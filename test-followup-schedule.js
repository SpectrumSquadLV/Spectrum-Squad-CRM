// Which follow-ups are due (Phase 4).
//
// Phase 3 left a seam: templates carry a step and a delay_days, and
// max_follow_ups is enforced, but nothing acted on them. This acts on them --
// and the single most important thing about it is what it PRODUCES.
//
//   IT PRODUCES DRAFTS, NEVER SENDS. Phase 3's whole safety model is that a
//   person reads every message before it reaches an inbox. A scheduler that
//   promoted itself to sending would undo all of it, silently, at 3am.
//
// After that, in order of damage:
//
//   1. Following up with somebody who replied, unsubscribed, or asked us to
//      stop. The sequence has to notice.
//   2. Every follow-up becoming due at once because a date could not be read.
//      new Date(null) is the epoch, which reads as fifty years overdue.
//   3. Re-drafting something a person already cancelled, overriding their
//      decision every night.
//   4. Two drafts for the same step, because the sweep ran twice.
//
//   node test-followup-schedule.js
"use strict";
const path = require("path");
const { dueFollowUps, lastSent, DAY } = require(path.join(__dirname, "followup-schedule.js"));

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    const line = "  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "");
    failures.push(line); console.log(line);
  }
};
const section = (t) => console.log("\n== " + t + " ==");

const NOW = "2026-10-20T12:00:00.000Z";
const ago = (days) => new Date(Date.parse(NOW) - days * DAY).toISOString();

const SETTINGS = { max_follow_ups: 2 };
const TEMPLATES = {
  2: { id: 22, step: 2, delay_days: 7, active: true },
  3: { id: 33, step: 3, delay_days: 14, active: true },
};
const prospect = (extra = {}) => ({
  id: 1, business_name: "Bakery", status: "CONTACTED",
  do_not_contact: false, public_email: "hi@bakery.example", ...extra,
});
const sentMsg = (step, daysAgo, extra = {}) => ({ id: step * 10, step, status: "sent", sent_at: ago(daysAgo), ...extra });

const run = (opts) => dueFollowUps({
  prospects: [prospect(opts.prospect || {})],
  messagesByProspect: { 1: opts.messages || [] },
  templatesByStep: opts.templates || TEMPLATES,
  settings: opts.settings || SETTINGS,
  suppressedEmails: opts.suppressed || [],
  now: "now" in opts ? opts.now : NOW,
});

section("A follow-up becomes due once the delay has elapsed");
let r = run({ messages: [sentMsg(1, 8)] });
check("step 2 is due after 8 days on a 7-day delay", r.due.length === 1 && r.due[0].step === 2, r);
check("it names the template to use", r.due[0].template_id === 22, r.due[0]);
check("and says what it is following up on", r.due[0].previous_step === 1, r.due[0]);
check("exactly on the boundary it is due", run({ messages: [sentMsg(1, 7)] }).due.length === 1);
r = run({ messages: [sentMsg(1, 6)] });
check("a day early it is not", r.due.length === 0, r.due);
check("and it says how much longer", /another 1 day/i.test((r.skipped[0] || {}).reason || ""), r.skipped);

section("The delay runs from the SEND, not from anything else");
// A message that sat in the queue for a week has not been waiting on the
// recipient for a week.
r = run({ messages: [{ id: 1, step: 1, status: "sent", sent_at: ago(8), created_at: ago(30), approved_at: ago(20) }] });
check("an old draft that was sent recently is measured from the send", r.due.length === 1, r);
check("lastSent picks the highest sent step",
  lastSent([sentMsg(1, 30), sentMsg(2, 8)]).step === 2);
check("and ignores anything not sent",
  lastSent([sentMsg(1, 30), { id: 9, step: 5, status: "draft" }]).step === 1);

section("The chain walks forward");
r = run({ messages: [sentMsg(1, 30), sentMsg(2, 15)] });
check("after step 2, step 3 becomes due on its own delay", r.due.length === 1 && r.due[0].step === 3, r);
check("a day early on step 3 is not due",
  run({ messages: [sentMsg(1, 30), sentMsg(2, 13)] }).due.length === 0);

section("The follow-up limit ends the sequence");
r = run({ messages: [sentMsg(1, 40), sentMsg(2, 30), sentMsg(3, 20)] });
check("step 4 is never due with a limit of 2", r.due.length === 0, r.due);
check("and it says why", /follow-up limit|No template/i.test((r.skipped[0] || {}).reason || ""), r.skipped);
check("a limit of 0 means no follow-ups at all",
  run({ messages: [sentMsg(1, 40)], settings: { max_follow_ups: 0 } }).due.length === 0);
check("an unset limit means no follow-ups either",
  run({ messages: [sentMsg(1, 40)], settings: {} }).due.length === 0);

section("Somebody who replied is left alone");
for (const st of ["RESPONDED", "INTERESTED", "NOT_INTERESTED", "COMMITTED", "DO_NOT_CONTACT"]) {
  r = run({ messages: [sentMsg(1, 30)], prospect: { status: st } });
  check(`status ${st} stops the sequence`, r.due.length === 0, r.due);
}
check("a do-not-contact flag stops it even mid-sequence",
  run({ messages: [sentMsg(1, 30)], prospect: { do_not_contact: true } }).due.length === 0);
check("and somebody on the suppression list is never followed up",
  run({ messages: [sentMsg(1, 30)], suppressed: ["HI@Bakery.example"] }).due.length === 0);
check("the suppression match ignores case",
  /do-not-contact list/i.test((run({ messages: [sentMsg(1, 30)], suppressed: ["hi@bakery.example"] }).skipped[0] || {}).reason || ""));

section("A decision somebody already made is not overridden");
// The quiet one. Re-drafting a cancelled follow-up every night undoes a
// person's choice, and nothing on screen would say it happened.
r = run({ messages: [sentMsg(1, 30), { id: 5, step: 2, status: "cancelled" }] });
check("a cancelled follow-up is not re-drafted", r.due.length === 0, r.due);
check("and it says so", /cancelled or skipped/i.test((r.skipped[0] || {}).reason || ""), r.skipped);
check("nor is a skipped one",
  run({ messages: [sentMsg(1, 30), { id: 5, step: 2, status: "skipped" }] }).due.length === 0);

section("Running the sweep twice does not double-draft");
r = run({ messages: [sentMsg(1, 30), { id: 5, step: 2, status: "draft" }] });
check("an existing draft blocks another", r.due.length === 0, r.due);
check("and so does one already approved",
  run({ messages: [sentMsg(1, 30), { id: 5, step: 2, status: "approved" }] }).due.length === 0);
check("an already-SENT step 2 moves the chain on rather than repeating it",
  run({ messages: [sentMsg(1, 40), sentMsg(2, 20)] }).due[0].step === 3);

section("An unreadable date makes nothing due, rather than everything");
// The trap that bit the enrollment packets: new Date(null) is the epoch, so a
// missing date reads as fifty years overdue.
for (const bad of [null, undefined, "", "   ", "not a date", "2026-13-45"]) {
  r = run({ messages: [{ id: 1, step: 1, status: "sent", sent_at: bad }] });
  check(`sent_at ${JSON.stringify(bad)} makes nothing due`, r.due.length === 0, r.due);
  check(`...and says the date is unusable`, /no usable send date/i.test((r.skipped[0] || {}).reason || ""), r.skipped);
}
check("an unusable clock makes nothing due",
  run({ messages: [sentMsg(1, 30)], now: "rubbish" }).due.length === 0);
check("a template with no usable delay makes nothing due",
  run({ messages: [sentMsg(1, 30)], templates: { 2: { id: 22, step: 2, delay_days: null, active: true } } }).due.length === 0);
check("a negative delay is refused rather than making it instantly due",
  run({ messages: [sentMsg(1, 0)], templates: { 2: { id: 22, step: 2, delay_days: -5, active: true } } }).due.length === 0);

section("Templates have to exist and be switched on");
check("no template for the next step means nothing is due",
  run({ messages: [sentMsg(1, 30)], templates: {} }).due.length === 0);
r = run({ messages: [sentMsg(1, 30)], templates: { 2: { id: 22, step: 2, delay_days: 7, active: false } } });
check("an inactive template is not used", r.due.length === 0, r.due);
check("and says it is switched off", /switched off/i.test((r.skipped[0] || {}).reason || ""), r.skipped);

section("Somebody never contacted is not followed up");
r = run({ messages: [] });
check("no first message means no follow-up", r.due.length === 0, r.due);
check("and it says so plainly", /no first message/i.test((r.skipped[0] || {}).reason || ""), r.skipped);
check("a draft that was never sent does not start the clock",
  run({ messages: [{ id: 1, step: 1, status: "draft", created_at: ago(30) }] }).due.length === 0);
check("nor does a failed one",
  run({ messages: [{ id: 1, step: 1, status: "failed", created_at: ago(30) }] }).due.length === 0);

section("Every prospect is accounted for, none silently dropped");
const out = dueFollowUps({
  prospects: [
    prospect({ id: 1 }), prospect({ id: 2, status: "RESPONDED" }),
    prospect({ id: 3, public_email: "" }), prospect({ id: 4 }),
  ],
  messagesByProspect: { 1: [sentMsg(1, 30)], 2: [sentMsg(1, 30)], 3: [sentMsg(1, 30)], 4: [] },
  templatesByStep: TEMPLATES, settings: SETTINGS, suppressedEmails: [], now: NOW,
});
check("one is due", out.due.length === 1 && out.due[0].prospect_id === 1, out.due);
check("the other three are skipped with reasons", out.skipped.length === 3, out.skipped);
check("and every prospect appears exactly once",
  out.due.length + out.skipped.length === 4
  && new Set([...out.due.map((d) => d.prospect_id), ...out.skipped.map((s) => s.prospect_id)]).size === 4, out);
check("no prospects at all is simply nothing to do",
  dueFollowUps({ prospects: [], messagesByProspect: {}, templatesByStep: {}, settings: SETTINGS, now: NOW }).due.length === 0);
check("missing inputs do not throw",
  dueFollowUps({ now: NOW }).due.length === 0);

section("It only ever produces drafts");
// The property the whole safety model rests on. Nothing this function returns
// may look like an instruction to send.
const shape = run({ messages: [sentMsg(1, 30)] }).due[0];
check("a due item names a prospect, a step and a template",
  shape.prospect_id && shape.step && shape.template_id, shape);
check("and carries no status, approval or send instruction",
  shape.status === undefined && shape.approved === undefined && shape.send === undefined, Object.keys(shape));
const src = require("fs").readFileSync(path.join(__dirname, "followup-schedule.js"), "utf8");
check("the module cannot send: it has no email or network call",
  !/sendEmail|fetch\(|require\("https?"\)/.test(src));

if (failures.length) console.log("\n  --- failures ---\n" + failures.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
