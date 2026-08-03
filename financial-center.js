// financial-center.js -- Spectrum Squad CRM: Financial Center (ClickUp)
//
// Loaded as a plain <script src="financial-center.js"></script> right before
// </body> in index.html -- the ONLY change made to index.html for this
// feature. Everything else (nav item, page rendering, styling) is added at
// runtime from here, so the existing hand-rolled router/renderShell in
// index.html's inline script never has to be touched or risk breaking.
//
// This script runs in the SAME global scope as index.html's inline <script>
// (classic scripts, not modules, share one global lexical environment), so
// it can reference `state`, `api()`, etc. directly, exactly like the rest of
// the app's code does. IMPORTANT: `state` is declared with `const` in that
// inline script, so it's accessible here as the bare identifier `state` --
// but it is NOT a property of `window` (that's only true for `var`/function
// declarations at top level, not `let`/`const`). Always reference it as
// bare `state`, never `window.state` (which will always be undefined).
"use strict";

// ---------------- Styles (injected once) ----------------
(function injectStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .fc-tabs { display:flex; gap:6px; margin-bottom:18px; border-bottom:1px solid var(--border); flex-wrap:wrap; }
    .fc-tab { padding:10px 16px; text-decoration:none; color: var(--text-muted); font-weight:600; border-bottom:2px solid transparent; }
    .fc-tab.active { color: var(--brand); border-bottom-color: var(--brand); }
    .conn-pill { display:inline-block; padding:4px 12px; border-radius:999px; font-weight:700; font-size:13px; color:#fff; }
    .conn-pill.connected { background:#22c55e; }
    .conn-pill.connection_failed { background:#dc2626; }
    .conn-pill.disconnected { background:#6b7280; }
  `;
  document.head.appendChild(style);
})();

// ---------------- Permissions ----------------
// Mirrors the existing Authorization Alerts permission model used elsewhere
// in this app: admin/billing/clinical (BCBA) can view financial data, only
// admin/billing can edit or trigger a sync, only admin can change API
// credentials. Any other role (intake, scheduling -- and any future RBT
// login) gets no access, per the "RBTs: No access" requirement.
function canViewFinancial() {
  return typeof state !== "undefined" && !!state.user && ["admin", "billing", "clinical"].includes(state.user.role);
}
function canEditFinancial() {
  return typeof state !== "undefined" && !!state.user && ["admin", "billing"].includes(state.user.role);
}
function canAdminFinancial() {
  return typeof state !== "undefined" && !!state.user && state.user.role === "admin";
}

const FINANCIAL_TABS = [
  { key: "overview", label: "Overview" },
  { key: "claims", label: "Claims" },
  { key: "credentialing", label: "Credentialing" },
  { key: "alerts", label: "Financial Alerts" },
  { key: "settings", label: "Integration Settings" },
];

// ---------------- Page rendering ----------------
async function renderFinancialCenter(mount, tabParam) {
  if (!canViewFinancial()) {
    mount.innerHTML =
      '<div class="page-header"><div><h1>Financial Center</h1></div></div>' +
      '<div class="empty-state">You don\'t have permission to view this page.</div>';
    return;
  }
  const activeTab = FINANCIAL_TABS.some((t) => t.key === tabParam) ? tabParam : "overview";

  mount.innerHTML = `
    <div class="page-header">
      <div><h1>Financial Center</h1><p>Executive billing &amp; credentialing intelligence, powered by your ClickUp workspace.</p></div>
    </div>
    <div class="fc-tabs">
      ${FINANCIAL_TABS.filter((t) => t.key !== "settings" || canAdminFinancial())
        .map(
          (t) =>
            `<a href="#/financial-center/${t.key}" class="fc-tab${t.key === activeTab ? " active" : ""}">${t.label}</a>`
        )
        .join("")}
    </div>
    <div id="fc-tab-content"></div>
  `;

  const content = document.getElementById("fc-tab-content");
  if (activeTab === "settings" && canAdminFinancial()) {
    await renderFinancialSettings(content);
  } else {
    await renderFinancialDataTab(content, activeTab);
  }
}

async function renderFinancialDataTab(content, tab) {
  let status;
  try {
    status = await api("/api/financial/config-status");
  } catch (e) {
    status = { configured: false, connection_status: "disconnected" };
  }

  if (!status.configured) {
    content.innerHTML = `
      <div class="card empty-state">
        <p><strong>ClickUp isn't connected yet.</strong></p>
        <p>${
          canAdminFinancial()
            ? `Head to <a href="#/financial-center/settings">Integration Settings</a> to enter your ClickUp Personal API Token and start syncing billing data.`
            : `Ask an administrator to connect ClickUp under Financial Center &rarr; Integration Settings.`
        }</p>
      </div>
    `;
    return;
  }

  // Configured but this specific tab's live dashboard/claims/credentialing/
  // alerts numbers are built in a follow-up pass once real synced data is
  // flowing through clickup_tasks. Wiring proves out end-to-end here first.
  const labels = {
    overview: "Overview",
    claims: "Claims",
    credentialing: "Credentialing",
    alerts: "Financial Alerts",
  };
  content.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0;">${labels[tab] || "Overview"}</div>
      <p class="empty-state" style="margin:0;">ClickUp is connected. This view populates automatically once the next sync completes.</p>
    </div>
  `;
}

async function renderFinancialSettings(content) {
  let status, syncStatus, mappings;
  try {
    [status, syncStatus, mappings] = await Promise.all([
      api("/api/financial/config-status"),
      api("/api/financial/sync-status"),
      api("/api/financial/category-mappings"),
    ]);
  } catch (e) {
    content.innerHTML = `<div class="card empty-state">Failed to load settings: ${e.message}</div>`;
    return;
  }

  const statusLabel =
    status.connection_status === "connected"
      ? "Connected"
      : status.connection_status === "connection_failed"
      ? "Connection Failed"
      : "Disconnected";

  content.innerHTML = `
    <div class="card" style="margin-bottom:20px;">
      <div class="section-title" style="margin-top:0;">Connection</div>
      <p>Status: <span class="conn-pill ${status.connection_status || "disconnected"}">${statusLabel}</span></p>
      <form id="fc-config-form">
        <label>Personal API Token ${status.configured ? "(leave blank to keep the current token)" : ""}<br/>
          <input type="password" id="fc-token" placeholder="${
            status.configured ? "•••••••• (saved)" : "pk_xxxxxxxxxxxx"
          }" style="width:100%;max-width:420px;" />
        </label><br/><br/>
        <label>Workspace ID<br/><input type="text" id="fc-workspace" value="${status.workspace_id || ""}" style="width:100%;max-width:420px;" /></label><br/><br/>
        <label>Space ID<br/><input type="text" id="fc-space" value="${status.space_id || ""}" style="width:100%;max-width:420px;" /></label><br/><br/>
        <label>Folder ID<br/><input type="text" id="fc-folder" value="${status.folder_id || ""}" style="width:100%;max-width:420px;" /></label><br/><br/>
        <label>List IDs (comma-separated)<br/><input type="text" id="fc-lists" value="${status.list_ids || ""}" style="width:100%;max-width:420px;" /></label><br/><br/>
        <button type="submit" class="btn">Save</button>
        <button type="button" id="fc-test-btn" class="btn" style="margin-left:8px;">Test Connection</button>
      </form>
      <p id="fc-test-result" style="margin-top:10px;"></p>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="section-title" style="margin-top:0;">Sync Status</div>
      <p>Last Sync: ${
        syncStatus.lastSync
          ? new Date(syncStatus.lastSync.finishedAt || syncStatus.lastSync.startedAt).toLocaleString()
          : "Never"
      }
        ${
          syncStatus.lastSync
            ? ` — <span class="alert-badge ${syncStatus.lastSync.status === "success" ? "informational" : "critical"}">${syncStatus.lastSync.status}</span>`
            : ""
        }
      </p>
      <p>Next Sync: ${syncStatus.nextSync ? new Date(syncStatus.nextSync).toLocaleString() : "—"}</p>
      <p>Last Successful Sync: ${
        syncStatus.lastSuccessfulSync
          ? new Date(syncStatus.lastSuccessfulSync.finishedAt).toLocaleString() +
            ` (${syncStatus.lastSuccessfulSync.tasksSynced} tasks)`
          : "None yet"
      }</p>
      <p>Errors: ${syncStatus.lastSync && syncStatus.lastSync.error ? syncStatus.lastSync.error : "None"}</p>
      <button id="fc-sync-now-btn" class="btn">Run Sync Now</button>
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;">Task Category Mappings</div>
      <p class="empty-state" style="margin-top:0;">Map each ClickUp List ID to a category so synced tasks show up in the right dashboard section.</p>
      <table style="width:100%;margin-bottom:14px;border-collapse:collapse;">
        <thead><tr style="text-align:left;border-bottom:1px solid var(--border);"><th style="padding:6px 8px;">List ID</th><th style="padding:6px 8px;">List Name</th><th style="padding:6px 8px;">Category</th></tr></thead>
        <tbody>
          ${
            mappings
              .map(
                (m) =>
                  `<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 8px;">${m.list_id}</td><td style="padding:6px 8px;">${m.list_name || "—"}</td><td style="padding:6px 8px;">${m.category}</td></tr>`
              )
              .join("") || `<tr><td style="padding:6px 8px;" colspan="3">No mappings yet.</td></tr>`
          }
        </tbody>
      </table>
      <form id="fc-mapping-form">
        <input type="text" id="fc-map-list-id" placeholder="List ID" style="width:140px;" />
        <input type="text" id="fc-map-list-name" placeholder="List Name (optional)" style="width:180px;" />
        <select id="fc-map-category" style="width:200px;">
          ${["Billing", "Credentialing", "Authorizations", "Appeals", "Provider Enrollment", "Insurance Follow-up", "Client Billing", "Collections", "Other"]
            .map((c) => `<option value="${c}">${c}</option>`)
            .join("")}
        </select>
        <button type="submit" class="btn">Add Mapping</button>
      </form>
    </div>
  `;

  document.getElementById("fc-config-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      workspace_id: document.getElementById("fc-workspace").value.trim(),
      space_id: document.getElementById("fc-space").value.trim(),
      folder_id: document.getElementById("fc-folder").value.trim(),
      list_ids: document.getElementById("fc-lists").value.trim(),
    };
    const token = document.getElementById("fc-token").value.trim();
    if (token) body.token = token;
    await api("/api/financial/config", { method: "POST", body });
    await renderFinancialSettings(content);
  });

  document.getElementById("fc-test-btn").addEventListener("click", async () => {
    const resultEl = document.getElementById("fc-test-result");
    resultEl.textContent = "Testing…";
    try {
      const result = await api("/api/financial/test-connection", { method: "POST" });
      resultEl.textContent = result.detail;
    } catch (e) {
      resultEl.textContent = "Test failed: " + e.message;
    }
    await renderFinancialSettings(content);
  });

  document.getElementById("fc-sync-now-btn").addEventListener("click", async () => {
    await api("/api/financial/sync-now", { method: "POST" }).catch(() => {});
    await renderFinancialSettings(content);
  });

  document.getElementById("fc-mapping-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const list_id = document.getElementById("fc-map-list-id").value.trim();
    const list_name = document.getElementById("fc-map-list-name").value.trim();
    const category = document.getElementById("fc-map-category").value;
    if (!list_id) return;
    await api("/api/financial/category-mappings", { method: "POST", body: { list_id, list_name, category } });
    await renderFinancialSettings(content);
  });
}

// ---------------- Non-invasive wiring into the existing app shell ----------------
// The existing renderShell()/route() functions in index.html fully replace
// #app's innerHTML on every navigation, and don't know this nav item or page
// exist. Rather than editing that code (risking existing functionality), a
// MutationObserver watches #app and, after every re-render:
//   1. (Re-)injects the "Financial Center" sidebar button if missing (or if
//      permission just became available, e.g. state.user finished loading).
//   2. If the current hash is #/financial-center[...], renders this page's
//      content into #view-mount, replacing whatever the native router put
//      there for the (unrecognized-to-it) hash.
// The re-render guard key includes the permission check result (not just the
// hash) specifically so an early render that happened before `state.user`
// finished loading (and so saw canViewFinancial() as false) gets corrected
// automatically once auth state settles, instead of being locked in forever.

function syncNavButton() {
  const nav = document.querySelector(".sidebar nav");
  if (!nav) return;
  let btn = nav.querySelector('[data-nav="financial-center"]');
  if (!canViewFinancial()) {
    if (btn) btn.remove();
    return;
  }
  const isActive = location.hash.startsWith("#/financial-center");
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "nav-item";
    btn.dataset.nav = "financial-center";
    btn.innerHTML = "<span>💰</span> Financial Center";
    btn.addEventListener("click", () => {
      location.hash = "#/financial-center";
    });
    nav.appendChild(btn);
  }
  btn.classList.toggle("active", isActive);
  if (isActive) {
    nav.querySelectorAll(".nav-item").forEach((b) => {
      if (b !== btn) b.classList.remove("active");
    });
  }
}

function syncFinancialView() {
  const mount = document.getElementById("view-mount");
  if (!mount) return;
  if (!location.hash.startsWith("#/financial-center")) return;
  // Guard key includes the permission outcome, not just the hash, so a
  // render that happened before auth state settled gets retried once
  // canViewFinancial() flips to true (see comment above).
  const guardKey = location.hash + "|" + (canViewFinancial() ? "v" : "x");
  if (mount.dataset.fcRendered === guardKey) return;
  mount.dataset.fcRendered = guardKey;
  const parts = location.hash.split("/");
  const param = parts[2];
  renderFinancialCenter(mount, param);
}

function onAppMutated() {
  syncNavButton();
  syncFinancialView();
}

function initFinancialCenter() {
  const appRoot = document.getElementById("app");
  if (appRoot) {
    const observer = new MutationObserver(() => onAppMutated());
    observer.observe(appRoot, { childList: true, subtree: true });
  }
  window.addEventListener("hashchange", () => {
    const mount = document.getElementById("view-mount");
    if (mount) delete mount.dataset.fcRendered;
    setTimeout(onAppMutated, 0);
  });
  onAppMutated();
  // Defensive redundancy: auth/data loading is async, and it's possible for
  // the DOM to finish settling before state.user is fully populated (or for
  // no further mutation to fire after that point). These are cheap, safe,
  // no-op if everything already synced correctly (see the guards above).
  [150, 500, 1200, 2500].forEach((ms) => setTimeout(onAppMutated, ms));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initFinancialCenter);
} else {
  initFinancialCenter();
}
