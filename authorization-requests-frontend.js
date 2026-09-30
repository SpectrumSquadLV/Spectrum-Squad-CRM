// authorization-requests-frontend.js -- the Authorization Request, in the BCBA area.
//
// THE COLLAPSED CARD IS THE FEATURE. A BCBA opening this page has one
// question -- where is this, and what is waiting on me -- and it is answered
// without scrolling and without clicking: payer, type, the tracker, the one
// sentence that says what is holding it up, how many documents are ready, and
// the projected start. Everything else is behind View Details.
//
// The tracker is not decoration. Node state comes from the server, which
// derives it from the documents and the signature, so the dominoes cannot say
// "ready" while a requirement is missing.
(function () {
  "use strict";

  // ○ not started · ◐ in progress · ✓ complete · ! action needed · … waiting · ✕ denied
  var NODE = {
    not_started:   { glyph: "○", cls: "ns",   title: "Not started" },
    in_progress:   { glyph: "◐", cls: "ip",   title: "In progress" },
    complete:      { glyph: "✓", cls: "done", title: "Complete" },
    action_needed: { glyph: "!", cls: "act",  title: "Action needed" },
    waiting:       { glyph: "…", cls: "wait", title: "Waiting" },
    denied:        { glyph: "✕", cls: "den",  title: "Denied" },
  };
  var DOC_STATE = {
    ready: { glyph: "✓", cls: "ok", label: "Ready" },
    missing: { glyph: "!", cls: "act", label: "Missing" },
    awaiting_parent_signature: { glyph: "…", cls: "wait", label: "Parent Signature" },
  };

  var mountEl = null, state = { requests: [], open: {}, docTypes: [], types: [], config: null };

  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  // Status keys and action names are snake_case on the wire; this is the one
  // place they are turned into something a person reads.
  function human(s) { return String(s == null ? "" : s).replace(/_/g, " "); }
  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "That did not work.");
        return j;
      });
    });
  }
  var MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  function shortDate(iso) {
    var p = String(iso || "").slice(0, 10).split("-");
    return p.length === 3 ? MON[+p[1] - 1] + " " + (+p[2]) : "—";
  }
  function longDate(iso) {
    var p = String(iso || "").slice(0, 10).split("-");
    return p.length === 3 ? MON[+p[1] - 1] + " " + (+p[2]) + ", " + p[0] : "—";
  }

  function styles() {
    if (document.getElementById("ar-styles")) return;
    var st = document.createElement("style");
    st.id = "ar-styles";
    st.textContent = [
      ".ar{padding:20px;max-width:1100px;box-sizing:border-box}",
      ".ar *,.ar *::before,.ar *::after{box-sizing:border-box}",
      ".ar-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}",
      ".ar-h1{font-size:20px;font-weight:800;color:#1b2a6b;margin:0;letter-spacing:-.2px}",
      ".ar-sub{font-size:12.5px;color:#767488;margin:2px 0 0}",
      ".ar-cta{background:#1b2a6b;color:#fff;border:0;border-radius:999px;padding:10px 18px;font:inherit;",
      "  font-size:13px;font-weight:700;cursor:pointer}",
      ".ar-cta:hover{background:#16225a}",
      ".ar-card{background:#fff;border:1px solid #e6e1d4;border-radius:14px;margin-bottom:12px;overflow:hidden}",
      ".ar-top{padding:14px 16px}",
      ".ar-eyebrow{font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8b8798;margin-bottom:9px}",
      ".ar-eyebrow b{color:#1b2a6b}",
      /* --- the dominoes --------------------------------------------------
         A row of nodes joined by connectors. The connector before a completed
         node is filled, so the eye reads a line that stops where the work
         has. */
      ".ar-track{display:flex;align-items:center;gap:0;flex-wrap:wrap;margin:2px 0 10px}",
      ".ar-node{display:flex;align-items:center;gap:6px;flex:0 0 auto}",
      ".ar-dot{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;",
      "  font-weight:800;border:2px solid #ddd9cb;background:#fff;color:#b9b6c9;flex:0 0 auto;transition:transform .15s}",
      ".ar-node:hover .ar-dot{transform:scale(1.12)}",
      ".ar-dot.done{background:#16a34a;border-color:#16a34a;color:#fff}",
      ".ar-dot.ip{background:#fff;border-color:#2c4bb8;color:#2c4bb8}",
      ".ar-dot.act{background:#dc2626;border-color:#dc2626;color:#fff}",
      ".ar-dot.wait{background:#fef3c7;border-color:#e0a430;color:#8a5a00;font-size:11px}",
      ".ar-dot.den{background:#7f1d1d;border-color:#7f1d1d;color:#fff}",
      ".ar-nl{font-size:11px;font-weight:700;color:#5b5878;white-space:nowrap}",
      ".ar-node.is-ns .ar-nl{color:#b9b6c9}",
      ".ar-link{flex:1 1 18px;min-width:14px;height:3px;border-radius:2px;background:#ece8dd;margin:0 7px}",
      ".ar-link.on{background:#16a34a}",
      ".ar-say{font-size:13px;font-weight:700;color:#1b2a6b;display:flex;align-items:center;gap:7px}",
      ".ar-say .g{font-size:14px}",
      ".ar-meta{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-top:10px}",
      ".ar-prog{flex:1 1 200px;min-width:160px}",
      ".ar-bar{height:8px;background:#eeecf6;border-radius:999px;overflow:hidden;margin-top:5px}",
      ".ar-bar i{display:block;height:100%;background:#2c4bb8;border-radius:999px;transition:width .4s}",
      ".ar-bar i.full{background:#16a34a}",
      ".ar-ct{font-size:11.5px;color:#767488}",
      ".ar-start{text-align:right;flex:0 0 auto}",
      ".ar-start .k{font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#8b8798}",
      ".ar-start .v{font-size:20px;font-weight:800;color:#1b2a6b;line-height:1.1;letter-spacing:-.3px}",
      ".ar-start .n{font-size:10.5px;color:#b45309}",
      ".ar-more{width:100%;background:#faf8f3;border:0;border-top:1px solid #f0ece2;padding:9px;",
      "  font:inherit;font-size:12px;font-weight:700;color:#2c4bb8;cursor:pointer;text-align:center}",
      ".ar-more:hover{background:#f4f0e6}",
      ".ar-body{border-top:1px solid #f0ece2;padding:14px 16px;background:#fdfcf9}",
      ".ar-sec{font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#8b8798;margin:14px 0 7px}",
      ".ar-sec:first-child{margin-top:0}",
      ".ar-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f2efe7;font-size:13px}",
      ".ar-row:last-child{border-bottom:0}",
      ".ar-g{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;font-size:11px;font-weight:800;flex:0 0 auto}",
      ".ar-g.ok{background:#e9f9ee;color:#166534}.ar-g.act{background:#fee2e2;color:#991b1b}.ar-g.wait{background:#fef3c7;color:#8a5a00}",
      ".ar-rn{flex:1 1 auto;min-width:0}",
      ".ar-rn b{display:block;color:#33324a}",
      ".ar-rn span{font-size:11.5px;color:#8b8798}",
      ".ar-btn{background:#fff;border:1px solid #e6e1d4;border-radius:8px;padding:5px 11px;font:inherit;",
      "  font-size:11.5px;font-weight:700;color:#1b2a6b;cursor:pointer;flex:0 0 auto}",
      ".ar-btn:hover{background:#f6f3ec}",
      ".ar-btn.go{background:#e0a430;border-color:#e0a430;color:#1b2a6b}",
      ".ar-btn.go:hover{background:#d0941f}",
      ".ar-ready{background:linear-gradient(180deg,#f2fbf5,#fff);border:1px solid #bfe6cd;border-radius:12px;",
      "  padding:14px 16px;margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      ".ar-ready .t{font-size:14px;font-weight:800;color:#166534;flex:1 1 auto}",
      ".ar-ready .t span{display:block;font-size:12px;font-weight:500;color:#3f7a54;margin-top:1px}",
      ".ar-tl{position:relative;padding-left:16px}",
      ".ar-tl::before{content:'';position:absolute;left:4px;top:4px;bottom:4px;width:2px;background:#ece8dd}",
      ".ar-ev{position:relative;padding:5px 0;font-size:12.5px;color:#33324a}",
      ".ar-ev::before{content:'';position:absolute;left:-15px;top:11px;width:8px;height:8px;border-radius:50%;background:#c9c2ae}",
      ".ar-ev.good::before{background:#16a34a}",
      ".ar-ev time{display:inline-block;min-width:62px;color:#8b8798;font-size:11.5px}",
      ".ar-empty{padding:34px 18px;text-align:center;color:#767488;font-size:13px;background:#fff;",
      "  border:1px dashed #ddd9cb;border-radius:14px}",
      ".ar-back{position:fixed;inset:0;background:rgba(20,20,30,.4);z-index:90;display:flex;",
      "  align-items:flex-start;justify-content:center;padding:28px 14px;overflow-y:auto}",
      ".ar-modal{background:#fff;border-radius:16px;width:min(560px,100%);padding:20px}",
      ".ar-modal h2{font-size:16px;color:#1b2a6b;margin:0 0 3px}",
      ".ar-modal .lede{font-size:12.5px;color:#767488;margin:0 0 14px}",
      ".ar-f{margin-bottom:12px}",
      ".ar-f label{display:block;font-size:11.5px;font-weight:700;color:#5b5878;margin-bottom:4px}",
      ".ar-f select,.ar-f input,.ar-f textarea{width:100%;padding:9px 11px;border:1px solid #e6e1d4;",
      "  border-radius:9px;font:inherit;font-size:13.5px;background:#fff}",
      ".ar-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      ".ar-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:6px;flex-wrap:wrap}",
      ".ar-err{background:#fee2e2;color:#991b1b;border-radius:9px;padding:9px 12px;font-size:12.5px;margin-bottom:10px}",
      ".ar-note{background:#fff8e6;border:1px solid #f3e0b0;border-radius:9px;padding:9px 12px;font-size:12px;color:#7a5a12;margin-bottom:10px}",
      "@media (max-width:640px){.ar{padding:13px}.ar-nl{display:none}.ar-link{margin:0 4px}",
      "  .ar-grid2{grid-template-columns:1fr}.ar-start{text-align:left}}",
      "@media (prefers-reduced-motion:no-preference){",
      "  .ar-ready{animation:ar-pop .3s ease-out both}",
      "  @keyframes ar-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}} }",
    ].join("\n");
    document.head.appendChild(st);
  }

  // ---- the tracker --------------------------------------------------------
  // The connector INTO a node is filled when that node is complete, so the
  // filled run always ends exactly where progress does.
  function trackerHtml(t) {
    var parts = [];
    t.nodes.forEach(function (n, i) {
      var s = NODE[n.state] || NODE.not_started;
      if (i) parts.push('<i class="ar-link' + (n.state === "complete" ? " on" : "") + '"></i>');
      parts.push(
        '<span class="ar-node' + (n.state === "not_started" ? " is-ns" : "") + '" title="' + esc(n.label + " — " + s.title) + '">' +
          '<span class="ar-dot ' + s.cls + '">' + s.glyph + "</span>" +
          '<span class="ar-nl">' + esc(n.label) + "</span>" +
        "</span>");
    });
    return '<div class="ar-track">' + parts.join("") + "</div>";
  }

  // The single sentence under the tracker. It is the NEXT ACTION, not a
  // restatement of the status: "Waiting on Parent Signature" tells a BCBA
  // what to chase, "Awaiting Parent Signature" only tells them what to read.
  function saying(r) {
    var s = r.status;
    if (s === "missing_documents") {
      var miss = r.documents.filter(function (d) { return !d.optional && d.status === "missing"; });
      return { g: "!", t: miss.length === 1
        ? "Needs " + miss[0].label
        : miss.length + " required documents missing" };
    }
    if (s === "awaiting_parent_signature") return { g: "…", t: "Waiting on Parent Signature" };
    if (s === "ready_to_submit") return { g: "✓", t: "Ready to submit" };
    if (s === "submitted" || s === "pending_payer") return { g: "…", t: "With " + (r.payer || "the payer") + " for review" };
    if (s === "info_requested") return { g: "!", t: "Payer asked for more information" };
    if (s === "approved") return { g: "✓", t: "Approved" + (r.authorization_number ? " · " + r.authorization_number : "") };
    if (s === "partially_approved") return { g: "✓", t: "Partially approved" };
    if (s === "denied") return { g: "✕", t: "Denied" };
    if (s === "expired") return { g: "✕", t: "Expired" };
    if (s === "cancelled") return { g: "✕", t: "Cancelled" };
    return { g: "○", t: "Draft" };
  }

  function cardHtml(r) {
    var t = r.tracker, say = saying(r), open = !!state.open[r.id];
    var p = r.projection || {};
    var done = t.percent >= 100;
    var showStart = r.request_type !== "assessment" || !!r.projection.projected_start_date;
    return '<div class="ar-card" data-req="' + r.id + '">' +
      '<div class="ar-top">' +
        '<div class="ar-eyebrow"><b>' + esc(r.payer || "No payer on file") + "</b> &bull; " + esc(r.request_type_label) +
          " &bull; " + esc(r.client_name || "") + "</div>" +
        trackerHtml(t) +
        '<div class="ar-say"><span class="g">' + say.g + "</span>" + esc(say.t) + "</div>" +
        '<div class="ar-meta">' +
          '<div class="ar-prog">' +
            '<div class="ar-ct">' + t.ready_count + " of " + t.required_count + " required documents ready</div>" +
            '<div class="ar-bar"><i class="' + (done ? "full" : "") + '" style="width:' + Math.max(0, Math.min(100, t.percent)) + '%"></i></div>' +
          "</div>" +
          (showStart ? '<div class="ar-start" title="' + esc(p.disclaimer || "") + '">' +
            '<div class="k">Projected Start</div>' +
            '<div class="v">' + esc(shortDate(p.projected_start_date)) + "</div>" +
            (p.waiting_on_parent ? '<div class="n">&#9888; may slip until signed</div>' : "") +
          "</div>" : "") +
        "</div>" +
      "</div>" +
      '<button class="ar-more" data-toggle="' + r.id + '">' + (open ? "Hide Details &#9650;" : "View Details &#9660;") + "</button>" +
      (open ? detailsHtml(r) : "") +
      // The card MUST be closed here. Without it the parser nests every
      // following card inside this one, and replacing a single card's
      // outerHTML on expand then takes every card below it with it.
      "</div>";
  }

  function detailsHtml(r) {
    var h = '<div class="ar-body">';

    if (r.status === "ready_to_submit") {
      h += '<div class="ar-ready"><span style="font-size:22px">&#127881;</span>' +
        '<span class="t">AUTHORIZATION READY<span>All required documents are complete.</span></span>' +
        '<button class="ar-btn go" data-review="' + r.id + '">Review &amp; Send</button></div>';
    }
    if (r.status === "submitted" || r.status === "pending_payer") {
      var sub = (r.submissions || [])[r.submissions.length - 1];
      h += '<div class="ar-ready" style="background:linear-gradient(180deg,#eef2fd,#fff);border-color:#c3d0f5">' +
        '<span style="font-size:20px">&#10003;</span><span class="t" style="color:#1b2a6b">AUTHORIZATION SUBMITTED' +
        "<span>" + (sub ? esc(longDate(sub.submitted_at)) + " &bull; " + sub.attachment_count + " attachments" : "") +
        (r.projection.projected_response_date ? " &bull; response by " + esc(longDate(r.projection.projected_response_date)) : "") +
        "</span></span></div>";
    }

    h += '<div class="ar-sec">Required documents</div>';
    r.documents.forEach(function (d) {
      var st = DOC_STATE[d.status] || DOC_STATE.missing;
      h += '<div class="ar-row">' +
        '<span class="ar-g ' + st.cls + '">' + st.glyph + "</span>" +
        '<span class="ar-rn"><b>' + esc(d.label) + (d.optional ? " <span>(optional)</span>" : "") + "</b>" +
          "<span>" + (d.document
            ? esc(d.document.label || d.document.filename) + (d.document.document_date ? " — " + esc(longDate(d.document.document_date)) : "") +
              (d.match_source === "filename" ? " &bull; matched by filename, confirm it" : "")
            : "Not found in this client's file") + "</span></span>" +
        (d.status === "awaiting_parent_signature"
          ? '<button class="ar-btn go" data-sign="' + r.id + '">Request Parent Signature</button>'
          : "") +
        '<button class="ar-btn" data-change="' + r.id + '|' + esc(d.requirement_key) + '">' +
          (d.document ? "Change" : "Select Existing") + "</button>" +
      "</div>";
    });

    if (r.signature) {
      var s = r.signature;
      h += '<div class="ar-sec">Parent signature</div>' +
        '<div class="ar-row"><span class="ar-rn">' +
          "<b>" + esc(s.parent_email || "Parent") + "</b><span>" +
          "Requested: " + esc(longDate(s.requested_at)) +
          (s.last_reminder_at ? " &bull; Last reminder: " + esc(longDate(s.last_reminder_at)) : "") +
          " &bull; Reminders sent: " + (s.reminders_sent || 0) +
          " &bull; Document viewed: " + (s.viewed_at ? "Yes" : "No") +
          " &bull; Status: " + (s.status === "signed"
            ? "&#10003; Signed " + esc(longDate(s.signed_at)) + (s.signed_name ? " by " + esc(s.signed_name) : "")
            : "&#8987; Waiting on Parent") +
          "</span></span>" +
          (s.status === "pending"
            ? '<button class="ar-btn" data-resend="' + r.id + '">Resend Now</button>' +
              '<button class="ar-btn" data-copy="' + esc(s.signing_url || "") + '">Copy Signing Link</button>'
            : "") +
        "</div>";
    }

    if ((r.info_requests || []).length) {
      h += '<div class="ar-sec">Payer requested more information</div>';
      r.info_requests.forEach(function (i) {
        h += '<div class="ar-row"><span class="ar-g act">!</span><span class="ar-rn"><b>' +
          esc(i.needed || "Additional information") + "</b><span>Requested " + esc(longDate(i.requested_at)) +
          (i.due_date ? " &bull; due " + esc(longDate(i.due_date)) : "") +
          (i.responded_at ? " &bull; sent " + esc(longDate(i.responded_at)) : "") + "</span></span>" +
          (i.responded_at ? "" : '<button class="ar-btn go" data-info-send="' + r.id + "|" + i.id + '">Send Additional Information</button>') +
        "</div>";
      });
    }

    if (r.status === "approved" || r.status === "partially_approved") {
      h += '<div class="ar-sec">Approval</div><div class="ar-row"><span class="ar-rn">' +
        "<b>" + esc(r.authorization_number || "No authorization number recorded") + "</b><span>" +
        [r.effective_start ? "Effective " + longDate(r.effective_start) : "",
         r.effective_end ? "to " + longDate(r.effective_end) : "",
         r.approved_units ? r.approved_units + " units" : "",
         r.approved_hours ? r.approved_hours + " hours" : "",
         r.frequency || "", r.approved_cpt_codes || ""].filter(Boolean).map(esc).join(" &bull; ") +
        "</span></span></div>";
    }

    h += '<div class="ar-sec">Projected vs actual</div><div class="ar-row"><span class="ar-rn"><span>' +
      "Projected start " + esc(longDate(r.projection.projected_start_date)) +
      (r.actual_start_date ? " &bull; actual start " + esc(longDate(r.actual_start_date)) : "") +
      " &bull; " + esc(r.projection.estimate_note) +
      "<br/>" + esc(r.projection.disclaimer) + "</span></span></div>";

    h += '<div class="ar-sec">Activity</div><div class="ar-tl">';
    (r.events || []).forEach(function (e) {
      var good = /signed|submitted|matched|approved|ready/.test(e.action);
      // A bare "status changed" is not an audit trail. The row already stores
      // both sides of the move, so say which way it went.
      var detail = e.notes ? String(e.notes)
        : (e.new_status ? (e.prev_status ? human(e.prev_status) + " → " : "") + human(e.new_status) : "");
      h += '<div class="ar-ev' + (good ? " good" : "") + '"><time>' + esc(shortDate(e.at)) + "</time>" +
        esc(String(e.action).replace(/_/g, " ")) + (detail ? " — " + esc(detail) : "") + "</div>";
    });
    h += "</div>";

    h += '<div class="ar-acts" style="margin-top:14px">';
    if (!r.status_is_derived && r.status !== "approved" && r.status !== "denied") {
      h += '<button class="ar-btn" data-info="' + r.id + '">Payer wants more info</button>' +
           '<button class="ar-btn" data-outcome="' + r.id + '">Record payer decision</button>';
    }
    h += "</div></div>";
    return h;
  }

  // ---- modals -------------------------------------------------------------
  function modal(html) {
    var back = document.createElement("div");
    back.className = "ar-back";
    back.innerHTML = '<div class="ar-modal">' + html + "</div>";
    back.addEventListener("click", function (e) { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
    return back;
  }
  function fail(back, msg) {
    var box = back.querySelector(".ar-modal");
    var old = box.querySelector(".ar-err");
    if (old) old.remove();
    var d = document.createElement("div"); d.className = "ar-err"; d.textContent = msg;
    box.insertBefore(d, box.firstChild);
  }

  // §1. ONE question first, then the workflow is built from the answer. The
  // BCBA never navigates anywhere: the requirements for their client's payer
  // are fetched and shown in the same box.
  function openNew() {
    var back = modal(
      "<h2>Request Authorization</h2>" +
      '<p class="lede">What are you requesting?</p>' +
      '<div class="ar-f"><label for="ar-client">Client</label><select id="ar-client"><option value="">Loading…</option></select></div>' +
      '<div class="ar-f"><label for="ar-type">Request type</label><select id="ar-type">' +
        '<option value="">Choose…</option>' +
        state.types.map(function (t) { return '<option value="' + esc(t.key) + '">' + esc(t.label) + "</option>"; }).join("") +
      "</select></div>" +
      '<div id="ar-preview"></div>' +
      '<div class="ar-acts"><button class="ar-btn" data-x>Cancel</button>' +
        '<button class="ar-btn go" id="ar-create" disabled>Create Authorization Request</button></div>');
    back.querySelector("[data-x]").addEventListener("click", function () { back.remove(); });

    var sel = back.querySelector("#ar-client");
    api("/api/clients").then(function (d) {
      var list = (d.clients || d || []).filter(function (c) { return c && c.child_name; });
      sel.innerHTML = '<option value="">Choose a client…</option>' + list.map(function (c) {
        return '<option value="' + c.id + '">' + esc(c.child_name) + (c.insurance_provider ? " — " + esc(c.insurance_provider) : "") + "</option>";
      }).join("");
    }).catch(function () { sel.innerHTML = '<option value="">Could not load clients</option>'; });

    function preview() {
      var cid = sel.value, type = back.querySelector("#ar-type").value;
      var box = back.querySelector("#ar-preview");
      var btn = back.querySelector("#ar-create");
      if (!cid || !type) { box.innerHTML = ""; btn.disabled = true; return; }
      box.innerHTML = '<p class="lede">Checking this client’s file…</p>';
      api("/api/authorization-requests/preview?client_id=" + encodeURIComponent(cid) + "&request_type=" + encodeURIComponent(type))
        .then(function (d) {
          btn.disabled = false;
          var rq = d.requirements;
          var rows = d.items.map(function (i) {
            var c = i.candidates[0];
            return '<div class="ar-row"><span class="ar-g ' + (c ? "ok" : "act") + '">' + (c ? "&#10003;" : "!") + "</span>" +
              '<span class="ar-rn"><b>' + esc(i.label) + (i.optional ? " <span>(optional)</span>" : "") + "</b><span>" +
              (c ? "Found in client file — " + esc(c.label || c.filename) + (c.document_date ? " &bull; " + esc(longDate(c.document_date)) : "") +
                   (c.match_source === "filename" ? " &bull; matched by filename" : "")
                 : "Missing — you can add it after creating the request") +
              "</span></span></div>";
          }).join("");
          box.innerHTML =
            '<div class="ar-sec">' + esc(d.payer || "No payer on this client") + " requirements</div>" +
            (rq.configured === false ? '<div class="ar-note">This payer has no saved requirements yet, so the defaults for this request type are used. An administrator can configure it in Settings.</div>' : "") +
            (rows || '<p class="lede">This request type has no required documents configured.</p>') +
            (rq.parent_signature_required ? '<div class="ar-note">This payer requires a parent signature on the treatment plan. You will be able to request it from the card.</div>' : "");
        })
        .catch(function (e) { box.innerHTML = '<div class="ar-err">' + esc(e.message) + "</div>"; btn.disabled = true; });
    }
    sel.addEventListener("change", preview);
    back.querySelector("#ar-type").addEventListener("change", preview);

    back.querySelector("#ar-create").addEventListener("click", function () {
      var btn = this; btn.disabled = true; btn.textContent = "Creating…";
      api("/api/authorization-requests", { method: "POST", body: {
        client_id: Number(sel.value), request_type: back.querySelector("#ar-type").value } })
        .then(function (r) { back.remove(); state.open[r.id] = true; load(); })
        .catch(function (e) { btn.disabled = false; btn.textContent = "Create Authorization Request"; fail(back, e.message); });
    });
  }

  // §12. The whole package, before it leaves. Nothing is sent from a button
  // that did not first show exactly what it would send and to whom.
  function openReview(id) {
    var back = modal('<h2>Review &amp; Send</h2><p class="lede">Loading the package…</p>');
    api("/api/authorization-requests/" + id + "/review").then(function (d) {
      var box = back.querySelector(".ar-modal");
      var blocked = !d.email_configured || d.over_limit || (d.problems || []).length;
      box.innerHTML =
        "<h2>" + esc(d.request.payer || "Payer") + "</h2>" +
        '<p class="lede">' + esc(d.subject) + "</p>" +
        (!d.email_configured ? '<div class="ar-err">No Authorization Request email is configured. An owner or admin sets it in Settings.</div>' : "") +
        (d.over_limit ? '<div class="ar-err">These attachments total ' + (d.total_bytes / 1048576).toFixed(1) +
          "MB, over the " + Math.round(d.limit_bytes / 1048576) + "MB limit for one email. Send them through the secure document link instead.</div>" : "") +
        ((d.problems || []).length ? '<div class="ar-err">' + d.problems.map(esc).join("<br/>") + "</div>" : "") +
        (d.already_submitted ? '<div class="ar-note">This Authorization Request was already submitted on ' +
          esc(longDate(d.last_submitted_at)) + '. A reason is required to send it again.</div>' +
          '<div class="ar-f"><label for="ar-why">Reason for resubmission</label><input id="ar-why" type="text" placeholder="Why is this being sent again?" /></div>' : "") +
        '<div class="ar-sec">Client</div><div class="ar-row"><span class="ar-rn"><b>' +
          esc((d.client && d.client.child_name) || "") + "</b><span>" +
          [d.client && d.client.dob ? "DOB " + d.client.dob : "", d.request.member_id ? "Member " + d.request.member_id : "",
           d.request.requested_hours ? d.request.requested_hours : "", d.request.bcba_name || ""].filter(Boolean).map(esc).join(" &bull; ") +
          "</span></span></div>" +
        '<div class="ar-sec">Attachments (' + d.files.length + ")</div>" +
        d.files.map(function (f) {
          return '<div class="ar-row"><span class="ar-g ok">&#10003;</span><span class="ar-rn"><b>' +
            esc(f.filename) + "</b><span>" + esc(f.label) + " &bull; " + (f.bytes / 1024).toFixed(0) + "KB</span></span></div>";
        }).join("") +
        '<div class="ar-sec">Send to</div><div class="ar-row"><span class="ar-rn"><b>' +
          esc(d.to || "not configured") + "</b></span></div>" +
        '<div class="ar-acts"><button class="ar-btn" data-x>Cancel</button>' +
          '<button class="ar-btn go" id="ar-send"' + (blocked && !d.already_submitted ? " disabled" : "") + ">SEND AUTHORIZATION REQUEST</button></div>";
      box.querySelector("[data-x]").addEventListener("click", function () { back.remove(); });
      box.querySelector("#ar-send").addEventListener("click", function () {
        var btn = this; btn.disabled = true; btn.textContent = "Sending…";
        var why = box.querySelector("#ar-why");
        api("/api/authorization-requests/" + id + "/submit", { method: "POST",
          body: why ? { resubmission_reason: why.value } : {} })
          .then(function () { back.remove(); load(); })
          .catch(function (e) { btn.disabled = false; btn.textContent = "SEND AUTHORIZATION REQUEST"; fail(back, e.message); });
      });
    }).catch(function (e) { fail(back, e.message); });
  }

  function openChange(id, key) {
    var back = modal('<h2>Choose a document</h2><p class="lede">Looking in this client’s file…</p>');
    api("/api/authorization-requests/" + id + "/candidates?requirement_key=" + encodeURIComponent(key)).then(function (d) {
      var box = back.querySelector(".ar-modal");
      box.innerHTML = "<h2>Choose a document</h2>" +
        '<p class="lede">Newest first. The date each was given is shown so an old assessment is obvious.</p>' +
        (d.candidates.length ? d.candidates.map(function (c) {
          return '<div class="ar-row"><span class="ar-rn"><b>' + esc(c.label || c.filename) + "</b><span>" +
            (c.document_date ? esc(longDate(c.document_date)) : "no date recorded") +
            (c.match_source === "filename" ? " &bull; matched by filename" : " &bull; filed as " + esc(c.clinical_type || "")) +
            (c.has_file ? "" : " &bull; link, cannot be attached") + "</span></span>" +
            '<button class="ar-btn go" data-pick="' + c.id + '">Use this</button></div>';
        }).join("") : '<div class="ar-note">Nothing on this client’s record matches. Upload it on the client card and it will appear here.</div>') +
        '<div class="ar-acts"><button class="ar-btn" data-x>Close</button></div>';
      box.querySelector("[data-x]").addEventListener("click", function () { back.remove(); });
      box.querySelectorAll("[data-pick]").forEach(function (b) {
        b.addEventListener("click", function () {
          api("/api/authorization-requests/" + id + "/document", { method: "POST",
            body: { requirement_key: key, client_document_id: Number(b.dataset.pick) } })
            .then(function () { back.remove(); load(); })
            .catch(function (e) { fail(back, e.message); });
        });
      });
    }).catch(function (e) { fail(back, e.message); });
  }

  function openOutcome(id) {
    var back = modal("<h2>Record the payer's decision</h2>" +
      '<p class="lede">What the payer came back with. The projected dates stay on the record beside it.</p>' +
      '<div class="ar-f"><label for="o-st">Decision</label><select id="o-st">' +
        '<option value="approved">Approved</option><option value="partially_approved">Partially Approved</option>' +
        '<option value="denied">Denied</option><option value="pending_payer">Still pending</option>' +
        '<option value="expired">Expired</option><option value="cancelled">Cancelled</option></select></div>' +
      '<div id="o-appr">' +
        '<div class="ar-grid2"><div class="ar-f"><label>Authorization number</label><input id="o-num" type="text" /></div>' +
        '<div class="ar-f"><label>Approval date</label><input id="o-date" type="date" /></div></div>' +
        '<div class="ar-grid2"><div class="ar-f"><label>Effective start</label><input id="o-es" type="date" /></div>' +
        '<div class="ar-f"><label>Effective end</label><input id="o-ee" type="date" /></div></div>' +
        '<div class="ar-grid2"><div class="ar-f"><label>Approved CPT codes</label><input id="o-cpt" type="text" placeholder="97153, 97155" /></div>' +
        '<div class="ar-f"><label>Frequency</label><input id="o-freq" type="text" placeholder="20 hrs/week" /></div></div>' +
        '<div class="ar-grid2"><div class="ar-f"><label>Approved units</label><input id="o-units" type="text" /></div>' +
        '<div class="ar-f"><label>Approved hours</label><input id="o-hours" type="text" /></div></div>' +
        '<div class="ar-f"><label>Actual start date</label><input id="o-start" type="date" /></div>' +
      "</div>" +
      '<div class="ar-f"><label>Notes</label><textarea id="o-notes" rows="2"></textarea></div>' +
      '<div class="ar-acts"><button class="ar-btn" data-x>Cancel</button><button class="ar-btn go" id="o-save">Save</button></div>');
    back.querySelector("[data-x]").addEventListener("click", function () { back.remove(); });
    var st = back.querySelector("#o-st"), appr = back.querySelector("#o-appr");
    function sync() { appr.style.display = /approved/.test(st.value) ? "" : "none"; }
    st.addEventListener("change", sync); sync();
    back.querySelector("#o-save").addEventListener("click", function () {
      var v = function (id2) { var el = back.querySelector(id2); return el ? el.value : ""; };
      this.disabled = true;
      api("/api/authorization-requests/" + id + "/outcome", { method: "POST", body: {
        status: st.value, authorization_number: v("#o-num"), approval_date: v("#o-date"),
        effective_start: v("#o-es"), effective_end: v("#o-ee"), approved_cpt_codes: v("#o-cpt"),
        approved_units: v("#o-units"), approved_hours: v("#o-hours"), frequency: v("#o-freq"),
        actual_start_date: v("#o-start"), approval_notes: v("#o-notes"), outcome_reason: v("#o-notes") } })
        .then(function () { back.remove(); load(); })
        .catch(function (e) { fail(back, e.message); });
    });
  }

  function openInfo(id) {
    var back = modal("<h2>Payer asked for more information</h2>" +
      '<p class="lede">This stays on the same Authorization Request. A second request would split its history.</p>' +
      '<div class="ar-f"><label>What they need</label><textarea id="i-need" rows="2"></textarea></div>' +
      '<div class="ar-grid2"><div class="ar-f"><label>Requested by</label><input id="i-by" type="text" /></div>' +
      '<div class="ar-f"><label>Due date</label><input id="i-due" type="date" /></div></div>' +
      '<div class="ar-f"><label>Notes</label><textarea id="i-notes" rows="2"></textarea></div>' +
      '<div class="ar-acts"><button class="ar-btn" data-x>Cancel</button><button class="ar-btn go" id="i-save">Save</button></div>');
    back.querySelector("[data-x]").addEventListener("click", function () { back.remove(); });
    back.querySelector("#i-save").addEventListener("click", function () {
      this.disabled = true;
      api("/api/authorization-requests/" + id + "/info-request", { method: "POST", body: {
        needed: back.querySelector("#i-need").value, requested_by_payer: back.querySelector("#i-by").value,
        due_date: back.querySelector("#i-due").value, notes: back.querySelector("#i-notes").value } })
        .then(function () { back.remove(); load(); })
        .catch(function (e) { fail(back, e.message); });
    });
  }

  // ---- render + wire ------------------------------------------------------
  function render() {
    var rs = state.requests;
    mountEl.innerHTML =
      '<div class="ar">' +
        '<div class="ar-head"><div>' +
          '<h1 class="ar-h1">Authorization Request</h1>' +
          '<p class="ar-sub">Documents, parent signature, submission and payer review — one request, start to finish.</p>' +
        "</div>" +
        '<button class="ar-cta" id="ar-new">+ Request Authorization</button></div>' +
        (rs.length ? rs.map(cardHtml).join("")
          : '<div class="ar-empty"><strong>No Authorization Requests yet.</strong><br/>' +
            "Start one and the CRM will look through the client’s file for the documents the payer wants.</div>") +
      "</div>";
    wire();
  }

  // ROOT MATTERS. Expanding a card replaces only that card, so only that card
  // may be re-wired: running over the whole page again gives every OTHER card
  // a second click listener, and a second listener toggles the card straight
  // back shut. That is why this takes a root instead of always using mountEl.
  function wire(root) {
    var scope = root || mountEl;
    var q = function (sel, fn) {
      scope.querySelectorAll(sel).forEach(fn);
      if (scope !== mountEl && scope.matches && scope.matches(sel)) fn(scope);
    };
    if (scope === mountEl) {
      var nb = mountEl.querySelector("#ar-new");
      if (nb) nb.addEventListener("click", openNew);
    }
    q("[data-toggle]", function (b) {
      b.addEventListener("click", function () {
        var id = b.dataset.toggle;
        state.open[id] = !state.open[id];
        var r = state.requests.filter(function (x) { return String(x.id) === String(id); })[0];
        // Re-render only this card, so opening one does not scroll the page
        // out from under somebody reading another.
        var paint = function () {
          var card = mountEl.querySelector('[data-req="' + id + '"]');
          var row = state.requests.filter(function (x) { return String(x.id) === String(id); })[0];
          if (!row || !card) { render(); return; }
          var holder = document.createElement("div");
          holder.innerHTML = cardHtml(row);
          var fresh = holder.firstElementChild;
          card.replaceWith(fresh);
          wire(fresh);
        };
        paint();
        // The list is deliberately the cheap shape -- it carries no history,
        // because loading every request's events to draw a collapsed row would
        // be three extra queries per card. The detail is fetched the moment a
        // card is actually opened, so Activity shows the audit trail instead of
        // an empty panel. Fetched once; after that the row already has it.
        if (state.open[id] && r && !r.events) {
          api("/api/authorization-requests/" + id).then(function (full) {
            if (!full || !full.id) return;
            var i = state.requests.findIndex(function (x) { return String(x.id) === String(id); });
            if (i < 0) return;
            state.requests[i] = full;
            if (state.open[id]) paint();
          }).catch(function () {});
        }
      });
    });
    q("[data-review]", function (b) { b.addEventListener("click", function () { openReview(b.dataset.review); }); });
    q("[data-outcome]", function (b) { b.addEventListener("click", function () { openOutcome(b.dataset.outcome); }); });
    q("[data-info]", function (b) { b.addEventListener("click", function () { openInfo(b.dataset.info); }); });
    q("[data-change]", function (b) {
      b.addEventListener("click", function () {
        var p = b.dataset.change.split("|"); openChange(p[0], p[1]);
      });
    });
    q("[data-sign]", function (b) {
      b.addEventListener("click", function () {
        b.disabled = true; b.textContent = "Sending…";
        api("/api/authorization-requests/" + b.dataset.sign + "/request-signature", { method: "POST", body: {} })
          .then(function () { load(); })
          .catch(function (e) { b.disabled = false; b.textContent = "Request Parent Signature"; alert(e.message); });
      });
    });
    q("[data-resend]", function (b) {
      b.addEventListener("click", function () {
        b.disabled = true; b.textContent = "Sending…";
        api("/api/authorization-requests/" + b.dataset.resend + "/resend-signature", { method: "POST", body: {} })
          .then(function () { load(); })
          .catch(function (e) { b.disabled = false; b.textContent = "Resend Now"; alert(e.message); });
      });
    });
    q("[data-copy]", function (b) {
      b.addEventListener("click", function () {
        var url = b.dataset.copy;
        var done = function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy Signing Link"; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, function () { window.prompt("Signing link", url); });
        } else { window.prompt("Signing link", url); }
      });
    });
    q("[data-info-send]", function (b) {
      b.addEventListener("click", function () {
        var p = b.dataset.infoSend.split("|");
        openChangeForInfo(p[0], p[1]);
      });
    });
  }

  // Sending additional information reuses the client's own documents rather
  // than asking for another upload -- the same rule as the package itself.
  function openChangeForInfo(id, infoId) {
    var back = modal('<h2>Send additional information</h2><p class="lede">Loading this client’s documents…</p>');
    api("/api/authorization-requests/" + id).then(function (r) {
      return api("/api/clients/" + r.client_id).then(function (c) {
        var docs = (c.documents || []).filter(function (d) { return d.file_path; });
        var box = back.querySelector(".ar-modal");
        box.innerHTML = "<h2>Send additional information</h2>" +
          '<p class="lede">Attached to the same Authorization Request and sent to the configured address.</p>' +
          '<div class="ar-f"><label>Message (optional)</label><textarea id="ai-msg" rows="2"></textarea></div>' +
          '<div class="ar-sec">Choose documents</div>' +
          (docs.length ? docs.map(function (d) {
            return '<label class="ar-row" style="cursor:pointer"><input type="checkbox" value="' + d.id + '" class="ai-d" />' +
              '<span class="ar-rn"><b>' + esc(d.label || d.filename) + "</b></span></label>";
          }).join("") : '<div class="ar-note">This client has no stored documents to attach.</div>') +
          '<div class="ar-acts"><button class="ar-btn" data-x>Cancel</button>' +
          '<button class="ar-btn go" id="ai-send">Send Additional Information</button></div>';
        box.querySelector("[data-x]").addEventListener("click", function () { back.remove(); });
        box.querySelector("#ai-send").addEventListener("click", function () {
          var ids = [].slice.call(box.querySelectorAll(".ai-d:checked")).map(function (x) { return Number(x.value); });
          if (!ids.length) { fail(back, "Choose at least one document."); return; }
          this.disabled = true;
          api("/api/authorization-requests/" + id + "/info-response/" + infoId, { method: "POST",
            body: { document_ids: ids, message: box.querySelector("#ai-msg").value } })
            .then(function () { back.remove(); load(); })
            .catch(function (e) { fail(back, e.message); });
        });
      });
    }).catch(function (e) { fail(back, e.message); });
  }

  function load() {
    return api("/api/authorization-requests").then(function (d) {
      state.requests = d.requests || [];
      state.types = d.request_types || [];
      state.docTypes = d.doc_types || [];
      render();
    }).catch(function (e) {
      mountEl.innerHTML = '<div class="ar"><div class="ar-empty">Could not load Authorization Requests: ' + esc(e.message) + "</div></div>";
    });
  }

  window.__renderAuthorizationRequests = function (mount) {
    mountEl = mount;
    styles();
    mountEl.innerHTML = '<div class="ar"><div class="ar-empty">Loading…</div></div>';
    load();
  };
})();
