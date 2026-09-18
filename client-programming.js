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
  const { dbGet, dbAll, dbRun, nowISO, readBody, json, canAccessClients } = ctx;

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

  async function overview(clientId) {
    const client = await dbGet("SELECT id, child_name, assigned_bcba_name, assigned_bcba_email FROM clients WHERE id = ?", [clientId]).catch(() => null);
    if (!client) return null;
    const [notes, behaviours] = await Promise.all([notesFor(clientId), behavioursFor(clientId)]);
    return { client, notes, ...behaviours };
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

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/client-programming")) return false;
    if (!user || !canAccessClients(user)) { json(res, 403, { error: "Not allowed." }); return true; }

    const m = pathname.match(/^\/api\/client-programming\/(\d+)$/);
    if (m && method === "GET") {
      const data = await overview(Number(m[1]));
      if (!data) { json(res, 404, { error: "Client not found." }); return true; }
      data.rbt_options = await rbtOptions(Number(m[1]));
      json(res, 200, data);
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

  return { initTables, handleApi, overview, notesFor, behavioursFor, rbtOptions, _internal: { normalizeEntries } };
};
