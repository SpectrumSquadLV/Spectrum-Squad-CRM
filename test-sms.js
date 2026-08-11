// SMS sending (Twilio) integration test.
//
// Boot the server in SIMULATED mode (no SMS_PROVIDER/creds so nothing is
// actually delivered) but WITH an auth token + matching APP_BASE_URL so the
// inbound webhook's real Twilio-signature verification is exercised:
//
//   SMS_PROVIDER=none TWILIO_AUTH_TOKEN=testtoken \
//   APP_BASE_URL=http://127.0.0.1:3011 DATABASE_URL=... node server.js
//   BASE=http://127.0.0.1:3011 TWILIO_AUTH_TOKEN=testtoken \
//   APP_BASE_URL=http://127.0.0.1:3011 DATABASE_URL=... node test-sms.js
const { Pool } = require("pg");
const crypto = require("crypto");
const sms = require("./sms-client");
const BASE = process.env.BASE || "http://localhost:3011";
const TOKEN = process.env.TWILIO_AUTH_TOKEN || "testtoken";
const APP_BASE_URL = (process.env.APP_BASE_URL || BASE).replace(/\/$/, "");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sign like Twilio: base64(HMAC-SHA1(token, url + sorted key+value concat)).
function twilioSig(url, params) {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return crypto.createHmac("sha1", TOKEN).update(Buffer.from(data, "utf-8")).digest("base64");
}
async function inbound(params, { sign = true, badSig = false } = {}) {
  const url = APP_BASE_URL + "/api/sms/inbound";
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (sign) headers["X-Twilio-Signature"] = badSig ? "not-the-real-signature" : twilioSig(url, params);
  const r = await fetch(BASE + "/api/sms/inbound", { method: "POST", headers, body: new URLSearchParams(params).toString() });
  return { status: r.status, text: await r.text() };
}

// Poll notifications_log until an SMS row for a phone appears (auto-confirmation
// is fire-and-forget, so it lands just after the apply response).
async function waitForSmsLog(recipientLike, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = await pool.query("SELECT * FROM notifications_log WHERE channel='sms' AND recipient LIKE $1 ORDER BY id DESC LIMIT 1", ["%" + recipientLike]);
    if (r.rows.length) return r.rows[0];
    await sleep(100);
  }
  return null;
}

(async () => {
  console.log("\n== sms-client pure helpers ==");
  check("toE164 adds +1 to a 10-digit US number", sms.toE164("7025550123") === "+17025550123", sms.toE164("7025550123"));
  check("toE164 strips formatting", sms.toE164("(702) 555-0123") === "+17025550123", sms.toE164("(702) 555-0123"));
  check("toE164 keeps an existing +country number", sms.toE164("+447911123456") === "+447911123456");
  check("toE164 rejects a too-short number", sms.toE164("12345") === null);
  check("classifyInbound STOP", sms.classifyInbound("STOP") === "stop");
  check("classifyInbound Start (opt back in)", sms.classifyInbound("Start") === "start");
  check("classifyInbound HELP", sms.classifyInbound("help") === "help");
  check("classifyInbound a normal reply is not a keyword", sms.classifyInbound("Sounds great, thanks!") === "reply");
  check("classifyInbound bare 'yes' is NOT treated as opt-in", sms.classifyInbound("yes") === "reply");
  {
    const url = "https://x.test/api/sms/inbound", params = { From: "+15551112222", Body: "hi" };
    process.env.TWILIO_AUTH_TOKEN = TOKEN; // authToken() reads env at call time
    const good = sms.verifyInboundSignature(url, params, twilioSig(url, params));
    const bad = sms.verifyInboundSignature(url, params, "wrong");
    check("verifyInboundSignature accepts a valid signature", good.ok === true, good);
    check("verifyInboundSignature rejects a bad signature", bad.ok === false, bad);
  }

  console.log("\n== auto-confirmation text on apply (consent-gated) ==");
  const P_CONSENT = "7025557001";
  await req("/api/hr/apply", { method: "POST", useCookie: false, body: {
    full_name: "Texty McConsent", email: "texty.consent@example.test", phone: P_CONSENT,
    slug: "rbt", source: "website", consent_email: true, consent_sms: true,
    sms_consent_at: new Date().toISOString(), sms_consent_version: "sms-v1-2026-08",
  } });
  const autoRow = await waitForSmsLog(P_CONSENT);
  check("a consenting applicant gets an auto-confirmation SMS logged", !!autoRow, autoRow);
  check("auto SMS is 'simulated' (no Twilio creds)", autoRow && String(autoRow.delivered).startsWith("simulated"), autoRow && autoRow.delivered);
  check("auto SMS recipient normalized to E.164", autoRow && autoRow.recipient === "+1" + P_CONSENT, autoRow && autoRow.recipient);

  const P_NOCONSENT = "7025557002";
  await req("/api/hr/apply", { method: "POST", useCookie: false, body: {
    full_name: "No Texting", email: "no.text@example.test", phone: P_NOCONSENT,
    slug: "rbt", source: "website", consent_email: true, consent_sms: false,
  } });
  await sleep(400);
  const noConsentRows = await pool.query("SELECT * FROM notifications_log WHERE channel='sms' AND recipient LIKE $1", ["%" + P_NOCONSENT]);
  check("a non-consenting applicant gets NO text", noConsentRows.rows.length === 0, noConsentRows.rows.length);

  console.log("\n== auth + manual send gating ==");
  const anon = await req("/api/hr/applicants/1/send-sms", { method: "POST", useCookie: false, body: { body: "hi" } });
  check("unauthenticated manual send is rejected", anon.status === 401 || anon.status === 403, anon.status);

  const login = await req("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signs in", login.status === 200, login.data);

  const listAll = (await req("/api/hr/applicants")).data;
  const rows = Array.isArray(listAll) ? listAll : (listAll.applicants || []);
  const consentApp = rows.find((x) => x.email === "texty.consent@example.test");
  const noConsentApp = rows.find((x) => x.email === "no.text@example.test");
  check("consenting applicant is listed", !!consentApp, rows.slice(0, 2));

  const send1 = await req("/api/hr/applicants/" + consentApp.id + "/send-sms", { method: "POST", body: { body: "Hi! Are you free for a quick call this week?" } });
  check("owner can text a consenting applicant", send1.status === 200 && send1.data.ok, send1.data);
  check("manual send reports simulated delivery", send1.data && String(send1.data.delivered).startsWith("simulated"), send1.data);

  const send2 = await req("/api/hr/applicants/" + noConsentApp.id + "/send-sms", { method: "POST", body: { body: "hello" } });
  check("texting a non-consenting applicant is refused (400)", send2.status === 400, send2);

  // applicant with no phone at all
  await req("/api/hr/apply", { method: "POST", useCookie: false, body: {
    full_name: "Emailonly Person", email: "emailonly@example.test", slug: "rbt", source: "website", consent_email: true, consent_sms: true,
  } });
  const rows2 = (await req("/api/hr/applicants")).data;
  const noPhoneApp = (Array.isArray(rows2) ? rows2 : rows2.applicants || []).find((x) => x.email === "emailonly@example.test");
  const send3 = await req("/api/hr/applicants/" + noPhoneApp.id + "/send-sms", { method: "POST", body: { body: "hi" } });
  check("texting an applicant with no phone is refused (400)", send3.status === 400, send3);

  const emptyBody = await req("/api/hr/applicants/" + consentApp.id + "/send-sms", { method: "POST", body: { body: "   " } });
  check("an empty text body is refused (400)", emptyBody.status === 400, emptyBody);

  const msgs = (await req("/api/hr/applicants/" + consentApp.id)).data.messages || [];
  check("outbound texts are logged on the candidate timeline", msgs.some((m) => m.channel === "sms" && m.direction === "outbound"), msgs.map((m) => m.channel));

  console.log("\n== inbound webhook: signature enforcement ==");
  const badSig = await inbound({ From: "+1" + P_CONSENT, To: "+15550001111", Body: "hello" }, { badSig: true });
  check("an inbound request with a bad signature is rejected (403)", badSig.status === 403, badSig.status);

  console.log("\n== inbound webhook: STOP opts out + blocks future sends ==");
  const stop = await inbound({ From: "+1" + P_CONSENT, To: "+15550001111", Body: "STOP" });
  check("a signed STOP is accepted (200)", stop.status === 200, stop.status);
  check("STOP gets a confirming TwiML reply", /unsubscribed/i.test(stop.text), stop.text.slice(0, 120));
  const optRow = await pool.query("SELECT * FROM sms_opt_outs WHERE phone=$1", ["+1" + P_CONSENT]);
  check("the number is now on the opt-out list", optRow.rows.length === 1, optRow.rows);

  const detailAfterStop = (await req("/api/hr/applicants/" + consentApp.id)).data;
  check("the candidate profile now shows sms_opted_out", detailAfterStop.sms_opted_out === true, detailAfterStop.sms_opted_out);

  const sendAfterStop = await req("/api/hr/applicants/" + consentApp.id + "/send-sms", { method: "POST", body: { body: "still there?" } });
  check("texting an opted-out applicant is refused (400)", sendAfterStop.status === 400, sendAfterStop);

  console.log("\n== inbound webhook: START opts back in ==");
  const start = await inbound({ From: "+1" + P_CONSENT, To: "+15550001111", Body: "START" });
  check("a signed START is accepted", start.status === 200, start.status);
  const optRow2 = await pool.query("SELECT * FROM sms_opt_outs WHERE phone=$1", ["+1" + P_CONSENT]);
  check("the number is removed from the opt-out list", optRow2.rows.length === 0, optRow2.rows);

  console.log("\n== inbound webhook: a real reply lands on the timeline ==");
  const reply = await inbound({ From: "+1" + P_CONSENT, To: "+15550001111", Body: "Yes, Tuesday at 2pm works great!" });
  check("a signed reply is accepted", reply.status === 200, reply.status);
  const detailAfterReply = (await req("/api/hr/applicants/" + consentApp.id)).data;
  const inboundMsg = (detailAfterReply.messages || []).find((m) => m.channel === "sms" && m.direction === "inbound");
  check("the inbound text is logged on the candidate timeline", !!inboundMsg, (detailAfterReply.messages || []).map((m) => m.direction + ":" + m.channel));
  check("replying moves the candidate to 'responded'", detailAfterReply.stage === "responded", detailAfterReply.stage);

  await pool.end();
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
