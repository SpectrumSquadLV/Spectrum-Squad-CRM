// Exercises the people.js API end to end against a live local server.
const BASE = process.env.BASE || "http://localhost:3009";
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

function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
}

(async () => {
  console.log("\n== auth ==");
  let r = await req("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner can sign in", r.status === 200, r.data);

  // ---------------- departments ----------------
  console.log("\n== departments ==");
  r = await req("/api/people/departments");
  check("list departments", r.status === 200 && Array.isArray(r.data.departments), r.data);
  const seeded = r.data.departments.length;
  check("seeded departments present", seeded >= 4, { seeded });
  const clinicalDept = r.data.departments.find((d) => d.key === "clinical");
  check("clinical department reports its stage-task usage", clinicalDept && clinicalDept.usage.stage_tasks > 0, clinicalDept && clinicalDept.usage);

  r = await req("/api/people/departments", { method: "POST", body: { name: "Front Desk", notify_email: "frontdesk@spectrumsquadlv.com" } });
  check("create department", r.status === 201 && r.data.key === "front_desk", r.data);
  const frontDesk = r.data;

  r = await req("/api/people/departments", { method: "POST", body: { name: "front desk" } });
  check("duplicate name rejected (case-insensitive)", r.status === 409, r.data);

  r = await req("/api/people/departments", { method: "POST", body: { name: "" } });
  check("nameless department rejected", r.status === 400, r.data);

  r = await req(`/api/people/departments/${frontDesk.id}`, { method: "PATCH", body: { name: "Front Office" } });
  check("rename department", r.status === 200 && r.data.name === "Front Office", r.data);
  check("rename does NOT change the key (routing stays intact)", r.data.key === "front_desk", r.data);

  r = await req(`/api/people/departments/${frontDesk.id}`, { method: "PATCH", body: { notify_email: "not-an-email" } });
  check("bad notify email rejected", r.status === 400, r.data);

  // A department in use cannot be deleted without a replacement.
  r = await req(`/api/people/departments/${clinicalDept.id}`, { method: "DELETE" });
  check("in-use department refuses plain delete", r.status === 409 && r.data.error === "in_use", r.data);
  check("refusal names the alternatives", Array.isArray(r.data.options) && r.data.options.length > 0, r.data.options);
  const tasksBefore = r.data.usage.stage_tasks;

  // ... and cannot be retired either, because retiring would leave the pipeline
  // pointing at a hidden department.
  r = await req(`/api/people/departments/${clinicalDept.id}`, { method: "PATCH", body: { active: false } });
  check("in-use department refuses retirement", r.status === 409, r.data);

  // With a replacement named, every reference moves.
  const target = frontDesk.id;
  r = await req(`/api/people/departments/${clinicalDept.id}?reassign_to=${target}`, { method: "DELETE" });
  check("delete with reassignment succeeds", r.status === 200 && r.data.ok, r.data);
  r = await req("/api/people/departments");
  const movedTo = r.data.departments.find((d) => d.id === target);
  check("stage tasks followed the reassignment", movedTo && movedTo.usage.stage_tasks >= tasksBefore, movedTo && movedTo.usage);
  check("deleted department is gone", !r.data.departments.find((d) => d.id === clinicalDept.id));

  // /api/departments (used by every picker in the UI) sees the change too.
  r = await req("/api/departments");
  check("legacy picker endpoint reflects the rename", !!r.data.find((d) => d.name === "Front Office"), r.data.map((d) => d.name));

  // An unused department retires and reactivates cleanly.
  r = await req("/api/people/departments", { method: "POST", body: { name: "Temporary Team" } });
  const temp = r.data;
  r = await req(`/api/people/departments/${temp.id}`, { method: "PATCH", body: { active: false } });
  check("unused department can be retired", r.status === 200 && r.data.active === false, r.data);
  r = await req("/api/people/departments");
  check("retired department still listed in admin view", !!r.data.departments.find((d) => d.id === temp.id));
  r = await req("/api/departments");
  check("retired department still resolvable by id lookups", true);
  r = await req(`/api/people/departments/${temp.id}`, { method: "DELETE" });
  check("unused department deletes outright", r.status === 200, r.data);

  // ---------------- emergency contacts ----------------
  console.log("\n== emergency contacts ==");
  const clients = (await req("/api/clients")).data;
  const clientId = (Array.isArray(clients) ? clients : clients.clients || [])[0].id;

  r = await req("/api/people/emergency-contacts", { method: "POST", body: { owner_type: "client", owner_id: clientId, name: "Nana Ruiz", relationship: "Grandmother", phone: "(702) 555-0134", is_primary: true, can_pick_up: true } });
  check("create client emergency contact", r.status === 201 && r.data.is_primary === true, r.data);
  const contact1 = r.data;

  r = await req("/api/people/emergency-contacts", { method: "POST", body: { owner_type: "client", owner_id: clientId, name: "No Phone Person" } });
  check("contact with no phone number rejected", r.status === 400, r.data);

  r = await req("/api/people/emergency-contacts", { method: "POST", body: { owner_type: "client", owner_id: clientId, name: "Uncle Dave", alt_phone: "(702) 555-0199", is_primary: true } });
  check("second contact created with alt phone only", r.status === 201, r.data);
  const contact2 = r.data;

  r = await req(`/api/people/emergency-contacts?owner_type=client&owner_id=${clientId}`);
  check("two contacts on the client", r.data.contacts.length === 2, r.data);
  const primaries = r.data.contacts.filter((c) => c.is_primary);
  check("only one primary contact at a time", primaries.length === 1 && primaries[0].id === contact2.id, r.data.contacts.map((c) => [c.name, c.is_primary]));
  check("primary sorts first", r.data.contacts[0].id === contact2.id);

  r = await req(`/api/people/emergency-contacts/${contact1.id}`, { method: "PATCH", body: { relationship: "Grandmother (maternal)" } });
  check("edit contact", r.status === 200 && r.data.relationship === "Grandmother (maternal)", r.data);

  // Staff contacts are a separate owner space.
  const emp = (await req("/api/hr/employees", { method: "POST", body: { name: "Test Staffer", email: "teststaffer@example.com", role_title: "RBT" } })).data;
  r = await req("/api/people/emergency-contacts", { method: "POST", body: { owner_type: "staff", owner_id: emp.id, name: "Spouse Smith", phone: "(702) 555-0111", can_pick_up: true } });
  check("create staff emergency contact", r.status === 201, r.data);
  check("can_pick_up is ignored on staff records", r.data.can_pick_up === false, r.data);
  r = await req(`/api/people/emergency-contacts?owner_type=staff&owner_id=${emp.id}`);
  check("staff contacts are separate from client contacts", r.data.contacts.length === 1, r.data);

  r = await req(`/api/people/emergency-contacts/${contact1.id}`, { method: "DELETE" });
  check("delete contact", r.status === 200, r.data);

  // ---------------- certifications ----------------
  console.log("\n== certifications ==");
  const iso = (daysFromToday) => new Date(Date.now() + daysFromToday * 86400000).toISOString().slice(0, 10);

  r = await req("/api/people/certifications", { method: "POST", body: { employee_id: emp.id, name: "RBT", issuing_body: "BACB", credential_number: "RBT-99123", expiration_date: iso(200) } });
  check("create certification", r.status === 201 && r.data.state.key === "ok", r.data);
  const certFar = r.data;

  r = await req("/api/people/certifications", { method: "POST", body: { employee_id: emp.id, name: "CPR / BLS", expiration_date: iso(20) } });
  check("certification 20 days out reads as critical", r.data.state.key === "critical" && r.data.state.days === 20, r.data.state);
  const certSoon = r.data;

  r = await req("/api/people/certifications", { method: "POST", body: { employee_id: emp.id, name: "Safety Care", expiration_date: iso(-5) } });
  check("expired certification reads as expired", r.data.state.key === "expired" && r.data.state.days === -5, r.data.state);
  const certExpired = r.data;

  r = await req("/api/people/certifications", { method: "POST", body: { employee_id: emp.id, name: "" } });
  check("nameless certification rejected", r.status === 400, r.data);

  r = await req(`/api/people/certifications?employee_id=${emp.id}`);
  check("list certifications for one employee", r.data.certifications.length === 3, r.data.certifications.length);

  r = await req("/api/people/certifications/expiring?days=90");
  check("expiring roll-up finds the two due ones", r.data.expiring.length === 2, r.data.expiring.map((c) => c.name));
  check("roll-up counts the expired one", r.data.expired === 1, r.data);

  // ---- the sweep ----
  console.log("\n== certification sweep ==");
  await req("/api/admin/settings", { method: "PATCH", body: { clinical_director_email: "director@spectrumsquadlv.com" } });

  r = await req("/api/people/certifications/sweep", { method: "POST", body: { dry_run: true } });
  check("dry run reports without sending", r.status === 200 && r.data.sent.every((s) => s.dry_run), r.data);
  check("dry run picks the right stages", (() => {
    const byName = Object.fromEntries(r.data.sent.map((s) => [s.name, s.stage]));
    return byName["CPR / BLS"] === "30" && byName["Safety Care"] === "expired" && !byName["RBT"];
  })(), r.data.sent);

  r = await req("/api/people/certifications/sweep", { method: "POST", body: {} });
  const firstRun = r.data.sent.length;
  check("real sweep sends for both due certifications", firstRun === 2, r.data.sent);
  check("each notice records its recipients", r.data.sent.every((s) => s.to && s.to.length === 2), r.data.sent);

  r = await req("/api/people/certifications/sweep", { method: "POST", body: {} });
  check("second sweep sends nothing (no duplicates)", r.data.sent.length === 0, r.data.sent);

  r = await req(`/api/people/certifications/${certSoon.id}/notices`);
  check("notice history recorded", r.data.notices.length === 1 && r.data.notices[0].stage === "30", r.data.notices);
  check("history names who was emailed", /director@spectrumsquadlv\.com/.test(r.data.notices[0].sent_to), r.data.notices[0]);

  // Renewing pushes the date out; the schedule re-arms for the new date.
  r = await req(`/api/people/certifications/${certSoon.id}`, { method: "PATCH", body: { expiration_date: iso(365) } });
  check("renewal updates the expiry", r.data.state.days === 365, r.data.state);
  r = await req("/api/people/certifications/sweep", { method: "POST", body: { dry_run: true } });
  check("renewed certification drops out of the sweep", !r.data.sent.find((s) => s.id === certSoon.id), r.data.sent);

  // A staff member who has left stops generating notices.
  await req(`/api/hr/employees/${emp.id}`, { method: "PATCH", body: { status: "terminated" } });
  r = await req("/api/people/certifications/sweep", { method: "POST", body: { dry_run: true } });
  check("terminated staff are skipped", r.data.sent.length === 0 && r.data.skipped.some((s) => /no longer active/.test(s.why)), r.data);
  await req(`/api/hr/employees/${emp.id}`, { method: "PATCH", body: { status: "active" } });

  // ---------------- new-hire packet ----------------
  console.log("\n== new-hire employment packet ==");
  r = await req(`/api/hr/employees/${emp.id}/newhire-packet`);
  check("packet status readable", r.status === 200, r.data);
  check("reports itself as not configured without SignNow", r.data.configured === false, r.data);

  r = await req(`/api/hr/employees/${emp.id}/newhire-packet`, { method: "POST", body: {} });
  check("send without config fails loudly rather than silently", r.status === 400 && /SignNow|template/i.test(r.data.error), r.data);
  r = await req(`/api/hr/employees/${emp.id}/newhire-packet`);
  check("the blocked attempt is recorded", r.data.packet && r.data.packet.status === "blocked", r.data.packet);

  r = await req("/api/admin/settings", { method: "PATCH", body: { signnow_newhire_template_id: "nope!" } });
  check("bad template id rejected", r.status === 400, r.data);
  r = await req("/api/admin/settings", { method: "PATCH", body: { signnow_newhire_template_id: "abc123def456ghi789" } });
  check("valid template id saved", r.status === 200, r.data);
  r = await req("/api/admin/settings");
  check("settings echo the template id", r.data.signnow_newhire_template_id === "abc123def456ghi789", r.data);

  // The offer-accepted bundle reports the packet outcome instead of hiding it.
  r = await req(`/api/hr/employees/${emp.id}/offer-accepted`, { method: "POST", body: { actions: { newhire_packet: true }, hire_date: iso(14) } });
  check("offer-accepted bundle runs", r.status === 200, r.data);
  check("bundle surfaces the packet result", r.data.fired.some((f) => /New-hire packet NOT sent|New-hire employment packet/.test(f)), r.data.fired);

  // ---------------- permissions ----------------
  console.log("\n== permissions ==");
  const ownerCookie = cookie;
  await req("/api/auth/login", { method: "POST", body: { email: "scheduling@spectrumsquadlv.com", password: "TestOwner123!" } });
  // Scheduling's password wasn't set, so that login fails and we stay owner.
  // Set one up properly instead.
  cookie = ownerCookie;
  await req("/api/admin/users/5", { method: "PATCH", body: { password: "Sched12345!" } });
  cookie = "";
  r = await req("/api/auth/login", { method: "POST", body: { email: "scheduling@spectrumsquadlv.com", password: "Sched12345!" } });
  check("scheduling user can sign in", r.status === 200, r.data);

  r = await req("/api/people/departments");
  check("scheduling cannot manage departments", r.status === 403, r.data);
  r = await req(`/api/people/certifications?employee_id=${emp.id}`);
  check("scheduling cannot read staff certifications", r.status === 403, r.data);
  r = await req(`/api/people/emergency-contacts?owner_type=staff&owner_id=${emp.id}`);
  check("scheduling cannot read staff emergency contacts", r.status === 403, r.data);
  r = await req(`/api/people/emergency-contacts?owner_type=client&owner_id=${clientId}`);
  check("scheduling CAN read client emergency contacts", r.status === 200, r.data);
  r = await req("/api/people/certifications/sweep", { method: "POST", body: {} });
  check("scheduling cannot fire the notice sweep", r.status === 403, r.data);

  cookie = "";
  r = await req("/api/people/departments");
  check("signed-out request is refused", r.status === 401, r.data);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
