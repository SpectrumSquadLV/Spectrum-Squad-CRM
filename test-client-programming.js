// Client Programming -- supervision notes, in a real browser.
//
// What matters here is the shape the practice asked for and the data rules
// underneath it: the date and the RBT at the top of a note, then Programs on
// the left and Modifications on the right, paired row by row so a modification
// is never separated from the program it belongs to.
//
// Also asserted: behaviours are READ from the client's BIP rather than
// duplicated into a second table, because two copies of a behaviour plan is a
// clinical record that can disagree with itself.
const { chromium } = require("playwright");
const { Pool } = require("pg");

(async () => {
  const BASE = process.env.BASE || "http://localhost:3011";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  let pass = 0, fail = 0;
  const check = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + String(d).slice(0, 400) : "")); } };
  const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];

  // A client with a BIP and two behaviours, so the read-from-BIP rule has
  // something real to prove.
  const client = await one("INSERT INTO clients (child_name, stage) VALUES ('Programming Kid','active') RETURNING id");
  const bip = await one(
    "INSERT INTO client_bips (client_id, status, created_at, updated_at) VALUES ($1,'active',now(),now()) RETURNING id",
    [client.id]);
  await pool.query(
    `INSERT INTO bip_behaviors (bip_id, name, operational_definition, hypothesized_function, sort_order, created_at)
     VALUES ($1,'Elopement','Leaving the designated area without permission for more than 3 seconds.','Escape',0,now()),
            ($1,'Vocal protest','Audible refusal lasting more than 5 seconds.','Attention',1,now())`, [bip.id]);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  console.log("\n== the section is on the client card ==");
  await page.goto(BASE + `/#/pipeline/${client.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const mount = page.locator("#programming-mount");
  check("Client Programming appears on the client record", (await mount.count()) === 1);
  check("its renderer ran", (await mount.locator(".cp-wrap").count()) === 1,
    (await mount.innerHTML().catch(() => "")).slice(0, 200));

  console.log("\n== behaviours come from the BIP, not a second table ==");
  const behText = await mount.innerText();
  check("the client's behaviours are shown", /Elopement/.test(behText) && /Vocal protest/.test(behText), behText.slice(0, 300));
  check("and they are attributed to the BIP rather than presented as ours",
    /Behavior Intervention Plan/i.test(behText), behText.slice(0, 300));
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE '%behavio%'");
  check("no second behaviours table was created for programming",
    !tables.rows.some((r) => /programming|supervision/.test(r.table_name)),
    tables.rows.map((r) => r.table_name).join(","));

  console.log("\n== writing a supervision note ==");
  await mount.locator("[data-new]").click();
  await page.waitForTimeout(400);
  const ed = mount.locator("[data-editor]");
  check("the editor opens", (await ed.count()) === 1);
  check("the date defaults to today rather than blank",
    /^\d{4}-\d{2}-\d{2}$/.test(await ed.locator('[data-f="date"]').inputValue()));
  // Case-insensitive: the headings are uppercased in CSS, so innerText reports
  // "PROGRAMS". The order is what is being asserted, not the letter case.
  check("Programs is the LEFT column heading and Modifications the RIGHT",
    /^programs/i.test((await ed.locator(".cp-eh > span").nth(0).innerText()).trim())
    && /^modifications/i.test((await ed.locator(".cp-eh > span").nth(1).innerText()).trim()));

  // The RBT picker is populated from staff, not typed free-hand.
  const opts = await ed.locator('[data-f="rbt"] option').count();
  check("the RBT is chosen from staff rather than typed", opts > 1, opts);
  await ed.locator('[data-f="rbt"]').selectOption({ index: 1 });
  await ed.locator("[data-rows] .cp-erow").nth(0).locator("[data-p]").fill("Tacting common objects");
  await ed.locator("[data-rows] .cp-erow").nth(0).locator("[data-m]").fill("Moved from full to partial echoic prompt.");
  await ed.locator("[data-addrow]").click();
  await page.waitForTimeout(200);
  await ed.locator("[data-rows] .cp-erow").nth(1).locator("[data-p]").fill("Matching to sample");
  // Deliberately left with no modification -- a program run without a change is
  // a normal thing to record, and must not be dropped.
  await ed.locator('[data-f="general"]').fill("Client was well regulated throughout.");
  await ed.locator("[data-save]").click();
  await page.waitForTimeout(1800);

  console.log("\n== what got saved, and how it reads ==");
  const note = await one("SELECT * FROM client_supervision_notes WHERE client_id = $1", [client.id]);
  check("the note is stored", !!note, note);
  check("the RBT is recorded", !!note && !!note.rbt_name, note && note.rbt_name);
  const entries = (await pool.query("SELECT * FROM client_supervision_entries WHERE note_id=$1 ORDER BY sort_order", [note.id])).rows;
  check("both programs were saved, in order", entries.length === 2
    && entries[0].program === "Tacting common objects" && entries[1].program === "Matching to sample", entries);
  check("a program with no modification is kept, not dropped",
    entries[1].program === "Matching to sample" && !entries[1].modification, entries[1]);

  const card = mount.locator(".cp-note").first();
  check("the saved note renders", (await card.count()) === 1);
  const heads = await card.locator(".cp-col-h").allInnerTexts();
  check("the rendered note shows Programs then Modifications",
    /programs/i.test(heads[0] || "") && /modifications/i.test(heads[1] || ""), heads.join(" | "));
  const cardText = await card.innerText();
  check("the date is at the top of the note", /\b20\d\d\b/.test((await card.locator(".cp-date").innerText())));
  check("the RBT is at the top of the note", /RBT/.test(await card.locator(".cp-head").innerText()));
  check("a program with no modification reads as 'No change' rather than blank",
    /No change/.test(cardText), cardText.slice(0, 400));
  check("the session notes are shown", /well regulated/.test(cardText));

  console.log("\n== editing, and removing ==");
  await card.locator("[data-edit]").click();
  await page.waitForTimeout(500);
  const ed2 = mount.locator("[data-editor]");
  check("editing loads the existing rows", (await ed2.locator("[data-rows] .cp-erow").count()) === 2);
  await ed2.locator("[data-rows] .cp-erow").nth(1).locator("[data-m]").fill("Added a 2s delay.");
  await ed2.locator("[data-save]").click();
  await page.waitForTimeout(1500);
  const after = (await pool.query("SELECT * FROM client_supervision_entries WHERE note_id=$1 ORDER BY sort_order", [note.id])).rows;
  check("the edit saved against the right program", after.length === 2 && after[1].modification === "Added a 2s delay.", after);
  check("and did not duplicate the note",
    (await pool.query("SELECT 1 FROM client_supervision_notes WHERE client_id=$1", [client.id])).rows.length === 1);

  console.log("\n== responsive + clean ==");
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  check("no horizontal scroll at phone width", !overflow);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.waitForTimeout(400);
  await page.locator("#programming-mount").screenshot({ path: "/tmp/programming.png" }).catch(() => {});
  check("no page errors", errors.length === 0, errors.join(" | "));

  await browser.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
