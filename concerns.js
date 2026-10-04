// Report a Concern.
//
// Not a complaint box. A complaint box is where somebody tells you about
// somebody else; this applies to everyone, leadership included, and the rule
// it enforces is that raising a concern is a normal act with a normal process
// rather than a confrontation.
//
// Almost all the difficulty here is CONFIDENTIALITY, and it is not the kind
// that a permission flag solves on its own. Four things have to hold at once:
//
//   1. A CONCERN ABOUT SOMEBODY MUST NOT LAND ON THEIR DESK. Routing a concern
//      about a supervisor to that supervisor is worse than having no system,
//      because the employee believed there was one. So a reviewer who is NAMED
//      in a report cannot see it, cannot be assigned it, is not emailed about
//      it, and it is not in their list. Not hidden in the UI -- refused at the
//      API.
//
//   2. BEING NAMED HAS TO BE MACHINE-READABLE. "A person named in a report
//      cannot access it" is unenforceable against a text box: "Marissa",
//      "M. Gaut" and "my supervisor" are the same person and no string match
//      finds that out. So Person(s) Involved is a STAFF PICKER, stored as
//      ids, with free text alongside for anybody outside the system -- and the
//      exclusion runs off the structured half.
//
//   3. ACCESS IS A NAMED PERMISSION, NOT A JOB TITLE. An admin does not get
//      concern reports because they are an admin. The owner can hand the
//      permission to a specific person and take it away from a specific
//      person, including from herself.
//
//   4. NOTHING LEAKS SIDEWAYS. No dashboard tile, no notification body, no
//      activity feed, no search result. The emails this module sends name NO
//      detail at all -- not the type, not the people, not the text -- they say
//      only that something arrived and where to go and read it.
//
// ANONYMITY, HONESTLY. Inside the CRM a request carries a session, so the
// server knows who sent it whether or not it writes that down. Promising
// anonymity there would be a lie told to somebody taking a risk. So the
// in-app options are WITH MY NAME and CONFIDENTIAL, and genuine anonymity
// lives on the unauthenticated page, which ignores the session cookie even
// when the browser sends one. An anonymous report gets a reference code shown
// once, which is how its author follows it up without ever being identified.
//
// WHAT THIS CANNOT DO, said plainly because the alternative is false comfort:
// these are in-application controls. Somebody with direct database access can
// read any row in the database, including a concern naming them. The exclusion
// is enforced everywhere the application can enforce it, and every read is
// logged -- but a log is a deterrent, not a wall.
"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function initConcerns(ctx) {
  const { dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json } = ctx;

  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  const denied = (u, k) => !!(ctx.moduleDenied && ctx.moduleDenied(u, k));
  const role = (u) => (u && u.role) || "";
  const clean = (s) => String(s == null ? "" : s).trim();
  const num = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  const parseJson = (s, f) => { try { return s ? JSON.parse(s) : f; } catch (e) { return f; } };
  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // WHO MAY READ CONCERN REPORTS.
  //
  // Not "anyone with a manager or administrator title" -- that is the thing
  // the spec rules out, and for good reason: broad operational access
  // elsewhere in the CRM is not a reason to read somebody's account of being
  // treated unfairly.
  //
  // Owner and super_admin hold it by default, because a feature nobody can
  // read is a feature that silently swallows reports. Everyone else needs the
  // grant by name. The explicit DENY is checked first and beats everything, so
  // the owner can take it away from a specific person -- herself included --
  // which is what makes this a permission rather than a rank.
  const canReview = (u) =>
    !!u && !denied(u, "concern_review") &&
    (["owner", "super_admin"].includes(role(u)) || granted(u, "concern_review"));

  // Authorising a conflicted reviewer to see a report anyway, and granting the
  // review permission itself. The narrowest authority in the module.
  const canAuthorize = (u) => !!u && !denied(u, "concern_review") && ["owner", "super_admin"].includes(role(u));

  // Everyone signed in may raise one. The public page needs nobody at all.
  const canSubmit = (u) => !!u && !!u.id;

  const REPORT_TYPES = [
    "Policy Not Being Followed", "Policy Applied Inconsistently", "Unauthorized Policy Exception",
    "Favoritism or Preferential Treatment", "Professional Conduct Concern",
    "Leadership or Supervisor Concern", "Client Safety", "Employee Safety", "Clinical Concern",
    "Documentation Concern", "Billing or Compliance Concern", "Confidentiality or Privacy Concern",
    "Retaliation Concern", "Conflict of Interest", "Misuse of Company Resources", "Other",
  ];

  const STATUSES = [
    "New", "Received", "Under Review", "Additional Information Needed",
    "Investigation/Review In Progress", "Action Required", "Resolved", "Closed",
  ];
  const CLOSED = ["Resolved", "Closed"];

  // Three ways to send one, and the labels are honest about what each buys.
  // "anonymous" is reachable ONLY from the unauthenticated page -- see the
  // header, and the submit path that enforces it.
  const MODES = ["named", "confidential", "anonymous"];

  const WITNESS_ANSWERS = ["Yes", "No", "Not sure"];

  // The employee-facing words, kept here rather than in the page so the public
  // page and the in-app form cannot drift apart and promise different things.
  const INTRO = "If you observe something that may be inconsistent with Spectrum Squad policies, " +
    "procedures, professional standards, safety expectations, or our commitment to fair and " +
    "consistent operations, you may submit a concern here for review.";
  const NON_RETALIATION = "Spectrum Squad expects concerns to be raised in good faith. " +
    "Retaliation against an employee for raising a good faith concern or participating in a " +
    "review is prohibited.";
  const NOT_AN_ACCUSATION = "Submitting a concern does not mean wrongdoing has occurred. " +
    "It means something will be looked at.";

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS concern_reports (
      id SERIAL PRIMARY KEY,
      reference_code TEXT UNIQUE NOT NULL,   -- how an anonymous reporter follows up
      reporting_mode TEXT NOT NULL,          -- named | confidential | anonymous
      -- All three NULL for an anonymous report. Not "blanked on display":
      -- never written. See submitReport().
      reporter_user_id INTEGER,
      reporter_name TEXT,
      reporter_email TEXT,

      incident_date TEXT,
      incident_time TEXT,
      location TEXT,
      concern_type TEXT NOT NULL,
      concern_type_other TEXT,
      description TEXT NOT NULL,
      policy_id INTEGER,                     -- the policy/SOP involved, if it is in the library
      policy_text TEXT,                      -- or named in free text if it is not
      witnesses_present TEXT,                -- Yes | No | Not sure
      witnesses_text TEXT,
      reported_previously BOOLEAN DEFAULT FALSE,
      reported_previously_detail TEXT,
      additional_info TEXT,

      status TEXT NOT NULL DEFAULT 'New',
      assigned_reviewer_user_id INTEGER,
      assigned_reviewer_name TEXT,

      -- The reviewer's record of what was done.
      review_notes TEXT,
      applicable_policy_id INTEGER,
      applicable_policy_text TEXT,
      findings TEXT,
      corrective_action TEXT,
      follow_up_required BOOLEAN DEFAULT FALSE,
      follow_up_detail TEXT,
      resolution TEXT,
      closed_at TEXT,
      closed_by TEXT,

      created_at TEXT NOT NULL,
      updated_at TEXT
    )`).catch((e) => console.error("concern_reports initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_concern_status ON concern_reports(status)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_concern_ref ON concern_reports(reference_code)`).catch(() => {});

    // WHO IS NAMED. The structured half of Person(s) Involved, and the thing
    // the whole exclusion runs off. user_id is what an access check compares
    // against; employee_id is kept because the picker is the staff list and
    // not every employee has a login.
    await dbRun(`CREATE TABLE IF NOT EXISTS concern_report_people (
      id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL,
      employee_id INTEGER,
      user_id INTEGER,
      name TEXT,
      -- 'involved' = named by the reporter. 'interviewed' = spoken to during
      -- the review. Both are people the report is ABOUT or TOUCHES, and both
      -- are stored here so one query answers "is this person in this report".
      relation TEXT NOT NULL DEFAULT 'involved',
      note TEXT,
      added_at TEXT,
      added_by TEXT
    )`).catch((e) => console.error("concern_report_people initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_concern_people ON concern_report_people(report_id)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_concern_people_user ON concern_report_people(user_id)`).catch(() => {});

    // Anybody outside the system, or a description rather than a person. Kept
    // apart from the structured list so nobody mistakes free text for
    // something the exclusion can act on.
    await dbRun(`ALTER TABLE concern_reports ADD COLUMN IF NOT EXISTS people_text TEXT`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS concern_report_files (
      id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL,
      filename TEXT,
      content_type TEXT,
      data_base64 TEXT,
      caption TEXT,
      -- 'report' = sent by the reporter. 'evidence' = gathered in the review.
      kind TEXT NOT NULL DEFAULT 'report',
      added_at TEXT,
      added_by TEXT
    )`).catch((e) => console.error("concern_report_files initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_concern_files ON concern_report_files(report_id)`).catch(() => {});

    // The audit trail the spec asks for: when it was submitted, who ACCESSED
    // it, who changed the status, who reassigned it, what was done and when.
    // Reads are recorded here too, which is the point -- a log that only
    // records writes cannot answer "who has seen this".
    await dbRun(`CREATE TABLE IF NOT EXISTS concern_report_history (
      id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      actor_id INTEGER,
      actor_name TEXT,
      created_at TEXT NOT NULL
    )`).catch((e) => console.error("concern_report_history initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_concern_hist ON concern_report_history(report_id, id)`).catch(() => {});

    // "...unless specifically authorized by executive leadership." This table
    // IS that authorization: one row per person per report, with a written
    // reason, granted by somebody who is not themselves named. Absent a row,
    // a named reviewer is refused.
    await dbRun(`CREATE TABLE IF NOT EXISTS concern_report_access (
      id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      authorized_by TEXT NOT NULL,
      authorized_by_id INTEGER,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT,
      UNIQUE (report_id, user_id)
    )`).catch((e) => console.error("concern_report_access initTables:", e.message));
  }

  // ---------------------------------------------------------------
  // The access rules. Everything else in this module goes through these.
  // ---------------------------------------------------------------

  // Every user id named in a report, in either relation. One query, because
  // this runs on every single read.
  async function namedUserIds(reportId) {
    const rows = await dbAll(
      "SELECT user_id FROM concern_report_people WHERE report_id = ? AND user_id IS NOT NULL", [reportId]
    ).catch(() => []);
    return new Set(rows.map((r) => Number(r.user_id)));
  }

  async function isNamed(user, reportId) {
    if (!user || !user.id) return false;
    return (await namedUserIds(reportId)).has(Number(user.id));
  }

  async function hasAuthorization(user, reportId) {
    if (!user || !user.id) return false;
    const r = await dbGet(
      "SELECT id FROM concern_report_access WHERE report_id = ? AND user_id = ? AND revoked_at IS NULL",
      [reportId, user.id]).catch(() => null);
    return !!r;
  }

  // THE RULE. A reviewer sees a report unless they are named in it, and a
  // named reviewer sees it only with an explicit authorization on the record.
  //
  // Note what is NOT here: no special case for the owner. Being named excludes
  // her from the application's view of the report exactly as it excludes
  // anybody else, and if she needs it she authorizes herself by name and that
  // authorization is a row somebody can read.
  async function canAccess(user, reportId) {
    if (!canReview(user)) return false;
    if (await isNamed(user, reportId)) return hasAuthorization(user, reportId);
    return true;
  }

  async function log(reportId, entry) {
    await dbRun(
      `INSERT INTO concern_report_history (report_id, action, from_status, to_status, note, actor_id, actor_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [reportId, entry.action, entry.from_status || null, entry.to_status || null, entry.note || null,
       entry.actor_id || null, entry.actor_name || null, nowISO()]
    ).catch((e) => console.error("concern history:", e.message));
  }

  // A reference the reporter keeps. Deliberately not sequential and not
  // derived from anything: an anonymous report's code is the ONLY thing
  // connecting its author to it, and it exists only in their hands.
  function referenceCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
    const bytes = crypto.randomBytes(10);
    let out = "";
    for (let i = 0; i < 10; i++) out += alphabet[bytes[i] % alphabet.length];
    return "SQ-" + out.slice(0, 5) + "-" + out.slice(5);
  }

  // ---------------------------------------------------------------
  // Submitting
  // ---------------------------------------------------------------

  // Shared by the in-app form and the unauthenticated page.
  //
  // `user` is the session the request arrived with, and `allowAnonymous` says
  // whether this caller is the public page. The anonymity guarantee is the
  // first thing in the function and it is a DELETION, not a formatting
  // choice: when the mode is anonymous the session is dropped on the floor
  // before anything is written, so the row cannot carry an identity even
  // though the browser sent a perfectly good cookie. No IP either -- it is not
  // read, not passed in, and not stored.
  async function submitReport(b, user, allowAnonymous) {
    let mode = clean(b.reporting_mode).toLowerCase();
    if (!MODES.includes(mode)) mode = user ? "named" : "anonymous";
    if (mode === "anonymous" && !allowAnonymous) {
      return { error: "Anonymous reports are submitted from the open page, which carries no sign-in. " +
        "From inside the CRM your session identifies you, so this would be confidential rather than anonymous.", status: 400 };
    }
    if (mode !== "anonymous" && !user) {
      return { error: "Sign in to put your name to a concern, or submit anonymously instead.", status: 401 };
    }
    const anon = mode === "anonymous";
    const reporter = anon ? { id: null, name: null, email: null } : {
      id: user.id || null,
      name: clean(b.reporter_name) || user.name || null,
      email: clean(b.reporter_email) || user.email || null,
    };

    const type = clean(b.concern_type);
    if (!REPORT_TYPES.includes(type)) return { error: "Choose what kind of concern this is.", status: 400 };
    if (!clean(b.description)) return { error: "Describe what you observed — that is what gets reviewed.", status: 400 };

    const now = nowISO();
    const code = referenceCode();
    const row = await dbGet(
      `INSERT INTO concern_reports
         (reference_code, reporting_mode, reporter_user_id, reporter_name, reporter_email,
          incident_date, incident_time, location, concern_type, concern_type_other, description,
          policy_id, policy_text, witnesses_present, witnesses_text,
          reported_previously, reported_previously_detail, additional_info, people_text,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?) RETURNING *`,
      [code, mode, reporter.id, reporter.name, reporter.email,
       clean(b.incident_date) || null, clean(b.incident_time) || null, clean(b.location) || null,
       type, clean(b.concern_type_other) || null, clean(b.description),
       num(b.policy_id), clean(b.policy_text) || null,
       WITNESS_ANSWERS.includes(clean(b.witnesses_present)) ? clean(b.witnesses_present) : null,
       clean(b.witnesses_text) || null,
       b.reported_previously === true, clean(b.reported_previously_detail) || null,
       clean(b.additional_info) || null, clean(b.people_text) || null, now, now]
    );

    // The structured half of Person(s) Involved. Each entry is resolved to a
    // user id where one exists, because that id is what the exclusion compares
    // against -- an employee named only by their employee record still appears
    // on the report, but cannot be matched to a login, and the review screen
    // says so rather than pretending the exclusion covers them.
    const people = Array.isArray(b.people_involved) ? b.people_involved : [];
    for (const person of people.slice(0, 40)) {
      const empId = num(person && person.employee_id);
      let userId = num(person && person.user_id);
      let name = clean(person && person.name);
      if (empId) {
        const emp = await dbGet("SELECT id, name, email, user_id FROM hr_employees WHERE id = ?", [empId]).catch(() => null);
        if (emp) {
          name = name || emp.name;
          if (!userId) {
            // The employee record may carry the link directly; where it does
            // not, the login is found by address, which is how the rest of
            // this CRM joins a staff member to their account.
            userId = num(emp.user_id);
            if (!userId && clean(emp.email)) {
              const u = await dbGet("SELECT id FROM users WHERE LOWER(TRIM(email)) = ?",
                [clean(emp.email).toLowerCase()]).catch(() => null);
              userId = u ? u.id : null;
            }
          }
        }
      }
      if (!empId && !userId && !name) continue;
      await dbRun(
        `INSERT INTO concern_report_people (report_id, employee_id, user_id, name, relation, added_at, added_by)
         VALUES (?, ?, ?, ?, 'involved', ?, ?)`,
        [row.id, empId, userId, name || null, now, anon ? "anonymous reporter" : (reporter.name || "reporter")]
      ).catch((e) => console.error("concern person:", e.message));
    }

    for (const f of (Array.isArray(b.files) ? b.files : []).slice(0, 10)) {
      if (!f || !clean(f.data_base64)) continue;
      await dbRun(
        `INSERT INTO concern_report_files (report_id, filename, content_type, data_base64, caption, kind, added_at, added_by)
         VALUES (?, ?, ?, ?, ?, 'report', ?, ?)`,
        [row.id, clean(f.filename) || "attachment", clean(f.content_type) || null,
         String(f.data_base64).slice(0, 8_000_000), clean(f.caption) || null, now,
         anon ? "anonymous reporter" : (reporter.name || "reporter")]
      ).catch((e) => console.error("concern file:", e.message));
    }

    await log(row.id, {
      action: "submitted",
      to_status: "New",
      // The audit trail records the MODE, never the identity of an anonymous
      // reporter -- writing it here would undo the deletion above.
      note: anon ? "Submitted anonymously" : (mode === "confidential" ? "Submitted confidentially" : "Submitted with name"),
      actor_id: anon ? null : reporter.id,
      actor_name: anon ? null : reporter.name,
    });

    await notifyReviewers(row.id).catch((e) => console.error("concern notify:", e.message));
    return { ok: true, id: row.id, reference_code: code, reporting_mode: mode };
  }

  // Telling the reviewers something arrived.
  //
  // Two rules, both load-bearing:
  //   * a reviewer NAMED in the report is not told about it -- this is the
  //     "must not automatically route to that same person" requirement, and
  //     the exclusion has to happen here as well as on the dashboard, because
  //     an email is a route;
  //   * the email says NOTHING. Not the type, not the people, not a word of
  //     the description. Message bodies are stored in notifications_log, which
  //     the Message Outbox shows to admins -- who are deliberately NOT
  //     concern reviewers. An empty-handed email cannot leak through a screen
  //     somebody else can read.
  async function notifyReviewers(reportId) {
    const named = await namedUserIds(reportId);
    const users = await dbAll(
      "SELECT id, name, email, role, module_access FROM users WHERE email IS NOT NULL AND TRIM(email) <> ''"
    ).catch(() => []);
    const base = String(APP_BASE_URL || "").replace(/\/+$/, "");
    const link = base ? base + "/#/concerns" : "/#/concerns";
    let told = 0;
    for (const u of users) {
      if (!canReview(u)) continue;
      if (named.has(Number(u.id))) continue;
      try {
        await sendEmail({
          to: u.email,
          subject: "A concern has been submitted for review",
          html: `<p>A concern has been submitted and is waiting in the Concern Review Dashboard.</p>` +
            `<p>No details are included in this message by design.</p>` +
            `<p><a href="${esc(link)}">Open the Concern Review Dashboard</a></p>`,
          type: "concern_review_alert",
        });
        told++;
      } catch (e) { /* logged by sendEmail */ }
    }
    if (!told) {
      // Nobody could be told. Either there are no reviewers, or every one of
      // them is named. Said loudly in the server log because a report nobody
      // is told about is the failure this feature exists to prevent.
      console.error(`[concerns] report ${reportId}: NO UNCONFLICTED REVIEWER WAS NOTIFIED. ` +
        `Either no account holds concern_review, or every holder is named in the report.`);
      await log(reportId, { action: "no_unconflicted_reviewer",
        note: "No reviewer could be notified: either nobody holds the permission, or every holder is named in this report." });
    }
    return told;
  }

  // Is there anybody at all who could review this one? Answered without
  // naming them, and used to surface the gap on the dashboard.
  async function unconflictedReviewerCount(reportId) {
    const named = await namedUserIds(reportId);
    const users = await dbAll("SELECT id, role, module_access FROM users").catch(() => []);
    return users.filter((u) => canReview(u) && !named.has(Number(u.id))).length;
  }

  // ---------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------

  async function peopleFor(id) {
    const rows = await dbAll("SELECT * FROM concern_report_people WHERE report_id = ? ORDER BY id", [id]).catch(() => []);
    return rows.map((r) => ({
      id: r.id, employee_id: r.employee_id, user_id: r.user_id, name: r.name,
      relation: r.relation, note: r.note,
      // Said out loud rather than left to be inferred: somebody with no login
      // cannot be matched by the exclusion, so the screen must not imply they
      // have been locked out of their own report.
      matchable: !!r.user_id,
    }));
  }

  async function shape(r, { full, viewer } = {}) {
    const out = {
      id: r.id, reference_code: r.reference_code, reporting_mode: r.reporting_mode,
      // An anonymous report has no identity to show because none was stored.
      // A confidential one does, and the reviewer sees it -- confidential
      // means "not disclosed beyond the review", not "withheld from the
      // person doing the review".
      reporter: r.reporting_mode === "anonymous" ? null
        : { user_id: r.reporter_user_id, name: r.reporter_name, email: r.reporter_email },
      confidential: r.reporting_mode === "confidential",
      incident_date: r.incident_date, incident_time: r.incident_time, location: r.location,
      concern_type: r.concern_type, concern_type_other: r.concern_type_other,
      description: r.description,
      policy_id: r.policy_id, policy_text: r.policy_text,
      witnesses_present: r.witnesses_present, witnesses_text: r.witnesses_text,
      reported_previously: r.reported_previously === true || r.reported_previously === "t",
      reported_previously_detail: r.reported_previously_detail,
      additional_info: r.additional_info, people_text: r.people_text,
      status: r.status,
      assigned_reviewer_user_id: r.assigned_reviewer_user_id,
      assigned_reviewer_name: r.assigned_reviewer_name,
      review_notes: r.review_notes,
      applicable_policy_id: r.applicable_policy_id, applicable_policy_text: r.applicable_policy_text,
      findings: r.findings, corrective_action: r.corrective_action,
      follow_up_required: r.follow_up_required === true || r.follow_up_required === "t",
      follow_up_detail: r.follow_up_detail, resolution: r.resolution,
      closed_at: r.closed_at, closed_by: r.closed_by,
      created_at: r.created_at, updated_at: r.updated_at,
      open: !CLOSED.includes(r.status),
    };
    out.people = await peopleFor(r.id);
    out.involved = out.people.filter((p) => p.relation === "involved");
    out.interviewed = out.people.filter((p) => p.relation === "interviewed");
    out.unconflicted_reviewers = await unconflictedReviewerCount(r.id);
    if (full) {
      out.history = await dbAll("SELECT * FROM concern_report_history WHERE report_id = ? ORDER BY id", [r.id]).catch(() => []);
      out.files = (await dbAll(
        "SELECT id, filename, content_type, caption, kind, added_at, added_by FROM concern_report_files WHERE report_id = ? ORDER BY id",
        [r.id]).catch(() => []));
      out.authorizations = await dbAll(
        "SELECT * FROM concern_report_access WHERE report_id = ? ORDER BY id", [r.id]).catch(() => []);
      out.viewer_is_named = viewer ? (await namedUserIds(r.id)).has(Number(viewer.id)) : false;
    }
    return out;
  }

  // ---------------------------------------------------------------
  // The API
  // ---------------------------------------------------------------

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/concerns")) return false;

    // THE UNAUTHENTICATED PATHS. Listed explicitly rather than inferred, and
    // each one is written to work with no session at all.
    if (pathname === "/api/concerns/public/options" && method === "GET") {
      json(res, 200, await publicOptions());
      return true;
    }
    if (pathname === "/api/concerns/public/submit" && method === "POST") {
      const b = await readBody(req);
      // `user` is deliberately NOT passed through for an anonymous report --
      // submitReport drops it -- but it is passed so that somebody who is
      // signed in and chooses "with my name" on the open page still gets
      // their name on it.
      const r = await submitReport(b, b.reporting_mode === "anonymous" ? null : user, true);
      if (r.error) { json(res, r.status || 400, { error: r.error }); return true; }
      json(res, 201, { ok: true, reference_code: r.reference_code, reporting_mode: r.reporting_mode,
        non_retaliation: NON_RETALIATION });
      return true;
    }
    // Following up on a report using only the code. Returns the STATUS and
    // nothing else -- not the review notes, not the findings, not who is
    // looking at it. Enough to know it is alive, not enough to be a back door
    // into a report somebody found a code for.
    if (pathname === "/api/concerns/public/status" && method === "POST") {
      const b = await readBody(req);
      const code = clean(b.reference_code).toUpperCase();
      const r = code ? await dbGet("SELECT status, created_at, updated_at FROM concern_reports WHERE UPPER(reference_code) = ?", [code]) : null;
      if (!r) { json(res, 404, { error: "No concern matches that reference." }); return true; }
      json(res, 200, { status: r.status, submitted: r.created_at, updated: r.updated_at });
      return true;
    }

    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }
    const actor = user.name || user.email;

    if (pathname === "/api/concerns/options" && method === "GET") {
      json(res, 200, { ...(await publicOptions()), statuses: STATUSES,
        can_review: canReview(user), can_authorize: canAuthorize(user) });
      return true;
    }

    // Raising one from inside the CRM.
    if (pathname === "/api/concerns" && method === "POST") {
      if (!canSubmit(user)) { json(res, 403, { error: "Not permitted." }); return true; }
      const b = await readBody(req);
      const r = await submitReport(b, user, false);
      if (r.error) { json(res, r.status || 400, { error: r.error }); return true; }
      json(res, 201, { ok: true, reference_code: r.reference_code, reporting_mode: r.reporting_mode,
        non_retaliation: NON_RETALIATION });
      return true;
    }

    // THE RESTRICTED CONCERN REVIEW DASHBOARD. Its own list, reachable only
    // with the permission, and filtered report by report so a reviewer named
    // in one never sees that one -- the exclusion is in the SQL, not in the
    // page.
    if (pathname === "/api/concerns" && method === "GET") {
      if (!canReview(user)) { json(res, 403, { error: "Not permitted." }); return true; }
      const rows = await dbAll("SELECT * FROM concern_reports ORDER BY id DESC LIMIT 400").catch(() => []);
      const list = [];
      let hiddenFromYou = 0;
      for (const r of rows) {
        if (await canAccess(user, r.id)) list.push(await shape(r, { viewer: user }));
        else hiddenFromYou++;
      }
      json(res, 200, {
        reports: list,
        counts: {
          open: list.filter((r) => r.open).length,
          unassigned: list.filter((r) => r.open && !r.assigned_reviewer_user_id).length,
          new: list.filter((r) => r.status === "New").length,
          action_required: list.filter((r) => r.status === "Action Required").length,
          // A report with nobody left to review it. Counted so the gap is
          // visible rather than silent.
          no_reviewer: list.filter((r) => r.open && r.unconflicted_reviewers === 0).length,
        },
        // Told, not hidden: somebody should know a report exists that they are
        // not being shown, and why. The count carries no content.
        hidden_from_you: hiddenFromYou,
        statuses: STATUSES, types: REPORT_TYPES,
        can_authorize: canAuthorize(user),
        non_retaliation: NON_RETALIATION,
      });
      return true;
    }

    // Who could be assigned this one. Filtered by the SAME rule the assign
    // endpoint enforces, so the picker can never offer somebody who would be
    // refused -- and, more to the point, so a concern about a supervisor never
    // shows that supervisor as an option.
    if (pathname === "/api/concerns/reviewers" && method === "GET") {
      if (!canReview(user)) { json(res, 403, { error: "Not permitted." }); return true; }
      const reportId = num(query && query.report_id);
      if (!reportId) { json(res, 400, { error: "Which concern?" }); return true; }
      if (!(await canAccess(user, reportId))) { json(res, 403, { error: "Not permitted." }); return true; }
      const named = await namedUserIds(reportId);
      const users = await dbAll("SELECT id, name, email, role, module_access FROM users ORDER BY name").catch(() => []);
      const out = [];
      for (const u of users) {
        if (!canReview(u)) continue;
        if (named.has(Number(u.id)) && !(await hasAuthorization(u, reportId))) continue;
        out.push({ id: u.id, name: u.name, email: u.email });
      }
      json(res, 200, { reviewers: out });
      return true;
    }

    const one = pathname.match(/^\/api\/concerns\/(\d+)$/);
    if (one && method === "GET") {
      const id = Number(one[1]);
      const r = await dbGet("SELECT * FROM concern_reports WHERE id = ?", [id]);
      if (!r) { json(res, 404, { error: "That concern no longer exists." }); return true; }
      if (!(await canAccess(user, id))) {
        // The refusal says WHY when the reason is the exclusion, because
        // "not permitted" to somebody named in a report reads as a bug. It
        // still says nothing about the report.
        const named = await isNamed(user, id);
        json(res, 403, { error: named
          ? "You are named in this concern, so it is not available to you. Executive leadership can authorize access where there is a reason to."
          : "Not permitted." });
        // An attempt by a named person is worth recording even though it was
        // refused -- especially then.
        if (named) await log(id, { action: "access_refused", note: "Named in this report", actor_id: user.id, actor_name: actor });
        return true;
      }
      // EVERY READ IS RECORDED. "Who accessed this" is one of the things the
      // audit trail is for, and a log that only captures writes cannot answer
      // it.
      await log(id, { action: "accessed", actor_id: user.id, actor_name: actor });
      json(res, 200, await shape(r, { full: true, viewer: user }));
      return true;
    }

    return reviewApi(req, res, pathname, method, query, user, actor);
  }

  async function publicOptions() {
    return {
      types: REPORT_TYPES, witness_answers: WITNESS_ANSWERS,
      intro: INTRO, non_retaliation: NON_RETALIATION, not_an_accusation: NOT_AN_ACCUSATION,
      // The staff picker. Names only -- no addresses, no ids beyond what the
      // form needs -- because this list is served to an unauthenticated page.
      staff: (await dbAll(
        "SELECT id, name FROM hr_employees WHERE COALESCE(status,'active') <> 'terminated' AND name IS NOT NULL ORDER BY name"
      ).catch(() => [])).map((e) => ({ employee_id: e.id, name: e.name })),
      modes: [
        { key: "named", label: "Submit with my name",
          detail: "Your name is on the report and may be part of the review." },
        { key: "confidential", label: "Submit confidentially",
          detail: "Your name is recorded and visible only to the people reviewing concerns. It is not shared more widely." },
        { key: "anonymous", label: "Submit anonymously",
          detail: "Nothing identifying you is recorded at all. You get a reference code to follow it up — keep it, because it cannot be re-issued." },
      ],
    };
  }

  // ---------------------------------------------------------------
  // Reviewing
  // ---------------------------------------------------------------
  async function reviewApi(req, res, pathname, method, query, user, actor) {
    // Everything below acts on one report, so the access check is done once,
    // here, rather than repeated at each endpoint where it could be forgotten.
    const m = pathname.match(/^\/api\/concerns\/(\d+)\/([a-z-]+)$/);
    if (!m) { json(res, 404, { error: "Unknown endpoint." }); return true; }
    const id = Number(m[1]);
    const action = m[2];
    const before = await dbGet("SELECT * FROM concern_reports WHERE id = ?", [id]);
    if (!before) { json(res, 404, { error: "That concern no longer exists." }); return true; }

    // Authorizing a named person is the one act somebody who CANNOT access the
    // report may need to perform on it, so it is handled before the gate.
    if (action === "authorize" && method === "POST") {
      if (!canAuthorize(user)) {
        json(res, 403, { error: "Only executive leadership can authorize access to a concern." }); return true;
      }
      // A person named in the report cannot be the one who decides who gets to
      // read it. Otherwise the exclusion is a formality: name yourself,
      // authorize yourself, read it.
      if (await isNamed(user, id)) {
        json(res, 403, { error: "You are named in this concern, so you cannot decide who may access it." }); return true;
      }
      const b = await readBody(req);
      const target = num(b.user_id);
      if (!target) { json(res, 400, { error: "Name the person being authorized." }); return true; }
      if (!clean(b.reason)) { json(res, 400, { error: "Say why this person needs access — that is the record." }); return true; }
      const tu = await dbGet("SELECT id, name FROM users WHERE id = ?", [target]);
      if (!tu) { json(res, 404, { error: "No such user." }); return true; }
      await dbRun(
        `INSERT INTO concern_report_access (report_id, user_id, reason, authorized_by, authorized_by_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (report_id, user_id) DO UPDATE SET reason = EXCLUDED.reason,
           authorized_by = EXCLUDED.authorized_by, authorized_by_id = EXCLUDED.authorized_by_id,
           created_at = EXCLUDED.created_at, revoked_at = NULL, revoked_by = NULL`,
        [id, target, clean(b.reason), actor, user.id, nowISO()]);
      await log(id, { action: "access_authorized",
        note: `${tu.name || ("user " + target)} — ${clean(b.reason)}`, actor_id: user.id, actor_name: actor });
      json(res, 200, { ok: true });
      return true;
    }
    if (action === "authorize" && method === "DELETE") {
      if (!canAuthorize(user)) { json(res, 403, { error: "Not permitted." }); return true; }
      if (await isNamed(user, id)) { json(res, 403, { error: "You are named in this concern." }); return true; }
      const b = await readBody(req);
      const target = num(b.user_id);
      if (!target) { json(res, 400, { error: "Name the person." }); return true; }
      await dbRun("UPDATE concern_report_access SET revoked_at = ?, revoked_by = ? WHERE report_id = ? AND user_id = ? AND revoked_at IS NULL",
        [nowISO(), actor, id, target]);
      await log(id, { action: "access_revoked", note: `user ${target}`, actor_id: user.id, actor_name: actor });
      json(res, 200, { ok: true });
      return true;
    }

    if (!(await canAccess(user, id))) {
      const named = await isNamed(user, id);
      if (named) await log(id, { action: "access_refused", note: "Named in this report", actor_id: user.id, actor_name: actor });
      json(res, 403, { error: named
        ? "You are named in this concern, so it is not available to you."
        : "Not permitted." });
      return true;
    }

    if (action === "assign" && method === "POST") {
      const b = await readBody(req);
      const target = num(b.user_id);
      if (!target) { json(res, 400, { error: "Choose a reviewer." }); return true; }
      const tu = await dbGet("SELECT id, name, email, role, module_access FROM users WHERE id = ?", [target]);
      if (!tu) { json(res, 404, { error: "No such user." }); return true; }
      if (!canReview(tu)) {
        json(res, 400, { error: "That person does not have permission to review concerns." }); return true;
      }
      // THE CENTRAL ROUTING RULE. A concern about a supervisor cannot be
      // handed to that supervisor, however it is attempted -- the dashboard
      // will not offer them, and this refuses them if the call is made
      // directly.
      if ((await namedUserIds(id)).has(target) && !(await hasAuthorization(tu, id))) {
        json(res, 400, { error: "That person is named in this concern and cannot review it." }); return true;
      }
      await dbRun("UPDATE concern_reports SET assigned_reviewer_user_id = ?, assigned_reviewer_name = ?, updated_at = ? WHERE id = ?",
        [target, tu.name || null, nowISO(), id]);
      await log(id, { action: "assigned", note: tu.name || ("user " + target), actor_id: user.id, actor_name: actor });
      json(res, 200, await shape(await dbGet("SELECT * FROM concern_reports WHERE id = ?", [id]), { full: true, viewer: user }));
      return true;
    }

    if (action === "status" && method === "POST") {
      const b = await readBody(req);
      if (!STATUSES.includes(clean(b.status))) { json(res, 400, { error: "That is not a review status." }); return true; }
      const next = clean(b.status);
      // Closing a concern says the review is finished, so it has to say what
      // the finish was. A report closed with a blank resolution is a report
      // nobody can account for later.
      if (CLOSED.includes(next) && !clean(b.resolution) && !clean(before.resolution)) {
        json(res, 400, { error: "Write the resolution before closing — what was concluded, and what happened." }); return true;
      }
      const closing = CLOSED.includes(next) && !CLOSED.includes(before.status);
      await dbRun(
        `UPDATE concern_reports SET status = ?, resolution = COALESCE(?, resolution),
           closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?`,
        [next, clean(b.resolution) || null,
         closing ? nowISO() : (CLOSED.includes(next) ? before.closed_at : null),
         closing ? actor : (CLOSED.includes(next) ? before.closed_by : null),
         nowISO(), id]);
      await log(id, { action: "status_change", from_status: before.status, to_status: next,
        note: clean(b.note) || null, actor_id: user.id, actor_name: actor });
      json(res, 200, await shape(await dbGet("SELECT * FROM concern_reports WHERE id = ?", [id]), { full: true, viewer: user }));
      return true;
    }

    // The reviewer's record: notes, the policy it turns on, findings,
    // corrective action, follow-up, resolution.
    if (action === "review" && method === "PATCH") {
      const b = await readBody(req);
      const sets = [], args = [], changed = [];
      const put = (c, v, label) => { sets.push(`${c} = ?`); args.push(v); if (label) changed.push(label); };
      if (b.review_notes !== undefined) put("review_notes", clean(b.review_notes) || null, "review notes");
      if (b.applicable_policy_id !== undefined) put("applicable_policy_id", num(b.applicable_policy_id), "applicable policy");
      if (b.applicable_policy_text !== undefined) put("applicable_policy_text", clean(b.applicable_policy_text) || null, "applicable policy");
      if (b.findings !== undefined) put("findings", clean(b.findings) || null, "findings");
      if (b.corrective_action !== undefined) put("corrective_action", clean(b.corrective_action) || null, "corrective action");
      if (b.follow_up_required !== undefined) put("follow_up_required", b.follow_up_required === true, "follow-up requirement");
      if (b.follow_up_detail !== undefined) put("follow_up_detail", clean(b.follow_up_detail) || null, "follow-up");
      if (b.resolution !== undefined) put("resolution", clean(b.resolution) || null, "resolution");
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      put("updated_at", nowISO());
      await dbRun(`UPDATE concern_reports SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
      await log(id, { action: "review_updated", note: changed.join(", ") || null, actor_id: user.id, actor_name: actor });
      json(res, 200, await shape(await dbGet("SELECT * FROM concern_reports WHERE id = ?", [id]), { full: true, viewer: user }));
      return true;
    }

    // People spoken to during the review. Stored in the same table as the
    // people named by the reporter, because both are people the report
    // touches -- and somebody interviewed about a concern should not then be
    // able to read it either.
    if (action === "interviews" && method === "POST") {
      const b = await readBody(req);
      const empId = num(b.employee_id);
      let userId = num(b.user_id);
      let name = clean(b.name);
      if (empId) {
        const emp = await dbGet("SELECT id, name, email, user_id FROM hr_employees WHERE id = ?", [empId]).catch(() => null);
        if (emp) {
          name = name || emp.name;
          if (!userId) {
            userId = num(emp.user_id);
            if (!userId && clean(emp.email)) {
              const u = await dbGet("SELECT id FROM users WHERE LOWER(TRIM(email)) = ?", [clean(emp.email).toLowerCase()]).catch(() => null);
              userId = u ? u.id : null;
            }
          }
        }
      }
      if (!name && !empId && !userId) { json(res, 400, { error: "Name the person who was interviewed." }); return true; }
      await dbRun(
        `INSERT INTO concern_report_people (report_id, employee_id, user_id, name, relation, note, added_at, added_by)
         VALUES (?, ?, ?, ?, 'interviewed', ?, ?, ?)`,
        [id, empId, userId, name || null, clean(b.note) || null, nowISO(), actor]);
      await log(id, { action: "interview_recorded", note: name || ("employee " + empId), actor_id: user.id, actor_name: actor });
      json(res, 200, await shape(await dbGet("SELECT * FROM concern_reports WHERE id = ?", [id]), { full: true, viewer: user }));
      return true;
    }

    if (action === "files" && method === "POST") {
      const b = await readBody(req);
      if (!clean(b.data_base64)) { json(res, 400, { error: "No file provided." }); return true; }
      await dbRun(
        `INSERT INTO concern_report_files (report_id, filename, content_type, data_base64, caption, kind, added_at, added_by)
         VALUES (?, ?, ?, ?, ?, 'evidence', ?, ?)`,
        [id, clean(b.filename) || "evidence", clean(b.content_type) || null,
         String(b.data_base64).slice(0, 8_000_000), clean(b.caption) || null, nowISO(), actor]);
      await log(id, { action: "evidence_added", note: clean(b.filename) || null, actor_id: user.id, actor_name: actor });
      json(res, 200, await shape(await dbGet("SELECT * FROM concern_reports WHERE id = ?", [id]), { full: true, viewer: user }));
      return true;
    }

    json(res, 404, { error: "Unknown endpoint." });
    return true;
  }

  // The unauthenticated page. Served with no session, like the supply and
  // maintenance request pages it is modelled on.
  function servePage(req, res, pathname) {
    if (pathname === "/report-concern" || pathname === "/report-concern/") {
      const file = path.join(__dirname, "report-concern.html");
      if (fs.existsSync(file)) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          // Not indexed and not cached by a shared proxy. A concern form is
          // not secret, but a search engine listing for it is noise at best
          // and a signpost at worst.
          "X-Robots-Tag": "noindex, nofollow",
          "Cache-Control": "no-store",
        });
        res.end(fs.readFileSync(file, "utf8"));
        return true;
      }
    }
    return false;
  }

  // Exposed for the Message Outbox, which shows the whole notifications_log
  // to every admin. Concern alerts must not appear there for somebody who
  // cannot read concerns -- the fact that one was raised, and when, is itself
  // the thing being protected.
  const canSeeConcernMail = (u) => canReview(u);

  return { initTables, handleApi, servePage, canSeeConcernMail, _internal: {
    REPORT_TYPES, STATUSES, CLOSED, MODES, WITNESS_ANSWERS, INTRO, NON_RETALIATION, NOT_AN_ACCUSATION,
    canReview, canAuthorize, canSubmit, canAccess, isNamed, hasAuthorization, namedUserIds,
    log, referenceCode, clean, num, parseJson, esc,
    submitReport, notifyReviewers, unconflictedReviewerCount, shape, peopleFor, publicOptions,
    reviewApi,
  } };
};
