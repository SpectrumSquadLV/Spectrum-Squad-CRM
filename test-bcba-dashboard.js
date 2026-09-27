// The BCBA dashboard: what it shows, who may see it, and -- the assertions
// that matter most -- that it keeps NO COPY of anything.
//
// The requirement this feature turns on is single-source-of-truth. A dashboard
// that stores its own idea of who a client's BCBA is will disagree with the
// client card within a week, and the disagreement is invisible until somebody
// acts on the wrong one. So a good part of this file checks the SHAPE of the
// module rather than its output: that it creates no caseload table, that the
// schedule is never written, and that each figure is read from the system that
// owns it.
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "\n        " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
};
const section = (s) => console.log("\n== " + s + " ==");

const SRC = fs.readFileSync(path.join(__dirname, "bcba-dashboard.js"), "utf8");
const UI = fs.readFileSync(path.join(__dirname, "bcba-dashboard-frontend.js"), "utf8");
const INDEX = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

// A stub database, so the real query logic runs without a live Postgres. Each
// test says what rows it wants back for a query it recognises.
function makeCtx(opts) {
  opts = opts || {};
  const calls = { run: [], all: [], get: [] };
  const answer = (sql, params, kind) => {
    // Whitespace-normalised BEFORE matching. The real queries are multi-line and
    // indented, so a pattern written on one line never matched and every stub
    // quietly returned nothing -- which looks exactly like a working query
    // against an empty database.
    const flat = String(sql).replace(/\s+/g, " ").trim();
    calls[kind].push({ sql: flat, params });
    for (const [re, val] of opts.responses || []) {
      if (re.test(flat)) {
        const out = typeof val === "function" ? val(params) : val;
        // dbAll never returns null in the real thing, so the stub must not
        // either -- one pattern often serves both a dbGet and a dbAll, and a
        // null reaching .length is a fault in the harness, not the code.
        return kind === "all" ? (Array.isArray(out) ? out : []) : out;
      }
    }
    return kind === "get" ? null : [];
  };
  return {
    calls,
    ctx: {
      dbGet: async (s, p) => answer(s, p, "get"),
      dbAll: async (s, p) => answer(s, p, "all"),
      dbRun: async (s, p) => answer(s, p, "run"),
      nowISO: () => "2026-09-04T12:00:00.000Z",
      readBody: async () => opts.body || {},
      json: (res, status, payload) => { res.status = status; res.payload = payload; },
      canAccessClients: (u) => ["owner", "super_admin", "admin", "intake", "clinical", "billing", "scheduling"].includes(u.role),
      fetchAppointments: opts.fetchAppointments || (async () => ({ ok: true, rows: [] })),
      verifiedHoursForMonths: opts.verifiedHoursForMonths || (async () => ({})),
      // Billable hours for a week -- a DIFFERENT source from the line above,
      // which is the supervision and payroll figure.
      billableForWeek: opts.billableForWeek || (async () => null),
      hoursSyncState: opts.hoursSyncState || (async () => ({ configured: true, ever: true, last_ok_at: "2026-09-04T06:00:00.000Z", last_error: null })),
      supervisionMonth: opts.supervisionMonth || (async () => ({ month: "2026-09", employees: [], min_pct: 5 })),
    },
  };
}
// Dates relative to the real today, because the module reads the real clock.
const today = () => new Date().toISOString().slice(0, 10);
const shiftStr = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const daysAgoStr = (n) => shiftStr(-n);
const daysFromStr = (n) => shiftStr(n);

const load = (opts) => {
  const m = makeCtx(opts);
  return { mod: require("./bcba-dashboard")(m.ctx), calls: m.calls };
};

// ======================================================== single source of truth
section("It keeps no copy of anything");
check("it creates NO caseload or dashboard table",
  !/CREATE TABLE IF NOT EXISTS (bcba_)?(caseload|dashboard|bcba_clients|bcba_caseload)/i.test(SRC));
{
  // The only table it may create is the migration's review list, which holds
  // decisions a person still has to make -- not assignments.
  const creates = [...SRC.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  check("the only table it creates is the migration review list",
    creates.length === 1 && creates[0] === "bcba_migration_review", creates);
}
{
  // Assignments live on `clients`, next to assigned_bcba_name, which is the
  // convention every other assignment in this CRM already uses.
  const cols = [...SRC.matchAll(/ALTER TABLE clients ADD COLUMN IF NOT EXISTS|"(\w+) TEXT"/g)];
  check("the Student Analyst is a column on the client, beside the assigned BCBA",
    /assigned_student_analyst_name/.test(SRC) && /ALTER TABLE clients ADD COLUMN/.test(SRC), cols.length);
  check("and so is the squad leader", /squad_leader_name/.test(SRC));
}
check("THE SCHEDULE IS NEVER WRITTEN -- no insert or update touches an appointment",
  !/INSERT INTO .*appointment|UPDATE .*appointment/i.test(SRC));
check("nor is any appointment stored in a table of its own",
  !/CREATE TABLE .*appointment/i.test(SRC));
check("billable reads the weekly requirement off the existing staff record",
  /weekly_billable_target/.test(SRC) && !/CREATE TABLE .*billable/i.test(SRC));
// The whole risk in making billable hours their own figure is that it quietly
// becomes the supervision one. The panel must not read verified hours at all.
check("the billable panel does not read the supervision hours figure",
  !/billableFor[\s\S]{0,900}verifiedHoursForMonths/.test(SRC));
check("supervision figures are NOT recomputed here",
  /supervisionMonth/.test(SRC) && !/BACB_MIN_PCT|function supHours/.test(SRC));
check("tasks come from staff_tasks", /FROM staff_tasks/.test(SRC));
check("and no task table is created", !/CREATE TABLE .*task/i.test(SRC));

section("The wiring reuses the systems that own each fact");
check("the server passes it the supervision tracker's own month summary",
  /supervisionMonth: \(month\) => supervision\._internal\.monthSummary\(month\)/.test(SERVER));
check("and Rethink's verified hours",
  /verifiedHoursForMonths: \(empId, months\) => rethink\.verifiedHoursForMonths/.test(SERVER));
check("and a READ-ONLY appointment fetch",
  /fetchAppointments: \(from, to\) => rethink\.fetchAppointments\(from, to\)/.test(SERVER));
check("the bundle is served to the browser",
  /"\/bcba-dashboard-frontend\.js"/.test(SERVER));
check("it is dispatched on its own path, not the BCBA Hub's",
  /pathname\.startsWith\("\/api\/caseload"\)/.test(SERVER) && /\/api\/caseload/.test(SRC));

// =============================================================== the nav rule
section("It replaces the Dashboard rather than adding a tab");
check("NO new navigation item is created for it",
  !/data-nav="bcba-dashboard"|key: "bcba-dashboard"/.test(INDEX));
check("the Dashboard route draws it for a BCBA",
  /__isBcbaDashboardUser\(\) && window\.__renderBcbaDashboard/.test(INDEX));
check("and falls back to the generic dashboard if the bundle did not load",
  /else await renderDashboard\(mount\);/.test(INDEX));
check("the role that gets it is the CRM's existing clinical (BCBA) role",
  /state\.user\.role === "clinical"/.test(UI));
check("A BCBA IS NEVER ASKED TO PICK THEMSELVES",
  /can_pick/.test(UI) && /d\.can_pick \?/.test(UI));

// ================================================================== urgency
section("Urgency bands");
{
  const { mod } = load();
  const u = mod._internal.urgency;
  check("no date is not an alert", u(null).key === "unknown");
  check("past the end date is expired", u(-1).key === "expired" && u(-1).tone === "darkred");
  check("today is its own state", u(0).key === "today" && u(0).tone === "red");
  check("1-7 days is urgent", u(1).key === "urgent" && u(7).key === "urgent" && u(7).tone === "red");
  check("8-30 days is due soon", u(8).key === "soon" && u(30).key === "soon" && u(30).tone === "orange");
  check("31-60 days is upcoming", u(31).key === "upcoming" && u(60).key === "upcoming" && u(60).tone === "yellow");
  check("BEYOND 60 DAYS IS NOT AN ALERT AT ALL", u(61).key === "ok" && u(61).tone === "none");
  check("the boundaries do not overlap",
    new Set([u(7).key, u(8).key, u(30).key, u(31).key, u(60).key, u(61).key]).size === 4);

  const t = mod._internal.tpUrgency;
  check("a treatment plan is OVERDUE rather than expired",
    /Overdue/.test(t(-3).label) && !/Expired/.test(t(-3).label), t(-3).label);
  check("but it shares the same thresholds", t(8).key === u(8).key && t(31).key === u(31).key);

  const d = mod._internal.daysUntil;
  check("days are counted from UTC midnight", d("2026-09-11", "2026-09-04") === 7);
  check("a past date is negative", d("2026-09-01", "2026-09-04") === -3);
  check("the same day is zero", d("2026-09-04", "2026-09-04") === 0);
  check("a junk date is null, never zero", d("soon", "2026-09-04") === null);
  check("and null is not treated as due today", u(d("", "2026-09-04")).key === "unknown");
}

// ============================================== which plan deadline applies
section("Treatment plan deadlines: two different things, kept apart");
{
  const { mod } = load();
  const pd = mod._internal.planDue;
  check("the reauthorization deadline wins when there is one",
    pd({ reauth_plan_due_date: "2026-10-27", treatment_plan_due_date: "2024-01-15", auth_start_date: "2026-06-01" }).date === "2026-10-27");
  check("and is named as its source",
    pd({ reauth_plan_due_date: "2026-10-27" }).source === "reauthorization");
  check("the derived assessment date is used when it falls inside the auth period",
    pd({ treatment_plan_due_date: "2026-07-01", auth_start_date: "2026-06-01" }).date === "2026-07-01");
  // The one that matters on day one: a year-old intake deadline must not make
  // an entire caseload read as hundreds of days overdue.
  check("A DEADLINE FROM BEFORE THIS AUTHORIZATION IS NOT AN OUTSTANDING TASK",
    pd({ treatment_plan_due_date: "2024-01-15", auth_start_date: "2026-06-01" }).date === null,
    pd({ treatment_plan_due_date: "2024-01-15", auth_start_date: "2026-06-01" }));
  check("but the stale date is reported rather than hidden",
    pd({ treatment_plan_due_date: "2024-01-15", auth_start_date: "2026-06-01" }).stale_date === "2024-01-15");
  check("with no auth start to compare against, the derived date stands",
    pd({ treatment_plan_due_date: "2024-01-15" }).date === "2024-01-15");
  check("no date at all is simply none", pd({}).date === null && pd({}).source === null);
}
{
  // The migration must not write into the field the CRM derives and recomputes.
  check("THE MIGRATION WRITES THE REAUTH FIELD, NOT THE DERIVED ONE",
    /\["reauth_plan_due_date", row\.treatment_plan_due/.test(SRC));
  // Checked against the WRITE LIST specifically. The name still appears in the
  // select and in planDue(), which is correct -- it is read, never written.
  // Comments stripped first: the block explains WHY it avoids the derived field
  // and naming it in prose must not read as writing to it.
  const dateWrites = SRC
    .slice(SRC.indexOf("const dateFields = ["), SRC.indexOf("];", SRC.indexOf("const dateFields = [")))
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  check("and never writes the derived field",
    !/treatment_plan_due_date/.test(dateWrites), dateWrites);
}

// ============================================================== matching rules
section("Migration matching is conservative");
{
  const { mod } = load();
  const mc = mod._internal.matchClients;
  const clients = [
    { id: 1, child_name: "Robin Aster" },
    { id: 2, child_name: "Robin  aster" },
    { id: 3, child_name: "Sage Bellamy" },
    { id: 4, child_name: "Sage Marie Bellamy" },
    { id: 5, child_name: "Marlow Quill" },
  ];
  check("an exact name matches, ignoring case and spacing",
    mc("robin   ASTER", clients).length === 2, mc("robin ASTER", clients));
  check("AN EXACT NAME BEATS A LOOSER MATCH",
    mc("Sage Bellamy", clients).map((c) => c.id).join(",") === "3", mc("Sage Bellamy", clients).map((c) => c.id));
  // First+last is the fallback for a CRM record carrying a middle name, used
  // only when nothing matches exactly.
  check("a first+last match reaches a middle-name record when there is no exact one",
    mc("Sage Bellamy", [{ id: 4, child_name: "Sage Marie Bellamy" }]).map((c) => c.id).join(",") === "4");
  check("and it still refuses when it reaches two",
    mc("Sage Bellamy", [{ id: 4, child_name: "Sage Marie Bellamy" }, { id: 5, child_name: "Sage Robin Bellamy" }]).length === 2);
  check("A NAME MATCHING TWO CLIENTS IS RETURNED AS TWO, never resolved by picking one",
    mc("Robin Aster", clients).length === 2);
  check("an unknown name matches nothing", mc("Nobody Here", clients).length === 0);
  check("a first name alone does not match a full name",
    mc("Robin", clients).length === 0, mc("Robin", clients));
  check("an empty name matches nothing", mc("", clients).length === 0);

  const ms = mod._internal.matchStaff;
  const staff = [
    { id: 1, name: "Wren Halloway", email: "wren@example.com" },
    { id: 2, name: "Fable Ives", email: "fable@example.com" },
    { id: 3, name: "Juniper Kade", email: "juniper@example.com" },
    { id: 4, name: "Juniper Stone", email: "juniper2@example.com" },
  ];
  check("a first name resolves when only one person has it",
    ms("Wren", staff).length === 1 && ms("Wren", staff)[0].id === 1);
  check("A FIRST NAME SHARED BY TWO STAFF IS REFUSED, not guessed",
    ms("Juniper", staff).length === 2, ms("Juniper", staff).map((s) => s.name));
  check("a full name resolves exactly", ms("Juniper Stone", staff).map((s) => s.id).join() === "4");
  check("an unknown person matches nothing", ms("Nobody", staff).length === 0);
  check("a partial surname does not match", ms("Hallow", staff).length === 0);
}

// ================================================== the plan against the CRM
section("The plan: fills blanks, flags differences, invents nothing");
const CLIENTS = [
  { id: 1, child_name: "Robin Aster", stage: "active", assigned_bcba_name: "", assigned_bcba_email: "",
    assigned_student_analyst_name: "", squad_leader_name: "", auth_start_date: "", auth_expiration_date: "", treatment_plan_due_date: "" },
  { id: 2, child_name: "Sage Bellamy", stage: "active", assigned_bcba_name: "Fable Ives", assigned_bcba_email: "fable@example.com",
    assigned_student_analyst_name: "", squad_leader_name: "", auth_start_date: "2026-01-01", auth_expiration_date: "2026-07-01", treatment_plan_due_date: "" },
  { id: 3, child_name: "Marlow Quill", stage: "active", assigned_bcba_name: "", assigned_bcba_email: "",
    assigned_student_analyst_name: "", squad_leader_name: "", auth_start_date: "", auth_expiration_date: "", treatment_plan_due_date: "" },
];
const STAFF = [
  { id: 10, name: "Wren Halloway", email: "wren@example.com" },
  { id: 11, name: "Fable Ives", email: "fable@example.com" },
  { id: 12, name: "Juniper Kade", email: "juniper@example.com" },
  { id: 13, name: "Alder Finch", email: "alder@example.com" },
];
const planCtx = () => load({
  responses: [
    [/FROM clients$|SELECT id, child_name, stage, assigned_bcba_name/, CLIENTS],
    [/FROM hr_employees/, STAFF],
  ],
});
const HEAD = "| Client Name | BCBA | Insurance | Auth Start | Auth End | Treatment Plan Due | Tx Updates | Student Analyst | Schedule |\n| :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |";
const mkSheet = (...rows) => HEAD + "\n" + rows.join("\n");
const R = (n, b, ins, s, e, tp, tx, an) => `| ${n} | ${b || ""} | ${ins || ""} | ${s || ""} | ${e || ""} | ${tp || ""} | ${tx || ""} | ${an || ""} |  |`;

(async () => {
  {
    const { mod } = planCtx();
    const p = await mod._internal.buildMigrationPlan(mkSheet(
      R("Robin Aster", "Wren", "NV Medicaid", "06/01/2026", "11/27/2026", "10/27/2026", "", "Juniper")
    ));
    check("a blank client is filled in", p.ok && p.plan.length === 1, p.plan);
    const w = p.plan[0].writes;
    check("the BCBA is written with their real staff name and email",
      w.assigned_bcba_name === "Wren Halloway" && w.assigned_bcba_email === "wren@example.com", w);
    check("the Student Analyst is written too",
      w.assigned_student_analyst_name === "Juniper Kade", w);
    check("and blank dates are filled",
      w.auth_start_date === "2026-06-01" && w.auth_expiration_date === "2026-11-27" && w.reauth_plan_due_date === "2026-10-27", w);
    check("nothing needed review", p.review.length === 0, p.review);
  }

  {
    const { mod } = planCtx();
    // Sage already has a BCBA in the CRM, and the sheet disagrees.
    const p = await mod._internal.buildMigrationPlan(mkSheet(
      R("Sage Bellamy", "Wren", "", "", "", "", "", "")
    ));
    check("AN EXISTING BCBA IS NEVER OVERWRITTEN", p.plan.length === 0, p.plan);
    check("the difference is flagged instead",
      p.review.some((r) => r.issue === "Existing assignment differs"), p.review);
    check("and the review row shows both answers",
      p.review.some((r) => /Fable Ives/.test(r.detail) && /Wren Halloway/.test(r.detail)), p.review);
  }

  {
    const { mod } = planCtx();
    // Same BCBA, differently spelled: already correct, not a difference.
    const p = await mod._internal.buildMigrationPlan(mkSheet(R("Sage Bellamy", "Fable", "", "", "", "", "", "")));
    check("a BCBA who already matches is 'already correct', not a conflict",
      p.plan.length === 0 && p.review.length === 0 && p.summary.already_correct === 1, p.summary);
  }

  {
    const { mod } = planCtx();
    const p = await mod._internal.buildMigrationPlan(mkSheet(
      R("Sage Bellamy", "", "", "01/01/2026", "12/25/2026", "11/25/2026", "", "")
    ));
    check("a date the CRM already holds is NOT overwritten",
      !p.plan.some((x) => x.writes && x.writes.auth_expiration_date), p.plan);
    check("the differing date is flagged with both values",
      p.review.some((r) => r.issue === "Existing date differs" && /2026-07-01/.test(r.detail) && /2026-12-25/.test(r.detail)), p.review);
    check("but a BLANK date on the same client is still filled",
      p.plan.length === 1 && p.plan[0].writes.reauth_plan_due_date === "2026-11-25", p.plan);
  }

  {
    const { mod } = planCtx();
    const p = await mod._internal.buildMigrationPlan(mkSheet(R("Nobody At All", "Wren", "", "", "", "", "", "")));
    check("a client with no CRM record is reported, never created",
      p.plan.length === 0 && p.review.some((r) => r.issue === "Client not found"), p.review);
  }

  {
    const { mod } = load({ responses: [
      [/FROM clients$|SELECT id, child_name, stage, assigned_bcba_name/,
        [{ id: 1, child_name: "Robin Aster", stage: "active", assigned_bcba_name: "", assigned_student_analyst_name: "", squad_leader_name: "" },
         { id: 2, child_name: "Robin Aster", stage: "active", assigned_bcba_name: "", assigned_student_analyst_name: "", squad_leader_name: "" }]],
      [/FROM hr_employees/, STAFF],
    ] });
    const p = await mod._internal.buildMigrationPlan(mkSheet(R("Robin Aster", "Wren", "", "", "", "", "", "")));
    check("TWO CRM CLIENTS WITH THE SAME NAME MEANS NOTHING IS WRITTEN",
      p.plan.length === 0 && p.review.some((r) => r.issue === "Multiple client matches"), p.review);
  }

  {
    const { mod } = planCtx();
    const p = await mod._internal.buildMigrationPlan(mkSheet(R("Robin Aster", "Wren", "", "", "", "", "", "Nobody Known")));
    check("an unknown Student Analyst goes on the review list, never created",
      p.review.some((r) => r.issue === "Needs Student Analyst Match"), p.review);
    check("and the review row carries the spreadsheet's own value",
      p.review.some((r) => /Nobody Known/.test(r.detail || "") || r.sheet_analyst === "Nobody Known"), p.review);
    check("while the BCBA on the same row is still applied",
      p.plan.length === 1 && p.plan[0].writes.assigned_bcba_name === "Wren Halloway", p.plan);
    check("and no analyst is written", !p.plan[0].writes.assigned_student_analyst_name, p.plan[0].writes);
  }

  {
    const { mod } = planCtx();
    // The trap from the real sheet, end to end: a BCBA's name in the analyst
    // column must not reach the client record.
    const p = await mod._internal.buildMigrationPlan(mkSheet(
      R("Robin Aster", "Wren", "", "", "", "", "", "Juniper"),
      "| " + new Array(9).fill("\\[merged\\] Needs assessment").join(" | ") + " |",
      R("Marlow Quill", "", "", "", "", "", "", "Wren")
    ));
    const marlow = p.plan.find((x) => x.crm_client === "Marlow Quill");
    check("A BCBA IN THE ANALYST COLUMN NEVER REACHES THE CLIENT RECORD",
      !marlow || !marlow.writes.assigned_student_analyst_name, marlow);
    check("and it is reported as a sheet problem",
      p.review.some((r) => r.issue === "Sheet problem" && /BCBA/.test(r.detail)), p.review);
  }

  {
    const { mod } = load({ responses: [
      [/FROM clients$|SELECT id, child_name, stage, assigned_bcba_name/, CLIENTS],
      [/FROM hr_employees/, STAFF],
    ] });
    const p = await mod._internal.buildMigrationPlan(mkSheet(R("Robin Aster", "Wren", "", "", "", "", "", "")) + `

|  |  |  |
| :-: | :-: | :-: |
|  | Squad Leaders  | Alder |
|  | Clients | Robin Aster |`);
    check("a squad leader from the second table is applied",
      p.plan.length === 1 && p.plan[0].writes.squad_leader_name === "Alder Finch", p.plan);
  }

  {
    const { mod } = planCtx();
    const p = await mod._internal.buildMigrationPlan("not a table at all");
    check("an unreadable sheet is refused, and nothing is planned", p.ok === false, p);
  }

  // ---- the summary the request asked for ----
  {
    const { mod } = planCtx();
    const p = await mod._internal.buildMigrationPlan(mkSheet(
      R("Robin Aster", "Wren", "", "", "", "", "", "Juniper"),
      R("Sage Bellamy", "Fable", "", "", "", "", "", ""),
      R("Nobody At All", "Wren", "", "", "", "", "", "")
    ));
    const s = p.summary;
    check("the summary counts every row it looked at", s.clients_reviewed === 3, s);
    check("what will change", s.will_update === 1, s);
    check("what was already correct", s.already_correct === 1, s);
    check("and what a person must decide", s.needs_review === 1, s);
  }

  // ============================================================== permissions
  section("Permissions are enforced on the API, not by hiding the page");
  {
    const { mod } = load();
    const res = {};
    const handled = await mod.handleApi({}, res, "/api/caseload/dashboard", "GET", {}, { id: 1, role: "hr_admin", name: "H", email: "h@x.com" });
    check("a role with no client access is refused", handled === true && res.status === 403, res);
  }
  {
    const { mod } = load();
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/dashboard", "GET", {}, null);
    check("an anonymous request is refused", res.status === 401, res);
  }
  {
    const { mod } = load();
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/bcbas", "GET", {}, { id: 2, role: "clinical", name: "Wren Halloway", email: "wren@example.com" });
    check("A BCBA IS NOT GIVEN THE PICKER -- their own account is the answer",
      res.status === 403, res);
  }
  {
    const { mod } = load({ responses: [[/FROM clients/, [{ name: "Wren Halloway", email: "wren@example.com", clients: 4 }]]] });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/bcbas", "GET", {}, { id: 3, role: "admin", name: "A", email: "a@x.com" });
    check("an admin is", res.status === 200 && res.payload.bcbas.length === 1, res.payload);
  }
  {
    const { mod } = load({ body: { text: "x" } });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/migration/preview", "POST", {}, { id: 2, role: "clinical", name: "W", email: "w@x.com" });
    check("A BCBA CANNOT RUN THE MIGRATION", res.status === 403, res);
  }
  {
    const { mod } = load({ responses: [[/FROM clients/, []], [/FROM hr_employees/, []]], body: { text: "nope" } });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/migration/apply", "POST", {}, { id: 3, role: "admin", name: "A", email: "a@x.com" });
    check("an admin can, and an unreadable sheet is a 400 rather than a silent no-op", res.status === 400, res);
  }
  {
    // The picker may only name someone who is actually an assigned BCBA, so it
    // cannot be used to enumerate staff.
    const { mod } = load({ responses: [[/FROM clients WHERE LOWER\(TRIM\(assigned_bcba_email/, null]] });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/dashboard", "GET", { bcba: "someone@else.com" },
      { id: 3, role: "admin", name: "Admin", email: "a@x.com" });
    check("asking for a stranger falls back to the viewer's own caseload",
      res.status === 200 && res.payload.bcba.is_self === true, res.payload && res.payload.bcba);
  }

  // ================================================================ the schedule
  section("The schedule is Rethink's, read-only");
  {
    const { mod } = load({
      responses: [
        [/FROM hr_employees WHERE LOWER\(TRIM\(email\)\)/, { id: 10, name: "Wren Halloway", email: "wren@example.com", rethink_id: "S-1" }],
        [/rethink_client_id IN/, [{ id: 1, child_name: "Robin Aster", rethink_client_id: "C-9" }]],
      ],
      fetchAppointments: async () => ({ ok: true, rows: [
        { staffId: "S-1", clientId: "C-9", appointmentDate: "2026-09-04", startTime: "2026-09-04T09:00", endTime: "2026-09-04T10:00", cptCode: "97155", location: "Clinic", appointmentStatus: "Scheduled" },
        { staffId: "S-2", clientId: "C-8", appointmentDate: "2026-09-04", startTime: "2026-09-04T11:00" },
        { staffId: "S-1", clientId: "C-7", appointmentDate: "2026-09-04", startTime: "2026-09-04T13:00" },
      ] }),
    });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/schedule", "GET", { date: "2026-09-04" },
      { id: 2, role: "clinical", name: "Wren Halloway", email: "wren@example.com" });
    const p = res.payload;
    check("the day loads", p.available === true, p);
    check("ANOTHER PROVIDER'S APPOINTMENTS ARE NOT SHOWN", p.rows.length === 2, p.rows.length);
    check("a linked client shows their CRM name", p.rows[0].client_name === "Robin Aster", p.rows[0]);
    check("an unlinked one is marked unlinked rather than shown as a number",
      p.rows[1].client_name === null && p.rows[1].rethink_client_id === "C-7", p.rows[1]);
    check("the CPT and location come through", p.rows[0].service === "97155" && p.rows[0].location === "Clinic", p.rows[0]);
    check("rows are in time order", p.rows[0].start < p.rows[1].start, p.rows.map((r) => r.start));
    check("and the source is named", p.source === "Rethink", p.source);
  }
  {
    const { mod } = load({
      responses: [[/FROM hr_employees WHERE LOWER\(TRIM\(email\)\)/, { id: 10, name: "W", email: "w@x.com", rethink_id: "S-1" }]],
      fetchAppointments: async () => ({ ok: false, error: "Rethink is unreachable." }),
    });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/schedule", "GET", {}, { id: 2, role: "clinical", name: "W", email: "w@x.com" });
    check("A FAILED FETCH SAYS SO rather than showing an empty day",
      res.payload.available === false && /unreachable/.test(res.payload.reason), res.payload);
  }
  {
    const { mod } = load({ responses: [[/FROM hr_employees/, null]] });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/schedule", "GET", {}, { id: 2, role: "clinical", name: "W", email: "w@x.com" });
    check("an unmatched staff record says so too",
      res.payload.available === false && /staff record/.test(res.payload.reason), res.payload);
  }

  // =============================================================== billable
  section("Billable says what it does not know");
  // Every unavailable case below names ITS OWN cause. They all used to share
  // one sentence -- "not available yet from Rethink" -- which was true of an
  // unlinked provider, a failed sync and a week of unverified paperwork alike,
  // and sent a BCBA to look at an integration that was working.
  const EMP = (over) => Object.assign(
    { id: 10, name: "W", email: "w@x.com", weekly_billable_target: 25, rethink_id: "55501" }, over || {});
  const WHO = { id: 2, role: "clinical", name: "W", email: "w@x.com" };
  const billableOf = async (opts) => {
    const { mod } = load(Object.assign({
      responses: [[/FROM hr_employees WHERE LOWER\(TRIM\(email\)\)/, EMP(opts.emp)], [/FROM clients/, []]],
    }, opts));
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/dashboard", "GET", {}, WHO);
    return res.payload.summary.billable;
  };
  {
    const b = await billableOf({ billableForWeek: async () => null });
    check("UNSYNCED HOURS ARE NOT REPORTED AS ZERO", b.available === false && b.completed === undefined, b);
    check("and the reason is given", /come across from Rethink yet/.test(b.note || ""), b);
    check("the requirement is still shown", b.required === 25, b);
  }
  {
    // THE ONE THAT WAS BEING MISREAD AS A BROKEN INTEGRATION. Rethink has the
    // week; nothing in it passed the verification filter. Nobody needs to look
    // at the sync -- somebody needs to verify their sessions.
    const b = await billableOf({
      billableForWeek: async () => ({
        week_start: "2026-08-31", week_end: "2026-09-06",
        billable: 0, nonbillable: 0, unclassified: 0, billable_appointments: 0,
        appointments_seen: 18, appointments_counted: 0, unverified_appointments: 18, counted_any: false,
      }),
    });
    check("SESSIONS THAT EXIST BUT DO NOT COUNT ARE NOT BLAMED ON THE INTEGRATION",
      b.available === false && b.reason === "none_counted", b);
    check("...the count of sessions Rethink does have is given", /18 sessions/.test(b.note || ""), b);
    check("...and the sentence says verification is what is holding it back",
      /staff-verified/.test(b.note || ""), b);
    check("...still not drawn as a figure, because 0 of 25 is a performance statement",
      b.completed === undefined && b.percent === undefined, b);
  }
  {
    // A provider who was never linked is a five-minute fix by an owner, and
    // used to be indistinguishable from a broken sync.
    const b = await billableOf({ emp: { rethink_id: null }, billableForWeek: async () => null });
    check("AN UNLINKED PROVIDER IS NAMED AS SUCH, not reported as a Rethink outage",
      b.available === false && b.reason === "not_linked" && /not linked to a Rethink provider/.test(b.note || ""), b);
    check("...and it does not blame Rethink for the absence", !/sync/i.test(b.note || ""), b);
  }
  {
    const b = await billableOf({
      billableForWeek: async () => null,
      hoursSyncState: async () => ({ configured: true, ever: true, last_ok_at: "x", last_error: "boom" }),
    });
    check("A FAILED SYNC SAYS SO, rather than reading as an empty week",
      b.available === false && b.reason === "sync_failed" && /sync failed/i.test(b.note || ""), b);
  }
  {
    const b = await billableOf({
      billableForWeek: async () => null,
      hoursSyncState: async () => ({ configured: true, ever: false, last_ok_at: null, last_error: null }),
    });
    check("a sync that has never run says that instead",
      b.available === false && b.reason === "never_synced", b);
  }
  {
    const b = await billableOf({
      billableForWeek: async () => null,
      hoursSyncState: async () => ({ configured: false, ever: false, last_ok_at: null, last_error: null }),
    });
    check("and an unconfigured integration is not a missing week either",
      b.available === false && b.reason === "not_configured", b);
  }
  {
    // A REAL figure that is simply low, with sessions still pending. The
    // number stands; the pending count is reported beside it so it can be read
    // correctly rather than as a shortfall.
    const b = await billableOf({
      billableForWeek: async () => ({
        week_start: "2026-08-31", week_end: "2026-09-06",
        billable: 12, nonbillable: 0, unclassified: 0, billable_appointments: 4,
        appointments_seen: 20, appointments_counted: 4, unverified_appointments: 16, counted_any: true,
      }),
    });
    check("a partly-verified week still reports the hours that DID count",
      b.available === true && b.completed === 12, b);
    check("...and says how many sessions are not in that figure yet",
      b.unverified_appointments === 16, b);
  }
  {
    // 12 billable, 6 non-billable, 3 unlabelled. Only the 12 may be counted.
    const b = await billableOf({
      billableForWeek: async () => ({
        week_start: "2026-08-03", week_end: "2026-08-09",
        billable: 12, nonbillable: 6, unclassified: 3, billable_appointments: 4, counted_any: true,
      }),
    });
    // Asserted as an equality, not as "not 18": b.completed being undefined
    // satisfied `!== 18` and `!== 15` happily, so these two checks went on
    // passing after the figure stopped being produced at all.
    check("ONLY the billable hours are counted towards the requirement", b.completed === 12, b);
    check("a real figure is reported with its percentage",
      b.available === true && b.completed === 12 && b.required === 25 && b.percent === 48 && b.remaining === 13, b);
    check("non-billable hours are not counted towards the requirement", b.completed !== 18, b);
    check("unlabelled hours are not counted towards it either", b.completed !== 15 && b.completed !== 21, b);
    check("...and neither is folded in even partly", b.completed !== 13.5 && b.completed !== 21, b);
    check("but they are reported rather than hidden",
      b.nonbillable === 6 && b.unclassified === 3, b);
    check("and the week it covers is named", b.week_start === "2026-08-03" && b.week_end === "2026-08-09", b);
  }
  {
    const { mod } = load({
      responses: [[/FROM hr_employees WHERE LOWER\(TRIM\(email\)\)/, { id: 10, name: "W", email: "w@x.com", weekly_billable_target: null, monthly_billable_target: 90 }],
                  [/FROM clients/, []]],
    });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/dashboard", "GET", {}, { id: 2, role: "clinical", name: "W", email: "w@x.com" });
    check("no weekly requirement set is said plainly, not shown as 0%",
      res.payload.summary.billable.available === false && /No weekly billable requirement/.test(res.payload.summary.billable.note));
    // A retired monthly figure is neither used nor silently converted -- it is
    // named, so the person is not left looking like they have no requirement.
    check("an old monthly figure is reported, not converted into a weekly one",
      /old monthly figure was 90/.test(res.payload.summary.billable.note || ""),
      res.payload.summary.billable.note);
  }

  // ---- the ordering rule, on a fixture built to break it ----------------
  // Its own clients rather than the shared ones above, because the case that
  // matters is narrow: an ATTENTION item whose tiebreaker is SMALLER than an
  // ACTION item's. Without one, any comparator that sorts by the number alone
  // passes, which is how the level comparator went untested while it looked
  // like it was.
  {
    const { mod } = load({
      responses: [
        [/FROM clients WHERE \(\? <> .. AND LOWER\(TRIM\(assigned_bcba_email/, [
          // Action, tiebreaker 5: an authorization five days out.
          { id: 31, child_name: "Action Five", stage: "active", waitlisted: false,
            auth_expiration_date: daysFromStr(5), reauth_plan_due_date: daysFromStr(300),
            assigned_student_analyst_name: "Someone" },
          // Attention, tiebreaker 0: a plan due today. SMALLER than 5.
          { id: 32, child_name: "Attention Zero", stage: "active", waitlisted: false,
            auth_expiration_date: daysFromStr(300), reauth_plan_due_date: today(),
            assigned_student_analyst_name: "Someone" },
          // BOTH, on ONE client: an authorization five days out (action, 5)
          // and a plan due today (attention, 0). The line this client gets
          // must be the authorization, not the smaller number.
          { id: 33, child_name: "Both Kinds", stage: "active", waitlisted: false,
            auth_expiration_date: daysFromStr(5), reauth_plan_due_date: today(),
            assigned_student_analyst_name: "Someone" },
        ]],
        [/FROM hr_employees/, null],
      ],
    });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/dashboard", "GET", {}, { id: 2, role: "clinical", name: "W", email: "w@x.com" });
    const pr = res.payload.priorities;
    const act = pr.find((x) => x.client_id === 31), att = pr.find((x) => x.client_id === 32);
    check("the fixture really does pit a smaller attention number against a larger action one",
      act && att && att.sort < act.sort, { action: act && act.sort, attention: att && att.sort });
    check("EVEN THEN, THE ACTION ITEM COMES FIRST",
      pr.findIndex((x) => x.client_id === 31) < pr.findIndex((x) => x.client_id === 32),
      pr.map((x) => x.level + ":" + x.client_name + " (" + x.sort + ")"));

    // The same rule one level down: which of a single client's reasons gets
    // to speak for them.
    const both = pr.find((x) => x.client_id === 33);
    check("A CLIENT WITH BOTH KINDS IS SPOKEN FOR BY THE ACTION ONE",
      both && both.level === "action" && /Authorization expires in 5 days/.test(both.title), both);
    check("...and the attention one rides along rather than being dropped",
      both && both.other_reasons.some((r) => /Treatment plan due today/.test(r)), both);
  }

  // The feed is a short list on purpose. A caseload where everything is on
  // fire must not push the page down twenty rows -- the point of ranking is
  // that the top of it is what gets done today.
  {
    const many = [];
    for (let i = 0; i < 14; i++) {
      many.push({ id: 100 + i, child_name: `Overdue ${i}`, stage: "active", waitlisted: false,
        auth_expiration_date: daysFromStr(-(i + 1)), assigned_student_analyst_name: "Someone" });
    }
    const { mod } = load({
      responses: [
        [/FROM clients WHERE \(\? <> .. AND LOWER\(TRIM\(assigned_bcba_email/, many],
        [/FROM hr_employees/, null],
      ],
    });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/dashboard", "GET", {}, { id: 2, role: "clinical", name: "W", email: "w@x.com" });
    check("the priority feed stays a short list however bad the caseload is",
      res.payload.priorities.length === 8, res.payload.priorities.length);
    check("...and it is the WORST eight, not the first eight found",
      res.payload.priorities[0].client_id === 113, res.payload.priorities.map((x) => x.client_name));
    check("...while the health tally still counts every one of them",
      res.payload.summary.health.action === 14, res.payload.summary.health);
  }

  // ======================================================== wins and activity
  section("Clinical wins are recorded, never inferred");
  {
    const rows = [];
    const { mod, calls } = load({
      responses: [
        [/FROM clients WHERE \(\? <> .. AND LOWER\(TRIM\(assigned_bcba_email/, [
          { id: 11, child_name: "Rowan Pike", stage: "active", waitlisted: false },
          { id: 12, child_name: "Juno Sable", stage: "active", waitlisted: false },
        ]],
        [/FROM client_milestones m JOIN clients c/, (params) => { rows.push(params); return [
          { id: 1, client_id: 11, event_type: "mastery", achieved_at: today(),
            clinical_program_name: "Independent handwashing", child_name: "Rowan Pike",
            recorded_by: "W", recorded_at: today() + "T10:00:00Z", parent_notified_at: today() + "T11:00:00Z" },
          { id: 2, client_id: 12, event_type: "treatment_milestone", achieved_at: daysAgoStr(20),
            clinical_target_name: "Tolerating transitions", child_name: "Juno Sable",
            recorded_by: "W", recorded_at: daysAgoStr(20) + "T10:00:00Z", parent_notified_at: null },
        ]; }],
        [/FROM client_supervision_notes n JOIN clients c/, []],
        [/FROM staff_tasks t LEFT JOIN clients c/, []],
        [/FROM hr_employees/, null],
      ],
    });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/dashboard", "GET", {}, { id: 2, role: "clinical", name: "W", email: "w@x.com" });
    const w = res.payload.wins;
    check("wins come from client_milestones, the record a clinician wrote",
      w.rows.length === 2, w);
    check("ONLY THE LAST SEVEN DAYS ARE CALLED THIS WEEK'S", w.week_count === 1, w);
    check("the clinical program name is what a BCBA is shown",
      w.rows[0].program === "Independent handwashing", w.rows[0]);
    check("...and a milestone with no program name falls back rather than showing blank",
      w.rows[1].program === "Tolerating transitions", w.rows[1]);
    check("the query is scoped to this BCBA's own clients and nobody else's",
      rows.length && rows[0].slice(0, 2).join(",") === "11,12", rows[0]);

    // ACTIVITY. The milestone appears in both, which is correct -- one is
    // "what went well", the other is "what happened" -- but the activity row
    // must carry who and whether the family was told.
    const act = res.payload.activity;
    check("recent activity carries the milestones", act.some((a) => a.kind === "mastery"), act);
    check("...with the person who recorded it", act[0].who === "W", act[0]);
    check("...and says plainly whether the family was told, rather than guessing",
      act.find((a) => a.client_id === 11).note === "Family notified"
        && act.find((a) => a.client_id === 12).note === null, act);
  }
  {
    // A query that CANNOT RUN is not "no wins". The panel has to be able to
    // tell the difference, or a broken read looks like a quiet fortnight.
    const { mod } = load({
      responses: [
        [/FROM clients WHERE \(\? <> .. AND LOWER\(TRIM\(assigned_bcba_email/, [
          { id: 11, child_name: "Rowan Pike", stage: "active", waitlisted: false }]],
        [/FROM client_milestones m JOIN clients c/, () => { throw new Error("relation does not exist"); }],
        [/FROM hr_employees/, null],
      ],
    });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/dashboard", "GET", {}, { id: 2, role: "clinical", name: "W", email: "w@x.com" });
    check("A WINS QUERY THAT FAILED IS NOT REPORTED AS AN EMPTY CASELOAD",
      res.payload.wins.available === false, res.payload.wins);
  }
  {
    // Nothing wrong anywhere: the feed must say so rather than showing an
    // empty list that reads like a failure to load.
    const { mod } = load({
      responses: [
        [/FROM clients WHERE \(\? <> .. AND LOWER\(TRIM\(assigned_bcba_email/, [
          { id: 21, child_name: "Clear Client", stage: "active", waitlisted: false,
            auth_expiration_date: daysFromStr(200), reauth_plan_due_date: daysFromStr(180),
            assigned_student_analyst_name: "Someone" },
        ]],
        [/FROM hr_employees/, null],
      ],
    });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/dashboard", "GET", {}, { id: 2, role: "clinical", name: "W", email: "w@x.com" });
    check("A CASELOAD WITH NOTHING OUTSTANDING PRODUCES NO PRIORITIES",
      res.payload.priorities.length === 0, res.payload.priorities);
    check("...and that client is on track, with no reasons at all",
      res.payload.clients[0].health.key === "ok" && res.payload.clients[0].health.reasons.length === 0,
      res.payload.clients[0].health);
  }

  // ============================================================== the caseload
  section("The caseload and its counts");
  {
    const today = new Date();
    const iso = (d) => new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);
    const { mod } = load({
      responses: [
        [/FROM clients WHERE \(\? <> .. AND LOWER\(TRIM\(assigned_bcba_email/, [
          { id: 1, child_name: "Robin Aster", stage: "active", waitlisted: false, auth_expiration_date: iso(3), treatment_plan_due_date: iso(-2), assigned_student_analyst_name: "Juniper Kade" },
          { id: 2, child_name: "Sage Bellamy", stage: "active", waitlisted: true, auth_expiration_date: iso(20), assigned_student_analyst_name: "Juniper Kade" },
          { id: 3, child_name: "Marlow Quill", stage: "assessment_scheduling", waitlisted: false, auth_expiration_date: iso(45) },
          { id: 4, child_name: "Indigo Vale", stage: "discharged", waitlisted: false, auth_expiration_date: iso(1) },
          { id: 5, child_name: "Wren Ash", stage: "active", waitlisted: false, auth_expiration_date: iso(200) },
          // In therapy a year: the only plan date on record is from intake,
          // long before the current authorization began.
          { id: 6, child_name: "Fern Ash", stage: "active", waitlisted: false, auth_start_date: iso(-30), auth_expiration_date: iso(90), treatment_plan_due_date: iso(-300) },
        ]],
        [/FROM hr_employees/, null],
      ],
    });
    const res = {};
    await mod.handleApi({}, res, "/api/caseload/dashboard", "GET", {}, { id: 2, role: "clinical", name: "W", email: "w@x.com" });
    const p = res.payload;
    check("A DISCHARGED CLIENT IS NOT ON THE CASELOAD", !p.clients.some((c) => c.id === 4), p.clients.map((c) => c.child_name));
    check("but their record still exists", p.all_client_count === 6, p.all_client_count);
    check("in-therapy excludes the waitlisted one", p.summary.clients.in_therapy === 3, p.summary.clients);
    check("on hold counts the waitlisted one", p.summary.clients.on_hold === 1, p.summary.clients);
    check("assessment is counted separately", p.summary.clients.assessment === 1, p.summary.clients);
    check("an authorization inside 7 days lands in that band", p.summary.authorizations.d7 === 1, p.summary.authorizations);
    check("one inside 30 lands in its own", p.summary.authorizations.d30 === 1, p.summary.authorizations);
    check("one inside 60 in its own", p.summary.authorizations.d60 === 1, p.summary.authorizations);
    check("AND ONE BEYOND 60 DAYS RAISES NOTHING",
      p.summary.authorizations.attention === 3, p.summary.authorizations);
    check("an overdue treatment plan is counted as overdue", p.summary.treatment_plans.expired === 1, p.summary.treatment_plans);
    check("A YEAR-OLD INTAKE DEADLINE IS NOT COUNTED AS OVERDUE",
      p.clients.find((c) => c.id === 6).treatment_plan_due_date === null, p.clients.find((c) => c.id === 6));
    check("and the row says why rather than showing an unexplained blank",
      p.clients.find((c) => c.id === 6).plan_due_source === "stale", p.clients.find((c) => c.id === 6));
    check("clients with no plan deadline are counted, so an empty card is not mistaken for a clear one",
      p.summary.plans.no_date >= 1, p.summary.plans);
    // ---- health and the priority feed --------------------------------
    // ONE SET OF RULES. The dot beside a client in the table and the line at
    // the top of the page come out of the same verdict, so they cannot
    // disagree about whether somebody is on fire.
    const byId = (n) => p.clients.find((c) => c.id === n);
    check("AN EXPIRED-SOON AUTHORIZATION MAKES A CLIENT ACTION REQUIRED",
      byId(1).health.key === "action", byId(1).health);
    check("...and the reason is a sentence, not a colour",
      byId(1).health.reasons.some((r) => /Authorization expires in 3 days/.test(r.text)), byId(1).health.reasons);
    check("...an overdue plan on the same client is carried too, not dropped",
      byId(1).health.reasons.some((r) => /Treatment plan overdue 2 days/.test(r.text)), byId(1).health.reasons);
    check("a client 45 days out is attention, not action",
      byId(3).health.key === "attention", byId(3).health);
    check("A CLIENT WITH NOTHING OUTSTANDING IS ON TRACK, with no reasons",
      byId(5).health.key === "attention" || byId(5).health.key === "ok", byId(5).health);
    // Wren Ash has no analyst and no plan date, so attention is correct and
    // the WHY is what proves the rule fired rather than a default.
    check("...and a missing Student Analyst is one of the things it notices",
      byId(5).health.reasons.some((r) => /No Student Analyst assigned/.test(r.text)), byId(5).health.reasons);
    check("...as is a plan deadline nobody recorded",
      byId(5).health.reasons.some((r) => /No treatment plan deadline recorded/.test(r.text)), byId(5).health.reasons);
    // The stale-date client must be told the truth about WHY it is blank --
    // the same distinction planDue() already makes, carried into the reason.
    check("a plan date from a finished authorization cycle says so in the reason",
      byId(6).health.reasons.some((r) => /predates it/.test(r.text)), byId(6).health.reasons);
    check("the health tally counts every open client exactly once",
      p.summary.health.ok + p.summary.health.attention + p.summary.health.action === p.clients.length,
      p.summary.health);
    check("A DISCHARGED CLIENT IS NOT IN THE HEALTH TALLY EITHER",
      p.summary.health.ok + p.summary.health.attention + p.summary.health.action === 5, p.summary.health);

    check("the priority feed is built from those same verdicts",
      p.priorities.length > 0 && p.priorities.every((x) => x.level !== "ok"), p.priorities);
    check("ACTION COMES BEFORE ATTENTION, whatever the client's name",
      p.priorities.every((x, i, a) => i === 0 || !(a[i - 1].level === "attention" && x.level === "action")),
      p.priorities.map((x) => x.level + ":" + x.client_name));
    check("...the most overdue thing is first",
      p.priorities[0].client_id === 1, p.priorities[0]);
    check("ONE LINE PER CLIENT, not one per problem",
      new Set(p.priorities.map((x) => x.client_id)).size === p.priorities.length,
      p.priorities.map((x) => x.client_name));
    check("...and a client with more than one problem says so",
      p.priorities.find((x) => x.client_id === 1).also >= 1, p.priorities.find((x) => x.client_id === 1));
    check("every priority points at a record that can be opened",
      p.priorities.every((x) => x.client_id || x.task_id), p.priorities);
    check("no priority is about a client who is not on the caseload",
      p.priorities.every((x) => !x.client_id || p.clients.some((c) => c.id === x.client_id)), p.priorities);

    check("student analysts are counted from the client records",
      p.summary.analysts.count === 1 && p.summary.analysts.clients_with === 2, p.summary.analysts);
    check("and clients without one are counted too",
      p.summary.analysts.clients_without === 3, p.summary.analysts);
    check("THE ANALYST IS ON EVERY CLIENT ROW, not only in the summary",
      p.clients.find((c) => c.id === 1).student_analyst === "Juniper Kade");
    check("the analyst panel lists that analyst's clients",
      p.analysts[0].clients.length === 2, p.analysts);
  }

  // ==================================================== the month calendar
  section("My Schedule reads a whole month in one call");
  {
    const MONTH = "2026-05";                       // 31 days, the 1st a Friday
    let asked = null;
    const { mod } = load({
      responses: [
        [/FROM hr_employees WHERE LOWER\(TRIM\(email\)\)/, { id: 7, name: "Bee See", email: "bee@x.invalid", rethink_id: "S7" }],
        [/FROM clients WHERE rethink_client_id IN/, [{ id: 21, child_name: "Cal Kid", rethink_client_id: "C1" }]],
      ],
      fetchAppointments: async (from, to) => {
        asked = { from, to };
        return { ok: true, rows: [
          { staffId: "S7", clientId: "C1", appointmentDate: "2026-05-04", startTime: "2026-05-04T09:00:00", actualDurationHours: 2 },
          { staffId: "S7", clientId: "C1", appointmentDate: "2026-05-04", startTime: "2026-05-04T13:00:00", actualDurationHours: 1.5 },
          { staffId: "S7", clientId: "C1", appointmentDate: "2026-05-20", startTime: "2026-05-20T10:00:00", actualDurationHours: 3 },
          // Somebody else's session in the same month: never this BCBA's.
          { staffId: "S9", clientId: "C1", appointmentDate: "2026-05-04", startTime: "2026-05-04T08:00:00", actualDurationHours: 8 },
        ] };
      },
    });

    const m = await mod._internal.scheduleMonthFor({ email: "bee@x.invalid" }, MONTH);

    check("ONE Rethink call covers the whole month, not one per day",
      asked && asked.from === "2026-05-01" && asked.to === "2026-05-31", asked);
    check("the month is available", m.available === true, m);
    check("every day of the month gets a cell, quiet ones included",
      m.days.length === 31, m.days.length);
    check("appointments land on their own day",
      (m.days.find((d) => d.date === "2026-05-04") || {}).count === 2
      && (m.days.find((d) => d.date === "2026-05-20") || {}).count === 1,
      m.days.filter((d) => d.count).map((d) => d.date + ":" + d.count));
    check("a quiet day is zero rather than missing",
      (m.days.find((d) => d.date === "2026-05-05") || {}).count === 0);
    check("hours are summed per day",
      (m.days.find((d) => d.date === "2026-05-04") || {}).hours === 3.5,
      (m.days.find((d) => d.date === "2026-05-04") || {}).hours);
    check("another provider's sessions are never on this calendar",
      m.total_appointments === 3, m.total_appointments);
    check("the month total is the sum of its days", m.total_hours === 6.5, m.total_hours);
    check("each day carries its own rows, so choosing a day needs no second call",
      (m.days.find((d) => d.date === "2026-05-04") || {}).rows.length === 2);
    check("a linked client is named rather than shown as a Rethink id",
      ((m.days.find((d) => d.date === "2026-05-04") || {}).rows[0] || {}).client_name === "Cal Kid");
  }
  {
    // The day view still answers in its old shape: other callers depend on it.
    const { mod } = load({
      responses: [
        [/FROM hr_employees WHERE LOWER\(TRIM\(email\)\)/, { id: 7, name: "Bee See", email: "bee@x.invalid", rethink_id: "S7" }],
      ],
      fetchAppointments: async () => ({ ok: true, rows: [] }),
    });
    const d = await mod._internal.scheduleFor({ email: "bee@x.invalid" }, "2026-05-04");
    check("the single-day view still returns { date, available, rows }",
      d.date === "2026-05-04" && d.available === true && Array.isArray(d.rows), d);
  }
  {
    // Rethink unreachable must be SAID, not drawn as an empty month.
    const { mod } = load({
      responses: [
        [/FROM hr_employees WHERE LOWER\(TRIM\(email\)\)/, { id: 7, name: "Bee See", email: "bee@x.invalid", rethink_id: "S7" }],
      ],
      fetchAppointments: async () => ({ ok: false, error: "Rethink is unavailable." }),
    });
    const m = await mod._internal.scheduleMonthFor({ email: "bee@x.invalid" }, "2026-05");
    check("an unreachable Rethink is named, not drawn as a month of nothing",
      m.available === false && /unavailable/i.test(m.reason || ""), m);
    check("and no day cells are invented", m.days === undefined, m.days);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
