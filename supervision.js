// supervision.js -- RBT Supervision Tracker add-on.
//
// Monthly supervision log per employee (mirrors the "August Supervision
// Tracker" spreadsheet: one entry per supervision session with date, activity/
// client, time in/out, duration, face-to-face, supervisor, observed-with-client,
// individual/group, notes). Total monthly worked hours (the denominator for the
// BACB "≥5% of hours" rule) can be typed or imported from the Rethink payroll
// export. A BCBA signs off each month; on sign-off a summary PDF is generated,
// stored, and auto-emailed to the staff member and the BCBA.
//
// Additive per RULE ZERO: new table hr_supervision_logs, routes under
// /api/supervision/*, reuses hr_employees + Resend. Owns nothing existing.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

module.exports = function initSupervision(ctx) {
  const { dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json } = ctx;
  const onCompletion = ctx.onCompletion || (() => {});

  const DATA_DIR = path.join(__dirname, "data");
  const SUP_DIR = path.join(DATA_DIR, "supervision");
  if (!fs.existsSync(SUP_DIR)) fs.mkdirSync(SUP_DIR, { recursive: true });

  const BACB_MIN_PCT = 5; // BACB minimum: 5% of monthly service hours.

  // Who belongs on this tracker. RBTs are supervised; BCBAs do the supervising,
  // so a fully certified BCBA on the list is a permanently unmeetable 0% that
  // makes the whole board look non-compliant.
  //
  // Student analysts are the trap. They are RBTs pursuing certification, so
  // they DO need supervision, and several of them carry BCBA-flavoured access
  // in the CRM. The rule therefore reads the job title, not the login role, and
  // anything mentioning "student" stays on the tracker no matter what else the
  // title says.
  //
  // A title is a guess, so it is only ever the default: hr_employees
  // .supervision_required overrides it in either direction, and the tracker
  // shows who has been left off so nobody is silently dropped.
  const BCBA_TITLE = /\bBCBA\b|\bBCaBA\b|board[ -]?certified behavior analyst|clinical director/i;
  const STUDENT_TITLE = /student|in[- ]training|trainee|candidate|\bRBT\b/i;

  function supervisionDefault(emp) {
    const title = String((emp && emp.role_title) || "");
    if (!title.trim()) return true;               // unknown title: keep them on, visible
    if (STUDENT_TITLE.test(title)) return true;   // student analysts are RBTs
    return !BCBA_TITLE.test(title);
  }

  function isTracked(emp) {
    if (emp && (emp.supervision_required === true || emp.supervision_required === "t")) return true;
    if (emp && (emp.supervision_required === false || emp.supervision_required === "f")) return false;
    return supervisionDefault(emp);
  }

  function whyOff(emp) {
    if (emp && (emp.supervision_required === false || emp.supervision_required === "f")) {
      return "Taken off the tracker by hand";
    }
    return `${emp.role_title || "This role"} supervises rather than being supervised`;
  }

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_supervision_logs (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      month TEXT NOT NULL,               -- 'YYYY-MM'
      entries TEXT,                      -- JSON array of session rows
      hours_worked NUMERIC DEFAULT 0,    -- denominator (from Rethink or typed)
      signed_off BOOLEAN DEFAULT FALSE,
      signed_by TEXT,
      signed_at TEXT,
      pdf_stored TEXT,
      emailed_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE (employee_id, month)
    )`).catch((e) => console.error("supervision initTables:", e.message));

    // NULL means "decide from the job title". TRUE/FALSE is a human overruling
    // that guess for one person, which survives any later change to the rule.
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS supervision_required BOOLEAN")
      .catch((e) => console.error("supervision_required column:", e.message));

    // Amendments to an already-signed month. A signed month is a compliance
    // record: it can still be corrected -- people do log the wrong date, or a
    // session that never happened -- but not quietly. Every change after
    // sign-off keeps the entries as they were signed, who changed them, and
    // why, and drops the month back to unsigned so a BCBA has to look again.
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_supervision_amendments (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      reason TEXT NOT NULL,
      changed_by TEXT,
      changed_at TEXT,
      previous_entries TEXT,
      previous_hours_worked NUMERIC,
      previous_signed_by TEXT,
      previous_signed_at TEXT
    )`).catch((e) => console.error("supervision amendments initTables:", e.message));
  }

  function role(u) { return (u && (u.role || u.role_key || "")) || ""; }

  // A per-user grant from the Access editor unlocks this module's ordinary
  // access tier even when the role list wouldn't. Manage/sensitive tiers stay
  // role-gated.
  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  function canManage(u) { return ["owner", "super_admin", "admin", "hr_admin", "clinical"].includes(role(u)) || granted(u, "supervision"); }

  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
  function supHours(entries) {
    return Math.round((entries || []).reduce((s, e) => s + num(e.duration), 0) * 100) / 100;
  }
  function pct(sup, worked) {
    if (!worked) return null;
    return Math.round((sup / worked) * 1000) / 10; // one decimal
  }
  function thisMonth() {
    // Derived from nowISO() so it stays resume-safe (no Date.now()).
    return nowISO().slice(0, 7);
  }

  async function logActivity(employeeId, text) {
    const emp = await dbGet("SELECT hr_activity FROM hr_employees WHERE id = ?", [employeeId]).catch(() => null);
    if (!emp) return;
    let arr = [];
    try { arr = JSON.parse(emp.hr_activity || "[]"); } catch (e) { arr = []; }
    arr.unshift({ at: nowISO(), text });
    await dbRun("UPDATE hr_employees SET hr_activity = ? WHERE id = ?", [JSON.stringify(arr.slice(0, 200)), employeeId]).catch(() => {});
  }

  // ---- minimal .xlsx reader (Rethink Summary sheet: Id/First/Last/RegHours) --
  function unzip(buffer) {
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Not a readable .xlsx.");
    const count = buffer.readUInt16LE(eocd + 10), cdOff = buffer.readUInt32LE(eocd + 16);
    const files = {}; let p = cdOff;
    for (let n = 0; n < count; n++) {
      if (buffer.readUInt32LE(p) !== 0x02014b50) break;
      const method = buffer.readUInt16LE(p + 10), compSize = buffer.readUInt32LE(p + 20);
      const fnLen = buffer.readUInt16LE(p + 28), exLen = buffer.readUInt16LE(p + 30), cmLen = buffer.readUInt16LE(p + 32);
      const lo = buffer.readUInt32LE(p + 42);
      const name = buffer.toString("utf8", p + 46, p + 46 + fnLen);
      const lfn = buffer.readUInt16LE(lo + 26), lex = buffer.readUInt16LE(lo + 28);
      const start = lo + 30 + lfn + lex, comp = buffer.slice(start, start + compSize);
      try { files[name] = method === 0 ? comp : zlib.inflateRawSync(comp); } catch (e) {}
      p += 46 + fnLen + exLen + cmLen;
    }
    return files;
  }
  function xmlUn(s) { return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
  function colIdx(r) { const m = r.match(/^([A-Z]+)/); let n = 0; for (const c of m[1]) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; }
  function rowsOf(xml, shared) {
    const rows = []; const rre = /<row[^>]*>([\s\S]*?)<\/row>/g; let rm;
    while ((rm = rre.exec(xml))) {
      const cells = []; const cre = /<c\s+r="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
      while ((cm = cre.exec(rm[1]))) {
        const ci = colIdx(cm[1]); const a = cm[2] || "", inner = cm[3] || "";
        const t = (a.match(/t="([^"]+)"/) || [])[1] || ""; const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        let val = ""; if (t === "s" && v) val = shared[+v[1]] || ""; else if (v) val = v[1];
        cells[ci] = val;
      }
      rows.push(cells);
    }
    return rows;
  }
  // Returns { "firstname lastname": hoursWorked, "rethinkId": hours } maps.
  function parseRethinkHours(buffer) {
    const files = unzip(buffer);
    const dec = (b) => (b ? b.toString("utf8") : "");
    const shared = []; const sx = dec(files["xl/sharedStrings.xml"]); const sre = /<si>([\s\S]*?)<\/si>/g; let sm;
    while ((sm = sre.exec(sx))) { let s = ""; const t = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm; while ((tm = t.exec(sm[1]))) s += tm[1]; shared.push(xmlUn(s)); }
    // Locate the "Summary" sheet via workbook rels.
    const rels = dec(files["xl/_rels/workbook.xml.rels"]); const relMap = {}; let rr; const rx = /<Relationship\b([^>]*)\/>/g;
    while ((rr = rx.exec(rels))) { const id = (rr[1].match(/Id="([^"]+)"/) || [])[1], tg = (rr[1].match(/Target="([^"]+)"/) || [])[1]; if (id && tg) relMap[id] = tg; }
    const wb = dec(files["xl/workbook.xml"]); let target = ""; let sh; const shx = /<sheet\b([^>]*)\/>/g;
    while ((sh = shx.exec(wb))) { const nm = (sh[1].match(/name="([^"]+)"/) || [])[1]; const rid = (sh[1].match(/r:id="([^"]+)"/) || [])[1]; if (nm && /summary/i.test(nm)) { target = relMap[rid] || ""; break; } }
    if (!target) return { byName: {}, byId: {} };
    if (!target.startsWith("xl/")) target = "xl/" + target.replace(/^\//, "");
    const rows = rowsOf(dec(files[target]), shared);
    let h = rows.findIndex((r) => String((r || [])[0] || "").trim().toLowerCase() === "id"); if (h < 0) h = 1;
    const hdr = rows[h] || []; const col = (nm) => hdr.findIndex((x) => String(x || "").trim().toLowerCase() === nm.toLowerCase());
    const cId = col("Id"), cF = col("FirstName"), cL = col("LastName"), cReg = col("RegHours"), cOt1 = col("OT1Hours"), cOt2 = col("OT2Hours");
    const byName = {}, byId = {};
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i] || []; const id = String(r[cId] || "").trim(); if (!id && !r[cF]) continue;
      const worked = num(r[cReg]) + (cOt1 >= 0 ? num(r[cOt1]) : 0) + (cOt2 >= 0 ? num(r[cOt2]) : 0);
      const name = `${r[cF] || ""} ${r[cL] || ""}`.trim().toLowerCase();
      if (id) byId[id] = worked;
      if (name) byName[name] = worked;
    }
    return { byName, byId };
  }

  // ---- summary rollup for a month (list + overall %) -----------------------
  async function monthSummary(month) {
    const allEmps = await dbAll("SELECT id, name, role_title, rethink_id, hr_stage, status, supervision_required FROM hr_employees WHERE COALESCE(status,'active') <> 'terminated' ORDER BY name");
    const emps = allEmps.filter(isTracked);
    // Everyone left off, and why. Shown on the page rather than silently
    // dropped -- a name missing from a compliance tracker with no explanation
    // is exactly the kind of gap nobody notices until an audit.
    const excluded = allEmps.filter((e) => !isTracked(e)).map((e) => ({
      employee_id: e.id, name: e.name, role_title: e.role_title || "", reason: whyOff(e),
      manual: e.supervision_required === false || e.supervision_required === "f",
    }));
    const logs = await dbAll("SELECT * FROM hr_supervision_logs WHERE month = ?", [month]);
    const byEmp = {}; logs.forEach((l) => { byEmp[l.employee_id] = l; });
    let totSup = 0, totWorked = 0, needUpload = 0, signed = 0;
    const list = emps.map((e) => {
      const l = byEmp[e.id];
      let entries = []; try { entries = l && l.entries ? JSON.parse(l.entries) : []; } catch (x) {}
      const sup = supHours(entries);
      const worked = l ? num(l.hours_worked) : 0;
      const p = pct(sup, worked);
      totSup += sup; totWorked += worked;
      if (!worked) needUpload++;
      if (l && l.signed_off) signed++;
      return {
        employee_id: e.id, name: e.name, role_title: e.role_title || "",
        sup_hours: sup, hours_worked: worked, pct: p,
        meets: p != null ? p >= BACB_MIN_PCT : false,
        signed_off: !!(l && l.signed_off), signed_by: l && l.signed_by, signed_at: l && l.signed_at,
        entry_count: entries.length,
      };
    });
    return {
      month, min_pct: BACB_MIN_PCT,
      employees: list,
      excluded,
      overall_pct: pct(totSup, totWorked),
      total_sup_hours: Math.round(totSup * 100) / 100,
      total_worked_hours: Math.round(totWorked * 100) / 100,
      need_hours_upload: needUpload,
      signed_count: signed,
      staff_count: list.length,
    };
  }

  // ---- minimal PDF (text table) for the signed monthly summary -------------
  function pdfEsc(s) { return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
  function buildPdf(emp, month, entries, worked, supervisor, signedAt) {
    const pageW = 612, pageH = 792, m = 48; const c = []; let y = pageH - m;
    const L = (s, sz, f) => { c.push(`BT /${f} ${sz} Tf 1 0 0 1 ${m} ${y} Tm (${pdfEsc(s)}) Tj ET`); };
    L(`${emp.name} — Supervision Summary (${month})`, 16, "FB"); y -= 20;
    L("Spectrum Squad", 10, "F"); y -= 20;
    const sup = supHours(entries); const p = pct(sup, worked);
    L(`Supervision hours: ${sup}    Monthly worked hours: ${worked}    Percentage: ${p == null ? "n/a" : p + "%"} (min ${BACB_MIN_PCT}%)`, 11, "F"); y -= 22;
    L("Date        Activity/Client            Dur   F2F  Supervisor          Obs  Type", 9, "FB"); y -= 13;
    entries.slice(0, 40).forEach((e) => {
      const row = [
        (e.date || "").toString().slice(0, 10).padEnd(11),
        (e.activity || "").toString().slice(0, 24).padEnd(25),
        (String(e.duration || "")).padEnd(5),
        (e.face_to_face ? "Y" : "N").padEnd(4),
        (e.supervisor || "").toString().slice(0, 18).padEnd(19),
        (e.observed ? "Y" : "N").padEnd(4),
        (e.group || "").toString().slice(0, 10),
      ].join(" ");
      L(row, 9, "F"); y -= 12; if (y < 90) y = 90;
    });
    y -= 20;
    L(`Signed off by (BCBA): ${supervisor || ""}`, 11, "FB"); y -= 15;
    L(`Signed (UTC): ${signedAt || ""}`, 10, "F");
    const content = c.join("\n"); const enc = (s) => Buffer.from(s, "latin1"); const chunks = []; let off = 0; const xr = [];
    const push = (b) => { chunks.push(b); off += b.length; }; const obj = (n, b) => { xr[n] = off; push(enc(`${n} 0 obj\n`)); push(b); push(enc("\nendobj\n")); };
    push(enc("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"));
    obj(1, enc("<< /Type /Catalog /Pages 2 0 R >>"));
    obj(2, enc("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
    obj(3, enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F 5 0 R /FB 6 0 R >> >> /Contents 4 0 R >>`));
    const cb = enc(content); xr[4] = off; push(enc(`4 0 obj\n<< /Length ${cb.length} >>\nstream\n`)); push(cb); push(enc("\nendstream\nendobj\n"));
    obj(5, enc("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"));
    obj(6, enc("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>"));
    const xs = off; const cnt = 7; let x = `xref\n0 ${cnt}\n0000000000 65535 f \n`;
    for (let i = 1; i < cnt; i++) x += String(xr[i] || 0).padStart(10, "0") + " 00000 n \n";
    push(enc(x)); push(enc(`trailer\n<< /Size ${cnt} /Root 1 0 R >>\nstartxref\n${xs}\n%%EOF`));
    return Buffer.concat(chunks);
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/supervision")) return false;
    try {
      if (!user) return json(res, 401, { error: "Not authenticated" });
      if (!canManage(user)) return json(res, 403, { error: "Not permitted" });
      const actor = user.email || user.name || "user";
      const month = (query.month && /^\d{4}-\d{2}$/.test(query.month)) ? query.month : thisMonth();

      if (pathname === "/api/supervision/summary" && method === "GET") {
        return json(res, 200, await monthSummary(month));
      }
      if (pathname === "/api/supervision" && method === "GET") {
        return json(res, 200, await monthSummary(month));
      }

      // Import monthly worked hours from a Rethink payroll export.
      if (pathname === "/api/supervision/import-hours" && method === "POST") {
        const b = await readBody(req);
        if (!b.content_base64) return json(res, 400, { error: "No file provided." });
        const mo = (b.month && /^\d{4}-\d{2}$/.test(b.month)) ? b.month : thisMonth();
        let buf; try { let s = String(b.content_base64); const ci = s.indexOf(","); if (s.startsWith("data:") && ci >= 0) s = s.slice(ci + 1); buf = Buffer.from(s, "base64"); }
        catch (e) { return json(res, 400, { error: "Could not read the file." }); }
        let maps; try { maps = parseRethinkHours(buf); } catch (e) { return json(res, 400, { error: "Could not parse export: " + e.message }); }
        const emps = await dbAll("SELECT id, name, rethink_id FROM hr_employees");
        let updated = 0; const unmatched = [];
        for (const e of emps) {
          let worked = null;
          if (e.rethink_id && maps.byId[String(e.rethink_id)] != null) worked = maps.byId[String(e.rethink_id)];
          else if (e.name && maps.byName[e.name.trim().toLowerCase()] != null) worked = maps.byName[e.name.trim().toLowerCase()];
          if (worked == null) continue;
          await dbRun(
            `INSERT INTO hr_supervision_logs (employee_id, month, entries, hours_worked, created_at, updated_at)
             VALUES (?, ?, '[]', ?, ?, ?)
             ON CONFLICT (employee_id, month) DO UPDATE SET hours_worked = EXCLUDED.hours_worked, updated_at = EXCLUDED.updated_at`,
            [e.id, mo, worked, nowISO(), nowISO()]
          );
          updated++;
        }
        return json(res, 200, { ok: true, month: mo, updated });
      }

      const empMatch = pathname.match(/^\/api\/supervision\/employee\/(\d+)$/);
      if (empMatch && method === "GET") {
        const empId = Number(empMatch[1]);
        const emp = await dbGet("SELECT id, name, role_title FROM hr_employees WHERE id = ?", [empId]);
        if (!emp) return json(res, 404, { error: "Not found" });
        const log = await dbGet("SELECT * FROM hr_supervision_logs WHERE employee_id = ? AND month = ?", [empId, month]);
        let entries = []; try { entries = log && log.entries ? JSON.parse(log.entries) : []; } catch (x) {}
        const worked = log ? num(log.hours_worked) : 0; const sup = supHours(entries);
        // Recent history (last 12 months).
        const hist = await dbAll("SELECT month, entries, hours_worked, signed_off FROM hr_supervision_logs WHERE employee_id = ? ORDER BY month DESC LIMIT 12", [empId]);
        return json(res, 200, {
          employee: emp, month, entries, hours_worked: worked, sup_hours: sup, pct: pct(sup, worked),
          min_pct: BACB_MIN_PCT, signed_off: !!(log && log.signed_off), signed_by: log && log.signed_by, signed_at: log && log.signed_at,
          has_pdf: !!(log && log.pdf_stored),
          amendments: await dbAll(
            "SELECT reason, changed_by, changed_at, previous_signed_by FROM hr_supervision_amendments WHERE employee_id = ? AND month = ? ORDER BY id DESC",
            [empId, month]
          ).catch(() => []),
          history: hist.map((h) => { let en = []; try { en = JSON.parse(h.entries || "[]"); } catch (x) {} const s = supHours(en); return { month: h.month, sup_hours: s, hours_worked: num(h.hours_worked), pct: pct(s, num(h.hours_worked)), signed_off: !!h.signed_off }; }),
        });
      }

      // Save/replace the month's entries (+ optional hours_worked).
      if (empMatch && method === "POST") {
        const empId = Number(empMatch[1]);
        const b = await readBody(req);
        const mo = (b.month && /^\d{4}-\d{2}$/.test(b.month)) ? b.month : month;
        const entries = Array.isArray(b.entries) ? b.entries.map((e) => ({
          date: e.date || "", activity: e.activity || "", time_in: e.time_in || "", time_out: e.time_out || "",
          duration: num(e.duration), face_to_face: !!e.face_to_face, supervisor: e.supervisor || "",
          observed: !!e.observed, group: e.group || "", notes: e.notes || "",
        })) : [];
        const existing = await dbGet("SELECT * FROM hr_supervision_logs WHERE employee_id = ? AND month = ?", [empId, mo]);
        const worked = b.hours_worked != null ? num(b.hours_worked) : (existing ? num(existing.hours_worked) : 0);

        // A month that has been signed off can still be corrected, but the
        // correction is recorded and the signature is withdrawn. Leaving
        // signed_off = TRUE would mean a stored PDF, and an email already in
        // two inboxes, that no longer match the record they attest to.
        let amended = false;
        if (existing && existing.signed_off) {
          const changed =
            String(existing.entries || "[]") !== JSON.stringify(entries) ||
            num(existing.hours_worked) !== worked;
          if (changed) {
            const reason = String(b.change_reason || "").trim();
            if (!reason) {
              // Human sentence in `error` because that is the field the app's
              // api() helper surfaces; `code` is there for any caller that
              // wants to branch on it rather than read English.
              return json(res, 400, {
                error: `${mo} was signed off by ${existing.signed_by || "a BCBA"}. Say what you're correcting, and the month will go back to needing a fresh sign-off.`,
                code: "signed_off_needs_reason",
              });
            }
            await dbRun(
              `INSERT INTO hr_supervision_amendments
                 (employee_id, month, reason, changed_by, changed_at, previous_entries, previous_hours_worked, previous_signed_by, previous_signed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [empId, mo, reason, user.name || user.email || "unknown", nowISO(),
               existing.entries || "[]", num(existing.hours_worked), existing.signed_by, existing.signed_at]
            );
            // The PDF row is cleared rather than the file deleted: the signed
            // copy stays on disk as the historical artefact, it just stops
            // being offered as this month's current record.
            await dbRun(
              "UPDATE hr_supervision_logs SET signed_off = FALSE, signed_by = NULL, signed_at = NULL, pdf_stored = NULL WHERE id = ?",
              [existing.id]
            );
            await logActivity(empId, `Supervision for ${mo} amended after sign-off by ${user.name || user.email}: ${reason}. Needs a fresh BCBA sign-off.`);
            amended = true;
          }
        }

        await dbRun(
          `INSERT INTO hr_supervision_logs (employee_id, month, entries, hours_worked, signed_off, created_at, updated_at)
           VALUES (?, ?, ?, ?, FALSE, ?, ?)
           ON CONFLICT (employee_id, month) DO UPDATE SET entries = EXCLUDED.entries, hours_worked = EXCLUDED.hours_worked, updated_at = EXCLUDED.updated_at`,
          [empId, mo, JSON.stringify(entries), worked, nowISO(), nowISO()]
        );
        return json(res, 200, { ok: true, amended, sup_hours: supHours(entries), pct: pct(supHours(entries), worked) });
      }

      // BCBA sign-off → PDF + auto-email staff + BCBA.
      // Put someone on or take them off the tracker by hand. `tracked: null`
      // hands the decision back to the job-title rule.
      const trackMatch = pathname.match(/^\/api\/supervision\/employee\/(\d+)\/tracked$/);
      if (trackMatch && method === "PATCH") {
        const empId = Number(trackMatch[1]);
        const b = await readBody(req);
        const emp = await dbGet("SELECT id, name, role_title FROM hr_employees WHERE id = ?", [empId]);
        if (!emp) return json(res, 404, { error: "Not found" });
        const val = b.tracked === null || b.tracked === "auto" ? null : !!b.tracked;
        await dbRun("UPDATE hr_employees SET supervision_required = ? WHERE id = ?", [val, empId]);
        await logActivity(empId, val === null
          ? `Supervision tracking set back to automatic (by job title) by ${actor}.`
          : `${val ? "Added to" : "Removed from"} the RBT supervision tracker by ${actor}.`);
        return json(res, 200, { ok: true, employee_id: empId, supervision_required: val, tracked: isTracked({ ...emp, supervision_required: val }) });
      }

      const signMatch = pathname.match(/^\/api\/supervision\/employee\/(\d+)\/sign-off$/);
      if (signMatch && method === "POST") {
        const empId = Number(signMatch[1]);
        const b = await readBody(req);
        const mo = (b.month && /^\d{4}-\d{2}$/.test(b.month)) ? b.month : month;
        const supervisor = (b.supervisor_name || user.name || "").trim();
        if (!supervisor) return json(res, 400, { error: "Supervisor (BCBA) name is required to sign off." });
        const log = await dbGet("SELECT * FROM hr_supervision_logs WHERE employee_id = ? AND month = ?", [empId, mo]);
        if (!log) return json(res, 404, { error: "No supervision log for that month yet." });
        const emp = await dbGet("SELECT id, name, email FROM hr_employees WHERE id = ?", [empId]);
        let entries = []; try { entries = JSON.parse(log.entries || "[]"); } catch (x) {}
        const signedAt = nowISO();
        let stored = null;
        try {
          const pdf = buildPdf(emp, mo, entries, num(log.hours_worked), supervisor, signedAt);
          stored = `sup_${empId}_${mo}_${crypto.randomBytes(4).toString("hex")}.pdf`;
          fs.writeFileSync(path.join(SUP_DIR, stored), pdf);
        } catch (e) { console.error("supervision PDF failed:", e.message); }
        await dbRun("UPDATE hr_supervision_logs SET signed_off = TRUE, signed_by = ?, signed_at = ?, pdf_stored = ?, emailed_at = ? WHERE id = ?",
          [supervisor, signedAt, stored, signedAt, log.id]);
        // Auto-email staff + the signing BCBA.
        const sup = supHours(entries); const p = pct(sup, num(log.hours_worked));
        const body = `<p>Supervision summary for <strong>${escLite(emp.name)}</strong> — <strong>${escLite(mo)}</strong>:</p>
          <ul>
            <li>Supervision hours: <strong>${sup}</strong></li>
            <li>Monthly worked hours: <strong>${num(log.hours_worked)}</strong></li>
            <li>Percentage: <strong>${p == null ? "n/a" : p + "%"}</strong> (BACB minimum ${BACB_MIN_PCT}%)</li>
            <li>Signed off by (BCBA): <strong>${escLite(supervisor)}</strong> on ${escLite(signedAt.slice(0, 10))}</li>
          </ul>
          <p>This is the official monthly supervision record. Keep for your files.</p>`;
        const recipients = [];
        if (emp.email) recipients.push(emp.email);
        const bcba = await dbGet("SELECT email FROM hr_employees WHERE LOWER(name) = LOWER(?) LIMIT 1", [supervisor]).catch(() => null);
        if (bcba && bcba.email) recipients.push(bcba.email);
        if (user.email) recipients.push(user.email);
        for (const to of [...new Set(recipients)]) {
          await sendEmail({ to, subject: `Supervision signed off — ${emp.name} (${mo})`, html: body, type: "supervision_signoff" }).catch((e) => console.error("supervision email:", e.message));
        }
        await logActivity(empId, `Supervision for ${mo} signed off by ${supervisor} (${p == null ? "n/a" : p + "%"}).`);
        // Keyed on employee + month + the moment it was signed, because a month
        // that is amended and re-signed is a genuinely new sign-off.
        onCompletion("supervision_signed_off", {
          subject: emp.name,
          detail: `${mo} — ${sup} supervision hrs${p == null ? "" : ` (${p}%)`}, signed by ${supervisor}`,
          employeeId: empId,
          dedupeKey: `supervision:${empId}:${mo}:${signedAt}`,
        });
        return json(res, 200, { ok: true, emailed: [...new Set(recipients)], has_pdf: !!stored });
      }

      const pdfMatch = pathname.match(/^\/api\/supervision\/employee\/(\d+)\/pdf$/);
      if (pdfMatch && method === "GET") {
        const log = await dbGet("SELECT * FROM hr_supervision_logs WHERE employee_id = ? AND month = ?", [Number(pdfMatch[1]), month]);
        if (!log || !log.pdf_stored) return json(res, 404, { error: "No signed PDF yet." });
        const full = path.join(SUP_DIR, log.pdf_stored);
        if (!fs.existsSync(full)) return json(res, 404, { error: "PDF missing" });
        const data = fs.readFileSync(full);
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="supervision-${pdfMatch[1]}-${month}.pdf"`, "Content-Length": data.length });
        res.end(data); return true;
      }

      return false;
    } catch (e) {
      console.error("supervision handleApi error:", e);
      return json(res, 500, { error: "Supervision error: " + e.message });
    }
  }

  function escLite(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // Compact data for the dashboard widget.
  async function widget(month) {
    const s = await monthSummary(month || thisMonth());
    return {
      month: s.month, overall_pct: s.overall_pct, min_pct: s.min_pct,
      need_hours_upload: s.need_hours_upload, signed_count: s.signed_count, staff_count: s.staff_count,
      meeting: s.employees.filter((e) => e.meets).length,
    };
  }

  return { initTables, handleApi, widget, _internal: { parseRethinkHours, monthSummary, buildPdf } };
};
