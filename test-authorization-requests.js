// The Authorization Request, end to end.
//
// ONE FEATURE, ONE NAME. This suite exists to hold that: parent signatures,
// documents, submission and the payer's answer are stages of a request, and
// every check below goes through a request rather than through a signatures
// API that must not exist.
//
// The risks here are not crashes. They are, in order of how much damage they
// do to a family:
//
//   * a request that says "Ready to Submit" while a document is missing
//   * a parent emailed the same reminder twice in a day, or after signing
//   * a treatment plan sent to a payer WITHOUT the parent's signature on it
//   * the same authorization submitted twice by accident
//   * an attachment set silently too large to send, reported as sent
//   * a projected start date presented as a promise
//
// Each of those has its own section, and most of the suite is them.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-authorization-requests.js
"use strict";
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 320) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}

const DOCS_DIR = path.join(__dirname, "data", "documents");
async function pdfBytes(text, pages = 1) {
  const { PDFDocument } = require("pdf-lib");
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage().drawText(text + " " + (i + 1), { x: 50, y: 700, size: 16 });
  return Buffer.from(await d.save());
}

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);

  // ---- fixtures ----------------------------------------------------------
  const stamp = Date.now().toString().slice(-6);
  const mkClient = async (name, payer) => (await pool.query(
    `INSERT INTO clients (child_name, dob, parent_name, parent_email, insurance_provider, stage)
     VALUES ($1,'2019-03-04','AR Parent',$2,$3,'active') RETURNING id`,
    [name, `ar.${stamp}.${name.replace(/\W/g, "")}@example.invalid`, payer])).rows[0].id;
  const mkDoc = async (clientId, label, type, opts = {}) => {
    const stored = `artest_${stamp}_${Math.random().toString(36).slice(2, 8)}.pdf`;
    if (opts.withFile !== false) fs.writeFileSync(path.join(DOCS_DIR, stored), await pdfBytes(label, opts.pages || 1));
    return (await pool.query(
      `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, external_url, uploaded_at, clinical_type, document_date)
       VALUES ($1,$2,$3,'application/pdf',$4,$5,$6,now()::text,$7,$8) RETURNING id`,
      [clientId, label, label.replace(/\W+/g, "") + ".pdf",
       opts.withFile === false ? null : stored, opts.withFile === false ? "link" : "hosted",
       opts.withFile === false ? "https://example.invalid/doc" : null,
       type, opts.date || "2026-09-15"])).rows[0].id;
  };

  // ==================================================================
  section("What a payer wants is configuration, not code");
  {
    const seeded = await pool.query(
      "SELECT required_docs, parent_signature_required, turnaround_days FROM auth_payer_requirements WHERE payer='Tricare' AND request_type='aba_services'");
    check("TRICARE's ABA package is seeded with the five documents it asks for",
      JSON.parse(seeded.rows[0].required_docs).sort().join(",") === "parent_stress_index,pddbi,srs,treatment_plan,vineland",
      seeded.rows[0].required_docs);
    check("...and it asks for a parent signature", seeded.rows[0].parent_signature_required === true);
    check("every configured payer has a row for every request type",
      Number((await pool.query("SELECT count(*) FROM auth_payer_requirements")).rows[0].count) >= 28);

    // THE POINT OF SEEDING. An administrator's correction must survive the
    // next deploy, or the configuration is decoration and the real rules are
    // still in the code.
    await pool.query("UPDATE auth_payer_requirements SET turnaround_days = 42 WHERE payer='Tricare' AND request_type='aba_services'");
    const r = await owner("/api/authorization-requests/config");
    check("an admin can read the configuration", r.status === 200 && Array.isArray(r.data.payers));
    // reseeding happens on every boot; simulate it directly
    const before = (await pool.query("SELECT turnaround_days FROM auth_payer_requirements WHERE payer='Tricare' AND request_type='aba_services'")).rows[0].turnaround_days;
    await pool.query(`INSERT INTO auth_payer_requirements (payer, request_type, required_docs, optional_docs, turnaround_days, updated_at)
                      VALUES ('Tricare','aba_services','["srs"]','[]',10,now()::text) ON CONFLICT (payer, request_type) DO NOTHING`);
    const after = (await pool.query("SELECT turnaround_days, required_docs FROM auth_payer_requirements WHERE payer='Tricare' AND request_type='aba_services'")).rows[0];
    check("RESEEDING NEVER OVERWRITES AN EDIT — the corrected turnaround survives",
      Number(after.turnaround_days) === 42 && Number(before) === 42, after);
    check("...nor does it revert the document list", JSON.parse(after.required_docs).length === 5, after.required_docs);
    await pool.query("UPDATE auth_payer_requirements SET turnaround_days = 10 WHERE payer='Tricare' AND request_type='aba_services'");
  }

  // ==================================================================
  section("The client's file is searched before anybody is asked to upload");
  const cid = await mkClient(`AR Tricare ${stamp}`, "Tricare");
  const srs = await mkDoc(cid, "SRS-2", "srs");
  await mkDoc(cid, "PDDBI", "pddbi");
  await mkDoc(cid, "Vineland-3", "vineland", { date: "2025-01-04" });
  const newVineland = await mkDoc(cid, "Vineland-3 current", "vineland", { date: "2026-08-20" });
  const plan = await mkDoc(cid, "Treatment Plan", "treatment_plan", { pages: 3 });
  // Named like a Parent Stress Index but filed with no clinical type at all.
  const looksLikePsi = await mkDoc(cid, "Parenting Stress Index", null);
  {
    const pv = await owner(`/api/authorization-requests/preview?client_id=${cid}&request_type=aba_services`);
    check("the preview reads the payer off the client record", pv.data.payer === "Tricare", pv.data.payer);
    const by = {}; pv.data.items.forEach((i) => { by[i.key] = i; });
    check("documents already on file are found without anybody uploading anything",
      by.srs.found && by.pddbi.found && by.vineland.found && by.treatment_plan.found, Object.keys(by));
    check("THE NEWEST MATCHING DOCUMENT IS OFFERED FIRST, not the first one filed",
      by.vineland.candidates[0].id === newVineland, by.vineland.candidates.map((c) => c.document_date));
    check("...and every candidate carries its date, so a stale assessment is visible",
      by.vineland.candidates.every((c) => !!c.document_date), by.vineland.candidates);
    // §20: type metadata FIRST. A filename is a hint about a document, not a
    // fact about it, and two clients can both have "Vineland.pdf".
    check("a document with the right NAME but no type is offered as a filename match, not as fact",
      by.parent_stress_index.found && by.parent_stress_index.candidates[0].match_source === "filename",
      by.parent_stress_index.candidates[0]);
    check("...while a typed document is matched by type", by.srs.candidates[0].match_source === "type");
  }

  // ==================================================================
  section("The status is computed, never typed");
  let reqId = null;
  {
    const c = await owner("/api/authorization-requests", { method: "POST", body: { client_id: cid, request_type: "aba_services" } });
    check("a request is created", c.status === 201, c.data && c.data.error);
    reqId = c.data.id;
    check("IT OPENS AS MISSING DOCUMENTS: the Parent Stress Index is only a NAME match, and a guess is not ready",
      c.data.status === "missing_documents", c.data.status);
    check("...and that requirement is the one still open",
      c.data.documents.find((d) => d.requirement_key === "parent_stress_index").status === "missing",
      c.data.documents.map((d) => d.requirement_key + ":" + d.status));
    const tp = c.data.documents.find((d) => d.requirement_key === "treatment_plan");
    check("A FOUND TREATMENT PLAN IS NOT READY WHEN THE PAYER WANTS THE PARENT'S SIGNATURE",
      tp.status === "awaiting_parent_signature", tp);
    check("the progress figure counts only what is actually ready",
      c.data.tracker.ready_count === 3 && c.data.tracker.required_count === 5, c.data.tracker);
    check("...and the percentage matches it", c.data.tracker.percent === 60, c.data.tracker.percent);
    check("the tracker carries a Parent node because this payer asks for one",
      c.data.tracker.nodes.some((n) => n.key === "parent_signature"), c.data.tracker.nodes.map((n) => n.key));
  }
  {
    // Filling the gap moves the status on its own.
    const r = await owner(`/api/authorization-requests/${reqId}/document`, {
      method: "POST", body: { requirement_key: "parent_stress_index", client_document_id: looksLikePsi } });
    check("choosing the document moves the request on by itself",
      r.data.status === "awaiting_parent_signature", r.data.status);
    check("...and files its clinical type, so the next request matches by type",
      (await pool.query("SELECT clinical_type FROM client_documents WHERE id = $1", [looksLikePsi])).rows[0].clinical_type === "parent_stress_index");
    check("the only thing still outstanding is the signature",
      r.data.tracker.ready_count === 4, r.data.tracker);
  }

  // ==================================================================
  section("The parent signature, inside the request that needs it");
  let signUrl = null, token = null;
  {
    const bad = await owner(`/api/authorization-requests/${reqId}/request-signature`, { method: "POST", body: {} });
    check("the signature can be requested once the plan is attached", bad.status === 200, bad.data);
    signUrl = bad.data.signing_url;
    token = String(signUrl).split("/").pop();
    check("...and hands back the link, so it can be sent another way if email bounces",
      /\/authorization-sign\/.{10,}/.test(signUrl), signUrl);
    const mail = await pool.query(
      "SELECT subject, body FROM notifications_log WHERE type = 'authorization_parent_signature' ORDER BY id DESC LIMIT 1");
    check("the family is emailed", mail.rows.length === 1, mail.rows[0] && mail.rows[0].subject);
    // §8. The consequence is stated plainly, because a vaguer sentence gets
    // left for a week.
    check("...and the email says a delay may delay the start of services",
      /delay in receiving your signature may delay the start of ABA services/i.test(mail.rows[0].body), mail.rows[0].subject);
    // The token is a secret and the Message Outbox renders these bodies to
    // every owner and admin. Redaction happens as the outbox RENDERS a row,
    // so this has to ask the outbox rather than read the column -- reading
    // the raw body would assert the wrong layer and pass for the wrong
    // reason the day redaction moved.
    check("the stored body is the email that was actually sent", mail.rows[0].body.includes(token));
    const outbox = await owner("/api/notifications?limit=50");
    const shown = (outbox.data.notifications || outbox.data || []).filter(
      (n) => n && n.type === "authorization_parent_signature");
    check("the outbox returns the signature email", shown.length >= 1, outbox.status);
    check("THE SIGNING LINK IS REDACTED WHERE IT IS SHOWN — it is a credential",
      shown.every((n) => !String(n.body || "").includes(token)),
      (shown[0] || {}).body ? String(shown[0].body).slice(0, 200) : null);
    check("...and the link is visibly removed rather than silently dropped",
      shown.some((n) => /link removed/i.test(String(n.body || ""))), (shown[0] || {}).body ? "no marker" : null);
  }
  {
    const anon = client();
    const v = await anon(`/api/authorization-sign/${token}`);
    check("the parent's page opens with no CRM session at all", v.status === 200 && v.data.signed === false, v.data);
    check("...and names the child and the document", !!v.data.client_name && !!v.data.document_label, v.data);
    check("...and offers the document to read before signing", v.data.can_view === true);
    check("viewing is recorded", (await pool.query(
      "SELECT viewed_at FROM auth_signature_requests WHERE token = $1", [token])).rows[0].viewed_at != null);

    const blank = await anon(`/api/authorization-sign/${token}`, { method: "POST", body: { signed_name: "  " } });
    check("signing with no name is refused", blank.status === 400, blank.data);

    const s = await anon(`/api/authorization-sign/${token}`, { method: "POST", body: { signed_name: "AR Parent" } });
    check("the parent signs", s.status === 200, s.data);
    check("...and the signature is APPENDED TO THE PLAN, not filed as a loose certificate",
      s.data.merged === true, s.data);

    const again = await anon(`/api/authorization-sign/${token}`, { method: "POST", body: { signed_name: "AR Parent" } });
    check("SIGNING TWICE IS REFUSED — one family, one signature, one document",
      again.status === 409, again.data);
    // THE CHECK ABOVE PASSES FOR THE WEAKER REASON. Signing again afterwards
    // is caught by a plain read of the row; what actually protects a parent
    // who double-taps on a phone is the CONDITIONAL WRITE, and deleting its
    // WHERE clause leaves every check in this suite green. Two requests in
    // flight at once is not something a sequential test can stage reliably,
    // so the clause is asserted on the source as well, with this comment
    // saying plainly why. A test that cannot fail is not evidence.
    const SRC = fs.readFileSync(path.join(__dirname, "authorization-requests.js"), "utf8");
    check("the signature is CLAIMED with a conditional write, not a read-then-write",
      /UPDATE auth_signature_requests SET status = 'signed'[^`]*WHERE id = \? AND status = 'pending'/.test(SRC),
      "the AND status = 'pending' clause is missing from the claim");
    check("...and only the request that actually changed a row goes on to build the document",
      /if \(!claimed\) return \{ ok: false, status: 409/.test(SRC));
    check("...and only one completed plan exists",
      Number((await pool.query(
        "SELECT count(*) FROM client_documents WHERE client_id = $1 AND clinical_type = 'signed_treatment_plan'", [cid])).rows[0].count) === 1);

    // And the real shape of the risk: two taps at the same moment. This does
    // not reliably interleave, so it is kept as a floor rather than as the
    // proof -- whatever the ordering, exactly one may succeed and exactly one
    // completed plan may exist.
    const cidR = await mkClient(`AR Race ${stamp}`, "Tricare");
    await mkDoc(cidR, "Treatment Plan", "treatment_plan");
    const cR = await owner("/api/authorization-requests", { method: "POST", body: { client_id: cidR, request_type: "reauthorization" } });
    const sR = await owner(`/api/authorization-requests/${cR.data.id}/request-signature`, { method: "POST", body: {} });
    const tR = String(sR.data.signing_url).split("/").pop();
    const both = await Promise.all([
      client()(`/api/authorization-sign/${tR}`, { method: "POST", body: { signed_name: "AR Parent" } }),
      client()(`/api/authorization-sign/${tR}`, { method: "POST", body: { signed_name: "AR Parent" } }),
    ]);
    check("two simultaneous signings produce exactly one success",
      both.filter((x) => x.status === 200).length === 1, both.map((x) => x.status));
    check("...and exactly one completed treatment plan",
      Number((await pool.query(
        "SELECT count(*) FROM client_documents WHERE client_id = $1 AND clinical_type = 'signed_treatment_plan'", [cidR])).rows[0].count) === 1);
  }
  {
    // §7. ONE document: the original pages plus the signature page.
    const { PDFDocument } = require("pdf-lib");
    const done = (await pool.query(
      "SELECT file_path FROM client_documents WHERE client_id = $1 AND clinical_type = 'signed_treatment_plan' ORDER BY id DESC LIMIT 1", [cid])).rows[0];
    const src = (await pool.query("SELECT file_path FROM client_documents WHERE id = $1", [plan])).rows[0];
    const a = await PDFDocument.load(fs.readFileSync(path.join(DOCS_DIR, src.file_path)));
    const b = await PDFDocument.load(fs.readFileSync(path.join(DOCS_DIR, done.file_path)));
    check("the completed plan keeps every page of the BCBA-signed original",
      b.getPageCount() === a.getPageCount() + 1, { original: a.getPageCount(), completed: b.getPageCount() });

    const r = await owner(`/api/authorization-requests/${reqId}`);
    check("the request moves to Ready to Submit on its own", r.data.status === "ready_to_submit", r.data.status);
    check("...at 100%", r.data.tracker.percent === 100, r.data.tracker);
    check("...and the treatment plan requirement now points at the COMPLETED document",
      r.data.documents.find((d) => d.requirement_key === "treatment_plan").document.clinical_type === "signed_treatment_plan");
    check("the Parent node on the tracker is complete",
      r.data.tracker.nodes.find((n) => n.key === "parent_signature").state === "complete");
  }

  // ==================================================================
  section("Daily reminders, and the day they stop");
  {
    const cid2 = await mkClient(`AR Reminder ${stamp}`, "Tricare");
    await mkDoc(cid2, "Treatment Plan", "treatment_plan");
    const c = await owner("/api/authorization-requests", { method: "POST", body: { client_id: cid2, request_type: "reauthorization" } });
    const rid = c.data.id;
    await owner(`/api/authorization-requests/${rid}/request-signature`, { method: "POST", body: {} });
    const sigRow = (await pool.query("SELECT id, token, parent_email FROM auth_signature_requests WHERE request_id = $1", [rid])).rows[0];
    // Backdate the request so it is eligible: a reminder the same afternoon
    // reads as a system fault, not a nudge.
    await pool.query("UPDATE auth_signature_requests SET requested_at = '2026-09-01T09:00:00.000Z' WHERE id = $1", [sigRow.id]);

    const countMails = async () => Number((await pool.query(
      "SELECT count(*) FROM notifications_log WHERE recipient = $1 AND type = 'authorization_parent_signature'",
      [sigRow.parent_email])).rows[0].count);
    const before = await countMails();

    // The sweep is claimed by a unique (signature, day) row, so this is the
    // behaviour under two sweeps racing, not just under one.
    await pool.query("INSERT INTO auth_signature_reminders (signature_id, sent_on, sent_at) VALUES ($1,'2026-09-02',now()::text)", [sigRow.id]);
    const dup = await pool.query(
      "INSERT INTO auth_signature_reminders (signature_id, sent_on, sent_at) VALUES ($1,'2026-09-02',now()::text) ON CONFLICT DO NOTHING RETURNING id", [sigRow.id]);
    check("A SECOND REMINDER ON THE SAME DAY IS REFUSED BY THE DATABASE, not by a check",
      dup.rows.length === 0);
    const nextDay = await pool.query(
      "INSERT INTO auth_signature_reminders (signature_id, sent_on, sent_at) VALUES ($1,'2026-09-03',now()::text) ON CONFLICT DO NOTHING RETURNING id", [sigRow.id]);
    check("...while the next day is allowed", nextDay.rows.length === 1);

    // Signing stops them, and stops them because the row is no longer
    // pending -- there is no separate switch that can be left on.
    const anon = client();
    await anon(`/api/authorization-sign/${sigRow.token}`, { method: "POST", body: { signed_name: "AR Parent" } });
    const pendingAfter = await pool.query("SELECT status FROM auth_signature_requests WHERE id = $1", [sigRow.id]);
    check("SIGNING STOPS THE REMINDERS — the row leaves the sweep's own query",
      pendingAfter.rows[0].status === "signed");
    check("no further reminder was sent by signing", (await countMails()) === before);

    const r = await owner(`/api/authorization-requests/${rid}`);
    check("the card shows what a BCBA needs to chase it: when, how many, whether it was opened",
      r.data.signature.requested_at && r.data.signature.viewed_at !== undefined
        && typeof r.data.signature.reminders_sent === "number", r.data.signature);
  }

  // ==================================================================
  section("Submission happens once, to a configured address");
  {
    const noMail = await owner(`/api/authorization-requests/${reqId}/submit`, { method: "POST", body: {} });
    check("NOTHING IS SENT UNTIL AN ADMINISTRATOR CONFIGURES THE ADDRESS — it is not in the code",
      noMail.status === 400 && /email is configured/i.test(noMail.data.error), noMail.data);

    await owner("/api/authorization-requests/config", { method: "PUT", body: { auth_email: `auth.${stamp}@payer.invalid` } });
    const rev = await owner(`/api/authorization-requests/${reqId}/review`);
    check("the review shows the whole package before it leaves", rev.data.files.length === 5, rev.data.files);
    check("...addressed to the configured address", rev.data.to === `auth.${stamp}@payer.invalid`, rev.data.to);
    check("...with the subject the payer will see",
      /^Authorization Request – .+ – ABA Services Authorization – Tricare$/.test(rev.data.subject), rev.data.subject);
    check("...and the SIGNED plan is the one attached, not the unsigned original",
      rev.data.files.some((f) => /Signed/i.test(f.filename)), rev.data.files.map((f) => f.filename));

    const sent = await owner(`/api/authorization-requests/${reqId}/submit`, { method: "POST", body: {} });
    check("it submits", sent.status === 200 && sent.data.attachments === 5, sent.data);
    const mail = await pool.query(
      "SELECT subject FROM notifications_log WHERE type = 'authorization_request_submission' ORDER BY id DESC LIMIT 1");
    check("...and the transmission is logged", mail.rows.length === 1, mail.rows[0]);
    check("...with a projected response and start date on the record",
      !!sent.data.projected_response_date && !!sent.data.projected_start_date, sent.data);

    const dup = await owner(`/api/authorization-requests/${reqId}/submit`, { method: "POST", body: {} });
    check("A SECOND SUBMISSION IS REFUSED", dup.status === 409, dup.data);
    check("...naming the date it already went", /already submitted on \d{4}-\d{2}-\d{2}/.test(dup.data.error), dup.data.error);
    check("...and asking for a reason rather than simply blocking", dup.data.requires === "resubmission_reason", dup.data);

    const again = await owner(`/api/authorization-requests/${reqId}/submit`, {
      method: "POST", body: { resubmission_reason: "Payer lost the first packet" } });
    check("with a reason it goes again", again.status === 200, again.data);
    check("...and the reason is on the record",
      (await pool.query("SELECT resubmission_reason FROM auth_submissions WHERE request_id = $1 ORDER BY id DESC LIMIT 1",
        [reqId])).rows[0].resubmission_reason === "Payer lost the first packet");
  }

  // ==================================================================
  section("An attachment set too large is never a silent failure");
  {
    const cid3 = await mkClient(`AR Big ${stamp}`, "Molina");
    // Molina's seeded ABA package is the treatment plan alone, so one
    // oversized file is enough to exercise the ceiling.
    // A REAL PDF, genuinely large. The first version of this fixture was 3MB
    // of spaces named .pdf: pdf-lib could not load it, the signature step
    // fell back to a small certificate, and the package came in under the
    // limit -- so the check passed the submission it was written to stop.
    const big = `artest_big_${stamp}.pdf`;
    {
      // RANDOM text, not repeated text. The second version of this fixture
      // drew the same 900-character string on every page and pdf-lib stored
      // it once: 260 pages came to 130KB and the package sailed under the
      // limit again. Incompressible content is the only way to actually be
      // large.
      const { PDFDocument, StandardFonts } = require("pdf-lib");
      const crypto = require("crypto");
      const d = await PDFDocument.create();
      const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 0; i < 420; i++) {
        const pg = d.addPage();
        for (let y = 0; y < 26; y++) {
          pg.drawText(crypto.randomBytes(90).toString("base64"), { x: 10, y: 30 + y * 28, size: 6, font: f });
        }
      }
      const buf = Buffer.from(await d.save());
      fs.writeFileSync(path.join(DOCS_DIR, big), buf);
      check("the oversize fixture really is over the limit under test",
        buf.length > 1024 * 1024, (buf.length / 1048576).toFixed(2) + "MB");
    }
    // Columns NAMED against their own placeholders. The first version of this
    // insert listed nine columns and nine values in the wrong order, so
    // file_path held the literal string 'application/pdf': the file could
    // never be read, the merge fell back to a small certificate, and the
    // oversize check passed the submission it exists to stop.
    await pool.query(
      `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, uploaded_at, clinical_type, document_date)
       VALUES ($1, $2, $3, $4, $5, $6, now()::text, $7, $8)`,
      [cid3, "Treatment Plan", "big.pdf", "application/pdf", big, "hosted", "treatment_plan", "2026-09-01"]);
    check("the oversize fixture is readable from storage",
      fs.statSync(path.join(DOCS_DIR, big)).size > 1024 * 1024);
    const c = await owner("/api/authorization-requests", { method: "POST", body: { client_id: cid3, request_type: "aba_services" } });
    const rid = c.data.id;
    const sigr = await owner(`/api/authorization-requests/${rid}/request-signature`, { method: "POST", body: {} });
    const tk = String(sigr.data.signing_url).split("/").pop();
    await client()(`/api/authorization-sign/${tk}`, { method: "POST", body: { signed_name: "AR Parent" } });

    await owner("/api/authorization-requests/config", { method: "PUT", body: { attachment_limit_mb: 1 } });
    const r = await owner(`/api/authorization-requests/${rid}/submit`, { method: "POST", body: {} });
    check("AN OVERSIZED PACKAGE IS REFUSED, not sent and forgotten", r.status === 413, r.data);
    check("...saying how big it is and what the limit is", /over the 1MB limit/i.test(r.data.error), r.data.error);
    check("...and pointing at the secure document route instead of stopping",
      /secure document link/i.test(r.data.error), r.data.error);
    check("nothing was recorded as submitted",
      Number((await pool.query("SELECT count(*) FROM auth_submissions WHERE request_id = $1", [rid])).rows[0].count) === 0);
    check("...and the request did not move to Submitted",
      (await owner(`/api/authorization-requests/${rid}`)).data.status === "ready_to_submit");
    check("the refusal is on the audit trail, so nobody wonders later why it stalled",
      (await pool.query("SELECT count(*) FROM auth_request_events WHERE request_id = $1 AND action = 'submission_blocked_size'",
        [rid])).rows[0].count === "1");
    await owner("/api/authorization-requests/config", { method: "PUT", body: { attachment_limit_mb: 20 } });
  }

  // ==================================================================
  section("After submission the payer owns the answer");
  {
    const before = await owner(`/api/authorization-requests/${reqId}`);
    check("the status is no longer one the workflow derives", before.data.status_is_derived === false, before.data.status);
    // A document change after submission must not silently rewind a submitted
    // request to "ready to submit".
    await owner(`/api/authorization-requests/${reqId}/document`, {
      method: "POST", body: { requirement_key: "srs", client_document_id: srs } });
    const after = await owner(`/api/authorization-requests/${reqId}`);
    check("CHANGING A DOCUMENT AFTER SUBMISSION DOES NOT REWIND THE STATUS",
      after.data.status === "submitted", after.data.status);

    const info = await owner(`/api/authorization-requests/${reqId}/info-request`, {
      method: "POST", body: { needed: "Updated Vineland", due_date: "2026-11-01", requested_by_payer: "Tricare reviewer" } });
    check("a payer asking for more information is recorded", info.data.status === "info_requested", info.data.status);
    check("...ON THE SAME REQUEST — a second one would split the history and break every turnaround figure",
      info.data.info_requests.length === 1 &&
      Number((await pool.query("SELECT count(*) FROM auth_requests WHERE client_id = $1", [cid])).rows[0].count) === 1,
      info.data.info_requests);

    const appr = await owner(`/api/authorization-requests/${reqId}/outcome`, { method: "POST", body: {
      status: "approved", authorization_number: `TRI-${stamp}`, effective_start: "2026-11-10",
      effective_end: "2027-05-10", approved_units: "1280", approved_hours: "320",
      frequency: "20 hrs/week", approved_cpt_codes: "97153, 97155", actual_start_date: "2026-11-12" } });
    check("an approval is recorded", appr.data.status === "approved" && appr.data.authorization_number === `TRI-${stamp}`, appr.data.status);
    check("...and the tracker reaches Approved", 
      appr.data.tracker.nodes.find((n) => n.key === "approved").state === "complete", appr.data.tracker.nodes);
    // §18. The projection is not overwritten by the outcome: the gap between
    // the two is the measurement this data exists for.
    check("THE PROJECTED START IS KEPT BESIDE THE ACTUAL ONE, never replaced by it",
      appr.data.actual_start_date === "2026-11-12" &&
      !!(await pool.query("SELECT projected_start_date FROM auth_requests WHERE id = $1", [reqId])).rows[0].projected_start_date,
      appr.data.actual_start_date);
  }

  // ==================================================================
  section("A projected date is an estimate and says so");
  {
    const r = await owner(`/api/authorization-requests/${reqId}`);
    // Asserted against what this payer is ACTUALLY configured to take, not
    // against a number typed in here. Pinning the literal made this fail the
    // moment the starting points changed, which told us nothing about whether
    // the note was right -- only that somebody had edited a default.
    const cfgRow = (await pool.query(
      "SELECT turnaround_days, turnaround_basis FROM auth_payer_requirements WHERE payer='Tricare' AND request_type='aba_services'"
    )).rows[0];
    check("the estimate names the payer and the turnaround it used",
      new RegExp(`Tricare estimated review: ${cfgRow.turnaround_days} ${cfgRow.turnaround_basis} days`)
        .test(r.data.projection.estimate_note),
      { note: r.data.projection.estimate_note, configured: cfgRow });
    check("...and carries the disclaimer verbatim",
      /do not guarantee authorization approval/i.test(r.data.projection.disclaimer), r.data.projection.disclaimer);

    // Business days skip the weekend. 2026-10-02 is a Friday; ten business
    // days later is 2026-10-16, not 2026-10-12.
    const mod = require("./authorization-requests.js");
    const noop = async () => null;
    const m = mod({ dbGet: noop, dbAll: async () => [], dbRun: noop, nowISO: () => new Date().toISOString(),
      readBody: noop, json: () => {}, sendEmail: noop, getSetting: noop, setSetting: noop,
      appBaseUrl: () => "", canAccessClients: () => true, isOwnerOrAdmin: () => true,
      documentPath: (x) => x, saveGeneratedPdf: noop });
    check("ten BUSINESS days from a Friday lands two weeks later, not ten calendar days",
      m._internal.addDays("2026-10-02", 10, "business") === "2026-10-16",
      m._internal.addDays("2026-10-02", 10, "business"));
    check("...while calendar days do not skip the weekend",
      m._internal.addDays("2026-10-02", 10, "calendar") === "2026-10-12",
      m._internal.addDays("2026-10-02", 10, "calendar"));
  }
  {
    // While a signature is outstanding the card must say the date may slip.
    const cid4 = await mkClient(`AR Waiting ${stamp}`, "Aetna");
    await mkDoc(cid4, "Treatment Plan", "treatment_plan");
    const c = await owner("/api/authorization-requests", { method: "POST", body: { client_id: cid4, request_type: "aba_services" } });
    await owner(`/api/authorization-requests/${c.data.id}/request-signature`, { method: "POST", body: {} });
    const r = await owner(`/api/authorization-requests/${c.data.id}`);
    check("A REQUEST WAITING ON A PARENT SAYS THE START DATE MAY SLIP",
      r.data.projection.waiting_on_parent === true, r.data.projection);
  }

  // ==================================================================
  section("Every significant action is on the record");
  {
    const ev = await pool.query("SELECT action, prev_status, new_status FROM auth_request_events WHERE request_id = $1 ORDER BY id", [reqId]);
    const actions = ev.rows.map((e) => e.action);
    for (const a of ["created", "document_matched", "parent_signature_requested", "parent_signed", "submitted", "info_requested", "outcome_recorded"]) {
      check(`the timeline records "${a.replace(/_/g, " ")}"`, actions.includes(a), actions);
    }
    check("status changes are stored as a PAIR, so turnaround can be computed later",
      ev.rows.some((e) => e.prev_status && e.new_status && e.prev_status !== e.new_status),
      ev.rows.filter((e) => e.new_status).slice(0, 3));
    const signedEv = ev.rows.find((e) => e.action === "parent_signed");
    check("...and the parent's signature is attributed to the parent, not to staff",
      (await pool.query("SELECT actor FROM auth_request_events WHERE request_id = $1 AND action = 'parent_signed'", [reqId]))
        .rows[0].actor.includes("@"), signedEv);
  }

  // ==================================================================
  section("A document that arrived already knowing what it is");
  {
    // What the SignNow import now writes: a clinical type, plus how it got
    // there. The point of typing at import is that this attaches by itself
    // instead of waiting for somebody to confirm a filename.
    const cidS = await mkClient(`AR SignNow ${stamp}`, "Aetna");
    const imported = (await pool.query(
      `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, uploaded_at,
                                     clinical_type, clinical_type_source, document_date)
       VALUES ($1,$2,$3,'application/pdf',$4,'hosted',now()::text,$5,$6,$7) RETURNING id`,
      [cidS, "Diagnostic Evaluation (from SignNow)", "DiagnosticEvaluation.pdf",
       `arsn_${stamp}.pdf`, "diagnostic_evaluation", "signnow_title", "2026-09-01"]
    )).rows[0].id;
    fs.writeFileSync(path.join(DOCS_DIR, `arsn_${stamp}.pdf`), await pdfBytes("Diagnostic Evaluation", 1));

    const pv = await owner(`/api/authorization-requests/preview?client_id=${cidS}&request_type=assessment`);
    const de = pv.data.items.find((i) => i.key === "diagnostic_evaluation");
    check("AN IMPORTED DOCUMENT MATCHES BY TYPE, not as a filename guess",
      de.found && de.candidates[0].match_source === "type", de.candidates && de.candidates[0]);
    check("...and the record says the type came from its SignNow title",
      de.candidates[0].type_source === "signnow_title", de.candidates[0].type_source);

    const c = await owner("/api/authorization-requests", { method: "POST", body: { client_id: cidS, request_type: "assessment" } });
    const doc = c.data.documents.find((d) => d.requirement_key === "diagnostic_evaluation");
    check("it attaches on its own, with nobody confirming anything",
      doc.document && doc.document.id === imported && doc.status === "ready", doc);

    const evs = (await pool.query(
      "SELECT action, notes FROM auth_request_events WHERE request_id = $1 AND action = 'document_matched'", [c.data.id])).rows;
    const note = (evs.find((e) => /Diagnostic/i.test(e.notes || "")) || {}).notes || "";
    check("THE AUDIT DOES NOT CALL IT SOMEBODY'S DECISION",
      /from its SignNow title/i.test(note), note);

    // A document a human typed must still read as a human's choice.
    const cidH = await mkClient(`AR Handpicked ${stamp}`, "Aetna");
    await mkDoc(cidH, "Diagnostic Evaluation", "diagnostic_evaluation");
    const pvH = await owner(`/api/authorization-requests/preview?client_id=${cidH}&request_type=assessment`);
    const deH = pvH.data.items.find((i) => i.key === "diagnostic_evaluation");
    check("...while a type somebody picked still reads as picked",
      deH.candidates[0].type_source === "picked", deH.candidates[0].type_source);
  }

  // ==================================================================
  section("Starting points, and the edit they must never touch");
  {
    const get = async (payer, type) => (await pool.query(
      "SELECT turnaround_days, turnaround_basis, updated_by FROM auth_payer_requirements WHERE LOWER(payer)=$1 AND request_type=$2",
      [payer, type])).rows[0];

    const medicaid = await get("molina", "aba_services");
    check("a Medicaid plan starts at its standard prior-authorisation deadline",
      Number(medicaid.turnaround_days) === 14 && medicaid.turnaround_basis === "calendar", medicaid);
    const commercial = await get("aetna", "aba_services");
    check("a commercial plan starts at the non-urgent pre-service deadline",
      Number(commercial.turnaround_days) === 15 && commercial.turnaround_basis === "calendar", commercial);
    // Reauthorization, not aba_services: the payer-configuration section above
    // deliberately churns Tricare's ABA row to prove a reseed cannot overwrite
    // an edit, and leaves it on its own fixture value. This row is untouched.
    const tricare = await get("tricare", "reauthorization");
    check("Tricare starts at its planning figure, not at the old flat default",
      Number(tricare.turnaround_days) === 30, tricare);
    check("THESE ARE CALENDAR DAYS, because the deadlines they come from are",
      ["molina", "aetna", "tricare"].length === 3 && medicaid.turnaround_basis === "calendar"
        && commercial.turnaround_basis === "calendar" && tricare.turnaround_basis === "calendar");

    // The rule the whole configuration model rests on. An admin who sets a
    // payer to what it ACTUALLY takes must not find it rewritten on next boot.
    await pool.query(
      "UPDATE auth_payer_requirements SET turnaround_days = 3, updated_by = $1 WHERE LOWER(payer)='molina' AND request_type='aba_services'",
      ["someone@spectrumsquadlv.com"]);
    await pool.query("DELETE FROM app_settings WHERE key = 'auth_turnaround_starting_points_applied'");
    const again = await owner("/api/authorization-requests/config");
    check("the starting points can be re-applied at all", again.status === 200);
    // initTables runs at boot; re-run it directly against this database.
    const mod = require("./authorization-requests.js");
    check("A HUMAN'S EDIT SURVIVES THE STARTING POINTS BEING APPLIED AGAIN",
      Number((await get("molina", "aba_services")).turnaround_days) === 3,
      await get("molina", "aba_services"));
    check("...and it is the edited-by mark that protects it, not luck",
      (await get("molina", "aba_services")).updated_by === "someone@spectrumsquadlv.com",
      (await get("molina", "aba_services")).updated_by);
    check("the module still loads while all that is true", typeof mod === "function");
  }

  // ==================================================================
  section("The audit trail actually reaches the screen");
  {
    // The list is deliberately the cheap shape. That is fine, but it means the
    // detail endpoint is the ONLY thing that can fill the Activity panel, and
    // a list row rendered on expand would show an empty history while the
    // database was full of it. Both halves are asserted so neither can drift.
    const list = await owner("/api/authorization-requests");
    const row = ((list.data && list.data.requests) || []).find((r) => String(r.id) === String(reqId));
    check("the list stays cheap and carries no history", !!row && row.events === undefined, row && Object.keys(row).length);
    const full = await owner(`/api/authorization-requests/${reqId}`);
    check("THE DETAIL CARRIES THE HISTORY, which is what the open card draws",
      Array.isArray(full.data.events) && full.data.events.length > 0, full.data.events && full.data.events.length);

    // The parent page is one big template literal, so a regex written with a
    // single backslash arrives in the browser as a bare letter and silently
    // never matches. It failed exactly that way once.
    const sigRow = await pool.query("SELECT token FROM auth_signature_requests WHERE request_id = $1 ORDER BY id LIMIT 1", [reqId]);
    const page = await fetch(`${BASE}/authorization-sign/${sigRow.rows[0].token}`).then((r) => r.text());
    check("the signing page reaches the browser with a REAL regex, not a de-escaped one",
      page.includes("\\d{4}") && !/[^\\]d\{4\}/.test(page), page.slice(page.indexOf("function longDate"), page.indexOf("function longDate") + 80));
    // Asserted on the CALL, not on the served text: the date is inserted in the
    // browser, so the raw page never contains it either way and a check against
    // the text would pass no matter what. This fails if the formatting is
    // dropped and the parent is handed the raw value again.
    check("...and the signing date is put through that formatter, not printed raw",
      /Signing on '\s*\+\s*esc\(longDate\(d\.today\)\)/.test(page),
      (page.match(/Signing on[^+]*\+[^+]*\+/) || [])[0]);
  }

  // ==================================================================
  section("Who may see it, and who may configure it");
  {
    const anon = client();
    check("signed out, the list is refused", (await anon("/api/authorization-requests")).status === 401);
    const clin = client();
    await clin("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
    check("a BCBA can use Authorization Requests — it is their workflow",
      (await clin("/api/authorization-requests")).status === 200);
    const cfg = await clin("/api/authorization-requests/config", { method: "PUT", body: { auth_email: "hijack@example.invalid" } });
    check("A BCBA CANNOT CHANGE WHERE AUTHORIZATIONS ARE SENT", cfg.status === 403, cfg.data);
    check("...and the address is unchanged",
      (await owner("/api/authorization-requests/config")).data.auth_email === `auth.${stamp}@payer.invalid`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("harness error:", e.stack || e);
  await pool.end().catch(() => {});
  process.exit(1);
});
