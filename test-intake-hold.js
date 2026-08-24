// Putting the automated intake chasers on hold for one family.
//
// Quiana's ask, and the situation behind it: enrollment packets the CRM
// believes it sent that SignNow never delivered. Those families were being
// emailed daily about a document they never received, and the 7-day rule would
// then close them out for not signing it. No stage and no waitlist flag can
// see that, so a person has to be able to say "stop chasing this family" --
// without resending anything, and without moving them anywhere.
//
// What this suite is really guarding is the two ways the feature could be
// worse than doing nothing:
//
//   1. A hold that silences the emails but leaves the deadline running. The
//      family then gets closed out in silence, and nobody sees it happen.
//   2. A hold nobody can find afterwards. Permanent silence on a family who
//      needed chasing is the same outcome as losing their file.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-intake-hold.js
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

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const DAY = 24 * 3600 * 1000;

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);

  const purge = async () => {
    const ids = "(SELECT id FROM clients WHERE child_name LIKE 'HOLD %')";
    for (const t of ["client_tasks", "enrollment_packets", "screener_invites",
                     "screener_submissions", "client_notes", "notifications_log"]) {
      await pool.query(`DELETE FROM ${t} WHERE client_id IN ${ids}`).catch(() => {});
    }
    await pool.query("DELETE FROM clients WHERE child_name LIKE 'HOLD %'").catch(() => {});
  };
  await purge();

  const mkClient = async (name) => {
    const r = await owner("/api/clients", {
      method: "POST",
      body: { child_name: name, parent_name: "Parent " + name, parent_email: `${name.replace(/\W/g, "")}@example.invalid` },
    });
    return (r.data && (r.data.id || (r.data.client && r.data.client.id))) || null;
  };
  const card = async (id) => (await owner(`/api/clients/${id}`)).data;
  const row = async (id) => (await pool.query("SELECT * FROM clients WHERE id = $1", [id])).rows[0];
  const mails = async (id) =>
    Number((await pool.query("SELECT count(*) FROM notifications_log WHERE client_id = $1", [id])).rows[0].count);
  // Creating a client sends the family a "we received your form" email, and it
  // is fire-and-forget, so a count taken immediately is a count of a race. What
  // matters here is not that a client has never been emailed -- it is that
  // holding and releasing them emails nobody -- so every assertion below is a
  // BEFORE and AFTER around the action, taken once the welcome mail has landed.
  const settle = () => new Promise((r) => setTimeout(r, 1200));

  section("A family being chased normally says so");
  const c1 = await mkClient("HOLD One");
  check("the client was created", !!c1, c1);
  let state = (await card(c1)).intakeChasing;
  check("the card reports the chasing state", !!state, state);
  check("nothing is paused to begin with", state.paused === false && state.on_hold === false, state);
  check("and no reason is invented", state.reason === null, state.reason);

  section("Placing a hold");
  await settle();
  const mailsBeforeHold = await mails(c1);
  const put = await owner(`/api/clients/${c1}/intake-chasing`, {
    method: "POST", body: { on_hold: true, note: "Packet never reached the family in SignNow" },
  });
  check("it is accepted", put.status === 200, put.data);
  state = (await card(c1)).intakeChasing;
  check("the family is now on hold", state.on_hold === true && state.paused === true, state);
  check("with the reason staff typed, so the next person knows why",
    /never reached the family/i.test(state.reason || ""), state.reason);
  check("it records who did it", /@/.test(state.held_by || ""), state.held_by);
  check("and when", !!state.held_at, state.held_at);

  section("A hold is a decision about a family, so it is in the case notes");
  // Not only in a column. Somebody reading the record months later should find
  // this beside every other decision, not have to know the column exists.
  const note = (await pool.query(
    "SELECT body FROM client_notes WHERE client_id = $1 ORDER BY id DESC LIMIT 1", [c1])).rows[0] || {};
  check("a note was written", /on hold/i.test(note.body || ""), note.body);
  check("and it carries the reason", /never reached/i.test(note.body || ""), note.body);

  section("Nothing was sent to the family");
  // The entire point. A control whose job is to stop emails must not itself
  // email -- not the family, and not a "your paperwork is on hold" notice.
  await settle();
  check("placing the hold sent the family nothing",
    (await mails(c1)) === mailsBeforeHold, { before: mailsBeforeHold, after: await mails(c1) });

  section("And nothing was moved");
  // Deliberately not the waitlist: that would badge them as waiting for a place
  // they are not waiting for, move them on the board, and email them to say so.
  const r1 = await row(c1);
  check("the client is not on the waitlist", r1.waitlisted !== true, r1.waitlisted);
  check("and is still in the stage they were in", r1.stage === "new_submission", r1.stage);

  section("The packet deadline stops when the button is pressed");
  // Not at the next hourly sweep. The confirmation says the deadline stops now,
  // and it should be true by the time they finish reading it.
  const c2 = await mkClient("HOLD Packet");
  await pool.query(
    `INSERT INTO enrollment_packets (client_id, signnow_document_id, status, sent_at)
     VALUES ($1, 'doc-hold-2', 'sent', $2)
     ON CONFLICT (client_id) DO UPDATE SET signnow_document_id = 'doc-hold-2', status = 'sent', sent_at = EXCLUDED.sent_at, paused_since = NULL`,
    [c2, iso(5 * DAY)]);
  await owner(`/api/clients/${c2}/intake-chasing`, { method: "POST", body: { on_hold: true } });
  const pk = (await pool.query("SELECT * FROM enrollment_packets WHERE client_id = $1", [c2])).rows[0];
  check("the packet clock is stopped straight away", !!pk.paused_since, pk);
  check("and the packet is untouched otherwise -- not cancelled, not resent",
    pk.status === "sent" && pk.signnow_document_id === "doc-hold-2", pk);

  section("Holding twice does not lose the original pause");
  // Re-pressing it (or a second person doing so) must not restart the clock,
  // which would quietly hand back time the family had already used.
  const firstPause = pk.paused_since;
  const firstHeld = (await row(c2)).intake_chasing_paused_at;
  await owner(`/api/clients/${c2}/intake-chasing`, { method: "POST", body: { on_hold: true, note: "a second look" } });
  const pk2 = (await pool.query("SELECT * FROM enrollment_packets WHERE client_id = $1", [c2])).rows[0];
  check("the original pause start is kept", pk2.paused_since === firstPause, { firstPause, now: pk2.paused_since });
  // "Held since 24 August" is the one thing this record exists to answer, so
  // pressing the button again must not quietly move it to today.
  const r2 = await row(c2);
  check("and so is the date the family was first held",
    r2.intake_chasing_paused_at === firstHeld, { firstHeld, now: r2.intake_chasing_paused_at });
  check("a new note is taken", /second look/.test(r2.intake_chasing_pause_note || ""), r2.intake_chasing_pause_note);
  // Held once with a reason, then held again with none: the reason must survive,
  // or a second press silently destroys why anybody stopped chasing them.
  await owner(`/api/clients/${c2}/intake-chasing`, { method: "POST", body: { on_hold: true } });
  check("and a hold with no note does not erase the note already there",
    /second look/.test((await row(c2)).intake_chasing_pause_note || ""),
    (await row(c2)).intake_chasing_pause_note);

  section("Lifting it");
  const mailsBeforeLift = await mails(c1);
  const off = await owner(`/api/clients/${c1}/intake-chasing`, { method: "POST", body: { on_hold: false } });
  check("it is accepted", off.status === 200, off.data);
  state = (await card(c1)).intakeChasing;
  check("chasing resumes", state.on_hold === false && state.paused === false, state);
  check("and the record is cleared rather than left half-set",
    state.held_at === null && state.held_by === null && state.note === null, state);
  const offNote = (await pool.query(
    "SELECT body FROM client_notes WHERE client_id = $1 ORDER BY id DESC LIMIT 1", [c1])).rows[0] || {};
  check("lifting it is recorded too", /off hold/i.test(offNote.body || ""), offNote.body);
  // Releasing must not fire a catch-up burst of everything the hold suppressed.
  await settle();
  check("lifting it sent the family nothing either",
    (await mails(c1)) === mailsBeforeLift, { before: mailsBeforeLift, after: await mails(c1) });

  section("Lifting a hold on a waitlisted family says it changes nothing");
  // The question somebody actually has at that moment. Without this the button
  // looks broken: they click Resume, and the family stays silent.
  const c3 = await mkClient("HOLD Waitlisted");
  await pool.query("UPDATE clients SET waitlisted = true WHERE id = $1", [c3]);
  await owner(`/api/clients/${c3}/intake-chasing`, { method: "POST", body: { on_hold: true } });
  state = (await card(c3)).intakeChasing;
  check("the hold is what is reported, because it is the one they can undo",
    /on hold/i.test(state.reason || ""), state.reason);
  check("but the card is told the waitlist would still hold them",
    state.still_paused_without_hold === true, state);
  check("and can say which rule that is",
    /waitlist/i.test(state.automatic_reason || ""), state.automatic_reason);

  section("A hold is not invisible");
  // Permanent silence on a family who needed chasing is the same outcome as
  // losing their file, so the board carries it too -- not just the card.
  const board = (await owner("/api/clients")).data || [];
  const onBoard = board.find((c) => c.id === c3);
  check("the pipeline board can see the hold", !!(onBoard && onBoard.intake_chasing_paused_at), onBoard);

  section("Not everyone may hold or release a family");
  const clinical = client();
  await clinical("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("a clinical user cannot place a hold",
    (await clinical(`/api/clients/${c1}/intake-chasing`, { method: "POST", body: { on_hold: true } })).status === 403);
  check("nor lift one",
    (await clinical(`/api/clients/${c3}/intake-chasing`, { method: "POST", body: { on_hold: false } })).status === 403);
  check("and the refusal changed nothing", (await row(c1)).intake_chasing_paused_at === null);

  section("Odd input");
  check("an unknown client is a 404, not a silent success",
    (await owner("/api/clients/99999999/intake-chasing", { method: "POST", body: { on_hold: true } })).status === 404);
  const c4 = await mkClient("HOLD NoNote");
  await owner(`/api/clients/${c4}/intake-chasing`, { method: "POST", body: { on_hold: true } });
  state = (await card(c4)).intakeChasing;
  check("a hold with no note still holds, and still explains itself",
    state.on_hold === true && (state.reason || "").length > 20, state);
  // A note long enough to be a pasted email thread is trimmed rather than
  // rejected: refusing the hold over its note would leave the family being
  // chased, which is the wrong way round.
  await owner(`/api/clients/${c4}/intake-chasing`, { method: "POST", body: { on_hold: true, note: "x".repeat(2000) } });
  const trimmed = (await row(c4)).intake_chasing_pause_note || "";
  check("an over-long note is trimmed, not refused", trimmed.length === 500, trimmed.length);

  await purge();
  await pool.end();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
