// The QR code's landing page.
//
// One code is printed and stuck on a wall, so the thing that breaks here is
// not the page -- it is a TILE THAT GOES NOWHERE. Nobody notices, because
// nobody on the inside scans the poster; the person who finds out is a
// clinician standing in front of a broken door, getting a sign-in prompt.
//
// That is not hypothetical. /maintenance-request was served from inside the
// /supply-request guard, where its own path can never arrive, so the public
// maintenance form was unreachable and every link to it returned the CRM
// shell. It looked fine in the source and failed in the browser.
//
// So this suite does not read the HTML and call it done. It follows every
// link on the page to the live server and asserts the page that comes back is
// the RIGHT page, by its title. A 200 is not the bar: the SPA fallback
// returns 200 for anything.
//
//   BASE=http://127.0.0.1:3011 node test-staff-hub.js
"use strict";
const BASE = process.env.BASE || "http://localhost:3011";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

const titleOf = (html) => {
  const m = String(html).match(/<title>([^<]*)<\/title>/i);
  return m ? m[1].trim() : "";
};

(async () => {
  section("The page itself");
  const r = await fetch(BASE + "/staff");
  const html = await r.text();
  check("the landing page is served to anybody, with no sign-in", r.status === 200, r.status);
  check("and it is the hub, not the CRM shell", /Spectrum Squad .*Staff/.test(titleOf(html)), titleOf(html));
  check("it is not indexed — this is an internal front door",
    /noindex/i.test(r.headers.get("x-robots-tag") || ""), r.headers.get("x-robots-tag"));

  section("Every tile goes where it says");
  // The destination is identified by the TITLE of the page that answers.
  // Checking the status code alone would pass against the SPA fallback, which
  // is exactly the failure this file exists to catch.
  const EXPECTED = [
    ["/policies", /Policies/i, "Access Policies & Standard Operating Procedures"],
    ["/supply-request", /Supply/i, "Supply Request"],
    ["/maintenance-request", /broken|Maintenance/i, "Maintenance Request"],
    ["/squad-report", /Attendance/i, "Attendance Infractions"],
    ["/report-concern", /Concern/i, "Report A Concern"],
  ];

  const hrefs = [...html.matchAll(/<a class="tile" href="([^"]+)"/g)].map((m) => m[1]);
  check("the page offers exactly the five options", hrefs.length === EXPECTED.length, hrefs);
  for (const [path] of EXPECTED) {
    check(`the ${path} tile is on the page`, hrefs.includes(path), hrefs);
  }

  for (const [path, titleRe, label] of EXPECTED) {
    const res = await fetch(BASE + path);
    const t = titleOf(await res.text());
    check(`${label} — ${path} answers`, res.status === 200, res.status);
    check(`${label} — and it is ITS page, not the CRM shell`, titleRe.test(t), t || "(no title)");
  }

  section("What the page promises");
  check("the concern tile says where a report goes", /only to Quiana/i.test(html),
    "the confidentiality note is missing");
  check("and it does not promise anonymity it cannot keep — it says 'without giving your name'",
    !/anonymous/i.test(html), "the page uses the word anonymous");

  section("What is NOT on it");
  // PTO moved back to Rethink. A tile for a page that no longer exists is a
  // dead end on a printed poster.
  check("no PTO tile", !/my-pto|My PTO/i.test(html), "a PTO link survives on the hub");
  const pto = await fetch(BASE + "/my-pto");
  const ptoTitle = titleOf(await pto.text());
  check("and /my-pto no longer serves a PTO page",
    !/PTO/i.test(ptoTitle), ptoTitle || "(no title)");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
