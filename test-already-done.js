// "This was already done" — recording work that happened outside the CRM.
//
// Quiana's ask: a way to mark the clinical screener, the enrollment packet and
// any stage task as already complete, without the emails they normally fire.
// A family who signed on paper a fortnight ago should not get a "welcome to
// the next step" today, and staff should not be alerted to action something
// already actioned.
//
// The whole value is in what does NOT happen, and an email that fails to send
// leaves no trace — so every check here counts rows in notifications_log
// before and after. A test that only asserted the task went green would pass
// just as happily while emailing every family in the pipeline.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-already-done.js
"use strict";
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
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

// Every email the CRM sends is written to notifications_log, so counting it is
// how "nothing was sent" gets proved rather than assumed.
const mailCount = async (clientId) =>
  Number((await pool.query("SELECT count(*) FROM notifications_log WHERE client_id = $1", [clientId])).rows[0].count);

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);

  // Children first: client_tasks, packets, invites and notes all reference the
  // client, so deleting the client alone trips the foreign key.
  const purge = async () => {
    const ids = "(SELECT id FROM clients WHERE child_name LIKE 'ALREADY %')";
    for (const t of ["client_tasks", "enrollment_packets", "screener_invites",
                     "screener_submissions", "client_notes", "notifications_log"]) {
      await pool.query(`DELETE FROM ${t} WHERE client_id IN ${ids}`).catch(() => {});
    }
    await pool.query("DELETE FROM clients WHERE child_name LIKE 'ALREADY %'").catch(() => {});
  };
  await purge();

  const mkClient = async (name) => {
    const r = await owner("/api/clients", {
      method: "POST",
      body: { child_name: name, parent_name: "Parent " + name, parent_email: `${name.replace(/\W/g, "")}@example.invalid` },
    });
    return (r.data && (r.data.id || (r.data.client && r.data.client.id))) || null;
  };

  // ---------------------------------------------------------------- tasks
  section("A stage task marked 'already done' emails nobody");
  const quiet = await mkClient("ALREADY Quiet");
  check("the client was created", !!quiet, quiet);
  const quietTasks = (await owner(`/api/clients/${quiet}`)).data.tasks || [];
  check("it has stage tasks to tick", quietTasks.length > 0, quietTasks.length);

  const before = await mailCount(quiet);
  const t = quietTasks[0];
  const done = await owner(`/api/tasks/${t.id}/complete`, { method: "POST", body: { silent: true } });
  check("the task completes", done.status === 200, done.data);

  const after = await mailCount(quiet);
  check("NOT ONE email was sent", after === before, { before, after });

  const quietAfter = (await owner(`/api/clients/${quiet}`)).data;
  const ticked = (quietAfter.tasks || []).find((x) => x.id === t.id);
  check("but the task really is complete", ticked && ticked.status === "completed", ticked && ticked.status);
  check("and it is recorded as a back-fill, not an ordinary tick",
    (await pool.query("SELECT completed_silently FROM client_tasks WHERE id = $1", [t.id])).rows[0].completed_silently === true);

  section("The ordinary path still does send");
  // The opposite guard, and the one that matters most: if "already done" had
  // worked by breaking sending outright, every check above would pass while the
  // CRM quietly stopped emailing anyone.
  //
  // Only some stages email a parent (MILESTONE_STAGE_TEMPLATES in server.js),
  // so this walks a client up to one that does rather than assuming any stage
  // move sends. Advancing into "authorization" fires milestone_authorization.
  const loud = await mkClient("ALREADY Loud");
  const advanceTo = async (id, stage) => {
    for (let i = 0; i < 8; i++) {
      const c = (await owner(`/api/clients/${id}`)).data.client;
      if (c.stage === stage) return true;
      const r = await owner(`/api/clients/${id}/advance`, { method: "POST", body: {} });
      if (r.status !== 200) return false;
    }
    return false;
  };
  check("a client can be walked to the authorization stage",
    await advanceTo(loud, "authorization"),
    (await owner(`/api/clients/${loud}`)).data.client.stage);
  await new Promise((r) => setTimeout(r, 1500)); // sends are fire-and-forget
  const loudMail = await mailCount(loud);
  check("reaching a milestone stage emailed the family", loudMail > 0, loudMail);

  // The same journey, silently. Same stages, same tasks, nothing sent.
  const hushed = await mkClient("ALREADY Hushed");
  const hushedTasks = (await owner(`/api/clients/${hushed}`)).data.tasks || [];
  const beforeHushed = await mailCount(hushed);
  for (const ht of hushedTasks) {
    await owner(`/api/tasks/${ht.id}/complete`, { method: "POST", body: { silent: true } });
  }
  await new Promise((r) => setTimeout(r, 1500));
  check("the same stage completed as 'already done' sends nothing",
    (await mailCount(hushed)) === beforeHushed,
    { before: beforeHushed, after: await mailCount(hushed) });
  check("and the client still moved on",
    (await owner(`/api/clients/${hushed}`)).data.client.stage !== "new_submission",
    (await owner(`/api/clients/${hushed}`)).data.client.stage);

  // ------------------------------------------------------------- screener
  section("The clinical screener can be marked already done");
  const scr = await mkClient("ALREADY Screener");
  const beforeScr = await mailCount(scr);
  const mark = await owner(`/api/screener/mark-complete/${scr}`, { method: "POST", body: {} });
  check("it is accepted", mark.status === 200, mark.data);
  check("no email went to the family", (await mailCount(scr)) === beforeScr);

  const scrRow = (await pool.query("SELECT clinical_screener_completed FROM clients WHERE id = $1", [scr])).rows[0];
  check("the screener reads as completed", scrRow.clinical_screener_completed === true, scrRow);
  check("a note records who did it and why it was quiet",
    /already completed/i.test(((await pool.query(
      "SELECT body FROM client_notes WHERE client_id = $1 ORDER BY id DESC LIMIT 1", [scr])).rows[0] || {}).body || ""));
  // No answers are invented: the submission list stays empty rather than
  // gaining a fabricated row that clinical staff would later read as real.
  check("no fake submission was written",
    Number((await pool.query("SELECT count(*) FROM screener_submissions WHERE client_id = $1", [scr])).rows[0].count) === 0);

  section("Marking it done stops the chase");
  // An outstanding invite is closed, so the daily reminder has nothing to send.
  const chased = await mkClient("ALREADY Chased");
  await pool.query(
    `INSERT INTO screener_invites (client_id, token, status, sent_at, reminder_count)
     VALUES ($1, $2, 'sent', $3, 0)`,
    [chased, "tok-chased-" + chased, new Date().toISOString()]
  );
  await owner(`/api/screener/mark-complete/${chased}`, { method: "POST", body: {} });
  const inv = (await pool.query("SELECT status FROM screener_invites WHERE client_id = $1", [chased])).rows[0];
  check("the outstanding invite is closed", inv && inv.status === "completed", inv);

  // --------------------------------------------------------------- packet
  section("The enrollment packet can be marked already signed");
  const pk = await mkClient("ALREADY Packet");
  const beforePk = await mailCount(pk);
  const pkMark = await owner(`/api/clients/${pk}/enrollment-packet/mark-complete`, { method: "POST", body: {} });
  check("it is accepted", pkMark.status === 200, pkMark.data);
  check("no email went to the family", (await mailCount(pk)) === beforePk);

  const pkRow = (await pool.query("SELECT * FROM enrollment_packets WHERE client_id = $1", [pk])).rows[0];
  check("a completed packet row now exists", pkRow && pkRow.status === "completed", pkRow && pkRow.status);
  check("with no SignNow document behind it, honestly recorded as null",
    pkRow && pkRow.signnow_document_id === null, pkRow && pkRow.signnow_document_id);
  check("and it shows on the card as signed",
    ((await owner(`/api/clients/${pk}`)).data.enrollmentPacket || {}).status === "completed");

  section("An existing packet is updated rather than duplicated");
  const pk2 = await mkClient("ALREADY Packet Two");
  // enrollment_packets is unique per client, and creating a client may already
  // have queued one, so this upserts rather than assuming the row is absent.
  await pool.query(
    `INSERT INTO enrollment_packets (client_id, signnow_document_id, status, sent_at)
     VALUES ($1, 'doc-already-2', 'sent', $2)
     ON CONFLICT (client_id) DO UPDATE
       SET signnow_document_id = 'doc-already-2', status = 'sent'`,
    [pk2, new Date().toISOString()]);
  await owner(`/api/clients/${pk2}/enrollment-packet/mark-complete`, { method: "POST", body: {} });
  const rows2 = (await pool.query("SELECT * FROM enrollment_packets WHERE client_id = $1", [pk2])).rows;
  check("still exactly one packet row", rows2.length === 1, rows2.length);
  check("flipped to completed", rows2[0].status === "completed", rows2[0].status);
  check("keeping the real document id it already had",
    rows2[0].signnow_document_id === "doc-already-2", rows2[0].signnow_document_id);

  section("Not everyone may do this");
  const clinical = client();
  await clinical("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("a clinical user cannot mark a packet signed",
    (await clinical(`/api/clients/${pk}/enrollment-packet/mark-complete`, { method: "POST", body: {} })).status === 403);

  await purge();
  await pool.end();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
