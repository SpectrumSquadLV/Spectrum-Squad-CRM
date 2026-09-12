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

  // ---------------------------------------------------------------- scores
  // The Fidelity Check email tells an RBT their own result, and that body is
  // kept verbatim like every other. RBT Fidelity is NOT granted by CRM role,
  // so an admin who cannot open a single Fidelity screen must not be able to
  // read somebody's score out of the message log instead.
  //
  // Built from the real template rather than a hand-typed lookalike: a body
  // shaped differently from what the CRM actually sends would assert nothing.
  const SCORE_BODY = `
      <p>Hi Casey,</p>
      <p>Your Fidelity Check from <strong>2026-09-01</strong> has been completed and signed by Someone BCBA.</p>
      <table style="border-collapse:collapse;font-size:15px;margin:14px 0;">
        <tr><td style="padding:5px 14px 5px 0;color:#5b6472;">Score</td><td style="padding:5px 0;font-weight:700;">58 / 60</td></tr>
        <tr><td style="padding:5px 14px 5px 0;color:#5b6472;">Percentage</td><td style="padding:5px 0;font-weight:700;">96.7%</td></tr>
        <tr><td style="padding:5px 14px 5px 0;color:#5b6472;">Rating</td><td style="padding:5px 0;font-weight:700;">Exceptional</td></tr>
      </table>
      <p style="text-align:center;margin:24px 0;">
        <a href="https://x.test/fidelity-ack/${SECRET}" style="background:#e0a430;">Read it and acknowledge</a>
      </p>`;
  await pool.query(
    `INSERT INTO notifications_log (client_id, type, recipient, subject, body, sent_at, delivered, ack_token)
     VALUES (NULL, 'test_redact', $1, $2, $3, now()::text, 'sent', $4)`,
    [`redact.${stamp}@example.invalid`, `REDACT fidelity-score ${stamp}`, SCORE_BODY, "ack" + stamp]
  );

  const out2 = await api("/api/notifications");
  const scored = (out2.body || []).find((r) => String(r.subject || "").includes(`fidelity-score ${stamp}`));
  check("the Fidelity Check message is returned", !!scored, (out2.body || []).length);
  const sBody = String((scored || {}).body || "");
  check("the score out of 60 is withheld", !/58 \/ 60/.test(sBody), sBody.slice(0, 300));
  check("...and the percentage", !/96\.7%/.test(sBody), sBody.slice(0, 300));
  check("...and the rating in words", !/Exceptional/.test(sBody), sBody.slice(0, 300));
  check("...each replaced by something that says it was withheld",
    (sBody.match(/\[withheld\]/g) || []).length === 3, sBody.slice(0, 400));

  // The reader still has to be able to see WHAT was sent. A blank where a
  // message used to be is its own kind of useless.
  check("the reader can still tell it was a Fidelity Check, and when",
    /Fidelity Check from/.test(sBody) && /2026-09-01/.test(sBody), sBody.slice(0, 300));
  check("...and the labels survive, so the shape of the message is legible",
    /Score/.test(sBody) && /Percentage/.test(sBody) && /Rating/.test(sBody), sBody.slice(0, 300));
  check("...and its acknowledgement link is redacted like every other",
    !sBody.includes(SECRET) && /fidelity-ack\/\[link removed\]/.test(sBody), sBody.slice(0, 300));

  const storedScore = (await pool.query(
    "SELECT body FROM notifications_log WHERE subject LIKE $1 LIMIT 1", [`REDACT fidelity-score ${stamp}`]
  )).rows[0];
  check("the STORED Fidelity email still carries the real score",
    storedScore && /58 \/ 60/.test(String(storedScore.body))
      && /96\.7%/.test(String(storedScore.body)), "storage was altered");

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
