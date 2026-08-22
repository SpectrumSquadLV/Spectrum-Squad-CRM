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
  const state = { tab: "dashboard", filters: {} };

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
        if (act === "start") {
          alert("Application workspaces arrive in Phase 2. For now this grant is marked as Preparing Application so it shows on the dashboard.");
          await api(`/api/grants/opportunities/${id}`, { method: "PATCH", body: { status: "Preparing Application" } });
          return again();
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
    el.innerHTML = `
      <div class="gf-card">
        <h4>Where opportunities come from</h4>
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 4px;">
          Nothing here fetches anything yet — that is Phase 4. The integration column is an honest record of
          what each source would actually take to automate, so the work can be scoped rather than guessed at.</p>
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
      else if (state.tab === "applications") laterPhase(body, "Applications",
        "An application workspace per grant: questions, required documents, narrative drafts, budget, tasks and a submission checklist.", "Phase 2");
      else if (state.tab === "calendar") laterPhase(body, "Grant calendar",
        "Opening dates, deadlines, LOI dates and reporting dates on one calendar, with alerts inside the CRM.", "Phase 2");
      else if (state.tab === "documents") laterPhase(body, "Documents",
        "The reusable grant document library — W-9, licenses, insurance certificates, financials — with expiry dates.", "Phase 2");
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
