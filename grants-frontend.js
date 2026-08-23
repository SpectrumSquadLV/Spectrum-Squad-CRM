// grants-frontend.js -- Grant Finder screens.
//
// Built around the six questions the module exists to answer, in this order:
// what money is available, do we qualify, how much, what for, when is it due,
// what do I do next. Every screen is arranged so those are readable without
// clicking into anything.
//
// The one rule that shapes the design: eligibility is shown before relevance.
// A 90% match that is nonprofit-only is a waste of an afternoon, so the
// disqualification flags sit at the top of the card in red, above the score.
//
// Mirrors the other frontend modules: renders into the mount the native router
// hands it, exposes window.__renderGrants, styles in its own <style> block.
(function () {
  "use strict";

  // Same shape the other frontend modules use: prefer the shell's api() so
  // session handling stays in one place, fall back to fetch if this module is
  // ever loaded before it.
  async function api(path, opts) {
    if (typeof window.api === "function") return window.api(path, opts);
    const res = await fetch(path, {
      method: (opts && opts.method) || "GET",
      headers: { "Content-Type": "application/json" },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
    return data;
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let META = null;                 // categories, priorities, statuses
  const state = { tab: "dashboard", filters: {}, openApplication: null };

  function injectStyles() {
    if (document.getElementById("gf-styles")) return;
    const st = document.createElement("style");
    st.id = "gf-styles";
    st.textContent = `
      .gf-tabs { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px; }
      .gf-tab { border:1px solid var(--border,#e5e7eb); background:#fff; color:var(--text-muted,#6b7280);
        border-radius:999px; padding:7px 14px; font-size:13px; font-weight:700; cursor:pointer; }
      .gf-tab:hover { border-color:#1b2a6b; color:#1b2a6b; }
      .gf-tab.active { background:#1b2a6b; color:#fff; border-color:#1b2a6b; }
      .gf-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:20px; }
      .gf-stat { background:#fff; border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:13px 15px; }
      .gf-stat b { display:block; font-size:23px; color:#1b2a6b; line-height:1.25; }
      .gf-stat span { font-size:12px; color:var(--text-muted,#6b7280); }
      .gf-stat.money b { color:#0f7a5a; }
      .gf-card { background:#fff; border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:15px 17px; margin-bottom:12px; }
      .gf-card h4 { margin:0 0 2px; font-size:16px; color:#1b2a6b; }
      .gf-funder { font-size:12.5px; color:var(--text-muted,#6b7280); margin-bottom:9px; }
      .gf-score { float:right; text-align:center; margin-left:14px; }
      .gf-score b { display:block; font-size:21px; line-height:1.1; }
      .gf-score span { font-size:10.5px; color:var(--text-muted,#6b7280); text-transform:uppercase; letter-spacing:.4px; }
      .gf-s-hi b { color:#0f7a5a; } .gf-s-mid b { color:#a56b00; } .gf-s-lo b { color:#9aa1ab; }
      .gf-badges { display:flex; flex-wrap:wrap; gap:5px; margin:8px 0; }
      .gf-badge { font-size:11px; font-weight:700; border-radius:999px; padding:3px 9px; background:#eef1fb; color:#1b2a6b; }
      .gf-elig { font-size:11.5px; font-weight:800; border-radius:999px; padding:3px 10px; }
      .gf-e-eligible { background:#dcfce7; color:#166534; }
      .gf-e-possibly_eligible { background:#fef9c3; color:#854d0e; }
      .gf-e-needs_review { background:#e5e7eb; color:#374151; }
      .gf-e-likely_ineligible { background:#fee2e2; color:#991b1b; }
      .gf-flags { background:#fef2f2; border:1px solid #fecaca; color:#991b1b; border-radius:8px;
        padding:8px 11px; font-size:12.5px; margin:9px 0; }
      .gf-flags b { display:block; margin-bottom:3px; }
      .gf-why { background:#f8fafc; border-left:3px solid #5fa8a0; padding:8px 12px; font-size:13px;
        color:#334155; border-radius:0 8px 8px 0; margin:9px 0; }
      .gf-meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:7px 16px; font-size:12.5px; margin:10px 0; }
      .gf-meta div span { color:var(--text-muted,#6b7280); }
      .gf-actions { display:flex; gap:7px; flex-wrap:wrap; margin-top:11px; }
      .gf-btn { border:1px solid var(--border,#e5e7eb); background:#fff; border-radius:8px; padding:6px 13px;
        font-size:12.5px; font-weight:700; cursor:pointer; color:#1b2a6b; }
      .gf-btn:hover { border-color:#1b2a6b; }
      .gf-btn.primary { background:#1b2a6b; color:#fff; border-color:#1b2a6b; }
      .gf-btn.danger { color:#991b1b; }
      .gf-filters { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
      .gf-filters input, .gf-filters select { border:1px solid var(--border,#e5e7eb); border-radius:8px;
        padding:7px 10px; font-size:13px; }
      .gf-form { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:12px; }
      .gf-form label { display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:3px; }
      .gf-form input, .gf-form select, .gf-form textarea { width:100%; border:1px solid var(--border,#e5e7eb);
        border-radius:8px; padding:7px 10px; font-size:13px; box-sizing:border-box; }
      .gf-form .wide { grid-column:1/-1; }
      .gf-checks { display:flex; flex-wrap:wrap; gap:6px; }
      .gf-check { border:1px solid var(--border,#e5e7eb); border-radius:999px; padding:5px 11px; font-size:12px; cursor:pointer; }
      .gf-check.on { background:#1b2a6b; color:#fff; border-color:#1b2a6b; }
      .gf-empty { text-align:center; color:var(--text-muted,#6b7280); padding:34px 16px; font-size:14px; }
      .gf-soon { background:#f8fafc; border:1px dashed var(--border,#cbd5e1); border-radius:12px;
        padding:22px; color:#475569; font-size:13.5px; }
      .gf-soon h4 { margin:0 0 7px; color:#1b2a6b; }
      .gf-redact { color:#9aa1ab; font-style:italic; }
    `;
    document.head.appendChild(st);
  }

  const money = (n) => (n === null || n === undefined || n === "" ? "—"
    : "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }));
  const scoreClass = (s) => (s >= 70 ? "gf-s-hi" : s >= 40 ? "gf-s-mid" : "gf-s-lo");
  const yesNo = (v) => (v === true ? "Yes" : v === false ? "No" : "Unclear");

  function daysOut(deadline) {
    if (!deadline) return null;
    const d = Math.ceil((new Date(deadline + "T00:00:00Z") - Date.now()) / 86400000);
    return Number.isFinite(d) ? d : null;
  }

  // ------------------------------------------------------------------ card
  function grantCard(g, opts = {}) {
    const d = daysOut(g.deadline);
    const due = g.deadline
      ? `${esc(g.deadline)}${d !== null ? ` <span style="color:${d < 0 ? "#991b1b" : d <= 30 ? "#a56b00" : "#6b7280"};">(${d < 0 ? "closed" : d + " days"})</span>` : ""}`
      : "—";
    return `
      <div class="gf-card" data-grant="${g.id}">
        <div class="gf-score ${scoreClass(g.match_score)}">
          <b>${g.match_score}%</b><span>match</span>
        </div>
        <h4>${esc(g.name)}</h4>
        <div class="gf-funder">${esc(g.funder || "Funding organisation not recorded")}</div>

        <span class="gf-elig gf-e-${g.eligibility_status}">${esc(g.eligibility_label)}</span>

        ${g.disqualification_flags && g.disqualification_flags.length ? `
          <div class="gf-flags">
            <b>Check before you spend time on this</b>
            ${g.disqualification_flags.map((f) => esc(f)).join(" · ")}
          </div>` : ""}

        <div class="gf-why"><strong>Why this matches Spectrum Squad:</strong> ${esc(g.match_explanation)}</div>
        ${g.eligibility_explanation ? `<div style="font-size:12.5px;color:#475569;margin:7px 0;">${esc(g.eligibility_explanation)}</div>` : ""}

        <div class="gf-meta">
          <div><span>Potential award</span><br><strong>${money(g.expected_award || g.amount_max)}</strong></div>
          <div><span>Deadline</span><br><strong>${due}</strong></div>
          <div><span>Location eligibility</span><br><strong>${esc(g.geographic_eligibility || "Not recorded")}</strong></div>
          <div><span>For-profit eligible</span><br><strong>${yesNo(g.for_profit_allowed)}</strong></div>
          <div><span>Veteran-owned preference</span><br><strong>${yesNo(g.veteran_preference)}</strong></div>
          <div><span>Woman-owned preference</span><br><strong>${yesNo(g.woman_preference)}</strong></div>
          <div><span>Status</span><br><strong>${esc(g.status)}</strong></div>
        </div>

        ${g.tags && g.tags.length ? `<div class="gf-badges">${g.tags.map((t) => `<span class="gf-badge">${esc((META.categories.find((c) => c.key === t) || {}).label || t)}</span>`).join("")}</div>` : ""}

        <div class="gf-actions">
          ${g.source_url ? `<a class="gf-btn" href="${esc(g.source_url)}" target="_blank" rel="noopener">View grant</a>` : ""}
          ${opts.saved
            ? `<button class="gf-btn" data-act="unsave" data-id="${g.id}">Remove from saved</button>`
            : `<button class="gf-btn" data-act="save" data-id="${g.id}">Save</button>`}
          <button class="gf-btn primary" data-act="start" data-id="${g.id}">Start application</button>
          <button class="gf-btn" data-act="ai" data-id="${g.id}">Ask the assistant</button>
          <button class="gf-btn" data-act="edit" data-id="${g.id}">Edit</button>
          <button class="gf-btn danger" data-act="dismiss" data-id="${g.id}">Dismiss</button>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------- dashboard
  async function renderDashboard(el) {
    const d = await api("/api/grants/dashboard");
    const t = d.totals;
    el.innerHTML = `
      <div class="gf-stats">
        <div class="gf-stat"><b>${t.active}</b><span>Active opportunities</span></div>
        <div class="gf-stat"><b>${t.high_match}</b><span>High match (70%+)</span></div>
        <div class="gf-stat"><b>${t.closing_30}</b><span>Closing in 30 days</span></div>
        <div class="gf-stat"><b>${t.preparing}</b><span>Applications in progress</span></div>
        <div class="gf-stat"><b>${t.submitted}</b><span>Submitted</span></div>
        <div class="gf-stat"><b>${t.awarded}</b><span>Awarded</span></div>
        <div class="gf-stat"><b>${t.declined}</b><span>Declined</span></div>
        <div class="gf-stat money"><b>${money(t.potential_funding)}</b><span>Potential funding available</span></div>
      </div>

      <h3 style="color:#1b2a6b;margin:22px 0 10px;">Top opportunities for Spectrum Squad</h3>
      <p style="font-size:12.5px;color:#6b7280;margin:-6px 0 12px;">
        Ranked by match score. Anything we are likely ineligible for is left out of this list.</p>
      <div id="gf-top">${d.top.length ? d.top.map((g) => grantCard(g)).join("") : `<div class="gf-empty">No opportunities yet. Add one from the Opportunities tab.</div>`}</div>

      <h3 style="color:#1b2a6b;margin:26px 0 10px;">Upcoming deadlines</h3>
      ${d.deadlines.length ? `<div class="gf-card" style="padding:0;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tbody>${d.deadlines.map((g) => {
            const dd = daysOut(g.deadline);
            return `<tr style="border-bottom:1px solid var(--border,#eef0f4);">
              <td style="padding:9px 14px;"><strong>${esc(g.name)}</strong><br><span style="color:#6b7280;font-size:12px;">${esc(g.funder || "")}</span></td>
              <td style="padding:9px 14px;white-space:nowrap;">
                <span class="gf-elig gf-e-${g.eligibility_status}">${esc(g.eligibility_label)}</span></td>
              <td style="padding:9px 14px;white-space:nowrap;">${esc(g.deadline)}</td>
              <td style="padding:9px 14px;white-space:nowrap;color:${dd !== null && dd <= 14 ? "#991b1b" : "#6b7280"};">${dd === null ? "" : dd + " days"}</td>
              <td style="padding:9px 14px;white-space:nowrap;">${money(g.expected_award || g.amount_max)}</td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>` : `<div class="gf-empty">Nothing closing in the next 30 days.</div>`}
    `;
    wireCards(el);
  }

  // ---------------------------------------------------------- opportunities
  async function renderOpportunities(el, opts = {}) {
    const f = state.filters;
    const qs = new URLSearchParams();
    if (f.q) qs.set("q", f.q);
    if (f.tag) qs.set("tag", f.tag);
    if (f.eligibility) qs.set("eligibility", f.eligibility);
    if (f.status) qs.set("status", f.status);
    if (opts.savedOnly) qs.set("status", "");
    const { grants } = await api("/api/grants/opportunities" + (qs.toString() ? "?" + qs : ""));
    const list = opts.savedOnly ? grants.filter((g) => g.saved_at) : grants;

    el.innerHTML = `
      <div class="gf-filters">
        <input id="gf-q" placeholder="Search grants, funders, populations…" value="${esc(f.q || "")}" style="min-width:260px;" />
        <select id="gf-tag"><option value="">All categories</option>
          ${META.categories.map((c) => `<option value="${c.key}"${f.tag === c.key ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
        <select id="gf-elig"><option value="">All eligibility</option>
          ${Object.entries(META.eligibility_labels).map(([k, v]) => `<option value="${k}"${f.eligibility === k ? " selected" : ""}>${esc(v)}</option>`).join("")}</select>
        <select id="gf-status"><option value="">All statuses</option>
          ${META.statuses.map((s) => `<option value="${s}"${f.status === s ? " selected" : ""}>${esc(s)}</option>`).join("")}</select>
        <button class="gf-btn" id="gf-clear">Clear</button>
        <button class="gf-btn primary" id="gf-add" style="margin-left:auto;">+ Add grant</button>
      </div>
      <div id="gf-form-slot"></div>
      <div id="gf-list">${list.length ? list.map((g) => grantCard(g, { saved: opts.savedOnly })).join("")
        : `<div class="gf-empty">${opts.savedOnly ? "No saved grants yet." : "No opportunities match. Add one with “Add grant”."}</div>`}</div>
    `;

    const rerender = () => (opts.savedOnly ? renderSaved(el) : renderOpportunities(el));
    el.querySelector("#gf-q").addEventListener("change", (e) => { state.filters.q = e.target.value.trim(); rerender(); });
    el.querySelector("#gf-tag").addEventListener("change", (e) => { state.filters.tag = e.target.value; rerender(); });
    el.querySelector("#gf-elig").addEventListener("change", (e) => { state.filters.eligibility = e.target.value; rerender(); });
    el.querySelector("#gf-status").addEventListener("change", (e) => { state.filters.status = e.target.value; rerender(); });
    el.querySelector("#gf-clear").addEventListener("click", () => { state.filters = {}; rerender(); });
    el.querySelector("#gf-add").addEventListener("click", () => openForm(el.querySelector("#gf-form-slot"), null, rerender));
    wireCards(el, rerender);
  }

  const renderSaved = (el) => renderOpportunities(el, { savedOnly: true });

  // --------------------------------------------------------- add / edit form
  async function openForm(slot, grant, done) {
    const g = grant || {};
    const tags = new Set(g.tags || []);
    const bool = (name, label) => `
      <div><label>${label}</label>
        <select name="${name}">
          <option value=""${g[name] === null || g[name] === undefined ? " selected" : ""}>Unclear / not recorded</option>
          <option value="true"${g[name] === true ? " selected" : ""}>Yes</option>
          <option value="false"${g[name] === false ? " selected" : ""}>No</option>
        </select></div>`;
    slot.innerHTML = `
      <div class="gf-card">
        <h4>${grant ? "Edit grant" : "Add a grant"}</h4>
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 12px;">
          Leave anything you have not read yet as “Unclear”. Blank is treated as unknown, never as a yes —
          the eligibility verdict says what still needs checking.</p>
        <form id="gf-form" class="gf-form">
          <div class="wide"><label>Grant name *</label><input name="name" required value="${esc(g.name || "")}" /></div>
          <div><label>Funding organisation</label><input name="funder" value="${esc(g.funder || "")}" /></div>
          <div><label>Opportunity number</label><input name="opportunity_number" value="${esc(g.opportunity_number || "")}" /></div>
          <div><label>Source URL</label><input name="source_url" value="${esc(g.source_url || "")}" /></div>
          <div><label>Application URL</label><input name="application_url" value="${esc(g.application_url || "")}" /></div>
          <div class="wide"><label>Description</label><textarea name="description" rows="3">${esc(g.description || "")}</textarea></div>

          <div><label>Minimum award</label><input name="amount_min" value="${esc(g.amount_min || "")}" /></div>
          <div><label>Maximum award</label><input name="amount_max" value="${esc(g.amount_max || "")}" /></div>
          <div><label>Expected award</label><input name="expected_award" value="${esc(g.expected_award || "")}" /></div>
          <div><label>Opens</label><input name="opening_date" type="date" value="${esc(g.opening_date || "")}" /></div>
          <div><label>Deadline</label><input name="deadline" type="date" value="${esc(g.deadline || "")}" /></div>

          <div class="wide"><label>Geographic eligibility</label>
            <input name="geographic_eligibility" placeholder="e.g. Nevada, or National" value="${esc(g.geographic_eligibility || "")}" /></div>
          <div class="wide"><label>Applicant eligibility (as written in the notice)</label>
            <textarea name="applicant_eligibility" rows="2">${esc(g.applicant_eligibility || "")}</textarea></div>

          ${bool("for_profit_allowed", "For-profit allowed")}
          ${bool("nonprofit_required", "Nonprofit required")}
          ${bool("small_business_eligible", "Small business eligible")}
          ${bool("government_only", "Government only")}
          ${bool("university_only", "University only")}
          ${bool("school_district_only", "School district only")}
          ${bool("tribal_only", "Tribal organisation only")}
          ${bool("research_institution_only", "Research institution only")}
          ${bool("veteran_preference", "Veteran-owned preference")}
          ${bool("woman_preference", "Woman-owned preference")}
          ${bool("matching_funds_required", "Matching funds required")}
          ${bool("partnerships_required", "Partnership required")}
          ${bool("sam_required", "SAM.gov registration required")}
          ${bool("uei_required", "UEI required")}

          <div><label>Minimum years in business</label><input name="min_years_in_business" value="${esc(g.min_years_in_business || "")}" /></div>
          <div><label>Minimum annual revenue</label><input name="min_annual_revenue" value="${esc(g.min_annual_revenue || "")}" /></div>
          <div><label>Maximum employees</label><input name="max_employees" value="${esc(g.max_employees || "")}" /></div>

          <div class="wide"><label>Target population</label><input name="target_population" value="${esc(g.target_population || "")}" /></div>
          <div class="wide"><label>What could Spectrum Squad use this for?</label>
            <textarea name="potential_use" rows="2">${esc(g.potential_use || "")}</textarea></div>
          <div><label>Application complexity</label>
            <select name="complexity">${["", "Low", "Medium", "High"].map((c) => `<option${g.complexity === c ? " selected" : ""}>${c}</option>`).join("")}</select></div>
          <div><label>Status</label>
            <select name="status">${META.statuses.map((s) => `<option${(g.status || "New") === s ? " selected" : ""}>${s}</option>`).join("")}</select></div>
          <div class="wide"><label>Documents needed</label><textarea name="documents_needed" rows="2">${esc(g.documents_needed || "")}</textarea></div>
          <div class="wide"><label>Notes</label><textarea name="notes" rows="2">${esc(g.notes || "")}</textarea></div>

          <div class="wide"><label>Categories — these drive the match score</label>
            <div class="gf-checks" id="gf-tags">
              ${META.categories.map((c) => `<span class="gf-check${tags.has(c.key) ? " on" : ""}" data-tag="${c.key}">${esc(c.label)}</span>`).join("")}
            </div></div>

          <div class="wide gf-actions">
            <button type="submit" class="gf-btn primary">${grant ? "Save changes" : "Add grant"}</button>
            <button type="button" class="gf-btn" id="gf-cancel">Cancel</button>
            <span id="gf-err" style="color:#991b1b;font-size:12.5px;align-self:center;"></span>
          </div>
        </form>
      </div>`;

    slot.querySelectorAll("#gf-tags .gf-check").forEach((c) =>
      c.addEventListener("click", () => c.classList.toggle("on")));
    slot.querySelector("#gf-cancel").addEventListener("click", () => { slot.innerHTML = ""; });
    slot.querySelector("#gf-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {};
      fd.forEach((v, k) => { body[k] = v === "" ? null : v; });
      body.tags = [...slot.querySelectorAll("#gf-tags .gf-check.on")].map((c) => c.dataset.tag);
      try {
        if (grant) await api(`/api/grants/opportunities/${grant.id}`, { method: "PATCH", body });
        else await api("/api/grants/opportunities", { method: "POST", body });
        slot.innerHTML = "";
        done && done();
      } catch (err) {
        slot.querySelector("#gf-err").textContent = err.message;
      }
    });
  }

  function wireCards(el, rerender) {
    const again = rerender || (() => render(document.getElementById("view-mount")));
    el.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        if (act === "edit") {
          const { grant } = await api(`/api/grants/opportunities/${id}`);
          let slot = el.querySelector("#gf-form-slot");
          if (!slot) { slot = document.createElement("div"); el.prepend(slot); }
          openForm(slot, grant, again);
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        if (act === "ai") {
          const card = btn.closest(".gf-card");
          let slot = card.querySelector(".gf-ai-slot");
          if (slot) { slot.remove(); return; }   // second click closes it
          slot = document.createElement("div");
          slot.className = "gf-ai-slot";
          card.appendChild(slot);
          return assistantPanel(slot, { grantId: Number(id) });
        }
        if (act === "start") {
          const r = await api("/api/grants/applications", { method: "POST", body: { grant_id: Number(id) } });
          state.tab = "applications";
          state.openApplication = r.application.id;
          return render(document.getElementById("view-mount"));
        }
        if (act === "dismiss" && !confirm("Dismiss this grant? It stays in the database but drops off the lists.")) return;
        await api(`/api/grants/opportunities/${id}/${act}`, { method: "POST" });
        again();
      });
    });
  }

  // ---------------------------------------------------------------- profile
  async function renderProfile(el) {
    const { profile: p, can_edit_sensitive } = await api("/api/grants/profile");
    const { priorities } = await api("/api/grants/priorities");
    const txt = (n, l, v) => `<div><label>${l}</label><input name="${n}" value="${esc(v == null ? "" : v)}" /></div>`;
    const area = (n, l, v) => `<div class="wide"><label>${l}</label><textarea name="${n}" rows="2">${esc(v || "")}</textarea></div>`;
    const yn = (n, l, v) => `<div><label>${l}</label><select name="${n}">
      <option value=""${v === null || v === undefined ? " selected" : ""}>Not set</option>
      <option value="true"${v === true ? " selected" : ""}>Yes</option>
      <option value="false"${v === false ? " selected" : ""}>No</option></select></div>`;

    el.innerHTML = `
      <div class="gf-card">
        <h4>Organisation profile</h4>
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 13px;">
          This is what every grant is matched against, and what later phases will draw narratives from.
          The more of it that is filled in, the sharper the eligibility verdicts get.</p>
        <form id="gf-profile" class="gf-form">
          ${txt("company_name", "Company name", p.company_name)}
          ${txt("legal_name", "Legal entity name", p.legal_name)}
          ${txt("business_type", "Business type", p.business_type)}
          ${yn("for_profit", "For-profit", p.for_profit)}
          ${txt("state", "State", p.state)}
          ${txt("county", "County", p.county)}
          ${txt("cities_served", "Cities served", p.cities_served)}
          ${txt("year_founded", "Year founded", p.year_founded)}
          ${yn("woman_owned", "Woman-owned", p.woman_owned)}
          ${yn("veteran_owned", "Veteran-owned", p.veteran_owned)}
          ${yn("minority_owned", "Minority-owned", p.minority_owned)}
          ${yn("small_business", "Small business", p.small_business)}
          ${txt("industry", "Industry", p.industry)}
          ${txt("naics_codes", "NAICS codes", p.naics_codes)}
          ${txt("npi", "NPI", p.npi)}
          ${txt("employee_count", "Employees", p.employee_count)}
          ${txt("clients_served", "Clients served", p.clients_served)}
          ${txt("age_groups", "Age groups served", p.age_groups)}
          ${area("populations_served", "Populations served", p.populations_served)}
          ${area("services", "Services provided", p.services)}
          ${area("mission", "Mission", p.mission)}
          ${area("description", "Company description", p.description)}
          ${area("community_impact", "Community impact", p.community_impact)}
          ${area("workforce_programs", "Workforce programs", p.workforce_programs)}
          ${area("rbt_training_program", "RBT training program", p.rbt_training_program)}
          ${area("school_partnerships", "School partnerships", p.school_partnerships)}
          ${area("clinic_locations", "Clinic locations", p.clinic_locations)}
          ${area("expansion_areas", "Areas of expansion", p.expansion_areas)}
          ${txt("certifications", "Certifications", p.certifications)}
          ${txt("licenses", "Licenses", p.licenses)}
          ${txt("accreditations", "Accreditations", p.accreditations)}

          <div class="wide" style="border-top:1px solid var(--border,#e5e7eb);padding-top:13px;margin-top:6px;">
            <strong style="color:#1b2a6b;font-size:13.5px;">Registration and financial details</strong>
            <p style="font-size:12px;color:#6b7280;margin:3px 0 0;">
              ${can_edit_sensitive
                ? "Visible to owner accounts only. Several federal grants cannot be applied for without these."
                : "Restricted to owner accounts. You can see whether they are on file, not what they are."}</p>
          </div>
          ${can_edit_sensitive ? `
            ${yn("sam_registered", "SAM.gov registration active", p.sam_registered)}
            ${txt("uei", "UEI", p.uei)}
            ${txt("ein", "EIN", p.ein)}
            ${txt("duns", "DUNS", p.duns)}
            ${txt("annual_revenue_range", "Annual revenue range", p.annual_revenue_range)}
          ` : `
            <div class="wide gf-redact">On file: ${(p._redacted || []).length ? esc((p._redacted || []).join(", ")) : "none of these are filled in yet"}.</div>
          `}

          <div class="wide gf-actions">
            <button type="submit" class="gf-btn primary">Save profile</button>
            <span id="gf-perr" style="color:#991b1b;font-size:12.5px;align-self:center;"></span>
          </div>
        </form>
      </div>

      <div class="gf-card">
        <h4>What we need money for</h4>
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 11px;">
          Grants that fund these get extra weight in the match score, so the dashboard reorders itself
          around what you are actually trying to pay for.</p>
        <div class="gf-checks" id="gf-priorities">
          ${priorities.map((pr) => `<span class="gf-check${pr.selected ? " on" : ""}" data-key="${pr.key}">${esc(pr.label)}</span>`).join("")}
        </div>
        <div class="gf-actions"><button class="gf-btn primary" id="gf-save-pri">Save priorities</button>
          <span id="gf-prierr" style="font-size:12.5px;align-self:center;color:#0f7a5a;"></span></div>
      </div>`;

    el.querySelectorAll("#gf-priorities .gf-check").forEach((c) =>
      c.addEventListener("click", () => c.classList.toggle("on")));

    el.querySelector("#gf-save-pri").addEventListener("click", async () => {
      const keys = [...el.querySelectorAll("#gf-priorities .gf-check.on")].map((c) => c.dataset.key);
      const r = await api("/api/grants/priorities", { method: "PUT", body: { keys } });
      el.querySelector("#gf-prierr").textContent = `Saved. ${r.rescored} grant(s) rescored.`;
    });

    el.querySelector("#gf-profile").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {};
      fd.forEach((v, k) => { body[k] = v === "" ? null : v; });
      try {
        const r = await api("/api/grants/profile", { method: "PATCH", body });
        el.querySelector("#gf-perr").style.color = "#0f7a5a";
        el.querySelector("#gf-perr").textContent = `Saved. ${r.rescored} grant(s) rescored.`;
      } catch (err) { el.querySelector("#gf-perr").textContent = err.message; }
    });
  }

  // ---------------------------------------------------------------- sources
  async function renderSources(el) {
    const { sources } = await api("/api/grants/sources");
    const INTEGRATION = {
      api_available: ["#166534", "#dcfce7", "API available — can be automated in Phase 4"],
      portal_only: ["#854d0e", "#fef9c3", "Website only — check by hand for now"],
      manual: ["#374151", "#e5e7eb", "Tracked manually"],
    };
    const { connectors } = await api("/api/grants/connectors");
    const { runs } = await api("/api/grants/discovery/runs");
    const when = (t) => (t ? new Date(t).toLocaleString() : "never");

    el.innerHTML = `
      <div class="gf-card">
        <h4>Automated sources</h4>
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 10px;">
          These pull opportunities in on their own, once a day. Anything imported arrives as
          <strong>needs review</strong> — a funder's eligibility wording is copied across for a person to read,
          never turned into a yes by the importer.</p>
        ${connectors.map((c) => `
          <div style="border:1px solid var(--border,#eef0f4);border-radius:8px;padding:11px 13px;margin-bottom:9px;">
            <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;">
              <strong>${esc(c.label)}</strong>
              <span class="gf-elig" style="background:${c.available ? "#dcfce7" : "#fef9c3"};color:${c.available ? "#166534" : "#854d0e"};">
                ${c.available ? "Ready" : esc(c.reason || "Not configured")}</span>
              ${c.verified ? "" : `<span class="gf-elig" style="background:#e5e7eb;color:#374151;">Unverified against the live service</span>`}
              <span style="margin-left:auto;font-size:12px;color:#6b7280;">Last run: ${esc(when(c.last_run && c.last_run.finished_at))}</span>
              ${c.available ? `<button class="gf-btn" data-test="${esc(c.key)}">Test fetch</button>
                <button class="gf-btn" data-run="${esc(c.key)}">Run now</button>` : ""}
            </div>
            ${c.note ? `<p style="margin:7px 0 0;font-size:12px;color:#6b7280;">${esc(c.note)}</p>` : ""}
            ${c.last_run ? `<p style="margin:6px 0 0;font-size:12px;color:${c.last_run.ok ? "#374151" : "#b91c1c"};">
              ${!c.last_run.ok ? `Failed: ${esc(c.last_run.error || "no reason recorded")}`
                : c.last_run.dry_run ? `Test fetch only — ${c.last_run.fetched} returned, nothing imported.`
                : `Found ${c.last_run.fetched}, imported ${c.last_run.imported}, ${c.last_run.duplicates} already tracked${Number(c.last_run.high_matches) ? `, ${c.last_run.high_matches} scoring 70%+` : ""}.`}</p>` : ""}
            ${c.docs ? `<p style="margin:5px 0 0;font-size:12px;"><a href="${esc(c.docs)}" target="_blank" rel="noopener">API documentation</a></p>` : ""}
            <div class="gf-testout" data-for="${esc(c.key)}" style="display:none;margin-top:8px;"></div>
          </div>`).join("")}
      </div>

      <div class="gf-card">
        <h4>Paste an export</h4>
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 8px;">
          The path that needs no integration at all: paste a JSON array of opportunities from any portal.
          Duplicates are skipped, and these are held to exactly the same rule — nothing arrives marked eligible.</p>
        <textarea id="gf-paste" rows="6" placeholder='[{"name": "...", "funder": "...", "deadline": "2027-03-31", "description": "..."}]'
          style="width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:9px;border:1px solid var(--border,#dfe3ea);border-radius:7px;"></textarea>
        <div style="margin-top:8px;"><button class="gf-btn primary" id="gf-paste-go">Import</button>
          <span id="gf-paste-msg" style="margin-left:10px;font-size:12.5px;"></span></div>
      </div>

      ${runs.length ? `<div class="gf-card">
        <h4>Recent runs</h4>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
          <thead><tr style="background:#f8fafc;">
            <th style="text-align:left;padding:7px 10px;">Source</th>
            <th style="text-align:left;padding:7px 10px;">When</th>
            <th style="text-align:left;padding:7px 10px;">Result</th>
            <th style="text-align:left;padding:7px 10px;">Run by</th>
          </tr></thead>
          <tbody>${runs.map((r) => `<tr style="border-top:1px solid var(--border,#eef0f4);">
            <td style="padding:7px 10px;">${esc(r.source_key)}</td>
            <td style="padding:7px 10px;">${esc(when(r.finished_at))}</td>
            <td style="padding:7px 10px;color:${r.ok ? "#374151" : "#b91c1c"};">${!r.ok ? esc(r.error || "failed")
              : r.dry_run ? `test fetch &middot; ${r.fetched} returned &middot; nothing imported`
              : `${r.fetched} found &middot; ${r.imported} imported &middot; ${r.duplicates} duplicate`}</td>
            <td style="padding:7px 10px;color:#6b7280;">${esc(r.triggered_by || "schedule")}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>` : ""}

      <div class="gf-card">
        <h4>Where else opportunities come from</h4>
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 4px;">
          Sources checked by hand. The integration column records what each would take to automate,
          so the work can be scoped rather than guessed at.</p>
      </div>
      <div class="gf-card" style="padding:0;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="background:#f8fafc;">
            <th style="text-align:left;padding:9px 14px;">Source</th>
            <th style="text-align:left;padding:9px 14px;">Type</th>
            <th style="text-align:left;padding:9px 14px;">Integration</th>
            <th style="padding:9px 14px;"></th>
          </tr></thead>
          <tbody>${sources.map((s) => {
            const [fg, bg, label] = INTEGRATION[s.integration] || INTEGRATION.manual;
            return `<tr style="border-top:1px solid var(--border,#eef0f4);">
              <td style="padding:9px 14px;"><strong>${esc(s.name)}</strong>
                ${s.url ? `<br><a href="${esc(s.url)}" target="_blank" rel="noopener" style="font-size:12px;">${esc(s.url)}</a>` : ""}
                ${s.notes ? `<br><span style="font-size:12px;color:#6b7280;">${esc(s.notes)}</span>` : ""}</td>
              <td style="padding:9px 14px;text-transform:capitalize;">${esc(s.kind || "")}</td>
              <td style="padding:9px 14px;"><span class="gf-elig" style="background:${bg};color:${fg};">${esc(label)}</span></td>
              <td style="padding:9px 14px;text-align:right;"><button class="gf-btn danger" data-src="${s.id}">Remove</button></td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>`;
    el.querySelectorAll("[data-src]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Remove this funding source?")) return;
      await api(`/api/grants/sources/${b.dataset.src}`, { method: "DELETE" });
      renderSources(el);
    }));

    // Fetch and map, but write nothing. While an adapter has not been run
    // against the live service this is how you find out whether the mapping is
    // right -- without putting a wrongly-read grant in front of anyone.
    el.querySelectorAll("[data-test]").forEach((b) => b.addEventListener("click", async () => {
      const out = el.querySelector(`.gf-testout[data-for="${b.dataset.test}"]`);
      out.style.display = "block";
      out.innerHTML = `<span style="font-size:12px;color:#6b7280;">Fetching…</span>`;
      try {
        const r = await api("/api/grants/discovery/run", { method: "POST", body: { source: b.dataset.test, dry_run: true } });
        if (!r.ok) { out.innerHTML = `<span style="font-size:12.5px;color:#b91c1c;">${esc(r.error || "Could not reach it.")}</span>`; return; }
        out.innerHTML = `<p style="margin:0 0 6px;font-size:12.5px;">Reached it. ${r.fetched} opportunit${r.fetched === 1 ? "y" : "ies"} returned, nothing imported.
          ${r.sample && r.sample.length ? "This is how the first few would be read:" : "It returned nothing to read."}</p>
          ${(r.sample || []).map((g) => `<div style="border-left:3px solid #cbd5e1;padding:4px 0 4px 9px;margin-bottom:6px;font-size:12.5px;">
            <strong>${esc(g.name)}</strong>${g.funder ? ` — ${esc(g.funder)}` : ""}<br>
            <span style="color:#6b7280;">${esc(g.opportunity_number || "no opportunity number")}
              ${g.deadline ? ` · closes ${esc(g.deadline)}` : " · no deadline read"}
              ${g.amount_max ? ` · up to $${Number(g.amount_max).toLocaleString()}` : ""}</span><br>
            <span style="color:#6b7280;">Eligibility as written: ${esc(g.applicant_eligibility || "(none given)")} — not interpreted.</span>
          </div>`).join("")}`;
      } catch (e) {
        out.innerHTML = `<span style="font-size:12.5px;color:#b91c1c;">${esc(e.message)}</span>`;
      }
    }));

    el.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", async () => {
      const was = b.textContent;
      b.textContent = "Running…"; b.disabled = true;
      try {
        const r = await api("/api/grants/discovery/run", { method: "POST", body: { source: b.dataset.run } });
        if (!r.ok) alert(r.error || "That source could not run.");
        renderSources(el);
      } catch (e) {
        alert(e.message); b.textContent = was; b.disabled = false;
      }
    }));

    const go = el.querySelector("#gf-paste-go");
    if (go) go.addEventListener("click", async () => {
      const text = el.querySelector("#gf-paste").value.trim();
      const msg = el.querySelector("#gf-paste-msg");
      if (!text) { msg.textContent = "Paste something first."; return; }
      go.disabled = true; msg.textContent = "Importing…";
      try {
        const r = await api("/api/grants/import", { method: "POST", body: { records: text } });
        msg.style.color = "#166534";
        msg.textContent = `${r.imported} imported, ${r.duplicates} already tracked`
          + (r.rejected ? `, ${r.rejected} unusable` : "")
          + (r.high_matches ? ` — ${r.high_matches} scoring 70%+` : "") + ".";
        el.querySelector("#gf-paste").value = "";
      } catch (e) {
        msg.style.color = "#b91c1c"; msg.textContent = e.message;
      } finally { go.disabled = false; }
    });
  }

  // ------------------------------------------------------------- assistant
  // One panel, used from a grant card and from inside a workspace. What it
  // shows after every answer is as important as the answer: which facts it was
  // based on, so nobody mistakes a confident paragraph for a sourced one.
  let AI_ACTIONS = null;

  async function assistantPanel(box, { grantId, applicationId, onSaved } = {}) {
    if (!AI_ACTIONS) AI_ACTIONS = await api("/api/grants/ai/actions");
    const drafts = AI_ACTIONS.actions.filter((a) => a.section);
    const asks = AI_ACTIONS.actions.filter((a) => !a.section);
    box.innerHTML = `
      <div class="gf-card" style="background:#fbfcfe;">
        <h4>Grant assistant</h4>
        ${AI_ACTIONS.configured ? `
          <p style="font-size:12.5px;color:#6b7280;margin:0 0 10px;">
            Answers come only from the organisation profile, the approved reuse library and this grant's own
            record. Anything it does not have, it marks <strong>[Information Needed]</strong> rather than inventing.</p>`
          : `<div class="gf-flags"><b>The assistant is not switched on</b>
             ANTHROPIC_API_KEY is not set on this install, so nothing here will run.</div>`}
        <div class="gf-checks" style="margin-bottom:8px;">
          ${asks.map((a) => `<span class="gf-check" data-ai="${a.key}">${esc(a.label)}</span>`).join("")}
        </div>
        ${applicationId ? `<div class="gf-checks">
          ${drafts.map((a) => `<span class="gf-check" data-ai="${a.key}">${esc(a.label)}</span>`).join("")}
        </div>` : ""}
        <div class="gf-actions">
          <input id="gf-ai-q" placeholder="Anything to add? (optional)" style="flex:1;min-width:220px;border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:7px 10px;font-size:13px;" />
        </div>
        <div id="gf-ai-out" style="margin-top:11px;"></div>
      </div>`;

    const out = box.querySelector("#gf-ai-out");
    box.querySelectorAll("[data-ai]").forEach((btn) => btn.addEventListener("click", async () => {
      const action = btn.dataset.ai;
      out.innerHTML = `<p style="font-size:13px;color:#6b7280;">Thinking…</p>`;
      let r;
      try {
        r = await api("/api/grants/ai", {
          method: "POST",
          body: { action, grant_id: grantId || null, application_id: applicationId || null,
                  question: box.querySelector("#gf-ai-q").value.trim() || null },
        });
      } catch (e) { out.innerHTML = `<div class="gf-flags">${esc(e.message)}</div>`; return; }

      if (!r.ok) {
        const why = r.reason === "not_configured"
          ? "The assistant is not switched on for this install — ANTHROPIC_API_KEY is not set."
          : esc(r.error || "It could not answer.");
        out.innerHTML = `<div class="gf-flags"><b>No answer</b>${why}</div>`;
        return;
      }

      // Structured answers render as a list; everything else as text with the
      // Information Needed markers made visible rather than buried.
      let bodyHtml;
      if (r.parsed && Array.isArray(r.parsed.missing)) {
        bodyHtml = r.parsed.missing.length
          ? `<ul style="margin:0;padding-left:18px;font-size:13px;">${r.parsed.missing.map((m) =>
              `<li style="margin-bottom:4px;"><strong>${esc(m.item)}</strong> — ${esc(m.why)}</li>`).join("")}</ul>`
          : `<p style="font-size:13px;color:#0f7a5a;margin:0;">Nothing obvious is missing.</p>`;
      } else {
        bodyHtml = `<div style="font-size:13.5px;white-space:pre-wrap;line-height:1.55;">${
          esc(r.text).replace(/\[Information Needed:([^\]]*)\]/g,
            '<mark style="background:#fef9c3;color:#854d0e;font-weight:700;">[Information Needed:$1]</mark>')
        }</div>`;
      }

      out.innerHTML = `
        <div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:12px 14px;background:#fff;">
          <div style="font-size:12px;font-weight:700;color:#1b2a6b;margin-bottom:7px;">${esc(r.label)}</div>
          ${bodyHtml}
          <div style="margin-top:10px;font-size:11.5px;color:#9aa1ab;border-top:1px solid var(--border,#eef0f4);padding-top:7px;">
            Based on ${r.sources.profile_facts} profile fact(s) and ${r.sources.approved_blocks} approved reuse block(s).
            ${r.sources.approved_blocks === 0 ? "Approve some reuse content to give it more to work with." : ""}
            · ${esc(r.model || "")}
          </div>
          ${r.section && applicationId ? `<div class="gf-actions">
            <button class="gf-btn primary" id="gf-ai-save">Save as the ${esc(r.label.replace(/^Draft: /, ""))} section</button>
            <span id="gf-ai-saved" style="align-self:center;font-size:12.5px;color:#0f7a5a;"></span></div>` : ""}
        </div>`;

      const saveBtn = out.querySelector("#gf-ai-save");
      if (saveBtn) saveBtn.addEventListener("click", async () => {
        await api(`/api/grants/applications/${applicationId}/narrative/${r.section}/from-ai`, {
          method: "POST", body: { content: r.text },
        });
        out.querySelector("#gf-ai-saved").textContent = "Saved onto the application.";
        if (onSaved) onSaved();
      });
    }));
  }

  // ------------------------------------------------------- applications
  async function renderApplications(el) {
    if (state.openApplication) return renderWorkspace(el, state.openApplication);
    const { applications, statuses } = await api("/api/grants/applications");
    el.innerHTML = applications.length ? `
      <p style="font-size:12.5px;color:#6b7280;margin:0 0 12px;">
        One workspace per grant you are applying for. Open it to work through the checklist,
        the narrative and the documents.</p>
      ${applications.map((a) => {
        const pct = a.progress.total ? Math.round((a.progress.done / a.progress.total) * 100) : 0;
        const d = a.days_left;
        return `<div class="gf-card">
          <div class="gf-score ${pct >= 80 ? "gf-s-hi" : pct >= 40 ? "gf-s-mid" : "gf-s-lo"}">
            <b>${pct}%</b><span>ready</span></div>
          <h4>${esc(a.grant_name)}</h4>
          <div class="gf-funder">${esc(a.funder || "")}</div>
          <span class="gf-elig gf-e-${a.status === "Submitted" || a.status === "Awarded" ? "eligible" : a.status === "Declined" ? "likely_ineligible" : "needs_review"}">${esc(a.status)}</span>
          <div class="gf-meta">
            <div><span>Checklist</span><br><strong>${a.progress.done} of ${a.progress.total} done</strong></div>
            <div><span>Deadline</span><br><strong>${esc(a.submission_deadline || a.grant_deadline || "—")}
              ${d !== null && d !== undefined ? `<span style="color:${d < 0 ? "#991b1b" : d <= 14 ? "#a56b00" : "#6b7280"};">(${d < 0 ? "passed" : d + " days"})</span>` : ""}</strong></div>
            <div><span>Requesting</span><br><strong>${money(a.amount_requested)}</strong></div>
            <div><span>Owner</span><br><strong>${esc(a.owner_email || "—")}</strong></div>
          </div>
          <div class="gf-actions"><button class="gf-btn primary" data-open-app="${a.id}">Open workspace</button></div>
        </div>`;
      }).join("")}`
      : `<div class="gf-empty">No applications yet. Open one with “Start application” on any grant.</div>`;
    el.querySelectorAll("[data-open-app]").forEach((b) => b.addEventListener("click", () => {
      state.openApplication = Number(b.dataset.openApp);
      renderApplications(el);
    }));
  }

  async function renderWorkspace(el, appId) {
    const d = await api(`/api/grants/applications/${appId}`);
    const a = d.application, g = d.grant || {};
    const pct = d.progress.total ? Math.round((d.progress.done / d.progress.total) * 100) : 0;
    const field = (name, label, val, type = "text") =>
      `<div><label>${label}</label><input name="${name}" type="${type}" value="${esc(val == null ? "" : val)}" /></div>`;

    el.innerHTML = `
      <button class="gf-btn" id="gf-back" style="margin-bottom:12px;">← All applications</button>

      <div class="gf-card">
        <div class="gf-score ${pct >= 80 ? "gf-s-hi" : pct >= 40 ? "gf-s-mid" : "gf-s-lo"}"><b>${pct}%</b><span>ready</span></div>
        <h4>${esc(g.name || "")}</h4>
        <div class="gf-funder">${esc(g.funder || "")}</div>
        <span class="gf-elig gf-e-${g.eligibility_status || "needs_review"}">${esc(g.eligibility_label || "")}</span>
        ${g.disqualification_flags && g.disqualification_flags.length
          ? `<div class="gf-flags"><b>Check before you spend time on this</b>${g.disqualification_flags.map(esc).join(" · ")}</div>` : ""}
        ${g.eligibility_explanation ? `<div class="gf-why">${esc(g.eligibility_explanation)}</div>` : ""}
        <div class="gf-meta">
          <div><span>Potential award</span><br><strong>${money(g.expected_award || g.amount_max)}</strong></div>
          <div><span>Match</span><br><strong>${g.match_score == null ? "—" : g.match_score + "%"}</strong></div>
          ${g.source_url ? `<div><span>Notice</span><br><a href="${esc(g.source_url)}" target="_blank" rel="noopener">Open</a></div>` : ""}
        </div>
      </div>

      <div class="gf-card">
        <h4>Submission checklist</h4>
        <div id="gf-checklist">${d.checklist.map((c) => `
          <label style="display:flex;align-items:center;gap:9px;padding:6px 0;font-size:13.5px;cursor:pointer;">
            <input type="checkbox" data-check="${esc(c.key)}"${c.done ? " checked" : ""} />
            <span style="${c.done ? "color:#6b7280;text-decoration:line-through;" : ""}">${esc(c.label)}</span>
            ${c.done_by ? `<span style="margin-left:auto;font-size:11.5px;color:#9aa1ab;">${esc(c.done_by)}</span>` : ""}
          </label>`).join("")}</div>
      </div>

      <div class="gf-card">
        <h4>Dates, budget and status</h4>
        <form id="gf-app-form" class="gf-form">
          <div><label>Status</label><select name="status">
            ${d.statuses ? "" : ""}${["Preparing", "Ready to submit", "Submitted", "Awarded", "Declined", "Withdrawn"]
              .map((x) => `<option${a.status === x ? " selected" : ""}>${x}</option>`).join("")}</select></div>
          ${field("owner_email", "Owner", a.owner_email)}
          ${field("amount_requested", "Amount requested", a.amount_requested)}
          ${field("submission_deadline", "Submission deadline", a.submission_deadline, "date")}
          ${field("loi_deadline", "Letter of intent due", a.loi_deadline, "date")}
          ${field("award_announcement_date", "Award announcement", a.award_announcement_date, "date")}
          ${field("reporting_deadline", "Reporting due", a.reporting_deadline, "date")}
          ${field("follow_up_date", "Follow up", a.follow_up_date, "date")}
          ${field("confirmation_ref", "Submission confirmation reference", a.confirmation_ref)}
          <div class="wide"><label>Budget notes</label><textarea name="budget_notes" rows="3">${esc(a.budget_notes || "")}</textarea></div>
          <div class="wide"><label>Notes</label><textarea name="notes" rows="2">${esc(a.notes || "")}</textarea></div>
          <div class="wide gf-actions">
            <button type="submit" class="gf-btn primary">Save</button>
            ${a.submitted_at
              ? `<span style="align-self:center;font-size:12.5px;color:#0f7a5a;">Submitted ${esc(String(a.submitted_at).slice(0, 10))} by ${esc(a.submitted_by || "")}</span>`
              : `<button type="button" class="gf-btn" id="gf-submit-app">Mark submitted</button>`}
            <span id="gf-app-msg" style="align-self:center;font-size:12.5px;color:#0f7a5a;"></span>
          </div>
        </form>
      </div>

      <div id="gf-ws-ai"></div>

      <div class="gf-card">
        <h4>Narrative</h4>
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 10px;">
          Written by hand for now. Phase 3 drafts these from the organisation profile.</p>
        ${d.narratives.map((n) => `
          <div style="margin-bottom:12px;">
            <label style="font-size:12px;font-weight:700;color:#475569;">${esc(n.label)}
              ${n.updated_at ? `<span style="font-weight:400;color:#9aa1ab;"> — saved ${esc(String(n.updated_at).slice(0, 10))}</span>` : ""}</label>
            <textarea data-narr="${esc(n.key)}" rows="4" style="width:100%;border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:8px 10px;font-size:13px;box-sizing:border-box;">${esc(n.content)}</textarea>
          </div>`).join("")}
        <div class="gf-actions"><button class="gf-btn primary" id="gf-save-narr">Save narrative</button>
          <span id="gf-narr-msg" style="align-self:center;font-size:12.5px;color:#0f7a5a;"></span></div>
      </div>

      <div class="gf-card">
        <h4>Application questions</h4>
        <div id="gf-questions">${d.questions.length ? d.questions.map((q) => `
          <div style="margin-bottom:11px;">
            <div style="font-size:13px;font-weight:700;color:#1b2a6b;">${esc(q.question)}
              <button class="gf-btn danger" data-del-q="${q.id}" style="float:right;padding:2px 8px;">Remove</button></div>
            <textarea data-ans="${q.id}" rows="3" style="width:100%;border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:8px 10px;font-size:13px;box-sizing:border-box;margin-top:4px;">${esc(q.answer || "")}</textarea>
          </div>`).join("") : `<p style="font-size:13px;color:#6b7280;">No questions recorded yet.</p>`}</div>
        <div class="gf-actions">
          <input id="gf-new-q" placeholder="Add a question from the application form…" style="flex:1;min-width:240px;border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:7px 10px;font-size:13px;" />
          <button class="gf-btn" id="gf-add-q">Add</button>
          <button class="gf-btn primary" id="gf-save-ans">Save answers</button>
        </div>
      </div>

      <div class="gf-card">
        <h4>Required documents</h4>
        ${d.documents.length ? `<table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tbody>${d.documents.map((x) => `<tr style="border-bottom:1px solid var(--border,#eef0f4);">
            <td style="padding:7px 0;">${esc(x.name || x.requirement || "—")}${x.category ? ` <span style="color:#6b7280;">(${esc(x.category)})</span>` : ""}</td>
            <td style="padding:7px 0;color:#6b7280;">${x.expires_at ? "expires " + esc(x.expires_at) : ""}</td>
            <td style="padding:7px 0;text-align:right;"><button class="gf-btn danger" data-del-doc="${x.id}">Remove</button></td>
          </tr>`).join("")}</tbody></table>` : `<p style="font-size:13px;color:#6b7280;">Nothing attached yet.</p>`}
        <div class="gf-actions">
          <select id="gf-doc-pick" style="border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:7px 10px;font-size:13px;">
            <option value="">Attach from the document library…</option>
          </select>
          <input id="gf-doc-req" placeholder="…or note a requirement we do not have yet" style="flex:1;min-width:220px;border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:7px 10px;font-size:13px;" />
          <button class="gf-btn" id="gf-attach">Add</button>
        </div>
      </div>

      <div class="gf-card">
        <h4>Tasks</h4>
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 10px;">
          These are ordinary staff tasks, so they appear in the assignee's Tasks &amp; Alerts with the usual reminders.</p>
        ${d.tasks.length ? d.tasks.map((t) => `<div style="display:flex;gap:9px;align-items:center;padding:5px 0;font-size:13px;border-bottom:1px solid var(--border,#eef0f4);">
          <span style="${t.status === "done" ? "color:#6b7280;text-decoration:line-through;" : ""}">${esc(t.title)}</span>
          <span style="margin-left:auto;color:#6b7280;font-size:12px;">${esc(t.assigned_name || "unassigned")}${t.due_date ? " · due " + esc(t.due_date) : ""}</span>
        </div>`).join("") : `<p style="font-size:13px;color:#6b7280;">No tasks yet.</p>`}
        <div class="gf-actions">
          <input id="gf-task-title" placeholder="What needs doing?" style="flex:1;min-width:220px;border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:7px 10px;font-size:13px;" />
          <input id="gf-task-due" type="date" style="border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:7px 10px;font-size:13px;" />
          <button class="gf-btn" id="gf-add-task">Add task</button>
        </div>
      </div>`;

    const reload = () => renderWorkspace(el, appId);
    assistantPanel(el.querySelector("#gf-ws-ai"), { grantId: a.grant_id, applicationId: appId, onSaved: reload });
    el.querySelector("#gf-back").addEventListener("click", () => { state.openApplication = null; renderApplications(el); });

    el.querySelectorAll("[data-check]").forEach((cb) => cb.addEventListener("change", async () => {
      await api(`/api/grants/applications/${appId}/checklist/${cb.dataset.check}`, { method: "PATCH", body: { done: cb.checked } });
      reload();
    }));

    el.querySelector("#gf-app-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target); const body = {};
      fd.forEach((v, k) => { body[k] = v === "" ? null : v; });
      await api(`/api/grants/applications/${appId}`, { method: "PATCH", body });
      el.querySelector("#gf-app-msg").textContent = "Saved.";
    });

    const submitBtn = el.querySelector("#gf-submit-app");
    if (submitBtn) submitBtn.addEventListener("click", async () => {
      const ref = prompt("Submission confirmation reference (optional):", "");
      if (ref === null) return;
      await api(`/api/grants/applications/${appId}/submit`, { method: "POST", body: { confirmation_ref: ref } });
      reload();
    });

    el.querySelector("#gf-save-narr").addEventListener("click", async () => {
      for (const ta of el.querySelectorAll("[data-narr]")) {
        await api(`/api/grants/applications/${appId}/narrative/${ta.dataset.narr}`, { method: "PUT", body: { content: ta.value } });
      }
      el.querySelector("#gf-narr-msg").textContent = "Saved.";
    });

    el.querySelector("#gf-add-q").addEventListener("click", async () => {
      const q = el.querySelector("#gf-new-q").value.trim();
      if (!q) return;
      await api(`/api/grants/applications/${appId}/questions`, { method: "POST", body: { question: q } });
      reload();
    });
    el.querySelector("#gf-save-ans").addEventListener("click", async () => {
      for (const ta of el.querySelectorAll("[data-ans]")) {
        await api(`/api/grants/applications/${appId}/questions/${ta.dataset.ans}`, { method: "PATCH", body: { answer: ta.value } });
      }
      reload();
    });
    el.querySelectorAll("[data-del-q]").forEach((b) => b.addEventListener("click", async () => {
      await api(`/api/grants/applications/${appId}/questions/${b.dataset.delQ}`, { method: "DELETE" });
      reload();
    }));

    // Fill the attach picker from the library.
    try {
      const { documents } = await api("/api/grants/documents");
      const pick = el.querySelector("#gf-doc-pick");
      documents.forEach((doc) => {
        const o = document.createElement("option");
        o.value = doc.id; o.textContent = `${doc.name}${doc.category ? " — " + doc.category : ""}`;
        pick.appendChild(o);
      });
    } catch (e) { /* the picker just stays empty */ }

    el.querySelector("#gf-attach").addEventListener("click", async () => {
      const docId = el.querySelector("#gf-doc-pick").value;
      const req = el.querySelector("#gf-doc-req").value.trim();
      if (!docId && !req) return;
      await api(`/api/grants/applications/${appId}/documents`, { method: "POST", body: { document_id: docId || null, requirement: req || null } });
      reload();
    });
    el.querySelectorAll("[data-del-doc]").forEach((b) => b.addEventListener("click", async () => {
      await api(`/api/grants/applications/${appId}/documents/${b.dataset.delDoc}`, { method: "DELETE" });
      reload();
    }));

    el.querySelector("#gf-add-task").addEventListener("click", async () => {
      const title = el.querySelector("#gf-task-title").value.trim();
      if (!title) return;
      await api(`/api/grants/applications/${appId}/tasks`, {
        method: "POST", body: { title, due_date: el.querySelector("#gf-task-due").value || null },
      });
      reload();
    });
  }

  // ---------------------------------------------------------------- calendar
  async function renderCalendar(el) {
    const { events } = await api("/api/grants/calendar");
    const TONE = {
      urgent: ["#991b1b", "#fee2e2"], upcoming: ["#1b2a6b", "#eef1fb"],
      submitted: ["#166534", "#dcfce7"], closed: ["#6b7280", "#e5e7eb"],
    };
    const groups = [
      ["Overdue or closed", events.filter((e) => e.state === "closed")],
      ["Next 14 days", events.filter((e) => e.state === "urgent")],
      ["Later", events.filter((e) => e.state === "upcoming")],
      ["Submitted", events.filter((e) => e.state === "submitted")],
    ];
    el.innerHTML = events.length ? groups.map(([title, list]) => !list.length ? "" : `
      <h3 style="color:#1b2a6b;margin:18px 0 8px;font-size:15px;">${title} <span style="color:#9aa1ab;font-weight:400;">(${list.length})</span></h3>
      <div class="gf-card" style="padding:0;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tbody>${list.map((e) => {
            const [fg, bg] = TONE[e.state] || TONE.upcoming;
            return `<tr style="border-bottom:1px solid var(--border,#eef0f4);">
              <td style="padding:9px 14px;white-space:nowrap;"><strong>${esc(e.date)}</strong>
                ${e.days !== null ? `<br><span style="color:#9aa1ab;font-size:11.5px;">${e.days < 0 ? Math.abs(e.days) + " days ago" : e.days + " days"}</span>` : ""}</td>
              <td style="padding:9px 14px;"><span class="gf-elig" style="background:${bg};color:${fg};">${esc(e.label)}</span></td>
              <td style="padding:9px 14px;"><strong>${esc(e.grant)}</strong><br><span style="color:#6b7280;font-size:12px;">${esc(e.funder || "")}</span></td>
              <td style="padding:9px 14px;"><span class="gf-elig gf-e-${e.eligibility_status}">${esc(e.eligibility_label)}</span></td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>`).join("")
      : `<div class="gf-empty">No dates yet. Add a grant with a deadline and it appears here.</div>`;
  }

  // --------------------------------------------------------------- documents
  async function renderDocuments(el) {
    const { documents, categories } = await api("/api/grants/documents");
    const TONE = { expired: ["#991b1b", "#fee2e2"], expiring: ["#854d0e", "#fef9c3"], ok: ["#166534", "#dcfce7"], no_expiry: ["#374151", "#e5e7eb"] };
    el.innerHTML = `
      <div class="gf-card">
        <h4>Add a document</h4>
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 11px;">
          The things funders ask for every time. Give anything that goes stale an expiry date and the
          library will tell you before a grant application does.</p>
        <form id="gf-doc-form" class="gf-form">
          <div><label>Name *</label><input name="name" required /></div>
          <div><label>Category</label><select name="category">${categories.map((c) => `<option>${esc(c)}</option>`).join("")}</select></div>
          <div><label>Expires</label><input name="expires_at" type="date" /></div>
          <div><label>Link (if it lives elsewhere)</label><input name="external_url" /></div>
          <div class="wide"><label>File</label><input name="file" type="file" /></div>
          <div class="wide"><label>Notes</label><input name="notes" /></div>
          <div class="wide gf-actions"><button type="submit" class="gf-btn primary">Add document</button>
            <span id="gf-doc-msg" style="align-self:center;font-size:12.5px;color:#991b1b;"></span></div>
        </form>
      </div>
      ${documents.length ? `<div class="gf-card" style="padding:0;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="background:#f8fafc;">
            <th style="text-align:left;padding:9px 14px;">Document</th>
            <th style="text-align:left;padding:9px 14px;">Category</th>
            <th style="text-align:left;padding:9px 14px;">Expiry</th>
            <th style="padding:9px 14px;"></th></tr></thead>
          <tbody>${documents.map((d) => {
            const [fg, bg] = TONE[d.status.key] || TONE.no_expiry;
            return `<tr style="border-top:1px solid var(--border,#eef0f4);">
              <td style="padding:9px 14px;"><strong>${esc(d.name)}</strong>
                ${d.filename ? `<br><span style="color:#6b7280;font-size:12px;">${esc(d.filename)}</span>` : ""}
                ${d.external_url ? `<br><a href="${esc(d.external_url)}" target="_blank" rel="noopener" style="font-size:12px;">link</a>` : ""}</td>
              <td style="padding:9px 14px;">${esc(d.category || "")}</td>
              <td style="padding:9px 14px;"><span class="gf-elig" style="background:${bg};color:${fg};">${esc(d.status.label)}</span></td>
              <td style="padding:9px 14px;text-align:right;"><button class="gf-btn danger" data-del="${d.id}">Remove</button></td>
            </tr>`;
          }).join("")}</tbody></table></div>` : `<div class="gf-empty">Nothing in the library yet.</div>`}`;

    el.querySelector("#gf-doc-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { name: fd.get("name"), category: fd.get("category"), expires_at: fd.get("expires_at") || null,
        external_url: fd.get("external_url") || null, notes: fd.get("notes") || null };
      const file = e.target.querySelector('input[type="file"]').files[0];
      if (file) {
        const buf = await file.arrayBuffer();
        let bin = ""; const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        body.content_base64 = btoa(bin);
        body.filename = file.name;
        body.mime_type = file.type || "application/octet-stream";
      }
      try {
        await api("/api/grants/documents", { method: "POST", body });
        renderDocuments(el);
      } catch (err) { el.querySelector("#gf-doc-msg").textContent = err.message; }
    });
    el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Remove this document from the library?")) return;
      await api(`/api/grants/documents/${b.dataset.del}`, { method: "DELETE" });
      renderDocuments(el);
    }));
  }

  // ----------------------------------------------------------- reuse library
  async function renderReuse(el) {
    const { blocks } = await api("/api/grants/reuse");
    const approvedCount = blocks.filter((b) => b.approved && b.content).length;
    el.innerHTML = `
      <div class="gf-card">
        <h4>Reusable application content</h4>
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 4px;">
          The paragraphs that go into every application. Write them once, approve them, and the assistant
          will draw on them instead of inventing.</p>
        <p style="font-size:12.5px;margin:0;color:${approvedCount ? "#0f7a5a" : "#991b1b"};">
          ${approvedCount} of ${blocks.length} approved.
          ${approvedCount ? "" : "Until something is approved the assistant has only the organisation profile to work from."}</p>
      </div>
      ${blocks.map((b) => `
        <div class="gf-card">
          <h4>${esc(b.label)}
            <span class="gf-elig ${b.approved && b.content ? "gf-e-eligible" : "gf-e-needs_review"}" style="float:right;">
              ${b.approved && b.content ? "Approved" : b.content ? "Draft" : "Empty"}</span></h4>
          ${b.updated_by ? `<div class="gf-funder">last edited by ${esc(b.updated_by)}${b.updated_at ? " on " + esc(String(b.updated_at).slice(0, 10)) : ""}</div>` : ""}
          <textarea data-reuse="${esc(b.key)}" rows="4" style="width:100%;border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:8px 10px;font-size:13px;box-sizing:border-box;">${esc(b.content)}</textarea>
          <div class="gf-actions">
            <label style="display:flex;align-items:center;gap:7px;font-size:13px;">
              <input type="checkbox" data-approve="${esc(b.key)}"${b.approved ? " checked" : ""} /> Approved for use in applications</label>
            <button class="gf-btn primary" data-save-reuse="${esc(b.key)}">Save</button>
            <span data-msg="${esc(b.key)}" style="align-self:center;font-size:12.5px;color:#0f7a5a;"></span>
          </div>
        </div>`).join("")}`;

    el.querySelectorAll("[data-save-reuse]").forEach((btn) => btn.addEventListener("click", async () => {
      const key = btn.dataset.saveReuse;
      await api(`/api/grants/reuse/${key}`, {
        method: "PUT",
        body: {
          content: el.querySelector(`[data-reuse="${key}"]`).value,
          approved: el.querySelector(`[data-approve="${key}"]`).checked,
        },
      });
      el.querySelector(`[data-msg="${key}"]`).textContent = "Saved.";
    }));
  }

  // ------------------------------------------------------- not yet built
  function laterPhase(el, title, whatItWillDo, phase) {
    el.innerHTML = `<div class="gf-soon">
      <h4>${esc(title)} — ${esc(phase)}</h4>
      <p style="margin:0 0 8px;">${esc(whatItWillDo)}</p>
      <p style="margin:0;color:#6b7280;">Phase 1 is the grant database, dashboard, organisation profile,
      match scoring, eligibility analysis and search. This screen is deliberately empty rather than a
      mock-up, so nothing here looks like it works when it does not.</p>
    </div>`;
  }

  // ------------------------------------------------------------------ shell
  const TABS = [
    ["dashboard", "Dashboard"],
    ["opportunities", "Opportunities"],
    ["saved", "Saved grants"],
    ["applications", "Applications"],
    ["calendar", "Grant calendar"],
    ["sources", "Funding sources"],
    ["profile", "Organisation profile"],
    ["reuse", "Reuse library"],
    ["documents", "Documents"],
  ];

  async function render(mount) {
    injectStyles();
    if (!META) META = await api("/api/grants/meta");
    mount.innerHTML = `
      <h2 style="color:#1b2a6b;margin:0 0 4px;">Grant Finder</h2>
      <p style="color:#6b7280;font-size:13px;margin:0 0 16px;">
        What money is available, whether we qualify, how much, what for, and when it is due.</p>
      <div class="gf-tabs">${TABS.map(([k, l]) =>
        `<button class="gf-tab${state.tab === k ? " active" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
      <div id="gf-body"></div>`;
    mount.querySelectorAll("[data-tab]").forEach((b) =>
      b.addEventListener("click", () => { state.tab = b.dataset.tab; render(mount); }));

    const body = mount.querySelector("#gf-body");
    try {
      if (state.tab === "dashboard") await renderDashboard(body);
      else if (state.tab === "opportunities") await renderOpportunities(body);
      else if (state.tab === "saved") await renderSaved(body);
      else if (state.tab === "sources") await renderSources(body);
      else if (state.tab === "profile") await renderProfile(body);
      else if (state.tab === "applications") await renderApplications(body);
      else if (state.tab === "calendar") await renderCalendar(body);
      else if (state.tab === "reuse") await renderReuse(body);
      else if (state.tab === "documents") await renderDocuments(body);
    } catch (e) {
      body.innerHTML = `<div class="gf-empty">Could not load: ${esc(e.message)}</div>`;
    }
  }

  window.__renderGrants = async function (mount) {
    // Someone without access typing #/grants should land on the dashboard the
    // way every other guarded module behaves, not on an uncaught error. The
    // server is what actually enforces this; the nav entry and this are only
    // there to keep the app from breaking underneath them.
    try {
      await render(mount);
    } catch (e) {
      if (typeof window.renderDashboard === "function") return window.renderDashboard(mount);
      mount.innerHTML = `<div class="gf-empty">${esc(e.message)}</div>`;
    }
  };
})();
