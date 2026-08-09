// authorizations.js -- real authorization records, imported from the Rethink
// "Authorization Utilization" export.
//
// Before this, an authorization was three columns on the client row:
// authorization_status, auth_start_date, auth_expiration_date, plus a single
// authorized_hours_per_week on the financial form. No payer, no auth number,
// no CPT, no units, no used/scheduled/remaining. Every number the Scheduling
// Center wants to show -- unscheduled authorized hours, utilization, expiry
// risk, Schedule Health -- would have been built on that one free-text field.
//
// The export gives all of it, per client per service line:
//
//   Client | Funder | Service Line | Auth # | Auth # Units/Freq | Dates |
//   Service Name | Billing Code | Scheduling Goal | Total Sched Goal |
//   Total Auth Hours | Sched Hours | Unsched Hours | Verified Hours |
//   Sched/Auth | Sched/Goal | Days Until Expiration | Status |
//   Rendering Provider | Referring Provider Name
//
// Two things learned from the real file and encoded here:
//
//   * Units are 15-minute units. Total Auth Hours is always units / 4 for
//     "/Total" rows. Where the frequency is Weekly or Monthly, the units are
//     per week or per month while Total Auth Hours is still the whole-period
//     total, so the two are stored separately and never derived from each
//     other.
//
//   * Sched Hours + Unsched Hours == Total Auth Hours on every row, and the
//     sheet carries its own Totals: row. Both are checked after parsing. A
//     parse that does not reconcile to the file's own totals is reported as
//     unverified rather than quietly trusted -- the same rule the bank and
//     payroll importers follow.
//
// Nothing is written on upload. The import is parsed, matched against real
// client records, and shown for confirmation. Clients are never created, and
// an unmatched row is surfaced rather than dropped.

"use strict";

module.exports = function initAuthorizations(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, crypto, readBody, json,
    canAccessClients, unzip,
  } = ctx;

  const clean = (v) => (v == null ? "" : String(v).trim());
  const numOrNull = (v) => {
    const s = clean(v).replace(/[,$%]/g, "");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

  const ADMIN_ROLES = ["owner", "super_admin", "admin"];
  const IMPORT_ROLES = ["owner", "super_admin", "admin", "billing", "scheduling", "clinical"];
  const isAdmin = (u) => !!u && ADMIN_ROLES.includes(u.role);
  const canImport = (u) => !!u && IMPORT_ROLES.includes(u.role);

  // 15-minute billing units.
  const UNITS_PER_HOUR = 4;

  // ======================= SCHEMA ============================
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS auth_imports (
      id SERIAL PRIMARY KEY,
      filename TEXT,
      sha256 TEXT,
      row_count INTEGER,
      matched_count INTEGER,
      unmatched_count INTEGER,
      control_totals TEXT,
      parsed_totals TEXT,
      verified BOOLEAN DEFAULT FALSE,
      verification_note TEXT,
      imported_by TEXT,
      imported_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS client_authorizations (
      id SERIAL PRIMARY KEY,
      client_id INTEGER,                  -- null until a human confirms the match
      client_name_raw TEXT NOT NULL,      -- exactly as the export wrote it
      payer TEXT,
      service_line TEXT,
      auth_number TEXT,
      units_value REAL,
      units_frequency TEXT,               -- Total | Weekly | Monthly
      effective_date TEXT,
      expiration_date TEXT,
      service_name TEXT,
      billing_code TEXT,                  -- CPT
      goal_hours REAL,
      goal_frequency TEXT,
      total_auth_hours REAL,
      scheduled_hours REAL,
      unscheduled_hours REAL,
      verified_hours REAL,
      sched_auth_pct REAL,
      sched_goal_pct REAL,
      days_until_expiration INTEGER,
      status TEXT,
      rendering_provider TEXT,
      referring_provider TEXT,
      row_warnings TEXT,                  -- JSON array
      import_id INTEGER,
      source_row INTEGER,
      created_at TEXT,
      updated_at TEXT
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS client_auth_client_idx ON client_authorizations (client_id)`).catch(() => {});
    // Occurrence is part of the key on purpose. The real export contains the
    // same authorization line repeated -- Sol McAtee's appears four times --
    // and a key without it silently collapsed those into one row on import,
    // quietly discarding data. They are kept, numbered, and flagged instead.
    await dbRun(`ALTER TABLE client_authorizations ADD COLUMN IF NOT EXISTS occurrence INTEGER DEFAULT 1`).catch(() => {});
    await dbRun(`ALTER TABLE client_authorizations ADD COLUMN IF NOT EXISTS duplicate_of_count INTEGER DEFAULT 1`).catch(() => {});
    await dbRun(`DROP INDEX IF EXISTS client_auth_key_idx`).catch(() => {});
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS client_auth_key_idx
                 ON client_authorizations (client_name_raw, COALESCE(auth_number,''), COALESCE(billing_code,''),
                                           COALESCE(effective_date,''), COALESCE(occurrence,1))`).catch(() => {});

    // Utilization changes every import. Kept so "we were at 3% two weeks ago"
    // is answerable, and so an import can never silently rewrite history.
    await dbRun(`CREATE TABLE IF NOT EXISTS auth_utilization_history (
      id SERIAL PRIMARY KEY,
      authorization_id INTEGER NOT NULL,
      import_id INTEGER,
      total_auth_hours REAL,
      scheduled_hours REAL,
      unscheduled_hours REAL,
      verified_hours REAL,
      days_until_expiration INTEGER,
      status TEXT,
      recorded_at TEXT
    )`);

    console.log("Authorizations schema ready.");
  }

  // ======================= VALIDITY ==========================
  // Spectrum Squad's rule, not an inference: an authorization only counts if it
  // has a real authorization number AND today falls inside its own date range.
  //
  // This deliberately overrides the export's Status column. Rethink marks rows
  // Active that carry "Place Holder" where the number should be, and a row can
  // still read Active on the day after it expires. Anything excluded is
  // reported with the reason rather than dropped, because an authorization
  // that vanishes from a total without explanation is how a clinic ends up
  // delivering unauthorised hours.
  function authValidity(row, todayStr) {
    const today = todayStr || nowISO().slice(0, 10);
    const num = clean(row.auth_number);
    const hasNumber = !!num && !/^place\s*holder$/i.test(num);
    const from = clean(row.effective_date).slice(0, 10);
    const to = clean(row.expiration_date).slice(0, 10);
    if (!from || !to) {
      return { valid: false, countable: false, reason: "no_dates", message: "No authorization date range on file." };
    }
    if (today < from) {
      return { valid: false, countable: false, reason: "not_started", message: `Doesn't start until ${from}.` };
    }
    if (today > to) {
      return { valid: false, countable: false, reason: "expired", message: `Ended ${to}.` };
    }
    // A repeat of a line already counted contributes no additional hours.
    if ((row.occurrence || 1) > 1) {
      return { valid: false, countable: false, reason: "duplicate_line", message: `Copy ${row.occurrence} of ${row.duplicate_of_count} identical rows in the export.` };
    }
    // In date range but no number on file. This is a gap in Rethink, not proof
    // that no authorization exists -- Harper Hall is an active client with a
    // live authorization whose number simply was not entered. Treating that as
    // "no authorization" would zero her hours and drop her off Clients Needing
    // Hours, which is the opposite of what should happen. So it counts for
    // scheduling and is held back from anything billing-facing until the number
    // is entered.
    if (!hasNumber) {
      return {
        valid: false, countable: true, reason: "no_number",
        message: "In date range, but no authorization number on file yet — confirm it in Rethink before billing.",
      };
    }
    return { valid: true, countable: true, reason: "valid", message: "" };
  }

  // ======================= XLSX ==============================
  // Namespace-agnostic: Rethink writes <x:row>, other tools write <row>.
  const NS = "(?:[A-Za-z0-9]+:)?";
  const unescapeXml = (s) =>
    String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

  function parseSheet(buffer) {
    const files = unzip(buffer);
    const dec = (b) => (b == null ? "" : Buffer.isBuffer(b) ? b.toString("utf8") : String(b));

    const sharedRaw = dec(files["xl/sharedStrings.xml"]);
    const strings = [...sharedRaw.matchAll(new RegExp(`<${NS}si>([\\s\\S]*?)</${NS}si>`, "g"))].map((m) =>
      unescapeXml([...m[1].matchAll(new RegExp(`<${NS}t[^>]*>([\\s\\S]*?)</${NS}t>`, "g"))].map((x) => x[1]).join(""))
    );

    const sheetKey = Object.keys(files).find((k) => /^xl\/worksheets\/sheet1\.xml$/i.test(k))
      || Object.keys(files).find((k) => /^xl\/worksheets\/.*\.xml$/i.test(k));
    if (!sheetKey) throw new Error("That file doesn't contain a worksheet.");
    const sheet = dec(files[sheetKey]);

    const rows = [];
    for (const rm of sheet.matchAll(new RegExp(`<${NS}row[^>]*r="(\\d+)"[^>]*>([\\s\\S]*?)</${NS}row>`, "g"))) {
      const cells = {};
      for (const cm of rm[2].matchAll(new RegExp(`<${NS}c[^>]*r="([A-Z]+)\\d+"([^>]*)>([\\s\\S]*?)</${NS}c>`, "g"))) {
        const attrs = cm[2] || "", inner = cm[3] || "";
        const vm = new RegExp(`<${NS}v>([\\s\\S]*?)</${NS}v>`).exec(inner);
        const im = new RegExp(`<${NS}is>[\\s\\S]*?<${NS}t[^>]*>([\\s\\S]*?)</${NS}t>`).exec(inner);
        let val = "";
        if (im) val = unescapeXml(im[1]);
        else if (vm) val = /t="s"/.test(attrs) ? (strings[Number(vm[1])] || "") : unescapeXml(vm[1]);
        cells[cm[1]] = val;
      }
      rows.push({ row: Number(rm[1]), cells });
    }
    return rows;
  }

  // ======================= FIELD PARSERS =====================
  // "4280/Total", "120/Weekly", "8/Monthly", or a bare "4280".
  function parseUnits(raw) {
    const s = clean(raw);
    if (!s) return { value: null, frequency: null };
    const m = /^([\d.,]+)\s*(?:\/\s*(\w+))?$/.exec(s);
    if (!m) return { value: null, frequency: null, unparsed: s };
    return { value: numOrNull(m[1]), frequency: m[2] ? m[2][0].toUpperCase() + m[2].slice(1).toLowerCase() : "Total" };
  }

  // "1070hrs/Total", "2hrs/Monthly"
  function parseGoal(raw) {
    const s = clean(raw);
    if (!s) return { hours: null, frequency: null };
    const m = /^([\d.,]+)\s*hrs?\s*(?:\/\s*(\w+))?$/i.exec(s);
    if (!m) return { hours: null, frequency: null, unparsed: s };
    return { hours: numOrNull(m[1]), frequency: m[2] ? m[2][0].toUpperCase() + m[2].slice(1).toLowerCase() : "Total" };
  }

  // "07/23/2026-01/22/2027"
  function parseDates(raw) {
    const s = clean(raw);
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*[-–]\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!m) return { start: null, end: null, unparsed: s || null };
    const iso = (mo, d, y) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return { start: iso(m[1], m[2], m[3]), end: iso(m[4], m[5], m[6]) };
  }

  // "Barlew, Jaxon" -> { last, first, display }
  function parseClientName(raw) {
    const s = clean(raw);
    if (!s) return null;
    if (s.includes(",")) {
      const [last, ...rest] = s.split(",");
      return { last: clean(last), first: clean(rest.join(",")), display: `${clean(rest.join(","))} ${clean(last)}`.trim() };
    }
    const parts = s.split(/\s+/);
    return { last: parts[parts.length - 1], first: parts.slice(0, -1).join(" "), display: s };
  }

  const HEADERS = {
    A: "client", B: "payer", C: "service_line", D: "auth_number", E: "units",
    F: "dates", G: "service_name", H: "billing_code", I: "goal", J: "goal_total",
    K: "total_auth_hours", L: "scheduled_hours", M: "unscheduled_hours", N: "verified_hours",
    O: "sched_auth_pct", P: "sched_goal_pct", Q: "days_until_expiration", R: "status",
    S: "rendering_provider", T: "referring_provider",
  };

  // ======================= PARSE =============================
  function parseExport(buffer) {
    const raw = parseSheet(buffer);

    // Find the header row rather than assuming row 5: the export has a title
    // row above it and Rethink may add more later.
    const headerRow = raw.find((r) => clean(r.cells.A).toLowerCase() === "client" && /funder/i.test(clean(r.cells.B)));
    if (!headerRow) {
      throw new Error("This doesn't look like an Authorization Utilization export — no Client / Funder header row was found.");
    }

    const rows = [];
    let controlTotals = null;

    for (const r of raw) {
      if (r.row <= headerRow.row) continue;
      const c = r.cells;
      const first = clean(c.A);

      // The sheet's own Totals: row -- the control the parse is checked against.
      if (/^totals?:?$/i.test(first)) {
        controlTotals = {
          goal_total: numOrNull(c.J), total_auth_hours: numOrNull(c.K),
          scheduled_hours: numOrNull(c.L), unscheduled_hours: numOrNull(c.M),
          verified_hours: numOrNull(c.N),
        };
        continue;
      }
      if (!first) continue;

      const warnings = [];
      const name = parseClientName(first);
      const units = parseUnits(c.E);
      const goal = parseGoal(c.I);
      const dates = parseDates(c.F);

      const authNumber = clean(c.D);
      // Real placeholders exist in the export. Recorded as missing rather than
      // treated as a valid authorization number.
      const placeholder = !authNumber || /^place\s*holder$/i.test(authNumber);

      const totalAuth = numOrNull(c.K);
      const sched = numOrNull(c.L);
      const unsched = numOrNull(c.M);

      if (units.unparsed) warnings.push(`Units "${units.unparsed}" couldn't be read.`);
      if (goal.unparsed) warnings.push(`Scheduling goal "${goal.unparsed}" couldn't be read.`);
      if (dates.unparsed) warnings.push(`Authorization dates "${dates.unparsed}" couldn't be read.`);
      if (placeholder) warnings.push("No real authorization number on this row (the export says \"Place Holder\").");
      if (totalAuth != null && sched != null && unsched != null && Math.abs((sched + unsched) - totalAuth) > 0.01) {
        warnings.push(`Scheduled (${sched}) plus unscheduled (${unsched}) doesn't equal the authorized total (${totalAuth}).`);
      }
      // Units and hours should agree at 4 units per hour on "/Total" rows.
      // Weekly and Monthly rows state units per period while the hours column
      // is the whole-period total, so they are not compared.
      if (units.value != null && totalAuth && units.frequency === "Total") {
        const implied = units.value / UNITS_PER_HOUR;
        if (Math.abs(implied - totalAuth) > 0.01) {
          warnings.push(`${units.value} units works out to ${round2(implied)} hours at 15 minutes each, but the export says ${totalAuth}.`);
        }
      }

      rows.push({
        source_row: r.row,
        client_name_raw: first,
        client_first: name ? name.first : "",
        client_last: name ? name.last : "",
        client_display: name ? name.display : first,
        payer: clean(c.B) || null,
        service_line: clean(c.C) || null,
        auth_number: placeholder ? null : authNumber,
        auth_number_raw: authNumber || null,
        units_value: units.value,
        units_frequency: units.frequency,
        effective_date: dates.start,
        expiration_date: dates.end,
        service_name: clean(c.G) || null,
        billing_code: clean(c.H) || null,
        goal_hours: goal.hours,
        goal_frequency: goal.frequency,
        goal_total: numOrNull(c.J),
        total_auth_hours: totalAuth,
        scheduled_hours: sched,
        unscheduled_hours: unsched,
        verified_hours: numOrNull(c.N),
        sched_auth_pct: numOrNull(c.O),
        sched_goal_pct: numOrNull(c.P),
        days_until_expiration: numOrNull(c.Q) == null ? null : Math.round(numOrNull(c.Q)),
        status: clean(c.R) || null,
        rendering_provider: clean(c.S) || null,
        referring_provider: clean(c.T) || null,
        warnings,
      });
    }

    // The export repeats some authorization lines verbatim -- same client, auth
    // number, service code, dates and units -- differing only in scheduled
    // hours. The file's own Totals row adds all the copies up, so the exported
    // "authorized hours" figure is inflated for those clients. Both numbers are
    // reported: faithful to the file, and distinct. Nothing is dropped.
    const groups = new Map();
    for (const r of rows) {
      const key = [r.client_name_raw, r.auth_number_raw || "", r.billing_code || "",
                   r.effective_date || "", r.units_value, r.units_frequency].join("|");
      const list = groups.get(key) || [];
      list.push(r);
      groups.set(key, list);
    }
    let duplicateHours = 0;
    const duplicateGroups = [];
    for (const list of groups.values()) {
      list.forEach((r, i) => { r.occurrence = i + 1; r.duplicate_of_count = list.length; });
      if (list.length > 1) {
        const first = list[0];
        duplicateHours += (first.total_auth_hours || 0) * (list.length - 1);
        duplicateGroups.push({
          client_name_raw: first.client_name_raw, auth_number: first.auth_number_raw,
          billing_code: first.billing_code, service_name: first.service_name,
          dates: `${first.effective_date} to ${first.expiration_date}`,
          copies: list.length, hours_each: first.total_auth_hours,
          extra_hours: round2((first.total_auth_hours || 0) * (list.length - 1)),
          rows: list.map((r) => r.source_row),
        });
        for (const r of list) {
          r.warnings.push(`This authorization line appears ${list.length} times in the export (rows ${list.map((x) => x.source_row).join(", ")}). The export's totals count all ${list.length}.`);
        }
      }
    }

    // Reconcile against the file's own totals.
    const parsedTotals = {
      goal_total: round2(rows.reduce((n, r) => n + (r.goal_total || 0), 0)),
      total_auth_hours: round2(rows.reduce((n, r) => n + (r.total_auth_hours || 0), 0)),
      scheduled_hours: round2(rows.reduce((n, r) => n + (r.scheduled_hours || 0), 0)),
      unscheduled_hours: round2(rows.reduce((n, r) => n + (r.unscheduled_hours || 0), 0)),
      verified_hours: round2(rows.reduce((n, r) => n + (r.verified_hours || 0), 0)),
    };

    let verified = false;
    let verificationNote;
    if (!controlTotals) {
      verificationNote = "This export has no Totals row, so the parse couldn't be checked against the file's own figures.";
    } else {
      const off = [];
      for (const k of Object.keys(parsedTotals)) {
        const a = parsedTotals[k], b = controlTotals[k];
        if (b == null) continue;
        if (Math.abs(a - b) > 0.02) off.push(`${k.replace(/_/g, " ")}: read ${a}, file says ${b}`);
      }
      verified = off.length === 0;
      verificationNote = verified
        ? "Every column adds up to the totals printed in the export."
        : `The parse doesn't match the export's own totals — ${off.join("; ")}.`;
    }

    const distinctTotals = {
      total_auth_hours: round2(rows.filter((r) => r.occurrence === 1).reduce((n, r) => n + (r.total_auth_hours || 0), 0)),
      scheduled_hours: round2(rows.reduce((n, r) => n + (r.scheduled_hours || 0), 0)),
    };

    return {
      rows, controlTotals, parsedTotals, verified, verificationNote,
      duplicates: {
        groups: duplicateGroups,
        extra_rows: rows.filter((r) => r.occurrence > 1).length,
        double_counted_hours: round2(duplicateHours),
        distinct_totals: distinctTotals,
      },
    };
  }

  // ======================= MATCHING ==========================
  // Deliberately conservative, for the same reason the BIP import is: these
  // are children's clinical and billing records. A confident match needs a
  // full-name agreement, not a first name and a hopeful guess.
  function normalise(s) {
    return clean(s).toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  }

  function scoreClient(row, client) {
    const why = [];
    let score = 0;
    const target = normalise(client.child_name);
    if (!target) return { score: 0, why };
    const first = normalise(row.client_first);
    const last = normalise(row.client_last);

    if (target === normalise(row.client_display)) { score += 100; why.push("full name matches exactly"); }
    else if (target === normalise(`${last} ${first}`)) { score += 100; why.push("full name matches (last, first)"); }
    else {
      const parts = target.split(" ");
      const tFirst = parts[0], tLast = parts[parts.length - 1];
      if (first && tFirst === first) { score += 45; why.push("first name matches"); }
      if (last && tLast === last) { score += 45; why.push("last name matches"); }
      if (first && last && tLast === first && tFirst === last) { score += 80; why.push("first and last appear reversed but both match"); }
    }
    return { score, why };
  }

  function matchRow(row, clients) {
    const scored = clients
      .map((c) => ({ client: c, ...scoreClient(row, c) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = scored[0], runnerUp = scored[1];
    // 90 means both names agreed. Anything less waits for a human.
    const confident = best && best.score >= 90 && (!runnerUp || best.score - runnerUp.score >= 40);
    return {
      match: best ? { client_id: best.client.id, child_name: best.client.child_name, score: best.score, reasons: best.why, confident: !!confident } : null,
      alternatives: scored.slice(0, 4).map((x) => ({ client_id: x.client.id, child_name: x.client.child_name, score: x.score, reasons: x.why })),
    };
  }

  // ======================= API ===============================
  async function readUpload(req) {
    // Raw body upload: the client posts the file bytes with the filename in a
    // header, matching how the other importers in this app receive documents.
    return await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > 25 * 1024 * 1024) { reject(new Error("That file is larger than 25 MB.")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/auth-util/")) return false;
    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }

    try {
      const actor = user.email || `user:${user.id}`;

      // ---- preview: parse + match, write nothing ----
      if (pathname === "/api/auth-util/preview" && method === "POST") {
        if (!canImport(user)) { json(res, 403, { error: "Not permitted to import authorizations." }); return true; }
        const buffer = await readUpload(req);
        if (!buffer.length) { json(res, 400, { error: "No file was received." }); return true; }
        const sha = crypto.createHash("sha256").update(buffer).digest("hex");

        let parsed;
        try { parsed = parseExport(buffer); }
        catch (e) { json(res, 400, { error: e.message }); return true; }

        const clients = await dbAll("SELECT id, child_name FROM clients ORDER BY id");
        const items = parsed.rows.map((row) => ({ ...row, ...matchRow(row, clients) }));

        const previouslyImported = await dbGet("SELECT id, filename, imported_at FROM auth_imports WHERE sha256 = ?", [sha]);

        // Group by client so the preview reads like a roster, not 139 rows.
        const byClient = {};
        for (const it of items) {
          const key = it.client_name_raw;
          byClient[key] = byClient[key] || {
            client_name_raw: key, client_display: it.client_display,
            match: it.match, alternatives: it.alternatives, rows: [],
            total_auth_hours: 0, scheduled_hours: 0, unscheduled_hours: 0, warnings: 0,
          };
          byClient[key].rows.push(it);
          byClient[key].total_auth_hours += it.total_auth_hours || 0;
          byClient[key].scheduled_hours += it.scheduled_hours || 0;
          byClient[key].unscheduled_hours += it.unscheduled_hours || 0;
          byClient[key].warnings += it.warnings.length;
        }
        const groups = Object.values(byClient).map((g) => ({
          ...g,
          total_auth_hours: round2(g.total_auth_hours),
          scheduled_hours: round2(g.scheduled_hours),
          unscheduled_hours: round2(g.unscheduled_hours),
        }));

        json(res, 200, {
          sha256: sha,
          already_imported: previouslyImported || null,
          verified: parsed.verified,
          verification_note: parsed.verificationNote,
          duplicates: parsed.duplicates,
          control_totals: parsed.controlTotals,
          parsed_totals: parsed.parsedTotals,
          summary: {
            rows: items.length,
            clients: groups.length,
            matched: groups.filter((g) => g.match && g.match.confident).length,
            needs_confirmation: groups.filter((g) => g.match && !g.match.confident).length,
            unmatched: groups.filter((g) => !g.match).length,
            expired: items.filter((r) => clean(r.status).toLowerCase() === "expired").length,
            expiring_30: items.filter((r) => r.days_until_expiration != null && r.days_until_expiration >= 0 && r.days_until_expiration <= 30).length,
            rows_with_warnings: items.filter((r) => r.warnings.length).length,
          },
          clients: groups,
        });
        return true;
      }

      // ---- commit: only what the user confirmed ----
      if (pathname === "/api/auth-util/commit" && method === "POST") {
        if (!canImport(user)) { json(res, 403, { error: "Not permitted to import authorizations." }); return true; }
        const b = await readBody(req);
        const rows = Array.isArray(b.rows) ? b.rows : [];
        if (!rows.length) { json(res, 400, { error: "Nothing was selected to import." }); return true; }

        const imp = await dbGet(
          `INSERT INTO auth_imports (filename, sha256, row_count, matched_count, unmatched_count,
             control_totals, parsed_totals, verified, verification_note, imported_by, imported_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
          [clean(b.filename) || null, clean(b.sha256) || null, rows.length,
           rows.filter((r) => r.client_id).length, rows.filter((r) => !r.client_id).length,
           JSON.stringify(b.control_totals || null), JSON.stringify(b.parsed_totals || null),
           !!b.verified, clean(b.verification_note) || null, actor, nowISO()]
        );

        let created = 0, updated = 0;
        const skipped = [];
        for (const r of rows) {
          if (!clean(r.client_name_raw)) { skipped.push({ row: r.source_row, reason: "no client name" }); continue; }
          const existing = await dbGet(
            `SELECT * FROM client_authorizations
              WHERE client_name_raw = ? AND COALESCE(auth_number,'') = ? AND COALESCE(billing_code,'') = ?
                AND COALESCE(effective_date,'') = ? AND COALESCE(occurrence,1) = ?`,
            [r.client_name_raw, clean(r.auth_number), clean(r.billing_code), clean(r.effective_date), Number(r.occurrence) || 1]
          );

          const vals = [
            r.client_id ? Number(r.client_id) : null, r.client_name_raw,
            clean(r.payer) || null, clean(r.service_line) || null, clean(r.auth_number) || null,
            r.units_value, clean(r.units_frequency) || null,
            clean(r.effective_date) || null, clean(r.expiration_date) || null,
            clean(r.service_name) || null, clean(r.billing_code) || null,
            r.goal_hours, clean(r.goal_frequency) || null,
            r.total_auth_hours, r.scheduled_hours, r.unscheduled_hours, r.verified_hours,
            r.sched_auth_pct, r.sched_goal_pct, r.days_until_expiration,
            clean(r.status) || null, clean(r.rendering_provider) || null, clean(r.referring_provider) || null,
            JSON.stringify(r.warnings || []), imp.id, r.source_row || null,
            Number(r.occurrence) || 1, Number(r.duplicate_of_count) || 1,
          ];

          let authId;
          if (existing) {
            await dbRun(
              `UPDATE client_authorizations SET
                 client_id = COALESCE(?, client_id), client_name_raw = ?, payer = ?, service_line = ?, auth_number = ?,
                 units_value = ?, units_frequency = ?, effective_date = ?, expiration_date = ?,
                 service_name = ?, billing_code = ?, goal_hours = ?, goal_frequency = ?,
                 total_auth_hours = ?, scheduled_hours = ?, unscheduled_hours = ?, verified_hours = ?,
                 sched_auth_pct = ?, sched_goal_pct = ?, days_until_expiration = ?,
                 status = ?, rendering_provider = ?, referring_provider = ?,
                 row_warnings = ?, import_id = ?, source_row = ?, occurrence = ?, duplicate_of_count = ?, updated_at = ?
               WHERE id = ?`,
              [...vals, nowISO(), existing.id]
            );
            authId = existing.id;
            updated++;
          } else {
            const row = await dbGet(
              `INSERT INTO client_authorizations
                 (client_id, client_name_raw, payer, service_line, auth_number, units_value, units_frequency,
                  effective_date, expiration_date, service_name, billing_code, goal_hours, goal_frequency,
                  total_auth_hours, scheduled_hours, unscheduled_hours, verified_hours,
                  sched_auth_pct, sched_goal_pct, days_until_expiration, status,
                  rendering_provider, referring_provider, row_warnings, import_id, source_row,
                  occurrence, duplicate_of_count, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
              [...vals, nowISO(), nowISO()]
            );
            authId = row.id;
            created++;
          }

          // Utilization at this point in time, never overwritten.
          await dbRun(
            `INSERT INTO auth_utilization_history
               (authorization_id, import_id, total_auth_hours, scheduled_hours, unscheduled_hours,
                verified_hours, days_until_expiration, status, recorded_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [authId, imp.id, r.total_auth_hours, r.scheduled_hours, r.unscheduled_hours,
             r.verified_hours, r.days_until_expiration, clean(r.status) || null, nowISO()]
          );
        }

        json(res, 200, { ok: true, import_id: imp.id, created, updated, skipped });
        return true;
      }

      // ---- read back ----
      if (pathname === "/api/auth-util/imports" && method === "GET") {
        if (!canImport(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        json(res, 200, { imports: await dbAll("SELECT * FROM auth_imports ORDER BY id DESC LIMIT 25") });
        return true;
      }

      const clientAuthMatch = pathname.match(/^\/api\/auth-util\/client\/(\d+)$/);
      if (clientAuthMatch && method === "GET") {
        if (!canAccessClients(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const rows = await dbAll(
          "SELECT * FROM client_authorizations WHERE client_id = ? ORDER BY expiration_date DESC, billing_code",
          [Number(clientAuthMatch[1])]
        );
        for (const r of rows) r.validity = authValidity(r);
        const active = rows.filter((r) => r.validity.countable);
        json(res, 200, {
          authorizations: rows.map((r) => ({ ...r, row_warnings: JSON.parse(r.row_warnings || "[]") })),
          validity_rule: ("Hours count when today falls inside the authorization's date range. An authorization "
            + "in range but missing its number still counts for scheduling and is flagged as needing the number "
            + "before billing. Expired, not-yet-started and duplicate rows do not count at all."),
          totals: {
            authorized_hours: round2(active.reduce((n, r) => n + (r.total_auth_hours || 0), 0)),
            scheduled_hours: round2(active.reduce((n, r) => n + (r.scheduled_hours || 0), 0)),
            valid_authorizations: active.filter((r) => r.validity.valid).length,
            needs_auth_number: active.filter((r) => !r.validity.valid).length,
            unverified_hours: round2(active.filter((r) => !r.validity.valid)
              .reduce((n, r) => n + (r.total_auth_hours || 0), 0)),
            excluded: rows.filter((r) => !r.validity.countable).map((r) => ({
              service: r.service_name, billing_code: r.billing_code,
              hours: r.total_auth_hours, why: r.validity.message,
            })),
            unscheduled_hours: round2(active.reduce((n, r) => n + (r.unscheduled_hours || 0), 0)),
          },
          soonest_expiration: active.length
            ? active.map((r) => r.expiration_date).filter(Boolean).sort()[0] : null,
        });
        return true;
      }

      // Roll-up for the Scheduling Center: who has authorized hours going unused,
      // and whose authorization is about to run out.
      if (pathname === "/api/auth-util/overview" && method === "GET") {
        if (!canAccessClients(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const all = await dbAll(
          `SELECT a.*, c.child_name FROM client_authorizations a
             LEFT JOIN clients c ON c.id = a.client_id`
        );
        for (const r of all) r.validity = authValidity(r);
        // Countable = real hours the clinic can schedule against.
        // Valid = countable AND carrying an authorization number, so billable.
        const rows = all.filter((r) => r.validity.countable);
        const excluded = all.filter((r) => !r.validity.countable);
        const unverified = rows.filter((r) => !r.validity.valid);
        const dupExtra = excluded.filter((r) => r.validity.reason === "duplicate_line");
        const byClient = {};
        for (const r of rows) {
          const key = r.client_id || `raw:${r.client_name_raw}`;
          byClient[key] = byClient[key] || {
            client_id: r.client_id, name: r.child_name || r.client_name_raw,
            matched: !!r.client_id, authorized: 0, scheduled: 0, unscheduled: 0, unverified_hours: 0,
            soonest_expiration: null, services: [],
          };
          const g = byClient[key];
          if (!r.validity.valid) g.unverified_hours = round2((g.unverified_hours || 0) + (r.total_auth_hours || 0));
          g.authorized += r.total_auth_hours || 0;
          g.scheduled += r.scheduled_hours || 0;
          g.unscheduled += r.unscheduled_hours || 0;
          g.services.push({ code: r.billing_code, name: r.service_name, unscheduled: r.unscheduled_hours, days: r.days_until_expiration });
          if (r.expiration_date && (!g.soonest_expiration || r.expiration_date < g.soonest_expiration)) {
            g.soonest_expiration = r.expiration_date;
          }
        }
        const clientsOut = Object.values(byClient).map((g) => ({
          ...g,
          authorized: round2(g.authorized), scheduled: round2(g.scheduled), unscheduled: round2(g.unscheduled),
          utilization_pct: g.authorized ? round2((g.scheduled / g.authorized) * 100) : null,
        })).sort((a, b) => b.unscheduled - a.unscheduled);

        json(res, 200, {
          clients: clientsOut,
          unmatched_clients: clientsOut.filter((c) => !c.matched).length,
          duplicate_lines: dupExtra.length,
          duplicate_hours_excluded: round2(dupExtra.reduce((n, r) => n + (r.total_auth_hours || 0), 0)),
          // Counted for scheduling, not yet billable.
          needs_auth_number: {
            rows: unverified.length,
            hours: round2(unverified.reduce((n, r) => n + (r.total_auth_hours || 0), 0)),
            clients: [...new Set(unverified.map((r) => r.child_name || r.client_name_raw))].sort(),
          },
          // Every row that did not count, and why. Nothing disappears silently.
          excluded: ["no_number", "no_dates", "not_started", "expired", "duplicate_line"].map((reason) => {
            const list = excluded.filter((r) => r.validity.reason === reason);
            return {
              reason, rows: list.length,
              hours: round2(list.reduce((n, r) => n + (r.total_auth_hours || 0), 0)),
              clients: [...new Set(list.map((r) => r.child_name || r.client_name_raw))].sort(),
            };
          }).filter((x) => x.rows > 0),
          totals: {
            authorized: round2(clientsOut.reduce((n, c) => n + c.authorized, 0)),
            scheduled: round2(clientsOut.reduce((n, c) => n + c.scheduled, 0)),
            unscheduled: round2(clientsOut.reduce((n, c) => n + c.unscheduled, 0)),
          },
          expiring_30: rows.filter((r) => r.days_until_expiration != null && r.days_until_expiration >= 0 && r.days_until_expiration <= 30).length,
          expired: excluded.filter((r) => r.validity.reason === "expired").length,
        });
        return true;
      }

      // Link an imported row to a client after the fact.
      const linkMatch = pathname.match(/^\/api\/auth-util\/(\d+)\/link$/);
      if (linkMatch && method === "POST") {
        if (!canImport(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const b = await readBody(req);
        const clientId = Number(b.client_id || 0);
        if (!clientId) { json(res, 400, { error: "Choose a client." }); return true; }
        const client = await dbGet("SELECT id FROM clients WHERE id = ?", [clientId]);
        if (!client) { json(res, 404, { error: "That client no longer exists." }); return true; }
        const auth = await dbGet("SELECT * FROM client_authorizations WHERE id = ?", [Number(linkMatch[1])]);
        if (!auth) { json(res, 404, { error: "That authorization no longer exists." }); return true; }
        // Link every row for the same exported name at once -- they are all the
        // same child, and linking one at a time invites a half-linked client.
        await dbRun("UPDATE client_authorizations SET client_id = ?, updated_at = ? WHERE client_name_raw = ?",
          [clientId, nowISO(), auth.client_name_raw]);
        json(res, 200, { ok: true, linked: auth.client_name_raw });
        return true;
      }

      if (pathname === "/api/auth-util/unmatched" && method === "GET") {
        if (!canImport(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        json(res, 200, {
          rows: await dbAll("SELECT * FROM client_authorizations WHERE client_id IS NULL ORDER BY client_name_raw, billing_code"),
        });
        return true;
      }

      json(res, 404, { error: "Not found" });
      return true;
    } catch (err) {
      console.error("authorizations.js error on", method, pathname, err);
      json(res, 500, { error: err.message || "Something went wrong." });
      return true;
    }
  }

  return {
    initTables,
    handleApi,
    parseExport,
    authValidity,
    _lib: { parseUnits, parseGoal, parseDates, parseClientName, scoreClient, matchRow, authValidity, UNITS_PER_HOUR },
  };
};
