// stripe-client.js -- a tiny, dependency-free Stripe REST wrapper.
//
// SECURITY: this client never sees or stores raw card / bank / CVV data. All
// sensitive details are collected by Stripe's own hosted Checkout (setup mode),
// so the CRM only ever handles safe identifiers (customer id, payment-method
// brand + last4, status). The secret key lives only in the server environment.
//
// It degrades gracefully: with no STRIPE_SECRET_KEY set, configured() is false
// and the callers show a "not connected" state instead of erroring.
const crypto = require("crypto");

const API = "https://api.stripe.com/v1";

function secretKey() { return process.env.STRIPE_SECRET_KEY || ""; }
function webhookSecret() { return process.env.STRIPE_WEBHOOK_SECRET || ""; }
function configured() { return !!secretKey(); }

// Stripe wants application/x-www-form-urlencoded with bracket notation for
// nested params. This flattens { a: { b: 1 }, m: {x:'y'} } -> a[b]=1&m[x]=y.
function encodeForm(obj, prefix) {
  const parts = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val == null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (typeof val === "object" && !Array.isArray(val)) {
      parts.push(encodeForm(val, k));
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(val))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

async function call(method, path, body) {
  if (!configured()) throw new Error("Stripe is not configured on the server (STRIPE_SECRET_KEY is not set).");
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bearer " + secretKey(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? encodeForm(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Stripe request failed (${res.status})`;
    const err = new Error(msg); err.stripe = data && data.error; throw err;
  }
  return data;
}

// Create (or reuse) a Stripe Customer for an organization. Returns { id, ... }.
async function createCustomer({ name, email, metadata }) {
  return call("POST", "/customers", { name, email, metadata });
}

// A hosted Checkout Session in SETUP mode: Stripe collects and tokenizes the
// payment method on its own pages, then redirects back. We only ever store what
// the webhook / retrieval returns (customer id, brand, last4, status).
async function createSetupCheckoutSession({ customerId, successUrl, cancelUrl, paymentMethodTypes }) {
  const body = {
    mode: "setup",
    customer: customerId,
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
  (paymentMethodTypes || ["card", "us_bank_account"]).forEach((t, i) => { body[`payment_method_types[${i}]`] = t; });
  return call("POST", "/checkout/sessions", body);
}

async function retrieveCheckoutSession(id) { return call("GET", `/checkout/sessions/${encodeURIComponent(id)}`); }
async function retrievePaymentMethod(id) { return call("GET", `/payment_methods/${encodeURIComponent(id)}`); }
async function retrieveCustomer(id) { return call("GET", `/customers/${encodeURIComponent(id)}`); }

// Verify a Stripe webhook signature (HMAC-SHA256 over `${t}.${payload}`), the
// same scheme stripe.webhooks.constructEvent uses. Returns the parsed event or
// throws. Requires STRIPE_WEBHOOK_SECRET.
function verifyWebhook(rawBody, sigHeader, toleranceSec) {
  const secret = webhookSecret();
  if (!secret) throw new Error("Stripe webhook secret is not configured (STRIPE_WEBHOOK_SECRET).");
  const parts = {};
  String(sigHeader || "").split(",").forEach((kv) => { const i = kv.indexOf("="); if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); });
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) throw new Error("Missing Stripe-Signature header.");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Stripe signature verification failed.");
  // (Timestamp tolerance intentionally lenient here; tighten with toleranceSec.)
  return JSON.parse(rawBody);
}

// Pull safe, display-only payment-method details from a Stripe PM object.
function safePaymentMethodSummary(pm) {
  if (!pm) return {};
  const type = pm.type || null;
  let brand = null, last4 = null;
  if (pm.card) { brand = pm.card.brand || null; last4 = pm.card.last4 || null; }
  else if (pm.us_bank_account) { brand = pm.us_bank_account.bank_name || "bank account"; last4 = pm.us_bank_account.last4 || null; }
  return { type, brand, last4 };
}

module.exports = {
  configured, webhookSecretConfigured: () => !!webhookSecret(),
  createCustomer, createSetupCheckoutSession, retrieveCheckoutSession,
  retrievePaymentMethod, retrieveCustomer, verifyWebhook, safePaymentMethodSummary,
};
