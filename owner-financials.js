// owner-financials.js -- Injects a private "Owner Financial Snapshot" into
// existing client cards (both board views) and the client detail modal,
// plus (Phase 4b) inline editing of the per-client hours/date overrides,
// plus (Phase 4c) a private "Financial Settings" page for the company-wide
// rates. Progressive-enhancement plugin, same pattern as theme.js/
// attendance.js/pipeline-v2.js: never touches the app's own module-scoped
// state/route, just watches the DOM and reacts.
//
// Permission is enforced before anything renders: on load this probes
// GET /api/owner-financial-settings once. A 403 means the logged-in user
// is not permitted to see financials -- in that case this script fetches
// nothing else and injects nothing, ever, for the rest of the session. All
// of the real enforcement already happened server-side in Phase 3; this is
// just staying consistent with it on the client, not a second gate.
(function () {
  const SETTINGS_HASH = "#/owner-financial-settings";
  const ALL_ROLES = ["owner", "super_admin", "admin", "intake", "clinical", "billing", "scheduling"];
  const LIFETIME_SOURCES = [
    { value: "estimated_from_schedule", label: "Estimated from schedule" },
    { value: "estimated_from_authorization", label: "Estimated from authorization" },
    { value: "calculated_from_completed_sessions", label: "Calculated from completed sessions" },
    { value: "calculated_from_collected_claims", label: "Calculated from collected claims" },
  ];

  let authorized = null; // null = not yet checked, true/false after probe
  let summaryData = null; // { [clientId]: {estMonthlyRevenue, ...} }
  const detailCache = {}; // { [clientId]: full /financials response }
  let lastOpenedClientId = null;
  const attachedNodes = {}; // { [clientId]: [wrapEl, ...] } -- every injected wrap currently in the DOM for that client, so a save anywhere refreshes every visible copy
  let ownerSettingsCache = null;
  let settingsMountObserver = null;

  function fmtMoney(n) {
    if (n == null) return "—";
    const sign = n < 0 ? "-" : "";
    return sign + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function dateVal(iso) {
    return iso ? String(iso).slice(0, 10) : "";
  }

  async function checkAuthorizedAndLoad() {
    try {
      const res = await fetch("/api/owner-financial-settings");
      if (!res.ok) {
        authorized = false;
        return;
      }
      authorized = true;
      ownerSettingsCache = await res.json();
      const sumRes = await fetch("/api/clients/financials-summary");
      summaryData = sumRes.ok ? await sumRes.json() : {};
    } catch (e) {
      authorized = false;
    }
  }

  async function getFullFinancials(clientId, forceRefresh) {
    if (!forceRefresh && detailCache[clientId]) return detailCache[clientId];
    const res = await fetch("/api/clients/" + encodeURIComponent(clientId) + "/financials");
    if (!res.ok) return null;
    const data = await res.json();
    detailCache[clientId] = data;
    return data;
  }

  async function refreshSummary() {
    try {
      const res = await fetch("/api/clients/financials-summary");
      summaryData = res.ok ? await res.json() : summaryData;
    } catch (e) {
      /* keep stale summary rather than blow away the UI */
    }
    attachDashboardStat();
  }

  // ---------- Compact summary (always visible if authorized) ----------
  function compactHTML(clientId) {
    const s = (summaryData && summaryData[clientId]) || null;
    if (!s) {
      return (
        '<div class="ofin-compact" style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);font-size:10.5px;color:var(--text-muted);">' +
          "🔒 Financials unavailable" +
        "</div>"
      );
    }
    return (
      '<div class="ofin-compact" style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);font-size:10.5px;line-height:1.6;color:var(--text-muted);">' +
        '<div style="display:flex;justify-content:space-between;"><span>Est. Monthly Revenue</span><b style="color:var(--text);">' + fmtMoney(s.estMonthlyRevenue) + "</b></div>" +
        '<div style="display:flex;justify-content:space-between;"><span>Est. Monthly Net Profit</span><b style="color:var(--text);">' + fmtMoney(s.estMonthlyNetProfit) + "</b></div>" +
        '<div style="display:flex;justify-content:space-between;"><span>Est. Lifetime Revenue</span><b style="color:var(--text);">' + fmtMoney(s.estLifetimeRevenue) + "</b></div>" +
        '<div style="display:flex;justify-content:space-between;"><span>Est. Lifetime Net Profit</span><b style="color:var(--text);">' + fmtMoney(s.estLifetimeNetProfit) + "</b></div>" +
        (s.hasMissing ? '<div style="margin-top:4px;color:var(--brand-gold-dark);">⚠ Some figures use incomplete data</div>' : "") +
        '<button type="button" class="ofin-toggle" data-ofin-client="' + esc(clientId) + '" style="margin-top:6px;background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:10px;font-weight:700;color:var(--brand-navy,var(--brand));cursor:pointer;">🔒 Owner Financial Snapshot ▾</button>' +
      "</div>"
    );
  }

  // ---------- Full collapsible snapshot body (read-only view) ----------
  function snapshotBodyHTML(data, clientId) {
    if (!data) {
      return '<div style="padding:10px;font-size:11.5px;color:var(--text-muted);">Could not load financial data.</div>';
    }
    const inputs = data.inputs || {};
    const rev = data.revenue;
    const profit = data.netProfit;
    const life = data.lifetime;

    const missingHTML = (data.missingLabels || []).length
      ? '<div style="margin:8px 0;padding:8px 10px;background:#fdecec;border:1px solid #f5c2c2;border-radius:8px;font-size:11px;color:#a3282e;">' +
          '<b style="display:block;margin-bottom:3px;">Missing information</b>' +
          data.missingLabels.map((l) => "<div>• " + esc(l) + "</div>").join("") +
        "</div>"
      : "";

    const row = (label, val) =>
      '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;"><span style="color:var(--text-muted);">' + esc(label) + "</span><b>" + fmtMoney(val) + "</b></div>";

    const revenueBlock = rev
      ? '<div style="margin-top:10px;"><b style="font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--text-muted);">Estimated Revenue</b>' +
          row("Weekly", rev.weekly) + row("Monthly", rev.monthly) + row("Annual", rev.annual) +
          (rev.authorizationPeriod != null ? row("Authorization period", rev.authorizationPeriod) : "") +
        "</div>"
      : "";

    const profitBlock = profit
      ? '<div style="margin-top:10px;"><b style="font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--text-muted);">Estimated Net Profit</b>' +
          row("Weekly", profit.weekly) + row("Monthly", profit.monthly) + row("Annual", profit.annual) +
          (profit.authorizationPeriod != null ? row("Authorization period", profit.authorizationPeriod) : "") +
        "</div>"
      : "";

    const lifetimeBlock = life
      ? '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">' +
          '<b style="font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--text-muted);">Estimated Lifetime Client Value</b>' +
          (life.isInactive ? '<div style="margin:4px 0;display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;background:#eee;color:#555;">Inactive -- projections stopped as of service end</div>' : "") +
          '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Service start: ' + esc(life.serviceStartDate ? life.serviceStartDate.slice(0, 10) : "—") +
            (life.serviceEndDate ? " · Service end: " + esc(life.serviceEndDate.slice(0, 10)) : "") + "</div>" +
          '<div style="font-size:11px;color:var(--text-muted);">Total service weeks: ' + esc(life.totalServiceWeeks ?? "—") + " · Lifetime hours: " + esc(life.lifetimeHours ?? "—") + "</div>" +
          row("Lifetime revenue", life.lifetimeRevenue) +
          row("Lifetime net profit", life.lifetimeNetProfit) +
          (life.projected12moRevenue != null ? row("Projected 12-mo revenue", life.projected12moRevenue) : "") +
          (life.projected12moNetProfit != null ? row("Projected 12-mo net profit", life.projected12moNetProfit) : "") +
          row("Combined value (revenue)", life.combinedRevenue) +
          row("Combined value (net profit)", life.combinedNetProfit) +
          '<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Calculation source: ' + esc(life.calculationSource) + "</div>" +
        "</div>"
      : "";

    return (
      '<div style="padding:10px;">' +
        (inputs.hoursSourceLabel
          ? '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">Projection based on: ' + esc(inputs.hoursSourceLabel) + "</div>"
          : "") +
        missingHTML +
        revenueBlock +
        profitBlock +
        lifetimeBlock +
        '<div style="margin-top:10px;"><button type="button" class="ofin-edit-open" data-ofin-client="' + esc(clientId) + '" style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 9px;font-size:10.5px;font-weight:700;color:var(--brand-navy,var(--brand));cursor:pointer;">✎ Edit hours &amp; dates</button></div>' +
        '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);font-size:9.5px;line-height:1.5;color:var(--text-muted);">Financial projections are based on Spectrum Squad’s current company-wide revenue and net-profit averages per client-service hour. These figures are estimates for planning purposes and may differ from actual billed, collected, or accounting results.</div>' +
      "</div>"
    );
  }

  // ---------- Phase 4b: inline edit form for one client's overrides ----------
  function editFormHTML(clientId, data) {
    const s = (data && data.settings) || {};
    const pref = s.hours_source_preference || "scheduled";
    return (
      '<div class="ofin-edit-form" style="padding:10px;border-top:1px dashed var(--border);">' +
        '<div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--text-muted);margin-bottom:6px;">Edit projection inputs</div>' +

        '<label style="display:block;font-size:11px;margin-bottom:8px;">Hours source' +
          '<select class="ofin-f-hours-source" style="display:block;width:100%;margin-top:3px;padding:5px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;">' +
            '<option value="scheduled"' + (pref === "scheduled" ? " selected" : "") + ">Scheduled hours/week (default)</option>" +
            '<option value="authorized"' + (pref === "authorized" ? " selected" : "") + ">Authorized hours/week</option>" +
            '<option value="custom"' + (pref === "custom" ? " selected" : "") + ">Custom projected hours/week</option>" +
          "</select>" +
        "</label>" +

        '<label style="display:block;font-size:11px;margin-bottom:8px;">Authorized hours/week' +
          '<input type="number" min="0" step="0.5" class="ofin-f-authorized" value="' + esc(s.authorized_hours_per_week ?? "") + '" style="display:block;width:100%;margin-top:3px;padding:5px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;" />' +
        "</label>" +

        '<label style="display:block;font-size:11px;margin-bottom:8px;">Custom projected hours/week' +
          '<input type="number" min="0" step="0.5" class="ofin-f-custom" value="' + esc(s.custom_projected_hours_per_week ?? "") + '" style="display:block;width:100%;margin-top:3px;padding:5px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;" />' +
        "</label>" +

        '<label style="display:block;font-size:11px;margin-bottom:8px;">Service start date override' +
          '<input type="date" class="ofin-f-start" value="' + esc(dateVal(s.service_start_date_override)) + '" style="display:block;width:100%;margin-top:3px;padding:5px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;" />' +
        "</label>" +

        '<label style="display:block;font-size:11px;margin-bottom:8px;">Service end date override' +
          '<input type="date" class="ofin-f-end" value="' + esc(dateVal(s.service_end_date_override)) + '" style="display:block;width:100%;margin-top:3px;padding:5px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;" />' +
        "</label>" +

        '<label style="display:block;font-size:11px;margin-bottom:10px;">Lifetime calculation source' +
          '<select class="ofin-f-lifetime-source" style="display:block;width:100%;margin-top:3px;padding:5px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;">' +
            LIFETIME_SOURCES.map((o) => '<option value="' + o.value + '"' + ((s.lifetime_calc_source || "estimated_from_schedule") === o.value ? " selected" : "") + ">" + esc(o.label) + "</option>").join("") +
          "</select>" +
        "</label>" +

        '<div class="ofin-edit-error" style="display:none;font-size:10.5px;color:#a3282e;margin-bottom:8px;"></div>' +

        '<div style="display:flex;gap:8px;">' +
          '<button type="button" class="ofin-edit-save" data-ofin-client="' + esc(clientId) + '" style="flex:1;background:var(--brand-navy,var(--brand));color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;">Save</button>' +
          '<button type="button" class="ofin-edit-cancel" style="flex:0 0 auto;background:none;border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;">Cancel</button>' +
        "</div>" +
      "</div>"
    );
  }

  function fullSectionShellHTML() {
    return (
      '<div class="ofin-full" style="display:none;margin-top:8px;background:var(--brand-light,#edecf8);border:1px solid var(--border);border-radius:10px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border);">' +
          '<b style="font-size:11.5px;color:var(--brand-navy,var(--brand));">🔒 Owner Financial Snapshot</b>' +
          '<span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#a3282e;background:#fdecec;padding:2px 6px;border-radius:999px;">Private — Owner Only</span>' +
        "</div>" +
        '<div class="ofin-full-body" style="font-size:11.5px;">Loading…</div>' +
      "</div>"
    );
  }

  // Wires a single card's compact-line + collapsible section, including the
  // Phase 4b edit form. `container` is the card (or modal content) element
  // to append into; `clientId` is the client this section belongs to.
  function attachSection(container, clientId) {
    if (!container || container.dataset.ofin === "1") return;
    container.dataset.ofin = "1";

    const wrap = document.createElement("div");
    wrap.innerHTML = compactHTML(clientId) + fullSectionShellHTML();
    // Prevent clicks anywhere in our injected section from bubbling up to
    // the card's own click handler (which opens the client modal).
    wrap.addEventListener("click", (e) => e.stopPropagation());
    container.appendChild(wrap);

    if (!attachedNodes[clientId]) attachedNodes[clientId] = [];
    attachedNodes[clientId].push(wrap);

    wireWrap(wrap, clientId);
  }

  // Loads + renders the full breakdown into fullBody and wires its Edit
  // button. `fullBody.dataset.ofinLoaded` tracks whether this has happened
  // at least once, so re-opening doesn't unnecessarily re-fetch, and so
  // refreshClientUI (below) can tell whether an open section actually has
  // content to refresh.
  async function renderFullBody(fullBody, clientId, forceRefresh) {
    const data = await getFullFinancials(clientId, forceRefresh);
    fullBody.innerHTML = snapshotBodyHTML(data, clientId);
    fullBody.dataset.ofinLoaded = "1";
    wireFullBody(fullBody, clientId, data);
  }

  // Wires a toggle button's click behavior. Single source of truth for
  // open/close + lazy-load, called both when a wrap is first attached and
  // again after its compact block is replaced (which creates a brand new
  // button element that needs its own listener). Guarded by _ofinWired so
  // the same button element is never wired twice.
  function wireToggle(wrap, clientId) {
    const toggleBtn = wrap.querySelector(".ofin-toggle");
    const fullSection = wrap.querySelector(".ofin-full");
    const fullBody = wrap.querySelector(".ofin-full-body");
    if (!toggleBtn || toggleBtn._ofinWired) return;
    toggleBtn._ofinWired = true;
    toggleBtn.addEventListener("click", async () => {
      const isOpen = fullSection.style.display !== "none";
      if (isOpen) {
        fullSection.style.display = "none";
        toggleBtn.textContent = "🔒 Owner Financial Snapshot ▾";
        return;
      }
      fullSection.style.display = "block";
      toggleBtn.textContent = "🔒 Owner Financial Snapshot ▴";
      if (fullBody.dataset.ofinLoaded !== "1") {
        await renderFullBody(fullBody, clientId, false);
      }
    });
  }

  // (Re)wires a single injected wrap. Called once on attach; also exposes
  // hooks refreshClientUI uses after a save to update this wrap in place.
  function wireWrap(wrap, clientId) {
    wireToggle(wrap, clientId);

    // Exposed so refreshClientUI can force this particular wrap to reload
    // with fresh data after a save made from a different open copy of the
    // same client's section (card + modal open at once, edge case but cheap
    // to handle correctly).
    wrap._ofinReloadOpen = () => {
      const fullSection = wrap.querySelector(".ofin-full");
      const fullBody = wrap.querySelector(".ofin-full-body");
      if (!fullSection || fullSection.style.display === "none") return Promise.resolve();
      return renderFullBody(fullBody, clientId, true);
    };
    wrap._ofinUpdateCompact = () => {
      const compact = wrap.querySelector(".ofin-compact");
      if (!compact) return;
      const fresh = document.createElement("div");
      fresh.innerHTML = compactHTML(clientId);
      compact.replaceWith(fresh.firstChild);
      wireToggle(wrap, clientId);
    };
  }

  function wireFullBody(fullBody, clientId, data) {
    const editOpenBtn = fullBody.querySelector(".ofin-edit-open");
    if (editOpenBtn) {
      editOpenBtn.addEventListener("click", () => {
        if (fullBody.querySelector(".ofin-edit-form")) return; // already open
        const div = document.createElement("div");
        div.innerHTML = editFormHTML(clientId, data);
        fullBody.appendChild(div.firstChild);
        wireEditForm(fullBody, clientId);
      });
    }
  }

  function wireEditForm(fullBody, clientId) {
    const form = fullBody.querySelector(".ofin-edit-form");
    if (!form) return;
    const cancelBtn = form.querySelector(".ofin-edit-cancel");
    const saveBtn = form.querySelector(".ofin-edit-save");
    const errorBox = form.querySelector(".ofin-edit-error");

    cancelBtn.addEventListener("click", () => form.remove());

    saveBtn.addEventListener("click", async () => {
      const numOrNull = (v) => (v === "" || v == null ? null : Number(v));
      const dateOrNull = (v) => (v === "" || v == null ? null : v);
      const payload = {
        hours_source_preference: form.querySelector(".ofin-f-hours-source").value,
        authorized_hours_per_week: numOrNull(form.querySelector(".ofin-f-authorized").value),
        custom_projected_hours_per_week: numOrNull(form.querySelector(".ofin-f-custom").value),
        service_start_date_override: dateOrNull(form.querySelector(".ofin-f-start").value),
        service_end_date_override: dateOrNull(form.querySelector(".ofin-f-end").value),
        lifetime_calc_source: form.querySelector(".ofin-f-lifetime-source").value,
      };
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      errorBox.style.display = "none";
      try {
        const res = await fetch("/api/clients/" + encodeURIComponent(clientId) + "/financial-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error("Save failed");
        const fresh = await res.json();
        detailCache[clientId] = fresh;
        await refreshSummary();
        await refreshClientUI(clientId);
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
        errorBox.textContent = "Could not save. Please try again.";
        errorBox.style.display = "block";
      }
    });
  }

  // Re-renders every currently-attached copy of a client's section (there
  // can be more than one -- e.g. the board card and an open modal) using
  // freshly-fetched data, and closes any open edit form since it's now
  // saved. No manual "recalculate" step is needed anywhere: the very next
  // GET this triggers recomputes everything server-side from the saved
  // inputs.
  async function refreshClientUI(clientId) {
    const nodes = (attachedNodes[clientId] || []).filter((n) => n.isConnected);
    attachedNodes[clientId] = nodes;
    for (const wrap of nodes) {
      if (wrap._ofinUpdateCompact) wrap._ofinUpdateCompact();
      if (wrap._ofinReloadOpen) await wrap._ofinReloadOpen();
    }
  }

  function scanAndAttach(root) {
    if (authorized !== true) return;
    (root || document).querySelectorAll(".client-card[data-client]").forEach((card) => {
      attachSection(card, card.getAttribute("data-client"));
    });
    (root || document).querySelectorAll("[data-pv2-open]").forEach((card) => {
      attachSection(card, card.getAttribute("data-pv2-open"));
    });
    const modalBody = (root || document).querySelector(".modal-backdrop .modal");
    if (modalBody && lastOpenedClientId) {
      attachSection(modalBody, lastOpenedClientId);
    }
    attachDashboardStat();
  }

  function computeTotalMonthlyNetProfit() {
    if (!summaryData) return null;
    let total = 0;
    let any = false;
    let missing = false;
    Object.values(summaryData).forEach((s) => {
      if (!s) return;
      if (typeof s.estMonthlyNetProfit === "number") {
        total += s.estMonthlyNetProfit;
        any = true;
      }
      if (s.hasMissing) missing = true;
    });
    return any ? { total, missing } : null;
  }

  function attachDashboardStat() {
    if (authorized !== true) return;
    const grid = document.querySelector(".stat-grid");
    if (!grid) return;
    let card = grid.querySelector(".ofin-dash-stat");
    if (!card) {
      card = document.createElement("div");
      card.className = "stat-card ofin-dash-stat";
      card.innerHTML =
        '<div class="label">🔒 Est. Total Monthly Net Profit</div>' +
        '<div class="value"></div>' +
        '<div class="ofin-dash-note" style="font-size:10.5px;color:var(--text-muted,#767488);margin-top:2px;"></div>';
      grid.appendChild(card);
    }
    const result = computeTotalMonthlyNetProfit();
    card.querySelector(".value").textContent = result ? fmtMoney(result.total) : "—";
    card.querySelector(".ofin-dash-note").textContent = result && result.missing ? "Some clients missing info" : "";
  }

  // ---------- Phase 4c: private Owner Financial Settings page ----------
  function injectSettingsNavButton() {
    if (authorized !== true) return;
    const nav = document.querySelector(".sidebar nav");
    if (!nav || document.getElementById("ofin-settings-nav-btn")) return;
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.id = "ofin-settings-nav-btn";
    btn.textContent = "⚙ Financial Settings";
    btn.addEventListener("click", () => {
      location.hash = SETTINGS_HASH;
    });
    nav.appendChild(btn);
  }

  function setSettingsNavActive(isActive) {
    const btn = document.getElementById("ofin-settings-nav-btn");
    if (!btn) return;
    if (isActive) {
      document.querySelectorAll(".sidebar nav .nav-item").forEach((el) => el.classList.remove("active"));
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  }

  function roleCheckboxesHTML(currentRoles) {
    return ALL_ROLES.map((r) => {
      const checked = currentRoles.includes(r);
      const locked = r === "owner"; // never let this be unchecked from the UI -- avoids locking the account out
      return (
        '<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;padding:3px 0;">' +
          '<input type="checkbox" class="ofin-role-cb" value="' + r + '"' + (checked ? " checked" : "") + (locked ? " disabled" : "") + " />" +
          esc(r) + (locked ? ' <span style="color:var(--text-muted);font-size:10.5px;">(always included)</span>' : "") +
        "</label>"
      );
    }).join("");
  }

  function settingsPageHTML(settings) {
    const roles = (settings.financial_view_roles || "owner,super_admin").split(",").map((r) => r.trim()).filter(Boolean);
    return (
      '<div style="padding:24px 28px 60px;max-width:520px;">' +
        '<h1 style="font-size:24px;margin:0 0 4px;font-weight:700;color:var(--brand-navy,var(--brand));">🔒 Financial Settings</h1>' +
        '<p style="margin:0 0 18px;color:var(--text-muted);font-size:13px;">Private — Owner Only. Controls the company-wide averages used to estimate revenue and net profit per client, and who is allowed to see any of it.</p>' +

        '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;">' +
          '<label style="display:block;font-size:12.5px;margin-bottom:12px;">Average revenue per hour ($)' +
            '<input type="number" min="0" step="0.01" id="ofin-s-revenue" value="' + esc(settings.avg_revenue_per_hour) + '" style="display:block;width:100%;margin-top:4px;padding:7px;font-size:13px;border:1px solid var(--border);border-radius:6px;" />' +
          "</label>" +
          '<label style="display:block;font-size:12.5px;margin-bottom:12px;">Average net profit per hour ($)' +
            '<input type="number" min="0" step="0.01" id="ofin-s-profit" value="' + esc(settings.avg_net_profit_per_hour) + '" style="display:block;width:100%;margin-top:4px;padding:7px;font-size:13px;border:1px solid var(--border);border-radius:6px;" />' +
          "</label>" +
          '<label style="display:block;font-size:12.5px;margin-bottom:12px;">Monthly conversion factor (weeks/month)' +
            '<input type="number" min="0" step="0.01" id="ofin-s-monthly" value="' + esc(settings.monthly_conversion_factor) + '" style="display:block;width:100%;margin-top:4px;padding:7px;font-size:13px;border:1px solid var(--border);border-radius:6px;" />' +
          "</label>" +
          '<label style="display:block;font-size:12.5px;margin-bottom:16px;">Default hours source' +
            '<select id="ofin-s-default-source" style="display:block;width:100%;margin-top:4px;padding:7px;font-size:13px;border:1px solid var(--border);border-radius:6px;">' +
              '<option value="scheduled"' + (settings.default_hours_source === "scheduled" ? " selected" : "") + ">Scheduled hours/week</option>" +
              '<option value="authorized"' + (settings.default_hours_source === "authorized" ? " selected" : "") + ">Authorized hours/week</option>" +
              '<option value="custom"' + (settings.default_hours_source === "custom" ? " selected" : "") + ">Custom projected hours/week</option>" +
            "</select>" +
          "</label>" +
          '<div style="font-size:12.5px;font-weight:700;margin-bottom:6px;">Who can view client financials</div>' +
          '<div id="ofin-s-roles">' + roleCheckboxesHTML(roles) + "</div>" +
          '<div class="ofin-s-error" style="display:none;font-size:11px;color:#a3282e;margin-top:10px;"></div>' +
          '<button type="button" id="ofin-s-save" style="margin-top:16px;background:var(--brand-navy,var(--brand));color:#fff;border:none;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;">Save settings</button>' +
          '<span id="ofin-s-saved" style="display:none;margin-left:10px;font-size:12px;color:#177a3c;">Saved.</span>' +
        "</div>" +
      "</div>"
    );
  }

  function wireSettingsPage(mount) {
    const saveBtn = mount.querySelector("#ofin-s-save");
    const savedMsg = mount.querySelector("#ofin-s-saved");
    const errorBox = mount.querySelector(".ofin-s-error");
    if (!saveBtn) return;
    saveBtn.addEventListener("click", async () => {
      const roles = Array.from(mount.querySelectorAll(".ofin-role-cb"))
        .filter((cb) => cb.checked || cb.disabled) // disabled checkboxes are the always-included owner role
        .map((cb) => cb.value);
      const payload = {
        avg_revenue_per_hour: Number(mount.querySelector("#ofin-s-revenue").value),
        avg_net_profit_per_hour: Number(mount.querySelector("#ofin-s-profit").value),
        monthly_conversion_factor: Number(mount.querySelector("#ofin-s-monthly").value),
        default_hours_source: mount.querySelector("#ofin-s-default-source").value,
        financial_view_roles: roles.join(","),
      };
      saveBtn.disabled = true;
      savedMsg.style.display = "none";
      errorBox.style.display = "none";
      try {
        const res = await fetch("/api/owner-financial-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error("Save failed");
        ownerSettingsCache = await res.json();
        // Company-wide rates changed -- every already-fetched client detail
        // is now stale, so drop the cache and refresh the summary line for
        // any cards currently on screen.
        Object.keys(detailCache).forEach((k) => delete detailCache[k]);
        await refreshSummary();
        for (const clientId of Object.keys(attachedNodes)) {
          await refreshClientUI(clientId);
        }
        saveBtn.disabled = false;
        savedMsg.style.display = "inline";
      } catch (e) {
        saveBtn.disabled = false;
        errorBox.textContent = "Could not save. Please try again.";
        errorBox.style.display = "block";
      }
    });
  }

  async function renderSettingsPage() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    mount.innerHTML = '<div style="padding:40px;color:var(--text-muted);">Loading financial settings...</div>';
    const settings = ownerSettingsCache || (await (async () => {
      const res = await fetch("/api/owner-financial-settings");
      return res.ok ? res.json() : null;
    })());
    if (!settings) {
      mount.innerHTML = '<div style="padding:40px;color:#a3282e;">Could not load financial settings.</div>';
      return;
    }
    ownerSettingsCache = settings;
    mount.innerHTML = settingsPageHTML(settings);
    mount.dataset.ofinSettings = "1";
    wireSettingsPage(mount);
  }

  function watchSettingsMount() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    if (settingsMountObserver) settingsMountObserver.disconnect();
    settingsMountObserver = new MutationObserver(() => {
      if (location.hash !== SETTINGS_HASH) return;
      const m = document.getElementById("view-mount");
      if (m && m.dataset.ofinSettings !== "1") renderSettingsPage();
    });
    settingsMountObserver.observe(mount, { childList: true });
  }

  function reassertSettingsIfNeeded() {
    if (location.hash !== SETTINGS_HASH) return;
    if (authorized !== true) return;
    setSettingsNavActive(true);
    const mount = document.getElementById("view-mount");
    if (mount && mount.dataset.ofinSettings !== "1") renderSettingsPage();
  }

  function onHashChange() {
    const isSettings = location.hash === SETTINGS_HASH;
    setSettingsNavActive(isSettings);
    if (!isSettings) {
      if (settingsMountObserver) { settingsMountObserver.disconnect(); settingsMountObserver = null; }
      return;
    }
    if (authorized !== true) return; // no nav button either, but guard direct hash navigation too
    watchSettingsMount();
    renderSettingsPage();
    [100, 300, 800, 1500].forEach((ms) => setTimeout(reassertSettingsIfNeeded, ms));
  }

  function boot() {
    // Capture-phase click listener: records which client a card click was
    // for, just before the app's own handler opens its modal. This works
    // for both card types without needing to touch the app's own
    // module-scoped functions, which aren't reachable from outside.
    document.addEventListener(
      "click",
      (e) => {
        const el = e.target.closest("[data-client]");
        const pv2 = e.target.closest("[data-pv2-open]");
        if (el) lastOpenedClientId = el.getAttribute("data-client");
        else if (pv2) lastOpenedClientId = pv2.getAttribute("data-pv2-open");
      },
      true
    );

    checkAuthorizedAndLoad().then(() => {
      if (authorized) {
        scanAndAttach(document);
        injectSettingsNavButton();
        if (location.hash === SETTINGS_HASH) onHashChange();
      }
    });

    // Re-scan whenever the app (re)renders cards or opens the modal, and
    // re-inject the nav button if the app's own re-render wiped it out.
    // Only ever ADDS content behind idempotent guards (dataset.ofin,
    // getElementById checks), so this cannot loop even though it's
    // watching the whole document.
    new MutationObserver(() => {
      if (authorized === true) {
        scanAndAttach(document);
        injectSettingsNavButton();
      }
    }).observe(document.body, { childList: true, subtree: true });

    window.addEventListener("hashchange", onHashChange);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
