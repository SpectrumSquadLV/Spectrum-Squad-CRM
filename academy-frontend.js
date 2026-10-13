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
  var VIEW = "me";          // me | roster | review
  var OPEN_WEEK = null;
  var REVIEW = null;        // the loaded 30-day review, when VIEW === "review"
  var BACK_TO = "me";       // where Back goes: remembered, not guessed
  var CUR_PROG = null;      // the programme open in the curriculum editor
  // THE CURRICULUM READS, UNTIL SOMEBODY TURNS EDITING ON.
  //
  // Everybody who runs onboarding can see what the training asks of the
  // people they supervise. Only the practice owner can change it, and even
  // she has to switch editing on first -- a screen you read every week
  // should not have "Remove week" sitting under your cursor.
  var CUR_EDIT = false;

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
      ".ac-independent{background:#dcfce7;color:#166534;}",
      ".ac-needs_support{background:#fef3c7;color:#92400e;}",
      ".ac-not_demonstrated{background:#fee2e2;color:#991b1b;}",
      ".ac-unrated{background:#f1f5f9;color:#475569;}",
      ".ac-dom{padding:12px 0;border-top:1px solid var(--border,#eef0f4);}",
      ".ac-dom:first-child{border-top:0;}",
      ".ac-dom select,.ac-dom textarea,.ac-plan input,.ac-plan textarea{font:inherit;padding:7px 9px;",
      "border:1px solid var(--border,#e5e7eb);border-radius:8px;width:100%;box-sizing:border-box;}",
      ".ac-plan{background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px;margin-top:9px;}",
      ".ac-plan-on{background:#f8fafc;border:1px solid var(--border,#e5e7eb);border-radius:10px;",
      "padding:10px 12px;margin-top:8px;font-size:12.5px;}",
      ".ac-block{background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:12px;",
      "margin-bottom:10px;font-size:12.5px;color:#991b1b;}",
      ".ac-grid2{display:grid;grid-template-columns:1fr 1fr;gap:9px;}",
      ".ac-res{display:flex;gap:8px;align-items:baseline;padding:5px 0;font-size:13px;}",
      ".ac-res a{color:var(--brand-navy,#1b2a6b);}",
      ".ac-rk{font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted,#64748b);",
      "border:1px solid var(--border,#e5e7eb);border-radius:999px;padding:1px 7px;white-space:nowrap;}",
      ".ac-stat{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;}",
      ".ac-stat>div{border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:12px;}",
      ".ac-stat b{display:block;font-size:24px;font-weight:800;color:var(--brand-navy,#1b2a6b);line-height:1.1;}",
      ".ac-sealed{background:#f8fafc;border:1px dashed var(--border,#cbd5e1);border-radius:12px;padding:16px;}",
      ".ac-quote{border-left:3px solid var(--border,#e5e7eb);padding:4px 0 4px 11px;margin:9px 0;font-size:13px;}",
      ".ac-hrs input,.ac-hrs select{font:inherit;padding:7px 9px;border:1px solid var(--border,#e5e7eb);",
      "border-radius:8px;width:100%;box-sizing:border-box;}",
      ".ac-sv label{display:block;margin:10px 0 3px;font-size:13px;font-weight:600;}",
      ".ac-sv textarea{font:inherit;padding:7px 9px;border:1px solid var(--border,#e5e7eb);border-radius:8px;",
      "width:100%;box-sizing:border-box;}",
      ".ac-scale{display:flex;gap:6px;}",
      ".ac-scale button{flex:1;padding:8px 0;border:1px solid var(--border,#e5e7eb);background:#fff;",
      "border-radius:8px;cursor:pointer;font:inherit;}",
      ".ac-scale button.on{background:var(--brand-navy,#1b2a6b);color:#fff;border-color:var(--brand-navy,#1b2a6b);}",
      "@media (max-width:640px){.ac-weeks{grid-template-columns:repeat(2,1fr);}.ac-grid2{grid-template-columns:1fr;}}",
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

  // "I WASN'T TRAINED ON THIS" IS THE MOST PROMINENT CONTROL ON THE PAGE
  // after the progress bar, and it is worded as a statement about the
  // programme rather than an admission about the person. Somebody who has to
  // hunt for it, or who reads it as "report my own ignorance", does not press
  // it -- and the whole value of the feature is in the pressing.
  function helpHtml(d) {
    return '<div class="ac-card">'
      + '<div class="ac-row" style="justify-content:space-between;">'
        + "<div><h3 style=\"margin:0 0 2px;font-size:15px;\">Stuck on something?</h3>"
        + '<div class="ac-sub">Nobody expects you to work our systems out on your own.</div></div>'
        + '<div class="ac-row">'
          + '<button class="btn secondary" id="ac-ask">Ask my mentor</button>'
          + '<button class="btn" id="ac-gap" style="background:#b91c1c;">I wasn\'t trained on this</button>'
        + "</div>"
      + "</div>"
      + '<div id="ac-forms"></div>'
      + "</div>";
  }

  function askFormHtml() {
    return '<div style="margin-top:14px;border-top:1px solid var(--border,#eef0f4);padding-top:13px;">'
      + '<label style="font-size:12.5px;font-weight:600;">What do you need to know?</label>'
      + '<input id="ac-q-subject" placeholder="Where do I find…" style="width:100%;padding:9px 11px;'
      + 'border:1px solid var(--border,#e5e7eb);border-radius:9px;margin:5px 0 9px;" />'
      + '<textarea id="ac-q-body" rows="3" placeholder="Any detail that helps (optional)" '
      + 'style="width:100%;padding:9px 11px;border:1px solid var(--border,#e5e7eb);border-radius:9px;"></textarea>'
      + '<div class="ac-row" style="margin-top:9px;"><button class="btn" id="ac-q-send">Send to my mentor</button>'
      + '<span class="ac-sub">It waits for them. You are not interrupting a session.</span></div>'
      + '<div id="ac-q-msg" class="ac-sub" style="margin-top:7px;"></div></div>';
  }

  function gapFormHtml() {
    return '<div style="margin-top:14px;border-top:1px solid var(--border,#eef0f4);padding-top:13px;">'
      + '<div class="ac-sub" style="margin-bottom:9px;">This goes to your mentor and to clinical leadership.'
      + " It is treated as a gap in the training, not a mark against you.</div>"
      + '<label style="font-size:12.5px;font-weight:600;">Topic or procedure</label>'
      + '<input id="ac-g-topic" placeholder="Authorization unit tracking" style="width:100%;padding:9px 11px;'
      + 'border:1px solid var(--border,#e5e7eb);border-radius:9px;margin:5px 0 9px;" />'
      + '<label style="font-size:12.5px;font-weight:600;">What is missing?</label>'
      + '<textarea id="ac-g-desc" rows="3" style="width:100%;padding:9px 11px;'
      + 'border:1px solid var(--border,#e5e7eb);border-radius:9px;margin:5px 0 9px;"></textarea>'
      + '<div class="ac-row">'
        + '<label style="font-size:12.5px;">How urgent?<br><select id="ac-g-urg" style="padding:8px 10px;'
        + 'border:1px solid var(--border,#e5e7eb);border-radius:9px;margin-top:4px;">'
        + '<option value="blocking">It is blocking me now</option>'
        + '<option value="soon" selected>I need it soon</option>'
        + '<option value="whenever">Whenever there is time</option></select></label>'
        + '<label style="font-size:12.5px;display:flex;align-items:center;gap:7px;margin-top:17px;">'
        + '<input type="checkbox" id="ac-g-now" style="width:auto;margin:0;" /> I need help right now</label>'
      + "</div>"
      + '<div class="ac-row" style="margin-top:11px;"><button class="btn" id="ac-g-send">Send it</button></div>'
      + '<div id="ac-g-msg" class="ac-sub" style="margin-top:7px;"></div></div>';
  }

  function checkinsHtml(list, canSign, isMine) {
    if (!list || !list.length) return "";
    var LABEL = { complete: "Complete", awaiting_supervisor: "Waiting on your supervisor",
                  awaiting_employee: "Waiting on you", due: "Due now", scheduled: "Scheduled" };
    return '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">Check-ins</h3>'
      + '<div class="ac-sub" style="margin-bottom:8px;">Day 7, 14, 21 and 30. Both of you fill one in —'
      + " it is a conversation, not a form.</div>"
      + list.map(function (c) {
        var open = c.state === "due" || c.state === "awaiting_employee";
        return '<div class="ac-item"><div style="flex:1;min-width:0;">'
          + "<div><strong>Day " + c.day + "</strong> "
            + '<span class="ac-sub">due ' + esc(c.due_date) + "</span></div>"
          + (c.learned ? '<div class="ac-sub" style="margin-top:4px;"><strong>Learned:</strong> '
              + esc(c.learned) + "</div>" : "")
          + (c.mentor_feedback ? '<div class="ac-sub" style="margin-top:3px;"><strong>Feedback:</strong> '
              + esc(c.mentor_feedback) + "</div>" : "")
          + (isMine && open
              ? '<div style="margin-top:8px;"><textarea data-ci-learned="' + c.day + '" rows="2" '
                + 'placeholder="What have you learned this week?" style="width:100%;padding:8px 10px;'
                + 'border:1px solid var(--border,#e5e7eb);border-radius:9px;"></textarea>'
                + '<textarea data-ci-unclear="' + c.day + '" rows="2" placeholder="What is still unclear?" '
                + 'style="width:100%;padding:8px 10px;border:1px solid var(--border,#e5e7eb);'
                + 'border-radius:9px;margin-top:6px;"></textarea>'
                + '<button class="btn small" data-ci-save="' + c.day + '" style="margin-top:7px;">Save my half</button></div>'
              : "")
          + (canSign && c.employee_done_at && !c.supervisor_done_at
              ? '<div style="margin-top:8px;"><textarea data-ci-fb="' + c.day + '" rows="2" '
                + 'placeholder="Your feedback" style="width:100%;padding:8px 10px;'
                + 'border:1px solid var(--border,#e5e7eb);border-radius:9px;"></textarea>'
                + '<button class="btn small" data-ci-sign="' + c.day + '" style="margin-top:7px;">Add my half</button></div>'
              : "")
          + "</div>"
          + '<div><span class="ac-pill ac-' + (c.state === "complete" ? "completed"
              : c.state === "scheduled" ? "not_started" : "awaiting_review") + '">'
            + esc(LABEL[c.state] || c.state) + "</span></div></div>";
      }).join("") + "</div>";
  }

  function threadsHtml(questions, gaps, canAnswer) {
    var qs = (questions || []).slice(0, 10);
    var gs = (gaps || []).slice(0, 10);
    if (!qs.length && !gs.length) return "";
    return '<div class="ac-card"><h3 style="margin:0 0 8px;font-size:15px;">Questions &amp; training gaps</h3>'
      + qs.map(function (q) {
        return '<div class="ac-item"><div style="flex:1;min-width:0;">'
          + "<div><strong>" + esc(q.subject) + "</strong>"
            + (q.asked_by ? ' <span class="ac-sub">· ' + esc(q.asked_by) + "</span>" : "") + "</div>"
          + (q.body ? '<div class="ac-sub">' + esc(q.body) + "</div>" : "")
          + (q.answer ? '<div class="ac-comp" style="margin-top:6px;">' + esc(q.answer)
              + '<div class="ac-sub" style="margin-top:4px;">— ' + esc(q.answered_by || "") + "</div></div>" : "")
          + (canAnswer && q.status === "open"
              ? '<div style="margin-top:7px;"><textarea data-ans="' + q.id + '" rows="2" '
                + 'placeholder="Answer it" style="width:100%;padding:8px 10px;'
                + 'border:1px solid var(--border,#e5e7eb);border-radius:9px;"></textarea>'
                + '<button class="btn small" data-ans-send="' + q.id + '" style="margin-top:6px;">Send answer</button></div>'
              : "")
          + '</div><div><span class="ac-pill ac-' + (q.status === "answered" ? "completed" : "awaiting_review")
          + '">' + (q.status === "answered" ? "Answered" : "Open") + "</span></div></div>";
      }).join("")
      + gs.map(function (g) {
        var S = { submitted: "Submitted", under_review: "Under Review",
                  training_scheduled: "Training Scheduled", resolved: "Resolved" };
        return '<div class="ac-item"><div style="flex:1;min-width:0;">'
          + '<div><strong>Not trained on:</strong> ' + esc(g.topic)
            + (g.raised_by ? ' <span class="ac-sub">· ' + esc(g.raised_by) + "</span>" : "") + "</div>"
          + (g.description ? '<div class="ac-sub">' + esc(g.description) + "</div>" : "")
          + (g.resolution ? '<div class="ac-comp" style="margin-top:6px;">' + esc(g.resolution) + "</div>" : "")
          + '</div><div><span class="ac-pill ac-' + (g.status === "resolved" ? "completed"
              : g.status === "submitted" ? "needs_training" : "awaiting_review") + '">'
          + esc(S[g.status] || g.status) + "</span></div></div>";
      }).join("")
      + "</div>";
  }

  // ---- training material --------------------------------------------------
  var RES_LABEL = { document: "SOP", video: "Video", link: "Link", note: "Note" };
  function resourcesHtml(list) {
    if (!list || !list.length) return "";
    return '<div style="margin-top:7px;">' + list.map(function (r) {
      var label = '<span class="ac-rk">' + esc(RES_LABEL[r.kind] || r.kind) + "</span>";
      if (r.kind === "note") {
        return '<div class="ac-res">' + label + "<span>" + esc(r.title) + " — " + esc(r.body || "") + "</span></div>";
      }
      // rel=noopener because these are links somebody else pasted, and
      // target=_blank without it hands the new page a handle on this one.
      return '<div class="ac-res">' + label + '<a href="' + esc(r.href || "#")
        + '" target="_blank" rel="noopener noreferrer">' + esc(r.title) + "</a></div>";
    }).join("") + "</div>";
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
        + resourcesHtml(it.resources)
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
      + helpHtml(d)
      + '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">Week ' + week + " — " + esc(title) + "</h3>"
      + '<div class="ac-sub" style="margin-bottom:8px;">Tick each topic as you cover it. The competency at the'
      + " end is signed off by your mentor, not by you.</div>"
      // THE WEEK'S OWN MATERIAL. Attached to the week rather than to one
      // item -- the ten-minute video that covers the whole week -- and
      // rendered here because the first version of this put it in the data
      // and nowhere on the page, which is the same as not having it.
      + resourcesHtml(((p.weeks || []).filter(function (w) { return Number(w.week) === Number(week); })[0] || {}).resources)
      + inWeek.map(function (i) { return itemHtml(i, false); }).join("")
      + "</div>"
      + checkinsHtml(DATA.checkins, false, true)
      + '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">Your 30-day review</h3>'
      + '<div class="ac-sub" style="margin-bottom:9px;">At the end of the thirty days your mentor rates ten areas of'
      + " the job and your Clinical Director signs it off. You will see all of it, and talk it through, once it is"
      + " signed — not while it is being written.</div>"
      + '<button class="btn small" data-rv-open="' + d.enrollment.id + '" data-rv-who="you">Open it</button></div>'
      + hoursHtml(d)
      + surveyHtml()
      + threadsHtml(DATA.questions, DATA.gaps, false);
  }

  // ---- THE THIRTY-DAY REVIEW ----------------------------------------------
  //
  // Ten domains, three ratings, and deliberately no total. There is no score
  // anywhere on this panel because the moment a number appears, the question
  // stops being "is this person operating independently" and becomes "are we
  // over the line" -- and the approval is supposed to be a judgement somebody
  // signs their name to.
  //
  // The panel also never hides why it cannot be approved. Every blocker is
  // listed, with the thing to do about it, because a greyed-out button that
  // will not say what is wrong is the most frustrating object in software.
  function ratingPill(r) {
    if (!r.rating) return '<span class="ac-pill ac-unrated">Not yet rated</span>';
    return '<span class="ac-pill ac-' + esc(r.rating) + '">' + esc(r.rating_label) + "</span>";
  }

  function planRowHtml(p) {
    return '<div class="ac-plan-on"><strong>' + esc(p.action) + "</strong>"
      + '<div class="ac-sub" style="margin-top:3px;">Due ' + esc(p.due_date)
      + " · reassessed " + esc(p.reassess_on)
      + (p.state === "closed" ? " · closed" : "") + "</div>"
      + (p.outcome ? '<div class="ac-sub" style="margin-top:3px;">Outcome: ' + esc(p.outcome) + "</div>" : "")
      + (p.state === "open" && REVIEW.can_rate
          ? '<div style="margin-top:7px;"><input data-pl-out="' + p.id + '" placeholder="What did the reassessment find?">'
            + '<button class="btn small" style="margin-top:6px;" data-pl-close="' + p.id + '">Close this plan</button></div>'
          : "")
      + "</div>";
  }

  function domainHtml(r, rv) {
    var plans = (rv.plans || []).filter(function (p) { return p.domain === r.domain; });
    var isGap = r.rating && r.rating !== "independent";
    var h = '<div class="ac-dom" data-domain="' + esc(r.domain) + '">'
      + '<div class="ac-row" style="justify-content:space-between;">'
        + "<strong>" + esc(r.label) + "</strong>" + ratingPill(r)
      + "</div>"
      + (r.note ? '<div class="ac-sub" style="margin-top:4px;">' + esc(r.note) + "</div>" : "")
      + (r.rated_by ? '<div class="ac-sub" style="margin-top:2px;">Rated by ' + esc(r.rated_by) + "</div>" : "");
    if (REVIEW.can_rate && !rv.closed) {
      h += '<div class="ac-grid2" style="margin-top:8px;">'
        + '<select data-rate="' + esc(r.domain) + '">'
          + '<option value="">Choose a rating…</option>'
          + Object.keys(REVIEW.rating_labels || {}).map(function (k) {
              return '<option value="' + esc(k) + '"' + (r.rating === k ? " selected" : "") + ">"
                + esc(REVIEW.rating_labels[k]) + "</option>";
            }).join("")
        + "</select>"
        + '<input data-rnote="' + esc(r.domain) + '" placeholder="What you saw (required unless Independent)"'
        + ' value="' + esc(r.note || "") + '">'
        + "</div>"
        + '<button class="btn small" style="margin-top:7px;" data-rsave="' + esc(r.domain) + '">Save rating</button>';
    }
    h += plans.map(planRowHtml).join("");
    // A GAP WITH NO PLAN IS THE ONE THING THAT BLOCKS APPROVAL, so the form
    // to fix it sits right under the rating that caused it rather than in a
    // separate place somebody has to go and find.
    if (isGap && !plans.length && REVIEW.can_rate && !rv.closed) {
      h += '<div class="ac-plan"><strong style="font-size:13px;">This needs a development plan</strong>'
        + '<div class="ac-sub" style="margin:2px 0 8px;">With a deadline and a date to look at it again — a plan'
        + " with no date on it is how somebody is still &quot;needing support&quot; in March.</div>"
        + '<textarea data-pa="' + esc(r.domain) + '" rows="2" placeholder="What will happen — training, shadowing, a specific piece of work"></textarea>'
        + '<div class="ac-grid2" style="margin-top:8px;">'
          + '<label class="ac-sub">Deadline<input type="date" data-pd="' + esc(r.domain) + '"></label>'
          + '<label class="ac-sub">Reassess on<input type="date" data-pr="' + esc(r.domain) + '"></label>'
        + "</div>"
        + '<button class="btn small" style="margin-top:8px;" data-padd="' + esc(r.domain) + '">Add the plan</button>'
        + "</div>";
    }
    return h + "</div>";
  }

  // ---- WHAT IS WAITING ON THE PERSON READING THIS -------------------------
  //
  // The approval gate refuses to sign off an onboarding while a competency
  // review request sits unanswered. Before this card existed, that refusal
  // was unresolvable from the screen: the only control that reviews a
  // competency was rendered for nobody and wired to nothing, so the only way
  // out of the blocker was the API. A gate has to come with the means of
  // getting through it.
  function waitingHtml() {
    var items = ((REVIEW.progress || {}).items || []).filter(function (i) {
      return i.status === "awaiting_review";
    });
    if (!REVIEW.can_rate || !items.length) return "";
    return '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">Waiting on you</h3>'
      + '<div class="ac-sub" style="margin-bottom:8px;">They have said they are ready. Watch them do it, then'
      + " sign it off or send it back with what still needs work — the onboarding cannot be approved while one of"
      + " these is unanswered.</div>"
      + items.map(function (i) {
        return '<div class="ac-item"><div style="flex:1;min-width:0;">'
          + '<div style="font-weight:700;">' + esc(i.title) + "</div>"
          + (i.detail ? '<div class="ac-comp">' + esc(i.detail) + "</div>" : "")
          + '<div style="margin-top:7px;"><input data-vn="' + i.item_id
            + '" placeholder="What still needs work (required to send it back)"></div>'
        + "</div>"
        + '<div style="text-align:right;display:flex;flex-direction:column;gap:6px;align-items:flex-end;">'
          + '<button class="btn small" data-vok="' + i.item_id + '">Sign it off</button>'
          + '<button class="btn small secondary" data-vno="' + i.item_id + '">Needs more training</button>'
        + "</div></div>";
      }).join("")
      + "</div>";
  }

  function blockersHtml(rv) {
    var out = [];
    if (!rv.complete) out.push("Still unrated: " + rv.unrated.map(esc).join(", ") + ".");
    if (REVIEW.progress && REVIEW.progress.awaiting_review) {
      out.push(REVIEW.progress.awaiting_review + " competency review request(s) are unanswered.");
    }
    var covered = {};
    (rv.plans || []).forEach(function (p) { covered[p.domain] = true; });
    var missing = (rv.gaps || []).filter(function (g) { return !covered[g.domain]; });
    if (missing.length) {
      out.push("No development plan yet for: " + missing.map(function (m) { return esc(m.label); }).join(", ") + ".");
    }
    if (!out.length) return "";
    return '<div class="ac-block"><strong>Not ready to approve yet</strong><ul style="margin:6px 0 0;padding-left:18px;">'
      + out.map(function (t) { return "<li>" + t + "</li>"; }).join("") + "</ul></div>";
  }

  function reviewHtml() {
    var rv = REVIEW.review;
    var who = REVIEW.who || "this employee";
    var head = '<div class="ac-card"><div class="ac-row" style="justify-content:space-between;">'
      + "<div><h3 style=\"margin:0;font-size:15px;\">30-day review — " + esc(who) + "</h3>"
      + '<div class="ac-sub">Day ' + ((REVIEW.progress || {}).day || "?") + " of onboarding</div></div>"
      + '<button class="btn small" id="ac-rv-back">Back</button></div></div>';

    if (!rv) {
      // NOT-YET-STARTED IS STILL A REVIEW SCREEN. The first version of this
      // showed the ten domains and nothing else, so whoever opened a day-30
      // review was never told what signing it off would require -- they
      // found out one refusal at a time. The blockers belong on screen from
      // the first moment, when they are at their longest.
      var blank = {
        state: "draft", closed: false, complete: false, plans: [], gaps: [],
        ratings: (REVIEW.domains || []).map(function (d) {
          return { domain: d.key, label: d.label, rating: null, note: null };
        }),
        unrated: (REVIEW.domains || []).map(function (d) { return d.label; }),
      };
      return head + waitingHtml() + '<div class="ac-card"><div class="ac-sub">'
        + (REVIEW.can_rate
            ? "No review has been started. Rating the first area below starts it."
            : "No review has been started yet.")
        + "</div></div>"
        + domainsCard(blank) + approveCard(blank);
    }
    if (rv.draft_in_progress) {
      return head + '<div class="ac-card"><div class="ac-sub">Your review has been started but is not finished.'
        + " You will see it in full, and talk it through, once your Clinical Director has signed it off.</div></div>";
    }
    return head + waitingHtml() + domainsCard(rv) + approveCard(rv);
  }

  function domainsCard(rv) {
    return '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">The ten areas</h3>'
      + '<div class="ac-sub" style="margin-bottom:6px;">Independent, Requires Additional Support, or Not Yet'
      + " Demonstrated. There is no score and no pass mark — anything below Independent needs a plan with dates.</div>"
      + (rv.ratings || []).map(function (r) { return domainHtml(r, rv); }).join("")
      + "</div>";
  }

  function approveCard(rv) {
    if (rv.closed) {
      return '<div class="ac-card"><h3 style="margin:0 0 4px;font-size:15px;">'
        + (rv.state === "development_plan" ? "Approved, with a development plan" : "Approved") + "</h3>"
        + '<div class="ac-sub">Signed off by ' + esc(rv.approved_by || "—") + " on "
        + esc(String(rv.approved_at || "").slice(0, 10)) + ".</div>"
        + (rv.summary ? '<div style="margin-top:8px;">' + esc(rv.summary) + "</div>" : "")
        + "</div>";
    }
    if (!REVIEW.can_approve) {
      return '<div class="ac-card"><div class="ac-sub">'
        + (REVIEW.is_subject
            ? "You cannot approve your own onboarding."
            : "The Clinical Director or an Assistant Clinical Director signs off the completion. Your ratings above are what they sign off on.")
        + "</div></div>";
    }
    return '<div class="ac-card"><h3 style="margin:0 0 4px;font-size:15px;">Sign off the onboarding</h3>'
      + '<div class="ac-sub" style="margin-bottom:9px;">This is a judgement, not a calculation: the CRM will not'
      + " approve anybody because thirty days have passed or because a checklist is full.</div>"
      + blockersHtml(rv)
      + '<textarea id="ac-rv-summary" rows="3" placeholder="A short summary of the review — this is sent to them"></textarea>'
      + '<div class="ac-row" style="margin-top:9px;"><button class="btn" id="ac-rv-approve">Approve the onboarding</button>'
      + '<span class="ac-sub" id="ac-rv-msg"></span></div>'
      + "</div>";
  }

  function openReview(enrId, who) {
    api("/api/academy/enrollments/" + enrId + "/review").then(function (d) {
      REVIEW = d; REVIEW.enr_id = enrId; REVIEW.who = who;
      BACK_TO = VIEW; VIEW = "review"; render();
    }).catch(function (e) { alert(e.message); });
  }

  // ---- TRAINING HOURS -----------------------------------------------------
  //
  // Logged by the person who spent the time, which is the only person who
  // knows. The card says in as many words that these do not reach payroll,
  // because somebody logging eight hours of shadowing needs to know whether
  // they have just claimed eight hours of pay. They have not.
  function hoursHtml(d) {
    var h = DATA.hours || {};
    var rows = h.hours || [];
    return '<div class="ac-card ac-hrs"><h3 style="margin:0 0 2px;font-size:15px;">Your training hours</h3>'
      + '<div class="ac-sub" style="margin-bottom:9px;">Time spent learning, kept separately from clinical hours.'
      + " <strong>These are not billable hours and they do not go to payroll or Rethink</strong> — they are here so"
      + " the practice can see what the training actually costs."
      + (h.target ? " The programme suggests about " + esc(h.target) + " hours in total." : "") + "</div>"
      + '<div class="ac-row" style="margin-bottom:6px;">'
        + '<strong style="font-size:20px;">' + esc(h.total == null ? 0 : h.total) + "</strong>"
        + '<span class="ac-sub">hours logged</span></div>'
      + '<div class="ac-grid2"><label class="ac-sub">Day<input type="date" id="ac-h-date" value="'
        + esc(new Date().toISOString().slice(0, 10)) + '"></label>'
        + '<label class="ac-sub">Hours<input id="ac-h-hours" placeholder="2.5"></label></div>'
      + '<div style="margin-top:8px;"><input id="ac-h-act" placeholder="What was the training?"></div>'
      + '<button class="btn small" style="margin-top:8px;" id="ac-h-add">Log it</button>'
      + '<span class="ac-sub" id="ac-h-msg" style="margin-left:9px;"></span>'
      + (rows.length
          ? '<div style="margin-top:11px;">' + rows.map(function (r) {
              return '<div class="ac-item"><div style="flex:1;min-width:0;">'
                + "<div>" + esc(r.activity) + "</div>"
                + '<div class="ac-sub">' + esc(r.on_date) + " · " + esc(r.hours) + " hours</div></div>"
                + '<div><button class="btn small secondary" data-h-del="' + r.id + '">Remove</button></div></div>';
            }).join("") + "</div>"
          : '<div class="ac-sub" style="margin-top:9px;">Nothing logged yet.</div>')
      + "</div>";
  }

  // ---- THE ANONYMOUS SURVEY -----------------------------------------------
  //
  // The promise text is not decoration. It is the difference between a
  // survey somebody answers honestly and one they answer carefully, and it
  // has to be accurate: the link is absent, not hidden -- and free text can
  // still give somebody away, which the form says rather than implying
  // otherwise.
  var SURVEY = { prepared: 0, mentor_time: 0, set_up_to_do_job: 0 };
  function scaleHtml(key, label) {
    var v = SURVEY[key] || 0;
    var out = "<label>" + esc(label) + '</label><div class="ac-scale">';
    for (var i = 1; i <= 5; i++) {
      out += '<button type="button" data-sv="' + key + '" data-svv="' + i + '"'
        + (v === i ? ' class="on"' : "") + ">" + i + "</button>";
    }
    return out + "</div>";
  }
  function surveyHtml() {
    var sv = DATA.survey || {};
    if (!sv.can_submit) {
      if (!sv.already) return "";
      return '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">Onboarding feedback</h3>'
        + '<div class="ac-sub">Thank you — your feedback is in, with nothing attached to it that says it was yours.</div></div>';
    }
    var qs = sv.questions || [];
    var text = qs.filter(function (q) { return !q.scale; });
    return '<div class="ac-card ac-sv"><h3 style="margin:0 0 2px;font-size:15px;">Tell us how the onboarding went</h3>'
      + '<div class="ac-sub" style="margin-bottom:4px;">' + esc(sv.promise || "") + "</div>"
      + qs.filter(function (q) { return q.scale; }).map(function (q) {
          return scaleHtml(q.key, q.text);
        }).join("")
      + text.map(function (q) {
          return "<label>" + esc(q.text) + '</label><textarea rows="2" data-svt="' + esc(q.key) + '"></textarea>';
        }).join("")
      + '<div class="ac-row" style="margin-top:11px;"><button class="btn" id="ac-sv-send">Send it</button>'
      + '<span class="ac-sub" id="ac-sv-msg"></span></div></div>';
  }

  // ---- NAMING CLINICAL LEADERSHIP -----------------------------------------
  //
  // The designation that gates the entire Academy: without a Clinical
  // Director or an Assistant, nobody can sign off a competency and no
  // onboarding can be approved.
  //
  // The endpoint for this shipped in step one and NOTHING EVER CALLED IT, so
  // the only way to name anybody was an API request. A permission nobody can
  // grant is a feature nobody has.
  //
  // Owner-only, and the server says so -- this card appears because
  // can_assign came back true, not because the browser decided the viewer
  // looked like an owner.
  function leadershipHtml() {
    var L = DATA.leadership;
    if (!L) return "";
    var cd = L.clinical_director;
    var assistants = L.assistants || [];
    var who = function (p) {
      return '<div class="ac-item"><div style="flex:1;min-width:0;">'
        + "<strong>" + esc(p.name) + "</strong>"
        + (p.email ? '<div class="ac-sub">' + esc(p.email) + "</div>" : "")
        + "</div>"
        + (L.can_assign
            ? '<div><button class="btn small secondary" data-lead-clear="' + p.id + '">Remove</button></div>'
            : "")
        + "</div>";
    };

    var out = '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">Clinical leadership</h3>'
      + '<div class="ac-sub" style="margin-bottom:9px;">Who can sign off a competency and approve a completed'
      + " onboarding. Until somebody is named here, nobody can — the Academy records progress and then has"
      + " nobody to accept it.</div>";

    out += '<div class="ac-sub" style="text-transform:uppercase;letter-spacing:.4px;font-size:10.5px;'
      + 'margin-top:10px;">Clinical Director</div>';
    out += cd ? who(cd)
      : '<div class="ac-block" style="margin-top:6px;"><strong>Nobody is named.</strong>'
        + '<div class="ac-sub" style="margin-top:4px;">No onboarding can be approved until somebody is.</div></div>';

    out += '<div class="ac-sub" style="text-transform:uppercase;letter-spacing:.4px;font-size:10.5px;'
      + 'margin-top:12px;">Assistant Clinical Directors</div>';
    out += assistants.length ? assistants.map(who).join("")
      : '<div class="ac-sub" style="margin-top:4px;">None named. Optional — they can approve as well as the'
        + " Director, which matters when the Director is the person being reviewed.</div>";

    // Said out loud, because the fallback working quietly is how somebody
    // concludes the designation is broken.
    if (L.from_setting) {
      out += '<div class="ac-sub" style="margin-top:11px;">The CRM is still falling back to the older'
        + " <strong>clinical_director_email</strong> setting (" + esc(L.from_setting) + ")."
        + " Naming somebody above replaces it, and keeps working if their email ever changes.</div>";
    }

    if (L.can_assign) {
      var cands = DATA.leadCandidates || [];
      out += '<div class="ac-plan" style="margin-top:12px;background:#f8fafc;border-color:var(--border,#e5e7eb);">'
        + '<strong style="font-size:13px;">Name somebody</strong>'
        + '<div class="ac-sub" style="margin:2px 0 8px;">Only you can do this: it hands somebody the power to'
        + " approve an onboarding, which is not a thing a clinical lead should be able to give themselves.</div>"
        + '<div class="ac-grid2">'
          + '<label class="ac-sub">Who<select id="ac-ld-who"><option value="">Choose a staff member…</option>'
            + cands.map(function (c) {
                return '<option value="' + c.id + '">' + esc(c.name)
                  + (c.role_title ? " — " + esc(c.role_title) : "") + "</option>";
              }).join("")
          + "</select></label>"
          + '<label class="ac-sub">As<select id="ac-ld-role">'
            + '<option value="clinical_director">Clinical Director</option>'
            + '<option value="assistant_clinical_director">Assistant Clinical Director</option>'
          + "</select></label>"
        + "</div>"
        + '<div class="ac-sub" style="margin-top:7px;">There is one Clinical Director. Naming a second replaces'
        + " the first, so &quot;the Clinical Director approved it&quot; is never ambiguous in the audit trail.</div>"
        + '<button class="btn small" style="margin-top:8px;" id="ac-ld-save">Name them</button>'
        + '<span class="ac-sub" id="ac-ld-msg" style="margin-left:9px;"></span>'
        + "</div>";
    }
    return out + "</div>";
  }

  // ---- the roster, for mentors and leadership -----------------------------
  function rosterHtml(list, canManage) {
    if (!list.length) {
      return '<div class="ac-card"><div class="ac-sub">Nobody is onboarding at the moment.</div></div>';
    }
    return '<div class="ac-card" style="overflow-x:auto;">'
      + '<table class="ac-tbl" style="min-width:720px;"><thead><tr>'
      + "<th>Who</th><th>Started</th><th>Day</th><th>Progress</th><th>Needs attention</th><th>Mentor</th>"
      + "<th>Review</th>"
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
            + (e.review_due ? '<span class="ac-pill ac-not_demonstrated">30-day review due</span> ' : "")
            + (e.open_plans ? '<span class="ac-pill ac-needs_support">' + e.open_plans + " open plan(s)</span> " : "")
            + (!e.awaiting_review && !e.needs_training && !e.review_due && !e.open_plans
                ? '<span class="ac-sub">—</span>' : "")
          + "</td>"
          + "<td>" + (e.mentor_name ? esc(e.mentor_name)
              : '<span class="ac-sub">none assigned</span>') + "</td>"
          + '<td><button class="btn small" data-rv-open="' + e.id + '" data-rv-who="' + esc(e.name) + '">'
            + (e.state === "completed" ? "View review" : "30-day review") + "</button></td>"
          + "</tr>";
      }).join("")
      + "</tbody></table></div>";
  }

  // ---- REPORTS ------------------------------------------------------------
  //
  // Figures somebody can act on this morning, not a dashboard to admire.
  // Overdue first, because that is the one that means a person has been
  // forgotten about.
  function reportsHtml() {
    var r = DATA.reports;
    if (!r) return '<div class="ac-card"><div class="ac-sub">Loading…</div></div>';
    var c = r.counts || {};
    var stat = function (n, label, warn) {
      return "<div><b" + (warn && n ? ' style="color:#991b1b;"' : "") + ">" + esc(n) + "</b>"
        + '<span class="ac-sub">' + esc(label) + "</span></div>";
    };
    var out = '<div class="ac-card"><div class="ac-row" style="justify-content:space-between;">'
      + "<h3 style=\"margin:0;font-size:15px;\">" + esc(r.program.name) + "</h3>"
      + '<a class="btn small" href="/api/academy/reports.csv?program=' + esc(r.program.key)
      + '">Export CSV</a></div>'
      + '<div class="ac-sub" style="margin:2px 0 11px;">Curriculum version ' + esc(r.program.version)
      + " · " + esc(r.program.weeks) + " weeks</div>"
      + '<div class="ac-stat">'
        + stat(c.total, "enrolled")
        + stat(c.active, "in progress")
        + stat(c.completed, "completed")
        + stat(c.overdue, "past their date", true)
        + stat(c.review_due, "review due", true)
      + "</div></div>";

    out += '<div class="ac-card"><div class="ac-stat">'
      + stat(r.median_days_to_complete == null ? "—" : r.median_days_to_complete, "median days to complete")
      + stat(r.completed_counted, "finished, counted")
      + stat((r.competencies || {}).signed_off, "competencies signed off")
      + stat((r.competencies || {}).sent_back, "sent back for more training")
      + stat((r.training_hours || {}).total, "training hours")
      + "</div>"
      + '<div class="ac-sub" style="margin-top:9px;">' + esc((r.training_hours || {}).note || "") + "</div>"
      + '<div class="ac-sub" style="margin-top:4px;">A median rather than an average: with a handful of'
      + " completions, one slow onboarding describes a programme nobody experienced.</div></div>";

    if ((r.recurring_gaps || []).length) {
      out += '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">What people say they were never taught</h3>'
        + '<div class="ac-sub" style="margin-bottom:8px;">One person is a gap in their training. Three people on the'
        + " same topic is a gap in the programme.</div>"
        + '<table class="ac-tbl"><thead><tr><th>Topic</th><th>Times raised</th><th>Still open</th></tr></thead><tbody>'
        + r.recurring_gaps.map(function (g) {
            return "<tr><td>" + esc(g.topic) + "</td><td>"
              + (g.n > 1 ? "<strong>" + esc(g.n) + "</strong>" : esc(g.n)) + "</td><td>" + esc(g.open) + "</td></tr>";
          }).join("")
        + "</tbody></table></div>";
    }

    if ((r.open_plans || []).length) {
      out += '<div class="ac-card"><h3 style="margin:0 0 8px;font-size:15px;">Open development plans</h3>'
        + '<table class="ac-tbl"><thead><tr><th>Who</th><th>Area</th><th>Action</th><th>Due</th><th>Reassess</th></tr></thead><tbody>'
        + r.open_plans.map(function (d) {
            return "<tr><td>" + esc(d.name) + "</td><td>" + esc(d.domain) + "</td><td>" + esc(d.action) + "</td>"
              + "<td>" + (d.overdue ? '<span class="ac-pill ac-not_demonstrated">' + esc(d.due_date) + "</span>"
                                    : esc(d.due_date)) + "</td>"
              + "<td>" + esc(d.reassess_on) + "</td></tr>";
          }).join("")
        + "</tbody></table></div>";
    }

    out += '<div class="ac-card" style="overflow-x:auto;"><h3 style="margin:0 0 8px;font-size:15px;">Everybody</h3>'
      + '<table class="ac-tbl" style="min-width:860px;"><thead><tr>'
      + "<th>Who</th><th>State</th><th>Day</th><th>Progress</th><th>Curriculum</th><th>Review</th>"
      + "<th>Training hours</th><th>Needs attention</th></tr></thead><tbody>"
      + (r.people || []).map(function (p) {
          return "<tr><td><strong>" + esc(p.name) + "</strong>"
            + (p.mentor_name ? '<div class="ac-sub">mentor: ' + esc(p.mentor_name) + "</div>"
                             : '<div class="ac-sub">no mentor</div>') + "</td>"
            + "<td>" + esc(p.state) + (p.overdue ? ' <span class="ac-pill ac-not_demonstrated">overdue</span>' : "") + "</td>"
            + "<td>" + esc(p.day) + "</td>"
            + '<td><div class="ac-mini"><div style="width:' + esc(p.percent) + '%"></div></div>'
              + '<div class="ac-sub">' + esc(p.percent) + "%</div></td>"
            + "<td>v" + esc(p.curriculum_version) + "</td>"
            + "<td>" + esc(p.review_state || "—")
              + (p.open_plans ? '<div class="ac-sub">' + esc(p.open_plans) + " open plan(s)</div>" : "") + "</td>"
            + "<td>" + esc(p.training_hours) + "</td>"
            + "<td>" + (p.awaiting_review ? esc(p.awaiting_review) + " to review " : "")
              + (p.needs_training ? esc(p.needs_training) + " redoing" : "")
              + (!p.awaiting_review && !p.needs_training ? '<span class="ac-sub">—</span>' : "") + "</td></tr>";
        }).join("")
      + "</tbody></table></div>";

    // The feedback, which is sealed until enough people have answered.
    var sr = DATA.surveyResults;
    if (sr) {
      if (sr.withheld) {
        out += '<div class="ac-card"><h3 style="margin:0 0 6px;font-size:15px;">Anonymous feedback</h3>'
          + '<div class="ac-sealed"><strong>' + esc(sr.responses) + " response(s) — sealed</strong>"
          + '<div class="ac-sub" style="margin-top:5px;">' + esc(sr.reason || "") + "</div></div></div>";
      } else {
        out += '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">Anonymous feedback</h3>'
          + '<div class="ac-sub" style="margin-bottom:9px;">' + esc(sr.responses)
          + " responses. Nothing here says who wrote it, in any order, because nothing was stored that could.</div>"
          + '<div class="ac-stat">'
            + stat((sr.averages || {}).prepared, "felt prepared (1-5)")
            + stat((sr.averages || {}).mentor_time, "time with mentor (1-5)")
            + stat((sr.averages || {}).set_up_to_do_job, "set up for the job (1-5)")
          + "</div>"
          + (sr.comments || []).map(function (c) {
              return '<div class="ac-quote"><div class="ac-sub">' + esc(c.q) + "</div>" + esc(c.text) + "</div>";
            }).join("")
          + "</div>";
      }
    }
    return out;
  }

  // ---- CURRICULUM MANAGEMENT ----------------------------------------------
  //
  // The screen that makes the brief's last line true: a second programme for
  // RBT onboarding or Squad Leader development without anybody writing code.
  // It says on its face when an edit will fork, because "this will create
  // version 3 and leave the four people currently onboarding on version 2"
  // is not a thing to discover afterwards.
  function curriculumHtml() {
    var c = DATA.curriculum;
    if (!c) return '<div class="ac-card"><div class="ac-sub">Loading…</div></div>';
    var progs = c.programs || [];
    var sel = progs.filter(function (p) { return Number(p.id) === Number(CUR_PROG); })[0] || progs[0];
    // `mayAuthor` is the owner's account; `editing` is whether she has turned
    // it on. Everything that changes the training is behind BOTH, and the
    // server refuses it regardless of what this screen draws.
    var mayAuthor = !!(DATA.roster && DATA.roster.can_author);
    var editing = mayAuthor && CUR_EDIT;
    var out = '<div class="ac-card"><div class="ac-row" style="justify-content:space-between;">'
      + "<h3 style=\"margin:0;font-size:15px;\">Programmes</h3>"
      + '<div class="ac-row" style="gap:6px;">'
        + (mayAuthor
            ? '<button class="btn small' + (editing ? "" : " secondary") + '" id="ac-cu-edit">'
              + (editing ? "Done editing" : "Edit curriculum") + "</button>"
            : "")
        + (editing ? '<button class="btn small" id="ac-cu-new">New programme</button>' : "")
      + "</div></div>"
      + '<div class="ac-sub" style="margin:3px 0 9px;">'
      + (editing
          ? "Editing is on. A programme is rows, not code — so RBT onboarding and Squad Leader development can be built here."
          : mayAuthor
            ? "This is the training as it stands. Switch editing on to change it."
            : "This is the training as it stands, so you can see what the people you supervise are being asked to do. Only the practice owner changes it.")
      + "</div>"
      + '<table class="ac-tbl"><thead><tr><th>Name</th><th>For</th><th>Weeks</th><th>Version</th>'
      + "<th>Enrolled</th><th>Content</th><th></th></tr></thead><tbody>"
      + progs.map(function (p) {
          return "<tr" + (sel && Number(p.id) === Number(sel.id) ? ' style="background:#f8fafc;"' : "") + ">"
            + "<td><strong>" + esc(p.name) + "</strong>"
            + (p.active ? "" : '<div class="ac-sub">inactive</div>') + "</td>"
            + "<td>" + esc(p.role_target || "—")
              + (p.role_target ? '<div class="ac-sub">auto-enrols</div>' : "") + "</td>"
            + "<td>" + esc(p.weeks) + "</td><td>v" + esc(p.version) + "</td>"
            + "<td>" + esc(p.enrolled) + "</td>"
            + "<td>" + esc(p.modules) + " weeks, " + esc(p.items) + " items</td>"
            + '<td><button class="btn small secondary" data-cu-pick="' + p.id + '">Open</button></td></tr>';
        }).join("")
      + "</tbody></table>"
      + '<div id="ac-cu-form"></div></div>';

    if (!sel) return out;
    var body = c.body || {};
    out += '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">' + esc(sel.name) + "</h3>"
      + '<div class="ac-sub" style="margin-bottom:9px;">'
      + (!editing
          ? esc(sel.enrolled) + " enrolled · version " + esc(sel.version)
          : Number(sel.enrolled) > 0
            ? "<strong>" + esc(sel.enrolled) + " people are enrolled.</strong> Editing anything here creates version "
              + esc(Number(sel.version) + 1) + " and leaves all of them on version " + esc(sel.version)
              + " — nobody's finished week changes under them."
            : "Nobody is enrolled yet, so edits change this version in place.")
      + "</div>"
      + (body.modules || []).map(function (m) {
          return '<div class="ac-comp" style="margin-bottom:10px;background:#fff;border-color:var(--border,#e5e7eb);">'
            + '<div class="ac-row" style="justify-content:space-between;">'
              + "<div><strong>Week " + esc(m.week) + " — " + esc(m.title) + "</strong>"
              + (m.focus ? '<div class="ac-sub">' + esc(m.focus) + "</div>" : "") + "</div>"
              + (editing ? '<div><button class="btn small secondary" data-cu-mdel="' + m.id + '">Remove week</button></div>' : "")
            + "</div>"
            + (m.items || []).map(function (i) {
                return '<div class="ac-item"><div style="flex:1;min-width:0;">'
                  + "<div>" + esc(i.title) + "</div>"
                  + '<div class="ac-sub">' + esc(i.kind) + (i.required ? "" : " · optional") + "</div>"
                  + resourcesHtml(i.resources)
                  + (editing
                      ? '<div style="margin-top:6px;"><button class="btn small" data-cu-res="' + i.id
                        + '" data-cu-res-kind="item">Attach material</button></div>'
                      : "")
                + "</div>"
                + (editing ? '<div><button class="btn small secondary" data-cu-idel="' + i.id + '">Remove</button></div>' : "")
                + "</div>";
              }).join("")
            + (editing
                ? '<div class="ac-row" style="margin-top:9px;">'
                  + '<button class="btn small" data-cu-iadd="' + m.id + '">Add an item</button>'
                  + '<button class="btn small" data-cu-res="' + m.id + '" data-cu-res-kind="module">Attach material to the week</button>'
                + "</div>"
                : "")
            + "</div>";
        }).join("")
      + (editing ? '<button class="btn small" id="ac-cu-wadd">Add a week</button>' : "")
      + '<div id="ac-cu-form2"></div></div>';
    return out;
  }

  // ---- render -------------------------------------------------------------
  function render() {
    if (!HOST || !DATA) return;
    var showRoster = DATA.roster && (DATA.roster.enrollments || []).length >= 0
      && (DATA.roster.can_manage || (DATA.roster.enrollments || []).length > 0);
    var canManage = !!(DATA.roster && DATA.roster.can_manage);
    // Authoring the training is the owner's; running onboarding is
    // leadership's. The Curriculum tab is the former.
    var canAuthor = !!(DATA.roster && DATA.roster.can_author);
    var tabs = "";
    if (showRoster) {
      tabs = '<div style="margin-bottom:12px;">'
        + '<button class="ac-tab' + (VIEW === "me" ? " on" : "") + '" data-view="me">My training</button>'
        + '<button class="ac-tab' + (VIEW === "roster" ? " on" : "") + '" data-view="roster">'
        + (canManage ? "Everyone onboarding" : "My mentees") + "</button>"
        + (canManage
            ? '<button class="ac-tab' + (VIEW === "reports" ? " on" : "") + '" data-view="reports">Reports</button>'
              + '<button class="ac-tab' + (VIEW === "curriculum" ? " on" : "") + '" data-view="curriculum">Curriculum</button>'
            : "")
        + "</div>";
    }
    if (VIEW === "review" && REVIEW) {
      HOST.innerHTML = '<div class="ac-wrap">' + reviewHtml() + "</div>";
      wire();
      return;
    }
    var body;
    if (VIEW === "roster" && showRoster) {
      // A mentor's queue belongs beside the roster, not buried in a
      // mentee's record: the question they have not answered is the thing
      // they came to this screen for.
      // Above the roster, because a roster full of people nobody can sign
      // off is the symptom and this is the cause.
      body = (canManage ? leadershipHtml() : "")
           + rosterHtml(DATA.roster.enrollments || [], canManage)
           + threadsHtml(DATA.questions, DATA.gaps, true);
    } else if (VIEW === "reports" && canManage) {
      body = reportsHtml();
    } else if (VIEW === "curriculum" && canManage) {
      body = curriculumHtml();
    } else {
      body = meHtml(DATA.me);
    }
    HOST.innerHTML = '<div class="ac-wrap">' + tabs + body + "</div>";
    wire();
  }

  function wire() {
    HOST.querySelectorAll("[data-view]").forEach(function (b) {
      b.addEventListener("click", function () {
        VIEW = b.dataset.view;
        render();
        // Fetched on first open rather than on every page load: a new BCBA
        // opening their own checklist has no business pulling the whole
        // practice's reports down with it.
        if (VIEW === "reports" && !DATA.reports) loadReports();
        if (VIEW === "curriculum" && !DATA.curriculum) loadCurriculum();
      });
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

    var forms = HOST.querySelector("#ac-forms");
    var show = function (html) { if (forms) { forms.innerHTML = html; wire(); } };
    var ask = HOST.querySelector("#ac-ask");
    if (ask) ask.addEventListener("click", function () { show(askFormHtml()); });
    var gapBtn = HOST.querySelector("#ac-gap");
    if (gapBtn) gapBtn.addEventListener("click", function () { show(gapFormHtml()); });

    var qSend = HOST.querySelector("#ac-q-send");
    if (qSend) qSend.addEventListener("click", function () {
      var subject = (HOST.querySelector("#ac-q-subject") || {}).value || "";
      var msg = HOST.querySelector("#ac-q-msg");
      if (!subject.trim()) { if (msg) msg.textContent = "Give it a subject first."; return; }
      qSend.disabled = true;
      api("/api/academy/questions", { method: "POST", body: {
        subject: subject, body: (HOST.querySelector("#ac-q-body") || {}).value || "" } })
        .then(function (d) {
          if (msg) {
            msg.textContent = d.mentor_notified
              ? "Sent. Your mentor has it."
              : "Saved. No mentor is assigned yet, so clinical leadership will pick it up.";
          }
          reload();
        })
        .catch(function (e) { qSend.disabled = false; if (msg) msg.textContent = e.message; });
    });

    var gSend = HOST.querySelector("#ac-g-send");
    if (gSend) gSend.addEventListener("click", function () {
      var topic = (HOST.querySelector("#ac-g-topic") || {}).value || "";
      var msg = HOST.querySelector("#ac-g-msg");
      if (!topic.trim()) { if (msg) msg.textContent = "What was the topic?"; return; }
      gSend.disabled = true;
      api("/api/academy/gaps", { method: "POST", body: {
        topic: topic,
        description: (HOST.querySelector("#ac-g-desc") || {}).value || "",
        urgency: (HOST.querySelector("#ac-g-urg") || {}).value || "soon",
        needs_help_now: !!(HOST.querySelector("#ac-g-now") || {}).checked } })
        .then(function () {
          if (msg) msg.textContent = "Sent to your mentor and clinical leadership. You will hear back.";
          reload();
        })
        .catch(function (e) { gSend.disabled = false; if (msg) msg.textContent = e.message; });
    });

    HOST.querySelectorAll("[data-ans-send]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-ans-send");
        var ta = HOST.querySelector('[data-ans="' + id + '"]');
        if (!ta || !ta.value.trim()) { alert("Write an answer first."); return; }
        b.disabled = true;
        api("/api/academy/questions/" + id, { method: "POST", body: { answer: ta.value } })
          .then(reload).catch(function (e) { b.disabled = false; alert(e.message); });
      });
    });

    var enrId = DATA.me && DATA.me.enrollment ? DATA.me.enrollment.id : null;
    HOST.querySelectorAll("[data-ci-save]").forEach(function (b) {
      b.addEventListener("click", function () {
        var day = b.getAttribute("data-ci-save");
        if (!enrId) return;
        b.disabled = true;
        api("/api/academy/enrollments/" + enrId + "/checkins/" + day, { method: "POST", body: {
          learned: (HOST.querySelector('[data-ci-learned="' + day + '"]') || {}).value || "",
          still_unclear: (HOST.querySelector('[data-ci-unclear="' + day + '"]') || {}).value || "" } })
          .then(reload).catch(function (e) { b.disabled = false; alert(e.message); });
      });
    });
    // ---- naming clinical leadership --------------------------------------
    var setLead = function (id, role, msgEl, btn) {
      if (btn) btn.disabled = true;
      return api("/api/academy/leadership/" + id, { method: "PUT", body: { leadership: role } })
        .then(function (d) {
          DATA.leadership = Object.assign({}, DATA.leadership, d.leadership || {});
          return loadLeadership();
        })
        .then(render)
        .catch(function (e) {
          if (btn) btn.disabled = false;
          if (msgEl) msgEl.textContent = e.message; else alert(e.message);
        });
    };
    var ldSave = HOST.querySelector("#ac-ld-save");
    if (ldSave) ldSave.addEventListener("click", function () {
      var msg = HOST.querySelector("#ac-ld-msg");
      var who = (HOST.querySelector("#ac-ld-who") || {}).value || "";
      var role = (HOST.querySelector("#ac-ld-role") || {}).value || "";
      if (!who) { if (msg) msg.textContent = "Choose a staff member first."; return; }
      setLead(who, role, msg, ldSave);
    });
    HOST.querySelectorAll("[data-lead-clear]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!window.confirm("Remove their clinical leadership designation? They will no longer be able to"
          + " approve an onboarding.")) return;
        setLead(b.getAttribute("data-lead-clear"), "", null, b);
      });
    });

    // ---- training hours --------------------------------------------------
    var hAdd = HOST.querySelector("#ac-h-add");
    if (hAdd) hAdd.addEventListener("click", function () {
      var msg = HOST.querySelector("#ac-h-msg");
      var enrId = DATA.me && DATA.me.enrollment ? DATA.me.enrollment.id : null;
      if (!enrId) return;
      hAdd.disabled = true;
      api("/api/academy/enrollments/" + enrId + "/hours", { method: "POST", body: {
        on_date: (HOST.querySelector("#ac-h-date") || {}).value || "",
        hours: (HOST.querySelector("#ac-h-hours") || {}).value || "",
        activity: (HOST.querySelector("#ac-h-act") || {}).value || "" } })
        .then(function () { return loadHours(); })
        .then(render)
        .catch(function (e) { hAdd.disabled = false; if (msg) msg.textContent = e.message; });
    });
    HOST.querySelectorAll("[data-h-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        b.disabled = true;
        api("/api/academy/hours/" + b.getAttribute("data-h-del"), { method: "DELETE" })
          .then(function () { return loadHours(); }).then(render)
          .catch(function (e) { b.disabled = false; alert(e.message); });
      });
    });

    // ---- the survey ------------------------------------------------------
    HOST.querySelectorAll("[data-sv]").forEach(function (b) {
      b.addEventListener("click", function () {
        SURVEY[b.getAttribute("data-sv")] = Number(b.getAttribute("data-svv"));
        render();
      });
    });
    var svSend = HOST.querySelector("#ac-sv-send");
    if (svSend) svSend.addEventListener("click", function () {
      var msg = HOST.querySelector("#ac-sv-msg");
      var body = { prepared: SURVEY.prepared, mentor_time: SURVEY.mentor_time,
                   set_up_to_do_job: SURVEY.set_up_to_do_job };
      HOST.querySelectorAll("[data-svt]").forEach(function (t) { body[t.getAttribute("data-svt")] = t.value; });
      svSend.disabled = true;
      api("/api/academy/survey", { method: "POST", body: body })
        .then(function () { return api("/api/academy/survey"); })
        .then(function (d) { DATA.survey = d; render(); })
        .catch(function (e) { svSend.disabled = false; if (msg) msg.textContent = e.message; });
    });

    // ---- the curriculum editor -------------------------------------------
    // The switch. Only drawn for the owner, so only she can reach it; the
    // server refuses every write regardless of what this screen offers.
    var cuEdit = HOST.querySelector("#ac-cu-edit");
    if (cuEdit) cuEdit.addEventListener("click", function () {
      CUR_EDIT = !CUR_EDIT;
      render();
    });
    HOST.querySelectorAll("[data-cu-pick]").forEach(function (b) {
      b.addEventListener("click", function () {
        CUR_PROG = Number(b.getAttribute("data-cu-pick"));
        loadCurriculumBody().then(render);
      });
    });
    var form = HOST.querySelector("#ac-cu-form");
    var form2 = HOST.querySelector("#ac-cu-form2");
    var newProg = HOST.querySelector("#ac-cu-new");
    if (newProg && form) newProg.addEventListener("click", function () {
      form.innerHTML = '<div class="ac-plan" style="background:#f8fafc;border-color:var(--border,#e5e7eb);">'
        + '<strong style="font-size:13px;">A new programme</strong>'
        + '<div class="ac-sub" style="margin:2px 0 8px;">It is usable straight away. Leave the role blank unless you'
        + " want everybody with that job title enrolled automatically.</div>"
        + '<input id="ac-np-name" placeholder="Name, e.g. RBT Onboarding">'
        + '<div class="ac-grid2" style="margin-top:8px;">'
          + '<label class="ac-sub">Weeks<input id="ac-np-weeks" value="4"></label>'
          + '<label class="ac-sub">Role to auto-enrol (optional)<input id="ac-np-role" placeholder="leave blank"></label>'
        + "</div>"
        + '<button class="btn small" style="margin-top:8px;" id="ac-np-save">Create it</button>'
        + '<span class="ac-sub" id="ac-np-msg"></span></div>';
      wire();
    });
    var npSave = HOST.querySelector("#ac-np-save");
    if (npSave) npSave.addEventListener("click", function () {
      var msg = HOST.querySelector("#ac-np-msg");
      npSave.disabled = true;
      api("/api/academy/programs", { method: "POST", body: {
        name: (HOST.querySelector("#ac-np-name") || {}).value || "",
        weeks: (HOST.querySelector("#ac-np-weeks") || {}).value || 4,
        role_target: (HOST.querySelector("#ac-np-role") || {}).value || "" } })
        .then(function (d) { CUR_PROG = d.program.id; return loadCurriculum(); })
        .then(render)
        .catch(function (e) { npSave.disabled = false; if (msg) msg.textContent = e.message; });
    });

    var wAdd = HOST.querySelector("#ac-cu-wadd");
    if (wAdd && form2) wAdd.addEventListener("click", function () {
      form2.innerHTML = '<div class="ac-plan" style="background:#f8fafc;border-color:var(--border,#e5e7eb);">'
        + '<strong style="font-size:13px;">A new week</strong>'
        + '<div class="ac-grid2" style="margin-top:7px;">'
          + '<label class="ac-sub">Week number<input id="ac-nw-week" value="1"></label>'
          + '<label class="ac-sub">Title<input id="ac-nw-title" placeholder="What the week covers"></label>'
        + "</div>"
        + '<button class="btn small" style="margin-top:8px;" id="ac-nw-save">Add it</button>'
        + '<span class="ac-sub" id="ac-nw-msg"></span></div>';
      wire();
    });
    var nwSave = HOST.querySelector("#ac-nw-save");
    if (nwSave) nwSave.addEventListener("click", function () {
      var msg = HOST.querySelector("#ac-nw-msg");
      nwSave.disabled = true;
      api("/api/academy/programs/" + CUR_PROG + "/modules", { method: "POST", body: {
        week: (HOST.querySelector("#ac-nw-week") || {}).value || 1,
        title: (HOST.querySelector("#ac-nw-title") || {}).value || "" } })
        .then(function () { return loadCurriculum(); }).then(render)
        .catch(function (e) { nwSave.disabled = false; if (msg) msg.textContent = e.message; });
    });

    HOST.querySelectorAll("[data-cu-iadd]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!form2) return;
        form2.innerHTML = '<div class="ac-plan" style="background:#f8fafc;border-color:var(--border,#e5e7eb);">'
          + '<strong style="font-size:13px;">A new item</strong>'
          + '<input id="ac-ni-title" placeholder="What they do" style="margin-top:7px;">'
          + '<div class="ac-grid2" style="margin-top:8px;">'
            + '<label class="ac-sub">Kind<select id="ac-ni-kind">'
              + '<option value="reading">Reading</option><option value="checklist">Checklist item</option>'
              + '<option value="competency">Competency (signed off by a supervisor)</option>'
              + '<option value="quiz">Quiz</option></select></label>'
            + '<label class="ac-sub">Detail<input id="ac-ni-detail" placeholder="optional"></label>'
          + "</div>"
          + '<button class="btn small" style="margin-top:8px;" data-ni-save="' + b.getAttribute("data-cu-iadd") + '">Add it</button>'
          + '<span class="ac-sub" id="ac-ni-msg"></span></div>';
        wire();
      });
    });
    HOST.querySelectorAll("[data-ni-save]").forEach(function (b) {
      b.addEventListener("click", function () {
        var msg = HOST.querySelector("#ac-ni-msg");
        b.disabled = true;
        api("/api/academy/modules/" + b.getAttribute("data-ni-save") + "/items", { method: "POST", body: {
          title: (HOST.querySelector("#ac-ni-title") || {}).value || "",
          kind: (HOST.querySelector("#ac-ni-kind") || {}).value || "reading",
          detail: (HOST.querySelector("#ac-ni-detail") || {}).value || "" } })
          .then(function () { return loadCurriculum(); }).then(render)
          .catch(function (e) { b.disabled = false; if (msg) msg.textContent = e.message; });
      });
    });

    var del = function (url, confirmText) {
      return function () {
        if (!window.confirm(confirmText)) return;
        api(url, { method: "DELETE" }).then(function () { return loadCurriculum(); }).then(render)
          .catch(function (e) { alert(e.message); });
      };
    };
    HOST.querySelectorAll("[data-cu-mdel]").forEach(function (b) {
      b.addEventListener("click", del("/api/academy/modules/" + b.getAttribute("data-cu-mdel"),
        "Remove this week? Anybody already enrolled keeps it — they stay on their own version."));
    });
    HOST.querySelectorAll("[data-cu-idel]").forEach(function (b) {
      b.addEventListener("click", del("/api/academy/items/" + b.getAttribute("data-cu-idel"),
        "Remove this item? Anybody already enrolled keeps it."));
    });

    HOST.querySelectorAll("[data-cu-res]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!form2) return;
        var id = b.getAttribute("data-cu-res");
        var scope = b.getAttribute("data-cu-res-kind");
        form2.innerHTML = '<div class="ac-plan" style="background:#f8fafc;border-color:var(--border,#e5e7eb);">'
          + '<strong style="font-size:13px;">Attach training material</strong>'
          + '<div class="ac-sub" style="margin:2px 0 8px;">A video is an embedded link — Loom, YouTube or Vimeo.'
          + " An SOP is picked from the policy library rather than pasted in, so an amended SOP stays correct here.</div>"
          + '<div class="ac-grid2"><label class="ac-sub">Kind<select id="ac-nr-kind">'
            + '<option value="video">Video (link)</option><option value="link">Link</option>'
            + '<option value="document">SOP or policy from the library</option>'
            + '<option value="note">A note</option></select></label>'
            + '<label class="ac-sub">Title<input id="ac-nr-title" placeholder="What it is"></label></div>'
          + '<div style="margin-top:8px;"><input id="ac-nr-url" placeholder="https://..."></div>'
          + '<div style="margin-top:8px;"><select id="ac-nr-pol"><option value="">Choose a policy or SOP…</option>'
            + ((DATA.policies || []).map(function (p) {
                return '<option value="' + p.id + '">' + esc(p.title) + "</option>";
              }).join("")) + "</select></div>"
          + '<div style="margin-top:8px;"><input id="ac-nr-body" placeholder="The note itself"></div>'
          + '<button class="btn small" style="margin-top:8px;" data-nr-save="' + id + '" data-nr-scope="' + scope + '">Attach it</button>'
          + '<span class="ac-sub" id="ac-nr-msg"></span></div>';
        wire();
      });
    });
    HOST.querySelectorAll("[data-nr-save]").forEach(function (b) {
      b.addEventListener("click", function () {
        var msg = HOST.querySelector("#ac-nr-msg");
        var id = Number(b.getAttribute("data-nr-save"));
        var scope = b.getAttribute("data-nr-scope");
        var body = {
          kind: (HOST.querySelector("#ac-nr-kind") || {}).value || "link",
          title: (HOST.querySelector("#ac-nr-title") || {}).value || "",
          url: (HOST.querySelector("#ac-nr-url") || {}).value || "",
          policy_id: (HOST.querySelector("#ac-nr-pol") || {}).value || null,
          body: (HOST.querySelector("#ac-nr-body") || {}).value || "",
        };
        if (scope === "module") body.module_id = id; else body.item_id = id;
        b.disabled = true;
        api("/api/academy/resources", { method: "POST", body: body })
          .then(function () { return loadCurriculum(); }).then(render)
          .catch(function (e) { b.disabled = false; if (msg) msg.textContent = e.message; });
      });
    });

    // ---- the review ------------------------------------------------------
    HOST.querySelectorAll("[data-rv-open]").forEach(function (b) {
      b.addEventListener("click", function () {
        openReview(b.getAttribute("data-rv-open"), b.getAttribute("data-rv-who"));
      });
    });
    var back = HOST.querySelector("#ac-rv-back");
    if (back) back.addEventListener("click", function () {
      REVIEW = null; VIEW = BACK_TO === "review" ? "me" : BACK_TO;
      render();
    });

    var reloadReview = function () {
      return api("/api/academy/enrollments/" + REVIEW.enr_id + "/review").then(function (d) {
        var who = REVIEW.who, id = REVIEW.enr_id;
        REVIEW = d; REVIEW.who = who; REVIEW.enr_id = id;
        render();
      });
    };

    var verify = function (itemId, status, note) {
      return api("/api/academy/enrollments/" + REVIEW.enr_id + "/items/" + itemId,
                 { method: "POST", body: { status: status, note: note } });
    };
    HOST.querySelectorAll("[data-vok]").forEach(function (b) {
      b.addEventListener("click", function () {
        b.disabled = true;
        verify(b.getAttribute("data-vok"), "completed", "")
          .then(reloadReview).catch(function (e) { b.disabled = false; alert(e.message); });
      });
    });
    HOST.querySelectorAll("[data-vno]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-vno");
        var el = HOST.querySelector('[data-vn="' + id + '"]');
        // SENDING SOMETHING BACK HAS TO SAY WHY. The server refuses a blank
        // one, and being told that after pressing the button is worse than
        // being told before.
        if (!el || !el.value.trim()) { alert("Say what still needs work before sending it back."); return; }
        b.disabled = true;
        verify(id, "needs_training", el.value)
          .then(reloadReview).catch(function (e) { b.disabled = false; alert(e.message); });
      });
    });

    HOST.querySelectorAll("[data-rsave]").forEach(function (b) {
      b.addEventListener("click", function () {
        var dom = b.getAttribute("data-rsave");
        var sel = HOST.querySelector('[data-rate="' + dom + '"]');
        var note = HOST.querySelector('[data-rnote="' + dom + '"]');
        if (!sel || !sel.value) { alert("Choose a rating first."); return; }
        b.disabled = true;
        api("/api/academy/enrollments/" + REVIEW.enr_id + "/review", { method: "POST", body: {
          domain: dom, rating: sel.value, note: note ? note.value : "" } })
          .then(reloadReview)
          .catch(function (e) { b.disabled = false; alert(e.message); });
      });
    });

    HOST.querySelectorAll("[data-padd]").forEach(function (b) {
      b.addEventListener("click", function () {
        var dom = b.getAttribute("data-padd");
        var g = function (attr) {
          var el = HOST.querySelector("[" + attr + '="' + dom + '"]');
          return el ? el.value : "";
        };
        b.disabled = true;
        api("/api/academy/enrollments/" + REVIEW.enr_id + "/review/plans", { method: "POST", body: {
          domain: dom, action: g("data-pa"), due_date: g("data-pd"), reassess_on: g("data-pr") } })
          .then(reloadReview)
          .catch(function (e) { b.disabled = false; alert(e.message); });
      });
    });

    HOST.querySelectorAll("[data-pl-close]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-pl-close");
        var el = HOST.querySelector('[data-pl-out="' + id + '"]');
        if (!el || !el.value.trim()) { alert("Say what the reassessment found."); return; }
        b.disabled = true;
        api("/api/academy/plans/" + id, { method: "PATCH", body: { outcome: el.value } })
          .then(reloadReview)
          .catch(function (e) { b.disabled = false; alert(e.message); });
      });
    });

    var appr = HOST.querySelector("#ac-rv-approve");
    if (appr) appr.addEventListener("click", function () {
      var sum = HOST.querySelector("#ac-rv-summary");
      var msg = HOST.querySelector("#ac-rv-msg");
      appr.disabled = true;
      api("/api/academy/enrollments/" + REVIEW.enr_id + "/review/approve", { method: "POST", body: {
        summary: sum ? sum.value : "" } })
        .then(reloadReview)
        .catch(function (e) { appr.disabled = false; if (msg) msg.textContent = e.message; else alert(e.message); });
    });

    HOST.querySelectorAll("[data-ci-sign]").forEach(function (b) {
      b.addEventListener("click", function () {
        var day = b.getAttribute("data-ci-sign");
        if (!enrId) return;
        b.disabled = true;
        api("/api/academy/enrollments/" + enrId + "/checkins/" + day, { method: "POST", body: {
          mentor_feedback: (HOST.querySelector('[data-ci-fb="' + day + '"]') || {}).value || "" } })
          .then(reload).catch(function (e) { b.disabled = false; alert(e.message); });
      });
    });
  }

  function loadLeadership() {
    return api("/api/academy/leadership")
      .then(function (d) {
        DATA.leadership = d;
        // The candidate list is owner-only, so it is fetched only when the
        // server has said this viewer can assign.
        if (!d.can_assign) { DATA.leadCandidates = []; return null; }
        return api("/api/academy/leadership/candidates").catch(function () { return { candidates: [] }; });
      })
      .then(function (c) { if (c) DATA.leadCandidates = c.candidates || []; })
      .catch(function () { DATA.leadership = null; });
  }

  function loadHours() {
    var enrId = DATA.me && DATA.me.enrollment ? DATA.me.enrollment.id : null;
    if (!enrId) return Promise.resolve();
    return api("/api/academy/enrollments/" + enrId + "/hours")
      .then(function (d) { DATA.hours = d; })
      .catch(function () { DATA.hours = { hours: [], total: 0 }; });
  }

  function loadReports() {
    return api("/api/academy/reports")
      .then(function (d) {
        DATA.reports = d;
        // The feedback is a separate call because it is separately
        // permissioned and separately sealed.
        return api("/api/academy/survey/results").catch(function () { return null; });
      })
      .then(function (sr) { DATA.surveyResults = sr; render(); })
      .catch(function (e) {
        DATA.reports = null;
        HOST.innerHTML = '<div class="ac-wrap"><div class="ac-card"><div class="ac-sub">'
          + esc(e.message) + "</div></div></div>";
      });
  }

  function loadCurriculumBody() {
    var progs = (DATA.curriculum || {}).programs || [];
    var sel = progs.filter(function (p) { return Number(p.id) === Number(CUR_PROG); })[0] || progs[0];
    if (!sel) return Promise.resolve();
    CUR_PROG = sel.id;
    return api("/api/academy/curriculum?program=" + encodeURIComponent(sel.key) + "&version=" + sel.version)
      .then(function (d) { DATA.curriculum.body = d; })
      .catch(function () { DATA.curriculum.body = { modules: [] }; });
  }

  function loadCurriculum() {
    return api("/api/academy/programs")
      .then(function (d) {
        DATA.curriculum = { programs: d.programs || [] };
        // The policy library, for attaching an SOP by reference.
        return api("/api/policies").catch(function () { return null; });
      })
      .then(function (pol) {
        // { policies: [...] } -- checked against growth.js rather than
        // guessed, because a wrong key here is a silently empty dropdown
        // and nobody would know the SOP list had failed to load.
        DATA.policies = (pol && pol.policies) || [];
        return loadCurriculumBody();
      })
      .then(function () { render(); })
      .catch(function (e) {
        HOST.innerHTML = '<div class="ac-wrap"><div class="ac-card"><div class="ac-sub">'
          + esc(e.message) + "</div></div></div>";
      });
  }

  function reload() { window.__renderAcademy(HOST); }

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
      api("/api/academy/questions").catch(function () { return { questions: [] }; }),
      api("/api/academy/gaps").catch(function () { return { gaps: [] }; }),
      api("/api/academy/survey").catch(function () { return { can_submit: false }; }),
      api("/api/academy/leadership").catch(function () { return null; }),
    ]).then(function (r) {
      DATA = { me: r[0], roster: r[1], questions: (r[2] || {}).questions, gaps: (r[3] || {}).gaps,
               survey: r[4], leadership: r[5] };
      if (DATA.me && DATA.me.enrolled) {
        return api("/api/academy/enrollments/" + DATA.me.enrollment.id + "/checkins")
          .then(function (c) { DATA.checkins = c.checkins; return loadHours(); })
          .then(function () { return r; })
          .catch(function () { return r; });
      }
      return r;
    }).then(function (r) {
      if (!DATA.me.enrolled && DATA.roster && (DATA.roster.enrollments || []).length) VIEW = "roster";
      render();
      // The candidate list follows, so the card can render immediately with
      // who is already named and fill its picker a moment later.
      if (DATA.leadership && DATA.leadership.can_assign) loadLeadership().then(render);
    });
  };
})();
