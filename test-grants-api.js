// Grant Finder over HTTP: storage, permissions, duplicates, and the fact that
// a score is never allowed to go stale.
//
// test-grants-scoring.js drives the engine directly. This one is about the
// things only the real server can show: that admins get in and clinical staff
// do not, that the owner's EIN is not readable by an admin, that the same
// grant cannot be entered twice, and that changing the profile or the funding
// priorities re-scores everything already in the database.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-grants-api.js
"use strict";
const crypto = require("crypto");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 320) : "")); }
}
const section = (t) => console.log("\n== " + t + " ==");

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
const hp = (pw) => { const salt = crypto.randomBytes(16).toString("hex"); return { hash: crypto.scryptSync(pw, salt, 64).toString("hex"), salt }; };

(async () => {
  // An admin (in) and a clinical user (out), to prove the boundary.
  const a = hp("TestAdmin123!");
  await pool.query(
    `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
     VALUES ('Grant Admin','grantadmin@spectrumsquadlv.com',$1,$2,'admin',now())
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_salt=EXCLUDED.password_salt, role='admin'`,
    [a.hash, a.salt]
  );

  const owner = client(), admin = client(), clinical = client();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("admin signs in", (await admin("/api/auth/login", { method: "POST", body: { email: "grantadmin@spectrumsquadlv.com", password: "TestAdmin123!" } })).status === 200);
  check("clinical signs in", (await clinical("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  // ------------------------------------------------------------ permissions
  section("Who may look at the money");
  check("clinical staff are refused the dashboard", (await clinical("/api/grants/dashboard")).status === 403);
  check("clinical staff are refused the opportunities list", (await clinical("/api/grants/opportunities")).status === 403);
  check("clinical staff cannot add a grant",
    (await clinical("/api/grants/opportunities", { method: "POST", body: { name: "Sneaky" } })).status === 403);
  check("an admin may see the dashboard", (await admin("/api/grants/dashboard")).status === 200);

  // -------------------------------------------------------------- the seed
  section("It is useful before anyone fills anything in");
  const profile0 = await owner("/api/grants/profile");
  check("the organisation profile exists already", profile0.status === 200 && !!profile0.data.profile, profile0.data);
  check("and knows we are a for-profit Nevada company",
    profile0.data.profile.for_profit === true && /nevada/i.test(profile0.data.profile.state || ""), profile0.data.profile);
  check("and that we are woman-owned and veteran-owned",
    profile0.data.profile.woman_owned === true && profile0.data.profile.veteran_owned === true);
  const sources0 = await owner("/api/grants/sources");
  check("the funding sources are seeded", sources0.data.sources.length > 10, sources0.data.sources.length);
  check("Grants.gov is recorded as automatable later",
    sources0.data.sources.some((s) => s.name === "Grants.gov" && s.integration === "api_available"));
  check("and the foundations are honestly marked manual",
    sources0.data.sources.some((s) => s.integration === "manual"));

  // ------------------------------------------------------------- adding one
  section("Adding a grant scores it on the way in");
  const created = await owner("/api/grants/opportunities", {
    method: "POST",
    body: {
      name: "Nevada Behavioral Health Workforce Expansion",
      funder: "Nevada DHHS",
      opportunity_number: "NV-BH-2026-01",
      geographic_eligibility: "Nevada",
      for_profit_allowed: true, small_business_eligible: true, woman_preference: true,
      amount_max: 250000, expected_award: 150000,
      deadline: "2099-12-31",
      tags: ["nevada", "behavioral_health", "healthcare_workforce", "rbt_training", "autism"],
    },
  });
  check("created", created.status === 200 && created.data.grant, created.data);
  const g = created.data.grant;
  check("came back with a match score", typeof g.match_score === "number" && g.match_score > 0, g.match_score);
  check("and an eligibility verdict", g.eligibility_status === "eligible", g.eligibility_status);
  check("and an explanation a human can read", /Nevada/i.test(g.match_explanation || ""), g.match_explanation);

  // --------------------------------------------------------- duplicate rules
  section("The same grant cannot be entered twice");
  const dupeNumber = await owner("/api/grants/opportunities", {
    method: "POST", body: { name: "Different title entirely", opportunity_number: "NV-BH-2026-01" },
  });
  check("caught on opportunity number", dupeNumber.status === 409, dupeNumber.data);
  check("and names the grant it collided with",
    /Nevada Behavioral Health Workforce Expansion/.test((dupeNumber.data || {}).error || ""), dupeNumber.data);

  const dupeName = await owner("/api/grants/opportunities", {
    method: "POST", body: { name: "Nevada Behavioral Health Workforce Expansion", funder: "Nevada DHHS" },
  });
  check("caught on name and funder together", dupeName.status === 409, dupeName.data);

  const notDupe = await owner("/api/grants/opportunities", {
    method: "POST", body: { name: "Nevada Behavioral Health Workforce Expansion", funder: "A completely different funder" },
  });
  check("but the same name from another funder is allowed", notDupe.status === 200, notDupe.data);

  // The override covers the heuristics, not the funder's own identifier: a
  // repeated opportunity number is the same grant by definition, and the unique
  // index says so too.
  const forcedNumber = await owner("/api/grants/opportunities", {
    method: "POST", body: { name: "Different title entirely", opportunity_number: "NV-BH-2026-01", allow_duplicate: true },
  });
  check("an opportunity-number collision cannot be overridden", forcedNumber.status === 409, forcedNumber.data);
  check("and it is marked as the hard kind", forcedNumber.data.hard === true, forcedNumber.data);
  check("with an explanation rather than a database error",
    /opportunity number/i.test((forcedNumber.data || {}).error || ""), forcedNumber.data);

  const forcedName = await owner("/api/grants/opportunities", {
    method: "POST", body: { name: "Nevada Behavioral Health Workforce Expansion", funder: "Nevada DHHS", allow_duplicate: true },
  });
  check("but a name-and-funder collision can be, deliberately", forcedName.status === 200, forcedName.data);

  // ------------------------------------------------- ineligible is not shown
  section("A grant we cannot apply for is never recommended");
  const blocked = await owner("/api/grants/opportunities", {
    method: "POST",
    body: {
      name: "Autism Family Support Fund", funder: "A Foundation",
      geographic_eligibility: "Nevada", nonprofit_required: true, expected_award: 500000,
      deadline: "2099-11-30",
      tags: ["autism", "children_youth", "nevada", "behavioral_health"],
    },
  });
  check("it stores fine", blocked.status === 200, blocked.data);
  check("it still scores as relevant", blocked.data.grant.match_score >= 40, blocked.data.grant.match_score);
  check("but is marked likely ineligible", blocked.data.grant.eligibility_status === "likely_ineligible");

  const dash = await owner("/api/grants/dashboard");
  check("the dashboard keeps it out of the top opportunities",
    !dash.data.top.some((x) => x.id === blocked.data.grant.id), dash.data.top.map((x) => x.name));
  check("and out of the potential-funding total",
    dash.data.totals.potential_funding < 500000, dash.data.totals.potential_funding);
  check("the dashboard counts the active ones", dash.data.totals.active >= 3, dash.data.totals);

  // ------------------------------------------------------ scores stay fresh
  section("Changing what we need money for re-scores everything");
  const before = (await owner(`/api/grants/opportunities/${g.id}`)).data.grant.match_score;
  const put = await owner("/api/grants/priorities", { method: "PUT", body: { keys: ["train_rbts", "rbt_workforce_program"] } });
  check("saving priorities reports how many it re-scored", put.data.rescored >= 3, put.data);
  const after = (await owner(`/api/grants/opportunities/${g.id}`)).data.grant.match_score;
  check("the RBT workforce grant scores higher than it did", after > before, { before, after });

  // ------------------------------------------------------------- filtering
  section("Search and filters");
  check("free text finds it by funder",
    (await owner("/api/grants/opportunities?q=nevada dhhs")).data.grants.length >= 1);
  check("filtering by category works",
    (await owner("/api/grants/opportunities?tag=rbt_training")).data.grants.every((x) => x.tags.includes("rbt_training")));
  check("filtering by eligibility works",
    (await owner("/api/grants/opportunities?eligibility=likely_ineligible")).data.grants.every((x) => x.eligibility_status === "likely_ineligible"));
  check("and it finds the blocked one",
    (await owner("/api/grants/opportunities?eligibility=likely_ineligible")).data.grants.some((x) => x.id === blocked.data.grant.id));

  // -------------------------------------------------------- save / dismiss
  section("Saving and dismissing");
  await owner(`/api/grants/opportunities/${g.id}/save`, { method: "POST" });
  const saved = (await owner(`/api/grants/opportunities/${g.id}`)).data.grant;
  check("saving stamps it", !!saved.saved_at);
  await owner(`/api/grants/opportunities/${notDupe.data.grant.id}/dismiss`, { method: "POST" });
  const listAfter = (await owner("/api/grants/opportunities")).data.grants;
  check("a dismissed grant drops off the list", !listAfter.some((x) => x.id === notDupe.data.grant.id));
  check("but is not deleted",
    (await owner(`/api/grants/opportunities/${notDupe.data.grant.id}`)).status === 200);

  // ------------------------------------------------------------- sensitive
  section("The owner's registration details are not admin-readable");
  await owner("/api/grants/profile", { method: "PATCH", body: { ein: "88-1234567", uei: "ABC123DEF456", annual_revenue_range: "$5M-$10M" } });
  const ownerView = (await owner("/api/grants/profile")).data;
  check("the owner can read the EIN back", ownerView.profile.ein === "88-1234567", ownerView.profile.ein);
  const adminView = (await admin("/api/grants/profile")).data;
  check("an admin cannot", adminView.profile.ein !== "88-1234567", adminView.profile.ein);
  check("but can see that it is on file", (adminView.profile._redacted || []).includes("ein"), adminView.profile._redacted);
  check("and is told they may not edit it", adminView.can_edit_sensitive === false);
  await admin("/api/grants/profile", { method: "PATCH", body: { ein: "00-0000000" } });
  check("an admin writing to it changes nothing",
    (await owner("/api/grants/profile")).data.profile.ein === "88-1234567");

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
