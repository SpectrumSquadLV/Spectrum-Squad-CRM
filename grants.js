// grants.js -- Grant Finder: funding opportunities, eligibility analysis and
// match scoring for Spectrum Squad.
//
// The job this replaces is a person opening thirty websites and reading
// eligibility paragraphs. So the module is built around the reading, not the
// list: an opportunity is only useful once somebody has decided whether we can
// actually apply, and that decision is what the scoring and eligibility engine
// records.
//
// Three deliberate choices.
//
// 1. SCORING AND ELIGIBILITY ARE PURE FUNCTIONS. scoreGrant() and
//    analyzeEligibility() take a grant and a profile and return a number and a
//    verdict. No database, no clock, no network. They are exported so the tests
//    can drive them directly with awkward grants, which is the only way to trust
//    a number that a human is going to act on.
//
// 2. ELIGIBILITY IS NOT THE SCORE. A grant can be a perfect thematic match --
//    autism, Nevada, children -- and still be closed to us because it is
//    501(c)(3) only. Those are different questions and they are answered
//    separately: the score says "how relevant", the eligibility says "may we
//    apply at all". A high score never overrides a disqualification, and a
//    disqualified grant is never shown as a recommendation.
//
// 3. UNKNOWN IS NOT THE SAME AS NO. A blank "for-profit allowed" field means
//    nobody has read that paragraph yet, and it comes back as "Needs review"
//    with the reason attached, never as a quiet yes. Guessing here wastes days
//    of somebody's week.
//
// Phase 1. Additive: new grant_* tables and routes under /api/grants/*.
// Nothing existing is modified.

"use strict";

module.exports = function initGrants(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, readBody, json,
  } = ctx;

  const clean = (s) => String(s == null ? "" : s).trim();
  const parseJson = (s, d) => { try { return typeof s === "string" ? JSON.parse(s) : (s || d); } catch (e) { return d; } };
  // Postgres hands booleans back as true/false, but an imported row may carry
  // "t"/"true"/1. Anything unset stays null -- see design note 3.
  function tri(v) {
    if (v === null || v === undefined || v === "") return null;
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    const s = String(v).trim().toLowerCase();
    if (["true", "t", "yes", "y", "1"].includes(s)) return true;
    if (["false", "f", "no", "n", "0"].includes(s)) return false;
    return null;
  }

  // ------------------------------------------------------------------ roles
  // Grant records are leadership material: who we are asking for money and
  // whether we qualify. Admins and above.
  const VIEW_ROLES = ["owner", "super_admin", "admin"];
  // The organisation's EIN, UEI, SAM registration and revenue band are the
  // fields somebody could do damage with. Owner-level only, and redacted rather
  // than hidden so an admin can still see that the field is filled in.
  const SENSITIVE_ROLES = ["owner", "super_admin"];
  const canView = (u) => !!u && VIEW_ROLES.includes(u.role);
  const canSeeSensitive = (u) => !!u && SENSITIVE_ROLES.includes(u.role);

  // ------------------------------------------------------------- categories
  // The vocabulary shared by grants, the profile and the funding priorities.
  // A grant is tagged with these; the profile says which ones describe us; the
  // priorities say which ones we want money for right now.
  const CATEGORIES = [
    { key: "aba", label: "ABA" },
    { key: "autism", label: "Autism" },
    { key: "behavioral_health", label: "Behavioral Health" },
    { key: "mental_health", label: "Mental Health" },
    { key: "developmental_disabilities", label: "Developmental Disabilities" },
    { key: "children_youth", label: "Children / Youth" },
    { key: "healthcare", label: "Healthcare" },
    { key: "healthcare_workforce", label: "Healthcare Workforce" },
    { key: "workforce_development", label: "Workforce Development" },
    { key: "rbt_training", label: "RBT Training" },
    { key: "employee_training", label: "Employee Training" },
    { key: "small_business", label: "Small Business" },
    { key: "veteran_owned", label: "Veteran-Owned Business" },
    { key: "woman_owned", label: "Woman-Owned Business" },
    { key: "nevada", label: "Nevada" },
    { key: "clark_county", label: "Clark County" },
    { key: "las_vegas", label: "Las Vegas" },
    { key: "technology", label: "Technology" },
    { key: "healthcare_innovation", label: "Healthcare Innovation" },
    { key: "facility_expansion", label: "Facility Expansion" },
    { key: "equipment", label: "Equipment" },
    { key: "community_programs", label: "Community Programs" },
    { key: "education", label: "Education" },
    { key: "school_partnerships", label: "School Partnerships" },
    { key: "underserved", label: "Underserved Populations" },
  ];
  const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
  const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

  // What we might want the money for. Selected priorities add weight to grants
  // tagged with the categories they map to, so the dashboard reorders itself
  // around what we are actually trying to fund this quarter.
  const FUNDING_PRIORITIES = [
    { key: "hire_bcbas", label: "Hire BCBAs", tags: ["healthcare_workforce", "workforce_development", "behavioral_health"] },
    { key: "train_rbts", label: "Train RBTs", tags: ["rbt_training", "healthcare_workforce", "employee_training"] },
    { key: "rbt_workforce_program", label: "Develop RBT workforce program", tags: ["rbt_training", "workforce_development", "healthcare_workforce"] },
    { key: "employee_training", label: "Employee training", tags: ["employee_training", "workforce_development"] },
    { key: "clinic_expansion", label: "Clinic expansion", tags: ["facility_expansion"] },
    { key: "new_clinic", label: "New clinic location", tags: ["facility_expansion"] },
    { key: "furniture", label: "Furniture", tags: ["equipment"] },
    { key: "sensory_equipment", label: "Sensory equipment", tags: ["equipment", "autism"] },
    { key: "therapy_equipment", label: "Therapy equipment", tags: ["equipment"] },
    { key: "vehicles", label: "Vehicles", tags: ["equipment"] },
    { key: "technology", label: "Technology", tags: ["technology", "healthcare_innovation"] },
    { key: "crm_software", label: "CRM / software development", tags: ["technology", "healthcare_innovation"] },
    { key: "telehealth", label: "Telehealth", tags: ["technology", "healthcare_innovation", "healthcare"] },
    { key: "community_outreach", label: "Community outreach", tags: ["community_programs", "underserved"] },
    { key: "school_partnerships", label: "School partnerships", tags: ["school_partnerships", "education"] },
    { key: "scholarships", label: "Scholarships", tags: ["education", "workforce_development"] },
    { key: "parent_education", label: "Parent education", tags: ["education", "community_programs"] },
    { key: "clinical_programs", label: "Clinical programs", tags: ["behavioral_health", "aba"] },
    { key: "research", label: "Research", tags: ["healthcare_innovation"] },
    { key: "new_services", label: "New therapy services", tags: ["behavioral_health", "healthcare"] },
    { key: "marketing", label: "Marketing", tags: ["community_programs"] },
    { key: "admin_infrastructure", label: "Administrative infrastructure", tags: ["technology", "small_business"] },
  ];

  const STATUSES = [
    "New", "Reviewing", "Saved", "Not Eligible", "Not Interested",
    "Preparing Application", "Application Ready", "Submitted", "Awarded", "Declined", "Closed",
  ];

  // Applicant-type restrictions that shut us out outright, and the plain words
  // used to explain each one. Spectrum Squad is a for-profit company, so these
  // are absolute rather than a matter of degree.
  const HARD_RESTRICTIONS = [
    { field: "nonprofit_required", flag: "Nonprofit only",
      why: "This grant appears restricted to 501(c)(3) nonprofit organizations. Spectrum Squad is a for-profit company." },
    { field: "government_only", flag: "Government only",
      why: "Only government agencies may apply." },
    { field: "university_only", flag: "University only",
      why: "Only colleges and universities may apply." },
    { field: "school_district_only", flag: "School district only",
      why: "Only school districts may apply." },
    { field: "tribal_only", flag: "Tribal organization only",
      why: "Only tribal organizations may apply." },
    { field: "research_institution_only", flag: "Research institution only",
      why: "Only research institutions may apply." },
  ];

  // Requirements that do not disqualify us but cost real time, or that we may
  // simply not meet yet. Each one is checked against the profile where the
  // profile knows the answer.
  const READINESS_CHECKS = [
    { field: "sam_required", profile: "sam_registered", flag: "SAM.gov registration required",
      unmet: "Requires an active SAM.gov registration, which the organisation profile does not record as active." },
    { field: "uei_required", profile: "uei", flag: "UEI required",
      unmet: "Requires a UEI, and none is recorded in the organisation profile." },
    { field: "matching_funds_required", profile: null, flag: "Matching funds required",
      unmet: "Requires matching funds, so budget for our own contribution before applying." },
    { field: "partnerships_required", profile: null, flag: "Partnership required",
      unmet: "Requires a formal partner organisation on the application." },
  ];

  // =====================================================================
  // SCORING -- pure. No database, no clock. See design note 1.
  // =====================================================================
  //
  // The weights are deliberately visible rather than tuned in secret: every
  // point the score awards is named in the reasons list, so "84%" can always be
  // read back as the sentences that produced it.
  const WEIGHTS = {
    geography: 18,        // Nevada or national reach
    business_type: 14,    // for-profit small business explicitly allowed
    ownership: 10,        // woman-owned / veteran-owned preference
    mission: 30,          // ABA, autism, behavioural health, children
    capability: 14,       // workforce development, training, technology
    priority: 14,         // matches what we are trying to fund right now
  };

  function grantTags(grant) {
    const tags = parseJson(grant.tags, []) || [];
    return Array.isArray(tags) ? tags.filter((t) => CATEGORY_KEYS.includes(t)) : [];
  }

  // How well the grant's geography fits a Nevada / Clark County provider.
  function geographyPoints(grant, profile, reasons) {
    const geo = clean(grant.geographic_eligibility).toLowerCase();
    const tags = grantTags(grant);
    const state = clean(profile.state || "Nevada").toLowerCase();
    if (tags.includes("nevada") || tags.includes("clark_county") || tags.includes("las_vegas")
        || geo.includes(state) || geo.includes("nevada") || geo.includes(" nv")) {
      reasons.push("Open to Nevada applicants, where Spectrum Squad operates.");
      return WEIGHTS.geography;
    }
    if (geo && /national|nationwide|all states|any state|united states/.test(geo)) {
      reasons.push("National in scope, so Nevada is not a barrier.");
      return Math.round(WEIGHTS.geography * 0.8);
    }
    // Blank is not national. Nobody has read the geography paragraph yet, and
    // scoring it as if they had is the same mistake as assuming a blank
    // for-profit field means yes -- see design note 3. It earns nothing, and
    // eligibility separately reports it as unrecorded rather than as a barrier.
    if (!geo) {
      reasons.push("Geographic eligibility has not been recorded yet.");
      return 0;
    }
    // A named geography that is not ours. Eligibility will usually catch this
    // too; the score reflects it either way.
    return 0;
  }

  function businessTypePoints(grant, profile, reasons) {
    let pts = 0;
    const forProfit = tri(grant.for_profit_allowed);
    const small = tri(grant.small_business_eligible);
    if (forProfit === true) {
      pts += Math.round(WEIGHTS.business_type * 0.6);
      reasons.push("For-profit organisations are explicitly eligible.");
    } else if (forProfit === null) {
      // Unknown earns nothing. It is not evidence.
      reasons.push("Whether for-profit companies may apply has not been recorded yet.");
    }
    if (small === true) {
      pts += Math.round(WEIGHTS.business_type * 0.4);
      reasons.push("Small businesses are eligible.");
    }
    return Math.min(pts, WEIGHTS.business_type);
  }

  function ownershipPoints(grant, profile, reasons) {
    let pts = 0;
    if (tri(grant.woman_preference) === true && tri(profile.woman_owned) === true) {
      pts += Math.round(WEIGHTS.ownership * 0.5);
      reasons.push("Gives preference to woman-owned businesses, and Spectrum Squad is woman-led.");
    }
    if (tri(grant.veteran_preference) === true && tri(profile.veteran_owned) === true) {
      pts += Math.round(WEIGHTS.ownership * 0.5);
      reasons.push("Gives preference to veteran-owned businesses, and Spectrum Squad is veteran-owned.");
    }
    return Math.min(pts, WEIGHTS.ownership);
  }

  // The heart of it: does this money go to the kind of work we do?
  const MISSION_TAGS = ["aba", "autism", "behavioral_health", "mental_health",
    "developmental_disabilities", "children_youth", "healthcare", "underserved"];
  const CAPABILITY_TAGS = ["workforce_development", "healthcare_workforce", "rbt_training",
    "employee_training", "technology", "healthcare_innovation", "facility_expansion",
    "equipment", "community_programs", "education", "school_partnerships", "small_business"];

  function missionPoints(grant, profile, reasons) {
    const tags = grantTags(grant);
    const hits = MISSION_TAGS.filter((t) => tags.includes(t));
    if (!hits.length) return 0;
    // Two strong hits is already a clear thematic match; more is confirmation,
    // not multiplication, so the curve flattens.
    const share = Math.min(hits.length / 3, 1);
    const pts = Math.round(WEIGHTS.mission * share);
    reasons.push(`Funds work we already do: ${hits.map((t) => CATEGORY_LABEL[t]).join(", ").toLowerCase()}.`);
    return pts;
  }

  function capabilityPoints(grant, profile, reasons) {
    const tags = grantTags(grant);
    const hits = CAPABILITY_TAGS.filter((t) => tags.includes(t));
    if (!hits.length) return 0;
    const share = Math.min(hits.length / 3, 1);
    const pts = Math.round(WEIGHTS.capability * share);
    reasons.push(`Supports things we are building: ${hits.map((t) => CATEGORY_LABEL[t]).join(", ").toLowerCase()}.`);
    return pts;
  }

  function priorityPoints(grant, priorities, reasons) {
    if (!priorities || !priorities.length) return 0;
    const tags = grantTags(grant);
    const matched = FUNDING_PRIORITIES
      .filter((p) => priorities.includes(p.key))
      .filter((p) => p.tags.some((t) => tags.includes(t)));
    if (!matched.length) return 0;
    const share = Math.min(matched.length / 2, 1);
    const pts = Math.round(WEIGHTS.priority * share);
    reasons.push(`Matches a current funding priority: ${matched.map((p) => p.label.toLowerCase()).join(", ")}.`);
    return pts;
  }

  // scoreGrant(grant, profile, priorities) -> { score, reasons, explanation }
  function scoreGrant(grant, profile = {}, priorities = []) {
    const reasons = [];
    const score = Math.max(0, Math.min(100,
      geographyPoints(grant, profile, reasons) +
      businessTypePoints(grant, profile, reasons) +
      ownershipPoints(grant, profile, reasons) +
      missionPoints(grant, profile, reasons) +
      capabilityPoints(grant, profile, reasons) +
      priorityPoints(grant, priorities, reasons)
    ));
    return { score, reasons, explanation: explainMatch(score, reasons) };
  }

  function explainMatch(score, reasons) {
    if (!reasons.length) return "Nothing recorded on this opportunity matches Spectrum Squad yet. Fill in its eligibility and categories to score it.";
    const lead = score >= 75 ? "Strong match" : score >= 50 ? "Worth a look" : score >= 25 ? "Weak match" : "Probably not for us";
    return `${lead}. ${reasons.join(" ")}`;
  }

  // =====================================================================
  // ELIGIBILITY -- pure. Answers "may we apply", never "should we".
  // =====================================================================
  //
  // Returns one of: eligible | possibly_eligible | likely_ineligible | needs_review
  function analyzeEligibility(grant, profile = {}) {
    const flags = [];      // things to show before anyone spends time reading
    const blockers = [];   // reasons we cannot apply at all
    const unknowns = [];   // reasons nobody can say yet
    const positives = [];

    const forProfitOrg = tri(profile.for_profit) !== false; // Spectrum Squad is for-profit

    // ---- hard restrictions
    for (const r of HARD_RESTRICTIONS) {
      if (tri(grant[r.field]) === true) {
        // Only a blocker for the kind of organisation we actually are.
        if (r.field !== "nonprofit_required" || forProfitOrg) {
          flags.push(r.flag);
          blockers.push(r.why);
        }
      }
    }
    if (tri(grant.for_profit_allowed) === false && forProfitOrg) {
      flags.push("For-profit companies excluded");
      blockers.push("This grant does not accept applications from for-profit companies.");
    }

    // ---- geography
    const geo = clean(grant.geographic_eligibility).toLowerCase();
    const state = clean(profile.state || "Nevada").toLowerCase();
    const national = !geo || /national|nationwide|all states|any state|united states/.test(geo);
    const mentionsUs = geo.includes(state) || geo.includes("nevada") || geo.includes(" nv") || geo.endsWith(" nv");
    if (geo && !national && !mentionsUs) {
      flags.push("Geographic restriction");
      blockers.push(`Restricted to ${clean(grant.geographic_eligibility)}, which does not include Nevada.`);
    } else if (mentionsUs) {
      positives.push("Nevada applicants are eligible");
    }

    // ---- thresholds we may not clear
    const years = Number(grant.min_years_in_business || 0);
    if (years > 0) {
      const founded = Number(profile.year_founded || 0);
      const age = founded ? new Date().getFullYear() - founded : null;
      flags.push(`Minimum ${years} years in business`);
      if (age !== null && age < years) {
        blockers.push(`Requires ${years} years in business; Spectrum Squad has been operating about ${age}.`);
      } else if (age === null) {
        unknowns.push(`Requires ${years} years in business, and the profile does not record the year founded.`);
      }
    }
    const minRev = Number(grant.min_annual_revenue || 0);
    if (minRev > 0) {
      flags.push("Revenue requirement");
      unknowns.push(`Requires minimum annual revenue of $${minRev.toLocaleString()}; check this against our own figures before applying.`);
    }
    const maxEmp = Number(grant.max_employees || 0);
    if (maxEmp > 0) {
      const emp = Number(profile.employee_count || 0);
      flags.push(`Employee cap: ${maxEmp}`);
      if (emp && emp > maxEmp) {
        blockers.push(`Limited to organisations with ${maxEmp} employees or fewer; we record ${emp}.`);
      }
    }

    // ---- readiness (costly, not fatal)
    for (const c of READINESS_CHECKS) {
      if (tri(grant[c.field]) !== true) continue;
      flags.push(c.flag);
      if (!c.profile) { unknowns.push(c.unmet); continue; }
      const have = c.profile === "sam_registered" ? tri(profile.sam_registered) === true : !!clean(profile[c.profile]);
      if (!have) unknowns.push(c.unmet);
    }

    // ---- the central unknown
    if (tri(grant.for_profit_allowed) === null && !blockers.length) {
      unknowns.push("Whether for-profit companies may apply is not recorded. Read the eligibility section of the notice before spending time on this one.");
    } else if (tri(grant.for_profit_allowed) === true) {
      positives.push("private and for-profit healthcare organisations are explicitly eligible");
    }

    // ---- verdict
    let status, explanation;
    if (blockers.length) {
      status = "likely_ineligible";
      explanation = `Potential issue: ${blockers.join(" ")}`;
    } else if (unknowns.length) {
      status = tri(grant.for_profit_allowed) === true ? "possibly_eligible" : "needs_review";
      explanation = unknowns.join(" ");
    } else if (positives.length) {
      status = "eligible";
      explanation = `Strong eligibility: ${positives.join(", ")}.`;
    } else {
      status = "needs_review";
      explanation = "Not enough of this notice has been recorded to judge eligibility. Fill in the eligibility fields.";
    }
    return { status, explanation, flags, blockers, unknowns };
  }

  const ELIGIBILITY_LABEL = {
    eligible: "Eligible",
    possibly_eligible: "Possibly eligible",
    likely_ineligible: "Likely ineligible",
    needs_review: "Needs review",
  };

  // Score and verdict together, as everything outside this module wants them.
  function assess(grant, profile, priorities) {
    const s = scoreGrant(grant, profile, priorities);
    const e = analyzeEligibility(grant, profile);
    return {
      match_score: s.score,
      match_explanation: s.explanation,
      match_reasons: s.reasons,
      eligibility_status: e.status,
      eligibility_label: ELIGIBILITY_LABEL[e.status],
      eligibility_explanation: e.explanation,
      disqualification_flags: e.flags,
    };
  }

  // =====================================================================
  // SCHEMA
  // =====================================================================
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS grant_opportunities (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      funder TEXT,
      opportunity_number TEXT,
      source_url TEXT,
      application_url TEXT,
      description TEXT,
      amount_min NUMERIC,
      amount_max NUMERIC,
      expected_award NUMERIC,
      opening_date TEXT,
      deadline TEXT,
      geographic_eligibility TEXT,
      applicant_eligibility TEXT,
      for_profit_allowed BOOLEAN,
      nonprofit_required BOOLEAN,
      government_only BOOLEAN,
      university_only BOOLEAN,
      school_district_only BOOLEAN,
      tribal_only BOOLEAN,
      research_institution_only BOOLEAN,
      small_business_eligible BOOLEAN,
      veteran_preference BOOLEAN,
      woman_preference BOOLEAN,
      matching_funds_required BOOLEAN,
      partnerships_required BOOLEAN,
      sam_required BOOLEAN,
      uei_required BOOLEAN,
      min_years_in_business INTEGER,
      min_annual_revenue NUMERIC,
      max_employees INTEGER,
      industry TEXT,
      target_population TEXT,
      tags TEXT,                       -- JSON array of CATEGORY keys
      potential_use TEXT,
      complexity TEXT,                 -- Low | Medium | High
      estimated_effort TEXT,
      requirements TEXT,
      documents_needed TEXT,
      contact TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'New',
      source_id INTEGER,
      match_score INTEGER,
      eligibility_status TEXT,
      eligibility_explanation TEXT,
      dismissed_at TEXT,
      saved_at TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("grants initTables:", e.message));

    // Duplicate detection. A funder's opportunity number is the strongest
    // identifier when it exists; the rest fall back to name+funder and URL.
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS grant_opps_number
      ON grant_opportunities (LOWER(opportunity_number)) WHERE opportunity_number IS NOT NULL AND opportunity_number <> ''`)
      .catch(() => {});
    await dbRun("CREATE INDEX IF NOT EXISTS grant_opps_status ON grant_opportunities (status, deadline)").catch(() => {});

    // One row, id = 1. The reusable facts about Spectrum Squad that both the
    // matching engine and (in a later phase) the narrative drafts read from.
    await dbRun(`CREATE TABLE IF NOT EXISTS grant_org_profile (
      id INTEGER PRIMARY KEY,
      company_name TEXT,
      legal_name TEXT,
      business_type TEXT,
      for_profit BOOLEAN,
      state TEXT,
      county TEXT,
      cities_served TEXT,
      year_founded INTEGER,
      woman_owned BOOLEAN,
      veteran_owned BOOLEAN,
      minority_owned BOOLEAN,
      small_business BOOLEAN,
      industry TEXT,
      naics_codes TEXT,
      npi TEXT,
      employee_count INTEGER,
      clients_served INTEGER,
      populations_served TEXT,
      age_groups TEXT,
      services TEXT,
      mission TEXT,
      description TEXT,
      community_impact TEXT,
      workforce_programs TEXT,
      rbt_training_program TEXT,
      school_partnerships TEXT,
      clinic_locations TEXT,
      expansion_areas TEXT,
      annual_revenue_range TEXT,      -- sensitive
      sam_registered BOOLEAN,          -- sensitive
      uei TEXT,                        -- sensitive
      ein TEXT,                        -- sensitive
      duns TEXT,                       -- sensitive
      certifications TEXT,
      licenses TEXT,
      accreditations TEXT,
      updated_at TEXT,
      updated_by TEXT
    )`).catch((e) => console.error("grants profile initTables:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS grant_funding_priorities (
      key TEXT PRIMARY KEY,
      selected BOOLEAN NOT NULL DEFAULT false,
      updated_at TEXT
    )`).catch((e) => console.error("grants priorities initTables:", e.message));

    // Where opportunities come from. Phase 1 records them and how each one can
    // be reached; nothing here pretends to fetch anything yet -- integration
    // status is the honest field that says so.
    await dbRun(`CREATE TABLE IF NOT EXISTS grant_sources (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT,
      kind TEXT,                       -- federal | state | local | foundation | corporate | business
      integration TEXT,                -- manual | api_available | portal_only
      notes TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TEXT
    )`).catch((e) => console.error("grants sources initTables:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS grant_saved_searches (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      params TEXT,
      created_by TEXT,
      created_at TEXT
    )`).catch((e) => console.error("grants saved searches initTables:", e.message));

    // ---------------------------------------------------------- phase 2
    // One workspace per grant. The deadline is copied from the grant when the
    // workspace opens but kept separately: funders move dates, and an internal
    // target ahead of the real one is a normal way to work.
    await dbRun(`CREATE TABLE IF NOT EXISTS grant_applications (
      id SERIAL PRIMARY KEY,
      grant_id INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'Preparing',
      owner_email TEXT,
      amount_requested NUMERIC,
      loi_deadline TEXT,
      submission_deadline TEXT,
      award_announcement_date TEXT,
      reporting_deadline TEXT,
      follow_up_date TEXT,
      budget_notes TEXT,
      notes TEXT,
      submitted_at TEXT,
      submitted_by TEXT,
      confirmation_ref TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("grant_applications initTables:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS grant_application_questions (
      id SERIAL PRIMARY KEY,
      application_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      sort INTEGER DEFAULT 0,
      updated_at TEXT
    )`).catch((e) => console.error("grant_application_questions initTables:", e.message));

    // One row per narrative section, so sections can be written and reviewed
    // independently. Phase 3 drafts these; phase 2 stores what a human writes.
    await dbRun(`CREATE TABLE IF NOT EXISTS grant_application_narratives (
      id SERIAL PRIMARY KEY,
      application_id INTEGER NOT NULL,
      section_key TEXT NOT NULL,
      content TEXT,
      updated_at TEXT,
      updated_by TEXT
    )`).catch((e) => console.error("grant_application_narratives initTables:", e.message));
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS grant_narrative_section
      ON grant_application_narratives (application_id, section_key)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS grant_application_checklist (
      id SERIAL PRIMARY KEY,
      application_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT false,
      done_at TEXT,
      done_by TEXT,
      sort INTEGER DEFAULT 0
    )`).catch((e) => console.error("grant_application_checklist initTables:", e.message));
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS grant_checklist_item
      ON grant_application_checklist (application_id, key)`).catch(() => {});

    // The reusable document library: W-9, licences, insurance certificates and
    // the rest. Stored the same way client documents are -- bytes on the
    // volume, a row pointing at them -- so there is one storage story.
    await dbRun(`CREATE TABLE IF NOT EXISTS grant_documents (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      filename TEXT,
      mime_type TEXT,
      file_path TEXT,
      external_url TEXT,
      expires_at TEXT,
      notes TEXT,
      uploaded_by TEXT,
      uploaded_at TEXT
    )`).catch((e) => console.error("grant_documents initTables:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS grant_application_documents (
      id SERIAL PRIMARY KEY,
      application_id INTEGER NOT NULL,
      document_id INTEGER,
      requirement TEXT,
      attached_at TEXT
    )`).catch((e) => console.error("grant_application_documents initTables:", e.message));

    // Deadline notices are recorded BEFORE the email goes out, so a crash
    // mid-sweep can never turn into a duplicate blast. Same shape as the
    // certification sweep in people.js, for the same reason.
    await dbRun(`CREATE TABLE IF NOT EXISTS grant_deadline_notices (
      id SERIAL PRIMARY KEY,
      grant_id INTEGER,
      application_id INTEGER,
      kind TEXT NOT NULL,          -- submission | loi | reporting
      stage TEXT NOT NULL,
      sent_at TEXT NOT NULL
    )`).catch((e) => console.error("grant_deadline_notices initTables:", e.message));
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS grant_notice_once
      ON grant_deadline_notices (grant_id, kind, stage)`).catch(() => {});

    // Grant work is staff work. Rather than a second to-do system nobody
    // watches, application tasks are ordinary staff_tasks carrying a grant id,
    // so they land in the assignee's existing Tasks & Alerts queue and inherit
    // its assignment email and due-date reminders.
    await dbRun("ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS grant_id INTEGER").catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS grant_reuse_blocks (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      content TEXT,
      approved BOOLEAN NOT NULL DEFAULT false,
      updated_at TEXT,
      updated_by TEXT
    )`).catch((e) => console.error("grant_reuse_blocks initTables:", e.message));

    // Every assistant run, kept whether it worked or not. An assistant nobody
    // can audit is one nobody should paste into a funding application.
    await dbRun(`CREATE TABLE IF NOT EXISTS grant_ai_runs (
      id SERIAL PRIMARY KEY,
      grant_id INTEGER,
      application_id INTEGER,
      action TEXT NOT NULL,
      ok BOOLEAN NOT NULL,
      model TEXT,
      reason TEXT,
      output TEXT,
      sources TEXT,
      created_at TEXT
    )`).catch((e) => console.error("grant_ai_runs initTables:", e.message));

    // Every discovery run, successful or not. Without this the automation is
    // unfalsifiable: nobody can tell a source that found nothing from one that
    // has been quietly failing for a month.
    await dbRun(`CREATE TABLE IF NOT EXISTS grant_discovery_runs (
      id SERIAL PRIMARY KEY,
      source_key TEXT NOT NULL,
      ok BOOLEAN NOT NULL,
      fetched INTEGER DEFAULT 0,
      imported INTEGER DEFAULT 0,
      duplicates INTEGER DEFAULT 0,
      rejected INTEGER DEFAULT 0,
      high_matches INTEGER DEFAULT 0,
      dry_run BOOLEAN DEFAULT FALSE,
      error TEXT,
      raw_sample TEXT,          -- so a wrong mapping can be seen, not guessed at.
                                -- Truncated for storage, so it is for reading, not re-parsing.
      triggered_by TEXT,
      started_at TEXT,
      finished_at TEXT
    )`).catch((e) => console.error("grant_discovery_runs initTables:", e.message));

    await seedReuseBlocks();
    await seedProfile();
    await seedSources();
  }

  // The profile starts filled in with what is already true and publicly known
  // about Spectrum Squad, so the matching engine is useful on day one rather
  // than after somebody fills in forty fields. Nothing sensitive is guessed:
  // EIN, UEI, SAM and revenue are left blank for a human.
  async function seedProfile() {
    const existing = await dbGet("SELECT id FROM grant_org_profile WHERE id = 1").catch(() => null);
    if (existing) return;
    await dbRun(
      `INSERT INTO grant_org_profile
        (id, company_name, business_type, for_profit, state, county, cities_served,
         woman_owned, veteran_owned, small_business, industry, populations_served,
         age_groups, services, mission, updated_at)
       VALUES (1, ?, ?, true, ?, ?, ?, true, true, true, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        "Spectrum Squad", "For-profit small business", "Nevada", "Clark County",
        "Las Vegas, Henderson",
        "ABA and behavioral health",
        "Children with autism and developmental disabilities, and their families",
        "Children and youth",
        "Applied Behavior Analysis (ABA) therapy, behavioral health services, RBT training and workforce development",
        "Spectrum Squad provides ABA therapy to children with autism and developmental disabilities in southern Nevada, and is building workforce development and RBT training programs.",
        nowISO(),
      ]
    ).catch((e) => console.error("grants seedProfile:", e.message));
  }

  // The places worth watching, recorded with an honest integration status.
  // "manual" means somebody pastes the opportunity in; nothing here claims to
  // scrape. Phase 4 replaces the status on the ones that gain an integration.
  const DEFAULT_SOURCES = [
    ["Grants.gov", "https://www.grants.gov", "federal", "api_available", "Federal opportunity search. Has a public search API worth wiring up in Phase 4."],
    ["SAM.gov", "https://sam.gov", "federal", "api_available", "Contract and assistance listings. API requires a registered key."],
    ["HHS", "https://www.hhs.gov/grants", "federal", "portal_only", "Department of Health and Human Services grant programs."],
    ["HRSA", "https://www.hrsa.gov/grants", "federal", "portal_only", "Health workforce and rural health funding."],
    ["SAMHSA", "https://www.samhsa.gov/grants", "federal", "portal_only", "Behavioral and mental health funding."],
    ["Department of Education", "https://www.ed.gov/grants", "federal", "portal_only", "Education and special education programs."],
    ["Department of Labor", "https://www.dol.gov/grants", "federal", "portal_only", "Workforce development and apprenticeship funding."],
    ["SBA", "https://www.sba.gov/funding-programs", "federal", "portal_only", "Small business programs, including woman-owned and veteran-owned."],
    ["Nevada DHHS", "https://dhhs.nv.gov", "state", "portal_only", "Nevada Department of Health and Human Services."],
    ["Nevada workforce programs", "https://detr.nv.gov", "state", "portal_only", "Nevada workforce and training funding."],
    ["Clark County", "https://www.clarkcountynv.gov", "local", "portal_only", "County community and social service funding."],
    ["City of Las Vegas", "https://www.lasvegasnevada.gov", "local", "portal_only", "City grants and community programs."],
    ["City of Henderson", "https://www.cityofhenderson.com", "local", "portal_only", "City grants and community programs."],
    ["Autism foundations", "", "foundation", "manual", "Autism-specific private foundations. Tracked by hand."],
    ["Disability foundations", "", "foundation", "manual", "Disability services foundations. Tracked by hand."],
    ["Healthcare foundations", "", "foundation", "manual", "Regional and national healthcare funders."],
    ["Corporate grant programs", "", "corporate", "manual", "Corporate giving and community investment programs."],
    ["Veteran business programs", "", "business", "manual", "Veteran-owned small business funding."],
    ["Woman-owned business programs", "", "business", "manual", "Woman-owned small business funding."],
  ];

  // Seeded empty on purpose. A reuse block exists so a human can write and
  // approve it; pre-filling one with invented prose would be the exact failure
  // this module is built to avoid.
  async function seedReuseBlocks() {
    for (const sec of REUSE_SECTIONS) {
      await dbRun(
        "INSERT INTO grant_reuse_blocks (key, label, content, approved, updated_at) VALUES (?, ?, NULL, false, ?) ON CONFLICT (key) DO NOTHING",
        [sec.key, sec.label, nowISO()]
      ).catch(() => {});
    }
  }

  async function seedSources() {
    const row = await dbGet("SELECT COUNT(*) AS n FROM grant_sources").catch(() => ({ n: 1 }));
    if (Number(row && row.n) > 0) return;
    for (const [name, url, kind, integration, notes] of DEFAULT_SOURCES) {
      await dbRun(
        "INSERT INTO grant_sources (name, url, kind, integration, notes, active, created_at) VALUES (?, ?, ?, ?, ?, true, ?)",
        [name, url, kind, integration, notes, nowISO()]
      ).catch(() => {});
    }
  }

  // =====================================================================
  // READING
  // =====================================================================
  async function getProfile() {
    const row = await dbGet("SELECT * FROM grant_org_profile WHERE id = 1").catch(() => null);
    return row || { id: 1, for_profit: true, state: "Nevada" };
  }

  const SENSITIVE_FIELDS = ["annual_revenue_range", "sam_registered", "uei", "ein", "duns"];
  // Redact rather than delete: an admin should be able to see that the EIN is
  // on file without being able to read it.
  function redactProfile(profile, user) {
    if (canSeeSensitive(user)) return profile;
    const out = { ...profile, _redacted: [] };
    for (const f of SENSITIVE_FIELDS) {
      if (out[f] !== null && out[f] !== undefined && out[f] !== "") {
        out[f] = f === "sam_registered" ? null : "••••••••";
        out._redacted.push(f);
      }
    }
    return out;
  }

  async function selectedPriorities() {
    const rows = await dbAll("SELECT key FROM grant_funding_priorities WHERE selected = true").catch(() => []);
    return rows.map((r) => r.key);
  }

  // Every read path goes through here, so a grant is never shown with a stale
  // score: the assessment is recomputed from the current profile and current
  // priorities each time it is read, and the stored columns are only a cache
  // for sorting and filtering in SQL.
  async function decorate(grants) {
    const profile = await getProfile();
    const priorities = await selectedPriorities();
    return grants.map((g) => ({ ...g, tags: grantTags(g), ...assess(g, profile, priorities) }));
  }

  async function listGrants(filters = {}) {
    const where = [];
    const args = [];
    if (filters.status) { where.push("status = ?"); args.push(filters.status); }
    if (!filters.include_dismissed) where.push("dismissed_at IS NULL");
    if (filters.q) {
      where.push("(LOWER(name) LIKE ? OR LOWER(funder) LIKE ? OR LOWER(description) LIKE ? OR LOWER(target_population) LIKE ?)");
      const like = `%${String(filters.q).toLowerCase()}%`;
      args.push(like, like, like, like);
    }
    if (filters.closing_within_days) {
      const days = Number(filters.closing_within_days) || 30;
      const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      where.push("deadline IS NOT NULL AND deadline <> '' AND deadline <= ?");
      args.push(cutoff);
    }
    const sql = `SELECT * FROM grant_opportunities ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY COALESCE(match_score, 0) DESC, deadline ASC NULLS LAST, id DESC`;
    let rows = await dbAll(sql, args).catch(() => []);
    let out = await decorate(rows);
    // Tag and eligibility filters run in JS because both are computed rather
    // than stored in a shape SQL can filter on.
    if (filters.tag) out = out.filter((g) => g.tags.includes(filters.tag));
    if (filters.eligibility) out = out.filter((g) => g.eligibility_status === filters.eligibility);
    if (filters.min_score) out = out.filter((g) => g.match_score >= Number(filters.min_score));
    return out;
  }

  // The six questions the dashboard exists to answer, in one payload.
  async function dashboard() {
    const all = await decorate(await dbAll("SELECT * FROM grant_opportunities WHERE dismissed_at IS NULL").catch(() => []));
    const open = all.filter((g) => !["Closed", "Declined", "Not Interested", "Not Eligible"].includes(g.status));
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const closingSoon = open.filter((g) => g.deadline && g.deadline >= today && g.deadline <= in30);
    const applicable = open.filter((g) => g.eligibility_status !== "likely_ineligible");
    const potential = applicable.reduce((sum, g) => sum + Number(g.expected_award || g.amount_max || 0), 0);
    return {
      totals: {
        active: open.length,
        high_match: open.filter((g) => g.match_score >= 70 && g.eligibility_status !== "likely_ineligible").length,
        closing_30: closingSoon.length,
        preparing: all.filter((g) => ["Preparing Application", "Application Ready"].includes(g.status)).length,
        submitted: all.filter((g) => g.status === "Submitted").length,
        awarded: all.filter((g) => g.status === "Awarded").length,
        declined: all.filter((g) => g.status === "Declined").length,
        potential_funding: potential,
      },
      // Never recommend something we cannot apply for -- see design note 2.
      top: applicable.slice().sort((a, b) => b.match_score - a.match_score).slice(0, 8),
      deadlines: closingSoon.slice().sort((a, b) => String(a.deadline).localeCompare(String(b.deadline))).slice(0, 10),
    };
  }

  // =====================================================================
  // WRITING
  // =====================================================================
  const WRITABLE = [
    "name", "funder", "opportunity_number", "source_url", "application_url", "description",
    "amount_min", "amount_max", "expected_award", "opening_date", "deadline",
    "geographic_eligibility", "applicant_eligibility", "for_profit_allowed", "nonprofit_required",
    "government_only", "university_only", "school_district_only", "tribal_only",
    "research_institution_only", "small_business_eligible", "veteran_preference", "woman_preference",
    "matching_funds_required", "partnerships_required", "sam_required", "uei_required",
    "min_years_in_business", "min_annual_revenue", "max_employees", "industry", "target_population",
    "potential_use", "complexity", "estimated_effort", "requirements", "documents_needed",
    "contact", "notes", "status", "source_id",
  ];
  const BOOLEAN_FIELDS = new Set([
    "for_profit_allowed", "nonprofit_required", "government_only", "university_only",
    "school_district_only", "tribal_only", "research_institution_only", "small_business_eligible",
    "veteran_preference", "woman_preference", "matching_funds_required", "partnerships_required",
    "sam_required", "uei_required",
  ]);
  const NUMBER_FIELDS = new Set([
    "amount_min", "amount_max", "expected_award", "min_years_in_business", "min_annual_revenue",
    "max_employees", "source_id",
  ]);

  function coerce(field, value) {
    if (BOOLEAN_FIELDS.has(field)) return tri(value);
    if (NUMBER_FIELDS.has(field)) {
      if (value === "" || value === null || value === undefined) return null;
      const n = Number(String(value).replace(/[$,]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    return value === undefined ? undefined : clean(value) || null;
  }

  // Duplicate detection, in the order the identifiers can be trusted.
  //
  // An opportunity number is the funder's own identifier: two records carrying
  // the same one are the same grant, so that collision is HARD -- the unique
  // index enforces it and no override gets past it. Name-and-funder and URL are
  // heuristics, and a human who insists can overrule them.
  async function findDuplicate(body, excludeId) {
    const number = clean(body.opportunity_number);
    const name = clean(body.name);
    const funder = clean(body.funder);
    const url = clean(body.source_url);
    const not = excludeId ? " AND id <> ?" : "";
    const tail = excludeId ? [excludeId] : [];
    if (number) {
      const r = await dbGet(`SELECT id, name FROM grant_opportunities WHERE LOWER(opportunity_number) = LOWER(?)${not}`, [number, ...tail]).catch(() => null);
      if (r) return { ...r, on: "opportunity number", hard: true };
    }
    if (url) {
      const r = await dbGet(`SELECT id, name FROM grant_opportunities WHERE LOWER(source_url) = LOWER(?)${not}`, [url, ...tail]).catch(() => null);
      if (r) return { ...r, on: "source URL" };
    }
    if (name && funder) {
      const r = await dbGet(`SELECT id, name FROM grant_opportunities WHERE LOWER(name) = LOWER(?) AND LOWER(COALESCE(funder,'')) = LOWER(?)${not}`, [name, funder, ...tail]).catch(() => null);
      if (r) return { ...r, on: "name and funding organisation" };
    }
    return null;
  }

  // The stored score is a cache for SQL ordering; decorate() is the truth.
  async function restamp(id) {
    const row = await dbGet("SELECT * FROM grant_opportunities WHERE id = ?", [id]).catch(() => null);
    if (!row) return null;
    const a = assess(row, await getProfile(), await selectedPriorities());
    await dbRun(
      "UPDATE grant_opportunities SET match_score = ?, eligibility_status = ?, eligibility_explanation = ?, updated_at = ? WHERE id = ?",
      [a.match_score, a.eligibility_status, a.eligibility_explanation, nowISO(), id]
    ).catch(() => {});
    return { ...row, tags: grantTags(row), ...a };
  }

  // A profile or priority change moves every score, so the cached columns are
  // rebuilt rather than left to drift.
  async function restampAll() {
    const rows = await dbAll("SELECT id FROM grant_opportunities").catch(() => []);
    for (const r of rows) await restamp(r.id);
    return rows.length;
  }

  // =====================================================================
  // PHASE 2 -- application workspace, calendar, deadline alerts, documents
  // =====================================================================

  // The sections a grant narrative is written in. Stored one row each so they
  // can be worked on and reviewed separately.
  const NARRATIVE_SECTIONS = [
    { key: "executive_summary", label: "Executive summary" },
    { key: "statement_of_need", label: "Statement of need" },
    { key: "program_description", label: "Program description" },
    { key: "community_impact", label: "Community impact" },
    { key: "organizational_background", label: "Organisational background" },
    { key: "outcomes", label: "Measurable outcomes" },
    { key: "budget_justification", label: "Budget justification" },
    { key: "sustainability", label: "Sustainability plan" },
  ];

  const APPLICATION_STATUSES = ["Preparing", "Ready to submit", "Submitted", "Awarded", "Declined", "Withdrawn"];

  const DOCUMENT_CATEGORIES = [
    "W-9", "EIN documentation", "Business license", "Professional license",
    "Insurance certificate", "Organization chart", "Leadership bio", "Resume",
    "Financial statement", "Profit & loss", "Budget", "Tax return",
    "Letter of support", "Partnership agreement", "Policy", "Program description",
    "SAM registration", "UEI documentation", "Other",
  ];

  // The checklist a workspace opens with. Conditioned on the grant: there is no
  // point asking somebody to tick "UEI verified" for a funder that never asks
  // for one, and a checklist full of irrelevant lines is a checklist people
  // stop reading.
  function checklistFor(grant) {
    const items = [
      { key: "eligibility", label: "Eligibility confirmed" },
      { key: "budget", label: "Budget completed" },
      { key: "narrative", label: "Narrative completed" },
      { key: "attachments", label: "Required attachments uploaded" },
      { key: "reviewed", label: "Application reviewed" },
      { key: "owner_approval", label: "Owner approval" },
      { key: "submitted", label: "Application submitted" },
      { key: "confirmation", label: "Submission confirmation saved" },
    ];
    const conditional = [];
    if (tri(grant.sam_required) === true) conditional.push({ key: "sam", label: "SAM.gov registration active" });
    if (tri(grant.uei_required) === true) conditional.push({ key: "uei", label: "UEI verified" });
    if (tri(grant.partnerships_required) === true) conditional.push({ key: "letters", label: "Letters of support received" });
    if (tri(grant.matching_funds_required) === true) conditional.push({ key: "match", label: "Matching funds confirmed" });
    // Registration and partnership work comes before the writing, so it sits
    // near the top where it can still change the decision to apply at all.
    const ordered = [items[0], ...conditional, ...items.slice(1)];
    return ordered.map((it, i) => ({ ...it, sort: i }));
  }

  async function ensureApplication(grantId, user) {
    const existing = await dbGet("SELECT * FROM grant_applications WHERE grant_id = ?", [grantId]).catch(() => null);
    if (existing) return existing;
    const grant = await dbGet("SELECT * FROM grant_opportunities WHERE id = ?", [grantId]).catch(() => null);
    if (!grant) return null;
    const r = await dbRun(
      `INSERT INTO grant_applications (grant_id, status, owner_email, submission_deadline, amount_requested, created_by, created_at, updated_at)
       VALUES (?, 'Preparing', ?, ?, ?, ?, ?, ?) RETURNING id`,
      [grantId, user.email, grant.deadline || null, grant.expected_award || grant.amount_max || null, user.email, nowISO(), nowISO()]
    );
    const id = r && r.rows && r.rows[0] ? r.rows[0].id : null;
    if (!id) return null;
    for (const it of checklistFor(grant)) {
      await dbRun(
        "INSERT INTO grant_application_checklist (application_id, key, label, sort) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        [id, it.key, it.label, it.sort]
      ).catch(() => {});
    }
    // The opportunity's own status follows the workspace, so the dashboard
    // counts and the pipeline agree without anyone updating two places.
    await dbRun("UPDATE grant_opportunities SET status = 'Preparing Application', updated_at = ? WHERE id = ?", [nowISO(), grantId]).catch(() => {});
    return dbGet("SELECT * FROM grant_applications WHERE id = ?", [id]);
  }

  // Everything the workspace shows, in one read.
  async function applicationDetail(appId) {
    const app = await dbGet("SELECT * FROM grant_applications WHERE id = ?", [appId]).catch(() => null);
    if (!app) return null;
    const grantRow = await dbGet("SELECT * FROM grant_opportunities WHERE id = ?", [app.grant_id]).catch(() => null);
    const [grant] = grantRow ? await decorate([grantRow]) : [null];
    const [questions, narratives, checklist, docs, tasks] = await Promise.all([
      dbAll("SELECT * FROM grant_application_questions WHERE application_id = ? ORDER BY sort, id", [appId]).catch(() => []),
      dbAll("SELECT * FROM grant_application_narratives WHERE application_id = ?", [appId]).catch(() => []),
      dbAll("SELECT * FROM grant_application_checklist WHERE application_id = ? ORDER BY sort, id", [appId]).catch(() => []),
      dbAll(`SELECT ad.id, ad.requirement, ad.attached_at, d.id AS document_id, d.name, d.category, d.expires_at, d.filename
               FROM grant_application_documents ad LEFT JOIN grant_documents d ON d.id = ad.document_id
              WHERE ad.application_id = ? ORDER BY ad.id`, [appId]).catch(() => []),
      dbAll("SELECT * FROM staff_tasks WHERE grant_id = ? ORDER BY status, due_date NULLS LAST, id", [app.grant_id]).catch(() => []),
    ]);
    const byKey = Object.fromEntries(narratives.map((n) => [n.section_key, n]));
    return {
      application: app,
      grant,
      questions,
      checklist,
      documents: docs,
      tasks,
      narratives: NARRATIVE_SECTIONS.map((sec) => ({
        ...sec,
        content: (byKey[sec.key] || {}).content || "",
        updated_at: (byKey[sec.key] || {}).updated_at || null,
      })),
      progress: {
        done: checklist.filter((c) => c.done).length,
        total: checklist.length,
      },
    };
  }

  // ------------------------------------------------------------- calendar
  // Every date the module knows about, flattened into one list the calendar
  // and the dashboard can both read.
  const DAY_MS = 24 * 60 * 60 * 1000;
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00Z");
    if (isNaN(d.getTime())) return null;
    const today = new Date(nowISO().slice(0, 10) + "T00:00:00Z");
    return Math.round((d.getTime() - today.getTime()) / DAY_MS);
  }

  function eventState(days, submitted) {
    if (submitted) return "submitted";
    if (days === null) return "upcoming";
    if (days < 0) return "closed";
    if (days <= 14) return "urgent";
    return "upcoming";
  }

  async function calendar() {
    const grants = await decorate(await dbAll("SELECT * FROM grant_opportunities WHERE dismissed_at IS NULL").catch(() => []));
    const apps = await dbAll("SELECT * FROM grant_applications").catch(() => []);
    const appByGrant = Object.fromEntries(apps.map((a) => [a.grant_id, a]));
    const events = [];
    const push = (g, kind, label, date, extra = {}) => {
      if (!date) return;
      const days = daysUntil(date);
      events.push({
        grant_id: g.id, grant: g.name, funder: g.funder, kind, label, date, days,
        eligibility_status: g.eligibility_status, eligibility_label: g.eligibility_label,
        state: eventState(days, extra.submitted), ...extra,
      });
    };
    for (const g of grants) {
      const a = appByGrant[g.id];
      const submitted = !!(a && a.submitted_at);
      push(g, "opening", "Opens", g.opening_date);
      push(g, "deadline", "Application deadline", (a && a.submission_deadline) || g.deadline, { submitted, application_id: a && a.id });
      if (a) {
        push(g, "loi", "Letter of intent due", a.loi_deadline, { application_id: a.id });
        push(g, "award", "Award announcement", a.award_announcement_date, { application_id: a.id });
        push(g, "reporting", "Reporting due", a.reporting_deadline, { application_id: a.id });
        push(g, "follow_up", "Follow up", a.follow_up_date, { application_id: a.id });
      }
    }
    events.sort((x, y) => String(x.date).localeCompare(String(y.date)));
    return { events };
  }

  // -------------------------------------------------------- deadline alerts
  // Same shape as the certification sweep in people.js: staged notices, the
  // most urgent crossed stage wins so a sweep that did not run for a week still
  // sends the right one, and the notice is recorded BEFORE the email goes out
  // so a crash cannot produce a duplicate blast.
  const DEADLINE_STAGES = [
    { key: "30", days: 30, level: "heads up" },
    { key: "14", days: 14, level: "action needed" },
    { key: "7", days: 7, level: "urgent" },
    { key: "3", days: 3, level: "urgent" },
    { key: "1", days: 1, level: "urgent" },
    { key: "due", days: 0, level: "due today" },
  ];

  function dueStage(daysLeft) {
    if (daysLeft === null || daysLeft < 0) return null;
    let chosen = null;
    for (const s of DEADLINE_STAGES) if (daysLeft <= s.days) chosen = s;
    return chosen;
  }

  async function alertRecipients() {
    const configured = clean(await ctx.getAppSetting("grant_alert_recipients", ""));
    if (configured) return [...new Set(configured.split(/[,;]/).map((x) => x.trim()).filter(Boolean))];
    const owner = clean(await ctx.getAppSetting("owner_notification_email", ""));
    if (owner) return [owner];
    const row = await dbGet(
      "SELECT email FROM users WHERE role IN ('owner','super_admin') AND email <> 'admin@spectrumsquadlv.com' ORDER BY id LIMIT 1"
    ).catch(() => null);
    return row && row.email ? [row.email] : [];
  }

  // Returns what it did, so the route and the tests can see it rather than
  // inferring it from an inbox.
  async function deadlineSweep({ dryRun = false } = {}) {
    const sent = [];
    const grants = await dbAll(
      `SELECT * FROM grant_opportunities
        WHERE dismissed_at IS NULL AND deadline IS NOT NULL AND deadline <> ''
          AND status NOT IN ('Submitted','Awarded','Declined','Closed','Not Interested','Not Eligible')`
    ).catch(() => []);
    const profile = await getProfile();
    const priorities = await selectedPriorities();
    const to = await alertRecipients();

    for (const g of grants) {
      // Never chase a deadline for something we cannot apply for.
      const a = assess(g, profile, priorities);
      if (a.eligibility_status === "likely_ineligible") continue;
      const app = await dbGet("SELECT * FROM grant_applications WHERE grant_id = ?", [g.id]).catch(() => null);
      if (app && app.submitted_at) continue;
      const deadline = (app && app.submission_deadline) || g.deadline;
      const stage = dueStage(daysUntil(deadline));
      if (!stage) continue;
      const already = await dbGet(
        "SELECT id FROM grant_deadline_notices WHERE grant_id = ? AND kind = 'submission' AND stage = ?",
        [g.id, stage.key]
      ).catch(() => null);
      if (already) continue;
      if (dryRun) { sent.push({ grant_id: g.id, name: g.name, stage: stage.key, days: daysUntil(deadline), dry_run: true }); continue; }
      // Recorded first. See the comment on the table.
      await dbRun(
        "INSERT INTO grant_deadline_notices (grant_id, application_id, kind, stage, sent_at) VALUES (?, ?, 'submission', ?, ?) ON CONFLICT DO NOTHING",
        [g.id, app ? app.id : null, stage.key, nowISO()]
      ).catch(() => {});
      const days = daysUntil(deadline);
      if (to.length && ctx.sendEmail) {
        await ctx.sendEmail({
          to: to.join(", "),
          subject: `Grant deadline ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}: ${g.name}`,
          html: `<p><strong>${esc(g.name)}</strong>${g.funder ? ` &mdash; ${esc(g.funder)}` : ""}</p>
                 <p>Closes <strong>${esc(deadline)}</strong> (${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} away`}).</p>
                 <p>Match ${a.match_score}% &middot; ${esc(a.eligibility_label)}.</p>
                 <p>${esc(a.match_explanation)}</p>
                 ${app ? "<p>An application workspace is already open for this grant.</p>"
                       : "<p>No application workspace has been opened for this grant yet.</p>"}`,
          type: "grant_deadline",
        }).catch((e) => console.error("[grants] deadline email failed:", e.message));
      }
      console.log(`[grants] deadline notice grant=${g.id} stage=${stage.key} days=${days} recipients=${to.length}`);
      sent.push({ grant_id: g.id, name: g.name, stage: stage.key, days });
    }
    return { sent, recipients: to.length };
  }

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ------------------------------------------------------------- documents
  function documentStatus(doc) {
    const d = daysUntil(doc.expires_at);
    if (!doc.expires_at) return { key: "no_expiry", label: "No expiry", days: null };
    if (d < 0) return { key: "expired", label: `Expired ${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ago`, days: d };
    if (d <= 30) return { key: "expiring", label: `Expires in ${d} day${d === 1 ? "" : "s"}`, days: d };
    return { key: "ok", label: `Expires in ${d} days`, days: d };
  }

  // =====================================================================
  // PHASE 3 -- the grant assistant and the reuse library
  // =====================================================================
  //
  // The instruction was: use what we know about Spectrum Squad, and never make
  // anything up. Those pull in opposite directions unless the model is only
  // ever shown facts we actually hold, so that is how this is built.
  //
  //   * profileFacts() emits ONLY the profile fields that are filled in. An
  //     empty field is not sent as an empty string, it is absent. The model
  //     cannot repeat a number it was never given.
  //   * The reuse library is the other source, and only APPROVED blocks are
  //     sent. A half-written paragraph nobody signed off on must not end up in
  //     a funder's inbox.
  //   * Every prompt closes with the same rule: anything not in the material
  //     above is unknown, and must be written as [Information Needed: ...]
  //     rather than guessed.
  //
  // buildAssistantRequest() is pure and exported, so the tests can assert what
  // the model is and is not told without spending a token or needing a key.

  // The reusable paragraphs a grant application is assembled from. Seeded empty
  // and filled in by a human; only approved ones are ever shown to the model.
  const REUSE_SECTIONS = [
    { key: "company_description", label: "Company description" },
    { key: "mission_statement", label: "Mission statement" },
    { key: "history", label: "History" },
    { key: "population_served", label: "Population served" },
    { key: "community_need", label: "Community need" },
    { key: "program_description", label: "Program description" },
    { key: "aba_services", label: "ABA services description" },
    { key: "rbt_workforce_program", label: "RBT workforce program" },
    { key: "leadership_background", label: "Leadership background" },
    { key: "community_impact", label: "Community impact" },
    { key: "goals", label: "Goals" },
    { key: "measurable_outcomes", label: "Measurable outcomes" },
    { key: "sustainability_plan", label: "Sustainability plan" },
    { key: "diversity_access", label: "Diversity and access statement" },
    { key: "veteran_owned", label: "Veteran-owned business description" },
    { key: "woman_led", label: "Woman-led organisation description" },
  ];

  // Profile fields worth telling the model about, in the words a grant reader
  // would use. Sensitive registration details are deliberately absent: an EIN
  // has no business in a generated paragraph.
  const PROFILE_FACTS = [
    ["company_name", "Organisation"],
    ["legal_name", "Legal entity name"],
    ["business_type", "Business type"],
    ["state", "State"],
    ["county", "County"],
    ["cities_served", "Cities served"],
    ["year_founded", "Year founded"],
    ["industry", "Industry"],
    ["employee_count", "Employees"],
    ["clients_served", "Clients served"],
    ["populations_served", "Populations served"],
    ["age_groups", "Age groups served"],
    ["services", "Services provided"],
    ["mission", "Mission"],
    ["description", "Description"],
    ["community_impact", "Community impact"],
    ["workforce_programs", "Workforce programs"],
    ["rbt_training_program", "RBT training program"],
    ["school_partnerships", "School partnerships"],
    ["clinic_locations", "Clinic locations"],
    ["expansion_areas", "Areas of expansion"],
    ["certifications", "Certifications"],
    ["licenses", "Licenses"],
    ["accreditations", "Accreditations"],
    ["naics_codes", "NAICS codes"],
  ];

  // Only what is filled in. Absence is the point -- see the note above.
  function profileFacts(profile = {}) {
    const lines = [];
    for (const [field, label] of PROFILE_FACTS) {
      const v = clean(profile[field]);
      if (v) lines.push(`${label}: ${v}`);
    }
    if (tri(profile.for_profit) === true) lines.push("Tax status: for-profit company (not a 501(c)(3) nonprofit)");
    if (tri(profile.woman_owned) === true) lines.push("Ownership: woman-owned / woman-led");
    if (tri(profile.veteran_owned) === true) lines.push("Ownership: veteran-owned");
    if (tri(profile.minority_owned) === true) lines.push("Ownership: minority-owned");
    if (tri(profile.small_business) === true) lines.push("Size: small business");
    return lines;
  }

  // Only what somebody has approved.
  function approvedBlocks(blocks = []) {
    return blocks.filter((b) => tri(b.approved) === true && clean(b.content));
  }

  function grantFacts(grant = {}) {
    const lines = [];
    const add = (label, v) => { const c = clean(v); if (c) lines.push(`${label}: ${c}`); };
    add("Grant", grant.name);
    add("Funding organisation", grant.funder);
    add("Opportunity number", grant.opportunity_number);
    add("Description", grant.description);
    add("Geographic eligibility", grant.geographic_eligibility);
    add("Applicant eligibility, as written in the notice", grant.applicant_eligibility);
    add("Industry", grant.industry);
    add("Target population", grant.target_population);
    add("Deadline", grant.deadline);
    if (grant.amount_min || grant.amount_max) add("Award range", `${grant.amount_min || "?"} to ${grant.amount_max || "?"}`);
    add("Expected award", grant.expected_award);
    add("Requirements", grant.requirements);
    add("Documents needed", grant.documents_needed);
    const flag = (v, yes) => { if (tri(v) === true) lines.push(yes); };
    flag(grant.for_profit_allowed, "For-profit organisations are eligible");
    flag(grant.nonprofit_required, "Restricted to 501(c)(3) nonprofits");
    flag(grant.small_business_eligible, "Small businesses are eligible");
    flag(grant.woman_preference, "Preference for woman-owned businesses");
    flag(grant.veteran_preference, "Preference for veteran-owned businesses");
    flag(grant.matching_funds_required, "Matching funds are required");
    flag(grant.partnerships_required, "A partner organisation is required");
    flag(grant.sam_required, "An active SAM.gov registration is required");
    flag(grant.uei_required, "A UEI is required");
    if (tri(grant.for_profit_allowed) === null) lines.push("Whether for-profit organisations may apply has NOT been recorded");
    return lines;
  }

  // The rule every prompt ends with. One wording, so it cannot drift between
  // actions and quietly get weaker in one of them.
  const NO_FABRICATION = [
    "Use only the material above. It is everything the CRM holds about Spectrum Squad and this grant.",
    "Never invent a fact, a number, a date, a partner, an outcome or a credential.",
    "Where you need something that is not in the material above, write it inline exactly as",
    "[Information Needed: what is missing] and carry on. Do not guess, do not use a placeholder",
    "like XX or TBD, and do not quietly leave the gap out.",
  ].join(" ");

  const ASSISTANT_ROLE =
    "You are helping Spectrum Squad, an ABA and behavioural health provider in Nevada, work on grant funding. " +
    "Write plainly, for a busy owner, in British-neutral plain English without marketing language.";

  const MISSING_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["missing"],
    properties: {
      missing: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["item", "why"],
          properties: {
            item: { type: "string", description: "The fact or document that is missing" },
            why: { type: "string", description: "What it is needed for" },
          },
        },
      },
    },
  };

  // Each action is a task description; the facts are assembled identically for
  // all of them so no action can accidentally see more than another.
  const ASSISTANT_ACTIONS = {
    explain: { label: "Explain this grant", effort: "low", max: 1500,
      task: "Explain what this grant funds, who it is for, and what applying would involve, in under 200 words." },
    qualify: { label: "Do we qualify?", effort: "high", max: 2000,
      task: "Assess whether Spectrum Squad is eligible to apply. Be direct about anything that disqualifies us, and about anything the notice does not say. Do not treat an unrecorded field as a yes." },
    why_match: { label: "Why are we a match?", effort: "medium", max: 1500,
      task: "Explain why Spectrum Squad is or is not a good fit for this funder's priorities." },
    use_for: { label: "What could we request funding for?", effort: "medium", max: 1500,
      task: "Suggest what Spectrum Squad could legitimately request funding for under this grant, based only on the services and programmes recorded for us." },
    requirements: { label: "Summarise requirements", effort: "low", max: 2000,
      task: "List what the funder requires: eligibility, documents, registrations, partnerships, deadlines. Mark anything the notice does not state." },
    checklist: { label: "Create an application checklist", effort: "medium", max: 2000,
      task: "Produce a checklist of everything that must be done to submit this application, in the order it should be done." },
    missing: { label: "Identify missing information", effort: "medium", max: 2000, schema: MISSING_SCHEMA,
      task: "List every fact, figure or document that would be needed to write a strong application for this grant and that is NOT in the material above. Return them as structured items." },
    narrative: { label: "Draft the narrative", effort: "high", max: 8000,
      task: "Draft a grant narrative for this application, using the approved reusable content where it fits." },
  };

  // The per-section drafting actions, generated from the narrative sections so
  // the two lists cannot drift apart.
  for (const sec of [
    { key: "executive_summary", label: "Executive summary" },
    { key: "statement_of_need", label: "Statement of need" },
    { key: "program_description", label: "Program description" },
    { key: "community_impact", label: "Community impact" },
    { key: "organizational_background", label: "Organisational background" },
    { key: "outcomes", label: "Measurable outcomes" },
    { key: "budget_justification", label: "Budget justification" },
  ]) {
    ASSISTANT_ACTIONS[`draft_${sec.key}`] = {
      label: `Draft: ${sec.label}`,
      effort: "high",
      max: 4000,
      section: sec.key,
      task: `Draft the "${sec.label}" section of this grant application.`,
    };
  }

  // Pure. Everything the model will be shown, assembled from records only.
  function buildAssistantRequest(actionKey, { grant, profile, application, blocks = [], question } = {}) {
    const action = ASSISTANT_ACTIONS[actionKey];
    if (!action) return null;
    const facts = profileFacts(profile);
    const approved = approvedBlocks(blocks);
    const parts = [];

    parts.push("=== WHAT THE CRM HOLDS ABOUT SPECTRUM SQUAD ===");
    parts.push(facts.length ? facts.join("\n") : "(nothing recorded)");

    parts.push("\n=== APPROVED REUSABLE CONTENT ===");
    parts.push(approved.length
      ? approved.map((b) => `--- ${b.label} ---\n${clean(b.content)}`).join("\n\n")
      : "(none approved yet)");

    if (grant) {
      parts.push("\n=== THE GRANT ===");
      parts.push(grantFacts(grant).join("\n") || "(nothing recorded)");
      if (grant.eligibility_explanation) {
        parts.push(`\nThe CRM's own eligibility assessment: ${grant.eligibility_label} -- ${grant.eligibility_explanation}`);
      }
    }

    if (application) {
      const bits = [];
      if (application.amount_requested) bits.push(`Amount we intend to request: ${application.amount_requested}`);
      if (clean(application.budget_notes)) bits.push(`Budget notes: ${clean(application.budget_notes)}`);
      if (clean(application.notes)) bits.push(`Notes: ${clean(application.notes)}`);
      if (bits.length) { parts.push("\n=== OUR APPLICATION SO FAR ==="); parts.push(bits.join("\n")); }
    }

    parts.push(`\n=== TASK ===\n${action.task}`);
    if (clean(question)) parts.push(`\nThe person asking added: ${clean(question)}`);
    parts.push(`\n${NO_FABRICATION}`);

    return {
      system: `${ASSISTANT_ROLE} ${NO_FABRICATION}`,
      user: parts.join("\n"),
      schema: action.schema || null,
      effort: action.effort,
      maxTokens: action.max,
      action: actionKey,
      section: action.section || null,
      // Reported back so the UI can say what the answer was based on, which is
      // the difference between a tool people trust and one they do not.
      sources: { profile_facts: facts.length, approved_blocks: approved.length, has_grant: !!grant },
    };
  }

  async function runAssistant(actionKey, { grantId, applicationId, question } = {}) {
    const action = ASSISTANT_ACTIONS[actionKey];
    if (!action) return { ok: false, reason: "unknown_action", error: "Unknown assistant action." };
    let grant = null, application = null;
    if (applicationId) {
      application = await dbGet("SELECT * FROM grant_applications WHERE id = ?", [applicationId]).catch(() => null);
      if (application) grantId = grantId || application.grant_id;
    }
    if (grantId) {
      const row = await dbGet("SELECT * FROM grant_opportunities WHERE id = ?", [grantId]).catch(() => null);
      if (row) [grant] = await decorate([row]);
    }
    const profile = await getProfile();
    const blocks = await dbAll("SELECT * FROM grant_reuse_blocks").catch(() => []);
    const req = buildAssistantRequest(actionKey, { grant, profile, application, blocks, question });
    const out = await ctx.callClaude(req);
    // Recorded either way. An assistant nobody can audit is one nobody should
    // paste into a funding application.
    await dbRun(
      `INSERT INTO grant_ai_runs (grant_id, application_id, action, ok, model, reason, output, sources, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [grantId || null, applicationId || null, actionKey, !!out.ok, out.model || null,
       out.ok ? null : out.reason, out.ok ? out.text : (out.error || null),
       JSON.stringify(req.sources), nowISO()]
    ).catch(() => {});
    return { ...out, action: actionKey, label: action.label, section: action.section || null, sources: req.sources };
  }

  // =====================================================================
  // PHASE 4 -- discovery: bringing opportunities in from outside
  // =====================================================================
  //
  // The pipeline the brief drew: source -> found -> imported -> read ->
  // eligibility checked -> scored -> high matches surfaced -> owner alerted.
  // Everything after "imported" already existed; this is the front of it.
  //
  // The one thing worth stating loudly: an imported grant is never marked
  // eligible. The connector copies the funder's eligibility wording across
  // verbatim and leaves every tri-state flag null, so the engine reports
  // "needs review" and a human reads the notice. A robot that guessed here
  // would quietly undo the whole point of phase 1.

  const connectors = ctx.connectors || require("./grant-connectors");

  // Import already-normalised records. Returns counts rather than throwing, so
  // a partly-bad batch still lands the good rows.
  async function importOpportunities(records, { sourceKey = "paste", actor = "system" } = {}) {
    let imported = 0, duplicates = 0, rejected = 0;
    const highMatches = [];

    for (const raw of records || []) {
      const g = connectors.normalize(sourceKey, raw);
      if (!g) { rejected++; continue; }

      const dupe = await findDuplicate(g);
      if (dupe) { duplicates++; continue; }

      // Note what is NOT in this list: not one eligibility flag. normalize()
      // already leaves them null, and this allowlist means a feed that hands us
      // "for_profit_allowed": true cannot write it either. Both would have to
      // be changed to make an import able to claim we qualify.
      const cols = ["name", "funder", "opportunity_number", "source_url", "application_url", "description",
        "amount_min", "amount_max", "expected_award", "opening_date", "deadline",
        "geographic_eligibility", "applicant_eligibility", "industry", "target_population"];
      const present = cols.filter((c) => g[c] !== undefined && g[c] !== null && g[c] !== "");
      const r = await dbRun(
        `INSERT INTO grant_opportunities (${present.join(", ")}, tags, status, created_by, created_at, updated_at)
         VALUES (${present.map(() => "?").join(", ")}, ?, 'New', ?, ?, ?) RETURNING id`,
        [...present.map((c) => g[c]), JSON.stringify(g.tags || []),
         actor && actor !== "system" ? `${sourceKey} import (${actor})` : `${sourceKey} import`, nowISO(), nowISO()]
      ).catch((e) => { console.error("[grants] import row failed:", e.message); return null; });
      if (!r || !r.rows || !r.rows[0]) { rejected++; continue; }

      imported++;
      const stored = await restamp(r.rows[0].id);
      // "High match" deliberately excludes anything we could not apply for.
      if (stored && stored.match_score >= 70 && stored.eligibility_status !== "likely_ineligible") {
        highMatches.push(stored);
      }
    }
    return { imported, duplicates, rejected, highMatches };
  }

  async function alertHighMatches(highMatches, sourceLabel) {
    if (!highMatches.length) return 0;
    const to = await alertRecipients();
    if (!to.length || !ctx.sendEmail) return 0;
    await ctx.sendEmail({
      to: to.join(", "),
      subject: `${highMatches.length} new grant${highMatches.length === 1 ? "" : "s"} worth a look`,
      html: `<p>${esc(sourceLabel)} brought in ${highMatches.length} opportunit${highMatches.length === 1 ? "y" : "ies"}
             scoring 70% or better that we are not obviously ineligible for.</p>
             ${highMatches.map((g) => `<p><strong>${esc(g.name)}</strong>${g.funder ? ` &mdash; ${esc(g.funder)}` : ""}<br>
               Match ${g.match_score}% &middot; ${esc(g.eligibility_label)}${g.deadline ? ` &middot; closes ${esc(g.deadline)}` : ""}<br>
               <span style="color:#555;">${esc(g.match_explanation)}</span></p>`).join("")}
             <p style="color:#888;font-size:12px;">Eligibility has not been confirmed on these. The notice still needs reading.</p>`,
      type: "grant_discovery",
    }).catch((e) => console.error("[grants] discovery email failed:", e.message));
    return to.length;
  }

  // One source, one run, recorded either way.
  async function discoveryRun(sourceKey, { triggeredBy = "schedule", fetchImpl, dryRun = false } = {}) {
    const started = nowISO();
    const status = connectors.connectorStatus(sourceKey);
    const record = async (row) => {
      await dbRun(
        `INSERT INTO grant_discovery_runs (source_key, ok, fetched, imported, duplicates, rejected, high_matches,
           dry_run, error, raw_sample, triggered_by, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sourceKey, !!row.ok, row.fetched || 0, row.imported || 0, row.duplicates || 0, row.rejected || 0,
         row.high_matches || 0, !!row.dry_run, row.error || null,
         row.raw_sample ? JSON.stringify(row.raw_sample).slice(0, 4000) : null,
         triggeredBy, started, nowISO()]
      ).catch(() => {});
      return row;
    };

    if (!status.available) {
      return record({ ok: false, error: status.reason || "This source cannot run." });
    }

    const connector = connectors.CONNECTORS[sourceKey];
    let out;
    try {
      out = await connector.fetch({ fetchImpl: fetchImpl || ctx.httpFetch || fetch });
    } catch (e) {
      return record({ ok: false, error: `Could not reach ${status.label}: ${e.message}` });
    }
    if (!out.ok) return record({ ok: false, error: out.error, raw_sample: out.raw_sample });

    // A look before importing. Worth having while an adapter is unverified:
    // it answers "is the mapping right?" without writing a row.
    if (dryRun) {
      const sample = out.records.slice(0, 3).map((r) => connectors.normalize(sourceKey, r)).filter(Boolean);
      await record({ ok: true, fetched: out.records.length, dry_run: true, raw_sample: out.raw_sample });
      return { ok: true, dry_run: true, fetched: out.records.length, sample, raw_sample: out.raw_sample };
    }

    const res = await importOpportunities(out.records, { sourceKey });
    const alerted = await alertHighMatches(res.highMatches, status.label);
    console.log(`[grants] discovery source=${sourceKey} fetched=${out.records.length} imported=${res.imported} `
      + `duplicates=${res.duplicates} high=${res.highMatches.length} alerted=${alerted}`);
    return record({
      ok: true, fetched: out.records.length, imported: res.imported, duplicates: res.duplicates,
      rejected: res.rejected, high_matches: res.highMatches.length, raw_sample: out.raw_sample,
    });
  }

  // Every source that can run, daily.
  async function discoverySweep({ triggeredBy = "schedule", fetchImpl } = {}) {
    const results = [];
    for (const key of Object.keys(connectors.CONNECTORS)) {
      const status = connectors.connectorStatus(key);
      if (!status.available) continue;   // reported in the connectors list, not as a failed run
      results.push({ source: key, ...(await discoveryRun(key, { triggeredBy, fetchImpl })) });
    }
    return { results };
  }

  // =====================================================================
  // API
  // =====================================================================
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/grants")) return false;
    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }
    if (!canView(user)) { json(res, 403, { error: "Not permitted" }); return true; }

    try {
      // ---------------- reference data ----------------
      if (pathname === "/api/grants/meta" && method === "GET") {
        json(res, 200, {
          categories: CATEGORIES,
          priorities: FUNDING_PRIORITIES,
          statuses: STATUSES,
          eligibility_labels: ELIGIBILITY_LABEL,
          can_see_sensitive: canSeeSensitive(user),
        });
        return true;
      }

      if (pathname === "/api/grants/dashboard" && method === "GET") {
        json(res, 200, await dashboard());
        return true;
      }

      // ---------------- opportunities ----------------
      if (pathname === "/api/grants/opportunities" && method === "GET") {
        json(res, 200, { grants: await listGrants(query || {}) });
        return true;
      }

      if (pathname === "/api/grants/opportunities" && method === "POST") {
        const b = await readBody(req);
        const name = clean(b.name);
        if (!name) { json(res, 400, { error: "Give the grant a name." }); return true; }
        const dupe = await findDuplicate(b);
        if (dupe && (dupe.hard || !b.allow_duplicate)) {
          json(res, 409, {
            error: dupe.hard
              ? `“${dupe.name}” already has opportunity number ${clean(b.opportunity_number)}. A funder's opportunity number identifies one grant, so this cannot be added twice.`
              : `“${dupe.name}” is already tracked, matched on ${dupe.on}.`,
            duplicate_id: dupe.id,
            hard: !!dupe.hard,
          });
          return true;
        }
        // name, tags and status are written explicitly below, so they are kept
        // out of the generic field list -- listing a column twice is a 500 from
        // Postgres, and the form always submits a status.
        const fields = WRITABLE.filter((f) => b[f] !== undefined && !["name", "status"].includes(f));
        const cols = ["name", ...fields, "tags", "status", "created_by", "created_at", "updated_at"];
        const vals = [
          name,
          ...fields.map((f) => coerce(f, b[f])),
          JSON.stringify((Array.isArray(b.tags) ? b.tags : []).filter((t) => CATEGORY_KEYS.includes(t))),
          clean(b.status) || "New",
          user.email, nowISO(), nowISO(),
        ];
        const placeholders = cols.map(() => "?").join(", ");
        const r = await dbRun(
          `INSERT INTO grant_opportunities (${cols.join(", ")}) VALUES (${placeholders}) RETURNING id`,
          vals
        );
        const id = r && r.rows && r.rows[0] ? r.rows[0].id : null;
        json(res, 200, { ok: true, grant: id ? await restamp(id) : null });
        return true;
      }

      const one = pathname.match(/^\/api\/grants\/opportunities\/(\d+)$/);
      if (one && method === "GET") {
        const row = await dbGet("SELECT * FROM grant_opportunities WHERE id = ?", [one[1]]);
        if (!row) { json(res, 404, { error: "Not found" }); return true; }
        const [decorated] = await decorate([row]);
        json(res, 200, { grant: decorated });
        return true;
      }

      if (one && method === "PATCH") {
        const b = await readBody(req);
        const fields = WRITABLE.filter((f) => b[f] !== undefined);
        if (fields.length) {
          const dupe = await findDuplicate({ ...b }, Number(one[1]));
          if (dupe && (dupe.hard || !b.allow_duplicate)) {
            json(res, 409, {
              error: dupe.hard
                ? `“${dupe.name}” already has that opportunity number, and a funder's opportunity number identifies one grant.`
                : `“${dupe.name}” is already tracked, matched on ${dupe.on}.`,
              duplicate_id: dupe.id,
              hard: !!dupe.hard,
            });
            return true;
          }
          await dbRun(
            `UPDATE grant_opportunities SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
            [...fields.map((f) => coerce(f, b[f])), nowISO(), one[1]]
          );
        }
        if (Array.isArray(b.tags)) {
          await dbRun("UPDATE grant_opportunities SET tags = ? WHERE id = ?",
            [JSON.stringify(b.tags.filter((t) => CATEGORY_KEYS.includes(t))), one[1]]);
        }
        json(res, 200, { ok: true, grant: await restamp(one[1]) });
        return true;
      }

      if (one && method === "DELETE") {
        await dbRun("DELETE FROM grant_opportunities WHERE id = ?", [one[1]]);
        json(res, 200, { ok: true });
        return true;
      }

      // Save / dismiss are status shortcuts the cards use.
      const act = pathname.match(/^\/api\/grants\/opportunities\/(\d+)\/(save|unsave|dismiss|restore)$/);
      if (act && method === "POST") {
        const [, id, what] = act;
        if (what === "save") await dbRun("UPDATE grant_opportunities SET saved_at = ?, status = CASE WHEN status = 'New' THEN 'Saved' ELSE status END WHERE id = ?", [nowISO(), id]);
        if (what === "unsave") await dbRun("UPDATE grant_opportunities SET saved_at = NULL WHERE id = ?", [id]);
        if (what === "dismiss") await dbRun("UPDATE grant_opportunities SET dismissed_at = ?, status = 'Not Interested' WHERE id = ?", [nowISO(), id]);
        if (what === "restore") await dbRun("UPDATE grant_opportunities SET dismissed_at = NULL WHERE id = ?", [id]);
        json(res, 200, { ok: true, grant: await restamp(id) });
        return true;
      }

      // ---------------- organisation profile ----------------
      if (pathname === "/api/grants/profile" && method === "GET") {
        json(res, 200, { profile: redactProfile(await getProfile(), user), can_edit_sensitive: canSeeSensitive(user) });
        return true;
      }

      if (pathname === "/api/grants/profile" && method === "PATCH") {
        const b = await readBody(req);
        const PROFILE_FIELDS = [
          "company_name", "legal_name", "business_type", "for_profit", "state", "county",
          "cities_served", "year_founded", "woman_owned", "veteran_owned", "minority_owned",
          "small_business", "industry", "naics_codes", "npi", "employee_count", "clients_served",
          "populations_served", "age_groups", "services", "mission", "description",
          "community_impact", "workforce_programs", "rbt_training_program", "school_partnerships",
          "clinic_locations", "expansion_areas", "certifications", "licenses", "accreditations",
          ...(canSeeSensitive(user) ? SENSITIVE_FIELDS : []),
        ];
        const bools = new Set(["for_profit", "woman_owned", "veteran_owned", "minority_owned", "small_business", "sam_registered"]);
        const nums = new Set(["year_founded", "employee_count", "clients_served"]);
        const fields = PROFILE_FIELDS.filter((f) => b[f] !== undefined);
        if (fields.length) {
          await dbRun(
            `UPDATE grant_org_profile SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = 1`,
            [
              ...fields.map((f) => (bools.has(f) ? tri(b[f]) : nums.has(f) ? (Number(b[f]) || null) : clean(b[f]) || null)),
              nowISO(), user.email,
            ]
          );
        }
        // The profile is half of every score.
        const restamped = await restampAll();
        json(res, 200, { ok: true, profile: redactProfile(await getProfile(), user), rescored: restamped });
        return true;
      }

      // ---------------- funding priorities ----------------
      if (pathname === "/api/grants/priorities" && method === "GET") {
        const rows = await dbAll("SELECT key, selected FROM grant_funding_priorities").catch(() => []);
        const on = new Set(rows.filter((r) => r.selected).map((r) => r.key));
        json(res, 200, { priorities: FUNDING_PRIORITIES.map((p) => ({ ...p, selected: on.has(p.key) })) });
        return true;
      }

      if (pathname === "/api/grants/priorities" && method === "PUT") {
        const b = await readBody(req);
        const keys = (Array.isArray(b.keys) ? b.keys : []).filter((k) => FUNDING_PRIORITIES.some((p) => p.key === k));
        await dbRun("DELETE FROM grant_funding_priorities").catch(() => {});
        for (const k of keys) {
          await dbRun("INSERT INTO grant_funding_priorities (key, selected, updated_at) VALUES (?, true, ?) ON CONFLICT (key) DO UPDATE SET selected = true", [k, nowISO()]).catch(() => {});
        }
        const restamped = await restampAll();
        json(res, 200, { ok: true, selected: keys, rescored: restamped });
        return true;
      }

      // ---------------- funding sources ----------------
      if (pathname === "/api/grants/sources" && method === "GET") {
        json(res, 200, { sources: await dbAll("SELECT * FROM grant_sources ORDER BY kind, name").catch(() => []) });
        return true;
      }

      if (pathname === "/api/grants/sources" && method === "POST") {
        const b = await readBody(req);
        const name = clean(b.name);
        if (!name) { json(res, 400, { error: "Give the source a name." }); return true; }
        await dbRun(
          "INSERT INTO grant_sources (name, url, kind, integration, notes, active, created_at) VALUES (?, ?, ?, ?, ?, true, ?)",
          [name, clean(b.url) || null, clean(b.kind) || "foundation", clean(b.integration) || "manual", clean(b.notes) || null, nowISO()]
        );
        json(res, 200, { ok: true });
        return true;
      }

      const src = pathname.match(/^\/api\/grants\/sources\/(\d+)$/);
      if (src && method === "DELETE") {
        await dbRun("DELETE FROM grant_sources WHERE id = ?", [src[1]]);
        json(res, 200, { ok: true });
        return true;
      }

      // ---------------- saved searches ----------------
      if (pathname === "/api/grants/searches" && method === "GET") {
        json(res, 200, { searches: await dbAll("SELECT * FROM grant_saved_searches ORDER BY name").catch(() => []) });
        return true;
      }

      if (pathname === "/api/grants/searches" && method === "POST") {
        const b = await readBody(req);
        const name = clean(b.name);
        if (!name) { json(res, 400, { error: "Name the search." }); return true; }
        await dbRun("INSERT INTO grant_saved_searches (name, params, created_by, created_at) VALUES (?, ?, ?, ?)",
          [name, JSON.stringify(b.params || {}), user.email, nowISO()]);
        json(res, 200, { ok: true });
        return true;
      }

      const sq = pathname.match(/^\/api\/grants\/searches\/(\d+)$/);
      if (sq && method === "DELETE") {
        await dbRun("DELETE FROM grant_saved_searches WHERE id = ?", [sq[1]]);
        json(res, 200, { ok: true });
        return true;
      }

      // ---------------- phase 2: applications ----------------
      if (pathname === "/api/grants/applications" && method === "GET") {
        const rows = await dbAll(
          `SELECT a.*, g.name AS grant_name, g.funder, g.deadline AS grant_deadline, g.match_score, g.eligibility_status
             FROM grant_applications a JOIN grant_opportunities g ON g.id = a.grant_id
            ORDER BY CASE a.status WHEN 'Preparing' THEN 0 WHEN 'Ready to submit' THEN 1 ELSE 2 END,
                     a.submission_deadline NULLS LAST, a.id`
        ).catch(() => []);
        for (const r of rows) {
          const c = await dbGet(
            "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE done) AS done FROM grant_application_checklist WHERE application_id = ?",
            [r.id]
          ).catch(() => ({ total: 0, done: 0 }));
          r.progress = { done: Number(c.done || 0), total: Number(c.total || 0) };
          r.days_left = daysUntil(r.submission_deadline || r.grant_deadline);
        }
        json(res, 200, { applications: rows, statuses: APPLICATION_STATUSES });
        return true;
      }

      if (pathname === "/api/grants/applications" && method === "POST") {
        const b = await readBody(req);
        const app = await ensureApplication(Number(b.grant_id), user);
        if (!app) { json(res, 404, { error: "No such grant." }); return true; }
        json(res, 200, { ok: true, application: app, detail: await applicationDetail(app.id) });
        return true;
      }

      const appOne = pathname.match(/^\/api\/grants\/applications\/(\d+)$/);
      if (appOne && method === "GET") {
        const detail = await applicationDetail(appOne[1]);
        if (!detail) { json(res, 404, { error: "Not found" }); return true; }
        json(res, 200, { ...detail, narrative_sections: NARRATIVE_SECTIONS });
        return true;
      }

      if (appOne && method === "PATCH") {
        const b = await readBody(req);
        const F = ["status", "owner_email", "amount_requested", "loi_deadline", "submission_deadline",
          "award_announcement_date", "reporting_deadline", "follow_up_date", "budget_notes", "notes", "confirmation_ref"];
        const fields = F.filter((f) => b[f] !== undefined);
        if (fields.length) {
          await dbRun(
            `UPDATE grant_applications SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
            [...fields.map((f) => (f === "amount_requested" ? (Number(String(b[f]).replace(/[$,]/g, "")) || null) : clean(b[f]) || null)), nowISO(), appOne[1]]
          );
        }
        json(res, 200, { ok: true, ...(await applicationDetail(appOne[1])) });
        return true;
      }

      // Submitting is the one state change with consequences elsewhere: it
      // stops the deadline chasing and moves the opportunity's own status.
      const appSubmit = pathname.match(/^\/api\/grants\/applications\/(\d+)\/submit$/);
      if (appSubmit && method === "POST") {
        const b = await readBody(req);
        const app = await dbGet("SELECT * FROM grant_applications WHERE id = ?", [appSubmit[1]]).catch(() => null);
        if (!app) { json(res, 404, { error: "Not found" }); return true; }
        await dbRun(
          "UPDATE grant_applications SET status = 'Submitted', submitted_at = ?, submitted_by = ?, confirmation_ref = COALESCE(?, confirmation_ref), updated_at = ? WHERE id = ?",
          [nowISO(), user.email, clean(b.confirmation_ref) || null, nowISO(), app.id]
        );
        await dbRun("UPDATE grant_opportunities SET status = 'Submitted', updated_at = ? WHERE id = ?", [nowISO(), app.grant_id]);
        await dbRun("UPDATE grant_application_checklist SET done = true, done_at = ?, done_by = ? WHERE application_id = ? AND key = 'submitted' AND done = false",
          [nowISO(), user.email, app.id]).catch(() => {});
        json(res, 200, { ok: true, ...(await applicationDetail(app.id)) });
        return true;
      }

      const appCheck = pathname.match(/^\/api\/grants\/applications\/(\d+)\/checklist\/([a-z_]+)$/);
      if (appCheck && method === "PATCH") {
        const b = await readBody(req);
        const done = tri(b.done) === true;
        await dbRun(
          "UPDATE grant_application_checklist SET done = ?, done_at = ?, done_by = ? WHERE application_id = ? AND key = ?",
          [done, done ? nowISO() : null, done ? user.email : null, appCheck[1], appCheck[2]]
        );
        json(res, 200, { ok: true, ...(await applicationDetail(appCheck[1])) });
        return true;
      }

      const appNarr = pathname.match(/^\/api\/grants\/applications\/(\d+)\/narrative\/([a-z_]+)$/);
      if (appNarr && method === "PUT") {
        const b = await readBody(req);
        if (!NARRATIVE_SECTIONS.some((x) => x.key === appNarr[2])) { json(res, 400, { error: "Unknown section" }); return true; }
        await dbRun(
          `INSERT INTO grant_application_narratives (application_id, section_key, content, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (application_id, section_key) DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          [appNarr[1], appNarr[2], String(b.content == null ? "" : b.content), nowISO(), user.email]
        );
        json(res, 200, { ok: true, ...(await applicationDetail(appNarr[1])) });
        return true;
      }

      const appQ = pathname.match(/^\/api\/grants\/applications\/(\d+)\/questions$/);
      if (appQ && method === "POST") {
        const b = await readBody(req);
        const q = clean(b.question);
        if (!q) { json(res, 400, { error: "Give the question some text." }); return true; }
        await dbRun("INSERT INTO grant_application_questions (application_id, question, answer, sort, updated_at) VALUES (?, ?, ?, ?, ?)",
          [appQ[1], q, clean(b.answer) || null, Number(b.sort) || 0, nowISO()]);
        json(res, 200, { ok: true, ...(await applicationDetail(appQ[1])) });
        return true;
      }
      const appQOne = pathname.match(/^\/api\/grants\/applications\/(\d+)\/questions\/(\d+)$/);
      if (appQOne && method === "PATCH") {
        const b = await readBody(req);
        await dbRun("UPDATE grant_application_questions SET answer = ?, updated_at = ? WHERE id = ? AND application_id = ?",
          [String(b.answer == null ? "" : b.answer), nowISO(), appQOne[2], appQOne[1]]);
        json(res, 200, { ok: true, ...(await applicationDetail(appQOne[1])) });
        return true;
      }
      if (appQOne && method === "DELETE") {
        await dbRun("DELETE FROM grant_application_questions WHERE id = ? AND application_id = ?", [appQOne[2], appQOne[1]]);
        json(res, 200, { ok: true, ...(await applicationDetail(appQOne[1])) });
        return true;
      }

      // Tasks are ordinary staff tasks carrying a grant id, so they show up in
      // the assignee's normal queue rather than a second place to look.
      const appTasks = pathname.match(/^\/api\/grants\/applications\/(\d+)\/tasks$/);
      if (appTasks && method === "POST") {
        const b = await readBody(req);
        const title = clean(b.title);
        if (!title) { json(res, 400, { error: "Give the task a title." }); return true; }
        const app = await dbGet("SELECT * FROM grant_applications WHERE id = ?", [appTasks[1]]).catch(() => null);
        if (!app) { json(res, 404, { error: "Not found" }); return true; }
        if (!ctx.createStaffTask) { json(res, 500, { error: "Task creation is not wired up." }); return true; }
        await ctx.createStaffTask({
          title, description: clean(b.description) || null,
          assigned_user_id: b.assigned_user_id ? Number(b.assigned_user_id) : null,
          due_date: clean(b.due_date) || null,
          created_by: user.email,
          grant_id: app.grant_id,
        });
        json(res, 200, { ok: true, ...(await applicationDetail(app.id)) });
        return true;
      }

      // ---------------- phase 2: document library ----------------
      if (pathname === "/api/grants/documents" && method === "GET") {
        const docs = await dbAll("SELECT * FROM grant_documents ORDER BY category, name").catch(() => []);
        json(res, 200, {
          documents: docs.map((d) => ({ ...d, status: documentStatus(d) })),
          categories: DOCUMENT_CATEGORIES,
        });
        return true;
      }

      if (pathname === "/api/grants/documents" && method === "POST") {
        const b = await readBody(req);
        const name = clean(b.name);
        if (!name) { json(res, 400, { error: "Give the document a name." }); return true; }
        let filePath = null, filename = null, mime = null;
        if (b.content_base64) {
          if (!ctx.saveDocument) { json(res, 500, { error: "File storage is not wired up." }); return true; }
          const saved = ctx.saveDocument({
            prefix: "grant",
            filename: clean(b.filename) || name,
            contentBase64: String(b.content_base64),
          });
          if (!saved.ok) { json(res, saved.status || 400, { error: saved.error }); return true; }
          filePath = saved.stored_name; filename = clean(b.filename) || name; mime = clean(b.mime_type) || "application/octet-stream";
        }
        await dbRun(
          `INSERT INTO grant_documents (name, category, filename, mime_type, file_path, external_url, expires_at, notes, uploaded_by, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [name, clean(b.category) || "Other", filename, mime, filePath, clean(b.external_url) || null,
           clean(b.expires_at) || null, clean(b.notes) || null, user.email, nowISO()]
        );
        json(res, 200, { ok: true });
        return true;
      }

      const docOne = pathname.match(/^\/api\/grants\/documents\/(\d+)$/);
      if (docOne && method === "PATCH") {
        const b = await readBody(req);
        const F = ["name", "category", "expires_at", "notes", "external_url"];
        const fields = F.filter((f) => b[f] !== undefined);
        if (fields.length) {
          await dbRun(`UPDATE grant_documents SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`,
            [...fields.map((f) => clean(b[f]) || null), docOne[1]]);
        }
        json(res, 200, { ok: true });
        return true;
      }
      if (docOne && method === "DELETE") {
        await dbRun("DELETE FROM grant_application_documents WHERE document_id = ?", [docOne[1]]).catch(() => {});
        await dbRun("DELETE FROM grant_documents WHERE id = ?", [docOne[1]]);
        json(res, 200, { ok: true });
        return true;
      }

      const appDocs = pathname.match(/^\/api\/grants\/applications\/(\d+)\/documents$/);
      if (appDocs && method === "POST") {
        const b = await readBody(req);
        await dbRun("INSERT INTO grant_application_documents (application_id, document_id, requirement, attached_at) VALUES (?, ?, ?, ?)",
          [appDocs[1], b.document_id ? Number(b.document_id) : null, clean(b.requirement) || null, nowISO()]);
        json(res, 200, { ok: true, ...(await applicationDetail(appDocs[1])) });
        return true;
      }
      const appDocOne = pathname.match(/^\/api\/grants\/applications\/(\d+)\/documents\/(\d+)$/);
      if (appDocOne && method === "DELETE") {
        await dbRun("DELETE FROM grant_application_documents WHERE id = ? AND application_id = ?", [appDocOne[2], appDocOne[1]]);
        json(res, 200, { ok: true, ...(await applicationDetail(appDocOne[1])) });
        return true;
      }

      // ---------------- phase 2: calendar and alerts ----------------
      if (pathname === "/api/grants/calendar" && method === "GET") {
        json(res, 200, await calendar());
        return true;
      }

      if (pathname === "/api/grants/deadline-sweep" && method === "POST") {
        const b = await readBody(req).catch(() => ({}));
        json(res, 200, await deadlineSweep({ dryRun: tri(b.dry_run) === true }));
        return true;
      }

      // ---------------- phase 3: the assistant ----------------
      if (pathname === "/api/grants/ai/actions" && method === "GET") {
        json(res, 200, {
          actions: Object.entries(ASSISTANT_ACTIONS).map(([key, a]) => ({ key, label: a.label, section: a.section || null })),
          configured: ctx.aiConfigured ? ctx.aiConfigured() : false,
        });
        return true;
      }

      if (pathname === "/api/grants/ai" && method === "POST") {
        const b = await readBody(req);
        const out = await runAssistant(clean(b.action), {
          grantId: b.grant_id ? Number(b.grant_id) : null,
          applicationId: b.application_id ? Number(b.application_id) : null,
          question: clean(b.question),
        });
        if (!out.ok) {
          // An install with no key, or a refusal, is a 200 with an honest
          // reason rather than an error the UI has to guess at.
          json(res, out.reason === "unknown_action" ? 400 : 200, {
            ok: false, reason: out.reason, error: out.error, action: out.action,
          });
          return true;
        }
        json(res, 200, {
          ok: true, action: out.action, label: out.label, section: out.section,
          text: out.text, parsed: out.parsed, model: out.model, sources: out.sources,
        });
        return true;
      }

      // Save a drafted section straight onto the application, so a draft the
      // owner is happy with does not have to be copied by hand.
      const aiSave = pathname.match(/^\/api\/grants\/applications\/(\d+)\/narrative\/([a-z_]+)\/from-ai$/);
      if (aiSave && method === "POST") {
        const b = await readBody(req);
        if (!NARRATIVE_SECTIONS.some((x) => x.key === aiSave[2])) { json(res, 400, { error: "Unknown section" }); return true; }
        await dbRun(
          `INSERT INTO grant_application_narratives (application_id, section_key, content, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (application_id, section_key) DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          [aiSave[1], aiSave[2], String(b.content == null ? "" : b.content), nowISO(), `${user.email} (AI draft)`]
        );
        json(res, 200, { ok: true, ...(await applicationDetail(aiSave[1])) });
        return true;
      }

      // ---------------- phase 3: the reuse library ----------------
      if (pathname === "/api/grants/reuse" && method === "GET") {
        const rows = await dbAll("SELECT * FROM grant_reuse_blocks").catch(() => []);
        const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
        json(res, 200, {
          blocks: REUSE_SECTIONS.map((sec) => ({
            ...sec,
            content: (byKey[sec.key] || {}).content || "",
            approved: (byKey[sec.key] || {}).approved === true,
            updated_at: (byKey[sec.key] || {}).updated_at || null,
            updated_by: (byKey[sec.key] || {}).updated_by || null,
          })),
        });
        return true;
      }

      const reuseOne = pathname.match(/^\/api\/grants\/reuse\/([a-z_]+)$/);
      if (reuseOne && method === "PUT") {
        if (!REUSE_SECTIONS.some((x) => x.key === reuseOne[1])) { json(res, 400, { error: "Unknown block" }); return true; }
        const b = await readBody(req);
        const sec = REUSE_SECTIONS.find((x) => x.key === reuseOne[1]);
        await dbRun(
          `INSERT INTO grant_reuse_blocks (key, label, content, approved, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, approved = EXCLUDED.approved,
             updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          [reuseOne[1], sec.label, String(b.content == null ? "" : b.content), tri(b.approved) === true, nowISO(), user.email]
        );
        json(res, 200, { ok: true });
        return true;
      }

      // The audit trail. Owner-level, because it contains everything the
      // assistant has been asked and everything it answered.
      if (pathname === "/api/grants/ai/runs" && method === "GET") {
        if (!canSeeSensitive(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        json(res, 200, {
          runs: await dbAll("SELECT * FROM grant_ai_runs ORDER BY id DESC LIMIT 50").catch(() => []),
        });
        return true;
      }

      // ---------------- phase 4: discovery ----------------
      if (pathname === "/api/grants/connectors" && method === "GET") {
        const list = Object.keys(connectors.CONNECTORS).map((k) => connectors.connectorStatus(k));
        for (const c of list) {
          c.last_run = await dbGet(
            "SELECT * FROM grant_discovery_runs WHERE source_key = ? ORDER BY id DESC LIMIT 1", [c.key]
          ).catch(() => null);
        }
        json(res, 200, { connectors: list });
        return true;
      }

      if (pathname === "/api/grants/discovery/run" && method === "POST") {
        const b = await readBody(req);
        const key = clean(b.source);
        if (key && !connectors.CONNECTORS[key]) { json(res, 400, { error: "No such source." }); return true; }
        const out = key
          ? await discoveryRun(key, { triggeredBy: user.email, dryRun: tri(b.dry_run) === true })
          : await discoverySweep({ triggeredBy: user.email });
        json(res, 200, out);
        return true;
      }

      if (pathname === "/api/grants/discovery/runs" && method === "GET") {
        json(res, 200, {
          runs: await dbAll("SELECT * FROM grant_discovery_runs ORDER BY id DESC LIMIT 40").catch(() => []),
        });
        return true;
      }

      // The path that works with no integration at all: paste what a portal
      // gave you. Same normalisation, same dedupe, same refusal to guess
      // eligibility as an automated source.
      if (pathname === "/api/grants/import" && method === "POST") {
        const b = await readBody(req);
        let rows = b.records;
        if (typeof rows === "string") {
          try { rows = JSON.parse(rows); }
          catch (e) { json(res, 400, { error: "That did not parse as JSON." }); return true; }
        }
        if (!Array.isArray(rows)) { json(res, 400, { error: "Expected a JSON array of opportunities." }); return true; }
        const res2 = await importOpportunities(rows, { sourceKey: "paste", actor: user.email });
        await alertHighMatches(res2.highMatches, "a pasted import");
        await dbRun(
          `INSERT INTO grant_discovery_runs (source_key, ok, fetched, imported, duplicates, rejected, high_matches, triggered_by, started_at, finished_at)
           VALUES ('paste', true, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [rows.length, res2.imported, res2.duplicates, res2.rejected, res2.highMatches.length, user.email, nowISO(), nowISO()]
        ).catch(() => {});
        json(res, 200, {
          ok: true, fetched: rows.length, imported: res2.imported, duplicates: res2.duplicates,
          rejected: res2.rejected, high_matches: res2.highMatches.length,
        });
        return true;
      }

      json(res, 404, { error: "Unknown grants route" });
      return true;
    } catch (e) {
      console.error("[grants] api error:", e.message);
      json(res, 500, { error: e.message });
      return true;
    }
  }

  return {
    initTables, handleApi,
    // exported for the tests and for later phases
    scoreGrant, analyzeEligibility, assess, dashboard, listGrants,
    deadlineSweep, calendar, checklistFor, documentStatus, daysUntil, dueStage,
    buildAssistantRequest, runAssistant, profileFacts, approvedBlocks, grantFacts,
    importOpportunities, discoveryRun, discoverySweep, alertHighMatches,
    ASSISTANT_ACTIONS, REUSE_SECTIONS, NO_FABRICATION,
    NARRATIVE_SECTIONS, APPLICATION_STATUSES, DOCUMENT_CATEGORIES, DEADLINE_STAGES,
    CATEGORIES, FUNDING_PRIORITIES, STATUSES, ELIGIBILITY_LABEL, WEIGHTS,
  };
};
