// Rethink endpoint discovery -- find out what this account can actually read.
//
// WHY THIS EXISTS
//
// The CRM is being asked to show clinical programming (programs, targets,
// mastery) pulled from Rethink. Nobody here knows whether this account's DWH
// API exposes programming at all: the integration reads three endpoints --
// Appointments, Clients, ClientAuthorization -- and nothing in the codebase
// has ever asked for a fourth. The Clients schema was itself undocumented to
// us until somebody read the Swagger, and an earlier version of rethink.js
// sniffed keys and was deliberately rewritten to stop guessing.
//
// Building a programming sync against an invented schema would repeat exactly
// that mistake, at greater cost: tables, detection logic and parent emails all
// resting on a shape nobody confirmed. So this probes first and reports what
// is really there.
//
// WHAT IT DOES
//
// Asks for ONE ROW from each candidate endpoint and records three things:
// whether it answered, what its envelope counted, and THE NAMES OF THE KEYS
// the row carried. That is enough to decide whether a programming sync is
// possible and what to map it to.
//
// WHAT IT NEVER DOES
//
//   * No writes. GET only, so a probe cannot alter clinical data in Rethink.
//   * No VALUES are stored or shown -- only key names. Keys are structure;
//     values are PHI. This is the same line rethink-client.js already draws
//     ("Keys are structure, not PHI") and the reason a probe can be run by an
//     admin and read on a screen at all.
//   * No guessing dressed as fact. Every name below is a CANDIDATE. The point
//     of running it is to replace the guesses with an answer.
//
// CONTROLS
//
// The three endpoints the CRM already uses are probed alongside the
// candidates, and are marked as controls. Without them, a run that returns 404
// for everything is ambiguous: it could mean "this account has no programming
// endpoints" or "the probe is broken / the credentials are dead". If the
// controls come back and the candidates do not, the answer is the first one.

"use strict";

module.exports = function initRethinkDiscovery(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json, client, canManage } = ctx;

  // Endpoints the CRM already reads successfully. Probed as CONTROLS so a run
  // that finds nothing can be told apart from a run that failed.
  const KNOWN = ["Appointments", "Clients", "ClientAuthorization"];

  // CANDIDATES -- names that MIGHT exist. None of these is documented to us
  // and none should be treated as real until a probe says HTTP 200. They are
  // ordered roughly by how central they would be to a programming sync, since
  // the run stops at MAX_CANDIDATES and the useful ones should be reached
  // first.
  const CANDIDATES = [
    // Skill acquisition: programs and the targets under them.
    "ClientProgram", "ClientPrograms", "Program", "Programs",
    "ClientTarget", "ClientTargets", "Target", "Targets",
    "ClientGoal", "ClientGoals", "Goal", "Goals",
    "SkillAcquisition", "Curriculum",
    // Behaviour reduction.
    "ClientBehavior", "ClientBehaviors", "Behavior", "Behaviors",
    "BehaviorReduction", "BehaviorPlan",
    // The data behind either of the above -- baselines, trials, progress.
    "ClientProgress", "Progress", "ProgramData", "TargetData", "DataCollection",
    "ClientData", "TrialData",
    // Treatment planning, which in some products carries the goal list.
    "TreatmentPlan", "ClientTreatmentPlan", "ClientAssessment", "Assessment",
    // Session notes sometimes carry the programs run in that session.
    "SessionNote", "SessionNotes", "ClientSessionNote",
  ];

  // A cap, because every name here is a request to somebody else's API. Two
  // attempts each at most, so the ceiling is twice this.
  const MAX_CANDIDATES = 40;
  // Politeness gap between requests. The vendor rate-limits, and the client
  // retries on 429 -- better not to provoke it across a long run.
  // Injectable only so the suite is not spending real seconds sleeping
  // between stubbed calls; production never passes it.
  const GAP_MS = ctx.gapMs == null ? 250 : Number(ctx.gapMs) || 0;

  async function initTables() {
    // One row per endpoint name, replaced on each run rather than appended, so
    // the screen shows the current answer instead of a history nobody reads.
    await dbRun(`CREATE TABLE IF NOT EXISTS rethink_endpoint_probes (
      id SERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      is_control BOOLEAN DEFAULT FALSE,
      ok BOOLEAN,
      http_status INTEGER,
      error_kind TEXT,
      error_message TEXT,
      rows_seen INTEGER,
      envelope_counters TEXT,
      -- JSON array of KEY NAMES from the first row. Never values.
      row_keys TEXT,
      params_used TEXT,
      probed_at TEXT
    )`).catch((e) => console.error("rethink_endpoint_probes initTables:", e.message));
    await dbRun(`CREATE TABLE IF NOT EXISTS rethink_probe_runs (
      id SERIAL PRIMARY KEY,
      started_at TEXT,
      finished_at TEXT,
      actor TEXT,
      endpoints_tried INTEGER,
      endpoints_ok INTEGER,
      controls_ok INTEGER,
      note TEXT
    )`).catch((e) => console.error("rethink_probe_runs initTables:", e.message));
  }

  // The key names of the first row, sorted, capped. Sorted because the order a
  // vendor happens to serialise in is not information, and a stable order
  // makes two runs comparable at a glance.
  function keyNamesOf(rows) {
    const first = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!first || typeof first !== "object") return [];
    return Object.keys(first).map(String).sort().slice(0, 200);
  }

  // One endpoint, up to two shapes of request.
  //
  // Some endpoints refuse a bare call and want a date window -- that is how
  // ClientAuthorization behaved, and the attempt ladder written for it is the
  // precedent here. So: ask for a single row with no filter; if that is
  // refused as a BAD REQUEST specifically, ask again with a window. A 404 is
  // not retried, because "no such endpoint" is an answer, not a failure.
  async function probeOne(endpoint, { from, to }) {
    // PageSize is 500, NOT 1.
    //
    // The first live run asked for a single row -- as little as possible, which
    // seemed like the courteous thing -- and every one of the three endpoints
    // the CRM reads every day came back 400 while the candidates came back 404.
    // A known-good endpoint refusing the request is about the REQUEST, and the
    // only thing this probe sent that the working integration does not is
    // PageSize=1. So it now sends the shape that is proven to work in
    // production: Page 1, PageSize 500, exactly as dwhGetAllPages does.
    //
    // A page of rows costs a little bandwidth and buys the truth. Nothing is
    // kept from it: the key names come off row zero and the rows are dropped.
    const attempts = [
      { label: "page_1", params: { Page: 1, PageSize: 500 } },
      { label: "with_date_window", params: { Page: 1, PageSize: 500, From: from, To: to } },
    ];

    let last = null;
    for (const attempt of attempts) {
      try {
        const payload = await client.dwhGet(endpoint, attempt.params, { nowMs: Date.now() });
        let rows = [];
        // A 200 whose body is not a recognisable list is still a 200: the
        // endpoint EXISTS, which is the question being asked. Record it as
        // reachable with no rows read rather than throwing the answer away.
        try { rows = client.extractRows(payload, endpoint) || []; } catch (e) { rows = []; }
        return {
          ok: true,
          http_status: 200,
          rows_seen: rows.length,
          envelope_counters: client.envelopeCounters ? client.envelopeCounters(payload) : {},
          row_keys: keyNamesOf(rows),
          params_used: attempt.label,
          error_kind: null,
          error_message: null,
        };
      } catch (e) {
        last = {
          ok: false,
          http_status: e && e.status != null ? e.status : null,
          rows_seen: 0,
          envelope_counters: {},
          row_keys: [],
          params_used: attempt.label,
          exists: false,
          error_kind: (e && e.kind) || "error",
          // e.message is already redacted by RethinkError. e.upstream is NOT
          // and is deliberately left behind: we cannot promise an arbitrary
          // upstream body is free of PHI.
          error_message: String((e && e.message) || "").slice(0, 300),
        };
        // 404 means the name does not exist here. Asking again with a date
        // window cannot change that, and would just be a second request.
        if (last.http_status === 404) break;
        // 400 is not a miss. A route that does not exist answers 404 before
        // anything looks at the query string, so a 400 means THE ENDPOINT IS
        // THERE and refused the parameters -- which is a discovery, and worth
        // saying out loud rather than burying in a table of failures.
        if (last.http_status === 400) last.exists = true;
        // 401 is about the credential, not this endpoint. Every remaining
        // candidate would fail the same way, so let the caller stop.
        if (last.error_kind === "auth") { last.fatal = true; break; }
      }
    }
    return last;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Run the probe. Read-only, bounded, and safe to run twice.
  async function probeEndpoints(opts = {}) {
    if (!client.configured()) {
      return { ok: false, kind: "config", error: "Rethink credentials are not configured on the server." };
    }
    const actor = String(opts.actor || "unknown");
    const started = nowISO();
    // A month is enough for an endpoint that wants a window; this is looking
    // for a SHAPE, not for data.
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const extra = (Array.isArray(opts.extra_endpoints) ? opts.extra_endpoints : [])
      .map((s) => String(s).trim())
      // A path, not a URL: anything with a slash, scheme or query would let a
      // probe point somewhere other than the DWH base.
      .filter((s) => /^[A-Za-z][A-Za-z0-9_-]{0,60}$/.test(s))
      .slice(0, 10);

    const list = [
      ...KNOWN.map((e) => ({ endpoint: e, is_control: true })),
      ...[...new Set([...extra, ...CANDIDATES])].slice(0, MAX_CANDIDATES).map((e) => ({ endpoint: e, is_control: false })),
    ];

    client.log("probe_start", { endpoints: list.length, controls: KNOWN.length });

    const results = [];
    let stoppedEarly = null;
    for (const item of list) {
      const r = await probeOne(item.endpoint, { from, to });
      results.push(Object.assign({}, r, { endpoint: item.endpoint, is_control: item.is_control }));
      client.log("probe_result", {
        endpoint: item.endpoint, ok: r.ok, status: r.http_status,
        keys: (r.row_keys || []).length, control: item.is_control,
      });
      if (r.fatal) {
        // The credential is the problem. Carrying on would be forty more
        // requests all failing for the same reason.
        stoppedEarly = `Stopped after ${item.endpoint}: Rethink rejected our credentials, so every remaining endpoint would fail the same way.`;
        break;
      }
      await sleep(GAP_MS);
    }

    for (const r of results) {
      await dbRun(
        `INSERT INTO rethink_endpoint_probes
           (endpoint, is_control, ok, http_status, error_kind, error_message,
            rows_seen, envelope_counters, row_keys, params_used, probed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET
           is_control = EXCLUDED.is_control, ok = EXCLUDED.ok, http_status = EXCLUDED.http_status,
           error_kind = EXCLUDED.error_kind, error_message = EXCLUDED.error_message,
           rows_seen = EXCLUDED.rows_seen, envelope_counters = EXCLUDED.envelope_counters,
           row_keys = EXCLUDED.row_keys, params_used = EXCLUDED.params_used,
           probed_at = EXCLUDED.probed_at`,
        [r.endpoint, !!r.is_control, !!r.ok, r.http_status, r.error_kind, r.error_message,
         r.rows_seen || 0, JSON.stringify(r.envelope_counters || {}),
         JSON.stringify(r.row_keys || []), r.params_used, nowISO()]
      ).catch((e) => client.log("probe_store_failed", { endpoint: r.endpoint, error: e.message }));
    }

    const controlsOk = results.filter((r) => r.is_control && r.ok).length;
    const found = results.filter((r) => !r.is_control && r.ok);

    await dbRun(
      `INSERT INTO rethink_probe_runs (started_at, finished_at, actor, endpoints_tried, endpoints_ok, controls_ok, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [started, nowISO(), actor, results.length, found.length, controlsOk, stoppedEarly]
    ).catch(() => {});

    client.log("probe_done", { tried: results.length, found: found.length, controls_ok: controlsOk });

    return {
      ok: true,
      tried: results.length,
      controls_ok: controlsOk,
      controls_total: KNOWN.length,
      found: found.length,
      stopped_early: stoppedEarly,
      // The verdict, said in one sentence, because a table of forty 404s is
      // not an answer anybody can act on.
      verdict: verdictFor(results, controlsOk, stoppedEarly),
      results: results.map(shape),
    };
  }

  // What the run actually means. The controls are what make this sayable: a
  // wall of 404s means one thing when the known endpoints answered and quite
  // another when they did not.
  function verdictFor(results, controlsOk, stoppedEarly) {
    if (stoppedEarly) return stoppedEarly;
    const found = results.filter((r) => !r.is_control && r.ok);
    if (!controlsOk) {
      // The controls exist to catch exactly this. A wall of 404s means one
      // thing when the known-good endpoints answered and quite another when
      // they did not -- and on the first live run they did not, which is how
      // a bad request shape was caught instead of being reported as "Rethink
      // has no programming data".
      const why = results.filter((r) => r.is_control).map((r) => `${r.endpoint} ${r.http_status || r.error_kind}`).join(", ");
      return `None of the three endpoints the CRM already uses answered either (${why}), so this run says NOTHING about programming. A known-good endpoint failing is about the request, not the account — fix that and re-run before drawing any conclusion.`;
    }
    // A candidate that answered 400 EXISTS. Saying "none answered" over the
    // top of that would throw away the most useful thing the run found.
    const present = results.filter((r) => !r.is_control && !r.ok && r.exists);
    if (!found.length && present.length) {
      return `No candidate returned data, but ${present.length} answered 400 rather than 404 — ${
        present.map((r) => r.endpoint).join(", ")} EXIST on this account and refused the parameters we sent. That is a live lead: the next step is the right query for them, not a different name.`;
    }
    if (!found.length) {
      return `The ${controlsOk} endpoint(s) the CRM already uses answered normally, and none of the ${results.length - controlsOk} candidate programming endpoints did — every one returned 404, which is the API saying the name does not exist here. On this account, programming does not appear to be reachable through the DWH API under any of the names tried.`;
    }
    const withRows = found.filter((r) => (r.row_keys || []).length);
    return `${found.length} candidate endpoint(s) answered: ${found.map((r) => r.endpoint).join(", ")}. ` +
      (withRows.length
        ? `${withRows.length} returned a row, so their field names are listed below and can be mapped.`
        : "None returned a row, so the field names are still unknown — try a wider date window or a client who has programming.");
  }

  function shape(r) {
    return {
      endpoint: r.endpoint,
      is_control: !!r.is_control,
      ok: !!r.ok,
      http_status: r.http_status,
      error_kind: r.error_kind || null,
      error_message: r.error_message || null,
      // True when the endpoint answered 400: present, but not on the terms we
      // asked. Different from a 404, and a different next step.
      exists: !!r.exists,
      rows_seen: r.rows_seen || 0,
      envelope_counters: r.envelope_counters || {},
      row_keys: r.row_keys || [],
      params_used: r.params_used || null,
    };
  }

  // The last run, read back without probing anything.
  async function latestProbe() {
    const rows = await dbAll(
      `SELECT * FROM rethink_endpoint_probes ORDER BY is_control DESC, ok DESC, endpoint`
    ).catch(() => []);
    const run = await dbGet(
      "SELECT * FROM rethink_probe_runs ORDER BY id DESC LIMIT 1"
    ).catch(() => null);
    const parse = (v) => { try { const p = JSON.parse(v || "null"); return p == null ? undefined : p; } catch (e) { return undefined; } };
    return {
      ok: true,
      configured: client.configured(),
      last_run: run || null,
      results: rows.map((r) => ({
        endpoint: r.endpoint,
        is_control: !!r.is_control,
        ok: !!r.ok,
        http_status: r.http_status,
        error_kind: r.error_kind,
        error_message: r.error_message,
        rows_seen: Number(r.rows_seen) || 0,
        envelope_counters: parse(r.envelope_counters) || {},
        row_keys: parse(r.row_keys) || [],
        params_used: r.params_used,
        probed_at: r.probed_at,
      })),
    };
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/rethink/discovery")) return false;
    // Same tier as the rest of the Rethink admin surface. Checked on the
    // server, not by hiding a button.
    if (!canManage(user)) { json(res, 403, { error: "Owner or super admin only." }); return true; }

    if (pathname === "/api/rethink/discovery" && method === "GET") {
      json(res, 200, await latestProbe());
      return true;
    }

    if (pathname === "/api/rethink/discovery/probe" && method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      const actor = (user && (user.email || user.name)) || "unknown";
      // Who ran it and when is recorded by probeEndpoints itself, in
      // rethink_probe_runs. That row IS the audit record for this action --
      // the CRM other audit tables are for client authorizations and for
      // money, and an integration probe belongs in neither.
      const out = await probeEndpoints({ actor, extra_endpoints: b && b.extra_endpoints });
      json(res, out.ok ? 200 : 502, out);
      return true;
    }

    return false;
  }

  // Run the probe once, ever, without anybody pressing the button.
  //
  // THE OWNER ASKED FOR IT AND CANNOT BE THE ONE TO PRESS IT. The two things
  // a probe needs -- the Rethink credentials and network access to the vendor
  // -- exist only on the deployed server, so the person who wants the answer
  // and the machine that can get it are not the same place. This closes that
  // gap: the server asks on their behalf, once, and writes the answer where
  // the screen and the logs can both show it.
  //
  // ONCE, EVER. It runs only when no probe run has EVER been recorded, so a
  // restart, a redeploy or a crash loop cannot turn forty requests to somebody
  // else's API into four hundred. After the first run the button is the only
  // way to probe again, which is where that decision belongs.
  async function probeOnceOnBoot() {
    if (!client.configured()) return { ran: false, why: "not_configured" };
    // ONCE, EVER -- unless the once was inconclusive.
    //
    // A run whose CONTROLS failed answered nothing: it tells us the request was
    // wrong, not what Rethink holds. Treating that as "already probed" would
    // lock in a non-answer forever and leave the button as the only way out.
    // So a run only counts as done when at least one known-good endpoint
    // answered -- and, because that could otherwise retry on every boot
    // forever, three attempts is the ceiling.
    const prior = await dbAll(
      "SELECT controls_ok FROM rethink_probe_runs ORDER BY id"
    ).catch(() => []);
    if (prior.some((r) => Number(r.controls_ok) > 0)) return { ran: false, why: "already_probed" };
    if (prior.length >= 3) return { ran: false, why: "inconclusive_limit_reached" };

    const out = await probeEndpoints({ actor: "boot (first run)" }).catch((e) => ({
      ok: false, kind: "error", error: String((e && e.message) || e),
    }));
    if (!out.ok) {
      console.log(`[rethink-probe] VERDICT: the probe could not run -- ${out.error || out.kind}`);
      return { ran: false, why: out.kind || "error" };
    }

    // Printed so the answer is readable from the deploy logs, not only from
    // the screen. Endpoint names and FIELD names only -- the same line the
    // rest of this module holds, because values are PHI and logs travel.
    console.log(`[rethink-probe] VERDICT: ${out.verdict}`);
    for (const r of out.results) {
      if (!r.ok) continue;
      console.log(`[rethink-probe] ${r.is_control ? "control " : "FOUND   "}${r.endpoint}: ${
        r.rows_seen} row(s)${r.row_keys.length ? " | fields: " + r.row_keys.join(", ") : " | no row, so no field names"}`);
    }
    return { ran: true, found: out.found, controls_ok: out.controls_ok };
  }

  return {
    initTables, handleApi, probeEndpoints, latestProbe, probeOnceOnBoot,
    _internal: { CANDIDATES, KNOWN, keyNamesOf, verdictFor, probeOne, MAX_CANDIDATES },
  };
};
