// A client in active therapy is not chased for intake paperwork.
//
// The bug this exists to prevent has teeth. The enrollment packet sweep does
// two things when a packet has been out for 7 days: it stops reminding, and it
// moves the client to "not moving forward". Nothing checked whether the family
// had since started therapy -- so a client in active treatment, whose packet
// row was never flipped to completed, would be emailed daily about enrollment
// and then closed out mid-treatment by a scheduled job.
//
// The sibling suite (test-waitlist-quiet.js) re-implements the sweep's branch
// inside the test, which means it cannot catch a change to the real rule. This
// one calls the real function, so it can.
//
//   node test-intake-chasing.js
"use strict";
const path = require("path");
const { intakeChasingPaused, isWaitlisted, pauseReason } = require(path.join(__dirname, "intake-chasing.js"));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

const client = (stage, extra = {}) => ({ stage, waitlisted: false, ...extra });

section("A client in active therapy is left alone");
check("active therapy pauses chasing", intakeChasingPaused(client("active")) === true);
check("and says why in words a person can read",
  /active therapy/i.test(pauseReason(client("active")) || ""), pauseReason(client("active")));

section("So is a family who has left");
check("discharged", intakeChasingPaused(client("discharged")) === true);
check("not moving forward", intakeChasingPaused(client("not_moving_forward")) === true);
check("the reason says closed out",
  /closed out/i.test(pauseReason(client("discharged")) || ""), pauseReason(client("discharged")));

section("The waitlist rule still holds");
for (const shape of [true, "t", 1]) {
  check(`waitlisted as ${JSON.stringify(shape)} pauses chasing`,
    intakeChasingPaused(client("intake_packet", { waitlisted: shape })) === true);
}
check("and is reported as the waitlist, not as a stage",
  /waitlist/i.test(pauseReason(client("intake_packet", { waitlisted: true })) || ""));

section("Families who SHOULD be chased still are");
// The whole value of the change is that it narrows nothing else. A client
// halfway through intake who has not signed is exactly who these reminders and
// the 7-day deadline are for.
for (const stage of ["new_submission", "clinical_screener", "insurance_verification",
  "intake_packet", "assessment_scheduling", "authorization", "first_day_scheduled"]) {
  check(`${stage} is still chased`, intakeChasingPaused(client(stage)) === false, stage);
  check(`${stage} reports no pause reason`, pauseReason(client(stage)) === null, pauseReason(client(stage)));
}

section("Odd input does not accidentally silence the chasers");
// Returning true here would silently stop chasing everyone, which is the
// failure mode nobody notices until a month of paperwork has not gone out.
check("null client is not treated as paused", intakeChasingPaused(null) === false);
check("undefined client is not treated as paused", intakeChasingPaused(undefined) === false);
check("a client with no stage at all is still chased", intakeChasingPaused({}) === false);
check("waitlisted false is not truthy", isWaitlisted({ waitlisted: false }) === false);
check("waitlisted 'f' is not truthy", isWaitlisted({ waitlisted: "f" }) === false);

section("The rule is shared, not copied");
// server.js and screener.js must both consult this module. A second copy of
// the condition is how the packet sweep and the screener drift apart.
const fs = require("fs");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const screener = fs.readFileSync(path.join(__dirname, "screener.js"), "utf8");
check("server.js requires it", /require\("\.\/intake-chasing"\)/.test(server));
check("screener.js requires it", /require\("\.\/intake-chasing"\)/.test(screener));
check("the packet sweep gates on it", /intakeChasingPaused\(packetClient\)/.test(server));
check("the screener invite pass gates on it", /filter\(\(c\) => !chasingPaused\(c\)\)/.test(screener));
check("the screener reminder pass gates on it", /if \(chasingPaused\(client\)\) continue;/.test(screener));
check("server.js no longer carries its own stage list",
  !/\["active", "discharged", "not_moving_forward"\]\.includes/.test(server));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
