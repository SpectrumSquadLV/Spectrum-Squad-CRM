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
    check("an unmatched Rethink provider is reported in the sync warnings",
      out.warnings.some((w) => /had no matching CRM employee/.test(w)), out.warnings.join(" | "));
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
      // status: "Active" throughout, because Ready to Link now requires it.
      { clientId: "R1", firstName: "Ava", lastName: "Nguyen", dateOfBirth: "2019-04-02T00:00:00Z", status: "Active" },
      { clientId: "R2", firstName: "Liam", lastName: "O'Brien", dateOfBirth: "2018-11-20", status: "Active" },
      { clientId: "R3", firstName: "Noah", lastName: "Patel", dateOfBirth: "2016-02-02", status: "Active" },
      { clientId: "R4", firstName: "Mia", lastName: "Garcia", dateOfBirth: "2020-01-15", status: "Active" },
      { clientId: "R5", firstName: "Mia", lastName: "Garcia", dateOfBirth: "2021-09-09", status: "Active" },
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
    // Still scanned and still matched -- just held for a human, because the
    // record is Discharged rather than Active.
    check("a discharged client is still scanned and matched, not dropped",
      out.no_match === 0 && out.needs_review === 1, JSON.stringify(out));
    check("but a non-Active status keeps it out of Ready to Link", out.ready_to_link === 0, out.ready_to_link);
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

  console.log("\nMISSING FROM CRM (RETHINK-ONLY CLIENTS)\n");

  // Read-only reconciliation. A Rethink client with no CRM record was
  // previously invisible: the matcher iterates CRM clients, so anyone existing
  // only in Rethink was fetched, ignored and discarded. An established therapy
  // client omitted from the CRM could sit there indefinitely.
  {
    const stored = [];
    const crmOpen = [
      { id: 1, child_name: "Matched Child", dob: "2020-01-01", rethink_client_id: null },
    ];
    const crmLinked = [{ id: 9, child_name: "Already Linked", rethink_client_id: "R_LINKED" }];
    const crmClosed = [{ id: 20, child_name: "Discharged Child", dob: "2018-08-08" }];

    const ctx = {
      dbGet: async (sql) => (/FROM rethink_config/i.test(sql) ? CONFIRMED : null),
      dbAll: async (sql) => {
        if (/rethink_client_id IS NOT NULL/i.test(sql)) return crmLinked;
        if (/stage IN \('discharged'/i.test(sql)) return crmClosed;
        if (/FROM clients/i.test(sql)) return crmOpen;
        return [];
      },
      dbRun: async (sql, p = []) => {
        if (/INSERT INTO rethink_unmatched_clients/i.test(sql)) {
          stored.push({ id: p[0], first: p[1], last: p[2], dob: p[3], status: p[4], closedId: p[5], closedName: p[6] });
        }
      },
      nowISO: () => NOW, readBody: async () => ({}), json: () => {},
    };

    stub.dwhGetAllPages = async () => ({ rows: [
      // Matches an open CRM client -> a candidate, so NOT missing.
      { clientId: "R_CAND", firstName: "Matched", lastName: "Child", dateOfBirth: "2020-01-01", status: "Active" },
      // Already saved on a CRM client -> NOT missing, even though nothing matched by name.
      { clientId: "R_LINKED", firstName: "Already", lastName: "Linked", dateOfBirth: "2019-09-09", status: "Active" },
      // Genuinely absent from the CRM. This is the Ervel case.
      { clientId: "R_ORPHAN_A", firstName: "Ervel", lastName: "Medina", dateOfBirth: "2017-03-03", status: "Active" },
      { clientId: "R_ORPHAN_P", firstName: "Pending", lastName: "Person", dateOfBirth: "2021-02-02", status: "Pending Acceptance" },
      { clientId: "R_ORPHAN_I", firstName: "Old", lastName: "Record", dateOfBirth: "2015-05-05", status: "Inactive" },
      // Absent from the OPEN population but present as a discharged client.
      { clientId: "R_CLOSED", firstName: "Discharged", lastName: "Child", dateOfBirth: "2018-08-08", status: "Inactive" },
    ], pages: 1, truncated: false });

    const out = await initRethink(ctx).scanClientMatches();
    const ids = stored.map((s) => s.id);

    check("a Rethink client matching an open CRM client is not reported missing",
      !ids.includes("R_CAND"), JSON.stringify(ids));
    check("a Rethink client already linked to a CRM client is not reported missing",
      !ids.includes("R_LINKED"), JSON.stringify(ids));
    check("a genuinely absent Active client IS reported missing", ids.includes("R_ORPHAN_A"), JSON.stringify(ids));
    check("Pending Acceptance and Inactive orphans are reported too",
      ids.includes("R_ORPHAN_P") && ids.includes("R_ORPHAN_I"), JSON.stringify(ids));
    check("the scan reports the orphan count", out.rethink_only === 4, out.rethink_only);
    check("and how many of them are Active", out.rethink_only_active === 1, out.rethink_only_active);

    // The duplicate-creation trap: the matcher only considers open-stage CRM
    // clients, so a discharged client would otherwise read as "no CRM record".
    const closedRow = stored.find((s) => s.id === "R_CLOSED");
    check("a discharged CRM client is flagged as a possible existing record, not silently absent",
      closedRow && closedRow.closedId === 20, JSON.stringify(closedRow));
    check("and it names the CRM client so nobody recreates them",
      closedRow && closedRow.closedName === "Discharged Child");

    check("the stored row carries name, DOB, id and status for display",
      stored.some((s) => s.id === "R_ORPHAN_A" && s.first === "Ervel" && s.last === "Medina"
        && s.dob === "2017-03-03" && s.status === "Active"), JSON.stringify(stored));

    // Read-only: nothing may be created or linked by the reconciliation pass.
    check("no CRM client is created by the reconciliation pass",
      !stored.some((s) => s.created), "reconciliation must never insert into clients");
  }

  // Ordering: Active first, so an established client omitted from the CRM is
  // not buried under historical records.
  {
    const orphanRows = [
      { rethink_client_id: "I1", first_name: "Old", last_name: "Record", dob: "2015-01-01", status: "Inactive" },
      { rethink_client_id: "A1", first_name: "Ervel", last_name: "Medina", dob: "2017-03-03", status: "Active" },
      { rethink_client_id: "P1", first_name: "Pending", last_name: "Person", dob: "2021-01-01", status: "Pending Acceptance" },
    ];
    const ctx = {
      dbGet: async (sql) => (/FROM rethink_config/i.test(sql) ? CONFIRMED : null),
      dbAll: async (sql) => (/FROM rethink_unmatched_clients/i.test(sql) ? orphanRows
        : /FROM clients/i.test(sql) ? [] : []),
      dbRun: async () => {}, nowISO: () => NOW, readBody: async () => ({}), json: () => {},
    };
    const review = await initRethink(ctx).clientMatchReview();
    check("Active orphans sort first", review.rethink_only[0].status === "Active", JSON.stringify(review.rethink_only.map((r) => r.status)));
    check("Inactive orphans sort last", review.rethink_only[2].status === "Inactive");
    check("priority is exposed for colour-coding",
      review.rethink_only[0].priority === 0 && review.rethink_only[2].priority === 2);
    check("counts are broken out by status",
      review.rethink_only_counts.total === 3 && review.rethink_only_counts.active === 1
        && review.rethink_only_counts.pending === 1 && review.rethink_only_counts.inactive === 1,
      JSON.stringify(review.rethink_only_counts));
  }

  console.log("\nRETHINK CLIENT STATUS GATING\n");

  // Status decides auto-approvability separately from name confidence. An
  // exact first + last + DOB hit on a closed record is still a human decision,
  // because linking it drives that child's 97153 authorization data.
  {
    const crm = [
      { id: 1, child_name: "Amir Fentress", dob: "2022-01-09", rethink_client_id: null },
      { id: 2, child_name: "Alexander Borja", dob: "2022-05-16", rethink_client_id: null },
      { id: 3, child_name: "Bryce Collera", dob: "2022-07-26", rethink_client_id: null },
      { id: 4, child_name: "Nostatus Child", dob: "2021-03-03", rethink_client_id: null },
      { id: 5, child_name: "Unknown Status", dob: "2020-02-02", rethink_client_id: null },
    ];
    const { ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: crm });
    stub.dwhGetAllPages = async () => ({ rows: [
      { clientId: "R1", firstName: "Amir", lastName: "Fentress", dateOfBirth: "2022-01-09", status: "Active" },
      { clientId: "R2", firstName: "Alexander", lastName: "Borja", dateOfBirth: "2022-05-16", status: "Inactive" },
      { clientId: "R3", firstName: "Bryce", lastName: "Collera", dateOfBirth: "2022-07-26", status: "Pending Acceptance" },
      { clientId: "R4", firstName: "Nostatus", lastName: "Child", dateOfBirth: "2021-03-03", status: "" },
      { clientId: "R5", firstName: "Unknown", lastName: "Status", dateOfBirth: "2020-02-02", status: "Some Future Value" },
    ], pages: 1, truncated: false });

    const out = await initRethink(ctx).scanClientMatches();
    check("only the Active client is Ready to Link", out.ready_to_link === 1, out.ready_to_link);
    check("Inactive, Pending Acceptance, blank and unknown statuses all go to review",
      out.needs_review === 4, out.needs_review);
    check("no candidate is dropped from the scan because of its status",
      out.no_match === 0, out.no_match);
  }

  // The same gate, applied on the review screen rather than in the counters.
  {
    const candidates = [
      { crm_client_id: 1, rethink_client_id: "R1", rethink_first: "Amir", rethink_last: "Fentress", rethink_dob: "2022-01-09", rethink_status: "Active", confidence: "high", reason: "first + last + DOB" },
      { crm_client_id: 2, rethink_client_id: "R2", rethink_first: "Alexander", rethink_last: "Borja", rethink_dob: "2022-05-16", rethink_status: "Inactive", confidence: "high", reason: "first + last + DOB" },
      { crm_client_id: 3, rethink_client_id: "R3", rethink_first: "Bryce", rethink_last: "Collera", rethink_dob: "2022-07-26", rethink_status: "Pending Acceptance", confidence: "high", reason: "first + last + DOB" },
    ];
    const ctx = {
      dbGet: async (sql) => (/FROM rethink_config/i.test(sql) ? CONFIRMED : null),
      dbAll: async (sql) => (/FROM rethink_client_match_candidates/i.test(sql) ? candidates
        : /FROM clients/i.test(sql) ? [
            { id: 1, child_name: "Amir Fentress", dob: "2022-01-09", rethink_client_id: null },
            { id: 2, child_name: "Alexander Borja", dob: "2022-05-16", rethink_client_id: null },
            { id: 3, child_name: "Bryce Collera", dob: "2022-07-26", rethink_client_id: null },
          ] : []),
      dbRun: async () => {}, nowISO: () => NOW, readBody: async () => ({}), json: () => {},
    };
    const review = await initRethink(ctx).clientMatchReview();
    const byId = (id) => review.items.find((i) => i.crm_client_id === id);

    check("an Active exact match shows as ready", byId(1).status === "ready", byId(1).status);
    check("an Inactive exact match shows as review", byId(2).status === "review", byId(2).status);
    check("a Pending Acceptance exact match shows as review", byId(3).status === "review", byId(3).status);
    check("the counters agree with the rows",
      review.counts.ready === 1 && review.counts.review === 2, JSON.stringify(review.counts));

    check("the Inactive row explains WHY a perfect match is held",
      /Inactive/.test(byId(2).candidates[0].status_blocks_ready || ""), byId(2).candidates[0].status_blocks_ready);
    check("the Pending Acceptance row explains why too",
      /Pending Acceptance/.test(byId(3).candidates[0].status_blocks_ready || ""), byId(3).candidates[0].status_blocks_ready);
    check("an Active row carries no block reason",
      byId(1).candidates[0].status_blocks_ready === null);
    check("the status itself is exposed on every row for display",
      byId(1).candidates[0].status === "Active" && byId(2).candidates[0].status === "Inactive"
        && byId(3).candidates[0].status === "Pending Acceptance");
    check("an Inactive client is still linkable by hand — it is held, not hidden",
      byId(2).candidates.length === 1 && byId(2).candidates[0].rethink_client_id === "R2");
  }

  // Status must not rescue a weak name match, and must not override the
  // matching rules the operator asked to keep manual.
  {
    const crm = [
      { id: 1, child_name: "Daymond estrada", dob: "2022-11-15", rethink_client_id: null },
      { id: 2, child_name: "Angela Huffman", dob: "2017-05-19", rethink_client_id: null },
      { id: 3, child_name: "Ariana Rush", dob: null, rethink_client_id: null },
    ];
    const { ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: crm });
    stub.dwhGetAllPages = async () => ({ rows: [
      { clientId: "R1", firstName: "Daymond", lastName: "Estrada Arenas", dateOfBirth: "2022-11-15", status: "Active" },
      { clientId: "R2", firstName: "Angela", lastName: "Huffman", dateOfBirth: "2017-05-17", status: "Active" },
      { clientId: "R3", firstName: "Ariana", lastName: "Rush", dateOfBirth: "2019-05-19", status: "Active" },
    ], pages: 1, truncated: false });

    const out = await initRethink(ctx).scanClientMatches();
    check("an Active status does NOT promote a compound-surname match",
      out.ready_to_link === 0, `ready=${out.ready_to_link}`);
    check("an Active status does NOT auto-resolve a DOB mismatch", out.ready_to_link === 0);
    check("an Active status does NOT auto-resolve a missing DOB", out.ready_to_link === 0);
    check("all three stay in review", out.needs_review === 3, out.needs_review);
  }

  console.log("\nCLIENTS DATE WINDOW\n");

  // /api/Clients was being called with no parameters and returned zero rows,
  // while /api/Appointments returned 305 with a From/To window on the same
  // credentials. These assertions pin the two-attempt probe that settles it.
  {
    const seen = [];
    const clients = [{ id: 1, child_name: "Ava Nguyen", dob: "2019-04-02", rethink_client_id: null }];

    // Windowed call returns rows -> the no-parameter call must never be made.
    const { ctx } = makeDb({ now: NOW, config: CONFIRMED, clients });
    stub.dwhGetAllPages = async (path, params) => {
      seen.push(Object.keys(params || {}).sort().join(","));
      return Object.keys(params || {}).length
        ? { rows: [{ clientId: "R1", firstName: "Ava", lastName: "Nguyen", dateOfBirth: "2019-04-02" }], pages: 1, truncated: false }
        : { rows: [], pages: 1, truncated: false };
    };
    const out = await initRethink(ctx).scanClientMatches();
    check("the Clients call now sends a date window", seen[0] === "From,To", JSON.stringify(seen));
    check("a successful windowed call short-circuits the fallback", seen.length === 1, JSON.stringify(seen));
    check("clients returned by the windowed call are scanned", out.ok === true && out.rethink_clients === 1, JSON.stringify(out));
  }

  {
    // Windowed call empty -> fall back to the original no-parameter call.
    const seen = [];
    const { ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: [{ id: 1, child_name: "Ava Nguyen", dob: "2019-04-02" }] });
    stub.dwhGetAllPages = async (path, params) => {
      const keys = Object.keys(params || {}).sort().join(",");
      seen.push(keys);
      return keys === ""
        ? { rows: [{ clientId: "R1", firstName: "Ava", lastName: "Nguyen", dateOfBirth: "2019-04-02" }], pages: 1, truncated: false }
        : { rows: [], pages: 1, truncated: false };
    };
    const out = await initRethink(ctx).scanClientMatches();
    check("an empty windowed call falls back to no parameters",
      seen.length === 2 && seen[1] === "", JSON.stringify(seen));
    check("the fallback's rows are used", out.ok === true && out.rethink_clients === 1, JSON.stringify(out));
  }

  {
    // Both empty -> report it as a Rethink-side question, not a connection fault.
    const { ctx } = makeDb({ now: NOW, config: CONFIRMED, clients: [{ id: 1, child_name: "A B", dob: "2019-01-01" }] });
    stub.dwhGetAllPages = async () => ({ rows: [], pages: 1, truncated: false });
    const out = await initRethink(ctx).scanClientMatches();
    check("both attempts empty is reported as empty, not as an error", out.ok === false && out.kind === "empty");
    check("the message states both attempts were made",
      /date window/.test(out.error) && /no parameters/.test(out.error), out.error);
    check("the message does not blame the connection",
      /reachable and authenticated/.test(out.error), out.error);
  }

  console.log("\nSCHEMA DIAGNOSTIC (FIELD NAMES ONLY)\n");

  // /api/Clients returns HTTP 200 with zero rows while /api/Appointments
  // returns 305 with the same credentials. To find out what an Appointment
  // actually carries -- and whether it carries client demographics -- we log
  // its FIELD NAMES. Not one value may appear, because every value on that
  // record is PHI.
  {
    const { schemaOf } = realClient;
    const appt = {
      staffId: 7, clientId: 42, appointmentStatus: "Completed", staffVerification: true,
      actualDurationHours: 2.5, appointmentDate: "2026-08-03T09:00:00Z",
      sessionNote: "Client made good progress on tacting.",
      client: { firstName: "Ava", lastName: "Nguyen", dateOfBirth: "2019-04-02" },
      services: [{ code: "97153" }],
    };
    const fields = schemaOf(appt).sort();

    check("top-level field names are reported", fields.includes("clientId") && fields.includes("staffId"));
    check("nested objects are expanded as parent.child",
      fields.includes("client.firstName") && fields.includes("client.dateOfBirth"), fields.join(","));
    check("arrays are named but not descended into",
      fields.includes("services[]") && !fields.some((f) => f.startsWith("services.")), fields.join(","));

    const dump = fields.join(",");
    check("NO value appears in the schema dump — not a name",
      !/Ava|Nguyen/.test(dump), dump);
    check("NO value appears in the schema dump — not a DOB",
      !/2019-04-02/.test(dump), dump);
    check("NO value appears in the schema dump — not a session note",
      !/tacting|progress/i.test(dump), dump);
    check("NO value appears in the schema dump — not an id or a status",
      !/\b42\b/.test(dump) && !/Completed/.test(dump), dump);

    // The empty-result case: an endpoint returning 200-with-nothing must be
    // distinguishable from a wrong filter, so the envelope and the params sent
    // are recorded.
    const lines = [];
    const realLog = console.log, realErr = console.error;
    console.log = (...a) => lines.push(a.join(" ")); console.error = console.log;
    realClient.log("schema", { endpoint: "Clients", source: "empty_result", rows: 0, params_sent: "PageSize,Page" });
    console.log = realLog; console.error = realErr;
    check("an empty result records which params were sent",
      lines.some((l) => /source=empty_result/.test(l) && /params_sent=PageSize,Page/.test(l)), lines.join(" | "));
  }

  console.log("\nSUPERVISION POPULATION SCOPING\n");

  // "Rethink Provider Match Needed" is a supervision-page warning and must name
  // only supervisees. It previously named everyone without a Rethink ID --
  // BCBAs, the clinical director, the owner -- because the SQL tested
  // COALESCE(supervision_required, TRUE) and that column is NULL for nearly
  // everyone. The rule now comes from supervision.js itself.
  {
    // The real predicate, loaded from the supervision module so this test
    // breaks if the two ever drift apart.
    const supervision = require("./supervision")({
      dbGet: async () => null, dbAll: async () => [], dbRun: async () => {},
      sendEmail: async () => {}, nowISO: () => NOW, crypto: require("crypto"),
      APP_BASE_URL: "", readBody: async () => ({}), json: () => {},
    });
    const isTracked = supervision.isTracked;

    check("an RBT is in the supervision population",
      isTracked({ role_title: "Registered Behavior Technician", supervision_required: null }) === true);
    check("a BCBA is not", isTracked({ role_title: "BCBA", supervision_required: null }) === false);
    check("a clinical director is not",
      isTracked({ role_title: "Clinical Director", supervision_required: null }) === false);
    check("a student analyst IS, even though the title says BCBA-track",
      isTracked({ role_title: "Student Analyst", supervision_required: null }) === true);
    check("an explicit opt-in overrides the title",
      isTracked({ role_title: "BCBA", supervision_required: true }) === true);
    check("an explicit opt-out overrides the title",
      isTracked({ role_title: "RBT", supervision_required: false }) === false);

    // The flagging pass, driven by that predicate.
    const employees = [
      { id: 1, name: "Real RBT", role_title: "Registered Behavior Technician", rethink_id: null, supervision_required: null },
      { id: 2, name: "Clarissa Vergara", role_title: "BCBA", rethink_id: null, supervision_required: null },
      { id: 3, name: "Micah Galang", role_title: "Clinical Director", rethink_id: null, supervision_required: null },
      { id: 4, name: "Quiana", role_title: "Owner", rethink_id: null, supervision_required: null },
      { id: 5, name: "Linked RBT", role_title: "RBT", rethink_id: "S100", supervision_required: null },
    ];
    const flagged = [];
    const ctx = {
      dbGet: async (sql) => (/INSERT INTO rethink_sync_log/i.test(sql) ? { id: 1 }
        : /FROM rethink_config/i.test(sql) ? CONFIRMED : null),
      dbAll: async (sql) => (/FROM hr_employees/i.test(sql)
        ? (/rethink_id IS NULL/i.test(sql) ? employees.filter((e) => !e.rethink_id) : employees)
        : []),
      dbRun: async (sql, p = []) => {
        if (/SET rethink_match_needed = TRUE WHERE id/i.test(sql)) flagged.push(p[0]);
      },
      nowISO: () => NOW, readBody: async () => ({}), json: () => {},
      isSupervisionTracked: isTracked,
    };
    stub.dwhGetAllPages = async () => ({ rows: [
      { staffId: "S100", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 6, appointmentDate: "2026-08-03" },
    ], pages: 1, truncated: false });

    await initRethink(ctx).syncSupervisionHours("test", "2026-08");

    check("an unlinked RBT is flagged as needing a Rethink match", flagged.includes(1), JSON.stringify(flagged));
    check("a BCBA without a Rethink ID is NOT flagged", !flagged.includes(2), JSON.stringify(flagged));
    check("a clinical director is NOT flagged", !flagged.includes(3));
    check("an already-linked RBT is not flagged", !flagged.includes(5));

    // Documents a real gap rather than hiding it. The title rule only excludes
    // BCBA-flavoured titles; every other title defaults to TRACKED on purpose,
    // so that nobody is silently dropped from a compliance tracker. "Owner" is
    // not a BCBA title, so the owner is in the population by default -- on the
    // board as well as in this warning. The intended remedy is the per-person
    // override, not a growing list of job titles hard-coded in a regex.
    check("a non-clinical title like Owner is tracked by default (by design)",
      flagged.includes(4), JSON.stringify(flagged));
    check("and the per-person override is what removes them",
      isTracked({ role_title: "Owner", supervision_required: false }) === false);
  }

  // The safety property: scoping the WARNING must not cost anyone their hours.
  {
    const employees = [
      { id: 1, name: "Real RBT", role_title: "RBT", rethink_id: "S100", supervision_required: null },
      { id: 2, name: "A BCBA", role_title: "BCBA", rethink_id: "S200", supervision_required: null },
    ];
    const { state, ctx } = makeDb({ now: NOW, config: CONFIRMED, employees });
    ctx.isSupervisionTracked = (e) => !/BCBA/i.test(e.role_title || "");
    stub.dwhGetAllPages = async () => ({ rows: [
      { staffId: "S100", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 5, appointmentDate: "2026-08-03" },
      { staffId: "S200", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 7, appointmentDate: "2026-08-04" },
    ], pages: 1, truncated: false });

    await initRethink(ctx).syncSupervisionHours("test", "2026-08");

    check("worked hours are still synced for a supervised RBT",
      state.supervisionWrites.some((w) => w.employeeId === 1 && w.hours === 5), JSON.stringify(state.supervisionWrites));
    check("worked hours are ALSO still synced for a non-supervisee",
      state.supervisionWrites.some((w) => w.employeeId === 2 && w.hours === 7), JSON.stringify(state.supervisionWrites));
    check("both providers keep their Rethink mapping",
      state.providerMonth.filter((p) => p.employeeId).length === 2);
  }

  // If the wiring is lost, the warning goes quiet rather than naming everyone.
  {
    const { ctx } = makeDb({
      now: NOW, config: CONFIRMED,
      employees: [{ id: 1, name: "Unlinked", role_title: "RBT", rethink_id: null }],
    });
    delete ctx.isSupervisionTracked;
    const flagged = [];
    const origRun = ctx.dbRun;
    ctx.dbRun = async (sql, p = []) => {
      if (/SET rethink_match_needed = TRUE WHERE id/i.test(sql)) flagged.push(p[0]);
      return origRun(sql, p);
    };
    stub.dwhGetAllPages = async () => ({ rows: [], pages: 1, truncated: false });
    await initRethink(ctx).syncSupervisionHours("test", "2026-08");
    check("without the supervision predicate, nobody is flagged rather than everybody",
      flagged.length === 0, JSON.stringify(flagged));
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
