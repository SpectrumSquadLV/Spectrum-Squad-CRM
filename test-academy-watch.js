// HOW FAR THROUGH A TRAINING VIDEO SOMEBODY ACTUALLY GOT.
//
// The practice's training videos are MP4s linked from a file host, so they
// play in a <video> element we own -- and a player we own can say how far it
// has played. An embedded YouTube or Vimeo iframe cannot, without loading
// that provider's script into a signed-in page, so the bar covers the files
// we play ourselves and says nothing about the rest.
//
// THE RULE THIS SUITE DEFENDS ABOVE ALL: WATCHING IS NOT COMPLETING. The
// brief is explicit that an activity must not be ticked off because somebody
// opened it. Recording that a video was watched to the end must therefore
// leave the module exactly as unfinished as it was.
//
// And progress only ever moves FORWARD. Somebody who scrubs back to re-watch
// a section has not unwatched the rest of it.
//
//   DATABASE_URL=... node run-tests.js test-academy-watch.js
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
    const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'AcadWat %')";
    await pool.query(`DELETE FROM academy_video_progress WHERE employee_id IN ${ids}`).catch(() => {});
    const enr = `(SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`;
    for (const t of ["academy_dev_plans", "academy_progress", "academy_audit", "academy_checkins",
                     "academy_questions", "academy_gaps"]) {
      await pool.query(`DELETE FROM ${t} WHERE enrollment_id IN ${enr}`).catch(() => {});
    }
    await pool.query(`DELETE FROM academy_enrollments WHERE employee_id IN ${ids}`).catch(() => {});
    await pool.query(`DELETE FROM hr_employees WHERE name LIKE 'AcadWat %'`).catch(() => {});
    await pool.query(`DELETE FROM users WHERE name LIKE 'AcadWat %'`).catch(() => {});
  };

  try {
    await purge();
    const owner = session();
    const ol = await owner("/api/auth/login", {
      method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
    if (ol.status !== 200) throw new Error("owner login failed: " + ol.status);

    const mkUser = async (label, title, role = "clinical") => {
      // Lower-cased: addresses are stored lower-cased by the app and the
      // lookup lower-cases what it is given, so a capital in the label here
      // makes a user who can never sign in.
      const email = `acadwat-${label}-${stamp}@example.invalid`.toLowerCase();
      const pw = hp("AcadWat123!");
      await pool.query(
        `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
         VALUES ($1,$2,$3,$4,$5, now())`, [`AcadWat ${label}`, email, pw.hash, pw.salt, role]);
      let empId = null;
      if (title) {
        empId = (await pool.query(
          `INSERT INTO hr_employees (name, email, role_title, status)
           VALUES ($1,$2,$3,'active') RETURNING id`, [`AcadWat ${label}`, email, title])).rows[0].id;
      }
      const c = session();
      const r = await c("/api/auth/login", { method: "POST", body: { email, password: "AcadWat123!" } });
      if (r.status !== 200) throw new Error(`${label} login failed: ${r.status} ${JSON.stringify(r.data)}`);
      return { client: c, empId, email };
    };

    const learner = await mkUser("Learner", "BCBA");
    const other = await mkUser("Other", "BCBA");
    const director = await mkUser("Director", "Clinical Director");
    await owner(`/api/academy/leadership/${director.empId}`, { method: "PUT", body: { leadership: "clinical_director" } });
    // A login with NO employee record at all.
    const stray = await mkUser("Stray", null);

    // ---------------------------------------------------------------- setup
    const mk = await owner("/api/academy/programs", { method: "POST", body: {
      name: `AcadWat Programme ${stamp}`, key: `acadwat-${stamp}`, weeks: 2, duration_days: 14 } });
    if (mk.status !== 200) throw new Error("programme create failed: " + JSON.stringify(mk.data));
    const prog = mk.data.program;
    const wk = await owner(`/api/academy/programs/${prog.id}/modules`, {
      method: "POST", body: { week: 1, title: "Week one" } });
    const modId = wk.data.module.id;
    const it = await owner(`/api/academy/modules/${modId}/items`, {
      method: "POST", body: { title: "Watch the HIPAA training", kind: "reading" } });
    const itemId = it.data.id || it.data.item_id || (it.data.item && it.data.item.id);

    const vid = await owner("/api/academy/resources", { method: "POST", body: {
      kind: "video", title: "HIPAA training video",
      url: "https://files.spectrumsquadlv.com/training/hipaa.mp4", item_id: itemId } });
    check("the owner can attach an mp4 by link", vid.status === 200, vid.data);
    const docRes = await owner("/api/academy/resources", { method: "POST", body: {
      kind: "link", title: "A reading", url: "https://example.invalid/reading", item_id: itemId } });

    // The resource id, read back the way the page sees it.
    const cur = await owner(`/api/academy/curriculum?program=${prog.key}`);
    const allRes = [].concat(...(cur.data.modules || []).map(
      (m) => [].concat(...(m.items || []).map((i) => i.resources || []))));
    const theVideo = allRes.find((r) => r.kind === "video");
    const theLink = allRes.find((r) => r.kind === "link");
    check("the video comes back as a playable FILE, not an embed",
      !!(theVideo && theVideo.file && theVideo.file.src) && theVideo.embed === null, theVideo);
    check("...with the mp4 type on it", theVideo.file.type === "video/mp4", theVideo.file);

    const er = await owner("/api/academy/enrollments", { method: "POST", body: {
      employee_id: learner.empId, program_key: prog.key } });
    check("the learner is enrolled", er.status === 200, er.data);

    const post = (c, id, body) => c(`/api/academy/videos/${id}/progress`, { method: "POST", body });

    // =====================================================================
    section("WHAT THE PLAYER REPORTS IS WHAT THE BAR SHOWS");
    const p1 = await post(learner.client, theVideo.id, { position: 30, duration: 120 });
    check("progress is recorded", p1.status === 200, p1.data);
    check("...as a quarter of the way through", p1.data.progress.percent === 25, p1.data.progress);
    check("...and is not marked finished", p1.data.progress.finished === false, p1.data.progress);

    const p2 = await post(learner.client, theVideo.id, { position: 60, duration: 120 });
    check("watching further moves it on", p2.data.progress.percent === 50, p2.data.progress);

    section("PROGRESS ONLY EVER MOVES FORWARD");
    // Scrubbing back to re-watch a section has not unwatched the rest.
    const p3 = await post(learner.client, theVideo.id, { position: 20, duration: 120 });
    check("SCRUBBING BACK DOES NOT LOSE WHAT THEY WATCHED",
      p3.data.progress.percent === 50, p3.data.progress);
    check("...though where they are now is remembered, so it picks up there",
      Number(p3.data.progress.last_position) === 20, p3.data.progress);

    section("A PLAYER REPORTING NONSENSE IS NOT BELIEVED");
    const p4 = await post(learner.client, theVideo.id, { position: 5000, duration: 120 });
    check("a position past the end is clamped to the end rather than stored",
      Number(p4.data.progress.furthest_seconds) === 120, p4.data.progress);
    check("...which reads as 100%, not 4166%", p4.data.progress.percent === 100, p4.data.progress);
    check("a position that is not a number is refused",
      (await post(learner.client, theVideo.id, { position: "halfway", duration: 120 })).status === 400);
    check("a negative position is refused",
      (await post(learner.client, theVideo.id, { position: -5, duration: 120 })).status === 400);
    check("a length of zero is refused",
      (await post(learner.client, theVideo.id, { position: 1, duration: 0 })).status === 400);

    section("WATCHED TO THE END");
    const fresh = await owner("/api/academy/resources", { method: "POST", body: {
      kind: "video", title: "Second video", url: "https://files.spectrumsquadlv.com/training/two.mp4", item_id: itemId } });
    const cur2 = await owner(`/api/academy/curriculum?program=${prog.key}`);
    const vids = [].concat(...(cur2.data.modules || []).map(
      (m) => [].concat(...(m.items || []).map((i) => i.resources || []))))
      .filter((r) => r.kind === "video" && /Second/.test(r.title));
    const v2 = vids[0];
    const nearEnd = await post(learner.client, v2.id, { position: 114, duration: 120 });
    check("stopping a few seconds from the end still counts as watched to the end",
      nearEnd.data.progress.finished === true, nearEnd.data.progress);
    // On a FRESH video, because the one above was already clamped to the end
    // earlier in this suite -- asserting "not finished" against it would have
    // passed for the wrong reason.
    const fourth = await owner("/api/academy/resources", { method: "POST", body: {
      kind: "video", title: "Fourth video", url: "https://files.spectrumsquadlv.com/training/four.mp4", item_id: itemId } });
    const cur4 = await owner(`/api/academy/curriculum?program=${prog.key}`);
    const v4 = [].concat(...(cur4.data.modules || []).map(
      (m) => [].concat(...(m.items || []).map((i) => i.resources || []))))
      .filter((r) => r.kind === "video" && /Fourth/.test(r.title))[0];
    const halfWay = await post(learner.client, v4.id, { position: 60, duration: 120 });
    check("...but HALF WAY THROUGH IS NOT watched to the end",
      halfWay.data.progress.finished === false, halfWay.data.progress);
    check("...and reads as half", halfWay.data.progress.percent === 50, halfWay.data.progress);

    section("WATCHING IS NOT COMPLETING — the rule the brief states outright");
    const me = await learner.client("/api/academy/me");
    const done = (me.data.progress || {}).completed;
    check("the video was watched to the end", nearEnd.data.progress.finished === true);
    check("AND THE MODULE IS STILL NOT COMPLETE", Number(done) === 0, { completed: done });
    check("...nor is the programme any further on than it was",
      Number((me.data.progress || {}).percent) === 0, me.data.progress);

    section("A LENGTH THE PLAYER COULD NOT WORK OUT");
    const third = await owner("/api/academy/resources", { method: "POST", body: {
      kind: "video", title: "Third video", url: "https://files.spectrumsquadlv.com/training/three.webm", item_id: itemId } });
    const cur3 = await owner(`/api/academy/curriculum?program=${prog.key}`);
    const v3 = [].concat(...(cur3.data.modules || []).map(
      (m) => [].concat(...(m.items || []).map((i) => i.resources || []))))
      .filter((r) => r.kind === "video" && /Third/.test(r.title))[0];
    const noDur = await post(learner.client, v3.id, { position: 12 });
    check("progress is still recorded without a length", noDur.status === 200, noDur.data);
    check("...and the percentage is null rather than a misleading zero",
      noDur.data.progress.percent === null, noDur.data.progress);

    section("WHOSE WATCHING IS WHOSE");
    const mine = await learner.client("/api/academy/videos/progress");
    check("the learner reads their own", mine.status === 200 && !!mine.data.progress[theVideo.id], mine.data);
    const theirs = await other.client("/api/academy/videos/progress");
    check("somebody else's account shows none of it",
      !theirs.data.progress[theVideo.id], theirs.data);
    const peek = await other.client(`/api/academy/videos/progress?employee=${learner.empId}`);
    check("AN ORDINARY COLLEAGUE CANNOT READ THEIRS", peek.status === 403, peek.status);
    const dirPeek = await director.client(`/api/academy/videos/progress?employee=${learner.empId}`);
    check("whoever runs onboarding can, which is the point of a tracker",
      dirPeek.status === 200 && !!dirPeek.data.progress[theVideo.id], dirPeek.status);

    section("WHAT CANNOT BE REPORTED AGAINST");
    check("a resource that is not a video", (await post(learner.client, theLink.id, { position: 5 })).status === 404);
    check("a resource that does not exist", (await post(learner.client, 99999999, { position: 5 })).status === 404);
    const strayPost = await post(stray.client, theVideo.id, { position: 5, duration: 10 });
    check("a login with no employee record is told so rather than silently recording nothing",
      strayPost.status === 403, strayPost.status);
    check("...and says why", /employee record/i.test((strayPost.data && strayPost.data.error) || ""), strayPost.data);

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
