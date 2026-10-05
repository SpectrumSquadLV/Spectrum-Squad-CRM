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
        + '<td colspan="7" style="padding:9px 12px;color:#92400e;">' + esc(r.error) + '</td></tr>';
    }
    // The old badge said "Measured" for timecards and "Estimated" for anything
    // else. There is no estimate any more -- accrual reads only real synced
    // hours -- so what the badge has to say now is whether Rethink has sent
    // everything for the period, because an unsynced month is the one thing
    // that can still move a balance.
    var basis = r.unsynced_months
      ? '<span title="' + esc(r.hours_basis_detail || "") + '" style="background:#fef3c7;color:#92400e;font-weight:700;font-size:11px;padding:2px 8px;border-radius:999px;">'
        + r.unsynced_months + ' month(s) not synced</span>'
      : '<span title="' + esc(r.hours_basis_detail || "") + '" style="background:#dcfce7;color:#166534;font-weight:700;font-size:11px;padding:2px 8px;border-radius:999px;">Rethink</span>';

    if (r.not_yet_eligible) {
      return '<tr style="border-top:1px solid var(--border,#eef0f4);">'
        + '<td style="padding:9px 12px;"><strong>' + esc(r.name) + '</strong>'
          + (r.role_title ? '<div style="font-size:12px;color:#6b7280;">' + esc(r.role_title) + '</div>' : "")
        + '</td>'
        + '<td colspan="7" style="padding:9px 12px;color:#6b7280;">' + esc(r.hours_basis_detail || "Not yet accruing.") + '</td></tr>';
    }

    var el = r.eligibility || {};
    return '<tr style="border-top:1px solid var(--border,#eef0f4);">'
      + '<td style="padding:9px 12px;"><strong>' + esc(r.name) + '</strong>'
        + (r.role_title ? '<div style="font-size:12px;color:#6b7280;">' + esc(r.role_title) + '</div>' : "")
        + '<button class="pto-audit" data-id="' + r.employee_id + '" style="all:unset;cursor:pointer;color:#1b2a6b;'
          + 'font-size:11.5px;font-weight:700;text-decoration:underline;margin-top:3px;display:block;">See the working</button>'
      + '</td>'
      // Hire date, the 90-day date and the accrual start, side by side. These
      // three are the first thing anybody asks about a PTO figure, and deriving
      // them by hand from a hire date is how disputes start.
      + '<td style="padding:9px 12px;font-size:12.5px;">' + esc(el.hire || "—")
        + '<div style="color:#6b7280;">+90: ' + esc(el.waiting_ends || "—") + '</div></td>'
      + '<td style="padding:9px 12px;font-size:12.5px;font-weight:700;">' + esc(el.start || "—")
        + '<div style="font-weight:400;color:#6b7280;font-size:11px;">' + esc(el.reason || "") + '</div></td>'
      + '<td style="padding:9px 12px;">' + h(r.hours_worked)
        + '<div style="font-size:11.5px;color:#6b7280;">' + h(r.hours_billable) + ' billable · '
          + h(r.hours_nonbillable) + ' non-billable</div>'
        + (r.hours_unclassified > 0
            ? '<div style="font-size:11.5px;color:#92400e;" title="Rethink could not classify these, so they are not accrued on.">'
              + h(r.hours_unclassified) + ' unclassified, excluded</div>' : "")
        + '<div style="margin-top:3px;">' + basis + '</div></td>'
      + '<td style="padding:9px 12px;">' + h(r.accrued)
        + '<div style="font-size:11.5px;color:#6b7280;">at ' + r.rate + '/h'
          + (r.annual_cap > 0 ? ', cap ' + r.annual_cap + '/yr' : '') + '</div>'
        // Hours the cap prevented accruing, shown rather than dropped: somebody
        // will ask why a full year of work produced the cap and not more.
        + (r.forfeited_to_cap > 0
            ? '<div style="font-size:11.5px;color:#92400e;" title="Held back by the annual cap.">'
              + h(r.forfeited_to_cap) + ' above the cap</div>'
            : "")
      + '</td>'
      + '<td style="padding:9px 12px;">' + h(r.taken)
        + (r.taken_assumed_days ? '<div style="font-size:11.5px;color:#92400e;">' + r.taken_assumed_days + ' full day(s) assumed at ' + (r.weekly_hours / 5) + ' h</div>' : "")
      + '</td>'
      + '<td style="padding:9px 12px;">' + (r.adjustments ? h(r.adjustments) : "—") + '</td>'
      + '<td style="padding:9px 12px;font-weight:700;font-size:14px;' + (r.balance < 0 ? "color:#b91c1c;" : "") + '">'
        + h(r.balance) + (r.estimated ? '<div style="font-size:11px;font-weight:400;color:#92400e;">estimate</div>' : "")
      + '</td></tr>';
  }

  // THE WORKING BEHIND ONE BALANCE.
  //
  // The roster answers "how much"; this answers "why", which is the question
  // that actually arrives. Every row the ledger holds, in date order, with the
  // running balance beside it -- so a figure can be walked back to the month
  // of hours that produced it rather than taken on trust.
  function auditModal(id) {
    fetch("/api/pto/ledger/" + id).then(function (r) { return r.json(); }).then(function (d) {
      var bd = document.createElement("div");
      bd.className = "modal-backdrop";
      var el = d.eligibility || {};
      var rows = (d.rows || []).map(function (r) {
        var kindColor = r.kind === "accrual" ? "#166534" : (r.kind === "usage" ? "#b91c1c" : "#92400e");
        var amount = r.kind === "accrual" ? "+" + h(r.pto_earned)
          : (r.kind === "usage" ? "−" + h(r.pto_used)
            : (Number(r.adjustment) >= 0 ? "+" : "−") + h(Math.abs(Number(r.adjustment))));
        return '<tr style="border-top:1px solid #f0ede3;">'
          + '<td style="padding:7px 10px;font-size:12.5px;">' + esc(r.transaction_date || "")
            + (r.period_start ? '<div style="color:#6b7280;font-size:11px;">' + esc(r.period_start) + ' → ' + esc(r.period_end) + '</div>' : "")
          + '</td>'
          + '<td style="padding:7px 10px;"><span style="color:' + kindColor + ';font-weight:700;font-size:11.5px;text-transform:uppercase;">'
            + esc(r.kind) + '</span></td>'
          + '<td style="padding:7px 10px;font-size:12.5px;">'
            + (r.eligible_hours == null ? "—" : h(r.eligible_hours)
                + (r.billable_hours != null ? '<div style="color:#6b7280;font-size:11px;">'
                    + h(r.billable_hours) + ' b · ' + h(r.nonbillable_hours) + ' nb</div>' : ""))
          + '</td>'
          + '<td style="padding:7px 10px;font-size:12.5px;">' + (r.accrual_rate == null ? "—" : r.accrual_rate) + '</td>'
          + '<td style="padding:7px 10px;font-size:12.5px;font-weight:700;color:' + kindColor + ';">' + amount + '</td>'
          + '<td style="padding:7px 10px;font-size:12.5px;font-weight:700;">' + h(r.balance_after) + '</td>'
          + '<td style="padding:7px 10px;font-size:11.5px;color:#6b7280;">' + esc(r.reason || "")
            + '<div style="font-size:10.5px;">' + esc(r.source || "") + '</div></td>'
          + '</tr>';
      }).join("");

      bd.innerHTML = '<div class="modal" style="max-width:900px;">'
        + '<div class="modal-header"><div><h2>' + esc((d.employee || {}).name || "PTO") + '</h2>'
          + '<div style="font-size:12.5px;color:#6b7280;">Hired ' + esc(el.hire || "—")
            + ' · 90 days complete ' + esc(el.waiting_ends || "—")
            + ' · accrual starts <strong>' + esc(el.start || "—") + '</strong></div>'
        + '</div><button class="close-btn">✕</button></div>'
        + '<div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:10px 12px;'
          + 'margin-bottom:12px;font-size:12.5px;color:#312e81;">' + esc(el.reason || "")
          + ' Accrual is ' + ((d.policy || {}).rate || "0.038") + ' h per hour actually worked,'
          + ' on billable and non-billable hours combined.</div>'
        + (d.built
          ? '<div style="background:#fff;border:1px solid #e6e1d4;border-radius:10px;overflow:auto;max-height:440px;">'
            + '<table style="width:100%;border-collapse:collapse;"><thead><tr style="background:#faf9f5;text-align:left;color:#6b7280;font-size:11.5px;">'
              + '<th style="padding:7px 10px;">Date</th><th style="padding:7px 10px;">Kind</th>'
              + '<th style="padding:7px 10px;">Eligible hours</th><th style="padding:7px 10px;">Rate</th>'
              + '<th style="padding:7px 10px;">Change</th><th style="padding:7px 10px;">Balance</th>'
              + '<th style="padding:7px 10px;">Why</th>'
            + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
          // Never built is not the same as nothing earned, and the screen must
          // not let somebody read it that way.
          : '<div style="background:#fff8e6;border:1px solid #f3e0b0;border-radius:10px;padding:14px;font-size:13px;color:#92400e;">'
            + '<strong>No ledger has been built for this person yet.</strong> That is not a balance of zero — '
            + 'it means the historical recalculation has not been run. Preview it first from the PTO screen.</div>')
        + '</div>';
      document.body.appendChild(bd);
      bd.querySelector(".close-btn").addEventListener("click", function () { bd.remove(); });
      bd.addEventListener("click", function (e) { if (e.target === bd) bd.remove(); });
    }).catch(function (e) { alert(e.message || "Could not load the ledger."); });
  }

  function render(data) {
    DATA = data;
    var rows = data.staff || [];
    var unsynced = (data.staff || []).filter(function (x) { return x.unsynced_months > 0; }).length;

    MOUNT.innerHTML =
      '<h1 style="margin:0 0 4px;">PTO Balances</h1>'
      + '<p style="color:var(--text-muted);font-size:13px;margin:0 0 6px;max-width:800px;">'
      + 'Accrues per hour worked at <strong>' + data.default_rate + ' hours per hour</strong>'
      + (Math.abs(data.default_rate - data.statutory_rate) < 1e-9
          ? ' — the Nevada statutory minimum (NRS 608.0197), 40 hours over a 2,080-hour year.'
          : ' (the Nevada statutory minimum is ' + data.statutory_rate + ').')
      + ' Leave taken comes from the existing time-off records. As of ' + esc(data.as_of) + '.</p>'
      + '<p style="color:var(--text-muted);font-size:13px;margin:0 0 6px;max-width:800px;">'
      + (data.default_annual_cap > 0
          ? 'Accrual is capped at <strong>' + data.default_annual_cap + ' hours per benefit year</strong>, counted from each person\'s hire anniversary'
            + (data.default_annual_cap === data.statutory_cap ? ' — the Nevada maximum.' : '.')
          : 'Accrual is <strong>not capped</strong>.')
      + '</p>'

      // This banner used to explain the assumed standard week. That mechanism
      // is gone -- nothing is assumed any more -- so the warning had to change
      // with it rather than keep describing a behaviour the code no longer
      // has. What can still move a balance now is a month Rethink has not
      // sent, and that is what it says.
      + (unsynced
        ? '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:11px 13px;margin:12px 0;font-size:13px;color:#92400e;">'
          + '⚠ <strong>' + unsynced + ' ' + (unsynced === 1 ? "person has" : "people have") + ' months that have not been synced from Rethink.</strong> '
          + 'Those hours are not counted, so these balances can still rise once the sync catches up. '
          + 'A month with nothing synced is not a month with no work in it.'
          // The fix, offered where the problem is stated. The automatic sync
          // only ever fetches the CURRENT month, so every earlier one has to
          // be asked for -- and a warning you cannot act on from the screen
          // you are reading it on is a warning that gets ignored.
          + '<div style="margin-top:9px;"><button class="btn small" id="pto-backfill">Fetch the missing months from Rethink</button>'
            + '<span id="pto-backfill-res" style="font-size:12px;margin-left:8px;"></span></div>'
          + '</div>'
        : "")

      + '<div style="display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;margin:14px 0;">'
        + '<label style="font-size:13px;">Accrual rate (h per hour worked)<br>'
          + '<input type="number" step="0.00001" min="0" id="pto-rate" value="' + data.default_rate + '" style="width:130px;margin-top:3px;" /></label>'
        + '<label style="font-size:13px;">Standard week (hours)<br>'
          + '<input type="number" step="0.5" min="1" max="168" id="pto-weekly" value="' + data.default_weekly_hours + '" style="width:110px;margin-top:3px;" /></label>'
        + '<label style="font-size:13px;">Annual cap (hours, 0 = none)<br>'
          + '<input type="number" step="1" min="0" id="pto-cap" value="' + data.default_annual_cap + '" style="width:130px;margin-top:3px;" /></label>'
        + '<button class="btn small" id="pto-save">Save defaults</button>'
        + '<span id="pto-status" style="font-size:12.5px;color:var(--text-muted);"></span>'
      + '</div>'

      // overflow-x:auto, NOT hidden. The audit view needs eight columns and
      // `hidden` does exactly what it says -- on a narrow window the right-hand
      // columns are clipped away with no scrollbar to reveal them, and the
      // column that disappears first is Balance, which is the one number
      // anybody came to the screen for.
      + '<div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;overflow-x:auto;">'
      + '<table style="width:100%;border-collapse:collapse;font-size:13px;min-width:1040px;">'
      + '<thead><tr style="background:#f8fafc;">'
        + '<th style="text-align:left;padding:9px 12px;">Staff</th>'
        + '<th style="text-align:left;padding:9px 12px;">Hired / +90 days</th>'
        + '<th style="text-align:left;padding:9px 12px;">Accrual starts</th>'
        + '<th style="text-align:left;padding:9px 12px;">Eligible hours worked</th>'
        + '<th style="text-align:left;padding:9px 12px;">Gross earned</th>'
        + '<th style="text-align:left;padding:9px 12px;">Used</th>'
        + '<th style="text-align:left;padding:9px 12px;">Adjustments</th>'
        + '<th style="text-align:left;padding:9px 12px;">Balance</th>'
      + '</tr></thead><tbody>'
      + (rows.length ? rows.map(rowHtml).join("") : '<tr><td colspan="8" style="padding:16px;color:#6b7280;">No staff on file.</td></tr>')
      + '</tbody></table></div>'

      + '<p style="font-size:12px;color:var(--text-muted);margin-top:12px;max-width:800px;">'
      + 'A balance is accrued − taken + adjustments. Nothing here writes to payroll; it is a record for a person to act on. '
      + 'Use an adjustment to carry in an opening balance or correct a figure — every adjustment needs a reason.</p>'
      + '<div style="margin-top:12px;"><button class="btn secondary" id="pto-preview">Recalculate from source…</button>'
        + '<span style="font-size:11.5px;color:#6b7280;margin-left:8px;">Shows what would change before anything is written.</span></div>';

    wire();
  }

  // THE HISTORICAL RECALCULATION, SHOWN BEFORE IT RUNS.
  //
  // The policy is explicit that the recalculation must be visible before any
  // destructive historical update executes, so the button PREVIEWS. Applying
  // is a second, deliberate click against a list of who moves and by how much.
  // Every applied run is snapshotted and can be put back.
  // FETCHING THE MONTHS NOBODY ASKED FOR.
  //
  // The automatic Rethink sync passes no month, so it only ever fetches the
  // current one. Every month before it has to be requested, and until it is
  // those hours simply are not in the CRM -- which is why most balances on
  // this screen are short.
  //
  // It runs in the background and this polls, because a year of months is
  // minutes of upstream calls and a browser that gives up halfway leaves
  // somebody unsure whether it is still going.
  function backfillModal() {
    var bd = document.createElement("div");
    bd.className = "modal-backdrop";
    bd.innerHTML = '<div class="modal" style="max-width:640px;">'
      + '<div class="modal-header"><div><h2>Fetch missing months from Rethink</h2>'
      + '<div style="font-size:12.5px;color:var(--text-muted);">The automatic sync only ever fetches the current month. Earlier ones have to be asked for.</div>'
      + '</div><button class="close-btn">&times;</button></div>'
      + '<div id="pto-bf-body" style="font-size:13px;color:var(--text-muted);">Checking what is missing…</div>'
      + '</div>';
    document.body.appendChild(bd);
    var close = function () { bd.remove(); };
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", function (e) { if (e.target === bd) close(); });
    var body = bd.querySelector("#pto-bf-body");
    var timer = null;
    var stop = function () { if (timer) { clearInterval(timer); timer = null; } };
    bd.addEventListener("DOMNodeRemoved", stop);

    function paint(d) {
      var run = d.run;
      if (run && run.running) {
        var pct = run.total ? Math.round((run.done / run.total) * 100) : 0;
        body.innerHTML = '<div style="font-weight:700;color:#1b2a6b;margin-bottom:6px;">Fetching ' + esc(run.current || "") + '…</div>'
          + '<div style="background:#eef0f4;border-radius:999px;height:10px;overflow:hidden;margin-bottom:6px;">'
            + '<div style="background:#1b2a6b;height:100%;width:' + pct + '%;transition:width .3s;"></div></div>'
          + '<div style="font-size:12.5px;">' + run.done + ' of ' + run.total + ' month(s)'
          + (run.failed ? ' · <span style="color:#b91c1c;">' + run.failed + ' failed</span>' : '') + '</div>'
          + '<div style="font-size:12px;color:var(--text-muted);margin-top:8px;">You can close this; it keeps going.</div>';
        return;
      }
      if (run && run.finished_at) {
        // Failures are named, not folded into a total. "6 of 8" with no
        // indication of which two is a message nobody can act on.
        var bad = (run.results || []).filter(function (r) { return !r.ok; });
        body.innerHTML = '<div style="background:' + (bad.length ? '#fff8e6' : '#e9f9ee') + ';border:1px solid '
            + (bad.length ? '#f3e0b0' : '#bfe6cd') + ';border-radius:10px;padding:11px 13px;font-size:13px;color:'
            + (bad.length ? '#92400e' : '#166534') + ';">'
          + '<strong>' + (run.total - run.failed) + ' of ' + run.total + ' month(s) fetched.</strong>'
          + (bad.length ? ' Not fetched: ' + esc(bad.map(function (r) { return r.month + " (" + (r.error || "failed") + ")"; }).join(", ")) : '')
          + '</div>'
          + '<div style="font-size:12.5px;color:var(--text-muted);margin-top:10px;">'
          + 'Balances on this screen now include those hours. Recalculate from source to write them into the ledger.</div>';
        stop();
        load();
        return;
      }
      var missing = d.missing_months || [];
      if (!missing.length) {
        body.innerHTML = '<div style="font-size:13px;">Nothing is missing between ' + esc(d.range.from) + ' and '
          + esc(d.range.to) + '. Every month has been fetched.</div>';
        return;
      }
      body.innerHTML = '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:11px 13px;'
          + 'font-size:13px;color:#92400e;margin-bottom:12px;"><strong>' + missing.length + ' month(s) have never been fetched:</strong> '
          + esc(missing.join(", ")) + '</div>'
        + (d.can_run
          ? '<div style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;">Each month is fetched in turn, '
            + 'and a month already fetched is simply replaced — running this again is safe.</div>'
            + '<button class="btn" id="pto-bf-go">Fetch ' + missing.length + ' month(s)</button>'
          : '<div style="font-size:12.5px;color:var(--text-muted);">Only the owner can start a backfill.</div>');
      var go = bd.querySelector("#pto-bf-go");
      if (go) go.addEventListener("click", function () {
        go.disabled = true;
        body.insertAdjacentHTML("beforeend", '<div style="font-size:12.5px;margin-top:8px;">Starting…</div>');
        api("/api/rethink/backfill", { method: "POST", body: { from: d.range.from, to: d.range.to } })
          .then(function () { poll(); timer = setInterval(poll, 2000); })
          .catch(function (e) { go.disabled = false; body.insertAdjacentHTML("beforeend",
            '<div style="color:#b91c1c;font-size:12.5px;margin-top:6px;">' + esc(e.message || "Could not start.") + '</div>'); });
      });
    }
    function poll() {
      fetch("/api/rethink/backfill").then(function (r) { return r.json(); }).then(paint)
        .catch(function () { /* a dropped poll is not a failure; the next one will do */ });
    }
    poll();
  }

  function recalcModal() {
    var bd = document.createElement("div");
    bd.className = "modal-backdrop";
    bd.innerHTML = '<div class="modal" style="max-width:820px;">'
      + '<div class="modal-header"><div><h2>Recalculate PTO from source</h2>'
      + '<div style="font-size:12.5px;color:#6b7280;">Rebuilds every balance from Rethink hours, the 90-day rule and the 1 March 2026 start.</div>'
      + '</div><button class="close-btn">✕</button></div>'
      + '<div id="pto-recalc-body" style="font-size:13px;color:#6b7280;">Working out what would change…</div>'
      + '</div>';
    document.body.appendChild(bd);
    bd.querySelector(".close-btn").addEventListener("click", function () { bd.remove(); });
    bd.addEventListener("click", function (e) { if (e.target === bd) bd.remove(); });
    var body = bd.querySelector("#pto-recalc-body");

    api("/api/pto/rebuild", { method: "POST", body: {} }).then(function (d) {
      var sum = d.summary || {};
      var moved = (d.employees || []).filter(function (e) { return e.delta != null && Math.abs(e.delta) >= 0.01; });
      var fresh = (d.employees || []).filter(function (e) { return e.delta == null; });
      var rows = (d.employees || []).map(function (e) {
        var delta = e.delta == null ? '<span style="color:#6b7280;">new</span>'
          : (e.delta > 0 ? '<span style="color:#166534;font-weight:700;">+' + h(e.delta) + '</span>'
            : (e.delta < 0 ? '<span style="color:#b91c1c;font-weight:700;">' + h(e.delta) + '</span>'
              : '<span style="color:#6b7280;">no change</span>'));
        return '<tr style="border-top:1px solid #f0ede3;">'
          + '<td style="padding:6px 10px;font-size:12.5px;">' + esc(e.name) + '</td>'
          + '<td style="padding:6px 10px;font-size:12px;color:#6b7280;">' + esc(e.accrual_start || "—") + '</td>'
          + '<td style="padding:6px 10px;font-size:12.5px;">' + (e.hours == null ? "—" : h(e.hours)) + '</td>'
          + '<td style="padding:6px 10px;font-size:12.5px;">' + (e.prior_balance == null ? "—" : h(e.prior_balance)) + '</td>'
          + '<td style="padding:6px 10px;font-size:12.5px;font-weight:700;">' + (e.balance == null ? "—" : h(e.balance)) + '</td>'
          + '<td style="padding:6px 10px;">' + delta + '</td>'
          + '<td style="padding:6px 10px;font-size:11.5px;color:#92400e;">'
            + (e.not_yet_eligible ? "inside 90 days" : (e.unsynced_months ? e.unsynced_months + " month(s) unsynced" : "")) + '</td>'
          + '</tr>';
      }).join("");

      body.innerHTML =
        '<div style="background:#fff8e6;border:1px solid #f3e0b0;border-radius:10px;padding:10px 12px;'
          + 'margin-bottom:12px;font-size:12.5px;color:#92400e;"><strong>Nothing has changed yet.</strong> '
          + 'This is what applying would do. ' + (sum.changed || 0) + ' of ' + (sum.employees || 0)
          + ' balance(s) would move' + (fresh.length ? ', and ' + fresh.length + ' would be built for the first time' : '')
          + '. ' + (sum.with_unsynced_months ? sum.with_unsynced_months + ' person(s) have months Rethink has not sent, which are not counted.' : '')
        + '</div>'
        + '<div style="border:1px solid #e6e1d4;border-radius:10px;overflow:auto;max-height:360px;margin-bottom:12px;">'
        + '<table style="width:100%;border-collapse:collapse;"><thead><tr style="background:#faf9f5;text-align:left;color:#6b7280;font-size:11.5px;">'
          + '<th style="padding:6px 10px;">Staff</th><th style="padding:6px 10px;">Accrual starts</th>'
          + '<th style="padding:6px 10px;">Eligible hours</th><th style="padding:6px 10px;">Was</th>'
          + '<th style="padding:6px 10px;">Becomes</th><th style="padding:6px 10px;">Change</th><th style="padding:6px 10px;"></th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        + '<div style="display:flex;gap:10px;align-items:center;">'
          + '<button class="btn" id="pto-apply">Apply to all ' + (sum.employees || 0) + '</button>'
          + '<span id="pto-apply-res" style="font-size:12.5px;color:#6b7280;">Every applied run is saved and can be put back.</span>'
        + '</div>';

      bd.querySelector("#pto-apply").addEventListener("click", function () {
        if (!confirm("Replace " + (sum.employees || 0) + " PTO balance(s) with the recalculated figures?\n\n"
          + "The current ledger is saved first, so this can be undone.")) return;
        var res = bd.querySelector("#pto-apply-res");
        res.textContent = "Applying…";
        api("/api/pto/rebuild", { method: "POST", body: { apply: true, note: "Historical recalculation" } })
          .then(function (out) {
            res.innerHTML = 'Done. Batch <code style="user-select:all;">' + esc(out.batch_id || "") + '</code> — quote it to undo.';
            load();
          }).catch(function (e) { res.textContent = e.message || "Could not apply."; });
      });
    }).catch(function (e) { body.textContent = e.message || "Could not work out the change."; });
  }

  function wire() {
    MOUNT.querySelectorAll(".pto-audit").forEach(function (b) {
      b.addEventListener("click", function () { auditModal(b.getAttribute("data-id")); });
    });
    var prev = MOUNT.querySelector("#pto-preview");
    if (prev) prev.addEventListener("click", function () { recalcModal(); });
    var bf = MOUNT.querySelector("#pto-backfill");
    if (bf) bf.addEventListener("click", function () { backfillModal(); });
    var save = MOUNT.querySelector("#pto-save");
    if (save) save.addEventListener("click", function () {
      var status = MOUNT.querySelector("#pto-status");
      save.disabled = true;
      api("/api/pto/settings", {
        method: "PUT",
        body: {
          rate: MOUNT.querySelector("#pto-rate").value,
          weekly_hours: MOUNT.querySelector("#pto-weekly").value,
          annual_cap: MOUNT.querySelector("#pto-cap").value,
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
