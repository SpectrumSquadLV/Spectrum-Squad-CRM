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
  function canView(user) { return !!user && VIEW_ROLES.includes(user.role); }

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

  function haversineMiles(a, b) {
    const R = 3958.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.asin(Math.sqrt(s)) * 10) / 10;
  }

  async function buildMap() {
    const clientRows = await dbAll("SELECT id, child_name, address FROM clients WHERE address IS NOT NULL AND address <> '' ORDER BY child_name");
    const empRows = await dbAll("SELECT id, name, role_title, address FROM hr_employees WHERE address IS NOT NULL AND address <> '' AND (status IS NULL OR status <> 'terminated') ORDER BY name");

    const clients = [], clinicians = [];
    let pending = 0;
    for (const c of clientRows) {
      const co = await coordFor(c.address);
      if (co) clients.push({ id: c.id, name: c.child_name, lat: co.lat, lng: co.lng });
      else pending++;
    }
    for (const e of empRows) {
      const co = await coordFor(e.address);
      if (co) clinicians.push({ id: e.id, name: e.name, role_title: e.role_title || "", lat: co.lat, lng: co.lng });
      else pending++;
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

    return { center: CENTER, clients, clinicians, pairings, pending, totalClients: clientRows.length, totalClinicians: empRows.length };
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

  return { initTables, handleApi, geocodeSweep, buildMap, haversineMiles, canView };
};
