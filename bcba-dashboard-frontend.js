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
  function shiftDay(iso, by) {
    const d = new Date(String(iso).slice(0, 10) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + by);
    return d.toISOString().slice(0, 10);
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

  function injectStyles() {
    if (document.getElementById("bd-styles")) return;
    const st = document.createElement("style");
    st.id = "bd-styles";
    st.textContent = `
    .bd { padding: 22px; max-width: 1240px; min-width: 0; }
    .bd * { min-width: 0; box-sizing: border-box; }
    .bd-head { margin-bottom: 18px; display:flex; align-items:flex-end; justify-content:space-between; gap:14px; flex-wrap:wrap; }
    .bd-hello { font-size: clamp(19px, 3.6vw, 25px); font-weight: 700; color: #1b2a6b; margin: 0 0 3px; letter-spacing: -0.2px; }
    .bd-sub { font-size: 13px; color: #767488; margin: 0; }
    .bd-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(215px, 100%), 1fr)); gap: 12px; margin-bottom: 18px; }
    .bd-card { background:#fff; border:1px solid #e6e1d4; border-radius:12px; padding:13px 15px; text-align:left; font:inherit; cursor:pointer; display:block; width:100%; }
    .bd-card:hover { border-color:#c9c2ae; }
    .bd-card[data-static="1"] { cursor: default; }
    .bd-card[data-static="1"]:hover { border-color:#e6e1d4; }
    .bd-ct { font-size:10.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#767488; margin-bottom:6px; }
    .bd-cn { font-size:26px; font-weight:700; color:#1b2a6b; line-height:1.05; }
    .bd-cl { font-size:11.5px; color:#767488; margin-top:5px; line-height:1.5; }
    .bd-split { display:flex; gap:5px 12px; flex-wrap:wrap; margin-top:7px; }
    .bd-chip { font-size:10.5px; font-weight:700; padding:2px 7px; border-radius:20px; }
    .bd-panel { background:#fff; border:1px solid #e6e1d4; border-radius:12px; margin-bottom:16px; overflow:hidden; }
    .bd-ph { padding:12px 15px; border-bottom:1px solid #f0ece2; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
    .bd-pt { font-size:13.5px; font-weight:700; color:#1b2a6b; margin:0; }
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
    .bd-ql { font-size:12px; font-weight:600; padding:6px 12px; border-radius:8px; border:1px solid #e6e1d4; background:#fff; color:#1b2a6b; text-decoration:none; }
    .bd-ql:hover { background:#f6f3ec; }
    .bd-day { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .bd-db { font-size:11.5px; font-weight:600; padding:4px 9px; border:1px solid #e6e1d4; border-radius:8px; background:#fff; cursor:pointer; color:#4b5563; }
    .bd-an { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .bd-drawer-back { position:fixed; inset:0; background:rgba(20,20,30,.35); z-index:80; display:flex; justify-content:flex-end; }
    .bd-drawer { background:#fff; width:min(420px,100%); height:100%; overflow-y:auto; padding:20px; }
    .bd-x { float:right; border:0; background:none; font-size:18px; cursor:pointer; color:#767488; line-height:1; }
    .bd-two { display:grid; grid-template-columns: repeat(auto-fit, minmax(min(330px,100%), 1fr)); gap:16px; }
    @media print {
      .sidebar, .bd-filters, .bd-day, .bd-links, .bd-fb { display:none !important; }
      .bd-panel { break-inside: avoid; }
    }`;
    document.head.appendChild(st);
  }

  // ================= summary cards =========================================
  function cards(d) {
    const s = d.summary;
    const c = s.clients, a = s.authorizations, tp = s.treatment_plans, an = s.analysts, b = s.billable;
    const chip = (label, v, tone) => {
      if (!v) return "";
      const t = TONES[tone] || TONES.grey;
      return `<span class="bd-chip" style="background:${t.soft}; color:${t.softFg};">${esc(label)} ${v}</span>`;
    };
    // Billable says what it knows. An unavailable figure is named, never drawn
    // as 0% -- that would report a clinician as behind when nothing is wrong.
    const billableBody = b.available
      ? `<div class="bd-cn">${b.percent == null ? "—" : b.percent + "%"}</div>
         <div class="bd-bar"><i style="width:${Math.max(0, Math.min(100, b.percent || 0))}%;"></i></div>
         <div class="bd-cl">${b.completed} of ${b.required} hours · ${b.remaining} remaining</div>`
      : `<div class="bd-cn" style="font-size:15px; line-height:1.35; padding-top:5px;">Not available</div>
         <div class="bd-cl">${esc(b.note || "")}</div>`;

    return `<div class="bd-cards">
      <button class="bd-card" data-go="caseload">
        <div class="bd-ct">My Clients</div>
        <div class="bd-cn">${c.total}</div>
        <div class="bd-split">
          ${chip("In therapy", c.in_therapy, "none")}
          ${chip("Assessment", c.assessment, "grey")}
          ${chip("On hold", c.on_hold, "yellow")}
        </div>
      </button>

      <button class="bd-card" data-go="auth">
        <div class="bd-ct">Authorizations Expiring</div>
        <div class="bd-cn">${a.attention}</div>
        <div class="bd-split">
          ${chip("Expired", a.expired, "darkred")}
          ${chip("7 days", a.d7, "red")}
          ${chip("30 days", a.d30, "orange")}
          ${chip("60 days", a.d60, "yellow")}
        </div>
        ${a.attention ? "" : `<div class="bd-cl">Nothing inside 60 days.</div>`}
      </button>

      <button class="bd-card" data-go="caseload">
        <div class="bd-ct">Treatment Plans Due</div>
        <div class="bd-cn">${tp.attention}</div>
        <div class="bd-split">
          ${chip("Overdue", tp.expired, "darkred")}
          ${chip("7 days", tp.d7, "red")}
          ${chip("30 days", tp.d30, "orange")}
          ${chip("60 days", tp.d60, "yellow")}
        </div>
        ${tp.attention ? "" : `<div class="bd-cl">Nothing inside 60 days.</div>`}
        ${s.plans && s.plans.no_date ? `<div class="bd-cl">${s.plans.no_date} client${s.plans.no_date === 1 ? "" : "s"} with no plan deadline recorded.</div>` : ""}
      </button>

      <button class="bd-card" data-go="analysts">
        <div class="bd-ct">Student Analysts</div>
        <div class="bd-cn">${an.count}</div>
        <div class="bd-cl">${an.clients_with} client${an.clients_with === 1 ? "" : "s"} with an analyst${
          an.clients_without ? ` · <strong>${an.clients_without}</strong> without` : ""}</div>
      </button>

      <div class="bd-card" data-static="1">
        <div class="bd-ct">Monthly Billable</div>
        ${billableBody}
      </div>
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
        <div><h2 class="bd-pt">Authorizations Expiring Soon</h2>
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
        <div><h2 class="bd-pt">My Schedule</h2>
          <p class="bd-pn">Read from Rethink, which is the source of truth for scheduling. The CRM never changes it.</p></div>
        <div class="bd-day">
          <button class="bd-db" data-day="prev">‹ Previous</button>
          <button class="bd-db" data-day="today">Today</button>
          <button class="bd-db" data-day="next">Next ›</button>
        </div>
      </div>
      <div class="bd-body" id="bd-sched-body"><div class="bd-empty">Loading the schedule…</div></div>
    </div>`;
  }

  async function fillSchedule() {
    const box = document.getElementById("bd-sched-body");
    if (!box) return;
    box.innerHTML = `<div class="bd-empty">Loading ${esc(dayLabel(scheduleDate))}…</div>`;
    let d;
    const qs = "?date=" + encodeURIComponent(scheduleDate) + (viewingEmail ? "&bcba=" + encodeURIComponent(viewingEmail) : "");
    try { d = await api("/api/caseload/schedule" + qs); }
    catch (e) { box.innerHTML = `<div class="bd-empty">Couldn't load the schedule: ${esc(e.message)}</div>`; return; }

    if (!d.available) {
      // Named, not blanked. A schedule panel that silently shows nothing is
      // indistinguishable from a day with no sessions.
      box.innerHTML = `<div class="bd-empty"><strong>${esc(dayLabel(d.date))}</strong><br/>${esc(d.reason || "The schedule is not available.")}</div>`;
      return;
    }
    if (!d.rows.length) {
      box.innerHTML = `<div class="bd-empty">No appointments in Rethink for ${esc(dayLabel(d.date))}.</div>`;
      return;
    }
    const time = (r) => {
      if (!r.start) return "—";
      const t = String(r.start).slice(11, 16) || String(r.start).slice(0, 5);
      const e = r.end ? (String(r.end).slice(11, 16) || String(r.end).slice(0, 5)) : "";
      return e ? `${t}–${e}` : t;
    };
    box.innerHTML = `<div class="bd-scroll"><table>
      <thead><tr><th>Time</th><th>Client</th><th>Location</th><th>Type / CPT</th><th>Status</th></tr></thead>
      <tbody>${d.rows.map((r) => `<tr>
        <td>${esc(time(r))}</td>
        <td>${r.client_id
              ? `<button class="bd-link" data-client="${r.client_id}">${esc(r.client_name)}</button>`
              : `<span style="color:#767488;">Not linked to a CRM client</span>`}</td>
        <td>${esc(r.location || "—")}</td>
        <td>${esc(r.service || "—")}</td>
        <td>${esc(r.status || "—")}</td>
      </tr>`).join("")}</tbody>
    </table></div>
    <div class="bd-note">${esc(dayLabel(d.date))} · ${d.rows.length} appointment${d.rows.length === 1 ? "" : "s"} from Rethink.</div>`;
  }

  // ================= caseload =============================================
  const FILTERS = [
    { key: "all", label: "All" },
    { key: "active", label: "In Therapy" },
    { key: "assessment_scheduling", label: "Assessment" },
    { key: "hold", label: "On Hold" },
    { key: "waitlist", label: "Waitlisted" },
  ];

  function matchesFilter(c) {
    if (caseFilter === "all") return true;
    if (caseFilter === "hold" || caseFilter === "waitlist") return c.waitlisted;
    if (caseFilter === "active") return c.stage === "active" && !c.waitlisted;
    return c.stage === caseFilter;
  }

  function caseloadPanel(d) {
    const q = caseSearch.trim().toLowerCase();
    const rows = d.clients.filter(matchesFilter)
      .filter((c) => !q || String(c.child_name || "").toLowerCase().includes(q));

    const body = rows.length
      ? `<div class="bd-scroll"><table>
          <thead><tr>
            <th>Client</th><th>Status</th><th>Payer</th><th>Auth End</th>
            <th>Treatment Plan Due</th><th>Student Analyst</th><th>Next Session</th>
          </tr></thead>
          <tbody>${rows.map((c) => `<tr>
            <td><button class="bd-link" data-client="${c.id}">${esc(c.child_name)}</button></td>
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

    return `<div class="bd-panel">
      <div class="bd-ph">
        <div><h2 class="bd-pt">My Caseload</h2>
          <p class="bd-pn">${d.clients.length} open client${d.clients.length === 1 ? "" : "s"}. The Student Analyst is here so you never have to open a card to find one.</p></div>
        <div class="bd-filters">
          ${FILTERS.map((f) => `<button class="bd-fb ${caseFilter === f.key ? "on" : ""}" data-filter="${f.key}">${esc(f.label)}</button>`).join("")}
          <input class="bd-search" id="bd-case-search" placeholder="Search clients…" value="${esc(caseSearch)}" />
        </div>
      </div>
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
        <h2 class="bd-pt">My Student Analysts</h2>
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
        <h2 class="bd-pt">My Tasks</h2>
        <p class="bd-pn">From Tasks &amp; Alerts — the same tasks, not a copy.</p>
      </div><a class="bd-ql" href="#/tasks">Open Tasks &amp; Alerts</a></div>
      <div class="bd-body">${body}</div>
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
      : `<div class="bd-empty">No supervision responsibilities recorded for you${s.derived ? " (" + esc(s.derived) + ")" : ""}.</div>`;
    return `<div class="bd-panel">
      <div class="bd-ph"><div>
        <h2 class="bd-pt">Supervision</h2>
        <p class="bd-pn">Figures come from the RBT Supervision tracker, not recalculated here.</p>
      </div><a class="bd-ql" href="#/supervision">Open RBT Supervision</a></div>
      <div class="bd-body">${body}</div>
    </div>`;
  }

  // ================= quick links ==========================================
  function quickLinks() {
    const links = [
      ["Treatment Plan Cheat Sheet", "#/bcba-hub"],
      ["Form Library", "#/bcba-hub"],
      ["Client Behavior / BIP", "#/client-behavior"],
      ["RBT Supervision", "#/supervision"],
      ["Policies & SOPs", "#/policies"],
      ["BCBA Hub", "#/bcba-hub"],
      ["Billable Requirements", "#/billable"],
    ];
    return `<div class="bd-panel"><div class="bd-ph" style="border-bottom:0;">
      <div class="bd-links">${links.map(([l, h]) => `<a class="bd-ql" href="${h}">${esc(l)}</a>`).join("")}</div>
    </div></div>`;
  }

  // ================= render ===============================================
  function render() {
    const d = data;
    const other = !d.bcba.is_self;
    mountEl.innerHTML = `<div class="bd">
      <div class="bd-head">
        <div>
          <h1 class="bd-hello">${esc(greeting())}, ${esc(firstName(d.bcba.name))}.</h1>
          <p class="bd-sub">Here's what's happening with your caseload today.</p>
        </div>
        ${d.can_pick ? `<div class="bd-day">
          <label style="font-size:11.5px; color:#767488;">Viewing</label>
          <select id="bd-pick" class="bd-search" style="max-width:220px;"></select>
        </div>` : ""}
      </div>
      ${other ? `<div class="bd-panel"><div class="bd-warn" style="border-top:0;">You are viewing <strong>${esc(d.bcba.name)}</strong>'s caseload.</div></div>` : ""}
      ${cards(d)}
      ${authPanel(d)}
      ${schedulePanel()}
      ${caseloadPanel(d)}
      ${analystPanel(d)}
      <div class="bd-two">${tasksPanel(d)}${supervisionPanel(d)}</div>
      ${quickLinks()}
    </div>`;
    wire();
    fillSchedule();
    fillNextSessions();
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
    mountEl.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
      const target = b.dataset.go === "analysts" ? "#bd-analysts" : null;
      if (b.dataset.go === "auth") { location.hash = "#/auth-alerts"; return; }
      const el = target ? document.querySelector(target) : mountEl.querySelector(".bd-panel:nth-of-type(3)");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    mountEl.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.day;
      scheduleDate = k === "today" ? todayStr() : shiftDay(scheduleDate, k === "next" ? 1 : -1);
      fillSchedule();
    }));
    mountEl.querySelectorAll("[data-done]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("/api/staff-tasks/" + b.dataset.done, { method: "PATCH", body: { status: "done" } });
        await load();
      } catch (e) { b.disabled = false; b.textContent = e.message; }
    }));
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
    </div>`);
    const ta = document.getElementById("mig-text");
    if (sheetText) ta.value = sheetText;
    document.getElementById("mig-preview").addEventListener("click", async () => {
      sheetText = ta.value;
      if (!sheetText.trim()) { document.getElementById("mig-msg").textContent = "Paste the sheet first."; return; }
      await preview();
    });
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
