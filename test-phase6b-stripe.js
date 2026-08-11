// Phase 6b (Stripe tokenized payments, item 12) integration test.
// Boot the server with STRIPE_WEBHOOK_SECRET=whsec_test (and NO STRIPE_SECRET_KEY)
// so we can exercise the not-configured paths and the webhook end to end.
//
//   DATABASE_URL=... STRIPE_WEBHOOK_SECRET=whsec_test node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-phase6b-stripe.js
const { Pool } = require("pg");
const crypto = require("crypto");
const BASE = process.env.BASE || "http://localhost:3009";
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let cookieOwner = "", cookieStaff = "", pass = 0, fail = 0;
function mk(getset) { return async (path, { method = "GET", body, cookie } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie"); const jar = sc ? sc.split(";")[0] : cookie;
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, jar };
}; }
const req = mk();
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 300) : "")); } }
function signed(payload) {
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${sig}`;
}
async function webhook(eventObj, sigHeader) {
  const payload = JSON.stringify(eventObj);
  const res = await fetch(BASE + "/api/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": sigHeader != null ? sigHeader : signed(payload) }, body: payload });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

(async () => {
  const owner = await req("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signs in", owner.status === 200, owner.data); cookieOwner = owner.jar;
  const staff = await req("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("staffer signs in", staff.status === 200, staff.data); cookieStaff = staff.jar;

  // A contract to attach payment to.
  const created = await req("/api/leads", { method: "POST", body: { name: "Sunrise Elementary", contact_email: "billing@sunrise.test" }, cookie: cookieOwner });
  const id = created.data.id;

  console.log("\n== payment status is owner-gated + safe-only ==");
  const asStaff = await req("/api/leads/" + id + "/payment", { cookie: cookieStaff });
  check("a non-owner cannot view payment info (403)", asStaff.status === 403, asStaff.status);
  const asOwner = await req("/api/leads/" + id + "/payment", { cookie: cookieOwner });
  check("owner can view payment status", asOwner.status === 200, asOwner.data);
  check("Stripe reports not-configured (no secret key set)", asOwner.data.configured === false, asOwner.data);
  check("no method on file yet", asOwner.data.payment_method_on_file === false, asOwner.data);
  // The response must expose ONLY safe fields (no raw card/bank keys).
  const keys = Object.keys(asOwner.data);
  const forbidden = keys.filter((k) => /number|cvv|cvc|routing|account_number|pan|secret/i.test(k));
  check("the payload contains no sensitive field names", forbidden.length === 0, forbidden);

  console.log("\n== setup refuses gracefully when Stripe isn't connected ==");
  const setup = await req("/api/leads/" + id + "/payment/setup", { method: "POST", cookie: cookieOwner });
  check("setup returns a clear not-configured error (400)", setup.status === 400 && /not connected|STRIPE_SECRET_KEY/i.test(setup.data.error || ""), setup.data);

  console.log("\n== webhook: signature is enforced ==");
  await pool.query("UPDATE crm_leads SET stripe_customer_id='cus_test123' WHERE id=$1", [id]);
  const bad = await webhook({ type: "payment_method.attached", data: { object: { customer: "cus_test123", type: "card", card: { brand: "visa", last4: "4242" } } } }, "t=1,v1=deadbeef");
  check("an invalid signature is rejected (400)", bad.status === 400, bad.status);

  console.log("\n== webhook: a verified event updates only safe fields ==");
  const attach = await webhook({ type: "payment_method.attached", data: { object: { customer: "cus_test123", type: "card", card: { brand: "visa", last4: "4242" } } } });
  check("a properly-signed event is accepted", attach.status === 200 && attach.data.ok, attach.data);
  let lead = (await pool.query("SELECT * FROM crm_leads WHERE id=$1", [id])).rows[0];
  check("method-on-file is now true", lead.payment_method_on_file === true || lead.payment_method_on_file === "t", lead.payment_method_on_file);
  check("safe brand + last4 stored", lead.payment_method_brand === "visa" && lead.payment_method_last4 === "4242", { brand: lead.payment_method_brand, last4: lead.payment_method_last4 });
  check("status set to active", lead.payment_status === "active", lead.payment_status);

  const paid = await webhook({ type: "payment_intent.succeeded", data: { object: { customer: "cus_test123", amount_received: 25000 } } });
  check("a payment_intent.succeeded is applied", paid.data.ok, paid.data);
  lead = (await pool.query("SELECT * FROM crm_leads WHERE id=$1", [id])).rows[0];
  check("last payment amount recorded ($250.00)", Number(lead.last_payment_amount) === 250, lead.last_payment_amount);

  const failed = await webhook({ type: "payment_intent.payment_failed", data: { object: { customer: "cus_test123" } } });
  check("a payment failure is applied", failed.data.ok, failed.data);
  lead = (await pool.query("SELECT * FROM crm_leads WHERE id=$1", [id])).rows[0];
  check("failed-payment flag is raised", lead.failed_payment === true || lead.failed_payment === "t", lead.failed_payment);

  console.log("\n== the payment activity is on the contract timeline ==");
  const events = (await pool.query("SELECT * FROM crm_lead_events WHERE lead_id=$1 AND actor='stripe'", [id])).rows;
  check("Stripe updates are logged on the timeline", events.length >= 2, events.length);

  await pool.end();
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
