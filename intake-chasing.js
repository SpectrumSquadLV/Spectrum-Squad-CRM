// intake-chasing.js -- who the automated intake-paperwork chasers leave alone.
//
// Small and pure on purpose. The enrollment packet sweep and the clinical
// screener sweep both consult this, and one of them does more than send email:
// the packet's 7-day rule moves a client to "not moving forward". A rule with
// that much reach should be one function that a test can call directly, not a
// condition copied into two sweeps and a test's re-implementation of them.
"use strict";

// Postgres hands `waitlisted` back as a real boolean, but a couple of older
// code paths compare against "t", so both shapes are accepted rather than
// trusting one driver's.
function isWaitlisted(client) {
  if (!client) return false;
  return client.waitlisted === true || client.waitlisted === "t" || client.waitlisted === 1;
}

// Stages where chasing intake paperwork is wrong. Not because the paperwork
// stopped mattering -- because the message would be wrong to send:
//
//   active      -- the family is IN THERAPY. Whatever a stale packet row says,
//                  they got through intake; a daily "please complete your
//                  enrollment packet" reads as though we lost their file.
//   discharged
//   not_moving_forward
//               -- they have left. Chasing paperwork now is worse than useless.
const NOT_CHASED_STAGES = ["active", "discharged", "not_moving_forward"];

// The whole rule. Waitlisted families are included: the waitlist email tells
// them there is nothing to do right now, so nothing should then ask them to do
// something.
//
// This gates the 7-day auto-close-out as well as the reminders, which is the
// part that actually bites. Silencing the reminder alone would still let the
// deadline move a client in active therapy to "not moving forward" -- closing
// out a family mid-treatment over a packet row nobody ever flipped.
function intakeChasingPaused(client) {
  if (!client) return false;
  if (isWaitlisted(client)) return true;
  return NOT_CHASED_STAGES.includes(client.stage);
}

// Why, in words, for a screen that has to explain itself to staff. Null when
// chasing is running normally.
function pauseReason(client) {
  if (!intakeChasingPaused(client)) return null;
  if (isWaitlisted(client)) return "This family is on the waitlist, so automatic intake emails are paused.";
  if (client.stage === "active") return "This client is in active therapy, so automatic intake emails are paused.";
  return "This client is closed out, so automatic intake emails are paused.";
}

module.exports = { isWaitlisted, intakeChasingPaused, pauseReason, NOT_CHASED_STAGES };
