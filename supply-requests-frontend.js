// supply-requests-frontend.js -- Clinic Supply Requests admin view (progressive-enhancement).
// Injects a "Supply Requests" sidebar button and renders into #view-mount on its
// hash route. Owner / Super Admin / Admin only. Walks each request through the
// full flow and emails the requester on status changes (server-side).
(function () {
  "use strict";
  const HASH = "#/supply";
  const ADMIN_ROLES = ["owner", "super_admin", "admin"];
  const ACCENT = "#4f46e5";

  function canSee() { return typeof state !== "undefined" && state.user && ADMIN_ROLES.includes(state.user.role); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, { method: opts.method || "GET", headers: opts.body ? { "Content-Type": "application/json" } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "Request failed");
    return d;
  }
  function fmt(s) { if (!s) return ""; try { return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch (e) { return s; } }
  function fmtT(s) { if (!s) return ""; try { return new Date(s).toLocaleString(); } catch (e) { return s; } }
  function statusColor(s) { return { Submitted: "#6366f1", Approved: "#0891b2", Ordered: "#ca8a04", Received: "#16a34a", Denied: "#dc2626" }[s] || "#64748b"; }
  const STATUSES = ["Submitted", "Approved", "Ordered", "Received", "Denied"];

  let curFilter = "open";

  function injectNav() {
    if (!canSee()) return;
    const nav = document.querySelector(".sidebar nav");
    if (!nav || document.getElementById("supply-nav-btn")) return;
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.id = "supply-nav-btn";
    btn.innerHTML = "<span>📦</span> Supply Requests";
    btn.addEventListener("click", () => { location.hash = HASH; });
    nav.appendChild(btn);
  }

  async function render() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    mount.innerHTML = '<div style="padding:40px;color:#767488;">Loading supply requests…</div>';
    let data;
    try { data = await api("/api/supply/requests?status=" + encodeURIComponent(curFilter)); }
    catch (e) { mount.innerHTML = '<div style="padding:40px;color:#a3282e;">' + esc(e.message) + "</div>"; return; }
    mount.dataset.supply = "1";
    const c = data.counts;

    const chip = (key, label, n, color) =>
      '<button class="sup-filter" data-f="' + key + '" style="border:1px solid ' + (curFilter === key ? ACCENT : "#e6e1d4") + ';background:' + (curFilter === key ? "#eef2ff" : "#fff") + ';color:' + (color || "#333") + ';border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer;">' + esc(label) + (n != null ? " · " + n : "") + "</button>";

    const rows = data.rows.map((r) =>
      '<tr class="sup-row" data-id="' + r.id + '" style="cursor:pointer;border-bottom:1px solid #f0ede3;">' +
      '<td style="padding:10px 12px;"><div style="font-weight:700;">' + esc(r.item_name) + (r.priority === "Urgent" ? ' <span style="color:#dc2626;font-size:11px;">● Urgent</span>' : "") + "</div>" +
        '<div style="font-size:11.5px;color:#8a8797;">' + (r.quantity ? esc(r.quantity) + " · " : "") + (r.has_photo ? "📷 · " : "") + (r.item_url ? "🔗 · " : "") + esc(r.location || "") + "</div></td>" +
      '<td style="padding:10px 12px;">' + esc(r.requester_name || "—") + '<div style="font-size:11.5px;color:#8a8797;">' + esc(r.requester_email || "") + "</div></td>" +
      '<td style="padding:10px 12px;color:#8a8797;font-size:12.5px;">' + fmt(r.created_at) + "</td>" +
      '<td style="padding:10px 12px;"><span style="display:inline-block;background:' + statusColor(r.status) + ';color:#fff;font-weight:700;font-size:11.5px;padding:3px 10px;border-radius:20px;">' + esc(r.status) + "</span></td>" +
      "</tr>"
    ).join("") || '<tr><td colspan="4" style="padding:24px;text-align:center;color:#8a8797;">No requests here yet.</td></tr>';

    const shareLink = (location.origin || "") + "/supply-request";

    mount.innerHTML =
      '<div style="padding:24px 28px 60px;max-width:1000px;">' +
        '<div style="display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;margin-bottom:6px;">' +
          '<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:22px;">📦</span><h1 style="font-size:24px;margin:0;font-weight:800;color:' + ACCENT + ';">Supply Requests</h1></div>' +
          '<div style="display:flex;gap:8px;"><button class="btn small secondary" id="sup-share">🔗 Copy staff link</button><button class="btn small secondary" id="sup-settings">⚙ Settings</button></div>' +
        "</div>" +
        '<p style="margin:0 0 14px;color:#767488;font-size:13.5px;">Staff submit from the public link (no login). Move each request through the flow — the requester is emailed automatically on every change.</p>' +
        '<div id="sup-share-box" style="display:none;background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:13px;">Share this link with staff: <code style="user-select:all;">' + esc(shareLink) + "</code></div>" +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">' +
          chip("open", "Open", (c.Submitted + c.Approved + c.Ordered)) +
          chip("Submitted", "Submitted", c.Submitted, "#6366f1") +
          chip("Approved", "Approved", c.Approved, "#0891b2") +
          chip("Ordered", "Ordered", c.Ordered, "#ca8a04") +
          chip("Received", "Received", c.Received, "#16a34a") +
          chip("Denied", "Denied", c.Denied, "#dc2626") +
          chip("all", "All", null) +
        "</div>" +
        '<div style="background:#fff;border:1px solid #e6e1d4;border-radius:12px;overflow:hidden;">' +
          '<table style="width:100%;border-collapse:collapse;font-size:13.5px;"><thead><tr style="background:#faf9f5;text-align:left;color:#767488;font-size:12px;">' +
            '<th style="padding:10px 12px;">Item</th><th style="padding:10px 12px;">Requested by</th><th style="padding:10px 12px;">Date</th><th style="padding:10px 12px;">Status</th>' +
          "</tr></thead><tbody>" + rows + "</tbody></table>" +
        "</div>" +
      "</div>";

    mount.querySelectorAll(".sup-filter").forEach((b) => b.addEventListener("click", () => { curFilter = b.getAttribute("data-f"); render(); }));
    mount.querySelectorAll(".sup-row").forEach((el) => el.addEventListener("click", () => openDetail(el.getAttribute("data-id"))));
    document.getElementById("sup-share").addEventListener("click", () => {
      const box = document.getElementById("sup-share-box"); box.style.display = "block";
      if (navigator.clipboard) navigator.clipboard.writeText(shareLink).catch(() => {});
    });
    document.getElementById("sup-settings").addEventListener("click", openSettings);
  }

  function modal(inner, width) {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = '<div class="modal" style="max-width:' + (width || 620) + 'px;">' + inner + "</div>";
    document.body.appendChild(back);
    const close = () => back.remove();
    const cb = back.querySelector(".close-btn"); if (cb) cb.addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    return { back, close };
  }

  async function openDetail(id) {
    let d;
    try { d = await api("/api/supply/requests/" + id); } catch (e) { alert(e.message); return; }
    const r = d.request;
    const nextByStatus = { Submitted: ["Approved", "Denied"], Approved: ["Ordered", "Denied"], Ordered: ["Received", "Denied"], Received: [], Denied: [] };
    const actions = (nextByStatus[r.status] || []).map((s) =>
      '<button class="btn small" data-to="' + s + '" style="background:' + statusColor(s) + ';border-color:' + statusColor(s) + ';">Mark ' + s + "</button>").join(" ");

    const hist = (d.history || []).map((h) => {
      const label = h.action === "submitted" ? "Submitted" : h.action === "status_change" ? ("→ " + h.to_status) : h.action === "note" ? "Note" : "Edited";
      return '<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #f5f3ec;font-size:12.5px;">' +
        '<div style="width:10px;height:10px;border-radius:50%;margin-top:4px;background:' + (h.to_status ? statusColor(h.to_status) : "#cbd5e1") + ';flex:0 0 auto;"></div>' +
        '<div><b>' + esc(label) + "</b>" + (h.note ? " — " + esc(h.note) : "") + (h.notified ? ' <span style="color:#16a34a;font-size:11px;">emailed ✓</span>' : "") +
        '<div style="color:#8a8797;font-size:11px;">' + fmtT(h.created_at) + " · " + esc(h.actor_name || "") + "</div></div></div>";
    }).join("") || '<div style="color:#8a8797;font-size:12.5px;">No history.</div>';

    const { back, close } = modal(
      '<div class="modal-header"><div><h2>' + esc(r.item_name) + '</h2><span class="badge" style="background:' + statusColor(r.status) + '">' + esc(r.status) + "</span></div><button class=\"close-btn\">✕</button></div>" +
      '<div class="form-grid">' +
        '<div class="field"><label>Requested by</label><div>' + esc(r.requester_name || "—") + "<div style=\"font-size:12px;color:#8a8797;\">" + esc(r.requester_email || "") + "</div></div></div>" +
        '<div class="field"><label>Clinic / site</label><div>' + esc(r.location || "—") + "</div></div>" +
        '<div class="field"><label>How much</label><div>' + esc(r.quantity || "—") + "</div></div>" +
        '<div class="field"><label>Priority</label><div>' + esc(r.priority || "Normal") + "</div></div>" +
      "</div>" +
      (r.item_url ? '<div class="field"><label>Item link</label><a href="' + esc(r.item_url) + '" target="_blank" rel="noopener">' + esc(r.item_url) + "</a></div>" : "") +
      (r.has_photo ? '<div class="field"><label>Photo</label><img src="/api/supply/requests/' + r.id + '/photo" style="max-width:220px;border-radius:10px;border:1px solid #e6e1d4;" /></div>' : "") +
      (r.notes ? '<div class="field"><label>Notes</label><div>' + esc(r.notes) + "</div></div>" : "") +
      '<div class="field"><label>Estimated cost (optional, internal)</label><div style="display:flex;gap:8px;align-items:center;"><input id="sup-cost" value="' + (r.estimated_cost != null ? r.estimated_cost : "") + '" placeholder="$" style="max-width:120px;" /><button class="btn small secondary" id="sup-cost-save">Save</button><span id="sup-cost-res" style="font-size:12px;color:var(--text-muted);"></span></div></div>' +
      '<div class="section-title">Update status</div>' +
      '<div class="field"><label>Note to include in the email (optional)</label><input id="sup-note" placeholder="e.g. ordered 2 boxes, arriving Friday" /></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' + (actions || '<span style="color:#8a8797;font-size:13px;">This request is closed.</span>') + '</div>' +
      '<div id="sup-act-res" style="font-size:12px;color:var(--text-muted);margin-top:8px;"></div>' +
      '<div style="margin-top:6px;"><a class="btn small secondary" href="' + esc(r.trackUrl) + '" target="_blank" rel="noopener">Open requester\'s tracking page</a></div>' +
      '<div class="section-title">History</div>' + hist,
      680
    );

    back.querySelectorAll("[data-to]").forEach((b) => b.addEventListener("click", async () => {
      const to = b.getAttribute("data-to");
      const note = back.querySelector("#sup-note").value.trim();
      const resEl = back.querySelector("#sup-act-res");
      b.disabled = true; resEl.textContent = "Updating…";
      try {
        const rr = await api("/api/supply/requests/" + id + "/status", { method: "POST", body: { status: to, note: note || null } });
        resEl.textContent = "Marked " + to + (rr.notified ? " · requester emailed ✓" : " · (no email sent)");
        setTimeout(() => { close(); render(); }, 700);
      } catch (e) { b.disabled = false; resEl.textContent = e.message; }
    }));
    back.querySelector("#sup-cost-save").addEventListener("click", async () => {
      const resEl = back.querySelector("#sup-cost-res");
      try { await api("/api/supply/requests/" + id, { method: "PATCH", body: { estimated_cost: back.querySelector("#sup-cost").value } }); resEl.textContent = "Saved ✓"; }
      catch (e) { resEl.textContent = e.message; }
    });
  }

  async function openSettings() {
    let s;
    try { s = await api("/api/supply/settings"); } catch (e) { alert(e.message); return; }
    const { back, close } = modal(
      '<div class="modal-header"><div><h2>Supply Request Settings</h2></div><button class="close-btn">✕</button></div>' +
      '<div class="field"><label>Notify these emails when a new request comes in</label><input id="sup-notify" value="' + esc(s.notify_emails || "") + '" placeholder="you@spectrumsquadlv.com, manager@…" /><div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">Comma-separate for multiple. Leave blank for no alerts.</div></div>' +
      '<div style="margin-top:12px;"><button class="btn" id="sup-set-save">Save</button> <span id="sup-set-res" style="font-size:12px;color:var(--text-muted);"></span></div>'
    );
    back.querySelector("#sup-set-save").addEventListener("click", async () => {
      const resEl = back.querySelector("#sup-set-res");
      try { await api("/api/supply/settings", { method: "PUT", body: { notify_emails: back.querySelector("#sup-notify").value.trim() } }); resEl.textContent = "Saved ✓"; }
      catch (e) { resEl.textContent = e.message; }
    });
  }

  function onHash() {
    if (location.hash !== HASH) return;
    if (!canSee()) { location.hash = "#/dashboard"; return; }
    render();
    [120, 400, 900].forEach((ms) => setTimeout(() => { const m = document.getElementById("view-mount"); if (location.hash === HASH && m && m.dataset.supply !== "1") render(); }, ms));
  }
  function boot() {
    [200, 700, 1500, 3000].forEach((ms) => setTimeout(injectNav, ms));
    new MutationObserver(injectNav).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", onHash);
    if (location.hash === HASH) onHash();
  }
  boot();
})();
