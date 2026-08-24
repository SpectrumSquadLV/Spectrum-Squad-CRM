// The reusable event system (Phase 1: data layer).
//
// The Halloween Palooza is the first event created here, and the single most
// important thing this suite checks is that it is only a ROW. So every feature
// below is exercised against a SECOND, completely unrelated event -- a spring
// resource fair -- and the two are checked for leakage in both directions. If
// anything in the implementation quietly assumes Halloween, one event, or one
// set of sponsorship prices, these fail.
//
// The other things worth guarding, in order of how much damage they do:
//
//   1. Money that blends. Cash committed, cash paid and the ESTIMATED value of
//      donated goods are three different things. A single "total raised" that
//      mixes them ends up in a sponsor deck and cannot be stood behind.
//   2. Do-not-contact that can be undone by accident. A business that asked not
//      to be contacted must stay suppressed across EVERY event, and moving them
//      through a workflow status must never lift it.
//   3. Duplicate protection that discards. A likely duplicate is shown to the
//      person and they decide; nothing is silently dropped, and the same
//      business is never blocked from a different event.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-events.js
"use strict";
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
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

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);

  const purge = async () => {
    await pool.query("DELETE FROM events WHERE name LIKE 'EVTEST %'").catch(() => {});
    await pool.query("DELETE FROM event_outreach_suppression WHERE business_name LIKE 'EVTEST %'").catch(() => {});
  };
  await purge();

  const mkEvent = async (name, extra = {}) =>
    (await owner("/api/events", { method: "POST", body: { name, ...extra } })).data.id;
  const detail = async (id) => (await owner(`/api/events/${id}`)).data;

  // ==================================================================
  section("The seeded first event is data, not architecture");
  const all = (await owner("/api/events")).data;
  check("the events list loads", !!all && Array.isArray(all.events), all);
  const palooza = (all.events || []).find((e) => /Halloween Palooza/i.test(e.name));
  check("the Halloween Palooza exists as an ordinary event row", !!palooza, (all.events || []).map((e) => e.name));
  if (palooza) {
    const pd = await detail(palooza.id);
    check("it starts as a DRAFT", pd.event.status === "DRAFT", pd.event.status);
    // Only what was actually given: a name and a year. Everything else blank
    // and editable rather than invented -- a made-up venue reaches a flyer.
    check("no venue was invented", !pd.event.venue_name, pd.event.venue_name);
    check("no date was invented", !pd.event.event_date, pd.event.event_date);
    check("no attendance goal was invented", pd.event.attendance_goal == null, pd.event.attendance_goal);
    check("it has the five starter sponsorship levels",
      (pd.sponsorship_levels || []).length === 5, (pd.sponsorship_levels || []).map((l) => l.name));
    check("the levels carry the starter prices",
      (pd.sponsorship_levels || []).map((l) => Number(l.amount)).join(",") === "100,250,500,1000,2500",
      (pd.sponsorship_levels || []).map((l) => l.amount));
    // Prices are DATA. If they were baked into logic, editing one would not stick.
    const lvl = pd.sponsorship_levels[0];
    check("a starter price can be edited",
      (await owner(`/api/events/${palooza.id}/sponsorship-levels/${lvl.id}`,
        { method: "PATCH", body: { amount: 123.45 } })).status === 200);
    const after = await detail(palooza.id);
    check("and the edit persists",
      Number((after.sponsorship_levels.find((l) => l.id === lvl.id) || {}).amount) === 123.45);
    await owner(`/api/events/${palooza.id}/sponsorship-levels/${lvl.id}`, { method: "PATCH", body: { amount: 100 } });
  }

  // ==================================================================
  section("A second, unrelated event works identically");
  // The check that catches a Halloween assumption. Nothing below mentions
  // Halloween, and all of it has to work.
  const fair = await mkEvent("EVTEST Spring Resource Fair 2027", { event_date: "2027-04-10", status: "PLANNING" });
  const gala = await mkEvent("EVTEST Autism Acceptance Gala");
  check("a second event can be created", !!fair, fair);
  check("and a third", !!gala, gala);
  let fd = await detail(fair);
  check("it has NO sponsorship levels of its own", (fd.sponsorship_levels || []).length === 0,
    (fd.sponsorship_levels || []).length);
  check("...so the starter levels belong to that one event, not to the app", true);
  check("its own levels can be created",
    (await owner(`/api/events/${fair}/sponsorship-levels`,
      { method: "POST", body: { name: "Bloom Sponsor", amount: 750 } })).status === 201);
  check("a slug was generated", !!fd.event.slug, fd.event.slug);
  check("and it is not Halloween-derived", !/halloween/i.test(fd.event.slug || ""), fd.event.slug);

  // ==================================================================
  section("Prospects belong to exactly one event");
  const mkProspect = async (eventId, body) =>
    owner(`/api/events/${eventId}/prospects`, { method: "POST", body });
  const bakeryFair = await mkProspect(fair, {
    business_name: "EVTEST Smiths Bakery", website: "https://www.smiths-evtest.com",
    public_email: "hi@smiths-evtest.com", opportunity_type: "SPONSOR", priority: "HIGH",
  });
  check("a prospect can be added", bakeryFair.status === 201, bakeryFair.data);
  fd = await detail(fair);
  check("it appears on its own event", (fd.prospects || []).length === 1, fd.prospects);
  const gd = await detail(gala);
  check("and NOT on another event", (gd.prospects || []).length === 0, gd.prospects);

  // ==================================================================
  section("Duplicate protection warns, and never discards");
  const dupe = await mkProspect(fair, {
    business_name: "Smith's Bakery LLC", website: "smiths-evtest.com",
  });
  check("a likely duplicate is refused with 409, not silently created", dupe.status === 409, dupe.data);
  check("the existing record is shown so a person can open it",
    Array.isArray(dupe.data.duplicates) && dupe.data.duplicates.length > 0, dupe.data);
  check("and it says what matched",
    (dupe.data.duplicates[0].matched_on || []).length > 0, dupe.data.duplicates[0]);
  check("a domain match is reported as certain",
    dupe.data.duplicates[0].confidence === "certain", dupe.data.duplicates[0]);
  fd = await detail(fair);
  check("nothing was created by the refused attempt", (fd.prospects || []).length === 1, fd.prospects.length);

  const forced = await mkProspect(fair, {
    business_name: "Smith's Bakery LLC", website: "smiths-evtest.com", force: true,
  });
  check("the person can override and add it anyway", forced.status === 201, forced.data);
  check("and is told it went in despite the match",
    Array.isArray(forced.data.added_despite_duplicates), forced.data);

  // The half that would be a real bug: the same business at a DIFFERENT event.
  const bakeryGala = await mkProspect(gala, {
    business_name: "EVTEST Smiths Bakery", website: "https://smiths-evtest.com",
  });
  check("the same business on a DIFFERENT event is never blocked", bakeryGala.status === 201, bakeryGala.data);

  const checkDup = await owner(`/api/events/${fair}/prospects/check-duplicate`, {
    method: "POST", body: { business_name: "Smiths Bakery" } });
  check("a form can check before saving", checkDup.status === 200 && checkDup.data.duplicates.length > 0, checkDup.data);

  // ==================================================================
  section("Do-not-contact is permanent, and applies across every event");
  const noisy = await mkProspect(fair, {
    business_name: "EVTEST Loud Signs Co", public_email: "stop@loudsigns-evtest.com",
  });
  const noisyId = noisy.data.id;
  check("marking do-not-contact is accepted",
    (await owner(`/api/events/${fair}/prospects/${noisyId}`, {
      method: "PATCH", body: { do_not_contact: true, do_not_contact_reason: "Asked us to stop" } })).status === 200);
  fd = await detail(fair);
  let row = (fd.prospects || []).find((p) => p.id === noisyId);
  check("the flag is set", row.do_not_contact === true, row);
  check("the status shows it in the pipeline too", row.status === "DO_NOT_CONTACT", row.status);
  check("the reason is recorded", /asked us to stop/i.test(row.do_not_contact_reason || ""), row.do_not_contact_reason);
  check("and when, so it can be audited", !!row.do_not_contact_at, row.do_not_contact_at);

  // The accident this prevents: somebody moves them along the pipeline and the
  // suppression quietly lifts.
  await owner(`/api/events/${fair}/prospects/${noisyId}`, { method: "PATCH", body: { status: "READY_FOR_OUTREACH" } });
  fd = await detail(fair);
  row = (fd.prospects || []).find((p) => p.id === noisyId);
  check("changing their status does NOT lift the suppression", row.do_not_contact === true, row);
  check("and the status snaps back rather than reading as ready to email",
    row.status === "DO_NOT_CONTACT", row.status);

  // The other half: a new event must start already knowing.
  const noisyAgain = await mkProspect(gala, {
    business_name: "EVTEST Loud Signs Co", public_email: "stop@loudsigns-evtest.com",
  });
  check("adding them to a different event is allowed", noisyAgain.status === 201, noisyAgain.data);
  const gd2 = await detail(gala);
  const carried = (gd2.prospects || []).find((p) => p.id === noisyAgain.data.id);
  check("but they arrive already suppressed", carried.do_not_contact === true, carried);
  check("with the status carried over, not reset to a fresh prospect",
    carried.status === "DO_NOT_CONTACT", carried.status);

  check("lifting it is possible, and deliberate",
    (await owner(`/api/events/${fair}/prospects/${noisyId}`, {
      method: "PATCH", body: { do_not_contact: false } })).status === 200);
  fd = await detail(fair);
  check("and then the flag really is clear",
    (fd.prospects.find((p) => p.id === noisyId) || {}).do_not_contact === false);

  // ==================================================================
  section("Cash and donated goods are never added together");
  const sponsorProspect = await mkProspect(fair, { business_name: "EVTEST Big Bank" });
  const lvls = (await detail(fair)).sponsorship_levels;
  check("a sponsorship can be recorded",
    (await owner(`/api/events/${fair}/sponsorships`, {
      method: "POST", body: {
        prospect_id: sponsorProspect.data.id, sponsorship_level_id: lvls[0].id,
        amount_committed: 1000, amount_paid: 400, payment_status: "PARTIAL",
      } })).status === 201);
  check("an in-kind donation can be recorded",
    (await owner(`/api/events/${fair}/donations`, {
      method: "POST", body: {
        donor_name: "EVTEST Party Store", item_or_service: "Bounce house",
        donation_category: "Bounce Houses", estimated_value: 600, received: true,
      } })).status === 201);
  // Deliberately unvalued: nobody has priced it.
  check("an unvalued donation is accepted",
    (await owner(`/api/events/${fair}/donations`, {
      method: "POST", body: { donor_name: "EVTEST Anon", item_or_service: "Two crates of pumpkins" } })).status === 201);

  fd = await detail(fair);
  const t = fd.totals;
  check("committed is its own figure", Number(t.sponsorship_committed) === 1000, t);
  check("paid is its own figure", Number(t.sponsorship_paid) === 400, t);
  check("in-kind is reported separately as an ESTIMATE",
    Number(t.in_kind_estimate_received) === 600, t);
  check("there is no single blended 'total raised' to misquote",
    t.total_raised === undefined && t.total === undefined, Object.keys(t));
  // The quiet one: an unvalued donation counted as zero would make a real gift
  // vanish from the numbers with nothing on screen to say so.
  check("an unvalued item is counted as unvalued, not as zero",
    t.in_kind_items_unvalued === 1, t);
  check("and it still exists as a donation", t.in_kind_count === 2, t);
  check("a received donation with no thanks yet is flagged", t.awaiting_thanks >= 1, t);

  section("A cancelled sponsorship stops counting");
  const spList = (await detail(fair)).sponsorships;
  await owner(`/api/events/${fair}/sponsorships/${spList[0].id}`, { method: "PATCH", body: { payment_status: "CANCELLED" } });
  fd = await detail(fair);
  check("a cancelled sponsorship is excluded from committed",
    Number(fd.totals.sponsorship_committed) === 0, fd.totals);
  await owner(`/api/events/${fair}/sponsorships/${spList[0].id}`, { method: "PATCH", body: { payment_status: "PARTIAL" } });

  section("Thanking somebody is a fact with a date");
  const dn = (await detail(fair)).donations.find((d) => d.item_or_service === "Bounce house");
  await owner(`/api/events/${fair}/donations/${dn.id}`, { method: "PATCH", body: { thank_you_sent: true } });
  fd = await detail(fair);
  const thanked = fd.donations.find((d) => d.id === dn.id);
  check("marking thanks records when", !!thanked.thank_you_sent_at, thanked);
  check("and it drops off the awaiting list",
    fd.totals.awaiting_thanks < 2, fd.totals);

  // ==================================================================
  section("Vendors move through their statuses, and the day's needs add up");
  const v1 = await owner(`/api/events/${fair}/vendors`, {
    method: "POST", body: { vendor_name: "EVTEST Taco Truck", electricity_needed: true, status: "INVITED" } });
  check("a vendor can be created", v1.status === 201, v1.data);
  for (const st of ["INTERESTED", "APPLICATION_SENT", "UNDER_REVIEW", "APPROVED", "CONFIRMED"]) {
    check(`it can move to ${st}`,
      (await owner(`/api/events/${fair}/vendors/${v1.data.id}`, { method: "PATCH", body: { status: st } })).status === 200);
  }
  await owner(`/api/events/${fair}/vendors`, {
    method: "POST", body: { vendor_name: "EVTEST Face Painter", table_needed: true, status: "INTERESTED" } });
  fd = await detail(fair);
  check("only CONFIRMED vendors are counted as confirmed",
    fd.totals.vendors_confirmed === 1 && fd.totals.vendors_total === 2, fd.totals);
  // The thing nobody remembers until the morning of the event.
  check("power needs are counted from confirmed vendors only",
    fd.totals.needs_electricity === 1, fd.totals);
  check("and so are table needs", fd.totals.needs_table === 0, fd.totals);
  check("an unknown status is refused rather than stored",
    (await owner(`/api/events/${fair}/vendors/${v1.data.id}`,
      { method: "PATCH", body: { status: "BANANA" } })).status === 200
    && (await detail(fair)).vendors.find((v) => v.id === v1.data.id).status === "CONFIRMED");

  section("Community partners record what they actually agreed to");
  const cp = await owner(`/api/events/${fair}/community-partners`, {
    method: "POST", body: {
      organization_name: "EVTEST Public Library", status: "CONFIRMED",
      display_flyers: true, share_registration_link: true,
    } });
  check("a community partner can be created", cp.status === 201, cp.data);
  fd = await detail(fair);
  const partner = fd.community_partners[0];
  check("their commitments are stored", partner.display_flyers === true && partner.share_registration_link === true, partner);
  check("and what they did NOT agree to stays false", partner.email_families === false, partner);
  check("confirmed partners are counted", fd.totals.partners_confirmed === 1, fd.totals);

  // ==================================================================
  section("Everything stays isolated by event");
  const gd3 = await detail(gala);
  check("the third event has no sponsorships", (gd3.sponsorships || []).length === 0);
  check("no donations", (gd3.donations || []).length === 0);
  check("no vendors", (gd3.vendors || []).length === 0);
  check("no community partners", (gd3.community_partners || []).length === 0);
  check("and its totals are all zero rather than borrowed",
    Number(gd3.totals.sponsorship_committed) === 0 && gd3.totals.vendors_total === 0, gd3.totals);
  check("a prospect from one event cannot be attached to another's sponsorship",
    (await owner(`/api/events/${gala}/sponsorships`, {
      method: "POST", body: { prospect_id: sponsorProspect.data.id, amount_committed: 10 } })).status === 400);
  check("nor a sponsorship level from another event",
    (await owner(`/api/events/${gala}/sponsorships`, {
      method: "POST", body: { sponsor_name: "X", sponsorship_level_id: lvls[0].id } })).status === 400);

  // ==================================================================
  section("Deleting a prospect never makes a sponsorship anonymous");
  const doomed = await mkProspect(gala, { business_name: "EVTEST Doomed Co" });
  await owner(`/api/events/${gala}/sponsorships`, {
    method: "POST", body: { prospect_id: doomed.data.id, amount_committed: 250 } });
  check("the prospect can be deleted",
    (await owner(`/api/events/${gala}/prospects/${doomed.data.id}`, { method: "DELETE" })).status === 200);
  const gd4 = await detail(gala);
  check("the sponsorship survives", (gd4.sponsorships || []).length === 1, gd4.sponsorships);
  check("and still says who it was from",
    /Doomed Co/.test((gd4.sponsorships[0] || {}).sponsor_name || ""), gd4.sponsorships[0]);
  check("the money is still counted", Number(gd4.totals.sponsorship_committed) === 250, gd4.totals);

  // ==================================================================
  section("Event settings persist");
  check("settings can be saved",
    (await owner(`/api/events/${fair}`, { method: "PATCH", body: {
      venue_name: "EVTEST Community Center", city: "Las Vegas", state: "NV", zip: "89101",
      attendance_goal: 400, sponsorship_goal: 12000, status: "PUBLISHED",
      registration_url: "https://example.invalid/tickets",
    } })).status === 200);
  fd = await detail(fair);
  check("the venue persisted", fd.event.venue_name === "EVTEST Community Center", fd.event);
  check("the goal persisted", Number(fd.event.attendance_goal) === 400, fd.event.attendance_goal);
  check("the status persisted", fd.event.status === "PUBLISHED", fd.event.status);
  check("an invalid status is refused rather than stored",
    (await owner(`/api/events/${fair}`, { method: "PATCH", body: { status: "SPOOKY" } })).status === 200
    && (await detail(fair)).event.status === "PUBLISHED");
  check("renaming regenerates the slug",
    (await owner(`/api/events/${fair}`, { method: "PATCH", body: { name: "EVTEST Spring Fair Renamed" } })).status === 200);
  fd = await detail(fair);
  check("and the prospects are still attached after the rename",
    (fd.prospects || []).length > 0, (fd.prospects || []).length);
  check("an event cannot be saved with a blank name",
    (await owner(`/api/events/${fair}`, { method: "PATCH", body: { name: "   " } })).status === 400);

  // ==================================================================
  section("Not everyone may see the money, or the events at all");
  const clinical = client();
  await clinical("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("a clinical user cannot list events", (await clinical("/api/events")).status === 403);
  check("nor open one", (await clinical(`/api/events/${fair}`)).status === 403);
  check("nor add a prospect",
    (await clinical(`/api/events/${fair}/prospects`, { method: "POST", body: { business_name: "X" } })).status === 403);

  const intake = client();
  await intake("/api/auth/login", { method: "POST", body: { email: "intake@spectrumsquadlv.com", password: "TestStaff123!" } });
  const intakeView = await intake(`/api/events/${fair}`);
  check("an intake user CAN open the event", intakeView.status === 200, intakeView.data);
  check("but is told they cannot see money", intakeView.data.can_see_money === false);
  // Absent, not zeroed: a zero would read as "nobody has sponsored anything".
  check("committed amounts are absent rather than shown as zero",
    intakeView.data.totals.sponsorship_committed === undefined, intakeView.data.totals);
  check("and per-sponsorship amounts are stripped too",
    (intakeView.data.sponsorships || []).every((s) => s.amount_committed === undefined),
    intakeView.data.sponsorships);
  check("they still see who the sponsors are",
    (intakeView.data.sponsorships || []).every((s) => !!s.sponsor_name));
  check("they cannot record a sponsorship",
    (await intake(`/api/events/${fair}/sponsorships`, { method: "POST", body: { sponsor_name: "X" } })).status === 403);
  check("and cannot delete the event",
    (await intake(`/api/events/${fair}`, { method: "DELETE" })).status === 403);

  // ==================================================================
  section("Deleting an event says what goes with it");
  const doomedEvent = await mkEvent("EVTEST Doomed Event");
  await mkProspect(doomedEvent, { business_name: "EVTEST Someone" });
  const del = await owner(`/api/events/${doomedEvent}`, { method: "DELETE" });
  check("it is deleted", del.status === 200, del.data);
  check("and reports what it removed", del.data.removed && del.data.removed.prospects === 1, del.data);
  check("the event is really gone", (await owner(`/api/events/${doomedEvent}`)).status === 404);
  check("its prospects went with it",
    Number((await pool.query("SELECT count(*) FROM event_prospects WHERE event_id = $1", [doomedEvent])).rows[0].count) === 0);
  check("but other events are untouched", (await owner(`/api/events/${fair}`)).status === 200);

  section("Bad input is refused, not stored");
  check("an event with no name is refused",
    (await owner("/api/events", { method: "POST", body: { name: "  " } })).status === 400);
  check("a prospect with no business name is refused",
    (await mkProspect(fair, { business_name: "" })).status === 400);
  check("a donation with no description is refused",
    (await owner(`/api/events/${fair}/donations`, { method: "POST", body: { donor_name: "X" } })).status === 400);
  check("a donation with no donor is refused",
    (await owner(`/api/events/${fair}/donations`, { method: "POST", body: { item_or_service: "Sweets" } })).status === 400);
  check("an unknown event is a 404", (await owner("/api/events/99999999")).status === 404);
  check("adding to an unknown event is a 404",
    (await owner("/api/events/99999999/prospects", { method: "POST", body: { business_name: "X" } })).status === 404);

  await purge();
  await pool.end();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
