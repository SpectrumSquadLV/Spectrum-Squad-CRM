// packet-clock.js -- what the enrollment packet sweep should do to one packet.
//
// Extracted from the sweep so it can be tested for real. The sweep itself is
// wrapped around a SignNow call, so anything inside it needs live credentials
// to reach; the consequence was that the only test of the 7-day rule was a
// hand-copy of the branch inside the test file, which by construction cannot
// catch a change to the rule it is copying.
//
// What lives here is the part with teeth: whether a family is emailed today,
// and whether they are closed out as "not moving forward". No I/O, no clock of
// its own -- `now` is passed in -- so a test can put a packet at any age and
// read the real answer.
"use strict";

const { intakeChasingPaused } = require("./intake-chasing");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const EXPIRE_AFTER_DAYS = 7;
const REMIND_AFTER_HOURS = 24;

function msFrom(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

// Returns exactly one action, plus the paused time that should be banked
// alongside it (null when there is nothing to bank).
//
//   hold    -- this family is not being chased. `startPause` says whether the
//              clock still needs stopping.
//   expire  -- the 7 days are up: close the packet and the client out.
//   remind  -- send today's reminder.
//   wait    -- nothing due.
function packetSweepStep({ packet, client, now, expireAfterDays = EXPIRE_AFTER_DAYS, remindAfterHours = REMIND_AFTER_HOURS }) {
  // Families we should not be chasing are not reminded AND not timed out. The
  // clock is genuinely stopped, not just quiet: suppressing the reminder alone
  // would still let the 7-day rule move them to "not moving forward", which
  // for a client already in active therapy -- or one whose packet was never
  // actually delivered -- closes a family out over a row nobody flipped.
  if (intakeChasingPaused(client)) {
    return { action: "hold", startPause: !packet.paused_since, bankMs: null };
  }

  let pausedMs = Number(packet.paused_ms || 0);
  let bankMs = null;
  if (packet.paused_since) {
    // Came off the hold since the last sweep: bank the paused time and carry on
    // from where the clock stopped, rather than from zero or from the original
    // send date.
    const startedAt = msFrom(packet.paused_since);
    const pausedFor = startedAt === null ? 0 : Math.max(0, now - startedAt);
    pausedMs += pausedFor;
    bankMs = pausedMs;
  }

  const sentAt = msFrom(packet.sent_at);
  if (sentAt === null) {
    // A packet with no usable send date has no age, and guessing one would
    // guess in the direction of closing a family out. `new Date(null)` is the
    // epoch, so the arithmetic below would read it as fifty years overdue.
    return { action: "wait", bankMs, daysSinceSent: null, reason: "no send date on the packet" };
  }

  // Clamped: if paused_ms ever exceeded the real elapsed time -- a clock
  // change, or a pause recorded against a re-sent packet -- the packet reads
  // as brand new rather than as a negative age, which errs towards giving the
  // family more time instead of less.
  const daysSinceSent = Math.max(0, now - sentAt - pausedMs) / DAY;

  if (daysSinceSent >= expireAfterDays) return { action: "expire", bankMs, daysSinceSent };

  const lastReminder = msFrom(packet.last_reminder_at) ?? sentAt;
  const hoursSinceReminder = (now - lastReminder) / HOUR;
  if (hoursSinceReminder >= remindAfterHours) {
    return { action: "remind", bankMs, daysSinceSent, hoursSinceReminder };
  }
  return { action: "wait", bankMs, daysSinceSent, hoursSinceReminder };
}

module.exports = { packetSweepStep, EXPIRE_AFTER_DAYS, REMIND_AFTER_HOURS, HOUR, DAY };
