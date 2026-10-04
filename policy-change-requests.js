// Policy change requests, and the exceptions that are made to policies.
//
// Two features in one module because they are two answers to the same
// question -- "the rule does not fit this situation" -- and keeping them apart
// would mean two audit trails that have to be read together to understand what
// happened to a policy.
//
//   A CHANGE REQUEST asks for the rule itself to be different, and goes to the
//   monthly review. Submitting one changes NOTHING: the policy in force stays
//   in force until an approved revision is published, which is the single most
//   important property here. A request that quietly altered the rule would
//   make the review meaningless.
//
//   AN EXCEPTION leaves the rule alone and departs from it once, on the
//   record. The point is not to stop leadership exercising discretion. It is
//   to stop discretion being INVISIBLE -- so that what was allowed, for whom,
//   by whom, why, and for how long is a row somebody can read later, rather
//   than something everyone half-remembers differently.
"use strict";

module.exports = function initPolicyChangeRequests(ctx) {
  const { dbGet, dbAll, dbRun, sendEmail, nowISO, readBody, json } = ctx;

  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  const role = (u) => (u && u.role) || "";
  // Anyone signed in may ASK for a policy to change. That is the point of the
  // feature: the alternative is the corridor conversation it replaces.
  const canSubmit = (u) => !!u && !!u.id;
  // Running the review queue -- assigning, asking for more, deferring.
  const canReview = (u) => !!u && (["owner", "super_admin", "admin", "hr_admin"].includes(role(u)) || granted(u, "policy_review"));
  // DECIDING is narrower than reviewing, and deliberately so. The spec asks for
  // final approval to rest with executive leadership, and "admin" in this CRM
  // is an operational tier that a manager can hold.
  const canDecide = (u) => !!u && (["owner", "super_admin"].includes(role(u)) || granted(u, "policy_decide"));
  // Emergency changes bypass the monthly cycle, so the authority to start one
  // is the narrowest in the module.
  const canEmergency = (u) => !!u && (["owner", "super_admin"].includes(role(u)) || granted(u, "policy_emergency"));
  // Authorising an exception, and approving the ones that need it.
  const canException = (u) => !!u && (["owner", "super_admin", "admin", "hr_admin"].includes(role(u)) || granted(u, "policy_exception"));
  const canExecApprove = (u) => !!u && (["owner", "super_admin"].includes(role(u)) || granted(u, "policy_decide"));

  const REQUEST_TYPES = [
    { key: "create", label: "Create New Policy" },
    { key: "modify", label: "Modify Existing Policy" },
    { key: "discontinue", label: "Discontinue Policy" },
  ];
  const STATUSES = [
    "Submitted", "Pending Monthly Review", "Under Review", "Additional Information Requested",
    "Approved", "Approved With Modification", "Deferred", "Declined", "Implemented",
  ];
  // The ones that mean a decision has been made. Used to decide what still
  // belongs in the review queue.
  const DECIDED = ["Approved", "Approved With Modification", "Declined", "Implemented"];
  const DECISIONS = ["Approve", "Approve With Modification", "Defer", "Decline"];
  const DECISION_STATUS = {
    Approve: "Approved",
    "Approve With Modification": "Approved With Modification",
    Defer: "Deferred",
    Decline: "Declined",
  };
  const IMPACT_AREAS = ["Clients", "Families", "Staff", "Clinical Operations", "Scheduling",
    "Compliance", "Billing", "Financial Operations", "Other"];
  // Named grounds rather than a free-text box. An emergency route with no
  // friction becomes the normal route, and the monthly cycle quietly stops
  // existing; making somebody pick one of these is the friction.
  const EMERGENCY_GROUNDS = ["Safety", "Compliance", "Payer requirement", "Legal or regulatory", "Urgent business operations"];
  const EXCEPTION_STATUSES = ["Active", "Expired", "Revoked"];

  const clean = (s) => String(s == null ? "" : s).trim();
  const parseJson = (s, f) => { try { return s ? JSON.parse(s) : f; } catch (e) { return f; } };
  const today = () => nowISO().slice(0, 10);
  const addDays = (iso, n) => {
    const d = new Date(String(iso).slice(0, 10) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // Which monthly review a request belongs to. Stamped on submission so a
  // request cannot drift between cycles while nobody is looking.
  // Every id that arrives in a request BODY goes through this. A non-numeric
  // one otherwise reaches Postgres as NaN, which does not throw a handled
  // error -- it rejects outside the dispatch chain and takes the process with
  // it. Returns null rather than NaN so the caller can answer 400.
  const num = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const escapeHtml = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const cycleFor = (iso) => String(iso || nowISO()).slice(0, 7);

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS policy_change_requests (
      id SERIAL PRIMARY KEY,
      requester_name TEXT,
      requester_email TEXT,
      department TEXT,
      requester_role TEXT,
      policy_id INTEGER,                   -- NULL when asking for a NEW policy
      proposed_title TEXT,                 -- what the new policy would be called
      request_type TEXT NOT NULL,          -- create | modify | discontinue
      requested_change TEXT,
      reason TEXT,
      problem_solved TEXT,
      proposed_solution TEXT,
      impact_areas TEXT,                   -- JSON array
      impact_other TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Monthly Review',
      review_cycle TEXT,                   -- YYYY-MM, stamped on submission
      assigned_reviewer TEXT,
      decision TEXT,                       -- Approve | Approve With Modification | Defer | Decline
      decision_notes TEXT,                 -- REQUIRED with a decision
      decision_date TEXT,
      decided_by TEXT,
      effective_date TEXT,
      resulting_policy_id INTEGER,         -- the revision that was published
      requires_acknowledgment BOOLEAN DEFAULT FALSE,
      requires_training BOOLEAN DEFAULT FALSE,
      training_note TEXT,
      is_emergency BOOLEAN DEFAULT FALSE,
      emergency_grounds TEXT,
      emergency_reason TEXT,
      emergency_by TEXT,
      emergency_at TEXT,
      implemented_at TEXT,
      implemented_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("policy_change_requests initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_pcr_status ON policy_change_requests(status)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_pcr_cycle ON policy_change_requests(review_cycle)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_pcr_email ON policy_change_requests(requester_email)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS policy_change_request_history (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      actor_id INTEGER,
      actor_name TEXT,
      created_at TEXT NOT NULL
    )`).catch((e) => console.error("policy_change_request_history initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_pcr_hist ON policy_change_request_history(request_id, id)`).catch(() => {});

    // Attachments reuse the policy document store rather than starting a
    // second file pipeline beside the first.
    await dbRun(`CREATE TABLE IF NOT EXISTS policy_change_request_documents (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      document_id INTEGER NOT NULL,
      added_by TEXT,
      added_at TEXT,
      UNIQUE (request_id, document_id)
    )`).catch((e) => console.error("policy_change_request_documents initTables:", e.message));

    // ---- exceptions ----------------------------------------------------
    await dbRun(`CREATE TABLE IF NOT EXISTS policy_exceptions (
      id SERIAL PRIMARY KEY,
      policy_id INTEGER NOT NULL,
      scope_type TEXT DEFAULT 'employees',   -- employees | situation
      employee_ids TEXT,                     -- JSON array of hr_employees.id
      employee_names TEXT,                   -- JSON array, kept so the record reads
                                             -- correctly after somebody leaves
      situation TEXT,
      reason TEXT NOT NULL,
      authorized_by TEXT NOT NULL,
      authorized_at TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,                         -- NULL = no end date set
      status TEXT NOT NULL DEFAULT 'Active',
      executive_approval_required BOOLEAN DEFAULT FALSE,
      executive_approved_by TEXT,
      executive_approved_at TEXT,
      revoked_by TEXT,
      revoked_at TEXT,
      revoke_reason TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("policy_exceptions initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_pex_policy ON policy_exceptions(policy_id)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_pex_status ON policy_exceptions(status)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS policy_exception_documents (
      id SERIAL PRIMARY KEY,
      exception_id INTEGER NOT NULL,
      document_id INTEGER NOT NULL,
      added_by TEXT,
      added_at TEXT,
      UNIQUE (exception_id, document_id)
    )`).catch((e) => console.error("policy_exception_documents initTables:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS policy_exception_history (
      id SERIAL PRIMARY KEY,
      exception_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      note TEXT,
      actor_id INTEGER,
      actor_name TEXT,
      created_at TEXT NOT NULL
    )`).catch((e) => console.error("policy_exception_history initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_pex_hist ON policy_exception_history(exception_id, id)`).catch(() => {});
  }

  async function logRequest(id, entry) {
    await dbRun(
      `INSERT INTO policy_change_request_history (request_id, action, from_status, to_status, note, actor_id, actor_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, entry.action, entry.from_status || null, entry.to_status || null, entry.note || null,
       entry.actor_id || null, entry.actor_name || null, nowISO()]
    ).catch((e) => console.error("pcr history:", e.message));
  }
  async function logException(id, entry) {
    await dbRun(
      `INSERT INTO policy_exception_history (exception_id, action, note, actor_id, actor_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, entry.action, entry.note || null, entry.actor_id || null, entry.actor_name || null, nowISO()]
    ).catch((e) => console.error("pex history:", e.message));
  }

  // An exception with an end date in the past is no longer in force, whether or
  // not anybody has opened the page. Computed on read rather than written by a
  // sweep, so "expired" cannot be wrong because a job did not run.
  function effectiveStatus(row) {
    if (row.status === "Revoked") return "Revoked";
    if (row.end_date && String(row.end_date).slice(0, 10) < today()) return "Expired";
    return row.status || "Active";
  }

  async function shapeRequest(id, full) {
    const r = await dbGet("SELECT * FROM policy_change_requests WHERE id = ?", [id]);
    if (!r) return null;
    const pol = r.policy_id ? await dbGet("SELECT id, title, doc_kind, doc_number FROM crm_policies WHERE id = ?", [r.policy_id]).catch(() => null) : null;
    const out = {
      id: r.id, requester_name: r.requester_name, requester_email: r.requester_email,
      department: r.department, requester_role: r.requester_role,
      policy: pol ? { id: pol.id, title: pol.title, kind: pol.doc_kind || "policy", doc_number: pol.doc_number } : null,
      proposed_title: r.proposed_title, request_type: r.request_type,
      requested_change: r.requested_change, reason: r.reason, problem_solved: r.problem_solved,
      proposed_solution: r.proposed_solution,
      impact_areas: parseJson(r.impact_areas, []), impact_other: r.impact_other,
      status: r.status, review_cycle: r.review_cycle, assigned_reviewer: r.assigned_reviewer,
      decision: r.decision, decision_notes: r.decision_notes, decision_date: r.decision_date, decided_by: r.decided_by,
      effective_date: r.effective_date, resulting_policy_id: r.resulting_policy_id,
      requires_acknowledgment: r.requires_acknowledgment === true || r.requires_acknowledgment === "t",
      requires_training: r.requires_training === true || r.requires_training === "t",
      training_note: r.training_note,
      is_emergency: r.is_emergency === true || r.is_emergency === "t",
      emergency_grounds: r.emergency_grounds, emergency_reason: r.emergency_reason,
      emergency_by: r.emergency_by, emergency_at: r.emergency_at,
      implemented_at: r.implemented_at, implemented_by: r.implemented_by,
      created_at: r.created_at, updated_at: r.updated_at,
      awaiting_review: !DECIDED.includes(r.status),
    };
    if (full) {
      out.history = await dbAll("SELECT * FROM policy_change_request_history WHERE request_id = ? ORDER BY id", [id]).catch(() => []);
      out.documents = await dbAll(
        `SELECT d.id, d.title, d.filename FROM policy_change_request_documents a
           JOIN crm_policy_documents d ON d.id = a.document_id WHERE a.request_id = ?`, [id]).catch(() => []);
    }
    return out;
  }

  async function shapeException(row, full) {
    const pol = await dbGet("SELECT id, title, doc_kind, doc_number FROM crm_policies WHERE id = ?", [row.policy_id]).catch(() => null);
    const out = {
      id: row.id,
      policy: pol ? { id: pol.id, title: pol.title, kind: pol.doc_kind || "policy", doc_number: pol.doc_number } : null,
      scope_type: row.scope_type, employee_ids: parseJson(row.employee_ids, []),
      employee_names: parseJson(row.employee_names, []), situation: row.situation,
      reason: row.reason, authorized_by: row.authorized_by, authorized_at: row.authorized_at,
      start_date: row.start_date, end_date: row.end_date,
      status: effectiveStatus(row), stored_status: row.status,
      // A permanent exception is a policy by another name. Surfaced so the
      // review queue can show which ones nobody ever set an end date on.
      open_ended: !row.end_date,
      executive_approval_required: row.executive_approval_required === true || row.executive_approval_required === "t",
      executive_approved_by: row.executive_approved_by, executive_approved_at: row.executive_approved_at,
      revoked_by: row.revoked_by, revoked_at: row.revoked_at, revoke_reason: row.revoke_reason,
      created_at: row.created_at, updated_at: row.updated_at,
    };
    if (full) {
      out.history = await dbAll("SELECT * FROM policy_exception_history WHERE exception_id = ? ORDER BY id", [row.id]).catch(() => []);
      out.documents = await dbAll(
        `SELECT d.id, d.title, d.filename FROM policy_exception_documents a
           JOIN crm_policy_documents d ON d.id = a.document_id WHERE a.exception_id = ?`, [row.id]).catch(() => []);
    }
    return out;
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/policy-changes") && !pathname.startsWith("/api/policy-exceptions")) return false;
    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }

    const actor = user.name || user.email;

    // ================= change requests =================
    if (pathname === "/api/policy-changes/options" && method === "GET") {
      const policies = await dbAll(
        "SELECT id, title, doc_kind, doc_number FROM crm_policies WHERE COALESCE(status,'Active') <> 'Archived' ORDER BY title"
      ).catch(() => []);
      json(res, 200, {
        request_types: REQUEST_TYPES, statuses: STATUSES, decisions: DECISIONS,
        impact_areas: IMPACT_AREAS, emergency_grounds: EMERGENCY_GROUNDS,
        policies: policies.map((p) => ({ id: p.id, title: p.title, kind: p.doc_kind || "policy", doc_number: p.doc_number })),
        can_review: canReview(user), can_decide: canDecide(user), can_emergency: canEmergency(user),
      });
      return true;
    }

    if (pathname === "/api/policy-changes" && method === "POST") {
      if (!canSubmit(user)) { json(res, 403, { error: "Not permitted." }); return true; }
      const b = await readBody(req);
      const type = clean(b.request_type);
      if (!REQUEST_TYPES.some((t) => t.key === type)) {
        json(res, 400, { error: "Say whether you are asking to create, modify or discontinue a policy." }); return true;
      }
      const polId = num(b.policy_id);
      if (type !== "create" && !polId) {
        json(res, 400, { error: "Choose the policy this is about." }); return true;
      }
      if (type === "create" && !clean(b.proposed_title)) {
        json(res, 400, { error: "Give the policy you are proposing a name." }); return true;
      }
      if (!clean(b.requested_change)) { json(res, 400, { error: "Describe the change you are asking for." }); return true; }
      if (!clean(b.reason)) { json(res, 400, { error: "Say why — a request with no reason cannot be reviewed." }); return true; }

      // An emergency is NOT something a requester can declare. It is started by
      // executive leadership, on named grounds, and it is a separate act from
      // raising a request -- so a form cannot smuggle one through.
      const now = nowISO();
      const row = await dbGet(
        `INSERT INTO policy_change_requests
           (requester_name, requester_email, department, requester_role, policy_id, proposed_title,
            request_type, requested_change, reason, problem_solved, proposed_solution,
            impact_areas, impact_other, status, review_cycle, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending Monthly Review', ?, ?, ?) RETURNING *`,
        [clean(b.requester_name) || user.name || null, clean(b.requester_email) || user.email || null,
         clean(b.department) || null, clean(b.requester_role) || null,
         type === "create" ? null : polId, clean(b.proposed_title) || null,
         type, clean(b.requested_change), clean(b.reason), clean(b.problem_solved) || null,
         clean(b.proposed_solution) || null,
         JSON.stringify((Array.isArray(b.impact_areas) ? b.impact_areas : []).filter((x) => IMPACT_AREAS.includes(x))),
         clean(b.impact_other) || null, cycleFor(now), now, now]
      );
      await logRequest(row.id, { action: "submitted", to_status: "Pending Monthly Review",
        note: `Queued for the ${cycleFor(now)} review`, actor_id: user.id, actor_name: actor });
      json(res, 201, await shapeRequest(row.id, true));
      return true;
    }

    if (pathname === "/api/policy-changes" && method === "GET") {
      const review = canReview(user);
      const myEmail = clean(user.email).toLowerCase();
      // Somebody who cannot review sees the requests they raised. Everyone can
      // ASK, so everyone can see what came of their own asking.
      const where = review ? "" : " WHERE lower(trim(requester_email)) = ?";
      const args = review ? [] : [myEmail];
      const rows = await dbAll(`SELECT * FROM policy_change_requests${where} ORDER BY id DESC LIMIT 400`, args).catch(() => []);
      const list = [];
      for (const r of rows) list.push(await shapeRequest(r.id, false));
      const counts = {
        awaiting: list.filter((r) => r.awaiting_review).length,
        this_cycle: list.filter((r) => r.awaiting_review && r.review_cycle === cycleFor()).length,
        emergency: list.filter((r) => r.is_emergency && r.awaiting_review).length,
        approved_not_implemented: list.filter((r) => /^Approved/.test(r.status)).length,
      };
      json(res, 200, { requests: list, counts, cycle: cycleFor(),
        can_review: review, can_decide: canDecide(user), can_emergency: canEmergency(user),
        statuses: STATUSES, decisions: DECISIONS });
      return true;
    }

    const oneReq = pathname.match(/^\/api\/policy-changes\/(\d+)$/);
    if (oneReq && method === "GET") {
      const id = Number(oneReq[1]);
      const r = await dbGet("SELECT * FROM policy_change_requests WHERE id = ?", [id]);
      if (!r) { json(res, 404, { error: "That request no longer exists." }); return true; }
      const mine = clean(r.requester_email).toLowerCase() === clean(user.email).toLowerCase();
      if (!canReview(user) && !mine) { json(res, 403, { error: "Not permitted." }); return true; }
      json(res, 200, await shapeRequest(id, true));
      return true;
    }

    // Assigning a reviewer, asking for more, moving it along -- everything
    // short of deciding it.
    if (oneReq && method === "PATCH") {
      if (!canReview(user)) { json(res, 403, { error: "Only a policy reviewer can update a request." }); return true; }
      const id = Number(oneReq[1]);
      const before = await dbGet("SELECT * FROM policy_change_requests WHERE id = ?", [id]);
      if (!before) { json(res, 404, { error: "That request no longer exists." }); return true; }
      const b = await readBody(req);
      const sets = [], args = [];
      const put = (c, v) => { sets.push(`${c} = ?`); args.push(v); };
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) { json(res, 400, { error: "That is not a request status." }); return true; }
        // A DECISION IS NOT A STATUS EDIT. Routing it through the decide
        // endpoint is what guarantees a written response exists and that the
        // person setting it is allowed to decide, not merely to review.
        if (DECIDED.includes(b.status) && !DECIDED.includes(before.status)) {
          json(res, 400, { error: "Record the decision instead — an approval needs a written response." }); return true;
        }
        put("status", b.status);
        // Putting something back into the queue re-stamps the cycle. Without
        // this a deferred request keeps the cycle it was first raised in, so
        // it never appears in a later month's list and quietly stops being
        // reviewed -- which is the one thing a deferral is not supposed to
        // mean.
        if (b.status === "Pending Monthly Review" && before.status !== "Pending Monthly Review") {
          put("review_cycle", cycleFor());
        }
      }
      if (b.assigned_reviewer !== undefined) put("assigned_reviewer", clean(b.assigned_reviewer) || null);
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      put("updated_at", nowISO());
      await dbRun(`UPDATE policy_change_requests SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
      if (b.status !== undefined && b.status !== before.status) {
        await logRequest(id, { action: "status_change", from_status: before.status, to_status: b.status,
          note: clean(b.note) || null, actor_id: user.id, actor_name: actor });
      }
      if (b.assigned_reviewer !== undefined && clean(b.assigned_reviewer) !== clean(before.assigned_reviewer)) {
        await logRequest(id, { action: "assigned", note: clean(b.assigned_reviewer) || "Unassigned", actor_id: user.id, actor_name: actor });
      }
      json(res, 200, await shapeRequest(id, true));
      return true;
    }

    const decideM = pathname.match(/^\/api\/policy-changes\/(\d+)\/decide$/);
    if (decideM && method === "POST") {
      if (!canDecide(user)) { json(res, 403, { error: "Only executive leadership can decide a policy change." }); return true; }
      const id = Number(decideM[1]);
      const before = await dbGet("SELECT * FROM policy_change_requests WHERE id = ?", [id]);
      if (!before) { json(res, 404, { error: "That request no longer exists." }); return true; }
      const b = await readBody(req);
      if (!DECISIONS.includes(clean(b.decision))) { json(res, 400, { error: "Choose approve, approve with modification, defer or decline." }); return true; }
      // The written response is the whole point of recording a decision. A
      // decision with no reasoning is the corridor conversation again.
      if (!clean(b.decision_notes)) { json(res, 400, { error: "Write the decision response — what was decided, and why." }); return true; }
      const status = DECISION_STATUS[clean(b.decision)];
      await dbRun(
        `UPDATE policy_change_requests SET decision = ?, decision_notes = ?, decision_date = ?, decided_by = ?,
           status = ?, effective_date = ?, resulting_policy_id = ?, requires_acknowledgment = ?,
           requires_training = ?, training_note = ?, updated_at = ? WHERE id = ?`,
        [clean(b.decision), clean(b.decision_notes), clean(b.decision_date) || today(), actor, status,
         clean(b.effective_date) || null, num(b.resulting_policy_id),
         b.requires_acknowledgment === true, b.requires_training === true, clean(b.training_note) || null,
         nowISO(), id]
      );
      await logRequest(id, { action: "decided", from_status: before.status, to_status: status,
        note: `${clean(b.decision)} — ${clean(b.decision_notes)}`, actor_id: user.id, actor_name: actor });

      // The person who asked gets told. A review they never hear back from is
      // the corridor conversation with extra steps -- and the written response
      // this endpoint insists on is exactly what they are owed.
      if (clean(before.requester_email)) {
        try {
          await sendEmail({
            to: clean(before.requester_email),
            subject: `Policy change request ${status.toLowerCase()} — ${clean(before.proposed_title) || "your request"}`,
            html: `<p>Your policy change request has been reviewed.</p>
              <ul><li><b>Decision:</b> ${escapeHtml(clean(b.decision))}</li>
              <li><b>Response:</b> ${escapeHtml(clean(b.decision_notes))}</li>
              ${clean(b.effective_date) ? `<li><b>Effective:</b> ${escapeHtml(clean(b.effective_date))}</li>` : ""}</ul>
              ${/^Approved/.test(status)
                ? "<p>The approved change takes effect when the revised policy is published. Until then the current policy still applies.</p>"
                : "<p>The current policy is unchanged.</p>"}
              <p>Open the CRM → Requests &amp; Reports → Policy Change Requests to see the full record.</p>`,
            type: "policy_change_decision",
            refType: "policy_change_request", refId: id,
          });
        } catch (e) { /* logged by sendEmail; the decision itself has landed */ }
      }
      json(res, 200, await shapeRequest(id, true));
      return true;
    }

    const implM = pathname.match(/^\/api\/policy-changes\/(\d+)\/implement$/);
    if (implM && method === "POST") {
      if (!canDecide(user)) { json(res, 403, { error: "Not permitted." }); return true; }
      const id = Number(implM[1]);
      const before = await dbGet("SELECT * FROM policy_change_requests WHERE id = ?", [id]);
      if (!before) { json(res, 404, { error: "That request no longer exists." }); return true; }
      // Only something that was APPROVED can be implemented. Marking a declined
      // or undecided request as implemented would say the rule changed when it
      // did not.
      if (!/^Approved/.test(before.status)) {
        json(res, 400, { error: "Only an approved change can be marked implemented." }); return true;
      }
      await dbRun("UPDATE policy_change_requests SET status = 'Implemented', implemented_at = ?, implemented_by = ?, updated_at = ? WHERE id = ?",
        [nowISO(), actor, nowISO(), id]);
      await logRequest(id, { action: "implemented", from_status: before.status, to_status: "Implemented",
        note: clean((await readBody(req).catch(() => ({}))).note) || null, actor_id: user.id, actor_name: actor });
      json(res, 200, await shapeRequest(id, true));
      return true;
    }

    const emergM = pathname.match(/^\/api\/policy-changes\/(\d+)\/emergency$/);
    if (emergM && method === "POST") {
      if (!canEmergency(user)) { json(res, 403, { error: "Only executive leadership can start an emergency policy change." }); return true; }
      const id = Number(emergM[1]);
      const before = await dbGet("SELECT * FROM policy_change_requests WHERE id = ?", [id]);
      if (!before) { json(res, 404, { error: "That request no longer exists." }); return true; }
      const b = await readBody(req);
      if (!EMERGENCY_GROUNDS.includes(clean(b.grounds))) {
        json(res, 400, { error: "Name the grounds: " + EMERGENCY_GROUNDS.join(", ") + "." }); return true;
      }
      if (!clean(b.reason)) { json(res, 400, { error: "Say why this cannot wait for the monthly review." }); return true; }
      await dbRun(
        `UPDATE policy_change_requests SET is_emergency = TRUE, emergency_grounds = ?, emergency_reason = ?,
           emergency_by = ?, emergency_at = ?, status = 'Under Review', updated_at = ? WHERE id = ?`,
        [clean(b.grounds), clean(b.reason), actor, nowISO(), nowISO(), id]);
      // Logged as its OWN action rather than as an ordinary status change, so a
      // later reader can count how often the monthly cycle was bypassed and on
      // what grounds. That number is the point of making this a separate act.
      await logRequest(id, { action: "emergency_declared", from_status: before.status, to_status: "Under Review",
        note: `${clean(b.grounds)}: ${clean(b.reason)}`, actor_id: user.id, actor_name: actor });
      json(res, 200, await shapeRequest(id, true));
      return true;
    }

    // Supporting documentation. The policy document library is reused rather
    // than given a second uploader of its own: a request that cites a document
    // should cite THE document, not a copy of it.
    const docM = pathname.match(/^\/api\/policy-changes\/(\d+)\/documents$/);
    if (docM && (method === "POST" || method === "DELETE")) {
      const id = Number(docM[1]);
      const r = await dbGet("SELECT * FROM policy_change_requests WHERE id = ?", [id]);
      if (!r) { json(res, 404, { error: "That request no longer exists." }); return true; }
      const mine = clean(r.requester_email).toLowerCase() === clean(user.email).toLowerCase();
      // The requester can attach to their own request while it is still open.
      // Once it has been decided the attachments are part of the record of what
      // was decided on, so only a reviewer may change them.
      if (!canReview(user) && !(mine && !DECIDED.includes(r.status))) {
        json(res, 403, { error: "Not permitted." }); return true;
      }
      const b = await readBody(req);
      const docId = num(b.document_id);
      if (!docId) { json(res, 400, { error: "Choose a document from the library." }); return true; }
      if (method === "DELETE") {
        await dbRun("DELETE FROM policy_change_request_documents WHERE request_id = ? AND document_id = ?", [id, docId]);
        await logRequest(id, { action: "document_removed", note: `Document #${docId}`, actor_id: user.id, actor_name: actor });
        json(res, 200, await shapeRequest(id, true)); return true;
      }
      const doc = await dbGet("SELECT id, title FROM crm_policy_documents WHERE id = ?", [docId]);
      if (!doc) { json(res, 404, { error: "That document is not in the library." }); return true; }
      await dbRun(
        `INSERT INTO policy_change_request_documents (request_id, document_id, added_by, added_at)
         VALUES (?, ?, ?, ?) ON CONFLICT (request_id, document_id) DO NOTHING`,
        [id, doc.id, actor, nowISO()]);
      await logRequest(id, { action: "document_added", note: doc.title, actor_id: user.id, actor_name: actor });
      json(res, 200, await shapeRequest(id, true));
      return true;
    }

    return exceptionsApi(req, res, pathname, method, query, user, actor);
  }

  // ================= policy exceptions =================
  //
  // Deliberately NOT an approval workflow. An exception is a record of a
  // decision somebody with authority has already made; making it a request
  // queue would either slow down legitimate discretion or be routed around.
  // What it does insist on is that the row is complete: which policy, who it
  // covers, who said yes, why, and until when.
  async function exceptionsApi(req, res, pathname, method, query, user, actor) {
    if (!pathname.startsWith("/api/policy-exceptions")) {
      json(res, 404, { error: "Unknown endpoint." });
      return true;
    }

    if (pathname === "/api/policy-exceptions" && method === "GET") {
      // An exception is read by anyone who can see policies -- if a rule is not
      // being applied to someone, the people held to it should be able to see
      // that it was decided openly. Writing it is the restricted act.
      const rows = await dbAll("SELECT * FROM policy_exceptions ORDER BY id DESC LIMIT 400").catch(() => []);
      const list = [];
      for (const r of rows) list.push(await shapeException(r, false));
      json(res, 200, {
        exceptions: list,
        counts: {
          active: list.filter((e) => e.status === "Active").length,
          expiring_soon: list.filter((e) => e.status === "Active" && e.end_date &&
            String(e.end_date).slice(0, 10) <= addDays(today(), 30)).length,
          open_ended: list.filter((e) => e.status === "Active" && e.open_ended).length,
          awaiting_exec: list.filter((e) => e.executive_approval_required && !e.executive_approved_at && e.status === "Active").length,
        },
        statuses: EXCEPTION_STATUSES,
        can_write: canException(user), can_exec_approve: canExecApprove(user),
      });
      return true;
    }

    if (pathname === "/api/policy-exceptions" && method === "POST") {
      if (!canException(user)) { json(res, 403, { error: "Only a designated authority can record a policy exception." }); return true; }
      const b = await readBody(req);
      const polId = num(b.policy_id);
      if (!polId) { json(res, 400, { error: "Choose the policy being excepted." }); return true; }
      const pol = await dbGet("SELECT id FROM crm_policies WHERE id = ?", [polId]);
      if (!pol) { json(res, 404, { error: "That policy no longer exists." }); return true; }
      if (!clean(b.reason)) { json(res, 400, { error: "Say why the exception was made — that is the whole record." }); return true; }
      if (!clean(b.authorized_by)) { json(res, 400, { error: "Name the person who authorized it." }); return true; }
      const names = Array.isArray(b.employee_names) ? b.employee_names.map(clean).filter(Boolean) : [];
      const ids = Array.isArray(b.employee_ids) ? b.employee_ids.map(num).filter(Boolean) : [];
      if (!names.length && !ids.length && !clean(b.situation)) {
        json(res, 400, { error: "Say who or what situation this covers." }); return true;
      }
      const now = nowISO();
      const row = await dbGet(
        `INSERT INTO policy_exceptions
           (policy_id, scope_type, employee_ids, employee_names, situation, reason, authorized_by,
            authorized_at, start_date, end_date, status, executive_approval_required,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?) RETURNING *`,
        [polId, ids.length || names.length ? "people" : "situation",
         JSON.stringify(ids), JSON.stringify(names), clean(b.situation) || null,
         clean(b.reason), clean(b.authorized_by), clean(b.authorized_at) || now,
         clean(b.start_date) || today(), clean(b.end_date) || null,
         b.executive_approval_required === true, now, now]);
      await logException(row.id, {
        action: "recorded",
        note: clean(b.end_date) ? `Until ${clean(b.end_date)}` : "No end date set",
        actor_id: user.id, actor_name: actor });
      json(res, 201, await shapeException(row, true));
      return true;
    }

    const oneEx = pathname.match(/^\/api\/policy-exceptions\/(\d+)$/);
    if (oneEx && method === "GET") {
      const row = await dbGet("SELECT * FROM policy_exceptions WHERE id = ?", [Number(oneEx[1])]);
      if (!row) { json(res, 404, { error: "That exception no longer exists." }); return true; }
      json(res, 200, await shapeException(row, true));
      return true;
    }

    if (oneEx && method === "PATCH") {
      if (!canException(user)) { json(res, 403, { error: "Not permitted." }); return true; }
      const id = Number(oneEx[1]);
      const before = await dbGet("SELECT * FROM policy_exceptions WHERE id = ?", [id]);
      if (!before) { json(res, 404, { error: "That exception no longer exists." }); return true; }
      const b = await readBody(req);
      const sets = [], args = [], changed = [];
      const put = (c, v, label) => { sets.push(`${c} = ?`); args.push(v); if (label) changed.push(label); };
      if (b.reason !== undefined) {
        if (!clean(b.reason)) { json(res, 400, { error: "The reason cannot be emptied." }); return true; }
        put("reason", clean(b.reason), "reason");
      }
      if (b.situation !== undefined) put("situation", clean(b.situation) || null, "situation");
      if (b.employee_names !== undefined) put("employee_names", JSON.stringify((b.employee_names || []).map(clean).filter(Boolean)), "who it covers");
      if (b.employee_ids !== undefined) put("employee_ids", JSON.stringify((b.employee_ids || []).map(num).filter(Boolean)), "who it covers");
      if (b.start_date !== undefined) put("start_date", clean(b.start_date) || null, "start date");
      if (b.end_date !== undefined) put("end_date", clean(b.end_date) || null, clean(b.end_date) ? `end date ${clean(b.end_date)}` : "end date removed");
      if (b.authorized_by !== undefined && clean(b.authorized_by)) put("authorized_by", clean(b.authorized_by), "authorizing person");
      if (b.executive_approval_required !== undefined) put("executive_approval_required", b.executive_approval_required === true, "executive approval requirement");
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      put("updated_at", nowISO());
      await dbRun(`UPDATE policy_exceptions SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
      await logException(id, { action: "edited", note: changed.join(", ") || null, actor_id: user.id, actor_name: actor });
      json(res, 200, await shapeException(await dbGet("SELECT * FROM policy_exceptions WHERE id = ?", [id]), true));
      return true;
    }

    const approveEx = pathname.match(/^\/api\/policy-exceptions\/(\d+)\/executive-approval$/);
    if (approveEx && method === "POST") {
      if (!canExecApprove(user)) { json(res, 403, { error: "Only executive leadership can give that approval." }); return true; }
      const id = Number(approveEx[1]);
      const row = await dbGet("SELECT * FROM policy_exceptions WHERE id = ?", [id]);
      if (!row) { json(res, 404, { error: "That exception no longer exists." }); return true; }
      const b = await readBody(req);
      await dbRun("UPDATE policy_exceptions SET executive_approved_by = ?, executive_approved_at = ?, updated_at = ? WHERE id = ?",
        [actor, nowISO(), nowISO(), id]);
      await logException(id, { action: "executive_approved", note: clean(b.note) || null, actor_id: user.id, actor_name: actor });
      json(res, 200, await shapeException(await dbGet("SELECT * FROM policy_exceptions WHERE id = ?", [id]), true));
      return true;
    }

    // Revoked, never deleted. An exception that can be deleted is an exception
    // nobody can review, which is the problem this log exists to fix.
    const revokeEx = pathname.match(/^\/api\/policy-exceptions\/(\d+)\/revoke$/);
    if (revokeEx && method === "POST") {
      if (!canException(user)) { json(res, 403, { error: "Not permitted." }); return true; }
      const id = Number(revokeEx[1]);
      const row = await dbGet("SELECT * FROM policy_exceptions WHERE id = ?", [id]);
      if (!row) { json(res, 404, { error: "That exception no longer exists." }); return true; }
      const b = await readBody(req);
      if (!clean(b.reason)) { json(res, 400, { error: "Say why it is being withdrawn." }); return true; }
      await dbRun("UPDATE policy_exceptions SET status = 'Revoked', revoked_by = ?, revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE id = ?",
        [actor, nowISO(), clean(b.reason), nowISO(), id]);
      await logException(id, { action: "revoked", note: clean(b.reason), actor_id: user.id, actor_name: actor });
      json(res, 200, await shapeException(await dbGet("SELECT * FROM policy_exceptions WHERE id = ?", [id]), true));
      return true;
    }

    const exDocM = pathname.match(/^\/api\/policy-exceptions\/(\d+)\/documents$/);
    if (exDocM && (method === "POST" || method === "DELETE")) {
      if (!canException(user)) { json(res, 403, { error: "Not permitted." }); return true; }
      const id = Number(exDocM[1]);
      const row = await dbGet("SELECT id FROM policy_exceptions WHERE id = ?", [id]);
      if (!row) { json(res, 404, { error: "That exception no longer exists." }); return true; }
      const b = await readBody(req);
      const docId = num(b.document_id);
      if (!docId) { json(res, 400, { error: "Choose a document from the library." }); return true; }
      if (method === "DELETE") {
        await dbRun("DELETE FROM policy_exception_documents WHERE exception_id = ? AND document_id = ?", [id, docId]);
        await logException(id, { action: "document_removed", note: `Document #${docId}`, actor_id: user.id, actor_name: actor });
      } else {
        const doc = await dbGet("SELECT id, title FROM crm_policy_documents WHERE id = ?", [docId]);
        if (!doc) { json(res, 404, { error: "That document is not in the library." }); return true; }
        await dbRun(
          `INSERT INTO policy_exception_documents (exception_id, document_id, added_by, added_at)
           VALUES (?, ?, ?, ?) ON CONFLICT (exception_id, document_id) DO NOTHING`,
          [id, doc.id, actor, nowISO()]);
        await logException(id, { action: "document_added", note: doc.title, actor_id: user.id, actor_name: actor });
      }
      json(res, 200, await shapeException(await dbGet("SELECT * FROM policy_exceptions WHERE id = ?", [id]), true));
      return true;
    }

    json(res, 404, { error: "Unknown endpoint." });
    return true;
  }

  return { initTables, handleApi, shapeRequest, shapeException, _internal: { REQUEST_TYPES, STATUSES, DECISIONS, DECISION_STATUS, DECIDED,
    IMPACT_AREAS, EMERGENCY_GROUNDS, EXCEPTION_STATUSES, canSubmit, canReview, canDecide, canEmergency,
    canException, canExecApprove, cycleFor, effectiveStatus, logRequest, logException, clean, parseJson } };
};
