// The one-time BCBA / Student Analyst assignment migration.
//
// Weighted heavily toward WHAT IT REFUSES TO DO, because that is where the harm
// is. A migration that writes the wrong BCBA onto a client is invisible: the
// dashboard looks right, the caseload looks right, and the person who should
// have chased an expiring authorization simply never sees it.
//
// Every fixture here is INVENTED. The real sheet is a list of children with
// their payers and authorization dates, and it does not belong in a repository.
// The shapes are copied from the real document -- merged section headings,
// blank spacer rows, a squad table underneath, first-name-only staff, and the
// column whose meaning changes part-way down -- and the content is not.
"use strict";
const { parseAssignmentSheet, parseDate } = require("./bcba-migration-parser");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "\n        " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : "")); }
};
const section = (s) => console.log("\n== " + s + " ==");

const HEADER = "| Client Name | BCBA | Insurance | Auth Start | Auth End | Treatment Plan Due | Tx Updates | Student Analyst | Schedule |";
const SEP = "| :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |";
const sheet = (...rows) => [HEADER, SEP, ...rows].join("\n");
const row = (c) => `| ${c.name} | ${c.bcba || ""} | ${c.ins || ""} | ${c.start || ""} | ${c.end || ""} | ${c.tp || ""} | ${c.tx || ""} | ${c.analyst || ""} | ${c.sched || ""} |`;
const merged = (label) => "| " + new Array(9).fill(`\\[merged\\] ${label}`).join(" | ") + " |";
const find = (r, name) => r.rows.find((x) => x.client_name === name);

// ============================================================ reading the sheet
section("Reading the sheet");
{
  const r = parseAssignmentSheet(sheet(
    row({ name: "Robin Aster", bcba: "Wren", ins: "NV Medicaid", start: "06/01/2026", end: "11/27/2026", tp: "10/27/2026", analyst: "Juniper", sched: "clinic, 9-3" }),
    row({ name: "Sage Bellamy", bcba: "Wren", ins: "Molina", start: "3/9/26", end: "9/4/2026", tp: "8/4/2026", analyst: "Rowan" })
  ));
  check("the sheet parses", r.ok, r.reason);
  check("both client rows are read", r.rows.length === 2, r.rows.length);
  const a = find(r, "Robin Aster");
  check("the BCBA is read", a.bcba === "Wren", a.bcba);
  check("the Student Analyst is read", a.student_analyst === "Juniper", a.student_analyst);
  check("dates become ISO", a.auth_start === "2026-06-01" && a.auth_end === "2026-11-27" && a.treatment_plan_due === "2026-10-27", a);
  check("a two-digit year is read as this century",
    find(r, "Sage Bellamy").auth_start === "2026-03-09", find(r, "Sage Bellamy").auth_start);
  check("the schedule note is carried but marked as a note",
    a.schedule_note === "clinic, 9-3", a.schedule_note);
}

// ---- columns are found by name, never by position -------------------------
{
  const shuffled = [
    "| Student Analyst | Client Name | Auth End | BCBA | Auth Start |",
    "| :-: | :-: | :-: | :-: | :-: |",
    "| Juniper | Robin Aster | 11/27/2026 | Wren | 06/01/2026 |",
  ].join("\n");
  const r = parseAssignmentSheet(shuffled);
  const a = r.ok && find(r, "Robin Aster");
  check("A REORDERED SHEET STILL LANDS IN THE RIGHT FIELDS",
    !!a && a.bcba === "Wren" && a.student_analyst === "Juniper" && a.auth_end === "2026-11-27", a);
}

// ---- a sheet it cannot identify is refused whole ---------------------------
{
  const r = parseAssignmentSheet("| Name | Person |\n| :-: | :-: |\n| Robin | Wren |");
  check("a sheet without the required columns is REFUSED rather than read positionally",
    r.ok === false, r);
  check("and says what it needed", /Client Name/.test(r.reason || ""), r.reason);
}
check("empty input is refused", parseAssignmentSheet("").ok === false);
check("so is text with no table", parseAssignmentSheet("just some words").ok === false);

// ============================================ the column that changes meaning
section("The Student Analyst column stops meaning Student Analyst");
{
  // Exactly the real document's shape: below a section heading, the analyst
  // column holds the BCBA doing the intake.
  const r = parseAssignmentSheet(sheet(
    row({ name: "Robin Aster", bcba: "Wren", analyst: "Juniper" }),
    row({ name: "Sage Bellamy", bcba: "Fable", analyst: "Rowan" }),
    merged("Needs assessment"),
    row({ name: "Marlow Quill", analyst: "Wren" }),
    row({ name: "Indigo Vale", analyst: "Fable" })
  ));
  const m = find(r, "Marlow Quill"), i = find(r, "Indigo Vale");
  check("A BCBA'S NAME IN THE ANALYST COLUMN IS NOT IMPORTED AS AN ANALYST",
    m.student_analyst === "" && i.student_analyst === "", { m: m.student_analyst, i: i.student_analyst });
  check("and the row says why, with the value it saw",
    m.sheet_issues.some((x) => /Wren/.test(x) && /BCBA/.test(x)), m.sheet_issues);
  check("the raw value is kept so a person can see what the sheet said",
    m.student_analyst_raw === "Wren", m.student_analyst_raw);
  check("a genuine analyst in the same sheet is still read",
    find(r, "Robin Aster").student_analyst === "Juniper");
  // The rule is evidence-based, not a hard-coded section name: renaming the
  // heading must not change the outcome.
  const renamed = parseAssignmentSheet(sheet(
    row({ name: "Robin Aster", bcba: "Wren", analyst: "Juniper" }),
    merged("Waiting on paperwork"),
    row({ name: "Marlow Quill", analyst: "Wren" })
  ));
  check("RENAMING THE SECTION HEADING DOES NOT DEFEAT THE CHECK",
    find(renamed, "Marlow Quill").student_analyst === "", find(renamed, "Marlow Quill"));
}
{
  // And the opposite: an analyst under a heading is still an analyst, because
  // the reason to refuse was the name, not the section.
  const r = parseAssignmentSheet(sheet(
    row({ name: "Robin Aster", bcba: "Wren", analyst: "Juniper" }),
    merged("Pending"),
    row({ name: "Marlow Quill", analyst: "Rowan" })
  ));
  check("an analyst who is not a BCBA is still read under a heading",
    find(r, "Marlow Quill").student_analyst === "Rowan", find(r, "Marlow Quill"));
  check("the section is recorded", find(r, "Marlow Quill").section === "Pending", find(r, "Marlow Quill").section);
}

// ==================================================== dates it will not accept
section("Dates");
check("a real date parses", parseDate("06/01/2026").value === "2026-06-01");
check("a single-digit month and day parse", parseDate("3/9/2026").value === "2026-03-09");
check("a two-digit year parses", parseDate("3/9/26").value === "2026-03-09");
check("an ISO date passes through", parseDate("2026-03-09").value === "2026-03-09");
check("30 February is refused", parseDate("02/30/2026").value === null && !!parseDate("02/30/2026").issue);
check("month 13 is refused", parseDate("13/01/2026").value === null);
check("free text is refused rather than guessed", parseDate("next month").value === null);
check("and says so", /not in a format/.test(parseDate("next month").issue || ""));
check("blank is simply empty, with no complaint", parseDate("").value === null && !parseDate("").issue);
check("n/a is treated as deliberately empty", parseDate("n/a").value === null && !parseDate("n/a").issue);

section("Dates that cannot both be true");
{
  const r = parseAssignmentSheet(sheet(
    // The real sheet has one of these: an auth ending before it starts, almost
    // certainly a year typo. Reported, NEVER corrected -- picking the year for
    // somebody is picking their renewal deadline.
    row({ name: "Robin Aster", bcba: "Wren", start: "7/8/2026", end: "01/01/2026", tp: "12/1/2026" }),
    row({ name: "Sage Bellamy", bcba: "Wren", start: "07/23/2026", end: "1/22/2027", tp: "12/21/2027" })
  ));
  const a = find(r, "Robin Aster"), b = find(r, "Sage Bellamy");
  check("AN AUTH ENDING BEFORE IT STARTS IS FLAGGED",
    a.sheet_issues.some((x) => /Auth End .* is not after Auth Start/.test(x)), a.sheet_issues);
  check("and the dates are still reported, not blanked",
    a.auth_start === "2026-07-08" && a.auth_end === "2026-01-01", a);
  check("nothing is corrected to a guessed year",
    a.auth_end === "2026-01-01", a.auth_end);
  check("A TREATMENT PLAN DUE AFTER THE AUTH ENDS IS FLAGGED",
    b.sheet_issues.some((x) => /Treatment Plan Due .* is after Auth End/.test(x)), b.sheet_issues);
  check("a consistent row carries no issues",
    parseAssignmentSheet(sheet(row({ name: "Robin Aster", bcba: "Wren", start: "1/1/2026", end: "7/1/2026", tp: "6/1/2026" })))
      .rows[0].sheet_issues.length === 0);
}

// ==================================================== the shape of the document
section("Spacer rows, headings and merged cells");
{
  const r = parseAssignmentSheet(sheet(
    row({ name: "Robin Aster", bcba: "Wren", analyst: "Juniper" }),
    "|  |  |  |  |  |  |  |  |  |",
    "|  |  |  |  |  |  |  |  |  |",
    merged("Auth in, no staff"),
    row({ name: "Sage Bellamy", bcba: "Fable", analyst: "Rowan" })
  ));
  check("blank spacer rows are skipped, not imported as clients", r.rows.length === 2, r.rows.map((x) => x.client_name));
  check("a merged heading is a section, not a client",
    !r.rows.some((x) => /merged|Auth in/.test(x.client_name)), r.rows.map((x) => x.client_name));
  check("THE MERGED MARKER IS STRIPPED FROM THE SECTION NAME",
    find(r, "Sage Bellamy").section === "Auth in, no staff", find(r, "Sage Bellamy").section);
}
{
  // A wholly blank row is formatting and says nothing. A row that CARRIES DATA
  // but has no client name is different -- something was written there and
  // cannot be filed -- so that one is reported rather than quietly dropped.
  const r = parseAssignmentSheet(sheet(
    row({ name: "Robin Aster", bcba: "Wren" }),
    "|  |  |  |  |  |  |  |  |  |",
    row({ name: "", bcba: "Fable", analyst: "Rowan", start: "1/1/2026" })
  ));
  check("a blank spacer row raises no warning, because nothing was lost",
    r.rows.length === 1, r.rows.map((x) => x.client_name));
  check("A ROW WITH DATA BUT NO CLIENT NAME IS REPORTED",
    r.warnings.some((w) => /1 row\(s\) had no client name/.test(w)), r.warnings);
}
{
  const r = parseAssignmentSheet(sheet(row({ name: "Imagine School at Elsewhere", bcba: "Wren", ins: "n/a", start: "n/a", end: "n/a", tp: "n/a" })));
  const s = r.rows[0];
  check("an n/a row keeps its name and carries no dates", s.auth_start === null && s.auth_end === null, s);
  check("and raises no date complaint, because n/a is deliberate", s.sheet_issues.length === 0, s.sheet_issues);
}

// ================================================================ squad table
section("The squad table underneath");
{
  const text = sheet(
    row({ name: "Robin Aster", bcba: "Wren", analyst: "Juniper" }),
    row({ name: "Sage Bellamy", bcba: "Fable", analyst: "Rowan" })
  ) + `

|  |  |  |  |
| :-: | :-: | :-: | :-: |
|  | Clinical Director  | \\[merged\\] Fable | \\[merged\\] Fable |
|  | Squad Leaders  | Alder | Brook |
|  | Staff  | Juniper | Rowan |
|  |  | Marlow | Indigo |
|  |  |  |  |
|  | Squad Leaders  | Alder | Brook |
|  | Clients | Robin Aster | Sage Bellamy |
|  |  | Marlow Quill |  |`;
  const r = parseAssignmentSheet(text);
  check("the squad table is read", r.squads.length === 2, r.squads);
  const alder = r.squads.find((s) => s.squad_leader === "Alder");
  const brook = r.squads.find((s) => s.squad_leader === "Brook");
  check("each leader gets their own clients",
    alder && alder.clients.join(",") === "Robin Aster,Marlow Quill", alder);
  check("and the second column is not mixed into the first",
    brook && brook.clients.join(",") === "Sage Bellamy", brook);
  // The document has TWO "Squad Leaders" rows: one over a staff list and one
  // over a client list. Reading the first would file employees as children.
  check("THE STAFF BLOCK IS NOT READ AS CLIENTS",
    !r.squads.some((s) => s.clients.some((c) => c === "Juniper" || c === "Rowan" || c === "Indigo")),
    r.squads);
  check("a squad grouping is separate from the BCBA grouping",
    alder.clients.includes("Robin Aster") && find(r, "Robin Aster").bcba === "Wren");
}
{
  const r = parseAssignmentSheet(sheet(row({ name: "Robin Aster", bcba: "Wren" })));
  check("a sheet with no squad table simply has none", r.ok && r.squads.length === 0, r.squads);
}

// ======================================================== nothing is invented
section("Nothing is invented");
{
  const r = parseAssignmentSheet(sheet(
    row({ name: "Robin Aster", bcba: "", analyst: "" }),
    row({ name: "Sage Bellamy", bcba: "Wren" })
  ));
  const a = find(r, "Robin Aster");
  check("a row with no BCBA gets no BCBA", a.bcba === "", a.bcba);
  check("a row with no analyst gets no analyst", a.student_analyst === "", a.student_analyst);
  check("an empty row is still reported so it can be reviewed", !!a);
  check("a blank analyst raises no ambiguity complaint", a.sheet_issues.length === 0, a.sheet_issues);
  check("the sheet's BCBA names are reported, for the reader",
    r.bcba_names.includes("wren"), r.bcba_names);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
