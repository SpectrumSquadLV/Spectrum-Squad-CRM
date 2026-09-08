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
// Every reason NOT to send lives in outreach-guard.js, pure and exhaustively
// tested. See test-outreach-guard.js.
const guard = require("./outreach-guard");
// Which follow-ups are due, decided purely. See test-followup-schedule.js.
const { dueFollowUps } = require("./followup-schedule");
// Reading a stranger's form submission. An allowlist, not a denylist -- see
// vendor-application.js and test-vendor-application.js.
const vendorApp = require("./vendor-application");
// Registrations from Eventbrite. Two routes, one shape: a CSV export that works
// today, and an API adapter that has never reached the live service from here.
const ebImport = require("./eventbrite-import");
const ebClient = require("./eventbrite-client");

module.exports = function initEvents(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json } = ctx;
  // Optional so the module still loads standalone for the pure tests. Without
  // sendEmail nothing can send, which is the correct direction to fail.
  const sendEmail = ctx.sendEmail || null;
  const renderMergeFields = ctx.renderMergeFields
    || ((str, f) => String(str || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) => (f && f[k] != null ? String(f[k]) : "")));
  const APP_BASE_URL = ctx.APP_BASE_URL || "";
  const randomToken = ctx.randomToken || (() => require("crypto").randomBytes(24).toString("hex"));
  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  const role = (u) => (u && (u.role || u.role_key || "")) || "";

  // Outreach and relationships, not clinical data -- so this mirrors the Lead
  // Management tier rather than the client-record tier.
  const canEvents = (u) =>
    ["owner", "super_admin", "admin", "intake", "scheduling"].includes(role(u)) || granted(u, "events");
  // Money: committed amounts, payments, valuations.
  const canMoney = (u) => ["owner", "super_admin", "admin"].includes(role(u));
  const canDelete = (u) => ["owner", "super_admin", "admin"].includes(role(u));
  // Deliberately NARROWER than canEvents. Viewing the partner list is one
  // thing; sending email in Spectrum Squad's name to businesses who never
  // asked to hear from us is another, and intake/scheduling do not get it.
  const canOutreach = (u) => ["owner", "super_admin", "admin"].includes(role(u));

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

    // Phase 6: registrations from Eventbrite. The event id is per event; the
    // token is an environment variable, because it is a credential.
    await dbRun("ALTER TABLE events ADD COLUMN IF NOT EXISTS eventbrite_event_id TEXT").catch(() => {});
    // The RESULT of the last sync, never a bare number. A registration count
    // with no record of where it came from or whether the sync worked is the
    // thing the dashboard has refused to show since Phase 2.
    await dbRun(`CREATE TABLE IF NOT EXISTS event_registration_sync (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      source TEXT NOT NULL,                 -- 'csv' | 'api'
      status TEXT NOT NULL,                 -- 'success' | 'failed'
      registrations INTEGER,
      tickets INTEGER,
      not_attending INTEGER,
      undedupable INTEGER,
      problems TEXT,
      raw_sample TEXT,
      synced_by TEXT,
      synced_at TEXT
    )`).catch((e) => console.error("event_registration_sync:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_reg_sync_event ON event_registration_sync(event_id, id DESC)`).catch(() => {});

    // Phase 5: the public vendor sign-up form. Applications are CLOSED until
    // somebody opens them, per event -- a public write endpoint that is on by
    // default the moment an event is created is not something to ship.
    await dbRun("ALTER TABLE events ADD COLUMN IF NOT EXISTS vendor_applications_open BOOLEAN NOT NULL DEFAULT FALSE").catch(() => {});
    await dbRun("ALTER TABLE events ADD COLUMN IF NOT EXISTS vendor_application_intro TEXT").catch(() => {});

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
    // Where the row came from, so a staff member can tell an application a
    // vendor filled in themselves from one somebody typed on their behalf.
    await dbRun("ALTER TABLE event_vendors ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'staff'").catch(() => {});
    await dbRun("ALTER TABLE event_vendors ADD COLUMN IF NOT EXISTS applied_at TEXT").catch(() => {});

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

    // ---- Phase 3: outreach ------------------------------------------------
    //
    // Settings are GLOBAL, deliberately not per event. A daily send limit is a
    // domain-reputation control: two events each with their own limit of 50
    // would put 100 cold emails a day out of one sending domain, which is how
    // a domain stops being delivered at all.
    await dbRun(`CREATE TABLE IF NOT EXISTS event_outreach_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      daily_limit INTEGER NOT NULL DEFAULT 40,
      batch_size INTEGER NOT NULL DEFAULT 10,
      send_hour_start INTEGER NOT NULL DEFAULT 9,
      send_hour_end INTEGER NOT NULL DEFAULT 17,
      max_follow_ups INTEGER NOT NULL DEFAULT 2,
      -- Required before anything sends: CAN-SPAM wants a real mailing address
      -- in commercial email, and it is not something this code can invent.
      postal_address TEXT,
      reply_to TEXT,
      org_name TEXT,
      updated_by TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("event_outreach_settings:", e.message));
    // Starts DISABLED with no postal address, so a fresh install cannot send
    // even if somebody finds the button.
    await dbRun(`INSERT INTO event_outreach_settings (id, enabled, updated_at)
                 VALUES (1, FALSE, ?) ON CONFLICT (id) DO NOTHING`, [nowISO()]).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS event_outreach_templates (
      id SERIAL PRIMARY KEY,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      -- Step 1 is the first approach; 2+ are follow-ups, capped by
      -- max_follow_ups. delay_days is how long after the previous step.
      step INTEGER NOT NULL DEFAULT 1,
      delay_days INTEGER NOT NULL DEFAULT 7,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("event_outreach_templates:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_outreach_templates_event ON event_outreach_templates(event_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS event_outreach_messages (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      prospect_id INTEGER NOT NULL REFERENCES event_prospects(id) ON DELETE CASCADE,
      template_id INTEGER REFERENCES event_outreach_templates(id) ON DELETE SET NULL,
      step INTEGER NOT NULL DEFAULT 1,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      -- draft -> approved -> sent, or cancelled / failed / skipped. Nothing
      -- reaches an inbox from 'draft': a person has to approve it.
      status TEXT NOT NULL DEFAULT 'draft',
      created_by TEXT,
      approved_by TEXT,
      approved_at TEXT,
      sent_at TEXT,
      failed_reason TEXT,
      skipped_reason TEXT,
      -- One per message, so an unsubscribe can be traced to what prompted it.
      unsubscribe_token TEXT UNIQUE,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("event_outreach_messages:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_outreach_messages_event ON event_outreach_messages(event_id)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_outreach_messages_status ON event_outreach_messages(status)`).catch(() => {});
    // The hard stop on double-sending, at the database rather than only in
    // code: one SENT message per prospect per step, ever.
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_once_per_step
                 ON event_outreach_messages(prospect_id, step) WHERE status = 'sent'`).catch(() => {});

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

  // -------------------------------------------------- registrations (Ph 6)
  //
  // The dashboard has said "ticketing lives on Eventbrite -- the CRM has no
  // registration count" since Phase 2. A number appears here ONLY when a sync
  // actually succeeded, and it arrives with where it came from and when. A
  // failed sync leaves the meter saying what it always said, rather than
  // reporting zero registrations for a sold-out event.
  async function latestRegistrationSync(eventId) {
    return dbGet(
      "SELECT * FROM event_registration_sync WHERE event_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1",
      [eventId]).catch(() => null);
  }

  async function recordSync(eventId, source, result, actorName) {
    const problems = (result.problems || []).join(" | ") || null;
    await dbRun(
      `INSERT INTO event_registration_sync (event_id, source, status, registrations, tickets,
         not_attending, undedupable, problems, raw_sample, synced_by, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [eventId, source, result.status, result.registrations ?? null, result.tickets ?? null,
       result.not_attending ?? null, result.undedupable ?? null, problems,
       result.raw_sample ? String(result.raw_sample).slice(0, 2000) : null,
       actorName || "staff", nowISO()]
    ).catch((e) => console.error("recordSync:", e.message));
  }

  const eventbriteToken = () => String(process.env.EVENTBRITE_TOKEN || "").trim();

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

  function buildDashboard({ event, prospects, sponsorships, donations, vendors, partners, levels, today, registrationSync }) {
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
        // A real figure ONLY when a sync succeeded. Otherwise the meter says
        // what it has always said rather than reporting zero.
        registrations: registrationSync
          ? meter("Registrations", registrationSync.registrations, event.registration_goal,
              { source: `From Eventbrite (${registrationSync.source === "api" ? "API" : "CSV export"}), synced ${String(registrationSync.synced_at || "").slice(0, 10)}.` })
          : meter("Registrations", null, event.registration_goal,
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

  // ------------------------------------------------------------- outreach
  const OUTREACH_STATUSES = ["draft", "approved", "sent", "cancelled", "failed", "skipped"];

  async function outreachSettings() {
    const row = await dbGet("SELECT * FROM event_outreach_settings WHERE id = 1");
    return row || { enabled: false };
  }

  const localHour = (iso) => new Date(iso).getHours();

  async function sentTodayCount(today) {
    const day = String(today).slice(0, 10);
    const rows = await dbAll(
      "SELECT id FROM event_outreach_messages WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at LIKE ?",
      [day + "%"]);
    return rows.length;
  }

  async function suppressedSet() {
    const rows = await dbAll("SELECT email FROM event_outreach_suppression WHERE email IS NOT NULL");
    return new Set(rows.map((r) => String(r.email || "").trim().toLowerCase()));
  }

  // Which steps each prospect has ALREADY been sent. The duplicate guard reads
  // this rather than trusting the queue, so a re-queued message cannot become
  // a second email.
  async function sentStepsFor(eventId) {
    const rows = await dbAll(
      "SELECT prospect_id, step FROM event_outreach_messages WHERE event_id = ? AND status = 'sent'", [eventId]);
    const out = {};
    for (const r of rows) (out[r.prospect_id] = out[r.prospect_id] || []).push(String(r.step));
    return out;
  }

  function mergeFieldsFor(event, prospect) {
    return {
      business_name: prospect.business_name || "",
      contact_name: prospect.contact_name || prospect.business_name || "",
      contact_title: prospect.contact_title || "",
      city: prospect.city || "",
      event_name: event.name || "",
      event_date: event.event_date || "",
      venue_name: event.venue_name || "",
      registration_url: event.registration_url || "",
      public_contact_email: event.public_contact_email || "",
      public_contact_phone: event.public_contact_phone || "",
    };
  }

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

    // ---- outreach settings (GLOBAL -- see the table comment)
    if (pathname === "/api/events/outreach/settings" && method === "GET") {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const st = await outreachSettings();
      json(res, 200, { settings: st, problems: guard.configProblems(st) });
      return true;
    }
    if (pathname === "/api/events/outreach/settings" && method === "PUT") {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const b = await readBody(req);
      const sets = [], vals = [];
      const put = (c, v) => { sets.push(`${c} = ?`); vals.push(v); };
      if ("enabled" in b) put("enabled", bool(b.enabled));
      for (const f of ["daily_limit", "batch_size", "send_hour_start", "send_hour_end", "max_follow_ups"]) {
        if (f in b) put(f, intOrNull(b[f]));
      }
      for (const f of ["postal_address", "reply_to", "org_name"]) if (f in b) put(f, clean(b[f], 500));
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      vals.push(actor, nowISO());
      await dbRun(`UPDATE event_outreach_settings SET ${sets.join(", ")}, updated_by = ?, updated_at = ? WHERE id = 1`, vals);
      const st = await outreachSettings();
      // The problems list comes back with the save, so turning outreach on
      // while it is still unsendable says so immediately rather than at the
      // moment somebody presses send.
      json(res, 200, { ok: true, settings: st, problems: guard.configProblems(st) });
      return true;
    }

    // ---- outreach templates
    const tmplMatch = pathname.match(/^\/api\/events\/(\d+)\/outreach\/templates$/);
    if (tmplMatch && method === "GET") {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const eventId = Number(tmplMatch[1]);
      json(res, 200, {
        templates: await dbAll(
          "SELECT * FROM event_outreach_templates WHERE event_id = ? ORDER BY step, id", [eventId]),
      });
      return true;
    }
    if (tmplMatch && method === "POST") {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const eventId = Number(tmplMatch[1]);
      if (!(await eventExists(eventId))) { json(res, 404, { error: "Event not found" }); return true; }
      const b = await readBody(req);
      const name = clean(b.name, 200), subject = clean(b.subject, 300), body = clean(b.body, 20000);
      if (!name || !subject || !body) {
        json(res, 400, { error: "A template needs a name, a subject and a body." }); return true;
      }
      const row = await dbRun(
        `INSERT INTO event_outreach_templates (event_id, name, step, delay_days, subject, body, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
        [eventId, name, Math.max(1, intOrNull(b.step) || 1), Math.max(0, intOrNull(b.delay_days) || 0),
         subject, body, "active" in b ? bool(b.active) : true, nowISO(), nowISO()]);
      json(res, 201, { ok: true, id: row.rows[0].id });
      return true;
    }
    const tmplOne = pathname.match(/^\/api\/events\/(\d+)\/outreach\/templates\/(\d+)$/);
    if (tmplOne && (method === "PATCH" || method === "DELETE")) {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const id = Number(tmplOne[2]);
      const before = await dbGet("SELECT * FROM event_outreach_templates WHERE id = ? AND event_id = ?",
        [id, Number(tmplOne[1])]);
      if (!before) { json(res, 404, { error: "Not found" }); return true; }
      if (method === "DELETE") {
        await dbRun("DELETE FROM event_outreach_templates WHERE id = ?", [id]);
        json(res, 200, { ok: true }); return true;
      }
      const b = await readBody(req);
      const sets = [], vals = [];
      const put = (c, v) => { sets.push(`${c} = ?`); vals.push(v); };
      for (const f of ["name", "subject"]) if (f in b) put(f, clean(b[f], 300));
      if ("body" in b) put("body", clean(b.body, 20000));
      if ("step" in b) put("step", Math.max(1, intOrNull(b.step) || 1));
      if ("delay_days" in b) put("delay_days", Math.max(0, intOrNull(b.delay_days) || 0));
      if ("active" in b) put("active", bool(b.active));
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      vals.push(nowISO(), id);
      await dbRun(`UPDATE event_outreach_templates SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, vals);
      json(res, 200, { ok: true });
      return true;
    }

    // ---- draft generation
    //
    // Produces DRAFTS. Nothing here can send. Every prospect that is skipped
    // comes back with a reason rather than being quietly left out, because
    // "why didn't the bakery get one?" is the question this screen exists to
    // answer.
    const draftMatch = pathname.match(/^\/api\/events\/(\d+)\/outreach\/draft$/);
    if (draftMatch && method === "POST") {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const eventId = Number(draftMatch[1]);
      const event = await dbGet("SELECT * FROM events WHERE id = ?", [eventId]);
      if (!event) { json(res, 404, { error: "Event not found" }); return true; }
      const b = await readBody(req);
      const templateId = intOrNull(b.template_id);
      const template = templateId
        ? await dbGet("SELECT * FROM event_outreach_templates WHERE id = ? AND event_id = ?", [templateId, eventId])
        : null;
      if (!template) { json(res, 400, { error: "Pick a template that belongs to this event." }); return true; }

      const settings = await outreachSettings();
      const suppressed = await suppressedSet();
      const sentSteps = await sentStepsFor(eventId);
      const ids = Array.isArray(b.prospect_ids) ? b.prospect_ids.map(Number).filter(Boolean) : null;
      const prospects = ids && ids.length
        ? await dbAll(`SELECT * FROM event_prospects WHERE event_id = ? AND id IN (${ids.map(() => "?").join(",")})`, [eventId, ...ids])
        : await dbAll("SELECT * FROM event_prospects WHERE event_id = ?", [eventId]);

      const created = [], skipped = [];
      for (const p of prospects) {
        const why = guard.canQueueStep({
          step: template.step, settings, prospect: p, alreadySentSteps: sentSteps[p.id] || [],
        });
        if (why) { skipped.push({ prospect_id: p.id, business_name: p.business_name, reason: why }); continue; }
        const to = guard.validEmail(p.public_email || p.contact_email);
        if (!to) { skipped.push({ prospect_id: p.id, business_name: p.business_name, reason: "No usable email address on file." }); continue; }
        if (suppressed.has(to)) { skipped.push({ prospect_id: p.id, business_name: p.business_name, reason: "On the do-not-contact list." }); continue; }
        const existing = await dbGet(
          "SELECT id FROM event_outreach_messages WHERE event_id = ? AND prospect_id = ? AND step = ? AND status IN ('draft','approved')",
          [eventId, p.id, template.step]);
        if (existing) { skipped.push({ prospect_id: p.id, business_name: p.business_name, reason: "A message for this step is already waiting." }); continue; }

        const f = mergeFieldsFor(event, p);
        const row = await dbRun(
          `INSERT INTO event_outreach_messages (event_id, prospect_id, template_id, step, to_email, subject, body,
             status, created_by, unsubscribe_token, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?) RETURNING id`,
          [eventId, p.id, template.id, template.step, to,
           renderMergeFields(template.subject, f), renderMergeFields(template.body, f),
           actor, randomToken(), nowISO(), nowISO()]);
        created.push({ id: row.rows[0].id, prospect_id: p.id, business_name: p.business_name, to_email: to });
      }
      json(res, 200, { ok: true, created: created.length, skipped: skipped.length, drafts: created, skipped_detail: skipped });
      return true;
    }

    // ---- registrations from Eventbrite (Phase 6)
    const regMatch = pathname.match(/^\/api\/events\/(\d+)\/registrations$/);
    if (regMatch && method === "GET") {
      const eventId = Number(regMatch[1]);
      const ev = await dbGet("SELECT * FROM events WHERE id = ?", [eventId]);
      if (!ev) { json(res, 404, { error: "Event not found" }); return true; }
      const last = await latestRegistrationSync(eventId);
      const history = await dbAll(
        "SELECT id, source, status, registrations, tickets, problems, synced_by, synced_at FROM event_registration_sync WHERE event_id = ? ORDER BY id DESC LIMIT 10",
        [eventId]);
      json(res, 200, {
        eventbrite_event_id: ev.eventbrite_event_id || null,
        connector: ebClient.connectorStatus({
          token: eventbriteToken(), eventbriteEventId: ev.eventbrite_event_id,
        }),
        // Said in the payload, not only in a comment: the adapter has never
        // reached the live service from here.
        api_note: "The Eventbrite API adapter has not been verified against the live service. "
          + "The CSV export works today and needs no credentials.",
        latest: last || null,
        history,
      });
      return true;
    }

    // Import an Eventbrite attendee CSV. Works today, no credentials.
    const regCsvMatch = pathname.match(/^\/api\/events\/(\d+)\/registrations\/import$/);
    if (regCsvMatch && method === "POST") {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const eventId = Number(regCsvMatch[1]);
      if (!(await eventExists(eventId))) { json(res, 404, { error: "Event not found" }); return true; }
      const b = await readBody(req);
      const parsed = ebImport.parseAttendeeCsv(b.csv || "");
      const summary = ebImport.summarise(parsed.rows);
      const dryRun = b.dry_run === true;

      // A file nobody could read is a FAILED sync, recorded as such. It must
      // not overwrite a good number with zero.
      const usable = parsed.rows.length > 0;
      if (!dryRun) {
        await recordSync(eventId, "csv", {
          status: usable ? "success" : "failed",
          registrations: usable ? summary.registrations : null,
          tickets: usable ? summary.tickets : null,
          not_attending: summary.not_attending,
          undedupable: summary.undedupable,
          problems: parsed.report.problems,
        }, actor);
      }
      json(res, 200, {
        ok: usable, dry_run: dryRun,
        report: parsed.report, summary,
        recorded: usable && !dryRun,
      });
      return true;
    }

    // Run the API adapter. Reports honestly when it cannot.
    const regSyncMatch = pathname.match(/^\/api\/events\/(\d+)\/registrations\/sync$/);
    if (regSyncMatch && method === "POST") {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const eventId = Number(regSyncMatch[1]);
      const ev = await dbGet("SELECT * FROM events WHERE id = ?", [eventId]);
      if (!ev) { json(res, 404, { error: "Event not found" }); return true; }

      const result = await ebClient.fetchAttendees({
        token: eventbriteToken(),
        eventbriteEventId: ev.eventbrite_event_id,
        fetchImpl: ctx.eventbriteFetch || undefined,
      });
      if (!result.ok) {
        // Recorded as a failure so the history shows it was tried, and the
        // dashboard keeps whatever the last GOOD sync said rather than
        // dropping to zero.
        await recordSync(eventId, "api", {
          status: "failed", problems: [result.error || result.status],
          raw_sample: result.sample,
        }, actor);
        json(res, 200, { ok: false, status: result.status, error: result.error || null, connector: ebClient.connectorStatus({ token: eventbriteToken(), eventbriteEventId: ev.eventbrite_event_id }) });
        return true;
      }
      const summary = ebImport.summarise(result.attendees);
      await recordSync(eventId, "api", {
        status: "success", registrations: summary.registrations, tickets: summary.tickets,
        not_attending: summary.not_attending, undedupable: summary.undedupable,
        problems: [], raw_sample: result.sample,
      }, actor);
      json(res, 200, { ok: true, summary, pages: result.pages });
      return true;
    }

    // ---- follow-up sweep, on demand
    //
    // Drafts only. There is deliberately no route anywhere that both generates
    // a follow-up and sends it.
    const fuMatch = pathname.match(/^\/api\/events\/(\d+)\/outreach\/follow-ups$/);
    if (fuMatch && (method === "POST" || method === "GET")) {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const eventId = Number(fuMatch[1]);
      const event = await dbGet("SELECT * FROM events WHERE id = ?", [eventId]);
      if (!event) { json(res, 404, { error: "Event not found" }); return true; }

      if (method === "GET") {
        // A preview: what WOULD be drafted, without writing anything. So a
        // person can look before letting the sweep loose on a real list.
        const settings = await outreachSettings();
        const prospects = await dbAll("SELECT * FROM event_prospects WHERE event_id = ?", [eventId]);
        const messages = await dbAll("SELECT * FROM event_outreach_messages WHERE event_id = ?", [eventId]);
        const templates = await dbAll("SELECT * FROM event_outreach_templates WHERE event_id = ? AND active = TRUE", [eventId]);
        const messagesByProspect = {};
        for (const m of messages) (messagesByProspect[m.prospect_id] = messagesByProspect[m.prospect_id] || []).push(m);
        const templatesByStep = {};
        for (const t of templates.slice().sort((a, b) => a.id - b.id)) {
          if (templatesByStep[t.step] === undefined) templatesByStep[t.step] = t;
        }
        const preview = dueFollowUps({
          prospects, messagesByProspect, templatesByStep, settings,
          suppressedEmails: await suppressedSet(), now: nowISO(),
        });
        const byId = {};
        for (const p of prospects) byId[p.id] = p.business_name;
        json(res, 200, {
          due: preview.due,
          skipped: preview.skipped.map((s) => ({ ...s, business_name: byId[s.prospect_id] })),
        });
        return true;
      }

      const r = await followUpSweep(eventId, actor);
      json(res, 200, { ok: true, ...r });
      return true;
    }

    // ---- the review queue
    const msgsMatch = pathname.match(/^\/api\/events\/(\d+)\/outreach\/messages$/);
    if (msgsMatch && method === "GET") {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const eventId = Number(msgsMatch[1]);
      const status = clean(query && query.status, 40);
      const rows = status && OUTREACH_STATUSES.includes(status)
        ? await dbAll("SELECT * FROM event_outreach_messages WHERE event_id = ? AND status = ? ORDER BY id DESC LIMIT 500", [eventId, status])
        : await dbAll("SELECT * FROM event_outreach_messages WHERE event_id = ? ORDER BY id DESC LIMIT 500", [eventId]);
      const settings = await outreachSettings();
      const counts = {};
      for (const st of OUTREACH_STATUSES) counts[st] = 0;
      for (const r of await dbAll("SELECT status FROM event_outreach_messages WHERE event_id = ?", [eventId])) {
        counts[r.status] = (counts[r.status] || 0) + 1;
      }
      json(res, 200, {
        messages: rows, counts, settings,
        problems: guard.configProblems(settings),
        sent_today: await sentTodayCount(nowISO()),
        within_hours: guard.withinSendingHours(localHour(nowISO()), settings),
      });
      return true;
    }

    // ---- approve / cancel
    const msgOne = pathname.match(/^\/api\/events\/(\d+)\/outreach\/messages\/(\d+)\/(approve|cancel)$/);
    if (msgOne && method === "POST") {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const id = Number(msgOne[2]), action = msgOne[3];
      const m = await dbGet("SELECT * FROM event_outreach_messages WHERE id = ? AND event_id = ?", [id, Number(msgOne[1])]);
      if (!m) { json(res, 404, { error: "Not found" }); return true; }
      if (m.status === "sent") { json(res, 400, { error: "That message has already been sent." }); return true; }
      if (action === "approve") {
        await dbRun("UPDATE event_outreach_messages SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?",
          [actor, nowISO(), nowISO(), id]);
      } else {
        await dbRun("UPDATE event_outreach_messages SET status = 'cancelled', updated_at = ? WHERE id = ?", [nowISO(), id]);
      }
      json(res, 200, { ok: true });
      return true;
    }

    // ---- the send pass
    //
    // Every guard is re-checked HERE, immediately before each send, not at
    // queue time: somebody can be marked do-not-contact, or reply, in the hours
    // between a batch being approved and its last message going out.
    const sendMatch = pathname.match(/^\/api\/events\/(\d+)\/outreach\/send$/);
    if (sendMatch && method === "POST") {
      if (!canOutreach(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const eventId = Number(sendMatch[1]);
      const event = await dbGet("SELECT * FROM events WHERE id = ?", [eventId]);
      if (!event) { json(res, 404, { error: "Event not found" }); return true; }
      if (!sendEmail) { json(res, 503, { error: "Email is not wired up on this server." }); return true; }

      const settings = await outreachSettings();
      const approved = await dbAll(
        "SELECT * FROM event_outreach_messages WHERE event_id = ? AND status = 'approved' ORDER BY id", [eventId]);
      const prospectsById = {};
      for (const p of await dbAll("SELECT * FROM event_prospects WHERE event_id = ?", [eventId])) prospectsById[p.id] = p;

      const plan = guard.sendableNow({
        messages: approved, prospectsById,
        suppressedEmails: await suppressedSet(),
        sentStepsByProspect: await sentStepsFor(eventId),
        settings, sentToday: await sentTodayCount(nowISO()), hour: localHour(nowISO()),
      });

      // A message held for a permanent reason is marked skipped so it stops
      // being retried every pass; one held for a temporary reason (batch full,
      // daily limit, outside hours) stays approved and goes next time.
      const TEMPORARY = /batch full|daily send limit|outside the configured sending hours/i;
      for (const h of plan.hold) {
        if (TEMPORARY.test(h.reason) || plan.problems.length) continue;
        await dbRun("UPDATE event_outreach_messages SET status = 'skipped', skipped_reason = ?, updated_at = ? WHERE id = ?",
          [h.reason, nowISO(), h.message.id]);
      }

      const sent = [], failed = [];
      for (const m of plan.send) {
        const unsubscribeUrl = `${APP_BASE_URL}/outreach/unsubscribe?token=${encodeURIComponent(m.unsubscribe_token || "")}`;
        const footer = guard.complianceFooter({
          unsubscribeUrl, postalAddress: settings.postal_address,
          orgName: settings.org_name || "Spectrum Squad",
        });
        // Refuses rather than sending without an opt-out. configProblems
        // already caught this, so reaching here means something changed
        // underneath -- and the answer is still not to send.
        if (!footer) {
          failed.push({ id: m.id, reason: "No postal address or unsubscribe link -- refused to send." });
          await dbRun("UPDATE event_outreach_messages SET status = 'failed', failed_reason = ?, updated_at = ? WHERE id = ?",
            ["Missing opt-out or postal address", nowISO(), m.id]);
          continue;
        }
        try {
          const r = await sendEmail({
            to: m.to_email, subject: m.subject, html: String(m.body || "") + footer,
            clientId: null, type: "event_outreach",
          });
          if (r && r.delivered === "failed") throw new Error(r.errorMsg || "delivery failed");
          await dbRun("UPDATE event_outreach_messages SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?",
            [nowISO(), nowISO(), m.id]);
          // The prospect's own record moves too, so the pipeline and the
          // dashboard reflect that they have actually been contacted.
          await dbRun(
            `UPDATE event_prospects SET date_contacted = COALESCE(NULLIF(date_contacted,''), ?),
               last_contact_date = ?, status = CASE WHEN status IN ('NEW_PROSPECT','RESEARCHED','READY_FOR_OUTREACH')
               THEN 'CONTACTED' ELSE status END, updated_at = ? WHERE id = ?`,
            [nowISO(), nowISO(), nowISO(), m.prospect_id]);
          sent.push({ id: m.id, to: m.to_email });
        } catch (err) {
          await dbRun("UPDATE event_outreach_messages SET status = 'failed', failed_reason = ?, updated_at = ? WHERE id = ?",
            [String(err.message || err).slice(0, 500), nowISO(), m.id]);
          failed.push({ id: m.id, reason: String(err.message || err).slice(0, 200) });
        }
      }

      console.log(`[outreach] event ${eventId}: sent ${sent.length}, failed ${failed.length}, held ${plan.hold.length} by ${actor}`);
      json(res, 200, {
        ok: true, sent: sent.length, failed: failed.length, held: plan.hold.length,
        problems: plan.problems,
        held_detail: plan.hold.map((h) => ({ id: h.message.id, reason: h.reason })),
        failed_detail: failed,
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
        registrationSync: await latestRegistrationSync(id),
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
                       "city", "state", "zip", "registration_url", "public_contact_email", "public_contact_phone",
                       "vendor_application_intro", "eventbrite_event_id"]) {
        if (f in b) put(f, clean(b[f], f === "description" || f === "vendor_application_intro" ? 8000 : 500));
      }
      // Opening a public write endpoint is not the same kind of act as editing
      // a venue: it puts a form on the open internet that anybody can post to.
      // So it needs the higher tier -- the same people who may send email in
      // the company's name -- rather than everybody who can edit an event.
      if ("vendor_applications_open" in b) {
        if (!canOutreach(user)) {
          json(res, 403, { error: "Only an owner or admin can open or close public vendor sign-ups." });
          return true;
        }
        put("vendor_applications_open", bool(b.vendor_applications_open));
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

  // ---- follow-up sweep (Phase 4)
  //
  // Turns a due follow-up into a DRAFT in the same review queue as everything
  // else. It cannot send: it writes rows with status 'draft', and a person
  // still has to read and approve each one. That is the whole point -- Phase 3
  // is built on nothing reaching an inbox unread, and a scheduler that
  // promoted itself to sending would undo that silently, overnight.
  async function followUpSweep(eventId, actorName) {
    const event = await dbGet("SELECT * FROM events WHERE id = ?", [eventId]);
    if (!event) return { drafted: 0, skipped: 0, detail: [], error: "Event not found" };

    const settings = await outreachSettings();
    const prospects = await dbAll("SELECT * FROM event_prospects WHERE event_id = ?", [eventId]);
    const messages = await dbAll("SELECT * FROM event_outreach_messages WHERE event_id = ?", [eventId]);
    const templates = await dbAll(
      "SELECT * FROM event_outreach_templates WHERE event_id = ? AND active = TRUE", [eventId]);

    const messagesByProspect = {};
    for (const m of messages) (messagesByProspect[m.prospect_id] = messagesByProspect[m.prospect_id] || []).push(m);
    const templatesByStep = {};
    // Lowest id wins when two templates claim the same step, so the choice is
    // stable rather than depending on row order.
    for (const t of templates.slice().sort((a, b) => a.id - b.id)) {
      if (templatesByStep[t.step] === undefined) templatesByStep[t.step] = t;
    }

    const { due, skipped } = dueFollowUps({
      prospects, messagesByProspect, templatesByStep, settings,
      suppressedEmails: await suppressedSet(), now: nowISO(),
    });

    const created = [];
    for (const d of due) {
      const p = prospects.find((x) => x.id === d.prospect_id);
      const t = templatesByStep[d.step];
      if (!p || !t) continue;
      const f = mergeFieldsFor(event, p);
      const row = await dbRun(
        `INSERT INTO event_outreach_messages (event_id, prospect_id, template_id, step, to_email, subject, body,
           status, created_by, unsubscribe_token, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?) RETURNING id`,
        [eventId, p.id, t.id, d.step, d.to_email,
         renderMergeFields(t.subject, f), renderMergeFields(t.body, f),
         actorName || "follow-up sweep", randomToken(), nowISO(), nowISO()]
      ).catch((e) => { console.error("followup draft:", e.message); return null; });
      if (row && row.rows && row.rows[0]) {
        created.push({ id: row.rows[0].id, prospect_id: p.id, business_name: p.business_name, step: d.step });
      }
    }
    if (created.length) {
      console.log(`[outreach] follow-up sweep drafted ${created.length} message(s) for event ${eventId} -- all awaiting approval`);
    }
    return { drafted: created.length, skipped: skipped.length, created, skipped_detail: skipped };
  }

  // Runs across every event that is not finished with. Scheduled daily; also
  // available on demand from the Outreach screen.
  async function followUpSweepAll() {
    const settings = await outreachSettings();
    // Nothing is drafted while outreach is switched off. Queueing drafts a
    // person would find waiting for them after deciding not to do outreach at
    // all is its own small betrayal.
    if (!(settings.enabled === true || settings.enabled === "t")) {
      return { events: 0, drafted: 0, reason: "Outreach is switched off." };
    }
    const events = await dbAll(
      "SELECT id FROM events WHERE status NOT IN ('COMPLETED','CANCELLED')").catch(() => []);
    let drafted = 0;
    for (const ev of events) {
      const r = await followUpSweep(ev.id, "follow-up sweep").catch((e) => {
        console.error("followUpSweep failed for event", ev.id, e.message); return null;
      });
      if (r) drafted += r.drafted;
    }
    return { events: events.length, drafted };
  }

  // ------------------------------------------------- public vendor sign-up
  //
  // Phase 5. The only place in the event system that takes input from somebody
  // with no account, so the defences are stated rather than assumed:
  //
  //   CLOSED BY DEFAULT. vendor_applications_open must be switched on per
  //   event. A public write endpoint that is live the moment an event exists
  //   is not something to ship.
  //   AN ALLOWLIST. vendor-application.js decides what a stranger may set.
  //   Status is not on it, so nobody approves their own booth.
  //   A DAILY CAP. Bounded per event, so a script cannot fill the table
  //   overnight. Generous enough that a real vendor never meets it.
  //   A HONEYPOT. Answered with the same page as a real submission, because
  //   telling a bot it was caught only teaches whoever wrote it.
  const MAX_APPLICATIONS_PER_DAY = 60;
  // A plain HTML form posts application/x-www-form-urlencoded, and the CRM's
  // shared readBody only parses JSON -- it would reject every submission and
  // the form would show validation errors no matter what somebody typed. The
  // form is deliberately a plain form rather than a fetch(), so it works with
  // no JavaScript, so the body has to be read here.
  //
  // Capped: a public endpoint must never accept unbounded bytes.
  const MAX_FORM_BYTES = 64 * 1024;
  function readFormBody(req) {
    return new Promise((resolve) => {
      let raw = "", tooBig = false;
      req.on("data", (c) => {
        if (tooBig) return;
        raw += c;
        if (raw.length > MAX_FORM_BYTES) { tooBig = true; raw = ""; }
      });
      req.on("end", () => {
        if (tooBig || !raw) return resolve({});
        const type = String(req.headers["content-type"] || "");
        if (type.includes("application/json")) {
          try { return resolve(JSON.parse(raw)); } catch (e) { return resolve({}); }
        }
        const out = {};
        try {
          for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
        } catch (e) { /* a malformed body is an empty one, not a crash */ }
        resolve(out);
      });
      req.on("error", () => resolve({}));
    });
  }

  const escHtml = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function signupPage({ title, body, event }) {
    return `<!doctype html><html><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>${escHtml(title)}</title>`
      + `<style>
        body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7f8fb;color:#201a4d;
             margin:0;padding:5vh 16px;line-height:1.55;}
        .wrap{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px;}
        h1{margin:0 0 6px;font-size:24px;} .sub{color:#6b6a86;font-size:14px;margin:0 0 20px;}
        label{display:block;font-weight:600;font-size:13.5px;margin:14px 0 4px;}
        input[type=text],input[type=email],input[type=tel],input[type=number],textarea{
          width:100%;padding:9px 11px;border:1px solid #d1d5db;border-radius:8px;font:inherit;box-sizing:border-box;}
        textarea{min-height:80px;} .row{display:flex;gap:16px;flex-wrap:wrap;}
        .row>div{flex:1;min-width:200px;}
        .check{display:flex;align-items:center;gap:8px;font-weight:400;margin-top:10px;}
        .check input{width:auto;}
        button{margin-top:20px;background:#1b2a6b;color:#fff;border:0;border-radius:9px;
               padding:11px 20px;font:inherit;font-weight:600;cursor:pointer;}
        .err{background:#fee2e2;border:1px solid #fecaca;color:#991b1b;border-radius:9px;padding:10px 12px;margin-bottom:14px;font-size:14px;}
        .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}
        .note{color:#6b6a86;font-size:12.5px;margin-top:16px;}
      </style></head><body><div class="wrap">${body}</div></body></html>`;
  }

  function signupForm(event, errors, prev) {
    const p = prev || {};
    const v = (k) => escHtml(p[k] || "");
    const when = event.event_date
      ? escHtml(event.event_date) + (event.venue_name ? " &middot; " + escHtml(event.venue_name) : "")
      : (event.venue_name ? escHtml(event.venue_name) : "Date to be confirmed");
    return `<h1>Vendor sign-up</h1>
      <p class="sub">${escHtml(event.name)}<br>${when}</p>
      ${event.vendor_application_intro ? `<p>${escHtml(event.vendor_application_intro)}</p>` : ""}
      ${(errors || []).length ? `<div class="err">${errors.map(escHtml).join("<br>")}</div>` : ""}
      <form method="POST">
        <label>Business name *</label>
        <input type="text" name="vendor_name" required maxlength="200" value="${v("vendor_name")}">
        <div class="row">
          <div><label>What do you sell or offer?</label>
            <input type="text" name="vendor_type" maxlength="120" value="${v("vendor_type")}"></div>
          <div><label>Website</label>
            <input type="text" name="website" maxlength="500" value="${v("website")}"></div>
        </div>
        <label>Tell us about your products or services</label>
        <textarea name="products_services" maxlength="2000">${v("products_services")}</textarea>
        <div class="row">
          <div><label>Your name</label>
            <input type="text" name="contact_name" maxlength="200" value="${v("contact_name")}"></div>
          <div><label>Email *</label>
            <input type="email" name="contact_email" required maxlength="200" value="${v("contact_email")}"></div>
        </div>
        <div class="row">
          <div><label>Phone</label>
            <input type="tel" name="contact_phone" maxlength="60" value="${v("contact_phone")}"></div>
          <div><label>Booth size you need</label>
            <input type="text" name="booth_size" maxlength="60" placeholder="e.g. 10x10" value="${v("booth_size")}"></div>
        </div>
        <label class="check"><input type="checkbox" name="electricity_needed" value="on"> I need access to power</label>
        <label class="check"><input type="checkbox" name="table_needed" value="on"> I need a table</label>
        <label>Chairs needed</label>
        <input type="number" name="chairs_needed" min="0" max="50" value="${v("chairs_needed")}">
        <label>Anything else we should know?</label>
        <textarea name="special_requirements" maxlength="2000">${v("special_requirements")}</textarea>
        <div class="hp" aria-hidden="true">
          <label>Do not fill this in</label>
          <input type="text" name="${vendorApp.HONEYPOT_FIELD}" tabindex="-1" autocomplete="off">
        </div>
        <button type="submit">Send my application</button>
        <p class="note">Applying does not confirm a booth. We will review your application and email you.</p>
      </form>`;
  }

  // GET and POST on the same public path. No session: a vendor has no account.
  async function serveVendorSignup(req, res, pathname, method) {
    const m = pathname.match(/^\/vendor-signup\/([A-Za-z0-9-]{1,120})$/);
    const send = (status, html) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" });
      res.end(html);
      return true;
    };
    const closed = (title, msg) => send(404, signupPage({
      title, body: `<h1>${escHtml(title)}</h1><p>${escHtml(msg)}</p>`,
    }));
    if (!m) return closed("Not found", "That sign-up link is not valid.");

    const event = await dbGet("SELECT * FROM events WHERE slug = ?", [m[1]]).catch(() => null);
    // The same answer whether the event does not exist or is not accepting
    // applications, so the page is not a way to enumerate events.
    if (!event || !(event.vendor_applications_open === true || event.vendor_applications_open === "t")) {
      return closed("Sign-ups are closed",
        "This event is not accepting vendor applications at the moment. If you think that is a mistake, please get in touch.");
    }

    if (method === "GET") {
      return send(200, signupPage({ title: "Vendor sign-up", event, body: signupForm(event, [], {}) }));
    }
    if (method !== "POST") return closed("Not found", "That sign-up link is not valid.");

    const body = await readFormBody(req);
    const thanks = () => send(200, signupPage({
      title: "Thank you", event,
      body: `<h1>Thank you</h1><p>Your application for <strong>${escHtml(event.name)}</strong> has been received.</p>`
        + `<p>We will review it and email you. Applying does not confirm a booth.</p>`,
    }));

    // Caught bots get the same page a real vendor gets. Nothing is written.
    if (vendorApp.looksAutomated(body)) {
      console.log(`[vendor-signup] discarded an automated submission for event ${event.id}`);
      return thanks();
    }

    const parsed = vendorApp.parseApplication(body);
    if (!parsed.ok) {
      return send(400, signupPage({
        title: "Vendor sign-up", event,
        body: signupForm(event, parsed.errors, body),
      }));
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent = await dbAll(
      "SELECT id FROM event_vendors WHERE event_id = ? AND source = 'public' AND applied_at > ?",
      [event.id, since]).catch(() => []);
    if (recent.length >= MAX_APPLICATIONS_PER_DAY) {
      console.warn(`[vendor-signup] daily cap reached for event ${event.id}`);
      return send(429, signupPage({
        title: "Please try again later", event,
        body: `<h1>Please try again later</h1><p>We have had a lot of applications today. `
          + `Please try again tomorrow, or email us directly.</p>`,
      }));
    }

    // Somebody applying twice UPDATES their application rather than creating a
    // second one -- a vendor who realises they forgot the power question should
    // not become two rows a staff member has to reconcile. Only while it is
    // still an application: once staff have moved it along, a resubmission is
    // recorded as a fresh one so their decision is not overwritten.
    const existing = await dbGet(
      `SELECT * FROM event_vendors WHERE event_id = ? AND lower(contact_email) = ?
         AND status IN ('APPLICATION_RECEIVED','INVITED','INTERESTED') ORDER BY id DESC`,
      [event.id, parsed.value.contact_email]).catch(() => null);

    const cols = ["vendor_name", "vendor_type", "products_services", "contact_name", "contact_email",
      "contact_phone", "booth_size", "special_requirements", "electricity_needed", "table_needed", "chairs_needed"];
    try {
      if (existing) {
        await dbRun(
          `UPDATE event_vendors SET ${cols.map((c) => `${c} = ?`).join(", ")},
             status = 'APPLICATION_RECEIVED', source = 'public', applied_at = ?, updated_at = ? WHERE id = ?`,
          [...cols.map((c) => parsed.value[c]), nowISO(), nowISO(), existing.id]);
        console.log(`[vendor-signup] updated application ${existing.id} for event ${event.id}`);
      } else {
        // No prospect row is created. A vendor who came to us is not somebody
        // we sourced, and putting them in the prospect pipeline would sweep
        // them into outreach sequences aimed at businesses we are approaching.
        await dbRun(
          `INSERT INTO event_vendors (event_id, ${cols.join(", ")}, status, source, applied_at, created_at, updated_at)
           VALUES (?, ${cols.map(() => "?").join(", ")}, 'APPLICATION_RECEIVED', 'public', ?, ?, ?)`,
          [event.id, ...cols.map((c) => parsed.value[c]), nowISO(), nowISO(), nowISO()]);
        console.log(`[vendor-signup] new application for event ${event.id}`);
      }
    } catch (err) {
      console.error("[vendor-signup] could not save:", err.message);
      return send(500, signupPage({
        title: "Something went wrong", event,
        body: `<h1>Something went wrong</h1><p>We could not save your application. `
          + `Please try again, or email us directly.</p>`,
      }));
    }

    // Staff are told, and the dashboard's work queue already surfaces
    // APPLICATION_RECEIVED as "vendors waiting on us to review their
    // application" -- so this needs no new place to look.
    const notify = clean(event.public_contact_email, 200);
    if (sendEmail && notify) {
      sendEmail({
        to: notify,
        subject: `Vendor application: ${parsed.value.vendor_name} — ${event.name}`,
        html: `<p><strong>${escHtml(parsed.value.vendor_name)}</strong> has applied to be a vendor at `
          + `${escHtml(event.name)}.</p>`
          + `<p>Contact: ${escHtml(parsed.value.contact_name || "—")} · ${escHtml(parsed.value.contact_email)}`
          + `${parsed.value.contact_phone ? " · " + escHtml(parsed.value.contact_phone) : ""}</p>`
          + `<p>It is waiting for review on the event's Vendors tab.</p>`,
        clientId: null, type: "event_vendor_application",
      }).catch((e) => console.error("vendor application notify failed:", e.message));
    }

    return thanks();
  }

  // The opt-out link in every outreach email. PUBLIC -- no session, because the
  // recipient is a business owner who has no account here and must not need one
  // to be left alone.
  //
  // A GET changes state, which is normally wrong, and here it is deliberate. A
  // confirmation step would mean an opt-out that some people never complete,
  // and the two ways to be wrong are not symmetrical: a link-scanner
  // unsubscribing somebody who did not click costs us one prospect, while a
  // missed opt-out means emailing a person who asked us to stop. The second is
  // worse, so this errs towards unsubscribing.
  //
  // Suppression is GLOBAL and permanent -- it is not scoped to the event they
  // happened to be emailed about.
  async function handleUnsubscribe(req, res, query) {
    const token = String((query && query.token) || "").trim();
    const page = (title, body) => {
      const html = `<!doctype html><html><head><meta charset="utf-8">`
        + `<meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>${title}</title></head>`
        + `<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:12vh auto;padding:0 20px;color:#201a4d;line-height:1.6;">`
        + body + `</body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    };
    if (!token) {
      page("Unsubscribe", "<h1>That link is not valid</h1><p>The unsubscribe link was incomplete. "
        + "Please reply to the email you received and we will remove you.</p>");
      return true;
    }
    const msg = await dbGet("SELECT * FROM event_outreach_messages WHERE unsubscribe_token = ?", [token]);
    if (!msg) {
      page("Unsubscribe", "<h1>That link is not valid</h1><p>We could not find that unsubscribe link. "
        + "Please reply to the email you received and we will remove you.</p>");
      return true;
    }
    const email = String(msg.to_email || "").trim().toLowerCase();
    if (email) {
      const prospect = await dbGet("SELECT * FROM event_prospects WHERE id = ?", [msg.prospect_id]).catch(() => null);
      await dbRun(
        `INSERT INTO event_outreach_suppression (email, business_name, reason, created_by, created_at)
         VALUES (?, ?, 'Unsubscribed from an outreach email', 'self-service', ?)
         ON CONFLICT (email) DO NOTHING`,
        [email, prospect ? prospect.business_name : null, nowISO()]).catch((e) => console.error("unsubscribe:", e.message));
      // The prospect record is flagged too, so anybody looking at them in the
      // CRM sees it -- not only the send path.
      await dbRun(
        `UPDATE event_prospects SET do_not_contact = TRUE, status = 'DO_NOT_CONTACT',
           do_not_contact_reason = 'Unsubscribed from an outreach email',
           do_not_contact_at = COALESCE(NULLIF(do_not_contact_at,''), ?),
           do_not_contact_by = 'self-service', updated_at = ?
         WHERE lower(public_email) = ? OR lower(contact_email) = ?`,
        [nowISO(), nowISO(), email, email]).catch((e) => console.error("unsubscribe flag:", e.message));
      // Anything still queued for them is cancelled, not left to be approved
      // by somebody who has not noticed.
      await dbRun(
        "UPDATE event_outreach_messages SET status = 'cancelled', updated_at = ? WHERE lower(to_email) = ? AND status IN ('draft','approved')",
        [nowISO(), email]).catch(() => {});
      console.log(`[outreach] unsubscribe honoured for a recipient of message ${msg.id}`);
    }
    page("Unsubscribed", "<h1>You're unsubscribed</h1>"
      + "<p>We won't contact you about this or any future Spectrum Squad community event.</p>"
      + "<p style=\"color:#6b6a86;font-size:14px;\">If this was a mistake, reply to the email you received "
      + "and we can put it back.</p>");
    return true;
  }

  return {
    initTables, handleApi, handleUnsubscribe, serveVendorSignup, followUpSweep, followUpSweepAll,
    rollup, buildDashboard, daysUntil, slugify,
    canEvents, canMoney, canOutreach, outreachSettings,
    PIPELINE_ORDER, OUT_OF_PIPELINE,
    EVENT_STATUSES, PROSPECT_STATUSES, OPPORTUNITY_TYPES, PAYMENT_STATUSES,
    VENDOR_STATUSES, PARTNER_STATUSES, DONATION_CATEGORIES, STARTER_LEVELS, FIRST_EVENT_NAME,
  };
};
