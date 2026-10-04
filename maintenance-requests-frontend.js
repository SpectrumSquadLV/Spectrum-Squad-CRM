// maintenance-requests-frontend.js -- Maintenance Requests.
//
// Deliberately the same shape as supply-requests-frontend.js: one hash route,
// a sidebar button this file injects itself, and two views off the same route
// decided by the SERVER'S can_manage flag rather than by anything the browser
// asserts about itself. The browser only decides which controls to draw; every
// call is refused server-side regardless.
//
// The dashboard strip is the one real addition. A maintenance queue is read by
// somebody deciding what to do next, and "six open" is a different question
// from "one of them is a safety issue" -- so the counts that would change
// somebody's afternoon are on screen before any row is.
(function () {
  "use strict";
  const HASH = "#/maintenance";

  function canSee() {
    if (typeof state === "undefined" || !state.user || !state.user.id) return false;
    const ma = typeof getModuleAccess === "function" ? getModuleAccess(state.user) : null;
    return !(ma && ma.maintenance === false);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, { method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "That did not work.");
    return d;
  }
  function fmt(s) { if (!s) return ""; try { return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch (e) { return s; } }
  function fmtT(s) { if (!s) return ""; try { return new Date(s).toLocaleString(); } catch (e) { return s; } }

  const STATUS_COLOR = {
    Submitted: "#6366f1", Received: "#0891b2", Assigned: "#7c3aed",
    "In Progress": "#ca8a04", "Waiting on Vendor/Parts": "#b45309",
    Completed: "#16a34a", Closed: "#64748b",
  };
  // Safety Issue is red on purpose, and it is the only red. If three things
  // are urgent then nothing is.
  const PRIORITY_STYLE = {
    Routine: "background:#eef0f5; color:#4b5563;",
    "Needs Attention": "background:#fef3c7; color:#92400e;",
    Urgent: "background:#ffedd5; color:#9a3412;",
    "Safety Issue": "background:#fee2e2; color:#991b1b; font-weight:800;",
  };

  let filter = "open", detailId = null;

  function injectNav() {
    if (!canSee()) return;
    const nav = document.querySelector(".sidebar nav");
    if (!nav || document.getElementById("maintenance-nav-btn")) return;
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.id = "maintenance-nav-btn";
    btn.dataset.nav = "maintenance";
    btn.innerHTML = "Maintenance";
    btn.addEventListener("click", () => { location.hash = HASH; });
    const anchor = document.querySelector('[data-nav="supply"]');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    else nav.appendChild(btn);
  }

  function tile(label, n, tone) {
    return `<div class="mr-tile" style="--t:${tone};">
      <span class="mr-tile-n">${n}</span><span class="mr-tile-l">${esc(label)}</span></div>`;
  }

  function row(r, canManage) {
    const where = [r.location, r.area].filter(Boolean).join(" — ");
    return `<button class="mr-row" data-open="${r.id}">
      <span class="mr-row-main">
        <span class="mr-row-top">
          <span class="mr-pri" style="${PRIORITY_STYLE[r.priority] || PRIORITY_STYLE.Routine}">${esc(r.priority)}</span>
          <span class="mr-cat">${esc(r.category || "Other")}</span>
          ${r.escalated_at ? `<span class="mr-flag">flagged for leadership</span>` : ""}
        </span>
        <span class="mr-desc">${esc(r.description)}</span>
        <span class="mr-meta">${where ? esc(where) + " · " : ""}${esc(fmt(r.created_at))}${
          canManage && r.requester_name ? " · " + esc(r.requester_name) : ""}${
          r.assigned_to ? " · assigned to " + esc(r.assigned_to) : ""}</span>
      </span>
      <span class="mr-status" style="background:${STATUS_COLOR[r.status] || "#64748b"};">${esc(r.status)}</span>
    </button>`;
  }

  async function render(mount) {
    let d;
    try { d = await api("/api/maintenance/requests"); }
    catch (e) {
      mount.innerHTML = `<div class="page-header"><div><h1>Maintenance</h1></div></div><div class="empty-state">${esc(e.message)}</div>`;
      return;
    }
    const can = d.can_manage;
    const shown = d.requests.filter((r) => {
      if (filter === "open") return r.is_open;
      if (filter === "safety") return r.priority === "Safety Issue" && r.is_open;
      if (filter === "urgent") return r.priority === "Urgent" && r.is_open;
      if (filter === "waiting") return r.status === "Waiting on Vendor/Parts";
      if (filter === "done") return !r.is_open;
      return true;
    });
    const c = d.counts || {};
    mount.innerHTML = `
      <div class="page-header">
        <div><h1>Maintenance</h1><p>${can ? "Everything reported, and where each job has got to." : "What you have reported, and where it has got to."}</p></div>
        <div style="display:flex; gap:8px;">
          <button class="btn" id="mr-new">+ Submit maintenance request</button>
          ${can ? `<button class="btn secondary" id="mr-settings">Who gets told</button>` : ""}
        </div>
      </div>
      <div class="mr-tiles">
        ${tile("Open", c.open || 0, "#6366f1")}
        ${tile("Urgent", c.urgent || 0, "#ea580c")}
        ${tile("Safety issues", c.safety || 0, "#dc2626")}
        ${tile("Assigned", c.assigned || 0, "#7c3aed")}
        ${tile("Waiting on vendor", c.waiting || 0, "#b45309")}
        ${tile("Completed", c.completed || 0, "#16a34a")}
      </div>
      <div class="mr-filters">
        ${[["open", "Open"], ["safety", "Safety"], ["urgent", "Urgent"], ["waiting", "Waiting"], ["done", "Completed"], ["all", "All"]]
          .map(([k, l]) => `<button class="btn small ${filter === k ? "" : "secondary"}" data-filter="${k}">${l}</button>`).join("")}
        <span style="font-size:12px; color:var(--text-muted); margin-left:auto;">${shown.length} shown</span>
      </div>
      <div class="card" style="margin:0;">
        ${shown.length ? shown.map((r) => row(r, can)).join("") : `<div class="empty-state">Nothing here.</div>`}
      </div>
      ${can ? `<div style="font-size:12px; color:var(--text-muted); margin-top:10px;">
        Anyone without a CRM login can report something at <strong>${esc(d.public_url || "")}</strong></div>` : ""}
      <style>
        .mr-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; }
        .mr-tile { background:#fff; border:1px solid #e6e8f0; border-left:4px solid var(--t); border-radius:12px; padding:12px 14px; display:flex; flex-direction:column; gap:2px; }
        .mr-tile-n { font-size:22px; font-weight:800; color:#1f2430; line-height:1; }
        .mr-tile-l { font-size:11.5px; color:#6b7280; }
        .mr-filters { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
        .mr-row { width:100%; text-align:left; background:none; border:0; border-bottom:1px solid #eef0f5; padding:12px 4px; display:flex; gap:12px; align-items:center; cursor:pointer; font:inherit; }
        .mr-row:last-child { border-bottom:0; }
        .mr-row:hover { background:#fafbff; }
        .mr-row-main { flex:1; display:flex; flex-direction:column; gap:3px; min-width:0; }
        .mr-row-top { display:flex; gap:7px; align-items:center; flex-wrap:wrap; }
        .mr-pri { border-radius:4px; padding:1.5px 7px; font-size:10.5px; font-weight:700; }
        .mr-cat { font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:.04em; font-weight:600; }
        .mr-flag { background:#fee2e2; color:#991b1b; border-radius:4px; padding:1.5px 7px; font-size:10px; font-weight:700; }
        .mr-desc { font-size:13.5px; color:#1f2430; font-weight:600; }
        .mr-meta { font-size:11.5px; color:#9aa0ad; }
        .mr-status { color:#fff; border-radius:999px; padding:3px 11px; font-size:11px; font-weight:700; white-space:nowrap; }
      </style>`;

    // The shell's own router does not know this hash and falls through to the
    // dashboard, so it will happily paint over this mount a moment after it is
    // drawn. The marker is how the re-render below tells "mine" from "theirs".
    mount.dataset.maintenance = "1";

    mount.querySelectorAll("[data-filter]").forEach((b) =>
      b.addEventListener("click", () => { filter = b.dataset.filter; render(mount); }));
    mount.querySelectorAll("[data-open]").forEach((b) =>
      b.addEventListener("click", () => openDetail(Number(b.dataset.open), d, mount)));
    const nb = mount.querySelector("#mr-new");
    if (nb) nb.addEventListener("click", () => submitModal(d, mount));
    const sb = mount.querySelector("#mr-settings");
    if (sb) sb.addEventListener("click", () => settingsModal(mount));
  }

  function submitModal(d, mount) {
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    bd.innerHTML = `<div class="modal" style="width:620px; max-width:94vw;">
      <div class="modal-header"><h2>Submit a maintenance request</h2><button class="close-btn">✕</button></div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
        <div class="field"><label>Location</label><input data-f="location" placeholder="Which site" /></div>
        <div class="field"><label>Specific area or room</label><input data-f="area" placeholder="e.g. Room 3" /></div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
        <div class="field"><label>Category</label><select data-f="category">
          ${(d.categories || []).map((c) => `<option>${esc(c)}</option>`).join("")}</select></div>
        <div class="field"><label>Priority</label><select data-f="priority">
          ${(d.priorities || []).map((p) => `<option>${esc(p)}</option>`).join("")}</select></div>
      </div>
      <div class="field"><label>What needs fixing?</label>
        <textarea data-f="description" rows="5" style="width:100%; font-family:inherit;"></textarea></div>
      <div class="field"><label>Photo (optional)</label><input type="file" id="mr-photo" accept="image/*" /></div>
      <div id="mr-safety-note" style="display:none; background:#fef2f2; border:1px solid #fecaca; color:#991b1b; border-radius:9px; padding:10px 12px; font-size:12.5px; margin-top:4px;">
        A safety issue is sent to leadership as soon as you submit it, without waiting for anyone to open the queue.
      </div>
      <div style="margin-top:14px; display:flex; gap:8px;">
        <button class="btn" id="mr-save">Submit</button>
        <span id="mr-msg" style="font-size:12.5px; color:var(--text-muted); align-self:center;"></span>
      </div>
    </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    const pri = bd.querySelector('[data-f="priority"]');
    const note = bd.querySelector("#mr-safety-note");
    const syncNote = () => { note.style.display = /Safety Issue|Urgent/.test(pri.value) ? "block" : "none"; };
    pri.addEventListener("change", syncNote); syncNote();

    bd.querySelector("#mr-save").addEventListener("click", async function () {
      const body = {};
      ["location", "area", "category", "priority", "description"].forEach((f) => {
        body[f] = bd.querySelector(`[data-f="${f}"]`).value.trim();
      });
      if (!body.description) { bd.querySelector("#mr-msg").textContent = "Describe what needs fixing."; return; }
      const file = bd.querySelector("#mr-photo").files[0];
      if (file) {
        try {
          body.files = [{
            filename: file.name, mime_type: file.type, kind: "photo",
            content_base64: await new Promise((res, rej) => {
              const r = new FileReader();
              r.onload = () => res(String(r.result).split(",")[1]);
              r.onerror = () => rej(new Error("Could not read that photo."));
              r.readAsDataURL(file);
            }),
          }];
        } catch (e) { bd.querySelector("#mr-msg").textContent = e.message; return; }
      }
      this.disabled = true; this.textContent = "Submitting…";
      try { await api("/api/maintenance/requests", { method: "POST", body }); close(); render(mount); }
      catch (e) { bd.querySelector("#mr-msg").textContent = e.message; this.disabled = false; this.textContent = "Submit"; }
    });
  }

  async function openDetail(id, d, mount) {
    let r;
    try { r = await api("/api/maintenance/requests/" + id); } catch (e) { return; }
    const can = d.can_manage;
    const where = [r.location, r.area].filter(Boolean).join(" — ");
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    bd.innerHTML = `<div class="modal" style="width:700px; max-width:94vw;">
      <div class="modal-header"><h2>${esc(r.category || "Maintenance")}</h2><button class="close-btn">✕</button></div>
      <div style="font-size:12px; color:var(--text-muted); margin:-6px 0 10px;">
        <span class="mr-pri" style="${PRIORITY_STYLE[r.priority] || ""}">${esc(r.priority)}</span>
        · ${esc(r.status)}${where ? " · " + esc(where) : ""} · raised ${esc(fmt(r.created_at))}
        ${can && r.requester_name ? " by " + esc(r.requester_name) : ""}
        ${r.escalated_at ? `<div style="margin-top:4px; color:#991b1b; font-weight:700;">Flagged for leadership on ${esc(fmt(r.escalated_at))} (${esc(r.escalated_reason || "")})</div>` : ""}
      </div>
      <div style="font-size:13.5px; line-height:1.6; white-space:pre-wrap; color:#2b2f3a;">${esc(r.description)}</div>
      ${(r.files || []).length ? `<div style="margin-top:12px; font-size:12.5px;">
        ${r.files.map((f) => `<div>▤ <a href="/api/maintenance/files/${f.id}" target="_blank" rel="noopener">${esc(f.original_name || f.kind)}</a> <span style="color:#9aa0ad;">${esc(f.kind)}</span></div>`).join("")}
      </div>` : ""}
      ${can ? `
      <div style="border-top:1px solid #eef0f5; margin-top:14px; padding-top:12px; display:grid; grid-template-columns:1fr 1fr; gap:10px;">
        <div class="field"><label>Status</label><select data-f="status">
          ${(d.statuses || []).map((s) => `<option${s === r.status ? " selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
        <div class="field"><label>Priority</label><select data-f="priority">
          ${(d.priorities || []).map((p) => `<option${p === r.priority ? " selected" : ""}>${esc(p)}</option>`).join("")}</select></div>
        <div class="field"><label>Assigned to</label><input data-f="assigned_to" value="${esc(r.assigned_to || "")}" /></div>
        <div class="field"><label>Vendor</label><input data-f="vendor_name" value="${esc(r.vendor_name || "")}" /></div>
        <div class="field"><label>Vendor contact</label><input data-f="vendor_contact" value="${esc(r.vendor_contact || "")}" /></div>
        <div class="field"><label>Completed on</label><input type="date" data-f="completed_on" value="${esc(String(r.completed_on || "").slice(0, 10))}" /></div>
      </div>
      <div class="field"><label>Internal notes</label><textarea data-f="internal_notes" rows="3" style="width:100%; font-family:inherit;">${esc(r.internal_notes || "")}</textarea></div>
      <div class="field"><label>Completion notes</label><textarea data-f="completion_notes" rows="2" style="width:100%; font-family:inherit;">${esc(r.completion_notes || "")}</textarea></div>
      <div style="display:flex; gap:8px; margin-top:8px;">
        <button class="btn" id="mr-upd">Save</button>
        <span id="mr-dmsg" style="font-size:12.5px; color:var(--text-muted); align-self:center;"></span>
      </div>` : ""}
      <div style="margin-top:16px;">
        <div style="font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:#6b7280; font-weight:700; margin-bottom:6px;">History</div>
        <div style="display:flex; flex-direction:column; gap:4px; font-size:12.5px; color:#4b5563;">
          ${(r.history || []).map((h) => `<div><span style="color:#9aa0ad;">${esc(fmtT(h.created_at))}</span> — ${esc(String(h.action).replace(/_/g, " "))}${
            h.from_status || h.to_status ? ` <strong>${esc(h.from_status || "")}${h.from_status && h.to_status ? " → " : ""}${esc(h.to_status || "")}</strong>` : ""}${
            h.note ? " · " + esc(h.note) : ""}${h.actor_name ? ` <span style="color:#9aa0ad;">(${esc(h.actor_name)})</span>` : ""}</div>`).join("")
            || `<div style="color:#9aa0ad;">Nothing yet.</div>`}
        </div>
      </div>
    </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    const upd = bd.querySelector("#mr-upd");
    if (upd) upd.addEventListener("click", async function () {
      const body = {};
      ["status", "priority", "assigned_to", "vendor_name", "vendor_contact", "internal_notes", "completion_notes", "completed_on"]
        .forEach((f) => { const el = bd.querySelector(`[data-f="${f}"]`); if (el) body[f] = el.value; });
      this.disabled = true; this.textContent = "Saving…";
      try { await api("/api/maintenance/requests/" + id, { method: "PATCH", body }); close(); render(mount); }
      catch (e) { bd.querySelector("#mr-dmsg").textContent = e.message; this.disabled = false; this.textContent = "Save"; }
    });
  }

  async function settingsModal(mount) {
    let s = {};
    try { s = await api("/api/maintenance/settings"); } catch (e) {}
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    bd.innerHTML = `<div class="modal" style="width:520px; max-width:94vw;">
      <div class="modal-header"><h2>Who gets told</h2><button class="close-btn">✕</button></div>
      <div class="field"><label>New maintenance requests</label>
        <input data-f="notify_to" value="${esc(s.notify_to || "")}" placeholder="facilities@spectrumsquadlv.com" /></div>
      <div class="field"><label>Urgent and safety issues</label>
        <input data-f="escalate_to" value="${esc(s.escalate_to || "")}" placeholder="Leave blank to use the address above" />
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:3px;">
          Told immediately, without waiting for anyone to open the queue.</div></div>
      <div style="margin-top:12px; display:flex; gap:8px;">
        <button class="btn" id="mr-set-save">Save</button>
        <span id="mr-set-msg" style="font-size:12.5px; color:var(--text-muted); align-self:center;"></span>
      </div>
    </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    bd.querySelector("#mr-set-save").addEventListener("click", async function () {
      this.disabled = true;
      try {
        await api("/api/maintenance/settings", { method: "PUT", body: {
          notify_to: bd.querySelector('[data-f="notify_to"]').value.trim(),
          escalate_to: bd.querySelector('[data-f="escalate_to"]').value.trim(),
        } });
        close();
      } catch (e) { bd.querySelector("#mr-set-msg").textContent = e.message; this.disabled = false; }
    });
  }

  function mountEl() { return document.getElementById("view-mount") || document.getElementById("page"); }
  // "The shell has not booted yet" and "this person may not see it" are
  // different answers and must not share a branch. Treating the first as the
  // second redirects away from the page a moment before it could have worked,
  // which is exactly what happened: on a reload straight onto this hash, the
  // route fired before `state` existed and bounced to the dashboard.
  function shellReady() { return typeof state !== "undefined" && !!state && !!state.user && !!state.user.id; }
  function route() {
    if (location.hash !== HASH) return;
    if (shellReady() && !canSee()) { location.hash = "#/dashboard"; return; }
    const m = mountEl();
    if (m && shellReady()) render(m);
    // Same approach the supply module uses, for the same reason: the shell
    // repaints after us, so the view is redrawn if the marker has gone.
    [120, 400, 900].forEach((ms) => setTimeout(() => {
      const el = mountEl();
      if (location.hash === HASH && el && shellReady() && el.dataset.maintenance !== "1") render(el);
    }, ms));
  }
  function boot() {
    [200, 700, 1500, 3000].forEach((ms) => setTimeout(injectNav, ms));
    new MutationObserver(injectNav).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", route);
    // Retried as the shell comes up, because a reload lands here before it has.
    [0, 250, 600, 1200, 2200].forEach((ms) => setTimeout(() => { if (location.hash === HASH) route(); }, ms));
  }
  boot();
  window.__renderMaintenance = function (mount) { return render(mount); };
})();
