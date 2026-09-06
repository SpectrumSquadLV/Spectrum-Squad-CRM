// Asking a question, and changing a rule without losing the old one.
//
//   node test-policy-ask.js
//
// TWO REQUESTS, and they are the same request from two directions.
//
//   "I need to make sure there's a feature where people can put in questions
//    and it pulls up the related policy. I also need to be able to create
//    memos to modify the policies/SOPs and add it to the already existing
//    policy. For example our SOP says the turnaround time for treatment plans
//    for BCBAs is 7 days -- we are changing it to 14."
//
// The example is the whole specification. A person asks how long they have,
// and the answer has to be FOURTEEN. Not seven, which is what the approved,
// signed, uploaded SOP still says in black and white and always will.
//
// WHY THE EXISTING SEARCH COULD NOT DO IT. The library's search is a substring
// match. No document anywhere contains the string "how long do BCBAs have to
// finish a treatment plan", so typing a question returned NOTHING -- which
// reads as "we have no policy on that", the worst wrong answer available.
//
// WHY NOT JUST EDIT THE SOP TO SAY 14. Because then nothing says it used to
// say 7, who changed it, or when -- and an acknowledgment somebody signed last
// year silently becomes an acknowledgment of language they never read. So the
// memo sits ON TOP of the original: dated, attributed, in force, and the
// approved wording underneath is untouched.
//
// The things that would make this dangerous rather than useful, each of which
// is checked below:
//
//   * ANSWERING WITH THE SUPERSEDED RULE. If a question matches the original
//     paragraph, the answer must still say the policy has been amended and
//     carry the memo. A confidently quoted 7 is worse than no feature.
//   * INVENTING AN ANSWER. Every word returned is a verbatim passage. Nothing
//     is composed, summarised, or paraphrased.
//   * A DRAFT OR A FUTURE-DATED MEMO ANSWERING AS THOUGH IT WERE THE RULE.
//   * A MEMO REWRITING THE POLICY. The original body must be byte-identical
//     after amendment.
//   * LOSING A WITHDRAWN MEMO. Rescinding stops it applying; it never deletes.
//   * A SIGNATURE SURVIVING THE CHANGE IT PREDATES.
//   * ANYONE BEING ABLE TO ISSUE ONE.
"use strict";
const BASE = process.env.BASE || "http://localhost:3009";

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    const line = "  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500) : "");
    fail++; failures.push(line); console.log(line);
  }
};
const section = (t) => console.log("\n== " + t + " ==");

function makeClient() {
  let cookies = {};
  return {
    async req(path, { method = "GET", body } = {}) {
      const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(BASE + path, {
        method,
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(jar ? { Cookie: jar } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      });
      for (const sc of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [pair] = sc.split(";");
        const i = pair.indexOf("=");
        if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      return { status: res.status, data, text };
    },
  };
}
async function login(email, password) {
  const c = makeClient();
  const r = await c.req("/api/auth/login", { method: "POST", body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${r.text.slice(0, 120)}`);
  return c;
}
const anon = makeClient();
const RUN = Math.random().toString(36).slice(2, 7);
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

// The real thing, in the shape a real SOP is in: the sentence that answers the
// question is one paragraph among several, and the words of the question are
// not the words of the document.
const SOP_BODY = [
  "Purpose. This procedure sets out how the clinical team prepares, reviews and submits treatment plans following an initial or reauthorization assessment.",
  "Scope. It applies to every board certified behavior analyst carrying a caseload, including those supervising in a part-time capacity.",
  "Turnaround. Following completion of the assessment, the assigned analyst must complete and submit the written treatment plan within 7 calendar days. A plan not submitted inside that window is escalated to the clinical director.",
  "Review. The clinical director reviews each submitted plan for goal quality, baseline data and medical necessity language before it is sent to the funding source.",
  "Records. A copy of every submitted plan is filed to the client record on the day it is sent.",
].join("\n\n");

const DECOY_BODY = [
  "Purpose. This policy sets out how staff request and record paid time off.",
  "Notice. Requests for planned leave should be submitted at least 14 calendar days in advance through the CRM.",
  "Approval. Your supervisor approves or declines a request within 3 working days of receiving it.",
].join("\n\n");

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const clinical = await login("clinical@spectrumsquadlv.com", "TestStaff123!");

  // ---------------------------------------------------------------- seed --
  const mkPolicy = async (body) => {
    const r = await owner.req("/api/policies", { method: "POST", body });
    if (r.status !== 201) throw new Error("could not create policy: " + r.text.slice(0, 200));
    return r.data;
  };
  const sop = await mkPolicy({
    title: `Treatment Plan Turnaround SOP ${RUN}`,
    category: "Clinical", body: SOP_BODY, requires_acknowledgment: true,
  });
  const decoy = await mkPolicy({
    title: `Paid Time Off Requests ${RUN}`, category: "Other", body: DECOY_BODY,
  });
  const libOf = async (client, id) => {
    const r = await (client || owner).req("/api/policies/library");
    return (r.data.policies || []).find((p) => p.id === id);
  };
  check("the SOP is in the library to be asked about", !!(await libOf(owner, sop.id)), sop);
  check("and so is an unrelated policy that also talks about days",
    !!(await libOf(owner, decoy.id)), decoy);

  const ask = async (client, q) => (await (client || owner).req("/api/policies/ask?q=" + encodeURIComponent(q)));

  // ==================================================================== 1 ==
  section("A question in plain words finds the policy");
  const Q = "how long do BCBAs have to finish a treatment plan?";
  let a = await ask(owner, Q);
  check("the question is answered at all", a.status === 200, a.text.slice(0, 200));
  const top = a.data.answers[0];
  check("SOMETHING CAME BACK -- the substring search this replaces returned nothing for this",
    a.data.answers.length > 0, a.data);
  check("and the top answer is the treatment plan SOP, not the leave policy that also says 'days'",
    top && top.policy.id === sop.id, a.data.answers.map((x) => x.policy.title));
  check("THE PARAGRAPH IT QUOTES IS THE ONE THAT ANSWERS THE QUESTION",
    /within 7 calendar days/.test(top.passage.text), top.passage.text);
  check("quoted verbatim from the policy -- nothing composed, nothing paraphrased",
    SOP_BODY.includes(top.passage.text.split("\n\n")[0]), top.passage.text.slice(0, 160));
  check("it is a paragraph, not the whole document dumped back",
    top.passage.text.length < SOP_BODY.length * 0.6, { passage: top.passage.text.length, whole: SOP_BODY.length });
  check("and it says which words it matched, so it is obvious why this came back",
    Array.isArray(top.matched) && top.matched.length >= 2, top.matched);
  check("nothing is amended yet", top.amended === false, top.amended);

  section("A question about something else finds something else");
  a = await ask(owner, "how much notice do I need to give for time off?");
  check("the leave policy answers a leave question",
    a.data.answers[0] && a.data.answers[0].policy.id === decoy.id,
    a.data.answers.map((x) => x.policy.title));

  section("A question nothing covers says so, rather than guessing");
  a = await ask(owner, "what is the policy on keeping tropical fish in the clinic aquarium");
  check("NO ANSWER IS INVENTED", a.data.answers.length === 0, a.data.answers.map((x) => x.policy.title));
  check("and it reports what it searched, so 'nothing' is a fact and not a shrug",
    a.data.searched && a.data.searched.policies > 0, a.data.searched);

  a = await ask(owner, "what about the and of it");
  check("a question of nothing but common words is explained, not crashed",
    a.status === 200 && a.data.answers.length === 0 && !!a.data.note, a.data);
  check("an empty question is refused", (await ask(owner, "   ")).status === 400);

  // ==================================================================== 2 ==
  section("The memo: seven days becomes fourteen");
  const MEMO_BODY = "Effective immediately, the assigned analyst has 14 calendar days from completion of the assessment to submit the written treatment plan. This replaces the 7 calendar day turnaround stated under Turnaround above. Escalation to the clinical director is unchanged.";
  let r = await owner.req(`/api/policies/${sop.id}/amendments`, {
    method: "POST",
    body: { title: "Treatment plan turnaround extended to 14 days", body: MEMO_BODY, status: "Active" },
  });
  check("the memo is created", r.status === 201, r.text.slice(0, 300));
  const memoId = r.data.amendment.id;
  check("IT RE-ISSUES THE POLICY AS A NEW VERSION -- an amended policy is not the one people signed",
    r.data.reissued_as === "2" && r.data.previous_version === "1", r.data);
  check("and says plainly that acknowledgments will be asked for again",
    r.data.resets_acknowledgments === true, r.data);

  section("THE ORIGINAL WORDING IS UNTOUCHED");
  const after = await libOf(owner, sop.id);
  check("the approved text is byte-for-byte what it was", after.body === SOP_BODY,
    { same: after.body === SOP_BODY, len: [after.body.length, SOP_BODY.length] });
  check("it still says seven days, because that is what it said", /within 7 calendar days/.test(after.body));
  check("the policy carries the memo beside it", (after.amendments_in_force || []).length === 1, after.amendments_in_force);
  check("and is flagged as amended", after.amended === true, after.amended);

  section("Now the question answers fourteen");
  a = await ask(owner, Q);
  const t2 = a.data.answers[0];
  check("the SOP is still the policy that answers it", t2.policy.id === sop.id, a.data.answers.map((x) => x.policy.title));
  check("THE QUOTED PASSAGE IS THE MEMO, not the wording it replaced",
    t2.passage.source === "amendment" && /14 calendar days/.test(t2.passage.text), t2.passage);
  check("the answer says the policy has been amended", t2.amended === true, t2.amended);
  check("and the original paragraph is still offered underneath, so the change is visible as a change",
    t2.also && /7 calendar days/.test(t2.also.text), t2.also);

  section("Even a question that only matches the OLD wording carries the memo");
  // The trap. Somebody asks using the words of the superseded paragraph -- the
  // original scores, the memo may not -- and a naive implementation quotes 7
  // days with total confidence.
  a = await ask(owner, "escalated to the clinical director plan not submitted");
  const t3 = a.data.answers.find((x) => x.policy.id === sop.id);
  check("the SOP comes back", !!t3, a.data.answers.map((x) => x.policy.title));
  check("MARKED AMENDED EVEN THOUGH THE OLD PARAGRAPH IS WHAT MATCHED",
    t3.amended === true, t3 && { source: t3.passage.source, amended: t3.amended });
  check("with the memo attached to the answer, so nobody reads 7 days and stops",
    (t3.amendments_in_force || []).some((m) => /14 calendar days/.test(m.body)), t3.amendments_in_force);

  // ==================================================================== 3 ==
  section("A draft is not the rule");
  r = await owner.req(`/api/policies/${sop.id}/amendments`, {
    method: "POST", body: { title: "Draft: turnaround to 21 days", body: "Under discussion: 21 calendar days.", status: "Draft" },
  });
  check("a draft memo can be written", r.status === 201, r.text.slice(0, 200));
  const draftId = r.data.amendment.id;
  check("WRITING A DRAFT DOES NOT RE-ISSUE THE POLICY", !r.data.reissued_as, r.data);
  a = await ask(owner, "how many days for the treatment plan turnaround");
  check("AND IT NEVER ANSWERS A QUESTION",
    !JSON.stringify(a.data.answers).includes("21 calendar days"), a.data.answers[0] && a.data.answers[0].passage.text);
  let am = await clinical.req(`/api/policies/${sop.id}/amendments`);
  check("staff cannot see it at all", (am.data.drafts || []).length === 0, am.data.drafts);
  check("but they can see what is in force", am.data.in_force.length === 1, am.data.in_force.map((m) => m.title));

  section("A memo dated for later is real, and is not the rule yet");
  r = await owner.req(`/api/policies/${sop.id}/amendments`, {
    method: "POST",
    body: { title: "Turnaround moves to 10 days", body: "From the effective date, the window is 10 calendar days.", effective_date: iso(30), status: "Active" },
  });
  check("it is accepted", r.status === 201, r.text.slice(0, 200));
  check("and reported as not yet in force", r.data.amendment.in_force === false, r.data.amendment);
  check("WRITING IT DOES NOT RE-ISSUE THE POLICY EITHER -- nothing has changed yet",
    !r.data.reissued_as, r.data);
  a = await ask(owner, "how many days for the treatment plan turnaround");
  // The QUOTED passage, not the whole payload -- the answer deliberately
  // carries the scheduled memo as a warning, and checking the payload would
  // fail on the very thing it is supposed to have.
  const quoted = a.data.answers.map((x) => x.passage.text + " " + ((x.also && x.also.text) || "")).join(" ");
  check("IT IS NOT WHAT ANYBODY IS TOLD THE RULE IS",
    !quoted.includes("10 calendar days"), quoted.slice(0, 200));
  const t4 = a.data.answers.find((x) => x.policy.id === sop.id);
  check("but the answer warns that a change is coming",
    (t4.amendments_scheduled || []).length === 1, t4 && t4.amendments_scheduled);

  // ==================================================================== 4 ==
  section("Withdrawing a memo does not erase it");
  r = await owner.req(`/api/policies/amendments/${memoId}/rescind`, { method: "POST", body: { reason: "Reverted after clinical review" } });
  check("it can be rescinded", r.status === 200, r.text.slice(0, 200));
  check("which re-issues the policy again -- changing the rule back is as material as changing it",
    r.data.reissued_as === "3", r.data);
  am = await owner.req(`/api/policies/${sop.id}/amendments`);
  check("IT IS STILL THERE, in the record", am.data.rescinded.some((m) => m.id === memoId), am.data.rescinded);
  check("with who withdrew it and why", am.data.rescinded.some((m) => m.id === memoId && /clinical review/i.test(m.rescind_reason || "")),
    am.data.rescinded.map((m) => m.rescind_reason));
  check("and it no longer applies", am.data.in_force.length === 0, am.data.in_force);
  a = await ask(owner, Q);
  const t5 = a.data.answers[0];
  check("the question answers seven days again, from the original policy",
    t5.passage.source === "policy" && /7 calendar days/.test(t5.passage.text), t5.passage);
  check("and the policy is no longer flagged as amended", t5.amended === false, t5.amended);

  r = await owner.req(`/api/policies/amendments/${memoId}`, { method: "PATCH", body: { body: "Actually 30 days." } });
  check("A RESCINDED MEMO CANNOT BE EDITED BACK INTO SOMETHING ELSE", r.status === 400, r.data);
  r = await owner.req(`/api/policies/amendments/${memoId}`, { method: "DELETE" });
  check("and it cannot be deleted -- it is history now", r.status === 400, r.data);
  r = await owner.req(`/api/policies/amendments/${draftId}`, { method: "DELETE" });
  check("a draft that was never issued can be deleted, because it was never the rule", r.status === 200, r.data);

  // ==================================================================== 5 ==
  section("A signature does not survive the change it predates");
  const sop2 = await mkPolicy({
    title: `Supervision Ratio SOP ${RUN}`, category: "Clinical",
    body: "Each RBT receives at least 2 hours of direct supervision for every 40 hours of client contact.",
    requires_acknowledgment: true,
  });
  r = await clinical.req(`/api/policies/${sop2.id}/acknowledge`, { method: "POST", body: {} });
  check("a member of staff acknowledges version 1", r.status === 200 && r.data.version === "1", r.data);
  let mine = await libOf(clinical, sop2.id);
  check("and it shows as acknowledged", !!mine.my_acknowledgment, mine.my_acknowledgment);

  await owner.req(`/api/policies/${sop2.id}/amendments`, {
    method: "POST", body: { title: "Ratio raised to 3 hours", body: "Direct supervision rises to 3 hours per 40 hours of client contact.", status: "Active" },
  });
  mine = await libOf(clinical, sop2.id);
  check("AFTER THE MEMO THEY OWE A FRESH ONE", !mine.my_acknowledgment, mine.my_acknowledgment);
  check("against the new version", mine.version === "2", mine.version);
  const acks = await owner.req("/api/policies/acknowledgments");
  check("AND THE OLD SIGNATURE IS KEPT as the record of what they actually read",
    (acks.data.historical || []).some((h) => h.policy_id === sop2.id && h.version === "1"),
    (acks.data.historical || []).filter((h) => h.policy_id === sop2.id));

  // ==================================================================== 6 ==
  section("Who can change a rule");
  r = await clinical.req(`/api/policies/${sop.id}/amendments`, {
    method: "POST", body: { title: "Nope", body: "Clinical staff writing policy." },
  });
  check("A BCBA CANNOT ISSUE A MEMO -- refused on the route, not by hiding a button", r.status === 403, r.status);
  r = await clinical.req(`/api/policies/amendments/${memoId}/rescind`, { method: "POST", body: {} });
  check("nor withdraw one", r.status === 403, r.status);
  r = await anon.req(`/api/policies/${sop.id}/amendments`, { method: "POST", body: { title: "x", body: "y" } });
  check("and a signed-out request gets nowhere", r.status === 401, r.status);
  r = await anon.req("/api/policies/ask?q=treatment+plan+turnaround");
  check("asking a question requires signing in too", r.status === 401, r.status);

  section("A memo has to say something");
  r = await owner.req(`/api/policies/${sop.id}/amendments`, { method: "POST", body: { title: "", body: "x" } });
  check("an untitled memo is refused", r.status === 400, r.data);
  r = await owner.req(`/api/policies/${sop.id}/amendments`, { method: "POST", body: { title: "x", body: "  " } });
  check("an empty one is refused", r.status === 400, r.data);
  r = await owner.req(`/api/policies/${sop.id}/amendments`, { method: "POST", body: { title: "x", body: "y", effective_date: "next tuesday" } });
  check("and a date that is not a date is refused", r.status === 400, r.data);
  r = await owner.req(`/api/policies/99999/amendments`, { method: "POST", body: { title: "x", body: "y" } });
  check("a memo cannot be attached to a policy that does not exist", r.status === 404, r.status);

  // ==================================================================== 7 ==
  section("The QR viewer shows the current rule, not the superseded one");
  // Most people read a policy by scanning the code on the wall. Serving them
  // the original with no mention of the memo would make the printed QR the one
  // place in the practice still showing the old rule.
  const pub = await anon.req("/api/policies/public/" + encodeURIComponent(sop2.slug || ""));
  const pubSlug = (await libOf(owner, sop2.id)).slug;
  const pub2 = await anon.req("/api/policies/public/" + encodeURIComponent(pubSlug));
  check("the public page loads without signing in", pub2.status === 200, pub2.status);
  check("AND CARRIES THE MEMO", (pub2.data.amendments || []).some((m) => /3 hours/.test(m.body)), pub2.data.amendments);
  check("with the original text still there beneath it", /2 hours of direct supervision/.test(pub2.data.body || ""), (pub2.data.body || "").slice(0, 120));
  check("and no draft leaks onto a page anyone can open",
    !JSON.stringify(pub2.data).includes("21 calendar days"), pub2.data.amendments);

  section("The keyword search finds memo wording too");
  const lib = await owner.req("/api/policies/library?q=" + encodeURIComponent("3 hours per 40 hours"));
  check("a policy amended to say something can be found by searching for it",
    (lib.data.policies || []).some((p) => p.id === sop2.id), (lib.data.policies || []).map((p) => p.title));

  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
