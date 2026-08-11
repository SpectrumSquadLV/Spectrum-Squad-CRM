// Verifies the expanded application fields are returned by the CRM applicant
// detail endpoint (and desired_pay rides with the sensitive tier).
const BASE = process.env.BASE || "http://localhost:3009";
let cookie = "", pass = 0, fail = 0;
async function req(p, { method = "GET", body } = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  let d = null; try { d = await r.json(); } catch (e) {} return { status: r.status, data: d };
}
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? " -> " + JSON.stringify(d).slice(0,200) : "")); } }
(async () => {
  // public apply with the full field set
  await req("/api/hr/apply", { method: "POST", body: {
    full_name: "Surface Test", preferred_name: "Surf", email: "surface@example.test", phone: "7025550000",
    address: "9 Rainbow Rd, Las Vegas NV", slug: "rbt", source: "website",
    desired_pay: "$27/hr", certifications: "RBT, CPR", education: "BA UNLV", employment_history: "RBT 2y",
    availability: { days: { Mon: true, Tue: true }, earliest: "09:00", latest: "16:00", weekly_hours: "30", type: "full_time", notes: "No weekends" },
    consent_email: true, consent_sms: true, sms_consent_at: new Date().toISOString(), sms_consent_version: "sms-v1-2026-08",
  } });
  const login = await req("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signs in", login.status === 200, login.data);
  const list = (await req("/api/hr/applicants")).data || [];
  const rows = Array.isArray(list) ? list : (list.applicants || []);
  const found = rows.find((x) => (x.email === "surface@example.test") || (x.name === "Surface Test"));
  check("applicant is in the list", !!found, rows.slice(0,2));
  const a = (await req("/api/hr/applicants/" + found.id)).data;
  check("profile returns preferred_name", a.preferred_name === "Surf", a.preferred_name);
  check("profile returns address", /Rainbow Rd/.test(a.address || ""), a.address);
  check("profile returns certifications", /RBT/.test(a.certifications || ""), a.certifications);
  check("profile returns education", /UNLV/.test(a.education || ""), a.education);
  check("profile returns employment_history", /RBT/.test(a.employment_history || ""), a.employment_history);
  check("profile returns availability object", a.availability && a.availability.days && a.availability.days.Mon === true, a.availability);
  check("profile returns sms consent metadata", !!a.sms_consent_at && a.sms_consent_version === "sms-v1-2026-08", { at: a.sms_consent_at, v: a.sms_consent_version });
  check("desired_pay shown to owner (sensitive tier)", a.desired_pay === "$27/hr", a.desired_pay);
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
