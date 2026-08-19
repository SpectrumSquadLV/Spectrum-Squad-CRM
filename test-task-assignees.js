// Assigning a task to your actual staff.
//
// The picker used to read the `users` table -- CRM login accounts. Most of the
// team has a staff record and no login, so they simply were not in the list:
// you could not assign work to the people who do the work. Worse, the due-date
// reminder joined through users too, so even if a name got typed in, nobody
// was emailed.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
  };

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const api = (path, opts) => page.evaluate(async ({ p, o }) => {
    const r = await fetch(p, {
      method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: o && o.body ? JSON.stringify(o.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { p: path, o: opts });

  // A staff member with no CRM login -- the case that was invisible.
  const stamp = String(await page.evaluate(() => Date.now()));
  const employeeName = "Roster Only " + stamp.slice(-5);
  const employeeEmail = `roster.only.${stamp.slice(-5)}@example.invalid`;
  const made = await api("/api/hr/employees", {
    method: "POST",
    body: { name: employeeName, email: employeeEmail, role_title: "RBT", status: "active" },
  });
  check("created a staff member with no login", made.status === 200 || made.status === 201, JSON.stringify(made).slice(0, 200));

  // ---------------- 1. the roster reaches the picker ----------------
  const staff = await api("/api/staff");
  const list = Array.isArray(staff.body) ? staff.body : [];
  check("the staff list answers", staff.status === 200 && list.length > 0, JSON.stringify(staff).slice(0, 200));

  const logins = list.filter((s) => s.has_login);
  const rosterOnly = list.filter((s) => !s.has_login);
  check("login accounts are still listed", logins.length > 0, JSON.stringify(logins.map((s) => s.name)));
  check("staff without a login are listed too", rosterOnly.some((s) => s.name === employeeName),
    JSON.stringify(list.map((s) => `${s.name}:${s.has_login ? "login" : "roster"}`)));

  const rosterEntry = list.find((s) => s.name === employeeName);
  check("someone without a login has no user id to submit", rosterEntry && rosterEntry.id === null, JSON.stringify(rosterEntry));
  check("but does carry an email to reach them on", rosterEntry && rosterEntry.email === employeeEmail, JSON.stringify(rosterEntry));

  // Nobody appears twice: a person with both a login and a staff record is one
  // entry, and keeps the login so their reminders and "my tasks" still work.
  // Two rows for the same name are not merged -- that would risk assigning work
  // to the wrong person -- but they must be tellable apart in the dropdown.
  const labels = list.map((s) => (s.label || s.name || "").toLowerCase());
  check("every entry is distinguishable in the list", new Set(labels).size === labels.length, JSON.stringify(labels));

  // ---------------- 2. the dropdown actually shows them ----------------
  await page.evaluate(() => { location.hash = "#/tasks"; });
  await page.waitForFunction(() => !!document.querySelector("#stask-assignee"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(900);
  const options = await page.evaluate(() =>
    [...document.querySelectorAll("#stask-assignee option")].map((o) => o.textContent.trim())
  );
  check("the Assign to dropdown lists them", options.some((o) => o.startsWith(employeeName)), JSON.stringify(options));
  check("the dropdown separates login from roster-only", await page.evaluate(() =>
    document.querySelectorAll("#stask-assignee optgroup").length === 2));

  // ---------------- 3. assigning to them works end to end ----------------
  const title = "Reminder wiring check " + stamp.slice(-5);
  await page.evaluate(({ name }) => {
    const sel = document.querySelector("#stask-assignee");
    const opt = [...sel.options].find((o) => o.textContent.trim().startsWith(name));
    sel.value = opt.value;
  }, { name: employeeName });
  await page.fill("#stask-title", title);
  await page.click("#stask-add");
  await page.waitForTimeout(2200);

  const tasks = await api("/api/staff-tasks");
  const mine = (Array.isArray(tasks.body) ? tasks.body : []).find((t) => t.title === title);
  check("the task was created", !!mine, JSON.stringify(tasks.body).slice(0, 200));
  check("it is assigned to the right person by name", mine && mine.assigned_name === employeeName, mine && mine.assigned_name);
  check("their email is stored on the task", mine && mine.assigned_email === employeeEmail, mine && mine.assigned_email);
  check("no bogus user id was invented", mine && !mine.assigned_user_id, mine && String(mine.assigned_user_id));

  // The assignment email must have gone somewhere real.
  const outbox = await api("/api/notifications");
  const sent = (Array.isArray(outbox.body) ? outbox.body : [])
    .filter((n) => n.type === "staff_task_assigned" && (n.recipient || "").includes(employeeEmail.split("@")[0]));
  check("they were emailed about it, login or not", sent.length >= 1,
    JSON.stringify((Array.isArray(outbox.body) ? outbox.body : []).slice(0, 3).map((n) => n.type + ":" + n.recipient)));

  // ---------------- 4. assigning to a login account still works ----------
  const loginPerson = logins[0];
  const title2 = "Login assignee check " + stamp.slice(-5);
  await page.evaluate(({ name }) => {
    const sel = document.querySelector("#stask-assignee");
    const opt = [...sel.options].find((o) => o.textContent.trim().startsWith(name));
    sel.value = opt.value;
  }, { name: loginPerson.name });
  await page.fill("#stask-title", title2);
  await page.click("#stask-add");
  await page.waitForTimeout(2200);

  const tasks2 = await api("/api/staff-tasks");
  const t2 = (Array.isArray(tasks2.body) ? tasks2.body : []).find((t) => t.title === title2);
  check("a login account still gets the real user id", t2 && Number(t2.assigned_user_id) === Number(loginPerson.id),
    t2 && `${t2.assigned_user_id} vs ${loginPerson.id}`);
  check("and is named on the task", t2 && t2.assigned_name === loginPerson.name, t2 && t2.assigned_name);

  // ---------------- 5. tidy up ----------------
  for (const t of [mine, t2]) {
    if (t) await api(`/api/staff-tasks/${t.id}`, { method: "DELETE" });
  }

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
