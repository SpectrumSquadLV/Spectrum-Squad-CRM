// Magic links in the Message Outbox.
//
// notifications_log stores every email body verbatim, and the Outbox renders it
// to owner / super_admin / admin. Those bodies carry links that open a page AS
// the person they were mailed to: accepting a timecard, signing an offer,
// submitting availability, uploading a child's documents. A screen for checking
// what was sent therefore doubled as a way to act as anybody the CRM has ever
// emailed.
//
// sendPasswordResetEmail already refuses to log its link for exactly this
// reason; this is the same rule applied to the rest, at DISPLAY rather than
// storage. The distinction matters and is asserted here: the stored body keeps
// its real link, so the recipient's own copy still works and a failed email can
// still be re-sent as a working one.
const { chromium } = require("playwright");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
  };

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const api = (path) => page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: "include" });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, path);

  const stamp = String(await page.evaluate(() => Date.now())).slice(-6);
  const SECRET = "tok" + stamp + "abcdefghijklmnop";

  // One row per link shape the CRM actually sends.
  const shapes = [
    ["verify-timecard", `<p>Review it: <a href="https://x.test/verify-timecard/${SECRET}">Open</a></p>`],
    ["offer",           `<p><a href="https://x.test/offer/${SECRET}">Your offer</a></p>`],
    ["screener",        `<p><a href="https://x.test/screener/${SECRET}">Screener</a></p>`],
    ["apply",           `<p><a href="https://x.test/apply/${SECRET}">Apply</a></p>`],
    ["query token",     `<p><a href="https://x.test/client-documents/?token=${SECRET}">Upload</a></p>`],
    ["attendance",      `<p><a href="https://x.test/attendance-sign/?token=${SECRET}">Sign</a></p>`],
  ];
  for (const [label, html] of shapes) {
    await pool.query(
      `INSERT INTO notifications_log (client_id, type, recipient, subject, body, sent_at, delivered, ack_token)
       VALUES (NULL, 'test_redact', $1, $2, $3, now()::text, 'sent', $4)`,
      [`redact.${stamp}@example.invalid`, `REDACT ${label} ${stamp}`, html, "ack" + stamp]
    );
  }

  const out = await api("/api/notifications");
  check("the outbox answers", out.status === 200, JSON.stringify(out).slice(0, 200));
  const mine = (out.body || []).filter((r) => String(r.subject || "").includes(`${stamp}`));
  check("every seeded message is returned", mine.length === shapes.length, mine.length);

  for (const r of mine) {
    const shape = String(r.subject).replace(`REDACT `, "").replace(` ${stamp}`, "");
    check(`the ${shape} link is redacted`, !String(r.body || "").includes(SECRET),
      String(r.body || "").slice(0, 160));
  }
  check("the route is still visible, so it is clear WHAT was sent",
    mine.some((r) => /verify-timecard\/\[link removed\]/.test(r.body || "")),
    (mine.find((r) => /verify-timecard/.test(r.body || "")) || {}).body);
  check("the rest of the message survives redaction",
    mine.every((r) => /<a href=/.test(r.body || "")), "links removed entirely");

  // The acknowledgement token is a one-click credential too.
  check("the acknowledgement token is not handed out at all",
    mine.every((r) => r.ack_token === undefined), JSON.stringify(mine[0] || {}).slice(0, 200));

  // STORAGE IS UNTOUCHED. This is what keeps the recipient's own link working
  // and lets a failed email be re-sent as a working one.
  const stored = (await pool.query(
    "SELECT body FROM notifications_log WHERE subject LIKE $1 LIMIT 1", [`REDACT verify-timecard ${stamp}`]
  )).rows[0];
  check("the stored email still contains the real link",
    stored && String(stored.body).includes(SECRET), stored && String(stored.body).slice(0, 160));

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));

  await pool.query("DELETE FROM notifications_log WHERE type = 'test_redact'").catch(() => {});
  await pool.end();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
