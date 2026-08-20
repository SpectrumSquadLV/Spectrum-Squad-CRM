// The inbound SMS webhook on an install with no Twilio credentials.
//
// test-sms.js covers the configured case: the server has TWILIO_AUTH_TOKEN, so
// it can check the X-Twilio-Signature header and does. This suite covers the
// other half, which is the one that was wrong in production -- with no token
// set, the endpoint verified nothing and accepted whatever arrived.
//
// That is not a harmless dev shortcut. /api/sms/inbound is public, and a STOP
// from an unverified caller lands a phone number on the shared opt-out list,
// after which every send to that family is refused. So the endpoint has to
// fail closed: no token, no inbound.
//
// Run with NO TWILIO_AUTH_TOKEN in the server's environment:
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-sms-unconfigured.js
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
}

// A number that belongs to no fixture, so anything found under it came from
// this suite.
const FROM = "+17025550917";

async function postInbound(params, headers = {}) {
  const body = new URLSearchParams(params).toString();
  const r = await fetch(BASE + "/api/sms/inbound", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
  return { status: r.status, text: await r.text() };
}

async function optOutRows() {
  const r = await pool.query("SELECT phone FROM sms_opt_outs WHERE phone = $1", [FROM]);
  return r.rows;
}

(async () => {
  console.log("\n== no auth token configured ==");

  check("the server really has no token (otherwise this suite proves nothing)",
    !process.env.TWILIO_AUTH_TOKEN, process.env.TWILIO_AUTH_TOKEN ? "set" : "unset");

  const plain = await postInbound({ From: FROM, Body: "STOP", MessageSid: "SMtest0001" });
  check("an unsigned inbound request is refused (403)", plain.status === 403, plain);
  check("and says it is a configuration problem, not a bad signature",
    /not configured/i.test(plain.text), plain.text);

  // The point of the refusal: the STOP must not have been acted on.
  check("the forged STOP did not reach the opt-out list", (await optOutRows()).length === 0);

  // A signature header cannot help when there is no token to check it against.
  const signed = await postInbound(
    { From: FROM, Body: "STOP", MessageSid: "SMtest0002" },
    { "X-Twilio-Signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
  );
  check("a request carrying some signature is refused too", signed.status === 403, signed);
  check("still nothing on the opt-out list", (await optOutRows()).length === 0);

  // START would clear an opt-out; it must not be honoured either.
  const start = await postInbound({ From: FROM, Body: "START", MessageSid: "SMtest0003" });
  check("START is refused as well", start.status === 403, start);

  // A GET is a different route entirely -- make sure the refusal above is the
  // signature gate and not the endpoint being missing.
  const wrongMethod = await fetch(BASE + "/api/sms/inbound", { method: "GET" });
  check("the endpoint exists (GET is not a 403)", wrongMethod.status !== 403, wrongMethod.status);

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
