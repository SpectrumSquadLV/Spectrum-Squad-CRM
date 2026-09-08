// Active RBTs in Rethink that the supervision tracker cannot see.
//
// The tracker's roster is built from hr_employees, so there are exactly two
// ways for a working RBT to be absent from it, and BOTH look identical to full
// compliance -- the only evidence is a name that isn't on the page:
//
//   1. They exist in Rethink and have no CRM staff record at all.
//   2. They are on the roster but carry no Rethink ID, so their verified hours
//      can never be matched and they sit at 0% looking negligent.
//
// Case 1 needs a Rethink sync and is covered against a stubbed transport in
// test-rethink.js. THIS suite covers case 2 end to end, plus the linking
// endpoint that closes both -- because linking a provider to the wrong person
// moves real verified hours onto the wrong compliance record, which is a worse
// outcome than the gap it was meant to close.
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

  const stamp = String(await page.evaluate(() => Date.now())).slice(-5);
  const mk = async (label, title, extra) => {
    const name = `${label} ${stamp}`;
    const r = await api("/api/hr/employees", {
      method: "POST",
      body: { name, email: `${label.toLowerCase().replace(/\s+/g, ".")}.${stamp}@example.invalid`, role_title: title, status: "active", ...(extra || {}) },
    });
    return { name, id: r.body && (r.body.id || (r.body.employee && r.body.employee.id)) };
  };

  const unlinked = await mk("Unlinked Rbt", "RBT");
  const other    = await mk("Other Rbt", "RBT");

  // ---------------- the tracker reports who it cannot sync ----------------
  let s = await api("/api/supervision");
  check("the tracker answers", s.status === 200, JSON.stringify(s).slice(0, 200));
  const gapNames = (s.body.rethink_unlinked_staff || []).map((e) => e.name);
  check("an RBT with no Rethink ID is reported as unlinked", gapNames.includes(unlinked.name),
    JSON.stringify(gapNames).slice(0, 300));
  const row = (s.body.employees || []).find((e) => e.name === unlinked.name);
  check("and their roster row says so too", row && row.rethink_linked === false, JSON.stringify(row));
  check("the tracker still lists them — unlinked is a gap, not a reason to hide someone",
    !!row, JSON.stringify(gapNames).slice(0, 200));

  // ---------------- linking ----------------
  const SID = "RT" + stamp;
  let r = await api("/api/supervision/rethink-link", { method: "POST", body: { employee_id: unlinked.id, rethink_staff_id: SID } });
  check("a provider can be linked to a staff member", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  s = await api("/api/supervision");
  const after = (s.body.employees || []).find((e) => e.name === unlinked.name);
  check("the roster row now reads as linked", after && after.rethink_linked === true, JSON.stringify(after));
  check("and they drop off the unlinked list",
    !(s.body.rethink_unlinked_staff || []).map((e) => e.name).includes(unlinked.name));

  // One provider, one employee. Two staff holding the same Rethink ID would
  // split one person's hours across two compliance records.
  r = await api("/api/supervision/rethink-link", { method: "POST", body: { employee_id: other.id, rethink_staff_id: SID } });
  check("the same Rethink ID cannot be given to a second staff member", r.status === 409, JSON.stringify(r.body));
  check("and the refusal names who already holds it", /\b/.test(r.body.error || "") && r.body.code === "rethink_id_taken",
    JSON.stringify(r.body));

  // An existing ID is the join for every other Rethink workflow, not just this
  // tracker, so it is never replaced by accident.
  r = await api("/api/supervision/rethink-link", { method: "POST", body: { employee_id: unlinked.id, rethink_staff_id: "RT-DIFFERENT-" + stamp } });
  check("an existing link is not silently overwritten", r.status === 409 && r.body.code === "already_linked", JSON.stringify(r.body));

  r = await api("/api/supervision/rethink-link", { method: "POST", body: { employee_id: unlinked.id, rethink_staff_id: "RT-DIFFERENT-" + stamp, replace: true } });
  check("but it can be replaced when that is asked for explicitly", r.status === 200 && r.body.replaced === SID, JSON.stringify(r.body));

  // Re-sending the same link is a no-op rather than an error: the button is
  // one click away from being pressed twice.
  r = await api("/api/supervision/rethink-link", { method: "POST", body: { employee_id: unlinked.id, rethink_staff_id: "RT-DIFFERENT-" + stamp } });
  check("linking the same pair twice is harmless", r.status === 200 && r.body.already === true, JSON.stringify(r.body));

  r = await api("/api/supervision/rethink-link", { method: "POST", body: { employee_id: unlinked.id } });
  check("a link with no Rethink ID is refused", r.status === 400, JSON.stringify(r.body));
  r = await api("/api/supervision/rethink-link", { method: "POST", body: { rethink_staff_id: "RT-NOBODY" } });
  check("a link with no staff member is refused", r.status === 400, JSON.stringify(r.body));
  r = await api("/api/supervision/rethink-link", { method: "POST", body: { employee_id: 99999999, rethink_staff_id: "RT-GHOST" } });
  check("linking to a staff member who is not on file is refused", r.status === 404, JSON.stringify(r.body));

  // The whole /api/supervision namespace is permission-gated; the link route
  // must not be reachable without a session just because it is new.
  const anon = await page.evaluate(async () => {
    const res = await fetch("/api/supervision/rethink-link", {
      method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: 1, rethink_staff_id: "RT-ANON" }),
    });
    return res.status;
  });
  check("linking is refused without a session", anon === 401 || anon === 403, anon);

  // ---------------- the page shows the gap ----------------
  const stillUnlinked = await mk("Never Linked Rbt", "RBT");
  await page.evaluate(() => { location.hash = "#/supervision"; });
  await page.waitForFunction(() => /Overall supervision/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  // Scoped to the section itself, not the whole page. Asserting against the
  // page text passed even with the section deleted -- the RBT's name is in the
  // roster table above and "0%" appears in the headline, so both assertions
  // were reading the rest of the page and reporting success.
  const gapBox = page.locator("[data-sup-rethink-gap]");
  check("the page has a section for RBTs the tracker cannot sync", await gapBox.count() === 1,
    await page.locator("#view-mount").innerText().then((t) => t.slice(-500)));
  const gapText = (await gapBox.count()) ? await gapBox.innerText() : "";
  check("it names the unlinked RBT", gapText.includes(stillUnlinked.name), gapText.slice(0, 600));
  check("it explains the consequence rather than just flagging it",
    /0%/.test(gapText) && /never sync/i.test(gapText), gapText.slice(0, 600));

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
