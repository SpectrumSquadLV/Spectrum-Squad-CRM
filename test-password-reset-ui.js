// The forgotten-password screens, in a browser.
//
// The API suite (test-password-reset.js) proves the rules. This proves a person
// can reach them: that the link is on the login card, that the two screens
// render for somebody with no session at all, and -- the one worth a browser --
// that THE TOKEN NEVER LEAVES THE FRAGMENT on the way in.
//
// A reset link is a working key to an account. Put it in the path or the query
// string and it lands in the web server's access log, in Railway's HTTP log,
// and in a Referer header on the way to any external asset the page loads. Put
// it after the "#" and the browser never sends it at all. That is a property of
// the URL shape, so it is checked by watching the actual requests the browser
// makes, not by reading the code.
const { chromium } = require("playwright");
const { Pool } = require("pg");
const crypto = require("crypto");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
  };
  const BASE = process.env.BASE || "http://localhost:3009";

  const signedOut = async (hash = "/") => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {}
      try { localStorage.clear(); } catch (e) {}
    });
    await page.goto(BASE + "/" + hash, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
  };

  console.log("\n== The way in ==");
  await signedOut();
  await page.waitForSelector("#login-form", { timeout: 15000 });
  check("the login card offers a way out of being locked out",
    await page.locator("#forgot-password-link").count() === 1);
  check("and it says what it does, in words somebody would look for",
    /forgot/i.test(await page.locator("#forgot-password-link").innerText()),
    await page.locator("#forgot-password-link").innerText().catch(() => ""));

  await page.click("#forgot-password-link");
  await page.waitForTimeout(600);
  check("clicking it reaches the request screen WITHOUT a session",
    await page.locator("#forgot-form").count() === 1, await page.evaluate(() => location.hash));
  check("the login form is gone, so there is one thing to do",
    await page.locator("#login-form").count() === 0);
  const blurb = await page.innerText(".login-card");
  check("it says the link expires", /hour/i.test(blurb), blurb.slice(0, 200));

  console.log("\n== Asking for a link ==");
  await page.fill('#forgot-form input[name="email"]', "scheduling@spectrumsquadlv.com");
  await page.click("#forgot-submit");
  await page.waitForTimeout(1200);
  const known = await page.innerText("#forgot-done");
  check("the confirmation replaces the form, so nobody sends three",
    await page.locator("#forgot-form").isHidden(), known);
  check("and it is worded as a maybe, not a confirmation the account exists",
    /if that address has an account/i.test(known), known);

  await signedOut("#/forgot-password");
  await page.fill('#forgot-form input[name="email"]', "nobody-at-all@example.invalid");
  await page.click("#forgot-submit");
  await page.waitForTimeout(1200);
  const unknown = await page.innerText("#forgot-done");
  check("AN ADDRESS WITH NO ACCOUNT SEES THE IDENTICAL SENTENCE",
    unknown.trim() === known.trim(), { known, unknown });

  console.log("\n== A link that cannot be used ==");
  await signedOut("#/reset-password?token=" + "0".repeat(64));
  await page.waitForTimeout(900);
  const badCard = await page.innerText(".login-card");
  check("a bogus token gets an explanation, not a password form",
    await page.locator("#reset-form").count() === 0 && /cannot be used|not valid/i.test(badCard), badCard.slice(0, 200));
  check("and a way to ask for a new one", await page.locator('a[href="#/forgot-password"]').count() >= 1);
  check("it reassures that nothing changed", /has not been changed/i.test(badCard), badCard.slice(0, 300));

  console.log("\n== The token stays in the fragment ==");
  // Every request the browser makes while the reset screen loads and submits.
  const seen = [];
  page.on("request", (req) => seen.push({
    url: req.url(), method: req.method(),
    referer: req.headers()["referer"] || "",
    post: req.postData() || "",
  }));
  const TOKEN = "a1b2c3".padEnd(64, "d");
  await signedOut("#/reset-password?token=" + TOKEN);
  await page.waitForTimeout(900);
  const leaked = seen.filter((r) => r.url.includes(TOKEN) && !r.url.includes("#"));
  check("NO REQUEST URL CARRIES THE TOKEN in its path or query string",
    leaked.length === 0, leaked.slice(0, 3));
  check("and no Referer header carries it either",
    seen.every((r) => !r.referer.includes(TOKEN)),
    seen.filter((r) => r.referer.includes(TOKEN)).slice(0, 3));
  // Both checks above would pass trivially if the token were simply never sent.
  // It is sent -- in a POST body, which is the whole point.
  const presented = seen.filter((r) => r.method === "POST" && r.post.includes(TOKEN));
  check("the token IS presented to the server, in a request body",
    presented.length === 1, { posts: presented.length, requests: seen.length });
  check("and that request is the check endpoint",
    presented.every((r) => r.url.endsWith("/api/auth/reset-password/check")),
    presented.map((r) => r.url));

  console.log("\n== The form itself ==");
  // A real token, minted with the same hashing rule the server uses, so the
  // form under test is the one somebody actually opens from their email. Doing
  // this here rather than behind an environment variable is deliberate: half a
  // suite that only runs when somebody remembers to set a variable is half a
  // suite that never runs.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const EMAIL = "scheduling@spectrumsquadlv.com";
  const realToken = crypto.randomBytes(32).toString("hex");
  const u = (await pool.query("SELECT id FROM users WHERE lower(email) = lower($1)", [EMAIL])).rows[0];
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, created_at, expires_at, requested_email)
     VALUES ($1,$2,$3,$4,$5)`,
    [u.id, crypto.createHash("sha256").update(realToken).digest("hex"),
     new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString(), EMAIL]
  );

  await signedOut("#/reset-password?token=" + realToken);
  await page.waitForTimeout(900);
  check("a valid link shows the password form", await page.locator("#reset-form").count() === 1);
  const hint = await page.innerText(".login-card");
  check("naming the account only in masked form",
    /\*/.test(hint) && !hint.includes(EMAIL), hint.slice(0, 200));

  await page.fill('#reset-form input[name="password"]', "MismatchOne123!");
  await page.fill('#reset-form input[name="confirm"]', "MismatchTwo123!");
  await page.click("#reset-submit");
  await page.waitForTimeout(600);
  check("two different passwords are caught before anything is sent",
    /do not match/i.test(await page.innerText("#reset-error")),
    await page.innerText("#reset-error"));
  check("and the form is still usable after that",
    await page.locator("#reset-submit").isEnabled());
  check("THE LINK WAS NOT SPENT by the mismatch",
    (await page.evaluate((t) => fetch("/api/auth/reset-password/check", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }),
    }).then((r) => r.json()), realToken)).valid === true);

  await page.fill('#reset-form input[name="password"]', "BrowserSetPass1!");
  await page.fill('#reset-form input[name="confirm"]', "BrowserSetPass1!");
  await page.click("#reset-submit");
  await page.waitForTimeout(1500);
  const doneCard = await page.innerText(".login-card");
  check("the reset completes and says so", /password updated/i.test(doneCard), doneCard.slice(0, 200));
  check("AND SAYS THE OTHER SESSIONS WERE ENDED, because that is the point of resetting",
    /signed out/i.test(doneCard), doneCard.slice(0, 300));

  await page.click('a[href="#/login"]');
  await page.waitForTimeout(700);
  check("and it leads back to a working sign-in form",
    await page.locator("#login-form").count() === 1);
  await page.fill('#login-form input[name="email"]', EMAIL);
  await page.fill('#login-form input[name="password"]', "BrowserSetPass1!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(1800);
  check("THE PASSWORD SET IN THE BROWSER ACTUALLY SIGNS IN",
    await page.locator("#nav-list").count() === 1,
    await page.evaluate(() => location.hash));
  await pool.end();

  console.log("\n== Presentation ==");
  await signedOut("#/forgot-password");
  const html = await page.innerHTML(".login-card");
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  check("no emoji on the password screens", emoji.length === 0, emoji);
  const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  check("nothing overflows horizontally", overflow.doc <= overflow.win + 1, overflow);

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
