// Care team assignments, and the authorized-hours figure beside them.
//
// TWO BUGS AND ONE FEATURE, all of which fail the same quiet way: a screen that
// states something false about a client, which is worse than one that says
// nothing.
//
// 1. AUTHORIZED HOURS READ THE WRONG TABLE. The client scheduling summary asked
//    client_financial_forms -- the parent-facing copay form -- for
//    authorized_hours_per_week, a column that lives on
//    client_financial_settings and has never existed on the form. Postgres
//    said "column does not exist" every single time, a .catch turned that into
//    null, and the endpoint reported "not on file" for EVERY client, including
//    the ones whose hours were filled in and visible two screens away.
//
// 2. THE STUDENT ANALYST COULD NOT BE SET. The Care team panel displayed the
//    field and no endpoint wrote it: it was reachable only from the bulk
//    assignment migration. Correcting one child meant migrating everybody.
//
// 3. ASSIGNING A BCBA REQUIRED THE INSURANCE RECORD. It was an AUTH_FIELD, so
//    "let her reassign clinicians" could not be answered without also handing
//    over the payer, the dates and the notes. Now it is a grantable capability
//    that carries four fields and nothing else -- and the test that matters
//    most here is that the grant does NOT unlock the authorization record.
//
// Run: DATABASE_URL=... node run-tests.js test-care-team-grant.js

"use strict";
const BASE = process.env.BASE || "http://localhost:3009";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    console.log("  FAIL  " + name + (detail !== undefined
      ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : ""));
  }
};

// A tiny cookie-jar client, one per signed-in person.
function client() {
  let jar = "";
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(jar ? { Cookie: jar } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
    const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (setC && setC.length) jar = setC.map((c) => c.split(";")[0]).join("; ");
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    return { status: r.status, body };
  };
}

// GET /api/clients/:id answers { client, tasks, sessions, ... } -- the record
// is NESTED. Reading the top level instead returns undefined for every field,
// which makes an assertion pass for the wrong reason, so it goes through here.
const clientOf = (r) => (r && r.body && r.body.client) || {};

const login = async (email, password) => {
  const c = client();
  const r = await c("/api/auth/login", { method: "POST", body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return c;
};

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", "TestOwner123!");
  // The scheduling role stands in for the real case: somebody who may see
  // clients but has never been allowed near the insurance record.
  const sched = await login("scheduling@spectrumsquadlv.com", "TestOwner123!");

  const made = await owner("/api/clients", {
    method: "POST",
    body: { parent_name: "CTG Parent", child_name: "CTG Child", parent_email: "ctg@example.invalid" },
  });
  const id = made.body && made.body.id;
  check("a client to work with", !!id, made.body);

  // ---------------- open by default -------------------------------------
  console.log("\n-- who may change the care team --");
  {
    // The care team NAMES are already readable by everyone with client access.
    // Correcting one therefore needs no grant: making people ask permission to
    // fix what they can already see just leaves the wrong name on the record.
    const r = await sched("/api/clients/" + id + "/care-team", {
      method: "PATCH", body: { assigned_bcba_name: "Set By Scheduling" },
    });
    check("anyone who can open a client record may fix the assignment",
      r.status === 200 && r.body.assigned_bcba_name === "Set By Scheduling", r);
  }

  const users = await owner("/api/admin/users");
  const rows = Array.isArray(users.body) ? users.body : (users.body && (users.body.users || users.body.data)) || [];
  const schedUser = rows.find((u) => String(u.email).startsWith("scheduling"));
  check("the scheduling account is visible to the owner", !!schedUser, users.body);

  const brene = sched;
  {
    const r = await brene("/api/clients/" + id + "/care-team", {
      method: "PATCH",
      body: {
        assigned_bcba_name: "Granted BCBA",
        assigned_bcba_email: "Granted.BCBA@Spectrumsquadlv.COM",
        assigned_student_analyst_name: "Granted Analyst",
        assigned_student_analyst_email: "analyst@spectrumsquadlv.com",
      },
    });
    check("the BCBA can be assigned", r.status === 200 && r.body.assigned_bcba_name === "Granted BCBA", r);
    check("the STUDENT ANALYST can be assigned at last",
      r.body && r.body.assigned_student_analyst_name === "Granted Analyst", r.body);
    check("an email is stored lower-cased, so two spellings are one person",
      r.body && r.body.assigned_bcba_email === "granted.bcba@spectrumsquadlv.com", r.body);
  }

  // ---------------- the grant's edges ----------------------------------
  console.log("\n-- what the grant does NOT open --");
  {
    const r = await brene("/api/clients/" + id + "/authorization", {
      method: "PATCH", body: { insurance_payer: "Sneaky Payer" },
    });
    check("the care-team grant does not unlock the insurance record", r.status === 403, r);

    const seen = clientOf(await brene("/api/clients/" + id));
    check("and it does not reveal the payer either",
      seen.insurance_payer === undefined || seen.insurance_payer === null, seen.insurance_payer);
  }
  {
    const r = await brene("/api/clients/" + id + "/care-team", {
      method: "PATCH", body: { squad_leader_name: "Not Mine To Set", stage: "discharged" },
    });
    check("fields outside the care team are not writable through it", r.status === 400, r);
    const after = clientOf(await owner("/api/clients/" + id));
    check("and nothing outside the care team changed",
      !!after.stage && after.stage !== "discharged", after.stage);
  }
  {
    const r = await brene("/api/clients/" + id + "/care-team", {
      method: "PATCH", body: { assigned_bcba_email: "not-an-email" },
    });
    check("a malformed email is refused rather than stored", r.status === 400, r);
  }

  // ---------------- the boundary that still holds ------------------------
  // "Anyone can edit the assignment" means anyone who may open the child's
  // record. HR-side roles may not, and no default and no toggle changes that:
  // this is the gate that protects the file itself, not a convenience.
  console.log("\n-- 'anyone' still stops at the client-access line --");
  {
    const made = await owner("/api/admin/users", {
      method: "POST",
      body: { name: "CTG HR", email: "ctg.hr@example.invalid", password: "TestStaff123!", role: "hr_admin" },
    });
    check("an HR-side account can be created for the test", made.status === 200 || made.status === 201, made);

    const hr = await login("ctg.hr@example.invalid", "TestStaff123!");
    const r = await hr("/api/clients/" + id + "/care-team", {
      method: "PATCH", body: { assigned_bcba_name: "HR Should Not Reach This" },
    });
    check("an HR role cannot touch the care team, default or not", r.status === 403, r);

    // And the same account explicitly switched ON must still be refused --
    // a capability toggle can widen an edit, never open a child's file.
    const hrUsers = await owner("/api/admin/users");
    const hrRows = Array.isArray(hrUsers.body) ? hrUsers.body : (hrUsers.body && (hrUsers.body.users || hrUsers.body.data)) || [];
    const hrUser = hrRows.find((u) => String(u.email) === "ctg.hr@example.invalid");
    await owner("/api/admin/users/" + hrUser.id, { method: "PATCH", body: { module_access: { "care-team": true } } });
    const hr2 = await login("ctg.hr@example.invalid", "TestStaff123!");
    const r2 = await hr2("/api/clients/" + id + "/care-team", {
      method: "PATCH", body: { assigned_bcba_name: "Still Not Allowed" },
    });
    check("switching it ON for an HR role does NOT open a child's record", r2.status === 403, r2);

    const after = clientOf(await owner("/api/clients/" + id));
    check("and the assignment is untouched by either attempt",
      after.assigned_bcba_name !== "HR Should Not Reach This" && after.assigned_bcba_name !== "Still Not Allowed",
      after.assigned_bcba_name);
  }

  // ---------------- clearing --------------------------------------------
  console.log("\n-- unassigning --");
  {
    const r = await brene("/api/clients/" + id + "/care-team", {
      method: "PATCH", body: { assigned_student_analyst_name: "   " },
    });
    check("a blank name unassigns rather than storing an empty string",
      r.status === 200 && r.body.assigned_student_analyst_name === null, r.body);
  }

  // ---------------- revoking --------------------------------------------
  // On by default is not the same as impossible to take away: an explicit
  // "Off" against care-team in the Access editor still closes it for one
  // person, server-side and not merely in the UI.
  console.log("\n-- taking it away from one person --");
  {
    const off = await owner("/api/admin/users/" + schedUser.id, {
      method: "PATCH", body: { module_access: { "care-team": false } },
    });
    check("the owner can switch the capability off for one person", off.status === 200, off);

    const revoked = await login("scheduling@spectrumsquadlv.com", "TestOwner123!");
    const r = await revoked("/api/clients/" + id + "/care-team", {
      method: "PATCH", body: { assigned_bcba_name: "After Revoke" },
    });
    check("an explicit Off closes the door at the server, not just the screen", r.status === 403, r);
    const after = clientOf(await owner("/api/clients/" + id));
    check("the assignment made before the revoke survives it",
      after.assigned_bcba_name === "Granted BCBA", after.assigned_bcba_name);

    // Back to the default so the rest of the suite sees the normal world.
    await owner("/api/admin/users/" + schedUser.id, { method: "PATCH", body: { module_access: {} } });
  }

  // ---------------- the owner never needed the grant --------------------
  {
    const r = await owner("/api/clients/" + id + "/care-team", {
      method: "PATCH", body: { assigned_bcba_name: "Owner Set" },
    });
    check("an owner can always set the care team, grant or no grant",
      r.status === 200 && r.body.assigned_bcba_name === "Owner Set", r);
  }

  // ---------------- authorized hours ------------------------------------
  // The regression that matters: this read used to name client_financial_forms,
  // which has no such column, so the answer was null for everybody.
  console.log("\n-- authorized hours come back at all --");
  {
    const before = await owner("/api/sched/client/" + id + "/summary");
    check("with nothing on file the summary says null, not zero",
      before.status === 200 && before.body.authorized_hours === null, before.body);

    const set = await owner("/api/clients/" + id + "/financial-settings", {
      method: "PATCH", body: { authorized_hours_per_week: 20 },
    });
    check("authorized hours can be set", set.status === 200, set);

    const after = await owner("/api/sched/client/" + id + "/summary");
    check("the summary now REPORTS those hours instead of 'not on file'",
      after.body && after.body.authorized_hours === 20, after.body);
    check("and the unscheduled figure is worked out from them",
      after.body && after.body.unscheduled_hours === 20, after.body);
  }

  // ---------------- the capability is grantable but not a page ----------
  console.log("\n-- the Access editor --");
  {
    const html = await fetch(BASE + "/").then((r) => r.text());
    check("care-team is offered in the Access editor", /"care-team":\s*\{\s*label/.test(html));
    check("it is marked a capability, so it never becomes a sidebar button",
      /"care-team":[^}]*capability:\s*true/.test(html));
    check("the nav loop honours that flag", /if \(m\.capability\) return;/.test(html));
    check("the client-side gate mirrors the server's", /function canEditCareTeam\(\)/.test(html));
    check("and it is open by default rather than requiring a grant",
      /function canEditCareTeam\(\)[\s\S]{0,260}!canAccessClients\(\)/.test(html));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
