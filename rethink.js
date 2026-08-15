// rethink.js -- Rethink integration service layer.
//
// One module owns every Rethink API sync. Nothing else in the CRM calls the
// Rethink API directly; modules read the tables this one writes.
//
//   Rethink Service (this file)
//     -> provider/session synchronisation  (verified monthly hours)
//     -> normalisation + CRM identity mapping
//     -> CRM database
//
// PURPOSE 1 -- VERIFIED MONTHLY HOURS (implemented here)
//
// Sums actualDurationHours per staffId from DWH GET /api/Appointments for the
// current calendar month, counting only appointments that are completed, not
// cancelled, not deleted, and genuinely staff-verified. That figure becomes the
// denominator for the RBT supervision percentage, replacing the payroll-export
// number that included overtime and non-billable time.
//
// THE FILTER IS NOT HARD-CODED, ON PURPOSE.
//
// We know the field names (appointmentStatus, staffVerification) but not the
// values Rethink actually returns in them for this tenant. Inventing them --
// guessing that "Completed" is spelled that way, or that staffVerification is a
// boolean -- is how an integration quietly produces a wrong compliance number
// that nobody catches until an audit.
//
// So every sync records the DISTINCT values it observed in those two fields,
// with counts and hour totals, into rethink_observed_values. An admin reads the
// real values off the Rethink Integration panel, ticks the ones that mean
// "completed" and "staff verified", and only then is the filter confirmed.
//
// Until it is confirmed the sync still runs, still pages the whole month, and
// still shows a PROVISIONAL total -- but it does not write anything into the
// supervision tracker. A provisional number cannot silently become a compliance
// figure.
//
// DATA SAFETY. A failed sync never blanks a good value. Hours are written only
// on a successful, filter-confirmed sync for a matched provider; every write is
// a whole-month recomputation keyed on (employee, month), so re-running a sync
// can never duplicate or double-count. Failures are recorded in
// rethink_sync_log and the last successful value stays exactly where it is,
// flagged stale by its own timestamp.
//
// PHI. Appointment rows carry PHI. Nothing in this module logs a row, a client
// id, or a session note. What is persisted is the aggregate hours per provider
// per month, plus structural facts (status value, count) needed to operate the
// integration.

"use strict";

const client = require("./rethink-client");

module.exports = function initRethink(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json } = ctx;

  // Supplied by server.js from supervision.js. Defaults to "nobody is
  // supervised" rather than "everybody is": if the wiring is ever lost, the
  // failure is a warning that goes quiet, not one that names half the company
  // as needing a Rethink ID. A test asserts server.js passes it.
  const isSupervisionTracked = ctx.isSupervisionTracked || (() => false);

  const DWH_APPOINTMENTS = "Appointments";

  // Confirmed against the DWH Swagger: GET /api/ClientAuthorization -- singular.
  // Kept overridable so a path change does not need a deploy, but the default
  // is now the documented route rather than a guess.
  const DWH_AUTHORIZATIONS = process.env.RETHINK_AUTH_ENDPOINT || "ClientAuthorization";

  // Confirmed against the DWH Swagger: GET /api/Clients.
  const DWH_CLIENTS = process.env.RETHINK_CLIENTS_ENDPOINT || "Clients";

  // /api/Clients returned HTTP 200 with zero rows while /api/Appointments
  // returned 305 on the same credentials. The difference in how we called them
  // was the date window: Appointments got From/To, Clients got nothing. The
  // documented DWH parameter set is From, To, PageSize, Page, so a
  // data-warehouse endpoint filtered on a date it was never given is the
  // cheapest explanation.
  //
  // Wide by design. We do not know which date this window filters on -- created,
  // modified, admitted -- so it is opened far enough back that any of them
  // includes every client on the books, and narrowed only if that proves noisy.
  const CLIENTS_FROM = process.env.RETHINK_CLIENTS_FROM || "2000-01-01";

  // The CPT this tracker cares about. Other codes are deliberately not imported.
  const TARGET_BILLING_CODE = "97153";
  // Fallback identity for 97153 when billingCode comes back empty. Comma-
  // separated ids, set once the real values are read off production.
  const TARGET_CODE_IDS = String(process.env.RETHINK_97153_CODE_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  // Roles allowed to see and drive the integration. Reading the panel is
  // admin-tier; changing the filter or forcing a sync is owner/super_admin,
  // because the filter decides what counts as a compliance hour.
  const VIEW_ROLES = ["owner", "super_admin", "admin", "hr_admin", "clinical"];
  const MANAGE_ROLES = ["owner", "super_admin"];
  const roleOf = (u) => (u && (u.role || u.role_key || "")) || "";
  const canView = (u) => VIEW_ROLES.includes(roleOf(u));
  const canManage = (u) => MANAGE_ROLES.includes(roleOf(u));
  // Client matching links PHI records together, so it stays owner/admin-only.
  const canMatch = (u) => ["owner", "super_admin", "admin"].includes(roleOf(u));

  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const round2 = (n) => Math.round(n * 100) / 100;
  const nowMs = () => { const t = Date.parse(nowISO()); return Number.isFinite(t) ? t : Date.now(); };
  const thisMonth = () => nowISO().slice(0, 7);
  const today = () => nowISO().slice(0, 10);

  // Normalised comparison key for a status/verification value. Rethink may send
  // "Completed", "completed", true, or 1 for the same concept; the admin ticks
  // one of them and all spellings of it match.
  const norm = (v) => {
    if (v === true) return "true";
    if (v === false) return "false";
    return String(v == null ? "" : v).trim().toLowerCase();
  };

  // ======================= SCHEMA ============================
  async function initTables() {
    // Single-row configuration. id = 1 always.
    await dbRun(`CREATE TABLE IF NOT EXISTS rethink_config (
      id INTEGER PRIMARY KEY,
      filter_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      completed_statuses TEXT,          -- JSON array of accepted appointmentStatus values
      verified_values TEXT,             -- JSON array of accepted staffVerification values
      require_staff_verification BOOLEAN NOT NULL DEFAULT TRUE,
      sync_interval_minutes INTEGER NOT NULL DEFAULT 240,
      confirmed_by TEXT,
      confirmed_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("rethink_config initTables:", e.message));

    await dbRun(
      `INSERT INTO rethink_config (id, filter_confirmed, completed_statuses, verified_values, updated_at)
       VALUES (1, FALSE, '[]', '[]', ?) ON CONFLICT (id) DO NOTHING`,
      [nowISO()]
    ).catch(() => {});

    // Every sync attempt, success or failure, so the panel can always show
    // last-attempted, last-successful, and why a run failed.
    await dbRun(`CREATE TABLE IF NOT EXISTS rethink_sync_log (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,               -- supervision_hours
      month TEXT,
      started_at TEXT,
      finished_at TEXT,
      status TEXT,                      -- running | success | failed | partial
      triggered_by TEXT,                -- scheduled | manual | boot
      appointments_seen INTEGER DEFAULT 0,
      appointments_counted INTEGER DEFAULT 0,
      providers_matched INTEGER DEFAULT 0,
      providers_unmatched INTEGER DEFAULT 0,
      hours_written BOOLEAN DEFAULT FALSE,
      error TEXT,
      error_kind TEXT,
      warnings TEXT                     -- JSON array
    )`).catch((e) => console.error("rethink_sync_log initTables:", e.message));

    // Per-provider, per-month aggregate. Recomputed wholesale each sync, which
    // is what makes repeat syncs idempotent -- there is no per-appointment row
    // to duplicate. employee_id is NULL when the staffId could not be matched.
    await dbRun(`CREATE TABLE IF NOT EXISTS rethink_provider_month (
      id SERIAL PRIMARY KEY,
      rethink_staff_id TEXT NOT NULL,
      month TEXT NOT NULL,
      employee_id INTEGER,
      staff_name_hint TEXT,
      verified_hours NUMERIC DEFAULT 0,
      appointment_count INTEGER DEFAULT 0,
      provisional BOOLEAN NOT NULL DEFAULT TRUE,
      computed_at TEXT,
      UNIQUE (rethink_staff_id, month)
    )`).catch((e) => console.error("rethink_provider_month initTables:", e.message));

    // Distinct values seen in the two fields that drive the filter. This is the
    // whole point of the confirm-before-finalise design: it shows the operator
    // what production actually returns.
    await dbRun(`CREATE TABLE IF NOT EXISTS rethink_observed_values (
      id SERIAL PRIMARY KEY,
      field TEXT NOT NULL,              -- appointmentStatus | staffVerification | clientVerification
      value_raw TEXT,
      value_norm TEXT,
      occurrences INTEGER DEFAULT 0,
      hours_sum NUMERIC DEFAULT 0,
      month TEXT,
      last_seen_at TEXT,
      UNIQUE (field, value_norm, month)
    )`).catch((e) => console.error("rethink_observed_values initTables:", e.message));

    // Supervision denominator columns. Additive: the existing hours_worked
    // column and the payroll upload path are untouched, so nothing breaks if
    // the integration is switched off.
    await dbRun("ALTER TABLE hr_supervision_logs ADD COLUMN IF NOT EXISTS rethink_verified_hours NUMERIC")
      .catch((e) => console.error("rethink_verified_hours column:", e.message));
    await dbRun("ALTER TABLE hr_supervision_logs ADD COLUMN IF NOT EXISTS rethink_synced_at TEXT")
      .catch((e) => console.error("rethink_synced_at column:", e.message));

    // Set when a provider appears in Rethink but no CRM employee matches, so
    // the tracker can show "Rethink Provider Match Needed" instead of guessing.
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS rethink_match_needed BOOLEAN NOT NULL DEFAULT FALSE")
      .catch((e) => console.error("rethink_match_needed column:", e.message));

    // ---- Purpose 2: 97153 authorizations -------------------------------
    // Kept in its own table rather than merged into client_authorizations.
    // That table is keyed on the spreadsheet's (client_name_raw, auth_number,
    // billing_code, effective_date, occurrence) because the .xlsx export has no
    // stable identifier. The API does: clientAuthorizationId. Writing API rows
    // into a name-keyed table would collide with the importer's unique index
    // and make it impossible to tell which source a row came from.
    await dbRun(`CREATE TABLE IF NOT EXISTS rethink_client_authorizations (
      id SERIAL PRIMARY KEY,
      client_authorization_id TEXT NOT NULL UNIQUE,   -- Rethink's stable key; makes re-sync idempotent
      rethink_client_id TEXT,
      client_id INTEGER,                              -- CRM client, NULL when unmatched
      authorization_no TEXT,
      funder TEXT,
      service_line TEXT,
      billing_code TEXT,
      billing_code_id TEXT,
      procedure_code_id TEXT,
      start_date TEXT,
      end_date TEXT,
      status TEXT,
      unit_type TEXT,
      authorized_number_of_units REAL,
      frequency_type TEXT,
      scheduling_goal TEXT,
      diagnosis_code TEXT,
      rendering_provider TEXT,
      authorization_received TEXT,
      standing TEXT,                                  -- current | upcoming | expired
      last_synced_at TEXT,
      created_at TEXT
    )`).catch((e) => console.error("rethink_client_authorizations initTables:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS rethink_auth_client_idx ON rethink_client_authorizations (client_id)").catch(() => {});

    // The permanent CRM client <-> Rethink client mapping, so we stop matching
    // people by name. Additive; clients.rethink_status and
    // clients.rethink_client_created are untouched.
    await dbRun("ALTER TABLE clients ADD COLUMN IF NOT EXISTS rethink_client_id TEXT")
      .catch((e) => console.error("clients.rethink_client_id column:", e.message));
    await dbRun("ALTER TABLE clients ADD COLUMN IF NOT EXISTS rethink_auth_review_needed BOOLEAN NOT NULL DEFAULT FALSE")
      .catch((e) => console.error("clients.rethink_auth_review_needed column:", e.message));
    // Where the authorization dates on the client row came from, so a human can
    // tell a Rethink-sourced date from a hand-typed one at a glance.
    await dbRun("ALTER TABLE clients ADD COLUMN IF NOT EXISTS auth_dates_source TEXT")
      .catch((e) => console.error("clients.auth_dates_source column:", e.message));
    await dbRun("ALTER TABLE clients ADD COLUMN IF NOT EXISTS auth_dates_synced_at TEXT")
      .catch((e) => console.error("clients.auth_dates_synced_at column:", e.message));

    // ---- client matching staging ---------------------------------------
    // Proposals only. Nothing here is authoritative and nothing here writes to
    // clients.rethink_client_id -- an owner has to approve each link. Rebuilt
    // on every scan, so it can be thrown away safely.
    await dbRun(`CREATE TABLE IF NOT EXISTS rethink_client_match_candidates (
      id SERIAL PRIMARY KEY,
      crm_client_id INTEGER NOT NULL,
      rethink_client_id TEXT NOT NULL,
      rethink_first TEXT,
      rethink_last TEXT,
      rethink_dob TEXT,
      confidence TEXT,                  -- high | medium
      reason TEXT,
      scanned_at TEXT,
      UNIQUE (crm_client_id, rethink_client_id)
    )`).catch((e) => console.error("rethink_client_match_candidates initTables:", e.message));
    // Informational only -- shown to the reviewer, never filtered on.
    await dbRun("ALTER TABLE rethink_client_match_candidates ADD COLUMN IF NOT EXISTS rethink_status TEXT")
      .catch((e) => console.error("rethink_status column:", e.message));

    // Audit of every link an owner approved: who, when, and what it replaced.
    await dbRun(`CREATE TABLE IF NOT EXISTS rethink_client_link_log (
      id SERIAL PRIMARY KEY,
      crm_client_id INTEGER NOT NULL,
      rethink_client_id TEXT,
      previous_value TEXT,
      confidence TEXT,
      approved_by TEXT,
      approved_at TEXT
    )`).catch((e) => console.error("rethink_client_link_log initTables:", e.message));
  }

  // ======================= CLIENT MATCHING ===================
  // Names are compared on a normalised form: accents folded, punctuation and
  // suffixes dropped, case and spacing flattened. "O'Brien-Smith Jr." and
  // "obrien smith" become the same string, so a formatting difference never
  // reads as a different child.
  function normName(s) {
    return String(s == null ? "" : s)
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // fold accents: José -> Jose
      .toLowerCase()
      // Apostrophes are REMOVED rather than turned into a space: O'Brien and
      // OBrien are the same surname, and splitting it produces a phantom
      // given-name token that makes the two records look like different
      // children. Hyphens and everything else still become spaces.
      .replace(/['’]/g, "")
      .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, " ")
      .replace(/[^a-z ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // The CRM stores one child_name; Rethink gives first and last separately.
  // Last token is the surname, everything before it the given name(s), which
  // handles both "Ana Maria Lopez" and "Lopez" without inventing a middle-name
  // rule the data does not support.
  function splitName(full) {
    const parts = normName(full).split(" ").filter(Boolean);
    if (!parts.length) return { first: "", last: "" };
    if (parts.length === 1) return { first: parts[0], last: "" };
    return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
  }

  // Rethink client status decides whether a high-confidence match may be
  // auto-approvable, separately from how confident the NAME match is. A record
  // can be a perfect first + last + DOB hit and still be the wrong thing to
  // link, because it is a closed or not-yet-accepted record.
  //
  //   Active             -> may reach Ready to Link
  //   Pending Acceptance -> always Needs Review
  //   Inactive           -> always Needs Review
  //
  // The allowlist is deliberately positive: any status we have not seen -- a
  // blank, or a value Rethink adds later -- lands in Needs Review rather than
  // being auto-approved on the assumption it is harmless. Nothing is ever
  // excluded from the scan; every candidate stays visible for a human to judge.
  const READY_STATUSES = ["active"];
  const statusAllowsReady = (s) => READY_STATUSES.includes(norm(s));
  function whyStatusBlocks(s) {
    const v = String(s == null ? "" : s).trim();
    if (!v) return "Rethink reports no status for this record";
    return `Rethink status is "${v}"`;
  }

  // The documented GET /api/Clients schema. These are the exact property names
  // from the DWH Swagger, not a guess and not auto-detected -- earlier versions
  // sniffed the keys because the schema had not been published to us.
  const CLIENT_FIELDS = {
    id: "clientId",
    first: "firstName",
    last: "lastName",
    dob: "dateOfBirth",
    status: "status",
  };

  // The documented names are used directly; this only checks they are actually
  // present, so a schema change surfaces as a clear error naming the keys that
  // came back instead of silently matching nobody. Keys are structure, not PHI.
  // `status` is informational on the review screen, so it is not required.
  const REQUIRED_CLIENT_FIELDS = ["id", "first", "last", "dob"];
  function validateClientFields(sampleRow) {
    const keys = Object.keys(sampleRow || {});
    const missing = REQUIRED_CLIENT_FIELDS
      .filter((role) => !keys.includes(CLIENT_FIELDS[role]))
      .map((role) => CLIENT_FIELDS[role]);
    return { missing, keys_seen: keys };
  }

  // Pull the Rethink client list, compare against active CRM clients, and store
  // proposals. Writes nothing to clients.rethink_client_id -- ever.
  async function scanClientMatches() {
    if (!client.configured()) {
      return { ok: false, error: "Rethink credentials are not configured.", kind: "config" };
    }

    client.log("sync_start", { kind: "client_match_scan", endpoint: DWH_CLIENTS });

    // Two attempts, on purpose, so one run settles the question rather than
    // costing another deploy: the windowed call first, and if it comes back
    // empty, the original no-parameter call. Whichever returns rows is the
    // answer, and the log says which it was. The second attempt is skipped
    // entirely once the first produces data, so the steady state is one request.
    const attempts = [
      { label: "with_date_window", params: { From: CLIENTS_FROM, To: today() } },
      { label: "no_parameters", params: {} },
    ];

    let fetched = null;
    let usedAttempt = null;
    try {
      for (const attempt of attempts) {
        const result = await client.dwhGetAllPages(DWH_CLIENTS, attempt.params, { nowMs: nowMs(), pageSize: 500 });
        client.log("clients_attempt", {
          endpoint: DWH_CLIENTS, attempt: attempt.label,
          params_sent: Object.keys(attempt.params).sort().join(",") || "(none)",
          rows: (result.rows || []).length,
        });
        if ((result.rows || []).length) { fetched = result; usedAttempt = attempt.label; break; }
        if (!fetched) fetched = result; // keep the last empty result for reporting
      }
    } catch (e) {
      client.log("sync_failed", {
        kind: "client_match_scan", endpoint: e.endpoint || DWH_CLIENTS, status: e.status,
        stage: e.stage, error_kind: e.kind, error_name: e.name, upstream: e.upstream, error: e.message,
      });
      return {
        ok: false, kind: e.kind || "http", status: e.status || null, detail_in_server_logs: true,
        error: e.safe || client.redact(e.message),
      };
    }

    const rows = fetched.rows || [];
    if (!rows.length) {
      client.log("clients_empty", {
        endpoint: DWH_CLIENTS, attempts: attempts.map((a) => a.label).join(","), from: CLIENTS_FROM, to: today(),
      });
      return {
        ok: false, kind: "empty", detail_in_server_logs: true,
        error: `The Rethink "${DWH_CLIENTS}" endpoint returned HTTP 200 with no clients, both with a ${CLIENTS_FROM}–${today()} date window and with no parameters at all. The endpoint is reachable and authenticated, so this is a query or permission question on Rethink's side rather than a connection problem.`,
      };
    }
    client.log("clients_loaded", { endpoint: DWH_CLIENTS, attempt: usedAttempt, rows: rows.length });

    const { missing, keys_seen } = validateClientFields(rows[0]);
    if (missing.length) {
      return {
        ok: false, kind: "field_map",
        error: `The Rethink client response is missing ${missing.join(", ")}. Keys returned: ${keys_seen.join(", ")}.`,
        keys_seen,
      };
    }

    const crmClients = await dbAll(
      "SELECT id, child_name, dob, rethink_client_id FROM clients WHERE stage NOT IN ('discharged','not_moving_forward')"
    ).catch(() => []);

    // Index the Rethink side once, reading the documented fields directly.
    const F = CLIENT_FIELDS;
    const rethinkClients = rows.map((r) => ({
      id: String(r[F.id] == null ? "" : r[F.id]).trim(),
      first: normName(r[F.first]),
      last: normName(r[F.last]),
      dob: dateOnly(r[F.dob]),
      rawFirst: r[F.first] == null ? "" : String(r[F.first]),
      rawLast: r[F.last] == null ? "" : String(r[F.last]),
      // Shown to the reviewer so they do not link a child to a closed Rethink
      // record. Not filtered on: the status vocabulary is not documented to us,
      // and silently dropping clients on a guessed value is how a real child
      // goes missing from the tracker.
      status: r[F.status] == null ? "" : String(r[F.status]),
    })).filter((r) => r.id);

    await dbRun("DELETE FROM rethink_client_match_candidates").catch(() => {});

    let ready = 0, review = 0, none = 0, alreadyLinked = 0;

    for (const c of crmClients) {
      if (c.rethink_client_id && String(c.rethink_client_id).trim()) { alreadyLinked++; continue; }

      const { first, last } = splitName(c.child_name);
      const dob = dateOnly(c.dob);
      const candidates = [];

      for (const r of rethinkClients) {
        const firstOk = !!first && !!r.first && first === r.first;
        const lastOk = !!last && !!r.last && last === r.last;
        const dobOk = !!dob && !!r.dob && dob === r.dob;
        const dobKnown = !!dob && !!r.dob;

        let confidence = null, reason = "";
        if (firstOk && lastOk && dobOk) { confidence = "high"; reason = "first + last + DOB"; }
        else if (firstOk && lastOk && !dobKnown) { confidence = "medium"; reason = "first + last, DOB missing on one side"; }
        else if (firstOk && lastOk && !dobOk) { confidence = "medium"; reason = "first + last match but DOB differs"; }
        else if (lastOk && dobOk) { confidence = "medium"; reason = "last + DOB, first name differs"; }
        else if (firstOk && dobOk) { confidence = "medium"; reason = "first + DOB, last name differs"; }
        if (confidence) candidates.push({ r, confidence, reason });
      }

      for (const cand of candidates) {
        await dbRun(
          `INSERT INTO rethink_client_match_candidates
             (crm_client_id, rethink_client_id, rethink_first, rethink_last, rethink_dob, rethink_status, confidence, reason, scanned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (crm_client_id, rethink_client_id) DO UPDATE SET
             rethink_status = EXCLUDED.rethink_status, confidence = EXCLUDED.confidence,
             reason = EXCLUDED.reason, scanned_at = EXCLUDED.scanned_at`,
          [c.id, cand.r.id, cand.r.rawFirst, cand.r.rawLast, cand.r.dob, cand.r.status, cand.confidence, cand.reason, nowISO()]
        ).catch(() => {});
      }

      // "Ready to Link" means exactly one high-confidence candidate, no other
      // candidate of any kind competing with it, AND a Rethink status that
      // permits auto-approval. Anything else is a human decision.
      const highs = candidates.filter((x) => x.confidence === "high");
      const uncontestedHigh = highs.length === 1 && candidates.length === 1;
      if (uncontestedHigh && statusAllowsReady(highs[0].r.status)) ready++;
      else if (candidates.length) review++;
      else none++;
    }

    return {
      ok: true,
      rethink_clients: rethinkClients.length,
      crm_clients_considered: crmClients.length - alreadyLinked,
      already_linked: alreadyLinked,
      ready_to_link: ready,
      needs_review: review,
      no_match: none,
      field_map: CLIENT_FIELDS,
    };
  }

  // The review screen's data: one entry per unlinked active CRM client.
  async function clientMatchReview() {
    const crmClients = await dbAll(
      `SELECT id, child_name, dob, rethink_client_id FROM clients
        WHERE stage NOT IN ('discharged','not_moving_forward') ORDER BY child_name`
    ).catch(() => []);
    const cands = await dbAll(
      "SELECT * FROM rethink_client_match_candidates ORDER BY crm_client_id, confidence, rethink_last"
    ).catch(() => []);
    const byClient = new Map();
    for (const c of cands) {
      const list = byClient.get(c.crm_client_id) || [];
      list.push(c);
      byClient.set(c.crm_client_id, list);
    }

    const items = crmClients.map((c) => {
      const list = byClient.get(c.id) || [];
      const highs = list.filter((x) => x.confidence === "high");
      const uncontestedHigh = highs.length === 1 && list.length === 1;
      const statusOk = uncontestedHigh && statusAllowsReady(highs[0].rethink_status);
      let status;
      if (c.rethink_client_id && String(c.rethink_client_id).trim()) status = "linked";
      else if (statusOk) status = "ready";
      else if (list.length) status = "review";
      else status = "no_match";
      return {
        crm_client_id: c.id,
        crm_name: c.child_name,
        crm_dob: dateOnly(c.dob),
        linked_rethink_client_id: c.rethink_client_id || null,
        status,
        candidates: list.map((x) => ({
          rethink_client_id: x.rethink_client_id,
          name: `${x.rethink_first || ""} ${x.rethink_last || ""}`.trim(),
          dob: x.rethink_dob,
          status: x.rethink_status || null,
          confidence: x.confidence,
          reason: x.reason,
          // Why an otherwise-perfect match is still sitting in review. Without
          // this the reviewer sees "first + last + DOB" next to "Needs Review"
          // and reasonably concludes the page is broken.
          status_blocks_ready: x.confidence === "high" && !statusAllowsReady(x.rethink_status)
            ? whyStatusBlocks(x.rethink_status) : null,
        })),
      };
    });

    const last = await dbGet("SELECT MAX(scanned_at) AS m FROM rethink_client_match_candidates").catch(() => null);
    return {
      items,
      last_scanned_at: (last && last.m) || null,
      counts: {
        linked: items.filter((i) => i.status === "linked").length,
        ready: items.filter((i) => i.status === "ready").length,
        review: items.filter((i) => i.status === "review").length,
        no_match: items.filter((i) => i.status === "no_match").length,
      },
    };
  }

  // Approve one proposed link. An existing id is never replaced without an
  // explicit confirm, and the previous value is kept in the audit log either way.
  async function approveClientLink(crmClientId, rethinkClientId, opts = {}, actor = "unknown") {
    const c = await dbGet("SELECT id, rethink_client_id FROM clients WHERE id = ?", [crmClientId]).catch(() => null);
    if (!c) return { ok: false, error: "That client no longer exists." };

    const incoming = String(rethinkClientId == null ? "" : rethinkClientId).trim();
    if (!incoming) return { ok: false, error: "No Rethink client ID given." };

    const existing = c.rethink_client_id ? String(c.rethink_client_id).trim() : "";
    if (existing && existing !== incoming && !opts.confirm_overwrite) {
      return {
        ok: false, needs_confirmation: true, existing_value: existing,
        error: `This client is already linked to Rethink ID ${existing}. Confirm to replace it.`,
      };
    }
    if (existing === incoming) return { ok: true, unchanged: true };

    // Refuse to point two CRM clients at the same Rethink client by accident.
    const clash = await dbGet(
      "SELECT id, child_name FROM clients WHERE rethink_client_id = ? AND id <> ?", [incoming, crmClientId]
    ).catch(() => null);
    if (clash && !opts.confirm_duplicate) {
      return {
        ok: false, needs_confirmation: true, duplicate_of: { id: clash.id, name: clash.child_name },
        error: `Rethink ID ${incoming} is already linked to another client. Confirm to link it anyway.`,
      };
    }

    const cand = await dbGet(
      "SELECT confidence FROM rethink_client_match_candidates WHERE crm_client_id = ? AND rethink_client_id = ?",
      [crmClientId, incoming]
    ).catch(() => null);

    await dbRun("UPDATE clients SET rethink_client_id = ? WHERE id = ?", [incoming, crmClientId]);
    await dbRun(
      `INSERT INTO rethink_client_link_log (crm_client_id, rethink_client_id, previous_value, confidence, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [crmClientId, incoming, existing || null, (cand && cand.confidence) || "manual", actor, nowISO()]
    ).catch(() => {});
    await dbRun("DELETE FROM rethink_client_match_candidates WHERE crm_client_id = ?", [crmClientId]).catch(() => {});

    return { ok: true, crm_client_id: crmClientId, rethink_client_id: incoming, replaced: existing || null };
  }


  // ======================= CONFIG ============================
  async function getConfig() {
    const row = await dbGet("SELECT * FROM rethink_config WHERE id = 1").catch(() => null);
    const parse = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
    return {
      filter_confirmed: !!(row && (row.filter_confirmed === true || row.filter_confirmed === "t")),
      completed_statuses: parse(row && row.completed_statuses),
      verified_values: parse(row && row.verified_values),
      require_staff_verification: !row || row.require_staff_verification === true || row.require_staff_verification === "t",
      sync_interval_minutes: (row && Number(row.sync_interval_minutes)) || 240,
      confirmed_by: (row && row.confirmed_by) || null,
      confirmed_at: (row && row.confirmed_at) || null,
    };
  }

  // ======================= FILTERING =========================
  // Provisional heuristic, used ONLY to show a preview total before the filter
  // is confirmed. It never writes to the supervision tracker. It exists so the
  // first sync produces something an operator can sanity-check against Rethink's
  // own reporting, not so it can be trusted.
  const PROVISIONAL_COMPLETED = /^(completed|complete|finalized|finalised|rendered)$/;
  const PROVISIONAL_VERIFIED = /^(true|verified|yes|y|1|approved|signed)$/;

  function decide(row, cfg) {
    const status = norm(row.appointmentStatus);
    const staffVer = norm(row.staffVerification);

    const statusOk = cfg.filter_confirmed
      ? cfg.completed_statuses.map(norm).includes(status)
      : PROVISIONAL_COMPLETED.test(status);

    const verifiedOk = !cfg.require_staff_verification ? true : (cfg.filter_confirmed
      ? cfg.verified_values.map(norm).includes(staffVer)
      : PROVISIONAL_VERIFIED.test(staffVer));

    return { statusOk, verifiedOk, counts: statusOk && verifiedOk };
  }

  // ======================= PROVIDER MATCHING =================
  // Permanent identifier first, and only ever a permanent identifier. The
  // payroll import already matches on hr_employees.rethink_id, so the same
  // column is the join for the API. A staffId with no match is surfaced, never
  // guessed at by name -- the whole reason names are unsafe here is that two
  // RBTs called "J. Martinez" produce a silently wrong compliance record.
  async function buildStaffMap() {
    const emps = await dbAll(
      "SELECT id, name, rethink_id FROM hr_employees WHERE COALESCE(status,'active') <> 'terminated'"
    ).catch(() => []);
    const byRethinkId = new Map();
    for (const e of emps) {
      if (e.rethink_id != null && String(e.rethink_id).trim() !== "") {
        byRethinkId.set(String(e.rethink_id).trim(), e);
      }
    }
    return { byRethinkId, employees: emps };
  }

  // ======================= SYNC ==============================
  // Window for the month: from the first of the month to the earlier of the
  // month end and today, so future appointments are never requested at all.
  function monthWindow(month) {
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = `${month}-${String(lastDay).padStart(2, "0")}`;
    const t = today();
    return { from: `${month}-01`, to: end > t ? t : end };
  }

  async function syncSupervisionHours(triggeredBy = "scheduled", monthArg) {
    const month = /^\d{4}-\d{2}$/.test(monthArg || "") ? monthArg : thisMonth();
    const startedAt = nowISO();
    const warnings = [];

    const logRow = await dbGet(
      `INSERT INTO rethink_sync_log (kind, month, started_at, status, triggered_by)
       VALUES ('supervision_hours', ?, ?, 'running', ?) RETURNING id`,
      [month, startedAt, triggeredBy]
    ).catch(() => null);
    const logId = logRow && logRow.id;

    client.log("sync_start", { kind: "supervision_hours", month, triggered_by: triggeredBy });

    const fail = async (message, kind, err) => {
      // Everything useful goes to stdout for Railway; the browser gets only the
      // sanitised line. The upstream body in particular stays server-side --
      // we cannot promise an arbitrary upstream body is free of PHI.
      client.log("sync_failed", {
        kind: "supervision_hours", month, error_kind: kind,
        status: err && err.status, endpoint: err && err.endpoint, stage: err && err.stage,
        error_name: err && err.name, upstream: err && err.upstream, error: message,
      });
      // A failed sync leaves every previously synced value exactly as it was.
      // Nothing is blanked, nothing is zeroed.
      await dbRun(
        "UPDATE rethink_sync_log SET finished_at = ?, status = 'failed', error = ?, error_kind = ?, warnings = ? WHERE id = ?",
        [nowISO(), client.redact(message).slice(0, 500), kind || "error", JSON.stringify(warnings), logId]
      ).catch(() => {});
      return {
        ok: false,
        error: (err && err.safe) || client.redact(message),
        kind: kind || "error", status: (err && err.status) || null, month,
        detail_in_server_logs: true,
      };
    };

    if (!client.configured()) {
      return fail("Rethink credentials are not configured. Add RETHINK_CLIENT_ID and RETHINK_CLIENT_SECRET.", "config",
        { safe: "Rethink credentials are not configured on the server." });
    }

    const cfg = await getConfig();
    const { from, to } = monthWindow(month);

    // Cancelled and deleted appointments are excluded at the source rather than
    // filtered out here, so they never enter the process at all.
    let fetched;
    try {
      fetched = await client.dwhGetAllPages(DWH_APPOINTMENTS, {
        From: from,
        To: to,
        FilterByAppointmentDate: true,
        IncludeDeleted: false,
        IncludeCanceled: false,
      }, { nowMs: nowMs(), pageSize: 500 });
    } catch (e) {
      return fail(e.message, e.kind || "http", e);
    }

    if (fetched.truncated) {
      warnings.push(`Stopped at the page limit for ${month}; the month may be incomplete.`);
    }

    const rows = fetched.rows || [];
    const { byRethinkId } = await buildStaffMap();

    // ---- aggregate ------------------------------------------------------
    const perStaff = new Map();      // staffId -> { hours, count }
    const observed = new Map();      // `${field}|${norm}` -> { field, raw, norm, n, hours }
    let counted = 0, skippedNoDuration = 0, skippedFuture = 0;
    const cutoff = today();

    const observe = (field, raw, hours) => {
      const key = `${field}|${norm(raw)}`;
      const cur = observed.get(key) || { field, raw: raw === undefined ? null : raw, norm: norm(raw), n: 0, hours: 0 };
      cur.n += 1; cur.hours += hours;
      observed.set(key, cur);
    };

    for (const row of rows) {
      // One bad row must not take down the month.
      try {
        const apptDate = String(row.appointmentDate || "").slice(0, 10);
        // Belt and braces: the From/To window should already exclude these.
        if (apptDate && apptDate > cutoff) { skippedFuture++; continue; }

        const hours = num(row.actualDurationHours);
        observe("appointmentStatus", row.appointmentStatus, hours);
        observe("staffVerification", row.staffVerification, hours);
        observe("clientVerification", row.clientVerification, hours);

        const verdict = decide(row, cfg);
        if (!verdict.counts) continue;

        // Only actual duration is ever summed. A completed, verified session
        // with no actualDurationHours is reported rather than back-filled from
        // the scheduled duration, which would inflate the denominator.
        if (!(hours > 0)) { skippedNoDuration++; continue; }

        const staffId = String(row.staffId == null ? "" : row.staffId).trim();
        if (!staffId) { warnings.push("An appointment had no staffId and was skipped."); continue; }

        const cur = perStaff.get(staffId) || { hours: 0, count: 0 };
        cur.hours += hours; cur.count += 1;
        perStaff.set(staffId, cur);
        counted++;
      } catch (e) {
        warnings.push(`A row could not be read: ${client.redact(e.message)}`);
      }
    }

    if (skippedNoDuration) {
      warnings.push(`${skippedNoDuration} completed/verified appointment(s) had no actualDurationHours and were not counted.`);
    }
    if (skippedFuture) warnings.push(`${skippedFuture} future appointment(s) were excluded.`);

    // ---- persist observed values ---------------------------------------
    // Replaced per month so the panel always reflects the latest sync.
    await dbRun("DELETE FROM rethink_observed_values WHERE month = ?", [month]).catch(() => {});
    for (const o of observed.values()) {
      await dbRun(
        `INSERT INTO rethink_observed_values (field, value_raw, value_norm, occurrences, hours_sum, month, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (field, value_norm, month) DO UPDATE SET
           occurrences = EXCLUDED.occurrences, hours_sum = EXCLUDED.hours_sum, last_seen_at = EXCLUDED.last_seen_at`,
        [o.field, o.raw == null ? null : String(o.raw).slice(0, 200), o.norm, o.n, round2(o.hours), month, nowISO()]
      ).catch((e) => warnings.push(`Could not record observed value: ${e.message}`));
    }

    // ---- persist per-provider aggregate --------------------------------
    // Wholesale replacement for the month is what guarantees a repeat sync
    // cannot duplicate or double-count.
    await dbRun("DELETE FROM rethink_provider_month WHERE month = ?", [month]).catch(() => {});

    let matched = 0, unmatched = 0;
    const unmatchedIds = [];
    const provisional = !cfg.filter_confirmed;

    for (const [staffId, agg] of perStaff.entries()) {
      const emp = byRethinkId.get(staffId) || null;
      if (emp) matched++; else { unmatched++; unmatchedIds.push(staffId); }

      await dbRun(
        `INSERT INTO rethink_provider_month
           (rethink_staff_id, month, employee_id, verified_hours, appointment_count, provisional, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (rethink_staff_id, month) DO UPDATE SET
           employee_id = EXCLUDED.employee_id, verified_hours = EXCLUDED.verified_hours,
           appointment_count = EXCLUDED.appointment_count, provisional = EXCLUDED.provisional,
           computed_at = EXCLUDED.computed_at`,
        [staffId, month, emp ? emp.id : null, round2(agg.hours), agg.count, provisional, nowISO()]
      ).catch((e) => warnings.push(`Could not store hours for a provider: ${e.message}`));
    }

    // ---- flag providers needing a match --------------------------------
    // Cleared and re-set each run so a match made in the CRM clears the flag on
    // the next sync without anyone having to dismiss it.
    await dbRun("UPDATE hr_employees SET rethink_match_needed = FALSE WHERE rethink_match_needed = TRUE").catch(() => {});
    if (unmatched) {
      warnings.push(`${unmatched} Rethink provider(s) had no matching CRM employee: ${unmatchedIds.slice(0, 20).join(", ")}`);
    }
    // A SUPERVISED employee with no rethink_id cannot ever be matched, so they
    // are flagged directly on their record.
    //
    // "Supervised" is the supervision tracker's own definition, asked for
    // rather than re-derived here. The previous SQL used
    // COALESCE(supervision_required, TRUE), and supervision_required is NULL
    // for nearly everyone -- it means "decide from the job title" -- so that
    // test silently resolved to TRUE for the whole company and the warning
    // named BCBAs, the clinical director and the owner alongside actual RBTs.
    //
    // This only scopes the WARNING. Staff outside the supervision population
    // keep their Rethink IDs and their mapping for every other workflow, and
    // their hours are still synced -- see the denominator write below, which
    // is keyed on a matched provider and knows nothing about supervision.
    const unlinked = await dbAll(
      `SELECT id, name, role_title, supervision_required FROM hr_employees
        WHERE COALESCE(status,'active') <> 'terminated'
          AND (rethink_id IS NULL OR TRIM(rethink_id) = '')`
    ).catch(() => []);
    const needingMatch = unlinked.filter((e) => isSupervisionTracked(e));
    for (const e of needingMatch) {
      await dbRun("UPDATE hr_employees SET rethink_match_needed = TRUE WHERE id = ?", [e.id])
        .catch((err) => warnings.push(`Could not flag employee ${e.id}: ${err.message}`));
    }

    // ---- write the supervision denominator ------------------------------
    // Only ever on a confirmed filter. A provisional number is shown in the
    // panel but never becomes a compliance figure.
    let wrote = false;
    if (cfg.filter_confirmed) {
      for (const [staffId, agg] of perStaff.entries()) {
        const emp = byRethinkId.get(staffId);
        if (!emp) continue;
        const hours = round2(agg.hours);
        if (!(hours >= 0)) continue; // never write a non-number over a good one
        await dbRun(
          `INSERT INTO hr_supervision_logs
             (employee_id, month, entries, hours_worked, rethink_verified_hours, rethink_synced_at, created_at, updated_at)
           VALUES (?, ?, '[]', ?, ?, ?, ?, ?)
           ON CONFLICT (employee_id, month) DO UPDATE SET
             rethink_verified_hours = EXCLUDED.rethink_verified_hours,
             rethink_synced_at = EXCLUDED.rethink_synced_at,
             updated_at = EXCLUDED.updated_at`,
          [emp.id, month, hours, hours, nowISO(), nowISO(), nowISO()]
        ).catch((e) => warnings.push(`Could not write supervision hours for employee ${emp.id}: ${e.message}`));
        wrote = true;
      }
    } else {
      warnings.push("Filter not confirmed yet -- hours are provisional and were NOT written to the supervision tracker.");
    }

    const status = warnings.length ? "partial" : "success";
    await dbRun(
      `UPDATE rethink_sync_log SET finished_at = ?, status = ?, appointments_seen = ?, appointments_counted = ?,
         providers_matched = ?, providers_unmatched = ?, hours_written = ?, warnings = ? WHERE id = ?`,
      [nowISO(), status, rows.length, counted, matched, unmatched, wrote, JSON.stringify(warnings.slice(0, 50)), logId]
    ).catch(() => {});

    return {
      ok: true, month, status,
      appointments_seen: rows.length,
      appointments_counted: counted,
      providers_matched: matched,
      providers_unmatched: unmatched,
      filter_confirmed: cfg.filter_confirmed,
      hours_written: wrote,
      warnings,
    };
  }

  // ======================= 97153 AUTHORIZATIONS ==============
  // Is this row the CPT we track? billingCode is the primary test. When it is
  // blank -- which the field list warns is possible -- we fall back to the
  // configured code ids rather than assuming a code we cannot see.
  function is97153(row) {
    const code = String(row.billingCode == null ? "" : row.billingCode).trim();
    if (code) return code === TARGET_BILLING_CODE;
    if (!TARGET_CODE_IDS.length) return false;
    const bId = String(row.billingCodeId == null ? "" : row.billingCodeId).trim();
    const pId = String(row.procedureCodeId == null ? "" : row.procedureCodeId).trim();
    return (bId && TARGET_CODE_IDS.includes(bId)) || (pId && TARGET_CODE_IDS.includes(pId));
  }

  const dateOnly = (v) => {
    const s = String(v == null ? "" : v).trim();
    if (!s) return null;
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  };

  // current | upcoming | expired | unknown, per the rules the CRM was given.
  function standingOf(startDate, endDate, todayStr) {
    if (!startDate || !endDate) return "unknown";
    if (startDate > todayStr) return "upcoming";
    if (endDate < todayStr) return "expired";
    return "current";
  }

  async function syncAuthorizations(triggeredBy = "scheduled") {
    const startedAt = nowISO();
    const warnings = [];
    const t = today();

    const logRow = await dbGet(
      `INSERT INTO rethink_sync_log (kind, month, started_at, status, triggered_by)
       VALUES ('authorizations', ?, ?, 'running', ?) RETURNING id`,
      [thisMonth(), startedAt, triggeredBy]
    ).catch(() => null);
    const logId = logRow && logRow.id;

    client.log("sync_start", { kind: "authorizations", triggered_by: triggeredBy, endpoint: DWH_AUTHORIZATIONS });

    const fail = async (message, kind, err) => {
      client.log("sync_failed", {
        kind: "authorizations", error_kind: kind,
        status: err && err.status, endpoint: err && err.endpoint, stage: err && err.stage,
        error_name: err && err.name, upstream: err && err.upstream, error: message,
      });
      // Nothing is blanked. Every previously synced authorization value and
      // every client auth date stays exactly as the last good sync left it.
      await dbRun(
        "UPDATE rethink_sync_log SET finished_at = ?, status = 'failed', error = ?, error_kind = ?, warnings = ? WHERE id = ?",
        [nowISO(), client.redact(message).slice(0, 500), kind || "error", JSON.stringify(warnings), logId]
      ).catch(() => {});
      return {
        ok: false,
        error: (err && err.safe) || client.redact(message),
        kind: kind || "error", status: (err && err.status) || null,
        detail_in_server_logs: true,
      };
    };

    if (!client.configured()) {
      return fail("Rethink credentials are not configured. Add RETHINK_CLIENT_ID and RETHINK_CLIENT_SECRET.", "config",
        { safe: "Rethink credentials are not configured on the server." });
    }

    let fetched;
    try {
      fetched = await client.dwhGetAllPages(DWH_AUTHORIZATIONS, {}, { nowMs: nowMs(), pageSize: 500 });
    } catch (e) {
      // A 404 here almost always means the configured path is wrong, so the
      // path travels to the browser too. It is configuration, not a secret,
      // and it is the difference between "something failed" and "fix this".
      if (e.status === 404) {
        e.safe = `${e.safe || client.redact(e.message)} — the configured path is "${DWH_AUTHORIZATIONS}"; set RETHINK_AUTH_ENDPOINT if that is wrong.`;
      }
      return fail(
        `${e.message} (endpoint "${DWH_AUTHORIZATIONS}" -- set RETHINK_AUTH_ENDPOINT if that path is wrong)`,
        e.kind || "http", e
      );
    }

    const rows = fetched.rows || [];
    if (fetched.truncated) warnings.push("Stopped at the authorization page limit; the list may be incomplete.");

    // Active CRM clients only. "Active" follows the pipeline convention used
    // everywhere else in the CRM: everything except the two closed stages.
    const clients = await dbAll(
      "SELECT id, rethink_client_id FROM clients WHERE stage NOT IN ('discharged','not_moving_forward')"
    ).catch(() => []);
    const byRethinkClientId = new Map();
    for (const c of clients) {
      if (c.rethink_client_id != null && String(c.rethink_client_id).trim() !== "") {
        byRethinkClientId.set(String(c.rethink_client_id).trim(), c);
      }
    }

    let seen97153 = 0, upserted = 0, unmatched = 0, skippedDeleted = 0;
    const unmatchedClientIds = new Set();
    const perClient = new Map(); // crm client id -> rows[]

    for (const row of rows) {
      try {
        // isDeleted is not in the documented field list but the selection rules
        // call for it, so it is honoured when present and ignored when absent.
        if (row.isDeleted === true || norm(row.isDeleted) === "true") { skippedDeleted++; continue; }
        if (!is97153(row)) continue;
        seen97153++;

        const authId = String(row.clientAuthorizationId == null ? "" : row.clientAuthorizationId).trim();
        if (!authId) { warnings.push("An authorization row had no clientAuthorizationId and was skipped."); continue; }

        const rClientId = String(row.clientId == null ? "" : row.clientId).trim();
        const crm = rClientId ? byRethinkClientId.get(rClientId) : null;
        if (!crm) { unmatched++; if (rClientId) unmatchedClientIds.add(rClientId); }

        const startDate = dateOnly(row.startDate);
        const endDate = dateOnly(row.endDate);
        if (!startDate || !endDate) {
          warnings.push(`Authorization ${authId} is missing a start or end date.`);
        }
        const standing = standingOf(startDate, endDate, t);

        await dbRun(
          `INSERT INTO rethink_client_authorizations
             (client_authorization_id, rethink_client_id, client_id, authorization_no, funder, service_line,
              billing_code, billing_code_id, procedure_code_id, start_date, end_date, status, unit_type,
              authorized_number_of_units, frequency_type, scheduling_goal, diagnosis_code, rendering_provider,
              authorization_received, standing, last_synced_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (client_authorization_id) DO UPDATE SET
             rethink_client_id = EXCLUDED.rethink_client_id, client_id = EXCLUDED.client_id,
             authorization_no = EXCLUDED.authorization_no, funder = EXCLUDED.funder,
             service_line = EXCLUDED.service_line, billing_code = EXCLUDED.billing_code,
             billing_code_id = EXCLUDED.billing_code_id, procedure_code_id = EXCLUDED.procedure_code_id,
             start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date, status = EXCLUDED.status,
             unit_type = EXCLUDED.unit_type, authorized_number_of_units = EXCLUDED.authorized_number_of_units,
             frequency_type = EXCLUDED.frequency_type, scheduling_goal = EXCLUDED.scheduling_goal,
             diagnosis_code = EXCLUDED.diagnosis_code, rendering_provider = EXCLUDED.rendering_provider,
             authorization_received = EXCLUDED.authorization_received, standing = EXCLUDED.standing,
             last_synced_at = EXCLUDED.last_synced_at`,
          [authId, rClientId || null, crm ? crm.id : null,
           row.authorizationNo == null ? null : String(row.authorizationNo),
           row.funder == null ? null : String(row.funder),
           row.serviceLine == null ? null : String(row.serviceLine),
           row.billingCode == null ? null : String(row.billingCode),
           row.billingCodeId == null ? null : String(row.billingCodeId),
           row.procedureCodeId == null ? null : String(row.procedureCodeId),
           startDate, endDate,
           row.status == null ? null : String(row.status),
           row.unitType == null ? null : String(row.unitType),
           Number.isFinite(parseFloat(row.authorizedNumberOfUnits)) ? parseFloat(row.authorizedNumberOfUnits) : null,
           row.frequencyType == null ? null : String(row.frequencyType),
           row.schedulingGoal == null ? null : String(row.schedulingGoal),
           row.diagnosisCode == null ? null : String(row.diagnosisCode),
           row.renderingProvider == null ? null : String(row.renderingProvider),
           row.authorizationReceived == null ? null : String(row.authorizationReceived),
           standing, nowISO(), nowISO()]
        );
        upserted++;

        if (crm) {
          const list = perClient.get(crm.id) || [];
          list.push({ authId, startDate, endDate, standing });
          perClient.set(crm.id, list);
        }
      } catch (e) {
        // One bad authorization must not abort the whole sync.
        warnings.push(`An authorization row failed: ${client.redact(e.message)}`);
      }
    }

    if (unmatchedClientIds.size) {
      warnings.push(`${unmatchedClientIds.size} Rethink client(s) with a 97153 authorization had no CRM match.`);
    }
    if (skippedDeleted) warnings.push(`${skippedDeleted} deleted authorization(s) ignored.`);

    // ---- choose the applicable authorization and drive the alert system --
    // This is the disconnect fix. The existing expiration alert engine reads
    // clients.auth_start_date / clients.auth_expiration_date; until now nothing
    // populated them from real authorization data. We write the applicable
    // 97153 dates there and leave the alert engine, its 60/30/14/7/0 day
    // thresholds and its emails completely untouched.
    let datesWritten = 0, flaggedForReview = 0;
    await dbRun("UPDATE clients SET rethink_auth_review_needed = FALSE WHERE rethink_auth_review_needed = TRUE").catch(() => {});

    for (const [crmClientId, list] of perClient.entries()) {
      try {
        const current = list.filter((a) => a.standing === "current");

        // Overlapping current authorizations are never resolved by picking one.
        if (current.length > 1) {
          await dbRun("UPDATE clients SET rethink_auth_review_needed = TRUE WHERE id = ?", [crmClientId]).catch(() => {});
          flaggedForReview++;
          warnings.push(`Client ${crmClientId} has ${current.length} overlapping current 97153 authorizations -- flagged for review, dates not changed.`);
          continue;
        }

        // Preference order encodes "do not overwrite a valid current
        // authorization with an old expired one": a current auth always wins,
        // and an expired one is only used when there is nothing current. An
        // upcoming auth is retained in the table as upcoming but does not drive
        // the expiration alerts, which are about the authorization in force.
        let chosen = current[0] || null;
        if (!chosen) {
          const expired = list.filter((a) => a.standing === "expired" && a.endDate)
            .sort((a, b) => (a.endDate < b.endDate ? 1 : -1));
          chosen = expired[0] || null; // most recently expired, so the alert system flags it
        }
        if (!chosen || !chosen.startDate || !chosen.endDate) continue;

        await dbRun(
          `UPDATE clients SET auth_start_date = ?, auth_expiration_date = ?,
             auth_dates_source = 'rethink', auth_dates_synced_at = ? WHERE id = ?`,
          [chosen.startDate, chosen.endDate, nowISO(), crmClientId]
        );
        datesWritten++;
      } catch (e) {
        warnings.push(`Could not apply authorization dates for client ${crmClientId}: ${client.redact(e.message)}`);
      }
    }

    const status = warnings.length ? "partial" : "success";
    await dbRun(
      `UPDATE rethink_sync_log SET finished_at = ?, status = ?, appointments_seen = ?, appointments_counted = ?,
         providers_matched = ?, providers_unmatched = ?, hours_written = ?, warnings = ? WHERE id = ?`,
      [nowISO(), status, rows.length, seen97153, datesWritten, unmatched, false,
       JSON.stringify(warnings.slice(0, 50)), logId]
    ).catch(() => {});

    return {
      ok: true, status,
      rows_seen: rows.length,
      authorizations_97153: seen97153,
      upserted,
      clients_unmatched: unmatched,
      client_dates_written: datesWritten,
      clients_flagged_for_review: flaggedForReview,
      warnings,
    };
  }

  // ======================= STATUS ============================
  async function integrationStatus(month) {
    const mo = /^\d{4}-\d{2}$/.test(month || "") ? month : thisMonth();
    const cfg = await getConfig();
    const last = await dbGet(
      "SELECT * FROM rethink_sync_log WHERE kind = 'supervision_hours' ORDER BY id DESC LIMIT 1"
    ).catch(() => null);
    const lastOk = await dbGet(
      "SELECT * FROM rethink_sync_log WHERE kind = 'supervision_hours' AND status IN ('success','partial') ORDER BY id DESC LIMIT 1"
    ).catch(() => null);
    const observedRows = await dbAll(
      "SELECT field, value_raw, value_norm, occurrences, hours_sum FROM rethink_observed_values WHERE month = ? ORDER BY field, occurrences DESC",
      [mo]
    ).catch(() => []);
    const providers = await dbAll(
      `SELECT p.rethink_staff_id, p.employee_id, p.verified_hours, p.appointment_count, p.provisional, e.name
         FROM rethink_provider_month p LEFT JOIN hr_employees e ON e.id = p.employee_id
        WHERE p.month = ? ORDER BY p.verified_hours DESC`,
      [mo]
    ).catch(() => []);
    const needMatch = await dbAll(
      "SELECT id, name, role_title FROM hr_employees WHERE rethink_match_needed = TRUE ORDER BY name"
    ).catch(() => []);

    const parseWarn = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } };

    const lastAuth = await dbGet(
      "SELECT * FROM rethink_sync_log WHERE kind = 'authorizations' ORDER BY id DESC LIMIT 1"
    ).catch(() => null);
    const lastAuthOk = await dbGet(
      "SELECT * FROM rethink_sync_log WHERE kind = 'authorizations' AND status IN ('success','partial') ORDER BY id DESC LIMIT 1"
    ).catch(() => null);
    const authCounts = await dbGet(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE standing = 'current')::int AS current,
              COUNT(*) FILTER (WHERE standing = 'upcoming')::int AS upcoming,
              COUNT(*) FILTER (WHERE standing = 'expired')::int AS expired,
              COUNT(*) FILTER (WHERE client_id IS NULL)::int AS unmatched
         FROM rethink_client_authorizations`
    ).catch(() => null);
    const authReview = await dbAll(
      "SELECT id, child_name FROM clients WHERE rethink_auth_review_needed = TRUE ORDER BY child_name"
    ).catch(() => []);

    return {
      month: mo,
      // Per-variable booleans, never values. "configured" alone could not tell
      // an owner WHICH credential was missing, which is exactly what made a
      // mistyped variable name invisible in production.
      credentials: client.configState(),
      authorizations: {
        endpoint: DWH_AUTHORIZATIONS,
        target_code: TARGET_BILLING_CODE,
        code_id_fallback_configured: TARGET_CODE_IDS.length > 0,
        counts: authCounts || { total: 0, current: 0, upcoming: 0, expired: 0, unmatched: 0 },
        clients_needing_review: authReview,
        last_attempted_sync: lastAuth ? {
          started_at: lastAuth.started_at, finished_at: lastAuth.finished_at,
          status: lastAuth.status, error: lastAuth.error, error_kind: lastAuth.error_kind,
        } : null,
        last_successful_sync: lastAuthOk ? { finished_at: lastAuthOk.finished_at } : null,
        stale: !!(lastAuth && lastAuth.status === "failed" && lastAuthOk),
        warnings: lastAuth ? parseWarn(lastAuth.warnings) : [],
      },
      configured: client.configured(),
      token: client.tokenState(nowMs()),
      endpoints: { token_url: client.endpoints.TOKEN_URL, dwh_base: client.endpoints.DWH_BASE, scope: client.endpoints.SCOPE },
      filter: {
        confirmed: cfg.filter_confirmed,
        completed_statuses: cfg.completed_statuses,
        verified_values: cfg.verified_values,
        require_staff_verification: cfg.require_staff_verification,
        confirmed_by: cfg.confirmed_by,
        confirmed_at: cfg.confirmed_at,
      },
      sync_interval_minutes: cfg.sync_interval_minutes,
      last_attempted_sync: last ? {
        started_at: last.started_at, finished_at: last.finished_at, status: last.status,
        triggered_by: last.triggered_by, error: last.error, error_kind: last.error_kind,
      } : null,
      last_successful_sync: lastOk ? {
        finished_at: lastOk.finished_at,
        appointments_seen: lastOk.appointments_seen,
        appointments_counted: lastOk.appointments_counted,
        providers_matched: lastOk.providers_matched,
        providers_unmatched: lastOk.providers_unmatched,
        hours_written: lastOk.hours_written,
      } : null,
      // True when the most recent attempt failed but an older good value stands.
      stale: !!(last && last.status === "failed" && lastOk),
      warnings: last ? parseWarn(last.warnings) : [],
      observed_values: observedRows,
      providers,
      providers_needing_match: needMatch,
      totals: {
        providers: providers.length,
        matched: providers.filter((p) => p.employee_id).length,
        unmatched: providers.filter((p) => !p.employee_id).length,
        verified_hours: round2(providers.reduce((s, p) => s + num(p.verified_hours), 0)),
      },
    };
  }

  // ======================= API ===============================
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/rethink")) return false;

    if (!canView(user)) { json(res, 403, { error: "Not permitted." }); return true; }

    if (pathname === "/api/rethink/status" && method === "GET") {
      json(res, 200, await integrationStatus(query && query.month));
      return true;
    }

    if (pathname === "/api/rethink/sync-now" && method === "POST") {
      if (!canManage(user)) { json(res, 403, { error: "Owner or super admin only." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      const which = (b && b.what) || "all";
      const out = { ok: true };
      if (which === "all" || which === "hours") out.hours = await syncSupervisionHours("manual", b && b.month);
      if (which === "all" || which === "authorizations") out.authorizations = await syncAuthorizations("manual");
      out.ok = Object.values(out).every((v) => typeof v !== "object" || v.ok !== false);
      // The browser's api() helper reads `data.error` and otherwise shows a
      // useless "Request failed" -- which is exactly what a real upstream
      // failure looked like from the UI. Lift the sanitised reasons to the top
      // level. Only the safe messages travel; upstream bodies stay in the logs.
      if (!out.ok) {
        out.error = [out.hours, out.authorizations]
          .filter((r) => r && r.ok === false && r.error)
          .map((r) => r.error)
          .join(" · ") || "The Rethink sync failed. See the server logs for detail.";
        out.detail_in_server_logs = true;
      }
      json(res, out.ok ? 200 : 502, out);
      return true;
    }

    if (pathname === "/api/rethink/authorizations" && method === "GET") {
      const rows = await dbAll(
        `SELECT a.*, c.child_name FROM rethink_client_authorizations a
           LEFT JOIN clients c ON c.id = a.client_id
          ORDER BY a.standing, a.end_date DESC LIMIT 500`
      ).catch(() => []);
      json(res, 200, { rows });
      return true;
    }

    // Confirm (or re-open) the completed/verified filter once the real values
    // returned by production have been read off the observed-values list.
    if (pathname === "/api/rethink/filter" && method === "PUT") {
      if (!canManage(user)) { json(res, 403, { error: "Owner or super admin only." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      const statuses = Array.isArray(b.completed_statuses) ? b.completed_statuses.map(String) : [];
      const verified = Array.isArray(b.verified_values) ? b.verified_values.map(String) : [];
      const requireVer = b.require_staff_verification !== false;
      const confirm = b.filter_confirmed === true;

      if (confirm && !statuses.length) {
        json(res, 400, { error: "Select at least one appointmentStatus value that means completed." });
        return true;
      }
      if (confirm && requireVer && !verified.length) {
        json(res, 400, { error: "Select at least one staffVerification value that means verified, or turn off the verification requirement." });
        return true;
      }

      await dbRun(
        `UPDATE rethink_config SET filter_confirmed = ?, completed_statuses = ?, verified_values = ?,
           require_staff_verification = ?, confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = 1`,
        [confirm, JSON.stringify(statuses), JSON.stringify(verified), requireVer,
         confirm ? ((user && (user.email || user.name)) || "unknown") : null,
         confirm ? nowISO() : null, nowISO()]
      );
      json(res, 200, { ok: true, filter: (await getConfig()) });
      return true;
    }

    // ---- client matching (owner/admin only) ----------------------------
    if (pathname.startsWith("/api/rethink/client-match")) {
      if (!canMatch(user)) { json(res, 403, { error: "Owner or admin only." }); return true; }

      if (pathname === "/api/rethink/client-match" && method === "GET") {
        json(res, 200, await clientMatchReview());
        return true;
      }

      if (pathname === "/api/rethink/client-match/scan" && method === "POST") {
        const out = await scanClientMatches();
        json(res, out.ok ? 200 : 502, out);
        return true;
      }

      if (pathname === "/api/rethink/client-match/approve" && method === "POST") {
        const b = await readBody(req).catch(() => ({}));
        const actor = (user && (user.email || user.name)) || "unknown";
        const links = Array.isArray(b.links) && b.links.length
          ? b.links
          : [{ crm_client_id: b.crm_client_id, rethink_client_id: b.rethink_client_id }];

        const results = [];
        let linked = 0;
        for (const l of links) {
          const out = await approveClientLink(
            Number(l.crm_client_id), l.rethink_client_id,
            { confirm_overwrite: b.confirm_overwrite === true, confirm_duplicate: b.confirm_duplicate === true },
            actor
          ).catch((e) => ({ ok: false, error: client.redact(e.message) }));
          results.push({ crm_client_id: l.crm_client_id, ...out });
          if (out.ok && !out.unchanged) linked++;
        }

        // Newly linked clients have no authorization data yet, so pull it now
        // rather than making someone wait for the next scheduled sweep.
        let authSync = null;
        if (linked > 0 && b.sync !== false) {
          authSync = await syncAuthorizations("client_link").catch((e) => ({ ok: false, error: e.message }));
        }
        json(res, 200, { ok: results.every((r) => r.ok), linked, results, authorization_sync: authSync });
        return true;
      }

      json(res, 404, { error: "Unknown client-match route." });
      return true;
    }

    if (pathname === "/api/rethink/sync-log" && method === "GET") {
      json(res, 200, {
        rows: await dbAll("SELECT * FROM rethink_sync_log ORDER BY id DESC LIMIT 25").catch(() => []),
      });
      return true;
    }

    return false;
  }

  // Hours for the supervision tracker: only confirmed, matched values. Returns
  // a map of employee_id -> hours. Callers fall back to their existing value.
  async function verifiedHoursByEmployee(month) {
    const cfg = await getConfig();
    if (!cfg.filter_confirmed) return {};
    const rows = await dbAll(
      "SELECT employee_id, verified_hours FROM rethink_provider_month WHERE month = ? AND employee_id IS NOT NULL AND provisional = FALSE",
      [month]
    ).catch(() => []);
    const out = {};
    for (const r of rows) out[r.employee_id] = num(r.verified_hours);
    return out;
  }

  return {
    initTables,
    handleApi,
    syncSupervisionHours,
    syncAuthorizations,
    integrationStatus,
    verifiedHoursByEmployee,
    getConfig,
    scanClientMatches,
    clientMatchReview,
    approveClientLink,
    _internal: { decide, norm, monthWindow, standingOf, is97153, dateOnly, normName, splitName, validateClientFields, CLIENT_FIELDS },
  };
};
