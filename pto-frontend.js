// pto-frontend.js -- PTO balances.
//
// The screen's job is to be honest about where each number came from. Accrual
// is per hour worked, and salaried staff largely do not clock hours, so every
// balance is either MEASURED (approved timecards) or ESTIMATED (their standard
// week, assumed). A row says which, on its face, rather than presenting one
// tidy figure that is quietly half-guessed.
(function () {
  "use strict";

  var MOUNT = null;
  var DATA = null;

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

  function h(n) { return n == null ? "—" : (Math.round(n * 100) / 100) + " h"; }

  function rowHtml(r) {
    if (r.error) {
      return '<tr style="border-top:1px solid var(--border,#eef0f4);">'
        + '<td style="padding:9px 12px;"><strong>' + esc(r.name) + '</strong></td>'
        + '<td colspan="5" style="padding:9px 12px;color:#92400e;">' + esc(r.error) + '</td></tr>';
    }
    var basis = r.hours_basis === "timecards"
      ? '<span title="' + esc(r.hours_basis_detail || "") + '" style="background:#dcfce7;color:#166534;font-weight:700;font-size:11px;padding:2px 8px;border-radius:999px;">Measured</span>'
      : '<span title="' + esc(r.hours_basis_detail || "") + '" style="background:#fef3c7;color:#92400e;font-weight:700;font-size:11px;padding:2px 8px;border-radius:999px;">Estimated</span>';

    return '<tr style="border-top:1px solid var(--border,#eef0f4);">'
      + '<td style="padding:9px 12px;"><strong>' + esc(r.name) + '</strong>'
        + (r.role_title ? '<div style="font-size:12px;color:#6b7280;">' + esc(r.role_title) + '</div>' : "")
      + '</td>'
      + '<td style="padding:9px 12px;">' + h(r.hours_worked) + '<div style="margin-top:3px;">' + basis + '</div></td>'
      + '<td style="padding:9px 12px;">' + h(r.accrued)
        + '<div style="font-size:11.5px;color:#6b7280;">at ' + r.rate + '/h</div></td>'
      + '<td style="padding:9px 12px;">' + h(r.taken)
        + (r.taken_assumed_days ? '<div style="font-size:11.5px;color:#92400e;">' + r.taken_assumed_days + ' full day(s) assumed at ' + (r.weekly_hours / 5) + ' h</div>' : "")
      + '</td>'
      + '<td style="padding:9px 12px;">' + (r.adjustments ? h(r.adjustments) : "—") + '</td>'
      + '<td style="padding:9px 12px;font-weight:700;font-size:14px;' + (r.balance < 0 ? "color:#b91c1c;" : "") + '">'
        + h(r.balance) + (r.estimated ? '<div style="font-size:11px;font-weight:400;color:#92400e;">estimate</div>' : "")
      + '</td></tr>';
  }

  function render(data) {
    DATA = data;
    var rows = data.staff || [];
    var estimated = rows.filter(function (r) { return !r.error && r.estimated; }).length;

    MOUNT.innerHTML =
      '<h1 style="margin:0 0 4px;">PTO Balances</h1>'
      + '<p style="color:var(--text-muted);font-size:13px;margin:0 0 6px;max-width:800px;">'
      + 'Accrues per hour worked at <strong>' + data.default_rate + ' hours per hour</strong>'
      + (Math.abs(data.default_rate - data.statutory_rate) < 1e-9
          ? ' — the Nevada statutory minimum (NRS 608.0197), 40 hours over a 2,080-hour year.'
          : ' (the Nevada statutory minimum is ' + data.statutory_rate + ').')
      + ' Leave taken comes from the existing time-off records. As of ' + esc(data.as_of) + '.</p>'

      + (estimated
        ? '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:11px 13px;margin:12px 0;font-size:13px;color:#92400e;">'
          + '⚠️ <strong>' + estimated + ' balance' + (estimated === 1 ? " is" : "s are") + ' an estimate.</strong> '
          + 'Accrual is per hour worked, and salaried staff do not clock hours — where there are no approved timecards, '
          + 'their standard week is assumed instead. Those rows are marked. Treat them as indicative, not as a figure to quote at somebody.'
          + '</div>'
        : "")

      + '<div style="display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;margin:14px 0;">'
        + '<label style="font-size:13px;">Accrual rate (h per hour worked)<br>'
          + '<input type="number" step="0.00001" min="0" id="pto-rate" value="' + data.default_rate + '" style="width:130px;margin-top:3px;" /></label>'
        + '<label style="font-size:13px;">Standard week (hours)<br>'
          + '<input type="number" step="0.5" min="1" max="168" id="pto-weekly" value="' + data.default_weekly_hours + '" style="width:110px;margin-top:3px;" /></label>'
        + '<button class="btn small" id="pto-save">Save defaults</button>'
        + '<span id="pto-status" style="font-size:12.5px;color:var(--text-muted);"></span>'
      + '</div>'

      + '<div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;overflow:hidden;">'
      + '<table style="width:100%;border-collapse:collapse;font-size:13px;">'
      + '<thead><tr style="background:#f8fafc;">'
        + '<th style="text-align:left;padding:9px 12px;">Staff</th>'
        + '<th style="text-align:left;padding:9px 12px;">Hours worked</th>'
        + '<th style="text-align:left;padding:9px 12px;">Accrued</th>'
        + '<th style="text-align:left;padding:9px 12px;">Taken</th>'
        + '<th style="text-align:left;padding:9px 12px;">Adjustments</th>'
        + '<th style="text-align:left;padding:9px 12px;">Balance</th>'
      + '</tr></thead><tbody>'
      + (rows.length ? rows.map(rowHtml).join("") : '<tr><td colspan="6" style="padding:16px;color:#6b7280;">No staff on file.</td></tr>')
      + '</tbody></table></div>'

      + '<p style="font-size:12px;color:var(--text-muted);margin-top:12px;max-width:800px;">'
      + 'A balance is accrued − taken + adjustments. Nothing here writes to payroll; it is a record for a person to act on. '
      + 'Use an adjustment to carry in an opening balance or correct a figure — every adjustment needs a reason.</p>';

    wire();
  }

  function wire() {
    var save = MOUNT.querySelector("#pto-save");
    if (save) save.addEventListener("click", function () {
      var status = MOUNT.querySelector("#pto-status");
      save.disabled = true;
      api("/api/pto/settings", {
        method: "PUT",
        body: {
          rate: MOUNT.querySelector("#pto-rate").value,
          weekly_hours: MOUNT.querySelector("#pto-weekly").value,
        },
      }).then(function () {
        save.disabled = false;
        if (status) { status.textContent = "Saved."; setTimeout(function () { status.textContent = ""; }, 1500); }
        load();
      }).catch(function (e) {
        save.disabled = false;
        if (status) status.textContent = e.message || "Could not save.";
      });
    });
  }

  function load() {
    return api("/api/pto/roster").then(render).catch(function (e) {
      MOUNT.innerHTML = '<div class="empty-state">Could not load PTO balances: ' + esc(e.message) + '</div>';
    });
  }

  window.__renderPto = function (mount) {
    MOUNT = mount;
    mount.innerHTML = '<div class="empty-state">Loading…</div>';
    return load();
  };
})();
