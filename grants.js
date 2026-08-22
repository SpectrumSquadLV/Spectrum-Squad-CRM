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
    CATEGORIES, FUNDING_PRIORITIES, STATUSES, ELIGIBILITY_LABEL, WEIGHTS,
  };
};
