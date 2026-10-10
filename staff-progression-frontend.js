// staff-progression-frontend.js -- two screens, one source.
//
//   1. THE STAFF PROGRESSION WIDGET on the Clinical Director's dashboard.
//      Read-only. Everything on it is derived by the server from the HR Hub on
//      every load, so it is only ever as stale as the last time the page asked.
//      It re-asks when the tab regains focus and every few minutes while open.
//
//   2. THE PAYER ENROLLMENT SECTION of the HR Hub staff card, where HR records
//      group linking and credentialing with each payer. That card is the one
//      place this data is edited; the widget only reads it.
//
// Exposes window.__fillStaffProgression(el) and window.__renderPayerEnrollments(el, employeeId).
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
  function dateLabel(s) {
    if (!s) return "—";
    const p = String(s).slice(0, 10).split("-");
    if (p.length !== 3) return String(s);
    return MONTHS[+p[1] - 1] + " " + (+p[2]) + ", " + p[0];
  }
  function shortDate(s) {
    if (!s) return "—";
    const p = String(s).slice(0, 10).split("-");
    return p.length === 3 ? MONTHS[+p[1] - 1] + " " + (+p[2]) : String(s);
  }
  function ago(iso) {
    if (!iso) return "—";
    const t = Date.parse(iso.length <= 10 ? iso + "T12:00:00" : iso);
    if (!Number.isFinite(t)) return "—";
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 30) return days + " days ago";
    return shortDate(iso);
  }
  const todayIso = () => new Date().toISOString().slice(0, 10);

  function injectStyles() {
    if (document.getElementById("spw-styles")) return;
    const st = document.createElement("style");
    st.id = "spw-styles";
    // Same tokens as the BCBA dashboard panels it sits among: the cream
    // borders, the navy headings, the rounded pills.
    st.textContent = `
    /* Box sizing is set here rather than inherited from the BCBA dashboard's
       .bd wrapper, because on the main dashboard there is no such wrapper. */
    #spw-panel, #spw-panel *, #spw-panel *::before, #spw-panel *::after { box-sizing:border-box; min-width:0; }
    .spw-host { margin:20px 0; }
    .spw-host .bd-panel { margin-bottom:0; }
    .spw-sum { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
    .spw-chip { font-size:11px; font-weight:700; padding:3px 9px; border-radius:20px; white-space:nowrap; display:inline-block; }
    .spw-tools { padding:10px 15px; border-bottom:1px solid #f0ece2; display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between; }
    .spw-phases { display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:6px; padding:10px 15px; border-bottom:1px solid #f0ece2; }
    @media (max-width: 640px) { .spw-phases { grid-template-columns:repeat(3, minmax(0,1fr)); } }
    .spw-ph { border:1px solid #ece8dd; border-radius:9px; background:#fff; padding:6px 8px; text-align:left; font:inherit; cursor:pointer; }
    .spw-ph:hover { border-color:#c9c2ae; }
    .spw-ph.on { border-color:#1b2a6b; box-shadow:inset 0 0 0 1px #1b2a6b; }
    .spw-ph-n { font-size:17px; font-weight:700; color:#1b2a6b; line-height:1.1; }
    .spw-ph-l { font-size:10.5px; color:#767488; font-weight:600; line-height:1.25; }
    .spw-list { }
    .spw-row { display:grid; grid-template-columns: minmax(150px,1.5fr) minmax(130px,1.2fr) 92px minmax(170px,1.6fr) 74px 18px;
      gap:10px; align-items:center; width:100%; padding:9px 15px 9px 12px; border:0; border-bottom:1px solid #f6f3ec;
      border-left:3px solid transparent; background:#fff; text-align:left; font:inherit; cursor:pointer; }
    .spw-row:hover { background:#faf8f3; }
    .spw-row.delayed { border-left-color:#dc2626; }
    .spw-row.soon { border-left-color:#eab308; }
    .spw-row[aria-expanded="true"] { background:#faf8f3; }
    .spw-hdr { display:grid; grid-template-columns: minmax(150px,1.5fr) minmax(130px,1.2fr) 92px minmax(170px,1.6fr) 74px 18px;
      gap:10px; padding:7px 15px 7px 15px; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:#767488; font-weight:700; border-bottom:1px solid #f0ece2; }
    @media (max-width: 860px) {
      .spw-hdr { display:none; }
      .spw-row { grid-template-columns: 1fr auto; row-gap:6px; }
      .spw-row > .spw-c-phase, .spw-row > .spw-c-next { grid-column: 1 / -1; }
      .spw-row > .spw-c-start, .spw-row > .spw-c-upd { font-size:11px; }
      .spw-row > .spw-chev { display:none; }
    }
    .spw-name { font-size:13px; font-weight:700; color:#1b2a6b; display:block; }
    .spw-pos { font-size:11.5px; color:#767488; display:block; }
    .spw-steps { display:flex; gap:3px; margin-top:5px; }
    .spw-steps i { height:5px; flex:1 1 0; border-radius:3px; background:#eeecf6; display:block; }
    .spw-steps i.done { background:#1b2a6b; }
    .spw-steps i.cur { background:linear-gradient(90deg,#1b2a6b var(--f,0%),#c7cbe6 var(--f,0%)); }
    .spw-pct { font-size:10.5px; color:#767488; margin-left:6px; font-weight:600; }
    .spw-start { font-size:12px; font-weight:600; color:#1f2430; display:block; }
    .spw-start-s { font-size:10.5px; color:#767488; display:block; }
    .spw-next { font-size:12px; color:#1f2430; display:block; line-height:1.35; }
    .spw-who { font-size:10.5px; color:#767488; display:flex; gap:5px; align-items:center; flex-wrap:wrap; margin-top:2px; }
    .spw-wait { font-size:9.5px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; padding:1px 6px; border-radius:4px; }
    .spw-wait.int { background:#e0e7ff; color:#1e3a8a; }
    .spw-wait.ext { background:#f3e8ff; color:#6b21a8; }
    .spw-out { font-size:10.5px; color:#9a3412; font-weight:700; }
    .spw-upd { font-size:11px; color:#767488; }
    .spw-chev { color:#b9b6c9; transition:transform .12s; }
    .spw-row[aria-expanded="true"] .spw-chev { transform:rotate(90deg); }
    .spw-detail { padding:12px 15px 14px; background:#fdfcf9; border-bottom:1px solid #f0ece2; }
    .spw-flags { display:flex; flex-direction:column; gap:5px; margin-bottom:10px; }
    .spw-flag { font-size:12px; padding:6px 10px; border-radius:8px; }
    .spw-flag.red { background:#fee2e2; color:#991b1b; }
    .spw-flag.amber { background:#fef9c3; color:#854d0e; }
    .spw-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(min(260px,100%), 1fr)); gap:12px; }
    .spw-box { background:#fff; border:1px solid #ece8dd; border-radius:10px; padding:10px 12px; }
    .spw-bt { font-size:10.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#767488; margin:0 0 6px; }
    .spw-req { display:flex; gap:8px; align-items:flex-start; justify-content:space-between; font-size:12px; padding:4px 0; border-bottom:1px solid #f6f3ec; }
    .spw-req:last-child { border-bottom:0; }
    .spw-req-l { color:#1f2430; }
    .spw-req-o { font-size:10.5px; color:#767488; white-space:nowrap; display:flex; gap:4px; align-items:center; }
    .spw-done { font-size:11.5px; color:#166534; padding:2px 0; }
    .spw-kv { display:grid; grid-template-columns: auto 1fr; gap:3px 10px; font-size:12px; }
    .spw-kv dt { color:#767488; } .spw-kv dd { margin:0; color:#1f2430; }
    .spw-ptab { width:100%; border-collapse:collapse; font-size:11.5px; }
    .spw-ptab th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#767488; font-weight:700; padding:5px 6px; border-bottom:1px solid #f0ece2; white-space:nowrap; }
    .spw-ptab td { padding:6px; border-bottom:1px solid #f6f3ec; vertical-align:top; white-space:nowrap; }
    .spw-ptab tr:last-child td { border-bottom:0; }
    .spw-pst { font-size:10.5px; font-weight:700; padding:2px 7px; border-radius:20px; display:inline-block; }
    .spw-actions { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; }
    .spw-more { display:block; width:100%; padding:9px; border:0; background:#faf8f3; color:#1b2a6b; font:inherit; font-size:12px; font-weight:600; cursor:pointer; border-top:1px solid #f0ece2; }
    .spw-tl { list-style:none; margin:0; padding:0; font-size:12px; }
    .spw-tl li { display:flex; justify-content:space-between; gap:10px; padding:3px 0; }
    .spw-tl span { color:#767488; white-space:nowrap; }
    /* HR Hub staff card: payer enrollment editor */
    .spw-pe-row { border:1px solid #e6e8f0; border-radius:10px; padding:10px; margin-bottom:8px; }
    .spw-pe-head { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
    .spw-pe-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(130px,1fr)); gap:8px; }
    .spw-pe-grid label { font-size:11px; color:#6b7280; display:block; margin-bottom:2px; }
    .spw-pe-grid input, .spw-pe-grid select, .spw-pe-add input, .spw-pe-add select { width:100%; box-sizing:border-box; font:inherit; font-size:12.5px; padding:5px 7px; border:1px solid #d9dce6; border-radius:7px; background:#fff; }
    .spw-pe-add { display:grid; grid-template-columns: 2fr 1.3fr 1.3fr auto; gap:8px; align-items:end; margin-top:6px; }
    @media (max-width: 560px) { .spw-pe-add { grid-template-columns: 1fr 1fr; } }
    .spw-pe-msg { font-size:12px; color:#6b7280; margin-top:4px; min-height:1em; }
    `;
    document.head.appendChild(st);
  }

  const PHASE_TONE = {
    recruitment: { bg: "#f3f4f6", fg: "#4b5563" },
    preboarding: { bg: "#ffedd5", fg: "#9a3412" },
    onboarding: { bg: "#fef9c3", fg: "#854d0e" },
    credentialing: { bg: "#e0e7ff", fg: "#1e3a8a" },
    partial_clearance: { bg: "#dbeafe", fg: "#1d4ed8" },
    active: { bg: "#e9f9ee", fg: "#166534" },
  };
  const PAYER_TONE = {
    not_started: { bg: "#f3f4f6", fg: "#4b5563" },
    submitted: { bg: "#e0e7ff", fg: "#1e3a8a" },
    pending: { bg: "#f3e8ff", fg: "#6b21a8" },
    approved: { bg: "#dbeafe", fg: "#1d4ed8" },
    effective: { bg: "#e9f9ee", fg: "#166534" },
    denied: { bg: "#fee2e2", fg: "#991b1b" },
    not_required: { bg: "#f3f4f6", fg: "#6b7280" },
  };
  function phasePill(p) {
    const t = PHASE_TONE[p.phase] || PHASE_TONE.recruitment;
    return `<span class="spw-chip" style="background:${t.bg}; color:${t.fg};">${esc(p.phase_label)}</span>`;
  }
  function waitTag(w) {
    return w === "external"
      ? `<span class="spw-wait ext" title="Waiting on someone outside Spectrum Squad">External</span>`
      : `<span class="spw-wait int" title="Waiting on someone at Spectrum Squad">Internal</span>`;
  }

  // ======================================================================
  // 1. THE WIDGET
  // ======================================================================
  const W = {
    data: null, loadedAt: 0, loading: null, el: null, surface: "",
    role: "all", phase: "", attention: "", expanded: new Set(), showAll: false,
    timer: null,
  };
  const REFRESH_MS = 3 * 60 * 1000;
  const PAGE = 8;

  async function fetchData(force) {
    if (!force && W.data && Date.now() - W.loadedAt < 60 * 1000) return W.data;
    if (W.loading) return W.loading;
    W.loading = api("/api/staff-progression" + (W.surface ? "?surface=" + encodeURIComponent(W.surface) : ""))
      .then((d) => { W.data = d; W.loadedAt = Date.now(); return d; })
      .catch((e) => { if (e.status === 403 || e.status === 401) { W.data = { visible: false }; W.loadedAt = Date.now(); return W.data; } throw e; })
      .finally(() => { W.loading = null; });
    return W.loading;
  }

  function filtered(d) {
    return d.people.filter((p) =>
      (W.role === "all" || p.role_group === W.role)
      && (!W.phase || p.phase === W.phase)
      && (W.attention !== "delayed" || p.flags.delayed.length)
      && (W.attention !== "soon" || p.flags.approaching));
  }

  function steps(p) {
    // Five steps up to Active; the current one is part-filled by progress
    // within it.
    const n = 5, cur = p.phase_index;
    const per = 100 / n;
    const within = Math.max(0, Math.min(100, Math.round(((p.progress - cur * per) / per) * 100)));
    let s = "";
    for (let i = 0; i < n; i++) {
      if (i < cur) s += `<i class="done"></i>`;
      else if (i === cur) s += `<i class="cur" style="--f:${within}%;"></i>`;
      else s += `<i></i>`;
    }
    return `<span class="spw-steps" aria-hidden="true">${s}</span>`;
  }

  function startCell(p) {
    if (!p.start_date) return `<span class="spw-start">Not set</span><span class="spw-start-s">anticipated start</span>`;
    const n = p.days_to_start;
    const sub = n == null ? "" : n < 0 ? `${-n} day${n === -1 ? "" : "s"} ago` : n === 0 ? "today" : `in ${n} day${n === 1 ? "" : "s"}`;
    const col = n != null && n < 0 ? "#991b1b" : p.flags.approaching ? "#854d0e" : "#767488";
    return `<span class="spw-start">${esc(shortDate(p.start_date))}</span><span class="spw-start-s" style="color:${col};">${esc(sub)}</span>`;
  }

  function rowHtml(p) {
    const cls = p.flags.delayed.length ? " delayed" : p.flags.approaching ? " soon" : "";
    const open = W.expanded.has(p.key);
    const nx = p.next_action;
    const flagTxt = p.flags.delayed.length ? "Delayed" : p.flags.approaching ? "Starting soon" : "";
    return `<button class="spw-row${cls}" data-spw-row="${esc(p.key)}" aria-expanded="${open}"
        aria-label="${esc(p.name)}, ${esc(p.phase_label)}${flagTxt ? ", " + flagTxt : ""}">
      <span><span class="spw-name">${esc(p.name)}</span><span class="spw-pos">${esc(p.position)}</span></span>
      <span class="spw-c-phase">${phasePill(p)}${p.stage_label ? `<span class="spw-pct">${esc(p.stage_label)}</span>` : `<span class="spw-pct">${p.progress}%</span>`}${steps(p)}</span>
      <span class="spw-c-start">${startCell(p)}</span>
      <span class="spw-c-next">${nx
        ? `<span class="spw-next">${esc(nx.label)}</span><span class="spw-who">${waitTag(nx.waiting)} ${esc(nx.owner)}${p.outstanding.length > 1 ? ` <span class="spw-out">+${p.outstanding.length - 1} more</span>` : ""}</span>`
        : `<span class="spw-next" style="color:#166534;">Nothing outstanding</span>`}</span>
      <span class="spw-c-upd spw-upd">${esc(ago(p.last_updated))}</span>
      <span class="spw-chev">${chev()}</span>
    </button>${open ? detailHtml(p) : ""}`;
  }
  function chev() {
    return `<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5l5 5-5 5"/></svg>`;
  }

  function payerTable(payers) {
    if (!payers.length) return `<div style="font-size:12px; color:#767488;">No payer enrollment recorded in the HR Hub yet.</div>`;
    return `<div style="overflow-x:auto;"><table class="spw-ptab">
      <thead><tr><th>Payer</th><th>Type</th><th>Status</th><th>Submitted</th><th>Pending</th><th>Approved</th><th>Effective</th></tr></thead>
      <tbody>${payers.map((x) => {
        const t = PAYER_TONE[x.status] || PAYER_TONE.not_started;
        return `<tr>
          <td style="font-weight:600; color:#1b2a6b;">${esc(x.payer)}</td>
          <td>${esc(x.kind_label)}</td>
          <td><span class="spw-pst" style="background:${t.bg}; color:${t.fg};">${esc(x.status_label)}</span>${x.days_waiting != null ? `<div style="font-size:10.5px; color:${x.slow ? "#991b1b" : "#767488"}; margin-top:2px;">${x.days_waiting} days waiting</div>` : ""}</td>
          <td>${esc(shortDate(x.submitted_date))}</td><td>${esc(shortDate(x.pending_date))}</td>
          <td>${esc(shortDate(x.approved_date))}</td><td>${esc(shortDate(x.effective_date))}</td>
        </tr>`;
      }).join("")}</tbody></table></div>`;
  }

  function detailHtml(p) {
    const d = W.data;
    const flags = [
      ...p.flags.delayed.map((f) => `<div class="spw-flag red">${esc(f)}</div>`),
      ...(p.flags.approaching && !p.flags.delayed.length
        ? [`<div class="spw-flag amber">Starts ${esc(dateLabel(p.start_date))} with ${p.outstanding.length} requirement${p.outstanding.length === 1 ? "" : "s"} still open.</div>`] : []),
    ].join("");
    const outstanding = p.outstanding.length
      ? p.outstanding.map((r) => `<div class="spw-req"><span class="spw-req-l">${esc(r.label)}</span><span class="spw-req-o">${waitTag(r.waiting)} ${esc(r.owner)}</span></div>`).join("")
      : `<div class="spw-done">Nothing outstanding.</div>`;
    const done = p.completed.length
      ? `<details style="margin-top:6px;"><summary style="font-size:11.5px; color:#166534; cursor:pointer;">${p.completed.length} completed</summary>${p.completed.map((r) => `<div class="spw-done">✓ ${esc(r.label)}</div>`).join("")}</details>`
      : "";
    const kv = [
      ["Position", p.position], ["Phase", p.stage_label ? `${p.phase_label} · ${p.stage_label}` : p.phase_label],
      ["Anticipated start", p.start_date ? dateLabel(p.start_date) : "Not set"],
      p.employment_type ? ["Employment", String(p.employment_type).replace(/_/g, " ")] : null,
      p.supervisor ? ["Supervisor", p.supervisor] : null,
      p.location ? ["Location", p.location] : null,
      ["Last updated", p.last_updated ? dateLabel(p.last_updated) : "—"],
    ].filter(Boolean);
    const timeline = p.timeline.length
      ? `<ul class="spw-tl">${p.timeline.map((t) => `<li>${esc(t.label)}<span>${esc(dateLabel(t.date))}</span></li>`).join("")}</ul>`
      : `<div style="font-size:12px; color:#767488;">No dated milestones yet.</div>`;
    const edit = d && d.can_edit
      ? `<div class="spw-actions"><button class="bd-ql" style="cursor:pointer;" data-spw-edit="${esc(p.key)}">${p.source === "employee" ? "Open staff record in HR Hub" : "Open candidate in HR Hub"}</button></div>`
      : "";
    return `<div class="spw-detail" data-spw-detail="${esc(p.key)}">
      ${flags ? `<div class="spw-flags">${flags}</div>` : ""}
      <div class="spw-grid">
        <div class="spw-box"><p class="spw-bt">Outstanding requirements (${p.outstanding.length})</p>${outstanding}${done}</div>
        <div class="spw-box"><p class="spw-bt">Details</p><dl class="spw-kv" style="margin:0;">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
          <p class="spw-bt" style="margin-top:12px;">Timeline</p>${timeline}</div>
      </div>
      ${p.source === "employee" ? `<div class="spw-box" style="margin-top:12px;"><p class="spw-bt">Payer group linking &amp; credentialing</p>${payerTable(p.payers)}</div>` : ""}
      ${edit}
    </div>`;
  }

  function paint() {
    const el = W.el;
    if (!el || !document.body.contains(el)) return;
    const d = W.data;
    if (!d || !d.visible) { el.innerHTML = ""; el.style.display = "none"; return; }
    el.style.display = "";
    const rows = filtered(d);
    const shown = W.showAll ? rows : rows.slice(0, PAGE);
    const rc = (k) => (k === "all" ? d.counts.all : d.counts[k] || 0);
    const roleBtns = [{ key: "all", label: "All" }].concat(d.role_groups)
      .map((g) => `<button class="bd-fb${W.role === g.key ? " on" : ""}" data-spw-role="${g.key}">${esc(g.label)} <span style="opacity:.7;">${rc(g.key)}</span></button>`).join("");
    const attn = [
      { key: "delayed", label: "Delayed", n: d.delayed, on: "#dc2626" },
      { key: "soon", label: `Starting within ${d.thresholds.START_SOON_DAYS} days`, n: d.approaching, on: "#ca8a04" },
    ].map((a) => `<button class="bd-fb${W.attention === a.key ? " on" : ""}" data-spw-attn="${a.key}"
        ${W.attention === a.key ? `style="background:${a.on}; border-color:${a.on};"` : ""}>${esc(a.label)} <span style="opacity:.7;">${a.n}</span></button>`).join("");
    const phases = d.phases.filter((p) => p.key !== "active").map((p) =>
      `<button class="spw-ph${W.phase === p.key ? " on" : ""}" data-spw-phase="${p.key}">
        <div class="spw-ph-n">${d.by_phase[p.key] || 0}</div><div class="spw-ph-l">${esc(p.label)}</div></button>`).join("");

    el.innerHTML = `<div class="bd-panel" id="spw-panel">
      <div class="bd-ph">
        <div><h2 class="bd-pt">${peopleIcon()} Incoming Staff Progression</h2>
          <p class="bd-pn">Live from the HR Hub. Read-only here — changes made in the HR Hub show up automatically.</p></div>
        <div class="spw-sum">
          <span class="spw-chip" style="background:#eef0fb; color:#1b2a6b;">${d.counts.all} incoming</span>
          ${d.delayed ? `<span class="spw-chip" style="background:#fee2e2; color:#991b1b;">${d.delayed} delayed</span>` : ""}
          ${d.approaching ? `<span class="spw-chip" style="background:#fef9c3; color:#854d0e;">${d.approaching} starting soon</span>` : ""}
        </div>
      </div>
      <div class="spw-phases" role="group" aria-label="Filter by phase">${phases}</div>
      <div class="spw-tools">
        <div class="bd-filters" role="group" aria-label="Filter by role">${roleBtns}</div>
        <div class="bd-filters" role="group" aria-label="Filter by attention">${attn}</div>
      </div>
      ${rows.length ? `<div class="spw-hdr"><span>Employee</span><span>Phase &amp; progress</span><span>Start</span><span>Next action</span><span>Updated</span><span></span></div>
        <div class="spw-list">${shown.map(rowHtml).join("")}</div>
        ${rows.length > PAGE ? `<button class="spw-more" data-spw-more="1">${W.showAll ? "Show fewer" : `Show all ${rows.length}`}</button>` : ""}`
        : `<div class="bd-empty">${d.counts.all ? "Nobody matches these filters." : "No incoming clinical staff right now. Anyone hired, onboarding or still clearing payers will appear here."}</div>`}
    </div>`;
    wireWidget(el);
  }
  function peopleIcon() {
    return `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="2.5"/><circle cx="13.5" cy="8" r="2"/><path d="M3 16c0-2.2 1.8-4 4-4s4 1.8 4 4"/><path d="M12 16c0-1.7 1.1-3 2.5-3S17 14.3 17 16"/></svg>`;
  }

  function wireWidget(el) {
    el.querySelectorAll("[data-spw-role]").forEach((b) => b.addEventListener("click", () => { W.role = b.dataset.spwRole; W.showAll = false; paint(); }));
    el.querySelectorAll("[data-spw-phase]").forEach((b) => b.addEventListener("click", () => {
      W.phase = W.phase === b.dataset.spwPhase ? "" : b.dataset.spwPhase; W.showAll = false; paint();
    }));
    el.querySelectorAll("[data-spw-attn]").forEach((b) => b.addEventListener("click", () => {
      W.attention = W.attention === b.dataset.spwAttn ? "" : b.dataset.spwAttn; W.showAll = false; paint();
    }));
    el.querySelectorAll("[data-spw-row]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.spwRow;
      if (W.expanded.has(k)) W.expanded.delete(k); else W.expanded.add(k);
      paint();
    }));
    const more = el.querySelector("[data-spw-more]");
    if (more) more.addEventListener("click", () => { W.showAll = !W.showAll; paint(); });
    el.querySelectorAll("[data-spw-edit]").forEach((b) => b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const k = b.dataset.spwEdit;
      const [kind, id] = k.split("-");
      if (kind === "app") { location.hash = "#/hr/candidate/" + id; return; }
      if (typeof openStaffModal === "function") {
        // The staff card re-draws the staff list on save; it is given a
        // throwaway mount so it does not draw over the dashboard. When the
        // card closes, the widget re-reads the HR Hub.
        const scratch = document.createElement("div");
        openStaffModal(id, scratch);
        const watch = new MutationObserver(() => {
          if (!document.querySelector(".modal-backdrop")) { watch.disconnect(); refresh(true); }
        });
        watch.observe(document.body, { childList: true });
      } else location.hash = "#/staff";
    }));
  }

  async function refresh(force) {
    try { await fetchData(force); } catch (e) {
      if (W.el && !W.data) W.el.innerHTML = `<div class="bd-panel"><div class="bd-empty">Couldn't load staff progression: ${esc(e.message)}</div></div>`;
      return;
    }
    paint();
  }

  window.__fillStaffProgression = function (el, surface) {
    if (!el) return;
    injectStyles();
    // A different surface is a different answer from the server (see
    // isDesignatedLead), so the cache does not carry across.
    if ((surface || "") !== W.surface) { W.surface = surface || ""; W.data = null; W.loadedAt = 0; }
    W.el = el;
    // Paint what we have straight away (the dashboard re-renders on every
    // caseload filter click), then make sure it is current.
    if (W.data) paint();
    refresh(false);
    if (!W.timer) {
      W.timer = setInterval(() => { if (W.el && document.body.contains(W.el) && !document.hidden) refresh(true); }, REFRESH_MS);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && W.el && document.body.contains(W.el)) refresh(true);
      });
    }
  };

  // ======================================================================
  // 2. HR HUB STAFF CARD: payer enrollment
  // ======================================================================
  const DATE_FOR_STATUS = { submitted: "submitted_date", pending: "pending_date", approved: "approved_date", effective: "effective_date" };

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
          <div style="font-size:12px; color:#6b7280;">Submitted ${esc(shortDate(r.submitted_date))} · Pending ${esc(shortDate(r.pending_date))} · Approved ${esc(shortDate(r.approved_date))} · Effective ${esc(shortDate(r.effective_date))}</div></div>`;
      }
      const dateIn = (f, label) => `<div><label>${label}</label><input type="date" data-pe="${f}" value="${esc(r[f] || "")}" /></div>`;
      return `<div class="spw-pe-row" data-pe-row="${r.id}">
        <div class="spw-pe-head"><strong>${esc(r.payer)} · ${esc(r.kind_label)}</strong>
          <span class="spw-pst" style="background:${t.bg}; color:${t.fg};">${esc(r.status_label)}${r.days_waiting != null ? ` · ${r.days_waiting}d` : ""}</span></div>
        <div class="spw-pe-grid">
          <div><label>Status</label><select data-pe="status">${opts(d.statuses, r.stored_status)}</select></div>
          ${dateIn("submitted_date", "Submitted")}${dateIn("pending_date", "Pending since")}
          ${dateIn("approved_date", "Approved")}${dateIn("effective_date", "Effective")}
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
      <div style="font-size:12px; color:var(--text-muted, #6b7280); margin-bottom:8px;">Group linking and individual credentialing with each payer. The Clinical Director's dashboard reads this — it is not kept anywhere else.</div>
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
    // Moving to a status puts today's date in that status's box if it is
    // empty -- visibly, so HR can correct it before saving. Nothing is dated
    // behind anybody's back.
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
      try { await api("/api/payer-enrollments/" + id, { method: "PATCH", body }); W.loadedAt = 0; await window.__renderPayerEnrollments(el, employeeId); }
      catch (e) { b.disabled = false; msg(id, e.message, true); }
    }));
    el.querySelectorAll("[data-pe-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Remove this payer enrollment from the record? The removal is noted in the activity log.")) return;
      b.disabled = true;
      try { await api("/api/payer-enrollments/" + b.dataset.peDel, { method: "DELETE" }); W.loadedAt = 0; await window.__renderPayerEnrollments(el, employeeId); }
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
      try { await api("/api/payer-enrollments", { method: "POST", body }); W.loadedAt = 0; await window.__renderPayerEnrollments(el, employeeId); }
      catch (e) { add.disabled = false; msg("new", e.message, true); }
    });
  };
})();
