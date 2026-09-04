// ot-frontend.js -- Occupational Therapy dashboard (progressive-enhancement).
// Mirrors pipeline-v2.js: injects its own sidebar nav button and renders the OT
// dashboard into #view-mount on its hash route, without touching the app router.
// Visible only to OT-permitted roles. Shows only OT + shared demographics.
(function () {
  const HASH = "#/ot";
  const OT_ROLES = ["owner", "super_admin", "admin", "ot_admin", "ot_staff"];
  const ACCENT = "#2f8f89"; // OT accent (teal) — subtle differentiation from ABA navy

  const OT_ADMIN_ROLES = ["owner", "super_admin", "admin", "ot_admin"];
  function canSeeOT() {
    return typeof state !== "undefined" && state.user && OT_ROLES.includes(state.user.role);
  }
  function canAdminOT() {
    return typeof state !== "undefined" && state.user && OT_ADMIN_ROLES.includes(state.user.role);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, { method: opts.method || "GET", headers: opts.body ? { "Content-Type": "application/json" } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "Request failed");
    return d;
  }

  function injectNav() {
    if (!canSeeOT()) return;
    const nav = document.querySelector(".sidebar nav");
    if (!nav || document.getElementById("ot-nav-btn")) return;
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.id = "ot-nav-btn";
    // A key of its own, so an admin can drag this button like any other entry.
    // The shell never creates it from the saved order -- the role check above
    // is still the only thing that decides whether it exists.
    btn.dataset.nav = "ot";
    btn.innerHTML = 'Occupational Therapy';
    btn.addEventListener("click", () => { location.hash = HASH; });
    nav.appendChild(btn);
    if (typeof window.__navPlace === "function") window.__navPlace(btn);
  }

  function chip(item) {
    const ok = item.ok;
    const label = item.value ? item.label + ": " + item.value : item.label;
    const bg = ok ? "#e9f9ee" : "#fdecec";
    const col = ok ? "#177a3c" : "#a3282e";
    const mark = ok ? "✓" : (item.value && /pending|sent|%/i.test(item.value) ? "…" : "✕");
    return '<span style="display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;margin:2px 4px 2px 0;background:' + bg + ';color:' + col + ';">' + esc(label) + " " + mark + "</span>";
  }

  function card(c) {
    const missing = (c.missing || []).map(chip).join("");
    return '<div style="background:#fff;border:1px solid #e6e1d4;border-radius:12px;padding:12px 14px;margin-bottom:10px;border-left:4px solid ' + ACCENT + ';cursor:pointer;" data-ot-open="' + c.ot_client_id + '">' +
      '<div style="font-weight:700;font-size:14.5px;margin-bottom:2px;">' + esc(c.child_name) + "</div>" +
      '<div style="font-size:12px;color:#767488;margin-bottom:6px;">' + esc(c.parent_name || "") + (c.dob ? " · DOB " + esc(c.dob) : "") + "</div>" +
      '<div style="line-height:1.8;">' + missing + "</div>" +
      "</div>";
  }

  async function render() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    mount.innerHTML = '<div style="padding:40px;color:#767488;">Loading OT dashboard…</div>';
    let data;
    try { data = await api("/api/ot/dashboard"); }
    catch (e) { mount.innerHTML = '<div style="padding:40px;color:#a3282e;">' + esc(e.message) + "</div>"; return; }
    const cols = data.statuses.map((s) => {
      const items = data.byStatus[s] || [];
      return '<div style="flex:0 0 300px;background:rgba(0,0,0,0.02);border-radius:12px;padding:12px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:2px 4px 12px;">' +
          '<h3 style="font-size:13.5px;margin:0;font-weight:700;">' + esc(s) + "</h3>" +
          '<span style="font-size:12px;color:#767488;background:#fff;border:1px solid #e6e1d4;border-radius:20px;padding:1px 9px;">' + items.length + "</span></div>" +
        (items.length ? items.map(card).join("") : '<div style="font-size:12.5px;color:#767488;text-align:center;padding:16px 4px;">—</div>') +
        "</div>";
    }).join("");
    mount.innerHTML =
      '<div style="padding:24px 28px 60px;">' +
        '<div style="display:flex;align-items:center;gap:10px;margin:0 0 4px;justify-content:space-between;">' +
          '<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:22px;"></span><h1 style="font-size:24px;margin:0;font-weight:700;color:' + ACCENT + ';">Occupational Therapy</h1></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="btn small" id="ot-add-btn">+ Add enrollment</button>' +
            '<button class="btn small secondary" id="ot-outbox-btn">✉ Messages</button>' +
            (canAdminOT() ? '<button class="btn small secondary" id="ot-settings-btn">⚙ OT Settings</button>' : "") +
          "</div>" +
        "</div>" +
        '<p style="margin:0 0 18px;color:#767488;font-size:14px;">OT intake pipeline. Each card shows what\'s holding a family up, at a glance. ' + data.total + ' OT client(s).</p>' +
        '<div style="display:flex;gap:16px;overflow-x:auto;padding-bottom:8px;align-items:flex-start;">' + cols + "</div>" +
      "</div>";
    mount.dataset.ot = "1";
    mount.querySelectorAll("[data-ot-open]").forEach((el) => el.addEventListener("click", () => openDetail(el.getAttribute("data-ot-open"))));
    const sbtn = document.getElementById("ot-settings-btn");
    if (sbtn) sbtn.addEventListener("click", openSettings);
    const abtn = document.getElementById("ot-add-btn");
    if (abtn) abtn.addEventListener("click", openAddEnrollment);
    const obtn = document.getElementById("ot-outbox-btn");
    if (obtn) obtn.addEventListener("click", openOtOutbox);
  }

  function otModal(inner, width) {
    const bd = document.createElement("div"); bd.className = "modal-backdrop";
    bd.innerHTML = '<div class="modal" style="width:' + (width || "520px") + ';max-width:94vw;">' + inner + "</div>";
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.querySelector(".close-btn").addEventListener("click", close);
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    return { bd, close };
  }

  function openAddEnrollment() {
    const { bd, close } = otModal(
      '<div class="modal-header"><h2>Add OT Enrollment</h2><button class="close-btn">✕</button></div>' +
      '<p style="font-size:13px;color:#767488;margin-top:0;">Creates a new OT lead. If you enter a parent email, they get a link to complete the intake form.</p>' +
      '<div class="field"><label>Child name *</label><input id="ot-e-child" /></div>' +
      '<div class="field"><label>Parent / caregiver name</label><input id="ot-e-parent" /></div>' +
      '<div class="field"><label>Parent email</label><input id="ot-e-email" type="email" placeholder="Sends the intake link if provided" /></div>' +
      '<div class="field"><label>Parent phone</label><input id="ot-e-phone" /></div>' +
      '<div style="margin-top:14px;display:flex;gap:8px;align-items:center;"><button class="btn" id="ot-e-save">Create enrollment</button><span id="ot-e-status" style="font-size:12.5px;color:#767488;"></span></div>'
    );
    bd.querySelector("#ot-e-save").addEventListener("click", async () => {
      const child = bd.querySelector("#ot-e-child").value.trim();
      const st = bd.querySelector("#ot-e-status");
      if (!child) { st.textContent = "Child name is required."; return; }
      st.textContent = "Creating…";
      try {
        const r = await api("/api/ot/enrollment", { method: "POST", body: {
          child_name: child, parent_name: bd.querySelector("#ot-e-parent").value.trim(),
          parent_email: bd.querySelector("#ot-e-email").value.trim(), parent_phone: bd.querySelector("#ot-e-phone").value.trim(),
        } });
        st.textContent = r.emailed ? "Created ✓ — intake link emailed." : "Created ✓";
        setTimeout(() => { close(); render(); }, 900);
      } catch (e) { st.textContent = e.message || "Failed."; }
    });
  }

  async function openOtOutbox() {
    const { bd } = otModal('<div class="modal-header"><h2>OT Messages</h2><button class="close-btn">✕</button></div><div id="ot-ob-body"><p style="color:#767488;">Loading…</p></div>', "680px");
    const body = bd.querySelector("#ot-ob-body");
    let rows;
    try { rows = await api("/api/ot/notifications"); }
    catch (e) { body.innerHTML = '<p style="color:#a3282e;">' + esc(e.message) + "</p>"; return; }
    if (!rows.length) { body.innerHTML = '<p style="color:#767488;">No OT emails sent yet.</p>'; return; }
    body.innerHTML = rows.map((n) =>
      '<div class="task-row"><div class="info"><strong>' + esc(n.subject) + '</strong><div class="due">to ' + esc(n.recipient || "—") + " · " + esc((n.type || "").replace(/_/g, " ")) + "</div></div>" +
      '<button class="btn small secondary" data-ot-vn="' + n.id + '">View</button></div>'
    ).join("");
    const map = {}; rows.forEach((n) => { map[String(n.id)] = n; });
    body.querySelectorAll("[data-ot-vn]").forEach((b) => b.addEventListener("click", () => {
      const n = map[b.getAttribute("data-ot-vn")]; if (!n) return;
      const m = otModal('<div class="modal-header"><h2 style="font-size:16px;">' + esc(n.subject) + '</h2><button class="close-btn">✕</button></div>' +
        '<div style="font-size:12.5px;color:#767488;margin-bottom:10px;">to ' + esc(n.recipient || "—") + " · " + esc(fmtWhen(n.sent_at)) + "</div>" +
        '<div style="border:1px solid #e6e1d4;border-radius:10px;padding:14px;max-height:60vh;overflow:auto;background:#fff;">' + (n.body || "<em>(no body)</em>") + "</div>", "680px");
    }));
  }

  function fmtWhen(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return iso || ""; } }

  async function openSettings() {
    let s;
    try { s = await api("/api/ot/settings"); } catch (e) { alert(e.message); return; }
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    const fields = [
      ["ot_eligibility_email", "Eligibility Verification Email", "Where eligibility & benefits requests are sent (with insurance cards attached)."],
      ["ot_intake_notification_emails", "Intake Notification Recipients", "Notified when a new OT intake is submitted. Comma-separate for multiple."],
      ["ot_referral_email", "Referral Recipient", "Optional — where referral/order requests go."],
      ["ot_general_notification_email", "General Notification Email", "Optional — general OT notifications."],
    ];
    back.innerHTML = '<div class="modal"><div class="modal-header"><div><h2>OT Settings</h2><span class="badge" style="background:' + ACCENT + '">Automations</span></div><button class="close-btn">✕</button></div>' +
      '<p style="color:var(--text-muted);font-size:13px;margin-top:-6px;">These control OT email automations. Nothing is hardcoded — set them here.</p>' +
      fields.map(function (f) { return '<div class="field"><label>' + f[1] + '</label><input id="set-' + f[0] + '" value="' + esc(s[f[0]] || "") + '" placeholder="name@spectrumsquadlv.com" /><div style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">' + f[2] + "</div></div>"; }).join("") +
      '<div style="margin-top:14px;"><button class="btn" id="ot-set-save">Save settings</button> <span id="ot-set-res" style="font-size:12px;color:var(--text-muted);"></span></div></div>';
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector(".close-btn").addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelector("#ot-set-save").addEventListener("click", async () => {
      const body = {};
      fields.forEach((f) => { body[f[0]] = back.querySelector("#set-" + f[0]).value.trim(); });
      const res = back.querySelector("#ot-set-res");
      try { await api("/api/ot/settings", { method: "POST", body: body }); res.textContent = "Saved ✓"; }
      catch (e) { res.textContent = e.message; }
    });
  }

  async function openDetail(otId) {
    let d;
    try { d = await api("/api/ot/clients/" + otId); } catch (e) { alert(e.message); return; }
    const s = d.shared || {};
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    const statusOpts = d.statuses.map((x) => '<option ' + (x === d.ot.status ? "selected" : "") + ">" + esc(x) + "</option>").join("");
    const activity = (d.activity || []).slice(0, 12).map((a) => '<div style="font-size:12.5px;padding:6px 0;border-bottom:1px solid #f0ede3;"><b>' + esc(a.type) + "</b> — " + esc(a.detail || "") + '<div style="color:#8a8797;font-size:11px;">' + esc((a.created_at || "").slice(0, 10)) + " · " + esc(a.actor || "") + "</div></div>").join("") || '<div class="empty-state">No activity yet.</div>';
    const docs = (d.documents || []).map((doc) => '<a class="btn small secondary" href="/api/ot/documents/' + doc.id + '" target="_blank" style="margin:2px 4px 2px 0;">' + esc(doc.kind || doc.filename) + "</a>").join("") || '<div class="empty-state">No documents uploaded.</div>';
    back.innerHTML = '<div class="modal">' +
      '<div class="modal-header"><div><h2>' + esc(s.child_name || "OT Client") + '</h2><span class="badge" style="background:' + ACCENT + '">Occupational Therapy</span></div><button class="close-btn">✕</button></div>' +
      '<div class="form-grid">' +
        '<div class="field"><label>Parent / Guardian</label><div>' + esc(s.parent_name || "—") + " (" + esc(s.parent_relationship || "—") + ")</div></div>" +
        '<div class="field"><label>Contact</label><div>' + esc(s.parent_email || "—") + " · " + esc(s.parent_phone || "—") + "</div></div>" +
        '<div class="field"><label>Date of Birth</label><div>' + esc(s.dob || "—") + "</div></div>" +
        '<div class="field"><label>Address</label><div>' + esc(s.address || "—") + "</div></div>" +
      "</div>" +
      (canAdminOT() ? (function () {
        var linked = s.client_id;
        var matches = (d.ot && d.ot.potential_matches) || [];
        var m = matches.length ? '<div style="font-size:12.5px;color:#767488;margin-top:6px;">Possible existing families:</div>' +
          matches.map(function (x) { return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f0ede3;"><span>' + esc(x.child_name) + ' <span style="color:#8a8797;font-size:11px">(' + esc(x.why) + ')</span></span><button class="btn small secondary" data-link="' + x.client_id + '">Link</button></div>'; }).join("") : "";
        return '<div class="section-title">Family / Identity</div>' +
          '<div>' + (linked ? '<span class="tag" style="background:#177a3c;color:#fff;">Linked to shared family #' + esc(linked) + '</span> <button class="btn small secondary" id="ot-unlink">Unlink</button>' : '<span class="tag" style="background:#946213;color:#fff;">Not linked to a shared family</span>') + '</div>' +
          m +
          '<div style="margin-top:8px;"><input id="ot-fam-q" placeholder="Search existing families by name, phone, or email…" style="width:100%;" /><div id="ot-fam-res"></div></div>';
      })() : "") +
      '<div class="section-title">OT Status</div>' +
      '<div style="display:flex;gap:8px;align-items:center;"><select id="ot-status">' + statusOpts + '</select><button class="btn small" id="ot-status-save">Update</button><span id="ot-status-res" style="font-size:12px;color:var(--text-muted);"></span></div>' +
      '<div class="section-title">Insurance & Eligibility</div>' +
      (function () {
        var o = d.ot || {};
        var st = o.eligibility_status || "not_started";
        var labelMap = { not_started: "Not started", needs_config: "Needs a recipient (set in OT Settings)", sent: "Sent — awaiting result", verified: "Verified ✓", failed: "Send failed", pending: "Pending" };
        var col = st === "verified" ? "#177a3c" : (st === "failed" || st === "needs_config" ? "#a3282e" : "#1e4fa3");
        return '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
          '<span class="tag" style="background:' + col + ';color:#fff;">' + esc(labelMap[st] || st) + "</span>" +
          (o.eligibility_sent_at ? '<span style="font-size:12px;color:var(--text-muted);">last sent ' + esc(String(o.eligibility_sent_at).slice(0, 10)) + (o.eligibility_email_to ? " → " + esc(o.eligibility_email_to) : "") + "</span>" : "") +
          (canAdminOT() ? ' <button class="btn small secondary" id="ot-elig-resend">' + (o.eligibility_sent_at ? "Resend Eligibility Verification" : "Send Eligibility Verification") + "</button>" : "") +
          '<span id="ot-elig-res" style="font-size:12px;color:var(--text-muted);"></span></div>';
      })() +
      '<div class="section-title">Documents</div>' + docs +
      '<div class="section-title">Activity</div>' + activity +
      "</div>";
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector(".close-btn").addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelector("#ot-status-save").addEventListener("click", async () => {
      const res = back.querySelector("#ot-status-res");
      try { await api("/api/ot/clients/" + otId + "/status", { method: "POST", body: { status: back.querySelector("#ot-status").value } }); res.textContent = "Saved ✓"; render(); }
      catch (e) { res.textContent = e.message; }
    });
    const resendBtn = back.querySelector("#ot-elig-resend");
    if (resendBtn) resendBtn.addEventListener("click", async () => {
      const res = back.querySelector("#ot-elig-res");
      resendBtn.disabled = true; res.textContent = "Sending…";
      try {
        const r = await api("/api/ot/clients/" + otId + "/eligibility/resend", { method: "POST", body: {} });
        res.textContent = "Sent to " + r.to + " (" + r.attachments + " attachment" + (r.attachments === 1 ? "" : "s") + ") ✓";
        close(); openDetail(otId); render();
      } catch (e) { resendBtn.disabled = false; res.textContent = e.message; }
    });
    // Family linking (admin only)
    async function doLink(clientId) {
      try { await api("/api/ot/clients/" + otId + "/link", { method: "POST", body: { client_id: clientId } }); close(); openDetail(otId); render(); }
      catch (e) { alert(e.message); }
    }
    back.querySelectorAll("[data-link]").forEach((b) => b.addEventListener("click", () => doLink(b.getAttribute("data-link"))));
    const unlink = back.querySelector("#ot-unlink");
    if (unlink) unlink.addEventListener("click", async () => { if (!confirm("Unlink this OT record from the shared family?")) return; try { await api("/api/ot/clients/" + otId + "/unlink", { method: "POST", body: {} }); close(); openDetail(otId); render(); } catch (e) { alert(e.message); } });
    const famQ = back.querySelector("#ot-fam-q");
    if (famQ) {
      var t;
      famQ.addEventListener("input", function () {
        clearTimeout(t);
        t = setTimeout(async function () {
          var q = famQ.value.trim();
          var box = back.querySelector("#ot-fam-res");
          if (q.length < 2) { box.innerHTML = ""; return; }
          try {
            var r = await api("/api/ot/family-search?q=" + encodeURIComponent(q));
            box.innerHTML = (r.results || []).length ? r.results.map(function (x) {
              return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f0ede3;"><span>' + esc(x.child_name) + ' <span style="color:#8a8797;font-size:11px">' + esc(x.parent_name || "") + (x.dob ? " · " + esc(x.dob) : "") + '</span></span><button class="btn small secondary" data-link2="' + x.id + '">Link</button></div>';
            }).join("") : '<div style="color:#8a8797;font-size:12.5px;padding:6px 0;">No matches.</div>';
            box.querySelectorAll("[data-link2]").forEach((b) => b.addEventListener("click", () => doLink(b.getAttribute("data-link2"))));
          } catch (e) { box.innerHTML = '<div class="err">' + esc(e.message) + "</div>"; }
        }, 300);
      });
    }
  }

  function onHash() {
    if (location.hash !== HASH) return;
    if (!canSeeOT()) { location.hash = "#/dashboard"; return; }
    render();
    [120, 400, 900].forEach((ms) => setTimeout(() => { const m = document.getElementById("view-mount"); if (location.hash === HASH && m && m.dataset.ot !== "1") render(); }, ms));
  }

  // Exposed so the app shell (index.html) can render the OT dashboard directly
  // for OT-only users without going through the ABA router.
  window.__otRender = render;

  function boot() {
    [200, 700, 1500, 3000].forEach((ms) => setTimeout(injectNav, ms));
    new MutationObserver(injectNav).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", onHash);
    if (location.hash === HASH) onHash();
  }
  boot();
})();
