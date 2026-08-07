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

  const REASONS = ["No call/no show", "Late arrival", "Early departure", "Excessive callouts", "Other"];

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
  }

  // -------------------------------------------------------------- permissions
  function role(user) { return (user && (user.role || user.role_key || "")) || ""; }
  function canManage(user) {
    return ["owner", "super_admin", "admin", "hr_admin"].includes(role(user));
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
        const rows = await dbAll("SELECT * FROM hr_attendance_flags WHERE employee_id = ? ORDER BY id DESC", [empId]);
        rows.forEach((r) => { r.has_pdf = !!r.pdf_stored; delete r.signature; });
        return json(res, 200, { flags: rows, count_90d: flagsInLast90(rows) });
      }

      // Create a flag.
      if (listMatch && method === "POST") {
        const empId = Number(listMatch[1]);
        const emp = await dbGet("SELECT id, name FROM hr_employees WHERE id = ?", [empId]);
        if (!emp) return json(res, 404, { error: "Employee not found" });
        const b = await readBody(req);
        const reason = REASONS.includes(b.reason) ? b.reason : (b.reason || "Other");
        const row = await dbRun(
          `INSERT INTO hr_attendance_flags (employee_id, incident_date, reason, notes, acknowledged, created_by, created_at)
           VALUES (?, ?, ?, ?, FALSE, ?, ?) RETURNING id`,
          [empId, b.incident_date || nowISO().slice(0, 10), reason, b.notes || null, actor, nowISO()]
        );
        const id = row && row.rows && row.rows[0] ? row.rows[0].id : null;
        await logEmpActivity(empId, `Attendance flag logged: ${reason} (incident ${b.incident_date || "n/a"}).`);
        return json(res, 201, { ok: true, id });
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

      // Delete a flag (logged mistakes).
      const delMatch = pathname.match(/^\/api\/attendance\/flag\/(\d+)$/);
      if (delMatch && method === "DELETE") {
        const flag = await dbGet("SELECT * FROM hr_attendance_flags WHERE id = ?", [Number(delMatch[1])]);
        if (flag) {
          if (flag.pdf_stored) { try { fs.unlinkSync(path.join(ATT_DIR, flag.pdf_stored)); } catch (e) {} }
          await dbRun("DELETE FROM hr_attendance_flags WHERE id = ?", [flag.id]);
          await logEmpActivity(flag.employee_id, "Attendance flag removed.");
        }
        return json(res, 200, { ok: true });
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
  :root{--navy:#29225c;--gold:#e0a430;--surface:#fff;--text:#201a4d;--muted:#6b6a86;}
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
  // Unacknowledged flags older than 7 days → auto-task (once per flag).
  async function dailySweep() {
    const cutoff = Date.now() - 7 * 86400000;
    const rows = await dbAll(
      "SELECT f.*, e.name AS emp_name FROM hr_attendance_flags f JOIN hr_employees e ON e.id = f.employee_id WHERE f.acknowledged = FALSE"
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

  return { initTables, handleApi, servePage, dailySweep, _internal: { buildAckPdf, REASONS } };
};
