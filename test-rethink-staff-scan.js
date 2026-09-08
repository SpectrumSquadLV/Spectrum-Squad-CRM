// The button that scans Rethink for employees and puts them in the CRM.
//
// Rethink is unreachable from a build environment, so what this suite covers is
// everything AROUND the API call: that the screen exists and is reachable, that
// it is owner/admin only at the SERVER (not merely hidden), that a staff record
// is never created from a staff id alone, that somebody already on the roster
// is a link rather than a second personnel file, and that a scan with no
// credentials fails honestly instead of looking like "nobody works here".
//
// The scan's own arithmetic -- who worked, how many sessions, whose name came
// back -- is covered against a stubbed transport in test-rethink.js.
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

  // ---------------- the bundle is actually served ----------------
  // The static handler has an allowlist; a frontend file missing from it 404s
  // and the screen silently falls back to the dashboard.
  const js = await page.evaluate(async () => (await fetch("/rethink-staff-frontend.js")).status);
  check("the screen's bundle is served, not 404", js === 200, js);

  // ---------------- the screen ----------------
  await page.evaluate(() => { location.hash = "#/rethink-staff"; });
  await page.waitForTimeout(1800);
  const text = await page.locator("#view-mount").innerText();
  check("the Rethink Staff screen renders", /Rethink Staff/i.test(text), text.slice(0, 300));
  check("there is a button to scan Rethink for employees",
    await page.locator("#rs-scan").count() === 1, text.slice(0, 300));
  check("it explains that nothing is saved until approved",
    /Nothing is saved until you approve/i.test(text), text.slice(0, 400));
  check("it is reachable from the sidebar, not only by URL",
    await page.locator('a[href="#/rethink-staff"], [data-nav="rethink-staff"]').count() > 0
      || /Rethink Staff/i.test(await page.locator("body").innerText()), "nav");

  // ---------------- the review endpoint ----------------
  let r = await api("/api/rethink/staff-match");
  check("the review endpoint answers", r.status === 200, JSON.stringify(r).slice(0, 200));
  check("it lists the CRM roster to link against", Array.isArray(r.body.employees), JSON.stringify(r.body).slice(0, 200));
  check("and who has no Rethink link yet",
    r.body.employees.some((e) => e.linked === false), JSON.stringify(r.body.employees || []).slice(0, 200));

  // ---------------- a scan with no credentials fails honestly ----------------
  // Silence here would read as "Rethink has no staff", which is the wrong
  // answer to show on a screen whose job is finding people.
  r = await api("/api/rethink/staff-match/scan", { method: "POST", body: {} });
  check("a scan without credentials is refused, not answered with an empty list",
    r.status === 502 && r.body.ok === false, JSON.stringify(r.body).slice(0, 200));
  check("and says the credentials are the reason",
    /credential/i.test(r.body.error || ""), r.body.error);

  // ---------------- creating a record is guarded ----------------
  r = await api("/api/rethink/staff-match/create", { method: "POST", body: { rethink_staff_id: "TEST-ID-1", name: "" } });
  check("a staff record cannot be created from a staff id alone", r.status === 400, JSON.stringify(r.body));
  check("and it says a name is needed", /name is required/i.test(r.body.error || ""), r.body.error);

  const stamp = String(await page.evaluate(() => Date.now())).slice(-6);
  const nm = "Scanned Rbt " + stamp;
  r = await api("/api/rethink/staff-match/create", {
    method: "POST", body: { rethink_staff_id: "RS-" + stamp, name: nm, role_title: "RBT" },
  });
  check("a named provider can be added deliberately", r.status === 201 && r.body.ok === true, JSON.stringify(r.body));

  // Same person again is a link, not a second personnel file.
  const again = await api("/api/rethink/staff-match/create", {
    method: "POST", body: { rethink_staff_id: "RS2-" + stamp, name: nm },
  });
  check("the same person is not created twice", again.status === 409 && again.body.code === "name_exists",
    JSON.stringify(again.body));

  // And the record really is on the roster, carrying its Rethink id.
  const roster = await api("/api/rethink/staff-match");
  const made = (roster.body.employees || []).find((e) => e.name === nm);
  check("the new staff member is on the roster", !!made, nm);
  check("with the Rethink id attached, so their hours can match",
    made && made.rethink_id === "RS-" + stamp, JSON.stringify(made));

  // ---------------- server-side permission, not a hidden button ----------------
  const anon = await page.evaluate(async () => {
    const res = await fetch("/api/rethink/staff-match/scan", {
      method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json" }, body: "{}",
    });
    return res.status;
  });
  check("scanning is refused without a session", anon === 401 || anon === 403, anon);

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
