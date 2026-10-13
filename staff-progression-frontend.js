// staff-progression-frontend.js -- the Credentialing Tracker, in three places.
//
//   1. THE CREDENTIALING DASHBOARD at #/credentialing: summary cards, the staff
//      progression table, the employee side panel with the three-stage tracker,
//      payer linking and per-payer readiness, and (the owner only) the settings for
//      payer rules, due dates and the 7 AM email.
//   2. A COMPACT CARD on the Clinical Director's dashboards that links to it.
//   3. THE PAYER ENROLLMENT SECTION of the HR Hub staff card, where HR records
//      linking and credentialing with each payer.
//
// Everything is derived by the server from the HR Hub on every load. Nothing
// here is the source of anything.
//
// Exposes window.__renderCredentialing(mount), window.__fillStaffProgression(el, surface)
// and window.__renderPayerEnrollments(el, employeeId).
(function () {
  "use strict";

  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, {
      method: opts.method || "GET", credentials: "include",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(d.error || "Request failed"); e.status = res.status; throw e; }
    return d;
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortDate(s) {
    if (!s) return "—";
    const p = String(s).slice(0, 10).split("-");
    return p.length === 3 ? MONTHS[+p[1] - 1] + " " + (+p[2]) + ", " + p[0] : String(s);
  }
  function stamp(iso) {
    if (!iso) return "—";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return shortDate(iso);
    return new Date(t).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");

  // Green complete, blue in progress, yellow pending action, red overdue.
  const TONE = {
    complete: { bg: "#dcfce7", fg: "#166534", bar: "#16a34a" },
    approved: { bg: "#dcfce7", fg: "#166534", bar: "#16a34a" },
    linked: { bg: "#dcfce7", fg: "#166534", bar: "#16a34a" },
    in_progress: { bg: "#dbeafe", fg: "#1e40af", bar: "#2563eb" },
    submitted: { bg: "#dbeafe", fg: "#1e40af", bar: "#2563eb" },
    pending: { bg: "#fef3c7", fg: "#92400e", bar: "#d97706" },
    not_started: { bg: "#fef3c7", fg: "#92400e", bar: "#d97706" },
    action_needed: { bg: "#fef3c7", fg: "#92400e", bar: "#d97706" },
    overdue: { bg: "#fee2e2", fg: "#991b1b", bar: "#dc2626" },
    not_required: { bg: "#f1f5f9", fg: "#475569", bar: "#94a3b8" },
  };
  const pill = (k, label) => { const t = TONE[k] || TONE.pending; return `<span class="cr-pill" style="background:${t.bg};color:${t.fg};">${esc(label)}</span>`; };
  function bar(pct, k) {
    const t = TONE[k] || TONE.in_progress;
    return `<div class="cr-bar"><span style="width:${Math.max(0, Math.min(100, pct))}%;background:${t.bar};"></span></div>`;
  }

  function injectStyles() {
    if (document.getElementById("cr-styles")) return;
    const st = document.createElement("style");
    st.id = "cr-styles";
    st.textContent = `
    .cr, .cr * { box-sizing: border-box; }
    .cr { color: #1f2340; max-width: 1280px; }
    .cr-head { display:flex; flex-wrap:wrap; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:18px; }
    .cr-eyebrow { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#6b6a86; font-weight:700; }
    .cr-title { font-family: var(--font-header, inherit); font-size:26px; font-weight:800; color: var(--brand-navy, #1b2a6b); margin:2px 0 2px; }
    .cr-sub { color:#6b6a86; font-size:13.5px; }
    .cr-actions { display:flex; gap:8px; flex-wrap:wrap; }
    .cr-btn { font:inherit; font-size:13px; font-weight:700; border-radius:999px; padding:8px 16px; border:1px solid var(--brand-navy, #1b2a6b); background:var(--brand-navy, #1b2a6b); color:#fff; cursor:pointer; }
    .cr-btn.ghost { background:#fff; color:var(--brand-navy, #1b2a6b); border-color:#d9dcea; }
    .cr-btn.small { padding:5px 12px; font-size:12px; }
    .cr-btn:disabled { opacity:.55; cursor:default; }
    .cr-cards { display:grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap:12px; margin-bottom:16px; }
    .cr-card { background:#fff; border:1px solid #eceef5; border-radius:16px; padding:14px 16px; box-shadow:0 1px 3px rgba(41,34,92,.06); cursor:pointer; text-align:left; font:inherit; color:inherit; position:relative; overflow:hidden; }
    .cr-card::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--accent, #1b2a6b); }
    .cr-card.on { outline:2px solid var(--accent, #1b2a6b); outline-offset:-2px; }
    .cr-card .n { font-size:28px; font-weight:800; line-height:1.1; color:var(--accent, #1b2a6b); }
    .cr-card .l { font-size:12.5px; color:#6b6a86; margin-top:4px; font-weight:600; }
    .cr-panel { background:#fff; border:1px solid #eceef5; border-radius:16px; box-shadow:0 1px 3px rgba(41,34,92,.06); }
    .cr-filters { display:flex; flex-wrap:wrap; gap:8px; padding:12px; border-bottom:1px solid #f0f1f6; align-items:center; }
    .cr-filters input, .cr-filters select, .cr-field input, .cr-field select, .cr-field textarea {
      font:inherit; font-size:13px; padding:7px 10px; border:1px solid #dcdfea; border-radius:10px; background:#fff; color:inherit; min-width:0; }
    .cr-filters .grow { flex:1 1 200px; }
    .cr-filters label { font-size:11.5px; color:#6b6a86; display:flex; align-items:center; gap:5px; }
    .cr-table { width:100%; border-collapse:collapse; }
    .cr-table th { text-align:left; font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:#6b6a86; padding:10px 12px; border-bottom:1px solid #eceef5; font-weight:700; white-space:nowrap; }
    .cr-table td { padding:12px; border-bottom:1px solid #f3f4f8; font-size:13.5px; vertical-align:middle; }
    .cr-table td[data-l="Hire date"], .cr-table td[data-l="Target completion"] { white-space:nowrap; }
    .cr-table tbody tr { cursor:pointer; }
    .cr-table tbody tr:hover { background:#fafaff; }
    .cr-name { display:flex; align-items:center; gap:10px; }
    .cr-av { width:34px; height:34px; border-radius:50%; background:var(--brand-navy-light, #edecf8); color:var(--brand-navy, #1b2a6b); display:flex; align-items:center; justify-content:center; font-weight:800; font-size:12.5px; flex:none; }
    .cr-muted { color:#6b6a86; font-size:12px; }
    .cr-pill { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:700; white-space:nowrap; }
    .cr-bar { height:8px; background:#eef0f6; border-radius:999px; overflow:hidden; min-width:90px; }
    .cr-bar span { display:block; height:100%; border-radius:999px; transition: width .3s; }
    .cr-prog { display:flex; flex-direction:column; gap:4px; min-width:110px; }
    .cr-dots { display:flex; gap:4px; }
    .cr-dots i { width:14px; height:6px; border-radius:3px; background:#e5e7eb; display:block; }
    .cr-menu { font:inherit; border:1px solid #dcdfea; background:#fff; border-radius:8px; padding:4px 10px; cursor:pointer; color:var(--brand-navy, #1b2a6b); font-weight:700; }
    .cr-empty { padding:28px; text-align:center; color:#6b6a86; }
    .cr-section-title { font-weight:800; color:var(--brand-navy, #1b2a6b); font-size:15px; margin:0 0 10px; }
    details.cr-cands { margin-top:16px; }
    details.cr-cands summary { cursor:pointer; font-weight:700; color:var(--brand-navy, #1b2a6b); padding:12px 16px; }
    /* side panel */
    .cr-scrim { position:fixed; inset:0; background:rgba(20,24,60,.32); z-index:900; }
    .cr-drawer { position:fixed; top:0; right:0; bottom:0; width:min(620px, 100vw); background:#f7f8fb; z-index:901; overflow-y:auto; box-shadow:-10px 0 40px rgba(20,24,60,.18); }
    .cr-dhead { position:sticky; top:0; background:#fff; border-bottom:1px solid #eceef5; padding:16px 20px; display:flex; align-items:center; gap:12px; z-index:2; }
    .cr-dhead h2 { margin:0; font-size:19px; color:var(--brand-navy, #1b2a6b); font-family:var(--font-header, inherit); }
    .cr-x { margin-left:auto; font:inherit; font-size:20px; border:0; background:transparent; cursor:pointer; color:#6b6a86; }
    .cr-dbody { padding:16px 20px 40px; display:flex; flex-direction:column; gap:14px; }
    .cr-box { background:#fff; border:1px solid #eceef5; border-radius:14px; padding:14px 16px; }
    .cr-grid { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:10px 16px; }
    .cr-grid .k { font-size:11px; color:#6b6a86; text-transform:uppercase; letter-spacing:.04em; font-weight:700; }
    .cr-grid .v { font-size:14px; font-weight:600; margin-top:2px; }
    .cr-track { display:flex; align-items:flex-start; margin:6px 0 2px; }
    .cr-step { flex:1; text-align:center; position:relative; font-size:11.5px; font-weight:700; color:#475569; }
    .cr-step .c { width:30px; height:30px; border-radius:50%; margin:0 auto 6px; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:800; position:relative; z-index:1; border:2px solid #fff; box-shadow:0 0 0 1px #e5e7eb; }
    .cr-step::before { content:""; position:absolute; top:15px; left:-50%; width:100%; height:3px; background:var(--line, #e5e7eb); z-index:0; }
    .cr-step:first-child::before { display:none; }
    .cr-ms { border-left:4px solid var(--accent, #e5e7eb); }
    .cr-ms-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .cr-ms-head strong { font-size:14.5px; }
    .cr-req { list-style:none; margin:8px 0 0; padding:0; font-size:13px; }
    .cr-req li { padding:3px 0; display:flex; gap:8px; }
    .cr-req .ok { color:#16a34a; font-weight:800; width:14px; }
    .cr-req .no { color:#d97706; font-weight:800; width:14px; }
    .cr-edit { margin-top:10px; padding-top:10px; border-top:1px dashed #e5e7eb; display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:8px; }
    .cr-field { display:flex; flex-direction:column; gap:3px; font-size:11px; color:#6b6a86; font-weight:700; }
    .cr-field.wide { grid-column:1 / -1; }
    .cr-msg { font-size:12.5px; margin-top:6px; }
    .cr-ptable { width:100%; border-collapse:collapse; font-size:13px; }
    .cr-ptable td, .cr-ptable th { padding:7px 6px; border-bottom:1px solid #f3f4f8; text-align:left; }
    .cr-ptable th { font-size:11px; color:#6b6a86; text-transform:uppercase; }
    .cr-hist { font-size:12.5px; list-style:none; padding:0; margin:0; }
    .cr-hist li { padding:5px 0; border-bottom:1px solid #f3f4f8; }
    .cr-check { display:flex; align-items:center; gap:6px; font-size:12.5px; font-weight:600; color:#1f2340; }
    /* compact dashboard card */
    .cr-mini { background:#fff; border:1px solid #eceef5; border-radius:16px; padding:14px 16px; margin:14px 0; box-shadow:0 1px 3px rgba(41,34,92,.06); }
    .cr-mini-cards { display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:8px; margin:10px 0; }
    .cr-mini-cards div { background:#f7f8fb; border-radius:12px; padding:8px; text-align:center; }
    .cr-mini-cards b { display:block; font-size:20px; }
    .cr-mini-cards span { font-size:11px; color:#6b6a86; }
    /* HR Hub payer section */
    .spw-pe-row { border:1px solid #eceef5; border-radius:10px; padding:10px 12px; margin-bottom:8px; background:#fff; }
    .spw-pe-head { display:flex; justify-content:space-between; gap:8px; align-items:center; margin-bottom:6px; flex-wrap:wrap; }
    .spw-pst { display:inline-block; padding:2px 9px; border-radius:999px; font-size:11.5px; font-weight:700; }
    .spw-pe-grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:8px; }
    .spw-pe-grid label { display:block; font-size:11px; color:#6b7280; }
    .spw-pe-grid input, .spw-pe-grid select, .spw-pe-add input, .spw-pe-add select { width:100%; font:inherit; font-size:12.5px; padding:5px 7px; border:1px solid #d9dce6; border-radius:7px; box-sizing:border-box; }
    .spw-pe-add { display:grid; grid-template-columns:2fr 1.3fr 1.3fr auto; gap:8px; align-items:end; margin-top:6px; }
    .spw-pe-msg { font-size:12px; }
    @media (max-width: 1000px) { .cr-cards { grid-template-columns:repeat(3, minmax(0,1fr)); } }
    @media (max-width: 760px) {
      .cr-cards, .cr-mini-cards { grid-template-columns:repeat(2, minmax(0,1fr)); }
      .cr-table thead { display:none; }
      .cr-head { padding-top:40px; }
      .cr-table, .cr-table tbody { display:block; width:100%; }
      .cr-table tr { display:grid; grid-template-columns:1fr 1fr; gap:8px 14px; padding:14px 12px; border-bottom:1px solid #eceef5; }
      .cr-table td { display:block; border:0; padding:0; min-width:0; }
      .cr-table td[data-l="Employee"], .cr-table td[data-l="Credentialing"], .cr-table td[data-l=""], .cr-table td[colspan] { grid-column:1 / -1; }
      .cr-table td[data-l=""] .cr-menu { width:100%; padding:8px; }
      .cr-table td[data-l="Employee"]::before { display:none; }
      .cr-table td[data-l]::before { content:attr(data-l); display:block; font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; color:#6b6a86; font-weight:700; }
      .cr-grid, .cr-edit, .spw-pe-grid, .spw-pe-add { grid-template-columns:1fr; }
      .cr-step { font-size:10px; }
    }`;
    document.head.appendChild(st);
  }

  // ======================================================================
  // 1. THE DASHBOARD
  // ======================================================================
  const S = { data: null, filters: { q: "", position: "", status: "", coordinator: "", from: "", to: "" }, mount: null };
  const CARD_DEFS = [
    { key: "", label: "Total new hires", n: (s) => s.total, accent: "#1b2a6b" },
    { key: "approved", label: "Internally approved", n: (s) => s.approved, accent: "#16a34a" },
    { key: "in_progress", label: "In progress", n: (s) => s.in_progress, accent: "#2563eb" },
    { key: "action_needed", label: "Action needed", n: (s) => s.action_needed, accent: "#d97706" },
    { key: "overdue", label: "Overdue", n: (s) => s.overdue, accent: "#dc2626" },
  ];

  function filtered() {
    const f = S.filters, q = f.q.trim().toLowerCase();
    return S.data.people.filter((p) =>
      (!q || p.name.toLowerCase().includes(q) || p.position.toLowerCase().includes(q))
      && (!f.position || p.position_group === f.position)
      && (!f.status || p.status === f.status)
      && (!f.coordinator || (f.coordinator === "__none" ? !p.coordinator : p.coordinator === f.coordinator))
      && (!f.from || (p.hire_date && p.hire_date >= f.from))
      && (!f.to || (p.hire_date && p.hire_date <= f.to)));
  }

  function rowHtml(p) {
    const done = p.milestones.map((m) => `<i style="background:${(TONE[m.status] || TONE.pending).bar};" title="${esc(m.label)}: ${esc(m.status_label)}"></i>`).join("");
    const pp = p.payer_progress;
    return `<tr data-emp="${p.employee_id}">
      <td data-l="Employee"><div class="cr-name"><div class="cr-av">${esc(initials(p.name))}</div><div><strong>${esc(p.name)}</strong>
        <div class="cr-muted">${esc(p.current_stage)}${p.coordinator ? " · " + esc(p.coordinator) : ""}</div></div></div></td>
      <td data-l="Position">${esc(p.position)}<div class="cr-muted">${esc(p.position_group_label)}</div></td>
      <td data-l="Hire date">${esc(shortDate(p.hire_date))}<div class="cr-muted">${p.days_in_onboarding} day${p.days_in_onboarding === 1 ? "" : "s"}</div></td>
      <td data-l="Credentialing"><div class="cr-prog">${bar(p.progress, p.status === "overdue" ? "overdue" : p.approved ? "complete" : "in_progress")}
        <div class="cr-dots">${done}</div><span class="cr-muted">${p.milestones_done} of ${p.milestones_total} milestones</span></div></td>
      <td data-l="Payer linking">${pp.total ? `<div class="cr-prog">${bar(Math.round(pp.linked / pp.total * 100), pp.linked === pp.total ? "linked" : "submitted")}<span class="cr-muted">${esc(pp.label)}</span></div>` : `<span class="cr-muted">N/A</span>`}</td>
      <td data-l="Status">${pill(p.status, p.status_label)}${p.attention.length && !p.approved ? `<div class="cr-muted" style="margin-top:4px;">${esc(p.attention[0])}</div>` : ""}</td>
      <td data-l="Target completion">${esc(shortDate(p.target_completion_date))}</td>
      <td data-l=""><button class="cr-menu" data-open="${p.employee_id}" aria-label="Open ${esc(p.name)}">View</button></td>
    </tr>`;
  }

  function paintTable() {
    const el = S.mount && S.mount.querySelector("#cr-rows");
    if (!el) return;
    const list = filtered();
    el.innerHTML = list.length ? list.map(rowHtml).join("")
      : `<tr><td colspan="8"><div class="cr-empty">${S.data.people.length ? "Nobody matches these filters." : "No new hires on the tracker. Employees marked Onboarding in the HR Hub appear here automatically."}</div></td></tr>`;
    S.mount.querySelectorAll(".cr-card").forEach((c) => c.classList.toggle("on", c.dataset.card === S.filters.status));
    S.mount.querySelector("#cr-count").textContent = `${list.length} of ${S.data.people.length}`;
  }

  async function renderPage(mount) {
    injectStyles();
    S.mount = mount;
    mount.innerHTML = `<div class="cr"><div class="cr-empty">Loading credentialing…</div></div>`;
    try { S.data = await api("/api/credentialing"); }
    catch (e) {
      mount.innerHTML = `<div class="cr"><div class="cr-panel cr-empty">${esc(e.status === 403 ? "The Credentialing dashboard is for HR, owners and admins, and the Clinical Director and Assistants." : e.message)}</div></div>`;
      return;
    }
    const d = S.data, s = d.summary, f = S.filters;
    const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`;
    mount.innerHTML = `<div class="cr">
      <div class="cr-head">
        <div><div class="cr-eyebrow">Spectrum Squad · HR</div><div class="cr-title">Credentialing</div>
          <div class="cr-sub">Internal onboarding for every new hire, with payer linking tracked separately. Read from the HR Hub on every load.</div></div>
        <div class="cr-actions">
          ${d.can_edit ? `<button class="cr-btn ghost" id="cr-track">Track an employee</button>` : ""}
          ${d.can_configure ? `<button class="cr-btn ghost" id="cr-settings">Settings &amp; daily email</button>`
            : `<span class="cr-muted" style="font-size:12px;align-self:center;">Payer rules, deadlines and the daily email are set by the practice owner.</span>`}
          <button class="cr-btn ghost" id="cr-refresh">Refresh</button>
        </div>
      </div>
      <div class="cr-cards">${CARD_DEFS.map((c) => `<button class="cr-card" data-card="${c.key}" style="--accent:${c.accent};"><div class="n">${c.n(s)}</div><div class="l">${c.label}</div></button>`).join("")}</div>
      ${!d.payers_configured && d.can_configure ? `<div class="cr-panel" style="padding:12px 16px;margin-bottom:14px;font-size:13px;">No payer requires individual linking yet, so linking shows N/A for everyone and does not hold up any approval. <a href="#" id="cr-cfg-link">Choose which payers need individual linking</a>.</div>` : ""}
      <div class="cr-panel">
        <div class="cr-filters">
          <input class="grow" id="cr-q" placeholder="Search name or position" value="${esc(f.q)}" />
          <select id="cr-pos">${opt("", "All positions", f.position)}${d.positions.map((p) => opt(p.key, p.label, f.position)).join("")}</select>
          <select id="cr-st">${opt("", "All statuses", f.status)}${d.statuses.map((x) => opt(x.key, x.label, f.status)).join("")}</select>
          <select id="cr-co">${opt("", "All coordinators", f.coordinator)}${opt("__none", "No coordinator", f.coordinator)}${d.coordinators.map((c) => opt(c, c, f.coordinator)).join("")}</select>
          <label>Hired from <input type="date" id="cr-from" value="${esc(f.from)}" /></label>
          <label>to <input type="date" id="cr-to" value="${esc(f.to)}" /></label>
          <span class="cr-muted" id="cr-count" style="margin-left:auto;"></span>
        </div>
        <div style="overflow-x:auto;"><table class="cr-table">
          <thead><tr><th>Employee</th><th>Position</th><th>Hire date</th><th>Credentialing progress</th><th>Payer linking</th><th>Current status</th><th>Target completion</th><th></th></tr></thead>
          <tbody id="cr-rows"></tbody></table></div>
      </div>
      ${d.candidates.length ? `<details class="cr-cands cr-panel"><summary>Still in recruitment (${d.candidates.length})</summary>
        <div style="overflow-x:auto;"><table class="cr-table"><thead><tr><th>Candidate</th><th>Position</th><th>Stage</th><th>Days in stage</th><th>Proposed start</th><th>Owner</th></tr></thead><tbody>
        ${d.candidates.map((c) => `<tr style="cursor:default;"><td data-l="Candidate"><strong>${esc(c.name)}</strong></td><td data-l="Position">${esc(c.position)}</td><td data-l="Stage">${esc(c.stage)}</td>
          <td data-l="Days in stage">${c.days_in_stage == null ? "—" : c.days_in_stage}</td><td data-l="Proposed start">${esc(shortDate(c.proposed_start))}</td><td data-l="Owner">${esc(c.owner)}</td></tr>`).join("")}
        </tbody></table></div></details>` : ""}
      <div class="cr-muted" style="margin-top:10px;">Updated ${esc(stamp(d.generated_at))}. Payer linking never holds up internal approval.</div>
    </div>`;

    const on = (id, ev, fn) => { const x = mount.querySelector(id); if (x) x.addEventListener(ev, fn); };
    on("#cr-q", "input", (e) => { f.q = e.target.value; paintTable(); });
    on("#cr-pos", "change", (e) => { f.position = e.target.value; paintTable(); });
    on("#cr-st", "change", (e) => { f.status = e.target.value; paintTable(); });
    on("#cr-co", "change", (e) => { f.coordinator = e.target.value; paintTable(); });
    on("#cr-from", "change", (e) => { f.from = e.target.value; paintTable(); });
    on("#cr-to", "change", (e) => { f.to = e.target.value; paintTable(); });
    on("#cr-refresh", "click", () => renderPage(mount));
    on("#cr-settings", "click", () => openSettings());
    on("#cr-cfg-link", "click", (e) => { e.preventDefault(); openSettings(); });
    on("#cr-track", "click", () => openTrack());
    mount.querySelectorAll(".cr-card").forEach((c) => c.addEventListener("click", () => {
      f.status = f.status === c.dataset.card ? "" : c.dataset.card;
      const sel = mount.querySelector("#cr-st"); if (sel) sel.value = f.status;
      paintTable();
    }));
    mount.querySelector("#cr-rows").addEventListener("click", (e) => {
      const tr = e.target.closest("[data-emp]");
      if (tr) openPerson(Number(tr.dataset.emp));
    });
    paintTable();
    const hashId = (location.hash.match(/^#\/credentialing\/(\d+)/) || [])[1];
    if (hashId) openPerson(Number(hashId));
  }

  // ---- drawer plumbing ----------------------------------------------------
  function drawer(title, sub) {
    closeDrawer();
    const scrim = document.createElement("div"); scrim.className = "cr-scrim"; scrim.id = "cr-scrim";
    const dr = document.createElement("div"); dr.className = "cr-drawer cr"; dr.id = "cr-drawer";
    dr.setAttribute("role", "dialog"); dr.setAttribute("aria-label", title);
    dr.innerHTML = `<div class="cr-dhead"><div><h2>${esc(title)}</h2>${sub ? `<div class="cr-muted">${esc(sub)}</div>` : ""}</div><button class="cr-x" aria-label="Close">&times;</button></div><div class="cr-dbody"><div class="cr-empty">Loading…</div></div>`;
    document.body.appendChild(scrim); document.body.appendChild(dr);
    scrim.addEventListener("click", closeDrawer);
    dr.querySelector(".cr-x").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", escClose);
    return dr.querySelector(".cr-dbody");
  }
  function escClose(e) { if (e.key === "Escape") closeDrawer(); }
  function closeDrawer() {
    ["cr-scrim", "cr-drawer"].forEach((id) => { const x = document.getElementById(id); if (x) x.remove(); });
    document.removeEventListener("keydown", escClose);
  }

  // ---- the employee panel ---------------------------------------------------
  async function openPerson(empId) {
    const pre = S.data && S.data.people.find((p) => p.employee_id === empId);
    const body = drawer(pre ? pre.name : "Employee", pre ? pre.position : "");
    let d;
    try { d = await api("/api/credentialing/employees/" + empId); }
    catch (e) { body.innerHTML = `<div class="cr-box">${esc(e.message)}</div>`; return; }
    paintPerson(body, d);
  }

  function paintPerson(body, d) {
    const p = d.person, edit = !!d.can_edit;
    const head = document.querySelector("#cr-drawer .cr-dhead h2");
    if (head) head.textContent = p.name;
    const step = (m, i) => {
      const t = TONE[m.status] || TONE.pending;
      const prev = i ? p.milestones[i - 1] : null;
      const line = prev && prev.status === "complete" ? TONE.complete.bar : "#e5e7eb";
      return `<div class="cr-step" style="--line:${line};"><div class="c" style="background:${t.bg};color:${t.fg};box-shadow:0 0 0 2px ${t.bar};">${m.status === "complete" ? "&#10003;" : i + 1}</div>${esc(m.label)}<div class="cr-muted" style="font-weight:600;">${esc(m.status_label)}</div></div>`;
    };
    const msBox = (m) => {
      const t = TONE[m.status] || TONE.pending;
      const opts = [["auto", "Follow the HR records"], ["in_progress", "In progress"], ["pending", "Pending"], ["complete", "Complete (sign off)"]];
      const curSel = m.auto_complete ? "auto" : (m.status === "complete" ? "complete" : (m.status === "overdue" || m.status === "pending" || m.status === "in_progress") ? "__keep" : "auto");
      return `<div class="cr-box cr-ms" style="--accent:${t.bar};" data-ms="${m.key}">
        <div class="cr-ms-head"><strong>${esc(m.label)}</strong>${pill(m.status, m.status_label)}${m.sign_off_required ? `<span class="cr-muted">Sign-off required</span>` : ""}</div>
        <div class="cr-grid" style="margin-top:10px;">
          <div><div class="k">Completed</div><div class="v">${m.completed_at ? esc(stamp(m.completed_at)) + `<div class="cr-muted">by ${esc(m.completed_by || "—")}</div>` : "—"}</div></div>
          <div><div class="k">Responsible</div><div class="v">${esc(m.responsible)}</div></div>
          <div><div class="k">Due</div><div class="v">${esc(shortDate(m.due_date))}${m.due_overridden ? ` <span class="cr-muted">(set by HR)</span>` : ""}</div></div>
          <div><div class="k">Last updated</div><div class="v">${m.updated_at ? esc(stamp(m.updated_at)) + `<div class="cr-muted">by ${esc(m.updated_by || "—")}</div>` : "—"}</div></div>
        </div>
        ${m.notes ? `<div style="margin-top:8px;font-size:13px;"><span class="cr-muted">Notes:</span> ${esc(m.notes)}</div>` : ""}
        ${m.requirements.length ? `<ul class="cr-req">${m.requirements.map((r) => `<li><span class="${r.done ? "ok" : "no"}">${r.done ? "&#10003;" : "&bull;"}</span><span>${esc(r.label)}${r.detail ? ` <span class="cr-muted">(${esc(r.detail)})</span>` : ""} <span class="cr-muted">· ${esc(r.owner)}</span>${r.kind === "payer" && !r.done ? ` <span class="cr-muted">· waiting on the insurer</span>` : ""}</span></li>`).join("")}</ul>` : ""}
        ${m.missing.length ? `<div class="cr-muted" style="margin-top:6px;"><strong>Missing:</strong> ${esc(m.missing.join("; "))}</div>` : ""}
        ${edit ? `<div class="cr-edit">
          <label class="cr-field">Status<select data-f="status">${curSel === "__keep" ? `<option value="__keep" selected>${esc(m.status_label)} (current)</option>` : ""}${opts.map(([v, l]) => `<option value="${v}"${v === curSel ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          <label class="cr-field">Responsible<input data-f="responsible" value="${esc(m.responsible)}" /></label>
          <label class="cr-field">Due date<input type="date" data-f="due_date" value="${esc(m.due_overridden ? m.due_date : "")}" placeholder="${esc(m.due_date || "")}" /></label>
          <label class="cr-field wide">Notes (visible to clinical leadership)<textarea data-f="notes" rows="2">${esc(m.notes || "")}</textarea></label>
          <div class="cr-field wide" style="flex-direction:row;align-items:center;gap:10px;"><button class="cr-btn small" data-save="${m.key}">Save</button><span class="cr-msg" data-msg="${m.key}"></span></div>
        </div>` : ""}
      </div>`;
    };
    const link = p.payer_linking;
    body.innerHTML = `
      <div class="cr-box">
        <div class="cr-ms-head" style="margin-bottom:12px;">${pill(p.status, p.status_label)}<span class="cr-muted">${esc(p.current_stage)}</span></div>
        <div class="cr-grid">
          <div><div class="k">Position</div><div class="v">${esc(p.position)}</div></div>
          <div><div class="k">Hire date</div><div class="v">${esc(shortDate(p.hire_date))}</div></div>
          <div><div class="k">Expected start</div><div class="v">${esc(shortDate(p.expected_start_date))}</div></div>
          <div><div class="k">Days in onboarding</div><div class="v">${p.days_in_onboarding}</div></div>
          <div><div class="k">Onboarding coordinator</div><div class="v">${esc(p.coordinator || "Not assigned")}</div></div>
          <div><div class="k">Target completion</div><div class="v">${esc(shortDate(p.target_completion_date))}</div></div>
        </div>
        ${p.next_action ? `<div style="margin-top:12px;font-size:13px;background:#f7f8fb;border-radius:10px;padding:8px 10px;"><span class="cr-muted">Next:</span> <strong>${esc(p.next_action.label)}</strong> <span class="cr-muted">· ${esc(p.next_action.owner)}</span></div>` : ""}
        ${edit ? `<div class="cr-edit">
          <label class="cr-field">Coordinator<input id="cr-coord" value="${esc(p.coordinator || "")}" placeholder="Name" /></label>
          <label class="cr-field">Target completion<input type="date" id="cr-target" value="${esc(p.target_overridden ? p.target_completion_date : "")}" /></label>
          <div class="cr-field" style="justify-content:flex-end;"><button class="cr-btn small" id="cr-save-track">Save</button></div>
          <span class="cr-msg wide" id="cr-track-msg"></span>
        </div>` : ""}
      </div>
      <div class="cr-box"><div class="cr-section-title">Internal credentialing milestones</div>
        <div class="cr-track">${p.milestones.map(step).join("")}</div>
        <div style="margin-top:10px;">${bar(p.progress, p.approved ? "complete" : p.status === "overdue" ? "overdue" : "in_progress")}</div>
        <div class="cr-muted" style="margin-top:4px;">${p.milestones_done} of ${p.milestones_total} complete${p.approved ? ` · approved ${esc(stamp(p.approved_at))} by ${esc(p.approved_by || "—")}` : ""}</div>
      </div>
      ${p.milestones.map(msBox).join("")}
      <div class="cr-box"><div class="cr-section-title">Insurance payer linking</div>
        <div class="cr-muted" style="margin-bottom:8px;">Confirmed linking is part of final internal approval.${edit ? " Edit linking on the HR Hub staff card." : ""}</div>
        ${link.length ? `<div style="overflow-x:auto;"><table class="cr-ptable"><thead><tr><th>Payer</th><th>Status</th><th>Submitted</th><th>Confirmed</th><th>Effective</th></tr></thead><tbody>
          ${link.map((l) => `<tr><td><strong>${esc(l.payer)}</strong>${l.why ? `<div class="cr-muted">${esc(l.why)}</div>` : ""}</td><td>${pill(l.state === "linked" ? "linked" : l.state, l.state_label)}${l.days_waiting != null ? `<div class="cr-muted">${l.days_waiting} days waiting</div>` : ""}</td>
            <td>${esc(shortDate(l.submitted_date))}</td><td>${esc(shortDate(l.confirmation_date))}</td><td>${esc(shortDate(l.effective_date))}</td></tr>`).join("")}
          </tbody></table></div>` : `<div class="cr-muted">N/A — no payer requires individual linking for this position.</div>`}
      </div>
      ${p.readiness.length ? `<div class="cr-box"><div class="cr-section-title">Ready to serve clients, by payer</div>
        <div class="cr-muted" style="margin-bottom:8px;">Client authorizations and supervision are still checked per client before scheduling.</div>
        <table class="cr-ptable"><tbody>${p.readiness.map((r) => `<tr><td><strong>${esc(r.payer)}</strong></td><td>${r.ready ? pill("complete", "Eligible") : pill("pending", "Not yet")}</td><td class="cr-muted">${esc(r.missing.join("; "))}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <div class="cr-box"><div class="cr-section-title">Change history</div>
        ${d.history.length ? `<ul class="cr-hist">${d.history.map((h) => `<li><strong>${esc(stamp(h.changed_at))}</strong> · ${esc(h.changed_by || "—")}<br><span class="cr-muted">${esc(h.milestone_key.replace(/_/g, " "))}:</span> ${esc(h.change)}</li>`).join("")}</ul>` : `<div class="cr-muted">No changes recorded yet.</div>`}
      </div>`;

    if (!edit) return;
    const after = async (res) => {
      if (S.mount && document.body.contains(S.mount)) {
        try { S.data = await api("/api/credentialing"); renderPageKeepDrawer(); } catch (e) {}
      }
      const fresh = await api("/api/credentialing/employees/" + p.employee_id);
      paintPerson(body, fresh);
    };
    body.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", async () => {
      const key = b.dataset.save, box = body.querySelector(`[data-ms="${key}"]`), msg = body.querySelector(`[data-msg="${key}"]`);
      const payload = {};
      box.querySelectorAll("[data-f]").forEach((i) => { payload[i.dataset.f] = i.value; });
      if (payload.status === "__keep") delete payload.status;
      if (payload.due_date === "") payload.due_date = null;
      b.disabled = true;
      try { await api(`/api/credentialing/employees/${p.employee_id}/milestones/${key}`, { method: "PATCH", body: payload }); await after(); }
      catch (e) { b.disabled = false; msg.textContent = e.message; msg.style.color = "#b91c1c"; }
    }));
    const st = body.querySelector("#cr-save-track");
    if (st) st.addEventListener("click", async () => {
      st.disabled = true;
      try {
        await api(`/api/credentialing/employees/${p.employee_id}`, { method: "PATCH", body: {
          coordinator: body.querySelector("#cr-coord").value, target_completion_date: body.querySelector("#cr-target").value || null } });
        await after();
      } catch (e) { st.disabled = false; const m = body.querySelector("#cr-track-msg"); m.textContent = e.message; m.style.color = "#b91c1c"; }
    });
  }
  // Repaint the page behind the drawer without closing it.
  function renderPageKeepDrawer() {
    if (!S.mount) return;
    const s = S.data.summary;
    S.mount.querySelectorAll(".cr-card").forEach((c) => {
      const def = CARD_DEFS.find((x) => x.key === c.dataset.card);
      if (def) c.querySelector(".n").textContent = def.n(s);
    });
    paintTable();
  }

  // ---- track an employee who is not marked Onboarding ----------------------
  async function openTrack() {
    const body = drawer("Track an employee", "Add someone the HR Hub does not have as Onboarding");
    let d;
    try { d = await api("/api/credentialing/trackable"); } catch (e) { body.innerHTML = `<div class="cr-box">${esc(e.message)}</div>`; return; }
    body.innerHTML = `<div class="cr-box">
      <div class="cr-muted" style="margin-bottom:10px;">Employees marked Onboarding in the HR Hub are tracked automatically. Use this for a recent hire who is already active.</div>
      ${d.employees.length ? `<label class="cr-field">Employee<select id="cr-pick">${d.employees.map((e) => `<option value="${e.id}">${esc(e.name)}${e.position ? " — " + esc(e.position) : ""}${e.hire_date ? " (hired " + esc(shortDate(e.hire_date)) + ")" : ""}</option>`).join("")}</select></label>
      <div style="margin-top:10px;"><button class="cr-btn" id="cr-pick-go">Add to tracker</button> <span class="cr-msg" id="cr-pick-msg"></span></div>` : `<div class="cr-muted">Everyone eligible is already on the tracker.</div>`}
    </div>`;
    const go = body.querySelector("#cr-pick-go");
    if (go) go.addEventListener("click", async () => {
      go.disabled = true;
      const id = Number(body.querySelector("#cr-pick").value);
      try { await api("/api/credentialing/track", { method: "POST", body: { employee_id: id } }); closeDrawer(); await renderPage(S.mount); openPerson(id); }
      catch (e) { go.disabled = false; const m = body.querySelector("#cr-pick-msg"); m.textContent = e.message; m.style.color = "#b91c1c"; }
    });
  }

  // ---- settings: payer rules, due dates, the daily email --------------------
  async function openSettings() {
    const body = drawer("Credentialing settings", "Owner and admin only");
    let c, log;
    try { [c, log] = await Promise.all([api("/api/credentialing/config"), api("/api/credentialing/email/log")]); }
    catch (e) { body.innerHTML = `<div class="cr-box">${esc(e.message)}</div>`; return; }
    const em = c.email;
    const posBoxes = (p) => c.positions.map((x) => `<label class="cr-check"><input type="checkbox" data-pos="${x.key}"${p.positions.includes(x.key) ? " checked" : ""} /> ${esc(x.label)}</label>`).join("");
    const LOG_TONE = { sent: "complete", simulated: "in_progress", skipped: "not_required", failed: "overdue", partial: "pending", running: "in_progress", sending: "in_progress" };
    body.innerHTML = `
      <div class="cr-box"><div class="cr-section-title">Daily onboarding email</div>
        <div class="cr-muted" style="margin-bottom:10px;">Sent at the time below, Pacific time (daylight saving handled), only when at least one active new hire has incomplete internal onboarding. Payer linking alone never triggers it.</div>
        <div class="cr-edit" style="border:0;padding:0;margin:0;">
          <label class="cr-check"><input type="checkbox" id="cr-em-on"${em.enabled ? " checked" : ""} /> Send the daily email</label>
          <label class="cr-field">Send time (Pacific)<input type="time" id="cr-em-time" value="${esc(em.time)}" /></label>
          <div></div>
          <label class="cr-field wide">Recipients (one per line or comma separated)<textarea id="cr-em-to" rows="3" placeholder="Leave blank to send to the Clinical Director and Assistants">${esc(em.recipients.join("\n"))}</textarea></label>
        </div>
        <div class="cr-muted" style="margin-top:6px;">Currently going to: <strong>${esc(em.effective_recipients.join(", ") || "nobody")}</strong> ${em.recipient_source === "clinical_leadership" ? "(Clinical Director and Assistants)" : em.recipient_source === "owner_notification_email" ? "(owner notification address)" : ""}</div>
        <div class="cr-actions" style="margin-top:12px;">
          <button class="cr-btn small" id="cr-em-save">Save email settings</button>
          <button class="cr-btn small ghost" id="cr-em-preview">Preview</button>
          <button class="cr-btn small ghost" id="cr-em-test">Send me a test</button>
          <button class="cr-btn small ghost" id="cr-em-run">Run today's report now</button>
          <button class="cr-btn small ghost" id="cr-em-retry">Retry failed</button>
        </div>
        <div class="cr-msg" id="cr-em-msg"></div>
        <div id="cr-em-prev"></div>
      </div>
      <div class="cr-box"><div class="cr-section-title">Delivery log</div>
        ${log.log.length ? `<div style="overflow-x:auto;"><table class="cr-ptable"><thead><tr><th>Day</th><th>Recipient</th><th>Status</th><th>Detail</th></tr></thead><tbody>
          ${log.log.map((r) => `<tr><td>${esc(shortDate(r.report_date))}<div class="cr-muted">${esc(r.kind)}</div></td><td>${esc(r.recipient === "*" ? "Daily run" : r.recipient)}</td>
            <td>${pill(LOG_TONE[r.status] || "pending", r.status)}${r.attempts > 1 ? `<div class="cr-muted">${r.attempts} attempts</div>` : ""}</td><td class="cr-muted">${esc(r.reason || r.error || "")}</td></tr>`).join("")}
          </tbody></table></div>` : `<div class="cr-muted">Nothing sent yet.</div>`}
      </div>
      <div class="cr-box"><div class="cr-section-title">Payer linking rules</div>
        <div class="cr-muted" style="margin-bottom:10px;">Only a payer switched on here is tracked. Payers left off do not appear on anyone's record and never hold up an approval. Confirmed linking is part of final internal approval. Leave every position unticked to mean all positions.</div>
        <div id="cr-payers">${c.payers.map((p, i) => `<div class="cr-box" style="margin-bottom:8px;padding:10px 12px;" data-payer="${i}">
          <div class="cr-ms-head"><strong data-name>${esc(p.payer)}</strong>
            <label class="cr-check" style="margin-left:auto;"><input type="checkbox" data-req${p.requires_linking ? " checked" : ""} /> Requires individual linking</label></div>
          <div data-detail style="display:${p.requires_linking ? "block" : "none"};">
            <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;">${posBoxes(p)}</div>
            <label class="cr-check" style="margin-top:8px;"><input type="checkbox" data-case${p.caseload_only ? " checked" : ""} /> Only staff with this payer's clients on their caseload</label>
          </div>
        </div>`).join("")}</div>
        <div style="display:flex;gap:8px;margin-top:6px;"><input id="cr-new-payer" placeholder="Add another payer" style="flex:1;font:inherit;font-size:13px;padding:7px 10px;border:1px solid #dcdfea;border-radius:10px;" /><button class="cr-btn small ghost" id="cr-add-payer">Add</button></div>
      </div>
      <div class="cr-box"><div class="cr-section-title">Milestone due dates</div>
        <div class="cr-muted" style="margin-bottom:10px;">Days after the hire date. HR can override any one person's due date on their panel.</div>
        <div class="cr-edit" style="border:0;padding:0;margin:0;grid-template-columns:repeat(2,minmax(0,1fr));">
          ${S.data.milestones.map((m) => `<label class="cr-field">${esc(m.label)}<input type="number" min="0" max="365" data-due="${m.key}" value="${c.due_days[m.key]}" /></label>`).join("")}
        </div>
      </div>
      <div><button class="cr-btn" id="cr-cfg-save">Save payer rules and due dates</button> <span class="cr-msg" id="cr-cfg-msg"></span></div>`;

    const msg = (id, t, bad) => { const m = body.querySelector(id); m.textContent = t; m.style.color = bad ? "#b91c1c" : "#166534"; };
    const emailBody = () => ({ enabled: body.querySelector("#cr-em-on").checked, time: body.querySelector("#cr-em-time").value, recipients: body.querySelector("#cr-em-to").value });
    const act = (id, fn) => { const b = body.querySelector(id); b.addEventListener("click", async () => { b.disabled = true; try { await fn(); } catch (e) { msg("#cr-em-msg", e.message, true); } b.disabled = false; }); };
    act("#cr-em-save", async () => { await api("/api/credentialing/config", { method: "PUT", body: { email: emailBody() } }); msg("#cr-em-msg", "Saved."); setTimeout(openSettings, 600); });
    act("#cr-em-preview", async () => {
      const p = await api("/api/credentialing/email/preview");
      msg("#cr-em-msg", p.would_send ? `Would send today: ${p.reason}.` : p.reason, !p.would_send);
      const box = body.querySelector("#cr-em-prev");
      box.innerHTML = `<div class="cr-muted" style="margin:10px 0 4px;"><strong>Subject:</strong> ${esc(p.subject)}</div><iframe title="Email preview" style="width:100%;height:560px;border:1px solid #eceef5;border-radius:12px;background:#fff;"></iframe>`;
      box.querySelector("iframe").srcdoc = p.html;
    });
    act("#cr-em-test", async () => { const r = await api("/api/credentialing/email/test", { method: "POST", body: {} }); msg("#cr-em-msg", r.status === "simulated" ? `Test logged to ${r.to}, but no email provider is configured, so it was not actually delivered.` : r.ok ? `Test sent to ${r.to}.` : "The test failed. See the delivery log.", !r.ok || r.status === "simulated"); });
    act("#cr-em-run", async () => {
      const r = await api("/api/credentialing/email/run", { method: "POST", body: {} });
      msg("#cr-em-msg", !r.ran ? "Today's report already ran. Use Retry failed for any failed deliveries." : r.status === "skipped" ? "Nobody has pending onboarding, so no email was sent." : `Report ${r.status}: ${r.sent} delivered${r.failed ? `, ${r.failed} failed` : ""}.`, r.status === "failed");
      setTimeout(openSettings, 1200);
    });
    act("#cr-em-retry", async () => { const r = await api("/api/credentialing/email/retry", { method: "POST", body: {} }); msg("#cr-em-msg", r.retried && r.retried.length ? `Retried ${r.retried.length} delivery(ies).` : "Nothing needed retrying."); setTimeout(openSettings, 1200); });
    body.querySelector("#cr-add-payer").addEventListener("click", () => {
      const name = body.querySelector("#cr-new-payer").value.trim();
      if (!name) return;
      c.payers.push({ payer: name, requires_linking: false, positions: [], caseload_only: false });
      const wrap = body.querySelector("#cr-payers");
      const i = c.payers.length - 1;
      wrap.insertAdjacentHTML("beforeend", `<div class="cr-box" style="margin-bottom:8px;padding:10px 12px;" data-payer="${i}"><div class="cr-ms-head"><strong data-name>${esc(name)}</strong>
        <label class="cr-check" style="margin-left:auto;"><input type="checkbox" data-req /> Requires individual linking</label></div>
        <div data-detail style="display:none;">
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;">${posBoxes(c.payers[i])}</div>
          <label class="cr-check" style="margin-top:8px;"><input type="checkbox" data-case /> Only staff with this payer's clients on their caseload</label>
        </div></div>`);
      body.querySelector("#cr-new-payer").value = "";
      wireReqToggles();
    });
    // A payer that needs no individual linking needs none of the settings that
    // go with it, so they stay out of the way until it is switched on.
    function wireReqToggles() {
      body.querySelectorAll("[data-payer] [data-req]").forEach((box) => {
        if (box.dataset.wired) return;
        box.dataset.wired = "1";
        box.addEventListener("change", () => {
          const d = box.closest("[data-payer]").querySelector("[data-detail]");
          if (d) d.style.display = box.checked ? "block" : "none";
        });
      });
    }
    wireReqToggles();
    const save = body.querySelector("#cr-cfg-save");
    save.addEventListener("click", async () => {
      const payers = [...body.querySelectorAll("[data-payer]")].map((row) => ({
        payer: row.querySelector("[data-name]").textContent,
        requires_linking: row.querySelector("[data-req]").checked,
        caseload_only: row.querySelector("[data-case]").checked,
        positions: [...row.querySelectorAll("[data-pos]:checked")].map((x) => x.dataset.pos),
      }));
      const due_days = {};
      body.querySelectorAll("[data-due]").forEach((i) => { due_days[i.dataset.due] = Number(i.value); });
      save.disabled = true;
      try { await api("/api/credentialing/config", { method: "PUT", body: { payers, due_days } }); msg("#cr-cfg-msg", "Saved."); await renderPage(S.mount); openSettings(); }
      catch (e) { save.disabled = false; msg("#cr-cfg-msg", e.message, true); }
    });
  }

  window.__renderCredentialing = async function (mount) { closeDrawer(); await renderPage(mount); };

  // ======================================================================
  // 2. COMPACT CARD on the Clinical Director's dashboards
  // ======================================================================
  window.__fillStaffProgression = async function (el, surface) {
    if (!el) return;
    injectStyles();
    let d;
    try { d = await api("/api/staff-progression" + (surface === "admin" ? "?surface=admin" : "")); }
    catch (e) { el.innerHTML = ""; el.style.display = "none"; return; }
    if (!d || !d.visible) { el.innerHTML = ""; el.style.display = "none"; return; }
    const s = d.summary;
    const urgent = d.people.filter((p) => p.status === "overdue" || p.status === "action_needed").slice(0, 3);
    el.style.display = "";
    el.innerHTML = `<div class="cr-mini cr">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <div><div class="cr-eyebrow">New hire credentialing</div><div style="font-weight:800;font-size:16px;color:var(--brand-navy,#1b2a6b);">Staff progression</div></div>
        <a href="#/credentialing" class="cr-btn small ghost" style="margin-left:auto;text-decoration:none;">Open dashboard</a>
      </div>
      <div class="cr-mini-cards">
        <div><b style="color:#1b2a6b;">${s.total}</b><span>New hires</span></div>
        <div><b style="color:#16a34a;">${s.approved}</b><span>Approved</span></div>
        <div><b style="color:#2563eb;">${s.in_progress}</b><span>In progress</span></div>
        <div><b style="color:#d97706;">${s.action_needed}</b><span>Action needed</span></div>
        <div><b style="color:#dc2626;">${s.overdue}</b><span>Overdue</span></div>
      </div>
      ${urgent.length ? urgent.map((p) => `<a href="#/credentialing/${p.employee_id}" style="display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid #f3f4f8;text-decoration:none;color:inherit;font-size:13px;">
        ${pill(p.status, p.status_label)}<strong>${esc(p.name)}</strong><span class="cr-muted">${esc(p.next_action ? p.next_action.label : p.current_stage)}</span></a>`).join("")
        : `<div class="cr-muted">Nobody needs action right now.</div>`}
    </div>`;
  };

  // ======================================================================
  // 3. HR HUB STAFF CARD: payer enrollment
  // ======================================================================
  const DATE_FOR_STATUS = { submitted: "submitted_date", pending: "pending_date", approved: "approved_date", effective: "effective_date" };
  const PAYER_TONE = {
    not_started: TONE.not_started, submitted: TONE.submitted, pending: TONE.in_progress, approved: TONE.complete,
    effective: TONE.complete, denied: TONE.overdue, not_required: TONE.not_required,
  };

  window.__renderPayerEnrollments = async function (el, employeeId) {
    if (!el || !employeeId) return;
    injectStyles();
    el.innerHTML = `<div class="empty-state">Loading payer enrollment…</div>`;
    let d;
    try { d = await api("/api/payer-enrollments?employee_id=" + encodeURIComponent(employeeId)); }
    catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.status === 403 ? "You don't have access to payer enrollment." : e.message)}</div>`; return; }
    const manage = !!d.can_manage;
    const opts = (list, cur) => list.map((x) => `<option value="${esc(x.key)}"${x.key === cur ? " selected" : ""}>${esc(x.label)}</option>`).join("");
    const listId = "spw-payers-" + employeeId;
    const rowEdit = (r) => {
      const t = PAYER_TONE[r.status] || PAYER_TONE.not_started;
      if (!manage) {
        return `<div class="spw-pe-row"><div class="spw-pe-head"><strong>${esc(r.payer)} · ${esc(r.kind_label)}</strong>
          <span class="spw-pst" style="background:${t.bg}; color:${t.fg};">${esc(r.status_label)}</span></div>
          <div style="font-size:12px; color:#6b7280;">Submitted ${esc(shortDate(r.submitted_date))} · Pending ${esc(shortDate(r.pending_date))} · Confirmed ${esc(shortDate(r.approved_date))} · Effective ${esc(shortDate(r.effective_date))}</div></div>`;
      }
      const dateIn = (f, label) => `<div><label>${label}</label><input type="date" data-pe="${f}" value="${esc(r[f] || "")}" /></div>`;
      return `<div class="spw-pe-row" data-pe-row="${r.id}">
        <div class="spw-pe-head"><strong>${esc(r.payer)} · ${esc(r.kind_label)}</strong>
          <span class="spw-pst" style="background:${t.bg}; color:${t.fg};">${esc(r.status_label)}${r.days_waiting != null ? ` · ${r.days_waiting}d` : ""}</span></div>
        <div class="spw-pe-grid">
          <div><label>Status</label><select data-pe="status">${opts(d.statuses, r.stored_status)}</select></div>
          ${dateIn("submitted_date", "Submitted")}${dateIn("pending_date", "Pending since")}
          ${dateIn("approved_date", "Confirmed / approved")}${dateIn("effective_date", "Effective")}
          <div><label>Next action owner</label><input data-pe="next_action_owner" value="${esc(r.next_action_owner || "")}" placeholder="Credentialing (HR)" /></div>
        </div>
        <div style="margin-top:8px;"><label style="font-size:11px; color:#6b7280;">Notes (HR only — not shown on the dashboard)</label>
          <input data-pe="notes" value="${esc(r.notes || "")}" style="width:100%; box-sizing:border-box; font:inherit; font-size:12.5px; padding:5px 7px; border:1px solid #d9dce6; border-radius:7px;" /></div>
        <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
          <button class="btn small" data-pe-save="${r.id}">Save</button>
          <button class="btn small secondary" data-pe-del="${r.id}">Remove</button>
          <span class="spw-pe-msg" data-pe-msg="${r.id}"></span>
        </div>
      </div>`;
    };
    el.innerHTML = `
      <div style="font-size:12px; color:var(--text-muted, #6b7280); margin-bottom:8px;">Group linking and individual credentialing with each payer. The Credentialing dashboard reads this; it is not kept anywhere else. It never holds up internal approval.</div>
      ${d.enrollments.length ? d.enrollments.map(rowEdit).join("") : `<div class="empty-state">No payer enrollment recorded yet.</div>`}
      ${manage ? `<div class="spw-pe-add">
        <div><label style="font-size:11px; color:#6b7280;">Payer</label><input data-pe-new="payer" list="${listId}" placeholder="e.g. Nevada Medicaid" />
          <datalist id="${listId}">${d.payer_suggestions.map((p) => `<option value="${esc(p)}"></option>`).join("")}</datalist></div>
        <div><label style="font-size:11px; color:#6b7280;">Type</label><select data-pe-new="kind">${opts(d.kinds, "group_link")}</select></div>
        <div><label style="font-size:11px; color:#6b7280;">Status</label><select data-pe-new="status">${opts(d.statuses, "not_started")}</select></div>
        <button class="btn small" data-pe-add="1">Add</button>
      </div><div class="spw-pe-msg" data-pe-msg="new"></div>` : ""}`;

    if (!manage) return;
    const msg = (k, t, bad) => { const m = el.querySelector(`[data-pe-msg="${k}"]`); if (m) { m.textContent = t; m.style.color = bad ? "#b91c1c" : "#166534"; } };
    el.querySelectorAll('[data-pe-row] [data-pe="status"]').forEach((sel) => sel.addEventListener("change", () => {
      const row = sel.closest("[data-pe-row]");
      const f = DATE_FOR_STATUS[sel.value];
      const inp = f && row.querySelector(`[data-pe="${f}"]`);
      if (inp && !inp.value) inp.value = todayIso();
    }));
    el.querySelectorAll("[data-pe-save]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.peSave;
      const row = el.querySelector(`[data-pe-row="${id}"]`);
      const body = {};
      row.querySelectorAll("[data-pe]").forEach((i) => { body[i.dataset.pe] = i.value || null; });
      b.disabled = true;
      try { await api("/api/payer-enrollments/" + id, { method: "PATCH", body }); await window.__renderPayerEnrollments(el, employeeId); }
      catch (e) { b.disabled = false; msg(id, e.message, true); }
    }));
    el.querySelectorAll("[data-pe-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Remove this payer enrollment from the record? The removal is noted in the activity log.")) return;
      b.disabled = true;
      try { await api("/api/payer-enrollments/" + b.dataset.peDel, { method: "DELETE" }); await window.__renderPayerEnrollments(el, employeeId); }
      catch (e) { b.disabled = false; msg(b.dataset.peDel, e.message, true); }
    }));
    const add = el.querySelector("[data-pe-add]");
    if (add) add.addEventListener("click", async () => {
      const body = { employee_id: Number(employeeId) };
      el.querySelectorAll("[data-pe-new]").forEach((i) => { body[i.dataset.peNew] = i.value || null; });
      const f = DATE_FOR_STATUS[body.status];
      if (f) body[f] = todayIso();
      if (!body.payer) { msg("new", "Enter the payer.", true); return; }
      add.disabled = true;
      try { await api("/api/payer-enrollments", { method: "POST", body }); await window.__renderPayerEnrollments(el, employeeId); }
      catch (e) { add.disabled = false; msg("new", e.message, true); }
    });
  };
})();
