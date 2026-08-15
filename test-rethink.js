// Rethink integration -- logic tests.
//
// The Rethink API is not reachable from a build environment, and the two things
// this integration produces are a BACB compliance percentage and an
// authorization expiry date. Both are numbers somebody trusts without checking.
// So the decision logic is tested directly, against a stubbed transport and an
// in-memory database, rather than left to be discovered in production.
//
// What is covered here is every scenario on the acceptance list: verified /
// unverified / cancelled / absent sessions, an unmatchable provider, the four
// authorization standings, overlapping authorizations, an API failure, and a
// repeat sync. What is NOT covered -- and cannot be until credentials are in
// Railway -- is the shape of a real Rethink response. That is exactly why the
// completed/verified filter is configurable instead of hard-coded.
//
// Run: node test-rethink.js     (no database, no network, no browser)

"use strict";

const path = require("path");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
};

// ---- stub the transport so no network call is ever attempted --------------
const clientPath = require.resolve("./rethink-client");
const realClient = require("./rethink-client");
const stub = {
  configured: () => true,
  redact: realClient.redact,
  tokenState: () => ({ has_token: true, valid: true, expires_in_seconds: 3000 }),
  endpoints: realClient.endpoints,
  RethinkError: realClient.RethinkError,
  extractRows: realClient.extractRows,
  // Swapped per scenario.
  dwhGetAllPages: async () => ({ rows: [], pages: 1, truncated: false }),
  dwhGet: async () => ({}),
  getToken: async () => "stub",
  invalidateToken: () => {},
};
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: stub };

// ---- in-memory database --------------------------------------------------
// Only the statements this module actually issues are understood; anything else
// is recorded so an unexpected write shows up in the assertions rather than
// passing silently.
function makeDb(seed) {
  const state = {
    config: seed.config,
    employees: seed.employees || [],
    clients: seed.clients || [],
    providerMonth: [],
    observed: [],
    supervisionWrites: [],
    authRows: [],
    clientDateWrites: [],
    reviewFlags: [],
    matchNeededCleared: 0,
    matchNeededSet: 0,
    deletes: [],
    log: [],
    sql: [],
  };

  const dbGet = async (sql, p = []) => {
    state.sql.push(sql);
    if (/INSERT INTO rethink_sync_log/i.test(sql)) { state.log.push({ kind: p[0] }); return { id: state.log.length }; }
    if (/FROM rethink_config/i.test(sql)) return state.config;
    if (/FROM rethink_sync_log/i.test(sql)) return null;
    if (/FROM rethink_client_authorizations/i.test(sql)) return null;
    return null;
  };

  const dbAll = async (sql) => {
    state.sql.push(sql);
    if (/FROM hr_employees/i.test(sql)) return state.employees;
    if (/FROM clients/i.test(sql)) return state.clients;
    return [];
  };

  const dbRun = async (sql, p = []) => {
    state.sql.push(sql);
    if (/^\s*DELETE FROM/i.test(sql)) { state.deletes.push(sql.trim().split("\n")[0]); return; }
    if (/INSERT INTO rethink_provider_month/i.test(sql)) {
      state.providerMonth.push({ staffId: p[0], month: p[1], employeeId: p[2], hours: p[3], count: p[4], provisional: p[5] });
      return;
    }
    if (/INSERT INTO rethink_observed_values/i.test(sql)) {
      state.observed.push({ field: p[0], raw: p[1], norm: p[2], n: p[3], hours: p[4] });
      return;
    }
    if (/INSERT INTO hr_supervision_logs/i.test(sql)) {
      state.supervisionWrites.push({ employeeId: p[0], month: p[1], hours: p[3] });
      return;
    }
    if (/INSERT INTO rethink_client_authorizations/i.test(sql)) {
      state.authRows.push({ authId: p[0], rethinkClientId: p[1], clientId: p[2], start: p[9], end: p[10], standing: p[19] });
      return;
    }
    if (/UPDATE clients SET auth_start_date/i.test(sql)) {
      state.clientDateWrites.push({ start: p[0], end: p[1], clientId: p[3] });
      return;
    }
    if (/UPDATE clients SET rethink_auth_review_needed = TRUE/i.test(sql)) { state.reviewFlags.push(p[0]); return; }
    if (/SET rethink_match_needed = FALSE/i.test(sql)) { state.matchNeededCleared++; return; }
    if (/SET rethink_match_needed = TRUE/i.test(sql)) { state.matchNeededSet++; return; }
  };

  return { state, ctx: { dbGet, dbAll, dbRun, nowISO: () => seed.now, readBody: async () => ({}), json: () => {} } };
}

const CONFIRMED = {
  filter_confirmed: true,
  completed_statuses: JSON.stringify(["Completed"]),
  verified_values: JSON.stringify(["true"]),
  require_staff_verification: true,
  sync_interval_minutes: 240,
};
const UNCONFIRMED = { ...CONFIRMED, filter_confirmed: false };

const NOW = "2026-08-15T12:00:00.000Z";
const initRethink = require("./rethink");

(async () => {
  console.log("\nSUPERVISION -- verified monthly hours\n");

  // Scenarios 1-4: one provider with a mix of rows, plus a provider with none.
  {
    const { state, ctx } = makeDb({
      now: NOW, config: CONFIRMED,
      employees: [
        { id: 1, name: "Verified RBT", rethink_id: "S100" },
        { id: 2, name: "No Sessions RBT", rethink_id: "S200" },
      ],
    });
    stub.dwhGetAllPages = async () => ({ rows: [
      { staffId: "S100", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 2.5, appointmentDate: "2026-08-03" },
      { staffId: "S100", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 1.25, appointmentDate: "2026-08-04" },
      // unverified -- must not count
      { staffId: "S100", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 3, appointmentDate: "2026-08-05" },
      // cancelled status -- must not count
      { staffId: "S100", appointmentStatus: "Cancelled", staffVerification: true, actualDurationHours: 4, appointmentDate: "2026-08-06" },
      // completed + verified but no actual duration -- must not be back-filled
      { staffId: "S100", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: null, durationHours: 8, appointmentDate: "2026-08-07" },
      // future -- must not count
      { staffId: "S100", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 5, appointmentDate: "2026-08-30" },
    ], pages: 1, truncated: false });

    const r = initRethink(ctx);
    const out = await r.syncSupervisionHours("test", "2026-08");
    const s100 = state.providerMonth.find((p) => p.staffId === "S100");

    check("sums only completed + staff-verified appointments", s100 && s100.hours === 3.75, s100 && s100.hours);
    check("unverified sessions are excluded", out.appointments_counted === 2, out.appointments_counted);
    check("cancelled sessions are excluded", !!s100 && s100.count === 2, s100 && s100.count);
    check("scheduled durationHours is never substituted for actualDurationHours",
      s100 && s100.hours === 3.75, s100 && s100.hours);
    check("a missing actualDurationHours is reported, not silently dropped",
      out.warnings.some((w) => /actualDurationHours/i.test(w)), out.warnings.join(" | "));
    check("future appointments are excluded", s100 && s100.hours === 3.75);
    check("a provider with no sessions gets no row", !state.providerMonth.find((p) => p.staffId === "S200"));
    check("hours reach the supervision tracker for a matched provider",
      state.supervisionWrites.some((w) => w.employeeId === 1 && w.hours === 3.75),
      JSON.stringify(state.supervisionWrites));
    check("distinct field values are recorded for confirmation",
      state.observed.some((o) => o.field === "appointmentStatus" && o.norm === "cancelled"),
      JSON.stringify(state.observed.map((o) => o.field + "=" + o.norm)));
  }

  // Scenario 5: provider present in Rethink, absent from the CRM.
  {
    const { state, ctx } = makeDb({ now: NOW, config: CONFIRMED, employees: [{ id: 1, name: "Known", rethink_id: "S100" }] });
    stub.dwhGetAllPages = async () => ({ rows: [
      { staffId: "S999", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 6, appointmentDate: "2026-08-03" },
    ], pages: 1, truncated: false });

    const r = initRethink(ctx);
    const out = await r.syncSupervisionHours("test", "2026-08");
    check("an unmatched provider is counted as unmatched", out.providers_unmatched === 1, out.providers_unmatched);
    check("an unmatched provider is stored with a null employee, never guessed",
      state.providerMonth[0] && state.providerMonth[0].employeeId === null);
    check("no supervision hours are written for an unmatched provider", state.supervisionWrites.length === 0);
    check("unmatched providers are surfaced as needing a match", state.matchNeededSet > 0);
  }

  // The filter gate: provisional totals must never reach the tracker.
  {
    const { state, ctx } = makeDb({ now: NOW, config: UNCONFIRMED, employees: [{ id: 1, name: "RBT", rethink_id: "S100" }] });
    stub.dwhGetAllPages = async () => ({ rows: [
      { staffId: "S100", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 10, appointmentDate: "2026-08-03" },
    ], pages: 1, truncated: false });

    const r = initRethink(ctx);
    const out = await r.syncSupervisionHours("test", "2026-08");
    check("an unconfirmed filter still computes a provisional total", state.providerMonth[0].hours === 10);
    check("an unconfirmed filter writes NOTHING to the supervision tracker", state.supervisionWrites.length === 0);
    check("the provisional total is marked provisional", state.providerMonth[0].provisional === true);
    check("and says so in the warnings", out.warnings.some((w) => /not confirmed/i.test(w)));
    const hours = await r.verifiedHoursByEmployee("2026-08");
    check("verifiedHoursByEmployee returns nothing while unconfirmed", Object.keys(hours).length === 0);
  }

  // Scenario 11: API failure must not destroy anything.
  {
    const { state, ctx } = makeDb({ now: NOW, config: CONFIRMED, employees: [{ id: 1, name: "RBT", rethink_id: "S100" }] });
    stub.dwhGetAllPages = async () => { throw new realClient.RethinkError("Rethink is down.", { kind: "http" }); };

    const r = initRethink(ctx);
    const out = await r.syncSupervisionHours("test", "2026-08");
    check("a failed sync reports failure", out.ok === false, JSON.stringify(out));
    check("a failed sync deletes nothing", state.deletes.length === 0, state.deletes.join(" | "));
    check("a failed sync writes no hours", state.supervisionWrites.length === 0);
    check("a failed sync writes no provider rows", state.providerMonth.length === 0);
  }

  // Scenario 12: re-running a sync is idempotent.
  {
    const rows = [{ staffId: "S100", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 4, appointmentDate: "2026-08-03" }];
    stub.dwhGetAllPages = async () => ({ rows, pages: 1, truncated: false });
    const runOnce = async () => {
      const { state, ctx } = makeDb({ now: NOW, config: CONFIRMED, employees: [{ id: 1, name: "RBT", rethink_id: "S100" }] });
      const r = initRethink(ctx);
      await r.syncSupervisionHours("test", "2026-08");
      return state;
    };
    const a = await runOnce(), b = await runOnce();
    check("a repeat sync produces the same hours, not doubled",
      a.providerMonth[0].hours === 4 && b.providerMonth[0].hours === 4,
      `${a.providerMonth[0].hours} / ${b.providerMonth[0].hours}`);
    check("a repeat sync replaces the month rather than appending",
      b.deletes.some((d) => /rethink_provider_month/i.test(d)));
    check("a repeat sync writes one supervision row per provider", b.supervisionWrites.length === 1);
  }

  console.log("\nAUTHORIZATIONS -- 97153 only\n");

  const authClients = [
    { id: 10, rethink_client_id: "C10" },
    { id: 11, rethink_client_id: "C11" },
    { id: 12, rethink_client_id: "C12" },
    { id: 13, rethink_client_id: "C13" },
    { id: 14, rethink_client_id: "C14" },
  ];
  const auth = (o) => Object.assign({
    clientAuthorizationId: o.id, clientId: o.c, billingCode: "97153",
    startDate: o.s, endDate: o.e, status: "Approved", funder: "Payer",
    authorizationNo: "A" + o.id, unitType: "Units", authorizedNumberOfUnits: 400,
  }, o.extra || {});

  // Scenarios 6-10 in one pass.
  {
    const { state, ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: authClients });
    stub.dwhGetAllPages = async () => ({ rows: [
      auth({ id: "AU1", c: "C10", s: "2026-08-01", e: "2026-12-31" }),                    // current
      auth({ id: "AU2", c: "C11", s: "2025-01-01", e: "2026-06-30" }),                    // expired
      auth({ id: "AU3", c: "C12", s: "2026-10-01", e: "2027-03-31" }),                    // upcoming
      auth({ id: "AU4", c: "C13", s: "2026-08-01", e: "2026-11-30" }),                    // overlapping current
      auth({ id: "AU5", c: "C13", s: "2026-07-15", e: "2026-10-31" }),                    // overlapping current
      // a non-97153 code for a tracked client -- must be ignored entirely
      { clientAuthorizationId: "AU6", clientId: "C14", billingCode: "97155", startDate: "2026-08-01", endDate: "2026-12-31" },
      // a deleted record -- must be ignored
      auth({ id: "AU7", c: "C10", s: "2026-08-01", e: "2026-12-31", extra: { isDeleted: true } }),
    ], pages: 1, truncated: false });

    const r = initRethink(ctx);
    const out = await r.syncAuthorizations("test");

    const byId = (id) => state.authRows.find((a) => a.authId === id);
    const dateFor = (cid) => state.clientDateWrites.find((w) => w.clientId === cid);

    check("only 97153 authorizations are imported", out.authorizations_97153 === 5, out.authorizations_97153);
    check("a non-97153 code is not imported at all", !byId("AU6"));
    check("a deleted authorization is ignored", !byId("AU7"));

    check("an active authorization is marked current", byId("AU1").standing === "current");
    check("an expired authorization is marked expired", byId("AU2").standing === "expired");
    check("an upcoming authorization is retained as upcoming", byId("AU3").standing === "upcoming");

    check("a current authorization drives the client's expiration date",
      dateFor(10) && dateFor(10).end === "2026-12-31", JSON.stringify(dateFor(10)));
    check("an expired authorization with no replacement still sets dates so the alert system flags it",
      dateFor(11) && dateFor(11).end === "2026-06-30", JSON.stringify(dateFor(11)));
    check("an upcoming-only authorization does not become the active expiration date",
      !dateFor(12), JSON.stringify(dateFor(12)));

    check("overlapping current authorizations flag the client for review", state.reviewFlags.includes(13));
    check("overlapping current authorizations do NOT pick one arbitrarily", !dateFor(13));
    check("a client with no 97153 authorization gets no dates written", !dateFor(14));
    check("the review flag is cleared before re-evaluating", state.matchNeededCleared >= 0 && state.sql.some((s) => /rethink_auth_review_needed = FALSE/i.test(s)));
  }

  // "Do not overwrite a valid current authorization with an old expired one."
  {
    const { state, ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: [{ id: 20, rethink_client_id: "C20" }] });
    stub.dwhGetAllPages = async () => ({ rows: [
      auth({ id: "OLD", c: "C20", s: "2024-01-01", e: "2025-01-01" }),
      auth({ id: "NEW", c: "C20", s: "2026-08-01", e: "2027-01-31" }),
    ], pages: 1, truncated: false });

    const r = initRethink(ctx);
    await r.syncAuthorizations("test");
    const w = state.clientDateWrites.find((x) => x.clientId === 20);
    check("a current authorization always beats an expired one regardless of order",
      w && w.end === "2027-01-31", JSON.stringify(w));
    check("exactly one date write per client", state.clientDateWrites.filter((x) => x.clientId === 20).length === 1);
  }

  // Unmatched client, and missing dates.
  {
    const { state, ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: [{ id: 30, rethink_client_id: "C30" }] });
    stub.dwhGetAllPages = async () => ({ rows: [
      auth({ id: "UM", c: "C_UNKNOWN", s: "2026-08-01", e: "2026-12-31" }),
      auth({ id: "ND", c: "C30", s: null, e: null }),
    ], pages: 1, truncated: false });

    const r = initRethink(ctx);
    const out = await r.syncAuthorizations("test");
    check("an unmatched client is counted, not guessed", out.clients_unmatched === 1, out.clients_unmatched);
    check("an unmatched client is stored with a null CRM id",
      state.authRows.find((a) => a.authId === "UM").clientId === null);
    check("a missing authorization date is warned about", out.warnings.some((w) => /missing a start or end date/i.test(w)));
    check("a missing authorization date never writes dates", !state.clientDateWrites.find((w) => w.clientId === 30));
  }

  // API failure on the authorization side.
  {
    const { state, ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: authClients });
    stub.dwhGetAllPages = async () => { throw new realClient.RethinkError("Timed out.", { kind: "timeout" }); };
    const r = initRethink(ctx);
    const out = await r.syncAuthorizations("test");
    check("a failed authorization sync reports failure", out.ok === false);
    check("a failed authorization sync never blanks client dates", state.clientDateWrites.length === 0);
    check("a failed authorization sync writes no authorization rows", state.authRows.length === 0);
    check("the failure names the endpoint so a wrong path is obvious",
      /ClientAuthorizations|RETHINK_AUTH_ENDPOINT/.test(out.error), out.error);
  }

  // Repeat authorization sync -- idempotent by stable key.
  {
    const rows = [auth({ id: "AU1", c: "C10", s: "2026-08-01", e: "2026-12-31" })];
    stub.dwhGetAllPages = async () => ({ rows, pages: 1, truncated: false });
    const runOnce = async () => {
      const { state, ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: authClients });
      await initRethink(ctx).syncAuthorizations("test");
      return state;
    };
    const a = await runOnce(), b = await runOnce();
    check("a repeat authorization sync produces one row per authorization",
      a.authRows.length === 1 && b.authRows.length === 1);
    check("a repeat authorization sync writes the same dates", b.clientDateWrites.length === 1);
  }

  console.log("\nPURE LOGIC\n");
  {
    const { ctx } = makeDb({ now: NOW, config: CONFIRMED });
    const { standingOf, is97153, dateOnly, monthWindow } = initRethink(ctx)._internal;
    check("standing: current", standingOf("2026-08-01", "2026-12-31", "2026-08-15") === "current");
    check("standing: upcoming", standingOf("2026-09-01", "2026-12-31", "2026-08-15") === "upcoming");
    check("standing: expired", standingOf("2025-01-01", "2026-08-14", "2026-08-15") === "expired");
    check("standing: boundary day counts as current", standingOf("2026-08-15", "2026-08-15", "2026-08-15") === "current");
    check("standing: unknown without dates", standingOf(null, "2026-12-31", "2026-08-15") === "unknown");
    check("97153 matched on billingCode", is97153({ billingCode: "97153" }) === true);
    check("97155 is not 97153", is97153({ billingCode: "97155" }) === false);
    check("a blank billingCode does not silently match", is97153({ billingCode: "", billingCodeId: "7" }) === false);
    check("dateOnly trims a timestamp", dateOnly("2026-08-01T00:00:00Z") === "2026-08-01");
    check("month window never requests the future",
      monthWindow("2026-08").to === "2026-08-15", monthWindow("2026-08").to);
    check("month window starts on the first", monthWindow("2026-08").from === "2026-08-01");
    check("a past month uses its real end date", monthWindow("2026-07").to === "2026-07-31");
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
