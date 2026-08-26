// Registrations reaching the dashboard (Phase 6), end to end.
//
// The parsing and the API adapter are covered in test-eventbrite.js. This
// drives the real endpoints and checks the one rule the dashboard has held
// since Phase 2:
//
//   A NUMBER WE DO NOT HAVE IS NOT ZERO. Before any sync the registration
//   meter says where the figure lives. A FAILED sync must not overwrite a good
//   number, and must never turn into "nobody has registered" for an event that
//   has sold out.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-registrations.js
"use strict";
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

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

function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}

const CSV =
  "Order #,Order Date,First Name,Last Name,Email,Quantity,Ticket Type,Status\n" +
  "2001,2026-10-24,Ana,Reyes,ana@reg.invalid,3,Family,Attending\n" +
  "2002,2026-10-24,Marcus,Bell,marcus@reg.invalid,2,Family,Attending\n" +
  "2003,2026-10-24,Sam,Cruz,sam@reg.invalid,4,Family,Refunded\n";

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);

  const purge = async () => { await pool.query("DELETE FROM events WHERE name LIKE 'REG %'").catch(() => {}); };
  await purge();

  const evId = (await owner("/api/events", { method: "POST", body: {
    name: "REG Test Event", event_date: "2027-02-01", registration_goal: 400 } })).data.id;

  section("Before any sync the dashboard admits it does not know");
  let dash = (await owner(`/api/events/${evId}/dashboard`)).data;
  check("the registration meter keeps its goal", dash.meters.registrations.target === 400, dash.meters.registrations);
  check("but the actual is unknown, not zero", dash.meters.registrations.actual_known === false, dash.meters.registrations);
  check("and null rather than 0", dash.meters.registrations.actual === null, dash.meters.registrations);
  check("no percentage is computed against a number we do not have",
    dash.meters.registrations.percent === null, dash.meters.registrations);
  check("and it says where the figure lives",
    /eventbrite/i.test(dash.meters.registrations.source || ""), dash.meters.registrations.source);

  section("The connector says what it needs rather than looking healthy");
  let reg = (await owner(`/api/events/${evId}/registrations`)).data;
  check("it reports not ready", reg.connector.ready === false, reg.connector);
  check("naming the token", reg.connector.missing.some((m) => /token/i.test(m)), reg.connector.missing);
  check("and the event id", reg.connector.missing.some((m) => /event id/i.test(m)), reg.connector.missing);
  // The honesty that matters most here.
  check("it declares the API adapter unverified against the live service",
    reg.connector.verified_against_live_service === false, reg.connector);
  check("and says so in words too", /not been verified/i.test(reg.api_note || ""), reg.api_note);
  check("no sync has happened yet", reg.latest === null, reg.latest);

  section("A dry run shows what would be counted, and records nothing");
  const dry = await owner(`/api/events/${evId}/registrations/import`, {
    method: "POST", body: { csv: CSV, dry_run: true } });
  check("it reads the file", dry.data.report.rows_read === 3, dry.data.report);
  check("counting only the two who are coming", dry.data.summary.registrations === 2, dry.data.summary);
  check("and five tickets between them", dry.data.summary.tickets === 5, dry.data.summary);
  check("nothing was recorded", dry.data.recorded === false, dry.data);
  check("the dashboard still says it does not know",
    (await owner(`/api/events/${evId}/dashboard`)).data.meters.registrations.actual_known === false);

  section("A real import puts a number on the dashboard");
  const imp = await owner(`/api/events/${evId}/registrations/import`, { method: "POST", body: { csv: CSV } });
  check("it succeeds", imp.data.ok === true, imp.data);
  check("and is recorded", imp.data.recorded === true, imp.data);
  dash = (await owner(`/api/events/${evId}/dashboard`)).data;
  check("the meter now carries a real figure", dash.meters.registrations.actual === 2, dash.meters.registrations);
  check("and knows it", dash.meters.registrations.actual_known === true, dash.meters.registrations);
  check("with a percentage against the goal", dash.meters.registrations.percent === 0.5, dash.meters.registrations);
  // A figure with no provenance is the thing this was built to avoid.
  check("and says where it came from and when",
    /eventbrite/i.test(dash.meters.registrations.source || "") && /csv/i.test(dash.meters.registrations.source || ""),
    dash.meters.registrations.source);
  check("the refunded order is not in the count", dash.meters.registrations.actual !== 3);

  section("Re-importing the same export does not double the number");
  await owner(`/api/events/${evId}/registrations/import`, { method: "POST", body: { csv: CSV } });
  dash = (await owner(`/api/events/${evId}/dashboard`)).data;
  check("still two registrations", dash.meters.registrations.actual === 2, dash.meters.registrations);

  section("A FAILED sync never overwrites a good number with zero");
  // The rule that matters. An unreadable file must not make a sold-out event
  // read as nobody having registered.
  const bad = await owner(`/api/events/${evId}/registrations/import`, {
    method: "POST", body: { csv: "this is not a csv at all" } });
  check("the import reports failure", bad.data.ok === false, bad.data);
  dash = (await owner(`/api/events/${evId}/dashboard`)).data;
  check("the dashboard still shows the last GOOD figure", dash.meters.registrations.actual === 2, dash.meters.registrations);
  check("not zero", dash.meters.registrations.actual !== 0, dash.meters.registrations);
  const failed = (await pool.query(
    "SELECT * FROM event_registration_sync WHERE event_id = $1 AND status = 'failed' ORDER BY id DESC LIMIT 1",
    [evId])).rows[0];
  check("but the failed attempt IS recorded, so it is not invisible", !!failed, failed);
  check("with what went wrong", !!(failed && failed.problems), failed && failed.problems);

  section("An empty file is a failure, not a report of zero");
  await owner(`/api/events/${evId}/registrations/import`, { method: "POST", body: { csv: "" } });
  dash = (await owner(`/api/events/${evId}/dashboard`)).data;
  check("the good figure survives that too", dash.meters.registrations.actual === 2, dash.meters.registrations);

  section("The API route reports honestly when it cannot run");
  const sync = await owner(`/api/events/${evId}/registrations/sync`, { method: "POST", body: {} });
  check("it does not pretend to have run", sync.data.ok === false, sync.data);
  check("it says it is not configured", sync.data.status === "not_configured", sync.data);
  check("and repeats what is missing", (sync.data.connector.missing || []).length > 0, sync.data.connector);
  dash = (await owner(`/api/events/${evId}/dashboard`)).data;
  check("and the good CSV figure is untouched", dash.meters.registrations.actual === 2, dash.meters.registrations);

  section("The history is kept, so a wrong number can be traced");
  reg = (await owner(`/api/events/${evId}/registrations`)).data;
  check("several attempts are listed", (reg.history || []).length >= 4, (reg.history || []).length);
  check("each says which route it used",
    reg.history.every((h) => h.source === "csv" || h.source === "api"), reg.history.map((h) => h.source));
  check("and whether it worked",
    reg.history.every((h) => h.status === "success" || h.status === "failed"), reg.history.map((h) => h.status));
  check("and who ran it", reg.history.every((h) => !!h.synced_by), reg.history[0]);
  check("the latest SUCCESS is what the dashboard used",
    reg.latest && Number(reg.latest.registrations) === 2, reg.latest);

  section("Setting the Eventbrite event id moves the connector along");
  await owner(`/api/events/${evId}`, { method: "PATCH", body: { eventbrite_event_id: "123456789" } });
  reg = (await owner(`/api/events/${evId}/registrations`)).data;
  check("the id is stored", reg.eventbrite_event_id === "123456789", reg.eventbrite_event_id);
  check("and the connector now only wants the token",
    reg.connector.missing.length === 1 && /token/i.test(reg.connector.missing[0]), reg.connector.missing);
  check("it is still not ready", reg.connector.ready === false, reg.connector);

  section("Not everyone may import registrations");
  const intake = client();
  await intake("/api/auth/login", { method: "POST", body: { email: "intake@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("an intake user can see the state", (await intake(`/api/events/${evId}/registrations`)).status === 200);
  check("but cannot import",
    (await intake(`/api/events/${evId}/registrations/import`, { method: "POST", body: { csv: CSV } })).status === 403);
  check("nor run the API sync",
    (await intake(`/api/events/${evId}/registrations/sync`, { method: "POST", body: {} })).status === 403);
  const clinical = client();
  await clinical("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("a clinical user cannot reach any of it",
    (await clinical(`/api/events/${evId}/registrations`)).status === 403);

  section("Registrations stay isolated by event");
  const ev2 = (await owner("/api/events", { method: "POST", body: {
    name: "REG Other Event", registration_goal: 100 } })).data.id;
  const d2 = (await owner(`/api/events/${ev2}/dashboard`)).data;
  check("another event has no registration figure", d2.meters.registrations.actual_known === false, d2.meters.registrations);
  check("and its own sync history is empty",
    ((await owner(`/api/events/${ev2}/registrations`)).data.history || []).length === 0);
  check("an unknown event is a 404", (await owner("/api/events/99999999/registrations")).status === 404);

  await purge();
  await pool.end();
  if (failures.length) console.log("\n  --- failures ---\n" + failures.join("\n"));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
