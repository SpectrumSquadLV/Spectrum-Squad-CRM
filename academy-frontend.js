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
      + helpHtml(d)
      + '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">Week ' + week + " — " + esc(title) + "</h3>"
      + '<div class="ac-sub" style="margin-bottom:8px;">Tick each topic as you cover it. The competency at the'
      + " end is signed off by your mentor, not by you.</div>"
      + inWeek.map(function (i) { return itemHtml(i, false); }).join("")
      + "</div>"
      + checkinsHtml(DATA.checkins, false, true)
      + '<div class="ac-card"><h3 style="margin:0 0 2px;font-size:15px;">Your 30-day review</h3>'
      + '<div class="ac-sub" style="margin-bottom:9px;">At the end of the thirty days your mentor rates ten areas of'
      + " the job and your Clinical Director signs it off. You will see all of it, and talk it through, once it is"
      + " signed — not while it is being written.</div>"
      + '<button class="btn small" data-rv-open="' + d.enrollment.id + '" data-rv-who="you">Open it</button></div>'
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
    if (VIEW === "review" && REVIEW) {
      HOST.innerHTML = '<div class="ac-wrap">' + reviewHtml() + "</div>";
      wire();
      return;
    }
    var body = VIEW === "roster" && showRoster
      ? rosterHtml(DATA.roster.enrollments || [], DATA.roster.can_manage)
        // A mentor's queue belongs beside the roster, not buried in a
        // mentee's record: the question they have not answered is the thing
        // they came to this screen for.
        + threadsHtml(DATA.questions, DATA.gaps, true)
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
    ]).then(function (r) {
      DATA = { me: r[0], roster: r[1], questions: (r[2] || {}).questions, gaps: (r[3] || {}).gaps };
      if (DATA.me && DATA.me.enrolled) {
        return api("/api/academy/enrollments/" + DATA.me.enrollment.id + "/checkins")
          .then(function (c) { DATA.checkins = c.checkins; return r; })
          .catch(function () { return r; });
      }
      return r;
    }).then(function (r) {
      if (!DATA.me.enrolled && DATA.roster && (DATA.roster.enrollments || []).length) VIEW = "roster";
      render();
    });
  };
})();
