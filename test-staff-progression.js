// Staff Progression: the Clinical Director's view of incoming clinicians.
//
// What this suite holds the feature to, in the order it matters:
//
//   * THE HR HUB IS THE ONLY SOURCE. Change a record in the HR Hub and the
//     widget's answer changes, with nothing to resync. No progression status
//     is stored anywhere.
//   * NOTHING CONFIDENTIAL CROSSES OVER. Pay, background-check notes, HR's
//     payer notes -- planted in the records and asserted absent from the
//     payload as raw text, not just as missing keys.
//   * THE WIDGET IS READ-ONLY for the Clinical Director, and HR edits payer
//     enrollment behind the HR Hub's own permission.
//   * PEOPLE LEAVE THE WIDGET when they are active and fully cleared, and only
//     then -- with their HR Hub record and history untouched.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-staff-progression.js
const { Pool } = require("pg");

const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const stamp = Date.now().toString(36);

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 400) : "")); console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");
const q = (sql, p) => pool.query(sql, p || []);
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  const cd = client();
  check("clinical user signs in", (await cd("/api/auth/login", {
    method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  const mkEmp = async (b) => (await owner("/api/hr/employees", { method: "POST", body: b })).data.id;
  const patchEmp = (id, b) => owner(`/api/hr/employees/${id}`, { method: "PATCH", body: b });
  const widget = async (c, qs) => (await (c || owner)("/api/staff-progression" + (qs || ""))).data;
  const find = (d, key) => (d.people || []).find((p) => p.key === key);
  const addPayer = (b) => owner("/api/payer-enrollments", { method: "POST", body: b });

  // ==================================================================
  section("Permission: clinical leadership and HR, nobody else");
  const r0 = await cd("/api/staff-progression");
  check("an ordinary clinical user is refused", r0.status === 403, r0);
  // The Clinical Director is a person designated in the Academy, not a role.
  const cdEmp = await mkEmp({ name: `Dana Director ${stamp}`, email: "clinical@spectrumsquadlv.com", role_title: "Clinical Director" });
  check("the owner designates her Clinical Director",
    (await owner(`/api/academy/leadership/${cdEmp}`, { method: "PUT", body: { leadership: "clinical_director" } })).status === 200);
  const r1 = await cd("/api/staff-progression");
  check("the Clinical Director can see it", r1.status === 200 && r1.data.visible === true, r1);
  check("...and it is read-only for her (no HR permission)", r1.data.can_edit === false, r1.data.can_edit);
  check("owner sees it with the way into the HR Hub", (await widget()).can_edit === true);
  check("on the main dashboard the owner does NOT get it (only the designated director does)",
    (await widget(owner, "?surface=admin")).visible === false);
  check("on the main dashboard the Clinical Director does", (await widget(cd, "?surface=admin")).visible === true);

  // ==================================================================
  section("Who is incoming");
  const bcba = await mkEmp({ name: `Bea BCBA ${stamp}`, role_title: "BCBA", email: `bea${stamp}@x.test` });
  await patchEmp(bcba, { status: "onboarding", hr_stage: "Offer Accepted", hr_hire_date: day(10) });
  const vet = await mkEmp({ name: `Val Veteran ${stamp}`, role_title: "RBT", email: `val${stamp}@x.test` });
  const office = await mkEmp({ name: `Oscar Office ${stamp}`, role_title: "Office Manager" });
  await patchEmp(office, { status: "onboarding" });
  const student = await mkEmp({ name: `Sam Student ${stamp}`, role_title: "Student Analyst" });
  await patchEmp(student, { status: "onboarding", hr_hire_date: day(40) });

  let d = await widget(cd);
  const b1 = find(d, "emp-" + bcba);
  check("an onboarding BCBA is listed", !!b1);
  check("...in the BCBA group", b1 && b1.role_group === "bcba", b1 && b1.role_group);
  check("...with the start date from the HR Hub", b1 && b1.start_date === day(10), b1 && b1.start_date);
  check("...flagged as starting soon (within 14 days, work open)", b1 && b1.flags.approaching === true);
  check("...and nothing recorded with payers is said, not assumed",
    b1 && b1.outstanding.some((o) => /Payer enrollment not started/.test(o.label)), b1 && b1.outstanding);
  check("an established active RBT with no open payer work is NOT listed", !find(d, "emp-" + vet));
  check("a non-clinical hire is NOT listed", !find(d, "emp-" + office));
  check("a Student Analyst is listed in their own group", (find(d, "emp-" + student) || {}).role_group === "student_analyst");
  check("counts cover every role filter", ["all", "bcba", "rbt", "student_analyst", "other"].every((k) => typeof d.counts[k] === "number"), d.counts);

  // ==================================================================
  section("Next action: who, and internal or external");
  check("the next action names an owner and says internal or external",
    b1 && b1.next_action && b1.next_action.owner && ["internal", "external"].includes(b1.next_action.waiting), b1 && b1.next_action);
  const rethinkReq = b1.outstanding.find((o) => /Rethink/.test(o.label));
  check("Rethink set-up is the clinic's job (internal, HR)", rethinkReq && rethinkReq.waiting === "internal" && rethinkReq.owner === "HR", rethinkReq);
  const availReq = b1.outstanding.find((o) => /Availability/.test(o.label));
  check("availability is the new hire's (external)", availReq && availReq.waiting === "external", availReq);

  // ==================================================================
  section("The HR Hub is the source: change it there, the widget follows");
  await patchEmp(bcba, { hr_hire_date: day(30) });
  d = await widget(cd);
  check("moving the start date in the HR Hub moves it here", find(d, "emp-" + bcba).start_date === day(30));
  check("...and it is no longer 'starting soon'", find(d, "emp-" + bcba).flags.approaching === false);
  await patchEmp(bcba, { rethink_id: "R-" + stamp, hr_availability: '{"mon":"9-5"}' });
  d = await widget(cd);
  check("setting up Rethink in the HR Hub clears that requirement",
    !find(d, "emp-" + bcba).outstanding.some((o) => /Rethink/.test(o.label)));
  check("with onboarding done and nothing with payers, the phase is Credentialing",
    find(d, "emp-" + bcba).phase === "credentialing", find(d, "emp-" + bcba).phase);
  const tables = await q(`SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND (table_name ILIKE '%progression%' OR table_name ILIKE 'staff_progress%')`);
  check("no progression status table exists -- it is derived, not stored", tables.rows.length === 0, tables.rows);

  // ==================================================================
  section("Payer enrollment: HR edits it, the director reads it");
  const denied = await cd("/api/payer-enrollments", { method: "POST", body: { employee_id: bcba, payer: "Molina", kind: "credentialing" } });
  check("the Clinical Director cannot add payer enrollment", denied.status === 403, denied);
  const p1 = await addPayer({ employee_id: bcba, payer: "Nevada Medicaid", kind: "group_link", status: "effective", effective_date: day(-1) });
  check("HR adds an effective group link", p1.status === 200, p1);
  const p2 = await addPayer({ employee_id: bcba, payer: "Anthem BCBS", kind: "credentialing", status: "submitted",
    submitted_date: day(-3), notes: "SECRET-PAYER-NOTE-" + stamp });
  check("HR adds a submitted credentialing", p2.status === 200, p2);
  check("a duplicate payer+type is refused",
    (await addPayer({ employee_id: bcba, payer: "anthem bcbs", kind: "credentialing" })).status === 409);
  check("'effective' with no effective date is refused",
    (await addPayer({ employee_id: bcba, payer: "Aetna", kind: "credentialing", status: "effective", effective_date: "" })).status === 400);
  check("a nonsense status is refused",
    (await addPayer({ employee_id: bcba, payer: "Aetna", kind: "credentialing", status: "probably" })).status === 400);

  d = await widget(cd);
  let b2 = find(d, "emp-" + bcba);
  check("one payer effective, one open -> Partial payer clearance", b2.phase === "partial_clearance", b2.phase);
  const anthem = b2.payers.find((p) => p.payer === "Anthem BCBS");
  check("payer rows carry their dates", anthem && anthem.submitted_date === day(-3), anthem);
  check("a submitted payer is an EXTERNAL wait on the payer",
    b2.outstanding.some((o) => /Anthem/.test(o.label) && o.waiting === "external" && o.owner === "Anthem BCBS"), b2.outstanding);

  // An approval whose effective date has arrived is effective without anybody flipping it.
  const pid = p2.data.enrollment.id;
  await owner(`/api/payer-enrollments/${pid}`, { method: "PATCH", body: { status: "approved", approved_date: day(-2), effective_date: day(5) } });
  b2 = find(await widget(cd), "emp-" + bcba);
  check("approved with a future effective date is still open (waiting on the date)",
    b2.payers.find((p) => p.id === pid).status === "approved");
  await owner(`/api/payer-enrollments/${pid}`, { method: "PATCH", body: { effective_date: day(0) } });
  b2 = find(await widget(cd), "emp-" + bcba);
  check("...and effective on the day it arrives", b2.payers.find((p) => p.id === pid).status === "effective");
  check("with every payer cleared but the HR Hub still saying onboarding, the one action left is to mark them active",
    b2.outstanding.length === 1 && /Mark as active/.test(b2.outstanding[0].label), b2.outstanding);

  const act = await q("SELECT hr_activity FROM hr_employees WHERE id = $1", [bcba]);
  check("payer changes are written to the HR Hub activity log",
    /Anthem BCBS credentialing/.test(act.rows[0].hr_activity || ""), (act.rows[0].hr_activity || "").slice(0, 200));

  // ==================================================================
  section("Delays");
  const late = await mkEmp({ name: `Lou Late ${stamp}`, role_title: "Registered Behavior Technician" });
  await patchEmp(late, { status: "active" });
  await addPayer({ employee_id: late, payer: "SilverSummit", kind: "credentialing", status: "pending", submitted_date: day(-60) });
  d = await widget(cd);
  const l1 = find(d, "emp-" + late);
  check("an ACTIVE RBT still waiting on a payer stays on the widget", !!l1);
  check("...in Credentialing", l1 && l1.phase === "credentialing", l1 && l1.phase);
  check("...flagged delayed after 60 days pending", l1 && l1.flags.delayed.some((x) => /pending 60 days/.test(x)), l1 && l1.flags);
  check("...and only payer work counts for somebody already active",
    l1 && l1.outstanding.every((o) => /SilverSummit/.test(o.label)), l1 && l1.outstanding);
  check("delayed people sort first", d.people[0].flags.delayed.length > 0);
  const past = await mkEmp({ name: `Pat Past ${stamp}`, role_title: "RBT" });
  await patchEmp(past, { status: "onboarding", hr_hire_date: day(-3) });
  check("a start date that has passed while still onboarding is a delay",
    find(await widget(cd), "emp-" + past).flags.delayed.some((x) => /has passed/.test(x)));

  // ==================================================================
  section("Leaving the widget when fully onboarded");
  await owner(`/api/payer-enrollments/${(await q("SELECT id FROM hr_payer_enrollments WHERE employee_id=$1", [late])).rows[0].id}`,
    { method: "PATCH", body: { status: "effective", effective_date: day(0) } });
  check("cleared with every payer and active -> gone from the widget", !find(await widget(cd), "emp-" + late));
  await patchEmp(bcba, { status: "active" });
  check("marking the BCBA active in the HR Hub removes her too", !find(await widget(cd), "emp-" + bcba));
  const still = await owner(`/api/hr/employees/${bcba}`);
  check("...while her HR Hub record and history are intact",
    still.status === 200 && /Anthem/.test(still.data.hr_activity || ""), still.status);
  const pe = await owner(`/api/payer-enrollments?employee_id=${bcba}`);
  check("...including her payer enrollment", pe.data.enrollments.length === 2, pe.data.enrollments.length);

  // ==================================================================
  section("Recruitment, from the applicant pipeline");
  const pos = (await q(`INSERT INTO hr_positions (slug, title, role_type, created_at) VALUES ($1,'Registered Behavior Technician','rbt',now()::text) RETURNING id`, ["rbt-" + stamp])).rows[0].id;
  const app = (await q(`INSERT INTO hr_applicants (position_id, full_name, email, stage, updated_at, created_at)
     VALUES ($1,$2,$3,'offer_sent',$4,$4) RETURNING id`, [pos, `Ana Applicant ${stamp}`, `ana${stamp}@x.test`, day(-1)])).rows[0].id;
  await q(`INSERT INTO hr_offers (applicant_id, position_id, job_title, comp_amount, comp_unit, comp_notes, start_date, status, created_at)
     VALUES ($1,$2,'RBT',98765.43,'year','PAYNOTE-${stamp}',$3,'sent',now()::text)`, [app, pos, day(20)]);
  const nonClin = (await q(`INSERT INTO hr_positions (slug, title, role_type, created_at) VALUES ($1,'Billing Specialist','other',now()::text) RETURNING id`, ["bill-" + stamp])).rows[0].id;
  const app2 = (await q(`INSERT INTO hr_applicants (position_id, full_name, stage, updated_at, created_at)
     VALUES ($1,$2,'offer_sent',$3,$3) RETURNING id`, [nonClin, `Bill Biller ${stamp}`, day(-1)])).rows[0].id;
  d = await widget(cd);
  const a1 = find(d, "app-" + app);
  check("a clinical candidate with an offer out is in Recruitment", a1 && a1.phase === "recruitment", a1 && a1.phase);
  check("...waiting externally on the candidate", a1 && a1.next_action.waiting === "external" && a1.next_action.owner === "Candidate", a1 && a1.next_action);
  check("...with the offer's start date", a1 && a1.start_date === day(20));
  check("a non-clinical candidate is not listed", !find(d, "app-" + app2));

  // ==================================================================
  section("Nothing confidential reaches the dashboard");
  await q(`INSERT INTO hr_doc_tracker (employee_id, doc_key, status, notes, stored_name, date_requested, updated_at)
           VALUES ($1,'background_check','Requested','BGC-RESULT-${stamp}','bgc-${stamp}.pdf',$2,now()::text)
           ON CONFLICT (employee_id, doc_key) DO UPDATE SET notes = EXCLUDED.notes`, [past, day(-10)]);
  await addPayer({ employee_id: past, payer: "Molina", kind: "credentialing", status: "not_started", notes: "SECRET-PAYER-NOTE-" + stamp });
  const raw = JSON.stringify(await widget(cd));
  check("no pay amount", !/98765/.test(raw));
  check("no compensation notes or fields", !/PAYNOTE|comp_amount|comp_notes|hourly_rate/.test(raw));
  check("no background check notes or file", !/BGC-RESULT|bgc-/.test(raw));
  check("no HR payer notes", !/SECRET-PAYER-NOTE/.test(raw));
  check("an outstanding background check is NAMED and nothing more",
    (find(JSON.parse(raw), "emp-" + past).outstanding || []).some((o) => o.label === "Background check"));
  const peCd = await cd(`/api/payer-enrollments?employee_id=${past}`);
  check("the director reading payer enrollment directly gets no notes either",
    peCd.status === 200 && !/SECRET-PAYER-NOTE/.test(JSON.stringify(peCd.data)), peCd.status);
  check("...and is told she cannot manage it", peCd.data.can_manage === false);

  // ==================================================================
  section("Nothing on the widget writes");
  for (const m of ["POST", "PATCH", "DELETE"]) {
    const r = await owner("/api/staff-progression", { method: m, body: {} });
    check(`${m} /api/staff-progression is not a route`, r.status === 404 || r.status === 405 || (r.data && !r.data.ok), r.status);
  }

  if (failures.length) console.log("\nFAILURES:\n  " + failures.join("\n  "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch (x) {} process.exit(1); });
