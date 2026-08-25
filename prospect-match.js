// prospect-match.js -- is this business already on this event?
//
// Outreach lists are built by several people from several sources, so the same
// business arrives more than once: "Smith's Bakery", "Smiths Bakery LLC", and
// a website that is the same domain with a www on the front. Left alone that
// becomes two prospects, two people emailing the same owner, and a sponsor
// count that is wrong.
//
// The rule this implements, and its two halves matter equally:
//
//   WARN, NEVER DISCARD. A likely duplicate is shown to the person adding it,
//   with what it matched, and they decide. Silently dropping a row loses
//   whatever was different about it.
//
//   SCOPED TO ONE EVENT. The same bakery sponsoring both the Halloween Palooza
//   and a spring resource fair is normal and correct. Duplicate detection never
//   looks across events.
//
// Pure: no database. The caller supplies the candidate rows. See
// test-prospect-match.js.
"use strict";

// Legal suffixes and punctuation carry no identity -- "Smith's Bakery LLC" and
// "Smiths Bakery" are one business. Stripped for COMPARISON only; what the
// user typed is always what gets stored and shown.
const SUFFIXES = [
  "llc", "l l c", "inc", "incorporated", "corp", "corporation", "co", "company",
  "ltd", "limited", "llp", "lp", "pllc", "pc", "pa", "dba", "the",
];

function normalizeName(v) {
  let s = String(v == null ? "" : v).toLowerCase();
  s = s.replace(/&/g, " and ");
  // Apostrophes are removed rather than turned into spaces: a possessive is
  // part of the word. Splitting it makes "Smith's Bakery" read as "smith s
  // bakery", which then fails to match the same shop typed as "Smiths Bakery".
  s = s.replace(/['\u2018\u2019\u02bc`]/g, "");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return "";
  let words = s.split(" ").filter(Boolean);
  // Strip suffixes from either end, repeatedly: "The Smith Co LLC" -> "smith".
  let changed = true;
  while (changed && words.length > 1) {
    changed = false;
    if (SUFFIXES.includes(words[0])) { words.shift(); changed = true; }
    if (words.length > 1 && SUFFIXES.includes(words[words.length - 1])) { words.pop(); changed = true; }
  }
  return words.join(" ");
}

// The registrable part of a URL or bare host. Two businesses are the same if
// they share a domain, regardless of http/https, www, path or query.
function normalizeDomain(v) {
  let s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");   // scheme
  s = s.split(/[/?#]/)[0];                          // path, query, fragment
  s = s.replace(/^www\./, "");
  s = s.replace(/:\d+$/, "");                       // port
  // A bare word with no dot is not a domain; treating it as one would match
  // every prospect whose website field holds a note rather than a URL.
  if (!s.includes(".")) return "";
  return s;
}

function normalizeEmail(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

// Digits only, and only when there are enough of them to identify anybody. A
// four-digit extension is not a phone number and must not match another one.
function normalizePhone(v) {
  let d = String(v == null ? "" : v).replace(/\D+/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);   // US country code
  return d.length >= 10 ? d : "";
}

function fingerprint(row) {
  return {
    name: normalizeName(row && (row.business_name || row.name)),
    domain: normalizeDomain(row && row.website),
    email: normalizeEmail(row && (row.public_email || row.contact_email || row.email)),
    phone: normalizePhone(row && (row.public_phone || row.contact_phone || row.phone)),
  };
}

// Which fields two rows agree on. An empty value never counts as agreement --
// two prospects with no website recorded have not "matched on website".
function matchedFields(a, b) {
  const fa = fingerprint(a), fb = fingerprint(b);
  const hits = [];
  if (fa.name && fa.name === fb.name) hits.push("business name");
  if (fa.domain && fa.domain === fb.domain) hits.push("website");
  if (fa.email && fa.email === fb.email) hits.push("email");
  if (fa.phone && fa.phone === fb.phone) hits.push("phone");
  return hits;
}

// `existing` must already be scoped to one event by the caller -- this has no
// way to check that, so it is the caller's job and is asserted in the tests.
//
// Confidence is deliberately coarse. "certain" means an identifier only one
// business has; "likely" means the name alone, which is worth a second look but
// is genuinely ambiguous for "Elite Dance" or "Main Street Dental".
function findDuplicates(candidate, existing) {
  const out = [];
  for (const row of existing || []) {
    const fields = matchedFields(candidate, row);
    if (!fields.length) continue;
    const hard = fields.some((f) => f === "website" || f === "email" || f === "phone");
    out.push({
      id: row.id,
      business_name: row.business_name || row.name || null,
      matched_on: fields,
      confidence: hard ? "certain" : "likely",
    });
  }
  // Strongest first, so a screen showing only one shows the one that matters.
  return out.sort((a, b) =>
    (a.confidence === b.confidence ? b.matched_on.length - a.matched_on.length
      : a.confidence === "certain" ? -1 : 1));
}

module.exports = {
  normalizeName, normalizeDomain, normalizeEmail, normalizePhone,
  fingerprint, matchedFields, findDuplicates, SUFFIXES,
};
