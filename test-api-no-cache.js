// A write that lands in the database and a screen that keeps the old number.
//
//   DATABASE_URL=... node run-tests.js test-api-no-cache.js
//
// Reported as "still two separate" -- after a caseload merge that had already
// worked. The two BCBA cards on the dashboard read 8 and 6, byte-identical to
// the screenshot taken before the merge.
//
// EVERY API RESPONSE WENT OUT WITH NO CACHE HEADERS AT ALL, and that is not the
// same as saying "do not cache me". A GET with no freshness information may be
// reused by a cache without asking, on its own guess at how long it stays good
// -- RFC 9111 calls it heuristic freshness, and Safari applies it. So a merge,
// a status change, an assignment could all be written, and the screen keep
// showing what it was handed earlier. It reads exactly like the write failed,
// which is the worst way for this to look: the next thing somebody does is run
// it again.
//
// This is the second half of a bug already fixed once. "Marissa still has the
// old everything" was the same problem in the STATIC files, fixed with ETags
// and no-cache there. The data responses were never touched.
//
// no-cache rather than no-store, and the difference was measured: no-store These responses are
// leaves a request pending in Chromium long enough that three existing browser
// suites never reach networkidle. no-cache still forbids reuse without asking
// the server first, which is the whole of the bug.
"use strict";
const BASE = process.env.BASE || "http://localhost:3009";

let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else {
    const line = "  FAIL  " + n + (d !== undefined ? "  -> " + (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 300) : "");
    fail++; failures.push(line); console.log(line);
  }
};

function client() {
  let jar = "";
  return async (path, { method = "GET", body } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(jar ? { Cookie: jar } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) jar = sc.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data, cache: res.headers.get("cache-control") };
  };
}

(async () => {
  const owner = client();
  const login = await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signs in", login.status === 200, login.status);
  check("even the login response must be revalidated", login.cache === "no-cache", login.cache);

  console.log("\n== Nothing a screen reads may be served from a cache ==");
  // A spread across the app rather than one endpoint: the bug was in the one
  // helper every route answers through, so the guarantee is app-wide or it is
  // not worth having.
  const endpoints = [
    "/api/dashboard",
    "/api/clients",
    "/api/staff",
    "/api/caseload/bcbas",
    "/api/tasks",
    "/api/policies/library",
    "/api/hr/employees",
    "/api/admin/settings",
  ];
  for (const path of endpoints) {
    const r = await owner(path);
    // 200 or 403 -- either way the HEADER must be there. A refusal that gets
    // cached is its own bug: a permission granted afterwards would keep reading
    // as denied.
    check(`${path} says no-cache`, r.cache === "no-cache", { path, status: r.status, cache: r.cache });
  }

  console.log("\n== And the number really does change when the data does ==");
  // The end-to-end shape of what was reported: rename the BCBA on a client and
  // ask the dashboard again. The caseload card is grouped by that name, so a
  // stale answer here is exactly the two-cards-that-should-be-one symptom.
  const RUN = Math.random().toString(36).slice(2, 7);
  const made = await owner("/api/clients", {
    method: "POST",
    body: { child_name: "Cache Probe " + RUN, parent_name: "P", parent_email: `cache.${RUN}@example.invalid` },
  });
  const id = made.data.id;
  const setName = (name) => owner(`/api/clients/${id}/authorization`, { method: "PATCH", body: { assigned_bcba_name: name } });
  const countFor = async (name) => {
    const d = await owner("/api/caseload/bcbas");
    const row = (d.data.bcbas || []).find((b) => b.name === name);
    return row ? row.clients : 0;
  };

  await setName("Cache Split A " + RUN);
  check("the first name shows on the caseload list", (await countFor("Cache Split A " + RUN)) === 1);
  await setName("Cache Split B " + RUN);
  check("RENAMING IS VISIBLE ON THE VERY NEXT READ, not the next hard refresh",
    (await countFor("Cache Split B " + RUN)) === 1, await countFor("Cache Split B " + RUN));
  check("AND THE OLD NAME IS GONE FROM IT -- the two-cards-that-should-be-one symptom",
    (await countFor("Cache Split A " + RUN)) === 0, await countFor("Cache Split A " + RUN));

  const dash = await owner("/api/dashboard");
  const onDash = ((dash.data.bcbaCaseloads || {}).bcbas || []).map((b) => b.name);
  check("the dashboard card agrees with the caseload list",
    onDash.includes("Cache Split B " + RUN) && !onDash.includes("Cache Split A " + RUN),
    onDash.filter((n) => n.includes(RUN)));

  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
