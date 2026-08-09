// signnow-import.js -- file the SignNow back-catalogue onto client and staff records.
//
// 212 signed documents live in SignNow and nowhere else: enrollment packets,
// treatment plans, FA-11E authorizations, offer letters, timecards. To see any
// of them today you log into a second system and search by half-remembered
// title.
//
// The whole risk here is one sentence: attaching a document to the wrong
// child's record. That is a HIPAA problem, not a tidiness problem. So this
// module is built around refusing to guess.
//
//   * Nothing is written until a human confirms. `preview` reads SignNow and
//     produces a plan; `commit` acts only on the ids it is handed.
//   * Every match carries the evidence that produced it and a confidence.
//     Below the bar the document is listed for a person to place by hand
//     rather than filed on a maybe.
//   * Nothing is silently dropped. Test documents, blank templates, superseded
//     timecards and unmatched files are all reported with a reason, so "not
//     imported" is always a visible decision rather than a gap.
//   * Importing twice is safe. Each SignNow id is recorded on import and
//     skipped forever after -- enforced by a unique index, not a check-then-
//     write, which races.
//
// On the PHI. Quiana chose to copy enrollment packets in knowing they carry
// SSNs and insurance cards. What that decision owes her, and what this does:
// files land under /app/data and never in PUBLIC_FILES (the static allowlist is
// the only thing stopping them being served as plain assets), they reach a
// browser solely through the existing authenticated document routes, and every
// commit is written to the audit log with who ran it. Nothing here ever
// attaches a document to an email.

"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function initSignNowImport(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, crypto, json, readBody,
    signNowRequest, signNowConfigured, signNowFetchRaw,
    DOCS_DIR, RESUME_DIR, logAudit,
  } = ctx;

  const IMPORT_ROLES = ["owner", "super_admin", "admin"];
  const canImport = (u) => !!u && IMPORT_ROLES.includes(u.role);

  // ---------------------------------------------------------------- schema
  async function initTables() {
    // The inventory is cached rather than re-read on every preview: filling in
    // the signer emails costs one API call per document, and 212 of those is
    // not something to repeat because somebody refreshed the page.
    await dbRun(`CREATE TABLE IF NOT EXISTS signnow_inventory (
      id SERIAL PRIMARY KEY,
      signnow_id TEXT NOT NULL UNIQUE,
      name TEXT,
      entity_type TEXT,
      signer_emails TEXT,            -- JSON array, lower-cased
      last_updated_at TEXT,
      fetch_error TEXT,
      fetched_at TEXT
    )`).catch((e) => console.error("signnow_inventory initTables:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS signnow_imported (
      id SERIAL PRIMARY KEY,
      signnow_id TEXT NOT NULL UNIQUE,
      target_type TEXT NOT NULL,     -- client | employee
      target_id INTEGER NOT NULL,
      document_row_id INTEGER,
      title TEXT,
      bytes INTEGER,
      imported_by TEXT,
      imported_at TEXT
    )`).catch((e) => console.error("signnow_imported initTables:", e.message));
  }

  // ---------------------------------------------------------------- helpers
  const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();
  const jparse = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };
  const norm = (s) => lower(s).replace(/[^a-z0-9]+/g, " ").trim();

  // Somebody testing the plumbing, not a real record. A list rather than a
  // silent filter, so any one of them can be overruled.
  const TEST_PATTERNS = [/\bzztest\b/i, /\btest\b/i, /\bdemo\b/i, /\bsample\b/i, /\bdelete ?verify\b/i, /\bpipelinev2\b/i];
  const looksLikeTest = (name) => TEST_PATTERNS.some((re) => re.test(String(name || "")));

  // A stock template with nobody attached, rather than a signed instance.
  const TEMPLATE_TITLES = new Set([
    "job offer letter", "job offer letter bcba", "job offer letter newest rbt", "job offer letter rbt",
    "new hire employee packet", "spectrum squad new patient enrollment packet",
    "class dojo photography waiver", "transportation waiver", "job application spectrum squad",
    "spectrum squad outing waiver", "release of client records spectrum squad",
    "spectrum squad student analyst agreement", "rbt offer letter",
  ]);

  function docKind(name) {
    const n = lower(name);
    if (/timecard|timesheet|hours|payroll/.test(n)) return "timecard";
    if (/offer letter|letter of intent|employ ?nv|voucher/.test(n)) return "offer";
    if (/new hire|credentialing|student analyst agreement|attendance & punctuality|job application/.test(n)) return "hr";
    if (/enrollment packet|new patient/.test(n)) return "enrollment";
    if (/treatment plan|initial assess|progress report|r?eauthorization|treatment request/.test(n)) return "clinical";
    if (/fa-?11/.test(n)) return "authorization";
    if (/behavior intervention|\bbip\b/.test(n)) return "bip";
    if (/waiver|consent|release|medical release/.test(n)) return "consent";
    return "other";
  }
  const CLIENT_KINDS = new Set(["enrollment", "clinical", "authorization", "bip", "consent"]);
  const STAFF_KINDS = new Set(["timecard", "offer", "hr"]);

  // ---------------------------------------------------------------- inventory
  async function refreshInventory() {
    if (!signNowConfigured || !signNowConfigured()) {
      throw new Error("SignNow is not connected on the server, so there is nothing to read.");
    }
    const found = [];
    let offset = 0;
    for (let page = 0; page < 25; page++) {   // a bound, not a limit: 25 x 100 >> 212
      let res;
      try {
        res = await signNowRequest(`/user/documentsv2?limit=100&offset=${offset}`);
      } catch (e) {
        // Older accounts expose the classic listing instead. Try it once rather
        // than failing the whole import over an endpoint name.
        res = await signNowRequest(`/user/documents?limit=100&offset=${offset}`);
      }
      const groups = Array.isArray(res) ? res : (res.document_groups || res.documents || []);
      if (!groups.length) break;
      for (const g of groups) {
        const participants = (g.invite && g.invite.participants) || [];
        found.push({
          signnow_id: g.id,
          name: g.name || g.document_name || "",
          entity_type: g.entity_type || "document",
          emails: participants.map((p) => lower(p.email)).filter(Boolean),
          last_updated: g.last_updated ? new Date(Number(g.last_updated) * 1000).toISOString() : null,
          needsFetch: participants.length === 0,
        });
      }
      if (Array.isArray(res) ? groups.length < 100 : !res.has_more) break;
      offset += 100;
    }

    // Fill in the signer emails the listing did not carry. Sequential on
    // purpose: this runs once, and hammering the API in parallel is how an
    // account gets rate-limited halfway through.
    for (const d of found) {
      if (!d.needsFetch) continue;
      try {
        const full = await signNowRequest(`/document/${d.signnow_id}`);
        const emails = new Set();
        for (const i of (full.field_invites || full.requests || [])) {
          if (i.email) emails.add(lower(i.email));
          if (i.signer_email) emails.add(lower(i.signer_email));
        }
        d.emails = [...emails];
      } catch (e) {
        // Unreadable is not the same as absent. It keeps its row so it still
        // shows up in the "place this by hand" list.
        d.fetchError = e.message;
      }
    }

    for (const d of found) {
      await dbRun(
        `INSERT INTO signnow_inventory (signnow_id, name, entity_type, signer_emails, last_updated_at, fetch_error, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (signnow_id) DO UPDATE SET
           name = EXCLUDED.name, entity_type = EXCLUDED.entity_type,
           signer_emails = EXCLUDED.signer_emails, last_updated_at = EXCLUDED.last_updated_at,
           fetch_error = EXCLUDED.fetch_error, fetched_at = EXCLUDED.fetched_at`,
        [d.signnow_id, d.name, d.entity_type, JSON.stringify(d.emails || []),
         d.last_updated, d.fetchError || null, nowISO()]
      );
    }
    return { total: found.length, unreadable: found.filter((d) => d.fetchError).length };
  }

  // ---------------------------------------------------------------- matching
  //
  // Confidence is deliberately coarse. There are two useful states -- "sure
  // enough to file without a human reading it" and "not sure" -- and pretending
  // to more precision than that would only make a wrong match look considered.
  //
  //   exact   signer email matched a record. The only identifier in this data
  //           that cannot mean two people.
  //   strong  full name in the title, or the four-letter initials convention.
  //   weak    a first name only. Never auto-filed: first names repeat, and the
  //           cost of being wrong is a stranger's SSN on a child's record.
  function buildIndex(clients, employees) {
    const byEmail = new Map();
    for (const c of clients) {
      if (c.parent_email) byEmail.set(lower(c.parent_email), { type: "client", id: c.id, name: c.child_name });
    }
    for (const e of employees) {
      if (e.email) byEmail.set(lower(e.email), { type: "employee", id: e.id, name: e.name });
    }
    return { byEmail };
  }

  // "Hudson Holland" -> "huho". The convention the BIP import already used.
  function initialsOf(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return null;
    return (parts[0].slice(0, 2) + parts[parts.length - 1].slice(0, 2)).toLowerCase();
  }

  function matchOne(doc, clients, employees, index) {
    const title = doc.name || "";
    const nTitle = norm(title);
    const kind = docKind(title);
    const emails = jparse(doc.signer_emails, []);

    // 1. Signer email. Exact, and it beats everything else.
    for (const em of emails) {
      const hit = index.byEmail.get(em);
      if (hit) {
        return { ...hit, confidence: "exact", evidence: `Signed by ${em}`, kind };
      }
    }

    // Which side of the house this document belongs to, used to stop a staff
    // name matching a client document and vice versa.
    const wantClient = CLIENT_KINDS.has(kind);
    const wantStaff = STAFF_KINDS.has(kind);

    // 2. Full name in the title.
    const nameHits = [];
    if (!wantStaff) {
      for (const c of clients) {
        if (c.child_name && nTitle.includes(norm(c.child_name))) {
          nameHits.push({ type: "client", id: c.id, name: c.child_name, evidence: `"${c.child_name}" in the title` });
        }
      }
    }
    if (!wantClient) {
      for (const e of employees) {
        if (e.name && nTitle.includes(norm(e.name))) {
          nameHits.push({ type: "employee", id: e.id, name: e.name, evidence: `"${e.name}" in the title` });
        }
      }
    }
    if (nameHits.length === 1) return { ...nameHits[0], confidence: "strong", kind };
    if (nameHits.length > 1) {
      return { type: null, confidence: "ambiguous", kind,
        evidence: `Title matches more than one person: ${nameHits.map((h) => h.name).join(", ")}` };
    }

    // 3. Four-letter client initials at the start of the title -- "HuHo", and
    //    the spaced variant "Ja Ba" that SignNow titles also use.
    if (!wantStaff) {
      const lead = nTitle.split(" ").slice(0, 2).join("");
      const initHits = clients.filter((c) => {
        const ini = initialsOf(c.child_name);
        return ini && (lead.startsWith(ini) || nTitle.startsWith(ini));
      });
      if (initHits.length === 1) {
        return { type: "client", id: initHits[0].id, name: initHits[0].child_name, confidence: "strong", kind,
          evidence: `Title starts with "${initialsOf(initHits[0].child_name)}" — the initials convention` };
      }
      if (initHits.length > 1) {
        return { type: null, confidence: "ambiguous", kind,
          evidence: `Those initials fit more than one client: ${initHits.map((c) => c.child_name).join(", ")}` };
      }
    }

    // 4. Email local-part embedded in the title -- "..._1_dgomm", "_lgilbert".
    if (!wantClient) {
      const localHits = employees.filter((e) => {
        const localPart = lower(e.email).split("@")[0];
        return localPart && localPart.length >= 4 && nTitle.includes(localPart);
      });
      if (localHits.length === 1) {
        return { type: "employee", id: localHits[0].id, name: localHits[0].name, confidence: "strong", kind,
          evidence: `Title contains "${lower(localHits[0].email).split("@")[0]}"` };
      }
    }

    // 5. First name only. Reported, never auto-filed.
    const firstHits = [];
    if (!wantClient) {
      for (const e of employees) {
        const first = norm(String(e.name || "").split(/\s+/)[0]);
        if (first && first.length >= 3 && new RegExp(`(^| )${first}( |$|'s)`).test(nTitle)) {
          firstHits.push({ type: "employee", id: e.id, name: e.name });
        }
      }
    }
    if (firstHits.length === 1) {
      return { ...firstHits[0], confidence: "weak", kind,
        evidence: `Only a first name to go on — "${String(firstHits[0].name).split(/\s+/)[0]}"` };
    }
    if (firstHits.length > 1) {
      return { type: null, confidence: "ambiguous", kind,
        evidence: `That first name fits ${firstHits.length} people: ${firstHits.map((h) => h.name).join(", ")}` };
    }

    return { type: null, confidence: "none", kind, evidence: "Nothing in the title or the signer identifies anyone" };
  }

  // ---------------------------------------------------------------- preview
  async function buildPreview() {
    const inventory = await dbAll("SELECT * FROM signnow_inventory ORDER BY last_updated_at DESC NULLS LAST, id DESC");
    const already = new Set((await dbAll("SELECT signnow_id FROM signnow_imported")).map((r) => r.signnow_id));
    const clients = await dbAll("SELECT id, child_name, parent_email, stage FROM clients");
    const employees = await dbAll("SELECT id, name, email, role_title FROM hr_employees WHERE COALESCE(status,'active') <> 'terminated'");
    const index = buildIndex(clients, employees);

    const plan = { ready: [], needsYou: [], skipped: [], alreadyImported: [] };

    // Timecards are kept most-recent-per-person; the rest stay in SignNow.
    // Collected first so the decision can see the whole set at once.
    const timecards = [];

    for (const doc of inventory) {
      const base = {
        signnow_id: doc.signnow_id, title: doc.name,
        signer_emails: jparse(doc.signer_emails, []),
        last_updated_at: doc.last_updated_at,
        kind: docKind(doc.name),
      };

      if (already.has(doc.signnow_id)) { plan.alreadyImported.push({ ...base, reason: "Already filed by a previous run" }); continue; }
      if (looksLikeTest(doc.name)) { plan.skipped.push({ ...base, reason: "Looks like a test document" }); continue; }
      if (doc.fetch_error) { plan.needsYou.push({ ...base, reason: `SignNow would not return this one: ${doc.fetch_error}` }); continue; }

      const m = matchOne(doc, clients, employees, index);

      // A stock template with no signer is the blank, not somebody's copy.
      if (!m.type && TEMPLATE_TITLES.has(norm(doc.name)) && !base.signer_emails.length) {
        plan.skipped.push({ ...base, reason: "Blank template, nobody signed it" });
        continue;
      }

      const row = { ...base, match: m };
      if (m.kind === "timecard" && m.type === "employee") { timecards.push(row); continue; }

      if (m.type && (m.confidence === "exact" || m.confidence === "strong")) plan.ready.push(row);
      else plan.needsYou.push({ ...row, reason: m.evidence });
    }

    // Most recent timecard per person; the rest are reported as superseded so
    // the count still adds up rather than quietly shrinking.
    const newestByEmployee = new Map();
    for (const t of timecards) {
      const k = t.match.id;
      const cur = newestByEmployee.get(k);
      if (!cur || String(t.last_updated_at || "") > String(cur.last_updated_at || "")) newestByEmployee.set(k, t);
    }
    for (const t of timecards) {
      if (newestByEmployee.get(t.match.id) === t) plan.ready.push(t);
      else plan.skipped.push({ ...t, reason: `Older timecard for ${t.match.name} — only the most recent is filed` });
    }

    return {
      counts: {
        total: inventory.length,
        ready: plan.ready.length,
        needsYou: plan.needsYou.length,
        skipped: plan.skipped.length,
        alreadyImported: plan.alreadyImported.length,
      },
      clients: clients.length,
      employees: employees.length,
      ...plan,
    };
  }

  // ---------------------------------------------------------------- commit
  async function importOne(signnowId, target, actor) {
    const inv = await dbGet("SELECT * FROM signnow_inventory WHERE signnow_id = ?", [signnowId]);
    if (!inv) return { ok: false, error: "Not in the inventory — refresh it first." };
    const existing = await dbGet("SELECT id FROM signnow_imported WHERE signnow_id = ?", [signnowId]);
    if (existing) return { ok: false, already: true, error: "Already filed." };

    let buffer;
    try {
      buffer = await signNowFetchRaw(`/document/${signnowId}/download?type=collapsed&with_history=0`);
    } catch (e) {
      return { ok: false, error: `Could not download it from SignNow: ${e.message}` };
    }
    if (!buffer || !buffer.length) return { ok: false, error: "SignNow returned an empty file." };

    const safe = String(inv.name || "document").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const stored = `signnow_${signnowId.slice(0, 10)}_${crypto.randomBytes(4).toString("hex")}_${safe}.pdf`;
    const label = `${inv.name} (from SignNow)`;

    let docRowId = null;
    if (target.type === "client") {
      const client = await dbGet("SELECT id FROM clients WHERE id = ?", [target.id]);
      if (!client) return { ok: false, error: "That client no longer exists." };
      fs.writeFileSync(path.join(DOCS_DIR, stored), buffer);
      const row = await dbGet(
        `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, external_url, uploaded_at)
         VALUES (?, ?, ?, 'application/pdf', ?, 'hosted', NULL, ?) RETURNING id`,
        [target.id, label, `${safe}.pdf`, stored, nowISO()]
      );
      docRowId = row.id;
    } else if (target.type === "employee") {
      const emp = await dbGet("SELECT id FROM hr_employees WHERE id = ?", [target.id]);
      if (!emp) return { ok: false, error: "That staff member no longer exists." };
      fs.writeFileSync(path.join(RESUME_DIR, stored), buffer);
      const row = await dbGet(
        `INSERT INTO hr_documents (employee_id, kind, filename, stored_name, mime_type, created_at)
         VALUES (?, 'signnow', ?, ?, 'application/pdf', ?) RETURNING id`,
        [target.id, `${safe}.pdf`, stored, nowISO()]
      );
      docRowId = row.id;
    } else {
      return { ok: false, error: "No destination given." };
    }

    await dbRun(
      `INSERT INTO signnow_imported (signnow_id, target_type, target_id, document_row_id, title, bytes, imported_by, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (signnow_id) DO NOTHING`,
      [signnowId, target.type, target.id, docRowId, inv.name, buffer.length, actor, nowISO()]
    );
    if (typeof logAudit === "function") {
      await logAudit(actor, "signnow_import", target.type, target.id,
        `Filed "${inv.name}" (${Math.round(buffer.length / 1024)} KB) from SignNow`).catch(() => {});
    }
    return { ok: true, bytes: buffer.length, document_row_id: docRowId };
  }

  // ---------------------------------------------------------------- routes
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/signnow-import")) return false;
    if (!user) return json(res, 401, { error: "Not authenticated" });
    if (!canImport(user)) return json(res, 403, { error: "Not permitted" });

    if (pathname === "/api/signnow-import/refresh" && method === "POST") {
      try {
        const r = await refreshInventory();
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (pathname === "/api/signnow-import/preview" && method === "GET") {
      const inv = await dbGet("SELECT COUNT(*) AS n FROM signnow_inventory");
      if (!Number(inv.n)) {
        return json(res, 200, { empty: true, message: "Nothing read from SignNow yet — run the scan first." });
      }
      return json(res, 200, await buildPreview());
    }

    // Commit takes an explicit list. There is deliberately no "import
    // everything" shortcut: the ids in the body are the record of what a human
    // actually agreed to.
    if (pathname === "/api/signnow-import/commit" && method === "POST") {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json(res, 400, { error: "Nothing was selected to import." });
      const actor = user.email || user.name || "unknown";
      const results = [];
      for (const it of items.slice(0, 500)) {
        const r = await importOne(String(it.signnow_id), { type: it.target_type, id: Number(it.target_id) }, actor)
          .catch((e) => ({ ok: false, error: e.message }));
        results.push({ signnow_id: it.signnow_id, ...r });
      }
      return json(res, 200, {
        ok: true,
        imported: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok && !r.already).length,
        skipped: results.filter((r) => r.already).length,
        bytes: results.reduce((s, r) => s + (r.bytes || 0), 0),
        results,
      });
    }

    return false;
  }

  return { initTables, handleApi, refreshInventory, buildPreview, importOne, canImport, _internal: { matchOne, docKind, looksLikeTest, initialsOf, buildIndex } };
};
