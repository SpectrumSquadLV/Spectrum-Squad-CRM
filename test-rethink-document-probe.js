// Can the Authorization Request pull documents from Rethink?
//
// The honest answer before this probe was "our integration has no documents
// endpoint", which is a fact about US, not about Rethink. This settles the
// question about THEM, and the probe has one property that matters more than
// whether it finds anything:
//
//   IT RECORDS SHAPE, NEVER CONTENT.
//
// These are clinical records. "Does Rethink expose documents" is answerable
// from field names, HTTP statuses and integer counts alone, so a value must
// never reach the database or the report. The suite feeds the probe a record
// stuffed with recognisable personal data and then asserts none of it is
// anywhere in what the probe wrote.
//
//   node test-rethink-document-probe.js
const path = require("path");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

// ---- stub the transport: no network call is ever attempted ----------------
const clientPath = require.resolve("./rethink-client");
const realClient = require("./rethink-client");

// A record shaped like a real one, carrying data that must never be recorded.
const SECRETS = ["Mateo Alvarez", "2019-03-04", "555-0148", "parent@example.invalid"];
const DOC_ROW = {
  documentId: 88, clientId: 41, clientName: "Mateo Alvarez", dateOfBirth: "2019-03-04",
  guardianPhone: "555-0148", guardianEmail: "parent@example.invalid",
  documentName: "Vineland-3.pdf", documentUrl: "https://rethink.invalid/d/88", uploadedOn: "2026-08-20",
};
const CLIENT_ROW = {
  clientId: 41, firstName: "Mateo", lastName: "Alvarez", dateOfBirth: "2019-03-04",
  funder: "Tricare", fileNumber: "A-1002", latestAssessmentUrl: "https://rethink.invalid/a/7",
};

function makeStub(behaviour) {
  return {
    configured: () => true,
    redact: realClient.redact,
    log: () => {},
    snippet: realClient.snippet,
    safeMessage: realClient.safeMessage,
    RethinkError: realClient.RethinkError,
    schemaOf: realClient.schemaOf,
    extractRows: realClient.extractRows,
    dwhGetAllPages: async () => ({ rows: [], pages: 1, truncated: false }),
    dwhGet: behaviour,
  };
}

function makeDb() {
  const rows = [];
  const dbRun = async (sql, params = []) => {
    if (/INSERT INTO rethink_document_probe/i.test(sql)) {
      const [kind, name, http_status, verdict, row_count, counters, fields, note, at] = params;
      const i = rows.findIndex((r) => r.kind === kind && r.name === name);
      const rec = { kind, name, http_status, verdict, row_count, counters, fields, note, at };
      if (i >= 0) rows[i] = rec; else rows.push(rec);
    }
    return { rowCount: 1 };
  };
  return { rows, dbRun, dbAll: async () => rows, dbGet: async () => null };
}

function load(behaviour) {
  const db = makeDb();
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: makeStub(behaviour) };
  delete require.cache[require.resolve("./rethink.js")];
  const mod = require("./rethink.js")({
    dbGet: db.dbGet, dbAll: db.dbAll, dbRun: db.dbRun,
    nowISO: () => "2026-09-30T12:00:00.000Z",
    readBody: async () => ({}), json: () => {},
    sendEmail: async () => ({ ok: true }),
    getSetting: async () => null, setSetting: async () => {},
    appBaseUrl: () => "http://localhost",
  });
  return { mod, db };
}

(async () => {
  // ------------------------------------------------------------------
  section("A name that does not exist is a real answer, not a failure");
  {
    const { mod, db } = load(async () => { const e = new Error("Not Found"); e.status = 404; throw e; });
    const out = await mod._documentProbe.probeClientDocuments();
    check("the probe completes even when every name 404s", out.ok === true, out);
    const eps = db.rows.filter((r) => r.kind === "endpoint");
    check("every candidate name was actually tried", eps.length === mod._documentProbe.DOC_ENDPOINT_CANDIDATES.length,
      { tried: eps.length, candidates: mod._documentProbe.DOC_ENDPOINT_CANDIDATES.length });
    check("A 404 IS RECORDED AS ABSENT, which is the finding", eps.every((r) => r.verdict === "absent"),
      eps.slice(0, 3));
    check("and the answer says so plainly", /exposes no client documents/i.test(out.answer), out.answer);
  }

  // ------------------------------------------------------------------
  section("Refused is not the same as absent");
  {
    const { mod } = load(async () => { const e = new Error("Forbidden"); e.status = 403; throw e; });
    const out = await mod._documentProbe.probeClientDocuments();
    check("a 403 is recorded as refused, never as absent",
      out.endpoints.every((r) => r.verdict === "refused"), out.endpoints.slice(0, 2));
    check("THE ANSWER DOES NOT CLAIM RETHINK HAS NO DOCUMENTS when it only refused us",
      !/exposes no client documents/i.test(out.answer) && /refused/i.test(out.answer), out.answer);
  }

  // ------------------------------------------------------------------
  section("A documents endpoint that exists is found, and reported as shape");
  {
    const { mod, db } = load(async (name) => {
      if (name === "ClientDocument") return { items: [DOC_ROW], totalCount: 412 };
      const e = new Error("Not Found"); e.status = 404; throw e;
    });
    const out = await mod._documentProbe.probeClientDocuments();
    check("the endpoint that answers is the one reported", /ClientDocument/.test(out.answer), out.answer);
    const hit = db.rows.find((r) => r.name === "ClientDocument");
    check("its field names are recorded", /documentName/.test(hit.fields) && /documentUrl/.test(hit.fields), hit.fields);
    check("the envelope's own count is kept, so scale is known", /"totalCount":412/.test(hit.counters), hit.counters);

    // The property the whole probe lives or dies by.
    const everythingWritten = JSON.stringify(db.rows) + JSON.stringify(out);
    const leaked = SECRETS.filter((v) => everythingWritten.includes(v));
    check("NO VALUE FROM THE RECORD REACHES THE DATABASE OR THE REPORT", leaked.length === 0, leaked);
    check("...and that is not because the probe found nothing", hit.verdict === "found" && JSON.parse(hit.fields).length > 5,
      { verdict: hit.verdict, fields: JSON.parse(hit.fields).length });
  }

  // ------------------------------------------------------------------
  section("A document hanging off a record we already pull");
  {
    const { mod, db } = load(async (name) => {
      if (name === "Clients") return { items: [CLIENT_ROW] };
      const e = new Error("Not Found"); e.status = 404; throw e;
    });
    const out = await mod._documentProbe.probeClientDocuments();
    check("a document-shaped field on the client record is noticed",
      out.nested.some((n) => n.fields.includes("latestAssessmentUrl")), out.nested);
    check("the answer points at it rather than saying there is nothing",
      /document-shaped fields/i.test(out.answer), out.answer);
    // fileNumber matches the hint but is an identifier, not a document.
    const nestedRow = db.rows.find((r) => r.kind === "nested_field" && r.name === "Clients");
    check("AN IDENTIFIER THAT MERELY LOOKS DOCUMENT-SHAPED IS NOT REPORTED",
      !/fileNumber/.test(nestedRow.fields), nestedRow.fields);
    const everythingWritten = JSON.stringify(db.rows) + JSON.stringify(out);
    check("no value leaks from this path either",
      SECRETS.filter((v) => everythingWritten.includes(v)).length === 0,
      SECRETS.filter((v) => everythingWritten.includes(v)));
  }

  // ------------------------------------------------------------------
  section("An empty answer is told apart from a wrong question");
  {
    const { mod, db } = load(async () => ({ items: [], totalCount: 0 }));
    const out = await mod._documentProbe.probeClientDocuments();
    const row = db.rows.find((r) => r.kind === "endpoint");
    check("zero rows with a zero count reads as empty, not absent", row.verdict === "empty", row);
    check("the count that proves it is kept", /"totalCount":0/.test(row.counters), row.counters);
  }
  {
    const { mod, db } = load(async () => ({ items: [] }));
    const out = await mod._documentProbe.probeClientDocuments();
    const row = db.rows.find((r) => r.kind === "endpoint");
    check("NO ROWS AND NO COUNTERS IS FLAGGED AS UNDECIDABLE, not as an answer",
      /cannot tell empty from wrongly asked/i.test(row.note || ""), row.note);
  }

  // ------------------------------------------------------------------
  section("It refuses to run without credentials");
  {
    const db = makeDb();
    require.cache[clientPath] = {
      id: clientPath, filename: clientPath, loaded: true,
      exports: { ...makeStub(async () => ({})), configured: () => false },
    };
    delete require.cache[require.resolve("./rethink.js")];
    const mod = require("./rethink.js")({
      dbGet: db.dbGet, dbAll: db.dbAll, dbRun: db.dbRun,
      nowISO: () => "2026-09-30T12:00:00.000Z",
      readBody: async () => ({}), json: () => {},
      sendEmail: async () => ({ ok: true }),
      getSetting: async () => null, setSetting: async () => {},
      appBaseUrl: () => "http://localhost",
    });
    const out = await mod._documentProbe.probeClientDocuments();
    check("it says so rather than reporting an absence it never checked",
      out.ok === false && out.configured === false, out);
    check("...and writes nothing", db.rows.length === 0, db.rows.length);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
