// test-hire-packet-ui.js -- the packet in a browser, which is the only place
// most of it exists.
//
// test-hire-packet.js drives the API, and an API test cannot see the part the
// applicant actually meets: whether tapping a paragraph puts your initials in
// the box, whether the button unlocks before you have read the policy you are
// about to sign, whether a step you do not have to do is still on screen, or
// whether twenty minutes of typing survives the page being reopened.
//
// Those are exactly the failures that reach a real person and never reach a
// log, so they are asserted here against the real page.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-hire-packet-ui.js
const { chromium } = require("playwright");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "\n          -> " + String(detail).slice(0, 300) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  const stamp = Date.now();

  async function position(slug, title, roleType) {
    const r = await pool.query(
      `INSERT INTO hr_positions (slug, title, role_type, status, created_at)
       VALUES ($1,$2,$3,'open',now()) RETURNING id`, [`${slug}-${stamp}`, title, roleType]);
    return r.rows[0].id;
  }
  async function applicantWithPacket(name, email, positionId) {
    const a = await pool.query(
      `INSERT INTO hr_applicants (position_id, full_name, email, stage, applied_at, created_at, updated_at)
       VALUES ($1,$2,$3,'credentials_references',now(),now(),now()) RETURNING id`,
      [positionId, name, email]);
    const id = a.rows[0].id;
    // The sweep is what creates the packet in real life; it is driven here
    // through the server so the row is made the same way it is in production.
    const login = await fetch(BASE + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@spectrumsquadlv.com", password: "TestOwner123!" }),
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    await fetch(BASE + "/api/hire-packet/sweep", { method: "POST", headers: { Cookie: cookie } });
    const t = await pool.query("SELECT token FROM hire_packets WHERE applicant_id = $1", [id]);
    return { id, token: t.rows[0] && t.rows[0].token };
  }

  const rbtPos = await position("zzui-rbt", "Registered Behavior Technician", "rbt");
  const bcbaPos = await position("zzui-bcba", "Board Certified Behavior Analyst", "bcba");
  const rbt = await applicantWithPacket(`ZzUi Rbt ${stamp}`, `zzuirbt${stamp}@example.com`, rbtPos);
  const bcba = await applicantWithPacket(`ZzUi Bcba ${stamp}`, `zzuibcba${stamp}@example.com`, bcbaPos);

  const open = async (token) => {
    await page.goto(`${BASE}/hire-packet?token=${token}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
  };
  const stepName = () => page.evaluate(() => {
    const el = document.querySelector(".step.active");
    return el ? el.getAttribute("data-name") : null;
  });
  const nextLabel = () => page.evaluate(() => document.getElementById("nextBtn").textContent.trim());
  const nextDisabled = () => page.evaluate(() => document.getElementById("nextBtn").disabled);
  const clickNext = async () => { await page.click("#nextBtn"); await page.waitForTimeout(450); };
  async function scrollPolicyToEnd() {
    await page.evaluate(() => {
      const pane = document.querySelector(".step.active .policy");
      pane.scrollTop = pane.scrollHeight;
      pane.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(250);
  }
  async function drawSignature() {
    // The pad sits at the bottom of a long step. Mouse coordinates are
    // viewport-relative, so it has to be on screen before it can be drawn on.
    const box = await page.evaluate(() => {
      const c = document.querySelector(".step.active canvas.pad");
      c.scrollIntoView({ block: "center" });
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.waitForTimeout(250);
    await page.mouse.move(box.x + 20, box.y + box.h / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 20, { steps: 8 });
    await page.mouse.move(box.x + 140, box.y + box.h - 20, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    // What the pad is actually capturing. A canvas left at its 300x150 default
    // while its step was hidden still takes ink and still exports an image --
    // a squashed one, drawn on the transparent ground that a JPEG renders
    // black. So the size is checked, not just the fact that something arrived.
    return page.evaluate(() => {
      const c = document.querySelector(".step.active canvas.pad");
      const r = c.getBoundingClientRect();
      return { canvasW: c.width, canvasH: c.height, expectW: Math.round(r.width * (window.devicePixelRatio || 1)) };
    });
  }
  async function walkTo(name, guard) {
    for (let n = 0; n < 20; n++) {
      if ((await stepName()) === name) return true;
      if (guard) await guard(await stepName());
      await clickNext();
    }
    return (await stepName()) === name;
  }

  // ======================================================================
  section("It opens");
  await open(rbt.token);
  check("the welcome screen is the first thing you see", (await stepName()) === "welcome", await stepName());
  check("it does not look like an error page",
    (await page.textContent("h1")).indexOf("Let's make it official") >= 0, await page.textContent("h1"));
  check("the progress bar is there", await page.isVisible("#progressFill"));

  // ======================================================================
  section("Typing into it");
  await clickNext();
  check("the first question is who you are", (await stepName()) === "about", await stepName());
  await page.fill('[name="name_first"]', "ZzUi");
  await page.fill('[name="name_last"]', "Rbt");
  await page.fill('[name="phone_mobile"]', "702-555-0199");
  await page.waitForTimeout(1400);   // the autosave is debounced
  const savedRow = await pool.query("SELECT answers FROM hire_packets WHERE applicant_id = $1", [rbt.id]);
  const savedAnswers = JSON.parse(savedRow.rows[0].answers || "{}");
  check("what is typed is saved without pressing anything", savedAnswers.name_last === "Rbt", savedAnswers);

  await open(rbt.token);
  await clickNext();
  const stillThere = await page.inputValue('[name="name_last"]');
  check("...and is still there when the link is opened again", stillThere === "Rbt", stillThere);

  section("Employment history opens up as you need it");
  await walkTo("history");
  check("only the most recent employer is shown to begin with",
    (await page.isVisible("#employer1")) && !(await page.isVisible("#employer2")));
  await page.click("#addEmployer");
  await page.waitForTimeout(300);
  check("...and another appears when you ask for one", await page.isVisible("#employer2"));

  // ======================================================================
  section("Initialling the acknowledgement");
  await walkTo("acknowledgement");
  check("the clauses are all there", (await page.locator(".clause").count()) === 9, await page.locator(".clause").count());
  // The name is already there -- it carries over from the first step, which is
  // the point of carrying it over. Cleared here to check the other path.
  check("the name carries over from the application", (await page.inputValue("#ackName")) === "ZzUi Rbt",
    await page.inputValue("#ackName"));
  await page.fill("#ackName", "");
  await page.click(".clause");
  const beforeName = await page.textContent(".clause .box");
  check("tapping a clause with no name to initial with asks for the name first",
    beforeName.trim() === "\u2014" && (await page.isVisible('[data-err="acknowledgement"].show')), beforeName);

  await page.fill("#ackName", "ZzUi Rbt");
  await page.click(".clause");
  await page.waitForTimeout(150);
  check("...and then stamps your initials in the box", (await page.textContent(".clause .box")).trim() === "ZR",
    await page.textContent(".clause .box"));

  await clickNext();
  check("it will not move on with paragraphs left uninitialled",
    (await stepName()) === "acknowledgement" && /initial every paragraph/i.test(await page.textContent('[data-err="acknowledgement"]')),
    await page.textContent('[data-err="acknowledgement"]'));

  await page.evaluate(() => {
    document.querySelectorAll(".clause:not(.done)").forEach((el) => el.click());
  });
  await page.waitForTimeout(200);
  check("every clause can be initialled", (await page.locator(".clause.done").count()) === 9);

  await clickNext();
  check("...and it still will not move on without a signature",
    (await stepName()) === "acknowledgement" && /sign in the box/i.test(await page.textContent('[data-err="acknowledgement"]')),
    await page.textContent('[data-err="acknowledgement"]'));

  const pad = await drawSignature();
  check("the pad captures the box that is actually on screen, not a stale default",
    pad.canvasW === pad.expectW && pad.canvasW > 400, pad);
  await clickNext();
  await page.waitForTimeout(800);
  check("signing moves it on", (await stepName()) === "reporting",
    (await stepName()) + " / " + (await page.textContent('[data-err="acknowledgement"]').catch(() => "")));
  const ackRow = await pool.query(
    `SELECT s.* FROM hire_packet_sections s JOIN hire_packets p ON p.id = s.packet_id
      WHERE p.applicant_id = $1 AND s.section_key = 'acknowledgement'`, [rbt.id]);
  check("the signature reaches the record", ackRow.rows.length === 1 && ackRow.rows[0].status === "signed", ackRow.rows[0]);
  check("...along with the initials that were stamped",
    JSON.parse(ackRow.rows[0].initials || "{}").drug_test === "ZR", ackRow.rows[0].initials);
  check("...and the signature is recorded at the size it was drawn at",
    Number(ackRow.rows[0].sig_w) === pad.canvasW, `${ackRow.rows[0].sig_w} vs ${pad.canvasW}`);

  // ======================================================================
  section("Reading the policy before signing it");
  check("the button says to read it first", /read to the end/i.test(await nextLabel()), await nextLabel());
  check("...and does not work yet", await nextDisabled());
  await scrollPolicyToEnd();
  check("reading to the end unlocks it", !(await nextDisabled()));
  check("...and the marker says so", /read to the end ✓/i.test(await page.textContent('[data-readmark="reporting"]')),
    await page.textContent('[data-readmark="reporting"]'));

  await page.fill('[name="reporting_full_name"]', "ZzUi Rbt");
  await drawSignature();
  await clickNext();
  await page.waitForTimeout(600);
  check("the mandatory reporting acknowledgment signs", (await stepName()) === "ce", await stepName());

  await scrollPolicyToEnd();
  await page.fill('[name="ce_full_name"]', "ZzUi Rbt");
  await drawSignature();
  await clickNext();
  await page.waitForTimeout(600);
  check("the RBT continuing education policy signs", (await stepName()) === "form8850", await stepName());

  // ======================================================================
  section("The two forms that get printed");
  check("it will not let you skip sending the form back",
    (await nextDisabled()) && /send it back first/i.test(await nextLabel()), await nextLabel());
  const pageText = await page.textContent(".step.active");
  check("it says out loud that completing the 8850 is voluntary", /voluntary/i.test(pageText));

  await page.setInputFiles('[data-file="form_8850"]', {
    name: "8850-signed.pdf", mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 signed 8850\n%%EOF"),
  });
  await page.waitForTimeout(900);
  check("sending it back is acknowledged on screen",
    /received/i.test(await page.textContent('[data-done="form_8850"]')), await page.textContent('[data-done="form_8850"]'));
  check("...and the button unlocks", !(await nextDisabled()), await nextLabel());

  await clickNext();
  check("the waiver is next", (await stepName()) === "waiver", await stepName());
  const waiverText = await page.textContent(".step.active");
  check("the waiver step says Nevada will not take a digital signature",
    /pen to paper/i.test(waiverText) && /black or blue/i.test(waiverText), waiverText.slice(0, 200));

  await page.setInputFiles('[data-file="background_waiver"]', {
    name: "waiver-signed.jpg", mimeType: "image/jpeg",
    buffer: Buffer.from("not really a jpeg, but it is a file"),
  });
  await page.waitForTimeout(900);
  check("the signed waiver is accepted", !(await nextDisabled()), await nextLabel());
  check("...and the last step offers to finish", /finish/i.test(await nextLabel()), await nextLabel());

  // ======================================================================
  section("Finishing");
  await clickNext();
  await page.waitForTimeout(1200);
  check("it lands on the thank-you screen", (await stepName()) === "done", await stepName());
  check("...and says the packet is complete",
    /that's the whole packet/i.test(await page.textContent(".step.active")), await page.textContent(".step.active"));
  const finalRow = await pool.query("SELECT status FROM hire_packets WHERE applicant_id = $1", [rbt.id]);
  check("the record says completed", finalRow.rows[0].status === "completed", finalRow.rows[0]);
  const filed = await pool.query(
    "SELECT COUNT(*)::int AS n FROM hr_applicant_documents WHERE applicant_id = $1 AND kind = 'application_packet'", [rbt.id]);
  check("the packet is filed against the applicant", filed.rows[0].n === 1, filed.rows[0]);

  // ======================================================================
  section("A BCBA is not shown the RBT policy");
  await open(bcba.token);
  const bcbaSteps = await page.evaluate(() =>
    [].slice.call(document.querySelectorAll(".step")).map((s) => s.getAttribute("data-name")));
  check("the RBT policy step is not on their packet at all", bcbaSteps.indexOf("ce") < 0, bcbaSteps);
  check("...and the rest of it still is",
    ["about", "acknowledgement", "reporting", "form8850", "waiver"].every((n) => bcbaSteps.indexOf(n) >= 0), bcbaSteps);
  const label = await page.evaluate(() => document.getElementById("progressLabel").textContent);
  check("the step count is the truth, not the RBT count", /begin/i.test(label), label);
  await clickNext();
  const counted = await page.evaluate(() => document.getElementById("progressLabel").textContent);
  check("...and it counts the steps this applicant actually has",
    counted === "Step 1 of " + (bcbaSteps.length - 2), counted + " vs " + (bcbaSteps.length - 2));

  check("nothing threw in the browser", errors.length === 0, errors.join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
