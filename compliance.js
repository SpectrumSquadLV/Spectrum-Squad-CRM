// compliance.js -- the Compliance & Certification Hub: ONE library of the
// training this practice requires, for everybody who works here.
//
// It is NOT part of the BCBA Onboarding Academy, and that is the whole point.
// HIPAA is required of an RBT, a BCBA, the front desk and the Clinical
// Director alike. Built inside the Academy it would have been BCBA-only, and
// the day RBT onboarding wanted HIPAA there would have been a second copy of
// it -- two courses, two completion records, and an RBT sitting through
// training they had already done. So the library is central and the
// onboarding programmes REFERENCE it.
//
// WHAT THIS FILE OWNS: the library (what courses exist) and the rules (who
// each one is required of, and how often). Assignment, delivery, quizzes,
// certificates and the leadership dashboard build on these and come after.
//
// WHAT IT DELIBERATELY REUSES, because none of it needed rebuilding:
//
//   crm_policies + crm_policy_acknowledgments   a course whose delivery is
//                                 "acknowledge a policy" POINTS at the policy.
//                                 Acknowledgments there are already one row
//                                 per person per VERSION of the policy.
//   staff_certifications          an externally issued certificate, with its
//                                 expiry and the staged reminder ladder that
//                                 already chases it (45/30/15 for an RBT
//                                 certification, 90/60/30/14/7/1 otherwise).
//   hr_employees                  the one employee database, including the
//                                 department each person is in.
//   positionGroup()               the title classifier staff-progression.js
//                                 already uses. One vocabulary, so "RBT"
//                                 cannot come to mean two different things.
//
// TWO THINGS IT WILL NOT DO.
//
//   IT SHIPS NO RENEWAL INTERVALS. Every interval is configurable and blank
//   until somebody sets it. The brief says requirements follow "applicable
//   laws, contracts, and company policies", and a number invented here would
//   be read as that law -- a wrong renewal period on mandatory reporter
//   training is worse than an empty field that is visibly waiting for one.
//
//   IT NEVER DELETES A COURSE. Training history has to be auditable years
//   later, and a completion that points at a course nobody can look up any
//   more is not a record. Retiring a course clears it from the library and
//   leaves every transcript intact.
"use strict";

module.exports = function initCompliance(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json } = ctx;
  const getAppSetting = ctx.getAppSetting || (async (k, f) => f);
  const setAppSetting = ctx.setAppSetting || (async () => {});
  // The title classifier and the position list come from staff-progression so
  // there is exactly one answer to "what position is this person".
  const positionGroup = ctx.positionGroup || ((t) => (t ? "unset" : "unset"));
  const POSITIONS = ctx.POSITIONS || [{ key: "unset", label: "Position not set" }];

  const clean = (v) => (v == null ? "" : String(v).trim());
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(clean(v));
  const today = () => nowISO().slice(0, 10);

  // ---- WHO MAY DO WHAT ----------------------------------------------------
  //
  // AUTHORING THE TRAINING IS THE PRACTICE OWNER'S, AND NOBODY ELSE'S.
  //
  // Asked for in those words: nobody but her edits the training or adds the
  // documents. It is a defensible line rather than a quirk -- what the
  // practice requires of its staff, and the material it hands them to satisfy
  // it, is the thing a licensing body or an insurer will hold her to. HR runs
  // onboarding and clinical leadership reads the compliance picture; neither
  // rewrites the curriculum.
  //
  const canManage = (u) => !!u && u.role === "owner";
  const isClinicalLead = ctx.isClinicalLead || (async (u) => !!u && ["owner", "super_admin"].includes(u.role));
  // Reading is wider than writing: HR runs onboarding and clinical leadership
  // has to see where the practice stands.
  //
  // The training-only "employee" role is refused here explicitly, and that
  // check is load-bearing rather than belt-and-braces: clinical-lead status
  // is decided by EMAIL, not by role, so an employee-role login whose address
  // carries that designation would otherwise read the whole library.
  const VIEW_ROLES = ["owner", "admin", "super_admin", "hr_admin"];
  async function canView(user) {
    if (!user || user.role === "employee") return false;
    if (VIEW_ROLES.includes(user.role)) return true;
    if (canManage(user)) return true;
    return await isClinicalLead(user);
  }

  // ---- WHAT A COURSE IS ---------------------------------------------------
  //
  // `delivery` is how somebody completes it, and it is the field that decides
  // what "completed" is even allowed to mean:
  //
  //   internal              we deliver it: materials to read or watch here,
  //                         and a quiz if the course has one.
  //   external_link         we send them somewhere else to take it, and they
  //                         tell us when it is done.
  //   external_certificate  a provider issues the certificate (CPR, BLS, a
  //                         state registry). Completion means a certificate
  //                         on file, and it is checked rather than claimed.
  //   policy_ack            reading a policy and acknowledging it IS the
  //                         course. It points at a policy row; the policy
  //                         text is never copied in here.
  const DELIVERY = [
    { key: "internal", label: "Delivered here", certificate: true },
    { key: "external_link", label: "Taken elsewhere, self-reported", certificate: false },
    { key: "external_certificate", label: "Provider certificate on file", certificate: false },
    { key: "policy_ack", label: "Policy acknowledgment", certificate: false },
  ];
  const DELIVERY_KEYS = DELIVERY.map((d) => d.key);

  // Who a course is required of.
  const SCOPES = [
    { key: "all", label: "Required of everybody" },
    { key: "position", label: "Required of a position" },
    { key: "department", label: "Required of a department" },
    { key: "optional", label: "Optional professional development" },
  ];
  const SCOPE_KEYS = SCOPES.map((s) => s.key);

  // CHANGING ONE OF THESE CHANGES WHAT COMPLETING THE COURSE MEANS, so it
  // forks a new version and last year's completions keep pointing at the
  // version they were earned against. Fixing a typo in the title does not:
  // a version bump that means nothing teaches people to ignore versions.
  const VERSIONED_FIELDS = ["delivery", "policy_id", "external_url", "passing_score"];

  // ======================= SCHEMA ============================
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS compliance_courses (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      delivery TEXT NOT NULL DEFAULT 'internal',
      policy_id INTEGER,
      external_url TEXT,
      provider TEXT,
      passing_score INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      retired_at TEXT,
      retired_by TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_by TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("compliance_courses:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS compliance_course_rules (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL,
      scope TEXT NOT NULL,
      position_group TEXT,
      department_key TEXT,
      renewal_months INTEGER,
      due_days INTEGER,
      effective_from TEXT,
      created_by TEXT,
      created_at TEXT
    )`).catch((e) => console.error("compliance_course_rules:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS compliance_rules_course ON compliance_course_rules (course_id)").catch(() => {});

    // Every change to a course or its rules, with who and when. A renewal
    // interval is a compliance decision; "it has always said 24 months" needs
    // to be answerable without anybody's word for it.
    // WHAT ACTUALLY HAPPENED. Requirements are computed from the rules every
    // time they are asked for (see the assignment engine below); completions
    // are the durable half, because a transcript has to survive a rule being
    // rewritten years later.
    //
    // There is deliberately NO unique key on (employee, course, version): a
    // course that renews is completed again and again, and each sitting is a
    // row. The key includes the DATE so that recording the same sitting twice
    // is refused while a renewal is not.
    //
    // `hours` is TRAINING hours and nothing else. It is never written to any
    // billable table and never counted as service delivery -- the brief asks
    // for the two to be tracked separately, and mixing them would put
    // training time into a client's authorisation.
    await dbRun(`CREATE TABLE IF NOT EXISTS compliance_completions (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      course_version INTEGER NOT NULL,
      completed_on TEXT NOT NULL,
      source TEXT NOT NULL,
      hours REAL,
      expires_on TEXT,
      evidence_note TEXT,
      verified_by TEXT,
      verified_at TEXT,
      recorded_by TEXT,
      recorded_at TEXT,
      UNIQUE (employee_id, course_id, course_version, completed_on)
    )`).catch((e) => console.error("compliance_completions:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS compliance_completions_emp ON compliance_completions (employee_id)").catch(() => {});
    await dbRun("CREATE INDEX IF NOT EXISTS compliance_completions_course ON compliance_completions (course_id)").catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS compliance_audit (
      id SERIAL PRIMARY KEY,
      course_id INTEGER,
      change TEXT NOT NULL,
      changed_by TEXT,
      changed_at TEXT
    )`).catch((e) => console.error("compliance_audit:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS compliance_audit_course ON compliance_audit (course_id)").catch(() => {});

    await seedLibrary();
    console.log("Compliance & Certification Hub schema ready.");
  }

  // THE SEVEN COURSES THE BRIEF NAMES, as library entries and nothing more.
  //
  // Seeded WITHOUT RULES on purpose. A course with no rule is required of
  // nobody, so this adds a library and assigns no training: the moment a rule
  // is set, that is a decision somebody made about who has to do what, with
  // their name on it in the audit trail. Seeding rules instead would have
  // assigned company-wide training to every employee on the next restart,
  // which is not a thing software should decide.
  //
  // Delivery kinds are a starting point and every one of them is editable.
  const SEED = [
    { key: "hipaa", title: "HIPAA Privacy & Security", delivery: "internal",
      summary: "Protected health information: what it is, how it may be used, and what to do about a suspected breach." },
    { key: "harassment_prevention", title: "Sexual Harassment Prevention", delivery: "internal",
      summary: "Recognising harassment, the practice's standards of conduct, and how to report without fear of retaliation." },
    { key: "mandatory_reporter", title: "Nevada Mandatory Reporter Training", delivery: "external_link",
      summary: "Who is a mandated reporter in Nevada, what has to be reported, to whom, and how quickly." },
    { key: "ethics_conduct", title: "Workplace Ethics & Professional Conduct", delivery: "internal",
      summary: "Professional boundaries, conflicts of interest, social media and dual relationships." },
    { key: "client_rights", title: "Client Rights & Abuse Prevention", delivery: "internal",
      summary: "The rights of the people we serve, recognising abuse and neglect, and the duty to report it." },
    { key: "infection_control", title: "Infection Control & Bloodborne Pathogens", delivery: "internal",
      summary: "Standard precautions, hand hygiene, exposure response and safe handling." },
    { key: "emergency_safety", title: "Emergency Preparedness & Workplace Safety", delivery: "internal",
      summary: "Fire, evacuation, severe weather, medical emergencies and incident reporting." },
  ];
  async function seedLibrary() {
    if (clean(await getAppSetting("compliance_library_seeded", "")) === "1") return;
    let added = 0;
    for (const c of SEED) {
      try {
        const r = await dbRun(
          `INSERT INTO compliance_courses (key, title, summary, delivery, version, active, created_by, created_at, updated_by, updated_at)
           VALUES (?,?,?,?,1,TRUE,'Spectrum Squad',?,'Spectrum Squad',?)
           ON CONFLICT (key) DO NOTHING RETURNING id`,
          [c.key, c.title, c.summary, c.delivery, nowISO(), nowISO()]);
        if (r && r.rows && r.rows.length) {
          added++;
          await audit(r.rows[0].id, `Added to the library as a starting point: ${c.title}. Required of nobody until a rule is set.`, "Spectrum Squad");
        }
      } catch (e) { console.error("compliance seed:", e.message); return; }
    }
    if (added) console.log(`Compliance: ${added} course(s) added to the library, each required of nobody until a rule is set.`);
    await setAppSetting("compliance_library_seeded", "1").catch(() => {});
  }

  async function audit(courseId, change, who) {
    await dbRun("INSERT INTO compliance_audit (course_id, change, changed_by, changed_at) VALUES (?,?,?,?)",
      [courseId || null, change, who || "system", nowISO()]).catch(() => {});
  }

  // ======================= READING THE LIBRARY ================
  function publicRule(r) {
    return {
      id: r.id, scope: r.scope,
      position_group: r.position_group || null,
      department_key: r.department_key || null,
      renewal_months: r.renewal_months == null ? null : Number(r.renewal_months),
      due_days: r.due_days == null ? null : Number(r.due_days),
      effective_from: r.effective_from || null,
      created_by: r.created_by || null, created_at: r.created_at || null,
    };
  }
  // Rows are built field by field from an allowlist, never by spreading a
  // database row, so a column added later cannot leak into a payload.
  function publicCourse(c, rules) {
    const applies = (rules || []).filter((r) => r.scope !== "optional");
    return {
      id: c.id, key: c.key, title: c.title, summary: c.summary || null,
      delivery: c.delivery, delivery_label: (DELIVERY.find((d) => d.key === c.delivery) || {}).label || c.delivery,
      policy_id: c.policy_id == null ? null : Number(c.policy_id),
      external_url: c.external_url || null,
      provider: c.provider || null,
      passing_score: c.passing_score == null ? null : Number(c.passing_score),
      version: Number(c.version || 1),
      active: !!c.active,
      retired_at: c.retired_at || null,
      rules: (rules || []).map(publicRule),
      // Said plainly, because a library entry that is required of nobody
      // looks identical to one that is required of everybody otherwise.
      required_of: !applies.length ? "Nobody yet — no rule set"
        : applies.some((r) => r.scope === "all") ? "Everybody"
        : applies.map((r) => r.scope === "position"
            ? ((POSITIONS.find((p) => p.key === r.position_group) || {}).label || r.position_group)
            : r.department_key).filter(Boolean).join(", "),
      renews: (() => {
        const months = applies.map((r) => r.renewal_months).filter((m) => m != null);
        if (!applies.length) return null;
        if (!months.length) return "Once, no renewal set";
        return months.length === 1 ? `Every ${months[0]} months`
          : `Every ${Math.min(...months)}–${Math.max(...months)} months, by rule`;
      })(),
      updated_at: c.updated_at || null, updated_by: c.updated_by || null,
    };
  }

  async function library({ includeRetired = false } = {}) {
    const courses = await dbAll(
      `SELECT * FROM compliance_courses ${includeRetired ? "" : "WHERE active = TRUE"} ORDER BY title`).catch(() => []);
    const rules = await dbAll("SELECT * FROM compliance_course_rules ORDER BY id").catch(() => []);
    const byCourse = new Map();
    rules.forEach((r) => {
      if (!byCourse.has(r.course_id)) byCourse.set(r.course_id, []);
      byCourse.get(r.course_id).push(r);
    });
    return courses.map((c) => publicCourse(c, byCourse.get(c.id) || []));
  }

  // The vocabulary the configuration screen needs, so it never invents its
  // own list of positions or departments.
  async function vocabulary() {
    const depts = await dbAll("SELECT key, name FROM departments ORDER BY name").catch(() => []);
    return {
      delivery: DELIVERY.map((d) => ({ key: d.key, label: d.label, certificate: d.certificate })),
      scopes: SCOPES,
      positions: POSITIONS.filter((p) => p.key !== "unset"),
      departments: depts.map((d) => ({ key: d.key, name: d.name })),
    };
  }

  // ======================= WRITING =============================
  function validateCourse(b, { creating }) {
    const out = {};
    if (creating || b.title !== undefined) {
      const title = clean(b.title).slice(0, 200);
      if (!title) return { error: "A course needs a title." };
      out.title = title;
    }
    if (b.summary !== undefined) out.summary = clean(b.summary).slice(0, 2000) || null;
    if (creating || b.delivery !== undefined) {
      const d = clean(b.delivery) || "internal";
      if (!DELIVERY_KEYS.includes(d)) return { error: `Delivery must be one of: ${DELIVERY_KEYS.join(", ")}.` };
      out.delivery = d;
    }
    if (b.provider !== undefined) out.provider = clean(b.provider).slice(0, 200) || null;
    if (b.external_url !== undefined) {
      const u = clean(b.external_url).slice(0, 500);
      if (u && !/^https?:\/\//i.test(u)) return { error: "A training link must start with http:// or https://." };
      out.external_url = u || null;
    }
    if (b.policy_id !== undefined) {
      const n = Number(b.policy_id);
      out.policy_id = b.policy_id === null || b.policy_id === "" ? null : (Number.isInteger(n) && n > 0 ? n : NaN);
      if (Number.isNaN(out.policy_id)) return { error: "That is not a policy." };
    }
    if (b.passing_score !== undefined) {
      if (b.passing_score === null || b.passing_score === "") out.passing_score = null;
      else {
        const n = Number(b.passing_score);
        if (!Number.isInteger(n) || n < 1 || n > 100) return { error: "A passing score is a whole percentage from 1 to 100." };
        out.passing_score = n;
      }
    }
    return { fields: out };
  }

  // A key is derived from the title once, at creation, and never changes:
  // completion records point at it, so renaming a course must not orphan
  // everybody's transcript.
  async function freeKey(title) {
    const base = clean(title).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "course";
    for (let i = 0; i < 50; i++) {
      const key = i ? `${base}_${i + 1}` : base;
      const taken = await dbGet("SELECT id FROM compliance_courses WHERE key = ?", [key]).catch(() => null);
      if (!taken) return key;
    }
    return `${base}_${Date.now().toString(36)}`;
  }

  async function createCourse(user, b) {
    const v = validateCourse(b, { creating: true });
    if (v.error) return { status: 400, error: v.error };
    const f = v.fields;
    if (f.delivery === "policy_ack" && !f.policy_id) {
      return { status: 400, error: "A policy acknowledgment course has to say which policy." };
    }
    const who = clean(user.name) || clean(user.email) || "HR";
    const key = await freeKey(f.title);
    const row = await dbRun(
      `INSERT INTO compliance_courses (key, title, summary, delivery, policy_id, external_url, provider, passing_score,
         version, active, created_by, created_at, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,TRUE,?,?,?,?) RETURNING id`,
      [key, f.title, f.summary || null, f.delivery, f.policy_id || null, f.external_url || null,
       f.provider || null, f.passing_score == null ? null : f.passing_score, who, nowISO(), who, nowISO()]);
    const id = row.rows[0].id;
    await audit(id, `Course created: ${f.title} (${f.delivery}). Required of nobody until a rule is set.`, who);
    return { status: 201, id };
  }

  async function updateCourse(user, id, b) {
    const before = await dbGet("SELECT * FROM compliance_courses WHERE id = ?", [id]).catch(() => null);
    if (!before) return { status: 404, error: "No such course." };
    const v = validateCourse(b, { creating: false });
    if (v.error) return { status: 400, error: v.error };
    const f = v.fields;
    const who = clean(user.name) || clean(user.email) || "HR";

    const delivery = f.delivery !== undefined ? f.delivery : before.delivery;
    const policyId = f.policy_id !== undefined ? f.policy_id : before.policy_id;
    if (delivery === "policy_ack" && !policyId) {
      return { status: 400, error: "A policy acknowledgment course has to say which policy." };
    }

    // Did anything change what COMPLETING this course means?
    const changed = Object.keys(f).filter((k) => String(f[k] == null ? "" : f[k]) !== String(before[k] == null ? "" : before[k]));
    if (!changed.length) return { status: 200, ok: true, unchanged: true };
    const forks = changed.some((k) => VERSIONED_FIELDS.includes(k));
    const nextVersion = forks ? Number(before.version || 1) + 1 : Number(before.version || 1);

    const sets = Object.keys(f);
    await dbRun(
      `UPDATE compliance_courses SET ${sets.map((k) => `${k} = ?`).join(", ")}, version = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [...sets.map((k) => f[k]), nextVersion, who, nowISO(), id]);
    await audit(id, forks
      ? `Changed ${changed.join(", ")} — this changes what completing the course means, so it is now version ${nextVersion}. Records already earned keep version ${before.version}.`
      : `Changed ${changed.join(", ")}.`, who);
    return { status: 200, ok: true, version: nextVersion, forked: forks };
  }

  // RETIRED, NOT DELETED. A transcript that points at a course nobody can
  // look up any more is not a record.
  async function retireCourse(user, id, retire) {
    const before = await dbGet("SELECT * FROM compliance_courses WHERE id = ?", [id]).catch(() => null);
    if (!before) return { status: 404, error: "No such course." };
    const who = clean(user.name) || clean(user.email) || "HR";
    await dbRun("UPDATE compliance_courses SET active = ?, retired_at = ?, retired_by = ?, updated_by = ?, updated_at = ? WHERE id = ?",
      [!retire, retire ? nowISO() : null, retire ? who : null, who, nowISO(), id]);
    await audit(id, retire
      ? `Retired. It is assigned to nobody new; every completion already recorded against it is kept.`
      : `Brought back into the library.`, who);
    return { status: 200, ok: true };
  }

  function validateRule(r) {
    const scope = clean(r && r.scope);
    if (!SCOPE_KEYS.includes(scope)) return { error: `Scope must be one of: ${SCOPE_KEYS.join(", ")}.` };
    const out = { scope, position_group: null, department_key: null };
    if (scope === "position") {
      const p = clean(r.position_group);
      if (!POSITIONS.some((x) => x.key === p && x.key !== "unset")) return { error: "That is not a position." };
      out.position_group = p;
    }
    if (scope === "department") {
      out.department_key = clean(r.department_key);
      if (!out.department_key) return { error: "A department rule has to name a department." };
    }
    if (r.renewal_months === null || r.renewal_months === undefined || r.renewal_months === "") out.renewal_months = null;
    else {
      const n = Number(r.renewal_months);
      if (!Number.isInteger(n) || n < 1 || n > 120) return { error: "A renewal interval is a whole number of months from 1 to 120." };
      out.renewal_months = n;
    }
    if (r.due_days === null || r.due_days === undefined || r.due_days === "") out.due_days = null;
    else {
      const n = Number(r.due_days);
      if (!Number.isInteger(n) || n < 0 || n > 365) return { error: "Days to complete is a whole number from 0 to 365." };
      out.due_days = n;
    }
    if (r.effective_from !== undefined && clean(r.effective_from)) {
      if (!isDate(r.effective_from)) return { error: "Effective from must be a calendar date (YYYY-MM-DD)." };
      out.effective_from = clean(r.effective_from).slice(0, 10);
    } else out.effective_from = null;
    return { rule: out };
  }

  async function setRules(user, courseId, list) {
    const course = await dbGet("SELECT * FROM compliance_courses WHERE id = ?", [courseId]).catch(() => null);
    if (!course) return { status: 404, error: "No such course." };
    if (!Array.isArray(list)) return { status: 400, error: "Send a list of rules." };
    const who = clean(user.name) || clean(user.email) || "HR";

    const parsed = [];
    for (const r of list) {
      const v = validateRule(r);
      if (v.error) return { status: 400, error: v.error };
      parsed.push(v.rule);
    }
    // A department named in a rule has to be a department, or the rule
    // silently matches nobody and nobody notices the training is missing.
    for (const r of parsed) {
      if (!r.department_key) continue;
      const d = await dbGet("SELECT key FROM departments WHERE key = ?", [r.department_key]).catch(() => null);
      if (!d) return { status: 400, error: "That is not one of the departments on file." };
    }
    const seen = new Set();
    for (const r of parsed) {
      const sig = [r.scope, r.position_group, r.department_key].join("|");
      if (seen.has(sig)) return { status: 400, error: "The same rule is in the list twice." };
      seen.add(sig);
    }

    const beforeRules = await dbAll("SELECT * FROM compliance_course_rules WHERE course_id = ? ORDER BY id", [courseId]).catch(() => []);
    await dbRun("DELETE FROM compliance_course_rules WHERE course_id = ?", [courseId]);
    for (const r of parsed) {
      await dbRun(
        `INSERT INTO compliance_course_rules (course_id, scope, position_group, department_key, renewal_months, due_days, effective_from, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [courseId, r.scope, r.position_group, r.department_key, r.renewal_months, r.due_days,
         r.effective_from || today(), who, nowISO()]);
    }
    const describe = (rs) => rs.length
      ? rs.map((r) => [r.scope, r.position_group, r.department_key].filter(Boolean).join(" ")
          + (r.renewal_months ? ` every ${r.renewal_months}m` : " once")).join("; ")
      : "nobody";
    await audit(courseId, `Who it is required of: ${describe(beforeRules)} → ${describe(parsed)}.`, who);
    return { status: 200, ok: true };
  }

  // ======================= WHO HAS TO DO WHAT ==================
  //
  // THE ASSIGNMENT ENGINE. Requirements are COMPUTED, never stored as rows.
  //
  // That is the design the brief forces, in its own words: "avoid creating
  // duplicate training records when a course is required by multiple
  // onboarding programs", and nobody should "repeat the same current training
  // simply because it appears in multiple onboarding programs". A computed set
  // is keyed by course, so two programmes both asking for HIPAA produce ONE
  // requirement and one completion satisfies both. There is no second row to
  // go stale, and nothing to clean up when somebody changes department or a
  // rule is rewritten -- the next read simply asks the rules again.
  //
  // What IS stored is what actually happened: completions, with who verified
  // them. History is the durable half.

  // Dates, kept small and explicit rather than pulling in a library.
  function addDays(iso, n) {
    if (!isDate(iso)) return null;
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function addMonths(iso, n) {
    if (!isDate(iso)) return null;
    const d = new Date(`${iso}T00:00:00Z`);
    const day = d.getUTCDate();
    d.setUTCMonth(d.getUTCMonth() + n);
    // 31 January plus one month is the end of February, not the 3rd of March.
    if (d.getUTCDate() < day) d.setUTCDate(0);
    return d.toISOString().slice(0, 10);
  }
  function daysUntil(iso) {
    if (!isDate(iso)) return null;
    return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400000);
  }

  // ONE employee database, as the brief requires: this looks the person up in
  // hr_employees rather than keeping a second roster. user_id is the real
  // link; the email match is the fallback for a record created before the
  // login existed, which is the normal order of events in hiring.
  async function employeeForUser(user) {
    if (!user) return null;
    let emp = null;
    if (user.id != null) {
      emp = await dbGet("SELECT * FROM hr_employees WHERE user_id = ?", [user.id]).catch(() => null);
    }
    if (!emp && clean(user.email)) {
      emp = await dbGet("SELECT * FROM hr_employees WHERE LOWER(email) = LOWER(?)", [clean(user.email)]).catch(() => null);
    }
    return emp;
  }

  // Does this rule catch this person? Positions come from the shared title
  // classifier so "RBT" means one thing across the CRM; departments come from
  // the employee's own department field.
  function appliesTo(rule, emp) {
    if (rule.scope === "all") return true;
    if (rule.scope === "position") {
      return !!rule.position_group && rule.position_group === positionGroup(emp.role_title);
    }
    if (rule.scope === "department") {
      return !!rule.department_key && rule.department_key === clean(emp.department_key);
    }
    return false; // optional is never required
  }

  function because(rule, deptNames) {
    if (rule.scope === "all") return "Required of everybody";
    if (rule.scope === "position") {
      return `Required of ${(POSITIONS.find((p) => p.key === rule.position_group) || {}).label || rule.position_group}`;
    }
    if (rule.scope === "department") {
      return `Required of ${deptNames.get(rule.department_key) || rule.department_key}`;
    }
    return "Optional professional development";
  }

  // Where one course stands for one person.
  function evaluate(course, applicable, emp, comps, ack, deptNames, { optional = false } = {}) {
    // SEVERAL RULES CAN CATCH ONE PERSON -- "everybody", plus "every RBT".
    // That is one requirement, and where the rules disagree the stricter
    // number wins: the shorter deadline, the shorter renewal. Two rules must
    // never become two things to complete.
    const nums = (f) => applicable.map((r) => r[f]).filter((v) => v != null)
      .map(Number).filter((v) => Number.isFinite(v));
    const dueDays = nums("due_days").length ? Math.min(...nums("due_days")) : null;
    const renewal = nums("renewal_months").length ? Math.min(...nums("renewal_months")) : null;
    const effective = applicable.map((r) => r.effective_from).filter(isDate).sort()[0] || null;

    const mine = comps.filter((c) => c.course_id === course.id);
    const verified = mine.filter((c) => !!c.verified_at)
      .sort((a, b) => String(a.completed_on).localeCompare(String(b.completed_on)));
    const waiting = mine.filter((c) => !c.verified_at)
      .sort((a, b) => String(a.completed_on).localeCompare(String(b.completed_on)));

    // A policy acknowledgment IS the completion, read from the existing
    // acknowledgment table. Nothing is copied into compliance_completions for
    // it -- that would be the duplicate record the brief rules out, and the
    // acknowledgment is already one row per person per policy VERSION.
    let latest = verified[verified.length - 1] || null;
    let completed_on = latest ? latest.completed_on : null;
    let earned_version = latest ? Number(latest.course_version) : null;
    let completion_source = latest ? latest.source : null;
    let verified_by = latest ? latest.verified_by : null;
    if (course.delivery === "policy_ack") {
      completed_on = ack && ack.current_on ? String(ack.current_on).slice(0, 10) : null;
      earned_version = completed_on ? Number(course.version) : null;
      completion_source = completed_on ? "policy_ack" : null;
      // The system watched them do it, so there is nothing for a human to
      // check -- but it says so rather than borrowing somebody's name.
      verified_by = completed_on ? "Recorded automatically on acknowledgment" : null;
      latest = null;
    }

    let state, due_on = null;
    if (completed_on) {
      if (renewal != null) {
        due_on = addMonths(completed_on, renewal);
        state = daysUntil(due_on) < 0 ? "overdue" : "complete";
      } else {
        state = "complete"; // once, and no renewal interval has been set
      }
    } else if (waiting.length) {
      // SUBMITTED IS NOT COMPLETE. Self-reported training and a filed
      // certificate both sit here until somebody checks them: the brief wants
      // certificates generated only after VERIFIED completion, and nothing
      // approved merely because time passed or a document was opened.
      state = "submitted";
    } else {
      // The clock starts at the later of their hire date and the day the rule
      // took effect, so a rule written this morning does not land on a
      // five-year employee already overdue.
      const anchor = [emp.hire_date, effective].filter(isDate).sort().pop() || null;
      due_on = dueDays != null && anchor ? addDays(anchor, dueDays) : null;
      state = due_on ? (daysUntil(due_on) < 0 ? "overdue" : "due") : "no_deadline";
    }
    if (optional) state = completed_on ? "complete" : "optional";

    return {
      course_id: course.id, key: course.key, title: course.title, summary: course.summary || null,
      delivery: course.delivery,
      delivery_label: (DELIVERY.find((d) => d.key === course.delivery) || {}).label || course.delivery,
      provider: course.provider || null,
      external_url: course.external_url || null,
      policy_id: course.policy_id == null ? null : Number(course.policy_id),
      version: Number(course.version || 1),
      optional: !!optional,
      required_because: optional ? "Optional professional development"
        : applicable.map((r) => because(r, deptNames)).join("; "),
      renewal_months: renewal,
      due_days: dueDays,
      state,
      due_on,
      days_left: due_on ? daysUntil(due_on) : null,
      completed_on: completed_on || null,
      completion_source,
      verified_by: verified_by || null,
      // Completed against an earlier version of the course. It still counts --
      // they did the training, and nobody should be marked non-compliant
      // because a link was corrected -- but it is visible so the owner can
      // decide a retake is warranted. That is a judgement, not arithmetic.
      earned_version,
      superseded: earned_version != null && earned_version < Number(course.version || 1),
      submitted: waiting.length
        ? { id: waiting[waiting.length - 1].id, completed_on: waiting[waiting.length - 1].completed_on,
            source: waiting[waiting.length - 1].source }
        : null,
      // TRAINING HISTORY, preserved: every sitting, oldest first.
      history: mine
        .sort((a, b) => String(a.completed_on).localeCompare(String(b.completed_on)))
        .map((c) => ({
          id: c.id, completed_on: c.completed_on, course_version: Number(c.course_version),
          source: c.source, hours: c.hours == null ? null : Number(c.hours),
          expires_on: c.expires_on || null,
          verified_by: c.verified_by || null, verified_at: c.verified_at || null,
        })),
      policy: course.delivery === "policy_ack" && ack
        ? { id: ack.policy_id, title: ack.title, version: ack.version,
            acknowledged_version: ack.acknowledged_version || null }
        : null,
      // Acknowledging a policy happens on the policy, not here.
      can_self_report: course.delivery !== "policy_ack",
    };
  }

  const STATE_ORDER = { overdue: 0, due: 1, submitted: 2, no_deadline: 3, complete: 4, optional: 5 };

  // One person's whole training picture.
  async function trainingRecord(emp) {
    const courses = await dbAll("SELECT * FROM compliance_courses WHERE active = TRUE ORDER BY title").catch(() => []);
    const rules = await dbAll("SELECT * FROM compliance_course_rules ORDER BY id").catch(() => []);
    const comps = await dbAll("SELECT * FROM compliance_completions WHERE employee_id = ?", [emp.id]).catch(() => []);
    const depts = await dbAll("SELECT key, name FROM departments").catch(() => []);
    const deptNames = new Map(depts.map((d) => [d.key, d.name]));

    const byCourse = new Map();
    rules.forEach((r) => {
      if (!byCourse.has(r.course_id)) byCourse.set(r.course_id, []);
      byCourse.get(r.course_id).push(r);
    });

    // Policy-acknowledgment courses, resolved against the live policy and the
    // acknowledgments already on file. Acknowledgments are keyed on the USER
    // id, which is why an employee with no login shows as not acknowledged
    // rather than as mysteriously complete.
    const policyIds = courses.filter((c) => c.delivery === "policy_ack" && c.policy_id).map((c) => Number(c.policy_id));
    const ackByPolicy = new Map();
    if (policyIds.length) {
      for (const pid of [...new Set(policyIds)]) {
        const pol = await dbGet("SELECT id, title, version FROM crm_policies WHERE id = ?", [pid]).catch(() => null);
        if (!pol) continue;
        const version = String((pol.version == null ? "1" : pol.version)).trim() || "1";
        let rows = [];
        if (emp.user_id != null) {
          rows = await dbAll(
            "SELECT policy_version, acknowledged_at FROM crm_policy_acknowledgments WHERE policy_id = ? AND employee_id = ?",
            [pid, emp.user_id]).catch(() => []);
        }
        const current = rows.find((r) => String(r.policy_version).trim() === version) || null;
        ackByPolicy.set(pid, {
          policy_id: pid, title: pol.title, version,
          current_on: current ? current.acknowledged_at : null,
          // Acknowledged an EARLIER version: the policy changed under them, so
          // it is not current and the page says which version they signed.
          acknowledged_version: rows.length
            ? rows.map((r) => String(r.policy_version).trim()).sort().pop() : null,
        });
      }
    }

    const required = [], optional = [];
    for (const c of courses) {
      const rs = byCourse.get(c.id) || [];
      const applicable = rs.filter((r) => appliesTo(r, emp));
      const isOptional = !applicable.length && rs.some((r) => r.scope === "optional");
      if (!applicable.length && !isOptional) continue; // required of nobody, or not of them
      const ack = c.delivery === "policy_ack" && c.policy_id ? ackByPolicy.get(Number(c.policy_id)) || null : null;
      const row = evaluate(c, applicable, emp, comps, ack, deptNames, { optional: isOptional });
      (isOptional ? optional : required).push(row);
    }
    const order = (a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state])
      || String(a.due_on || "9999").localeCompare(String(b.due_on || "9999"))
      || a.title.localeCompare(b.title);
    required.sort(order);
    optional.sort(order);

    const count = (st) => required.filter((r) => r.state === st).length;
    return {
      employee: {
        id: emp.id, name: emp.name, email: emp.email || null,
        role_title: emp.role_title || null,
        position_group: positionGroup(emp.role_title),
        position_label: (POSITIONS.find((p) => p.key === positionGroup(emp.role_title)) || {}).label || null,
        department_key: emp.department_key || null,
        department: emp.department_key ? deptNames.get(emp.department_key) || emp.department_key : null,
        hire_date: emp.hire_date || null,
      },
      required, optional,
      summary: {
        total: required.length,
        overdue: count("overdue"), due: count("due"), submitted: count("submitted"),
        complete: count("complete"), no_deadline: count("no_deadline"),
        // Training hours, kept apart from billable hours by design.
        training_hours: required.concat(optional).reduce((n, r) => n
          + r.history.filter((h) => h.verified_at).reduce((m, h) => m + (h.hours || 0), 0), 0),
      },
    };
  }

  // ---- RECORDING A COMPLETION -------------------------------------------
  //
  // VERIFYING SOMEBODY'S TRAINING IS AN HR ACT, NOT AN AUTHORING ONE. The
  // owner alone writes the curriculum; HR runs onboarding and checks what
  // comes in. Clinical leadership reads the compliance picture and verifies
  // nothing, which is why this list is narrower than canView.
  const VERIFY_ROLES = ["owner", "admin", "super_admin", "hr_admin"];
  const canVerify = (u) => !!u && VERIFY_ROLES.includes(u.role);

  function validateCompletion(b) {
    const completed_on = clean(b.completed_on) || today();
    if (!isDate(completed_on)) return { error: "Give the date it was completed as YYYY-MM-DD." };
    if (completed_on > today()) return { error: "Training cannot be completed in the future." };
    let hours = null;
    if (b.hours !== undefined && b.hours !== null && clean(b.hours) !== "") {
      hours = Number(b.hours);
      if (!Number.isFinite(hours) || hours < 0 || hours > 200) return { error: "Training hours must be a number between 0 and 200." };
    }
    let expires_on = null;
    if (clean(b.expires_on)) {
      expires_on = clean(b.expires_on);
      if (!isDate(expires_on)) return { error: "Give the expiry date as YYYY-MM-DD." };
    }
    return { fields: { completed_on, hours, expires_on, evidence_note: clean(b.evidence_note).slice(0, 1000) || null } };
  }

  // Shared by "I did this" and "HR recorded this for them". `verifiedNow` is
  // the whole difference: a person reporting their own training never
  // verifies it, whoever they are.
  async function recordCompletion(emp, courseId, body, who, { verifiedNow, source }) {
    const course = await dbGet("SELECT * FROM compliance_courses WHERE id = ? AND active = TRUE", [courseId]).catch(() => null);
    if (!course) return { status: 404, error: "No such course." };
    if (course.delivery === "policy_ack") {
      return { status: 400, error: "This course is completed by acknowledging the policy, in Policies." };
    }
    // It has to be something they are actually asked to do, so a completion
    // cannot be filed against training that was never required of them.
    const rec = await trainingRecord(emp);
    const row = rec.required.concat(rec.optional).find((r) => r.course_id === course.id);
    if (!row) return { status: 400, error: "That course is not assigned to this person." };

    const v = validateCompletion(body);
    if (v.error) return { status: 400, error: v.error };
    const f = v.fields;
    const existing = await dbGet(
      "SELECT id FROM compliance_completions WHERE employee_id = ? AND course_id = ? AND course_version = ? AND completed_on = ?",
      [emp.id, course.id, Number(course.version || 1), f.completed_on]).catch(() => null);
    if (existing) return { status: 409, error: "That sitting is already on record for this person." };

    await dbRun(
      `INSERT INTO compliance_completions
         (employee_id, course_id, course_version, completed_on, source, hours, expires_on, evidence_note,
          verified_by, verified_at, recorded_by, recorded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [emp.id, course.id, Number(course.version || 1), f.completed_on, source, f.hours, f.expires_on,
       f.evidence_note, verifiedNow ? who : null, verifiedNow ? nowISO() : null, who, nowISO()]);
    await audit(course.id, verifiedNow
      ? `Completion recorded and verified for ${emp.name} (completed ${f.completed_on}).`
      : `Completion reported for ${emp.name} (completed ${f.completed_on}), waiting to be verified.`, who);
    return { status: 201, ok: true, verified: !!verifiedNow };
  }

  async function setVerified(user, id, verified, note) {
    const row = await dbGet("SELECT * FROM compliance_completions WHERE id = ?", [id]).catch(() => null);
    if (!row) return { status: 404, error: "No such completion." };
    const who = clean(user.name) || clean(user.email) || "HR";
    const emp = await dbGet("SELECT name FROM hr_employees WHERE id = ?", [row.employee_id]).catch(() => null);
    await dbRun("UPDATE compliance_completions SET verified_by = ?, verified_at = ? WHERE id = ?",
      [verified ? who : null, verified ? nowISO() : null, id]);
    await audit(row.course_id, `${verified ? "Verified" : "Verification withdrawn on"} the completion recorded for `
      + `${(emp && emp.name) || "an employee"} (completed ${row.completed_on})`
      + (clean(note) ? `: ${clean(note).slice(0, 300)}` : "."), who);
    return { status: 200, ok: true };
  }

  // ======================= ROUTES ==============================
  async function handleApi(req, res, pathname, method, user, query) {
    if (!pathname.startsWith("/api/compliance/")) return false;

    if (pathname === "/api/compliance/courses" && method === "GET") {
      if (!(await canView(user))) { json(res, 403, { error: "Not permitted" }); return true; }
      json(res, 200, {
        courses: await library({ includeRetired: String(query && query.retired) === "1" }),
        vocabulary: await vocabulary(),
        can_manage: canManage(user),
      });
      return true;
    }

    if (pathname === "/api/compliance/courses" && method === "POST") {
      if (!canManage(user)) { json(res, 403, { error: "Only the practice owner can change the course library." }); return true; }
      const r = await createCourse(user, await readBody(req));
      if (r.error) { json(res, r.status, { error: r.error }); return true; }
      json(res, 201, { ok: true, id: r.id });
      return true;
    }

    let m = pathname.match(/^\/api\/compliance\/courses\/(\d+)$/);
    if (m && method === "PATCH") {
      if (!canManage(user)) { json(res, 403, { error: "Only the practice owner can change the course library." }); return true; }
      const r = await updateCourse(user, Number(m[1]), await readBody(req));
      if (r.error) { json(res, r.status, { error: r.error }); return true; }
      json(res, 200, { ok: true, version: r.version, forked: !!r.forked, unchanged: !!r.unchanged });
      return true;
    }

    m = pathname.match(/^\/api\/compliance\/courses\/(\d+)\/retire$/);
    if (m && method === "POST") {
      if (!canManage(user)) { json(res, 403, { error: "Only the practice owner can retire a course." }); return true; }
      const b = await readBody(req);
      const r = await retireCourse(user, Number(m[1]), b.retire === undefined ? true : !!b.retire);
      if (r.error) { json(res, r.status, { error: r.error }); return true; }
      json(res, 200, { ok: true });
      return true;
    }

    m = pathname.match(/^\/api\/compliance\/courses\/(\d+)\/rules$/);
    if (m && method === "PUT") {
      if (!canManage(user)) { json(res, 403, { error: "Only the practice owner can decide who training is required of." }); return true; }
      const b = await readBody(req);
      const r = await setRules(user, Number(m[1]), b.rules);
      if (r.error) { json(res, r.status, { error: r.error }); return true; }
      json(res, 200, { ok: true });
      return true;
    }

    m = pathname.match(/^\/api\/compliance\/courses\/(\d+)\/history$/);
    if (m && method === "GET") {
      if (!(await canView(user))) { json(res, 403, { error: "Not permitted" }); return true; }
      const rows = await dbAll(
        "SELECT change, changed_by, changed_at FROM compliance_audit WHERE course_id = ? ORDER BY id DESC LIMIT 200",
        [Number(m[1])]).catch(() => []);
      json(res, 200, { history: rows });
      return true;
    }

    // ---- A PERSON'S OWN TRAINING ---------------------------------------
    //
    // NOT canView-gated, and that is deliberate rather than an oversight.
    // canView governs reading the compliance picture of OTHER people and it
    // refuses the training-only role on purpose. Everybody who works here can
    // see their own training, which for an employee account is the entire
    // reason the login exists.
    if (pathname === "/api/compliance/my-training" && method === "GET") {
      if (!user) { json(res, 401, { error: "Sign in to see your training." }); return true; }
      const emp = await employeeForUser(user);
      if (!emp) {
        // Said plainly instead of showing an empty list, which would read as
        // "nothing is required of you" when the truth is that the login is
        // not joined up to an employee record yet.
        json(res, 200, {
          linked: false,
          message: "Your login is not linked to an employee record yet, so your training cannot be worked out. HR can link it.",
          required: [], optional: [], summary: null,
        });
        return true;
      }
      const rec = await trainingRecord(emp);
      json(res, 200, { linked: true, ...rec, can_verify: canVerify(user) });
      return true;
    }

    // "I have done this." Never verifies: a self-report is a claim, and the
    // brief asks that completion be verified before a certificate exists.
    m = pathname.match(/^\/api\/compliance\/my-training\/(\d+)\/report$/);
    if (m && method === "POST") {
      if (!user) { json(res, 401, { error: "Sign in first." }); return true; }
      const emp = await employeeForUser(user);
      if (!emp) { json(res, 400, { error: "Your login is not linked to an employee record yet." }); return true; }
      const who = clean(user.name) || clean(user.email) || "Employee";
      const r = await recordCompletion(emp, Number(m[1]), await readBody(req), who,
        { verifiedNow: false, source: "self_report" });
      if (r.error) { json(res, r.status, { error: r.error }); return true; }
      json(res, 201, { ok: true, verified: false });
      return true;
    }

    // ---- SOMEBODY ELSE'S TRAINING --------------------------------------
    m = pathname.match(/^\/api\/compliance\/employees\/(\d+)\/training$/);
    if (m && method === "GET") {
      if (!(await canView(user))) { json(res, 403, { error: "Not permitted" }); return true; }
      const emp = await dbGet("SELECT * FROM hr_employees WHERE id = ?", [Number(m[1])]).catch(() => null);
      if (!emp) { json(res, 404, { error: "No such employee." }); return true; }
      const rec = await trainingRecord(emp);
      json(res, 200, { ...rec, can_verify: canVerify(user) });
      return true;
    }

    // HR recording training they have evidence of, which verifies it in the
    // same step because they are the ones doing the checking.
    m = pathname.match(/^\/api\/compliance\/employees\/(\d+)\/completions$/);
    if (m && method === "POST") {
      if (!canVerify(user)) { json(res, 403, { error: "Only the owner or HR can record somebody else's training." }); return true; }
      const emp = await dbGet("SELECT * FROM hr_employees WHERE id = ?", [Number(m[1])]).catch(() => null);
      if (!emp) { json(res, 404, { error: "No such employee." }); return true; }
      const who = clean(user.name) || clean(user.email) || "HR";
      // Read once: the body is a stream, and asking twice gets an empty
      // object the second time.
      const body = await readBody(req);
      const r = await recordCompletion(emp, Number(body.course_id), body, who,
        { verifiedNow: true, source: "recorded" });
      if (r.error) { json(res, r.status, { error: r.error }); return true; }
      json(res, 201, { ok: true, verified: true });
      return true;
    }

    m = pathname.match(/^\/api\/compliance\/completions\/(\d+)\/verify$/);
    if (m && method === "POST") {
      if (!canVerify(user)) { json(res, 403, { error: "Only the owner or HR can verify training." }); return true; }
      const b = await readBody(req);
      const r = await setVerified(user, Number(m[1]), b.verified === undefined ? true : !!b.verified, b.note);
      if (r.error) { json(res, r.status, { error: r.error }); return true; }
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  return {
    initTables, handleApi, library, canView, canManage, canVerify, trainingRecord, employeeForUser,
    _internal: { DELIVERY, DELIVERY_KEYS, SCOPES, SCOPE_KEYS, VERSIONED_FIELDS, SEED, VERIFY_ROLES,
                 validateCourse, validateRule, publicCourse, freeKey, seedLibrary, positionGroup,
                 appliesTo, evaluate, addDays, addMonths, daysUntil, validateCompletion,
                 recordCompletion, setVerified, because },
  };
};
