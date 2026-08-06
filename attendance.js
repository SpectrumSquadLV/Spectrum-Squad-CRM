// attendance.js -- Spectrum Squad CRM: attendance alerts (dashboard summary)
//
// Attendance alerts are now sent from a button on each client's card (see the
// client modal in index.html) rather than a dedicated nav page. This module
// keeps only the small Dashboard summary card that surfaces alerts still
// awaiting a parent's acknowledgment, so nothing falls through the cracks.
// Progressive-enhancement, same self-healing pattern as the other plugins.
"use strict";

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
    return; // e.g. non-owner without outbox access -- silently skip
  }
  if (document.getElementById("att-dash-card")) return; // race guard
  if (!alerts.length) return; // nothing to show; keep the dashboard clean

  const card = document.createElement("div");
  card.id = "att-dash-card";
  card.className = "card";
  card.style.marginTop = "20px";
  card.innerHTML = `
    <div class="section-title" style="margin-top:0;">Attendance Alerts Awaiting Parent Acknowledgment</div>
    ${alerts.slice(0, 8).map((n) => `
      <div class="task-row">
        <div class="info"><strong>${n.recipient || "parent"}</strong><div class="due">${n.subject || "Attendance Alert"}${typeof fmtDate === "function" && n.sent_at ? " · " + fmtDate(n.sent_at) : ""}</div></div>
        <span class="delivered-pill simulated">Awaiting ack</span>
      </div>
    `).join("")}
    <div style="font-size:12px; color:var(--text-muted); margin-top:8px;">Send a new attendance alert from a client's card (open the client, then use the Attendance section).</div>
  `;
  mount.appendChild(card);
}

// ---------------- self-healing sync loop ----------------
function attSyncView() {
  // Remove any stale nav button from earlier versions of this module.
  const oldNav = document.querySelector('.sidebar nav [data-nav="attendance"]');
  if (oldNav) oldNav.remove();
  attRenderDashboardCard();
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
