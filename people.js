// people.js -- Departments, emergency contacts, and staff certification expiry.
//
// Three things that all hang off "who works here and who do we call":
//
//   1. DEPARTMENTS. The departments table already existed but was seed-only:
//      four rows, and the admin screen could edit one field on them. Everything
//      downstream (stage_tasks routing, department alert emails, the staff
//      department picker) references departments by id, so a rename propagates
//      on its own. What did NOT exist was creating one, retiring one, or
//      deleting one safely. Deleting a department that still routes pipeline
//      tasks would silently break stage routing -- so a delete that would
//      orphan anything is refused unless a replacement department is named,
//      and then every reference is moved before the row goes.
//
//   2. EMERGENCY CONTACTS. On both client and staff records, many per person.
//      One shared table with an owner_type discriminator, because the fields
//      are identical and the access rules are the only thing that differs.
//
//   3. CERTIFICATION EXPIRY. Staff certifications with real expiry dates, and
//      staged notices at 90/60/30/14/7/1 days out, on the expiry date, and
//      weekly after that. Each stage sends at most once per certification --
//      the send is recorded before the email goes out, so a crash mid-sweep
//      can never turn into a duplicate blast. The Clinical Director address
//      comes from the configurable app setting, never a hard-coded address.
//
// Additive: new tables (plus two idempotent columns on departments), routes
// under /api/people/*. Nothing existing is modified.

"use strict";

module.exports = function initPeople(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, readBody, json,
    sendEmail, APP_BASE_URL, getAppSetting, canAccessClients,
  } = ctx;

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  const clean = (v) => (v == null ? "" : String(v).trim());

  // ======================= ROLES =============================
  // Departments and certifications are administrative settings.
  const ADMIN_ROLES = ["owner", "super_admin", "admin"];
  // Who may see and edit staff records (and therefore staff emergency contacts
  // and certifications). Mirrors the HR module's manage roles.
  const STAFF_ROLES = ["owner", "super_admin", "admin", "hr_admin"];

  function isAdmin(user) { return !!user && ADMIN_ROLES.includes(user.role); }
  function canStaff(user) { return !!user && STAFF_ROLES.includes(user.role); }

  // An emergency contact on a child's record is PHI-adjacent; it follows client
  // record access. On a staff record it follows staff access.
  function canOwner(user, ownerType) {
    return ownerType === "client" ? canAccessClients(user) : canStaff(user);
  }

  // ======================= SCHEMA ============================
  // A client's emergency contact must be someone OTHER than the parent or
  // guardian, and someone who does not live in the child's home -- otherwise
  // one incident takes out both the primary contact and the backup. Enforced
  // on the server so it holds however the record is created.
  //
  // Matched on the relationship the office types in. Deliberately narrow: it
  // catches the words that unambiguously mean the parent/guardian and nothing
  // else, so "grandmother", "aunt", "family friend", "neighbour" all pass.
  const PARENT_RELATIONSHIP = /\b(mother|father|mom|mum|mommy|dad|daddy|parent|guardian|step-?mother|step-?father|step-?mom|step-?dad)\b/i;

  function clientContactProblem(relationship, outsideHousehold) {
    if (PARENT_RELATIONSHIP.test(String(relationship || ""))) {
      return "The emergency contact has to be someone other than the parent or guardian — please add a relative, friend or neighbour who can be reached if the parent can't be.";
    }
    if (outsideHousehold !== true) {
      return "Please confirm this person does not live in the client's home. An emergency contact who lives in the same household can't act as a backup.";
    }
    return null;
  }

  async function initTables() {
    // departments already exists in the core schema. Two additive columns:
    // `active` so a department can be retired without destroying the history
    // of tasks that referenced it, and `sort_order` for the picker.
    await dbRun(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`).catch(() => {});
    await dbRun(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS sort_order INTEGER`).catch(() => {});
    await dbRun(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS description TEXT`).catch(() => {});
    await dbRun(`UPDATE departments SET active = TRUE WHERE active IS NULL`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS emergency_contacts (
      id SERIAL PRIMARY KEY,
      owner_type TEXT NOT NULL,          -- client | staff
      owner_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      relationship TEXT,
      phone TEXT,
      alt_phone TEXT,
      email TEXT,
      address TEXT,
      is_primary BOOLEAN DEFAULT FALSE,
      can_pick_up BOOLEAN DEFAULT FALSE, -- clients only; ignored for staff
      notes TEXT,
      sort_order INTEGER DEFAULT 0,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS emergency_contacts_owner_idx
                 ON emergency_contacts (owner_type, owner_id)`).catch(() => {});
    // A child's emergency contact has to be somebody we can actually reach when
    // the parent cannot be reached -- which rules out anyone living in the same
    // house. NULL (not just false) on purpose: contacts entered before this
    // rule existed read as "not recorded yet" rather than being silently
    // asserted to live in, or out of, the home. Only clients use it; a staff
    // member's emergency contact is usually their spouse.
    await dbRun("ALTER TABLE emergency_contacts ADD COLUMN IF NOT EXISTS outside_household BOOLEAN").catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS staff_certifications (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      name TEXT NOT NULL,                -- RBT, BCBA, CPR/BLS, Safety Care, TB test...
      issuing_body TEXT,
      credential_number TEXT,
      issued_date TEXT,
      expiration_date TEXT,
      status TEXT DEFAULT 'active',      -- active | renewed | archived
      notes TEXT,
      notify_staff BOOLEAN DEFAULT TRUE,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS staff_certifications_emp_idx
                 ON staff_certifications (employee_id)`).catch(() => {});

    // One row per (certification, stage) that has been notified. The UNIQUE
    // constraint is what makes the sweep idempotent: a second attempt at the
    // same stage fails the insert instead of sending a second email.
    await dbRun(`CREATE TABLE IF NOT EXISTS certification_notices (
      id SERIAL PRIMARY KEY,
      certification_id INTEGER NOT NULL,
      stage TEXT NOT NULL,               -- 90 | 60 | 30 | 14 | 7 | 1 | expired | overdue-7 ...
      expiration_date TEXT,              -- snapshot, so moving the date re-arms the stages
      sent_to TEXT,
      sent_at TEXT,
      UNIQUE (certification_id, stage, expiration_date)
    )`);

    console.log("People (departments, emergency contacts, certifications) schema ready.");
  }

  // ======================= DEPARTMENTS =======================
  const DEPT_COLORS = ["#4f46e5", "#0891b2", "#059669", "#d97706", "#db2777", "#7c3aed", "#dc2626", "#0284c7"];

  function slugify(name) {
    return clean(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  }

  async function uniqueKey(name) {
    const base = slugify(name) || "department";
    let key = base;
    for (let i = 2; i < 200; i++) {
      const hit = await dbGet("SELECT id FROM departments WHERE key = ?", [key]);
      if (!hit) return key;
      key = `${base}_${i}`;
    }
    return `${base}_${Date.now()}`;
  }

  // Everywhere a department id is stored. Used both to warn before a delete and
  // to move references when one is supplied.
  const DEPT_REFERENCES = [
    { table: "stage_tasks", column: "department_id", label: "pipeline stage task" },
    { table: "users", column: "department_id", label: "team member" },
  ];

  async function departmentUsage(id) {
    const usage = {};
    let total = 0;
    for (const ref of DEPT_REFERENCES) {
      let n = 0;
      try {
        const row = await dbGet(`SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ?`, [id]);
        n = Number(row && row.n) || 0;
      } catch (e) { n = 0; }
      usage[ref.table] = n;
      total += n;
    }
    usage.total = total;
    return usage;
  }

  async function listDepartments(includeInactive) {
    const rows = await dbAll(
      `SELECT * FROM departments ${includeInactive ? "" : "WHERE active IS NOT FALSE"}
        ORDER BY sort_order NULLS LAST, name`
    );
    for (const d of rows) d.usage = await departmentUsage(d.id);
    return rows;
  }

  // ======================= CERT NOTICE STAGES ================
  // Days before expiry. `0` is the expiry date itself; negatives are the
  // weekly nags afterwards, capped so a certification nobody renews does not
  // email forever.
  const CERT_STAGES = [
    { key: "90", days: 90, level: "heads up", tone: "#0891b2" },
    { key: "60", days: 60, level: "heads up", tone: "#0891b2" },
    { key: "30", days: 30, level: "action needed", tone: "#d97706" },
    { key: "14", days: 14, level: "action needed", tone: "#d97706" },
    { key: "7", days: 7, level: "urgent", tone: "#dc2626" },
    { key: "1", days: 1, level: "urgent", tone: "#dc2626" },
    { key: "expired", days: 0, level: "expired", tone: "#991b1b" },
    { key: "overdue-7", days: -7, level: "expired", tone: "#991b1b" },
    { key: "overdue-14", days: -14, level: "expired", tone: "#991b1b" },
    { key: "overdue-30", days: -30, level: "expired", tone: "#991b1b" },
  ];

  const DAY = 24 * 60 * 60 * 1000;

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00Z");
    if (isNaN(d.getTime())) return null;
    const today = new Date(nowISO().slice(0, 10) + "T00:00:00Z");
    return Math.round((d.getTime() - today.getTime()) / DAY);
  }

  function fmtDate(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00Z");
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  // The stage a certification is due for right now, or null. Picks the most
  // urgent threshold that has been crossed so a certification added late (or a
  // sweep that did not run for a week) still sends the right notice instead of
  // silently skipping every stage it slept through.
  function dueStage(daysLeft) {
    if (daysLeft == null) return null;
    let chosen = null;
    for (const s of CERT_STAGES) {
      if (daysLeft <= s.days) chosen = s; // list is ordered most-distant first
    }
    return chosen;
  }

  function certStatusOf(cert) {
    const d = daysUntil(cert.expiration_date);
    if (cert.status === "archived") return { key: "archived", label: "Archived", days: d };
    if (d == null) return { key: "no_date", label: "No expiry date on file", days: null };
    if (d < 0) return { key: "expired", label: `Expired ${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ago`, days: d };
    if (d === 0) return { key: "expires_today", label: "Expires today", days: 0 };
    if (d <= 30) return { key: "critical", label: `Expires in ${d} day${d === 1 ? "" : "s"}`, days: d };
    if (d <= 90) return { key: "soon", label: `Expires in ${d} days`, days: d };
    return { key: "ok", label: `Expires in ${d} days`, days: d };
  }

  // ======================= CERT EMAILS =======================
  function certEmailHtml({ heading, intro, cert, employeeName, daysLeft, tone, forDirector }) {
    const when = fmtDate(cert.expiration_date);
    const countdown =
      daysLeft > 0 ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} from today`
      : daysLeft === 0 ? "today"
      : `${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} ago`;
    return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2333;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <div style="background:${tone};color:#fff;padding:18px 24px;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Spectrum Squad</div>
      <div style="font-size:19px;font-weight:700;margin-top:2px;">${esc(heading)}</div>
    </div>
    <div style="padding:22px 24px;font-size:14.5px;line-height:1.6;">
      <p style="margin:0 0 14px;">${intro}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 16px;">
        <tr><td style="padding:6px 0;color:#6b7280;width:150px;">Certification</td><td style="padding:6px 0;font-weight:600;">${esc(cert.name)}</td></tr>
        ${forDirector ? `<tr><td style="padding:6px 0;color:#6b7280;">Staff member</td><td style="padding:6px 0;font-weight:600;">${esc(employeeName)}</td></tr>` : ""}
        ${cert.issuing_body ? `<tr><td style="padding:6px 0;color:#6b7280;">Issued by</td><td style="padding:6px 0;">${esc(cert.issuing_body)}</td></tr>` : ""}
        ${cert.credential_number ? `<tr><td style="padding:6px 0;color:#6b7280;">Number</td><td style="padding:6px 0;">${esc(cert.credential_number)}</td></tr>` : ""}
        <tr><td style="padding:6px 0;color:#6b7280;">Expiration date</td><td style="padding:6px 0;font-weight:600;">${esc(when)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">That is</td><td style="padding:6px 0;">${esc(countdown)}</td></tr>
      </table>
      ${cert.notes ? `<p style="margin:0 0 14px;color:#4b5563;"><strong>Notes:</strong> ${esc(cert.notes)}</p>` : ""}
      <p style="margin:0 0 6px;color:#6b7280;font-size:13px;">Once the certification is renewed, update the expiration date on the staff record and these reminders stop automatically.</p>
    </div>
  </div>
  <div style="max-width:560px;margin:12px auto 0;text-align:center;color:#9aa0ae;font-size:11.5px;">Sent automatically by the Spectrum Squad CRM · ${esc(APP_BASE_URL)}</div>
</body></html>`;
  }

  async function sendCertNotices(cert, employee, stage, daysLeft) {
    const directorEmail = clean(await getAppSetting("clinical_director_email", ""));
    const recipients = [];
    const staffEmail = clean(employee && employee.email);
    const first = (clean(employee && employee.name).split(/\s+/)[0]) || "there";

    const urgency =
      stage.key === "expired" || stage.key.startsWith("overdue") ? "has expired"
      : daysLeft === 1 ? "expires tomorrow"
      : daysLeft === 0 ? "expires today"
      : `expires in ${daysLeft} days`;

    if (staffEmail && cert.notify_staff !== false) {
      await sendEmail({
        to: staffEmail,
        subject: `${stage.key.startsWith("overdue") || stage.key === "expired" ? "Expired" : "Reminder"}: your ${cert.name} ${urgency}`,
        html: certEmailHtml({
          heading: stage.key === "expired" || stage.key.startsWith("overdue")
            ? "Certification expired" : "Certification renewal reminder",
          intro: `Hi ${esc(first)}, your <strong>${esc(cert.name)}</strong> ${esc(urgency)}. Please start the renewal and send the updated certificate to the office so we can keep your file current.`,
          cert, employeeName: employee.name, daysLeft, tone: stage.tone, forDirector: false,
        }),
        type: "certification_expiry",
      }).catch((e) => console.error("cert notice to staff failed:", e.message));
      recipients.push(staffEmail);
    }

    if (directorEmail) {
      await sendEmail({
        to: directorEmail,
        subject: `${employee.name}: ${cert.name} ${urgency}`,
        html: certEmailHtml({
          heading: stage.key === "expired" || stage.key.startsWith("overdue")
            ? "Staff certification expired" : "Staff certification expiring",
          intro: `<strong>${esc(employee.name)}</strong>'s <strong>${esc(cert.name)}</strong> ${esc(urgency)}.${staffEmail ? " They have been emailed as well." : " <em>No email address is on file for this staff member, so only you were notified.</em>"}`,
          cert, employeeName: employee.name, daysLeft, tone: stage.tone, forDirector: true,
        }),
        type: "certification_expiry",
      }).catch((e) => console.error("cert notice to director failed:", e.message));
      recipients.push(directorEmail);
    }

    return recipients;
  }

  // The daily sweep. Claiming the stage row BEFORE sending is deliberate: if the
  // process dies between the insert and the send, one notice is missed, which is
  // recoverable. The other order would re-send on every restart.
  async function certificationSweep({ dryRun = false } = {}) {
    const results = { checked: 0, sent: [], skipped: [] };
    let rows;
    try {
      rows = await dbAll(
        `SELECT c.*, e.name AS employee_name, e.email AS employee_email, e.status AS employee_status
           FROM staff_certifications c
           JOIN hr_employees e ON e.id = c.employee_id
          WHERE c.status = 'active' AND c.expiration_date IS NOT NULL AND c.expiration_date <> ''`
      );
    } catch (e) {
      // hr_employees may not exist in a stripped test database.
      return { ...results, error: e.message };
    }

    for (const cert of rows) {
      results.checked++;
      if (["terminated", "archived"].includes(clean(cert.employee_status))) {
        results.skipped.push({ id: cert.id, why: "staff member is no longer active" });
        continue;
      }
      const daysLeft = daysUntil(cert.expiration_date);
      const stage = dueStage(daysLeft);
      if (!stage) continue;
      // Past the last nag: stop.
      if (daysLeft < CERT_STAGES[CERT_STAGES.length - 1].days) {
        results.skipped.push({ id: cert.id, why: "past the final overdue notice" });
        continue;
      }

      const expSnapshot = String(cert.expiration_date).slice(0, 10);
      const already = await dbGet(
        "SELECT id FROM certification_notices WHERE certification_id = ? AND stage = ? AND expiration_date = ?",
        [cert.id, stage.key, expSnapshot]
      );
      if (already) continue;

      if (dryRun) {
        results.sent.push({ id: cert.id, employee: cert.employee_name, name: cert.name, stage: stage.key, days: daysLeft, dry_run: true });
        continue;
      }

      // Claim first, then send.
      try {
        await dbRun(
          `INSERT INTO certification_notices (certification_id, stage, expiration_date, sent_to, sent_at)
           VALUES (?, ?, ?, ?, ?)`,
          [cert.id, stage.key, expSnapshot, "", nowISO()]
        );
      } catch (e) {
        continue; // lost the race with another sweep; that one will send.
      }

      const recipients = await sendCertNotices(
        cert,
        { id: cert.employee_id, name: cert.employee_name, email: cert.employee_email },
        stage, daysLeft
      );
      await dbRun("UPDATE certification_notices SET sent_to = ? WHERE certification_id = ? AND stage = ? AND expiration_date = ?",
        [recipients.join(", "), cert.id, stage.key, expSnapshot]).catch(() => {});

      results.sent.push({
        id: cert.id, employee: cert.employee_name, name: cert.name,
        stage: stage.key, days: daysLeft, to: recipients,
      });
      if (!recipients.length) {
        results.skipped.push({ id: cert.id, why: "nobody to notify — no staff email and no Clinical Director address configured" });
      }
    }
    return results;
  }

  // ======================= API ===============================
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/people/")) return false;
    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }

    try {
      // ---------------- departments ----------------
      if (pathname === "/api/people/departments" && method === "GET") {
        if (!isAdmin(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        json(res, 200, { departments: await listDepartments(true), colors: DEPT_COLORS });
        return true;
      }

      if (pathname === "/api/people/departments" && method === "POST") {
        if (!isAdmin(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const b = await readBody(req);
        const name = clean(b.name);
        if (!name) { json(res, 400, { error: "Give the department a name." }); return true; }
        const dupe = await dbGet("SELECT id FROM departments WHERE LOWER(name) = LOWER(?)", [name]);
        if (dupe) { json(res, 409, { error: "A department with that name already exists." }); return true; }
        const key = await uniqueKey(name);
        const count = await dbGet("SELECT COUNT(*) AS n FROM departments");
        const color = clean(b.color) || DEPT_COLORS[Number(count.n) % DEPT_COLORS.length];
        const row = await dbGet(
          `INSERT INTO departments (key, name, color, notify_email, description, active, sort_order)
           VALUES (?, ?, ?, ?, ?, TRUE, ?) RETURNING *`,
          [key, name.slice(0, 80), color, clean(b.notify_email) || null, clean(b.description) || null, Number(count.n) + 1]
        );
        row.usage = await departmentUsage(row.id);
        json(res, 201, row);
        return true;
      }

      const deptMatch = pathname.match(/^\/api\/people\/departments\/(\d+)$/);
      if (deptMatch && method === "PATCH") {
        if (!isAdmin(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const id = Number(deptMatch[1]);
        const dept = await dbGet("SELECT * FROM departments WHERE id = ?", [id]);
        if (!dept) { json(res, 404, { error: "That department no longer exists." }); return true; }
        const b = await readBody(req);
        const sets = [], params = [];

        if (typeof b.name === "string" && clean(b.name)) {
          const dupe = await dbGet("SELECT id FROM departments WHERE LOWER(name) = LOWER(?) AND id <> ?", [clean(b.name), id]);
          if (dupe) { json(res, 409, { error: "Another department already uses that name." }); return true; }
          // The key is left alone on rename. Seeded keys ("intake", "clinical")
          // are referenced by the pipeline seed and by department alert lookups;
          // rewriting one would break routing to make a label prettier.
          sets.push("name = ?"); params.push(clean(b.name).slice(0, 80));
        }
        if (typeof b.color === "string" && clean(b.color)) { sets.push("color = ?"); params.push(clean(b.color).slice(0, 20)); }
        if ("notify_email" in b) {
          const em = clean(b.notify_email);
          if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { json(res, 400, { error: "That notify address doesn't look like an email." }); return true; }
          sets.push("notify_email = ?"); params.push(em || null);
        }
        if ("description" in b) { sets.push("description = ?"); params.push(clean(b.description) || null); }
        if ("sort_order" in b) { sets.push("sort_order = ?"); params.push(Number(b.sort_order) || null); }
        if ("active" in b) {
          const active = !!b.active;
          if (!active) {
            const usage = await departmentUsage(id);
            if (usage.stage_tasks > 0) {
              json(res, 409, {
                error: `${dept.name} still routes ${usage.stage_tasks} pipeline stage task${usage.stage_tasks === 1 ? "" : "s"}. Move those to another department first, or delete the department and choose a replacement.`,
              });
              return true;
            }
          }
          sets.push("active = ?"); params.push(active);
        }
        if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
        params.push(id);
        await dbRun(`UPDATE departments SET ${sets.join(", ")} WHERE id = ?`, params);
        const updated = await dbGet("SELECT * FROM departments WHERE id = ?", [id]);
        updated.usage = await departmentUsage(id);
        json(res, 200, updated);
        return true;
      }

      if (deptMatch && method === "DELETE") {
        if (!isAdmin(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const id = Number(deptMatch[1]);
        const dept = await dbGet("SELECT * FROM departments WHERE id = ?", [id]);
        if (!dept) { json(res, 404, { error: "That department no longer exists." }); return true; }
        const remaining = await dbGet("SELECT COUNT(*) AS n FROM departments WHERE id <> ?", [id]);
        if (Number(remaining.n) === 0) { json(res, 400, { error: "You can't delete the last department." }); return true; }

        const usage = await departmentUsage(id);
        const reassignTo = Number(query.reassign_to || 0) || null;

        if (usage.total > 0 && !reassignTo) {
          json(res, 409, {
            error: "in_use",
            message: `${dept.name} is still used by ${usage.stage_tasks} pipeline stage task${usage.stage_tasks === 1 ? "" : "s"} and ${usage.users} team member${usage.users === 1 ? "" : "s"}. Choose a department to move them to.`,
            usage,
            options: (await listDepartments(false)).filter((d) => d.id !== id).map((d) => ({ id: d.id, name: d.name })),
          });
          return true;
        }

        if (reassignTo) {
          const target = await dbGet("SELECT * FROM departments WHERE id = ?", [reassignTo]);
          if (!target || target.id === id) { json(res, 400, { error: "Pick a different, existing department to move things to." }); return true; }
          // Move every reference before the row goes, so nothing is left
          // pointing at a department id that no longer resolves.
          for (const ref of DEPT_REFERENCES) {
            await dbRun(`UPDATE ${ref.table} SET ${ref.column} = ? WHERE ${ref.column} = ?`, [reassignTo, id]).catch(() => {});
          }
        }

        await dbRun("DELETE FROM departments WHERE id = ?", [id]);
        json(res, 200, { ok: true, deleted: dept.name, reassigned_to: reassignTo || null, moved: usage.total });
        return true;
      }

      // ---------------- emergency contacts ----------------
      if (pathname === "/api/people/emergency-contacts" && method === "GET") {
        const ownerType = clean(query.owner_type) === "staff" ? "staff" : "client";
        const ownerId = Number(query.owner_id || 0);
        if (!ownerId) { json(res, 400, { error: "owner_id is required." }); return true; }
        if (!canOwner(user, ownerType)) { json(res, 403, { error: "Not permitted" }); return true; }
        const rows = await dbAll(
          `SELECT * FROM emergency_contacts WHERE owner_type = ? AND owner_id = ?
            ORDER BY is_primary DESC, sort_order, id`,
          [ownerType, ownerId]
        );
        if (ownerType !== "client") { json(res, 200, { contacts: rows }); return true; }
        // Which of these actually satisfy the rule, and which pre-date it and
        // still need the household question answered.
        const compliant = rows.filter((c) => !clientContactProblem(c.relationship, c.outside_household === true));
        json(res, 200, {
          contacts: rows,
          requires_outside_household: true,
          has_compliant_contact: compliant.length > 0,
          needs_review: rows.filter((c) => c.outside_household == null).map((c) => c.id),
        });
        return true;
      }

      if (pathname === "/api/people/emergency-contacts" && method === "POST") {
        const b = await readBody(req);
        const ownerType = clean(b.owner_type) === "staff" ? "staff" : "client";
        const ownerId = Number(b.owner_id || 0);
        if (!ownerId) { json(res, 400, { error: "owner_id is required." }); return true; }
        if (!canOwner(user, ownerType)) { json(res, 403, { error: "Not permitted" }); return true; }
        const name = clean(b.name);
        if (!name) { json(res, 400, { error: "An emergency contact needs a name." }); return true; }
        if (!clean(b.phone) && !clean(b.alt_phone)) {
          json(res, 400, { error: "An emergency contact needs at least one phone number." });
          return true;
        }
        if (ownerType === "client") {
          const problem = clientContactProblem(b.relationship, b.outside_household === true);
          if (problem) { json(res, 400, { error: problem }); return true; }
        }
        if (b.is_primary) {
          await dbRun("UPDATE emergency_contacts SET is_primary = FALSE WHERE owner_type = ? AND owner_id = ?", [ownerType, ownerId]);
        }
        const row = await dbGet(
          `INSERT INTO emergency_contacts
             (owner_type, owner_id, name, relationship, phone, alt_phone, email, address,
              is_primary, can_pick_up, outside_household, notes, sort_order, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
          [ownerType, ownerId, name.slice(0, 120), clean(b.relationship) || null,
           clean(b.phone) || null, clean(b.alt_phone) || null, clean(b.email) || null,
           clean(b.address) || null, !!b.is_primary, ownerType === "client" && !!b.can_pick_up,
           ownerType === "client" ? b.outside_household === true : null,
           clean(b.notes) || null, Number(b.sort_order) || 0, user.email, nowISO(), nowISO()]
        );
        json(res, 201, row);
        return true;
      }

      const ecMatch = pathname.match(/^\/api\/people\/emergency-contacts\/(\d+)$/);
      if (ecMatch && (method === "PATCH" || method === "DELETE")) {
        const id = Number(ecMatch[1]);
        const row = await dbGet("SELECT * FROM emergency_contacts WHERE id = ?", [id]);
        if (!row) { json(res, 404, { error: "That contact no longer exists." }); return true; }
        if (!canOwner(user, row.owner_type)) { json(res, 403, { error: "Not permitted" }); return true; }

        if (method === "DELETE") {
          await dbRun("DELETE FROM emergency_contacts WHERE id = ?", [id]);
          json(res, 200, { ok: true });
          return true;
        }

        const b = await readBody(req);
        const fields = ["name", "relationship", "phone", "alt_phone", "email", "address", "notes"];
        const sets = [], params = [];
        for (const f of fields) {
          if (f in b) {
            if (f === "name" && !clean(b.name)) { json(res, 400, { error: "An emergency contact needs a name." }); return true; }
            sets.push(`${f} = ?`); params.push(clean(b[f]) || null);
          }
        }
        // Re-run the client rule against the record as it WILL be, so an edit
        // can never turn a compliant contact into the parent, or quietly clear
        // the out-of-household confirmation.
        if (row.owner_type === "client" && ("relationship" in b || "outside_household" in b)) {
          const nextRel = "relationship" in b ? b.relationship : row.relationship;
          const nextOutside = "outside_household" in b ? b.outside_household === true : row.outside_household === true;
          const problem = clientContactProblem(nextRel, nextOutside);
          if (problem) { json(res, 400, { error: problem }); return true; }
        }
        if ("outside_household" in b) {
          sets.push("outside_household = ?");
          params.push(row.owner_type === "client" ? b.outside_household === true : null);
        }
        if ("can_pick_up" in b) { sets.push("can_pick_up = ?"); params.push(row.owner_type === "client" && !!b.can_pick_up); }
        if ("sort_order" in b) { sets.push("sort_order = ?"); params.push(Number(b.sort_order) || 0); }
        if ("is_primary" in b) {
          if (b.is_primary) {
            await dbRun("UPDATE emergency_contacts SET is_primary = FALSE WHERE owner_type = ? AND owner_id = ?", [row.owner_type, row.owner_id]);
          }
          sets.push("is_primary = ?"); params.push(!!b.is_primary);
        }
        if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
        sets.push("updated_at = ?"); params.push(nowISO());
        params.push(id);
        await dbRun(`UPDATE emergency_contacts SET ${sets.join(", ")} WHERE id = ?`, params);
        json(res, 200, await dbGet("SELECT * FROM emergency_contacts WHERE id = ?", [id]));
        return true;
      }

      // ---------------- certifications ----------------
      if (pathname === "/api/people/certifications" && method === "GET") {
        if (!canStaff(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const employeeId = Number(query.employee_id || 0);
        const rows = employeeId
          ? await dbAll("SELECT * FROM staff_certifications WHERE employee_id = ? ORDER BY status, expiration_date NULLS LAST, name", [employeeId])
          : await dbAll(
              `SELECT c.*, e.name AS employee_name, e.email AS employee_email
                 FROM staff_certifications c JOIN hr_employees e ON e.id = c.employee_id
                WHERE c.status = 'active'
                ORDER BY c.expiration_date NULLS LAST, e.name`
            );
        for (const r of rows) r.state = certStatusOf(r);
        json(res, 200, { certifications: rows, stages: CERT_STAGES.map((s) => s.key) });
        return true;
      }

      if (pathname === "/api/people/certifications" && method === "POST") {
        if (!canStaff(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const b = await readBody(req);
        const employeeId = Number(b.employee_id || 0);
        if (!employeeId) { json(res, 400, { error: "Which staff member is this for?" }); return true; }
        const name = clean(b.name);
        if (!name) { json(res, 400, { error: "Give the certification a name (RBT, CPR/BLS, and so on)." }); return true; }
        const row = await dbGet(
          `INSERT INTO staff_certifications
             (employee_id, name, issuing_body, credential_number, issued_date, expiration_date,
              status, notes, notify_staff, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
          [employeeId, name.slice(0, 120), clean(b.issuing_body) || null, clean(b.credential_number) || null,
           clean(b.issued_date) || null, clean(b.expiration_date) || null, "active",
           clean(b.notes) || null, b.notify_staff === false ? false : true, user.email, nowISO(), nowISO()]
        );
        row.state = certStatusOf(row);
        json(res, 201, row);
        return true;
      }

      const certMatch = pathname.match(/^\/api\/people\/certifications\/(\d+)$/);
      if (certMatch && (method === "PATCH" || method === "DELETE")) {
        if (!canStaff(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const id = Number(certMatch[1]);
        const cert = await dbGet("SELECT * FROM staff_certifications WHERE id = ?", [id]);
        if (!cert) { json(res, 404, { error: "That certification no longer exists." }); return true; }

        if (method === "DELETE") {
          await dbRun("DELETE FROM certification_notices WHERE certification_id = ?", [id]).catch(() => {});
          await dbRun("DELETE FROM staff_certifications WHERE id = ?", [id]);
          json(res, 200, { ok: true });
          return true;
        }

        const b = await readBody(req);
        const sets = [], params = [];
        for (const f of ["name", "issuing_body", "credential_number", "issued_date", "expiration_date", "notes"]) {
          if (f in b) { sets.push(`${f} = ?`); params.push(clean(b[f]) || null); }
        }
        if ("status" in b) {
          const st = clean(b.status);
          if (!["active", "renewed", "archived"].includes(st)) { json(res, 400, { error: "Unknown status." }); return true; }
          sets.push("status = ?"); params.push(st);
        }
        if ("notify_staff" in b) { sets.push("notify_staff = ?"); params.push(!!b.notify_staff); }
        if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
        sets.push("updated_at = ?"); params.push(nowISO());
        params.push(id);
        await dbRun(`UPDATE staff_certifications SET ${sets.join(", ")} WHERE id = ?`, params);
        const updated = await dbGet("SELECT * FROM staff_certifications WHERE id = ?", [id]);
        updated.state = certStatusOf(updated);
        // Renewing = a new expiration date. The notice rows are keyed on the old
        // date, so the staged reminders re-arm on their own for the new one.
        json(res, 200, updated);
        return true;
      }

      // Notice history for one certification -- so the card can show what has
      // already gone out rather than leaving anyone guessing.
      const certNoticeMatch = pathname.match(/^\/api\/people\/certifications\/(\d+)\/notices$/);
      if (certNoticeMatch && method === "GET") {
        if (!canStaff(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        json(res, 200, {
          notices: await dbAll(
            "SELECT * FROM certification_notices WHERE certification_id = ? ORDER BY sent_at DESC",
            [Number(certNoticeMatch[1])]
          ),
        });
        return true;
      }

      // Expiring-soon roll-up for the Staff page banner.
      if (pathname === "/api/people/certifications/expiring" && method === "GET") {
        if (!canStaff(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const within = Number(query.days || 90);
        let rows = [];
        try {
          rows = await dbAll(
            `SELECT c.*, e.name AS employee_name, e.status AS employee_status
               FROM staff_certifications c JOIN hr_employees e ON e.id = c.employee_id
              WHERE c.status = 'active' AND c.expiration_date IS NOT NULL AND c.expiration_date <> ''
              ORDER BY c.expiration_date`
          );
        } catch (e) { rows = []; }
        const out = rows
          .filter((r) => !["terminated", "archived"].includes(clean(r.employee_status)))
          .map((r) => ({ ...r, state: certStatusOf(r) }))
          .filter((r) => r.state.days != null && r.state.days <= within);
        json(res, 200, {
          expiring: out,
          expired: out.filter((r) => r.state.days < 0).length,
          within_30: out.filter((r) => r.state.days >= 0 && r.state.days <= 30).length,
          clinical_director_email: clean(await getAppSetting("clinical_director_email", "")),
        });
        return true;
      }

      // Manual run of the sweep. dry_run=1 reports what WOULD send.
      if (pathname === "/api/people/certifications/sweep" && method === "POST") {
        if (!isAdmin(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const b = await readBody(req).catch(() => ({}));
        json(res, 200, await certificationSweep({ dryRun: !!(b && b.dry_run) }));
        return true;
      }

      json(res, 404, { error: "Not found" });
      return true;
    } catch (err) {
      console.error("people.js error on", method, pathname, err);
      json(res, 500, { error: err.message || "Something went wrong." });
      return true;
    }
  }

  return {
    initTables,
    handleApi,
    certificationSweep,
    listDepartments,
    _lib: { CERT_STAGES, daysUntil, dueStage, certStatusOf, slugify },
  };
};
