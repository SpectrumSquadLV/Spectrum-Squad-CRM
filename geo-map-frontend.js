// geo-map-frontend.js -- Clients & Clinicians map (progressive-enhancement).
// Injects a "Map" sidebar button and renders a Leaflet + OpenStreetMap view
// into #view-mount. Owner / Super Admin / Admin / Scheduling only. Lazy-loads
// Leaflet from cdnjs on first use. Click a client pin to see the nearest
// clinicians (straight-line miles) for in-home pairing.
(function () {
  "use strict";
  const HASH = "#/map";
  const ROLES = ["owner", "super_admin", "admin", "scheduling"];
  const ACCENT = "#4f46e5";
  const CLIENT_COLOR = "#e11d48";     // clients = rose (fallback / legacy)
  const CLINICIAN_COLOR = "#2563eb";  // clinicians = blue

  // Where the child is seen. Each setting gets its own colour AND its own
  // shape, so the map is still readable in greyscale, on a projector, or by
  // someone who can't separate the two reds. The palette is drawn from the
  // CRM's existing accents rather than a new one.
  //
  // "multiple" is a real answer, not a fudge: a record naming more than one
  // setting is shown as such instead of being forced into whichever the code
  // happened to test for first. "unknown" is likewise shown as unknown rather
  // than defaulted to a setting nobody chose.
  const SETTING_STYLE = {
    in_home:   { label: "In-Home",           color: "#3f8f89", shape: "home" },
    in_school: { label: "In-School",         color: "#e0a430", shape: "school" },
    clinic:    { label: "Clinic",            color: "#3f56b5", shape: "clinic" },
    multiple:  { label: "Multiple settings", color: "#8b5cf6", shape: "multiple" },
    unknown:   { label: "Not specified",     color: "#94a3b8", shape: "unknown" },
  };
  const SETTING_ORDER = ["in_home", "in_school", "clinic", "multiple", "unknown"];
  function settingStyle(key) { return SETTING_STYLE[key] || SETTING_STYLE.unknown; }

  // A small inline-SVG pin. Same silhouette for every setting so they read as
  // one family, with the glyph inside carrying the meaning.
  function settingGlyph(shape) {
    switch (shape) {
      case "home":     return '<path d="M11 15.4 5.6 19.9v-6.9h10.8v6.9z" fill="#fff"/><path d="M11 4.6 3.9 11h14.2z" fill="#fff"/>';
      case "school":   return '<path d="M11 4.4 3.4 8.3 11 12.2l7.6-3.9z" fill="#fff"/><path d="M6.2 10.6v4.6c0 1.7 2.2 3 4.8 3s4.8-1.3 4.8-3v-4.6L11 13.4z" fill="#fff"/>';
      case "clinic":   return '<rect x="9.4" y="4.6" width="3.2" height="13" rx="0.7" fill="#fff"/><rect x="4.6" y="9.4" width="12.8" height="3.2" rx="0.7" fill="#fff"/>';
      case "multiple": return '<circle cx="7.6" cy="9" r="2.7" fill="#fff"/><circle cx="14.4" cy="9" r="2.7" fill="#fff"/><circle cx="11" cy="15" r="2.7" fill="#fff"/>';
      default:         return '<circle cx="11" cy="11" r="3.6" fill="none" stroke="#fff" stroke-width="2.2"/>';
    }
  }
  function settingIcon(L, key) {
    const st = settingStyle(key);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 22 30">' +
        '<path d="M11 29.2C11 29.2 21 18.6 21 11A10 10 0 1 0 1 11c0 7.6 10 18.2 10 18.2z" fill="' + st.color + '" stroke="#fff" stroke-width="2"/>' +
        settingGlyph(st.shape) +
      "</svg>";
    return L.divIcon({
      className: "map-setting-pin",
      html: svg,
      iconSize: [26, 34],
      iconAnchor: [13, 33],
      popupAnchor: [0, -30],
    });
  }
  // The same pin at legend/inline size, as a data-free inline SVG string.
  function settingSwatch(key) {
    const st = settingStyle(key);
    return '<svg width="14" height="18" viewBox="0 0 22 30" aria-hidden="true" style="vertical-align:-3px;">' +
      '<path d="M11 29.2C11 29.2 21 18.6 21 11A10 10 0 1 0 1 11c0 7.6 10 18.2 10 18.2z" fill="' + st.color + '" stroke="#fff" stroke-width="2"/>' +
      settingGlyph(st.shape) + "</svg>";
  }

  function canSee() { return typeof state !== "undefined" && state.user && ROLES.includes(state.user.role); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, { method: opts.method || "GET", headers: opts.body ? { "Content-Type": "application/json" } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "Request failed");
    return d;
  }

  let leafletLoading = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
      js.onload = resolve;
      js.onerror = () => reject(new Error("Could not load the map library (check your connection)."));
      document.head.appendChild(js);
    });
    return leafletLoading;
  }

  function injectNav() {
    if (!canSee()) return;
    const nav = document.querySelector(".sidebar nav");
    if (!nav || document.getElementById("map-nav-btn")) return;
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.id = "map-nav-btn";
    btn.innerHTML = "<span>🗺️</span> Map";
    btn.addEventListener("click", () => { location.hash = HASH; });
    nav.appendChild(btn);
  }

  let map, layers = { clients: null, clinicians: null, settings: {} }, linkLines = null, data = null, selectedClientId = null;
  const markerIndex = { clients: {}, clinicians: {} };

  async function render() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    mount.dataset.map = "1";
    mount.innerHTML =
      '<div style="padding:20px 24px 10px;">' +
        '<div style="display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;">' +
          '<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:22px;">🗺️</span><h1 style="font-size:24px;margin:0;font-weight:800;color:' + ACCENT + ';">Clients & Clinicians Map</h1></div>' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<label style="font-size:12.5px;display:flex;align-items:center;gap:5px;"><input type="checkbox" id="map-show-clients" checked /> <span style="font-weight:700;">Clients</span></label>' +
            '<label style="font-size:12.5px;display:flex;align-items:center;gap:5px;"><input type="checkbox" id="map-show-clin" checked /> <span style="color:' + CLINICIAN_COLOR + ';font-weight:700;">● Clinicians</span></label>' +
            '<button class="btn small secondary" id="map-geocode">Geocode addresses</button>' +
          "</div>" +
        "</div>" +
        '<p id="map-status" style="margin:6px 0 0;color:#767488;font-size:13px;">Loading map…</p>' +
        // Service-setting legend. Doubles as the filter: each entry is a
        // checkbox, so a scheduler can look at just the in-home caseload.
        // Laid out as a wrapping row rather than a stacked list.
        '<div id="map-legend" style="display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-top:8px;"></div>' +
      "</div>" +
      '<div style="display:flex;gap:0;flex-wrap:wrap;padding:0 24px 40px;">' +
        '<div id="map-canvas" style="flex:1;min-width:300px;height:520px;border:1px solid #e6e1d4;border-radius:12px 0 0 12px;overflow:hidden;background:#eef2f7;"></div>' +
        '<div id="map-side" style="width:320px;min-width:260px;max-width:100%;height:520px;overflow:auto;border:1px solid #e6e1d4;border-left:none;border-radius:0 12px 12px 0;padding:14px;background:#fff;">' +
          '<div style="color:#8a8797;font-size:13px;">Tap a client pin to see the nearest clinicians for an in-home match.</div>' +
        "</div>" +
      "</div>";

    try { await loadLeaflet(); } catch (e) { document.getElementById("map-status").innerHTML = '<span style="color:#a3282e;">' + esc(e.message) + "</span>"; return; }
    try { data = await api("/api/geo/map"); } catch (e) { document.getElementById("map-status").innerHTML = '<span style="color:#a3282e;">' + esc(e.message) + "</span>"; return; }

    const unmapped = data.unmappedClinicians || [];
    const statusEl = document.getElementById("map-status");
    statusEl.innerHTML =
      "Showing <b>" + data.clients.length + "</b> of " + data.totalClients + " clients and <b>" + data.clinicians.length + "</b> of " + data.totalClinicians + " clinicians." +
      (unmapped.length ? ' <span style="color:#b45309;">' + unmapped.length + " employee(s) not on the map — see the list on the right.</span>" : "") +
      (data.pending > 0 ? ' <span style="color:#b45309;">Click <b>Geocode addresses</b> to place pending ones.</span>' : "");

    // Default side-panel content: list every employee the map couldn't place,
    // with the exact reason, so no active employee is silently missing.
    renderUnmappedPanel(unmapped);

    // init map
    const L = window.L;
    if (map) { map.remove(); map = null; }
    map = L.map("map-canvas", { scrollWheelZoom: true }).setView([data.center.lat, data.center.lng], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap",
    }).addTo(map);

    layers.clients = L.layerGroup().addTo(map);
    layers.clinicians = L.layerGroup().addTo(map);
    linkLines = L.layerGroup().addTo(map);
    markerIndex.clients = {}; markerIndex.clinicians = {};

    const bounds = [];
    data.clinicians.forEach((cn) => {
      const m = L.circleMarker([cn.lat, cn.lng], { radius: 7, color: "#fff", weight: 2, fillColor: CLINICIAN_COLOR, fillOpacity: 1 })
        .bindPopup("<b>" + esc(cn.name) + "</b><br>" + esc(cn.role_title || "Clinician"));
      m.addTo(layers.clinicians); markerIndex.clinicians[cn.id] = m; bounds.push([cn.lat, cn.lng]);
    });
    // One layer per service setting, so the legend can switch each on and off
    // and the marker itself says where the child is seen.
    layers.settings = {};
    SETTING_ORDER.forEach((k) => { layers.settings[k] = L.layerGroup().addTo(layers.clients); });
    data.clients.forEach((cl) => {
      const key = SETTING_STYLE[cl.setting_key] ? cl.setting_key : "unknown";
      const st = settingStyle(key);
      const detail = cl.setting_key === "multiple" && cl.service_location
        ? esc(cl.service_location)
        : cl.setting_key === "unknown"
          ? (cl.service_location ? esc(cl.service_location) + " (not a recognised setting)" : "No service setting recorded")
          : st.label;
      const m = L.marker([cl.lat, cl.lng], { icon: settingIcon(L, key) })
        .bindPopup("<b>" + esc(cl.name) + "</b><br>" + settingSwatch(key) + " " + detail);
      m.on("click", () => selectClient(cl.id));
      m.addTo(layers.settings[key]); markerIndex.clients[cl.id] = m; bounds.push([cl.lat, cl.lng]);
    });
    renderLegend();
    if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
    setTimeout(() => map.invalidateSize(), 200);

    document.getElementById("map-show-clients").addEventListener("change", (e) => { e.target.checked ? layers.clients.addTo(map) : map.removeLayer(layers.clients); });
    document.getElementById("map-show-clin").addEventListener("change", (e) => { e.target.checked ? layers.clinicians.addTo(map) : map.removeLayer(layers.clinicians); });
    document.getElementById("map-geocode").addEventListener("click", async (e) => {
      const b = e.target; b.disabled = true; b.textContent = "Geocoding…";
      try { const r = await api("/api/geo/geocode", { method: "POST", body: {} }); b.textContent = "Added " + r.geocoded + (r.failed ? " (" + r.failed + " couldn't be found)" : ""); setTimeout(render, 800); }
      catch (err) { b.disabled = false; b.textContent = "Geocode addresses"; alert(err.message); }
    });

    if (selectedClientId) selectClient(selectedClientId);
  }

  // The legend, which is also the per-setting filter. A setting nobody uses is
  // left out entirely rather than shown as a permanent zero.
  function renderLegend() {
    const el = document.getElementById("map-legend");
    if (!el || !data) return;
    const counts = data.settingCounts || {};
    const present = SETTING_ORDER.filter((k) => counts[k]);
    if (!present.length) { el.innerHTML = ""; return; }
    el.innerHTML =
      '<span style="font-size:12px;color:#767488;">Service setting:</span>' +
      present.map((k) =>
        '<label style="font-size:12.5px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;cursor:pointer;">' +
          '<input type="checkbox" class="map-setting-toggle" data-setting="' + k + '" checked style="margin:0;" />' +
          settingSwatch(k) +
          '<span style="font-weight:600;">' + esc(settingStyle(k).label) + "</span>" +
          '<span style="color:#8a8797;">' + counts[k] + "</span>" +
        "</label>").join("");
    el.querySelectorAll(".map-setting-toggle").forEach((cb) => {
      cb.addEventListener("change", () => {
        const k = cb.getAttribute("data-setting");
        const layer = layers.settings[k];
        if (!layer) return;
        if (cb.checked) layer.addTo(layers.clients);
        else layers.clients.removeLayer(layer);
      });
    });
  }

  // Renders the "Unmapped employees" list into the side panel. Shown by default
  // (no client selected) so the user can see exactly who is missing and why.
  function renderUnmappedPanel(unmapped) {
    const side = document.getElementById("map-side");
    if (!side) return;
    unmapped = unmapped || (data && data.unmappedClinicians) || [];
    let html = '<div style="color:#8a8797;font-size:13px;margin-bottom:12px;">Tap a client pin to see the nearest clinicians for an in-home match.</div>';
    if (unmapped.length) {
      html +=
        '<div style="font-weight:800;font-size:14px;margin-bottom:2px;">Unmapped employees (' + unmapped.length + ")</div>" +
        '<div style="font-size:11.5px;color:#8a8797;margin-bottom:10px;">These active employees aren\'t on the map yet.</div>' +
        unmapped.map((u) =>
          '<div style="padding:8px 10px;border:1px solid #f1e4c9;background:#fffaf0;border-radius:9px;margin-bottom:7px;">' +
            '<div style="font-weight:700;font-size:13.5px;">' + esc(u.name) + "</div>" +
            '<div style="font-size:11.5px;color:#8a8797;">' + esc(u.role_title || "Clinician") + "</div>" +
            '<div style="font-size:11.5px;color:#b45309;margin-top:2px;">' + esc(u.reason_label || u.reason || "") + "</div>" +
          "</div>").join("");
    }
    side.innerHTML = html;
  }

  function selectClient(clientId) {
    selectedClientId = clientId;
    const L = window.L;
    const cl = data.clients.find((c) => String(c.id) === String(clientId));
    const pairs = (data.pairings[clientId] || []);
    const side = document.getElementById("map-side");
    if (!cl) return;

    // draw lines to nearest 3
    linkLines.clearLayers();
    pairs.slice(0, 3).forEach((p) => {
      const cn = data.clinicians.find((x) => String(x.id) === String(p.clinician_id));
      if (cn) L.polyline([[cl.lat, cl.lng], [cn.lat, cn.lng]], { color: ACCENT, weight: 2, dashArray: "5,6", opacity: 0.7 }).addTo(linkLines);
    });
    map.setView([cl.lat, cl.lng], Math.max(map.getZoom(), 12), { animate: true });
    const m = markerIndex.clients[clientId]; if (m) m.openPopup();

    const clKey = SETTING_STYLE[cl.setting_key] ? cl.setting_key : "unknown";
    side.innerHTML =
      '<div style="font-weight:800;font-size:16px;margin-bottom:2px;">' + esc(cl.name) + "</div>" +
      '<div style="font-size:12px;margin-bottom:6px;">' + settingSwatch(clKey) + " " +
        esc(cl.setting_key === "multiple" && cl.service_location ? cl.service_location : settingStyle(clKey).label) + "</div>" +
      '<div style="font-size:12px;color:#8a8797;margin-bottom:12px;">Nearest clinicians for in-home (straight-line miles)</div>' +
      (pairs.length ? pairs.map((p, i) =>
        '<div class="map-pair" data-cn="' + p.clinician_id + '" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 10px;border:1px solid ' + (i === 0 ? "#c7d2fe" : "#eee") + ';background:' + (i === 0 ? "#eef2ff" : "#fff") + ';border-radius:9px;margin-bottom:7px;cursor:pointer;">' +
          '<div><div style="font-weight:700;font-size:13.5px;">' + esc(p.name) + (i === 0 ? ' <span style="font-size:10px;color:' + ACCENT + ';">closest</span>' : "") + "</div>" +
          '<div style="font-size:11.5px;color:#8a8797;">' + esc(p.role_title || "Clinician") + "</div></div>" +
          '<div style="font-weight:800;color:' + ACCENT + ';white-space:nowrap;">' + p.miles + " mi</div>" +
        "</div>").join("")
        : '<div style="color:#8a8797;font-size:13px;">No clinicians are mapped yet. Add home addresses to staff profiles, then Geocode.</div>') +
      '<button class="btn small secondary" id="map-clear" style="margin-top:8px;">Clear selection</button>';

    side.querySelectorAll(".map-pair").forEach((el) => el.addEventListener("click", () => {
      const cn = data.clinicians.find((x) => String(x.id) === String(el.getAttribute("data-cn")));
      if (cn) { map.setView([cn.lat, cn.lng], 14, { animate: true }); const mm = markerIndex.clinicians[cn.id]; if (mm) mm.openPopup(); }
    }));
    const clr = document.getElementById("map-clear");
    if (clr) clr.addEventListener("click", () => { selectedClientId = null; linkLines.clearLayers(); renderUnmappedPanel(); });
  }

  // The native router in index.html owns the #/map route + sidebar button now;
  // it calls window.__renderMap(mount) directly, so this module no longer
  // injects its own nav button or listens for hashchange (which previously
  // raced the router and bounced the user back to the Dashboard).
  window.__renderMap = function (mount) {
    if (!canSee()) { location.hash = "#/dashboard"; return; }
    return render();
  };
})();
