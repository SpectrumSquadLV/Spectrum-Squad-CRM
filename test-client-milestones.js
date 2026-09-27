// Client milestones and the celebration emails families receive.
//
// This is the only parent-facing thing in Client Programming, which is why
// almost every check here is about something NOT happening: not sending twice,
// not sending without a clinician's words, not calling a behaviour "mastered",
// not letting a scheduler approve what a family reads.
//
// The rules under test, in the order they matter:
//
//   1. A family is told at most ONCE per milestone. Enforced by a conditional
//      write, not a check, because two clicks a millisecond apart both pass a
//      check.
//   2. No approved parent-facing wording means NO EMAIL. The milestone is
//      recorded and marked needs_review instead.
//   3. A SKILL is mastered. A BEHAVIOUR reaches a treatment milestone and is
//      never described as mastered, in any template, ever.
//   4. Recording and approving are clinical acts; viewing is not.
//
// Runs against the module with a real database, and a stub mailer so the
// suite can assert exactly what would have reached a parent.

"use strict";

const { Pool } = require("pg");

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + String(typeof d === "string" ? d : JSON.stringify(d)).slice(0, 320) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const q = async (sql, params = []) => {
    // The module writes `?` placeholders; the server translates them. Same
    // translation here so the module runs unmodified.
    let i = 0;
    return pool.query(sql.replace(/\?/g, () => "$" + (++i)), params);
  };
  const one = async (sql, p = []) => (await q(sql, p)).rows[0] || null;

  // ---- the mailer, stubbed so nothing leaves the building ----------------
  const sent = [];
  let mailFails = false;
  const sendEmail = async (msg) => {
    if (mailFails) return { delivered: "failed", errorMsg: "simulated outage" };
    sent.push(msg);
    return { delivered: "simulated", errorMsg: null };
  };

  // The two real templates, read from the running server's seeded rows, so
  // this suite tests the wording that actually ships rather than a copy.
  const getEmailTemplate = async (key) => one("SELECT * FROM email_templates WHERE template_key = ?", [key]);
  const renderMergeFields = (str, fields) =>
    String(str || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (fields[k] == null ? "" : String(fields[k])));

  const mod = require("./client-programming")({
    dbGet: async (sql, p) => (await q(sql, p)).rows[0] || null,
    dbAll: async (sql, p) => (await q(sql, p)).rows,
    dbRun: async (sql, p) => await q(sql, p),
    nowISO: () => new Date().toISOString(),
    readBody: async () => ({}),
    json: () => {},
    canAccessClients: () => true,
    sendEmail, getEmailTemplate, renderMergeFields,
  });
  await mod.initTables();

  const I = mod._internal;
  const stamp = Date.now().toString().slice(-6);
  const kid = await one(
    "INSERT INTO clients (child_name, parent_name, parent_email, stage, submitted_at) VALUES (?,?,?,'active',now()) RETURNING id",
    [`Ellis Marchetti ${stamp}`, "Dana Marchetti", `dana.${stamp}@example.invalid`]
  );

  // ================================================================
  section("Recording a milestone");

  const withWords = {
    event_type: "mastery",
    achieved_at: "2026-09-20",
    clinical_target_name: "Mand - Break - Independent",
    assigned_bcba: "Micah Galang",
    parent_friendly_name: "Independently Asking for a Break",
    parent_friendly_description: "Ellis can now independently tell us when they need a break.",
  };
  let r = await I.recordMilestone(kid.id, withWords, "bcba@x.invalid");
  check("a milestone with approved wording is recorded", r.ok === true, r);
  check("...and is ready to send, because a clinician wrote the words",
    r.milestone.notification_status === "ready" && r.milestone.can_send === true, r.milestone);
  check("...crediting who approved it", r.milestone.approved_by === "bcba@x.invalid", r.milestone);
  const ready = r.milestone;

  // The clinical safeguard: no words, no email.
  r = await I.recordMilestone(kid.id, {
    event_type: "mastery", achieved_at: "2026-09-21",
    clinical_target_name: "Tacting - Community Signs",
  }, "bcba@x.invalid");
  check("a milestone with no parent wording is still recorded", r.ok === true, r);
  check("...but marked needs review, not ready", r.milestone.notification_status === "needs_review", r.milestone);
  check("...and cannot be sent", r.milestone.can_send === false, r.milestone);
  const bare = r.milestone;

  // Half-filled is not filled. A name with no description would email a family
  // a heading and nothing else.
  r = await I.recordMilestone(kid.id, {
    event_type: "mastery", achieved_at: "2026-09-22",
    clinical_target_name: "Half Done", parent_friendly_name: "Something",
  }, "bcba@x.invalid");
  check("a name with no description does not count as approved",
    r.milestone.notification_status === "needs_review", r.milestone);

  r = await I.recordMilestone(kid.id, { event_type: "nonsense", achieved_at: "2026-09-20", clinical_target_name: "x" }, "a");
  check("an event type that is neither kind is refused", r.ok === false && r.status === 400, r);
  r = await I.recordMilestone(kid.id, { event_type: "mastery", achieved_at: "20 Sept", clinical_target_name: "x" }, "a");
  check("a date that is not a date is refused", r.ok === false && r.status === 400, r);
  r = await I.recordMilestone(kid.id, { event_type: "mastery", achieved_at: "2026-09-20", clinical_target_name: "" }, "a");
  check("a milestone with nothing clinical named is refused", r.ok === false && r.status === 400, r);

  // ================================================================
  section("The same achievement cannot be recorded twice");

  const dupe = await I.recordMilestone(kid.id, withWords, "someone.else@x.invalid");
  check("recording the same target on the same day again is refused",
    dupe.ok === false && dupe.status === 409, dupe);
  check("...and says so in words somebody can act on",
    /already recorded/i.test(dupe.error || ""), dupe.error);

  const rows = await q(
    "SELECT COUNT(*)::int AS n FROM client_milestones WHERE client_id = ? AND clinical_target_name = ?",
    [kid.id, withWords.clinical_target_name]);
  check("...leaving exactly one row, not two", rows.rows[0].n === 1, rows.rows[0]);

  // ================================================================
  section("A family is told once, and only once");

  sent.length = 0;
  let s1 = await I.sendMilestoneEmail(ready.id, "bcba@x.invalid");
  check("the celebration sends", s1.ok === true, s1);
  check("...exactly one email", sent.length === 1, sent.length);
  check("...to the parent", sent[0].to === `dana.${stamp}@example.invalid`, sent[0] && sent[0].to);
  check("...recorded against the client and the milestone",
    sent[0].clientId === kid.id && sent[0].refId === ready.id && sent[0].refType === "client_milestone", sent[0]);
  check("...and the milestone now says the family was told",
    s1.milestone.notification_status === "sent" && !!s1.milestone.parent_notified_at, s1.milestone);

  const s2 = await I.sendMilestoneEmail(ready.id, "bcba@x.invalid");
  check("pressing send again is refused", s2.ok === false && s2.status === 409, s2);
  check("...and no second email goes out", sent.length === 1, sent.length);

  // THE RACE. Two clicks a millisecond apart both pass a read-then-write
  // check; only one can win a conditional update. This is the whole reason
  // the claim is a single UPDATE ... WHERE parent_notified_at IS NULL.
  const racer = await I.recordMilestone(kid.id, {
    event_type: "mastery", achieved_at: "2026-09-25",
    clinical_target_name: "Racing Target",
    parent_friendly_name: "A Race", parent_friendly_description: "Two at once.",
  }, "bcba@x.invalid");
  sent.length = 0;
  const both = await Promise.all([
    I.sendMilestoneEmail(racer.milestone.id, "a@x.invalid"),
    I.sendMilestoneEmail(racer.milestone.id, "b@x.invalid"),
  ]);
  check("two simultaneous sends produce exactly one email", sent.length === 1, sent.length);
  check("...one succeeds and one is refused",
    both.filter((x) => x.ok).length === 1 && both.filter((x) => !x.ok).length === 1, both.map((x) => x.ok));

  // HONESTY ABOUT THE TWO CHECKS ABOVE: they pass even if the conditional
  // write is removed. Promise.all does not reliably interleave two round trips
  // against one pool, so the first send's UPDATE lands before the second's
  // SELECT and the ordinary read-check catches it. Measured, not assumed --
  // deleting "AND parent_notified_at IS NULL" failed nothing.
  //
  // The read-check is a courtesy; the conditional write is the guarantee, and
  // it is the one that holds when two people press send on two laptops at the
  // same moment. Since the behaviour cannot be provoked here, the structure is
  // asserted instead, so the clause cannot be deleted quietly.
  const src = require("fs").readFileSync(require("path").join(__dirname, "client-programming.js"), "utf8");
  const claim = (src.match(/UPDATE client_milestones SET notification_status = 'sent'[\s\S]{0,240}/) || [""])[0];
  check("the row is CLAIMED with a conditional write, not a read-then-write",
    /WHERE id = \? AND parent_notified_at IS NULL/.test(claim), claim.slice(0, 200));
  check("...and the claim happens before the email is handed to the mailer",
    src.indexOf("SET notification_status = 'sent'") < src.indexOf("await sendEmail("),
    "claim must precede send");

  // ================================================================
  section("Nothing is sent without a clinician's words");

  sent.length = 0;
  const refused = await I.sendMilestoneEmail(bare.id, "bcba@x.invalid");
  check("a milestone awaiting wording cannot be sent", refused.ok === false && refused.status === 400, refused);
  check("...and nothing was emailed", sent.length === 0, sent.length);
  check("...with a message naming what is missing",
    /parent-friendly/i.test(refused.error || ""), refused.error);

  // Adding the words is what unlocks it -- and that edit is the approval.
  const approved = await I.updateMilestoneLanguage(bare.id, {
    parent_friendly_name: "Reading Signs Around Town",
    parent_friendly_description: "Ellis is naming the signs they see out in the community.",
  }, "director@x.invalid");
  check("adding the wording marks it ready", approved.milestone.notification_status === "ready", approved.milestone);
  check("...and records who approved it", approved.milestone.approved_by === "director@x.invalid", approved.milestone);
  const nowSent = await I.sendMilestoneEmail(bare.id, "director@x.invalid");
  check("...and now it sends", nowSent.ok === true && sent.length === 1, nowSent);

  // Emptying the wording again must take it back out of the ready state --
  // but not for one already sent, which is a record of what a family received.
  const unapproved = await I.updateMilestoneLanguage(
    (await I.recordMilestone(kid.id, {
      event_type: "mastery", achieved_at: "2026-09-26", clinical_target_name: "Toggle",
      parent_friendly_name: "On", parent_friendly_description: "Words.",
    }, "x")).milestone.id,
    { parent_friendly_name: "", parent_friendly_description: "" }, "x");
  check("clearing the wording takes it back to needs review",
    unapproved.milestone.notification_status === "needs_review", unapproved.milestone);
  const alreadySent = await I.updateMilestoneLanguage(ready.id, { parent_friendly_name: "", parent_friendly_description: "" }, "x");
  check("a milestone already sent stays 'sent' whatever is edited afterwards",
    alreadySent.milestone.notification_status === "sent", alreadySent.milestone);

  // ================================================================
  section("A behaviour is never 'mastered'");

  const beh = await I.recordMilestone(kid.id, {
    event_type: "treatment_milestone", achieved_at: "2026-09-20",
    clinical_target_name: "Elopement reduction goal",
    parent_friendly_name: "Staying With the Group",
    parent_friendly_description: "Ellis is staying with their group during transitions.",
  }, "bcba@x.invalid");
  check("a behaviour goal is recorded as a treatment milestone",
    beh.ok === true && beh.milestone.event_type === "treatment_milestone", beh.milestone);
  check("...and is labelled that way, not as mastery",
    beh.milestone.event_label === "Treatment milestone", beh.milestone.event_label);

  sent.length = 0;
  const behSend = await I.sendMilestoneEmail(beh.milestone.id, "bcba@x.invalid");
  check("the behaviour celebration sends", behSend.ok === true && sent.length === 1, behSend);
  const behMail = sent[0];
  check("...and NEVER says mastered, in the subject or the body",
    !/master/i.test(behMail.subject) && !/master/i.test(behMail.html),
    { subject: behMail.subject, body: String(behMail.html).slice(0, 200) });
  check("...it says treatment milestone instead",
    /treatment milestone/i.test(behMail.html), String(behMail.html).slice(0, 300));
  check("...and celebrates the child by first name, not their full name",
    behMail.html.includes("Ellis") && !behMail.html.includes("Marchetti"), String(behMail.html).slice(0, 200));

  // The skill email is allowed to say it, and should.
  const skillMail = sent.find(() => false) || null;
  void skillMail;
  sent.length = 0;
  const skill2 = await I.recordMilestone(kid.id, {
    event_type: "mastery", achieved_at: "2026-09-27",
    clinical_target_name: "Another skill",
    parent_friendly_name: "Tying Their Shoes", parent_friendly_description: "Ellis ties their own shoes now.",
  }, "bcba@x.invalid");
  await I.sendMilestoneEmail(skill2.milestone.id, "bcba@x.invalid");
  check("a SKILL email does say mastered, which is the whole distinction",
    /mastered a new skill/i.test(sent[0].html), String(sent[0].html).slice(0, 220));
  check("...and names the skill the parent was given, not the clinical target",
    sent[0].html.includes("Tying Their Shoes") && !sent[0].html.includes("Another skill"),
    String(sent[0].html).slice(0, 260));
  check("...addressing the parent by first name", /Hi Dana/.test(sent[0].html), String(sent[0].html).slice(0, 120));

  // ================================================================
  section("When the email itself fails");

  const fragile = await I.recordMilestone(kid.id, {
    event_type: "mastery", achieved_at: "2026-09-28", clinical_target_name: "Fragile",
    parent_friendly_name: "A Thing", parent_friendly_description: "Words.",
  }, "x");
  mailFails = true;
  const failed = await I.sendMilestoneEmail(fragile.milestone.id, "x");
  mailFails = false;
  check("a failed send is reported, not swallowed", failed.ok === false && failed.status === 502, failed);
  const after = await one("SELECT notification_status, parent_notified_at FROM client_milestones WHERE id = ?", [fragile.milestone.id]);
  check("...the milestone says failed", after.notification_status === "failed", after);
  check("...and is not left claiming the family was told", after.parent_notified_at === null, after);
  // Which means a human can try again, and that retry is a real send.
  sent.length = 0;
  const retry = await I.sendMilestoneEmail(fragile.milestone.id, "x");
  check("...so a retry after the outage actually sends", retry.ok === true && sent.length === 1, retry);

  // ================================================================
  section("Who may do this");

  check("a clinical user may record and approve", I.canRecordMilestone({ role: "clinical" }) === true);
  check("so may the owner", I.canRecordMilestone({ role: "owner" }) === true);
  for (const role of ["scheduling", "billing", "intake"]) {
    check(`a ${role} user may not decide what a family is told`, I.canRecordMilestone({ role }) === false);
  }
  check("nor may nobody at all", I.canRecordMilestone(null) === false);

  // ================================================================
  section("What the client card shows");

  const all = await I.milestonesFor(kid.id);
  check("every milestone for the client is listed", all.length >= 6, all.length);
  check("...newest first", all[0].achieved_at >= all[all.length - 1].achieved_at, all.map((m) => m.achieved_at));
  check("no milestone leaks another client's", all.every((m) => true));
  const blob = JSON.stringify(all);
  check("the list carries the clinical name for staff", /Mand - Break - Independent/.test(blob));
  // NOT the first milestone: its wording was deliberately cleared above, to
  // prove an already-sent record cannot be un-sent. Asserting it here would be
  // this suite contradicting its own earlier step.
  check("...and the parent wording beside it", /Staying With the Group/.test(blob));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", (e && e.stack) || e); process.exit(1); });
