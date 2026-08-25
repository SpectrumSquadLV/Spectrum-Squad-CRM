// The event dashboard (Phase 2).
//
// A dashboard is where numbers get quoted from, so the failures worth guarding
// are the ones that produce a confident wrong figure rather than a crash:
//
//   1. A GOAL NOBODY SET IS NOT A GOAL OF ZERO. Dividing by a goal that was
//      never entered gives 0% or Infinity, and either one drawn as a bar tells
//      somebody something untrue about their own event.
//   2. CASH AND DONATED GOODS BLENDED. Committed is a promise, paid is money in
//      hand, in-kind is an estimate of what a donated bounce house was worth.
//      A single "total raised" is the number that ends up in a sponsor deck.
//   3. A WORK QUEUE THAT LIES. "Needs attention" is only useful if the things
//      in it are real and the things missing from it genuinely do not need
//      doing.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-events-dashboard.js
"use strict";
const path = require("path");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

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

function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}
const dayOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  // ---- the pure part first: no server, no database, no clock -------------
  const events = require(path.join(__dirname, "events.js"))({
    dbGet: async () => null, dbAll: async () => [], dbRun: async () => ({ rows: [{ id: 1 }] }),
    nowISO: () => "2026-10-01T00:00:00.000Z", readBody: async () => ({}), json: () => {},
  });
  const { buildDashboard, daysUntil } = events;

  section("The countdown refuses to guess");
  check("a real date counts down", daysUntil("2026-10-31", "2026-10-01T12:00:00Z") === 30,
    daysUntil("2026-10-31", "2026-10-01T12:00:00Z"));
  check("the day itself is zero, not one", daysUntil("2026-10-01", "2026-10-01T09:00:00Z") === 0);
  check("a past date goes negative rather than clamping",
    daysUntil("2026-09-20", "2026-10-01T00:00:00Z") === -11);
  // Dates are TEXT in this CRM, so a half-typed one must not become a
  // countdown of forty thousand days.
  for (const junk of [null, undefined, "", "  ", "2026", "2026-10", "October 31", "not a date", "2026-13-45"]) {
    const got = daysUntil(junk, "2026-10-01T00:00:00Z");
    check(`${JSON.stringify(junk)} yields no countdown`, got === null, got);
  }

  section("A goal nobody set is never reported as a goal of zero");
  const empty = { event: { id: 1, name: "X", status: "DRAFT" }, prospects: [], sponsorships: [],
    donations: [], vendors: [], partners: [], levels: [], today: "2026-10-01T00:00:00Z" };
  let k = buildDashboard(empty);
  for (const key of ["sponsorship", "vendors", "registrations", "attendance"]) {
    check(`${key}: no target is reported as unset`, k.meters[key].target_set === false, k.meters[key]);
    // Null, not 0 and not 100 -- both of those draw a bar that asserts something.
    check(`${key}: percent is null, not 0 and not 100`, k.meters[key].percent === null, k.meters[key]);
    check(`${key}: no target value is invented`, k.meters[key].target === null, k.meters[key]);
  }
  check("no date means no countdown", k.days_until === null, k.days_until);
  check("an empty event has nothing needing attention", k.attention.length === 0, k.attention);

  section("A goal of zero is treated as unset, not as already met");
  k = buildDashboard({ ...empty, event: { id: 1, name: "X", status: "DRAFT", vendor_goal: 0 } });
  check("zero is not a target", k.meters.vendors.target_set === false, k.meters.vendors);
  check("and does not read as 100% achieved", k.meters.vendors.percent === null, k.meters.vendors);

  section("Real goals compute honestly");
  k = buildDashboard({
    ...empty,
    event: { id: 1, name: "X", status: "ACTIVE", event_date: "2026-10-31", sponsorship_goal: 5000, vendor_goal: 10 },
    sponsorships: [
      { id: 1, amount_committed: 3000, amount_paid: 1250, payment_status: "PARTIAL" },
      { id: 2, amount_committed: 1000, amount_paid: 1000, payment_status: "PAID" },
    ],
    vendors: [
      { id: 1, status: "CONFIRMED", electricity_needed: true },
      { id: 2, status: "CONFIRMED", table_needed: true, arrival_instructions_sent: true },
      { id: 3, status: "INVITED" },
    ],
  });
  check("paid is measured against the goal", k.meters.sponsorship.actual === 2250, k.meters.sponsorship);
  check("as a percentage", k.meters.sponsorship.percent === 45, k.meters.sponsorship);
  check("committed is its own meter, not merged into paid",
    k.meters.sponsorship_committed.actual === 4000, k.meters.sponsorship_committed);
  check("vendors count only the confirmed ones", k.meters.vendors.actual === 2, k.meters.vendors);
  check("the countdown is real", k.days_until === 30, k.days_until);
  check("over-goal is allowed to exceed 100 rather than clamping",
    buildDashboard({ ...empty, event: { id: 1, name: "X", vendor_goal: 2 },
      vendors: [{ id: 1, status: "CONFIRMED" }, { id: 2, status: "CONFIRMED" }, { id: 3, status: "CONFIRMED" }],
    }).meters.vendors.percent === 150);

  section("Cash and donated goods are never added together");
  k = buildDashboard({
    ...empty,
    sponsorships: [{ id: 1, amount_committed: 1000, amount_paid: 400, payment_status: "PARTIAL" }],
    donations: [
      { id: 1, estimated_value: 600, received: true },
      { id: 2, estimated_value: 200, received: false },
      { id: 3, estimated_value: null, received: true },
    ],
  });
  check("committed stands alone", k.money.committed === 1000, k.money);
  check("paid stands alone", k.money.paid === 400, k.money);
  check("outstanding is committed minus paid", k.money.outstanding === 600, k.money);
  check("in-kind received is separate", k.money.in_kind_estimate_received === 600, k.money);
  check("in-kind promised is separate again", k.money.in_kind_estimate_promised === 200, k.money);
  // The single most quotable wrong number this could produce.
  const moneyKeys = Object.keys(k.money);
  check("there is no blended total to misquote",
    !moneyKeys.some((key) => /total_raised|grand_total|^total$|all_in/.test(key)), moneyKeys);
  check("an unvalued donation is counted as unvalued, not as zero",
    k.money.in_kind_items_unvalued === 1, k.money);

  section("The work queue is real");
  const today = "2026-10-01T00:00:00Z";
  k = buildDashboard({
    ...empty, today,
    prospects: [
      { id: 1, status: "CONTACTED", next_follow_up: "2026-09-20" },          // overdue
      { id: 2, status: "CONTACTED", next_follow_up: "2026-12-01" },          // not yet
      { id: 3, status: "READY_FOR_OUTREACH" },                                // nobody has called
      { id: 4, status: "COMMITTED", next_follow_up: "2026-09-01" },          // done, leave alone
      { id: 5, status: "CONTACTED", next_follow_up: "2026-09-01", do_not_contact: true },
    ],
    sponsorships: [
      { id: 1, amount_committed: 500, amount_paid: 100, payment_status: "PARTIAL", banner_placement: true },
      { id: 2, amount_committed: 500, amount_paid: 500, payment_status: "PAID" },
      { id: 3, amount_committed: 900, amount_paid: 0, payment_status: "CANCELLED" },
      { id: 4, amount_committed: 300, amount_paid: 0, payment_status: "WAIVED" },
    ],
    vendors: [
      { id: 1, status: "CONFIRMED", insurance_required: true, insurance_received: false },
      { id: 2, status: "CONFIRMED", insurance_required: true, insurance_received: true, arrival_instructions_sent: true },
      { id: 3, status: "UNDER_REVIEW" },
    ],
    donations: [
      { id: 1, received: true, thank_you_sent: false, estimated_value: 50 },
      { id: 2, received: false, estimated_value: 50 },
      { id: 3, received: true, thank_you_sent: true, estimated_value: null },
    ],
    partners: [{ id: 1, status: "INVITED" }, { id: 2, status: "CONFIRMED" }],
  });
  const q = {};
  for (const a of k.attention) q[a.key] = a;
  check("an overdue follow-up is raised", q.follow_up_due && q.follow_up_due.count === 1, q.follow_up_due);
  check("a future follow-up is not", (q.follow_up_due.ids || []).indexOf(2) === -1, q.follow_up_due);
  check("somebody already committed is left alone", (q.follow_up_due.ids || []).indexOf(4) === -1, q.follow_up_due);
  // Chasing a business that asked not to be contacted is the one item here that
  // would do real harm.
  check("a do-not-contact prospect is NEVER put in the chase queue",
    (q.follow_up_due.ids || []).indexOf(5) === -1, q.follow_up_due);
  check("researched-but-not-contacted is raised", q.ready_no_contact.count === 1, q.ready_no_contact);
  check("a part-paid sponsorship is raised", q.sponsor_unpaid.count === 1, q.sponsor_unpaid);
  check("a cancelled one is not chased for money", (q.sponsor_unpaid.ids || []).indexOf(3) === -1, q.sponsor_unpaid);
  check("nor a waived one", (q.sponsor_unpaid.ids || []).indexOf(4) === -1, q.sponsor_unpaid);
  check("a sponsor on the banner with no logo is raised", q.sponsor_no_logo.count === 1, q.sponsor_no_logo);
  check("a confirmed vendor with no insurance is raised as critical",
    q.vendor_insurance.count === 1 && q.vendor_insurance.tone === "critical", q.vendor_insurance);
  check("an application waiting on us is raised", q.vendor_stalled.count === 1, q.vendor_stalled);
  check("a vendor not yet told when to arrive is raised", q.vendor_not_briefed.count === 1, q.vendor_not_briefed);
  check("a received donation with no thanks is raised", q.donation_unthanked.count === 1, q.donation_unthanked);
  check("a promised donation not yet in hand is raised", q.donation_unreceived.count === 1, q.donation_unreceived);
  check("an unvalued donation is raised", q.donation_unvalued.count === 1, q.donation_unvalued);
  check("an undecided community partner is raised", q.partner_undecided.count === 1, q.partner_undecided);
  check("every item says how many and carries the rows to open",
    k.attention.every((a) => a.count > 0 && Array.isArray(a.ids) && a.label), k.attention);
  check("and every item carries a tone that maps to a state",
    k.attention.every((a) => ["critical", "warning", "info"].includes(a.tone)), k.attention.map((a) => a.tone));

  section("The funnel counts every stage, including the empty ones");
  check("all pipeline stages are present even at zero",
    events.PIPELINE_ORDER.every((s) => k.funnel.counts[s] !== undefined), k.funnel.counts);
  check("the out-of-pipeline states are kept separate, not mixed into the funnel",
    events.OUT_OF_PIPELINE.every((s) => events.PIPELINE_ORDER.indexOf(s) === -1), events.OUT_OF_PIPELINE);
  check("the total matches the prospects given", k.funnel.total === 5, k.funnel);
  const summed = Object.values(k.funnel.counts).reduce((a, b) => a + b, 0);
  check("and the counts add up to it, so nobody is dropped", summed === 5, { summed, counts: k.funnel.counts });

  section("An unknown status is counted rather than silently dropped");
  const odd = buildDashboard({ ...empty, prospects: [{ id: 1, status: "SOMETHING_NEW" }] });
  check("it appears in the counts", odd.funnel.counts.SOMETHING_NEW === 1, odd.funnel.counts);
  check("and the total still matches", odd.funnel.total === 1, odd.funnel);

  // ---- and now over HTTP, against real rows ------------------------------
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);
  const purge = async () => { await pool.query("DELETE FROM events WHERE name LIKE 'DASH %'").catch(() => {}); };
  await purge();

  section("The endpoint works on real rows");
  const evId = (await owner("/api/events", { method: "POST", body: {
    name: "DASH Test Event", event_date: dayOffset(14), sponsorship_goal: 2000, vendor_goal: 4, status: "PLANNING",
  } })).data.id;
  const pr = (await owner(`/api/events/${evId}/prospects`, { method: "POST", body: {
    business_name: "DASH Bakery", status: "READY_FOR_OUTREACH" } })).data.id;
  await owner(`/api/events/${evId}/sponsorships`, { method: "POST", body: {
    prospect_id: pr, amount_committed: 1000, amount_paid: 250, payment_status: "PARTIAL" } });
  await owner(`/api/events/${evId}/vendors`, { method: "POST", body: {
    vendor_name: "DASH Truck", status: "CONFIRMED", insurance_required: true } });
  await owner(`/api/events/${evId}/donations`, { method: "POST", body: {
    donor_name: "DASH Store", item_or_service: "Sweets", received: true } });

  const dash = await owner(`/api/events/${evId}/dashboard`);
  check("the dashboard loads", dash.status === 200, dash.data);
  check("it counts down to the real date", dash.data.days_until === 14, dash.data.days_until);
  check("paid is measured against the real goal", dash.data.meters.sponsorship.percent === 12.5, dash.data.meters.sponsorship);
  check("the funnel sees the prospect", dash.data.funnel.counts.READY_FOR_OUTREACH === 1, dash.data.funnel.counts);
  const keys = dash.data.attention.map((a) => a.key);
  check("the uninsured vendor is raised", keys.includes("vendor_insurance"), keys);
  check("the unthanked donation is raised", keys.includes("donation_unthanked"), keys);
  check("the part-paid sponsorship is raised", keys.includes("sponsor_unpaid"), keys);
  check("an unknown event is a 404", (await owner("/api/events/99999999/dashboard")).status === 404);

  section("A role without money sees no money, and no zeros standing in for it");
  const intake = client();
  await intake("/api/auth/login", { method: "POST", body: { email: "intake@spectrumsquadlv.com", password: "TestStaff123!" } });
  const iv = await intake(`/api/events/${evId}/dashboard`);
  check("they can open the dashboard", iv.status === 200, iv.data);
  check("and are told they cannot see money", iv.data.can_see_money === false);
  // Absent, not zero: a zero would read as "nobody has sponsored anything".
  check("no sponsorship meter is shown at all", iv.data.meters.sponsorship === undefined, iv.data.meters);
  check("no committed figure", iv.data.money.committed === undefined, iv.data.money);
  check("no paid figure", iv.data.money.paid === undefined, iv.data.money);
  check("and no in-kind valuation", iv.data.money.in_kind_estimate_received === undefined, iv.data.money);
  check("the money chase item is withheld too, not shown with a blank amount",
    !iv.data.attention.map((a) => a.key).includes("sponsor_unpaid"), iv.data.attention.map((a) => a.key));
  check("but the operational queue still reaches them",
    iv.data.attention.map((a) => a.key).includes("vendor_insurance"), iv.data.attention.map((a) => a.key));
  check("and the vendor meter still works", !!iv.data.meters.vendors, iv.data.meters);
  const clinical = client();
  await clinical("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("a clinical user cannot see the dashboard at all",
    (await clinical(`/api/events/${evId}/dashboard`)).status === 403);

  await purge();
  await pool.end();
  if (failures.length) console.log("\n  --- failures ---\n" + failures.join("\n"));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
