// May this outreach message actually be sent?
//
// This is the first thing in the event system that emails anybody, and the
// recipients are local businesses who never asked to hear from us. So the
// suite is almost entirely about refusing to send.
//
// The failures worth guarding, worst first:
//
//   1. EMAILING SOMEBODY WHO ASKED US NOT TO. Legally and reputationally the
//      worst thing here. Two independent things must stop it -- the prospect
//      flag and the global suppression list -- and neither may be lifted by a
//      status change.
//   2. SENDING AFTER SOMEBODY REPLIED. Scheduled follow-ups arriving at a
//      person who is already talking to you reads as a machine that is not
//      listening.
//   3. SENDING TWICE. Re-running a batch, or two people pressing send, must
//      never double-message a business.
//   4. SENDING WITHOUT A PERSON APPROVING IT. Nothing reaches a real inbox
//      because a scheduler decided it was time.
//
//   node test-outreach-guard.js
"use strict";
const path = require("path");
const G = require(path.join(__dirname, "outreach-guard.js"));

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

const OK_SETTINGS = {
  enabled: true, postal_address: "123 Main St, Las Vegas NV 89101",
  daily_limit: 50, batch_size: 10, send_hour_start: 9, send_hour_end: 17, max_follow_ups: 2,
};
const prospect = (extra = {}) => ({ id: 1, status: "CONTACTED", do_not_contact: false, ...extra });
const message = (extra = {}) => ({ id: 1, prospect_id: 1, step: 1, to_email: "hi@shop.example", status: "approved", ...extra });

section("Nothing sends until it is configured to");
check("a complete configuration has no problems", G.configProblems(OK_SETTINGS).length === 0, G.configProblems(OK_SETTINGS));
check("switched off is a problem", /switched off/i.test(G.configProblems({ ...OK_SETTINGS, enabled: false }).join(" ")));
// CAN-SPAM: commercial email must carry a real mailing address, and it cannot
// be invented, so nothing sends until somebody enters one.
check("no postal address blocks everything",
  /postal address/i.test(G.configProblems({ ...OK_SETTINGS, postal_address: "" }).join(" ")));
check("a blank-ish postal address does not count",
  /postal address/i.test(G.configProblems({ ...OK_SETTINGS, postal_address: "   " }).join(" ")));
check("no daily limit blocks everything",
  /daily send limit/i.test(G.configProblems({ ...OK_SETTINGS, daily_limit: 0 }).join(" ")));
check("no batch size blocks everything",
  /batch size/i.test(G.configProblems({ ...OK_SETTINGS, batch_size: null }).join(" ")));
check("every problem is reported at once, not one at a time",
  G.configProblems({}).length >= 4, G.configProblems({}));

section("Sending hours");
check("inside the window sends", G.withinSendingHours(10, OK_SETTINGS) === true);
check("the start hour is inclusive", G.withinSendingHours(9, OK_SETTINGS) === true);
check("the end hour is exclusive", G.withinSendingHours(17, OK_SETTINGS) === false);
check("before the window does not", G.withinSendingHours(8, OK_SETTINGS) === false);
check("the middle of the night does not", G.withinSendingHours(3, OK_SETTINGS) === false);
// An unset window must send NOTHING. Defaulting to all-day is the one direction
// that cannot be taken back.
for (const bad of [{}, { send_hour_start: null, send_hour_end: null }, { send_hour_start: 17, send_hour_end: 9 },
                   { send_hour_start: -1, send_hour_end: 25 }, { send_hour_start: 9, send_hour_end: 9 }]) {
  check(`an unusable window sends nothing: ${JSON.stringify(bad)}`, G.withinSendingHours(10, bad) === false);
}
for (const h of [null, undefined, "ten", -1, 24, 1.5]) {
  check(`${JSON.stringify(h)} is not an hour`, G.withinSendingHours(h, OK_SETTINGS) === false);
}

section("Somebody who asked not to be contacted is never emailed");
check("the prospect flag blocks it",
  /do not contact/i.test(G.blockedReason({
    message: message(), prospect: prospect({ do_not_contact: true }),
    suppressedEmails: [], alreadySentSteps: [],
  }) || ""));
// The second, independent guard: the global list. One of these failing must
// not be enough to reach somebody.
check("the suppression list blocks it even when the flag is clear",
  /do-not-contact list/i.test(G.blockedReason({
    message: message(), prospect: prospect(),
    suppressedEmails: ["HI@Shop.example"], alreadySentSteps: [],
  }) || ""));
check("the list match ignores case and padding",
  G.blockedReason({
    message: message({ to_email: "  Hi@SHOP.example " }), prospect: prospect(),
    suppressedEmails: ["hi@shop.example"], alreadySentSteps: [],
  }) !== null);
check("a Set works as well as a list",
  G.blockedReason({
    message: message(), prospect: prospect(),
    suppressedEmails: new Set(["hi@shop.example"]), alreadySentSteps: [],
  }) !== null);

section("A reply stops the sequence");
for (const st of G.STOPPED_STATUSES) {
  check(`status ${st} stops it`,
    /stops at status|do not contact/i.test(G.blockedReason({
      message: message(), prospect: prospect({ status: st }), suppressedEmails: [], alreadySentSteps: [],
    }) || ""), st);
}
for (const st of ["NEW_PROSPECT", "RESEARCHED", "READY_FOR_OUTREACH", "CONTACTED", "FOLLOW_UP_NEEDED"]) {
  check(`status ${st} still allows outreach`,
    G.blockedReason({ message: message(), prospect: prospect({ status: st }), suppressedEmails: [], alreadySentSteps: [] }) === null, st);
}

section("Nobody is messaged twice for the same step");
check("an already-sent step is blocked",
  /already been sent/i.test(G.blockedReason({
    message: message({ step: 2 }), prospect: prospect(), suppressedEmails: [], alreadySentSteps: [1, 2],
  }) || ""));
check("a different step is fine",
  G.blockedReason({ message: message({ step: 3 }), prospect: prospect(), suppressedEmails: [], alreadySentSteps: [1, 2] }) === null);
check("step numbers compare as values, not as types",
  G.blockedReason({ message: message({ step: 2 }), prospect: prospect(), suppressedEmails: [], alreadySentSteps: ["2"] }) !== null);

section("Nothing sends without a person approving it");
for (const st of ["queued", "draft", "cancelled", "failed", ""]) {
  check(`status ${JSON.stringify(st)} is not approved`,
    /not approved/i.test(G.blockedReason({
      message: message({ status: st }), prospect: prospect(), suppressedEmails: [], alreadySentSteps: [],
    }) || ""), st);
}
check("an already-sent message says so rather than sending again",
  /already sent/i.test(G.blockedReason({
    message: message({ status: "sent" }), prospect: prospect(), suppressedEmails: [], alreadySentSteps: [],
  }) || ""));

section("Missing pieces block rather than throw");
check("no message", G.blockedReason({ message: null, prospect: prospect() }) !== null);
check("a deleted prospect", G.blockedReason({ message: message(), prospect: null }) !== null);
for (const bad of ["", "   ", "not-an-email", null, "a@b"]) {
  check(`${JSON.stringify(bad)} is not a usable address`,
    /no usable email/i.test(G.blockedReason({
      message: message({ to_email: bad }), prospect: prospect(), suppressedEmails: [], alreadySentSteps: [],
    }) || ""), bad);
}

section("The follow-up limit is real");
check("the first message is always allowed",
  G.canQueueStep({ step: 1, settings: OK_SETTINGS, prospect: prospect(), alreadySentSteps: [] }) === null);
check("follow-up 1 is within a limit of 2",
  G.canQueueStep({ step: 2, settings: OK_SETTINGS, prospect: prospect(), alreadySentSteps: [1] }) === null);
check("follow-up 2 is within a limit of 2",
  G.canQueueStep({ step: 3, settings: OK_SETTINGS, prospect: prospect(), alreadySentSteps: [1, 2] }) === null);
check("follow-up 3 is not",
  /follow-up limit/i.test(G.canQueueStep({ step: 4, settings: OK_SETTINGS, prospect: prospect(), alreadySentSteps: [1, 2, 3] }) || ""));
check("a limit of zero allows the first message and no follow-up",
  G.canQueueStep({ step: 1, settings: { ...OK_SETTINGS, max_follow_ups: 0 }, prospect: prospect(), alreadySentSteps: [] }) === null
  && G.canQueueStep({ step: 2, settings: { ...OK_SETTINGS, max_follow_ups: 0 }, prospect: prospect(), alreadySentSteps: [1] }) !== null);
check("an unset limit queues no follow-ups at all",
  G.canQueueStep({ step: 2, settings: { ...OK_SETTINGS, max_follow_ups: null }, prospect: prospect(), alreadySentSteps: [1] }) !== null);
check("a do-not-contact prospect is never queued",
  G.canQueueStep({ step: 1, settings: OK_SETTINGS, prospect: prospect({ do_not_contact: true }), alreadySentSteps: [] }) !== null);
check("nor one who already replied",
  G.canQueueStep({ step: 2, settings: OK_SETTINGS, prospect: prospect({ status: "RESPONDED" }), alreadySentSteps: [1] }) !== null);
for (const s of [0, -1, null, "two", 1.5]) {
  check(`step ${JSON.stringify(s)} is refused`, G.canQueueStep({ step: s, settings: OK_SETTINGS, prospect: prospect(), alreadySentSteps: [] }) !== null);
}

section("A pass respects the daily limit and the batch size");
const many = (n) => Array.from({ length: n }, (_, i) => message({ id: i + 1, prospect_id: i + 1 }));
const byId = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, prospect({ id: i + 1 })]));
let r = G.sendableNow({
  messages: many(25), prospectsById: byId(25), suppressedEmails: [], sentStepsByProspect: {},
  settings: OK_SETTINGS, sentToday: 0, hour: 10,
});
check("the batch caps this pass at 10", r.send.length === 10, r.send.length);
check("the rest are held, not dropped", r.hold.length === 15, r.hold.length);
check("and each held one says why", r.hold.every((h) => !!h.reason), r.hold.slice(0, 2));
check("the batch-full reason is distinguishable from a refusal",
  r.hold.some((h) => /next pass/i.test(h.reason)), r.hold[0]);

r = G.sendableNow({
  messages: many(25), prospectsById: byId(25), suppressedEmails: [], sentStepsByProspect: {},
  settings: { ...OK_SETTINGS, batch_size: 100 }, sentToday: 47, hour: 10,
});
check("the daily limit stops it at 3 when 47 already went", r.send.length === 3, r.send.length);
check("and says the limit was reached", r.hold.some((h) => /daily send limit/i.test(h.reason)), r.hold[0]);
check("nothing goes when the day is used up",
  G.sendableNow({ messages: many(5), prospectsById: byId(5), suppressedEmails: [], sentStepsByProspect: {},
    settings: OK_SETTINGS, sentToday: 50, hour: 10 }).send.length === 0);
check("a count above the limit does not go negative and let sends through",
  G.sendableNow({ messages: many(5), prospectsById: byId(5), suppressedEmails: [], sentStepsByProspect: {},
    settings: OK_SETTINGS, sentToday: 9999, hour: 10 }).send.length === 0);

section("A whole pass stops when the configuration is wrong");
for (const [label, s, hour] of [
  ["switched off", { ...OK_SETTINGS, enabled: false }, 10],
  ["no postal address", { ...OK_SETTINGS, postal_address: "" }, 10],
  ["outside sending hours", OK_SETTINGS, 3],
]) {
  const out = G.sendableNow({ messages: many(5), prospectsById: byId(5), suppressedEmails: [],
    sentStepsByProspect: {}, settings: s, sentToday: 0, hour });
  check(`${label}: nothing sends`, out.send.length === 0, out.send.length);
  check(`${label}: every message is accounted for`, out.hold.length === 5, out.hold.length);
  check(`${label}: and the reason is reported`, out.problems.length > 0, out.problems);
}

section("A refusal inside a pass does not consume the daily allowance");
// A blocked message must not eat a slot -- otherwise one suppressed address
// silently costs a real business its email that day.
r = G.sendableNow({
  messages: [message({ id: 1, prospect_id: 1 }), message({ id: 2, prospect_id: 2 }), message({ id: 3, prospect_id: 3 })],
  prospectsById: { 1: prospect({ id: 1, do_not_contact: true }), 2: prospect({ id: 2 }), 3: prospect({ id: 3 }) },
  suppressedEmails: [], sentStepsByProspect: {},
  settings: { ...OK_SETTINGS, daily_limit: 2, batch_size: 10 }, sentToday: 0, hour: 10,
});
check("the blocked one is held", r.hold.length === 1 && /do not contact/i.test(r.hold[0].reason), r.hold);
check("and both real ones still go", r.send.length === 2, r.send.length);

section("Every email carries an opt-out and a postal address");
const footer = G.complianceFooter({
  unsubscribeUrl: "https://crm.example/outreach/unsubscribe?token=abc",
  postalAddress: "123 Main St, Las Vegas NV 89101", orgName: "Spectrum Squad",
});
check("the footer exists", !!footer);
check("it carries the unsubscribe link", /outreach\/unsubscribe\?token=abc/.test(footer), footer);
check("it carries the postal address", /123 Main St/.test(footer), footer);
check("it says why they received it", /inviting local businesses/i.test(footer));
// If either piece is missing the footer refuses to build, and the sender
// refuses to send -- rather than quietly emailing without an opt-out.
check("no address means no footer", G.complianceFooter({ unsubscribeUrl: "https://x/u", postalAddress: "" }) === null);
check("no unsubscribe link means no footer", G.complianceFooter({ unsubscribeUrl: "", postalAddress: "123 Main St" }) === null);
check("a hostile org name cannot inject markup",
  !/<script>/.test(G.complianceFooter({ unsubscribeUrl: "https://x/u", postalAddress: "a", orgName: "<script>x</script>" })));

if (failures.length) console.log("\n  --- failures ---\n" + failures.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
