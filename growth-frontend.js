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
    if (c.type === "month_to_month") return `<div style="padding:10px 12px; border-radius:10px; background:#e0f2fe; color:#075985; font-weight:700; font-size:13px;">Month-to-month — no fixed expiration. Renews automatically until either side gives ${lead.notice_period_days || "the agreed"} days' notice.</div>`;
    if (c.type === "fixed_term" && c.expiresOn) {
      const bg = c.expired ? "#fee2e2" : (c.expiringSoon ? "#fef3c7" : "#dcfce7");
      const fg = c.expired ? "#a3282e" : (c.expiringSoon ? "#946213" : "#166534");
      const label = c.expired ? `Expired ${Math.abs(c.daysRemaining)} day(s) ago` : `${c.daysRemaining} day(s) remaining`;
      return `<div style="padding:10px 12px; border-radius:10px; background:${bg}; color:${fg}; font-weight:700; font-size:13px;">Fixed-term contract ends ${esc(c.expiresOn)} — ${label}.${lead.renewal_date ? " Renewal date: " + esc(lead.renewal_date) + "." : ""}</div>`;
    }
    return "";
  }
  function eventIcon(t) { return { note: "▤", checkin: "◇", contract: "▣", alert: "⚠", task: "✓", stage: "→" }[t] || "•"; }

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
        <button class="btn small secondary" data-checkin="7">1-week</button>
        <button class="btn small secondary" data-checkin="30">30-day</button>
        <button class="btn small secondary" data-checkin="60">60-day</button>
        <button class="btn small secondary" data-checkin="90">90-day</button>
        <span id="checkin-status" style="font-size:12px; color:var(--text-muted);"></span>
      </div>
      <div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">The 7/30/60/90 automation also drops a reminder task on the assigned team member. Templates are editable under Email Templates.</div>

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
      ? `<span class="tag" style="background:#fee2e2;color:#a3282e;">⚠ Payment failed</span>`
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
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">Card and bank details are entered on Stripe's secure pages — this CRM only ever stores safe identifiers (brand, last 4, status), never full card or account numbers.</div>
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
  // Library filters. Module-level so they survive a re-render after an edit or
  // an acknowledgment, rather than snapping back to "everything".
  let polQ = "", polCat = "", polStatus = "";
  // The question and its answers survive a re-render too -- acknowledging a
  // policy you were pointed at should not throw away what you asked.
  let polAsk = "", polAnswers = null, polAsking = false, polAskErr = "";

  // Highlights the words the search actually matched. Stems are matched as
  // PREFIXES because that is how they were produced: the question's "days"
  // became "day", and the passage says "days".
  function markTerms(text, terms) {
    let html = esc(text);
    (terms || []).forEach((t) => {
      const safe = String(t).replace(/[^a-z0-9]/gi, "");
      if (safe.length < 2) return;
      html = html.replace(new RegExp("\\b(" + safe + "[a-z]*)\\b", "gi"), "<mark>$1</mark>");
    });
    return html;
  }

  const AMEND_CSS = `
    .pol-memo { background:#fff8e8; border:1px solid #e6c98a; border-left:5px solid #e0a430; border-radius:10px; padding:12px 14px; margin-bottom:12px; }
    .pol-memo.scheduled { background:#f3f6ff; border-color:#c3cdf0; border-left-color:#3f56b5; }
    .pol-memo.draft { background:#f7f7f9; border-color:#dfe1e8; border-left-color:#9aa0ad; }
    .pol-memo.rescinded { background:#fafafa; border-color:#e5e7eb; border-left-color:#cbd0d8; color:#6b7280; }
    .pol-memo-h { font-size:10.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#8a6516; margin-bottom:4px; }
    .pol-memo.scheduled .pol-memo-h { color:#3f56b5; }
    .pol-memo.draft .pol-memo-h, .pol-memo.rescinded .pol-memo-h { color:#6b7280; }
    .pol-memo-t { font-weight:700; color:#1f2430; margin-bottom:5px; font-size:13.5px; }
    .pol-memo-b { white-space:pre-wrap; font-size:13px; line-height:1.6; color:#2b2f3a; }
    .pol-memo-f { font-size:11.5px; color:#6b7280; margin-top:8px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .pol-orig-h { font-size:10.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#9aa0ad; border-top:1px solid #eceef3; padding-top:10px; margin:14px 0 8px; }
    .pol-ans { border:1px solid #e6e8f0; border-left:5px solid var(--pc,#3f56b5); border-radius:12px; padding:14px 16px; margin-bottom:12px; background:#fff; }
    .pol-ans-t { font-weight:700; font-size:15px; color:#1f2430; }
    .pol-ans-q { white-space:pre-wrap; font-size:13.5px; line-height:1.62; color:#2b2f3a; margin:9px 0 0; }
    .pol-ans-q mark { background:#fdf0c8; color:inherit; border-radius:3px; padding:0 1px; }
    .pol-ans-src { font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:#8a6516; margin-top:10px; }
    .pol-ans-also { margin-top:10px; border-top:1px dashed #e6e8f0; padding-top:9px; }
    .pol-ans-also summary { cursor:pointer; font-size:12px; color:#3f56b5; }
  `;

  async function renderPolicies(mount) {
    let d;
    const qs = new URLSearchParams();
    if (polQ) qs.set("q", polQ);
    if (polCat) qs.set("category", polCat);
    if (polStatus) qs.set("status", polStatus);
    try { d = await api("/api/policies/library" + (qs.toString() ? "?" + qs.toString() : "")); }
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
    const STATUS_STYLE = {
      Active: "background:#dcfce7; color:#166534;",
      Draft: "background:#fef3c7; color:#92400e;",
      Archived: "background:#e5e7eb; color:#4b5563;",
    };
    const card = (p) => {
      const c = colorOf(p);
      const st = p.status || "Active";
      // Acknowledgment state is per VERSION, so a policy re-issued since you
      // last signed reads as outstanding again rather than quietly done.
      const ack = !p.requires_acknowledgment ? ""
        : p.my_acknowledgment
          ? `<span class="pol-badge" style="background:#dcfce7; color:#166534;">✓ acknowledged v${esc(p.my_acknowledgment.version)}</span>`
          : `<span class="pol-badge" style="background:#fee2e2; color:#991b1b;">acknowledgment needed</span>`;
      return `<button class="pol-card" data-pol-open="${p.id}" style="--pc:${c};">
        <span class="pol-stripe"></span>
        <span class="pol-cat">${esc(p.category || "Other")}</span>
        <span class="pol-title">${esc(p.title)}</span>
        <span class="pol-badges">
          <span class="pol-badge" style="${STATUS_STYLE[st] || STATUS_STYLE.Archived}">${esc(st)}</span>
          <span class="pol-badge" style="background:#eef0f5; color:#4b5563;">v${esc(p.version || "1")}</span>
          ${(p.amendments_in_force || []).length
            ? `<span class="pol-badge" style="background:#fdf0c8; color:#8a6516;">amended ×${(p.amendments_in_force || []).length}</span>` : ""}
          ${(p.amendments_scheduled || []).length
            ? `<span class="pol-badge" style="background:#e9eefc; color:#3f56b5;">change scheduled</span>` : ""}
          ${ack}
        </span>
        <span class="pol-snip">${snippet(p)}</span>
        <span class="pol-foot">${p.document ? "" + esc(p.document.title) : "/policies/" + esc(p.slug)}${
          p.effective_date ? " · eff. " + esc(String(p.effective_date).slice(0, 10)) : ""}</span>
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
          ${d.can_manage ? `<button class="btn" id="pol-doc-upload">⇧ Upload source document</button>
          <button class="btn secondary" id="pol-add">+ Write one</button>
          <button class="btn secondary" id="pol-import">Import policies</button>
          <button class="btn secondary" id="pol-acks">Acknowledgments</button>` : ""}
        </div>
      </div>
      <div class="card" style="margin:0 0 16px; padding:16px 18px;">
        <div style="font-weight:700; font-size:14px; margin-bottom:3px;">Ask a question</div>
        <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:10px;">
          Ask in your own words — &ldquo;how long do BCBAs have to finish a treatment plan?&rdquo; — and it points
          you at the policy and the paragraph that answers it. It quotes the policy; it never writes one.
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <input id="pol-ask" placeholder="What do you want to know?" value="${esc(polAsk)}"
            style="flex:1; min-width:220px; padding:10px 12px; border:1px solid var(--border,#e5e7eb); border-radius:8px; font-size:14px;" />
          <button class="btn" id="pol-ask-go"${polAsking ? " disabled" : ""}>${polAsking ? "Looking…" : "Ask"}</button>
          ${polAsk || polAnswers ? `<button class="btn secondary" id="pol-ask-clear">Clear</button>` : ""}
        </div>
        <div id="pol-ask-out" style="margin-top:14px;">${askResultsHTML(COLORS)}</div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:14px;">
        <input id="pol-q" placeholder="Search policies by keyword…" value="${esc(polQ)}"
          style="flex:1; min-width:200px; padding:8px 11px; border:1px solid var(--border,#e5e7eb); border-radius:8px; font-size:13px;" />
        <select id="pol-cat" style="padding:8px 10px; border:1px solid var(--border,#e5e7eb); border-radius:8px; font-size:13px;">
          <option value="">All categories</option>
          ${(d.categories || []).map((c) => `<option value="${esc(c)}"${c === polCat ? " selected" : ""}>${esc(c)}</option>`).join("")}
        </select>
        <select id="pol-status" style="padding:8px 10px; border:1px solid var(--border,#e5e7eb); border-radius:8px; font-size:13px;">
          <option value="">All statuses</option>
          ${(d.statuses || []).map((s) => `<option value="${esc(s)}"${s === polStatus ? " selected" : ""}>${esc(s)}</option>`).join("")}
        </select>
        ${polQ || polCat || polStatus ? `<button class="btn small secondary" id="pol-clear">Clear</button>` : ""}
        <span style="font-size:12px; color:var(--text-muted);">${d.policies.length} of ${d.total}</span>
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
        .pol-badges { display:flex; flex-wrap:wrap; gap:4px; }
        .pol-badge { border-radius:5px; padding:1px 6px; font-size:10px; font-weight:700; }
        ${AMEND_CSS}
      </style>
      <div style="display:grid; grid-template-columns: 1.6fr 1fr; gap:20px;">
        <div class="card" style="margin:0;"><div id="pol-upload-status" style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px;"></div>${list}</div>
        <div class="card" style="margin:0; text-align:center;">
          <div class="section-title" style="margin-top:0;">Printable QR code</div>
          <img src="${qr}" alt="Policies QR code" style="width:220px; height:220px; max-width:100%;" />
          <div style="font-size:12px; color:var(--text-muted); margin-top:8px; word-break:break-all;">${esc(publicUrl)}</div>
          <button class="btn small secondary" id="pol-print" style="margin-top:10px;">Print QR</button>
        </div>
      </div>`;
    const on = (sel, ev, fn) => { const el = mount.querySelector(sel); if (el) el.addEventListener(ev, fn); };

    // ---- library filters ----
    let qTimer = null;
    on("#pol-q", "input", (e) => {
      clearTimeout(qTimer);
      const v = e.target.value;
      qTimer = setTimeout(() => { polQ = v; renderPolicies(mount); }, 250);
    });
    // ---- ask ----
    const runAsk = async () => {
      const inp = mount.querySelector("#pol-ask");
      polAsk = inp ? inp.value.trim() : polAsk;
      if (!polAsk) { polAnswers = null; polAskErr = ""; await renderPolicies(mount); return; }
      polAsking = true; polAskErr = "";
      await renderPolicies(mount);
      try { polAnswers = await api("/api/policies/ask?q=" + encodeURIComponent(polAsk)); }
      catch (e) { polAnswers = null; polAskErr = e.message || "Could not search the policies."; }
      polAsking = false;
      await renderPolicies(mount);
      const again = mount.querySelector("#pol-ask");
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    };
    on("#pol-ask-go", "click", runAsk);
    on("#pol-ask", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runAsk(); } });
    on("#pol-ask-clear", "click", async () => { polAsk = ""; polAnswers = null; polAskErr = ""; await renderPolicies(mount); });
    mount.querySelectorAll("[data-ans-open]").forEach((b) =>
      b.addEventListener("click", () => {
        const pol = d.policies.find((x) => String(x.id) === b.dataset.ansOpen);
        if (pol) policyReader(pol, d, mount, colorOf);
        // A policy filtered out of the library by the category or status
        // dropdown is still a valid answer to a question -- it is simply not on
        // screen, so the reader is opened from the answer's own copy instead of
        // silently doing nothing.
        else {
          const a = (polAnswers && polAnswers.answers || []).find((x) => String(x.policy.id) === b.dataset.ansOpen);
          if (a) policyReader({ ...a.policy, amendments_in_force: a.amendments_in_force,
            amendments_scheduled: a.amendments_scheduled }, d, mount, colorOf);
        }
      }));

    on("#pol-cat", "change", (e) => { polCat = e.target.value; renderPolicies(mount); });
    on("#pol-status", "change", (e) => { polStatus = e.target.value; renderPolicies(mount); });
    on("#pol-clear", "click", () => { polQ = polCat = polStatus = ""; renderPolicies(mount); });
    on("#pol-acks", "click", () => ackReport(mount));
    on("#pol-import", "click", () => importModal(d, mount));

    on("#pol-add", "click", () => policyModal(null, d, mount));
    mount.querySelectorAll("[data-pol-open]").forEach((b) =>
      b.addEventListener("click", () => policyReader(d.policies.find((x) => String(x.id) === b.dataset.polOpen), d, mount, colorOf)));
    on("#pol-doc-upload", "click", () => {
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
            // Uploads a SOURCE DOCUMENT, not a policy. The handbook lands once
            // and policy records are created against it afterwards; the text is
            // stored verbatim and nothing is extracted or rewritten.
            await api("/api/policies/documents", {
              method: "POST",
              body: {
                filename: f.name, content_base64: b64,
                doc_type: /handbook/i.test(f.name) ? "Employee Handbook" : "Policy Document",
              },
            });
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

  // The answer panel. Every answer is a POINTER -- the policy, and the
  // paragraph of it that matched -- with the words that matched highlighted so
  // it is obvious why this came back. Nothing here is written by the CRM: the
  // quoted text is verbatim from the policy or from a memo.
  function askResultsHTML(COLORS) {
    if (polAsking) return `<div style="font-size:13px; color:var(--text-muted);">Reading the policies…</div>`;
    if (polAskErr) return `<div class="empty-state" style="margin:0;">${esc(polAskErr)}</div>`;
    if (!polAnswers) return "";
    const a = polAnswers;
    if (!a.answers || !a.answers.length) {
      return `<div class="empty-state" style="margin:0;">
        <strong>Nothing in the policy library answers that.</strong>
        <div style="font-size:12.5px; margin-top:6px;">
          ${a.note ? esc(a.note) : `Searched ${a.searched.passages} passage(s) across ${a.searched.policies} active
          ${a.searched.policies === 1 ? "policy" : "policies"}${a.searched.not_active
            ? ` (${a.searched.not_active} draft or archived ${a.searched.not_active === 1 ? "policy was" : "policies were"} not searched — a draft is not the rule)`
            : ""}.`}
        </div>
        <div style="font-size:12.5px; margin-top:6px; color:var(--text-muted);">
          That means no policy on file covers it, not that the answer is no. Ask whoever owns the area.
        </div>
      </div>`;
    }
    const memoLine = (m) => `<div class="pol-memo" style="margin-bottom:8px;">
      <div class="pol-memo-h">Amended${m.effective_date ? " &middot; effective " + esc(String(m.effective_date).slice(0, 10)) : ""}</div>
      <div class="pol-memo-t">${esc(m.title)}</div>
      <div class="pol-memo-b">${esc(m.body)}</div>
    </div>`;
    return a.answers.map((ans) => {
      const p = ans.policy;
      const c = (p.color && /^#[0-9a-fA-F]{6}$/.test(p.color)) ? p.color : ((COLORS || {})[p.category] || "#3f56b5");
      const fromMemo = ans.passage.source === "amendment";
      return `<div class="pol-ans" style="--pc:${c};">
        <div style="display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap;">
          <div style="flex:1; min-width:180px;">
            <div class="pol-ans-t">${esc(p.title)}</div>
            <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">
              ${esc(p.category || "Other")} &middot; v${esc(p.version || "1")}${
                p.document ? " &middot; " + esc(p.document.title) : ""}${
                p.section_ref ? " &middot; " + esc(p.section_ref) : ""}
            </div>
          </div>
          <button class="btn small secondary" data-ans-open="${p.id}">Open policy</button>
        </div>
        ${ans.amended ? `<div style="margin-top:8px;"><span class="pol-badge" style="background:#fdf0c8; color:#8a6516;">This policy has been amended</span></div>` : ""}
        ${fromMemo ? `<div class="pol-ans-src">From an amendment memo${
          ans.passage.effective_date ? " &middot; effective " + esc(String(ans.passage.effective_date).slice(0, 10)) : ""}</div>` : ""}
        <div class="pol-ans-q">${markTerms(ans.passage.text, ans.matched)}</div>
        ${ans.also ? `<details class="pol-ans-also"><summary>${
          ans.also.source === "amendment" ? "There is a memo on this too" : "What the original policy text says"
        }</summary><div class="pol-ans-q">${markTerms(ans.also.text, ans.matched)}</div></details>` : ""}
        ${!fromMemo && ans.amended ? `<div style="margin-top:10px;">
          <div class="pol-ans-src">The memo(s) that changed this policy</div>
          <div style="margin-top:6px;">${ans.amendments_in_force.map(memoLine).join("")}</div>
        </div>` : ""}
        ${(ans.amendments_scheduled || []).length ? `<div style="margin-top:8px; font-size:12px; color:#3f56b5;">
          A change to this policy takes effect ${esc(String(ans.amendments_scheduled[0].effective_date || "").slice(0, 10))}: ${esc(ans.amendments_scheduled[0].title)}
        </div>` : ""}
      </div>`;
    }).join("") + `<div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">
      ${a.answers.length} ${a.answers.length === 1 ? "policy" : "policies"} matched
      &ldquo;${esc(a.question)}&rdquo; out of ${a.searched.policies} searched. Passages are quoted from the policy, unedited.
    </div>`;
  }

  // ---------------------------- AMENDMENT MEMOS ----------------------------
  // What is in force goes ABOVE the original text, and the original is labelled
  // as what it is. Somebody reading top to bottom reads the current rule first;
  // somebody who stops reading half way has still read the current rule. Any
  // other order asks a person to notice a correction after they have already
  // acted on the thing it corrects.
  function memoBlocks(pol) {
    const inForce = pol.amendments_in_force || [];
    const scheduled = pol.amendments_scheduled || [];
    if (!inForce.length && !scheduled.length) return "";
    const memo = (m, cls, head) => `<div class="pol-memo ${cls}">
      <div class="pol-memo-h">${head}</div>
      <div class="pol-memo-t">${esc(m.title)}</div>
      <div class="pol-memo-b">${esc(m.body)}</div>
      <div class="pol-memo-f">${m.created_by ? "Issued by " + esc(m.created_by) : ""}${
        m.issued_at ? " &middot; " + esc(new Date(m.issued_at).toLocaleDateString()) : ""}${
        m.policy_version ? " &middot; amends v" + esc(m.policy_version) : ""}</div>
    </div>`;
    return inForce.map((m) => memo(m, "", "In force" + (m.effective_date ? " &middot; since " + esc(String(m.effective_date).slice(0, 10)) : ""))).join("")
      + scheduled.map((m) => memo(m, "scheduled", "Takes effect " + esc(String(m.effective_date || "").slice(0, 10)) + " &middot; not the rule yet")).join("")
      + (inForce.length
        ? `<div class="pol-orig-h">Original policy text — the amendment${inForce.length > 1 ? "s" : ""} above take${inForce.length > 1 ? "" : "s"} precedence</div>`
        : "");
  }

  // The manager's view of the same thing: drafts nobody else can see, and the
  // memos that no longer apply. Rescinded ones are listed rather than hidden --
  // "what did this policy used to say, and who changed it" is the question this
  // whole feature exists to be able to answer.
  function memoAdmin(pol) {
    const drafts = pol.amendments_drafts || [];
    const gone = pol.amendments_rescinded || [];
    if (!drafts.length && !gone.length && !(pol.amendments_in_force || []).length && !(pol.amendments_scheduled || []).length) return "";
    const row = (m, cls, head, actions) => `<div class="pol-memo ${cls}">
      <div class="pol-memo-h">${head}</div>
      <div class="pol-memo-t">${esc(m.title)}</div>
      <div class="pol-memo-f">${m.created_by ? "By " + esc(m.created_by) : ""}${
        m.rescinded_at ? " &middot; withdrawn " + esc(String(m.rescinded_at).slice(0, 10)) + (m.rescinded_by ? " by " + esc(m.rescinded_by) : "") : ""}${
        m.rescind_reason ? " &middot; " + esc(m.rescind_reason) : ""}
        ${actions}</div>
    </div>`;
    const live = [...(pol.amendments_in_force || []), ...(pol.amendments_scheduled || [])];
    return `<details style="margin-top:16px;" ${drafts.length ? "open" : ""}>
      <summary style="cursor:pointer; font-size:12.5px; font-weight:700; color:var(--text-muted);">
        Amendment memos (${live.length} in force or scheduled${drafts.length ? `, ${drafts.length} draft` : ""}${gone.length ? `, ${gone.length} rescinded` : ""})
      </summary>
      <div style="margin-top:10px;">
        ${live.map((m) => row(m, "", m.in_force ? "In force" : "Scheduled",
          `<button class="btn small secondary" data-amend-edit="${m.id}">Edit</button>
           <button class="btn small secondary" data-amend-rescind="${m.id}">Rescind</button>`)).join("")}
        ${drafts.map((m) => row(m, "draft", "Draft — not issued, and not visible to staff",
          `<button class="btn small secondary" data-amend-edit="${m.id}">Edit</button>`)).join("")}
        ${gone.map((m) => row(m, "rescinded", "Rescinded — kept as the record of what changed and when", "")).join("")}
      </div>
    </details>`;
  }

  // Writing one. The form is short on purpose: what is changing, when it starts,
  // and whether it is issued yet. A memo that needs a page of fields is a policy
  // rewrite wearing a memo's clothes.
  function amendmentModal(pol, existing, mount) {
    const a = existing || { title: "", body: "", effective_date: "", status: "Active" };
    const editing = !!(existing && existing.id);
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    bd.innerHTML = `<div class="modal" style="width:640px; max-width:94vw;">
      <div class="modal-header">
        <h2>${editing ? "Edit amendment memo" : "Amendment memo"}</h2>
        <button class="close-btn">✕</button>
      </div>
      <div style="font-size:12.5px; color:var(--text-muted); margin:-6px 0 14px;">
        Amends <strong>${esc(pol.title)}</strong> (currently v${esc(pol.version || "1")}). The policy's own wording is not
        changed — this memo sits on top of it, dated and attributed, and the original stays exactly as approved.
      </div>
      <div class="field" style="margin-bottom:10px;">
        <label>What is changing</label>
        <input id="am-title" value="${esc(a.title)}" maxlength="200"
          placeholder="e.g. Treatment plan turnaround extended to 14 days" style="width:100%;" />
      </div>
      <div class="field" style="margin-bottom:10px;">
        <label>The memo</label>
        <textarea id="am-body" rows="8" style="width:100%; font-family:inherit;"
          placeholder="State the change plainly, and what it replaces. e.g. Effective immediately, BCBAs have 14 calendar days to complete a treatment plan following the assessment. This replaces the 7-day turnaround in section 3.">${esc(a.body)}</textarea>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div class="field">
          <label>Effective date</label>
          <input id="am-date" type="date" value="${esc(String(a.effective_date || "").slice(0, 10))}" style="width:100%;" />
          <div style="font-size:11.5px; color:var(--text-muted); margin-top:3px;">Leave blank to apply as soon as it is issued.</div>
        </div>
        <div class="field">
          <label>Status</label>
          <select id="am-status" style="width:100%;">
            <option value="Active"${a.status !== "Draft" ? " selected" : ""}>Issue it now</option>
            <option value="Draft"${a.status === "Draft" ? " selected" : ""}>Keep as a draft</option>
          </select>
        </div>
      </div>
      <div id="am-note" style="margin-top:12px; font-size:12.5px; background:#fff8e8; border:1px solid #e6c98a; border-radius:9px; padding:10px 12px; color:#8a6516;"></div>
      <div id="am-err" style="color:#b91c1c; font-size:12.5px; margin-top:10px;"></div>
      <div style="margin-top:14px; display:flex; gap:8px;">
        <button class="btn" id="am-save">${editing ? "Save memo" : "Add memo to this policy"}</button>
        <button class="btn secondary" id="am-cancel">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.querySelector("#am-cancel").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });

    // Says what is about to happen before it happens. Re-issuing a policy that
    // asks for a signature means everybody signs again, and finding that out
    // afterwards is how a feature gets a reputation.
    const note = bd.querySelector("#am-note");
    const paint = () => {
      const issuing = bd.querySelector("#am-status").value === "Active";
      note.style.display = issuing ? "" : "none";
      if (!issuing) return;
      note.innerHTML = `Issuing this memo re-issues <strong>${esc(pol.title)}</strong> as a new version.`
        + (pol.requires_acknowledgment
          ? " Because this policy requires acknowledgment, <strong>everyone will be asked to acknowledge it again</strong> — the signatures already given stay on file against the version they were given for."
          : " Acknowledgments already on file are untouched.");
    };
    bd.querySelector("#am-status").addEventListener("change", paint);
    paint();

    bd.querySelector("#am-save").addEventListener("click", async () => {
      const btn = bd.querySelector("#am-save");
      const err = bd.querySelector("#am-err");
      const body = {
        title: bd.querySelector("#am-title").value.trim(),
        body: bd.querySelector("#am-body").value.trim(),
        effective_date: bd.querySelector("#am-date").value || null,
        status: bd.querySelector("#am-status").value,
      };
      if (!body.title) { err.textContent = "Say what is changing."; return; }
      if (!body.body) { err.textContent = "A memo needs to say what the change is."; return; }
      err.textContent = "";
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        const r = editing
          ? await api("/api/policies/amendments/" + existing.id, { method: "PATCH", body })
          : await api("/api/policies/" + pol.id + "/amendments", { method: "POST", body });
        close();
        await renderPolicies(mount);
        if (r.reissued_as) {
          alert(`Memo added. "${pol.title}" is now version ${r.reissued_as}.`
            + (r.resets_acknowledgments ? "\n\nEveryone will be asked to acknowledge the new version. The acknowledgments already given are kept against the version they were given for." : ""));
        }
      } catch (e2) { err.textContent = e2.message || "Could not save that."; btn.disabled = false; btn.textContent = editing ? "Save memo" : "Add memo to this policy"; }
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
        ${esc(pol.category || "Other")} · ${esc(pol.status || "Active")} · v${esc(pol.version || "1")}${
          pol.effective_date ? " · effective " + esc(String(pol.effective_date).slice(0, 10)) : ""}${
          pol.updated_at ? " · updated " + esc(new Date(pol.updated_at).toLocaleDateString()) : ""}
        ${pol.document ? `<div style="margin-top:3px;">From <strong>${esc(pol.document.title)}</strong>${pol.section_ref ? " · " + esc(pol.section_ref) : ""}</div>` : ""}
      </div>
      ${memoBlocks(pol)}
      <div class="pol-read">${esc(pol.body || "")}</div>
      ${pol.requires_acknowledgment ? `<div id="pol-ack-box" style="margin-top:14px; padding:11px 13px; border-radius:9px; ${
        pol.my_acknowledgment
          ? `background:#ecfdf5; border:1px solid #a7f3d0; color:#065f46;`
          : `background:#fff4dd; border:1px solid #f1d9a0; color:#a56b00;`}">
        ${pol.my_acknowledgment
          ? `✓ You acknowledged version ${esc(pol.my_acknowledgment.version)} on ${esc(new Date(pol.my_acknowledgment.acknowledged_at).toLocaleString())}.`
          : `<div style="margin-bottom:8px;">This policy requires your acknowledgment${pol.version ? ` (version ${esc(pol.version)})` : ""}.</div>
             <button class="btn small" id="pol-ack-btn">I have read and acknowledge this policy</button>`}
      </div>` : ""}
      ${d.can_manage ? memoAdmin(pol) : ""}
      <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">
        ${d.can_manage ? `<button class="btn" id="pol-r-amend">+ Amendment memo</button>` : ""}
        ${d.can_manage ? `<button class="btn secondary" id="pol-r-edit">Edit</button>` : ""}
        ${pol.document ? `<button class="btn secondary" id="pol-r-doc">View full source document</button>` : ""}
        <a class="btn secondary" href="/policies/${esc(pol.slug)}" target="_blank" rel="noopener">Open public page</a>
      </div>
    </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    const rOn = (sel, fn) => { const el = bd.querySelector(sel); if (el) el.addEventListener("click", fn); };
    rOn("#pol-r-edit", () => { close(); policyModal(pol, d, mount); });
    rOn("#pol-r-amend", () => { close(); amendmentModal(pol, null, mount); });
    bd.querySelectorAll("[data-amend-edit]").forEach((b) => b.addEventListener("click", () => {
      const all = [...(pol.amendments_in_force || []), ...(pol.amendments_scheduled || []), ...(pol.amendments_drafts || [])];
      const a = all.find((x) => String(x.id) === b.dataset.amendEdit);
      if (a) { close(); amendmentModal(pol, a, mount); }
    }));
    bd.querySelectorAll("[data-amend-rescind]").forEach((b) => b.addEventListener("click", async () => {
      const reason = prompt("Why is this memo being withdrawn? (Optional — it stays in the policy's history either way.)");
      if (reason === null) return;
      b.disabled = true; b.textContent = "Rescinding…";
      try {
        const r = await api("/api/policies/amendments/" + b.dataset.amendRescind + "/rescind", { method: "POST", body: { reason } });
        close();
        await renderPolicies(mount);
        if (r.reissued_as) alert("Memo rescinded. The policy is now version " + r.reissued_as + ".");
      } catch (err) { alert(err.message); b.disabled = false; b.textContent = "Rescind"; }
    }));

    // Acknowledgment is recorded against the version being read, so a later
    // re-issue asks again rather than counting this one.
    rOn("#pol-ack-btn", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = "Recording…";
      try {
        await api("/api/policies/" + pol.id + "/acknowledge", { method: "POST", body: {} });
        close();
        await renderPolicies(mount);
      } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = "I have read and acknowledge this policy"; }
    });

    rOn("#pol-r-doc", async () => {
      try {
        const doc = await api("/api/policies/documents/" + pol.document.id);
        const b2 = document.createElement("div"); b2.className = "modal-backdrop";
        b2.innerHTML = `<div class="modal" style="width:820px; max-width:94vw;">
          <div class="modal-header"><h2>${esc(doc.document.title)}</h2><button class="close-btn">✕</button></div>
          <div style="font-size:12px; color:var(--text-muted); margin:-6px 0 12px;">
            ${esc(doc.document.doc_type || "")}${doc.document.filename ? " · " + esc(doc.document.filename) : ""}
            · ${doc.policies.length} policy record(s) reference this document
          </div>
          <div class="pol-read">${esc(doc.document.body || "")}</div>
        </div>`;
        document.body.appendChild(b2);
        b2.querySelector(".close-btn").addEventListener("click", () => b2.remove());
        b2.addEventListener("click", (ev) => { if (ev.target === b2) b2.remove(); });
      } catch (err) { alert(err.message); }
    });
  }

  // Create many policy records against one uploaded source document.
  //
  // Two ways in. "Detect sections" asks the server where the document appears
  // to divide -- fine for a numbered SOP. "Paste an import map" takes a
  // reviewed list of boundaries, which is what a handbook needs: title-case
  // prose defeats automatic detection badly enough that it mistitles sections
  // and lets one swallow the next.
  //
  // Either way the policy TEXT is whatever the map carries -- verbatim from the
  // document. Nothing here rewrites, summarises or shortens it.
  function importModal(d, mount) {
    const docs = d.documents || [];
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    bd.innerHTML = `<div class="modal" style="width:760px; max-width:95vw;">
      <div class="modal-header"><h2>Import policies from a document</h2><button class="close-btn">✕</button></div>
      ${docs.length ? `
        <div class="field"><label>Source document</label><select id="imp-doc">
          ${docs.map((x) => `<option value="${x.id}">${esc(x.title)}${x.doc_type ? " — " + esc(x.doc_type) : ""}</option>`).join("")}
        </select></div>
        <div style="display:flex; gap:8px; margin:10px 0;">
          <button class="btn small secondary" id="imp-detect">Detect sections automatically</button>
          <span style="font-size:12px; color:var(--text-muted); align-self:center;">or paste a reviewed import map below</span>
        </div>
        <div class="field"><label>Import map (JSON)</label>
          <textarea id="imp-json" rows="10" placeholder='{"sections":[{"title":"Overtime Policy","category":"Payroll &amp; Compensation","body":"..."}]}'
            style="width:100%; font-family:ui-monospace,Menlo,monospace; font-size:11.5px;"></textarea></div>
        <div id="imp-note" style="font-size:12px; color:var(--text-muted); margin-bottom:8px;"></div>
        <div style="margin-top:6px; display:flex; gap:8px; align-items:center;">
          <button class="btn" id="imp-go">Import</button>
          <span id="imp-status" style="font-size:12.5px; color:var(--text-muted);"></span>
        </div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:8px;">
          Imported policies are created Active, version 1, with no acknowledgment required.
          Re-importing the same document will not duplicate a policy that is already there.</div>`
        : `<div class="empty-state">Upload a source document first.</div>`}
    </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    if (!docs.length) return;

    const note = bd.querySelector("#imp-note");
    const status = bd.querySelector("#imp-status");

    bd.querySelector("#imp-detect").addEventListener("click", async () => {
      const id = bd.querySelector("#imp-doc").value;
      note.textContent = "Reading document…";
      try {
        const r = await api("/api/policies/documents/" + id + "/sections");
        bd.querySelector("#imp-json").value = JSON.stringify({ sections: r.sections.map((s) => ({
          title: s.title, category: "Other", section_ref: s.section_ref || null, body: s.body,
        })) }, null, 1);
        note.textContent = `${r.sections.length} section(s) detected. Review the titles and set a category on each before importing — automatic detection is a starting point, not an answer.`;
      } catch (e) { note.textContent = e.message; }
    });

    bd.querySelector("#imp-go").addEventListener("click", async () => {
      const id = bd.querySelector("#imp-doc").value;
      let payload;
      try { payload = JSON.parse(bd.querySelector("#imp-json").value); }
      catch (e) { status.textContent = "That isn't valid JSON."; return; }
      const sections = payload && Array.isArray(payload.sections) ? payload.sections : null;
      if (!sections || !sections.length) { status.textContent = "No sections found in that map."; return; }
      if (!confirm(`Create ${sections.length} policy record(s) from this document?`)) return;
      status.textContent = `Importing ${sections.length}…`;
      try {
        const r = await api("/api/policies/documents/" + id + "/import", { method: "POST", body: { sections } });
        close();
        await renderPolicies(mount);
        const skipped = (r.skipped || []).length;
        alert(`Imported ${r.created} policy record(s).` + (skipped ? `\n${skipped} skipped:\n` + r.skipped.map((s) => `• ${s.title} — ${s.reason}`).join("\n") : ""));
      } catch (e) { status.textContent = e.message; }
    });
  }

  // Admin: who has acknowledged what, per policy version.
  async function ackReport(mount) {
    let d;
    try { d = await api("/api/policies/acknowledgments"); }
    catch (e) { alert(e.message); return; }
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    const chip = (n, style) => `<span class="pol-badge" style="${style}">${n}</span>`;
    bd.innerHTML = `<div class="modal" style="width:860px; max-width:95vw;">
      <div class="modal-header"><h2>Policy acknowledgments</h2><button class="close-btn">✕</button></div>
      <div style="font-size:12px; color:var(--text-muted); margin:-6px 0 12px;">
        Counted against each policy's current version. Anything outstanding for more than
        ${d.overdue_after_days} days reads as overdue.</div>
      ${d.by_policy.length ? d.by_policy.map((p) => `
        <div class="card" style="margin:0 0 10px;">
          <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center;">
            <div><strong>${esc(p.title)}</strong>
              <div style="font-size:11.5px; color:var(--text-muted);">${esc(p.category || "")} · v${esc(p.version)}</div></div>
            <div style="display:flex; gap:5px;">
              ${chip(p.acknowledged + " acknowledged", "background:#dcfce7; color:#166534;")}
              ${chip(p.pending + " pending", "background:#fef3c7; color:#92400e;")}
              ${chip(p.overdue + " overdue", "background:#fee2e2; color:#991b1b;")}
            </div>
          </div>
          <details style="margin-top:8px;"><summary style="cursor:pointer; font-size:12px;">By employee</summary>
            <div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:6px;">
              ${p.employees.map((e) => `<span class="pol-badge" style="${
                e.state === "acknowledged" ? "background:#dcfce7; color:#166534;"
                : e.state === "overdue" ? "background:#fee2e2; color:#991b1b;"
                : "background:#fef3c7; color:#92400e;"}">${esc(e.name || "—")}</span>`).join("")}
            </div>
          </details>
        </div>`).join("")
        : `<div class="empty-state">No policy currently requires acknowledgment.</div>`}
      ${d.historical.length ? `<details style="margin-top:6px;">
        <summary style="cursor:pointer; font-size:12.5px; font-weight:600;">Superseded acknowledgments (${d.historical.length})</summary>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:6px;">
          Kept as the historical record of what each person acknowledged, and when, before the policy was re-issued.</div>
        <ul style="font-size:12px; margin:6px 0 0 16px;">
          ${d.historical.map((h) => `<li>${esc(h.name || "—")} — v${esc(h.version)} on ${esc(new Date(h.acknowledged_at).toLocaleDateString())}</li>`).join("")}
        </ul></details>` : ""}
    </div>`;
    document.body.appendChild(bd);
    bd.querySelector(".close-btn").addEventListener("click", () => bd.remove());
    bd.addEventListener("click", (e) => { if (e.target === bd) bd.remove(); });
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
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-top:6px;">
        <div class="field"><label>Status</label><select data-f="status">
          ${(d.statuses || ["Active", "Draft", "Archived"]).map((s) => `<option ${(pol.status || "Active") === s ? "selected" : ""}>${esc(s)}</option>`).join("")}
        </select></div>
        <div class="field"><label>Version</label><input data-f="version" value="${esc(pol.version || "1")}" placeholder="1" /></div>
        <div class="field"><label>Effective date</label><input type="date" data-f="effective_date" value="${esc(String(pol.effective_date || "").slice(0, 10))}" /></div>
        <div class="field"><label>Section in source</label><input data-f="section_ref" value="${esc(pol.section_ref || "")}" placeholder="e.g. Section 4.2" /></div>
      </div>
      <div class="field"><label>Source document</label><select data-f="document_id">
        <option value="">— none (standalone policy) —</option>
        ${(d.documents || []).map((doc) => `<option value="${doc.id}" ${String(pol.document && pol.document.id) === String(doc.id) ? "selected" : ""}>${esc(doc.title)}</option>`).join("")}
      </select></div>
      <label style="display:flex; gap:8px; align-items:center; font-size:13px; margin-top:6px;"><input type="checkbox" data-f="requires_acknowledgment" ${pol.requires_acknowledgment ? "checked" : ""} /> Require employee acknowledgment</label>
      <div style="font-size:11.5px; color:var(--text-muted); margin:2px 0 0 24px;">Changing the version re-issues the policy: past acknowledgments are kept as history and everyone is asked again.</div>
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
        status: bd.querySelector('[data-f="status"]').value,
        version: bd.querySelector('[data-f="version"]').value.trim() || "1",
        effective_date: bd.querySelector('[data-f="effective_date"]').value || null,
        section_ref: bd.querySelector('[data-f="section_ref"]').value.trim() || null,
        document_id: bd.querySelector('[data-f="document_id"]').value || null,
        requires_acknowledgment: bd.querySelector('[data-f="requires_acknowledgment"]').checked,
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
