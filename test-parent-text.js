// Text-a-parent (client card) integration test.
//
// Exercises the "Text Parent" feature added to the client facecard: recording
// parent SMS consent, the consent + opt-out gate on the manual-send endpoint,
// simulated delivery, opt-out enforcement, and that every send is logged to the
// family's communication history.
//
// Boot the server in SIMULATED mode (no SMS_PROVIDER/creds so nothing is
// actually delivered) but WITH an auth token so the app is otherwise wired:
//
//   SMS_PROVIDER=none TWILIO_AUTH_TOKEN=testtoken \
//   APP_BASE_URL=http://127.0.0.1:3021 DATABASE_URL=... node server.js
//   BASE=http://127.0.0.1:3021 DATABASE_URL=... node test-parent-text.js
const { Pool } = require("pg");
const crypto = require("crypto");
const BASE = process.env.BASE || "http://localhost:3021";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let cookie = "", pass = 0, fail = 0;
async function req(p, { method = "GET", body, useCookie = true } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(useCookie && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get("set-cookie"); if (sc && useCookie) cookie = sc.split(";")[0];
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 260) : "")); } }

// Give the seeded owner a known password (matches the shared test convention),
// mirroring server.js hashPassword: scrypt(password, salt, 64) hex.
async function setOwnerPassword() {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("TestOwner123!", salt, 64).toString("hex");
  await pool.query("UPDATE users SET password_hash=$1, password_salt=$2 WHERE email='admin@spectrumsquadlv.com'", [hash, salt]);
}

async function main() {
  await setOwnerPassword();

  const login = await req("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signs in", login.status === 200, login.data);

  const PHONE = "7025550199";
  const created = await req("/api/clients", { method: "POST", body: {
    child_name: "Testy McClient", parent_name: "Pat Parent", parent_relationship: "Mother",
    parent_email: "pat.parent@example.test", parent_phone: PHONE,
  } });
  check("a client is created", created.status === 201 && created.data.id, created.data);
  const id = created.data.id;

  console.log("\n== consent gate ==");
  const beforeConsent = await req("/api/clients/" + id + "/send-sms", { method: "POST", body: { body: "Hello there" } });
  check("texting before consent is refused (400)", beforeConsent.status === 400, beforeConsent);

  const get1 = await req("/api/clients/" + id);
  check("client detail reports smsConfigured", typeof get1.data.smsConfigured === "boolean", get1.data.smsConfigured);
  check("client detail reports parentSmsOptedOut=false", get1.data.parentSmsOptedOut === false, get1.data.parentSmsOptedOut);
  check("parent_sms_consent starts false", !get1.data.client.parent_sms_consent, get1.data.client.parent_sms_consent);

  console.log("\n== recording consent ==");
  const consent = await req("/api/clients/" + id, { method: "PATCH", body: { parent_sms_consent: true } });
  check("consent PATCH succeeds", consent.status === 200 && consent.data.parent_sms_consent === true, consent.data);
  check("consent timestamp is stamped", !!consent.data.parent_sms_consent_at, consent.data.parent_sms_consent_at);

  console.log("\n== sending ==");
  const send1 = await req("/api/clients/" + id + "/send-sms", { method: "POST", body: { body: "Hi Pat! Just a reminder about tomorrow's session." } });
  check("owner can text a consenting parent", send1.status === 200 && send1.data.ok, send1.data);
  check("manual send reports simulated delivery", send1.data && String(send1.data.delivered).startsWith("simulated"), send1.data);

  const logRows = await pool.query("SELECT * FROM notifications_log WHERE client_id=$1 AND channel='sms' AND type='parent_manual_sms'", [id]);
  check("the text is logged to the family communication history", logRows.rows.length === 1, logRows.rows.length);

  const notifs = (await req("/api/clients/" + id)).data.notifications || [];
  check("the text appears in the client's notifications feed", notifs.some((n) => n.channel === "sms" && n.type === "parent_manual_sms"), notifs.map((n) => n.type));

  console.log("\n== validation ==");
  const empty = await req("/api/clients/" + id + "/send-sms", { method: "POST", body: { body: "   " } });
  check("an empty body is refused (400)", empty.status === 400, empty);
  const tooLong = await req("/api/clients/" + id + "/send-sms", { method: "POST", body: { body: "x".repeat(1001) } });
  check("an over-long body is refused (400)", tooLong.status === 400, tooLong);

  console.log("\n== no-phone client ==");
  const noPhone = await req("/api/clients", { method: "POST", body: { child_name: "No Phone Kid", parent_name: "Sam", parent_sms_consent: true } });
  await req("/api/clients/" + noPhone.data.id, { method: "PATCH", body: { parent_sms_consent: true } });
  const send4 = await req("/api/clients/" + noPhone.data.id + "/send-sms", { method: "POST", body: { body: "hi" } });
  check("texting a parent with no phone is refused (400)", send4.status === 400, send4);

  console.log("\n== opt-out enforcement ==");
  const e164 = "+1" + PHONE;
  await pool.query("INSERT INTO sms_opt_outs (phone, opted_out_at, reason) VALUES ($1, $2, 'test') ON CONFLICT (phone) DO NOTHING", [e164, new Date().toISOString()]);
  const getOpted = await req("/api/clients/" + id);
  check("client detail now reports parentSmsOptedOut=true", getOpted.data.parentSmsOptedOut === true, getOpted.data.parentSmsOptedOut);
  const sendOpted = await req("/api/clients/" + id + "/send-sms", { method: "POST", body: { body: "still there?" } });
  check("texting an opted-out parent is refused (400)", sendOpted.status === 400, sendOpted);
  await pool.query("DELETE FROM sms_opt_outs WHERE phone=$1", [e164]);

  console.log("\n== auth gate ==");
  const anon = await req("/api/clients/" + id + "/send-sms", { method: "POST", useCookie: false, body: { body: "hi" } });
  check("unauthenticated send is rejected (401/403)", anon.status === 401 || anon.status === 403, anon.status);

  console.log("\n== withdrawing consent ==");
  const withdraw = await req("/api/clients/" + id, { method: "PATCH", body: { parent_sms_consent: false } });
  check("consent can be withdrawn", withdraw.status === 200 && withdraw.data.parent_sms_consent === false, withdraw.data);
  check("consent timestamp cleared on withdrawal", !withdraw.data.parent_sms_consent_at, withdraw.data.parent_sms_consent_at);
  const sendAfterWithdraw = await req("/api/clients/" + id + "/send-sms", { method: "POST", body: { body: "hi again" } });
  check("texting after consent withdrawn is refused (400)", sendAfterWithdraw.status === 400, sendAfterWithdraw);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
