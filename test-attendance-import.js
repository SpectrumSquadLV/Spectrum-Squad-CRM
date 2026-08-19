// test-attendance-import.js -- the one-time import of the historical
// attendance log.
//
// The practice tracked attendance in a Google Sheet before this module. The
// CRM is the system of record now, so the history has to come across: a rolling
// 90-day total that restarted at zero would hand out $50 bonuses nobody earned
// and erase warnings people are already carrying.
//
// The rows below are the real shapes out of "Attendance Log - RBTs", including
// the four things actually wrong with it:
//   * the same occurrence typed two different ways either side of the 6/1/2026
//     policy rewrite ("Call-off  (>=4 hours notice)" vs "Call-off (with more
//     than 4 hours notice)")
//   * staff names that drift ("Nicolas Lineras" for Linares, "Katelyn" for Kate)
//   * the occurrence type pasted into the Emergency?/Documentation? columns
//   * a trailing space on a name
//
//   DATABASE_URL=... node server.js
//   node test-attendance-import.js
"use strict";

const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";
const STAFF_PW = process.env.STAFF_PASSWORD || "TestStaff123!";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

async function login(email, password) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("login failed for " + email + ": " + res.status);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => ({})) : await r.text() };
  };
}

const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
// The log is in M/D/YYYY, like the sheet.
const usDate = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
};

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", OWNER_PW);
  const clinical = await login("clinical@spectrumsquadlv.com", STAFF_PW);
  // An alphabetic run marker, not digits: the importer normalises names down to
  // letters (real names have no digits in them), so a numeric stamp would leave
  // every run's "Nicolas Linares" looking identical to the last run's.
  const stamp = (function () {
    let n = Date.now() % 308915776, out = "";
    while (out.length < 6) { out = "abcdefghijklmnopqrstuvwxyz"[n % 26] + out; n = Math.floor(n / 26); }
    return out.charAt(0).toUpperCase() + out.slice(1);
  })();
  let r;

  // Two staff members whose names the sheet gets wrong in exactly the ways the
  // real one does.
  let mkSeq = 0;
  const mk = async (name, hireDaysAgo) => {
    // Distinct email per record even when two share a name -- that is how two
    // real people with the same name are told apart everywhere else in the CRM.
    const e = await owner("/api/hr/employees", {
      method: "POST",
      body: { name, email: `${name.replace(/\W/g, "").toLowerCase()}.${++mkSeq}@example.invalid`, role_title: "RBT", status: "active", hire_date: daysAgo(hireDaysAgo) },
    });
    return e.data && (e.data.id || (e.data.employee && e.data.employee.id));
  };
  const linaresId = await mk(`Nicolas ${stamp} Linares`, 300);
  const kateId = await mk(`Kate ${stamp} Brunner`, 300);
  check("created the two staff members the log misspells", !!linaresId && !!kateId, { linaresId, kateId });

  // --------------------------------------------------------------------
  section("Reading the log");

  const header = "Date\tStaff Name\tShift Start\tOccurrence Type\tEmergency? (Y/N)\tDocumentation? (Y/N)\tTime Notified\tNotice Hours\tNotes\tPoints";
  const row = (a) => a.join("\t");
  const LOG = [
    "Attendance Log",                                  // the sheet's title row
    "",                                                // and its blank rows
    header,
    // exact name, new policy wording
    row([usDate(20), `Kate ${stamp} Brunner`, "3:00 PM", "Call-off with less than 4 hours notice (Emergency)", "N", "Y", "11:30 AM", "3.50", "knee injured, went to doctor", "1.0"]),
    // misspelt name -- the row the sheet silently scored as nobody's
    row([usDate(25), `Nicolas ${stamp} Lineras`, "8:30 AM", "Call-off with less than 4 hours notice - Non-Emergency/No Documentation", "", "", "5:30 AM", "3.00", "stomach hurts", "2.0"]),
    // old pre-6/1/2026 wording for the same occurrence type, with the >= sign
    row([usDate(30), `Nicolas ${stamp} Linares`, "9:00 AM", "Call-off  (≥4 hours notice)", "N", "N", "3:33 AM", "4.45", "sickness", "1.0"]),
    // earn-back, old wording, negative points, no Y/N columns at all
    row([usDate(35), `Kate ${stamp} Brunner`, "12:30 PM", "Picked Up Last Minute Shift", "", "", "10:00 AM", "2.50", "covered a session", "-1.0"]),
    // the occurrence type pasted into the Emergency?/Documentation? columns
    row([usDate(40), `Kate ${stamp} Brunner`, "8:30 AM", "Call-off (with more than 4 hours notice)", "Call-off  (≥4 hours notice)", "Call-off  (≥4 hours notice)", "7:00 AM", "1.50", "dr note provided", "1.0"]),
    // trailing space on the name
    row([usDate(45), `Nicolas ${stamp} Linares `, "12:30 PM", "Late (any amount of time)", "", "", "12:45 PM", "-0.25", "slept in", "0.5"]),
    // an occurrence type that is not in the matrix at all
    row([usDate(50), `Kate ${stamp} Brunner`, "9:00 AM", "Ate my homework", "", "", "", "", "", "3.0"]),
    // no name anybody recognises
    row([usDate(55), `Nobody ${stamp} Here`, "9:00 AM", "Late (any amount of time)", "", "", "9:30 AM", "-0.50", "", "0.5"]),
    "",
    "\t\t\t\t\t\t\t\t\t",                              // the sheet's trailing empties
  ].join("\n");

  r = await owner("/api/attendance/import/preview", { method: "POST", body: { text: LOG } });
  check("the owner can preview an import", r.status === 200, r.data);
  const items = r.data.items || [];
  const sum = r.data.summary || {};
  check("it skipped the title and blank rows and found only the occurrences", sum.total === 8, sum);
  check("nothing has been written yet -- this is a preview",
    (await owner(`/api/attendance/employee/${linaresId}`)).data.flags.length === 0);

  const byNote = (n) => items.find((i) => (i.notes || "").includes(n));

  // --------------------------------------------------------------------
  section("It reads what the sheet actually says");

  let it = byNote("knee injured");
  check("a date in M/D/YYYY becomes a real date", it && it.incident_date === daysAgo(20), it && it.incident_date);
  check("12-hour times become 24-hour", it && it.shift_start === "15:00" && it.time_notified === "11:30", it);
  check("Y/N columns become true/false", it && it.emergency === false && it.documentation === true, it);
  check("an exact name matches confidently", it && it.confidence === "confident" && it.match === kateId, it);

  it = byNote("sickness");
  check("the old pre-policy wording maps to the same matrix type",
    it && it.type_key === "calloff_gt4", it && it.type_key);
  check("even with the ≥ sign in it", it && it.importable === true, it);

  it = byNote("covered a session");
  check("an earn-back keeps its negative points", it && it.points === -1, it && it.points);
  check("and maps to the picked-up-shift type", it && it.type_key === "picked_up_shift", it && it.type_key);

  it = byNote("dr note provided");
  check("the occurrence type pasted into the Emergency column is not read as a Y",
    it && it.emergency === false, it);
  check("and it says so rather than importing it silently",
    it && it.warnings.some((w) => /Emergency column/i.test(w)), it && it.warnings);

  it = byNote("slept in");
  check("a trailing space on a name still matches", it && it.match === linaresId, it);

  // --------------------------------------------------------------------
  section("The names the sheet lost");

  it = byNote("stomach hurts");
  check("a misspelt name still finds the right person", it && it.match === linaresId, it);
  check("but is flagged for confirmation rather than assumed",
    it && it.confidence === "check", it && it.confidence);
  check("and says which spelling it saw and which record it means",
    it && it.warnings.some((w) => /Lineras/.test(w) && /Linares/.test(w)), it && it.warnings);

  it = items.find((i) => (i.source_name || "").includes("Nobody"));
  check("a name with no staff record at all is not guessed at", it && it.match === null, it && it.match);
  check("and asks for a person to be chosen", it && it.warnings.some((w) => /No staff record/i.test(w)), it && it.warnings);

  it = items.find((i) => (i.source_type || "").includes("homework"));
  check("an occurrence type that is not in the matrix cannot be imported", it && it.importable === false, it);
  check("and says why", it && it.warnings.some((w) => /not an occurrence in the matrix/i.test(w)), it && it.warnings);

  // --------------------------------------------------------------------
  section("Importing");

  const confirmable = items.filter((i) => i.importable && i.match).map((i) => ({ ...i, employee_id: i.match }));
  check("six rows are importable once the names are confirmed", confirmable.length === 6, confirmable.length);

  r = await owner("/api/attendance/import/commit", { method: "POST", body: { items: confirmable } });
  check("the import runs", r.status === 200, r.data);
  check("and wrote every confirmed row", r.data.created.length === 6, r.data);

  const lin = (await owner(`/api/attendance/employee/${linaresId}`)).data;
  check("the misspelt row landed on the right person's record", lin.flags.length === 3, lin.flags.length);
  check("with the points the log gave them, not a restatement",
    lin.flags.map((f) => Number(f.points)).sort().join(",") === "0.5,1,2",
    lin.flags.map((f) => f.points));
  check("their rolling 90-day total now reflects the history", lin.score.points_90 === 3.5, lin.score);
  check("which puts them at a real discipline step rather than good standing",
    lin.score.discipline_level === "Verbal reminder", lin.score.discipline_level);

  const kate = (await owner(`/api/attendance/employee/${kateId}`)).data;
  check("the earn-back came across as a credit", kate.score.points_90 === 1, kate.score);

  check("imported rows are marked as imported, not as somebody logging them today",
    lin.flags.every((f) => /imported/i.test(f.created_by || "")), lin.flags.map((f) => f.created_by));
  check("nobody was emailed about history that already happened",
    lin.flags.every((f) => !f.notified_at), lin.flags.map((f) => f.notified_at));

  // --------------------------------------------------------------------
  section("Importing the same log twice");

  r = await owner("/api/attendance/import/preview", { method: "POST", body: { text: LOG } });
  check("the second read sees them as already imported",
    (r.data.summary || {}).already_imported === 6, r.data.summary);

  r = await owner("/api/attendance/import/commit", { method: "POST", body: { items: confirmable } });
  check("and committing again writes nothing", r.data.created.length === 0, r.data);
  check("saying each row was already imported",
    r.data.skipped.length === 6 && r.data.skipped.every((s) => /already imported/i.test(s.reason)), r.data.skipped);

  const lin2 = (await owner(`/api/attendance/employee/${linaresId}`)).data;
  check("so nobody's points doubled", lin2.score.points_90 === 3.5, lin2.score);

  // --------------------------------------------------------------------
  section("Two staff records with the same name");

  // The sheet could not tell these apart at all -- it keyed on the typed name,
  // so both people's occurrences landed in the same bucket. Here it has to ask.
  const twinA = await mk(`Jordan ${stamp} Reyes`, 200);
  const twinB = await mk(`Jordan ${stamp} Reyes`, 150);
  check("created two staff members with the same name", !!twinA && !!twinB && twinA !== twinB, { twinA, twinB });

  const TWIN_LOG = [
    header,
    row([usDate(15), `Jordan ${stamp} Reyes`, "9:00 AM", "Late (any amount of time)", "", "", "9:30 AM", "-0.50", "twin row", "0.5"]),
  ].join("\n");
  r = await owner("/api/attendance/import/preview", { method: "POST", body: { text: TWIN_LOG } });
  const twin = (r.data.items || [])[0];
  check("an exact name that matches two people is not treated as confident",
    twin && twin.confidence === "check", twin && twin.confidence);
  check("it says so plainly",
    twin && twin.warnings.some((w) => /More than one staff record/i.test(w)), twin && twin.warnings);
  check("and offers both records to choose between",
    twin && twin.alternatives.filter((a) => a.id === twinA || a.id === twinB).length === 2, twin && twin.alternatives);

  // --------------------------------------------------------------------
  section("Who can import");

  r = await clinical("/api/attendance/import/preview", { method: "POST", body: { text: LOG } });
  check("a clinical user cannot preview an import", r.status === 403, r.status);
  r = await clinical("/api/attendance/import/commit", { method: "POST", body: { items: confirmable } });
  check("nor commit one", r.status === 403, r.status);

  r = await owner("/api/attendance/import/preview", { method: "POST", body: { text: "just some words\nand more words" } });
  check("a file that is not a log is refused with an explanation",
    r.status === 400 && /header row/i.test(r.data.error || ""), r.data);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
