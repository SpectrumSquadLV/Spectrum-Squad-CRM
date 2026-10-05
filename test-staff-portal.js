// The staff portal: one QR code, and the one door behind it that reads data
// back instead of only taking it in.
//
// Supply, maintenance and concerns are safe to leave open because they are
// write-only and anonymous. PTO is neither. So this suite is not really about
// the form -- it is about the four ways this feature could hand somebody
// another person's information:
//
//   1. the endpoint that tells you whether an email belongs to staff
//   2. the one-time code sitting in a log an admin can read
//   3. an employee_id in a request body that the server believes
//   4. a portal session that turns out to open the CRM, or a CRM session
//      that turns out to open the portal
//
// Each has its own section below, and each is asserted against a REAL second
// employee rather than a hypothetical one.
//
//   DATABASE_URL=... PORT=3062 node server.js
//   BASE=http://127.0.0.1:3062 node test-staff-portal.js
const { Pool } = require("pg");

const BASE = process.env.BASE || "http://localhost:3062";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const stamp = Date.now().toString(36);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 320) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let cookie = "";
  const f = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d, setCookie: sc || "" };
  };
  f.cookie = () => cookie;
  f.setCookie = (c) => { cookie = c; };
  return f;
}

(async () => {
  const owner = client();
  const admin = client();
  const alice = client();   // the employee whose PTO this is
  const bob = client();     // the colleague who must never see it

  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);

  // ---- fixtures ----------------------------------------------------------
  const purge = async () => {
    const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'Portal %')";
    for (const t of ["staff_time_off", "pto_ledger", "pto_adjustments", "rethink_provider_day"]) {
      await pool.query(`DELETE FROM ${t} WHERE employee_id IN ${ids}`).catch(() => {});
    }
    await pool.query("DELETE FROM portal_sessions WHERE employee_id IN " + ids).catch(() => {});
    await pool.query("DELETE FROM portal_login_codes WHERE email LIKE 'portal-%'").catch(() => {});
    await pool.query("DELETE FROM notifications_log WHERE recipient LIKE 'portal-%'").catch(() => {});
    await pool.query("DELETE FROM hr_employees WHERE name LIKE 'Portal %'").catch(() => {});
  };
  await purge();

  const aliceEmail = `portal-alice-${stamp}@example.invalid`;
  const bobEmail = `portal-bob-${stamp}@example.invalid`;
  const mk = async (name, email, hire) => (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
     VALUES ($1,$2,'RBT',$3,'active') RETURNING id`, [name, email, hire])).rows[0].id;
  const aliceId = await mk("Portal Alice", aliceEmail, "2025-10-01");
  const bobId = await mk("Portal Bob", bobEmail, "2025-10-01");

  // Real worked hours, so there is a real balance to protect.
  const workDay = async (empId, day, billable) => pool.query(
    `INSERT INTO rethink_provider_day (rethink_staff_id, day, month, employee_id, billable_hours,
       nonbillable_hours, unclassified_hours, computed_at)
     VALUES ($1,$2,$3,$4,$5,0,0, now()::text)
     ON CONFLICT (rethink_staff_id, day) DO UPDATE SET billable_hours = EXCLUDED.billable_hours`,
    [`portal-${empId}`, day, day.slice(0, 7), empId, billable]);
  await workDay(aliceId, "2026-03-10", 100);
  await workDay(bobId, "2026-03-10", 50);
  await pool.query("DELETE FROM app_settings WHERE key = 'pto_annual_cap'").catch(() => {});

  const lastCode = async (email) => (await pool.query(
    "SELECT * FROM portal_login_codes WHERE email = $1 ORDER BY id DESC LIMIT 1", [email])).rows[0];

  // ==================================================================
  section("1. ASKING FOR A CODE IS NOT A STAFF DIRECTORY");
  const forReal = await alice("/api/portal/code", { method: "POST", body: { email: aliceEmail } });
  const forNobody = await client()("/api/portal/code", {
    method: "POST", body: { email: `nobody-${stamp}@example.invalid` } });
  check("a real address gets a 200", forReal.status === 200, forReal);
  check("AND SO DOES AN ADDRESS THAT BELONGS TO NOBODY", forNobody.status === 200, forNobody);
  check("the two answers are byte-identical, so neither confirms a staff member exists",
    JSON.stringify(forReal.data) === JSON.stringify(forNobody.data),
    { real: forReal.data, nobody: forNobody.data });
  check("and no code row is written for the address that is not staff",
    !(await lastCode(`nobody-${stamp}@example.invalid`)),
    "a code row exists for a non-employee");

  // ==================================================================
  section("2. THE CODE IS A CREDENTIAL, SO IT IS NOT IN THE OUTBOX");
  const row = await lastCode(aliceEmail);
  check("a code was issued for the real address", !!row, row);
  check("it is stored only as a hash, never in the clear",
    !!row && /^[0-9a-f]{64}$/.test(String(row.code_hash)), row && row.code_hash);
  const logged = (await pool.query(
    "SELECT subject, body FROM notifications_log WHERE recipient = $1 ORDER BY id DESC LIMIT 1",
    [aliceEmail])).rows[0];
  check("the send is recorded", !!logged, logged);
  // The real code is not knowable from here, so this asserts the stronger and
  // more useful property: NOTHING in the log row can be a six-digit code.
  check("THE OUTBOX ROW CONTAINS NO SIX-DIGIT CODE IN ITS BODY",
    !!logged && !/\b\d{6}\b/.test(String(logged.body || "")), logged && logged.body);
  check("nor in its subject, which the outbox also renders",
    !!logged && !/\b\d{6}\b/.test(String(logged.subject || "")), logged && logged.subject);
  check("and it says plainly that the code was left out on purpose",
    !!logged && /deliberately not recorded/i.test(String(logged.body || "")), logged && logged.body);

  // The suite needs a usable code, so it plants a known one the same way the
  // server would -- hashed, unconsumed, in date.
  const crypto = require("crypto");
  const plant = async (email, empId, code, { expired = false, attempts = 0 } = {}) => {
    await pool.query("UPDATE portal_login_codes SET consumed_at = now()::text WHERE email = $1 AND consumed_at IS NULL", [email]);
    const hash = crypto.createHash("sha256").update(code).digest("hex");
    const exp = new Date(Date.now() + (expired ? -60000 : 600000)).toISOString();
    return (await pool.query(
      `INSERT INTO portal_login_codes (email, employee_id, code_hash, attempts, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5, now()::text) RETURNING *`, [email, empId, hash, attempts, exp])).rows[0];
  };

  // ==================================================================
  section("3. THE GUESSING BUDGET");
  await plant(aliceEmail, aliceId, "123456");
  const wrong = await alice("/api/portal/verify", { method: "POST", body: { email: aliceEmail, code: "999999" } });
  check("a wrong code is refused", wrong.status === 401, wrong);
  check("and the refusal does not say which part was wrong",
    !/email|address|employee/i.test(String(wrong.data && wrong.data.error || "")), wrong.data);
  const afterOne = await lastCode(aliceEmail);
  check("the attempt is counted", Number(afterOne.attempts) === 1, afterOne.attempts);

  await plant(aliceEmail, aliceId, "123456", { attempts: 5 });
  const spent = await alice("/api/portal/verify", { method: "POST", body: { email: aliceEmail, code: "123456" } });
  check("A CODE PAST ITS ATTEMPT LIMIT IS DEAD EVEN WHEN THE GUESS IS RIGHT",
    spent.status === 401, spent);
  const burned = await lastCode(aliceEmail);
  check("and it is consumed, so it cannot be tried again", !!burned.consumed_at, burned);

  await plant(aliceEmail, aliceId, "123456", { expired: true });
  const stale = await alice("/api/portal/verify", { method: "POST", body: { email: aliceEmail, code: "123456" } });
  check("an expired code is refused", stale.status === 401, stale);

  // ==================================================================
  section("4. SIGNING IN, AND SEEING ONLY YOURSELF");
  await plant(aliceEmail, aliceId, "246810");
  const ok = await alice("/api/portal/verify", { method: "POST", body: { email: aliceEmail, code: "246810" } });
  check("the right code is accepted", ok.status === 200, ok);
  check("the cookie is HttpOnly, so no script on the page can read it",
    /HttpOnly/i.test(ok.setCookie), ok.setCookie);
  check("and SameSite=Strict, so it does not travel on a cross-site request",
    /SameSite=Strict/i.test(ok.setCookie), ok.setCookie);
  check("it is NOT called `session`, so no CRM code path can mistake it for one",
    /^portal_session=/.test(ok.setCookie), ok.setCookie);

  const used = await lastCode(aliceEmail);
  check("A CODE WORKS ONCE: it is consumed by the sign-in", !!used.consumed_at, used);
  const replay = await client()("/api/portal/verify", { method: "POST", body: { email: aliceEmail, code: "246810" } });
  check("so replaying it mints no second session", replay.status === 401, replay);

  const mine = await alice("/api/portal/me");
  check("the portal answers with a balance", mine.status === 200 && mine.data.pto, mine.data);
  check("it is ALICE's balance", mine.data.employee.name === "Portal Alice", mine.data.employee);
  check("100 hours worked at 0.038 is 3.80 hours of PTO",
    Math.abs(Number(mine.data.pto.balance) - 3.8) < 0.01, mine.data.pto);
  check("and it does not hand back the whole roster",
    !Array.isArray(mine.data.staff) && mine.data.employees === undefined, Object.keys(mine.data));

  // ==================================================================
  section("5. THERE IS NO ENDPOINT THAT TAKES SOMEBODY ELSE'S ID");
  // The point is not that these are rejected -- it is that no route exists
  // which accepts an employee id at all, so there is nothing to reject.
  const byQuery = await alice("/api/portal/me?employee_id=" + bobId);
  check("an employee_id on the query string is ignored, not honoured",
    byQuery.status === 200 && byQuery.data.employee.name === "Portal Alice",
    byQuery.data && byQuery.data.employee);
  const asBob = await alice("/api/portal/pto-request", { method: "POST", body: {
    employee_id: bobId, start_date: "2026-09-02", end_date: "2026-09-02" } });
  check("an employee_id in the body does not redirect the request to Bob",
    asBob.status === 200, asBob);
  const bobRows = (await pool.query("SELECT * FROM staff_time_off WHERE employee_id = $1", [bobId])).rows;
  check("BOB HAS NO REQUEST: the id in the body was never read",
    bobRows.length === 0, bobRows);
  const aliceRows = (await pool.query("SELECT * FROM staff_time_off WHERE employee_id = $1", [aliceId])).rows;
  check("it landed on Alice, who is who the session says she is", aliceRows.length === 1, aliceRows);

  // ==================================================================
  section("6. THE TWO SESSION SYSTEMS DO NOT INTEROPERATE");
  const crmViaPortal = await alice("/api/pto/roster");
  check("A PORTAL SESSION DOES NOT OPEN THE CRM — the roster refuses it",
    crmViaPortal.status === 401 || crmViaPortal.status === 403, crmViaPortal.status);
  const concernsViaPortal = await alice("/api/concerns/reports");
  check("nor any other authenticated route",
    concernsViaPortal.status === 401 || concernsViaPortal.status === 403, concernsViaPortal.status);

  // And the other way: the owner's CRM session is not a portal session.
  const portalViaCrm = await owner("/api/portal/me");
  check("A CRM SESSION DOES NOT OPEN THE PORTAL — not even the owner's",
    portalViaCrm.status === 401, portalViaCrm);

  // ==================================================================
  section("7. A REQUEST IS A REQUEST, NOT A WITHDRAWAL");
  const reqRow = aliceRows[0];
  check("it is stored as `requested`", reqRow.status === "requested", reqRow.status);
  check("and as PTO, so the ledger will recognise it", (reqRow.kind || "pto") === "pto", reqRow.kind);
  const beforeDecision = await alice("/api/portal/me");
  check("A PENDING REQUEST TAKES NOTHING OFF THE BALANCE",
    Math.abs(Number(beforeDecision.data.pto.balance) - 3.8) < 0.01, beforeDecision.data.pto);
  check("and nothing is recorded as used", Number(beforeDecision.data.pto.used) === 0, beforeDecision.data.pto);

  // ==================================================================
  section("8. ONLY THE OWNER DECIDES");
  // A REAL ADMIN, not a clinical account. A clinical login is refused by the
  // outer canManage gate before the owner check is ever reached, so testing
  // with one would assert nothing about the owner check at all -- removing it
  // would leave the suite green. This account can read the PTO roster, which
  // is what makes its refusal to DECIDE mean something.
  await pool.query("UPDATE users SET role = 'admin' WHERE email = 'scheduling@spectrumsquadlv.com'");
  check("a full admin signs in", (await admin("/api/auth/login", {
    method: "POST", body: { email: "scheduling@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  const adminRoster = await admin("/api/pto/roster");
  check("and they really do have PTO access — the roster opens for them",
    adminRoster.status === 200, adminRoster.status);
  const adminQueue = await admin("/api/pto/requests");
  check("they can read the request queue", adminQueue.status === 200, adminQueue.status);
  check("but the queue tells them they may not decide",
    adminQueue.data && adminQueue.data.can_decide === false, adminQueue.data && adminQueue.data.can_decide);
  const adminTry = await admin("/api/pto/requests/" + reqRow.id, { method: "POST", body: { status: "approved" } });
  check("AN ADMIN WITH FULL PTO ACCESS STILL CANNOT APPROVE PTO", adminTry.status === 403, adminTry);
  const stillOpen = (await pool.query("SELECT status FROM staff_time_off WHERE id = $1", [reqRow.id])).rows[0];
  check("and the request is untouched by the attempt", stillOpen.status === "requested", stillOpen);

  const queue = await owner("/api/pto/requests");
  check("the owner can read the queue", queue.status === 200, queue.status);
  const queued = (queue.data.requests || []).find((r) => r.id === reqRow.id);
  check("Alice's request is in it", !!queued, (queue.data.requests || []).length);
  check("with the balance the decision would be spending",
    !!queued && Math.abs(Number(queued.balance) - 3.8) < 0.01, queued && queued.balance);
  check("and the queue says the owner may decide", queue.data.can_decide === true, queue.data.can_decide);

  const decided = await owner("/api/pto/requests/" + reqRow.id, { method: "POST", body: { status: "approved" } });
  check("the owner approves it", decided.status === 200, decided);
  const twice = await owner("/api/pto/requests/" + reqRow.id, { method: "POST", body: { status: "denied" } });
  check("A DECISION IS MADE ONCE — it cannot be flipped afterwards", twice.status === 400, twice);

  // ==================================================================
  section("9. AN APPROVAL MOVES THE BALANCE, BY THE ORDINARY ROUTE");
  const after = await alice("/api/portal/me");
  check("the approved day now counts as used", Number(after.data.pto.used) > 0, after.data.pto);
  check("AND THE BALANCE HAS COME DOWN BY IT",
    Number(after.data.pto.balance) < Number(beforeDecision.data.pto.balance),
    { before: beforeDecision.data.pto.balance, after: after.data.pto.balance });
  // Nothing wrote a balance anywhere: the admin roster, which reads the same
  // tables by a different path, must agree.
  const roster = await owner("/api/pto/roster");
  const aliceOnRoster = (roster.data.staff || []).find((s) => s.name === "Portal Alice");
  check("the admin roster agrees with the portal, because both read one source",
    !!aliceOnRoster && Math.abs(Number(aliceOnRoster.balance) - Number(after.data.pto.balance)) < 0.01,
    { roster: aliceOnRoster && aliceOnRoster.balance, portal: after.data.pto.balance });

  // ==================================================================
  section("9b. LEAVE BOOKED FOR LATER IS NOT INVISIBLE");
  // The ledger counts leave when it is TAKEN, which is right for an accrual
  // ledger and wrong as the only figure on a screen somebody books from:
  // approve a fortnight in December and the balance reads untouched until
  // December, so the same fortnight can be asked for twice.
  const beforeBooking = await alice("/api/portal/me");
  const futureReq = (await pool.query(
    `INSERT INTO staff_time_off (employee_id, start_date, end_date, all_day, kind, status, created_at)
     VALUES ($1,'2027-06-01','2027-06-01', TRUE, 'pto','approved', now()::text) RETURNING *`,
    [aliceId])).rows[0];
  const withBooking = await alice("/api/portal/me");
  check("a day approved for next year does NOT count as used yet",
    Number(withBooking.data.pto.used) === Number(beforeBooking.data.pto.used),
    { before: beforeBooking.data.pto.used, after: withBooking.data.pto.used });
  check("the earned balance is likewise unchanged, because the ledger is left alone",
    Math.abs(Number(withBooking.data.pto.balance) - Number(beforeBooking.data.pto.balance)) < 0.001,
    { before: beforeBooking.data.pto.balance, after: withBooking.data.pto.balance });
  check("BUT IT IS COUNTED AS BOOKED AHEAD", Number(withBooking.data.pto.booked) > 0,
    withBooking.data.pto);
  check("AND WHAT IS FREE TO BOOK HAS COME DOWN BY IT",
    Math.abs(Number(withBooking.data.pto.free)
             - (Number(withBooking.data.pto.balance) - Number(withBooking.data.pto.booked))) < 0.001,
    withBooking.data.pto);
  check("so the same day cannot be quietly booked twice",
    Number(withBooking.data.pto.free) < Number(beforeBooking.data.pto.free), 
    { before: beforeBooking.data.pto.free, after: withBooking.data.pto.free });
  await pool.query("DELETE FROM staff_time_off WHERE id = $1", [futureReq.id]);

  // ==================================================================
  section("9c. THE HOURS QUOTED ARE THE HOURS CHARGED");
  // A figure shown before submitting that differs from the one taken off
  // afterwards is worse than no figure at all.
  const quoteReq = await alice("/api/portal/pto-request", { method: "POST", body: {
    start_date: "2027-03-05", end_date: "2027-03-08" } });   // Friday to Monday
  check("a Friday-to-Monday request is accepted", quoteReq.status === 200, quoteReq);
  const quoted = Number(quoteReq.data.hours);
  await pool.query("UPDATE staff_time_off SET status = 'approved' WHERE id = $1",
    [quoteReq.data.request.id]);
  const charged = await alice("/api/portal/me");
  check("FOUR CALENDAR DAYS QUOTED, FOUR CHARGED — the quote follows the ledger, weekends included",
    Math.abs(Number(charged.data.pto.booked) - quoted) < 0.01,
    { quoted, booked: charged.data.pto.booked });
  await pool.query("DELETE FROM staff_time_off WHERE id = $1", [quoteReq.data.request.id]);

  // ==================================================================
  section("10. WITHDRAWING ONLY YOUR OWN, AND ONLY WHILE IT IS PENDING");
  const bobReq = (await pool.query(
    `INSERT INTO staff_time_off (employee_id, start_date, end_date, all_day, kind, status, created_at)
     VALUES ($1,'2026-12-01','2026-12-01', TRUE, 'pto','requested', now()::text) RETURNING *`,
    [bobId])).rows[0];
  const steal = await alice("/api/portal/pto-request/" + bobReq.id, { method: "DELETE" });
  check("ALICE CANNOT WITHDRAW BOB'S REQUEST", steal.status === 404, steal);
  const bobStill = (await pool.query("SELECT * FROM staff_time_off WHERE id = $1", [bobReq.id])).rows[0];
  check("and Bob's request is still there", !!bobStill, bobStill);
  const approved = await alice("/api/portal/pto-request/" + reqRow.id, { method: "DELETE" });
  check("nor can she withdraw her own once it has been approved", approved.status === 400, approved);

  // ==================================================================
  section("11. LEAVING CLOSES THE DOOR");
  await pool.query("UPDATE hr_employees SET status = 'terminated' WHERE id = $1", [aliceId]);
  const gone = await alice("/api/portal/me");
  check("A TERMINATED EMPLOYEE LOSES THE PORTAL MID-SESSION, without waiting for expiry",
    gone.status === 401, gone);
  await pool.query("UPDATE hr_employees SET status = 'active' WHERE id = $1", [aliceId]);

  // ==================================================================
  section("12. THE PAGES THEMSELVES");
  const hub = await fetch(BASE + "/staff");
  const hubHtml = await hub.text();
  check("the QR landing page is served", hub.status === 200, hub.status);
  check("it offers all four doors",
    /supply-request/.test(hubHtml) && /maintenance-request/.test(hubHtml)
    && /report-concern/.test(hubHtml) && /my-pto/.test(hubHtml), hubHtml.slice(0, 200));
  check("and it is not indexed", /noindex/i.test(hub.headers.get("x-robots-tag") || ""),
    hub.headers.get("x-robots-tag"));
  const ptoPage = await fetch(BASE + "/my-pto");
  const ptoHtml = await ptoPage.text();
  check("the PTO page is served to anybody", ptoPage.status === 200, ptoPage.status);
  check("BUT IT CARRIES NO BALANCE IN ITS HTML — the page is a shell until a code is handed back",
    !/balance.{0,40}\d+\.\d\d/i.test(ptoHtml), "a number that looks like a balance is in the page source");
  check("and it is not cached by a shared proxy",
    /no-store/i.test(ptoPage.headers.get("cache-control") || ""), ptoPage.headers.get("cache-control"));

  await purge();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
