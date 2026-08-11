// sms-client.js -- a tiny, dependency-free Twilio SMS wrapper.
//
// Mirrors stripe-client.js: no SDK, just the built-in fetch against Twilio's
// REST API, plus the small pure helpers the server needs (E.164 normalization,
// inbound-keyword classification, and X-Twilio-Signature verification).
//
// It degrades gracefully: with no Twilio credentials set, configured() is false
// and the server falls back to "simulated" sends (logged, not delivered), so the
// whole app is demoable with zero external accounts -- exactly like email.
//
// SECURITY / COMPLIANCE: this module only *delivers*. Consent and opt-out
// enforcement live in the server (sendSms) so every path -- automated or manual
// -- goes through the same gate. Never text a recipient who hasn't consented or
// who has opted out.
"use strict";

const crypto = require("crypto");

const API_BASE = "https://api.twilio.com/2010-04-01";

function provider() { return (process.env.SMS_PROVIDER || "none").toLowerCase(); } // twilio | none
function accountSid() { return process.env.TWILIO_ACCOUNT_SID || ""; }
function authToken() { return process.env.TWILIO_AUTH_TOKEN || ""; }
function fromNumber() { return process.env.TWILIO_FROM_NUMBER || ""; }
function messagingServiceSid() { return process.env.TWILIO_MESSAGING_SERVICE_SID || ""; }

// Fully configured to actually deliver? Needs an account, a token, and a sender
// (either a from-number or a Messaging Service SID).
function configured() {
  return provider() === "twilio" && !!accountSid() && !!authToken() && !!(fromNumber() || messagingServiceSid());
}

// Normalize a human-entered phone to E.164 (+15551234567). US-default: bare
// 10-digit numbers get +1, 11-digit 1XXXXXXXXXX get a plus. Anything already in
// +<country> form is kept. Returns null when it can't produce a plausible number
// so callers never send to garbage.
function toE164(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s[0] === "+") {
    const digits = s.slice(1).replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15 ? "+" + digits : null;
  }
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  if (d.length >= 8 && d.length <= 15) return "+" + d;
  return null;
}

// Classify an inbound message body for opt-out handling. Only the explicit
// carrier keywords count -- we deliberately do NOT treat a bare "yes" as opt-in,
// so a normal reply can never silently re-subscribe someone.
const STOP_WORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout"];
const START_WORDS = ["start", "unstop", "yesstop"];
const HELP_WORDS = ["help", "info"];
function classifyInbound(body) {
  const w = String(body == null ? "" : body).trim().toLowerCase().replace(/[^a-z]/g, "");
  if (STOP_WORDS.includes(w)) return "stop";
  if (START_WORDS.includes(w)) return "start";
  if (HELP_WORDS.includes(w)) return "help";
  return "reply";
}

// Verify an inbound Twilio request signature. Twilio signs
// base64(HMAC-SHA1(authToken, fullUrl + concat(sorted key+value pairs))).
// Returns { ok, reason }. Without an auth token we can't verify -- callers
// decide whether to accept that (dev/simulated) or reject it (production).
function verifyInboundSignature(fullUrl, params, signature) {
  const token = authToken();
  if (!token) return { ok: false, reason: "no_auth_token" };
  if (!signature) return { ok: false, reason: "missing_signature" };
  let data = String(fullUrl || "");
  for (const k of Object.keys(params || {}).sort()) data += k + params[k];
  const expected = crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, reason: ok ? null : "mismatch" };
}

// Deliver one message. Returns { ok, sid, status, error }. Throws only on a
// programming error; network/API failures come back as { ok:false, error }.
async function sendMessage({ to, body }) {
  if (!configured()) throw new Error("SMS is not configured on the server (SMS_PROVIDER/TWILIO_* are not set).");
  const form = new URLSearchParams();
  form.set("To", to);
  if (messagingServiceSid()) form.set("MessagingServiceSid", messagingServiceSid());
  else form.set("From", fromNumber());
  form.set("Body", body);
  const auth = Buffer.from(accountSid() + ":" + authToken()).toString("base64");
  const res = await fetch(`${API_BASE}/Accounts/${encodeURIComponent(accountSid())}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: (data && data.message) || `Twilio request failed (${res.status})`, code: data && data.code };
  }
  return { ok: true, sid: data.sid, status: data.status };
}

module.exports = {
  provider, configured, toE164, classifyInbound, verifyInboundSignature, sendMessage,
};
