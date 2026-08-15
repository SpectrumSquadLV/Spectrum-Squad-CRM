// Front-end wiring checks.
//
// Written after #/rethink-clients silently fell back to the dashboard in
// production. The page, the route and the nav were all fine; the file was
// simply missing from server.js's PUBLIC_FILES allowlist, so the browser got a
// 404, window.__renderRethinkMatch never defined, and the router's else-branch
// quietly rendered the dashboard instead.
//
// That failure is invisible: no error, no blank page, just the wrong screen.
// The first assertion here is therefore the general one -- EVERY script
// index.html loads must be served -- so the next front-end file added to this
// app cannot repeat it.
//
// Run: node test-frontend-routes.js     (no database, no network, no browser)

"use strict";

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
};

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const indexHtml = read("index.html");
const serverJs = read("server.js");

// ---- the allowlist, as the server actually defines it ---------------------
const publicBlock = serverJs.match(/const PUBLIC_FILES = new Set\(\[([\s\S]*?)\]\);/);
const publicFiles = new Set(
  (publicBlock ? publicBlock[1] : "").split("\n")
    .map((l) => (l.match(/"([^"]+)"/) || [])[1])
    .filter(Boolean)
);

console.log("\nSTATIC ASSET ALLOWLIST\n");
check("server.js defines a PUBLIC_FILES allowlist", !!publicBlock);

// Every locally-referenced script tag in index.html must be served.
const scriptSrcs = [...indexHtml.matchAll(/<script\s+src="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((s) => !/^https?:\/\//.test(s));

check("index.html loads at least one local script", scriptSrcs.length > 0);
for (const src of scriptSrcs) {
  const asPath = src.startsWith("/") ? src : "/" + src;
  check(`${src} is on the PUBLIC_FILES allowlist`, publicFiles.has(asPath),
    `not in allowlist — the browser would 404 and its window.__render* global would never define`);
  check(`${src} exists on disk`, fs.existsSync(path.join(__dirname, asPath.slice(1))));
}

// ---- the Rethink client matching screen, end to end ----------------------
console.log("\nRETHINK CLIENT MATCHING ROUTE\n");

check("the matching bundle is served", publicFiles.has("/rethink-match-frontend.js"));
check("index.html loads the matching bundle",
  /<script\s+src="rethink-match-frontend\.js"><\/script>/.test(indexHtml));

const matchJs = read("rethink-match-frontend.js");
check("the bundle defines the global the router looks for",
  /window\.__renderRethinkMatch\s*=/.test(matchJs));

check("the router claims #/rethink-clients",
  /hash\.startsWith\("#\/rethink-clients"\)/.test(indexHtml));
check("the router calls the matching renderer",
  /#\/rethink-clients"\)\)\s*\{\s*if\s*\(window\.__renderRethinkMatch\)/.test(indexHtml));

// The hash must resolve to a nav key, or the sidebar highlight breaks.
const rawView = "#/rethink-clients".split("/")[1];
check("the hash resolves to the nav key 'rethink-clients'", rawView === "rethink-clients", rawView);

// ---- navigation ----------------------------------------------------------
console.log("\nNAVIGATION\n");

check("there is a sidebar entry for the matching screen",
  /key:\s*"rethink-clients"[^}]*label:\s*"Rethink Client Matching"/.test(indexHtml));
check("the sidebar entry points at the right hash",
  /key:\s*"rethink-clients"[^}]*hash:\s*"#\/rethink-clients"/.test(indexHtml));

// Gated to the same roles the server enforces on /api/rethink/client-match.
const navGuard = indexHtml.match(/if \((\[[^\]]*\])\.includes\(state\.user\.role\)\)\s*\n\s*navItems\.push\(\{ key: "rethink-clients"/);
check("the sidebar entry is owner/admin only", !!navGuard, navGuard && navGuard[1]);
if (navGuard) {
  const roles = navGuard[1];
  check("owner, admin and super_admin can see it",
    /"owner"/.test(roles) && /"admin"/.test(roles) && /"super_admin"/.test(roles), roles);
  check("clinical and hr_admin cannot",
    !/"clinical"/.test(roles) && !/"hr_admin"/.test(roles), roles);
}

check("the module catalog knows the screen (so per-user access grants work)",
  /"rethink-clients":\s*\{[^}]*hash:\s*"#\/rethink-clients"/.test(indexHtml));

// The server-side guard is the one that actually enforces access.
const rethinkJs = read("rethink.js");
check("the server restricts client-match routes to owner/admin",
  /const canMatch = \(u\) => \["owner", "super_admin", "admin"\]\.includes\(roleOf\(u\)\)/.test(rethinkJs));
check("the client-match routes check canMatch before doing anything",
  /pathname\.startsWith\("\/api\/rethink\/client-match"\)\)\s*\{\s*\n\s*if \(!canMatch\(user\)\)/.test(rethinkJs));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
