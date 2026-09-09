// test-onboarding-former-staff.js -- onboarding is work keyed to an employment,
// and it has to end when the employment does.
//
// The bug this suite exists for: nothing in onboarding.js ever read
// hr_employees.status. The deadline sweep joined that table for a name and an
// email, and the four portal routes found the record by its token without ever
// asking who it belonged to. So a new hire who was terminated or withdrew part
// way through their paperwork kept being emailed "we're still waiting on a few
// of your onboarding documents", kept generating staff tasks to chase them,
// and -- the half that matters most -- the link in that email still worked.
// A former employee could still upload their driver's licence and their
// certificates, and the CRM would file them against the employee record,
// create certification records off them, and tell leadership the onboarding
// was complete.
//
// Two things are being tested at once here, so each refusal is written with
// its positive control beside it:
//
//   1. That the guard fires. Easy to write, easy to pass for the wrong reason:
//      a sweep that emails nobody at all passes every "did not email" check in
//      this file. Every silence is therefore paired with a hire who SHOULD be
//      chased, in the same sweep.
//   2. That the guard does not fire on people who are still here. A new hire's
//      employment status is literally 'onboarding' while they are doing this,
//      somebody on leave is still staff, and -- the one that would have been a
//      genuinely worse bug than the one being fixed -- a REHIRE accepts an
//      offer while their old record still says terminated.
//
//   DATABASE_URL=... node server.js
//   node test-onboarding-former-staff.js
"use strict";

const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    const d = detail === undefined ? "" : "\n          -> " +
      String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400);
    console.log("  FAIL  " + name + d);
  }
};
const section = (t) => console.log("\n== " + t + " ==");

(async () => {
  async function login(email, password) {
    const res = await fetch(BASE + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error("login failed for " + email + ": " + res.status);
    const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
    return async (path, opts = {}) => {
      const r = await fetch(BASE + path, {
        method: opts.method || "GET",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const ct = r.headers.get("content-type") || "";
      return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => ({})) : await r.text() };
    };
  }
  // The portal is public: no cookie, and the upload route takes the file as the
  // raw body rather than JSON, which is how new-hire.html posts it.
  const anon = async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: opts.raw ? {} : { "Content-Type": "application/json" },
      body: opts.raw !== undefined ? opts.raw : (opts.body ? JSON.stringify(opts.body) : undefined),
    });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => ({})) : await r.text() };
  };

  const owner = await login("admin@spectrumsquadlv.com", OWNER_PW);
  const stamp = Date.now().toString().slice(-6);

  const sql = (q, p) => pool.query(q, p);
  const one = async (q, p) => (await sql(q, p)).rows[0] || null;

  // A hire with a portal, made the way the CRM makes one: the employee exists
  // and is being onboarded, and the record is started from the staff side.
  async function mkHire(label, opts = {}) {
    const email = `ob.${label}.${stamp}@example.invalid`;
    const emp = await one(
      `INSERT INTO hr_employees (name, email, role_title, status, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [`Zz Onboard ${label} ${stamp}`, email, opts.role || "Registered Behavior Technician",
       opts.status || "onboarding", new Date().toISOString()]
    );
    const started = await owner(`/api/onboarding/employee/${emp.id}`, { method: "POST" });
    if (started.status !== 201) throw new Error(`could not start onboarding for ${label}: ${JSON.stringify(started.data)}`);
    const rec = await one("SELECT * FROM onboarding_records WHERE employee_id = $1", [emp.id]);
    return { id: emp.id, email, recId: rec.id, token: rec.portal_token };
  }

  const setStatus = (id, status) => sql("UPDATE hr_employees SET status = $1 WHERE id = $2", [status, id]);
  // Put the deadline where the sweep will act on it, and clear the two stamps
  // that make the sweep once-only so each section starts from the same place.
  const setDeadline = (recId, hoursFromNow) => sql(
    `UPDATE onboarding_records SET deadline_at = $1, nudge_sent_at = NULL, overdue_flagged_at = NULL,
       status = 'awaiting_documents' WHERE id = $2`,
    [new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString(), recId]
  );
  const emailsTo = async (email) => Number((await one(
    "SELECT COUNT(*) AS n FROM notifications_log WHERE recipient = $1", [email])).n);
  const tasksFor = async (empId) => Number((await one(
    "SELECT COUNT(*) AS n FROM staff_tasks WHERE description = $1", [`Staff #${empId}`])).n);
  const recOf = (recId) => one("SELECT * FROM onboarding_records WHERE id = $1", [recId]);
  const docOf = (recId, key) => one(
    "SELECT * FROM onboarding_documents WHERE onboarding_id = $1 AND doc_key = $2", [recId, key]);

  // ================================================================
  section("The sweep does not chase somebody who has left");

  const staying   = await mkHire("staying");
  const leaving   = await mkHire("leaving");
  const archived  = await mkHire("archived");
  const onLeave   = await mkHire("onleave");
  const noStatus  = await mkHire("nostatus");

  await setStatus(leaving.id, "terminated");
  await setStatus(archived.id, "archived");
  await setStatus(onLeave.id, "leave");
  await sql("UPDATE hr_employees SET status = NULL WHERE id = $1", [noStatus.id]);

  // Inside the nudge window: more than nothing left, less than 24 hours.
  for (const h of [staying, leaving, archived, onLeave, noStatus]) await setDeadline(h.recId, 12);

  const swept = await owner("/api/onboarding/sweep", { method: "POST" });
  check("the sweep runs", swept.status === 200, swept.data);

  check("the hire who is still here IS nudged — without this, every silence below passes for the wrong reason",
    (await emailsTo(staying.email)) === 1, await emailsTo(staying.email));
  check("somebody terminated mid-paperwork is not emailed about their documents",
    (await emailsTo(leaving.email)) === 0);
  check("an archived record is treated the same as a terminated one",
    (await emailsTo(archived.email)) === 0);
  check("somebody on leave is still staff, and is still nudged",
    (await emailsTo(onLeave.email)) === 1, await emailsTo(onLeave.email));
  check("a blank status means active, not gone",
    (await emailsTo(noStatus.email)) === 1, await emailsTo(noStatus.email));
  check("the nudge stamp is only written for the people who were nudged",
    !!(await recOf(staying.recId)).nudge_sent_at && !(await recOf(leaving.recId)).nudge_sent_at);

  // ---------------------------------------------------------------- overdue
  const overdueHere = await mkHire("overduehere");
  const overdueGone = await mkHire("overduegone");
  await setStatus(overdueGone.id, "terminated");
  await setDeadline(overdueHere.recId, -2);
  await setDeadline(overdueGone.recId, -2);

  const swept2 = await owner("/api/onboarding/sweep", { method: "POST" });
  check("the overdue sweep runs", swept2.status === 200, swept2.data);
  check("a deadline that has passed still raises a task for somebody who is here",
    (await tasksFor(overdueHere.id)) === 1, await tasksFor(overdueHere.id));
  check("no task is raised to chase somebody who has already left",
    (await tasksFor(overdueGone.id)) === 0);
  check("and their record is not flagged past deadline either",
    !(await recOf(overdueGone.recId)).overdue_flagged_at);
  check("the record of somebody who is here IS flagged",
    !!(await recOf(overdueHere.recId)).overdue_flagged_at);
  check("the sweep counts what it did, not what it skipped",
    swept2.data && swept2.data.flagged === 1, swept2.data);

  // ================================================================
  section("The link in that email stops opening");

  const portalHere = await mkHire("portalhere");
  const portalGone = await mkHire("portalgone");
  await setStatus(portalGone.id, "terminated");

  const openHere = await anon(`/api/onboarding/public/portal?token=${portalHere.token}`);
  check("a current hire's link opens", openHere.status === 200, openHere.data);
  // The routes below now read the staff record once, at the top, instead of
  // looking it up again further down. This is what proves that record is still
  // reaching the parts of them that use it.
  check("and it still greets them by name", openHere.data.first_name === "Zz", openHere.data.first_name);

  const openGone = await anon(`/api/onboarding/public/portal?token=${portalGone.token}`);
  check("a former employee's link does not", openGone.status === 403, openGone.data);
  check("and it says so kindly, pointing at a human",
    /no longer active/i.test(openGone.data.error || "") && /reply to your welcome email/i.test(openGone.data.error || ""),
    openGone.data);
  check("without announcing an employment status to whoever is holding the link",
    !/terminat|archiv|fired|dismiss/i.test(openGone.data.error || ""), openGone.data);

  // The portal's own reading of "still here", which is JavaScript rather than
  // the sweep's SQL and can disagree with it if nobody looks.
  const portalLeave = await mkHire("portalleave");
  await setStatus(portalLeave.id, "leave");
  const openLeave = await anon(`/api/onboarding/public/portal?token=${portalLeave.token}`);
  check("somebody on leave can still finish their paperwork", openLeave.status === 200, openLeave.data);

  const portalBlank = await mkHire("portalblank");
  await sql("UPDATE hr_employees SET status = NULL WHERE id = $1", [portalBlank.id]);
  const openBlank = await anon(`/api/onboarding/public/portal?token=${portalBlank.token}`);
  check("a staff record with no status at all is not read as somebody who left — older rows have none",
    openBlank.status === 200, openBlank.data);

  // The employee row itself is gone. Not an expected state, but an onboarding
  // record pointing at nobody must not accept documents on their behalf.
  const orphan = await mkHire("orphan");
  await sql("DELETE FROM hr_employees WHERE id = $1", [orphan.id]);
  const openOrphan = await anon(`/api/onboarding/public/portal?token=${orphan.token}`);
  check("a portal whose staff record has been deleted refuses rather than opening on nobody",
    openOrphan.status === 403, openOrphan.data);

  const portalShouty = await mkHire("portalshouty");
  await setStatus(portalShouty.id, "TERMINATED");
  const openShouty = await anon(`/api/onboarding/public/portal?token=${portalShouty.token}`);
  check("a status typed or imported in capitals is still a status",
    openShouty.status === 403, openShouty.data);

  const openUnknown = await anon(`/api/onboarding/public/portal?token=nonsense-${stamp}`);
  check("an unknown token still reads as an unknown token, not as somebody who left",
    openUnknown.status === 404 && /isn't valid/i.test(openUnknown.data.error || ""), openUnknown.data);

  const upQs = (h, key) => `?token=${h.token}&doc_key=${key}&filename=proof.txt&mime=text/plain`;

  const upGone = await anon("/api/onboarding/public/upload" + upQs(portalGone, "ssn"),
    { method: "POST", raw: "a scan of something personal" });
  check("a former employee cannot upload a document", upGone.status === 403, upGone.data);
  check("and nothing was recorded as received",
    (await docOf(portalGone.recId, "ssn")).status === "awaiting");

  const upHere = await anon("/api/onboarding/public/upload" + upQs(portalHere, "ssn"),
    { method: "POST", raw: "a scan of something personal" });
  check("a current hire still can — the guard is on the employment, not on uploading",
    upHere.status === 200, upHere.data);
  check("and it is recorded",
    (await docOf(portalHere.recId, "ssn")).status === "received");

  const datesGone = await anon(`/api/onboarding/public/dates?token=${portalGone.token}`, {
    method: "POST", body: { doc_key: "rbt_cert", expiration_date: "2030-01-01" },
  });
  check("a former employee cannot type in certificate dates", datesGone.status === 403, datesGone.data);
  const certRows = Number((await one(
    "SELECT COUNT(*) AS n FROM staff_certifications WHERE employee_id = $1", [portalGone.id])).n);
  check("so no certification record is created against their staff file", certRows === 0, certRows);

  const attestGone = await anon(`/api/onboarding/public/attest?token=${portalGone.token}`, {
    method: "POST", body: { doc_key: "credentialing" },
  });
  check("a former employee cannot tick the credentialing form off", attestGone.status === 403, attestGone.data);
  check("and that item is still outstanding",
    (await docOf(portalGone.recId, "credentialing")).status === "awaiting");

  const datesHere = await anon(`/api/onboarding/public/dates?token=${portalHere.token}`, {
    method: "POST", body: { doc_key: "rbt_cert", issued_date: "2024-01-02", expiration_date: "2030-01-01" },
  });
  check("a current hire can type in the dates their certificate did not carry",
    datesHere.status === 200, datesHere.data);
  const certHere = await one(
    "SELECT * FROM staff_certifications WHERE employee_id = $1 AND name = 'RBT'", [portalHere.id]);
  check("and the certification lands on their staff record, expiry and all",
    certHere && certHere.expiration_date === "2030-01-01", certHere);

  const attestHere = await anon(`/api/onboarding/public/attest?token=${portalHere.token}`, {
    method: "POST", body: { doc_key: "credentialing" },
  });
  check("a current hire still can", attestHere.status === 200, attestHere.data);

  // ================================================================
  section("What they already sent is kept, and HR can still see it");

  const partway = await mkHire("partway");
  const sentIn = await anon("/api/onboarding/public/upload" + upQs(partway, "ssn"),
    { method: "POST", raw: "sent before they left" });
  check("the hire gets a document in before leaving", sentIn.status === 200, sentIn.data);
  await setStatus(partway.id, "terminated");

  const kept = await docOf(partway.recId, "ssn");
  check("what was received stays received — nothing is deleted because somebody left",
    kept && kept.status === "received", kept);

  const staffView = await owner(`/api/onboarding/employee/${partway.id}`);
  check("HR can still open the onboarding record of somebody who has left",
    staffView.status === 200 && staffView.data.onboarding, staffView.data);
  check("including the documents that did arrive",
    (staffView.data.documents || []).some((d) => d.doc_key === "ssn" && d.status === "received"),
    staffView.data.documents);

  // ================================================================
  section("Onboarding is not started for somebody who has left");

  const gonePerson = await one(
    `INSERT INTO hr_employees (name, email, role_title, status, created_at)
     VALUES ($1, $2, 'Registered Behavior Technician', 'terminated', $3) RETURNING id`,
    [`Zz Onboard gone ${stamp}`, `ob.gone.${stamp}@example.invalid`, new Date().toISOString()]
  );
  const startGone = await owner(`/api/onboarding/employee/${gonePerson.id}`, { method: "POST" });
  check("starting a document portal for a former employee is refused", startGone.status === 400, startGone.data);
  check("and the refusal says what to do about it if they are coming back",
    /employment status/i.test(startGone.data.error || ""), startGone.data);
  const noRec = await one("SELECT * FROM onboarding_records WHERE employee_id = $1", [gonePerson.id]);
  check("no record, no token, nothing to email", !noRec);

  // ================================================================
  section("A rehire is not locked out by any of this");
  // The regression the guard above could easily have caused. Accepting an offer
  // did NOT touch the employment status, so a returning employee's record still
  // read 'terminated' at the moment their onboarding was created -- their portal
  // link would have been refused, and nobody would have known why.

  const returner = await one(
    `INSERT INTO hr_employees (name, email, role_title, status, termination_date, created_at)
     VALUES ($1, $2, 'Registered Behavior Technician', 'terminated', '2025-03-14', $3) RETURNING id`,
    [`Zz Onboard returner ${stamp}`, `ob.returner.${stamp}@example.invalid`, new Date().toISOString()]
  );
  const applicant = await one(
    `INSERT INTO hr_applicants (full_name, email, stage, applied_at, created_at)
     VALUES ($1, $2, 'offer', $3, $3) RETURNING id`,
    [`Zz Onboard returner ${stamp}`, `ob.returner.${stamp}@example.invalid`, new Date().toISOString()]
  );
  const offerToken = `tok-returner-${stamp}`;
  await sql(
    `INSERT INTO hr_offers (applicant_id, job_title, start_date, status, token, created_at, updated_at)
     VALUES ($1, 'Registered Behavior Technician', $2, 'sent', $3, $4, $4)`,
    [applicant.id, new Date().toISOString().slice(0, 10), offerToken, new Date().toISOString()]
  );

  const accepted = await anon("/api/hr/public/offer/accept", {
    method: "POST", body: { token: offerToken, signed_name: `Zz Onboard returner ${stamp}` },
  });
  check("the returning employee accepts the offer", accepted.status === 200, accepted.data);

  const backOn = await one("SELECT * FROM hr_employees WHERE id = $1", [returner.id]);
  check("accepting puts them back on staff instead of leaving them marked terminated",
    backOn && backOn.status === "onboarding", backOn && backOn.status);
  check("the old termination date is cleared, so turnover stops counting them as a separation",
    backOn && !backOn.termination_date, backOn && backOn.termination_date);
  check("and the fact that they once left survives in the activity log",
    /rehired/i.test(backOn.hr_activity || "") && /2025-03-14/.test(backOn.hr_activity || ""),
    (backOn.hr_activity || "").slice(0, 200));

  // The other direction: somebody already on staff accepting an offer -- an
  // internal move -- must not be knocked back to 'onboarding' by the rule above.
  const promoted = await one(
    `INSERT INTO hr_employees (name, email, role_title, status, created_at)
     VALUES ($1, $2, 'Registered Behavior Technician', 'active', $3) RETURNING id`,
    [`Zz Onboard promoted ${stamp}`, `ob.promoted.${stamp}@example.invalid`, new Date().toISOString()]
  );
  const promoApplicant = await one(
    `INSERT INTO hr_applicants (full_name, email, stage, applied_at, created_at)
     VALUES ($1, $2, 'offer', $3, $3) RETURNING id`,
    [`Zz Onboard promoted ${stamp}`, `ob.promoted.${stamp}@example.invalid`, new Date().toISOString()]
  );
  const promoToken = `tok-promoted-${stamp}`;
  await sql(
    `INSERT INTO hr_offers (applicant_id, job_title, start_date, status, token, created_at, updated_at)
     VALUES ($1, 'Lead RBT', $2, 'sent', $3, $4, $4)`,
    [promoApplicant.id, new Date().toISOString().slice(0, 10), promoToken, new Date().toISOString()]
  );
  const promoAccepted = await anon("/api/hr/public/offer/accept", {
    method: "POST", body: { token: promoToken, signed_name: `Zz Onboard promoted ${stamp}` },
  });
  check("a current employee accepts an internal offer", promoAccepted.status === 200, promoAccepted.data);
  const stillActive = await one("SELECT status FROM hr_employees WHERE id = $1", [promoted.id]);
  check("and stays active — only somebody who had left is moved back to onboarding",
    stillActive && stillActive.status === "active", stillActive && stillActive.status);

  const returnRec = await one("SELECT * FROM onboarding_records WHERE employee_id = $1", [returner.id]);
  check("their onboarding portal is created", !!returnRec, returnRec);
  if (returnRec) {
    const returnPortal = await anon(`/api/onboarding/public/portal?token=${returnRec.portal_token}`);
    check("and it opens — a rehire is a hire, not a former employee",
      returnPortal.status === 200, returnPortal.data);
  } else {
    check("and it opens — a rehire is a hire, not a former employee", false, "no onboarding record to open");
  }

  // ================================================================
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("SUITE ERROR:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
