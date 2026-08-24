// Reading SignNow's answer to "is this signed yet?"
//
// This suite exists because of a specific outage. Families signed their
// enrollment packets; the CRM never noticed. The detection was one line --
// `field_invites[].status === "fulfilled"` -- which is how SignNow reports a
// ROLE-BASED invite. The enrollment packets go out as FREEFORM invites, and a
// signed freeform invite does not carry that status at all.
//
// Nothing caught it because nothing tested it: the shape came from a live API
// nobody could reach from a test. So the reader is now pure, and every shape
// below is taken from what SignNow actually returned for real Spectrum Squad
// documents (checked against the account on 2026-08-24).
//
//   node test-signnow-status.js
"use strict";
const path = require("path");
const { readSignNowCompletion } = require(path.join(__dirname, "signnow-status.js"));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

section("The shape that broke: a signed freeform invite");
// This is the enrollment packet case. No status string anywhere -- the only
// evidence of signing is that the request carries the signature it produced.
check("a freeform request carrying a signature id reads as completed",
  readSignNowCompletion({
    id: "41289222794449829cd15f65b16fbe66e95b40af",
    requests: [{ id: "r1", signer_email: "leslie.hamid@yahoo.com", signature_id: "sig-abc" }],
  }) === "completed");
check("...and so does one the API marks signed",
  readSignNowCompletion({ requests: [{ id: "r1", signed: true }] }) === "completed");
check("...and a document that simply has a signature on it",
  readSignNowCompletion({ signatures: [{ id: "sig-1", created: 1787176759 }] }) === "completed");

section("The shape that always worked: a role-based invite");
check("field_invites fulfilled still reads as completed",
  readSignNowCompletion({ field_invites: [{ status: "fulfilled" }] }) === "completed");
check("case and padding do not matter",
  readSignNowCompletion({ field_invites: [{ status: "Fulfilled" }] }) === "completed");
check("a fulfilled entry under requests counts too",
  readSignNowCompletion({ requests: [{ status: "fulfilled" }] }) === "completed");

section("Not signed yet is still not signed");
// The other half of the bug would be worse: marking packets complete that are
// not. That sends the screener, stops the reminders, and tells staff a family
// has enrolled when they have not.
check("a pending freeform invite is not complete",
  readSignNowCompletion({ requests: [{ id: "r1", signer_email: "a@b.c" }] }) === null);
check("a pending role invite is not complete",
  readSignNowCompletion({ field_invites: [{ status: "pending" }] }) === null);
check("an empty document is not complete",
  readSignNowCompletion({ field_invites: [], requests: [], signatures: [] }) === null);
check("an empty signatures array is not a signature",
  readSignNowCompletion({ signatures: [] }) === null);
check("a document with nothing on it at all", readSignNowCompletion({}) === null);

section("A decline is a decline, even alongside a signature");
// A family can sign one round and decline a re-send. Reading the stale
// signature and calling that completed would enrol somebody who refused.
check("declined alone", readSignNowCompletion({ field_invites: [{ status: "declined" }] }) === "declined");
check("declined wins over a fulfilled sibling",
  readSignNowCompletion({ field_invites: [{ status: "fulfilled" }, { status: "declined" }] }) === "declined",
  readSignNowCompletion({ field_invites: [{ status: "fulfilled" }, { status: "declined" }] }));
check("declined wins over a stale signature on the document",
  readSignNowCompletion({ requests: [{ status: "declined" }], signatures: [{ id: "old" }] }) === "declined");

section("Junk in does not become a false completion");
for (const junk of [null, undefined, "", 0, [], "completed", { field_invites: "nope" }, { requests: null }]) {
  check(`${JSON.stringify(junk)} reads as not-complete`, readSignNowCompletion(junk) === null,
    readSignNowCompletion(junk));
}

section("server.js uses it rather than keeping its own copy");
const fs = require("fs");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
check("server.js requires the module", /require\("\.\/signnow-status"\)/.test(server));
check("the packet sweep calls it", /signNowStatus = readSignNowCompletion\(doc\)/.test(server));
check("and no longer carries the old one-line check",
  !/field_invites \|\| doc\.requests/.test(server), "the inline check is still there");
check("an undetermined status is logged rather than passing silently",
  /\[signnow\] packet .*not complete yet/.test(server));
// The log line is a diagnostic on a document full of a family's personal
// details -- a signed enrollment packet carries names, dates of birth, an
// address and insurance details. It must say enough to diagnose a mismatch and
// nothing about the family.
//
// This checks the PROPERTY, not one implementation of it: an earlier version of
// this assertion pinned the exact expression used, and failed the moment the
// diagnostic was improved while still being perfectly private.
const logLine = (server.match(/console\.log\(`\[signnow\][\s\S]{0,700}?\);/) || [""])[0];
check("the diagnostic exists", logLine.length > 0);
for (const forbidden of [
  ["field values", /\.value\b/],
  ["the fields array", /\bfields\[/],
  ["the document name, which is the child's name", /document_name/],
  ["the whole response", /JSON\.stringify\(doc\)/],
  ["signer emails", /signer_email|email/i],
]) {
  check(`it does not log ${forbidden[0]}`, !forbidden[1].test(logLine), logLine.slice(0, 260));
}
check("it identifies which packet, so a mismatch can be chased",
  /packet \$\{packet\.id\}/.test(logLine));
check("and which document, so it can be checked against SignNow",
  /signnow_document_id/.test(logLine));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
