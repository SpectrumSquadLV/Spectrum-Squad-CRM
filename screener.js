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
  // Optional so this module still loads standalone; a missing recorder must
  // never break a parent's submission.
  const onCompletion = ctx.onCompletion || (() => {});
  // Who should not be chased about intake paperwork -- intake-chasing.js owns
  // the rule (waitlisted, in active therapy, or closed out).
  const chasingPaused = ctx.intakeChasingPaused || require("./intake-chasing").intakeChasingPaused;
  // Editable wording for the two parent-facing screener emails. Optional for
  // the same reason: without them the module falls back to its built-in copy
  // rather than failing to send.
  const getEmailTemplate = ctx.getEmailTemplate || null;
  const renderMergeFields = ctx.renderMergeFields || null;

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
    // Manual sends live on the SAME invite row as the automated ones -- one
    // screener, one token, one history. These three columns only record who
    // pressed the button and when, so staff can tell a hand-sent screener from
    // an automatic one without a second table.
    await dbRun("ALTER TABLE screener_invites ADD COLUMN IF NOT EXISTS last_manual_sent_at TEXT").catch(() => {});
    await dbRun("ALTER TABLE screener_invites ADD COLUMN IF NOT EXISTS last_manual_sent_by TEXT").catch(() => {});
    await dbRun("ALTER TABLE screener_invites ADD COLUMN IF NOT EXISTS manual_send_count INTEGER NOT NULL DEFAULT 0").catch(() => {});
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

  // The wording comes from the editable templates (Settings -> Email Templates
  // -> Clinical Screener Emails), not from this file. The inline copy below is
  // only a fallback for the case where the template row is somehow missing --
  // a family must never go without their screener because a row vanished.
  async function renderScreenerEmail(client, link, isReminder) {
    const parent = client.parent_name || "there";
    const child = client.child_name || "your child";
    const key = isReminder ? "screener_reminder" : "screener_invite";

    let subject = null, body = null;
    if (getEmailTemplate && renderMergeFields) {
      const tpl = await getEmailTemplate(key).catch(() => null);
      if (tpl && tpl.body_template) {
        const fields = { parent_name: parent, child_name: child, screener_link: link };
        subject = renderMergeFields(tpl.subject_template, fields);
        body = renderMergeFields(tpl.body_template, fields);
      }
    }

    if (body == null) {
      console.error(`[screener] no ${key} template found -- falling back to the built-in wording`);
      subject = isReminder
        ? `Reminder: ${child}'s clinical screener — Spectrum Squad`
        : `One more step for ${child} 🌈 — Spectrum Squad`;
      const intro = isReminder
        ? `<p>Hi ${parent},</p><p>Just a gentle reminder — we're still waiting on ${child}'s clinical screener. It takes about 10 minutes and works great on your phone. Whenever you have a moment! 💜</p>`
        : `<p>Hi ${parent},</p><p>Thank you for completing ${child}'s enrollment packet! 🎉</p><p>The last step to get started is a short clinical screener so our clinical team can build the perfect care plan. It's quick (about 10 minutes), phone-friendly, and there are no wrong answers.</p>`;
      body = intro + ctaButton(link, "Start the Screener →");
    }

    // The link is the entire point of this email. If an edit dropped
    // {{screener_link}}, the parent would get a friendly note asking them to
    // complete a screener with no way to reach it -- so the button is put back
    // rather than sending something useless. Noisy in the log on purpose.
    if (!body.includes(link)) {
      console.error(`[screener] the ${key} template has no {{screener_link}} in it -- appending the link so the email still works`);
      body += ctaButton(link, "Start the Screener →");
    }
    if (!String(subject || "").trim()) {
      subject = isReminder ? `Reminder: ${child}'s clinical screener` : `One more step for ${child} — Spectrum Squad`;
    }
    return { subject, html: body };
  }

  async function sendScreenerEmail(client, token, isReminder) {
    const link = `${APP_BASE_URL}/screener/${token}`;
    const { subject, html } = await renderScreenerEmail(client, link, isReminder);
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
    // Families who should not be chased are filtered in JS rather than SQL so
    // the rule lives in exactly one place (chasingPaused), and applies here and
    // in the reminder pass below. Nothing is lost by skipping: this query picks
    // a family up again on the next sweep once chasing resumes.
    const candidates = await dbAll(
      `SELECT c.* FROM clients c
       JOIN enrollment_packets p ON p.client_id = c.id
       WHERE p.status = 'completed'
         AND c.clinical_screener_completed = false
         AND c.parent_email IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM screener_invites si WHERE si.client_id = c.id)`
    );
    const toSend = candidates.filter((c) => !chasingPaused(c));
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
      // Paused, not cancelled: the invite stays 'sent' and its reminder count
      // is untouched, so a family who waits a month does not burn through
      // their 30 reminders while nobody is asking them for anything.
      if (chasingPaused(client)) continue;
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

  // --- Manual send (staff button on the client record) ----------------------
  // Deliberately reuses createAndSend()'s invite row and token: a hand-sent
  // screener is the SAME screener, so a family never ends up with two links,
  // and anything they already filled in against that token still counts.
  //
  // The automation sends only once the SignNow enrollment packet comes back
  // completed. When that packet stalls -- or SignNow is down, or the family
  // signed on paper -- nothing ever reaches the parent. This is the manual
  // override for exactly that case.
  const MANUAL_RESEND_COOLDOWN_HOURS = 12;

  async function screenerStatus(clientId) {
    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
    if (!client) return null;
    const inv = await dbGet("SELECT * FROM screener_invites WHERE client_id = ?", [clientId]);
    const packet = await dbGet("SELECT status, sent_at, completed_at FROM enrollment_packets WHERE client_id = ?", [clientId]).catch(() => null);
    const lastSentAt = inv ? (inv.last_manual_sent_at || inv.last_reminder_at || inv.sent_at) : null;
    const hoursSince = lastSentAt ? (Date.now() - new Date(lastSentAt).getTime()) / 3600000 : null;
    // Why hasn't it gone out by itself? Said plainly, so nobody has to guess.
    let autoBlockedReason = null;
    if (!client.parent_email) autoBlockedReason = "No parent email is on file for this family.";
    else if (client.clinical_screener_completed) autoBlockedReason = null;
    else if (chasingPaused(client)) {
      // Paused, not blocked: staff can still send it by hand from this screen.
      autoBlockedReason = require("./intake-chasing").pauseReason(client)
        + " You can still send it by hand.";
    }
    else if (!inv && (!packet || packet.status !== "completed")) {
      autoBlockedReason = packet
        ? `The screener sends automatically once the enrollment packet is signed. That packet is currently "${packet.status}".`
        : "The screener sends automatically once the enrollment packet is signed. No enrollment packet has been sent yet.";
    }
    return {
      client_id: Number(clientId),
      has_parent_email: !!client.parent_email,
      parent_email: client.parent_email || null,
      completed: !!client.clinical_screener_completed,
      completed_at: inv && inv.completed_at ? inv.completed_at : null,
      invited: !!inv,
      first_sent_at: inv ? inv.sent_at : null,
      last_sent_at: lastSentAt,
      last_manual_sent_at: inv ? inv.last_manual_sent_at || null : null,
      last_manual_sent_by: inv ? inv.last_manual_sent_by || null : null,
      manual_send_count: inv ? Number(inv.manual_send_count || 0) : 0,
      reminder_count: inv ? Number(inv.reminder_count || 0) : 0,
      packet_status: packet ? packet.status : null,
      auto_blocked_reason: autoBlockedReason,
      // The button asks for confirmation rather than refusing outright: a
      // resend is sometimes exactly what is wanted (wrong address, lost email).
      resend_cooldown_hours: MANUAL_RESEND_COOLDOWN_HOURS,
      recently_sent: hoursSince != null && hoursSince < MANUAL_RESEND_COOLDOWN_HOURS,
    };
  }

  // force=false is the accident guard: a second press inside the cooldown, or a
  // press on an already-completed screener, comes back as a question instead of
  // a duplicate email. force=true is the deliberate resend.
  async function sendManual(clientId, actor, force) {
    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
    if (!client) return { ok: false, status: 404, error: "Client not found." };
    if (!client.parent_email) {
      return { ok: false, status: 400, error: "This family has no parent email on file, so the screener can't be sent." };
    }
    const existing = await dbGet("SELECT * FROM screener_invites WHERE client_id = ?", [clientId]);

    if (client.clinical_screener_completed && !force) {
      return {
        ok: false, status: 409, code: "already_completed",
        error: "This family already completed their clinical screener. Send it again anyway?",
      };
    }
    if (existing && !force) {
      const lastAt = existing.last_manual_sent_at || existing.last_reminder_at || existing.sent_at;
      const hours = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 3600000 : Infinity;
      if (hours < MANUAL_RESEND_COOLDOWN_HOURS) {
        return {
          ok: false, status: 409, code: "recently_sent",
          error: `The screener was already sent to this family ${hours < 1 ? "less than an hour" : Math.floor(hours) + " hours"} ago. Send it again anyway?`,
          last_sent_at: lastAt,
        };
      }
    }

    // Same token if one exists; a fresh invite only when there is none.
    if (!existing) {
      const token = crypto.randomBytes(24).toString("hex");
      await dbRun(
        `INSERT INTO screener_invites (client_id, token, status, sent_at)
         VALUES (?, ?, 'sent', ?) ON CONFLICT (client_id) DO NOTHING`,
        [clientId, token, nowISO()]
      );
    }
    const inv = await dbGet("SELECT * FROM screener_invites WHERE client_id = ?", [clientId]);
    if (!inv) return { ok: false, status: 500, error: "Could not create the screener invite." };

    // A resend reads as a reminder to the parent; a first send reads as the
    // original invitation. Both use the existing screener email templates.
    const isReminder = !!(existing && (existing.reminder_count > 0 || existing.last_manual_sent_at || existing.completed_at));
    await sendScreenerEmail(client, inv.token, isReminder);

    // Reopen a completed invite only on a deliberate resend, so the reminder
    // sweep starts chasing it again.
    await dbRun(
      `UPDATE screener_invites
          SET last_manual_sent_at = ?, last_manual_sent_by = ?,
              manual_send_count = COALESCE(manual_send_count, 0) + 1,
              last_reminder_at = ?,
              status = CASE WHEN ? THEN 'sent' ELSE status END,
              completed_at = CASE WHEN ? THEN NULL ELSE completed_at END
        WHERE id = ?`,
      [nowISO(), actor || "staff", nowISO(),
       !client.clinical_screener_completed, !client.clinical_screener_completed, inv.id]
    );

    return { ok: true, status: 200, sent_to: client.parent_email, sent_at: nowISO(), sent_by: actor || "staff", resend: !!existing };
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

  // A screener holds diagnoses, self-injury history and medical background.
  // "Logged in" is not enough -- HR-side and OT-only accounts must not read it
  // or send it. One list, used by every screener route, so read access and
  // send access can never drift apart.
  const SCREENER_ROLES = ["owner", "super_admin", "admin", "intake", "clinical", "billing", "scheduling"];
  function canSendScreener(user) {
    return !!user && (SCREENER_ROLES.includes(user.role) || (ctx.moduleGranted && ctx.moduleGranted(user, "pipeline")));
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
      onCompletion("screener_completed", {
        subject: client.child_name,
        clientId: client.id,
        dedupeKey: `screener:${inv.id}`,
        link: `${APP_BASE_URL}/#/pipeline/${client.id}`,
      });
      notifyTeam(client, body).catch((e) => console.error("[screener] team notify failed:", e.message));
      json(res, 200, { ok: true });
      return true;
    }

    // Clinical-screener status for one client: has it been sent, when, by
    // whom, and -- if it has not gone out on its own -- why not.
    const statusMatch = pathname.match(/^\/api\/screener\/status\/(\d+)$/);
    if (statusMatch && method === "GET") {
      if (!user) { json(res, 401, { error: "Not authenticated" }); return true; }
      if (!canSendScreener(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const st = await screenerStatus(Number(statusMatch[1]));
      if (!st) { json(res, 404, { error: "Client not found" }); return true; }
      json(res, 200, st);
      return true;
    }

    // Manual send. Enforced here on the server, not merely by hiding a button.
    const sendMatch = pathname.match(/^\/api\/screener\/send\/(\d+)$/);
    if (sendMatch && method === "POST") {
      if (!user) { json(res, 401, { error: "Not authenticated" }); return true; }
      if (!canSendScreener(user)) { json(res, 403, { error: "Not permitted to send the clinical screener." }); return true; }
      let body = {};
      try { body = (await readBody(req)) || {}; } catch (e) { body = {}; }
      const actor = user.email || user.name || "staff";
      const r = await sendManual(Number(sendMatch[1]), actor, body.force === true);
      if (!r.ok) {
        json(res, r.status || 400, { error: r.error, code: r.code || null, last_sent_at: r.last_sent_at || null });
        return true;
      }
      console.log(`[screener] manually sent for client ${sendMatch[1]} by ${actor}`);
      json(res, 200, { ok: true, sent_to: r.sent_to, sent_at: r.sent_at, sent_by: r.sent_by, resend: r.resend });
      return true;
    }

    // Staff view of a client's submission (auth required).
    if (pathname.startsWith("/api/screener/submission/") && method === "GET") {
      if (!user) { json(res, 401, { error: "Not authenticated" }); return true; }
      if (!canSendScreener(user)) { json(res, 403, { error: "Not permitted" }); return true; }
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

  return { handleApi, servePage, tick, initTables, sendManual, screenerStatus, canSendScreener };
};
