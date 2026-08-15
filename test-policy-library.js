// Policy library -- structure tests.
//
// The two things worth protecting here are the ones that are expensive to
// discover late:
//
//   * One source document holds many policies. The Employee Handbook is
//     uploaded once and the Attendance Policy, Dress Code and the rest become
//     separately findable records pointing back at it.
//   * An acknowledgment belongs to a POLICY VERSION. Re-issuing a policy must
//     leave the old acknowledgment intact as historical proof and put everyone
//     back into "pending" against the new version. Overwriting that record
//     would destroy the only evidence of what somebody actually agreed to.
//
// Run: node test-policy-library.js     (no database, no network, no browser)

"use strict";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
};

const NOW = "2026-08-15T12:00:00.000Z";

// ---- in-memory database -------------------------------------------------
function makeDb(seed = {}) {
  const state = {
    policies: seed.policies || [],
    documents: seed.documents || [],
    acks: seed.acks || [],
    employees: seed.employees || [],
    updates: [],
    inserts: [],
    sql: [],
  };
  let nextId = 100;

  const dbAll = async (sql, p = []) => {
    state.sql.push(sql);
    if (/FROM crm_policies p LEFT JOIN crm_policy_documents/i.test(sql)) {
      return state.policies.map((x) => {
        const d = state.documents.find((dd) => dd.id === x.document_id);
        return { ...x, document_title: d ? d.title : null, document_type: d ? d.doc_type : null, document_filename: d ? d.filename : null };
      });
    }
    if (/FROM crm_policy_acknowledgments WHERE employee_id/i.test(sql)) {
      return state.acks.filter((a) => a.employee_id === p[0]);
    }
    if (/FROM crm_policy_acknowledgments/i.test(sql)) return state.acks;
    if (/FROM crm_policies WHERE requires_acknowledgment = TRUE/i.test(sql)) {
      return state.policies.filter((x) => x.requires_acknowledgment && (x.status || "Active") === "Active");
    }
    if (/FROM crm_policies WHERE document_id/i.test(sql)) return state.policies.filter((x) => x.document_id === p[0]);
    if (/FROM hr_employees/i.test(sql)) return state.employees;
    if (/FROM crm_policy_documents/i.test(sql)) return state.documents;
    if (/FROM crm_policies/i.test(sql)) return state.policies;
    return [];
  };

  const dbGet = async (sql, p = []) => {
    state.sql.push(sql);
    if (/INSERT INTO crm_policy_documents/i.test(sql)) {
      const doc = { id: nextId++, title: p[0], doc_type: p[1], filename: p[2], body: p[3], version: p[4], effective_date: p[5], status: p[6] };
      state.documents.push(doc); state.inserts.push({ table: "documents", row: doc });
      return doc;
    }
    if (/FROM crm_policies WHERE id/i.test(sql)) return state.policies.find((x) => x.id === p[0]) || null;
    if (/FROM crm_policy_documents WHERE id/i.test(sql)) return state.documents.find((x) => x.id === p[0]) || null;
    if (/FROM crm_policies WHERE slug/i.test(sql)) return state.policies.find((x) => x.slug === p[0]) || null;
    return null;
  };

  const dbRun = async (sql, p = []) => {
    state.sql.push(sql);
    if (/INSERT INTO crm_policy_acknowledgments/i.test(sql)) {
      const key = `${p[0]}::${p[1]}::${p[2]}`;
      if (state.acks.some((a) => `${a.policy_id}::${a.policy_version}::${a.employee_id}` === key)) {
        return { rows: [] }; // ON CONFLICT DO NOTHING
      }
      state.acks.push({ policy_id: p[0], policy_version: p[1], employee_id: p[2], employee_name: p[3], employee_email: p[4], acknowledged_at: p[5] });
      return { rows: [] };
    }
    if (/INSERT INTO crm_policies/i.test(sql)) {
      const row = {
        id: nextId++, title: p[0], category: p[1], body: p[2], slug: p[3], published: p[4],
        document_id: p[8], section_ref: p[9], status: p[10], version: p[11],
        effective_date: p[12], requires_acknowledgment: p[13], ack_required_since: p[14],
      };
      state.policies.push(row); state.inserts.push({ table: "policies", row });
      return { rows: [{ id: row.id }] };
    }
    if (/^\s*UPDATE crm_policies SET/i.test(sql)) { state.updates.push({ sql, params: p }); return { rows: [] }; }
    return { rows: [] };
  };

  return {
    state,
    ctx: {
      dbGet, dbAll, dbRun, nowISO: () => NOW, crypto: require("crypto"),
      readBody: async () => ({}), json: () => {}, moduleGranted: () => false,
      extractPdfLines: () => [], unzip: () => ({}),
      sendEmail: async () => {}, getAppSetting: async () => null, APP_BASE_URL: "",
      emailTemplates: {}, createStaffTask: () => {}, stripe: {},
    },
  };
}

// Drive handleApi directly so the real route logic runs.
function call(growth, { path, method = "GET", body = {}, user = null, query = {} }) {
  return new Promise((resolve) => {
    const res = { _s: null, _b: null };
    const ctxJson = (r, status, payload) => { res._s = status; res._b = payload; resolve({ status, body: payload }); };
    growth.__setJson(ctxJson);
    growth.__setBody(body);
    growth.handleApi({}, res, path, method, query, user).then((handled) => {
      if (!handled && res._s === null) resolve({ status: 404, body: null, unhandled: true });
    });
  });
}

// growth.js takes json/readBody from ctx, so they are swapped per call.
function buildGrowth(ctx) {
  let jsonFn = () => {}, bodyVal = {};
  const wrapped = { ...ctx, json: (...a) => jsonFn(...a), readBody: async () => bodyVal };
  const g = require("./growth")(wrapped);
  g.__setJson = (fn) => { jsonFn = fn; };
  g.__setBody = (b) => { bodyVal = b; };
  return g;
}

const OWNER = { id: 1, name: "Owner", email: "owner@x.com", role: "owner" };
const STAFF = { id: 42, name: "Riley RBT", email: "riley@x.com", role: "clinical" };

(async () => {
  console.log("\nCATEGORIES\n");
  {
    const { ctx } = makeDb();
    const g = buildGrowth(ctx);
    const r = await call(g, { path: "/api/policies/library", user: OWNER });
    const cats = r.body.categories;
    check("the new category list is offered", cats.includes("HIPAA, Privacy & Confidentiality") && cats.includes("Mandated Reporting"), cats.length);
    check("all 25 requested categories are present", cats.length >= 25, cats.length);
    check("legacy categories are hidden when nothing uses them",
      !cats.includes("HR") && !cats.includes("Billing"), JSON.stringify(cats.slice(-6)));
    check("statuses are exposed", JSON.stringify(r.body.statuses) === JSON.stringify(["Active", "Draft", "Archived"]));
  }
  {
    // A policy still filed under a legacy category keeps that option available.
    const { ctx } = makeDb({ policies: [{ id: 1, title: "Old", category: "HR", slug: "old", status: "Active" }] });
    const g = buildGrowth(ctx);
    const r = await call(g, { path: "/api/policies/library", user: OWNER });
    check("a legacy category in use stays selectable so nothing is orphaned",
      r.body.categories.includes("HR"), JSON.stringify(r.body.categories.slice(-3)));
    check("the legacy policy is still listed", r.body.policies.length === 1);
  }

  console.log("\nONE DOCUMENT, MANY POLICIES\n");
  {
    const { state, ctx } = makeDb({
      documents: [{ id: 7, title: "Spectrum Squad Employee Handbook", doc_type: "Employee Handbook", filename: "handbook.pdf", body: "full text" }],
      policies: [
        { id: 1, title: "Attendance Policy", category: "Attendance & Timekeeping", slug: "att", document_id: 7, status: "Active", version: "1", section_ref: "4.2" },
        { id: 2, title: "Dress Code", category: "Dress Code & Appearance", slug: "dress", document_id: 7, status: "Active", version: "1" },
        { id: 3, title: "Standalone SOP", category: "Administrative SOPs", slug: "sop", document_id: null, status: "Active", version: "1" },
      ],
    });
    const g = buildGrowth(ctx);
    const r = await call(g, { path: "/api/policies/library", user: OWNER });
    const att = r.body.policies.find((p) => p.id === 1);

    check("two policies share one source document",
      r.body.policies.filter((p) => p.document && p.document.id === 7).length === 2);
    check("the handbook is not duplicated per policy", state.documents.length === 1);
    check("a policy names its source document", att.document.title === "Spectrum Squad Employee Handbook", JSON.stringify(att.document));
    check("the source document type is carried through", att.document.type === "Employee Handbook");
    check("a section reference is preserved", att.section_ref === "4.2");
    check("a standalone policy has no document", r.body.policies.find((p) => p.id === 3).document === null);
  }

  console.log("\nSEARCH AND FILTER\n");
  {
    const { ctx } = makeDb({
      policies: [
        { id: 1, title: "Attendance Policy", category: "Attendance & Timekeeping", slug: "a", status: "Active", body: "Employees must clock in", version: "2", effective_date: "2026-01-01" },
        { id: 2, title: "Dress Code", category: "Dress Code & Appearance", slug: "b", status: "Draft", body: "Scrubs are required" },
        { id: 3, title: "Old Rule", category: "Other", slug: "c", status: "Archived", body: "retired" },
      ],
    });
    const g = buildGrowth(ctx);
    check("search matches a title",
      (await call(g, { path: "/api/policies/library", user: OWNER, query: { q: "attendance" } })).body.policies.length === 1);
    check("search matches body text",
      (await call(g, { path: "/api/policies/library", user: OWNER, query: { q: "scrubs" } })).body.policies.length === 1);
    check("filter by category",
      (await call(g, { path: "/api/policies/library", user: OWNER, query: { category: "Dress Code & Appearance" } })).body.policies.length === 1);
    check("filter by status",
      (await call(g, { path: "/api/policies/library", user: OWNER, query: { status: "Archived" } })).body.policies.length === 1);
    const all = (await call(g, { path: "/api/policies/library", user: OWNER })).body.policies;
    check("version and effective date are exposed",
      all.find((p) => p.id === 1).version === "2" && all.find((p) => p.id === 1).effective_date === "2026-01-01");
    check("a policy with no version reads as version 1", all.find((p) => p.id === 2).version === "1");
    check("archived policies are still listed, not hidden", all.length === 3);
  }

  console.log("\nACKNOWLEDGMENT IS TIED TO A VERSION\n");
  {
    const { state, ctx } = makeDb({
      policies: [{ id: 1, title: "Attendance Policy", category: "Attendance & Timekeeping", slug: "a", status: "Active", version: "1", requires_acknowledgment: true, ack_required_since: NOW }],
      employees: [{ id: 42, name: "Riley RBT", email: "riley@x.com" }],
    });
    const g = buildGrowth(ctx);

    let r = await call(g, { path: "/api/policies/1/acknowledge", method: "POST", user: STAFF });
    check("an employee can acknowledge an active policy", r.status === 200 && r.body.version === "1", JSON.stringify(r.body));
    check("the acknowledgment records the version", state.acks[0].policy_version === "1");
    check("it records who and when", state.acks[0].employee_id === 42 && state.acks[0].acknowledged_at === NOW);

    await call(g, { path: "/api/policies/1/acknowledge", method: "POST", user: STAFF });
    check("acknowledging twice does not duplicate the record", state.acks.length === 1, state.acks.length);

    // Re-issue: version 1 -> 2.
    state.policies[0].version = "2";
    r = await call(g, { path: "/api/policies/library", user: STAFF });
    check("after a re-issue the employee has no acknowledgment for the new version",
      r.body.policies[0].my_acknowledgment === null, JSON.stringify(r.body.policies[0].my_acknowledgment));
    check("the version 1 acknowledgment still exists in the record",
      state.acks.length === 1 && state.acks[0].policy_version === "1");

    await call(g, { path: "/api/policies/1/acknowledge", method: "POST", user: STAFF });
    check("acknowledging version 2 adds a row beside version 1, not over it",
      state.acks.length === 2 && state.acks.map((a) => a.policy_version).sort().join(",") === "1,2",
      JSON.stringify(state.acks.map((a) => a.policy_version)));

    r = await call(g, { path: "/api/policies/library", user: STAFF });
    check("the library now shows the employee as acknowledged for version 2",
      r.body.policies[0].my_acknowledgment && r.body.policies[0].my_acknowledgment.version === "2");
  }

  {
    const { ctx } = makeDb({
      policies: [
        { id: 1, title: "No ack needed", slug: "a", status: "Active", version: "1", requires_acknowledgment: false },
        { id: 2, title: "Archived", slug: "b", status: "Archived", version: "1", requires_acknowledgment: true },
      ],
    });
    const g = buildGrowth(ctx);
    check("a policy that does not require acknowledgment refuses one",
      (await call(g, { path: "/api/policies/1/acknowledge", method: "POST", user: STAFF })).status === 400);
    check("an archived policy cannot be acknowledged",
      (await call(g, { path: "/api/policies/2/acknowledge", method: "POST", user: STAFF })).status === 400);
    check("an anonymous visitor cannot acknowledge",
      (await call(g, { path: "/api/policies/1/acknowledge", method: "POST", user: null })).status === 401);
  }

  console.log("\nADMIN ACKNOWLEDGMENT REPORT\n");
  {
    const { ctx } = makeDb({
      policies: [{ id: 1, title: "Attendance Policy", category: "Attendance & Timekeeping", slug: "a", status: "Active", version: "2", requires_acknowledgment: true, ack_required_since: "2026-08-14T00:00:00.000Z" }],
      employees: [{ id: 42, name: "Riley RBT" }, { id: 43, name: "Sam RBT" }, { id: 44, name: "Alex RBT" }],
      acks: [
        { policy_id: 1, policy_version: "2", employee_id: 42, employee_name: "Riley RBT", acknowledged_at: NOW },
        { policy_id: 1, policy_version: "1", employee_id: 43, employee_name: "Sam RBT", acknowledged_at: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const g = buildGrowth(ctx);
    const r = await call(g, { path: "/api/policies/acknowledgments", user: OWNER });
    const p = r.body.by_policy[0];

    check("the report counts acknowledged for the CURRENT version", p.acknowledged === 1, p.acknowledged);
    check("someone who only acknowledged the old version counts as pending",
      p.pending === 2, `${p.pending} pending / ${p.overdue} overdue`);
    check("the report breaks down by employee", p.employees.length === 3);
    check("the person who acknowledged v2 shows acknowledged",
      p.employees.find((e) => e.employee_id === 42).state === "acknowledged");
    check("the person who only acknowledged v1 shows pending",
      p.employees.find((e) => e.employee_id === 43).state === "pending");
    check("the superseded v1 acknowledgment is preserved as history",
      r.body.historical.some((h) => h.employee_id === 43 && h.version === "1"), JSON.stringify(r.body.historical));
    check("staff cannot read the acknowledgment report",
      (await call(g, { path: "/api/policies/acknowledgments", user: STAFF })).status === 403);
  }

  {
    // Overdue: the requirement has been outstanding longer than the threshold.
    const { ctx } = makeDb({
      policies: [{ id: 1, title: "Old requirement", slug: "a", status: "Active", version: "1", requires_acknowledgment: true, ack_required_since: "2026-06-01T00:00:00.000Z" }],
      employees: [{ id: 42, name: "Riley RBT" }],
    });
    const g = buildGrowth(ctx);
    const p = (await call(g, { path: "/api/policies/acknowledgments", user: OWNER })).body.by_policy[0];
    check("a long-outstanding requirement reads as overdue rather than pending",
      p.overdue === 1 && p.pending === 0, `${p.pending} pending / ${p.overdue} overdue`);
  }

  console.log("\nADMIN CONTROLS AND PERMISSIONS\n");
  {
    const { state, ctx } = makeDb({
      policies: [{ id: 1, title: "Attendance Policy", slug: "a", status: "Active", version: "1", requires_acknowledgment: false, category: "Other" }],
    });
    const g = buildGrowth(ctx);

    let r = await call(g, { path: "/api/policies/1", method: "PATCH", user: OWNER, body: { version: "2" } });
    check("bumping the version reports a re-issue", r.body.reissued === true && r.body.previous_version === "1", JSON.stringify(r.body));
    check("the re-issue restarts the acknowledgment clock",
      state.updates.some((u) => /ack_required_since/.test(u.sql)));

    r = await call(g, { path: "/api/policies/1", method: "PATCH", user: OWNER, body: { status: "Archived" } });
    check("a policy can be archived", r.status === 200);
    r = await call(g, { path: "/api/policies/1", method: "PATCH", user: OWNER, body: { status: "Nonsense" } });
    check("an unknown status is rejected", r.status === 400, JSON.stringify(r.body));
    r = await call(g, { path: "/api/policies/1", method: "PATCH", user: OWNER, body: { category: "Not A Category" } });
    check("an unknown category is rejected", r.status === 400);
    r = await call(g, { path: "/api/policies/1", method: "PATCH", user: OWNER, body: { category: "Mandated Reporting" } });
    check("a new category is accepted", r.status === 200);
    r = await call(g, { path: "/api/policies/1", method: "PATCH", user: STAFF, body: { title: "Hijacked" } });
    check("staff cannot edit a policy", r.status === 403);
  }

  {
    const { state, ctx } = makeDb({
      documents: [{ id: 7, title: "Employee Handbook", doc_type: "Employee Handbook", filename: "h.pdf", body: "text" }],
    });
    const g = buildGrowth(ctx);
    const r = await call(g, {
      path: "/api/policies", method: "POST", user: OWNER,
      body: { title: "Attendance Policy", category: "Attendance & Timekeeping", document_id: 7, section_ref: "4.2", version: "1", requires_acknowledgment: true, effective_date: "2026-01-01" },
    });
    check("a policy record can be created against an existing document", r.status === 201);
    const created = state.policies.find((p) => p.title === "Attendance Policy");
    check("it links to the source document", created.document_id === 7);
    check("it stores the section reference", created.section_ref === "4.2");
    check("turning acknowledgment on at creation starts the clock", created.ack_required_since === NOW);
    check("no second copy of the handbook is created", state.documents.length === 1);

    check("staff cannot upload a source document",
      (await call(g, { path: "/api/policies/documents", method: "POST", user: STAFF, body: { content_base64: "x" } })).status === 403);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
