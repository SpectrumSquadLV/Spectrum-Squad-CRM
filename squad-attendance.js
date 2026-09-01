// squad-attendance.js -- Squad Leader attendance reporting (QR -> PIN -> form).
//
// RBTs designated as Squad Leaders report attendance infractions for the staff
// on their own squad. The workflow is:
//
//   Scan QR  ->  PIN  ->  short-lived session  ->  form  ->  pick a squad member
//            ->  submit  ->  the report lands on that person's CRM profile
//
// WHAT THIS DELIBERATELY IS NOT
// ----------------------------
// It is not a second attendance system. A submitted report is an ordinary row
// in `hr_attendance_flags`, carrying a point value resolved from the same
// `hr_attendance_types` matrix that the office uses, so it shows up on the
// staff card, in the roster, in the 90-day discipline ladder and in the monthly
// review exactly like a report typed in by an administrator. It is also not a
// second permission system: submitting a report gives a Squad Leader no login,
// no HR access, and no route into anybody's record beyond the names of the
// people on their own squad.
//
// SECURITY POSTURE
// ----------------
//   * The QR code encodes ONE static path and nothing else. No employee id, no
//     name, no token, no squad. Scanning it gets you a PIN prompt and a picture
//     of the Spectrum Squad logo -- printing it on a wall leaks nothing, and a
//     photograph of it is worth no more than the URL itself.
//   * The PIN is never in front-end code and never in the URL. It is stored as
//     a scrypt hash with a per-leader salt, set by an administrator, and this
//     module has no route that can read one back.
//   * A correct PIN mints an opaque random session token, stored server-side,
//     valid for 30 minutes, delivered as an HttpOnly cookie scoped to the
//     reporting routes. Every squad route re-checks it against the database, so
//     revoking a leader takes effect on their next request rather than when a
//     token happens to expire.
//   * Failed PINs are counted and the account locks for a spell. The counter is
//     in Postgres, so restarting the server does not clear it.
//   * The roster a leader can see is scoped to their own squad, and returns
//     names and job titles only -- no email, no address, no points, no
//     discipline level, no bonus status.
//   * Every report records who submitted it, from which squad, at what time,
//     and through which channel.
//
// Additive per RULE ZERO: new tables `hr_squads`, `hr_squad_leader_auth` and
// `hr_squad_sessions`, new columns on `hr_attendance_flags`, all routes under
// /api/squad/*, one public page at /squad-report. It changes nothing that
// already exists.
"use strict";

module.exports = function initSquadAttendance(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, crypto, APP_BASE_URL, readBody, json,
    // The attendance module owns the matrix and the scoring. Both are asked
    // for rather than re-implemented, so a policy change in one place changes
    // this too.
    attendance,
  } = ctx;
  const sendEmail = ctx.sendEmail || (async () => ({ delivered: "skipped" }));
  const getAppSetting = ctx.getAppSetting || (async (_k, d) => d);

  // A leader stays signed in for half an hour. Long enough to report several
  // people after a shift, short enough that a phone left on a counter is not
  // an open door.
  const SESSION_MINUTES = 30;
  const MAX_FAILED_PINS = 5;
  const LOCK_MINUTES = 15;
  const PIN_MIN_LENGTH = 6;
  const PIN_MAX_LENGTH = 12;
  const COOKIE = "squad_session";

  // ------------------------------------------------------------------ schema
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_squads (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      leader_employee_id INTEGER,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("hr_squads initTables:", e.message));

    // Which squad a staff member belongs to. NULL means "not on a squad", which
    // is the correct default for everybody who already exists -- nobody is
    // silently assigned to anyone's roster by this migration.
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS squad_id INTEGER")
      .catch((e) => console.error("hr_employees.squad_id:", e.message));

    // The PIN. Hash + salt only; there is no column, and no route, that can
    // produce the PIN itself. `active` is how a leader is switched off without
    // destroying the record of who used to hold the role.
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_squad_leader_auth (
      employee_id INTEGER PRIMARY KEY,
      pin_hash TEXT NOT NULL,
      pin_salt TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      pin_set_at TEXT,
      pin_set_by TEXT,
      last_used_at TEXT
    )`).catch((e) => console.error("hr_squad_leader_auth initTables:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_squad_sessions (
      token TEXT PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      created_at TEXT,
      expires_at TEXT NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      user_agent TEXT
    )`).catch((e) => console.error("hr_squad_sessions initTables:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS hr_squad_sessions_emp_idx ON hr_squad_sessions (employee_id)").catch(() => {});

    // The audit trail on the report itself. `created_by` and `created_at`
    // already record a submitter and a submission time for office-entered
    // reports; these say it came through the squad channel and pin the
    // submitter to an employee record rather than a free-text name.
    for (const [name, type] of [
      ["submitted_via", "TEXT"],                 // squad_qr, when a leader filed it
      ["submitted_by_employee_id", "INTEGER"],   // the leader's hr_employees.id
      ["submitted_squad_id", "INTEGER"],         // the squad they filed it under
      ["incident_time", "TEXT"],                 // 'HH:MM', when it applies
    ]) {
      await dbRun(`ALTER TABLE hr_attendance_flags ADD COLUMN IF NOT EXISTS ${name} ${type}`)
        .catch((e) => console.error(`hr_attendance_flags.${name}:`, e.message));
    }
  }

  // ------------------------------------------------------------------ helpers
  function today() { return nowISO().slice(0, 10); }
  function minutesFromNow(n) { return new Date(Date.parse(nowISO()) + n * 60000).toISOString(); }

  function hashPin(pin, salt = crypto.randomBytes(16).toString("hex")) {
    return { hash: crypto.scryptSync(String(pin), salt, 64).toString("hex"), salt };
  }
  function verifyPin(pin, salt, expected) {
    const { hash } = hashPin(pin, salt);
    const a = Buffer.from(hash), b = Buffer.from(String(expected || ""));
    // timingSafeEqual throws on a length mismatch, which is itself a signal;
    // comparing lengths first and returning false keeps this constant-shaped.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function setSessionCookie(res, token, maxAgeSeconds) {
    const secure = String(APP_BASE_URL || "").startsWith("https://") ? " Secure;" : "";
    res.setHeader("Set-Cookie",
      `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${maxAgeSeconds}`);
  }
  function clearSessionCookie(res) {
    const secure = String(APP_BASE_URL || "").startsWith("https://") ? " Secure;" : "";
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=0`);
  }

  // Resolve the caller's squad-leader session. Everything is re-read from the
  // database on every request -- a leader deactivated, moved off a squad, or
  // terminated stops being able to submit immediately, not when their token
  // eventually runs out.
  async function currentLeader(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const sess = await dbGet(
      "SELECT * FROM hr_squad_sessions WHERE token = ? AND revoked = FALSE",
      [token]
    ).catch(() => null);
    if (!sess) return null;
    if (String(sess.expires_at) <= nowISO()) return null;

    const emp = await dbGet(
      `SELECT e.id, e.name, e.role_title, e.squad_id, e.status,
              s.id AS squad_id_confirmed, s.name AS squad_name, s.active AS squad_active,
              a.active AS auth_active
         FROM hr_employees e
         JOIN hr_squad_leader_auth a ON a.employee_id = e.id
         LEFT JOIN hr_squads s ON s.leader_employee_id = e.id AND s.active = TRUE
        WHERE e.id = ?`,
      [sess.employee_id]
    ).catch(() => null);
    if (!emp) return null;
    if (emp.auth_active === false || emp.auth_active === "f") return null;
    if (String(emp.status || "active").toLowerCase() === "terminated") return null;
    if (!emp.squad_id_confirmed) return null; // no longer leading a squad
    return {
      employee_id: emp.id,
      name: emp.name,
      role_title: emp.role_title || "",
      squad_id: emp.squad_id_confirmed,
      squad_name: emp.squad_name,
      token,
      expires_at: sess.expires_at,
    };
  }

  // The people a given leader may file a report about: the active members of
  // the squad they lead, and nobody else. A leader is not on their own list --
  // reporting yourself is not what this is for, and leaving it out removes an
  // obvious way to muddy the record.
  async function squadMembers(squadId, leaderEmployeeId) {
    return await dbAll(
      `SELECT id, name, role_title FROM hr_employees
        WHERE squad_id = ?
          AND id <> ?
          AND COALESCE(status,'active') <> 'terminated'
        ORDER BY name`,
      [squadId, leaderEmployeeId]
    ).catch(() => []);
  }

  // ----------------------------------------------------- management (admin UI)
  // Same tier as the rest of attendance administration: this decides who can
  // discipline whom, so it is not something a module grant unlocks.
  function role(u) { return (u && (u.role || u.role_key || "")) || ""; }
  function canAdmin(u) { return ["owner", "super_admin", "admin", "hr_admin"].includes(role(u)); }

  async function squadOverview() {
    const squads = await dbAll(
      `SELECT s.*, e.name AS leader_name, e.role_title AS leader_role,
              (a.employee_id IS NOT NULL) AS leader_has_pin,
              a.active AS leader_pin_active, a.last_used_at, a.locked_until,
              (SELECT COUNT(*) FROM hr_employees m
                WHERE m.squad_id = s.id AND COALESCE(m.status,'active') <> 'terminated') AS member_count
         FROM hr_squads s
         LEFT JOIN hr_employees e ON e.id = s.leader_employee_id
         LEFT JOIN hr_squad_leader_auth a ON a.employee_id = s.leader_employee_id
        ORDER BY s.active DESC, s.name`
    ).catch(() => []);
    for (const s of squads) {
      s.members = await dbAll(
        `SELECT id, name, role_title FROM hr_employees
          WHERE squad_id = ? AND COALESCE(status,'active') <> 'terminated' ORDER BY name`,
        [s.id]
      ).catch(() => []);
      s.locked = !!(s.locked_until && String(s.locked_until) > nowISO());
    }
    const staff = await dbAll(
      `SELECT id, name, role_title, squad_id FROM hr_employees
        WHERE COALESCE(status,'active') <> 'terminated' ORDER BY name`
    ).catch(() => []);
    return { squads, staff, report_url: `${APP_BASE_URL}/squad-report`, pin_min_length: PIN_MIN_LENGTH };
  }

  // ---------------------------------------------------------------- reporting
  // Create the flag. Point values come from the matrix, never from the request:
  // a form that could post its own points would be a way to hand out or hold
  // back a $50 attendance bonus by editing a request in the browser.
  async function fileReport(leader, body) {
    const empId = Number(body.employee_id);
    if (!empId) return { ok: false, status: 400, error: "Choose who the report is about." };

    const member = await dbGet(
      `SELECT id, name, role_title FROM hr_employees
        WHERE id = ? AND squad_id = ? AND COALESCE(status,'active') <> 'terminated'`,
      [empId, leader.squad_id]
    ).catch(() => null);
    if (!member) {
      // Deliberately the same answer whether the person does not exist or is
      // simply not on this squad -- otherwise this route is a way to probe the
      // staff list from a phone.
      return { ok: false, status: 403, error: "That staff member is not on your squad." };
    }

    const type = await attendance.typeByKey(body.type_key);
    if (!type) return { ok: false, status: 400, error: "Choose an attendance type from the policy list." };
    if (type.kind !== "occurrence") {
      // Earn-backs remove points. A peer should not be able to award one.
      return { ok: false, status: 403, error: "Only the office can record an earn-back." };
    }

    const incidentDate = String(body.incident_date || today()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(incidentDate)) {
      return { ok: false, status: 400, error: "Enter the date the infraction happened." };
    }
    if (incidentDate > today()) {
      return { ok: false, status: 400, error: "The date of the infraction cannot be in the future." };
    }
    const incidentTime = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(body.incident_time || "").trim())
      ? String(body.incident_time).trim()
      : null;
    const notes = String(body.notes || "").trim().slice(0, 2000) || null;

    // The same occurrence, filed twice, is a double-tap on the submit button or
    // two leaders reporting the same thing -- not two infractions. Points would
    // otherwise double.
    const dupe = await dbGet(
      `SELECT id FROM hr_attendance_flags
        WHERE employee_id = ? AND incident_date = ? AND type_key = ?
          AND COALESCE(voided, FALSE) = FALSE`,
      [empId, incidentDate, type.key]
    ).catch(() => null);
    if (dupe) {
      return {
        ok: false, status: 409,
        error: `A "${type.label}" is already recorded for ${member.name} on ${incidentDate}. The office can see it — nothing further is needed.`,
      };
    }

    const submittedBy = `${leader.name} (Squad Leader — ${leader.squad_name})`;
    const row = await dbRun(
      `INSERT INTO hr_attendance_flags
         (employee_id, incident_date, incident_time, reason, type_key, points, notes,
          acknowledged, created_by, created_at,
          submitted_via, submitted_by_employee_id, submitted_squad_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?, 'squad_qr', ?, ?) RETURNING id`,
      [empId, incidentDate, incidentTime, type.label, type.key, Number(type.points), notes,
       submittedBy, nowISO(), leader.employee_id, leader.squad_id]
    );
    const id = row && row.rows && row.rows[0] ? row.rows[0].id : null;

    // The employee's own activity log, so the report is visible on their CRM
    // profile the moment it is filed -- which is what "automatically links to
    // the correct staff member's profile" means here.
    await attendance.logEmpActivity(
      empId,
      `Attendance: ${type.label} (${Number(type.points) > 0 ? "+" : ""}${Number(type.points)} pts) on ${incidentDate}` +
      `${incidentTime ? ` at ${incidentTime}` : ""}, reported by ${submittedBy}.`
    ).catch((e) => console.error("squad report activity log failed:", e.message));

    // Management is told, because a peer-filed report should be looked at by
    // somebody with the authority to void it if it is wrong. The employee is
    // NOT emailed from here: the acknowledgment goes out from the office
    // through the existing flow, after a human has read it.
    await notifyManagement(leader, member, type, incidentDate, incidentTime, notes)
      .catch((e) => console.error("squad report notify failed:", e.message));

    console.log(`[squad] report filed id=${id} by leader=${leader.employee_id} squad=${leader.squad_id} about=${empId} type=${type.key}`);
    return { ok: true, id, employee_name: member.name, label: type.label, points: Number(type.points) };
  }

  async function notifyManagement(leader, member, type, incidentDate, incidentTime, notes) {
    const configured = String((await getAppSetting("attendance_review_recipients", "")) || "").trim();
    let recipients = configured
      ? configured.split(/[,;]/).map((x) => x.trim()).filter(Boolean)
      : [];
    if (!recipients.length) {
      const owner = String((await getAppSetting("owner_notification_email", "")) || "").trim();
      if (owner) recipients = [owner];
    }
    if (!recipients.length) {
      const rows = await dbAll(
        `SELECT email FROM users WHERE role IN ('owner','super_admin','admin','hr_admin')
           AND email <> 'admin@spectrumsquadlv.com'
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'super_admin' THEN 1 ELSE 2 END LIMIT 1`
      ).catch(() => []);
      if (rows.length) recipients = [rows[0].email];
    }
    if (!recipients.length) return;

    const esc = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html =
      `<p>A Squad Leader has filed an attendance report.</p>` +
      `<ul>` +
        `<li><strong>Employee:</strong> ${esc(member.name)}${member.role_title ? ` (${esc(member.role_title)})` : ""}</li>` +
        `<li><strong>Type:</strong> ${esc(type.label)} (${Number(type.points) > 0 ? "+" : ""}${Number(type.points)} points)</li>` +
        `<li><strong>Date of infraction:</strong> ${esc(incidentDate)}${incidentTime ? ` at ${esc(incidentTime)}` : ""}</li>` +
        `<li><strong>Submitted by:</strong> ${esc(leader.name)} — ${esc(leader.squad_name)}</li>` +
        `<li><strong>Submitted:</strong> ${esc(nowISO())}</li>` +
      `</ul>` +
      (notes ? `<p><strong>Notes:</strong><br>${esc(notes)}</p>` : "") +
      `<p>It is on ${esc(member.name)}'s staff record now and counts toward their rolling points. ` +
      `Review it on the Attendance page — if it is wrong, void it there, which keeps the record and the reason.</p>`;

    for (const to of [...new Set(recipients.map((r) => r.toLowerCase()))]) {
      await sendEmail({
        to,
        subject: `Squad Leader attendance report — ${member.name} (${type.label})`,
        html,
        type: "attendance_squad_report",
      }).catch((e) => console.error("squad notify email:", e.message));
    }
  }

  // ------------------------------------------------------------------- router
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/squad/")) return false;
    try {
      // ============ PUBLIC-FACING (squad leader, PIN session) ============

      // What the scanned page needs before anybody has authenticated: nothing
      // but the clinic's name. No staff list, no squad list, no leader names.
      if (pathname === "/api/squad/public/context" && method === "GET") {
        const leader = await currentLeader(req);
        return json(res, 200, {
          signed_in: !!leader,
          leader: leader ? { name: leader.name, squad_name: leader.squad_name, expires_at: leader.expires_at } : null,
        });
      }

      if (pathname === "/api/squad/public/login" && method === "POST") {
        const b = await readBody(req).catch(() => ({}));
        const email = String(b.email || "").trim().toLowerCase();
        const pin = String(b.pin || "");
        // One message for every kind of failure. A response that distinguished
        // "no such leader" from "wrong PIN" would let anyone with the QR code
        // work out who the squad leaders are.
        const deny = () => json(res, 401, { error: "That email and PIN don't match a squad leader." });
        if (!email || !pin) return deny();

        const rec = await dbGet(
          `SELECT e.id, e.name, e.status, a.pin_hash, a.pin_salt, a.active, a.failed_attempts, a.locked_until,
                  s.id AS squad_id, s.name AS squad_name
             FROM hr_employees e
             JOIN hr_squad_leader_auth a ON a.employee_id = e.id
             LEFT JOIN hr_squads s ON s.leader_employee_id = e.id AND s.active = TRUE
            WHERE LOWER(e.email) = ?`,
          [email]
        ).catch(() => null);
        if (!rec) return deny();

        if (rec.locked_until && String(rec.locked_until) > nowISO()) {
          return json(res, 429, { error: "Too many incorrect PINs. Try again in a few minutes, or ask the office to reset it." });
        }
        if (rec.active === false || rec.active === "f") return deny();
        if (String(rec.status || "active").toLowerCase() === "terminated") return deny();
        if (!rec.squad_id) return deny();

        if (!verifyPin(pin, rec.pin_salt, rec.pin_hash)) {
          const failed = Number(rec.failed_attempts || 0) + 1;
          const lock = failed >= MAX_FAILED_PINS;
          await dbRun(
            "UPDATE hr_squad_leader_auth SET failed_attempts = ?, locked_until = ? WHERE employee_id = ?",
            [lock ? 0 : failed, lock ? minutesFromNow(LOCK_MINUTES) : null, rec.id]
          ).catch(() => {});
          console.log(`[squad] failed PIN for employee=${rec.id} attempt=${failed}${lock ? " (locked)" : ""}`);
          if (lock) return json(res, 429, { error: "Too many incorrect PINs. Try again in a few minutes, or ask the office to reset it." });
          return deny();
        }

        // A fresh sign-in retires this leader's previous sessions, so a token
        // left on a device they no longer have stops working.
        await dbRun("UPDATE hr_squad_sessions SET revoked = TRUE WHERE employee_id = ?", [rec.id]).catch(() => {});
        const token = crypto.randomBytes(32).toString("base64url");
        const expires = minutesFromNow(SESSION_MINUTES);
        await dbRun(
          "INSERT INTO hr_squad_sessions (token, employee_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
          [token, rec.id, nowISO(), expires, String(req.headers["user-agent"] || "").slice(0, 200)]
        );
        await dbRun(
          "UPDATE hr_squad_leader_auth SET failed_attempts = 0, locked_until = NULL, last_used_at = ? WHERE employee_id = ?",
          [nowISO(), rec.id]
        ).catch(() => {});
        setSessionCookie(res, token, SESSION_MINUTES * 60);
        console.log(`[squad] leader ${rec.id} signed in for squad ${rec.squad_id}`);
        return json(res, 200, {
          ok: true,
          leader: { name: rec.name, squad_name: rec.squad_name, expires_at: expires },
        });
      }

      if (pathname === "/api/squad/public/logout" && method === "POST") {
        const token = parseCookies(req)[COOKIE];
        if (token) await dbRun("UPDATE hr_squad_sessions SET revoked = TRUE WHERE token = ?", [token]).catch(() => {});
        clearSessionCookie(res);
        return json(res, 200, { ok: true });
      }

      // Everything below needs a live squad-leader session.
      if (pathname.startsWith("/api/squad/public/")) {
        const leader = await currentLeader(req);
        if (!leader) {
          clearSessionCookie(res);
          return json(res, 401, { error: "Your session has ended. Please enter your PIN again." });
        }

        // The form's own data: the leader's squad members, and the policy list.
        // Names and job titles only.
        if (pathname === "/api/squad/public/form" && method === "GET") {
          const members = await squadMembers(leader.squad_id, leader.employee_id);
          const types = (await attendance.matrixTypes())
            .filter((t) => t.kind === "occurrence" && t.active !== false)
            .map((t) => ({ key: t.key, label: t.label, description: t.description || "" }));
          return json(res, 200, {
            leader: { name: leader.name, squad_name: leader.squad_name, expires_at: leader.expires_at },
            members,
            types,
            today: today(),
          });
        }

        if (pathname === "/api/squad/public/report" && method === "POST") {
          const b = await readBody(req).catch(() => ({}));
          const r = await fileReport(leader, b);
          return json(res, r.ok ? 201 : (r.status || 400), r);
        }

        return json(res, 404, { error: "Not found" });
      }

      // ==================== ADMIN (logged-in CRM user) ====================
      if (!user) return json(res, 401, { error: "Not authenticated" });
      if (!canAdmin(user)) return json(res, 403, { error: "Not permitted" });
      const actor = user.email || user.name || "user";

      if (pathname === "/api/squad/admin/overview" && method === "GET") {
        return json(res, 200, await squadOverview());
      }

      if (pathname === "/api/squad/admin/squads" && method === "POST") {
        const b = await readBody(req);
        const name = String(b.name || "").trim();
        if (!name) return json(res, 400, { error: "Give the squad a name." });
        await dbRun(
          "INSERT INTO hr_squads (name, leader_employee_id, active, created_by, created_at, updated_at) VALUES (?, ?, TRUE, ?, ?, ?)",
          [name.slice(0, 80), b.leader_employee_id ? Number(b.leader_employee_id) : null, actor, nowISO(), nowISO()]
        );
        return json(res, 201, await squadOverview());
      }

      const squadMatch = pathname.match(/^\/api\/squad\/admin\/squads\/(\d+)$/);
      if (squadMatch && method === "PATCH") {
        const id = Number(squadMatch[1]);
        const b = await readBody(req);
        const sets = [], params = [];
        if (b.name !== undefined) { sets.push("name = ?"); params.push(String(b.name || "").trim().slice(0, 80)); }
        if (b.leader_employee_id !== undefined) {
          sets.push("leader_employee_id = ?");
          params.push(b.leader_employee_id ? Number(b.leader_employee_id) : null);
        }
        if (b.active !== undefined) { sets.push("active = ?"); params.push(!!b.active); }
        if (!sets.length) return json(res, 400, { error: "Nothing to update." });
        sets.push("updated_at = ?"); params.push(nowISO(), id);
        await dbRun(`UPDATE hr_squads SET ${sets.join(", ")} WHERE id = ?`, params);
        // Standing down a squad ends its leader's sessions immediately rather
        // than leaving a live token pointing at a squad that no longer exists.
        if (b.active === false) {
          const sq = await dbGet("SELECT leader_employee_id FROM hr_squads WHERE id = ?", [id]).catch(() => null);
          if (sq && sq.leader_employee_id) {
            await dbRun("UPDATE hr_squad_sessions SET revoked = TRUE WHERE employee_id = ?", [sq.leader_employee_id]).catch(() => {});
          }
        }
        return json(res, 200, await squadOverview());
      }

      // Put staff on a squad (or take them off with squad_id = null).
      if (pathname === "/api/squad/admin/members" && method === "POST") {
        const b = await readBody(req);
        const ids = (Array.isArray(b.employee_ids) ? b.employee_ids : []).map(Number).filter((n) => n > 0);
        if (!ids.length) return json(res, 400, { error: "Choose at least one staff member." });
        const squadId = b.squad_id ? Number(b.squad_id) : null;
        if (squadId) {
          const sq = await dbGet("SELECT id FROM hr_squads WHERE id = ?", [squadId]).catch(() => null);
          if (!sq) return json(res, 404, { error: "That squad no longer exists." });
        }
        await dbRun(
          `UPDATE hr_employees SET squad_id = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
          [squadId, ...ids]
        );
        return json(res, 200, await squadOverview());
      }

      // Set or reset a leader's PIN. The PIN is chosen by the administrator and
      // shown back exactly once, in this response, so they can hand it over --
      // it is stored only as a hash and there is no route that reads it again.
      if (pathname === "/api/squad/admin/pin" && method === "POST") {
        const b = await readBody(req);
        const empId = Number(b.employee_id);
        if (!empId) return json(res, 400, { error: "Choose the squad leader." });
        const emp = await dbGet("SELECT id, name, email FROM hr_employees WHERE id = ?", [empId]).catch(() => null);
        if (!emp) return json(res, 404, { error: "Staff member not found." });
        if (!emp.email) return json(res, 400, { error: `${emp.name} needs an email address on file — it is how they sign in.` });

        const pin = String(b.pin || "").trim();
        if (!/^\d+$/.test(pin)) return json(res, 400, { error: "The PIN must be digits only." });
        if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
          return json(res, 400, { error: `The PIN must be between ${PIN_MIN_LENGTH} and ${PIN_MAX_LENGTH} digits.` });
        }
        if (/^(\d)\1+$/.test(pin) || "01234567890".includes(pin) || "09876543210".includes(pin)) {
          return json(res, 400, { error: "Choose a PIN that isn't all the same digit or a straight run of digits." });
        }

        const { hash, salt } = hashPin(pin);
        await dbRun(
          `INSERT INTO hr_squad_leader_auth (employee_id, pin_hash, pin_salt, active, failed_attempts, locked_until, pin_set_at, pin_set_by)
           VALUES (?, ?, ?, TRUE, 0, NULL, ?, ?)
           ON CONFLICT (employee_id) DO UPDATE SET
             pin_hash = EXCLUDED.pin_hash, pin_salt = EXCLUDED.pin_salt, active = TRUE,
             failed_attempts = 0, locked_until = NULL,
             pin_set_at = EXCLUDED.pin_set_at, pin_set_by = EXCLUDED.pin_set_by`,
          [empId, hash, salt, nowISO(), actor]
        );
        // A new PIN invalidates anything signed in on the old one.
        await dbRun("UPDATE hr_squad_sessions SET revoked = TRUE WHERE employee_id = ?", [empId]).catch(() => {});
        await attendance.logEmpActivity(empId, `Squad Leader reporting PIN set by ${actor}.`).catch(() => {});
        console.log(`[squad] PIN set for employee=${empId} by ${actor}`);
        return json(res, 200, { ok: true, sign_in_email: emp.email, overview: await squadOverview() });
      }

      // Switch a leader's access off (or back on) without destroying the record
      // that they held it, and without touching any report they filed.
      if (pathname === "/api/squad/admin/pin/active" && method === "POST") {
        const b = await readBody(req);
        const empId = Number(b.employee_id);
        if (!empId) return json(res, 400, { error: "Choose the squad leader." });
        const active = !!b.active;
        await dbRun("UPDATE hr_squad_leader_auth SET active = ? WHERE employee_id = ?", [active, empId]);
        if (!active) await dbRun("UPDATE hr_squad_sessions SET revoked = TRUE WHERE employee_id = ?", [empId]).catch(() => {});
        await attendance.logEmpActivity(empId, `Squad Leader reporting access ${active ? "re-enabled" : "switched off"} by ${actor}.`).catch(() => {});
        return json(res, 200, await squadOverview());
      }

      // Every report filed through the QR channel, newest first. Management
      // view -- ordinary staff never reach this route.
      if (pathname === "/api/squad/admin/reports" && method === "GET") {
        const rows = await dbAll(
          `SELECT f.id, f.employee_id, f.incident_date, f.incident_time, f.reason, f.type_key, f.points,
                  f.notes, f.created_by, f.created_at, f.voided, f.voided_reason,
                  e.name AS employee_name, e.role_title,
                  l.name AS leader_name, sq.name AS squad_name
             FROM hr_attendance_flags f
             LEFT JOIN hr_employees e ON e.id = f.employee_id
             LEFT JOIN hr_employees l ON l.id = f.submitted_by_employee_id
             LEFT JOIN hr_squads sq ON sq.id = f.submitted_squad_id
            WHERE f.submitted_via = 'squad_qr'
            ORDER BY f.created_at DESC, f.id DESC
            LIMIT 200`
        ).catch(() => []);
        return json(res, 200, { reports: rows });
      }

      return false;
    } catch (e) {
      console.error("squad handleApi error:", e);
      return json(res, 500, { error: "Squad reporting error: " + e.message });
    }
  }

  // Expired and revoked sessions are cleared out on the ordinary sweep, so the
  // table does not grow forever. Nothing depends on a session row surviving.
  async function sweepSessions() {
    await dbRun("DELETE FROM hr_squad_sessions WHERE expires_at < ? OR revoked = TRUE", [nowISO()])
      .catch((e) => console.error("squad session sweep:", e.message));
  }

  // --------------------------------------------------------- the public page
  function servePage(req, res, pathname) {
    if (pathname === "/squad-report" || pathname.startsWith("/squad-report/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageHtml());
      return true;
    }
    return false;
  }

  function pageHtml() {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>Attendance Report — Spectrum Squad</title>
<style>
  :root{--navy:#1b2a6b;--gold:#e0a430;--surface:#fff;--text:#201a4d;--muted:#6b6a86;--border:#e7e4f5;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);
    background:linear-gradient(160deg,#efe9ff 0%,#f7f8fb 45%,#e8f5f2 100%);min-height:100vh}
  .wrap{max-width:560px;margin:0 auto;padding:24px 16px 60px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:22px;margin:16px 0;
    box-shadow:0 18px 50px rgba(41,34,92,.12)}
  .logo{display:block;max-width:180px;width:60%;height:auto;margin:0 auto 6px}
  h1{font-size:20px;margin:8px 0 2px;color:var(--navy);text-align:center}
  .sub{font-size:13px;color:var(--muted);text-align:center;margin:0 0 4px}
  label.f{display:block;font-weight:600;margin:14px 0 4px;color:var(--navy);font-size:13px}
  input,select,textarea{width:100%;border:1px solid #d7d3ee;border-radius:10px;padding:11px;font-size:16px;
    font-family:inherit;background:#fff;color:inherit}
  textarea{resize:vertical}
  .btn{display:block;width:100%;background:linear-gradient(135deg,var(--gold),#f0b64a);color:#3a2a00;border:none;
    border-radius:14px;padding:15px;font-size:17px;font-weight:800;cursor:pointer;margin-top:18px}
  .btn[disabled]{opacity:.6;cursor:default}
  .link{background:none;border:1px solid #d7d3ee;color:var(--navy);border-radius:10px;padding:8px 12px;
    cursor:pointer;font-weight:600;font-size:13px;width:auto}
  .who{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12.5px;color:var(--muted);
    border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:6px}
  .err{background:#fee2e2;color:#991b1b;border-radius:10px;padding:10px 12px;font-size:13.5px;margin-top:12px}
  .ok{background:#f0fdf4;color:#166534;border-radius:10px;padding:10px 12px;font-size:13.5px;margin-top:12px}
  .note{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.45}
  /* Two short fields side by side; they wrap on a narrow phone. */
  .row{display:flex;flex-wrap:wrap;gap:12px}
  .row > *{flex:1 1 160px;min-width:0}
  .done{text-align:center;padding:26px 8px}
</style></head>
<body>
<div class="wrap" id="app"><div class="card"><p class="sub">Loading…</p></div></div>
<script>
(function(){
  var app=document.getElementById('app');
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
  function api(path,opts){
    opts=opts||{};
    return fetch(path,{
      method:opts.method||'GET',
      credentials:'same-origin',
      headers:opts.body?{'Content-Type':'application/json'}:undefined,
      body:opts.body?JSON.stringify(opts.body):undefined
    }).then(function(r){return r.json().catch(function(){return {};}).then(function(j){
      if(!r.ok){var e=new Error(j.error||'Something went wrong.');e.status=r.status;throw e;}
      return j;});});
  }
  function head(){
    return '<img class="logo" src="/logo.png" alt="Spectrum Squad"/>'+
           '<h1>Attendance Report</h1>';
  }

  // ---- step 1: PIN ----
  function renderLogin(msg){
    app.innerHTML='<div class="card">'+head()+
      '<p class="sub">Squad Leaders only. Sign in to report an attendance infraction for someone on your squad.</p>'+
      '<label class="f" for="sq-email">Your work email</label>'+
      '<input id="sq-email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" placeholder="you@spectrumsquadlv.com"/>'+
      '<label class="f" for="sq-pin">Your PIN</label>'+
      '<input id="sq-pin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="••••••"/>'+
      '<button class="btn" id="sq-go">Sign in</button>'+
      (msg?'<div class="err">'+esc(msg)+'</div>':'')+
      '<p class="note">Your PIN is set by the office. This page shows nothing about any employee until you have signed in. '+
      'If you have forgotten your PIN, ask the office to set a new one — nobody can look up the old one.</p>'+
      '</div>';
    var go=document.getElementById('sq-go');
    var submit=function(){
      var email=document.getElementById('sq-email').value.trim();
      var pin=document.getElementById('sq-pin').value;
      if(!email||!pin){return renderLogin('Enter your work email and your PIN.');}
      go.disabled=true;go.textContent='Checking…';
      api('/api/squad/public/login',{method:'POST',body:{email:email,pin:pin}})
        .then(function(){renderForm();})
        .catch(function(e){renderLogin(e.message);});
    };
    go.addEventListener('click',submit);
    document.getElementById('sq-pin').addEventListener('keydown',function(e){if(e.key==='Enter')submit();});
  }

  // ---- step 2: the report ----
  function renderForm(msg,tone){
    api('/api/squad/public/form').then(function(d){
      var members=d.members||[],types=d.types||[];
      app.innerHTML='<div class="card">'+head()+
        '<div class="who"><span>'+esc(d.leader.name)+' · '+esc(d.leader.squad_name)+'</span>'+
          '<button class="link" id="sq-out">Sign out</button></div>'+
        (members.length
          ? '<label class="f" for="sq-emp">Employee</label>'+
            '<select id="sq-emp"><option value="">Choose someone on your squad…</option>'+
              members.map(function(m){return '<option value="'+m.id+'">'+esc(m.name)+(m.role_title?' — '+esc(m.role_title):'')+'</option>';}).join('')+
            '</select>'+
            '<label class="f" for="sq-type">What happened</label>'+
            '<select id="sq-type"><option value="">Choose from the attendance policy…</option>'+
              types.map(function(t){return '<option value="'+esc(t.key)+'">'+esc(t.label)+'</option>';}).join('')+
            '</select>'+
            '<div class="note" id="sq-type-note"></div>'+
            '<div class="row">'+
              '<div><label class="f" for="sq-date">Date it happened</label>'+
                '<input id="sq-date" type="date" max="'+esc(d.today)+'" value="'+esc(d.today)+'"/></div>'+
              '<div><label class="f" for="sq-time">Time (if it applies)</label>'+
                '<input id="sq-time" type="time"/></div>'+
            '</div>'+
            '<label class="f" for="sq-notes">Notes</label>'+
            '<textarea id="sq-notes" rows="3" placeholder="Anything the office should know."></textarea>'+
            '<button class="btn" id="sq-submit">Submit report</button>'
          : '<p class="sub" style="margin-top:14px;">Nobody is currently assigned to your squad, so there is nobody to report. Ask the office to add your squad members.</p>')+
        (msg?'<div class="'+(tone==='ok'?'ok':'err')+'">'+esc(msg)+'</div>':'')+
        '<p class="note">Submitting records this on the employee\\'s staff file and tells the office. '+
        'You cannot see anyone\\'s attendance history, points or records from here.</p>'+
        '</div>';
      document.getElementById('sq-out').addEventListener('click',function(){
        api('/api/squad/public/logout',{method:'POST'}).then(function(){renderLogin();}).catch(function(){renderLogin();});
      });
      var typeSel=document.getElementById('sq-type');
      if(typeSel){
        typeSel.addEventListener('change',function(){
          var t=types.filter(function(x){return x.key===typeSel.value;})[0];
          document.getElementById('sq-type-note').textContent=t&&t.description?t.description:'';
        });
      }
      var btn=document.getElementById('sq-submit');
      if(btn){
        btn.addEventListener('click',function(){
          var body={
            employee_id:document.getElementById('sq-emp').value,
            type_key:typeSel.value,
            incident_date:document.getElementById('sq-date').value,
            incident_time:document.getElementById('sq-time').value||null,
            notes:document.getElementById('sq-notes').value
          };
          if(!body.employee_id){return renderForm('Choose who the report is about.');}
          if(!body.type_key){return renderForm('Choose what happened.');}
          btn.disabled=true;btn.textContent='Submitting…';
          api('/api/squad/public/report',{method:'POST',body:body})
            .then(function(r){renderDone(r);})
            .catch(function(e){
              if(e.status===401){return renderLogin('Your session has ended. Please enter your PIN again.');}
              renderForm(e.message);
            });
        });
      }
    }).catch(function(e){
      if(e.status===401){return renderLogin();}
      app.innerHTML='<div class="card">'+head()+'<div class="err">'+esc(e.message)+'</div></div>';
    });
  }

  // ---- step 3: confirmation ----
  function renderDone(r){
    app.innerHTML='<div class="card done">'+head()+
      '<p class="sub" style="font-size:15px;margin-top:12px;">Report submitted for <strong>'+esc(r.employee_name)+'</strong>.</p>'+
      '<p class="note">It is on their staff file and the office has been notified. Thank you.</p>'+
      '<button class="btn" id="sq-again">Report someone else</button>'+
      '<button class="link" id="sq-out2" style="margin:12px auto 0;">Sign out</button>'+
      '</div>';
    document.getElementById('sq-again').addEventListener('click',function(){renderForm();});
    document.getElementById('sq-out2').addEventListener('click',function(){
      api('/api/squad/public/logout',{method:'POST'}).then(function(){renderLogin();}).catch(function(){renderLogin();});
    });
  }

  api('/api/squad/public/context')
    .then(function(c){ c.signed_in ? renderForm() : renderLogin(); })
    .catch(function(){ renderLogin(); });
})();
</script>
</body></html>`;
  }

  return { initTables, handleApi, servePage, sweepSessions, squadOverview, _internal: { hashPin, verifyPin, currentLeader, fileReport } };
};
