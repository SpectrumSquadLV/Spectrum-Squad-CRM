// vendor-application.js -- reading what a stranger typed into a public form.
//
// Phase 5 puts a vendor sign-up form on the open internet. Nothing else in the
// event system takes input from somebody with no account, so this is where the
// care goes.
//
// THE RULE: an applicant controls only what they are describing about
// themselves. The fields are an ALLOWLIST, not a denylist. Anything not on it
// -- a status, an id, an event, a fee, a flag -- is ignored no matter what
// arrives in the body, so no amount of guessing at field names lets somebody
// approve their own booth, waive their own fee, or attach themselves to a
// different event.
//
// Pure: no database, no network. See test-vendor-application.js.
"use strict";

// Everything a vendor may say about themselves, with its cap. The cap matters
// as much as the name: an unbounded text field on a public form is how a
// database fills up overnight.
const FIELDS = {
  vendor_name: 200,
  vendor_type: 120,
  products_services: 2000,
  contact_name: 200,
  contact_email: 200,
  contact_phone: 60,
  booth_size: 60,
  special_requirements: 2000,
  website: 500,
};
// Booleans they may set, all of them describing their own needs on the day.
const FLAGS = ["electricity_needed", "table_needed"];
// Deliberately NOT accepted from the public: status, prospect_id, event_id,
// insurance_received, arrival_instructions_sent, final_confirmation_sent,
// notes (staff-facing), booth_number, or anything about money.

// Control characters are stripped rather than stored. They are invisible in a
// form field, survive into staff screens and exports, and are a standard way to
// smuggle something past a reader who is skimming. Built with new RegExp so the
// source file itself contains no control bytes.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

const clean = (v, max) => {
  const s = String(v == null ? "" : v).replace(CONTROL_CHARS, "").trim();
  return s ? s.slice(0, max) : null;
};
const bool = (v) => v === true || v === "true" || v === "on" || v === 1 || v === "1";

function validEmail(v) {
  const s = String(v == null ? "" : v).replace(CONTROL_CHARS, "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200 ? s : "";
}

// The honeypot is a field a real person never sees and never fills. A bot that
// fills every input it finds trips it. Anything caught is answered with the
// same cheerful page as a real submission -- telling a bot it was detected only
// teaches whoever wrote it to try again.
const HONEYPOT_FIELD = "company_website_confirm";

function looksAutomated(body) {
  return !!String((body && body[HONEYPOT_FIELD]) || "").trim();
}

// Returns { ok, value, errors }. Errors are phrased for a member of the public
// filling in a form, not for a developer reading a log.
function parseApplication(body) {
  const b = body && typeof body === "object" ? body : {};
  const errors = [];

  const vendorName = clean(b.vendor_name, FIELDS.vendor_name);
  if (!vendorName) errors.push("Please tell us your business name.");

  const email = validEmail(b.contact_email);
  if (!email) {
    errors.push(String(b.contact_email || "").trim()
      ? "That email address doesn't look right."
      : "Please give us an email address so we can reply.");
  }

  const value = { vendor_name: vendorName, contact_email: email || null };
  for (const [field, max] of Object.entries(FIELDS)) {
    if (field === "vendor_name" || field === "contact_email") continue;
    value[field] = clean(b[field], max);
  }
  for (const f of FLAGS) value[f] = bool(b[f]);

  // A number, bounded. "How many chairs" is not a place to accept anything.
  const chairs = parseInt(b.chairs_needed, 10);
  value.chairs_needed = Number.isFinite(chairs) && chairs > 0 ? Math.min(chairs, 50) : null;

  return { ok: errors.length === 0, value, errors };
}

module.exports = { parseApplication, looksAutomated, validEmail, FIELDS, FLAGS, HONEYPOT_FIELD };
