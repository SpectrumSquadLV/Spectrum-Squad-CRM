// Step four on screen: training material, the hours log, the survey, the
// reports, and the curriculum editor.
//
// The claims worth having in a browser are the ones where a silent
// regression MISLEADS somebody rather than merely annoying them:
//
//   * the hours card says, in words, that these are not billable. Somebody
//     logging eight hours of shadowing needs to know they have not just
//     claimed eight hours of pay.
//   * the survey says the link to their name is ABSENT, and warns that free
//     text can still identify them. An over-promise here is the difference
//     between honest answers and a careful fiction.
//   * the curriculum editor says, BEFORE an edit, that it will fork and
//     leave the people currently onboarding where they are.
//   * sealed feedback looks sealed, and shows no answers.
//   * an ordinary BCBA is offered none of the leadership screens.
//
//   BASE=http://127.0.0.1:3013 DATABASE_URL=... node test-academy-library-ui.js
"use strict";
const { chromium } = require("playwright");
const { Pool } = require("pg");
const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const stamp = Date.now().toString(36);
const today = () => new Date().toISOString().slice(0, 10);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");
  const BASE = process.env.BASE || "http://localhost:3013";
  const hp = (pw) => {
    const salt = crypto.randomBytes(16).toString("hex");
    return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
  };
  const login = async (email, password) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {}
    });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(1600);
  };
  const openAcademy = async () => {
    await page.goto(BASE + "/#/bcba-hub");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".bh-tabs", { timeout: 15000 });
    await page.click('.bh-tab[data-tab="academy"]');
    await page.waitForSelector(".ac-wrap", { timeout: 15000 });
    await page.waitForTimeout(800);
  };

  const purge = async () => {
    const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'AcadL4 %')";
    const enr = `(SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`;
    await pool.query(`DELETE FROM academy_hours WHERE enrollment_id IN ${enr}`).catch(() => {});
    await pool.query(`DELETE FROM academy_survey_done WHERE enrollment_id IN ${enr}`).catch(() => {});
    for (const t of ["academy_dev_plans", "academy_progress", "academy_audit", "academy_checkins",
                     "academy_questions", "academy_gaps"]) {
      await pool.query(`DELETE FROM ${t} WHERE enrollment_id IN ${enr}`).catch(() => {});
    }
    await pool.query(`DELETE FROM academy_enrollments WHERE employee_id IN ${ids}`).catch(() => {});
    await pool.query("UPDATE academy_enrollments SET mentor_id = NULL WHERE mentor_id IN " + ids).catch(() => {});
    await pool.query("DELETE FROM hr_employees WHERE name LIKE 'AcadL4 %'").catch(() => {});
    await pool.query("DELETE FROM users WHERE email LIKE 'acadl4-%'").catch(() => {});
    const progs = "(SELECT id FROM academy_programs WHERE key LIKE 'acadl4-%')";
    await pool.query(`DELETE FROM academy_survey_responses WHERE program_id IN ${progs}`).catch(() => {});
    await pool.query(`DELETE FROM academy_resources WHERE module_id IN (SELECT id FROM academy_modules WHERE program_id IN ${progs})`).catch(() => {});
    await pool.query(`DELETE FROM academy_resources WHERE item_id IN (SELECT i.id FROM academy_items i JOIN academy_modules m ON m.id = i.module_id WHERE m.program_id IN ${progs})`).catch(() => {});
    await pool.query(`DELETE FROM academy_items WHERE module_id IN (SELECT id FROM academy_modules WHERE program_id IN ${progs})`).catch(() => {});
    await pool.query(`DELETE FROM academy_modules WHERE program_id IN ${progs}`).catch(() => {});
    await pool.query(`DELETE FROM academy_enrollments WHERE program_id IN ${progs}`).catch(() => {});
    await pool.query(`DELETE FROM academy_programs WHERE key LIKE 'acadl4-%'`).catch(() => {});
    await pool.query("DELETE FROM crm_policies WHERE title LIKE 'AcadL4 %'").catch(() => {});
  };

  try {
    await purge();

    // ---- fixtures through the real API ---------------------------------
    let cookie = "";
    const asOwner = async (path, opts = {}) => {
      const r = await fetch(BASE + path, {
        method: opts.method || "GET",
        headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
      let d = null; try { d = await r.json(); } catch (e) {}
      return { status: r.status, data: d };
    };
    await asOwner("/api/auth/login", { method: "POST", body: {
      email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });

    const prog = (await asOwner("/api/academy/programs", { method: "POST", body: {
      name: `AcadL4 Programme ${stamp}`, key: `acadl4-${stamp}`, weeks: 1, duration_days: 7 } })).data.program;
    const mod = (await asOwner(`/api/academy/programs/${prog.id}/modules`, { method: "POST", body: {
      week: 1, title: "Week 1 — Systems" } })).data.module;
    const item = (await asOwner(`/api/academy/modules/${mod.id}/items`, { method: "POST", body: {
      title: "Learn the authorization screen", kind: "reading" } })).data.item;
    const pol = (await pool.query(
      `INSERT INTO crm_policies (title, category, body, slug, published, created_at)
       VALUES ('AcadL4 Attendance Policy','HR','Be on time.',$1,TRUE, now()::text) RETURNING id`,
      [`acadl4-att-${stamp}`])).rows[0];
    await asOwner("/api/academy/resources", { method: "POST", body: {
      item_id: item.id, kind: "document", policy_id: pol.id } });
    await asOwner("/api/academy/resources", { method: "POST", body: {
      module_id: mod.id, kind: "video", title: "Our systems in ten minutes",
      url: "https://www.loom.com/share/acadl4" } });

    const email = `acadl4-new-${stamp}@example.invalid`;
    const p1 = hp("AcadL4Pass123!");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ('AcadL4 Newbie',$1,$2,$3,'clinical', now())`, [email, p1.hash, p1.salt]);
    const empId = (await pool.query(
      `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
       VALUES ('AcadL4 Newbie',$1,'BCBA',$2,'active') RETURNING id`, [email, today()])).rows[0].id;
    const enr = (await asOwner("/api/academy/enrollments", { method: "POST", body: {
      employee_id: empId, program_key: prog.key } })).data.enrollment;
    check("the fixture is built through the real API", !!enr && !!enr.id, enr);

    // =====================================================================
    section("THE NEW BCBA SEES WHAT TO READ AND WATCH");
    await login(email, "AcadL4Pass123!");
    await openAcademy();
    const txt = await page.textContent(".ac-wrap");
    check("the week's video is on the page", /Our systems in ten minutes/.test(txt), txt.slice(0, 400));
    check("and the SOP attached to the item", /AcadL4 Attendance Policy/.test(txt), txt.slice(0, 600));
    const links = await page.evaluate(() => [...document.querySelectorAll(".ac-res a")].map((a) => ({
      href: a.getAttribute("href"), rel: a.getAttribute("rel"), target: a.getAttribute("target"),
    })));
    check("the SOP links into the policy library, not a copy",
      links.some((l) => /^\/policies#/.test(l.href || "")), links);
    check("the video keeps its external link", links.some((l) => /loom\.com/.test(l.href || "")), links);
    check("EVERY EXTERNAL LINK CARRIES rel=noopener — these are addresses"
      + " somebody else pasted",
      links.filter((l) => /^https?:/.test(l.href || "")).every((l) => /noopener/.test(l.rel || "")), links);

    section("THE HOURS CARD SAYS WHERE THE HOURS DO NOT GO");
    check("there is a training hours card", /Your training hours/.test(txt), txt.slice(0, 900));
    check("IT SAYS IN WORDS THEY ARE NOT BILLABLE AND DO NOT REACH PAYROLL",
      /not billable hours and they do not go to payroll/i.test(txt), txt.slice(0, 1400));
    await page.fill("#ac-h-hours", "2.5");
    await page.fill("#ac-h-act", "Shadowed two sessions");
    await page.click("#ac-h-add");
    await page.waitForTimeout(1200);
    const afterH = await page.textContent(".ac-wrap");
    check("logging hours works", /Shadowed two sessions/.test(afterH), afterH.slice(0, 900));
    check("and the total moves", /2\.5/.test(afterH), afterH.slice(0, 900));
    const stored = (await pool.query(
      "SELECT * FROM academy_hours WHERE enrollment_id = $1", [enr.id])).rows;
    check("the entry is in academy_hours and nowhere else", stored.length === 1, stored);

    // The form clears itself after a successful log, which is right -- so a
    // second entry is filled in again, the way a person would.
    check("the form cleared itself after logging",
      !(await page.inputValue("#ac-h-act")), await page.inputValue("#ac-h-act"));
    await page.fill("#ac-h-hours", "1");
    await page.fill("#ac-h-act", "Read the authorization SOP");
    await page.click("#ac-h-add");
    await page.waitForTimeout(1200);
    check("a second entry on the same day is accepted — two sessions in one day is real",
      (await pool.query("SELECT COUNT(*)::int AS n FROM academy_hours WHERE enrollment_id = $1",
        [enr.id])).rows[0].n === 2);
    await page.click("[data-h-del]");
    await page.waitForTimeout(1000);
    check("and they can remove their own mistake",
      (await pool.query("SELECT COUNT(*)::int AS n FROM academy_hours WHERE enrollment_id = $1",
        [enr.id])).rows[0].n === 1);

    section("THE SURVEY PROMISES ONLY WHAT IT DELIVERS");
    const sv = await page.textContent(".ac-wrap");
    check("the survey is on their screen", /Tell us how the onboarding went/.test(sv), sv.slice(-900));
    check("IT SAYS THE LINK IS ABSENT, NOT HIDDEN", /not hidden, absent/i.test(sv), sv.slice(-900));
    check("AND WARNS FREE TEXT CAN STILL IDENTIFY THEM",
      /own words could still identify you/i.test(sv), sv.slice(-900));
    check("there are three rating scales",
      await page.locator(".ac-scale").count() === 3, await page.locator(".ac-scale").count());
    const early = await page.click("#ac-sv-send").then(() => page.waitForTimeout(900)).then(
      () => page.textContent("#ac-sv-msg"));
    check("sending it unanswered is refused, on the page", /1 to 5/i.test(early), early);
    for (const k of ["prepared", "mentor_time", "set_up_to_do_job"]) {
      await page.click(`[data-sv="${k}"][data-svv="4"]`);
      await page.waitForTimeout(250);
    }
    await page.fill('[data-svt="missing"]', "Nobody showed me the authorization screen.");
    await page.click("#ac-sv-send");
    await page.waitForTimeout(1400);
    const done = await page.textContent(".ac-wrap");
    check("a complete one is accepted", /your feedback is in/i.test(done), done.slice(-500));
    const anon = (await pool.query(
      "SELECT * FROM academy_survey_responses WHERE program_id = $1", [prog.id])).rows;
    check("the response is stored", anon.length === 1, anon);
    check("WITH NO COLUMN ANYWHERE ON IT THAT NAMES THEM",
      anon[0] && !Object.keys(anon[0]).some((k) => /employee|enrol|name|email|user/i.test(k)),
      Object.keys(anon[0] || {}));

    section("AN ORDINARY BCBA IS OFFERED NONE OF THE LEADERSHIP SCREENS");
    check("no reports tab", await page.locator('[data-view="reports"]').count() === 0);
    check("no curriculum tab", await page.locator('[data-view="curriculum"]').count() === 0);
    check("in fact no tab bar at all, because they have nobody else to look at",
      await page.locator(".ac-tab").count() === 0, await page.locator(".ac-tab").count());

    section("A MENTOR GETS A TAB BAR AND STILL NOT THE LEADERSHIP SCREENS");
    // This is the case the permission check in the tab bar exists for. An
    // ordinary BCBA proves nothing about it: they are given no tab bar, so
    // the check never runs for them.
    const mEmail = `acadl4-mentor-${stamp}@example.invalid`;
    const mp = hp("AcadL4Pass123!");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ('AcadL4 Mentor',$1,$2,$3,'clinical', now())`, [mEmail, mp.hash, mp.salt]);
    const mentorId = (await pool.query(
      `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
       VALUES ('AcadL4 Mentor',$1,'BCBA',$2,'active') RETURNING id`, [mEmail, today()])).rows[0].id;
    const pa = await asOwner(`/api/academy/enrollments/${enr.id}`, { method: "PATCH", body: { mentor_id: mentorId } });
    check("a mentor is assigned", pa.status === 200, pa.data);
    await login(mEmail, "AcadL4Pass123!");
    await openAcademy();
    check("the mentor DOES get a tab bar", await page.locator(".ac-tab").count() >= 2,
      await page.locator(".ac-tab").count());
    check("including their mentees", /My mentees/.test(await page.textContent(".ac-wrap")),
      (await page.textContent(".ac-wrap")).slice(0, 200));
    check("BUT NO REPORTS TAB — a mentor manages a person, not the programme",
      await page.locator('[data-view="reports"]').count() === 0,
      await page.locator('[data-view="reports"]').count());
    check("AND NO CURRICULUM TAB", await page.locator('[data-view="curriculum"]').count() === 0,
      await page.locator('[data-view="curriculum"]').count());
    // And the server agrees, which is the half that actually matters.
    const mRep = await page.evaluate(async () => {
      const r = await fetch("/api/academy/reports", { credentials: "include" });
      return r.status;
    });
    check("and the server refuses them the reports anyway", mRep === 403, mRep);

    // =====================================================================
    section("NAMING A CLINICAL DIRECTOR, FROM THE SCREEN");
    // The endpoint for this shipped in step one and nothing ever called it,
    // so the only way to name anybody was an API request -- and a permission
    // nobody can grant is a feature nobody has. These checks are that the
    // control exists, that it works, and that it is not offered to staff.
    await login("admin@spectrumsquadlv.com", "TestOwner123!");
    await openAcademy();
    await page.click('[data-view="roster"]');
    await page.waitForTimeout(1400);
    const ld = await page.textContent(".ac-wrap");
    check("the owner is shown a clinical leadership card",
      /Clinical leadership/.test(ld), ld.slice(0, 400));
    check("it says plainly what happens while nobody is named",
      /No onboarding can be approved until somebody is/i.test(ld)
        || /has nobody to accept it/i.test(ld), ld.slice(0, 900));
    check("THERE IS A PICKER TO NAME SOMEBODY",
      await page.locator("#ac-ld-who").count() === 1, await page.locator("#ac-ld-who").count());
    const candCount = await page.locator("#ac-ld-who option").count();
    check("and it is populated with staff, not empty", candCount > 1, candCount);
    check("it warns that a second Director replaces the first",
      /Naming a second replaces/i.test(ld), ld.slice(0, 1800));

    const mentorLabel = await page.evaluate(() => {
      const o = [...document.querySelectorAll("#ac-ld-who option")].find((x) => /AcadL4 Mentor/.test(x.textContent));
      return o ? o.value : "";
    });
    check("the mentor is selectable", !!mentorLabel, mentorLabel);
    await page.selectOption("#ac-ld-who", mentorLabel);
    await page.selectOption("#ac-ld-role", "clinical_director");
    await page.click("#ac-ld-save");
    await page.waitForTimeout(1800);
    const named = await page.textContent(".ac-wrap");
    check("NAMING SOMEBODY WORKS, from the screen", /AcadL4 Mentor/.test(named), named.slice(0, 900));
    const row = (await pool.query(
      "SELECT academy_leadership FROM hr_employees WHERE id = $1", [mentorId])).rows[0];
    check("and it is recorded against them",
      row && row.academy_leadership === "clinical_director", row);

    section("A CLINICAL LEAD SEES WHO IS NAMED BUT CANNOT NAME ANYBODY");
    // The deciding case for the picker's own gate. The owner sees it and a
    // plain BCBA sees no card at all, so neither exercises it -- somebody
    // who IS leadership but is NOT the owner is the person it exists for.
    await pool.query("UPDATE hr_employees SET academy_leadership = 'assistant_clinical_director' WHERE id = $1",
      [mentorId]);
    await login(mEmail, "AcadL4Pass123!");
    await openAcademy();
    await page.click('[data-view="roster"]');
    await page.waitForTimeout(1400);
    const leadView = await page.textContent(".ac-wrap");
    check("they DO see the clinical leadership card", /Clinical leadership/.test(leadView),
      leadView.slice(0, 400));
    check("THEY DO NOT GET THE PICKER — naming leadership is the owner's",
      await page.locator("#ac-ld-who").count() === 0, await page.locator("#ac-ld-who").count());
    check("nor a remove control", await page.locator("[data-lead-clear]").count() === 0,
      await page.locator("[data-lead-clear]").count());
    const leadDenied = await page.evaluate(async () => {
      const r = await fetch("/api/academy/leadership/candidates", { credentials: "include" });
      return r.status;
    });
    check("and the candidate list is refused them too", leadDenied === 403, leadDenied);

    // THE DECIDING CASE FOR THE CURRICULUM, for the same reason as the picker
    // above: the owner sees the switch and a plain BCBA sees no tab, so
    // neither proves the line. Somebody who IS leadership but is NOT the
    // owner is the person this rule exists for -- she supervises people
    // through the programme and has to see what it asks of them, and she does
    // not rewrite it.
    await page.click('[data-view="curriculum"]');
    await page.waitForTimeout(1800);
    const leadCu = await page.textContent(".ac-wrap");
    check("a clinical lead CAN open the curriculum", /Programmes/.test(leadCu), leadCu.slice(0, 300));
    check("...and is told why she is looking at it",
      /see what the people you supervise are being asked to do/i.test(leadCu), leadCu.slice(0, 500));
    check("...and told whose it is to change", /Only the practice owner changes it/i.test(leadCu), leadCu.slice(0, 500));
    check("SHE IS NOT OFFERED THE SWITCH AT ALL", await page.locator("#ac-cu-edit").count() === 0,
      await page.locator("#ac-cu-edit").count());
    check("...nor anything that removes a week", await page.locator("[data-cu-mdel]").count() === 0);
    check("...nor anything that attaches a document", await page.locator("[data-cu-res]").count() === 0);
    check("...nor anything that reorders the curriculum",
      await page.locator("[data-cu-wmove]").count() === 0 && await page.locator("[data-cu-mmove]").count() === 0,
      [await page.locator("[data-cu-wmove]").count(), await page.locator("[data-cu-mmove]").count()]);
    check("...nor a New programme button", await page.locator("#ac-cu-new").count() === 0);
    check("but she can open a programme and read it", await page.locator("[data-cu-pick]").count() >= 2);
    // And the server refuses her regardless of what the screen drew.
    const cuDenied = await page.evaluate(async () => {
      const r = await fetch("/api/academy/programs", { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Hers" }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    });
    check("...and the API refuses her a new programme", cuDenied.status === 403, cuDenied);
    check("...saying whose it is", /practice owner/i.test((cuDenied.body && cuDenied.body.error) || ""), cuDenied.body);

    await pool.query("UPDATE hr_employees SET academy_leadership = NULL WHERE id = $1", [mentorId]);

    section("AND IT IS NOT OFFERED TO STAFF");
    await login(email, "AcadL4Pass123!");
    await openAcademy();
    check("an ordinary BCBA sees no leadership card",
      !/Clinical leadership/.test(await page.textContent(".ac-wrap")));
    const denied = await page.evaluate(async (id) => {
      const r = await fetch("/api/academy/leadership/" + id, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadership: "clinical_director" }) });
      return r.status;
    }, empId);
    check("AND THE SERVER REFUSES THEM NAMING THEMSELVES", denied === 403, denied);
    const stillPlain = (await pool.query(
      "SELECT academy_leadership FROM hr_employees WHERE id = $1", [empId])).rows[0];
    check("so they did not become the Clinical Director",
      stillPlain && !stillPlain.academy_leadership, stillPlain);
    await pool.query("UPDATE hr_employees SET academy_leadership = NULL WHERE id = $1", [mentorId]).catch(() => {});

    section("LEADERSHIP: THE REPORTS");
    await login("admin@spectrumsquadlv.com", "TestOwner123!");
    await openAcademy();
    check("the owner gets a reports tab", await page.locator('[data-view="reports"]').count() === 1);
    await page.click('[data-view="reports"]');
    await page.waitForTimeout(1600);
    const rep = await page.textContent(".ac-wrap");
    check("the reports load", /enrolled/.test(rep), rep.slice(0, 500));
    check("median days to complete is labelled as a median, and explains why",
      /median days to complete/i.test(rep) && /one slow onboarding/i.test(rep), rep.slice(0, 2000));
    check("TRAINING HOURS ARE LABELLED NOT BILLABLE HERE TOO",
      /not billable/i.test(rep), rep.slice(0, 2000));
    check("there is a CSV export", await page.locator('a[href*="reports.csv"]').count() >= 1);

    section("THE SEALED FEEDBACK LOOKS SEALED");
    check("with one response it says sealed", /sealed/i.test(rep), rep.slice(-1200));
    check("AND SHOWS NO ANSWERS AT ALL",
      !/authorization screen/i.test(rep), rep.slice(-1200));
    check("while saying what would open it", /3 people have answered/i.test(rep), rep.slice(-1200));

    // =====================================================================
    section("THE CURRICULUM READS, UNTIL EDITING IS SWITCHED ON");
    await page.click('[data-view="curriculum"]');
    await page.waitForTimeout(1800);
    const ro = await page.textContent(".ac-wrap");
    check("the programme list loads", /Programmes/.test(ro), ro.slice(0, 400));
    check("it opens READ-ONLY, even for the owner", /Switch editing on to change it/i.test(ro), ro.slice(0, 400));
    check("...with nothing on screen that removes a week",
      await page.locator("[data-cu-mdel]").count() === 0, await page.locator("[data-cu-mdel]").count());
    check("...nothing that adds one", await page.locator("#ac-cu-wadd").count() === 0);
    check("...nothing that attaches a document",
      await page.locator("[data-cu-res]").count() === 0, await page.locator("[data-cu-res]").count());
    check("...nothing that moves a week or a module",
      await page.locator("[data-cu-wmove]").count() === 0 && await page.locator("[data-cu-mmove]").count() === 0,
      [await page.locator("[data-cu-wmove]").count(), await page.locator("[data-cu-mmove]").count()]);
    check("...and nothing can be dragged",
      await page.locator('[data-cu-mod][draggable="true"]').count() === 0,
      await page.locator('[data-cu-mod][draggable="true"]').count());
    check("...and no New programme button", await page.locator("#ac-cu-new").count() === 0);
    check("but the programmes can still be opened and read",
      await page.locator("[data-cu-pick]").count() >= 2, await page.locator("[data-cu-pick]").count());
    check("the owner is offered the switch", await page.locator("#ac-cu-edit").count() === 1);

    section("LEADERSHIP: THE CURRICULUM EDITOR");
    await page.click("#ac-cu-edit");
    await page.waitForTimeout(900);
    const cu = await page.textContent(".ac-wrap");
    check("switching it on says so", /Editing is on/i.test(cu), cu.slice(0, 300));
    check("and says a programme is rows rather than code, for RBT and Squad Leader",
      /RBT onboarding and Squad\s*Leader development/i.test(cu), cu.slice(0, 700));
    const rows = await page.locator("[data-cu-pick]").count();
    check("every programme can be opened", rows >= 2, rows);

    // Open OUR programme, which has somebody enrolled.
    const mine = await page.evaluate((key) => {
      const tr = [...document.querySelectorAll("tr")].find((r) => r.textContent.includes(key));
      const b = tr && tr.querySelector("[data-cu-pick]");
      return b ? b.getAttribute("data-cu-pick") : null;
    }, `AcadL4 Programme ${stamp}`);
    check("ours is in the list", !!mine, mine);
    await page.click(`[data-cu-pick="${mine}"]`);
    await page.waitForTimeout(1600);
    const open = await page.textContent(".ac-wrap");
    check("its weeks and items show", /Learn the authorization screen/.test(open), open.slice(0, 1200));
    check("THE EDITOR WARNS, BEFORE ANY EDIT, THAT IT WILL FORK",
      /Editing anything here creates version 2/i.test(open), open.slice(0, 1500));
    check("and says the enrolled person stays where they are",
      /leaves all of them on version 1/i.test(open)
        && /nobody's finished week changes under them/i.test(open), open.slice(0, 1600));
    check("the attached material is shown in the editor too",
      /Attendance Policy/.test(open), open.slice(0, 1400));

    // ---- EACH ITEM IS A MODULE, AND THEY MOVE --------------------------
    section("THE WEEKS HOLD MODULES, AND BOTH CAN BE MOVED");
    check("what sits in a week is called a module now",
      /Add a module/.test(open) && !/Add an item/.test(open), open.slice(0, 1600));
    // This programme ships with one module, and one module cannot demonstrate
    // an order. Adding the second through the screen also exercises the
    // renamed form.
    await page.locator("[data-cu-iadd]").first().click();
    await page.waitForTimeout(400);
    const addForm = await page.textContent(".ac-wrap");
    check("the add form calls it a module", /A new module/.test(addForm), addForm.slice(-700));
    await page.fill("#ac-ni-title", "Second module for ordering");
    await page.click("[data-ni-save]");
    await page.waitForTimeout(2200);

    check("every module can be picked up",
      await page.locator('[data-cu-mod][draggable="true"]').count() >= 2,
      await page.locator("[data-cu-mod]").count());
    check("...and has arrows, so it can be moved without dragging",
      await page.locator("[data-cu-mmove]").count() >= 2, await page.locator("[data-cu-mmove]").count());
    check("each week can be moved too",
      await page.locator("[data-cu-wmove]").count() >= 1, await page.locator("[data-cu-wmove]").count());
    check("THE NUMBERING RUNS STRAIGHT THROUGH THE PROGRAMME, 1..N across the weeks"
      + " rather than restarting in each one",
      await page.evaluate(() => {
        const ns = [...document.querySelectorAll("[data-cu-mod] strong")].map((e) => e.textContent.trim());
        return ns.length >= 2 && ns.every((v, i) => v === (i + 1) + ".");
      }), await page.evaluate(() => [...document.querySelectorAll("[data-cu-mod] strong")].map((e) => e.textContent.trim())));
    check("the first module's up arrow is disabled, because there is nothing above it",
      await page.locator("[data-cu-mmove][data-cu-dir='-1']").first().isDisabled());
    // ---- A TRAINING VIDEO PLAYS IN THE PAGE ---------------------------
    // It used to be a link that opened a new tab, which meant the employee
    // left their checklist to watch the training.
    const vidItem = await page.locator("[data-cu-res][data-cu-res-kind='item']").first();
    await vidItem.click();
    await page.waitForTimeout(500);
    await page.selectOption("#ac-nr-kind", "video");
    await page.fill("#ac-nr-title", "How we run a session");
    await page.fill("#ac-nr-url", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    check("the form says which hosts play in the page",
      /YouTube, Vimeo, Loom or Google Drive/.test(await page.textContent("#ac-cu-form2")),
      await page.textContent("#ac-cu-form2"));
    await page.click("[data-nr-save]");
    await page.waitForTimeout(2000);
    const frame = page.locator(".ac-vidbox iframe").first();
    check("THE VIDEO IS EMBEDDED, not left as a link", await page.locator(".ac-vidbox iframe").count() >= 1,
      await page.locator(".ac-vidbox iframe").count());
    const vsrc = await frame.getAttribute("src");
    check("...pointing at a player rather than the page that was pasted",
      vsrc === "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", vsrc);
    check("...sandboxed", (await frame.getAttribute("sandbox") || "").includes("allow-scripts"), await frame.getAttribute("sandbox"));
    check("...and loaded lazily, so a week of videos does not fetch them all at once",
      (await frame.getAttribute("loading")) === "lazy");
    check("...with the provider named and a way out to a new tab",
      /YouTube/.test(await page.textContent(".ac-vid")) && /open it in a new tab/.test(await page.textContent(".ac-vid")),
      await page.textContent(".ac-vid"));
    const box = await page.locator(".ac-vidbox").first().boundingBox();
    check("...in a 16:9 box rather than a collapsed strip",
      box && box.height > 100 && Math.abs(box.width / box.height - 16 / 9) < 0.2, box);

    // A host nobody allowlisted stays a link, which is the safe answer.
    await vidItem.click();
    await page.waitForTimeout(500);
    await page.selectOption("#ac-nr-kind", "video");
    await page.fill("#ac-nr-title", "A file on our own server");
    await page.fill("#ac-nr-url", "https://example.invalid/training.mp4");
    await page.click("[data-nr-save]");
    await page.waitForTimeout(2000);
    check("a video on a host we do not embed is kept as a link, not a broken player",
      await page.locator(".ac-vidbox iframe").count() === 1
      && /A file on our own server/.test(await page.textContent(".ac-wrap")),
      await page.locator(".ac-vidbox iframe").count());
    const anyBad = await page.locator('iframe[src*="example.invalid"]').count();
    check("...and nothing from that host is framed in the page", anyBad === 0, anyBad);

    check("with a control to attach more",
      await page.locator("[data-cu-res]").count() >= 1, await page.locator("[data-cu-res]").count());

    section("ATTACHING AN SOP OFFERS THE POLICY LIBRARY, NOT A TEXT BOX");
    await page.click("[data-cu-res]");
    await page.waitForTimeout(900);

    // THE FORM HAS TO BE WHERE SHE IS LOOKING. All three of these forms open
    // in one box at the bottom of the entire curriculum, so on a real
    // twelve-week programme the form lands far below the fold: nothing visibly
    // happens and the button reads as broken. It was reported as exactly that.
    // Reading the form with textContent -- which is what this suite used to do
    // -- passes whether or not a human can see it, which is why it went
    // unnoticed. These two assert what the person actually gets.
    const vp = await page.evaluate(() => {
      const f = document.querySelector("#ac-cu-form2");
      if (!f || !f.children.length) return { missing: true };
      const r = f.getBoundingClientRect();
      return {
        top: Math.round(r.top), viewportHeight: window.innerHeight,
        onScreen: r.top < window.innerHeight && r.bottom > 0,
        focusInside: f.contains(document.activeElement),
        focusTag: document.activeElement ? document.activeElement.tagName : null,
      };
    });
    check("THE ATTACH FORM IS SCROLLED TO WHERE SHE IS LOOKING, not left below the fold",
      vp.onScreen && vp.top < vp.viewportHeight * 0.75, vp);
    check("...and the cursor is already in it, so she can just type",
      vp.focusInside === true, vp);

    const form = await page.textContent(".ac-wrap");
    check("the form explains that a video plays in the page, and where from",
      /plays in the page/i.test(form) && /YouTube, Vimeo, Loom or Google Drive/.test(form), form.slice(-800));
    check("...and that anything else is kept as a link",
      /Anything else is kept as a link that opens in a new tab/i.test(form), form.slice(-800));
    check("and that an SOP is picked rather than pasted",
      /picked from the policy library rather than pasted/i.test(form), form.slice(-800));
    const opts = await page.evaluate(() => [...document.querySelectorAll("#ac-nr-pol option")].map((o) => o.textContent));
    check("THE POLICY LIBRARY ACTUALLY LOADED into the dropdown — a wrong key"
      + " here would be a silently empty list",
      opts.some((t) => /AcadL4 Attendance Policy/.test(t)), opts.slice(0, 8));

    section("MOVING A MODULE ACTUALLY MOVES IT");
    // End to end, through the API and back onto the screen. The order is sent
    // as one request for the whole layout, so this also proves the screen
    // builds that layout correctly rather than just calling something.
    const orderOf = () => page.evaluate(() =>
      [...document.querySelectorAll("[data-cu-modtitle]")].map((e) => e.textContent.trim()));
    const before = await orderOf();
    check("there are at least two modules to swap", before.length >= 2, before);
    await page.locator("[data-cu-mmove][data-cu-dir='1']").first().click();
    await page.waitForTimeout(2000);
    const after = await orderOf();
    check("THE FIRST TWO MODULES SWAPPED", after[0] === before[1] && after[1] === before[0],
      { before: before.slice(0, 3), after: after.slice(0, 3) });
    check("...and nothing was lost or duplicated in the move", after.length === before.length,
      { before: before, after: after });
    check("...and no error was reported",
      (await page.textContent("#ac-cu-order-msg")).trim() === "",
      await page.textContent("#ac-cu-order-msg"));

    section("CREATING A SECOND PROGRAMME WITHOUT A DEVELOPER");
    await page.click("#ac-cu-new");
    await page.waitForTimeout(400);
    const nf = await page.textContent(".ac-wrap");
    check("the new-programme form warns about the auto-enrol role",
      /Leave the role blank unless/i.test(nf), nf.slice(0, 1200));
    await page.fill("#ac-np-name", `AcadL4 Squad Leader ${stamp}`);
    await page.fill("#ac-np-weeks", "6");
    await page.click("#ac-np-save");
    await page.waitForTimeout(1800);
    const made = (await pool.query(
      "SELECT * FROM academy_programs WHERE name = $1", [`AcadL4 Squad Leader ${stamp}`])).rows[0];
    check("A SQUAD LEADER PROGRAMME IS CREATED FROM THE SCREEN", !!made, made);
    check("with the weeks asked for", made && Number(made.weeks) === 6, made && made.weeks);
    check("AND NO ROLE TARGET, so nobody is swept onto a half-written curriculum",
      made && !made.role_target, made && made.role_target);
    if (made) {
      await pool.query("DELETE FROM academy_programs WHERE id = $1", [made.id]).catch(() => {});
    }

    section("Nothing threw");
    check("no page errors anywhere in that journey", errors.length === 0, errors.slice(0, 3));

    await purge();
  } catch (e) {
    fail++;
    console.log("  FAIL  the suite threw  -> " + e.message);
    await purge().catch(() => {});
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
