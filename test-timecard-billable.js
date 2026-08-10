// Unit tests for the billable / non-billable timecard split and the bulk
// review payload. Pure functions only -- no server, no database, no network.
// Run with: node test-timecard-billable.js
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 400) : "")); }
}

// Minimal ctx: initHr only destructures these at construction time, and the
// functions under test never touch the database or the network.
const noop = async () => {};
const hr = require(path.join(__dirname, "hr.js"))({
  dbGet: async () => null,
  dbAll: async () => [],
  dbRun: async () => ({ rows: [{ id: 1 }] }),
  sendEmail: noop,
  notify: noop,
  audit: noop,
  json: () => {},
  sendFile: () => {},
  readBody: async () => ({}),
  escapeHtml: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  parseJson: (s, d) => { try { return typeof s === "string" ? JSON.parse(s) : (s || d); } catch (e) { return d; } },
  nowISO: () => "2026-08-10T00:00:00.000Z",
  newToken: () => "tok",
  firstNameOf: (n) => String(n || "there").split(" ")[0],
  APP_BASE_URL: "https://example.test",
  RESUME_DIR: "/tmp",
  crypto: require("crypto"),
});
const I = hr._internal;

console.log("\n== classifyBillable ==");
check("'Billable' -> true", I.classifyBillable("Billable") === true);
check("'Non-Billable' -> false", I.classifyBillable("Non-Billable") === false);
check("'non billable' (space, lowercase) -> false", I.classifyBillable("non billable") === false);
check("'Non_Billable' -> false", I.classifyBillable("Non_Billable") === false);
check("'NON-BILLABLE' -> false", I.classifyBillable("NON-BILLABLE") === false);
check("'  Billable  ' trims -> true", I.classifyBillable("  Billable  ") === true);
check("'Billable - Direct' still counts as billable", I.classifyBillable("Billable - Direct") === true);
check("empty -> null (unknown, never assumed billable)", I.classifyBillable("") === null);
check("null -> null", I.classifyBillable(null) === null);
check("'Cancellation' -> null, not billable", I.classifyBillable("Cancellation") === null);
check("number 0 does not crash", I.classifyBillable(0) === null);

console.log("\n== timecardTotals ==");
const entries = [
  { date: "Mon, Aug 3", hours: 4, appt_type: "Billable" },
  { date: "Tue, Aug 4", hours: 2.5, appt_type: "Non-Billable" },
  { date: "Wed, Aug 5", hours: 1.25, appt_type: "Billable" },
  { date: "Thu, Aug 6", hours: 3, appt_type: "" },
];
const t = I.timecardTotals(entries);
check("billable hours sum", t.billable_hours === 5.25, t.billable_hours);
check("non-billable hours sum", t.non_billable_hours === 2.5, t.non_billable_hours);
check("unclassified hours sum", t.unclassified_hours === 3, t.unclassified_hours);
check("total = billable + non-billable + unclassified", t.total_hours === 10.75, t);
check("no hour is lost or double counted",
  Math.round((t.billable_hours + t.non_billable_hours + t.unclassified_hours) * 100) / 100 === t.total_hours, t);
check("has_split true when the export labeled anything", t.has_split === true);
check("entries keep their original index for editing",
  t.billable[0]._i === 0 && t.billable[1]._i === 2 && t.non_billable[0]._i === 1, t.billable.map((e) => e._i));

const legacy = I.timecardTotals([{ date: "x", hours: 6 }, { date: "y", hours: 2 }]);
check("timecards imported before Appt Type existed: has_split false", legacy.has_split === false);
check("legacy total still correct", legacy.total_hours === 8, legacy.total_hours);
check("legacy shows 0 billable rather than guessing", legacy.billable_hours === 0 && legacy.unclassified_hours === 8, legacy);

const empty = I.timecardTotals([]);
check("empty entries -> all zeroes, no crash", empty.total_hours === 0 && empty.has_split === false, empty);
check("null entries -> no crash", I.timecardTotals(null).total_hours === 0);

const explicit = I.timecardTotals([{ hours: 5, billable: true, appt_type: "" }, { hours: 5, billable: false }]);
check("an explicit billable flag wins over a blank appt_type",
  explicit.billable_hours === 5 && explicit.non_billable_hours === 5, explicit);

const floaty = I.timecardTotals([
  { hours: 0.1, appt_type: "Billable" }, { hours: 0.2, appt_type: "Billable" },
]);
check("float noise is rounded to 2dp (0.1 + 0.2 = 0.3)", floaty.billable_hours === 0.3, floaty.billable_hours);

console.log("\n== buildPayrollTimecards: Appt Type column ==");
function sheetsWith(headerName) {
  return {
    Summary: [
      ["Start Date:", "08/01/2026", "", "End Date:", "08/14/2026"],
      ["Id", "FirstName", "LastName", "RegHours", "OT1Hours", "OT2Hours", "TotalPay"],
      ["77", "Quiana", "Blake", 8, 0, 0, 0],
    ],
    "Time Sheet Entries": [
      ["", "", ""],
      ["", "Id", "Alerts", "StartTime", "EndTime", "DateOfService", "ActualStartTime", "ActualEndTime", "Duration", "StaffVerified", "ApptStatus", headerName],
      ["", "77", "", "9:00 AM", "1:00 PM", "2026-08-03", "", "", 4, "Yes", "Completed", "Billable"],
      ["", "77", "", "2:00 PM", "4:00 PM", "2026-08-04", "", "", 2, "Yes", "Completed", "Non-Billable"],
      ["", "77", "", "9:00 AM", "11:00 AM", "2026-08-05", "", "", 2, "Yes", "Completed", "Billable"],
    ],
  };
}
for (const header of ["Appt Type", "ApptType", "AppointmentType"]) {
  const built = I.buildPayrollTimecards(sheetsWith(header));
  const emp = built.employees[0];
  check(`"${header}" header is recognised`, built.has_appt_type === true, built.has_appt_type);
  check(`"${header}": billable hours split out`, emp.billable_hours === 6, emp.billable_hours);
  check(`"${header}": non-billable hours split out`, emp.non_billable_hours === 2, emp.non_billable_hours);
  check(`"${header}": every entry carries its own label`,
    emp.entries.every((e) => e.appt_type) && emp.entries[1].billable === false, emp.entries);
}
const noCol = I.buildPayrollTimecards(sheetsWith("SomethingElse"));
check("missing Appt Type column is reported, not faked", noCol.has_appt_type === false);
check("missing column: hours still parse, nothing is labeled billable",
  noCol.employees[0].billable_hours === 0 && noCol.employees[0].unclassified_hours === 8, noCol.employees[0]);
check("missing column: period start/end still read", noCol.period_start === "08/01/2026" && noCol.period_end === "08/14/2026", noCol);
check("missing column: pay columns are still ignored", noCol.employees[0].entries[0].pay === undefined);

console.log("\n== shapeTimecardPreview ==");
const shaped = I.shapeTimecardPreview(
  { id: 9, status: "imported", employee_id: 3, entries: JSON.stringify(entries), pay_period_start: "08/01/2026", pay_period_end: "08/14/2026", verification_requested_at: null },
  { name: "Quiana Blake", email: "q@example.test", role_title: "BCBA" },
  [{ id: 1, status: "open" }, { id: 2, status: "approved" }]
);
check("preview carries the recipient", shaped.employee_email === "q@example.test" && shaped.has_email === true, shaped.employee_email);
check("preview splits the hours", shaped.billable_hours === 5.25 && shaped.non_billable_hours === 2.5, shaped);
check("preview counts only unresolved flags", shaped.open_flags === 1, shaped.open_flags);
check("preview counts shifts", shaped.shifts === 4, shaped.shifts);
check("preview exposes the grouped rows for the review screen",
  shaped.billable.length === 2 && shaped.non_billable.length === 1 && shaped.unclassified.length === 1, {
    b: shaped.billable.length, n: shaped.non_billable.length, u: shaped.unclassified.length });
const noEmail = I.shapeTimecardPreview({ id: 10, status: "imported", entries: "[]" }, { name: "No Email", email: "" }, []);
check("staff with no email are flagged, not silently dropped", noEmail.has_email === false, noEmail);
check("unparseable entries JSON degrades to empty, no crash", I.shapeTimecardPreview({ id: 11, entries: "{oops" }, null, []).total_hours === 0);

console.log("\n== email + employee page rendering ==");
const html = I.timecardEmailHtml("Quiana", "08/01 – 08/14", "https://x.test/t", t);
check("email shows the billable subtotal", html.includes(">5.25<"), null);
check("email shows the non-billable subtotal", html.includes(">2.5<"), null);
check("email shows the grand total", html.includes(">10.75<"), null);
check("email labels both buckets", /Billable/.test(html) && /Non-billable/.test(html));
const legacyHtml = I.timecardEmailHtml("Quiana", "p", "u", legacy);
check("legacy timecard email shows no misleading 0-billable strip", !legacyHtml.includes("Non-billable"));
check("email still renders with no totals at all", I.timecardEmailHtml("Q", "p", "u").includes("Review my timecard"));

// The employee-facing page ships its logic as an inline script inside a
// template literal; make sure that script is still valid JS after editing.
const page = I.timecardVerifyHtml();
const scripts = page.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
check("verify page has an inline script", scripts.length === 1, scripts.length);
let scriptOk = true, scriptErr = "";
try { new Function(scripts[0].replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "")); }
catch (e) { scriptOk = false; scriptErr = e.message; }
check("employee timecard page script parses", scriptOk, scriptErr);
// A backslash escape eaten by the template literal would silently break the
// regex and dump every non-billable shift into the billable pile.
check("client-side classifier regex survived the template literal",
  /non\[-_ \]\*billable/.test(page), page.slice(page.indexOf("function clsOf"), page.indexOf("function clsOf") + 200));
check("page renders a billable section", page.includes("Billable shifts"));
check("page renders a non-billable section", page.includes("Non-billable shifts"));
check("page keeps per-section subtotals", page.includes("sub-") && page.includes("Billable subtotal"));

// ---- The signed PDF, rendered for real and read back ----------------------
// Needs pdftotext (poppler-utils) to read the result; skipped when it's absent
// so this file still runs anywhere.
(async () => {
  console.log("\n== signed PDF ==");
  const cp = require("child_process");
  const fs = require("fs");
  const has = (fn) => { try { fn(); return true; } catch (e) { return false; } };
  const hasPdftotext = has(() => cp.execSync("command -v pdftotext", { stdio: "ignore" }));
  const hasPdfkit = has(() => require.resolve("pdfkit"));
  if (!hasPdftotext || !hasPdfkit) {
    console.log(`  SKIP  PDF checks (${!hasPdfkit ? "run npm install" : "install poppler-utils for pdftotext"})`);
  } else {
    const written = [];
    const pdfHr = require(path.join(__dirname, "hr.js"))({
      dbGet: async (sql) => (/hr_employees/.test(sql) ? { name: "Quiana Blake", role_title: "BCBA" } : null),
      dbAll: async () => [],
      dbRun: async (sql, p) => { if (/hr_documents/.test(sql)) written.push(p); return { rows: [{ id: 1 }] }; },
      sendEmail: noop, notify: noop, audit: noop, json: () => {}, sendFile: () => {}, readBody: async () => ({}),
      escapeHtml: (s) => String(s == null ? "" : s),
      parseJson: (s, d) => { try { return typeof s === "string" ? JSON.parse(s) : (s || d); } catch (e) { return d; } },
      nowISO: () => "2026-08-10T00:00:00.000Z", newToken: () => "tok",
      firstNameOf: (n) => String(n || "").split(" ")[0],
      APP_BASE_URL: "", crypto: require("crypto"),
    });
    const dir = path.join(__dirname, "data", "hr-resumes");
    const readPdf = (stored) => cp.execSync(`pdftotext -layout ${JSON.stringify(path.join(dir, stored))} -`).toString();
    const cleanup = [];

    await pdfHr._internal.saveTimecardPdf({
      id: 1, employee_id: 3, entries: JSON.stringify(entries),
      pay_period_start: "08/01/2026", pay_period_end: "08/14/2026",
    }, "Quiana Blake");
    cleanup.push(written[written.length - 1][2]);
    const txt = readPdf(written[written.length - 1][2]);
    check("PDF has a Billable section", /Billable hours/.test(txt));
    check("PDF has a Non-billable section", /Non-billable hours/.test(txt));
    check("PDF has an Unclassified section for unlabeled shifts", /Unclassified hours/.test(txt));
    check("PDF billable subtotal is 5.25", /Billable subtotal: 5\.25/.test(txt), txt);
    check("PDF non-billable subtotal is 2.5", /Non-billable subtotal: 2\.5/.test(txt));
    check("PDF unclassified subtotal is 3", /Unclassified subtotal: 3/.test(txt));
    check("PDF grand total is 10.75", /Total hours: 10\.75/.test(txt));
    check("PDF keeps the signature block", /electronically signed by: Quiana Blake/.test(txt));
    check("a shift appears in exactly one section",
      (txt.match(/Mon, Aug 3/g) || []).length === 1 && (txt.match(/Tue, Aug 4/g) || []).length === 1, txt);
    check("PDF filename names the employee and period",
      /Timecard_Quiana_Blake_08\/14\/2026\.pdf/.test(written[written.length - 1][1]), written[written.length - 1][1]);

    await pdfHr._internal.saveTimecardPdf({
      id: 2, employee_id: 3, entries: JSON.stringify([{ date: "Mon", scheduled: "9-5", hours: 6 }, { date: "Tue", scheduled: "9-11", hours: 2 }]),
      pay_period_start: "a", pay_period_end: "b",
    }, "Quiana Blake");
    cleanup.push(written[written.length - 1][2]);
    const legacyTxt = readPdf(written[written.length - 1][2]);
    check("legacy PDF shows no empty Billable/Non-billable headings",
      !/Billable hours/.test(legacyTxt) && !/Non-billable hours/.test(legacyTxt), legacyTxt);
    check("legacy PDF still totals correctly", /Total hours: 8/.test(legacyTxt));

    const many = [];
    for (let i = 0; i < 90; i++) many.push({ date: "Day " + i, scheduled: "9-5", hours: 1, appt_type: i % 2 ? "Billable" : "Non-Billable" });
    await pdfHr._internal.saveTimecardPdf({ id: 3, employee_id: 3, entries: JSON.stringify(many), pay_period_start: "a", pay_period_end: "b" }, "Q B");
    cleanup.push(written[written.length - 1][2]);
    const bigTxt = readPdf(written[written.length - 1][2]);
    check("90 shifts: subtotals survive the page break",
      /Billable subtotal: 45/.test(bigTxt) && /Non-billable subtotal: 45/.test(bigTxt), bigTxt.slice(-500));
    check("90 shifts: grand total survives the page break", /Total hours: 90/.test(bigTxt));
    check("90 shifts: the last shift is not pushed off the page", /Day 89/.test(bigTxt));
    check("90 shifts: the signature block is not pushed off the page", /electronically signed by/.test(bigTxt));

    cleanup.forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} });
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
