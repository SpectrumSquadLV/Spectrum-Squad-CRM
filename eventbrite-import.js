// eventbrite-import.js -- reading an Eventbrite attendee export.
//
// The dashboard has said "ticketing lives on Eventbrite -- the CRM has no
// registration count" since Phase 2. This is how that number arrives.
//
// The Eventbrite API is the better source, and eventbrite-client.js is written
// for it. But the API needs a token nobody has entered yet, and the network
// this was built on cannot reach eventbriteapi.com at all. A CSV export is
// something Quiana can download today and works with no credentials, so it is
// the path that actually delivers the number.
//
// Two failure modes matter more than a parse error:
//
//   1. COUNTING PEOPLE WHO ARE NOT COMING. An export includes refunded,
//      cancelled and declined orders, and they read exactly like attendees.
//      Counting them inflates a registration figure somebody plans catering
//      against and reports to a sponsor.
//   2. GUESSING A COLUMN. Eventbrite's headers vary by account, ticket setup
//      and locale. A mapper that quietly picks the wrong column reports
//      confident nonsense. Every column is matched by name or left out, and
//      the caller is told which were found and which were ignored.
//
// Pure: no database, no network. See test-eventbrite-import.js.
"use strict";

const { parseCsv, findColumn, normalizeHeader } = require("./csv-parse");

// Header spellings seen across Eventbrite exports. Most specific alias first.
const COLUMNS = {
  first_name: ["first name", "attendee first name", "buyer first name", "first"],
  last_name: ["last name", "attendee last name", "buyer last name", "last", "surname"],
  full_name: ["attendee name", "name", "full name", "buyer name"],
  email: ["attendee email", "email address", "email", "buyer email"],
  quantity: ["quantity", "qty", "tickets", "number of tickets"],
  ticket_type: ["ticket type", "ticket name", "ticket class"],
  order_ref: ["attendee number", "attendee id", "attendee", "order number", "order id", "order"],
  order_date: ["order date", "date created", "created", "purchase date"],
  status: ["order status", "attendee status", "status"],
};

// Resolved most-specific first, each claiming its column so a broader alias
// cannot take it afterwards. `full_name` is deliberately LAST: its "name" alias
// also matches "Ticket Name", "First Name" and "Last Name", and without this
// order a file whose only name-ish column is the ticket class would report a
// list of people all called "General Admission".
const RESOLUTION_ORDER = [
  "email", "quantity", "ticket_type", "status",
  "order_date", "order_ref", "first_name", "last_name", "full_name",
];

// Statuses that mean this person is not coming. Anything unrecognised counts as
// attending, because the alternative -- silently dropping somebody whose status
// string we do not know -- loses a real registration from the total.
const NOT_ATTENDING = [
  "refunded", "cancelled", "canceled", "declined", "deleted", "abandoned", "not attending",
];

function isNotAttending(status) {
  const s = normalizeHeader(status);
  if (!s) return false;
  return NOT_ATTENDING.some((n) => s.includes(normalizeHeader(n)));
}

function cell(row, idx) {
  if (idx < 0) return "";
  return String(row[idx] == null ? "" : row[idx]).trim();
}

function toPositiveInt(v) {
  const n = parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Returns { rows, report }. The report is not decoration: it is how a person
// confirms the file was understood before any number reaches a dashboard.
function parseAttendeeCsv(text) {
  const raw = parseCsv(text);
  if (raw.length < 2) {
    return {
      rows: [],
      report: {
        rows_read: 0, mapped: {}, unmapped_headers: [],
        attending: 0, not_attending: 0, tickets: 0,
        problems: raw.length
          ? ["The file has a header row but no attendees below it."]
          : ["No rows could be read from that file."],
      },
    };
  }

  const headers = raw[0].map((h) => String(h || ""));
  const idx = {};
  const taken = new Set();
  for (const field of RESOLUTION_ORDER) {
    const found = findColumn(headers, COLUMNS[field], taken);
    idx[field] = found;
    if (found >= 0) taken.add(found);
  }

  const problems = [];
  const hasSplitName = idx.first_name >= 0 || idx.last_name >= 0;
  if (!hasSplitName && idx.full_name < 0) {
    problems.push("No name column was recognised, so attendees will import without names.");
  }
  if (idx.email < 0) {
    problems.push("No email column was recognised. Attendees cannot be matched or de-duplicated without it.");
  }
  if (idx.status < 0) {
    // Said plainly rather than assumed away: with no status column, refunds and
    // cancellations are indistinguishable from people who are coming.
    problems.push("No status column was recognised, so refunded or cancelled orders cannot be told apart and everyone is counted as attending.");
  }

  const unmapped = headers
    .map((h, i) => ({ h: String(h).trim(), i }))
    .filter((c) => !taken.has(c.i) && c.h !== "")
    .map((c) => c.h);

  const rows = [];
  for (let r = 1; r < raw.length; r++) {
    const row = raw[r];
    const first = cell(row, idx.first_name);
    const last = cell(row, idx.last_name);
    const joined = [first, last].filter(Boolean).join(" ").trim();
    const status = cell(row, idx.status);
    rows.push({
      name: joined || cell(row, idx.full_name) || null,
      email: (cell(row, idx.email) || "").toLowerCase() || null,
      quantity: toPositiveInt(cell(row, idx.quantity)),
      ticket_type: cell(row, idx.ticket_type) || null,
      external_ref: cell(row, idx.order_ref) || null,
      ordered_at: cell(row, idx.order_date) || null,
      status_raw: status || null,
      attending: !isNotAttending(status),
    });
  }

  const attendingRows = rows.filter((x) => x.attending);
  // Two different numbers, kept apart. A row is a registration; a row may carry
  // several tickets. Reporting one as the other misstates the headcount in
  // whichever direction the event happens to sell.
  const tickets = attendingRows.reduce((sum, x) => sum + (x.quantity || 1), 0);

  return {
    rows,
    report: {
      rows_read: rows.length,
      mapped: Object.fromEntries(
        Object.entries(idx).filter(([, i]) => i >= 0).map(([f, i]) => [f, headers[i].trim()])
      ),
      unmapped_headers: unmapped,
      attending: attendingRows.length,
      not_attending: rows.length - attendingRows.length,
      tickets,
      problems,
    },
  };
}

// Re-importing the same export must not double a total. Eventbrite's own
// reference is used when the file carries one; otherwise the email. A row with
// neither cannot be de-duplicated, which is counted and reported rather than
// hidden.
function dedupeKey(row) {
  if (!row) return null;
  if (row.external_ref) return "ref:" + String(row.external_ref).trim().toLowerCase();
  if (row.email) return "email:" + String(row.email).trim().toLowerCase();
  return null;
}

// The numbers a dashboard may show, from a set of parsed rows.
function summarise(rows) {
  const seen = new Set();
  let registrations = 0, tickets = 0, notAttending = 0, undedupable = 0;
  for (const r of rows || []) {
    if (!r.attending) { notAttending += 1; continue; }
    const key = dedupeKey(r);
    if (key === null) { undedupable += 1; }
    else if (seen.has(key)) continue;
    else seen.add(key);
    registrations += 1;
    tickets += r.quantity || 1;
  }
  return { registrations, tickets, not_attending: notAttending, undedupable };
}

module.exports = {
  parseAttendeeCsv, dedupeKey, summarise, isNotAttending,
  COLUMNS, NOT_ATTENDING, RESOLUTION_ORDER,
};
