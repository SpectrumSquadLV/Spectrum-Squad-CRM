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

    var rows = flags.length ? flags.map(function (f) {
      var status = f.acknowledged
        ? '<span class="tag" style="background:#dcfce7; color:#166534;">Acknowledged</span>'
        : '<span class="tag" style="background:#fef3c7; color:#92400e;">Pending signature</span>';
      var actions = f.acknowledged
        ? (f.has_pdf ? '<a class="btn small secondary" href="/api/attendance/flag/' + f.id + '/pdf" target="_blank" rel="noopener">Download PDF</a>' : '<span style="font-size:11.5px; color:var(--text-muted);">signed</span>')
        : '<button class="btn small" data-att-sign="' + f.id + '">Sign now</button>'
          + '<button class="btn small secondary" data-att-email="' + f.id + '">Email link</button>'
          + '<button class="btn small secondary" data-att-del="' + f.id + '">✕</button>';
      return '<div class="task-row" style="align-items:flex-start;">'
        + '<div class="info"><strong>' + esc(f.reason || "Flag") + '</strong> · ' + esc(fmt(f.incident_date))
        + (f.notes ? '<div class="due">' + esc(f.notes) + "</div>" : "")
        + (f.acknowledged && f.signed_date ? '<div class="due">Signed ' + esc(fmt(f.signed_date)) + (f.typed_name ? " by " + esc(f.typed_name) : "") + "</div>" : "")
        + '<div style="margin-top:4px;">' + status + "</div></div>"
        + '<div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">' + actions + "</div></div>";
    }).join("") : '<div class="empty-state">No attendance flags on record.</div>';

    container.innerHTML =
      '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;">'
      + '<span class="tag" style="background:' + (count90 ? "#fee2e2" : "#dcfce7") + '; color:' + (count90 ? "#991b1b" : "#166534") + '; font-size:13px; padding:6px 12px;">⚑ Flags in last 90 days: <strong>' + count90 + "</strong></span>"
      + '<button class="btn small" id="att-add-btn">+ Log attendance flag</button></div>'
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
    container.querySelectorAll("[data-att-del]").forEach(function (b) {
      b.addEventListener("click", async function () {
        if (!confirm("Remove this attendance flag?")) return;
        try { await api("/api/attendance/flag/" + b.getAttribute("data-att-del"), { method: "DELETE" }); renderSection(container, empId, empName); }
        catch (e) { alert(e.message); }
      });
    });
  }

  function showAddForm(container, empId, empName) {
    var box = container.querySelector("#att-add-form");
    if (!box) return;
    var today = new Date().toISOString().slice(0, 10);
    box.innerHTML =
      '<div style="border:1px solid var(--border,#eee); border-radius:10px; padding:12px; margin-bottom:10px;">'
      + '<div class="form-grid" style="gap:8px;">'
      + '<div class="field"><label>Date of incident</label><input id="att-date" type="date" value="' + today + '" /></div>'
      + '<div class="field"><label>Reason</label><select id="att-reason">' + REASONS.map(function (r) { return '<option>' + esc(r) + "</option>"; }).join("") + "</select></div>"
      + '</div>'
      + '<div class="field full"><label>Notes</label><textarea id="att-notes" rows="2" style="width:100%;"></textarea></div>'
      + '<div style="margin-top:8px; display:flex; gap:8px;"><button class="btn small" id="att-save">Save flag</button><button class="btn small secondary" id="att-cancel">Cancel</button><span id="att-status" style="font-size:12.5px; color:var(--text-muted); align-self:center;"></span></div>'
      + "</div>";
    box.querySelector("#att-cancel").addEventListener("click", function () { box.innerHTML = ""; });
    box.querySelector("#att-save").addEventListener("click", async function () {
      var body = {
        incident_date: box.querySelector("#att-date").value || null,
        reason: box.querySelector("#att-reason").value,
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

  window.HRAttendance = { renderSection: renderSection };
})();
