// bcba-migration-parser.js -- reads the practice's "BCBA assignments / Auth due
// dates" sheet into the rows the one-time migration reviews.
//
// THIS IS A ONE-TIME CLEANUP, NOT A SYNCHRONISATION. Nothing here runs on a
// schedule and nothing here re-reads the sheet later. After the migration the
// CRM is the source of truth for who a client's BCBA and Student Analyst are;
// the sheet is history. That is the whole reason this is a parser handed to an
// admin screen rather than a connector.
//
// WHY THIS REFUSES SO MUCH
//
// The sheet is a working document, not an export. It carries merged section
// headings, blank spacer rows, a second table of squad leaders underneath, and
// -- the one that matters -- A COLUMN WHOSE MEANING CHANGES PART-WAY DOWN.
// Under "Needs assessment" the Student Analyst column holds BCBA names, because
// for a child who has not started yet the useful fact is who is doing the
// intake. Importing that literally would file a BCBA as somebody's Student
// Analyst, which reads as perfectly plausible on screen and is wrong.
//
// So the rule that catches it is drawn FROM THE SHEET ITSELF rather than from
// the section headings, which are free text and get renamed: a name that
// appears in the BCBA column anywhere in the document is a BCBA, and finding it
// in the Student Analyst column is reported as ambiguous rather than imported.
//
// Everything else follows the same principle -- when the sheet is unclear, the
// row goes on the review table and a person decides. A migration that guesses
// is worse than one that asks, because nobody re-checks a field that was filled
// in silently.
"use strict";

// Columns are found by their header text, never by position, so a column
// inserted into the sheet does not silently shift every value one to the left.
const COLUMNS = [
  { key: "client_name", match: /^client\s*name$/i, required: true },
  { key: "bcba", match: /^bcba$/i, required: true },
  { key: "insurance", match: /^insurance$|^payer$/i },
  { key: "auth_start", match: /^auth\s*start$/i },
  { key: "auth_end", match: /^auth\s*end$/i },
  { key: "treatment_plan_due", match: /^treatment\s*plan\s*due$|^tx\s*plan\s*due$/i },
  { key: "tx_updates", match: /^tx\s*updates$|^treatment\s*plan\s*updates$/i },
  { key: "student_analyst", match: /^student\s*analyst$/i, required: true },
  { key: "schedule", match: /^schedule$/i },
];

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

// Google's markdown export escapes punctuation, and a merged cell arrives as
// the literal text "[merged] <value>" repeated across the row.
function unescapeCell(s) {
  let out = String(s == null ? "" : s);
  let prev = null;
  while (out !== prev) { prev = out; out = out.replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, "$1"); }
  // Trim BEFORE stripping the marker: the cell arrives padded, so an anchored
  // match against the untrimmed string never fires and every section heading
  // keeps a "[merged]" prefix.
  return clean(clean(out).replace(/^\[merged\]\s*/i, ""));
}

// A value that means "there is deliberately nothing here" rather than "nobody
// filled this in". Both end up empty; neither is guessed at.
const isBlank = (v) => !v || /^(n\/a|na|none|-|—|tbd)$/i.test(v);

// Two shapes, because the sheet arrives two ways and both are ordinary.
//
//   * A markdown pipe table, which is what an export of the document gives.
//   * TAB-SEPARATED text, which is what COPYING CELLS OUT OF GOOGLE SHEETS
//     puts on the clipboard. That is how a person will actually use this, and
//     accepting only the first would have refused every real paste.
//
// A tab-separated line is recognised by containing a tab, never by guessing at
// spacing: client names, payers and schedule notes are full of spaces, and
// splitting on runs of them would cut names in half.
function splitRow(line) {
  // ONLY the line ending is stripped. A trailing tab is an EMPTY TRAILING CELL,
  // not whitespace: trimming it turns "Needs assessment\t\t\t" into a line with
  // no tab at all, which stops looking like a table row and silently ends the
  // table -- taking every row after it with it.
  const t = String(line).replace(/[\r\n]+$/, "");
  if (t.trim().startsWith("|")) {
    // Drop the leading and trailing pipe, then split. Escaped pipes inside a
    // cell are not separators.
    const body = t.trim().replace(/^\|/, "").replace(/\|\s*$/, "");
    return body.split(/(?<!\\)\|/).map(unescapeCell);
  }
  if (t.includes("\t")) return t.split("\t").map(unescapeCell);
  return null;
}

// A markdown alignment row. ONE dash is legal -- ":-:" is what Google's export
// writes -- so requiring two made the separator look like a merged heading and
// set every following row's section to ":-:".
const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c) || c === "");

// A heading row in this sheet is a merged cell: the same non-empty text
// repeated across every column. "Pending", "Needs assessment", and so on.
function sectionLabel(cells) {
  const filled = cells.filter(Boolean);
  if (!filled.length) return null;
  // Exported form: the merged value repeated across the row.
  if (filled.length >= 3) {
    const first = filled[0];
    if (filled.every((c) => c === first)) return first;
  }
  // Pasted form: a merged cell arrives once, in the first column, with the rest
  // of the row empty. That is also what a client row carrying nothing but a
  // name looks like, so this only claims it as a heading when the row is WIDE
  // and everything after the first cell is empty -- and even then the row is
  // reported either way, never silently dropped.
  if (filled.length === 1 && cells.length >= 4 && cells[0] && cells.slice(1).every((c) => !c)) {
    return { maybe: cells[0] };
  }
  return null;
}

// mm/dd/yyyy and mm/dd/yy, which is what the sheet actually contains. Anything
// else is left for a person: a date read wrongly moves an authorization
// deadline, and a deadline that is wrong by a year is worse than one missing.
function parseDate(raw) {
  const v = clean(raw);
  if (isBlank(v)) return { value: null };
  let m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]);
    let y = Number(m[3]);
    if (m[3].length === 2) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return { value: null, issue: `Date "${v}" is not a real date` };
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    // Round-trip it: 02/30 parses arithmetically and is still not a day.
    const back = new Date(iso + "T00:00:00Z");
    if (Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== iso) {
      return { value: null, issue: `Date "${v}" is not a real date` };
    }
    return { value: iso };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { value: v };
  return { value: null, issue: `Date "${v}" is not in a format this can read` };
}

/**
 * Parse the sheet.
 *
 * Returns { ok, reason?, rows, squads, warnings, bcba_names }.
 *   rows   -- one per client line that named a client, with the values read and
 *             any issues found IN THE SHEET (not against the CRM; that is the
 *             importer's job, because only it can see the client records).
 *   squads -- squad leader -> client names, from the second table.
 */
function parseAssignmentSheet(text) {
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  const tables = [];
  let current = null;
  for (const line of lines) {
    const cells = splitRow(line);
    if (!cells) { if (current) { tables.push(current); current = null; } continue; }
    if (!current) current = [];
    current.push(cells);
  }
  if (current) tables.push(current);
  if (!tables.length) return { ok: false, reason: "No table was found in that text.", rows: [], squads: [], warnings: [] };

  // ---- the client table: the one whose header names a client and a BCBA ----
  let header = null, headerAt = -1, table = null;
  for (const t of tables) {
    for (let i = 0; i < t.length; i++) {
      const cells = t[i];
      if (isSeparator(cells)) continue;
      const map = {};
      COLUMNS.forEach((col) => {
        const at = cells.findIndex((c) => col.match.test(c));
        if (at >= 0 && map[col.key] === undefined) map[col.key] = at;
      });
      const missing = COLUMNS.filter((c) => c.required && map[c.key] === undefined);
      if (!missing.length) { header = map; headerAt = i; table = t; break; }
    }
    if (header) break;
  }
  if (!header) {
    return {
      ok: false,
      rows: [], squads: [], warnings: [],
      reason: "Could not find the header row. It needs columns named Client Name, BCBA and Student Analyst.",
    };
  }

  const warnings = [];
  const at = (cells, key) => (header[key] === undefined ? "" : clean(cells[header[key]] || ""));

  // First pass: every name that appears in the BCBA column, anywhere. This is
  // the evidence the Student Analyst check below is built on.
  const bcbaNames = new Set();
  for (let i = headerAt + 1; i < table.length; i++) {
    const cells = table[i];
    if (isSeparator(cells) || sectionLabel(cells)) continue;
    const b = at(cells, "bcba");
    if (b && !isBlank(b)) bcbaNames.add(b.toLowerCase());
  }

  const rows = [];
  let section = "";
  let skippedBlank = 0;
  for (let i = headerAt + 1; i < table.length; i++) {
    const cells = table[i];
    if (isSeparator(cells)) continue;
    const label = sectionLabel(cells);
    if (typeof label === "string") { section = label; continue; }
    // An ambiguous one sets the section AND still falls through as a row, so a
    // real client carrying only a name is never lost to a wrong guess. It will
    // reach the review table as "Client not found", which is visible and
    // harmless, rather than disappearing.
    if (label && label.maybe) section = label.maybe;

    const name = at(cells, "client_name");
    if (!name || isBlank(name)) { skippedBlank++; continue; }

    const issues = [];
    const bcba = at(cells, "bcba");
    const analystRaw = at(cells, "student_analyst");

    // THE CHECK THIS FILE EXISTS FOR. A name used as a BCBA elsewhere in the
    // sheet is not read as a Student Analyst here.
    let analyst = "";
    if (analystRaw && !isBlank(analystRaw)) {
      if (bcbaNames.has(analystRaw.toLowerCase())) {
        issues.push(`"${analystRaw}" is listed as a BCBA elsewhere in this sheet, so it is not read as a Student Analyst here`);
      } else {
        analyst = analystRaw;
      }
    }

    const authStart = parseDate(at(cells, "auth_start"));
    const authEnd = parseDate(at(cells, "auth_end"));
    const tpDue = parseDate(at(cells, "treatment_plan_due"));
    [authStart, authEnd, tpDue].forEach((d) => { if (d.issue) issues.push(d.issue); });

    // Dates that cannot both be true. These are reported, never corrected: the
    // obvious repair for "auth ends before it starts" is a year typo, and
    // picking the year for somebody is picking their renewal deadline.
    if (authStart.value && authEnd.value && authEnd.value <= authStart.value) {
      issues.push(`Auth End (${authEnd.value}) is not after Auth Start (${authStart.value})`);
    }
    if (tpDue.value && authEnd.value && tpDue.value > authEnd.value) {
      issues.push(`Treatment Plan Due (${tpDue.value}) is after Auth End (${authEnd.value})`);
    }

    rows.push({
      client_name: name,
      bcba: isBlank(bcba) ? "" : bcba,
      student_analyst: analyst,
      student_analyst_raw: analystRaw && isBlank(analystRaw) ? "" : analystRaw,
      insurance: (() => { const v = at(cells, "insurance"); return isBlank(v) ? "" : v; })(),
      auth_start: authStart.value,
      auth_end: authEnd.value,
      treatment_plan_due: tpDue.value,
      // Informational only. The sheet's schedule notes are historical; the live
      // schedule comes from Rethink and nothing here writes one.
      schedule_note: (() => { const v = at(cells, "schedule"); return isBlank(v) ? "" : v; })(),
      tx_updates: (() => { const v = at(cells, "tx_updates"); return isBlank(v) ? "" : v; })(),
      section,
      sheet_issues: issues,
    });
  }

  if (skippedBlank) warnings.push(`${skippedBlank} row(s) had no client name and were skipped.`);
  if (!rows.length) warnings.push("The header was found but no client rows followed it.");

  return {
    ok: true,
    rows,
    squads: parseSquadTable(tables, header ? null : undefined),
    bcba_names: [...bcbaNames],
    warnings,
  };
}

// ---- the squad table -------------------------------------------------------
// A second table underneath the client list, laid out sideways: a row labelled
// "Squad Leaders" naming the leaders, then rows of client names beneath each.
// It is a DIFFERENT grouping from the BCBA one -- a client's squad leader is
// usually not their BCBA -- so it is read separately and never inferred from
// the caseload.
function parseSquadTable(tables) {
  const out = [];
  for (const t of tables) {
    for (let i = 0; i < t.length; i++) {
      const cells = t[i];
      const labelAt = cells.findIndex((c) => /^squad\s*leaders?$/i.test(c));
      if (labelAt < 0) continue;
      // Leaders are whatever follows the label on that row.
      const leaders = [];
      for (let c = labelAt + 1; c < cells.length; c++) {
        const v = clean(cells[c]);
        leaders.push(v && !isBlank(v) ? v : null);
      }
      if (!leaders.some(Boolean)) continue;

      // Only a block headed "Clients" carries client names. The sheet has a
      // second Squad Leaders row above a STAFF list, and importing that would
      // file employees as children.
      let j = i + 1;
      let sawClientsHeader = false;
      const byLeader = leaders.map(() => []);
      for (; j < t.length; j++) {
        const row = t[j];
        if (isSeparator(row)) continue;
        const rowLabel = clean(row[labelAt] || "");
        if (/^squad\s*leaders?$/i.test(rowLabel)) break;      // the next block
        if (/^clients?$/i.test(rowLabel)) { sawClientsHeader = true; }
        else if (rowLabel && !sawClientsHeader) continue;      // "Staff", etc.
        if (!sawClientsHeader) continue;
        let any = false;
        for (let c = labelAt + 1; c < row.length; c++) {
          const v = clean(row[c] || "");
          if (!v || isBlank(v)) continue;
          any = true;
          const idx = c - labelAt - 1;
          if (leaders[idx]) byLeader[idx].push(v);
        }
        // A fully blank row ends the block.
        if (!any && sawClientsHeader && byLeader.some((l) => l.length)) break;
      }
      leaders.forEach((leader, idx) => {
        if (leader && byLeader[idx] && byLeader[idx].length) {
          out.push({ squad_leader: leader, clients: byLeader[idx] });
        }
      });
    }
  }
  return out;
}

module.exports = { parseAssignmentSheet, parseDate, COLUMNS };
