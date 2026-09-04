// The appointment-activity fallback.
//
// This Rethink account's /api/Clients returns HTTP 200 with an empty result,
// and so does /api/ClientAuthorization, while /api/Appointments returns rows on
// the same token. So "who is actually in therapy" is read off the schedule
// instead of off a client list we cannot see.
//
// That makes this a fallback built on a thinner source than the one it stands
// in for, and the assertions that matter are about what it therefore REFUSES to
// do. Appointments carries no name, no date of birth and no home address:
//
//   * it must never write an address -- the addresses on this endpoint are
//     appointment and EVV locations, not where a family lives
//   * it must never overwrite an insurance provider somebody typed
//   * it must not pick a funder when the appointments disagree about who pays
//   * it must not claim to identify an unlinked client it can only count
//
// A client with no sessions in the window is reported, never written off: a
// child on a school break is not a discharged child.
//
//   node test-rethink-activity.js
"use strict";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

// ---- stub the transport so no network call is ever attempted --------------
const clientPath = require.resolve("./rethink-client");
const realClient = require("./rethink-client");
const stub = {
  configured: () => true,
  redact: realClient.redact,
  log: () => {},
  snippet: realClient.snippet,
  safeMessage: realClient.safeMessage,
  configState: realClient.configState,
  tokenState: () => ({ has_token: true, valid: true, expires_in_seconds: 3000 }),
  endpoints: realClient.endpoints,
  RethinkError: realClient.RethinkError,
  extractRows: realClient.extractRows,
  dwhGetAllPages: async () => ({ rows: [], pages: 1, truncated: false }),
  dwhGet: async () => ({}),
  getToken: async () => "stub",
  invalidateToken: () => {},
};
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: stub };

const initRethink = require("./rethink.js");

const NOW = "2026-09-03T12:00:00.000Z";

// A fake database that understands only the statements this path issues, and
// records every write WITH ITS SQL. Reading a parameter by position is how an
// earlier suite in this repo asserted the wrong thing for a while; matching on
// the column name in the statement cannot drift the same way.
function makeCtx(state) {
  return {
    nowISO: () => NOW,
    readBody: async () => ({}),
    json: async () => {},
    async dbGet() { return undefined; },
    async dbAll(sql) {
      if (/FROM clients/.test(sql) && /rethink_client_id IS NOT NULL/.test(sql)) {
        state.lastLinkedSql = sql;
        // Deliberately does NOT filter on stage: the statement selects every
        // linked client and the module partitions open from closed itself, so
        // a fake that pre-filtered would hide the closed-but-active case.
        return state.clients
          .filter((c) => c.rethink_client_id && String(c.rethink_client_id).trim())
          .map((c) => ({
            id: c.id, child_name: c.child_name, stage: c.stage || "active",
            insurance_provider: c.insurance_provider, rethink_client_id: c.rethink_client_id,
          }));
      }
      return [];
    },
    async dbRun(sql, p = []) {
      state.sql.push(sql);
      const m = sql.match(/UPDATE clients SET (.+?) WHERE id = \?/s);
      if (m) {
        const cols = m[1].split(",").map((x) => x.trim().split("=")[0].trim());
        const c = state.clients.find((x) => x.id === p[p.length - 1]);
        if (c) cols.forEach((col, i) => { c[col] = p[i]; state.writes.push({ id: c.id, field: col, value: p[i] }); });
      }
      if (/UPDATE rethink_config SET last_activity_scan_at/.test(sql)) {
        state.config = { last_activity_scan_at: p[0], last_activity_window_days: p[1] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}
const freshState = () => ({ clients: [], writes: [], sql: [], config: null, lastLinkedSql: "" });

// Two children on the books, one of them with two sessions.
const APPTS = [
  { clientId: "R-100", appointmentDate: "2026-08-30T00:00:00", funder: "Silver State Health" },
  { clientId: "R-100", appointmentDate: "2026-09-01T00:00:00", funder: "Silver State Health" },
  { clientId: "R-200", appointmentDate: "2026-08-11T00:00:00", funder: "Medicaid" },
  // A child receiving services that the CRM has never linked.
  { clientId: "R-999", appointmentDate: "2026-09-02T00:00:00", funder: "Medicaid" },
];
const feed = (rows, extra = {}) => { stub.dwhGetAllPages = async () => ({ rows, pages: 1, truncated: false, ...extra }); };

(async () => {
  // ============ the window ================================================
  section("The window is asked for, and reported back");
  {
    const s = freshState();
    const r = initRethink(makeCtx(s));
    let asked = null;
    stub.dwhGetAllPages = async (ep, params) => { asked = { ep, params }; return { rows: APPTS, pages: 1, truncated: false }; };
    const out = await r._activity.scanAppointmentActivity({ days: 30 });
    check("it reads the Appointments endpoint", asked.ep === "Appointments", asked.ep);
    check("cancelled and deleted sessions are excluded at the source, not filtered here",
      asked.params.IncludeCanceled === false && asked.params.IncludeDeleted === false, asked.params);
    check("the window ends today", out.window.to === "2026-09-03", out.window);
    check("and starts the requested number of days back", out.window.from === "2026-08-04", out.window);
    check("the default window is 90 days, not 30",
      r._activity.ACTIVITY_DAYS === 90, r._activity.ACTIVITY_DAYS);
  }

  // ============ aggregation ===============================================
  section("Sessions are grouped per child");
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    s.clients.push({ id: 2, child_name: "Bo", rethink_client_id: "R-200", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed(APPTS);
    const out = await r._activity.scanAppointmentActivity();

    check("every client with a session is counted", out.rethink_clients_with_activity === 3, out.rethink_clients_with_activity);
    check("both linked clients are seen as active", out.linked_active === 2, out);
    const ada = s.clients[0];
    check("the LATEST session date is recorded, not the first seen",
      ada.rethink_last_appointment_date === "2026-09-01", ada.rethink_last_appointment_date);
    check("the session count is recorded", ada.rethink_appointment_count === 2, ada.rethink_appointment_count);
    check("the scan stamps when it ran", !!ada.rethink_activity_synced_at, ada.rethink_activity_synced_at);
    check("and records the window it used on the config row",
      s.config && s.config.last_activity_window_days === 90, s.config);
  }

  // ============ what it must not write ====================================
  section("It never writes an address");
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    // An appointment carrying every address-shaped field this endpoint has.
    feed([{
      clientId: "R-100", appointmentDate: "2026-09-01T00:00:00", funder: "Silver State Health",
      appointmentLocationAddress: "700 Clinic Blvd", parentVerifiedAddress: "18 Rowan Way",
    }]);
    await r._activity.scanAppointmentActivity();
    const addressWrites = s.writes.filter((w) => /address/i.test(w.field) && w.field !== "rethink_last_appointment_date");
    check("an appointment location is NEVER written to the client's address",
      addressWrites.length === 0, addressWrites);
    check("nor is the EVV parent-verified address",
      !s.clients[0].address, s.clients[0].address);
  }

  section("It never overwrites an insurance provider a person typed");
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: "Corrected By Billing" });
    s.clients.push({ id: 2, child_name: "Bo", rethink_client_id: "R-200", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed(APPTS);
    const out = await r._activity.scanAppointmentActivity();
    check("THE VALUE BILLING TYPED SURVIVES",
      s.clients[0].insurance_provider === "Corrected By Billing", s.clients[0].insurance_provider);
    check("a blank one is filled from the funder", s.clients[1].insurance_provider === "Medicaid", s.clients[1].insurance_provider);
    check("and only the fill is counted", out.insurance_filled === 1, out.insurance_filled);
  }

  section("Disagreeing funders are reported, not guessed at");
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed([
      { clientId: "R-100", appointmentDate: "2026-08-30T00:00:00", funder: "Medicaid" },
      { clientId: "R-100", appointmentDate: "2026-09-01T00:00:00", funder: "Silver State Health" },
    ]);
    const out = await r._activity.scanAppointmentActivity();
    check("NOTHING is written when the appointments name two funders",
      s.clients[0].insurance_provider === null, s.clients[0].insurance_provider);
    check("the conflict is surfaced with both names so billing can settle it",
      out.insurance_conflicts.length === 1 && out.insurance_conflicts[0].funders.length === 2,
      out.insurance_conflicts);
    check("and it is not counted as a fill", out.insurance_filled === 0, out.insurance_filled);
  }

  // ============ a quiet client is not a discharged client ==================
  section("A client with no sessions is reported, never written off");
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    s.clients.push({ id: 2, child_name: "Quiet", rethink_client_id: "R-777", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed(APPTS);
    const out = await r._activity.scanAppointmentActivity();
    check("the quiet client is listed as idle", out.linked_idle === 1 && out.idle[0].name === "Quiet", out.idle);
    check("NOTHING on their record is touched -- a break is not a discharge",
      s.writes.filter((w) => w.id === 2).length === 0, s.writes.filter((w) => w.id === 2));
  }

  section("A future appointment is not reported as a session already held");
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed([
      { clientId: "R-100", appointmentDate: "2026-09-01T00:00:00", funder: "Medicaid" },
      // Rethink ignoring the To bound. The supervision sync guards against this
      // too, and here it would otherwise read as "last seen next week".
      { clientId: "R-100", appointmentDate: "2026-09-20T00:00:00", funder: "Medicaid" },
    ]);
    const out = await r._activity.scanAppointmentActivity();
    check("the last appointment is the one that has actually happened",
      s.clients[0].rethink_last_appointment_date === "2026-09-01", s.clients[0].rethink_last_appointment_date);
    check("the future one is not counted as a session held",
      s.clients[0].rethink_appointment_count === 1, s.clients[0].rethink_appointment_count);
    check("and it is reported rather than silently dropped",
      out.warnings.some((w) => /dated after today/.test(w)), out.warnings);
  }

  // The bug this catches: reporting a discharged client's live sessions as a
  // stranger the CRM has never heard of. Those are different problems -- one is
  // a missing record, the other is a discharge that did not reach Rethink --
  // and answering the second with the first sends somebody hunting for a child
  // whose record is already open in front of them.
  section("A client closed in the CRM but still being seen is its own finding");
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    s.clients.push({ id: 2, child_name: "Closed Carter", rethink_client_id: "R-200", stage: "discharged", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed(APPTS);
    const out = await r._activity.scanAppointmentActivity();
    check("they are NOT counted as a child with no CRM record",
      out.unlinked_active_count === 1 && out.unlinked_active[0].rethink_client_id === "R-999", out.unlinked_active);
    check("they are reported as closed-in-CRM-but-still-scheduled",
      out.closed_but_active_count === 1 && out.closed_but_active[0].name === "Closed Carter", out.closed_but_active);
    check("their stage is named so the reader knows which record to open",
      out.closed_but_active[0].stage === "discharged", out.closed_but_active[0]);
    check("and nothing on the closed record is written",
      s.writes.filter((w) => w.id === 2).length === 0, s.writes.filter((w) => w.id === 2));
    check("nor are they counted among the open clients", out.linked_total === 1, out.linked_total);
  }

  section("Discharged CRM clients are excluded by the query itself");
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Gone", rethink_client_id: "R-100", stage: "discharged", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed(APPTS);
    const out = await r._activity.scanAppointmentActivity();
    check("the statement reads stage, so closed clients can be told apart in code",
      /stage/.test(s.lastLinkedSql), s.lastLinkedSql.slice(0, 160));
    check("a discharged client is not counted among the open ones",
      out.linked_total === 0 && out.linked_active === 0, out);
  }

  // ============ the number this exists to produce ==========================
  section("Unlinked children are counted, and honestly not named");
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    s.clients.push({ id: 2, child_name: "Bo", rethink_client_id: "R-200", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed(APPTS);
    const out = await r._activity.scanAppointmentActivity();
    check("the child the CRM cannot account for is counted", out.unlinked_active_count === 1, out.unlinked_active_count);
    check("their Rethink id is given, because that is real", out.unlinked_active[0].rethink_client_id === "R-999", out.unlinked_active);
    check("NO NAME is invented for them -- Appointments does not carry one",
      !("name" in out.unlinked_active[0]), Object.keys(out.unlinked_active[0]));
    check("and nothing is created for them", s.writes.filter((w) => w.id > 2).length === 0, s.writes);
  }

  // ============ bad and empty input =======================================
  section("Malformed and empty responses");
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed([
      { appointmentDate: "2026-09-01T00:00:00", funder: "Medicaid" },       // no clientId
      { clientId: "R-100", appointmentDate: "2026-09-01T00:00:00", funder: "Silver State Health" },
    ]);
    const out = await r._activity.scanAppointmentActivity();
    check("a row with no clientId is skipped rather than crashing the run", out.ok === true, out);
    check("and the skip is reported instead of swallowed",
      out.warnings.some((w) => /no clientId/.test(w)), out.warnings);
  }
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed([]);
    const out = await r._activity.scanAppointmentActivity();
    check("an empty window fails loudly rather than reporting everybody idle", out.ok === false, out);
    check("the message says Appointments is the endpoint that still works",
      /Appointments is the one endpoint this account can read/.test(out.error), out.error);
    check("and NOTHING is written on an empty response", s.writes.length === 0, s.writes);
  }
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    stub.dwhGetAllPages = async () => { throw new realClient.RethinkError("Rethink is down.", { kind: "http", status: 503 }); };
    const out = await r._activity.scanAppointmentActivity();
    check("an upstream failure is reported, not thrown", out.ok === false && out.kind === "http", out);
    check("and writes nothing", s.writes.length === 0, s.writes);
  }
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed(APPTS, { truncated: true });
    const out = await r._activity.scanAppointmentActivity();
    check("a truncated fetch warns that the window may be incomplete",
      out.warnings.some((w) => /incomplete/.test(w)), out.warnings);
  }

  section("A dry run reads without writing");
  {
    const s = freshState();
    s.clients.push({ id: 1, child_name: "Ada", rethink_client_id: "R-100", insurance_provider: null });
    const r = initRethink(makeCtx(s));
    feed(APPTS);
    const out = await r._activity.scanAppointmentActivity({ dryRun: true });
    check("it still reports what it found", out.linked_active === 1, out);
    check("but touches nothing", s.writes.length === 0 && s.config === null, { writes: s.writes, config: s.config });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR:", e); process.exit(1); });
