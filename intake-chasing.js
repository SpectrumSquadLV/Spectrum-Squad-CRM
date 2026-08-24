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

// A hold a person put there by hand, for a family the automatic rules have no
// way to know about -- the case this was built for being a packet the CRM
// believes it sent and SignNow never delivered. Chasing a family daily for a
// document they never received, and then closing them out for not signing it,
// is not something a stage or a waitlist flag can spot.
//
// The timestamp IS the flag: a hold that cannot say when it started, and later
// who started it, is a hold nobody can audit or safely lift.
function onHold(client) {
  if (!client) return false;
  return !!String(client.intake_chasing_paused_at || "").trim();
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

// The reasons that apply on their own, with no hold in place. Kept separate
// from the hold so a screen can answer the question that actually matters when
// somebody goes to lift one: "will this family start getting emails again?"
// Lifting a hold on a waitlisted family changes nothing, and a button that
// implies otherwise is a button that gets clicked twice.
function automaticPauseReason(client) {
  if (!client) return null;
  if (isWaitlisted(client)) return "This family is on the waitlist, so automatic intake emails are paused.";
  if (client.stage === "active") return "This client is in active therapy, so automatic intake emails are paused.";
  if (NOT_CHASED_STAGES.includes(client.stage)) return "This client is closed out, so automatic intake emails are paused.";
  return null;
}

function holdReason(client) {
  const note = String((client && client.intake_chasing_pause_note) || "").trim();
  return "Intake reminders are on hold for this family" + (note ? ": " + note : ".");
}

// The whole rule. Waitlisted families are included: the waitlist email tells
// them there is nothing to do right now, so nothing should then ask them to do
// something.
//
// This gates the 7-day auto-close-out as well as the reminders, which is the
// part that actually bites. Silencing the reminder alone would still let the
// deadline move a client in active therapy to "not moving forward" -- closing
// out a family mid-treatment over a packet row nobody ever flipped. A manual
// hold inherits that same protection, which is the point: pausing the emails
// while leaving the deadline running would close the family out in silence,
// which is worse than the emails were.
function intakeChasingPaused(client) {
  if (!client) return false;
  if (onHold(client)) return true;
  if (isWaitlisted(client)) return true;
  return NOT_CHASED_STAGES.includes(client.stage);
}

// Why, in words, for a screen that has to explain itself to staff. Null when
// chasing is running normally. A deliberate hold outranks an automatic reason:
// it is the one somebody chose, and the only one they can undo.
function pauseReason(client) {
  if (!client) return null;
  if (onHold(client)) return holdReason(client);
  return automaticPauseReason(client);
}

// Everything a card or an API response needs to describe the current state
// without re-deriving any of it. Built here so there is exactly one place that
// knows the rule.
function chasingState(client) {
  const held = onHold(client);
  const automatic = automaticPauseReason(client);
  return {
    paused: intakeChasingPaused(client),
    on_hold: held,
    held_at: held ? client.intake_chasing_paused_at : null,
    held_by: held ? (client.intake_chasing_paused_by || null) : null,
    note: held ? (client.intake_chasing_pause_note || null) : null,
    reason: pauseReason(client),
    // True when lifting the hold would NOT resume anything, because an
    // automatic rule is holding it too.
    still_paused_without_hold: !!automatic,
    automatic_reason: automatic,
  };
}

module.exports = {
  isWaitlisted,
  onHold,
  intakeChasingPaused,
  pauseReason,
  automaticPauseReason,
  chasingState,
  NOT_CHASED_STAGES,
};
