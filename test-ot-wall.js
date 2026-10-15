// THE OT WALL, AND THE ONE DOOR IN IT.
//
// An ot_admin / ot_staff account gets a locked-down shell: the Occupational
// Therapy section and nothing else. The wall is not the missing sidebar
// buttons -- it is that route() RETURNS before the block that fetches client
// records, so no ABA client, pipeline stage or therapist is ever loaded for
// them. OT accounts see shared family demographics only: no ABA clinical,
// authorization, billing or financial data.
//
// Asked for: an OT Admin who needs the Credentialing Tracker. That is now the
// one section that can be granted across, because staff credentialing is
// about EMPLOYEES -- their credentials and payer enrolments -- and holds no
// client record, which is what the wall is for.
//
// SO THIS SUITE DEFENDS BOTH HALVES:
//
//   1. THE DOOR OPENS PER PERSON, NEVER PER ROLE. An OT account with no grant
//      is still locked to the OT page, and asking for #/credentialing by hand
//      bounces it straight back.
//   2. THE WALL STAYS UP FOR WHOEVER WALKS THROUGH IT. The granted OT admin
//      gets credentialing and nothing else, and -- the assertion that
//      actually matters -- no client, stage or therapist request is made for
//      her on any page.
//
// Nothing covered the OT roles in a browser before this, so the wall itself
// was resting on a code comment.
//
//   DATABASE_URL=... node run-tests.js test-ot-wall.js
"use strict";

const { chromium } = require("playwright");
const { Pool } = require("pg");
const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const BASE = process.env.BASE || "http://localhost:3011";
const stamp = Date.now().toString(36);

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++; failures.push(name);
    console.log("  FAIL  " + name + (detail !== undefined
      ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : ""));
  }
};
const section = (t) => console.log("\n== " + t + " ==");

const hp = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  // EVERY request the page makes, so "no client data is fetched" is an
  // observation rather than a belief.
  let seen = [];
  page.on("request", (r) => seen.push(r.url()));
  const clientDataAsked = () => seen.filter((u) =>
    /\/api\/(clients|stages|therapists)(\?|$|\/)/.test(u));

  const PW = "OtWall123!";
  const mkUser = async (label, role, moduleAccess) => {
    const email = `otwall-${label}-${stamp}@example.invalid`.toLowerCase();
    const h = hp(PW);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, module_access, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())`,
      [`OtWall ${label}`, email, h.hash, h.salt, role, moduleAccess]);
    return email;
  };

  async function login(email, password) {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => { await fetch("/api/auth/logout", { method: "POST" }); });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(2200);
  }

  try {
    await pool.query(`DELETE FROM users WHERE name LIKE 'OtWall %'`).catch(() => {});
    const plainOt = await mkUser("Plain", "ot_admin", null);
    const grantedOt = await mkUser("Granted", "ot_admin", JSON.stringify({ credentialing: true }));

    // =====================================================================
    section("AN OT ACCOUNT WITH NO GRANT IS LOCKED TO ITS OWN SECTION");
    seen = [];
    await login(plainOt, PW);
    check("it lands on the OT page", /#\/ot/.test(await page.evaluate(() => location.hash)),
      await page.evaluate(() => location.hash));
    check("THERE IS NO CREDENTIALING ENTRY",
      await page.locator('[data-nav="credentialing"]').count() === 0,
      await page.locator('[data-nav="credentialing"]').count());
    check("...nor a dashboard, client or HR entry",
      await page.locator('[data-nav="dashboard"]').count() === 0
      && await page.locator('[data-nav="pipeline"]').count() === 0
      && await page.locator('[data-nav="hr"]').count() === 0,
      await page.evaluate(() => [...document.querySelectorAll("[data-nav]")].map((e) => e.dataset.nav)));

    section("...AND ASKING FOR IT BY HAND BOUNCES BACK");
    await page.evaluate(() => { location.hash = "#/credentialing"; });
    await page.waitForTimeout(1500);
    check("THE HASH IS SENT BACK TO THE OT PAGE",
      /#\/ot/.test(await page.evaluate(() => location.hash)),
      await page.evaluate(() => location.hash));
    check("...and THE TRACKER ITSELF IS NOT RENDERED",
      await page.locator(".cr-head").count() === 0, await page.locator(".cr-head").count());
    check("NO CLIENT DATA WAS FETCHED FOR THEM AT ANY POINT",
      clientDataAsked().length === 0, clientDataAsked().slice(0, 4));
    // Asserted ABOVE this probe on purpose: the probe fetches /api/clients
    // itself to prove the server refuses it, which would otherwise show up in
    // the page's own request log and fail the check for the wrong reason.
    const plainApis = await page.evaluate(async () => {
      const get = async (u) => (await fetch(u, { credentials: "include" })).status;
      return {
        nav: await get("/api/nav-order"),
        cred: await get("/api/credentialing"),
        clients: await get("/api/clients"),
      };
    });
    check("the server refuses them nav-order, as it always has", plainApis.nav === 403, plainApis);
    check("...and refuses them credentialing", plainApis.cred === 403, plainApis);
    check("...and refuses them client records", plainApis.clients === 403, plainApis);

    // =====================================================================
    section("THE GRANTED OT ADMIN GETS CREDENTIALING, AND ONLY THAT");
    seen = [];
    await login(grantedOt, PW);
    check("the Credentialing entry is there now",
      await page.locator('[data-nav="credentialing"]').count() === 1,
      await page.evaluate(() => [...document.querySelectorAll("[data-nav]")].map((e) => e.dataset.nav)));
    check("...and STILL no dashboard, clients, HR or pipeline",
      await page.locator('[data-nav="dashboard"]').count() === 0
      && await page.locator('[data-nav="pipeline"]').count() === 0
      && await page.locator('[data-nav="hr"]').count() === 0
      && await page.locator('[data-nav="staff"]').count() === 0,
      await page.evaluate(() => [...document.querySelectorAll("[data-nav]")].map((e) => e.dataset.nav)));

    section("AND THE PAGE ACTUALLY OPENS FOR HER");
    await page.evaluate(() => { location.hash = "#/credentialing"; });
    await page.waitForTimeout(2500);
    check("the hash STAYS on credentialing rather than bouncing",
      /#\/credentialing/.test(await page.evaluate(() => location.hash)),
      await page.evaluate(() => location.hash));
    // .cr-head is drawn only by the loaded tracker. Matching the word
    // "Credentialing" would have matched the sidebar button instead, which is
    // how an earlier version of this test passed without the page loading.
    check("THE TRACKER ITSELF IS ON SCREEN",
      await page.locator(".cr-head").count() === 1, await page.locator(".cr-head").count());
    const grantedBody = await page.textContent("body");
    // Only the PAGE-level refusal matters. The tracker also has an HR-only
    // "add somebody to the tracker" panel, which answers 403 for any
    // read-only viewer -- a clinical lead included -- and prints its message
    // on the page. That is correct, so the assertion names the refusal that
    // would mean she was locked out rather than any refusal at all.
    check("...and it is NOT the page-level refusal panel",
      !/is for HR, owners and admins/i.test(grantedBody),
      grantedBody.replace(/\s+/g, " ").trim().slice(0, 240));
    check("...and the tracker's own heading is there",
      /Internal onboarding for every new hire/i.test(grantedBody),
      grantedBody.replace(/\s+/g, " ").trim().slice(0, 240));

    section("THE WALL IS STILL A WALL FOR HER — the assertion that matters");
    check("NO CLIENT, STAGE OR THERAPIST WAS EVER FETCHED FOR HER",
      clientDataAsked().length === 0, clientDataAsked().slice(0, 4));
    check("and the page threw nothing", errors.length === 0, errors.slice(0, 3));

    section("ONE DOOR, NOT SEVERAL — everything else is still refused");
    const grantedApis = await page.evaluate(async () => {
      const get = async (u) => (await fetch(u, { credentials: "include" })).status;
      return {
        cred: await get("/api/credentialing"),
        nav: await get("/api/nav-order"),
        clients: await get("/api/clients"),
        hr: await get("/api/hr/employees"),
        screener: await get("/api/screener/list"),
        progression: await get("/api/staff-progression"),
        financial: await get("/api/financial-ledger/summary"),
      };
    });
    check("credentialing is open to her", grantedApis.cred === 200, grantedApis);
    check("...and nav-order, which the sidebar needs", grantedApis.nav === 200, grantedApis);
    check("BUT CLIENT RECORDS ARE STILL REFUSED", grantedApis.clients === 403, grantedApis);
    check("...HR is still refused", grantedApis.hr === 403, grantedApis);
    check("...the clinical screener is still refused — the hole this wall was built for",
      grantedApis.screener === 403, grantedApis);
    check("...the dashboard progression widget is still refused",
      grantedApis.progression === 403, grantedApis);
    check("...and the financial ledger is still refused", grantedApis.financial === 403, grantedApis);

    section("A GRANT DOES NOT HAND OVER THE OWNER'S SETTINGS");
    // She can READ the configuration, because the tracker cannot draw its
    // columns without knowing which payers need linking. What she must not get
    // is the owner's email settings, or the ability to CHANGE any of it.
    const cfg = await page.evaluate(async () => {
      const r = await fetch("/api/credentialing/config", { credentials: "include" });
      const d = await r.json().catch(() => ({}));
      const put = await fetch("/api/credentialing/config", {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ due_days: { documents: 1 } }),
      });
      return { get: r.status, can_configure: d.can_configure, hasEmail: d.email !== undefined, put: put.status };
    });
    check("she can read which payers need linking, which the tracker needs", cfg.get === 200, cfg);
    check("...but is not told she may configure it", cfg.can_configure === false, cfg);
    check("...THE OWNER'S EMAIL SETTINGS ARE NOT IN THE PAYLOAD", cfg.hasEmail === false, cfg);
    check("...and CHANGING the payer rules and deadlines is refused", cfg.put === 403, cfg);

    if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log("  " + f)); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.query(`DELETE FROM users WHERE name LIKE 'OtWall %'`).catch(() => {});
    await browser.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error("Crashed:", e);
    try { await browser.close(); } catch (x) {}
    try { await pool.end(); } catch (x) {}
    process.exit(1);
  }
})();
