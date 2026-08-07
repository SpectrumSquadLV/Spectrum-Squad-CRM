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
  const CLIENT_COLOR = "#e11d48";     // clients = rose
  const CLINICIAN_COLOR = "#2563eb";  // clinicians = blue

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

  let map, layers = { clients: null, clinicians: null }, linkLines = null, data = null, selectedClientId = null;
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
            '<label style="font-size:12.5px;display:flex;align-items:center;gap:5px;"><input type="checkbox" id="map-show-clients" checked /> <span style="color:' + CLIENT_COLOR + ';font-weight:700;">● Clients</span></label>' +
            '<label style="font-size:12.5px;display:flex;align-items:center;gap:5px;"><input type="checkbox" id="map-show-clin" checked /> <span style="color:' + CLINICIAN_COLOR + ';font-weight:700;">● Clinicians</span></label>' +
            '<button class="btn small secondary" id="map-geocode">Geocode addresses</button>' +
          "</div>" +
        "</div>" +
        '<p id="map-status" style="margin:6px 0 0;color:#767488;font-size:13px;">Loading map…</p>' +
      "</div>" +
      '<div style="display:flex;gap:0;flex-wrap:wrap;padding:0 24px 40px;">' +
        '<div id="map-canvas" style="flex:1;min-width:300px;height:520px;border:1px solid #e6e1d4;border-radius:12px 0 0 12px;overflow:hidden;background:#eef2f7;"></div>' +
        '<div id="map-side" style="width:320px;min-width:260px;max-width:100%;height:520px;overflow:auto;border:1px solid #e6e1d4;border-left:none;border-radius:0 12px 12px 0;padding:14px;background:#fff;">' +
          '<div style="color:#8a8797;font-size:13px;">Tap a client pin to see the nearest clinicians for an in-home match.</div>' +
        "</div>" +
      "</div>";

    try { await loadLeaflet(); } catch (e) { document.getElementById("map-status").innerHTML = '<span style="color:#a3282e;">' + esc(e.message) + "</span>"; return; }
    try { data = await api("/api/geo/map"); } catch (e) { document.getElementById("map-status").innerHTML = '<span style="color:#a3282e;">' + esc(e.message) + "</span>"; return; }

    const statusEl = document.getElementById("map-status");
    statusEl.innerHTML =
      "Showing <b>" + data.clients.length + "</b> of " + data.totalClients + " clients and <b>" + data.clinicians.length + "</b> of " + data.totalClinicians + " clinicians." +
      (data.pending > 0 ? ' <span style="color:#b45309;">' + data.pending + " address(es) not mapped yet — click <b>Geocode addresses</b>.</span>" : "");

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
    data.clients.forEach((cl) => {
      const m = L.circleMarker([cl.lat, cl.lng], { radius: 8, color: "#fff", weight: 2, fillColor: CLIENT_COLOR, fillOpacity: 1 })
        .bindPopup("<b>" + esc(cl.name) + "</b><br>Client");
      m.on("click", () => selectClient(cl.id));
      m.addTo(layers.clients); markerIndex.clients[cl.id] = m; bounds.push([cl.lat, cl.lng]);
    });
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

    side.innerHTML =
      '<div style="font-weight:800;font-size:16px;margin-bottom:2px;">' + esc(cl.name) + "</div>" +
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
    if (clr) clr.addEventListener("click", () => { selectedClientId = null; linkLines.clearLayers(); side.innerHTML = '<div style="color:#8a8797;font-size:13px;">Tap a client pin to see the nearest clinicians for an in-home match.</div>'; });
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
