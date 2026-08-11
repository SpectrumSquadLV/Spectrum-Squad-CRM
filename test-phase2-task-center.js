// Phase 2 (staff productivity) integration test — run against a live server.
//
//   DATABASE_URL=... node server.js
//   node test-phase2-task-center.js
//
// Verifies the personal Task Center + counter API:
//   - task priority persists
//   - GET /api/staff-tasks/summary returns the caller's own open/overdue/today counts
//   - supervisors (owner) see the whole task list; scope=mine narrows to them
//   - a NON-supervisory staffer is scoped server-side to ONLY their own tasks
//     and can never see a task assigned to someone else
const BASE = process.env.BASE || "http://localhost:3009";
let cookie = "";
let pass = 0, fail = 0;

function makeClient() {
  let jar = "";
  return async function req(path, { method = "GET", body } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(jar ? { Cookie: jar } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) jar = sc.split(";")[0];
    let data = null; try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  };
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
}

(async () => {
  const owner = makeClient();
  const staff = makeClient();

  console.log("\n== auth ==");
  let r = await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner can sign in", r.status === 200, r.data);
  let rs = await staff("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("a non-supervisory staffer can sign in", rs.status === 200, rs.data);
  if (r.status !== 200 || rs.status !== 200) { console.log("\nCannot continue.\n"); process.exit(1); }

  const me = (await owner("/api/auth/me")).data.user;
  const staffMe = (await staff("/api/auth/me")).data.user;

  console.log("\n== priority persists ==");
  let created = await owner("/api/staff-tasks", { method: "POST", body: { title: "P2 owner task", assigned_user_id: me.id, priority: "high" } });
  check("task created", created.status === 201, created.data);
  check("priority persisted as high", created.data && created.data.priority === "high", created.data && created.data.priority);
  let bad = await owner("/api/staff-tasks", { method: "POST", body: { title: "P2 bad priority", assigned_user_id: me.id, priority: "banana" } });
  check("unknown priority falls back to normal", bad.data && bad.data.priority === "normal", bad.data && bad.data.priority);

  // A task assigned to the staffer (by their email + id).
  let staffTask = await owner("/api/staff-tasks", { method: "POST", body: { title: "P2 clinical-only task", assigned_user_id: staffMe.id, assigned_email: staffMe.email, priority: "urgent" } });
  check("owner can assign a task to the staffer", staffTask.status === 201, staffTask.data);
  const staffTaskId = staffTask.data && staffTask.data.id;
  const ownerTaskId = created.data && created.data.id;

  console.log("\n== summary endpoint ==");
  let sum = await owner("/api/staff-tasks/summary");
  check("owner summary returns numeric open count", sum.status === 200 && typeof sum.data.open === "number", sum.data);
  check("owner summary counts their own task", sum.data && sum.data.open >= 1, sum.data);
  let ssum = await staff("/api/staff-tasks/summary");
  check("staffer summary counts the task assigned to them", ssum.data && ssum.data.open >= 1, ssum.data);

  console.log("\n== supervisor sees all; scope=mine narrows ==");
  const allForOwner = (await owner("/api/staff-tasks")).data || [];
  check("owner (supervisor) sees the staffer's task in the full list", allForOwner.some((t) => t.id === staffTaskId), allForOwner.length);
  const mineForOwner = (await owner("/api/staff-tasks?scope=mine")).data || [];
  check("owner scope=mine includes owner's own task", mineForOwner.some((t) => t.id === ownerTaskId), mineForOwner.length);
  check("owner scope=mine EXCLUDES the staffer-only task", !mineForOwner.some((t) => t.id === staffTaskId), mineForOwner.map((t) => t.id));

  console.log("\n== non-supervisor is scoped server-side ==");
  const staffList = (await staff("/api/staff-tasks")).data || [];
  check("staffer sees the task assigned to them", staffList.some((t) => t.id === staffTaskId), staffList.map((t) => t.id));
  check("staffer CANNOT see the owner's task (server-enforced, not just hidden)", !staffList.some((t) => t.id === ownerTaskId), staffList.map((t) => t.id));
  // Even explicitly asking for everything must not widen their view.
  const staffTryAll = (await staff("/api/staff-tasks?scope=all")).data || [];
  check("staffer scope=all is still scoped to their own tasks", !staffTryAll.some((t) => t.id === ownerTaskId), staffTryAll.map((t) => t.id));

  console.log("\n== quick-complete flips status ==");
  let done = await staff("/api/staff-tasks/" + staffTaskId, { method: "PATCH", body: { status: "done" } });
  check("staffer can complete their own task", done.data && done.data.status === "done", done.data && done.data.status);
  let ssum2 = await staff("/api/staff-tasks/summary");
  check("completing it drops the staffer's open count", ssum2.data && ssum2.data.open === (ssum.data.open - 1), { before: ssum.data, after: ssum2.data });

  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nCrashed:", e); process.exit(1); });
