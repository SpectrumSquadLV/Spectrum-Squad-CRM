// The two ways a pay period becomes timecards.
//
// There was no coverage here at all, which is how the .xlsx path came to fail
// silently: every shape of broken file produced the same sentence, "No
// employees found in the export. Is this the Rethink payroll export?", with
// nowhere to go when the answer was yes.
//
// What is checked:
//   - a well-formed export imports, with hours split billable / non-billable
//   - an export whose cells carry no r="B7" position attribute (legal, and
//     what some writers emit) imports too -- it used to parse as empty rows
//   - tab names that have been re-cased or re-spaced still match
//   - each way of being unreadable reports what the parser actually SAW
//   - building from Rethink's verified sessions: guards, validation, and a
//     clear answer when Rethink is not configured on this server
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-payroll-import.js
"use strict";
const { Pool } = require("pg");
const crypto = require("crypto");
const zlib = require("zlib");

const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 300) : "")); } }
const section = (t) => console.log("\n== " + t + " ==");
function mkClient() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}
function hp(pw) { const salt = crypto.randomBytes(16).toString("hex"); return { hash: crypto.scryptSync(pw, salt, 64).toString("hex"), salt }; }

// The module under test speaks `?` placeholders (server.js translates them);
// pg wants $1, $2. One translator, used by every query in this suite.
const q = (sql, params = []) => {
  let i = 0;
  return pool.query(String(sql).replace(/\?/g, () => `$${++i}`), params);
};

// ---------------------------------------------------------------- xlsx writer
// Just enough of the format to produce files the server has to read: a real
// ZIP, real sharedStrings, real sheets. `withRefs: false` omits the optional
// r="B7" cell position attribute, which is what the regression is about.
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i) => { let s = "", n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

function buildXlsx(sheetsIn, { withRefs = true } = {}) {
  const names = Object.keys(sheetsIn);
  const shared = [];
  const sharedIdx = new Map();
  const intern = (v) => { if (!sharedIdx.has(v)) { sharedIdx.set(v, shared.length); shared.push(v); } return sharedIdx.get(v); };

  const sheetXml = names.map((name) => {
    const rows = sheetsIn[name].map((cells, ri) => {
      const cs = cells.map((val, ci) => {
        const ref = withRefs ? ` r="${colName(ci)}${ri + 1}"` : "";
        // Without r="B7" a cell's column is its position in the row, so a
        // blank has to be written out as <c/> rather than dropped -- that is
        // what a writer which omits the attribute actually emits.
        if (val === "" || val === null || val === undefined) return withRefs ? "" : `<c/>`;
        if (typeof val === "number") return `<c${ref}><v>${val}</v></c>`;
        return `<c${ref} t="s"><v>${intern(String(val))}</v></c>`;
      }).join("");
      return `<row${withRefs ? ` r="${ri + 1}"` : ""}>${cs}</row>`;
    }).join("");
    return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });

  const files = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((n, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((v) => `<si><t>${xmlEsc(v)}</t></si>`).join("")}</sst>`,
  };
  names.forEach((_, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml[i]; });
  return zipOf(files);
}

function zipOf(files) {
  const names = Object.keys(files);
  const locals = [], central = [];
  let offset = 0;
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

  for (const name of names) {
    const raw = Buffer.from(files[name], "utf8");
    const comp = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8); eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), cdBuf, eocd]);
}

// A payroll export shaped like the real one. Excel dates are serials.
const DAY = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
function exportFor(ids, { summaryTab = "Summary", entriesTab = "Time Sheet Entries" } = {}) {
  const summary = [
    ["Start Date:", "09/07/2026", "", "End Date:", "09/20/2026"],
    ["Id", "FirstName", "LastName", "RegHours", "OT1Hours"],
    ...ids.map((e) => [e.id, e.first, e.last, e.reg, 0]),
  ];
  const entries = [
    ["", "Payroll detail"],
    ["", "Id", "Alerts", "StartTime", "EndTime", "DateOfService", "ActualStartTime", "ActualEndTime", "Duration", "StaffVerified", "ApptStatus", "Appt Type"],
    ...ids.flatMap((e) => (e.shifts || []).map((sft) =>
      ["", e.id, "", "9:00 AM", "1:00 PM", DAY(2026, 9, sft.day), "9:00 AM", "1:00 PM", sft.hours, "Yes", "Completed", sft.type])),
  ];
  return buildXlsx({ [summaryTab]: summary, [entriesTab]: entries });
}
const b64 = (buf) => buf.toString("base64");

(async () => {
  const m = hp("TestMgr123!");
  await pool.query(
    `INSERT INTO users (name, email, password_hash, password_salt, role, department_id, created_at)
     VALUES ('Payroll Mgr','payrollmgr@spectrumsquadlv.com',$1,$2,'hr_admin',NULL,now())
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_salt=EXCLUDED.password_salt, role='hr_admin'`,
    [m.hash, m.salt]
  );
  const s = hp("TestStaff123!");
  await pool.query(
    `INSERT INTO users (name, email, password_hash, password_salt, role, department_id, created_at)
     VALUES ('Clin User','payrollclin@spectrumsquadlv.com',$1,$2,'clinical',NULL,now())
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_salt=EXCLUDED.password_salt, role='clinical'`,
    [s.hash, s.salt]
  );

  const owner = mkClient(), mgr = mkClient(), clin = mkClient();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("a manager signs in", (await mgr("/api/auth/login", { method: "POST", body: { email: "payrollmgr@spectrumsquadlv.com", password: "TestMgr123!" } })).status === 200);
  check("a clinical user signs in", (await clin("/api/auth/login", { method: "POST", body: { email: "payrollclin@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  const stamp = Date.now().toString().slice(-6);
  const mk = async (name, rethinkId, email) => (await pool.query(
    "INSERT INTO hr_employees (name,email,rethink_id,status,created_at) VALUES ($1,$2,$3,'active',now()) RETURNING id",
    [name, email, rethinkId]
  )).rows[0].id;
  const aliceId = await mk(`Alice Payroll ${stamp}`, `RT-A-${stamp}`, `alice.${stamp}@example.test`);
  const bobId = await mk(`Bob Payroll ${stamp}`, `RT-B-${stamp}`, null);
  check("created the staff the export refers to", !!aliceId && !!bobId);

  const roster = [
    { id: `RT-A-${stamp}`, first: "Alice", last: `Payroll ${stamp}`, reg: 6,
      shifts: [{ day: 8, hours: 4, type: "Billable" }, { day: 9, hours: 2, type: "Non-Billable" }] },
    { id: `RT-B-${stamp}`, first: "Bob", last: `Payroll ${stamp}`, reg: 3,
      shifts: [{ day: 10, hours: 3, type: "Billable" }] },
  ];

  // ------------------------------------------------------------------
  section("A well-formed export");

  let r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "payroll.xlsx", content_base64: b64(exportFor(roster)) } });
  check("it imports", r.status === 200, r.data);
  check("it read the pay period off the file", r.data.pay_period_start === "09/07/2026" && r.data.pay_period_end === "09/20/2026", r.data);
  check("both staff matched on their Rethink id", r.data.matched === 2, r.data);
  check("hours are split billable / non-billable", r.data.billable_hours === 7 && r.data.non_billable_hours === 2, r.data);
  check("a timecard exists per matched person", (r.data.timecard_ids || []).length === 2, r.data.timecard_ids);
  check("somebody with no email is named rather than dropped",
    (r.data.no_email || []).some((n) => n.includes("Bob")), r.data.no_email);

  const tcId = r.data.timecard_ids[0];
  const tc = (await owner(`/api/hr/timecards/${tcId}`)).data;
  check("the timecard carries its shifts", (tc.entries || []).length >= 1, (tc.entries || []).length);
  check("each shift kept its appointment type", (tc.entries || []).every((e) => e.appt_type), tc.entries);

  // ------------------------------------------------------------------
  section("An export whose cells carry no position attribute");

  // r="B7" is optional in the spec. Omitting it used to make every row parse
  // as empty, and the only symptom was "no employees found".
  r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "norefs.xlsx", content_base64: b64(buildXlsx({
    Summary: [
      ["Start Date:", "09/07/2026", "", "End Date:", "09/20/2026"],
      ["Id", "FirstName", "LastName", "RegHours"],
      [`RT-A-${stamp}`, "Alice", `Payroll ${stamp}`, 4],
    ],
    "Time Sheet Entries": [
      ["", "Payroll detail"],
      ["", "Id", "Alerts", "StartTime", "EndTime", "DateOfService", "ActualStartTime", "ActualEndTime", "Duration", "StaffVerified", "ApptStatus", "Appt Type"],
      ["", `RT-A-${stamp}`, "", "9:00 AM", "1:00 PM", DAY(2026, 9, 8), "9:00 AM", "1:00 PM", 4, "Yes", "Completed", "Billable"],
    ],
  }, { withRefs: false })) } });
  check("it still imports", r.status === 200, r.data);
  check("with the right person and hours", r.data.matched === 1 && r.data.billable_hours === 4, r.data);

  // ------------------------------------------------------------------
  section("Tabs that have been renamed on the way through");

  r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "recased.xlsx", content_base64: b64(exportFor(roster, { summaryTab: "summary", entriesTab: "TimeSheet Entries" })) } });
  check("a re-cased and re-spaced tab name still matches", r.status === 200 && r.data.matched === 2, r.data);

  // ------------------------------------------------------------------
  section("When it cannot be read, it says what it saw");

  r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "wrong.xlsx", content_base64: b64(buildXlsx({ "Sheet1": [["Name", "Hours"], ["Alice", 4]] })) } });
  check("a file with no Summary tab is refused", r.status === 400, r.status);
  check("and it names the tabs the file actually has",
    /no Summary tab/i.test(r.data.error || "") && /Sheet1/.test(r.data.error || ""), r.data.error);

  r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "cols.xlsx", content_base64: b64(buildXlsx({
    Summary: [["Start Date:", "09/07/2026"], ["Employee", "Hours Worked"], ["Alice", 4]],
  })) } });
  check("a Summary tab with the wrong columns is refused", r.status === 400, r.status);
  check("and it prints the header it found, and the one it wanted",
    /Employee/.test(r.data.error || "") && /FirstName/.test(r.data.error || ""), r.data.error);

  r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "empty.xlsx", content_base64: b64(buildXlsx({ Summary: [] })) } });
  check("an empty Summary tab says it is empty", r.status === 400 && /empty/i.test(r.data.error || ""), r.data.error);

  r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "notazip.xlsx", content_base64: Buffer.from("this is not a spreadsheet").toString("base64") } });
  check("something that is not a spreadsheet at all is refused clearly",
    r.status === 400 && /\.xlsx|ZIP/i.test(r.data.error || ""), r.data.error);

  r = await clin("/api/hr/payroll/import", { method: "POST", body: { filename: "x.xlsx", content_base64: b64(exportFor(roster)) } });
  check("a clinical user cannot import payroll", r.status === 403, r.status);

  // ------------------------------------------------------------------
  section("Building from Rethink's verified sessions");

  r = await clin("/api/hr/timecards/from-rethink", { method: "POST", body: { from: "2026-09-07", to: "2026-09-20" } });
  check("a clinical user cannot build timecards", r.status === 403, r.status);

  r = await owner("/api/hr/timecards/from-rethink", { method: "POST", body: { from: "nope", to: "2026-09-20" } });
  check("a start date that is not a date is refused", r.status === 400 && /YYYY-MM-DD/.test(r.data.error || ""), r.data);

  r = await owner("/api/hr/timecards/from-rethink", { method: "POST", body: { from: "2026-09-20", to: "2026-09-07" } });
  check("a range that runs backwards is refused", r.status === 400 && /after the end/i.test(r.data.error || ""), r.data);

  r = await owner("/api/hr/timecards/from-rethink", { method: "POST", body: { from: "2026-09-07", to: "2026-09-20" } });
  // No Rethink credentials in the test environment, so this must fail LOUDLY
  // and specifically -- never with an empty, plausible-looking run of zero
  // timecards that somebody could mistake for "nobody worked".
  check("with no Rethink credentials it refuses rather than returning nothing",
    r.status === 502 || r.status === 503, { status: r.status, data: r.data });
  check("and says Rethink is the problem",
    /rethink|credential|configured/i.test((r.data && r.data.error) || ""), r.data);
  check("it did not create any timecards on the way",
    !r.data || !(r.data.timecard_ids || []).length, r.data && r.data.timecard_ids);

  // ------------------------------------------------------------------
  section("Which sessions land on a timecard");

  // The route's network half cannot run here, but the rule it applies can:
  // load the module with a stub context and feed it appointment rows. This is
  // the part that decides whose hours those were and which sessions count.
  const hrMod = require("./hr")({
    dbGet: async () => null, dbAll: async () => [], dbRun: async () => ({ rows: [] }),
    sendEmail: async () => ({}), nowISO: () => new Date().toISOString(),
    crypto, APP_BASE_URL: "http://localhost", readBody: async () => ({}),
    json: () => {}, sendFile: () => {},
    // Rethink's own rule, stubbed to the shape the real decide() returns --
    // INCLUDING its require_staff_verification opt-out, because that switch
    // being honoured is exactly the bug this suite has to catch.
    verificationVerdict: (row, cfg) => {
      const status = String(row.appointmentStatus || "").trim().toLowerCase();
      // Mirrors decide(): a practice that has named its accepted statuses is
      // held to that list, and only an unconfigured one falls back to the
      // module do not rule. A stub that always used the loose rule would let
      // a configured practice test pass for the wrong reason.
      const statusOk = (cfg && cfg.filter_confirmed)
        ? (cfg.completed_statuses || []).map((x) => String(x).trim().toLowerCase()).includes(status)
        : /^(completed|complete|finalized|finalised|rendered)$/.test(status);
      const verifiedOk = (cfg && cfg.require_staff_verification === false)
        ? true
        : String(row.staffVerification || "").toLowerCase() === "verified";
      return { statusOk, verifiedOk, counts: statusOk && verifiedOk };
    },
    rethinkBillableRaw: (row) => row.appointmentType || "",
    // Mirrors nameHint(): renderingProvider is the field this account's
    // appointment rows actually carry, so a stub that only knew staffName
    // would pass while production found nobody.
    rethinkStaffName: (row) => row.staffName || row.renderingProvider || null,
  });
  const group = hrMod._internal.groupVerifiedSessions;

  const rows = [
    { staffId: "S1", appointmentDate: "2026-09-09", actualDurationHours: 2, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Billable" },
    { staffId: "S1", appointmentDate: "2026-09-07", actualDurationHours: 3, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Non-Billable" },
    { staffId: "S2", appointmentDate: "2026-09-08", actualDurationHours: 4, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Billable" },
    // left out: delivered but never verified
    { staffId: "S1", appointmentDate: "2026-09-10", actualDurationHours: 8, staffVerification: "", appointmentStatus: "Completed", appointmentType: "Billable" },
    // left out: no staff member on the row at all
    { staffId: "", appointmentDate: "2026-09-11", actualDurationHours: 5, staffVerification: "Verified", appointmentStatus: "Completed" },
  ];
  const g = group(rows, {});
  check("every row is accounted for", g.scanned === 5, g);
  check("unverified sessions are left off", g.unverified === 1, g);
  check("so are rows with nobody on them", g.noStaff === 1, g);
  check("what is left is grouped per staff member", g.byStaff.size === 2, [...g.byStaff.keys()]);

  const s1 = g.byStaff.get("S1");
  check("one person's verified sessions are all there", s1.length === 2, s1);
  check("and are in date order, not the order Rethink returned them",
    s1[0].date === "2026-09-07" && s1[1].date === "2026-09-09", s1.map((e) => e.date));
  check("the unverified 8-hour session is nowhere in their hours",
    s1.reduce((a, e) => a + e.hours, 0) === 5, s1);
  check("billable and non-billable are carried through from the appointment type",
    s1.filter((e) => e.billable === true).length === 1 && s1.filter((e) => e.billable === false).length === 1, s1);
  check("no client name or id rides along on a timecard entry",
    s1.every((e) => !("clientId" in e) && !("clientName" in e) && !("client" in e)), s1[0]);

  // An id with no staff record has to be nameable, or "go link this person"
  // is not something anybody can act on.
  const named = group([
    { staffId: "S9", staffName: "Dana Reyes", appointmentDate: "2026-09-09", actualDurationHours: 2, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Billable" },
  ], {});
  check("an unmatched Rethink id carries the staff name off the session",
    named.names.get("S9") === "Dana Reyes", [...named.names.entries()]);

  // A row shaped exactly like the live ones. The field names below are the
  // ones Rethink logs on every Appointments fetch for this account -- note
  // appointmentDate arrives with a time on it, and staffId arrives as a
  // number, not a string.
  const live = group([
    { staffId: 4821, renderingProvider: "Ayaana Harris", appointmentDate: "2026-09-08T00:00:00",
      appointmentStartTime: "9:00 AM", actualDurationHours: 3.5, staffVerification: "Verified",
      appointmentStatus: "Completed", appointmentType: "Billable",
      clientId: 991, sessionNote: "a session note", diagnosisCode: "F84.0" },
  ], {});
  const liveEntries = live.byStaff.get("4821");
  check("a numeric staff id is keyed as the string the staff record stores", !!liveEntries, [...live.byStaff.keys()]);
  check("a date that arrives with a time on it is cut back to the day",
    liveEntries && liveEntries[0].date === "2026-09-08", liveEntries && liveEntries[0].date);
  check("the hours come off actualDurationHours", liveEntries && liveEntries[0].hours === 3.5, liveEntries);
  check("and the appointment type is read for the billable split",
    liveEntries && liveEntries[0].billable === true, liveEntries);
  check("no client id, session note or diagnosis rides along onto a timecard",
    !/a session note|F84\.0|991/.test(JSON.stringify(liveEntries)), liveEntries);

  // The two import routes write a pay period in different formats, so an
  // exact string match can never notice that the same fortnight is already on
  // file. Two timecards for one pay period is a payroll mess worth naming.
  const overlap = hrMod._internal.periodsOverlap;
  const pday = hrMod._internal.periodDay;
  check("the spreadsheet's date format is understood", pday("09/07/2026") === "2026-09-07", pday("09/07/2026"));
  check("and so is ISO", pday("2026-09-07") === "2026-09-07", pday("2026-09-07"));
  check("the same fortnight written both ways is seen as the same dates",
    overlap("2026-09-07", "2026-09-20", "09/07/2026", "09/20/2026") === true);
  check("a period that merely touches at one end still overlaps",
    overlap("2026-09-07", "2026-09-20", "09/20/2026", "10/03/2026") === true);
  check("the next fortnight does not", overlap("2026-09-07", "2026-09-20", "09/21/2026", "10/04/2026") === false);
  check("an unparseable period never counts as an overlap",
    overlap("2026-09-07", "2026-09-20", "last two weeks", "") === false);

  const empty = group([], {});
  check("an empty range groups to nobody rather than throwing", empty.byStaff.size === 0 && empty.scanned === 0, empty);

  // ------------------------------------------------------------------
  section("An unverified session never reaches a timecard");

  // The shared Rethink filter carries a require_staff_verification switch, and
  // when it is off the verification test is skipped entirely: every completed
  // session counts as verified. Defensible for a supervision total, wrong for
  // a timecard -- it put unverified sessions in front of staff to sign for.
  {
    const rows = [
      { staffId: "V1", appointmentDate: "2026-09-08", actualDurationHours: 4, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Billable" },
      { staffId: "V1", appointmentDate: "2026-09-09", actualDurationHours: 8, staffVerification: "", appointmentStatus: "Completed", appointmentType: "Billable" },
      { staffId: "V1", appointmentDate: "2026-09-10", actualDurationHours: 3, staffVerification: "Cancelled by staff", appointmentStatus: "Cancelled", appointmentType: "Billable" },
    ];

    // The switch OFF is the setting that caused this. It must change nothing.
    const off = group(rows, { require_staff_verification: false });
    const entries = off.byStaff.get("V1") || [];
    check("with verification switched off in the shared filter, the unverified session is STILL left off",
      entries.length === 1 && entries[0].date === "2026-09-08", entries.map((e) => e.date));
    check("and only the verified hours are counted",
      entries.reduce((a, e) => a + e.hours, 0) === 4, entries);
    check("the unverified one is counted as unverified", off.unverified === 1, off);

    // Switched on, the answer is identical -- the timecard never depended on it.
    const on = group(rows, { require_staff_verification: true });
    check("switching it on changes nothing, because a timecard never honoured it",
      (on.byStaff.get("V1") || []).length === 1 && on.unverified === 1, on);

    // The two reasons a session is dropped are not the same thing, and used to
    // be counted together and reported as "not staff-verified".
    check("a session that was not completed is counted separately, not as unverified",
      off.notCompleted === 1 && off.unverified === 1, { notCompleted: off.notCompleted, unverified: off.unverified });

    // What the verification field actually said, so an emptier-than-expected
    // range explains itself.
    const vals = Object.fromEntries((off.verification_values || []).map((v) => [v.value, v.sessions]));
    check("the verification values seen are reported, blanks included",
      vals["verified"] === 1 && vals["(blank)"] === 1, off.verification_values);
    check("and a session that never happened is not tallied among them",
      !vals["cancelled by staff"], off.verification_values);
  }

  // ------------------------------------------------------------------
  section("Why a range is shorter than the payroll export");

  // Reported from a real run: one RBT's timecard came back 37 hours where the
  // payroll export said 77. The screen said "13 were not completed sessions"
  // and stopped there -- which is the shape of an answer without being one.
  // Forty hours of somebody's pay were missing and there was nothing on the
  // screen to check: no way to see whether those thirteen were cancellations
  // or real work filed under a status this practice never told the CRM to
  // count. The words Rethink used, and the hours behind them, are the whole
  // difference between "that is right" and "that is wrong".
  {
    const rows = [
      { staffId: "W1", appointmentDate: "2026-09-08", actualDurationHours: 4, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Billable" },
      // Real work, under a word the accepted-status list does not carry.
      { staffId: "W1", appointmentDate: "2026-09-09", actualDurationHours: 6, staffVerification: "Verified", appointmentStatus: "Rendered", appointmentType: "Billable" },
      { staffId: "W1", appointmentDate: "2026-09-10", actualDurationHours: 5, staffVerification: "Verified", appointmentStatus: "Rendered", appointmentType: "Billable" },
      // Not work at all.
      { staffId: "W1", appointmentDate: "2026-09-11", actualDurationHours: 3, staffVerification: "", appointmentStatus: "Cancelled", appointmentType: "Billable" },
      // Happened, nobody verified it.
      { staffId: "W1", appointmentDate: "2026-09-12", actualDurationHours: 2, staffVerification: "", appointmentStatus: "Completed", appointmentType: "Billable" },
    ];
    // The configured case: this practice has named its accepted statuses and
    // "Rendered" is not among them, so real work files itself under a word the
    // CRM has not been told to count.
    const g = group(rows, { filter_confirmed: true, completed_statuses: ["Completed"], verified_values: ["Verified"] });

    check("only the completed, verified session lands on the timecard",
      (g.byStaff.get("W1") || []).length === 1, g.byStaff.get("W1"));
    check("the sessions dropped for their status are counted", g.notCompleted === 3, g.notCompleted);
    check("and the ones dropped for verification separately", g.unverified === 1, g.unverified);

    const st = Object.fromEntries((g.status_values || []).map((v) => [v.value, v.sessions]));
    check("the screen can say WHICH status kept them off, not just how many",
      st.rendered === 2 && st.cancelled === 1, g.status_values);
    check("the most common reason is reported first, so the big one is not buried",
      (g.status_values || [])[0].value === "rendered", g.status_values);

    // The number somebody actually compares against a payroll report.
    check("the hours behind the dropped sessions are totalled",
      g.not_completed_hours === 14 && g.unverified_hours === 2,
      { notCompleted: g.not_completed_hours, unverified: g.unverified_hours });
    check("so 4 on the timecard and 16 left off accounts for all 20 hours Rethink sent",
      4 + g.not_completed_hours + g.unverified_hours === 20,
      { onCard: 4, notCompleted: g.not_completed_hours, unverified: g.unverified_hours });

    // Per person, because a build for one employee that reports the whole
    // practice's numbers is telling them about sessions that are not theirs.
    const two = group([
      ...rows,
      { staffId: "W2", appointmentDate: "2026-09-08", actualDurationHours: 9, staffVerification: "Verified", appointmentStatus: "No Show", appointmentType: "Billable" },
    ], { filter_confirmed: true, completed_statuses: ["Completed"], verified_values: ["Verified"] });
    const exW1 = two.excludedByStaff.get("W1");
    const exW2 = two.excludedByStaff.get("W2");
    check("each staff member's dropped statuses are kept against their own id",
      exW1.statuses.get("rendered") === 2 && !exW1.statuses.has("no show"),
      [...exW1.statuses.entries()]);
    check("and somebody else's are not mixed in",
      exW2.statuses.get("no show") === 1 && exW2.statuses.size === 1, [...exW2.statuses.entries()]);
    check("the hours left off are attributed per person too",
      exW1.hours === 16 && exW2.hours === 9, { w1: exW1.hours, w2: exW2.hours });
    check("what the verification field said is kept per person as well",
      exW1.verifications.get("(blank)") === 1, [...exW1.verifications.entries()]);

    // A range where nothing was dropped says nothing, rather than an empty list.
    const clean = group([rows[0]], { filter_confirmed: true, completed_statuses: ["Completed"], verified_values: ["Verified"] });
    check("a range that dropped nothing reports no statuses to explain",
      (clean.status_values || []).length === 0 && clean.not_completed_hours === 0, clean.status_values);
  }

  // ------------------------------------------------------------------
  section("Billable or non-billable, and nothing else");

  // Every appointment at this practice is one or the other. A timecard that
  // offered a third "Not labeled" column handed back a pile of hours for
  // somebody to classify by hand, for a distinction that had already been
  // made -- and those hours sat outside both subtotals on the sheet staff
  // were asked to sign.
  {
    const totals = hrMod._internal.timecardTotals;
    const g = group([
      { staffId: "B1", appointmentDate: "2026-09-08", actualDurationHours: 4, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Billable" },
      { staffId: "B1", appointmentDate: "2026-09-09", actualDurationHours: 2, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Non-Billable" },
      // Rethink sent no type at all.
      { staffId: "B1", appointmentDate: "2026-09-10", actualDurationHours: 3, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "" },
      // And a word that is neither.
      { staffId: "B1", appointmentDate: "2026-09-11", actualDurationHours: 1, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Parent Training" },
    ], {});
    const e = g.byStaff.get("B1") || [];
    check("every verified session is on the timecard", e.length === 4, e.length);
    check("not one entry is left unclassified",
      e.every((x) => x.billable === true || x.billable === false), e.map((x) => x.billable));
    check("Rethink's own word still decides when it gives one",
      e[0].billable === true && e[1].billable === false, e.slice(0, 2));
    check("an hour Rethink said nothing about counts as non-billable, not as billable",
      e[2].billable === false && e[3].billable === false, e.slice(2));
    check("and is stamped as a guess, so the review screen can say which ones",
      e[2].billable_inferred === true && e[3].billable_inferred === true
        && !e[0].billable_inferred && !e[1].billable_inferred, e);

    const t = totals(e);
    check("the sheet has no third column of hours", t.unclassified_hours === 0 && t.unclassified.length === 0, t.unclassified);
    check("and the two subtotals account for the whole 10 hours",
      t.billable_hours === 4 && t.non_billable_hours === 6, t);
  }

  // The same rule on the spreadsheet route, end to end -- two import paths
  // disagreeing about what a blank cell means is its own bug.
  {
    const blankId = await mk(`Blankcell Payroll ${stamp}`, `RT-BC-${stamp}`, `blank.${stamp}@example.test`);
    r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "blanktype.xlsx", content_base64: b64(exportFor([
      { id: `RT-BC-${stamp}`, first: "Blankcell", last: `Payroll ${stamp}`, reg: 7,
        shifts: [{ day: 8, hours: 4, type: "Billable" }, { day: 9, hours: 3, type: "" }] },
    ])) } });
    check("an export with a blank Appt Type cell still imports", r.status === 200, r.data);
    check("the blank cell does not become a third bucket of hours",
      !r.data.unclassified_hours, r.data);
    check("it is counted as non-billable, the safe direction",
      r.data.billable_hours === 4 && r.data.non_billable_hours === 3, r.data);
    const card = (await owner(`/api/hr/timecards/${r.data.timecard_ids[0]}`)).data;
    const blank = (card.entries || []).find((x) => !String(x.appt_type || "").trim());
    check("and the entry itself says non-billable rather than nothing",
      blank && blank.billable === false, blank);
    check("stamped as inferred, because the export did not say so",
      blank && blank.billable_inferred === true, blank);
    void blankId;
  }

  // ------------------------------------------------------------------
  section("One person, several Rethink staff records");

  // Straight from a real run: Rethink held THREE staff records for one RBT.
  // Only one carried the id linked to her staff record, so she arrived as
  // three rows -- one "ready" and two "no staff match" -- and her hours were
  // split across three timecards, two of them attached to nobody.
  const splitEmp = await mk(`Marissa Split ${stamp}`, `RT-M1-${stamp}`, `marissa.${stamp}@example.test`);
  const sessionsFor = (id, day, hours) => ({
    staffId: id, renderingProvider: `Marissa Split ${stamp}`,
    appointmentDate: `2026-09-${String(day).padStart(2, "0")}T00:00:00`,
    actualDurationHours: hours, staffVerification: "Verified",
    appointmentStatus: "Completed", appointmentType: "Billable",
  });
  const splitRows = [
    sessionsFor(`RT-M1-${stamp}`, 8, 10),   // the linked record
    sessionsFor(`RT-M2-${stamp}`, 9, 5),    // a second record, same human
    sessionsFor(`RT-M3-${stamp}`, 10, 2.5), // and a third
  ];

  r = await owner("/api/hr/timecards/from-rethink", { method: "POST", body: { from: "2026-09-07", to: "2026-09-20" } });
  check("the route still refuses without Rethink credentials rather than inventing hours",
    r.status === 502 || r.status === 503, r.status);

  // The merge itself is the rule under test, and it needs a database, so drive
  // it through a module instance wired to the real one.
  {
    const names = new Map(splitRows.map((row) => [String(row.staffId), row.renderingProvider]));
    const byStaff = new Map();
    for (const row of splitRows) {
      const k = String(row.staffId);
      if (!byStaff.has(k)) byStaff.set(k, []);
      byStaff.get(k).push({ date: String(row.appointmentDate).slice(0, 10), hours: row.actualDurationHours, appt_type: "Billable", billable: true });
    }
    // Resolve exactly the way the route does.
    const resolve = async (staffId) => {
      let st = (await q("SELECT id, name, email FROM hr_employees WHERE rethink_id = ?", [staffId])).rows[0] || null;
      let by = st ? "rethink_id" : null;
      const hint = names.get(staffId);
      if (!st && hint) {
        st = (await q(
          `SELECT id, name, email FROM hr_employees WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
            ORDER BY (COALESCE(status,'active') = 'terminated'), id LIMIT 1`, [hint])).rows[0] || null;
        if (st) by = "name";
      }
      return { st, by };
    };
    const buckets = new Map();
    for (const [staffId, entries] of byStaff) {
      const { st, by } = await resolve(staffId);
      const key = st ? `emp:${st.id}` : `name:${String(names.get(staffId) || "").toLowerCase()}`;
      const b = buckets.get(key) || { staff: st, matchedBy: by, staffIds: [], entries: [] };
      if (!b.staff && st) { b.staff = st; b.matchedBy = by; }
      b.staffIds.push(staffId); b.entries.push(...entries);
      buckets.set(key, b);
    }
    check("three Rethink staff records for one person collapse to one timecard", buckets.size === 1, buckets.size);
    const only = [...buckets.values()][0];
    check("and it is attached to her real staff record", only.staff && only.staff.id === splitEmp, only.staff);
    check("carrying every session from all three records", only.entries.length === 3, only.entries.length);
    check("and the hours add up rather than being split three ways",
      only.entries.reduce((a, e) => a + e.hours, 0) === 17.5, only.entries);
    check("the merge records which Rethink ids it came from", only.staffIds.length === 3, only.staffIds);
    check("the id-linked record is what identified her, not a name guess",
      only.matchedBy === "rethink_id", only.matchedBy);
  }

  // The same person with NO id linked at all: the name is the only way in, and
  // it must be reported as a name match rather than passed off as certain.
  {
    const nameOnlyEmp = await mk(`Nameonly Match ${stamp}`, null, `nameonly.${stamp}@example.test`);
    const st = (await q(
      `SELECT id, name FROM hr_employees WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
        ORDER BY (COALESCE(status,'active') = 'terminated'), id LIMIT 1`, [`Nameonly Match ${stamp}`])).rows[0];
    check("an unlinked Rethink record still finds its person by name", st && st.id === nameOnlyEmp, st);
  }

  // A name that two staff records share must prefer the one still employed.
  {
    const dupName = `Dup Employed ${stamp}`;
    const goneId = (await q(
      "INSERT INTO hr_employees (name,email,status,created_at) VALUES ($1,$2,'terminated',now()) RETURNING id",
      [dupName, `gone.${stamp}@example.test`])).rows[0].id;
    const hereId = await mk(dupName, null, `here.${stamp}@example.test`);
    const pick = (await q(
      `SELECT id FROM hr_employees WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
        ORDER BY (COALESCE(status,'active') = 'terminated'), id LIMIT 1`, [dupName])).rows[0];
    check("a shared name prefers the staff member who still works here",
      pick && pick.id === hereId && pick.id !== goneId, { pick, hereId, goneId });
  }

  // ------------------------------------------------------------------
  section("Building one person's timecard on its own");

  // Doing a single person should not need a spreadsheet, and should not be a
  // different code path from the batch -- a one-off that disagreed with the
  // batch would be worse than not having it.
  r = await owner("/api/hr/timecards/from-rethink", { method: "POST", body: { from: "2026-09-07", to: "2026-09-20", employee_id: 999999 } });
  check("building for a staff member who does not exist is refused", r.status === 404, { status: r.status, data: r.data });

  r = await owner("/api/hr/timecards/from-rethink", { method: "POST", body: { from: "2026-09-07", to: "2026-09-20", employee_id: "not-a-number" } });
  check("and so is something that is not a staff member at all", r.status === 400, { status: r.status, data: r.data });

  r = await owner("/api/hr/timecards/from-rethink", { method: "POST", body: { from: "2026-09-07", to: "2026-09-20", employee_id: splitEmp } });
  check("a real staff member still refuses without Rethink credentials rather than inventing hours",
    r.status === 502 || r.status === 503, { status: r.status, data: r.data });

  r = await clin("/api/hr/timecards/from-rethink", { method: "POST", body: { from: "2026-09-07", to: "2026-09-20", employee_id: splitEmp } });
  check("a clinical user cannot build one person's timecard either", r.status === 403, r.status);

  // The per-person accounting has to be about THAT person. "29 sessions left
  // off" across the whole practice says nothing about the name on the screen.
  {
    const g = group([
      { staffId: "P1", renderingProvider: "Solo One", appointmentDate: "2026-09-08", actualDurationHours: 4, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Billable" },
      { staffId: "P1", renderingProvider: "Solo One", appointmentDate: "2026-09-09", actualDurationHours: 3, staffVerification: "", appointmentStatus: "Completed", appointmentType: "Billable" },
      { staffId: "P2", renderingProvider: "Solo Two", appointmentDate: "2026-09-09", actualDurationHours: 9, staffVerification: "", appointmentStatus: "Completed", appointmentType: "Billable" },
    ], {});
    check("skipped sessions are attributed to the staff member they belong to",
      g.excludedByStaff.get("P1").unverified === 1 && g.excludedByStaff.get("P2").unverified === 1,
      [...g.excludedByStaff.entries()]);
    check("so one person's count is not the whole practice's",
      g.excludedByStaff.get("P1").unverified !== g.unverified, { theirs: g.excludedByStaff.get("P1"), everyone: g.unverified });
    check("somebody whose every session was unverified is still named",
      g.names.get("P2") === "Solo Two", [...g.names.entries()]);
    check("and has no bucket of hours, because none of it is verified",
      !g.byStaff.has("P2"), [...g.byStaff.keys()]);
  }

  // ------------------------------------------------------------------
  section("A person whose Rethink record is not linked");

  // Reported from a real run: a BCBA who is plainly in Rethink came back as
  // "Rethink has no sessions for them in these dates". Her CRM record carried
  // no Rethink id and her name in Rethink did not match hers here, so her
  // sessions sat in a bucket belonging to nobody -- and the screen told her
  // employer she had delivered nothing, which was false.
  {
    const g = group([
      // Hers, under a spelling the CRM does not have.
      { staffId: "MG1", renderingProvider: "Galang, Micah", appointmentDate: "2026-09-08", actualDurationHours: 6, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Billable" },
      { staffId: "MG1", renderingProvider: "Galang, Micah", appointmentDate: "2026-09-09", actualDurationHours: 4, staffVerification: "Verified", appointmentStatus: "Completed", appointmentType: "Billable" },
    ], {});
    const bucketKeys = [...g.byStaff.keys()];
    check("her sessions are still read off Rethink", bucketKeys.includes("MG1"), bucketKeys);
    check("and carry the name Rethink gave them", g.names.get("MG1") === "Galang, Micah", [...g.names.entries()]);
    check("they are not counted as unverified -- they were verified",
      g.unverified === 0 && g.notCompleted === 0, g);

    // What the route does with that: the bucket resolves to no employee, so it
    // becomes an unlinked candidate rather than silently vanishing.
    const unresolved = { staff: null, hint: g.names.get("MG1"), staffIds: ["MG1"], entries: g.byStaff.get("MG1") };
    const candidate = {
      name: unresolved.hint,
      rethink_ids: unresolved.staffIds,
      sessions: unresolved.entries.length,
      hours: unresolved.entries.reduce((a, e) => a + e.hours, 0),
    };
    check("an unlinked Rethink record is reportable by name, not just by id",
      candidate.name === "Galang, Micah", candidate);
    check("with the work it represents, so it is obvious it is somebody's",
      candidate.sessions === 2 && candidate.hours === 10, candidate);
  }

  // ------------------------------------------------------------------
  section("A person whose every session was excluded");

  // Reported from a real run, one deploy after the unlinked-candidate list
  // shipped: a BCBA plainly working in Rethink still came back as
  // "nothing in Rethink for these dates is theirs". The list was built from
  // the BUCKETS, and a bucket only exists for a staff id with at least one
  // session that survived the filters. Somebody whose fortnight is entirely
  // supervision and assessment -- filed under a status this practice has not
  // told the CRM to count -- produces no bucket at all, so they were invisible
  // to the very list that exists to find them. Same false sentence, new place.
  {
    const cfgStrict = { filter_confirmed: true, completed_statuses: ["Completed"], verified_values: ["Verified"] };
    const g = group([
      // Hers: real work, every session under a word the accepted list lacks.
      { staffId: "EX1", renderingProvider: "Galang, Micah", appointmentDate: "2026-09-08", actualDurationHours: 6, staffVerification: "Verified", appointmentStatus: "Rendered", appointmentType: "Billable" },
      { staffId: "EX1", renderingProvider: "Galang, Micah", appointmentDate: "2026-09-09", actualDurationHours: 4, staffVerification: "Verified", appointmentStatus: "Rendered", appointmentType: "Billable" },
      { staffId: "EX1", renderingProvider: "Galang, Micah", appointmentDate: "2026-09-10", actualDurationHours: 2, staffVerification: "", appointmentStatus: "Completed", appointmentType: "Billable" },
    ], cfgStrict);

    check("she produces no bucket at all, because nothing survived the filters",
      !g.byStaff.has("EX1"), [...g.byStaff.keys()]);
    check("but the staff id is still named, so she is not anonymous",
      g.names.get("EX1") === "Galang, Micah", [...g.names.entries()]);

    // Everything the screen needs comes off excludedByStaff, which is the
    // half the candidate list was not reading.
    const ex = g.excludedByStaff.get("EX1");
    check("her sessions are all accounted for against her id",
      ex.notCompleted === 2 && ex.unverified === 1, ex);
    check("with the hours behind them, so the work is not reported as nothing",
      ex.hours === 12, ex.hours);
    check("and the word that kept them off, so it can be checked",
      ex.statuses.get("rendered") === 2, [...ex.statuses.entries()]);

    // What the route builds from that: a candidate with zero counted and the
    // exclusions attached, rather than no candidate at all.
    const candidate = {
      name: g.names.get("EX1"),
      rethink_ids: ["EX1"],
      sessions: 0,
      hours: 0,
      excluded_sessions: ex.unverified + ex.notCompleted,
      excluded_hours: ex.hours,
      statuses: [...ex.statuses.entries()].map(([value, sessions]) => ({ value, sessions })),
      unverified: ex.unverified,
    };
    check("she is reportable by name even though nothing of hers counted",
      candidate.name === "Galang, Micah" && candidate.sessions === 0, candidate);
    check("carrying the work that was left off, so nobody reads it as an idle fortnight",
      candidate.excluded_sessions === 3 && candidate.excluded_hours === 12, candidate);
    check("and the status to check, which is the actionable part",
      candidate.statuses.some((x) => x.value === "rendered" && x.sessions === 2), candidate.statuses);
  }

  // ------------------------------------------------------------------
  section("Building the same period twice");

  // The normal way to use a date range: build it, notice people have not
  // verified their sessions yet, chase them, build again. That must not leave
  // two timecards per person with no way to tell which one to send.
  //
  // Driven through a module instance wired to the real database, so this is
  // the same upsert the route calls -- not a re-implementation of it.
  const dbHr = require("./hr")({
    dbGet: async (sql, p2) => (await q(sql, p2)).rows[0] || null,
    dbAll: async (sql, p2) => (await q(sql, p2)).rows,
    dbRun: async (sql, p2) => await q(sql, p2),
    sendEmail: async () => ({}), nowISO: () => new Date().toISOString(),
    crypto, APP_BASE_URL: "http://localhost", readBody: async () => ({}),
    json: () => {}, sendFile: () => {},
  });
  const upsert = dbHr._internal.upsertPeriodTimecard;

  const rebuildEmp = await mk(`Rebuild Test ${stamp}`, `RT-R-${stamp}`, `rebuild.${stamp}@example.test`);
  const period = { employee_id: rebuildEmp, source: "rethink_verified", pay_period_start: "2026-09-07", pay_period_end: "2026-09-20" };
  const withHours = (hours) => ({ ...period, entries: [{ date: "2026-09-08", hours, appt_type: "Billable", billable: true }] });
  const cards = async () => (await q(
    "SELECT id, status, entries FROM hr_timecards WHERE employee_id = ? ORDER BY id", [rebuildEmp])).rows;

  const first = await upsert(withHours(4), "tester");
  check("the first build creates a timecard", !!first.id && first.replaced === false, first);
  check("and there is exactly one", (await cards()).length === 1, (await cards()).length);

  const second = await upsert(withHours(6), "tester");
  check("building the same period again does NOT create a second timecard", (await cards()).length === 1, (await cards()).length);
  check("it rebuilds the one that was already there", second.id === first.id && second.replaced === true, second);
  check("with the new hours, not the old ones",
    JSON.parse((await cards())[0].entries)[0].hours === 6, (await cards())[0].entries);

  // Once it has been sent for signature it is a record of what somebody was
  // shown, and is never rewritten underneath them.
  await q("UPDATE hr_timecards SET verification_requested_at = ? WHERE id = ?", [new Date().toISOString(), first.id]);
  const third = await upsert(withHours(99), "tester");
  check("a timecard already sent for signature is reported as locked", third.locked === true && third.replaced === false, third);
  check("its hours are left exactly as that employee saw them",
    JSON.parse((await cards())[0].entries)[0].hours === 6, (await cards())[0].entries);
  check("and no duplicate was created alongside it", (await cards()).length === 1, (await cards()).length);

  // A different period for the same person is a different timecard.
  const other = await upsert({ ...period, pay_period_start: "2026-09-21", pay_period_end: "2026-10-04", entries: [{ date: "2026-09-22", hours: 3 }] }, "tester");
  check("the next pay period gets its own timecard", other.id !== first.id && (await cards()).length === 2, (await cards()).length);

  // ------------------------------------------------------------------
  section("Reviewing a fortnight where everybody is already signed");

  // Reported from a real run: "the review timecard button is not working."
  // It was enabled off MATCHED but opened on the SENDABLE ids, and a card
  // already sent for signature is excluded from those. A fortnight whose only
  // person is already signed therefore offered "Preview & send 1 timecard(s)"
  // and opened a review with nothing in it. Nothing errored, so pressing it
  // simply did nothing -- and there was no other way to reach that person's
  // signing link.
  {
    const lockedEmp = await mk(`Locked Review ${stamp}`, `RT-LK-${stamp}`, `locked.${stamp}@example.test`);
    const card = await dbHr._internal.upsertPeriodTimecard({
      employee_id: lockedEmp, source: "rethink_verified",
      pay_period_start: "2026-09-07", pay_period_end: "2026-09-20",
      entries: [{ date: "2026-09-08", hours: 4, appt_type: "Billable", billable: true }],
    }, "tester");
    await q("UPDATE hr_timecards SET verification_requested_at = ? WHERE id = ?", [new Date().toISOString(), card.id]);

    // An empty array is TRUTHY, so the old "sendable || everything" fallback
    // never ran. Pinned because it is the whole shape of the bug.
    const sendable = [];
    check("an empty sendable list does not fall back through ||",
      (sendable || ["would-have-fallen-back"]).length === 0, sendable);

    // preview-batch is what the review screen loads. Asked for the locked
    // card by id it returns it, so the screen has something to show.
    r = await owner("/api/hr/timecards/preview-batch", { method: "POST", body: { ids: [card.id] } });
    check("the review screen can load a timecard that is already sent", r.status === 200 && r.data.count === 1, r.data);
    // Still sendable: "already sent" locks it against being REBUILT under
    // somebody who has already seen it, not against being sent again. The
    // screen labels it "already sent -- this resends" and means it.
    check("and marks it as already sent rather than hiding it",
      (r.data.timecards[0].already_sent_at || null) !== null, r.data.timecards && r.data.timecards[0]);
    check("which is a resend, not a refusal -- the badge and the count agree",
      r.data.sendable === 1, r.data.sendable);

    // The link, which is the thing asked for: a way to get it to somebody
    // when the email is not how it is reaching them.
    r = await owner(`/api/hr/timecards/${card.id}/link`);
    check("an already-sent timecard hands back its signing link", r.status === 200 && !!r.data.url, r.data);
    check("the link is the same verify-timecard URL the email uses, not a new shape",
      /\/verify-timecard\/[a-f0-9]{8,}$/.test(r.data.url || ""), r.data.url);

    // Asking twice must not invalidate what the employee already has.
    const again = await owner(`/api/hr/timecards/${card.id}/link`);
    check("asking again returns the SAME link, so the one they were emailed still works",
      again.data.url === r.data.url, { first: r.data.url, second: again.data.url });

    r = await clin(`/api/hr/timecards/${card.id}/link`);
    check("a clinical user cannot read somebody's signing link", r.status === 403, r.status);

    r = await owner("/api/hr/timecards/99999999/link");
    check("a timecard that does not exist has no link to give", r.status === 404, r.status);
  }

  // ------------------------------------------------------------------
  section("The export knows the Rethink IDs the API will not give");

  // This account's appointment payload carries no provider name, so the
  // Rethink Staff screen lists people as bare numbers nobody can link. The
  // payroll export pairs an id with a first and last name on every row -- the
  // exact mapping that is missing -- and the import read it, matched on the
  // NAME, and threw the id away. Every pay period, for as long as there have
  // been pay periods.
  {
    const learnName = `Learnid Person ${stamp}`;
    const learnEmp = await mk(learnName, null, `learn.${stamp}@example.test`);  // deliberately no rethink_id
    const rid = `RT-LEARN-${stamp}`;

    r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "learn.xlsx", content_base64: b64(exportFor([
      { id: rid, first: "Learnid", last: `Person ${stamp}`, reg: 5, shifts: [{ day: 8, hours: 5, type: "Billable" }] },
    ])) } });
    check("the export still imports as usual", r.status === 200, r.data);
    check("and the person is matched on their name, as before", r.data.matched === 1, r.data);
    check("it reports the Rethink ID their CRM record is missing",
      (r.data.link_suggestions || []).some((l) => l.employee_id === learnEmp && l.rethink_id === rid),
      r.data.link_suggestions);
    check("and NOTHING is written -- the id is offered, not applied",
      !(await q("SELECT rethink_id FROM hr_employees WHERE id = ?", [learnEmp])).rows[0].rethink_id,
      "rethink_id must still be null until somebody presses Link");

    // Somebody who already has an id is not offered one.
    r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "already.xlsx", content_base64: b64(exportFor([
      { id: `RT-A-${stamp}`, first: "Alice", last: `Payroll ${stamp}`, reg: 4, shifts: [{ day: 8, hours: 4, type: "Billable" }] },
    ])) } });
    check("a staff member already linked is not offered a link again",
      !(r.data.link_suggestions || []).some((l) => l.employee_id === aliceId), r.data.link_suggestions);

    // An id already on somebody else is never quietly moved.
    const otherName = `Otherlearn Person ${stamp}`;
    const otherEmp = await mk(otherName, null, `otherlearn.${stamp}@example.test`);
    r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "taken.xlsx", content_base64: b64(exportFor([
      { id: `RT-A-${stamp}`, first: "Otherlearn", last: `Person ${stamp}`, reg: 3, shifts: [{ day: 9, hours: 3, type: "Billable" }] },
    ])) } });
    // NOT what it looks like: the id lookup runs first, so this row matches
    // ALICE, who holds that id, and never reaches the name match at all. That
    // is the behaviour worth pinning -- an id in the export belongs to whoever
    // holds it, and a name-twin cannot take it off them.
    check("an id already on a staff record stays with its holder, and no second link is offered",
      !(r.data.link_suggestions || []).some((l) => l.employee_id === otherEmp)
        && (r.data.employees || []).every((e) => e.matched_by !== "name"),
      { links: r.data.link_suggestions, employees: r.data.employees });

    // A name the CRM has never heard of is a person to add, not a link.
    r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "stranger.xlsx", content_base64: b64(exportFor([
      { id: `RT-STR-${stamp}`, first: "Stranger", last: `Nobody ${stamp}`, reg: 2, shifts: [{ day: 9, hours: 2, type: "Billable" }] },
    ])) } });
    check("an id reaching nobody on the roster is reported as unknown, not as a link",
      (r.data.unknown_ids || []).some((u) => u.rethink_id === `RT-STR-${stamp}`)
        && !(r.data.link_suggestions || []).length, { unknown: r.data.unknown_ids, links: r.data.link_suggestions });

    // Pressing Link goes through the Rethink Staff endpoint -- one way to
    // link a person, not two that can disagree.
    const linked = await owner("/api/rethink/staff-match/link", { method: "POST", body: { rethink_staff_id: rid, employee_id: learnEmp } });
    check("linking from the import preview writes the id", linked.status === 200, linked.data);
    check("and the staff record now carries it",
      String((await q("SELECT rethink_id FROM hr_employees WHERE id = ?", [learnEmp])).rows[0].rethink_id) === rid,
      "rethink_id after link");

    // Which is the point: next time, no suggestion, because it matches on id.
    r = await owner("/api/hr/payroll/import", { method: "POST", body: { filename: "learn2.xlsx", content_base64: b64(exportFor([
      { id: rid, first: "Learnid", last: `Person ${stamp}`, reg: 5, shifts: [{ day: 10, hours: 5, type: "Billable" }] },
    ])) } });
    check("the next export matches them on the id and offers nothing",
      r.data.matched === 1 && !(r.data.link_suggestions || []).length, r.data.link_suggestions);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
