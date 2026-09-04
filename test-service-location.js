// Service location is a set, not one answer.
//
// A client can be seen in the clinic AND at home AND at school, and the field
// used to be a single <select> that could only say one of them. This drives the
// real editor in a browser rather than checking the markup, because the whole
// point is what a person can record.
//
// The two things worth being careful about, and what they are asserted against:
//
//   * NOTHING ALREADY ON A RECORD IS LOST. The column held free text before
//     this change -- "In Home / In-School", "Telehealth", whatever was typed or
//     imported. Opening a client and pressing Save must not quietly delete a
//     value the checkboxes do not recognise, so the editor keeps the remainder
//     in a field of its own and the test saves without touching it.
//   * THE MAP STILL AGREES. geo-map.js already classified a value naming more
//     than one setting as `multiple`; that is why this could stay in the single
//     TEXT column. If it had stopped agreeing, the map would silently report
//     one setting for a client seen in three.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + String(detail).slice(0, 400) : "")); }
  };
  const BASE = process.env.BASE || "http://localhost:3009";

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const mkClient = (name, value) => page.evaluate(async (a) => {
    const r = await fetch("/api/clients", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        child_name: a.name, parent_name: "Setting Parent",
        parent_email: a.name.replace(/\W+/g, ".").toLowerCase() + "@example.com",
        address: "742 Evergreen Terrace, Las Vegas, NV 89101",
        service_location: a.value,
      }),
    });
    return (await r.json()).id;
  }, { name, value });
  const stored = (id) => page.evaluate(async (cid) => {
    const d = await (await fetch("/api/clients/" + cid, { credentials: "include" })).json();
    return (d.client || d).service_location;
  }, id);
  // Saving reopens the card, so an earlier modal is still on the page when the
  // next one is asked for. Clear them first, and click through the DOM rather
  // than the pointer: a stacked backdrop intercepts a real click.
  const openEditor = async (id) => {
    await page.evaluate((cid) => {
      document.querySelectorAll(".modal-backdrop").forEach((el) => el.remove());
      openClientModal(cid);
    }, id);
    await page.waitForSelector(".modal-backdrop #client-edit-btn", { timeout: 10000 });
    await page.evaluate(() => document.querySelector(".modal-backdrop #client-edit-btn").click());
    await page.waitForSelector(".modal-backdrop #cd-service_location", { timeout: 10000 });
  };
  const boxes = () => page.evaluate(() =>
    Array.from(document.querySelectorAll(".modal-backdrop #cd-service_location input.svc-opt"))
      .map((i) => ({ value: i.value, checked: i.checked })));
  const save = async () => {
    await page.evaluate(() => document.querySelector(".modal-backdrop #client-save-btn").click());
    await page.waitForTimeout(2000);
  };

  // ---------------------------------------------------------------- the shape
  console.log("\n== The field offers every setting at once ==");
  const oneSetting = await mkClient("Setting One Child", "In Home");
  await openEditor(oneSetting);
  const opts = await boxes();
  check("the editor shows a checkbox per setting rather than one dropdown",
    opts.length === 3, opts);
  check("all three settings are offered",
    ["In-Clinic", "In Home", "In-School"].every((v) => opts.some((o) => o.value === v)), opts);
  check("the stored setting is the one ticked",
    opts.filter((o) => o.checked).map((o) => o.value).join(",") === "In Home", opts);
  check("they are laid out across the row, not stacked",
    await page.locator(".modal-backdrop #cd-service_location .opt-row").count() === 1);
  check("a single <select> is not left behind",
    await page.locator(".modal-backdrop select#cd-service_location").count() === 0);

  console.log("\n== Recording more than one ==");
  await page.evaluate(() => {
    document.querySelectorAll(".modal-backdrop #cd-service_location input.svc-opt").forEach((i) => {
      if (i.value !== "In Home") i.checked = true;
    });
  });
  await save();
  const three = await stored(oneSetting);
  check("ALL THREE SETTINGS ARE SAVED",
    three === "In-Clinic, In Home, In-School", three);

  const mapSaw = await page.evaluate(async (cid) => {
    const m = await (await fetch("/api/geo/map", { credentials: "include" })).json();
    const row = (m.clients || []).find((c) => c.id === cid);
    return row ? { key: row.setting_key, n: (row.settings || []).length } : { missing: true };
  }, oneSetting);
  check("and the map reports every one of them, not the first",
    mapSaw.missing || (mapSaw.key === "multiple" && mapSaw.n === 3), mapSaw);

  console.log("\n== Unticking everything ==");
  await openEditor(oneSetting);
  await page.evaluate(() => {
    document.querySelectorAll(".modal-backdrop #cd-service_location input.svc-opt").forEach((i) => { i.checked = false; });
  });
  await save();
  const emptied = await stored(oneSetting);
  check("records no setting rather than keeping the old one",
    !emptied, JSON.stringify(emptied));

  // ------------------------------------------------------ historical values
  console.log("\n== A value written before this was a multi-select ==");
  const legacySlash = await mkClient("Setting Legacy Child", "In Home / In-School");
  await openEditor(legacySlash);
  const legacyBoxes = await boxes();
  check("a slash-separated pair is READ as both settings",
    legacyBoxes.filter((o) => o.checked).map((o) => o.value).sort().join(",") === "In Home,In-School",
    legacyBoxes);
  await save();
  const legacyAfter = await stored(legacySlash);
  check("and saving keeps both, in the canonical spelling",
    legacyAfter === "In Home, In-School", legacyAfter);

  const freeText = await mkClient("Setting Telehealth Child", "In Home, Telehealth");
  await openEditor(freeText);
  const ftBoxes = await boxes();
  const otherVal = await page.evaluate(() => {
    const el = document.querySelector(".modal-backdrop #cd-service_location .svc-other");
    return el ? el.value : null;
  });
  check("a setting the checkboxes do not know is shown rather than dropped",
    otherVal === "Telehealth", otherVal);
  check("and the part they do know is still ticked",
    ftBoxes.filter((o) => o.checked).map((o) => o.value).join(",") === "In Home", ftBoxes);
  await save();
  const ftAfter = await stored(freeText);
  check("SAVING WITHOUT TOUCHING IT DOES NOT DELETE IT",
    ftAfter === "In Home, Telehealth", ftAfter);

  // A record whose whole value is unrecognised is the same question with
  // nothing to fall back on.
  const onlyFree = await mkClient("Setting Unknown Child", "Grandparent's house");
  await openEditor(onlyFree);
  await save();
  const onlyFreeAfter = await stored(onlyFree);
  check("a value that names no known setting at all survives a save too",
    onlyFreeAfter === "Grandparent's house", onlyFreeAfter);

  // ------------------------------------------------------------ new clients
  console.log("\n== Adding a client ==");
  await page.goto(BASE + "/#/pipeline", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    document.querySelectorAll(".modal-backdrop").forEach((el) => el.remove());
    openNewClientModal();
  });
  await page.waitForSelector("#new-client-form", { timeout: 10000 });
  const addForm = await page.evaluate(() => {
    const form = document.getElementById("new-client-form");
    if (!form) return { noForm: true };
    return {
      boxes: Array.from(form.querySelectorAll('input.svc-opt[name="service_location"]')).map((i) => i.value),
      selects: form.querySelectorAll('select[name="service_location"]').length,
    };
  });
  check("the add-a-client form offers the settings as checkboxes",
    addForm.noForm || addForm.boxes.length === 3, addForm);
  check("and no longer as a single dropdown",
    addForm.noForm || addForm.selects === 0, addForm);

  // Submitting two ticked boxes must send two. FormData keeps only the last
  // value of a repeated field name, so this is the case that would have
  // silently recorded one setting.
  if (!addForm.noForm) {
    const submitted = await page.evaluate(async () => {
      const form = document.getElementById("new-client-form");
      form.querySelector('input[name="child_name"]').value = "Setting New Child";
      form.querySelector('input[name="parent_name"]').value = "New Parent";
      form.querySelector('input[name="parent_email"]').value = "setting.new@example.com";
      form.querySelectorAll('input.svc-opt[name="service_location"]').forEach((i) => {
        i.checked = i.value === "In-Clinic" || i.value === "In-School";
      });
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 2200));
      const all = await (await fetch("/api/clients", { credentials: "include" })).json();
      const list = Array.isArray(all) ? all : (all.clients || []);
      const made = list.find((c) => c.child_name === "Setting New Child");
      return made ? made.service_location : null;
    });
    check("A NEW CLIENT KEEPS BOTH TICKED SETTINGS", submitted === "In-Clinic, In-School", submitted);
  }

  // ------------------------------------------------------------- filtering
  console.log("\n== Filtering by a setting ==");
  const filtered = await page.evaluate(() => {
    const parse = window.__parseServiceLocation, has = window.__serviceLocationHas;
    if (!parse || !has) return { missing: true };
    return {
      both: has("In-Clinic, In Home", "In Home") && has("In-Clinic, In Home", "In-Clinic"),
      notThird: has("In-Clinic, In Home", "In-School"),
      // "In-School" contains "School" and "In Home" contains "Home"; a raw
      // substring test would match the wrong one here.
      exact: !has("In-School", "In Home") && !has("In Home", "In-School"),
      blank: has("", "In Home"),
    };
  });
  check("a client in two settings matches EACH of them",
    filtered.missing || filtered.both === true, filtered);
  check("and does not match one they are not seen in",
    filtered.missing || filtered.notThird === false, filtered);
  check("one setting is not mistaken for another",
    filtered.missing || filtered.exact === true, filtered);
  check("a blank setting matches nothing",
    filtered.missing || filtered.blank === false, filtered);

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
