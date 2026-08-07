// supervision-frontend.js -- RBT Supervision Tracker UI.
// Exposes window.__renderSupervision(mount) for the native router, plus
// window.HRSupervision.{ openEditor, renderStaffSection } for the staff card.
// Uses the global api() helper from index.html.
(function () {
  "use strict";
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function curMonth() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
  function monthLabel(m) { if (!m) return ""; const [y, mo] = m.split("-"); const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; return (names[+mo] || mo) + " " + y; }

  let curM = curMonth();

  async function renderSupervision(mount) {
    mount.innerHTML = `<div class="page-header"><div><h1>RBT Supervision</h1><p>Monthly supervision hours vs. hours worked. BACB minimum is 5% per month.</p></div>
      <div style="display:flex; gap:8px; align-items:center;">
        <input type="month" id="sup-month" value="${curM}" />
        <button class="btn secondary" id="sup-upload">⬆ Upload Rethink hours</button>
      </div></div>
      <div id="sup-body"><div class="empty-state">Loading…</div></div>`;
    mount.querySelector("#sup-month").addEventListener("change", (e) => { curM = e.target.value || curMonth(); renderSupervision(mount); });
    mount.querySelector("#sup-upload").addEventListener("click", () => openHoursUpload(mount));
    await fillTable(mount);
  }

  async function fillTable(mount) {
    const box = mount.querySelector("#sup-body");
    let d;
    try { d = await api("/api/supervision?month=" + encodeURIComponent(curM)); }
    catch (e) { box.innerHTML = `<div class="empty-state">Couldn't load: ${esc(e.message)}</div>`; return; }
    const overall = d.overall_pct == null ? "—" : d.overall_pct + "%";
    const rows = d.employees.map((e) => {
      const pctCell = e.pct == null
        ? `<span class="tag" style="background:#fef3c7; color:#92400e;">needs hours</span>`
        : `<span class="tag" style="background:${e.meets ? "#dcfce7" : "#fee2e2"}; color:${e.meets ? "#166534" : "#991b1b"};">${e.pct}%</span>`;
      return `<tr data-sup-emp="${e.employee_id}" style="cursor:pointer;">
        <td style="padding:8px 10px; border-top:1px solid var(--border,#eee);"><strong>${esc(e.name)}</strong></td>
        <td style="padding:8px 10px; border-top:1px solid var(--border,#eee);">${esc(e.role_title || "—")}</td>
        <td style="padding:8px 10px; border-top:1px solid var(--border,#eee); text-align:right;">${e.sup_hours}</td>
        <td style="padding:8px 10px; border-top:1px solid var(--border,#eee); text-align:right;">${e.hours_worked || "—"}</td>
        <td style="padding:8px 10px; border-top:1px solid var(--border,#eee);">${pctCell}</td>
        <td style="padding:8px 10px; border-top:1px solid var(--border,#eee);">${e.signed_off ? `<span class="tag" style="background:#dcfce7; color:#166534;">✓ signed</span>` : `<span class="tag">open</span>`}</td>
      </tr>`;
    }).join("");
    box.innerHTML = `
      <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px;">
        <div style="flex:1; min-width:150px; background:var(--bg,#f7f8fb); border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:14px 16px;">
          <div style="font-size:26px; font-weight:800; color:var(--brand-navy,#1b2a6b);">${overall}</div>
          <div style="font-size:12px; color:var(--text-muted);">Overall supervision — ${esc(monthLabel(d.month))}</div>
        </div>
        <div style="flex:1; min-width:150px; background:var(--bg,#f7f8fb); border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:14px 16px;">
          <div style="font-size:26px; font-weight:800; color:var(--brand-navy,#1b2a6b);">${d.signed_count}/${d.staff_count}</div>
          <div style="font-size:12px; color:var(--text-muted);">Signed off</div>
        </div>
        <div style="flex:1; min-width:150px; background:var(--bg,#f7f8fb); border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:14px 16px;">
          <div style="font-size:26px; font-weight:800; color:${d.need_hours_upload ? "#b45309" : "var(--brand-navy,#1b2a6b)"};">${d.need_hours_upload}</div>
          <div style="font-size:12px; color:var(--text-muted);">Missing worked hours</div>
        </div>
      </div>
      ${d.need_hours_upload ? `<div style="background:#fff4dd; color:#a56b00; border-radius:8px; padding:8px 12px; font-size:12.5px; margin-bottom:12px;">⬆ Upload the Rethink hours export for ${esc(monthLabel(d.month))} to calculate supervision percentages.</div>` : ""}
      <div class="card">
        <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:13px; min-width:640px;">
          <thead><tr style="text-align:left; color:var(--text-muted); font-size:11px; text-transform:uppercase;">
            <th style="padding:8px 10px;">Staff</th><th style="padding:8px 10px;">Role</th><th style="padding:8px 10px; text-align:right;">Sup hrs</th><th style="padding:8px 10px; text-align:right;">Worked hrs</th><th style="padding:8px 10px;">%</th><th style="padding:8px 10px;">Status</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="6"><div class="empty-state">No staff.</div></td></tr>`}</tbody>
        </table></div>
      </div>`;
    box.querySelectorAll("[data-sup-emp]").forEach((tr) => tr.addEventListener("click", () => openEditor(tr.dataset.supEmp, curM, () => fillTable(mount))));
  }

  function openHoursUpload(mount) {
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    bd.innerHTML = `<div class="modal" style="width:520px;">
      <div class="modal-header"><h2>Upload Rethink hours — ${esc(monthLabel(curM))}</h2><button class="close-btn">✕</button></div>
      <p style="font-size:13px; color:var(--text-muted); margin-top:0;">Upload the Rethink payroll/hours export (.xlsx). Each staff member's total worked hours for this month become the denominator for their supervision %.</p>
      <input type="file" id="sup-file" accept=".xlsx" />
      <div id="sup-up-status" style="font-size:12.5px; margin-top:10px; color:var(--text-muted);"></div>
    </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    bd.querySelector("#sup-file").addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const st = bd.querySelector("#sup-up-status"); st.textContent = "Reading…";
      const r = new FileReader();
      r.onload = async () => {
        try {
          const res = await api("/api/supervision/import-hours", { method: "POST", body: { month: curM, content_base64: String(r.result).split(",")[1] } });
          st.textContent = `Updated worked hours for ${res.updated} staff.`;
          setTimeout(() => { close(); renderSupervision(mount); }, 900);
        } catch (err) { st.textContent = err.message || "Failed."; }
      };
      r.readAsDataURL(f);
    });
  }

  const BLANK = () => ({ date: "", activity: "", time_in: "", time_out: "", duration: "", face_to_face: false, supervisor: "", observed: false, group: "Individual", notes: "" });

  async function openEditor(empId, month, onDone) {
    month = month || curMonth();
    let d;
    try { d = await api("/api/supervision/employee/" + empId + "?month=" + encodeURIComponent(month)); }
    catch (e) { alert(e.message); return; }
    let entries = d.entries && d.entries.length ? d.entries.slice() : [BLANK()];
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    document.body.appendChild(bd);
    const close = () => bd.remove();

    function render() {
      const sup = entries.reduce((s, e) => s + (parseFloat(e.duration) || 0), 0);
      const worked = d.hours_worked || 0;
      const p = worked ? Math.round((sup / worked) * 1000) / 10 : null;
      const rowHtml = entries.map((e, i) => `<tr>
        <td><input data-f="date" data-i="${i}" type="date" value="${esc((e.date || "").slice(0,10))}" style="width:130px;"/></td>
        <td><input data-f="activity" data-i="${i}" value="${esc(e.activity || "")}" placeholder="Activity/Client" style="width:150px;"/></td>
        <td><input data-f="time_in" data-i="${i}" value="${esc(e.time_in || "")}" placeholder="9:00a" style="width:64px;"/></td>
        <td><input data-f="time_out" data-i="${i}" value="${esc(e.time_out || "")}" placeholder="10:30a" style="width:64px;"/></td>
        <td><input data-f="duration" data-i="${i}" type="number" step="0.25" value="${esc(e.duration || "")}" style="width:64px;"/></td>
        <td style="text-align:center;"><input data-f="face_to_face" data-i="${i}" type="checkbox" ${e.face_to_face ? "checked" : ""}/></td>
        <td><input data-f="supervisor" data-i="${i}" value="${esc(e.supervisor || "")}" placeholder="BCBA" style="width:120px;"/></td>
        <td style="text-align:center;"><input data-f="observed" data-i="${i}" type="checkbox" ${e.observed ? "checked" : ""}/></td>
        <td><select data-f="group" data-i="${i}"><option ${e.group === "Individual" ? "selected" : ""}>Individual</option><option ${e.group === "Group" ? "selected" : ""}>Group</option></select></td>
        <td><input data-f="notes" data-i="${i}" value="${esc(e.notes || "")}" style="width:120px;"/></td>
        <td><button class="btn small secondary" data-del="${i}">✕</button></td>
      </tr>`).join("");
      bd.innerHTML = `<div class="modal" style="width:min(1000px,96vw);">
        <div class="modal-header"><h2>${esc(d.employee.name)} — Supervision (${esc(monthLabel(month))})</h2><button class="close-btn">✕</button></div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:10px;">
          <label style="font-size:12.5px;">Monthly worked hours <input id="sup-worked" type="number" step="0.1" value="${esc(worked)}" style="width:90px;"/></label>
          <span class="tag" style="background:${p == null ? "#fef3c7" : (p >= d.min_pct ? "#dcfce7" : "#fee2e2")}; color:${p == null ? "#92400e" : (p >= d.min_pct ? "#166534" : "#991b1b")};">Supervision: ${sup.toFixed(2)} hrs · ${p == null ? "enter worked hours" : p + "% (min " + d.min_pct + "%)"}</span>
          ${d.signed_off ? `<span class="tag" style="background:#dcfce7; color:#166534;">✓ Signed off by ${esc(d.signed_by || "")}</span>` : ""}
          ${d.has_pdf ? `<a class="btn small secondary" href="/api/supervision/employee/${empId}/pdf?month=${encodeURIComponent(month)}" target="_blank" rel="noopener">Download PDF</a>` : ""}
        </div>
        <div style="overflow-x:auto;"><table style="border-collapse:collapse; font-size:12px;">
          <thead><tr style="color:var(--text-muted); font-size:10.5px; text-transform:uppercase;">
            <th style="padding:4px;">Date</th><th style="padding:4px;">Activity/Client</th><th style="padding:4px;">In</th><th style="padding:4px;">Out</th><th style="padding:4px;">Dur</th><th style="padding:4px;">F2F</th><th style="padding:4px;">Supervisor</th><th style="padding:4px;">Obs</th><th style="padding:4px;">Type</th><th style="padding:4px;">Notes</th><th></th>
          </tr></thead><tbody>${rowHtml}</tbody>
        </table></div>
        <div style="margin-top:8px;"><button class="btn small secondary" id="sup-add-row">+ Add row</button></div>
        <div style="margin-top:14px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn" id="sup-save">Save</button>
          <input id="sup-signer" placeholder="BCBA name to sign off" style="width:200px;" value="${esc(d.signed_by || "")}"/>
          <button class="btn secondary" id="sup-signoff">Sign off &amp; email</button>
          <span id="sup-status" style="font-size:12.5px; color:var(--text-muted);"></span>
        </div>
      </div>`;
      bd.querySelector(".close-btn").addEventListener("click", close);
      pull();
      bd.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { entries.splice(Number(b.dataset.del), 1); if (!entries.length) entries = [BLANK()]; render(); }));
      bd.querySelector("#sup-add-row").addEventListener("click", () => { entries.push(BLANK()); render(); });
      bd.querySelector("#sup-save").addEventListener("click", () => save(false));
      bd.querySelector("#sup-signoff").addEventListener("click", () => signOff());
    }
    function pull() {
      bd.querySelectorAll("[data-f]").forEach((el) => {
        const i = Number(el.dataset.i), f = el.dataset.f;
        el.addEventListener("change", () => { entries[i][f] = (el.type === "checkbox") ? el.checked : el.value; });
      });
    }
    async function save(silent) {
      const worked = parseFloat(bd.querySelector("#sup-worked").value) || 0;
      const st = bd.querySelector("#sup-status"); if (!silent) st.textContent = "Saving…";
      try {
        await api("/api/supervision/employee/" + empId, { method: "POST", body: { month, entries, hours_worked: worked } });
        if (!silent) { st.textContent = "Saved ✓"; d.hours_worked = worked; }
        return true;
      } catch (e) { st.textContent = e.message || "Failed."; return false; }
    }
    async function signOff() {
      const signer = bd.querySelector("#sup-signer").value.trim();
      const st = bd.querySelector("#sup-status");
      if (!signer) { st.textContent = "Enter the BCBA name to sign off."; return; }
      if (!confirm("Sign off " + d.employee.name + "'s supervision for " + monthLabel(month) + "? This emails the staff member and the BCBA.")) return;
      st.textContent = "Signing…";
      if (!(await save(true))) return;
      try {
        const r = await api("/api/supervision/employee/" + empId + "/sign-off", { method: "POST", body: { month, supervisor_name: signer } });
        st.textContent = "Signed & emailed (" + (r.emailed || []).length + " recipient(s)).";
        setTimeout(() => { close(); if (onDone) onDone(); }, 1000);
      } catch (e) { st.textContent = e.message || "Failed."; }
    }
    render();
  }

  // Compact section for the staff card.
  async function renderStaffSection(container, empId) {
    if (!container) return;
    const month = curMonth();
    let d;
    try { d = await api("/api/supervision/employee/" + empId + "?month=" + encodeURIComponent(month)); }
    catch (e) { container.innerHTML = `<div class="empty-state">Supervision unavailable.</div>`; return; }
    const p = d.pct;
    const badge = p == null ? `<span class="tag" style="background:#fef3c7; color:#92400e;">needs hours</span>`
      : `<span class="tag" style="background:${p >= d.min_pct ? "#dcfce7" : "#fee2e2"}; color:${p >= d.min_pct ? "#166534" : "#991b1b"};">${p}% (min ${d.min_pct}%)</span>`;
    const hist = (d.history || []).slice(0, 6).map((h) => `<span style="font-size:11.5px; color:var(--text-muted); margin-right:10px;">${monthLabel(h.month)}: ${h.pct == null ? "—" : h.pct + "%"}${h.signed_off ? " ✓" : ""}</span>`).join("");
    container.innerHTML = `<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <strong style="font-size:13px;">${monthLabel(month)}:</strong> ${badge}
      <span style="font-size:12px; color:var(--text-muted);">${d.sup_hours} sup hrs / ${d.hours_worked || "—"} worked</span>
      <button class="btn small" data-open-sup>Open tracker</button>
      ${d.signed_off ? `<span class="tag" style="background:#dcfce7; color:#166534;">✓ signed</span>` : ""}
    </div>${hist ? `<div style="margin-top:6px;">${hist}</div>` : ""}`;
    const btn = container.querySelector("[data-open-sup]");
    if (btn) btn.addEventListener("click", () => openEditor(empId, month, () => renderStaffSection(container, empId)));
  }

  window.__renderSupervision = function (mount) { return renderSupervision(mount); };
  window.HRSupervision = { openEditor: openEditor, renderStaffSection: renderStaffSection };
})();
