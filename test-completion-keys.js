// Every completion key a caller fires must exist in the EVENTS registry.
//
// This is here because one did not. client-forms.js fired
// "client_documents_received" when a parent finished uploading their diagnosis
// and both sides of the insurance card, and completions.js had no such key, so
// production logged
//
//   completions.record: unknown event key client_documents_received
//
// every time a family completed a document request. record() deliberately
// keeps the completion rather than dropping it -- it falls back to the raw key
// as the title and files it under "Other" -- so nothing was lost, but the
// digest read like a glitch and nobody noticed for a week.
//
// A registry lookup that misses is the kind of thing a test should catch, not
// a log line somebody happens to scroll past. Pure source scan: no server, no
// database, no network.
//   Run with: node test-completion-keys.js
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 400) : "")); }
}

// The registry is exported, so read it rather than re-parsing it. initCompletions
// only destructures its ctx at construction time and EVENTS is a literal, so a
// bare object is enough to get at it.
const completions = require(path.join(__dirname, "completions.js"))({
  dbGet: async () => null,
  dbAll: async () => [],
  dbRun: async () => ({ rows: [] }),
  sendEmail: async () => ({ delivered: "simulated" }),
  nowISO: () => "2026-08-20T00:00:00.000Z",
  json: () => {},
  readBody: async () => ({}),
  getAppSetting: async () => "",
  setAppSetting: async () => {},
  APP_BASE_URL: "https://example.test",
});
const EVENTS = completions.EVENTS;

console.log("\n== the registry itself ==");
check("completions exports its EVENTS registry", EVENTS && typeof EVENTS === "object");
const registered = Object.keys(EVENTS || {});
check("it is not empty", registered.length > 0, registered.length);
check("every entry has a label and a group",
  registered.every((k) => EVENTS[k] && EVENTS[k].label && EVENTS[k].group),
  registered.filter((k) => !(EVENTS[k] && EVENTS[k].label && EVENTS[k].group)));

// ---------------------------------------------------------------- the callers
// Match onCompletion("key" ...) and completions.record("key" ...) across the
// server modules. Deliberately not a require() of each module: the point is to
// see what the source says, including paths a test run never reaches.
const SOURCES = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith(".js") && !f.startsWith("test-") && f !== "run-tests.js");

const fired = new Map(); // key -> [files]
for (const file of SOURCES) {
  const src = fs.readFileSync(path.join(__dirname, file), "utf8");
  const re = /(?:onCompletion|completions\.record|\brecordCompletion)\(\s*["']([a-z0-9_]+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    if (!fired.has(m[1])) fired.set(m[1], []);
    if (!fired.get(m[1]).includes(file)) fired.get(m[1]).push(file);
  }
}

console.log("\n== keys fired by callers ==");
check("callers fire at least one completion key", fired.size > 0, fired.size);

const unregistered = [...fired.entries()]
  .filter(([key]) => !registered.includes(key))
  .map(([key, files]) => `${key} (fired in ${files.join(", ")})`);

check("every key a caller fires is registered in EVENTS", unregistered.length === 0, unregistered);

// The specific one that was missing, named so a regression is unmistakable.
check("client_documents_received is registered", registered.includes("client_documents_received"));
check("and it is grouped with the other family events",
  EVENTS.client_documents_received && EVENTS.client_documents_received.group === "Families",
  EVENTS.client_documents_received);

console.log(`\n  ${fired.size} keys fired, ${registered.length} registered`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
