// Timecard Management Hub (HR > Timecards).
//
// One pay period at a time: summary counts, a compact table with one action
// menu per row, bulk send / resend / ZIP / CSV, a detail panel, an archive of
// fully-signed periods, and optional automatic reminders.
//
// What has to hold, beyond "the screen renders":
//   * statuses are derived from what actually happened (sent, signed, overdue)
//   * bulk actions only touch eligible records and say what they skipped
//   * a second click can't send the same email twice
//   * signed timecards, signed PDFs and hours are never changed by any of it
//   * bulk downloads/exports are permission-checked and audit-logged
//   * the phone layout has no sideways scroll
//
//   node run-tests.js test-timecard-hub.js
"use strict";
const { chromium } = require("playwright");
const zlib = require("zlib");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3009";
const SHOT_DIR = process.env.SHOT_DIR || "";

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const q = (sql, params) => pool.query(sql, params);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + String(detail).slice(0, 400) : "")); }
  };

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const api = (path, opts) => page.evaluate(async ({ p, o }) => {
    const r = await fetch(p, {
      method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: o && o.body ? JSON.stringify(o.body) : undefined,
    });
    const ct = r.headers.get("content-type") || "";
    if (/zip/.test(ct)) {
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = ""; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return { status: r.status, ct, b64: btoa(s), skipped: r.headers.get("X-Skipped-Count"), cd: r.headers.get("Content-Disposition") };
    }
    if (/csv/.test(ct)) return { status: r.status, ct, text: await r.text(), cd: r.headers.get("Content-Disposition") };
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { p: path, o: opts });

  const stamp = String(Date.now()).slice(-6);
  const mkEmp = async (name, email, role) => {
    const r = await api("/api/hr/employees", { method: "POST", body: { name, email, role_title: role, status: "active" } });
    return r.body && (r.body.id || (r.body.employee && r.body.employee.id));
  };
  const mkTc = async (employee_id, start, end, entries) => {
    const r = await api("/api/hr/timecards/import", { method: "POST", body: { employee_id, source: "test", pay_period_start: start, pay_period_end: end, entries } });
    return r.body && r.body.id;
  };

  console.log("\n--- setup ---");
  const A = await mkEmp(`Avery Hub ${stamp}`, `avery.${stamp}@example.invalid`, "RBT");
  const B = await mkEmp(`Blake Hub ${stamp}`, `blake.${stamp}@example.invalid`, "BCBA");
  const C = await mkEmp(`Casey Hub ${stamp}`, "", "RBT");
  const D = await mkEmp(`=cmd Hub ${stamp}`, `d.${stamp}@example.invalid`, "RBT");
  check("employees are created", A && B && C && D, [A, B, C, D].join(","));

  const P1 = ["2026-09-01", "2026-09-14"], P2 = ["2026-08-18", "2026-08-31"];
  const e = (d, h) => ({ date: d, clock_in: "09:00", clock_out: "17:00", hours: h, appt_type: "Billable - Direct" });
  const tA = await mkTc(A, ...P1, [e("2026-09-01", 4), e("2026-09-01", 3), e("2026-09-02", 8)]);
  const tB = await mkTc(B, ...P1, [e("2026-09-03", 6)]);
  const tC = await mkTc(C, ...P1, [e("2026-09-04", 5)]);
  const tA2 = await mkTc(A, ...P2, [e("2026-08-20", 7)]);
  const tD2 = await mkTc(D, ...P2, [e("2026-08-21", 2)]);
  check("timecards are created", tA && tB && tC && tA2 && tD2);
  const entriesBefore = (await q("SELECT id, entries FROM hr_timecards ORDER BY id")).rows;

  console.log("\n--- one pay period at a time ---");
  let hub = await api("/api/hr/timecards/hub");
  check("the hub answers", hub.status === 200, JSON.stringify(hub.body).slice(0, 200));
  const sp = hub.body.selected_period || {};
  check("it opens on the newest open period", sp.pay_period_start === P1[0] && sp.pay_period_end === P1[1], JSON.stringify(sp));
  check("with just that period's timecards", (hub.body.timecards || []).length === 3, (hub.body.timecards || []).length);
  check("every period is listed for the selector", (hub.body.periods || []).length === 2, JSON.stringify(hub.body.periods));
  check("hours are totalled per timecard", (hub.body.timecards.find((t) => t.id === tA) || {}).total_hours === 15);
  check("nothing sent yet reads as Not sent", hub.body.timecards.every((t) => t.hub_status === "not_sent"));
  const p1sum = hub.body.periods.find((p) => p.pay_period_end === P1[1]);
  check("the period summary totals hours", p1sum && p1sum.total_hours === 26, JSON.stringify(p1sum));
  const h2 = await api(`/api/hr/timecards/hub?period_start=${P2[0]}&period_end=${P2[1]}`);
  check("another period can be picked", (h2.body.timecards || []).length === 2 && h2.body.selected_period.pay_period_end === P2[1]);

  console.log("\n--- bulk send: eligible only, no duplicates ---");
  let r = await api("/api/hr/timecards/send", { method: "POST", body: { ids: [tA, tB, tC] } });
  check("bulk send sends to everyone with an email", r.body.sent === 2, JSON.stringify(r.body));
  check("and reports who has no email", (r.body.skipped || []).some((n) => /Casey/.test(n)), JSON.stringify(r.body.skipped));
  r = await api("/api/hr/timecards/send", { method: "POST", body: { ids: [tA, tA] } });
  check("a repeat within the minute does not email again", r.body.sent === 0 && (r.body.just_sent || []).length === 1, JSON.stringify(r.body));
  r = await api(`/api/hr/timecards/${tB}/request-verification`, { method: "POST", body: {} });
  check("nor does a single resend click", r.body.sent === false && r.body.reason === "just_sent" && /verify-timecard/.test(r.body.url || ""), JSON.stringify(r.body));
  const mailsA = (await q("SELECT COUNT(*)::int AS n FROM notifications_log WHERE ref_type = 'timecard' AND ref_id = $1", [tA])).rows[0].n;
  check("exactly one email went to Avery", mailsA === 1, mailsA);
  // A double click: two sends racing on a card nobody has sent yet.
  const race = await Promise.all([
    api(`/api/hr/timecards/${tD2}/request-verification`, { method: "POST", body: {} }),
    api(`/api/hr/timecards/${tD2}/request-verification`, { method: "POST", body: {} }),
  ]);
  const raceMails = (await q("SELECT COUNT(*)::int AS n FROM notifications_log WHERE ref_type = 'timecard' AND ref_id = $1", [tD2])).rows[0].n;
  check("two racing clicks produce one email", raceMails === 1 && race.filter((x) => x.body.sent).length === 1, raceMails + " " + JSON.stringify(race.map((x) => x.body)));

  hub = await api("/api/hr/timecards/hub");
  const st = (id) => (hub.body.timecards.find((t) => t.id === id) || {}).hub_status;
  check("sent timecards read as Awaiting signature", st(tA) === "awaiting" && st(tB) === "awaiting", st(tA) + "/" + st(tB));
  check("someone with no email on file still reads as Not sent", st(tC) === "not_sent", st(tC));
  const rowA = hub.body.timecards.find((t) => t.id === tA);
  check("the first send is tracked", !!rowA.first_sent_at && Number(rowA.send_count) === 1, JSON.stringify({ f: rowA.first_sent_at, n: rowA.send_count }));

  console.log("\n--- signing ---");
  const link = await api(`/api/hr/timecards/${tA}/link`);
  const token = String(link.body.url || "").split("/verify-timecard/")[1];
  r = await api("/api/hr/public/timecard/accept", { method: "POST", body: { token, signed_name: "Avery Hub" } });
  check("the employee signs", r.status === 200, JSON.stringify(r.body));
  hub = await api("/api/hr/timecards/hub");
  const signedRow = hub.body.timecards.find((t) => t.id === tA);
  check("it reads as Signed with the signature time", signedRow.hub_status === "signed" && !!signedRow.accepted_at);
  check("and its signed PDF is attached", !!signedRow.pdf_doc_id);
  r = await api("/api/hr/timecards/send", { method: "POST", body: { ids: [tA] } });
  check("bulk send skips a signed timecard", r.body.sent === 0 && (r.body.already_signed || []).length === 1, JSON.stringify(r.body));

  console.log("\n--- overdue ---");
  r = await api("/api/hr/timecards/hub-settings", { method: "POST", body: { overdue_days: 2 } });
  check("the overdue window is configurable", r.body.settings && r.body.settings.overdue_days === 2, JSON.stringify(r.body));
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
  await q("UPDATE hr_timecards SET first_sent_at = $1, verification_requested_at = $1 WHERE id = $2", [threeDaysAgo, tB]);
  hub = await api("/api/hr/timecards/hub");
  check("an unsigned timecard past the window is Overdue", (hub.body.timecards.find((t) => t.id === tB) || {}).hub_status === "overdue");

  console.log("\n--- resend to all pending ---");
  r = await api("/api/hr/timecards/send-all", { method: "POST", body: { pay_period_start: P1[0], pay_period_end: P1[1], only_pending: true } });
  check("only people who were sent it and haven't signed are reminded", r.body.sent === 1 && (r.body.skipped || []).length === 0, JSON.stringify(r.body));
  const lastB = (await q("SELECT subject FROM notifications_log WHERE ref_type = 'timecard' AND ref_id = $1 ORDER BY id DESC LIMIT 1", [tB])).rows[0];
  check("and it goes out as a reminder", lastB && /Reminder/.test(lastB.subject), lastB && lastB.subject);
  hub = await api("/api/hr/timecards/hub");
  check("a reminder does not reset Overdue", (hub.body.timecards.find((t) => t.id === tB) || {}).hub_status === "overdue");

  console.log("\n--- downloads ---");
  r = await api("/api/hr/timecards/signed-zip", { method: "POST", body: { pay_period_start: P1[0], pay_period_end: P1[1] } });
  check("a period's signed timecards download as a ZIP", r.status === 200 && /zip/.test(r.ct || ""), r.status + " " + r.ct);
  if (r.b64) {
    const buf = Buffer.from(r.b64, "base64");
    check("it is a real ZIP", buf.readUInt32LE(0) === 0x04034b50);
    const nameLen = buf.readUInt16LE(26), compLen = buf.readUInt32LE(18);
    const name = buf.slice(30, 30 + nameLen).toString("utf8");
    const pdf = zlib.inflateRawSync(buf.slice(30 + nameLen, 30 + nameLen + compLen));
    check("holding the signed PDF, named for the person and period", /Avery_Hub/.test(name) && /2026-09-01_to_2026-09-14\.pdf$/.test(name), name);
    check("which opens as a PDF", pdf.slice(0, 4).toString() === "%PDF");
    check("the unsigned ones are counted as left out", r.skipped === "2", r.skipped);
  }
  r = await api("/api/hr/timecards/signed-zip", { method: "POST", body: { ids: [tB, tC] } });
  check("a selection with nothing signed is refused plainly", r.status === 400 && /signed PDF/.test(r.body.error || ""), JSON.stringify(r.body));

  r = await api(`/api/hr/timecards/export.csv?period_start=${P1[0]}&period_end=${P1[1]}`);
  const lines = String(r.text || "").replace(/^﻿/, "").trim().split(/\r\n/);
  check("the summary exports as CSV", r.status === 200 && /csv/.test(r.ct || "") && lines.length === 4, r.status + " " + lines.length);
  check("with hours and signature status", /Employee,Position/.test(lines[0]) && lines.some((l) => /Avery Hub.*,15,.*Signed/.test(l)) && lines.some((l) => /Blake Hub.*Overdue/.test(l)), lines.join(" | "));
  r = await api(`/api/hr/timecards/export.csv?period_start=${P2[0]}&period_end=${P2[1]}`);
  check("a name that looks like a formula is neutralised", /\n'=cmd Hub/.test(String(r.text).replace(/\r/g, "")), String(r.text).slice(0, 300));

  console.log("\n--- archive ---");
  const link2 = await api(`/api/hr/timecards/${tA2}/link`);
  await api("/api/hr/public/timecard/accept", { method: "POST", body: { token: String(link2.body.url).split("/verify-timecard/")[1], signed_name: "Avery Hub" } });
  const link3 = await api(`/api/hr/timecards/${tD2}/link`);
  await api("/api/hr/public/timecard/accept", { method: "POST", body: { token: String(link3.body.url).split("/verify-timecard/")[1], signed_name: "D Hub" } });
  hub = await api("/api/hr/timecards/hub");
  const p2 = hub.body.periods.find((p) => p.pay_period_end === P2[1]);
  check("a period where everyone signed is marked complete", p2 && p2.complete === true, JSON.stringify(p2));
  check("and nothing in it was deleted", p2 && p2.total === 2);
  r = await api("/api/hr/timecards/hub?q=" + encodeURIComponent("Avery Hub " + stamp));
  check("search finds a person across every period", r.body.searching_all === true && r.body.timecards.length === 2, JSON.stringify(r.body.timecards.map((t) => t.pay_period_end)));

  console.log("\n--- automatic reminders ---");
  r = await api("/api/hr/timecards/hub-settings", { method: "POST", body: { auto_reminders: true, reminder_days: 1, max_reminders: 1 } });
  check("reminders can be switched on", r.body.settings.auto_reminders === true && r.body.settings.max_reminders === 1);
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
  await q("UPDATE hr_timecards SET verification_requested_at = $1 WHERE id = $2", [twoDaysAgo, tB]);
  // The sweep, run in-process against the same database the server uses.
  const sent = [];
  const conv = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const hrMod = require("./hr")({
    dbGet: async (s, p = []) => (await pool.query(conv(s), p)).rows[0],
    dbAll: async (s, p = []) => (await pool.query(conv(s), p)).rows,
    dbRun: async (s, p = []) => { const x = await pool.query(conv(s), p); return { rowCount: x.rowCount, rows: x.rows }; },
    sendEmail: async (m) => { sent.push(m); return { delivered: "sent" }; },
    nowISO: () => new Date().toISOString(), crypto: require("crypto"), APP_BASE_URL: BASE,
    readBody: async () => ({}), json: () => {}, sendFile: () => {}, PUBLIC_DIR: __dirname,
    moduleGranted: () => false, getAppSetting: async (k, fb = null) => fb,
  });
  let sw = await hrMod.processTimecardReminders();
  check("the sweep reminds the person who hasn't signed", sw.sent === 1 && sent.length === 1 && /Reminder/.test(sent[0].subject), JSON.stringify(sw) + " " + JSON.stringify(sent.map((m) => m.to)));
  check("and only them", sent.every((m) => /blake/.test(m.to)), JSON.stringify(sent.map((m) => m.to)));
  await q("UPDATE hr_timecards SET verification_requested_at = $1, last_reminder_at = $1 WHERE id = $2", [twoDaysAgo, tB]);
  sw = await hrMod.processTimecardReminders();
  check("it stops at the configured number of reminders", sw.sent === 0, JSON.stringify(sw));
  const rc = (await q("SELECT reminder_count FROM hr_timecards WHERE id = $1", [tB])).rows[0].reminder_count;
  check("and records how many were sent", Number(rc) === 1, rc);
  await api("/api/hr/timecards/hub-settings", { method: "POST", body: { auto_reminders: false } });

  console.log("\n--- integrity + audit ---");
  const entriesAfter = (await q("SELECT id, entries FROM hr_timecards ORDER BY id")).rows;
  check("no hours were changed by any of this", JSON.stringify(entriesBefore) === JSON.stringify(entriesAfter));
  const audit = await api("/api/hr/audit");
  const actions = new Set((audit.body || []).map((a) => a.action));
  check("bulk download, export and settings changes are audit-logged",
    ["timecard_pdfs_bulk_downloaded", "timecard_summary_exported", "timecard_hub_settings_changed", "timecard_resend_pending"].every((a) => actions.has(a)),
    [...actions].join(","));
  const anon = await page.evaluate(async () => (await fetch("/api/hr/timecards/hub", { credentials: "omit" })).status);
  check("the hub is refused without a session", anon === 401 || anon === 403, anon);

  console.log("\n--- the screen (desktop) ---");
  await page.evaluate(() => { location.hash = "#/hr/timecards"; });
  await page.waitForSelector("#tc-period", { timeout: 30000 }).catch(() => {});
  await page.selectOption("#tc-period", `${P1[0]}|${P1[1]}`).catch(() => {});
  await page.waitForSelector(`[data-tcmenu="${tA}"]`, { timeout: 20000 }).catch(() => {});
  const cards = await page.locator(".tch-cards").innerText({ timeout: 5000 }).catch(() => "");
  check("summary cards show the period's counts", /Total timecards/.test(cards) && /Pending signatures/.test(cards) && /Overdue/.test(cards) && /26/.test(cards), cards.replace(/\n/g, " "));
  check("one compact row per timecard", await page.locator(".tch-row:not(.head)").count() === 3);
  check("rows carry no stacked buttons", await page.locator(".tch-row [data-tcsend], .tch-row [data-tcdel]").count() === 0);
  if (SHOT_DIR) await page.screenshot({ path: SHOT_DIR + "/hub-desktop.png", fullPage: true });
  await page.locator(`[data-tcmenu="${tA}"]`).click();
  await page.waitForTimeout(250);
  const menu = await page.locator(".tch-menu").innerText().catch(() => "");
  check("the action menu has the row's actions", /View timecard/.test(menu) && /View email history/.test(menu) && /View signed PDF/.test(menu) && /Delete timecard/.test(menu), menu);
  check("a signed timecard can't be re-sent from it", !/Resend email|Send email/.test(menu), menu);
  if (SHOT_DIR) await page.screenshot({ path: SHOT_DIR + "/hub-menu.png" });
  await page.locator(".tch-menu [data-tc]").click();
  await page.waitForSelector(".tch-panel #tcd-body .tch-sec", { timeout: 10000 }).catch(() => {});
  const panel = await page.locator(".tch-panel").innerText().catch(() => "");
  check("the detail panel shows hours by day and signature tracking", /Daily hours/i.test(panel) && /Signature tracking/i.test(panel) && /First emailed/.test(panel) && /Email history/i.test(panel), panel.replace(/\n/g, " | ").slice(0, 400));
  check("with the daily breakdown summed", /15/.test(panel) && /Days worked/.test(panel));
  if (SHOT_DIR) await page.screenshot({ path: SHOT_DIR + "/hub-detail.png" });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.locator(`.tc-pick[value="${tB}"]`).check();
  await page.waitForTimeout(200);
  check("selecting a row brings up the bulk bar", /1 selected/.test(await page.locator("#tc-bulk").innerText().catch(() => "")));
  await page.locator(".tch-card", { hasText: "Overdue" }).click();
  await page.waitForTimeout(200);
  check("a summary card filters the table", await page.locator(".tch-row:not(.head)").count() === 1);
  await page.locator('[data-tcview="archive"]').click();
  await page.waitForTimeout(300);
  const arch = await page.locator("#hr-body").innerText().catch(() => "");
  check("the archive lists the completed period", /Completed pay periods/i.test(arch) && /Aug 18, 2026/.test(arch), arch.replace(/\n/g, " | ").slice(0, 600));

  console.log("\n--- the screen (phone) ---");
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  m.on("pageerror", (er) => errors.push("mobile pageerror: " + er.message));
  m.on("dialog", async (d) => { await d.accept(); });
  await m.goto(BASE + "/", { waitUntil: "networkidle" });
  await m.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await m.fill('#login-form input[name="password"]', "TestOwner123!");
  await m.click('#login-form button[type="submit"]');
  await m.waitForTimeout(2500);
  await m.evaluate(() => { location.hash = "#/hr/timecards"; });
  await m.waitForSelector("#tc-period", { timeout: 30000 }).catch(() => {});
  await m.selectOption("#tc-period", `${P1[0]}|${P1[1]}`).catch(() => {});
  await m.waitForSelector(`[data-tcmenu="${tB}"]`, { timeout: 20000 }).catch(() => {});
  const over = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  check("no sideways scroll on a phone", over.sw <= over.w, JSON.stringify(over));
  check("filters are folded away until asked for", !(await m.locator("#tc-filters").isVisible()) && await m.locator("#tc-filter-toggle").isVisible());
  check("each row still shows its status", await m.locator(`.tch-row[data-row="${tB}"] .tch-meta-m .tch-pill`).isVisible());
  if (SHOT_DIR) await m.screenshot({ path: SHOT_DIR + "/hub-mobile.png", fullPage: true });
  await m.locator(`[data-tcmenu="${tB}"]`).tap();
  await m.waitForTimeout(250);
  const box = await m.locator(".tch-menu").boundingBox();
  check("the action menu stays on screen", box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  if (SHOT_DIR) await m.screenshot({ path: SHOT_DIR + "/hub-mobile-menu.png" });
  await m.locator(".tch-menu [data-tc]").tap();
  await m.waitForSelector(".tch-panel #tcd-body .tch-sec", { timeout: 10000 }).catch(() => {});
  const pb = await m.locator(".tch-panel").boundingBox();
  check("details open full-width on a phone", pb && Math.round(pb.width) === 390, JSON.stringify(pb));
  if (SHOT_DIR) await m.screenshot({ path: SHOT_DIR + "/hub-mobile-detail.png" });

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
