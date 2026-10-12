// Downloading a signed timecard gives you THAT timecard.
//
// The bug this file exists for: hr_documents never recorded which timecard a
// signed PDF was of, so every query asking for "the signed PDF for this
// timecard" fell back to "the newest timecard PDF for this employee". Open
// September's signed card and you were handed the most recent one -- for
// every pay period except the latest.
//
// A signed timecard is a payroll record with somebody's name on it, so the
// claims here are about identity, not availability:
//
//   * each period's detail returns ITS OWN pdf, by id and by filename
//   * the list gives every row a different pdf, not one repeated
//   * a timecard nobody signed offers NOTHING, rather than another period's
//     signature -- absent beats wrong
//   * the PDFs already on file are relinked on boot, where the filename says
//     unambiguously which period they belong to
//
//   DATABASE_URL=... BASE=http://127.0.0.1:3014 node test-timecard-pdf-match.js
"use strict";
const { Pool } = require("pg");
const { spawn } = require("child_process");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const BASE = process.env.BASE || "http://localhost:3014";
const stamp = Date.now().toString(36);

let cookie = "", pass = 0, fail = 0;
async function req(p, { method = "GET", body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const ct = r.headers.get("content-type") || "";
  let d = null;
  if (ct.includes("json")) { try { d = await r.json(); } catch (e) {} }
  return { status: r.status, data: d, headers: r.headers };
}
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 320) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");
const tokenOf = (url) => {
  const s = String(url || "");
  const q = s.match(/[?&]token=([^&]+)/i);
  if (q) return q[1];
  return s.split("?")[0].split("/").filter(Boolean).pop() || "";
};

(async () => {
  try {
    const login = await req("/api/auth/login", { method: "POST", body: {
      email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
    check("owner signs in", login.status === 200, login.data);

    const emp = (await pool.query(
      `INSERT INTO hr_employees (name, email, role_title, status, created_at)
       VALUES ($1,$2,'RBT','active',now()) RETURNING id`,
      [`TcPdf Hazel ${stamp}`, `tcpdf.hazel.${stamp}@example.test`])).rows[0];

    const entries = (d1, d2) => JSON.stringify([
      { date: d1, clock_in: "09:00", clock_out: "17:00", hours: 8 },
      { date: d2, clock_in: "09:00", clock_out: "15:00", hours: 6 },
    ]);
    const mkTc = async (start, end, e) => (await pool.query(
      `INSERT INTO hr_timecards (employee_id, source, pay_period_start, pay_period_end, entries, status, created_at)
       VALUES ($1,'import',$2,$3,$4,'imported',now()) RETURNING id`,
      [emp.id, start, end, e])).rows[0].id;

    // The reported case: an earlier fortnight she signed, and a later one.
    const sept = await mkTc("2026-09-07", "2026-09-20", entries("2026-09-07", "2026-09-08"));
    const oct = await mkTc("2026-10-05", "2026-10-18", entries("2026-10-05", "2026-10-06"));
    const unsigned = await mkTc("2026-11-02", "2026-11-15", entries("2026-11-02", "2026-11-03"));

    const sign = async (id, name) => {
      const v = await req(`/api/hr/timecards/${id}/request-verification`, { method: "POST" });
      check(`a verification link is created for ${id}`, v.status === 200 && !!tokenOf(v.data.url), v.data);
      const a = await req("/api/hr/public/timecard/accept", { method: "POST", body: {
        token: tokenOf(v.data.url), signed_name: name } });
      check(`it is signed for ${id}`, a.status === 200 && a.data.ok, a.data);
    };

    section("SHE SIGNS BOTH FORTNIGHTS");
    await sign(sept, "Hazel Holbert");
    await sign(oct, "Hazel Holbert");

    const septPdf = (await req(`/api/hr/timecards/${sept}`)).data.pdf_doc_id;
    const octPdf = (await req(`/api/hr/timecards/${oct}`)).data.pdf_doc_id;
    check("the September card has a signed PDF", septPdf != null, septPdf);
    check("the October card has one too", octPdf != null, octPdf);
    check("AND THEY ARE DIFFERENT DOCUMENTS — the whole bug was one id served"
      + " for every period", septPdf !== octPdf, { septPdf, octPdf });

    section("OPENING SEPTEMBER GIVES YOU SEPTEMBER");
    // Checked by FILENAME, not just by a differing id: the filename carries
    // the pay period end, so this is the assertion that would have caught
    // the original bug rather than merely noticing two rows existed.
    const dl = await req(`/api/hr/employee-documents/${septPdf}`);
    check("the document downloads", dl.status === 200, dl.status);
    const cd = dl.headers.get("content-disposition") || "";
    check("ITS FILENAME IS THE SEPTEMBER PERIOD", /2026-09-20/.test(cd), cd);
    check("and not the October one", !/2026-10-18/.test(cd), cd);
    const dlOct = await req(`/api/hr/employee-documents/${octPdf}`);
    check("October's downloads as October",
      /2026-10-18/.test(dlOct.headers.get("content-disposition") || ""),
      dlOct.headers.get("content-disposition"));

    section("THE LIST DOES NOT REPEAT ONE PDF DOWN THE COLUMN");
    const list = (await req("/api/hr/timecards")).data || [];
    const mine = list.filter((r) => Number(r.employee_id) === Number(emp.id));
    check("all three of her cards are listed", mine.length === 3, mine.length);
    const septRow = mine.find((r) => Number(r.id) === Number(sept));
    const octRow = mine.find((r) => Number(r.id) === Number(oct));
    check("the September row carries September's pdf",
      Number(septRow.pdf_doc_id) === Number(septPdf), { row: septRow.pdf_doc_id, expected: septPdf });
    check("the October row carries October's",
      Number(octRow.pdf_doc_id) === Number(octPdf), { row: octRow.pdf_doc_id, expected: octPdf });

    section("A TIMECARD NOBODY SIGNED OFFERS NOTHING");
    // Absent beats wrong. Before the fix this returned the most recently
    // signed PDF belonging to somebody's other fortnight.
    const un = (await req(`/api/hr/timecards/${unsigned}`)).data;
    check("the unsigned card has no PDF at all", un.pdf_doc_id == null, un.pdf_doc_id);
    const unRow = mine.find((r) => Number(r.id) === Number(unsigned));
    check("and the list agrees", unRow && unRow.pdf_doc_id == null, unRow && unRow.pdf_doc_id);

    section("THE PDFS ALREADY ON FILE ARE RELINKED ON BOOT");
    // A document stored before this column existed: right employee, filename
    // carrying the period, no timecard_id. The migration runs in initTables,
    // so this boots a second server against the same database to exercise
    // the real path rather than re-running the SQL from the test.
    const legacyTc = await mkTc("2026-07-06", "2026-07-19", entries("2026-07-06", "2026-07-07"));
    const legacyDoc = (await pool.query(
      `INSERT INTO hr_documents (employee_id, kind, filename, stored_name, mime_type, created_at)
       VALUES ($1,'timecard',$2,'legacy.pdf','application/pdf', now()::text) RETURNING id`,
      [emp.id, `Timecard_TcPdf_Hazel_2026-07-19.pdf`])).rows[0].id;
    // And an ambiguous one: two cards ending the same day, so the filename
    // cannot say which. It must be left alone.
    const ambA = await mkTc("2026-06-01", "2026-06-14", entries("2026-06-01", "2026-06-02"));
    const ambB = await mkTc("2026-06-01", "2026-06-14", entries("2026-06-03", "2026-06-04"));
    const ambDoc = (await pool.query(
      `INSERT INTO hr_documents (employee_id, kind, filename, stored_name, mime_type, created_at)
       VALUES ($1,'timecard',$2,'ambiguous.pdf','application/pdf', now()::text) RETURNING id`,
      [emp.id, `Timecard_TcPdf_Hazel_2026-06-14.pdf`])).rows[0].id;

    const port = 3900 + (process.pid % 90);
    const child = spawn(process.execPath, ["server.js"], {
      env: { ...process.env, PORT: String(port), DATABASE_URL: process.env.DATABASE_URL },
      stdio: "ignore",
    });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
        if (r.status) up = true;
      } catch (e) { /* not listening yet */ }
    }
    check("a second server booted against the same database", up === true, up);
    await new Promise((r) => setTimeout(r, 1500));
    child.kill("SIGTERM");

    const after = (await pool.query(
      "SELECT id, timecard_id FROM hr_documents WHERE id = ANY($1::int[])", [[legacyDoc, ambDoc]])).rows;
    const legacyAfter = after.find((r) => Number(r.id) === Number(legacyDoc));
    const ambAfter = after.find((r) => Number(r.id) === Number(ambDoc));
    check("THE LEGACY PDF IS NOW LINKED TO ITS OWN FORTNIGHT",
      legacyAfter && Number(legacyAfter.timecard_id) === Number(legacyTc),
      { got: legacyAfter && legacyAfter.timecard_id, expected: legacyTc });
    check("AND THE AMBIGUOUS ONE IS LEFT UNLINKED — attaching a signature to"
      + " the wrong fortnight is worse than offering no download",
      ambAfter && ambAfter.timecard_id == null, ambAfter && ambAfter.timecard_id);
    const ambDetail = (await req(`/api/hr/timecards/${ambA}`)).data;
    check("so the ambiguous period shows no PDF", ambDetail.pdf_doc_id == null, ambDetail.pdf_doc_id);
    void ambB;

    // cleanup
    await pool.query("DELETE FROM hr_documents WHERE employee_id = $1", [emp.id]).catch(() => {});
    await pool.query("DELETE FROM hr_timecard_links WHERE timecard_id IN (SELECT id FROM hr_timecards WHERE employee_id = $1)", [emp.id]).catch(() => {});
    await pool.query("DELETE FROM hr_timecard_flags WHERE timecard_id IN (SELECT id FROM hr_timecards WHERE employee_id = $1)", [emp.id]).catch(() => {});
    await pool.query("DELETE FROM hr_timecards WHERE employee_id = $1", [emp.id]).catch(() => {});
    await pool.query("DELETE FROM hr_employees WHERE id = $1", [emp.id]).catch(() => {});
  } catch (e) {
    fail++;
    console.log("  FAIL  the suite threw  -> " + e.message + "\n" + (e.stack || "").split("\n").slice(1, 4).join("\n"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
