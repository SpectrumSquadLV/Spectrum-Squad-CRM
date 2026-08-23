// Phase 6a: expanded employment application. Verifies the new fields and
// availability are captured and stored.
//
// Texting was later removed, so the consent checkbox is gone from the form.
// The consent COLUMNS are not: a consent somebody gave is a record about them,
// and applications imported from elsewhere may still carry one. So this checks
// two things that pull in opposite directions -- the form no longer asks, and
// the store still keeps what it is given.
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 300) : "")); } }
async function post(path, body) { const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); let d = null; try { d = await r.json(); } catch (e) {} return { status: r.status, data: d }; }

(async () => {
  console.log("\n== careers page renders cleanly ==");
  const page = await fetch(BASE + "/careers").then((r) => r.text());
  check("no unrendered ${ in the served page", !page.includes("${"), false);
  check("no stray backticks in the served page", page.indexOf("`") === -1, false);
  check("the new Availability step is present", page.includes("stepAvailability"), false);
  check("the texting consent box is gone, since nothing can send a text",
    !/recruiting-related text messages/i.test(page), false);
  check("and the form no longer asks for it at all", !page.includes("consent_sms"), false);

  console.log("\n== an expanded application is stored in full ==");
  const sub = await post("/api/hr/apply", {
    full_name: "Jamie Applicant", preferred_name: "Jam", email: "jam+6a@example.test", phone: "7025550199",
    address: "123 Main St, Las Vegas, NV 89101", city: "Las Vegas", state: "NV", slug: "rbt", source: "website",
    desired_pay: "$26/hr", certifications: "RBT, CPR/BLS", education: "BA Psychology, UNLV 2022",
    employment_history: "RBT at ABC ABA 2022-2024", earliest_start: "Immediately",
    availability: { days: { Mon: true, Wed: true, Fri: true }, earliest: "09:00", latest: "17:00", weekly_hours: "25", type: "part_time", notes: "No Sundays" },
    screening_answers: { rbt_active: "Yes", transportation: "Yes" },
    consent_email: true, consent_sms: true, sms_consent_at: new Date().toISOString(), sms_consent_version: "sms-v1-2026-08",
  });
  check("application accepted", sub.status === 201 && sub.data.ok, sub.data);
  const a = (await pool.query("SELECT * FROM hr_applicants WHERE email = 'jam+6a@example.test' ORDER BY id DESC LIMIT 1")).rows[0];
  check("preferred name stored", a && a.preferred_name === "Jam", a && a.preferred_name);
  check("address stored", a && /Main St/.test(a.address || ""), a && a.address);
  check("desired pay stored", a && a.desired_pay === "$26/hr", a && a.desired_pay);
  check("certifications stored", a && /RBT/.test(a.certifications || ""), a && a.certifications);
  check("education stored", a && /UNLV/.test(a.education || ""), a && a.education);
  check("employment history stored", a && /ABC ABA/.test(a.employment_history || ""), a && a.employment_history);
  const avail = a && a.availability ? JSON.parse(a.availability) : {};
  check("availability days stored", avail.days && avail.days.Mon === true && avail.days.Wed === true, avail);
  check("availability hours + type stored", avail.weekly_hours === "25" && avail.type === "part_time", avail);
  // Historical/imported consent still stores and reads back, so nothing that
  // was already recorded is lost by the texting removal.
  check("a supplied text consent is still recorded", a && (a.consent_sms === true || a.consent_sms === "t"), a && a.consent_sms);
  check("with its timestamp", a && !!a.sms_consent_at, a && a.sms_consent_at);
  check("and the disclosure version it was given under", a && a.sms_consent_version === "sms-v1-2026-08", a && a.sms_consent_version);

  console.log("\n== consent metadata is NOT recorded when consent is declined ==");
  const sub2 = await post("/api/hr/apply", { full_name: "No SMS", email: "nosms+6a@example.test", slug: "rbt", source: "website", consent_email: true, consent_sms: false, sms_consent_at: new Date().toISOString(), sms_consent_version: "sms-v1-2026-08" });
  check("second application accepted", sub2.status === 201, sub2.data);
  const b = (await pool.query("SELECT * FROM hr_applicants WHERE email = 'nosms+6a@example.test' ORDER BY id DESC LIMIT 1")).rows[0];
  check("no consent timestamp when declined", b && !b.sms_consent_at, b && b.sms_consent_at);

  await pool.end();
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
