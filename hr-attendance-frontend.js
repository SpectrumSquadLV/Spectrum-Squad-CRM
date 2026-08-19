// hr-attendance-frontend.js -- Employee Attendance UI for the staff card.
//
// Exposes window.HRAttendance.renderSection(container, employeeId, employeeName)
// which the staff modal calls to render the attendance section: a 90-day flag
// counter, a "Log attendance flag" form, the flag history, and per-flag actions
// (sign in-app with a draw-to-sign pad, email a signing link to the employee,
// download the signed PDF, delete). Uses the app's global api() helper.
(function () {
  "use strict";

  var REASONS = ["No call/no show", "Late arrival", "Early departure", "Excessive callouts", "Other"];
  var _types = [];  // the attendance matrix, cached from the last load

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function fmt(d) {
    if (!d) return "—";
    try { var dt = new Date(d); if (isNaN(dt)) return String(d); return dt.toLocaleDateString(); } catch (e) { return String(d); }
  }

  async function renderSection(container, empId, empName) {
    if (!container) return;
    container.innerHTML = '<div style="font-size:12.5px; color:var(--text-muted);">Loading attendance…</div>';
    var data;
    try { data = await api("/api/attendance/employee/" + empId); }
    catch (e) { container.innerHTML = '<div class="empty-state">Attendance unavailable: ' + esc(e.message) + "</div>"; return; }
    var flags = (data && data.flags) || [];
    var count90 = (data && data.count_90d) || 0;
    var score = (data && data.score) || null;
    _types = (data && data.types) || _types;

    var rows = flags.length ? flags.map(function (f) {
      var status = f.acknowledged
        ? '<span class="tag" style="background:#dcfce7; color:#166534;">Acknowledged</span>'
        : '<span class="tag" style="background:#fef3c7; color:#92400e;">Pending signature</span>';
      var voided = f.voided === true || f.voided === "t";
      var actions = voided
        ? '<span style="font-size:11.5px; color:var(--text-muted);">voided</span>'
        : (f.acknowledged
          ? (f.has_pdf ? '<a class="btn small secondary" href="/api/attendance/flag/' + f.id + '/pdf" target="_blank" rel="noopener">Download PDF</a>' : '<span style="font-size:11.5px; color:var(--text-muted);">signed</span>')
          : '<button class="btn small" data-att-sign="' + f.id + '">Sign now</button>'
            + '<button class="btn small secondary" data-att-email="' + f.id + '">Email link</button>')
          + (voided ? "" : '<button class="btn small secondary" data-att-void="' + f.id + '" title="Void this occurrence">Void</button>');
      var ptsTag = f.points == null ? ""
        : ' <span class="tag" style="background:' + (f.points < 0 ? "#dcfce7" : "#e0e7ff") + ';color:' + (f.points < 0 ? "#166534" : "#3730a3") + ';">' + (f.points > 0 ? "+" : "") + f.points + " pts</span>";
      return '<div class="task-row" style="align-items:flex-start;' + (voided ? "opacity:.55;" : "") + '">'
        + '<div class="info"><strong>' + esc(f.reason || "Occurrence") + "</strong>" + ptsTag + ' · ' + esc(fmt(f.incident_date))
        + (f.notice_hours != null ? '<div class="due">' + f.notice_hours + " hrs notice" + (f.emergency ? " · emergency" : "") + (f.documentation ? " · documented" : "") + "</div>" : "")
        + (f.notes ? '<div class="due">' + esc(f.notes) + "</div>" : "")
        + (voided ? '<div class="due" style="color:#b45309;">Voided' + (f.voided_by ? " by " + esc(f.voided_by) : "") + (f.voided_reason ? ": " + esc(f.voided_reason) : "") + "</div>" : "")
        + (f.acknowledged && f.signed_date ? '<div class="due">Signed ' + esc(fmt(f.signed_date)) + (f.typed_name ? " by " + esc(f.typed_name) : "") + "</div>" : "")
        + (voided ? "" : '<div style="margin-top:4px;">' + status + "</div>") + "</div>"
        + '<div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">' + actions + "</div></div>";
    }).join("") : '<div class="empty-state">No attendance flags on record.</div>';

    var chip = function (label, value, tone) {
      return '<span class="tag" style="background:' + tone[0] + ';color:' + tone[1] + ';font-size:12.5px;padding:5px 11px;">' + esc(label) + ": <strong>" + esc(String(value)) + "</strong></span>";
    };
    var head = score
      ? chip("30-day points", score.points_30, score.points_30 >= 1.5 ? ["#fef3c7", "#92400e"] : ["#dcfce7", "#166534"])
        + " " + chip("90-day points", score.points_90, score.points_90 >= 3 ? ["#fee2e2", "#991b1b"] : ["#dcfce7", "#166534"])
        + " " + pill(score.discipline_level) + " " + pill(score.review_level)
        + " " + chip("Bonus", score.bonus_eligible ? "$50 on track" : score.bonus_status, score.bonus_eligible ? ["#dcfce7", "#166534"] : ["#f1f5f9", "#475569"])
      : chip("Flags in last 90 days", count90, count90 ? ["#fee2e2", "#991b1b"] : ["#dcfce7", "#166534"]);

    container.innerHTML =
      '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap; margin-bottom:8px;">'
      + '<div style="display:flex; gap:6px; flex-wrap:wrap;">' + head + "</div>"
      + '<button class="btn small" id="att-add-btn">+ Log occurrence</button></div>'
      + (score && score.review_action ? '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Monthly review action: <strong>' + esc(score.review_action) + "</strong>" + (score.next_bonus_date ? " · next bonus date " + esc(score.next_bonus_date) : "") + "</div>" : "")
      + '<div id="att-add-form"></div>'
      + '<div id="att-list">' + rows + "</div>";

    container.querySelector("#att-add-btn").addEventListener("click", function () { showAddForm(container, empId, empName); });
    wireRows(container, empId, empName);
  }

  function wireRows(container, empId, empName) {
    container.querySelectorAll("[data-att-sign]").forEach(function (b) {
      b.addEventListener("click", function () { openSignModal(b.getAttribute("data-att-sign"), empName, function () { renderSection(container, empId, empName); }); });
    });
    container.querySelectorAll("[data-att-email]").forEach(function (b) {
      b.addEventListener("click", async function () {
        b.disabled = true; b.textContent = "Sending…";
        try { await api("/api/attendance/flag/" + b.getAttribute("data-att-email") + "/send-ack", { method: "POST" }); b.textContent = "Sent ✓"; }
        catch (e) { b.disabled = false; b.textContent = "Email link"; alert(e.message); }
      });
    });
    // Voided, never deleted: this is a disciplinary record, and a row that
    // vanishes takes the reason with it.
    container.querySelectorAll("[data-att-void]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var reason = prompt("Void this occurrence?\n\nIt stays on the record, marked voided, and stops counting towards points. Why is it being voided?");
        if (reason === null) return;
        if (!String(reason).trim()) { alert("A reason is required."); return; }
        try { await api("/api/attendance/flag/" + b.getAttribute("data-att-void") + "/void", { method: "POST", body: { reason: String(reason).trim() } }); renderSection(container, empId, empName); }
        catch (e) { alert(e.message); }
      });
    });
  }

  function showAddForm(container, empId, empName) {
    var box = container.querySelector("#att-add-form");
    if (!box) return;
    var today = new Date().toISOString().slice(0, 10);
    // Occurrence types come from the matrix, so the point value is never typed
    // in by hand and the list stays in step with the policy.
    var types = _types || [];
    var opts = function (kind) {
      return types.filter(function (t) { return t.kind === kind && t.active !== false; })
        .map(function (t) {
          return '<option value="' + esc(t.key) + '">' + esc(t.label) + " (" + (t.points > 0 ? "+" : "") + t.points + ")</option>";
        }).join("");
    };
    box.innerHTML =
      '<div style="border:1px solid var(--border,#eee); border-radius:10px; padding:12px; margin-bottom:10px;">'
      + '<div class="form-grid" style="gap:8px;">'
      + '<div class="field"><label>Date</label><input id="att-date" type="date" value="' + today + '" /></div>'
      + '<div class="field"><label>Occurrence</label><select id="att-type">'
        + '<optgroup label="Occurrences">' + opts("occurrence") + "</optgroup>"
        + '<optgroup label="Earning back points">' + opts("earnback") + "</optgroup>"
        + "</select></div>"
      + '<div class="field"><label>Shift start</label><input id="att-shift" placeholder="9:00 AM" /></div>'
      + '<div class="field"><label>Time notified</label><input id="att-notified" placeholder="7:44 AM" /></div>'
      + '</div>'
      + '<div style="display:flex; gap:18px; margin:8px 0; flex-wrap:wrap;">'
        + '<label style="font-size:12.5px; display:flex; align-items:center; gap:6px;"><input id="att-emerg" type="checkbox" style="width:auto;" /> Emergency</label>'
        + '<label style="font-size:12.5px; display:flex; align-items:center; gap:6px;"><input id="att-doc" type="checkbox" style="width:auto;" /> Documentation provided</label>'
        + '<label style="font-size:12.5px; display:flex; align-items:center; gap:6px;"><input id="att-notify" type="checkbox" checked style="width:auto;" /> Email the staff member</label>'
      + "</div>"
      + '<div class="field full"><label>Notes</label><textarea id="att-notes" rows="2" style="width:100%;"></textarea></div>'
      + '<div style="margin-top:8px; display:flex; gap:8px;"><button class="btn small" id="att-save">Save occurrence</button><button class="btn small secondary" id="att-cancel">Cancel</button><span id="att-status" style="font-size:12.5px; color:var(--text-muted); align-self:center;"></span></div>'
      + "</div>";
    box.querySelector("#att-cancel").addEventListener("click", function () { box.innerHTML = ""; });
    box.querySelector("#att-save").addEventListener("click", async function () {
      var body = {
        incident_date: box.querySelector("#att-date").value || null,
        type_key: box.querySelector("#att-type").value,
        shift_start: box.querySelector("#att-shift").value || null,
        time_notified: box.querySelector("#att-notified").value || null,
        emergency: box.querySelector("#att-emerg").checked,
        documentation: box.querySelector("#att-doc").checked,
        notify: box.querySelector("#att-notify").checked,
        notes: box.querySelector("#att-notes").value || null,
      };
      box.querySelector("#att-status").textContent = "Saving…";
      try { await api("/api/attendance/employee/" + empId, { method: "POST", body: body }); box.innerHTML = ""; renderSection(container, empId, empName); }
      catch (e) { box.querySelector("#att-status").textContent = e.message || "Could not save."; }
    });
  }

  // In-app draw-to-sign modal (staff signs on the manager's device).
  function openSignModal(flagId, empName, onDone) {
    var backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML =
      '<div class="modal" style="width:520px;">'
      + '<div class="modal-header"><h2>Sign acknowledgment</h2><button class="close-btn">✕</button></div>'
      + '<p style="font-size:13px; color:var(--text-muted); margin-top:0;">Hand the device to <strong>' + esc(empName || "the employee") + '</strong> to review and sign.</p>'
      + '<label style="font-weight:600; font-size:13px;">Draw signature</label>'
      + '<canvas id="att-pad" style="border:1px dashed #b9b3e0; border-radius:12px; width:100%; height:170px; touch-action:none; background:#fff; display:block; margin:6px 0;"></canvas>'
      + '<div style="display:flex; gap:8px; align-items:center;"><button class="btn small secondary" id="att-clear">Clear</button><span style="font-size:12px; color:var(--text-muted);">Sign with finger or mouse.</span></div>'
      + '<div class="field" style="margin-top:10px;"><label>Type full name</label><input id="att-typed" type="text" placeholder="Full name" /></div>'
      + '<div style="margin-top:14px; display:flex; gap:8px;"><button class="btn" id="att-do-sign">Sign &amp; save</button><span id="att-sign-status" style="font-size:12.5px; color:var(--text-muted); align-self:center;"></span></div>'
      + "</div>";
    document.body.appendChild(backdrop);
    var close = function () { backdrop.remove(); };
    backdrop.querySelector(".close-btn").addEventListener("click", close);
    backdrop.addEventListener("click", function (e) { if (e.target === backdrop) close(); });

    var canvas = backdrop.querySelector("#att-pad");
    var cctx, drawing = false, hasInk = false;
    function setup() {
      var ratio = window.devicePixelRatio || 1;
      var rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      cctx = canvas.getContext("2d");
      cctx.fillStyle = "#fff"; cctx.fillRect(0, 0, canvas.width, canvas.height);
      cctx.scale(ratio, ratio);
      cctx.strokeStyle = "#1b1440"; cctx.lineWidth = 2.2; cctx.lineCap = "round"; cctx.lineJoin = "round";
      function pos(e) { var r = canvas.getBoundingClientRect(); var t = e.touches ? e.touches[0] : e; return { x: t.clientX - r.left, y: t.clientY - r.top }; }
      function start(e) { drawing = true; var p = pos(e); cctx.beginPath(); cctx.moveTo(p.x, p.y); e.preventDefault(); }
      function move(e) { if (!drawing) return; var p = pos(e); cctx.lineTo(p.x, p.y); cctx.stroke(); hasInk = true; e.preventDefault(); }
      function end() { drawing = false; }
      canvas.addEventListener("mousedown", start); canvas.addEventListener("mousemove", move); window.addEventListener("mouseup", end);
      canvas.addEventListener("touchstart", start, { passive: false }); canvas.addEventListener("touchmove", move, { passive: false }); canvas.addEventListener("touchend", end);
    }
    // Defer to let the modal lay out so the canvas has a measured width.
    setTimeout(setup, 30);
    backdrop.querySelector("#att-clear").addEventListener("click", function () { if (cctx) { cctx.fillStyle = "#fff"; cctx.fillRect(0, 0, canvas.width, canvas.height); hasInk = false; } });

    backdrop.querySelector("#att-do-sign").addEventListener("click", async function () {
      var typed = (backdrop.querySelector("#att-typed").value || "").trim();
      var status = backdrop.querySelector("#att-sign-status");
      if (!typed) { status.textContent = "Please type the employee's full name."; return; }
      if (!hasInk) { status.textContent = "Please draw a signature."; return; }
      var btn = backdrop.querySelector("#att-do-sign"); btn.disabled = true; status.textContent = "Saving…";
      try {
        await api("/api/attendance/flag/" + flagId + "/sign", {
          method: "POST",
          body: { signature: canvas.toDataURL("image/jpeg", 0.85), typed_name: typed, sig_w: canvas.width, sig_h: canvas.height },
        });
        close();
        if (onDone) onDone();
      } catch (e) { btn.disabled = false; status.textContent = e.message || "Could not save."; }
    });
  }

  // ===================== ROSTER PAGE =====================
  // The whole team's attendance at a glance -- what the summary tab of the
  // "Attendance Log - RBTs" sheet did, computed from the CRM's own records.
  function levelTone(level) {
    return ({
      "Termination review": ["#fee2e2", "#991b1b"],
      "Final warning or probation": ["#fee2e2", "#991b1b"],
      "Written warning": ["#fef3c7", "#92400e"],
      "Verbal reminder": ["#e0f2fe", "#075985"],
      "Good standing": ["#dcfce7", "#166534"],
      "Leadership Review": ["#fee2e2", "#991b1b"],
      "Attendance Improvement Plan": ["#fef3c7", "#92400e"],
      "Coaching Conversation": ["#fef3c7", "#92400e"],
      "Meets Expectations": ["#e0f2fe", "#075985"],
      "Exceeds Expectations": ["#dcfce7", "#166534"],
    })[level] || ["#f1f5f9", "#475569"];
  }
  function pill(text) {
    var t = levelTone(text);
    return '<span class="tag" style="background:' + t[0] + ';color:' + t[1] + ';white-space:nowrap;">' + esc(text) + "</span>";
  }

  async function renderRoster(mount) {
    if (!mount) return true;
    mount.innerHTML = '<div class="empty-state">Loading attendance…</div>';
    var d;
    try { d = await api("/api/attendance/roster"); }
    catch (e) { mount.innerHTML = '<div class="empty-state">Attendance unavailable: ' + esc(e.message) + "</div>"; return true; }

    var t = d.totals || {};
    var tile = function (val, label, color) {
      return '<div style="flex:1;min-width:130px;background:var(--bg,#f7f8fb);border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:14px 16px;">' +
        '<div style="font-size:26px;font-weight:800;color:' + (color || "var(--brand-navy,#1b2a6b)") + ';">' + val + "</div>" +
        '<div style="font-size:12px;color:var(--text-muted);">' + esc(label) + "</div></div>";
    };

    var rows = (d.staff || []).slice().sort(function (a, b) {
      return b.points_30 - a.points_30 || b.points_90 - a.points_90 || String(a.name).localeCompare(String(b.name));
    }).map(function (s) {
      return '<tr class="att-row" data-emp="' + s.employee_id + '" style="cursor:pointer;border-bottom:1px solid var(--border,#eee);">' +
        '<td style="padding:9px 10px;"><strong>' + esc(s.name) + "</strong>" +
          '<div style="font-size:11.5px;color:var(--text-muted);">' + esc(s.role_title || "") + (s.hire_date ? " · hired " + esc(String(s.hire_date).slice(0, 10)) : "") + "</div></td>" +
        '<td style="padding:9px 10px;text-align:right;font-weight:700;">' + s.points_30 + "</td>" +
        '<td style="padding:9px 10px;text-align:right;font-weight:700;">' + s.points_90 + "</td>" +
        '<td style="padding:9px 10px;">' + pill(s.review_level) + "</td>" +
        '<td style="padding:9px 10px;">' + pill(s.discipline_level) + "</td>" +
        '<td style="padding:9px 10px;font-size:12.5px;">' + (s.bonus_eligible
            ? '<span style="color:#166534;font-weight:700;">$' + (d.bonus_amount || 50) + "</span>"
            : '<span style="color:var(--text-muted);">' + esc(s.bonus_status) + "</span>") +
          (s.next_bonus_date ? '<div style="font-size:11px;color:var(--text-muted);">next ' + esc(s.next_bonus_date) + "</div>" : "") + "</td>" +
        '<td style="padding:9px 10px;text-align:center;">' + (s.unsigned_acknowledgments
            ? '<span class="tag" style="background:#fef3c7;color:#92400e;">' + s.unsigned_acknowledgments + " unsigned</span>" : "—") + "</td>" +
        "</tr>";
    }).join("") || '<tr><td colspan="7"><div class="empty-state">No staff on the roster yet.</div></td></tr>';

    mount.innerHTML =
      '<div class="page-header"><div><h1>Staff Attendance</h1>' +
        '<p>Points, standing and bonus eligibility under the Attendance &amp; Punctuality Policy. Rolling 90 days for standing; the last 30 days for the monthly review.</p></div>' +
        '<div style="display:flex;gap:8px;"><button class="btn secondary small" id="att-matrix-btn">⚙ Attendance matrix</button>' +
        '<button class="btn secondary small" id="att-import-btn">⇩ Import attendance log</button>' +
        '<button class="btn secondary small" id="att-review-btn">✉ Send monthly review</button></div></div>' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">' +
        tile(t.people || 0, "Staff tracked") +
        tile(t.with_points_90 || 0, "With points (90 days)", (t.with_points_90 ? "#b45309" : null)) +
        tile(t.needing_action || 0, "At coaching level or above", (t.needing_action ? "#b91c1c" : null)) +
        tile(t.bonus_eligible || 0, "On track for the bonus", "#166534") +
        tile(t.unsigned || 0, "Unsigned acknowledgments", (t.unsigned ? "#b45309" : null)) +
      "</div>" +
      '<div id="att-review-status" style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;"></div>' +
      '<div class="card"><div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:760px;">' +
        '<thead><tr style="text-align:left;color:var(--text-muted);font-size:11.5px;text-transform:uppercase;">' +
          '<th style="padding:7px 10px;">Staff</th><th style="padding:7px 10px;text-align:right;">30-day</th>' +
          '<th style="padding:7px 10px;text-align:right;">90-day</th><th style="padding:7px 10px;">Monthly review</th>' +
          '<th style="padding:7px 10px;">Standing</th><th style="padding:7px 10px;">Bonus</th>' +
          '<th style="padding:7px 10px;text-align:center;">Acknowledgments</th>' +
        "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
        '<div style="font-size:12px;color:var(--text-muted);margin-top:10px;">Click a staff member to open their record and log an occurrence.</div>' +
      "</div>";

    mount.querySelectorAll(".att-row").forEach(function (el) {
      el.addEventListener("click", function () {
        if (typeof openStaffModal === "function") openStaffModal(el.getAttribute("data-emp"));
        else location.hash = "#/staff";
      });
    });
    mount.querySelector("#att-matrix-btn").addEventListener("click", openMatrixEditor);
    mount.querySelector("#att-import-btn").addEventListener("click", function () { openImporter(mount); });
    mount.querySelector("#att-review-btn").addEventListener("click", async function () {
      var st = mount.querySelector("#att-review-status");
      if (!confirm("Send the monthly attendance review now?\n\nStaff with points in the period get their review; owner/admin get the roster summary. Anyone already sent for this period is skipped.")) return;
      st.textContent = "Sending…";
      try {
        var r = await api("/api/attendance/monthly-review", { method: "POST", body: {} });
        st.textContent = "Reviewed " + r.reviewed + " staff · " + r.emailed_staff + " emailed · " +
          r.emailed_managers + " summary email(s)" +
          (r.skipped_already_sent ? " · " + r.skipped_already_sent + " already sent this period" : "") +
          (r.no_recipients ? " · ⚠ no summary recipient configured" : "");
      } catch (e) { st.textContent = e.message || "Could not send."; }
    });
    return true;
  }

  async function openMatrixEditor() {
    var d;
    try { d = await api("/api/attendance/types"); } catch (e) { alert(e.message); return; }
    var bd = document.createElement("div");
    bd.className = "modal-backdrop";
    var group = function (kind, title, note) {
      var list = (d.types || []).filter(function (t) { return t.kind === kind; });
      return '<div class="section-title">' + title + "</div>" +
        '<div style="font-size:12px;color:var(--text-muted);margin:-4px 0 8px;">' + note + "</div>" +
        list.map(function (t) {
          return '<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border,#f0f0f0);">' +
            '<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;">' + esc(t.label) + "</div>" +
            '<div style="font-size:11.5px;color:var(--text-muted);">' + esc(t.description || "") + "</div></div>" +
            '<input data-mx="' + esc(t.key) + '" type="number" step="0.5" value="' + t.points + '" style="width:80px;text-align:right;" />' +
            "</div>";
        }).join("");
    };
    bd.innerHTML = '<div class="modal" style="max-width:640px;max-height:88vh;overflow:auto;">' +
      '<div class="modal-header"><div><h2>Attendance matrix</h2>' +
      '<div style="font-size:12.5px;color:var(--text-muted);">Point values from the Attendance &amp; Punctuality Policy, effective ' + esc(d.effective || "") + '. Changing a value here changes how future occurrences are scored — occurrences already logged keep the points they were given.</div></div>' +
      '<button class="close-btn">✕</button></div>' +
      group("occurrence", "Occurrences (points added)", "Positive values.") +
      group("earnback", "Earning back points", "Negative values.") +
      '<div style="margin-top:14px;display:flex;gap:8px;align-items:center;">' +
      '<button class="btn" id="mx-save">Save matrix</button><span id="mx-status" style="font-size:12.5px;color:var(--text-muted);"></span></div></div>';
    document.body.appendChild(bd);
    var close = function () { bd.remove(); };
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", function (e) { if (e.target === bd) close(); });
    bd.querySelector("#mx-save").addEventListener("click", async function () {
      var st = bd.querySelector("#mx-status");
      var types = Array.prototype.map.call(bd.querySelectorAll("[data-mx]"), function (i) {
        return { key: i.getAttribute("data-mx"), points: Number(i.value) };
      });
      st.textContent = "Saving…";
      try { await api("/api/attendance/types", { method: "PUT", body: { types: types } }); st.textContent = "Saved ✓"; }
      catch (e) { st.textContent = e.message || "Could not save."; }
    });
  }

  // ---------------- one-time import of the attendance log ----------------
  // The practice kept attendance in a Google Sheet before this page existed.
  // Paste or upload it here and the history comes across, so nobody's rolling
  // 90-day total restarts at zero. Every row is shown with the staff member it
  // matched before anything is written, because the sheet keys on a typed name
  // and has real drift in it (Kate/Katelyn Brunner, Linares/Lineras).
  async function openImporter(mount) {
    var bd = document.createElement("div");
    bd.className = "modal-backdrop";
    bd.innerHTML = '<div class="modal" style="max-width:860px;max-height:90vh;overflow:auto;">' +
      '<div class="modal-header"><div><h2>Import the attendance log</h2>' +
      '<div style="font-size:12.5px;color:var(--text-muted);max-width:640px;">Open the log tab of the attendance spreadsheet, select the rows including the header, and paste them below — or upload the sheet as CSV. Nothing is saved until you have checked the matches. Importing the same log twice does not double anyone’s points.</div></div>' +
      '<button class="close-btn">✕</button></div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">' +
        '<button class="btn secondary small" id="imp-file">Upload a CSV instead</button>' +
        '<span id="imp-status" style="font-size:12.5px;color:var(--text-muted);"></span></div>' +
      '<textarea id="imp-text" rows="7" style="width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px;" ' +
        'placeholder="Date&#9;Staff Name&#9;Shift Start&#9;Occurrence Type&#9;Emergency?&#9;Documentation?&#9;Time Notified&#9;Notice Hours&#9;Notes&#9;Points"></textarea>' +
      '<div style="margin-top:8px;"><button class="btn" id="imp-check">Check the log</button></div>' +
      '<div id="imp-preview" style="margin-top:14px;"></div></div>';
    document.body.appendChild(bd);
    var close = function () { bd.remove(); };
    bd.querySelector(".close-btn").addEventListener("click", close);

    var previewed = [];
    var status = bd.querySelector("#imp-status");
    var panel = bd.querySelector("#imp-preview");

    bd.querySelector("#imp-file").addEventListener("click", function () {
      var inp = document.createElement("input");
      inp.type = "file"; inp.accept = ".csv,.tsv,.txt,text/csv";
      inp.addEventListener("change", async function () {
        var f = inp.files[0]; if (!f) return;
        bd.querySelector("#imp-text").value = await f.text();
        status.textContent = "Read " + f.name + ". Now check the log.";
      });
      inp.click();
    });

    bd.querySelector("#imp-check").addEventListener("click", async function () {
      var text = bd.querySelector("#imp-text").value;
      if (!text.trim()) { status.textContent = "Paste the log first."; return; }
      status.textContent = "Reading…";
      try {
        var r = await api("/api/attendance/import/preview", { method: "POST", body: { text: text } });
        previewed = r.items || [];
        var s = r.summary;
        status.textContent = s.total + " row(s): " + s.ready + " ready, " + s.needs_confirmation +
          " need a name confirmed, " + s.already_imported + " already imported, " + s.unreadable + " unreadable.";
        draw();
      } catch (e) { status.textContent = e.message || "Could not read that."; panel.innerHTML = ""; }
    });

    function draw() {
      if (!previewed.length) { panel.innerHTML = '<div class="empty-state">No occurrence rows in that log.</div>'; return; }
      panel.innerHTML = previewed.map(function (it, i) {
        var tone = it.already_imported ? "#6b7280"
          : !it.importable ? "#a3282e"
          : it.confidence === "confident" ? "#177a3c" : "#946213";
        var label = it.already_imported ? "Already imported — will skip"
          : !it.importable ? "Cannot be imported"
          : it.confidence === "confident" ? "Matched" : "Confirm the staff member";
        var opts = (it.alternatives || []).map(function (a) {
          return '<option value="' + a.id + '"' + (it.match === a.id ? " selected" : "") + ">" +
            esc(a.name) + " — " + a.score + "% match</option>";
        }).join("");
        var disabled = (it.already_imported || !it.importable) ? " disabled" : "";
        return '<div style="border:1px solid var(--border,#e5e7eb);border-left:3px solid ' + tone +
          ';border-radius:12px;padding:10px 12px;margin-bottom:8px;">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<strong style="font-size:13px;">' + esc(it.source_name || "(no name)") + "</strong>" +
            '<span style="font-size:12.5px;color:var(--text-muted);">' + esc(it.incident_date || it.source_type) + "</span>" +
            '<span style="background:' + tone + '1a;color:' + tone + ';border-radius:999px;padding:2px 9px;font-size:11px;font-weight:700;">' + label + "</span>" +
          "</div>" +
          '<div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;">' +
            esc(it.type_label || it.source_type) +
            (it.points == null ? "" : ' · <strong style="color:' + (it.points > 0 ? "#b45309" : "#166534") + ';">' +
              (it.points > 0 ? "+" : "") + it.points + " pts</strong>") +
            (it.notice_hours == null ? "" : " · " + it.notice_hours + "h notice") + "</div>" +
          ((it.warnings || []).length ? '<div style="font-size:12px;color:#946213;margin-top:4px;">' +
            it.warnings.map(esc).join("<br>") + "</div>" : "") +
          '<div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<label style="font-size:12.5px;">Staff member:</label>' +
            '<select data-imp="' + i + '"' + disabled + ' style="font-size:12.5px;min-width:260px;">' +
              '<option value="">— choose —</option>' + opts + "</select></div></div>";
      }).join("") +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:10px;">' +
        '<button class="btn" id="imp-commit">Import the confirmed rows</button>' +
        '<span id="imp-commit-status" style="font-size:12.5px;color:var(--text-muted);"></span></div>';

      panel.querySelector("#imp-commit").addEventListener("click", async function () {
        var payload = [];
        panel.querySelectorAll("[data-imp]").forEach(function (sel) {
          var it = previewed[Number(sel.getAttribute("data-imp"))];
          if (it.already_imported || !it.importable || !sel.value) return;
          payload.push(Object.assign({}, it, { employee_id: Number(sel.value) }));
        });
        if (!payload.length) { panel.querySelector("#imp-commit-status").textContent = "Nothing selected to import."; return; }
        if (!confirm("Import " + payload.length + " occurrence(s)?\n\nThey are added to each staff member's history with the points the log gave them. Nobody is emailed — these already happened.")) return;
        var st = panel.querySelector("#imp-commit-status");
        st.textContent = "Importing…";
        try {
          var r = await api("/api/attendance/import/commit", { method: "POST", body: { items: payload } });
          st.textContent = "Imported " + r.created.length + " occurrence(s)." + (r.skipped.length ? " Skipped " + r.skipped.length + "." : "");
          previewed = [];
          setTimeout(function () { close(); renderRoster(mount); }, 1200);
        } catch (e) { st.textContent = e.message || "Could not import."; }
      });
    }
  }

  window.__renderAttendance = renderRoster;

  window.HRAttendance = { renderSection: renderSection };
})();
