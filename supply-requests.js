// supply-requests.js -- Spectrum Squad CRM: Clinic Supply / Shopping Requests.
//
// Self-contained add-on (ot.js pattern). Staff submit a supply request from a
// PUBLIC tokenized link (no login): what item, how much, a link or a photo, and
// notes. Each request gets its own tracking token so the requester can follow
// status without an account, and is emailed on every status change.
//
// Owns all /api/supply/* routes and serves the public /supply-request page.
// Admin management (owner / super_admin / admin) walks the request through the
// full flow: Submitted -> Approved -> Ordered -> Received (or Denied), emailing
// the requester each step. Reuses the shared sendEmail() + the Railway volume.
"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function initSupply(ctx) {
  const { dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, sendFile } = ctx;

  const DATA_DIR = path.join(__dirname, "data");
  const SUPPLY_DIR = path.join(DATA_DIR, "supply-files");
  if (!fs.existsSync(SUPPLY_DIR)) fs.mkdirSync(SUPPLY_DIR, { recursive: true });

  const ADMIN_ROLES = ["owner", "super_admin", "admin"];

  // A per-user grant from the Access editor unlocks this module's ordinary
  // access tier even when the role list wouldn't. Manage/sensitive tiers stay
  // role-gated.
  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  function canAdmin(user) { return !!user && (ADMIN_ROLES.includes(user.role) || granted(user, "supply")); }
  // Only the practice OWNER (role 'owner' — Quiana) may see the full supply
  // queue. Everyone else sees only the requests they submitted themselves.
  function isOwner(user) { return !!user && user.role === "owner"; }

  // Full status flow. Denied is reachable from any open state; Received/Denied
  // are terminal.
  const STATUSES = ["Submitted", "Approved", "Ordered", "Received", "Denied"];
  const OPEN_STATUSES = ["Submitted", "Approved", "Ordered"];
  const STATUS_MESSAGE = {
    Approved: "Your request has been approved and is queued for ordering.",
    Ordered: "Your item has been ordered. We'll let you know when it arrives.",
    Received: "Your item has been received. Check with your clinic lead to pick it up.",
    Denied: "Your request was not approved. Reach out to an administrator with any questions.",
  };

  function newToken() { return crypto.randomBytes(20).toString("hex"); }
  function parseJson(s, f) { try { return s ? JSON.parse(s) : f; } catch (e) { return f; } }
  const MAX_PHOTO_BYTES = 6 * 1024 * 1024; // ~6MB decoded cap

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS supply_requests (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      requester_name TEXT,
      requester_email TEXT,
      location TEXT,                       -- which clinic / site (optional)
      item_name TEXT NOT NULL,
      quantity TEXT,                       -- "how much" (free text: "2 boxes")
      item_url TEXT,
      photo_stored TEXT,
      photo_mime TEXT,
      notes TEXT,
      priority TEXT DEFAULT 'Normal',
      estimated_cost NUMERIC,
      status TEXT NOT NULL DEFAULT 'Submitted',
      created_at TEXT,
      updated_at TEXT
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS supply_request_history (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      action TEXT NOT NULL,                -- submitted|status_change|note|edit
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      notified BOOLEAN DEFAULT false,
      actor_id INTEGER,
      actor_name TEXT,
      created_at TEXT
    )`);
    // Owner-configurable recipients for new-request alerts.
    await dbRun(`CREATE TABLE IF NOT EXISTS supply_settings (
      id INTEGER PRIMARY KEY,
      config TEXT NOT NULL,
      updated_at TEXT
    )`);
    const s = await dbGet("SELECT id FROM supply_settings WHERE id = 1");
    if (!s) await dbRun("INSERT INTO supply_settings (id, config, updated_at) VALUES (1, ?, ?)",
      [JSON.stringify({ notify_emails: "" }), nowISO()]);
  }

  async function getSettings() {
    const row = await dbGet("SELECT config FROM supply_settings WHERE id = 1");
    return Object.assign({ notify_emails: "" }, row ? parseJson(row.config, {}) : {});
  }

  async function history(requestId, entry) {
    await dbRun(
      `INSERT INTO supply_request_history (request_id, action, from_status, to_status, note, notified, actor_id, actor_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [requestId, entry.action, entry.from_status || null, entry.to_status || null, entry.note || null,
       !!entry.notified, entry.actor_id || null, entry.actor_name || null, nowISO()]
    );
  }

  function trackUrl(token) {
    const base = (APP_BASE_URL || "").replace(/\/$/, "");
    return `${base}/supply-request?track=${token}`;
  }

  function statusColor(status) {
    return { Submitted: "#6366f1", Approved: "#0891b2", Ordered: "#ca8a04", Received: "#16a34a", Denied: "#dc2626" }[status] || "#64748b";
  }

  function requesterEmailHtml(reqRow, toStatus, note) {
    const msg = STATUS_MESSAGE[toStatus] || "Your request status has been updated.";
    return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:540px;margin:0 auto;color:#111;">
      <div style="background:#4f46e5;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;font-size:17px;font-weight:700;">Spectrum Squad — Supply Request Update</div>
      <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:20px;">
        <p style="margin:0 0 12px;">Hi ${reqRow.requester_name || "there"},</p>
        <p style="margin:0 0 14px;">Your request for <strong>${escapeHtml(reqRow.item_name)}</strong>${reqRow.quantity ? " (" + escapeHtml(reqRow.quantity) + ")" : ""} is now:</p>
        <div style="display:inline-block;background:${statusColor(toStatus)};color:#fff;font-weight:700;padding:6px 14px;border-radius:20px;margin-bottom:14px;">${toStatus}</div>
        <p style="margin:0 0 14px;color:#334155;">${msg}</p>
        ${note ? `<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:14px;"><b>Note:</b> ${escapeHtml(note)}</div>` : ""}
        <a href="${trackUrl(reqRow.token)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Track this request</a>
        <p style="margin:16px 0 0;color:#64748b;font-size:12px;">You're receiving this because you submitted a supply request to Spectrum Squad.</p>
      </div>
    </div>`;
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function publicView(r) {
    // What the public tracking page is allowed to see (no internal cost, etc.).
    return {
      token: r.token, item_name: r.item_name, quantity: r.quantity, item_url: r.item_url,
      has_photo: !!r.photo_stored, notes: r.notes, status: r.status, priority: r.priority,
      requester_name: r.requester_name, location: r.location,
      created_at: r.created_at, updated_at: r.updated_at,
    };
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/supply/")) return false;

    // ---------------- PUBLIC (tokenized, no login) ----------------
    if (pathname === "/api/supply/public/submit" && method === "POST") {
      const b = await readBody(req);
      const itemName = (b.item_name || "").trim();
      const email = (b.requester_email || "").trim();
      if (!itemName) return (json(res, 400, { error: "Please enter the item you need." }), true);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return (json(res, 400, { error: "Please enter a valid email so we can send you status updates." }), true);

      let photoStored = null, photoMime = null;
      if (b.photo_base64) {
        const buf = Buffer.from(b.photo_base64, "base64");
        if (buf.length > MAX_PHOTO_BYTES) return (json(res, 400, { error: "Photo is too large (max ~6MB)." }), true);
        photoStored = newToken() + ".img";
        fs.writeFileSync(path.join(SUPPLY_DIR, photoStored), buf);
        photoMime = b.photo_mime || "image/jpeg";
      }
      const token = newToken();
      const now = nowISO();
      const row = await dbGet(
        `INSERT INTO supply_requests
          (token, requester_name, requester_email, location, item_name, quantity, item_url, photo_stored, photo_mime, notes, priority, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?) RETURNING *`,
        [token, (b.requester_name || "").trim() || null, email, (b.location || "").trim() || null,
         itemName, (b.quantity || "").trim() || null, (b.item_url || "").trim() || null,
         photoStored, photoMime, (b.notes || "").trim() || null, (b.priority || "Normal"), now, now]
      );
      await history(row.id, { action: "submitted", to_status: "Submitted", actor_name: row.requester_name || "Requester" });

      // Confirmation to the requester.
      try {
        await sendEmail({
          to: email,
          subject: `We got your supply request — ${itemName}`,
          html: requesterEmailHtml(row, "Submitted", null).replace("is now:", "has been received and is now:"),
          type: "supply_request",
        });
      } catch (e) { /* logged by sendEmail */ }

      // Optional internal alert to configured recipients.
      try {
        const s = await getSettings();
        const recips = (s.notify_emails || "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
        if (recips.length) {
          await sendEmail({
            to: recips.join(","),
            subject: `New supply request: ${itemName}`,
            html: `<p>New supply request submitted.</p><ul><li><b>Item:</b> ${escapeHtml(itemName)}</li><li><b>How much:</b> ${escapeHtml(row.quantity || "—")}</li><li><b>From:</b> ${escapeHtml(row.requester_name || "—")} (${escapeHtml(email)})</li><li><b>Clinic/site:</b> ${escapeHtml(row.location || "—")}</li>${row.item_url ? `<li><b>Link:</b> <a href="${escapeHtml(row.item_url)}">${escapeHtml(row.item_url)}</a></li>` : ""}</ul><p>Open the CRM → Supply Requests to review.</p>`,
            type: "supply_request_alert",
          });
        }
      } catch (e) { /* non-fatal */ }

      return (json(res, 200, { ok: true, token, trackUrl: trackUrl(token) }), true);
    }

    const pubTrack = pathname.match(/^\/api\/supply\/public\/track\/([a-f0-9]+)$/);
    if (pubTrack && method === "GET") {
      const r = await dbGet("SELECT * FROM supply_requests WHERE token = ?", [pubTrack[1]]);
      if (!r) return (json(res, 404, { error: "We couldn't find that request." }), true);
      const hist = await dbAll(
        "SELECT action, from_status, to_status, note, created_at FROM supply_request_history WHERE request_id = ? ORDER BY id ASC",
        [r.id]
      );
      // Public timeline hides internal actor identities and admin-only notes on edits.
      const timeline = hist
        .filter((h) => h.action === "submitted" || h.action === "status_change")
        .map((h) => ({ status: h.to_status, note: h.action === "status_change" ? h.note : null, at: h.created_at }));
      return (json(res, 200, { request: publicView(r), timeline }), true);
    }

    const pubPhoto = pathname.match(/^\/api\/supply\/public\/photo\/([a-f0-9]+)$/);
    if (pubPhoto && method === "GET") {
      const r = await dbGet("SELECT photo_stored, photo_mime FROM supply_requests WHERE token = ?", [pubPhoto[1]]);
      if (!r || !r.photo_stored) return (json(res, 404, { error: "No photo" }), true);
      const full = path.join(SUPPLY_DIR, r.photo_stored);
      if (!fs.existsSync(full)) return (json(res, 404, { error: "No photo" }), true);
      return (sendFile(res, 200, fs.readFileSync(full), r.photo_mime || "image/jpeg", "supply-photo"), true);
    }

    // ---------------- AUTHENTICATED (any signed-in staff) ----------------
    // Visibility rule (Change 5): the OWNER sees every request; any other
    // signed-in user sees ONLY the requests they submitted (matched on their
    // account email == requester_email). The "add order" form itself is the
    // PUBLIC page above, so submitting is open to everyone.
    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }
    const owner = isOwner(user);
    const myEmail = (user.email || "").trim().toLowerCase();
    const mineClause = owner ? "" : " AND lower(trim(requester_email)) = ?";
    const mineArg = owner ? [] : [myEmail];

    if (pathname === "/api/supply/requests" && method === "GET") {
      const status = query.status;
      let rows;
      if (status === "open") {
        rows = await dbAll(`SELECT * FROM supply_requests WHERE status IN ('Submitted','Approved','Ordered')${mineClause} ORDER BY id DESC`, mineArg);
      } else if (status && STATUSES.includes(status)) {
        rows = await dbAll(`SELECT * FROM supply_requests WHERE status = ?${mineClause} ORDER BY id DESC`, [status, ...mineArg]);
      } else {
        rows = await dbAll(`SELECT * FROM supply_requests WHERE 1=1${mineClause} ORDER BY id DESC LIMIT 300`, mineArg);
      }
      const counts = {};
      for (const st of STATUSES) {
        const c = await dbGet(`SELECT COUNT(*)::int AS c FROM supply_requests WHERE status = ?${mineClause}`, [st, ...mineArg]);
        counts[st] = c ? c.c : 0;
      }
      return (json(res, 200, { rows: rows.map(adminView), counts, statuses: STATUSES, is_owner: owner }), true);
    }

    const detail = pathname.match(/^\/api\/supply\/requests\/(\d+)$/);
    if (detail && method === "GET") {
      const r = await dbGet("SELECT * FROM supply_requests WHERE id = ?", [detail[1]]);
      if (!r) return (json(res, 404, { error: "Not found" }), true);
      // Non-owners may only open their own request.
      if (!owner && (r.requester_email || "").trim().toLowerCase() !== myEmail) {
        return (json(res, 403, { error: "Not permitted." }), true);
      }
      const hist = await dbAll("SELECT * FROM supply_request_history WHERE request_id = ? ORDER BY id ASC", [r.id]);
      return (json(res, 200, { request: adminView(r), history: hist }), true);
    }

    // ---------------- ADMIN (owner / super_admin / admin) ----------------
    // Managing requests (status changes, edits, notes, settings) stays gated to
    // administrators; the visibility rule above governs who can READ them.
    if (!canAdmin(user)) { json(res, 403, { error: "Not permitted to manage supply requests." }); return true; }

    // Change status (+ optional note) and email the requester.
    const statusChange = pathname.match(/^\/api\/supply\/requests\/(\d+)\/status$/);
    if (statusChange && method === "POST") {
      const r = await dbGet("SELECT * FROM supply_requests WHERE id = ?", [statusChange[1]]);
      if (!r) return (json(res, 404, { error: "Not found" }), true);
      const b = await readBody(req);
      const toStatus = b.status;
      if (!STATUSES.includes(toStatus)) return (json(res, 400, { error: "Invalid status" }), true);
      const from = r.status;
      await dbRun("UPDATE supply_requests SET status = ?, updated_at = ? WHERE id = ?", [toStatus, nowISO(), r.id]);

      let notified = false;
      if (toStatus !== from && r.requester_email && b.notify !== false) {
        try {
          await sendEmail({
            to: r.requester_email,
            subject: `Supply request ${toStatus.toLowerCase()} — ${r.item_name}`,
            html: requesterEmailHtml(r, toStatus, b.note || null),
            type: "supply_request",
          });
          notified = true;
        } catch (e) { notified = false; }
      }
      await history(r.id, { action: "status_change", from_status: from, to_status: toStatus, note: b.note || null, notified, actor_id: user.id, actor_name: user.name || user.email });
      return (json(res, 200, { ok: true, status: toStatus, notified }), true);
    }

    // Admin edits (quantity, cost, notes, item link) — never emails.
    if (detail && method === "PATCH") {
      const r = await dbGet("SELECT * FROM supply_requests WHERE id = ?", [detail[1]]);
      if (!r) return (json(res, 404, { error: "Not found" }), true);
      const b = await readBody(req);
      const allowed = ["quantity", "item_url", "notes", "priority", "location", "item_name"];
      const sets = [], vals = [];
      for (const f of allowed) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
      if (b.estimated_cost !== undefined) { sets.push("estimated_cost = ?"); vals.push(b.estimated_cost === "" || b.estimated_cost == null ? null : Number(b.estimated_cost)); }
      if (!sets.length) return (json(res, 200, adminView(r)), true);
      sets.push("updated_at = ?"); vals.push(nowISO());
      vals.push(r.id);
      const updated = await dbGet(`UPDATE supply_requests SET ${sets.join(", ")} WHERE id = ? RETURNING *`, vals);
      await history(r.id, { action: "edit", note: "Details updated", actor_id: user.id, actor_name: user.name || user.email });
      return (json(res, 200, adminView(updated)), true);
    }

    // Add an internal note (no email).
    const noteMatch = pathname.match(/^\/api\/supply\/requests\/(\d+)\/note$/);
    if (noteMatch && method === "POST") {
      const r = await dbGet("SELECT id FROM supply_requests WHERE id = ?", [noteMatch[1]]);
      if (!r) return (json(res, 404, { error: "Not found" }), true);
      const b = await readBody(req);
      await history(r.id, { action: "note", note: b.note || "", actor_id: user.id, actor_name: user.name || user.email });
      return (json(res, 200, { ok: true }), true);
    }

    // Serve the photo to an admin (by id).
    const adminPhoto = pathname.match(/^\/api\/supply\/requests\/(\d+)\/photo$/);
    if (adminPhoto && method === "GET") {
      const r = await dbGet("SELECT photo_stored, photo_mime FROM supply_requests WHERE id = ?", [adminPhoto[1]]);
      if (!r || !r.photo_stored) return (json(res, 404, { error: "No photo" }), true);
      const full = path.join(SUPPLY_DIR, r.photo_stored);
      if (!fs.existsSync(full)) return (json(res, 404, { error: "No photo" }), true);
      return (sendFile(res, 200, fs.readFileSync(full), r.photo_mime || "image/jpeg", "supply-photo"), true);
    }

    // Settings (notification recipients).
    if (pathname === "/api/supply/settings" && method === "GET") {
      return (json(res, 200, await getSettings()), true);
    }
    if (pathname === "/api/supply/settings" && method === "PUT") {
      const b = await readBody(req);
      const merged = Object.assign(await getSettings(), { notify_emails: (b.notify_emails || "").trim() });
      await dbRun("UPDATE supply_settings SET config = ?, updated_at = ? WHERE id = 1", [JSON.stringify(merged), nowISO()]);
      return (json(res, 200, merged), true);
    }

    return false;
  }

  function adminView(r) {
    return {
      id: r.id, token: r.token, requester_name: r.requester_name, requester_email: r.requester_email,
      location: r.location, item_name: r.item_name, quantity: r.quantity, item_url: r.item_url,
      has_photo: !!r.photo_stored, notes: r.notes, priority: r.priority,
      estimated_cost: r.estimated_cost == null ? null : Number(r.estimated_cost),
      status: r.status, created_at: r.created_at, updated_at: r.updated_at,
      trackUrl: trackUrl(r.token),
    };
  }

  // Serve the public submit + track page.
  async function servePage(req, res, pathname) {
    if (pathname === "/supply-request" || pathname === "/supply-request/") {
      const file = path.join(__dirname, "supply-request.html");
      if (fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(file, "utf8"));
        return true;
      }
    }
    return false;
  }

  return { initTables, handleApi, servePage, canAdmin, STATUSES };
};
