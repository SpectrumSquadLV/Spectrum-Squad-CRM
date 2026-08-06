// client-forms.js -- Parent-facing interactive client forms for Spectrum Squad.
// Backend add-on module (same pattern as hr.js): required from server.js with
// shared deps injected. Owns:
//   * Financial Obligation form (Good Faith Estimate / financial responsibility)
//     -- staff enter the eligibility results, the parent gets a cute interactive
//     form to sign, and the signed acknowledgment is kept in the client file.
//   * Parent schedule-request form (Phase 4) lives in its own module additions.
//
// Public endpoints (no auth) live under /api/client-forms/public/* and the
// pages are served at /financial-form/. Staff endpoints require a logged-in
// user (enforced here since this is dispatched before the global auth gate).
"use strict";

const path = require("path");
const fs = require("fs");

module.exports = function initClientForms(ctx) {
  const {
    dbGet,
    dbAll,
    dbRun,
    sendEmail,
    nowISO,
    crypto,
    APP_BASE_URL,
    readBody,
    json,
  } = ctx;

  // ============================ SCHEMA ============================
  async function initTables() {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS client_financial_forms (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        plan_type TEXT NOT NULL,            -- copay | secondary | mco
        copay_amount TEXT,
        copay_per TEXT,                     -- day | session
        coinsurance_pct TEXT,
        deductible TEXT,
        deductible_remaining TEXT,
        oop_max TEXT,
        oop_remaining TEXT,
        secondary_insurance_name TEXT,
        mco_name TEXT,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'sent', -- sent | viewed | signed
        signed_name TEXT,
        signed_at TEXT,
        viewed_at TEXT,
        sent_at TEXT,
        created_by TEXT,
        created_at TEXT
      );
    `);
    console.log("Client Forms schema ready.");
  }

  // ============================ HELPERS ============================
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function money(v) {
    if (v == null || v === "") return null;
    const n = String(v).replace(/[^0-9.\-]/g, "");
    if (n === "") return null;
    return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const PLAN_TYPES = ["copay", "secondary", "mco"];

  // ============================ CORE ============================
  async function createFinancialForm(body, actor) {
    const clientId = Number(body.client_id);
    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
    if (!client) return { ok: false, status: 404, error: "Client not found" };
    const planType = String(body.plan_type || "").trim();
    if (!PLAN_TYPES.includes(planType)) return { ok: false, status: 400, error: "Choose a plan type (co-pay, secondary, or MCO)." };

    const token = crypto.randomBytes(24).toString("hex");
    const row = await dbGet(
      `INSERT INTO client_financial_forms
        (client_id, token, plan_type, copay_amount, copay_per, coinsurance_pct, deductible,
         deductible_remaining, oop_max, oop_remaining, secondary_insurance_name, mco_name,
         notes, status, sent_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)
       RETURNING *`,
      [
        clientId, token, planType,
        body.copay_amount || null, body.copay_per || "day", body.coinsurance_pct || null,
        body.deductible || null, body.deductible_remaining || null, body.oop_max || null,
        body.oop_remaining || null, body.secondary_insurance_name || null, body.mco_name || null,
        body.notes || null, nowISO(), actor || "staff", nowISO(),
      ]
    );

    // Email the parent a link to the interactive form.
    if (client.parent_email) {
      const link = `${APP_BASE_URL}/financial-form/?token=${token}`;
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;color:#29225c;">
          <h2 style="color:#29225c;">One quick step for ${esc(client.child_name)} 💛</h2>
          <p>Hi ${esc(client.parent_name || "there")},</p>
          <p>We've completed the insurance benefits check for <strong>${esc(client.child_name)}</strong>! The last step before we move forward is a quick, friendly review of what your insurance covers and what (if anything) you'd be responsible for — then a simple signature.</p>
          <p style="text-align:center;margin:28px 0;">
            <a href="${esc(link)}" style="background:#e0a430;color:#29225c;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:999px;font-size:16px;display:inline-block;">Review &amp; Sign →</a>
          </p>
          <p style="font-size:13px;color:#666;">It only takes a minute. If the button doesn't work, copy and paste this link:<br/>${esc(link)}</p>
          <p>Warmly,<br/>The Spectrum Squad Team</p>
        </div>`;
      await sendEmail({
        to: client.parent_email,
        subject: `Your financial review for ${client.child_name} — Spectrum Squad`,
        html,
        clientId,
        type: "financial_form",
      }).catch((e) => console.error("financial form email failed:", e));
    }

    return { ok: true, form: row, link: `${APP_BASE_URL}/financial-form/?token=${token}`, emailed: !!client.parent_email };
  }

  async function listFinancialForms(clientId) {
    return dbAll(
      `SELECT id, client_id, token, plan_type, copay_amount, copay_per, status,
              signed_name, signed_at, viewed_at, sent_at, created_at
         FROM client_financial_forms WHERE client_id = ? ORDER BY id DESC`,
      [clientId]
    );
  }

  async function getPublicForm(token) {
    const form = await dbGet("SELECT * FROM client_financial_forms WHERE token = ?", [token]);
    if (!form) return null;
    const client = await dbGet("SELECT child_name, parent_name FROM clients WHERE id = ?", [form.client_id]);
    if (form.status === "sent") {
      await dbRun("UPDATE client_financial_forms SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'", [nowISO(), form.id]);
    }
    return { form, client };
  }

  async function signForm(token, signedName) {
    const form = await dbGet("SELECT * FROM client_financial_forms WHERE token = ?", [token]);
    if (!form) return { ok: false, status: 404, error: "Form not found" };
    if (form.status === "signed") return { ok: true, alreadySigned: true };
    const name = String(signedName || "").trim();
    if (!name) return { ok: false, status: 400, error: "Please type your name to sign." };

    await dbRun(
      "UPDATE client_financial_forms SET status = 'signed', signed_name = ?, signed_at = ? WHERE id = ?",
      [name, nowISO(), form.id]
    );

    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [form.client_id]);

    // Keep the signed acknowledgment in the client's file as a viewable link.
    await dbRun(
      `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, external_url, uploaded_at)
       VALUES (?, ?, ?, NULL, NULL, 'link', ?, ?)`,
      [
        form.client_id,
        `Signed Financial Responsibility Form (${new Date().toLocaleDateString()})`,
        "financial-responsibility.html",
        `${APP_BASE_URL}/financial-form/?token=${token}`,
        nowISO(),
      ]
    ).catch((e) => console.error("could not file signed form:", e));

    // Confirmation to the parent + a copy of the record kept in the outbox.
    if (client && client.parent_email) {
      await sendEmail({
        to: client.parent_email,
        subject: `Thank you — financial form signed for ${client.child_name}`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#29225c;">
          <h2>All done, thank you! 🎉</h2>
          <p>Hi ${esc(client.parent_name || "there")}, we've received your signed financial responsibility form for <strong>${esc(client.child_name)}</strong>. A copy is saved in your file. You can view it anytime here:</p>
          <p><a href="${esc(APP_BASE_URL)}/financial-form/?token=${esc(token)}">View signed form</a></p>
          <p>Warmly,<br/>The Spectrum Squad Team</p></div>`,
        clientId: form.client_id,
        type: "financial_form",
      }).catch((e) => console.error("sign confirmation email failed:", e));
    }

    return { ok: true, signed_at: nowISO(), signed_name: name };
  }

  // ============================ API ============================
  // Returns true if handled. Dispatched from server.js BEFORE the auth gate,
  // so public endpoints work without a session and staff endpoints check `user`.
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/client-forms/")) return false;

    // ---- Public (no auth) ----
    if (pathname === "/api/client-forms/public/financial" && method === "GET") {
      const data = await getPublicForm(query.token || "");
      if (!data) { json(res, 404, { error: "This form link is invalid or has expired." }); return true; }
      const f = data.form;
      json(res, 200, {
        child_name: data.client ? data.client.child_name : "",
        parent_name: data.client ? data.client.parent_name : "",
        plan_type: f.plan_type,
        copay_amount: f.copay_amount,
        copay_per: f.copay_per,
        coinsurance_pct: f.coinsurance_pct,
        deductible: f.deductible,
        deductible_remaining: f.deductible_remaining,
        oop_max: f.oop_max,
        oop_remaining: f.oop_remaining,
        secondary_insurance_name: f.secondary_insurance_name,
        mco_name: f.mco_name,
        notes: f.notes,
        status: f.status,
        signed_name: f.signed_name,
        signed_at: f.signed_at,
      });
      return true;
    }
    if (pathname === "/api/client-forms/public/financial/sign" && method === "POST") {
      const body = await readBody(req);
      const result = await signForm(body.token || "", body.signed_name || "");
      json(res, result.ok ? 200 : (result.status || 400), result);
      return true;
    }

    // ---- Staff (auth required) ----
    if (!user) { json(res, 401, { error: "Not authenticated" }); return true; }

    if (pathname === "/api/client-forms/financial" && method === "POST") {
      const body = await readBody(req);
      const result = await createFinancialForm(body, user.email);
      json(res, result.ok ? 201 : (result.status || 400), result);
      return true;
    }
    const listMatch = pathname.match(/^\/api\/client-forms\/financial\/(\d+)$/);
    if (listMatch && method === "GET") {
      json(res, 200, await listFinancialForms(Number(listMatch[1])));
      return true;
    }

    return false;
  }

  // ============================ PUBLIC PAGE ============================
  async function servePage(req, res, pathname) {
    if (pathname === "/financial-form" || pathname.startsWith("/financial-form/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(financialFormHtml());
      return true;
    }
    return false;
  }

  // Cute, friendly, interactive financial responsibility form. Fetches its own
  // data by token, shows the scenario that applies (co-pay / secondary / MCO),
  // the "keep your insurance current" reminder, the No Surprises Act
  // disclaimers, and a type-to-sign acknowledgment with a confetti celebration.
  function financialFormHtml() {
    return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Financial Review — Spectrum Squad</title>
<style>
  :root{--navy:#29225c;--gold:#e0a430;--teal:#5fa8a0;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--navy);
    background:linear-gradient(135deg,#f3f0ff 0%,#eafaf6 100%);min-height:100vh;}
  #confetti{position:fixed;inset:0;pointer-events:none;z-index:60}
  .wrap{max-width:640px;margin:0 auto;padding:24px 16px 80px;}
  .card{background:#fff;border-radius:20px;box-shadow:0 18px 50px rgba(41,34,92,.14);padding:28px 26px;animation:rise .5s ease both;}
  @keyframes rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
  .badge{display:inline-block;background:#eef0fb;color:var(--navy);border-radius:999px;padding:6px 14px;font-size:12.5px;font-weight:700;margin-bottom:14px;}
  h1{font-size:24px;margin:0 0 6px;}
  h2{font-size:16px;margin:22px 0 8px;color:var(--navy);}
  p{line-height:1.6;font-size:15px;}
  .hero{font-size:44px;line-height:1;margin-bottom:6px;}
  .scenario{border-radius:14px;padding:16px 18px;margin:16px 0;border:2px solid;}
  .scenario.copay{background:#fff8ec;border-color:var(--gold);}
  .scenario.secondary{background:#eef6f5;border-color:var(--teal);}
  .scenario.mco{background:#f3f0ff;border-color:#8a7fd0;}
  .scenario h3{margin:0 0 8px;font-size:17px;}
  table.figs{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px;}
  table.figs td{padding:6px 8px;border-bottom:1px solid #eee;}
  table.figs td:last-child{text-align:right;font-weight:700;}
  .disclaimer{background:#faf9fd;border:1px solid #e7e4f2;border-radius:12px;padding:14px 16px;font-size:12.5px;color:#555;line-height:1.55;margin-top:18px;}
  .keepcurrent{background:#eafaf6;border:1px dashed var(--teal);border-radius:12px;padding:14px 16px;margin-top:16px;font-size:14px;}
  label.ack{display:flex;gap:10px;align-items:flex-start;margin:18px 0;font-size:14px;cursor:pointer;}
  label.ack input{margin-top:3px;transform:scale(1.3);}
  .sign-label{font-size:13px;font-weight:700;margin:14px 0 6px;}
  #sign{width:100%;padding:14px 16px;border:2px solid #ddd;border-radius:12px;font-size:22px;
    font-family:'Segoe Script','Brush Script MT',cursive;color:var(--navy);}
  #sign:focus{outline:none;border-color:var(--gold);}
  .btn{width:100%;margin-top:18px;background:var(--gold);color:var(--navy);font-weight:800;border:none;
    border-radius:999px;padding:16px;font-size:17px;cursor:pointer;transition:transform .1s;}
  .btn:hover{transform:translateY(-1px)}
  .btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
  .muted{color:#888;font-size:12.5px;text-align:center;margin-top:12px;}
  .done{text-align:center;padding:20px 0;}
  .done .big{font-size:60px;}
  .err{color:#b91c1c;text-align:center;padding:40px 16px;}
</style></head>
<body>
<canvas id="confetti"></canvas>
<div class="wrap"><div class="card" id="card"><p class="err">Loading…</p></div></div>
<script>
var params=new URLSearchParams(location.search),token=params.get("token");
var card=document.getElementById("card");
function money(v){if(v==null||v==="")return null;var n=String(v).replace(/[^0-9.\\-]/g,"");if(n==="")return null;return "$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}
function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}

if(!token){card.innerHTML='<p class="err">This form link is missing its code. Please use the link from your email.</p>';}
else{fetch("/api/client-forms/public/financial?token="+encodeURIComponent(token)).then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});}).then(function(res){
  if(!res.ok){card.innerHTML='<p class="err">'+esc(res.d.error||"This link is invalid or has expired.")+'</p>';return;}
  render(res.d);
}).catch(function(){card.innerHTML='<p class="err">Something went wrong loading your form. Please try again.</p>';});}

function scenarioHTML(d){
  if(d.plan_type==="copay"){
    var rows="";
    var cp=money(d.copay_amount); if(cp) rows+='<td>Your co-pay</td><td>'+cp+' per '+esc(d.copay_per||"day")+'</td></tr><tr>';
    if(d.coinsurance_pct) rows+='<td>Co-insurance</td><td>'+esc(d.coinsurance_pct)+'%</td></tr><tr>';
    var ded=money(d.deductible); if(ded) rows+='<td>Deductible</td><td>'+ded+'</td></tr><tr>';
    var dedr=money(d.deductible_remaining); if(dedr) rows+='<td>Deductible remaining</td><td>'+dedr+'</td></tr><tr>';
    var oop=money(d.oop_max); if(oop) rows+='<td>Out-of-pocket max</td><td>'+oop+'</td></tr><tr>';
    var oopr=money(d.oop_remaining); if(oopr) rows+='<td>Out-of-pocket remaining</td><td>'+oopr+'</td></tr><tr>';
    if(rows) rows="<table class='figs'><tr>"+rows.replace(/<tr>$/,"")+"</table>";
    return '<div class="scenario copay"><h3>💳 You have a co-pay</h3>'+
      '<p>Your insurance covers ABA services, and you have a co-pay (and/or co-insurance) that applies to each visit. Here is what we have on file from your benefits check:</p>'+
      rows+
      '<p style="margin-top:10px;">Once your out-of-pocket maximum is met, insurance pays 100% for the rest of the calendar year. Actual amounts are always based on how your insurer processes each claim.</p></div>';
  }
  if(d.plan_type==="secondary"){
    return '<div class="scenario secondary"><h3>🧩 You have secondary insurance</h3>'+
      '<p>Great news — you have a <strong>secondary insurance'+(d.secondary_insurance_name?' ('+esc(d.secondary_insurance_name)+')':'')+'</strong>. Your primary insurance is billed first, and your secondary may cover some or all of the remaining balance (like your co-pay or co-insurance).</p>'+
      (money(d.copay_amount)?'<p>Any co-pay on file: <strong>'+money(d.copay_amount)+' per '+esc(d.copay_per||"day")+'</strong> — your secondary may reduce or cover this.</p>':'')+
      '<p>You are only responsible for amounts that neither plan pays. We will always bill both before anything comes to you.</p></div>';
  }
  // mco
  return '<div class="scenario mco"><h3>🛡️ You have an MCO plan</h3>'+
    '<p>Our records show '+ (d.mco_name?('you are enrolled in <strong>'+esc(d.mco_name)+'</strong>, a'):'you are enrolled in a') +' <strong>Managed Care Organization (MCO)</strong>.</p>'+
    '<p>While your MCO coverage is active, <strong>we are not able to bill for ABA services</strong>. That means services can\\'t be provided through your insurance during that time. If your MCO coverage changes — or if you gain other coverage — please let us know right away so we can help you keep services going.</p>'+
    '<p>We\\'ll walk through your options with you. You are never responsible for charges we cannot bill.</p></div>';
}

function render(d){
  if(d.status==="signed"){
    card.innerHTML='<div class="done"><div class="big">✅</div><h1>You\\'re all set!</h1>'+
      '<p>This financial responsibility form was signed by <strong>'+esc(d.signed_name)+'</strong>'+(d.signed_at?' on '+new Date(d.signed_at).toLocaleDateString():'')+'.</p>'+
      '<p class="muted">A copy is saved in '+esc(d.child_name||"your child")+'\\'s file. You can close this page.</p></div>';
    return;
  }
  var html='<span class="badge">Spectrum Squad · Financial Review</span>'+
    '<div class="hero">💛</div>'+
    '<h1>Almost there, '+esc(d.parent_name||"friend")+'!</h1>'+
    '<p>We finished the insurance benefits check for <strong>'+esc(d.child_name||"your child")+'</strong>. Here\\'s a clear, friendly summary of your coverage and what to expect — then just sign at the bottom.</p>'+
    scenarioHTML(d)+
    (d.notes?'<p><strong>A note from our team:</strong> '+esc(d.notes)+'</p>':'')+
    '<div class="keepcurrent"><strong>📌 Please keep your insurance up to date with us.</strong><br/>'+
      'Insurance plans change — new cards, new plans, new MCO enrollment, or a change in coverage can all affect services and billing. The moment anything about your insurance changes, please tell us. Keeping us current protects your child\\'s services and prevents surprise bills.</div>'+
    '<h2>Acknowledgment &amp; Signature</h2>'+
    '<div class="disclaimer">I understand that I am responsible for any portion of costs for services provided that are not reimbursed by my insurance company. This summary of benefits was provided by my insurance company; the actual determination of benefits will be made by the insurance company. This is a Good Faith Estimate under the No Surprises Act — it is an estimate, not a contract, and actual charges may differ. I have the right to initiate a dispute if billed charges are substantially more than this estimate.</div>'+
    '<label class="ack"><input type="checkbox" id="ack"/> <span>I have read and understand the information above, and I acknowledge my financial responsibility for '+esc(d.child_name||"my child")+'\\'s care.</span></label>'+
    '<div class="sign-label">✍️ Type your full name to sign</div>'+
    '<input id="sign" placeholder="Your full name" autocomplete="name"/>'+
    '<button class="btn" id="submit" disabled>Sign &amp; Submit</button>'+
    '<div class="muted">Signed electronically · '+new Date().toLocaleDateString()+'</div>';
  card.innerHTML=html;
  var ack=document.getElementById("ack"),sign=document.getElementById("sign"),btn=document.getElementById("submit");
  function upd(){btn.disabled=!(ack.checked && sign.value.trim().length>1);}
  ack.addEventListener("change",upd);sign.addEventListener("input",upd);
  btn.addEventListener("click",function(){
    btn.disabled=true;btn.textContent="Signing…";
    fetch("/api/client-forms/public/financial/sign",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:token,signed_name:sign.value.trim()})}).then(function(r){return r.json();}).then(function(res){
      if(res.ok){celebrate();card.innerHTML='<div class="done"><div class="big">🎉</div><h1>Thank you, '+esc(sign.value.trim())+'!</h1><p>Your financial responsibility form is signed and saved. Our team will be in touch with next steps for '+esc(d.child_name||"your child")+'.</p><p class="muted">You can close this page.</p></div>';}
      else{btn.disabled=false;btn.textContent="Sign & Submit";alert(res.error||"Could not sign. Please try again.");}
    }).catch(function(){btn.disabled=false;btn.textContent="Sign & Submit";alert("Something went wrong. Please try again.");});
  });
}

// ---- confetti ----
function celebrate(){
  var cv=document.getElementById("confetti"),cx=cv.getContext("2d");
  cv.width=innerWidth;cv.height=innerHeight;var parts=[];
  var colors=["#e0a430","#5fa8a0","#29225c","#f6c667","#8a7fd0"];
  for(var i=0;i<160;i++){parts.push({x:Math.random()*cv.width,y:-20-Math.random()*cv.height,r:4+Math.random()*6,c:colors[i%colors.length],vy:2+Math.random()*4,vx:-2+Math.random()*4,a:Math.random()*6});}
  var t=0;(function run(){cx.clearRect(0,0,cv.width,cv.height);parts.forEach(function(p){p.y+=p.vy;p.x+=p.vx;p.a+=.1;cx.save();cx.translate(p.x,p.y);cx.rotate(p.a);cx.fillStyle=p.c;cx.fillRect(-p.r/2,-p.r/2,p.r,p.r*1.6);cx.restore();});t++;if(t<260)requestAnimationFrame(run);else cx.clearRect(0,0,cv.width,cv.height);})();
}
</script>
</body></html>`;
  }

  return { initTables, handleApi, servePage, createFinancialForm };
};
