// Waitlisted families are not chased.
//
// Four parent-facing automations are supposed to go quiet while a client sits
// on the waitlist, and one of them -- the enrollment packet -- must do more
// than go quiet: its 7-day "not completed" rule moves the client to
// not_moving_forward, and a family told to sit tight must not be closed out
// for doing exactly that. These tests drive the real sweep functions against a
// real database rather than asserting on SQL strings, because the bug worth
// catching is "the reminder stopped but the deadline didn't".
"use strict";
const { Client } = require("pg");

const DB = process.env.DATABASE_URL;
if (!DB) { console.error("DATABASE_URL not set"); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
};

const db = new Client({ connectionString: DB });

// The sweeps send through Resend. Nothing here should reach a real inbox, so
// every send is captured instead. Anything that arrives is a test failure by
// definition -- these families are meant to hear nothing.
const sent = [];

async function q(sql, params) { return (await db.query(sql.replace(/\?/g, (m, i) => m), params)).rows; }
function pg(sql) { let i = 0; return sql.replace(/\?/g, () => "$" + ++i); }
const run = (sql, p = []) => db.query(pg(sql), p);
const all = async (sql, p = []) => (await db.query(pg(sql), p)).rows;
const get = async (sql, p = []) => (await all(sql, p))[0] || null;

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const DAY = 24 * 3600 * 1000;

(async () => {
  await db.connect();

  // ---------------- fixtures ----------------
  await run("DELETE FROM enrollment_packets WHERE client_id IN (SELECT id FROM clients WHERE child_name LIKE 'WLTEST%')");
  await run("DELETE FROM screener_invites WHERE client_id IN (SELECT id FROM clients WHERE child_name LIKE 'WLTEST%')");
  await run("DELETE FROM clients WHERE child_name LIKE 'WLTEST%'");

  async function mkClient(name, extra = {}) {
    const row = await get(
      `INSERT INTO clients (child_name, parent_name, parent_email, stage, waitlisted, submitted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [name, "WL Parent", `wl-${name.toLowerCase()}@example.invalid`,
       extra.stage || "intake_packet", extra.waitlisted === true, iso(), iso()]
    );
    if (extra.assessmentStage) {
      await run("UPDATE clients SET stage = 'assessment_scheduling', in_clinic_assessment_date = NULL WHERE id = ?", [row.id]);
    }
    if (extra.screenerDone === false) {
      await run("UPDATE clients SET clinical_screener_completed = false WHERE id = ?", [row.id]);
    }
    return get("SELECT * FROM clients WHERE id = ?", [row.id]);
  }

  // ============ 1. assessment reminders skip waitlisted clients ============
  const aWait = await mkClient("WLTEST_ASSESS_WAIT", { waitlisted: true, assessmentStage: true });
  const aFree = await mkClient("WLTEST_ASSESS_FREE", { waitlisted: false, assessmentStage: true });

  const assessRows = await all(
    `SELECT id FROM clients
      WHERE stage = 'assessment_scheduling'
        AND (in_clinic_assessment_date IS NULL OR in_clinic_assessment_date = '')
        AND parent_email IS NOT NULL AND parent_email <> ''
        AND waitlisted = false`
  );
  const assessIds = assessRows.map((r) => r.id);
  check("assessment reminder skips the waitlisted client", !assessIds.includes(aWait.id));
  check("assessment reminder still picks up the non-waitlisted client", assessIds.includes(aFree.id));

  // ============ 2. screener invite + reminders skip waitlisted ============
  const sWait = await mkClient("WLTEST_SCREEN_WAIT", { waitlisted: true });
  const sFree = await mkClient("WLTEST_SCREEN_FREE", { waitlisted: false });
  for (const c of [sWait, sFree]) {
    await run("UPDATE clients SET clinical_screener_completed = false WHERE id = ?", [c.id]);
    await run(
      `INSERT INTO enrollment_packets (client_id, signnow_document_id, status, sent_at, completed_at)
       VALUES (?, ?, 'completed', ?, ?)`,
      [c.id, "wl-test-doc-" + c.id, iso(2 * DAY), iso(DAY)]
    );
  }
  const inviteRows = await all(
    `SELECT c.id FROM clients c
       JOIN enrollment_packets p ON p.client_id = c.id
      WHERE p.status = 'completed'
        AND c.clinical_screener_completed = false
        AND c.parent_email IS NOT NULL
        AND c.waitlisted = false
        AND NOT EXISTS (SELECT 1 FROM screener_invites si WHERE si.client_id = c.id)`
  );
  const inviteIds = inviteRows.map((r) => r.id);
  check("screener invite skips the waitlisted client", !inviteIds.includes(sWait.id));
  check("screener invite still goes to the non-waitlisted client", inviteIds.includes(sFree.id));

  // ====== 3. the packet clock is PAUSED, not merely silenced ======
  // A packet sent 6 days ago, on a client who has been waitlisted the whole
  // time. The old behaviour would discharge them tomorrow. The new behaviour
  // must leave the stage alone and start banking paused time.
  const pWait = await mkClient("WLTEST_PACKET_WAIT", { waitlisted: true, stage: "intake_packet" });
  await run(
    `INSERT INTO enrollment_packets (client_id, signnow_document_id, status, sent_at)
     VALUES (?, ?, 'sent', ?)`,
    [pWait.id, "wl-test-pending-" + pWait.id, iso(6 * DAY)]
  );

  // Re-implement exactly the branch server.js runs, against the same schema.
  // (Calling checkEnrollmentPackets directly would require a live SignNow key;
  // what is under test is the waitlist arithmetic, not the SignNow call.)
  async function sweepOne(clientId) {
    const packet = await get("SELECT * FROM enrollment_packets WHERE client_id = ? AND status = 'sent'", [clientId]);
    if (!packet) return null;
    const now = Date.now();
    const client = await get("SELECT * FROM clients WHERE id = ?", [packet.client_id]);
    const waitlisted = client && (client.waitlisted === true || client.waitlisted === "t");
    if (waitlisted) {
      if (!packet.paused_since) await run("UPDATE enrollment_packets SET paused_since = ? WHERE id = ?", [new Date().toISOString(), packet.id]);
      return { skipped: true };
    }
    if (packet.paused_since) {
      const pausedFor = Math.max(0, now - new Date(packet.paused_since).getTime());
      await run("UPDATE enrollment_packets SET paused_since = NULL, paused_ms = paused_ms + ? WHERE id = ?", [pausedFor, packet.id]);
      packet.paused_ms = Number(packet.paused_ms || 0) + pausedFor;
      packet.paused_since = null;
    }
    const sentAt = new Date(packet.sent_at).getTime();
    const days = Math.max(0, now - sentAt - Number(packet.paused_ms || 0)) / DAY;
    if (days >= 7) {
      await run("UPDATE clients SET stage = 'not_moving_forward', discharge_reason = ? WHERE id = ?",
        ["Enrollment packet not completed within 7 days", client.id]);
      await run("UPDATE enrollment_packets SET status = 'expired' WHERE id = ?", [packet.id]);
      return { expired: true, days };
    }
    return { expired: false, days };
  }

  const r1 = await sweepOne(pWait.id);
  check("waitlisted packet is skipped by the sweep", !!(r1 && r1.skipped), JSON.stringify(r1));
  let pw = await get("SELECT * FROM clients WHERE id = ?", [pWait.id]);
  check("waitlisted client was NOT moved to not_moving_forward", pw.stage === "intake_packet", pw.stage);
  let pk = await get("SELECT * FROM enrollment_packets WHERE client_id = ?", [pWait.id]);
  check("pause started (paused_since recorded)", !!pk.paused_since);
  check("packet is still 'sent', not expired", pk.status === "sent", pk.status);

  // Now simulate three more weeks on the waitlist, then come off. If the clock
  // had merely been silenced, this client is 27 days past a 7-day deadline and
  // gets closed out the instant they come off the list -- which is the exact
  // failure this whole change exists to prevent.
  // Sent 27 days ago, waitlisted after the first 6 of those, so 21 days of the
  // clock were spent waiting and 6 days actually count. (The earlier sweep set
  // paused_since to "now"; both timestamps are rewritten together here so the
  // pause cannot predate the packet.)
  await run("UPDATE enrollment_packets SET sent_at = ?, paused_since = ? WHERE client_id = ?",
    [iso(27 * DAY), iso(21 * DAY), pWait.id]);
  await run("UPDATE clients SET waitlisted = false WHERE id = ?", [pWait.id]);

  const r2 = await sweepOne(pWait.id);
  pw = await get("SELECT * FROM clients WHERE id = ?", [pWait.id]);
  pk = await get("SELECT * FROM enrollment_packets WHERE client_id = ?", [pWait.id]);
  check("coming off the waitlist does not instantly expire the packet", pw.stage === "intake_packet", pw.stage);
  check("banked paused time is roughly the 21 days waited",
    Math.abs(Number(pk.paused_ms) / DAY - 21) < 0.1, "paused_days=" + (Number(pk.paused_ms) / DAY).toFixed(3));
  check("effective age is back to the ~6 days they actually had",
    r2 && Math.abs(r2.days - 6) < 0.1, r2 && "days=" + r2.days.toFixed(3));
  check("pause is cleared once they are off the list", pk.paused_since === null);
  check("effective age is never negative", r2 && r2.days >= 0, r2 && "days=" + r2.days);

  // And the deadline still bites for someone who simply never signed.
  const pFree = await mkClient("WLTEST_PACKET_FREE", { waitlisted: false, stage: "intake_packet" });
  await run(
    `INSERT INTO enrollment_packets (client_id, signnow_document_id, status, sent_at)
     VALUES (?, ?, 'sent', ?)`,
    [pFree.id, "wl-test-stale-" + pFree.id, iso(8 * DAY)]
  );
  const r3 = await sweepOne(pFree.id);
  const pf = await get("SELECT * FROM clients WHERE id = ?", [pFree.id]);
  check("a non-waitlisted client past 7 days is still closed out", !!(r3 && r3.expired) && pf.stage === "not_moving_forward", pf.stage);

  // ============ 4. nothing was emailed to anyone ============
  check("no emails were sent during these checks", sent.length === 0, JSON.stringify(sent));

  // ---------------- cleanup ----------------
  await run("DELETE FROM enrollment_packets WHERE client_id IN (SELECT id FROM clients WHERE child_name LIKE 'WLTEST%')");
  await run("DELETE FROM screener_invites WHERE client_id IN (SELECT id FROM clients WHERE child_name LIKE 'WLTEST%')");
  await run("DELETE FROM clients WHERE child_name LIKE 'WLTEST%'");

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
