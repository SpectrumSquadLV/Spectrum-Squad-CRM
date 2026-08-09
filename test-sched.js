// Exercises the scheduling engine against a live local server.
const BASE = "http://localhost:3009";
let cookie = "";
let pass = 0, fail = 0;

async function req(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + JSON.stringify(detail).slice(0, 320) : "")); }
};
const d = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const dow = (s) => new Date(s + "T00:00:00Z").getUTCDay();

(async () => {
  console.log("\n== setup ==");
  let r = await req("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signed in", r.status === 200, r.data);

  r = await req("/api/sched/bootstrap");
  check("bootstrap loads", r.status === 200 && Array.isArray(r.data.locations), r.data);
  check("locations seeded", r.data.locations.length >= 5, r.data.locations && r.data.locations.length);
  check("bootstrap reports my permissions", r.data.me && r.data.me.can_schedule === true, r.data.me);
  const clinic = r.data.locations.find((l) => l.kind === "clinic");
  const home = r.data.locations.find((l) => l.kind === "home");
  const clients = r.data.clients;
  check("clients available to schedule", clients.length > 0, clients.length);
  check("client names are shortened for the calendar", /^[A-Za-z]+ [A-Z]\.$/.test(clients[0].display), clients[0]);

  // Two staff to schedule against.
  const mayaId = (await req("/api/hr/employees", { method: "POST", body: { name: "Maya Torres", email: "maya@spectrumsquadlv.com", role_title: "RBT" } })).data.id;
  const jordanId = (await req("/api/hr/employees", { method: "POST", body: { name: "Jordan Pike", email: "jordan@spectrumsquadlv.com", role_title: "RBT" } })).data.id;
  const clientA = clients[0].id, clientB = clients[1] ? clients[1].id : clients[0].id;

  // Pick a weekday so recurrence tests are predictable.
  let base = d(7);
  while (dow(base) === 0 || dow(base) === 6) base = d((new Date(base) - new Date(d(0))) / 86400000 + 1);

  console.log("\n== creating sessions ==");
  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientA, staff_id: mayaId, location_id: clinic.id,
    session_date: base, start_time: "09:00", end_time: "12:00",
    service_label: "ABA Therapy", service_code: "97153",
  }});
  check("create a single session", r.status === 201 && r.data.session.id, r.data);
  check("missing availability is a note, not a blocker", r.status === 201, r.data);
  const s1 = r.data.session;
  check("hours computed", s1.hours === 3, s1.hours);
  check("friendly time labels", s1.start_label === "9:00 AM" && s1.end_label === "12:00 PM", [s1.start_label, s1.end_label]);
  check("assigned session starts as scheduled", s1.status === "scheduled", s1.status);

  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientB, staff_id: null, location_id: clinic.id,
    session_date: base, start_time: "13:00", end_time: "15:00",
  }});
  check("unassigned session saves as needing coverage", r.status === 201 && r.data.session.status === "needs_coverage", r.data.session && r.data.session.status);
  const s2 = r.data.session;

  console.log("\n== conflict detection ==");
  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientB, staff_id: mayaId, location_id: clinic.id,
    session_date: base, start_time: "10:00", end_time: "11:00",
  }});
  check("staff double-booking is blocked", r.status === 409 && r.data.error === "conflict", r.data);
  check("the message names the staff member, client and times", /Maya is already scheduled with .+ from 9:00 AM to 12:00 PM/.test((r.data.blocking[0] || {}).message), r.data.blocking);

  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientA, staff_id: jordanId, location_id: clinic.id,
    session_date: base, start_time: "11:00", end_time: "13:00",
  }});
  check("client double-booking is blocked", r.status === 409 && r.data.blocking.some((c) => c.code === "client_double_booked"), r.data.blocking);

  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientA, staff_id: jordanId, session_date: base, start_time: "15:00", end_time: "14:00",
  }});
  check("backwards times rejected in plain words", r.status === 409 && /ends before it starts/.test(r.data.blocking[0].message), r.data.blocking);

  // Adjacent sessions at different locations warn about travel.
  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientB, staff_id: mayaId, location_id: home.id,
    session_date: base, start_time: "12:10", end_time: "12:50",
  }});
  check("tight turnaround between locations warns", r.status === 409 && r.data.error === "warnings" && r.data.warnings.some((w) => w.code === "travel"), r.data.warnings);
  check("travel warning states the actual gap", /Only 10 minutes between/.test(r.data.warnings.find((w) => w.code === "travel").message), r.data.warnings);

  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientB, staff_id: mayaId, location_id: home.id,
    session_date: base, start_time: "12:10", end_time: "12:50",
    accept_warnings: true, override_reason: "Same building, different room",
  }});
  check("a warning can be accepted with a reason", r.status === 201, r.data);
  const s3 = r.data.session;

  console.log("\n== availability ==");
  await req(`/api/sched/availability/staff/${jordanId}`, { method: "POST", body: { windows: [
    { day_of_week: dow(base), start_time: "08:00", end_time: "15:00" },
  ]}});
  r = await req(`/api/sched/availability/staff/${jordanId}`);
  check("staff availability saved", r.data.windows.length === 1, r.data.windows);

  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientB, staff_id: jordanId, session_date: base, start_time: "16:00", end_time: "18:00",
  }});
  check("scheduling outside declared availability warns", r.status === 409 && r.data.warnings.some((w) => w.code === "outside_availability"), r.data.warnings);
  check("the warning quotes their real hours", /only available .+ 8:00 AM–3:00 PM/.test(r.data.warnings.find((w) => w.code === "outside_availability").message), r.data.warnings);

  r = await req(`/api/sched/availability/staff/${jordanId}`, { method: "POST", body: { windows: [
    { day_of_week: dow(base), start_time: "15:00", end_time: "08:00" },
  ]}});
  check("backwards availability window rejected", r.status === 400 && /start time before its end time/.test(r.data.error), r.data);

  await req(`/api/sched/availability/client/${clientA}`, { method: "POST", body: { windows: [
    { day_of_week: dow(base), start_time: "15:00", end_time: "19:00" },
  ]}});
  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientA, staff_id: jordanId, session_date: base, start_time: "08:00", end_time: "09:00",
  }});
  check("scheduling outside client availability warns", r.status === 409 && r.data.warnings.some((w) => w.code === "outside_client_availability"), r.data.warnings);

  console.log("\n== time off ==");
  r = await req("/api/sched/time-off", { method: "POST", body: {
    employee_id: mayaId, start_date: base, end_date: base, kind: "pto",
  }});
  check("time off saved", r.status === 201, r.data);
  check("time off reports the sessions it collides with", r.data.conflicts.length >= 1 && /still needs covering/.test(r.data.conflicts[0].message), r.data.conflicts);

  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientB, staff_id: mayaId, session_date: base, start_time: "18:00", end_time: "19:00",
  }});
  check("scheduling into approved PTO is blocked", r.status === 409 && r.data.blocking.some((c) => c.code === "time_off"), r.data.blocking);
  const toId = (await req(`/api/sched/availability/staff/${mayaId}`)).data.time_off[0].id;
  await req(`/api/sched/time-off/${toId}`, { method: "DELETE" });

  console.log("\n== recurring series ==");
  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientA, staff_id: jordanId, location_id: clinic.id,
    recurring: true, days_of_week: [1, 3, 5], start_time: "15:30", end_time: "18:30",
    starts_on: d(14), ends_on: d(42), accept_warnings: true, override_reason: "Confirmed with family",
  }});
  check("recurring series created", r.status === 201 && r.data.created > 0, r.data);
  const seriesCount = r.data.created;
  check("series produced roughly 4 weeks of M/W/F", seriesCount >= 10 && seriesCount <= 14, seriesCount);

  r = await req(`/api/sched/sessions?from=${d(14)}&to=${d(42)}&client_id=${clientA}`);
  const seriesSessions = r.data.sessions.filter((s) => s.series_id);
  check("series sessions land on Mon/Wed/Fri only", seriesSessions.every((s) => [1, 3, 5].includes(dow(s.session_date))), seriesSessions.slice(0, 3).map((s) => s.session_date));
  check("every occurrence carries the series id", seriesSessions.length === seriesCount, [seriesSessions.length, seriesCount]);

  // Editing scope.
  const mid = seriesSessions[Math.floor(seriesSessions.length / 2)];
  r = await req(`/api/sched/sessions/${mid.id}`, { method: "PATCH", body: { scope: "this", admin_notes: "Just this one" } });
  check("this-session-only edit touches one row", r.status === 200 && r.data.affected === 1, r.data);

  r = await req(`/api/sched/sessions/${mid.id}`, { method: "PATCH", body: { scope: "future", staff_id: mayaId, accept_warnings: true, override_reason: "Handover" } });
  check("this-and-future reassignment touches several rows", r.status === 200 && r.data.affected > 1, r.data);
  r = await req(`/api/sched/sessions?from=${d(14)}&to=${d(42)}&client_id=${clientA}`);
  const after = r.data.sessions.filter((s) => s.series_id);
  const beforeMid = after.filter((s) => s.session_date < mid.session_date);
  const fromMid = after.filter((s) => s.session_date >= mid.session_date);
  check("earlier occurrences kept the original staff", beforeMid.every((s) => s.staff_id === jordanId), beforeMid.map((s) => s.staff_display));
  check("this one and later moved to the new staff", fromMid.every((s) => s.staff_id === mayaId), fromMid.map((s) => s.staff_display));
  check("reassignment recorded who it came from", fromMid.every((s) => s.previous_staff_id === jordanId), fromMid[0]);

  // A date change must not spread across the series.
  const dates = new Set(after.map((s) => s.session_date));
  r = await req(`/api/sched/sessions/${mid.id}`, { method: "PATCH", body: { scope: "series", session_date: d(60), accept_warnings: true } });
  const after2 = (await req(`/api/sched/sessions?from=${d(14)}&to=${d(70)}&client_id=${clientA}`)).data.sessions.filter((s) => s.series_id);
  const movedCount = after2.filter((s) => s.session_date === d(60)).length;
  check("a series edit does NOT collapse every occurrence onto one date", movedCount === 1, { movedCount, total: after2.length });

  console.log("\n== status, cancellation, coverage ==");
  r = await req(`/api/sched/sessions/${s1.id}`, { method: "PATCH", body: { status: "checked_in" } });
  check("check in", r.status === 200 && r.data.session.status === "checked_in", r.data.session && r.data.session.status);
  r = await req(`/api/sched/sessions/${s1.id}`, { method: "PATCH", body: { status: "completed" } });
  check("complete", r.data.session.status === "completed", r.data.session);
  check("completing a session raises the note requirement", r.data.session.note_status === "required", r.data.session.note_status);

  r = await req(`/api/sched/sessions/${s1.id}`, { method: "DELETE" });
  check("a session that happened cannot be deleted", r.status === 409 && /Cancel it with a reason/.test(r.data.error), r.data);

  r = await req(`/api/sched/sessions/${s3.id}/cancel`, { method: "POST", body: { cancelled_by: "client_family" } });
  check("cancelling without a reason is refused", r.status === 400, r.data);
  r = await req(`/api/sched/sessions/${s3.id}/cancel`, { method: "POST", body: { cancelled_by: "client_family", reason: "Child unwell" } });
  check("cancel with who and why", r.status === 200 && r.data.session.status === "cancelled", r.data.session);
  check("a cancelled session is not billable", r.data.session.billing_status === "not_ready" && /did not occur/.test(r.data.session.billing_hold_reason), r.data.session);

  // A staff call-out leaves the client's session needing coverage.
  r = await req("/api/sched/sessions", { method: "POST", body: {
    client_id: clientB, staff_id: jordanId, location_id: clinic.id,
    session_date: d(3), start_time: "09:00", end_time: "11:00", accept_warnings: true,
  }});
  const s4 = r.data.session;
  r = await req(`/api/sched/sessions/${s4.id}/cancel`, { method: "POST", body: { cancelled_by: "staff", reason: "Sick", staff_call_out: true } });
  check("a staff call-out leaves the session needing coverage", r.data.session.status === "needs_coverage", r.data.session.status);
  check("the call-out unassigns the staff member", r.data.session.staff_id === null, r.data.session);
  check("but remembers who it was", r.data.session.previous_staff_id === jordanId, r.data.session);

  r = await req(`/api/sched/sessions/${s4.id}`, { method: "PATCH", body: { staff_id: mayaId, accept_warnings: true, reason: "Covered by Maya" } });
  check("coverage reassignment works", r.status === 200 && r.data.session.staff_id === mayaId, r.data.session);

  console.log("\n== audit trail ==");
  r = await req(`/api/sched/sessions/${s4.id}`);
  check("history recorded", r.data.history.length >= 3, r.data.history.length);
  const reassign = r.data.history.find((h) => h.field === "staff_id");
  check("reassignment records before and after", reassign && String(reassign.old_value) !== String(reassign.new_value), reassign);
  check("reassignment records the reason", reassign && /Covered by Maya/.test(reassign.reason || ""), reassign);
  check("the call-out is in the history", r.data.history.some((h) => h.action === "call_out"), r.data.history.map((h) => h.action));

  console.log("\n== day board ==");
  r = await req(`/api/sched/day-board?date=${base}`);
  check("day board loads", r.status === 200 && r.data.metrics, r.data);
  check("counts sessions today", r.data.metrics.sessions_today >= 3, r.data.metrics);
  check("counts what needs coverage", r.data.metrics.needs_coverage >= 1, r.data.metrics);
  check("counts missing notes from completed sessions", r.data.metrics.notes_missing >= 1, r.data.metrics);

  console.log("\n== summaries ==");
  r = await req(`/api/sched/client/${clientA}/summary?week_start=${base}`);
  check("client summary loads", r.status === 200, r.data);
  check("scheduled hours computed", r.data.scheduled_hours > 0, r.data.scheduled_hours);
  check("unknown authorized hours reported as null, not zero", r.data.authorized_hours === null ? r.data.unscheduled_hours === null : true, r.data);

  r = await req(`/api/sched/staff/${mayaId}/summary?week_start=${base}`);
  check("staff summary loads", r.status === 200 && r.data.scheduled_hours > 0, r.data);
  check("open capacity never goes negative", r.data.open_capacity_hours >= 0, r.data);

  console.log("\n== legacy migration ==");
  r = await req("/api/sched/migrate-legacy", { method: "POST" });
  check("legacy weekly patterns converted", r.status === 200, r.data);
  const first = r.data;
  r = await req("/api/sched/migrate-legacy", { method: "POST" });
  check("migration refuses to run twice", r.data.already === true, r.data);

  console.log("\n== permissions ==");
  const ownerCookie = cookie;
  await req("/api/admin/users", { method: "POST", body: {
    name: "Maya Torres", email: "maya@spectrumsquadlv.com", password: "MayaTech123!", role: "clinical",
  }});
  // Re-fetch: a duplicate email just means the account already exists.
  cookie = "";
  r = await req("/api/auth/login", { method: "POST", body: { email: "maya@spectrumsquadlv.com", password: "MayaTech123!" } });
  const techLoggedIn = r.status === 200;
  if (techLoggedIn) {
    r = await req("/api/sched/day-board");
    check("clinical role can see the whole day board", r.status === 200, r.data);
  } else {
    check("technician account created for permission test", false, r.data);
  }

  cookie = ownerCookie;
  await req("/api/admin/users", { method: "POST", body: {
    name: "Sierra Lane", email: "sierra@spectrumsquadlv.com", password: "Sierra12345!", role: "interviewer",
  }});
  cookie = "";
  r = await req("/api/auth/login", { method: "POST", body: { email: "sierra@spectrumsquadlv.com", password: "Sierra12345!" } });
  if (r.status === 200) {
    r = await req("/api/sched/bootstrap");
    check("a role with no schedule access and no staff record is told why", r.status === 403 && /staff record/.test(r.data.error), r.data);
  }

  cookie = "";
  r = await req("/api/sched/sessions");
  check("signed-out request refused", r.status === 401, r.data);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
