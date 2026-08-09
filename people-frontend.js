// people-frontend.js -- UI for departments, emergency contacts, staff
// certifications, and the new-hire employment packet.
//
// Rendered into mount points that index.html provides, the same way
// bip-frontend.js and hr-attendance-frontend.js work, so index.html only ever
// gains a container div and one call.
//
// Icons are inline SVG rather than emoji, matching the BIP workspace.
(function () {
  "use strict";

  const esc = (s) => {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };
  const clean = (v) => (v == null ? "" : String(v).trim());

  async function call(path, opts) {
    if (typeof window.api === "function") return window.api(path, opts);
    const res = await fetch(path, {
      method: (opts && opts.method) || "GET",
      headers: { "Content-Type": "application/json" },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
    return data;
  }

  const ICON = {
    phone: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    alert: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    badge: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    doc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  };

  const CARD = "border:1px solid var(--border,#e5e7eb); border-radius:10px; padding:12px 14px; margin-bottom:10px; background:var(--card-bg,#fff);";
  // The app-wide .empty-state is a full-page placeholder with a lot of vertical
  // padding. These sections sit inline inside a card, so they use a compact one.
  const EMPTY = (msg) =>
    `<div style="font-size:13px; color:var(--text-muted); padding:10px 12px; border:1px dashed var(--border,#e5e7eb); border-radius:10px; margin-bottom:10px;">${esc(msg)}</div>`;

  function fmtDate(s) {
    if (!s) return "—";
    const d = new Date(String(s).slice(0, 10) + "T00:00:00Z");
    if (isNaN(d.getTime())) return String(s);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  // A small modal shell, so the four editors below all behave the same way.
  function drawer(title, innerHtml, onSave) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" style="width:480px;">
        <div class="modal-header"><h2 style="font-size:17px;">${esc(title)}</h2><button class="close-btn">&#10005;</button></div>
        <div class="form-grid" style="gap:10px;">${innerHtml}</div>
        <div style="margin-top:16px; display:flex; gap:8px; align-items:center;">
          <button class="btn" data-drawer-save>Save</button>
          <button class="btn secondary" data-drawer-cancel>Cancel</button>
          <span data-drawer-status style="font-size:12.5px; color:#b91c1c;"></span>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const status = (msg) => { backdrop.querySelector("[data-drawer-status]").textContent = msg || ""; };
    backdrop.querySelector(".close-btn").addEventListener("click", close);
    backdrop.querySelector("[data-drawer-cancel]").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    const saveBtn = backdrop.querySelector("[data-drawer-save]");
    saveBtn.addEventListener("click", async () => {
      const values = {};
      backdrop.querySelectorAll("[data-k]").forEach((el) => {
        values[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value;
      });
      saveBtn.disabled = true;
      status("");
      try {
        await onSave(values);
        close();
      } catch (e) {
        status(e.message || "Could not save.");
        saveBtn.disabled = false;
      }
    });
    const firstInput = backdrop.querySelector("input, select, textarea");
    if (firstInput) firstInput.focus();
    return { backdrop, close, status };
  }

  const textField = (k, label, value, opts = {}) =>
    `<div class="field ${opts.full ? "full" : ""}"><label>${esc(label)}</label>
       <input data-k="${k}" ${opts.type ? `type="${opts.type}"` : ""} value="${esc(value || "")}" placeholder="${esc(opts.placeholder || "")}" /></div>`;
  const checkField = (k, label, checked) =>
    `<div class="field full"><label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
       <input data-k="${k}" type="checkbox" ${checked ? "checked" : ""} style="width:auto;" /> ${esc(label)}</label></div>`;

  // =====================================================================
  // EMERGENCY CONTACTS  (clients and staff share one component)
  // =====================================================================
  async function renderEmergencyContacts(el, ownerType, ownerId) {
    if (!el || !ownerId) return;
    el.innerHTML = `<div style="font-size:13px; color:var(--text-muted); padding:8px 2px;">Loading emergency contacts…</div>`;
    let contacts = [];
    try {
      const data = await call(`/api/people/emergency-contacts?owner_type=${encodeURIComponent(ownerType)}&owner_id=${ownerId}`);
      contacts = data.contacts || [];
    } catch (e) {
      el.innerHTML = EMPTY(`Couldn't load emergency contacts: ${e.message}`);
      return;
    }

    const reload = () => renderEmergencyContacts(el, ownerType, ownerId);

    const row = (c) => `
      <div style="${CARD} ${c.is_primary ? "border-left:4px solid #dc2626;" : ""}">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
          <div style="min-width:0;">
            <div style="font-weight:600; font-size:14px;">
              ${esc(c.name)}
              ${c.is_primary ? `<span class="tag" style="background:#fee2e2; color:#991b1b; margin-left:6px;">Primary</span>` : ""}
              ${c.can_pick_up ? `<span class="tag" style="background:#dcfce7; color:#166534; margin-left:4px;">Authorized pickup</span>` : ""}
            </div>
            <div style="font-size:12.5px; color:var(--text-muted); margin-top:2px;">${esc(c.relationship || "Relationship not recorded")}</div>
            <div style="font-size:13.5px; margin-top:6px; display:flex; flex-wrap:wrap; gap:12px; align-items:center;">
              ${c.phone ? `<a href="tel:${esc(c.phone)}" style="display:inline-flex; align-items:center; gap:5px; text-decoration:none; color:inherit;">${ICON.phone}<strong>${esc(c.phone)}</strong></a>` : ""}
              ${c.alt_phone ? `<a href="tel:${esc(c.alt_phone)}" style="display:inline-flex; align-items:center; gap:5px; text-decoration:none; color:var(--text-muted);">${ICON.phone}${esc(c.alt_phone)}</a>` : ""}
              ${c.email ? `<a href="mailto:${esc(c.email)}" style="color:var(--text-muted); text-decoration:none;">${esc(c.email)}</a>` : ""}
            </div>
            ${c.address ? `<div style="font-size:12.5px; color:var(--text-muted); margin-top:4px;">${esc(c.address)}</div>` : ""}
            ${c.notes ? `<div style="font-size:12.5px; margin-top:6px; white-space:pre-wrap;">${esc(c.notes)}</div>` : ""}
          </div>
          <div style="white-space:nowrap; display:flex; gap:6px;">
            <button class="btn small secondary" data-ec-edit="${c.id}">Edit</button>
            <button class="btn small secondary" data-ec-del="${c.id}" style="color:#b91c1c;" title="Remove">${ICON.trash}</button>
          </div>
        </div>
      </div>`;

    el.innerHTML = `
      ${contacts.length ? contacts.map(row).join("") : EMPTY("No emergency contact on file yet.")}
      <button class="btn small" data-ec-add>+ Add emergency contact</button>`;

    const openEditor = (c) => {
      const isNew = !c;
      c = c || {};
      drawer(isNew ? "Add emergency contact" : `Edit ${c.name}`,
        [
          textField("name", "Full name", c.name),
          textField("relationship", "Relationship", c.relationship, { placeholder: ownerType === "client" ? "Mother, Grandparent, Neighbor…" : "Spouse, Parent, Friend…" }),
          textField("phone", "Phone", c.phone, { placeholder: "(702) 555-0134" }),
          textField("alt_phone", "Alternate phone", c.alt_phone),
          textField("email", "Email", c.email, { type: "email", full: true }),
          textField("address", "Address", c.address, { full: true }),
          checkField("is_primary", "This is the first person to call", !!c.is_primary),
          ownerType === "client" ? checkField("can_pick_up", "Authorized to pick the child up", !!c.can_pick_up) : "",
          `<div class="field full"><label>Notes</label><textarea data-k="notes" rows="2" placeholder="Anything the team should know before calling">${esc(c.notes || "")}</textarea></div>`,
        ].join(""),
        async (v) => {
          if (!clean(v.name)) throw new Error("A name is required.");
          if (!clean(v.phone) && !clean(v.alt_phone)) throw new Error("At least one phone number is required.");
          // owner_type rides on the query string as well as the body so the
          // per-user module gate in server.js can tell a client contact from a
          // staff one before the request reaches this module.
          if (isNew) await call(`/api/people/emergency-contacts?owner_type=${encodeURIComponent(ownerType)}`, { method: "POST", body: { ...v, owner_type: ownerType, owner_id: Number(ownerId) } });
          else await call(`/api/people/emergency-contacts/${c.id}?owner_type=${encodeURIComponent(ownerType)}`, { method: "PATCH", body: v });
          await reload();
        });
    };

    el.querySelector("[data-ec-add]").addEventListener("click", () => openEditor(null));
    el.querySelectorAll("[data-ec-edit]").forEach((b) =>
      b.addEventListener("click", () => openEditor(contacts.find((c) => String(c.id) === b.dataset.ecEdit))));
    el.querySelectorAll("[data-ec-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        const c = contacts.find((x) => String(x.id) === b.dataset.ecDel);
        if (!confirm(`Remove ${c ? c.name : "this contact"} from the emergency contacts?`)) return;
        try { await call(`/api/people/emergency-contacts/${b.dataset.ecDel}?owner_type=${encodeURIComponent(ownerType)}`, { method: "DELETE" }); await reload(); }
        catch (e) { alert(e.message); }
      }));
  }

  // =====================================================================
  // STAFF CERTIFICATIONS
  // =====================================================================
  const CERT_PRESETS = ["RBT", "BCBA", "BCaBA", "CPR / BLS", "Safety Care", "TB Test", "Background Check", "Driver's License", "Auto Insurance", "First Aid"];

  function certTone(state) {
    if (!state) return { bg: "#f3f4f6", fg: "#374151", bar: "transparent" };
    if (state.key === "expired") return { bg: "#fee2e2", fg: "#991b1b", bar: "#dc2626" };
    if (state.key === "expires_today") return { bg: "#fee2e2", fg: "#991b1b", bar: "#dc2626" };
    if (state.key === "critical") return { bg: "#fef3c7", fg: "#92400e", bar: "#d97706" };
    if (state.key === "soon") return { bg: "#e0f2fe", fg: "#075985", bar: "#0891b2" };
    if (state.key === "no_date") return { bg: "#f3f4f6", fg: "#6b7280", bar: "#9ca3af" };
    return { bg: "#dcfce7", fg: "#166534", bar: "#16a34a" };
  }

  async function renderCertifications(el, employeeId) {
    if (!el || !employeeId) return;
    el.innerHTML = `<div style="font-size:13px; color:var(--text-muted); padding:8px 2px;">Loading certifications…</div>`;
    let certs = [], directorEmail = "";
    try {
      const data = await call(`/api/people/certifications?employee_id=${employeeId}`);
      certs = data.certifications || [];
    } catch (e) {
      el.innerHTML = EMPTY(`Couldn't load certifications: ${e.message}`);
      return;
    }
    try {
      const roll = await call("/api/people/certifications/expiring?days=0");
      directorEmail = roll.clinical_director_email || "";
    } catch (e) { /* not fatal */ }

    const reload = () => renderCertifications(el, employeeId);

    const row = (c) => {
      const t = certTone(c.state);
      return `<div style="${CARD} border-left:4px solid ${t.bar};">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
          <div style="min-width:0;">
            <div style="font-weight:600; font-size:14px; display:flex; align-items:center; gap:6px;">${ICON.badge}${esc(c.name)}
              ${c.status !== "active" ? `<span class="tag">${esc(c.status)}</span>` : ""}</div>
            <div style="margin-top:5px;">
              <span class="tag" style="background:${t.bg}; color:${t.fg};">${esc((c.state && c.state.label) || "")}</span>
              <span style="font-size:12.5px; color:var(--text-muted); margin-left:6px;">Expires ${esc(fmtDate(c.expiration_date))}</span>
            </div>
            ${(() => {
              const bits = [];
              if (c.issuing_body) bits.push(esc(c.issuing_body));
              if (c.credential_number) bits.push("#" + esc(c.credential_number));
              if (c.issued_date) bits.push("Issued " + esc(fmtDate(c.issued_date)));
              if (c.notify_staff === false) bits.push("<em>staff reminders off</em>");
              return bits.length ? `<div style="font-size:12.5px; color:var(--text-muted); margin-top:5px;">${bits.join(" · ")}</div>` : "";
            })()}
            ${c.notes ? `<div style="font-size:12.5px; margin-top:5px; white-space:pre-wrap;">${esc(c.notes)}</div>` : ""}
            <div style="margin-top:6px;"><a href="#" data-cert-notices="${c.id}" style="font-size:12px; color:var(--text-muted);">Reminder history</a></div>
            <div data-cert-notice-box="${c.id}"></div>
          </div>
          <div style="white-space:nowrap; display:flex; gap:6px;">
            <button class="btn small secondary" data-cert-renew="${c.id}">Log renewal</button>
            <button class="btn small secondary" data-cert-edit="${c.id}">Edit</button>
            <button class="btn small secondary" data-cert-del="${c.id}" style="color:#b91c1c;">${ICON.trash}</button>
          </div>
        </div>
      </div>`;
    };

    el.innerHTML = `
      <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px; display:flex; align-items:center; gap:6px;">
        ${ICON.clock}Reminders go out at 90, 60, 30, 14, 7 and 1 days before expiry, on the expiry date, and weekly for a month after —
        to the staff member and ${directorEmail ? `the Clinical Director (<strong>${esc(directorEmail)}</strong>)` : `<span style="color:#b91c1c;">the Clinical Director (no address set yet — add one in Admin Settings)</span>`}.
      </div>
      ${certs.length ? certs.map(row).join("") : EMPTY("No certifications recorded for this staff member yet.")}
      <button class="btn small" data-cert-add>+ Add certification</button>`;

    const openEditor = (c, presetName) => {
      const isNew = !c;
      c = c || {};
      drawer(isNew ? "Add certification" : `Edit ${c.name}`,
        [
          `<div class="field full"><label>Certification</label>
             <input data-k="name" list="cert-presets" value="${esc(c.name || presetName || "")}" placeholder="RBT, CPR/BLS, Safety Care…" />
             <datalist id="cert-presets">${CERT_PRESETS.map((p) => `<option value="${esc(p)}"></option>`).join("")}</datalist></div>`,
          textField("issuing_body", "Issued by", c.issuing_body, { placeholder: "BACB, American Heart Association…" }),
          textField("credential_number", "Certificate / license number", c.credential_number),
          textField("issued_date", "Issued date", (c.issued_date || "").slice(0, 10), { type: "date" }),
          textField("expiration_date", "Expiration date", (c.expiration_date || "").slice(0, 10), { type: "date" }),
          checkField("notify_staff", "Email the staff member as well as the Clinical Director", c.notify_staff !== false),
          `<div class="field full"><label>Notes</label><textarea data-k="notes" rows="2">${esc(c.notes || "")}</textarea></div>`,
        ].join(""),
        async (v) => {
          if (!clean(v.name)) throw new Error("Give the certification a name.");
          if (isNew) await call("/api/people/certifications", { method: "POST", body: { ...v, employee_id: Number(employeeId) } });
          else await call(`/api/people/certifications/${c.id}`, { method: "PATCH", body: v });
          await reload();
        });
    };

    el.querySelector("[data-cert-add]").addEventListener("click", () => openEditor(null));
    el.querySelectorAll("[data-cert-edit]").forEach((b) =>
      b.addEventListener("click", () => openEditor(certs.find((c) => String(c.id) === b.dataset.certEdit))));

    // "Renewed" is the common case: same certification, new dates. Reusing the
    // same row keeps the history in one place, and because the reminder log is
    // keyed on the expiration date, changing the date re-arms every stage.
    el.querySelectorAll("[data-cert-renew]").forEach((b) =>
      b.addEventListener("click", () => {
        const c = certs.find((x) => String(x.id) === b.dataset.certRenew);
        if (!c) return;
        drawer(`Renew ${c.name}`,
          [
            `<div class="field full" style="font-size:13px; color:var(--text-muted);">Enter the new dates. The reminder schedule restarts for the new expiration date.</div>`,
            textField("issued_date", "New issued date", "", { type: "date" }),
            textField("expiration_date", "New expiration date", "", { type: "date" }),
            textField("credential_number", "Certificate number (if it changed)", c.credential_number),
          ].join(""),
          async (v) => {
            if (!clean(v.expiration_date)) throw new Error("A new expiration date is required.");
            await call(`/api/people/certifications/${c.id}`, { method: "PATCH", body: { ...v, status: "active" } });
            await reload();
          });
      }));

    el.querySelectorAll("[data-cert-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        const c = certs.find((x) => String(x.id) === b.dataset.certDel);
        if (!confirm(`Delete ${c ? c.name : "this certification"} and its reminder history?`)) return;
        try { await call(`/api/people/certifications/${b.dataset.certDel}`, { method: "DELETE" }); await reload(); }
        catch (e) { alert(e.message); }
      }));

    el.querySelectorAll("[data-cert-notices]").forEach((a) =>
      a.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const box = el.querySelector(`[data-cert-notice-box="${a.dataset.certNotices}"]`);
        if (!box) return;
        if (box.innerHTML) { box.innerHTML = ""; return; }
        box.innerHTML = `<div style="font-size:12px; color:var(--text-muted); padding:4px 0;">Loading…</div>`;
        try {
          const { notices } = await call(`/api/people/certifications/${a.dataset.certNotices}/notices`);
          box.innerHTML = notices.length
            ? `<div style="font-size:12px; color:var(--text-muted); margin-top:4px; padding-left:2px; border-left:2px solid var(--border,#e5e7eb);">
                 ${notices.map((n) => `<div style="padding:2px 0 2px 8px;">${esc(n.stage === "expired" ? "On the expiry date" : n.stage.startsWith("overdue") ? n.stage.replace("overdue-", "") + " days overdue" : n.stage + " days before")} — sent ${esc(fmtDate(n.sent_at))}${n.sent_to ? " to " + esc(n.sent_to) : ""}</div>`).join("")}
               </div>`
            : `<div style="font-size:12px; color:var(--text-muted); padding:4px 0 4px 8px;">No reminders have been sent for this certification yet.</div>`;
        } catch (e) {
          box.innerHTML = `<div style="font-size:12px; color:#b91c1c;">${esc(e.message)}</div>`;
        }
      }));
  }

  // Roll-up banner for the Staff directory page.
  async function renderCertBanner(el) {
    if (!el) return;
    let data;
    try { data = await call("/api/people/certifications/expiring?days=90"); } catch (e) { el.innerHTML = ""; return; }
    const list = data.expiring || [];
    if (!list.length) { el.innerHTML = ""; return; }
    const expired = list.filter((c) => c.state.days < 0);
    const soon = list.filter((c) => c.state.days >= 0);
    el.innerHTML = `
      <div style="border:1px solid var(--border,#e5e7eb); border-left:4px solid ${expired.length ? "#dc2626" : "#d97706"}; border-radius:10px; padding:10px 14px; background:var(--card-bg,#fff);">
        <div style="display:flex; align-items:center; gap:8px; font-weight:600; font-size:13.5px; color:${expired.length ? "#991b1b" : "#92400e"};">
          ${ICON.alert}${expired.length ? `${expired.length} certification${expired.length === 1 ? " has" : "s have"} expired` : `${soon.length} certification${soon.length === 1 ? "" : "s"} expiring within 90 days`}
        </div>
        <div style="font-size:12.5px; color:var(--text-muted); margin-top:6px; display:flex; flex-wrap:wrap; gap:6px;">
          ${list.slice(0, 12).map((c) => {
            const t = certTone(c.state);
            return `<span class="tag" style="background:${t.bg}; color:${t.fg};">${esc(c.employee_name)} · ${esc(c.name)} · ${esc(c.state.label)}</span>`;
          }).join("")}
          ${list.length > 12 ? `<span class="tag">+${list.length - 12} more</span>` : ""}
        </div>
      </div>`;
  }

  // =====================================================================
  // NEW-HIRE EMPLOYMENT PACKET (SignNow)
  // =====================================================================
  async function renderNewHirePacket(el, employeeId) {
    if (!el || !employeeId) return;
    el.innerHTML = `<div style="font-size:13px; color:var(--text-muted); padding:8px 2px;">Checking packet status…</div>`;
    let data;
    try { data = await call(`/api/hr/employees/${employeeId}/newhire-packet`); }
    catch (e) { el.innerHTML = EMPTY(`Couldn't check the packet: ${e.message}`); return; }

    const p = data.packet;
    const statusLine = !data.configured
      ? `<span style="color:#92400e;">Not set up yet — ${data.signnow_connected ? "add the SignNow template ID in Admin Settings" : "connect SignNow on the server"}.</span>`
      : !p ? `Not sent yet. It sends automatically the moment this person's offer is accepted.`
      : p.status === "sent" ? `<span style="color:#166534;">Sent ${esc(fmtDate(p.sent_at))}${p.recipient_email ? " to " + esc(p.recipient_email) : ""}. Waiting on their signature.</span>`
      : p.status === "completed" ? `<span style="color:#166534;">Completed ${esc(fmtDate(p.completed_at))}.</span>`
      : `<span style="color:#b91c1c;">${esc(p.status)} — ${esc(p.error_detail || "no detail recorded")} (${p.attempts} attempt${p.attempts === 1 ? "" : "s"})</span>`;

    el.innerHTML = `
      <div style="${CARD}">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
          <div style="min-width:0;">
            <div style="font-weight:600; font-size:13.5px; display:flex; align-items:center; gap:6px;">${ICON.doc}New hire employment packet</div>
            <div style="font-size:12.5px; margin-top:5px;">${statusLine}</div>
          </div>
          <div style="white-space:nowrap;">
            <button class="btn small secondary" data-packet-send>${p && ["sent", "completed"].includes(p.status) ? "Resend" : "Send now"}</button>
          </div>
        </div>
        <div data-packet-status style="font-size:12.5px; margin-top:8px;"></div>
      </div>`;

    el.querySelector("[data-packet-send]").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      const already = p && ["sent", "completed"].includes(p.status);
      if (already && !confirm("This person has already been sent their packet. Send another copy?")) return;
      btn.disabled = true;
      const out = el.querySelector("[data-packet-status]");
      out.textContent = "Sending…";
      out.style.color = "var(--text-muted)";
      try {
        await call(`/api/hr/employees/${employeeId}/newhire-packet`, { method: "POST", body: { force: !!already } });
        await renderNewHirePacket(el, employeeId);
      } catch (e) {
        out.textContent = e.message;
        out.style.color = "#b91c1c";
        btn.disabled = false;
      }
    });
  }

  // =====================================================================
  // DEPARTMENTS (Admin Settings)
  // =====================================================================
  async function renderDepartmentsAdmin(el) {
    if (!el) return;
    el.innerHTML = `<div style="font-size:13px; color:var(--text-muted); padding:8px 2px;">Loading departments…</div>`;
    let data;
    try { data = await call("/api/people/departments"); }
    catch (e) { el.innerHTML = EMPTY(`Couldn't load departments: ${e.message}`); return; }
    const depts = data.departments || [];
    const colors = data.colors || [];
    const reload = async () => {
      await renderDepartmentsAdmin(el);
      // Keep every department picker in the app in step with the change.
      if (window.state && typeof window.api === "function") {
        try { window.state.departments = await window.api("/api/departments"); } catch (e) {}
      }
    };

    const row = (d) => `
      <div style="${CARD} border-left:4px solid ${esc(d.color)}; ${d.active === false ? "opacity:.6;" : ""}">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start; flex-wrap:wrap;">
          <div style="min-width:200px;">
            <div style="font-weight:600; font-size:14px;">${esc(d.name)}
              ${d.active === false ? `<span class="tag">Retired</span>` : ""}</div>
            <div style="font-size:12.5px; color:var(--text-muted); margin-top:3px;">
              ${d.notify_email ? esc(d.notify_email) : "<em>no notification email</em>"}
            </div>
            <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">
              Routes ${d.usage.stage_tasks} pipeline task${d.usage.stage_tasks === 1 ? "" : "s"} · ${d.usage.users} team member${d.usage.users === 1 ? "" : "s"}
            </div>
            ${d.description ? `<div style="font-size:12.5px; margin-top:5px;">${esc(d.description)}</div>` : ""}
          </div>
          <div style="white-space:nowrap; display:flex; gap:6px; align-items:flex-start;">
            <button class="btn small secondary" data-dept-edit="${d.id}">Edit</button>
            <button class="btn small secondary" data-dept-toggle="${d.id}">${d.active === false ? "Reactivate" : "Retire"}</button>
            <button class="btn small secondary" data-dept-del="${d.id}" style="color:#b91c1c;">${ICON.trash}</button>
          </div>
        </div>
      </div>`;

    el.innerHTML = `
      <p style="font-size:13px; color:var(--text-muted); margin-top:0;">
        Departments drive pipeline task routing, alert emails, and the department picker on every team member.
        Renaming one updates it everywhere immediately. Retiring one hides it from new pickers but keeps its history.
      </p>
      ${depts.map(row).join("")}
      <button class="btn small" data-dept-add>+ Add department</button>`;

    const editor = (d) => {
      const isNew = !d;
      d = d || {};
      drawer(isNew ? "Add department" : `Edit ${d.name}`,
        [
          textField("name", "Department name", d.name, { full: true, placeholder: "Clinical, Billing, Front Desk…" }),
          textField("notify_email", "Notification email", d.notify_email, { type: "email", full: true, placeholder: "Alerts for this department go here" }),
          `<div class="field full"><label>Color</label>
             <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
               <input data-k="color" type="color" value="${esc(d.color || colors[0] || "#4f46e5")}" style="width:52px; height:34px; padding:2px;" />
               ${colors.map((c) => `<button type="button" data-swatch="${esc(c)}" style="width:22px;height:22px;border-radius:50%;border:1px solid #0002;background:${esc(c)};cursor:pointer;"></button>`).join("")}
             </div></div>`,
          `<div class="field full"><label>What this department handles (optional)</label><textarea data-k="description" rows="2">${esc(d.description || "")}</textarea></div>`,
        ].join(""),
        async (v) => {
          if (!clean(v.name)) throw new Error("Give the department a name.");
          if (isNew) await call("/api/people/departments", { method: "POST", body: v });
          else await call(`/api/people/departments/${d.id}`, { method: "PATCH", body: v });
          await reload();
        });
      document.querySelectorAll("[data-swatch]").forEach((b) =>
        b.addEventListener("click", () => {
          const input = b.closest(".modal").querySelector('[data-k="color"]');
          if (input) input.value = b.dataset.swatch;
        }));
    };

    el.querySelector("[data-dept-add]").addEventListener("click", () => editor(null));
    el.querySelectorAll("[data-dept-edit]").forEach((b) =>
      b.addEventListener("click", () => editor(depts.find((d) => String(d.id) === b.dataset.deptEdit))));

    el.querySelectorAll("[data-dept-toggle]").forEach((b) =>
      b.addEventListener("click", async () => {
        const d = depts.find((x) => String(x.id) === b.dataset.deptToggle);
        if (!d) return;
        try {
          await call(`/api/people/departments/${d.id}`, { method: "PATCH", body: { active: d.active === false } });
          await reload();
        } catch (e) { alert(e.message); }
      }));

    // Deleting a department that still routes tasks would break stage routing,
    // so the server refuses until a replacement is named. That refusal comes
    // back with the list of choices, which is what this prompt is built from.
    el.querySelectorAll("[data-dept-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        const d = depts.find((x) => String(x.id) === b.dataset.deptDel);
        if (!d) return;
        if (!confirm(`Delete the ${d.name} department?`)) return;
        try {
          await call(`/api/people/departments/${d.id}`, { method: "DELETE" });
          await reload();
          return;
        } catch (e) {
          // Not an "in use" refusal? Just report it.
          if (!/still used by/i.test(e.message) && !/in_use/i.test(e.message)) { alert(e.message); return; }
        }
        const options = depts.filter((x) => x.id !== d.id && x.active !== false);
        drawer(`Move ${d.name}'s work first`,
          [
            `<div class="field full" style="font-size:13px;">${esc(d.name)} still routes ${d.usage.stage_tasks} pipeline task${d.usage.stage_tasks === 1 ? "" : "s"} and is set on ${d.usage.users} team member${d.usage.users === 1 ? "" : "s"}. Choose where those should go.</div>`,
            `<div class="field full"><label>Move everything to</label><select data-k="reassign_to">
               ${options.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}</select></div>`,
          ].join(""),
          async (v) => {
            if (!v.reassign_to) throw new Error("Pick a department.");
            await call(`/api/people/departments/${d.id}?reassign_to=${encodeURIComponent(v.reassign_to)}`, { method: "DELETE" });
            await reload();
          });
      }));
  }


  // =====================================================================
  // STAFF AVATAR -- one implementation, used everywhere a staff member is
  // named. Initials render immediately; the photo swaps in only for people
  // who actually have one, so no screen fires a request that 404s. If the
  // image fails for any reason the initials simply stay, which is why they
  // are the markup rather than a placeholder behind it.
  // =====================================================================
  function avatarInitials(name) {
    return clean(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  }

  function staffAvatarHtml(employeeId, name, opts = {}) {
    const size = opts.size || 32;
    const has = opts.hasPhoto ? "1" : "0";
    return `<span class="staff-avatar" data-avatar-emp="${employeeId == null ? "" : employeeId}" data-avatar-has="${has}"
      title="${esc(name || "")}"
      style="width:${size}px; height:${size}px; border-radius:50%; background:#eceafd; color:#4c34b5;
             font-size:${Math.max(9, Math.round(size * 0.36))}px; font-weight:750; display:inline-flex;
             align-items:center; justify-content:center; overflow:hidden; flex:0 0 auto; ${opts.style || ""}"
      >${esc(avatarInitials(name))}</span>`;
  }

  // Call after inserting markup that contains staff avatars.
  function hydrateAvatars(root) {
    (root || document).querySelectorAll('.staff-avatar[data-avatar-has="1"]:not([data-avatar-done])').forEach((el) => {
      const id = el.dataset.avatarEmp;
      if (!id) return;
      el.setAttribute("data-avatar-done", "1");
      const img = new Image();
      img.alt = el.getAttribute("title") || "";
      img.style.cssText = "width:100%;height:100%;object-fit:cover;";
      img.onload = () => { el.textContent = ""; el.appendChild(img); };
      img.onerror = () => { /* keep the initials */ };
      img.src = `/api/hr/employees/${encodeURIComponent(id)}/photo`;
    });
  }

  window.PeopleUI = {
    staffAvatarHtml,
    hydrateAvatars,
    avatarInitials,
    renderEmergencyContacts,
    renderCertifications,
    renderCertBanner,
    renderNewHirePacket,
    renderDepartmentsAdmin,
  };
  window.StaffAvatar = { html: staffAvatarHtml, hydrate: hydrateAvatars, initials: avatarInitials };
})();
