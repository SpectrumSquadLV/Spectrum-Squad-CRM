// scheduling-frontend.js -- the Scheduling Center.
//
// Built to the Spectrum Squad dashboard design: soft pastel status colours,
// rounded cards, a staff-by-day week grid, a right rail of things that need
// attention, and a squad strip along the bottom.
//
// Everything on screen comes from the real API in scheduling.js and
// authorizations.js. Where a number is not knowable yet it says so rather than
// showing a zero -- a clinic reading "0 authorized hours" would act on it.
//
// Status is never communicated by colour alone. Every session card carries a
// dot, a shape and a word, so the calendar still reads correctly in greyscale
// and to anyone who cannot separate the pastels.
(function () {
  "use strict";

  const esc = (s) => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  const clean = (v) => (v == null ? "" : String(v).trim());

  async function call(path, opts) {
    if (typeof window.api === "function") return window.api(path, opts);
    const res = await fetch(path, {
      method: (opts && opts.method) || "GET",
      headers: { "Content-Type": "application/json" },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.payload = data; throw e; }
    return data;
  }

  // ---------- time helpers ----------
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? +m[1] * 60 + +m[2] : null; };
  const pad = (n) => String(n).padStart(2, "0");
  const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const fmtTime = (t) => {
    const v = toMin(t); if (v == null) return String(t || "");
    const h = Math.floor(v / 60), m = v % 60, ap = h >= 12 ? "PM" : "AM", h12 = h % 12 === 0 ? 12 : h % 12;
    return m ? `${h12}:${pad(m)} ${ap}` : `${h12} ${ap}`;
  };
  const iso = (d) => d.toISOString().slice(0, 10);
  const parseDate = (s) => new Date(String(s).slice(0, 10) + "T00:00:00Z");
  const addDays = (s, n) => { const d = parseDate(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const dow = (s) => parseDate(s).getUTCDay();
  const todayIso = () => iso(new Date());
  const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const fmtDay = (s) => `${DAY_SHORT[dow(s)]} ${parseDate(s).getUTCDate()}`;
  const fmtRange = (a, b) => {
    const A = parseDate(a), B = parseDate(b);
    const sameMonth = A.getUTCMonth() === B.getUTCMonth();
    return sameMonth
      ? `${MONTHS[A.getUTCMonth()]} ${A.getUTCDate()} – ${B.getUTCDate()}, ${A.getUTCFullYear()}`
      : `${MONTHS[A.getUTCMonth()]} ${A.getUTCDate()} – ${MONTHS[B.getUTCMonth()]} ${B.getUTCDate()}, ${B.getUTCFullYear()}`;
  };
  const weekStartOf = (d) => addDays(d, -dow(d));

  // ---------- status vocabulary ----------
  // Colour is the last signal, never the only one: each entry carries a glyph
  // and a word too.
  const STATUS = {
    scheduled:      { label: "Scheduled",     bg: "#e9f7ef", fg: "#166534", dot: "#22a565", glyph: "●" },
    checked_in:     { label: "Checked in",    bg: "#e0f2fe", fg: "#075985", dot: "#0284c7", glyph: "◐" },
    in_progress:    { label: "In progress",   bg: "#e0f2fe", fg: "#075985", dot: "#0284c7", glyph: "◐" },
    completed:      { label: "Completed",     bg: "#eef2f7", fg: "#334155", dot: "#64748b", glyph: "✓" },
    cancelled:      { label: "Cancelled",     bg: "#f4f4f5", fg: "#6b7280", dot: "#9ca3af", glyph: "—" },
    no_show:        { label: "No show",       bg: "#fdeaea", fg: "#991b1b", dot: "#dc2626", glyph: "✗" },
    staff_call_out: { label: "Call out",      bg: "#fdeaea", fg: "#991b1b", dot: "#dc2626", glyph: "✗" },
    needs_coverage: { label: "Needs coverage",bg: "#fde8ef", fg: "#9d174d", dot: "#db2777", glyph: "⚠" },
  };
  const NOTE_BADGE = {
    required:  { label: "Note missing", bg: "#fef3c7", fg: "#92400e" },
    draft:     { label: "Note draft",   bg: "#fef3c7", fg: "#92400e" },
    completed: { label: "Note done",    bg: "#e9f7ef", fg: "#166534" },
    verified:  { label: "Verified",     bg: "#e9f7ef", fg: "#166534" },
  };

  const ICON = {
    plus: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    spark: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/></svg>',
    tune: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="10" cy="8" r="2.2" fill="currentColor" stroke="none"/><circle cx="15" cy="16" r="2.2" fill="currentColor" stroke="none"/></svg>',
    chevL: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    chevR: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    alert: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
    people: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>',
  };

  // ---------- styles ----------
  const STYLE_ID = "sched-center-style";
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
.sc-wrap { --sc-radius:16px; --sc-line:#e8eaf0; font-size:13.5px; }
.sc-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:16px; }
.sc-title { font-size:22px; font-weight:750; letter-spacing:-.01em; margin:0; display:flex; align-items:center; gap:9px; }
.sc-sub { color:var(--text-muted,#6b7280); font-size:13px; margin-top:4px; display:flex; gap:18px; flex-wrap:wrap; }
.sc-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.sc-btn { display:inline-flex; align-items:center; gap:7px; border-radius:11px; border:1px solid var(--sc-line); background:#fff;
  padding:9px 14px; font-size:13px; font-weight:600; color:#2b3040; cursor:pointer; transition:transform .12s ease, box-shadow .12s ease, background .12s ease; }
.sc-btn:hover { transform:translateY(-1px); box-shadow:0 4px 14px rgba(30,35,60,.09); }
.sc-btn:active { transform:translateY(0); }
.sc-btn.primary { background:linear-gradient(135deg,#7c5cf0,#6d4ae6); border-color:transparent; color:#fff; box-shadow:0 4px 14px rgba(109,74,230,.28); }
.sc-btn.icon { padding:9px 11px; }

.sc-metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:16px; }
.sc-metric { border-radius:var(--sc-radius); padding:14px 16px; border:1px solid transparent; cursor:pointer;
  transition:transform .14s ease, box-shadow .14s ease; position:relative; text-align:left; width:100%; font:inherit; }
.sc-metric:hover { transform:translateY(-2px); box-shadow:0 8px 22px rgba(30,35,60,.10); }
.sc-metric[aria-pressed="true"] { outline:2px solid #6d4ae6; outline-offset:1px; }
.sc-metric .k { font-size:12.5px; font-weight:600; color:#4b5563; }
.sc-metric .v { font-size:28px; font-weight:780; letter-spacing:-.02em; line-height:1.15; margin-top:2px; }
.sc-metric .c { font-size:12px; color:#6b7280; }
.sc-metric .badge { position:absolute; top:13px; right:13px; width:30px; height:30px; border-radius:10px;
  display:flex; align-items:center; justify-content:center; }

.sc-body { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:14px; align-items:start; }
@media (max-width:1200px){ .sc-body { grid-template-columns:minmax(0,1fr); } }

.sc-card { background:var(--card-bg,#fff); border:1px solid var(--sc-line); border-radius:var(--sc-radius); }
.sc-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:12px 14px; border-bottom:1px solid var(--sc-line); }
.sc-seg { display:inline-flex; background:#f3f4f8; border-radius:11px; padding:3px; gap:2px; }
.sc-seg button { border:0; background:transparent; border-radius:9px; padding:7px 15px; font-size:12.5px; font-weight:650;
  color:#5b6070; cursor:pointer; transition:background .14s ease, color .14s ease; }
.sc-seg button[aria-pressed="true"] { background:#6d4ae6; color:#fff; box-shadow:0 2px 8px rgba(109,74,230,.30); }
.sc-range { font-size:15px; font-weight:700; margin:0 4px; }

.sc-grid { overflow:auto; }
.sc-grid table { border-collapse:separate; border-spacing:0; width:100%; min-width:860px; table-layout:fixed; }
.sc-grid thead th:not(.sc-staffcell) { width:calc((100% - 150px)/7); }
.sc-grid th, .sc-grid td { vertical-align:top; }
.sc-grid thead th { position:sticky; top:0; background:var(--card-bg,#fff); z-index:3; padding:12px 8px; font-size:12.5px;
  font-weight:680; color:#3d4354; border-bottom:1px solid var(--sc-line); text-align:center; }
.sc-grid thead th.today { color:#6d4ae6; }
.sc-grid tbody td { border-bottom:1px solid #f1f2f6; padding:7px 6px; }
.sc-staffcell { position:sticky; left:0; background:var(--card-bg,#fff); z-index:2; width:150px; min-width:150px;
  border-right:1px solid var(--sc-line); }
.sc-staff { display:flex; align-items:center; gap:9px; padding:4px 2px; }
.sc-av { width:32px; height:32px; border-radius:50%; background:#eceafd; color:#4c34b5; font-size:11.5px; font-weight:750;
  display:flex; align-items:center; justify-content:center; flex:0 0 auto; }
.sc-staff .n { font-weight:670; font-size:13px; line-height:1.2; }
.sc-staff .r { font-size:11.5px; color:#6b7280; }

.sc-sess { border-radius:12px; padding:8px 10px; margin-bottom:6px; cursor:grab; border:1px solid transparent;
  transition:transform .12s ease, box-shadow .12s ease; }
.sc-sess:hover { transform:translateY(-1px); box-shadow:0 5px 16px rgba(30,35,60,.12); }
.sc-sess:active { cursor:grabbing; }
.sc-sess .t { font-size:12.5px; font-weight:700; display:flex; align-items:center; gap:6px; }
.sc-sess .m { font-size:11px; opacity:.85; margin-top:2px; }
.sc-sess .t { overflow-wrap:anywhere; }
.sc-sess .b { font-size:10.5px; font-weight:700; border-radius:6px; padding:1px 6px; display:inline-block; margin-top:5px; }
.sc-drop { outline:2px dashed #6d4ae6; outline-offset:-3px; background:#f6f3ff; border-radius:12px; }
.sc-open { border:1px dashed #b9c0d4; border-radius:11px; padding:8px 10px; font-size:12px; color:#6b7280;
  text-align:center; cursor:pointer; transition:background .12s ease, border-color .12s ease; }
.sc-open:hover { background:#f6f3ff; border-color:#6d4ae6; color:#4c34b5; }
.sc-off { text-align:center; color:#9aa0ae; font-size:12px; padding:10px 0; }

.sc-rail { display:flex; flex-direction:column; gap:14px; }
.sc-panel { background:var(--card-bg,#fff); border:1px solid var(--sc-line); border-radius:var(--sc-radius); padding:14px; }
.sc-panel h3 { margin:0 0 10px; font-size:13.5px; font-weight:730; display:flex; align-items:center; gap:7px; justify-content:space-between; }
.sc-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 11px; border-radius:12px;
  background:#fafbfd; border:1px solid #f0f1f5; margin-bottom:7px; cursor:pointer; transition:transform .12s ease, box-shadow .12s ease; }
.sc-row:hover { transform:translateX(2px); box-shadow:0 3px 12px rgba(30,35,60,.08); }
.sc-row .l { font-size:12.8px; font-weight:660; }
.sc-row .s { font-size:11.5px; color:#6b7280; margin-top:1px; }
.sc-pill { border-radius:999px; padding:3px 10px; font-size:11.5px; font-weight:700; white-space:nowrap; }

.sc-strip { display:grid; grid-template-columns:repeat(auto-fit,minmax(92px,1fr)); gap:10px; }
.sc-stat { border-radius:13px; padding:10px 12px; background:#fafbfd; border:1px solid #f0f1f5; text-align:center; }
.sc-stat .v { font-size:19px; font-weight:760; }
.sc-stat .k { font-size:11px; color:#6b7280; }
.sc-bar { height:8px; border-radius:999px; background:#eef0f5; overflow:hidden; margin-top:4px; }
.sc-bar > i { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,#7c5cf0,#22a565); transition:width .5s ease; }

.sc-empty { text-align:center; padding:22px 14px; color:#6b7280; font-size:13px; }
.sc-empty .big { font-size:15px; font-weight:700; color:#334155; margin-bottom:3px; }
.sc-skel { background:linear-gradient(90deg,#f2f3f7 25%,#e9ebf1 37%,#f2f3f7 63%); background-size:400% 100%;
  animation:scShimmer 1.3s ease infinite; border-radius:12px; }
@keyframes scShimmer { 0%{background-position:100% 50%} 100%{background-position:0 50%} }
@media (prefers-reduced-motion: reduce){ .sc-wrap * { transition:none !important; animation:none !important; } }
`;
    document.head.appendChild(s);
  }

  // ---------- state ----------
  const S = {
    view: "week",           // day | week | month
    lens: "staff",          // staff | client | location
    anchor: todayIso(),
    filterStatus: null,
    boot: null,
    sessions: [],
    board: null,
    authOverview: null,
    mount: null,
  };

  const initials = (n) => clean(n).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  // Asking for a photo that isn't there would 404 on every card, so the flag
  // comes from the staff list rather than being assumed.
  const staffHasPhoto = (id) => {
    const e = ((S.boot && S.boot.staff) || []).find((x) => String(x.id) === String(id));
    return !!(e && e.has_photo);
  };

  function rangeFor() {
    if (S.view === "day") return { from: S.anchor, to: S.anchor };
    if (S.view === "month") {
      const d = parseDate(S.anchor);
      const first = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
      const last = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
      return { from: weekStartOf(first), to: addDays(weekStartOf(last), 6) };
    }
    const ws = weekStartOf(S.anchor);
    return { from: ws, to: addDays(ws, 6) };
  }

  function step(dir) {
    if (S.view === "day") S.anchor = addDays(S.anchor, dir);
    else if (S.view === "month") {
      const d = parseDate(S.anchor);
      S.anchor = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1)));
    } else S.anchor = addDays(S.anchor, dir * 7);
    render();
  }

  // ---------- data ----------
  async function load() {
    const r = rangeFor();
    const jobs = [
      call(`/api/sched/sessions?from=${r.from}&to=${r.to}`).then((d) => { S.sessions = d.sessions || []; S.scopedToMe = d.scoped_to_me; }),
    ];
    if (!S.boot) jobs.push(call("/api/sched/bootstrap").then((d) => { S.boot = d; }));
    jobs.push(call(`/api/sched/day-board?date=${todayIso()}`).then((d) => { S.board = d; }).catch(() => { S.board = null; }));
    jobs.push(call("/api/auth-util/overview").then((d) => { S.authOverview = d; }).catch(() => { S.authOverview = null; }));
    await Promise.all(jobs);
  }

  // ---------- session card ----------
  function sessionCard(s) {
    const st = STATUS[s.status] || STATUS.scheduled;
    const note = s.status === "completed" ? NOTE_BADGE[s.note_status] : null;
    const who = s.status === "needs_coverage" ? "Coverage needed" : s.client_display;
    return `<div class="sc-sess" draggable="true" data-session="${s.id}"
        style="background:${st.bg}; color:${st.fg};"
        title="${esc(s.client_display)} with ${esc(s.staff_display)} · ${esc(s.start_label)}–${esc(s.end_label)} · ${esc(st.label)}">
      <div class="t"><span aria-hidden="true" style="color:${st.dot};">${st.glyph}</span>${esc(who)}${(s.transportation_services === true || s.transportation_services === "t") ? ` <span title="Transportation provided — coordinate a ride" aria-label="Transportation provided">🚐</span>` : ""}</div>
      <div class="m">${esc(s.start_label)} – ${esc(s.end_label)}${s.location_name ? " · " + esc(s.location_name) : ""}</div>
      ${s.status !== "scheduled" ? `<span class="b" style="background:rgba(255,255,255,.65);">${esc(st.label)}</span>` : ""}
      ${note ? `<span class="b" style="background:${note.bg}; color:${note.fg}; margin-left:4px;">${esc(note.label)}</span>` : ""}
    </div>`;
  }

  function visibleSessions() {
    if (!S.filterStatus) return S.sessions;
    if (S.filterStatus === "notes") return S.sessions.filter((s) => s.status === "completed" && ["required", "draft"].includes(s.note_status));
    if (S.filterStatus === "unassigned") return S.sessions.filter((s) => !s.staff_id || s.status === "needs_coverage");
    return S.sessions.filter((s) => s.status === S.filterStatus);
  }

  // ---------- week / day grid ----------
  function gridRows() {
    const list = visibleSessions();
    if (S.lens === "client") {
      const byId = new Map();
      for (const s of list) if (!byId.has(s.client_id)) byId.set(s.client_id, { id: s.client_id, name: s.client_display, role: "Client" });
      return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    if (S.lens === "location") {
      const byId = new Map();
      for (const s of list) {
        const k = s.location_id || 0;
        if (!byId.has(k)) byId.set(k, { id: k, name: s.location_name || "No location set", role: "Location" });
      }
      return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    const staff = (S.boot && S.boot.staff) || [];
    const rows = staff.map((e) => ({ id: e.id, name: e.name, role: e.role_title || "Staff", photo: !!e.has_photo, employee_id: e.id }));
    // Anything unassigned needs a home on the board, or coverage gaps vanish.
    if (list.some((s) => !s.staff_id)) rows.push({ id: 0, name: "Unassigned", role: "Needs coverage" });
    return rows;
  }

  const rowKeyOf = (s) => (S.lens === "client" ? s.client_id : S.lens === "location" ? (s.location_id || 0) : (s.staff_id || 0));

  function renderGrid() {
    const r = rangeFor();
    const days = S.view === "day" ? [S.anchor] : Array.from({ length: 7 }, (_, i) => addDays(r.from, i));
    const rows = gridRows();
    const list = visibleSessions();

    if (!rows.length) {
      return `<div class="sc-empty"><div class="big">Nothing scheduled ${S.view === "day" ? "today" : "this week"}</div>
        Add a session, or jump to a week that has some.</div>`;
    }

    const head = `<thead><tr>
      <th class="sc-staffcell" style="text-align:left;">${S.lens === "staff" ? "Staff" : S.lens === "client" ? "Client" : "Location"}</th>
      ${days.map((d) => `<th class="${d === todayIso() ? "today" : ""}">${esc(fmtDay(d))}${d === todayIso() ? " &middot; today" : ""}</th>`).join("")}
    </tr></thead>`;

    const body = rows.map((row) => {
      const cells = days.map((d) => {
        const here = list.filter((s) => s.session_date === d && rowKeyOf(s) === row.id)
          .sort((a, b) => toMin(a.start_time) - toMin(b.start_time));
        const inner = here.length
          ? here.map(sessionCard).join("")
          : `<div class="sc-open" data-add-row="${row.id}" data-add-date="${d}" role="button" tabindex="0">Open</div>`;
        return `<td data-drop-row="${row.id}" data-drop-date="${d}">${inner}</td>`;
      }).join("");
      // Only the staff lens shows a face; a client or location row has none.
      const av = (S.lens === "staff" && window.StaffAvatar && row.employee_id)
        ? window.StaffAvatar.html(row.employee_id, row.name, { size: 32, hasPhoto: row.photo })
        : `<span class="sc-av">${esc(initials(row.name))}</span>`;
      return `<tr>
        <td class="sc-staffcell"><div class="sc-staff">${av}
          <span><span class="n">${esc(row.name)}</span><div class="r">${esc(row.role)}</div></span></div></td>
        ${cells}
      </tr>`;
    }).join("");

    return `<div class="sc-grid"><table>${head}<tbody>${body}</tbody></table></div>`;
  }

  function renderMonth() {
    const r = rangeFor();
    const anchor = parseDate(S.anchor);
    const weeks = [];
    for (let d = r.from; d <= r.to; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
    const list = visibleSessions();
    return `<div style="padding:12px 14px;">
      <div style="display:grid; grid-template-columns:repeat(7,1fr); gap:8px; margin-bottom:6px;">
        ${DAY_SHORT.map((d) => `<div style="text-align:center; font-size:11.5px; font-weight:680; color:#6b7280;">${d}</div>`).join("")}
      </div>
      ${weeks.map((w) => `<div style="display:grid; grid-template-columns:repeat(7,1fr); gap:8px; margin-bottom:8px;">
        ${w.map((d) => {
          const here = list.filter((s) => s.session_date === d).sort((a, b) => toMin(a.start_time) - toMin(b.start_time));
          const other = parseDate(d).getUTCMonth() !== anchor.getUTCMonth();
          return `<div class="sc-card" style="min-height:104px; padding:7px 8px; ${other ? "opacity:.45;" : ""} ${d === todayIso() ? "border-color:#6d4ae6;" : ""}">
            <div style="font-size:11.5px; font-weight:700; color:${d === todayIso() ? "#6d4ae6" : "#3d4354"}; margin-bottom:4px;">${parseDate(d).getUTCDate()}</div>
            ${here.slice(0, 3).map((s) => {
              const st = STATUS[s.status] || STATUS.scheduled;
              return `<div class="sc-sess" data-session="${s.id}" style="background:${st.bg}; color:${st.fg}; padding:4px 7px; margin-bottom:4px;">
                <div class="t" style="font-size:11px;"><span aria-hidden="true" style="color:${st.dot};">${st.glyph}</span>${esc(s.client_display)}</div>
                <div class="m" style="font-size:10.5px;">${esc(s.start_label)} · ${esc(s.staff_display)}</div></div>`;
            }).join("")}
            ${here.length > 3 ? `<div style="font-size:10.5px; color:#6b7280; padding-left:3px;">+${here.length - 3} more</div>` : ""}
          </div>`;
        }).join("")}
      </div>`).join("")}
    </div>`;
  }

  // ---------- rail ----------
  function railNeedingHours() {
    const ov = S.authOverview;
    if (!ov) {
      return `<div class="sc-panel"><h3>Clients Needing Hours</h3>
        <div class="sc-empty">No authorization data yet. Import your Rethink Authorization Utilization export and this fills in.</div></div>`;
    }
    const rows = (ov.clients || []).filter((c) => c.unscheduled > 0).slice(0, 6);
    return `<div class="sc-panel">
      <h3><span style="display:flex; align-items:center; gap:7px;">${ICON.people}Clients Needing Hours</span>
        <span style="font-size:11.5px; font-weight:600; color:#6d4ae6;">${ov.clients ? ov.clients.length : 0} total</span></h3>
      ${rows.length ? rows.map((c) => `<div class="sc-row" data-client-hours="${c.client_id || ""}">
          <div><div class="l">${esc(c.name)}</div>
            <div class="s">${c.authorized} authorized &middot; ${c.scheduled} scheduled</div></div>
          <span class="sc-pill" style="background:#fde8ef; color:#9d174d;">${c.unscheduled} hrs</span>
        </div>`).join("")
        : `<div class="sc-empty"><div class="big">Every authorized hour is scheduled</div>Nothing going unused right now.</div>`}
      ${ov.unmatched_clients ? `<div style="font-size:11.5px; color:#92400e; margin-top:6px;">${ov.unmatched_clients} imported client${ov.unmatched_clients === 1 ? "" : "s"} not yet linked to a CRM record.</div>` : ""}
    </div>`;
  }

  function railToday() {
    const b = S.board;
    if (!b) return "";
    const m = b.metrics;
    const line = (label, value, key, tone) => `<div class="sc-row" data-filter="${key || ""}">
      <div class="l">${esc(label)}</div>
      <span class="sc-pill" style="background:${tone ? tone[0] : "#eef2f7"}; color:${tone ? tone[1] : "#334155"};">${value}</span></div>`;
    return `<div class="sc-panel">
      <h3><span style="display:flex; align-items:center; gap:7px;">${ICON.clock}Today's Overview</span></h3>
      ${line("Sessions today", m.sessions_today, "")}
      ${line("In progress", m.in_progress, "in_progress", ["#e0f2fe", "#075985"])}
      ${line("Completed", m.completed, "completed")}
      ${m.notes_missing ? line("Notes missing", m.notes_missing, "notes", ["#fef3c7", "#92400e"]) : ""}
      ${m.needs_coverage ? line("Coverage needed", m.needs_coverage, "unassigned", ["#fde8ef", "#9d174d"]) : ""}
      ${m.cancellations ? line("Cancellations", m.cancellations, "cancelled") : ""}
      ${!m.sessions_today ? `<div class="sc-empty">Nothing on the calendar today.</div>` : ""}
    </div>`;
  }

  // ---------- metrics ----------
  function metrics() {
    const list = S.sessions;
    const ov = S.authOverview;
    const needsCoverage = list.filter((s) => s.status === "needs_coverage" || !s.staff_id).length;
    const notesMissing = list.filter((s) => s.status === "completed" && ["required", "draft"].includes(s.note_status)).length;
    const missingHours = ov ? Math.round((ov.totals.unscheduled || 0)) : null;
    const clientsShort = ov ? (ov.clients || []).filter((c) => c.unscheduled > 0).length : null;
    const clientsFull = ov ? (ov.clients || []).length - (clientsShort || 0) : null;

    // Schedule Health is only shown when it can be computed from real data.
    // A percentage invented from an empty calendar is worse than no number.
    let health = null;
    if (ov && ov.totals && ov.totals.authorized > 0) {
      const utilisation = Math.min(1, (ov.totals.scheduled || 0) / ov.totals.authorized);
      const coveragePenalty = list.length ? needsCoverage / list.length : 0;
      const notePenalty = list.length ? notesMissing / list.length : 0;
      health = Math.max(0, Math.round((utilisation * 0.6 + (1 - coveragePenalty) * 0.25 + (1 - notePenalty) * 0.15) * 100));
    }

    const card = (key, label, value, caption, bg, badgeBg, badgeFg, icon, filter) => `
      <button class="sc-metric" style="background:${bg};" data-metric="${filter || ""}" aria-pressed="${S.filterStatus === filter && !!filter}">
        <div class="k">${esc(label)}</div>
        <div class="v">${value}</div>
        <div class="c">${esc(caption)}</div>
        <span class="badge" style="background:${badgeBg}; color:${badgeFg};">${icon}</span>
      </button>`;

    return `<div class="sc-metrics">
      ${card("health", "Schedule Health", health == null ? "&mdash;" : health + "%",
        health == null ? "Needs authorization data" : health >= 90 ? "Looking good" : health >= 70 ? "Some gaps" : "Needs attention",
        "#efeafe", "#ded4fb", "#4c34b5", ICON.spark, "")}
      ${card("full", "Clients", clientsFull == null ? "&mdash;" : clientsFull, "Fully scheduled", "#e9f7ef", "#cdeeda", "#166534", ICON.check, "")}
      ${card("missing", "Missing Hours", missingHours == null ? "&mdash;" : missingHours,
        clientsShort == null ? "No data yet" : `For ${clientsShort} client${clientsShort === 1 ? "" : "s"}`,
        "#fdeef0", "#fbd8dd", "#9d174d", ICON.alert, "")}
      ${card("cover", "Coverage Needed", needsCoverage, needsCoverage === 1 ? "Session" : "Sessions", "#eaf4fe", "#d3e8fc", "#075985", ICON.people, "unassigned")}
      ${card("notes", "Notes Missing", notesMissing, "From completed sessions", "#fff7e6", "#fde8bd", "#92400e", ICON.clock, "notes")}
      ${card("auth", "Authorization Alerts", ov ? (ov.expiring_30 + Number(ov.expired || 0)) : "&mdash;",
        ov ? `${ov.expiring_30} expiring, ${ov.expired} expired` : "No data yet", "#fff3e6", "#fde3c4", "#9a3412", ICON.alert, "")}
    </div>`;
  }

  // ---------- render ----------
  function render() {
    const mount = S.mount;
    if (!mount) return;
    const r = rangeFor();
    const me = (S.boot && S.boot.me) || {};
    const canAdd = me.can_schedule;

    mount.innerHTML = `<div class="sc-wrap">
      <div class="sc-head">
        <div>
          <h1 class="sc-title">Scheduling Center</h1>
          <div class="sc-sub">
            <span>${S.scopedToMe ? "Showing your own sessions" : "Showing the whole clinic"}</span>
            ${S.boot && S.boot.staff ? `<span>${S.boot.staff.length} staff</span>` : ""}
            ${S.boot && S.boot.clients ? `<span>${S.boot.clients.length} clients</span>` : ""}
          </div>
        </div>
        <div class="sc-actions">
          ${canAdd ? `<button class="sc-btn primary" data-add>${ICON.plus}Add Session</button>` : ""}
          <button class="sc-btn" data-refresh>Refresh</button>
        </div>
      </div>

      ${metrics()}

      <div class="sc-body">
        <div>
          <div class="sc-card">
            <div class="sc-toolbar">
              <button class="sc-btn icon" data-step="-1" aria-label="Previous">${ICON.chevL}</button>
              <button class="sc-btn icon" data-step="1" aria-label="Next">${ICON.chevR}</button>
              <button class="sc-btn" data-today>Today</button>
              <div class="sc-seg">
                ${["day", "week", "month"].map((v) => `<button data-view="${v}" aria-pressed="${S.view === v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}
              </div>
              <span class="sc-range">${S.view === "day" ? esc(`${DAY_SHORT[dow(S.anchor)]}, ${MONTHS[parseDate(S.anchor).getUTCMonth()]} ${parseDate(S.anchor).getUTCDate()}`) : esc(fmtRange(r.from, r.to))}</span>
              <div style="flex:1;"></div>
              <div class="sc-seg">
                ${[["staff", "Staff View"], ["client", "Client View"], ["location", "Location View"]]
                  .map(([k, l]) => `<button data-lens="${k}" aria-pressed="${S.lens === k}">${l}</button>`).join("")}
              </div>
            </div>
            ${S.filterStatus ? `<div style="padding:8px 14px; font-size:12.5px; background:#f6f3ff; border-bottom:1px solid var(--sc-line);">
              Filtered to <strong>${esc(S.filterStatus === "notes" ? "sessions missing a note" : S.filterStatus === "unassigned" ? "sessions needing coverage" : (STATUS[S.filterStatus] || {}).label || S.filterStatus)}</strong>
              &middot; <a href="#" data-clear-filter style="color:#6d4ae6;">show everything</a></div>` : ""}
            ${S.view === "month" ? renderMonth() : renderGrid()}
          </div>
        </div>
        <div class="sc-rail">
          ${railNeedingHours()}
          ${railToday()}
        </div>
      </div>
    </div>`;

    wire(mount);
    if (window.StaffAvatar) window.StaffAvatar.hydrate(mount);
  }

  // ---------- interactions ----------
  function wire(mount) {
    mount.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => step(Number(b.dataset.step))));
    const today = mount.querySelector("[data-today]");
    if (today) today.addEventListener("click", () => { S.anchor = todayIso(); refresh(); });
    mount.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => { S.view = b.dataset.view; refresh(); }));
    mount.querySelectorAll("[data-lens]").forEach((b) => b.addEventListener("click", () => { S.lens = b.dataset.lens; render(); }));
    const refreshBtn = mount.querySelector("[data-refresh]");
    if (refreshBtn) refreshBtn.addEventListener("click", () => refresh());
    const clear = mount.querySelector("[data-clear-filter]");
    if (clear) clear.addEventListener("click", (e) => { e.preventDefault(); S.filterStatus = null; render(); });

    mount.querySelectorAll("[data-metric]").forEach((b) => b.addEventListener("click", () => {
      const f = b.dataset.metric;
      if (!f) return;
      S.filterStatus = S.filterStatus === f ? null : f;
      render();
    }));
    mount.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
      const f = b.dataset.filter;
      if (!f) return;
      S.filterStatus = S.filterStatus === f ? null : f;
      render();
    }));

    const add = mount.querySelector("[data-add]");
    if (add) add.addEventListener("click", () => openSessionEditor(null));

    mount.querySelectorAll("[data-add-row]").forEach((el) => {
      const go = () => {
        const preset = { session_date: el.dataset.addDate };
        if (S.lens === "staff" && el.dataset.addRow !== "0") preset.staff_id = Number(el.dataset.addRow);
        if (S.lens === "client") preset.client_id = Number(el.dataset.addRow);
        if (S.lens === "location") preset.location_id = Number(el.dataset.addRow);
        openSessionEditor(null, preset);
      };
      el.addEventListener("click", go);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });

    mount.querySelectorAll("[data-session]").forEach((el) => {
      el.addEventListener("click", () => openSessionDetail(Number(el.dataset.session)));
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", el.dataset.session);
        e.dataTransfer.effectAllowed = "move";
      });
    });

    // Drag and drop between cells. A drop is a real edit, so it goes through
    // the same conflict checks as any other change and can be refused.
    mount.querySelectorAll("[data-drop-row]").forEach((td) => {
      td.addEventListener("dragover", (e) => { e.preventDefault(); td.classList.add("sc-drop"); });
      td.addEventListener("dragleave", () => td.classList.remove("sc-drop"));
      td.addEventListener("drop", async (e) => {
        e.preventDefault();
        td.classList.remove("sc-drop");
        const id = Number(e.dataTransfer.getData("text/plain"));
        if (!id) return;
        const s = S.sessions.find((x) => x.id === id);
        if (!s) return;
        const body = { session_date: td.dataset.dropDate };
        const rowId = Number(td.dataset.dropRow);
        if (S.lens === "staff") body.staff_id = rowId || null;
        if (S.lens === "location") body.location_id = rowId || null;
        if (S.lens === "client" && rowId !== s.client_id) {
          alert("Moving a session to a different client isn't a drag — open the session and change the client so the change is recorded properly.");
          return;
        }
        if (body.session_date === s.session_date && (S.lens !== "staff" || body.staff_id === s.staff_id)) return;
        await saveWithConflicts(`/api/sched/sessions/${id}`, "PATCH", body,
          `Moved ${s.client_display} to ${fmtDay(body.session_date)}`);
      });
    });
  }

  async function refresh() {
    if (!S.mount) return;
    S.mount.innerHTML = `<div class="sc-wrap"><div class="sc-metrics">
      ${Array.from({ length: 6 }, () => `<div class="sc-skel" style="height:92px;"></div>`).join("")}
      </div><div class="sc-skel" style="height:380px;"></div></div>`;
    injectStyles();
    try { await load(); render(); }
    catch (e) {
      S.mount.innerHTML = `<div class="sc-wrap"><div class="sc-empty"><div class="big">Couldn't load the schedule</div>${esc(e.message)}</div></div>`;
    }
  }

  // Shared save path: blocking conflicts stop, warnings ask once and record why.
  async function saveWithConflicts(path, method, body, successNote) {
    try {
      await call(path, { method, body });
      await refresh();
      return true;
    } catch (e) {
      const p = e.payload || {};
      if (p.error === "conflict") {
        alert("That won't work:\n\n" + (p.blocking || []).map((c) => "• " + c.message).join("\n"));
        return false;
      }
      if (p.error === "warnings") {
        const reason = prompt(
          "Heads up:\n\n" + (p.warnings || []).map((c) => "• " + c.message).join("\n") +
          "\n\nTo go ahead anyway, type a short reason (it gets saved with the change):", "");
        if (!reason) return false;
        try {
          await call(path, { method, body: { ...body, accept_warnings: true, override_reason: reason } });
          await refresh();
          return true;
        } catch (e2) {
          const p2 = e2.payload || {};
          alert(p2.blocking ? p2.blocking.map((c) => "• " + c.message).join("\n") : e2.message);
          return false;
        }
      }
      alert(e.message);
      return false;
    }
  }

  // ---------- editor ----------
  function openSessionEditor(existing, preset) {
    const b = S.boot || { clients: [], staff: [], locations: [] };
    const s = existing || preset || {};
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const opt = (list, sel, label) => `<option value="">—</option>` +
      list.map((x) => `<option value="${x.id}" ${String(x.id) === String(sel) ? "selected" : ""}>${esc(label(x))}</option>`).join("");
    backdrop.innerHTML = `<div class="modal" style="width:540px;">
      <div class="modal-header"><h2 style="font-size:18px;">${existing ? "Edit session" : "Add session"}</h2><button class="close-btn">&#10005;</button></div>
      <div class="form-grid" style="gap:10px;">
        <div class="field full"><label>Client</label><select data-k="client_id">${opt(b.clients, s.client_id, (c) => c.display)}</select></div>
        <div class="field"><label>Assigned staff</label><select data-k="staff_id">${opt(b.staff, s.staff_id, (e) => `${e.name}${e.role_title ? " · " + e.role_title : ""}`)}</select></div>
        <div class="field"><label>Supervising BCBA</label><select data-k="supervisor_id">${opt(b.staff, s.supervisor_id, (e) => e.name)}</select></div>
        <div class="field"><label>Date</label><input data-k="session_date" type="date" value="${esc((s.session_date || todayIso()).slice(0, 10))}" /></div>
        <div class="field"><label>Location</label><select data-k="location_id">${opt(b.locations, s.location_id, (l) => l.name)}</select></div>
        <div class="field"><label>Start</label><input data-k="start_time" type="time" value="${esc(s.start_time || "15:00")}" /></div>
        <div class="field"><label>End</label><input data-k="end_time" type="time" value="${esc(s.end_time || "18:00")}" /></div>
        <div class="field"><label>Service</label><input data-k="service_label" value="${esc(s.service_label || "Direct Therapy W/ RBT")}" /></div>
        <div class="field"><label>CPT</label><input data-k="service_code" value="${esc(s.service_code || "97153")}" placeholder="97153" /></div>
        ${existing ? "" : `<div class="field full"><label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input data-k="recurring" type="checkbox" style="width:auto;" /> Repeat weekly</label></div>
        <div class="field full" data-recur style="display:none;">
          <label>Days</label>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            ${DAY_SHORT.map((d, i) => `<label style="display:flex; align-items:center; gap:4px; font-size:12.5px; border:1px solid var(--border,#e5e7eb); border-radius:9px; padding:5px 9px; cursor:pointer;">
              <input type="checkbox" data-dow="${i}" style="width:auto;" />${d}</label>`).join("")}
          </div>
          <label style="margin-top:8px;">Repeat until</label><input data-k="ends_on" type="date" />
        </div>`}
        <div class="field full"><label>Scheduling notes</label><textarea data-k="admin_notes" rows="2">${esc(s.admin_notes || "")}</textarea></div>
      </div>
      <div style="margin-top:16px; display:flex; gap:8px; align-items:center;">
        <button class="btn" data-save>${existing ? "Save changes" : "Add session"}</button>
        <button class="btn secondary" data-cancel>Cancel</button>
        <span data-status style="font-size:12.5px; color:#b91c1c;"></span>
      </div>
    </div>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.querySelector(".close-btn").addEventListener("click", close);
    backdrop.querySelector("[data-cancel]").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

    const recurBox = backdrop.querySelector("[data-recur]");
    const recurChk = backdrop.querySelector('[data-k="recurring"]');
    if (recurChk) recurChk.addEventListener("change", () => { recurBox.style.display = recurChk.checked ? "" : "none"; });

    backdrop.querySelector("[data-save]").addEventListener("click", async () => {
      const v = {};
      backdrop.querySelectorAll("[data-k]").forEach((el) => { v[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value; });
      const st = backdrop.querySelector("[data-status]");
      if (!v.client_id) { st.textContent = "Choose a client."; return; }
      if (!v.start_time || !v.end_time) { st.textContent = "Set a start and end time."; return; }
      if (v.recurring) {
        v.days_of_week = [...backdrop.querySelectorAll("[data-dow]")].filter((c) => c.checked).map((c) => Number(c.dataset.dow));
        if (!v.days_of_week.length) { st.textContent = "Pick at least one day to repeat on."; return; }
        v.starts_on = v.session_date;
      }
      close();
      await saveWithConflicts(existing ? `/api/sched/sessions/${existing.id}` : "/api/sched/sessions",
        existing ? "PATCH" : "POST", v);
    });
  }

  // ---------- detail ----------
  async function openSessionDetail(id) {
    let data;
    try { data = await call(`/api/sched/sessions/${id}`); } catch (e) { alert(e.message); return; }
    const s = data.session;
    const st = STATUS[s.status] || STATUS.scheduled;
    const can = (S.boot && S.boot.me && S.boot.me.can_schedule);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `<div class="modal" style="width:520px;">
      <div class="modal-header"><h2 style="font-size:18px;">${esc(s.client_display)}</h2><button class="close-btn">&#10005;</button></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
        <span class="sc-pill" style="background:${st.bg}; color:${st.fg};">${st.glyph} ${esc(st.label)}</span>
        ${s.status === "completed" && NOTE_BADGE[s.note_status] ? `<span class="sc-pill" style="background:${NOTE_BADGE[s.note_status].bg}; color:${NOTE_BADGE[s.note_status].fg};">${NOTE_BADGE[s.note_status].label}</span>` : ""}
      </div>
      <table style="width:100%; font-size:13.5px;">
        <tr><td style="color:#6b7280; width:130px; padding:4px 0;">When</td><td>${esc(s.session_date)} &middot; ${esc(s.start_label)} – ${esc(s.end_label)} (${s.hours} hr${s.hours === 1 ? "" : "s"})</td></tr>
        <tr><td style="color:#6b7280; padding:4px 0;">Staff</td><td>
          <span style="display:inline-flex; align-items:center; gap:8px;">
            ${s.staff_id && window.StaffAvatar ? window.StaffAvatar.html(s.staff_id, s.staff_display, { size: 26, hasPhoto: staffHasPhoto(s.staff_id) }) : ""}
            ${esc(s.staff_display)}</span></td></tr>
        ${s.supervisor_name ? `<tr><td style="color:#6b7280; padding:4px 0;">Supervisor</td><td>${esc(s.supervisor_name)}</td></tr>` : ""}
        <tr><td style="color:#6b7280; padding:4px 0;">Location</td><td>${esc(s.location_name || "Not set")}</td></tr>
        <tr><td style="color:#6b7280; padding:4px 0;">Service</td><td>${esc(s.service_label || "Not set")}${s.service_code ? " · " + esc(s.service_code) : ""}</td></tr>
        ${s.cancellation_reason ? `<tr><td style="color:#6b7280; padding:4px 0;">Cancelled</td><td>${esc(s.cancelled_by)} — ${esc(s.cancellation_reason)}</td></tr>` : ""}
        ${s.admin_notes ? `<tr><td style="color:#6b7280; padding:4px 0;">Notes</td><td>${esc(s.admin_notes)}</td></tr>` : ""}
      </table>
      ${can ? `<div style="margin-top:16px; display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn small" data-edit>Edit</button>
        ${["scheduled", "checked_in"].includes(s.status) ? `<button class="btn small secondary" data-status-set="checked_in">Check in</button>` : ""}
        ${["scheduled", "checked_in", "in_progress"].includes(s.status) ? `<button class="btn small secondary" data-status-set="completed">Complete</button>` : ""}
        ${!["cancelled", "completed"].includes(s.status) ? `<button class="btn small secondary" data-cancel-sess style="color:#b91c1c;">Cancel session</button>` : ""}
      </div>` : ""}
      ${data.history && data.history.length ? `<div class="section-title">History</div>
        <div style="font-size:12px; color:#6b7280; max-height:180px; overflow:auto;">
          ${data.history.map((h) => `<div style="padding:4px 0 4px 9px; border-left:2px solid var(--border,#e5e7eb); margin-bottom:3px;">
            <strong>${esc(h.action.replace(/_/g, " "))}</strong>${h.field ? " · " + esc(h.field.replace(/_/g, " ")) : ""}
            ${h.old_value || h.new_value ? `<div>${esc(h.old_value || "—")} → ${esc(h.new_value || "—")}</div>` : ""}
            ${h.reason ? `<div><em>${esc(h.reason)}</em></div>` : ""}
            <div style="opacity:.7;">${esc((h.created_at || "").slice(0, 16).replace("T", " "))} · ${esc(h.actor || "")}</div>
          </div>`).join("")}
        </div>` : ""}
    </div>`;
    document.body.appendChild(backdrop);
    if (window.StaffAvatar) window.StaffAvatar.hydrate(backdrop);
    const close = () => backdrop.remove();
    backdrop.querySelector(".close-btn").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

    const editBtn = backdrop.querySelector("[data-edit]");
    if (editBtn) editBtn.addEventListener("click", () => { close(); openSessionEditor(s); });
    backdrop.querySelectorAll("[data-status-set]").forEach((btn) => btn.addEventListener("click", async () => {
      close();
      await saveWithConflicts(`/api/sched/sessions/${s.id}`, "PATCH", { status: btn.dataset.statusSet });
    }));
    const cancelBtn = backdrop.querySelector("[data-cancel-sess]");
    if (cancelBtn) cancelBtn.addEventListener("click", () => { close(); openCancel(s); });
  }

  function openCancel(s) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `<div class="modal" style="width:440px;">
      <div class="modal-header"><h2 style="font-size:17px;">Cancel ${esc(s.client_display)}'s session</h2><button class="close-btn">&#10005;</button></div>
      <div class="form-grid" style="gap:10px;">
        <div class="field full"><label>Who cancelled?</label><select data-k="cancelled_by">
          <option value="client_family">Client / family</option>
          <option value="staff">Staff member</option>
          <option value="spectrum_squad">Spectrum Squad</option>
          <option value="other">Other</option></select></div>
        <div class="field full"><label>Reason</label><input data-k="reason" placeholder="Child unwell, family travel, staff sick…" /></div>
        <div class="field full"><label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input data-k="staff_call_out" type="checkbox" style="width:auto;" /> This is a staff call-out — keep the session and find coverage</label></div>
        <div class="field full"><label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input data-k="no_show" type="checkbox" style="width:auto;" /> Client did not show</label></div>
        <div class="field full"><label>Notes (optional)</label><textarea data-k="notes" rows="2"></textarea></div>
      </div>
      <div style="margin-top:14px; display:flex; gap:8px; align-items:center;">
        <button class="btn" data-go>Record cancellation</button>
        <button class="btn secondary" data-cancel>Back</button>
        <span data-status style="font-size:12.5px; color:#b91c1c;"></span>
      </div>
      <div style="font-size:12px; color:#6b7280; margin-top:10px;">A cancelled session is never billable and is kept on the record.</div>
    </div>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.querySelector(".close-btn").addEventListener("click", close);
    backdrop.querySelector("[data-cancel]").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector("[data-go]").addEventListener("click", async () => {
      const v = {};
      backdrop.querySelectorAll("[data-k]").forEach((el) => { v[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value; });
      const st = backdrop.querySelector("[data-status]");
      if (!clean(v.reason)) { st.textContent = "A reason is required."; return; }
      try { await call(`/api/sched/sessions/${s.id}/cancel`, { method: "POST", body: v }); close(); await refresh(); }
      catch (e) { st.textContent = e.message; }
    });
  }

  // ---------- entry point ----------
  async function renderSchedulingCenter(mount) {
    if (!mount) return;
    injectStyles();
    S.mount = mount;
    await refresh();
  }

  window.SchedulingCenter = { render: renderSchedulingCenter };
})();
