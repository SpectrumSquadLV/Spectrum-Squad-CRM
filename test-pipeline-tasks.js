// Three changes, checked together because they all touch the client card and
// the dashboard: Intake Packet is gone as a phase, the Pipeline Snapshot
// counts the clients it actually shows, and a stage task can be un-ticked.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let dialogAnswer = true;
  const dialogs = [];
  page.on("dialog", async (d) => { dialogs.push(d.message()); dialogAnswer ? await d.accept() : await d.dismiss(); });

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

  // ============ 1. Intake Packet is gone ============
  const dash = await page.evaluate(async () => (await fetch("/api/dashboard", { credentials: "include" })).json());
  const stageKeys = (dash.stages || []).map((s) => s.key);
  check("intake_packet is not a stage any more", !stageKeys.includes("intake_packet"), stageKeys.join(","));
  check("the stages either side survived",
    stageKeys.includes("insurance_verification") && stageKeys.includes("assessment_scheduling"), stageKeys.join(","));

  const stranded = await page.evaluate(async () => {
    const list = await (await fetch("/api/clients", { credentials: "include" })).json();
    return (Array.isArray(list) ? list : []).filter((c) => c.stage === "intake_packet").length;
  });
  check("no client is left in the retired stage", stranded === 0, "stranded=" + stranded);

  await page.evaluate(() => { location.hash = "#/dashboard"; });
  await page.waitForTimeout(2500);
  const dashText = await page.locator("#view-mount").innerText();
  check("the snapshot no longer lists Intake Packet", !/Intake Packet/i.test(dashText), dashText.slice(0, 400));

  // ============ 2. the snapshot counts what it shows ============
  const shown = (dash.stages || [])
    .filter((s) => !["discharged", "not_moving_forward"].includes(s.key))
    .reduce((sum, s) => {
      const row = (dash.byStage || []).find((b) => b.stage === s.key);
      return sum + (row ? Number(row.n) : 0);
    }, 0);
  check("the pipeline count equals the stages on show", Number(dash.activeClients) === shown,
    `activeClients=${dash.activeClients} sumOfBars=${shown}`);

  const closedCount = (dash.byStage || [])
    .filter((b) => ["discharged", "not_moving_forward"].includes(b.stage))
    .reduce((s, b) => s + Number(b.n), 0);
  check("closed-out clients are counted separately, not lost", Number(dash.closedClients) === closedCount,
    `closedClients=${dash.closedClients} actual=${closedCount}`);
  check("active + closed still equals everyone", Number(dash.activeClients) + Number(dash.closedClients) === Number(dash.totalClients),
    `${dash.activeClients} + ${dash.closedClients} vs ${dash.totalClients}`);
  check("the card is labelled as the pipeline, not all clients ever", /Clients in the pipeline/i.test(dashText), dashText.slice(0, 200));

  // A discharged client's expired authorization must stop being chased.
  const authProbe = await page.evaluate(async () => {
    const list = await (await fetch("/api/clients", { credentials: "include" })).json();
    // A client who is still in the pipeline. Picking list[0] blindly could
    // land on one a previous run discharged, and the probe would measure
    // nothing.
    const c = (Array.isArray(list) ? list : []).find((x) => !["discharged", "not_moving_forward"].includes(x.stage));
    if (!c) return null;
    const before = await (await fetch("/api/dashboard", { credentials: "include" })).json();
    await fetch(`/api/clients/${c.id}/authorization`, {
      method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorization_status: "Approved", auth_expiration_date: "2020-01-01" }),
    });
    const withExpired = await (await fetch("/api/dashboard", { credentials: "include" })).json();
    const priorStage = c.stage;
    await fetch(`/api/clients/${c.id}/discharge`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "auth-count probe" }),
    });
    const afterDischarge = await (await fetch("/api/dashboard", { credentials: "include" })).json();
    await fetch(`/api/clients/${c.id}/discharge`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: priorStage, reason: "" }),
    });
    await fetch(`/api/clients/${c.id}/authorization`, {
      method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorization_status: "Not Required", auth_expiration_date: "" }),
    });
    return {
      base: before.authCounts && before.authCounts.expired,
      withExpired: withExpired.authCounts && withExpired.authCounts.expired,
      afterDischarge: afterDischarge.authCounts && afterDischarge.authCounts.expired,
    };
  });
  if (authProbe) {
    check("an expired auth on a live client is counted", authProbe.withExpired === authProbe.base + 1, JSON.stringify(authProbe));
    check("discharging that client stops it being counted", authProbe.afterDischarge === authProbe.base, JSON.stringify(authProbe));
  } else {
    check("auth probe ran", false, "no client available");
  }

  // ============ 3. a stage task can be un-ticked ============
  const target = await page.evaluate(async () => {
    const tasks = await (await fetch("/api/tasks?status=all", { credentials: "include" })).json();
    const open = (Array.isArray(tasks) ? tasks : []).find((t) => t.status !== "completed");
    return open ? { taskId: open.id, clientId: open.client_id, label: open.label } : null;
  });
  check("found an open stage task", !!target, JSON.stringify(target));

  if (target) {
    await page.evaluate((id) => openClientModal(id), target.clientId);
    await page.waitForTimeout(2400);
    let modal = page.locator(".modal-backdrop").last();
    check("the card explains that undo doesn't move the client back",
      /Undo puts a task back to not done/i.test(await modal.innerText()));

    await modal.locator(`[data-complete-task="${target.taskId}"]`).click();
    await page.waitForTimeout(2600);

    modal = page.locator(".modal-backdrop").last();
    const undoBtn = modal.locator(`[data-reopen-task="${target.taskId}"]`);
    check("a completed task offers Undo", await undoBtn.count() > 0);

    const state1 = await page.evaluate(async (tid) => {
      const tasks = await (await fetch("/api/tasks?status=all", { credentials: "include" })).json();
      const t = tasks.find((x) => x.id === tid);
      return t && t.status;
    }, target.taskId);
    check("marking done is recorded", state1 === "completed", state1);

    dialogAnswer = true;
    await undoBtn.click();
    await page.waitForTimeout(2800);
    const state2 = await page.evaluate(async (tid) => {
      const tasks = await (await fetch("/api/tasks?status=all", { credentials: "include" })).json();
      const t = tasks.find((x) => x.id === tid);
      return t && { status: t.status, completed_at: t.completed_at };
    }, target.taskId);
    check("undo puts the task back to not done", state2 && state2.status !== "completed", JSON.stringify(state2));
    check("undo clears the completion timestamp", state2 && !state2.completed_at, JSON.stringify(state2));

    modal = page.locator(".modal-backdrop").last();
    check("the card shows it as open again",
      (await modal.locator(`[data-complete-task="${target.taskId}"]`).count()) > 0);
  }

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
