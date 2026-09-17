// Changing the email address a person signs in with.
//
// This exists because the CRM had no way to do it at all -- not in the UI, not
// in the API -- and the owner account was seeded as admin@spectrumsquadlv.com,
// a mailbox that hard-bounced on 7 August 2026. Every task reminder addressed
// to that account has been discarded since.
//
// The hard part is NOT the UPDATE on users.email. It is that this codebase uses
// a staff member's email address as a de-facto foreign key. Their employee
// record, the clients they are assigned to, the tasks they own, the supply
// requests they raised, the notes they wrote -- all of it is joined on the
// address, not on users.id. So a bare `UPDATE users SET email` silently
// detaches a person from their own work: they keep signing in, and their
// clients, tasks and staff record quietly stop being theirs.
//
// That is the exact failure this module has to avoid, so the change carries the
// references with it, inside one transaction. All of it lands or none of it
// does; a half-renamed person is worse than one who was never renamed.
//
// REFERENCES below is deliberately a declared list rather than SQL scattered
// through a function: it is the answer to "where is this person identified by
// their address", it can be read without tracing code, and the test suite
// checks it against the live schema so a column added later cannot quietly go
// uncarried.

"use strict";

module.exports = function initUserEmail(ctx) {
  const { pool, dbGet, dbAll, dbRun, nowISO } = ctx;

  // Where a STAFF MEMBER is identified by their email address. Each of these
  // moves when they do.
  const REFERENCES = [
    // Their staff record. Joined to the login by email in scheduling.js and in
    // the admin user list, so losing this link costs them their schedule and
    // their photo.
    { table: "hr_employees", column: "email", label: "staff record" },

    // Client assignment. These decide what a scoped (non-admin) user can SEE --
    // userAssignedToClient() and assignedClientIds() both match on the address.
    { table: "clients", column: "assigned_bcba_email", label: "clients where they are the BCBA" },
    { table: "clients", column: "assigned_billing_email", label: "clients where they handle billing" },
    { table: "clients", column: "assigned_student_analyst_email", label: "clients where they are the student analyst" },
    { table: "clients", column: "squad_leader_email", label: "clients where they are squad leader" },
    { table: "client_bips", column: "assigned_bcba_email", label: "BIPs assigned to them" },

    // Task ownership and the right to edit. created_by is not named *email but
    // holds one -- the can_edit rule in server.js compares it to user.email.
    { table: "staff_tasks", column: "assigned_email", label: "tasks assigned to them" },
    { table: "staff_tasks", column: "created_by", label: "tasks they created" },

    // "My requests" on the supply screen is this column matched to the login.
    { table: "supply_requests", column: "requester_email", label: "supply requests they raised" },

    // Their own record of what they have signed and what they own.
    { table: "crm_policy_acknowledgments", column: "employee_email", label: "policy acknowledgements" },
    { table: "grant_applications", column: "owner_email", label: "grants they own" },

    // Authorship. Rewritten rather than left behind, because these are how a
    // person finds the notes they wrote -- the address is an identifier here,
    // not a record of where something was sent.
    { table: "bip_notes", column: "author_email", label: "BIP notes they wrote" },
    { table: "bip_behavior_notes", column: "author_email", label: "behaviour notes they wrote" },
    { table: "bip_questions", column: "asked_by_email", label: "BIP questions they asked" },
  ];

  // Columns that hold an email address but are NOT this person's identity, and
  // must therefore stay exactly as they are. Two kinds:
  //
  //   * somebody else's address entirely (a parent, an applicant, a vendor) --
  //     rewriting one of these would be a data corruption bug with a
  //     confidentiality flavour;
  //   * a record of something that already happened (who was emailed, who was
  //     viewed-as, an email status). History is not updated when a person
  //     changes their address; it stays true about the moment it describes.
  //
  // Listed explicitly so the coverage test can insist that every email column
  // in the schema was considered by somebody, rather than merely not noticed.
  const NOT_IDENTITY = [
    // Other people
    "clients.parent_email", "emergency_contacts.email", "hr_applicants.email",
    "hr_applicants.consent_email", "crm_leads.contact_email",
    "event_community_partners.contact_email", "event_prospects.contact_email",
    "event_prospects.public_email", "event_vendors.contact_email",
    "events.public_contact_email", "event_outreach_messages.to_email",
    "event_outreach_suppression.email", "signnow_inventory.signer_emails",
    "newhire_packets.recipient_email", "ot_clients.eligibility_email_to",
    // A shared destination, not a person: a department mailbox may happen to
    // equal somebody's address without being their identity.
    "departments.notify_email",
    // History, and flags/timestamps that are not addresses at all
    "admin_view_as_log.owner_email", "admin_view_as_log.target_email",
    "auth_alerts.email_recipients", "auth_alerts.email_sent", "auth_alerts.email_sent_at",
    "clients.first_day_email_bcba", "clients.first_day_email_date", "clients.first_day_email_sent_at",
    "event_community_partners.email_families",
    "fidelity_checks.email_status", "fidelity_checks.emailed_at",
    "hr_attendance_reviews.emailed_to", "hr_supervision_logs.emailed_at",
    "rethink_verification_runs.email_status", "rethink_verification_runs.emailed_to",
    // This module's own audit trail. Emphatically history: rewriting the record
    // of a rename to use the renamed address would erase the only evidence of
    // what the address used to be, which is the one thing it is for.
    "user_email_changes.old_email", "user_email_changes.new_email",
    // Handled on its own terms: revoked rather than rewritten (see below).
    "password_reset_tokens.requested_email",
    // The login itself, updated first inside the transaction.
    "users.email",
  ];

  // Settings that name a person as a destination. Moved only when they exactly
  // match the old address, so an unrelated address is never touched.
  const SETTING_KEYS = [
    "owner_notification_email", "clinical_director_email",
    "rethink_verification_report_to", "hire_packet_recipient",
  ];

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS user_email_changes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      old_email TEXT NOT NULL,
      new_email TEXT NOT NULL,
      actor TEXT,
      moved TEXT,
      created_at TEXT
    )`);
  }

  const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();
  const VALID = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  // Validation that does not touch the database, so the route can reject a bad
  // request without opening a transaction. Returns an error string or null.
  function validate(newEmail, target) {
    const next = norm(newEmail);
    if (!next) return "An email address is required.";
    if (next.length > 320) return "That email address is too long.";
    if (!VALID.test(next)) return "Please enter a valid email address.";
    if (!target) return "User not found.";
    if (next === norm(target.email)) return "That is already their email address.";
    return null;
  }

  // The change itself. One transaction: either the person and everything that
  // identifies them moves, or nothing does.
  //
  // Sessions are deliberately NOT cleared. They key on users.id, not on the
  // address, so the change does not sign anybody out -- and signing the owner
  // out of the screen she is standing on, mid-edit, would be a hostile way to
  // end an operation that has already succeeded. Her next sign-in uses the new
  // address; the password is untouched.
  async function changeEmail({ targetId, newEmail, actorEmail }) {
    const target = await dbGet("SELECT id, name, email, role FROM users WHERE id = ?", [targetId]);
    const problem = validate(newEmail, target);
    if (problem) return { ok: false, error: problem };

    const next = norm(newEmail);
    const old = norm(target.email);

    const clash = await dbGet("SELECT id FROM users WHERE LOWER(email) = ?", [next]);
    if (clash) return { ok: false, error: "Another account already uses that email address.", conflict: true };

    const client = await pool.connect();
    const moved = [];
    try {
      await client.query("BEGIN");

      // The login first. If the UNIQUE constraint rejects it -- somebody else
      // took the address between the check above and here -- nothing else has
      // been touched yet and the rollback is trivial.
      await client.query("UPDATE users SET email = $1 WHERE id = $2", [next, target.id]);

      for (const ref of REFERENCES) {
        // Case- and whitespace-insensitive, because these columns are typed in
        // by hand in half the places they are set.
        const r = await client.query(
          `UPDATE ${ref.table} SET ${ref.column} = $1 WHERE LOWER(TRIM(${ref.column})) = $2`,
          [next, old]
        );
        if (r.rowCount > 0) moved.push({ ...ref, rows: r.rowCount });
      }

      const s = await client.query(
        `UPDATE app_settings SET value = $1
          WHERE key = ANY($2::text[]) AND LOWER(TRIM(value)) = $3`,
        [next, SETTING_KEYS, old]
      );
      if (s.rowCount > 0) {
        moved.push({ table: "app_settings", column: "value", label: "notification settings pointed at them", rows: s.rowCount });
      }

      // Revoked, not rewritten. A live reset token issued to the old address
      // would let whoever still receives mail there take the account over --
      // and the whole reason for this change is usually that nobody does.
      const t = await client.query(
        "DELETE FROM password_reset_tokens WHERE LOWER(TRIM(requested_email)) = $1",
        [old]
      );
      if (t.rowCount > 0) {
        moved.push({ table: "password_reset_tokens", column: "requested_email", label: "password reset links revoked", rows: t.rowCount });
      }

      await client.query(
        `INSERT INTO user_email_changes (user_id, old_email, new_email, actor, moved, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [target.id, old, next, actorEmail || null, JSON.stringify(moved), nowISO()]
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // Said plainly rather than swallowed: a change that half-happened and
      // reported success is the one outcome this module exists to prevent.
      console.error(`user email change failed (${old} -> ${next}):`, e.message);
      const duplicate = /duplicate key|unique/i.test(e.message || "");
      return {
        ok: false,
        error: duplicate
          ? "Another account already uses that email address."
          : "The change could not be completed, so nothing was changed.",
        conflict: duplicate,
      };
    } finally {
      client.release();
    }

    return { ok: true, user_id: target.id, name: target.name, old_email: old, new_email: next, moved };
  }

  async function history(userId, limit = 50) {
    const rows = await dbAll(
      userId
        ? "SELECT * FROM user_email_changes WHERE user_id = ? ORDER BY id DESC LIMIT ?"
        : "SELECT * FROM user_email_changes ORDER BY id DESC LIMIT ?",
      userId ? [userId, Number(limit) || 50] : [Number(limit) || 50]
    ).catch(() => []);
    return rows.map((r) => ({ ...r, moved: (() => { try { return JSON.parse(r.moved || "[]"); } catch { return []; } })() }));
  }

  return { initTables, changeEmail, history, validate, REFERENCES, NOT_IDENTITY, SETTING_KEYS };
};
