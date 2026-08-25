// Duplicate protection for event prospects.
//
// Outreach lists get built by several people from several sources, so the same
// business arrives more than once under slightly different spellings. Two
// prospects means two people emailing the same owner, and a sponsor count that
// is wrong.
//
// The two halves of the rule are tested equally hard, because getting either
// backwards is worse than having no duplicate check at all:
//
//   WARN, NEVER DISCARD -- a match is surfaced, never silently dropped.
//   SCOPED TO ONE EVENT -- the same bakery sponsoring the Halloween Palooza and
//   a spring resource fair is normal. Blocking that would be a bug.
//
//   node test-prospect-match.js
"use strict";
const path = require("path");
const {
  normalizeName, normalizeDomain, normalizeEmail, normalizePhone,
  matchedFields, findDuplicates,
} = require(path.join(__dirname, "prospect-match.js"));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

section("The same business typed differently is the same business");
const SAME = [
  ["Smith's Bakery", "Smiths Bakery"],
  ["The Smith's Bakery, LLC", "Smiths Bakery"],
  ["Smith & Sons", "Smith and Sons"],
  ["ACME Corp.", "Acme Corporation"],
  ["Vegas Dental Group Inc", "vegas dental group"],
  ["  Double  Spaced  Co ", "Double Spaced"],
];
for (const [a, b] of SAME) {
  check(`"${a}" == "${b}"`, normalizeName(a) === normalizeName(b), { a: normalizeName(a), b: normalizeName(b) });
}

section("...but genuinely different businesses stay different");
// Over-normalising is the quieter failure: it merges two real sponsors and
// somebody only finds out when one of them is missing from the banner.
const DIFFERENT = [
  ["Smith's Bakery", "Smith's Butchers"],
  ["Main Street Dental", "Main Street Dance"],
  ["Vegas Pediatrics", "Vegas Pediatric Dentistry"],
];
for (const [a, b] of DIFFERENT) {
  check(`"${a}" != "${b}"`, normalizeName(a) !== normalizeName(b), { a: normalizeName(a), b: normalizeName(b) });
}
check("a name that is only a suffix is not erased to nothing",
  normalizeName("The Company") !== "", normalizeName("The Company"));

section("Websites match on the domain, not the exact string");
for (const [a, b] of [
  ["https://www.smiths.com/menu?x=1", "smiths.com"],
  ["HTTP://Smiths.com", "https://smiths.com/"],
  ["www.smiths.com:8080/a/b", "smiths.com"],
]) {
  check(`"${a}" == "${b}"`, normalizeDomain(a) === normalizeDomain(b), { a: normalizeDomain(a), b: normalizeDomain(b) });
}
check("different domains do not match", normalizeDomain("smiths.com") !== normalizeDomain("smiths.net"));
check("a note typed into the website box is not a domain",
  normalizeDomain("ask Maria for it") === "", normalizeDomain("ask Maria for it"));
check("...so two prospects with notes there do not match each other",
  matchedFields({ business_name: "A", website: "no site" }, { business_name: "B", website: "none" }).length === 0);

section("Phone numbers match on digits, with enough of them to mean something");
check("formatting is ignored", normalizePhone("(702) 555-0134") === normalizePhone("702.555.0134"));
check("a US country code is ignored", normalizePhone("+1 702 555 0134") === normalizePhone("7025550134"));
check("an extension is not a phone number", normalizePhone("x4471") === "", normalizePhone("x4471"));
check("...so two short numbers do not match each other",
  matchedFields({ business_name: "A", public_phone: "1234" }, { business_name: "B", public_phone: "1234" }).length === 0);
check("a bad email is not an identifier", normalizeEmail("not an email") === "");
check("but a real one is lowercased", normalizeEmail(" Ana@Example.COM ") === "ana@example.com");

section("A blank field is never a match");
// The failure that would make this useless: every prospect with no website
// matching every other prospect with no website.
const blankA = { business_name: "Alpha", website: "", public_email: "", public_phone: "" };
const blankB = { business_name: "Beta", website: null, public_email: null, public_phone: undefined };
check("two mostly-empty rows do not match", matchedFields(blankA, blankB).length === 0, matchedFields(blankA, blankB));
check("and neither matches an empty candidate against a full row",
  matchedFields({ business_name: "" }, { business_name: "Alpha", website: "a.com" }).length === 0);

section("How sure we are is reported honestly");
// A shared email or domain is an identifier only one business has. A shared
// NAME is worth a look but genuinely ambiguous -- there are three "Elite Dance"
// studios in Las Vegas.
const existing = [
  { id: 1, business_name: "Smiths Bakery", website: "smiths.com", public_email: "hi@smiths.com" },
  { id: 2, business_name: "Elite Dance", website: "elitedancelv.com" },
];
let dupes = findDuplicates({ business_name: "Smith's Bakery LLC", website: "https://www.smiths.com" }, existing);
check("a domain match is certain", dupes[0] && dupes[0].confidence === "certain", dupes);
check("and says what it matched on",
  dupes[0].matched_on.includes("website") && dupes[0].matched_on.includes("business name"), dupes[0]);
dupes = findDuplicates({ business_name: "Elite Dance" }, existing);
check("a name-only match is only likely", dupes[0] && dupes[0].confidence === "likely", dupes);
check("a business nobody has added yet is not a duplicate",
  findDuplicates({ business_name: "Brand New Co", website: "brandnew.com" }, existing).length === 0);

section("The strongest match is listed first");
const many = [
  { id: 10, business_name: "Elite Dance" },
  { id: 11, business_name: "Something Else", public_email: "hi@elite.com" },
];
dupes = findDuplicates({ business_name: "Elite Dance", public_email: "hi@elite.com" }, many);
check("both are found", dupes.length === 2, dupes);
check("the certain one comes first", dupes[0].confidence === "certain" && dupes[0].id === 11, dupes);

section("Nothing is ever discarded");
// findDuplicates REPORTS. It has no power to drop a row, and the shape it
// returns has to carry enough for a person to decide.
check("it returns matches rather than a yes/no", Array.isArray(dupes));
check("each match names the existing record so it can be opened",
  dupes.every((d) => d.id !== undefined && d.business_name !== undefined), dupes);
check("an empty existing list is simply no duplicates",
  findDuplicates({ business_name: "Anything" }, []).length === 0);
check("and a missing list does not throw",
  findDuplicates({ business_name: "Anything" }, null).length === 0);
check("junk candidates do not throw either",
  findDuplicates(null, existing).length === 0 && findDuplicates({}, existing).length === 0);

section("Duplicate checking is the caller's to scope to one event");
// There is no event_id here on purpose: this function cannot see events, so it
// cannot accidentally block a business from a second event. The caller passes
// only that event's prospects. test-events.js proves the caller does that.
check("the function takes no event and returns none",
  findDuplicates({ business_name: "X" }, [{ id: 1, business_name: "X", event_id: 999 }])
    .every((d) => d.event_id === undefined));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
