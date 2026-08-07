// growth-frontend.js -- Lead Management + Policies/SOPs UIs.
// Exposes window.__renderLeads(mount) and window.__renderPolicies(mount) for the
// native router. Uses the global api() helper.
(function () {
  "use strict";
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function money(n) { if (n == null || n === "") return "—"; return "$" + (Math.round(Number(n) * 100) / 100).toLocaleString(); }

  // ============================ LEADS ============================
  async function renderLeads(mount) {
    let d;
    try { d = await api("/api/leads"); }
    catch (e) { mount.innerHTML = `<div class="page-header"><div><h1>Lead Management</h1></div></div><div class="empty-state">${esc(e.message)}</div>`; return; }
    const stageColor = (s) => ({ New: "#e0e7ff", Contacted: "#fef3c7", "Meeting Set": "#dbeafe", "Proposal Sent": "#fde68a", Won: "#dcfce7", Lost: "#fee2e2" }[s] || "#eee");
    const rows = d.leads.map((l) => `<tr data-lead="${l.id}" style="cursor:pointer;">
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);"><strong>${esc(l.name)}</strong>${l.contact_name ? `<div style="color:var(--text-muted); font-size:12px;">${esc(l.contact_name)}</div>` : ""}</td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">${esc(l.lead_type || "—")}</td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);"><span class="tag" style="background:${stageColor(l.stage)};">${esc(l.stage)}</span></td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">${money(l.est_value)}</td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">${l.next_follow_up ? esc(l.next_follow_up) : "—"}</td>
    </tr>`).join("");
    mount.innerHTML = `
      <div class="page-header">
        <div><h1>Lead Management</h1><p>School, private-pay, and community contracts &amp; leads. Track stage, value, and follow-ups.</p></div>
        <button class="btn" id="lead-add">+ Add lead</button>
      </div>
      <div class="card"><div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:13px; min-width:640px;">
        <thead><tr style="text-align:left; color:var(--text-muted); font-size:11px; text-transform:uppercase;">
          <th style="padding:8px 10px;">Name</th><th style="padding:8px 10px;">Type</th><th style="padding:8px 10px;">Stage</th><th style="padding:8px 10px;">Est. value</th><th style="padding:8px 10px;">Next follow-up</th>
        </tr></thead><tbody>${rows || `<tr><td colspan="5"><div class="empty-state">No leads yet.</div></td></tr>`}</tbody>
      </table></div></div>`;
    mount.querySelector("#lead-add").addEventListener("click", () => leadModal(null, d, mount));
    mount.querySelectorAll("[data-lead]").forEach((tr) => tr.addEventListener("click", () => leadModal(d.leads.find((x) => String(x.id) === tr.dataset.lead), d, mount)));
  }

  function leadModal(lead, d, mount) {
    lead = lead || {};
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    const f = (k, label, type) => `<div class="field"><label>${label}</label><input data-f="${k}" ${type ? `type="${type}"` : ""} value="${esc(lead[k] == null ? "" : lead[k])}" /></div>`;
    bd.innerHTML = `<div class="modal" style="width:560px;">
      <div class="modal-header"><h2>${lead.id ? "Edit lead" : "Add lead"}</h2><button class="close-btn">✕</button></div>
      <div class="form-grid" style="gap:10px;">
        ${f("name", "Organization / lead name")}
        <div class="field"><label>Type</label><select data-f="lead_type">${d.types.map((t) => `<option ${lead.lead_type === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
        <div class="field"><label>Stage</label><select data-f="stage">${d.stages.map((s) => `<option ${lead.stage === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
        ${f("contact_name", "Contact name")}
        ${f("contact_email", "Contact email", "email")}
        ${f("contact_phone", "Contact phone")}
        ${f("est_value", "Estimated value ($)", "number")}
        ${f("next_follow_up", "Next follow-up", "date")}
        <div class="field full"><label>Notes</label><textarea data-f="notes" rows="3">${esc(lead.notes || "")}</textarea></div>
      </div>
      <div style="margin-top:14px; display:flex; gap:8px;">
        <button class="btn" id="lead-save">${lead.id ? "Save" : "Add"}</button>
        ${lead.id ? `<button class="btn secondary" id="lead-del" style="color:#b91c1c;">Delete</button>` : ""}
        <span id="lead-status" style="font-size:12.5px; color:var(--text-muted); align-self:center;"></span>
      </div>
    </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    bd.querySelector("#lead-save").addEventListener("click", async () => {
      const body = {};
      bd.querySelectorAll("[data-f]").forEach((el) => { body[el.dataset.f] = el.value || null; });
      if (!body.name) { bd.querySelector("#lead-status").textContent = "Name is required."; return; }
      try {
        if (lead.id) await api("/api/leads/" + lead.id, { method: "PATCH", body });
        else await api("/api/leads", { method: "POST", body });
        close(); renderLeads(mount);
      } catch (e) { bd.querySelector("#lead-status").textContent = e.message || "Failed."; }
    });
    const del = bd.querySelector("#lead-del");
    if (del) del.addEventListener("click", async () => { if (!confirm("Delete this lead?")) return; try { await api("/api/leads/" + lead.id, { method: "DELETE" }); close(); renderLeads(mount); } catch (e) { alert(e.message); } });
  }

  // ============================ POLICIES ============================
  async function renderPolicies(mount) {
    let d;
    try { d = await api("/api/policies"); }
    catch (e) { mount.innerHTML = `<div class="page-header"><div><h1>Policies &amp; SOPs</h1></div></div><div class="empty-state">${esc(e.message)}</div>`; return; }
    const publicUrl = location.origin + "/policies";
    const qr = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(publicUrl);
    const byCat = {}; d.policies.forEach((p) => { (byCat[p.category || "Other"] = byCat[p.category || "Other"] || []).push(p); });
    const list = Object.keys(byCat).sort().map((cat) => `<div class="section-title">${esc(cat)}</div>` + byCat[cat].map((p) => `
      <div class="task-row"><div class="info"><strong>${esc(p.title)}</strong> ${p.published ? "" : `<span class="tag">draft</span>`}<div class="due">/policies/${esc(p.slug)}</div></div>
        <div style="display:flex; gap:6px;"><button class="btn small secondary" data-pol-edit="${p.id}">Edit</button><a class="btn small secondary" href="/policies/${esc(p.slug)}" target="_blank" rel="noopener">View</a></div>
      </div>`).join("")).join("") || `<div class="empty-state">No policies yet.</div>`;
    mount.innerHTML = `
      <div class="page-header">
        <div><h1>Policies, SOPs &amp; Procedures</h1><p>Staff can scan the QR code to read any policy. Print it and post it around the clinic.</p></div>
        <button class="btn" id="pol-add">+ Add policy</button>
      </div>
      <div style="display:grid; grid-template-columns: 1.6fr 1fr; gap:20px;">
        <div class="card" style="margin:0;">${list}</div>
        <div class="card" style="margin:0; text-align:center;">
          <div class="section-title" style="margin-top:0;">Printable QR code</div>
          <img src="${qr}" alt="Policies QR code" style="width:220px; height:220px; max-width:100%;" />
          <div style="font-size:12px; color:var(--text-muted); margin-top:8px; word-break:break-all;">${esc(publicUrl)}</div>
          <button class="btn small secondary" id="pol-print" style="margin-top:10px;">🖨 Print QR</button>
        </div>
      </div>`;
    mount.querySelector("#pol-add").addEventListener("click", () => policyModal(null, d, mount));
    mount.querySelectorAll("[data-pol-edit]").forEach((b) => b.addEventListener("click", () => policyModal(d.policies.find((x) => String(x.id) === b.dataset.polEdit), d, mount)));
    mount.querySelector("#pol-print").addEventListener("click", () => {
      const w = window.open("", "_blank");
      if (w) { w.document.write(`<html><head><title>Policies QR — Spectrum Squad</title></head><body style="text-align:center;font-family:sans-serif;padding:40px;"><h2>Spectrum Squad — Policies &amp; Procedures</h2><p>Scan to read our policies, SOPs &amp; procedures</p><img src="${qr}" style="width:320px;height:320px;"/><p style="color:#555;">${esc(publicUrl)}</p></body></html>`); w.document.close(); w.focus(); setTimeout(() => w.print(), 400); }
    });
  }

  function policyModal(pol, d, mount) {
    pol = pol || {};
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    bd.innerHTML = `<div class="modal" style="width:680px; max-width:94vw;">
      <div class="modal-header"><h2>${pol.id ? "Edit policy" : "Add policy"}</h2><button class="close-btn">✕</button></div>
      <div class="field"><label>Title</label><input data-f="title" value="${esc(pol.title || "")}" /></div>
      <div class="field"><label>Category</label><select data-f="category">${d.categories.map((c) => `<option ${pol.category === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
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
