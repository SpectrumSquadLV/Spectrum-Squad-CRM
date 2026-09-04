// Anybody in the Hub can put a form in the library.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-bcba-forms-contrib.js
//
// Asked for as "I need the option to add files to the BCBA hub to show up on
// all ends not just mine". Adding a form and MAINTAINING the library were one
// permission, so the button existed on one person's screen -- and the BCBA who
// is actually handed a payer's new packet had to forward it to somebody.
//
// The library is blank forms, not PHI, so widening WHO MAY ADD is cheap. What
// is not cheap is the other half, and that is what most of this suite is about:
//
//   * A FORM CODE IS NOT A LABEL. It is what makes a file the answer to a
//     requirement on every BCBA's screen -- name FA-11F and the cheat sheet
//     links there. A contributor setting one would be quietly deciding what
//     their colleagues submit, so the field is dropped from their upload.
//   * REPLACING THE FILE UNDER AN EXISTING FORM is the same attack with no
//     visible change at all: same name, same description, different document.
//     It stays with admins.
//   * EDITING OR ARCHIVING SOMEBODY ELSE'S FORM changes what a colleague
//     already relies on.
//   * WITHDRAWING YOUR OWN has to exist, or "I just uploaded the wrong file"
//     is a state with no way out of it.
//   * AND IT HAS TO ACTUALLY REACH THE OTHER SCREENS, which is the whole
//     request: a form added by one person and visible only to them is the bug
//     being fixed, not the fix.
"use strict";
const { Pool } = require("pg");

const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else {
    fail++;
    const line = "  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 320) : "");
    failures.push(line);
    console.log(line);
  }
};
// The runner keeps only the tail of a suite's output, so a failure forty
// assertions up would otherwise never be seen.
const replay = () => { if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); } };

function client() {
  let jar = "";
  const send = async (path, { method = "GET", body, raw, type } = {}) => {
    const headers = { ...(jar ? { Cookie: jar } : {}) };
    if (raw !== undefined) headers["Content-Type"] = type || "application/octet-stream";
    else if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) jar = sc.split(";")[0];
    const ct = res.headers.get("content-type") || "";
    let data = null, text = null;
    if (ct.includes("json")) { data = await res.json().catch(() => null); }
    else { text = await res.text().catch(() => null); }
    return { status: res.status, data, text, type: ct };
  };
  send.login = (email, password) => send("/api/auth/login", { method: "POST", body: { email, password } });
  // The library takes the file as the raw body with its metadata on the query
  // string -- there is no multipart parser in this codebase.
  send.upload = (meta, contents) => {
    const qs = new URLSearchParams(meta).toString();
    return send("/api/bcba/forms?" + qs, { method: "POST", raw: Buffer.from(contents) });
  };
  return send;
}

const listFor = async (who) => ((await who("/api/bcba/forms")).data || {}).forms || [];
const findByName = async (who, name) => (await listFor(who)).find((f) => f.name === name) || null;

(async () => {
  const owner = client(), bcba = client(), bcba2 = client(), billing = client(), intake = client();

  check("owner signs in", (await owner.login("admin@spectrumsquadlv.com", "TestOwner123!")).status === 200);
  check("a BCBA signs in", (await bcba.login("clinical@spectrumsquadlv.com", "TestStaff123!")).status === 200);
  check("billing signs in", (await billing.login("billing@spectrumsquadlv.com", "TestStaff123!")).status === 200);
  check("intake signs in", (await intake.login("intake@spectrumsquadlv.com", "TestStaff123!")).status === 200);
  // A SECOND BCBA, so "it reaches the other screens" is tested against somebody
  // who is neither the uploader nor an admin.
  await pool.query("UPDATE users SET role = 'clinical' WHERE lower(email) = lower('scheduling@spectrumsquadlv.com')");
  check("a second BCBA signs in", (await bcba2.login("scheduling@spectrumsquadlv.com", "TestOwner123!")).status === 200);

  console.log("\n== Who is offered it ==");
  const asBcba = (await bcba("/api/bcba/forms")).data;
  check("A BCBA IS OFFERED THE OPTION TO ADD ONE", asBcba.can_add === true, asBcba.can_add);
  check("and is still not offered the library's controls",
    asBcba.can_manage === false, asBcba.can_manage);
  check("billing is offered it too -- they submit the authorization request",
    (await billing("/api/bcba/forms")).data.can_add === true);
  check("the owner still is", (await owner("/api/bcba/forms")).data.can_add === true);
  check("SOMEBODY WITH NO HUB ACCESS IS NOT",
    (await intake("/api/bcba/forms")).status === 403, (await intake("/api/bcba/forms")).status);
  check("the cheat sheet says so as well, since that is where the tab lives",
    (await bcba("/api/bcba/cheatsheet")).data.can_add_forms === true);

  console.log("\n== A BCBA adds one ==");
  const NAME = "Zz Parent Consent (added by a BCBA)";
  const BODY = "%PDF-1.4 pretend consent form\n";
  const added = await bcba.upload({
    name: NAME, description: "Uploaded during the contribution test.",
    category: "parent", filename: "zz-consent.pdf", mime: "application/pdf",
  }, BODY);
  check("the upload is accepted", added.status === 201, added.data);
  const form = added.data && added.data.form;
  check("it comes back with an id and a file", !!form && !!form.id && form.has_file === true, form);
  check("credited to the person who added it", !!form && /clinical@/.test(form.uploaded_by || ""), form && form.uploaded_by);
  check("and marked as theirs, so they are offered the way back", !!form && form.mine === true, form);

  console.log("\n== IT SHOWS UP ON ALL ENDS -- the whole request ==");
  const forOther = await findByName(bcba2, NAME);
  check("ANOTHER BCBA SEES IT", !!forOther, (await listFor(bcba2)).map((f) => f.name).slice(0, 8));
  check("and it is not marked as theirs", !!forOther && forOther.mine === false, forOther && forOther.mine);
  check("billing sees it", !!(await findByName(billing, NAME)));
  check("the owner sees it", !!(await findByName(owner, NAME)));
  const dl = await bcba2("/api/bcba/forms/" + form.id + "/file");
  check("AND THE FILE ACTUALLY DOWNLOADS FOR THEM -- a row with no file is not a form",
    dl.status === 200, dl.status);
  check("with the contents that were uploaded", (dl.text || "").includes("pretend consent form"),
    (dl.text || "").slice(0, 60));

  console.log("\n== What a contributor may not decide ==");
  // Naming a form code answers a cheat sheet requirement with a file of your
  // choosing, on every BCBA's screen.
  const coded = await bcba.upload({
    name: "Zz Tried To Claim A Code", category: "payer", form_code: "FA-11F",
    filename: "zz.pdf", mime: "application/pdf",
  }, "not the real FA-11F");
  check("an upload naming a form code is still accepted", coded.status === 201, coded.data);
  check("BUT THE CODE IS DROPPED, not honoured",
    coded.data.form.form_code === null, coded.data.form.form_code);
  const stillOurs = await pool.query(
    "SELECT form_code FROM bcba_forms WHERE name = 'Zz Tried To Claim A Code'");
  check("and nothing reached the column either",
    stillOurs.rows.every((r) => !r.form_code), stillOurs.rows);
  const ownerCoded = await owner.upload({
    name: "Zz Admin May Set A Code", category: "payer", form_code: "FA-99Z",
    filename: "zz.pdf", mime: "application/pdf",
  }, "admin upload");
  check("AN ADMIN STILL CAN -- the field was gated, not removed",
    ownerCoded.data.form.form_code === "FA-99Z", ownerCoded.data.form.form_code);

  console.log("\n== And may not touch what is already there ==");
  const target = (await findByName(owner, "Zz Admin May Set A Code")).id;
  const edit = await bcba("/api/bcba/forms/" + target, { method: "PATCH", body: { name: "Zz Renamed By A BCBA" } });
  check("A BCBA CANNOT RENAME SOMEBODY ELSE'S FORM", edit.status === 403, edit.status);
  const replace = await bcba("/api/bcba/forms/" + target + "/file?filename=x.pdf&mime=application/pdf",
    { method: "POST", raw: Buffer.from("swapped underneath") });
  check("NOR SWAP THE FILE UNDER IT -- same name, different document, no sign of it",
    replace.status === 403, replace.status);
  const arch = await bcba("/api/bcba/forms/" + target, { method: "PATCH", body: { archived: true } });
  check("nor archive it", arch.status === 403, arch.status);
  const del = await bcba("/api/bcba/forms/" + target, { method: "DELETE" });
  check("nor delete it", del.status === 403, del.status);
  const stolen = await bcba2("/api/bcba/forms/" + form.id + "/withdraw", { method: "POST" });
  check("AND CANNOT WITHDRAW A FORM THAT IS NOT THEIRS", stolen.status === 403, stolen.data);
  const intruder = await intake("/api/bcba/forms/" + form.id + "/withdraw", { method: "POST" });
  check("somebody with no Hub access cannot either", intruder.status === 403, intruder.status);

  const untouched = await findByName(owner, "Zz Admin May Set A Code");
  check("NOT ONE OF THOSE CHANGED ANYTHING", !!untouched && untouched.archived === false, untouched);
  const bytes = await owner("/api/bcba/forms/" + target + "/file");
  check("and the file underneath is the one the admin uploaded",
    (bytes.text || "").includes("admin upload"), (bytes.text || "").slice(0, 40));

  console.log("\n== Taking your own back ==");
  const mine = await bcba("/api/bcba/forms/" + form.id + "/withdraw", { method: "POST" });
  check("a contributor can withdraw their own", mine.status === 200, mine.data);
  check("it is gone from the library for everybody", !(await findByName(bcba2, NAME)));
  check("including for them", !(await findByName(bcba, NAME)));
  const row = (await pool.query("SELECT archived_at, stored_name FROM bcba_forms WHERE id = $1", [form.id])).rows[0];
  check("IT IS ARCHIVED, NOT DELETED -- the record of it having existed is kept",
    !!row && !!row.archived_at, row);
  check("and the file is still there to be restored", !!row && !!row.stored_name, row);
  const restored = await owner("/api/bcba/forms/" + form.id, { method: "PATCH", body: { archived: false } });
  check("an admin can put it back", restored.status === 200, restored.data);
  check("and it is on everyone's screen again", !!(await findByName(bcba2, NAME)));

  console.log("\n== Rubbish in ==");
  const noName = await bcba.upload({ filename: "x.pdf", mime: "application/pdf" }, "x");
  check("a form with no name is refused", noName.status === 400, noName.data);
  const empty = await bcba.upload({ name: "Zz Empty", filename: "x.pdf", mime: "application/pdf" }, "");
  check("an empty upload is refused rather than stored as a form with no file",
    empty.status === 400, empty.data);
  const ghost = await bcba("/api/bcba/forms/999999/withdraw", { method: "POST" });
  check("withdrawing a form that does not exist is a 404, not a crash", ghost.status === 404, ghost.status);

  replay();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
