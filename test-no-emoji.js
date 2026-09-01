// No emoji in the user-facing interface.
//
// The CRM had emoji scattered through it -- section headers on the client
// card, the sidebar nav, page titles, button prefixes, status dots. They were
// removed on the grounds that a clinical record and the software around it
// should look like a professional tool rather than a chat message.
//
// The reason this is a test and not a one-off sweep: emoji come back. They
// arrive one at a time, in a new button label or a new nav entry, and nobody
// notices until there are forty again. This fails the build the first time one
// reappears in a file a user actually looks at.
//
// WHAT IS AN EMOJI, FOR THIS TEST
// -------------------------------
// Coloured pictographs -- anything the platform renders as a picture. Not
// monochrome typographic marks, which are doing real work and stay:
//
//   ✓ ✕ ✗   status ticks, close buttons
//   ⚠ ⚙ ✎ ✉  warning, settings, edit, mail -- text-presentation dingbats used
//             in the nav's icon slot and in status glyph sets
//   → ← ⇧ ⇩ ▾ ▸ ▴  arrows and disclosure carets
//   ◧ ▤ ◉ ◷ ◵ ◇ ▥ ⧉ ◎ ▽ ▦ ◈ ◐ ▧ ▨ ⧗ ▩ ◑ ▣  the nav's geometric icon set
//
// The distinction that matters is COLOUR, not category: a variation selector
// (U+FE0F) turns a text glyph into an emoji one, so it is banned outright --
// "⚠️" fails, "⚠" passes, and they look completely different on screen.
//
//   node test-no-emoji.js
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "\n        " + detail : "")); }
};

// Files a user's browser actually renders. Server modules are excluded: their
// emoji live in outbound email bodies and log lines, which are not this UI.
const UI_FILES = [
  "index.html",
  ...fs.readdirSync(__dirname).filter((f) => /-frontend\.js$/.test(f)),
  "screener-admin.js",
  "pipeline-v2.js",
  "financial-center.js",
  "owner-financials.js",
  "theme.js",
];

// Coloured pictograph blocks. Emoji, by any ordinary reading of the word.
const PICTOGRAPH = /[\u{1F000}-\u{1FAFF}\u{1F900}-\u{1F9FF}]/u;
// Symbols that are emoji-presentation by default even without a selector.
const EMOJI_BY_DEFAULT = /[\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{25FD}-\u{25FE}\u{2614}-\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}-\u{26AB}\u{26BD}-\u{26BE}\u{26C4}-\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}-\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2705}\u{270A}-\u{270B}\u{2728}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2795}-\u{2797}\u{27B0}\u{27BF}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}]/u;
// The variation selector that forces emoji presentation on a text glyph.
const VS16 = /\u{FE0F}/u;

const scan = (re) => {
  const hits = [];
  for (const f of UI_FILES) {
    const full = path.join(__dirname, f);
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = line.match(new RegExp(re, "gu"));
      if (m) hits.push(`${f}:${i + 1}  [${[...new Set(m)].join("")}]  ${line.trim().slice(0, 100)}`);
    });
  }
  return hits;
};

console.log("\n== No emoji in the interface ==");
console.log(`  (scanning ${UI_FILES.length} user-facing files)`);

const pictographs = scan(PICTOGRAPH.source);
check("no coloured pictographs anywhere in the interface",
  pictographs.length === 0, pictographs.slice(0, 12).join("\n        "));

const defaults = scan(EMOJI_BY_DEFAULT.source);
check("no symbols that render as emoji without a selector (✅ ❌ ❓ ✨ ⚪ …)",
  defaults.length === 0, defaults.slice(0, 12).join("\n        "));

const selectors = scan(VS16.source);
check("no emoji variation selectors — a text glyph must stay a text glyph",
  selectors.length === 0, selectors.slice(0, 12).join("\n        "));

// The other half of the rule: the monochrome marks are load-bearing, so a
// well-meaning "remove all the symbols" pass must not take them out either.
console.log("\n== The functional marks are still there ==");
const all = UI_FILES
  .filter((f) => fs.existsSync(path.join(__dirname, f)))
  .map((f) => fs.readFileSync(path.join(__dirname, f), "utf8"))
  .join("\n");
for (const [glyph, what] of [
  ["✓", "status ticks"],
  ["✕", "close buttons"],
  ["⚠", "warning marks"],
  ["⚙", "settings"],
]) {
  check(`${what} (${glyph}) survived`, all.includes(glyph));
}

// And the client card specifically, since that is where this started.
console.log("\n== The client card's section headers ==");
const idx = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const csCalls = [...idx.matchAll(/cs\("([a-z]+)", "([^"]*)"/g)];
check("every client-card section is declared with an empty icon slot",
  csCalls.length > 10 && csCalls.every(([, , icon]) => icon === ""),
  csCalls.filter(([, , i]) => i !== "").map(([m]) => m).join("  "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
