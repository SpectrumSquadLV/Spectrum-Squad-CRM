// The grant assistant's prompt construction.
//
// The instruction for phase 3 was: use what the CRM knows about Spectrum
// Squad, and never fabricate. Those pull against each other, and the usual way
// that goes wrong is invisible -- a model handed an empty field writes a
// plausible number into it and nobody notices until a funder does.
//
// So the enforcement is structural rather than a polite request in the prompt,
// and this suite checks the structure:
//
//   1. A field that is empty in the profile is ABSENT from the prompt, not
//      sent as a blank. The model cannot repeat what it was never shown.
//   2. Only APPROVED reuse blocks are sent. A half-written paragraph nobody
//      signed off on must not reach a funder.
//   3. The EIN, UEI, SAM registration and revenue band are never sent at all.
//   4. Every action, without exception, carries the no-fabrication rule and
//      the [Information Needed: ...] instruction.
//
// buildAssistantRequest() is pure, so all of that is checkable without an API
// key, a network call or a token spent.
//   Run with: node test-grants-assistant.js
"use strict";
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 400) : "")); }
}
const section = (t) => console.log("\n== " + t + " ==");

const grants = require(path.join(__dirname, "grants.js"))({
  dbGet: async () => null,
  dbAll: async () => [],
  dbRun: async () => ({ rows: [] }),
  nowISO: () => "2026-08-23T00:00:00.000Z",
  readBody: async () => ({}),
  json: () => {},
  callClaude: async () => ({ ok: false, reason: "not_configured" }),
  aiConfigured: () => false,
});
const { buildAssistantRequest, profileFacts, approvedBlocks, ASSISTANT_ACTIONS, REUSE_SECTIONS, NO_FABRICATION } = grants;

// A profile with some fields filled in and some deliberately empty, plus every
// sensitive field populated so their absence from the prompt is meaningful.
const PROFILE = {
  company_name: "Spectrum Squad",
  state: "Nevada",
  county: "Clark County",
  services: "ABA therapy and RBT training",
  mission: "Serving children with autism in southern Nevada.",
  for_profit: true, woman_owned: true, veteran_owned: true, small_business: true,
  // deliberately empty
  employee_count: null, clients_served: "", community_impact: null, year_founded: "",
  // sensitive -- must never be sent
  ein: "88-1234567", uei: "ABC123DEF456", annual_revenue_range: "$5M-$10M", sam_registered: true,
};

const GRANT = {
  id: 1, name: "Nevada Workforce Grant", funder: "Nevada DETR",
  geographic_eligibility: "Nevada", for_profit_allowed: true, sam_required: true,
  deadline: "2026-12-01", eligibility_label: "Eligible",
  eligibility_explanation: "Strong eligibility: Nevada applicants are eligible.",
  tags: JSON.stringify(["nevada", "rbt_training"]),
};

const BLOCKS = [
  { key: "mission_statement", label: "Mission statement", content: "APPROVED MISSION TEXT", approved: true },
  { key: "history", label: "History", content: "DRAFT HISTORY NOBODY SIGNED OFF", approved: false },
  { key: "goals", label: "Goals", content: "", approved: true },
];

// ------------------------------------------------------------ profile facts
section("Only what we actually know is sent");
const facts = profileFacts(PROFILE);
const factText = facts.join("\n");
check("a filled field is included", /Spectrum Squad/.test(factText));
check("so is the state", /Nevada/.test(factText));
check("an empty field is absent entirely, not blank", !/Employees/.test(factText), factText);
check("a null field too", !/Community impact/.test(factText), factText);
check("an empty string field too", !/Year founded/.test(factText), factText);
check("for-profit status is stated plainly, since it decides eligibility",
  /for-profit/i.test(factText) && /not a 501\(c\)\(3\)/i.test(factText), factText);
check("woman-owned is stated", /woman-owned/i.test(factText));
check("veteran-owned is stated", /veteran-owned/i.test(factText));

section("Registration and financial details are never sent");
for (const [label, secret] of [["EIN", "88-1234567"], ["UEI", "ABC123DEF456"], ["revenue", "$5M-$10M"]]) {
  check(`the ${label} is not in the profile facts`, !factText.includes(secret), factText);
}

// ------------------------------------------------------------ reuse blocks
section("Only approved reusable content is sent");
const approved = approvedBlocks(BLOCKS);
check("an approved block with content is included", approved.some((b) => b.key === "mission_statement"));
check("an unapproved block is not", !approved.some((b) => b.key === "history"), approved.map((b) => b.key));
check("an approved but empty block is not", !approved.some((b) => b.key === "goals"), approved.map((b) => b.key));
check("so exactly one block survives", approved.length === 1, approved.length);

// ------------------------------------------------------- the built request
section("A built request shows the model the right material");
const req = buildAssistantRequest("draft_statement_of_need", { grant: GRANT, profile: PROFILE, blocks: BLOCKS });
check("it builds", !!req);
check("the approved text is in the prompt", req.user.includes("APPROVED MISSION TEXT"));
check("the unapproved text is NOT", !req.user.includes("DRAFT HISTORY NOBODY SIGNED OFF"), req.user.slice(0, 200));
check("the EIN is not in the prompt", !req.user.includes("88-1234567"));
check("the UEI is not in the prompt", !req.user.includes("ABC123DEF456"));
check("the revenue band is not in the prompt", !req.user.includes("$5M-$10M"));
check("the grant is described", /Nevada Workforce Grant/.test(req.user));
check("including its own eligibility verdict", /Strong eligibility/.test(req.user));
check("the task names the section", /Statement of need/i.test(req.user));
check("it reports what it was based on", req.sources.profile_facts > 0 && req.sources.approved_blocks === 1, req.sources);
check("and which section it drafts", req.section === "statement_of_need");

section("An unrecorded eligibility field is stated as unrecorded, not omitted");
const vague = buildAssistantRequest("qualify", {
  grant: { name: "Vague Grant", for_profit_allowed: null }, profile: PROFILE, blocks: [],
});
check("the prompt says it has not been recorded",
  /has NOT been recorded/i.test(vague.user), vague.user.slice(-400));

// ------------------------------------------------- the no-fabrication rule
section("Every action carries the same no-fabrication rule");
const keys = Object.keys(ASSISTANT_ACTIONS);
check("there are the actions the brief asked for", keys.length >= 14, keys.length);
for (const key of keys) {
  const r = buildAssistantRequest(key, { grant: GRANT, profile: PROFILE, blocks: BLOCKS });
  check(`${key}: builds`, !!r);
  check(`${key}: the system prompt forbids inventing`, r.system.includes(NO_FABRICATION));
  check(`${key}: the user prompt repeats the rule`, r.user.includes(NO_FABRICATION));
  check(`${key}: it names the Information Needed format`, /\[Information Needed:/.test(r.user));
  check(`${key}: no secret leaked`, !r.user.includes("88-1234567") && !r.user.includes("ABC123DEF456"));
}

section("The named actions from the brief are all present");
for (const k of ["explain", "qualify", "why_match", "use_for", "requirements", "checklist", "missing", "narrative",
  "draft_executive_summary", "draft_statement_of_need", "draft_program_description",
  "draft_community_impact", "draft_organizational_background", "draft_outcomes", "draft_budget_justification"]) {
  check(`"${k}" exists`, !!ASSISTANT_ACTIONS[k], keys);
}

section("Identify-missing-information returns structured items");
const missing = buildAssistantRequest("missing", { grant: GRANT, profile: PROFILE, blocks: BLOCKS });
check("it asks for a schema", !!missing.schema);
check("shaped as a list of item + why",
  missing.schema.properties.missing.items.required.join(",") === "item,why", missing.schema);

section("An unknown action is refused rather than guessed at");
check("returns null", buildAssistantRequest("please_invent_something", { profile: PROFILE }) === null);

section("A bare profile still produces a usable request");
const bare = buildAssistantRequest("explain", { grant: GRANT, profile: {}, blocks: [] });
check("it builds", !!bare);
check("and says plainly that nothing is recorded", /\(nothing recorded\)/.test(bare.user), bare.user.slice(0, 200));
check("and that no blocks are approved", /\(none approved yet\)/.test(bare.user));

section("The reuse library covers what the brief listed");
for (const k of ["company_description", "mission_statement", "history", "population_served", "community_need",
  "program_description", "aba_services", "rbt_workforce_program", "leadership_background", "community_impact",
  "goals", "measurable_outcomes", "sustainability_plan", "diversity_access", "veteran_owned", "woman_led"]) {
  check(`"${k}" is a reuse block`, REUSE_SECTIONS.some((s) => s.key === k), REUSE_SECTIONS.map((s) => s.key));
}

section("There is one Claude client, and only one");
const fs = require("fs");
const sources = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith(".js") && !f.startsWith("test-") && f !== "run-tests.js");
const withEndpoint = sources.filter((f) =>
  fs.readFileSync(path.join(__dirname, f), "utf8").includes("api.anthropic.com"));
check("exactly one module holds the Anthropic endpoint", withEndpoint.length === 1, withEndpoint);
check("and it is ai-client.js", withEndpoint[0] === "ai-client.js", withEndpoint);
check("hr.js goes through the shared client",
  fs.readFileSync(path.join(__dirname, "hr.js"), "utf8").includes('require("./ai-client")'));
check("so does the grants module, via its ctx",
  fs.readFileSync(path.join(__dirname, "server.js"), "utf8").includes("callClaude: (o) => aiClient.callClaude(o)"));

section("Without a key the client declines rather than throwing");
const aiClient = require(path.join(__dirname, "ai-client.js"));
const hadKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
check("configured() is false", aiClient.configured() === false);
// No network: not_configured short-circuits before any fetch.
aiClient.callClaude({ system: "s", user: "u" }).then((r) => {
  check("callClaude resolves rather than rejecting", !!r);
  check("with ok false", r.ok === false, r);
  check("and a reason the UI can state plainly", r.reason === "not_configured", r);
  if (hadKey) process.env.ANTHROPIC_API_KEY = hadKey;

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
});

