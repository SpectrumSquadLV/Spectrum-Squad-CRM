// Reading registrations from Eventbrite (Phase 6).
//
// The dashboard has said "ticketing lives on Eventbrite -- the CRM has no
// registration count" since Phase 2. This is how the number arrives, by two
// routes: a CSV export that works today, and an API adapter that cannot be
// verified from here because the network blocks eventbriteapi.com entirely.
//
// The failures worth guarding, in order of how wrong the resulting number is:
//
//   1. COUNTING PEOPLE WHO ARE NOT COMING. Refunded and cancelled orders read
//      exactly like attendees. A registration figure is planned against and
//      quoted to sponsors.
//   2. REPORTING ZERO WHEN WE SIMPLY DO NOT KNOW. A failed sync must never
//      become "nobody has registered" -- the same rule the dashboard has held
//      since Phase 2.
//   3. GUESSING A COLUMN, so the figure is confident nonsense.
//   4. DOUBLE-COUNTING on a re-import, which somebody will do the morning of
//      the event to pick up the last sign-ups.
//
//   node test-eventbrite.js
"use strict";
const path = require("path");
const imp = require(path.join(__dirname, "eventbrite-import.js"));
const api = require(path.join(__dirname, "eventbrite-client.js"));
const { parseCsv, findColumn } = require(path.join(__dirname, "csv-parse.js"));

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    const line = "  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "");
    failures.push(line); console.log(line);
  }
};
const section = (t) => console.log("\n== " + t + " ==");

// Wrapped in an async IIFE: this file uses require(), and a top-level await
// alongside it makes the module format ambiguous to Node.
(async () => {
// ---------------------------------------------------------------- the CSV
section("The CSV itself is read properly, not split on commas");
check("quoted commas stay inside their field",
  JSON.stringify(parseCsv('a,b\n"Reyes, Ana",x\n')) === JSON.stringify([["a", "b"], ["Reyes, Ana", "x"]]));
check("escaped quotes survive", parseCsv('a\n"he said ""hi"""\n')[1][0] === 'he said "hi"');
check("a newline inside a quoted field is not a new row", parseCsv('a,b\n"l1\nl2",x\n').length === 2);
check("CRLF reads the same as LF",
  JSON.stringify(parseCsv("a,b\r\n1,2\r\n")) === JSON.stringify([["a", "b"], ["1", "2"]]));

const TYPICAL =
  "Order #,Order Date,First Name,Last Name,Email,Quantity,Ticket Type,Status\n" +
  "1001,2026-10-24,Ana,Reyes,ANA@Example.com,3,Family Pass,Attending\n" +
  "1002,2026-10-24,Marcus,Bell,marcus@example.com,2,Family Pass,Attending\n";

section("A typical export reads cleanly");
let out = imp.parseAttendeeCsv(TYPICAL);
check("both rows are read", out.rows.length === 2, out.report);
check("names are joined", out.rows[0].name === "Ana Reyes", out.rows[0]);
check("email is lowercased", out.rows[0].email === "ana@example.com", out.rows[0].email);
check("quantity is a number", out.rows[0].quantity === 3, out.rows[0].quantity);
check("nothing is reported as a problem", out.report.problems.length === 0, out.report.problems);

section("Registrations and tickets are two different numbers");
// One row is a registration; a row may carry several tickets. Reporting one as
// the other misstates the headcount in whichever direction the event sells.
check("two registrations", out.report.attending === 2, out.report);
check("five tickets", out.report.tickets === 5, out.report);
check("and the summary agrees",
  imp.summarise(out.rows).registrations === 2 && imp.summarise(out.rows).tickets === 5,
  imp.summarise(out.rows));

section("Refunded and cancelled orders are not counted as coming");
const WITH_REFUNDS = TYPICAL +
  "1003,2026-10-24,Sam,Cruz,sam@example.com,4,Family Pass,Refunded\n" +
  "1004,2026-10-24,Dee,Okafor,dee@example.com,2,Family Pass,Cancelled\n";
out = imp.parseAttendeeCsv(WITH_REFUNDS);
check("all four rows are read", out.rows.length === 4);
check("only two count as attending", out.report.attending === 2, out.report);
check("the other two are reported, not dropped", out.report.not_attending === 2, out.report);
check("their tickets are not in the total", out.report.tickets === 5, out.report.tickets);
check("the original wording is kept",
  out.rows.find((r) => r.email === "dee@example.com").status_raw === "Cancelled");
for (const s of ["Refunded", "refunded", "CANCELLED", "Canceled", "Declined", "Not Attending", "Deleted"]) {
  check(`"${s}" means not coming`, imp.isNotAttending(s) === true);
}
for (const s of ["Attending", "Completed", "Checked In", "", null, undefined]) {
  check(`${JSON.stringify(s)} counts as coming`, imp.isNotAttending(s) === false);
}
out = imp.parseAttendeeCsv("Email,Status\nx@example.com,Some New Eventbrite Word\n");
check("an unfamiliar status counts as coming rather than being dropped",
  out.rows[0].attending === true, out.rows[0]);

section("No column is ever guessed");
// "Ticket Name" contains the word "name"; a greedy match reports a guest list
// of people all called "General Admission".
out = imp.parseAttendeeCsv("Ticket Name,Email\nGeneral Admission,z@example.com\n");
check("a ticket column is not mistaken for a name column", out.rows[0].name === null, out.rows[0]);
check("it is read as the ticket type instead", out.rows[0].ticket_type === "General Admission");
check("and the missing name is reported", out.report.problems.some((p) => /name column/i.test(p)));
check("a broad alias does not steal a specific field's column",
  imp.parseAttendeeCsv("Order Date,Order #,Email\n2026-10-24,55,a@b.co\n").rows[0].external_ref === "55");
check("word-boundary matching does not match inside another word",
  findColumn(["Reorder Code"], ["order"]) === -1);
check("a missing column is -1, never column 0",
  findColumn(["Email", "Phone"], ["quantity"]) === -1);

section("The report says what was understood, so it can be checked first");
out = imp.parseAttendeeCsv(
  "Order #,First Name,Last Name,Email,Status,Marketing Opt In,Barcode\n" +
  "9,Ana,Reyes,a@b.co,Attending,Yes,ABC123\n");
check("the columns it used are named", out.report.mapped.email === "Email", out.report.mapped);
check("the columns it ignored are named too",
  out.report.unmapped_headers.includes("Marketing Opt In"), out.report.unmapped_headers);
check("it does not claim a column it did not find", !("quantity" in out.report.mapped), out.report.mapped);
out = imp.parseAttendeeCsv("First Name,Email\nAna,a@b.co\n");
check("a file with no status column warns that refunds cannot be told apart",
  out.report.problems.some((p) => /refunded or cancelled/i.test(p)), out.report.problems);

section("Re-importing the same export does not double the total");
// Somebody will re-download the export the morning of the event.
const rows = imp.parseAttendeeCsv(TYPICAL).rows;
check("the same rows twice still count once",
  imp.summarise(rows.concat(rows)).registrations === 2, imp.summarise(rows.concat(rows)));
check("and the ticket total does not double",
  imp.summarise(rows.concat(rows)).tickets === 5, imp.summarise(rows.concat(rows)));
check("the Eventbrite reference is the key when there is one",
  imp.dedupeKey({ external_ref: "1001", email: "a@b.co" }) === "ref:1001");
check("the email is the fallback", imp.dedupeKey({ external_ref: null, email: "A@B.co" }) === "email:a@b.co");
check("a row with neither has no key rather than sharing one",
  imp.dedupeKey({ name: "Ana" }) === null);
check("rows that cannot be de-duplicated are counted and reported",
  imp.summarise([{ attending: true, name: "X" }, { attending: true, name: "Y" }]).undedupable === 2);

section("Rubbish in does not become a confident number");
for (const junk of ["", "   ", null, undefined]) {
  const r = imp.parseAttendeeCsv(junk);
  check(`${JSON.stringify(junk)} reads nobody`, r.rows.length === 0 && r.report.attending === 0, r.report);
  check("...and says so", r.report.problems.length > 0, r.report.problems);
}
check("a header row with no attendees reads nobody",
  imp.parseAttendeeCsv("Order #,Email\n").rows.length === 0);
check("a nonsense quantity does not become NaN tickets",
  imp.parseAttendeeCsv("Email,Quantity\na@b.co,lots\n").rows[0].quantity === null);
check("and such a row still counts as one ticket, not zero",
  imp.summarise(imp.parseAttendeeCsv("Email,Quantity\na@b.co,lots\n").rows).tickets === 1);
check("a negative quantity is refused",
  imp.parseAttendeeCsv("Email,Quantity\na@b.co,-4\n").rows[0].quantity === null);

// ---------------------------------------------------------------- the API
section("The API adapter says what it needs, rather than looking healthy");
let st = api.connectorStatus({});
check("with nothing configured it is not ready", st.ready === false, st);
check("it names the token", st.missing.some((m) => /token/i.test(m)), st.missing);
check("and the event id", st.missing.some((m) => /event id/i.test(m)), st.missing);
check("it links the documentation", /eventbrite\.com\/platform\/api/.test(st.docs || ""), st.docs);
// The honesty that matters: this has never made a real request from here.
check("it declares itself unverified against the live service",
  st.verified_against_live_service === false, st);
check("fully configured it reports ready",
  api.connectorStatus({ token: "t", eventbriteEventId: "123" }).ready === true);

section("An attendee object maps to the same shape the CSV produces");
const mapped = api.mapAttendee({
  id: "555", quantity: 3, ticket_class_name: "Family Pass", created: "2026-10-24T10:00:00Z",
  status: "Attending", profile: { name: "Ana Reyes", email: "ANA@Example.com" },
});
check("the name comes through", mapped.name === "Ana Reyes", mapped);
check("the email is lowercased", mapped.email === "ana@example.com", mapped.email);
check("the quantity is a number", mapped.quantity === 3, mapped.quantity);
check("it carries a de-duplication reference", mapped.external_ref === "555", mapped);
check("and reads as attending", mapped.attending === true);
check("a first/last profile is joined when there is no full name",
  api.mapAttendee({ profile: { first_name: "Sam", last_name: "Cruz" } }).name === "Sam Cruz");
check("a refunded attendee is not attending",
  api.mapAttendee({ refunded: true, profile: {} }).attending === false);
check("nor a cancelled one", api.mapAttendee({ cancelled: true, profile: {} }).attending === false);
check("nor one whose status says deleted",
  api.mapAttendee({ status: "Deleted", profile: {} }).attending === false);
check("an unfamiliar status still counts as attending",
  api.mapAttendee({ status: "Something New", profile: {} }).attending === true);
check("junk does not throw", api.mapAttendee(null).attending === false);

section("A failed sync is never reported as zero registrations");
// The rule the dashboard has held since Phase 2: a number we do not have is not
// a number we have that happens to be zero.
const fetchThrows = async () => { throw new Error("connect ECONNREFUSED"); };
let res = await api.fetchAttendees({ token: "t", eventbriteEventId: "1", fetchImpl: fetchThrows });
check("a network failure reports unreachable", res.status === "unreachable", res);
check("it is not ok", res.ok === false, res);
check("and carries the reason", /ECONNREFUSED/.test(res.error || ""), res.error);

const fetch401 = async () => ({ ok: false, status: 401 });
res = await api.fetchAttendees({ token: "bad", eventbriteEventId: "1", fetchImpl: fetch401 });
check("a bad token reports unauthorised", res.status === "unauthorised", res);
check("rather than an empty attendee list being taken as truth",
  res.ok === false && res.attendees.length === 0, res);

const fetchWrongShape = async () => ({ ok: true, status: 200, json: async () => ({ something: "else" }) });
res = await api.fetchAttendees({ token: "t", eventbriteEventId: "1", fetchImpl: fetchWrongShape });
check("an unexpected response shape is reported, not read as zero attendees",
  res.status === "unexpected_shape" && res.ok === false, res);
check("and it keeps a sample so the mapping can be corrected", !!res.sample, res.sample);
check("with nothing configured it refuses before making a request",
  (await api.fetchAttendees({})).status === "not_configured");

section("Paging is followed to the end");
const pages = {
  1: { attendees: [{ id: "1", profile: { email: "a@x.co" } }], pagination: { has_more_items: true, page_count: 2 } },
  2: { attendees: [{ id: "2", profile: { email: "b@x.co" } }], pagination: { has_more_items: false, page_count: 2 } },
};
let requested = [];
const fetchPaged = async (url) => {
  const p = Number((url.match(/page=(\d+)/) || [])[1] || 1);
  requested.push(p);
  return { ok: true, status: 200, json: async () => pages[p] };
};
res = await api.fetchAttendees({ token: "t", eventbriteEventId: "1", fetchImpl: fetchPaged });
check("both pages were fetched", requested.join(",") === "1,2", requested);
check("and both attendees came back", res.attendees.length === 2, res.attendees.length);
check("it stops when there are no more", res.pages === 2, res.pages);
// A paging bug that never terminates would hammer somebody else's API.
requested = [];
const fetchForever = async (url) => {
  requested.push(Number((url.match(/page=(\d+)/) || [])[1] || 1));
  return { ok: true, status: 200, json: async () => ({ attendees: [], pagination: { has_more_items: true } }) };
};
res = await api.fetchAttendees({ token: "t", eventbriteEventId: "1", fetchImpl: fetchForever, maxPages: 5 });
check("a server that always says 'more' is stopped by the page cap",
  requested.length === 5, requested.length);

section("The two routes agree");
// Whichever way the data arrived, everything downstream reads one shape.
const fromApi = [api.mapAttendee({
  id: "1001", quantity: 3, status: "Attending", profile: { name: "Ana Reyes", email: "ana@example.com" },
})];
const fromCsv = imp.parseAttendeeCsv(TYPICAL).rows.slice(0, 1);
check("the same fields exist on both",
  Object.keys(fromApi[0]).sort().join(",") === Object.keys(fromCsv[0]).sort().join(","),
  { api: Object.keys(fromApi[0]).sort(), csv: Object.keys(fromCsv[0]).sort() });
check("and summarise reads either",
  imp.summarise(fromApi).registrations === 1 && imp.summarise(fromCsv).registrations === 1);
check("de-duplication works across both, so one person counted twice is one",
  imp.summarise(fromApi.concat(fromCsv)).registrations === 1,
  imp.summarise(fromApi.concat(fromCsv)));

if (failures.length) console.log("\n  --- failures ---\n" + failures.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
