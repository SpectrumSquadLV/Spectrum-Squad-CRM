// Who is looking after this child, on the child's own record.
//
//   DATABASE_URL=... node run-tests.js test-client-care-team.js
//
// Reported as "the assigned BCBAs are not showing under the individual client
// profile". They were not, and there were two separate reasons — one cosmetic,
// one that made a screen state something false.
//
// 1. IT WAS IN THE WRONG PLACE. The BCBA appeared in exactly two spots on the
//    client card, both inside collapsed sections: the AUTHORIZATION card — an
//    insurance section — and, oddly, First Day of ABA. The pipeline card, the
//    caseload board and the dashboard all showed it. The client's own record,
//    the one place somebody opens to ask "who has this child", did not. The
//    Student Analyst and Squad Leader were on the record and rendered NOWHERE,
//    so a caseload could be reassigned and leave no visible trace on the client.
//
// 2. IT WAS BEHIND AN INSURANCE GATE. assigned_bcba_name sat in AUTH_FIELDS,
//    which is stripped from every client row for roles that cannot view
//    authorization data — intake and scheduling among them. The result was not
//    a blank: First Day of ABA told those roles "Not assigned yet" and "no
//    confirmation will be sent until a BCBA is assigned", about clients who
//    HAVE a BCBA. Scheduling is the role that works that card.
//
// THE SUBTLETY THAT MADE THIS EASY TO GET WRONG: AUTH_FIELDS was doing two
// different jobs — the list withheld on READ, and the list editable through the
// authorization endpoint. Simply removing the BCBA from it would have fixed the
// read and quietly broken assignment, since that endpoint is the only way the
// name is ever set. The lists are now separate, and this suite holds both ends:
// the name is readable by everyone who can see the client, and still only
// settable by the roles that could always set it.
//
// What must NOT leak is checked just as hard. The payer, the dates, the status,
// the notes, the billing contact and the BCBA's EMAIL ADDRESS stay withheld —
// a staff contact detail is a different thing from a clinician's name.
"use strict";
const { chromium } = require("playwright");
const { Pool } = require("pg");

const BASE = process.env.BASE || "http://localhost:3009";

function api() {
  let jar = "";
  return async (path, { method = "GET", body } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(jar ? { Cookie: jar } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) jar = sc.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  let pass = 0, fail = 0;
  const failures = [];
  const check = (n, c, d) => {
    if (c) { pass++; console.log("  PASS  " + n); }
    else {
      const line = "  FAIL  " + n + (d !== undefined ? "  -> " + (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 400) : "");
      fail++; failures.push(line); console.log(line);
    }
  };
  const login = async (email, password) => {
    const c = api();
    const r = await c("/api/auth/login", { method: "POST", body: { email, password } });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
    return c;
  };

  const owner = await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const clinical = await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  const scheduling = await login("scheduling@spectrumsquadlv.com", "TestOwner123!");
  const intake = await login("intake@spectrumsquadlv.com", "TestStaff123!");

  const made = await owner("/api/clients", {
    method: "POST",
    body: { child_name: "Care Team Child", parent_name: "Care Parent", parent_email: "care@example.invalid" },
  });
  const id = made.data.id;
  const bare = await owner("/api/clients", {
    method: "POST",
    body: { child_name: "Nobody Assigned Child", parent_name: "Bare Parent", parent_email: "bare@example.invalid" },
  });
  const bareId = bare.data.id;

  console.log("\n== Assigning is unchanged: only the roles that could, still can ==");
  const setBcba = (c, name) => c(`/api/clients/${id}/authorization`, {
    method: "PATCH",
    body: { assigned_bcba_name: name, assigned_bcba_email: "ct.bcba@example.invalid", insurance_payer: "Test Payer", auth_notes: "private note" },
  });
  const nameInDb = async () => (await pool.query(
    "SELECT assigned_bcba_name FROM clients WHERE id = $1", [id])).rows[0].assigned_bcba_name;

  // Checked against the DATABASE, not the status code. A BCBA is allowed to
  // save auth_notes through this same endpoint, so sending both in one body
  // returns 200 while silently ignoring the name — which is correct behaviour
  // and would make a status-code assertion here pass for the wrong reason.
  await setBcba(clinical, "Clinical Should Not Set This");
  check("A BCBA STILL CANNOT ASSIGN THE BCBA — checked in the row, not the status",
    (await nameInDb()) !== "Clinical Should Not Set This", await nameInDb());
  const asScheduling = await setBcba(scheduling, "Scheduling Should Not Set This");
  check("nor can scheduling, which is refused outright", asScheduling.status === 403, asScheduling.status);
  check("and nothing of theirs landed either", (await nameInDb()) !== "Scheduling Should Not Set This");
  const assigned = await setBcba(owner, "Care Team BCBA");
  check("AN OWNER STILL CAN — the endpoint that sets it is untouched", assigned.status === 200, assigned.data);
  check("and the name is on the row", (await nameInDb()) === "Care Team BCBA", await nameInDb());

  // The other two are ordinary client columns, set by the assignment migration.
  await pool.query(
    "UPDATE clients SET assigned_student_analyst_name = $1, squad_leader_name = $2 WHERE id = $3",
    ["Care Team Analyst", "Care Team Leader", id]);

  console.log("\n== Everyone who can see the client can see who has them ==");
  const rowFor = async (c, cid) => {
    const r = await c("/api/clients");
    return (r.data || []).find((x) => String(x.id) === String(cid));
  };
  for (const [label, c] of [["owner", owner], ["clinical", clinical], ["scheduling", scheduling], ["intake", intake]]) {
    const row = await rowFor(c, id);
    check(`${label} reads the assigned BCBA`, row && row.assigned_bcba_name === "Care Team BCBA",
      { role: label, value: row && row.assigned_bcba_name });
  }

  console.log("\n== And what is actually authorization data still is not theirs ==");
  // The half that makes the change safe. If this ever goes green-to-red, the
  // split between "withheld on read" and "editable" has been collapsed again.
  for (const [label, c] of [["scheduling", scheduling], ["intake", intake]]) {
    const row = await rowFor(c, id);
    check(`${label} does NOT get the payer`, row && row.insurance_payer === undefined, { role: label, v: row && row.insurance_payer });
    check(`${label} does NOT get the auth notes`, row && row.auth_notes === undefined, { role: label, v: row && row.auth_notes });
    check(`${label} does NOT get the BCBA's EMAIL — a name is not a contact detail`,
      row && row.assigned_bcba_email === undefined, { role: label, v: row && row.assigned_bcba_email });
    check(`${label} does NOT get the billing contact`, row && row.assigned_billing_name === undefined, { role: label, v: row && row.assigned_billing_name });
  }
  const ownerRow = await rowFor(owner, id);
  check("an owner still gets all of it", ownerRow.insurance_payer === "Test Payer" && ownerRow.assigned_bcba_email === "ct.bcba@example.invalid", {
    payer: ownerRow.insurance_payer, email: ownerRow.assigned_bcba_email });

  // ------------------------------------------------------------------ UI ---
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  const openAs = async (email, pw, cid) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {}
      try { localStorage.clear(); } catch (e) {}
    });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', pw);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(2200);
    await page.evaluate((c) => { location.hash = "#/pipeline/" + c; }, cid);
    await page.waitForSelector(".modal-backdrop", { timeout: 20000 });
    await page.waitForTimeout(1200);
  };
  // The care team block is read WITHOUT expanding anything: being visible on
  // open is the entire point of the change.
  const careTeam = () => page.evaluate(() => {
    const heads = [...document.querySelectorAll(".modal-backdrop .section-title")]
      .filter((h) => /care team/i.test(h.textContent));
    if (!heads.length) return null;
    const card = heads[0].parentElement;
    const r = card.getBoundingClientRect();
    return { text: card.innerText.replace(/\s+/g, " ").trim(), visible: r.width > 0 && r.height > 0, top: Math.round(r.top) };
  });

  console.log("\n== On the client's own record, without expanding anything ==");
  await openAs("admin@spectrumsquadlv.com", "TestOwner123!", id);
  let ct = await careTeam();
  check("THERE IS A CARE TEAM ON THE CLIENT CARD", !!ct && ct.visible, ct);
  check("naming the BCBA", ct && /Care Team BCBA/.test(ct.text), ct && ct.text);
  check("the Student Analyst, which was on the record and shown nowhere",
    ct && /Care Team Analyst/.test(ct.text), ct && ct.text);
  check("and the Squad Leader", ct && /Care Team Leader/.test(ct.text), ct && ct.text);

  // The collapsible sections are <details data-cs="...">; the Authorization one
  // is data-cs="authorization". Targeting the section rather than hunting for a
  // text node is what makes this survive a wording change.
  const authTop = await page.evaluate(() => {
    const d = document.querySelector('.modal-backdrop [data-cs="authorization"]');
    return d ? Math.round(d.getBoundingClientRect().top) : null;
  });
  check("ABOVE the Authorization section, not inside it",
    ct && authTop !== null && ct.top < authTop, { careTeam: ct && ct.top, authorization: authTop });

  console.log("\n== Scheduling was being told something false ==");
  await openAs("scheduling@spectrumsquadlv.com", "TestOwner123!", id);
  ct = await careTeam();
  check("scheduling sees the care team too", !!ct && /Care Team BCBA/.test(ct.text), ct && ct.text);
  const modalText = await page.evaluate(() => document.querySelector(".modal-backdrop").textContent);
  check("AND IS NO LONGER TOLD 'Not assigned yet' ABOUT A CLIENT WHO HAS A BCBA",
    !/Not assigned yet/.test(modalText), modalText.slice(0, 200));
  check("still no payer on their screen", !/Test Payer/.test(modalText));
  check("still no auth note on their screen", !/private note/.test(modalText));
  check("and not the BCBA's email address either", !/ct\.bcba@example\.invalid/.test(modalText));

  console.log("\n== A client nobody is carrying says so ==");
  await openAs("admin@spectrumsquadlv.com", "TestOwner123!", bareId);
  ct = await careTeam();
  check("the care team still renders", !!ct && ct.visible, ct);
  check("SAYING PLAINLY THAT NOBODY IS ASSIGNED, rather than showing an empty box",
    ct && /Nobody is assigned to this client yet/i.test(ct.text), ct && ct.text);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
