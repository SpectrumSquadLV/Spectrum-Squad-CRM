// grant-connectors.js -- where opportunities come from, and how an outside
// record becomes one of ours.
//
// The brief was blunt about this phase: do not build fake automation. So the
// shape here is deliberate.
//
//   * Every connector declares what it actually needs (`requires`) and reports
//     honestly whether it can run. A source needing an API key nobody has set
//     says so; it does not quietly return nothing and look successful.
//   * The HTTP call is INJECTED (`fetchImpl`). The mapping, the tagging and the
//     refusals are pure and tested against recorded payloads. Only the network
//     hop itself is untested, and it is one line.
//   * normalize() NEVER infers eligibility. This is the important one -- see
//     the note on it below.
//
// Verification status, stated plainly because it matters: the Grants.gov
// adapter is written to that API's documented shape but has NOT been run
// against the live service, because the network this was built on blocks it.
// Its first production run records a sample of the raw payload precisely so a
// mapping that is wrong can be seen and fixed rather than guessed at.

"use strict";

const clean = (s) => String(s == null ? "" : s).trim();

// ---------------------------------------------------------------- tagging
// Keyword -> category. Used only to tag an imported record so it can be found
// and scored; it never decides eligibility.
const TAG_RULES = [
  [/\baba\b|applied behaou?r?ior/i, "aba"],
  [/autism|asd\b/i, "autism"],
  [/behaviou?ral health/i, "behavioral_health"],
  [/mental health/i, "mental_health"],
  [/developmental disabilit/i, "developmental_disabilities"],
  [/child|children|youth|pediatric|paediatric/i, "children_youth"],
  [/health care|healthcare|clinic|medical/i, "healthcare"],
  [/health.{0,12}workforce/i, "healthcare_workforce"],
  [/workforce|apprentice/i, "workforce_development"],
  [/\brbt\b|registered behaviou?r technician/i, "rbt_training"],
  [/staff training|employee training|professional development/i, "employee_training"],
  [/small business/i, "small_business"],
  [/veteran/i, "veteran_owned"],
  [/women|woman-owned|women-owned/i, "woman_owned"],
  [/nevada/i, "nevada"],
  [/clark county/i, "clark_county"],
  [/las vegas/i, "las_vegas"],
  [/technolog|software|digital/i, "technology"],
  [/innovation/i, "healthcare_innovation"],
  [/facility|construction|renovat/i, "facility_expansion"],
  [/equipment/i, "equipment"],
  [/community/i, "community_programs"],
  [/education|school/i, "education"],
  [/school district|school partnership/i, "school_partnerships"],
  [/underserved|undeserved|rural|low.income|disparit/i, "underserved"],
];

function inferTags(...texts) {
  const hay = texts.filter(Boolean).join(" \n ");
  const out = [];
  for (const [re, tag] of TAG_RULES) if (re.test(hay) && !out.includes(tag)) out.push(tag);
  return out;
}

// ------------------------------------------------------------- normalising
// An outside record becomes one of ours WITHOUT any eligibility judgement.
//
// This is the load-bearing decision of the whole phase. The scoring engine
// treats an unrecorded eligibility field as unknown and reports "needs review";
// that guarantee is worth more than the convenience of a robot guessing. A
// funder's applicant-eligibility codes do not map cleanly onto "may a Nevada
// for-profit ABA provider apply", and a wrong yes costs somebody a week.
//
// So: the eligibility text is copied across verbatim for a human to read, and
// every tri-state eligibility flag stays null. An imported grant can never
// arrive already marked Eligible.
function normalize(sourceKey, raw) {
  const map = NORMALIZERS[sourceKey];
  if (!map) return null;
  const g = map(raw);
  if (!g || !clean(g.name)) return null;
  return {
    ...g,
    // Never inferred. Left for the engine to call "needs review" and for a
    // person to fill in after reading the notice.
    for_profit_allowed: null,
    nonprofit_required: null,
    small_business_eligible: null,
    government_only: null,
    university_only: null,
    school_district_only: null,
    tribal_only: null,
    research_institution_only: null,
    veteran_preference: null,
    woman_preference: null,
    matching_funds_required: null,
    partnerships_required: null,
    sam_required: null,
    uei_required: null,
    status: "New",
    tags: inferTags(g.name, g.description, g.applicant_eligibility, g.target_population, g.industry),
  };
}

const NORMALIZERS = {
  // Grants.gov search2. Field names follow that API's documented response;
  // every read is defensive because this mapping has not been seen against
  // the live service (see the header note).
  grants_gov: (r) => ({
    name: clean(r.title || r.opportunityTitle),
    funder: clean(r.agency || r.agencyName || r.agencyCode) || "Grants.gov",
    opportunity_number: clean(r.number || r.opportunityNumber),
    source_url: clean(r.number || r.opportunityNumber)
      ? `https://www.grants.gov/search-results-detail/${clean(r.id || r.opportunityId)}`
      : "",
    description: clean(r.description || r.synopsis || r.oppSynopsis),
    deadline: isoDate(r.closeDate || r.closeDateDisplay),
    opening_date: isoDate(r.openDate || r.postedDate),
    // Verbatim, for a human. Not parsed into flags -- see normalize().
    applicant_eligibility: clean(
      Array.isArray(r.applicantTypes) ? r.applicantTypes.map((t) => t.description || t).join("; ")
        : (r.eligibility || r.applicantEligibility)
    ),
    geographic_eligibility: clean(r.geography) || "National",
    industry: clean(Array.isArray(r.categories) ? r.categories.map((c) => c.description || c).join("; ") : r.category),
    amount_max: num(r.awardCeiling),
    amount_min: num(r.awardFloor),
    expected_award: num(r.awardCeiling),
  }),

  // SAM.gov opportunities. Same treatment.
  sam_gov: (r) => ({
    name: clean(r.title),
    funder: clean(r.fullParentPathName || r.organizationName) || "SAM.gov",
    opportunity_number: clean(r.noticeId || r.solicitationNumber),
    source_url: clean(r.uiLink),
    description: clean(r.description),
    deadline: isoDate(r.responseDeadLine),
    opening_date: isoDate(r.postedDate),
    applicant_eligibility: clean(r.typeOfSetAsideDescription),
    geographic_eligibility: clean(r.placeOfPerformance && r.placeOfPerformance.state
      && (r.placeOfPerformance.state.name || r.placeOfPerformance.state.code)) || "National",
    industry: clean(r.naicsCode),
  }),

  // A pasted export. Accepts our own field names, so anything a human can get
  // out of a portal can come in without an integration existing at all. This
  // is the path that works today.
  paste: (r) => ({
    name: clean(r.name || r.title),
    funder: clean(r.funder || r.agency),
    opportunity_number: clean(r.opportunity_number || r.number),
    source_url: clean(r.source_url || r.url),
    application_url: clean(r.application_url),
    description: clean(r.description),
    deadline: isoDate(r.deadline || r.close_date),
    opening_date: isoDate(r.opening_date || r.open_date),
    applicant_eligibility: clean(r.applicant_eligibility || r.eligibility),
    geographic_eligibility: clean(r.geographic_eligibility || r.geography),
    industry: clean(r.industry || r.category),
    target_population: clean(r.target_population),
    amount_min: num(r.amount_min), amount_max: num(r.amount_max),
    expected_award: num(r.expected_award || r.amount_max),
  }),
};

function isoDate(v) {
  const s = clean(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Grants.gov uses MM/DD/YYYY in several fields.
  const us = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1]}-${us[2]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------- connectors
const CONNECTORS = {
  grants_gov: {
    key: "grants_gov",
    label: "Grants.gov",
    requires: [],
    verified: false,
    docs: "https://www.grants.gov/api/api-guide",
    note: "Public search API, no key needed. Written to the documented shape but not yet run against the live service — the first run records a sample of the response so the mapping can be corrected against reality.",
    async fetch({ fetchImpl, keywords = "autism behavioral health workforce", rows = 25, timeoutMs = 20000 } = {}) {
      // A funder's API that accepts the connection and then never answers would
      // otherwise hold the daily sweep open indefinitely.
      const res = await fetchImpl("https://api.grants.gov/v1/api/search2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyword: keywords, rows, oppStatuses: "forecasted|posted" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, error: `Grants.gov returned ${res.status}` };
      const data = await res.json();
      // The documented envelope is { data: { oppHits: [...] } }; tolerate a
      // bare array or a hits key rather than failing on a shape surprise.
      const hits = (data && data.data && data.data.oppHits) || (data && data.oppHits) || (Array.isArray(data) ? data : []);
      return { ok: true, records: Array.isArray(hits) ? hits : [], raw_sample: hits && hits[0] ? hits[0] : data };
    },
  },

  sam_gov: {
    key: "sam_gov",
    label: "SAM.gov",
    requires: ["SAM_API_KEY"],
    verified: false,
    docs: "https://open.gsa.gov/api/get-opportunities-public-api/",
    note: "Needs a free SAM.gov API key in SAM_API_KEY. Until that is set this connector reports that it cannot run, rather than returning nothing and looking healthy.",
    async fetch({ fetchImpl, rows = 25, ptype = "g", timeoutMs = 20000 } = {}) {
      const key = process.env.SAM_API_KEY;
      if (!key) return { ok: false, error: "SAM_API_KEY is not set." };
      const to = new Date();
      const from = new Date(Date.now() - 30 * 86400000);
      const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
      const url = `https://api.sam.gov/opportunities/v2/search?limit=${rows}&api_key=${encodeURIComponent(key)}`
        + `&postedFrom=${fmt(from)}&postedTo=${fmt(to)}&ptype=${ptype}`;
      const res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ok: false, error: `SAM.gov returned ${res.status}` };
      const data = await res.json();
      const hits = (data && data.opportunitiesData) || [];
      return { ok: true, records: Array.isArray(hits) ? hits : [], raw_sample: hits[0] || data };
    },
  },
};

// Can this source run right now, and if not, why not.
function connectorStatus(key) {
  const c = CONNECTORS[key];
  if (!c) return { key, available: false, reason: "No such connector." };
  const missing = (c.requires || []).filter((v) => !process.env[v]);
  return {
    key: c.key,
    label: c.label,
    requires: c.requires || [],
    verified: !!c.verified,
    docs: c.docs,
    note: c.note,
    available: missing.length === 0,
    reason: missing.length ? `Needs ${missing.join(", ")}.` : null,
  };
}

module.exports = { CONNECTORS, NORMALIZERS, normalize, inferTags, connectorStatus, isoDate, num, TAG_RULES };
