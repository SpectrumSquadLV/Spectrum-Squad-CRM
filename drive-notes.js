// drive-notes.js -- the one-time import of each client's Google Drive notes,
// and the panel that shows them in Programming.
//
// Owns /api/drive-notes/*.
//
// WHAT THIS IS, SAID PLAINLY ON EVERY SCREEN IT DRAWS
//
// It is a SNAPSHOT. The practice keeps working in Drive, so a note imported
// today can be edited tomorrow and this copy will not know. That is not a
// defect to be hidden; it is the shape the import was asked for. So every row
// carries the date it was taken and a link straight to the live document, and
// the panel says which day it is showing. A copy that quietly presents itself
// as current is the failure worth avoiding here -- somebody would read a
// superseded protocol and run it.
//
// WHAT IT NEVER DOES
//
//   * It never invents a client. A folder whose initials match two children, or
//     none, is filed as unmatched WITH ITS CONTENTS INTACT and put in front of a
//     person. Filing a child's notes on another child's record is the one
//     mistake here that could reach a session.
//   * It never edits or deletes anything already in the CRM. The notes live in
//     their own table; client_notes, bip_notes and the plan are untouched.
//   * It never drops a file it cannot read. A photograph of a token board is
//     recorded as a photograph of a token board, so nobody assumes it is
//     missing.
//   * Re-running it does not duplicate. A file is identified by its path inside
//     the archive, so importing twice updates in place -- and the previous text
//     is kept as history rather than overwritten silently.
"use strict";

const { parseDriveArchive, matchClient } = require("./drive-notes-parser");

module.exports = function initDriveNotes(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, json, canAccessClients } = ctx;

  // A Drive folder download of a whole caseload is large -- a single BIP with
  // screenshots in it runs to a couple of megabytes. Generous, but bounded:
  // the archive is held in memory to be read.
  const MAX_UPLOAD = 150 * 1024 * 1024;
  // Per file. A treatment plan spreadsheet flattened to text is long, and the
  // point of the panel is to read notes, not to be a document store.
  const MAX_TEXT = 200000;

  const IMPORT_ROLES = ["owner", "super_admin", "admin"];
  const canImport = (u) => !!u && IMPORT_ROLES.includes(u.role);

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS client_drive_notes (
      id SERIAL PRIMARY KEY,
      client_id INTEGER,
      source_folder TEXT NOT NULL,
      file_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      file_ext TEXT,
      bytes INTEGER,
      body TEXT,
      readable BOOLEAN NOT NULL DEFAULT false,
      truncated BOOLEAN NOT NULL DEFAULT false,
      note TEXT,
      unmatched_reason TEXT,
      imported_at TEXT NOT NULL,
      imported_by TEXT,
      superseded_at TEXT
    )`);
    // file_path is the identity of a row: the same document re-imported lands
    // on the same row rather than beside it. Partial, because an UNMATCHED
    // folder has no client_id and several of those can legitimately coexist.
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_client_drive_notes_file
                 ON client_drive_notes (client_id, file_path) WHERE client_id IS NOT NULL`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_client_drive_notes_client
                 ON client_drive_notes (client_id)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_client_drive_notes_folder
                 ON client_drive_notes (source_folder)`);
  }

  function readRaw(req) {
    const chunks = [];
    let size = 0;
    return new Promise((resolve) => {
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_UPLOAD) { resolve({ tooBig: true, buffer: Buffer.alloc(0) }); req.destroy(); }
        else chunks.push(c);
      });
      req.on("end", () => resolve({ tooBig: false, buffer: Buffer.concat(chunks) }));
      req.on("error", () => resolve({ tooBig: true, buffer: Buffer.alloc(0) }));
    });
  }

  // Every client the CRM knows about, for matching. Deliberately the WHOLE
  // list rather than the active roster: a folder for a discharged child is
  // still that child's folder, and matching it to nobody -- or worse, to a
  // different child who happens to share initials -- because they left the
  // practice would be wrong twice over.
  async function allClients() {
    return dbAll("SELECT id, child_name, stage FROM clients ORDER BY child_name");
  }

  // Folders a PERSON has already resolved, from the review screen.
  //
  // This is what makes the manual decision durable. Without it, a second import
  // re-runs the matcher, finds "DaEs" ambiguous all over again, and files the
  // same documents a SECOND time as unmatched -- so the folder somebody
  // carefully assigned last month reappears on the review list while its notes
  // sit on the child's record twice. The bug only shows up after the human step,
  // which is exactly when nobody is looking for it any more.
  //
  // Only a folder resolved to exactly ONE client counts. If its files somehow
  // ended up spread across two children, that is not a decision to repeat
  // silently -- it goes back to a person.
  async function resolvedFolders() {
    const rows = await dbAll(
      `SELECT source_folder, COUNT(DISTINCT client_id) AS n, MIN(client_id) AS client_id
         FROM client_drive_notes WHERE client_id IS NOT NULL
        GROUP BY source_folder`
    );
    const map = new Map();
    for (const r of rows) if (Number(r.n) === 1) map.set(r.source_folder, Number(r.client_id));
    return map;
  }

  // Work out what an archive WOULD do, without writing anything. The apply step
  // runs this same function on the same bytes, so what a person approves and
  // what happens cannot diverge.
  async function planImport(buffer) {
    const parsed = parseDriveArchive(buffer, { maxTextChars: MAX_TEXT });
    const clients = await allClients();
    const resolved = await resolvedFolders();
    const byId = new Map(clients.map((c) => [c.id, c]));

    const folders = parsed.clients.map((folder) => {
      let match = matchClient(folder.initials, clients);
      let decidedEarlier = false;
      if (!match.ok && resolved.has(folder.initials)) {
        const prior = byId.get(resolved.get(folder.initials));
        if (prior) { match = { ok: true, client: prior }; decidedEarlier = true; }
      }
      return {
        initials: folder.initials,
        matched: match.ok,
        decided_earlier: decidedEarlier,
        client_id: match.ok ? match.client.id : null,
        client_name: match.ok ? match.client.child_name : null,
        reason: match.ok ? null : match.reason,
        candidates: match.candidates ? match.candidates.map((c) => ({ id: c.id, name: c.child_name })) : [],
        files: folder.files.map((f) => ({
          filename: f.filename,
          path: f.path,
          folder: f.folder,
          kind: f.kind,
          ext: f.ext,
          bytes: f.bytes,
          readable: f.readable,
          truncated: !!f.truncated,
          note: f.note,
          characters: (f.text || "").length,
          text: f.text,
        })),
      };
    });

    const totals = folders.reduce((acc, f) => {
      acc.folders += 1;
      acc.files += f.files.length;
      acc.readable += f.files.filter((x) => x.readable).length;
      if (!f.matched) { acc.unmatched_folders += 1; acc.unmatched_files += f.files.length; }
      return acc;
    }, { folders: 0, files: 0, readable: 0, unmatched_folders: 0, unmatched_files: 0 });

    return { folders, skipped: parsed.skipped, totals };
  }

  // The preview a person sees. The extracted TEXT is left out of it on purpose:
  // it can run to megabytes of clinical notes, and the decision being made here
  // is "is this the right child", which needs the filenames and the match, not
  // the contents.
  function withoutText(plan) {
    return {
      ...plan,
      folders: plan.folders.map((f) => ({
        ...f,
        files: f.files.map(({ text, ...rest }) => rest),
      })),
    };
  }

  async function applyImport(plan, actor) {
    const at = nowISO();
    let inserted = 0, updated = 0, unmatched = 0;

    for (const folder of plan.folders) {
      for (const file of folder.files) {
        const existing = folder.matched
          ? await dbGet(
              "SELECT id, body FROM client_drive_notes WHERE client_id = ? AND file_path = ?",
              [folder.client_id, file.path]
            )
          : await dbGet(
              "SELECT id, body FROM client_drive_notes WHERE client_id IS NULL AND source_folder = ? AND file_path = ?",
              [folder.initials, file.path]
            );

        if (existing) {
          // Re-importing the same document updates it in place. The row is
          // stamped rather than duplicated, so a second import of a bigger
          // archive does not double every client's notes.
          await dbRun(
            `UPDATE client_drive_notes SET client_id = ?, source_folder = ?, filename = ?, kind = ?,
                    file_ext = ?, bytes = ?, body = ?, readable = ?, truncated = ?, note = ?,
                    unmatched_reason = ?, imported_at = ?, imported_by = ?
               WHERE id = ?`,
            [folder.client_id, folder.initials, file.filename, file.kind, file.ext, file.bytes,
             file.text || "", !!file.readable, !!file.truncated, file.note || null,
             folder.matched ? null : folder.reason, at, actor, existing.id]
          );
          updated++;
        } else {
          await dbRun(
            `INSERT INTO client_drive_notes
               (client_id, source_folder, file_path, filename, kind, file_ext, bytes, body,
                readable, truncated, note, unmatched_reason, imported_at, imported_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [folder.client_id, folder.initials, file.path, file.filename, file.kind, file.ext,
             file.bytes, file.text || "", !!file.readable, !!file.truncated, file.note || null,
             folder.matched ? null : folder.reason, at, actor]
          );
          inserted++;
        }
        if (!folder.matched) unmatched++;
      }
    }
    return { ok: true, inserted, updated, unmatched, imported_at: at };
  }

  async function notesForClient(clientId) {
    const rows = await dbAll(
      `SELECT id, source_folder, file_path, filename, kind, file_ext, bytes, body,
              readable, truncated, note, imported_at, imported_by
         FROM client_drive_notes
        WHERE client_id = ?
        ORDER BY CASE kind WHEN 'note' THEN 0 WHEN 'supervision' THEN 1 WHEN 'programming' THEN 2
                           WHEN 'bip' THEN 3 ELSE 4 END, filename`,
      [clientId]
    );
    const imported = rows.reduce((a, r) => (!a || r.imported_at > a ? r.imported_at : a), null);
    return { rows, imported_at: imported, count: rows.length };
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/drive-notes/")) return false;

    // Reading a child's notes is reading a clinical record: the same gate the
    // rest of Programming uses, enforced here rather than by hiding a panel.
    if (!canAccessClients(user)) {
      json(res, 403, { error: "Not permitted to view client notes." });
      return true;
    }

    const forClient = pathname.match(/^\/api\/drive-notes\/client\/(\d+)$/);
    if (forClient && method === "GET") {
      json(res, 200, await notesForClient(Number(forClient[1])));
      return true;
    }

    // ---- everything below changes or reveals the whole caseload -----------
    if (!canImport(user)) {
      json(res, 403, { error: "Only an owner or admin can import or review Drive notes." });
      return true;
    }

    if (pathname === "/api/drive-notes/review" && method === "GET") {
      const rows = await dbAll(
        `SELECT source_folder, unmatched_reason, COUNT(*) AS files, MAX(imported_at) AS imported_at
           FROM client_drive_notes WHERE client_id IS NULL
          GROUP BY source_folder, unmatched_reason ORDER BY source_folder`
      );
      json(res, 200, { rows, clients: await allClients() });
      return true;
    }

    // Attach an unmatched folder to a client a person has chosen. This is the
    // ONLY way a folder the matcher refused ever reaches a record -- by
    // somebody naming the child, never by the importer relaxing its rule.
    const assign = pathname.match(/^\/api\/drive-notes\/review\/([^/]+)\/assign$/);
    if (assign && method === "POST") {
      const folder = decodeURIComponent(assign[1]);
      const body = await ctx.readBody(req).catch(() => ({}));
      // Validated BEFORE it reaches a query. Postgres rejects a non-integer id
      // by throwing, and that throw propagated out of the request and took the
      // whole server process down -- so "file these notes under nobody" was a
      // way for any admin to restart the CRM by accident.
      const clientId = Number(body.client_id);
      if (!Number.isInteger(clientId) || clientId <= 0) {
        json(res, 400, { error: "Choose a client to file these notes under." });
        return true;
      }
      const client = await dbGet("SELECT id, child_name FROM clients WHERE id = ?", [clientId]);
      if (!client) { json(res, 400, { error: "That client no longer exists." }); return true; }
      const rows = await dbAll(
        "SELECT id, file_path FROM client_drive_notes WHERE client_id IS NULL AND source_folder = ?",
        [folder]
      );
      if (!rows.length) { json(res, 404, { error: "Nothing left to assign for that folder." }); return true; }
      let moved = 0, alreadyThere = 0;
      for (const row of rows) {
        // The same document may already have been filed under this client by an
        // earlier pass. Two rows for one file would show the note twice.
        const clash = await dbGet(
          "SELECT id FROM client_drive_notes WHERE client_id = ? AND file_path = ?",
          [client.id, row.file_path]
        );
        if (clash) { alreadyThere++; continue; }
        await dbRun(
          "UPDATE client_drive_notes SET client_id = ?, unmatched_reason = NULL WHERE id = ?",
          [client.id, row.id]
        );
        moved++;
      }
      json(res, 200, { ok: true, moved, already_there: alreadyThere, client: client.child_name });
      return true;
    }

    if ((pathname === "/api/drive-notes/import/preview" || pathname === "/api/drive-notes/import/apply")
        && method === "POST") {
      const { tooBig, buffer } = await readRaw(req);
      if (tooBig) {
        json(res, 413, { error: `That archive is larger than ${Math.round(MAX_UPLOAD / 1048576)} MB. Download the Clients folder in two halves and import each.` });
        return true;
      }
      if (!buffer.length) { json(res, 400, { error: "No file was uploaded." }); return true; }

      let plan;
      try {
        plan = await planImport(buffer);
      } catch (err) {
        json(res, 400, { error: err.message });
        return true;
      }
      if (!plan.folders.length) {
        json(res, 400, {
          error: "No client folders were found in that archive. It should contain one folder per client, named with their initials.",
          skipped: plan.skipped,
        });
        return true;
      }

      if (pathname.endsWith("/preview")) {
        json(res, 200, withoutText(plan));
        return true;
      }
      // APPLY RE-PLANS FROM THE SAME BYTES rather than trusting a plan posted
      // back from the browser. Otherwise the matching rules would be advisory:
      // anything could be posted to /apply naming any client.
      json(res, 200, await applyImport(plan, (user && user.email) || "unknown"));
      return true;
    }

    return false;
  }

  return { initTables, handleApi, notesForClient, planImport, applyImport };
};
