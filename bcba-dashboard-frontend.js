// bcba-dashboard-frontend.js -- the BCBA's landing screen.
//
// This REPLACES the generic Dashboard for the clinical (BCBA) role. There is no
// "BCBA Dashboard" nav item and there is no BCBA picker for a BCBA: their own
// account is the answer to "whose caseload is this", so the page loads their
// work without asking them anything. An owner or admin keeps the administrative
// dashboard and gets a picker, because covering an absence otherwise means
// asking the person who is absent.
//
// Every number on this page is read from the system that owns it -- clients,
// staff tasks, the authorization alert queue, billable requirements, the RBT
// supervision tracker, Rethink. Nothing is stored here and nothing is a second
// copy. The one thing the page is careful to SAY rather than imply: where a
// figure is not available yet, it says so instead of showing a zero, because
// "0 of 90 hours" reads as a performance problem when the truth is that the
// month's hours have not synced.
//
// Exposes window.__renderBcbaDashboard(mount) and window.__isBcbaDashboardUser().
(function () {
  "use strict";

  const TONES = {
    darkred:  { bg: "#7f1d1d", fg: "#ffffff", soft: "#fee2e2", softFg: "#7f1d1d" },
    red:      { bg: "#dc2626", fg: "#ffffff", soft: "#fee2e2", softFg: "#991b1b" },
    orange:   { bg: "#ea7317", fg: "#ffffff", soft: "#ffedd5", softFg: "#9a3412" },
    yellow:   { bg: "#eab308", fg: "#3f2d00", soft: "#fef9c3", softFg: "#854d0e" },
    none:     { bg: "#e9f9ee", fg: "#166534", soft: "#e9f9ee", softFg: "#166534" },
    grey:     { bg: "#e5e7eb", fg: "#4b5563", soft: "#f3f4f6", softFg: "#6b7280" },
  };

  // Line icons, drawn here rather than pulled from a font: the app ships no
  // icon library and a webfont for nine glyphs is a network request that can
  // fail and leave empty boxes on a clinical screen.
  const ICON = {
    people: '<circle cx="7" cy="7" r="2.5"/><circle cx="13.5" cy="8" r="2"/><path d="M3 16c0-2.2 1.8-4 4-4s4 1.8 4 4"/><path d="M12 16c0-1.7 1.1-3 2.5-3S17 14.3 17 16"/>',
    doc: '<path d="M6 3h5l3 3v11a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M11 3v3h3"/>',
    checkbox: '<rect x="3.5" y="3.5" width="13" height="13" rx="2"/><path d="M7 10l2 2 4-4"/>',
    cap: '<path d="M10 4l7 3.5-7 3.5-7-3.5L10 4z"/><path d="M6 9.5V13c0 1.1 1.8 2 4 2s4-.9 4-2V9.5"/>',
    chart: '<path d="M4 16V9"/><path d="M9 16V4"/><path d="M14 16v-5"/>',
    clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>',
    calendar: '<rect x="3.5" y="4.5" width="13" height="12" rx="2"/><path d="M3.5 8h13"/><path d="M7 3v3M13 3v3"/>',
    briefcase: '<rect x="3" y="6.5" width="14" height="9" rx="2"/><path d="M7.5 6.5V5a1 1 0 011-1h3a1 1 0 011 1v1.5"/>',
    link: '<path d="M8.5 11.5a3 3 0 004.2 0l2.3-2.3a3 3 0 10-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 00-4.2 0L5 10.8a3 3 0 104.2 4.2l1-1"/>',
    chevron: '<path d="M8 5l5 5-5 5"/>',
    download: '<path d="M10 3v9"/><path d="M6.5 8.5L10 12l3.5-3.5"/><path d="M4 15h12"/>',
  };
  function icon(name, size) {
    return '<svg class="bd-i" width="' + (size || 17) + '" height="' + (size || 17) + '" viewBox="0 0 20 20" ' +
      'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICON[name] || "") + "</svg>";
  }

  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  const n0 = (v) => (v == null ? "—" : String(v));

  function dayLabel(s) {
    if (!s) return "—";
    const p = String(s).slice(0, 10).split("-");
    if (p.length !== 3) return String(s);
    const m = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return (m[+p[1]] || p[1]) + " " + (+p[2]) + ", " + p[0];
  }
  const todayStr = () => new Date().toISOString().slice(0, 10);
  function longDate() {
    try {
      return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    } catch (e) { return todayStr(); }
  }
  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }
  const firstName = (full) => String(full || "").trim().split(/\s+/)[0] || "there";

  function pill(u) {
    if (!u) return "";
    const t = TONES[u.tone] || TONES.grey;
    return `<span class="bd-pill" style="background:${t.soft}; color:${t.softFg};">${esc(u.label)}</span>`;
  }

  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, {
      method: opts.method || "GET", credentials: "include",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "Request failed");
    return d;
  }

  // The dashboard is for the clinical (BCBA) role. Anyone else keeps the
  // dashboard they already had.
  window.__isBcbaDashboardUser = function () {
    return typeof state !== "undefined" && !!state.user && state.user.role === "clinical";
  };

  let data = null, mountEl = null, viewingEmail = null;
  let caseFilter = "all", caseSearch = "", scheduleDate = todayStr();
  // Empty string means "no health filter". Kept separate from caseFilter so
  // the stage buttons and the health segments compose rather than replace one
  // another.
  let healthFilter = "";
  // The month the calendar is showing, and the month payload it last loaded.
  // Kept apart from scheduleDate so clicking a day inside the open month is
  // instant -- the rows are already here, and re-fetching Rethink to show a
  // day we already hold would be a spinner for nothing.
  let scheduleMonth = todayStr().slice(0, 7);
  let monthData = null;

  function injectStyles() {
    if (document.getElementById("bd-styles")) return;
    const st = document.createElement("style");
    st.id = "bd-styles";
    st.textContent = `
    /* .bd itself, not only its descendants: the app's global border-box rule
       never applies (a stray declaration makes the parser swallow it), so
       padding adds OUTSIDE a declared width here unless it is set explicitly. */
    .bd { padding: 22px; max-width: 1240px; min-width: 0; box-sizing: border-box; }
    .bd *, .bd *::before, .bd *::after { min-width: 0; box-sizing: border-box; }
    @media (max-width: 700px) { .bd { padding: 14px; } }
    /* The Task Center is the shell's markup mounted inside this section, so its
       rows follow the app's styling rather than this one's. A task row is a
       flex line of check, text and buttons that will not wrap on its own. */
    .bd-tc .tc-row { flex-wrap: wrap; }
    .bd-tc .tc-tabs { flex-wrap: wrap; }
    .bd-head { margin-bottom: 18px; display:flex; align-items:flex-end; justify-content:space-between; gap:14px; flex-wrap:wrap; }
    .bd-hello { font-size: clamp(19px, 3.6vw, 25px); font-weight: 700; color: #1b2a6b; margin: 0 0 3px; letter-spacing: -0.2px; }
    .bd-sub { font-size: 13px; color: #767488; margin: 0; }
    .bd-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(215px, 100%), 1fr)); gap: 12px; margin-bottom: 18px; }
    .bd-card { background:#fff; border:1px solid #e6e1d4; border-radius:12px; padding:13px 15px; text-align:left; font:inherit; cursor:pointer; display:block; width:100%; }
    .bd-card:hover { border-color:#c9c2ae; }
    .bd-card[data-static="1"] { cursor: default; }
    .bd-card[data-static="1"]:hover { border-color:#e6e1d4; }
    /* The mock's card head: a tinted rounded square holding a line icon, with
       the number beside it rather than under it. */
    .bd-chead { display:flex; align-items:center; gap:11px; margin-bottom:9px; }
    .bd-mark { width:38px; height:38px; border-radius:11px; display:grid; place-items:center; flex:0 0 auto; }
    .bd-i { display:block; }
    .bd-headmeta { text-align:right; font-size:12px; color:#767488; line-height:1.6; }
    .bd-headmeta .q { font-style:italic; color:#5b5878; }
    .bd-chev { color:#b9b6c9; flex:0 0 auto; }
    .bd-row-link { cursor:pointer; }
    .bd-row-link:hover { background:#faf8f3; }
    .bd-ct { font-size:10.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#767488; margin-bottom:6px; }
    .bd-cn { font-size:26px; font-weight:700; color:#1b2a6b; line-height:1.05; }
    .bd-cl { font-size:11.5px; color:#767488; margin-top:5px; line-height:1.5; }
    .bd-split { display:flex; gap:5px 12px; flex-wrap:wrap; margin-top:7px; }
    .bd-chip { font-size:10.5px; font-weight:700; padding:2px 7px; border-radius:20px; }
    .bd-panel { background:#fff; border:1px solid #e6e1d4; border-radius:12px; margin-bottom:16px; overflow:hidden; }
    .bd-ph { padding:12px 15px; border-bottom:1px solid #f0ece2; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
    .bd-pt { font-size:13.5px; font-weight:700; color:#1b2a6b; margin:0; display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
    .bd-pn { font-size:11.5px; color:#767488; margin:2px 0 0; font-weight:400; }
    .bd-body { padding: 4px 0; }
    .bd-scroll { overflow-x:auto; }
    .bd table { width:100%; border-collapse:collapse; font-size:12.5px; }
    .bd th { text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:#767488; font-weight:700; padding:8px 14px; border-bottom:1px solid #f0ece2; white-space:nowrap; }
    .bd td { padding:9px 14px; border-bottom:1px solid #f6f3ec; vertical-align:top; }
    .bd tr:last-child td { border-bottom:0; }
    .bd-link { color:#1b2a6b; font-weight:600; text-decoration:none; cursor:pointer; background:none; border:0; padding:0; font:inherit; text-align:left; }
    .bd-link:hover { text-decoration:underline; }
    .bd-pill { font-size:10.5px; font-weight:700; padding:2px 8px; border-radius:20px; white-space:nowrap; display:inline-block; }
    .bd-empty { padding:22px 15px; color:#767488; font-size:12.5px; text-align:center; }
    .bd-note { padding:9px 15px; color:#767488; font-size:11.5px; background:#faf8f3; border-top:1px solid #f0ece2; }
    .bd-warn { padding:10px 15px; background:#fef9c3; color:#854d0e; font-size:12px; border-top:1px solid #fde68a; }
    .bd-filters { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
    .bd-fb { font-size:11.5px; font-weight:600; padding:4px 10px; border-radius:20px; border:1px solid #e6e1d4; background:#fff; color:#4b5563; cursor:pointer; }
    .bd-fb.on { background:#1b2a6b; color:#fff; border-color:#1b2a6b; }
    .bd-search { font-size:12.5px; padding:5px 9px; border:1px solid #e6e1d4; border-radius:8px; min-width:0; flex:1 1 150px; max-width:230px; }
    .bd-bar { height:8px; background:#eeecf6; border-radius:999px; overflow:hidden; margin-top:8px; }
    .bd-bar i { display:block; height:100%; background:#1b2a6b; }
    .bd-links { display:flex; flex-wrap:wrap; gap:7px; }
    .bd-linkrow { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 15px;
      font-size:12.5px; font-weight:600; color:#1b2a6b; text-decoration:none; border-bottom:1px solid #f6f3ec; }
    .bd-linkrow:last-child { border-bottom:0; }
    .bd-linkrow:hover { background:#faf8f3; }
    .bd-ql { font-size:12px; font-weight:600; padding:6px 12px; border-radius:8px; border:1px solid #e6e1d4; background:#fff; color:#1b2a6b; text-decoration:none; }
    .bd-ql:hover { background:#f6f3ec; }
    .bd-day { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .bd-db { font-size:11.5px; font-weight:600; padding:4px 9px; border:1px solid #e6e1d4; border-radius:8px; background:#fff; cursor:pointer; color:#4b5563; }
    .bd-an { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .bd-drawer-back { position:fixed; inset:0; background:rgba(20,20,30,.35); z-index:80; display:flex; justify-content:flex-end; }
    .bd-drawer { background:#fff; width:min(420px,100%); height:100%; overflow-y:auto; padding:20px; }
    .bd-x { float:right; border:0; background:none; font-size:18px; cursor:pointer; color:#767488; line-height:1; }
    .bd-tc { margin-bottom:16px; }
    .bd-two { display:grid; grid-template-columns: repeat(auto-fit, minmax(min(330px,100%), 1fr)); gap:16px; }

    /* ---- month calendar ------------------------------------------------
       Seven equal columns at every width. The cells shrink rather than the
       grid scrolling sideways, because a calendar you have to scroll is not
       a calendar -- the whole point is seeing the month at once. */
    .bd-cal { display:grid; grid-template-columns:repeat(7,1fr); gap:4px; }
    .bd-cal-dow { font-size:10.5px; font-weight:700; letter-spacing:.05em; text-transform:uppercase;
      color:#8b8798; text-align:center; padding:4px 0 2px; }
    .bd-cal-cell { min-height:74px; border:1px solid #ece8dd; border-radius:9px; background:#fff;
      padding:5px 6px; text-align:left; font:inherit; cursor:pointer; display:flex; flex-direction:column;
      gap:3px; transition:border-color .12s, background .12s; }
    .bd-cal-cell:hover { border-color:#c9c2ae; background:#fdfcf9; }
    .bd-cal-cell.pad { background:#faf9f6; border-color:#f1eee6; cursor:default; }
    .bd-cal-cell.pad:hover { background:#faf9f6; border-color:#f1eee6; }
    .bd-cal-cell.today { border-color:#1b2a6b; box-shadow:inset 0 0 0 1px #1b2a6b; }
    .bd-cal-cell.sel { background:#1b2a6b; border-color:#1b2a6b; }
    .bd-cal-cell.sel .bd-cal-n, .bd-cal-cell.sel .bd-cal-h { color:#fff; }
    .bd-cal-cell.sel .bd-cal-pill { background:#e0a430; color:#1b2a6b; }
    .bd-cal-n { font-size:12.5px; font-weight:700; color:#33324a; line-height:1.1; }
    .bd-cal-pill { align-self:flex-start; font-size:10.5px; font-weight:700; padding:1px 6px;
      border-radius:999px; background:#eef1fa; color:#1b2a6b; }
    .bd-cal-h { font-size:10.5px; color:#767488; margin-top:auto; }
    .bd-cal-sum { font-size:12px; color:#767488; margin-top:10px; }
    @media (max-width:560px) {
      .bd-cal-cell { min-height:56px; padding:4px; }
      .bd-cal-n { font-size:11.5px; }
      .bd-cal-pill { font-size:9.5px; padding:0 4px; }
      .bd-cal-h { display:none; }
    }

    /* ================= the command centre ==============================
       Everything below is the visual hierarchy this page was missing: it had
       seven cards of identical weight and a lot of white. The rule here is
       that SIZE MEANS URGENCY. The billable ring and the priority feed are
       the two things a BCBA opens this page for, so they are the two things
       that are big; the counts beside them are a strip of tiles, not seven
       more cards competing for the same attention. */

    /* The header no longer takes a tenth of the screen. */
    .bd-head { margin-bottom: 14px; align-items: center; }

    /* WEEK STRIP: the billable ring, then compact tiles. */
    .bd-week { display:grid; grid-template-columns: minmax(250px, 300px) 1fr; gap:12px; margin-bottom:14px; align-items:stretch; }
    @media (max-width: 900px) { .bd-week { grid-template-columns: 1fr; } }
    .bd-hero { background:#fff; border:1px solid #e6e1d4; border-radius:14px; padding:15px 17px; display:flex; gap:15px; align-items:center; }
    .bd-hero.win { background:linear-gradient(180deg,#f2fbf5 0%,#ffffff 70%); border-color:#bfe6cd; }
    .bd-hero-txt { min-width:0; }
    .bd-ring { flex:0 0 auto; position:relative; width:86px; height:86px; }
    .bd-ring svg { display:block; transform:rotate(-90deg); }
    .bd-ring-c { position:absolute; inset:0; display:grid; place-items:center; text-align:center; }
    .bd-ring-n { font-size:19px; font-weight:800; color:#1b2a6b; line-height:1; letter-spacing:-.4px; }
    .bd-ring-l { font-size:9.5px; font-weight:700; color:#8b8798; text-transform:uppercase; letter-spacing:.05em; margin-top:2px; }
    .bd-hero-big { font-size:20px; font-weight:800; color:#1b2a6b; letter-spacing:-.3px; line-height:1.1; }
    .bd-hero-sub { font-size:11.5px; color:#767488; margin-top:4px; line-height:1.5; }
    .bd-hero-mtd { margin-top:9px; padding-top:9px; border-top:1px dashed #ece8dd; }
    .bd-mini { height:6px; background:#eeecf6; border-radius:999px; overflow:hidden; margin-top:5px; }
    .bd-mini i { display:block; height:100%; background:#4a63c9; border-radius:999px; }

    /* TILES: four compact facts, not four more cards. */
    .bd-tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(min(140px,100%), 1fr)); gap:10px; }
    .bd-tile { background:#fff; border:1px solid #e6e1d4; border-radius:12px; padding:11px 13px; text-align:left;
      font:inherit; cursor:pointer; display:flex; flex-direction:column; gap:2px; border-left-width:4px; }
    .bd-tile:hover { border-color:#c9c2ae; border-left-color:inherit; background:#fdfcf9; }
    .bd-tile-n { font-size:22px; font-weight:800; color:#1b2a6b; line-height:1.05; letter-spacing:-.4px; }
    .bd-tile-t { font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#8b8798; }
    .bd-tile-s { font-size:11px; color:#767488; line-height:1.45; margin-top:2px; }

    /* PRIORITY FEED. Left rule carries the colour; the row stays readable. */
    .bd-prio { display:flex; align-items:center; gap:11px; padding:10px 15px; border-bottom:1px solid #f6f3ec;
      border-left:4px solid transparent; background:none; width:100%; text-align:left; font:inherit; cursor:pointer; }
    .bd-prio:last-child { border-bottom:0; }
    .bd-prio:hover { background:#faf8f3; }
    .bd-prio-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
    .bd-prio-txt { flex:1 1 auto; min-width:0; }
    .bd-prio-n { font-size:13px; font-weight:700; color:#1b2a6b; }
    .bd-prio-d { font-size:11.5px; color:#5b5878; margin-top:1px; }
    .bd-prio-go { font-size:11px; font-weight:700; color:#2c4bb8; white-space:nowrap; flex:0 0 auto; display:flex; align-items:center; gap:3px; }
    .bd-calm { padding:16px 15px; display:flex; gap:11px; align-items:center; }
    .bd-calm-e { font-size:20px; line-height:1; }
    .bd-calm-t { font-size:13px; font-weight:700; color:#166534; }
    .bd-calm-s { font-size:11.5px; color:#767488; margin-top:1px; }

    /* HEALTH: three segments that filter the table below. */
    .bd-health { display:flex; gap:8px; flex-wrap:wrap; }
    .bd-hb { display:flex; align-items:center; gap:7px; padding:6px 12px; border-radius:20px; border:1px solid #e6e1d4;
      background:#fff; font:inherit; font-size:12px; font-weight:600; color:#4b5563; cursor:pointer; }
    .bd-hb:hover { border-color:#c9c2ae; }
    .bd-hb.on { border-width:2px; padding:5px 11px; }
    .bd-hb b { font-size:14px; font-weight:800; }
    .bd-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; display:inline-block; }
    /* The table's health cell: a dot that explains itself on hover. */
    .bd-hcell { display:inline-flex; align-items:center; gap:6px; cursor:help; }
    .bd-hcell span.t { font-size:11px; font-weight:700; }

    /* CALENDAR CATEGORIES. Colour is never the only carrier -- the day cell
       shows counts and the detail rows name the service in words. */
    .bd-cal-bars { display:flex; gap:2px; margin-top:auto; }
    .bd-cal-bars i { height:3px; border-radius:2px; flex:1 1 auto; min-width:3px; }
    .bd-leg { display:flex; gap:9px 14px; flex-wrap:wrap; padding:9px 15px; border-top:1px solid #f0ece2; background:#faf8f3; }
    .bd-leg span { font-size:10.5px; color:#5b5878; display:inline-flex; align-items:center; gap:5px; }
    .bd-leg i { width:9px; height:9px; border-radius:3px; display:inline-block; }
    .bd-appt { display:flex; gap:11px; padding:9px 15px; border-bottom:1px solid #f6f3ec; align-items:flex-start; }
    .bd-appt:last-child { border-bottom:0; }
    .bd-appt-bar { width:3px; border-radius:2px; align-self:stretch; flex:0 0 auto; }
    .bd-appt-t { font-size:11.5px; font-weight:700; color:#1b2a6b; white-space:nowrap; flex:0 0 auto; min-width:92px; }
    .bd-appt-m { flex:1 1 auto; min-width:0; }
    .bd-appt-n { font-size:12.5px; font-weight:600; color:#33324a; }
    .bd-appt-s { font-size:11px; color:#767488; margin-top:1px; }

    /* WINS + ACTIVITY */
    .bd-win { display:flex; gap:10px; padding:9px 15px; align-items:flex-start; border-bottom:1px solid #f6f3ec; }
    .bd-win:last-child { border-bottom:0; }
    .bd-win-e { font-size:15px; line-height:1.3; flex:0 0 auto; }
    .bd-win-n { font-size:12.5px; color:#33324a; }
    .bd-win-d { font-size:11px; color:#767488; margin-top:1px; }
    .bd-act { display:flex; gap:10px; padding:8px 15px; align-items:baseline; border-bottom:1px solid #f6f3ec; font-size:12px; }
    .bd-act:last-child { border-bottom:0; }
    .bd-act-w { flex:1 1 auto; min-width:0; color:#33324a; }
    .bd-act-t { font-size:10.5px; color:#8b8798; white-space:nowrap; flex:0 0 auto; }

    /* QUICK LINKS as tiles rather than six full-width rows. */
    .bd-tiles-l { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(155px,100%),1fr)); gap:8px; padding:12px 15px; }
    .bd-lt { display:flex; align-items:center; gap:9px; padding:10px 11px; border:1px solid #e6e1d4; border-radius:10px;
      background:#fff; font-size:12px; font-weight:600; color:#1b2a6b; text-decoration:none; }
    .bd-lt:hover { background:#f6f3ec; border-color:#c9c2ae; }

    /* SUPERVISION compliance strip above the table it summarises. */
    .bd-sup { display:flex; gap:10px 18px; flex-wrap:wrap; align-items:center; padding:11px 15px; border-bottom:1px solid #f0ece2; }
    .bd-sup-n { font-size:19px; font-weight:800; color:#1b2a6b; line-height:1; }
    .bd-sup-l { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#8b8798; margin-top:3px; }

    /* Branding must never be easier to read than the data. There are TWO
       marks on every page -- theme.js paints one behind #view-mount and the
       shell fixes a second in the top right corner -- and both are dimmed
       HERE rather than removed at source, so every other page keeps the look
       it was given.
       z-index matters as much as opacity: the pseudo-element is positioned
       and the panels are not, so at z-index 0 it painted OVER the cards it
       was supposed to sit behind. */
    #view-mount:has(.bd)::before { opacity:.02 !important; background-size:240px !important;
      background-position: right 30px bottom 26px !important; z-index:-1 !important; }
    .main:has(.bd) > img[aria-hidden="true"] { opacity:.028 !important; width:86px !important; }

    /* TASK CENTER. The shell's own component, mounted here -- its markup and
       its behaviour are not this page's to change, so the empty state is
       reshaped with CSS alone. Tasks & Alerts keeps the look it was given.
       An empty task list took a card the height of the caseload table to say
       nothing was due. */
    .bd-tc .empty-state { padding:11px 15px !important; min-height:0 !important; height:auto !important;
      text-align:left !important; font-size:12.5px; color:#166534; display:flex; align-items:center; gap:8px; }
    .bd-tc .empty-state::before { content:"✓"; font-weight:800; color:#16a34a; font-size:13px; }
    /* Overdue is the one thing in that list worth interrupting for. */
    .bd-tc .tc-row.overdue { border-left:3px solid #dc2626; background:#fffafa; }

    /* Micro-interactions only: a fade-in on the priority feed, and nothing
       that moves while somebody is reading a deadline. */
    @media (prefers-reduced-motion: no-preference) {
      .bd-prio, .bd-tile, .bd-hero { animation: bd-in .22s ease-out both; }
      @keyframes bd-in { from { opacity:0; transform:translateY(3px); } to { opacity:1; transform:none; } }
    }

    /* RESPONSIVE. Desktop and laptop are the BCBA's workflow, so nothing is
       hidden on the way down -- the grids collapse and the table scrolls
       inside its own panel rather than the page going wide. */
    @media (max-width: 1100px) {
      .bd-week { grid-template-columns: 1fr; }
      .bd-two { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      .bd-hero { flex-direction:column; align-items:flex-start; }
      .bd-hcell span.t { display:none; }
      .bd-prio-go { font-size:0; }
      .bd-prio-go svg { width:14px; height:14px; }
      .bd-appt { flex-wrap:wrap; }
      .bd-appt-t { min-width:0; }
    }

    @media print {
      .sidebar, .bd-filters, .bd-day, .bd-links, .bd-fb, .bd-health { display:none !important; }
      .bd-panel { break-inside: avoid; }
      .bd-cal-cell { min-height:58px; }
      .bd-prio, .bd-tile, .bd-hero { animation:none !important; }
    }`;
    document.head.appendChild(st);
  }

  // ================= the clinical week ====================================
  // WHAT THIS REPLACED, and why: seven cards of identical size and colour,
  // each with a number in it. A page where everything is emphasised has no
  // emphasis, and the two things a BCBA opens this for -- am I on track, and
  // what is on fire -- were the same weight as the Student Analyst count.
  //
  // Nothing was removed. Every figure the old cards carried is still here and
  // still comes from the same place in the payload; they are arranged by how
  // much they matter instead of by the order they were written.
  const RING_R = 34, RING_C = 2 * Math.PI * RING_R;

  function ring(percent, tone) {
    // An unavailable figure gets an empty track and no number, never a 0%
    // sweep -- a full grey circle reads as "you have done none of it".
    const p = percent == null ? null : Math.max(0, Math.min(100, percent));
    const dash = p == null ? 0 : (p / 100) * RING_C;
    const stroke = tone === "green" ? "#16a34a" : tone === "gold" ? "#d97706" : "#2c4bb8";
    return `<div class="bd-ring">
      <svg width="86" height="86" viewBox="0 0 86 86" aria-hidden="true">
        <circle cx="43" cy="43" r="${RING_R}" fill="none" stroke="#eeecf6" stroke-width="8"/>
        ${p == null ? "" : `<circle cx="43" cy="43" r="${RING_R}" fill="none" stroke="${stroke}" stroke-width="8"
          stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${(RING_C - dash).toFixed(1)}"/>`}
      </svg>
      <div class="bd-ring-c">
        <div class="bd-ring-n" style="${p == null ? "color:#b9b6c9;" : ""}">${p == null ? "—" : p + "%"}</div>
        <div class="bd-ring-l">of goal</div>
      </div>
    </div>`;
  }

  // The headline for a billable figure that is not available. Each cause has
  // its own words because each has a different person fixing it; the server
  // decides which, and the page does not guess.
  const UNAVAILABLE_HEAD = {
    none_counted: "Waiting on verification",
    not_linked: "Not linked to Rethink",
    sync_failed: "Sync failed",
    never_synced: "Not synced yet",
    not_configured: "Not configured",
    no_target: "No weekly requirement",
    no_staff_record: "No staff record",
  };

  function billableHero(d) {
    const b = d.summary.billable;
    if (!b.available) {
      return `<div class="bd-hero">
        ${ring(null)}
        <div class="bd-hero-txt">
          <div class="bd-ct">Billable progress</div>
          <div class="bd-hero-big" style="font-size:15px; line-height:1.3;">${esc(UNAVAILABLE_HEAD[b.reason] || "Not available")}</div>
          <div class="bd-hero-sub">${esc(b.note || "")}</div>
        </div>
      </div>`;
    }
    const met = b.percent != null && b.percent >= 100;
    const over = Math.round((b.completed - b.required) * 10) / 10;
    const m = b.month;
    return `<div class="bd-hero${met ? " win" : ""}">
      ${ring(b.percent, met ? "green" : b.percent != null && b.percent >= 70 ? "gold" : null)}
      <div class="bd-hero-txt">
        <div class="bd-ct">${met ? "Weekly goal reached 🎉" : "Billable · this week"}</div>
        <div class="bd-hero-big">${b.completed} / ${b.required} <span style="font-size:13px; font-weight:600; color:#767488;">hrs</span></div>
        <div class="bd-hero-sub">${met
          ? `${over > 0 ? over + " hours above target." : "Target met exactly."} Nice work.`
          : `${b.remaining} hour${b.remaining === 1 ? "" : "s"} remaining this week.`}</div>
        ${b.unverified_appointments ? `<div class="bd-hero-sub" style="color:#b45309;">${b.unverified_appointments} session${
            b.unverified_appointments === 1 ? " is" : "s are"} awaiting staff verification in Rethink.</div>` : ""}
        ${m ? `<div class="bd-hero-mtd">
          <div class="bd-ct" style="margin-bottom:3px;">This month so far</div>
          <div style="font-size:12.5px; font-weight:700; color:#33324a;">${m.completed} / ${m.required} hrs${
            m.percent == null ? "" : ` · ${m.percent}%`}</div>
          <div class="bd-mini"><i style="width:${Math.max(0, Math.min(100, m.percent || 0))}%;"></i></div>
          <div class="bd-hero-sub">${m.remaining > 0
            ? `${m.remaining} hours remaining across ${m.weeks_counted} measured week${m.weeks_counted === 1 ? "" : "s"}.`
            : `Ahead across ${m.weeks_counted} measured week${m.weeks_counted === 1 ? "" : "s"}.`}</div>
        </div>` : ""}
      </div>
    </div>`;
  }

  // A tile is a fact plus a way in. `go` is the existing navigation, unchanged.
  function tile(opts) {
    return `<button class="bd-tile" data-go="${opts.go}" style="border-left-color:${opts.rule};"
      ${opts.title ? `title="${esc(opts.title)}"` : ""}>
      <div class="bd-tile-t">${esc(opts.label)}</div>
      <div class="bd-tile-n"${opts.numColor ? ` style="color:${opts.numColor};"` : ""}>${esc(String(opts.value))}</div>
      <div class="bd-tile-s">${opts.sub}</div>
    </button>`;
  }

  function cards(d) {
    const s = d.summary;
    const c = s.clients, a = s.authorizations, tp = s.treatment_plans, an = s.analysts;

    // Urgency chooses the rule colour: red for anything already past, gold for
    // anything inside the window, green when there is nothing to do. The
    // thresholds are the server's -- this reads its bands, it does not invent
    // its own.
    const toneOf = (bands) => bands.expired ? "#dc2626"
      : (bands.d7 || bands.d30) ? "#d97706"
      : bands.d60 ? "#eab308" : "#16a34a";

    const authSub = a.attention
      ? [a.expired ? `${a.expired} expired` : "", a.d7 ? `${a.d7} within 7 days` : "",
         a.d30 ? `${a.d30} within 30` : "", a.d60 ? `${a.d60} within 60` : ""].filter(Boolean).join(" · ")
      : "Nothing inside 60 days.";
    const tpSub = tp.attention
      ? [tp.expired ? `${tp.expired} overdue` : "", tp.d7 ? `${tp.d7} within 7 days` : "",
         tp.d30 ? `${tp.d30} within 30` : "", tp.d60 ? `${tp.d60} within 60` : ""].filter(Boolean).join(" · ")
      : "Nothing inside 60 days.";

    return `<div class="bd-week">
      ${billableHero(d)}
      <div class="bd-tiles">
        ${tile({ go: "caseload", label: "Total caseload", value: c.total, rule: "#2c4bb8",
          sub: [c.in_therapy ? `${c.in_therapy} in therapy` : "", c.assessment ? `${c.assessment} assessment` : "",
                c.on_hold ? `${c.on_hold} on hold` : ""].filter(Boolean).join(" · ") || "No open clients." })}
        ${tile({ go: "caseload", label: "Treatment plans", value: tp.attention, rule: toneOf(tp),
          numColor: tp.expired ? "#b91c1c" : undefined, sub: esc(tpSub)
            + (s.plans && s.plans.no_date ? `<br/><span style="color:#b45309;">${s.plans.no_date} with no deadline recorded</span>` : "") })}
        ${tile({ go: "auth", label: "Authorizations", value: a.attention, rule: toneOf(a),
          numColor: a.expired ? "#b91c1c" : undefined, sub: esc(authSub) })}
        ${tile({ go: "analysts", label: "Student analysts", value: an.count, rule: an.clients_without ? "#eab308" : "#16a34a",
          sub: an.clients_without
            ? `${an.clients_with} client${an.clients_with === 1 ? "" : "s"} covered · <span style="color:#b45309;">${an.clients_without} unassigned</span>`
            : `Every client has one.` })}
      </div>
    </div>`;
  }

  // ================= priority for you =====================================
  // THE SAME VERDICTS THE HEALTH DOTS USE, ranked. The server builds them from
  // one set of rules so a client cannot be top of this list and green in the
  // table. Nothing here is hard-coded: every line is a client on this BCBA's
  // own caseload with a reason that came out of their own record.
  const LEVEL = {
    action:    { dot: "#dc2626", rule: "#dc2626", label: "Action required" },
    attention: { dot: "#eab308", rule: "#eab308", label: "Needs attention" },
  };
  // Which existing screen a reason belongs on. No new pages: these are the
  // routes the dashboard already links to.
  const PRIO_ACTION = {
    auth_expired: "Review authorization", auth_urgent: "Review authorization",
    auth_soon: "Review authorization",
    plan_overdue: "Open treatment plan", plan_soon: "Open treatment plan",
    plan_missing: "Set plan deadline",
    no_analyst: "Assign an analyst", task_overdue: "Open tasks", task_today: "Open tasks",
  };

  function priorityPanel(d) {
    const rows = d.priorities || [];
    const body = rows.length
      ? rows.map((p) => {
          const L = LEVEL[p.level] || LEVEL.attention;
          const go = PRIO_ACTION[p.reason_key] || "Open client";
          const attrs = p.client_id
            ? `data-client="${p.client_id}"${p.section ? ` data-section="${esc(p.section)}"` : ""}`
            : `data-goto="#/tasks"`;
          return `<button class="bd-prio" style="border-left-color:${L.rule};" ${attrs}
            title="${esc([p.title].concat(p.other_reasons || []).join(" "))}">
            <span class="bd-prio-dot" style="background:${L.dot};"></span>
            <span class="bd-prio-txt">
              <span class="bd-prio-n">${esc(p.client_name || "My tasks")}</span>
              <span class="bd-prio-d">${esc(p.title)}${p.also ? ` · and ${p.also} more` : ""}</span>
            </span>
            <span class="bd-prio-go">${esc(go)} ${icon("chevron", 13)}</span>
          </button>`;
        }).join("")
      : `<div class="bd-calm">
          <span class="bd-calm-e">✨</span>
          <span><span class="bd-calm-t">Caseload looking good</span>
          <span class="bd-calm-s">No expired authorizations, no overdue plans and no overdue tasks on this caseload.</span></span>
        </div>`;
    const urgent = rows.filter((p) => p.level === "action").length;
    return `<div class="bd-panel">
      <div class="bd-ph"><div>
        <h2 class="bd-pt">${icon("clock", 16)} Priority for you</h2>
        <p class="bd-pn">${rows.length
          ? `${urgent ? `<strong>${urgent} need${urgent === 1 ? "s" : ""} action now</strong> · ` : ""}ranked from your own client records — authorizations, plan deadlines and your tasks.`
          : "Ranked from your own client records — authorizations, plan deadlines and your tasks."}</p>
      </div></div>
      <div class="bd-body" style="padding:0;">${body}</div>
    </div>`;
  }

  // ================= authorizations =======================================
  function authPanel(d) {
    // Only the ones that need attention, closest first. A full list of every
    // authorization is the Authorization Alerts page; this is the short list a
    // BCBA acts on today.
    const rows = d.clients
      .filter((c) => c.auth_days !== null && c.auth_days <= 60)
      .sort((a, b) => a.auth_days - b.auth_days);
    const body = rows.length
      ? `<div class="bd-scroll"><table>
          <thead><tr>
            <th>Client</th><th>Payer</th><th>Auth Start</th><th>Auth End</th>
            <th>Days</th><th>Treatment Plan Due</th><th>Status</th>
          </tr></thead>
          <tbody>${rows.map((c) => `<tr>
            <td><button class="bd-link" data-client="${c.id}">${esc(c.child_name)}</button></td>
            <td>${esc(c.insurance_provider || "—")}</td>
            <td>${dayLabel(c.auth_start_date)}</td>
            <td><button class="bd-link" data-client="${c.id}" data-section="auth">${dayLabel(c.auth_expiration_date)}</button></td>
            <td>${c.auth_days}</td>
            <td>${c.treatment_plan_due_date ? dayLabel(c.treatment_plan_due_date) + " " + pill(c.tp_urgency) : "—"}</td>
            <td>${pill(c.auth_urgency)}</td>
          </tr>`).join("")}</tbody>
        </table></div>`
      : `<div class="bd-empty">No authorization on this caseload expires within 60 days.</div>`;

    return `<div class="bd-panel">
      <div class="bd-ph">
        <div><h2 class="bd-pt">${icon("clock", 16)} Authorizations Expiring Soon</h2>
          <p class="bd-pn">From the client's own authorization record — this is not a second copy.</p></div>
        <a class="bd-ql" href="#/auth-alerts">View All Authorizations</a>
      </div>
      <div class="bd-body">${body}</div>
    </div>`;
  }

  // ================= schedule =============================================
  function schedulePanel() {
    return `<div class="bd-panel" id="bd-sched">
      <div class="bd-ph">
        <div><h2 class="bd-pt">${icon("calendar", 16)} My Schedule <span style="font-weight:400; color:var(--text-muted);">(from Rethink)</span></h2>
          <p class="bd-pn">Read from Rethink, which is the source of truth for scheduling. The CRM never changes it.</p></div>
        <div class="bd-day">
          <button class="bd-db" data-month="prev">‹ Previous</button>
          <button class="bd-db" data-month="today">Today</button>
          <button class="bd-db" data-month="next">Next ›</button>
        </div>
      </div>
      <div class="bd-body" id="bd-sched-body"><div class="bd-empty">Loading the schedule…</div></div>
    </div>`;
  }

  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  function monthLabel(m) {
    const p = String(m || "").split("-");
    return p.length === 2 ? `${MONTH_NAMES[+p[1] - 1] || p[1]} ${p[0]}` : String(m);
  }
  function shiftMonth(m, by) {
    const [y, mo] = String(m).split("-").map(Number);
    const d = new Date(Date.UTC(y, mo - 1 + by, 1));
    return d.toISOString().slice(0, 7);
  }
  // Which weekday the 1st falls on, and how many days the month has. Done in
  // UTC against the date string so the grid cannot slip a day for somebody in
  // a different timezone than the server.
  function monthShape(m) {
    const [y, mo] = String(m).split("-").map(Number);
    return {
      firstDow: new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(),
      days: new Date(Date.UTC(y, mo, 0)).getUTCDate(),
    };
  }

  // ---- appointment categories -------------------------------------------
  // COLOUR IS DERIVED FROM WHAT RETHINK ACTUALLY SENT, and from nothing else.
  // scheduleRange() already passes through `service` (the first of cptCode,
  // serviceCode, appointmentType, serviceName that Rethink populated) and
  // `status`. If neither says anything recognisable the appointment is grey
  // and is labelled "Uncategorised" -- a guessed category on a clinical
  // calendar is worse than no category, and inventing a CPT code that Rethink
  // did not send would be worse still.
  //
  // The words come first and the colour second: every row names its service in
  // text, so the palette is a scanning aid rather than the only carrier.
  const APPT_CATS = [
    { key: "cancelled",  label: "Cancelled / no-show", color: "#dc2626" },
    { key: "assessment", label: "Assessment",          color: "#16a34a" },
    { key: "parent",     label: "Parent training",     color: "#7c3aed" },
    { key: "direct",     label: "Direct / supervision", color: "#2c4bb8" },
    { key: "clinical",   label: "Treatment plan / clinical work", color: "#d97706" },
    { key: "nonbillable", label: "Non-billable",       color: "#9ca3af" },
    { key: "other",      label: "Uncategorised",       color: "#c7c3d4" },
  ];
  const CAT_BY_KEY = {};
  APPT_CATS.forEach((c) => { CAT_BY_KEY[c.key] = c; });

  function apptCategory(r) {
    const status = String(r.status || "").toLowerCase();
    if (/cancel|no[-\s]?show|missed/.test(status)) return "cancelled";
    const svc = String(r.service || "").toLowerCase();
    if (!svc) return "other";
    // CPT first, because a code is unambiguous where a free-text name is not.
    if (/\b97151\b|\b97152\b|assessment|intake/.test(svc)) return "assessment";
    if (/\b97156\b|\b97157\b|parent|caregiver|family/.test(svc)) return "parent";
    if (/\b97153\b|\b97155\b|direct|supervis/.test(svc)) return "direct";
    if (/treatment plan|report|clinical|indirect/.test(svc)) return "clinical";
    if (/non[-\s]?billable|admin|travel|cancellation/.test(svc)) return "nonbillable";
    return "other";
  }
  const catColor = (key) => (CAT_BY_KEY[key] || CAT_BY_KEY.other).color;

  function legendHtml(rows) {
    // Only the categories that are actually on this month's calendar. A legend
    // listing six colours none of which are on screen is decoration.
    const present = new Set((rows || []).map(apptCategory));
    const shown = APPT_CATS.filter((c) => present.has(c.key));
    if (!shown.length) return "";
    return `<div class="bd-leg">${shown.map((c) =>
      `<span><i style="background:${c.color};"></i>${esc(c.label)}</span>`).join("")}</div>`;
  }

  const apptTime = (r) => {
    if (!r.start) return "—";
    const t = String(r.start).slice(11, 16) || String(r.start).slice(0, 5);
    const e = r.end ? (String(r.end).slice(11, 16) || String(r.end).slice(0, 5)) : "";
    return e ? `${t}–${e}` : t;
  };

  // The selected day's appointments, under the grid. Unchanged in substance
  // from the old day view -- the calendar is how you choose a day, not a
  // replacement for seeing what is on it.
  // The chosen day, as a readable agenda rather than a five-column table. The
  // substance is unchanged -- same fields, same source, same "not linked"
  // wording -- but a BCBA reads their day down the times, not across columns.
  function dayDetailHtml(rows, iso) {
    if (!rows.length) {
      return `<div class="bd-empty">No appointments in Rethink for ${esc(dayLabel(iso))}.</div>`;
    }
    const hours = rows.reduce((a, r) => a + (Number(r.duration_hours) || 0), 0);
    const shown = Math.round(hours * 10) / 10;
    return `<div style="border-top:1px solid #f0ece2;">
      <div style="padding:10px 15px 4px;">
        <div class="bd-ct" style="margin:0;">${esc(dayLabel(iso))}</div>
      </div>
      ${rows.map((r) => {
        const cat = apptCategory(r);
        return `<div class="bd-appt">
          <span class="bd-appt-bar" style="background:${catColor(cat)};" title="${esc((CAT_BY_KEY[cat] || {}).label || "")}"></span>
          <span class="bd-appt-t">${esc(apptTime(r))}</span>
          <span class="bd-appt-m">
            <span class="bd-appt-n">${r.client_id
              ? `<button class="bd-link" data-client="${r.client_id}">${esc(r.client_name)}</button>`
              : `<span style="color:#767488; font-weight:500;">Not linked to a CRM client</span>`}</span>
            <span class="bd-appt-s">${[r.service, r.location, r.status].filter(Boolean).map(esc).join(" &middot; ") || "Rethink sent no service or location for this appointment."}</span>
          </span>
        </div>`;
      }).join("")}
      <div class="bd-note">${rows.length} appointment${rows.length === 1 ? "" : "s"} from Rethink${
        // Only stated when Rethink actually gave durations. A day total of 0
        // because the field was empty is not a day with no hours on it.
        hours > 0 ? ` &middot; <strong>${shown} hour${shown === 1 ? "" : "s"}</strong> recorded` : ""}.</div>
    </div>`;
  }

  function calendarHtml(d) {
    const { firstDow, days } = monthShape(d.month);
    const byDate = new Map((d.days || []).map((c) => [c.date, c]));
    const t = todayStr();
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    const cells = [];
    // Leading blanks so the 1st lands under its real weekday.
    for (let i = 0; i < firstDow; i++) cells.push(`<div class="bd-cal-cell pad" aria-hidden="true"></div>`);
    for (let n = 1; n <= days; n++) {
      const iso = `${d.month}-${String(n).padStart(2, "0")}`;
      const c = byDate.get(iso) || { count: 0, hours: 0 };
      const cls = ["bd-cal-cell"];
      if (iso === t) cls.push("today");
      if (iso === scheduleDate) cls.push("sel");
      cells.push(`<button class="${cls.join(" ")}" data-cal-day="${iso}"
        aria-label="${esc(dayLabel(iso))}, ${c.count} appointment${c.count === 1 ? "" : "s"}"
        ${iso === scheduleDate ? 'aria-current="date"' : ""}>
        <span class="bd-cal-n">${n}</span>
        ${c.count ? `<span class="bd-cal-pill">${c.count}</span>` : ""}
        ${c.count && c.hours ? `<span class="bd-cal-h">${c.hours}h</span>` : ""}
        ${c.count ? `<span class="bd-cal-bars">${
          // One stripe per appointment, in the order they sit on the day, so
          // the shape of a day is legible without opening it.
          (c.rows || []).slice(0, 8).map((r) => `<i style="background:${catColor(apptCategory(r))};"></i>`).join("")
        }</span>` : ""}
      </button>`);
    }

    return `<div style="padding:4px 15px 12px;">
      <div class="bd-cal" role="grid" aria-label="${esc(monthLabel(d.month))} schedule">
        ${dow.map((x) => `<div class="bd-cal-dow">${x}</div>`).join("")}
        ${cells.join("")}
      </div>
      <div class="bd-cal-sum">${esc(monthLabel(d.month))} · ${d.total_appointments} appointment${d.total_appointments === 1 ? "" : "s"}${d.total_hours ? ` · ${d.total_hours}h` : ""} from Rethink.</div>
      </div>
      ${legendHtml((d.days || []).reduce((a, c) => a.concat(c.rows || []), []))}`;
  }

  // Redraws from what is already loaded -- no fetch. Used when the person
  // clicks a different day inside the open month.
  function paintSchedule() {
    const box = document.getElementById("bd-sched-body");
    if (!box || !monthData || !monthData.available) return;
    const cell = (monthData.days || []).find((c) => c.date === scheduleDate);
    box.innerHTML = calendarHtml(monthData)
      + (scheduleDate.slice(0, 7) === monthData.month ? dayDetailHtml((cell && cell.rows) || [], scheduleDate) : "");
  }

  async function fillSchedule() {
    const box = document.getElementById("bd-sched-body");
    if (!box) return;
    box.innerHTML = `<div class="bd-empty">Loading ${esc(monthLabel(scheduleMonth))}…</div>`;
    let d;
    const qs = "?month=" + encodeURIComponent(scheduleMonth) + (viewingEmail ? "&bcba=" + encodeURIComponent(viewingEmail) : "");
    try { d = await api("/api/caseload/schedule" + qs); }
    catch (e) { box.innerHTML = `<div class="bd-empty">Couldn't load the schedule: ${esc(e.message)}</div>`; return; }

    if (!d.available) {
      // Named, not blanked. A schedule panel that silently shows nothing is
      // indistinguishable from a month with no sessions.
      monthData = null;
      box.innerHTML = `<div class="bd-empty"><strong>${esc(monthLabel(d.month || scheduleMonth))}</strong><br/>${esc(d.reason || "The schedule is not available.")}</div>`;
      return;
    }
    monthData = d;
    // Opening a month that does not contain the selected day selects a day
    // inside it, so the detail below the grid is never about a month you are
    // not looking at: today if it falls here, otherwise the 1st.
    if (scheduleDate.slice(0, 7) !== d.month) {
      scheduleDate = todayStr().slice(0, 7) === d.month ? todayStr() : `${d.month}-01`;
    }
    paintSchedule();
  }

  // ================= caseload =============================================
  const FILTERS = [
    { key: "all", label: "All" },
    { key: "active", label: "In Therapy" },
    { key: "assessment_scheduling", label: "Assessment" },
    { key: "hold", label: "On Hold" },
    { key: "waitlist", label: "Waitlisted" },
  ];

  // The number on a stage button is how many clients are AT THAT STAGE, which
  // is what somebody reads it as. It deliberately ignores the health filter:
  // a count that changed every time a health segment was pressed would be
  // describing the screen rather than the caseload.
  function countFor(d, key) {
    if (!d || !Array.isArray(d.clients)) return null;
    const wasCase = caseFilter, wasHealth = healthFilter;
    caseFilter = key; healthFilter = "";
    const n = d.clients.filter(matchesFilter).length;
    caseFilter = wasCase; healthFilter = wasHealth;
    return n;
  }

  function matchesFilter(c) {
    // Health is a SECOND filter, not a sixth stage button: somebody wants "the
    // three that need action" without giving up "in therapy". The stage
    // filters below are untouched and still mean exactly what they meant.
    if (healthFilter && (!c.health || c.health.key !== healthFilter)) return false;
    if (caseFilter === "all") return true;
    if (caseFilter === "hold" || caseFilter === "waitlist") return c.waitlisted;
    if (caseFilter === "active") return c.stage === "active" && !c.waitlisted;
    return c.stage === caseFilter;
  }

  // ---- caseload health -------------------------------------------------
  const HEALTH = {
    action:    { dot: "#dc2626", label: "Action required", short: "Action" },
    attention: { dot: "#eab308", label: "Needs attention", short: "Attention" },
    ok:        { dot: "#16a34a", label: "On track",        short: "On track" },
  };

  // The dot explains itself. Colour alone is not a message somebody can act
  // on -- and for anyone who cannot separate the reds and greens it is not a
  // message at all -- so the reasons the server computed are the title text,
  // and the word is beside the dot on the wider layouts.
  function healthCell(c) {
    const h = c.health || { key: "ok", reasons: [] };
    const H = HEALTH[h.key] || HEALTH.ok;
    const why = (h.reasons || []).map((r) => r.text).join(" ") || "Nothing outstanding on this client.";
    return `<span class="bd-hcell" title="${esc(H.label + ". " + why)}">
      <span class="bd-dot" style="background:${H.dot};"></span>
      <span class="t" style="color:${H.dot};">${esc(H.short)}</span>
    </span>`;
  }

  function healthStrip(d) {
    const t = (d.summary && d.summary.health) || { ok: 0, attention: 0, action: 0 };
    const seg = (key, n) => {
      const H = HEALTH[key];
      const on = healthFilter === key;
      return `<button class="bd-hb ${on ? "on" : ""}" data-health="${key}"
        style="${on ? `border-color:${H.dot};` : ""}"
        aria-pressed="${on}">
        <span class="bd-dot" style="background:${H.dot};"></span><b>${n}</b> ${esc(H.label)}
      </button>`;
    };
    return `<div class="bd-health">
      ${seg("ok", t.ok)}${seg("attention", t.attention)}${seg("action", t.action)}
      ${healthFilter ? `<button class="bd-hb" data-health="">Clear</button>` : ""}
    </div>`;
  }

  function caseloadPanel(d) {
    const q = caseSearch.trim().toLowerCase();
    const rows = d.clients.filter(matchesFilter)
      .filter((c) => !q || String(c.child_name || "").toLowerCase().includes(q));

    const body = rows.length
      ? `<div class="bd-scroll"><table>
          <thead><tr>
            <th>Client</th><th>Health</th><th>Status</th><th>Payer</th><th>Auth End</th>
            <th>Treatment Plan Due</th><th>Student Analyst</th><th>Next Session</th>
          </tr></thead>
          <tbody>${rows.map((c) => `<tr>
            <td><button class="bd-link" data-client="${c.id}">${esc(c.child_name)}</button></td>
            <td>${healthCell(c)}</td>
            <td>${esc(stageLabel(c))}</td>
            <td>${esc(c.insurance_provider || "—")}</td>
            <td>${c.auth_expiration_date ? dayLabel(c.auth_expiration_date) + " " + pill(c.auth_urgency) : "—"}</td>
            <td>${c.treatment_plan_due_date
                  ? dayLabel(c.treatment_plan_due_date) + " " + pill(c.tp_urgency)
                  : c.plan_due_source === "stale"
                    ? `<span style="color:#767488;" title="The only plan date on record (${esc(c.plan_due_stale)}) is from before this authorization began, so it belongs to a finished cycle.">Not set</span>`
                    : "—"}</td>
            <td>${c.student_analyst
                  ? `<button class="bd-link" data-analyst="${esc(c.student_analyst)}">${esc(c.student_analyst)}</button>`
                  : `<span class="bd-pill" style="background:${TONES.yellow.soft}; color:${TONES.yellow.softFg};">Unassigned</span>`}</td>
            <td data-next="${c.id}" style="color:#767488;">—</td>
          </tr>`).join("")}</tbody>
        </table></div>`
      : `<div class="bd-empty">No clients match that filter.</div>`;

    return `<div class="bd-panel" id="bd-caseload">
      <div class="bd-ph">
        <div><h2 class="bd-pt">${icon("briefcase", 16)} My Caseload</h2>
          <p class="bd-pn">${d.clients.length} open client${d.clients.length === 1 ? "" : "s"}. Health is worked out from this client's own authorization, plan deadline, analyst and tasks — hover a dot for the reason.</p></div>
        <div class="bd-filters">
          ${FILTERS.map((f) => `<button class="bd-fb ${caseFilter === f.key ? "on" : ""}" data-filter="${f.key}">${esc(f.label)}${countFor(d, f.key) === null ? "" : ` (${countFor(d, f.key)})`}</button>`).join("")}
          <input class="bd-search" id="bd-case-search" placeholder="Search my clients…" value="${esc(caseSearch)}" />
          <button class="bd-db" id="bd-export">${icon("download", 14)} Export</button>
        </div>
      </div>
      <div style="padding:11px 15px; border-bottom:1px solid #f0ece2;">${healthStrip(d)}</div>
      <div class="bd-body">${body}</div>
    </div>`;
  }

  function stageLabel(c) {
    if (c.waitlisted) return "On hold / waitlisted";
    const map = {
      active: "In therapy", first_day_scheduled: "First day scheduled",
      assessment_scheduling: "Assessment", authorization: "Authorization pending",
      insurance_verification: "Insurance verification", clinical_screener: "Clinical screener",
      new_submission: "New submission",
    };
    return map[c.stage] || c.stage || "—";
  }

  // ================= student analysts =====================================
  function analystPanel(d) {
    const rows = d.analysts;
    const unassigned = d.summary.analysts.clients_without;
    const body = rows.length
      ? `<div class="bd-scroll"><table>
          <thead><tr><th>Student Analyst</th><th>Clients</th><th>Assigned Clients</th></tr></thead>
          <tbody>${rows.map((a) => `<tr>
            <td><button class="bd-link" data-analyst="${esc(a.name)}">${esc(a.name)}</button></td>
            <td>${a.clients.length}</td>
            <td>${a.clients.map((c) => `<button class="bd-link" data-client="${c.id}" style="font-weight:400;">${esc(c.child_name)}</button>`).join(", ")}</td>
          </tr>`).join("")}</tbody>
        </table></div>`
      : `<div class="bd-empty">No Student Analyst is assigned to any client on this caseload yet.</div>`;
    return `<div class="bd-panel" id="bd-analysts">
      <div class="bd-ph"><div>
        <h2 class="bd-pt">${icon("cap", 16)} My Student Analysts</h2>
        <p class="bd-pn">From each client's own record — BCBA → Client → Student Analyst, not a separate caseload.</p>
      </div></div>
      <div class="bd-body">${body}</div>
      ${unassigned ? `<div class="bd-warn">${unassigned} client${unassigned === 1 ? " has" : "s have"} no Student Analyst assigned.</div>` : ""}
    </div>`;
  }

  function analystDrawer(name) {
    const a = (data.analysts || []).find((x) => x.name === name);
    const clients = a ? a.clients : (data.clients || []).filter((c) => c.student_analyst === name)
      .map((c) => ({ id: c.id, child_name: c.child_name }));
    const back = document.createElement("div");
    back.className = "bd-drawer-back";
    back.innerHTML = `<div class="bd-drawer">
      <button class="bd-x" id="bd-drawer-x">✕</button>
      <h2 style="margin:0 0 2px; font-size:17px; color:#1b2a6b;">${esc(name)}</h2>
      <p style="margin:0 0 14px; font-size:12px; color:#767488;">Student Analyst${a && a.email ? " · " + esc(a.email) : ""}</p>
      <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#767488; margin-bottom:6px;">Supervisor / BCBA</div>
      <div style="font-size:13px; margin-bottom:14px;">${esc(data.bcba.name || "—")}</div>
      <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#767488; margin-bottom:6px;">Clients under this BCBA</div>
      <div style="font-size:13px; margin-bottom:14px;">${
        clients.length ? clients.map((c) => `<div style="padding:4px 0; border-bottom:1px solid #f6f3ec;"><button class="bd-link" data-client="${c.id}">${esc(c.child_name)}</button></div>`).join("")
                       : "<span style='color:#767488;'>None</span>"}</div>
      ${supervisionForAnalyst(name)}
      <p style="font-size:11.5px; color:#767488; margin-top:16px;">Fieldwork and supervision detail live in the RBT Supervision tracker.
        <a class="bd-link" href="#/supervision">Open the tracker</a>.</p>
    </div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelector("#bd-drawer-x").addEventListener("click", close);
    back.querySelectorAll("[data-client]").forEach((b) => b.addEventListener("click", () => {
      close(); openClient(b.dataset.client);
    }));
  }

  // Only what the supervision tracker actually recorded. No fieldwork figure is
  // shown when none exists, rather than a zero that reads as "none completed".
  function supervisionForAnalyst(name) {
    const sup = data.supervision && data.supervision.rows
      ? data.supervision.rows.find((r) => String(r.name || "").toLowerCase() === String(name).toLowerCase())
      : null;
    if (!sup) return `<div style="font-size:12.5px; color:#767488;">No supervision recorded for this person this month.</div>`;
    return `<div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#767488; margin-bottom:6px;">This month's supervision</div>
      <div style="font-size:13px;">${sup.supervision_hours == null ? "—" : sup.supervision_hours} of ${sup.worked_hours == null ? "—" : sup.worked_hours} worked hours${
        sup.percent == null ? "" : ` · ${sup.percent}%`}${sup.signed_off ? " · signed off" : ""}</div>`;
  }

  // ================= tasks =================================================
  // THE REAL TASK CENTER, not a second task list. Replacing the generic
  // dashboard for the clinical role took the Task Center away from every BCBA
  // -- its Completed tab and its reopen have no equivalent here -- so this
  // mounts the shell's own one. The fallback below only draws if the shell did
  // not load, and says what it is.
  function taskCenterPanel() {
    if (typeof window.__taskCenterHtml === "function") {
      return '<div class="bd-tc">' + window.__taskCenterHtml({ marginTop: "0" }) + "</div>";
    }
    return "";
  }

  function tasksPanel(d) {
    const order = { overdue: 0, today: 1, week: 2, later: 3 };
    const rows = (d.tasks || []).slice().sort((a, b) => (order[a.bucket] - order[b.bucket]) || String(a.due_date || "").localeCompare(String(b.due_date || "")));
    const tone = { overdue: "darkred", today: "red", week: "orange", later: "grey" };
    const label = { overdue: "Overdue", today: "Due today", week: "This week", later: "Later" };
    const body = rows.length
      ? `<div class="bd-scroll"><table>
          <thead><tr><th>Task</th><th>Client</th><th>Due</th><th></th><th></th></tr></thead>
          <tbody>${rows.map((t) => {
            const tn = TONES[tone[t.bucket]] || TONES.grey;
            return `<tr>
              <td><strong>${esc(t.title)}</strong>${t.description ? `<div style="color:#767488; font-size:11.5px;">${esc(t.description)}</div>` : ""}</td>
              <td>${t.client_id ? `<button class="bd-link" data-client="${t.client_id}">${esc(t.client_name || "Client")}</button>` : "—"}</td>
              <td>${t.due_date ? dayLabel(t.due_date) : "—"}</td>
              <td><span class="bd-pill" style="background:${tn.soft}; color:${tn.softFg};">${label[t.bucket]}</span></td>
              <td style="text-align:right;"><button class="bd-db" data-done="${t.id}">Mark done</button></td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>`
      : `<div class="bd-empty">Nothing outstanding. </div>`;
    return `<div class="bd-panel">
      <div class="bd-ph"><div>
        <h2 class="bd-pt">${icon("checkbox", 16)} My Tasks</h2>
        <p class="bd-pn">From Tasks &amp; Alerts — the same tasks, not a copy.</p>
      </div><a class="bd-ql" href="#/tasks">Open Tasks &amp; Alerts</a></div>
      <div class="bd-body">${body}</div>
    </div>`;
  }

  // ================= clinical wins ========================================
  // Milestones a clinician RECORDED in Client Programming, on this BCBA's own
  // clients. Read from client_milestones and nowhere else: nothing here is
  // inferred, and Rethink exposes no mastery data to infer it from -- the
  // endpoint probe established that, which is why milestones are recorded by
  // a person in the first place.
  //
  // INTERNAL. The parent-facing side of a milestone is the celebration email,
  // and this panel neither sends nor re-sends one.
  function winsPanel(d) {
    const w = d.wins || { rows: [], week_count: 0, available: true };
    const body = !w.available
      ? `<div class="bd-empty">Clinical wins could not be read just now.</div>`
      : w.rows.length
        ? w.rows.map((r) => `<div class="bd-win">
            <span class="bd-win-e">${r.event_type === "mastery" ? "🏆" : "🌟"}</span>
            <span>
              <span class="bd-win-n"><button class="bd-link" data-client="${r.client_id}" data-section="programming">${esc(r.client_name)}</button>
                — ${r.event_type === "mastery" ? "mastered" : "reached a treatment milestone"}${
                  r.program ? ` <strong>${esc(r.program)}</strong>` : ""}</span>
              <span class="bd-win-d">${esc(dayLabel(r.achieved_at))}</span>
            </span>
          </div>`).join("")
        : `<div class="bd-calm">
            <span class="bd-calm-e">🌱</span>
            <span><span class="bd-calm-t" style="color:#1b2a6b;">No milestones recorded yet</span>
            <span class="bd-calm-s">Wins appear here as soon as a clinician records one in a client's Client Programming section.</span></span>
          </div>`;
    return `<div class="bd-panel">
      <div class="bd-ph"><div>
        <h2 class="bd-pt">🌟 Clinical wins</h2>
        <p class="bd-pn">${w.week_count
          ? `<strong>${w.week_count} recorded in the last 7 days</strong> across your caseload. `
          : ""}From Client Programming — recorded by a clinician, never inferred.</p>
      </div></div>
      <div class="bd-body" style="padding:0;">${body}</div>
    </div>`;
  }

  // ================= recent clinical activity =============================
  // Three things that are genuinely written down against a client, each read
  // from the table that owns it. A source that cannot be read contributes
  // nothing rather than a placeholder row.
  const ACT_ICON = { mastery: "🏆", milestone: "🌟", programming: "📋", task: "✓" };

  function activityPanel(d) {
    const rows = d.activity || [];
    const body = rows.length
      ? rows.map((a) => `<div class="bd-act">
          <span>${ACT_ICON[a.kind] || "•"}</span>
          <span class="bd-act-w">${esc(a.what)}${a.detail ? ` — ${esc(a.detail)}` : ""}
            ${a.client_id ? `· <button class="bd-link" data-client="${a.client_id}" style="font-weight:600;">${esc(a.client_name)}</button>` : ""}
            ${a.who ? `<span style="color:#8b8798;"> · ${esc(a.who)}</span>` : ""}
            ${a.note ? `<span style="color:#16a34a;"> · ${esc(a.note)}</span>` : ""}</span>
          <span class="bd-act-t">${a.at ? esc(dayLabel(String(a.at).slice(0, 10))) : ""}</span>
        </div>`).join("")
      : `<div class="bd-empty">Nothing recorded against your clients in the last 30 days.</div>`;
    return `<div class="bd-panel">
      <div class="bd-ph"><div>
        <h2 class="bd-pt">${icon("doc", 16)} Recent clinical activity</h2>
        <p class="bd-pn">Milestones, programming supervision notes and completed tasks on your caseload — each from the record that owns it.</p>
      </div></div>
      <div class="bd-body" style="padding:0;">${body}</div>
    </div>`;
  }

  // ================= supervision ==========================================
  function supervisionPanel(d) {
    const s = d.supervision || { rows: [] };
    const tone = { below: "red", no_hours: "orange", no_supervision: "orange", ok: "none" };
    const label = { below: "Below requirement", no_hours: "No worked hours", no_supervision: "No supervision logged", ok: "On track" };
    const body = s.rows && s.rows.length
      ? `<div class="bd-scroll"><table>
          <thead><tr><th>RBT</th><th>Worked Hours</th><th>Supervision</th><th>Percentage</th><th>Status</th></tr></thead>
          <tbody>${s.rows.map((r) => {
            const tn = TONES[tone[r.status]] || TONES.grey;
            return `<tr>
              <td><strong>${esc(r.name)}</strong>${r.role_title ? `<div style="color:#767488; font-size:11.5px;">${esc(r.role_title)}</div>` : ""}</td>
              <td>${r.worked_hours == null || r.worked_hours === 0 ? "—" : r.worked_hours}</td>
              <td>${r.supervision_hours == null ? "—" : r.supervision_hours}</td>
              <td>${r.percent == null ? "—" : r.percent + "%"}</td>
              <td><span class="bd-pill" style="background:${tn.soft}; color:${tn.softFg};">${label[r.status] || "—"}</span>${r.signed_off ? ` <span style="font-size:11px; color:#767488;">signed</span>` : ""}</td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>
        <div class="bd-note">${esc(s.month)} · list derived from ${esc(s.derived || "")}. The RBT Supervision tracker is the full record.</div>`
      // A compact line rather than an empty card the height of a table. The
      // sentence is the same one it always showed -- including how the list
      // would be derived if there were one, which is the part that stops
      // "nothing here" reading as "the tracker is broken".
      : `<div class="bd-note" style="border-top:0;">No supervision responsibilities recorded for you${s.derived ? " — " + esc(s.derived) + "." : "."}</div>`;

    // A summary of rows that already exist, counted -- NOT a second
    // compliance calculation. Every status here was decided by the RBT
    // Supervision tracker and passed through; this only tallies them, which
    // is why it cannot drift from the tracker.
    const rs = s.rows || [];
    const okN = rs.filter((r) => r.status === "ok").length;
    const badN = rs.length - okN;
    const strip = rs.length ? `<div class="bd-sup">
      <div><div class="bd-sup-n">${rs.length}</div><div class="bd-sup-l">RBTs</div></div>
      <div><div class="bd-sup-n" style="color:#16a34a;">${okN}</div><div class="bd-sup-l">On track</div></div>
      <div><div class="bd-sup-n" style="color:${badN ? "#b45309" : "#8b8798"};">${badN}</div><div class="bd-sup-l">Need attention</div></div>
      <div style="margin-left:auto; font-size:11.5px; color:#767488;">${esc(s.month || "")}${
        s.min_pct != null ? ` · ${s.min_pct}% required` : ""}</div>
    </div>` : "";

    return `<div class="bd-panel">
      <div class="bd-ph"><div>
        <h2 class="bd-pt">${icon("people", 16)} Supervision</h2>
        <p class="bd-pn">Figures come from the RBT Supervision tracker, not recalculated here.</p>
      </div><a class="bd-ql" href="#/supervision">Open RBT Supervision</a></div>
      ${strip}
      <div class="bd-body">${body}</div>
    </div>`;
  }

  // ================= quick links ==========================================
  function quickLinks() {
    const links = [
      ["Treatment Plan Cheat Sheet", "#/bcba-hub", "doc"],
      ["Form Library", "#/bcba-hub", "briefcase"],
      ["Programming / BIP", "#/client-behavior", "checkbox"],
      ["RBT Supervision", "#/supervision", "people"],
      ["Policies & SOPs", "#/policies", "doc"],
      ["Billable Requirements", "#/billable", "chart"],
    ];
    // Six full-width rows became six tiles. Same destinations, same order,
    // about a third of the vertical space -- this sits at the bottom of the
    // page and was taking as much room as the caseload.
    return `<div class="bd-panel">
      <div class="bd-ph"><div><h2 class="bd-pt">${icon("link", 16)} Quick Links</h2></div></div>
      <div class="bd-tiles-l">${links.map(([l, h, ic]) => `
        <a class="bd-lt" href="${h}">
          <span class="bd-mark" style="width:26px; height:26px; border-radius:8px; background:#eef1fb; color:#2c4bb8;">${icon(ic, 14)}</span>
          <span>${esc(l)}</span>
        </a>`).join("")}</div>
    </div>`;
  }

  // ================= render ===============================================
  function render() {
    const d = data;
    const other = !d.bcba.is_self;
    // ORDER IS THE DESIGN. First screen: what needs attention, and how am I
    // doing. Then the work itself -- schedule and caseload. Then the things
    // worth knowing but not worth interrupting for. The panels are the same
    // panels; what changed is which one a BCBA meets first.
    mountEl.innerHTML = `<div class="bd">
      <div class="bd-head">
        <div>
          <h1 class="bd-hello">${esc(greeting())}, ${esc(firstName(d.bcba.name))}.</h1>
          <p class="bd-sub">Here's what needs your attention today.</p>
        </div>
        <div class="bd-headmeta">
          <div>${esc(longDate())}</div>
        </div>
        ${d.can_pick ? `<div class="bd-day">
          <label style="font-size:11.5px; color:#767488;">Viewing</label>
          <select id="bd-pick" class="bd-search" style="max-width:220px;"></select>
        </div>` : ""}
      </div>
      ${other ? `<div class="bd-panel"><div class="bd-warn" style="border-top:0;">You are viewing <strong>${esc(d.bcba.name)}</strong>'s caseload.</div></div>` : ""}
      ${cards(d)}
      ${priorityPanel(d)}
      <div id="bd-progression" style="display:none;"></div>
      ${taskCenterPanel() || tasksPanel(d)}
      ${schedulePanel()}
      ${caseloadPanel(d)}
      <div class="bd-two">
        ${winsPanel(d)}
        ${activityPanel(d)}
      </div>
      ${authPanel(d)}
      ${analystPanel(d)}
      ${supervisionPanel(d)}
      ${quickLinks()}
    </div>`;
    wire();
    if (typeof window.__fillTaskCenter === "function") {
      try { window.__fillTaskCenter(mountEl); } catch (e) { /* the shell owns its own errors */ }
    }
    fillSchedule();
    fillNextSessions();
    // The Clinical Director's Staff Progression widget. It owns its own fetch
    // and permission: the server answers 403 for anybody who is not clinical
    // leadership or HR, and the slot stays hidden.
    if (typeof window.__fillStaffProgression === "function") {
      try { window.__fillStaffProgression(mountEl.querySelector("#bd-progression")); } catch (e) { /* the widget owns its own errors */ }
    }
  }

  function openClient(id) {
    if (typeof openClientModal === "function") openClientModal(Number(id));
    else location.hash = "#/pipeline";
  }

  function wire() {
    mountEl.querySelectorAll("[data-client]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      openClient(b.dataset.client);
    }));
    mountEl.querySelectorAll("[data-analyst]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      analystDrawer(b.dataset.analyst);
    }));
    mountEl.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
      caseFilter = b.dataset.filter; render();
    }));
    // The health segments filter the caseload table that is already on the
    // page. Pressing the one that is on turns it off, which is what a toggle
    // that looks pressed has to do.
    mountEl.querySelectorAll("[data-health]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.health;
      healthFilter = (!k || healthFilter === k) ? "" : k;
      render();
      const panel = mountEl.querySelector("#bd-caseload");
      if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    mountEl.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => {
      location.hash = b.dataset.goto;
    }));
    // Scroll targets are named, not counted. The old fallback was
    // ".bd-panel:nth-of-type(3)", which meant reordering the page silently
    // sent every tile to the wrong panel.
    const GO_TARGET = { analysts: "#bd-analysts", caseload: "#bd-caseload", schedule: "#bd-sched" };
    mountEl.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.go === "auth") { location.hash = "#/auth-alerts"; return; }
      const el = document.querySelector(GO_TARGET[b.dataset.go] || "#bd-caseload");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    mountEl.querySelectorAll("[data-month]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.month;
      if (k === "today") { scheduleMonth = todayStr().slice(0, 7); scheduleDate = todayStr(); }
      else scheduleMonth = shiftMonth(scheduleMonth, k === "next" ? 1 : -1);
      fillSchedule();
    }));
    // Day cells are delegated from the panel body rather than bound per cell:
    // the grid is redrawn on every month change and on every selection, so
    // handlers bound to the old cells would be gone by the second click.
    const schedBody = document.getElementById("bd-sched-body");
    if (schedBody && !schedBody.dataset.calWired) {
      schedBody.dataset.calWired = "1";
      schedBody.addEventListener("click", (ev) => {
        const cell = ev.target.closest("[data-cal-day]");
        if (!cell || !schedBody.contains(cell)) return;
        scheduleDate = cell.dataset.calDay;
        paintSchedule();
      });
    }
    mountEl.querySelectorAll("[data-done]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("/api/staff-tasks/" + b.dataset.done, { method: "PATCH", body: { status: "done" } });
        await load();
      } catch (e) { b.disabled = false; b.textContent = e.message; }
    }));
    const exportBtn = mountEl.querySelector("#bd-export");
    if (exportBtn) exportBtn.addEventListener("click", () => exportCaseload());

    const search = mountEl.querySelector("#bd-case-search");
    if (search) {
      search.addEventListener("input", () => {
        caseSearch = search.value;
        const at = search.selectionStart;
        render();
        const again = mountEl.querySelector("#bd-case-search");
        if (again) { again.focus(); again.setSelectionRange(at, at); }
      });
    }
    const pick = mountEl.querySelector("#bd-pick");
    if (pick) fillPicker(pick);
  }

  async function fillPicker(sel) {
    let d;
    try { d = await api("/api/caseload/bcbas"); } catch (e) { return; }
    const me = (state.user && state.user.name) || "";
    sel.innerHTML = `<option value="">${esc(me)} (me)</option>` +
      (d.bcbas || []).map((b) => `<option value="${esc(b.email || b.name)}"${
        (viewingEmail && (b.email === viewingEmail || b.name === viewingEmail)) ? " selected" : ""
      }>${esc(b.name)} (${b.clients})</option>`).join("");
    sel.addEventListener("change", () => { viewingEmail = sel.value || null; load(); });
  }

  // Next sessions are fetched separately, AFTER the page is drawn, so a slow or
  // unreachable Rethink delays one column rather than the whole dashboard.
  async function fillNextSessions() {
    if (!data || !data.clients.length) return;
    let d;
    const qs = "?date=" + encodeURIComponent(todayStr()) + (viewingEmail ? "&bcba=" + encodeURIComponent(viewingEmail) : "");
    try { d = await api("/api/caseload/schedule" + qs); } catch (e) { return; }
    if (!d.available) return;
    const byClient = new Map();
    (d.rows || []).forEach((r) => {
      if (!r.client_id) return;
      const cur = byClient.get(r.client_id);
      if (!cur || String(r.start || "") < String(cur.start || "")) byClient.set(r.client_id, r);
    });
    mountEl.querySelectorAll("[data-next]").forEach((td) => {
      const r = byClient.get(Number(td.dataset.next));
      if (!r) return;
      const t = r.start ? (String(r.start).slice(11, 16) || String(r.start).slice(0, 5)) : "Today";
      td.textContent = "Today " + t;
      td.style.color = "";
    });
  }

  // The rows currently on screen, as a CSV. Built in the browser from data the
  // page already has: no new endpoint, and no way for this to hand out a client
  // the viewer could not already see.
  function exportCaseload() {
    if (!data) return;
    const q = caseSearch.trim().toLowerCase();
    const rows = data.clients.filter(matchesFilter)
      .filter((c) => !q || String(c.child_name || "").toLowerCase().includes(q));
    const cell = (v) => {
      const t = v == null ? "" : String(v);
      return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    // The export follows the table: it exports what is on screen, including
    // the health column and -- the part a spreadsheet is actually useful for
    // -- the REASONS, which a coloured dot cannot carry into a CSV.
    const head = ["Client", "Health", "Why", "Status", "Payer", "Auth End", "Treatment Plan Due", "Student Analyst"];
    const body = rows.map((c) => {
      const h = c.health || { key: "ok", reasons: [] };
      return [
        c.child_name, (HEALTH[h.key] || HEALTH.ok).label,
        (h.reasons || []).map((r) => r.text).join(" "),
        stageLabel(c), c.insurance_provider || "",
        c.auth_expiration_date || "", c.treatment_plan_due_date || "", c.student_analyst || "Unassigned",
      ].map(cell).join(",");
    });
    const csv = [head.join(","), ...body].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "caseload-" + todayStr() + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function load() {
    let d;
    try {
      d = await api("/api/caseload/dashboard" + (viewingEmail ? "?bcba=" + encodeURIComponent(viewingEmail) : ""));
    } catch (e) {
      mountEl.innerHTML = `<div class="bd"><div class="bd-panel"><div class="bd-empty">Couldn't load your caseload: ${esc(e.message)}</div></div></div>`;
      return;
    }
    data = d;
    render();
  }

  // Shared with the migration screen below, which uses the same stylesheet and
  // may be opened without the dashboard ever having drawn.
  window.__bdInjectStyles = injectStyles;

  window.__renderBcbaDashboard = async function (mount) {
    injectStyles();
    mountEl = mount;
    mount.innerHTML = `<div class="bd"><div class="bd-panel"><div class="bd-empty">Loading your caseload…</div></div></div>`;
    await load();
  };
})();

// ============================================================================
// THE ONE-TIME ASSIGNMENT MIGRATION
// ============================================================================
// Paste the sheet, see exactly what would change, then apply it. Two properties
// this screen exists to guarantee:
//
//   * NOTHING IS WRITTEN UNTIL YOU PRESS APPLY, and what is written is what the
//     preview showed. The server re-plans from the same text on apply rather
//     than trusting a plan posted back from here, so the review rules are
//     enforced rather than advisory.
//   * AN ASSIGNMENT THE CRM ALREADY HOLDS IS NEVER OVERWRITTEN. A difference
//     between the sheet and the CRM goes on the review table, because the CRM
//     may well be the newer answer.
//
// It is deliberately not a connector. Nothing re-reads the sheet later, and
// after this runs the CRM is the source of truth for these assignments.
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
    if (!res.ok) throw new Error(d.error || "Request failed");
    return d;
  }

  const ISSUE_TONE = {
    "Client not found": "#7f1d1d",
    "Multiple client matches": "#7f1d1d",
    "BCBA not found": "#9a3412",
    "Needs Student Analyst Match": "#9a3412",
    "Squad Leader not found": "#9a3412",
    "Existing assignment differs": "#854d0e",
    "Existing date differs": "#854d0e",
    "Sheet problem": "#854d0e",
  };

  function reviewTable(rows) {
    if (!rows.length) return `<div class="bd-empty">Nothing needs review.</div>`;
    return `<div class="bd-scroll"><table>
      <thead><tr>
        <th>Spreadsheet Client</th><th>CRM Match</th><th>Spreadsheet BCBA</th>
        <th>CRM BCBA</th><th>Student Analyst</th><th>Issue</th><th>Action</th>
      </tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><strong>${esc(r.sheet_client)}</strong></td>
        <td>${esc(r.crm_client || "—")}</td>
        <td>${esc(r.sheet_bcba || "—")}</td>
        <td>${esc(r.crm_bcba || "—")}</td>
        <td>${esc(r.sheet_analyst || "—")}</td>
        <td><span style="color:${ISSUE_TONE[r.issue] || "#4b5563"}; font-weight:700;">${esc(r.issue)}</span>
            ${r.detail ? `<div style="color:#767488; font-size:11.5px;">${esc(r.detail)}</div>` : ""}</td>
        <td style="color:#767488;">Nothing was changed — decide on the client's card.</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  }

  function planTable(plan) {
    if (!plan.length) return `<div class="bd-empty">No client needs a change.</div>`;
    return `<div class="bd-scroll"><table>
      <thead><tr><th>CRM Client</th><th>From the spreadsheet</th><th>What will change</th></tr></thead>
      <tbody>${plan.map((p) => `<tr>
        <td><strong>${esc(p.crm_client)}</strong></td>
        <td style="color:#767488;">${esc(p.sheet_client)}</td>
        <td>${p.notes.map((n) => `<div>${esc(n)}</div>`).join("")}</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  }

  let mountEl = null, sheetText = "";

  function shell(inner) {
    mountEl.innerHTML = `<div class="bd">
      <div class="bd-head"><div>
        <h1 class="bd-hello">BCBA &amp; Student Analyst Assignments</h1>
        <p class="bd-sub">A one-time cleanup from the assignments spreadsheet. Nothing here runs again on its own.</p>
      </div><a class="bd-ql" href="#/admin">Back to Admin Settings</a></div>
      ${inner}
    </div>`;
  }

  function start(message) {
    shell(`<div class="bd-panel">
      <div class="bd-ph"><div>
        <h2 class="bd-pt">Paste the spreadsheet</h2>
        <p class="bd-pn">Select the rows in the sheet — including the header row — and paste them here. The squad-leader table underneath can be pasted with them.</p>
      </div></div>
      <div style="padding:14px 15px;">
        <textarea id="mig-text" rows="10" style="width:100%; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px;"
          placeholder="Client Name	BCBA	Insurance	Auth Start	Auth End	Treatment Plan Due	Tx Updates	Student Analyst	Schedule"></textarea>
        <div style="margin-top:10px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="bd-ql" id="mig-preview" style="background:#1b2a6b; color:#fff; border-color:#1b2a6b; cursor:pointer;">Preview the changes</button>
          <span id="mig-msg" style="font-size:12.5px; color:#a3282e;">${esc(message || "")}</span>
        </div>
      </div>
      <div class="bd-note">Nothing is written until you review the preview and press Apply.</div>
    </div>
    <div id="mig-dupes"></div>`);
    const ta = document.getElementById("mig-text");
    if (sheetText) ta.value = sheetText;
    document.getElementById("mig-preview").addEventListener("click", async () => {
      sheetText = ta.value;
      if (!sheetText.trim()) { document.getElementById("mig-msg").textContent = "Paste the sheet first."; return; }
      await preview();
    });
    renderDuplicates();
  }

  // Every name as it is actually stored, with its caseload count, and a merge
  // an admin drives themselves.
  //
  // THIS IS THE PART THAT MAKES THE PANEL HONEST. The matching above only
  // recognises two shapes, so it will keep missing real duplicates -- and the
  // failure mode of a detector that finds nothing is that it says so, which
  // reads as "there is no problem" to somebody looking straight at one. The
  // roster shows what is on file whether or not anything was matched: two rows
  // that look identical on screen ARE two different strings, and seeing them
  // side by side with their counts is usually the whole diagnosis.
  function rosterBlock(r) {
    const opts = (sel) => r.names.map((n) =>
      `<option value="${esc(n.name)}">${esc(n.name)} — ${n.clients} client${n.clients === 1 ? "" : "s"}</option>`).join("");
    return `<div style="padding:13px 15px; border-top:1px solid #eceaf6;">
      <div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#6b6a86; margin-bottom:7px;">
        ${esc(r.label)} — every name on file (${r.names.length})
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:11px;">
        ${r.names.map((n) => `<span style="background:#f4f3fa; border:1px solid #e4e2f0; border-radius:999px; padding:3px 10px; font-size:12.5px;">
          ${esc(n.name)} <span style="color:#6b6a86;">${n.clients}</span></span>`).join("")}
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12.5px;">
        <span>Move everyone filed under</span>
        <select data-mm-from="${esc(r.field)}" style="max-width:220px;">${opts()}</select>
        <span>onto</span>
        <select data-mm-to="${esc(r.field)}" style="max-width:220px;">${opts()}</select>
        <button class="bd-ql" data-manual-merge="${esc(r.field)}" style="cursor:pointer;">Merge</button>
      </div>
      <div data-mm-msg="${esc(r.field)}" style="font-size:12px; margin-top:6px;"></div>
    </div>`;
  }

  // ---- one person filed under two spellings ------------------------------
  //
  // assigned_bcba_name and the two beside it are free text, so the same person
  // ends up as "Marissa" on some clients and "Marissa Gaut" on others -- and
  // the caseload picker, which groups by that string, shows her twice with her
  // clients split between the halves.
  async function renderDuplicates() {
    const box = document.getElementById("mig-dupes");
    if (!box) return;
    let d;
    try { d = await api("/api/caseload/name-duplicates"); }
    catch (e) { box.innerHTML = ""; return; }
    const all = d.duplicates || [];
    const rosters = (d.rosters || []).filter((r) => (r.names || []).length);
    const sure = all.filter((x) => x.confident);
    const unsure = all.filter((x) => !x.confident);

    // Three shapes end up here: a merge we are sure of, a short name that could
    // be one of several people, and a group who merely share a first name --
    // which is a question, never a proposal.
    const row = (x, i) => `<div style="padding:12px 15px; border-top:1px solid #eceaf6;">
      <div style="display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap;">
        <div style="min-width:0; flex:1;">
          ${x.group ? x.group.map((g) => `<div><strong>${esc(g.name)}</strong>
            <span style="color:#6b6a86;"> &mdash; ${g.clients} client${g.clients === 1 ? "" : "s"}</span></div>`).join("")
          : `<strong>${esc(x.from)}</strong>
          <span style="color:#6b6a86;"> (${x.from_clients} client${x.from_clients === 1 ? "" : "s"})</span>`}
          ${x.to ? ` &rarr; <strong>${esc(x.to)}</strong>
            <span style="color:#6b6a86;"> (${x.to_clients} client${x.to_clients === 1 ? "" : "s"})</span>` : ""}
          <div style="font-size:12px; color:#6b6a86; margin-top:3px;">${esc(x.label)} &middot; ${esc(x.reason)}</div>
          ${x.candidates && !x.group ? `<div style="font-size:12px; color:#a3282e; margin-top:3px;">Could be: ${x.candidates.map(esc).join(", ")}</div>` : ""}
        </div>
        ${x.to ? `<button class="bd-ql" data-merge="${i}" style="cursor:pointer;">Merge into ${esc(x.to)}</button>` : ""}
      </div>
      <div class="bd-err" data-merge-msg="${i}" style="font-size:12px; color:#a3282e; margin-top:6px;"></div>
    </div>`;

    box.innerHTML = `<div class="bd-panel" style="margin-top:16px;">
      <div class="bd-ph"><div><h2 class="bd-pt">Staff filed under two names</h2>
      <p class="bd-pn">The BCBA, Student Analyst and Squad Leader on a client are typed in by hand, so one person can end up spelled two ways &mdash; which is why they appear twice on the caseload list with their clients split between them. Merging rewrites the name on those clients; nothing else about the record changes.</p>
      </div></div>
      ${sure.length ? sure.map((x) => row(x, all.indexOf(x))).join("") : ""}
      ${unsure.length ? `<div class="bd-note" style="border-top:1px solid #eceaf6;">
        These need a person to decide, so no merge is offered automatically:
      </div>${unsure.map((x) => row(x, all.indexOf(x))).join("")}` : ""}
      ${!all.length ? `<div class="bd-note" style="border-top:1px solid #eceaf6;">
        Nothing matched the patterns this looks for &mdash; a name that is another one shortened,
        or the same name spelled with different spacing. That is not the same as saying there is no
        duplicate: a surname typed two ways, a middle initial, or a slip in the spelling all read as
        two different people here. <strong>If somebody is appearing twice on the caseload board, they
        are below, spelled two ways.</strong>
      </div>` : ""}
      ${rosters.map(rosterBlock).join("")}
    </div>`;

    box.querySelectorAll("[data-manual-merge]").forEach((b) => b.addEventListener("click", async () => {
      const field = b.getAttribute("data-manual-merge");
      const from = box.querySelector(`[data-mm-from="${field}"]`).value;
      const to = box.querySelector(`[data-mm-to="${field}"]`).value;
      const msg = box.querySelector(`[data-mm-msg="${field}"]`);
      msg.style.color = "#a3282e";
      if (!from || !to) { msg.textContent = "Pick both names."; return; }
      if (from === to) { msg.textContent = "Those are the same name — pick the wrong spelling on the left and the right one on the right."; return; }
      // Merging is a rewrite across client records and there is no undo, so the
      // names are read back before it happens. A merge of the wrong two people
      // is far more work to unpick than this prompt is to read.
      if (!confirm(`Move every client filed under "${from}" onto "${to}"?

This rewrites the name on those client records. It cannot be undone from here.`)) return;
      b.disabled = true;
      try {
        const r = await api("/api/caseload/merge-name", { method: "POST", body: { field, from, to } });
        msg.style.color = "#1c6b45";
        msg.textContent = `Moved ${r.moved} client${r.moved === 1 ? "" : "s"} onto ${r.to}. ${r.now_on} now filed under that name${r.email_applied ? `, email ${r.email_applied}` : ""}.`;
        setTimeout(renderDuplicates, 1200);
      } catch (e) {
        msg.textContent = e.message;
        b.disabled = false;
      }
    }));

    box.querySelectorAll("[data-merge]").forEach((b) => b.addEventListener("click", async () => {
      const x = all[Number(b.getAttribute("data-merge"))];
      const msg = box.querySelector(`[data-merge-msg="${b.getAttribute("data-merge")}"]`);
      b.disabled = true;
      msg.textContent = "";
      try {
        const r = await api("/api/caseload/merge-name", {
          method: "POST", body: { field: x.field, from: x.from, to: x.to },
        });
        msg.style.color = "#1c6b45";
        msg.textContent = `Moved ${r.moved} client${r.moved === 1 ? "" : "s"} onto ${r.to}. ${r.now_on} now filed under that name${r.email_applied ? `, email ${r.email_applied}` : ""}.`;
        setTimeout(renderDuplicates, 1200);
      } catch (e) {
        msg.style.color = "#a3282e";
        msg.textContent = e.message;
        b.disabled = false;
      }
    }));
  }

  async function preview() {
    shell(`<div class="bd-panel"><div class="bd-empty">Matching against your client records…</div></div>`);
    let d;
    try { d = await api("/api/caseload/migration/preview", { method: "POST", body: { text: sheetText } }); }
    catch (e) { start(e.message); return; }

    const s = d.summary;
    shell(`
      <div class="bd-cards">
        <div class="bd-card" data-static="1"><div class="bd-ct">Clients Reviewed</div><div class="bd-cn">${s.clients_reviewed}</div></div>
        <div class="bd-card" data-static="1"><div class="bd-ct">Will Be Updated</div><div class="bd-cn">${s.will_update}</div></div>
        <div class="bd-card" data-static="1"><div class="bd-ct">Already Correct</div><div class="bd-cn">${s.already_correct}</div></div>
        <div class="bd-card" data-static="1"><div class="bd-ct">Needs Review</div><div class="bd-cn">${s.needs_review}</div>
          <div class="bd-cl">Left alone — nothing is guessed.</div></div>
      </div>
      ${d.warnings && d.warnings.length ? `<div class="bd-panel"><div class="bd-warn" style="border-top:0;">${d.warnings.map(esc).join("<br/>")}</div></div>` : ""}
      <div class="bd-panel">
        <div class="bd-ph"><div><h2 class="bd-pt">What will change</h2>
          <p class="bd-pn">Only blank fields are filled. An assignment or date the CRM already holds is never overwritten here.</p></div>
          <div style="display:flex; gap:8px;">
            <button class="bd-ql" id="mig-back">Back</button>
            <button class="bd-ql" id="mig-apply" style="background:#1b2a6b; color:#fff; border-color:#1b2a6b; cursor:pointer;">Apply ${s.will_update} change${s.will_update === 1 ? "" : "s"}</button>
          </div>
        </div>
        <div class="bd-body">${planTable(d.plan)}</div>
      </div>
      <div class="bd-panel">
        <div class="bd-ph"><div><h2 class="bd-pt">Needs review</h2>
          <p class="bd-pn">Rows this will not decide for you. Nothing on this list is written.</p></div></div>
        <div class="bd-body">${reviewTable(d.review)}</div>
      </div>`);

    document.getElementById("mig-back").addEventListener("click", () => start(""));
    const apply = document.getElementById("mig-apply");
    apply.addEventListener("click", async () => {
      apply.disabled = true;
      apply.textContent = "Applying…";
      try {
        const r = await api("/api/caseload/migration/apply", { method: "POST", body: { text: sheetText } });
        done(r);
      } catch (e) { apply.disabled = false; apply.textContent = "Apply — " + e.message; }
    });
  }

  function done(r) {
    const s = r.summary;
    shell(`
      <div class="bd-cards">
        <div class="bd-card" data-static="1"><div class="bd-ct">Clients Reviewed</div><div class="bd-cn">${s.clients_reviewed}</div></div>
        <div class="bd-card" data-static="1"><div class="bd-ct">BCBA Assignments Updated</div><div class="bd-cn">${s.bcba_assignments_updated}</div></div>
        <div class="bd-card" data-static="1"><div class="bd-ct">Student Analysts Updated</div><div class="bd-cn">${s.student_analyst_assignments_updated}</div></div>
        <div class="bd-card" data-static="1"><div class="bd-ct">Squad Leaders Updated</div><div class="bd-cn">${s.squad_leader_assignments_updated}</div></div>
        <div class="bd-card" data-static="1"><div class="bd-ct">Already Correct</div><div class="bd-cn">${s.already_correct}</div></div>
        <div class="bd-card" data-static="1"><div class="bd-ct">Needs Review</div><div class="bd-cn">${s.needs_review}</div></div>
      </div>
      <div class="bd-panel">
        <div class="bd-ph"><div><h2 class="bd-pt">Done</h2>
          <p class="bd-pn">${s.clients_changed} client record${s.clients_changed === 1 ? "" : "s"} changed${
            s.date_fields_filled ? `, including ${s.date_fields_filled} with blank authorization or treatment-plan dates filled in` : ""
          }. The CRM is now the source of truth for these assignments.</p></div></div>
        <div class="bd-body">${reviewTable(r.review || [])}</div>
      </div>`);
  }

  window.__renderBcbaMigration = async function (mount) {
    mountEl = mount;
    // The same stylesheet the dashboard uses. An admin can reach this screen
    // without the dashboard ever having drawn, so it is injected here too --
    // it is idempotent.
    if (window.__bdInjectStyles) window.__bdInjectStyles();
    start("");
  };
})();
