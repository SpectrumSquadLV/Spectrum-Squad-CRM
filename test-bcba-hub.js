// The BCBA Hub: payer requirements and the Form Library.
//
// THE RULE THIS SUITE EXISTS TO DEFEND. The cheat sheet is the source of truth
// and payers differ on purpose. The failure that would matter is not a broken
// page -- it is a page that quietly shows a BCBA the WRONG PAYER'S
// REQUIREMENTS, or invents one, because that produces a plan that gets denied
// and nobody can see why from the screen.
//
// So the assertions are weighted toward what must NOT happen:
//   * No payer's requirement list is another payer's.
//   * Molina, whose components the cheat sheet leaves empty, stays empty.
//   * A payer with no reviewer hot buttons is given none.
//   * Counts are pinned, so an edit to the data file that adds or drops a
//     requirement has to be deliberate.
//
// The Form Library half is about custody of files: who may change them, that a
// download is the bytes that were uploaded, that a replace keeps the same form
// (and therefore the cheat sheet's link to it), that deleting is refused until
// a form is archived, and that an upload cannot write outside its directory.
//
//   node test-bcba-hub.js
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const BASE = process.env.BASE || "http://localhost:3009";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + String(JSON.stringify(detail)).slice(0, 400) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");
const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");

function makeClient() {
  let cookies = {};
  return {
    async req(p, { method = "GET", body, rawBody, headers = {}, binary = false } = {}) {
      const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(BASE + p, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(jar ? { Cookie: jar } : {}),
          ...headers,
        },
        body: rawBody !== undefined ? rawBody : (body ? JSON.stringify(body) : undefined),
        redirect: "manual",
      });
      for (const sc of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [pair] = sc.split(";");
        const i = pair.indexOf("=");
        if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
      if (binary) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { status: res.status, buffer: buf, headers: res.headers };
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      return { status: res.status, data, text, headers: res.headers };
    },
  };
}
async function login(email, password) {
  const c = makeClient();
  const r = await c.req("/api/auth/login", { method: "POST", body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${r.text.slice(0, 120)}`);
  return c;
}

(async () => {
  // ================= the data is the document ===========================
  section("The cheat sheet data keeps the payers apart");
  const DATA = require("./bcba-cheatsheet-data.js");
  const byName = (n) => DATA.payers.find((p) => p.name === n);
  const itemCount = (p) => p.sections.reduce((n, s) => n + s.items.filter((i) => i.kind === "item").length, 0);

  check("every payer in the cheat sheet is present",
    DATA.payers.length === 7, DATA.payers.map((p) => p.name));
  check("and they are the payers the document names",
    ["NV Medicaid", "CareSource", "Aetna", "TRICARE", "Anthem BCBS", "SilverSummit", "Molina"]
      .every(byName), DATA.payers.map((p) => p.name));

  // Pinned counts. Not decoration: an accidental edit to the data file that
  // dropped or duplicated a requirement would otherwise pass every other test
  // here, and a BCBA would be reading a plan requirement that is not the
  // payer's.
  const PINNED = {
    "NV Medicaid": 20, "CareSource": 101, "Aetna": 147,
    "TRICARE": 128, "Anthem BCBS": 12, "SilverSummit": 66, "Molina": 0,
  };
  Object.keys(PINNED).forEach((n) => {
    check(`${n} carries its ${PINNED[n]} requirements, no more and no fewer`,
      byName(n) && itemCount(byName(n)) === PINNED[n], byName(n) && itemCount(byName(n)));
  });

  // THE ONE THAT MATTERS MOST. The document has no treatment plan components
  // for Molina. An empty section is the honest answer; filling it from a payer
  // that does have them would look completely plausible on screen.
  const molina = byName("Molina");
  check("MOLINA'S COMPONENTS STAY EMPTY, because the cheat sheet has none",
    molina.sections.length === 0 && itemCount(molina) === 0, molina.sections);
  check("but Molina keeps the quick-reference the document does give it",
    molina.assessment_units.length === 1 && /16 Units/.test(molina.assessment_units[0]),
    molina.assessment_units);

  // No two payers share a requirement list. Payers legitimately share
  // individual requirement WORDING ("Baseline data"), so this compares the
  // whole set: two identical sets would mean one was copied over the other.
  const sig = (p) => JSON.stringify(p.sections.map((s) => s.items.map((i) => i.text)));
  const seen = new Map();
  let collision = null;
  for (const p of DATA.payers) {
    if (!itemCount(p)) continue;
    const k = sig(p);
    if (seen.has(k)) collision = [seen.get(k), p.name];
    seen.set(k, p.name);
  }
  check("NO PAYER'S REQUIREMENTS ARE ANOTHER PAYER'S", collision === null, collision);

  // Hot buttons exist for exactly the three payers whose sheet has them.
  const withHot = DATA.payers.filter((p) => p.hot_buttons).map((p) => p.name).sort();
  check("only the payers whose sheet lists reviewer hot buttons have them",
    JSON.stringify(withHot) === JSON.stringify(["Aetna", "SilverSummit", "TRICARE"]), withHot);
  check("and the others are given none rather than generic advice",
    DATA.payers.filter((p) => !p.hot_buttons).length === 4);

  // Reauthorization grouping.
  check("Aetna's reauthorization sub-sections are grouped under reauthorization",
    ["Progress", "If Progress Is Limited", "Parent Training", "Continued Medical Necessity"]
      .every((t) => (byName("Aetna").sections.find((s) => s.title === t) || {}).group === "reauth"),
    byName("Aetna").sections.filter((s) => s.group === "reauth").map((s) => s.title));
  check("Aetna's plan sections are not swept in with them",
    byName("Aetna").sections.find((s) => s.title === "Member Information").group === "plan");
  check("NV Medicaid's one reauthorization-only requirement is flagged on the item",
    byName("NV Medicaid").sections[0].items.some((i) => i.reauth_only && /previous authorization/i.test(i.text)));
  check("and it is the only one flagged there",
    byName("NV Medicaid").sections[0].items.filter((i) => i.reauth_only).length === 1);

  // Wrapped lines were rejoined rather than shown as two half requirements.
  check("a requirement wrapped across two lines in Word is one requirement",
    byName("Anthem BCBS").required_documents.some((t) => /Certification for Requesting Initial Applied Behavior Analysis \(ABA\) Services/.test(t)),
    byName("Anthem BCBS").required_documents);
  check("and no requirement is left as a dangling fragment",
    !DATA.payers.some((p) => p.sections.some((s) => s.items.some((i) => /^(is occurring|preventing generalization|Analysis \(ABA\))/.test(i.text)))));

  // ================= who can see it =====================================
  section("The hub is reference material, gated on clinical and admin roles");
  const owner = await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const clinical = await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  const billing = await login("billing@spectrumsquadlv.com", "TestStaff123!");
  const intake = await login("intake@spectrumsquadlv.com", "TestStaff123!");
  const scheduling = await login("scheduling@spectrumsquadlv.com", "TestOwner123!");

  check("a BCBA can read the cheat sheet", (await clinical.req("/api/bcba/cheatsheet")).status === 200);
  check("billing can too, because they submit the authorization",
    (await billing.req("/api/bcba/cheatsheet")).status === 200);
  check("an owner can", (await owner.req("/api/bcba/cheatsheet")).status === 200);
  check("intake cannot", (await intake.req("/api/bcba/cheatsheet")).status === 403);
  check("scheduling cannot", (await scheduling.req("/api/bcba/cheatsheet")).status === 403);
  check("and the refusal is enforced on the API, not by hiding the tab",
    /if \(!canView\(user\)\) \{ json\(res, 403/.test(read("bcba-hub.js")));

  const cs = await owner.req("/api/bcba/cheatsheet");
  check("the API serves every payer", (cs.data.payers || []).length === 7);
  check("a BCBA is not offered form management", !(await clinical.req("/api/bcba/forms")).data.can_manage);
  check("an owner is", (await owner.req("/api/bcba/forms")).data.can_manage === true);

  // ================= the form library ===================================
  section("The Form Library is maintained without touching the CRM");
  const bytes = crypto.randomBytes(2048);
  const up = async (client, qs, body) => client.req("/api/bcba/forms?" + qs, {
    method: "POST", rawBody: body, headers: { "Content-Type": "application/octet-stream" },
  });

  // A BCBA MAY ADD ONE. Asked for as "the option to add files ... on all ends
  // not just mine": the person handed a payer's new packet is the one holding
  // the file. What they may not do is decide what it ANSWERS -- a form code
  // wires a file into the cheat sheet on every BCBA's screen -- so the code is
  // dropped rather than the upload being refused. test-bcba-forms-contrib.js
  // covers the rest of that boundary.
  const byBcba = await up(clinical, "name=Zz+From+A+BCBA&form_code=FA-11F&filename=x.pdf&mime=application/pdf", bytes);
  check("A BCBA CAN UPLOAD A FORM", byBcba.status === 201, byBcba.status);
  check("but does not get to say which requirement it answers",
    byBcba.data.form.form_code === null, byBcba.data.form.form_code);
  const deniedIntake = await up(intake, "name=Sneaky&filename=x.pdf", bytes);
  check("and someone with no hub access still cannot upload at all", deniedIntake.status === 403, deniedIntake.status);
  // Put the library back as the rest of this suite expects to find it.
  await clinical.req("/api/bcba/forms/" + byBcba.data.form.id + "/withdraw", { method: "POST" });

  const created = await up(owner,
    "name=" + encodeURIComponent("FA-11F ASD Diagnosis Certification") +
    "&description=" + encodeURIComponent("Nevada certification form.") +
    "&category=payer&payer_key=nv-medicaid&form_code=FA-11F&filename=fa11f.pdf&mime=application/pdf",
    bytes);
  check("an owner can add a form", created.status === 201, created.data);
  const formId = created.data && created.data.form && created.data.form.id;
  check("it is filed under the category and payer chosen",
    created.data.form.category === "payer" && created.data.form.payer_name === "NV Medicaid", created.data.form);
  check("a PDF is offered a Print action", created.data.form.can_print === true);

  const dl = await owner.req("/api/bcba/forms/" + formId + "/file", { binary: true });
  check("DOWNLOADING RETURNS THE BYTES THAT WERE UPLOADED",
    dl.status === 200 && Buffer.compare(dl.buffer, bytes) === 0,
    dl.status + " " + (dl.buffer ? dl.buffer.length : 0) + " vs " + bytes.length);
  check("and it comes back as an attachment with its own filename",
    /attachment; filename="fa11f.pdf"/.test(dl.headers.get("content-disposition") || ""),
    dl.headers.get("content-disposition"));
  const inline = await owner.req("/api/bcba/forms/" + formId + "/file?disposition=inline", { binary: true });
  check("asking for it inline is what makes Print work",
    /^inline/.test(inline.headers.get("content-disposition") || ""), inline.headers.get("content-disposition"));
  check("a BCBA can download it — that is the point of the library",
    (await clinical.req("/api/bcba/forms/" + formId + "/file", { binary: true })).status === 200);

  // ---- the link back to the cheat sheet
  section("A required form links to the one copy in the library");
  const linked = await owner.req("/api/bcba/cheatsheet");
  const nv = linked.data.payers.find((p) => p.name === "NV Medicaid");
  const fa11f = nv.required_documents.find((d) => /FA-11F/.test(d.text));
  check("NV Medicaid's FA-11F requirement now carries the uploaded form",
    fa11f && fa11f.form && fa11f.form.id === formId, fa11f);
  const fa11e = nv.required_documents.find((d) => /FA-11E/.test(d.text));
  check("but FA-11E, which nobody uploaded, links to nothing",
    fa11e && fa11e.form === null, fa11e);
  const aetna = linked.data.payers.find((p) => p.name === "Aetna");
  check("and a payer whose documents never name that form gets no link",
    aetna.required_documents.every((d) => d.form === null), aetna.required_documents);
  check("the form is not copied into the cheat sheet data",
    !/form_code|bcba_forms/.test(read("bcba-cheatsheet-data.js")));

  // ---- replace, archive, delete
  section("Maintaining a form keeps its identity and its history");
  const newBytes = crypto.randomBytes(1024);
  const replaced = await owner.req("/api/bcba/forms/" + formId + "/file?filename=fa11f-2027.pdf&mime=application/pdf", {
    method: "POST", rawBody: newBytes, headers: { "Content-Type": "application/octet-stream" },
  });
  check("a reissued form replaces the file in place", replaced.status === 200, replaced.data);
  check("the form keeps its id, so the cheat sheet link still points at it",
    replaced.data.form.id === formId);
  const after = await owner.req("/api/bcba/forms/" + formId + "/file", { binary: true });
  check("and the download is now the new file",
    Buffer.compare(after.buffer, newBytes) === 0);

  const earlyDelete = await owner.req("/api/bcba/forms/" + formId, { method: "DELETE" });
  check("DELETING A LIVE FORM IS REFUSED — archive it first",
    earlyDelete.status === 400, earlyDelete.data);
  const stillThere = await owner.req("/api/bcba/forms/" + formId + "/file", { binary: true });
  check("so the file is still there after the refused delete", stillThere.status === 200);

  await owner.req("/api/bcba/forms/" + formId, { method: "PATCH", body: { archived: true } });
  const listed = await owner.req("/api/bcba/forms");
  check("an archived form drops off the library list",
    !(listed.data.forms || []).some((f) => f.id === formId));
  const withArchived = await owner.req("/api/bcba/forms?archived=1");
  check("but an admin can still see it, so nothing is lost",
    (withArchived.data.forms || []).some((f) => f.id === formId));
  const archivedLink = await owner.req("/api/bcba/cheatsheet");
  const nv2 = archivedLink.data.payers.find((p) => p.name === "NV Medicaid");
  check("and an archived form stops being offered from the cheat sheet",
    nv2.required_documents.every((d) => d.form === null), nv2.required_documents);
  await owner.req("/api/bcba/forms/" + formId, { method: "PATCH", body: { archived: false } });
  check("restoring it brings it back", (await owner.req("/api/bcba/forms")).data.forms.some((f) => f.id === formId));

  const nonAdminPatch = await clinical.req("/api/bcba/forms/" + formId, { method: "PATCH", body: { name: "Renamed" } });
  check("a BCBA cannot rename a form", nonAdminPatch.status === 403, nonAdminPatch.status);
  const nonAdminDelete = await clinical.req("/api/bcba/forms/" + formId, { method: "DELETE" });
  check("nor delete one", nonAdminDelete.status === 403, nonAdminDelete.status);

  // ================= the refusals =======================================
  section("What an upload refuses to do");
  const noName = await up(owner, "filename=x.pdf", bytes);
  check("a form with no name is refused", noName.status === 400, noName.data);
  const empty = await up(owner, "name=Empty&filename=x.pdf", Buffer.alloc(0));
  check("an empty upload is refused rather than filed as a form", empty.status === 400, empty.data);

  // A filename is data, not a path. The stored name is generated, so a
  // traversal attempt cannot put a file outside the forms directory.
  const evil = await up(owner, "name=Traversal&filename=" + encodeURIComponent("../../../server.js") + "&mime=text/plain", bytes);
  check("a filename that tries to climb out of the directory is stored safely",
    evil.status === 201, evil.data);
  check("server.js was not overwritten by it",
    /module\.exports|require\(/.test(read("server.js")) && read("server.js").length > 100000);
  check("the stored name is generated here rather than taken from the upload",
    /storedNameFor\(/.test(read("bcba-hub.js")) && /form_\$\{id\}_\$\{Date\.now\(\)\}/.test(read("bcba-hub.js")));

  const badCat = await up(owner, "name=Odd&category=nonsense&filename=x.pdf", bytes);
  check("an unknown category falls back to Other rather than being stored",
    badCat.data.form.category === "other", badCat.data.form);
  const badPayer = await up(owner, "name=Odd2&payer_key=blue-cross-of-narnia&filename=x.pdf", bytes);
  check("a payer key that is not in the cheat sheet is not stored",
    badPayer.data.form.payer_key === null, badPayer.data.form);

  // ================= no client data =====================================
  section("Nothing about a client goes through here");
  const src = read("bcba-hub.js");
  check("the module never reads the clients table", !/FROM clients|clients\b.*SELECT/i.test(src));
  check("it stores no checklist state, because the checklist is a review aid",
    !/CREATE TABLE[^;]*(checklist|readiness)/i.test(src));
  check("the checklist lives in the browser only",
    /localStorage/.test(read("bcba-hub-frontend.js")) &&
    !/api\/bcba\/(checklist|progress)/.test(read("bcba-hub-frontend.js")));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
