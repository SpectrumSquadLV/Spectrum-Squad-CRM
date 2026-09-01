// billable-frontend.js -- monthly billable requirements for clinical staff.
//
// Two jobs on one screen: set each person's monthly requirement, and see how
// the last finished month went against it.
//
// The screen leads with what CANNOT be sent and why, rather than burying it.
// A row whose hours are provisional, or whose month never synced, is the case
// where a well-meaning "send now" would put a wrong number in front of a
// clinician about their own performance -- so those rows say so on their face
// and the send button reports them by name.
(function () {
  "use strict";

  var MOUNT = null;
  var STATE = { month: null, data: null };

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
        if (!r.ok) throw new Error(d.error || "Request failed (" + r.status + ")");
        return d;
      });
    });
  }

  function hoursText(n) { return n == null ? "—" : String(n) + " h"; }

  function rowHtml(r) {
    var cannot = r.has_requirement && !r.trustworthy;
    var chip;
    if (!r.has_requirement) chip = '<span style="color:#6b7280;font-size:12.5px;">No requirement set</span>';
    else if (cannot) chip = '<span style="background:#fef3c7;color:#92400e;font-weight:700;font-size:11.5px;padding:2px 9px;border-radius:999px;">Cannot send yet</span>';
    else if (r.met) chip = '<span style="background:#dcfce7;color:#166534;font-weight:700;font-size:11.5px;padding:2px 9px;border-radius:999px;">Met (+' + r.variance + ' h)</span>';
    else chip = '<span style="background:#fee2e2;color:#991b1b;font-weight:700;font-size:11.5px;padding:2px 9px;border-radius:999px;">' + Math.abs(r.variance) + ' h under</span>';

    return '<tr style="border-top:1px solid var(--border,#eef0f4);">'
      + '<td style="padding:9px 12px;"><strong>' + esc(r.name) + '</strong>'
        + (r.role_title ? '<div style="font-size:12px;color:#6b7280;">' + esc(r.role_title) + '</div>' : "")
        + (!r.email ? '<div style="font-size:12px;color:#b45309;">No email address on file</div>' : "")
      + '</td>'
      + '<td style="padding:9px 12px;"><input type="number" min="0" step="0.5" style="width:88px;" '
        + 'data-target-for="' + r.employee_id + '" value="' + (r.target_hours == null ? "" : r.target_hours) + '" placeholder="—" /></td>'
      + '<td style="padding:9px 12px;">' + hoursText(r.actual_hours)
        + (r.appointments != null ? '<div style="font-size:12px;color:#6b7280;">' + r.appointments + ' appt' + (r.appointments === 1 ? "" : "s") + '</div>' : "")
      + '</td>'
      + '<td style="padding:9px 12px;">' + chip
        + (cannot ? '<div style="font-size:12px;color:#92400e;margin-top:3px;max-width:340px;">' + esc(r.note || "") + '</div>' : "")
      + '</td></tr>';
  }

  function render(data) {
    STATE.data = data;
    var rows = (data.staff || []);
    var withReq = rows.filter(function (r) { return r.has_requirement; });
    var sendable = withReq.filter(function (r) { return r.trustworthy && r.email; });
    var blocked = withReq.length - sendable.length;

    MOUNT.innerHTML =
      '<h1 style="margin:0 0 4px;">Billable Requirements</h1>'
      + '<p style="color:var(--text-muted);font-size:13px;margin:0 0 16px;max-width:760px;">'
      + 'Each person\'s monthly requirement, and what they actually delivered in <strong>' + esc(data.period_label) + '</strong>. '
      + 'Hours are verified session hours from Rethink — appointments recorded as delivered and verified. '
      + 'They are not a payroll or claims figure.</p>'

      + (!data.sync_ok
        ? '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:11px 13px;margin-bottom:14px;font-size:13px;color:#92400e;">'
          + '⚠ The Rethink sync for ' + esc(data.period_label) + ' has not completed successfully, so these hours are not final. '
          + 'Nothing will be emailed until it has.</div>'
        : "")

      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">'
        + '<label style="font-size:13px;">Month <input type="month" id="bill-month" value="' + esc(data.period) + '" style="margin-left:6px;" /></label>'
        + '<button class="btn small" id="bill-send"' + (sendable.length ? "" : " disabled") + '>'
          + 'Send ' + sendable.length + ' summar' + (sendable.length === 1 ? "y" : "ies") + '</button>'
        + (blocked ? '<span style="font-size:12.5px;color:#92400e;">' + blocked + ' cannot be sent yet</span>' : "")
        + '<span id="bill-status" style="font-size:12.5px;color:var(--text-muted);"></span>'
      + '</div>'

      + '<div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;overflow:hidden;">'
      + '<table style="width:100%;border-collapse:collapse;font-size:13px;">'
      + '<thead><tr style="background:#f8fafc;">'
        + '<th style="text-align:left;padding:9px 12px;">Staff</th>'
        + '<th style="text-align:left;padding:9px 12px;">Requirement</th>'
        + '<th style="text-align:left;padding:9px 12px;">Delivered</th>'
        + '<th style="text-align:left;padding:9px 12px;">Result</th>'
      + '</tr></thead><tbody>'
      + (rows.length ? rows.map(rowHtml).join("") : '<tr><td colspan="4" style="padding:16px;color:#6b7280;">No staff on file.</td></tr>')
      + '</tbody></table></div>';

    wire();
  }

  function wire() {
    var monthEl = MOUNT.querySelector("#bill-month");
    if (monthEl) monthEl.addEventListener("change", function () { load(monthEl.value); });

    // Saved on blur rather than behind a Save button: it is one number, and a
    // grid of unsaved fields is how somebody sets six requirements and loses
    // five of them.
    MOUNT.querySelectorAll("[data-target-for]").forEach(function (input) {
      input.addEventListener("change", function () {
        var id = input.getAttribute("data-target-for");
        var status = MOUNT.querySelector("#bill-status");
        input.disabled = true;
        api("/api/billable/target/" + id, { method: "PUT", body: { target_hours: input.value } })
          .then(function () {
            input.disabled = false;
            if (status) { status.textContent = "Saved."; setTimeout(function () { status.textContent = ""; }, 1500); }
            load(STATE.month);
          })
          .catch(function (e) {
            input.disabled = false;
            alert(e.message || "Could not save that requirement.");
          });
      });
    });

    var send = MOUNT.querySelector("#bill-send");
    if (send) send.addEventListener("click", function () {
      var label = (STATE.data && STATE.data.period_label) || "this month";
      if (!confirm("Email each of these staff their billable summary for " + label + "?\n\nAnyone whose hours are still provisional, or whose month has not synced, is skipped rather than sent a figure we cannot stand behind.")) return;
      send.disabled = true;
      var status = MOUNT.querySelector("#bill-status");
      if (status) status.textContent = "Sending…";
      api("/api/billable/run", { method: "POST", body: { month: STATE.month } })
        .then(function (r) {
          if (status) {
            status.textContent = "Sent " + r.sent + "."
              + ((r.skipped || []).length ? " Skipped " + r.skipped.length + "." : "")
              + ((r.errors || []).length ? " " + r.errors.length + " failed." : "");
          }
          if ((r.skipped || []).length) {
            console.log("[billable] skipped:", r.skipped.map(function (s) { return s.name + ": " + s.why; }).join(" | "));
          }
          load(STATE.month);
        })
        .catch(function (e) {
          send.disabled = false;
          if (status) status.textContent = e.message || "Could not send.";
        });
    });
  }

  function load(month) {
    STATE.month = month || null;
    return api("/api/billable/summary" + (month ? "?month=" + encodeURIComponent(month) : ""))
      .then(render)
      .catch(function (e) {
        MOUNT.innerHTML = '<div class="empty-state">Could not load billable requirements: ' + esc(e.message) + '</div>';
      });
  }

  window.__renderBillable = function (mount) {
    MOUNT = mount;
    mount.innerHTML = '<div class="empty-state">Loading…</div>';
    return load(STATE.month);
  };
})();
