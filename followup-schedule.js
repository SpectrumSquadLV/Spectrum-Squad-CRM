// followup-schedule.js -- which follow-ups are due, and which are not.
//
// Phase 3 built the outreach queue and deliberately left a seam: templates
// carry a step and a delay_days, and max_follow_ups is enforced, but nothing
// ever acted on them. This is what acts on them.
//
// WHAT IT PRODUCES IS DRAFTS. Not sends. The whole safety model of Phase 3 is
// that a person reads every message before it reaches an inbox, and a
// scheduler that quietly promoted itself to sending would undo all of it. A
// due follow-up lands in the same review queue as everything else.
//
// The delay is measured from when the PREVIOUS step was actually sent, not
// from when its draft was written or approved -- a message that sat in the
// queue for a week has not been waiting on the recipient for a week.
//
// Pure: no database, no clock of its own. See test-followup-schedule.js.
"use strict";

const guard = require("./outreach-guard");

const DAY = 24 * 60 * 60 * 1000;

function msFrom(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

// Highest step actually SENT to this prospect, with when it went.
function lastSent(messages) {
  let best = null;
  for (const m of messages || []) {
    if (m.status !== "sent") continue;
    const step = Number(m.step);
    if (!Number.isFinite(step)) continue;
    if (!best || step > best.step) best = { step, sent_at: m.sent_at, id: m.id };
  }
  return best;
}

// Returns { due, skipped }. Every prospect considered appears in exactly one of
// them, with a reason -- "why didn't the bakery get a follow-up?" is the
// question this exists to answer, and silence is not an answer.
function dueFollowUps({ prospects, messagesByProspect, templatesByStep, settings, suppressedEmails, now }) {
  const nowMs = msFrom(now);
  const due = [], skipped = [];
  const suppressed = suppressedEmails instanceof Set
    ? suppressedEmails
    : new Set((suppressedEmails || []).map((e) => String(e || "").trim().toLowerCase()));

  if (nowMs === null) {
    // No usable clock means nothing is due. Guessing would make every
    // follow-up due at once.
    return { due: [], skipped: (prospects || []).map((p) => ({ prospect_id: p.id, reason: "No usable current time." })) };
  }

  for (const p of prospects || []) {
    const msgs = (messagesByProspect || {})[p.id] || [];
    const sentSteps = msgs.filter((m) => m.status === "sent").map((m) => String(m.step));
    const last = lastSent(msgs);

    if (!last) { skipped.push({ prospect_id: p.id, reason: "No first message has been sent yet." }); continue; }

    const nextStep = last.step + 1;
    const template = (templatesByStep || {})[nextStep];
    if (!template) { skipped.push({ prospect_id: p.id, reason: `No template for step ${nextStep}.` }); continue; }
    if (template.active === false || template.active === "f") {
      skipped.push({ prospect_id: p.id, reason: `The step ${nextStep} template is switched off.` }); continue;
    }

    // Everything Phase 3 already knows about not contacting somebody, asked
    // again here rather than reimplemented: do-not-contact, a reply, the
    // follow-up limit, and one-send-per-step.
    const why = guard.canQueueStep({ step: nextStep, settings, prospect: p, alreadySentSteps: sentSteps });
    if (why) { skipped.push({ prospect_id: p.id, reason: why }); continue; }

    const to = guard.validEmail(p.public_email || p.contact_email);
    if (!to) { skipped.push({ prospect_id: p.id, reason: "No usable email address on file." }); continue; }
    if (suppressed.has(to)) { skipped.push({ prospect_id: p.id, reason: "On the do-not-contact list." }); continue; }

    // Anything already waiting for this step means the sweep has run before,
    // or somebody drafted it by hand. Either way it must not be duplicated.
    if (msgs.some((m) => Number(m.step) === nextStep && (m.status === "draft" || m.status === "approved"))) {
      skipped.push({ prospect_id: p.id, reason: `A step ${nextStep} message is already waiting.` }); continue;
    }
    // A cancelled or skipped one is a decision somebody made. Re-drafting it
    // every night would override that decision silently.
    if (msgs.some((m) => Number(m.step) === nextStep && (m.status === "cancelled" || m.status === "skipped"))) {
      skipped.push({ prospect_id: p.id, reason: `A step ${nextStep} message was already cancelled or skipped.` }); continue;
    }

    const sentMs = msFrom(last.sent_at);
    if (sentMs === null) {
      // The same trap as an unparseable packet date: new Date(null) is the
      // epoch, which would read as fifty years overdue and make every
      // follow-up due at once.
      skipped.push({ prospect_id: p.id, reason: "The previous message has no usable send date." }); continue;
    }
    // Number(null) is 0, and Number("") is 0 -- so a template with no delay
    // recorded would come back as "due immediately" rather than as
    // misconfigured. The absence is checked before the conversion.
    const rawDelay = template.delay_days;
    const delayDays = (rawDelay === null || rawDelay === undefined || String(rawDelay).trim() === "")
      ? NaN : Number(rawDelay);
    if (!Number.isFinite(delayDays) || delayDays < 0) {
      skipped.push({ prospect_id: p.id, reason: `The step ${nextStep} template has no usable delay.` }); continue;
    }
    const dueAt = sentMs + delayDays * DAY;
    if (nowMs < dueAt) {
      const daysLeft = Math.ceil((dueAt - nowMs) / DAY);
      skipped.push({ prospect_id: p.id, reason: `Not due for another ${daysLeft} day(s).`, due_at: new Date(dueAt).toISOString() });
      continue;
    }

    due.push({
      prospect_id: p.id, business_name: p.business_name, to_email: to,
      step: nextStep, template_id: template.id,
      previous_step: last.step, previous_sent_at: last.sent_at,
      due_at: new Date(dueAt).toISOString(),
    });
  }
  return { due, skipped };
}

module.exports = { dueFollowUps, lastSent, DAY };
