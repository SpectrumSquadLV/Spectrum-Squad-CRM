// academy-frontend.js -- the Onboarding Academy, inside the BCBA Hub.
//
// Mounted by the Hub rather than routed to, the same way Authorization
// Request is: window.__renderAcademy(host). The Hub owns the tab; this owns
// everything inside it.
//
// THREE AUDIENCES, ONE SCREEN. A new BCBA sees their own thirty days. A
// mentor sees their mentees. Clinical leadership sees everybody. Which one
// somebody gets is decided by what the server sends back, never by a role
// check in here -- the browser is not where that question is answered, and a
// screen that decides for itself would show the wrong thing the moment
// somebody's designation changed.
//
// WHAT THE SCREEN WILL NOT DO. There is no control anywhere in this file that
// completes a competency for the person doing it. The employee's buttons stop
// at "ready for review", because that is where their authority stops. Adding
// one here would not get past the server, but it would promise something the
// CRM then refuses, which is its own kind of broken.
(function () {
  "use strict";

  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  var HOST = null;
  var DATA = null;
  var VIEW = "me";          // me | roster
  var OPEN_WEEK = null;

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || "Something went wrong.");
        return d;
      });
    });
  }

  function injectStyles() {
    if (document.getElementById("academy-styles")) return;
    var st = document.createElement("style");
    st.id = "academy-styles";
    st.textContent = [
      ".ac-wrap{font-size:14px;}",
      ".ac-card{background:#fff;border:1px solid var(--border,#e5e7eb);border-radius:14px;padding:18px;margin-bottom:14px;}",
      ".ac-hero{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;align-items:flex-start;}",
      ".ac-big{font-size:34px;font-weight:800;color:var(--brand-navy,#1b2a6b);line-height:1;}",
      ".ac-sub{font-size:12.5px;color:var(--text-muted,#64748b);}",
      ".ac-bar{height:12px;border-radius:999px;background:#eef0f4;overflow:hidden;margin:12px 0 6px;}",
      ".ac-bar>div{height:100%;background:var(--brand-navy,#1b2a6b);transition:width .4s;}",
      ".ac-weeks{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:14px;}",
      ".ac-week{border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:12px;cursor:pointer;background:#fff;text-align:left;}",
      ".ac-week.on{border-color:var(--brand-navy,#1b2a6b);box-shadow:0 0 0 1px var(--brand-navy,#1b2a6b) inset;}",
      ".ac-week.done{background:#f0fdf4;border-color:#bbf7d0;}",
      ".ac-wk-n{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted,#64748b);}",
      ".ac-wk-t{font-weight:700;margin:2px 0 6px;font-size:13.5px;}",
      ".ac-item{display:flex;gap:11px;align-items:flex-start;padding:11px 0;border-top:1px solid var(--border,#eef0f4);}",
      ".ac-item:first-child{border-top:0;}",
      ".ac-pill{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:999px;white-space:nowrap;}",
      ".ac-not_started{background:#f1f5f9;color:#475569;}",
      ".ac-in_progress{background:#dbeafe;color:#1e40af;}",
      ".ac-awaiting_review{background:#fef3c7;color:#92400e;}",
      ".ac-completed{background:#dcfce7;color:#166534;}",
      ".ac-needs_training{background:#fee2e2;color:#991b1b;}",
      ".ac-comp{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:11px 13px;margin-top:4px;}",
      ".ac-note{font-size:12.5px;color:#92400e;margin-top:5px;}",
      ".ac-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}",
      ".ac-tab{background:none;border:0;border-bottom:2px solid transparent;padding:7px 2px;margin-right:16px;",
      "cursor:pointer;font-weight:600;color:var(--text-muted,#64748b);font-size:13.5px;}",
      ".ac-tab.on{color:var(--brand-navy,#1b2a6b);border-bottom-color:var(--brand-navy,#1b2a6b);}",
      ".ac-tbl{width:100%;border-collapse:collapse;font-size:13px;}",
      ".ac-tbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;",
      "color:var(--text-muted,#64748b);padding:7px 10px;}",
      ".ac-tbl td{padding:9px 10px;border-top:1px solid var(--border,#eef0f4);}",
      ".ac-mini{height:7px;border-radius:999px;background:#eef0f4;overflow:hidden;width:110px;}",
      ".ac-mini>div{height:100%;background:var(--brand-navy,#1b2a6b);}",
      "@media (max-width:640px){.ac-weeks{grid-template-columns:repeat(2,1fr);}}",
    ].join("\n");
    document.head.appendChild(st);
  }

  // ---- the employee's own thirty days -------------------------------------
  function heroHtml(d) {
    var p = d.progress;
    var e = d.enrollment;
    var week = Math.min(Math.ceil(p.day / 7), e.weeks || 4);
    return '<div class="ac-card"><div class="ac-hero">'
      + "<div><h2 style=\"margin:0 0 2px;\">Welcome to the Squad</h2>"
      + '<div class="ac-sub">' + esc(e.program_name) + " · started " + esc(e.start_date)
      + (e.state === "paused" ? ' · <strong style="color:#92400e;">paused</strong>' : "")
      + "</div></div>"
      + '<div style="text-align:right;"><div class="ac-big">' + p.percent + "%</div>"
      + '<div class="ac-sub">' + p.completed + " of " + p.total + " requirements</div></div>"
      + "</div>"
      + '<div class="ac-bar"><div style="width:' + p.percent + '%"></div></div>'
      + '<div class="ac-sub">Day ' + p.day + " · week " + week + " of " + (e.weeks || 4)
      + (e.due_date ? " · due " + esc(e.due_date) : "") + "</div>"
      + weeksHtml(p)
      + "</div>";
  }

  function weeksHtml(p) {
    return '<div class="ac-weeks">' + p.weeks.map(function (w) {
      var done = w.total > 0 && w.completed === w.total;
      var pct = w.total ? Math.round((w.completed / w.total) * 100) : 0;
      return '<button class="ac-week' + (OPEN_WEEK === w.week ? " on" : "") + (done ? " done" : "")
        + '" data-week="' + w.week + '">'
        + '<div class="ac-wk-n">Week ' + w.week + (done ? " · complete" : "") + "</div>"
        + '<div class="ac-wk-t">' + esc(w.title) + "</div>"
        + '<div class="ac-mini" style="width:100%;"><div style="width:' + pct + '%"></div></div>'
        + '<div class="ac-sub" style="margin-top:5px;">' + w.completed + "/" + w.total
        + (w.awaiting_review ? " · " + w.awaiting_review + " awaiting review" : "")
        + (w.needs_training ? ' · <span style="color:#991b1b;">' + w.needs_training + " to redo</span>" : "")
        + "</div></button>";
    }).join("") + "</div>";
  }

  function mentorHtml(d) {
    if (!d.mentor) {
      return '<div class="ac-card"><h3 style="margin:0 0 4px;font-size:15px;">My assigned mentor</h3>'
        + '<div class="ac-sub">No mentor has been assigned yet. Clinical leadership assigns one —'
        + " ask them if it has been a few days.</div></div>";
    }
    return '<div class="ac-card"><h3 style="margin:0 0 4px;font-size:15px;">My assigned mentor</h3>'
      + "<div><strong>" + esc(d.mentor.name) + "</strong>"
      + (d.mentor.role_title ? ' <span class="ac-sub">· ' + esc(d.mentor.role_title) + "</span>" : "") + "</div>"
      + (d.mentor.email ? '<div class="ac-sub"><a href="mailto:' + esc(d.mentor.email) + '">'
          + esc(d.mentor.email) + "</a></div>" : "")
      + '<div class="ac-sub" style="margin-top:7px;">Ask them anything. That is what they are for —'
      + " you are not expected to work systems out on your own.</div></div>";
  }

  function itemHtml(it, canReview) {
    var isComp = it.kind === "competency";
    var controls = "";
    if (it.status === "completed" && it.verified_by) {
      controls = '<span class="ac-sub">signed off by ' + esc(it.verified_by) + "</span>";
    } else if (isComp) {
      // THE EMPLOYEE'S BUTTONS STOP HERE. No "mark complete" exists for a
      // competency, because their authority does not extend to it.
      controls = it.status === "awaiting_review"
        ? '<span class="ac-sub">waiting on your supervisor</span>'
        : '<button class="btn small" data-ready="' + it.item_id + '">I\'m ready for review</button>';
    } else {
      controls = it.status === "completed"
        ? '<button class="btn small secondary" data-undo="' + it.item_id + '">Undo</button>'
        : '<button class="btn small" data-tick="' + it.item_id + '">Mark done</button>';
    }
    return '<div class="ac-item">'
      + '<div style="flex:1;min-width:0;">'
        + "<div" + (isComp ? ' style="font-weight:700;"' : "") + ">" + esc(it.title) + "</div>"
        + (it.detail ? '<div class="ac-comp">' + esc(it.detail) + "</div>" : "")
        + (it.reviewer_note && it.status === "needs_training"
            ? '<div class="ac-note"><strong>More training needed:</strong> ' + esc(it.reviewer_note) + "</div>" : "")
      + "</div>"
      + '<div style="text-align:right;display:flex;flex-direction:column;gap:6px;align-items:flex-end;">'
        + '<span class="ac-pill ac-' + esc(it.status) + '">' + esc(it.status_label) + "</span>"
        + controls
        + (canReview && it.status === "awaiting_review"
            ? '<button class="btn small" data-review="' + it.item_id + '">Review it</button>' : "")
      + "</div></div>";
  }

  function meHtml(d) {
    if (!d.enrolled) {
      return '<div class="ac-card"><div class="ac-sub">'
        + (d.reason === "no_employee_record"
            ? "This login is not linked to a staff record, so there is no onboarding to show."
            : "You are not currently enrolled in an onboarding programme.")
        + "</div></div>";
    }
    var p = d.progress;
    var week = OPEN_WEEK || Math.min(Math.ceil(p.day / 7), d.enrollment.weeks || 4);
    var inWeek = p.items.filter(function (i) { return Number(i.week) === Number(week); });
    var title = (p.weeks.find(function (w) { return w.week === week; }) || {}).title || ("Week " + week);
    return heroHtml(d)
      + mentorHtml(d)
      + '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">Week ' + week + " — " + esc(title) + "</h3>"
      + '<div class="ac-sub" style="margin-bottom:8px;">Tick each topic as you cover it. The competency at the'
      + " end is signed off by your mentor, not by you.</div>"
      + inWeek.map(function (i) { return itemHtml(i, false); }).join("")
      + "</div>";
  }

  // ---- the roster, for mentors and leadership -----------------------------
  function rosterHtml(list, canManage) {
    if (!list.length) {
      return '<div class="ac-card"><div class="ac-sub">Nobody is onboarding at the moment.</div></div>';
    }
    return '<div class="ac-card" style="overflow-x:auto;">'
      + '<table class="ac-tbl" style="min-width:720px;"><thead><tr>'
      + "<th>Who</th><th>Started</th><th>Day</th><th>Progress</th><th>Needs attention</th><th>Mentor</th>"
      + "</tr></thead><tbody>"
      + list.map(function (e) {
        return "<tr>"
          + '<td><strong>' + esc(e.name) + "</strong>"
            + (e.role_title ? '<div class="ac-sub">' + esc(e.role_title) + "</div>" : "") + "</td>"
          + "<td>" + esc(e.start_date) + (e.state !== "active"
              ? '<div class="ac-sub">' + esc(e.state) + "</div>" : "") + "</td>"
          + "<td>" + e.day + '<div class="ac-sub">week ' + e.current_week + "</div></td>"
          + '<td><div class="ac-mini"><div style="width:' + e.percent + '%"></div></div>'
            + '<div class="ac-sub">' + e.percent + "% · " + e.completed + "/" + e.total + "</div></td>"
          + "<td>"
            + (e.awaiting_review ? '<span class="ac-pill ac-awaiting_review">' + e.awaiting_review + " to review</span> " : "")
            + (e.needs_training ? '<span class="ac-pill ac-needs_training">' + e.needs_training + " redoing</span>" : "")
            + (!e.awaiting_review && !e.needs_training ? '<span class="ac-sub">—</span>' : "")
          + "</td>"
          + "<td>" + (e.mentor_name ? esc(e.mentor_name)
              : '<span class="ac-sub">none assigned</span>') + "</td>"
          + "</tr>";
      }).join("")
      + "</tbody></table></div>";
  }

  // ---- render -------------------------------------------------------------
  function render() {
    if (!HOST || !DATA) return;
    var showRoster = DATA.roster && (DATA.roster.enrollments || []).length >= 0
      && (DATA.roster.can_manage || (DATA.roster.enrollments || []).length > 0);
    var tabs = "";
    if (showRoster) {
      tabs = '<div style="margin-bottom:12px;">'
        + '<button class="ac-tab' + (VIEW === "me" ? " on" : "") + '" data-view="me">My training</button>'
        + '<button class="ac-tab' + (VIEW === "roster" ? " on" : "") + '" data-view="roster">'
        + (DATA.roster.can_manage ? "Everyone onboarding" : "My mentees") + "</button></div>";
    }
    var body = VIEW === "roster" && showRoster
      ? rosterHtml(DATA.roster.enrollments || [], DATA.roster.can_manage)
      : meHtml(DATA.me);
    HOST.innerHTML = '<div class="ac-wrap">' + tabs + body + "</div>";
    wire();
  }

  function wire() {
    HOST.querySelectorAll("[data-view]").forEach(function (b) {
      b.addEventListener("click", function () { VIEW = b.dataset.view; render(); });
    });
    HOST.querySelectorAll("[data-week]").forEach(function (b) {
      b.addEventListener("click", function () { OPEN_WEEK = Number(b.dataset.week); render(); });
    });
    var set = function (id, status) {
      api("/api/academy/items/" + id, { method: "POST", body: { status: status } })
        .then(function (d) { DATA.me.progress = d.progress; render(); })
        .catch(function (e) { alert(e.message); });
    };
    HOST.querySelectorAll("[data-tick]").forEach(function (b) {
      b.addEventListener("click", function () { set(b.dataset.tick, "completed"); });
    });
    HOST.querySelectorAll("[data-undo]").forEach(function (b) {
      b.addEventListener("click", function () { set(b.dataset.undo, "in_progress"); });
    });
    HOST.querySelectorAll("[data-ready]").forEach(function (b) {
      b.addEventListener("click", function () { set(b.dataset.ready, "awaiting_review"); });
    });
  }

  window.__renderAcademy = function (host) {
    injectStyles();
    HOST = host;
    host.innerHTML = '<div class="ac-wrap"><div class="ac-card"><div class="ac-sub">Loading the Academy…</div></div></div>';
    Promise.all([
      api("/api/academy/me").catch(function () { return { enrolled: false, reason: "error" }; }),
      // A 403 here is an answer, not a failure: it means this person is
      // neither a mentor nor leadership, and the roster simply does not
      // appear for them.
      api("/api/academy/enrollments").catch(function () { return null; }),
    ]).then(function (r) {
      DATA = { me: r[0], roster: r[1] };
      if (!DATA.me.enrolled && DATA.roster && (DATA.roster.enrollments || []).length) VIEW = "roster";
      render();
    });
  };
})();
