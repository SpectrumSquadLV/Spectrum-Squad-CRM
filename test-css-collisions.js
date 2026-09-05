// The shell's stylesheet reaches every bundle loaded beside it.
//
//   node test-css-collisions.js
//
// No server and no browser: this reads the source.
//
// WHY THIS EXISTS. index.html defined `.hint` as a 15px circle -- the little
// round "i" badge -- and used it ONCE. Four add-on bundles used class="hint"
// for what the name plainly means: a line of small print under a field. The
// shell's rule won on the properties it declared, so a full sentence was
// rendered inside a 15x15 box, wrapping one word per line and spilling down
// the side of a dialog. It shipped, and it was reported from a desk with a
// screenshot, because nothing in this codebase was looking.
//
// THE TRAP IS SPECIFIC AND MECHANICAL, so it can be checked:
//
//   1. The shell locks a class to a small fixed box.
//   2. An add-on uses that class name for something that is not a box.
//   3. The add-on scopes its own rule (".bh-fld .hint") and sets colour and
//      size of TEXT -- but not width or height, so the box still applies.
//
// Step 3 is what makes it invisible. The author believes they scoped it.
//
// TWO RULES HERE, and the second matters more than the first. Rule A catches
// the collision that exists. Rule B is about the NEXT one: a generic English
// word in the shell's stylesheet is a name somebody else will reach for, so
// adding one is a decision, not an accident.
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else {
    fail++;
    const line = "  FAIL  " + n + (d !== undefined ? "\n        " + (typeof d === "string" ? d : JSON.stringify(d, null, 2)) : "");
    failures.push(line);
    console.log(line);
  }
};

const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const shellCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
// Comments are STRIPPED FIRST. Without that the "selector" for a rule is
// everything since the last brace -- including the comment block above it --
// so `.hint` preceded by a comment never matches a bare-class selector and the
// rule silently checks nothing. That is exactly how this file passed on the
// bug it was written to catch, the first time it was run against it.
const decomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, " ");
const rulesOf = (css) => [...decomment(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ sel: m[1].trim(), body: m[2] }));

// The bundles the shell loads beside itself. Everything that is not the
// server, a test, or the runner.
const bundles = fs.readdirSync(ROOT)
  .filter((f) => /\.js$/.test(f) && !/^(test-|run-tests|server\.js)/.test(f))
  .filter((f) => /class=/.test(fs.readFileSync(path.join(ROOT, f), "utf8")));

const classesUsedIn = (src) => {
  const out = new Set();
  for (const m of src.matchAll(/class=\\?["'`]([^"'`]+)/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !/[${}+]/.test(c)) out.add(c);
  }
  return out;
};

// Does this file set width AND height for that class anywhere -- however it is
// scoped? If it does, it has taken responsibility for the geometry and the
// shell's box no longer decides.
const ownsGeometry = (src, cls) => {
  for (const r of rulesOf(src)) {
    if (!new RegExp("\\." + cls + "(?![\\w-])").test(r.sel)) continue;
    if (/(?:^|[;\s{])width\s*:/.test(r.body) && /(?:^|[;\s{])height\s*:/.test(r.body)) return true;
    // A class re-declared as a block with its own display is equally deliberate.
    if (/(?:^|[;\s{])display\s*:\s*(block|flex|grid)/.test(r.body)) return true;
  }
  return false;
};

console.log("\n== Rule A: a shell class locked to a small box, reused as content ==");
// Small enough that arbitrary text cannot live in it. A 34px brand mark or a
// 26px checkbox is the same trap at a slightly larger size.
const boxed = new Map();
for (const r of rulesOf(shellCss)) {
  const w = /(?:^|[;\s{])width\s*:\s*([\d.]+)px/.exec(r.body);
  const h = /(?:^|[;\s{])height\s*:\s*([\d.]+)px/.exec(r.body);
  if (!w || !h || +w[1] > 40 || +h[1] > 40) continue;
  for (const part of r.sel.split(",")) {
    const m = /^\s*\.([a-zA-Z][\w-]*)\s*$/.exec(part);
    if (m) boxed.set(m[1], { size: `${w[1]}x${h[1]}px`, sel: r.sel.trim() });
  }
}
check("the shell's fixed-size classes were found at all", boxed.size > 0, [...boxed.keys()]);

const collisions = [];
for (const f of bundles) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  const used = classesUsedIn(src);
  for (const [cls, info] of boxed) {
    if (!used.has(cls)) continue;
    if (ownsGeometry(src, cls)) continue;   // it set its own box: deliberate
    collisions.push(`${f} uses .${cls}, which index.html locks to ${info.size} (${info.sel}), and never sets its own width/height. Whatever ${f} puts in it will be squashed into that box.`);
  }
}
check("NO ADD-ON PUTS CONTENT IN A BOX THE SHELL SIZED FOR SOMETHING ELSE",
  collisions.length === 0, collisions.join("\n        "));

console.log("\n== Rule B: generic names in the shell are a decision ==");
// The root cause rather than the instance. `.hint` was not a bad rule -- it
// was a bad NAME for a rule in a stylesheet every bundle inherits. A single
// English word is a name somebody writing another module will reach for
// without ever looking here.
//
// Everything below was already in the shell when this check was written. The
// list is not an endorsement of each one: it is the line, and the point is
// that ADDING to it has to be deliberate. If a new generic word turns up,
// either prefix it (.ss-hint, .bh-hint) or add it here on purpose.
const ALLOWED_GENERIC = new Set([
  "active", "attention", "bad", "badge", "body", "brand", "btn", "card",
  "clickable", "completed", "critical", "cs", "danger", "done", "dot",
  "dragging", "due", "failed", "field", "full", "hint", "hot", "info",
  "informational", "kanban", "label", "main", "meta", "modal", "name",
  "none", "ok", "opt", "overdue", "pending", "reopened", "ro", "secondary",
  "sent", "sidebar", "simulated", "small", "sub", "subject", "tag", "tags",
  "urgent", "value", "warn", "who",
]);
const generic = new Set();
for (const r of rulesOf(shellCss)) {
  for (const m of r.sel.matchAll(/\.([a-z]+)(?![\w-])/g)) generic.add(m[1]);
}
const added = [...generic].filter((c) => !ALLOWED_GENERIC.has(c)).sort();
check("NO NEW SINGLE-WORD CLASS HAS APPEARED IN THE SHELL STYLESHEET",
  added.length === 0,
  added.length
    ? `New generic class name(s) in index.html: ${added.map((c) => "." + c).join(", ")}\n        `
      + "A one-word class here styles every bundle loaded beside the shell. Prefix it,\n        "
      + "or add it to ALLOWED_GENERIC in this file to say the reuse is intended."
    : undefined);

// And the specific one that caused all this, pinned so it cannot come back.
check("`.hint` is no longer the badge -- the badge is .hint-badge",
  /\.hint-badge\s*\{/.test(shellCss) && !/(?:^|\s|,)\.hint\s*\{[^}]*width\s*:\s*15px/.test(shellCss),
  shellCss.match(/\.hint[\w-]*\s*\{[^}]*\}/g) || []);

console.log("\n== What it looked at ==");
console.log(`  ${bundles.length} bundles, ${boxed.size} fixed-size shell classes, ${generic.size} generic names.`);

if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
