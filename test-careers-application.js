// Exercises the public careers / employment-application flow end to end against
// a live local server, the way test-treatment-plan-auth.js does.
//
//   DATABASE_URL=... node server.js         # in one shell
//   node test-careers-application.js         # in another
//
// The application intake is PUBLIC (no session), so the core of this suite
// needs no login: it lists the open roles, renders the careers page, and
// submits a real application for each of the four positions. If owner
// credentials happen to work, it additionally confirms the applicants landed
// in the pipeline through the authenticated API; otherwise that part is
// skipped rather than failing.
const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "admin@spectrumsquadlv.com";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "TestOwner123!";
let cookie = "";
let pass = 0, fail = 0;

async function req(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  if (raw) { const text = await res.text(); return { status: res.status, text }; }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 400) : "")); }
}

// The four roles this application must cover, plus a valid screening answer set
// for each (keyed by the position's screening-question ids).
const ROLES = [
  { slug: "rbt", title: /Registered Behavior Technician/i, role_type: "rbt",
    answers: { rbt_active: "Yes", transportation: "Yes", availability: "Weekday afternoons" } },
  { slug: "bcba-hybrid", title: /Board Certified Behavior Analyst/i, role_type: "bcba",
    answers: { bcba_certified: "Yes", nevada_lba: "Yes", years_experience: "5" } },
  { slug: "bcaba", title: /Board Certified Assistant Behavior Analyst/i, role_type: "other",
    answers: { bcaba_certified: "Yes", supervision_ok: "Yes", years_experience: "2" } },
  { slug: "administrative-assistant", title: /Administrative Assistant/i, role_type: "other",
    answers: { admin_experience: "5 years front desk", tools_comfort: "Yes", bilingual: "Spanish" } },
];

(async () => {
  console.log("\n== the four roles are open and public ==");
  let r = await req("/api/hr/public/positions");
  check("public positions endpoint responds", r.status === 200, r.data);
  const list = Array.isArray(r.data) ? r.data : [];
  check("at least four open roles are listed", list.length >= 4, list.length);
  const bySlug = {};
  list.forEach((p) => { bySlug[p.slug] = p; });
  for (const role of ROLES) {
    const p = bySlug[role.slug];
    check(role.slug + " is open", !!p, Object.keys(bySlug));
    if (p) {
      check(role.slug + " has the expected title", role.title.test(p.title || ""), p.title);
      check(role.slug + " has the expected role_type", p.role_type === role.role_type, p.role_type);
      check(role.slug + " ships screening questions", Array.isArray(p.screening_questions) && p.screening_questions.length > 0, p.screening_questions);
      check(role.slug + " hides sensitive comp on the public feed", !("comp_min" in p) && !("comp_max" in p), Object.keys(p));
    }
  }

  console.log("\n== each role is reachable by its own slug ==");
  for (const role of ROLES) {
    const one = await req("/api/hr/public/positions/" + role.slug);
    check(role.slug + " resolves individually", one.status === 200 && one.data && one.data.slug === role.slug, one.data);
  }

  console.log("\n== the careers page renders (and the template literal is clean) ==");
  const page = await req("/careers", { raw: true });
  check("/careers returns HTML", page.status === 200 && /<html/i.test(page.text), page.status);
  check("the page is the interactive experience, not the old plain form", page.text.includes("Come do the best work of your life"), false);
  check("it wires up the multi-step wizard", page.text.includes("stepFit") && page.text.includes("stepReview"), false);
  check("it includes the confetti celebration", page.text.includes("function confetti"), false);
  check("no unrendered ${ template interpolation leaked into the output", !page.text.includes("${"), false);
  check("no stray backticks leaked into the output", page.text.indexOf("`") === -1, false);
  // /apply/:token and /careers/:slug are served by the same SPA
  const applyPage = await req("/careers/rbt", { raw: true });
  check("/careers/:slug serves the same SPA", applyPage.status === 200 && /<html/i.test(applyPage.text), applyPage.status);

  console.log("\n== a real application can be submitted for every role ==");
  const created = {};
  for (const role of ROLES) {
    const payload = {
      full_name: "Test Applicant " + role.slug,
      email: "applicant+" + role.slug + "@example.test",
      phone: "7025550100",
      city: "Las Vegas",
      state: "NV",
      slug: role.slug,
      source: "website",
      earliest_start: "Immediately",
      cover_letter: "Excited to join the Spectrum Squad!",
      screening_answers: role.answers,
      consent_email: true,
    };
    const sub = await req("/api/hr/apply", { method: "POST", body: payload });
    check(role.slug + ": application accepted", sub.status === 201 && sub.data && sub.data.ok === true, sub.data);
    check(role.slug + ": a new applicant id is returned", sub.data && Number(sub.data.id) > 0, sub.data);
    check(role.slug + ": a match category is computed", sub.data && sub.data.match && typeof sub.data.match.match_category === "string", sub.data);
    if (sub.data && sub.data.id) created[role.slug] = sub.data.id;
  }

  console.log("\n== matching logic scores the credentialed roles ==");
  // The RBT answered active + transport, so should be qualified; the BCBA
  // answered certified + LBA, so should be a priority review. The 'other'
  // roles have no scoring rules and stay at insufficient_information -- which
  // is correct, not a bug.
  const rbtSub = await req("/api/hr/apply", { method: "POST", body: {
    full_name: "Qualified RBT", email: "qrbt@example.test", slug: "rbt", source: "website",
    screening_answers: { rbt_active: "Yes", transportation: "Yes" }, consent_email: true } });
  check("a fully-credentialed RBT is scored 'qualified'", rbtSub.data && rbtSub.data.match && rbtSub.data.match.match_category === "qualified", rbtSub.data);
  const bcbaSub = await req("/api/hr/apply", { method: "POST", body: {
    full_name: "Priority BCBA", email: "pbcba@example.test", slug: "bcba-hybrid", source: "website",
    screening_answers: { bcba_certified: "Yes", nevada_lba: "Yes" }, consent_email: true } });
  check("a certified + licensed BCBA is flagged for priority review", bcbaSub.data && bcbaSub.data.match && bcbaSub.data.match.priority_flag === true, bcbaSub.data);

  console.log("\n== the intake refuses incomplete applications ==");
  const noName = await req("/api/hr/apply", { method: "POST", body: { email: "x@example.test", slug: "rbt" } });
  check("missing name is rejected with 400", noName.status === 400, noName);
  const noContact = await req("/api/hr/apply", { method: "POST", body: { full_name: "No Contact", slug: "rbt" } });
  check("missing both email and phone is rejected with 400", noContact.status === 400, noContact);

  console.log("\n== applicants land in the pipeline (authenticated bonus check) ==");
  const login = await req("/api/auth/login", { method: "POST", body: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
  if (login.status !== 200) {
    console.log("  SKIP  owner login unavailable in this environment -- pipeline persistence not verified here");
  } else {
    const apps = await req("/api/hr/applicants");
    const rows = (apps.data && (apps.data.applicants || apps.data.rows || apps.data)) || [];
    const arr = Array.isArray(rows) ? rows : [];
    for (const role of ROLES) {
      const id = created[role.slug];
      const found = arr.find((a) => Number(a.id) === Number(id));
      check(role.slug + ": applicant is in the recruiting pipeline", !!found, id);
      if (found) check(role.slug + ": starts at the 'new_applicant' stage", found.stage === "new_applicant", found.stage);
    }
  }

  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nTest run crashed:", e); process.exit(1); });
