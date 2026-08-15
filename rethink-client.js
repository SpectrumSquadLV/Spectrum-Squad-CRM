// rethink-client.js -- transport layer for the Rethink Behavioral Health API.
//
// Two jobs, and deliberately nothing else:
//
//   1. OAuth2 client-credentials token acquisition and renewal, so nobody has
//      to mint a bearer token by hand every hour.
//   2. A paged GET helper for the data-warehouse (DWH) API.
//
// No business logic lives here. Nothing in this file knows what a supervision
// hour or a 97153 authorization is -- that belongs to rethink.js. The split
// exists so there is exactly one place that holds credentials and exactly one
// place that talks HTTP to Rethink, rather than fetch() calls scattered through
// the CRM.
//
// CREDENTIALS. RETHINK_CLIENT_ID and RETHINK_CLIENT_SECRET are read from the
// environment on the server only. They are never written to the database, never
// returned by an API route, never logged, and never sent to the browser. The
// access token is held in memory for the life of the process and is likewise
// never logged or persisted. If you add logging to this file, log status codes
// and counts -- not request bodies, not response bodies, not headers. Response
// bodies from the DWH contain PHI.

"use strict";

// Endpoints are configuration, not constants, so a base-URL change does not
// require a deploy. The defaults are the values Rethink issued with our API
// access.
const TOKEN_URL = process.env.RETHINK_TOKEN_URL || "https://id.rethinkbehavioralhealth.com/connect/token";
const DWH_BASE = process.env.RETHINK_DWH_BASE_URL || "https://dwh.rethinkbehavioralhealth.com/api/";

// Minimum permission necessary. The credential is provisioned for
// "api.read api.write", but both integrations this client serves are read-only,
// so we ask for the read scope alone. Override with RETHINK_SCOPE if a future
// feature genuinely needs to write back to Rethink.
const SCOPE = process.env.RETHINK_SCOPE || "api.read";

// Renew this long before the token actually expires, so a request never races
// its own expiry. Rethink tokens last ~1 hour.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const REQUEST_TIMEOUT_MS = Number(process.env.RETHINK_TIMEOUT_MS || 45000);
const MAX_RETRIES = 3;

// ---- credential presence -------------------------------------------------
function clientId() { return process.env.RETHINK_CLIENT_ID || ""; }
function clientSecret() { return process.env.RETHINK_CLIENT_SECRET || ""; }

// Whether the integration can run at all. Checked before every sync so a
// missing credential produces a clear, recorded reason rather than a 401 storm.
function configured() { return !!(clientId() && clientSecret()); }

const CREDENTIAL_VARS = ["RETHINK_CLIENT_ID", "RETHINK_CLIENT_SECRET"];

// Environment variable NAMES that are nearly right but not right -- almost
// always a trailing newline or space picked up when pasting the name into a
// hosting dashboard. process.env is keyed exactly, so "RETHINK_CLIENT_ID\n" is
// a different variable that no amount of correct code will ever read.
//
// This cost a production debugging session: the panel said "add both
// variables" while one of them was sitting right there in Railway with an
// invisible \n on the end of its key. Names are configuration, not secrets, so
// reporting them is safe -- values are never touched here.
function malformedCredentialNames() {
  const out = [];
  for (const key of Object.keys(process.env)) {
    const tidy = key.trim();
    if (tidy === key) continue;                       // name is clean
    if (!CREDENTIAL_VARS.includes(tidy)) continue;    // not one of ours
    out.push({ expected: tidy, actual: JSON.stringify(key) }); // JSON shows the \n
  }
  return out;
}

// Booleans only. Deliberately no values, no lengths, no prefixes -- enough to
// tell an owner which variable is missing and nothing that could leak a secret
// into a browser, a log line or a screenshot.
function configState() {
  return {
    clientIdConfigured: !!clientId(),
    clientSecretConfigured: !!clientSecret(),
    configured: configured(),
    malformed_variable_names: malformedCredentialNames(),
  };
}

// ---- token cache ---------------------------------------------------------
// Module-level, in-memory, process-lifetime. `pending` is the single-flight
// guard: when several syncs start at once they await one token request instead
// of stampeding the identity server.
let cached = { token: "", expiresAt: 0 };
let pending = null;

function tokenValid(nowMs) {
  return !!cached.token && cached.expiresAt - REFRESH_MARGIN_MS > nowMs;
}

// Strip anything credential-shaped out of a string before it can reach a log
// line or a database row. Belt and braces: we do not log bodies anyway, but a
// stray error message from a dependency should not be able to leak either.
function redact(s) {
  let out = String(s == null ? "" : s);
  const id = clientId(), secret = clientSecret();
  if (secret) out = out.split(secret).join("[redacted]");
  if (id) out = out.split(id).join("[redacted]");
  if (cached.token) out = out.split(cached.token).join("[redacted]");
  // Any bearer token or client_secret= form field that arrived from elsewhere.
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
  out = out.replace(/client_secret=[^&\s]+/gi, "client_secret=[redacted]");
  return out;
}

class RethinkError extends Error {
  constructor(message, opts = {}) {
    super(redact(message));
    this.name = "RethinkError";
    this.status = opts.status || null;
    this.kind = opts.kind || "error"; // auth | rate_limit | timeout | http | parse | config
    this.retryable = !!opts.retryable;
  }
}

function timeoutSignal(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

// ---- token acquisition ---------------------------------------------------
async function requestToken(nowMs) {
  if (!configured()) {
    throw new RethinkError(
      "Rethink credentials are not configured. Set RETHINK_CLIENT_ID and RETHINK_CLIENT_SECRET.",
      { kind: "config" }
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId(),
    client_secret: clientSecret(),
    scope: SCOPE,
  });

  const { signal, done } = timeoutSignal(REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal,
    });
  } catch (e) {
    throw new RethinkError(
      e.name === "AbortError" ? "Timed out contacting the Rethink identity server." : `Could not reach the Rethink identity server: ${e.message}`,
      { kind: e.name === "AbortError" ? "timeout" : "http", retryable: true }
    );
  } finally { done(); }

  if (!res.ok) {
    // The identity server echoes the grant in some error bodies, so the body is
    // read only to classify -- never stored, never logged.
    throw new RethinkError(
      `Rethink token request failed (HTTP ${res.status}).`,
      { status: res.status, kind: res.status === 401 || res.status === 400 ? "auth" : "http", retryable: res.status >= 500 }
    );
  }

  let data;
  try { data = await res.json(); }
  catch (e) { throw new RethinkError("Rethink token response was not valid JSON.", { kind: "parse" }); }

  const token = data && data.access_token;
  if (!token) throw new RethinkError("Rethink token response contained no access_token.", { kind: "parse" });

  // expires_in is seconds. Fall back to one hour, which is the documented life.
  const ttlMs = (Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600) * 1000;
  cached = { token, expiresAt: nowMs + ttlMs };
  return token;
}

// Returns a valid bearer token, acquiring or renewing as needed.
// `nowMs` is injected so callers can drive it from the app's clock.
async function getToken(nowMs) {
  const t = typeof nowMs === "number" ? nowMs : Date.now();
  if (tokenValid(t)) return cached.token;
  if (pending) return pending;
  pending = requestToken(t).finally(() => { pending = null; });
  return pending;
}

// Drop the cached token. Called after a 401 so the next attempt re-authenticates
// rather than replaying a token the server has already rejected.
function invalidateToken() { cached = { token: "", expiresAt: 0 }; }

function tokenState(nowMs) {
  const t = typeof nowMs === "number" ? nowMs : Date.now();
  return {
    has_token: !!cached.token,
    valid: tokenValid(t),
    expires_in_seconds: cached.token ? Math.max(0, Math.round((cached.expiresAt - t) / 1000)) : null,
  };
}

// ---- DWH requests --------------------------------------------------------
function buildUrl(base, path, params) {
  const url = new URL(String(path).replace(/^\//, ""), base.endsWith("/") ? base : base + "/");
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One GET against the DWH API, with token renewal on 401 and bounded retries on
// rate limiting and transient server errors.
async function dwhGet(path, params, opts = {}) {
  const nowMs = opts.nowMs;
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await getToken(nowMs);
    const { signal, done } = timeoutSignal(REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(buildUrl(DWH_BASE, path, params), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal,
      });
    } catch (e) {
      lastErr = new RethinkError(
        e.name === "AbortError" ? `Timed out calling Rethink ${path}.` : `Could not reach Rethink ${path}: ${e.message}`,
        { kind: e.name === "AbortError" ? "timeout" : "http", retryable: true }
      );
      if (attempt < MAX_RETRIES) { await sleep(500 * Math.pow(2, attempt)); continue; }
      throw lastErr;
    } finally { done(); }

    if (res.status === 401) {
      // Token rejected. Re-authenticate once; a second 401 is a real auth
      // failure (revoked credential, wrong scope) rather than an expiry race.
      invalidateToken();
      if (attempt < MAX_RETRIES) continue;
      throw new RethinkError(`Rethink rejected our credentials on ${path} (HTTP 401).`, { status: 401, kind: "auth" });
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60000)
        : 500 * Math.pow(2, attempt);
      lastErr = new RethinkError(
        res.status === 429 ? `Rethink rate-limited ${path}.` : `Rethink server error on ${path} (HTTP ${res.status}).`,
        { status: res.status, kind: res.status === 429 ? "rate_limit" : "http", retryable: true }
      );
      if (attempt < MAX_RETRIES) { await sleep(waitMs); continue; }
      throw lastErr;
    }

    if (!res.ok) {
      throw new RethinkError(`Rethink ${path} returned HTTP ${res.status}.`, { status: res.status, kind: "http" });
    }

    try { return await res.json(); }
    catch (e) { throw new RethinkError(`Rethink ${path} returned a malformed JSON body.`, { kind: "parse" }); }
  }

  throw lastErr || new RethinkError(`Rethink ${path} failed.`, { kind: "http" });
}

// The DWH response envelope is not documented to us, and guessing a field name
// would be exactly the kind of invention this integration is meant to avoid.
// So: accept a bare array, or an object carrying exactly one array property
// (whatever it is called), and otherwise fail loudly naming only the KEYS we
// received. Keys are structure, not PHI, so they are safe to surface to an
// admin -- values never are.
function extractRows(payload, path) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const arrayKeys = Object.keys(payload).filter((k) => Array.isArray(payload[k]));
    if (arrayKeys.length === 1) return payload[arrayKeys[0]];
    if (arrayKeys.length > 1) {
      // Prefer the longest array; record the ambiguity for the admin panel.
      const best = arrayKeys.reduce((a, b) => (payload[b].length > payload[a].length ? b : a));
      return payload[best];
    }
  }
  throw new RethinkError(
    `Could not find a result array in the Rethink ${path} response. Top-level keys were: ${
      payload && typeof payload === "object" ? Object.keys(payload).join(", ") || "(none)" : typeof payload
    }.`,
    { kind: "parse" }
  );
}

// Walk every page of a DWH collection endpoint. Stops when a page comes back
// short (or empty), or when maxPages is reached -- the latter is a runaway
// guard, and when it trips the caller is told so it can be reported rather than
// silently truncating the month.
async function dwhGetAllPages(path, params, opts = {}) {
  const pageSize = Number(opts.pageSize || 500);
  const maxPages = Number(opts.maxPages || 200);
  const rows = [];
  let page = 1;
  let truncated = false;

  for (; page <= maxPages; page++) {
    const payload = await dwhGet(path, { ...params, PageSize: pageSize, Page: page }, opts);
    const batch = extractRows(payload, path);
    rows.push(...batch);
    if (batch.length < pageSize) break;
    if (page === maxPages) truncated = true;
  }

  return { rows, pages: Math.min(page, maxPages), truncated };
}

module.exports = {
  configured,
  configState,
  malformedCredentialNames,
  getToken,
  invalidateToken,
  tokenState,
  dwhGet,
  dwhGetAllPages,
  extractRows,
  redact,
  RethinkError,
  endpoints: { TOKEN_URL, DWH_BASE, SCOPE },
};
