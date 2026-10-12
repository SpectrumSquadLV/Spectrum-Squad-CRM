// The Credentialing Tracker and its daily email, through the API.
//
// What this suite holds the feature to:
//
//   * THE HR HUB IS THE SOURCE. Document and credential progress is read from
//     the HR records; only sign-offs, notes and owners are stored.
//   * PAYER LINKING NEVER BLOCKS INTERNAL APPROVAL, and internal approval never
//     makes anyone "ready" for a payer by itself.
//   * PAYER RULES ARE CONFIGURED, NOT ASSUMED. No rules, no linking: N/A.
//   * THE EMAIL goes only when somebody has incomplete internal onboarding, never
//     for a payer-only issue, never twice in a day, and retries only failures.
//   * PERMISSIONS: HR edits, the Clinical Director reads, owner/admin configure.
//   * NOTHING CONFIDENTIAL CROSSES OVER: pay, document notes and HR's payer
//     notes are planted and asserted absent as raw text.
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
// Pacific dates, the way the tracker counts days.
const pdate = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

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
  // ==================================================================
  section("The 7 AM schedule is Pacific, through daylight saving");
  const mod = require("./staff-progression")({ dbGet: async () => null, dbAll: async () => [], dbRun: async () => {}, nowISO: () => new Date().toISOString(), readBody: async () => ({}), json: () => {} });
  const { isDue, pacific } = mod._internal;
  // 2026: PDT from 8 March (UTC-7), PST from 1 November (UTC-8).
  check("summer: 13:59 UTC is 06:59 PDT -- not yet", !isDue(new Date("2026-07-15T13:59:00Z"), "07:00"));
  check("summer: 14:00 UTC is 07:00 PDT -- due", isDue(new Date("2026-07-15T14:00:00Z"), "07:00"));
  check("winter: 14:00 UTC is 06:00 PST -- not yet", !isDue(new Date("2026-12-15T14:00:00Z"), "07:00"));
  check("winter: 15:00 UTC is 07:00 PST -- due", isDue(new Date("2026-12-15T15:00:00Z"), "07:00"));
  check("the morning DST starts (8 Mar 2026): 14:00 UTC is 07:00 PDT", isDue(new Date("2026-03-08T14:00:00Z"), "07:00") && !isDue(new Date("2026-03-08T13:30:00Z"), "07:00"));
  check("the morning DST ends (1 Nov 2026): 15:00 UTC is 07:00 PST", isDue(new Date("2026-11-01T15:00:00Z"), "07:00") && !isDue(new Date("2026-11-01T14:30:00Z"), "07:00"));
  check("the report day is the Pacific day, not UTC's", pacific(new Date("2026-07-16T03:00:00Z")).date === "2026-07-15");
  check("a configured time is honoured", !isDue(new Date("2026-07-15T14:00:00Z"), "08:30") && isDue(new Date("2026-07-15T15:30:00Z"), "08:30"));

  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  const cd = client();
  check("clinical user signs in", (await cd("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);
  // An HR administrator: the intake account, given the hr_admin role for this run.
  await q("UPDATE users SET role = 'hr_admin' WHERE LOWER(email) = 'intake@spectrumsquadlv.com'");
  const hrc = client();
  check("HR administrator signs in", (await hrc("/api/auth/login", { method: "POST", body: { email: "intake@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  const mkEmp = async (b) => (await owner("/api/hr/employees", { method: "POST", body: b })).data.id;
  const patchEmp = (id, b) => owner(`/api/hr/employees/${id}`, { method: "PATCH", body: b });
  const dash = async (c) => (await (c || owner)("/api/credentialing")).data;
  const person = async (id, c) => (await dash(c)).people.find((p) => p.employee_id === id);
  const ms = (p, k) => p.milestones.find((m) => m.key === k);
  const setMs = (id, key, body, c) => (c || owner)(`/api/credentialing/employees/${id}/milestones/${key}`, { method: "PATCH", body });
  const doc = (emp, key, status, extra) => q(
    `INSERT INTO hr_doc_tracker (employee_id, doc_key, status, date_requested, date_received, notes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now()::text)
     ON CONFLICT (employee_id, doc_key) DO UPDATE SET status = EXCLUDED.status, date_requested = EXCLUDED.date_requested,
       date_received = EXCLUDED.date_received, notes = EXCLUDED.notes`,
    [emp, key, status, (extra && extra.requested) || pdate(-2), status === "Received" || status === "Verified" ? pdate(-1) : null, (extra && extra.notes) || null]);

  // ==================================================================
  section("Permissions: HR edits, the Clinical Director reads, owner/admin configure");
  check("an ordinary clinical user is refused", (await cd("/api/credentialing")).status === 403);
  const cdEmp = await mkEmp({ name: `Dana Director ${stamp}`, email: "clinical@spectrumsquadlv.com", role_title: "Clinical Director" });
  check("the owner designates her Clinical Director",
    (await owner(`/api/academy/leadership/${cdEmp}`, { method: "PUT", body: { leadership: "clinical_director" } })).status === 200);
  const v = await dash(cd);
  check("the Clinical Director can see the dashboard", v && v.visible === true);
  check("...read-only, and no configuration", v.can_edit === false && v.can_configure === false, { e: v.can_edit, c: v.can_configure });
  check("she gets the nav entry", (await cd("/api/nav-order")).data.credentialing_access === true);
  const own = await dash();
  check("owner: edit and configure", own.can_edit === true && own.can_configure === true);
  const hv = await dash(hrc);
  check("HR administrator: edit, but not configure", hv.can_edit === true && hv.can_configure === false);
  check("HR administrator cannot change the email or payer rules",
    (await hrc("/api/credentialing/config", { method: "PUT", body: { email: { time: "06:00" } } })).status === 403
    && (await hrc("/api/credentialing/email/preview")).status === 403);
  check("the Clinical Director cannot send the email", (await cd("/api/credentialing/email/run", { method: "POST", body: {} })).status === 403);

  // ==================================================================
  section("Who is a new hire");
  const rbt = await mkEmp({ name: `Ray RBT ${stamp}`, role_title: "RBT", email: `ray${stamp}@x.test` });
  await patchEmp(rbt, { status: "onboarding", hr_hire_date: pdate(0) });
  const vet = await mkEmp({ name: `Val Veteran ${stamp}`, role_title: "RBT", email: `val${stamp}@x.test` });
  const office = await mkEmp({ name: `Oscar Office ${stamp}`, role_title: "Office Manager" });
  await patchEmp(office, { status: "onboarding", hr_hire_date: pdate(0) });
  let d = await dash();
  check("an onboarding RBT is on the tracker", !!d.people.find((p) => p.employee_id === rbt));
  check("an established active employee is not", !d.people.find((p) => p.employee_id === vet));
  check("administration hires are tracked too", (d.people.find((p) => p.employee_id === office) || {}).position_group === "admin");
  check("HR can add a recent active hire by hand", (await owner("/api/credentialing/track", { method: "POST", body: { employee_id: vet } })).status === 200
    && !!(await person(vet)));
  check("the Clinical Director cannot", (await cd("/api/credentialing/track", { method: "POST", body: { employee_id: office } })).status === 403);

  // ==================================================================
  section("Progress is calculated from the three milestones and the records");
  let p = await person(rbt);
  check("starts 0 of 3", p.milestones_done === 0 && p.progress === 0 && p.milestones_total === 3, p.milestones.map((m) => m.status));
  check("the three milestones, in order", p.milestones.map((m) => m.key).join() === "hr_onboarding,documents,approval",
    p.milestones.map((m) => m.key));
  check("there is no separate verification milestone", !p.milestones.some((m) => /verif/i.test(m.key) || /verif/i.test(m.label)),
    p.milestones.map((m) => m.label));
  check("only final approval needs a sign-off", ms(p, "approval").sign_off_required && !ms(p, "documents").sign_off_required && !ms(p, "hr_onboarding").sign_off_required);
  check("a milestone key that no longer exists is a 404", (await setMs(rbt, "verification", { status: "complete" })).status === 404);
  check("no documents requested is named", ms(p, "documents").missing.includes("No onboarding documents requested yet"));

  // HR onboarding from the records: Rethink id and availability.
  await patchEmp(rbt, { rethink_id: "R-" + stamp, hr_availability: "Mon-Fri" });
  p = await person(rbt);
  check("HR onboarding completes from the records", ms(p, "hr_onboarding").status === "complete" && ms(p, "hr_onboarding").auto_complete, ms(p, "hr_onboarding"));
  check("1 of 3 = 33%", p.milestones_done === 1 && p.progress === 33, { d: p.milestones_done, pr: p.progress });

  await doc(rbt, "headshot", "Received");
  await doc(rbt, "background_check", "Received", { notes: "BGCHECK-SECRET-" + stamp });
  await doc(rbt, "rbt_state", "Requested", { requested: pdate(-10) });
  p = await person(rbt);
  check("documents still open while one is outstanding", ms(p, "documents").status !== "complete");
  check("a document requested 10 days ago needs action", p.status === "action_needed" && p.attention.some((a) => /State RBT license requested 10 days ago/.test(a)), p.attention);
  check("a missing RBT certification is named in the same milestone",
    ms(p, "documents").missing.some((m) => /RBT certification missing or expired/.test(m)), ms(p, "documents").missing);
  check("the missing certification needs action", p.attention.some((a) => /RBT certification missing or expired/.test(a)), p.attention);

  // RECEIVED IS VERIFIED. No second sign-off over documents already on file.
  await doc(rbt, "rbt_state", "Received");
  await doc(rbt, "rbt_national", "Received");
  p = await person(rbt);
  check("documents complete once received, with no verification step",
    ms(p, "documents").status === "complete" && ms(p, "documents").auto_complete, ms(p, "documents"));
  check("nothing asks for the same document to be verified separately",
    !ms(p, "documents").requirements.some((r) => /verified$/i.test(r.label)), ms(p, "documents").requirements.map((r) => r.label));
  check("2 of 3 = 67%, ready for approval", p.milestones_done === 2 && p.progress === 67 && p.attention.includes("Ready for final internal approval"),
    { d: p.milestones_done, pr: p.progress, a: p.attention });
  check("a received document does not need the Verified status to count",
    ms(p, "documents").requirements.every((r) => r.done), ms(p, "documents").missing);

  // ==================================================================
  section("Payer rules are configured, not assumed -- and only by the owner");
  check("no rules: payer linking is N/A", p.payer_progress.label === "N/A" && p.payer_progress.total === 0);
  check("the HR administrator cannot set payer rules",
    (await hrc("/api/credentialing/config", { method: "PUT", body: { payers: [{ payer: "Nevada Medicaid", requires_linking: true }] } })).status === 403);
  // Settings are the owner's alone. An admin runs the CRM; it is not their
  // call which payers need linking or who gets the leadership email.
  const cdRole = (await q("SELECT role FROM users WHERE LOWER(email) = 'clinical@spectrumsquadlv.com'")).rows[0].role;
  await q("UPDATE users SET role = 'admin' WHERE LOWER(email) = 'clinical@spectrumsquadlv.com'");
  const adm = client();
  check("an admin signs in", (await adm("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);
  check("an admin cannot change credentialing settings",
    (await adm("/api/credentialing/config", { method: "PUT", body: { payers: [{ payer: "Aetna", requires_linking: true }] } })).status === 403);
  check("an admin cannot change the daily email",
    (await adm("/api/credentialing/config", { method: "PUT", body: { email: { enabled: false } } })).status === 403);
  check("an admin cannot run or manage the daily email", (await adm("/api/credentialing/email/log")).status === 403);
  check("the admin is told so on their own payload", (await adm("/api/credentialing")).data.can_configure === false);
  check("but the owner still can", (await owner("/api/credentialing")).data.can_configure === true);
  await q("UPDATE users SET role = $1 WHERE LOWER(email) = 'clinical@spectrumsquadlv.com'", [cdRole]);
  const cfg = await owner("/api/credentialing/config", { method: "PUT", body: { payers: [
    { payer: "Nevada Medicaid", requires_linking: true, positions: ["rbt"] },
    { payer: "Aetna", requires_linking: false },
    { payer: "Molina", requires_linking: true, positions: [], caseload_only: true },
  ] } });
  check("owner sets payer rules", cfg.status === 200, cfg.data);
  p = await person(rbt);
  check("the RBT needs Nevada Medicaid linking: 0 of 1", p.payer_progress.total === 1 && p.payer_progress.linked === 0, p.payer_progress);
  check("Aetna, which needs no individual linking, is not listed", !p.payer_linking.some((l) => l.payer === "Aetna"), p.payer_linking.map((l) => l.payer));
  check("Molina is caseload-only and the RBT has no Molina clients", (p.payer_linking.find((l) => l.payer === "Molina") || {}).applicable === false);
  const off = await person(office);
  check("an office hire has no applicable linking: N/A", off.payer_progress.label === "N/A");
  // A Molina client on the RBT's caseload makes Molina apply to them.
  await q(`INSERT INTO clients (child_name, parent_name, stage, insurance_payer, assigned_rbt_name)
           VALUES ($1, 'Parent', 'active_therapy', 'Molina Healthcare', $2)`, [`Kid ${stamp}`, `Ray RBT ${stamp}`]).catch((e) => console.log("  (client insert: " + e.message + ")"));
  p = await person(rbt);
  check("...with a Molina client on the caseload, Molina linking applies", (p.payer_linking.find((l) => l.payer === "Molina") || {}).applicable === true, p.payer_linking);

  // ==================================================================
  section("A payer that needs no individual linking is not tracked at all");
  check("it is not listed on anyone's record", !p.payer_linking.some((l) => l.payer === "Aetna"), p.payer_linking.map((l) => l.payer));
  check("it is not in the per-payer readiness list either", !p.readiness.some((r) => r.payer === "Aetna"), p.readiness.map((r) => r.payer));
  check("the payers that DO require linking are still listed", p.payer_linking.some((l) => l.payer === "Nevada Medicaid") && p.payer_linking.some((l) => l.payer === "Molina"),
    p.payer_linking.map((l) => l.payer));

  // ==================================================================
  section("Confirmed payer linking is part of final internal approval");
  p = await person(rbt);
  const payerReq = ms(p, "approval").requirements.find((r) => r.kind === "payer" && r.payer === "Nevada Medicaid");
  check("approval carries the pending payer link as a requirement",
    payerReq && /Nevada Medicaid linking confirmed/.test(payerReq.label) && !payerReq.done, ms(p, "approval").requirements);
  check("the payer requirement is marked as an outside wait", payerReq && payerReq.waiting === "external", payerReq);

  // One payer, nothing else outstanding: readiness names that payer and
  // nothing else. It does not also say "Internal approval", because the only
  // reason approval is open IS this payer -- that is the same fact twice.
  const solo = await mkEmp({ name: `Sol RBT ${stamp}`, role_title: "RBT", email: `sol${stamp}@x.test` });
  await patchEmp(solo, { status: "onboarding", hr_hire_date: pdate(0) });
  for (const k of ["hr_onboarding", "documents"]) await setMs(solo, k, { status: "complete", notes: "test" });
  await q(`INSERT INTO staff_certifications (employee_id, name, expiration_date, status, created_at) VALUES ($1, 'RBT', $2, 'active', now()::text)`, [solo, pdate(300)]);
  const medSolo = (await person(solo)).readiness.find((r) => r.payer === "Nevada Medicaid");
  check("when only this payer holds approval, readiness says it once, not twice",
    medSolo && medSolo.missing.join("|") === "Nevada Medicaid linking", medSolo);

  // An RBT with documents still outstanding AND linking pending: readiness has
  // two different things to report, and reports both.
  const ray2 = await mkEmp({ name: `Rae RBT ${stamp}`, role_title: "RBT", email: `rae${stamp}@x.test` });
  await patchEmp(ray2, { status: "onboarding", hr_hire_date: pdate(0) });
  const medBoth = (await person(ray2)).readiness.find((r) => r.payer === "Nevada Medicaid");
  check("when something internal is outstanding too, readiness names internal approval as well",
    medBoth && medBoth.missing.includes("Internal approval") && medBoth.missing.includes("Nevada Medicaid linking"), medBoth);

  const blocked = await setMs(rbt, "approval", { status: "complete" }, hrc);
  check("final approval is REFUSED while payer linking is unconfirmed",
    blocked.status === 400 && /Nevada Medicaid/.test(blocked.data.error || ""), blocked.data);
  check("...and the person is still not approved", (await person(rbt)).approved === false);

  // The owner can still approve over an insurer that is sitting on a
  // submission -- but only with a note, and the note is on the record.
  const forced = await setMs(rbt, "approval", { status: "complete", notes: "Medicaid submitted, approving now so she can start on other payers" }, hrc);
  check("approval over an unconfirmed payer goes through WITH a note", forced.status === 200, forced.data);
  p = await person(rbt);
  check("internally approved, 3 of 3", p.approved && p.status === "approved" && p.progress === 100, { pr: p.progress, d: p.milestones_done });
  check("approved hires stay on the dashboard", !!p);
  const hist0 = (await owner(`/api/credentialing/employees/${rbt}`)).data.history;
  check("the override is on the change history", hist0.some((h) => h.milestone_key === "approval" && /complete/.test(h.change) && h.changed_by), hist0);
  const med = p.readiness.find((r) => r.payer === "Nevada Medicaid");
  check("still NOT ready for Medicaid clients", med && !med.ready && med.missing.includes("Nevada Medicaid linking"), med);

  // A BCBA with nothing on file is never ready, approved or not. No payer
  // requires linking for a BCBA here, so nothing external holds the approval.
  const bc = await mkEmp({ name: `Bo BCBA ${stamp}`, role_title: "BCBA", email: `bo${stamp}@x.test` });
  await patchEmp(bc, { status: "onboarding", hr_hire_date: pdate(0) });
  for (const k of ["hr_onboarding", "documents"]) await setMs(bc, k, { status: "complete", notes: "test" });
  const bcAp = await setMs(bc, "approval", { status: "complete" });
  check("a BCBA with no applicable payer linking is approved with no note needed", bcAp.status === 200, bcAp.data);
  let bp = await person(bc);
  check("...and Medicaid (RBT-only linking) does not apply to a BCBA", (bp.payer_linking.find((l) => l.payer === "Nevada Medicaid") || {}).applicable === false);
  check("an approved BCBA with no certification on file is not ready for Medicaid", (bp.readiness.find((r) => r.payer === "Nevada Medicaid") || {}).missing.includes("Current credential on file"), bp.readiness);
  await q(`INSERT INTO staff_certifications (employee_id, name, expiration_date, status, created_at) VALUES ($1, 'BCBA', $2, 'active', now()::text)`, [bc, pdate(300)]);
  bp = await person(bc);
  check("...ready once a current BCBA certification is on file", (bp.readiness.find((r) => r.payer === "Nevada Medicaid") || {}).ready === true, bp.readiness);

  await owner("/api/payer-enrollments", { method: "POST", body: { employee_id: rbt, payer: "Nevada Medicaid", kind: "group_link", status: "submitted", submitted_date: pdate(-3), notes: "PAYERNOTE-" + stamp } });
  p = await person(rbt);
  check("submitted linking shows as Submitted", (p.payer_linking.find((l) => l.payer === "Nevada Medicaid") || {}).state === "submitted");
  const enr = (await owner(`/api/payer-enrollments?employee_id=${rbt}`)).data.enrollments.find((e) => e.payer === "Nevada Medicaid");
  await owner(`/api/payer-enrollments/${enr.id}`, { method: "PATCH", body: { status: "approved", approved_date: pdate(-1), effective_date: pdate(-1) } });
  p = await person(rbt);
  check("linked once confirmed", (p.payer_linking.find((l) => l.payer === "Nevada Medicaid") || {}).state === "linked" && p.payer_progress.linked === 1);
  check("...and only then ready for Medicaid clients", (p.readiness.find((r) => r.payer === "Nevada Medicaid") || {}).ready === true);

  // A clean run: everything internal done and the payer confirmed before the
  // sign-off, so no note is needed.
  const ray4 = await mkEmp({ name: `Roy RBT ${stamp}`, role_title: "RBT", email: `roy${stamp}@x.test` });
  await patchEmp(ray4, { status: "onboarding", hr_hire_date: pdate(0) });
  for (const k of ["hr_onboarding", "documents"]) await setMs(ray4, k, { status: "complete", notes: "test" });
  const r4blocked = await setMs(ray4, "approval", { status: "complete" }, hrc);
  check("an RBT with Medicaid unlinked cannot be approved without a note", r4blocked.status === 400, r4blocked.data);
  await owner("/api/payer-enrollments", { method: "POST", body: { employee_id: ray4, payer: "Nevada Medicaid", kind: "group_link", status: "approved", submitted_date: pdate(-30), approved_date: pdate(-1), effective_date: pdate(-1) } });
  const r4ok = await setMs(ray4, "approval", { status: "complete" }, hrc);
  check("...and is approved with no note once the payer confirms", r4ok.status === 200, r4ok.data);
  check("approval has nothing outstanding", ms(await person(ray4), "approval").missing.length === 0);

  // A link recorded against a payer nobody configured shows on the record but
  // does not hold up a sign-off. Noting an enrolment is not setting a rule.
  const unc = await mkEmp({ name: `Una RBT ${stamp}`, role_title: "RBT", email: `una${stamp}@x.test` });
  await patchEmp(unc, { status: "onboarding", hr_hire_date: pdate(0) });
  for (const k of ["hr_onboarding", "documents"]) await setMs(unc, k, { status: "complete", notes: "test" });
  await owner("/api/payer-enrollments", { method: "POST", body: { employee_id: unc, payer: `Cigna ${stamp}`, kind: "group_link", status: "submitted", submitted_date: pdate(-90) } });
  await owner("/api/payer-enrollments", { method: "POST", body: { employee_id: unc, payer: "Nevada Medicaid", kind: "group_link", status: "approved", submitted_date: pdate(-30), approved_date: pdate(-1), effective_date: pdate(-1) } });
  const up = await person(unc);
  check("an unconfigured payer still shows on the record", (up.payer_linking.find((l) => /^Cigna/.test(l.payer)) || {}).why === "Payer not yet configured", up.payer_linking);
  check("...but it is not one of approval's requirements",
    !ms(up, "approval").requirements.some((r) => r.kind === "payer" && /^Cigna/.test(r.payer || "")), ms(up, "approval").requirements);
  check("...and it is not chased after 90 days either", !up.attention.some((a) => /^Cigna/.test(a)), up.attention);
  const uncAp = await setMs(unc, "approval", { status: "complete" });
  check("...so the sign-off goes through with no note", uncAp.status === 200, uncAp.data);

  // A payer that has sat on a submission past the slow mark is worth chasing.
  const slow = await mkEmp({ name: `Sal RBT ${stamp}`, role_title: "RBT", email: `sal${stamp}@x.test` });
  await patchEmp(slow, { status: "onboarding", hr_hire_date: pdate(0) });
  await owner("/api/payer-enrollments", { method: "POST", body: { employee_id: slow, payer: "Nevada Medicaid", kind: "group_link", status: "submitted", submitted_date: pdate(-60) } });
  const sp = await person(slow);
  check("a payer unconfirmed after 60 days is flagged for chasing",
    sp.attention.some((a) => /Nevada Medicaid linking still unconfirmed after 60 days/.test(a)), sp.attention);
  const quick = await person(ray2);
  check("...but a payer nobody has submitted to yet is not flagged as a chase",
    !quick.attention.some((a) => /still unconfirmed after/.test(a)), quick.attention);

  // ==================================================================
  section("Overdue uses configurable due dates");
  const late = await mkEmp({ name: `Lena Late ${stamp}`, role_title: "BCBA", email: `lena${stamp}@x.test` });
  await patchEmp(late, { status: "onboarding", hr_hire_date: pdate(-40) });
  p = await person(late);
  check("40 days after hire with nothing done is overdue", p.status === "overdue" && ms(p, "hr_onboarding").status === "overdue", p.status);
  await owner("/api/credentialing/config", { method: "PUT", body: { due_days: { hr_onboarding: 60, documents: 60, approval: 60 } } });
  p = await person(late);
  check("with due dates moved to 60 days it is no longer overdue", p.status !== "overdue", p.status);
  check("due days must be sane", (await owner("/api/credentialing/config", { method: "PUT", body: { due_days: { hr_onboarding: -1, documents: 1, approval: 1 } } })).status === 400);
  await setMs(late, "hr_onboarding", { due_date: pdate(-1) }, hrc);
  p = await person(late);
  check("a per-person due date override makes it overdue again", p.status === "overdue" && ms(p, "hr_onboarding").due_overridden);
  await owner("/api/credentialing/config", { method: "PUT", body: { due_days: { hr_onboarding: 7, documents: 21, approval: 30 } } });
  await owner(`/api/credentialing/employees/${late}`, { method: "PATCH", body: { coordinator: "Kim", target_completion_date: pdate(5) } });
  p = await person(late);
  check("coordinator and target date are set by HR", p.coordinator === "Kim" && p.target_completion_date === pdate(5));
  check("the Clinical Director cannot change them", (await cd(`/api/credentialing/employees/${late}`, { method: "PATCH", body: { coordinator: "X" } })).status === 403);

  // ==================================================================
  section("Nothing confidential reaches the dashboard");
  await q("UPDATE hr_employees SET hourly_rate = 77.77 WHERE id = $1", [rbt]).catch(() => {});
  const raw = JSON.stringify((await cd("/api/credentialing")).data) + JSON.stringify((await cd(`/api/credentialing/employees/${rbt}`)).data);
  check("no background-check notes", !raw.includes("BGCHECK-SECRET-" + stamp));
  check("no HR payer notes", !raw.includes("PAYERNOTE-" + stamp));
  check("no pay", !raw.includes("77.77") && !/hourly_rate|comp_amount/.test(raw));
  check("the Clinical Director does not see HR's payer notes on the staff card either",
    !JSON.stringify((await cd(`/api/payer-enrollments?employee_id=${rbt}`)).data).includes("PAYERNOTE-" + stamp));

  // ==================================================================
  section("The daily email");
  const today = pdate(0);
  check("recipients must be real addresses", (await owner("/api/credentialing/config", { method: "PUT", body: { email: { recipients: "not-an-email" } } })).status === 400);
  check("send time must be HH:MM", (await owner("/api/credentialing/config", { method: "PUT", body: { email: { time: "7am" } } })).status === 400);
  await owner("/api/credentialing/config", { method: "PUT", body: { email: { recipients: "lead1@x.test, lead2@x.test", time: "07:00", enabled: true } } });
  const conf = (await owner("/api/credentialing/config")).data.email;
  check("recipients and time are saved", conf.recipients.join() === "lead1@x.test,lead2@x.test" && conf.time === "07:00" && conf.timezone === "America/Los_Angeles", conf);

  const pv = (await owner("/api/credentialing/email/preview")).data;
  check("preview: would send, with the right subject", pv.would_send && pv.subject.startsWith("Spectrum Squad | Daily New Hire Onboarding Status — "), pv.subject);
  check("the pending hire is in it", pv.html.includes(`Lena Late ${stamp}`));
  check("the approved hire is not in the pending list", !/Pending internal onboarding[\s\S]*Ray RBT/.test(pv.html.split("Approved in the last 24 hours")[0]));
  check("the approved hire is listed as recently approved", /Approved in the last 24 hours[\s\S]*Ray RBT/.test(pv.html));
  check("no confidential text in the email", !pv.html.includes("BGCHECK-SECRET-" + stamp) && !pv.html.includes("PAYERNOTE-" + stamp) && !pv.html.includes("77.77"));
  // Final approval's own requirements are "HR Onboarding complete" and
  // "Required Documents & Credentials complete" -- which restate the two rows
  // above them. In the Outstanding column, next to the document somebody is
  // actually missing, that says the same thing twice and reads as a
  // contradiction. The email leaves them out and lists only what is new.
  const pendingTable = pv.html.split("Pending internal onboarding")[1].split("Action required")[0];
  check("the outstanding column never lists a milestone as 'complete'",
    !/complete/i.test(pendingTable), (pendingTable.match(/[^<>]*complete[^<>]*/gi) || []).slice(0, 3));
  check("...it names what is actually missing instead",
    /Availability submitted|onboarding documents|certification/i.test(pendingTable), pendingTable.slice(0, 200));
  check("it links to the dashboard", pv.html.includes("/#/credentialing") && pv.html.includes("View Credentialing Dashboard"));

  const r1 = (await owner("/api/credentialing/email/run", { method: "POST", body: {} })).data;
  check("the report runs and delivers to both recipients", r1.ran && r1.sent === 2, r1);
  const r2 = (await owner("/api/credentialing/email/run", { method: "POST", body: {} })).data;
  check("a second run the same day sends nothing", r2.ran === false && r2.reason === "already_ran_today", r2);
  const rows = (await q("SELECT recipient, status, attempts FROM credentialing_email_log WHERE report_date = $1 AND kind = 'daily' ORDER BY recipient", [today])).rows;
  check("one log row per recipient plus the day's run row", rows.length === 3 && rows.filter((r) => r.recipient !== "*").every((r) => r.attempts === 1), rows);
  const outbox = (await q("SELECT COUNT(*)::int AS n FROM notifications_log WHERE type = 'credentialing_daily' AND recipient IN ('lead1@x.test','lead2@x.test')")).rows[0].n;
  check("exactly two emails went out", outbox === 2, outbox);
  // A failed delivery is retried; a delivered one is not.
  await q("UPDATE credentialing_email_log SET status = 'failed', error = 'provider 500' WHERE report_date = $1 AND kind = 'daily' AND recipient = 'lead2@x.test'", [today]);
  const rt = (await owner("/api/credentialing/email/retry", { method: "POST", body: {} })).data;
  check("retry resends only the failed recipient", rt.retried && rt.retried.length === 1 && rt.retried[0].to === "lead2@x.test", rt);
  const after = (await q("SELECT recipient, status, attempts FROM credentialing_email_log WHERE report_date = $1 AND kind = 'daily' AND recipient <> '*' ORDER BY recipient", [today])).rows;
  check("lead1 untouched (1 attempt), lead2 retried (2 attempts)", after[0].attempts === 1 && after[1].attempts === 2 && after[1].status !== "failed", after);
  const rt2 = (await owner("/api/credentialing/email/retry", { method: "POST", body: {} })).data;
  check("a second retry sends nothing", rt2.retried.length === 0);
  check("three emails in total, never a duplicate report", (await q("SELECT COUNT(*)::int AS n FROM notifications_log WHERE type = 'credentialing_daily'")).rows[0].n === 3);
  check("the log is readable by owner/admin", (await owner("/api/credentialing/email/log")).data.log.length >= 3);

  // ---- payer-only: the email DOES report it now ---------------------------
  // Internal onboarding finished for everyone. One person is held by nothing
  // but Medicaid linking -- which is now part of approval, so they are still
  // pending and the email still has something to say. It used to go quiet
  // here, which was the point of keeping linking out of approval.
  const everyone = [late, office, solo, ray2, ray4, slow];
  for (const id of everyone) {
    for (const k of ["hr_onboarding", "documents"]) await setMs(id, k, { status: "complete", notes: "test" });
    await setMs(id, "approval", { status: "complete", notes: "test" });
  }
  for (const k of ["hr_onboarding", "documents"]) await setMs(vet, k, { status: "complete", notes: "test" });
  await owner("/api/payer-enrollments", { method: "POST", body: { employee_id: vet, payer: "Nevada Medicaid", kind: "group_link", status: "pending", submitted_date: pdate(-2) } });
  d = await dash();
  const vetRow = d.people.find((x) => x.employee_id === vet);
  check("everyone whose linking is settled is internally approved",
    d.people.filter((x) => x.employee_id !== vet).every((x) => x.approved), d.people.filter((x) => !x.approved).map((x) => x.name));
  check("the one held only by Medicaid linking is NOT approved", vetRow && vetRow.approved === false, vetRow && vetRow.status);
  check("...and the hold is named as the payer link, not as paperwork",
    ms(vetRow, "approval").missing.length === 1 && /^Nevada Medicaid linking confirmed \(pending, 2 days waiting\)$/.test(ms(vetRow, "approval").missing[0]),
    ms(vetRow, "approval").missing);
  check("...their internal milestones are both complete", ms(vetRow, "hr_onboarding").status === "complete" && ms(vetRow, "documents").status === "complete");
  await q("DELETE FROM credentialing_email_log WHERE report_date = $1", [today]);
  const pv2 = (await owner("/api/credentialing/email/preview")).data;
  check("preview says the email WOULD be sent for a payer-only hold", pv2.would_send === true, pv2.reason);
  check("...and the email puts them under payer linking",
    /Waiting on insurance payer linking/.test(pv2.html) && pv2.html.includes(`Val Veteran ${stamp}`), /Waiting on insurance payer linking/.test(pv2.html));
  check("...and no longer has a credential-verification section", !/credential verification/i.test(pv2.html));
  const r3 = (await owner("/api/credentialing/email/run", { method: "POST", body: {} })).data;
  check("a payer-only hold sends the email", r3.ran && r3.status !== "skipped" && r3.sent > 0, r3);

  // With the payer confirmed, there is nobody pending and the email goes quiet.
  const vetEnr = (await owner(`/api/payer-enrollments?employee_id=${vet}`)).data.enrollments.find((e) => e.payer === "Nevada Medicaid");
  await owner(`/api/payer-enrollments/${vetEnr.id}`, { method: "PATCH", body: { status: "approved", approved_date: pdate(-1), effective_date: pdate(-1) } });
  const vetAp = await setMs(vet, "approval", { status: "complete" });
  check("once the payer confirms, approval needs no note", vetAp.status === 200, vetAp.data);
  check("everyone is internally approved", (await dash()).people.every((x) => x.approved), (await dash()).people.filter((x) => !x.approved).map((x) => x.name));
  await q("DELETE FROM credentialing_email_log WHERE report_date = $1", [today]);
  const pv3 = (await owner("/api/credentialing/email/preview")).data;
  check("preview says no email would be sent when nobody is pending", pv3.would_send === false);
  const r4 = (await owner("/api/credentialing/email/run", { method: "POST", body: {} })).data;
  check("nobody pending: no email", r4.ran && r4.status === "skipped" && r4.sent === 0, r4);
  check("the skip is logged", (await q("SELECT status FROM credentialing_email_log WHERE report_date = $1 AND recipient = '*'", [today])).rows[0].status === "skipped");

  // ---- the scheduled sweep honours the switch and the claim ----------------
  await owner("/api/credentialing/config", { method: "PUT", body: { email: { enabled: false } } });
  const conf2 = (await owner("/api/credentialing/config")).data.email;
  check("the email can be switched off", conf2.enabled === false);
  await owner("/api/credentialing/config", { method: "PUT", body: { email: { enabled: true, recipients: "" } } });
  const conf3 = (await owner("/api/credentialing/config")).data.email;
  check("blank recipients fall back to the Clinical Director", conf3.effective_recipients.includes("clinical@spectrumsquadlv.com") && conf3.recipient_source === "clinical_leadership", conf3);

  // ---- a test email is separate from the daily report ----------------------
  const te = (await owner("/api/credentialing/email/test", { method: "POST", body: { to: "tester@x.test" } })).data;
  check("a test email can be sent any time", te.ok && te.to === "tester@x.test", te);
  check("...and is logged as a test, not as the day's report", (await q("SELECT COUNT(*)::int AS n FROM credentialing_email_log WHERE kind = 'test'")).rows[0].n === 1);

  // ==================================================================
  section("Existing records are untouched");
  const emp = (await q("SELECT status, role_title FROM hr_employees WHERE id = $1", [rbt])).rows[0];
  check("internal approval does not change the HR Hub status", emp.status === "onboarding", emp);
  const act = (await q("SELECT hr_activity FROM hr_employees WHERE id = $1", [rbt])).rows[0].hr_activity || "";
  check("milestone changes land in the employee's activity history", /Credentialing — Final Internal Approval/.test(act), act.slice(0, 300));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch (x) {} process.exit(1); });
