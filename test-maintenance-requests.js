// Maintenance requests: something is broken, and somebody needs to know.
//
// Built on the Supply Request pattern, so most of what is asserted here is the
// part that ISN'T shared:
//
//   * A SAFETY ISSUE reaches leadership on arrival, not when somebody next
//     opens the queue -- and reaches them only once, however many times it is
//     edited afterwards.
//   * A member of staff sees their own requests and nobody else's, and never
//     the internal notes or what the vendor charged.
//   * The public page takes no login, because the person who finds the broken
//     lock may not have one.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-maintenance-requests.js
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 320) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, { method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}
const mailsFor = async (id, type) => (await pool.query(
  "SELECT id, type FROM notifications_log WHERE ref_type = 'maintenance_request' AND ref_id = $1" +
  (type ? " AND type = $2" : ""), type ? [id, type] : [id])).rows;

(async () => {
  const owner = client(), staff = client(), other = client();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST",
    body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  await staff("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  await other("/api/auth/login", { method: "POST", body: { email: "billing@spectrumsquadlv.com", password: "TestStaff123!" } });
  await owner("/api/maintenance/settings", { method: "PUT", body: {
    notify_to: "facilities@spectrumsquadlv.com", escalate_to: "leadership@spectrumsquadlv.com" } });

  // ==================================================================
  section("Reporting something");
  const mine = await staff("/api/maintenance/requests", { method: "POST", body: {
    description: "Tap in room 3 will not shut off", location: "Main clinic", area: "Room 3",
    category: "Plumbing", priority: "Needs Attention" } });
  check("a member of staff can report something", mine.status === 201, mine.data);
  check("it starts as Submitted", mine.data.status === "Submitted", mine.data.status);
  check("the description is required", (await staff("/api/maintenance/requests", { method: "POST", body: {} })).status === 400);
  const odd = await staff("/api/maintenance/requests", { method: "POST", body: {
    description: "Thing", category: "Nonsense", priority: "Whenever" } });
  check("AN UNKNOWN CATEGORY FALLS BACK rather than being refused — the report matters more than the label",
    odd.status === 201 && odd.data.category === "Other" && odd.data.priority === "Routine", odd.data);

  // ==================================================================
  section("A safety issue does not wait for anyone to look");
  const safety = await staff("/api/maintenance/requests", { method: "POST", body: {
    description: "Exposed wire by the back door", category: "Safety Hazard", priority: "Safety Issue" } });
  check("it is flagged the moment it arrives", !!safety.data.escalated_at, safety.data);
  check("...and the reason is recorded", safety.data.escalated_reason === "Safety Issue", safety.data.escalated_reason);
  const esc1 = await mailsFor(safety.data.id, "maintenance_escalation");
  check("LEADERSHIP IS EMAILED, separately from the ordinary new-request alert", esc1.length === 1, esc1);
  const full = await owner(`/api/maintenance/requests/${safety.data.id}`);
  check("the escalation is on the record", full.data.history.some((h) => h.action === "escalated"),
    full.data.history.map((h) => h.action));

  check("an ordinary request is NOT escalated",
    !mine.data.escalated_at && (await mailsFor(mine.data.id, "maintenance_escalation")).length === 0);

  // ==================================================================
  section("Raised in priority later, told once");
  {
    const r = await owner(`/api/maintenance/requests/${mine.data.id}`, { method: "PATCH", body: { priority: "Urgent" } });
    check("raising it to Urgent flags it", !!r.data.escalated_at, r.data);
    check("...and tells leadership", (await mailsFor(mine.data.id, "maintenance_escalation")).length === 1);
    await owner(`/api/maintenance/requests/${mine.data.id}`, { method: "PATCH", body: { priority: "Safety Issue" } });
    check("RAISING IT AGAIN DOES NOT TELL THEM TWICE — an alert that repeats is an alert that gets filtered",
      (await mailsFor(mine.data.id, "maintenance_escalation")).length === 1,
      await mailsFor(mine.data.id, "maintenance_escalation"));
  }

  // ==================================================================
  section("Who sees what");
  {
    const o = await owner("/api/maintenance/requests");
    const s = await staff("/api/maintenance/requests");
    const b = await other("/api/maintenance/requests");
    check("an administrator sees the whole queue", o.data.requests.length >= 3, o.data.requests.length);
    check("a member of staff sees their own", s.data.requests.length >= 2 && s.data.can_manage === false, s.data.requests.length);
    check("SOMEBODY ELSE'S REQUESTS ARE NOT IN THEIR LIST",
      b.data.requests.every((r) => !/Tap in room 3|Exposed wire/.test(r.description)),
      b.data.requests.map((r) => r.description));
    const peek = await other(`/api/maintenance/requests/${mine.data.id}`);
    check("...nor can they open one directly", peek.status === 403, peek.status);
  }

  // ==================================================================
  section("What an administrator adds, and what stays theirs");
  {
    const id = mine.data.id;
    const upd = await owner(`/api/maintenance/requests/${id}`, { method: "PATCH", body: {
      status: "Assigned", assigned_to: "Facilities", vendor_name: "AAA Plumbing",
      vendor_contact: "555-0100", internal_notes: "Quoted $200, do not approve over $300" } });
    check("they can assign and update it", upd.status === 200 && upd.data.status === "Assigned", upd.data.status);
    const seen = await staff(`/api/maintenance/requests/${id}`);
    check("the person who reported it sees the status", seen.status === 200 && seen.data.status === "Assigned");
    check("THEY DO NOT SEE THE INTERNAL NOTES", seen.data.internal_notes === undefined, seen.data.internal_notes);
    check("...nor what the vendor costs", seen.data.vendor_contact === undefined, seen.data.vendor_contact);
    check("an administrator does", (await owner(`/api/maintenance/requests/${id}`)).data.internal_notes
      === "Quoted $200, do not approve over $300");

    const bad = await owner(`/api/maintenance/requests/${id}`, { method: "PATCH", body: { status: "Fixed-ish" } });
    check("a status that is not in the flow is refused", bad.status === 400, bad.data);
    const nope = await staff(`/api/maintenance/requests/${id}`, { method: "PATCH", body: { status: "Closed" } });
    check("THE PERSON WHO REPORTED IT CANNOT CLOSE IT", nope.status === 403, nope.status);
  }

  // ==================================================================
  section("Telling the person what happened");
  {
    const id = mine.data.id;
    const before = (await mailsFor(id, "maintenance_status")).length;
    await owner(`/api/maintenance/requests/${id}`, { method: "PATCH", body: { status: "Completed" } });
    check("finishing the job emails whoever reported it", (await mailsFor(id, "maintenance_status")).length === before + 1);
    const h = (await owner(`/api/maintenance/requests/${id}`)).data.history;
    check("every move is on the record with who made it",
      h.some((x) => x.action === "status_change" && x.to_status === "Completed" && x.actor_name),
      h.filter((x) => x.action === "status_change"));
  }

  // ==================================================================
  section("The person who finds it may not have a login");
  {
    const r = await fetch(BASE + "/api/maintenance/public/submit", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Front door lock sticking", category: "Doors/Locks",
        requester_email: "contractor@example.invalid", requester_name: "A Contractor" }) });
    check("THE PUBLIC PAGE TAKES A REPORT WITH NO SESSION AT ALL", r.status === 201, r.status);
    const noEmail = await fetch(BASE + "/api/maintenance/public/submit", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: "Broken" }) });
    check("...but not without a way to reply", noEmail.status === 400, noEmail.status);
    const page = await fetch(BASE + "/maintenance-request").then((x) => x.status);
    check("and the page the queue advertises actually exists", page === 200, page);
    const opts = await fetch(BASE + "/api/maintenance/options").then((x) => x.json());
    check("it reads its categories from the server, so the two cannot drift",
      (opts.categories || []).includes("Plumbing") && (opts.priorities || []).includes("Safety Issue"), opts);
  }

  // ==================================================================
  section("The queue counts what is actually there");
  {
    const d = (await owner("/api/maintenance/requests")).data;
    const c = d.counts;
    const rows = d.requests;
    check("open counts only what is still open",
      c.open === rows.filter((r) => r.is_open).length, { counted: c.open, actual: rows.filter((r) => r.is_open).length });
    check("A SAFETY ISSUE THAT IS CLOSED IS NOT STILL COUNTED AS ONE",
      c.safety === rows.filter((r) => r.priority === "Safety Issue" && r.is_open).length,
      { counted: c.safety, actual: rows.filter((r) => r.priority === "Safety Issue" && r.is_open).length });
    const s = (await staff("/api/maintenance/requests")).data;
    check("a member of staff is never shown a total they cannot open",
      s.counts.open === s.requests.filter((r) => r.is_open).length,
      { counted: s.counts.open, visible: s.requests.filter((r) => r.is_open).length });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
