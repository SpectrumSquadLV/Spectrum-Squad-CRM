// attendance.js -- Spectrum Squad CRM: manual attendance alerts
//
// Progressive-enhancement module, loaded via its own <script> tag (same
// pattern as theme.js / financial-center.js / email-templates.js). It does
// NOT touch index.html's native router or renderShell -- it adds its own
// sidebar nav button + "#/attendance" view, and injects a small summary
// card into the native Dashboard view. Because renderShell() rebuilds the
// entire sidebar on every navigation, and the native router falls back to
// renderDashboard() for any hash it doesn't recognize, this file has to
// re-assert itself after every render -- it does that with a
// MutationObserver + hashchange listener + a handful of timed retries,
// exactly like the other plugin files in this app.
"use strict";

function attCanUse() {
  return !!(window.state && state.user);
}

// ---------------- sidebar nav button ----------------
function attSyncNavButton() {
  if (!attCanUse()) return;
  const nav = document.querySelector(".sidebar nav");
  if (!nav) return;
  if (nav.querySelector('[data-nav="attendance"]')) return;
  const btn = document.createElement("button");
  btn.className = "nav-item" + (location.hash.startsWith("#/attendance") ? " active" : "");
  btn.dataset.nav = "attendance";
  btn.innerHTML = "<span>&#9888;</span> Attendance Alerts";
  btn.addEventListener("click", () => { location.hash = "#/attendance"; });
  nav.appendChild(btn);
}

// ---------------- dedicated view ----------------
async function attRenderView(mount) {
  let clients = [];
  let notifications = [];
  try {
    clients = (window.state && Array.isArray(state.clients) && state.clients.length
      ? state.clients
      : await api("/api/clients"));
  } catch (e) { clients = []; }
  try {
    notifications = await api("/api/notifications");
  } catch (e) { notifications = []; }

  const eligible = clients
    .filter((c) => c.parent_email && c.stage !== "discharged" && c.stage !== "not_moving_forward")
    .sort((a, b) => (a.child_name || "").localeCompare(b.child_name || ""));

  const alerts = notifications
    .filter((n) => n.type === "attendance_alert")
    .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));

  mount.innerHTML = `
    <div id="att-view-content">
      <div class="page-header">
        <div>
          <h1>Attendance Alerts</h1>
          <p>Pull the current attendance percentage from Rethink, then send the parent a heads-up. This is a manual, staff-triggered alert -- it is not tied to automatic tracking.</p>
        </div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="section-title" style="margin-top:0;">Send Attendance Alert</div>
        ${eligible.length ? `
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <select id="att-client-select" style="min-width:220px; padding:8px 10px; border-radius:8px; border:1px solid var(--border);">
              ${eligible.map((c) => `<option value="${c.id}">${c.child_name}</option>`).join("")}
            </select>
            <button class="btn" id="att-send-btn">Send Attendance Alert</button>
          </div>
        ` : `<div class="empty-state">No active clients with a parent email on file.</div>`}
        <div id="att-send-result" style="margin-top:10px; font-size:12.5px; color:var(--text-muted);"></div>
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0;">Attendance Alert History</div>
        ${alerts.length ? alerts.map((n) => `
          <div class="task-row">
            <div class="info">
              <strong>${n.subject || "Attendance Alert"}</strong>
              <div class="due">to ${n.recipient || "parent"} &middot; ${typeof fmtDate === "function" ? fmtDate(n.sent_at) : n.sent_at}
                <span class="delivered-pill ${(n.delivered || "").split(":")[0]}">${(n.delivered || "").split(":")[0]}</span>
              </div>
            </div>
            ${n.acknowledged
              ? `<span class="delivered-pill sent">Acknowledged${n.acknowledged_at ? " " + (typeof fmtDate === "function" ? fmtDate(n.acknowledged_at) : n.acknowledged_at) : ""}</span>`
              : `<button class="btn small secondary" data-ack="${n.id}">Mark parent acknowledged</button>`}
          </div>
        `).join("") : `<div class="empty-state">No attendance alerts sent yet.</div>`}
      </div>
    </div>
  `;

  const sendBtn = mount.querySelector("#att-send-btn");
  if (sendBtn) {
    sendBtn.addEventListener("click", async () => {
      const select = mount.querySelector("#att-client-select");
      const id = select.value;
      const entered = prompt("Current attendance percentage per Rethink? (e.g. 65)", "");
      if (entered === null) return;
      const pct = Number(entered);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        alert("Please enter a number between 0 and 100.");
        return;
      }
      const resultEl = mount.querySelector("#att-send-result");
      resultEl.textContent = "Sending...";
      try {
        const result = await api(`/api/clients/${id}/attendance-alert`, {
          method: "POST",
          body: { percentage: pct },
        });
        resultEl.textContent = `Sent: ${result.delivered || "ok"}`;
        attRenderView(mount);
      } catch (e) {
        resultEl.textContent = `Failed: ${e.message}`;
      }
    });
  }

  mount.querySelectorAll("[data-ack]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/notifications/${btn.dataset.ack}/acknowledge`, { method: "POST" });
        attRenderView(mount);
      } catch (e) {
        alert("Could not update: " + e.message);
      }
    });
  });
}

// ---------------- dashboard summary card ----------------
async function attRenderDashboardCard() {
  const onDashboard = location.hash === "" || location.hash === "#/" || location.hash.startsWith("#/dashboard");
  if (!onDashboard) return;
  const mount = document.getElementById("view-mount");
  if (!mount || document.getElementById("att-dash-card")) return;
  if (!mount.querySelector(".stat-grid")) return; // native dashboard hasn't rendered yet

  let alerts = [];
  try {
    const notifications = await api("/api/notifications");
    alerts = notifications.filter((n) => n.type === "attendance_alert" && !n.acknowledged);
  } catch (e) {
    return;
  }
  if (document.getElementById("att-dash-card")) return; // race guard

  const card = document.createElement("div");
  card.id = "att-dash-card";
  card.className = "card";
  card.style.marginTop = "20px";
  card.innerHTML = `
    <div class="section-title" style="margin-top:0; display:flex; align-items:center; justify-content:space-between;">
      <span>Attendance Alerts Awaiting Acknowledgment</span>
      <button class="btn small secondary" id="att-dash-link">Open Attendance Alerts</button>
    </div>
    ${alerts.length ? alerts.slice(0, 5).map((n) => `
      <div class="task-row">
        <div class="info"><strong>${n.recipient || "parent"}</strong><div class="due">${n.subject || "Attendance Alert"}</div></div>
        <span class="delivered-pill simulated">Awaiting ack</span>
      </div>
    `).join("") : `<div class="empty-state">Nothing awaiting acknowledgment.</div>`}
  `;
  mount.appendChild(card);
  const link = document.getElementById("att-dash-link");
  if (link) link.addEventListener("click", () => { location.hash = "#/attendance"; });
}

// ---------------- self-healing sync loop ----------------
function attSyncView() {
  attSyncNavButton();
  const mount = document.getElementById("view-mount");
  if (!mount) return;
  if (location.hash.startsWith("#/attendance")) {
    if (!document.getElementById("att-view-content")) {
      attRenderView(mount);
    }
  } else {
    attRenderDashboardCard();
  }
}

function attInit() {
  attSyncView();
  const app = document.getElementById("app") || document.body;
  const observer = new MutationObserver(() => attSyncView());
  observer.observe(app, { childList: true, subtree: true });
  window.addEventListener("hashchange", attSyncView);
  [150, 500, 1200, 2500, 4000].forEach((ms) => setTimeout(attSyncView, ms));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", attInit);
} else {
  attInit();
}
