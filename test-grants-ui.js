// Grant Finder in a browser.
//
// The module's whole claim is that the six questions are answerable in seconds,
// so this drives the real screens and checks the answers are actually on them:
// what is available, do we qualify, how much, what for, when is it due.
//
// It also checks the one thing a screenshot cannot: that a grant we are not
// eligible for is visible with its reason, and still kept out of the
// recommendations.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-grants-ui.js
const { chromium } = require("playwright");
const crypto = require("crypto");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + String(detail).slice(0, 300) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  async function login(email, password) {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => { await fetch("/api/auth/logout", { method: "POST" }); });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(2200);
  }
  const goTab = async (tab) => {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(1400);
  };

  // An admin account, to prove the owner-only fields really are owner-only.
  // Each suite gets its own database, so this suite makes its own.
  {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync("TestAdmin123!", salt, 64).toString("hex");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ('Grant Admin','grantadmin@spectrumsquadlv.com',$1,$2,'admin',now())
       ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_salt=EXCLUDED.password_salt, role='admin'`,
      [hash, salt]
    );
  }

  await login("admin@spectrumsquadlv.com", "TestOwner123!");

  section("It is in the sidebar and it opens");
  check("Grant Finder is a top-level nav entry",
    await page.locator('.sidebar nav [data-nav="grants"]').count() === 1);
  check("and not buried in the Admin group",
    await page.evaluate(() => {
      const b = document.querySelector('.sidebar nav [data-nav="grants"]');
      return !!b && b.parentElement.tagName === "NAV";
    }));
  await page.click('[data-nav="grants"]');
  await page.waitForTimeout(2200);
  const shell = await page.locator("#view-mount").innerText();
  check("the module renders", /Grant Finder/.test(shell), shell.slice(0, 160));
  check("with its tabs", await page.locator(".gf-tab").count() >= 6);

  // Seed two grants through the API so the screens have something real to show.
  section("Two grants: one we can apply for, one we cannot");
  const made = await page.evaluate(async () => {
    const post = (b) => fetch("/api/grants/opportunities", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
    }).then((r) => r.json());
    const good = await post({
      name: "UI Nevada RBT Workforce Grant", funder: "Nevada DETR",
      geographic_eligibility: "Nevada", for_profit_allowed: true, small_business_eligible: true,
      woman_preference: true, expected_award: 120000, deadline: "2099-10-01",
      tags: ["nevada", "rbt_training", "healthcare_workforce", "behavioral_health"],
    });
    const blocked = await post({
      name: "UI Nonprofit Only Autism Fund", funder: "UI Foundation",
      geographic_eligibility: "Nevada", nonprofit_required: true,
      expected_award: 400000, deadline: "2099-10-15",
      tags: ["autism", "children_youth", "nevada"],
    });
    return { good: good.grant && good.grant.id, blocked: blocked.grant && blocked.grant.id };
  });
  check("both stored", !!made.good && !!made.blocked, made);

  section("The dashboard answers the six questions");
  await goTab("dashboard");
  const dash = await page.locator("#view-mount").innerText();
  check("what money is available — a funding total is shown", /Potential funding available/i.test(dash));
  check("how many are open", /Active opportunities/i.test(dash));
  check("what is closing soon", /Closing in 30 days/i.test(dash));
  check("the eligible grant is recommended", /UI Nevada RBT Workforce Grant/.test(dash));
  check("the nonprofit-only one is NOT recommended", !/UI Nonprofit Only Autism Fund/.test(
    await page.locator("#gf-top").innerText()));
  check("a match score is on the card", /%/.test(dash) && /match/i.test(dash));
  check("and a plain-language reason", /Why this matches Spectrum Squad/i.test(dash));
  check("when is it due — a deadline is shown", /2099-10-01/.test(dash));

  section("Opportunities shows the blocked grant, with its reason");
  await goTab("opportunities");
  const opps = await page.locator("#view-mount").innerText();
  check("the blocked grant is listed here", /UI Nonprofit Only Autism Fund/.test(opps));
  check("marked likely ineligible", /Likely ineligible/i.test(opps));
  check("with the disqualification flag up front", /Nonprofit only/i.test(opps));
  check("and the reason spelled out", /501\(c\)\(3\)|for-profit/i.test(opps));

  section("Filtering");
  await page.selectOption("#gf-elig", "likely_ineligible");
  await page.waitForTimeout(1200);
  const filtered = await page.locator("#gf-list").innerText();
  check("filtering to likely-ineligible keeps the blocked one", /UI Nonprofit Only Autism Fund/.test(filtered));
  check("and drops the eligible one", !/UI Nevada RBT Workforce Grant/.test(filtered));
  await page.selectOption("#gf-elig", "");
  await page.waitForTimeout(1200);

  section("Adding a grant through the form");
  await page.click("#gf-add");
  await page.waitForTimeout(700);
  check("the form opens", await page.locator("#gf-form").count() === 1);
  check("and says blanks mean unknown", /Unclear/i.test(await page.locator("#gf-form-slot").innerText()));
  await page.fill('#gf-form input[name="name"]', "UI Manually Added Grant");
  await page.fill('#gf-form input[name="funder"]', "UI Test Funder");
  await page.click('#gf-tags [data-tag="autism"]');
  await page.click('#gf-form button[type="submit"]');
  await page.waitForTimeout(1800);
  check("it appears in the list", /UI Manually Added Grant/.test(await page.locator("#gf-list").innerText()));

  section("Organisation profile and funding priorities");
  await goTab("profile");
  const prof = await page.locator("#view-mount").innerText();
  // Input values are not part of innerText, so this reads the field itself.
  check("the profile is pre-filled, not blank",
    (await page.inputValue('#gf-profile input[name="company_name"]')) === "Spectrum Squad",
    await page.inputValue('#gf-profile input[name="company_name"]'));
  check("the funding priorities are offered", /What we need money for/i.test(prof));
  check("the owner can see the registration fields", /EIN/.test(prof));
  // Selecting a priority must move the scores, which is the profile's whole job.
  await page.click('#gf-priorities [data-key="train_rbts"]');
  await page.click("#gf-save-pri");
  await page.waitForTimeout(1600);
  check("saving priorities reports the rescore", /rescored/i.test(await page.locator("#gf-prierr").innerText()));

  section("Funding sources are honest about automation");
  await goTab("sources");
  const src = await page.locator("#view-mount").innerText();
  check("the sources are listed", /Grants\.gov/.test(src));
  check("and say nothing is fetched yet", /Phase 4|nothing here fetches/i.test(src));
  check("marking which could be automated", /API available/i.test(src));

  section("The phases that are not built say so");
  await goTab("applications");
  check("Applications is an honest placeholder", /Phase 2/.test(await page.locator("#view-mount").innerText()));
  await goTab("calendar");
  check("Grant calendar too", /Phase 2/.test(await page.locator("#view-mount").innerText()));

  section("An admin does not see the owner's EIN");
  await login("grantadmin@spectrumsquadlv.com", "TestAdmin123!");
  await page.evaluate(() => { location.hash = "#/grants"; });
  await page.waitForTimeout(2000);
  await goTab("profile");
  const adminProf = await page.locator("#view-mount").innerText();
  check("the admin reaches the module", /Organisation profile/i.test(adminProf));
  check("but the registration fields are restricted", /Restricted to owner accounts/i.test(adminProf), adminProf.slice(0, 200));

  section("Clinical staff cannot reach it at all");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  check("no Grant Finder button", await page.locator('.sidebar nav [data-nav="grants"]').count() === 0);
  await page.evaluate(() => { location.hash = "#/grants"; });
  await page.waitForTimeout(1800);
  check("and typing the URL does not open it",
    !/Top opportunities for Spectrum Squad/i.test(await page.locator("#view-mount").innerText()));

  section("no broken pages");
  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" | "));

  await browser.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
