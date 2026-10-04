// Maintenance requests: something is broken, and somebody needs to know.
//
// Built on the Supply Request module deliberately, because the shape of the
// problem is the same -- a member of staff raises something, an administrator
// works it through a queue, and the person who raised it wants to know where it
// got to. Same tables-plus-history pattern, same per-user scoping, same
// tokenised public page for anyone without a login.
//
// WHAT IS DIFFERENT, AND WHY:
//
//   A SAFETY ISSUE IS NOT A PRIORITY. It is stored as one, because that is how
//   somebody picks it, but the moment it arrives it is flagged for leadership
//   and that flag does not depend on anybody reading a queue. A broken chair
//   can wait for the next person to open the page; an exposed wire cannot.
//
//   The queue has a waiting state the supply flow has no need for. "Waiting on
//   vendor/parts" is the difference between nobody having looked at something
//   and somebody having looked at it and being stuck, and a dashboard that
//   cannot tell those apart is a dashboard that gets ignored.
"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function initMaintenanceRequests(ctx) {
  const { dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, sendFile } = ctx;

  const DATA_DIR = path.join(__dirname, "data");
  const FILES_DIR = path.join(DATA_DIR, "maintenance-files");
  if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

  const ADMIN_ROLES = ["owner", "super_admin", "admin"];
  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  // Managing maintenance is an operational job, not a privilege: an office
  // manager granted "maintenance" runs the queue without being made an admin
  // of everything else.
  function canManage(user) { return !!user && (ADMIN_ROLES.includes(user.role) || granted(user, "maintenance")); }

  const STATUSES = ["Submitted", "Received", "Assigned", "In Progress", "Waiting on Vendor/Parts", "Completed", "Closed"];
  const OPEN_STATUSES = ["Submitted", "Received", "Assigned", "In Progress", "Waiting on Vendor/Parts"];
  const CATEGORIES = [
    "Plumbing", "Electrical", "HVAC", "Furniture", "Doors/Locks", "Walls/Paint",
    "Bathroom", "Kitchen", "Technology/Equipment", "Safety Hazard",
    "Cleaning/Facility Issue", "Exterior/Parking Lot", "Other",
  ];
  const PRIORITIES = ["Routine", "Needs Attention", "Urgent", "Safety Issue"];
  // The two that get leadership told without waiting for somebody to look.
  const ESCALATING = ["Urgent", "Safety Issue"];

  const STATUS_MESSAGE = {
    Received: "We have your maintenance request and it is in the queue.",
    Assigned: "Your maintenance request has been assigned.",
    "In Progress": "Work has started on your maintenance request.",
    "Waiting on Vendor/Parts": "Your request is waiting on a vendor or on parts.",
    Completed: "The work on your maintenance request is finished.",
    Closed: "Your maintenance request has been closed.",
  };

  const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
  const newToken = () => crypto.randomBytes(20).toString("hex");
  const clean = (s) => String(s == null ? "" : s).trim();
  const parseJson = (s, f) => { try { return s ? JSON.parse(s) : f; } catch (e) { return f; } };

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS maintenance_requests (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      requester_name TEXT,
      requester_email TEXT,
      location TEXT,                       -- which site
      area TEXT,                           -- the room, or the specific spot
      category TEXT,
      description TEXT NOT NULL,
      priority TEXT DEFAULT 'Routine',
      status TEXT NOT NULL DEFAULT 'Submitted',
      assigned_to TEXT,
      vendor_name TEXT,
      vendor_contact TEXT,
      internal_notes TEXT,
      completion_notes TEXT,
      completed_on TEXT,
      -- A safety issue is escalated ONCE, on the way in. Recorded so a later
      -- priority change cannot make it look as though leadership was never
      -- told, and so re-notifying is a decision rather than an accident.
      escalated_at TEXT,
      escalated_reason TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("maintenance_requests initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_maint_status ON maintenance_requests(status)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_maint_email ON maintenance_requests(requester_email)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS maintenance_request_history (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      action TEXT NOT NULL,                -- submitted|status_change|note|assign|vendor|priority|escalated|attachment
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      notified BOOLEAN DEFAULT false,
      actor_id INTEGER,
      actor_name TEXT,
      created_at TEXT
    )`).catch((e) => console.error("maintenance_request_history initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_maint_hist ON maintenance_request_history(request_id, id)`).catch(() => {});

    // Photographs, invoices, receipts. Stored beside the request rather than in
    // it, because a job can collect several over its life.
    await dbRun(`CREATE TABLE IF NOT EXISTS maintenance_request_files (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      kind TEXT DEFAULT 'photo',           -- photo | invoice | receipt | document
      stored_name TEXT NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      bytes INTEGER,
      uploaded_by TEXT,
      uploaded_at TEXT
    )`).catch((e) => console.error("maintenance_request_files initTables:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_maint_files ON maintenance_request_files(request_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS maintenance_settings (
      id INTEGER PRIMARY KEY,
      config TEXT NOT NULL,
      updated_at TEXT
    )`).catch((e) => console.error("maintenance_settings initTables:", e.message));
  }

  async function history(requestId, entry) {
    await dbRun(
      `INSERT INTO maintenance_request_history (request_id, action, from_status, to_status, note, notified, actor_id, actor_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [requestId, entry.action, entry.from_status || null, entry.to_status || null, entry.note || null,
       !!entry.notified, entry.actor_id || null, entry.actor_name || null, nowISO()]
    ).catch((e) => console.error("maintenance history:", e.message));
  }

  async function settings() {
    const row = await dbGet("SELECT config FROM maintenance_settings WHERE id = 1").catch(() => null);
    const cfg = parseJson(row && row.config, {}) || {};
    return { notify_to: cfg.notify_to || "", escalate_to: cfg.escalate_to || "" };
  }

  // Where an URGENT or SAFETY ISSUE goes. Falls back to the ordinary recipient
  // rather than nowhere: an escalation that reaches no one is worse than one
  // that reaches the same inbox twice.
  async function escalationRecipients() {
    const s = await settings();
    return clean(s.escalate_to) || clean(s.notify_to) || "";
  }

  function publicUrl() { return `${APP_BASE_URL}/maintenance-request`; }

  async function notifyNew(row) {
    const s = await settings();
    const to = clean(s.notify_to);
    const where = [row.location, row.area].filter(Boolean).join(" — ") || "not given";
    const body = `<p><strong>${esc(row.category || "Maintenance")}</strong> · ${esc(row.priority)}</p>
      <p>Where: ${esc(where)}</p>
      <p>${esc(row.description)}</p>
      <p>Raised by ${esc(row.requester_name || row.requester_email || "a member of staff")}.</p>`;
    if (to) {
      await sendEmail({ to, subject: `Maintenance request: ${row.category || "New"} (${row.priority})`,
        html: body, type: "maintenance_new", refType: "maintenance_request", refId: row.id }).catch(() => {});
    }
    if (ESCALATING.includes(row.priority)) {
      const esc_to = await escalationRecipients();
      if (esc_to) {
        await sendEmail({ to: esc_to,
          subject: `${row.priority === "Safety Issue" ? "SAFETY ISSUE" : "URGENT"}: maintenance request`,
          html: body, type: "maintenance_escalation", refType: "maintenance_request", refId: row.id }).catch(() => {});
      }
      await dbRun("UPDATE maintenance_requests SET escalated_at = ?, escalated_reason = ? WHERE id = ?",
        [nowISO(), row.priority, row.id]).catch(() => {});
      await history(row.id, { action: "escalated", note: `Flagged for leadership: ${row.priority}`, notified: !!esc_to, actor_name: "system" });
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Shared by the public page and the signed-in form, so the two cannot drift
  // into validating different things.
  async function createRequest(b, who) {
    const description = clean(b.description);
    if (!description) return { ok: false, status: 400, error: "Please describe what needs fixing." };
    const category = CATEGORIES.includes(clean(b.category)) ? clean(b.category) : "Other";
    const priority = PRIORITIES.includes(clean(b.priority)) ? clean(b.priority) : "Routine";
    const email = clean(b.requester_email || (who && who.email));
    // An email is how somebody finds out their request moved. The public page
    // has no session to fall back on, so it is required there; a signed-in
    // request takes it from the account.
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false, status: 400, error: "Please give an email address so we can tell you what happens to this." };
    }
    const token = newToken();
    const now = nowISO();
    const row = await dbGet(
      `INSERT INTO maintenance_requests
         (token, requester_name, requester_email, location, area, category, description, priority,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?) RETURNING *`,
      [token, clean(b.requester_name || (who && who.name)) || null, email,
       clean(b.location) || null, clean(b.area) || null, category, description, priority, now, now]
    );
    await history(row.id, { action: "submitted", to_status: "Submitted",
      actor_id: who ? who.id : null, actor_name: row.requester_name || row.requester_email || "Requester" });

    for (const f of (Array.isArray(b.files) ? b.files : []).slice(0, 8)) {
      await saveFile(row.id, f, row.requester_name || "Requester");
    }
    await notifyNew(row);
    return { ok: true, request: await shape(row.id, true) };
  }

  async function saveFile(requestId, f, by) {
    if (!f || !f.content_base64) return null;
    const buf = Buffer.from(f.content_base64, "base64");
    if (buf.length > MAX_PHOTO_BYTES) return { error: "That file is too large (max ~6MB)." };
    const stored = newToken() + path.extname(clean(f.filename) || "").slice(0, 10);
    fs.writeFileSync(path.join(FILES_DIR, stored), buf);
    await dbRun(
      `INSERT INTO maintenance_request_files (request_id, kind, stored_name, original_name, mime_type, bytes, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [requestId, ["photo", "invoice", "receipt", "document"].includes(clean(f.kind)) ? clean(f.kind) : "photo",
       stored, clean(f.filename) || null, clean(f.mime_type) || null, buf.length, by || null, nowISO()]
    );
    return { ok: true };
  }

  async function shape(id, full) {
    const r = await dbGet("SELECT * FROM maintenance_requests WHERE id = ?", [id]);
    if (!r) return null;
    const out = {
      id: r.id, requester_name: r.requester_name, requester_email: r.requester_email,
      location: r.location, area: r.area, category: r.category, description: r.description,
      priority: r.priority, status: r.status, assigned_to: r.assigned_to,
      vendor_name: r.vendor_name, vendor_contact: r.vendor_contact,
      completion_notes: r.completion_notes, completed_on: r.completed_on,
      escalated_at: r.escalated_at, escalated_reason: r.escalated_reason,
      created_at: r.created_at, updated_at: r.updated_at,
      is_open: OPEN_STATUSES.includes(r.status),
    };
    if (full) {
      out.internal_notes = r.internal_notes;
      out.history = await dbAll("SELECT * FROM maintenance_request_history WHERE request_id = ? ORDER BY id", [id]).catch(() => []);
      out.files = await dbAll(
        "SELECT id, kind, original_name, mime_type, bytes, uploaded_by, uploaded_at FROM maintenance_request_files WHERE request_id = ? ORDER BY id", [id]
      ).catch(() => []);
    }
    return out;
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/maintenance")) return false;

    // ---------------- public, tokenised, no login ----------------
    if (pathname === "/api/maintenance/public/submit" && method === "POST") {
      const b = await readBody(req);
      const r = await createRequest(b, null);
      json(res, r.ok ? 201 : (r.status || 400), r.ok ? { ok: true, id: r.request.id } : { error: r.error });
      return true;
    }
    if (pathname === "/api/maintenance/options" && method === "GET") {
      json(res, 200, { categories: CATEGORIES, priorities: PRIORITIES, statuses: STATUSES });
      return true;
    }

    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }
    const manage = canManage(user);
    const myEmail = clean(user.email).toLowerCase();

    if (pathname === "/api/maintenance/requests" && method === "POST") {
      const b = await readBody(req);
      const r = await createRequest(b, user);
      json(res, r.ok ? 201 : (r.status || 400), r.ok ? r.request : { error: r.error });
      return true;
    }

    if (pathname === "/api/maintenance/requests" && method === "GET") {
      // WHOSE REQUESTS SOMEBODY SEES IS DECIDED HERE AND NOWHERE ELSE. Without
      // the clause, every member of staff would read the whole building's
      // maintenance queue, including the internal notes and vendor costs on it.
      const mine = manage ? "" : " WHERE lower(trim(requester_email)) = ?";
      const args = manage ? [] : [myEmail];
      const rows = await dbAll(
        `SELECT * FROM maintenance_requests${mine} ORDER BY id DESC LIMIT 400`, args).catch(() => []);
      const list = [];
      for (const r of rows) list.push(await shape(r.id, false));
      // The dashboard counts. Computed over what this person may see, so a
      // member of staff is never shown a total they cannot open.
      const counts = { open: 0, urgent: 0, safety: 0, assigned: 0, waiting: 0, completed: 0 };
      rows.forEach((r) => {
        if (OPEN_STATUSES.includes(r.status)) counts.open++;
        if (r.priority === "Urgent" && OPEN_STATUSES.includes(r.status)) counts.urgent++;
        if (r.priority === "Safety Issue" && OPEN_STATUSES.includes(r.status)) counts.safety++;
        if (r.status === "Assigned") counts.assigned++;
        if (r.status === "Waiting on Vendor/Parts") counts.waiting++;
        if (r.status === "Completed" || r.status === "Closed") counts.completed++;
      });
      json(res, 200, { requests: list, counts, can_manage: manage,
        categories: CATEGORIES, priorities: PRIORITIES, statuses: STATUSES,
        public_url: publicUrl() });
      return true;
    }

    const one = pathname.match(/^\/api\/maintenance\/requests\/(\d+)$/);
    if (one && method === "GET") {
      const row = await dbGet("SELECT * FROM maintenance_requests WHERE id = ?", [Number(one[1])]);
      if (!row) { json(res, 404, { error: "That request no longer exists." }); return true; }
      const isMine = clean(row.requester_email).toLowerCase() === myEmail;
      if (!manage && !isMine) { json(res, 403, { error: "Not permitted." }); return true; }
      const full = await shape(row.id, true);
      // Internal notes and vendor cost are for whoever is running the job, not
      // for the person who reported the broken tap.
      if (!manage) { delete full.internal_notes; delete full.vendor_contact; }
      json(res, 200, full);
      return true;
    }

    if (one && method === "PATCH") {
      if (!manage) { json(res, 403, { error: "Only maintenance administrators can update a request." }); return true; }
      const id = Number(one[1]);
      const before = await dbGet("SELECT * FROM maintenance_requests WHERE id = ?", [id]);
      if (!before) { json(res, 404, { error: "That request no longer exists." }); return true; }
      const b = await readBody(req);
      const sets = [], args = [];
      const put = (col, val) => { sets.push(`${col} = ?`); args.push(val); };

      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) { json(res, 400, { error: "That is not a maintenance status." }); return true; }
        put("status", b.status);
      }
      if (b.priority !== undefined) {
        if (!PRIORITIES.includes(b.priority)) { json(res, 400, { error: "That is not a priority." }); return true; }
        put("priority", b.priority);
      }
      ["assigned_to", "vendor_name", "vendor_contact", "internal_notes", "completion_notes", "completed_on"]
        .forEach((f) => { if (b[f] !== undefined) put(f, clean(b[f]) || null); });
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      put("updated_at", nowISO());
      await dbRun(`UPDATE maintenance_requests SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);

      const actor = user.name || user.email;
      if (b.status !== undefined && b.status !== before.status) {
        await history(id, { action: "status_change", from_status: before.status, to_status: b.status,
          note: clean(b.note) || null, actor_id: user.id, actor_name: actor });
        const msg = STATUS_MESSAGE[b.status];
        if (msg && before.requester_email) {
          await sendEmail({ to: before.requester_email, subject: `Maintenance request update: ${b.status}`,
            html: `<p>${esc(msg)}</p><p>${esc(before.description)}</p>`,
            type: "maintenance_status", refType: "maintenance_request", refId: id }).catch(() => {});
        }
      }
      if (b.priority !== undefined && b.priority !== before.priority) {
        await history(id, { action: "priority", note: `${before.priority} → ${b.priority}`, actor_id: user.id, actor_name: actor });
        // Raised INTO an escalating priority after the fact: tell leadership
        // now, and only once, so a request that becomes a safety issue is not
        // quieter than one that arrived as one.
        if (ESCALATING.includes(b.priority) && !before.escalated_at) {
          const to = await escalationRecipients();
          if (to) {
            await sendEmail({ to, subject: `${b.priority === "Safety Issue" ? "SAFETY ISSUE" : "URGENT"}: maintenance request raised in priority`,
              html: `<p>${esc(before.description)}</p><p>Now: ${esc(b.priority)}</p>`,
              type: "maintenance_escalation", refType: "maintenance_request", refId: id }).catch(() => {});
          }
          await dbRun("UPDATE maintenance_requests SET escalated_at = ?, escalated_reason = ? WHERE id = ?",
            [nowISO(), b.priority, id]).catch(() => {});
          await history(id, { action: "escalated", note: `Flagged for leadership: ${b.priority}`, notified: !!to, actor_id: user.id, actor_name: actor });
        }
      }
      if (b.assigned_to !== undefined && clean(b.assigned_to) !== clean(before.assigned_to)) {
        await history(id, { action: "assign", note: clean(b.assigned_to) || "Unassigned", actor_id: user.id, actor_name: actor });
      }
      if (b.vendor_name !== undefined && clean(b.vendor_name) !== clean(before.vendor_name)) {
        await history(id, { action: "vendor", note: clean(b.vendor_name) || "Vendor cleared", actor_id: user.id, actor_name: actor });
      }
      json(res, 200, await shape(id, true));
      return true;
    }

    const noteM = pathname.match(/^\/api\/maintenance\/requests\/(\d+)\/note$/);
    if (noteM && method === "POST") {
      if (!manage) { json(res, 403, { error: "Not permitted." }); return true; }
      const b = await readBody(req);
      if (!clean(b.note)) { json(res, 400, { error: "Write the note first." }); return true; }
      await history(Number(noteM[1]), { action: "note", note: clean(b.note), actor_id: user.id, actor_name: user.name || user.email });
      json(res, 200, await shape(Number(noteM[1]), true));
      return true;
    }

    const fileM = pathname.match(/^\/api\/maintenance\/requests\/(\d+)\/files$/);
    if (fileM && method === "POST") {
      const id = Number(fileM[1]);
      const row = await dbGet("SELECT * FROM maintenance_requests WHERE id = ?", [id]);
      if (!row) { json(res, 404, { error: "That request no longer exists." }); return true; }
      const isMine = clean(row.requester_email).toLowerCase() === myEmail;
      // An invoice or a receipt is the administrator's business. A photograph
      // of the broken thing is the reporter's, and they may add one after the
      // fact without being given the rest of the queue.
      const b = await readBody(req);
      const kind = clean(b.kind) || "photo";
      if (!manage && (!isMine || kind !== "photo")) { json(res, 403, { error: "Not permitted." }); return true; }
      const r = await saveFile(id, b, user.name || user.email);
      if (r && r.error) { json(res, 400, { error: r.error }); return true; }
      await history(id, { action: "attachment", note: `${kind}: ${clean(b.filename) || "file"}`, actor_id: user.id, actor_name: user.name || user.email });
      json(res, 200, await shape(id, true));
      return true;
    }

    const fileOne = pathname.match(/^\/api\/maintenance\/files\/(\d+)$/);
    if (fileOne && method === "GET") {
      const f = await dbGet("SELECT * FROM maintenance_request_files WHERE id = ?", [Number(fileOne[1])]);
      if (!f) { json(res, 404, { error: "Not found." }); return true; }
      const row = await dbGet("SELECT * FROM maintenance_requests WHERE id = ?", [f.request_id]);
      const isMine = row && clean(row.requester_email).toLowerCase() === myEmail;
      if (!manage && !isMine) { json(res, 403, { error: "Not permitted." }); return true; }
      if (!manage && f.kind !== "photo") { json(res, 403, { error: "Not permitted." }); return true; }
      if (sendFile) return sendFile(res, path.join(FILES_DIR, f.stored_name), f.mime_type, f.original_name), true;
      json(res, 500, { error: "Cannot serve that file." });
      return true;
    }

    if (pathname === "/api/maintenance/settings" && method === "GET") {
      if (!manage) { json(res, 403, { error: "Not permitted." }); return true; }
      json(res, 200, await settings());
      return true;
    }
    if (pathname === "/api/maintenance/settings" && method === "PUT") {
      if (!manage) { json(res, 403, { error: "Not permitted." }); return true; }
      const b = await readBody(req);
      const cfg = { notify_to: clean(b.notify_to), escalate_to: clean(b.escalate_to) };
      await dbRun(
        `INSERT INTO maintenance_settings (id, config, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(cfg), nowISO()]);
      json(res, 200, { ok: true, ...cfg });
      return true;
    }
    return false;
  }

  // The page anyone can reach without a login. Advertised on the queue screen,
  // so it has to exist: a printed URL that 404s is worse than no URL.
  async function servePage(req, res, pathname) {
    if (pathname === "/maintenance-request" || pathname === "/maintenance-request/") {
      const file = path.join(__dirname, "maintenance-request.html");
      if (fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(file, "utf8"));
        return true;
      }
    }
    return false;
  }

  return { initTables, handleApi, servePage, createRequest, saveFile, shape, _internal: { STATUSES, CATEGORIES, PRIORITIES, ESCALATING, canManage, history, settings, escalationRecipients, publicUrl, notifyNew, FILES_DIR, MAX_PHOTO_BYTES, newToken, clean, parseJson, STATUS_MESSAGE, OPEN_STATUSES } };
};
