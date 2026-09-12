// test-hire-packet.js -- the application and policy packet.
//
// The packet has two halves that fail in opposite directions, so both are
// tested against their own opposite:
//
//   1. The parts Spectrum Squad wrote are retyped as a form, and the PDF that
//      lands in the personnel file has to say what the applicant actually read.
//      Both come out of hire-packet.html, so the test that matters is that
//      every field still resolves to a question and every clause to its text.
//      A field that stops resolving prints as a raw column name on somebody's
//      employment record.
//
//   2. The two government forms are handed over untouched. "Unaltered" is not
//      a promise a comment can keep, so it is asserted as bytes: what the
//      applicant downloads is compared byte for byte against forms/ on disk.
//      Nothing in this module is allowed to pre-fill, stamp or regenerate them.
//
// Everything that refuses is written with its positive control beside it. A
// sweep that emails nobody at all passes every "did not email" check in this
// file on its own, and a permission test passes for the wrong reason if the
// route is simply broken -- so each refusal is paired with the case that has
// to still work.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-hire-packet.js
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    const d = detail === undefined ? "" : "\n          -> " +
      String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400);
    console.log("  FAIL  " + name + d);
  }
}
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let cookie = "";
  return async (p, { method = "GET", body, raw } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined),
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}
// The applicant is not signed in: their token is the whole of their identity,
// and it travels on every request. A client per token, so a missing token in
// a test is a mistake in the test rather than a route that quietly refuses.
function applicantClient(token) {
  return async (p, { method = "GET", body, raw } = {}) => {
    const url = BASE + p + (p.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token);
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined),
    });
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}
async function getBytes(p, cookie) {
  const r = await fetch(BASE + p, { headers: cookie ? { Cookie: cookie } : {} });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf };
}
const hp = (pw) => { const salt = crypto.randomBytes(16).toString("hex"); return { hash: crypto.scryptSync(pw, salt, 64).toString("hex"), salt }; };

// A 1x1 baseline JPEG. Small, real, and the smallest thing the signature
// decoder will accept -- padded so it clears the module's 100-byte floor.
const SIG = "data:image/jpeg;base64," + Buffer.concat([
  Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64"),
]).toString("base64");

const stamp = Date.now();
// The completion email is deliberately fire-and-forget -- the applicant's
// "Finish" must not wait on an SMTP round trip, the same way finalizing a
// fidelity check locks the scores first and emails afterwards. So the test
// waits for it to land rather than reading the count the instant the response
// comes back, and fails on the timeout rather than on the race.
async function waitForMail(addr, was, ms = 6000) {
  const until = Date.now() + ms;
  for (;;) {
    const n = await packetMailTo(addr);
    if (n > was) return n;
    if (Date.now() > until) return n;
    await new Promise((r) => setTimeout(r, 150));
  }
}
const mailTo = (addr) => pool.query(
  "SELECT COUNT(*)::int AS n FROM notifications_log WHERE recipient = $1", [addr]
).then((r) => r.rows[0].n).catch(() => 0);
// The completion notice specifically. Counting every email to an address is
// enough for an invite, whose recipient is an applicant nothing else writes
// to -- but the packet recipient is a Spectrum Squad address that other
// automations also mail, so "did somebody get told" has to name the notice it
// is asking about or it passes on somebody else's email.
const packetMailTo = (addr) => pool.query(
  "SELECT COUNT(*)::int AS n FROM notifications_log WHERE recipient = $1 AND type = 'hire_packet_completed'", [addr]
).then((r) => r.rows[0].n).catch(() => 0);

(async () => {
  const owner = client(), hradmin = client(), interviewer = client(), clinical = client();

  const a = hp("TestHrAdmin123!"), b = hp("TestInterviewer123!");
  await pool.query(
    `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
     VALUES ('Packet HR','packethr@spectrumsquadlv.com',$1,$2,'hr_admin',now())
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_salt=EXCLUDED.password_salt, role='hr_admin'`,
    [a.hash, a.salt]
  );
  await pool.query(
    `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
     VALUES ('Packet Interviewer','packetiv@spectrumsquadlv.com',$1,$2,'interviewer',now())
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_salt=EXCLUDED.password_salt, role='interviewer'`,
    [b.hash, b.salt]
  );

  check("owner signs in", (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("hr admin signs in", (await hradmin("/api/auth/login", { method: "POST", body: { email: "packethr@spectrumsquadlv.com", password: "TestHrAdmin123!" } })).status === 200);
  check("interviewer signs in", (await interviewer("/api/auth/login", { method: "POST", body: { email: "packetiv@spectrumsquadlv.com", password: "TestInterviewer123!" } })).status === 200);
  check("clinical signs in", (await clinical("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  // ---------------------------------------------------------------- fixtures
  async function position(slug, title, roleType) {
    const r = await pool.query(
      `INSERT INTO hr_positions (slug, title, role_type, status, created_at)
       VALUES ($1,$2,$3,'open',now()) RETURNING id`,
      [`${slug}-${stamp}`, title, roleType]
    );
    return r.rows[0].id;
  }
  async function applicant(name, email, stage, positionId) {
    const r = await pool.query(
      `INSERT INTO hr_applicants (position_id, full_name, email, stage, applied_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,now(),now(),now()) RETURNING id`,
      [positionId, name, email, stage]
    );
    return r.rows[0].id;
  }
  const tokenFor = (id) => pool.query("SELECT token FROM hire_packets WHERE applicant_id = $1", [id])
    .then((r) => (r.rows[0] ? r.rows[0].token : null));

  const rbtPos = await position("zz-rbt", "Registered Behavior Technician", "rbt");
  const bcbaPos = await position("zz-bcba", "Board Certified Behavior Analyst", "bcba");

  // =========================================================================
  section("The form and the server describe the same packet");
  const content = require("./hire-packet-content");
  const questions = content.packetQuestions();
  const clauses = content.packetClauses();
  const html = fs.readFileSync(path.join(__dirname, "hire-packet.html"), "utf8");

  const named = new Set();
  const fieldRe = /<(?:input|textarea|select)\b([^>]*)>/g;
  let fm;
  while ((fm = fieldRe.exec(html))) {
    const n = fm[1].match(/\bname="([^"]+)"/);
    if (n) named.add(n[1]);
  }
  const unresolved = [...named].filter((n) => !questions[n]);
  check("every field on the form resolves to the question it was asked as", unresolved.length === 0, unresolved);
  check("there are questions to resolve at all", named.size > 60, named.size);
  const emptyClauses = Object.keys(clauses).filter((k) => !clauses[k] || clauses[k].length < 40);
  check("every clause the applicant initials has its wording", Object.keys(clauses).length >= 8 && emptyClauses.length === 0, emptyClauses);
  // Leadership decided not to carry the old acknowledgement page's drug-test
  // consent forward. Asserted rather than assumed: a clause nobody meant to ask
  // for is as much a defect on an employment record as a missing one.
  check("the retired drug-test consent is not asked for",
    !Object.keys(clauses).some((k) => /drug/i.test(clauses[k])), Object.keys(clauses));

  const onScreen = content.packetSections().filter((s) => s !== "intro" && s !== "done");
  const onServer = require("./hire-packet")({
    dbGet: async () => null, dbAll: async () => [], dbRun: async () => ({}),
    nowISO: () => "", crypto, readBody: async () => ({}), json: () => {}, sendFile: () => {},
    sendEmail: async () => {}, APP_BASE_URL: "",
  }).SECTIONS.map((s) => s.key);
  check("no step exists on screen that the server does not know about",
    onScreen.every((k) => onServer.includes(k)), onScreen.filter((k) => !onServer.includes(k)));
  check("no step exists on the server that the form never shows",
    onServer.every((k) => onScreen.includes(k)), onServer.filter((k) => !onScreen.includes(k)));

  // =========================================================================
  section("It goes out when the application reaches a decision");
  const live = await applicant(`ZzPacket Live ${stamp}`, `zzlive${stamp}@example.com`, "credentials_references", rbtPos);
  const tooEarly = await applicant(`ZzPacket Early ${stamp}`, `zzearly${stamp}@example.com`, "phone_screen", rbtPos);
  const noEmail = await applicant(`ZzPacket NoEmail ${stamp}`, null, "offer_sent", rbtPos);
  const rejected = await applicant(`ZzPacket Rejected ${stamp}`, `zzrej${stamp}@example.com`, "not_selected", rbtPos);

  check("a non-HR account cannot run the sweep", (await clinical("/api/hire-packet/sweep", { method: "POST" })).status === 403);
  check("the sweep runs for HR", (await owner("/api/hire-packet/sweep", { method: "POST" })).status === 200);

  check("the applicant at Credentials & References gets a packet", !!(await tokenFor(live)));
  check("...and was actually emailed it", (await mailTo(`zzlive${stamp}@example.com`)) > 0);
  check("an applicant still at Phone Screen is not sent one", !(await tokenFor(tooEarly)));
  check("an applicant with no email address is not sent one", !(await tokenFor(noEmail)));
  check("an applicant already turned down is not sent one", !(await tokenFor(rejected)));

  const liveToken = await tokenFor(live);

  // =========================================================================
  section("Opening the link");
  const me = applicantClient(liveToken);
  const anon = applicantClient("not-a-real-token");
  const state = await me("/api/hire-packet/public/state");
  check("the link opens", state.status === 200, state.data);
  check("it greets the applicant by name", state.data.applicant.name.indexOf("ZzPacket Live") === 0, state.data.applicant);
  check("it does not hand out the applicant's email address",
    JSON.stringify(state.data.applicant).indexOf("@") < 0, state.data.applicant);
  check("it does not hand out where they are in the pipeline",
    JSON.stringify(state.data).indexOf("credentials_references") < 0);
  const bad = await anon("/api/hire-packet/public/state");
  check("an unknown token is refused", bad.status === 404, bad.data);
  check("...and says the link is invalid, not that it is closed", /isn't valid/i.test(bad.data.error), bad.data);

  // =========================================================================
  section("Who has to read what");
  check("an RBT applicant is asked for the RBT continuing education policy",
    state.data.sections.includes("rbt_ce_policy"), state.data.sections);
  const bcbaId = await applicant(`ZzPacket Bcba ${stamp}`, `zzbcba${stamp}@example.com`, "offer_approval", bcbaPos);
  const noPosId = await applicant(`ZzPacket NoPos ${stamp}`, `zznopos${stamp}@example.com`, "offer_approval", null);
  await owner("/api/hire-packet/sweep", { method: "POST" });
  const bcbaTok = await tokenFor(bcbaId);
  const bcba = applicantClient(bcbaTok);
  const bcbaState = await bcba("/api/hire-packet/public/state");
  const noPosState = await applicantClient(await tokenFor(noPosId))("/api/hire-packet/public/state");
  check("a BCBA is not asked to sign the RBT policy", !bcbaState.data.sections.includes("rbt_ce_policy"), bcbaState.data.sections);
  check("...but still gets everything else", bcbaState.data.sections.length === state.data.sections.length - 1, bcbaState.data.sections);
  check("an applicant with no position on file is asked, rather than quietly skipped",
    noPosState.data.sections.includes("rbt_ce_policy"), noPosState.data.sections);

  // =========================================================================
  section("It saves as you go");
  const answers = {
    name_last: "Live", name_first: "ZzPacket", phone_mobile: "702-555-0101",
    email: `zzlive${stamp}@example.com`, present_address: "1 Test St, Las Vegas, NV",
    position_applying_for: "Registered Behavior Technician",
    want_part_time: "Yes", salary_desired: "$25/hr",
    employer1_name: "Previous ABA Co", employer1_starting_pay: "$20/hr", employer1_ending_pay: "$22/hr",
    employer1_reason_leaving: "Moved cities",
    ref1_name: "Jamie Reference", ref1_occupation: "BCBA",
    edu_college_name: "UNLV", edu_college_degree: "BA Psychology",
  };
  const saved = await me("/api/hire-packet/public/save", { method: "POST", body: { answers } });
  check("answers save", saved.status === 200, saved.data);
  const reopened = await me("/api/hire-packet/public/state");
  check("...and are still there when the link is opened again",
    reopened.data.answers.employer1_name === "Previous ABA Co", reopened.data.answers);
  const junk = await me("/api/hire-packet/public/save", { method: "POST", body: { answers: "not an object" } });
  check("a save with nothing in it is refused", junk.status === 400, junk.data);

  // =========================================================================
  section("Signing what is signed on screen");
  const initials = {};
  Object.keys(clauses).forEach((k) => { initials[k] = "ZL"; });

  let r = await me("/api/hire-packet/public/sign", { method: "POST", body: { section: "acknowledgement", signature: SIG, initials } });
  check("signing without typing a name is refused", r.status === 400 && /full name/i.test(r.data.error), r.data);
  r = await me("/api/hire-packet/public/sign", { method: "POST", body: { section: "acknowledgement", typed_name: "ZzPacket Live", initials } });
  check("signing with an empty signature box is refused", r.status === 400 && /sign in the box/i.test(r.data.error), r.data);

  const short = Object.assign({}, initials); delete short[Object.keys(clauses)[0]];
  r = await me("/api/hire-packet/public/sign", { method: "POST", body: { section: "acknowledgement", typed_name: "ZzPacket Live", signature: SIG, initials: short } });
  check("a half-initialled acknowledgement is refused", r.status === 400 && /initial every paragraph/i.test(r.data.error), r.data);

  r = await me("/api/hire-packet/public/sign", { method: "POST", body: { section: "form_8850", typed_name: "ZzPacket Live", signature: SIG } });
  check("a form that is signed on paper cannot be signed on screen", r.status === 400, r.data);

  for (const key of ["acknowledgement", "mandatory_reporting", "rbt_ce_policy"]) {
    const body = { section: key, typed_name: "ZzPacket Live", signature: SIG, sig_w: 500, sig_h: 160 };
    if (key === "acknowledgement") body.initials = initials;
    const res = await me("/api/hire-packet/public/sign", { method: "POST", body });
    check(`${key} signs`, res.status === 200, res.data);
  }
  const notMine = await bcba("/api/hire-packet/public/sign", {
    method: "POST",
    body: { section: "rbt_ce_policy", typed_name: "Bcba Person", signature: SIG, sig_w: 500, sig_h: 160 },
  });
  check("...and the BCBA cannot sign a policy that is not in their packet",
    notMine.status === 400 && /isn't part of your packet/i.test(notMine.data.error), notMine.data);

  // =========================================================================
  section("The two government forms are handed over untouched");
  const onDisk = {
    form_8850: fs.readFileSync(path.join(__dirname, "forms", "irs-form-8850.pdf")),
    background_waiver: fs.readFileSync(path.join(__dirname, "forms", "nv-civil-name-check.pdf")),
  };
  for (const key of Object.keys(onDisk)) {
    const got = await getBytes(`/api/hire-packet/public/form?key=${key}&token=${liveToken}`);
    check(`${key} downloads`, got.status === 200, got.status);
    check(`${key} is byte-for-byte the published form`, got.buf.equals(onDisk[key]),
      `served ${got.buf.length} bytes, on disk ${onDisk[key].length}`);
    check(`${key} is still a PDF`, got.buf.slice(0, 5).toString() === "%PDF-", got.buf.slice(0, 8).toString());
  }
  const noSuchForm = await me("/api/hire-packet/public/form?key=acknowledgement");
  check("a form that is not a paper form cannot be downloaded", noSuchForm.status === 404, noSuchForm.data);
  const bcbaWantsRbt = await getBytes(`/api/hire-packet/public/form?key=form_8850&token=${bcbaTok}`);
  check("...and the forms a BCBA does need still download", bcbaWantsRbt.status === 200, bcbaWantsRbt.status);

  // =========================================================================
  section("Sending the signed copies back");
  async function upload(token, key, body, filename, mime) {
    const r = await fetch(
      `${BASE}/api/hire-packet/public/upload?key=${key}&token=${token}`
      + `&filename=${encodeURIComponent(filename)}&mime=${encodeURIComponent(mime)}`,
      { method: "POST", body }
    );
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  }
  const signedScan = Buffer.from("%PDF-1.4 pretend this is a photo of a signed page\n%%EOF");
  const empty = await upload(liveToken, "form_8850", Buffer.alloc(0), "empty.pdf", "application/pdf");
  check("an empty upload is refused", empty.status === 400, empty.data);
  const up1 = await upload(liveToken, "form_8850", signedScan, "8850-signed.pdf", "application/pdf");
  check("the signed 8850 is accepted", up1.status === 200, up1.data);
  const up2 = await upload(liveToken, "background_waiver", signedScan, "waiver-signed.jpg", "image/jpeg");
  check("the signed waiver is accepted", up2.status === 200, up2.data);
  const afterUploads = await me("/api/hire-packet/public/state");
  check("the page can tell the applicant what it has",
    afterUploads.data.uploads.map((u) => u.key).sort().join(",") === "background_waiver,form_8850",
    afterUploads.data.uploads);

  // =========================================================================
  section("Finishing");
  const halfDone = await bcba("/api/hire-packet/public/state");
  check("the BCBA packet is genuinely still outstanding", halfDone.data.completed.length === 0, halfDone.data.completed);
  const early = await bcba("/api/hire-packet/public/complete", { method: "POST", body: {} });
  check("a packet with something outstanding cannot be finished", early.status === 400, early.data);

  // A packet of signatures with no application behind it would file as a
  // completed employment application, which it is not.
  const blank = await applicant(`ZzPacket Blank ${stamp}`, `zzblank${stamp}@example.com`, "offer_sent", bcbaPos);
  await owner("/api/hire-packet/sweep", { method: "POST" });
  const blankMe = applicantClient(await tokenFor(blank));
  for (const key of ["acknowledgement", "mandatory_reporting"]) {
    const body = { section: key, typed_name: "Blank Person", signature: SIG, sig_w: 500, sig_h: 160 };
    if (key === "acknowledgement") body.initials = initials;
    await blankMe("/api/hire-packet/public/sign", { method: "POST", body });
  }
  await upload(await tokenFor(blank), "form_8850", signedScan, "8850.pdf", "application/pdf");
  await upload(await tokenFor(blank), "background_waiver", signedScan, "waiver.jpg", "image/jpeg");
  const blankDone = await blankMe("/api/hire-packet/public/complete", { method: "POST", body: {} });
  check("everything signed but the application left blank cannot be finished",
    blankDone.status === 400 && /blank/i.test(blankDone.data.error), blankDone.data);
  await blankMe("/api/hire-packet/public/save", { method: "POST", body: { answers: { name_first: "Blank", name_last: "Person" } } });
  const blankNow = await blankMe("/api/hire-packet/public/complete", { method: "POST", body: {} });
  check("...and finishes once there is an application there", blankNow.status === 200, blankNow.data);

  const finished = await me("/api/hire-packet/public/complete", { method: "POST", body: {} });
  check("a complete packet finishes", finished.status === 200, finished.data);
  const docs = await pool.query(
    "SELECT * FROM hr_applicant_documents WHERE applicant_id = $1 AND kind = 'application_packet'", [live]
  );
  check("the packet is filed against the applicant", docs.rows.length === 1, docs.rows.length);
  check("...as a PDF", docs.rows[0] && docs.rows[0].mime_type === "application/pdf", docs.rows[0]);

  const locked = await me("/api/hire-packet/public/save", { method: "POST", body: { answers: { name_last: "Changed" } } });
  check("a finished packet stops taking edits", locked.status === 409, locked.data);

  // =========================================================================
  section("The document that goes in the file");
  const ownerCookie = (await (async () => {
    const r = await fetch(BASE + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@spectrumsquadlv.com", password: "TestOwner123!" }),
    });
    return (r.headers.get("set-cookie") || "").split(";")[0];
  })());
  const pdf = await getBytes(`/api/hire-packet/pdf/${live}`, ownerCookie);
  check("the owner can download the packet document", pdf.status === 200, pdf.status);
  check("...and it is a PDF", pdf.buf.slice(0, 5).toString() === "%PDF-", pdf.buf.slice(0, 8).toString());
  const text = pdf.buf.toString("latin1");
  check("it prints the question, not the column name", text.includes("Reason for leaving"), text.slice(0, 200));
  check("it prints the answer", text.includes("Moved cities"));
  check("it records the initials against the clause", text.includes("ZL"));
  check("it carries the policy wording that was signed", text.includes("NRS 432B"));
  check("it names the forms that were signed on paper", text.includes("8850-signed.pdf"));

  // =========================================================================
  section("Who may read it");
  check("an interviewer can see whether the packet is done", (await interviewer(`/api/hire-packet/status/${live}`)).status === 200);
  check("...but not the answers", (await interviewer(`/api/hire-packet/answers/${live}`)).status === 403);
  check("...nor the document", (await interviewer(`/api/hire-packet/pdf/${live}`)).status === 403);
  check("...nor the signed government forms", (await interviewer(`/api/hire-packet/file/${live}/form_8850`)).status === 403);
  check("...nor send one", (await interviewer(`/api/hire-packet/send/${live}`, { method: "POST" })).status === 403);
  check("clinical staff are nowhere near it", (await clinical(`/api/hire-packet/status/${live}`)).status === 403);

  const hrAnswers = await hradmin(`/api/hire-packet/answers/${live}`);
  const ownerAnswers = await owner(`/api/hire-packet/answers/${live}`);
  check("HR can read the application", hrAnswers.status === 200, hrAnswers.data);
  const hrKeys = hrAnswers.data.answers.map((x) => x.key);
  const ownerKeys = ownerAnswers.data.answers.map((x) => x.key);
  check("what somebody wants to be paid is not shown to HR", !hrKeys.includes("salary_desired"), hrKeys);
  check("...nor what they used to be paid", !hrKeys.includes("employer1_starting_pay"), hrKeys);
  check("...and HR is told something was withheld rather than left to wonder", hrAnswers.data.pay_answers_withheld >= 3, hrAnswers.data.pay_answers_withheld);
  check("the owner does see it", ownerKeys.includes("salary_desired"), ownerKeys);
  check("...and HR sees everything else", hrKeys.includes("employer1_reason_leaving"), hrKeys);

  const hrFile = await getBytes(`/api/hire-packet/file/${live}/form_8850`, null);
  check("the signed 8850 is not readable without signing in", hrFile.status === 401 || hrFile.status === 403, hrFile.status);

  // =========================================================================
  section("The packet stops when the application does");
  const willBeRejected = await applicant(`ZzPacket Dropped ${stamp}`, `zzdrop${stamp}@example.com`, "offer_sent", rbtPos);
  const stillGoing = await applicant(`ZzPacket Going ${stamp}`, `zzgoing${stamp}@example.com`, "offer_sent", rbtPos);
  const parked = await applicant(`ZzPacket Parked ${stamp}`, `zzparked${stamp}@example.com`, "offer_sent", rbtPos);
  await owner("/api/hire-packet/sweep", { method: "POST" });
  const droppedTok = await tokenFor(willBeRejected);
  const goingTok = await tokenFor(stillGoing);
  const parkedTok = await tokenFor(parked);
  check("all three were sent a packet while they were live", !!droppedTok && !!goingTok && !!parkedTok);

  await pool.query("UPDATE hr_applicants SET stage = 'not_selected' WHERE id = $1", [willBeRejected]);
  await pool.query("UPDATE hr_applicants SET stage = 'talent_pool' WHERE id = $1", [parked]);

  const closed = await applicantClient(droppedTok)("/api/hire-packet/public/state");
  check("the link stops opening for somebody who has been turned down", closed.status === 403, closed.data);
  check("...and does not tell whoever is holding the link why", !/not_selected|reject/i.test(closed.data.error), closed.data.error);
  check("...while a closed link and an unknown link stay different answers", closed.data.error !== bad.data.error);
  const stillOpen = await applicantClient(goingTok)("/api/hire-packet/public/state");
  check("...and the live applicant's link still opens", stillOpen.status === 200, stillOpen.status);
  const parkedOpen = await applicantClient(parkedTok)("/api/hire-packet/public/state");
  check("somebody parked in the talent pool keeps their link", parkedOpen.status === 200, parkedOpen.status);

  const uploadAfter = await upload(droppedTok, "form_8850", signedScan, "late.pdf", "application/pdf");
  check("a closed packet stops taking uploads", uploadAfter.status === 403, uploadAfter.data);

  // Reminders. Backdated so the 24-hour gate is open for all three at once,
  // which is what makes the two silences mean something.
  const before = {
    dropped: await mailTo(`zzdrop${stamp}@example.com`),
    going: await mailTo(`zzgoing${stamp}@example.com`),
    parked: await mailTo(`zzparked${stamp}@example.com`),
  };
  await pool.query(
    `UPDATE hire_packets SET sent_at = $1, last_reminder_at = NULL, last_manual_sent_at = NULL
      WHERE applicant_id = ANY($2::int[])`,
    [new Date(Date.now() - 72 * 3600 * 1000).toISOString(), [willBeRejected, stillGoing, parked]]
  );
  await owner("/api/hire-packet/sweep", { method: "POST" });
  check("the live applicant is reminded", (await mailTo(`zzgoing${stamp}@example.com`)) > before.going);
  check("somebody who has been turned down is not", (await mailTo(`zzdrop${stamp}@example.com`)) === before.dropped);
  check("somebody parked in the talent pool is not chased", (await mailTo(`zzparked${stamp}@example.com`)) === before.parked);

  // =========================================================================
  section("Sending it by hand");
  const byHand = await applicant(`ZzPacket ByHand ${stamp}`, `zzhand${stamp}@example.com`, "interviewed", rbtPos);
  const st = await owner(`/api/hire-packet/status/${byHand}`);
  check("the status screen says why it has not gone out on its own",
    /Credentials & References/i.test(st.data.auto_blocked_reason || ""), st.data.auto_blocked_reason);
  const sent = await owner(`/api/hire-packet/send/${byHand}`, { method: "POST" });
  check("HR can send it anyway", sent.status === 200, sent.data);
  check("...and it reached them", (await mailTo(`zzhand${stamp}@example.com`)) > 0);
  const again = await owner(`/api/hire-packet/send/${byHand}`, { method: "POST" });
  check("a second press inside the cooldown asks first", again.status === 409 && again.data.code === "recently_sent", again.data);
  const forced = await owner(`/api/hire-packet/send/${byHand}`, { method: "POST", body: { force: true } });
  check("...and sends when told to", forced.status === 200, forced.data);
  const tok = await tokenFor(byHand);
  const forcedTok = await tokenFor(byHand);
  check("a resend reuses the same link rather than orphaning the first one", tok === forcedTok);

  const refused = await owner(`/api/hire-packet/send/${rejected}`, { method: "POST" });
  check("HR cannot send a packet to somebody already turned down", refused.status === 400, refused.data);

  // =========================================================================
  section("The wording is editable, not baked in");
  const tplList = await owner("/api/email-templates");
  const list = Array.isArray(tplList.data) ? tplList.data : (tplList.data.templates || []);
  const byKey = Object.fromEntries(list.map((t) => [t.template_key, t]));
  check("the invitation is in the template editor", !!byKey.hire_packet_invite, Object.keys(byKey).length);
  check("the reminder is too", !!byKey.hire_packet_reminder, Object.keys(byKey).length);
  check("the editor offers the packet link as a merge field",
    (byKey.hire_packet_invite.fields || []).includes("packet_link"), byKey.hire_packet_invite.fields);
  check("the seeded wording is the wording the module falls back to",
    /government forms/i.test(byKey.hire_packet_invite.body_template || ""),
    (byKey.hire_packet_invite.body_template || "").slice(0, 120));

  const edited = await owner("/api/email-templates/hire_packet_invite", {
    method: "PUT",
    body: {
      subject_template: `Edited subject ${stamp}`,
      body_template: "<p>Hi {{first_name}}, here is your packet: {{packet_link}}</p>",
    },
  });
  check("the template can be edited", edited.status === 200, edited.data);
  const edt = await applicant(`ZzPacket Tpl ${stamp}`, `zztpl${stamp}@example.com`, "offer_sent", rbtPos);
  await owner("/api/hire-packet/sweep", { method: "POST" });
  const sentMail = await pool.query(
    "SELECT subject, body FROM notifications_log WHERE recipient = $1 ORDER BY id DESC LIMIT 1",
    [`zztpl${stamp}@example.com`]
  );
  check("...and the applicant gets the edited wording",
    sentMail.rows.length === 1 && sentMail.rows[0].subject === `Edited subject ${stamp}`, sentMail.rows[0]);

  // The link is the entire point of the email. An edit that drops it would
  // otherwise send somebody a friendly note about paperwork with no way to
  // reach it.
  await owner("/api/email-templates/hire_packet_reminder", {
    method: "PUT",
    body: { subject_template: "No link here", body_template: "<p>Hi {{first_name}}, please finish your packet.</p>" },
  });
  await pool.query(
    "UPDATE hire_packets SET sent_at = $1, last_reminder_at = NULL, last_manual_sent_at = NULL WHERE applicant_id = $2",
    [new Date(Date.now() - 72 * 3600 * 1000).toISOString(), edt]
  );
  await owner("/api/hire-packet/sweep", { method: "POST" });
  const reminder = await pool.query(
    "SELECT subject, body FROM notifications_log WHERE recipient = $1 ORDER BY id DESC LIMIT 1",
    [`zztpl${stamp}@example.com`]
  );
  const linkToken = await tokenFor(edt);
  check("a template edited to drop the link still goes out with one",
    reminder.rows[0].subject === "No link here" && reminder.rows[0].body.includes(linkToken),
    reminder.rows[0] && reminder.rows[0].body.slice(0, 200));

  // =========================================================================
  section("Somebody is told when a packet is finished");
  // The one failure this whole notification exists to prevent is silence: an
  // applicant spends twenty minutes on their paperwork, the CRM files it, and
  // nobody finds out. So the recipient is tested three ways -- the seeded
  // default, a configured address, and a list -- rather than assumed.
  async function completePacketFor(name, email) {
    const id = await applicant(name, email, "offer_sent", bcbaPos);   // BCBA: no CE policy step
    await owner("/api/hire-packet/sweep", { method: "POST" });
    const token = await tokenFor(id);
    const who = applicantClient(token);
    await who("/api/hire-packet/public/save", { method: "POST", body: { answers: { name_first: "Zz", name_last: "Finisher" } } });
    for (const key of ["acknowledgement", "mandatory_reporting"]) {
      const body = { section: key, typed_name: "Zz Finisher", signature: SIG, sig_w: 500, sig_h: 160 };
      if (key === "acknowledgement") body.initials = initials;
      await who("/api/hire-packet/public/sign", { method: "POST", body });
    }
    await upload(token, "form_8850", signedScan, "8850.pdf", "application/pdf");
    await upload(token, "background_waiver", signedScan, "waiver.jpg", "image/jpeg");
    const done = await who("/api/hire-packet/public/complete", { method: "POST", body: {} });
    return { id, status: done.status, error: done.data && done.data.error };
  }

  const settings = await owner("/api/admin/settings");
  const seeded = settings.data.hire_packet_recipient;
  check("the settings screen offers a packet recipient", typeof seeded === "string" && seeded.length > 0, settings.data.hire_packet_recipient);
  check("...and it is seeded rather than blank, so nothing completes silently", /@/.test(seeded || ""), seeded);
  const seedRow = await pool.query("SELECT value FROM app_settings WHERE key = 'hire_packet_recipient'");
  check("...as a real stored setting, not a default that only exists on the settings screen",
    seedRow.rows.length === 1 && seedRow.rows[0].value === seeded, seedRow.rows[0]);

  const beforeSeeded = await packetMailTo(seeded);
  const first = await completePacketFor(`ZzPacket Notify1 ${stamp}`, `zznotify1${stamp}@example.com`);
  check("a packet finishes with no recipient configured", first.status === 200, first.error);
  check("...and the seeded recipient is told", (await waitForMail(seeded, beforeSeeded)) > beforeSeeded, seeded);

  const configured = `zzhrbox${stamp}@example.com`;
  const setTo = await owner("/api/admin/settings", { method: "PATCH", body: { hire_packet_recipient: configured } });
  check("the recipient can be changed from Admin Settings", setTo.status === 200 && setTo.data.hire_packet_recipient === configured, setTo.data);

  const seededBeforeSecond = await packetMailTo(seeded);
  const second = await completePacketFor(`ZzPacket Notify2 ${stamp}`, `zznotify2${stamp}@example.com`);
  check("the next packet finishes too", second.status === 200, second.error);
  check("...and goes to the configured address", (await waitForMail(configured, 0)) > 0, configured);
  // Read only once the configured address has actually been written to, or
  // this passes for the wrong reason: nothing had been sent to anybody yet.
  check("...and not to the seeded one any more", (await packetMailTo(seeded)) === seededBeforeSecond, seeded);

  const badAddress = await owner("/api/admin/settings", { method: "PATCH", body: { hire_packet_recipient: "not-an-email" } });
  check("a bad address is refused", badAddress.status === 400, badAddress.data);
  const emptied = await owner("/api/admin/settings", { method: "PATCH", body: { hire_packet_recipient: "  " } });
  check("and it cannot be emptied back to nobody", emptied.status === 400 && /reach somebody/i.test(emptied.data.error), emptied.data);
  const stillSet = await owner("/api/admin/settings");
  check("...and the good one neither would have replaced is untouched",
    stillSet.data.hire_packet_recipient === configured, stillSet.data.hire_packet_recipient);

  const alsoTold = `zzhrbox2${stamp}@example.com`;
  await owner("/api/admin/settings", { method: "PATCH", body: { hire_packet_recipient: `${configured}, ${alsoTold}` } });
  const third = await completePacketFor(`ZzPacket Notify3 ${stamp}`, `zznotify3${stamp}@example.com`);
  check("a third packet finishes", third.status === 200, third.error);
  check("everyone on the list is told, not just the first", (await waitForMail(alsoTold, 0)) > 0, alsoTold);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
