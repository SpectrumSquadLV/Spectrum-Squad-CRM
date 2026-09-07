// pipeline-v2.js -- Milestone dashboard. Five phases:
//   Intake & Eligibility -> Assessment -> Authorization -> Ready to Start -> Active.
// "New Lead" was retired as a standalone phase (folded into Intake &
// Eligibility server-side); labels match server.js MILESTONES exactly.
// Progressive-enhancement plugin: injects its own nav button and renders
// into the existing #view-mount container on hashchange, without touching
// the app's own router/state (which are module-scoped, not global).
(function () {
  const HASH = "#/pipeline-v2";

  const MILESTONES = [
    { key: 2, label: "Intake & Eligibility", color: "#3f56b5" },
    { key: 3, label: "Assessment", color: "#3f8f89" },
    { key: 4, label: "Authorization", color: "#c98a1b" },
    { key: 5, label: "Ready to Start", color: "#e0a430" },
    { key: 6, label: "Active", color: "#22c55e" },
  ];

  const BLOCKERS = {
    parent: { label: "Waiting on parent", color: "#ef4444", bg: "#fdecec", text: "#a3282e" },
    insurance: { label: "Waiting on insurance", color: "#f59e0b", bg: "#fef3e0", text: "#946213" },
    clinical: { label: "Waiting on clinical", color: "#3b82f6", bg: "#e9f0ff", text: "#1e4fa3" },
    provider: { label: "Waiting on previous provider", color: "#8b5cf6", bg: "#f1ecff", text: "#5b3ec4" },
    ready: { label: "Ready for scheduling", color: "#22c55e", bg: "#e9f9ee", text: "#177a3c" },
    active: { label: "In active services", color: "#16a34a", bg: "#dcfce7", text: "#166534" },
  };

  const PRIORITY_STYLE = {
    High: { bg: "#fdecec", text: "#a3282e" },
    Medium: { bg: "#fef3e0", text: "#946213" },
    Low: { bg: "#e9f9ee", text: "#177a3c" },
  };

  let allClients = [];
  let filters = {};
  let loaded = false;
  let mountObserver = null;

  // The sidebar button used to be injected here, for every logged-in user,
  // with no role check -- which meant HR-only roles could open the client
  // pipeline and the owner's Access toggle for it did nothing. index.html now
  // renders "Client Pipeline" as a normal nav item with a proper role check.

  // ---------------------------------------------------------------------
  // LANES. A column used to be one card wide, so a phase holding twenty
  // clients was twenty cards deep and the page just got longer -- which is
  // exactly how it was reported: "each client card going down, making the
  // page longer".
  //
  // The fix is not to widen every column. Four of the five phases hold a
  // handful of clients at a time and a wide, mostly empty column is worse
  // than a narrow full one. So a column earns lanes from how much it is
  // actually holding: a second past six cards, a third past fourteen, and
  // never more than three. The busy phase spreads sideways, the quiet ones
  // stay exactly as they were, and the board gets wider only where there is
  // something to put in the width.
  //
  // Below 1180px there is no width to spend, so every column collapses back
  // to one lane -- two 130px cards side by side would be worse than the
  // scrolling this is meant to shorten.
  //
  // Written as a stylesheet rather than the inline styles the rest of this
  // file uses, because the collapse needs a media query and an inline style
  // cannot hold one. Class names are prefixed: this file is loaded beside
  // the shell's own stylesheet and a bare name here would style the whole
  // application.
  var STYLE_ID = "pv2-board-style";
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = [
      ".pv2-board{display:flex;gap:16px;overflow-x:auto;padding-bottom:8px;align-items:flex-start;}",
      ".pv2-col{--pv2-lanes:1;--pv2-lane:300px;flex:0 0 auto;",
      "  width:calc(var(--pv2-lanes) * var(--pv2-lane) + (var(--pv2-lanes) - 1) * 10px + 24px);",
      "  background:rgba(0,0,0,0.02);border-radius:12px;padding:12px;}",
      ".pv2-col.pv2-l2{--pv2-lanes:2;--pv2-lane:264px;}",
      ".pv2-col.pv2-l3{--pv2-lanes:3;--pv2-lane:264px;}",
      ".pv2-cards{display:grid;grid-template-columns:repeat(var(--pv2-lanes),minmax(0,1fr));",
      "  gap:10px;align-content:start;}",
      "@media (max-width:1180px){.pv2-col.pv2-l2,.pv2-col.pv2-l3{--pv2-lanes:1;--pv2-lane:300px;}}",
    ].join("\n");
    document.head.appendChild(el);
  }

  // Six and fourteen are the thresholds, not a formula: below six a column
  // fits on a screen already, and past fourteen two lanes are still seven
  // rows deep.
  function lanesFor(count) {
    if (count > 14) return 3;
    if (count > 6) return 2;
    return 1;
  }

  function setActiveNav(isActive) {
    const btn = document.querySelector('.sidebar nav [data-nav="pipeline"]');
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
      loaded = true;
    } catch (e) {
      mount.innerHTML = '<div style="padding:40px;color:#a3282e;">Failed to load pipeline data.</div>';
      return;
    }
    render();
  }

  function uniqueValues(key) {
    return [...new Set(allClients.map((c) => c[key]).filter(Boolean))].sort();
  }

  // Service location holds a SET now ("In-Clinic, In Home"), so the filter
  // cannot be a list of stored strings compared with ===. Both halves read the
  // field through the shell's parser -- the same one the editor writes with --
  // so a client seen in two settings appears under each of them.
  function serviceValues() {
    const parse = window.__parseServiceLocation;
    if (!parse) return uniqueValues("service_location");
    const settings = new Set(), extras = new Set();
    allClients.forEach((c) => {
      const p = parse(c.service_location);
      p.chosen.forEach((v) => settings.add(v));
      // Anything that is not one of the settings is still offered, so a value
      // typed before this was a multi-select stays filterable.
      if (p.extra) extras.add(p.extra);
    });
    const order = window.__serviceLocations || [];
    return order.filter((v) => settings.has(v)).concat([...extras].sort());
  }
  function serviceMatches(raw, wanted) {
    const has = window.__serviceLocationHas;
    if (!has) return raw === wanted;
    return has(raw, wanted) || String(raw || "") === wanted ||
      (window.__parseServiceLocation(raw).extra === wanted);
  }

  function applyFilters(list) {
    return list.filter((c) => {
      if (filters.milestone && String(c.milestone) !== filters.milestone) return false;
      if (filters.blocker && c.blocker !== filters.blocker) return false;
      if (filters.priority && c.priority !== filters.priority) return false;
      if (filters.insurance && c.insurance_provider !== filters.insurance) return false;
      if (filters.bcba && c.assigned_bcba_name !== filters.bcba) return false;
      if (filters.service && !serviceMatches(c.service_location, filters.service)) return false;
      if (filters.days && c.daysInStage < Number(filters.days)) return false;
      if (filters.waitlist === "only" && !c.waitlisted) return false;
      if (filters.waitlist === "hide" && c.waitlisted) return false;
      return true;
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Checklist item keys that map directly to a real boolean column on the
  // client record, and can therefore be checked off right from the card.
  // Keys prefixed with "__" are computed from other existing fields
  // (BCBA assignment, authorization status, etc.) and are set elsewhere in
  // the app, so they're shown as plain text here, not as checkboxes.
  function isCheckableKey(key) {
    return !!key && key.indexOf("__") !== 0;
  }

  function missingItemRow(label, key, clientId) {
    if (!isCheckableKey(key)) {
      return '<div style="color:#a3282e;">✕ ' + esc(label) + "</div>";
    }
    return (
      '<label style="display:flex;align-items:center;gap:6px;color:#a3282e;cursor:pointer;" data-pv2-checkrow="1">' +
        '<input type="checkbox" data-pv2-check="' + esc(clientId) + '" data-pv2-key="' + esc(key) + '" style="margin:0;cursor:pointer;flex:0 0 auto;" />' +
        "<span>" + esc(label) + "</span>" +
      "</label>"
    );
  }

  function waitlistTitle(c) {
    const since = c.waitlisted_at ? " since " + String(c.waitlisted_at).slice(0, 10) : "";
    const why = c.waitlist_reason ? " — " + c.waitlist_reason : "";
    return "On the waitlist" + since + why + ". Automated reminders to this family are paused.";
  }

  function cardHTML(c) {
    const ms = MILESTONES.find((m) => m.key === c.milestone) || MILESTONES[0];
    const b = BLOCKERS[c.blocker] || BLOCKERS.ready;
    const p = PRIORITY_STYLE[c.priority] || PRIORITY_STYLE.Low;
    const missing = (c.missingItems || []).slice(0, 3);
    const missingKeys = c.missingItemKeys || [];
    return (
      '<div style="background:#fff;border:1px solid #e6e1d4;border-radius:12px;padding:13px 14px;border-left:4px solid ' + ms.color + ';cursor:pointer;" data-pv2-open="' + c.id + '">' +
        '<div style="font-weight:700;font-size:14.5px;margin-bottom:6px;">' + esc(c.child_name) +
          // On the card, not behind a click. A waitlisted family is waiting on
          // purpose; without this the card is indistinguishable from one that
          // has simply stalled, and the whole board reads as neglect.
          (c.waitlisted
            ? ' <span title="' + esc(waitlistTitle(c)) + '" style="font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;background:#fef3c7;color:#92400e;vertical-align:middle;white-space:nowrap;">WAITLIST</span>'
            : "") +
          (c.transportation_services
            ? ' <span role="img" title="Spectrum Squad provides transportation for this client" aria-label="Transportation provided" style="padding:2px 6px;border-radius:20px;background:#e6f4f1;color:#2f6f68;vertical-align:middle;display:inline-flex;align-items:center;"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true" focusable="false" style="vertical-align:-2px;"><path d="M18.92 6.51A1.5 1.5 0 0 0 17.5 5.5h-11a1.5 1.5 0 0 0-1.42 1.01L3.2 12v6.5a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h11.6v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1V12zM6.85 15.2a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7zm10.3 0a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7zM5.1 11l1.4-4.03a.5.5 0 0 1 .47-.34h10.06a.5.5 0 0 1 .47.34L18.9 11z"/></svg></span>'
            : "") +
        "</div>" +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#767488;margin-bottom:2px;"><span>Owner</span><b style="color:#2b2a35;">' + esc(c.owner || "Unassigned") + "</b></div>" +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#767488;margin-bottom:2px;"><span>Days in stage</span><b style="color:#2b2a35;">' + (c.daysInStage ?? "—") + "</b></div>" +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#767488;margin-bottom:6px;"><span>Priority</span><span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;background:' + p.bg + ";color:" + p.text + ';">' + esc(c.priority || "—") + "</span></div>" +
        '<div style="background:#eee;border-radius:6px;height:6px;overflow:hidden;margin:6px 0 8px;"><div style="height:100%;border-radius:6px;width:' + (c.progressPct || 0) + "%;background:" + ms.color + ';"></div></div>' +
        '<div style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;margin:0 0 8px;background:' + b.bg + ";color:" + b.text + ';"><span style="width:8px;height:8px;border-radius:50%;background:' + b.color + ';display:inline-block;"></span>' + esc(b.label) + "</div>" +
        (missing.length ? '<div style="font-size:12px;margin-top:4px;line-height:1.7;">' + missing.map((m, i) => missingItemRow(m, missingKeys[i], c.id)).join("") + "</div>" : "") +
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
        '<select id="pv2-f-service"><option value="">All service types</option>' + opt(serviceValues()) + "</select>" +
        '<select id="pv2-f-days"><option value="">Any days waiting</option><option value="7">7+ days</option><option value="14">14+ days</option><option value="21">21+ days</option></select>' +
        '<select id="pv2-f-waitlist"><option value="">Waitlist: show all</option><option value="only">On the waitlist only</option><option value="hide">Hide waitlisted</option></select>' +
        '<button type="button" id="pv2-f-clear" style="margin-left:auto;background:none;border:none;color:#1b2a6b;text-decoration:underline;font-size:12.5px;cursor:pointer;">Clear filters</button>' +
      "</div>"
    );
  }

  function wireFilters(mount) {
    const map = { milestone: "pv2-f-milestone", blocker: "pv2-f-blocker", priority: "pv2-f-priority", insurance: "pv2-f-insurance", bcba: "pv2-f-bcba", service: "pv2-f-service", days: "pv2-f-days", waitlist: "pv2-f-waitlist" };
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

  // Wires the per-item checkboxes on each card. Clicking a checkbox marks
  // that checklist item complete via PATCH /api/clients/:id/checklist, then
  // reloads real data from the server so the card, its progress bar, and
  // (if this was the last missing item) its blocker/next-action all reflect
  // the update -- same "always refetch real data" approach used elsewhere
  // in this file, so there's no local state that can drift from the DB.
  function wireChecklist(mount) {
    mount.querySelectorAll("[data-pv2-checkrow]").forEach((row) => {
      row.addEventListener("click", (e) => e.stopPropagation());
    });
    mount.querySelectorAll("[data-pv2-check]").forEach((cb) => {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", async () => {
        const clientId = cb.getAttribute("data-pv2-check");
        const key = cb.getAttribute("data-pv2-key");
        if (!clientId || !key) return;
        cb.disabled = true;
        const payload = {};
        payload[key] = key === "intake_assessment_scheduled_date" ? new Date().toISOString().slice(0, 10) : true;
        try {
          const res = await fetch("/api/clients/" + encodeURIComponent(clientId) + "/checklist", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error("Update failed");
          await loadAndRender();
        } catch (e) {
          cb.disabled = false;
          cb.checked = false;
          alert("Could not save that update. Please try again.");
        }
      });
    });
  }

  function render() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    ensureStyle();
    const filtered = applyFilters(allClients);
    const columns = MILESTONES.map((m) => {
      const items = filtered.filter((c) => c.milestone === m.key);
      var lanes = lanesFor(items.length);
      return (
        '<div class="pv2-col' + (lanes > 1 ? " pv2-l" + lanes : "") + '" data-pv2-lanes="' + lanes + '">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;padding:2px 4px 12px;">' +
            '<div style="display:flex;align-items:center;gap:8px;"><span style="width:10px;height:10px;border-radius:50%;background:' + m.color + ';display:inline-block;"></span><h3 style="font-size:14px;margin:0;font-weight:700;">' + esc(m.label) + "</h3></div>" +
            '<span style="font-size:12px;color:#767488;background:#fff;border:1px solid #e6e1d4;border-radius:20px;padding:1px 9px;">' + items.length + "</span>" +
          "</div>" +
          (items.length
            ? '<div class="pv2-cards">' + items.map(cardHTML).join("") + "</div>"
            : '<div style="font-size:12.5px;color:#767488;text-align:center;padding:20px 4px;">No clients here right now.</div>') +
        "</div>"
      );
    }).join("");

    mount.innerHTML =
      '<div style="padding:24px 28px 60px;">' +
        '<h1 style="font-size:24px;margin:0 0 4px;font-weight:700;color:#1b2a6b;">Client pipeline</h1>' +
        '<p style="margin:0 0 18px;color:#767488;font-size:14px;">Milestone view with progress, blockers, and next actions. Check off an item to mark it done, or click a card to open the full client record.</p>' +
        filterBarHTML() +
        '<div class="pv2-board">' + columns + "</div>" +
      "</div>";
    mount.dataset.pv2 = "1";

    wireFilters(mount);
    wireChecklist(mount);
    mount.querySelectorAll("[data-pv2-open]").forEach((card) => {
      card.addEventListener("click", () => {
        location.hash = "#/pipeline/" + card.getAttribute("data-pv2-open");
      });
    });
  }

  // The app's own router also reacts to hashchange events, including for a
  // route it doesn't recognize like ours, and may asynchronously overwrite
  // #view-mount (and reset nav "active" classes) shortly AFTER we've already
  // rendered -- a race we can lose depending on network timing, sometimes
  // more than 1.5s after navigating in. Rather than relying only on a fixed
  // set of timed re-checks (which can lose the race if the app's router is
  // slow), also watch #view-mount itself for the app clobbering it, and
  // re-render immediately whenever that happens. This can't loop: our own
  // render() sets mount.dataset.pv2 = "1" synchronously right after setting
  // innerHTML, and the observer callback (which always runs after that,
  // since MutationObserver callbacks are microtasks queued after the
  // current synchronous code finishes) only re-renders when dataset.pv2 is
  // NOT "1" -- so it never reacts to its own render.
  function watchMount() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    if (mountObserver) mountObserver.disconnect();
    mountObserver = new MutationObserver(() => {
      if (location.hash !== HASH) return;
      if (!loaded) return;
      const m = document.getElementById("view-mount");
      if (m && m.dataset.pv2 !== "1") render();
    });
    mountObserver.observe(mount, { childList: true });
  }

  function reassertIfNeeded() {
    if (location.hash !== HASH) return;
    setActiveNav(true);
    if (!loaded) return;
    const mount = document.getElementById("view-mount");
    if (mount && mount.dataset.pv2 !== "1") render();
  }

  function onHashChange() {
    const isActive = location.hash === HASH;
    setActiveNav(isActive);
    if (!isActive) {
      if (mountObserver) { mountObserver.disconnect(); mountObserver = null; }
      return;
    }
    watchMount();
    loadAndRender();
    [100, 300, 800, 1500].forEach((ms) => setTimeout(reassertIfNeeded, ms));
  }

  function boot() {
    window.addEventListener("hashchange", onHashChange);
    if (location.hash === HASH) onHashChange();
  }

  boot();
})();
