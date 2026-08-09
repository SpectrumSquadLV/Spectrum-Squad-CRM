// Who belongs on the RBT supervision tracker.
//
// A fully certified BCBA on this list is a permanent 0% — they supervise, they
// are not supervised — and enough of them makes the whole board read as
// non-compliant when nothing is actually wrong. The trap is student analysts:
// they are RBTs working towards certification, several carry BCBA-flavoured
// access in the CRM, and they absolutely do need supervision. So the rule reads
// the job title, never the login role, and anything mentioning "student" stays.
//
// A title is a guess, so the last assertion here matters most: whoever is left
// off is named on the page with a reason and a one-click way back on. Silently
// vanishing from a compliance tracker is the failure that only surfaces at an
// audit.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
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

  const stamp = String(await page.evaluate(() => Date.now())).slice(-5);
  const mk = async (label, title) => {
    const name = `${label} ${stamp}`;
    const r = await api("/api/hr/employees", {
      method: "POST",
      body: { name, email: `${label.toLowerCase().replace(/\s+/g, ".")}.${stamp}@example.invalid`, role_title: title, status: "active" },
    });
    const id = r.body && (r.body.id || (r.body.employee && r.body.employee.id));
    return { name, title, id };
  };

  // The four cases that decide the rule.
  const bcba    = await mk("Real Bcba", "BCBA");
  const student = await mk("Student Analyst", "Student Analyst");
  const rbt     = await mk("Plain Rbt", "RBT");
  const bcbaStu = await mk("Bcba Student", "BCBA Student Analyst");

  const summary = await api("/api/supervision");
  const tracked = (summary.body.employees || []).map((e) => e.name);
  const off = (summary.body.excluded || []).map((e) => e.name);
  check("the tracker answers", summary.status === 200, JSON.stringify(summary).slice(0, 200));

  check("a BCBA is off the tracker", off.includes(bcba.name) && !tracked.includes(bcba.name),
    JSON.stringify({ tracked, off }));
  check("a student analyst stays on", tracked.includes(student.name) && !off.includes(student.name),
    JSON.stringify({ tracked, off }));
  check("a plain RBT stays on", tracked.includes(rbt.name), JSON.stringify(tracked));
  check("'BCBA Student Analyst' stays on — student wins over the BCBA in the title",
    tracked.includes(bcbaStu.name) && !off.includes(bcbaStu.name), JSON.stringify({ tracked, off }));

  const bcbaRow = (summary.body.excluded || []).find((e) => e.name === bcba.name);
  check("the exclusion says why", bcbaRow && /supervis/i.test(bcbaRow.reason || ""), bcbaRow && bcbaRow.reason);

  // Excluding people must not quietly change the compliance headline.
  check("the signed-off count is out of the tracked staff only",
    summary.body.staff_count === (summary.body.employees || []).length,
    `staff_count=${summary.body.staff_count} tracked=${(summary.body.employees || []).length}`);

  // ---------------- a human can overrule the guess, both ways ----------------
  let r = await api(`/api/supervision/employee/${bcba.id}/tracked`, { method: "PATCH", body: { tracked: true } });
  check("a BCBA can be put back on by hand", r.status === 200 && r.body.tracked === true, JSON.stringify(r.body));
  let after = await api("/api/supervision");
  check("and then appears on the tracker", (after.body.employees || []).some((e) => e.name === bcba.name));

  r = await api(`/api/supervision/employee/${rbt.id}/tracked`, { method: "PATCH", body: { tracked: false } });
  check("an RBT can be taken off by hand", r.status === 200 && r.body.tracked === false, JSON.stringify(r.body));
  after = await api("/api/supervision");
  const rbtOff = (after.body.excluded || []).find((e) => e.name === rbt.name);
  check("and is listed as removed on purpose, not by title", rbtOff && rbtOff.manual === true, JSON.stringify(rbtOff));

  r = await api(`/api/supervision/employee/${rbt.id}/tracked`, { method: "PATCH", body: { tracked: null } });
  check("handing the decision back to the job title works", r.status === 200 && r.body.tracked === true, JSON.stringify(r.body));

  // Put the BCBA back to automatic for the UI check below.
  await api(`/api/supervision/employee/${bcba.id}/tracked`, { method: "PATCH", body: { tracked: null } });

  // ---------------- the page says who is missing ----------------
  await page.evaluate(() => { location.hash = "#/supervision"; });
  await page.waitForFunction(() => /Overall supervision/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const pageText = await page.locator("#view-mount").innerText();
  check("the page has a 'not on this tracker' section", /Not on this tracker/i.test(pageText), pageText.slice(0, 400));
  check("it names the BCBA who was left off", pageText.includes(bcba.name), pageText.slice(-600));
  check("it explains why in plain English", /supervise rather than being supervised/i.test(pageText));
  // The heading is upper-cased by CSS, so innerText reads "NOT ON THIS
  // TRACKER" -- compare case-insensitively rather than against the source text.
  const notOnIdx = pageText.toLowerCase().indexOf("not on this tracker");
  check("the student analyst is in the main table, above the excluded list",
    pageText.indexOf(student.name) > -1 && notOnIdx > -1 && pageText.indexOf(student.name) < notOnIdx,
    `student=${pageText.indexOf(student.name)} notOn=${notOnIdx}`);
  check("there is a one-click way to put them back", await page.locator("[data-sup-track]").count() > 0);
  check("and a way to take someone off", await page.locator("[data-sup-untrack]").count() > 0);

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
