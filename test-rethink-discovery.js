// The Rethink endpoint probe: find out what this account can actually be
// asked for, without inventing an answer.
//
// The probe exists because a programming sync was specified against endpoints
// nobody has confirmed exist. Everything below is about the difference between
// "we asked and it said no" and "we assumed" -- so the tests are mostly about
// what the probe REFUSES to claim, and about not leaking PHI on the way.
//
// No network: the DWH transport is stubbed, so a run here can never reach
// Rethink. That is also what lets the 401/404/200 branches be tested at all.

"use strict";

const path = require("path");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + String(JSON.stringify(detail)).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n" + t.toUpperCase());

// ---- stub the transport --------------------------------------------------
// Same trick rethink.js's own suite uses: put the module in require.cache
// before the module under test asks for it.
const clientPath = require.resolve("./rethink-client.js");
const real = require("./rethink-client.js");

class StubError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.status = opts.status || null;
    this.kind = opts.kind || "http";
    this.upstream = opts.upstream || null;
  }
}

const calls = [];
let responder = () => { throw new StubError("not configured", { status: 404 }); };
const stub = {
  configured: () => true,
  log: () => {},
  extractRows: real.extractRows,
  envelopeCounters: real.envelopeCounters,
  RethinkError: StubError,
  dwhGet: async (endpoint, params) => {
    calls.push({ endpoint, params });
    return responder(endpoint, params);
  },
};
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: stub };

// ---- in-memory database --------------------------------------------------
function makeDb() {
  const state = { probes: new Map(), runs: [], sql: [] };
  const dbRun = async (sql, p = []) => {
    state.sql.push(sql);
    if (/INSERT INTO rethink_endpoint_probes/i.test(sql)) {
      // By column name: reading positionally means adding a column silently
      // shifts every assertion onto the wrong value.
      const cols = ((sql.match(/INSERT INTO rethink_endpoint_probes\s*\(([^)]*)\)/i) || [])[1] || "")
        .split(",").map((c) => c.trim().replace(/--.*$/, "").trim()).filter(Boolean);
      const row = {};
      cols.forEach((c, i) => { row[c] = p[i]; });
      state.probes.set(row.endpoint, row);
      return;
    }
    if (/INSERT INTO rethink_probe_runs/i.test(sql)) {
      state.runs.push({ started_at: p[0], finished_at: p[1], actor: p[2], tried: p[3], ok: p[4], controls_ok: p[5], note: p[6] });
      return;
    }
  };
  const dbAll = async (sql) => {
    state.sql.push(sql);
    if (/FROM rethink_endpoint_probes/i.test(sql)) return [...state.probes.values()];
    return [];
  };
  const dbGet = async (sql) => {
    state.sql.push(sql);
    if (/FROM rethink_probe_runs/i.test(sql)) return state.runs[state.runs.length - 1] || null;
    return null;
  };
  return { state, dbGet, dbAll, dbRun };
}

const initDiscovery = require("./rethink-discovery.js");
function makeModule(extra) {
  const db = makeDb();
  const mod = initDiscovery(Object.assign({
    dbGet: db.dbGet, dbAll: db.dbAll, dbRun: db.dbRun,
    nowISO: () => "2026-09-26T12:00:00.000Z",
    readBody: async () => ({}),
    json: () => {},
    client: stub,
    canManage: (u) => ["owner", "super_admin"].includes((u && u.role) || ""),
    // No real sleeping between stubbed calls -- the politeness gap is for the
    // vendor, and there is no vendor here.
    gapMs: 0,
  }, extra || {}));
  return { mod, db };
}

(async () => {
  // ------------------------------------------------------------------
  section("It is a read, never a write");

  // The whole safety case rests on this: a probe cannot change clinical data
  // in Rethink because it only ever issues GETs through a client whose only
  // read verb is dwhGet.
  const src = require("fs").readFileSync(path.join(__dirname, "rethink-discovery.js"), "utf8");
  check("the probe calls no write verb on the Rethink client",
    !/dwhPost|dwhPut|dwhPatch|dwhDelete|method:\s*["']POST["']/i.test(src), "no write verb may appear");
  check("and reaches Rethink only through dwhGet",
    (src.match(/client\.dwh[A-Za-z]+/g) || []).every((m) => m === "client.dwhGet"),
    src.match(/client\.dwh[A-Za-z]+/g));

  // ------------------------------------------------------------------
  section("Key names yes, values never");

  // Keys are structure; values are PHI. This is the line that lets an admin
  // read the result on a screen at all, so it is tested on a row that looks
  // like a real one.
  {
    const { mod } = makeModule();
    const keys = mod._internal.keyNamesOf([{
      targetName: "Mand - Break - Independent",
      clientId: 99123,
      status: "Mastered",
      masteredOn: "2026-09-01",
    }]);
    check("the key names come back", keys.join(",") === "clientId,masteredOn,status,targetName", keys);
    check("and not one value comes with them",
      !JSON.stringify(keys).includes("Mand") && !JSON.stringify(keys).includes("99123")
        && !JSON.stringify(keys).includes("Mastered"), keys);
    check("an empty page yields no keys rather than throwing", mod._internal.keyNamesOf([]).length === 0);
    check("a row that is not an object yields no keys", mod._internal.keyNamesOf(["nope"]).length === 0);
  }

  // ------------------------------------------------------------------
  section("A run that finds nothing");

  // The case the whole exercise is likeliest to hit. It has to be reported as
  // an answer, not as a failure -- and it is only sayable because the known
  // endpoints were asked too.
  {
    const { mod, db } = makeModule();
    calls.length = 0;
    responder = (endpoint) => {
      if (["Appointments", "Clients", "ClientAuthorization"].includes(endpoint)) {
        return { result: [{ clientId: 1 }], totalCount: 1 };
      }
      throw new StubError(`Rethink ${endpoint} returned HTTP 404.`, { status: 404, kind: "http" });
    };
    const out = await mod.probeEndpoints({ actor: "tester@x.invalid" });

    check("the run completes", out.ok === true, out);
    check("the three endpoints the CRM already uses are probed as controls",
      out.controls_ok === 3 && out.controls_total === 3, { ok: out.controls_ok, total: out.controls_total });
    check("no candidate programming endpoint answered", out.found === 0, out.found);
    check("and the verdict SAYS that, rather than leaving a table of 404s to interpret",
      /already uses answered normally/i.test(out.verdict) && /does not appear to be reachable/i.test(out.verdict),
      out.verdict);

    // A 404 is an answer. Asking again with a date window would just be a
    // second request to somebody else's API for a name that does not exist.
    const perEndpoint = {};
    calls.forEach((c) => { perEndpoint[c.endpoint] = (perEndpoint[c.endpoint] || 0) + 1; });
    const four04s = Object.entries(perEndpoint).filter(([e]) => !["Appointments", "Clients", "ClientAuthorization"].includes(e));
    check("a 404 is not retried with a second shape of request",
      four04s.every(([, n]) => n === 1), perEndpoint);

    check("every endpoint tried is on file for the screen to read",
      db.state.probes.size === out.tried, { stored: db.state.probes.size, tried: out.tried });
    check("the run records who ran it and when -- this is its audit record",
      db.state.runs.length === 1 && db.state.runs[0].actor === "tester@x.invalid"
        && !!db.state.runs[0].started_at && !!db.state.runs[0].finished_at, db.state.runs[0]);
  }

  // ------------------------------------------------------------------
  section("A run that finds something");

  {
    const { mod } = makeModule();
    responder = (endpoint) => {
      if (["Appointments", "Clients", "ClientAuthorization"].includes(endpoint)) return { result: [{ clientId: 1 }] };
      if (endpoint === "ClientGoal") {
        return { result: [{ goalId: 5, clientId: 1, goalName: "x", status: "Active", masteredOn: null }], totalCount: 42 };
      }
      throw new StubError("not found", { status: 404, kind: "http" });
    };
    const out = await mod.probeEndpoints({ actor: "tester" });
    const hit = out.results.find((r) => r.endpoint === "ClientGoal");

    check("the endpoint that answered is reported", out.found === 1 && hit && hit.ok === true, hit);
    check("with the field names, which is what a mapping is built from",
      hit.row_keys.join(",") === "clientId,goalId,goalName,masteredOn,status", hit && hit.row_keys);
    check("and the envelope count, so somebody can see how much is there",
      hit.envelope_counters.totalCount === 42, hit && hit.envelope_counters);
    check("the verdict names it instead of just counting it",
      /ClientGoal/.test(out.verdict) && /field names are listed/i.test(out.verdict), out.verdict);
  }

  // ------------------------------------------------------------------
  section("An endpoint that exists but returns nothing");

  // A 200 with no rows still answers the question being asked -- the endpoint
  // EXISTS. Throwing that away because no row came back would lose the finding.
  {
    const { mod } = makeModule();
    responder = (endpoint) => {
      if (endpoint === "Programs") return { result: [], totalCount: 0 };
      if (["Appointments", "Clients", "ClientAuthorization"].includes(endpoint)) return { result: [{ clientId: 1 }] };
      throw new StubError("not found", { status: 404, kind: "http" });
    };
    const out = await mod.probeEndpoints({ actor: "tester" });
    const hit = out.results.find((r) => r.endpoint === "Programs");
    check("an endpoint that answers with no rows is still recorded as reachable",
      hit && hit.ok === true && hit.rows_seen === 0, hit);
    check("its field names are honestly empty rather than guessed",
      hit && hit.row_keys.length === 0, hit && hit.row_keys);
    check("and the verdict says the names are still unknown",
      /still unknown/i.test(out.verdict), out.verdict);
  }

  // ------------------------------------------------------------------
  section("A body the client cannot read is still a 200");

  {
    const { mod } = makeModule();
    responder = (endpoint) => {
      if (endpoint === "Targets") return { somethingElse: { nested: true } };
      if (["Appointments", "Clients", "ClientAuthorization"].includes(endpoint)) return { result: [{ clientId: 1 }] };
      throw new StubError("not found", { status: 404, kind: "http" });
    };
    const out = await mod.probeEndpoints({ actor: "tester" });
    const hit = out.results.find((r) => r.endpoint === "Targets");
    check("an unrecognisable body does not lose the fact that the endpoint exists",
      hit && hit.ok === true, hit);
  }

  // ------------------------------------------------------------------
  section("Bad credentials stop the run");

  // Forty more requests that all fail for the same reason help nobody, and
  // reporting "no programming endpoints" off a dead credential would be the
  // worst possible outcome of this whole exercise.
  {
    const { mod } = makeModule();
    calls.length = 0;
    responder = () => { throw new StubError("Rethink rejected our credentials.", { status: 401, kind: "auth" }); };
    const out = await mod.probeEndpoints({ actor: "tester" });

    check("the run stops instead of hammering the API", calls.length <= 3, calls.length);
    check("it says the credential is the problem", /credentials/i.test(out.stopped_early || ""), out.stopped_early);
    check("and never concludes that programming is unavailable",
      !/does not appear to be reachable/i.test(out.verdict), out.verdict);
    check("no control answered, and the verdict refuses to read anything into the run",
      out.controls_ok === 0, out.controls_ok);
  }

  // ------------------------------------------------------------------
  section("Controls are what make a negative result mean anything");

  {
    const { mod } = makeModule();
    responder = () => { throw new StubError("server error", { status: 500, kind: "http" }); };
    const out = await mod.probeEndpoints({ actor: "tester" });
    check("with the known endpoints failing too, the run declines to draw a conclusion",
      /says nothing about programming/i.test(out.verdict), out.verdict);
  }

  // ------------------------------------------------------------------
  section("An endpoint that wants a date window");

  // ClientAuthorization needed one, which is the precedent. A 400 is retried
  // with a window; anything found that way is still a find.
  {
    const { mod } = makeModule();
    responder = (endpoint, params) => {
      if (endpoint === "ClientProgram") {
        if (!params.From) throw new StubError("Bad request", { status: 400, kind: "http" });
        return { result: [{ programId: 1, clientId: 2 }] };
      }
      if (["Appointments", "Clients", "ClientAuthorization"].includes(endpoint)) return { result: [{ clientId: 1 }] };
      throw new StubError("not found", { status: 404, kind: "http" });
    };
    const out = await mod.probeEndpoints({ actor: "tester" });
    const hit = out.results.find((r) => r.endpoint === "ClientProgram");
    check("an endpoint that refuses a bare call is asked again with a window",
      hit && hit.ok === true, hit);
    check("and the run records which shape of request worked, so it can be repeated",
      hit && hit.params_used === "with_date_window", hit && hit.params_used);
  }

  // ------------------------------------------------------------------
  section("It asks for as little as possible");

  {
    const { mod } = makeModule();
    calls.length = 0;
    responder = () => ({ result: [{ a: 1 }] });
    await mod.probeEndpoints({ actor: "tester" });
    check("every request asks for a single row", calls.every((c) => c.params.PageSize === 1), calls[0]);
    check("and only the first page", calls.every((c) => c.params.Page === 1), calls[0]);
    check("the number of endpoints tried is capped",
      calls.length <= mod._internal.MAX_CANDIDATES + mod._internal.KNOWN.length, calls.length);
  }

  // ------------------------------------------------------------------
  section("Nothing in the candidate list is presented as real");

  {
    const { mod } = makeModule();
    check("the candidates are only names to test, not endpoints claimed to exist",
      mod._internal.CANDIDATES.length > 0 && mod._internal.CANDIDATES.every((c) => typeof c === "string"));
    check("the three that ARE real are kept separate from them",
      mod._internal.KNOWN.join(",") === "Appointments,Clients,ClientAuthorization"
        && !mod._internal.CANDIDATES.some((c) => mod._internal.KNOWN.includes(c)),
      { known: mod._internal.KNOWN });
  }

  // ------------------------------------------------------------------
  section("Permission and input handling");

  {
    let status = null, body = null;
    const { mod } = makeModule({ json: (res, s, b) => { status = s; body = b; } });
    const req = {};
    await mod.handleApi(req, {}, "/api/rethink/discovery", "GET", {}, { role: "clinical" });
    check("a clinical user cannot read the probe results", status === 403, { status, body });
    status = null;
    await mod.handleApi(req, {}, "/api/rethink/discovery/probe", "POST", {}, { role: "admin" });
    check("nor can an admin run one -- this is the owner/super-admin tier", status === 403, status);
    status = null;
    const handled = await mod.handleApi(req, {}, "/api/rethink/status", "GET", {}, { role: "owner" });
    check("it claims only its own routes and leaves the rest of /api/rethink alone",
      handled === false && status === null, { handled, status });
  }

  {
    // extra_endpoints lets somebody test a name Rethink support gave them. It
    // is a PATH SEGMENT, so anything that could point the probe somewhere
    // other than the DWH base is dropped rather than sanitised into something
    // that still resolves.
    const { mod } = makeModule();
    calls.length = 0;
    responder = () => ({ result: [{ a: 1 }] });
    await mod.probeEndpoints({
      actor: "tester",
      extra_endpoints: ["MyCustomGoals", "../../etc/passwd", "http://evil.test/x", "Has Space", "Semi;colon", "ok2"],
    });
    const tried = calls.map((c) => c.endpoint);
    check("a plausible custom name is tried", tried.includes("MyCustomGoals"), tried.slice(0, 5));
    check("a traversal, a URL, a space and a semicolon are all refused",
      !tried.some((e) => /\.\.|https?:|\s|;/.test(e)), tried.filter((e) => /\.\.|https?:|\s|;/.test(e)));
  }

  // ------------------------------------------------------------------
  section("Reading the last run back");

  {
    const { mod } = makeModule();
    responder = (endpoint) => {
      if (endpoint === "ClientGoal") return { result: [{ goalId: 1, status: "Active" }] };
      if (["Appointments", "Clients", "ClientAuthorization"].includes(endpoint)) return { result: [{ clientId: 1 }] };
      throw new StubError("not found", { status: 404, kind: "http" });
    };
    await mod.probeEndpoints({ actor: "tester" });
    const latest = await mod.latestProbe();
    check("the screen can read the result without probing again", latest.ok === true && latest.results.length > 0, latest.results.length);
    const hit = latest.results.find((r) => r.endpoint === "ClientGoal");
    check("the stored field names survive the round trip",
      hit && hit.row_keys.join(",") === "goalId,status", hit && hit.row_keys);
    check("and still carry no values", !JSON.stringify(latest.results).includes("Active"),
      "a stored VALUE would mean PHI on an admin screen");
  }

  // ------------------------------------------------------------------
  section("The one boot run, and why it is only one");

  // The owner asked for the probe to be run for them: the credentials and the
  // route to the vendor exist only on the deployed server, so they cannot be
  // the one to press the button. The server asks on their behalf -- ONCE.
  // A restart, a redeploy or a crash loop must not turn forty requests to
  // somebody else's API into four hundred, so everything here is about the
  // guard rather than the probe.
  {
    const { mod, db } = makeModule();
    responder = (endpoint) => {
      if (endpoint === "ClientGoal") return { result: [{ goalId: 1, status: "Active" }] };
      if (["Appointments", "Clients", "ClientAuthorization"].includes(endpoint)) return { result: [{ clientId: 1 }] };
      throw new StubError("not found", { status: 404, kind: "http" });
    };

    const first = await mod.probeOnceOnBoot();
    check("the first boot runs it", first.ran === true, first);
    check("and records the run, which is what stops the second", db.state.runs.length === 1, db.state.runs.length);

    calls.length = 0;
    const second = await mod.probeOnceOnBoot();
    check("the next boot does NOT run it again", second.ran === false, second);
    check("...and says why, rather than failing silently", second.why === "already_probed", second);
    check("...and sends Rethink nothing at all", calls.length === 0, calls.length);

    // Ten restarts in a row is what a crash loop looks like.
    calls.length = 0;
    for (let i = 0; i < 10; i++) await mod.probeOnceOnBoot();
    check("ten restarts send Rethink nothing", calls.length === 0, calls.length);
    check("and add no runs", db.state.runs.length === 1, db.state.runs.length);
  }

  {
    // No credentials: boot must not try, and must not record a run either --
    // recording one would permanently suppress the real first probe.
    const { mod, db } = makeModule();
    const wasConfigured = stub.configured;
    stub.configured = () => false;
    calls.length = 0;
    const out = await mod.probeOnceOnBoot();
    stub.configured = wasConfigured;
    check("with no credentials the boot probe does not run", out.ran === false && out.why === "not_configured", out);
    check("...calls nothing", calls.length === 0, calls.length);
    check("...and records NO run, so the real first probe is not suppressed",
      db.state.runs.length === 0, db.state.runs.length);
  }

  {
    // A boot probe that throws must never take the server down with it.
    const { mod } = makeModule();
    responder = () => { throw new StubError("Rethink rejected our credentials.", { status: 401, kind: "auth" }); };
    let threw = false;
    try { await mod.probeOnceOnBoot(); } catch (e) { threw = true; }
    check("a probe that cannot authenticate does not throw out of boot", threw === false);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
