// Photographs on an SOP.
//
// A procedure written in prose often cannot say what a photograph says in one
// glance -- which cupboard, which switch, what "set up correctly" looks like.
// So each photo carries a STEP REFERENCE as well as a caption, which is the
// difference between documentation and a gallery at the end.
//
// Three things here are not cosmetic:
//
//   * AN UNPUBLISHED RECORD'S PHOTOS ARE NOT PUBLIC. The image route checks
//     the PARENT record's published flag, the same test the public page
//     applies to the text, so the two can never disagree. A draft SOP's
//     photographs are no more public than its words.
//   * ONLY IMAGES. The route serves uploaded bytes straight back to a
//     browser, so the type is an allow-list. Serving whatever arrives is how
//     a photo upload becomes a way to host anything at all.
//   * UPLOADING IS EDITING. It follows canPolicyEdit, not the operational
//     tier -- a photo in a procedure is part of the procedure.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-sop-photos.js
"use strict";
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const stamp = Date.now().toString(36);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 320) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let cookie = "";
  const f = async (p, { method = "GET", body, raw } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    if (raw) return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"),
                      bytes: Buffer.from(await r.arrayBuffer()) };
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
  return f;
}

// A real 1x1 PNG, so the bytes that come back can be compared to the bytes
// that went in rather than to a placeholder.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

(async () => {
  const owner = client();
  const staff = client();
  const admin = client();   // operational admin: runs the library, may not edit it
  const anon = client();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST",
    body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("a BCBA signs in", (await staff("/api/auth/login", { method: "POST",
    body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);
  // THE ACCOUNT THAT ACTUALLY TESTS THE LINE. A BCBA fails both tiers, so
  // using only one cannot tell canPolicyEdit from canPolicyManage. An admin
  // passes the operational tier and must still be refused: a photo in a
  // procedure is part of the procedure, and policy editing is locked to
  // executive leadership.
  await pool.query("UPDATE users SET role = 'admin' WHERE email = 'scheduling@spectrumsquadlv.com'");
  check("an operational admin signs in", (await admin("/api/auth/login", { method: "POST",
    body: { email: "scheduling@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("and they really do hold the operational tier",
    (await admin("/api/policies/acknowledgments")).status === 200);

  const sop = (await owner("/api/policies", { method: "POST", body: {
    title: `Cleaning the Sensory Room ${stamp}`, doc_kind: "sop", category: "Clinical SOPs",
    body: "1. Clear the mats.\n2. Wipe every surface.\n3. Return the equipment to the labelled shelf.",
  } })).data;
  check("an SOP exists to illustrate", !!sop.id, sop);

  // ==================================================================
  section("Uploading");
  const body64 = PNG_1PX.toString("base64");
  check("a BCBA cannot add a photo", (await staff("/api/policies/" + sop.id + "/photos", { method: "POST",
    body: { data_base64: body64, mime_type: "image/png", filename: "x.png" } })).status === 403);
  check("AND NEITHER CAN AN OPERATIONAL ADMIN — uploading a photo is editing the SOP",
    (await admin("/api/policies/" + sop.id + "/photos", { method: "POST",
      body: { data_base64: body64, mime_type: "image/png", filename: "x.png" } })).status === 403);

  const up = await owner("/api/policies/" + sop.id + "/photos", { method: "POST", body: {
    data_base64: body64, mime_type: "image/png", filename: "shelf.png",
    step_ref: "Step 3", caption: "The labelled shelf, correctly stocked." } });
  check("the owner can", up.status === 201, up.data);
  const photoId = up.data && up.data.id;

  check("a photo with no file is refused",
    (await owner("/api/policies/" + sop.id + "/photos", { method: "POST", body: { mime_type: "image/png" } })).status === 400);
  // The allow-list. These bytes are served straight back to a browser.
  for (const bad of ["application/pdf", "text/html", "image/svg+xml", "application/octet-stream", ""]) {
    check(`"${bad || "(none)"}" is refused — only real image types are served back`,
      (await owner("/api/policies/" + sop.id + "/photos", { method: "POST", body: {
        data_base64: body64, mime_type: bad, filename: "x" } })).status === 400);
  }
  check("a photo on a record that does not exist is refused",
    (await owner("/api/policies/999999/photos", { method: "POST", body: {
      data_base64: body64, mime_type: "image/png" } })).status === 404);

  // ==================================================================
  section("Reading it back");
  const listed = await owner("/api/policies/" + sop.id + "/photos");
  check("the photo is listed", (listed.data.photos || []).length === 1, listed.data);
  const ph = listed.data.photos[0];
  check("THE STEP IT BELONGS TO IS KEPT — this is what makes it documentation",
    ph.step_ref === "Step 3", ph);
  check("and the caption", /labelled shelf/.test(ph.caption || ""), ph);

  const img = await owner("/api/policies/photo/" + photoId, { raw: true });
  check("the image serves", img.status === 200, img.status);
  check("AS THE BYTES THAT WERE UPLOADED", Buffer.compare(img.bytes, PNG_1PX) === 0,
    { got: img.bytes.length, want: PNG_1PX.length });
  check("with its real content type", /image\/png/.test(img.type || ""), img.type);
  check("and cached hard, since a stored photo is never rewritten in place",
    /immutable/.test(img.cache || ""), img.cache);

  const lib = await owner("/api/policies/library");
  const row = (lib.data.policies || []).filter((p) => p.id === sop.id)[0] || {};
  check("the library carries the photo metadata so the reader can show it",
    (row.photos || []).length === 1 && row.photos[0].step_ref === "Step 3", row.photos);
  check("BUT NOT THE BYTES — a library of illustrated SOPs must not drag megabytes through one list call",
    !JSON.stringify(row.photos).includes(body64.slice(0, 40)), "image data found in the library payload");
  check("a BCBA sees the photos too — reading an SOP is everybody's job",
    (((await staff("/api/policies/library")).data.policies || [])
      .filter((p) => p.id === sop.id)[0] || {}).photos.length === 1);

  // ==================================================================
  section("AN UNPUBLISHED RECORD'S PHOTOS ARE NOT PUBLIC");
  // Unpublished EXPLICITLY. crm_policies.published defaults to TRUE, so a
  // record is public the moment it is created -- asserting against a fresh
  // one would have tested nothing and passed for the wrong reason.
  await pool.query("UPDATE crm_policies SET published = FALSE WHERE id = $1", [sop.id]);
  const pub0 = await anon("/api/policies/photo/" + photoId, { raw: true });
  check("while the SOP is unpublished, the image needs a session", pub0.status === 401, pub0.status);
  check("and its record is not on the public list either",
    (await anon("/api/policies/public/" + sop.slug)).status === 404);
  await pool.query("UPDATE crm_policies SET published = TRUE WHERE id = $1", [sop.id]);
  const pub1 = await anon("/api/policies/photo/" + photoId, { raw: true });
  check("once published, the QR page can load it with no sign-in", pub1.status === 200, pub1.status);
  check("and it is the same image", Buffer.compare(pub1.bytes, PNG_1PX) === 0);
  await pool.query("UPDATE crm_policies SET published = FALSE WHERE id = $1", [sop.id]);
  check("UNPUBLISHING TAKES THE PHOTO BACK OUT OF PUBLIC VIEW, because the check is on the record",
    (await anon("/api/policies/photo/" + photoId, { raw: true })).status === 401);
  await pool.query("UPDATE crm_policies SET published = TRUE WHERE id = $1", [sop.id]);

  const pubRec = await anon("/api/policies/public/" + sop.slug);
  check("the public record lists its photos", (pubRec.data.photos || []).length === 1, pubRec.data.photos);
  check("by id and caption only — no file paths leak to the open page",
    !JSON.stringify(pubRec.data.photos).includes("stored_name") &&
    !/[0-9a-f]{32}/.test(JSON.stringify(pubRec.data.photos)), pubRec.data.photos);

  // ==================================================================
  section("Editing and removing");
  check("an operational admin cannot re-caption it either",
    (await admin("/api/policies/photos/" + photoId, { method: "PATCH", body: { caption: "x" } })).status === 403);
  check("nor delete it",
    (await admin("/api/policies/photos/" + photoId, { method: "DELETE" })).status === 403);
  check("a BCBA cannot re-caption it",
    (await staff("/api/policies/photos/" + photoId, { method: "PATCH", body: { caption: "x" } })).status === 403);
  check("the owner can", (await owner("/api/policies/photos/" + photoId, { method: "PATCH", body: {
    step_ref: "Step 4", caption: "Updated." } })).status === 200);
  check("and it takes",
    ((await owner("/api/policies/" + sop.id + "/photos")).data.photos[0] || {}).step_ref === "Step 4");

  check("adding a photo is on the record's revision history",
    (await pool.query("SELECT summary FROM crm_policy_revisions WHERE policy_id = $1", [sop.id]))
      .rows.some((r) => /Photo added/i.test(r.summary || "")));

  check("a BCBA cannot delete it",
    (await staff("/api/policies/photos/" + photoId, { method: "DELETE" })).status === 403);
  const storedBefore = (await pool.query("SELECT stored_name FROM crm_policy_photos WHERE id = $1", [photoId])).rows[0];
  check("the owner can", (await owner("/api/policies/photos/" + photoId, { method: "DELETE" })).status === 200);
  check("the row is gone",
    (await pool.query("SELECT id FROM crm_policy_photos WHERE id = $1", [photoId])).rows.length === 0);
  check("AND THE FILE IS GONE FROM DISK, not just the row",
    !require("fs").existsSync(require("path").join(__dirname, "data", "policy-photos", storedBefore.stored_name)),
    storedBefore.stored_name);
  check("a deleted photo no longer serves",
    (await owner("/api/policies/photo/" + photoId, { raw: true })).status === 404);
  check("and the removal is on the revision history",
    (await pool.query("SELECT summary FROM crm_policy_revisions WHERE policy_id = $1", [sop.id]))
      .rows.some((r) => /Photo removed/i.test(r.summary || "")));

  // ==================================================================
  section("It did not disturb the document attachments");
  // The existing attachment path links a record to a DOCUMENT in the library,
  // and that uploader refuses anything whose text does not read as prose --
  // which is exactly why a photo needed its own door rather than a hole cut
  // in that one.
  const rejected = await owner("/api/policies/documents", { method: "POST", body: {
    filename: "photo.png", content_base64: body64 } });
  check("THE DOCUMENT UPLOADER STILL REFUSES AN IMAGE, as it should",
    rejected.status === 400, rejected.data);
  check("so the prose guard on the policy library is untouched",
    /PDF|Word|plain text|readable/i.test((rejected.data || {}).error || ""), rejected.data);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
