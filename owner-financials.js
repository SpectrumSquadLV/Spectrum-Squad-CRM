// owner-financials.js -- Injects a private "Owner Financial Snapshot" into
// existing client cards (both board views) and the client detail modal.
// Progressive-enhancement plugin, same pattern as theme.js/attendance.js/
// pipeline-v2.js: never touches the app's own module-scoped state/route,
// just watches the DOM and reacts.
//
// Permission is enforced before anything renders: on load this probes
// GET /api/owner-financial-settings once. A 403 means the logged-in user
// is not permitted to see financials -- in that case this script fetches
// nothing else and injects nothing, ever, for the rest of the session. All
// of the real enforcement already happened server-side in Phase 3; this is
// just staying consistent with it on the client, not a second gate.
(function () {
  let authorized = null; // null = not yet checked, true/false after probe
  let summaryData = null; // { [clientId]: {estMonthlyRevenue, ...} }
  const detailCache = {}; // { [clientId]: full /financials response }
  let lastOpenedClientId = null;

  function fmtMoney(n) {
    if (n == null) return "—";
    const sign = n < 0 ? "-" : "";
    return sign + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
  }

  async function checkAuthorizedAndLoad() {
    try {
      const res = await fetch("/api/owner-financial-settings");
      if (!res.ok) {
        authorized = false;
        return;
      }
      authorized = true;
      const sumRes = await fetch("/api/clients/financials-summary");
      summaryData = sumRes.ok ? await sumRes.json() : {};
    } catch (e) {
      authorized = false;
    }
  }

  async function getFullFinancials(clientId) {
    if (detailCache[clientId]) return detailCache[clientId];
    const res = await fetch("/api/clients/" + encodeURIComponent(clientId) + "/financials");
    if (!res.ok) return null;
    const data = await res.json();
    detailCache[clientId] = data;
    return data;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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

  // ---------- Full collapsible snapshot (lazy-loaded on first expand) ----------
  function snapshotBodyHTML(data) {
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
        '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);font-size:9.5px;line-height:1.5;color:var(--text-muted);">Financial projections are based on Spectrum Squad’s current company-wide revenue and net-profit averages per client-service hour. These figures are estimates for planning purposes and may differ from actual billed, collected, or accounting results.</div>' +
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

  // Wires a single card's compact-line + collapsible section. `container`
  // is the card (or modal content) element to append into; `clientId` is
  // the client this section belongs to.
  function attachSection(container, clientId) {
    if (!container || container.dataset.ofin === "1") return;
    container.dataset.ofin = "1";

    const wrap = document.createElement("div");
    wrap.innerHTML = compactHTML(clientId) + fullSectionShellHTML();
    // Prevent clicks anywhere in our injected section from bubbling up to
    // the card's own click handler (which opens the client modal).
    wrap.addEventListener("click", (e) => e.stopPropagation());
    container.appendChild(wrap);

    const toggleBtn = wrap.querySelector(".ofin-toggle");
    const fullSection = wrap.querySelector(".ofin-full");
    const fullBody = wrap.querySelector(".ofin-full-body");
    let loaded = false;
    if (toggleBtn) {
      toggleBtn.addEventListener("click", async () => {
        const isOpen = fullSection.style.display !== "none";
        if (isOpen) {
          fullSection.style.display = "none";
          toggleBtn.textContent = "🔒 Owner Financial Snapshot ▾";
          return;
        }
        fullSection.style.display = "block";
        toggleBtn.textContent = "🔒 Owner Financial Snapshot ▴";
        if (!loaded) {
          loaded = true;
          const data = await getFullFinancials(clientId);
          fullBody.innerHTML = snapshotBodyHTML(data);
        }
      });
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
      if (authorized) scanAndAttach(document);
    });

    // Re-scan whenever the app (re)renders cards or opens the modal. Only
    // ever ADDS content behind the idempotent dataset.ofin guard above, so
    // this cannot loop even though it's watching the whole document.
    new MutationObserver(() => {
      if (authorized === true) scanAndAttach(document);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
