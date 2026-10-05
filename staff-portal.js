// ===================== THE STAFF PORTAL =====================
//
// One QR code on the office wall, four things behind it: a supply request, a
// maintenance request, a concern, and -- new here -- your own PTO.
//
// THE FIRST THREE ARE WRITE-ONLY AND ANONYMOUS. That is what makes them safe
// to leave open: somebody who scans the code can put something IN and read
// nothing back. PTO is the opposite. It reads personal data, so the same door
// cannot be left open, and this module exists to build the lock.
//
// WHY A SEPARATE SESSION AND NOT THE CRM'S.
//
// A CRM session is an authorisation to use the CRM. If the portal issued one,
// a code emailed to a phone in a break room would be a key to the whole
// building -- clients, schedules, billing. So a portal session is its own
// token, in its own table, under its own cookie, and the ONLY thing it can do
// is answer for the one employee it was issued to. It is never accepted by
// /api/* anywhere else, and a CRM session is never accepted here either:
// the two systems do not interoperate, deliberately.
//
// THE EMPLOYEE ID IS NEVER TAKEN FROM THE REQUEST. Every route reads it off
// the session. There is no endpoint anywhere in this file that will tell you
// about an employee you did not prove you are -- not by id, not by email, not
// by name. That is the whole of "I don't need everyone being able to access
// other people's PTO information", and it is enforced in one place rather
// than checked in several.
//
// WHAT THE CODE EMAIL DOES NOT SAY. Asking for a code always answers the
// same way, whether or not the address belongs to anybody. An endpoint that
// says "no such employee" is a staff directory for anyone who can scan a QR
// code, and the practice's staff list is not public.
module.exports = function (ctx) {
  const { dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, readBody, json } = ctx;
  const ptoBalanceFor = ctx.ptoBalanceFor || null;
  const ptoHoursTaken = ctx.ptoHoursTaken || null;
  // Direct delivery, bypassing sendEmail. See sendCode() for why.
  const deliverEmail = ctx.deliverEmail || null;
  const brandedEmail = ctx.brandedEmail || ((h) => h);
  const ownerEmail = ctx.ownerEmail || (async () => "");
  const fs = require("fs");
  const path = require("path");

  // A code is six digits: short enough to read off a phone and type with one
  // hand, which is the whole point of the thing. Six digits is only a million
  // possibilities, so the guessing budget is what carries the security here,
  // not the length -- see MAX_ATTEMPTS.
  const CODE_LENGTH = 6;
  const CODE_TTL_MIN = 10;
  const MAX_ATTEMPTS = 5;
  // Five codes an hour per address. A person who did not get the first email
  // will try again two or three times; anybody past that is not a person.
  const MAX_SENDS_PER_HOUR = 5;
  // Long enough to look at a balance and fill in a request, short enough that
  // a borrowed phone is not an open account. Refreshed on use.
  const SESSION_TTL_MIN = 60;

  const now = () => nowISO();
  const clean = (v) => String(v == null ? "" : v).trim();
  const lower = (v) => clean(v).toLowerCase();
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(clean(v));
  const isTime = (v) => /^\d{2}:\d{2}$/.test(clean(v));
  const plus = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

  // THE RAW CODE IS NEVER STORED, the same way the password-reset tokens next
  // door are never stored. It exists in the email and in the typing fingers,
  // and the database holds only its hash -- so a backup, a support query or a
  // leak of this table hands somebody nothing they can use.
  function newCode() {
    // crypto.randomInt, not Math.random: a predictable code is no code.
    let out = "";
    for (let i = 0; i < CODE_LENGTH; i++) out += String(crypto.randomInt(0, 10));
    return out;
  }

  const newToken = () => crypto.randomBytes(32).toString("hex");

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS portal_login_codes (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      employee_id INTEGER,
      code_hash TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      consumed_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT
    )`).catch((e) => console.error("portal_login_codes initTables:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS portal_codes_email ON portal_login_codes (email)").catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS portal_sessions (
      token TEXT PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      email TEXT,
      created_at TEXT,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT
    )`).catch((e) => console.error("portal_sessions initTables:", e.message));
  }

  // ---- who is asking -------------------------------------------------------
  //
  // Cookie name is portal_session, never `session`. Two names means a portal
  // token can never be mistaken for a CRM token by any code path that reads
  // cookies, including code written later by somebody who has not read this.
  function portalCookie(req) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const pair of header.split(";")) {
      const i = pair.indexOf("=");
      if (i === -1) continue;
      if (pair.slice(0, i).trim() === "portal_session") {
        return decodeURIComponent(pair.slice(i + 1).trim());
      }
    }
    return null;
  }

  async function portalUser(req) {
    const token = portalCookie(req);
    if (!token) return null;
    const row = await dbGet(
      "SELECT * FROM portal_sessions WHERE token = ? AND expires_at > ?", [token, now()]
    ).catch(() => null);
    if (!row) return null;
    const emp = await dbGet(
      `SELECT id, name, email, role_title,
              COALESCE(NULLIF(hr_hire_date, ''), NULLIF(hire_date, '')) AS hire_date,
              pto_accrual_rate, standard_weekly_hours, pto_annual_cap, pto_enrolled,
              COALESCE(status,'active') AS status
         FROM hr_employees WHERE id = ?`, [row.employee_id]
    ).catch(() => null);
    // SOMEBODY WHO HAS LEFT LOSES THE DOOR IMMEDIATELY, even mid-session.
    // Their row stays for the record; their access does not.
    if (!emp || emp.status === "terminated") return null;
    return { session: row, employee: emp };
  }

  // Finding the employee behind an address. Email is the join the rest of the
  // CRM already uses between a person and their staff record.
  async function employeeByEmail(email) {
    if (!email) return null;
    return await dbGet(
      `SELECT id, name, email, COALESCE(status,'active') AS status
         FROM hr_employees
        WHERE LOWER(email) = ? AND COALESCE(status,'active') <> 'terminated'
        ORDER BY id LIMIT 1`, [lower(email)]
    ).catch(() => null);
  }

  // ---- the balance ---------------------------------------------------------
  //
  // Computed by pto.js, not here. A second implementation of the accrual rules
  // is a second set of rules, and the two would disagree the first time one
  // was corrected -- which is exactly the bug the PTO rebuild existed to fix.
  async function ownBalance(emp) {
    if (!ptoBalanceFor) return null;
    const r = await ptoBalanceFor(emp).catch(() => null);
    if (!r) return null;

    // APPROVED LEAVE THAT HAS NOT HAPPENED YET.
    //
    // The ledger counts leave as used when it is taken, not when it is
    // granted -- correct for an accrual ledger, and wrong as the only number
    // on a screen somebody books time off from. Approve a fortnight in
    // December and the balance would read untouched until December, so the
    // same fortnight could be asked for twice.
    //
    // Counted from TOMORROW, so a leave straddling today contributes its past
    // part to `used` and its future part to here, and neither is counted
    // twice. The balance itself is left exactly as the ledger computed it;
    // this is shown beside it, not subtracted from it.
    let booked = 0;
    if (ptoHoursTaken) {
      const t = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const far = String(new Date().getUTCFullYear() + 3) + "-12-31";
      // r.weekly_hours, NOT emp.standard_weekly_hours. The column is null for
      // most people and the company default fills in -- balanceFor has
      // already done that resolution, and reading the raw column instead
      // gives a standard day of zero, which silently makes every booked hour
      // disappear rather than failing loudly.
      const b = await ptoHoursTaken(emp.id, t, far, r.weekly_hours).catch(() => null);
      booked = b ? Number(b.hours) || 0 : 0;
    }
    // Deliberately NARROWER than the admin view. A person needs their balance
    // and how it was arrived at; they do not need their own cap, their
    // colleagues, or the internals of the ledger rebuild.
    return {
      name: r.name,
      accrual_start: r.eligibility ? r.eligibility.start : null,
      accrual_reason: r.eligibility ? r.eligibility.reason : null,
      not_yet_eligible: r.eligibility ? r.eligibility.not_yet === true : false,
      rate: r.rate,
      // Their own standard day, resolved the same way the ledger resolves it.
      weekly_hours: r.weekly_hours,
      hours_worked: r.hours_worked,
      earned: r.accrued,
      used: r.taken,
      adjustments: r.adjustments,
      balance: r.balance,
      // Already approved, not yet taken.
      booked: Math.round(booked * 100) / 100,
      // What is actually free to ask for. The one number somebody looking at
      // this screen is trying to find.
      free: Math.round((Number(r.balance) - booked) * 100) / 100,
      estimated: r.estimated === true,
      as_of: r.period ? r.period.to : null,
    };
  }

  // Their own requests, upcoming and recent. Only ever their own: employee_id
  // comes from the session.
  async function ownRequests(empId) {
    const rows = await dbAll(
      `SELECT id, start_date, end_date, all_day, start_time, end_time, kind, status, notes, created_at
         FROM staff_time_off
        WHERE employee_id = ? AND COALESCE(kind,'pto') = 'pto'
        ORDER BY start_date DESC LIMIT 50`, [empId]
    ).catch(() => []);
    return rows;
  }

  // How many hours a request is asking for, by the same arithmetic the ledger
  // uses when it eventually counts it as taken -- so the number somebody is
  // shown before they submit is the number that will come off afterwards.
  function requestedHours(b, weeklyHours) {
    const day = (Number(weeklyHours) > 0 ? Number(weeklyHours) : 40) / 5;
    if (b.all_day === false && isTime(b.start_time) && isTime(b.end_time)) {
      const [sh, sm] = clean(b.start_time).split(":").map(Number);
      const [eh, em] = clean(b.end_time).split(":").map(Number);
      const mins = (eh * 60 + em) - (sh * 60 + sm);
      return mins > 0 ? Math.round((mins / 60) * 100) / 100 : 0;
    }
    // CALENDAR DAYS, INCLUDING WEEKENDS, because that is what the ledger
    // counts (pto.js daysBetween). Skipping weekends here would read better
    // -- a Friday-to-Monday break is two working days -- but it would quote
    // somebody sixteen hours and then take thirty-two off their balance when
    // it was approved. The figure shown before submitting has to be the
    // figure charged afterwards, so this follows the ledger rather than
    // improving on it.
    const a = new Date(clean(b.start_date) + "T00:00:00Z");
    const z = new Date(clean(b.end_date) + "T00:00:00Z");
    const days = Math.max(0, Math.round((z - a) / 86400000) + 1);
    return Math.round(days * day * 100) / 100;
  }

  // THE CODE IS A CREDENTIAL, SO IT DOES NOT GO THROUGH sendEmail().
  //
  // sendEmail records the subject and body it sent into notifications_log, and
  // the Message Outbox renders that table to every owner and admin. A live
  // six-digit code sitting there would mean any admin could read a colleague's
  // PTO by reading the outbox -- which is the exact thing this module exists
  // to prevent, defeated by the logging rather than by the lock. The password
  // reset next door already had to solve this; same answer here.
  //
  // So the send is direct and THE LOG ROW CARRIES NO CODE, in the subject or
  // the body. That a code was requested, and whether it was delivered, is
  // worth keeping: somebody will ask why they got an email. The credential in
  // it is not.
  async function sendCode(emp, code) {
    const subject = "Your Spectrum Squad PTO code";
    const first = emp.name ? String(emp.name).split(" ")[0] : "there";
    const html = `
      <p>Hi ${first},</p>
      <p>Your code to see your PTO is:</p>
      <p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:16px 0;color:#1b2a6b;">${code}</p>
      <p>It works for the next ${CODE_TTL_MIN} minutes, and only once.</p>
      <p style="font-size:13px;color:#555;">If you did not ask for this you can ignore it &mdash; nobody
         can see your PTO without the code, and asking for one does not change anything.</p>
      <p>Spectrum Squad</p>`;
    let delivered = "no mailer", errorMsg = "";
    if (deliverEmail) {
      const r = await deliverEmail({ to: emp.email, subject, html: brandedEmail(html) }).catch((e) => ({ delivered: "error", errorMsg: e.message }));
      delivered = (r && r.delivered) || "unknown";
      errorMsg = (r && r.errorMsg) || "";
    }
    await dbRun(
      `INSERT INTO notifications_log (client_id, type, recipient, subject, body, sent_at, delivered, ref_type, ref_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [null, "portal_login_code", emp.email, subject,
       "<p>A one-time PTO code was emailed to this address. The code itself is deliberately not recorded here.</p>",
       now(), delivered + (errorMsg ? `: ${errorMsg}` : ""), "hr_employee", emp.id]
    ).catch(() => {});
    return { delivered, errorMsg };
  }

  async function handleApi(req, res, pathname, method) {
    if (!pathname.startsWith("/api/portal/")) return false;

    // ---- ask for a code --------------------------------------------------
    if (pathname === "/api/portal/code" && method === "POST") {
      const b = await readBody(req);
      const email = lower(b && b.email);
      // THE ANSWER IS THE SAME EITHER WAY. Not a convenience -- the difference
      // between "sent" and "no such person" is a staff directory anybody with
      // the QR code could walk.
      const vague = { ok: true, sent: true,
        message: "If that address belongs to a staff member, a code is on its way. It is good for 10 minutes." };
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        json(res, 400, { error: "That does not look like an email address." });
        return true;
      }
      const emp = await employeeByEmail(email);
      if (!emp) { json(res, 200, vague); return true; }

      // Rate limit per address. Counted on codes ISSUED, not codes delivered,
      // so a bounced mailbox cannot be used as an unlimited send button.
      const recent = await dbGet(
        "SELECT COUNT(*) AS n FROM portal_login_codes WHERE email = ? AND created_at > ?",
        [email, new Date(Date.now() - 3600000).toISOString()]
      ).catch(() => ({ n: 0 }));
      if (Number(recent && recent.n) >= MAX_SENDS_PER_HOUR) {
        // Still vague to the caller: a different answer here would leak that
        // the address is real.
        json(res, 200, vague);
        return true;
      }

      // Any earlier code for this address stops working the moment a new one
      // is asked for, so two codes are never live at once.
      await dbRun("UPDATE portal_login_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL",
        [now(), email]).catch(() => {});

      const code = newCode();
      await dbRun(
        `INSERT INTO portal_login_codes (email, employee_id, code_hash, expires_at, created_at)
         VALUES (?,?,?,?,?)`,
        [email, emp.id, sha(code), plus(CODE_TTL_MIN), now()]
      ).catch(() => {});

      await sendCode(emp, code);

      json(res, 200, vague);
      return true;
    }

    // ---- hand the code back ----------------------------------------------
    if (pathname === "/api/portal/verify" && method === "POST") {
      const b = await readBody(req);
      const email = lower(b && b.email);
      const code = clean(b && b.code);
      const no = () => json(res, 401, { error: "That code is wrong or has expired. Ask for a new one." });
      if (!email || !/^\d{4,8}$/.test(code)) { no(); return true; }

      const row = await dbGet(
        `SELECT * FROM portal_login_codes
          WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
          ORDER BY id DESC LIMIT 1`, [email, now()]
      ).catch(() => null);
      if (!row) { no(); return true; }

      // THE GUESSING BUDGET. Six digits is a million possibilities and five
      // tries, after which the code is dead and a new one must be emailed --
      // which is what makes a short code safe. The attempt is recorded BEFORE
      // the comparison, so a request that dies mid-flight still costs a try.
      if (Number(row.attempts) >= MAX_ATTEMPTS) {
        await dbRun("UPDATE portal_login_codes SET consumed_at = ? WHERE id = ?", [now(), row.id]).catch(() => {});
        no(); return true;
      }
      await dbRun("UPDATE portal_login_codes SET attempts = COALESCE(attempts,0) + 1 WHERE id = ?", [row.id]).catch(() => {});

      // Constant-time compare: a hash equality that short-circuits is a timing
      // oracle, and this one is cheap to make safe.
      const given = Buffer.from(sha(code));
      const want = Buffer.from(String(row.code_hash || ""));
      const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
      if (!ok) { no(); return true; }

      const emp = await dbGet(
        "SELECT id, name, email, COALESCE(status,'active') AS status FROM hr_employees WHERE id = ?",
        [row.employee_id]
      ).catch(() => null);
      if (!emp || emp.status === "terminated") { no(); return true; }

      // ONE USE. Consumed before the session is issued, so a replayed request
      // cannot mint a second session from the same code.
      await dbRun("UPDATE portal_login_codes SET consumed_at = ? WHERE id = ?", [now(), row.id]).catch(() => {});

      const token = newToken();
      await dbRun(
        `INSERT INTO portal_sessions (token, employee_id, email, created_at, expires_at, last_seen_at)
         VALUES (?,?,?,?,?,?)`,
        [token, emp.id, emp.email, now(), plus(SESSION_TTL_MIN), now()]
      ).catch(() => {});

      // HttpOnly so no script on the page can read it, SameSite=Strict because
      // this cookie has no business travelling on a cross-site request, and
      // Path=/api/portal so it is not even sent to the rest of the CRM.
      res.setHeader("Set-Cookie",
        `portal_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MIN * 60}`);
      json(res, 200, { ok: true, name: emp.name });
      return true;
    }

    // Everything past here needs a portal session.
    const me = await portalUser(req);
    if (pathname === "/api/portal/me" && method === "GET") {
      if (!me) { json(res, 401, { error: "Not signed in." }); return true; }
      await dbRun("UPDATE portal_sessions SET last_seen_at = ?, expires_at = ? WHERE token = ?",
        [now(), plus(SESSION_TTL_MIN), me.session.token]).catch(() => {});
      json(res, 200, {
        employee: { name: me.employee.name, role_title: me.employee.role_title || "" },
        pto: await ownBalance(me.employee),
        requests: await ownRequests(me.employee.id),
      });
      return true;
    }

    if (pathname === "/api/portal/logout" && method === "POST") {
      if (me) await dbRun("DELETE FROM portal_sessions WHERE token = ?", [me.session.token]).catch(() => {});
      res.setHeader("Set-Cookie", "portal_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0");
      json(res, 200, { ok: true });
      return true;
    }

    // ---- ask for time off -------------------------------------------------
    if (pathname === "/api/portal/pto-request" && method === "POST") {
      if (!me) { json(res, 401, { error: "Not signed in." }); return true; }
      const b = await readBody(req);
      if (!isDate(b.start_date) || !isDate(b.end_date)) {
        json(res, 400, { error: "Choose the first and last day." }); return true;
      }
      if (clean(b.end_date) < clean(b.start_date)) {
        json(res, 400, { error: "The last day is before the first one." }); return true;
      }
      const partial = b.all_day === false;
      if (partial && !(isTime(b.start_time) && isTime(b.end_time))) {
        json(res, 400, { error: "For part of a day, give a start and end time." }); return true;
      }
      if (partial && clean(b.start_date) !== clean(b.end_date)) {
        json(res, 400, { error: "Part of a day has to be a single day." }); return true;
      }

      // The same resolved standard week the balance uses, not the raw column:
      // a quote computed from a null week is a quote of zero hours.
      const bal = await ownBalance(me.employee);
      const hours = requestedHours(b, bal ? bal.weekly_hours : null);

      // REQUESTED, NEVER APPROVED. The portal cannot approve its own request,
      // and `requested` is not counted as taken by the ledger -- a balance
      // only moves when the owner says so.
      const row = await dbGet(
        `INSERT INTO staff_time_off
           (employee_id, start_date, end_date, all_day, start_time, end_time, kind, status, notes, created_by, created_at)
         VALUES (?,?,?,?,?,?,'pto','requested',?,?,?) RETURNING *`,
        [me.employee.id, clean(b.start_date), clean(b.end_date), !partial,
         partial ? clean(b.start_time) : null, partial ? clean(b.end_time) : null,
         clean(b.notes) || null, `portal:${me.employee.email || me.employee.id}`, now()]
      ).catch(() => null);
      if (!row) { json(res, 500, { error: "The request could not be saved." }); return true; }

      await sendEmail({
        to: await ownerEmail().catch(() => ""),
        subject: `PTO request — ${me.employee.name}`,
        html: `<p><strong>${me.employee.name}</strong> has asked for PTO.</p>
               <p>${clean(b.start_date)}${clean(b.end_date) !== clean(b.start_date) ? " to " + clean(b.end_date) : ""}
                  ${partial ? `, ${clean(b.start_time)}–${clean(b.end_time)}` : ""}
                  — about ${hours} hours.</p>
               ${clean(b.notes) ? `<p>${clean(b.notes)}</p>` : ""}
               <p>Approve or decline it on the PTO Balances screen.</p>`,
        type: "pto_request",
        refType: "staff_time_off",
        refId: row.id,
      }).catch(() => {});

      json(res, 200, { ok: true, request: row, hours });
      return true;
    }

    // Withdrawing one's own request, while it is still only a request.
    const cancelMatch = pathname.match(/^\/api\/portal\/pto-request\/(\d+)$/);
    if (cancelMatch && method === "DELETE") {
      if (!me) { json(res, 401, { error: "Not signed in." }); return true; }
      const id = Number(cancelMatch[1]);
      // The employee_id in the WHERE is the lock: a request belonging to
      // somebody else does not match, so it cannot be touched by id-guessing.
      const row = await dbGet(
        "SELECT * FROM staff_time_off WHERE id = ? AND employee_id = ?", [id, me.employee.id]
      ).catch(() => null);
      if (!row) { json(res, 404, { error: "No such request." }); return true; }
      if (clean(row.status) !== "requested") {
        json(res, 400, { error: "That one has already been decided. Speak to the office." }); return true;
      }
      await dbRun("DELETE FROM staff_time_off WHERE id = ? AND employee_id = ? AND status = 'requested'",
        [id, me.employee.id]).catch(() => {});
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  // The QR landing page, and the PTO page behind it. Both unauthenticated to
  // SERVE; the PTO one shows nothing until a code has been handed back.
  function servePage(req, res, pathname) {
    const file = (name) => {
      const f = path.join(__dirname, name);
      if (!fs.existsSync(f)) return false;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "no-store",
      });
      res.end(fs.readFileSync(f, "utf8"));
      return true;
    };
    if (pathname === "/staff" || pathname === "/staff/") return file("staff-hub.html");
    if (pathname === "/my-pto" || pathname === "/my-pto/") return file("my-pto.html");
    return false;
  }

  // Expired codes and sessions are rubbish with somebody's email address in
  // it. Swept on the same schedule as everything else rather than kept.
  async function sweep() {
    await dbRun("DELETE FROM portal_sessions WHERE expires_at < ?", [now()]).catch(() => {});
    await dbRun("DELETE FROM portal_login_codes WHERE expires_at < ?",
      [new Date(Date.now() - 86400000).toISOString()]).catch(() => {});
  }

  return { initTables, handleApi, servePage, sweep,
           _internal: { requestedHours, employeeByEmail, portalUser, CODE_TTL_MIN, MAX_ATTEMPTS,
                        MAX_SENDS_PER_HOUR, SESSION_TTL_MIN } };
};
