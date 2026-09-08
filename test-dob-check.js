// Which birthdays on file might have been typed the wrong way round.
//
// The DOB field asked day-first on a day-first browser until it was replaced,
// so birthdays entered before that may have month and day swapped. A transposed
// birthday is invisible -- it saves cleanly and looks plausible everywhere -- so
// the only way to find one is to ask which records are CAPABLE of being wrong.
//
// The report guesses nothing and changes nothing. Its most valuable output is
// the negative one: a day above 12 cannot be a month, so everything it does not
// list is provably correct.
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
  const mk = async (label, dob) => {
    const child = `${label} ${stamp}`;
    await api("/api/clients", {
      method: "POST",
      body: { child_name: child, parent_name: "P " + stamp, parent_email: `${label}.${stamp}@example.invalid`, dob },
    });
    return child;
  };

  // The four cases that define the rule.
  const swappable  = await mk("Dobamb", "2019-03-04");   // Mar 4 <-> Apr 3
  const dayTooBig  = await mk("Dobbig", "2019-03-25");   // 25 cannot be a month
  const sameBoth   = await mk("Dobsame", "2019-03-03");  // swap is identical
  const noDob      = await mk("Dobnone", null);
  const decNov     = await mk("Dobdec", "2019-12-11");   // both <= 12, still ambiguous

  const r = await api("/api/clients/dob-check");
  check("the check runs", r.status === 200, JSON.stringify(r).slice(0, 200));
  const names = (r.body.ambiguous || []).map((c) => c.child_name);

  check("a birthday whose swap is a different real date is flagged",
    names.includes(swappable), JSON.stringify(names).slice(0, 300));
  check("12/11 is flagged too — both halves are legal months",
    names.includes(decNov), JSON.stringify(names).slice(0, 300));
  check("a day above 12 is NOT flagged — it cannot be a month",
    !names.includes(dayTooBig), JSON.stringify(names).slice(0, 300));
  check("a birthday that swaps to itself is NOT flagged",
    !names.includes(sameBoth), JSON.stringify(names).slice(0, 300));
  check("a client with no birthday is not flagged as ambiguous",
    !names.includes(noDob), JSON.stringify(names).slice(0, 300));
  check("and is counted as having no birthday on file", r.body.no_dob >= 1, r.body.no_dob);

  const row = (r.body.ambiguous || []).find((c) => c.child_name === swappable);
  check("the report shows what is on file", row && row.stored_reading === "March 4, 2019", row && row.stored_reading);
  check("and the other way it could read", row && row.swapped_reading === "April 3, 2019", row && row.swapped_reading);
  check("both readings are spelled out, where a transposition is visible",
    row && /[A-Z][a-z]+ \d+, \d{4}/.test(row.stored_reading), row && row.stored_reading);

  // It must not change anything.
  const before = await api("/api/clients");
  const target = (before.body || []).find((c) => c.child_name === swappable);
  check("the report changed no record", target && String(target.dob).slice(0, 10) === "2019-03-04",
    target && target.dob);

  // ---------------- the screen ----------------
  const js = await page.evaluate(async () => (await fetch("/dob-check-frontend.js")).status);
  check("the screen's bundle is served, not 404", js === 200, js);

  await page.evaluate(() => { location.hash = "#/dob-check"; });
  await page.waitForTimeout(1800);
  const text = await page.locator("#view-mount").innerText();
  check("the screen renders", /Date of birth check/i.test(text), text.slice(0, 200));
  check("it lists the ambiguous client", text.includes(swappable), text.slice(0, 600));
  check("it shows both readings", /March 4, 2019/.test(text) && /April 3, 2019/.test(text), text.slice(0, 700));
  check("it says being listed does not mean the record is wrong",
    /does .{0,6}not.{0,6} mean a record is wrong|cannot tell/i.test(text), text.slice(0, 700));
  check("it reports how many are provably correct", /Provably correct/i.test(text), text.slice(0, 500));

  // ---------------- permission ----------------
  // It is under /api/clients, so the client-record gate applies to it.
  const anon = await page.evaluate(async () =>
    (await fetch("/api/clients/dob-check", { credentials: "omit" })).status);
  check("it is refused without a session", anon === 401 || anon === 403, anon);

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
