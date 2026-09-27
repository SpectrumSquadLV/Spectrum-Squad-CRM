// Client Programming -- supervision notes written against a client's programs.
//
// What a note is, in the practice's own terms: a BCBA sits in on a session,
// watches the RBT run the client's programs, and records two things side by
// side -- the program that was run, and the modification made to it. The date
// and the RBT sit at the top because a supervision note is evidence about a
// particular person on a particular day, and both are what anyone reads first.
//
// The pairing is the point. A list of programs and a separate list of
// modifications would lose which change belongs to which program, which is the
// only thing the note is really recording. So an entry holds both, and the two
// columns are one table rather than two.
//
// Behaviours shown alongside come from the client's BIP (bip_behaviors), which
// is where this CRM already keeps them. They are read-only here: the BIP owns
// them, and a supervision note is not the place to edit a behaviour plan.

"use strict";

module.exports = function initClientProgramming(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json, canAccessClients,
          sendEmail, getEmailTemplate, renderMergeFields } = ctx;

  // Recording a milestone, and approving the words a parent will read, are
  // clinical acts. canAccessClients() is wider than that on purpose -- intake,
  // billing and scheduling can all open a client -- so it decides who SEES
  // this section, and this decides who can change it. Same list the BIP uses,
  // because it is the same question.
  const CLINICAL_ROLES = ["owner", "super_admin", "admin", "clinical"];
  const canRecordMilestone = (u) => !!u && CLINICAL_ROLES.includes(u.role);

  // A skill is mastered. A BEHAVIOUR IS NEVER "MASTERED" -- it is reduced, and
  // a family reading "Jordan mastered aggression" would be right to be
  // appalled. The two event types exist so that the wording can never be
  // chosen by accident, and every sentence a parent sees is picked from the
  // type rather than assembled from a name.
  const EVENT_TYPES = {
    mastery: {
      label: "Mastered",
      template: "parent_milestone_mastery",
      // What this kind of event is allowed to be called on screen.
      verb: "mastered a new skill",
    },
    treatment_milestone: {
      label: "Treatment milestone",
      template: "parent_milestone_treatment",
      verb: "reached an important treatment milestone",
    },
  };
  const isEventType = (v) => Object.prototype.hasOwnProperty.call(EVENT_TYPES, String(v));

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS client_supervision_notes (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      session_date TEXT NOT NULL,
      rbt_name TEXT,
      rbt_email TEXT,
      bcba_name TEXT,
      bcba_email TEXT,
      general_notes TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_csn_client ON client_supervision_notes (client_id, session_date DESC)`);
    // Entries are a child table rather than a JSON blob so a future screen can
    // ask "which programs were modified this quarter" without parsing text.
    await dbRun(`CREATE TABLE IF NOT EXISTS client_supervision_entries (
      id SERIAL PRIMARY KEY,
      note_id INTEGER NOT NULL,
      program TEXT,
      modification TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_cse_note ON client_supervision_entries (note_id, sort_order, id)`);

    // Milestones: something a clinician decided was reached, and the record of
    // whether the family was told.
    //
    // NOT SYNCHRONISED FROM RETHINK, because it cannot be. The endpoint probe
    // asked this account's DWH API for thirty-four plausible programming
    // endpoint names and every one returned 404 while the three the CRM reads
    // daily answered normally. There is no program, target or mastery data to
    // read, so a clinician records the milestone instead -- which is also the
    // safer trigger: nothing here infers clinical progress.
    //
    // rethink_program_id and rethink_target_id are here and unused. When that
    // API does expose programming, a sync fills them and the detection can be
    // automatic without moving anything.
    await dbRun(`CREATE TABLE IF NOT EXISTS client_milestones (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      clinical_program_name TEXT,
      clinical_target_name TEXT,
      rethink_program_id TEXT,
      rethink_target_id TEXT,
      achieved_at TEXT NOT NULL,
      assigned_bcba TEXT,
      recorded_by TEXT,
      recorded_at TEXT,
      parent_friendly_name TEXT,
      parent_friendly_description TEXT,
      approved_by TEXT,
      approved_at TEXT,
      notification_status TEXT NOT NULL DEFAULT 'needs_review',
      parent_notified_at TEXT,
      internal_notes TEXT
    )`).catch((e) => console.error("client_milestones initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_cm_client ON client_milestones (client_id, achieved_at DESC, id DESC)`).catch(() => {});
    // THE DUPLICATE GUARD. One milestone per client, per kind, per target, per
    // day -- enforced by the database rather than by a check in the route,
    // because two clicks a second apart would both pass a check and both
    // insert. A repeated recording is refused here, which is what makes "the
    // family is never told twice" true rather than likely.
    await dbRun(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_client_milestone
         ON client_milestones (client_id, event_type, COALESCE(clinical_target_name,''), achieved_at)`
    ).catch((e) => console.error("uq_client_milestone:", e.message));
  }

  const clean = (v, max = 4000) => String(v == null ? "" : v).trim().slice(0, max);
  const lower = (v) => clean(v, 320).toLowerCase();
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  // Entries arrive as an array of { program, modification }. A row with neither
  // filled in is dropped rather than stored: an empty row is what a half-used
  // form leaves behind, not something somebody meant to record.
  function normalizeEntries(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((e) => ({ program: clean(e && e.program, 2000), modification: clean(e && e.modification, 2000) }))
      .filter((e) => e.program || e.modification)
      .slice(0, 100);
  }

  async function notesFor(clientId) {
    const notes = await dbAll(
      `SELECT * FROM client_supervision_notes WHERE client_id = ? ORDER BY session_date DESC, id DESC`,
      [clientId]
    ).catch(() => []);
    for (const n of notes) {
      n.entries = await dbAll(
        "SELECT id, program, modification, sort_order FROM client_supervision_entries WHERE note_id = ? ORDER BY sort_order, id",
        [n.id]
      ).catch(() => []);
    }
    return notes;
  }

  // The client's behaviours, from their BIP. Read-only, and clearly attributed
  // in the response so the screen can say where they came from rather than
  // implying the programming section owns them.
  async function behavioursFor(clientId) {
    const bip = await dbGet(
      "SELECT id, status, effective_date FROM client_bips WHERE client_id = ? ORDER BY id DESC LIMIT 1",
      [clientId]
    ).catch(() => null);
    if (!bip) return { source: "bip", bip_id: null, behaviours: [] };
    const rows = await dbAll(
      `SELECT id, name, operational_definition, hypothesized_function, replacement_behaviors, data_collection_method
         FROM bip_behaviors WHERE bip_id = ? ORDER BY sort_order, id`,
      [bip.id]
    ).catch(() => []);
    return { source: "bip", bip_id: bip.id, bip_status: bip.status, behaviours: rows };
  }

  // ---- milestones ---------------------------------------------------------

  function shapeMilestone(r) {
    const kind = EVENT_TYPES[r.event_type] || null;
    return {
      id: r.id,
      event_type: r.event_type,
      event_label: kind ? kind.label : r.event_type,
      clinical_program_name: r.clinical_program_name || "",
      clinical_target_name: r.clinical_target_name || "",
      achieved_at: r.achieved_at,
      assigned_bcba: r.assigned_bcba || "",
      recorded_by: r.recorded_by || "",
      recorded_at: r.recorded_at || null,
      parent_friendly_name: r.parent_friendly_name || "",
      parent_friendly_description: r.parent_friendly_description || "",
      approved_by: r.approved_by || "",
      approved_at: r.approved_at || null,
      notification_status: r.notification_status,
      parent_notified_at: r.parent_notified_at || null,
      internal_notes: r.internal_notes || "",
      // Whether the family can be told yet. Two separate reasons it might not
      // be, and the screen needs to tell them apart.
      can_send: (r.notification_status === "ready" || r.notification_status === "failed") && !r.parent_notified_at,
      needs_language: !clean(r.parent_friendly_name) || !clean(r.parent_friendly_description),
    };
  }

  async function milestonesFor(clientId) {
    const rows = await dbAll(
      "SELECT * FROM client_milestones WHERE client_id = ? ORDER BY achieved_at DESC, id DESC",
      [clientId]
    ).catch(() => []);
    return rows.map(shapeMilestone);
  }

  // Whether a milestone is ready to send is decided by ONE rule, here, so the
  // route that records and the route that edits cannot drift apart. No
  // approved parent-facing words means NEEDS REVIEW and no email -- which is
  // the clinical safeguard, not a formality: the alternative is a machine
  // choosing how somebody's child is described to their family.
  function statusFor(input, existing) {
    // Already told: that is a record of what a family received, and editing
    // the wording afterwards does not un-send it.
    if (existing && existing.parent_notified_at) return "sent";
    const named = clean(input.parent_friendly_name);
    const described = clean(input.parent_friendly_description);
    return named && described ? "ready" : "needs_review";
  }

  async function recordMilestone(clientId, body, actor) {
    const eventType = clean(body.event_type, 40);
    if (!isEventType(eventType)) {
      return { ok: false, status: 400, error: "Choose whether this is a mastered skill or a treatment milestone." };
    }
    const achieved = clean(body.achieved_at, 10);
    if (!DATE.test(achieved)) return { ok: false, status: 400, error: "A date is required, as YYYY-MM-DD." };
    const target = clean(body.clinical_target_name, 300);
    if (!target) return { ok: false, status: 400, error: "Name the program or goal this milestone is for." };

    const status = statusFor(body, null);
    const approved = status === "ready";
    try {
      const row = await dbGet(
        `INSERT INTO client_milestones
           (client_id, event_type, clinical_program_name, clinical_target_name,
            rethink_program_id, rethink_target_id, achieved_at, assigned_bcba,
            recorded_by, recorded_at, parent_friendly_name, parent_friendly_description,
            approved_by, approved_at, notification_status, internal_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
        [clientId, eventType, clean(body.clinical_program_name, 300), target,
         clean(body.rethink_program_id, 80) || null, clean(body.rethink_target_id, 80) || null,
         achieved, clean(body.assigned_bcba, 200), actor, nowISO(),
         clean(body.parent_friendly_name, 200), clean(body.parent_friendly_description, 2000),
         approved ? actor : null, approved ? nowISO() : null, status,
         clean(body.internal_notes, 2000)]
      );
      return { ok: true, milestone: shapeMilestone(row) };
    } catch (e) {
      // The unique index. Worth its own sentence: somebody pressing twice, or
      // two people recording the same achievement, is the ordinary way a
      // family gets told twice.
      if (/uq_client_milestone|duplicate key/i.test(String(e.message))) {
        return { ok: false, status: 409, error: "That milestone is already recorded for this client on that date." };
      }
      return { ok: false, status: 500, error: "Could not record that milestone." };
    }
  }

  // Editing the parent-facing words. The clinical fields and the achievement
  // itself are deliberately NOT editable here: this is the approval step, not
  // a second chance to change what happened.
  async function updateMilestoneLanguage(id, body, actor) {
    const existing = await dbGet("SELECT * FROM client_milestones WHERE id = ?", [id]).catch(() => null);
    if (!existing) return { ok: false, status: 404, error: "Milestone not found." };

    const status = statusFor(body, existing);
    const nowApproved = status === "ready";
    await dbRun(
      `UPDATE client_milestones
          SET parent_friendly_name = ?, parent_friendly_description = ?, internal_notes = ?,
              approved_by = ?, approved_at = ?, notification_status = ?
        WHERE id = ?`,
      [clean(body.parent_friendly_name, 200), clean(body.parent_friendly_description, 2000),
       clean(body.internal_notes, 2000),
       nowApproved ? actor : null, nowApproved ? nowISO() : null, status, id]
    );
    const row = await dbGet("SELECT * FROM client_milestones WHERE id = ?", [id]);
    return { ok: true, milestone: shapeMilestone(row) };
  }

  // Send the celebration.
  //
  // THE CLAIM ON THE TIN IS THAT THIS CAN NEVER SEND TWICE. It is true because
  // of the UPDATE below, not because of the check above it: the row is claimed
  // with a conditional write -- `WHERE parent_notified_at IS NULL` -- and only
  // the request that actually changes a row goes on to email. Two clicks a
  // millisecond apart both pass a read-then-write check; only one of them wins
  // a conditional update.
  //
  // The claim happens BEFORE the send. If the email then fails, the family is
  // not emailed twice by a retry -- the status says failed and a human decides.
  // Sending twice is worse than not sending: the first is a mistake the family
  // sees, the second is one a person can fix.
  async function sendMilestoneEmail(id, actor) {
    const m = await dbGet("SELECT * FROM client_milestones WHERE id = ?", [id]).catch(() => null);
    if (!m) return { ok: false, status: 404, error: "Milestone not found." };
    if (m.parent_notified_at) {
      return { ok: false, status: 409, error: "This family has already been told about this milestone." };
    }
    // 'failed' is a delivery outcome, not a withdrawal of approval: the
    // wording is still there and still approved, so a retry is exactly what
    // should happen next. Only missing wording blocks a send.
    if (m.notification_status !== "ready" && m.notification_status !== "failed") {
      return { ok: false, status: 400, error: "Add and approve the parent-friendly name and description first." };
    }
    const client = await dbGet(
      "SELECT id, child_name, parent_name, parent_email FROM clients WHERE id = ?", [m.client_id]
    ).catch(() => null);
    if (!client) return { ok: false, status: 404, error: "Client not found." };
    if (!clean(client.parent_email)) {
      return { ok: false, status: 400, error: "There is no parent email on this client's record." };
    }

    const claimed = await dbRun(
      `UPDATE client_milestones SET notification_status = 'sent', parent_notified_at = ?
        WHERE id = ? AND parent_notified_at IS NULL`,
      [nowISO(), id]
    ).catch(() => null);
    const changed = claimed && (claimed.rowCount != null ? claimed.rowCount : (claimed.changes || 0));
    if (!changed) {
      return { ok: false, status: 409, error: "This family has already been told about this milestone." };
    }

    const kind = EVENT_TYPES[m.event_type] || EVENT_TYPES.treatment_milestone;
    const tpl = getEmailTemplate ? await getEmailTemplate(kind.template) : null;
    if (!tpl) {
      await dbRun("UPDATE client_milestones SET notification_status = 'failed', parent_notified_at = NULL WHERE id = ?", [id]).catch(() => {});
      return { ok: false, status: 500, error: "The celebration email template is missing." };
    }

    // First names only. "Hi Mrs Alvarez-Whitfield" is not how this email
    // should read, and the child's first name is what the family calls them.
    const first = (v) => clean(v).split(/\s+/)[0] || "";
    const fields = {
      child_first_name: first(client.child_name),
      child_name: clean(client.child_name),
      parent_first_name: first(client.parent_name) || "there",
      parent_name: clean(client.parent_name),
      skill_name: clean(m.parent_friendly_name),
      milestone_name: clean(m.parent_friendly_name),
      milestone_description: clean(m.parent_friendly_description),
    };
    const subject = renderMergeFields(tpl.subject_template, fields);
    const html = renderMergeFields(tpl.body_template, fields);

    const out = await sendEmail({
      to: client.parent_email, subject, html,
      clientId: client.id, type: "parent_milestone",
      refType: "client_milestone", refId: id,
    }).catch((e) => ({ delivered: "failed", errorMsg: e.message }));

    if (out && out.delivered === "failed") {
      await dbRun(
        "UPDATE client_milestones SET notification_status = 'failed', parent_notified_at = NULL WHERE id = ?", [id]
      ).catch(() => {});
      return { ok: false, status: 502, error: `The email could not be sent: ${out.errorMsg || "unknown error"}` };
    }

    const row = await dbGet("SELECT * FROM client_milestones WHERE id = ?", [id]);
    void actor;
    return { ok: true, milestone: shapeMilestone(row) };
  }

  async function overview(clientId) {
    const client = await dbGet("SELECT id, child_name, assigned_bcba_name, assigned_bcba_email FROM clients WHERE id = ?", [clientId]).catch(() => null);
    if (!client) return null;
    const [notes, behaviours, milestones] = await Promise.all([
      notesFor(clientId), behavioursFor(clientId), milestonesFor(clientId),
    ]);
    return { client, notes, ...behaviours, milestones };
  }

  // Who the RBT picker offers: the staff actually assigned to this client,
  // then the rest of the active RBT-side staff. Names are typed by hand today
  // in half the CRM, and a picker is how that stops.
  async function rbtOptions(clientId) {
    const rows = await dbAll(
      `SELECT DISTINCT e.name, e.email, e.role_title
         FROM hr_employees e
        WHERE COALESCE(e.status,'active') <> 'terminated'
          AND COALESCE(e.name,'') <> ''
        ORDER BY e.name`
    ).catch(() => []);
    const c = await dbGet("SELECT assigned_rbt_name FROM clients WHERE id = ?", [clientId]).catch(() => null);
    const assigned = clean(c && c.assigned_rbt_name).toLowerCase();
    return rows
      .map((r) => ({ ...r, assigned: !!assigned && clean(r.name).toLowerCase() === assigned }))
      .sort((a, b) => (b.assigned ? 1 : 0) - (a.assigned ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  }

  async function writeEntries(noteId, entries) {
    await dbRun("DELETE FROM client_supervision_entries WHERE note_id = ?", [noteId]);
    let i = 0;
    for (const e of entries) {
      await dbRun(
        "INSERT INTO client_supervision_entries (note_id, program, modification, sort_order, created_at) VALUES (?, ?, ?, ?, ?)",
        [noteId, e.program || null, e.modification || null, i++, nowISO()]
      );
    }
  }

  const actorOf = (u) => String((u && (u.email || u.name)) || "unknown");

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/client-programming")) return false;
    if (!user || !canAccessClients(user)) { json(res, 403, { error: "Not allowed." }); return true; }

    const m = pathname.match(/^\/api\/client-programming\/(\d+)$/);
    if (m && method === "GET") {
      const data = await overview(Number(m[1]));
      if (!data) { json(res, 404, { error: "Client not found." }); return true; }
      data.rbt_options = await rbtOptions(Number(m[1]));
      // The server decides, and says so. A screen that re-derived this from a
      // role list would be answering a permission question it does not own.
      data.can_record_milestone = canRecordMilestone(user);
      json(res, 200, data);
      return true;
    }

    // ---- milestones -------------------------------------------------------
    const msList = pathname.match(/^\/api\/client-programming\/(\d+)\/milestones$/);
    if (msList && method === "POST") {
      if (!canRecordMilestone(user)) {
        json(res, 403, { error: "Only clinical staff can record a milestone." });
        return true;
      }
      const clientId = Number(msList[1]);
      const exists = await dbGet("SELECT id FROM clients WHERE id = ?", [clientId]).catch(() => null);
      if (!exists) { json(res, 404, { error: "Client not found." }); return true; }
      const body = await readBody(req).catch(() => ({}));
      const out = await recordMilestone(clientId, body || {}, actorOf(user));
      json(res, out.ok ? 201 : out.status, out.ok ? { ok: true, milestone: out.milestone } : { error: out.error });
      return true;
    }

    const msOne = pathname.match(/^\/api\/client-programming\/milestones\/(\d+)$/);
    if (msOne && method === "PATCH") {
      if (!canRecordMilestone(user)) {
        json(res, 403, { error: "Only clinical staff can approve what a parent is told." });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const out = await updateMilestoneLanguage(Number(msOne[1]), body || {}, actorOf(user));
      json(res, out.ok ? 200 : out.status, out.ok ? { ok: true, milestone: out.milestone } : { error: out.error });
      return true;
    }

    const msSend = pathname.match(/^\/api\/client-programming\/milestones\/(\d+)\/send$/);
    if (msSend && method === "POST") {
      if (!canRecordMilestone(user)) {
        json(res, 403, { error: "Only clinical staff can send a celebration." });
        return true;
      }
      const out = await sendMilestoneEmail(Number(msSend[1]), actorOf(user));
      json(res, out.ok ? 200 : out.status, out.ok ? { ok: true, milestone: out.milestone } : { error: out.error });
      return true;
    }

    // New supervision note.
    const post = pathname.match(/^\/api\/client-programming\/(\d+)\/notes$/);
    if (post && method === "POST") {
      const clientId = Number(post[1]);
      const client = await dbGet("SELECT id FROM clients WHERE id = ?", [clientId]);
      if (!client) { json(res, 404, { error: "Client not found." }); return true; }
      const b = await readBody(req);
      const date = clean(b.session_date, 10);
      if (!DATE.test(date)) { json(res, 400, { error: "A session date is required." }); return true; }
      const rbt = clean(b.rbt_name, 200);
      if (!rbt) { json(res, 400, { error: "Please say which RBT was supervised." }); return true; }
      const now = nowISO();
      const row = await dbGet(
        `INSERT INTO client_supervision_notes
           (client_id, session_date, rbt_name, rbt_email, bcba_name, bcba_email, general_notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [clientId, date, rbt, lower(b.rbt_email), clean(b.bcba_name, 200) || clean(user.name, 200),
         lower(b.bcba_email) || lower(user.email), clean(b.general_notes), lower(user.email), now, now]
      );
      await writeEntries(row.id, normalizeEntries(b.entries));
      json(res, 201, { ok: true, id: row.id, notes: await notesFor(clientId) });
      return true;
    }

    const one = pathname.match(/^\/api\/client-programming\/notes\/(\d+)$/);
    if (one && method === "PATCH") {
      const id = Number(one[1]);
      const note = await dbGet("SELECT * FROM client_supervision_notes WHERE id = ?", [id]);
      if (!note) { json(res, 404, { error: "Note not found." }); return true; }
      const b = await readBody(req);
      const sets = [], params = [];
      if (typeof b.session_date === "string") {
        const d = clean(b.session_date, 10);
        if (!DATE.test(d)) { json(res, 400, { error: "That is not a valid session date." }); return true; }
        sets.push("session_date = ?"); params.push(d);
      }
      if (typeof b.rbt_name === "string") {
        const r = clean(b.rbt_name, 200);
        if (!r) { json(res, 400, { error: "Please say which RBT was supervised." }); return true; }
        sets.push("rbt_name = ?"); params.push(r);
        sets.push("rbt_email = ?"); params.push(lower(b.rbt_email));
      }
      if (typeof b.general_notes === "string") { sets.push("general_notes = ?"); params.push(clean(b.general_notes)); }
      sets.push("updated_at = ?"); params.push(nowISO());
      params.push(id);
      await dbRun(`UPDATE client_supervision_notes SET ${sets.join(", ")} WHERE id = ?`, params);
      if (Array.isArray(b.entries)) await writeEntries(id, normalizeEntries(b.entries));
      json(res, 200, { ok: true, notes: await notesFor(note.client_id) });
      return true;
    }

    if (one && method === "DELETE") {
      const id = Number(one[1]);
      const note = await dbGet("SELECT client_id FROM client_supervision_notes WHERE id = ?", [id]);
      if (!note) { json(res, 404, { error: "Note not found." }); return true; }
      await dbRun("DELETE FROM client_supervision_entries WHERE note_id = ?", [id]);
      await dbRun("DELETE FROM client_supervision_notes WHERE id = ?", [id]);
      json(res, 200, { ok: true, notes: await notesFor(note.client_id) });
      return true;
    }

    return false;
  }

  return {
    initTables, handleApi, overview, notesFor, behavioursFor, rbtOptions,
    _internal: {
      normalizeEntries,
      recordMilestone, updateMilestoneLanguage, sendMilestoneEmail, milestonesFor,
      statusFor, shapeMilestone, EVENT_TYPES, canRecordMilestone,
    },
  };
};
