// role-matrix-lib.js -- the machinery behind the role matrix suites.
//
// SPLIT IN TWO ONLY FOR TIME. Rendering the shell after a reload costs about
// thirteen seconds in the test environment, and twelve roles at that rate runs
// past the runner's 180-second cap. So the catalogue is halved and each half
// is a suite; both write their own roles into the same role-matrix.json, and
// each asserts that the two halves together still cover every role the server
// offers -- a role added to ROLE_CATALOG and to neither half fails both.
//
// See test-role-matrix-core.js for what this is for and how to update it.
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { Pool } = require("pg");

const SNAPSHOT = path.join(__dirname, "role-matrix.json");
const UPDATE = process.env.UPDATE_MATRIX === "1";

// Halved so each suite fits the cap. Order is the catalogue's own.
const PART = {
  core: ["owner", "super_admin", "admin", "intake", "clinical", "billing"],
  support: ["scheduling", "hr_admin", "hiring_manager", "interviewer", "ot_admin", "ot_staff"],
};

// Every role the CRM offers. Read from the server so a role added to
// ROLE_CATALOG cannot quietly escape the matrix.
function rolesFromSource() {
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const block = src.slice(src.indexOf("const ROLE_CATALOG = ["));
  return (block.slice(0, block.indexOf("];")).match(/key:\s*"([a-z_]+)"/g) || [])
    .map((s) => s.replace(/key:\s*"|"/g, ""));
}

// The endpoints whose answer defines what a role can do. Chosen because each
// one gates a screen or a control that has been got wrong at least once.
const PROBES = [
  "/api/nav-order",
  "/api/staff",
  "/api/staff-tasks",
  "/api/clients",
  "/api/admin/users",
  "/api/hr/employees",
  "/api/billable/summary",
  "/api/bcba/forms",
  "/api/bcba/cheatsheet",
  "/api/caseload/dashboard",
  "/api/caseload/bcbas",
  "/api/auth/view-as/log",
];


async function runMatrix(part, check) {
  const BASE = process.env.BASE || "http://localhost:3009";
  const roles = PART[part];
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

  const catalogue = rolesFromSource();
  const covered = new Set([...PART.core, ...PART.support]);
  const missed = catalogue.filter((r) => !covered.has(r));
  check("EVERY ROLE IN ROLE_CATALOG IS IN ONE HALF OR THE OTHER", missed.length === 0,
    missed.length ? `Not covered by either matrix suite: ${missed.join(", ")}. Add them to PART in role-matrix-lib.js.` : undefined);

  const EMAIL = `zz.matrix.${part}@spectrumsquadlv.com`;
  const PW = "MatrixProbe123!";
  await pool.query("DELETE FROM users WHERE lower(email) = lower($1)", [EMAIL]);

  // ONE PAGE LOAD PER ROLE. The obvious way to do this -- log out, load the
  // login page, type, submit, load again -- is three loads of a 360KB shell
  // plus thirty bundles, and at twelve roles that ran the suite past the
  // runner's 180-second cap before it reached half of them. The session is
  // swapped through the API from the page that is already open, and a single
  // reload draws the sidebar for the new role.
  const login = async (email, password) => {
    if (!page.url().startsWith(BASE)) {
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(700);
    }
    const _t1 = Date.now();
    const ok = await page.evaluate(async ([e, p]) => {
      try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (err) {}
      try { localStorage.clear(); } catch (err) {}
      const r = await fetch("/api/auth/login", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: e, password: p }),
      });
      return r.status;
    }, [email, password]);
    // "commit" rather than "domcontentloaded": waiting for thirty bundles to
    // finish parsing costs seconds per role and the sidebar does not need
    // them. Wait for the thing actually being measured instead.
    const _t2 = Date.now();
    await page.reload({ waitUntil: "commit" });
    const _t3 = Date.now();
    await page.waitForSelector("#nav-list, #login-form", { timeout: 15000 }).catch(() => {});
    const _t4 = Date.now();
    await page.waitForTimeout(500);
    if (process.env.MATRIX_TIMING) console.log(`      [auth ${_t2 - _t1}ms | reload ${_t3 - _t2}ms | selector ${_t4 - _t3}ms]`);
    return ok;
  };

  // Create the probe account as the owner, then move it from role to role by
  // writing the column directly -- the API refuses some transitions, and the
  // subject here is what a role SEES, not how it is granted.
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const made = await page.evaluate(async ([email, pw]) => {
    const r = await fetch("/api/admin/users", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Zz Matrix Probe", email, password: pw, role: "intake" }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [EMAIL, PW]);
  check("a probe account exists to walk the roles with", made.status === 201, made.body);

  const capture = async () => {
    // The sidebar, as a person sees it: which entries, in what order, and
    // which are buried inside a heading that renders collapsed.
    const nav = await page.evaluate(() => {
      const units = Array.from(document.querySelectorAll("#nav-list > [data-nav], #nav-list > [data-nav-group]"));
      const top = units.map((el) => el.dataset.nav || ("group:" + el.dataset.navGroup));
      const grouped = {};
      document.querySelectorAll("[data-nav-sub]").forEach((sub) => {
        grouped[sub.dataset.navSub] = Array.from(sub.querySelectorAll("[data-nav]")).map((e) => e.dataset.nav);
      });
      return { top, grouped };
    });
    // Controls that live in the shell rather than on a page -- the ones that
    // are easiest to add without ever checking who else now sees them.
    const shell = await page.evaluate(() => ({
      reorder_in_sidebar: !!document.getElementById("nav-reorder-open"),
      view_as_buttons: document.querySelectorAll("[data-viewas-user]").length > 0,
      external_links: Array.from(document.querySelectorAll("[data-nav-external]")).map((e) => e.dataset.nav),
    }));
    // What each endpoint answers. The status is the permission; the can_*
    // flags are what the page uses to decide whether to draw a control, so a
    // flag flipping is a button appearing or vanishing on somebody's screen.
    const api = await page.evaluate(async (probes) => {
      const out = {};
      // In parallel. Twelve sequential same-origin requests, some of which do
      // real database work, was the bulk of the per-role cost.
      await Promise.all(probes.map(async (p) => {
        try {
          const r = await fetch(p, { credentials: "include" });
          const entry = { status: r.status };
          if (r.ok) {
            const d = await r.json().catch(() => null);
            const flags = {};
            const scan = (o) => {
              if (!o || typeof o !== "object" || Array.isArray(o)) return;
              for (const k of Object.keys(o)) if (/^can_|^is_.*_role$/.test(k)) flags[k] = o[k];
            };
            scan(d);
            if (Object.keys(flags).length) entry.flags = flags;
          }
          out[p] = entry;
        } catch (e) { out[p] = { status: "error" }; }
      }));
      return out;
    }, PROBES);
    return { nav, shell, api };
  };


  const seen = {};
  for (const role of roles) {
    await pool.query("UPDATE users SET role = $1 WHERE lower(email) = lower($2)", [role, EMAIL]);
    const t0 = Date.now();
    const status = await login(EMAIL, PW);
    if (status !== 200) { check(`the probe account can sign in as ${role}`, false, status); continue; }
    const tLogin = Date.now();
    seen[role] = await capture();
    console.log(`  captured ${role}: ${seen[role].nav.top.length} top-level entries `
      + `(login ${tLogin - t0}ms, capture ${Date.now() - tLogin}ms)`);
  }

  console.log("\n== Against the snapshot ==");
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")); } catch (e) { stored = {}; }
  const missing = roles.filter((r) => !stored[r]);
  if (UPDATE || missing.length === roles.length) {
    fs.writeFileSync(SNAPSHOT, JSON.stringify({ ...stored, ...seen }, null, 2) + "\n");
    check(UPDATE ? `SNAPSHOT UPDATED for the ${part} roles -- read the diff before committing it`
                 : `snapshot written for the ${part} roles for the first time`, true);
  } else {
    const diffs = [];
    const walk = (a, b, trail) => {
      const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
      for (const k of keys) {
        const av = a ? a[k] : undefined, bv = b ? b[k] : undefined;
        if (av && bv && typeof av === "object" && typeof bv === "object" && !Array.isArray(av)) { walk(av, bv, trail + "." + k); continue; }
        if (JSON.stringify(av) !== JSON.stringify(bv)) {
          diffs.push(`  ${trail}.${k}\n      was: ${JSON.stringify(av)}\n      now: ${JSON.stringify(bv)}`);
        }
      }
    };
    for (const r of roles) walk(stored[r], seen[r], r);
    check("NOBODY'S ACCESS CHANGED WITHOUT THE SNAPSHOT CHANGING WITH IT",
      diffs.length === 0,
      diffs.length
        ? diffs.join("\n") + "\n\n      If every line above is what you meant, re-run with UPDATE_MATRIX=1\n"
          + "      and commit role-matrix.json in the same change, so the difference is\n"
          + "      visible in review. If any line is a surprise, that is the bug."
        : undefined);
  }

  console.log("\n== Things that must be true whatever the snapshot says ==");
  // A snapshot only catches CHANGE. It would happily preserve a mistake that
  // was already there the day it was written, so the rules that matter most
  // are asserted outright as well.
  for (const [role, s] of Object.entries(seen)) {
    if (!["owner", "super_admin"].includes(role)) {
      check(`${role} is not offered the reorder control in the sidebar`, s.shell.reorder_in_sidebar === false);
      check(`${role} is not offered view-as`, s.shell.view_as_buttons === false);
    }
    if (!["owner", "super_admin", "admin"].includes(role)) {
      check(`${role} cannot read the view-as log`, s.api["/api/auth/view-as/log"].status !== 200,
        s.api["/api/auth/view-as/log"]);
    }
    if (/^ot_/.test(role)) {
      check(`${role} REACHES NO ABA CLIENT DATA`,
        s.api["/api/clients"].status !== 200 && s.api["/api/caseload/bcbas"].status !== 200,
        { clients: s.api["/api/clients"], caseload: s.api["/api/caseload/bcbas"] });
    }
    if (["hr_admin", "hiring_manager", "interviewer"].includes(role)) {
      check(`${role} reaches no client record either`, s.api["/api/clients"].status !== 200, s.api["/api/clients"]);
    }
  }

  check("no page errors while walking the roles", errors.length === 0, errors.join(" | "));
  await pool.end();
  await browser.close();
}

module.exports = { runMatrix, PART, rolesFromSource };
