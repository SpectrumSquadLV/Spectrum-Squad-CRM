// events-frontend.js -- the Events screen.
//
// Generic on purpose. Nothing here knows about Halloween: the Palooza is one
// row in the event list, and every tab below works the same for a Christmas
// event, a resource fair or an open house. The permanent navigation item is
// "Events", never the name of one event.
//
// Phase 1 is the data layer, so this is deliberately plain: a list, a detail
// with tabs, and the forms needed to get real information into the tables. The
// KPI dashboard is Phase 2 and the Overview tab is a summary, not a dashboard.
//
// There is no outreach here -- no send button, no email compose -- by design.
(function () {
  "use strict";

  var MOUNT = null;
  var STATE = { view: "list", eventId: null, tab: "overview", data: null, vocab: null, list: null };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function api(path, opts) {
    if (typeof window.api === "function") return window.api(path, opts);
    opts = opts || {};
    return fetch(path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.error || "Request failed (" + r.status + ")"); e.data = d; throw e; }
        return d;
      });
    });
  }
  // Money is only ever rendered when the server actually sent it. A role that
  // cannot see amounts gets no field at all, not a zero -- a zero would read as
  // "nobody has sponsored anything".
  function money(v) {
    if (v == null || v === "") return "—";
    var n = Number(v);
    return isFinite(n) ? "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  }
  function val(v) { return (v == null || v === "") ? "—" : esc(v); }
  function plural(n, one, many) { return n + " " + (Number(n) === 1 ? one : (many || one + "s")); }
  // Unknowns are labelled, never invented. A blank venue is a blank venue.
  function needed(v) {
    return (v == null || v === "")
      ? '<span style="color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:1px 7px;font-size:11.5px;">Information Needed</span>'
      : esc(v);
  }
  function pill(text, tone) {
    var tones = {
      ok: "background:#dcfce7;color:#166534;", warn: "background:#fef3c7;color:#92400e;",
      bad: "background:#fee2e2;color:#991b1b;", none: "background:#eef2ff;color:#3f56b5;",
      grey: "background:#e5e7eb;color:#374151;",
    };
    return '<span class="tag" style="' + (tones[tone] || tones.none) + 'font-weight:700;font-size:11px;">' + esc(text) + '</span>';
  }
  function statusTone(s) {
    if (["CONFIRMED", "COMMITTED", "PAID", "APPROVED", "PUBLISHED", "ACTIVE", "COMPLETED", "INTERESTED"].indexOf(s) >= 0) return "ok";
    if (["DECLINED", "NOT_INTERESTED", "CANCELLED", "DO_NOT_CONTACT"].indexOf(s) >= 0) return "bad";
    if (["FOLLOW_UP_NEEDED", "REQUIREMENTS_PENDING", "PENDING", "PARTIAL", "UNDER_REVIEW"].indexOf(s) >= 0) return "warn";
    return "grey";
  }
  function human(s) { return String(s || "").replace(/_/g, " ").toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); }); }

  function field(label, id, value, opts) {
    opts = opts || {};
    var t = opts.type || "text";
    if (t === "textarea") {
      return '<div class="field' + (opts.full ? " full" : "") + '"><label>' + esc(label) + '</label>'
        + '<textarea id="' + id + '" rows="' + (opts.rows || 3) + '">' + esc(value == null ? "" : value) + '</textarea></div>';
    }
    if (t === "select") {
      return '<div class="field"><label>' + esc(label) + '</label><select id="' + id + '">'
        + (opts.options || []).map(function (o) {
          var v = typeof o === "string" ? o : o.value, lb = typeof o === "string" ? human(o) : o.label;
          return '<option value="' + esc(v) + '"' + (String(value) === String(v) ? " selected" : "") + '>' + esc(lb) + '</option>';
        }).join("") + '</select></div>';
    }
    if (t === "checkbox") {
      return '<div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;">'
        + '<input type="checkbox" id="' + id + '" style="width:auto;"' + (value ? " checked" : "") + ' /> ' + esc(label) + '</label></div>';
    }
    return '<div class="field' + (opts.full ? " full" : "") + '"><label>' + esc(label) + '</label>'
      + '<input type="' + t + '" id="' + id + '" value="' + esc(value == null ? "" : value) + '"'
      + (opts.step ? ' step="' + opts.step + '"' : "") + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : "") + ' /></div>';
  }
  function get(id) { var el = document.getElementById(id); return el ? (el.type === "checkbox" ? el.checked : el.value) : undefined; }

  // ------------------------------------------------------------- modal form
  function formModal(title, bodyHtml, onSave, opts) {
    opts = opts || {};
    var bd = document.createElement("div");
    bd.className = "modal-backdrop";
    bd.innerHTML = '<div class="modal" style="width:' + (opts.width || 640) + 'px;">'
      + '<div class="modal-header"><h2>' + esc(title) + '</h2><button class="close-btn">✕</button></div>'
      + '<div class="form-grid">' + bodyHtml + '</div>'
      + '<div id="ev-form-error" style="display:none;color:#b91c1c;font-size:13px;margin-top:10px;"></div>'
      + '<div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end;">'
      + '<button type="button" class="btn secondary" id="ev-cancel">Cancel</button>'
      + '<button type="button" class="btn" id="ev-save">' + esc(opts.saveLabel || "Save") + '</button></div></div>';
    document.body.appendChild(bd);
    var close = function () { bd.remove(); };
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.querySelector("#ev-cancel").addEventListener("click", close);
    bd.addEventListener("click", function (e) { if (e.target === bd) close(); });
    bd.querySelector("#ev-save").addEventListener("click", function () {
      var btn = bd.querySelector("#ev-save");
      btn.disabled = true;
      Promise.resolve()
        .then(function () { return onSave(close, bd); })
        .catch(function (e) {
          var box = bd.querySelector("#ev-form-error");
          box.style.display = "block";
          box.innerHTML = esc(e.message || "Could not save.");
        })
        .then(function () { btn.disabled = false; });
    });
    return bd;
  }

  // ------------------------------------------------------------- event list
  function renderList(data) {
    STATE.list = data;
    var evs = data.events || [];
    MOUNT.innerHTML =
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;">'
      + '<div><h1 style="margin:0 0 4px;">Events</h1>'
      + '<p style="color:var(--text-muted);font-size:13px;margin:0;max-width:760px;">'
      + 'Community events and the businesses around them — prospects, sponsors, in-kind donations, vendors and community partners. '
      + 'Each event keeps its own list; the same business can take part in more than one.</p></div>'
      + '<button class="btn" id="ev-new">+ New event</button></div>'
      + (evs.length ? '<div style="display:grid;gap:12px;margin-top:18px;">' + evs.map(cardHtml).join("") + '</div>'
        : '<div class="empty-state" style="margin-top:18px;">No events yet. Create one to start tracking sponsors and partners.</div>');

    MOUNT.querySelector("#ev-new").addEventListener("click", newEventModal);
    Array.prototype.forEach.call(MOUNT.querySelectorAll("[data-open-event]"), function (el) {
      el.addEventListener("click", function () { openEvent(Number(el.dataset.openEvent)); });
    });
  }

  function cardHtml(ev) {
    var t = ev.totals || {};
    var bits = [];
    if (t.sponsorship_committed != null) bits.push("Sponsorship committed <strong>" + money(t.sponsorship_committed) + "</strong>");
    bits.push("Prospects <strong>" + (t.prospects_total || 0) + "</strong>");
    bits.push("Vendors <strong>" + (t.vendors_confirmed || 0) + "/" + (t.vendors_total || 0) + " confirmed</strong>");
    bits.push("Partners <strong>" + (t.partners_confirmed || 0) + "/" + (t.partners_total || 0) + "</strong>");
    bits.push("In-kind items <strong>" + (t.in_kind_count || 0) + "</strong>");
    return '<div class="card" style="cursor:pointer;" data-open-event="' + ev.id + '">'
      + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
      + '<strong style="font-size:16px;">' + esc(ev.name) + '</strong>'
      + pill(human(ev.status), statusTone(ev.status)) + '</div>'
      + '<div style="font-size:13px;color:var(--text-muted);margin-top:5px;">'
      + (ev.event_date ? esc(ev.event_date) : "Date not set")
      + (ev.venue_name ? " · " + esc(ev.venue_name) : "")
      + (ev.city ? " · " + esc(ev.city) : "") + '</div>'
      + '<div style="font-size:12.5px;color:var(--text-muted);margin-top:8px;">' + bits.join(" &nbsp;·&nbsp; ") + '</div></div>';
  }

  function newEventModal() {
    formModal("New event",
      field("Event name", "ev-name", "", { full: true, placeholder: "e.g. Spring Resource Fair 2027" })
      + field("Date", "ev-date", "", { type: "date" })
      + field("Status", "ev-status", "DRAFT", { type: "select", options: (STATE.vocab && STATE.vocab.event_statuses) || ["DRAFT"] }),
      function (close) {
        var name = (get("ev-name") || "").trim();
        if (!name) throw new Error("The event needs a name.");
        return api("/api/events", { method: "POST", body: { name: name, event_date: get("ev-date"), status: get("ev-status") } })
          .then(function (r) { close(); openEvent(r.id); });
      }, { saveLabel: "Create event" });
  }

  // ----------------------------------------------------------- event detail
  var TABS = [
    ["overview", "Overview"], ["prospects", "Prospects"], ["sponsors", "Sponsors"],
    ["donations", "Donations"], ["vendors", "Vendors"], ["partners", "Community Partners"],
    ["outreach", "Outreach"], ["settings", "Settings"],
  ];

  function openEvent(id) {
    STATE.view = "detail"; STATE.eventId = id;
    return refresh();
  }
  function refresh() {
    return api("/api/events/" + STATE.eventId).then(function (d) { STATE.data = d; renderDetail(); });
  }

  function renderDetail() {
    var d = STATE.data, ev = d.event;
    MOUNT.innerHTML =
      '<button class="btn secondary small" id="ev-back">← All events</button>'
      + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;">'
      + '<h1 style="margin:0;">' + esc(ev.name) + '</h1>' + pill(human(ev.status), statusTone(ev.status)) + '</div>'
      + '<div style="font-size:13px;color:var(--text-muted);margin-top:4px;">'
      + (ev.event_date ? esc(ev.event_date) : "Date not set")
      + (ev.venue_name ? " · " + esc(ev.venue_name) : "") + '</div>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:16px 0 14px;border-bottom:1px solid var(--border,#e5e7eb);padding-bottom:10px;">'
      + TABS.map(function (t) {
        var on = STATE.tab === t[0];
        return '<button class="btn ' + (on ? "" : "secondary") + ' small" data-tab="' + t[0] + '">' + esc(t[1]) + '</button>';
      }).join("") + '</div><div id="ev-tab-body"></div>';

    MOUNT.querySelector("#ev-back").addEventListener("click", function () { STATE.view = "list"; STATE.tab = "overview"; load(); });
    Array.prototype.forEach.call(MOUNT.querySelectorAll("[data-tab]"), function (b) {
      b.addEventListener("click", function () { STATE.tab = b.dataset.tab; renderDetail(); });
    });
    renderTab(document.getElementById("ev-tab-body"));
  }

  function table(headers, rows, emptyMsg) {
    if (!rows.length) return '<div class="empty-state">' + esc(emptyMsg) + '</div>';
    return '<div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;overflow-x:auto;">'
      + '<table style="width:100%;border-collapse:collapse;font-size:13px;min-width:640px;"><thead><tr style="background:#f8fafc;">'
      + headers.map(function (h) { return '<th style="text-align:left;padding:9px 12px;white-space:nowrap;">' + esc(h) + '</th>'; }).join("")
      + '</tr></thead><tbody>' + rows.join("") + '</tbody></table></div>';
  }
  function td(html, style) { return '<td style="padding:9px 12px;' + (style || "") + '">' + html + '</td>'; }
  function tr(cells) { return '<tr style="border-top:1px solid var(--border,#eef0f4);">' + cells.join("") + '</tr>'; }
  function addBar(label, id) {
    return '<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button class="btn small" id="' + id + '">+ ' + esc(label) + '</button></div>';
  }

  function renderTab(el) {
    var d = STATE.data;
    if (STATE.tab === "overview") return renderOverview(el, d);
    if (STATE.tab === "prospects") return renderProspects(el, d);
    if (STATE.tab === "sponsors") return renderSponsors(el, d);
    if (STATE.tab === "donations") return renderDonations(el, d);
    if (STATE.tab === "vendors") return renderVendors(el, d);
    if (STATE.tab === "partners") return renderPartners(el, d);
    if (STATE.tab === "outreach") return renderOutreach(el, d);
    if (STATE.tab === "settings") return renderSettings(el, d);
  }

  // ---------------------------------------------------------- dashboard
  //
  // Phase 2. Every number comes from /api/events/:id/dashboard so this screen
  // and the tabs cannot disagree.
  //
  // Colour is doing one job here: magnitude, in one hue. The funnel is a single
  // series, so there is no legend and no categorical palette -- each bar is
  // named by its own label. Status colours are reserved for state and always
  // ship with words beside them, never colour alone.
  //
  //   --viz-fill   #3f56b5  validated: inside the lightness band, >= 3:1 on white
  //   --viz-track  #eef0f4  a track, not a data mark
  //   good/warn/bad        #15803d / #b45309 / #b91c1c, all >= 3:1, always labelled
  var VIZ = { fill: "#3f56b5", track: "#eef0f4", good: "#15803d", warn: "#b45309", bad: "#b91c1c" };

  function meterHtml(m, opts) {
    opts = opts || {};
    var fmt = opts.money ? money : function (v) { return v == null ? "—" : Number(v).toLocaleString(); };
    var label = '<span style="color:var(--text-muted);">' + esc(m.label) + '</span>';

    // The CRM has no figure for this at all -- registrations and attendance are
    // not tracked here. Drawing "0 of 400" with an empty bar would claim nobody
    // has signed up, which is a different and much worse statement than "we do
    // not have this number".
    if (m.actual_known === false) {
      return '<div style="margin-bottom:14px;">'
        + '<div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">'
        + label + '<span style="font-weight:600;color:var(--text-muted);">'
        + (m.target_set ? 'Goal ' + fmt(m.target) : 'No goal set') + '</span></div>'
        + '<div style="font-size:11.5px;color:var(--text-muted);">'
        + esc(m.source || "Not tracked in the CRM.") + '</div></div>';
    }

    // A target nobody entered is not a target of zero. No bar is drawn at all,
    // because a full bar or an empty one both assert something untrue.
    if (!m.target_set) {
      return '<div style="margin-bottom:14px;">'
        + '<div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">'
        + label + '<span style="color:var(--text-muted);">No goal set</span></div>'
        + '<div style="font-size:15px;font-weight:700;">' + fmt(m.actual) + '</div>'
        + '<div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;">Set a goal in Settings to track progress.</div>'
        + '</div>';
    }
    var pct = m.percent == null ? 0 : m.percent;
    var width = Math.max(0, Math.min(100, pct));
    var met = pct >= 100;
    return '<div style="margin-bottom:14px;">'
      + '<div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">'
      + label
      + '<span style="font-weight:600;">' + fmt(m.actual) + ' <span style="color:var(--text-muted);font-weight:400;">of ' + fmt(m.target) + '</span></span></div>'
      + '<div style="height:10px;background:' + VIZ.track + ';border-radius:5px;overflow:hidden;">'
      + '<div style="height:100%;width:' + width + '%;background:' + (met ? VIZ.good : VIZ.fill) + ';border-radius:5px;"></div></div>'
      + '<div style="font-size:11.5px;color:' + (met ? VIZ.good : "var(--text-muted)") + ';margin-top:3px;">'
      + (met ? "✓ " : "") + pct + '% of goal</div></div>';
  }

  function funnelHtml(f) {
    var counts = f.counts || {};
    var order = f.order || [];
    var max = 0;
    order.forEach(function (k) { max = Math.max(max, counts[k] || 0); });
    (f.out_of_pipeline || []).forEach(function (k) { max = Math.max(max, counts[k] || 0); });
    if (!max) return '<div class="empty-state">No prospects yet.</div>';

    // Every bar is directly labelled, so identity never rests on colour, and a
    // bar of zero still shows its row -- a stage nobody has reached is
    // information, not something to hide.
    function bar(key) {
      var n = counts[key] || 0;
      var w = max ? Math.round((n / max) * 100) : 0;
      return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:5px;">'
        + '<div style="width:170px;flex:none;font-size:12.5px;color:var(--text-muted);text-align:right;">' + esc(human(key)) + '</div>'
        + '<div style="flex:1;min-width:0;height:18px;position:relative;">'
        + (n > 0
          ? '<div style="height:100%;width:' + Math.max(w, 2) + '%;background:' + VIZ.fill + ';border-radius:0 4px 4px 0;"></div>'
          : '<div style="height:100%;width:2px;background:' + VIZ.track + ';"></div>')
        + '</div>'
        + '<div style="width:40px;flex:none;font-size:13px;font-weight:700;">' + n + '</div></div>';
    }
    var out = (f.out_of_pipeline || []).filter(function (k) { return (counts[k] || 0) > 0; });
    return '<div>' + order.map(bar).join("") + '</div>'
      + (out.length
        ? '<div style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--border,#e5e7eb);">'
          + '<div style="font-size:11.5px;color:var(--text-muted);margin-bottom:6px;">Out of the pipeline</div>'
          + out.map(bar).join("") + '</div>'
        : "");
  }

  function attentionHtml(items) {
    if (!items || !items.length) {
      return '<div class="empty-state">Nothing needs chasing right now.</div>';
    }
    var toneColor = { critical: VIZ.bad, warning: VIZ.warn, info: VIZ.fill };
    var toneIcon = { critical: "●", warning: "▲", info: "■" };
    return '<div style="display:grid;gap:8px;">' + items.map(function (a) {
      var c = toneColor[a.tone] || VIZ.fill;
      // Icon AND words: the colour is never the only thing carrying the state.
      return '<div style="display:flex;align-items:center;gap:10px;border:1px solid var(--border,#e5e7eb);border-left:3px solid ' + c + ';border-radius:8px;padding:9px 12px;">'
        + '<span style="color:' + c + ';font-size:11px;" aria-hidden="true">' + toneIcon[a.tone] + '</span>'
        + '<span style="flex:1;min-width:0;font-size:13px;">' + esc(a.label) + '</span>'
        + '<span style="font-weight:700;font-size:14px;">' + a.count + '</span></div>';
    }).join("") + '</div>';
  }

  function renderOverview(el, d) {
    el.innerHTML = '<div class="empty-state">Loading dashboard…</div>';
    api("/api/events/" + STATE.eventId + "/dashboard").then(function (k) {
      var money$ = k.can_see_money;
      var days = k.days_until;
      var countdown = days == null
        ? '<div style="font-size:13px;color:var(--text-muted);">No date set yet</div>'
        : '<div><span style="font-size:34px;font-weight:700;line-height:1;">'
          + (days > 0 ? days : days === 0 ? "Today" : Math.abs(days))
          + '</span><span style="font-size:13px;color:var(--text-muted);margin-left:8px;">'
          + (days > 0 ? "day" + (days === 1 ? "" : "s") + " to go" : days === 0 ? "" : "day" + (Math.abs(days) === 1 ? "" : "s") + " ago")
          + '</span></div>';

      var m = k.meters || {};
      var meters = [];
      if (money$ && m.sponsorship) meters.push(meterHtml(m.sponsorship, { money: true }));
      if (money$ && m.sponsorship_committed) meters.push(meterHtml(m.sponsorship_committed, { money: true }));
      if (m.vendors) meters.push(meterHtml(m.vendors));
      // Registrations and attendance have no source of truth in the CRM yet --
      // ticketing lives on Eventbrite. Showing a meter at zero would claim
      // nobody has registered, which is not something this system knows.
      if (m.registrations && m.registrations.target_set) meters.push(meterHtml(m.registrations));
      if (m.attendance && m.attendance.target_set) meters.push(meterHtml(m.attendance));

      var mo = k.money || {};
      function tile(label, value, note, color) {
        return '<div class="card" style="flex:1;min-width:170px;">'
          + '<div style="font-size:11.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;">' + esc(label) + '</div>'
          + '<div style="font-size:22px;font-weight:700;margin-top:4px;' + (color ? "color:" + color + ";" : "") + '">' + value + '</div>'
          + (note ? '<div style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">' + note + '</div>' : "")
          + '</div>';
      }
      var tiles = [];
      if (money$) {
        tiles.push(tile("Sponsorship paid", money(mo.paid), "Money received"));
        tiles.push(tile("Committed", money(mo.committed), "Promised, not yet all in"));
        tiles.push(tile("Outstanding", money(mo.outstanding), "Committed minus paid",
          Number(mo.outstanding) > 0 ? VIZ.warn : null));
        // "$0.00" beside "1 not valued" says the donated bounce house was worth
        // nothing. When nothing has been valued yet there is no estimate to
        // show, so the tile says so instead of printing a zero somebody would
        // quote. A real zero (no donations at all) still reads as $0.00.
        var inKind = Number(mo.in_kind_estimate_received) > 0
          ? money(mo.in_kind_estimate_received)
          : (mo.in_kind_items_unvalued > 0 ? '<span style="color:var(--text-muted);">Not valued yet</span>' : money(0));
        tiles.push(tile("In-kind (estimated)", inKind,
          mo.in_kind_items_unvalued
            ? plural(mo.in_kind_items_unvalued, "item") + " received with no value recorded"
            : "Goods received, at estimated value"));
      }
      var r = k.readiness || {};
      tiles.push(tile("Prospects", (k.funnel || {}).total || 0,
        ((k.funnel || {}).counts || {}).COMMITTED ? (k.funnel.counts.COMMITTED + " committed") : "None committed yet"));
      tiles.push(tile("Vendors", (r.vendors_confirmed || 0) + " / " + (r.vendors_total || 0),
        (r.needs_electricity || 0) + " need power · " + (r.needs_table || 0) + " need a table"));
      tiles.push(tile("Community partners", (r.partners_confirmed || 0) + " / " + (r.partners_total || 0), "confirmed"));

      el.innerHTML =
        '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start;margin-bottom:6px;">'
        + '<div class="card" style="min-width:210px;">'
        + '<div style="font-size:11.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;">'
        + esc(k.event_date || "Date not set") + '</div>' + countdown + '</div>'
        + '<div class="card" style="flex:2;min-width:280px;">'
        + '<div style="font-size:11.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;">Goals</div>'
        + (meters.length ? meters.join("")
          : '<div style="font-size:13px;color:var(--text-muted);">No goals set yet. Add them in Settings.</div>')
        + '</div></div>'

        + '<div style="display:flex;gap:12px;flex-wrap:wrap;margin:14px 0;">' + tiles.join("") + '</div>'

        + '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start;">'
        + '<div class="card" style="flex:1;min-width:340px;">'
        + '<div style="font-weight:700;font-size:14px;margin-bottom:2px;">Prospect pipeline</div>'
        + '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">'
        + plural((k.funnel || {}).total || 0, "business", "businesses") + ' on this event</div>'
        + funnelHtml(k.funnel || {}) + '</div>'
        + '<div class="card" style="flex:1;min-width:340px;">'
        + '<div style="font-weight:700;font-size:14px;margin-bottom:2px;">Needs attention</div>'
        + '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Things somebody has to actually do</div>'
        + attentionHtml(k.attention) + '</div></div>'

        + (money$
          ? '<p style="font-size:12.5px;color:var(--text-muted);margin-top:14px;max-width:780px;">'
            + 'Cash and donated goods are kept apart on purpose. In-kind is an <strong>estimate</strong> of what a donated '
            + 'item was worth; committed is a promise; paid is money received. There is no combined "total raised" here, '
            + 'because that number could not be stood behind.</p>'
          : '<p style="font-size:12.5px;color:var(--text-muted);margin-top:14px;">Sponsorship amounts are not shown for your role.</p>');
    }).catch(function (e) {
      el.innerHTML = '<div class="empty-state">Could not load the dashboard: ' + esc(e.message) + '</div>';
    });
  }

  function renderProspects(el, d) {
    var rows = (d.prospects || []).map(function (p) {
      return tr([
        td('<strong>' + esc(p.business_name) + '</strong>'
          + (p.business_category ? '<div style="font-size:11.5px;color:var(--text-muted);">' + esc(p.business_category) + '</div>' : "")),
        td(val(p.contact_name) + (p.public_email ? '<div style="font-size:11.5px;color:var(--text-muted);">' + esc(p.public_email) + '</div>' : "")),
        td(pill(human(p.opportunity_type), "none")),
        td(pill(human(p.status), statusTone(p.status))
          + (p.do_not_contact ? " " + pill("Do not contact", "bad") : "")),
        td(val(p.priority)),
        td(d.can_see_money ? money(p.estimated_ask) : "—"),
        td('<button class="btn small secondary" data-edit-prospect="' + p.id + '">Edit</button>'
          + (d.can_delete ? ' <button class="btn small secondary" data-del-prospect="' + p.id + '" style="color:#b91c1c;">Delete</button>' : "")),
      ]);
    });
    el.innerHTML = addBar("Add prospect", "ev-add-prospect")
      + table(["Business", "Contact", "Opportunity", "Status", "Priority", "Est. ask", ""], rows,
        "No prospects yet. Add the businesses you plan to approach for this event.");
    document.getElementById("ev-add-prospect").addEventListener("click", function () { prospectModal(null); });
    wireRowButtons(el, "edit-prospect", function (id) {
      prospectModal((d.prospects || []).filter(function (p) { return p.id === id; })[0]);
    });
    wireRowButtons(el, "del-prospect", function (id) {
      var p = (d.prospects || []).filter(function (x) { return x.id === id; })[0];
      if (!confirm('Delete "' + (p ? p.business_name : "this prospect") + '"?\n\nAnything already recorded against them — sponsorships, donations, vendor or partner records — is kept and kept named.')) return;
      api("/api/events/" + STATE.eventId + "/prospects/" + id, { method: "DELETE" }).then(refresh);
    });
  }

  function wireRowButtons(el, attr, fn) {
    Array.prototype.forEach.call(el.querySelectorAll("[data-" + attr + "]"), function (b) {
      b.addEventListener("click", function () { fn(Number(b.dataset[attr.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })])); });
    });
  }

  function prospectModal(existing) {
    var v = existing || {};
    var vocab = STATE.vocab || {};
    var body =
      field("Business name", "p-name", v.business_name, { full: true })
      + field("Category", "p-cat", v.business_category, { placeholder: "e.g. Bakery, Dentist" })
      + field("Website", "p-web", v.website, { placeholder: "example.com" })
      + field("Public email", "p-email", v.public_email, { type: "email" })
      + field("Public phone", "p-phone", v.public_phone)
      + field("Contact name", "p-cname", v.contact_name)
      + field("Contact title", "p-ctitle", v.contact_title)
      + field("City", "p-city", v.city)
      + field("Opportunity", "p-opp", v.opportunity_type || "SPONSOR", { type: "select", options: vocab.opportunity_types || [] })
      + field("Priority", "p-pri", v.priority || "MEDIUM", { type: "select", options: vocab.priorities || [] })
      + field("Status", "p-status", v.status || "NEW_PROSPECT", { type: "select", options: vocab.prospect_statuses || [] })
      + (STATE.data.can_see_money ? field("Estimated ask", "p-ask", v.estimated_ask, { type: "number", step: "0.01" }) : "")
      + field("Source", "p-source", v.source, { placeholder: "Where did this lead come from?" })
      + field("Next follow-up", "p-follow", v.next_follow_up, { type: "date" })
      + field("Notes", "p-notes", v.notes, { type: "textarea", full: true })
      + '<div class="field full" style="border-top:1px solid var(--border,#e5e7eb);padding-top:10px;margin-top:4px;">'
      + '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">'
      + '<input type="checkbox" id="p-dnc" style="width:auto;"' + (v.do_not_contact ? " checked" : "") + ' /> '
      + '<strong>Do not contact</strong></label>'
      + '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">'
      + 'Permanent. Applies to this business across <strong>every</strong> Spectrum Squad event, not just this one, '
      + 'and is never lifted by changing their status.</div>'
      + '<input type="text" id="p-dnc-reason" placeholder="Reason (optional)" value="' + esc(v.do_not_contact_reason || "") + '" style="margin-top:8px;" /></div>';

    formModal(existing ? "Edit prospect" : "Add prospect", body, function (close, bd) {
      var payload = {
        business_name: (get("p-name") || "").trim(), business_category: get("p-cat"), website: get("p-web"),
        public_email: get("p-email"), public_phone: get("p-phone"), contact_name: get("p-cname"),
        contact_title: get("p-ctitle"), city: get("p-city"), opportunity_type: get("p-opp"),
        priority: get("p-pri"), status: get("p-status"), source: get("p-source"),
        next_follow_up: get("p-follow"), notes: get("p-notes"),
        do_not_contact: get("p-dnc"), do_not_contact_reason: get("p-dnc-reason"),
      };
      if (STATE.data.can_see_money) payload.estimated_ask = get("p-ask");
      if (!payload.business_name) throw new Error("The prospect needs a business name.");
      if (existing) {
        return api("/api/events/" + STATE.eventId + "/prospects/" + existing.id, { method: "PATCH", body: payload })
          .then(function () { close(); return refresh(); });
      }
      return api("/api/events/" + STATE.eventId + "/prospects", { method: "POST", body: payload })
        .then(function () { close(); return refresh(); })
        .catch(function (e) {
          // A likely duplicate is shown, with what it matched on, and the person
          // decides. Nothing is discarded either way.
          var dupes = e.data && e.data.duplicates;
          if (!dupes || !dupes.length) throw e;
          var lines = dupes.map(function (x) {
            return "• " + x.business_name + " (" + x.confidence + " — same " + x.matched_on.join(", ") + ")";
          }).join("\n");
          if (!confirm("This looks like a business already on this event:\n\n" + lines
            + "\n\nAdd it anyway as a separate prospect?")) { close(); return; }
          payload.force = true;
          return api("/api/events/" + STATE.eventId + "/prospects", { method: "POST", body: payload })
            .then(function () { close(); return refresh(); });
        });
    }, { width: 720 });
  }

  function prospectOptions(d, selected) {
    return [{ value: "", label: "— none —" }].concat((d.prospects || []).map(function (p) {
      return { value: String(p.id), label: p.business_name };
    })).map(function (o) {
      return '<option value="' + esc(o.value) + '"' + (String(selected || "") === o.value ? " selected" : "") + '>' + esc(o.label) + '</option>';
    }).join("");
  }

  function renderSponsors(el, d) {
    var levels = d.sponsorship_levels || [];
    var levelRows = levels.map(function (l) {
      return tr([
        td('<strong>' + esc(l.name) + '</strong>'),
        td(d.can_see_money ? money(l.amount) : "—"),
        td(val(l.description)),
        td(l.active ? pill("Active", "ok") : pill("Inactive", "grey")),
        td('<button class="btn small secondary" data-edit-level="' + l.id + '">Edit</button>'),
      ]);
    });
    var sponsorRows = (d.sponsorships || []).map(function (s) {
      var lvl = levels.filter(function (l) { return l.id === s.sponsorship_level_id; })[0];
      return tr([
        td('<strong>' + esc(s.sponsor_name || "—") + '</strong>'),
        td(lvl ? esc(lvl.name) : val(s.custom_sponsorship_name)),
        td(d.can_see_money ? money(s.amount_committed) : "—"),
        td(d.can_see_money ? money(s.amount_paid) : "—"),
        td(pill(human(s.payment_status), statusTone(s.payment_status))),
        td((s.logo_received ? pill("Logo", "ok") + " " : "") + (s.banner_placement ? pill("Banner", "none") + " " : "")
          + (s.vendor_booth_included ? pill("Booth", "none") : "")),
        td('<button class="btn small secondary" data-edit-sponsorship="' + s.id + '">Edit</button>'),
      ]);
    });
    el.innerHTML =
      '<h3 style="margin:0 0 8px;font-size:15px;">Sponsorship levels</h3>'
      + '<p style="font-size:12.5px;color:var(--text-muted);margin:0 0 10px;">Prices are data, not settings baked into the app — edit them freely.</p>'
      + addBar("Add level", "ev-add-level")
      + table(["Level", "Amount", "Description", "", ""], levelRows, "No sponsorship levels yet.")
      + '<h3 style="margin:22px 0 8px;font-size:15px;">Sponsors</h3>'
      + (d.can_see_money ? addBar("Record sponsorship", "ev-add-sponsorship") : "")
      + table(["Sponsor", "Level", "Committed", "Paid", "Payment", "Benefits", ""], sponsorRows,
        d.can_see_money ? "No sponsorships recorded yet." : "Sponsorship amounts are not shown for your role.");

    document.getElementById("ev-add-level").addEventListener("click", function () { levelModal(null); });
    wireRowButtons(el, "edit-level", function (id) { levelModal(levels.filter(function (l) { return l.id === id; })[0]); });
    var addS = document.getElementById("ev-add-sponsorship");
    if (addS) addS.addEventListener("click", function () { sponsorshipModal(null); });
    wireRowButtons(el, "edit-sponsorship", function (id) {
      sponsorshipModal((d.sponsorships || []).filter(function (s) { return s.id === id; })[0]);
    });
  }

  function levelModal(existing) {
    var v = existing || {};
    formModal(existing ? "Edit sponsorship level" : "Add sponsorship level",
      field("Level name", "l-name", v.name, { full: true })
      + field("Amount", "l-amount", v.amount, { type: "number", step: "0.01" })
      + field("Display order", "l-order", v.display_order == null ? 0 : v.display_order, { type: "number" })
      + field("Description", "l-desc", v.description, { type: "textarea", full: true })
      + field("Benefits", "l-benefits", v.benefits, { type: "textarea", full: true })
      + field("Active", "l-active", existing ? !!v.active : true, { type: "checkbox" }),
      function (close) {
        var payload = {
          name: (get("l-name") || "").trim(), amount: get("l-amount"),
          display_order: get("l-order"), description: get("l-desc"),
          benefits: get("l-benefits"), active: get("l-active"),
        };
        if (!payload.name) throw new Error("The level needs a name.");
        var url = "/api/events/" + STATE.eventId + "/sponsorship-levels" + (existing ? "/" + existing.id : "");
        return api(url, { method: existing ? "PATCH" : "POST", body: payload })
          .then(function () { close(); return refresh(); });
      });
  }

  function sponsorshipModal(existing) {
    var v = existing || {}, d = STATE.data;
    var levelOpts = '<option value="">— none —</option>' + (d.sponsorship_levels || []).map(function (l) {
      return '<option value="' + l.id + '"' + (String(v.sponsorship_level_id || "") === String(l.id) ? " selected" : "") + '>' + esc(l.name) + '</option>';
    }).join("");
    formModal(existing ? "Edit sponsorship" : "Record sponsorship",
      '<div class="field"><label>Prospect</label><select id="s-prospect">' + prospectOptions(d, v.prospect_id) + '</select></div>'
      + field("Sponsor name (if not a prospect)", "s-name", v.sponsor_name)
      + '<div class="field"><label>Level</label><select id="s-level">' + levelOpts + '</select></div>'
      + field("Custom level name", "s-custom", v.custom_sponsorship_name)
      + field("Amount committed", "s-committed", v.amount_committed, { type: "number", step: "0.01" })
      + field("Amount paid", "s-paid", v.amount_paid, { type: "number", step: "0.01" })
      + field("Payment status", "s-pay", v.payment_status || "NOT_INVOICED", { type: "select", options: (STATE.vocab || {}).payment_statuses || [] })
      + field("Date committed", "s-date", v.date_committed, { type: "date" })
      + field("Logo received", "s-logo", v.logo_received, { type: "checkbox" })
      + field("Banner placement", "s-banner", v.banner_placement, { type: "checkbox" })
      + field("Flyer placement", "s-flyer", v.flyer_placement, { type: "checkbox" })
      + field("Social media recognition", "s-social", v.social_media_recognition, { type: "checkbox" })
      + field("Vendor booth included", "s-booth", v.vendor_booth_included, { type: "checkbox" })
      + field("Notes", "s-notes", v.notes, { type: "textarea", full: true }),
      function (close) {
        var payload = {
          prospect_id: get("s-prospect") || null, sponsor_name: get("s-name"),
          sponsorship_level_id: get("s-level") || null, custom_sponsorship_name: get("s-custom"),
          amount_committed: get("s-committed"), amount_paid: get("s-paid"),
          payment_status: get("s-pay"), date_committed: get("s-date"),
          logo_received: get("s-logo"), banner_placement: get("s-banner"), flyer_placement: get("s-flyer"),
          social_media_recognition: get("s-social"), vendor_booth_included: get("s-booth"), notes: get("s-notes"),
        };
        var url = "/api/events/" + STATE.eventId + "/sponsorships" + (existing ? "/" + existing.id : "");
        return api(url, { method: existing ? "PATCH" : "POST", body: payload })
          .then(function () { close(); return refresh(); });
      }, { width: 720 });
  }

  function renderDonations(el, d) {
    var rows = (d.donations || []).map(function (x) {
      return tr([
        td('<strong>' + esc(x.donor_name || "—") + '</strong>'),
        td(esc(x.item_or_service) + (x.quantity ? ' <span style="color:var(--text-muted);">×' + esc(x.quantity) + '</span>' : "")),
        td(val(x.donation_category)),
        td(d.can_see_money
          ? (x.estimated_value == null
            ? '<span style="color:#92400e;" title="Nobody has valued this yet. It is not counted as zero.">Not valued</span>'
            : money(x.estimated_value))
          : "—"),
        td(x.received ? pill("Received", "ok") : pill("Promised", "warn")),
        td(x.thank_you_sent ? pill("Thanked", "ok") : (x.received ? pill("Needs thanks", "warn") : "—")),
        td('<button class="btn small secondary" data-edit-donation="' + x.id + '">Edit</button>'),
      ]);
    });
    el.innerHTML = addBar("Record donation", "ev-add-donation")
      + table(["Donor", "Item or service", "Category", "Est. value", "Status", "Thank-you", ""], rows,
        "No in-kind donations recorded yet.")
      + '<p style="font-size:12.5px;color:var(--text-muted);margin-top:10px;max-width:760px;">'
      + 'These are in-kind donations — goods and services. An estimated value is somebody\'s estimate and is '
      + 'reported separately from cash sponsorship, never added to it.</p>';
    document.getElementById("ev-add-donation").addEventListener("click", function () { donationModal(null); });
    wireRowButtons(el, "edit-donation", function (id) {
      donationModal((d.donations || []).filter(function (x) { return x.id === id; })[0]);
    });
  }

  function donationModal(existing) {
    var v = existing || {}, d = STATE.data;
    var cats = ((STATE.vocab || {}).donation_categories || []);
    formModal(existing ? "Edit donation" : "Record in-kind donation",
      '<div class="field"><label>Prospect</label><select id="dn-prospect">' + prospectOptions(d, v.prospect_id) + '</select></div>'
      + field("Donor name (if not a prospect)", "dn-donor", v.donor_name)
      + field("Item or service", "dn-item", v.item_or_service, { full: true })
      + '<div class="field"><label>Category</label><select id="dn-cat"><option value="">— none —</option>'
      + cats.map(function (c) { return '<option' + (v.donation_category === c ? " selected" : "") + '>' + esc(c) + '</option>'; }).join("")
      + '</select></div>'
      + field("Quantity", "dn-qty", v.quantity)
      + (d.can_see_money ? field("Estimated value", "dn-value", v.estimated_value, { type: "number", step: "0.01", placeholder: "Leave blank if not valued" }) : "")
      + field("Date promised", "dn-promised", v.date_promised, { type: "date" })
      + field("Received", "dn-received", v.received, { type: "checkbox" })
      + field("Thank-you sent", "dn-thanks", v.thank_you_sent, { type: "checkbox" })
      + field("Delivery / pickup notes", "dn-delivery", v.delivery_or_pickup_notes, { type: "textarea", full: true })
      + field("Notes", "dn-notes", v.notes, { type: "textarea", full: true }),
      function (close) {
        var payload = {
          prospect_id: get("dn-prospect") || null, donor_name: get("dn-donor"),
          item_or_service: (get("dn-item") || "").trim(), donation_category: get("dn-cat"),
          quantity: get("dn-qty"), date_promised: get("dn-promised"),
          received: get("dn-received"), thank_you_sent: get("dn-thanks"),
          delivery_or_pickup_notes: get("dn-delivery"), notes: get("dn-notes"),
        };
        if (d.can_see_money) payload.estimated_value = get("dn-value");
        if (!payload.item_or_service) throw new Error("A donation needs a description of what was given.");
        var url = "/api/events/" + STATE.eventId + "/donations" + (existing ? "/" + existing.id : "");
        return api(url, { method: existing ? "PATCH" : "POST", body: payload })
          .then(function () { close(); return refresh(); });
      }, { width: 720 });
  }

  function renderVendors(el, d) {
    var ev = d.event || {};
    var open = ev.vendor_applications_open === true;
    var link = window.location.origin + "/vendor-signup/" + (ev.slug || "");
    // The public form is closed until somebody opens it, and the panel says
    // which it is -- an open public write endpoint should never be a surprise.
    var signup =
      '<div class="card" style="margin-bottom:14px;">'
      + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
      + '<div style="font-weight:700;font-size:14px;">Public vendor sign-up</div>'
      + (open ? pill("Open", "ok") : pill("Closed", "grey")) + '</div>'
      + '<div style="font-size:12px;color:var(--text-muted);margin:6px 0 10px;">'
      + (open
        ? 'Anyone with this link can apply. Applications arrive as <strong>Application received</strong> '
          + 'for you to review — applying does not confirm a booth.'
        : 'Closed. Nobody can apply until you open it.')
      + '</div>'
      + (open
        ? '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
          + '<input type="text" id="v-signup-link" readonly value="' + esc(link) + '" '
          + 'style="flex:1;min-width:260px;font-size:12.5px;" />'
          + '<a class="btn small secondary" href="' + esc(link) + '" target="_blank" rel="noopener">Open</a></div>'
        : "")
      + '<div class="form-grid" style="margin-top:10px;">'
      + field("Intro shown on the form (optional)", "v-signup-intro", ev.vendor_application_intro,
          { type: "textarea", full: true, rows: 2 })
      + '</div>'
      + '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
      + '<button class="btn small' + (open ? " secondary" : "") + '" id="v-signup-toggle">'
      + (open ? "Close sign-ups" : "Open sign-ups") + '</button>'
      + '<button class="btn small secondary" id="v-signup-save-intro">Save intro</button>'
      + '<span id="v-signup-msg" style="font-size:12.5px;color:var(--text-muted);"></span></div></div>';
    renderVendorsInner(el, d, signup);
  }

  function renderVendorsInner(el, d, signupHtml) {
    var rows = (d.vendors || []).map(function (v) {
      var needs = [];
      if (v.electricity_needed) needs.push("power");
      if (v.table_needed) needs.push("table");
      if (v.chairs_needed) needs.push(v.chairs_needed + " chairs");
      return tr([
        td('<strong>' + esc(v.vendor_name || "—") + '</strong>'
          + (v.source === "public" ? ' ' + pill("Applied", "none") : "")
          + (v.vendor_type ? '<div style="font-size:11.5px;color:var(--text-muted);">' + esc(v.vendor_type) + '</div>' : "")),
        td(val(v.contact_name) + (v.contact_email ? '<div style="font-size:11.5px;color:var(--text-muted);">' + esc(v.contact_email) + '</div>' : "")),
        td(val(v.booth_size)),
        td(needs.length ? esc(needs.join(", ")) : "—"),
        td(v.insurance_required ? (v.insurance_received ? pill("Insured", "ok") : pill("Insurance due", "warn")) : "—"),
        td(pill(human(v.status), statusTone(v.status))),
        td('<button class="btn small secondary" data-edit-vendor="' + v.id + '">Edit</button>'),
      ]);
    });
    el.innerHTML = (signupHtml || "") + addBar("Add vendor", "ev-add-vendor")
      + table(["Vendor", "Contact", "Booth", "Needs", "Insurance", "Status", ""], rows,
        "No vendors yet.");
    var toggle = document.getElementById("v-signup-toggle");
    if (toggle) toggle.addEventListener("click", function () {
      var nowOpen = (d.event || {}).vendor_applications_open === true;
      if (!nowOpen && !confirm("Open public vendor sign-ups?\n\nAnyone with the link will be able to apply. "
        + "Applications arrive for you to review — nobody confirms their own booth.")) return;
      api("/api/events/" + STATE.eventId, { method: "PATCH",
        body: { vendor_applications_open: !nowOpen } }).then(refresh);
    });
    var saveIntro = document.getElementById("v-signup-save-intro");
    if (saveIntro) saveIntro.addEventListener("click", function () {
      var m = document.getElementById("v-signup-msg");
      m.textContent = "Saving…";
      api("/api/events/" + STATE.eventId, { method: "PATCH",
        body: { vendor_application_intro: get("v-signup-intro") } })
        .then(function () { m.textContent = "Saved."; return refresh(); })
        .catch(function (e) { m.textContent = "Could not save: " + e.message; });
    });
    document.getElementById("ev-add-vendor").addEventListener("click", function () { vendorModal(null); });
    wireRowButtons(el, "edit-vendor", function (id) {
      vendorModal((d.vendors || []).filter(function (v) { return v.id === id; })[0]);
    });
  }

  function vendorModal(existing) {
    var v = existing || {}, d = STATE.data;
    formModal(existing ? "Edit vendor" : "Add vendor",
      '<div class="field"><label>Prospect</label><select id="v-prospect">' + prospectOptions(d, v.prospect_id) + '</select></div>'
      + field("Vendor name (if not a prospect)", "v-name", v.vendor_name)
      + field("Vendor type", "v-type", v.vendor_type)
      + field("Products / services", "v-products", v.products_services, { type: "textarea", full: true })
      + field("Contact name", "v-cname", v.contact_name)
      + field("Contact email", "v-cemail", v.contact_email, { type: "email" })
      + field("Contact phone", "v-cphone", v.contact_phone)
      + field("Booth size", "v-booth", v.booth_size)
      + field("Chairs needed", "v-chairs", v.chairs_needed, { type: "number" })
      + field("Status", "v-status", v.status || "INVITED", { type: "select", options: (STATE.vocab || {}).vendor_statuses || [] })
      + field("Electricity needed", "v-power", v.electricity_needed, { type: "checkbox" })
      + field("Table needed", "v-table", v.table_needed, { type: "checkbox" })
      + field("Insurance required", "v-insreq", v.insurance_required, { type: "checkbox" })
      + field("Insurance received", "v-insrec", v.insurance_received, { type: "checkbox" })
      + field("Arrival instructions sent", "v-arrival", v.arrival_instructions_sent, { type: "checkbox" })
      + field("Final confirmation sent", "v-final", v.final_confirmation_sent, { type: "checkbox" })
      + field("Special requirements", "v-special", v.special_requirements, { type: "textarea", full: true })
      + field("Notes", "v-notes", v.notes, { type: "textarea", full: true }),
      function (close) {
        var payload = {
          prospect_id: get("v-prospect") || null, vendor_name: get("v-name"), vendor_type: get("v-type"),
          products_services: get("v-products"), contact_name: get("v-cname"), contact_email: get("v-cemail"),
          contact_phone: get("v-cphone"), booth_size: get("v-booth"), chairs_needed: get("v-chairs"),
          status: get("v-status"), electricity_needed: get("v-power"), table_needed: get("v-table"),
          insurance_required: get("v-insreq"), insurance_received: get("v-insrec"),
          arrival_instructions_sent: get("v-arrival"), final_confirmation_sent: get("v-final"),
          special_requirements: get("v-special"), notes: get("v-notes"),
        };
        var url = "/api/events/" + STATE.eventId + "/vendors" + (existing ? "/" + existing.id : "");
        return api(url, { method: existing ? "PATCH" : "POST", body: payload })
          .then(function () { close(); return refresh(); });
      }, { width: 720 });
  }

  function renderPartners(el, d) {
    var rows = (d.community_partners || []).map(function (p) {
      var helps = [];
      if (p.post_social_media) helps.push("social");
      if (p.email_families) helps.push("email families");
      if (p.display_flyers) helps.push("display flyers");
      if (p.distribute_flyers) helps.push("hand out flyers");
      if (p.share_registration_link) helps.push("share link");
      if (p.newsletter_feature) helps.push("newsletter");
      return tr([
        td('<strong>' + esc(p.organization_name || "—") + '</strong>'),
        td(val(p.contact_name) + (p.contact_email ? '<div style="font-size:11.5px;color:var(--text-muted);">' + esc(p.contact_email) + '</div>' : "")),
        td(helps.length ? esc(helps.join(", ")) : '<span style="color:var(--text-muted);">Nothing agreed yet</span>'),
        td(pill(human(p.status), statusTone(p.status))),
        td('<button class="btn small secondary" data-edit-partner="' + p.id + '">Edit</button>'),
      ]);
    });
    el.innerHTML = addBar("Add community partner", "ev-add-partner")
      + table(["Organisation", "Contact", "Will help with", "Status", ""], rows,
        "No community partners yet. These are organisations that help promote the event without paying to sponsor it.");
    document.getElementById("ev-add-partner").addEventListener("click", function () { partnerModal(null); });
    wireRowButtons(el, "edit-partner", function (id) {
      partnerModal((d.community_partners || []).filter(function (p) { return p.id === id; })[0]);
    });
  }

  function partnerModal(existing) {
    var v = existing || {}, d = STATE.data;
    formModal(existing ? "Edit community partner" : "Add community partner",
      '<div class="field"><label>Prospect</label><select id="cp-prospect">' + prospectOptions(d, v.prospect_id) + '</select></div>'
      + field("Organisation name (if not a prospect)", "cp-name", v.organization_name)
      + field("Contact name", "cp-cname", v.contact_name)
      + field("Contact email", "cp-cemail", v.contact_email, { type: "email" })
      + field("Contact phone", "cp-cphone", v.contact_phone)
      + field("Status", "cp-status", v.status || "PROSPECT", { type: "select", options: (STATE.vocab || {}).partner_statuses || [] })
      + field("Post on social media", "cp-social", v.post_social_media, { type: "checkbox" })
      + field("Email their families", "cp-email", v.email_families, { type: "checkbox" })
      + field("Display flyers", "cp-display", v.display_flyers, { type: "checkbox" })
      + field("Hand out flyers", "cp-distribute", v.distribute_flyers, { type: "checkbox" })
      + field("Share registration link", "cp-link", v.share_registration_link, { type: "checkbox" })
      + field("Newsletter feature", "cp-news", v.newsletter_feature, { type: "checkbox" })
      + field("Other commitment", "cp-other", v.other_commitment, { type: "textarea", full: true })
      + field("Notes", "cp-notes", v.notes, { type: "textarea", full: true }),
      function (close) {
        var payload = {
          prospect_id: get("cp-prospect") || null, organization_name: get("cp-name"),
          contact_name: get("cp-cname"), contact_email: get("cp-cemail"), contact_phone: get("cp-cphone"),
          status: get("cp-status"), post_social_media: get("cp-social"), email_families: get("cp-email"),
          display_flyers: get("cp-display"), distribute_flyers: get("cp-distribute"),
          share_registration_link: get("cp-link"), newsletter_feature: get("cp-news"),
          other_commitment: get("cp-other"), notes: get("cp-notes"),
        };
        var url = "/api/events/" + STATE.eventId + "/community-partners" + (existing ? "/" + existing.id : "");
        return api(url, { method: existing ? "PATCH" : "POST", body: payload })
          .then(function () { close(); return refresh(); });
      }, { width: 720 });
  }

  // ---------------------------------------------------------- outreach
  //
  // The screen for the one feature here that emails people who never asked to
  // hear from us. It is built around the review queue: drafts are generated in
  // bulk, and each one is read and approved by a person before anything can
  // reach an inbox. Nothing on this screen sends an unapproved message.
  function renderOutreach(el, d) {
    el.innerHTML = '<div class="empty-state">Loading…</div>';
    Promise.all([
      api("/api/events/outreach/settings"),
      api("/api/events/" + STATE.eventId + "/outreach/templates"),
      api("/api/events/" + STATE.eventId + "/outreach/messages"),
    ]).then(function (r) {
      var cfg = r[0], templates = r[1].templates || [], q = r[2];
      var problems = q.problems || [];
      var counts = q.counts || {};

      // Said at the top, in words, before anything else. Somebody arriving here
      // should know immediately whether this thing can send.
      var banner = problems.length
        ? '<div style="background:#fffbeb;border:1px solid #fde68a;border-left:4px solid ' + VIZ.warn + ';border-radius:10px;padding:12px 14px;margin-bottom:14px;">'
          + '<strong style="color:#92400e;">Nothing can send yet.</strong>'
          + '<ul style="margin:6px 0 0;padding-left:20px;color:#92400e;font-size:13px;">'
          + problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join("") + '</ul></div>'
        : '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-left:4px solid ' + VIZ.good + ';border-radius:10px;padding:11px 14px;margin-bottom:14px;font-size:13px;color:#166534;">'
          + '<strong>Sending is on.</strong> ' + (q.sent_today || 0) + ' of ' + (cfg.settings.daily_limit || 0)
          + ' sent today · ' + (q.within_hours ? 'inside' : '<strong>outside</strong>') + ' the sending window ('
          + (cfg.settings.send_hour_start) + ':00–' + (cfg.settings.send_hour_end) + ':00)</div>';

      var s = cfg.settings || {};
      var settingsHtml =
        '<div class="card" style="margin-bottom:16px;">'
        + '<div style="font-weight:700;font-size:14px;margin-bottom:2px;">Sending controls</div>'
        + '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">'
        + 'These apply to <strong>every</strong> event. A daily limit is about the reputation of the '
        + 'sending domain, so two events do not get one each.</div>'
        + '<div class="form-grid">'
        + field("Sending switched on", "o-enabled", !!s.enabled, { type: "checkbox" })
        + field("Daily send limit", "o-daily", s.daily_limit, { type: "number" })
        + field("Batch size (per pass)", "o-batch", s.batch_size, { type: "number" })
        + field("Send from hour", "o-hstart", s.send_hour_start, { type: "number" })
        + field("Send until hour", "o-hend", s.send_hour_end, { type: "number" })
        + field("Maximum follow-ups", "o-maxfu", s.max_follow_ups, { type: "number" })
        + field("Organisation name", "o-org", s.org_name, { placeholder: "Spectrum Squad" })
        + field("Reply-to address", "o-replyto", s.reply_to, { type: "email" })
        + field("Postal address (required by law in commercial email)", "o-postal", s.postal_address,
            { full: true, placeholder: "Street, city, state, ZIP" })
        + '</div>'
        + '<div style="margin-top:10px;display:flex;gap:10px;align-items:center;">'
        + '<button class="btn small" id="o-save-settings">Save controls</button>'
        + '<span id="o-settings-msg" style="font-size:12.5px;color:var(--text-muted);"></span></div></div>';

      var tmplRows = templates.map(function (t) {
        return tr([
          td('<strong>' + esc(t.name) + '</strong>'),
          td(t.step === 1 ? "First approach" : "Follow-up " + (t.step - 1)),
          td(esc(t.subject)),
          td(t.active ? pill("Active", "ok") : pill("Inactive", "grey")),
          td('<button class="btn small secondary" data-draft-tmpl="' + t.id + '">Generate drafts</button>'
            + ' <button class="btn small secondary" data-edit-tmpl="' + t.id + '">Edit</button>'),
        ]);
      });

      var msgs = q.messages || [];
      var msgRows = msgs.slice(0, 100).map(function (m) {
        var tone = { draft: "warn", approved: "none", sent: "ok", cancelled: "grey", failed: "bad", skipped: "grey" }[m.status] || "grey";
        return tr([
          td('<div style="font-size:12.5px;">' + esc(m.to_email) + '</div>'
            + '<div style="font-size:11.5px;color:var(--text-muted);">' + (m.step === 1 ? "First approach" : "Follow-up " + (m.step - 1)) + '</div>'),
          td('<div style="font-size:12.5px;">' + esc(m.subject) + '</div>'),
          td(pill(human(m.status), tone)
            + (m.skipped_reason ? '<div style="font-size:11px;color:var(--text-muted);margin-top:3px;">' + esc(m.skipped_reason) + '</div>' : "")
            + (m.failed_reason ? '<div style="font-size:11px;color:#b91c1c;margin-top:3px;">' + esc(m.failed_reason) + '</div>' : "")),
          td(m.approved_by ? '<div style="font-size:11.5px;color:var(--text-muted);">' + esc(m.approved_by) + '</div>' : "—"),
          td('<button class="btn small secondary" data-view-msg="' + m.id + '">Read</button>'
            + (m.status === "draft" ? ' <button class="btn small" data-approve-msg="' + m.id + '">Approve</button>' : "")
            + (m.status === "draft" || m.status === "approved"
              ? ' <button class="btn small secondary" data-cancel-msg="' + m.id + '" style="color:#b91c1c;">Cancel</button>' : "")),
        ]);
      });

      el.innerHTML = banner + settingsHtml
        + '<h3 style="margin:0 0 8px;font-size:15px;">Templates</h3>'
        + '<p style="font-size:12.5px;color:var(--text-muted);margin:0 0 10px;">'
        + 'Merge fields: {{business_name}}, {{contact_name}}, {{event_name}}, {{event_date}}, {{venue_name}}, {{registration_url}}. '
        + 'The opt-out link and postal address are added automatically — do not paste them in.</p>'
        + addBar("Add template", "o-add-tmpl")
        + table(["Template", "Step", "Subject", "", ""], tmplRows, "No templates yet.")
        + '<div class="card" style="margin:18px 0 4px;">'
        + '<div style="font-weight:700;font-size:14px;margin-bottom:2px;">Follow-ups</div>'
        + '<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">'
        + 'Runs daily. It writes <strong>drafts</strong> into the review queue below and cannot send \u2014 '
        + 'you still read and approve each one. A business that replied, unsubscribed, or has already had '
        + 'the maximum number of follow-ups is left alone.</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">'
        + '<button class="btn small secondary" id="o-fu-preview">See what is due</button>'
        + '<button class="btn small secondary" id="o-fu-run">Draft due follow-ups now</button>'
        + '<span id="o-fu-msg" style="font-size:12.5px;color:var(--text-muted);"></span></div>'
        + '<div id="o-fu-detail" style="margin-top:10px;"></div></div>'
        + '<h3 style="margin:22px 0 4px;font-size:15px;">Review queue</h3>'
        + '<p style="font-size:12.5px;color:var(--text-muted);margin:0 0 10px;">'
        + '<strong>Nothing sends until a person approves it.</strong> '
        + (counts.draft || 0) + ' awaiting review · ' + (counts.approved || 0) + ' approved and queued · '
        + (counts.sent || 0) + ' sent · ' + (counts.skipped || 0) + ' skipped · ' + (counts.cancelled || 0) + ' cancelled</p>'
        + '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">'
        + '<button class="btn small" id="o-send-pass"' + (problems.length ? " disabled" : "") + '>Send approved now</button>'
        + '<span id="o-send-msg" style="font-size:12.5px;color:var(--text-muted);align-self:center;"></span></div>'
        + table(["To", "Subject", "Status", "Approved by", ""], msgRows, "Nothing queued yet.");

      // ---- wiring
      document.getElementById("o-save-settings").addEventListener("click", function () {
        var msg = document.getElementById("o-settings-msg");
        msg.textContent = "Saving…";
        api("/api/events/outreach/settings", { method: "PUT", body: {
          enabled: get("o-enabled"), daily_limit: get("o-daily"), batch_size: get("o-batch"),
          send_hour_start: get("o-hstart"), send_hour_end: get("o-hend"), max_follow_ups: get("o-maxfu"),
          org_name: get("o-org"), reply_to: get("o-replyto"), postal_address: get("o-postal"),
        } }).then(function () { renderOutreach(el, d); })
          .catch(function (e) { msg.textContent = "Could not save: " + e.message; });
      });
      document.getElementById("o-add-tmpl").addEventListener("click", function () { templateModal(null, el, d); });
      wireRowButtons(el, "edit-tmpl", function (id) {
        templateModal(templates.filter(function (t) { return t.id === id; })[0], el, d);
      });
      wireRowButtons(el, "draft-tmpl", function (id) {
        if (!confirm("Generate draft emails for this event's prospects?\n\nThey are DRAFTS — nothing is sent until you approve each one.")) return;
        api("/api/events/" + STATE.eventId + "/outreach/draft", { method: "POST", body: { template_id: id } })
          .then(function (r) {
            alert(r.created + " draft(s) created, " + r.skipped + " skipped."
              + (r.skipped ? "\n\nSkipped:\n" + (r.skipped_detail || []).slice(0, 12)
                  .map(function (x) { return "• " + x.business_name + " — " + x.reason; }).join("\n") : ""));
            renderOutreach(el, d);
          }).catch(function (e) { alert("Could not generate drafts: " + e.message); });
      });
      wireRowButtons(el, "view-msg", function (id) {
        var m = msgs.filter(function (x) { return x.id === id; })[0];
        if (!m) return;
        formModal("To " + m.to_email,
          '<div class="field full"><label>Subject</label><div style="font-weight:600;">' + esc(m.subject) + '</div></div>'
          + '<div class="field full"><label>Body</label>'
          + '<div style="border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:12px;max-height:340px;overflow:auto;background:#fff;">'
          + m.body + '</div></div>'
          + '<div class="field full"><div style="font-size:12px;color:var(--text-muted);">'
          + 'An unsubscribe link and the postal address are added automatically when this sends.</div></div>',
          function (close) { close(); }, { width: 720, saveLabel: "Close" });
      });
      wireRowButtons(el, "approve-msg", function (id) {
        api("/api/events/" + STATE.eventId + "/outreach/messages/" + id + "/approve", { method: "POST", body: {} })
          .then(function () { renderOutreach(el, d); });
      });
      wireRowButtons(el, "cancel-msg", function (id) {
        api("/api/events/" + STATE.eventId + "/outreach/messages/" + id + "/cancel", { method: "POST", body: {} })
          .then(function () { renderOutreach(el, d); });
      });
      document.getElementById("o-fu-preview").addEventListener("click", function () {
        var box = document.getElementById("o-fu-detail");
        box.innerHTML = '<div style="font-size:12.5px;color:var(--text-muted);">Checking\u2026</div>';
        api("/api/events/" + STATE.eventId + "/outreach/follow-ups").then(function (r) {
          var due = r.due || [], sk = r.skipped || [];
          // Everyone left out is listed with the reason. "Why didn't the bakery
          // get one?" is the question this panel exists to answer.
          box.innerHTML =
            '<div style="font-size:13px;margin-bottom:6px;"><strong>' + due.length + '</strong> due now'
            + (due.length ? ': ' + due.map(function (x) {
                return esc(x.business_name || "\u2014") + ' (follow-up ' + (x.step - 1) + ')';
              }).join(", ") : "") + '</div>'
            + (sk.length
              ? '<details style="font-size:12.5px;color:var(--text-muted);"><summary>'
                + sk.length + ' not due, and why</summary><ul style="margin:6px 0 0;padding-left:20px;">'
                + sk.slice(0, 60).map(function (x) {
                    return '<li>' + esc(x.business_name || ("#" + x.prospect_id)) + ' \u2014 ' + esc(x.reason) + '</li>';
                  }).join("") + '</ul></details>'
              : "");
        }).catch(function (e) { box.innerHTML = '<div style="color:#b91c1c;font-size:12.5px;">' + esc(e.message) + '</div>'; });
      });
      document.getElementById("o-fu-run").addEventListener("click", function () {
        if (!confirm("Draft the follow-ups that are due?\n\nThey are DRAFTS \u2014 nothing is sent until you approve each one.")) return;
        var fm = document.getElementById("o-fu-msg");
        fm.textContent = "Working\u2026";
        api("/api/events/" + STATE.eventId + "/outreach/follow-ups", { method: "POST", body: {} })
          .then(function (r) {
            alert(r.drafted + " follow-up draft(s) created. Nothing has been sent \u2014 they are waiting in the review queue.");
            renderOutreach(el, d);
          }).catch(function (e) { fm.textContent = "Could not run: " + e.message; });
      });

      var sendBtn = document.getElementById("o-send-pass");
      if (sendBtn) sendBtn.addEventListener("click", function () {
        if (!confirm("Send the approved messages now?\n\nThis emails real businesses. "
          + "Only messages you have approved will go, up to the batch size and the daily limit.")) return;
        var msg = document.getElementById("o-send-msg");
        msg.textContent = "Sending…";
        api("/api/events/" + STATE.eventId + "/outreach/send", { method: "POST", body: {} })
          .then(function (r) {
            alert("Sent " + r.sent + ", failed " + r.failed + ", held " + r.held + "."
              + ((r.held_detail || []).length ? "\n\nHeld:\n" + r.held_detail.slice(0, 12)
                  .map(function (h) { return "• " + h.reason; }).join("\n") : ""));
            renderOutreach(el, d);
          }).catch(function (e) { msg.textContent = "Could not send: " + e.message; });
      });
    }).catch(function (e) {
      el.innerHTML = '<div class="empty-state">Could not load outreach: ' + esc(e.message) + '</div>';
    });
  }

  function templateModal(existing, el, d) {
    var v = existing || {};
    formModal(existing ? "Edit template" : "Add template",
      field("Template name", "t-name", v.name, { full: true })
      + field("Step (1 = first approach)", "t-step", v.step == null ? 1 : v.step, { type: "number" })
      + field("Days after previous step", "t-delay", v.delay_days == null ? 7 : v.delay_days, { type: "number" })
      + field("Subject", "t-subject", v.subject, { full: true })
      + field("Body (HTML)", "t-body", v.body, { type: "textarea", full: true, rows: 10 })
      + field("Active", "t-active", existing ? !!v.active : true, { type: "checkbox" }),
      function (close) {
        var payload = {
          name: (get("t-name") || "").trim(), step: get("t-step"), delay_days: get("t-delay"),
          subject: (get("t-subject") || "").trim(), body: (get("t-body") || "").trim(), active: get("t-active"),
        };
        if (!payload.name || !payload.subject || !payload.body) {
          throw new Error("A template needs a name, a subject and a body.");
        }
        var url = "/api/events/" + STATE.eventId + "/outreach/templates" + (existing ? "/" + existing.id : "");
        return api(url, { method: existing ? "PATCH" : "POST", body: payload })
          .then(function () { close(); renderOutreach(el, d); });
      }, { width: 760 });
  }

  function renderSettings(el, d) {
    var ev = d.event;
    el.innerHTML = '<div class="form-grid">'
      + field("Event name", "e-name", ev.name, { full: true })
      + field("Description", "e-desc", ev.description, { type: "textarea", full: true, rows: 4 })
      + field("Date", "e-date", ev.event_date, { type: "date" })
      + field("Start time", "e-start", ev.start_time, { type: "time" })
      + field("End time", "e-end", ev.end_time, { type: "time" })
      + field("Venue", "e-venue", ev.venue_name)
      + field("Address", "e-address", ev.address)
      + field("City", "e-city", ev.city)
      + field("State", "e-state", ev.state)
      + field("ZIP", "e-zip", ev.zip)
      + field("Registration URL", "e-regurl", ev.registration_url, { full: true, placeholder: "e.g. the Eventbrite link" })
      + field("Public contact email", "e-pemail", ev.public_contact_email, { type: "email" })
      + field("Public contact phone", "e-pphone", ev.public_contact_phone)
      + field("Registration goal", "e-goalreg", ev.registration_goal, { type: "number" })
      + field("Attendance goal", "e-goalatt", ev.attendance_goal, { type: "number" })
      + (d.can_see_money ? field("Sponsorship goal", "e-goalspon", ev.sponsorship_goal, { type: "number", step: "0.01" }) : "")
      + field("Vendor goal", "e-goalven", ev.vendor_goal, { type: "number" })
      + field("Status", "e-status", ev.status, { type: "select", options: (STATE.vocab || {}).event_statuses || [] })
      + '</div>'
      + '<div style="margin-top:14px;display:flex;gap:10px;align-items:center;">'
      + '<button class="btn" id="e-save">Save event</button>'
      + '<span id="e-status-msg" style="font-size:12.5px;color:var(--text-muted);"></span></div>'
      + '<div style="margin-top:22px;padding-top:14px;border-top:1px solid var(--border,#e5e7eb);">'
      + '<div style="font-size:12.5px;color:var(--text-muted);margin-bottom:8px;">'
      + 'Unset fields are left blank rather than filled with a guess. '
      + '<strong>' + needed(ev.venue_name ? "venue set" : "") + '</strong> venue · '
      + '<strong>' + needed(ev.event_date ? "date set" : "") + '</strong> date</div>'
      + (d.can_delete
        ? '<button class="btn secondary small" id="e-delete" style="color:#b91c1c;">Delete this event</button>'
        : "") + '</div>';

    document.getElementById("e-save").addEventListener("click", function () {
      var payload = {
        name: (get("e-name") || "").trim(), description: get("e-desc"), event_date: get("e-date"),
        start_time: get("e-start"), end_time: get("e-end"), venue_name: get("e-venue"),
        address: get("e-address"), city: get("e-city"), state: get("e-state"), zip: get("e-zip"),
        registration_url: get("e-regurl"), public_contact_email: get("e-pemail"),
        public_contact_phone: get("e-pphone"), registration_goal: get("e-goalreg"),
        attendance_goal: get("e-goalatt"), vendor_goal: get("e-goalven"), status: get("e-status"),
      };
      if (d.can_see_money) payload.sponsorship_goal = get("e-goalspon");
      var msg = document.getElementById("e-status-msg");
      msg.textContent = "Saving…";
      api("/api/events/" + STATE.eventId, { method: "PATCH", body: payload })
        .then(function () { msg.textContent = "Saved."; return refresh(); })
        .catch(function (e) { msg.textContent = "Could not save: " + e.message; });
    });
    var del = document.getElementById("e-delete");
    if (del) del.addEventListener("click", function () {
      var t = d.totals || {};
      if (!confirm('Delete "' + ev.name + '"?\n\nThis also removes '
        + (t.prospects_total || 0) + ' prospect(s), ' + (t.sponsorship_count || 0) + ' sponsorship(s), '
        + (t.in_kind_count || 0) + ' donation(s), ' + (t.vendors_total || 0) + ' vendor(s) and '
        + (t.partners_total || 0) + ' community partner(s).\n\nThis cannot be undone.')) return;
      api("/api/events/" + STATE.eventId, { method: "DELETE" })
        .then(function () { STATE.view = "list"; STATE.tab = "overview"; load(); });
    });
  }

  function load() {
    MOUNT.innerHTML = '<div class="empty-state">Loading…</div>';
    return api("/api/events/vocab")
      .then(function (v) { STATE.vocab = v; return api("/api/events"); })
      .then(renderList)
      .catch(function (e) {
        MOUNT.innerHTML = '<div class="empty-state">Could not load events: ' + esc(e.message) + '</div>';
      });
  }

  window.__renderEvents = function (mount) {
    MOUNT = mount;
    if (STATE.view === "detail" && STATE.eventId) {
      return api("/api/events/vocab")
        .then(function (v) { STATE.vocab = v; return refresh(); })
        .catch(function () { STATE.view = "list"; return load(); });
    }
    return load();
  };
})();
