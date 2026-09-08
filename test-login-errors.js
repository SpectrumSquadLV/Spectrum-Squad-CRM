// What the sign-in screen tells you when sign-in fails.
//
// api() turned EVERY 401 into a flat "Not authenticated" without reading the
// server's message, and the login endpoint answers a bad password with a 401.
// So the one screen where a person most needs to know what went wrong showed
// them the least useful sentence in the application -- "not authenticated"
// reads as "your account does not work", not "check the password". A new
// starter and an administrator each lost a round trip to it before anybody
// suspected the credentials.
//
// The security posture is deliberately unchanged: a wrong password and an
// address with no login give the SAME answer, so this screen still cannot be
// used to find out who has an account.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
  };

  const attempt = async (email, password) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(1200);
    const el = await page.locator("#login-error").count();
    return el ? (await page.locator("#login-error").innerText()).trim() : "";
  };

  // ---- a real account, the wrong password ----
  let msg = await attempt("admin@spectrumsquadlv.com", "definitely-not-the-password");
  check("a wrong password says the password is wrong", /invalid email or password/i.test(msg), msg);
  check("and does NOT say 'not authenticated'", !/not authenticated/i.test(msg), msg);
  check("the error is actually on screen, not thrown away by a redirect",
    msg.length > 0 && await page.locator("#login-form").count() === 1, msg);

  // ---- an address with no login at all: the same answer ----
  // This is the case the report came from -- somebody added to the staff
  // directory but never given a login reads as "not authenticated" too.
  const msg2 = await attempt("nobody.at.all.9f3c@example.invalid", "whatever-they-typed");
  check("an address with no login gives the same message", /invalid email or password/i.test(msg2), msg2);
  check("so the screen cannot be used to discover who has an account", msg2 === msg, `${msg} | ${msg2}`);

  // ---- an address pasted with whitespace still finds the account ----
  // Addresses are stored trimmed, and the lookup only lower-cased, so a pasted
  // address with a trailing space reported no such account -- which looks
  // exactly like access never having been granted.
  const padded = await page.evaluate(async () => {
    const r = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "  admin@spectrumsquadlv.com  ", password: "TestOwner123!" }),
    });
    return r.status;
  });
  check("an address with stray whitespace still signs in", padded === 200, padded);

  const wrongCase = await page.evaluate(async () => {
    const r = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Admin@SpectrumSquadLV.com", password: "TestOwner123!" }),
    });
    return r.status;
  });
  check("and so does one typed in the wrong case", wrongCase === 200, wrongCase);

  // ---- the good path still works ----
  // Those two probes signed in for real, so the session cookie has to go or
  // the next page load lands on the dashboard and there is no form to fill.
  await page.context().clearCookies();
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);
  check("a correct password still signs in", await page.locator("#login-form").count() === 0,
    await page.locator("body").innerText().then((t) => t.slice(0, 200)));

  // ---- an expired session on an ordinary call still bounces to login ----
  // The fix narrowed the redirect to non-login requests; it must not have
  // removed it, or somebody whose session lapsed would sit on a dead screen.
  // Cleared through the browser context, not document.cookie: the session
  // cookie is HttpOnly, so script cannot delete it and the "lapsed session"
  // this is meant to simulate never actually lapsed.
  await page.context().clearCookies();
  const bounced = await page.evaluate(async () => {
    try { await api("/api/clients"); } catch (e) { return { msg: e.message, hash: location.hash }; }
    return { msg: "no error", hash: location.hash };
  });
  check("a lapsed session still redirects to the login screen", /#\/login/.test(bounced.hash), JSON.stringify(bounced));

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
