// csv-parse.js -- RFC4180 CSV parsing, shared.
//
// Three modules (financial-advisor, fin-ledger, hr) each carry a private copy
// of this. Rewiring them is not this change's business, but adding a fourth
// copy is not either, so new callers use this one.
"use strict";

// Handles quoted fields, escaped quotes ("" inside a quoted field), embedded
// newlines and commas, and CRLF. Blank lines are dropped -- a trailing newline
// at the end of a file is not a row.
function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", inQuotes = false;
  const s = String(text == null ? "" : text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

// Normalise a header cell for matching: lowercase, collapse whitespace, and
// drop the punctuation that separates "Order #" from "order number".
function normalizeHeader(h) {
  return String(h == null ? "" : h).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Find the column whose header matches one of `aliases`. Returns -1 when
// nothing matches -- callers must treat that as "this column is not in the
// file", never as column 0.
//
// `taken` is a set of column indices already claimed by a more specific field.
// It is what stops a broad alias stealing a column that means something else:
// a bare "name" alias otherwise matches "Ticket Name" and files ticket types
// as people's names.
//
// The loose pass matches on WORD BOUNDARIES, not substrings, for the same
// reason -- "order" should find "Order #" without also finding "Reorder Code".
function findColumn(headers, aliases, taken) {
  const skip = taken instanceof Set ? taken : new Set();
  const norm = headers.map(normalizeHeader);
  const free = (i) => i !== -1 && !skip.has(i);

  for (const alias of aliases) {
    const a = normalizeHeader(alias);
    for (let i = 0; i < norm.length; i++) if (norm[i] === a && free(i)) return i;
  }
  for (const alias of aliases) {
    const a = normalizeHeader(alias);
    if (!a) continue;
    const boundary = new RegExp(`(^| )${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);
    for (let i = 0; i < norm.length; i++) if (boundary.test(norm[i]) && free(i)) return i;
  }
  return -1;
}

module.exports = { parseCsv, normalizeHeader, findColumn };
