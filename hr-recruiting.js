// hr-recruiting.js -- Spectrum Squad CRM: HR & Recruiting (frontend add-on)
// Progressive-enhancement module loaded via a single <script> tag in
// index.html (same pattern as email-templates.js / financial-center.js). It
// injects its own "HR & Recruiting" nav item and renders its own pages into
// #view-mount when the URL hash starts with #/hr, using a MutationObserver to
// survive the native app's own re-renders. It never modifies the existing app.
"use strict";

// Roles allowed to see/enter the HR section. Mirrors the server's
// HR_ACCESS_ROLES. Only owner/admin accounts exist today, so effectively
// owner/admin — but this already supports the future HR roles.
const HR_ACCESS_ROLES = ["owner", "admin", "super_admin", "hr_admin", "hiring_manager", "interviewer"];

const HRState = {
  meta: null,          // { stages, sources, match_categories, caps, role }
  pipelineView: "kanban",
};

function hrCanSee() {
  try {
    return !!(state && state.user && HR_ACCESS_ROLES.includes(state.user.role));
  } catch (e) {
    return false;
  }
}
function hrCanManage() {
  return !!(HRState.meta && HRState.meta.caps && HRState.meta.caps.canManage);
}
function hrCanSensitive() {
  return !!(HRState.meta && HRState.meta.caps && HRState.meta.caps.canSensitive);
}
// Owner-only: destructive timecard deletion.
function hrCanDelete() {
  return !!(HRState.meta && HRState.meta.caps && HRState.meta.caps.canDelete);
}

async function hrApi(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function hrEsc(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}
function hrFmtDate(d) {
  if (!d) return "—";
  const date = new Date(d);
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function hrFmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function hrStageLabel(key) {
  const s = (HRState.meta && HRState.meta.stages) || [];
  const found = s.find((x) => x.key === key);
  return found ? found.label : key;
}
function hrMatchLabel(key) {
  const m = (HRState.meta && HRState.meta.match_categories) || [];
  const found = m.find((x) => x.key === key);
  return found ? found.label : key || "—";
}
function hrSourceLabel(key) {
  const s = (HRState.meta && HRState.meta.sources) || [];
  const found = s.find((x) => x.key === key);
  return found ? found.label : key || "—";
}

// ---------------- nav injection ----------------
function hrSyncNavButton() {
  const nav = document.querySelector(".sidebar nav");
  if (!nav) return;
  if (!hrCanSee()) {
    const existing = nav.querySelector('[data-nav="hr"]');
    if (existing) existing.remove();
    return;
  }
  if (nav.querySelector('[data-nav="hr"]')) return;
  const btn = document.createElement("button");
  btn.className = "nav-item";
  btn.dataset.nav = "hr";
  btn.innerHTML = "HR &amp; Recruiting";
  btn.addEventListener("click", () => {
    location.hash = "#/hr/dashboard";
  });
  nav.appendChild(btn);
}

// ---------------- styles ----------------
function hrInjectStyles() {
  if (document.getElementById("hr-styles")) return;
  const style = document.createElement("style");
  style.id = "hr-styles";
  style.textContent = `
    .hr-wrap { padding: 22px; max-width: 1200px; }
    .hr-head { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:6px; }
    .hr-head h1 { font-size:22px; margin:0; color:var(--brand-navy,#1b2a6b); }
    .hr-tabs { display:flex; gap:6px; flex-wrap:wrap; margin:14px 0 20px; border-bottom:1px solid var(--border,#e5e7eb); }
    .hr-tab { background:none; border:none; padding:9px 14px; font-size:13.5px; cursor:pointer; color:var(--text-muted,#6b6a86); border-bottom:2px solid transparent; }
    .hr-tab.active { color:var(--brand-navy,#1b2a6b); border-bottom-color:var(--brand-gold,#e0a430); font-weight:600; }
    .hr-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:14px; }
    .hr-stat { background:var(--surface,#fff); border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:16px; box-shadow:0 1px 3px rgba(41,34,92,.06); }
    .hr-stat .n { font-size:26px; font-weight:700; color:var(--brand-navy,#1b2a6b); }
    .hr-stat .l { font-size:12.5px; color:var(--text-muted,#6b6a86); margin-top:2px; }
    .hr-stat.urgent { border-color:#f3c46b; background:#fffaf0; }
    .hr-stat.urgent .n { color:var(--brand-gold-dark,#c98a1b); }
    .hr-card { background:var(--surface,#fff); border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:16px; margin-top:16px; box-shadow:0 1px 3px rgba(41,34,92,.06); }
    .hr-card h2 { font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted,#6b6a86); margin:0 0 12px; }
    .hr-btn { background:var(--brand-navy,#1b2a6b); color:#fff; border:none; border-radius:8px; padding:9px 15px; font-size:13.5px; cursor:pointer; font-weight:600; }
    .hr-btn:hover { background:var(--brand-navy-dark,#101c4d); }
    .hr-btn.ghost { background:#fff; color:var(--brand-navy,#1b2a6b); border:1px solid var(--brand-navy,#1b2a6b); }
    .hr-btn.sm { padding:5px 10px; font-size:12.5px; }
    .hr-btn.danger { background:#fff; color:#b91c1c; border:1px solid #e3b1b1; }
    .hr-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .hr-badge { display:inline-block; border-radius:20px; padding:2px 10px; font-size:11.5px; font-weight:600; background:var(--brand-navy-light,#edecf8); color:var(--brand-navy,#1b2a6b); }
    .hr-badge.urgent { background:#fdecc8; color:var(--brand-gold-dark,#c98a1b); }
    .hr-badge.priority { background:#fde0e0; color:#b91c1c; }
    .hr-badge.qualified { background:#dcfce7; color:#15803d; }
    .hr-badge.possibly_qualified { background:#e0f2fe; color:#0369a1; }
    .hr-badge.paused { background:#fef3c7; color:#92400e; }
    .hr-badge.closed { background:#f1f1f4; color:#6b7280; }
    .hr-table { width:100%; border-collapse:collapse; font-size:13px; }
    .hr-table th { text-align:left; padding:8px 10px; border-bottom:2px solid var(--border,#e5e7eb); color:var(--text-muted,#6b6a86); font-size:11.5px; text-transform:uppercase; letter-spacing:.03em; white-space:nowrap; }
    .hr-table td { padding:9px 10px; border-bottom:1px solid #f0f0f3; vertical-align:top; }
    .hr-table tr.clickable:hover { background:var(--brand-navy-light,#edecf8); cursor:pointer; }
    .hr-kanban { display:flex; gap:12px; overflow-x:auto; padding-bottom:12px; }
    .hr-col { flex:0 0 250px; background:#f4f4f8; border-radius:10px; padding:10px; }
    .hr-col h3 { font-size:12px; margin:0 0 8px; color:var(--brand-navy,#1b2a6b); text-transform:uppercase; letter-spacing:.03em; display:flex; justify-content:space-between; }
    .hr-col h3 .cnt { background:#fff; border-radius:10px; padding:0 7px; font-size:11px; color:var(--text-muted,#6b6a86); }
    .hr-ccard { background:#fff; border:1px solid var(--border,#e5e7eb); border-radius:8px; padding:10px; margin-bottom:8px; font-size:12.5px; cursor:grab; }
    .hr-ccard.drop-hint { outline:2px dashed var(--brand-gold,#e0a430); }
    .hr-ccard .nm { font-weight:600; color:var(--brand-navy,#1b2a6b); }
    .hr-ccard .meta { color:var(--text-muted,#6b6a86); font-size:11.5px; margin-top:2px; }
    .hr-col.dragover { background:#e7e7f2; outline:2px dashed var(--brand-navy,#1b2a6b); }
    .hr-field { margin:12px 0; }
    .hr-field label { display:block; font-size:12.5px; font-weight:600; color:#374151; margin-bottom:5px; }
    .hr-field input, .hr-field textarea, .hr-field select { width:100%; padding:9px 10px; border:1px solid var(--border,#d1d5db); border-radius:8px; font-size:14px; box-sizing:border-box; font-family:inherit; }
    .hr-field textarea { min-height:80px; resize:vertical; }
    .hr-2col { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .hr-modal-back { position:fixed; inset:0; background:rgba(28,23,64,.45); display:flex; align-items:flex-start; justify-content:center; z-index:1000; padding:30px 16px; overflow-y:auto; }
    .hr-modal { background:#fff; border-radius:14px; max-width:820px; width:100%; padding:22px; box-shadow:0 20px 60px rgba(28,23,64,.3); }
    .hr-modal h2 { margin-top:0; color:var(--brand-navy,#1b2a6b); }
    .hr-close { float:right; background:none; border:none; font-size:22px; cursor:pointer; color:var(--text-muted,#6b6a86); line-height:1; }
    .hr-empty { text-align:center; padding:40px; color:var(--text-muted,#6b6a86); border:1px dashed var(--border,#e5e7eb); border-radius:12px; }
    .hr-err { color:#b91c1c; font-size:13.5px; }
    .hr-status { font-size:13px; margin-left:6px; }
    .hr-status.ok { color:#16a34a; } .hr-status.err { color:#dc2626; }
    .hr-muted { color:var(--text-muted,#6b6a86); font-size:13px; }
    .hr-note { background:#fafafa; border:1px solid #eee; border-radius:8px; padding:10px; margin-bottom:8px; font-size:13px; }
    .hr-note .who { font-size:11.5px; color:var(--text-muted,#6b6a86); }
    .hr-alert { background:#fffaf0; border:1px solid #f3c46b; border-radius:10px; padding:12px 14px; margin-bottom:12px; color:#8a5a00; font-size:13.5px; }
    .hr-tasklist li { margin-bottom:6px; }
    .hr-lock { font-size:12px; color:var(--text-muted,#6b6a86); font-style:italic; }
    @media (max-width:640px){ .hr-2col{grid-template-columns:1fr;} }
  `;
  document.head.appendChild(style);
}

// ---------------- tabs ----------------
const HR_TABS = [
  { key: "dashboard", label: "Recruiting Dashboard" },
  { key: "pipeline", label: "Applicant Pipeline" },
  { key: "inbox", label: "Recruiting Inbox" },
  { key: "scheduling", label: "Scheduling" },
  { key: "positions", label: "Positions" },
  { key: "timecards", label: "Timecards" },
  { key: "audit", label: "Audit Log" },
];

function hrTabsHtml(active) {
  return `<div class="hr-tabs">${HR_TABS.map(
    (t) => `<button class="hr-tab ${active === t.key ? "active" : ""}" data-hrtab="${t.key}">${hrEsc(t.label)}</button>`
  ).join("")}</div>`;
}
function hrWireTabs(root) {
  root.querySelectorAll("[data-hrtab]").forEach((b) => {
    b.addEventListener("click", () => (location.hash = "#/hr/" + b.dataset.hrtab));
  });
}

// ---------------- ensure meta loaded ----------------
async function hrEnsureMeta() {
  if (HRState.meta) return HRState.meta;
  HRState.meta = await hrApi("/api/hr/meta");
  return HRState.meta;
}

// ---------------- shell ----------------
async function hrRenderShell(mount, activeTab, bodyRenderer) {
  mount.innerHTML = `<div class="hr-wrap" id="hr-view-content">
    <div class="hr-head"><h1>HR &amp; Recruiting</h1></div>
    ${hrTabsHtml(activeTab)}
    <div id="hr-body"><p class="hr-muted">Loading…</p></div>
  </div>`;
  hrWireTabs(mount);
  try {
    await hrEnsureMeta();
    await bodyRenderer(document.getElementById("hr-body"));
  } catch (e) {
    const body = document.getElementById("hr-body");
    if (body) body.innerHTML = `<div class="hr-err">Failed to load: ${hrEsc(e.message)}</div>`;
  }
}

// ---------------- BCBA Command Center ----------------
async function hrRenderCommandCenter(body) {
  const d = await hrApi("/api/hr/command-center");
  const stat = (n, l, urgent) => `<div class="hr-stat ${urgent ? "urgent" : ""}"><div class="n">${n}</div><div class="l">${hrEsc(l)}</div></div>`;
  let alerts = "";
  if (d.waiting_too_long && d.waiting_too_long.length) {
    alerts = `<div class="hr-alert"><strong>⚠ ${d.waiting_too_long.length} qualified BCBA candidate(s) have waited more than one business day for a response.</strong> ${d.waiting_too_long
      .map((a) => `<a href="#/hr/candidate/${a.id}">${hrEsc(a.name)}</a>`)
      .join(", ")}</div>`;
  }
  body.innerHTML = `
    ${alerts}
    <div class="hr-grid">
      ${stat(d.total, "Total BCBA applicants")}
      ${stat(d.new, "New applicants")}
      ${stat(d.priority, "Priority candidates", d.priority > 0)}
      ${stat(d.qualified, "Qualified")}
      ${stat(d.awaiting_response, "Awaiting our response", d.awaiting_response > 0)}
      ${stat(d.stalled, "Stopped responding")}
      ${stat(d.interviews_scheduled, "Interviews scheduled")}
      ${stat(d.interviews_completed, "Interviews completed")}
      ${stat(d.offers_pending, "Offers pending")}
    </div>
    <div class="hr-card">
      <h2>Owner follow-up tasks & recommended actions</h2>
      ${
        d.owner_tasks && d.owner_tasks.length
          ? `<ul class="hr-tasklist">${d.owner_tasks
              .map(
                (t) =>
                  `<li><span class="hr-badge ${t.severity === "urgent" ? "urgent" : ""}">${hrEsc(
                    t.severity
                  )}</span> <a href="#/hr/candidate/${t.applicant_id}">${hrEsc(t.name)}</a> — ${hrEsc(t.action)}</li>`
              )
              .join("")}</ul>`
          : `<p class="hr-muted">No urgent tasks right now. </p>`
      }
    </div>
    <div class="hr-card">
      <h2>Days in current stage</h2>
      ${
        d.days_in_stage && d.days_in_stage.length
          ? `<table class="hr-table"><thead><tr><th>Candidate</th><th>Stage</th><th>Match</th><th>Days</th></tr></thead><tbody>${d.days_in_stage
              .map(
                (a) =>
                  `<tr class="clickable" data-cand="${a.id}"><td>${a.priority ? "★ " : ""}${hrEsc(a.name)}</td><td>${hrEsc(
                    hrStageLabel(a.stage)
                  )}</td><td>${hrEsc(hrMatchLabel(a.match))}</td><td>${a.days}</td></tr>`
              )
              .join("")}</tbody></table>`
          : `<p class="hr-muted">No active BCBA candidates yet. Share the careers link to start receiving applications.</p>`
      }
    </div>`;
  body.querySelectorAll("[data-cand]").forEach((tr) =>
    tr.addEventListener("click", () => (location.hash = "#/hr/candidate/" + tr.dataset.cand))
  );
}

// ---------------- Recruiting Dashboard ----------------
async function hrRenderDashboard(body) {
  const canManage = hrCanManage();
  const [d, notifs, settings] = await Promise.all([
    hrApi("/api/hr/dashboard"),
    hrApi("/api/hr/notifications").catch(() => []),
    hrApi("/api/hr/settings").catch(() => ({ daily_summary_enabled: true, daily_summary_hour: 13 })),
  ]);
  const stat = (n, l) => `<div class="hr-stat"><div class="n">${n}</div><div class="l">${hrEsc(l)}</div></div>`;
  const bars = (rows, keyer) =>
    rows && rows.length
      ? rows
          .map((r) => {
            const max = Math.max(...rows.map((x) => x.count), 1);
            const pct = Math.round((r.count / max) * 100);
            return `<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:12.5px"><span>${hrEsc(
              keyer(r)
            )}</span><span>${r.count}</span></div><div style="background:#eee;border-radius:6px;height:8px"><div style="width:${pct}%;background:var(--brand-navy,#1b2a6b);height:8px;border-radius:6px"></div></div></div>`;
          })
          .join("")
      : `<p class="hr-muted">No data yet.</p>`;
  body.innerHTML = `
    <div class="hr-grid">
      ${stat(d.active_positions, "Active positions")}
      ${stat(d.total_openings, "Total openings")}
      ${stat(d.new_applicants, "New applicants")}
      ${stat(d.unreviewed_applicants, "Unreviewed")}
      ${stat(d.need_followup, "Need follow-up")}
      ${stat(d.interviews_scheduled, "Interviews scheduled")}
      ${stat(d.interviews_completed, "Interviews completed")}
      ${stat(d.offers_pending, "Offers pending")}
      ${stat(d.hires, "Hires")}
      ${stat(d.automation_failures, "Automation failures")}
    </div>
    <div class="hr-2col">
      <div class="hr-card"><h2>Applicants by source</h2>${bars(d.applicants_by_source, (r) => hrSourceLabel(r.source))}</div>
      <div class="hr-card"><h2>Applicants by position</h2>${bars(d.applicants_by_position, (r) => r.title)}</div>
    </div>
    <div class="hr-2col">
      <div class="hr-card">
        <h2>Notifications ${notifs.filter((x) => !x.read).length ? `<span class="hr-badge urgent">${notifs.filter((x) => !x.read).length} new</span>` : ""}</h2>
        ${
          notifs.length
            ? notifs.slice(0, 12).map((x) => `<div class="hr-note ${x.read ? "" : ""}" style="border-left:3px solid ${x.severity === "urgent" ? "#ef4444" : x.severity === "warning" ? "#e0a430" : "#5fa8a0"}">
                <div${x.read ? "" : ' style="font-weight:600"'}>${hrEsc(x.title)}${x.applicant_id ? ` <a href="#/hr/candidate/${x.applicant_id}">→</a>` : ""}</div>
                <div class="hr-muted">${hrEsc(x.body || "")}</div>
                <div class="who">${hrFmtDateTime(x.created_at)}</div></div>`).join("")
            : `<p class="hr-muted">No notifications yet.</p>`
        }
        ${notifs.some((x) => !x.read) ? `<button class="hr-btn sm ghost" id="hr-notif-readall" style="margin-top:8px">Mark all read</button>` : ""}
      </div>
      <div class="hr-card">
        <h2>Daily recruiting summary</h2>
        <p class="hr-muted">Emailed to the owner each day with new applicants, priority candidates, responses, interviews, and recommended actions.</p>
        <div class="hr-field"><label><input type="checkbox" id="hr-sum-enabled" ${settings.daily_summary_enabled ? "checked" : ""} ${canManage ? "" : "disabled"}/> Send daily summary</label></div>
        <div class="hr-field"><label>Send at (hour, UTC)</label><input type="number" id="hr-sum-hour" min="0" max="23" value="${hrEsc(settings.daily_summary_hour)}" ${canManage ? "" : "disabled"} style="max-width:120px"/></div>
        ${canManage ? `<div class="hr-row"><button class="hr-btn sm" id="hr-sum-save">Save</button><button class="hr-btn sm ghost" id="hr-sum-now">Send now</button><span class="hr-status" id="hr-sum-status"></span></div>` : ""}
      </div>
    </div>`;

  const readAll = document.getElementById("hr-notif-readall");
  if (readAll) readAll.addEventListener("click", async () => { try { await hrApi("/api/hr/notifications/read-all", { method: "POST" }); hrRenderDashboard(body); } catch (e) { alert(e.message); } });
  if (canManage) {
    const saveBtn = document.getElementById("hr-sum-save");
    if (saveBtn) saveBtn.addEventListener("click", async () => {
      const st = document.getElementById("hr-sum-status");
      st.textContent = "Saving…"; st.className = "hr-status";
      try {
        await hrApi("/api/hr/settings", { method: "PUT", body: { daily_summary_enabled: document.getElementById("hr-sum-enabled").checked, daily_summary_hour: document.getElementById("hr-sum-hour").value } });
        st.textContent = "Saved."; st.className = "hr-status ok";
      } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
    });
    const nowBtn = document.getElementById("hr-sum-now");
    if (nowBtn) nowBtn.addEventListener("click", async () => {
      const st = document.getElementById("hr-sum-status");
      st.textContent = "Sending…"; st.className = "hr-status";
      try {
        const r = await hrApi("/api/hr/admin/send-summary", { method: "POST" });
        st.textContent = r.sent ? "Summary sent to the owner." : ("Not sent: " + (r.skipped || "unknown"));
        st.className = "hr-status " + (r.sent ? "ok" : "err");
      } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
    });
  }
}

// ---------------- Positions ----------------
async function hrRenderPositions(body) {
  const positions = await hrApi("/api/hr/positions");
  const canManage = hrCanManage();
  const canSens = hrCanSensitive();
  let html = "";
  if (canManage) {
    html += `<div class="hr-row" style="margin-bottom:14px"><button class="hr-btn" id="hr-new-pos">+ New Position</button></div>`;
  }
  if (!positions.length) {
    html += `<div class="hr-empty">No positions yet.</div>`;
  } else {
    html += positions
      .map((p) => {
        const comp =
          canSens && (p.comp_min || p.comp_max)
            ? `<span class="hr-badge">$${p.comp_min || "?"}–${p.comp_max || "?"}/${hrEsc(p.comp_unit)}</span>`
            : "";
        return `<div class="hr-card">
          <div class="hr-row" style="justify-content:space-between">
            <div>
              <div style="font-size:16px;font-weight:700;color:var(--brand-navy,#1b2a6b)">${hrEsc(p.title)}</div>
              <div class="hr-row" style="margin-top:6px">
                <span class="hr-badge ${p.priority === "urgent" ? "urgent" : ""}">${hrEsc(p.priority)}</span>
                <span class="hr-badge ${p.status === "paused" ? "paused" : p.status === "closed" ? "closed" : "qualified"}">${hrEsc(p.status)}</span>
                <span class="hr-badge">${hrEsc(p.location_type)}</span>
                <span class="hr-badge">${p.openings_count} opening(s)</span>
                <span class="hr-badge">${p.active_applicants} active applicant(s)</span>
                ${comp}
              </div>
            </div>
            <div class="hr-row">
              ${canManage ? `<button class="hr-btn sm ghost" data-edit="${p.id}">Edit</button>` : ""}
              ${canManage ? `<button class="hr-btn sm ghost" data-dup="${p.id}">Duplicate</button>` : ""}
              ${
                canManage && p.status === "open"
                  ? `<button class="hr-btn sm ghost" data-status="paused" data-id="${p.id}">Pause</button><button class="hr-btn sm danger" data-status="closed" data-id="${p.id}">Close</button>`
                  : ""
              }
              ${canManage && p.status !== "open" ? `<button class="hr-btn sm" data-status="open" data-id="${p.id}">Reopen</button>` : ""}
            </div>
          </div>
          <div style="margin-top:10px">
            <div class="hr-muted" style="font-weight:600;margin-bottom:4px">Application source links</div>
            <table class="hr-table"><tbody>
              ${(p.sources || [])
                .map(
                  (s) =>
                    `<tr><td>${hrEsc(hrSourceLabel(s.source))}${s.label ? " — " + hrEsc(s.label) : ""}</td>
                     <td><code style="font-size:11.5px">${hrEsc(s.url)}</code></td>
                     <td>${s.clicks} clicks · ${s.applications} apps</td>
                     <td><button class="hr-btn sm ghost" data-copy="${hrEsc(s.url)}">Copy</button></td></tr>`
                )
                .join("")}
            </tbody></table>
            ${canManage ? `<button class="hr-btn sm ghost" data-addsrc="${p.id}" style="margin-top:8px">+ Add source link</button>` : ""}
          </div>
        </div>`;
      })
      .join("");
  }
  body.innerHTML = html;

  if (canManage) {
    const nb = document.getElementById("hr-new-pos");
    if (nb) nb.addEventListener("click", () => hrOpenPositionModal(null));
  }
  body.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", async () => {
      const p = await hrApi("/api/hr/positions/" + b.dataset.edit);
      hrOpenPositionModal(p);
    })
  );
  body.querySelectorAll("[data-dup]").forEach((b) =>
    b.addEventListener("click", async () => {
      await hrApi("/api/hr/positions/" + b.dataset.dup + "/duplicate", { method: "POST" });
      hrRenderPositions(body);
    })
  );
  body.querySelectorAll("[data-status]").forEach((b) =>
    b.addEventListener("click", async () => {
      await hrApi("/api/hr/positions/" + b.dataset.id + "/status", { method: "POST", body: { status: b.dataset.status } });
      hrRenderPositions(body);
    })
  );
  body.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", () => {
      navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy);
      b.textContent = "Copied!";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    })
  );
  body.querySelectorAll("[data-addsrc]").forEach((b) =>
    b.addEventListener("click", async () => {
      const source = await hrPrompt("Source", (HRState.meta.sources || []).map((s) => s.key).join(", "), "indeed");
      if (!source) return;
      try {
        await hrApi("/api/hr/positions/" + b.dataset.addsrc + "/sources", { method: "POST", body: { source } });
        hrRenderPositions(body);
      } catch (e) {
        alert(e.message);
      }
    })
  );
}

function hrPrompt(label, hint, def) {
  return Promise.resolve(window.prompt(label + (hint ? " (" + hint + ")" : ""), def || ""));
}

function hrOpenPositionModal(pos) {
  const isEdit = !!pos;
  const p = pos || {
    title: "", role_type: "other", location_type: "onsite", locations: "", description: "", highlights: "",
    openings_count: 1, priority: "normal", comp_min: "", comp_max: "", comp_unit: "year", comp_notes: "",
    employment_types: [], min_qualifications: [], preferred_qualifications: [], screening_questions: [],
  };
  const canSens = hrCanSensitive();
  const back = document.createElement("div");
  back.className = "hr-modal-back";
  back.innerHTML = `<div class="hr-modal">
    <button class="hr-close" id="hr-mclose">×</button>
    <h2>${isEdit ? "Edit" : "New"} Position</h2>
    <div class="hr-field"><label>Title *</label><input id="p-title" value="${hrEsc(p.title)}"/></div>
    <div class="hr-2col">
      <div class="hr-field"><label>Role type</label><select id="p-role">
        <option value="bcba"${p.role_type === "bcba" ? " selected" : ""}>BCBA</option>
        <option value="rbt"${p.role_type === "rbt" ? " selected" : ""}>RBT</option>
        <option value="cota"${p.role_type === "cota" ? " selected" : ""}>COTA</option>
        <option value="other"${p.role_type === "other" ? " selected" : ""}>Other</option>
      </select></div>
      <div class="hr-field"><label>Location type</label><select id="p-loc">
        <option value="hybrid"${p.location_type === "hybrid" ? " selected" : ""}>Hybrid</option>
        <option value="onsite"${p.location_type === "onsite" ? " selected" : ""}>Onsite</option>
        <option value="remote"${p.location_type === "remote" ? " selected" : ""}>Remote</option>
      </select></div>
    </div>
    <div class="hr-2col">
      <div class="hr-field"><label>Locations</label><input id="p-locs" value="${hrEsc(p.locations)}"/></div>
      <div class="hr-field"><label>Openings</label><input id="p-openings" type="number" min="1" value="${hrEsc(p.openings_count)}"/></div>
    </div>
    <div class="hr-field"><label>Priority</label><select id="p-priority">
      <option value="urgent"${p.priority === "urgent" ? " selected" : ""}>Urgent</option>
      <option value="high"${p.priority === "high" ? " selected" : ""}>High</option>
      <option value="normal"${p.priority === "normal" ? " selected" : ""}>Normal</option>
    </select></div>
    <div class="hr-field"><label>Description</label><textarea id="p-desc">${hrEsc(p.description)}</textarea></div>
    <div class="hr-field"><label>Highlights / benefits</label><input id="p-high" value="${hrEsc(p.highlights)}"/></div>
    <div class="hr-field"><label>Minimum qualifications (one per line)</label><textarea id="p-min">${hrEsc((p.min_qualifications || []).join("\n"))}</textarea></div>
    <div class="hr-field"><label>Preferred qualifications (one per line)</label><textarea id="p-pref">${hrEsc((p.preferred_qualifications || []).join("\n"))}</textarea></div>
    ${
      canSens
        ? `<div class="hr-2col">
             <div class="hr-field"><label>Comp min</label><input id="p-cmin" type="number" value="${hrEsc(p.comp_min == null ? "" : p.comp_min)}"/></div>
             <div class="hr-field"><label>Comp max</label><input id="p-cmax" type="number" value="${hrEsc(p.comp_max == null ? "" : p.comp_max)}"/></div>
           </div>
           <div class="hr-field"><label>Comp unit</label><select id="p-cunit"><option value="year"${p.comp_unit === "year" ? " selected" : ""}>Per year</option><option value="hour"${p.comp_unit === "hour" ? " selected" : ""}>Per hour</option></select></div>`
        : `<p class="hr-lock">Compensation fields are visible to the owner only.</p>`
    }
    <div class="hr-row" style="margin-top:14px">
      <button class="hr-btn" id="hr-psave">${isEdit ? "Save changes" : "Create position"}</button>
      <button class="hr-btn ghost" id="hr-pcancel">Cancel</button>
      <span class="hr-status" id="hr-pstatus"></span>
    </div>
  </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelector("#hr-mclose").addEventListener("click", close);
  back.querySelector("#hr-pcancel").addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });

  back.querySelector("#hr-psave").addEventListener("click", async () => {
    const status = back.querySelector("#hr-pstatus");
    const lines = (id) => back.querySelector(id).value.split("\n").map((s) => s.trim()).filter(Boolean);
    const payload = {
      title: back.querySelector("#p-title").value.trim(),
      role_type: back.querySelector("#p-role").value,
      location_type: back.querySelector("#p-loc").value,
      locations: back.querySelector("#p-locs").value,
      openings_count: back.querySelector("#p-openings").value,
      priority: back.querySelector("#p-priority").value,
      description: back.querySelector("#p-desc").value,
      highlights: back.querySelector("#p-high").value,
      min_qualifications: lines("#p-min"),
      preferred_qualifications: lines("#p-pref"),
    };
    if (canSens) {
      payload.comp_min = back.querySelector("#p-cmin").value;
      payload.comp_max = back.querySelector("#p-cmax").value;
      payload.comp_unit = back.querySelector("#p-cunit").value;
    }
    if (!payload.title) { status.textContent = "Title is required."; status.className = "hr-status err"; return; }
    status.textContent = "Saving…"; status.className = "hr-status";
    try {
      if (isEdit) await hrApi("/api/hr/positions/" + pos.id, { method: "PUT", body: payload });
      else await hrApi("/api/hr/positions", { method: "POST", body: payload });
      close();
      const body = document.getElementById("hr-body");
      if (body) hrRenderPositions(body);
    } catch (e) {
      status.textContent = e.message; status.className = "hr-status err";
    }
  });
}

// ---------------- Scheduling ----------------
async function hrRenderScheduling(body) {
  const canManage = hrCanManage();
  const [slots, interviews, positions] = await Promise.all([
    hrApi("/api/hr/slots").catch(() => []),
    hrApi("/api/hr/interviews").catch(() => []),
    canManage ? hrApi("/api/hr/positions").catch(() => []) : Promise.resolve([]),
  ]);

  const slotForm = canManage
    ? `<div class="hr-card"><h2>Add availability</h2>
        <div class="hr-2col">
          <div class="hr-field"><label>Date & time</label><input type="datetime-local" id="sl-when"/></div>
          <div class="hr-field"><label>Duration (min)</label><input type="number" id="sl-dur" value="30"/></div>
        </div>
        <div class="hr-2col">
          <div class="hr-field"><label>Format</label><select id="sl-mode"><option value="virtual">Virtual</option><option value="in_person">In person</option></select></div>
          <div class="hr-field"><label>Position (optional)</label><select id="sl-pos"><option value="">Any</option>${positions.map((p) => `<option value="${p.id}">${hrEsc(p.title)}</option>`).join("")}</select></div>
        </div>
        <div class="hr-field"><label>Join link or location</label><input id="sl-loc" placeholder="Zoom link, or clinic address"/></div>
        <div class="hr-field"><label>Interviewer (name or email)</label><input id="sl-int"/></div>
        <div class="hr-row"><button class="hr-btn" id="sl-add">Add slot</button><span class="hr-status" id="sl-status"></span></div>
      </div>`
    : "";

  const slotsHtml = slots.length
    ? `<table class="hr-table"><thead><tr><th>When</th><th>Format</th><th>Position</th><th>Status</th><th></th></tr></thead><tbody>${slots
        .map(
          (s) =>
            `<tr><td>${hrFmtDateTime(s.start_at)}</td><td>${hrEsc(s.mode === "virtual" ? "Virtual" : "In person")} · ${s.duration_min}m</td><td>${hrEsc(s.position_title || "Any")}</td><td>${
              s.status === "booked" ? `<span class="hr-badge">booked${s.applicant_name ? " · " + hrEsc(s.applicant_name) : ""}</span>` : '<span class="hr-badge qualified">open</span>'
            }</td><td>${canManage && s.status === "open" ? `<button class="hr-btn sm ghost" data-slotcancel="${s.id}">Remove</button>` : ""}</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="hr-muted">No upcoming availability. Add some above so candidates can book.</p>`;

  const ivHtml = interviews.length
    ? `<table class="hr-table"><thead><tr><th>When</th><th>Candidate</th><th>Position</th><th>Status</th><th></th></tr></thead><tbody>${interviews
        .map(
          (i) =>
            `<tr><td>${hrFmtDateTime(i.scheduled_at)}</td><td class="clickable" data-cand="${i.applicant_id}">${hrEsc(i.applicant_name || "")}</td><td>${hrEsc(i.position_title || "")}</td><td><span class="hr-badge ${i.status === "no_show" ? "priority" : i.status === "completed" ? "qualified" : ""}">${hrEsc(i.status)}</span></td><td>${
              canManage && i.status === "scheduled"
                ? `<button class="hr-btn sm ghost" data-iv="${i.id}" data-st="completed">Completed</button> <button class="hr-btn sm danger" data-iv="${i.id}" data-st="no_show">No-show</button>`
                : ""
            }</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="hr-muted">No interviews yet.</p>`;

  body.innerHTML = `${slotForm}
    <div class="hr-card"><h2>Upcoming availability</h2>${slotsHtml}</div>
    <div class="hr-card"><h2>Interviews</h2>${ivHtml}</div>`;

  if (canManage) {
    const addBtn = document.getElementById("sl-add");
    addBtn.addEventListener("click", async () => {
      const st = document.getElementById("sl-status");
      const whenLocal = document.getElementById("sl-when").value;
      if (!whenLocal) { st.textContent = "Pick a date & time."; st.className = "hr-status err"; return; }
      st.textContent = "Adding…"; st.className = "hr-status";
      try {
        await hrApi("/api/hr/slots", {
          method: "POST",
          body: {
            start_at: new Date(whenLocal).toISOString(),
            duration_min: document.getElementById("sl-dur").value,
            mode: document.getElementById("sl-mode").value,
            position_id: document.getElementById("sl-pos").value || null,
            location_or_link: document.getElementById("sl-loc").value,
            interviewer: document.getElementById("sl-int").value,
          },
        });
        hrRenderScheduling(body);
      } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
    });
    body.querySelectorAll("[data-slotcancel]").forEach((b) =>
      b.addEventListener("click", async () => {
        try { await hrApi("/api/hr/slots/" + b.dataset.slotcancel + "/cancel", { method: "POST" }); hrRenderScheduling(body); } catch (e) { alert(e.message); }
      })
    );
    body.querySelectorAll("[data-iv]").forEach((b) =>
      b.addEventListener("click", async () => {
        try { await hrApi("/api/hr/interviews/" + b.dataset.iv + "/status", { method: "POST", body: { status: b.dataset.st } }); hrRenderScheduling(body); } catch (e) { alert(e.message); }
      })
    );
  }
  body.querySelectorAll("[data-cand]").forEach((el) => el.addEventListener("click", () => (location.hash = "#/hr/candidate/" + el.dataset.cand)));
}

// ---------------- Recruiting Inbox ----------------
async function hrRenderInbox(body) {
  const d = await hrApi("/api/hr/inbox");
  const na = d.needs_attention || [];
  const recent = d.recent || [];
  const naHtml = na.length
    ? `<table class="hr-table"><thead><tr><th>Candidate</th><th>Position</th><th>Stage</th><th>Last response</th><th>Automation</th></tr></thead><tbody>${na
        .map(
          (a) =>
            `<tr class="clickable" data-cand="${a.id}"><td>${hrEsc(a.full_name)}</td><td>${hrEsc(a.position_title || "—")}</td><td>${hrEsc(
              hrStageLabel(a.stage)
            )}</td><td>${hrFmtDate(a.last_response_at)}</td><td>${a.automation_paused ? '<span class="hr-badge paused">paused</span>' : '<span class="hr-badge qualified">active</span>'}</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="hr-muted">No candidates are currently awaiting a reply. </p>`;
  const recentHtml = recent.length
    ? `<table class="hr-table"><thead><tr><th>Direction</th><th>Candidate</th><th>Subject</th><th>Status</th><th>When</th></tr></thead><tbody>${recent
        .map(
          (m) =>
            `<tr class="clickable" data-cand="${m.applicant_id}"><td>${m.direction === "inbound" ? "↙ In" : "↗ Out"}</td><td>${hrEsc(
              m.full_name
            )}</td><td>${hrEsc(m.subject || "")}</td><td>${hrEsc(m.status || "")}</td><td>${hrFmtDate(m.created_at)}</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="hr-muted">No messages yet.</p>`;
  body.innerHTML = `
    <div class="hr-alert">Connect a recruiting mailbox (e.g. careers@spectrumsquad.com) by pointing your provider's inbound webhook at <code>/api/hr/inbound?secret=…</code>. Replies from candidates then land here automatically and pause their follow-up sequence. Set <code>HR_INBOUND_SECRET</code> in Railway.</div>
    <div class="hr-card"><h2>Awaiting your reply</h2>${naHtml}</div>
    <div class="hr-card"><h2>Recent conversations</h2>${recentHtml}</div>`;
  body.querySelectorAll("[data-cand]").forEach((tr) =>
    tr.addEventListener("click", () => (location.hash = "#/hr/candidate/" + tr.dataset.cand))
  );
}

// ---------------- Pipeline (Kanban + Table) ----------------
async function hrRenderPipeline(body) {
  const applicants = await hrApi("/api/hr/applicants");
  const canManage = hrCanManage();
  const toolbar = `<div class="hr-row" style="justify-content:space-between;margin-bottom:12px">
    <div class="hr-row">
      <button class="hr-btn sm ${HRState.pipelineView === "kanban" ? "" : "ghost"}" id="hr-view-kanban">Kanban</button>
      <button class="hr-btn sm ${HRState.pipelineView === "table" ? "" : "ghost"}" id="hr-view-table">Table</button>
    </div>
    ${canManage ? `<span class="hr-row"><button class="hr-btn sm ghost" id="hr-import">Import CSV</button><button class="hr-btn sm" id="hr-add-applicant">+ Add Applicant</button></span>` : ""}
  </div>`;

  let content;
  if (HRState.pipelineView === "table") {
    content = hrPipelineTable(applicants);
  } else {
    content = hrPipelineKanban(applicants);
  }
  body.innerHTML = toolbar + content;

  document.getElementById("hr-view-kanban").addEventListener("click", () => { HRState.pipelineView = "kanban"; hrRenderPipeline(body); });
  document.getElementById("hr-view-table").addEventListener("click", () => { HRState.pipelineView = "table"; hrRenderPipeline(body); });
  const addBtn = document.getElementById("hr-add-applicant");
  if (addBtn) addBtn.addEventListener("click", () => hrOpenApplicantModal());
  const importBtn = document.getElementById("hr-import");
  if (importBtn) importBtn.addEventListener("click", () => hrOpenImportModal(body));

  // wire card/table clicks
  body.querySelectorAll("[data-cand]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-nodrill]")) return;
      location.hash = "#/hr/candidate/" + el.dataset.cand;
    })
  );

  if (HRState.pipelineView === "kanban" && canManage) hrWireKanbanDnd(body);
}

function hrPipelineTable(applicants) {
  if (!applicants.length) return `<div class="hr-empty">No applicants yet. Share your careers link or add one manually.</div>`;
  return `<div class="hr-card" style="margin-top:0;overflow-x:auto"><table class="hr-table">
    <thead><tr><th>Name</th><th>Position</th><th>Stage</th><th>Match</th><th>Source</th><th>Applied</th><th>Last contact</th><th>Next follow-up</th></tr></thead>
    <tbody>${applicants
      .map(
        (a) =>
          `<tr class="clickable" data-cand="${a.id}">
            <td>${a.priority_flag ? "★ " : ""}${hrEsc(a.full_name)}</td>
            <td>${hrEsc(a.position_title || "—")}</td>
            <td>${hrEsc(hrStageLabel(a.stage))}</td>
            <td><span class="hr-badge ${a.match_category || ""}">${hrEsc(hrMatchLabel(a.match_category))}</span></td>
            <td>${hrEsc(hrSourceLabel(a.source))}</td>
            <td>${hrFmtDate(a.applied_at)}</td>
            <td>${hrFmtDate(a.last_contacted_at)}</td>
            <td>${hrFmtDate(a.next_followup_at)}</td>
          </tr>`
      )
      .join("")}</tbody></table></div>`;
}

function hrPipelineKanban(applicants) {
  const stages = (HRState.meta && HRState.meta.stages) || [];
  const byStage = {};
  stages.forEach((s) => (byStage[s.key] = []));
  applicants.forEach((a) => { (byStage[a.stage] = byStage[a.stage] || []).push(a); });
  return `<div class="hr-kanban">${stages
    .map(
      (s) => `<div class="hr-col" data-stage="${s.key}">
        <h3>${hrEsc(s.label)} <span class="cnt">${(byStage[s.key] || []).length}</span></h3>
        ${(byStage[s.key] || [])
          .map(
            (a) => `<div class="hr-ccard" draggable="true" data-cand="${a.id}" data-id="${a.id}">
              <div class="nm">${a.priority_flag ? "★ " : ""}${hrEsc(a.full_name)}</div>
              <div class="meta">${hrEsc(a.position_title || "—")}</div>
              <div class="meta"><span class="hr-badge ${a.match_category || ""}">${hrEsc(hrMatchLabel(a.match_category))}</span></div>
              <div class="meta">${hrEsc(hrSourceLabel(a.source))} · ${hrFmtDate(a.applied_at)}</div>
            </div>`
          )
          .join("")}
      </div>`
    )
    .join("")}</div>`;
}

function hrWireKanbanDnd(body) {
  let draggedId = null;
  body.querySelectorAll(".hr-ccard").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      draggedId = card.dataset.id;
      e.dataTransfer.effectAllowed = "move";
    });
  });
  body.querySelectorAll(".hr-col").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("dragover"); });
    col.addEventListener("dragleave", () => col.classList.remove("dragover"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("dragover");
      const stage = col.dataset.stage;
      if (!draggedId || !stage) return;
      try {
        await hrApi("/api/hr/applicants/" + draggedId + "/stage", { method: "POST", body: { stage } });
        hrRenderPipeline(body);
      } catch (err) {
        alert("Could not move candidate: " + err.message);
      }
    });
  });
}

function hrOpenImportModal(pipelineBody) {
  hrApi("/api/hr/positions").then((positions) => {
    const back = document.createElement("div");
    back.className = "hr-modal-back";
    back.innerHTML = `<div class="hr-modal">
      <button class="hr-close" id="hr-mclose">×</button>
      <h2>Import candidates (CSV)</h2>
      <p class="hr-muted">Paste CSV with a header row. Recognized columns: <code>full_name, email, phone, city, state, source</code>. Imported candidates are not auto-emailed.</p>
      <div class="hr-field"><label>Assign to position (optional)</label><select id="hr-imp-pos"><option value="">—</option>${positions
        .map((p) => `<option value="${p.id}">${hrEsc(p.title)}</option>`)
        .join("")}</select></div>
      <div class="hr-field"><label>CSV</label><textarea id="hr-imp-csv" style="min-height:160px" placeholder="full_name,email,phone,city,state,source
Jane Doe,jane@example.com,7025551212,Las Vegas,NV,indeed"></textarea></div>
      <div class="hr-row"><button class="hr-btn" id="hr-imp-go">Import</button><button class="hr-btn ghost" id="hr-imp-cancel">Cancel</button><span class="hr-status" id="hr-imp-status"></span></div>
    </div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector("#hr-mclose").addEventListener("click", close);
    back.querySelector("#hr-imp-cancel").addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelector("#hr-imp-go").addEventListener("click", async () => {
      const csv = back.querySelector("#hr-imp-csv").value.trim();
      const st = back.querySelector("#hr-imp-status");
      if (!csv) { st.textContent = "Paste some CSV first."; st.className = "hr-status err"; return; }
      st.textContent = "Importing…"; st.className = "hr-status";
      try {
        const r = await hrApi("/api/hr/import", { method: "POST", body: { csv, position_id: back.querySelector("#hr-imp-pos").value || null } });
        st.textContent = `Imported ${r.created}${r.duplicates ? ` (${r.duplicates} possible duplicates)` : ""}.`;
        st.className = "hr-status ok";
        setTimeout(() => { close(); if (pipelineBody) hrRenderPipeline(pipelineBody); }, 900);
      } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
    });
  });
}

function hrOpenApplicantModal() {
  hrApi("/api/hr/positions").then((positions) => {
    const back = document.createElement("div");
    back.className = "hr-modal-back";
    back.innerHTML = `<div class="hr-modal">
      <button class="hr-close" id="hr-mclose">×</button>
      <h2>Add Applicant</h2>
      <div class="hr-2col">
        <div class="hr-field"><label>Full name *</label><input id="a-name"/></div>
        <div class="hr-field"><label>Position</label><select id="a-pos"><option value="">—</option>${positions
          .map((p) => `<option value="${p.id}">${hrEsc(p.title)}</option>`)
          .join("")}</select></div>
      </div>
      <div class="hr-2col">
        <div class="hr-field"><label>Email</label><input id="a-email" type="email"/></div>
        <div class="hr-field"><label>Phone</label><input id="a-phone"/></div>
      </div>
      <div class="hr-2col">
        <div class="hr-field"><label>City</label><input id="a-city"/></div>
        <div class="hr-field"><label>Source</label><select id="a-source">${(HRState.meta.sources || [])
          .map((s) => `<option value="${s.key}">${hrEsc(s.label)}</option>`)
          .join("")}</select></div>
      </div>
      <div class="hr-row" style="margin-top:12px">
        <button class="hr-btn" id="hr-asave">Add applicant</button>
        <button class="hr-btn ghost" id="hr-acancel">Cancel</button>
        <span class="hr-status" id="hr-astatus"></span>
      </div>
    </div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector("#hr-mclose").addEventListener("click", close);
    back.querySelector("#hr-acancel").addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelector("#hr-asave").addEventListener("click", async () => {
      const status = back.querySelector("#hr-astatus");
      const name = back.querySelector("#a-name").value.trim();
      if (!name) { status.textContent = "Name is required."; status.className = "hr-status err"; return; }
      status.textContent = "Saving…"; status.className = "hr-status";
      try {
        const r = await hrApi("/api/hr/applicants", {
          method: "POST",
          body: {
            full_name: name,
            position_id: back.querySelector("#a-pos").value || null,
            email: back.querySelector("#a-email").value,
            phone: back.querySelector("#a-phone").value,
            city: back.querySelector("#a-city").value,
            source: back.querySelector("#a-source").value,
          },
        });
        close();
        if (r.duplicateOf) alert("Heads up: a possible duplicate of an existing applicant (#" + r.duplicateOf.id + ") was detected. The new record was still created.");
        location.hash = "#/hr/candidate/" + r.id;
      } catch (e) {
        status.textContent = e.message; status.className = "hr-status err";
      }
    });
  });
}

// Renders the AI screening assessment: the latest structured screening if one
// exists, otherwise the plain ai_summary. Returns "" when there's nothing yet.
function hrScreeningHtml(a) {
  const s = a.screenings && a.screenings.length ? a.screenings[0] : null;
  if (!s && !a.ai_summary) return "";
  const list = (json) => {
    let arr = json;
    try { if (typeof json === "string") arr = JSON.parse(json); } catch (e) { arr = []; }
    if (!Array.isArray(arr) || !arr.length) return "";
    return "<ul>" + arr.map((x) => `<li>${hrEsc(x)}</li>`).join("") + "</ul>";
  };
  if (!s) {
    return `<div class="hr-card"><h2>AI assessment</h2><div style="white-space:pre-wrap">${hrEsc(a.ai_summary)}</div></div>`;
  }
  const section = (label, json) => {
    const html = list(json);
    return html ? `<div style="margin-top:10px"><div class="hr-muted" style="font-weight:600">${label}</div>${html}</div>` : "";
  };
  return `<div class="hr-card">
    <h2>AI assessment ${s.match_category ? `<span class="hr-badge ${hrEsc(s.match_category)}">${hrEsc(hrMatchLabel(s.match_category))}</span>` : ""}</h2>
    <div style="white-space:pre-wrap">${hrEsc(s.summary || a.ai_summary || "")}</div>
    ${section("Confirmed qualifications", s.confirmed_quals)}
    ${section("Unconfirmed qualifications", s.unconfirmed_quals)}
    ${section("Missing information", s.missing_info)}
    ${section("Strengths", s.strengths)}
    ${section("Concerns for human review", s.concerns)}
    ${section("Suggested screening questions", s.suggested_questions)}
    ${s.recommended_action ? `<div style="margin-top:10px"><div class="hr-muted" style="font-weight:600">Recommended next action</div><div>${hrEsc(s.recommended_action)}</div></div>` : ""}
    <div class="hr-muted" style="margin-top:10px;font-size:11.5px">Generated by ${hrEsc(s.model || "AI")} · ${hrFmtDate(s.created_at)} · AI organizes and prioritizes only; a human makes the final decision.</div>
  </div>`;
}

// Recruiting communication panel: automation state, conversation history,
// scheduled follow-ups, and human-takeover controls.
function hrCommsHtml(a) {
  const msgs = a.messages || [];
  const followups = a.followups || [];
  const msgsHtml = msgs.length
    ? msgs
        .map((m) => {
          const inbound = m.direction === "inbound";
          const who = inbound ? "Candidate" : (m.ai_generated || m.sent_by === "assistant" ? "Assistant" : "Team");
          const snippet = String(m.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
          return `<div class="hr-note" style="border-left:3px solid ${inbound ? "#5fa8a0" : "#1b2a6b"}">
            <div style="font-weight:600">${hrEsc(m.subject || "(no subject)")}</div>
            <div>${hrEsc(snippet)}${snippet.length >= 160 ? "…" : ""}</div>
            <div class="who">${hrEsc(who)} · ${hrEsc(m.channel || "email")} · ${hrEsc(m.status || "")} · ${hrFmtDate(m.created_at)}</div>
          </div>`;
        })
        .join("")
    : `<p class="hr-muted">No messages yet.</p>`;
  const fuHtml = followups.length
    ? `<table class="hr-table"><thead><tr><th>Step</th><th>Scheduled</th><th>Status</th></tr></thead><tbody>${followups
        .map(
          (f) =>
            `<tr><td>${hrEsc(f.step)} <span class="hr-muted">(${hrEsc(f.sequence)})</span></td><td>${hrFmtDate(f.scheduled_at)}</td><td>${hrEsc(f.status)}</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="hr-muted">No scheduled follow-ups.</p>`;
  const statusLine = a.do_not_contact
    ? `<span class="hr-badge priority">Do not contact</span>`
    : a.automation_paused
    ? `<span class="hr-badge paused">Automation paused</span>`
    : `<span class="hr-badge qualified">Automation active</span>`;
  return `<div class="hr-card"><h2>Recruiting communication</h2>
    <div class="hr-row" style="margin-bottom:6px">${statusLine}
      ${a.next_followup_at ? `<span class="hr-muted">Next follow-up: ${hrFmtDate(a.next_followup_at)}</span>` : ""}
      ${a.last_response_at ? `<span class="hr-muted">Responded: ${hrFmtDate(a.last_response_at)}</span>` : ""}
    </div>
    <div class="hr-row" style="margin:8px 0 14px">
      <button class="hr-btn sm ghost" id="hr-pause-toggle" data-paused="${a.automation_paused ? "true" : "false"}">${a.automation_paused ? "Resume automation" : "Pause automation"}</button>
      <button class="hr-btn sm ghost" id="hr-log-response">Log candidate response</button>
    </div>
    <div class="hr-muted" style="font-weight:600;margin-bottom:6px">Conversation history</div>
    ${msgsHtml}
    <div class="hr-muted" style="font-weight:600;margin:14px 0 6px">Scheduled follow-ups</div>
    ${fuHtml}
    <div class="hr-muted" style="font-weight:600;margin:16px 0 6px">Send a message (takes over automation)</div>
    <div class="hr-field" style="margin:6px 0"><input id="hr-msg-subject" placeholder="Subject"/></div>
    <div class="hr-field" style="margin:6px 0"><textarea id="hr-msg-body" placeholder="Write a personal note to the candidate…"></textarea></div>
    <div class="hr-row"><button class="hr-btn sm" id="hr-send-msg">Send email</button><button class="hr-btn sm ghost" id="hr-draft-reply">Draft AI reply</button><span class="hr-status" id="hr-msg-status"></span></div>
    <div class="hr-muted" style="font-weight:600;margin:16px 0 6px">Interview scheduling</div>
    <div class="hr-row"><button class="hr-btn sm ghost" id="hr-sched-email">Email scheduling link</button><button class="hr-btn sm ghost" id="hr-sched-copy">Copy scheduling link</button><span class="hr-status" id="hr-sched-status"></span></div>
  </div>`;
}

// ---------------- Offers (owner-only) ----------------
async function hrLoadOffers(mount, id, a) {
  const card = mount.querySelector("#hr-offer-card");
  if (!card) return;
  let offers;
  try {
    offers = await hrApi("/api/hr/applicants/" + id + "/offers");
  } catch (e) {
    card.innerHTML = `<h2>Offer</h2><div class="hr-err">${hrEsc(e.message)}</div>`;
    return;
  }
  const o = offers[0];
  let html = "<h2>Offer </h2>";
  if (!o) {
    html += `<p class="hr-muted">No offer yet. Create a delightful, interactive offer the candidate can open, sign, and celebrate.</p><button class="hr-btn" id="hr-offer-new">Create offer</button>`;
  } else {
    const money = o.comp_amount != null ? "$" + Number(o.comp_amount).toLocaleString() + (o.comp_unit === "hour" ? "/hr" : "/yr") : "—";
    html += `<div class="hr-row" style="margin-bottom:8px"><span class="hr-badge ${o.status === "accepted" ? "qualified" : o.status === "declined" ? "priority" : ""}">${hrEsc(o.status)}</span> <span class="hr-muted">${hrEsc(o.job_title || "")} · ${money}</span></div>`;
    if (o.status === "accepted") html += `<p style="color:#16a34a;font-weight:600">Accepted by ${hrEsc(o.signed_name || "")} on ${hrFmtDate(o.signed_at)}</p>`;
    if (o.status === "declined") html += `<p class="hr-muted">Declined${o.decline_reason ? ": " + hrEsc(o.decline_reason) : ""}</p>`;
    html += `<div class="hr-row">`;
    if (o.status === "draft") {
      html += `<button class="hr-btn sm ghost" id="hr-offer-edit">Edit</button><button class="hr-btn sm" id="hr-offer-approve">Approve</button>`;
    } else if (o.status === "approved") {
      html += `<button class="hr-btn sm ghost" id="hr-offer-edit">Edit</button><button class="hr-btn sm" id="hr-offer-send">Send to candidate </button><button class="hr-btn sm ghost" id="hr-offer-withdraw">Back to draft</button>`;
    } else if (o.status === "sent") {
      html += `<button class="hr-btn sm ghost" id="hr-offer-edit">Edit</button><button class="hr-btn sm ghost" id="hr-offer-copy">Copy link</button> <a class="hr-btn sm ghost" href="${hrEsc(o.public_url)}" target="_blank">Preview</a><button class="hr-btn sm danger" id="hr-offer-withdraw">Withdraw</button>`;
    } else {
      html += `<button class="hr-btn sm ghost" id="hr-offer-copy">Copy link</button> <a class="hr-btn sm ghost" href="${hrEsc(o.public_url)}" target="_blank">Preview</a>`;
    }
    html += `<span class="hr-status" id="hr-offer-status"></span></div>`;
    if (o.status === "sent") html += `<p class="hr-muted" style="margin-top:6px">Sent — waiting on the candidate. You can still <strong>Edit</strong> (updates the live offer) or <strong>Withdraw</strong> it until they respond.</p>`;
  }
  card.innerHTML = html;

  const nb = card.querySelector("#hr-offer-new");
  if (nb) nb.addEventListener("click", () => hrOpenOfferModal(mount, id, a, null));
  const eb = card.querySelector("#hr-offer-edit");
  if (eb) eb.addEventListener("click", () => hrOpenOfferModal(mount, id, a, o));
  const ap = card.querySelector("#hr-offer-approve");
  if (ap) ap.addEventListener("click", async () => { try { await hrApi("/api/hr/offers/" + o.id + "/approve", { method: "POST" }); hrLoadOffers(mount, id, a); } catch (e) { alert(e.message); } });
  const sn = card.querySelector("#hr-offer-send");
  if (sn) sn.addEventListener("click", async () => {
    const st = card.querySelector("#hr-offer-status"); st.textContent = "Sending…"; st.className = "hr-status";
    try { await hrApi("/api/hr/offers/" + o.id + "/send", { method: "POST" }); hrLoadOffers(mount, id, a); } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
  });
  const cp = card.querySelector("#hr-offer-copy");
  if (cp) cp.addEventListener("click", () => { if (navigator.clipboard) navigator.clipboard.writeText(o.public_url); const st = card.querySelector("#hr-offer-status"); st.textContent = "Copied!"; st.className = "hr-status ok"; });
  const wd = card.querySelector("#hr-offer-withdraw");
  if (wd) wd.addEventListener("click", async () => {
    if (!confirm("Move this offer back to draft so you can edit it? The candidate's current link will stop working until you re-send.")) return;
    try { await hrApi("/api/hr/offers/" + o.id + "/withdraw", { method: "POST" }); hrLoadOffers(mount, id, a); } catch (e) { alert(e.message); }
  });
}

function hrOpenOfferModal(mount, id, a, o) {
  const p = o || {};
  const defaultHighlights = ["Supportive, collaborative clinical team", "Flexible schedule", "Meaningful work changing kids' lives", "Room to grow"];
  const back = document.createElement("div");
  back.className = "hr-modal-back";
  back.innerHTML = `<div class="hr-modal">
    <button class="hr-close" id="hr-mclose">×</button>
    <h2>${o ? "Edit" : "Create"} offer</h2>
    <div class="hr-field"><label>Job title</label><input id="of-title" value="${hrEsc(p.job_title || a.position_title || "")}"/></div>
    <div class="hr-2col">
      <div class="hr-field"><label>Compensation amount</label><input id="of-amt" type="text" inputmode="decimal" placeholder="e.g. 24 or 85000" value="${hrEsc(p.comp_amount == null ? "" : p.comp_amount)}"/></div>
      <div class="hr-field"><label>Per</label><select id="of-unit"><option value="year"${p.comp_unit === "year" ? " selected" : ""}>Year</option><option value="hour"${p.comp_unit === "hour" ? " selected" : ""}>Hour</option></select></div>
    </div>
    <div class="hr-2col">
      <div class="hr-field"><label>Employment type</label><input id="of-type" value="${hrEsc(p.employment_type || "")}" placeholder="Full-time"/></div>
      <div class="hr-field"><label>Start date</label><input id="of-start" type="date" value="${hrEsc(p.start_date || "")}"/></div>
    </div>
    <div class="hr-2col">
      <div class="hr-field"><label>Reports to</label><input id="of-sup" value="${hrEsc(p.supervisor || "")}"/></div>
      <div class="hr-field"><label>Location</label><input id="of-loc" value="${hrEsc(p.location || "")}"/></div>
    </div>
    <div class="hr-field"><label>Details / notes (optional)</label><input id="of-notes" value="${hrEsc(p.comp_notes || "")}" placeholder="e.g. plus benefits & PTO"/></div>
    <div class="hr-field"><label>Highlights / perks (one per line)</label><textarea id="of-high">${hrEsc((p.highlights && p.highlights.length ? p.highlights : defaultHighlights).join("\n"))}</textarea></div>
    <div class="hr-field"><label>Personal message</label><textarea id="of-msg" placeholder="We can't wait to have you on the team!">${hrEsc(p.custom_message || "")}</textarea></div>
    <div class="hr-field"><label>Expires in (days, optional)</label><input id="of-exp" type="number" placeholder="7"/></div>
    <div class="hr-row"><button class="hr-btn" id="of-save">${o ? "Save" : "Create offer"}</button><button class="hr-btn ghost" id="of-cancel">Cancel</button><span class="hr-status" id="of-status"></span></div>
  </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelector("#hr-mclose").addEventListener("click", close);
  back.querySelector("#of-cancel").addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  back.querySelector("#of-save").addEventListener("click", async () => {
    const st = back.querySelector("#of-status");
    const title = back.querySelector("#of-title").value.trim();
    if (!title) { st.textContent = "Job title is required."; st.className = "hr-status err"; return; }
    const days = parseInt(back.querySelector("#of-exp").value, 10);
    const body = {
      job_title: title,
      comp_amount: back.querySelector("#of-amt").value || null,
      comp_unit: back.querySelector("#of-unit").value,
      employment_type: back.querySelector("#of-type").value,
      start_date: back.querySelector("#of-start").value,
      supervisor: back.querySelector("#of-sup").value,
      location: back.querySelector("#of-loc").value,
      comp_notes: back.querySelector("#of-notes").value,
      highlights: back.querySelector("#of-high").value.split("\n").map((s) => s.trim()).filter(Boolean),
      custom_message: back.querySelector("#of-msg").value,
    };
    if (days > 0) body.expires_at = new Date(Date.now() + days * 86400000).toISOString();
    st.textContent = "Saving…"; st.className = "hr-status";
    try {
      if (o) await hrApi("/api/hr/offers/" + o.id, { method: "PUT", body });
      else await hrApi("/api/hr/applicants/" + id + "/offers", { method: "POST", body });
      close();
      hrLoadOffers(mount, id, a);
    } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
  });
}

// ---------------- Candidate profile ----------------
async function hrRenderCandidate(mount, id) {
  mount.innerHTML = `<div class="hr-wrap" id="hr-view-content">
    <div class="hr-row" style="margin-bottom:12px"><button class="hr-btn ghost sm" id="hr-back">← Back to pipeline</button></div>
    <div id="hr-cand-body"><p class="hr-muted">Loading…</p></div>
  </div>`;
  mount.querySelector("#hr-back").addEventListener("click", () => (location.hash = "#/hr/pipeline"));
  try {
    await hrEnsureMeta();
  } catch (e) {}
  const body = mount.querySelector("#hr-cand-body");
  let a;
  try {
    a = await hrApi("/api/hr/applicants/" + id);
  } catch (e) {
    body.innerHTML = `<div class="hr-err">Failed to load candidate: ${hrEsc(e.message)}</div>`;
    return;
  }
  const canManage = hrCanManage();
  const canSens = hrCanSensitive();
  const stages = (HRState.meta && HRState.meta.stages) || [];

  const answers = a.screening_answers || {};
  const answersHtml = Object.keys(answers).length
    ? Object.entries(answers).map(([k, v]) => `<div style="margin:4px 0"><span class="hr-muted">${hrEsc(k)}:</span> ${hrEsc(v)}</div>`).join("")
    : `<p class="hr-muted">No screening answers yet.</p>`;

  // Expanded application (Phase 6a): availability + certifications + education +
  // employment history. Availability is stored as a small JSON object.
  const av = a.availability && typeof a.availability === "object" ? a.availability : {};
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const avDays = av.days ? DOW.filter((d) => av.days[d]) : [];
  const avParts = [];
  if (avDays.length) avParts.push(avDays.join(", "));
  if (av.earliest || av.latest) avParts.push(`${av.earliest || "?"}–${av.latest || "?"}`);
  if (av.weekly_hours) avParts.push(`${av.weekly_hours} hrs/wk`);
  if (av.type) avParts.push({ full_time: "Full-time", part_time: "Part-time", either: "FT or PT" }[av.type] || av.type);
  const detailRow = (label, val, pre) => val ? `<div style="margin:6px 0"><span class="hr-muted" style="font-weight:600">${label}:</span> <span style="white-space:${pre ? "pre-wrap" : "normal"}">${hrEsc(val)}</span></div>` : "";
  const appDetailsHtml = (avParts.length || a.certifications || a.education || a.employment_history)
    ? `<div class="hr-card"><h2>Application details</h2>
        ${avParts.length ? `<div style="margin:6px 0"><span class="hr-muted" style="font-weight:600">Availability:</span> ${hrEsc(avParts.join(" · "))}${av.notes ? ` <span class="hr-muted">(${hrEsc(av.notes)})</span>` : ""}</div>` : ""}
        ${detailRow("Certifications & licenses", a.certifications, true)}
        ${detailRow("Education", a.education, true)}
        ${detailRow("Employment history", a.employment_history, true)}
      </div>`
    : "";

  const docsHtml = (a.documents || []).length
    ? (a.documents || []).map((d) => `<a class="hr-btn sm ghost" href="/api/hr/documents/${d.id}" target="_blank" style="margin-right:6px">${hrEsc(d.filename || d.kind)}</a>`).join("")
    : `<span class="hr-muted">No resume uploaded.</span>`;

  const notesHtml = (a.notes || []).length
    ? (a.notes || []).map((n) => `<div class="hr-note"><div>${hrEsc(n.body)}${n.rating ? " · " + n.rating : ""}</div><div class="who">${hrEsc(n.author)} · ${hrFmtDate(n.created_at)}${n.is_private ? " · private" : ""}</div></div>`).join("")
    : `<p class="hr-muted">No notes yet.</p>`;

  const historyHtml = (a.stage_history || []).length
    ? (a.stage_history || []).map((h) => `<div style="font-size:12.5px;margin:3px 0"><span class="hr-muted">${hrFmtDate(h.changed_at)}</span> — ${hrEsc(hrStageLabel(h.from_stage) || "start")} → <strong>${hrEsc(hrStageLabel(h.to_stage))}</strong> ${h.note ? "(" + hrEsc(h.note) + ")" : ""}</div>`).join("")
    : "";

  body.innerHTML = `
    <div class="hr-head">
      <h1>${a.priority_flag ? "★ " : ""}${hrEsc(a.full_name)}${a.preferred_name ? ` <span class="hr-muted" style="font-size:16px;font-weight:400">(goes by ${hrEsc(a.preferred_name)})</span>` : ""}</h1>
      <div class="hr-row">
        <span class="hr-badge ${a.match_category || ""}">${hrEsc(hrMatchLabel(a.match_category))}</span>
        <span class="hr-badge">${hrEsc(hrStageLabel(a.stage))}</span>
      </div>
    </div>
    <div class="hr-2col">
      <div class="hr-card"><h2>Contact & application</h2>
        <div><strong>${hrEsc(a.position_title || "No position")}</strong></div>
        <div class="hr-muted">${hrEsc(a.email || "no email")} · ${hrEsc(a.phone || "no phone")}</div>
        <div class="hr-muted">${hrEsc(a.city || "")}${a.state ? ", " + hrEsc(a.state) : ""}</div>
        ${a.address ? `<div class="hr-muted">${hrEsc(a.address)}</div>` : ""}
        <div class="hr-muted">Source: ${hrEsc(hrSourceLabel(a.source))} · Applied ${hrFmtDate(a.applied_at)}</div>
        <div class="hr-muted">Earliest start: ${hrEsc(a.earliest_start || "—")} · Setting: ${hrEsc(a.work_setting || "—")}</div>
        ${canSens ? `<div class="hr-muted">Desired pay: ${hrEsc(a.desired_pay || a.comp_expectation || "—")}</div>` : `<div class="hr-lock">Desired pay hidden (owner only)</div>`}
        <div class="hr-muted">Consent: email ${a.consent_email ? "✓" : "✗"}${a.sms_consent || a.consent_sms ? ` · text ✓<span title="Texting has been removed from the CRM. This is kept as the record of a consent that was given${a.sms_consent_version ? ", disclosure " + hrEsc(a.sms_consent_version) : ""}.">${a.sms_consent_at ? " (recorded " + hrFmtDate(a.sms_consent_at) + ")" : ""}</span>` : ""}${a.do_not_contact ? " · <strong>DO NOT CONTACT</strong>" : ""}</div>
        <div style="margin-top:10px">${docsHtml}</div>
      </div>
      <div class="hr-card"><h2>Move stage</h2>
        <div class="hr-field"><select id="hr-stage-sel">${stages.map((s) => `<option value="${s.key}"${s.key === a.stage ? " selected" : ""}>${hrEsc(s.label)}</option>`).join("")}</select></div>
        <button class="hr-btn sm ${canManage ? "" : "ghost"}" id="hr-move" ${canManage ? "" : "disabled"}>Update stage</button>
        <span class="hr-status" id="hr-move-status"></span>
        ${canManage ? `<div style="margin-top:14px"><button class="hr-btn sm ghost" id="hr-screen">Run AI screening</button> <span class="hr-status" id="hr-screen-status"></span></div>` : ""}
        ${historyHtml ? `<div style="margin-top:14px"><div class="hr-muted" style="font-weight:600">Stage history</div>${historyHtml}</div>` : ""}
      </div>
    </div>
    ${appDetailsHtml}
    <div class="hr-card"><h2>Screening answers</h2>${answersHtml}</div>
    ${a.cover_letter ? `<div class="hr-card"><h2>Cover letter</h2><div style="white-space:pre-wrap">${hrEsc(a.cover_letter)}</div></div>` : ""}
    ${hrScreeningHtml(a)}
    ${canManage ? hrCommsHtml(a) : ""}
    <div class="hr-card"><h2>Internal notes ${!canSens ? '<span class="hr-lock">(private notes & ratings owner-only)</span>' : ""}</h2>
      ${notesHtml}
      <div class="hr-field" style="margin-top:10px"><textarea id="hr-note-body" placeholder="Add a note…"></textarea></div>
      <div class="hr-row">
        ${canSens ? `<label class="hr-muted"><input type="checkbox" id="hr-note-private" checked/> Private</label> <input id="hr-note-rating" type="number" min="1" max="5" placeholder="Rating 1-5" style="width:110px;padding:8px;border:1px solid var(--border,#d1d5db);border-radius:8px"/>` : ""}
        <button class="hr-btn sm" id="hr-note-add">Add note</button>
        <span class="hr-status" id="hr-note-status"></span>
      </div>
    </div>
    ${canSens ? `<div class="hr-card" id="hr-offer-card"><h2>Offer</h2><p class="hr-muted">Loading…</p></div>` : ""}
    ${canManage ? `<div class="hr-card"><h2>Disposition</h2><div class="hr-row">
      <button class="hr-btn sm danger" data-disp="not_selected">Not selected</button>
      <button class="hr-btn sm ghost" data-disp="withdrawn">Withdrawn</button>
      <button class="hr-btn sm ghost" data-disp="talent_pool">Talent pool</button>
    </div></div>` : ""}
  `;

  // wire stage move
  const moveBtn = body.querySelector("#hr-move");
  if (moveBtn && canManage) {
    moveBtn.addEventListener("click", async () => {
      const st = body.querySelector("#hr-move-status");
      st.textContent = "Saving…"; st.className = "hr-status";
      try {
        await hrApi("/api/hr/applicants/" + id + "/stage", { method: "POST", body: { stage: body.querySelector("#hr-stage-sel").value } });
        st.textContent = "Updated."; st.className = "hr-status ok";
      } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
    });
  }
  const screenBtn = body.querySelector("#hr-screen");
  if (screenBtn) {
    screenBtn.addEventListener("click", async () => {
      const st = body.querySelector("#hr-screen-status");
      st.textContent = "Screening… (this can take a moment)"; st.className = "hr-status";
      screenBtn.disabled = true;
      try {
        const r = await hrApi("/api/hr/applicants/" + id + "/screen", { method: "POST" });
        if (r.ok) {
          hrRenderCandidate(mount, id); // re-render to show the new assessment
        } else {
          st.textContent = r.message || "Done."; st.className = "hr-status " + (r.pending ? "" : "err");
          screenBtn.disabled = false;
        }
      } catch (e) {
        st.textContent = e.message; st.className = "hr-status err";
        screenBtn.disabled = false;
      }
    });
  }
  const noteBtn = body.querySelector("#hr-note-add");
  if (noteBtn) {
    noteBtn.addEventListener("click", async () => {
      const st = body.querySelector("#hr-note-status");
      const bodyText = body.querySelector("#hr-note-body").value.trim();
      const ratingEl = body.querySelector("#hr-note-rating");
      const privEl = body.querySelector("#hr-note-private");
      if (!bodyText && (!ratingEl || !ratingEl.value)) { st.textContent = "Enter a note."; st.className = "hr-status err"; return; }
      st.textContent = "Saving…"; st.className = "hr-status";
      try {
        await hrApi("/api/hr/applicants/" + id + "/notes", {
          method: "POST",
          body: {
            body: bodyText,
            rating: ratingEl && ratingEl.value ? Number(ratingEl.value) : null,
            is_private: privEl ? privEl.checked : false,
          },
        });
        hrRenderCandidate(mount, id);
      } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
    });
  }
  body.querySelectorAll("[data-disp]").forEach((b) =>
    b.addEventListener("click", async () => {
      const reason = window.prompt("Reason (optional):", "");
      try {
        await hrApi("/api/hr/applicants/" + id + "/disposition", { method: "POST", body: { stage: b.dataset.disp, reason } });
        hrRenderCandidate(mount, id);
      } catch (e) { alert(e.message); }
    })
  );

  if (canSens) hrLoadOffers(mount, id, a);

  // ---- recruiting communication controls ----
  const pauseBtn = body.querySelector("#hr-pause-toggle");
  if (pauseBtn) {
    pauseBtn.addEventListener("click", async () => {
      const paused = pauseBtn.dataset.paused !== "true"; // toggle
      try {
        await hrApi("/api/hr/applicants/" + id + "/pause-automation", { method: "POST", body: { paused } });
        hrRenderCandidate(mount, id);
      } catch (e) { alert(e.message); }
    });
  }
  const respBtn = body.querySelector("#hr-log-response");
  if (respBtn) {
    respBtn.addEventListener("click", async () => {
      const note = window.prompt("Paste or summarize the candidate's response (optional). This pauses automation.", "");
      if (note === null) return;
      try {
        await hrApi("/api/hr/applicants/" + id + "/log-response", { method: "POST", body: { body: note } });
        hrRenderCandidate(mount, id);
      } catch (e) { alert(e.message); }
    });
  }
  const draftBtn = body.querySelector("#hr-draft-reply");
  if (draftBtn) {
    draftBtn.addEventListener("click", async () => {
      const st = body.querySelector("#hr-msg-status");
      st.textContent = "Drafting…"; st.className = "hr-status"; draftBtn.disabled = true;
      try {
        const d = await hrApi("/api/hr/applicants/" + id + "/draft-reply", { method: "POST" });
        body.querySelector("#hr-msg-subject").value = d.subject || "";
        body.querySelector("#hr-msg-body").value = d.body || "";
        st.textContent = (d.ai ? "AI draft ready — review before sending." : "Draft ready.") + (d.escalate ? " ⚠ Sensitive topic — a person should handle this personally." : "");
        st.className = "hr-status " + (d.escalate ? "err" : "ok");
      } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
      draftBtn.disabled = false;
    });
  }
  const schedEmailBtn = body.querySelector("#hr-sched-email");
  if (schedEmailBtn) {
    schedEmailBtn.addEventListener("click", async () => {
      const st = body.querySelector("#hr-sched-status");
      st.textContent = "Sending…"; st.className = "hr-status";
      try {
        const r = await hrApi("/api/hr/applicants/" + id + "/schedule-link", { method: "POST", body: { send: true } });
        st.textContent = r.sent ? "Scheduling link emailed." : "Link ready (no email on file).";
        st.className = "hr-status ok";
      } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
    });
  }
  const schedCopyBtn = body.querySelector("#hr-sched-copy");
  if (schedCopyBtn) {
    schedCopyBtn.addEventListener("click", async () => {
      const st = body.querySelector("#hr-sched-status");
      try {
        const r = await hrApi("/api/hr/applicants/" + id + "/schedule-link", { method: "POST", body: {} });
        if (navigator.clipboard) navigator.clipboard.writeText(r.url);
        st.textContent = "Copied: " + r.url; st.className = "hr-status ok";
      } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
    });
  }
  const sendMsgBtn = body.querySelector("#hr-send-msg");
  if (sendMsgBtn) {
    sendMsgBtn.addEventListener("click", async () => {
      const subject = body.querySelector("#hr-msg-subject").value.trim();
      const msgBody = body.querySelector("#hr-msg-body").value.trim();
      const st = body.querySelector("#hr-msg-status");
      if (!subject || !msgBody) { st.textContent = "Subject and message are required."; st.className = "hr-status err"; return; }
      st.textContent = "Sending…"; st.className = "hr-status"; sendMsgBtn.disabled = true;
      try {
        const r = await hrApi("/api/hr/applicants/" + id + "/send-message", { method: "POST", body: { subject, body: msgBody } });
        if (r.ok) {
          hrRenderCandidate(mount, id);
        } else {
          st.textContent = "Not sent: " + (r.skipped || r.delivered || "unknown"); st.className = "hr-status err"; sendMsgBtn.disabled = false;
        }
      } catch (e) { st.textContent = e.message; st.className = "hr-status err"; sendMsgBtn.disabled = false; }
    });
  }
}

// ---------------- Timecards: Timecard Management Hub ----------------
// One pay period at a time: summary cards, a compact employee table with a
// single action menu per row, bulk actions, a detail panel, and an archive of
// fully-signed periods. Built on the same endpoints the old list used --
// sending, previewing, the sent-email view, signed PDFs and owner-only delete
// all go through the routes they always did. Nothing on this screen edits
// hours or a signed document.

const TC_STATUS = {
  not_sent: { label: "Not sent", cls: "ns" },
  awaiting: { label: "Awaiting signature", cls: "aw" },
  overdue: { label: "Overdue", cls: "od" },
  signed: { label: "Signed", cls: "sg" },
  changes: { label: "Changes requested", cls: "ch" },
};

const TCHub = {
  view: "period",          // period | archive
  period: null,            // { start, end } -- null = let the server pick
  filters: { q: "", status: "", position: "", sent: "", signed: "" },
  selected: new Set(),
  filtersOpen: false,
  data: null,
  result: null,            // last bulk-action summary { kind, html }
  busy: false,
};

function hrTcInjectStyles() {
  if (document.getElementById("hr-tc-styles")) return;
  const s = document.createElement("style");
  s.id = "hr-tc-styles";
  s.textContent = `
    .tch { --tc-navy: var(--brand-navy,#1b2a6b); --tc-cream:#faf6ee; --tc-cream-2:#f4efe3; --tc-line:#ece6d8; }
    .tch-top { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
    .tch-viewtabs { display:inline-flex; background:var(--tc-cream-2); border-radius:10px; padding:3px; }
    .tch-viewtabs button { border:none; background:none; padding:7px 14px; border-radius:8px; font-size:13px; font-weight:600; color:var(--text-muted,#6b6a86); cursor:pointer; }
    .tch-viewtabs button.on { background:#fff; color:var(--tc-navy); box-shadow:0 1px 2px rgba(27,42,107,.12); }
    .tch-period { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .tch-period select { padding:8px 10px; border:1px solid var(--border,#d1d5db); border-radius:8px; font-size:14px; font-weight:600; color:var(--tc-navy); background:#fff; max-width:100%; }
    .tch-cards { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:10px; margin-bottom:12px; }
    .tch-card { text-align:left; background:#fff; border:1px solid var(--tc-line); border-radius:12px; padding:11px 12px; cursor:pointer; font:inherit; color:inherit; min-width:0; }
    .tch-card:hover { border-color:var(--tc-navy); }
    .tch-card.on { border-color:var(--tc-navy); box-shadow:0 0 0 2px rgba(27,42,107,.15); }
    .tch-card .n { font-size:22px; font-weight:700; color:var(--tc-navy); line-height:1.1; }
    .tch-card .l { font-size:11.5px; color:var(--text-muted,#6b6a86); margin-top:3px; }
    .tch-card.warn .n { color:#b45309; } .tch-card.bad .n { color:#b91c1c; } .tch-card.good .n { color:#15803d; }
    .tch-card.static { cursor:default; background:var(--tc-cream); }
    .tch-toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:10px; }
    .tch-toolbar .grow { flex:1 1 200px; min-width:0; }
    .tch-search { width:100%; box-sizing:border-box; padding:9px 12px; border:1px solid var(--border,#d1d5db); border-radius:8px; font-size:14px; }
    .tch-filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
    .tch-filters select { padding:7px 9px; border:1px solid var(--border,#d1d5db); border-radius:8px; font-size:13px; background:#fff; }
    .tch-filter-toggle { display:none; }
    .tch-list { background:#fff; border:1px solid var(--tc-line); border-radius:12px; overflow:hidden; }
    .tch-row { display:grid; grid-template-columns:30px minmax(0,2.2fr) 70px minmax(0,1.4fr) 80px 80px 40px; align-items:center; gap:8px; padding:8px 12px; border-top:1px solid #f1ede3; font-size:13.5px; }
    .tch-row:first-child { border-top:none; }
    .tch-row.head { background:var(--tc-cream); font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted,#6b6a86); font-weight:600; padding-top:9px; padding-bottom:9px; }
    .tch-row.sel { background:#f3f4fb; }
    .tch-name { font-weight:600; color:var(--tc-navy); background:none; border:none; padding:0; text-align:left; cursor:pointer; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
    .tch-name:hover { text-decoration:underline; }
    .tch-sub { font-size:11.5px; color:var(--text-muted,#6b6a86); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .tch-num { font-variant-numeric:tabular-nums; }
    .tch-meta-m { display:none; }
    .tch-pill { display:inline-flex; align-items:center; gap:5px; border-radius:999px; padding:2px 9px; font-size:11.5px; font-weight:600; white-space:nowrap; }
    .tch-pill::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
    .tch-pill.ns { background:#f1f1f4; color:#5b5b6b; }
    .tch-pill.aw { background:#e8ecfa; color:var(--tc-navy); }
    .tch-pill.od { background:#fde8e8; color:#b91c1c; }
    .tch-pill.sg { background:#dcfce7; color:#15803d; }
    .tch-pill.ch { background:#fdf0d5; color:#92400e; }
    .tch-dots { width:32px; height:32px; border-radius:8px; border:1px solid transparent; background:none; cursor:pointer; font-size:18px; line-height:1; color:var(--tc-navy); }
    .tch-dots:hover, .tch-dots.open { background:var(--tc-cream-2); border-color:var(--tc-line); }
    .tch-menu { position:fixed; z-index:1100; background:#fff; border:1px solid var(--tc-line); border-radius:10px; box-shadow:0 12px 32px rgba(27,42,107,.18); padding:5px; min-width:210px; }
    .tch-menu button, .tch-menu a { display:block; width:100%; text-align:left; background:none; border:none; padding:9px 11px; border-radius:7px; font-size:13.5px; color:var(--text,#201a4d); text-decoration:none; cursor:pointer; box-sizing:border-box; }
    .tch-menu button:hover, .tch-menu a:hover { background:var(--tc-cream); }
    .tch-menu button[disabled] { color:#a3a3b2; cursor:default; background:none; }
    .tch-menu .danger { color:#b91c1c; }
    .tch-menu hr { border:none; border-top:1px solid #f1ede3; margin:4px 0; }
    .tch-bulk { position:sticky; bottom:10px; z-index:20; display:flex; align-items:center; gap:8px; flex-wrap:wrap; background:var(--tc-navy); color:#fff; border-radius:12px; padding:9px 12px; margin-top:10px; box-shadow:0 10px 24px rgba(27,42,107,.25); }
    .tch-bulk .cnt { font-weight:700; margin-right:4px; }
    .tch-bulk button { background:rgba(255,255,255,.14); color:#fff; border:1px solid rgba(255,255,255,.25); border-radius:8px; padding:6px 11px; font-size:12.5px; font-weight:600; cursor:pointer; }
    .tch-bulk button:hover { background:rgba(255,255,255,.24); }
    .tch-bulk button[disabled] { opacity:.5; cursor:default; }
    .tch-result { border-radius:10px; padding:10px 12px; margin-bottom:10px; font-size:13px; background:#ecfdf3; border:1px solid #bbf7d0; color:#14532d; }
    .tch-result.err { background:#fef2f2; border-color:#fecaca; color:#7f1d1d; }
    .tch-result button { float:right; border:none; background:none; cursor:pointer; color:inherit; font-size:16px; line-height:1; }
    .tch-empty { padding:28px 16px; text-align:center; color:var(--text-muted,#6b6a86); font-size:13.5px; }
    .tch-arch { display:grid; grid-template-columns:minmax(0,1.6fr) 80px 80px 1fr; gap:8px; align-items:center; padding:9px 12px; border-top:1px solid #f1ede3; font-size:13.5px; }
    .tch-arch:first-child { border-top:none; }
    .tch-arch .acts { display:flex; gap:6px; justify-content:flex-end; flex-wrap:wrap; }
    .tch-more { margin-top:16px; }
    .tch-more > summary { cursor:pointer; font-size:13px; font-weight:600; color:var(--tc-navy); padding:8px 0; }
    .tch-panel-back { position:fixed; inset:0; background:rgba(28,23,64,.4); z-index:990; display:flex; justify-content:flex-end; }
    .tch-panel { background:#fff; width:min(560px,100%); height:100%; overflow-y:auto; box-shadow:-12px 0 40px rgba(28,23,64,.25); display:flex; flex-direction:column; }
    .tch-panel-h { position:sticky; top:0; background:var(--tc-navy,#1b2a6b); color:#fff; padding:16px 18px; z-index:1; }
    .tch-panel-h h2 { margin:0; font-size:18px; color:#fff; }
    .tch-panel-h .sub { font-size:12.5px; opacity:.85; margin-top:3px; }
    .tch-panel-h .x { float:right; background:none; border:none; color:#fff; font-size:22px; cursor:pointer; line-height:1; }
    .tch-panel-b { padding:16px 18px 28px; }
    .tch-sec { margin-top:16px; }
    .tch-sec h3 { font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted,#6b6a86); margin:0 0 8px; }
    .tch-kv { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
    .tch-kv div { background:var(--tc-cream,#faf6ee); border-radius:10px; padding:9px 10px; }
    .tch-kv b { display:block; font-size:16px; color:var(--tc-navy,#1b2a6b); }
    .tch-kv span { font-size:11px; color:var(--text-muted,#6b6a86); }
    .tch-timeline { list-style:none; margin:0; padding:0; }
    .tch-timeline li { display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px dashed #eee; font-size:13px; }
    .tch-timeline li span:last-child { color:var(--text-muted,#6b6a86); text-align:right; }
    .tch-days { width:100%; border-collapse:collapse; font-size:13px; }
    .tch-days td, .tch-days th { padding:6px 4px; border-bottom:1px solid #f1ede3; text-align:left; }
    .tch-days th { font-size:11px; color:var(--text-muted,#6b6a86); text-transform:uppercase; }
    .tch-days td.r, .tch-days th.r { text-align:right; }
    .tch-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
    @media (max-width: 980px) { .tch-cards { grid-template-columns:repeat(3,minmax(0,1fr)); } }
    @media (max-width: 640px) {
      .hr-wrap { padding:14px 12px; }
      .tch-cards { grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .tch-card { padding:9px 10px; } .tch-card .n { font-size:19px; }
      .tch-filter-toggle { display:inline-block; }
      .tch-filters { display:none; } .tch-filters.open { display:flex; }
      .tch-filters select { flex:1 1 45%; min-width:0; }
      .tch-row.head { display:none; }
      .tch-row { grid-template-columns:26px minmax(0,1fr) 36px; gap:6px 8px; padding:9px 10px; }
      .tch-row .c-hours, .tch-row .c-status, .tch-row .c-sent, .tch-row .c-signed { display:none; }
      .tch-meta-m { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:3px; font-size:11.5px; color:var(--text-muted,#6b6a86); }
      .tch-arch { grid-template-columns:minmax(0,1fr) auto; }
      .tch-arch .c-n, .tch-arch .c-h { display:none; }
      .tch-panel { width:100%; }
      .tch-kv { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .tch-bulk { bottom:6px; }
      .tch-period select { width:100%; }
      .tch-period { width:100%; }
    }
  `;
  document.head.appendChild(s);
}

function hrTcShort(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}
// Pay-period dates are plain YYYY-MM-DD. Parsed as local dates so a period
// ending on the 15th never shows as the 14th west of UTC.
function hrTcDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  if (!m) return s ? String(s) : "?";
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function hrTcPeriodLabel(p) {
  if (!p) return "No pay period";
  return `${hrTcDay(p.pay_period_start)} – ${hrTcDay(p.pay_period_end)}`;
}
function hrTcHours(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return String(v);
}
function hrTcPill(st) {
  const s = TC_STATUS[st] || { label: st, cls: "ns" };
  return `<span class="tch-pill ${s.cls}">${hrEsc(s.label)}</span>`;
}

async function hrRenderTimecards(body) {
  hrTcInjectStyles();
  const qs = new URLSearchParams();
  if (TCHub.period) { qs.set("period_start", TCHub.period.start || ""); qs.set("period_end", TCHub.period.end || ""); }
  const [employees, data] = await Promise.all([
    hrApi("/api/hr/employees").catch(() => []),
    hrApi("/api/hr/timecards/hub" + (qs.toString() ? "?" + qs : "")),
  ]);
  TCHub.data = data;
  if (data.selected_period) TCHub.period = { start: data.selected_period.pay_period_start || "", end: data.selected_period.pay_period_end || "" };
  // Selections never outlive the rows they pointed at.
  const ids = new Set((data.timecards || []).map((t) => String(t.id)));
  [...TCHub.selected].forEach((id) => { if (!ids.has(id)) TCHub.selected.delete(id); });
  hrTcDraw(body, employees);
}

function hrTcFiltered() {
  const f = TCHub.filters;
  const q = f.q.trim().toLowerCase();
  return ((TCHub.data && TCHub.data.timecards) || []).filter((t) => {
    if (q && !String(t.employee_name || "").toLowerCase().includes(q)) return false;
    if (f.status === "pending" && !["awaiting", "overdue"].includes(t.hub_status)) return false;
    if (f.status && f.status !== "pending" && t.hub_status !== f.status) return false;
    if (f.position && (t.role_title || "") !== f.position) return false;
    if (f.sent === "sent" && t.hub_status === "not_sent") return false;
    if (f.sent === "unsent" && t.hub_status !== "not_sent") return false;
    if (f.signed === "signed" && t.hub_status !== "signed") return false;
    if (f.signed === "unsigned" && t.hub_status === "signed") return false;
    return true;
  });
}

function hrTcDraw(body, employees) {
  const canManage = hrCanManage();
  const d = TCHub.data || { periods: [], timecards: [] };
  const all = d.timecards || [];
  const rows = hrTcFiltered();
  const sel = TCHub.selected;
  const count = (st) => all.filter((t) => t.hub_status === st).length;
  const pending = count("awaiting") + count("overdue");
  const hours = all.reduce((s, t) => s + (Number(t.total_hours) || 0), 0);
  const f = TCHub.filters;
  const card = (key, n, label, tone) => `<button class="tch-card ${tone || ""} ${f.status === key ? "on" : ""}" data-tccard="${key}"><div class="n">${n}</div><div class="l">${hrEsc(label)}</div></button>`;

  const openP = (d.periods || []).filter((p) => !p.complete);
  const doneP = (d.periods || []).filter((p) => p.complete);
  const curKey = TCHub.period ? `${TCHub.period.start}|${TCHub.period.end}` : "";
  const opt = (p) => {
    const k = `${p.pay_period_start || ""}|${p.pay_period_end || ""}`;
    return `<option value="${hrEsc(k)}" ${k === curKey ? "selected" : ""}>${hrEsc(hrTcPeriodLabel(p))} · ${p.signed}/${p.total} signed</option>`;
  };
  const periodSelect = (d.periods || []).length
    ? `<select id="tc-period" aria-label="Payroll period">${openP.length ? `<optgroup label="Open periods">${openP.map(opt).join("")}</optgroup>` : ""}${doneP.length ? `<optgroup label="Completed (all signed)">${doneP.map(opt).join("")}</optgroup>` : ""}</select>`
    : "";

  const positions = [...new Set(all.map((t) => t.role_title).filter(Boolean))].sort();
  const sel2 = (id, cur, opts) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${cur === v ? "selected" : ""}>${hrEsc(l)}</option>`).join("")}</select>`;

  const result = TCHub.result
    ? `<div class="tch-result ${TCHub.result.err ? "err" : ""}" id="tc-hub-result"><button data-x title="Dismiss">×</button>${TCHub.result.html}</div>` : "";

  const visibleIds = rows.map((t) => String(t.id));
  const allVisibleSelected = visibleIds.length && visibleIds.every((id) => sel.has(id));
  const rowHtml = (t) => {
    const id = String(t.id);
    const sentAt = t.first_sent_at || t.verification_requested_at;
    const sentLbl = t.hub_status === "not_sent" ? "—" : hrTcShort(sentAt);
    const signedLbl = t.hub_status === "signed" ? hrTcShort(t.accepted_at) : "—";
    const sub = [t.role_title, TCHub.data.searching_all ? `${hrTcDay(t.pay_period_start)} – ${hrTcDay(t.pay_period_end)}` : "", !t.has_email ? "no email on file" : "", Number(t.open_flags) ? `${t.open_flags} open flag${Number(t.open_flags) === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    return `<div class="tch-row ${sel.has(id) ? "sel" : ""}" data-row="${id}">
      <div>${canManage ? `<input type="checkbox" class="tc-pick" value="${id}" ${sel.has(id) ? "checked" : ""} aria-label="Select ${hrEsc(t.employee_name || "timecard")}"/>` : ""}</div>
      <div style="min-width:0">
        <button class="tch-name" data-tc="${id}">${hrEsc(t.employee_name || "Unassigned")}</button>
        ${sub ? `<div class="tch-sub">${hrEsc(sub)}</div>` : ""}
        <div class="tch-meta-m">${hrTcPill(t.hub_status)}<span class="tch-num">${hrTcHours(t.total_hours)}h</span>${t.hub_status !== "not_sent" ? `<span>Sent ${hrEsc(sentLbl)}</span>` : ""}${t.hub_status === "signed" ? `<span>Signed ${hrEsc(signedLbl)}</span>` : ""}</div>
      </div>
      <div class="c-hours tch-num">${hrTcHours(t.total_hours)}</div>
      <div class="c-status">${hrTcPill(t.hub_status)}</div>
      <div class="c-sent tch-num" title="${t.verification_requested_at && t.verification_requested_at !== sentAt ? "Last sent " + hrEsc(hrFmtDateTime(t.verification_requested_at)) : ""}">${hrEsc(sentLbl)}</div>
      <div class="c-signed tch-num">${hrEsc(signedLbl)}</div>
      <div style="text-align:right"><button class="tch-dots" data-tcmenu="${id}" aria-label="Actions for ${hrEsc(t.employee_name || "timecard")}" title="Actions">⋯</button></div>
    </div>`;
  };

  const signedInPeriod = count("signed");
  const periodView = `
    <div class="tch-cards">
      ${card("", all.length, "Total timecards")}
      ${card("pending", pending, "Pending signatures", pending ? "warn" : "")}
      ${card("signed", signedInPeriod, "Signed", signedInPeriod && signedInPeriod === all.length ? "good" : "")}
      ${card("not_sent", count("not_sent"), "Not yet sent")}
      ${card("overdue", count("overdue"), "Overdue", count("overdue") ? "bad" : "")}
      <div class="tch-card static"><div class="n tch-num">${hrTcHours(hours)}</div><div class="l">Total hours</div></div>
    </div>
    ${result}
    <div class="tch-toolbar">
      <div class="grow"><input class="tch-search" id="tc-search" type="search" placeholder="Search employees in this period" value="${hrEsc(f.q)}"/></div>
      <button class="hr-btn sm ghost tch-filter-toggle" id="tc-filter-toggle">Filters${["status", "position", "sent", "signed"].some((k) => f[k]) ? " •" : ""}</button>
      ${canManage && all.length ? `<button class="hr-btn sm ghost" id="tc-resend-pending" ${pending ? "" : "disabled"}>Resend to pending (${pending})</button>
      <button class="hr-btn sm ghost" id="tc-zip-period" ${signedInPeriod ? "" : "disabled"}>Download all signed (ZIP)</button>
      <a class="hr-btn sm ghost" id="tc-csv-period" style="text-decoration:none" href="/api/hr/timecards/export.csv?period_start=${encodeURIComponent(TCHub.period ? TCHub.period.start : "")}&period_end=${encodeURIComponent(TCHub.period ? TCHub.period.end : "")}">Export CSV</a>` : ""}
    </div>
    <div class="tch-filters ${TCHub.filtersOpen ? "open" : ""}" id="tc-filters">
      ${sel2("tc-f-status", f.status, [["", "All statuses"], ["not_sent", "Not sent"], ["pending", "Pending (awaiting + overdue)"], ["awaiting", "Awaiting signature"], ["overdue", "Overdue"], ["signed", "Signed"], ["changes", "Changes requested"]])}
      ${sel2("tc-f-position", f.position, [["", "All positions"], ...positions.map((p) => [hrEsc(p), p])])}
      ${sel2("tc-f-signed", f.signed, [["", "Signed + unsigned"], ["signed", "Signed only"], ["unsigned", "Unsigned only"]])}
      ${sel2("tc-f-sent", f.sent, [["", "Sent + unsent"], ["sent", "Sent only"], ["unsent", "Unsent only"]])}
      ${["status", "position", "sent", "signed"].some((k) => f[k]) || f.q ? `<button class="hr-btn sm ghost" id="tc-f-clear">Clear</button>` : ""}
    </div>
    <div class="tch-list" id="tc-list">
      ${all.length ? `<div class="tch-row head">
        <div>${canManage ? `<input type="checkbox" id="tc-check-all" title="Select all shown" ${allVisibleSelected ? "checked" : ""}/>` : ""}</div>
        <div>Employee</div><div>Hours</div><div>Status</div><div>Sent</div><div>Signed</div><div></div>
      </div>` : ""}
      ${rows.map(rowHtml).join("") || `<div class="tch-empty">${all.length ? "No timecards match these filters." : "No timecards for this pay period yet. Use Build timecards to create them."}</div>`}
    </div>
    ${canManage && sel.size ? `<div class="tch-bulk" id="tc-bulk">
      <span class="cnt">${sel.size} selected</span>
      <button id="tc-send-selected">Send / resend</button>
      <button id="tc-zip-selected">Download signed PDFs</button>
      <button id="tc-csv-selected">Export CSV</button>
      <button id="tc-sel-clear">Clear</button>
    </div>` : ""}`;

  const archive = hrTcArchiveHtml();

  const empRows = employees.length
    ? employees.map((e) => {
        const creds = (e.credentials || []).map((c) => `<span class="hr-badge">${hrEsc(c.credential_type)}${c.expiration_date ? " · exp " + hrFmtDate(c.expiration_date) : ""}</span>`).join(" ");
        return `<div style="padding:8px 0;border-bottom:1px solid #f0f0f3"><strong>${hrEsc(e.name)}</strong> <span class="hr-muted">${hrEsc(e.role_title || "")}</span><div style="margin-top:4px">${creds || '<span class="hr-muted">No credentials on file</span>'} ${canManage ? `<button class="hr-btn sm ghost" data-addcred="${e.id}">+ Credential</button>` : ""}</div></div>`;
      }).join("")
    : `<p class="hr-muted">No employees yet.</p>`;

  body.innerHTML = `<div class="tch">
    <div class="tch-top">
      <div class="tch-viewtabs" role="tablist">
        <button data-tcview="period" class="${TCHub.view === "period" ? "on" : ""}">Pay period</button>
        <button data-tcview="archive" class="${TCHub.view === "archive" ? "on" : ""}">Archive</button>
      </div>
      <div class="hr-row">
        ${canManage ? `<button class="hr-btn sm" id="tc-open-builder">Build timecards…</button><button class="hr-btn sm ghost" id="tc-settings">Reminders</button>` : ""}
        <span class="hr-status" id="tc-builder-status"></span>
      </div>
    </div>
    ${TCHub.view === "period" ? `<div class="tch-period" style="margin-bottom:12px">${periodSelect || `<span class="hr-muted">No pay periods yet.</span>`}</div>${periodView}` : archive}
    <details class="tch-more"><summary>Employees &amp; credentials</summary>
      <div class="hr-card" style="margin-top:6px">
        ${canManage ? `<div class="hr-2col"><div class="hr-field"><label>Name</label><input id="emp-name"/></div><div class="hr-field"><label>Email</label><input id="emp-email"/></div></div>
        <div class="hr-2col"><div class="hr-field"><label>Role title</label><input id="emp-role"/></div><div class="hr-field"><label>Employment type</label><input id="emp-type" placeholder="full_time / part_time"/></div></div>
        <div class="hr-row"><button class="hr-btn sm" id="emp-add">Add employee</button><span class="hr-status" id="emp-status"></span></div><hr style="border:none;border-top:1px solid #eee;margin:12px 0"/>` : ""}
        ${empRows}
      </div>
    </details>
    <p class="hr-lock" style="margin-top:10px">Nothing on this page changes payroll hours or a signed timecard. Emails only go out when you send them${TCHub.data && TCHub.data.settings && TCHub.data.settings.auto_reminders ? ", plus the automatic reminders you switched on" : ""}.</p>
  </div>`;

  hrTcWire(body, employees);
}

function hrTcArchiveHtml() {
  const d = TCHub.data || { periods: [] };
  const done = (d.periods || []).filter((p) => p.complete);
  const searchRows = TCHub.archiveSearch;
  const list = done.length
    ? `<div class="tch-list">${done.map((p) => `<div class="tch-arch">
        <div><strong style="color:var(--brand-navy,#1b2a6b)">${hrEsc(hrTcPeriodLabel(p))}</strong><div class="tch-sub">${p.total} timecard${p.total === 1 ? "" : "s"} · ${hrTcHours(p.total_hours)} hours · all signed</div></div>
        <div class="c-n tch-num">${p.total}</div><div class="c-h tch-num">${hrTcHours(p.total_hours)}h</div>
        <div class="acts"><button class="hr-btn sm ghost" data-arch-open="${hrEsc((p.pay_period_start || "") + "|" + (p.pay_period_end || ""))}">Open</button>${hrCanManage() ? `<button class="hr-btn sm ghost" data-arch-zip="${hrEsc((p.pay_period_start || "") + "|" + (p.pay_period_end || ""))}">ZIP</button>` : ""}</div>
      </div>`).join("")}</div>`
    : `<div class="tch-empty" style="border:1px dashed var(--border,#e5e7eb);border-radius:12px">No completed pay periods yet. A period moves here once every timecard in it is signed. Nothing is ever deleted.</div>`;
  const results = searchRows
    ? `<div class="tch-list" style="margin-bottom:14px">${searchRows.length ? searchRows.map((t) => `<div class="tch-arch">
        <div style="min-width:0"><button class="tch-name" data-tc="${t.id}">${hrEsc(t.employee_name || "Unassigned")}</button><div class="tch-sub">${hrEsc(hrTcDay(t.pay_period_start))} – ${hrEsc(hrTcDay(t.pay_period_end))} · ${hrTcHours(t.total_hours)}h</div></div>
        <div class="c-n">${hrTcPill(t.hub_status)}</div><div class="c-h tch-num">${t.hub_status === "signed" ? hrEsc(hrTcShort(t.accepted_at)) : ""}</div>
        <div class="acts">${t.pdf_doc_id ? `<a class="hr-btn sm ghost" style="text-decoration:none" href="/api/hr/employee-documents/${t.pdf_doc_id}" target="_blank">Signed PDF</a>` : ""}<button class="hr-btn sm ghost" data-arch-open="${hrEsc((t.pay_period_start || "") + "|" + (t.pay_period_end || ""))}">Period</button></div>
      </div>`).join("") : `<div class="tch-empty">No timecards found for that name.</div>`}</div>`
    : "";
  return `<div class="tch-toolbar"><div class="grow"><input class="tch-search" id="tc-arch-q" type="search" placeholder="Find a timecard in any pay period by employee name" value="${hrEsc(TCHub.archiveQ || "")}"/></div><button class="hr-btn sm" id="tc-arch-go">Search</button>${searchRows ? `<button class="hr-btn sm ghost" id="tc-arch-clear">Clear</button>` : ""}</div>
    ${results}
    <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted,#6b6a86);margin:6px 0 8px">Completed pay periods</h2>
    ${list}`;
}

function hrTcSetResult(html, err) { TCHub.result = { html, err: !!err }; }
function hrTcNames(list) { return list.map((n) => hrEsc(n)).join(", "); }

function hrTcSendSummary(r, verb) {
  const parts = [`<strong>${verb} ${r.sent} timecard${r.sent === 1 ? "" : "s"}.</strong>`];
  if (r.already_signed && r.already_signed.length) parts.push(`Skipped ${r.already_signed.length} already signed: ${hrTcNames(r.already_signed)}.`);
  if (r.just_sent && r.just_sent.length) parts.push(`Skipped ${r.just_sent.length} sent within the last minute (no duplicate emails): ${hrTcNames(r.just_sent)}.`);
  if (r.skipped && r.skipped.length) parts.push(`Not sent, no email on file: ${hrTcNames(r.skipped)}. Add their email under Employees &amp; credentials, then resend.`);
  return parts.join(" ");
}

async function hrTcDownloadZip(payload) {
  const res = await fetch("/api/hr/timecards/signed-zip", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = "Download failed.";
    try { const j = await res.json(); msg = j.error || msg; } catch (e) { /* not json */ }
    throw new Error(msg);
  }
  const skipped = Number(res.headers.get("X-Skipped-Count") || 0);
  const cd = res.headers.get("Content-Disposition") || "";
  const m = /filename="([^"]+)"/.exec(cd);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = m ? decodeURIComponent(m[1]) : "signed-timecards.zip";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return { skipped };
}

// One action menu, floated on the page and placed next to the button that
// opened it, so it is never clipped by the list and never makes the page
// scroll sideways on a phone.
function hrTcCloseMenu() {
  document.querySelectorAll(".tch-menu").forEach((m) => m.remove());
  document.querySelectorAll(".tch-dots.open").forEach((b) => b.classList.remove("open"));
}
function hrTcOpenMenu(btn, tc, body) {
  const wasOpen = btn.classList.contains("open");
  hrTcCloseMenu();
  if (wasOpen) return;
  const canManage = hrCanManage();
  const sent = tc.hub_status !== "not_sent";
  const signed = tc.hub_status === "signed";
  const items = [];
  items.push(`<button data-tc="${tc.id}">View timecard</button>`);
  if (canManage && !signed) items.push(`<button data-tcpreview="${tc.id}">Preview email</button>`);
  // Only once something has actually gone out -- a history button on a
  // timecard nobody has sent can only report nothing.
  if (canManage && tc.verification_requested_at) items.push(`<button data-tcsent="${tc.id}">View email history</button>`);
  if (canManage && !signed) items.push(`<button data-tcsend="${tc.id}">${sent ? "Resend email" : "Send email"}</button>`);
  if (tc.pdf_doc_id) {
    items.push(`<a href="/api/hr/employee-documents/${tc.pdf_doc_id}?inline=1" target="_blank" rel="noopener">View signed PDF</a>`);
    items.push(`<a href="/api/hr/employee-documents/${tc.pdf_doc_id}">Download signed PDF</a>`);
  }
  if (hrCanDelete()) items.push(`<hr/><button class="danger" data-tcdel="${tc.id}" data-tcwho="${hrEsc(tc.employee_name || "this timecard")}">Delete timecard</button>`);
  const menu = document.createElement("div");
  menu.className = "tch-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = items.join("");
  document.body.appendChild(menu);
  btn.classList.add("open");
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  hrTcWireActions(menu, body, true);
}

// Row and menu actions share one wiring so the menu, the detail panel and the
// archive search results all behave the same way.
function hrTcWireActions(root, body, fromMenu) {
  const refresh = () => hrRenderTimecards(body);
  const done = () => { if (fromMenu) hrTcCloseMenu(); };
  root.querySelectorAll("[data-tc]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); done(); hrOpenTimecardDetail(b.dataset.tc, body); }));
  root.querySelectorAll("[data-tcpreview]").forEach((b) => b.addEventListener("click", () => { done(); hrOpenTimecardPreview(b.dataset.tcpreview, body); }));
  root.querySelectorAll("[data-tcsent]").forEach((b) => b.addEventListener("click", () => { done(); hrOpenTimecardSentEmails(b.dataset.tcsent); }));
  root.querySelectorAll("a[href]").forEach((a) => a.addEventListener("click", () => done()));
  root.querySelectorAll("[data-tcsend]").forEach((b) => b.addEventListener("click", async () => {
    if (b.disabled) return;
    b.disabled = true; const old = b.textContent; b.textContent = "Sending…";
    try {
      const r = await hrApi("/api/hr/timecards/" + b.dataset.tcsend + "/request-verification", { method: "POST", body: {} });
      done();
      const t = ((TCHub.data && TCHub.data.timecards) || []).find((x) => String(x.id) === String(b.dataset.tcsend));
      const who = hrEsc((t && t.employee_name) || "the employee");
      if (r.sent) hrTcSetResult(`<strong>Timecard emailed to ${who}.</strong>`);
      else if (r.reason === "just_sent" || r.reason === "in_progress") hrTcSetResult(`Already sent to ${who} within the last minute, so it was not sent again.`);
      else hrTcSetResult(`Link created, but ${who} has no email on file. Add their email under Employees &amp; credentials, then resend.`, true);
      refresh();
    } catch (e) { alert(e.message); b.disabled = false; b.textContent = old; }
  }));
  root.querySelectorAll("[data-tcdel]").forEach((b) => b.addEventListener("click", async () => {
    done();
    if (!confirm(`Delete the timecard for ${b.dataset.tcwho}? This removes the imported hours and cannot be undone. (Any signed PDF already filed is kept.)`)) return;
    b.disabled = true;
    try {
      await hrApi("/api/hr/timecards/" + b.dataset.tcdel, { method: "DELETE" });
      TCHub.selected.delete(String(b.dataset.tcdel));
      hrTcSetResult(`Timecard for ${hrEsc(b.dataset.tcwho)} deleted.`);
      refresh();
    } catch (e) { alert(e.message || "Could not delete."); b.disabled = false; }
  }));
}

function hrTcWire(body, employees) {
  const canManage = hrCanManage();
  const redraw = () => hrTcDraw(body, employees);
  const refresh = () => hrRenderTimecards(body);
  const rowsById = new Map(((TCHub.data && TCHub.data.timecards) || []).map((t) => [String(t.id), t]));

  body.querySelectorAll("[data-tcview]").forEach((b) => b.addEventListener("click", () => {
    TCHub.view = b.dataset.tcview; TCHub.result = null; redraw();
  }));
  const res = body.querySelector("#tc-hub-result [data-x]");
  if (res) res.addEventListener("click", () => { TCHub.result = null; redraw(); });

  const per = body.querySelector("#tc-period");
  if (per) per.addEventListener("change", () => {
    const [start, end] = per.value.split("|");
    TCHub.period = { start, end }; TCHub.selected.clear(); TCHub.result = null;
    TCHub.filters = { q: "", status: "", position: "", sent: "", signed: "" };
    refresh();
  });

  body.querySelectorAll("[data-tccard]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.tccard;
    TCHub.filters.status = TCHub.filters.status === k ? "" : k;
    if (k === "") TCHub.filters.status = "";
    TCHub.filters.signed = ""; TCHub.filters.sent = "";
    redraw();
  }));

  // Search filters in place without redrawing the box being typed in.
  const search = body.querySelector("#tc-search");
  if (search) {
    let tmr = null;
    search.addEventListener("input", () => {
      clearTimeout(tmr);
      tmr = setTimeout(() => {
        TCHub.filters.q = search.value;
        const pos = search.selectionStart;
        redraw();
        const again = body.querySelector("#tc-search");
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* type=search */ } }
      }, 160);
    });
  }
  const ft = body.querySelector("#tc-filter-toggle");
  if (ft) ft.addEventListener("click", () => { TCHub.filtersOpen = !TCHub.filtersOpen; redraw(); });
  [["tc-f-status", "status"], ["tc-f-position", "position"], ["tc-f-signed", "signed"], ["tc-f-sent", "sent"]].forEach(([id, key]) => {
    const el = body.querySelector("#" + id);
    if (el) el.addEventListener("change", () => { TCHub.filters[key] = el.value; redraw(); });
  });
  const fc = body.querySelector("#tc-f-clear");
  if (fc) fc.addEventListener("click", () => { TCHub.filters = { q: "", status: "", position: "", sent: "", signed: "" }; redraw(); });

  // Selection.
  body.querySelectorAll(".tc-pick").forEach((c) => c.addEventListener("change", () => {
    if (c.checked) TCHub.selected.add(c.value); else TCHub.selected.delete(c.value);
    redraw();
  }));
  const allBox = body.querySelector("#tc-check-all");
  if (allBox) allBox.addEventListener("change", () => {
    hrTcFiltered().forEach((t) => { if (allBox.checked) TCHub.selected.add(String(t.id)); else TCHub.selected.delete(String(t.id)); });
    redraw();
  });
  const clr = body.querySelector("#tc-sel-clear");
  if (clr) clr.addEventListener("click", () => { TCHub.selected.clear(); redraw(); });

  // Menus.
  body.querySelectorAll("[data-tcmenu]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const t = rowsById.get(String(b.dataset.tcmenu));
    if (t) hrTcOpenMenu(b, t, body);
  }));
  if (!window.__tcMenuCloser) {
    window.__tcMenuCloser = true;
    document.addEventListener("click", (e) => { if (!e.target.closest(".tch-menu") && !e.target.closest(".tch-dots")) hrTcCloseMenu(); });
    window.addEventListener("resize", hrTcCloseMenu);
    window.addEventListener("scroll", hrTcCloseMenu, true);
    window.addEventListener("hashchange", hrTcCloseMenu);
  }
  hrTcWireActions(body.querySelector("#tc-list") || body, body, false);

  // A guarded runner: one bulk action at a time, the button disabled while it
  // runs, so a double tap can't fire it twice.
  const run = async (btn, fn) => {
    if (TCHub.busy) return;
    TCHub.busy = true;
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Working…"; }
    try { await fn(); }
    catch (e) { hrTcSetResult(hrEsc(e.message || "Something went wrong."), true); }
    finally {
      TCHub.busy = false;
      if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = old; }
    }
  };
  const selectedIds = () => [...TCHub.selected];
  const per2 = TCHub.period || { start: "", end: "" };

  const rp = body.querySelector("#tc-resend-pending");
  if (rp) rp.addEventListener("click", () => {
    const n = ((TCHub.data && TCHub.data.timecards) || []).filter((t) => ["awaiting", "overdue"].includes(t.hub_status)).length;
    if (!confirm(`Send a signature reminder to ${n} employee${n === 1 ? "" : "s"} who haven't signed for ${hrTcPeriodLabel(TCHub.data.selected_period)}?`)) return;
    run(rp, async () => {
      const r = await hrApi("/api/hr/timecards/send-all", { method: "POST", body: { pay_period_start: per2.start, pay_period_end: per2.end, only_pending: true } });
      hrTcSetResult(hrTcSendSummary(r, "Reminded on"));
      await refresh();
    });
  });
  const zp = body.querySelector("#tc-zip-period");
  if (zp) zp.addEventListener("click", () => run(zp, async () => {
    const r = await hrTcDownloadZip({ pay_period_start: per2.start, pay_period_end: per2.end });
    hrTcSetResult(`<strong>Signed timecards downloaded.</strong>${r.skipped ? ` ${r.skipped} unsigned timecard${r.skipped === 1 ? " was" : "s were"} left out.` : ""}`);
    redraw();
  }));

  const ss = body.querySelector("#tc-send-selected");
  if (ss) ss.addEventListener("click", () => {
    const ids = selectedIds();
    const eligible = ids.filter((id) => { const t = rowsById.get(id); return t && t.hub_status !== "signed"; });
    if (!eligible.length) { hrTcSetResult("Everyone selected has already signed, so there is nothing to send.", true); redraw(); return; }
    const signedN = ids.length - eligible.length;
    if (!confirm(`Email the timecard to ${eligible.length} employee${eligible.length === 1 ? "" : "s"}?${signedN ? ` (${signedN} already signed will be skipped.)` : ""}`)) return;
    run(ss, async () => {
      const r = await hrApi("/api/hr/timecards/send", { method: "POST", body: { ids: eligible } });
      r.already_signed = (r.already_signed || []).concat(ids.filter((id) => !eligible.includes(id)).map((id) => (rowsById.get(id) || {}).employee_name || "#" + id));
      hrTcSetResult(hrTcSendSummary(r, "Sent"));
      TCHub.selected.clear();
      await refresh();
    });
  });
  const zs = body.querySelector("#tc-zip-selected");
  if (zs) zs.addEventListener("click", () => {
    const ids = selectedIds().filter((id) => { const t = rowsById.get(id); return t && t.pdf_doc_id; });
    if (!ids.length) { hrTcSetResult("None of the selected timecards has a signed PDF yet.", true); redraw(); return; }
    run(zs, async () => {
      await hrTcDownloadZip({ ids });
      const left = TCHub.selected.size - ids.length;
      hrTcSetResult(`<strong>Downloaded ${ids.length} signed PDF${ids.length === 1 ? "" : "s"}.</strong>${left ? ` ${left} selected without a signed PDF ${left === 1 ? "was" : "were"} left out.` : ""}`);
      redraw();
    });
  });
  const cs = body.querySelector("#tc-csv-selected");
  if (cs) cs.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = "/api/hr/timecards/export.csv?ids=" + encodeURIComponent(selectedIds().join(","));
    document.body.appendChild(a); a.click(); a.remove();
  });

  // Archive.
  const aq = body.querySelector("#tc-arch-q");
  const go = async () => {
    const q = (aq && aq.value.trim()) || "";
    TCHub.archiveQ = q;
    if (!q) { TCHub.archiveSearch = null; redraw(); return; }
    const r = await hrApi("/api/hr/timecards/hub?q=" + encodeURIComponent(q));
    TCHub.archiveSearch = r.timecards || [];
    redraw();
  };
  const ag = body.querySelector("#tc-arch-go");
  if (ag) ag.addEventListener("click", () => go().catch((e) => alert(e.message)));
  if (aq) aq.addEventListener("keydown", (e) => { if (e.key === "Enter") go().catch((er) => alert(er.message)); });
  const ac = body.querySelector("#tc-arch-clear");
  if (ac) ac.addEventListener("click", () => { TCHub.archiveQ = ""; TCHub.archiveSearch = null; redraw(); });
  body.querySelectorAll("[data-arch-open]").forEach((b) => b.addEventListener("click", () => {
    const [start, end] = b.dataset.archOpen.split("|");
    TCHub.period = { start, end }; TCHub.view = "period"; TCHub.selected.clear(); TCHub.result = null;
    TCHub.filters = { q: "", status: "", position: "", sent: "", signed: "" };
    refresh();
  }));
  body.querySelectorAll("[data-arch-zip]").forEach((b) => b.addEventListener("click", () => {
    const [start, end] = b.dataset.archZip.split("|");
    run(b, async () => { await hrTcDownloadZip({ pay_period_start: start, pay_period_end: end }); });
  }));
  if (TCHub.view === "archive") hrTcWireActions(body.querySelector(".tch") || body, body, false);

  if (!canManage) return;

  const builderBtn = body.querySelector("#tc-open-builder");
  if (builderBtn) builderBtn.addEventListener("click", () => {
    const st = body.querySelector("#tc-builder-status");
    if (typeof window.openPayrollImportModal !== "function") {
      if (st) { st.textContent = "Open Staff › Staff and use Import payroll → timecards."; st.className = "hr-status err"; }
      return;
    }
    // No page mount: there is no staff directory behind this modal to refresh
    // when it closes, and handing it this page's body would render the Staff
    // page into HR & Recruiting.
    window.openPayrollImportModal(null);
  });
  const setBtn = body.querySelector("#tc-settings");
  if (setBtn) setBtn.addEventListener("click", () => hrTcOpenSettings(body));

  const empAdd = body.querySelector("#emp-add");
  if (empAdd) empAdd.addEventListener("click", async () => {
    const st = body.querySelector("#emp-status");
    const name = body.querySelector("#emp-name").value.trim();
    if (!name) { st.textContent = "Name required."; st.className = "hr-status err"; return; }
    try {
      await hrApi("/api/hr/employees", { method: "POST", body: { name, email: body.querySelector("#emp-email").value, role_title: body.querySelector("#emp-role").value, employment_type: body.querySelector("#emp-type").value } });
      refresh();
    } catch (e) { st.textContent = e.message; st.className = "hr-status err"; }
  });
  body.querySelectorAll("[data-addcred]").forEach((b) => b.addEventListener("click", async () => {
    const type = window.prompt("Credential type (e.g. RBT, BCBA, CPR, background_check):", "");
    if (!type) return;
    const exp = window.prompt("Expiration date (YYYY-MM-DD, optional):", "");
    try { await hrApi("/api/hr/employees/" + b.dataset.addcred + "/credentials", { method: "POST", body: { credential_type: type, expiration_date: exp || null } }); refresh(); } catch (e) { alert(e.message); }
  }));
}

function hrTcOpenSettings(body) {
  const s = (TCHub.data && TCHub.data.settings) || { overdue_days: 3, auto_reminders: false, reminder_days: 2, max_reminders: 3 };
  const back = document.createElement("div");
  back.className = "hr-modal-back";
  back.innerHTML = `<div class="hr-modal" style="max-width:460px">
    <button class="hr-close" data-x>×</button>
    <h2>Signature reminders</h2>
    <div class="hr-field"><label>Mark a timecard Overdue when it is unsigned this many days after it was first sent</label><input type="number" id="tcs-overdue" min="1" max="60" value="${s.overdue_days}"/></div>
    <div class="hr-field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="tcs-auto" style="width:auto" ${s.auto_reminders ? "checked" : ""}/><label for="tcs-auto" style="margin:0">Send reminders automatically</label></div>
    <div class="hr-2col">
      <div class="hr-field"><label>Every (days)</label><input type="number" id="tcs-every" min="1" max="30" value="${s.reminder_days}"/></div>
      <div class="hr-field"><label>Stop after (reminders)</label><input type="number" id="tcs-max" min="1" max="10" value="${s.max_reminders}"/></div>
    </div>
    <p class="hr-muted" style="font-size:12px">Reminders go only to people who were sent their timecard and haven't signed. Anyone who asked for changes is left for you to handle first.</p>
    <div class="hr-row"><button class="hr-btn" id="tcs-save">Save</button><span class="hr-status" id="tcs-st"></span></div>
  </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelector("[data-x]").addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  back.querySelector("#tcs-save").addEventListener("click", async (e) => {
    const btn = e.currentTarget; const st = back.querySelector("#tcs-st");
    btn.disabled = true;
    try {
      await hrApi("/api/hr/timecards/hub-settings", { method: "POST", body: {
        overdue_days: Number(back.querySelector("#tcs-overdue").value),
        auto_reminders: back.querySelector("#tcs-auto").checked,
        reminder_days: Number(back.querySelector("#tcs-every").value),
        max_reminders: Number(back.querySelector("#tcs-max").value),
      } });
      close(); hrRenderTimecards(body);
    } catch (er) { st.textContent = er.message; st.className = "hr-status err"; btn.disabled = false; }
  });
}

// Detail panel: everything about one timecard without leaving the dashboard.
// Slides in from the right on a computer, fills the screen on a phone.
function hrOpenTimecardDetail(id, tcBody) {
  const canManage = hrCanManage();
  const back = document.createElement("div");
  back.className = "tch-panel-back";
  back.innerHTML = `<div class="tch-panel" role="dialog" aria-modal="true"><div class="tch-panel-h"><button class="x" data-x aria-label="Close">×</button><h2>Loading…</h2></div><div class="tch-panel-b" id="tcd-body"></div></div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelector("[data-x]").addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);

  Promise.all([
    hrApi("/api/hr/timecards/" + id),
    canManage ? hrApi("/api/hr/timecards/" + id + "/emails").catch(() => null) : Promise.resolve(null),
  ]).then(([tc, mail]) => {
    const row = ((TCHub.data && TCHub.data.timecards) || []).find((t) => String(t.id) === String(id)) || {};
    const hub = row.hub_status || (tc.status === "accepted" ? "signed" : tc.status === "edit_requested" ? "changes" : tc.verification_requested_at ? "awaiting" : "not_sent");
    const entries = tc.entries || [];
    const total = entries.reduce((s, e) => s + (Number(e.hours) || 0), 0);
    const byDay = new Map();
    entries.forEach((e) => {
      const k = e.date || "—";
      const cur = byDay.get(k) || { hours: 0, n: 0 };
      cur.hours += Number(e.hours) || 0; cur.n++;
      byDay.set(k, cur);
    });
    const days = [...byDay.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const emp = tc.employee || {};
    const name = emp.name || row.employee_name || "Unassigned";
    const sentFirst = tc.first_sent_at || tc.verification_requested_at;

    const timeline = [
      ["Generated", tc.created_at ? hrFmtDateTime(tc.created_at) : "—"],
      ["First emailed", sentFirst ? hrFmtDateTime(sentFirst) : "Not sent"],
      ...(tc.verification_requested_at && tc.verification_requested_at !== sentFirst ? [["Last emailed", hrFmtDateTime(tc.verification_requested_at)]] : []),
      ...(Number(tc.reminder_count) ? [["Automatic reminders", `${tc.reminder_count}${tc.last_reminder_at ? " · last " + hrFmtDateTime(tc.last_reminder_at) : ""}`]] : []),
      ["Signed", tc.status === "accepted" ? `${hrFmtDateTime(tc.accepted_at)}${tc.signed_name ? " · as " + tc.signed_name : ""}` : "Not signed"],
    ];

    const flags = tc.flags || [];
    const flagsHtml = flags.length ? flags.map((f) => `<div class="hr-note" style="border-left:3px solid ${["approved", "corrected"].includes(f.status) ? "#22c55e" : "#e0a430"}">
        <div><strong>${hrEsc(f.flag_type.replace(/_/g, " "))}</strong> — ${hrEsc(f.status)}</div>
        <div class="hr-muted">${hrEsc(f.detail)}</div>
        ${f.employee_explanation ? `<div style="margin-top:4px"><em>Employee:</em> ${hrEsc(f.employee_explanation)}</div>` : ""}
        ${canManage && !["approved", "corrected"].includes(f.status) ? `<div class="hr-row" style="margin-top:6px"><button class="hr-btn sm" data-resolve="${f.id}" data-st="approved">Approve</button><button class="hr-btn sm ghost" data-resolve="${f.id}" data-st="corrected">Mark corrected</button></div>` : ""}
      </div>`).join("") : "";

    const edited = Array.isArray(tc.edited_entries) ? tc.edited_entries : [];
    const changes = tc.status === "edit_requested" ? `<div class="hr-note" style="border-left:3px solid #e0a430;background:#fdf6e6;margin-top:12px">
        <div><strong>Employee requested changes</strong> — they did not accept as-is.</div>
        ${tc.employee_note ? `<div style="margin-top:4px"><em>Their note:</em> ${hrEsc(tc.employee_note)}</div>` : ""}
        ${edited.length ? `<table class="tch-days" style="margin-top:6px"><tr><th>Date</th><th>In</th><th>Out</th><th class="r">Hours</th></tr>${edited.map((e) => `<tr><td>${hrEsc(e.date || "")}</td><td>${hrEsc(e.clock_in || "—")}</td><td>${hrEsc(e.clock_out || "—")}</td><td class="r">${hrEsc(e.hours != null ? e.hours : "")}</td></tr>`).join("")}</table>` : ""}
      </div>` : "";

    const mails = (mail && mail.emails) || [];
    const mailHtml = mail
      ? (mails.length ? `<ul class="tch-timeline">${mails.map((m) => `<li><span>${hrEsc(m.subject || "(no subject)")}<br><span class="hr-muted" style="font-size:11.5px">to ${hrEsc(m.recipient)} · ${hrEsc(m.delivered || "unknown")}</span></span><span>${hrEsc(hrFmtDateTime(m.sent_at))}</span></li>`).join("")}</ul>${tc.verification_requested_at ? `<button class="hr-btn sm ghost" style="margin-top:8px" data-tcsent="${tc.id}">Show the messages as sent</button>` : ""}`
        : `<p class="hr-muted" style="margin:0">No email recorded for this timecard yet.</p>`)
      : "";

    back.querySelector(".tch-panel-h").innerHTML = `<button class="x" data-x aria-label="Close">×</button>
      <h2>${hrEsc(name)}</h2>
      <div class="sub">${hrEsc(hrTcDay(tc.pay_period_start))} – ${hrEsc(hrTcDay(tc.pay_period_end))}${emp.role_title ? " · " + hrEsc(emp.role_title) : ""}</div>`;
    back.querySelector("[data-x]").addEventListener("click", close);

    const pdf = tc.pdf_doc_id;
    back.querySelector("#tcd-body").innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${hrTcPill(hub)}${!emp.email && canManage ? `<span class="hr-muted" style="font-size:12px">No email on file</span>` : emp.email ? `<span class="hr-muted" style="font-size:12px">${hrEsc(emp.email)}</span>` : ""}</div>
      <div class="tch-actions">
        ${canManage && hub !== "signed" ? `<button class="hr-btn sm" data-tcsend="${tc.id}">${hub === "not_sent" ? "Send for signature" : "Resend"}</button><button class="hr-btn sm ghost" data-tcpreview="${tc.id}">Preview email</button>` : ""}
        ${pdf ? `<a class="hr-btn sm ghost" style="text-decoration:none" href="/api/hr/employee-documents/${pdf}" target="_blank" rel="noopener">Download signed PDF</a>` : ""}
      </div>
      <div class="tch-sec"><div class="tch-kv">
        <div><b class="tch-num">${hrTcHours(total)}</b><span>Total hours</span></div>
        <div><b class="tch-num">${days.length}</b><span>Days worked</span></div>
        <div><b class="tch-num">${entries.length}</b><span>Sessions</span></div>
      </div></div>
      ${changes}
      <div class="tch-sec"><h3>Signature tracking</h3><ul class="tch-timeline">${timeline.map(([k, v]) => `<li><span>${hrEsc(k)}</span><span>${hrEsc(v)}</span></li>`).join("")}</ul></div>
      <div class="tch-sec"><h3>Daily hours</h3>${days.length ? `<table class="tch-days"><tr><th>Date</th><th class="r">Sessions</th><th class="r">Hours</th></tr>${days.map(([d, v]) => `<tr><td>${hrEsc(hrTcDay(d))}</td><td class="r">${v.n}</td><td class="r tch-num">${hrTcHours(v.hours)}</td></tr>`).join("")}<tr><td><strong>Total</strong></td><td></td><td class="r tch-num"><strong>${hrTcHours(total)}</strong></td></tr></table>` : `<p class="hr-muted">No entries on this timecard.</p>`}</div>
      ${pdf ? `<div class="tch-sec"><h3>Signed timecard</h3><iframe title="Signed timecard PDF" src="/api/hr/employee-documents/${pdf}?inline=1#view=FitH" style="width:100%;height:360px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:#fff"></iframe><p class="hr-muted" style="font-size:11.5px;margin:4px 0 0">If it doesn't display here, use Download signed PDF above.</p></div>` : ""}
      ${canManage ? `<div class="tch-sec"><h3>Email history</h3>${mailHtml}</div>` : ""}
      ${flagsHtml ? `<div class="tch-sec"><h3>Flags</h3>${flagsHtml}<p class="hr-lock">Approving a flag records supervisor sign-off only — it never changes payroll or timecard hours.</p></div>` : ""}`;

    const panel = back.querySelector("#tcd-body");
    hrTcWireActions(panel, tcBody, false);
    panel.querySelectorAll("[data-tcsend],[data-tcpreview],[data-tcsent]").forEach((b) => b.addEventListener("click", () => {
      if (b.matches("[data-tcsend]")) close();
    }));
    panel.querySelectorAll("[data-resolve]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await hrApi("/api/hr/timecard-flags/" + b.dataset.resolve + "/resolve", { method: "POST", body: { status: b.dataset.st } });
        close(); hrOpenTimecardDetail(id, tcBody); if (tcBody) hrRenderTimecards(tcBody);
      } catch (e) { alert(e.message); }
    }));
  }).catch((e) => {
    back.querySelector("#tcd-body").innerHTML = `<p class="hr-status err">${hrEsc(e.message || "Could not load this timecard.")}</p>`;
  });
}

// What was ACTUALLY emailed to this person about this timecard -- the message
// as it was sent, when it went, and whether it was delivered.
//
// THE SIGN-IN LINK IS REDACTED BY THE SERVER. The email carries a magic link
// that accepts the timecard as the employee, which is a credential rather than
// a convenience. Showing the message without handing over a working one is the
// same rule this application already holds for password-reset links.
//
// Emails sent before the CRM recorded which timecard they were about are listed
// SEPARATELY and by subject only: they can be matched to this person but not to
// this pay period, and presenting a guess as a fact is worse than saying so.
function hrOpenTimecardSentEmails(id) {
  // Same modal furniture the preview next door uses -- hr-modal-back and
  // hr-close are the classes this stylesheet actually defines.
  const wrap = document.createElement("div");
  wrap.className = "hr-modal-back";
  wrap.innerHTML = `<div class="hr-modal" style="max-width:760px">
    <button class="hr-close" data-x>×</button>
    <h2>Sent email</h2>
    <div id="tcsent-body"><p class="hr-muted">Loading…</p></div></div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector("[data-x]").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

  hrApi("/api/hr/timecards/" + id + "/emails").then((d) => {
    const box = wrap.querySelector("#tcsent-body");
    const mails = d.emails || [];
    const earlier = d.earlier_unlinked || [];

    const head = `<div style="margin-bottom:12px">
      <div><strong>${hrEsc(d.employee_name || "—")}</strong>
        <span class="hr-muted">${hrEsc(d.employee_email || "no email on file")}</span></div>
      ${d.status === "accepted"
        ? `<div class="hr-muted" style="font-size:12px;margin-top:3px">Accepted${d.signed_name ? " by " + hrEsc(d.signed_name) : ""}.</div>`
        : d.verification_requested_at
        ? `<div class="hr-muted" style="font-size:12px;margin-top:3px">Sent ${hrEsc(hrFmtDateTime(d.verification_requested_at))} — no response yet.</div>`
        : ""}
    </div>`;

    const body = mails.length
      ? mails.map((m) => `<div class="card" style="margin-bottom:12px;padding:12px 14px">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
            <strong style="font-size:13.5px">${hrEsc(m.subject || "(no subject)")}</strong>
            <span class="hr-muted" style="font-size:12px">${hrEsc(hrFmtDateTime(m.sent_at))}</span>
          </div>
          <div class="hr-muted" style="font-size:12px;margin:3px 0 8px">
            To ${hrEsc(m.recipient)} · ${hrEsc(m.delivered || "unknown")}
          </div>
          <details><summary style="cursor:pointer;font-size:12.5px">Show the message as it was sent</summary>
            <div style="border:1px solid #e6e1d4;border-radius:8px;padding:10px;margin-top:8px;background:#fff;max-height:420px;overflow:auto">${m.body}</div>
            <p class="hr-muted" style="font-size:11.5px;margin-top:6px">
              The review link is hidden here on purpose — it signs the timecard as ${hrEsc(d.employee_name || "the employee")}. It still works from their own inbox.
            </p>
          </details>
        </div>`).join("")
      : `<p class="hr-muted">No email has been recorded for this timecard.</p>`;

    const tail = earlier.length
      ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid #e6e1d4">
          <div style="font-size:13px;font-weight:700;margin-bottom:4px">Earlier timecard emails to this person (${earlier.length})</div>
          <p class="hr-muted" style="font-size:12px;margin:0 0 8px">Sent before the CRM recorded which timecard an email was about, so these can be matched to ${hrEsc(d.employee_name || "them")} but not to this pay period.</p>
          ${earlier.map((m) => `<div class="hr-muted" style="font-size:12.5px;padding:3px 0">
            ${hrEsc(hrFmtDateTime(m.sent_at))} — ${hrEsc(m.subject || "(no subject)")} · ${hrEsc(m.delivered || "unknown")}</div>`).join("")}
        </div>`
      : "";

    box.innerHTML = head + body + tail;
  }).catch((e) => {
    wrap.querySelector("#tcsent-body").innerHTML = `<p class="hr-status err">${hrEsc(e.message || "Could not load the sent email.")}</p>`;
  });
}

// Read-only look at exactly what the employee will receive, before anything
// goes out: the hours, the flags, and the actual email. Nothing is generated,
// nothing is sent, and the timecard's status is untouched until you press Send.
function hrOpenTimecardPreview(id, tcBody) {
  hrApi("/api/hr/timecards/" + id + "/preview").then((p) => {
    const entriesHtml = (p.entries || []).length
      ? `<table class="hr-table"><thead><tr><th>Date</th><th>In</th><th>Out</th><th>Hours</th></tr></thead><tbody>${(p.entries || [])
          .map((e) => `<tr><td>${hrEsc(e.date || "")}</td><td>${hrEsc(e.clock_in || "—")}</td><td>${hrEsc(e.clock_out || "—")}</td><td>${hrEsc(e.hours != null ? e.hours : "")}</td></tr>`)
          .join("")}<tr><td colspan="3" style="text-align:right"><strong>Total</strong></td><td><strong>${hrEsc(p.total_hours)}h</strong></td></tr></tbody></table>`
      : `<p class="hr-muted">No entries on this timecard.</p>`;
    const openFlags = (p.flags || []).filter((f) => !["approved", "corrected"].includes(f.status));
    const flagWarn = openFlags.length
      ? `<div class="hr-alert" style="margin-bottom:10px">⚠ ${openFlags.length} open flag${openFlags.length === 1 ? "" : "s"} on this timecard: ${hrEsc(openFlags.map((f) => f.flag_type.replace(/_/g, " ")).join(", "))}. The employee will see these too.</div>`
      : "";
    const noEmail = !p.has_email
      ? `<div class="hr-alert" style="margin-bottom:10px">This employee has no email on file, so nothing can be sent yet. Add their email in the Employees list first.</div>`
      : "";
    const alreadySent = p.already_sent_at
      ? `<p class="hr-muted" style="margin:0 0 10px">Already sent once — pressing Send again re-sends the same link.</p>`
      : "";

    const back = document.createElement("div");
    back.className = "hr-modal-back";
    back.innerHTML = `<div class="hr-modal" style="max-width:760px">
      <button class="hr-close" id="hr-pclose">×</button>
      <h2>Preview — ${hrEsc(p.employee_name || "Unassigned")}</h2>
      <p class="hr-muted">${hrEsc((p.pay_period_start || "?") + " → " + (p.pay_period_end || "?"))} · <strong>${hrEsc(p.total_hours)} hours</strong> · status: ${hrEsc(p.status)}</p>
      <p class="hr-muted">Goes to: <strong>${hrEsc(p.employee_email || "no email on file")}</strong><br>Subject: ${hrEsc(p.subject)}</p>
      ${noEmail}${flagWarn}${alreadySent}
      <div class="hr-muted" style="font-weight:600;margin:12px 0 6px">Hours the employee will see</div>
      ${entriesHtml}
      <div class="hr-muted" style="font-weight:600;margin:16px 0 6px">The email they'll get</div>
      <div style="border:1px solid #e6e8f0;border-radius:10px;overflow:hidden;background:#f4f1ea;">
        <iframe id="tc-pv-frame" style="width:100%;height:340px;border:0;display:block;background:#f4f1ea;"></iframe>
      </div>
      <div class="hr-row" style="margin-top:14px">
        <button class="hr-btn" id="tc-pv-send"${p.has_email ? "" : " disabled"}>${p.already_sent_at ? "Re-send to employee" : "Send to employee"}</button>
        <button class="hr-btn sm ghost" id="tc-pv-cancel">Close without sending</button>
        <span class="hr-status" id="tc-pv-status"></span>
      </div>
    </div>`;
    document.body.appendChild(back);
    // Written into the iframe rather than inlined so the email's own styles
    // can't leak into the app.
    const fr = back.querySelector("#tc-pv-frame");
    try {
      const d = fr.contentDocument || fr.contentWindow.document;
      d.open(); d.write(p.email_html || ""); d.close();
    } catch (e) { /* preview is best-effort */ }

    const close = () => back.remove();
    back.querySelector("#hr-pclose").addEventListener("click", close);
    back.querySelector("#tc-pv-cancel").addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    const sendBtn = back.querySelector("#tc-pv-send");
    sendBtn.addEventListener("click", async () => {
      const st = back.querySelector("#tc-pv-status");
      sendBtn.disabled = true; st.textContent = "Sending…"; st.className = "hr-status";
      try {
        const r = await hrApi("/api/hr/timecards/" + id + "/request-verification", { method: "POST", body: {} });
        st.textContent = r.sent ? "Sent." : (r.reason === "just_sent" || r.reason === "in_progress")
          ? "Already sent within the last minute, so it was not sent again." : "Link created, but no email on file.";
        st.className = r.sent ? "hr-status ok" : "hr-status err";
        if (tcBody) hrRenderTimecards(tcBody);
        setTimeout(close, 900);
      } catch (e) { st.textContent = e.message; st.className = "hr-status err"; sendBtn.disabled = false; }
    });
  }).catch((e) => alert(e.message));
}

// Older entry point, kept so anything still calling it lands on the new panel.
function hrOpenTimecardModal(id, tcBody) {
  hrOpenTimecardDetail(id, tcBody);
}

// ---------------- Audit log ----------------
async function hrRenderAudit(body) {
  if (!hrCanManage()) { body.innerHTML = `<div class="hr-empty">Audit log is available to managers/owner.</div>`; return; }
  const rows = await hrApi("/api/hr/audit");
  body.innerHTML = rows.length
    ? `<div class="hr-card" style="margin-top:0;overflow-x:auto"><table class="hr-table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead><tbody>${rows
        .map(
          (r) =>
            `<tr><td>${hrFmtDate(r.created_at)}</td><td>${hrEsc(r.actor)}</td><td>${hrEsc(r.action)}</td><td>${hrEsc(
              (r.entity_type || "") + (r.entity_id ? " #" + r.entity_id : "")
            )}</td><td>${hrEsc(r.detail || "")}</td></tr>`
        )
        .join("")}</tbody></table></div>`
    : `<div class="hr-empty">No audit entries yet.</div>`;
}

// ---------------- view rendering ----------------
let hrRenderInFlight = false;

function hrRenderKeyFor(hash) {
  const parts = hash.replace(/^#\//, "").split("/");
  if (parts[1] === "candidate" && parts[2]) return "cand:" + parts[2];
  return "tab:" + (parts[1] || "dashboard");
}

// Core render: draws the current #/hr hash into the given mount element.
async function hrDoRender(mount) {
  const hash = location.hash || "";
  const parts = hash.replace(/^#\//, "").split("/"); // ["hr", tabOrCandidate, maybeId]
  mount.dataset.hrKey = hrRenderKeyFor(hash);
  if (parts[1] === "candidate" && parts[2]) {
    await hrRenderCandidate(mount, parts[2]);
    return;
  }
  const tab = parts[1] || "dashboard";
  const renderers = {
    dashboard: hrRenderDashboard,
    pipeline: hrRenderPipeline,
    inbox: hrRenderInbox,
    scheduling: hrRenderScheduling,
    positions: hrRenderPositions,
    timecards: hrRenderTimecards,
    audit: hrRenderAudit,
  };
  await hrRenderShell(mount, tab, renderers[tab] || hrRenderDashboard);
}

// Primary entry point: the native router calls this directly for #/hr routes,
// handing us the real #view-mount inline (no race with the native dashboard).
// Returns true if HR handled the route (i.e. the user may access it).
// A render asked for while another is still running is not dropped: the
// router replaces #view-mount on every navigation, so the render already in
// flight may be drawing into a mount that is no longer on the page. Once it
// finishes, the newest mount is checked and drawn if it is still empty.
let hrRenderAgain = false;
function hrAfterRender(mount) {
  if (hrRenderAgain || (mount && !mount.isConnected)) {
    hrRenderAgain = false;
    setTimeout(hrSyncView, 0);
  }
}

window.__renderHR = async function (mount) {
  if (!hrCanSee()) return false;
  if (hrRenderInFlight) { hrRenderAgain = true; return true; }
  hrRenderInFlight = true;
  try {
    await hrDoRender(mount);
  } catch (e) {
    console.error("HR render error:", e);
    if (mount) mount.innerHTML = '<div class="hr-wrap"><div class="hr-err">Something went wrong loading HR &amp; Recruiting. Please refresh.</div></div>';
  } finally {
    hrRenderInFlight = false;
    hrAfterRender(mount);
  }
  return true;
};

// Fallback self-heal for when the native app re-renders #view-mount while we're
// on an #/hr route (the native router hook above is the primary path).
async function hrSyncView() {
  const hash = location.hash || "";
  if (!hash.startsWith("#/hr")) return;
  if (!hrCanSee()) return;
  if (hrRenderInFlight) return;
  const mount = document.getElementById("view-mount") || document.getElementById("app");
  if (!mount) return;
  if (mount.querySelector("#hr-view-content") && mount.dataset.hrKey === hrRenderKeyFor(hash)) return;
  hrRenderInFlight = true;
  try {
    await hrDoRender(mount);
  } catch (e) {
    console.error("HR view error:", e);
  } finally {
    hrRenderInFlight = false;
    hrAfterRender(mount);
  }
}

function hrInit() {
  hrInjectStyles();
  hrSyncNavButton();
  hrSyncView();

  const app = document.getElementById("app");
  if (app) {
    const observer = new MutationObserver(() => { hrSyncNavButton(); hrSyncView(); });
    observer.observe(app, { childList: true, subtree: true });
  }
  window.addEventListener("hashchange", () => { hrSyncNavButton(); hrSyncView(); });
  [150, 500, 1200, 2500, 4000].forEach((ms) => setTimeout(() => { hrSyncNavButton(); hrSyncView(); }, ms));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", hrInit);
} else {
  hrInit();
}
