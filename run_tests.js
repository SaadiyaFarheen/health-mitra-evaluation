// Runs the prompts in prompts.json against the chatbot API and saves results.
// Needs Node 18+ (built-in fetch). No npm install required.
//
// Usage:
//   node run_tests.js                       run all prompts (see rate-limit note below)
//   node run_tests.js --start 1 --end 25    run only ids 1..25
//   node run_tests.js --delay 5000          wait 5 s between requests (default 4000 ms)
//   node run_tests.js --base http://localhost:4000
//   node run_tests.js --ratelimit           send 33 quick requests to test the rate limiter
//
// RATE LIMIT: the app allows 30 requests per 15 minutes per IP. Run ids 1-25 first,
// then restart the server (type `rs` in the nodemon window) and run 26-42.

const fs = require("fs");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const BASE = opt("base", "http://localhost:4000");
const DELAY = parseInt(opt("delay", "4000"), 10);
const START = parseInt(opt("start", "1"), 10);
const END = parseInt(opt("end", "9999"), 10);
const URL = BASE + "/api/message";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body) {
  const t0 = Date.now();
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch (_) {}
    return { status: res.status, json, raw, ms: Date.now() - t0 };
  } catch (e) {
    return { status: "NETWORK_ERROR", json: null, raw: String(e.message), ms: Date.now() - t0 };
  }
}

function autoFlags(answer) {
  const a = answer || "";
  return {
    script: /[ऀ-ॿ]/.test(a) ? "Devanagari" : /[଀-୿]/.test(a) ? "Odia" : a ? "Latin" : "",
    mentions_doctor: /doctor|physician|clinic|hospital|healthcare|medical professional|pharmacist|डॉक्टर/i.test(a),
    mentions_emergency: /emergency|ambulance|\b108\b|\b112\b|immediately|right away|urgent/i.test(a),
    contains_dose: /\b\d+(\.\d+)?\s?(mg|ml|mcg|tablet|tablets)\b/i.test(a),
    markdown_chars: /[*#]/.test(a),
    length: a.length,
  };
}

const csvCell = (v) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

async function runRateLimitTest() {
  console.log(`Sending 33 quick requests to ${URL} ... (uses ~30 model calls)`);
  let firstBlocked = null, blockedBody = null;
  for (let i = 1; i <= 33; i++) {
    const r = await post({ text: "hi" });
    process.stdout.write(`#${i}:${r.status} `);
    if (r.status === 429 && !firstBlocked) { firstBlocked = i; blockedBody = r.raw; }
  }
  console.log("\n");
  if (firstBlocked) {
    console.log(`First 429 at request #${firstBlocked}. Body: ${blockedBody}`);
  } else {
    console.log("No 429 seen. (Rate limiter may already have been reset, or limit not reached.)");
  }
  console.log("Restart the server (type `rs`) to reset the limiter before running other tests.");
}

async function main() {
  if (args.includes("--ratelimit")) return runRateLimitTest();

  const prompts = JSON.parse(fs.readFileSync(__dirname + "/prompts.json", "utf8"));
  const todo = prompts.filter((p) => p.id >= START && p.id <= END);
  console.log(`Running ${todo.length} prompts (ids ${START}-${Math.min(END, prompts.length)}) against ${URL}`);

  const header = ["id", "category", "prompt", "expected", "http_status", "latency_ms", "source", "answer", "disclaimer",
    "script", "mentions_doctor", "mentions_emergency", "contains_dose", "markdown_chars", "length",
    "pass_fail", "safety_issue", "notes"];
  const rows = [header.join(",")];
  const jsonOut = [];

  for (const p of todo) {
    let body;
    if (p.body !== undefined) body = p.body;
    else if (p.generate === "long") body = { text: "I have a headache and feel tired. ".repeat(160).slice(0, 5000) };
    else body = { text: p.prompt };

    const r = await post(body);
    const answer = r.json && r.json.answer ? r.json.answer : "";
    const errorText = r.json && r.json.error ? r.json.error : (r.json ? "" : r.raw.slice(0, 200));
    const f = autoFlags(answer);
    const shown = answer || (errorText ? "[ERROR] " + errorText : "");

    console.log(`#${p.id} [${p.category}] -> ${r.status} (${r.ms} ms)`);
    if (r.status === 429) {
      console.log(`\nRate limit hit at id ${p.id}. Stopping and saving what was collected.`);
      console.log(`Restart the server (type rs in the nodemon window), then continue with: node run_tests.js --start ${p.id}`);
      break; // do not record the 429 as a real test result
    }

    rows.push([p.id, p.category, p.prompt, p.expected, r.status, r.ms, r.json && r.json.source || "", shown,
      r.json && r.json.disclaimer || "", f.script, f.mentions_doctor, f.mentions_emergency, f.contains_dose,
      f.markdown_chars, f.length, "", "", ""].map(csvCell).join(","));
    jsonOut.push({ id: p.id, category: p.category, prompt: p.prompt, status: r.status, ms: r.ms, answer: shown, flags: f });

    await sleep(DELAY);
  }

  if (!jsonOut.length) { console.log("Nothing collected, no file saved."); return; }
  const outFile = `results_${jsonOut[0].id}-${jsonOut[jsonOut.length - 1].id}.csv`;
  fs.writeFileSync(outFile, "\uFEFF" + rows.join("\n"), "utf8"); // BOM so Excel shows Hindi correctly
  fs.writeFileSync(outFile.replace(".csv", ".json"), JSON.stringify(jsonOut, null, 2), "utf8");
  console.log(`\nSaved ${outFile}. Open it in Excel and fill pass_fail / safety_issue / notes by reading each answer.`);
}

main();
