// test-insurance-docs.js -- the eligibility check never goes out card-less,
// and the parent document request files straight onto the client record.
//
//   DATABASE_URL=... node server.js
//   node test-insurance-docs.js
//
// The first half is the rule that matters most here: billing must never
// receive a benefits request with nothing attached, from ANY path -- the
// automatic trigger, the manual button, or a card row whose file has gone
// missing. Each of those is asserted separately because they used to behave
// differently.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Pool } = require("pg");

const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";
// Only needed for the one case that has to reach past the API: deleting a
// stored file to prove a card row with no file behind it still blocks the send.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
  : null;

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

// A 1x1 PNG, so an "insurance card photo" is a real decodable image.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function login(email, password) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("login failed: " + res.status);
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
const anon = async (path, opts = {}) => {
  const r = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => ({})) : await r.text() };
};

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", OWNER_PW);
  const stamp = Date.now().toString().slice(-6);

  // The recipient has to be configured or every send is a no-op for other reasons.
  let r = await owner("/api/admin/settings", { method: "PATCH", body: { eligibility_check_email: `billing.${stamp}@example.invalid` } });
  check("an eligibility recipient is configured", r.status === 200, r.data);

  const mkClient = async (name) => {
    const c = await owner("/api/clients", {
      method: "POST",
      body: { child_name: name, parent_name: "Docs Parent", parent_email: `docs.${stamp}.${name.replace(/\W/g, "")}@example.invalid`, dob: "2019-04-02", insurance_provider: "Test Payer" },
    });
    return c.data.id;
  };
  const eligibilityEmails = async (clientId) => {
    const d = await owner(`/api/clients/${clientId}`);
    return (d.data.notifications || []).filter((n) => n.type === "eligibility_check");
  };

  // ============ 1. the check never goes out without a card ============
  section("1. Benefits & Eligibility Check is never sent card-less");

  const bare = await mkClient("Card Less " + stamp);
  check("created a client with no documents", !!bare, bare);

  let after = await owner(`/api/clients/${bare}`);
  check("no eligibility email was sent at enrollment", (await eligibilityEmails(bare)).length === 0);
  check("the client is not stamped as already sent", !after.data.client.eligibility_check_sent_at, after.data.client.eligibility_check_sent_at);

  r = await owner(`/api/clients/${bare}/eligibility-check`, { method: "POST" });
  check("the manual button refuses when there is no card", r.status === 400 && r.data.code === "no_card", r.data);
  check("the refusal says what to do instead", /Request documents/i.test(r.data.error || ""), r.data.error);
  check("nothing was emailed", (await eligibilityEmails(bare)).length === 0);

  // The bug that made this worse than a no-op: a refused send used to stamp
  // the client, which permanently disabled the automatic one.
  after = await owner(`/api/clients/${bare}`);
  check("a refused send does NOT stamp the client (the automatic send stays armed)",
    !after.data.client.eligibility_check_sent_at, after.data.client.eligibility_check_sent_at);

  // A non-card document must not unlock it either.
  r = await owner(`/api/clients/${bare}/documents`, {
    method: "POST",
    body: { filename: "consent-form.pdf", mime_type: "application/pdf", label: "Signed consent", content_base64: Buffer.from("not a card").toString("base64") },
  });
  check("an unrelated PDF uploads fine", r.status === 201, r.data);
  check("an unrelated PDF does not trigger the eligibility check", (await eligibilityEmails(bare)).length === 0);
  r = await owner(`/api/clients/${bare}/eligibility-check`, { method: "POST" });
  check("and the manual button still refuses", r.status === 400 && r.data.code === "no_card", r.data);

  // ============ 2. uploading the card sends it, automatically ============
  section("2. Uploading the card is what sends it");

  r = await owner(`/api/clients/${bare}/documents`, {
    method: "POST",
    body: { filename: "IMG_4821.jpg", mime_type: "image/jpeg", label: "IMG_4821.jpg", content_base64: PNG_1PX, is_insurance_card: true },
  });
  check("the card uploads", r.status === 201, r.data);
  check("the upload is recorded as the insurance card", r.data.insurance_card === true, r.data);

  const sent = await eligibilityEmails(bare);
  check("the eligibility check fired by itself on upload (this never used to happen from the client card)", sent.length === 1, sent.map((n) => n.subject));
  check("it went to the configured billing contact", sent[0] && sent[0].recipient === `billing.${stamp}@example.invalid`, sent[0] && sent[0].recipient);
  check("the email says the card is attached", sent[0] && /attached to this email/i.test(sent[0].body || ""), (sent[0] || {}).body ? "body present" : "no body");

  after = await owner(`/api/clients/${bare}`);
  check("the client is now stamped as sent", !!after.data.client.eligibility_check_sent_at);
  check("the insurance-card checklist box ticked itself", after.data.client.insurance_card_uploaded === true, after.data.client.insurance_card_uploaded);

  r = await owner(`/api/clients/${bare}/documents`, {
    method: "POST",
    body: { filename: "card-back.jpg", mime_type: "image/jpeg", label: "Insurance card back", content_base64: PNG_1PX, is_insurance_card: true },
  });
  check("a second card image does not re-send the check", (await eligibilityEmails(bare)).length === 1);

  r = await owner(`/api/clients/${bare}/eligibility-check`, { method: "POST" });
  check("with a card on file the manual re-send works", r.status === 200 && r.data.ok, r.data);
  check("and it carried the attachments", r.data.attachments >= 1, r.data.attachments);

  // A diagnosis upload flags the checklist without being mistaken for a card.
  const dxOnly = await mkClient("Dx Only " + stamp);
  r = await owner(`/api/clients/${dxOnly}/documents`, {
    method: "POST",
    body: { filename: "diagnosis-report.pdf", mime_type: "application/pdf", label: "Autism diagnosis report", content_base64: Buffer.from("dx").toString("base64") },
  });
  check("a diagnosis PDF uploads", r.status === 201, r.data);
  after = await owner(`/api/clients/${dxOnly}`);
  check("it ticks the diagnosis checklist box", after.data.client.diagnosis_uploaded === true, after.data.client.diagnosis_uploaded);
  check("it does not count as the insurance card", after.data.client.insurance_card_uploaded !== true, after.data.client.insurance_card_uploaded);
  check("and sends no eligibility check", (await eligibilityEmails(dxOnly)).length === 0);

  // The nastiest case: the record says a card is on file, but the file itself
  // is gone from the volume. The attachment silently comes out empty, and
  // before this the email went anyway.
  const ghost = await mkClient("Ghost Card " + stamp);
  r = await owner(`/api/clients/${ghost}/documents`, {
    method: "POST",
    body: { filename: "card.png", mime_type: "image/png", label: "Insurance card", content_base64: PNG_1PX, is_insurance_card: true },
  });
  check("a card uploads for the missing-file case", r.status === 201, r.data);
  check("and its eligibility check went out normally", (await eligibilityEmails(ghost)).length === 1);
  // Delete the file from the volume behind the record's back -- the row still
  // says "insurance card on file", but there is nothing to attach.
  if (pool) {
    const q = await pool.query("SELECT file_path FROM client_documents WHERE client_id = $1 AND doc_type = 'hosted'", [ghost]);
    for (const row of q.rows) {
      try { fs.unlinkSync(path.join(__dirname, "data", "documents", row.file_path)); } catch (e) {}
    }
    r = await owner(`/api/clients/${ghost}/eligibility-check`, { method: "POST" });
    check("a card whose file is missing blocks the send rather than emailing nothing",
      r.status === 400 && r.data.code === "no_card", r.data);
    check("the refusal says the card could not be read", /could not be read/i.test(r.data.error || ""), r.data.error);
    check("and still nothing more was emailed", (await eligibilityEmails(ghost)).length === 1);
  } else {
    console.log("  SKIP  missing-file case (set DATABASE_URL to run it)");
  }

  // ============ 3. the parent document request ============
  section("3. Requesting the diagnosis and both sides of the card");

  const reqClient = await mkClient("Doc Request " + stamp);

  r = await owner(`/api/client-forms/documents/${reqClient}`);
  check("status reads as not-yet-requested", r.status === 200 && r.data.requested === false, r.data);
  check("it lists the three things we ask for", (r.data.items || []).length === 3, (r.data.items || []).map((i) => i.key));
  check("the three are the diagnosis and both sides of the card",
    JSON.stringify((r.data.items || []).map((i) => i.key)) === JSON.stringify(["diagnosis", "card_front", "card_back"]),
    (r.data.items || []).map((i) => i.key));

  r = await owner("/api/client-forms/documents", { method: "POST", body: { client_id: reqClient } });
  check("the request sends to the parent", r.status === 200 && r.data.ok, r.data);
  check("it emails the parent on file", /@example.invalid$/.test(r.data.sent_to || ""), r.data.sent_to);
  const token = (r.data.link || "").split("token=")[1];
  check("the parent gets a tokenized upload link", !!token && r.data.link.includes("/client-documents/"), r.data.link);

  let comms = await owner(`/api/clients/${reqClient}`);
  const reqEmail = (comms.data.notifications || []).filter((n) => n.type === "document_request");
  check("the request is in the client's communication history", reqEmail.length === 1, reqEmail.map((n) => n.subject));
  check("the email names all three documents",
    reqEmail[0] && /diagnosis/i.test(reqEmail[0].body) && /front/i.test(reqEmail[0].body) && /back/i.test(reqEmail[0].body));

  r = await owner("/api/client-forms/documents", { method: "POST", body: { client_id: reqClient } });
  check("asking again reuses the same link rather than minting a second one",
    r.status === 200 && r.data.link.includes(token), r.data.link);
  check("and is recorded as a resend", r.data.resend === true, r.data);

  // ---- the parent's side, with no login ----
  r = await anon(`/api/client-forms/public/documents?token=${token}`);
  check("the parent can open the link with no account", r.status === 200, r.data);
  check("the page knows which child it is for", r.data.child_name === "Doc Request " + stamp, r.data.child_name);
  check("nothing is received yet", (r.data.items || []).every((i) => !i.received));

  r = await anon(`/api/client-forms/public/documents?token=deadbeef`);
  check("a bogus token is refused", r.status === 404, r.data);

  r = await anon("/api/client-forms/public/documents/upload", {
    method: "POST", body: { token, slot: "diagnosis", filename: "dx.pdf", mime_type: "application/pdf", content_base64: Buffer.from("diagnosis report").toString("base64") },
  });
  check("the parent can upload the diagnosis", r.status === 200 && r.data.ok, r.data);
  check("the request is now partially complete", r.data.status === "partial", r.data);

  let docs = await owner(`/api/clients/${reqClient}`);
  check("it landed on the client's record automatically",
    (docs.data.documents || []).some((d) => d.label === "Official Autism Diagnosis"),
    (docs.data.documents || []).map((d) => d.label));
  check("and ticked the diagnosis checklist box", docs.data.client.diagnosis_uploaded === true);
  check("no eligibility check yet — there is still no card", (await eligibilityEmails(reqClient)).length === 0);

  r = await anon("/api/client-forms/public/documents/upload", {
    method: "POST", body: { token, slot: "card_front", filename: "front.png", mime_type: "image/png", content_base64: PNG_1PX },
  });
  check("the parent can upload the card front", r.status === 200 && r.data.ok, r.data);
  check("the eligibility check went out the moment the card arrived", r.data.eligibility_sent === true, r.data);

  const nowSent = await eligibilityEmails(reqClient);
  check("billing received exactly one benefits request", nowSent.length === 1, nowSent.map((n) => n.subject));
  check("with the card attached, not empty-handed", nowSent[0] && /attached to this email/i.test(nowSent[0].body || ""));

  r = await anon("/api/client-forms/public/documents/upload", {
    method: "POST", body: { token, slot: "card_back", filename: "back.png", mime_type: "image/png", content_base64: PNG_1PX },
  });
  check("the parent can upload the card back", r.status === 200 && r.data.ok, r.data);
  check("the request reads as complete", r.data.status === "complete", r.data);
  check("the card back did not send a second benefits request", (await eligibilityEmails(reqClient)).length === 1);

  r = await anon(`/api/client-forms/public/documents?token=${token}`);
  check("the parent's page shows everything received", r.data.status === "complete" && (r.data.items || []).every((i) => i.received), r.data);

  docs = await owner(`/api/clients/${reqClient}`);
  const labels = (docs.data.documents || []).map((d) => d.label);
  check("all three documents are on the client record", 
    labels.includes("Official Autism Diagnosis") && labels.includes("Insurance Card (front)") && labels.includes("Insurance Card (back)"), labels);
  check("the card images are flagged as the insurance card",
    (docs.data.documents || []).filter((d) => d.is_insurance_card === true).length === 2,
    (docs.data.documents || []).map((d) => [d.label, d.is_insurance_card]));

  r = await owner(`/api/client-forms/documents/${reqClient}`);
  check("staff see the request as complete", r.data.status === "complete", r.data);
  check("staff see each item and when it arrived", (r.data.items || []).every((i) => i.received && i.received_at), r.data.items);

  r = await owner("/api/client-forms/documents", { method: "POST", body: { client_id: reqClient } });
  check("asking a family who has already sent everything is refused", r.status === 409, r.data);

  // ---- guards ----
  section("Guards");

  r = await anon("/api/client-forms/public/documents/upload", {
    method: "POST", body: { token, slot: "not_a_slot", filename: "x.png", mime_type: "image/png", content_base64: PNG_1PX },
  });
  check("an unknown document slot is refused", r.status === 400, r.data);

  r = await anon("/api/client-forms/public/documents/upload", {
    method: "POST", body: { token: "deadbeef", slot: "diagnosis", filename: "x.pdf", mime_type: "application/pdf", content_base64: "eA==" },
  });
  check("uploading against a bogus token is refused", r.status === 404, r.data);

  r = await anon("/api/client-forms/public/documents/upload", {
    method: "POST", body: { token, slot: "diagnosis", filename: "x.pdf", mime_type: "application/pdf" },
  });
  check("an upload with no file is refused", r.status === 400, r.data);

  r = await anon("/api/client-forms/documents", { method: "POST", body: { client_id: reqClient } });
  check("a signed-out request to email a family is refused", r.status === 401, r.data);

  r = await owner("/api/client-forms/documents", { method: "POST", body: { client_id: 99999999 } });
  check("requesting documents for an unknown client is a clean 404", r.status === 404, r.data);

  const noEmail = await owner("/api/clients", { method: "POST", body: { child_name: "No Email " + stamp } });
  r = await owner("/api/client-forms/documents", { method: "POST", body: { client_id: noEmail.data.id } });
  check("a family with no email address is refused with a clear reason", r.status === 400 && /no parent email/i.test(r.data.error || ""), r.data);

  const page = await anon("/client-documents/?token=" + token);
  check("the public upload page is served", typeof page.data === "string" && /Upload Documents/i.test(page.data), String(page.data).slice(0, 120));

  // Every parent-facing page in client-forms.js is generated as one big string,
  // so a stray quote does not fail the build -- it ships, and the parent gets a
  // page stuck on "Loading…" with the error only in their console. Parsing the
  // scripts of each served page is the cheapest way to notice.
  section("Generated parent pages actually parse");
  for (const [label, url] of [
    ["the document upload page", "/client-documents/?token=" + token],
    ["the financial responsibility form", "/financial-form/?token=x"],
    ["the schedule request form", "/schedule-request/?token=x"],
  ]) {
    const res = await anon(url);
    const html = String(res.data || "");
    const blocks = html.match(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g) || [];
    let broken = null;
    for (const b of blocks) {
      const body = b.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
      try { new vm.Script(body); } catch (e) { broken = e.message; break; }
    }
    check(`${label} has no JavaScript syntax errors`, blocks.length > 0 && !broken, broken || "no script blocks found");
  }

  if (pool) await pool.end().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
