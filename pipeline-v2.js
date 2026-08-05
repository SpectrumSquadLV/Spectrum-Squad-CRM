// pipeline-v2.js -- Milestone dashboard (New Lead -> Intake & Eligibility ->
// Clinical Assessment -> Authorization -> Ready to Start -> Active Services).
// Progressive-enhancement plugin: injects its own nav button and renders
// into the existing #view-mount container on hashchange, without touching
// the app's own router/state (which are module-scoped, not global).
(function () {
  const HASH = "#/pipeline-v2";

  const MILESTONES = [
    { key: 1, label: "New Lead", color: "#6b7280" },
    { key: 2, label: "Intake & Eligibility", color: "#6660a8" },
    { key: 3, label: "Clinical Assessment", color: "#3f8f89" },
    { key: 4, label: "Authorization", color: "#c98a1b" },
    { key: 5, label: "Ready to Start", color: "#e0a430" },
    { key: 6, label: "Active Services", color: "#22c55e" },
  ];

  const BLOCKERS = {
    parent: { label: "Waiting on parent", color: "#ef4444", bg: "#fdecec", text: "#a3282e" },
    insurance: { label: "Waiting on insurance", color: "#f59e0b", bg: "#fef3e0", text: "#946213" },
    clinical: { label: "Waiting on clinical", color: "#3b82f6", bg: "#e9f0ff", text: "#1e4fa3" },
    provider: { label: "Waiting on previous provider", color: "#8b5cf6", bg: "#f1ecff", text: "#5b3ec4" },
    ready: { label: "Ready for scheduling", color: "#22c55e", bg: "#e9f9ee", text: "#177a3c" },
  };

  const PRIORITY_STYLE = {
    High: { bg: "#fdecec", text: "#a3282e" },
    Medium: { bg: "#fef3e0", text: "#946213" },
    Low: { bg: "#e9f9ee", text: "#177a3c" },
  };

  let allClients = [];
  let filters = {};

  function injectNavButton() {
    const nav = document.querySelector(".sidebar nav");
    if (!nav || document.getElementById("pv2-nav-btn")) return;
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.id = "pv2-nav-btn";
    btn.textContent = "◱ Pipeline v2";
    btn.addEventListener("click", () => {
      location.hash = HASH;
    });
    nav.appendChild(btn);
  }

  function setActiveNav(isActive) {
    const btn = document.getElementById("pv2-nav-btn");
    if (!btn) return;
    if (isActive) {
      document.querySelectorAll(".sidebar nav .nav-item").forEach((el) => el.classList.remove("active"));
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  }

  async function loadAndRender() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    mount.innerHTML = '<div style="padding:40px;color:#767488;">Loading pipeline...</div>';
    try {
      const res = await fetch("/api/dashboard/pipeline-v2");
      allClients = await res.json();
    } catch (e) {
      mount.innerHTML = '<div style="padding:40px;color:#a3282e;">Failed to load pipeline data.</div>';
      return;
    }
    render();
  }

  function uniqueValues(key) {
    return [...new Set(allClients.map((c) => c[key]).filter(Boolean))].sort();
  }

  function applyFilters(list) {
    return list.filter((c) => {
      if (filters.milestone && String(c.milestone) !== filters.milestone) return false;
      if (filters.blocker && c.blocker !== filters.blocker) return false;
      if (filters.priority && c.priority !== filters.priority) return false;
      if (filters.insurance && c.insurance_provider !== filters.insurance) return false;
      if (filters.bcba && c.assigned_bcba_name !== filters.bcba) return false;
      if (filters.service && c.service_location !== filters.service) return false;
      if (filters.days && c.daysInStage < Number(filters.days)) return false;
      return true;
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function cardHTML(c) {
    const ms = MILESTONES.find((m) => m.key === c.milestone) || MILESTONES[0];
    const b = BLOCKERS[c.blocker] || BLOCKERS.ready;
    const p = PRIORITY_STYLE[c.priority] || PRIORITY_STYLE.Low;
    const missing = (c.missingItems || []).slice(0, 3);
    return (
      '<div style="background:#fff;border:1px solid #e6e1d4;border-radius:12px;padding:13px 14px;margin-bottom:10px;border-left:4px solid ' + ms.color + ';cursor:pointer;" data-pv2-open="' + c.id + '">' +
        '<div style="font-weight:700;font-size:14.5px;margin-bottom:6px;">' + esc(c.child_name) + "</div>" +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#767488;margin-bottom:2px;"><span>Owner</span><b style="color:#2b2a35;">' + esc(c.owner || "Unassigned") + "</b></div>" +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#767488;margin-bottom:2px;"><span>Days in stage</span><b style="color:#2b2a35;">' + (c.daysInStage ?? "—") + "</b></div>" +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#767488;margin-bottom:6px;"><span>Priority</span><span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;background:' + p.bg + ";color:" + p.text + ';">' + esc(c.priority || "—") + "</span></div>" +
        '<div style="background:#eee;border-radius:6px;height:6px;overflow:hidden;margin:6px 0 8px;"><div style="height:100%;border-radius:6px;width:' + (c.progressPct || 0) + "%;background:" + ms.color + ';"></div></div>' +
        '<div style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;margin:0 0 8px;background:' + b.bg + ";color:" + b.text + ';"><span style="width:8px;height:8px;border-radius:50%;background:' + b.color + ';display:inline-block;"></span>' + esc(b.label) + "</div>" +
        (missing.length ? '<div style="font-size:12px;margin-top:4px;line-height:1.6;color:#a3282e;">' + missing.map((m) => "<div>✕ " + esc(m) + "</div>").join("") + "</div>" : "") +
        '<div style="font-size:12px;margin-top:8px;background:#faf8f2;border-radius:8px;padding:7px 9px;border:1px solid #e6e1d4;"><b style="display:block;font-size:10.5px;text-transform:uppercase;color:#767488;margin-bottom:2px;">Next action</b>' + esc(c.nextAction || "—") + "</div>" +
      "</div>"
    );
  }

  function filterBarHTML() {
    const opt = (arr) => arr.map((v) => '<option value="' + esc(v) + '">' + esc(v) + "</option>").join("");
    return (
      '<div style="background:#fff;border:1px solid #e6e1d4;border-radius:12px;padding:14px 16px;margin-bottom:18px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">' +
        '<select id="pv2-f-milestone"><option value="">All milestones</option>' + MILESTONES.map((m) => '<option value="' + m.key + '">' + esc(m.label) + "</option>").join("") + "</select>" +
        '<select id="pv2-f-blocker"><option value="">All blockers</option>' + Object.entries(BLOCKERS).map(([k, b]) => '<option value="' + k + '">' + esc(b.label) + "</option>").join("") + "</select>" +
        '<select id="pv2-f-priority"><option value="">All priorities</option><option>High</option><option>Medium</option><option>Low</option></select>' +
        '<select id="pv2-f-insurance"><option value="">All insurers</option>' + opt(uniqueValues("insurance_provider")) + "</select>" +
        '<select id="pv2-f-bcba"><option value="">All BCBAs</option>' + opt(uniqueValues("assigned_bcba_name")) + "</select>" +
        '<select id="pv2-f-service"><option value="">All service types</option>' + opt(uniqueValues("service_location")) + "</select>" +
        '<select id="pv2-f-days"><option value="">Any days waiting</option><option value="7">7+ days</option><option value="14">14+ days</option><option value="21">21+ days</option></select>' +
        '<button type="button" id="pv2-f-clear" style="margin-left:auto;background:none;border:none;color:#29225c;text-decoration:underline;font-size:12.5px;cursor:pointer;">Clear filters</button>' +
      "</div>"
    );
  }

  function wireFilters(mount) {
    const map = { milestone: "pv2-f-milestone", blocker: "pv2-f-blocker", priority: "pv2-f-priority", insurance: "pv2-f-insurance", bcba: "pv2-f-bcba", service: "pv2-f-service", days: "pv2-f-days" };
    Object.keys(map).forEach((key) => {
      const el = mount.querySelector("#" + map[key]);
      if (!el) return;
      el.value = filters[key] || "";
      el.addEventListener("change", () => {
        filters[key] = el.value;
        render();
      });
    });
    const clear = mount.querySelector("#pv2-f-clear");
    if (clear) clear.addEventListener("click", () => { filters = {}; render(); });
  }

  function render() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    const filtered = applyFilters(allClients);
    const columns = MILESTONES.map((m) => {
      const items = filtered.filter((c) => c.milestone === m.key);
      return (
        '<div style="flex:0 0 300px;background:rgba(0,0,0,0.02);border-radius:12px;padding:12px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;padding:2px 4px 12px;">' +
            '<div style="display:flex;align-items:center;gap:8px;"><span style="width:10px;height:10px;border-radius:50%;background:' + m.color + ';display:inline-block;"></span><h3 style="font-size:14px;margin:0;font-weight:700;">' + esc(m.label) + "</h3></div>" +
            '<span style="font-size:12px;color:#767488;background:#fff;border:1px solid #e6e1d4;border-radius:20px;padding:1px 9px;">' + items.length + "</span>" +
          "</div>" +
          (items.length ? items.map(cardHTML).join("") : '<div style="font-size:12.5px;color:#767488;text-align:center;padding:20px 4px;">No clients here right now.</div>') +
        "</div>"
      );
    }).join("");

    mount.innerHTML =
      '<div style="padding:24px 28px 60px;">' +
        '<h1 style="font-size:24px;margin:0 0 4px;font-weight:700;color:#29225c;">Client pipeline (v2)</h1>' +
        '<p style="margin:0 0 18px;color:#767488;font-size:14px;">Milestone view with progress, blockers, and next actions. Click a card to open the full client record.</p>' +
        filterBarHTML() +
        '<div style="display:flex;gap:16px;overflow-x:auto;padding-bottom:8px;align-items:flex-start;">' + columns + "</div>" +
      "</div>";

    wireFilters(mount);
    mount.querySelectorAll("[data-pv2-open]").forEach((card) => {
      card.addEventListener("click", () => {
        location.hash = "#/pipeline/" + card.getAttribute("data-pv2-open");
      });
    });
  }

  function onHashChange() {
    const isActive = location.hash === HASH;
    setActiveNav(isActive);
    if (isActive) loadAndRender();
  }

  function boot() {
    const tryInject = () => {
      injectNavButton();
      if (location.hash === HASH) onHashChange();
    };
    [150, 500, 1200, 2500, 4000].forEach((ms) => setTimeout(tryInject, ms));
    new MutationObserver(tryInject).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", onHashChange);
  }

  boot();
})();
