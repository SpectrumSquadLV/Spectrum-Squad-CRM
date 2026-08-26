// eventbrite-client.js -- the Eventbrite API adapter.
//
// UNVERIFIED AGAINST THE LIVE SERVICE. This is written to Eventbrite's
// documented v3 API, but the network this was built on cannot reach
// eventbriteapi.com at all -- the proxy answers 403 to CONNECT -- and no token
// has ever been entered. So it has never made a real request, and it says so on
// screen rather than looking healthy.
//
// That is the honest shape for an integration that cannot be tested end to end:
// the mapping, the refusals and the arithmetic are all real and tested against
// recorded-shape payloads through an injected fetch, and the first real run
// records a sample of the raw response so a wrong assumption shows up as
// something to correct rather than as a silently wrong number.
//
// What connecting it needs, exactly:
//
//   EVENTBRITE_TOKEN        a private token from
//                           https://www.eventbrite.com/platform/api-keys
//   the event's Eventbrite id   the numeric id in the event's Eventbrite URL,
//                           stored per event as eventbrite_event_id
//
// Docs: https://www.eventbrite.com/platform/api#/reference/attendee
"use strict";

const API_BASE = "https://www.eventbriteapi.com/v3";
const TIMEOUT_MS = 20000;

// Eventbrite marks a cancelled or refunded attendee on the attendee object
// itself. Anything unrecognised counts as attending, matching the CSV path --
// dropping somebody whose status we do not know loses a real registration.
function attendeeIsAttending(a) {
  if (!a || typeof a !== "object") return false;
  if (a.cancelled === true || a.refunded === true) return false;
  const status = String(a.status || "").toLowerCase();
  if (["deleted", "refunded", "cancelled", "canceled", "abandoned", "declined"].includes(status)) return false;
  return true;
}

// One attendee object -> the same shape the CSV path produces, so everything
// downstream reads one format regardless of where the data came from.
function mapAttendee(a) {
  const profile = (a && a.profile) || {};
  const name = String(profile.name || "").trim()
    || [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim()
    || null;
  const qty = parseInt(a && a.quantity, 10);
  return {
    name,
    email: String(profile.email || "").trim().toLowerCase() || null,
    quantity: Number.isFinite(qty) && qty > 0 ? qty : null,
    ticket_type: (a && a.ticket_class_name) || null,
    external_ref: (a && (a.id || a.order_id)) ? String(a.id || a.order_id) : null,
    ordered_at: (a && a.created) || null,
    status_raw: (a && a.status) || null,
    attending: attendeeIsAttending(a),
  };
}

// What this source needs before it can run, reported rather than guessed at.
function connectorStatus({ token, eventbriteEventId }) {
  const missing = [];
  if (!String(token || "").trim()) missing.push("An Eventbrite private token (EVENTBRITE_TOKEN).");
  if (!String(eventbriteEventId || "").trim()) missing.push("This event's Eventbrite event id.");
  return {
    ready: missing.length === 0,
    missing,
    // Stated in the payload, not only in a comment, so the screen can repeat it
    // to whoever is about to trust a number from here.
    verified_against_live_service: false,
    docs: "https://www.eventbrite.com/platform/api#/reference/attendee",
  };
}

// Fetch every attendee page. `fetchImpl` is injected so the mapping and the
// paging are testable without a network; production passes global fetch.
async function fetchAttendees({ token, eventbriteEventId, fetchImpl, maxPages = 40 }) {
  const status = connectorStatus({ token, eventbriteEventId });
  if (!status.ready) return { ok: false, status: "not_configured", ...status, attendees: [] };

  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { ok: false, status: "no_fetch", error: "No fetch implementation available.", attendees: [] };

  const attendees = [];
  let page = 1, sample = null, pages = 0;
  while (page <= maxPages) {
    const url = `${API_BASE}/events/${encodeURIComponent(eventbriteEventId)}/attendees/?page=${page}`;
    let res;
    try {
      res = await doFetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
          ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      });
    } catch (err) {
      // A network failure is reported, never treated as "no attendees" -- that
      // would quietly report a registration count of zero for a sold-out event.
      return { ok: false, status: "unreachable", error: String((err && err.message) || err), attendees: [], pages };
    }
    if (!res || !res.ok) {
      const code = res ? res.status : 0;
      return {
        ok: false,
        status: code === 401 || code === 403 ? "unauthorised" : "http_error",
        error: `Eventbrite answered HTTP ${code}.`,
        http_status: code, attendees: [], pages,
      };
    }
    let body;
    try { body = await res.json(); } catch (err) {
      return { ok: false, status: "unreadable", error: "Eventbrite's response was not JSON.", attendees: [], pages };
    }
    // The first page's raw shape is kept so a wrong assumption in this mapping
    // can be seen and corrected rather than guessed at. Truncated, because it
    // carries attendee names and emails.
    if (sample === null) sample = JSON.stringify(body).slice(0, 2000);

    const list = Array.isArray(body && body.attendees) ? body.attendees : null;
    if (list === null) {
      return {
        ok: false, status: "unexpected_shape",
        error: "Eventbrite's response had no attendees array. The adapter may need updating.",
        sample, attendees: [], pages,
      };
    }
    for (const a of list) attendees.push(mapAttendee(a));
    pages += 1;

    const pagination = (body && body.pagination) || {};
    const hasMore = pagination.has_more_items === true
      || (Number.isFinite(pagination.page_count) && page < pagination.page_count);
    if (!hasMore) break;
    page += 1;
  }
  return { ok: true, status: "ok", attendees, pages, sample };
}

module.exports = { fetchAttendees, connectorStatus, mapAttendee, attendeeIsAttending, API_BASE };
