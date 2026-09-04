// The imported Drive notes, on screen.
//
// The API suite proves the import rules. This proves the two things that only
// exist in a browser:
//
//   * THE PANEL SAYS IT IS A SNAPSHOT, with the date, where somebody reading it
//     will see it. The whole risk of a one-time copy is that it reads as
//     current -- a superseded protocol followed because the screen gave no
//     reason to doubt it. That warning is the feature, not decoration.
//   * A file with no text in it is still listed, with the reason. A token-board
//     photo that silently vanishes teaches people the panel is incomplete.
//
// Fixtures are invented; see drive-notes-test-fixtures.js.
const { chromium } = require("playwright");
const { Pool } = require("pg");
const { makeZip, docx, xlsx } = require("./drive-notes-test-fixtures");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
  };
  const BASE = process.env.BASE || "http://localhost:3009";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

  const login = async (email, password) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {}
      try { localStorage.clear(); } catch (e) {}
    });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(1600);
  };

  // A client in a stage Programming lists, with a folder's worth of files.
  const clientId = (await pool.query(
    "INSERT INTO clients (child_name, stage, submitted_at) VALUES ('Alejandro Quiroz','active',now()::text) RETURNING id"
  )).rows[0].id;

  const archive = makeZip({
    "Clients/AlQu/toilet toleration.docx": docx(["Sat for 4 minutes on 3 May.", "Tolerated the door closed."]),
    "Clients/AlQu/AlQu Supervision Notes.xlsx": xlsx({
      "Supervision Notes": [["Date", "Note"], ["2026-05-04", "Reviewed pairing procedure"]],
    }),
    "Clients/AlQu/token board.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    "Clients/ZzZz/orphan.docx": docx(["Belongs to nobody"]),
  });

  await login("admin@spectrumsquadlv.com", "TestOwner123!");

  console.log("\n== The import screen ==");
  await page.goto(BASE + "/#/admin", { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  check("Admin Settings offers the import",
    await page.locator('a[href="#/drive-notes-import"]').count() === 1);
  await page.goto(BASE + "/#/drive-notes-import", { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  const screen = await page.innerText("#view-mount");
  check("the screen loads rather than falling back to Admin Settings",
    await page.locator("#dn-file").count() === 1, screen.slice(0, 160));
  check("IT SAYS IT IS A SNAPSHOT, not a connection", /snapshot/i.test(screen), screen.slice(0, 400));
  check("and it says how to get the archive out of Drive",
    /download/i.test(screen) && /Clients/.test(screen), screen.slice(0, 400));
  check("nothing is waiting to be decided yet",
    /nothing is waiting/i.test(await page.innerText("#dn-review")), await page.innerText("#dn-review"));

  // Uploading through the browser's file picker needs a file on disk; the point
  // being tested here is the rendering of the result, so the archive is posted
  // from the page itself and the screens are then driven normally.
  const post = async (path, buf) => page.evaluate(async ([p, bytes]) => {
    const r = await fetch(p, {
      method: "POST", headers: { "Content-Type": "application/zip" },
      body: new Uint8Array(bytes), credentials: "include",
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, [path, Array.from(buf)]);

  const preview = await post("/api/drive-notes/import/preview", archive);
  check("the archive previews", preview.status === 200, preview.data && preview.data.error);
  const applied = await post("/api/drive-notes/import/apply", archive);
  check("and imports", applied.status === 200 && applied.data.inserted === 4, applied.data);

  console.log("\n== The review list ==");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  const review = await page.innerText("#dn-review");
  check("THE UNMATCHED FOLDER IS SHOWN, not swallowed", /ZzZz/.test(review), review.slice(0, 300));
  check("with the reason it could not be filed", /no client/i.test(review), review.slice(0, 300));
  check("and a way to say whose it is",
    await page.locator('[data-dn-assign="ZzZz"]').count() === 1);
  await page.click('[data-dn-assign="ZzZz"]');
  await page.waitForTimeout(500);
  check("filing it with nobody chosen is refused rather than doing something arbitrary",
    /choose a client/i.test(await page.innerText('[data-dn-err="ZzZz"]')),
    await page.innerText('[data-dn-err="ZzZz"]'));

  console.log("\n== The panel in Programming ==");
  await page.goto(BASE + "/#/client-behavior/" + clientId, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const panel = await page.innerText("#cb-drive");
  check("the panel renders on the client's Programming page",
    await page.locator("#cb-drive .card").count() === 3, panel.slice(0, 200));
  check("IT IS LABELLED A SNAPSHOT where somebody reading it will see it",
    /snapshot/i.test(panel), panel.slice(0, 300));
  check("AND CARRIES THE DATE IT WAS TAKEN", /\b20\d\d\b/.test(panel), panel.slice(0, 300));
  check("and says plainly that Drive is still where these are edited",
    /edited/i.test(panel) && /Drive/.test(panel), panel.slice(0, 400));

  check("the loose note is there", /toilet toleration/.test(panel), panel.slice(0, 400));
  check("the supervision sheet is there", /Supervision Notes/.test(panel), panel.slice(0, 400));
  check("THE IMAGE IS LISTED TOO, so nobody assumes it is missing",
    /token board\.png/.test(panel), panel.slice(0, 400));
  check("with the reason there is nothing to read in it",
    /no text can be extracted/i.test(panel), panel.slice(0, 500));

  console.log("\n== Reading one ==");
  const body = page.locator("#cb-drive pre").first();
  check("the text starts hidden, so the page is a list rather than a wall",
    await body.isHidden(), "visible");
  await page.locator("#cb-drive [data-drive-toggle]").first().click();
  await page.waitForTimeout(300);
  check("clicking Show reveals THE ACTUAL TEXT of the document",
    /Sat for 4 minutes/.test(await page.locator("#cb-drive pre").first().innerText()),
    await page.locator("#cb-drive pre").first().innerText());
  await page.locator("#cb-drive [data-drive-toggle]").first().click();
  await page.waitForTimeout(300);
  check("and clicking again hides it", await page.locator("#cb-drive pre").first().isHidden());

  console.log("\n== A client with nothing imported ==");
  const bare = (await pool.query(
    "INSERT INTO clients (child_name, stage, submitted_at) VALUES ('Nobody Imported','active',now()::text) RETURNING id"
  )).rows[0].id;
  await page.goto(BASE + "/#/client-behavior/" + bare, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  const empty = await page.innerText("#cb-drive");
  check("says nothing has been imported rather than showing an error",
    /nothing has been imported/i.test(empty), empty.slice(0, 200));
  check("AND THE PLAN ABOVE IT STILL RENDERED -- this panel cannot break the page",
    (await page.innerText("#cb-plan")).length > 0);

  console.log("\n== A clinical user ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await page.goto(BASE + "/#/client-behavior/" + clientId, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const clinical = await page.innerText("#cb-drive");
  check("a BCBA can read the imported notes", /toilet toleration/.test(clinical), clinical.slice(0, 200));
  check("but gets no import screen in the sidebar",
    await page.locator('[data-nav="admin"]').count() === 0);
  const forbidden = await page.evaluate(async () =>
    (await fetch("/api/drive-notes/review", { credentials: "include" })).status);
  check("AND THE REVIEW ENDPOINT REFUSES THEM AT THE API, not just in the menu",
    forbidden === 403, forbidden);

  console.log("\n== Presentation ==");
  const html = await page.innerHTML("#cb-drive");
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  check("no emoji in the panel", emoji.length === 0, emoji);

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
