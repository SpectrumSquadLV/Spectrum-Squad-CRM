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
const { intakeChasingPaused, isWaitlisted, pauseReason, onHold, automaticPauseReason, chasingState } =
  require(path.join(__dirname, "intake-chasing.js"));

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

section("A hold somebody put there by hand");
// The case this was added for: a packet the CRM believes it sent that SignNow
// never delivered. No stage and no flag can see that, so a person has to say
// so -- and the family is then chased daily for a document they never received
// and closed out by the 7-day rule for not signing it.
const held = (extra = {}) => client("intake_packet", {
  intake_chasing_paused_at: "2026-08-24T10:00:00.000Z",
  intake_chasing_paused_by: "qblake@spectrumsquadlv.com",
  ...extra,
});
check("a hold pauses chasing", intakeChasingPaused(held()) === true);
check("and is reported as a hold, not as a stage",
  /on hold/i.test(pauseReason(held()) || ""), pauseReason(held()));
check("the note is carried into the reason so staff read WHY",
  /never delivered/.test(pauseReason(held({ intake_chasing_pause_note: "packet never delivered" })) || ""),
  pauseReason(held({ intake_chasing_pause_note: "packet never delivered" })));
check("a hold with no note still explains itself",
  (pauseReason(held()) || "").length > 20, pauseReason(held()));

section("A hold is only a hold when it really is one");
// The timestamp IS the flag, so anything falsy or blank must read as no hold.
// Getting this wrong in the lenient direction would silence a family nobody
// meant to silence, and nothing would report it.
for (const empty of [null, undefined, "", "   "]) {
  check(`intake_chasing_paused_at = ${JSON.stringify(empty)} is not a hold`,
    onHold(client("intake_packet", { intake_chasing_paused_at: empty })) === false, empty);
  check(`...and chasing continues`,
    intakeChasingPaused(client("intake_packet", { intake_chasing_paused_at: empty })) === false, empty);
}
check("a hold on a null client is not a hold", onHold(null) === false);

section("Lifting a hold does not always resume anything");
// The question a person actually has at the moment they click Resume. A hold
// on a waitlisted family lifts to... still paused. A button that implies
// otherwise gets clicked twice and then reported as broken.
const heldAndWaitlisted = held({ waitlisted: true });
check("a hold outranks the waitlist in the reason shown",
  /on hold/i.test(pauseReason(heldAndWaitlisted) || ""), pauseReason(heldAndWaitlisted));
check("but the waitlist is still reported as what remains",
  /waitlist/i.test(automaticPauseReason(heldAndWaitlisted) || ""), automaticPauseReason(heldAndWaitlisted));
check("and the state says lifting the hold changes nothing",
  chasingState(heldAndWaitlisted).still_paused_without_hold === true);
check("whereas for an ordinary intake client it does",
  chasingState(held()).still_paused_without_hold === false);
check("an active client is reported without a hold in the way",
  automaticPauseReason(client("active")) !== null && automaticPauseReason(client("intake_packet")) === null);

section("The state a screen renders is derived here, not on the screen");
// The card used to work out "is this family being chased" from `waitlisted`
// alone. One rule, one place -- otherwise the screen and the sweeps drift and
// the screen is the one people believe.
const st = chasingState(held({ intake_chasing_pause_note: "SignNow never delivered it" }));
check("it reports the pause", st.paused === true && st.on_hold === true, st);
check("it says when", st.held_at === "2026-08-24T10:00:00.000Z", st.held_at);
check("and by whom, so a hold has an owner", st.held_by === "qblake@spectrumsquadlv.com", st.held_by);
check("and carries the note", /SignNow never delivered/.test(st.note || ""), st.note);
const running = chasingState(client("intake_packet"));
check("a family being chased normally reports no hold and no reason",
  running.paused === false && running.on_hold === false && running.reason === null, running);
check("and nothing is invented about who held it",
  running.held_at === null && running.held_by === null && running.note === null, running);

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
// The packet sweep now reaches the rule through packet-clock.js, which is what
// makes the 7-day arithmetic testable without live SignNow credentials. The
// chain still has to be unbroken, so each link is checked rather than assumed.
const clock = fs.readFileSync(path.join(__dirname, "packet-clock.js"), "utf8");
check("the packet sweep asks packet-clock what to do", /packetSweepStep\(\{ packet, client: packetClient, now \}\)/.test(server));
check("packet-clock requires the rule", /require\("\.\/intake-chasing"\)/.test(clock));
check("and gates on it before anything else", /if \(intakeChasingPaused\(client\)\)/.test(clock));
check("the sweep honours a hold by stopping, not by carrying on quietly",
  /if \(step\.action === "hold"\)[\s\S]{0,200}continue;/.test(server));
check("the screener invite pass gates on it", /filter\(\(c\) => !chasingPaused\(c\)\)/.test(screener));
check("the screener reminder pass gates on it", /if \(chasingPaused\(client\)\) continue;/.test(screener));
check("server.js no longer carries its own stage list",
  !/\["active", "discharged", "not_moving_forward"\]\.includes/.test(server));

section("The hold reaches the parts that actually bite");
check("the card gets its state from the module, not from its own guess",
  /intakeChasing: chasingState\(client\)/.test(server));
check("placing a hold stops the packet clock there and then, not at the next sweep",
  /UPDATE enrollment_packets SET paused_since = \? WHERE client_id = \? AND status = 'sent' AND paused_since IS NULL/.test(server));
check("and it is recorded in the case notes rather than only in a column",
  /Automatic intake reminders put on hold/.test(server));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
check("the card shows a held family without anything needing to be unfolded",
  /Automatic intake reminders are on hold/.test(html));
check("and the board marks them too, so a hold is not invisible from outside",
  /intake_chasing_paused_at \? `<span class="tag"/.test(html));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
