// outreach-guard.js -- may this message actually be sent?
//
// Phase 3 is the first thing in the event system that emails somebody. The
// recipients are local businesses who never asked to hear from us, so the
// interesting logic is not "how do we send" -- it is every reason not to.
//
// All of it is here, pure, so it can be tested exhaustively without a database
// or a network. The sender calls this immediately BEFORE each send, not only
// when the message was queued: a person can be marked do-not-contact, or reply,
// in the hours between a batch being approved and its last message going out,
// and a decision made at queue time would not know.
//
// The nine controls Quiana's spec required, and where each one lives:
//
//   daily send limit          sendableNow() -- counts what already went today
//   batch size                sendableNow() -- caps one pass
//   sending-hour controls     withinSendingHours()
//   maximum follow-ups        canQueueStep()
//   opt-out handling          blockedReason() -- suppression list
//   DO NOT CONTACT            blockedReason() -- the prospect flag AND the list
//   stop when someone replies blockedReason() -- STOPPED_STATUSES
//   no duplicate outreach     blockedReason() -- one send per prospect per step
//   activity logging          the caller writes every outcome; see events.js
"use strict";

// Statuses that mean the conversation has moved on and an automated sequence
// must stop. RESPONDED is the important one: somebody wrote back, and the worst
// thing an outreach system can do is keep sending scheduled follow-ups at a
// person who is already talking to you.
const STOPPED_STATUSES = [
  "RESPONDED", "INTERESTED", "NOT_INTERESTED", "COMMITTED", "DO_NOT_CONTACT",
];

const isTrue = (v) => v === true || v === "t" || v === 1 || v === "1";
const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

function validEmail(v) {
  const s = norm(v);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

// Sending hours are LOCAL clock hours, inclusive start, exclusive end. A
// business does not want a cold email at 03:00, and a domain that sends at 03:00
// looks like a domain that sends spam.
function withinSendingHours(hour, settings) {
  const h = Number(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) return false;
  const start = Number(settings && settings.send_hour_start);
  const end = Number(settings && settings.send_hour_end);
  // An unconfigured or nonsensical window sends nothing. Defaulting to "all
  // day" would be the one direction that cannot be undone.
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < 0 || start > 23 || end < 1 || end > 24 || start >= end) return false;
  return h >= start && h < end;
}

// Reasons the whole run must not proceed, independent of any one recipient.
// Returned as a list because a screen should say everything that is wrong, not
// make somebody fix one thing to discover the next.
function configProblems(settings) {
  const s = settings || {};
  const problems = [];
  if (!isTrue(s.enabled)) problems.push("Outreach sending is switched off.");
  // CAN-SPAM requires a real postal address in commercial email and a working
  // opt-out. Neither is optional, and neither can be invented, so nothing sends
  // until they are configured.
  if (!String(s.postal_address || "").trim()) {
    problems.push("No postal address is configured. Commercial email must carry a real mailing address.");
  }
  if (!Number.isFinite(Number(s.daily_limit)) || Number(s.daily_limit) <= 0) {
    problems.push("No daily send limit is set.");
  }
  if (!Number.isFinite(Number(s.batch_size)) || Number(s.batch_size) <= 0) {
    problems.push("No batch size is set.");
  }
  const start = Number(s.send_hour_start), end = Number(s.send_hour_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || start < 0 || end > 24) {
    problems.push("Sending hours are not set to a usable window.");
  }
  return problems;
}

// Why this ONE message must not go, or null if it may. Order matters only for
// which reason gets reported; every one of them blocks.
function blockedReason({ message, prospect, suppressedEmails, alreadySentSteps }) {
  if (!message) return "There is no message.";
  if (!prospect) return "The prospect this message was written for no longer exists.";

  // A person has to have approved it. Nothing reaches a real inbox because a
  // scheduler decided it was time.
  if (message.status !== "approved") {
    return message.status === "sent" ? "Already sent."
      : "Not approved by a person yet.";
  }

  if (isTrue(prospect.do_not_contact)) return "This business is marked do not contact.";
  if (STOPPED_STATUSES.includes(String(prospect.status || ""))) {
    return `The sequence stops at status ${prospect.status}.`;
  }

  const to = validEmail(message.to_email);
  if (!to) return "No usable email address.";
  const suppressed = suppressedEmails instanceof Set
    ? suppressedEmails
    : new Set((suppressedEmails || []).map(norm));
  if (suppressed.has(to)) return "This address is on the do-not-contact list.";

  // One send per prospect per step, ever. Re-running a batch, or two people
  // pressing send, must not double-message somebody.
  const sent = alreadySentSteps instanceof Set
    ? alreadySentSteps
    : new Set((alreadySentSteps || []).map((s) => String(s)));
  if (sent.has(String(message.step))) return "This step has already been sent to this business.";

  return null;
}

// May a follow-up at this step be QUEUED at all? Separate from blockedReason
// because it is asked earlier, when drafts are generated.
function canQueueStep({ step, settings, prospect, alreadySentSteps }) {
  const s = Number(step);
  if (!Number.isInteger(s) || s < 1) return "Not a valid step.";
  const max = Number((settings || {}).max_follow_ups);
  // Step 1 is the initial approach; steps 2+ are follow-ups. A max of 2 means
  // at most two follow-ups AFTER the first message.
  if (s > 1) {
    if (!Number.isFinite(max) || max < 0) return "No follow-up limit is set.";
    if (s - 1 > max) return `Past the follow-up limit of ${max}.`;
  }
  if (prospect && isTrue(prospect.do_not_contact)) return "This business is marked do not contact.";
  if (prospect && STOPPED_STATUSES.includes(String(prospect.status || ""))) {
    return `The sequence stops at status ${prospect.status}.`;
  }
  const sent = alreadySentSteps instanceof Set
    ? alreadySentSteps
    : new Set((alreadySentSteps || []).map((x) => String(x)));
  if (sent.has(String(s))) return "This step has already been sent to this business.";
  return null;
}

// Which of the approved messages may go out in THIS pass, and why each of the
// rest may not. Nothing is silently dropped -- every message gets a verdict the
// caller can log and a screen can show.
function sendableNow({ messages, prospectsById, suppressedEmails, sentStepsByProspect, settings, sentToday, hour }) {
  const problems = configProblems(settings);
  if (!withinSendingHours(hour, settings)) problems.push("Outside the configured sending hours.");
  if (problems.length) {
    return {
      send: [],
      hold: (messages || []).map((m) => ({ message: m, reason: problems[0] })),
      problems,
      remaining_today: 0,
    };
  }

  const limit = Number(settings.daily_limit);
  const batch = Number(settings.batch_size);
  let remaining = Math.max(0, limit - Math.max(0, Number(sentToday) || 0));

  const send = [], hold = [];
  for (const m of messages || []) {
    const prospect = (prospectsById || {})[m.prospect_id];
    const reason = blockedReason({
      message: m,
      prospect,
      suppressedEmails,
      alreadySentSteps: (sentStepsByProspect || {})[m.prospect_id] || [],
    });
    if (reason) { hold.push({ message: m, reason }); continue; }
    if (send.length >= batch) { hold.push({ message: m, reason: "Batch full — will go in the next pass." }); continue; }
    if (remaining <= 0) { hold.push({ message: m, reason: "Daily send limit reached." }); continue; }
    send.push(m);
    remaining -= 1;
  }
  return { send, hold, problems: [], remaining_today: remaining };
}

// Every outreach email carries a real opt-out and a postal address. Appended by
// the sender rather than left to whoever writes the template, because a
// template somebody forgets to paste it into is the one that goes to five
// hundred businesses.
function complianceFooter({ unsubscribeUrl, postalAddress, orgName }) {
  const addr = String(postalAddress || "").trim();
  const url = String(unsubscribeUrl || "").trim();
  if (!addr || !url) return null;   // the caller must refuse to send
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return '<hr style="margin:24px 0 12px;border:none;border-top:1px solid #e5e7eb;">'
    + '<p style="font-size:12px;color:#6b7280;line-height:1.5;">'
    + esc(orgName || "Spectrum Squad") + '<br>' + esc(addr) + '<br><br>'
    + 'You received this because we are inviting local businesses to take part in a community event. '
    + '<a href="' + esc(url) + '">Unsubscribe</a> and we will not contact you again.'
    + '</p>';
}

module.exports = {
  STOPPED_STATUSES, withinSendingHours, configProblems, blockedReason,
  canQueueStep, sendableNow, complianceFooter, validEmail,
};
