// bcba-hub.js -- the BCBA Hub: a clinical reference area, not a client area.
//
// TWO THINGS LIVE HERE AND THEY ARE DELIBERATELY DIFFERENT IN KIND.
//
//   1. The Treatment Plan Cheat Sheet. Payer requirements converted from the
//      practice's Authorization & Treatment Plan Cheat Sheet. It is REFERENCE
//      DATA, shipped in bcba-cheatsheet-data.js, read-only over the API.
//   2. The Form Library. Blank forms the practice uploads and maintains
//      itself, so a form changing does not mean changing the CRM.
//
// NO CLIENT INFORMATION PASSES THROUGH THIS MODULE. The checklist a BCBA ticks
// while reviewing a plan is a review aid, not a record: it is never sent here
// and never stored, which is why there is no table for it. The forms are BLANK
// forms -- the same document you would print off a payer's website -- so
// nothing in data/bcba-forms is PHI.
//
// The Form Library is the SINGLE SOURCE OF TRUTH for a downloadable form. When
// the cheat sheet says a payer requires FA-11F and a form carrying that code
// exists here, the requirement links to that one file. There is no second copy
// kept beside the cheat sheet to fall out of date.
const fs = require("fs");
const path = require("path");

module.exports = function initBcbaHub(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json } = ctx;

  const CHEATSHEET = require("./bcba-cheatsheet-data.js");

  // Reading the hub. "clinical" is the BCBA role; billing is included because
  // the cheat sheet is about what an AUTHORIZATION REQUEST needs, which is the
  // work billing does alongside the BCBA. Nothing here is a client record, so
  // this is reference access rather than PHI access.
  const VIEW_ROLES = ["owner", "super_admin", "admin", "clinical", "billing"];
  // Maintaining the Form Library. Same set that administers users.
  const MANAGE_ROLES = ["owner", "admin", "super_admin"];
  const canView = (u) => !!u && VIEW_ROLES.includes(u.role);
  const canManage = (u) => !!u && MANAGE_ROLES.includes(u.role);

  const DATA_DIR = path.join(__dirname, "data");
  const FORM_DIR = path.join(DATA_DIR, "bcba-forms");

  const CATEGORIES = [
    { key: "assessments", label: "Assessments" },
    { key: "clinical", label: "Clinical" },
    { key: "parent", label: "Parent/Caregiver" },
    { key: "payer", label: "Insurance/Payer" },
    { key: "school", label: "School" },
    { key: "other", label: "Other" },
  ];
  const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

  const clean = (v) => String(v == null ? "" : v).trim();
  const MAX_UPLOAD = 20 * 1024 * 1024;

  async function initTables() {
    if (!fs.existsSync(FORM_DIR)) fs.mkdirSync(FORM_DIR, { recursive: true });
    await dbRun(`CREATE TABLE IF NOT EXISTS bcba_forms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'other',
      payer_key TEXT,
      form_code TEXT,
      editable BOOLEAN DEFAULT FALSE,
      stored_name TEXT,
      filename TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      archived_at TEXT,
      uploaded_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);
    await dbRun("CREATE INDEX IF NOT EXISTS bcba_forms_code_idx ON bcba_forms (form_code)").catch(() => {});
  }

  // ---- form codes -------------------------------------------------------
  // The cheat sheet names Nevada's forms by code ("Form FA-11E: ...", "or a
  // FA-11F"). Matching on the CODE rather than on the sentence is what lets a
  // requirement find its file without the two texts having to agree word for
  // word -- the cheat sheet spells the same form four different ways across
  // payers.
  const CODE_RE = /\bFA-?\s?(\d{1,3}[A-Z]?)\b/gi;
  function codesIn(text) {
    const out = [];
    let m;
    CODE_RE.lastIndex = 0;
    while ((m = CODE_RE.exec(String(text || "")))) out.push(("FA-" + m[1]).toUpperCase());
    return out;
  }
  const normCode = (v) => clean(v).toUpperCase().replace(/\s+/g, "").replace(/^FA(?!-)/, "FA-");

  function attachForms(lines, formsByCode) {
    return (lines || []).map((text) => {
      const hit = codesIn(text).map((c) => formsByCode.get(c)).find(Boolean);
      return hit
        ? { text, form: { id: hit.id, name: hit.name, editable: !!hit.editable, code: hit.form_code } }
        : { text, form: null };
    });
  }

  function isPrintable(mime, filename) {
    const m = clean(mime).toLowerCase();
    if (m === "application/pdf" || m.startsWith("image/")) return true;
    return /\.(pdf|png|jpe?g|gif|webp)$/i.test(clean(filename));
  }

  function shapeForm(r) {
    return {
      id: r.id,
      name: r.name,
      description: r.description || "",
      category: r.category || "other",
      category_label: (CATEGORIES.find((c) => c.key === r.category) || {}).label || "Other",
      payer_key: r.payer_key || null,
      payer_name: r.payer_key ? (CHEATSHEET.payers.find((p) => p.key === r.payer_key) || {}).name || null : null,
      form_code: r.form_code || null,
      editable: !!r.editable,
      // Only the actions that actually apply to this file are offered. A .docx
      // has no print view in a browser, so it is not given a Print button that
      // would open a download dialog and look broken.
      can_print: isPrintable(r.mime_type, r.filename),
      has_file: !!r.stored_name,
      filename: r.filename || null,
      mime_type: r.mime_type || null,
      size_bytes: r.size_bytes || 0,
      archived: !!r.archived_at,
      updated_at: r.updated_at || r.created_at || null,
      uploaded_by: r.uploaded_by || null,
    };
  }

  async function formsByCodeMap() {
    const rows = await dbAll(
      "SELECT * FROM bcba_forms WHERE archived_at IS NULL AND form_code IS NOT NULL AND form_code <> ''"
    ).catch(() => []);
    const map = new Map();
    for (const r of rows) if (!map.has(normCode(r.form_code))) map.set(normCode(r.form_code), r);
    return map;
  }

  async function readRaw(req) {
    const chunks = [];
    let size = 0;
    const tooBig = await new Promise((resolve) => {
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_UPLOAD) { resolve(true); req.destroy(); } else chunks.push(c);
      });
      req.on("end", () => resolve(false));
      req.on("error", () => resolve(true));
    });
    return { tooBig, buffer: Buffer.concat(chunks) };
  }

  // A stored name is generated here and never taken from the upload, so a
  // filename cannot walk out of the forms directory.
  function storedNameFor(id, filename) {
    const ext = path.extname(clean(filename)).slice(0, 10).replace(/[^.A-Za-z0-9]/g, "");
    return `form_${id}_${Date.now()}${ext}`;
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/bcba/")) return false;
    if (!canView(user)) { json(res, 403, { error: "The BCBA Hub is for clinical and administrative staff." }); return true; }

    // ---- the cheat sheet -------------------------------------------------
    if (pathname === "/api/bcba/cheatsheet" && method === "GET") {
      const byCode = await formsByCodeMap();
      json(res, 200, {
        payers: CHEATSHEET.payers.map((p) => ({
          ...p,
          // Requirements that name a form get that form attached, so the
          // download comes from the Form Library rather than a copy.
          required_documents: attachForms(p.required_documents, byCode),
          assessment_authorization: attachForms(p.assessment_authorization, byCode),
        })),
        categories: CATEGORIES,
        can_manage_forms: canManage(user),
      });
      return true;
    }

    // ---- the form library ------------------------------------------------
    if (pathname === "/api/bcba/forms" && method === "GET") {
      const showArchived = clean(query.archived) === "1" && canManage(user);
      const rows = await dbAll(
        showArchived
          ? "SELECT * FROM bcba_forms ORDER BY archived_at IS NULL DESC, name"
          : "SELECT * FROM bcba_forms WHERE archived_at IS NULL ORDER BY name"
      ).catch(() => []);
      json(res, 200, {
        forms: rows.map(shapeForm),
        categories: CATEGORIES,
        can_manage: canManage(user),
      });
      return true;
    }

    const fileMatch = pathname.match(/^\/api\/bcba\/forms\/(\d+)\/file$/);
    if (fileMatch && method === "GET") {
      const row = await dbGet("SELECT * FROM bcba_forms WHERE id = ?", [Number(fileMatch[1])]);
      if (!row || !row.stored_name) { json(res, 404, { error: "That form has no file." }); return true; }
      const full = path.join(FORM_DIR, path.basename(row.stored_name));
      if (!fs.existsSync(full)) { json(res, 404, { error: "That form's file is missing from the library." }); return true; }
      const inline = clean(query.disposition) === "inline";
      const safe = clean(row.filename || row.name).replace(/[^\w.\- ]+/g, "_") || "form";
      res.writeHead(200, {
        "Content-Type": row.mime_type || "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safe}"`,
        "Content-Length": fs.statSync(full).size,
      });
      fs.createReadStream(full).pipe(res);
      return true;
    }

    // Everything below changes the library.
    if (!canManage(user)) {
      if (method !== "GET") { json(res, 403, { error: "Only an owner or admin can change the Form Library." }); return true; }
      json(res, 404, { error: "Not found" });
      return true;
    }

    // Create: metadata on the query string, the file as the raw body -- the
    // same shape the onboarding portal uses, so there is no multipart parser
    // in this codebase to maintain.
    if (pathname === "/api/bcba/forms" && method === "POST") {
      const name = clean(query.name);
      if (!name) { json(res, 400, { error: "A form needs a name." }); return true; }
      const category = CATEGORY_KEYS.includes(clean(query.category)) ? clean(query.category) : "other";
      const payerKey = CHEATSHEET.payers.some((p) => p.key === clean(query.payer_key)) ? clean(query.payer_key) : null;
      const { tooBig, buffer } = await readRaw(req);
      if (tooBig) { json(res, 413, { error: "That file is larger than 20 MB." }); return true; }
      if (!buffer.length) { json(res, 400, { error: "That upload came through empty." }); return true; }

      const row = await dbGet(
        `INSERT INTO bcba_forms (name, description, category, payer_key, form_code, editable,
                                 filename, mime_type, size_bytes, uploaded_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        [name.slice(0, 200), clean(query.description).slice(0, 500), category, payerKey,
         normCode(query.form_code) || null, clean(query.editable) === "1",
         clean(query.filename).slice(0, 200) || "form", clean(query.mime) || "application/octet-stream",
         buffer.length, user.email || user.name || "unknown", nowISO(), nowISO()]
      );
      const stored = storedNameFor(row.id, query.filename);
      fs.writeFileSync(path.join(FORM_DIR, stored), buffer);
      await dbRun("UPDATE bcba_forms SET stored_name = ? WHERE id = ?", [stored, row.id]);
      json(res, 201, { form: shapeForm({ ...row, stored_name: stored }) });
      return true;
    }

    const idMatch = pathname.match(/^\/api\/bcba\/forms\/(\d+)$/);
    if (idMatch && method === "PATCH") {
      const id = Number(idMatch[1]);
      const existing = await dbGet("SELECT * FROM bcba_forms WHERE id = ?", [id]);
      if (!existing) { json(res, 404, { error: "Form not found" }); return true; }
      const b = await readBody(req);
      const sets = [], vals = [];
      const put = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };
      if (b.name !== undefined) {
        if (!clean(b.name)) { json(res, 400, { error: "A form needs a name." }); return true; }
        put("name", clean(b.name).slice(0, 200));
      }
      if (b.description !== undefined) put("description", clean(b.description).slice(0, 500));
      if (b.category !== undefined) put("category", CATEGORY_KEYS.includes(clean(b.category)) ? clean(b.category) : "other");
      if (b.payer_key !== undefined) {
        put("payer_key", CHEATSHEET.payers.some((p) => p.key === clean(b.payer_key)) ? clean(b.payer_key) : null);
      }
      if (b.form_code !== undefined) put("form_code", normCode(b.form_code) || null);
      if (b.editable !== undefined) put("editable", !!b.editable);
      // Archiving is reversible and keeps the row. A form that was required
      // last year is part of why a plan was written the way it was, so the
      // record of it having existed is not thrown away.
      if (b.archived !== undefined) put("archived_at", b.archived ? nowISO() : null);
      if (!sets.length) { json(res, 400, { error: "Nothing to change." }); return true; }
      put("updated_at", nowISO());
      vals.push(id);
      await dbRun(`UPDATE bcba_forms SET ${sets.join(", ")} WHERE id = ?`, vals);
      json(res, 200, { form: shapeForm(await dbGet("SELECT * FROM bcba_forms WHERE id = ?", [id])) });
      return true;
    }

    // Replace the file, keeping the same form and the same links to it from
    // the cheat sheet. This is the case the library exists for: a payer
    // reissues FA-11F and nobody should have to touch the CRM.
    const replaceMatch = pathname.match(/^\/api\/bcba\/forms\/(\d+)\/file$/);
    if (replaceMatch && method === "POST") {
      const id = Number(replaceMatch[1]);
      const existing = await dbGet("SELECT * FROM bcba_forms WHERE id = ?", [id]);
      if (!existing) { json(res, 404, { error: "Form not found" }); return true; }
      const { tooBig, buffer } = await readRaw(req);
      if (tooBig) { json(res, 413, { error: "That file is larger than 20 MB." }); return true; }
      if (!buffer.length) { json(res, 400, { error: "That upload came through empty." }); return true; }
      const stored = storedNameFor(id, query.filename || existing.filename);
      fs.writeFileSync(path.join(FORM_DIR, stored), buffer);
      await dbRun(
        `UPDATE bcba_forms SET stored_name = ?, filename = ?, mime_type = ?, size_bytes = ?, updated_at = ?
         WHERE id = ?`,
        [stored, clean(query.filename).slice(0, 200) || existing.filename, clean(query.mime) || existing.mime_type,
         buffer.length, nowISO(), id]
      );
      // The superseded file is left on disk rather than unlinked: a replace
      // made by mistake is recoverable, and these are blank forms, not PHI.
      json(res, 200, { form: shapeForm(await dbGet("SELECT * FROM bcba_forms WHERE id = ?", [id])) });
      return true;
    }

    // Deleting for real is only offered on a form that is already archived, so
    // a misclick on a live form costs nothing.
    if (idMatch && method === "DELETE") {
      const id = Number(idMatch[1]);
      const existing = await dbGet("SELECT * FROM bcba_forms WHERE id = ?", [id]);
      if (!existing) { json(res, 404, { error: "Form not found" }); return true; }
      if (!existing.archived_at) {
        json(res, 400, { error: "Archive this form first. Deleting is only offered on an archived form." });
        return true;
      }
      await dbRun("DELETE FROM bcba_forms WHERE id = ?", [id]);
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  return { initTables, handleApi, _lib: { CATEGORIES, codesIn, normCode, isPrintable, CHEATSHEET } };
};
