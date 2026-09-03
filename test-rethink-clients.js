// Pulling client information across from Rethink.
//
// Two things happen on a client scan now, and both write to real family
// records, so both are tested here against a fake Rethink and a fake database:
//
//   * blank CRM demographics are filled from the matched Rethink record
//   * a child who is ACTIVE in Rethink and absent from the CRM gets a record
//
// The assertions that matter are the refusals. Filling a field is easy to get
// right; the ways this goes wrong are overwriting an address the office
// corrected, creating a second record for a child who is already here, and
// re-enrolling a discharged client. Each of those is a test.
//
//   node test-rethink-clients.js
"use strict";
const initRethink = require("./rethink.js");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

// A Rethink "Clients" response shaped like the vendor's other endpoints:
// camelCase, more fields than the five that are documented to us.
const RETHINK_ROWS = [
  {
    clientId: "R-100", firstName: "Ada", lastName: "Nguyen", dateOfBirth: "2018-04-02T00:00:00", status: "Active",
    address: "18 Rowan Way", city: "Las Vegas", state: "NV", zipCode: "89101",
    guardianName: "Mai Nguyen", guardianPhone: "702-555-0110", guardianEmail: "mai@example.com",
    funder: "Silver State Health",
  },
  {
    clientId: "R-200", firstName: "Bo", lastName: "Carter", dateOfBirth: "2017-09-15T00:00:00", status: "Active",
    address: "9 Ash Court", city: "Henderson", state: "NV", zipCode: "89012",
    guardianName: "Dee Carter", guardianPhone: "702-555-0220", guardianEmail: "dee@example.com",
    funder: "Medicaid",
  },
];

function makeCtx(state) {
  const noop = async () => {};
  return {
    nowISO: () => "2026-09-02T12:00:00.000Z",
    readBody: noop, json: noop,
    createClientBackfill: async (payload) => {
      const id = state.nextClientId++;
      const row = { id, ...payload };
      state.clients.push(row);
      state.created.push(payload);
      return row;
    },
    async dbGet(sql, p = []) {
      if (/FROM clients WHERE id = \?/.test(sql)) return state.clients.find((c) => c.id === p[0]) || undefined;
      if (/FROM clients WHERE rethink_client_id = \?/.test(sql)) return state.clients.find((c) => c.rethink_client_id === p[0]) || undefined;
      return undefined;
    },
    async dbAll(sql) {
      if (/FROM rethink_unmatched_clients/.test(sql)) return state.orphans;
      if (/rethink_client_id IS NOT NULL/.test(sql)) {
        return state.clients.filter((c) => c.rethink_client_id).map((c) => ({ id: c.id, rethink_client_id: c.rethink_client_id }));
      }
      return [];
    },
    async dbRun(sql, p = []) {
      const m = sql.match(/UPDATE clients SET (\w+) = \?/);
      if (m) {
        const c = state.clients.find((x) => x.id === p[p.length - 1]);
        if (c) { c[m[1]] = p[0]; state.writes.push({ id: c.id, field: m[1], value: p[0] }); }
      }
      if (/DELETE FROM rethink_unmatched_clients WHERE rethink_client_id/.test(sql)) {
        state.orphans = state.orphans.filter((o) => o.rethink_client_id !== p[0]);
      }
      if (/INSERT INTO rethink_client_link_log/.test(sql)) state.linkLog.push({ sql, params: p });
      return { rowCount: 1, rows: [] };
    },
  };
}

const freshState = () => ({
  clients: [], orphans: [], created: [], writes: [], linkLog: [], nextClientId: 1,
});

(async () => {
  // ============ the field map is resolved from what actually came back ======
  section("The demographic map is built from the keys Rethink returned");
  const r = initRethink(makeCtx(freshState()));
  const D = r._demographics;

  const full = D.resolveDemographicMap(Object.keys(RETHINK_ROWS[0]));
  check("address is mapped", full.map.address === "address", full.map);
  check("the funder is taken as the insurance provider",
    full.map.insurance_provider === "funder", full.map.insurance_provider);
  check("the guardian's phone and email are found",
    full.map.parent_phone === "guardianPhone" && full.map.parent_email === "guardianEmail", full.map);
  check("nothing is left unmapped when every field is present", full.unmapped.length === 0, full.unmapped);

  // The important half: an endpoint that returns LESS must map less, not guess.
  const sparse = D.resolveDemographicMap(["clientId", "firstName", "lastName", "dateOfBirth", "status"]);
  check("an endpoint with only the documented fields maps no demographics",
    Object.keys(sparse.map).length === 0, sparse.map);
  check("and every CRM field is reported as unmapped rather than silently skipped",
    sparse.unmapped.length === Object.keys(D.DEMOGRAPHIC_CANDIDATES).length, sparse.unmapped);

  const cased = D.resolveDemographicMap(["ZipCode", "ADDRESS", "guardianphone"]);
  check("matching is case-insensitive, so a vendor rename does not drop a field",
    cased.map.address === "ADDRESS" && cased.map.zip === "ZipCode" && cased.map.parent_phone === "guardianphone", cased.map);

  section("Address parts are joined, and never half-joined");
  check("a full address reads properly",
    D.composeAddress(RETHINK_ROWS[0], full.map) === "18 Rowan Way, Las Vegas, NV 89101",
    D.composeAddress(RETHINK_ROWS[0], full.map));
  check("a street with no city or zip is still usable",
    D.composeAddress({ address: "18 Rowan Way" }, { address: "address" }) === "18 Rowan Way");
  check("no street means no address at all, rather than a stray comma",
    D.composeAddress({ city: "Las Vegas", state: "NV" }, full.map) === "");
  check("a missing zip does not leave a dangling separator",
    D.composeAddress({ address: "1 A St", city: "Reno", state: "NV" }, full.map) === "1 A St, Reno, NV");

  // ============ filling only what is blank =================================
  section("Demographics fill blanks and never overwrite");
  const s1 = freshState();
  const r1 = initRethink(makeCtx(s1));
  s1.clients.push({
    id: 1, child_name: "Ada Nguyen", rethink_client_id: "R-100",
    dob: null, address: "", parent_phone: null,
    // The office corrected this after the family moved. Rethink still has the
    // old one. This must survive.
    parent_email: "corrected@example.com",
    parent_name: null, insurance_provider: null,
  });
  const fill = await r1._demographics.fillDemographics(1, RETHINK_ROWS[0], full.map);
  const c1 = s1.clients[0];
  check("a blank address is filled", c1.address === "18 Rowan Way, Las Vegas, NV 89101", c1.address);
  check("a blank phone is filled", c1.parent_phone === "702-555-0110", c1.parent_phone);
  check("a blank insurance provider is filled from the funder", c1.insurance_provider === "Silver State Health", c1.insurance_provider);
  check("a blank DOB is filled", c1.dob === "2018-04-02", c1.dob);
  check("THE EMAIL THE OFFICE TYPED IS NOT TOUCHED",
    c1.parent_email === "corrected@example.com", c1.parent_email);
  check("and the skip is reported rather than silent",
    fill.skipped.includes("parent_email"), fill.skipped);

  section("A DOB that disagrees is flagged, not overwritten");
  const s2 = freshState();
  const r2 = initRethink(makeCtx(s2));
  s2.clients.push({ id: 1, child_name: "Ada Nguyen", rethink_client_id: "R-100", dob: "2018-04-03", address: "x" });
  const fill2 = await r2._demographics.fillDemographics(1, RETHINK_ROWS[0], full.map);
  check("the CRM's own DOB stands", s2.clients[0].dob === "2018-04-03", s2.clients[0].dob);
  check("the disagreement is reported for a human",
    fill2.skipped.some((x) => /dob/.test(x) && /differs/.test(x)), fill2.skipped);

  // ============ auto-create ================================================
  section("An active Rethink client with no CRM record is created");
  const s3 = freshState();
  const r3 = initRethink(makeCtx(s3));
  const rowsById = new Map(RETHINK_ROWS.map((x) => [x.clientId, x]));
  s3.orphans = [{
    rethink_client_id: "R-100", first_name: "Ada", last_name: "Nguyen",
    dob: "2018-04-02", status: "Active", possible_closed_crm_client_id: null,
  }];
  const made = await r3._demographics.autoCreateActiveClients(rowsById, full.map);
  check("the client is created", made.created.length === 1, made);
  const rec = s3.clients[0];
  check("with their name", rec && rec.child_name === "Ada Nguyen", rec && rec.child_name);
  check("in the Active stage, which is the true statement about them",
    rec && rec.stage === "active", rec && rec.stage);
  check("carrying the demographics Rethink held",
    rec && rec.address === "18 Rowan Way, Las Vegas, NV 89101" && rec.insurance_provider === "Silver State Health",
    rec && { address: rec.address, ins: rec.insurance_provider });
  check("a note says where the record came from and what still needs checking",
    rec && /automatically from Rethink/i.test(rec.notes || "") && /needs filling in/i.test(rec.notes || ""), rec && rec.notes);
  check("the Rethink id is stamped on immediately, so a second scan cannot duplicate them",
    s3.writes.some((w) => w.field === "rethink_client_id" && w.value === "R-100"), s3.writes);
  check("the creation is written to the link audit log, attributed to the automation",
    s3.linkLog.length === 1
      && /auto_created/.test(s3.linkLog[0].sql)
      && s3.linkLog[0].params[1] === "R-100"
      && /automation/i.test(String(s3.linkLog[0].params[2])),
    s3.linkLog[0]);
  check("and they leave the unmatched list", s3.orphans.length === 0, s3.orphans);

  section("A second scan does not create them again");
  s3.orphans = [{
    rethink_client_id: "R-100", first_name: "Ada", last_name: "Nguyen",
    dob: "2018-04-02", status: "Active", possible_closed_crm_client_id: null,
  }];
  const again = await r3._demographics.autoCreateActiveClients(rowsById, full.map);
  check("nothing new is created", again.created.length === 0, again.created);
  check("and the reason given is that they are already linked",
    again.refused.some((x) => /already linked/i.test(x.reason)), again.refused);

  section("Auto-create refuses the cases that would do damage");
  const s4 = freshState();
  const r4 = initRethink(makeCtx(s4));
  s4.orphans = [
    { rethink_client_id: "R-300", first_name: "Cy", last_name: "Diaz", status: "Inactive", possible_closed_crm_client_id: null },
    { rethink_client_id: "R-400", first_name: "Eve", last_name: "Frost", status: "Pending Acceptance", possible_closed_crm_client_id: null },
    { rethink_client_id: "R-500", first_name: "Gus", last_name: "Hale", status: "Active", possible_closed_crm_client_id: 9, possible_closed_crm_name: "Gus Hale" },
    { rethink_client_id: "R-600", first_name: "", last_name: "", status: "Active", possible_closed_crm_client_id: null },
  ];
  const refusals = await r4._demographics.autoCreateActiveClients(rowsById, full.map);
  check("nothing at all is created from these four", refusals.created.length === 0, refusals.created);
  const why = (id) => (refusals.refused.find((x) => x.rethink_client_id === id) || {}).reason || "";
  check("an Inactive client is refused", /not Active/i.test(why("R-300")), why("R-300"));
  check("a Pending Acceptance client is refused", /not Active/i.test(why("R-400")), why("R-400"));
  check("a child who looks like a DISCHARGED CRM client is refused, naming the record to reactivate",
    /discharged/i.test(why("R-500")) && /Gus Hale/.test(why("R-500")), why("R-500"));
  check("a nameless Rethink record is refused", /no name/i.test(why("R-600")), why("R-600"));

  section("The per-run cap holds");
  const s5 = freshState();
  const r5 = initRethink(makeCtx(s5));
  const CAP = r5._demographics.AUTO_CREATE_CAP;
  s5.orphans = Array.from({ length: CAP + 5 }, (_, i) => ({
    rethink_client_id: `R-9${i}`, first_name: "Kid", last_name: `Number${i}`,
    status: "Active", possible_closed_crm_client_id: null,
  }));
  const capped = await r5._demographics.autoCreateActiveClients(rowsById, full.map);
  check(`at most ${CAP} are created in one run`, capped.created.length === CAP, capped.created.length);
  check("the rest are reported as deferred, not dropped",
    capped.refused.filter((x) => /per-run limit/i.test(x.reason)).length === 5, capped.refused.length);

  section("Nothing is created when the host has not wired the silent path in");
  const noCreate = initRethink({ ...makeCtx(freshState()), createClientBackfill: undefined });
  const off = await noCreate._demographics.autoCreateActiveClients(rowsById, full.map);
  check("it declines rather than falling back to an emailing path",
    off.unavailable === true && off.created.length === 0, off);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR:", e); process.exit(1); });
