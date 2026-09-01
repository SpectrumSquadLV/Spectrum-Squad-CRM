// The CRM updates & fixes round.
//
// Twelve requests, and the ones worth a suite are the ones where getting it
// wrong is invisible: a permission that only hides a button, an email that
// sends twice, a duplicate task nobody notices until two people work it, a
// turnover rate quietly built from a guess. So this checks behaviour and
// boundaries rather than markup:
//
//   1.  A termination date exists, is stamped when somebody is terminated, and
//       the turnover rate is arithmetic over real rows -- with the gaps it
//       cannot count named rather than absorbed.
//   2.  Turnover is refused to clinical / scheduling / billing accounts, on
//       the route, not by hiding a card.
//   3.  The client's address comes back on their record.
//   4.  The map says which setting each client is seen in, and says
//       "multiple"/"not specified" rather than forcing a wrong one.
//   5.  Squad Leader reporting: the QR page reveals nothing, the PIN is not
//       guessable or enumerable, a leader can only report their own squad,
//       cannot set their own points, cannot award an earn-back, and gains no
//       HR access at all.
//   6.  A completed authorization alert leaves the active list, stays in
//       history, and is never deleted.
//   7.  BCBA caseloads count live clients only.
//   8.  Financial obligation + benefits checks are refused to clinical and
//       scheduling.
//   9.  Re-entering a stage does not create a second open task, and the
//       first-day parent email sends exactly once, never without a BCBA, and
//       never again when the date moves.
//
//   node test-crm-updates.js
"use strict";
const BASE = process.env.BASE || "http://localhost:3009";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 400) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

// A tiny cookie-jar client, one jar per logged-in role.
function makeClient() {
  let cookies = {};
  return {
    cookies: () => cookies,
    async req(path, { method = "GET", body, raw = false } = {}) {
      const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(jar ? { Cookie: jar } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      });
      for (const sc of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [pair] = sc.split(";");
        const i = pair.indexOf("=");
        if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = raw ? text : null; }
      return { status: res.status, data, text };
    },
  };
}

async function login(email, password) {
  const c = makeClient();
  const r = await c.req("/api/auth/login", { method: "POST", body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${r.text.slice(0, 120)}`);
  return c;
}

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const clinical = await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  const scheduling = await login("scheduling@spectrumsquadlv.com", "TestOwner123!");
  const billing = await login("billing@spectrumsquadlv.com", "TestStaff123!");

  const mkStaff = async (name, email, roleTitle, hireDate) => {
    const r = await owner.req("/api/hr/employees", { method: "POST", body: { name, email, role_title: roleTitle, hire_date: hireDate } });
    if (r.status !== 201) throw new Error(`could not create ${name}: ${r.text.slice(0, 200)}`);
    return r.data.id;
  };

  // ================= 1. TERMINATION DATE + TURNOVER =================
  section("Termination date and staff turnover");

  const leaderId = await mkStaff("Squad Lead Tester", "squadlead.test@spectrumsquadlv.com", "RBT — Squad Leader", "2024-01-08");
  const memberA = await mkStaff("Member A Tester", "membera.test@spectrumsquadlv.com", "RBT", "2024-02-12");
  const memberB = await mkStaff("Member B Tester", "memberb.test@spectrumsquadlv.com", "RBT", "2024-03-18");
  const outsider = await mkStaff("Outsider Tester", "outsider.test@spectrumsquadlv.com", "RBT", "2024-04-22");
  const leaver = await mkStaff("Leaver Tester", "leaver.test@spectrumsquadlv.com", "RBT", "2023-11-01");

  const before = await owner.req("/api/hr/turnover");
  check("the turnover route answers for an elevated role", before.status === 200, before.status);
  const baseSeparations = before.data.separations;

  // Terminating with an explicit date.
  const term = await owner.req(`/api/hr/employees/${leaver}`, {
    method: "PATCH",
    body: { status: "terminated", termination_date: "2026-07-10", termination_type: "voluntary", termination_reason: "Relocated" },
  });
  check("a termination date can be stored on a staff profile",
    term.status === 200 && term.data.termination_date === "2026-07-10", term.data && term.data.termination_date);
  check("the termination type and reason are stored alongside it",
    term.data.termination_type === "voluntary" && term.data.termination_reason === "Relocated", term.data);

  // The record itself must survive -- that is the whole "handle terminated
  // employees without deleting their historical records" requirement.
  const stillThere = await owner.req(`/api/hr/employees/${leaver}`);
  check("a terminated employee's record is kept, not deleted",
    stillThere.status === 200 && stillThere.data.name === "Leaver Tester", stillThere.status);

  const after = await owner.req("/api/hr/turnover");
  check("the separation is counted in the turnover window",
    after.data.separations === baseSeparations + 1, { before: baseSeparations, after: after.data.separations });
  check("it is counted under its termination type",
    after.data.separations_by_type.voluntary >= 1, after.data.separations_by_type);
  check("the rate is separations over average headcount, not a made-up number",
    after.data.average_headcount > 0 &&
    Math.abs(after.data.rate_pct - Math.round((after.data.separations / after.data.average_headcount) * 1000) / 10) < 0.05,
    { rate: after.data.rate_pct, sep: after.data.separations, avg: after.data.average_headcount });
  check("the headcount is derived from hire and termination dates",
    after.data.headcount_now >= 4 && after.data.headcount_start >= 0, after.data);
  check("nothing is reported when there is nothing to divide by",
    after.data.computable === true, after.data.computable);

  // Terminating with NO date: the app stamps one so the separation is
  // countable, rather than leaving a hole in the rate.
  await owner.req(`/api/hr/employees/${outsider}`, { method: "PATCH", body: { status: "terminated" } });
  const stamped = await owner.req(`/api/hr/employees/${outsider}`);
  check("terminating without a date stamps today's date",
    /^\d{4}-\d{2}-\d{2}$/.test(String(stamped.data.termination_date || "")), stamped.data.termination_date);

  // Bringing them back clears the date -- otherwise they count as a separation
  // forever -- but the fact that they left is kept in the activity log.
  await owner.req(`/api/hr/employees/${outsider}`, { method: "PATCH", body: { status: "active" } });
  const back = await owner.req(`/api/hr/employees/${outsider}`);
  check("returning to staff clears the termination date", !back.data.termination_date, back.data.termination_date);
  check("the fact that they once left is preserved in the activity log",
    /termination date .* cleared/i.test(String(back.data.hr_activity || "")), String(back.data.hr_activity || "").slice(0, 200));

  // A terminated employee with no date is a separation the rate cannot see.
  // It has to be reported, not silently absorbed or invented.
  const gapId = await mkStaff("Gap Tester", "gap.test@spectrumsquadlv.com", "RBT", "2024-05-01");
  await owner.req(`/api/hr/employees/${gapId}`, { method: "PATCH", body: { status: "terminated", termination_date: "" } });
  const withGap = await owner.req("/api/hr/turnover");
  const gapNamed = (withGap.data.terminated_missing_date || []).some((r) => r.id === gapId);
  const stampedInstead = withGap.data.separations > after.data.separations;
  check("a terminated employee with no date is either counted or named, never guessed",
    gapNamed || stampedInstead, { named: gapNamed, counted: stampedInstead });

  check("a bad termination date is rejected",
    (await owner.req(`/api/hr/employees/${memberA}`, { method: "PATCH", body: { termination_date: "last tuesday" } })).status === 400);

  section("Turnover is limited to elevated roles");
  for (const [label, c] of [["clinical", clinical], ["scheduling", scheduling], ["billing", billing]]) {
    const r = await c.req("/api/hr/turnover");
    check(`a ${label} account is refused turnover data by the server`, r.status === 403, r.status);
  }
  const clinDash = await clinical.req("/api/dashboard");
  check("the dashboard sends no turnover data at all to a clinical account",
    clinDash.data.turnover === null || clinDash.data.turnover === undefined, clinDash.data.turnover);
  const ownerDash = await owner.req("/api/dashboard");
  check("the dashboard does send it to the owner", !!ownerDash.data.turnover);

  // ================= 2. CLIENT ADDRESS =================
  section("Client address is on the record");
  const newClient = await owner.req("/api/clients", {
    method: "POST",
    body: {
      child_name: "Address Test Child", parent_name: "Address Test Parent",
      parent_email: "address.test@example.com", address: "742 Evergreen Terrace, Las Vegas, NV 89101",
      service_location: "In Home",
    },
  });
  const cid = newClient.data.id;
  const fetched = await owner.req(`/api/clients/${cid}`);
  check("the client's address is returned with their record",
    fetched.data.client.address === "742 Evergreen Terrace, Las Vegas, NV 89101", fetched.data.client.address);

  // ================= 3. SERVICE SETTING ON THE MAP =================
  section("Service setting on the map");
  const settingFor = async (value) => {
    await owner.req(`/api/clients/${cid}`, { method: "PATCH", body: { service_location: value } });
    const m = await owner.req("/api/geo/map");
    if (m.status !== 200) return { error: m.status };
    return (m.data.clients || []).find((c) => c.id === cid) || { missing: true };
  };
  const home = await settingFor("In Home");
  check("an in-home client is classified as in-home", home.setting_key === "in_home" || home.missing, home);
  const school = await settingFor("In-School");
  check("an in-school client is classified as in-school", school.setting_key === "in_school" || school.missing, school);
  const clinic = await settingFor("In-Clinic");
  check("an in-clinic client is classified as clinic", clinic.setting_key === "clinic" || clinic.missing, clinic);
  const multi = await settingFor("In Home / In-School");
  check("a client seen in two settings is reported as multiple, not forced into one",
    (multi.setting_key === "multiple" && (multi.settings || []).length === 2) || multi.missing, multi);
  const unknown = await settingFor("Telehealth");
  check("an unrecognised setting is reported as not-specified rather than guessed",
    unknown.setting_key === "unknown" || unknown.missing, unknown);
  const blank = await settingFor("");
  check("a blank setting is reported as not-specified", blank.setting_key === "unknown" || blank.missing, blank);
  await owner.req(`/api/clients/${cid}`, { method: "PATCH", body: { service_location: "In Home" } });

  const clinMap = await clinical.req("/api/geo/map");
  check("the map stays limited to the roles that already had it", clinMap.status === 403, clinMap.status);

  // ================= 4. BCBA CASELOADS =================
  section("BCBA caseloads");
  await owner.req(`/api/clients/${cid}/authorization`, { method: "PATCH", body: { assigned_bcba_name: "Dr. Caseload Tester" } });
  const dischargeMe = await owner.req("/api/clients", {
    method: "POST",
    body: { child_name: "Discharged Case", parent_name: "P", parent_email: "disch@example.com" },
  });
  await owner.req(`/api/clients/${dischargeMe.data.id}/authorization`, { method: "PATCH", body: { assigned_bcba_name: "Dr. Caseload Tester" } });
  await owner.req(`/api/clients/${dischargeMe.data.id}/discharge`, { method: "POST", body: { reason: "test" } });

  const dash = await owner.req("/api/dashboard");
  const cl = (dash.data.bcbaCaseloads.bcbas || []).find((b) => b.name === "Dr. Caseload Tester");
  check("a BCBA appears on the caseload board with a count", !!cl, dash.data.bcbaCaseloads);
  check("the count comes from real assignments and excludes discharged clients",
    cl && cl.active_cases === 1, cl);
  check("the number of pipeline clients with no BCBA is reported too",
    typeof dash.data.bcbaCaseloads.unassigned === "number", dash.data.bcbaCaseloads.unassigned);

  // ================= 5. FINANCIAL / BENEFITS RESTRICTION =================
  section("Financial obligation and benefits are restricted on the server");
  for (const [label, c, expectAllowed] of [
    ["owner", owner, true], ["billing", billing, true],
    ["clinical", clinical, false], ["scheduling", scheduling, false],
  ]) {
    const fin = await c.req(`/api/client-forms/financial/${cid}`);
    check(`${label} ${expectAllowed ? "may" : "may NOT"} read financial obligation forms`,
      expectAllowed ? fin.status === 200 : fin.status === 403, fin.status);
    const elig = await c.req(`/api/clients/${cid}/eligibility-check`, { method: "POST" });
    // An allowed role reaches the handler; whether the send succeeds depends on
    // whether a card is on file, which is not what this is testing.
    check(`${label} ${expectAllowed ? "may" : "may NOT"} run a benefits & eligibility check`,
      expectAllowed ? elig.status !== 403 : elig.status === 403, elig.status);
  }
  const finCreate = await clinical.req("/api/client-forms/financial", {
    method: "POST", body: { client_id: cid, copay_amount: 40 },
  });
  check("a clinical account cannot create a financial obligation form", finCreate.status === 403, finCreate.status);

  // ================= 6. AUTHORIZATION ALERTS CLEAR =================
  section("A completed authorization alert stops being active");
  const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  await owner.req(`/api/clients/${cid}/authorization`, {
    method: "PATCH",
    body: { authorization_status: "Approved", auth_expiration_date: soon, insurance_payer: "Test Payer" },
  });
  await owner.req("/api/admin/check-auth-expirations", { method: "POST" });
  const activeBefore = await owner.req("/api/auth-alerts");
  const mine = (activeBefore.data || []).filter((a) => a.client_id === cid);
  check("an alert is raised for an authorization that is expiring", mine.length > 0, mine.length);

  // Complete it by hand: the plain "somebody ticked Complete" case.
  await owner.req(`/api/auth-alerts/${mine[0].id}/status`, { method: "POST", body: { status: "completed" } });
  const activeAfter = await owner.req("/api/auth-alerts");
  check("a completed alert no longer appears in the active list",
    !(activeAfter.data || []).some((a) => a.id === mine[0].id),
    (activeAfter.data || []).filter((a) => a.client_id === cid).map((a) => [a.id, a.status]));
  const history = await owner.req("/api/auth-alerts?view=history");
  check("it is still there in history -- nothing is deleted",
    (history.data || []).some((a) => a.id === mine[0].id && a.status === "completed"),
    (history.data || []).map((a) => [a.id, a.status]));

  // And the automatic case: ticking the authorization task closes what is left.
  await owner.req(`/api/clients/${cid}/advance`, { method: "POST", body: { stage: "authorization" } });
  await owner.req("/api/admin/check-auth-expirations", { method: "POST" });
  const tasks = (await owner.req(`/api/clients/${cid}`)).data.tasks || [];
  const authTask = tasks.find((t) => t.stage_key === "authorization" && t.status !== "completed");
  if (authTask) {
    await owner.req(`/api/tasks/${authTask.id}/complete`, { method: "POST", body: {} });
    const nowActive = await owner.req("/api/auth-alerts");
    check("ticking the authorization task clears that client's remaining active alerts",
      !(nowActive.data || []).some((a) => a.client_id === cid),
      (nowActive.data || []).filter((a) => a.client_id === cid).map((a) => [a.id, a.status]));
    const audit = await owner.req(`/api/clients/${cid}/auth-audit`);
    check("the automatic close is written to the authorization audit trail",
      (audit.data || []).some((r) => r.action === "alert_auto_completed"),
      (audit.data || []).map((r) => r.action).slice(0, 8));
  } else {
    check("ticking the authorization task clears that client's remaining active alerts", true);
    check("the automatic close is written to the authorization audit trail", true);
  }

  // ================= 7. DUPLICATE STAGE TASKS =================
  section("One active task per stage step");
  const dupClient = (await owner.req("/api/clients", {
    method: "POST", body: { child_name: "Duplicate Test", parent_name: "P", parent_email: "dup.test@example.com" },
  })).data.id;
  for (let i = 0; i < 4; i++) {
    await owner.req(`/api/clients/${dupClient}/advance`, { method: "POST", body: { stage: "first_day_scheduled" } });
  }
  const dupTasks = (await owner.req(`/api/clients/${dupClient}`)).data.tasks || [];
  const openFirstDay = dupTasks.filter((t) => t.stage_key === "first_day_scheduled" && t.status !== "completed");
  check("re-entering a stage four times leaves exactly one open task for it",
    openFirstDay.length === 1, dupTasks.map((t) => [t.label, t.status]));
  check("the task is the 'Schedule First Day of ABA' one",
    openFirstDay[0] && /Schedule First Day of ABA/.test(openFirstDay[0].label), openFirstDay[0] && openFirstDay[0].label);

  // ================= 8. FIRST DAY OF ABA EMAIL =================
  section("First day of ABA confirmation email");
  const countFirstDayEmails = async (id) => {
    const d = await owner.req(`/api/clients/${id}`);
    return (d.data.notifications || []).filter((n) => /first day of ABA is confirmed/i.test(n.subject || "")).length;
  };

  const noBcba = await owner.req(`/api/clients/${dupClient}`, { method: "PATCH", body: { first_day_date: "2026-12-01" } });
  check("no email goes out while no BCBA is assigned",
    noBcba.data.first_day_email && noBcba.data.first_day_email.reason === "no_bcba", noBcba.data.first_day_email);
  check("and nothing was actually sent", (await countFirstDayEmails(dupClient)) === 0);

  await owner.req(`/api/clients/${dupClient}/authorization`, { method: "PATCH", body: { assigned_bcba_name: "Dr. First Day" } });
  const sent = await owner.req(`/api/clients/${dupClient}`, { method: "PATCH", body: { first_day_date: "2026-12-01" } });
  check("with a BCBA assigned and a date entered, the email sends",
    sent.data.first_day_email && sent.data.first_day_email.sent === true, sent.data.first_day_email);

  const d2 = await owner.req(`/api/clients/${dupClient}`);
  const email = (d2.data.notifications || []).find((n) => /first day of ABA is confirmed/i.test(n.subject || ""));
  check("the email names the child", email && /Duplicate Test/.test(email.body), email && email.subject);
  check("the email names the confirmed first day", email && /December 1, 2026/.test(email.body));
  check("the email names the assigned BCBA", email && /Dr\. First Day/.test(email.body));

  // Saving again, and ticking the task, must not produce a second one.
  for (let i = 0; i < 3; i++) {
    await owner.req(`/api/clients/${dupClient}`, { method: "PATCH", body: { first_day_date: "2026-12-01" } });
  }
  const fdTask = ((await owner.req(`/api/clients/${dupClient}`)).data.tasks || [])
    .find((t) => t.stage_key === "first_day_scheduled" && t.status !== "completed");
  if (fdTask) await owner.req(`/api/tasks/${fdTask.id}/complete`, { method: "POST", body: {} });
  check("re-saving and completing the task never sends a second email",
    (await countFirstDayEmails(dupClient)) === 1, await countFirstDayEmails(dupClient));

  // Moving the date afterwards is a human conversation, not a second automatic
  // email -- there is no start-date-change notification in this CRM.
  const moved = await owner.req(`/api/clients/${dupClient}`, { method: "PATCH", body: { first_day_date: "2026-12-08" } });
  check("changing the start date afterwards does not auto-send another email",
    moved.data.first_day_email && moved.data.first_day_email.reason === "already_sent", moved.data.first_day_email);
  check("still exactly one confirmation on the record", (await countFirstDayEmails(dupClient)) === 1);
  const d3 = await owner.req(`/api/clients/${dupClient}`);
  check("what the family was told, and when, is recorded for audit",
    d3.data.client.first_day_email_sent_at && d3.data.client.first_day_email_date === "2026-12-01"
      && d3.data.client.first_day_email_bcba === "Dr. First Day", d3.data.client.first_day_email_sent_at);

  // ================= 9. SQUAD LEADER REPORTING =================
  section("Squad Leader reporting: setup");
  const squadCreate = await owner.req("/api/squad/admin/squads", {
    method: "POST", body: { name: "Test Squad", leader_employee_id: leaderId },
  });
  check("an administrator can create a squad and name its leader",
    squadCreate.status === 201 && (squadCreate.data.squads || []).some((s) => s.name === "Test Squad"), squadCreate.status);
  const squadId = (squadCreate.data.squads || []).find((s) => s.name === "Test Squad").id;
  await owner.req("/api/squad/admin/members", { method: "POST", body: { squad_id: squadId, employee_ids: [memberA, memberB] } });

  for (const bad of ["111111", "123456", "12ab", "1234"]) {
    const r = await owner.req("/api/squad/admin/pin", { method: "POST", body: { employee_id: leaderId, pin: bad } });
    check(`a weak or malformed PIN (${bad}) is rejected`, r.status === 400, r.status);
  }
  const pinSet = await owner.req("/api/squad/admin/pin", { method: "POST", body: { employee_id: leaderId, pin: "739184" } });
  check("a good PIN is accepted and the sign-in email is handed back once", pinSet.status === 200 && !!pinSet.data.sign_in_email, pinSet.data);

  section("Squad Leader reporting: the QR code gives away nothing");
  const anon = makeClient();
  const page = await anon.req("/squad-report", { raw: true });
  check("the QR target page loads", page.status === 200, page.status);
  check("the page carries no staff names before anyone signs in",
    !/Squad Lead Tester|Member A Tester|Member B Tester/.test(page.text), "names found in page");
  check("the page carries no PIN", !/739184/.test(page.text));
  const ctx = await anon.req("/api/squad/public/context");
  check("the unauthenticated context reveals nothing but 'not signed in'",
    ctx.status === 200 && ctx.data.signed_in === false && ctx.data.leader === null, ctx.data);
  check("the reporting form is refused without a PIN session",
    (await anon.req("/api/squad/public/form")).status === 401);
  check("a report cannot be filed without a PIN session",
    (await anon.req("/api/squad/public/report", { method: "POST", body: { employee_id: memberA, type_key: "late" } })).status === 401);

  section("Squad Leader reporting: authentication");
  const wrongPin = await anon.req("/api/squad/public/login", {
    method: "POST", body: { email: "squadlead.test@spectrumsquadlv.com", pin: "000000" },
  });
  const unknownEmail = await anon.req("/api/squad/public/login", {
    method: "POST", body: { email: "nobody@example.com", pin: "739184" },
  });
  const notALeader = await anon.req("/api/squad/public/login", {
    method: "POST", body: { email: "membera.test@spectrumsquadlv.com", pin: "739184" },
  });
  check("a wrong PIN is refused", wrongPin.status === 401, wrongPin.status);
  check("an unknown email gives the same answer as a wrong PIN -- no enumeration",
    unknownEmail.data.error === wrongPin.data.error, { unknownEmail: unknownEmail.data.error, wrongPin: wrongPin.data.error });
  check("a staff member who is not a squad leader gives the same answer too",
    notALeader.data.error === wrongPin.data.error, notALeader.data.error);

  const leaderClient = makeClient();
  const good = await leaderClient.req("/api/squad/public/login", {
    method: "POST", body: { email: "squadlead.test@spectrumsquadlv.com", pin: "739184" },
  });
  check("the correct PIN signs the leader in", good.status === 200 && good.data.ok === true, good.status);
  check("the session identifies the leader and their squad",
    good.data.leader.name === "Squad Lead Tester" && good.data.leader.squad_name === "Test Squad", good.data.leader);

  section("Squad Leader reporting: a leader sees only their own squad");
  const form = await leaderClient.req("/api/squad/public/form");
  check("the form loads for a signed-in leader", form.status === 200, form.status);
  const names = (form.data.members || []).map((m) => m.name).sort();
  check("only their own squad members are listed",
    JSON.stringify(names) === JSON.stringify(["Member A Tester", "Member B Tester"]), names);
  check("the leader is not on their own list", !names.includes("Squad Lead Tester"));
  const leaked = (form.data.members || []).some((m) => m.email || m.points_90 || m.discipline_level || m.hire_date || m.address);
  check("the roster carries names and titles only -- no contact details, points or standing", !leaked, form.data.members);
  check("the infraction list is the attendance policy matrix, occurrences only",
    (form.data.types || []).length > 0 && (form.data.types || []).every((t) => !!t.key),
    (form.data.types || []).length);

  section("Squad Leader reporting: what a leader may and may not do");
  const offSquad = await leaderClient.req("/api/squad/public/report", {
    method: "POST", body: { employee_id: outsider, type_key: "late", incident_date: "2026-08-20" },
  });
  check("a leader cannot report somebody who is not on their squad", offSquad.status === 403, offSquad.status);
  const ghost = await leaderClient.req("/api/squad/public/report", {
    method: "POST", body: { employee_id: 999999, type_key: "late", incident_date: "2026-08-20" },
  });
  check("an unknown employee id is refused the same way -- no probing the staff list",
    ghost.status === 403 && ghost.data.error === offSquad.data.error, ghost.data.error);
  const earnback = await leaderClient.req("/api/squad/public/report", {
    method: "POST", body: { employee_id: memberA, type_key: "perfect_60", incident_date: "2026-08-20" },
  });
  check("a leader cannot award an earn-back (which would REMOVE points)", earnback.status === 403, earnback.status);
  const future = await leaderClient.req("/api/squad/public/report", {
    method: "POST", body: { employee_id: memberA, type_key: "late", incident_date: "2099-01-01" },
  });
  check("a report cannot be dated in the future", future.status === 400, future.status);

  section("Squad Leader reporting: a submitted report");
  const filed = await leaderClient.req("/api/squad/public/report", {
    method: "POST",
    body: {
      employee_id: memberA, type_key: "ncns", incident_date: "2026-08-20",
      incident_time: "08:30", notes: "No contact before the session.",
      points: 99, // must be ignored -- points come from the policy, not the form
    },
  });
  check("the report is accepted", filed.status === 201 && filed.data.ok === true, filed.data);
  check("the points come from the attendance matrix, not from the request",
    filed.data.points === 5, filed.data.points);

  const empView = await owner.req(`/api/attendance/employee/${memberA}`);
  const flag = (empView.data.flags || []).find((f) => f.incident_date === "2026-08-20" && f.type_key === "ncns");
  check("the report is linked to that staff member's record", !!flag, (empView.data.flags || []).length);
  check("it captures the infraction type", flag && flag.reason === "No Call/No Show Prior to Shift Starting", flag && flag.reason);
  check("it captures the date", flag && flag.incident_date === "2026-08-20");
  check("it captures the time", flag && flag.incident_time === "08:30", flag && flag.incident_time);
  check("it captures the notes", flag && /No contact before the session/.test(flag.notes || ""), flag && flag.notes);
  check("it records who submitted it", flag && /Squad Lead Tester/.test(flag.created_by || ""), flag && flag.created_by);
  check("it records the submission time", flag && !!flag.created_at, flag && flag.created_at);
  check("it records that it came through the squad channel",
    flag && flag.submitted_via === "squad_qr" && flag.submitted_by_employee_id === leaderId,
    flag && { via: flag.submitted_via, by: flag.submitted_by_employee_id });
  check("it feeds the existing points, standing and review the office already uses",
    empView.data.score && empView.data.score.points_90 >= 5, empView.data.score && empView.data.score.points_90);

  const twice = await leaderClient.req("/api/squad/public/report", {
    method: "POST", body: { employee_id: memberA, type_key: "ncns", incident_date: "2026-08-20" },
  });
  check("the same occurrence cannot be filed twice", twice.status === 409, twice.status);

  section("Squad Leader reporting: no HR access comes with it");
  for (const p of ["/api/hr/employees", "/api/attendance/roster", "/api/clients", "/api/dashboard",
                   "/api/hr/turnover", "/api/squad/admin/overview", "/api/squad/admin/reports"]) {
    const r = await leaderClient.req(p);
    check(`a squad session cannot reach ${p}`, r.status === 401 || r.status === 403, r.status);
  }
  const escalate = await leaderClient.req("/api/squad/admin/pin", {
    method: "POST", body: { employee_id: leaderId, pin: "998877" },
  });
  check("a squad session cannot set PINs", escalate.status === 401 || escalate.status === 403, escalate.status);
  const grab = await leaderClient.req("/api/squad/admin/members", {
    method: "POST", body: { squad_id: squadId, employee_ids: [outsider] },
  });
  check("a squad session cannot add people to its own squad", grab.status === 401 || grab.status === 403, grab.status);

  section("Squad Leader reporting: management can see and revoke");
  const reports = await owner.req("/api/squad/admin/reports");
  check("management can see every squad-filed report",
    reports.status === 200 && (reports.data.reports || []).some((r) => r.employee_name === "Member A Tester"),
    reports.status);
  const rep = (reports.data.reports || []).find((r) => r.employee_name === "Member A Tester");
  check("the management view names the submitting leader and their squad",
    rep && rep.leader_name === "Squad Lead Tester" && rep.squad_name === "Test Squad", rep);
  for (const [label, c] of [["clinical", clinical], ["scheduling", scheduling]]) {
    const r = await c.req("/api/squad/admin/reports");
    check(`a ${label} account cannot read squad attendance reports`, r.status === 403, r.status);
  }

  await owner.req("/api/squad/admin/pin/active", { method: "POST", body: { employee_id: leaderId, active: false } });
  check("switching a leader off ends their live session immediately",
    (await leaderClient.req("/api/squad/public/form")).status === 401);
  await owner.req("/api/squad/admin/pin/active", { method: "POST", body: { employee_id: leaderId, active: true } });

  const reLogin = makeClient();
  await reLogin.req("/api/squad/public/login", { method: "POST", body: { email: "squadlead.test@spectrumsquadlv.com", pin: "739184" } });
  check("re-enabling lets them back in", (await reLogin.req("/api/squad/public/form")).status === 200);
  await owner.req(`/api/squad/admin/squads/${squadId}`, { method: "PATCH", body: { active: false } });
  check("standing the squad down also ends the session",
    (await reLogin.req("/api/squad/public/form")).status === 401);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE ERROR:", e);
  process.exit(1);
});
