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
  // Silenced in the stub so the suite's own output stays readable. The real
  // logger is exercised directly against the real client further down, which
  // is where the leak-safety assertions live.
  log: () => {},
  snippet: realClient.snippet,
  safeMessage: realClient.safeMessage,
  configState: realClient.configState,
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
    // The browser gets the sanitised message; the endpoint hint is added only
    // where it is actionable (see the 404 case below).
    check("the browser receives a sanitised message, not raw internals",
      typeof out.error === "string" && out.error.length > 0, out.error);
    check("the response says the detail is in the server logs", out.detail_in_server_logs === true);
  }

  // A 404 on the authorization endpoint is nearly always a wrong path, so the
  // path is surfaced to the operator.
  {
    const { ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: authClients });
    stub.dwhGetAllPages = async () => {
      throw new realClient.RethinkError("Rethink ClientAuthorization returned HTTP 404.", {
        kind: "http", status: 404, endpoint: "ClientAuthorization",
        safe: "Rethink ClientAuthorization endpoint returned 404",
      });
    };
    const out = await initRethink(ctx).syncAuthorizations("test");
    check("a 404 tells the operator which path was tried",
      /RETHINK_AUTH_ENDPOINT/.test(out.error), out.error);
    // Guards against regressing to the plural we originally guessed. The DWH
    // Swagger documents GET /api/ClientAuthorization -- singular.
    check("the authorization endpoint is the documented singular path",
      /"ClientAuthorization"/.test(out.error) && !/ClientAuthorizations/.test(out.error), out.error);
    check("the 404 message names the status", /404/.test(out.error), out.error);
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

  console.log("\nCLIENT MATCHING\n");

  // The matcher proposes; it must never write clients.rethink_client_id itself.
  {
    const crm = [
      { id: 1, child_name: "Ava Nguyen", dob: "2019-04-02", rethink_client_id: null },   // exact
      { id: 2, child_name: "Liam O'Brien", dob: "2018-11-20", rethink_client_id: null },  // punctuation
      { id: 3, child_name: "Noah Patel", dob: null, rethink_client_id: null },            // DOB missing in CRM
      { id: 4, child_name: "Mia Garcia", dob: "2020-01-15", rethink_client_id: null },    // two same-name candidates
      { id: 5, child_name: "Zoe Absent", dob: "2017-06-01", rethink_client_id: null },    // nobody
      { id: 6, child_name: "Already Linked", dob: "2019-01-01", rethink_client_id: "R99" },
    ];
    const { state, ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: crm });
    stub.dwhGetAllPages = async () => ({ rows: [
      { clientId: "R1", firstName: "Ava", lastName: "Nguyen", dateOfBirth: "2019-04-02T00:00:00Z" },
      { clientId: "R2", firstName: "Liam", lastName: "O'Brien", dateOfBirth: "2018-11-20" },
      { clientId: "R3", firstName: "Noah", lastName: "Patel", dateOfBirth: "2016-02-02" },
      { clientId: "R4", firstName: "Mia", lastName: "Garcia", dateOfBirth: "2020-01-15" },
      { clientId: "R5", firstName: "Mia", lastName: "Garcia", dateOfBirth: "2021-09-09" },
    ], pages: 1, truncated: false });

    const r = initRethink(ctx);
    const out = await r.scanClientMatches();

    const cands = state.sql.filter((s) => /INSERT INTO rethink_client_match_candidates/i.test(s));
    check("the scan reads the documented client schema", out.ok === true, out.error);
    check("it uses the documented field names, not auto-detection",
      out.field_map && out.field_map.id === "clientId" && out.field_map.first === "firstName"
        && out.field_map.last === "lastName" && out.field_map.dob === "dateOfBirth",
      JSON.stringify(out.field_map));
    check("an exact first + last + DOB match is Ready to Link", out.ready_to_link === 2, out.ready_to_link);
    check("punctuation and apostrophes do not break a match", out.ready_to_link === 2);
    check("two same-name candidates are Needs Review, never auto-picked", out.needs_review >= 1, out.needs_review);
    check("a client with no candidate is reported as no-match", out.no_match === 1, out.no_match);
    check("an already-linked client is skipped", out.already_linked === 1, out.already_linked);
    check("the scan proposes but never writes rethink_client_id",
      !state.sql.some((s) => /UPDATE clients SET rethink_client_id/i.test(s)));
    check("candidates are staged for review", cands.length > 0);
  }

  // A schema change must fail loudly with the keys it did see, rather than
  // silently matching nobody.
  {
    const { ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: [{ id: 1, child_name: "A B", dob: "2019-01-01" }] });
    stub.dwhGetAllPages = async () => ({ rows: [{ clientId: "R1", nickname: "Bee" }], pages: 1, truncated: false });
    const out = await initRethink(ctx).scanClientMatches();
    check("a client response missing documented fields fails rather than guessing", out.ok === false);
    check("the error names the documented fields that were missing",
      /firstName/.test(out.error || "") && /dateOfBirth/.test(out.error || ""), out.error);
    check("and names the keys it actually received", /nickname/.test(out.error || ""), out.error);
  }

  // Client status is carried through for the reviewer but never filters anyone out.
  {
    const { ctx } = makeDb({
      now: NOW, config: CONFIRMED,
      clients: [{ id: 1, child_name: "Ava Nguyen", dob: "2019-04-02", rethink_client_id: null }],
    });
    stub.dwhGetAllPages = async () => ({ rows: [
      { clientId: "R1", firstName: "Ava", lastName: "Nguyen", dateOfBirth: "2019-04-02", status: "Discharged" },
    ], pages: 1, truncated: false });
    const out = await initRethink(ctx).scanClientMatches();
    check("a client is still matched regardless of its Rethink status", out.ready_to_link === 1, out.ready_to_link);
    check("client status is part of the documented field map", out.field_map.status === "status");
  }

  // Approve & Link, and the overwrite guard.
  {
    const { state, ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: [] });
    let clientRow = { id: 7, rethink_client_id: null };
    ctx.dbGet = async (sql, p = []) => {
      state.sql.push(sql);
      if (/INSERT INTO rethink_sync_log/i.test(sql)) return { id: 1 };
      if (/FROM rethink_config/i.test(sql)) return CONFIRMED;
      if (/SELECT id, rethink_client_id FROM clients WHERE id/i.test(sql)) return clientRow;
      if (/WHERE rethink_client_id = \? AND id <>/i.test(sql)) return null;
      if (/FROM rethink_client_match_candidates WHERE crm_client_id/i.test(sql)) return { confidence: "high" };
      return null;
    };
    ctx.dbRun = async (sql, p = []) => {
      state.sql.push(sql);
      if (/UPDATE clients SET rethink_client_id/i.test(sql)) { clientRow.rethink_client_id = p[0]; state.clientDateWrites.push({ link: p[0] }); }
    };

    const r = initRethink(ctx);
    const first = await r.approveClientLink(7, "R42", {}, "owner@x");
    check("approving a link saves the Rethink client ID", first.ok === true && clientRow.rethink_client_id === "R42");
    check("the link is written to an audit log", state.sql.some((s) => /INSERT INTO rethink_client_link_log/i.test(s)));

    const same = await r.approveClientLink(7, "R42", {}, "owner@x");
    check("re-approving the same link is a no-op", same.ok === true && same.unchanged === true);

    const blocked = await r.approveClientLink(7, "R77", {}, "owner@x");
    check("an existing link is NOT overwritten without confirmation",
      blocked.ok === false && blocked.needs_confirmation === true, JSON.stringify(blocked));
    check("the refusal names the value it would replace", blocked.existing_value === "R42");
    check("the client ID is unchanged after a refused overwrite", clientRow.rethink_client_id === "R42");

    const forced = await r.approveClientLink(7, "R77", { confirm_overwrite: true }, "owner@x");
    check("an explicit confirmation does replace it", forced.ok === true && clientRow.rethink_client_id === "R77");
    check("and records what it replaced", forced.replaced === "R42");
  }

  console.log("\nCREDENTIAL REPORTING\n");

  // A mistyped variable NAME cost a production debugging session: Railway held
  // "RETHINK_CLIENT_ID\n" -- a trailing newline in the key -- so process.env
  // never saw it, while the panel said "add both variables" with one already
  // present. These assertions are about making that visible, never about
  // reading a value.
  {
    const saved = { ...process.env };
    const reset = () => {
      delete process.env.RETHINK_CLIENT_ID;
      delete process.env.RETHINK_CLIENT_SECRET;
      for (const k of Object.keys(process.env)) if (k.trim() !== k && k.includes("RETHINK")) delete process.env[k];
    };

    reset();
    let st = realClient.configState();
    check("with nothing set, both credentials report false",
      st.clientIdConfigured === false && st.clientSecretConfigured === false && st.configured === false);

    reset();
    process.env.RETHINK_CLIENT_SECRET = "x";
    st = realClient.configState();
    check("a present secret and absent id are reported separately",
      st.clientIdConfigured === false && st.clientSecretConfigured === true && st.configured === false,
      JSON.stringify(st));

    // The exact production failure.
    reset();
    process.env["RETHINK_CLIENT_ID\n"] = "x";
    process.env.RETHINK_CLIENT_SECRET = "y";
    st = realClient.configState();
    check("a trailing newline in the variable NAME still reads as not configured",
      st.clientIdConfigured === false && st.configured === false);
    check("and the malformed name is detected and named",
      st.malformed_variable_names.length === 1
        && st.malformed_variable_names[0].expected === "RETHINK_CLIENT_ID",
      JSON.stringify(st.malformed_variable_names));
    check("the malformed name is rendered so the whitespace is visible",
      /\\n/.test(st.malformed_variable_names[0].actual), st.malformed_variable_names[0].actual);

    reset();
    process.env.RETHINK_CLIENT_ID = "a";
    process.env.RETHINK_CLIENT_SECRET = "b";
    st = realClient.configState();
    check("with both set correctly, configured is true",
      st.clientIdConfigured === true && st.clientSecretConfigured === true && st.configured === true);
    check("no malformed names are reported when the environment is clean",
      st.malformed_variable_names.length === 0);
    check("configState never returns a credential value",
      !JSON.stringify(st).includes('"a"') && !JSON.stringify(st).includes('"b"'), JSON.stringify(st));

    // An unrelated badly-named variable must not be reported as ours.
    reset();
    process.env["SOME_OTHER_VAR "] = "z";
    check("unrelated malformed variable names are ignored",
      realClient.configState().malformed_variable_names.length === 0);
    delete process.env["SOME_OTHER_VAR "];

    reset();
    for (const k of Object.keys(saved)) process.env[k] = saved[k];
  }

  console.log("\nLIVE HOURS AS THE PRIMARY SOURCE\n");

  // Once the filter is confirmed, the API figure is the denominator and the
  // .xlsx upload stops being part of the workflow. These assertions cover the
  // handover in both directions -- including the one that matters most, that a
  // provider the API knows nothing about keeps whatever was already there
  // rather than dropping to zero.
  {
    const { state, ctx } = makeDb({
      now: NOW, config: CONFIRMED,
      employees: [{ id: 1, name: "RBT One", rethink_id: "S100" }, { id: 2, name: "RBT Two", rethink_id: "S200" }],
    });
    stub.dwhGetAllPages = async () => ({ rows: [
      { staffId: "S100", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 2, appointmentDate: "2026-08-03" },
      { staffId: "S100", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 1.5, appointmentDate: "2026-08-04" },
      { staffId: "S200", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 4, appointmentDate: "2026-08-05" },
    ], pages: 1, truncated: false });

    const r = initRethink(ctx);
    await r.syncSupervisionHours("test", "2026-08");

    // The per-provider figures the verification table renders.
    const s100 = state.providerMonth.find((p) => p.staffId === "S100");
    const s200 = state.providerMonth.find((p) => p.staffId === "S200");
    check("per-provider appointment counts are recorded for verification",
      s100.count === 2 && s200.count === 1, `${s100.count}/${s200.count}`);
    check("per-provider hours are recorded for verification",
      s100.hours === 3.5 && s200.hours === 4, `${s100.hours}/${s200.hours}`);
    check("a confirmed filter marks the figures non-provisional",
      s100.provisional === false && s200.provisional === false);
    check("confirmed hours reach the supervision tracker for every matched provider",
      state.supervisionWrites.length === 2, JSON.stringify(state.supervisionWrites));

  }

  // verifiedHoursByEmployee is what supervision.js reads for the denominator.
  // Built on its own ctx: the module destructures its db helpers at
  // construction, so they have to be in place before initRethink is called.
  {
    const rows = [{ employee_id: 1, verified_hours: 3.5 }, { employee_id: 2, verified_hours: 4 }];
    const ctxFor = (config) => ({
      dbGet: async (sql) => (/FROM rethink_config/i.test(sql) ? config : null),
      dbAll: async (sql) => (/FROM rethink_provider_month/i.test(sql) ? rows : []),
      dbRun: async () => {},
      nowISO: () => NOW, readBody: async () => ({}), json: () => {},
    });

    const hours = await initRethink(ctxFor(CONFIRMED)).verifiedHoursByEmployee("2026-08");
    check("the denominator map exposes hours per employee",
      hours[1] === 3.5 && hours[2] === 4, JSON.stringify(hours));

    const none = await initRethink(ctxFor(UNCONFIRMED)).verifiedHoursByEmployee("2026-08");
    check("an unconfirmed filter supplies no denominator at all",
      Object.keys(none).length === 0, JSON.stringify(none));
  }

  // Supervision percentage arithmetic, using the live denominator. Mirrors
  // supervision.js's pct(): one decimal place.
  {
    const pct = (sup, worked) => (!worked ? null : Math.round((sup / worked) * 1000) / 10);
    check("supervision % uses the live hours as the denominator", pct(4.25, 82.5) === 5.2, pct(4.25, 82.5));
    check("a provider with zero live hours yields no percentage, not a divide-by-zero",
      pct(2, 0) === null);
    check("5% of live hours is the BACB line", pct(5, 100) === 5);
  }

  console.log("\nOBSERVABILITY AND LEAK SAFETY\n");

  // A production sync failed with a generic "Request failed" and Railway showed
  // no log line at all -- the client logged nothing and the route returned no
  // top-level `error` for the browser's api() helper to read. Both are fixed;
  // these assertions hold the line, especially the ones proving that adding
  // logging did not start leaking credentials.
  {
    const SECRET = "sUperSecre7-VALUE-xyz";
    const ID = "client-id-abc123";
    const TOKEN = "eyJhbGciOiJIUzI1NiJ9.TOKENVALUE.sig";
    const savedEnv = { ...process.env };
    process.env.RETHINK_CLIENT_ID = ID;
    process.env.RETHINK_CLIENT_SECRET = SECRET;

    // Capture everything the module writes to stdout/stderr.
    const lines = [];
    const realLog = console.log, realErr = console.error;
    const capture = (...a) => lines.push(a.join(" "));

    // Drive the REAL client (not the stub) against a stubbed fetch, so the
    // logging and redaction paths actually execute.
    const realFetch = global.fetch;
    const restore = () => {
      global.fetch = realFetch; console.log = realLog; console.error = realErr;
      for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
      Object.assign(process.env, savedEnv);
    };

    // --- token rejected with an OAuth error code ---------------------------
    lines.length = 0;
    console.log = capture; console.error = capture;
    global.fetch = async () => ({
      ok: false, status: 400,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: "invalid_scope", error_description: "scope not granted" }),
      json: async () => ({ error: "invalid_scope" }),
    });
    realClient.invalidateToken();
    let caught = null;
    try { await realClient.dwhGet("Appointments", {}, { nowMs: 1 }); } catch (e) { caught = e; }
    console.log = realLog; console.error = realErr;

    check("a failed token request is logged", lines.some((l) => /stage=token_request_failed/.test(l)),
      lines.join(" | ").slice(0, 200));
    check("the log records the HTTP status", lines.some((l) => /status=400/.test(l)));
    check("the log records the upstream OAuth error", lines.some((l) => /oauth_error=invalid_scope/.test(l)));
    check("the log records the upstream body", lines.some((l) => /scope not granted/.test(l)));
    check("the log records the endpoint being called", lines.some((l) => /url=.*connect\/token/.test(l)));
    check("the browser-safe message names the OAuth error",
      caught && caught.safe === "Rethink token request rejected: invalid_scope", caught && caught.safe);
    check("NO log line contains the client secret", !lines.some((l) => l.includes(SECRET)));
    check("NO log line contains the client id", !lines.some((l) => l.includes(ID)));
    check("the safe message contains no credential",
      caught && !caught.safe.includes(SECRET) && !caught.safe.includes(ID));

    // --- DWH endpoint 404 --------------------------------------------------
    lines.length = 0;
    console.log = capture; console.error = capture;
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ access_token: TOKEN, expires_in: 3600 }) };
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => "No route matched." };
    };
    realClient.invalidateToken();
    caught = null;
    try { await realClient.dwhGet("ClientAuthorization", {}, { nowMs: 1 }); } catch (e) { caught = e; }
    console.log = realLog; console.error = realErr;

    check("the successful token acquisition is logged", lines.some((l) => /stage=token_acquired/.test(l)));
    check("the outgoing DWH request is logged with its endpoint",
      lines.some((l) => /stage=dwh_request\b.*endpoint=ClientAuthorization/.test(l)), lines.join(" | ").slice(0, 300));
    check("the 404 is logged with status and body",
      lines.some((l) => /stage=dwh_request_failed.*status=404/.test(l) && /No route matched/.test(l)));
    check("the browser-safe message names the endpoint and status",
      caught && caught.safe === "Rethink ClientAuthorization endpoint returned 404", caught && caught.safe);
    check("NO log line contains the bearer token", !lines.some((l) => l.includes(TOKEN)));
    check("NO log line contains an Authorization header", !lines.some((l) => /Authorization:/i.test(l)));
    check("NO log line contains the client secret", !lines.some((l) => l.includes(SECRET)));

    // --- 401 on a data endpoint -------------------------------------------
    lines.length = 0;
    console.log = capture; console.error = capture;
    calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls % 2 === 1) return { ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ access_token: TOKEN, expires_in: 3600 }) };
      return { ok: false, status: 401, headers: { get: () => null }, text: async () => "unauthorized" };
    };
    realClient.invalidateToken();
    caught = null;
    try { await realClient.dwhGet("Appointments", {}, { nowMs: 1 }); } catch (e) { caught = e; }
    console.log = realLog; console.error = realErr;

    check("a 401 on a data endpoint produces an authentication message",
      caught && /authentication failed \(401\)/.test(caught.safe), caught && caught.safe);
    check("the retry/re-auth is visible in the log", lines.some((l) => /re-authenticating/.test(l)));
    check("still no token in the log after a re-auth cycle", !lines.some((l) => l.includes(TOKEN)));

    // --- a successful response body is never logged ------------------------
    lines.length = 0;
    console.log = capture; console.error = capture;
    calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ access_token: TOKEN, expires_in: 3600 }) };
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => [{ clientId: "C1", firstName: "Ava", lastName: "Nguyen", dateOfBirth: "2019-04-02" }] };
    };
    realClient.invalidateToken();
    await realClient.dwhGet("Clients", {}, { nowMs: 1 });
    console.log = realLog; console.error = realErr;

    check("a successful request is logged", lines.some((l) => /stage=dwh_response_ok/.test(l)));
    check("the PHI in a SUCCESSFUL response body is never logged",
      !lines.some((l) => /Nguyen|Ava|2019-04-02/.test(l)), lines.join(" | ").slice(0, 200));

    // --- redaction as a last line of defence -------------------------------
    lines.length = 0;
    console.log = capture; console.error = capture;
    realClient.log("manual_test", { note: `secret=${SECRET} id=${ID} auth=Bearer ${TOKEN}` });
    console.log = realLog; console.error = realErr;
    check("redact() strips a credential even if a caller passes one in",
      !lines.some((l) => l.includes(SECRET) || l.includes(ID) || l.includes(TOKEN)), lines.join(" | "));
    check("and leaves a visible marker that something was removed",
      lines.some((l) => /\[redacted\]/.test(l)), lines.join(" | "));

    restore();
  }

  // The sanitised message the browser receives must never carry an upstream
  // body, which we cannot promise is PHI-free.
  {
    const e = new realClient.RethinkError("boom", {
      status: 500, endpoint: "Appointments", upstream: "patient Ava Nguyen not found",
      safe: "Rethink Appointments request failed (500)",
    });
    check("the upstream body is kept server-side on the error object", e.upstream.includes("Ava"));
    check("the browser-safe message excludes the upstream body", !e.safe.includes("Ava"), e.safe);
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

    const { normName, splitName, validateClientFields, CLIENT_FIELDS } = initRethink(ctx)._internal;
    check("names fold accents and case", normName("José") === normName("JOSE"));
    check("names drop punctuation", normName("O'Brien-Smith") === "obrien smith");
    check("names drop generational suffixes", normName("John Smith Jr.") === "john smith");
    check("a two-part name splits into first and last",
      splitName("Ava Nguyen").first === "ava" && splitName("Ava Nguyen").last === "nguyen");
    check("a three-part name keeps the last token as the surname",
      splitName("Ana Maria Lopez").first === "ana maria" && splitName("Ana Maria Lopez").last === "lopez");
    check("a single-token name has no surname", splitName("Cher").last === "");
    // Pins the documented Swagger schema. If any of these change, this fails
    // rather than the integration quietly matching nobody in production.
    check("client schema is exactly the documented Swagger fields",
      CLIENT_FIELDS.id === "clientId" && CLIENT_FIELDS.first === "firstName"
        && CLIENT_FIELDS.last === "lastName" && CLIENT_FIELDS.dob === "dateOfBirth"
        && CLIENT_FIELDS.status === "status", JSON.stringify(CLIENT_FIELDS));
    check("a complete client row validates",
      validateClientFields({ clientId: 1, firstName: "a", lastName: "b", dateOfBirth: "c", status: "d" }).missing.length === 0);
    check("a client row missing DOB is reported as missing dateOfBirth",
      validateClientFields({ clientId: 1, firstName: "a", lastName: "b" }).missing.join() === "dateOfBirth");
    check("status is informational, so its absence does not fail validation",
      validateClientFields({ clientId: 1, firstName: "a", lastName: "b", dateOfBirth: "c" }).missing.length === 0);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
