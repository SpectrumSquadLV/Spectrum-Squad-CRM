// supervision-frontend.js -- RBT Supervision Tracker UI.
// Exposes window.__renderSupervision(mount) for the native router, plus
// window.HRSupervision.{ openEditor, renderStaffSection } for the staff card.
// Uses the global api() helper from index.html.
(function () {
  "use strict";
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function curMonth() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
  function monthLabel(m) { if (!m) return ""; const [y, mo] = m.split("-"); const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; return (names[+mo] || mo) + " " + y; }
  // 'YYYY-MM-DD' -> 'Mon D, YYYY' (parsed as UTC so it never drifts a day).
  function dayLabel(s) {
    if (!s) return ""; const p = String(s).slice(0, 10).split("-"); if (p.length !== 3) return String(s);
    const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return (names[+p[1]] || p[1]) + " " + (+p[2]) + ", " + p[0];
  }

  let curM = curMonth();

  async function renderSupervision(mount) {
    mount.innerHTML = `<div class="page-header"><div><h1>RBT Supervision</h1><p>Monthly supervision hours vs. hours worked. BACB minimum is 5% per month.</p></div>
      <div style="display:flex; gap:8px; align-items:center;">
        <input type="month" id="sup-month" value="${curM}" />
        <button class="btn secondary" id="sup-upload">⬆ Upload Rethink hours</button>
      </div></div>
      <div id="rethink-panel"></div>
      <div id="sup-body"><div class="empty-state">Loading…</div></div>`;
    mount.querySelector("#sup-month").addEventListener("change", (e) => { curM = e.target.value || curMonth(); renderSupervision(mount); });
    mount.querySelector("#sup-upload").addEventListener("click", () => openHoursUpload(mount));
    await fillTable(mount);
    renderRethinkPanel(mount).catch(() => {});
  }

  // ---- Rethink integration status ----------------------------------------
  // Operational, not analytical: is it connected, when did it last work, who
  // could not be matched, and what does production actually return in the two
  // fields that decide whether an hour counts.
  async function renderRethinkPanel(mount) {
    const box = mount.querySelector("#rethink-panel");
    if (!box) return;
    let s;
    try { s = await api("/api/rethink/status?month=" + encodeURIComponent(curM)); }
    catch (e) { box.innerHTML = ""; return; } // not permitted, or not deployed yet
    const a = s.authorizations || {};

    const dot = (ok, warn) => `<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${ok ? "#16a34a" : warn ? "#d97706" : "#dc2626"}; margin-right:6px;"></span>`;
    const when = (t) => (t ? new Date(t).toLocaleString() : "never");
    const connOk = s.configured && s.last_successful_sync;
    const stale = s.stale || a.stale;

    // Distinct values seen in production, so the filter is confirmed against
    // reality rather than a guess.
    const vals = (field) => (s.observed_values || []).filter((o) => o.field === field);
    const chips = (field, selected) => vals(field).map((o) => {
      const on = (selected || []).map(String).map((x) => x.toLowerCase()).includes(String(o.value_norm));
      return `<label style="display:inline-flex; align-items:center; gap:5px; background:${on ? "#dcfce7" : "var(--bg,#f7f8fb)"}; border:1px solid ${on ? "#86efac" : "var(--border,#e5e7eb)"}; border-radius:999px; padding:3px 10px; font-size:12px; margin:2px 3px 2px 0; cursor:pointer;">
        <input type="checkbox" data-rt-field="${field}" value="${esc(o.value_raw == null ? "" : o.value_raw)}" ${on ? "checked" : ""} style="margin:0;" />
        <strong>${esc(o.value_raw == null ? "(null)" : o.value_raw)}</strong>
        <span style="color:var(--text-muted);">${o.occurrences}× · ${o.hours_sum}h</span>
      </label>`;
    }).join("") || `<span style="font-size:12px; color:var(--text-muted);">No values observed yet — run a sync.</span>`;

    box.innerHTML = `
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
        <h3 style="margin:0; font-size:14px;">${dot(connOk, s.configured && !connOk)}Rethink integration</h3>
        <div style="display:flex; gap:6px;">
          <a class="btn small secondary" href="#/rethink-clients">Client matching</a>
          <button class="btn small secondary" id="rt-sync">⟳ Sync Rethink now</button>
        </div>
      </div>
      ${!s.configured ? `<div style="background:#fee2e2; color:#991b1b; border-radius:8px; padding:8px 12px; font-size:12.5px; margin-top:10px;">
        Not configured — add <strong>RETHINK_CLIENT_ID</strong> and <strong>RETHINK_CLIENT_SECRET</strong> in Railway.</div>` : ""}
      ${stale ? `<div style="background:#fff4dd; color:#a56b00; border-radius:8px; padding:8px 12px; font-size:12.5px; margin-top:10px;">
        ⚠ The most recent sync failed. The figures below are the last good values and may be stale.</div>` : ""}
      ${!s.filter.confirmed && s.configured ? `<div style="background:#eef4ff; color:#1b3a7b; border-radius:8px; padding:8px 12px; font-size:12.5px; margin-top:10px;">
        Hours are <strong>provisional</strong> and are not being used for supervision percentages yet. Confirm below which values mean “completed” and “staff verified”.</div>` : ""}

      <div style="display:flex; gap:18px; flex-wrap:wrap; font-size:12.5px; margin-top:12px;">
        <div><div style="color:var(--text-muted);">Last successful sync</div><strong>${when(s.last_successful_sync && s.last_successful_sync.finished_at)}</strong></div>
        <div><div style="color:var(--text-muted);">Last attempted</div><strong>${when(s.last_attempted_sync && s.last_attempted_sync.finished_at)}</strong></div>
        <div><div style="color:var(--text-muted);">Providers matched</div><strong>${s.totals.matched} / ${s.totals.providers}</strong></div>
        <div><div style="color:var(--text-muted);">Need matching</div><strong style="color:${s.providers_needing_match.length ? "#b45309" : "inherit"};">${s.providers_needing_match.length}</strong></div>
        <div><div style="color:var(--text-muted);">97153 auths</div><strong>${a.counts ? a.counts.total : 0}</strong> <span style="color:var(--text-muted);">(${a.counts ? a.counts.current : 0} current)</span></div>
        <div><div style="color:var(--text-muted);">Clients need review</div><strong style="color:${(a.clients_needing_review || []).length ? "#b45309" : "inherit"};">${(a.clients_needing_review || []).length}</strong></div>
      </div>

      ${s.providers_needing_match.length ? `<div style="margin-top:10px; font-size:12px;">
        <strong style="color:#b45309;">Rethink Provider Match Needed:</strong> ${s.providers_needing_match.map((p) => esc(p.name)).join(", ")}
        <div style="color:var(--text-muted); margin-top:2px;">Add their Rethink ID on the staff record — they are never matched by name.</div></div>` : ""}

      ${(a.clients_needing_review || []).length ? `<div style="margin-top:8px; font-size:12px;">
        <strong style="color:#b45309;">Overlapping 97153 authorizations:</strong> ${a.clients_needing_review.map((c) => esc(c.child_name)).join(", ")}
        <div style="color:var(--text-muted); margin-top:2px;">Dates were left unchanged for these clients rather than picking one.</div></div>` : ""}

      <details style="margin-top:12px;" ${s.filter.confirmed ? "" : "open"}>
        <summary style="cursor:pointer; font-size:12.5px; font-weight:600;">Completed / verified filter ${s.filter.confirmed ? "✓ confirmed" : "— needs confirming"}</summary>
        <div style="margin-top:8px; font-size:12px;">
          <div style="color:var(--text-muted); margin-bottom:4px;">Values seen in <code>appointmentStatus</code> this month — tick the ones that mean completed:</div>
          <div>${chips("appointmentStatus", s.filter.completed_statuses)}</div>
          <div style="color:var(--text-muted); margin:8px 0 4px;">Values seen in <code>staffVerification</code> — tick the ones that mean verified:</div>
          <div>${chips("staffVerification", s.filter.verified_values)}</div>
          <div style="margin-top:10px;">
            <button class="btn small" id="rt-confirm">Save &amp; use for supervision %</button>
            ${s.filter.confirmed ? `<button class="btn small secondary" id="rt-unconfirm">Re-open</button>
              <span style="color:var(--text-muted); margin-left:8px;">confirmed by ${esc(s.filter.confirmed_by || "—")}</span>` : ""}
          </div>
        </div>
      </details>

      ${(s.warnings || []).length ? `<details style="margin-top:8px;"><summary style="cursor:pointer; font-size:12.5px; color:#b45309;">${s.warnings.length} sync warning(s)</summary>
        <ul style="font-size:11.5px; color:var(--text-muted); margin:6px 0 0 16px;">${s.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}
    </div>`;

    const picked = (field) => Array.from(box.querySelectorAll(`[data-rt-field="${field}"]:checked`)).map((i) => i.value);
    const saveFilter = async (confirm) => {
      try {
        await api("/api/rethink/filter", { method: "PUT", body: {
          filter_confirmed: confirm,
          completed_statuses: picked("appointmentStatus"),
          verified_values: picked("staffVerification"),
          require_staff_verification: true,
        } });
        await renderSupervision(mount);
      } catch (e) { alert(e.message); }
    };
    const cBtn = box.querySelector("#rt-confirm");
    if (cBtn) cBtn.addEventListener("click", () => saveFilter(true));
    const uBtn = box.querySelector("#rt-unconfirm");
    if (uBtn) uBtn.addEventListener("click", () => saveFilter(false));
    const sBtn = box.querySelector("#rt-sync");
    if (sBtn) sBtn.addEventListener("click", async () => {
      sBtn.disabled = true; sBtn.textContent = "Syncing…";
      try { await api("/api/rethink/sync-now", { method: "POST", body: { month: curM } }); }
      catch (e) { alert(e.message); }
      await renderSupervision(mount);
    });
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
        <td style="padding:8px 10px; border-top:1px solid var(--border,#eee); text-align:right;">${e.hours_worked || "—"}${e.hours_source === "rethink"
          ? `<div style="font-size:10.5px; color:#166534; font-weight:600;" title="Verified completed service hours from Rethink">Rethink verified</div>`
          : (e.hours_current_through ? `<div style="font-size:10.5px; color:var(--text-muted); font-weight:400;" title="Uploaded hours are current through this date">through ${esc(dayLabel(e.hours_current_through))}</div>` : "")}</td>
        <td style="padding:8px 10px; border-top:1px solid var(--border,#eee);">${pctCell}</td>
        <td style="padding:8px 10px; border-top:1px solid var(--border,#eee);">${e.signed_off ? `<span class="tag" style="background:#dcfce7; color:#166534;">✓ signed</span>` : `<span class="tag">open</span>`}</td>
        <td style="padding:8px 10px; border-top:1px solid var(--border,#eee); text-align:right;"><button class="btn small secondary" data-sup-untrack="${e.employee_id}" title="This person supervises rather than being supervised">Not supervised</button></td>
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
      <div style="display:flex; align-items:center; gap:8px; background:${d.global_hours_current_through ? "#eef4ff" : "#fff4dd"}; color:${d.global_hours_current_through ? "#1b3a7b" : "#a56b00"}; border:1px solid ${d.global_hours_current_through ? "#c7d8f5" : "#f1d9a0"}; border-radius:8px; padding:9px 13px; font-size:13px; margin-bottom:12px;">
        <span style="font-size:15px;">🗓️</span>
        ${d.global_hours_current_through
          ? `<span>Uploaded worked-hours are <strong>current through ${esc(dayLabel(d.global_hours_current_through))}</strong>.${d.hours_current_through && d.hours_current_through !== d.global_hours_current_through ? ` For ${esc(monthLabel(d.month))}, through ${esc(dayLabel(d.hours_current_through))}.` : ""} Upload again to extend coverage.</span>`
          : `<span>No worked-hours have been uploaded yet — upload the Rethink export to set the “hours current through” date.</span>`}
      </div>
      ${d.need_hours_upload ? `<div style="background:#fff4dd; color:#a56b00; border-radius:8px; padding:8px 12px; font-size:12.5px; margin-bottom:12px;">⬆ Upload the Rethink hours export for ${esc(monthLabel(d.month))} to calculate supervision percentages.</div>` : ""}
      <div class="card">
        <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:13px; min-width:640px;">
          <thead><tr style="text-align:left; color:var(--text-muted); font-size:11px; text-transform:uppercase;">
            <th style="padding:8px 10px;">Staff</th><th style="padding:8px 10px;">Role</th><th style="padding:8px 10px; text-align:right;">Sup hrs</th><th style="padding:8px 10px; text-align:right;">Worked hrs</th><th style="padding:8px 10px;">%</th><th style="padding:8px 10px;">Status</th><th></th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="7"><div class="empty-state">No staff.</div></td></tr>`}</tbody>
        </table></div>
      </div>
      ${(d.excluded || []).length ? `<div class="card" style="margin-top:14px;">
        <div class="section-title" style="margin-top:0;">Not on this tracker (${d.excluded.length})</div>
        <p style="font-size:12.5px; color:var(--text-muted); margin:-4px 0 10px;">BCBAs supervise rather than being supervised, so they are left off — a certified BCBA on the list is a permanent 0% that makes the whole board read as non-compliant. Student analysts are RBTs and stay on. If someone is in the wrong place, move them.</p>
        ${d.excluded.map((e) => `<div class="task-row">
          <div class="info"><strong>${esc(e.name)}</strong><div class="due">${esc(e.role_title || "No job title on file")} · ${esc(e.reason)}</div></div>
          <button class="btn small secondary" data-sup-track="${e.employee_id}">Put on the tracker</button>
        </div>`).join("")}
      </div>` : ""}`;
    box.querySelectorAll("[data-sup-emp]").forEach((tr) => tr.addEventListener("click", () => openEditor(tr.dataset.supEmp, curM, () => fillTable(mount))));
    box.querySelectorAll("[data-sup-untrack]").forEach((b) => b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const row = b.closest("tr");
      const who = row ? (row.querySelector("strong") || {}).textContent : "this person";
      if (!confirm(`Take ${who} off the RBT supervision tracker?\n\nUse this for BCBAs, who supervise rather than being supervised. Their logged sessions are kept and they reappear the moment you put them back.`)) return;
      b.disabled = true;
      try {
        await api("/api/supervision/employee/" + b.dataset.supUntrack + "/tracked", { method: "PATCH", body: { tracked: false } });
        await fillTable(mount);
      } catch (e) { b.disabled = false; alert(e.message || "Couldn't update that."); }
    }));
    box.querySelectorAll("[data-sup-track]").forEach((b) => b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      b.disabled = true;
      try {
        await api("/api/supervision/employee/" + b.dataset.supTrack + "/tracked", { method: "PATCH", body: { tracked: true } });
        await fillTable(mount);
      } catch (e) { b.disabled = false; alert(e.message || "Couldn't update that."); }
    }));
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
    // What the month looked like when it was opened. Used to tell an actual
    // correction apart from someone opening a signed month and pressing Save,
    // so a no-op save never demands a reason.
    let baseline = JSON.stringify({ entries: d.entries || [], worked: Number(d.hours_worked) || 0 });
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    document.body.appendChild(bd);
    const close = () => bd.remove();

    // One card per session instead of an eleven-column table. The old layout
    // scrolled sideways, which put the delete button off the right edge of the
    // screen -- present in the markup, invisible in practice. Everything a
    // session needs now fits the width of the modal, and Notes gets a real
    // box instead of a 120px slot.
    function sessionCard(e, i) {
      const isBlank = !e.date && !e.activity && !e.duration;
      return `<div class="sup-session" data-card="${i}" style="border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:12px 14px; margin-bottom:10px; background:var(--bg,#fbfbfd);">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px;">
          <strong style="font-size:12.5px; color:var(--text-muted);">Session ${i + 1}${isBlank ? " — new" : ""}</strong>
          <div style="display:flex; gap:6px;">
            <button class="btn small secondary" data-dup="${i}" title="Copy this session as a new one">Duplicate</button>
            <button class="btn small secondary" data-del="${i}" style="color:#b91c1c; border-color:#fecaca;">Delete</button>
          </div>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px;">
          <label style="font-size:11.5px; color:var(--text-muted);">Date
            <input data-f="date" data-i="${i}" type="date" value="${esc((e.date || "").slice(0, 10))}" style="width:100%;"/></label>
          <label style="font-size:11.5px; color:var(--text-muted);">Activity / Client
            <input data-f="activity" data-i="${i}" value="${esc(e.activity || "")}" placeholder="e.g. Session obs — J.R." style="width:100%;"/></label>
          <label style="font-size:11.5px; color:var(--text-muted);">Time in
            <input data-f="time_in" data-i="${i}" value="${esc(e.time_in || "")}" placeholder="9:00a" style="width:100%;"/></label>
          <label style="font-size:11.5px; color:var(--text-muted);">Time out
            <input data-f="time_out" data-i="${i}" value="${esc(e.time_out || "")}" placeholder="10:30a" style="width:100%;"/></label>
          <label style="font-size:11.5px; color:var(--text-muted);">Duration (hrs)
            <input data-f="duration" data-i="${i}" type="number" step="0.25" value="${esc(e.duration || "")}" style="width:100%;"/></label>
          <label style="font-size:11.5px; color:var(--text-muted);">Supervisor (BCBA)
            <input data-f="supervisor" data-i="${i}" value="${esc(e.supervisor || "")}" placeholder="BCBA name" style="width:100%;"/></label>
          <label style="font-size:11.5px; color:var(--text-muted);">Type
            <select data-f="group" data-i="${i}" style="width:100%;">
              <option ${e.group === "Individual" ? "selected" : ""}>Individual</option>
              <option ${e.group === "Group" ? "selected" : ""}>Group</option>
            </select></label>
        </div>
        <div style="display:flex; gap:18px; margin-top:10px; flex-wrap:wrap;">
          <label style="font-size:12.5px; display:flex; align-items:center; gap:6px;">
            <input data-f="face_to_face" data-i="${i}" type="checkbox" ${e.face_to_face ? "checked" : ""}/> Face-to-face</label>
          <label style="font-size:12.5px; display:flex; align-items:center; gap:6px;">
            <input data-f="observed" data-i="${i}" type="checkbox" ${e.observed ? "checked" : ""}/> Observed with client</label>
        </div>
        <label style="display:block; margin-top:10px; font-size:11.5px; color:var(--text-muted);">Notes
          <textarea data-f="notes" data-i="${i}" rows="2" placeholder="What was covered, feedback given, anything to follow up on…"
            style="width:100%; resize:vertical; font-family:inherit; font-size:13px;">${esc(e.notes || "")}</textarea></label>
      </div>`;
    }

    function render() {
      const sup = entries.reduce((s, e) => s + (parseFloat(e.duration) || 0), 0);
      const worked = d.hours_worked || 0;
      const p = worked ? Math.round((sup / worked) * 1000) / 10 : null;
      const amendments = d.amendments || [];
      bd.innerHTML = `<div class="modal" style="width:min(860px,96vw); max-height:92vh; overflow:auto;">
        <div class="modal-header"><h2>${esc(d.employee.name)} — Supervision (${esc(monthLabel(month))})</h2><button class="close-btn">✕</button></div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:10px;">
          <label style="font-size:12.5px;">Monthly worked hours <input id="sup-worked" type="number" step="0.1" value="${esc(worked)}" style="width:90px;"/></label>
          <span class="tag" style="background:${p == null ? "#fef3c7" : (p >= d.min_pct ? "#dcfce7" : "#fee2e2")}; color:${p == null ? "#92400e" : (p >= d.min_pct ? "#166534" : "#991b1b")};">Supervision: ${sup.toFixed(2)} hrs · ${p == null ? "enter worked hours" : p + "% (min " + d.min_pct + "%)"}</span>
          ${d.has_pdf ? `<a class="btn small secondary" href="/api/supervision/employee/${empId}/pdf?month=${encodeURIComponent(month)}" target="_blank" rel="noopener">Download signed PDF</a>` : ""}
        </div>
        ${d.signed_off ? `<div style="background:#f0fdf4; border:1px solid #bbf7d0; color:#166534; border-radius:10px; padding:10px 12px; font-size:12.5px; margin-bottom:12px;">
          <strong>✓ Signed off by ${esc(d.signed_by || "a BCBA")}</strong>${d.signed_at ? " on " + esc(String(d.signed_at).slice(0, 10)) : ""}.
          You can still correct this month — you'll be asked what changed, and it will go back to needing a fresh sign-off.
        </div>` : ""}
        ${amendments.length ? `<div style="background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:10px; padding:10px 12px; font-size:12.5px; margin-bottom:12px;">
          <strong>Corrected after sign-off</strong>
          ${amendments.map((a) => `<div style="margin-top:4px;">${esc(String(a.changed_at || "").slice(0, 10))} — ${esc(a.changed_by || "someone")}: ${esc(a.reason)}</div>`).join("")}
        </div>` : ""}
        <div id="sup-sessions">${entries.map(sessionCard).join("")}</div>
        <div><button class="btn small secondary" id="sup-add-row">+ Add a session</button></div>
        <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border,#e5e7eb); display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn" id="sup-save">Save</button>
          <input id="sup-signer" placeholder="BCBA name to sign off" style="width:200px;" value="${esc(d.signed_by || "")}"/>
          <button class="btn secondary" id="sup-signoff">Sign off &amp; email</button>
          <span id="sup-status" style="font-size:12.5px; color:var(--text-muted);"></span>
        </div>
      </div>`;
      bd.querySelector(".close-btn").addEventListener("click", close);
      pull();
      // Deleting a session is now a labelled button that asks first. It used to
      // be a bare ✕ that removed a compliance record with no confirmation.
      bd.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
        const i = Number(b.dataset.del);
        const e = entries[i] || {};
        const label = [e.date, e.activity].filter(Boolean).join(" — ") || "this empty session";
        if (!confirm(`Delete ${label}?` + (d.signed_off ? "\n\nThis month is signed off, so you'll be asked what changed when you save." : ""))) return;
        entries.splice(i, 1);
        if (!entries.length) entries = [BLANK()];
        render();
      }));
      bd.querySelectorAll("[data-dup]").forEach((b) => b.addEventListener("click", () => {
        const src = entries[Number(b.dataset.dup)] || BLANK();
        entries.splice(Number(b.dataset.dup) + 1, 0, Object.assign({}, src));
        render();
      }));
      bd.querySelector("#sup-add-row").addEventListener("click", () => { entries.push(BLANK()); render(); });
      bd.querySelector("#sup-save").addEventListener("click", () => save(false));
      bd.querySelector("#sup-signoff").addEventListener("click", () => signOff());
    }
    function pull() {
      bd.querySelectorAll("[data-f]").forEach((el) => {
        const i = Number(el.dataset.i), f = el.dataset.f;
        // "input" as well as "change": a textarea the user is still typing in
        // when they hit Save would otherwise lose its last edit.
        const sync = () => { entries[i][f] = (el.type === "checkbox") ? el.checked : el.value; };
        el.addEventListener("change", sync);
        el.addEventListener("input", sync);
      });
    }
    async function save(silent, reasonOverride) {
      const worked = parseFloat(bd.querySelector("#sup-worked").value) || 0;
      const st = bd.querySelector("#sup-status"); if (!silent) st.textContent = "Saving…";
      const body = { month, entries, hours_worked: worked };
      // The editor already knows the month is signed off, so ask before the
      // save rather than letting it fail and asking afterwards. The server
      // still refuses a reasonless change -- that guard is the real one, this
      // is only so the person isn't shown an error they didn't need to see.
      const dirty = JSON.stringify({ entries, worked }) !== baseline;
      let reason = reasonOverride;
      if (!reason && d.signed_off && dirty) {
        reason = prompt(
          `${monthLabel(month)} has already been signed off by ${d.signed_by || "a BCBA"}.\n\n` +
          "What are you correcting? This is recorded, and the month goes back to needing a fresh BCBA sign-off."
        );
        if (!reason || !reason.trim()) {
          if (!silent) st.textContent = "Not saved — the signed month is unchanged.";
          return false;
        }
        reason = reason.trim();
      }
      if (reason) body.change_reason = reason;
      try {
        const r = await api("/api/supervision/employee/" + empId, { method: "POST", body });
        baseline = JSON.stringify({ entries, worked });
        if (r && r.amended) {
          d.signed_off = false; d.signed_by = null; d.signed_at = null; d.has_pdf = false;
          d.hours_worked = worked;
          try {
            const fresh = await api("/api/supervision/employee/" + empId + "?month=" + encodeURIComponent(month));
            d.amendments = fresh.amendments || [];
          } catch (x) {}
          if (!silent) { render(); bd.querySelector("#sup-status").textContent = "Saved ✓ — this month needs a fresh sign-off."; }
          return true;
        }
        if (!silent) { st.textContent = "Saved ✓"; d.hours_worked = worked; }
        return true;
      } catch (e) {
        // The server refuses to quietly rewrite a signed month. Ask why, then
        // retry the same save with the reason attached.
        const msg = String((e && e.message) || "");
        if (!reason && /signed off by/i.test(msg)) {
          // Backstop: the record was signed off by someone else after this
          // editor was opened, so the page's own copy said otherwise.
          const late = prompt(
            `${monthLabel(month)} was signed off while you had this open. What are you correcting?\n\n` +
            "Saving will record this and put the month back to needing a fresh BCBA sign-off."
          );
          if (late && late.trim()) return save(silent, late.trim());
          st.textContent = "Not saved — the signed month is unchanged.";
          return false;
        }
        st.textContent = msg || "Failed.";
        return false;
      }
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
      <span style="font-size:12px; color:var(--text-muted);">${d.sup_hours} sup hrs / ${d.hours_worked || "—"} worked${d.hours_current_through ? ` · hours through ${esc(dayLabel(d.hours_current_through))}` : ""}</span>
      <button class="btn small" data-open-sup>Open tracker</button>
      ${d.signed_off ? `<span class="tag" style="background:#dcfce7; color:#166534;">✓ signed</span>` : ""}
    </div>${hist ? `<div style="margin-top:6px;">${hist}</div>` : ""}`;
    const btn = container.querySelector("[data-open-sup]");
    if (btn) btn.addEventListener("click", () => openEditor(empId, month, () => renderStaffSection(container, empId)));
  }

  window.__renderSupervision = function (mount) { return renderSupervision(mount); };
  window.HRSupervision = { openEditor: openEditor, renderStaffSection: renderStaffSection };
})();
