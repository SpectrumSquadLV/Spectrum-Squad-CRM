// completions.js -- one place every "something finished" event reports to.
//
// The problem this solves: a parent signs their financial obligation form, or
// submits their schedule, or finishes the clinical screener, and nothing tells
// anyone. The only way to find out was to open the client's card and look. The
// completions were happening; the knowing was not.
//
// Two deliberate design choices.
//
// 1. One recorder, not a sendEmail() sprinkled at each call site. Every event
//    lands in one table with one shape, so the dashboard feed, the digest and
//    any future Slack or SMS route all read the same rows. Adding an event is
//    one line at the place it happens.
//
// 2. Recorded first, delivered later. record() only writes a row -- it never
//    sends and never throws into its caller. A parent signing a form must not
//    fail because Resend is down, and a completion must not be lost because
//    nobody was watching at the time. The digest picks up anything unsent, so
//    an outage delays the news rather than destroying it.
//
// Delivery is one email per day listing everything that finished, because a
// mail per event is a mail nobody reads.

"use strict";

module.exports = function initCompletions(ctx) {
  const {
    dbGet, dbAll, dbRun, sendEmail, nowISO, json, readBody,
    getAppSetting, APP_BASE_URL,
  } = ctx;

  // Every kind of completion the system can report. `label` is what a human
  // reads in the feed and the digest; `group` is only for ordering the digest
  // so related things sit together.
  const EVENTS = {
    financial_form_signed:     { label: "Financial obligation form signed",       group: "Families" },
    schedule_request_submitted:{ label: "Parent submitted their schedule",        group: "Families" },
    screener_completed:        { label: "Clinical screener completed",            group: "Families" },
    enrollment_packet_completed:{ label: "Enrollment packet signed",              group: "Families" },
    client_documents_received: { label: "Insurance card and diagnosis received",  group: "Families" },
    eligibility_returned:      { label: "Eligibility check returned",             group: "Families" },
    client_stage_advanced:     { label: "Client moved to a new stage",            group: "Families" },
    client_active:             { label: "Client started therapy",                 group: "Families" },
    stage_task_completed:      { label: "Stage task completed",                   group: "Work" },
    staff_task_completed:      { label: "Staff to-do completed",                  group: "Work" },
    supply_request_fulfilled:  { label: "Supply request fulfilled",               group: "Work" },
    offer_accepted:            { label: "Job offer accepted",                     group: "Hiring" },
    newhire_packet_signed:     { label: "New hire packet signed",                 group: "Hiring" },
    onboarding_docs_complete:  { label: "New hire sent every document",           group: "Hiring" },
    onboarding_doc_received:   { label: "New hire document received",             group: "Hiring" },
    supervision_signed_off:    { label: "Supervision month signed off",           group: "Hiring" },
    certification_renewed:     { label: "Certification renewed",                  group: "Hiring" },
    ot_intake_submitted:       { label: "OT intake submitted",                    group: "Families" },
  };
  const GROUP_ORDER = ["Families", "Work", "Hiring"];

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS completions (
      id SERIAL PRIMARY KEY,
      event_key TEXT NOT NULL,
      title TEXT NOT NULL,          -- "Financial obligation form signed"
      subject TEXT,                 -- who it happened to: "Demo A." / "Jane Doe"
      detail TEXT,                  -- one short line of context, optional
      link TEXT,                    -- where to go to see it, optional
      client_id INTEGER,
      employee_id INTEGER,
      dedupe_key TEXT,              -- set for anything that could fire twice
      occurred_at TEXT NOT NULL,
      notified_at TEXT              -- NULL until a digest has carried it
    )`).catch((e) => console.error("completions initTables:", e.message));

    // A completion that can fire twice -- a sweep re-reading the same signed
    // packet, a double-submitted form -- carries a dedupe key. The unique index
    // is what actually enforces it; the INSERT just declines the collision.
    await dbRun(
      "CREATE UNIQUE INDEX IF NOT EXISTS completions_dedupe ON completions (dedupe_key) WHERE dedupe_key IS NOT NULL"
    ).catch((e) => console.error("completions dedupe index:", e.message));
    await dbRun(
      "CREATE INDEX IF NOT EXISTS completions_unsent ON completions (notified_at, occurred_at)"
    ).catch(() => {});
  }

  // Record that something finished. Never throws, never sends. Call it from
  // anywhere, including inside a request a parent is waiting on.
  async function record(eventKey, { subject, detail, link, clientId, employeeId, dedupeKey } = {}) {
    try {
      const def = EVENTS[eventKey];
      if (!def) {
        // An unknown key is a bug in the caller, but silently dropping the
        // completion would hide it. Record it under its raw key so it still
        // shows up and someone can see what is miswired.
        console.error("completions.record: unknown event key", eventKey);
      }
      await dbRun(
        `INSERT INTO completions (event_key, title, subject, detail, link, client_id, employee_id, dedupe_key, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          eventKey,
          (def && def.label) || eventKey,
          subject || null,
          detail || null,
          link || null,
          clientId || null,
          employeeId || null,
          dedupeKey || null,
          nowISO(),
        ]
      );
    } catch (e) {
      // Deliberately swallowed. A completion notice is never worth failing the
      // thing that completed.
      console.error("completions.record failed:", e.message);
    }
  }

  // ---------------------------------------------------------------- reading
  async function feed(limit = 25) {
    return dbAll(
      "SELECT * FROM completions ORDER BY occurred_at DESC, id DESC LIMIT ?",
      [Math.min(Math.max(Number(limit) || 25, 1), 200)]
    ).catch(() => []);
  }

  async function unsent() {
    return dbAll("SELECT * FROM completions WHERE notified_at IS NULL ORDER BY occurred_at ASC, id ASC").catch(() => []);
  }

  // ---------------------------------------------------------------- digest
  async function recipients() {
    const configured = String((await getAppSetting("completion_digest_recipients", "")) || "").trim();
    if (configured) {
      return [...new Set(configured.split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
    }
    // Fall back to the owner notification address, then the real owner mailbox
    // -- never the seeded admin@ account, which nobody reads.
    const ownerSetting = String((await getAppSetting("owner_notification_email", "")) || "").trim();
    if (ownerSetting) return [ownerSetting.toLowerCase()];
    // Last resort: a real human's mailbox. "owner" first, then super_admin,
    // then admin -- because the account Quiana actually signs in with may be
    // any of the three, and a digest that silently has nowhere to go is the
    // same as not building this at all. The seeded admin@ address is excluded
    // deliberately: it exists, but nobody reads it.
    const o = await dbGet(
      `SELECT email FROM users
        WHERE role IN ('owner','super_admin','admin')
          AND email IS NOT NULL AND email <> ''
          AND email <> 'admin@spectrumsquadlv.com'
        ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'super_admin' THEN 1 ELSE 2 END, id
        LIMIT 1`
    ).catch(() => null);
    return o && o.email ? [o.email.toLowerCase()] : [];
  }

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function digestHtml(rows) {
    const byGroup = {};
    for (const r of rows) {
      const def = EVENTS[r.event_key];
      const g = (def && def.group) || "Other";
      (byGroup[g] = byGroup[g] || []).push(r);
    }
    const groups = [...GROUP_ORDER, ...Object.keys(byGroup).filter((g) => !GROUP_ORDER.includes(g))];
    const time = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } };

    let html = `<p>Here's everything that finished today — ${rows.length} thing${rows.length === 1 ? "" : "s"}.</p>`;
    for (const g of groups) {
      const items = byGroup[g];
      if (!items || !items.length) continue;
      html += `<h3 style="margin:18px 0 6px; font-size:15px; color:#1b2a6b;">${esc(g)}</h3><ul style="margin:0; padding-left:18px;">`;
      for (const r of items) {
        const who = r.subject ? ` — <strong>${esc(r.subject)}</strong>` : "";
        const detail = r.detail ? `<div style="font-size:12.5px; color:#6b7280;">${esc(r.detail)}</div>` : "";
        html += `<li style="margin-bottom:7px;">${esc(r.title)}${who}
          <span style="font-size:12px; color:#9ca3af;">${esc(time(r.occurred_at))}</span>${detail}</li>`;
      }
      html += "</ul>";
    }
    html += `<p style="margin-top:20px; font-size:13px;">
      <a href="${esc(APP_BASE_URL)}/#/dashboard">Open the CRM</a> — the same list is on your dashboard, any time.</p>`;
    return html;
  }

  // Send one email covering everything not yet carried by a digest. Rows are
  // marked notified only after a successful send, so a failed digest re-sends
  // the same items tomorrow rather than swallowing them.
  async function sendDigest({ force = false } = {}) {
    const rows = await unsent();
    if (!rows.length) return { sent: false, reason: "nothing_to_report", count: 0 };

    const to = await recipients();
    if (!to.length) {
      // Loud in the log as well as on the dashboard. A digest with no
      // recipient is indistinguishable from a quiet day unless someone says so.
      console.error(
        `[completions] ${rows.length} completion(s) have nowhere to go — no digest recipient configured. ` +
        `Set one in Admin Settings → Daily "what finished today" email.`
      );
      return { sent: false, reason: "no_recipient", count: rows.length };
    }

    const subject = `${rows.length} thing${rows.length === 1 ? "" : "s"} finished today — Spectrum Squad`;
    const html = digestHtml(rows);

    let anyDelivered = false;
    for (const address of to) {
      const r = await sendEmail({ to: address, subject, html, type: "completion_digest" }).catch((e) => {
        console.error("completion digest send failed:", e.message);
        return { delivered: "failed" };
      });
      if (r && r.delivered && r.delivered !== "failed") anyDelivered = true;
    }

    // "simulated" counts as delivered -- that is the local/dev path, and not
    // marking the rows would replay the whole backlog every hour.
    if (!anyDelivered && !force) return { sent: false, reason: "delivery_failed", count: rows.length };

    const stamp = nowISO();
    await dbRun(
      `UPDATE completions SET notified_at = ? WHERE id IN (${rows.map(() => "?").join(",")})`,
      [stamp, ...rows.map((r) => r.id)]
    );
    return { sent: true, count: rows.length, to };
  }

  // The digest fires once a day. This is checked hourly rather than scheduled
  // for an exact minute, because the process restarts on every deploy and a
  // once-a-day setTimeout would simply never fire on a busy week.
  async function maybeSendDaily() {
    const hour = Number(await getAppSetting("completion_digest_hour", "18")) || 18;
    const now = new Date();
    if (now.getHours() < hour) return { sent: false, reason: "too_early" };
    const today = now.toISOString().slice(0, 10);
    const last = await getAppSetting("completion_digest_last_sent_date", "");
    if (last === today) return { sent: false, reason: "already_sent_today" };
    const result = await sendDigest();
    // Only claim the day once something actually went out. "nothing_to_report"
    // deliberately does not, so a quiet morning followed by a busy evening
    // still gets its digest.
    if (result.sent) await ctx.setAppSetting("completion_digest_last_sent_date", today);
    return result;
  }

  // ---------------------------------------------------------------- routes
  const VIEW_ROLES = ["owner", "super_admin", "admin"];
  const canView = (u) => !!u && VIEW_ROLES.includes(u.role);

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/completions")) return false;
    if (!user) return json(res, 401, { error: "Not authenticated" });
    if (!canView(user)) return json(res, 403, { error: "Not permitted" });

    if (pathname === "/api/completions" && method === "GET") {
      return json(res, 200, {
        completions: await feed(query.limit),
        pending_digest: (await unsent()).length,
        digest_hour: Number(await getAppSetting("completion_digest_hour", "18")) || 18,
        recipients: await recipients(),
      });
    }

    // Send the digest now rather than waiting for this evening.
    if (pathname === "/api/completions/digest" && method === "POST") {
      return json(res, 200, await sendDigest());
    }

    return false;
  }

  return { initTables, record, feed, unsent, sendDigest, maybeSendDaily, handleApi, EVENTS };
};
