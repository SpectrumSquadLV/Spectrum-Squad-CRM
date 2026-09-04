// bip-doc-parser.js -- turn a Behavior Intervention Plan document into the
// structured items bip.js's importer already accepts.
//
// The practice's BIPs live in Google Docs, one per client, and every one of
// them is a three-column table:
//
//     | Antecedent Strategies | Behavior | Consequences |
//
// with one row per target behaviour. That is a lucky and important fact: those
// three columns are almost exactly the three fields bip.js counts as core
// (prevention_strategies, operational_definition, response_strategy), so this
// is READING LABELLED CELLS rather than interpreting clinical prose.
//
// THE RULE THIS FILE INHERITS, from bip.js's own header: "Nothing clinical is
// ever invented. A field with no source information is recorded as not
// documented, never guessed at or filled from another client's plan."
//
// So the refusals are the design:
//
//   * No table, or a header this does not recognise -> refuse the whole
//     document. Guessing which column is which would put a consequence
//     strategy in the antecedent field, which reads as instructions to staff.
//   * A row with no behaviour name -> skipped and reported, never given an
//     invented name.
//   * A cell that is empty stays empty. bip.js renders that as "Not
//     documented", which is the truth.
//
// It also deliberately does NOT emit `client_name` or `dob`. bip.js's matcher
// scores a full-name match at 100 and initials at 55, and calls anything at 135
// or more "confident" -- which skips the human confirmation step. Emitting only
// initials and a first name caps the score at 90, so EVERY match this produces
// comes back for a person to confirm before it touches a child's record.
//
//   const { parseBipDoc } = require("./bip-doc-parser");
"use strict";

// Google Docs exports arrive with markdown escaping and encoded newlines.
function unescapeRepeatedly(s) {
  // Google Docs exports escape a hyphen as "\\-" -- an escaped backslash
  // followed by the hyphen -- so ONE pass turns it into "\-" and leaves that
  // in the text. It shows up in the plan as stray punctuation in front of
  // every strategy line. Repeat until the string stops changing, bounded so a
  // pathological input cannot spin.
  let out = s;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/\\([*_\-\\!.()[\]#>+])/g, "$1");
    if (next === out) break;
    out = next;
  }
  return out;
}

// Everything tidy() does EXCEPT stripping bold. The behaviour name is whatever
// the document put in bold at the head of the cell, and that is stronger
// evidence than punctuation: real plans write both "**Name:**" and "**Name**".
function tidyKeepBold(raw) {
  return unescapeRepeatedly(String(raw == null ? "" : raw))
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tidy(raw) {
  return unescapeRepeatedly(String(raw == null ? "" : raw))
    .replace(/&#10;/g, "\n")        // encoded newline
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\*\*/g, "")           // bold markers carry no meaning once parsed
    .replace(/[ \t]+/g, " ")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A markdown table row, split into cells. Returns null for separator rows
// (| :-: | --- |) and for anything that is not a row.
function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|");
  if (cells.every((c) => /^[\s:.-]*$/.test(c))) return null;   // separator
  return cells;
}

const COLUMN_PATTERNS = {
  prevention_strategies: /antecedent|prevention|proactive|before/i,
  behavior: /^\s*\**\s*behaviou?rs?\b|target behaviou?r/i,
  response_strategy: /consequence|response|reactive|after/i,
};

// Which column is which, read off the header row. Never positional: a document
// that orders them differently must still land in the right fields, and one
// this cannot read must be refused rather than guessed.
function readHeader(cells) {
  const map = {};
  cells.forEach((cell, i) => {
    const text = tidy(cell);
    for (const [key, re] of Object.entries(COLUMN_PATTERNS)) {
      if (map[key] === undefined && re.test(text)) map[key] = i;
    }
  });
  return map;
}

// "Self-Injurious Behavior: - Self-injurious behaviors are defined as..."
// The name is what the document itself put in bold before the colon. If there
// is no such label the row is not given a made-up one.
function splitBehaviorCell(text) {
  const bolded = tidyKeepBold(text);
  if (!bolded) return null;

  // Preferred: the name the document itself put in bold at the top of the cell.
  // Covers both "**Elopement:**" and "**Self-Injurious Behavior**".
  let name = "", body = "";
  const boldLead = bolded.match(/^\s*\*\*([^*\n]{2,80}?)\s*:?\s*\*\*\s*:?\s*([\s\S]*)$/);
  if (boldLead) {
    name = boldLead[1].trim();
    body = boldLead[2];
  } else {
    // Fallback: a "Name: definition" label with no bold at all.
    const plain = tidy(text);
    const m = plain.match(/^([^\n:]{2,80}?)\s*:\s*([\s\S]*)$/);
    if (!m) return null;
    name = m[1].replace(/^[-\s•]+/, "").trim();
    body = m[2];
  }
  if (!name || /^(for example|non ?-?example|ex|non ?-?ex)$/i.test(name)) return null;
  body = tidy(body);

  const examples = [], nonExamples = [], kept = [];
  // Real plans abbreviate these as "Ex:" and "Non-ex:" as well as writing them
  // out. Missing the short forms drops the examples into the definition, where
  // they read as part of what the behaviour IS.
  const NON_EX = /^non ?-?ex(amples?)?\b\s*[,:]?\s*/i;
  const EX = /^(for )?ex(amples?)?\b\s*[,:]?\s*/i;
  for (const line of body.split("\n")) {
    // Some plans write the definition as a markdown heading ("## Aggression is
    // defined as..."). The hashes are formatting, not content.
    const l = line.replace(/^[-\s•]+/, "").replace(/^#{1,6}\s*/, "").trim();
    if (!l) continue;
    if (NON_EX.test(l)) nonExamples.push(l.replace(NON_EX, "").trim());
    else if (EX.test(l)) examples.push(l.replace(EX, "").trim());
    else kept.push(l);
  }
  return {
    name,
    operational_definition: kept.join("\n").trim(),
    examples: examples.join("\n").trim(),
    non_examples: nonExamples.join("\n").trim(),
  };
}

function parseBipDoc(raw, opts = {}) {
  const warnings = [];
  const text = String(raw == null ? "" : raw);
  const rows = text.split("\n").map(splitRow).filter(Boolean);

  if (!rows.length) {
    return { ok: false, reason: "No table found in this document. The plans this reads are laid out as a table with Antecedent, Behavior and Consequence columns.", behaviors: [], warnings };
  }

  // The header is the first row that names at least the behaviour column and
  // one of the strategy columns. Anything less and the columns are a guess.
  let cols = null, headerAt = -1;
  for (let i = 0; i < rows.length && i < 5; i++) {
    const m = readHeader(rows[i]);
    if (m.behavior !== undefined && (m.prevention_strategies !== undefined || m.response_strategy !== undefined)) {
      cols = m; headerAt = i; break;
    }
  }
  if (!cols) {
    return {
      ok: false,
      reason: "Could not tell which column is which. Expected a header naming Antecedent Strategies, Behavior and Consequences.",
      behaviors: [], warnings,
    };
  }
  for (const key of ["prevention_strategies", "response_strategy"]) {
    if (cols[key] === undefined) warnings.push(`No ${key.replace(/_/g, " ")} column in this document; that field is left blank rather than filled from elsewhere.`);
  }

  const behaviors = [];
  const width = rows[headerAt].length;
  for (let i = headerAt + 1; i < rows.length; i++) {
    const cells = rows[i];
    // The plan table ends where the next table begins. Real documents carry a
    // second table after the plan -- an empty data-collection log with columns
    // Date / RBT / Duration / Comments -- and reading straight through it
    // turned that log's HEADER into a target behaviour called "RBT", with
    // every field blank, sitting in a child's plan looking like clinical
    // content. A differing column count, or a row that reads as a header in
    // its own right, ends the table.
    if (cells.length !== width) break;
    const again = readHeader(cells);
    if (again.behavior !== undefined
        && (again.prevention_strategies !== undefined || again.response_strategy !== undefined)) break;
    const parsed = splitBehaviorCell(cells[cols.behavior] || "");
    if (!parsed) {
      const any = cells.map(tidy).join("").trim();
      if (any) warnings.push(`Row ${i - headerAt} has no labelled behaviour name and was skipped rather than given one.`);
      continue;
    }
    behaviors.push({
      name: parsed.name,
      operational_definition: parsed.operational_definition,
      examples: parsed.examples,
      non_examples: parsed.non_examples,
      prevention_strategies: cols.prevention_strategies === undefined ? "" : tidy(cells[cols.prevention_strategies] || ""),
      response_strategy: cols.response_strategy === undefined ? "" : tidy(cells[cols.response_strategy] || ""),
    });
  }

  if (!behaviors.length) {
    return { ok: false, reason: "The table was read but no row carried a labelled behaviour name.", behaviors: [], warnings };
  }

  return {
    ok: true,
    behaviors,
    warnings,
    // Identity evidence only. See the header: no client_name, no dob, so the
    // matcher can never reach "confident" and skip human confirmation.
    initials: opts.initials || "",
    first_name: opts.first_name || "",
    source_name: opts.source_name || "",
    source_url: opts.source_url || "",
    source_date: opts.source_date || "",
  };
}

module.exports = { parseBipDoc, tidy, tidyKeepBold, splitRow, readHeader, splitBehaviorCell };
