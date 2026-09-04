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
  const edits = require("./bcba-cheatsheet-edits.js");

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
  const LOGO_DIR = path.join(DATA_DIR, "bcba-payer-logos");
  const crypto = require("crypto");

  const LOGO_EXT = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
    "image/webp": ".webp", "image/svg+xml": ".svg",
  };
  const extFor = (mime) => LOGO_EXT[mime] || ".bin";

  // Checked by MAGIC BYTES, not by the type the uploader declared. This file is
  // served back to every person who opens the Hub, so "it said it was a PNG" is
  // not good enough -- a mislabelled file would be handed out under an image
  // content type. SVG is text and has no magic number, so it is matched on its
  // root element instead.
  function looksLikeImage(buf, mime) {
    if (!buf || buf.length < 12) return false;
    const b = buf;
    switch (mime) {
      case "image/png":
        return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
      case "image/jpeg":
        return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
      case "image/gif":
        return b.slice(0, 6).toString("ascii") === "GIF87a" || b.slice(0, 6).toString("ascii") === "GIF89a";
      case "image/webp":
        return b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP";
      case "image/svg+xml": {
        const head = b.slice(0, 1024).toString("utf8").toLowerCase();
        // An SVG can carry script, and this one is rendered in an <img>, which
        // does not execute it -- but a file that is not an SVG at all is still
        // refused rather than served under an SVG content type.
        return head.includes("<svg");
      }
      default:
        return false;
    }
  }

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

  // Per-payer material the CHEAT SHEET DOES NOT CONTAIN: the payer's own
  // reference links, the denial reasons this practice actually sees, and a
  // logo. None of it can be derived from the source document, and none of it
  // may be invented -- so it is a table an admin fills in, empty until they do,
  // and the page says so rather than showing a confident blank.
  //
  // Deliberately SEPARATE from the cheat sheet data: bcba-cheatsheet-data.js
  // stays a faithful conversion of the practice's document, and nothing written
  // here can edit a requirement.
  async function initPayerMeta() {
    await dbRun(`CREATE TABLE IF NOT EXISTS bcba_payer_meta (
      payer_key TEXT PRIMARY KEY,
      links TEXT,
      denial_reasons TEXT,
      logo_stored TEXT,
      logo_mime TEXT,
      updated_by TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("[bcba] payer meta table:", e.message));
    for (const col of [
      "preauth_required TEXT",     // required | not_required | unknown
      "preauth_note TEXT",
      "preauth_source TEXT",       // document | setup | edited
      "preauth_updated_by TEXT",
      "preauth_updated_at TEXT",
    ]) {
      await dbRun(`ALTER TABLE bcba_payer_meta ADD COLUMN IF NOT EXISTS ${col}`)
        .catch((e) => console.error("[bcba] payer meta column:", e.message));
    }
    await seedPreauth();

    // Corrections to the converted cheat sheet. See bcba-cheatsheet-edits.js
    // for why an edit is keyed by the HASH of the text it replaced rather than
    // by its position.
    await dbRun(`CREATE TABLE IF NOT EXISTS bcba_cheatsheet_edits (
      id SERIAL PRIMARY KEY,
      payer_key TEXT NOT NULL,
      list_key TEXT NOT NULL,
      op TEXT NOT NULL,                -- edit | remove | add
      original_hash TEXT,
      original_text TEXT,
      text TEXT,
      updated_by TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("[bcba] cheatsheet edits table:", e.message));
    // One live change per line. A second edit of the same line replaces the
    // first rather than stacking, or the overlay order would decide what a
    // payer requires.
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bcba_edits_line
                 ON bcba_cheatsheet_edits (payer_key, list_key, original_hash)
                 WHERE original_hash IS NOT NULL`)
      .catch((e) => console.error("[bcba] cheatsheet edits index:", e.message));

    try { fs.mkdirSync(LOGO_DIR, { recursive: true }); } catch (e) { /* volume not mounted yet */ }
  }

  // WHETHER A PAYER NEEDS A PRE-AUTHORIZATION BEFORE THE ASSESSMENT.
  //
  // Three payers are answered by the cheat sheet in words -- "Authorization for
  // assessment is not required for 97151" -- and those are transcribed, quoting
  // the sentence.
  //
  // The other four the document does not answer either way. It lists what the
  // authorization request needs, which is not the same as saying one is
  // required, so these are marked at the practice's direction and RECORDED AS
  // SUCH: source "setup" rather than "document". That distinction is shown on
  // screen, because a marker that says "the cheat sheet states this" and one
  // that says "we believe this" carry different weight when a claim is denied,
  // and merging them would launder the second into the first.
  //
  // Seeded ONCE. An existing value is never overwritten -- the whole point of
  // this being editable is that the practice keeps up with payers changing
  // their minds, and a redeploy that reset those corrections would be worse
  // than not having them.
  const PREAUTH_SEED = {
    "nv-medicaid":  ["not_required", "The cheat sheet: authorization for assessment is not required for 97151 (limited to every 180 days).", "document"],
    "caresource":   ["not_required", "The cheat sheet: authorization for assessment is not required for 97151 (limited to every 180 days).", "document"],
    "molina":       ["not_required", "The cheat sheet: authorization for assessment is not required for 97151 (limited to every 180 days).", "document"],
    "aetna":        ["required", "Set at setup. The cheat sheet does not say this in words -- it lists what the authorization request needs.", "setup"],
    "tricare":      ["required", "Set at setup. The cheat sheet does not say this in words -- it lists what the authorization request needs.", "setup"],
    "anthem-bcbs":  ["required", "Set at setup. The cheat sheet does not say this in words -- it lists what the authorization request needs.", "setup"],
    "silversummit": ["required", "Set at setup. The cheat sheet does not say this in words -- it lists what the authorization request needs.", "setup"],
  };

  async function seedPreauth() {
    for (const [key, [required, note, source]] of Object.entries(PREAUTH_SEED)) {
      await dbRun(
        `INSERT INTO bcba_payer_meta (payer_key, preauth_required, preauth_note, preauth_source, preauth_updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (payer_key) DO UPDATE
           SET preauth_required = EXCLUDED.preauth_required,
               preauth_note = EXCLUDED.preauth_note,
               preauth_source = EXCLUDED.preauth_source,
               preauth_updated_at = EXCLUDED.preauth_updated_at
         WHERE bcba_payer_meta.preauth_required IS NULL`,
        [key, required, note, source, nowISO()]
      ).catch((e) => console.error("[bcba] preauth seed:", e.message));
    }
  }

  const parseJson = (v, fallback) => {
    if (!v) return fallback;
    try { const out = JSON.parse(v); return Array.isArray(out) ? out : fallback; } catch (e) { return fallback; }
  };

  async function payerMetaMap() {
    const rows = await dbAll("SELECT * FROM bcba_payer_meta").catch(() => []);
    const out = new Map();
    rows.forEach((r) => out.set(r.payer_key, {
      links: parseJson(r.links, []),
      denial_reasons: parseJson(r.denial_reasons, []),
      logo_url: r.logo_stored ? "/api/bcba/payers/" + encodeURIComponent(r.payer_key) + "/logo" : null,
      preauth: {
        // "unknown" rather than null when nothing is recorded, so the page can
        // say "not recorded" out loud. A payer with no marker at all is
        // indistinguishable from one that needs no pre-authorization.
        required: r.preauth_required || "unknown",
        note: r.preauth_note || null,
        source: r.preauth_source || null,
        updated_by: r.preauth_updated_by || null,
        updated_at: r.preauth_updated_at || null,
      },
    }));
    return out;
  }

  async function initTables() {
    await initPayerMeta();
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

  // A line arrives either as a plain string (the conversion's own text) or as an
  // object, once somebody has corrected it -- carrying the original wording and
  // who changed it. Both have to come out as { text, form, ...whatever the
  // overlay added }.
  //
  // Wrapping without unpacking is what this got wrong first: an edited line
  // became { text: { text: "...", edited: true }, form: null }, which renders
  // as "[object Object]" on the requirement a BCBA reads. Spreading the entry
  // keeps the edit marks and the form side by side.
  function attachForms(lines, formsByCode) {
    return (lines || []).map((entry) => {
      const isObj = entry && typeof entry === "object";
      const text = isObj ? entry.text : entry;
      const hit = codesIn(text).map((c) => formsByCode.get(c)).find(Boolean);
      const form = hit
        ? { id: hit.id, name: hit.name, editable: !!hit.editable, code: hit.form_code }
        : null;
      return isObj ? { ...entry, text, form } : { text, form };
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
      const meta = await payerMetaMap();
      const editRows = await dbAll(
        "SELECT * FROM bcba_cheatsheet_edits ORDER BY id"
      ).catch(() => []);
      const orphaned = [];
      json(res, 200, {
        payers: CHEATSHEET.payers.map((raw) => {
          // The overlay is applied FIRST, so a form named in an edited
          // requirement is attached to the edited text -- not to the wording
          // the document used to carry.
          const applied = edits.applyEdits(raw, editRows);
          orphaned.push(...applied.orphaned);
          const p = applied.payer;
          return {
          ...p,
          // Empty arrays until an admin fills them in. The page renders an
          // empty state that says what the panel is for rather than hiding it,
          // because a missing panel looks like the payer has nothing to say.
          links: (meta.get(p.key) || {}).links || [],
          denial_reasons: (meta.get(p.key) || {}).denial_reasons || [],
          logo_url: (meta.get(p.key) || {}).logo_url || null,
          // Requirements that name a form get that form attached, so the
          // download comes from the Form Library rather than a copy.
          preauth: (meta.get(p.key) || {}).preauth || { required: "unknown", note: null, source: null },
          required_documents: attachForms(p.required_documents, byCode),
          assessment_authorization: attachForms(p.assessment_authorization, byCode),
          };
        }),
        categories: CATEGORIES,
        can_manage_forms: canManage(user),
        // Editing a payer requirement changes what every BCBA is told to
        // submit, so it is the same set that maintains the Form Library.
        can_edit_requirements: canManage(user),
        // Changes whose original line is no longer in the converted document.
        // Surfaced rather than dropped: an edit that stops applying without
        // anybody being told is a requirement quietly reverting.
        orphaned_edits: canManage(user) ? orphaned : [],
      });
      return true;
    }

    // ---- a payer's logo -------------------------------------------------
    // Readable by anyone who can see the Hub, because it is drawn on every
    // payer card. Uploading one is an admin action, gated below.
    const logoMatch = pathname.match(/^\/api\/bcba\/payers\/([^/]+)\/logo$/);
    if (logoMatch && method === "GET") {
      const key = decodeURIComponent(logoMatch[1]);
      const row = await dbGet("SELECT logo_stored, logo_mime FROM bcba_payer_meta WHERE payer_key = ?", [key]).catch(() => null);
      if (!row || !row.logo_stored) { json(res, 404, { error: "No logo" }); return true; }
      let buf;
      try { buf = fs.readFileSync(path.join(LOGO_DIR, row.logo_stored)); }
      catch (e) { json(res, 404, { error: "No logo" }); return true; }
      res.writeHead(200, {
        "Content-Type": row.logo_mime || "image/png",
        "Content-Length": buf.length,
        // The filename is the row id plus a hash, so a replaced logo is a new
        // name and this can be cached hard without going stale.
        "Cache-Control": "public, max-age=86400",
      });
      res.end(buf);
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

    // Everything below changes what the Hub shows -- the Form Library, a
    // payer's links, its pre-authorization marker, and the payer requirements
    // themselves. A BCBA reads all of it and changes none of it.
    if (!canManage(user)) {
      if (method !== "GET") { json(res, 403, { error: "Only an owner or admin can change what the Hub shows." }); return true; }
      json(res, 404, { error: "Not found" });
      return true;
    }

    // ---- payer meta: links and denial reasons ---------------------------
    const metaMatch = pathname.match(/^\/api\/bcba\/payers\/([^/]+)\/meta$/);
    if (metaMatch && method === "PUT") {
      const key = decodeURIComponent(metaMatch[1]);
      if (!CHEATSHEET.payers.some((x) => x.key === key)) { json(res, 404, { error: "Unknown payer" }); return true; }
      const b = await readBody(req);
      // Links are name + URL, and ONLY http(s): a javascript: or data: URL in a
      // link an admin pasted would run on every BCBA's screen.
      const links = (Array.isArray(b.links) ? b.links : []).map((l) => ({
        label: clean(l && l.label).slice(0, 120),
        url: clean(l && l.url).slice(0, 500),
      })).filter((l) => l.label && /^https?:\/\//i.test(l.url)).slice(0, 20);
      const denials = (Array.isArray(b.denial_reasons) ? b.denial_reasons : [])
        .map((d) => clean(d).slice(0, 300)).filter(Boolean).slice(0, 30);
      await dbRun(
        `INSERT INTO bcba_payer_meta (payer_key, links, denial_reasons, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (payer_key) DO UPDATE SET links = EXCLUDED.links,
           denial_reasons = EXCLUDED.denial_reasons, updated_by = EXCLUDED.updated_by,
           updated_at = EXCLUDED.updated_at`,
        [key, JSON.stringify(links), JSON.stringify(denials), user.email || user.name || "unknown", nowISO()]
      );
      json(res, 200, { ok: true, links, denial_reasons: denials });
      return true;
    }

    // ---- whether this payer needs a pre-authorization --------------------
    const preauthMatch = pathname.match(/^\/api\/bcba\/payers\/([^/]+)\/preauth$/);
    if (preauthMatch && method === "PUT") {
      const key = decodeURIComponent(preauthMatch[1]);
      if (!CHEATSHEET.payers.some((x) => x.key === key)) { json(res, 404, { error: "Unknown payer" }); return true; }
      const b = await readBody(req);
      const required = clean(b.required);
      if (!["required", "not_required", "unknown"].includes(required)) {
        json(res, 400, { error: "Say whether a pre-authorization is required, is not required, or is not known." });
        return true;
      }
      // Anything a person sets is marked "edited", never "document". The
      // provenance of a marker is the point of recording it: a claim denied
      // over a pre-auth is a different conversation depending on whether the
      // cheat sheet said so or somebody here decided it.
      await dbRun(
        `INSERT INTO bcba_payer_meta (payer_key, preauth_required, preauth_note, preauth_source, preauth_updated_by, preauth_updated_at)
         VALUES (?, ?, ?, 'edited', ?, ?)
         ON CONFLICT (payer_key) DO UPDATE SET
           preauth_required = EXCLUDED.preauth_required,
           preauth_note = EXCLUDED.preauth_note,
           preauth_source = 'edited',
           preauth_updated_by = EXCLUDED.preauth_updated_by,
           preauth_updated_at = EXCLUDED.preauth_updated_at`,
        [key, required, clean(b.note).slice(0, 500) || null,
         user.email || user.name || "unknown", nowISO()]
      );
      json(res, 200, { ok: true, payer_key: key, required, source: "edited" });
      return true;
    }

    // ---- correcting a payer requirement ----------------------------------
    // The converted document is never modified. What is stored is the change
    // ON TOP of it, keyed by the text it replaced, so the original stays
    // recoverable and a reconversion cannot silently reapply a stale edit to a
    // different line. See bcba-cheatsheet-edits.js.
    if (pathname === "/api/bcba/requirements" && method === "POST") {
      const b = await readBody(req);
      const payer = CHEATSHEET.payers.find((x) => x.key === clean(b.payer_key));
      if (!payer) { json(res, 404, { error: "Unknown payer" }); return true; }
      const listKey = clean(b.list_key);
      if (!edits.listExists(payer, listKey)) {
        json(res, 400, { error: "That payer has no such list of requirements." });
        return true;
      }
      const op = clean(b.op);
      if (!["edit", "remove", "add"].includes(op)) { json(res, 400, { error: "Unknown change." }); return true; }
      const text = clean(b.text).slice(0, 2000);
      if (op !== "remove" && !text) {
        json(res, 400, { error: "A requirement needs some text." });
        return true;
      }

      const actor = user.email || user.name || "unknown";
      if (op === "add") {
        await dbRun(
          `INSERT INTO bcba_cheatsheet_edits (payer_key, list_key, op, text, updated_by, updated_at)
           VALUES (?, ?, 'add', ?, ?, ?)`,
          [payer.key, listKey, text, actor, nowISO()]
        );
        json(res, 200, { ok: true });
        return true;
      }

      // Edit and remove name the line by ITS ORIGINAL WORDING, and the hash is
      // computed here. The browser could send a hash instead, but then the
      // identity rule would have two implementations and the day they drifted
      // an edit would silently match nothing.
      //
      // Refusing an unmatched line here is what stops a change becoming an
      // orphan nobody can explain later.
      const hash = edits.itemHash(clean(b.original_text));
      const originalText = edits.findByHash(payer, listKey, hash);
      if (originalText === null) {
        json(res, 409, { error: "That requirement has changed in the cheat sheet since this page was opened. Reload and try again." });
        return true;
      }
      if (op === "edit" && edits.normalize(text) === edits.normalize(originalText)) {
        // Storing a change that changes nothing would put an "edited" mark on a
        // line that still reads exactly as the document wrote it.
        json(res, 200, { ok: true, unchanged: true });
        return true;
      }
      await dbRun(
        `INSERT INTO bcba_cheatsheet_edits (payer_key, list_key, op, original_hash, original_text, text, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (payer_key, list_key, original_hash) WHERE original_hash IS NOT NULL
         DO UPDATE SET op = EXCLUDED.op, text = EXCLUDED.text,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [payer.key, listKey, op, hash, originalText, op === "remove" ? null : text, actor, nowISO()]
      );
      json(res, 200, { ok: true });
      return true;
    }

    // Put a line back to what the document says, or drop an addition.
    const revertMatch = pathname.match(/^\/api\/bcba\/requirements\/(\d+)$/);
    if (revertMatch && method === "DELETE") {
      const row = await dbGet("SELECT * FROM bcba_cheatsheet_edits WHERE id = ?", [Number(revertMatch[1])]);
      if (!row) { json(res, 404, { error: "That change is not on file." }); return true; }
      await dbRun("DELETE FROM bcba_cheatsheet_edits WHERE id = ?", [row.id]);
      json(res, 200, { ok: true, reverted_to: row.original_text || null });
      return true;
    }

    // Every change on file, for a person reviewing what has drifted from the
    // document.
    if (pathname === "/api/bcba/requirements" && method === "GET") {
      const rows = await dbAll("SELECT * FROM bcba_cheatsheet_edits ORDER BY payer_key, list_key, id").catch(() => []);
      json(res, 200, { edits: rows });
      return true;
    }

    if (logoMatch && method === "POST") {
      const key = decodeURIComponent(logoMatch[1]);
      if (!CHEATSHEET.payers.some((x) => x.key === key)) { json(res, 404, { error: "Unknown payer" }); return true; }
      // Images only, by declared type AND by magic bytes. A file that merely
      // claims to be a PNG is served back to every user of the Hub.
      const mime = clean(query.mime).toLowerCase();
      const ALLOWED = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
      if (!ALLOWED.includes(mime)) { json(res, 400, { error: "A logo must be a PNG, JPEG, GIF, WebP or SVG." }); return true; }
      const { tooBig, buffer } = await readRaw(req);
      if (tooBig) { json(res, 413, { error: "That image is too large." }); return true; }
      if (!buffer.length) { json(res, 400, { error: "That upload came through empty." }); return true; }
      if (buffer.length > 512 * 1024) { json(res, 413, { error: "A logo should be under 512 KB." }); return true; }
      if (!looksLikeImage(buffer, mime)) { json(res, 400, { error: "That file is not the image type it claims to be." }); return true; }

      const stored = key.replace(/[^a-z0-9-]/gi, "") + "-" + crypto.randomBytes(6).toString("hex") + extFor(mime);
      try { fs.mkdirSync(LOGO_DIR, { recursive: true }); } catch (e) { /* already there */ }
      const prev = await dbGet("SELECT logo_stored FROM bcba_payer_meta WHERE payer_key = ?", [key]).catch(() => null);
      fs.writeFileSync(path.join(LOGO_DIR, stored), buffer);
      await dbRun(
        `INSERT INTO bcba_payer_meta (payer_key, logo_stored, logo_mime, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (payer_key) DO UPDATE SET logo_stored = EXCLUDED.logo_stored,
           logo_mime = EXCLUDED.logo_mime, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [key, stored, mime, user.email || user.name || "unknown", nowISO()]
      );
      // The old file goes only after the new one is recorded, so a crash in
      // between leaves a stale logo rather than none.
      if (prev && prev.logo_stored && prev.logo_stored !== stored) {
        try { fs.unlinkSync(path.join(LOGO_DIR, prev.logo_stored)); } catch (e) { /* already gone */ }
      }
      json(res, 201, { ok: true, logo_url: "/api/bcba/payers/" + encodeURIComponent(key) + "/logo" });
      return true;
    }

    if (logoMatch && method === "DELETE") {
      const key = decodeURIComponent(logoMatch[1]);
      const row = await dbGet("SELECT logo_stored FROM bcba_payer_meta WHERE payer_key = ?", [key]).catch(() => null);
      if (row && row.logo_stored) {
        try { fs.unlinkSync(path.join(LOGO_DIR, row.logo_stored)); } catch (e) { /* already gone */ }
      }
      await dbRun("UPDATE bcba_payer_meta SET logo_stored = NULL, logo_mime = NULL WHERE payer_key = ?", [key]).catch(() => {});
      json(res, 200, { ok: true });
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
