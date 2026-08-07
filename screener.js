// screener.js -- Clinical Screener automation (add-on module)
// ---------------------------------------------------------------------------
// Progressive add-on, mirroring how pipeline-v2.js / attendance.js plug in
// without rewriting the core. server.js wires this in with a few small lines
// (see the SCREENER hooks in server.js). Everything else -- database tables,
// the send/reminder scheduler, the public form-hosting + submit endpoints, and
// the intake-team notification -- lives here.
//
// Flow:
//   1. Parent completes their SignNow enrollment packet.
//      (server.js/checkEnrollmentPackets marks enrollment_packets.status =
//      'completed'.)
//   2. This module notices that, emails the parent a private link to the cute
//      clinical screener form (clinical-screener.html, hosted at /screener/:token).
//   3. If they don't finish it, it re-sends a friendly reminder every 24h
//      (until completed; capped at MAX_REMINDERS as a runaway safety net).
//   4. On submit, responses are saved to the client's record
//      (clinical_screener_completed -> true) AND a copy is emailed to the
//      intake team.
// ---------------------------------------------------------------------------
"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function initScreener(ctx) {
  const { dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, PUBLIC_DIR } = ctx;

  // --- Config (override via Railway env vars; sensible defaults otherwise) ---
  // Comma-separated list supported, e.g. "owner@x.com, clinical@x.com"
  const TEAM_EMAILS = (process.env.SCREENER_TEAM_EMAIL || "intake@spectrumsquadlv.com")
    .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  const REMINDER_INTERVAL_HOURS = 24;   // "daily until done"
  const MAX_REMINDERS = 30;             // runaway safety net (~30 days of daily nudges)
  const FORM_FILE = path.join(PUBLIC_DIR, "clinical-screener.html");

  // --- One-time table setup (safe to run every boot) ---
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS screener_invites (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL UNIQUE,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'sent',
      sent_at TEXT NOT NULL,
      last_reminder_at TEXT,
      reminder_count INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS screener_submissions (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      token TEXT,
      data TEXT NOT NULL,
      submitted_at TEXT NOT NULL
    )`);
  }

  // --- Emails ---------------------------------------------------------------
  function emailShell(inner) {
    return `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;color:#241d52;">
      <div style="background:#1b2a6b;color:#fff;padding:20px 24px;border-radius:14px 14px 0 0;">
        <div style="font-size:20px;font-weight:800;">Spectrum Squad 🌈</div>
      </div>
      <div style="background:#ffffff;border:1px solid #e7e5f2;border-top:none;padding:24px;border-radius:0 0 14px 14px;line-height:1.6;">
        ${inner}
      </div>
      <p style="text-align:center;color:#7a7796;font-size:12px;margin:14px 0;">Spectrum Squad · Las Vegas, NV</p>
    </div>`;
  }

  function ctaButton(link, label) {
    return `<p style="text-align:center;margin:26px 0;">
      <a href="${link}" style="background:#e0a430;color:#3a2c05;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px;display:inline-block;">${label}</a>
    </p>
    <p style="font-size:12px;color:#7a7796;">Or paste this link into your browser:<br>${link}</p>`;
  }

  async function sendScreenerEmail(client, token, isReminder) {
    const link = `${APP_BASE_URL}/screener/${token}`;
    const parent = client.parent_name || "there";
    const child = client.child_name || "your child";
    const subject = isReminder
      ? `Reminder: ${child}'s clinical screener — Spectrum Squad`
      : `One more step for ${child} 🌈 — Spectrum Squad`;
    const intro = isReminder
      ? `<p>Hi ${parent},</p><p>Just a gentle reminder — we're still waiting on ${child}'s clinical screener. It takes about 10 minutes and works great on your phone. Whenever you have a moment! 💜</p>`
      : `<p>Hi ${parent},</p><p>Thank you for completing ${child}'s enrollment packet! 🎉</p><p>The last step to get started is a short clinical screener so our clinical team can build the perfect care plan. It's quick (about 10 minutes), phone-friendly, and there are no wrong answers.</p>`;
    const html = emailShell(intro + ctaButton(link, "Start the Screener →"));
    await sendEmail({
      to: client.parent_email,
      subject,
      html,
      clientId: client.id,
      type: isReminder ? "screener_reminder" : "screener_invite",
    });
  }

  async function notifyTeam(client, data) {
    const child = client.child_name || "A client";
    // Recipient is configurable in Admin Settings ("Completed screener
    // recipient"); falls back to SCREENER_TEAM_EMAIL. Sent as an email only —
    // completing a screener never creates a task for anyone.
    let recipients = TEAM_EMAILS;
    const cfg = await dbGet("SELECT value FROM app_settings WHERE key = ?", ["screener_completed_recipient"]).catch(() => null);
    if (cfg && cfg.value) recipients = cfg.value.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    const clientLink = `${APP_BASE_URL}/#/pipeline/${client.id}`;
    const rows = Object.keys(data)
      .filter((k) => !k.startsWith("_"))
      .map((k) => {
        const v = Array.isArray(data[k]) ? data[k].join(", ") : data[k];
        if (v === undefined || v === null || v === "") return "";
        return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:600;color:#1b2a6b;vertical-align:top;">${k}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${String(v).replace(/</g, "&lt;")}</td></tr>`;
      })
      .join("");
    const html = emailShell(
      `<p><strong>${child}</strong> just completed their clinical screener. ✅</p>
       <p>It's saved on their record: <a href="${clientLink}">open in the CRM →</a></p>
       <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px;">${rows}</table>`
    );
    for (const addr of recipients) {
      await sendEmail({
        to: addr,
        subject: `✅ Clinical screener completed — ${child}`,
        html,
        clientId: client.id,
        type: "screener_team_notification",
      });
    }
  }

  // --- Trigger + reminder scheduler ----------------------------------------
  async function createAndSend(client) {
    const token = crypto.randomBytes(24).toString("hex");
    await dbRun(
      `INSERT INTO screener_invites (client_id, token, status, sent_at)
       VALUES (?, ?, 'sent', ?) ON CONFLICT (client_id) DO NOTHING`,
      [client.id, token, nowISO()]
    );
    const inv = await dbGet("SELECT * FROM screener_invites WHERE client_id = ?", [client.id]);
    if (inv) await sendScreenerEmail(client, inv.token, false);
  }

  async function tick() {
    // 1. Packet completed + screener not done + no invite yet -> send it.
    const toSend = await dbAll(
      `SELECT c.* FROM clients c
       JOIN enrollment_packets p ON p.client_id = c.id
       WHERE p.status = 'completed'
         AND c.clinical_screener_completed = false
         AND c.parent_email IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM screener_invites si WHERE si.client_id = c.id)`
    );
    for (const client of toSend) {
      try { await createAndSend(client); }
      catch (e) { console.error("[screener] send failed for client", client.id, e.message); }
    }

    // 2. Daily reminders for still-pending invites.
    const pending = await dbAll("SELECT * FROM screener_invites WHERE status = 'sent'");
    const now = Date.now();
    for (const inv of pending) {
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [inv.client_id]);
      if (!client) continue;
      if (client.clinical_screener_completed) {
        await dbRun("UPDATE screener_invites SET status = 'completed', completed_at = ? WHERE id = ?", [nowISO(), inv.id]);
        continue;
      }
      if (!client.parent_email || inv.reminder_count >= MAX_REMINDERS) continue;
      const last = inv.last_reminder_at ? new Date(inv.last_reminder_at).getTime() : new Date(inv.sent_at).getTime();
      const hours = (now - last) / (1000 * 60 * 60);
      if (hours >= REMINDER_INTERVAL_HOURS) {
        try {
          await sendScreenerEmail(client, inv.token, true);
          await dbRun("UPDATE screener_invites SET last_reminder_at = ?, reminder_count = reminder_count + 1 WHERE id = ?", [nowISO(), inv.id]);
        } catch (e) { console.error("[screener] reminder failed for client", client.id, e.message); }
      }
    }
  }

  function startScheduler() {
    setTimeout(() => { tick().catch((e) => console.error("[screener] tick failed:", e.message)); }, 45 * 1000);
    setInterval(() => { tick().catch((e) => console.error("[screener] tick failed:", e.message)); }, 60 * 60 * 1000);
  }

  // --- Public form hosting: GET /screener/:token ---------------------------
  async function servePage(req, res, pathname) {
    const parts = pathname.split("/").filter(Boolean); // ["screener", "<token>"]
    const token = parts[1];
    const notFound = (msg) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:sans-serif;max-width:440px;margin:60px auto;text-align:center;color:#241d52;padding:0 20px;"><div style="font-size:44px;">🌈</div><h2>${msg}</h2><p style="color:#7a7796;">If you think this is a mistake, please contact Spectrum Squad and we'll send you a fresh link.</p></div>`);
      return true;
    };
    if (!token) return notFound("This screener link looks incomplete.");
    let inv;
    try { inv = await dbGet("SELECT * FROM screener_invites WHERE token = ?", [token]); }
    catch (e) { inv = null; }
    if (!inv) return notFound("This screener link is invalid or has expired.");

    let html;
    try { html = fs.readFileSync(FORM_FILE, "utf8"); }
    catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Screener form unavailable.");
      return true;
    }
    html = html
      .replace('var SUBMIT_ENDPOINT = "";', 'var SUBMIT_ENDPOINT = "/api/screener/submit";')
      .replace('var SCREENER_TOKEN = "";', 'var SCREENER_TOKEN = ' + JSON.stringify(token) + ';');
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }

  // --- API: submit (public) + staff view (auth) ----------------------------
  async function handleApi(req, res, pathname, method, query, user) {
    // Public submit -- parents are not logged in.
    if (pathname === "/api/screener/submit" && method === "POST") {
      let body;
      try { body = await readBody(req); } catch (e) { json(res, 400, { error: "Bad request" }); return true; }
      const token = body && body._token;
      if (!token) { json(res, 400, { error: "Missing token" }); return true; }
      const inv = await dbGet("SELECT * FROM screener_invites WHERE token = ?", [token]);
      if (!inv) { json(res, 404, { error: "Invalid link" }); return true; }
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [inv.client_id]);
      if (!client) { json(res, 404, { error: "Client not found" }); return true; }

      await dbRun(
        "INSERT INTO screener_submissions (client_id, token, data, submitted_at) VALUES (?, ?, ?, ?)",
        [client.id, token, JSON.stringify(body), nowISO()]
      );
      await dbRun("UPDATE clients SET clinical_screener_completed = true, updated_at = ? WHERE id = ?", [nowISO(), client.id]);
      await dbRun("UPDATE screener_invites SET status = 'completed', completed_at = ? WHERE id = ?", [nowISO(), inv.id]);
      notifyTeam(client, body).catch((e) => console.error("[screener] team notify failed:", e.message));
      json(res, 200, { ok: true });
      return true;
    }

    // Staff view of a client's submission (auth required).
    if (pathname.startsWith("/api/screener/submission/") && method === "GET") {
      if (!user) { json(res, 401, { error: "Not authenticated" }); return true; }
      const clientId = pathname.split("/").pop();
      const row = await dbGet(
        "SELECT * FROM screener_submissions WHERE client_id = ? ORDER BY submitted_at DESC LIMIT 1",
        [clientId]
      );
      if (!row) { json(res, 404, { error: "No screener on file" }); return true; }
      let data = {};
      try { data = JSON.parse(row.data); } catch (e) {}
      json(res, 200, { submitted_at: row.submitted_at, data });
      return true;
    }

    return false;
  }

  // Boot
  initTables()
    .then(startScheduler)
    .catch((e) => console.error("[screener] init failed:", e.message));

  return { handleApi, servePage, tick, initTables };
};
