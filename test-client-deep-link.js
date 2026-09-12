// test-client-deep-link.js -- #/pipeline/<id> must never stop working.
//
// That hash is the link to ONE CHILD'S RECORD, and it is everywhere the CRM
// writes to a person: screener emails, document requests, task notices, the
// hire and intake packets, the Date of Birth check, the authorization alerts.
// Links already sitting in somebody's inbox cannot be reissued.
//
// It used to open the old kanban board and lay the client modal over it. That
// board has been retired -- the Clients board replaced it -- so the Clients
// board now paints behind the modal instead. This suite is the guarantee that
// the swap did not break the link, and that an old #/pipeline bookmark still
// lands somewhere useful rather than on an empty page.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

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

  const live = await page.evaluate(async () => {
    const list = await (await fetch("/api/clients", { credentials: "include" })).json();
    return (Array.isArray(list) ? list : [])
      .filter((c) => !["discharged", "not_moving_forward"].includes(c.stage))
      .map((c) => ({ id: c.id, name: c.child_name }));
  });
  check("there is a live client to link to", live.length >= 1, JSON.stringify(live).slice(0, 200));
  if (!live.length) { await browser.close(); process.exit(1); }
  const target = live[0];

  console.log("\n== The old board's address still gets somebody somewhere ==");
  await page.evaluate(() => { location.hash = "#/pipeline"; });
  await page.waitForTimeout(2200);
  check("#/pipeline redirects to the Clients board",
    await page.evaluate(() => location.hash) === "#/pipeline-v2",
    await page.evaluate(() => location.hash));
  check("...and the board actually drew",
    await page.evaluate(() => { const m = document.getElementById("view-mount"); return !!m && m.dataset.pv2 === "1"; }));
  check("...with the old kanban gone for good",
    await page.locator(".kanban-col").count() === 0);

  console.log("\n== An enrolment can still be added from the Clients screen ==");
  // The old board carried this button. Losing it would mean detouring via the
  // dashboard to add a client from the screen that lists clients.
  check("the Clients board offers + New Enrollment",
    await page.locator("#new-client-btn").count() === 1);
  await page.click("#new-client-btn");
  await page.waitForTimeout(800);
  check("...and it opens the enrolment form",
    await page.locator("#nc-dob, [data-usdate-for=\"nc-dob\"]").count() >= 1);
  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));

  console.log("\n== The link in every client email still opens that child ==");
  await page.evaluate((id) => { location.hash = "#/pipeline/" + id; }, target.id);
  await page.waitForTimeout(2500);
  const modal = page.locator(".modal-backdrop");
  check("the client record opens", await modal.count() >= 1, await page.evaluate(() => location.hash));
  const modalText = (await modal.first().innerText().catch(() => "")) || "";
  check("...and it is the right child", modalText.includes(target.name), modalText.slice(0, 200));

  // THE POINT OF THE CHANGE: the board is painted behind, so this is not a
  // modal floating over a blank page, and closing it leaves a usable screen.
  check("...with the Clients board behind it, not an empty page",
    await page.evaluate(() => { const m = document.getElementById("view-mount"); return !!m && m.dataset.pv2 === "1"; }));

  console.log("\n== And closing it leaves the reader on the board ==");
  await page.locator(".modal-backdrop .close-btn").first().click();
  await page.waitForTimeout(2000);
  check("the modal closes", await page.locator(".modal-backdrop").count() === 0);
  check("...onto the Clients board, not nowhere",
    await page.evaluate(() => location.hash) === "#/pipeline-v2",
    await page.evaluate(() => location.hash));
  check("...which is still drawn", await page.evaluate(() => {
    const m = document.getElementById("view-mount"); return !!m && m.dataset.pv2 === "1";
  }));

  check("no page errors throughout", errors.length === 0, errors.slice(0, 3).join(" | "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
