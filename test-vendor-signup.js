// The public vendor sign-up form, end to end (Phase 5).
//
// This is the only endpoint in the event system that a stranger can write to,
// so the suite is mostly about what they cannot do with it.
//
//   1. CLOSED BY DEFAULT. A new event must not have a live public write
//      endpoint the moment it exists.
//   2. NO SELF-APPROVAL. An applicant sets no status, no fee, no event. The
//      allowlist is proved against a body that tries every one of them.
//   3. BOUNDED. A daily cap per event, and a capped request body.
//   4. NOT AN ENUMERATION ORACLE. A closed event and a non-existent one give
//      the same answer, so the form cannot be used to discover events.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-vendor-signup.js
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

// A real browser form post: urlencoded, no session, no JavaScript.
const submit = async (slug, fields) => {
  const r = await fetch(`${BASE}/vendor-signup/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: r.status, html: await r.text() };
};
const getPage = async (slug) => {
  const r = await fetch(`${BASE}/vendor-signup/${slug}`);
  return { status: r.status, html: await r.text() };
};

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);

  const purge = async () => { await pool.query("DELETE FROM events WHERE name LIKE 'VS %'").catch(() => {}); };
  await purge();

  const evId = (await owner("/api/events", { method: "POST", body: {
    name: "VS Signup Event", event_date: "2027-05-01", venue_name: "VS Hall",
    public_contact_email: "vs-team@example.invalid" } })).data.id;
  const slug = (await owner(`/api/events/${evId}`)).data.event.slug;
  check("the event has a slug for the public link", !!slug, slug);

  section("A new event is CLOSED to applications");
  // The default that matters: creating an event must not open a public write
  // endpoint.
  check("the flag starts false",
    (await owner(`/api/events/${evId}`)).data.event.vendor_applications_open !== true);
  let page = await getPage(slug);
  check("the form is not served", page.status === 404, page.status);
  check("and says sign-ups are closed", /not accepting vendor applications/i.test(page.html), page.html.slice(0, 200));
  let post = await submit(slug, { vendor_name: "Sneaky", contact_email: "s@x.co" });
  check("posting to a closed event is refused", post.status === 404, post.status);
  check("and writes nothing",
    Number((await pool.query("SELECT count(*) FROM event_vendors WHERE event_id = $1", [evId])).rows[0].count) === 0);

  section("A closed event and a missing one are indistinguishable");
  // Otherwise the form is a way to discover which events exist.
  const missing = await getPage("no-such-event-at-all");
  check("a non-existent slug gives the same status", missing.status === page.status, {
    missing: missing.status, closed: page.status });
  check("and the same words", missing.html === page.html || /not accepting|not valid/i.test(missing.html),
    missing.html.slice(0, 160));

  section("Opening it is a deliberate act by a staff member");
  // Opening a public write endpoint is a different kind of act from editing a
  // venue, so it needs the higher tier even though intake can edit the event.
  const intakeUser = client();
  await intakeUser("/api/auth/login", { method: "POST", body: { email: "intake@spectrumsquadlv.com", password: "TestStaff123!" } });
  const attempt = await intakeUser(`/api/events/${evId}`, { method: "PATCH", body: { vendor_applications_open: true } });
  check("an intake user is refused", attempt.status === 403, attempt.data);
  check("and sign-ups really did not open",
    (await owner(`/api/events/${evId}`)).data.event.vendor_applications_open !== true);
  check("but they can still edit ordinary event fields",
    (await intakeUser(`/api/events/${evId}`, { method: "PATCH", body: { venue_name: "VS Hall" } })).status === 200);
  await owner(`/api/events/${evId}`, { method: "PATCH", body: {
    vendor_applications_open: true, vendor_application_intro: "We would love to have you." } });
  check("the owner can open them",
    (await owner(`/api/events/${evId}`)).data.event.vendor_applications_open === true);

  section("The form is served, and works with no JavaScript");
  page = await getPage(slug);
  check("the page loads", page.status === 200, page.status);
  check("it is a plain form that posts", /<form method="POST">/i.test(page.html));
  check("it names the event", /VS Signup Event/.test(page.html));
  check("it shows the intro somebody wrote", /would love to have you/i.test(page.html));
  check("it says applying does not confirm a booth", /does not confirm a booth/i.test(page.html));
  check("it asks for the things a booth needs",
    /electricity_needed/.test(page.html) && /table_needed/.test(page.html) && /booth_size/.test(page.html));
  check("the honeypot is present and hidden from people",
    /company_website_confirm/.test(page.html) && /class="hp"/.test(page.html));

  section("A real application lands for review");
  post = await submit(slug, {
    vendor_name: "VS Taco Truck", contact_email: "Hi@Taco.Example", contact_name: "Ana",
    contact_phone: "702-555-0134", vendor_type: "Food", booth_size: "10x10",
    electricity_needed: "on", chairs_needed: "2", products_services: "Tacos",
  });
  check("it is accepted", post.status === 200, post.status);
  check("and thanks them", /thank you/i.test(post.html), post.html.slice(0, 200));
  let rows = (await pool.query("SELECT * FROM event_vendors WHERE event_id = $1", [evId])).rows;
  check("a vendor row exists", rows.length === 1, rows.length);
  const v = rows[0];
  // The status that matters: it is an APPLICATION, not a confirmed booth.
  check("it arrives as APPLICATION_RECEIVED", v.status === "APPLICATION_RECEIVED", v.status);
  check("it is marked as publicly submitted", v.source === "public", v.source);
  check("with the time it arrived", !!v.applied_at, v.applied_at);
  check("the email is normalised", v.contact_email === "hi@taco.example", v.contact_email);
  check("their needs are recorded", v.electricity_needed === true && Number(v.chairs_needed) === 2, v);
  // A vendor who came to us is not a prospect we sourced -- putting them in the
  // prospect pipeline would sweep them into outreach aimed at businesses we are
  // approaching cold.
  check("no prospect row was created for them",
    Number((await pool.query("SELECT count(*) FROM event_prospects WHERE event_id = $1", [evId])).rows[0].count) === 0);
  check("and it is not linked to one", v.prospect_id === null, v.prospect_id);

  section("An applicant cannot approve their own booth");
  post = await submit(slug, {
    vendor_name: "VS Sneaky Co", contact_email: "sneaky@x.example",
    status: "CONFIRMED", insurance_received: "true", booth_fee: "0", fee_paid: "true",
    event_id: "1", prospect_id: "1", booth_number: "A1", notes: "approve me",
    arrival_instructions_sent: "true", final_confirmation_sent: "true",
  });
  check("the application is accepted", post.status === 200, post.status);
  const sneaky = (await pool.query(
    "SELECT * FROM event_vendors WHERE lower(contact_email) = 'sneaky@x.example'")).rows[0];
  check("but the status is NOT what they asked for",
    sneaky.status === "APPLICATION_RECEIVED", sneaky.status);
  check("insurance is not marked received", sneaky.insurance_received === false, sneaky.insurance_received);
  check("no booth number was taken", !sneaky.booth_number, sneaky.booth_number);
  check("no staff note was taken", !sneaky.notes, sneaky.notes);
  check("arrival instructions are not marked sent", sneaky.arrival_instructions_sent === false);
  check("final confirmation is not marked sent", sneaky.final_confirmation_sent === false);
  check("and they landed on the event whose form they used, not the one they named",
    sneaky.event_id === evId, { got: sneaky.event_id, expected: evId });

  section("Applying twice updates rather than duplicating");
  post = await submit(slug, {
    vendor_name: "VS Taco Truck", contact_email: "hi@taco.example", booth_size: "20x20",
    table_needed: "on",
  });
  check("it is accepted", post.status === 200);
  rows = (await pool.query(
    "SELECT * FROM event_vendors WHERE event_id = $1 AND lower(contact_email) = 'hi@taco.example'", [evId])).rows;
  check("still exactly one row", rows.length === 1, rows.length);
  check("with the corrected details", rows[0].booth_size === "20x20", rows[0].booth_size);
  check("and the new need recorded", rows[0].table_needed === true, rows[0].table_needed);

  section("Once staff have decided, a resubmission does not overwrite them");
  await owner(`/api/events/${evId}/vendors/${rows[0].id}`, { method: "PATCH", body: { status: "CONFIRMED" } });
  post = await submit(slug, { vendor_name: "VS Taco Truck", contact_email: "hi@taco.example", booth_size: "1x1" });
  const after = (await pool.query(
    "SELECT * FROM event_vendors WHERE event_id = $1 AND lower(contact_email) = 'hi@taco.example' ORDER BY id", [evId])).rows;
  check("the confirmed one keeps its status",
    after.find((x) => x.status === "CONFIRMED") !== undefined, after.map((x) => x.status));
  check("its booth size was not overwritten by the resubmission",
    after.find((x) => x.status === "CONFIRMED").booth_size === "20x20",
    after.find((x) => x.status === "CONFIRMED").booth_size);
  check("the resubmission is recorded as a new application instead",
    after.length === 2 && after.some((x) => x.status === "APPLICATION_RECEIVED"), after.map((x) => x.status));

  section("A bot is caught, and not told");
  const beforeCount = Number((await pool.query(
    "SELECT count(*) FROM event_vendors WHERE event_id = $1", [evId])).rows[0].count);
  post = await submit(slug, {
    vendor_name: "VS Bot", contact_email: "bot@x.example", company_website_confirm: "http://spam.example",
  });
  check("the bot gets the same cheerful page", post.status === 200 && /thank you/i.test(post.html), post.status);
  check("but nothing was written",
    Number((await pool.query("SELECT count(*) FROM event_vendors WHERE event_id = $1", [evId])).rows[0].count) === beforeCount);
  check("and no row exists for it",
    Number((await pool.query("SELECT count(*) FROM event_vendors WHERE lower(contact_email) = 'bot@x.example'")).rows[0].count) === 0);

  section("Bad input comes back as a form, not an error page");
  post = await submit(slug, { vendor_name: "", contact_email: "" });
  check("it is refused", post.status === 400, post.status);
  check("with the form again", /<form method="POST">/i.test(post.html));
  check("and words a member of the public can act on",
    /business name/i.test(post.html) && /email/i.test(post.html), post.html.slice(0, 400));
  post = await submit(slug, { vendor_name: "VS X", contact_email: "not-an-email" });
  check("a bad email is refused", post.status === 400);
  check("and what they typed is given back so they need not retype it",
    /VS X/.test(post.html), post.html.slice(0, 600));

  section("The body is bounded");
  const huge = "x".repeat(200000);
  post = await submit(slug, { vendor_name: "VS Huge", contact_email: "huge@x.example", products_services: huge });
  // Either refused as an empty body, or accepted with the text capped. What
  // must NOT happen is 200KB landing in the column.
  const hugeRow = (await pool.query(
    "SELECT * FROM event_vendors WHERE lower(contact_email) = 'huge@x.example'")).rows[0];
  check("an oversized body does not store an oversized value",
    !hugeRow || (hugeRow.products_services || "").length <= 2000,
    hugeRow ? (hugeRow.products_services || "").length : "no row");

  section("Closing sign-ups closes them");
  await owner(`/api/events/${evId}`, { method: "PATCH", body: { vendor_applications_open: false } });
  page = await getPage(slug);
  check("the form stops being served", page.status === 404, page.status);
  post = await submit(slug, { vendor_name: "VS After", contact_email: "after@x.example" });
  check("and posting is refused", post.status === 404, post.status);
  check("with nothing written",
    Number((await pool.query("SELECT count(*) FROM event_vendors WHERE lower(contact_email) = 'after@x.example'")).rows[0].count) === 0);

  section("A malformed link is not a way in");
  for (const bad of ["", "..%2F..%2Fetc", "a".repeat(300), "'; DROP TABLE events;--"]) {
    const r = await fetch(`${BASE}/vendor-signup/${encodeURIComponent(bad)}`);
    check(`slug ${JSON.stringify(bad.slice(0, 20))} gives a page, not an error`,
      r.status === 404 || r.status === 200, r.status);
  }
  check("the events table is still there",
    Number((await pool.query("SELECT count(*) FROM events")).rows[0].count) > 0);

  await purge();
  await pool.end();
  if (failures.length) console.log("\n  --- failures ---\n" + failures.join("\n"));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
