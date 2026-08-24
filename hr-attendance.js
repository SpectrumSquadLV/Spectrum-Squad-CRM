// hr-attendance.js -- Employee Attendance Flag + Acknowledgment add-on.
//
// Implements section 7 of the HR module spec: log an attendance flag against a
// staff member (date / reason / notes), generate a written acknowledgment the
// employee signs (draw-to-sign + typed name), export the signed acknowledgment
// as a timestamped PDF stored to the staff record, auto-task any acknowledgment
// left unsigned for more than 7 days, and surface a 90-day flag counter.
//
// Additive per RULE ZERO: new table `hr_attendance_flags`, all routes under
// /api/attendance/*, reuses the existing hr_employees identity, staff_tasks
// system, and Resend sender. No existing code is modified by this file.

const fs = require("fs");
const path = require("path");

module.exports = function initHrAttendance(ctx) {
  const { dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json } = ctx;

  const DATA_DIR = path.join(__dirname, "data");
  const ATT_DIR = path.join(DATA_DIR, "hr-attendance");
  if (!fs.existsSync(ATT_DIR)) fs.mkdirSync(ATT_DIR, { recursive: true });

  // Legacy free-text reasons. Kept so flags logged before the points matrix
  // existed still render; new occurrences carry a type_key from ATTENDANCE_MATRIX.
  const REASONS = ["No call/no show", "Late arrival", "Early departure", "Excessive callouts", "Other"];

  // ===================== THE ATTENDANCE MATRIX =====================
  // Spectrum Squad Attendance & Punctuality Policy, matrix effective 6/1/2026.
  // Transcribed from the "Attendance Log - RBTs" sheet this replaces. These are
  // seed values only: hr_attendance_types is the live copy and is editable in
  // the app, because the policy is dated and will be revised again.
  const MATRIX_EFFECTIVE = "2026-06-01";
  const ATTENDANCE_MATRIX = [
    // --- occurrences (points added) ---
    { key: "late", label: "Late (any amount of time)", description: "Clocking in after scheduled start", points: 0.5, kind: "occurrence", sort_order: 10 },
    { key: "calloff_lt4_nonemergency", label: "Call-off with less than 4 hours notice - Non-Emergency/No Documentation", description: "Non-emergency / no documentation", points: 2.0, kind: "occurrence", sort_order: 20 },
    { key: "calloff_lt4_emergency", label: "Call-off with less than 4 hours notice (Emergency)", description: "Day-of call-off with emergency documentation", points: 1.0, kind: "occurrence", sort_order: 30 },
    { key: "calloff_gt4", label: "Call-off (with more than 4 hours notice)", description: "Calling off the day of, for any reason", points: 1.0, kind: "occurrence", sort_order: 40 },
    { key: "timeoff_post_finalization", label: "Time Off Request Post Monthly Schedule Finalization", description: "Requested after time-off requests were due or within the week prior", points: 0.5, kind: "occurrence", sort_order: 50 },
    { key: "missed_clock", label: "Missed Clock-in/Out", description: "Includes failure to submit session notes by end of session day", points: 0.5, kind: "occurrence", sort_order: 60 },
    { key: "left_early", label: "Leaving Early or Abandoning Shift", description: "Without prior approval", points: 2.0, kind: "occurrence", sort_order: 70 },
    { key: "ncns", label: "No Call/No Show Prior to Shift Starting", description: "No contact before shift. 5+ may lead to termination.", points: 5.0, kind: "occurrence", sort_order: 80 },
    { key: "probation_absence", label: "Unscheduled Absence During Probation Period", description: "Calling off within the first 90 days. 1+ for each day missed.", points: 1.0, kind: "occurrence", sort_order: 90 },
    // --- earn-backs (points removed) ---
    { key: "perfect_30", label: "Perfect attendance (30 days)", description: "Perfect attendance for 30 days", points: -1.0, kind: "earnback", sort_order: 100 },
    { key: "perfect_60", label: "Perfect attendance (60 days)", description: "Perfect attendance for 60 days", points: -2.0, kind: "earnback", sort_order: 110 },
    { key: "picked_up_shift", label: "Picking up a last-minute shift (within 4 hours)", description: "Picked up within 4 hours", points: -1.0, kind: "earnback", sort_order: 120 },
    { key: "completed_aip", label: "Completion of attendance improvement plan", description: "Completed attendance improvement plan", points: -1.0, kind: "earnback", sort_order: 130 },
  ];

  // Rolling 90-day disciplinary ladder. Read highest-threshold-first.
  const DISCIPLINE_STEPS = [
    { at: 9, level: "Termination review" },
    { at: 7, level: "Final warning or probation" },
    { at: 5, level: "Written warning" },
    { at: 3, level: "Verbal reminder" },
    { at: 0, level: "Good standing" },
  ];

  // 30-Day Monthly Attendance Review Matrix.
  const MONTHLY_REVIEW = [
    { min: 4.5, level: "Leadership Review", action: "Review caseload / disciplinary action", bonus: "Not bonus eligible" },
    { min: 2.5, level: "Attendance Improvement Plan", action: "Create improvement plan", bonus: "Not bonus eligible for active cycle" },
    { min: 1.5, level: "Coaching Conversation", action: "Discuss patterns / support", bonus: "Not guaranteed" },
    { min: 0.5, level: "Meets Expectations", action: "Monitor and document", bonus: "May remain eligible only if 90-day points return to 0" },
    { min: 0, level: "Exceeds Expectations", action: "Recognize reliability", bonus: "Can remain eligible if 90-day points are 0" },
  ];

  const BONUS_AMOUNT = 50;      // $50
  const BONUS_CYCLE_DAYS = 90;  // paid every 90 days from hire date

  // ------------------------------------------------------------------ schema
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_attendance_flags (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      incident_date TEXT,
      reason TEXT,
      notes TEXT,
      acknowledged BOOLEAN DEFAULT FALSE,
      signature TEXT,
      typed_name TEXT,
      signed_date TEXT,
      pdf_stored TEXT,
      ack_token TEXT,
      followup_task_made TEXT,
      created_by TEXT,
      created_at TEXT
    )`).catch((e) => console.error("attendance initTables:", e.message));

    // The matrix itself, so the point values are data rather than code. Seeded
    // from ATTENDANCE_MATRIX on first boot and never overwritten afterwards --
    // once somebody edits a point value, that edit is the policy.
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_attendance_types (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT,
      points NUMERIC NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'occurrence',   -- occurrence | earnback
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_by TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("attendance types initTables:", e.message));
    for (const t of ATTENDANCE_MATRIX) {
      await dbRun(
        `INSERT INTO hr_attendance_types (key, label, description, points, kind, sort_order, active, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, 'system', ?)
         ON CONFLICT (key) DO NOTHING`,
        [t.key, t.label, t.description, t.points, t.kind, t.sort_order, nowISO()]
      ).catch((e) => console.error("attendance type seed:", e.message));
    }

    // Everything the matrix needs that a bare "flag" never carried. All
    // additive: a flag logged before this reads as a legacy row with no points.
    const cols = [
      ["type_key", "TEXT"],                 // -> hr_attendance_types.key
      ["points", "NUMERIC"],                // resolved at log time, so editing the matrix later cannot silently restate history
      ["shift_start", "TEXT"],              // 'HH:MM'
      ["time_notified", "TEXT"],            // 'HH:MM'
      ["notice_hours", "NUMERIC"],          // shift_start - time_notified, computed
      ["emergency", "BOOLEAN"],
      ["documentation", "BOOLEAN"],
      ["notified_at", "TEXT"],              // when the staff member was emailed about it
      ["voided", "BOOLEAN NOT NULL DEFAULT FALSE"],
      ["voided_reason", "TEXT"],
      ["voided_by", "TEXT"],
      ["voided_at", "TEXT"],
      ["imported_from", "TEXT"],            // set by the one-time sheet import
    ];
    for (const [name, type] of cols) {
      await dbRun(`ALTER TABLE hr_attendance_flags ADD COLUMN IF NOT EXISTS ${name} ${type}`)
        .catch((e) => console.error(`attendance column ${name}:`, e.message));
    }
    await dbRun(`CREATE INDEX IF NOT EXISTS hr_attendance_flags_emp_date_idx
                 ON hr_attendance_flags (employee_id, incident_date)`).catch(() => {});

    // One row per employee per month once their monthly review has been sent.
    // This is what makes the monthly send idempotent, and it doubles as the
    // review history -- what their points and level were at each checkpoint.
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_attendance_reviews (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      period TEXT NOT NULL,                 -- 'YYYY-MM'
      points_30 NUMERIC,
      review_level TEXT,
      review_action TEXT,
      points_90 NUMERIC,
      discipline_level TEXT,
      bonus_eligible BOOLEAN,
      next_bonus_date TEXT,
      emailed_to TEXT,
      created_at TEXT,
      UNIQUE (employee_id, period)
    )`).catch((e) => console.error("attendance reviews initTables:", e.message));
  }

  // -------------------------------------------------------------- permissions
  // The effective hire date, as SQL.
  //
  // There are two columns. `hire_date` is the original; `hr_hire_date` was
  // added later and is the one the Staff card writes and the offer-accepted
  // flow sets. Attendance read only the old one, so for anybody hired through
  // the app the bonus cycle said "No hire date on file" and never started --
  // which is exactly the bug this fixes. The Staff card already displays
  // `hr_hire_date || hire_date`, so this matches what a person sees on screen.
  //
  // NULLIF guards the empty string: a cleared date field stores "" rather than
  // NULL, and COALESCE alone would happily hand back "" as though it were set.
  const HIRE_DATE_SQL =
    "COALESCE(NULLIF(hr_hire_date, ''), NULLIF(hire_date, '')) AS hire_date";

  function role(user) { return (user && (user.role || user.role_key || "")) || ""; }
  function canManage(user) {
    return ["owner", "super_admin", "admin", "hr_admin"].includes(role(user));
  }
  // Changing point values, or firing the monthly review by hand, decides
  // discipline levels and who is owed a $50 bonus. Narrower than canManage on
  // purpose: an hr_admin can log and read attendance, but not rewrite the
  // policy the numbers come from.
  function canEditMatrix(user) {
    return ["owner", "super_admin", "admin"].includes(role(user));
  }

  // ---------------------------------------------------------------- helpers
  async function logEmpActivity(employeeId, text) {
    const emp = await dbGet("SELECT hr_activity FROM hr_employees WHERE id = ?", [employeeId]).catch(() => null);
    if (!emp) return;
    let arr = [];
    try { arr = JSON.parse(emp.hr_activity || "[]"); } catch (e) { arr = []; }
    arr.unshift({ at: nowISO(), text });
    await dbRun("UPDATE hr_employees SET hr_activity = ? WHERE id = ?", [JSON.stringify(arr.slice(0, 200)), employeeId]).catch(() => {});
  }

  async function makeStaffTask(title, employeeId) {
    await dbRun(
      `INSERT INTO staff_tasks (title, description, assigned_user_id, assigned_name, client_id, due_date, status, created_by, created_at)
       VALUES (?, ?, NULL, NULL, NULL, ?, 'open', 'Attendance auto', ?)`,
      [title, employeeId ? `Staff #${employeeId}` : null, nowISO().slice(0, 10), nowISO()]
    ).catch((e) => console.error("attendance staff task insert failed:", e.message));
  }

  // ===================== SCORING =====================
  // Everything the sheet computed with formulas, computed here instead. The
  // sheet keyed occurrences to staff by typing their NAME, and warned that the
  // names "MUST be identical ... in order for the formula to work" -- they were
  // not, so points were silently going missing (a staffer showing 0.0 while
  // carrying 2.5). Here an occurrence is keyed to employee_id, so a spelling
  // cannot drop it.

  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
  function round2(n) { return Math.round(n * 100) / 100; }

  // 'YYYY-MM-DD' for a date N days before the given day, in UTC. Attendance is
  // recorded per calendar date, so this deliberately does no timezone maths.
  function daysBefore(isoDay, n) {
    const d = new Date(String(isoDay).slice(0, 10) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }
  function addDays(isoDay, n) {
    const d = new Date(String(isoDay).slice(0, 10) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function today() { return nowISO().slice(0, 10); }

  // A voided occurrence is excluded from every total but is never deleted --
  // this is a disciplinary record, and "it was logged and then withdrawn" is
  // itself part of it.
  function countable(f) { return !(f.voided === true || f.voided === "t"); }

  function pointsBetween(rows, fromDay, toDay) {
    return round2(
      (rows || [])
        .filter(countable)
        .filter((f) => {
          const d = String(f.incident_date || f.created_at || "").slice(0, 10);
          return d && d >= fromDay && d <= toDay;
        })
        .reduce((sum, f) => sum + num(f.points), 0)
    );
  }

  function disciplineFor(points90) {
    for (const step of DISCIPLINE_STEPS) if (points90 >= step.at) return step.level;
    return "Good standing";
  }

  function monthlyReviewFor(points30) {
    for (const band of MONTHLY_REVIEW) if (points30 >= band.min) return band;
    return MONTHLY_REVIEW[MONTHLY_REVIEW.length - 1];
  }

  // Bonus cycles run from the hire date in 90-day steps, exactly as the sheet's
  // "Cycle 1/2/3/4 Eligible" columns do -- but the cycle only sets the PAYOUT
  // DATE. Eligibility is the rolling 90-day total, per the policy line "0
  // attendance points during a 90-day period".
  //
  // These come apart, which is why it is worth being explicit. Martha Vera in
  // the sheet is +2.5 rolling but NEGATIVE inside her current hire-date cycle
  // (four picked-up shifts since it began), and the sheet has her NOT
  // ELIGIBLE. Keying off the cycle window would have paid her the $50.
  function bonusCycle(hireDate, rows, asOfDay, points90) {
    const asOf = asOfDay || today();
    const hire = hireDate ? String(hireDate).slice(0, 10) : null;
    if (!hire || isNaN(new Date(hire + "T00:00:00Z").getTime())) {
      return { eligible: false, status: "No hire date on file", cycle_start: null, next_bonus_date: null, points_in_cycle: null };
    }
    const dayMs = 86400000;
    const elapsed = Math.floor(
      (new Date(asOf + "T00:00:00Z") - new Date(hire + "T00:00:00Z")) / dayMs
    );
    if (elapsed < 0) {
      return { eligible: false, status: "Hire date is in the future", cycle_start: hire, next_bonus_date: addDays(hire, BONUS_CYCLE_DAYS), points_in_cycle: null };
    }
    const completed = Math.floor(elapsed / BONUS_CYCLE_DAYS);
    const cycleStart = addDays(hire, completed * BONUS_CYCLE_DAYS);
    const nextBonus = addDays(hire, (completed + 1) * BONUS_CYCLE_DAYS);
    const inCycle = pointsBetween(rows, cycleStart, asOf);
    const rolling = points90 == null ? pointsBetween(rows, daysBefore(asOf, 90), asOf) : points90;
    const clean = rolling <= 0;
    if (completed === 0) {
      return {
        eligible: clean, status: "First 90-day cycle in progress",
        cycle_start: cycleStart, next_bonus_date: nextBonus,
        points_in_cycle: inCycle, points_rolling_90: rolling,
      };
    }
    return {
      eligible: clean,
      status: clean ? `Eligible — $${BONUS_AMOUNT} at next payout` : "Not eligible this cycle",
      cycle_start: cycleStart, next_bonus_date: nextBonus,
      points_in_cycle: inCycle, points_rolling_90: rolling,
    };
  }

  // The full picture for one employee, which is what both the roster and the
  // monthly review email are built from.
  function scoreEmployee(emp, rows, asOfDay) {
    const asOf = asOfDay || today();
    const points90 = pointsBetween(rows, daysBefore(asOf, 90), asOf);
    const points30 = pointsBetween(rows, daysBefore(asOf, 30), asOf);
    const band = monthlyReviewFor(points30);
    const bonus = bonusCycle(emp && emp.hire_date, rows, asOf, points90);
    const unsigned = (rows || []).filter((f) => countable(f) && !(f.acknowledged === true || f.acknowledged === "t")).length;
    return {
      employee_id: emp && emp.id,
      name: emp && emp.name,
      role_title: (emp && emp.role_title) || "",
      hire_date: (emp && emp.hire_date) || null,
      points_90: points90,
      discipline_level: disciplineFor(points90),
      points_30: points30,
      review_level: band.level,
      review_action: band.action,
      bonus_impact: band.bonus,
      bonus_eligible: bonus.eligible,
      bonus_status: bonus.status,
      bonus_cycle_start: bonus.cycle_start,
      next_bonus_date: bonus.next_bonus_date,
      points_in_bonus_cycle: bonus.points_in_cycle,
      unsigned_acknowledgments: unsigned,
      // "Staff who demonstrate repeated call-offs ... may have their caseload
      // reduced or split" -- surfaced at the written-warning threshold, which
      // is where the sheet's own Client Assignment Risk column flips.
      caseload_risk: points90 >= 5 ? "Review caseload" : "OK",
      occurrences_90: (rows || []).filter(countable).filter((f) => {
        const d = String(f.incident_date || "").slice(0, 10);
        return d && d >= daysBefore(asOf, 90) && d <= asOf;
      }).length,
    };
  }

  // Notice hours = shift start - time notified, on the incident date. This is
  // the sheet's "Notice Hours" column; negative means they told us after the
  // shift had already started.
  function noticeHours(shiftStart, timeNotified) {
    const parse = (t) => {
      const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})\s*([ap]m?)?$/i);
      if (!m) return null;
      let h = Number(m[1]) % 12;
      const min = Number(m[2]);
      const ap = (m[3] || "").toLowerCase();
      if (ap.startsWith("p")) h += 12;
      else if (!ap && Number(m[1]) <= 23) h = Number(m[1]); // 24-hour input
      return h * 60 + min;
    };
    const a = parse(shiftStart), b = parse(timeNotified);
    if (a == null || b == null) return null;
    return round2((a - b) / 60);
  }

  async function matrixTypes() {
    const rows = await dbAll("SELECT * FROM hr_attendance_types ORDER BY sort_order, label").catch(() => []);
    return rows.map((r) => ({ ...r, points: num(r.points) }));
  }
  async function typeByKey(key) {
    if (!key) return null;
    return dbGet("SELECT * FROM hr_attendance_types WHERE key = ?", [key]).catch(() => null);
  }

  function flagsInLast90(rows) {
    const cutoff = Date.now() - 90 * 86400000;
    return rows.filter((f) => {
      const d = f.incident_date || f.created_at;
      const t = d ? new Date(d).getTime() : 0;
      return t >= cutoff;
    }).length;
  }

  function acknowledgmentText(emp, flag) {
    return [
      `This document acknowledges that ${emp.name} has been informed of the attendance concern described below.`,
      "",
      `Date of incident: ${flag.incident_date || "(not specified)"}`,
      `Reason: ${flag.reason || "(not specified)"}`,
      `Notes: ${flag.notes || "(none)"}`,
      "",
      "By signing below, the employee confirms they have received and reviewed this attendance notice. Signing does not necessarily indicate agreement with the notice, only that it was received and reviewed.",
    ];
  }

  // ------------------------------------------------------- minimal PDF export
  function pdfEscape(s) {
    return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  }
  function wrapText(str, max) {
    const words = String(str == null ? "" : str).split(/\s+/);
    const lines = [];
    let cur = "";
    words.forEach((w) => {
      if (cur && (cur + " " + w).length > max) { lines.push(cur); cur = w; }
      else { cur = cur ? cur + " " + w : w; }
    });
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }

  // Builds a single-page US-Letter PDF with the acknowledgment text and, if
  // present, the drawn signature embedded as a baseline JPEG (DCTDecode — the
  // raw JPEG bytes can be placed straight into a PDF image stream, so no image
  // decoding library is needed). Returns a Buffer.
  function buildAckPdf(opts) {
    const pageW = 612, pageH = 792, margin = 56;
    const sigJpeg = opts.sigJpeg && opts.sigJpeg.length ? opts.sigJpeg : null;
    const c = [];
    let y = pageH - margin;
    const line = (str, size, font) => { c.push(`BT /${font} ${size} Tf 1 0 0 1 ${margin} ${y} Tm (${pdfEscape(str)}) Tj ET`); };

    line(opts.title || "Attendance Acknowledgment", 18, "FB"); y -= 26;
    line("Spectrum Squad", 11, "F"); y -= 22;

    (opts.paragraphs || []).forEach((p) => {
      if (p === "") { y -= 8; return; }
      wrapText(p, 92).forEach((ln) => { line(ln, 11, "F"); y -= 15; });
    });

    y -= 20;
    line("Employee signature:", 11, "FB"); y -= 6;
    let imgOps = "";
    if (sigJpeg) {
      const drawW = 220;
      const ratio = (opts.sigH && opts.sigW) ? (opts.sigH / opts.sigW) : 0.35;
      const drawH = Math.max(30, Math.round(drawW * ratio));
      const imgY = y - drawH;
      imgOps = `q ${drawW} 0 0 ${drawH} ${margin} ${imgY} cm /Im1 Do Q`;
      y = imgY - 18;
    } else {
      y -= 40;
    }
    line(`Typed name: ${opts.typedName || ""}`, 11, "F"); y -= 16;
    line(`Signed (UTC): ${opts.signedDate || ""}`, 11, "F"); y -= 16;
    line(`Document generated (UTC): ${opts.generatedDate || ""}`, 9, "F");

    const content = c.join("\n") + (imgOps ? ("\n" + imgOps) : "");

    const enc = (s) => Buffer.from(s, "latin1");
    const chunks = [];
    let offset = 0;
    const xref = [];
    const push = (buf) => { chunks.push(buf); offset += buf.length; };
    const obj = (n, bodyBuf) => { xref[n] = offset; push(enc(`${n} 0 obj\n`)); push(bodyBuf); push(enc(`\nendobj\n`)); };

    push(enc("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"));
    obj(1, enc("<< /Type /Catalog /Pages 2 0 R >>"));
    obj(2, enc("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
    const resources = `<< /Font << /F 5 0 R /FB 6 0 R >>${sigJpeg ? " /XObject << /Im1 7 0 R >>" : ""} >>`;
    obj(3, enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources ${resources} /Contents 4 0 R >>`));
    const contentBuf = enc(content);
    xref[4] = offset;
    push(enc(`4 0 obj\n<< /Length ${contentBuf.length} >>\nstream\n`));
    push(contentBuf);
    push(enc(`\nendstream\nendobj\n`));
    obj(5, enc("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
    obj(6, enc("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"));
    if (sigJpeg) {
      xref[7] = offset;
      push(enc(`7 0 obj\n<< /Type /XObject /Subtype /Image /Width ${opts.sigW || 500} /Height ${opts.sigH || 160} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${sigJpeg.length} >>\nstream\n`));
      push(sigJpeg);
      push(enc(`\nendstream\nendobj\n`));
    }
    const xrefStart = offset;
    const count = sigJpeg ? 8 : 7;
    let xr = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let i = 1; i < count; i++) xr += String(xref[i] || 0).padStart(10, "0") + " 00000 n \n";
    push(enc(xr));
    push(enc(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`));
    return Buffer.concat(chunks);
  }

  // Decode a data URL / base64 signature into a JPEG Buffer, or null.
  function decodeSignature(sig) {
    if (!sig) return null;
    let b64 = String(sig);
    const comma = b64.indexOf(",");
    if (b64.startsWith("data:") && comma >= 0) b64 = b64.slice(comma + 1);
    try {
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 100) return null;
      return buf;
    } catch (e) { return null; }
  }

  // Generate + store the signed acknowledgment PDF; returns the stored filename.
  async function generateAndStorePdf(emp, flag) {
    const sigJpeg = decodeSignature(flag.signature);
    const pdf = buildAckPdf({
      title: "Attendance Acknowledgment",
      paragraphs: acknowledgmentText(emp, flag),
      sigJpeg,
      sigW: flag.sig_w || 500,
      sigH: flag.sig_h || 160,
      typedName: flag.typed_name || "",
      signedDate: flag.signed_date || nowISO(),
      generatedDate: nowISO(),
    });
    const stored = `ack_${flag.id}_${crypto.randomBytes(6).toString("hex")}.pdf`;
    fs.writeFileSync(path.join(ATT_DIR, stored), pdf);
    return stored;
  }

  // ----------------------------------------------------------------- signing
  // Shared: apply a signature to a flag (from either in-app or the token page),
  // generate the PDF, mark acknowledged, log activity.
  async function applySignature(flag, emp, body) {
    const signedDate = nowISO();
    const withSig = {
      ...flag,
      signature: body.signature || null,
      typed_name: (body.typed_name || "").trim(),
      signed_date: signedDate,
      sig_w: Number(body.sig_w) || 500,
      sig_h: Number(body.sig_h) || 160,
    };
    let stored = null;
    try { stored = await generateAndStorePdf(emp, withSig); }
    catch (e) { console.error("attendance PDF generation failed:", e.message); }
    await dbRun(
      "UPDATE hr_attendance_flags SET acknowledged = TRUE, signature = ?, typed_name = ?, signed_date = ?, pdf_stored = ? WHERE id = ?",
      [withSig.signature, withSig.typed_name, signedDate, stored, flag.id]
    );
    await logEmpActivity(flag.employee_id, `Signed attendance acknowledgment (${flag.reason || "flag"}, incident ${flag.incident_date || "n/a"}).`);
    return stored;
  }


  // ==================== ONE-TIME IMPORT OF THE ATTENDANCE LOG ====================
  // The practice tracked attendance in a Google Sheet ("Attendance Log - RBTs")
  // before this module existed. The CRM is the system of record now, so the
  // history has to come across rather than everyone restarting at zero points --
  // a rolling 90-day total that begins today would hand out bonuses nobody has
  // earned and erase warnings people are already on.
  //
  // Deliberately an import-with-preview rather than a hard-coded backfill:
  //   * the sheet's own lookup formula keys on the typed staff name, so it has
  //     real drift in it (Nicolas Lineras/Linares, Katelyn/Kate Brunner). Those
  //     rows are silently worth 0 points in the sheet. Here they surface as a
  //     row that needs a person chosen, and once chosen they are keyed to an
  //     employee_id and cannot drift again.
  //   * staff health notes stay out of the codebase and out of git.

  // Every wording the sheet has used for an occurrence, old and new, mapped to
  // the matrix key. Compared after normalizeLabel(), so punctuation, casing,
  // en-dashes and doubled spaces do not matter.
  const IMPORT_TYPE_ALIASES = {
    "late": "late",
    "late any amount of time": "late",
    "call off <4 hours notice non emergency": "calloff_lt4_nonemergency",
    "call off with less than 4 hours notice non emergency no documentation": "calloff_lt4_nonemergency",
    "call off <4 hours notice emergency w documentation": "calloff_lt4_emergency",
    "call off with less than 4 hours notice emergency": "calloff_lt4_emergency",
    "call off >=4 hours notice": "calloff_gt4",
    "call off with more than 4 hours notice": "calloff_gt4",
    "time off request post monthly schedule finalization": "timeoff_post_finalization",
    "missed clock in out": "missed_clock",
    "leaving early abandoning shift": "left_early",
    "leaving early or abandoning shift": "left_early",
    "no call no show 1st": "ncns",
    "no call no show": "ncns",
    "no call no show prior to shift starting": "ncns",
    "unscheduled absences during probation period": "probation_absence",
    "unscheduled absence during probation period": "probation_absence",
    "perfect attendance 30 days": "perfect_30",
    "perfect attendance 60 days": "perfect_60",
    "picked up last minute shift": "picked_up_shift",
    "picking up a last minute shift within 4 hours": "picked_up_shift",
    "completion of attendance improvement plan": "completed_aip",
  };

  // Strip everything that varies between typings of the same label: dash forms,
  // slashes, punctuation, case, repeated whitespace. "≥" becomes ">=" first so
  // "Call-off  (≥4 hours notice)" and "Call-off (>=4 hours notice)" collapse
  // to the same string.
  function normalizeLabel(s) {
    return String(s || "")
      .replace(/[≥]/g, ">=").replace(/[≤]/g, "<=")
      .replace(/[–—]/g, " ")
      .toLowerCase()
      .replace(/[^a-z0-9<>=]+/g, " ")
      .trim();
  }

  function normalizeName(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // M/D/YYYY (the sheet) or YYYY-MM-DD (already normalised) -> YYYY-MM-DD.
  function importDate(v) {
    const s = String(v || "").trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (!m) return null;
    let [, mo, d, y] = m;
    if (y.length === 2) y = "20" + y;
    const mm = Number(mo), dd = Number(d);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  // "4:30 PM" / "16:30" -> "16:30".
  function importTime(v) {
    const s = String(v || "").trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i);
    if (m) {
      let h = Number(m[1]) % 12;
      if (m[3].toLowerCase() === "p") h += 12;
      return `${String(h).padStart(2, "0")}:${m[2]}`;
    }
    m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    if (h > 23 || Number(m[2]) > 59) return null;
    return `${String(h).padStart(2, "0")}:${m[2]}`;
  }

  function importBool(v) {
    const s = String(v || "").trim().toLowerCase();
    if (["y", "yes", "true", "1"].includes(s)) return true;
    if (["n", "no", "false", "0"].includes(s)) return false;
    return null; // blank, or the occurrence type pasted into the wrong column
  }

  // One line of delimiter-separated values, honouring quotes. Works for the CSV
  // download and for the tab-separated text you get pasting out of the sheet.
  function splitRow(line, delim) {
    const out = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  }

  // Column headers we understand, by what the sheet calls them.
  const IMPORT_COLUMNS = [
    ["date", /^date$/],
    ["name", /staff\s*name|employee|^name$/],
    ["shift_start", /shift\s*start/],
    ["type", /occurrence\s*type|^occurrence$|^type$/],
    ["emergency", /emergency/],
    ["documentation", /documentation/],
    ["time_notified", /time\s*notified/],
    ["notice_hours", /notice\s*hours/],
    ["notes", /^notes?$|comment/],
    ["points", /^points?$/],
  ];

  // Reads the pasted log into rows. Finds its own header line, so leading title
  // and blank rows from the sheet are ignored, and maps by header name so the
  // columns can be reordered without breaking the import.
  function parseAttendanceLog(text) {
    const lines = String(text || "").split(/\r?\n/);
    const delim = (lines.find((l) => l.includes("\t")) ? "\t" : ",");
    let map = null;
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const cells = splitRow(line, delim);
      if (!map) {
        const lower = cells.map((c) => c.toLowerCase().trim());
        // A header line is one that names both who and what.
        const hasName = lower.some((c) => /staff\s*name|employee/.test(c));
        const hasType = lower.some((c) => /occurrence|^type$/.test(c));
        if (!hasName || !hasType) continue;
        map = {};
        lower.forEach((c, i) => {
          for (const [key, re] of IMPORT_COLUMNS) {
            if (map[key] === undefined && re.test(c)) { map[key] = i; break; }
          }
        });
        continue;
      }
      const at = (k) => (map[k] === undefined ? "" : (cells[map[k]] || ""));
      const name = at("name").trim();
      const type = at("type").trim();
      if (!name && !type) continue;               // the sheet's trailing blank rows
      rows.push({
        raw_date: at("date"), raw_name: name, raw_type: type,
        raw_shift_start: at("shift_start"), raw_time_notified: at("time_notified"),
        raw_emergency: at("emergency"), raw_documentation: at("documentation"),
        raw_notice_hours: at("notice_hours"), notes: at("notes"), raw_points: at("points"),
      });
    }
    if (!map) return { error: "No header row found. The log needs a row naming its columns — at least \"Staff Name\" and \"Occurrence Type\"." };
    return { rows };
  }

  // How close two names are, 0..1, on whole name parts. Deliberately not a
  // character-distance score: "Kate"/"Katelyn" and "Linares"/"Lineras" are the
  // real drift in this sheet, and both share a surname exactly.
  function nameScore(a, b) {
    const A = normalizeName(a).split(" ").filter(Boolean);
    const B = normalizeName(b).split(" ").filter(Boolean);
    if (!A.length || !B.length) return 0;
    if (A.join(" ") === B.join(" ")) return 1;
    let hits = 0;
    const reasons = [];
    for (const x of A) {
      for (const y of B) {
        if (x === y) { hits += 1; reasons.push(x); break; }
        if (x.length > 2 && y.length > 2 && (x.startsWith(y) || y.startsWith(x))) { hits += 0.9; reasons.push(x); break; }
        if (editDistance(x, y) === 1 && x.length > 3) { hits += 0.8; reasons.push(x); break; }
        // transposition, e.g. Linares/Lineras
        if (x.length === y.length && x.split("").sort().join("") === y.split("").sort().join("")) { hits += 0.8; reasons.push(x); break; }
      }
    }
    return hits / Math.max(A.length, B.length);
  }

  function editDistance(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  }

  // A stable identity for a log line, so importing the same sheet twice does
  // not double anyone's points. Not the notes -- those get edited in the sheet.
  function importFingerprint(r) {
    const basis = [normalizeName(r.raw_name), importDate(r.raw_date) || r.raw_date,
                   normalizeLabel(r.raw_type), importTime(r.raw_shift_start) || ""].join("|");
    return "sheet:" + crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
  }

  async function previewAttendanceImport(text) {
    const parsed = parseAttendanceLog(text);
    if (parsed.error) return { error: parsed.error };
    const types = await matrixTypes();
    const byKey = {};
    types.forEach((t) => { byKey[t.key] = t; });
    const emps = await dbAll(
      "SELECT id, name, role_title, " + HIRE_DATE_SQL + ", status FROM hr_employees ORDER BY name"
    ).catch(() => []);
    const already = await dbAll(
      "SELECT imported_from FROM hr_attendance_flags WHERE imported_from IS NOT NULL"
    ).catch(() => []);
    const seen = new Set(already.map((r) => r.imported_from));

    const items = parsed.rows.map((r) => {
      const warnings = [];
      const fingerprint = importFingerprint(r);
      const date = importDate(r.raw_date);
      if (!date) warnings.push(`Could not read the date "${r.raw_date}" — this row cannot be imported.`);

      const typeKey = IMPORT_TYPE_ALIASES[normalizeLabel(r.raw_type)] || null;
      const type = typeKey ? byKey[typeKey] : null;
      if (!type) warnings.push(`"${r.raw_type}" is not an occurrence in the matrix — this row cannot be imported.`);

      // The sheet's own Points column is the historical record and wins. The
      // matrix is only the fallback, and a disagreement is worth saying out
      // loud rather than quietly restating what somebody was told at the time.
      const sheetPoints = r.raw_points !== "" && isFinite(parseFloat(r.raw_points)) ? parseFloat(r.raw_points) : null;
      const points = sheetPoints != null ? sheetPoints : (type ? num(type.points) : null);
      if (sheetPoints != null && type && Math.abs(sheetPoints - num(type.points)) > 0.001)
        warnings.push(`The log says ${sheetPoints} points, the matrix says ${num(type.points)}. Importing the ${sheetPoints} the staff member was given at the time.`);

      const emergency = importBool(r.raw_emergency);
      const documentation = importBool(r.raw_documentation);
      if (emergency === null && r.raw_emergency.trim())
        warnings.push(`"${r.raw_emergency}" is in the Emergency column instead of Y/N — importing it as unanswered.`);

      const shiftStart = importTime(r.raw_shift_start);
      const timeNotified = importTime(r.raw_time_notified);
      const sheetNotice = r.raw_notice_hours !== "" && isFinite(parseFloat(r.raw_notice_hours)) ? parseFloat(r.raw_notice_hours) : null;
      const computed = noticeHours(shiftStart, timeNotified);
      const notice = sheetNotice != null ? sheetNotice : computed;

      // Match the typed name to a real employee.
      const scored = emps
        .map((e) => ({ e, s: nameScore(r.raw_name, e.name) }))
        .filter((x) => x.s >= 0.5)
        .sort((a, b) => b.s - a.s);
      const best = scored[0] || null;
      const exact = best && normalizeName(best.e.name) === normalizeName(r.raw_name);
      // Two staff records that read the same are exactly the ambiguity the
      // sheet could not see. Never pick one of them silently.
      const tied = best ? scored.filter((x) => Math.abs(x.s - best.s) < 0.001).length > 1 : false;
      let match = null, confidence = null;
      if (best) {
        match = best.e.id;
        confidence = exact && !tied ? "confident" : "check";
        if (tied) warnings.push(`More than one staff record matches "${r.raw_name}" equally well. Choose the right person.`);
        else if (!exact) warnings.push(`The log says "${r.raw_name}"; the closest staff record is "${best.e.name}". Confirm before importing.`);
      } else if (r.raw_name) {
        warnings.push(`No staff record resembles "${r.raw_name}". Choose the right person, or leave it out.`);
      }

      return {
        fingerprint,
        already_imported: seen.has(fingerprint),
        source_name: r.raw_name,
        source_type: r.raw_type,
        incident_date: date,
        type_key: typeKey,
        type_label: type ? type.label : null,
        points,
        shift_start: shiftStart,
        time_notified: timeNotified,
        notice_hours: notice,
        emergency: emergency === true,
        documentation: documentation === true,
        notes: r.notes || null,
        match,
        confidence,
        alternatives: scored.slice(0, 6).map((x) => ({ id: x.e.id, name: x.e.name, score: Math.round(x.s * 100) })),
        importable: !!(date && type),
        warnings,
      };
    });

    return {
      items,
      summary: {
        total: items.length,
        ready: items.filter((i) => i.importable && i.confidence === "confident" && !i.already_imported).length,
        needs_confirmation: items.filter((i) => i.importable && i.confidence !== "confident" && !i.already_imported).length,
        already_imported: items.filter((i) => i.already_imported).length,
        unreadable: items.filter((i) => !i.importable).length,
      },
    };
  }

  // Writes the confirmed rows. Never emails anybody: these already happened and
  // the staff member was told at the time. Re-importing the same sheet is a
  // no-op because of the fingerprint.
  async function commitAttendanceImport(items, actor) {
    const created = [], skipped = [];
    for (const it of items) {
      const empId = Number(it.employee_id);
      if (!empId || !it.incident_date || !it.type_key) { skipped.push({ name: it.source_name, reason: "Incomplete row" }); continue; }
      const dupe = await dbGet("SELECT id FROM hr_attendance_flags WHERE imported_from = ?", [it.fingerprint]).catch(() => null);
      if (dupe) { skipped.push({ name: it.source_name, reason: "Already imported" }); continue; }
      const type = await typeByKey(it.type_key);
      if (!type) { skipped.push({ name: it.source_name, reason: "Occurrence type is no longer in the matrix" }); continue; }
      const points = isFinite(parseFloat(it.points)) ? parseFloat(it.points) : num(type.points);
      await dbRun(
        `INSERT INTO hr_attendance_flags
           (employee_id, incident_date, reason, type_key, points, shift_start, time_notified,
            notice_hours, emergency, documentation, notes, acknowledged, created_by, created_at, imported_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?, ?)`,
        [empId, it.incident_date, type.label, type.key, points,
         it.shift_start || null, it.time_notified || null,
         it.notice_hours == null || it.notice_hours === "" ? null : num(it.notice_hours),
         it.emergency === true, it.documentation === true, it.notes || null,
         `${actor} (imported)`, nowISO(), it.fingerprint]
      );
      created.push({ employee_id: empId, name: it.source_name, date: it.incident_date, label: type.label, points });
    }
    // One activity line per person, not one per row -- the employee record
    // should say the history came across, not replay two years of it.
    const byEmp = {};
    created.forEach((c) => { byEmp[c.employee_id] = (byEmp[c.employee_id] || 0) + 1; });
    for (const [empId, n] of Object.entries(byEmp)) {
      await logEmpActivity(Number(empId), `Attendance history imported from the attendance log by ${actor}: ${n} occurrence(s).`);
    }
    return { created, skipped };
  }

  // ------------------------------------------------------------------ router
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/attendance/")) return false;
    try {
      // -------- PUBLIC: token-based remote signing --------
      if (pathname === "/api/attendance/public/flag" && method === "GET") {
        const flag = await dbGet("SELECT * FROM hr_attendance_flags WHERE ack_token = ?", [query.token || ""]);
        if (!flag) return json(res, 404, { error: "This link is invalid or has expired." });
        const emp = await dbGet("SELECT id, name FROM hr_employees WHERE id = ?", [flag.employee_id]);
        return json(res, 200, {
          employee_name: emp ? emp.name : "",
          incident_date: flag.incident_date,
          reason: flag.reason,
          notes: flag.notes,
          acknowledged: !!flag.acknowledged,
          paragraphs: acknowledgmentText(emp || { name: "" }, flag),
        });
      }
      if (pathname === "/api/attendance/public/sign" && method === "POST") {
        const b = await readBody(req);
        const flag = await dbGet("SELECT * FROM hr_attendance_flags WHERE ack_token = ?", [b.token || ""]);
        if (!flag) return json(res, 404, { error: "This link is invalid or has expired." });
        if (flag.acknowledged) return json(res, 200, { ok: true, already: true });
        if (!(b.typed_name || "").trim()) return json(res, 400, { error: "Please type your name to sign." });
        const emp = await dbGet("SELECT * FROM hr_employees WHERE id = ?", [flag.employee_id]);
        await applySignature(flag, emp || { name: "", id: flag.employee_id }, b);
        return json(res, 200, { ok: true });
      }

      // -------- AUTHENTICATED (manage) --------
      if (!user) return json(res, 401, { error: "Not authenticated" });
      if (!canManage(user)) return json(res, 403, { error: "Not permitted" });
      const actor = user.email || user.name || "user";

      // List flags for an employee (+ 90-day count).
      const listMatch = pathname.match(/^\/api\/attendance\/employee\/(\d+)$/);
      if (listMatch && method === "GET") {
        const empId = Number(listMatch[1]);
        const emp = await dbGet("SELECT id, name, role_title, " + HIRE_DATE_SQL + ", email FROM hr_employees WHERE id = ?", [empId]);
        const rows = await dbAll("SELECT * FROM hr_attendance_flags WHERE employee_id = ? ORDER BY COALESCE(incident_date, created_at) DESC, id DESC", [empId]);
        rows.forEach((r) => { r.has_pdf = !!r.pdf_stored; r.points = r.points == null ? null : num(r.points); delete r.signature; });
        return json(res, 200, {
          flags: rows,
          count_90d: flagsInLast90(rows),
          score: emp ? scoreEmployee(emp, rows) : null,
          types: await matrixTypes(),
        });
      }

      // Log an occurrence. The point value comes from the matrix, not the
      // caller -- a client that could post its own points would be a way to
      // hand out or withhold a $50 bonus by editing a request.
      if (listMatch && method === "POST") {
        const empId = Number(listMatch[1]);
        const emp = await dbGet("SELECT id, name, email, " + HIRE_DATE_SQL + " FROM hr_employees WHERE id = ?", [empId]);
        if (!emp) return json(res, 404, { error: "Employee not found" });
        const b = await readBody(req);

        const type = await typeByKey(b.type_key);
        if (b.type_key && !type) return json(res, 400, { error: "That occurrence type is not in the attendance matrix." });
        if (!type && !b.reason) return json(res, 400, { error: "Choose an occurrence type." });

        const incidentDate = String(b.incident_date || today()).slice(0, 10);
        const label = type ? type.label : (REASONS.includes(b.reason) ? b.reason : (b.reason || "Other"));
        const points = type ? num(type.points) : null;
        const nh = b.notice_hours != null && b.notice_hours !== ""
          ? num(b.notice_hours)
          : noticeHours(b.shift_start, b.time_notified);

        const row = await dbRun(
          `INSERT INTO hr_attendance_flags
             (employee_id, incident_date, reason, type_key, points, shift_start, time_notified,
              notice_hours, emergency, documentation, notes, acknowledged, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?) RETURNING id`,
          [empId, incidentDate, label, type ? type.key : null, points,
           b.shift_start || null, b.time_notified || null, nh,
           b.emergency === true, b.documentation === true,
           b.notes || null, actor, nowISO()]
        );
        const id = row && row.rows && row.rows[0] ? row.rows[0].id : null;
        await logEmpActivity(empId, `Attendance: ${label}${points != null ? ` (${points > 0 ? "+" : ""}${points} pts)` : ""} on ${incidentDate}.`);

        // Tell the staff member, with their running total, so the first they
        // hear of a point is not their monthly review.
        let notified = false;
        if (b.notify !== false && emp.email) {
          const rows = await dbAll("SELECT * FROM hr_attendance_flags WHERE employee_id = ?", [empId]).catch(() => []);
          const score = scoreEmployee(emp, rows);
          notified = await emailOccurrence(emp, { label, points, incident_date: incidentDate, notes: b.notes }, score);
          if (notified) await dbRun("UPDATE hr_attendance_flags SET notified_at = ? WHERE id = ?", [nowISO(), id]).catch(() => {});
        }
        return json(res, 201, { ok: true, id, points, notified });
      }

      // The matrix, and editing it. Point values are policy, and the policy is
      // dated -- it has already been revised once.
      if (pathname === "/api/attendance/types" && method === "GET") {
        return json(res, 200, { types: await matrixTypes(), effective: MATRIX_EFFECTIVE });
      }
      if (pathname === "/api/attendance/types" && method === "PUT") {
        if (!canEditMatrix(user)) return json(res, 403, { error: "Only an owner or administrator can change the attendance matrix." });
        const b = await readBody(req);
        const list = Array.isArray(b.types) ? b.types : [];
        if (!list.length) return json(res, 400, { error: "Nothing to save." });
        let saved = 0;
        for (const t of list) {
          if (!t || !t.key) continue;
          const pts = Number(t.points);
          if (!isFinite(pts)) return json(res, 400, { error: `"${t.label || t.key}" needs a number of points.` });
          await dbRun(
            `UPDATE hr_attendance_types
                SET label = COALESCE(?, label), description = COALESCE(?, description),
                    points = ?, active = ?, updated_by = ?, updated_at = ?
              WHERE key = ?`,
            [t.label || null, t.description || null, pts, t.active !== false, actor, nowISO(), t.key]
          );
          saved++;
        }
        return json(res, 200, { ok: true, saved, types: await matrixTypes() });
      }

      // The whole roster at a glance -- the sheet's summary tab.
      if (pathname === "/api/attendance/roster" && method === "GET") {
        const asOf = /^\d{4}-\d{2}-\d{2}$/.test(query.as_of || "") ? query.as_of : today();
        const emps = await dbAll(
          `SELECT id, name, role_title, ${HIRE_DATE_SQL}, email, status FROM hr_employees
            WHERE COALESCE(status,'active') <> 'terminated' ORDER BY name`
        ).catch(() => []);
        const all = await dbAll("SELECT * FROM hr_attendance_flags").catch(() => []);
        const byEmp = {};
        all.forEach((f) => { (byEmp[f.employee_id] = byEmp[f.employee_id] || []).push(f); });
        const staff = emps.map((e) => scoreEmployee(e, byEmp[e.id] || [], asOf));
        return json(res, 200, {
          as_of: asOf,
          staff,
          totals: {
            people: staff.length,
            with_points_90: staff.filter((s) => s.points_90 > 0).length,
            bonus_eligible: staff.filter((s) => s.bonus_eligible).length,
            needing_action: staff.filter((s) => s.points_30 >= 1.5).length,
            unsigned: staff.reduce((n, s) => n + s.unsigned_acknowledgments, 0),
          },
          bonus_amount: BONUS_AMOUNT,
        });
      }

      // Void an occurrence logged in error. Never a hard delete: this is a
      // disciplinary record, and a row that vanishes takes the reason with it.
      const voidMatch = pathname.match(/^\/api\/attendance\/flag\/(\d+)\/void$/);
      if (voidMatch && method === "POST") {
        const flag = await dbGet("SELECT * FROM hr_attendance_flags WHERE id = ?", [Number(voidMatch[1])]);
        if (!flag) return json(res, 404, { error: "Occurrence not found" });
        const b = await readBody(req);
        const reason = String(b.reason || "").trim();
        if (!reason) return json(res, 400, { error: "Say why this occurrence is being voided — it stays on the record." });
        await dbRun(
          "UPDATE hr_attendance_flags SET voided = TRUE, voided_reason = ?, voided_by = ?, voided_at = ? WHERE id = ?",
          [reason, actor, nowISO(), flag.id]
        );
        await logEmpActivity(flag.employee_id, `Attendance occurrence voided by ${actor}: ${reason}`);
        return json(res, 200, { ok: true });
      }

      // One-time import of the historical attendance log. Preview first --
      // nothing is written until the names have been confirmed against real
      // staff records.
      if (pathname === "/api/attendance/import/preview" && method === "POST") {
        if (!canEditMatrix(user)) return json(res, 403, { error: "Only an owner or administrator can import the attendance log." });
        const b = await readBody(req);
        const result = await previewAttendanceImport(b.text || "");
        if (result.error) return json(res, 400, { error: result.error });
        return json(res, 200, result);
      }
      if (pathname === "/api/attendance/import/commit" && method === "POST") {
        if (!canEditMatrix(user)) return json(res, 403, { error: "Only an owner or administrator can import the attendance log." });
        const b = await readBody(req);
        const list = Array.isArray(b.items) ? b.items : [];
        if (!list.length) return json(res, 400, { error: "Nothing to import." });
        return json(res, 200, await commitAttendanceImport(list, actor));
      }

      // Run the monthly review now rather than waiting for the sweep.
      if (pathname === "/api/attendance/monthly-review" && method === "POST") {
        if (!canEditMatrix(user)) return json(res, 403, { error: "Only an owner or administrator can send the monthly review." });
        const b = await readBody(req).catch(() => ({}));
        const period = /^\d{4}-\d{2}$/.test(b.period || "") ? b.period : today().slice(0, 7);
        const result = await runMonthlyReview({ period, force: b.force === true, actor });
        return json(res, 200, result);
      }

      // In-app signing of a specific flag.
      const signMatch = pathname.match(/^\/api\/attendance\/flag\/(\d+)\/sign$/);
      if (signMatch && method === "POST") {
        const flag = await dbGet("SELECT * FROM hr_attendance_flags WHERE id = ?", [Number(signMatch[1])]);
        if (!flag) return json(res, 404, { error: "Flag not found" });
        const b = await readBody(req);
        if (!(b.typed_name || "").trim()) return json(res, 400, { error: "A typed name is required to sign." });
        const emp = await dbGet("SELECT * FROM hr_employees WHERE id = ?", [flag.employee_id]);
        const stored = await applySignature(flag, emp || { name: "", id: flag.employee_id }, b);
        return json(res, 200, { ok: true, has_pdf: !!stored });
      }

      // Email the employee a remote signing link.
      const sendMatch = pathname.match(/^\/api\/attendance\/flag\/(\d+)\/send-ack$/);
      if (sendMatch && method === "POST") {
        const flag = await dbGet("SELECT * FROM hr_attendance_flags WHERE id = ?", [Number(sendMatch[1])]);
        if (!flag) return json(res, 404, { error: "Flag not found" });
        const emp = await dbGet("SELECT * FROM hr_employees WHERE id = ?", [flag.employee_id]);
        if (!emp || !emp.email) return json(res, 400, { error: "This employee has no email on file." });
        let token = flag.ack_token;
        if (!token) {
          token = crypto.randomBytes(20).toString("hex");
          await dbRun("UPDATE hr_attendance_flags SET ack_token = ? WHERE id = ?", [token, flag.id]);
        }
        const link = `${APP_BASE_URL}/attendance-sign/?token=${token}`;
        const first = (emp.name || "there").split(/\s+/)[0];
        await sendEmail({
          to: emp.email,
          subject: "Please review and sign: attendance acknowledgment",
          html: `<p>Hi ${escapeHtmlLite(first)},</p>
                 <p>Please take a moment to review and sign an attendance acknowledgment regarding ${escapeHtmlLite(flag.incident_date || "a recent date")}.</p>
                 <p><a href="${link}">Review &amp; sign the acknowledgment</a></p>
                 <p>Thank you,<br/>Spectrum Squad</p>`,
          type: "attendance_ack",
        }).catch((e) => console.error("attendance ack email:", e.message));
        await logEmpActivity(flag.employee_id, "Attendance acknowledgment link emailed for signature.");
        return json(res, 200, { ok: true, link });
      }

      // Download the stored signed PDF.
      const pdfMatch = pathname.match(/^\/api\/attendance\/flag\/(\d+)\/pdf$/);
      if (pdfMatch && method === "GET") {
        const flag = await dbGet("SELECT * FROM hr_attendance_flags WHERE id = ?", [Number(pdfMatch[1])]);
        if (!flag || !flag.pdf_stored) return json(res, 404, { error: "No signed PDF for this flag yet." });
        const full = path.join(ATT_DIR, flag.pdf_stored);
        if (!fs.existsSync(full)) return json(res, 404, { error: "PDF file missing" });
        const data = fs.readFileSync(full);
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="attendance-acknowledgment-${flag.id}.pdf"`,
          "Content-Length": data.length,
        });
        res.end(data);
        return true;
      }

      // Legacy delete. Now that attendance drives discipline levels and a $50
      // bonus, an occurrence that disappears without trace is a hole: it is
      // voided instead, which stops it counting but keeps the row and the
      // reason. Kept on DELETE so anything still calling it behaves safely.
      const delMatch = pathname.match(/^\/api\/attendance\/flag\/(\d+)$/);
      if (delMatch && method === "DELETE") {
        const flag = await dbGet("SELECT * FROM hr_attendance_flags WHERE id = ?", [Number(delMatch[1])]);
        if (flag) {
          const b = await readBody(req).catch(() => ({}));
          await dbRun(
            "UPDATE hr_attendance_flags SET voided = TRUE, voided_reason = ?, voided_by = ?, voided_at = ? WHERE id = ?",
            [(b && b.reason) || "Removed", actor, nowISO(), flag.id]
          );
          await logEmpActivity(flag.employee_id, `Attendance occurrence voided by ${actor}.`);
        }
        return json(res, 200, { ok: true, voided: true });
      }

      return false;
    } catch (e) {
      console.error("attendance handleApi error:", e);
      return json(res, 500, { error: "Attendance error: " + e.message });
    }
  }

  function escapeHtmlLite(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ===================== EMAILS =====================
  const esc = escapeHtmlLite;
  function pts(n) { return (n > 0 ? "+" : "") + round2(num(n)); }

  function standingBlock(score) {
    return `<table style="border-collapse:collapse;font-size:14px;margin:14px 0;">
      <tr><td style="padding:5px 14px 5px 0;color:#555;">Points, last 30 days</td><td style="padding:5px 0;font-weight:700;">${round2(score.points_30)}</td></tr>
      <tr><td style="padding:5px 14px 5px 0;color:#555;">Points, rolling 90 days</td><td style="padding:5px 0;font-weight:700;">${round2(score.points_90)}</td></tr>
      <tr><td style="padding:5px 14px 5px 0;color:#555;">Standing</td><td style="padding:5px 0;font-weight:700;">${esc(score.discipline_level)}</td></tr>
      <tr><td style="padding:5px 14px 5px 0;color:#555;">Attendance bonus</td><td style="padding:5px 0;font-weight:700;">${esc(score.bonus_status)}</td></tr>
    </table>`;
  }

  // Sent when an occurrence is logged, so the first a staff member hears of a
  // point is not their monthly review.
  async function emailOccurrence(emp, occ, score) {
    if (!emp || !emp.email) return false;
    const first = (emp.name || "there").split(/\s+/)[0];
    const isCredit = occ.points != null && occ.points < 0;
    const html = `
      <p>Hi ${esc(first)},</p>
      <p>${isCredit
        ? "A credit has been added to your attendance record — thank you."
        : "An attendance occurrence has been recorded on your file."}</p>
      <table style="border-collapse:collapse;font-size:14px;margin:14px 0;">
        <tr><td style="padding:5px 14px 5px 0;color:#555;">Date</td><td style="padding:5px 0;font-weight:700;">${esc(occ.incident_date)}</td></tr>
        <tr><td style="padding:5px 14px 5px 0;color:#555;">Type</td><td style="padding:5px 0;font-weight:700;">${esc(occ.label)}</td></tr>
        ${occ.points != null ? `<tr><td style="padding:5px 14px 5px 0;color:#555;">Points</td><td style="padding:5px 0;font-weight:700;">${pts(occ.points)}</td></tr>` : ""}
        ${occ.notes ? `<tr><td style="padding:5px 14px 5px 0;color:#555;">Notes</td><td style="padding:5px 0;">${esc(occ.notes)}</td></tr>` : ""}
      </table>
      <p style="margin:18px 0 6px;font-weight:700;">Where this leaves you</p>
      ${standingBlock(score)}
      <p style="font-size:13px;color:#666;">Attendance points are tracked on a rolling 90-day basis under the Spectrum Squad Attendance &amp; Punctuality Policy. If you believe this was recorded in error, reply to this email and we will look at it.</p>
      <p>Thank you,<br/>Spectrum Squad</p>`;
    const r = await sendEmail({
      to: emp.email,
      subject: isCredit ? "Attendance credit recorded" : `Attendance occurrence recorded — ${occ.incident_date}`,
      html,
      type: "attendance_occurrence",
    }).catch((e) => { console.error("attendance occurrence email:", e.message); return null; });
    return !!(r && r.delivered !== "failed");
  }

  // ===================== MONTHLY REVIEW =====================
  // The 30-Day Monthly Attendance Review Matrix, run once a month. Idempotent
  // on (employee, period) via hr_attendance_reviews, so a re-run cannot email
  // anybody twice -- and the row it writes is the review history.
  async function runMonthlyReview(opts) {
    const period = (opts && opts.period) || today().slice(0, 7);
    const force = !!(opts && opts.force);
    const asOf = period === today().slice(0, 7) ? today() : lastDayOf(period);

    const emps = await dbAll(
      `SELECT id, name, email, role_title, ${HIRE_DATE_SQL} FROM hr_employees
        WHERE COALESCE(status,'active') <> 'terminated' ORDER BY name`
    ).catch(() => []);
    const all = await dbAll("SELECT * FROM hr_attendance_flags").catch(() => []);
    const byEmp = {};
    all.forEach((f) => { (byEmp[f.employee_id] = byEmp[f.employee_id] || []).push(f); });

    const scored = emps.map((e) => ({ emp: e, score: scoreEmployee(e, byEmp[e.id] || [], asOf) }));
    let emailedStaff = 0, skipped = 0;

    for (const { emp, score } of scored) {
      const already = await dbGet(
        "SELECT id FROM hr_attendance_reviews WHERE employee_id = ? AND period = ?", [emp.id, period]
      ).catch(() => null);
      if (already && !force) { skipped++; continue; }

      // Only a month that actually had activity reaches the staff member. A
      // clean month is reported to management on the roster summary instead of
      // as a "nothing happened" email to everyone.
      const hasActivity = score.points_30 !== 0 || score.occurrences_90 > 0;
      let sentTo = null;
      if (emp.email && score.points_30 !== 0) {
        const first = (emp.name || "there").split(/\s+/)[0];
        const html = `
          <p>Hi ${esc(first)},</p>
          <p>This is your monthly attendance review for <strong>${esc(monthLabel(period))}</strong>.</p>
          <table style="border-collapse:collapse;font-size:14px;margin:14px 0;">
            <tr><td style="padding:5px 14px 5px 0;color:#555;">Points this period</td><td style="padding:5px 0;font-weight:700;">${round2(score.points_30)}</td></tr>
            <tr><td style="padding:5px 14px 5px 0;color:#555;">Review level</td><td style="padding:5px 0;font-weight:700;">${esc(score.review_level)}</td></tr>
            <tr><td style="padding:5px 14px 5px 0;color:#555;">Next step</td><td style="padding:5px 0;">${esc(score.review_action)}</td></tr>
            <tr><td style="padding:5px 14px 5px 0;color:#555;">Rolling 90-day points</td><td style="padding:5px 0;font-weight:700;">${round2(score.points_90)}</td></tr>
            <tr><td style="padding:5px 14px 5px 0;color:#555;">Standing</td><td style="padding:5px 0;font-weight:700;">${esc(score.discipline_level)}</td></tr>
            <tr><td style="padding:5px 14px 5px 0;color:#555;">Attendance bonus</td><td style="padding:5px 0;font-weight:700;">${esc(score.bonus_status)}</td></tr>
            ${score.next_bonus_date ? `<tr><td style="padding:5px 14px 5px 0;color:#555;">Next bonus date</td><td style="padding:5px 0;">${esc(score.next_bonus_date)}</td></tr>` : ""}
          </table>
          <p style="font-size:13px;color:#666;">Points can be earned back: perfect attendance for 30 days, perfect attendance for 60 days, picking up a last-minute shift, or completing an attendance improvement plan. Every 90 days with zero points earns the $${BONUS_AMOUNT} attendance bonus.</p>
          <p>Thank you for everything you do for our families,<br/>Spectrum Squad</p>`;
        const r = await sendEmail({
          to: emp.email,
          subject: `Your attendance review — ${monthLabel(period)}`,
          html,
          type: "attendance_monthly_review",
        }).catch((e) => { console.error("attendance monthly email:", e.message); return null; });
        if (r && r.delivered !== "failed") { emailedStaff++; sentTo = emp.email; }
      }

      await dbRun(
        `INSERT INTO hr_attendance_reviews
           (employee_id, period, points_30, review_level, review_action, points_90,
            discipline_level, bonus_eligible, next_bonus_date, emailed_to, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (employee_id, period) DO UPDATE SET
           points_30 = EXCLUDED.points_30, review_level = EXCLUDED.review_level,
           review_action = EXCLUDED.review_action, points_90 = EXCLUDED.points_90,
           discipline_level = EXCLUDED.discipline_level, bonus_eligible = EXCLUDED.bonus_eligible,
           next_bonus_date = EXCLUDED.next_bonus_date,
           emailed_to = COALESCE(EXCLUDED.emailed_to, hr_attendance_reviews.emailed_to)`,
        [emp.id, period, score.points_30, score.review_level, score.review_action, score.points_90,
         score.discipline_level, score.bonus_eligible, score.next_bonus_date, sentTo, nowISO()]
      ).catch((e) => console.error("attendance review row:", e.message));
      if (hasActivity) await logEmpActivity(emp.id, `Monthly attendance review ${period}: ${score.review_level} (${round2(score.points_30)} pts in period, ${round2(score.points_90)} rolling).`);
    }

    // Management roster summary -- everybody, including the clean months.
    // Suppressed when every employee was skipped as already-reviewed, so
    // pressing "send monthly review" twice does not put two identical
    // summaries in the owner's inbox. A forced re-run still sends.
    const recipients = await reviewRecipients();
    const nothingNew = skipped === scored.length && scored.length > 0 && !force;
    let emailedManagers = 0;
    if (recipients.length && !nothingNew) {
      const needing = scored.filter((x) => x.score.points_30 >= 1.5)
        .sort((a, b) => b.score.points_30 - a.score.points_30);
      const bonusDue = scored.filter((x) => x.score.bonus_eligible);
      const row = (x) => `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${esc(x.score.name)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${round2(x.score.points_30)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${round2(x.score.points_90)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${esc(x.score.review_level)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${esc(x.score.discipline_level)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${x.score.bonus_eligible ? `$${BONUS_AMOUNT}` : "—"}</td>
      </tr>`;
      const html = `
        <p><strong>Monthly attendance review — ${esc(monthLabel(period))}</strong></p>
        <p>${needing.length
          ? `${needing.length} staff member${needing.length === 1 ? "" : "s"} at Coaching Conversation or above this period.`
          : "No staff member reached the coaching threshold this period."}
          ${bonusDue.length ? ` ${bonusDue.length} currently on track for the $${BONUS_AMOUNT} attendance bonus.` : ""}</p>
        <table style="border-collapse:collapse;font-size:13px;width:100%;">
          <tr style="text-align:left;background:#f5f5f7;">
            <th style="padding:7px 10px;">Staff</th><th style="padding:7px 10px;text-align:right;">30-day</th>
            <th style="padding:7px 10px;text-align:right;">90-day</th><th style="padding:7px 10px;">Review level</th>
            <th style="padding:7px 10px;">Standing</th><th style="padding:7px 10px;">Bonus</th>
          </tr>
          ${scored.slice().sort((a, b) => b.score.points_30 - a.score.points_30 || String(a.score.name).localeCompare(String(b.score.name))).map(row).join("")}
        </table>
        <p style="font-size:12px;color:#777;margin-top:14px;">Open the CRM → Staff Attendance for the full record.</p>`;
      for (const to of recipients) {
        const r = await sendEmail({ to, subject: `Attendance review — ${monthLabel(period)}`, html, type: "attendance_monthly_summary" })
          .catch((e) => { console.error("attendance summary email:", e.message); return null; });
        if (r && r.delivered !== "failed") emailedManagers++;
      }
    }

    return {
      ok: true, period, as_of: asOf,
      reviewed: scored.length, emailed_staff: emailedStaff,
      emailed_managers: emailedManagers, skipped_already_sent: skipped,
      no_recipients: !recipients.length,
      summary_suppressed: nothingNew,
    };
  }

  function lastDayOf(period) {
    const [y, m] = String(period).split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  function monthLabel(period) {
    const [y, m] = String(period).split("-").map(Number);
    const names = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${names[m] || m} ${y}`;
  }

  // Who gets the roster summary. Configurable, falling back to the owner
  // notification address and then to the actual owner/admin mailboxes, so this
  // cannot silently go nowhere on a fresh install.
  async function reviewRecipients() {
    const configured = ctx.getAppSetting ? String((await ctx.getAppSetting("attendance_review_recipients", "")) || "").trim() : "";
    if (configured) {
      return [...new Set(configured.split(/[,;]/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    }
    const owner = ctx.getAppSetting ? String((await ctx.getAppSetting("owner_notification_email", "")) || "").trim() : "";
    if (owner) return [owner.toLowerCase()];
    const rows = await dbAll(
      "SELECT email FROM users WHERE role IN ('owner','super_admin','admin') AND email <> 'admin@spectrumsquadlv.com' ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'super_admin' THEN 1 ELSE 2 END"
    ).catch(() => []);
    return rows.length ? [String(rows[0].email).toLowerCase()] : [];
  }

  // -------- public signing page --------
  function servePage(req, res, pathname) {
    if (pathname === "/attendance-sign" || pathname.startsWith("/attendance-sign/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(signPageHtml());
      return true;
    }
    return false;
  }

  function signPageHtml() {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Attendance Acknowledgment — Spectrum Squad</title>
<style>
  :root{--navy:#1b2a6b;--gold:#e0a430;--surface:#fff;--text:#201a4d;--muted:#6b6a86;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);
    background:linear-gradient(160deg,#efe9ff 0%,#f7f8fb 45%,#e8f5f2 100%);min-height:100vh}
  .wrap{max-width:640px;margin:0 auto;padding:26px 18px 60px}
  .card{background:var(--surface);border:1px solid #e7e4f5;border-radius:20px;padding:24px;margin:18px 0;
    box-shadow:0 18px 50px rgba(41,34,92,.12)}
  h1{font-size:22px;margin:6px 0;color:var(--navy)}
  p.body{white-space:pre-wrap;line-height:1.5}
  .meta{background:#f6f4ff;border-radius:12px;padding:12px 14px;margin:12px 0;font-size:14px}
  label.f{display:block;font-weight:600;margin:14px 0 4px;color:var(--navy)}
  input[type=text]{width:100%;border:1px solid #d7d3ee;border-radius:10px;padding:10px;font-size:16px}
  canvas{border:1px dashed #b9b3e0;border-radius:12px;width:100%;height:180px;touch-action:none;background:#fff}
  .row{display:flex;gap:8px;align-items:center;margin-top:6px}
  .btn{display:block;width:100%;background:linear-gradient(135deg,var(--gold),#f0b64a);color:#3a2a00;border:none;
    border-radius:14px;padding:16px;font-size:18px;font-weight:800;cursor:pointer;margin-top:18px}
  .btn[disabled]{opacity:.6;cursor:default}
  .link{background:none;border:1px solid #d7d3ee;color:var(--navy);border-radius:10px;padding:8px 12px;cursor:pointer;font-weight:600}
  .ok{text-align:center;padding:40px 10px}.ok .big{font-size:52px}
  .hint{font-size:13px;color:var(--muted)}
</style></head>
<body>
<div class="wrap" id="app"><div class="card"><p>Loading…</p></div></div>
<script>
(function(){
  var app=document.getElementById('app');
  var token=new URLSearchParams(location.search).get('token')||'';
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
  function err(m){app.innerHTML='<div class="card"><h1>Hmm…</h1><p>'+esc(m)+'</p></div>';}
  fetch('/api/attendance/public/flag?token='+encodeURIComponent(token))
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
    .then(function(res){
      if(!res.ok)return err(res.j.error||'This link is invalid or has expired.');
      if(res.j.acknowledged)return done();
      render(res.j);
    }).catch(function(){err('Could not load the acknowledgment.');});

  function render(d){
    var paras=(d.paragraphs||[]).map(function(p){return esc(p);}).join('\\n');
    app.innerHTML=
      '<div class="card">'+
        '<h1>Attendance Acknowledgment</h1>'+
        '<div class="meta"><strong>'+esc(d.employee_name||'')+'</strong><br>'+
          'Date of incident: '+esc(d.incident_date||'—')+'<br>Reason: '+esc(d.reason||'—')+'</div>'+
        '<p class="body">'+paras+'</p>'+
        '<label class="f">Draw your signature</label>'+
        '<canvas id="pad"></canvas>'+
        '<div class="row"><button class="link" id="clear">Clear</button><span class="hint">Sign with your finger or mouse.</span></div>'+
        '<label class="f">Type your full name</label>'+
        '<input type="text" id="typed" placeholder="Your full name"/>'+
        '<button class="btn" id="sign">Sign &amp; submit</button>'+
      '</div>';
    setupPad();
    document.getElementById('sign').addEventListener('click',submit);
  }

  var canvas,cctx,drawing=false,hasInk=false;
  function setupPad(){
    canvas=document.getElementById('pad');
    var ratio=window.devicePixelRatio||1;
    var rect=canvas.getBoundingClientRect();
    canvas.width=Math.round(rect.width*ratio);
    canvas.height=Math.round(rect.height*ratio);
    cctx=canvas.getContext('2d');
    cctx.fillStyle='#fff';cctx.fillRect(0,0,canvas.width,canvas.height);
    cctx.scale(ratio,ratio);
    cctx.strokeStyle='#1b1440';cctx.lineWidth=2.2;cctx.lineCap='round';cctx.lineJoin='round';
    function pos(e){var r=canvas.getBoundingClientRect();var t=e.touches?e.touches[0]:e;return{x:t.clientX-r.left,y:t.clientY-r.top};}
    function start(e){drawing=true;var p=pos(e);cctx.beginPath();cctx.moveTo(p.x,p.y);e.preventDefault();}
    function move(e){if(!drawing)return;var p=pos(e);cctx.lineTo(p.x,p.y);cctx.stroke();hasInk=true;e.preventDefault();}
    function end(){drawing=false;}
    canvas.addEventListener('mousedown',start);canvas.addEventListener('mousemove',move);
    window.addEventListener('mouseup',end);
    canvas.addEventListener('touchstart',start,{passive:false});
    canvas.addEventListener('touchmove',move,{passive:false});
    canvas.addEventListener('touchend',end);
    document.getElementById('clear').addEventListener('click',function(){cctx.fillStyle='#fff';cctx.fillRect(0,0,canvas.width,canvas.height);hasInk=false;});
  }

  function submit(){
    var typed=(document.getElementById('typed').value||'').trim();
    if(!typed){alert('Please type your full name.');return;}
    if(!hasInk){alert('Please draw your signature.');return;}
    var btn=document.getElementById('sign');btn.disabled=true;btn.textContent='Submitting…';
    var jpeg=canvas.toDataURL('image/jpeg',0.85);
    fetch('/api/attendance/public/sign',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:token,signature:jpeg,typed_name:typed,sig_w:canvas.width,sig_h:canvas.height})})
      .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
      .then(function(res){if(!res.ok){btn.disabled=false;btn.textContent='Sign & submit';return err(res.j.error||'Could not submit.');}done();})
      .catch(function(){btn.disabled=false;btn.textContent='Sign & submit';err('Could not submit. Please try again.');});
  }
  function done(){app.innerHTML='<div class="card ok"><div class="big">✅</div><h1>Thank you</h1><p>Your acknowledgment has been recorded.</p></div>';}
})();
</script>
</body></html>`;
  }

  // ------------------------------------------------------------- daily sweep
  // Runs the monthly review on the first sweep of each month, and chases
  // unsigned acknowledgments. The review is idempotent per (employee, period),
  // so the sweep firing repeatedly on the 1st cannot email anyone twice.
  async function dailySweep() {
    const monthly = await maybeRunMonthlyReview().catch((e) => {
      console.error("attendance monthly review failed:", e.message);
      return null;
    });
    const chased = await chaseUnsigned();
    return { chased, monthly };
  }

  // The review covers the month that has just ENDED, so it runs from the 1st
  // onward and reports last month. A CRM that was asleep on the 1st still
  // sends it the next time it wakes, because the period row is the guard
  // rather than the calendar day.
  async function maybeRunMonthlyReview() {
    const day = today();
    const [y, m] = day.slice(0, 7).split("-").map(Number);
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    const done = await dbGet("SELECT id FROM hr_attendance_reviews WHERE period = ? LIMIT 1", [prev]).catch(() => null);
    if (done) return null;
    // Nothing to review before there is any attendance data at all.
    const any = await dbGet("SELECT id FROM hr_attendance_flags LIMIT 1").catch(() => null);
    if (!any) return null;
    console.log(`[attendance] running the monthly review for ${prev}`);
    return runMonthlyReview({ period: prev, actor: "automation" });
  }

  async function chaseUnsigned() {
    const cutoff = Date.now() - 7 * 86400000;
    const rows = await dbAll(
      "SELECT f.*, e.name AS emp_name FROM hr_attendance_flags f JOIN hr_employees e ON e.id = f.employee_id WHERE f.acknowledged = FALSE AND COALESCE(f.voided, FALSE) = FALSE"
    ).catch(() => []);
    let made = 0;
    for (const f of rows) {
      if (f.followup_task_made) continue;
      const created = f.created_at ? new Date(f.created_at).getTime() : 0;
      if (created && created < cutoff) {
        await makeStaffTask(`Attendance acknowledgment pending: ${f.emp_name}`, f.employee_id);
        await dbRun("UPDATE hr_attendance_flags SET followup_task_made = ? WHERE id = ?", [nowISO(), f.id]);
        made++;
      }
    }
    return made;
  }

  return {
    initTables, handleApi, servePage, dailySweep,
    runMonthlyReview, scoreEmployee,
    _internal: {
      buildAckPdf, REASONS, ATTENDANCE_MATRIX, DISCIPLINE_STEPS, MONTHLY_REVIEW,
      scoreEmployee, disciplineFor, monthlyReviewFor, bonusCycle, noticeHours,
      pointsBetween, daysBefore, addDays, lastDayOf, monthLabel,
    },
  };
};
