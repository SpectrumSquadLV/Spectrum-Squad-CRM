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
