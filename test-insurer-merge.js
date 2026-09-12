// test-insurer-merge.js -- the same payer filed under more than one name.
//
// insurance_provider is free text, typed by whoever took the enrolment, so one
// payer ends up on file as "BCBS", "Blue Cross" and "Blue Cross Blue Shield".
// Every screen that groups by that string then shows the payer three times
// with its families split between the thirds.
//
// THE RULE THIS SUITE HOLDS: nothing merges on its own. "Aetna" and "Aetna
// Better Health" are different contracts, and a family moved onto the wrong one
// is a claim sent to the wrong place. The CRM may say which pairs look like the
// same name typed twice; it may never decide that two names are one payer.
//
//   DATABASE_URL=... node server.js
//   node test-insurer-merge.js
"use strict";

const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    const d = detail === undefined ? "" : "\n          -> " +
      String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400);
    console.log("  FAIL  " + name + d);
  }
};
const section = (t) => console.log("\n== " + t + " ==");

async function login(email, password) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("login failed for " + email + ": " + res.status);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => ({})) : await r.text() };
  };
}

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", OWNER_PW);
  const stamp = Date.now().toString().slice(-6);

  // Three spellings of one payer, and a fourth that only LOOKS related.
  const NAMES = {
    plain:  `Zed Health ${stamp}`,
    caps:   `ZED HEALTH ${stamp}`,
    spaced: `Zed  Health ${stamp}`,
    other:  `Zed Health Better ${stamp}`,
  };
  const made = [];
  const mk = async (label, provider) => {
    const r = await owner("/api/clients", {
      method: "POST",
      body: {
        child_name: `Ins ${label} ${stamp}`, parent_name: `Parent ${label}`,
        parent_email: `ins.${label}.${stamp}@example.invalid`, parent_phone: "7025550000",
        insurance_provider: provider,
      },
    });
    const id = r.data && (r.data.id || (r.data.client && r.data.client.id));
    if (!id) throw new Error(`could not create ${label}: ${JSON.stringify(r.data)}`);
    made.push(id);
    return id;
  };
  await mk("a", NAMES.plain);
  await mk("b", NAMES.plain);
  await mk("c", NAMES.caps);
  await mk("d", NAMES.spaced);
  await mk("e", NAMES.other);

  section("What is on file, and what merely looks the same");

  let r = await owner("/api/insurers");
  check("the insurer list loads", r.status === 200 && Array.isArray(r.data.insurers), r.status);
  const find = (n) => (r.data.insurers || []).find((x) => x.name === n);
  check("every spelling is listed separately, because that is the truth on file",
    !!find(NAMES.plain) && !!find(NAMES.caps) && !!find(NAMES.spaced), (r.data.insurers || []).slice(0, 8));
  check("...with the client count on each",
    find(NAMES.plain).clients === 2 && find(NAMES.caps).clients === 1, {
      plain: find(NAMES.plain), caps: find(NAMES.caps) });

  const group = (r.data.likely || []).find((g) => g.keep === NAMES.plain);
  check("the capitals-and-spacing variants are flagged as likely the same",
    !!group, r.data.likely);
  check("...keeping the spelling most clients already carry",
    group && group.keep === NAMES.plain, group);
  check("...and naming the ones that would fold into it",
    group && group.merge.length === 2
      && group.merge.includes(NAMES.caps) && group.merge.includes(NAMES.spaced), group);

  // THE IMPORTANT NEGATIVE. A different payer with a similar name is never
  // proposed, because no rule can tell "Aetna" from "Aetna Better Health".
  check("a DIFFERENT payer with a similar name is never proposed",
    !(r.data.likely || []).some((g) =>
      g.keep === NAMES.other || (g.merge || []).includes(NAMES.other)), r.data.likely);

  section("Merging is something a person does");

  r = await owner("/api/insurers/merge", { method: "POST", body: { from: NAMES.caps, to: NAMES.plain } });
  check("a merge moves the clients", r.status === 200 && r.data.moved === 1, r.data);
  check("...and says how many are on the surviving name now", r.data.now_on === 3, r.data);

  r = await owner("/api/insurers");
  check("the merged spelling is gone from the list", !(r.data.insurers || []).some((x) => x.name === NAMES.caps),
    (r.data.insurers || []).map((x) => x.name).slice(0, 10));
  check("...and its clients are on the surviving one",
    (r.data.insurers.find((x) => x.name === NAMES.plain) || {}).clients === 3,
    r.data.insurers.find((x) => x.name === NAMES.plain));
  check("the unrelated payer is untouched",
    (r.data.insurers.find((x) => x.name === NAMES.other) || {}).clients === 1,
    r.data.insurers.find((x) => x.name === NAMES.other));

  section("The refusals");

  r = await owner("/api/insurers/merge", { method: "POST", body: { from: NAMES.plain, to: NAMES.plain } });
  check("merging a name into itself is refused", r.status === 400, r.data);
  r = await owner("/api/insurers/merge", { method: "POST", body: { from: "", to: NAMES.plain } });
  check("a blank name is refused", r.status === 400, r.data);
  r = await owner("/api/insurers/merge", { method: "POST", body: { from: `Nobody ${stamp}`, to: NAMES.plain } });
  check("a name no client carries is refused, rather than silently doing nothing",
    r.status === 404, r.data);

  section("Who may merge");

  const mkUser = async (label, role) => {
    const email = `insm.${label}.${stamp}@example.invalid`;
    const c = await owner("/api/admin/users", {
      method: "POST", body: { name: `InsM ${label}`, email, password: "InsMerge123!", role },
    });
    if (c.status !== 201) throw new Error(`${label}: ${JSON.stringify(c.data)}`);
    return await login(email, "InsMerge123!");
  };

  // Clinical staff read client records, so they see the list. Rewriting the
  // payer on a pile of records at once is leadership's.
  const clinical = await mkUser("clinical", "clinical");
  r = await clinical("/api/insurers");
  check("a clinical user can see the insurer list", r.status === 200, r.status);
  r = await clinical("/api/insurers/merge", { method: "POST", body: { from: NAMES.spaced, to: NAMES.plain } });
  check("...but cannot merge", r.status === 403, r.data);

  const hrAdmin = await mkUser("hr", "hr_admin");
  r = await hrAdmin("/api/insurers");
  check("somebody with no client access cannot even see the list", r.status === 403, r.status);

  r = await owner("/api/insurers");
  check("and nothing moved while those were being refused",
    (r.data.insurers.find((x) => x.name === NAMES.spaced) || {}).clients === 1,
    r.data.insurers.find((x) => x.name === NAMES.spaced));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", (e && e.stack) || e); process.exit(1); });
