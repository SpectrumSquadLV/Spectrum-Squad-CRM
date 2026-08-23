// Phase 4: bringing opportunities in from outside.
//
// The brief said: do not build fake automation. The risk in an import pipeline
// is not that it crashes -- it is that it looks like it worked. So this suite
// is built around the three ways this could quietly lie:
//
//   1. AN IMPORTED GRANT MUST NEVER ARRIVE MARKED ELIGIBLE. A funder's
//      applicant-eligibility codes do not map onto "may a Nevada for-profit ABA
//      provider apply", and a wrong yes costs somebody a week. Two independent
//      things stop it: normalize() leaves every tri-state flag null, and the
//      importer's insert column list does not carry eligibility flags at all.
//      Both are checked here, separately -- including with a feed that
//      explicitly claims we qualify -- because a guarantee held up by one
//      unchecked line is a guarantee waiting to be deleted.
//   2. A SOURCE THAT CANNOT RUN MUST SAY SO. A connector missing its API key
//      must report that, not return zero records and look healthy.
//   3. RUNNING TWICE MUST NOT DUPLICATE. The same feed imported again imports
//      nothing.
//
// The network hop is the only untested line: the connectors take an injected
// fetchImpl, so the envelope handling, the mapping and the refusals are all
// driven here from recorded payloads.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-grants-discovery.js
"use strict";
const path = require("path");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 320) : "")); }
}
const section = (t) => console.log("\n== " + t + " ==");

const conn = require(path.join(__dirname, "grant-connectors.js"));

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
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// A Grants.gov record shaped the way that API documents it.
const GG_RECORD = {
  id: "355001",
  number: "HRSA-27-014",
  title: "Behavioral Health Workforce Education and Training for Children",
  agency: "Health Resources and Services Administration",
  description: "Supports training programmes that expand the behavioral health workforce serving children and adolescents with autism in underserved areas.",
  openDate: "01/15/2027",
  closeDate: "03/31/2027",
  awardCeiling: "480000",
  awardFloor: "120000",
  applicantTypes: [{ description: "Public and State controlled institutions of higher education" }, { description: "Nonprofits" }],
  categories: [{ description: "Health" }],
};

(async () => {
  // ==================================================================== pure
  section("An imported record never claims eligibility");
  const g = conn.normalize("grants_gov", GG_RECORD);
  check("it normalises", !!g, g);
  const FLAGS = ["for_profit_allowed", "nonprofit_required", "small_business_eligible", "government_only",
    "university_only", "school_district_only", "tribal_only", "research_institution_only",
    "veteran_preference", "woman_preference", "matching_funds_required", "partnerships_required",
    "sam_required", "uei_required"];
  for (const f of FLAGS) check(`${f} is left unrecorded`, g[f] === null, { [f]: g[f] });
  check("the funder's own eligibility wording is kept verbatim for a human",
    /Nonprofits/.test(g.applicant_eligibility), g.applicant_eligibility);
  check("even though that text says nonprofits, nothing was inferred from it",
    g.nonprofit_required === null && g.for_profit_allowed === null);

  section("The parts it is safe to map, it maps");
  check("title", g.name === "Behavioral Health Workforce Education and Training for Children", g.name);
  check("funder", /Health Resources/.test(g.funder), g.funder);
  check("opportunity number", g.opportunity_number === "HRSA-27-014", g.opportunity_number);
  check("US dates become ISO", g.deadline === "2027-03-31", g.deadline);
  check("so does the opening date", g.opening_date === "2027-01-15", g.opening_date);
  check("amounts become numbers", g.amount_max === 480000 && g.amount_min === 120000, [g.amount_min, g.amount_max]);
  check("status is New", g.status === "New");

  section("Tags are inferred, because they only affect findability and scoring");
  check("behavioral health", g.tags.includes("behavioral_health"), g.tags);
  check("autism", g.tags.includes("autism"), g.tags);
  check("children", g.tags.includes("children_youth"), g.tags);
  check("workforce", g.tags.includes("workforce_development"), g.tags);
  check("underserved", g.tags.includes("underserved"), g.tags);
  check("but not something absent from the text", !g.tags.includes("veteran_owned"), g.tags);

  section("A feed that hands us eligibility flags has them dropped");
  // Pins the first defence on its own. Without this, normalize() could start
  // passing a feed's claims through and nothing would notice, because the
  // importer's column allowlist would quietly cover for it.
  const pushy = conn.normalize("paste", {
    name: "Pushy Fund", funder: "Someone", for_profit_allowed: true, nonprofit_required: false,
    small_business_eligible: true, veteran_preference: true, woman_preference: true,
    matching_funds_required: false, sam_required: false, uei_required: false,
    government_only: false, university_only: false, school_district_only: false,
    tribal_only: false, research_institution_only: false, partnerships_required: false,
  });
  for (const f of FLAGS) check(`it drops the claimed ${f}`, pushy[f] === null, { [f]: pushy[f] });

  section("The most tempting possible import still needs a human");
  // A funder whose own notice says we may apply. This is the case where a
  // helpful importer would be most tempted to parse the sentence and mark it
  // eligible, and exactly the case the brief said never to assume.
  const tempting = conn.normalize("paste", {
    name: "Nevada Autism Workforce Fund", funder: "Nevada DHHS",
    description: "ABA therapy, RBT training and autism services for children in Clark County, Nevada.",
    geographic_eligibility: "Nevada", deadline: "2027-01-15", amount_max: 500000,
    eligibility: "Open to all Nevada providers including for-profit entities",
  });
  check("the permissive wording is carried across for a person to read",
    /for-profit entities/.test(tempting.applicant_eligibility), tempting.applicant_eligibility);
  check("but it is not turned into a yes", tempting.for_profit_allowed === null, tempting.for_profit_allowed);
  const grants = require(path.join(__dirname, "grants.js"))({
    dbGet: async () => null, dbAll: async () => [], dbRun: async () => ({ rows: [] }),
    nowISO: () => "2026-08-23", readBody: async () => ({}), json: () => {},
    callClaude: async () => ({ ok: false }), aiConfigured: () => false,
  });
  const verdict = grants.assess(tempting, {
    company_name: "Spectrum Squad", state: "Nevada", county: "Clark County", for_profit: true,
    woman_owned: true, veteran_owned: true, small_business: true,
    mission: "autism children", services: "ABA therapy, RBT training",
  }, ["rbt_training"]);
  check("so even a near-perfect match comes back needing review",
    verdict.eligibility_status === "needs_review", verdict);
  check("and says which sentence a person has to go and read",
    /for-profit/i.test(verdict.eligibility_explanation), verdict.eligibility_explanation);

  section("A record with no title is refused rather than stored blank");
  check("returns null", conn.normalize("grants_gov", { number: "X-1" }) === null);
  check("an unknown source returns null", conn.normalize("nope", GG_RECORD) === null);

  section("A source that cannot run says so");
  const samKeyWas = process.env.SAM_API_KEY;
  delete process.env.SAM_API_KEY;
  const sam = conn.connectorStatus("sam_gov");
  check("sam.gov is unavailable without its key", sam.available === false, sam);
  check("and names the variable it needs", /SAM_API_KEY/.test(sam.reason || ""), sam.reason);
  const gg = conn.connectorStatus("grants_gov");
  check("grants.gov needs no key", gg.available === true, gg);
  check("but is honestly marked unverified", gg.verified === false, gg);
  check("with a note saying why", /not yet run against the live service/i.test(gg.note || ""), gg.note);

  section("The connector handles what the API might actually return");
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { oppHits: [GG_RECORD] } }) });
  const r1 = await conn.CONNECTORS.grants_gov.fetch({ fetchImpl: okFetch });
  check("documented envelope: records come through", r1.ok && r1.records.length === 1, r1);
  check("and a raw sample is kept so a wrong mapping can be seen", !!r1.raw_sample);

  const bareFetch = async () => ({ ok: true, status: 200, json: async () => ({ oppHits: [GG_RECORD, GG_RECORD] }) });
  const r2 = await conn.CONNECTORS.grants_gov.fetch({ fetchImpl: bareFetch });
  check("a shape surprise does not break it", r2.ok && r2.records.length === 2, r2);

  const oddFetch = async () => ({ ok: true, status: 200, json: async () => ({ something: "else" }) });
  const r3 = await conn.CONNECTORS.grants_gov.fetch({ fetchImpl: oddFetch });
  check("an unrecognised body yields no records rather than throwing", r3.ok && r3.records.length === 0, r3);

  const badFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r4 = await conn.CONNECTORS.grants_gov.fetch({ fetchImpl: badFetch });
  check("an HTTP error is reported", r4.ok === false && /503/.test(r4.error), r4);

  const samNoKey = await conn.CONNECTORS.sam_gov.fetch({ fetchImpl: okFetch });
  check("sam.gov refuses to run without a key rather than calling", samNoKey.ok === false, samNoKey);
  if (samKeyWas) process.env.SAM_API_KEY = samKeyWas;

  // ================================================================ over HTTP
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);

  section("Importing through the paste path");
  const batch = [
    { name: "D1 Nevada Autism Services Expansion", funder: "Nevada DHHS", opportunity_number: "D1-001",
      description: "Behavioral health services for children with autism in Nevada, including workforce training.",
      geographic_eligibility: "Nevada", deadline: inDays(60), amount_max: 200000 },
    { name: "D1 Rural Broadband", funder: "USDA", opportunity_number: "D1-002",
      description: "Rural broadband infrastructure.", geographic_eligibility: "National", deadline: inDays(90) },
    // A feed that claims we qualify. It must not get its way: not through
    // normalize(), and not through the insert either.
    { name: "D1 Presumptuous Fund", funder: "Someone", opportunity_number: "D1-003",
      description: "Autism services in Nevada.", geographic_eligibility: "Nevada", deadline: inDays(45),
      for_profit_allowed: true, small_business_eligible: true, nonprofit_required: false,
      government_only: false, university_only: false, school_district_only: false, tribal_only: false,
      research_institution_only: false, veteran_preference: true, woman_preference: true,
      matching_funds_required: false, partnerships_required: false, sam_required: false, uei_required: false,
      eligibility_status: "eligible" },
    { title: "", funder: "Nobody" },   // unusable -- should be rejected, not stored
  ];
  const imp = await owner("/api/grants/import", { method: "POST", body: { records: batch } });
  check("the import runs", imp.status === 200, imp.data);
  check("three usable records land", imp.data.imported === 3, imp.data);
  check("the nameless one is rejected", imp.data.rejected === 1, imp.data);

  const listed = (await owner("/api/grants/opportunities?q=D1 Nevada Autism")).data.grants;
  check("the Nevada one is now tracked", listed.length === 1, listed.length);
  const nv = listed[0];
  check("it was tagged from its text", nv.tags.includes("autism") && nv.tags.includes("nevada"), nv.tags);
  check("it scored", typeof nv.match_score === "number" && nv.match_score > 0, nv.match_score);

  section("...and it is NOT presented as eligible");
  check("eligibility is needs_review, not eligible", nv.eligibility_status === "needs_review", nv.eligibility_status);
  check("the explanation says what has to be read",
    /for-profit/i.test(nv.eligibility_explanation || ""), nv.eligibility_explanation);
  check("for_profit_allowed is unrecorded on the stored row", nv.for_profit_allowed === null, nv.for_profit_allowed);

  section("A feed that claims we qualify does not get its way");
  const pres = (await owner("/api/grants/opportunities?q=Presumptuous")).data.grants[0];
  check("it was imported", !!pres, pres);
  check("but it is NOT eligible", pres.eligibility_status === "needs_review", pres.eligibility_status);
  for (const f of FLAGS) check(`its claimed ${f} was not stored`, pres[f] === null, { [f]: pres[f] });
  check("and its verdict says the notice still has to be read",
    /for-profit/i.test(pres.eligibility_explanation || ""), pres.eligibility_explanation);

  section("Running the same feed again imports nothing");
  const again = await owner("/api/grants/import", { method: "POST", body: { records: batch } });
  check("no new rows", again.data.imported === 0, again.data);
  check("all three are seen as duplicates", again.data.duplicates === 3, again.data);
  check("and the tracked count is unchanged",
    (await owner("/api/grants/opportunities?q=D1 ")).data.grants.length === 3);

  section("An import records who ran it");
  check("created_by names the source and the person",
    /paste import \(admin@spectrumsquadlv\.com\)/.test(nv.created_by || ""), nv.created_by);

  section("Malformed input is refused clearly");
  check("a non-array is a 400",
    (await owner("/api/grants/import", { method: "POST", body: { records: { name: "x" } } })).status === 400);
  const badJson = await owner("/api/grants/import", { method: "POST", body: { records: "{not json" } });
  check("unparseable text is a 400 with a readable reason",
    badJson.status === 400 && /did not parse/i.test(badJson.data.error || ""), badJson.data);

  section("The connector list is honest about each source");
  const conns = (await owner("/api/grants/connectors")).data.connectors;
  check("it lists them", conns.length >= 2, conns.length);
  const ggApi = conns.find((c) => c.key === "grants_gov");
  const samApi = conns.find((c) => c.key === "sam_gov");
  check("grants.gov is available", ggApi.available === true, ggApi);
  check("and flagged unverified", ggApi.verified === false, ggApi);
  check("sam.gov is unavailable", samApi.available === false, samApi);
  check("naming what it needs", /SAM_API_KEY/.test(samApi.reason || ""), samApi.reason);

  section("Every run is recorded, so a silent failure is visible");
  const runs = (await owner("/api/grants/discovery/runs")).data.runs;
  check("the paste imports were logged", runs.filter((r) => r.source_key === "paste").length >= 2, runs.length);
  const first = runs.find((r) => r.source_key === "paste");
  check("with counts", Number(first.imported) >= 0 && Number(first.fetched) === 4, first);
  check("and who ran it", !!first.triggered_by, first);

  section("Asking an unknown source to run is refused");
  check("400", (await owner("/api/grants/discovery/run", { method: "POST", body: { source: "made_up" } })).status === 400);

  section("A dry run looks without importing");
  // Driven against the connector rather than the live API: the route cannot
  // take an injected fetch, and a suite that reaches the internet is a suite
  // that fails for reasons that have nothing to do with this code.
  const dryRecords = (await conn.CONNECTORS.grants_gov.fetch({ fetchImpl: okFetch })).records;
  const mapped = dryRecords.map((r) => conn.normalize("grants_gov", r));
  check("a dry run maps what it fetched", mapped.length === 1 && !!mapped[0].name, mapped);
  check("and the mapping it would show carries no eligibility verdict",
    mapped[0].for_profit_allowed === null && !!mapped[0].applicant_eligibility, mapped[0]);

  section("A source that cannot run records why, rather than looking successful");
  const samRun = await owner("/api/grants/discovery/run", { method: "POST", body: { source: "sam_gov" } });
  check("it comes back not-ok", samRun.data.ok === false, samRun.data);
  check("with the missing key named", /SAM_API_KEY/.test(samRun.data.error || ""), samRun.data);
  const samRuns = (await owner("/api/grants/discovery/runs")).data.runs.filter((r) => r.source_key === "sam_gov");
  check("and the failure is on the record", samRuns.length === 1 && samRuns[0].ok === false, samRuns[0]);

  section("The importer does not write eligibility flags either");
  // Pins the second defence on its own. It is a backstop -- breaking it alone
  // changes no behaviour while normalize() holds -- so nothing observable can
  // check it, and it would rot unnoticed. The invariant is the column list.
  const fs = require("fs");
  const src = fs.readFileSync(path.join(__dirname, "grants.js"), "utf8");
  const colList = src.match(/const cols = \[([\s\S]*?)\];/);
  check("the import column allowlist is findable", !!colList);
  for (const f of FLAGS) {
    check(`"${f}" is not a column the importer writes`, !new RegExp(`"${f}"`).test(colList[1]), colList[1]);
  }

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
