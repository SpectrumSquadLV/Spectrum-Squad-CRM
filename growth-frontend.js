// growth-frontend.js -- Lead Management + Policies/SOPs UIs.
// Exposes window.__renderLeads(mount) and window.__renderPolicies(mount) for the
// native router. Uses the global api() helper.
(function () {
  "use strict";
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function money(n) { if (n == null || n === "") return "—"; return "$" + (Math.round(Number(n) * 100) / 100).toLocaleString(); }

  // ============================ LEADS ============================
  function contractCell(l) {
    const c = l.contract || {};
    if (c.type === "month_to_month") return '<span class="tag" style="background:#e0f2fe;">Month-to-month</span>';
    if (c.type === "fixed_term" && c.expiresOn) {
      const bg = c.expired ? "#fee2e2" : (c.expiringSoon ? "#fef3c7" : "#dcfce7");
      return `<span class="tag" style="background:${bg};">${c.expired ? "Expired" : c.daysRemaining + "d left"}</span>`;
    }
    return '<span style="color:var(--text-muted);">—</span>';
  }
  async function renderLeads(mount) {
    let d;
    try { d = await api("/api/leads"); }
    catch (e) { mount.innerHTML = `<div class="page-header"><div><h1>Lead Management</h1></div></div><div class="empty-state">${esc(e.message)}</div>`; return; }
    const stageColor = (s) => ({ New: "#e0e7ff", Contacted: "#fef3c7", "Meeting Set": "#dbeafe", "Proposal Sent": "#fde68a", Won: "#dcfce7", Lost: "#fee2e2" }[s] || "#eee");
    const rows = d.leads.map((l) => `<tr data-lead="${l.id}" style="cursor:pointer;">
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);"><strong>${esc(l.name)}</strong>${l.contact_name ? `<div style="color:var(--text-muted); font-size:12px;">${esc(l.contact_name)}</div>` : ""}</td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">${esc(l.relationship_status || l.lead_type || "—")}</td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);"><span class="tag" style="background:${stageColor(l.stage)};">${esc(l.stage)}</span></td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">${contractCell(l)}</td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">${l.assigned_to ? esc(l.assigned_to) : "—"}</td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">${l.next_follow_up ? esc(l.next_follow_up) : "—"}</td>
    </tr>`).join("");
    mount.innerHTML = `
      <div class="page-header">
        <div><h1>Lead &amp; Contract Management</h1><p>Nurture relationships and manage contracts — schools, private-pay, and community partners. Track stage, contract timing, and follow-ups.</p></div>
        <button class="btn" id="lead-add">+ Add lead</button>
      </div>
      <div class="card"><div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:13px; min-width:720px;">
        <thead><tr style="text-align:left; color:var(--text-muted); font-size:11px; text-transform:uppercase;">
          <th style="padding:8px 10px;">Organization</th><th style="padding:8px 10px;">Relationship</th><th style="padding:8px 10px;">Stage</th><th style="padding:8px 10px;">Contract</th><th style="padding:8px 10px;">Assigned</th><th style="padding:8px 10px;">Next follow-up</th>
        </tr></thead><tbody>${rows || `<tr><td colspan="6"><div class="empty-state">No leads yet.</div></td></tr>`}</tbody>
      </table></div></div>`;
    mount.querySelector("#lead-add").addEventListener("click", () => leadModal(null, d, mount));
    mount.querySelectorAll("[data-lead]").forEach((tr) => tr.addEventListener("click", () => openLead(tr.dataset.lead, d, mount)));
  }

  // Fetch the full lead (with timeline) then open the profile.
  async function openLead(id, d, mount) {
    try { const detail = await api("/api/leads/" + id); leadModal(detail.lead, d, mount, detail.events); }
    catch (e) { alert(e.message || "Could not open lead."); }
  }

  function contractBanner(lead) {
    const c = lead.contract || {};
    if (c.type === "month_to_month") return `<div style="padding:10px 12px; border-radius:10px; background:#e0f2fe; color:#075985; font-weight:700; font-size:13px;">🔄 Month-to-month — no fixed expiration. Renews automatically until either side gives ${lead.notice_period_days || "the agreed"} days' notice.</div>`;
    if (c.type === "fixed_term" && c.expiresOn) {
      const bg = c.expired ? "#fee2e2" : (c.expiringSoon ? "#fef3c7" : "#dcfce7");
      const fg = c.expired ? "#a3282e" : (c.expiringSoon ? "#946213" : "#166534");
      const label = c.expired ? `Expired ${Math.abs(c.daysRemaining)} day(s) ago` : `${c.daysRemaining} day(s) remaining`;
      return `<div style="padding:10px 12px; border-radius:10px; background:${bg}; color:${fg}; font-weight:700; font-size:13px;">📄 Fixed-term contract ends ${esc(c.expiresOn)} — ${label}.${lead.renewal_date ? " Renewal date: " + esc(lead.renewal_date) + "." : ""}</div>`;
    }
    return "";
  }
  function eventIcon(t) { return { note: "📝", checkin: "🤝", contract: "📄", alert: "⚠️", task: "✅", stage: "➡️" }[t] || "•"; }

  function leadModal(lead, d, mount, events) {
    lead = lead || {};
    events = events || [];
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    const f = (k, label, type) => `<div class="field"><label>${label}</label><input data-f="${k}" ${type ? `type="${type}"` : ""} value="${esc(lead[k] == null ? "" : lead[k])}" /></div>`;
    const sel = (k, label, opts, cur) => `<div class="field"><label>${label}</label><select data-f="${k}">${opts.map((o) => `<option value="${esc(o)}" ${String(cur) === String(o) ? "selected" : ""}>${esc(o === "none" ? "—" : o.replace(/_/g, " "))}</option>`).join("")}</select></div>`;
    const timeline = events.length
      ? events.map((ev) => `<div style="display:flex; gap:8px; padding:7px 0; border-bottom:1px solid var(--border,#eee); font-size:12.5px;"><span>${eventIcon(ev.event_type)}</span><div><div>${esc(ev.body)}</div><div style="color:var(--text-muted); font-size:11px;">${esc((ev.actor || "system"))} · ${esc((ev.created_at || "").slice(0, 16).replace("T", " "))}</div></div></div>`).join("")
      : `<div class="empty-state" style="text-align:left;">No activity logged yet.</div>`;
    bd.innerHTML = `<div class="modal" style="width:680px; max-width:96vw;">
      <div class="modal-header"><h2>${lead.id ? esc(lead.name) : "Add lead"}</h2><button class="close-btn">✕</button></div>

      <div class="section-title" style="margin-top:0;">Organization</div>
      <div class="form-grid" style="gap:10px;">
        ${f("name", "Organization / lead name")}
        ${sel("lead_type", "Type", d.types, lead.lead_type)}
        ${sel("lead_source", "Lead source", ["", ...d.sources], lead.lead_source)}
        ${sel("relationship_status", "Relationship status", ["", ...d.relationship_statuses], lead.relationship_status)}
        ${sel("stage", "Pipeline stage", d.stages, lead.stage)}
        ${f("assigned_to", "Assigned team member")}
        ${f("contact_name", "Primary contact")}
        ${f("contact_email", "Contact email", "email")}
        ${f("contact_phone", "Contact phone")}
        ${f("address", "Address")}
        <div class="field full"><label>Notes</label><textarea data-f="notes" rows="2">${esc(lead.notes || "")}</textarea></div>
      </div>

      <div class="section-title">Contract</div>
      ${lead.id ? `<div style="margin-bottom:10px;">${contractBanner(lead)}</div>` : ""}
      <div class="form-grid" style="gap:10px;">
        ${sel("contract_type", "Contract type", d.contract_types, lead.contract_type || "none")}
        ${sel("contract_status", "Contract status", d.contract_statuses, lead.contract_status || "none")}
        ${f("contract_start_date", "Start date", "date")}
        ${f("contract_end_date", "End date (fixed-term only)", "date")}
        ${f("renewal_date", "Renewal date", "date")}
        ${f("notice_period_days", "Notice period (days)", "number")}
        ${f("weekly_committed_hours", "Weekly committed hours", "number")}
        ${f("payment_arrangement", "Payment arrangement")}
        ${f("assigned_bcbas", "Assigned BCBA(s)")}
        ${f("other_staff", "Other assigned staff")}
        <div class="field full"><label>Special requirements</label><textarea data-f="special_requirements" rows="2">${esc(lead.special_requirements || "")}</textarea></div>
      </div>
      <div style="font-size:11.5px; color:var(--text-muted); margin-top:6px;">Month-to-month contracts have no fixed expiration. Fixed-term contracts show remaining time and raise expiry alerts automatically.</div>

      ${lead.id ? `<div id="pay-mount"></div>` : ""}

      ${lead.id ? `
      <div class="section-title">Relationship nurturing</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <span style="font-size:12.5px; color:var(--text-muted);">Send a check-in email:</span>
        <button class="btn small secondary" data-checkin="30">30-day</button>
        <button class="btn small secondary" data-checkin="60">60-day</button>
        <button class="btn small secondary" data-checkin="90">90-day</button>
        <span id="checkin-status" style="font-size:12px; color:var(--text-muted);"></span>
      </div>
      <div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">The 30/60/90 automation also drops a reminder task on the assigned team member. Templates are editable under Email Templates.</div>

      <div class="section-title">Timeline</div>
      <div style="display:flex; gap:8px; margin-bottom:10px;">
        <input id="ev-input" placeholder="Log a call, meeting, or note…" style="flex:1;" />
        <button class="btn small" id="ev-add">Log</button>
      </div>
      <div id="ev-list" style="max-height:220px; overflow:auto;">${timeline}</div>
      ` : ""}

      <div style="margin-top:16px; display:flex; gap:8px;">
        <button class="btn" id="lead-save">${lead.id ? "Save changes" : "Add lead"}</button>
        ${lead.id ? `<button class="btn secondary" id="lead-del" style="color:#b91c1c;">Delete</button>` : ""}
        <span id="lead-status" style="font-size:12.5px; color:var(--text-muted); align-self:center;"></span>
      </div>
    </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    if (lead.id) renderPaymentPanel(bd, lead);
    bd.querySelector("#lead-save").addEventListener("click", async () => {
      const body = {};
      bd.querySelectorAll("[data-f]").forEach((el) => { body[el.dataset.f] = el.value === "" ? null : el.value; });
      if (!body.name) { bd.querySelector("#lead-status").textContent = "Name is required."; return; }
      try {
        if (lead.id) await api("/api/leads/" + lead.id, { method: "PATCH", body });
        else await api("/api/leads", { method: "POST", body });
        close(); renderLeads(mount);
      } catch (e) { bd.querySelector("#lead-status").textContent = e.message || "Failed."; }
    });
    const del = bd.querySelector("#lead-del");
    if (del) del.addEventListener("click", async () => { if (!confirm("Delete this lead and its history?")) return; try { await api("/api/leads/" + lead.id, { method: "DELETE" }); close(); renderLeads(mount); } catch (e) { alert(e.message); } });
    // Timeline add
    const evAdd = bd.querySelector("#ev-add");
    if (evAdd) evAdd.addEventListener("click", async () => {
      const input = bd.querySelector("#ev-input"); const v = (input.value || "").trim();
      if (!v) return;
      try { await api("/api/leads/" + lead.id + "/events", { method: "POST", body: { body: v } }); close(); openLead(lead.id, d, mount); }
      catch (e) { alert(e.message); }
    });
    // Check-in preview + send
    bd.querySelectorAll("[data-checkin]").forEach((btn) => btn.addEventListener("click", async () => {
      const days = btn.dataset.checkin; const st = bd.querySelector("#checkin-status");
      st.textContent = "Loading preview…";
      let prev;
      try { prev = await api("/api/leads/" + lead.id + "/checkin/" + days + "/preview", { method: "POST" }); }
      catch (e) { st.textContent = e.message || "Preview failed."; return; }
      st.textContent = "";
      checkinPreviewModal(lead, days, prev, () => { close(); openLead(lead.id, d, mount); });
    }));
  }

  // Payment (Stripe) panel — owner-only. The GET is owner-gated server-side, so
  // if it 403s we simply hide the section. Shows only safe identifiers.
  async function renderPaymentPanel(bd, lead) {
    const mnt = bd.querySelector("#pay-mount");
    if (!mnt) return;
    let p;
    try { p = await api("/api/leads/" + lead.id + "/payment"); }
    catch (e) { mnt.innerHTML = ""; return; } // 403 (not owner) -> hide entirely
    function row(k, v) { return v ? `<li class="review-list" style="list-style:none;padding:0;margin:0;"><span style="color:var(--text-muted);">${esc(k)}:</span> <strong>${esc(v)}</strong></li>` : ""; }
    var pm = p.payment_method_on_file
      ? `${esc(p.payment_method_brand || p.payment_method_type || "Method")}${p.payment_method_last4 ? " ····" + esc(p.payment_method_last4) : ""}`
      : "None on file";
    var statusBadge = p.failed_payment
      ? `<span class="tag" style="background:#fee2e2;color:#a3282e;">⚠️ Payment failed</span>`
      : (p.payment_method_on_file ? `<span class="tag" style="background:#dcfce7;color:#166534;">Active</span>` : `<span class="tag" style="background:#eef0f5;">Not set up</span>`);
    var notConfigured = !p.configured
      ? `<div style="font-size:12px;color:#946213;background:#fef3e0;border-radius:8px;padding:8px 10px;margin-top:8px;">Stripe isn't connected on the server yet. Add <code>STRIPE_SECRET_KEY</code> (and <code>STRIPE_WEBHOOK_SECRET</code>) in your environment to enable live payments. The setup button will work as soon as it's connected.</div>`
      : "";
    mnt.innerHTML = `<div class="section-title">Payment (Stripe)</div>
      <div style="border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:12px 14px;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">${statusBadge}
          <span style="font-size:13px;">Method on file: <strong>${p.payment_method_on_file ? "Yes" : "No"}</strong></span></div>
        <ul style="list-style:none;padding:0;margin:0;font-size:13px;line-height:1.9;">
          ${row("Payment method", pm)}
          ${row("Status", p.payment_status)}
          ${row("Last payment", p.last_payment_at ? (p.last_payment_at.slice(0,10) + (p.last_payment_amount!=null?` · $${p.last_payment_amount}`:"")) : "")}
          ${row("Next payment", p.next_payment_at ? p.next_payment_at.slice(0,10) : "")}
          ${row("Stripe customer", p.stripe_customer_ref)}
        </ul>
        <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
          <button class="btn small" id="pay-setup">${p.payment_method_on_file ? "Update payment method" : "Set up payment method"}</button>
          <span id="pay-status" style="font-size:12px;color:var(--text-muted);"></span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">🔒 Card and bank details are entered on Stripe's secure pages — this CRM only ever stores safe identifiers (brand, last 4, status), never full card or account numbers.</div>
        ${notConfigured}
      </div>`;
    var btn = mnt.querySelector("#pay-setup");
    if (btn) btn.addEventListener("click", async () => {
      var st = mnt.querySelector("#pay-status"); btn.disabled = true; st.textContent = "Starting secure setup…";
      try {
        var r = await api("/api/leads/" + lead.id + "/payment/setup", { method: "POST" });
        if (r.url) { window.location.href = r.url; }
        else { st.textContent = "Setup started."; btn.disabled = false; }
      } catch (e) { st.textContent = e.message || "Could not start setup."; btn.disabled = false; }
    });
  }

  // Minimal preview-and-send modal for relationship check-ins.
  function checkinPreviewModal(lead, days, prev, onSent) {
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    bd.innerHTML = `<div class="modal" style="width:600px; max-width:94vw;">
      <div class="modal-header"><div><h2 style="font-size:17px; margin:0;">${days}-day check-in</h2><div style="font-size:12px; color:var(--text-muted);">To: ${esc(lead.contact_email || "— no contact email —")}</div></div><button class="close-btn">✕</button></div>
      <div style="font-size:13px; margin:6px 0;"><strong>Subject:</strong> ${esc(prev.subject)}</div>
      <iframe sandbox="" style="width:100%; height:300px; border:1px solid var(--border,#eee); border-radius:10px; background:#fff;"></iframe>
      <div id="cp-err" style="color:#b91c1c; font-size:12.5px; margin-top:6px;"></div>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="btn" id="cp-send" ${lead.contact_email ? "" : "disabled"}>Send email</button>
        <button class="btn secondary" id="cp-cancel">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(bd);
    bd.querySelector("iframe").srcdoc = prev.html;
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.querySelector("#cp-cancel").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    bd.querySelector("#cp-send").addEventListener("click", async () => {
      const b = bd.querySelector("#cp-send"); b.disabled = true; b.textContent = "Sending…";
      try { await api("/api/leads/" + lead.id + "/checkin/" + days + "/send", { method: "POST" }); close(); if (onSent) onSent(); }
      catch (e) { bd.querySelector("#cp-err").textContent = e.message || "Send failed."; b.disabled = false; b.textContent = "Send email"; }
    });
  }

  // ============================ POLICIES ============================
  async function renderPolicies(mount) {
    let d;
    try { d = await api("/api/policies"); }
    catch (e) { mount.innerHTML = `<div class="page-header"><div><h1>Policies &amp; SOPs</h1></div></div><div class="empty-state">${esc(e.message)}</div>`; return; }
    const publicUrl = location.origin + "/policies";
    const qr = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(publicUrl);
    const COLORS = d.category_colors || {};
    const colorOf = (p) => (p.color && /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : (COLORS[p.category] || "#6b7280"));
    const byCat = {}; d.policies.forEach((p) => { (byCat[p.category || "Other"] = byCat[p.category || "Other"] || []).push(p); });
    const snippet = (p) => {
      const t = p.summary || String(p.body || "").split("\n").filter((l) => l.trim()).slice(1, 3).join(" ");
      return t ? esc(t.slice(0, 130)) + (t.length > 130 ? "…" : "") : "";
    };
    const card = (p) => {
      const c = colorOf(p);
      return `<button class="pol-card" data-pol-open="${p.id}" style="--pc:${c};">
        <span class="pol-stripe"></span>
        <span class="pol-cat">${esc(p.category || "Other")}</span>
        <span class="pol-title">${esc(p.title)}${p.published ? "" : ` <span class="pol-draft">draft</span>`}</span>
        <span class="pol-snip">${snippet(p)}</span>
        <span class="pol-foot">${p.source_file ? "📎 " + esc(p.source_file) : "/policies/" + esc(p.slug)}</span>
      </button>`;
    };
    const list = Object.keys(byCat).sort().map((cat) => `
      <div class="pol-cat-head"><span class="pol-dot" style="background:${COLORS[cat] || "#6b7280"}"></span>${esc(cat)} <span class="pol-count">${byCat[cat].length}</span></div>
      <div class="pol-grid">${byCat[cat].map(card).join("")}</div>`).join("")
      || `<div class="empty-state">No policies yet — upload a PDF or Word doc to make your first card.</div>`;
    mount.innerHTML = `
      <div class="page-header">
        <div><h1>Policies, SOPs &amp; Procedures</h1><p>Staff can scan the QR code to read any policy. Print it and post it around the clinic.</p></div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn" id="pol-upload">⬆ Upload PDF / Word</button>
          <button class="btn secondary" id="pol-add">+ Write one</button>
        </div>
      </div>
      <style>
        .pol-cat-head { display:flex; align-items:center; gap:8px; font-weight:700; font-size:13px; letter-spacing:.02em; text-transform:uppercase; color:var(--text-muted,#6b7280); margin:18px 0 10px; }
        .pol-cat-head:first-child { margin-top:0; }
        .pol-dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
        .pol-count { background:#eef0f5; color:#555; border-radius:999px; padding:1px 8px; font-size:11px; }
        .pol-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(210px,1fr)); gap:12px; }
        .pol-card { position:relative; text-align:left; background:#fff; border:1px solid #e6e8f0; border-radius:14px; padding:14px 14px 12px 18px; cursor:pointer; display:flex; flex-direction:column; gap:6px; font:inherit; transition:transform .12s ease, box-shadow .12s ease; overflow:hidden; }
        .pol-card:hover { transform:translateY(-2px); box-shadow:0 8px 22px rgba(27,42,107,.13); border-color:var(--pc); }
        .pol-stripe { position:absolute; left:0; top:0; bottom:0; width:6px; background:var(--pc); }
        .pol-cat { align-self:flex-start; background:color-mix(in srgb, var(--pc) 14%, #fff); color:var(--pc); border-radius:999px; padding:2px 9px; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; }
        .pol-title { font-weight:650; font-size:14px; color:#1f2430; line-height:1.3; }
        .pol-draft { background:#fdecec; color:#a3282e; border-radius:5px; padding:1px 5px; font-size:10px; font-weight:700; }
        .pol-snip { font-size:12px; color:#6b7280; line-height:1.45; }
        .pol-foot { font-size:11px; color:#9aa0ad; margin-top:auto; word-break:break-all; }
        .pol-read { white-space:pre-wrap; font-size:13.5px; line-height:1.62; color:#2b2f3a; max-height:56vh; overflow:auto; padding-right:6px; }
      </style>
      <div style="display:grid; grid-template-columns: 1.6fr 1fr; gap:20px;">
        <div class="card" style="margin:0;"><div id="pol-upload-status" style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px;"></div>${list}</div>
        <div class="card" style="margin:0; text-align:center;">
          <div class="section-title" style="margin-top:0;">Printable QR code</div>
          <img src="${qr}" alt="Policies QR code" style="width:220px; height:220px; max-width:100%;" />
          <div style="font-size:12px; color:var(--text-muted); margin-top:8px; word-break:break-all;">${esc(publicUrl)}</div>
          <button class="btn small secondary" id="pol-print" style="margin-top:10px;">🖨 Print QR</button>
        </div>
      </div>`;
    mount.querySelector("#pol-add").addEventListener("click", () => policyModal(null, d, mount));
    mount.querySelectorAll("[data-pol-open]").forEach((b) =>
      b.addEventListener("click", () => policyReader(d.policies.find((x) => String(x.id) === b.dataset.polOpen), d, mount, colorOf)));
    mount.querySelector("#pol-upload").addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      inp.multiple = true;
      inp.addEventListener("change", async () => {
        const files = [...inp.files];
        if (!files.length) return;
        const st = mount.querySelector("#pol-upload-status");
        let done = 0; const failed = [];
        for (const f of files) {
          if (st) st.textContent = `Reading ${f.name} (${done + 1} of ${files.length})…`;
          try {
            const b64 = await new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(String(r.result).split(",")[1]);
              r.onerror = () => reject(new Error("Could not read " + f.name));
              r.readAsDataURL(f);
            });
            await api("/api/policies/upload", { method: "POST", body: { filename: f.name, content_base64: b64 } });
            done++;
          } catch (e) { failed.push(`${f.name}: ${e.message}`); }
        }
        await renderPolicies(mount);
        const st2 = mount.querySelector("#pol-upload-status");
        if (st2) st2.textContent = `Made ${done} card${done === 1 ? "" : "s"}.` + (failed.length ? ` Couldn't read: ${failed.join(" · ")}` : "");
      });
      inp.click();
    });
    mount.querySelector("#pol-print").addEventListener("click", () => {
      const w = window.open("", "_blank");
      if (w) { w.document.write(`<html><head><title>Policies QR — Spectrum Squad</title></head><body style="text-align:center;font-family:sans-serif;padding:40px;"><h2>Spectrum Squad — Policies &amp; Procedures</h2><p>Scan to read our policies, SOPs &amp; procedures</p><img src="${qr}" style="width:320px;height:320px;"/><p style="color:#555;">${esc(publicUrl)}</p></body></html>`); w.document.close(); w.focus(); setTimeout(() => w.print(), 400); }
    });
  }

  // Tap a card to read the whole policy without leaving the page.
  function policyReader(pol, d, mount, colorOf) {
    if (!pol) return;
    const c = colorOf(pol);
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    bd.innerHTML = `<div class="modal" style="width:720px; max-width:94vw; border-top:6px solid ${c};">
      <div class="modal-header">
        <h2 style="display:flex; align-items:center; gap:9px;"><span style="width:11px;height:11px;border-radius:50%;background:${c};display:inline-block;"></span>${esc(pol.title)}</h2>
        <button class="close-btn">✕</button>
      </div>
      <div style="font-size:12px; color:var(--text-muted); margin:-6px 0 12px;">
        ${esc(pol.category || "Other")}${pol.source_file ? " · 📎 " + esc(pol.source_file) : ""}${pol.published ? "" : " · draft"}
      </div>
      <div class="pol-read">${esc(pol.body || "")}</div>
      <div style="margin-top:14px; display:flex; gap:8px;">
        <button class="btn secondary" id="pol-r-edit">Edit</button>
        <a class="btn secondary" href="/policies/${esc(pol.slug)}" target="_blank" rel="noopener">Open public page</a>
      </div>
    </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    bd.querySelector("#pol-r-edit").addEventListener("click", () => { close(); policyModal(pol, d, mount); });
  }

  function policyModal(pol, d, mount) {
    pol = pol || {};
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    bd.innerHTML = `<div class="modal" style="width:680px; max-width:94vw;">
      <div class="modal-header"><h2>${pol.id ? "Edit policy" : "Add policy"}</h2><button class="close-btn">✕</button></div>
      <div class="field"><label>Title</label><input data-f="title" value="${esc(pol.title || "")}" /></div>
      <div class="field"><label>Category</label><select data-f="category">${d.categories.map((c) => `<option ${pol.category === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
      <div class="field"><label>Card colour</label>
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="color" data-f="color" value="${esc(pol.color && /^#[0-9a-fA-F]{6}$/.test(pol.color) ? pol.color : ((d.category_colors || {})[pol.category] || "#6b7280"))}" style="width:52px; height:34px; padding:2px;" />
          <span style="font-size:12px; color:var(--text-muted);">Defaults to the category colour — change it to make a card stand out.</span>
        </div>
      </div>
      <div class="field"><label>Body (the policy text)</label><textarea data-f="body" rows="12" style="width:100%; font-family:inherit;">${esc(pol.body || "")}</textarea></div>
      <label style="display:flex; gap:8px; align-items:center; font-size:13px; margin-top:6px;"><input type="checkbox" data-f="published" ${pol.published === false ? "" : "checked"} /> Published (visible on the public QR page)</label>
      <div style="margin-top:14px; display:flex; gap:8px;">
        <button class="btn" id="pol-save">${pol.id ? "Save" : "Add"}</button>
        ${pol.id ? `<button class="btn secondary" id="pol-del" style="color:#b91c1c;">Delete</button>` : ""}
        <span id="pol-status" style="font-size:12.5px; color:var(--text-muted); align-self:center;"></span>
      </div>
    </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    bd.querySelector("#pol-save").addEventListener("click", async () => {
      const body = {
        title: bd.querySelector('[data-f="title"]').value.trim(),
        category: bd.querySelector('[data-f="category"]').value,
        body: bd.querySelector('[data-f="body"]').value,
        color: bd.querySelector('[data-f="color"]').value,
        published: bd.querySelector('[data-f="published"]').checked,
      };
      if (!body.title) { bd.querySelector("#pol-status").textContent = "Title is required."; return; }
      try {
        if (pol.id) await api("/api/policies/" + pol.id, { method: "PATCH", body });
        else await api("/api/policies", { method: "POST", body });
        close(); renderPolicies(mount);
      } catch (e) { bd.querySelector("#pol-status").textContent = e.message || "Failed."; }
    });
    const del = bd.querySelector("#pol-del");
    if (del) del.addEventListener("click", async () => { if (!confirm("Delete this policy?")) return; try { await api("/api/policies/" + pol.id, { method: "DELETE" }); close(); renderPolicies(mount); } catch (e) { alert(e.message); } });
  }

  window.__renderLeads = function (mount) { return renderLeads(mount); };
  window.__renderPolicies = function (mount) { return renderPolicies(mount); };
})();
