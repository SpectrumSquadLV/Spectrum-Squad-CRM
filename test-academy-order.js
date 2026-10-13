// MOVING THE CURRICULUM AROUND: weeks, and the modules inside them.
//
// Asked for: "each item should be a module and they should be able to move
// them around." The weeks stay as the programme's pacing; what sits inside
// them is a module, numbered straight through, and both can be reordered.
//
// THE PROPERTY THAT DECIDES THE WHOLE DESIGN. Editing a curriculum somebody
// is enrolled on FORKS a new version, and versionForEdit bumps the version
// every single time it is called. So reordering five modules through the
// per-module PATCH would mint FIVE curriculum versions for one drag, each
// closing and reopening rows the last had just written. The whole new order
// therefore goes in ONE request that forks AT MOST ONCE -- and that is what
// the "exactly one version" assertions below are for. They are the reason
// this endpoint exists rather than a loop in the browser.
//
// And the brief's hard rule still holds through a reorder: an employee keeps
// reading the version they enrolled on. Moving modules about must not shuffle
// the curriculum under somebody who is halfway through it.
//
//   DATABASE_URL=... node run-tests.js test-academy-order.js
"use strict";

const { Pool } = require("pg");
const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const BASE = process.env.BASE || "http://localhost:3011";
const stamp = Date.now().toString(36);

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++; failures.push(name);
    console.log("  FAIL  " + name + (detail !== undefined
      ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : ""));
  }
};
const section = (t) => console.log("\n== " + t + " ==");

const hp = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
};
function session() {
  let cookie = "";
  return async function (path, opts = {}) {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}

(async () => {
  const purge = async () => {
    const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'AcadOrd %')";
    const enr = `(SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`;
    for (const t of ["academy_dev_plans", "academy_progress", "academy_audit", "academy_checkins",
                     "academy_questions", "academy_gaps"]) {
      await pool.query(`DELETE FROM ${t} WHERE enrollment_id IN ${enr}`).catch(() => {});
    }
    await pool.query(`DELETE FROM academy_enrollments WHERE employee_id IN ${ids}`).catch(() => {});
    await pool.query(`DELETE FROM hr_employees WHERE name LIKE 'AcadOrd %'`).catch(() => {});
    await pool.query(`DELETE FROM users WHERE name LIKE 'AcadOrd %'`).catch(() => {});
  };

  try {
    await purge();
    const owner = session();
    const ol = await owner("/api/auth/login", {
      method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
    if (ol.status !== 200) throw new Error("owner login failed: " + ol.status);

    // A clinical director: genuinely runs onboarding, authors nothing.
    const director = session();
    const de = `acadord-director-${stamp}@example.invalid`;
    const dp = hp("AcadOrd123!");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ('AcadOrd Director',$1,$2,$3,'clinical', now())`, [de, dp.hash, dp.salt]);
    const dirEmp = (await pool.query(
      `INSERT INTO hr_employees (name, email, role_title, status)
       VALUES ('AcadOrd Director',$1,'Clinical Director','active') RETURNING id`, [de])).rows[0].id;
    await owner(`/api/academy/leadership/${dirEmp}`, { method: "PUT", body: { leadership: "clinical_director" } });
    const dl = await director("/api/auth/login", { method: "POST", body: { email: de, password: "AcadOrd123!" } });
    if (dl.status !== 200) throw new Error("director login failed");

    // Somebody to enrol later, so the fork path is exercised for real.
    const plain = session();
    const pe = `acadord-plain-${stamp}@example.invalid`;
    const pp = hp("AcadOrd123!");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ('AcadOrd Plain',$1,$2,$3,'clinical', now())`, [pe, pp.hash, pp.salt]);
    const plainEmp = (await pool.query(
      `INSERT INTO hr_employees (name, email, role_title, status)
       VALUES ('AcadOrd Plain',$1,'BCBA','active') RETURNING id`, [pe])).rows[0].id;
    const pl = await plain("/api/auth/login", { method: "POST", body: { email: pe, password: "AcadOrd123!" } });
    if (pl.status !== 200) throw new Error("plain login failed");

    // ---------------------------------------------------------------- setup
    const mk = await owner("/api/academy/programs", { method: "POST", body: {
      name: `AcadOrd Programme ${stamp}`, key: `acadord-${stamp}`, weeks: 3, duration_days: 21 } });
    if (mk.status !== 200) throw new Error("programme create failed: " + JSON.stringify(mk.data));
    const prog = mk.data.program;

    const mkWeek = async (week, title) => {
      const r = await owner(`/api/academy/programs/${prog.id}/modules`, { method: "POST", body: { week, title } });
      if (r.status !== 200) throw new Error(`week create failed: ${JSON.stringify(r.data)}`);
      return r.data.module;
    };
    const mkMod = async (moduleId, title, kind = "reading") => {
      const r = await owner(`/api/academy/modules/${moduleId}/items`, { method: "POST", body: { title, kind } });
      if (r.status !== 200) throw new Error(`module create failed: ${JSON.stringify(r.data)}`);
      return r.data;
    };
    const w1 = await mkWeek(1, "Week one");
    const w2 = await mkWeek(2, "Week two");
    await mkMod(w1.id, "Alpha");
    await mkMod(w1.id, "Bravo");
    await mkMod(w1.id, "Charlie");
    await mkMod(w2.id, "Delta");

    // The curriculum as the screen sees it, flattened to titles in order.
    const read = async (version) => (await owner(
      `/api/academy/curriculum?program=${prog.key}` + (version ? `&version=${version}` : ""))).data;
    const titles = (cur) => (cur.modules || []).map((m) => (m.items || []).map((i) => i.title));
    const flat = (cur) => [].concat(...titles(cur));
    const layoutOf = (cur) => (cur.modules || []).map((m) => ({
      module_id: m.id, week: m.week, items: (m.items || []).map((i) => i.id) }));
    const progNow = async () => ((await owner("/api/academy/programs")).data.programs || [])
      .find((p) => Number(p.id) === Number(prog.id));
    const put = (layout, who) => (who || owner)(`/api/academy/programs/${prog.id}/order`,
      { method: "PUT", body: { layout } });

    const cur0 = await read();
    check("the programme starts with the modules in the order they were added",
      JSON.stringify(flat(cur0)) === JSON.stringify(["Alpha", "Bravo", "Charlie", "Delta"]), flat(cur0));
    check("...and numbering runs straight through the weeks, not per week",
      titles(cur0).length === 2 && titles(cur0)[0].length === 3, titles(cur0));

    // =====================================================================
    section("THE ORDER IS THE OWNER'S TO SET, AND NOBODY ELSE'S");
    const lay0 = layoutOf(cur0);
    const dOrd = await put(lay0, director);
    check("the Clinical Director cannot reorder the curriculum", dOrd.status === 403, dOrd.status);
    check("...and is told whose it is", /practice owner/i.test((dOrd.data && dOrd.data.error) || ""), dOrd.data);
    const pOrd = await put(lay0, plain);
    check("an ordinary BCBA cannot either", pOrd.status === 403, pOrd.status);

    // =====================================================================
    section("MOVING A MODULE WITHIN ITS WEEK");
    const l1 = layoutOf(cur0);
    l1[0].items = [l1[0].items[1], l1[0].items[0], l1[0].items[2]]; // Bravo, Alpha, Charlie
    const r1 = await put(l1);
    check("the owner can reorder", r1.status === 200, r1.data);
    check("NOBODY IS ENROLLED, so it did not fork", r1.data.forked === false, r1.data);
    const cur1 = await read();
    check("the new order reads back", JSON.stringify(flat(cur1)) === JSON.stringify(["Bravo", "Alpha", "Charlie", "Delta"]),
      flat(cur1));
    check("...and the version did not move", Number((await progNow()).version) === Number(prog.version),
      { was: prog.version, now: (await progNow()).version });

    // =====================================================================
    section("MOVING A MODULE INTO ANOTHER WEEK");
    const l2 = layoutOf(cur1);
    const moved = l2[0].items.pop();            // Charlie leaves week one
    l2[1].items.unshift(moved);                 // and arrives at the top of week two
    const r2 = await put(l2);
    check("the move is accepted", r2.status === 200, r2.data);
    const cur2 = await read();
    check("week one has two modules now", titles(cur2)[0].length === 2, titles(cur2));
    check("week two has it at the top",
      JSON.stringify(titles(cur2)[1]) === JSON.stringify(["Charlie", "Delta"]), titles(cur2));
    check("and nothing about the module itself changed",
      (cur2.modules[1].items[0].kind === "reading"), cur2.modules[1].items[0]);

    // =====================================================================
    section("MOVING A WHOLE WEEK");
    const l3 = layoutOf(cur2);
    const aw = l3[0].week, bw = l3[1].week;
    l3[0].week = bw; l3[1].week = aw;
    const swapped = [l3[1], l3[0]];
    const r3 = await put(swapped);
    check("the weeks can be swapped", r3.status === 200, r3.data);
    const cur3 = await read();
    check("WEEK TWO IS NOW FIRST", cur3.modules[0].title === "Week two", (cur3.modules || []).map((m) => m.title));
    check("...and its modules came with it",
      JSON.stringify(titles(cur3)[0]) === JSON.stringify(["Charlie", "Delta"]), titles(cur3));

    // put it back, so the rest of the suite reads naturally
    const l4 = layoutOf(cur3);
    const cw = l4[0].week, dw = l4[1].week;
    l4[0].week = dw; l4[1].week = cw;
    await put([l4[1], l4[0]]);

    // =====================================================================
    section("A LAYOUT THAT DOES NOT MATCH THE CURRICULUM IS REFUSED");
    const curNow = await read();
    const short = layoutOf(curNow);
    short[0].items = short[0].items.slice(1);   // quietly drop one module
    const rShort = await put(short);
    check("DROPPING A MODULE FROM THE LAYOUT IS REFUSED, not silently applied",
      rShort.status === 409, rShort.status);
    check("...and says the screen is stale", /changed since/i.test((rShort.data && rShort.data.error) || ""), rShort.data);

    const extra = layoutOf(curNow);
    extra[0].items = extra[0].items.concat([999999]);
    check("an id that is not in this programme is refused", (await put(extra)).status === 409);

    const missingWeek = layoutOf(curNow).slice(1);
    check("leaving a whole week out is refused", (await put(missingWeek)).status === 409);

    const dupe = layoutOf(curNow);
    dupe[1].items = dupe[1].items.concat([dupe[0].items[0]]);
    check("the same module listed twice is refused", (await put(dupe)).status === 409);

    const badWeek = layoutOf(curNow);
    badWeek[0].week = 99;
    const rBad = await put(badWeek);
    check("a week number outside the programme is refused", rBad.status === 400, rBad.status);
    check("...naming the range", /between 1 and 3/.test((rBad.data && rBad.data.error) || ""), rBad.data);

    check("and after all those refusals the curriculum is untouched",
      JSON.stringify(flat(await read())) === JSON.stringify(flat(curNow)), flat(await read()));

    // =====================================================================
    section("ONCE SOMEBODY IS ENROLLED: ONE REORDER, ONE VERSION");
    // Attach a document first, so the fork has something to carry.
    const beforeFork = await read();
    const firstMod = beforeFork.modules[0].items[0];
    const resAdd = await owner("/api/academy/resources", { method: "POST", body: {
      kind: "link", title: "Reading for this module", url: "https://example.invalid/reading", item_id: firstMod.id } });
    check("a document is attached to the first module", resAdd.status === 200, resAdd.data);

    const er = await owner("/api/academy/enrollments", { method: "POST", body: {
      employee_id: plainEmp, program_key: prog.key } });
    check("somebody is enrolled", er.status === 200, er.data);
    const enrolledVersion = Number(er.data.enrollment.program_version);

    const theirOrderBefore = ((await plain("/api/academy/me")).data.progress.items || []).map((i) => i.title);
    const flatWeeks = (beforeFork.modules || []).map((m) => m.title);
    check("they see the curriculum as it stands", theirOrderBefore.length === 4, theirOrderBefore);

    const vBefore = Number((await progNow()).version);
    // A reorder that moves THREE modules at once. Through the per-module
    // PATCH this would have been three forks and three versions.
    const l5 = layoutOf(beforeFork);
    l5[0].items = l5[0].items.slice().reverse();
    l5[1].items = l5[1].items.slice().reverse();
    const r5 = await put(l5);
    check("the reorder succeeds", r5.status === 200, r5.data);
    check("IT FORKED, because somebody is on it", r5.data.forked === true, r5.data);
    const vAfter = Number((await progNow()).version);
    check("AND THE VERSION MOVED BY EXACTLY ONE, for the whole reorder",
      vAfter === vBefore + 1, { before: vBefore, after: vAfter });

    const curNew = await read();
    check("the new version carries the new order",
      JSON.stringify(flat(curNew)) === JSON.stringify(flat(beforeFork).slice(0, 2).reverse()
        .concat(flat(beforeFork).slice(2).reverse())),
      { now: flat(curNew), was: flat(beforeFork) });
    check("every module survived the fork", flat(curNew).length === 4, flat(curNew));
    check("THE ATTACHED DOCUMENT CAME ACROSS — a reorder that loses the reading is the bug here",
      JSON.stringify(curNew).indexOf("Reading for this module") >= 0,
      (curNew.modules[0].items[0] || {}).resources);

    section("AND THE PERSON HALFWAY THROUGH DOES NOT HAVE IT SHUFFLED UNDER THEM");
    const theirOrderAfter = ((await plain("/api/academy/me")).data.progress.items || []).map((i) => i.title);
    check("THEY STILL SEE THEIR OWN ORDER, not the new one",
      JSON.stringify(theirOrderAfter) === JSON.stringify(theirOrderBefore),
      { theirs: theirOrderAfter, was: theirOrderBefore });
    check("...on the version they enrolled on",
      Number((await plain("/api/academy/me")).data.enrollment.program_version) === enrolledVersion,
      enrolledVersion);
    check("...and the old version still reads back in the old order",
      JSON.stringify(flat(await read(enrolledVersion))) === JSON.stringify(flat(beforeFork)),
      flat(await read(enrolledVersion)));

    section("MOVING A WHOLE WEEK ONCE SOMEBODY IS ENROLLED");
    // The week-swap above ran while nobody was on the programme, so it only
    // ever exercised the in-place branch. The forked branch writes new rows
    // and has to carry the week number across -- a mutant that kept the old
    // week number survived until this existed.
    const curW = await read();
    const lw = layoutOf(curW);
    const firstTitle = curW.modules[0].title, secondTitle = curW.modules[1].title;
    const vw = Number((await progNow()).version);
    const ww1 = lw[0].week, ww2 = lw[1].week;
    lw[0].week = ww2; lw[1].week = ww1;
    const rw = await put([lw[1], lw[0]]);
    check("the weeks swap on a forked version too", rw.status === 200, rw.data);
    check("...and it forked", rw.data.forked === true, rw.data);
    const curWAfter = await read();
    check("THE SECOND WEEK IS NOW FIRST on the new version",
      curWAfter.modules[0].title === secondTitle, (curWAfter.modules || []).map((m) => m.title));
    check("...and the one that was first is now second",
      curWAfter.modules[1].title === firstTitle, (curWAfter.modules || []).map((m) => m.title));
    check("...for exactly one more version", Number((await progNow()).version) === vw + 1,
      { was: vw, now: (await progNow()).version });
    check("...while the enrolled person's weeks stay as they were",
      JSON.stringify(((await read(enrolledVersion)).modules || []).map((m) => m.title))
        === JSON.stringify(flatWeeks), flatWeeks);

    section("A SECOND REORDER IS A SECOND VERSION, AND NOT A THIRD");
    // Read fresh: the week swap above forked, so every id from before it is
    // now an older version's row -- which the endpoint rightly refuses.
    const curFresh = await read();
    const vFresh = Number((await progNow()).version);
    const l6 = layoutOf(curFresh);
    l6[0].items = l6[0].items.slice().reverse();
    const r6 = await put(l6);
    check("it succeeds", r6.status === 200, r6.data);
    check("one more version, not several", Number((await progNow()).version) === vFresh + 1,
      { was: vFresh, now: (await progNow()).version });

    if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log("  " + f)); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await purge();
    await pool.end();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error("Crashed:", e);
    try { await pool.end(); } catch (x) {}
    process.exit(1);
  }
})();
