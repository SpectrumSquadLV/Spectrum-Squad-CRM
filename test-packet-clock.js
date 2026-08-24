// The enrollment packet clock: who gets emailed today, and who gets closed out.
//
// This is the sweep's whole consequence. A packet sitting at 'sent' emails the
// family every day, and on day seven moves them to "not moving forward" -- a
// scheduled job closing a family out, with no person in the loop.
//
// The rule used to live inside the sweep, wrapped around a SignNow call that
// needs live credentials, so the only test of it was a re-implementation of the
// branch inside a test file. A copy of a rule cannot catch a change to the
// rule. This calls the real function.
//
// The case it was extracted for: an enrollment packet the CRM believes it sent
// and SignNow never delivered. That family is chased daily for a document they
// never received, and then closed out for not signing it. Nothing about a
// stage or a waitlist flag can see that, so somebody has to be able to say so
// by hand -- and saying so has to stop BOTH halves.
//
//   node test-packet-clock.js
"use strict";
const path = require("path");
const { packetSweepStep, DAY, HOUR } = require(path.join(__dirname, "packet-clock.js"));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

// A fixed clock, so "seven days" means seven days and not "seven days unless
// the suite runs across a daylight-saving boundary".
const NOW = Date.parse("2026-08-24T12:00:00.000Z");
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

const packet = (extra = {}) => ({
  id: 1, client_id: 1, status: "sent", sent_at: at(3 * DAY),
  last_reminder_at: null, paused_since: null, paused_ms: 0, ...extra,
});
const client = (extra = {}) => ({ id: 1, stage: "intake_packet", waitlisted: false, ...extra });
const step = (p, c) => packetSweepStep({ packet: p, client: c, now: NOW });

section("An ordinary family mid-intake is chased, and eventually closed out");
check("a packet sent 3 days ago with no reminder yet gets today's reminder",
  step(packet(), client()).action === "remind", step(packet(), client()));
check("one reminded an hour ago is left alone",
  step(packet({ last_reminder_at: at(HOUR) }), client()).action === "wait",
  step(packet({ last_reminder_at: at(HOUR) }), client()));
check("one reminded 25 hours ago is due again",
  step(packet({ last_reminder_at: at(25 * HOUR) }), client()).action === "remind");
check("at 7 days it expires and the client is closed out",
  step(packet({ sent_at: at(7 * DAY + HOUR) }), client()).action === "expire");
check("at 6 days and 23 hours it does not",
  step(packet({ sent_at: at(7 * DAY - HOUR), last_reminder_at: at(HOUR) }), client()).action === "wait");

section("A hold stops the emails AND the deadline");
// Both halves, in one assertion each. A hold that only silenced the reminder
// would still close the family out on day seven, in silence -- which is worse
// than the emails it stopped.
const heldClient = client({ intake_chasing_paused_at: at(HOUR) });
check("a family on hold is not reminded", step(packet(), heldClient).action === "hold");
check("and a packet already past 7 days is NOT expired while held",
  step(packet({ sent_at: at(40 * DAY) }), heldClient).action === "hold",
  step(packet({ sent_at: at(40 * DAY) }), heldClient));
check("the clock is stopped, not merely ignored",
  step(packet(), heldClient).startPause === true);
check("and an already-stopped clock is not restarted each sweep",
  step(packet({ paused_since: at(2 * DAY) }), heldClient).startPause === false);

section("Coming off a hold gives back the time they had left");
// The failure this prevents: a family held for three weeks is released and
// instantly closed out, because the packet reads as 24 days old against a
// 7-day deadline. They had 4 days left when it stopped; they get 4 days back.
const released = step(packet({ sent_at: at(24 * DAY), paused_since: at(21 * DAY) }), client());
check("they are not expired the moment the hold lifts", released.action !== "expire", released);
check("the banked pause is the 21 days they actually waited",
  Math.abs(released.bankMs / DAY - 21) < 0.01, released.bankMs / DAY);
check("and the packet reads as the 3 days it really ran",
  Math.abs(released.daysSinceSent - 3) < 0.01, released.daysSinceSent);
check("nothing is banked when there was no pause", step(packet(), client()).bankMs === null);

section("The automatic reasons still hold, through the same path");
// packet-clock defers to intake-chasing rather than carrying its own list, so
// these are here to prove the deferral is real and not just imported.
for (const [label, c] of [
  ["a client in active therapy", client({ stage: "active" })],
  ["a discharged client", client({ stage: "discharged" })],
  ["a client already closed out", client({ stage: "not_moving_forward" })],
  ["a waitlisted family", client({ waitlisted: true })],
]) {
  check(`${label} is not chased`, step(packet(), c).action === "hold", label);
  check(`${label} is not closed out by a stale packet either`,
    step(packet({ sent_at: at(40 * DAY) }), c).action === "hold", label);
}

section("Bad data never closes a family out");
// The direction of the error matters. Every one of these could plausibly be
// read as "infinitely overdue", and each would discharge a real family.
check("a packet with no send date is left alone, not treated as ancient",
  step(packet({ sent_at: null }), client()).action === "wait",
  step(packet({ sent_at: null }), client()));
check("and says why rather than failing silently",
  /no send date/i.test(step(packet({ sent_at: null }), client()).reason || ""));
check("an unparseable send date is treated the same way",
  step(packet({ sent_at: "not a date" }), client()).action === "wait");
check("an unparseable pause start banks nothing rather than banking NaN",
  step(packet({ paused_since: "rubbish" }), client()).bankMs === 0);
check("paused time larger than the packet's age reads as brand new, not negative",
  step(packet({ sent_at: at(3 * DAY), paused_ms: 99 * DAY }), client()).daysSinceSent === 0);
check("a missing client is still chased rather than silently held",
  step(packet(), null).action !== "hold", step(packet(), null));

section("The thresholds are the documented ones");
// Pinned so a change to either has to be deliberate: these are the numbers in
// the reminder email and in what staff tell families.
check("7 days to expiry", step(packet({ sent_at: at(7 * DAY) }), client()).action === "expire");
check("24 hours between reminders",
  step(packet({ last_reminder_at: at(24 * HOUR) }), client()).action === "remind" &&
  step(packet({ last_reminder_at: at(23 * HOUR) }), client()).action === "wait");
check("the first reminder is timed from the send, not from never",
  step(packet({ sent_at: at(2 * HOUR), last_reminder_at: null }), client()).action === "wait");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
