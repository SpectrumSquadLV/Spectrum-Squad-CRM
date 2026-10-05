// The two doors, in a real browser.
//
// The separation is a claim about what somebody SEES. The API suite proves the
// data is filed correctly; this proves the screen does not put it back into one
// undifferentiated list, which is the thing being fixed.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-policies-sops-ui.js
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3011";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

function api(cookie) {
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, { method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie.v ? { Cookie: cookie.v } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie.v = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}

(async () => {
  const stamp = Date.now().toString(36);
  const cookie = { v: "" };
  const o = api(cookie);
  await o("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  const mk = async (b) => (await o("/api/policies", { method: "POST", body: b })).data;
  const pol = await mk({ title: `Documentation Policy ${stamp}`, doc_kind: "policy", category: "Session Notes & Documentation",
    doc_number: "POL-900", department: "Clinical", owner_name: "Quiana Blake", applicable_roles: ["RBT"],
    purpose: "Documentation must be timely.", body: "Complete within 24 hours." });
  const sop = await mk({ title: `Session Verification SOP ${stamp}`, doc_kind: "sop", category: "Session Notes & Documentation",
    doc_number: "SOP-900", department: "Clinical", body: "1. Open Rethink.\n2. Verify." });
  await mk({ title: `Attendance Policy ${stamp}`, doc_kind: "policy", category: "Attendance & Timekeeping", body: "Be on time." });
  await mk({ title: `Opening the Clinic SOP ${stamp}`, doc_kind: "sop", category: "Operations", body: "1. Unlock." });
  await o(`/api/policies/${pol.id}/links`, { method: "POST", body: { other_id: sop.id } });
  // Edited once, so there is a revision for the reader to show. A record that
  // has never changed correctly shows no history, which is why this cannot be
  // asserted on a freshly created one.
  await o(`/api/policies/${pol.id}`, { method: "PATCH", body: { body: "Complete within 12 hours.", version: "2" } });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  const login = async (email, password) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => { try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {} });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(1700);
  };
  const openPolicies = async () => {
    await page.goto(BASE + "/#/policies");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1700);
  };

  // ------------------------------------------------------------------
  section("Arriving: two doors, and nothing else");
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  await openPolicies();
  check("the section is still called Policies & SOPs",
    /Policies & SOPs/.test(await page.$eval("h1", (e) => e.textContent).catch(() => "")),
    await page.$eval("h1", (e) => e.textContent).catch(() => ""));
  const doors = await page.$$eval("[data-pol-kind]", (e) => e.map((x) => x.dataset.polKind));
  check("BOTH DOORS ARE THERE, and only those two", doors.join(",") === "policy,sop", doors);
  check("each door says how much is behind it",
    await page.$$eval(".pol-door-n", (e) => e.length === 2 && e.every((x) => /\d+ document/.test(x.textContent))),
    await page.$$eval(".pol-door-n", (e) => e.map((x) => x.textContent)).catch(() => []));
  check("THE UNDIFFERENTIATED LIST IS GONE — no records are shown before a choice",
    (await page.$$("[data-pol-open]")).length === 0, (await page.$$("[data-pol-open]")).length);

  // ------------------------------------------------------------------
  section("Behind each door, only its own records");
  await page.click('[data-pol-kind="policy"]');
  await page.waitForTimeout(1200);
  check("the heading names the library", /Policies/.test(await page.$eval("h1", (e) => e.textContent)),
    await page.$eval("h1", (e) => e.textContent));
  const polCards = await page.$$eval("[data-pol-open]", (e) => e.length);
  check("the policy library has records", polCards > 0, polCards);
  check("EVERY CARD IN IT SAYS POLICY",
    await page.$$eval(".pol-card .pol-kind", (e) => e.length > 0 && e.every((x) => x.textContent.trim() === "POLICY")),
    await page.$$eval(".pol-card .pol-kind", (e) => [...new Set(e.map((x) => x.textContent.trim()))]));

  await page.click("#pol-back"); await page.waitForTimeout(900);
  await page.click('[data-pol-kind="sop"]'); await page.waitForTimeout(1200);
  check("EVERY CARD IN THE OTHER SAYS SOP",
    await page.$$eval(".pol-card .pol-kind", (e) => e.length > 0 && e.every((x) => x.textContent.trim() === "SOP")),
    await page.$$eval(".pol-card .pol-kind", (e) => [...new Set(e.map((x) => x.textContent.trim()))]));
  check("there is a way back out", !!(await page.$("#pol-back")));

  // ------------------------------------------------------------------
  section("A filter left in one library does not follow you into the other");
  {
    await page.selectOption("#pol-status", "Archived");
    await page.waitForTimeout(1100);
    check("the filter applies where it was set", (await page.$$("[data-pol-open]")).length === 0);
    await page.click("#pol-back"); await page.waitForTimeout(900);
    await page.click('[data-pol-kind="policy"]'); await page.waitForTimeout(1200);
    check("A STALE FILTER DOES NOT MAKE THE OTHER LIBRARY LOOK EMPTY",
      (await page.$$("[data-pol-open]")).length > 0, (await page.$$("[data-pol-open]")).length);
    check("...and the control shows cleared, not just behaves cleared",
      (await page.$eval("#pol-status", (e) => e.value)) === "");
  }

  // ------------------------------------------------------------------
  section("Searching before choosing looks in both");
  {
    await page.click("#pol-back"); await page.waitForTimeout(900);
    await page.fill("#pol-q", stamp);
    await page.waitForTimeout(1400);
    const kinds = await page.$$eval(".pol-card .pol-kind", (e) => [...new Set(e.map((x) => x.textContent.trim()))].sort());
    check("A SEARCH FROM THE LANDING RETURNS BOTH KINDS", kinds.join(",") === "POLICY,SOP", kinds);
  }

  // ------------------------------------------------------------------
  section("Reading one: the right fields, and the other half of the pair");
  {
    // Still on the landing from the search above -- there is no way "back" from
    // there, so the search is cleared and a door chosen instead.
    await page.click("#pol-clear"); await page.waitForTimeout(1100);
    await page.click('[data-pol-kind="policy"]'); await page.waitForTimeout(1200);
    const titles = await page.$$eval("[data-pol-open] .pol-title", (e) => e.map((x) => x.textContent));
    const i = titles.findIndex((t) => /Documentation Policy/.test(t));
    await (await page.$$("[data-pol-open]"))[i].click();
    await page.waitForTimeout(1100);
    const text = await page.$eval(".modal", (e) => e.textContent);
    check("it is labelled a policy", /POLICY/.test(text));
    check("its number, department and owner are shown",
      /POL-900/.test(text) && /Clinical/.test(text) && /Quiana Blake/.test(text));
    check("who it applies to is shown", /Applies to/.test(text) && /RBT/.test(text));
    check("purpose is its own section", /PURPOSE|Purpose/.test(text));
    check("the body is headed as a policy statement, not as steps",
      /Policy statement/i.test(text) && !/^Procedure$/im.test(text));
    check("THE SOP THAT CARRIES IT OUT IS OFFERED",
      /How this is carried out/i.test(text) && (await page.$$("[data-rel-open]")).length === 1, text.slice(0, 200));
    check("revision history is available", /Revision history/i.test(text));

    // The link reads from both ends: opening the SOP must show the policy.
    await page.click("[data-rel-open]");
    await page.waitForTimeout(1300);
    const sopText = await page.$eval(".modal", (e) => e.textContent);
    check("OPENING THE RELATED SOP SHOWS THE POLICY BACK", /Governed by/i.test(sopText) && /Documentation Policy/.test(sopText),
      sopText.slice(0, 220));
    check("...and the SOP's body is headed as a procedure", /Procedure/i.test(sopText));
    check("only one reader is open at a time", (await page.$$(".modal-backdrop")).length === 1,
      (await page.$$(".modal-backdrop")).length);
  }

  // ------------------------------------------------------------------
  section("Photos on an SOP");
  // Asserted while the OWNER is still signed in -- the upload door is behind
  // canPolicyEdit, so checking it from the staff session below would prove
  // only that it is absent, which is a different claim.
  await openPolicies();
  const sopDoor = await page.$('[data-pol-kind="sop"]');
  if (sopDoor) { await sopDoor.click(); await page.waitForTimeout(900); }
  const firstSop = await page.$("[data-pol-open]");
  if (firstSop) {
    await firstSop.click();
    await page.waitForSelector(".pol-read", { timeout: 10000 });
    const reader = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
    check("the reader has a Photos section", /Photos/i.test(reader), reader.slice(0, 700));
    check("AND THE OWNER IS OFFERED A WAY TO ADD THEM", !!(await page.$("#pol-r-photo")));
    check("with a line saying why a photo earns its place in a procedure",
      /worth a paragraph|makes the rule clearer/i.test(reader), reader.slice(0, 1000));
    await page.click("#pol-r-photo");
    await page.waitForSelector("#pol-ph-files", { timeout: 10000 });
    const up = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
    check("THE UPLOAD SCREEN ASKS WHICH STEP EACH PHOTO BELONGS TO, not just for files",
      /step/i.test(up), up.slice(0, 600));
    check("and says that is what makes it part of the procedure",
      /part of the procedure|rather than as a gallery/i.test(up), up.slice(0, 700));
    check("the file input takes images only",
      ((await page.getAttribute("#pol-ph-files", "accept")) || "").includes("image"),
      await page.getAttribute("#pol-ph-files", "accept"));
    check("and more than one at a time",
      (await page.getAttribute("#pol-ph-files", "multiple")) !== null);
    await page.evaluate(() => { const b = document.querySelector(".modal-backdrop .close-btn"); if (b) b.click(); });
    await page.waitForTimeout(400);
  } else {
    check("an SOP exists to illustrate", false, "no SOP card found behind the SOP door");
  }

  section("Staff read, admins write");
  {
    await page.keyboard.press("Escape").catch(() => {});
    await login("clinical@spectrumsquadlv.com", "TestStaff123!");
    await openPolicies();
    check("a clinical user still gets both doors", (await page.$$("[data-pol-kind]")).length === 2);
    await page.click('[data-pol-kind="policy"]');
    await page.waitForTimeout(1200);
    check("they can read the library", (await page.$$("[data-pol-open]")).length > 0);
    check("THEY ARE OFFERED NO WAY TO CREATE ONE", !(await page.$("#pol-add")));
    await (await page.$("[data-pol-open]")).click();
    await page.waitForTimeout(1000);
    check("...nor to edit the one they opened", !(await page.$("#pol-r-edit")));
    check("...nor to link it", !(await page.$("#pol-r-link")));
    check("...NOR TO ADD PHOTOS, which is editing the procedure", !(await page.$("#pol-r-photo")));
  }

  check("no page errors anywhere in this run", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
