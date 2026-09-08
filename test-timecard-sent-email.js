// What was actually emailed to an employee about their timecard.
//
// The Timecards list showed that something had been sent, but not WHAT. The
// email body was only visible in the Message Outbox, mixed in with every other
// message the CRM has ever sent and with no way to tell which timecard it
// belonged to.
//
// Two things this has to get right.
//
// 1. THE LINK IS A CREDENTIAL. The email carries a magic link that accepts the
//    timecard AS THE EMPLOYEE. This application already refuses to put a
//    password-reset link on a screen for exactly that reason, and a link that
//    signs somebody's hours is the same kind of thing. So the message is shown
//    with the link removed.
// 2. AN EMAIL MUST NOT BE ATTRIBUTED TO THE WRONG PAY PERIOD. Emails are
//    stamped with the timecard they are about. Ones sent before that stamp
//    existed can be matched to the person but not the period, so they are
//    listed separately and by subject only, rather than presented as fact.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });

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

  const api = (path, opts) => page.evaluate(async ({ p, o }) => {
    const r = await fetch(p, {
      method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: o && o.body ? JSON.stringify(o.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { p: path, o: opts });

  const stamp = String(await page.evaluate(() => Date.now())).slice(-6);

  // An employee with an email, and a timecard for them.
  const emp = await api("/api/hr/employees", {
    method: "POST",
    body: { name: "TC Sent " + stamp, email: `tc.sent.${stamp}@example.invalid`, role_title: "RBT", status: "active" },
  });
  const empId = emp.body && (emp.body.id || (emp.body.employee && emp.body.employee.id));
  check("the employee is created", !!empId, JSON.stringify(emp.body).slice(0, 200));

  const imp = await api("/api/hr/timecards/import", {
    method: "POST",
    body: {
      employee_id: empId, source: "test",
      pay_period_start: "2026-08-03", pay_period_end: "2026-08-09",
      entries: [{ date: "2026-08-03", clock_in: "09:00", clock_out: "13:00", hours: 4, appt_type: "Billable - Direct" }],
    },
  });
  const tcId = imp.body && (imp.body.id || (imp.body.timecard && imp.body.timecard.id));
  check("the timecard is created", !!tcId, JSON.stringify(imp.body).slice(0, 200));

  // Nothing sent yet.
  let r = await api(`/api/hr/timecards/${tcId}/emails`);
  check("the view answers before anything is sent", r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check("and reports no email rather than inventing one",
    (r.body.emails || []).length === 0, JSON.stringify(r.body.emails || []));

  // Send it.
  const sent = await api(`/api/hr/timecards/${tcId}/request-verification`, { method: "POST", body: {} });
  check("the timecard sends", sent.status === 200 && sent.body.sent === true, JSON.stringify(sent.body).slice(0, 200));

  r = await api(`/api/hr/timecards/${tcId}/emails`);
  const mails = r.body.emails || [];
  check("the email that was sent is now listed", mails.length === 1, JSON.stringify(mails).slice(0, 200));
  check("it names who it went to", mails[0] && /tc\.sent\./.test(mails[0].recipient || ""), mails[0] && mails[0].recipient);
  check("it carries the subject that was used", mails[0] && /timecard/i.test(mails[0].subject || ""), mails[0] && mails[0].subject);
  check("it says when it was sent", !!(mails[0] && mails[0].sent_at), mails[0] && mails[0].sent_at);
  check("and whether it was delivered", !!(mails[0] && mails[0].delivered), mails[0] && mails[0].delivered);
  check("the body of the message is included", !!(mails[0] && mails[0].body && mails[0].body.length > 50));

  // THE CREDENTIAL. The stored email contains a working sign link; the view
  // must not hand it back.
  const body = (mails[0] && mails[0].body) || "";
  check("the sign-in link is removed from what is shown",
    /\/verify-timecard\/\[link removed\]/.test(body), body.slice(0, 400));
  check("no usable token is left anywhere in it",
    !/\/verify-timecard\/[A-Za-z0-9._~+/-]{8,}/.test(body), (body.match(/\/verify-timecard\/[^"'<\s]*/) || [""])[0]);
  // The redaction must not have gutted the message.
  check("the rest of the email is still readable",
    /timecard/i.test(body) && body.length > 200, body.length);

  // The email is stamped with THIS timecard, not merely with the person.
  const second = await api("/api/hr/timecards/import", {
    method: "POST",
    body: {
      employee_id: empId, source: "test",
      pay_period_start: "2026-08-10", pay_period_end: "2026-08-16",
      entries: [{ date: "2026-08-10", clock_in: "09:00", clock_out: "12:00", hours: 3 }],
    },
  });
  const tc2 = second.body && (second.body.id || (second.body.timecard && second.body.timecard.id));
  const r2 = await api(`/api/hr/timecards/${tc2}/emails`);
  check("a second pay period does not inherit the first one's email",
    (r2.body.emails || []).length === 0, JSON.stringify(r2.body.emails || []).slice(0, 200));

  // ---------------- permission ----------------
  const anon = await page.evaluate(async (id) =>
    (await fetch("/api/hr/timecards/" + id + "/emails", { credentials: "omit" })).status, tcId);
  check("it is refused without a session", anon === 401 || anon === 403, anon);

  // ---------------- the screen ----------------
  await page.evaluate(() => { location.hash = "#/hr"; });
  // Wait for the TAB before clicking it. Clicking a tab that has not rendered
  // yet is a silent no-op -- the screen stays on the recruiting dashboard and
  // the failure then reads as "the button is missing" rather than "the tab was
  // never opened", which is what sent the first two runs of this chasing the
  // wrong thing.
  await page.waitForSelector('[data-hrtab="timecards"]', { timeout: 25000 });
  await page.click('[data-hrtab="timecards"]');
  await page.waitForSelector(`[data-tcsent="${tcId}"]`, { timeout: 25000 }).catch(() => {});
  check("there is a Sent email button on a timecard that has been sent",
    await page.locator(`[data-tcsent="${tcId}"]`).count() === 1,
    // One selector, not two: a comma-separated locator matching several
    // elements throws in strict mode, and the message then says nothing.
    await page.locator("#hr-body").innerText().then((t) => t.slice(0, 200)).catch((e) => "hr-body unreadable: " + e.message));
  check("and none on the one that has not been sent",
    await page.locator(`[data-tcsent="${tc2}"]`).count() === 0);

  if (await page.locator(`[data-tcsent="${tcId}"]`).count()) {
    await page.locator(`[data-tcsent="${tcId}"]`).click();
    await page.waitForTimeout(1200);
    // Scoped to the panel's own body. Several .hr-modal-back elements can exist
    // in the DOM at once, and reading the first gave back just the close button.
    const panel = page.locator("#tcsent-body");
    const modal = await panel.innerText().catch(() => "");
    check("the panel opens", await panel.count() === 1, modal.slice(0, 200));
    check("it shows who it went to", /tc\.sent\./.test(modal), modal.slice(0, 300));
    // The note lives inside a <details>, and innerText does not see the content
    // of a closed disclosure -- so open it rather than asserting against text
    // the browser is not rendering.
    const disc = page.locator("#tcsent-body details summary");
    if (await disc.count()) { await disc.first().click(); await page.waitForTimeout(400); }
    const opened = await panel.innerText().catch(() => "");
    check("it explains the link is hidden on purpose",
      /signs the timecard as/i.test(opened), opened.slice(0, 800));
    check("and the message itself is shown once opened",
      /timecard/i.test(opened) && opened.length > modal.length, opened.length + " vs " + modal.length);
  }

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
