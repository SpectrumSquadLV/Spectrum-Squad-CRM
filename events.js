// events.js -- the reusable Spectrum Squad event system (Phase 1: data layer).
//
// The Halloween Palooza is the first event created here. It is a ROW. Nothing
// in this file knows what month it is, and the same tables are meant to carry
// a Christmas event, an Autism Acceptance event, a resource fair, an open house
// or a back-to-school drive without being touched. test-events.js creates a
// second, unrelated event and asserts that everything still works, which is the
// check that keeps that claim true.
//
// What it tracks is the side of an event nobody has a system for: the
// businesses and organisations around it. Prospects are the one business
// record; sponsorships, in-kind donations, vendors and community partners all
// point at a prospect rather than storing another copy of the same phone
// number.
//
//   events                     -> the event itself and its goals
//   event_prospects            -> a business, once, per event
//   event_sponsorship_levels   -> editable tiers and prices
//   event_sponsorships         -> who bought which tier
//   event_in_kind_donations    -> goods and services given
//   event_vendors              -> booths, and what they need on the day
//   event_community_partners   -> who will help promote it
//   event_outreach_suppression -> do-not-contact, across ALL events
//
// RULE ZERO: additive. New tables, routes under /api/events/*, no existing
// table or route touched. It deliberately holds no client or clinical data --
// the only link to the rest of the CRM is an optional assigned staff member and
// an optional link to an existing crm_leads row.
//
// Phase 1 does NOT send email. There is no send route and no send button. The
// suppression table exists now so that when outreach is built it has somewhere
// to check BEFORE the first message goes out, rather than being retrofitted
// after somebody has been emailed who asked not to be.
"use strict";

const { findDuplicates } = require("./prospect-match");

module.exports = function initEvents(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json } = ctx;
  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  const role = (u) => (u && (u.role || u.role_key || "")) || "";

  // Outreach and relationships, not clinical data -- so this mirrors the Lead
  // Management tier rather than the client-record tier.
  const canEvents = (u) =>
    ["owner", "super_admin", "admin", "intake", "scheduling"].includes(role(u)) || granted(u, "events");
  // Money: committed amounts, payments, valuations.
  const canMoney = (u) => ["owner", "super_admin", "admin"].includes(role(u));
  const canDelete = (u) => ["owner", "super_admin", "admin"].includes(role(u));

  // ---- Vocabularies. Stored as TEXT and validated here rather than as a
  // database enum, matching how the rest of this CRM handles stages, so a new
  // status is a one-line change and never a migration.
  const EVENT_STATUSES = ["DRAFT", "PLANNING", "PUBLISHED", "ACTIVE", "COMPLETED", "CANCELLED"];
  const PROSPECT_STATUSES = [
    "NEW_PROSPECT", "RESEARCHED", "READY_FOR_OUTREACH", "CONTACTED", "FOLLOW_UP_NEEDED",
    "RESPONDED", "INTERESTED", "NOT_INTERESTED", "COMMITTED", "DO_NOT_CONTACT",
  ];
  const OPPORTUNITY_TYPES = [
    "SPONSOR", "VENDOR", "IN_KIND_DONOR", "COMMUNITY_PARTNER",
    "ENTERTAINMENT", "FOOD_PARTNER", "MEDIA_PARTNER", "MULTIPLE",
  ];
  const PRIORITIES = ["LOW", "MEDIUM", "HIGH"];
  const PAYMENT_STATUSES = ["NOT_INVOICED", "PENDING", "PARTIAL", "PAID", "WAIVED", "CANCELLED"];
  const VENDOR_STATUSES = [
    "INVITED", "INTERESTED", "APPLICATION_SENT", "APPLICATION_RECEIVED", "UNDER_REVIEW",
    "APPROVED", "REQUIREMENTS_PENDING", "CONFIRMED", "DECLINED",
  ];
  const PARTNER_STATUSES = ["PROSPECT", "INVITED", "INTERESTED", "CONFIRMED", "DECLINED"];
  // Starter list, editable per donation -- a custom category is stored as typed.
  const DONATION_CATEGORIES = [
    "Candy", "Pumpkins", "Food", "Drinks", "Water", "Decorations", "Tables", "Chairs",
    "Tents", "Bounce Houses", "Entertainment", "Photography", "Videography", "Printing",
    "Signs/Banners", "Sensory Items", "Raffle Prizes", "Gift Cards", "Costumes",
    "Face Painting", "Balloon Art", "Event Supplies", "Other",
  ];

  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
  const money = (v) => { const n = num(v); return n === null ? null : Math.round(n * 100) / 100; };
  const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const clean = (v, max = 500) => {
    const s = String(v == null ? "" : v).trim();
    return s ? s.slice(0, max) : null;
  };
  const oneOf = (v, allowed, fallback) => (allowed.includes(String(v || "")) ? String(v) : fallback);
  const bool = (v) => v === true || v === "true" || v === 1 || v === "1";

  // A URL-safe handle for an event, unique across events. Used for readable
  // links; never used as a primary key, so renaming an event cannot orphan its
  // prospects.
  function slugify(name) {
    const base = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    return base || "event";
  }
  async function uniqueSlug(name, excludeId) {
    const base = slugify(name);
    for (let i = 0; i < 200; i++) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      const clash = await dbGet(
        excludeId ? "SELECT id FROM events WHERE slug = ? AND id <> ?" : "SELECT id FROM events WHERE slug = ?",
        excludeId ? [candidate, excludeId] : [candidate]);
      if (!clash) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  async function initTables() {
    // Follows this codebase's migration strategy: idempotent DDL at boot,
    // additive only. Nothing here drops or renames anything.
    await dbRun(`CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      description TEXT,
      event_date TEXT,
      start_time TEXT,
      end_time TEXT,
      venue_name TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      registration_url TEXT,
      public_contact_email TEXT,
      public_contact_phone TEXT,
      registration_goal INTEGER,
      attendance_goal INTEGER,
      sponsorship_goal NUMERIC,
      vendor_goal INTEGER,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("events:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS event_prospects (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      business_name TEXT NOT NULL,
      business_category TEXT,
      website TEXT,
      public_email TEXT,
      public_phone TEXT,
      contact_name TEXT,
      contact_title TEXT,
      contact_email TEXT,
      city TEXT,
      neighborhood TEXT,
      source TEXT,
      source_url TEXT,
      opportunity_type TEXT NOT NULL DEFAULT 'SPONSOR',
      estimated_ask NUMERIC,
      priority TEXT NOT NULL DEFAULT 'MEDIUM',
      assigned_staff_id INTEGER,
      status TEXT NOT NULL DEFAULT 'NEW_PROSPECT',
      -- Do-not-contact is a FLAG, not a status, on purpose. A status is a
      -- workflow position that somebody will move on; a request never to be
      -- contacted must survive that move. Both exist: the status makes it
      -- visible in the pipeline, the flag is what any future send checks.
      do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,
      do_not_contact_reason TEXT,
      do_not_contact_at TEXT,
      do_not_contact_by TEXT,
      date_added TEXT,
      date_contacted TEXT,
      last_contact_date TEXT,
      next_follow_up TEXT,
      response_summary TEXT,
      notes TEXT,
      -- An optional link to an existing contract lead, so a school that is both
      -- is one organisation with two roles rather than two records.
      lead_id INTEGER,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("event_prospects:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_event_prospects_event ON event_prospects(event_id)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_event_prospects_status ON event_prospects(event_id, status)`).catch(() => {});

    // Suppression is GLOBAL, not per event. A business that asks not to be
    // contacted has asked Spectrum Squad, not asked-about-Halloween. Scoping
    // this to an event would email them again about the next one.
    await dbRun(`CREATE TABLE IF NOT EXISTS event_outreach_suppression (
      id SERIAL PRIMARY KEY,
      email TEXT,
      domain TEXT,
      business_name TEXT,
      reason TEXT,
      created_by TEXT,
      created_at TEXT
    )`).catch((e) => console.error("event_outreach_suppression:", e.message));
    // Not a PARTIAL index. Postgres will not use a partial unique index to infer
    // an ON CONFLICT (email) target, so the upsert below silently failed and
    // nobody was ever actually added to the suppression list. A plain unique
    // index gives the same behaviour -- NULLs are distinct in Postgres, so rows
    // with no email do not collide with each other -- and the upsert works.
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_suppression_email_uniq
                 ON event_outreach_suppression(email)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS event_sponsorship_levels (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      amount NUMERIC,
      description TEXT,
      benefits TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("event_sponsorship_levels:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_event_levels_event ON event_sponsorship_levels(event_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS event_sponsorships (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      prospect_id INTEGER REFERENCES event_prospects(id) ON DELETE SET NULL,
      -- Kept so a sponsorship still says who it was from if the prospect row is
      -- ever removed. A total that silently loses a sponsor is worse than a
      -- slightly redundant column.
      sponsor_name TEXT,
      sponsorship_level_id INTEGER REFERENCES event_sponsorship_levels(id) ON DELETE SET NULL,
      custom_sponsorship_name TEXT,
      amount_committed NUMERIC,
      amount_paid NUMERIC,
      payment_status TEXT NOT NULL DEFAULT 'NOT_INVOICED',
      date_committed TEXT,
      logo_received BOOLEAN NOT NULL DEFAULT FALSE,
      logo_document_id INTEGER,
      banner_placement BOOLEAN NOT NULL DEFAULT FALSE,
      flyer_placement BOOLEAN NOT NULL DEFAULT FALSE,
      social_media_recognition BOOLEAN NOT NULL DEFAULT FALSE,
      vendor_booth_included BOOLEAN NOT NULL DEFAULT FALSE,
      benefits_notes TEXT,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("event_sponsorships:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_event_sponsorships_event ON event_sponsorships(event_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS event_in_kind_donations (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      prospect_id INTEGER REFERENCES event_prospects(id) ON DELETE SET NULL,
      donor_name TEXT,
      item_or_service TEXT NOT NULL,
      donation_category TEXT,
      quantity TEXT,
      estimated_value NUMERIC,
      date_promised TEXT,
      received BOOLEAN NOT NULL DEFAULT FALSE,
      date_received TEXT,
      delivery_or_pickup_notes TEXT,
      thank_you_sent BOOLEAN NOT NULL DEFAULT FALSE,
      thank_you_sent_at TEXT,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("event_in_kind_donations:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_event_donations_event ON event_in_kind_donations(event_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS event_vendors (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      prospect_id INTEGER REFERENCES event_prospects(id) ON DELETE SET NULL,
      vendor_name TEXT,
      vendor_type TEXT,
      products_services TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      booth_size TEXT,
      electricity_needed BOOLEAN NOT NULL DEFAULT FALSE,
      table_needed BOOLEAN NOT NULL DEFAULT FALSE,
      chairs_needed INTEGER,
      special_requirements TEXT,
      insurance_required BOOLEAN NOT NULL DEFAULT FALSE,
      insurance_received BOOLEAN NOT NULL DEFAULT FALSE,
      arrival_instructions_sent BOOLEAN NOT NULL DEFAULT FALSE,
      final_confirmation_sent BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'INVITED',
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("event_vendors:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_event_vendors_event ON event_vendors(event_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS event_community_partners (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      prospect_id INTEGER REFERENCES event_prospects(id) ON DELETE SET NULL,
      organization_name TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      status TEXT NOT NULL DEFAULT 'PROSPECT',
      post_social_media BOOLEAN NOT NULL DEFAULT FALSE,
      email_families BOOLEAN NOT NULL DEFAULT FALSE,
      display_flyers BOOLEAN NOT NULL DEFAULT FALSE,
      distribute_flyers BOOLEAN NOT NULL DEFAULT FALSE,
      share_registration_link BOOLEAN NOT NULL DEFAULT FALSE,
      newsletter_feature BOOLEAN NOT NULL DEFAULT FALSE,
      other_commitment TEXT,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("event_community_partners:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_event_partners_event ON event_community_partners(event_id)`).catch(() => {});

    await seedFirstEvent();
  }

  // The Halloween Palooza is seeded as ordinary data, exactly as a person would
  // type it. Only what was actually given: a name and a year. Date, venue,
  // goals and contacts are left NULL and editable rather than invented, because
  // a made-up venue that reaches a flyer is worse than a blank field.
  const FIRST_EVENT_NAME = "Spectrum Squad Halloween Palooza 2026";
  const STARTER_LEVELS = [
    { name: "Candy Sponsor", amount: 100, display_order: 1 },
    { name: "Pumpkin Sponsor", amount: 250, display_order: 2 },
    { name: "Boo Sponsor", amount: 500, display_order: 3 },
    { name: "Palooza Sponsor", amount: 1000, display_order: 4 },
    { name: "Presenting Sponsor", amount: 2500, display_order: 5, description: "$2,500 and above" },
  ];

  async function seedFirstEvent() {
    const existing = await dbGet("SELECT id FROM events WHERE name = ?", [FIRST_EVENT_NAME]).catch(() => null);
    if (existing) return;
    // Seeded once. If somebody deletes it, it is not silently recreated on the
    // next boot -- a marker records that the seed already ran.
    const marker = await dbGet("SELECT id FROM events LIMIT 1").catch(() => null);
    if (marker) return;
    const slug = await uniqueSlug(FIRST_EVENT_NAME);
    const row = await dbRun(
      `INSERT INTO events (name, slug, status, created_by, created_at, updated_at)
       VALUES (?, ?, 'DRAFT', 'system', ?, ?) RETURNING id`,
      [FIRST_EVENT_NAME, slug, nowISO(), nowISO()]
    ).catch((e) => { console.error("seed event:", e.message); return null; });
    if (!row || !row.rows || !row.rows[0]) return;
    const eventId = row.rows[0].id;
    for (const lv of STARTER_LEVELS) {
      await dbRun(
        `INSERT INTO event_sponsorship_levels (event_id, name, amount, description, display_order, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, TRUE, ?, ?)`,
        [eventId, lv.name, lv.amount, lv.description || null, lv.display_order, nowISO(), nowISO()]
      ).catch((e) => console.error("seed level:", e.message));
    }
    console.log(`[events] seeded "${FIRST_EVENT_NAME}" with ${STARTER_LEVELS.length} editable sponsorship levels.`);
  }

  // -------------------------------------------------------------- rollups
  //
  // Cash and donated goods are never added into one number. An in-kind
  // estimate is somebody's guess at what a donated bounce house was worth;
  // committed money is a promise; paid money is in the bank. A single "total
  // raised" that blends the three is the figure that ends up in a sponsor deck
  // and cannot be stood behind.
  function rollup(sponsorships, donations, vendors, partners, prospects) {
    const t = {
      sponsorship_committed: 0, sponsorship_paid: 0, sponsorship_count: sponsorships.length,
      in_kind_estimate_received: 0, in_kind_estimate_promised: 0, in_kind_items_unvalued: 0,
      in_kind_count: donations.length,
      vendors_confirmed: 0, vendors_total: vendors.length,
      partners_confirmed: 0, partners_total: partners.length,
      prospects_total: prospects.length, prospects_do_not_contact: 0,
      needs_electricity: 0, needs_table: 0, awaiting_thanks: 0,
    };
    for (const s of sponsorships) {
      if (s.payment_status === "CANCELLED") continue;
      t.sponsorship_committed += num(s.amount_committed) || 0;
      t.sponsorship_paid += num(s.amount_paid) || 0;
    }
    for (const d of donations) {
      const est = num(d.estimated_value);
      const received = d.received === true || d.received === "t";
      if (est === null) t.in_kind_items_unvalued += 1;
      else if (received) t.in_kind_estimate_received += est;
      else t.in_kind_estimate_promised += est;
      if (received && !(d.thank_you_sent === true || d.thank_you_sent === "t")) t.awaiting_thanks += 1;
    }
    for (const v of vendors) {
      if (v.status === "CONFIRMED") {
        t.vendors_confirmed += 1;
        if (v.electricity_needed === true || v.electricity_needed === "t") t.needs_electricity += 1;
        if (v.table_needed === true || v.table_needed === "t") t.needs_table += 1;
      }
    }
    for (const p of partners) if (p.status === "CONFIRMED") t.partners_confirmed += 1;
    for (const p of prospects) if (p.do_not_contact === true || p.do_not_contact === "t") t.prospects_do_not_contact += 1;
    for (const k of ["sponsorship_committed", "sponsorship_paid", "in_kind_estimate_received", "in_kind_estimate_promised"]) {
      t[k] = Math.round(t[k] * 100) / 100;
    }
    return t;
  }

  // ---------------------------------------------------------- dashboard
  //
  // Phase 2. Derived here rather than on the screen so the dashboard and the
  // tabs can never disagree about the same number.
  //
  // Two rules carried over from the data layer, because a dashboard is exactly
  // where they get broken:
  //
  //   A GOAL NOBODY SET IS NOT A GOAL OF ZERO. Reporting 0/0 as 100%, or as
  //   0%, invents a denominator. Every meter says whether a target was actually
  //   entered, and reads "No goal set" when it was not.
  //
  //   CASH AND DONATED GOODS STAY APART. Committed is a promise, paid is money
  //   received, in-kind is somebody's estimate of what a donated item was
  //   worth. There is no combined figure here to misquote.
  const PIPELINE_ORDER = [
    "NEW_PROSPECT", "RESEARCHED", "READY_FOR_OUTREACH", "CONTACTED",
    "FOLLOW_UP_NEEDED", "RESPONDED", "INTERESTED", "COMMITTED",
  ];
  const OUT_OF_PIPELINE = ["NOT_INTERESTED", "DO_NOT_CONTACT"];

  // Dates in this CRM are TEXT. Only a plain YYYY-MM-DD is treated as a day, so
  // a half-typed date cannot become a countdown of forty thousand days.
  function daysUntil(dateText, today) {
    const s = String(dateText || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const then = Date.parse(s + "T00:00:00Z");
    if (!Number.isFinite(then)) return null;
    const now = Date.parse(String(today).slice(0, 10) + "T00:00:00Z");
    if (!Number.isFinite(now)) return null;
    return Math.round((then - now) / 86400000);
  }

  // Two different unknowns, kept apart, because collapsing either into zero
  // states something false:
  //
  //   target_set  false -- nobody entered a goal. Percent is null, not 0/100.
  //   actual_known false -- the CRM HAS no figure for this. Registrations and
  //                  attendance are ticketed on Eventbrite and never flow in
  //                  here, so reporting "0 of 400" would claim nobody has
  //                  signed up rather than that we do not know.
  function meter(label, actual, target, opts) {
    const t = num(target);
    const set = t !== null && t > 0;
    const known = !(opts && opts.actualUnknown);
    const a = known ? Math.round((num(actual) || 0) * 100) / 100 : null;
    return {
      label,
      actual: a,
      actual_known: known,
      source: (opts && opts.source) || null,
      target: set ? t : null,
      target_set: set,
      percent: set && known ? Math.round((a / t) * 1000) / 10 : null,
    };
  }

  function buildDashboard({ event, prospects, sponsorships, donations, vendors, partners, levels, today }) {
    const totals = rollup(sponsorships, donations, vendors, partners, prospects);

    const byStatus = {};
    for (const st of PIPELINE_ORDER.concat(OUT_OF_PIPELINE)) byStatus[st] = 0;
    for (const p of prospects) {
      if (byStatus[p.status] === undefined) byStatus[p.status] = 0;
      byStatus[p.status] += 1;
    }

    // Work queues, not decoration. Each one is a thing a person can go and do,
    // and each carries the rows so the screen can link straight to them.
    const isTrue = (v) => v === true || v === "t";
    const attention = [];
    const push = (key, label, rows, tone) => {
      if (rows.length) attention.push({ key, label, count: rows.length, tone, ids: rows.map((r) => r.id).slice(0, 50) });
    };

    const todayStr = String(today).slice(0, 10);
    push("follow_up_due", "Prospects with a follow-up date that has passed",
      prospects.filter((p) => {
        const d = String(p.next_follow_up || "").trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= todayStr && !isTrue(p.do_not_contact)
          && !["COMMITTED", "NOT_INTERESTED", "DO_NOT_CONTACT"].includes(p.status);
      }), "warning");
    push("ready_no_contact", "Researched and ready, but nobody has reached out",
      prospects.filter((p) => p.status === "READY_FOR_OUTREACH" && !isTrue(p.do_not_contact)), "info");
    push("sponsor_unpaid", "Sponsorships committed but not fully paid",
      sponsorships.filter((s) => {
        if (s.payment_status === "CANCELLED" || s.payment_status === "WAIVED") return false;
        const c = num(s.amount_committed) || 0, p = num(s.amount_paid) || 0;
        return c > 0 && p < c;
      }), "warning");
    push("sponsor_no_logo", "Sponsors whose logo has not arrived",
      sponsorships.filter((s) => (isTrue(s.banner_placement) || isTrue(s.flyer_placement)) && !isTrue(s.logo_received)), "warning");
    push("vendor_insurance", "Confirmed vendors whose insurance is still outstanding",
      vendors.filter((v) => v.status === "CONFIRMED" && isTrue(v.insurance_required) && !isTrue(v.insurance_received)), "critical");
    push("vendor_not_briefed", "Confirmed vendors who have not had arrival instructions",
      vendors.filter((v) => v.status === "CONFIRMED" && !isTrue(v.arrival_instructions_sent)), "info");
    push("vendor_stalled", "Vendors waiting on us to review their application",
      vendors.filter((v) => ["APPLICATION_RECEIVED", "UNDER_REVIEW"].includes(v.status)), "warning");
    push("donation_unreceived", "Donations promised but not yet received",
      donations.filter((d) => !isTrue(d.received)), "info");
    push("donation_unthanked", "Donations received with no thank-you sent",
      donations.filter((d) => isTrue(d.received) && !isTrue(d.thank_you_sent)), "warning");
    push("donation_unvalued", "Donated items nobody has valued yet",
      donations.filter((d) => num(d.estimated_value) === null), "info");
    push("partner_undecided", "Community partners who have not said yes or no",
      partners.filter((p) => ["PROSPECT", "INVITED", "INTERESTED"].includes(p.status)), "info");

    return {
      event_id: event.id,
      event_name: event.name,
      event_date: event.event_date || null,
      days_until: daysUntil(event.event_date, today),
      status: event.status,
      meters: {
        sponsorship: meter("Sponsorship raised", totals.sponsorship_paid, event.sponsorship_goal),
        sponsorship_committed: meter("Sponsorship committed", totals.sponsorship_committed, event.sponsorship_goal),
        vendors: meter("Vendors confirmed", totals.vendors_confirmed, event.vendor_goal),
        registrations: meter("Registrations", null, event.registration_goal,
          { actualUnknown: true, source: "Ticketing lives on Eventbrite — the CRM has no registration count." }),
        attendance: meter("Attendance", null, event.attendance_goal,
          { actualUnknown: true, source: "Counted on the day — the CRM has no attendance figure." }),
      },
      funnel: {
        order: PIPELINE_ORDER,
        out_of_pipeline: OUT_OF_PIPELINE,
        counts: byStatus,
        total: prospects.length,
      },
      money: {
        committed: totals.sponsorship_committed,
        paid: totals.sponsorship_paid,
        outstanding: Math.round((totals.sponsorship_committed - totals.sponsorship_paid) * 100) / 100,
        in_kind_estimate_received: totals.in_kind_estimate_received,
        in_kind_estimate_promised: totals.in_kind_estimate_promised,
        in_kind_items_unvalued: totals.in_kind_items_unvalued,
        levels_offered: levels.filter((l) => isTrue(l.active)).length,
      },
      readiness: {
        vendors_confirmed: totals.vendors_confirmed,
        vendors_total: totals.vendors_total,
        needs_electricity: totals.needs_electricity,
        needs_table: totals.needs_table,
        partners_confirmed: totals.partners_confirmed,
        partners_total: totals.partners_total,
      },
      attention,
      totals,
    };
  }

  const stripMoney = (row, fields) => {
    const out = { ...row };
    for (const f of fields) delete out[f];
    return out;
  };

  // ------------------------------------------------------------------ API
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/events")) return false;
    if (!canEvents(user)) { json(res, 403, { error: "Not permitted" }); return true; }
    const actor = (user && (user.email || user.name)) || "staff";
    const seesMoney = canMoney(user);

    const eventExists = async (id) => !!(await dbGet("SELECT id FROM events WHERE id = ?", [id]));

    // ---- vocabularies, so the screen never hard-codes a second copy
    if (pathname === "/api/events/vocab" && method === "GET") {
      json(res, 200, {
        event_statuses: EVENT_STATUSES, prospect_statuses: PROSPECT_STATUSES,
        opportunity_types: OPPORTUNITY_TYPES, priorities: PRIORITIES,
        payment_statuses: PAYMENT_STATUSES, vendor_statuses: VENDOR_STATUSES,
        partner_statuses: PARTNER_STATUSES, donation_categories: DONATION_CATEGORIES,
        can_see_money: seesMoney, can_delete: canDelete(user),
      });
      return true;
    }

    // ---- events
    if (pathname === "/api/events" && method === "GET") {
      const events = await dbAll("SELECT * FROM events ORDER BY COALESCE(NULLIF(event_date,''),'9999-99-99') DESC, id DESC");
      const out = [];
      for (const ev of events) {
        const [sp, dn, vn, pt, pr] = await Promise.all([
          dbAll("SELECT * FROM event_sponsorships WHERE event_id = ?", [ev.id]),
          dbAll("SELECT * FROM event_in_kind_donations WHERE event_id = ?", [ev.id]),
          dbAll("SELECT * FROM event_vendors WHERE event_id = ?", [ev.id]),
          dbAll("SELECT * FROM event_community_partners WHERE event_id = ?", [ev.id]),
          dbAll("SELECT * FROM event_prospects WHERE event_id = ?", [ev.id]),
        ]);
        const totals = rollup(sp, dn, vn, pt, pr);
        out.push({
          ...(seesMoney ? ev : stripMoney(ev, ["sponsorship_goal"])),
          totals: seesMoney ? totals
            : stripMoney(totals, ["sponsorship_committed", "sponsorship_paid",
                                  "in_kind_estimate_received", "in_kind_estimate_promised"]),
        });
      }
      json(res, 200, { events: out, can_see_money: seesMoney });
      return true;
    }

    if (pathname === "/api/events" && method === "POST") {
      const b = await readBody(req);
      const name = clean(b.name, 200);
      if (!name) { json(res, 400, { error: "The event needs a name." }); return true; }
      const row = await dbRun(
        `INSERT INTO events (name, slug, description, event_date, start_time, end_time, venue_name, address,
           city, state, zip, registration_url, public_contact_email, public_contact_phone,
           registration_goal, attendance_goal, sponsorship_goal, vendor_goal, status, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [name, await uniqueSlug(name), clean(b.description, 8000), clean(b.event_date, 40),
         clean(b.start_time, 40), clean(b.end_time, 40), clean(b.venue_name, 300), clean(b.address, 300),
         clean(b.city, 120), clean(b.state, 60), clean(b.zip, 20), clean(b.registration_url, 500),
         clean(b.public_contact_email, 200), clean(b.public_contact_phone, 60),
         intOrNull(b.registration_goal), intOrNull(b.attendance_goal),
         seesMoney ? money(b.sponsorship_goal) : null, intOrNull(b.vendor_goal),
         oneOf(b.status, EVENT_STATUSES, "DRAFT"), actor, nowISO(), nowISO()]
      );
      json(res, 201, { ok: true, id: row.rows[0].id });
      return true;
    }

    const dashMatch = pathname.match(/^\/api\/events\/(\d+)\/dashboard$/);
    if (dashMatch && method === "GET") {
      const id = Number(dashMatch[1]);
      const ev = await dbGet("SELECT * FROM events WHERE id = ?", [id]);
      if (!ev) { json(res, 404, { error: "Not found" }); return true; }
      const [prospects, levels, sponsorships, donations, vendors, partners] = await Promise.all([
        dbAll("SELECT * FROM event_prospects WHERE event_id = ?", [id]),
        dbAll("SELECT * FROM event_sponsorship_levels WHERE event_id = ?", [id]),
        dbAll("SELECT * FROM event_sponsorships WHERE event_id = ?", [id]),
        dbAll("SELECT * FROM event_in_kind_donations WHERE event_id = ?", [id]),
        dbAll("SELECT * FROM event_vendors WHERE event_id = ?", [id]),
        dbAll("SELECT * FROM event_community_partners WHERE event_id = ?", [id]),
      ]);
      const d = buildDashboard({
        event: ev, prospects, sponsorships, donations, vendors, partners, levels, today: nowISO(),
      });
      if (!seesMoney) {
        // Money is removed, not zeroed. A zero would read as "nobody has
        // sponsored anything", which is a different and worse claim than
        // "you are not shown this".
        d.money = { in_kind_items_unvalued: d.money.in_kind_items_unvalued, levels_offered: d.money.levels_offered };
        delete d.meters.sponsorship;
        delete d.meters.sponsorship_committed;
        d.totals = stripMoney(d.totals, ["sponsorship_committed", "sponsorship_paid",
          "in_kind_estimate_received", "in_kind_estimate_promised"]);
        d.attention = d.attention.filter((a) => a.key !== "sponsor_unpaid");
      }
      json(res, 200, { ...d, can_see_money: seesMoney });
      return true;
    }

    const evMatch = pathname.match(/^\/api\/events\/(\d+)$/);
    if (evMatch && method === "GET") {
      const id = Number(evMatch[1]);
      const ev = await dbGet("SELECT * FROM events WHERE id = ?", [id]);
      if (!ev) { json(res, 404, { error: "Not found" }); return true; }
      const [prospects, levels, sponsorships, donations, vendors, partners] = await Promise.all([
        dbAll("SELECT * FROM event_prospects WHERE event_id = ? ORDER BY business_name", [id]),
        dbAll("SELECT * FROM event_sponsorship_levels WHERE event_id = ? ORDER BY display_order, id", [id]),
        dbAll("SELECT * FROM event_sponsorships WHERE event_id = ? ORDER BY id DESC", [id]),
        dbAll("SELECT * FROM event_in_kind_donations WHERE event_id = ? ORDER BY id DESC", [id]),
        dbAll("SELECT * FROM event_vendors WHERE event_id = ? ORDER BY id DESC", [id]),
        dbAll("SELECT * FROM event_community_partners WHERE event_id = ? ORDER BY id DESC", [id]),
      ]);
      const totals = rollup(sponsorships, donations, vendors, partners, prospects);
      json(res, 200, {
        event: seesMoney ? ev : stripMoney(ev, ["sponsorship_goal"]),
        prospects: seesMoney ? prospects : prospects.map((p) => stripMoney(p, ["estimated_ask"])),
        sponsorship_levels: seesMoney ? levels : levels.map((l) => stripMoney(l, ["amount"])),
        sponsorships: seesMoney ? sponsorships
          : sponsorships.map((s) => stripMoney(s, ["amount_committed", "amount_paid"])),
        donations: seesMoney ? donations : donations.map((d) => stripMoney(d, ["estimated_value"])),
        vendors, community_partners: partners,
        totals: seesMoney ? totals
          : stripMoney(totals, ["sponsorship_committed", "sponsorship_paid",
                                "in_kind_estimate_received", "in_kind_estimate_promised"]),
        can_see_money: seesMoney, can_delete: canDelete(user),
      });
      return true;
    }

    if (evMatch && method === "PATCH") {
      const id = Number(evMatch[1]);
      const before = await dbGet("SELECT * FROM events WHERE id = ?", [id]);
      if (!before) { json(res, 404, { error: "Not found" }); return true; }
      const b = await readBody(req);
      const sets = [], vals = [];
      const put = (c, v) => { sets.push(`${c} = ?`); vals.push(v); };
      if ("name" in b) {
        const n = clean(b.name, 200);
        if (!n) { json(res, 400, { error: "The event needs a name." }); return true; }
        put("name", n);
        if (n !== before.name) put("slug", await uniqueSlug(n, id));
      }
      for (const f of ["description", "event_date", "start_time", "end_time", "venue_name", "address",
                       "city", "state", "zip", "registration_url", "public_contact_email", "public_contact_phone"]) {
        if (f in b) put(f, clean(b[f], f === "description" ? 8000 : 500));
      }
      for (const f of ["registration_goal", "attendance_goal", "vendor_goal"]) if (f in b) put(f, intOrNull(b[f]));
      if ("sponsorship_goal" in b && seesMoney) put("sponsorship_goal", money(b.sponsorship_goal));
      if ("status" in b) put("status", oneOf(b.status, EVENT_STATUSES, before.status));
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      vals.push(nowISO(), id);
      await dbRun(`UPDATE events SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, vals);
      json(res, 200, { ok: true });
      return true;
    }

    if (evMatch && method === "DELETE") {
      if (!canDelete(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const id = Number(evMatch[1]);
      if (!(await eventExists(id))) { json(res, 404, { error: "Not found" }); return true; }
      const counts = {};
      for (const [k, table] of [["prospects", "event_prospects"], ["sponsorships", "event_sponsorships"],
        ["donations", "event_in_kind_donations"], ["vendors", "event_vendors"],
        ["community_partners", "event_community_partners"], ["sponsorship_levels", "event_sponsorship_levels"]]) {
        counts[k] = (await dbAll(`SELECT id FROM ${table} WHERE event_id = ?`, [id])).length;
      }
      // The cascade does the work; the counts are returned so the confirmation
      // on screen can say what is about to go, rather than "are you sure?".
      await dbRun("DELETE FROM events WHERE id = ?", [id]);
      json(res, 200, { ok: true, removed: counts });
      return true;
    }

    // ---- prospects
    const prospectsMatch = pathname.match(/^\/api\/events\/(\d+)\/prospects$/);
    if (prospectsMatch && method === "POST") {
      const eventId = Number(prospectsMatch[1]);
      if (!(await eventExists(eventId))) { json(res, 404, { error: "Event not found" }); return true; }
      const b = await readBody(req);
      const businessName = clean(b.business_name, 200);
      if (!businessName) { json(res, 400, { error: "The prospect needs a business name." }); return true; }

      // Duplicate protection, scoped to THIS event only. The same business on a
      // different event is normal and is never blocked -- the query below
      // cannot see other events.
      const siblings = await dbAll("SELECT * FROM event_prospects WHERE event_id = ?", [eventId]);
      const duplicates = findDuplicates({ ...b, business_name: businessName }, siblings);
      if (duplicates.length && !bool(b.force)) {
        // 409 with the matches, not a silent drop and not a silent create.
        json(res, 409, {
          error: "This looks like a business already on this event.",
          duplicates,
          hint: "Open the existing record, or send this again with force to add it anyway.",
        });
        return true;
      }

      const email = clean(b.public_email, 200);
      const suppressed = email
        ? await dbGet("SELECT * FROM event_outreach_suppression WHERE email = ?", [email.toLowerCase()])
        : null;

      const row = await dbRun(
        `INSERT INTO event_prospects (event_id, business_name, business_category, website, public_email,
           public_phone, contact_name, contact_title, contact_email, city, neighborhood, source, source_url,
           opportunity_type, estimated_ask, priority, assigned_staff_id, status,
           do_not_contact, do_not_contact_reason, do_not_contact_at, do_not_contact_by,
           date_added, next_follow_up, notes, lead_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [eventId, businessName, clean(b.business_category, 120), clean(b.website, 500), email,
         clean(b.public_phone, 60), clean(b.contact_name, 200), clean(b.contact_title, 120),
         clean(b.contact_email, 200), clean(b.city, 120), clean(b.neighborhood, 120),
         clean(b.source, 200), clean(b.source_url, 500),
         oneOf(b.opportunity_type, OPPORTUNITY_TYPES, "SPONSOR"),
         seesMoney ? money(b.estimated_ask) : null,
         oneOf(b.priority, PRIORITIES, "MEDIUM"),
         intOrNull(b.assigned_staff_id),
         // A business already on the global do-not-contact list is added with
         // that status carried over, rather than starting fresh as a new
         // prospect somebody will happily email.
         suppressed ? "DO_NOT_CONTACT" : oneOf(b.status, PROSPECT_STATUSES, "NEW_PROSPECT"),
         !!suppressed, suppressed ? (suppressed.reason || "On the do-not-contact list") : null,
         suppressed ? nowISO() : null, suppressed ? "suppression list" : null,
         clean(b.date_added, 40) || nowISO(), clean(b.next_follow_up, 40),
         clean(b.notes, 8000), intOrNull(b.lead_id), nowISO(), nowISO()]
      );
      json(res, 201, {
        ok: true, id: row.rows[0].id,
        added_despite_duplicates: duplicates.length ? duplicates : undefined,
        suppressed: !!suppressed || undefined,
      });
      return true;
    }

    // A dry-run duplicate check, so the form can warn while somebody types
    // rather than only after they press save.
    const dupCheck = pathname.match(/^\/api\/events\/(\d+)\/prospects\/check-duplicate$/);
    if (dupCheck && method === "POST") {
      const eventId = Number(dupCheck[1]);
      const b = await readBody(req);
      const siblings = await dbAll("SELECT * FROM event_prospects WHERE event_id = ?", [eventId]);
      json(res, 200, { duplicates: findDuplicates(b, siblings) });
      return true;
    }

    const prospectMatch = pathname.match(/^\/api\/events\/(\d+)\/prospects\/(\d+)$/);
    if (prospectMatch && method === "PATCH") {
      const id = Number(prospectMatch[2]);
      const before = await dbGet("SELECT * FROM event_prospects WHERE id = ? AND event_id = ?",
        [id, Number(prospectMatch[1])]);
      if (!before) { json(res, 404, { error: "Not found" }); return true; }
      const b = await readBody(req);
      const sets = [], vals = [];
      const put = (c, v) => { sets.push(`${c} = ?`); vals.push(v); };
      if ("business_name" in b) {
        const n = clean(b.business_name, 200);
        if (!n) { json(res, 400, { error: "The prospect needs a business name." }); return true; }
        put("business_name", n);
      }
      for (const f of ["business_category", "website", "public_email", "public_phone", "contact_name",
                       "contact_title", "contact_email", "city", "neighborhood", "source", "source_url",
                       "date_contacted", "last_contact_date", "next_follow_up", "response_summary", "notes"]) {
        if (f in b) put(f, clean(b[f], f === "notes" || f === "response_summary" ? 8000 : 500));
      }
      if ("opportunity_type" in b) put("opportunity_type", oneOf(b.opportunity_type, OPPORTUNITY_TYPES, before.opportunity_type));
      if ("priority" in b) put("priority", oneOf(b.priority, PRIORITIES, before.priority));
      if ("assigned_staff_id" in b) put("assigned_staff_id", intOrNull(b.assigned_staff_id));
      if ("lead_id" in b) put("lead_id", intOrNull(b.lead_id));
      if ("estimated_ask" in b && seesMoney) put("estimated_ask", money(b.estimated_ask));

      // Do-not-contact is sticky. Setting it also parks the status so it is
      // visible in the pipeline; CLEARING it needs the flag to be cleared
      // explicitly, and moving the status alone never lifts the suppression.
      if ("do_not_contact" in b) {
        const dnc = bool(b.do_not_contact);
        put("do_not_contact", dnc);
        put("do_not_contact_reason", dnc ? (clean(b.do_not_contact_reason, 500) || "Asked not to be contacted") : null);
        put("do_not_contact_at", dnc ? (before.do_not_contact_at || nowISO()) : null);
        put("do_not_contact_by", dnc ? actor : null);
        if (dnc) put("status", "DO_NOT_CONTACT");
        // Global suppression, so the next event's list starts already knowing.
        if (dnc) {
          const em = (clean(b.public_email, 200) || before.public_email || "").toLowerCase();
          if (em) {
            await dbRun(
              `INSERT INTO event_outreach_suppression (email, business_name, reason, created_by, created_at)
               VALUES (?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING`,
              [em, before.business_name, clean(b.do_not_contact_reason, 500) || "Asked not to be contacted",
               actor, nowISO()]).catch((e) => console.error("suppression:", e.message));
          }
        }
      }
      if ("status" in b) {
        const wanted = oneOf(b.status, PROSPECT_STATUSES, before.status);
        const stillDnc = "do_not_contact" in b ? bool(b.do_not_contact)
          : (before.do_not_contact === true || before.do_not_contact === "t");
        // A workflow status change must not quietly un-suppress somebody.
        put("status", stillDnc ? "DO_NOT_CONTACT" : wanted);
      }
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      vals.push(nowISO(), id);
      await dbRun(`UPDATE event_prospects SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, vals);
      json(res, 200, { ok: true });
      return true;
    }

    if (prospectMatch && method === "DELETE") {
      if (!canDelete(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const id = Number(prospectMatch[2]);
      const before = await dbGet("SELECT * FROM event_prospects WHERE id = ? AND event_id = ?",
        [id, Number(prospectMatch[1])]);
      if (!before) { json(res, 404, { error: "Not found" }); return true; }
      // Records that reference it keep their own copy of the name, so removing
      // a prospect never makes a sponsorship or a donation anonymous.
      await dbRun("UPDATE event_sponsorships SET sponsor_name = COALESCE(NULLIF(sponsor_name,''), ?) WHERE prospect_id = ?", [before.business_name, id]);
      await dbRun("UPDATE event_in_kind_donations SET donor_name = COALESCE(NULLIF(donor_name,''), ?) WHERE prospect_id = ?", [before.business_name, id]);
      await dbRun("UPDATE event_vendors SET vendor_name = COALESCE(NULLIF(vendor_name,''), ?) WHERE prospect_id = ?", [before.business_name, id]);
      await dbRun("UPDATE event_community_partners SET organization_name = COALESCE(NULLIF(organization_name,''), ?) WHERE prospect_id = ?", [before.business_name, id]);
      await dbRun("DELETE FROM event_prospects WHERE id = ?", [id]);
      json(res, 200, { ok: true });
      return true;
    }

    // ---- sponsorship levels
    const levelsMatch = pathname.match(/^\/api\/events\/(\d+)\/sponsorship-levels$/);
    if (levelsMatch && method === "POST") {
      const eventId = Number(levelsMatch[1]);
      if (!(await eventExists(eventId))) { json(res, 404, { error: "Event not found" }); return true; }
      const b = await readBody(req);
      const name = clean(b.name, 200);
      if (!name) { json(res, 400, { error: "The level needs a name." }); return true; }
      const row = await dbRun(
        `INSERT INTO event_sponsorship_levels (event_id, name, amount, description, benefits, display_order, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
        [eventId, name, money(b.amount), clean(b.description, 2000), clean(b.benefits, 4000),
         intOrNull(b.display_order) || 0, "active" in b ? bool(b.active) : true, nowISO(), nowISO()]
      );
      json(res, 201, { ok: true, id: row.rows[0].id });
      return true;
    }

    const levelMatch = pathname.match(/^\/api\/events\/(\d+)\/sponsorship-levels\/(\d+)$/);
    if (levelMatch && method === "PATCH") {
      const id = Number(levelMatch[2]);
      const before = await dbGet("SELECT * FROM event_sponsorship_levels WHERE id = ? AND event_id = ?",
        [id, Number(levelMatch[1])]);
      if (!before) { json(res, 404, { error: "Not found" }); return true; }
      const b = await readBody(req);
      const sets = [], vals = [];
      const put = (c, v) => { sets.push(`${c} = ?`); vals.push(v); };
      if ("name" in b) {
        const n = clean(b.name, 200);
        if (!n) { json(res, 400, { error: "The level needs a name." }); return true; }
        put("name", n);
      }
      if ("amount" in b) put("amount", money(b.amount));
      if ("description" in b) put("description", clean(b.description, 2000));
      if ("benefits" in b) put("benefits", clean(b.benefits, 4000));
      if ("display_order" in b) put("display_order", intOrNull(b.display_order) || 0);
      if ("active" in b) put("active", bool(b.active));
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      vals.push(nowISO(), id);
      await dbRun(`UPDATE event_sponsorship_levels SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, vals);
      json(res, 200, { ok: true });
      return true;
    }

    // ---- sponsorships
    const sponsorshipsMatch = pathname.match(/^\/api\/events\/(\d+)\/sponsorships$/);
    if (sponsorshipsMatch && method === "POST") {
      if (!seesMoney) { json(res, 403, { error: "Not permitted to record sponsorships" }); return true; }
      const eventId = Number(sponsorshipsMatch[1]);
      if (!(await eventExists(eventId))) { json(res, 404, { error: "Event not found" }); return true; }
      const b = await readBody(req);
      const prospectId = intOrNull(b.prospect_id);
      const prospect = prospectId
        ? await dbGet("SELECT * FROM event_prospects WHERE id = ? AND event_id = ?", [prospectId, eventId]) : null;
      if (prospectId && !prospect) { json(res, 400, { error: "That prospect is not on this event." }); return true; }
      const levelId = intOrNull(b.sponsorship_level_id);
      if (levelId && !(await dbGet("SELECT id FROM event_sponsorship_levels WHERE id = ? AND event_id = ?", [levelId, eventId]))) {
        json(res, 400, { error: "That sponsorship level is not on this event." }); return true;
      }
      const sponsorName = clean(b.sponsor_name, 200) || (prospect ? prospect.business_name : null);
      if (!sponsorName) { json(res, 400, { error: "A sponsorship needs a sponsor -- pick a prospect or type a name." }); return true; }
      const row = await dbRun(
        `INSERT INTO event_sponsorships (event_id, prospect_id, sponsor_name, sponsorship_level_id,
           custom_sponsorship_name, amount_committed, amount_paid, payment_status, date_committed,
           logo_received, banner_placement, flyer_placement, social_media_recognition, vendor_booth_included,
           benefits_notes, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [eventId, prospectId, sponsorName, levelId, clean(b.custom_sponsorship_name, 200),
         money(b.amount_committed), money(b.amount_paid),
         oneOf(b.payment_status, PAYMENT_STATUSES, "NOT_INVOICED"), clean(b.date_committed, 40),
         bool(b.logo_received), bool(b.banner_placement), bool(b.flyer_placement),
         bool(b.social_media_recognition), bool(b.vendor_booth_included),
         clean(b.benefits_notes, 4000), clean(b.notes, 4000), nowISO(), nowISO()]
      );
      json(res, 201, { ok: true, id: row.rows[0].id });
      return true;
    }

    const sponsorshipMatch = pathname.match(/^\/api\/events\/(\d+)\/sponsorships\/(\d+)$/);
    if (sponsorshipMatch && (method === "PATCH" || method === "DELETE")) {
      if (!seesMoney) { json(res, 403, { error: "Not permitted" }); return true; }
      const id = Number(sponsorshipMatch[2]);
      const before = await dbGet("SELECT * FROM event_sponsorships WHERE id = ? AND event_id = ?",
        [id, Number(sponsorshipMatch[1])]);
      if (!before) { json(res, 404, { error: "Not found" }); return true; }
      if (method === "DELETE") {
        if (!canDelete(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        await dbRun("DELETE FROM event_sponsorships WHERE id = ?", [id]);
        json(res, 200, { ok: true }); return true;
      }
      const b = await readBody(req);
      const sets = [], vals = [];
      const put = (c, v) => { sets.push(`${c} = ?`); vals.push(v); };
      if ("sponsor_name" in b) put("sponsor_name", clean(b.sponsor_name, 200));
      if ("sponsorship_level_id" in b) put("sponsorship_level_id", intOrNull(b.sponsorship_level_id));
      if ("custom_sponsorship_name" in b) put("custom_sponsorship_name", clean(b.custom_sponsorship_name, 200));
      for (const f of ["amount_committed", "amount_paid"]) if (f in b) put(f, money(b[f]));
      if ("payment_status" in b) put("payment_status", oneOf(b.payment_status, PAYMENT_STATUSES, before.payment_status));
      if ("date_committed" in b) put("date_committed", clean(b.date_committed, 40));
      for (const f of ["logo_received", "banner_placement", "flyer_placement",
                       "social_media_recognition", "vendor_booth_included"]) if (f in b) put(f, bool(b[f]));
      for (const f of ["benefits_notes", "notes"]) if (f in b) put(f, clean(b[f], 4000));
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      vals.push(nowISO(), id);
      await dbRun(`UPDATE event_sponsorships SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, vals);
      json(res, 200, { ok: true });
      return true;
    }

    // ---- in-kind donations
    const donationsMatch = pathname.match(/^\/api\/events\/(\d+)\/donations$/);
    if (donationsMatch && method === "POST") {
      const eventId = Number(donationsMatch[1]);
      if (!(await eventExists(eventId))) { json(res, 404, { error: "Event not found" }); return true; }
      const b = await readBody(req);
      const item = clean(b.item_or_service, 500);
      if (!item) { json(res, 400, { error: "A donation needs a description of what was given." }); return true; }
      const prospectId = intOrNull(b.prospect_id);
      const prospect = prospectId
        ? await dbGet("SELECT * FROM event_prospects WHERE id = ? AND event_id = ?", [prospectId, eventId]) : null;
      if (prospectId && !prospect) { json(res, 400, { error: "That prospect is not on this event." }); return true; }
      const donorName = clean(b.donor_name, 200) || (prospect ? prospect.business_name : null);
      if (!donorName) { json(res, 400, { error: "A donation needs a donor -- pick a prospect or type a name." }); return true; }
      const received = bool(b.received);
      const row = await dbRun(
        `INSERT INTO event_in_kind_donations (event_id, prospect_id, donor_name, item_or_service,
           donation_category, quantity, estimated_value, date_promised, received, date_received,
           delivery_or_pickup_notes, thank_you_sent, thank_you_sent_at, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [eventId, prospectId, donorName, item, clean(b.donation_category, 120), clean(b.quantity, 120),
         // Left NULL when nobody has valued it, never defaulted to zero: an
         // unvalued donation is not a worthless one, and the rollup counts
         // those separately instead of burying them in a total.
         seesMoney ? money(b.estimated_value) : null,
         clean(b.date_promised, 40), received, received ? (clean(b.date_received, 40) || nowISO()) : null,
         clean(b.delivery_or_pickup_notes, 2000), false, null, clean(b.notes, 4000), nowISO(), nowISO()]
      );
      json(res, 201, { ok: true, id: row.rows[0].id });
      return true;
    }

    const donationMatch = pathname.match(/^\/api\/events\/(\d+)\/donations\/(\d+)$/);
    if (donationMatch && (method === "PATCH" || method === "DELETE")) {
      const id = Number(donationMatch[2]);
      const before = await dbGet("SELECT * FROM event_in_kind_donations WHERE id = ? AND event_id = ?",
        [id, Number(donationMatch[1])]);
      if (!before) { json(res, 404, { error: "Not found" }); return true; }
      if (method === "DELETE") {
        if (!canDelete(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        await dbRun("DELETE FROM event_in_kind_donations WHERE id = ?", [id]);
        json(res, 200, { ok: true }); return true;
      }
      const b = await readBody(req);
      const sets = [], vals = [];
      const put = (c, v) => { sets.push(`${c} = ?`); vals.push(v); };
      if ("donor_name" in b) {
        const n = clean(b.donor_name, 200);
        if (!n) { json(res, 400, { error: "A donation needs a donor." }); return true; }
        put("donor_name", n);
      }
      if ("item_or_service" in b) {
        const n = clean(b.item_or_service, 500);
        if (!n) { json(res, 400, { error: "A donation needs a description." }); return true; }
        put("item_or_service", n);
      }
      for (const f of ["donation_category", "quantity", "date_promised", "delivery_or_pickup_notes", "notes"]) {
        if (f in b) put(f, clean(b[f], 4000));
      }
      if ("estimated_value" in b && seesMoney) put("estimated_value", money(b.estimated_value));
      if ("received" in b) {
        const rec = bool(b.received);
        put("received", rec);
        put("date_received", rec ? (clean(b.date_received, 40) || before.date_received || nowISO()) : null);
      }
      // Thanking somebody is a fact with a date. A tick with no date cannot
      // answer "when did we thank them?", which is the only question anyone
      // asks about it afterwards.
      if ("thank_you_sent" in b) {
        const sent = bool(b.thank_you_sent);
        put("thank_you_sent", sent);
        put("thank_you_sent_at", sent ? (before.thank_you_sent_at || nowISO()) : null);
      }
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      vals.push(nowISO(), id);
      await dbRun(`UPDATE event_in_kind_donations SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, vals);
      json(res, 200, { ok: true });
      return true;
    }

    // ---- vendors
    const vendorsMatch = pathname.match(/^\/api\/events\/(\d+)\/vendors$/);
    if (vendorsMatch && method === "POST") {
      const eventId = Number(vendorsMatch[1]);
      if (!(await eventExists(eventId))) { json(res, 404, { error: "Event not found" }); return true; }
      const b = await readBody(req);
      const prospectId = intOrNull(b.prospect_id);
      const prospect = prospectId
        ? await dbGet("SELECT * FROM event_prospects WHERE id = ? AND event_id = ?", [prospectId, eventId]) : null;
      if (prospectId && !prospect) { json(res, 400, { error: "That prospect is not on this event." }); return true; }
      const vendorName = clean(b.vendor_name, 200) || (prospect ? prospect.business_name : null);
      if (!vendorName) { json(res, 400, { error: "A vendor needs a name -- pick a prospect or type one." }); return true; }
      const row = await dbRun(
        `INSERT INTO event_vendors (event_id, prospect_id, vendor_name, vendor_type, products_services,
           contact_name, contact_email, contact_phone, booth_size, electricity_needed, table_needed,
           chairs_needed, special_requirements, insurance_required, insurance_received,
           arrival_instructions_sent, final_confirmation_sent, status, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [eventId, prospectId, vendorName, clean(b.vendor_type, 120), clean(b.products_services, 2000),
         clean(b.contact_name, 200) || (prospect ? prospect.contact_name : null),
         clean(b.contact_email, 200) || (prospect ? prospect.public_email : null),
         clean(b.contact_phone, 60) || (prospect ? prospect.public_phone : null),
         clean(b.booth_size, 60), bool(b.electricity_needed), bool(b.table_needed),
         intOrNull(b.chairs_needed), clean(b.special_requirements, 2000),
         bool(b.insurance_required), bool(b.insurance_received),
         bool(b.arrival_instructions_sent), bool(b.final_confirmation_sent),
         oneOf(b.status, VENDOR_STATUSES, "INVITED"), clean(b.notes, 4000), nowISO(), nowISO()]
      );
      json(res, 201, { ok: true, id: row.rows[0].id });
      return true;
    }

    const vendorMatch = pathname.match(/^\/api\/events\/(\d+)\/vendors\/(\d+)$/);
    if (vendorMatch && (method === "PATCH" || method === "DELETE")) {
      const id = Number(vendorMatch[2]);
      const before = await dbGet("SELECT * FROM event_vendors WHERE id = ? AND event_id = ?",
        [id, Number(vendorMatch[1])]);
      if (!before) { json(res, 404, { error: "Not found" }); return true; }
      if (method === "DELETE") {
        if (!canDelete(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        await dbRun("DELETE FROM event_vendors WHERE id = ?", [id]);
        json(res, 200, { ok: true }); return true;
      }
      const b = await readBody(req);
      const sets = [], vals = [];
      const put = (c, v) => { sets.push(`${c} = ?`); vals.push(v); };
      if ("vendor_name" in b) {
        const n = clean(b.vendor_name, 200);
        if (!n) { json(res, 400, { error: "A vendor needs a name." }); return true; }
        put("vendor_name", n);
      }
      for (const f of ["vendor_type", "products_services", "contact_name", "contact_email",
                       "contact_phone", "booth_size", "special_requirements", "notes"]) {
        if (f in b) put(f, clean(b[f], 4000));
      }
      for (const f of ["electricity_needed", "table_needed", "insurance_required", "insurance_received",
                       "arrival_instructions_sent", "final_confirmation_sent"]) if (f in b) put(f, bool(b[f]));
      if ("chairs_needed" in b) put("chairs_needed", intOrNull(b.chairs_needed));
      if ("status" in b) put("status", oneOf(b.status, VENDOR_STATUSES, before.status));
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      vals.push(nowISO(), id);
      await dbRun(`UPDATE event_vendors SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, vals);
      json(res, 200, { ok: true });
      return true;
    }

    // ---- community partners
    const cpMatch = pathname.match(/^\/api\/events\/(\d+)\/community-partners$/);
    if (cpMatch && method === "POST") {
      const eventId = Number(cpMatch[1]);
      if (!(await eventExists(eventId))) { json(res, 404, { error: "Event not found" }); return true; }
      const b = await readBody(req);
      const prospectId = intOrNull(b.prospect_id);
      const prospect = prospectId
        ? await dbGet("SELECT * FROM event_prospects WHERE id = ? AND event_id = ?", [prospectId, eventId]) : null;
      if (prospectId && !prospect) { json(res, 400, { error: "That prospect is not on this event." }); return true; }
      const orgName = clean(b.organization_name, 200) || (prospect ? prospect.business_name : null);
      if (!orgName) { json(res, 400, { error: "A community partner needs an organisation name." }); return true; }
      const row = await dbRun(
        `INSERT INTO event_community_partners (event_id, prospect_id, organization_name, contact_name,
           contact_email, contact_phone, status, post_social_media, email_families, display_flyers,
           distribute_flyers, share_registration_link, newsletter_feature, other_commitment, notes,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [eventId, prospectId, orgName,
         clean(b.contact_name, 200) || (prospect ? prospect.contact_name : null),
         clean(b.contact_email, 200) || (prospect ? prospect.public_email : null),
         clean(b.contact_phone, 60) || (prospect ? prospect.public_phone : null),
         oneOf(b.status, PARTNER_STATUSES, "PROSPECT"),
         bool(b.post_social_media), bool(b.email_families), bool(b.display_flyers),
         bool(b.distribute_flyers), bool(b.share_registration_link), bool(b.newsletter_feature),
         clean(b.other_commitment, 2000), clean(b.notes, 4000), nowISO(), nowISO()]
      );
      json(res, 201, { ok: true, id: row.rows[0].id });
      return true;
    }

    const cpOneMatch = pathname.match(/^\/api\/events\/(\d+)\/community-partners\/(\d+)$/);
    if (cpOneMatch && (method === "PATCH" || method === "DELETE")) {
      const id = Number(cpOneMatch[2]);
      const before = await dbGet("SELECT * FROM event_community_partners WHERE id = ? AND event_id = ?",
        [id, Number(cpOneMatch[1])]);
      if (!before) { json(res, 404, { error: "Not found" }); return true; }
      if (method === "DELETE") {
        if (!canDelete(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        await dbRun("DELETE FROM event_community_partners WHERE id = ?", [id]);
        json(res, 200, { ok: true }); return true;
      }
      const b = await readBody(req);
      const sets = [], vals = [];
      const put = (c, v) => { sets.push(`${c} = ?`); vals.push(v); };
      if ("organization_name" in b) {
        const n = clean(b.organization_name, 200);
        if (!n) { json(res, 400, { error: "A community partner needs an organisation name." }); return true; }
        put("organization_name", n);
      }
      for (const f of ["contact_name", "contact_email", "contact_phone", "other_commitment", "notes"]) {
        if (f in b) put(f, clean(b[f], 4000));
      }
      for (const f of ["post_social_media", "email_families", "display_flyers", "distribute_flyers",
                       "share_registration_link", "newsletter_feature"]) if (f in b) put(f, bool(b[f]));
      if ("status" in b) put("status", oneOf(b.status, PARTNER_STATUSES, before.status));
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      vals.push(nowISO(), id);
      await dbRun(`UPDATE event_community_partners SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, vals);
      json(res, 200, { ok: true });
      return true;
    }

    json(res, 404, { error: "Unknown events route" });
    return true;
  }

  return {
    initTables, handleApi, rollup, buildDashboard, daysUntil, slugify, canEvents, canMoney,
    PIPELINE_ORDER, OUT_OF_PIPELINE,
    EVENT_STATUSES, PROSPECT_STATUSES, OPPORTUNITY_TYPES, PAYMENT_STATUSES,
    VENDOR_STATUSES, PARTNER_STATUSES, DONATION_CATEGORIES, STARTER_LEVELS, FIRST_EVENT_NAME,
  };
};
