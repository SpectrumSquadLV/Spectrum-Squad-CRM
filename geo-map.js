// geo-map.js -- Spectrum Squad CRM: Clients & Clinicians map (backend).
//
// Plots existing client home addresses and employee (clinician) home addresses
// on a map so scheduling can pair the nearest clinician to each client for
// in-home services. Straight-line ("as the crow flies") miles — no paid API.
//
// Geocoding uses OpenStreetMap Nominatim (free) and is cached in geo_cache so
// each address is only looked up once. The map returns whatever is already
// cached instantly; a background sweep (and an on-demand button) fills in the
// rest, respecting Nominatim's ~1 request/second policy.
//
// Privacy: this is internal-only, gated to owner / super_admin / admin /
// scheduling. Addresses are never written to logs or placed in URLs.
"use strict";

module.exports = function initGeo(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, crypto } = ctx;

  const VIEW_ROLES = ["owner", "super_admin", "admin", "scheduling"];

  // A per-user grant from the Access editor unlocks this module's ordinary
  // access tier even when the role list wouldn't. Manage/sensitive tiers stay
  // role-gated.
  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  function canView(user) { return !!user && (VIEW_ROLES.includes(user.role) || granted(user, "map")); }

  // Default map center: Las Vegas.
  const CENTER = { lat: 36.1699, lng: -115.1398 };
  const GEOCODE_BATCH = 8;          // addresses geocoded per sweep call
  const GEOCODE_SPACING_MS = 1100;  // Nominatim: max ~1 req/sec

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS geo_cache (
      id SERIAL PRIMARY KEY,
      norm_address TEXT UNIQUE NOT NULL,
      raw_address TEXT,
      lat NUMERIC,
      lng NUMERIC,
      status TEXT NOT NULL DEFAULT 'ok',   -- ok|failed
      geocoded_at TEXT
    )`);
  }

  function norm(addr) {
    return String(addr || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  // ---- geocoding ----
  async function geocodeOne(rawAddress) {
    const attempts = [rawAddress];
    // If the address doesn't clearly include a state/zip, bias to Las Vegas, NV.
    if (!/\b(NV|nevada|\d{5})\b/i.test(rawAddress)) attempts.push(rawAddress + ", Las Vegas, NV");
    for (const q of attempts) {
      try {
        const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=" + encodeURIComponent(q);
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "SpectrumSquadCRM/1.0 (clinic scheduling map; contact admin@spectrumsquadlv.com)",
            "Accept": "application/json",
          },
        });
        if (!resp.ok) continue;
        const arr = await resp.json();
        if (Array.isArray(arr) && arr.length && arr[0].lat && arr[0].lon) {
          return { lat: Number(arr[0].lat), lng: Number(arr[0].lon) };
        }
      } catch (e) { /* try next form */ }
    }
    return null;
  }

  // Collect every distinct address used by active clients + active employees.
  async function collectAddresses() {
    const clients = await dbAll("SELECT address FROM clients WHERE address IS NOT NULL AND address <> ''");
    const emps = await dbAll("SELECT address FROM hr_employees WHERE address IS NOT NULL AND address <> '' AND (status IS NULL OR status <> 'terminated')");
    const set = new Map();
    for (const r of clients.concat(emps)) {
      const n = norm(r.address);
      if (n) set.set(n, r.address);
    }
    return set; // Map<normalized, raw>
  }

  // Geocode up to GEOCODE_BATCH addresses that aren't cached yet.
  async function geocodeSweep(limit) {
    const max = limit || GEOCODE_BATCH;
    const wanted = await collectAddresses();
    let done = 0, failed = 0;
    for (const [n, raw] of wanted) {
      if (done >= max) break;
      const cached = await dbGet("SELECT id FROM geo_cache WHERE norm_address = ?", [n]);
      if (cached) continue;
      const coords = await geocodeOne(raw);
      if (coords) {
        await dbRun(
          "INSERT INTO geo_cache (norm_address, raw_address, lat, lng, status, geocoded_at) VALUES (?, ?, ?, ?, 'ok', ?) ON CONFLICT (norm_address) DO NOTHING",
          [n, raw, coords.lat, coords.lng, nowISO()]
        );
        done++;
      } else {
        await dbRun(
          "INSERT INTO geo_cache (norm_address, raw_address, status, geocoded_at) VALUES (?, ?, 'failed', ?) ON CONFLICT (norm_address) DO NOTHING",
          [n, raw, nowISO()]
        );
        failed++;
      }
      // Respect Nominatim rate limit between network calls.
      await new Promise((r) => setTimeout(r, GEOCODE_SPACING_MS));
    }
    return { geocoded: done, failed };
  }

  async function coordFor(rawAddress) {
    const n = norm(rawAddress);
    if (!n) return null;
    const c = await dbGet("SELECT lat, lng, status FROM geo_cache WHERE norm_address = ?", [n]);
    if (c && c.status === "ok" && c.lat != null) return { lat: Number(c.lat), lng: Number(c.lng) };
    return null;
  }

  // Classify why an address can't be placed yet, so the UI can list the exact
  // employees (not just a count). Returns one of:
  //   'no_address'      -- nothing on file to geocode
  //   'geocode_failed'  -- Nominatim couldn't locate the address
  //   'not_geocoded'    -- valid address, just not looked up yet (run Geocode)
  async function placeReason(rawAddress) {
    const n = norm(rawAddress);
    if (!n) return "no_address";
    const c = await dbGet("SELECT status FROM geo_cache WHERE norm_address = ?", [n]);
    if (!c) return "not_geocoded";
    return c.status === "failed" ? "geocode_failed" : "not_geocoded";
  }
  const REASON_LABEL = {
    no_address: "No home address on file",
    geocode_failed: "Address couldn't be located — check spelling",
    not_geocoded: "Not geocoded yet — click Geocode addresses",
  };

  function haversineMiles(a, b) {
    const R = 3958.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.asin(Math.sqrt(s)) * 10) / 10;
  }

  // ---- service setting -----------------------------------------------
  // clients.service_location is a single free-text/select field whose values
  // are "In-Clinic", "In Home" and "In-School". Rather than assume one of
  // them, this reads what is actually stored: a record naming more than one
  // setting is reported as `multiple` with the settings it names, and a blank
  // or unrecognised value is `unknown`. Nothing is guessed into a category it
  // was never put in, which is what "handle it cleanly rather than forcing
  // incorrect data" has to mean here.
  const SETTINGS = [
    { key: "in_home", label: "In-Home", test: /\bin[\s-]?home\b|\bhome\b/i },
    { key: "in_school", label: "In-School", test: /\bin[\s-]?school\b|\bschool\b/i },
    { key: "clinic", label: "Clinic", test: /\bin[\s-]?clinic\b|\bclinic\b|\bcenter\b|\bcentre\b/i },
  ];
  function classifyServiceSetting(raw) {
    const text = String(raw || "").trim();
    if (!text) return { key: "unknown", label: "Not specified", settings: [], raw: "" };
    const hit = SETTINGS.filter((s) => s.test.test(text));
    if (!hit.length) return { key: "unknown", label: "Not specified", settings: [], raw: text };
    if (hit.length > 1) {
      return { key: "multiple", label: "Multiple settings", settings: hit.map((h) => h.key), raw: text };
    }
    return { key: hit[0].key, label: hit[0].label, settings: [hit[0].key], raw: text };
  }

  async function buildMap() {
    const clientRows = await dbAll("SELECT id, child_name, address, service_location FROM clients WHERE address IS NOT NULL AND address <> '' ORDER BY child_name");
    // Pull EVERY active employee (not just ones with an address) so the map can
    // account for all of them -- those it can't place are surfaced explicitly in
    // `unmappedClinicians` rather than silently dropped. This fixes "the map
    // isn't showing all employees": previously anyone without geocoded coords
    // (no address, not-yet-geocoded, or a failed lookup) just vanished.
    const empRows = await dbAll("SELECT id, name, role_title, address FROM hr_employees WHERE (status IS NULL OR status <> 'terminated') ORDER BY name");

    const clients = [], clinicians = [], unmappedClinicians = [];
    let pending = 0;
    for (const c of clientRows) {
      const co = await coordFor(c.address);
      if (co) {
        const setting = classifyServiceSetting(c.service_location);
        clients.push({
          id: c.id, name: c.child_name, lat: co.lat, lng: co.lng,
          service_location: c.service_location || null,
          setting_key: setting.key,
          setting_label: setting.label,
          settings: setting.settings,
        });
      } else pending++;
    }
    for (const e of empRows) {
      const co = await coordFor(e.address);
      if (co) {
        clinicians.push({ id: e.id, name: e.name, role_title: e.role_title || "", lat: co.lat, lng: co.lng });
      } else {
        const reason = await placeReason(e.address);
        if (reason === "not_geocoded") pending++;
        unmappedClinicians.push({ id: e.id, name: e.name, role_title: e.role_title || "", reason, reason_label: REASON_LABEL[reason] });
      }
    }

    // Pairings: nearest clinicians to each client (straight-line miles).
    const pairings = {};
    for (const cl of clients) {
      const ranked = clinicians
        .map((cn) => ({ clinician_id: cn.id, name: cn.name, role_title: cn.role_title, miles: haversineMiles(cl, cn) }))
        .sort((a, b) => a.miles - b.miles)
        .slice(0, 5);
      pairings[cl.id] = ranked;
    }

    // Counts per setting, so the legend can say how many of each are on the
    // map without the browser recomputing it.
    const settingCounts = {};
    for (const c of clients) settingCounts[c.setting_key] = (settingCounts[c.setting_key] || 0) + 1;

    return {
      center: CENTER, clients, clinicians, unmappedClinicians, pairings, pending,
      totalClients: clientRows.length, totalClinicians: empRows.length,
      settingCounts,
      settings: SETTINGS.map((s) => ({ key: s.key, label: s.label }))
        .concat([{ key: "multiple", label: "Multiple settings" }, { key: "unknown", label: "Not specified" }]),
    };
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/geo/")) return false;
    const json = ctx.json;
    if (!canView(user)) { json(res, 403, { error: "Not permitted to view the map." }); return true; }

    if (pathname === "/api/geo/map" && method === "GET") {
      json(res, 200, await buildMap()); return true;
    }
    // On-demand geocode of any not-yet-cached addresses (button in the UI).
    if (pathname === "/api/geo/geocode" && method === "POST") {
      const r = await geocodeSweep(GEOCODE_BATCH);
      json(res, 200, r); return true;
    }
    // Status: how many addresses still need geocoding.
    if (pathname === "/api/geo/status" && method === "GET") {
      const wanted = await collectAddresses();
      let cached = 0;
      for (const [n] of wanted) { const c = await dbGet("SELECT id FROM geo_cache WHERE norm_address = ?", [n]); if (c) cached++; }
      json(res, 200, { total: wanted.size, cached, pending: wanted.size - cached }); return true;
    }
    return false;
  }

  return { initTables, handleApi, geocodeSweep, buildMap, haversineMiles, canView, classifyServiceSetting };
};
