// test-punchlist-ui.js -- the screens for the seven repair items.
//
// test-punchlist.js proves the SERVER does the right thing. This proves the
// buttons exist, are wired up, and are drawn for the right people -- the half
// of several of these items that was actually broken (the supply section, for
// instance, was fully working server-side and simply had no way in).
//
//   DATABASE_URL=... node server.js
//   node test-punchlist-ui.js
const { chromium } = require("playwright");
const { openCardSection, cardHintText } = require("./card-test-helpers");
const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";
const STAFF_PW = process.env.STAFF_PASSWORD || "TestStaff123!";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "\n          -> " + String(detail).slice(0, 400) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  async function signIn(email, password) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 20000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(2800);
    return { page, errors };
  }

  const api = (page, path, opts) => page.evaluate(async ({ p, o }) => {
    const r = await fetch(p, {
      method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: o && o.body ? JSON.stringify(o.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { p: path, o: opts });

  const stamp = Date.now().toString().slice(-6);
  const { page: owner, errors: ownerErrors } = await signIn("admin@spectrumsquadlv.com", OWNER_PW);
  check("owner signs in", await owner.locator(".sidebar").isVisible().catch(() => false));

  // A client of our own, so nothing here depends on demo data.
  const made = await api(owner, "/api/clients", {
    method: "POST",
    body: { child_name: "UI Punchlist " + stamp, parent_name: "UI Parent", parent_email: `ui.${stamp}@example.invalid` },
  });
  const clientId = made.body && made.body.id;
  check("created a client to work with", !!clientId, made);

  // Two ways in, because they behave differently and both must work: the
  // pipeline board sets a #/pipeline/<id> URL, while the Task Center, the
  // tasks table and the auth alerts call openClientModal() directly.
  const openCard = async (page, id) => {
    await page.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); location.hash = "#/dashboard"; });
    await page.waitForTimeout(800);
    await page.evaluate((cid) => { location.hash = "#/pipeline/" + cid; }, id);
    await page.waitForTimeout(2600);
    return page.locator(".modal-backdrop").last();
  };
  const openCardDirect = async (page, id) => {
    await page.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); location.hash = "#/dashboard"; });
    await page.waitForTimeout(700);
    await page.evaluate((cid) => openClientModal(cid), id);
    await page.waitForTimeout(2400);
    return page.locator(".modal-backdrop").last();
  };

  // ================= 1. Reactivate =================
  section("1. Reactivate from Not Moving Forward");

  let card = await openCard(owner, clientId);
  await openCardSection(owner, "closeout");
  let text = await card.innerText();
  check("a live client shows the close-out buttons", /Not moving forward/i.test(text), text.slice(0, 300));
  check("a live client shows no reactivate panel", !(await card.locator("#reactivate-btn").count()));

  await api(owner, `/api/clients/${clientId}/discharge`, { method: "POST", body: { reason: "Never responded", stage: "not_moving_forward" } });
  await owner.evaluate(async () => { await loadClients(); });

  card = await openCard(owner, clientId);
  text = await card.innerText();
  check("a closed-out client shows the reactivate panel", (await card.locator("#reactivate-btn").count()) === 1, text.slice(0, 400));
  // That reassurance moved onto the hover icon when the card's sections were
  // folded; the panel itself is now buttons and state.
  check("the panel explains the record is kept",
    /same record/i.test(await cardHintText(owner)) || /stays exactly where it is/i.test(await cardHintText(owner)));
  check("the closure reason is shown on the panel", /Never responded/.test(text), text.slice(0, 400));
  check("the close-out buttons are gone while closed out", !(await card.locator("#not-moving-btn").count()));

  const stageOptions = await card.locator("#reactivate-stage option").allTextContents();
  check("the stage picker offers live pipeline stages", stageOptions.length >= 5, stageOptions);
  check("the stage picker does not offer a terminal stage",
    !stageOptions.some((o) => /not moving forward|discharged/i.test(o)), stageOptions);

  await card.locator("#reactivate-stage").selectOption("assessment_scheduling");
  owner.once("dialog", (d) => d.accept());          // the confirm()
  await card.locator("#reactivate-btn").click();
  await owner.waitForTimeout(900);
  // askReason() renders its own modal; confirm it and go.
  const reasonBox = owner.locator("#reason-input");
  if (await reasonBox.count()) {
    await reasonBox.fill("Family called back " + stamp);
    await owner.locator("#reason-confirm").click();
  }
  await owner.waitForTimeout(2500);

  let after = await api(owner, `/api/clients/${clientId}`);
  check("the client is back in the live pipeline", after.body.client.stage === "assessment_scheduling", after.body.client.stage);
  card = await openCard(owner, clientId);
  await openCardSection(owner, "notes");
  await owner.waitForTimeout(1000);
  text = await card.innerText();
  check("the card shows the reactivation in the note history", /Reactivated/.test(text), text.slice(0, 1200));
  check("the note names the original closure reason", /Never responded/.test(text), text.slice(0, 1200));

  // ================= 6. Send Clinical Screener =================
  section("6. Send Clinical Screener button");

  card = await openCard(owner, clientId);
  check("the client card carries a Send Screener button", (await card.locator("#screener-send-btn").count()) === 1);
  check("the View Screener button is still there", (await card.locator("#screener-view-btn").count()) === 1);
  // Opened from anywhere other than the pipeline board there is no client id in
  // the URL, which used to make both buttons vanish.
  const direct = await openCardDirect(owner, clientId);
  check("the buttons are there when the card is opened without a client URL",
    (await direct.locator("#screener-send-btn").count()) === 1 && (await direct.locator("#screener-view-btn").count()) === 1);
  card = await openCard(owner, clientId);
  let strip = await owner.locator("#screener-status-strip").innerText().catch(() => "");
  check("the strip says it has not been sent", /Not sent yet/i.test(strip), strip);
  check("the strip explains why the automation hasn't fired", /enrollment packet/i.test(strip), strip);

  await card.locator("#screener-send-btn").click();
  await owner.waitForTimeout(2500);
  strip = await owner.locator("#screener-status-strip").innerText().catch(() => "");
  check("the strip confirms the send", /sent to/i.test(strip) || /Sent /.test(strip), strip);

  await owner.waitForTimeout(1500);
  const st = await api(owner, `/api/screener/status/${clientId}`);
  check("the send really happened and is attributed", st.body.manual_send_count === 1 && !!st.body.last_manual_sent_by, st.body);

  // A second click inside the cooldown asks first.
  card = await openCard(owner, clientId);
  await owner.waitForTimeout(1200);
  let asked = false;
  owner.once("dialog", (d) => { asked = /already sent|again/i.test(d.message()); d.dismiss(); });
  await card.locator("#screener-send-btn").click();
  await owner.waitForTimeout(2500);
  check("a repeat click asks before sending again", asked);
  const st2 = await api(owner, `/api/screener/status/${clientId}`);
  check("declining the prompt sends nothing", st2.body.manual_send_count === 1, st2.body);

  // ================= 2. Emergency contacts =================
  section("2. Emergency contact editor");

  card = await openCard(owner, clientId);
  await openCardSection(owner, "emergency");
  await owner.waitForTimeout(1200);
  const ecText = await card.locator("#emergency-mount").innerText().catch(() => "");
  check("the client card warns that an emergency contact is needed", /Emergency contact needed/i.test(ecText), ecText.slice(0, 300));
  check("the warning states both conditions",
    /not the parent/i.test(ecText) && /does not live in the client's home/i.test(ecText), ecText.slice(0, 400));

  await card.locator("#emergency-mount [data-ec-add]").click();
  await owner.waitForTimeout(700);
  const drawer = owner.locator(".modal-backdrop").last();
  check("the editor asks the household question", (await drawer.locator('[data-k="outside_household"]').count()) === 1);
  const drawerText = await drawer.innerText();
  check("the question names the rule", /does not live in the client's home/i.test(drawerText), drawerText.slice(0, 400));

  await drawer.locator('[data-k="name"]').fill("Neighbour Pat " + stamp);
  await drawer.locator('[data-k="relationship"]').fill("Neighbour");
  await drawer.locator('[data-k="phone"]').fill("(702) 555-0155");
  await drawer.locator("[data-drawer-save]").click();
  await owner.waitForTimeout(900);
  check("saving without the confirmation is blocked in the editor",
    /does not live in the client's home/i.test(await drawer.locator("[data-drawer-status]").innerText()),
    await drawer.locator("[data-drawer-status]").innerText());

  await drawer.locator('[data-k="outside_household"]').check();
  await drawer.locator("[data-drawer-save]").click();
  await owner.waitForTimeout(1800);

  card = await openCard(owner, clientId);
  await openCardSection(owner, "emergency");
  await owner.waitForTimeout(1500);
  const ecText2 = await card.locator("#emergency-mount").innerText().catch(() => "");
  check("the contact saved", new RegExp("Neighbour Pat " + stamp).test(ecText2), ecText2.slice(0, 400));
  check("the card confirms they live elsewhere", /does not live in the client's home/i.test(ecText2), ecText2.slice(0, 400));
  check("the warning banner is gone", !/Emergency contact needed/i.test(ecText2), ecText2.slice(0, 300));

  // ================= 5. Supervision delete =================
  section("5. Supervision record deletion");

  const emp = await api(owner, "/api/hr/employees", {
    method: "POST", body: { name: "UI RBT " + stamp, email: `uirbt.${stamp}@example.invalid`, role_title: "RBT", status: "active" },
  });
  const empId = emp.body && (emp.body.id || (emp.body.employee && emp.body.employee.id));
  check("created a supervised staff member", !!empId, emp.body);
  const month = "2026-06";
  await api(owner, `/api/supervision/employee/${empId}`, {
    method: "POST", body: { month, hours_worked: 80, entries: [{ date: "2026-06-04", activity: "Obs", duration: 2, supervisor: "Allie R." }] },
  });

  await owner.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); });
  await owner.evaluate(({ e, m }) => window.HRSupervision.openEditor(e, m), { e: empId, m: month });
  await owner.waitForTimeout(2200);
  let supModal = owner.locator(".modal-backdrop").last();
  check("the owner sees a delete button on the supervision month", (await supModal.locator("#sup-delete").count()) === 1,
    (await supModal.innerText()).slice(0, 400));
  check("the button says what is kept", /kept in the supervision history/i.test(await supModal.innerText()));

  owner.once("dialog", async (d) => { await d.accept("Recorded against the wrong staff member"); });
  await supModal.locator("#sup-delete").click();
  await owner.waitForTimeout(2500);

  const supAfter = await api(owner, `/api/supervision/employee/${empId}?month=${month}`);
  check("the record is gone", (supAfter.body.entries || []).length === 0, supAfter.body.entries);
  check("the deletion is kept in the history",
    (supAfter.body.amendments || []).some((a) => a.action === "deleted"), supAfter.body.amendments);

  await owner.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); });
  await owner.evaluate(({ e, m }) => window.HRSupervision.openEditor(e, m), { e: empId, m: month });
  await owner.waitForTimeout(2200);
  supModal = owner.locator(".modal-backdrop").last();
  check("the delete button hides once there is nothing to delete", (await supModal.locator("#sup-delete").count()) === 0);
  check("the history panel shows the deletion", /record deleted/i.test(await supModal.innerText()), (await supModal.innerText()).slice(0, 500));
  await owner.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); });

  // ================= staff-side screens =================
  const { page: staff, errors: staffErrors } = await signIn("clinical@spectrumsquadlv.com", STAFF_PW);
  check("a non-supervisory staff member signs in", await staff.locator(".sidebar").isVisible().catch(() => false));

  // ---- 3. tasks ----
  section("3. Tasks & Alerts for a non-supervisory staff member");

  await staff.evaluate(() => { location.hash = "#/tasks"; });
  await staff.waitForTimeout(2600);
  const tasksText = await staff.locator("#view-mount").innerText();
  check("staff can reach Tasks & Alerts", /Tasks & Alerts/i.test(tasksText), tasksText.slice(0, 200));
  check("staff get the add-task form (this was hidden from them)",
    (await staff.locator("#stask-title").count()) === 1, tasksText.slice(0, 600));
  const assigneeOpts = await staff.locator("#stask-assignee option").allTextContents();
  check("the assignee list defaults to themselves", /Myself/i.test(assigneeOpts[0] || ""), assigneeOpts.slice(0, 4));
  check("they can also pick a colleague", assigneeOpts.length > 1, assigneeOpts.length);
  check("the page states the privacy rule", /task lists stay private/i.test(tasksText), tasksText.slice(0, 900));

  await staff.locator("#stask-title").fill("Staff-made task " + stamp);
  await staff.locator("#stask-add").click();
  await staff.waitForTimeout(2500);
  let tasksText2 = await staff.locator("#view-mount").innerText();
  check("the task they made for themselves appears", new RegExp("Staff-made task " + stamp).test(tasksText2), tasksText2.slice(0, 800));

  // ---- 7. reopen ----
  section("7. Undoing a completed task");

  await staff.locator(`[data-stask-done]`).first().click();
  await staff.waitForTimeout(2200);
  check("a reopen button appears once a task is done",
    (await staff.locator("[data-stask-reopen]").count()) >= 1);
  await staff.locator("[data-stask-reopen]").first().click();
  await staff.waitForTimeout(2200);
  tasksText2 = await staff.locator("#view-mount").innerText();
  check("the reopened task shows its completed-then-reopened history",
    /reopened by/i.test(tasksText2), tasksText2.slice(0, 900));
  check("reopening did not duplicate the task",
    (tasksText2.match(new RegExp("Staff-made task " + stamp, "g")) || []).length === 1);

  // Task Center on the dashboard: the Completed tab must offer a way back.
  await staff.evaluate(() => { location.hash = "#/dashboard"; });
  await staff.waitForTimeout(2600);
  await staff.evaluate(async () => {
    const t = (await (await fetch("/api/staff-tasks?scope=mine", { credentials: "include" })).json())[0];
    await fetch("/api/staff-tasks/" + t.id, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }),
    });
  });
  await staff.evaluate(() => { location.hash = "#/tasks"; location.hash = "#/dashboard"; });
  await staff.waitForTimeout(2800);
  const completedTab = staff.locator('[data-tc="completed"]');
  check("the Task Center has a Completed tab", (await completedTab.count()) === 1);
  await completedTab.click();
  await staff.waitForTimeout(1200);
  check("completed tasks in the Task Center offer Reopen (they used to be a dead end)",
    (await staff.locator("[data-tc-reopen]").count()) >= 1,
    await staff.locator("#task-center-body").innerText());
  await staff.locator("[data-tc-reopen]").first().click();
  await staff.waitForTimeout(2000);
  const openCount = await api(staff, "/api/staff-tasks/summary");
  check("the reopened task is counted as open again", Number(openCount.body.open) >= 1, openCount.body);

  // ---- 4. supply requests ----
  section("4. Supply Requests reachable by staff");

  const navText = await staff.locator(".sidebar nav").innerText();
  check("staff now have a Supply Requests nav entry", /Supply Requests/i.test(navText), navText);

  await staff.locator("#supply-nav-btn").click();
  await staff.waitForTimeout(2600);
  const supplyText = await staff.locator("#view-mount").innerText();
  check("the staff supply screen renders", /Supply Requests/i.test(supplyText), supplyText.slice(0, 300));
  check("there is a form to submit a request", (await staff.locator("#sup-new-item").count()) === 1, supplyText.slice(0, 400));
  check("and a list of their own requests", /My requests/i.test(supplyText), supplyText.slice(0, 400));

  await staff.locator("#sup-new-item").fill("Bubble wands " + stamp);
  await staff.locator("#sup-new-qty").fill("1 pack");
  await staff.locator("#sup-new-send").click();
  await staff.waitForTimeout(3000);
  const supplyText2 = await staff.locator("#view-mount").innerText();
  check("the submitted request appears in their list", new RegExp("Bubble wands " + stamp).test(supplyText2), supplyText2.slice(0, 700));

  const ownerQueue = await api(owner, "/api/supply/requests?status=all");
  check("it lands in the owner's queue",
    (ownerQueue.body.rows || []).some((r) => r.item_name === "Bubble wands " + stamp),
    (ownerQueue.body.rows || []).map((r) => r.item_name).slice(0, 5));

  // The staff view must not draw controls the server would reject.
  await staff.locator(".sup-row").first().click();
  await staff.waitForTimeout(1800);
  const detail = staff.locator(".modal-backdrop").last();
  check("a staff member's own request opens", (await detail.count()) === 1);
  check("no status-change buttons are drawn for staff", (await detail.locator("[data-to]").count()) === 0);
  check("no internal cost field is drawn for staff", (await detail.locator("#sup-cost").count()) === 0);
  check("they can still read the history", /History/i.test(await detail.innerText()));

  // Owner keeps the management view.
  await owner.evaluate(() => { location.hash = "#/supply"; });
  await owner.waitForTimeout(2800);
  const ownerSupply = await owner.locator("#view-mount").innerText();
  check("the owner still gets the full queue view", /Copy staff link/i.test(ownerSupply) || /Settings/i.test(ownerSupply), ownerSupply.slice(0, 300));
  check("the owner sees requests from other staff", new RegExp("Bubble wands " + stamp).test(ownerSupply), ownerSupply.slice(0, 700));

  section("no broken pages");
  check("no uncaught JavaScript errors on the owner's session", ownerErrors.length === 0, ownerErrors.join(" | "));
  check("no uncaught JavaScript errors on the staff session", staffErrors.length === 0, staffErrors.join(" | "));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
