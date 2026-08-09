// signnow-import-frontend.js -- the review screen for the SignNow back-catalogue.
//
// The screen exists because the import must not be a button that says "go".
// Filing a signed enrollment packet -- SSN, insurance card and all -- onto the
// wrong child's record is a HIPAA incident, so every proposed match is shown
// with the evidence that produced it, and nothing is written until someone
// ticks it.
//
// Four groups, in the order a person actually needs them:
//   Ready      matched on signer email or a full name. Pre-ticked.
//   Needs you  matched weakly, ambiguously, or not at all. Nothing pre-ticked;
//              each row gets a picker so it can be placed by hand.
//   Skipped    tests, blank templates, superseded timecards. Shown with the
//              reason so "not imported" is a decision you can see and overrule.
//   Done       already filed by an earlier run.
(function () {
  "use strict";
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }

  let plan = null;
  let clients = [];
  let staff = [];
  const chosen = {};   // signnow_id -> { target_type, target_id }

  const CONFIDENCE = {
    exact:     ["#dcfce7", "#166534", "signer email"],
    strong:    ["#e0e7ff", "#3730a3", "name match"],
    weak:      ["#fef3c7", "#92400e", "first name only"],
    ambiguous: ["#fee2e2", "#991b1b", "more than one match"],
    none:      ["#f3f4f6", "#4b5563", "no match"],
  };

  function pill(conf) {
    const c = CONFIDENCE[conf] || CONFIDENCE.none;
    return `<span class="tag" style="background:${c[0]}; color:${c[1]};">${esc(c[2])}</span>`;
  }

  function personOptions(selected) {
    const sel = selected || {};
    const cOpts = clients.map((c) =>
      `<option value='client:${c.id}' ${sel.target_type === "client" && Number(sel.target_id) === c.id ? "selected" : ""}>${esc(c.child_name)}</option>`).join("");
    const sOpts = staff.filter((s) => s.employee_id).map((s) =>
      `<option value='employee:${s.employee_id}' ${sel.target_type === "employee" && Number(sel.target_id) === s.employee_id ? "selected" : ""}>${esc(s.name)}</option>`).join("");
    return `<option value="">— leave it in SignNow —</option>`
      + `<optgroup label="Clients">${cOpts}</optgroup>`
      + `<optgroup label="Staff">${sOpts}</optgroup>`;
  }

  function readyRow(r) {
    const m = r.match || {};
    return `<div class="task-row" style="align-items:flex-start;">
      <label style="display:flex; gap:10px; align-items:flex-start; flex:1; cursor:pointer;">
        <input type="checkbox" data-imp="${esc(r.signnow_id)}" data-target="${esc(m.type)}:${esc(m.id)}" checked style="margin-top:3px;" />
        <span class="info" style="flex:1;">
          <strong>${esc(r.title)}</strong> ${pill(m.confidence)}
          <div class="due">→ ${esc(m.type === "client" ? "Client" : "Staff")}: <strong>${esc(m.name)}</strong> · ${esc(m.evidence || "")}</div>
        </span>
      </label>
    </div>`;
  }

  function needsRow(r) {
    const m = r.match || {};
    return `<div class="task-row" style="align-items:flex-start;">
      <div class="info" style="flex:1;">
        <strong>${esc(r.title)}</strong> ${pill(m.confidence || "none")}
        <div class="due">${esc(r.reason || m.evidence || "")}${(r.signer_emails || []).length ? ` · signed by ${esc(r.signer_emails.join(", "))}` : " · no signer on file"}</div>
        <div style="margin-top:6px;">
          <select data-place="${esc(r.signnow_id)}" style="max-width:320px;">${personOptions(chosen[r.signnow_id])}</select>
        </div>
      </div>
    </div>`;
  }

  function skippedRow(r) {
    return `<div class="task-row" style="align-items:flex-start;">
      <div class="info" style="flex:1;">
        <strong style="font-weight:600;">${esc(r.title)}</strong>
        <div class="due">${esc(r.reason || "")}</div>
        <div style="margin-top:6px;">
          <select data-place="${esc(r.signnow_id)}" style="max-width:320px;">${personOptions(chosen[r.signnow_id])}</select>
        </div>
      </div>
    </div>`;
  }

  function section(title, subtitle, rows, html, open) {
    if (!rows.length) return "";
    return `<div class="card" style="margin-top:14px;">
      <div class="section-title" style="margin-top:0;">${esc(title)} (${rows.length})</div>
      ${subtitle ? `<p style="font-size:12.5px; color:var(--text-muted); margin:-4px 0 10px;">${subtitle}</p>` : ""}
      <div style="max-height:${open ? "none" : "460px"}; overflow:auto;">${rows.map(html).join("")}</div>
    </div>`;
  }

  function render(mount) {
    const c = (plan && plan.counts) || {};
    mount.innerHTML = `<div class="page-header">
        <div><h1>SignNow document import</h1><p>File signed documents onto the client and staff records they belong to. Nothing is written until you tick it.</p></div>
        <div style="display:flex; gap:8px;">
          <button class="btn secondary" id="sni-scan">Scan SignNow</button>
          <button class="btn" id="sni-import">Import ticked</button>
        </div>
      </div>
      <div id="sni-status" style="font-size:13px; color:var(--text-muted); margin-bottom:10px;"></div>
      <div id="sni-body">${plan ? "" : `<div class="empty-state">Press <strong>Scan SignNow</strong> to read the account. That reads only — it writes nothing.</div>`}</div>`;

    mount.querySelector("#sni-scan").addEventListener("click", () => scan(mount));
    mount.querySelector("#sni-import").addEventListener("click", () => commit(mount));
    if (plan) renderPlan(mount);
  }

  function renderPlan(mount) {
    const body = mount.querySelector("#sni-body");
    const c = plan.counts;
    body.innerHTML = `
      <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:6px;">
        ${[["Ready to file", c.ready, "#166534"], ["Need you to place", c.needsYou, "#92400e"],
           ["Skipped", c.skipped, "#4b5563"], ["Already filed", c.alreadyImported, "#3730a3"]]
          .map(([label, n, col]) => `<div style="flex:1; min-width:150px; background:var(--bg,#f7f8fb); border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:14px 16px;">
            <div style="font-size:26px; font-weight:800; color:${col};">${n}</div>
            <div style="font-size:12px; color:var(--text-muted);">${label}</div></div>`).join("")}
      </div>
      <p style="font-size:12.5px; color:var(--text-muted);">${c.total} documents in SignNow, matched against ${plan.clients} clients and ${plan.employees} staff. Enrollment packets can contain Social Security numbers and insurance cards — once filed here they are visible to anyone who can already open client records, and every view is logged.</p>
      ${section("Ready to file", "Matched on the signer's email address or their full name in the title. Untick anything that looks wrong.", plan.ready, readyRow)}
      ${section("Need you to place", "Not confident enough to file on its own. Pick a person and it will be included.", plan.needsYou, needsRow)}
      ${section("Skipped", "Left alone on purpose. Pick a person on any of these to overrule it.", plan.skipped, skippedRow)}
      ${section("Already filed", "Imported by an earlier run. Running the import again will not duplicate them.", plan.alreadyImported,
        (r) => `<div class="task-row"><div class="info"><strong style="font-weight:600;">${esc(r.title)}</strong><div class="due">${esc(r.reason || "")}</div></div></div>`)}`;

    body.querySelectorAll("[data-place]").forEach((sel) => {
      sel.addEventListener("change", () => {
        const id = sel.dataset.place;
        if (!sel.value) { delete chosen[id]; return; }
        const [type, tid] = sel.value.split(":");
        chosen[id] = { target_type: type, target_id: Number(tid) };
        updateCount(mount);
      });
    });
    body.querySelectorAll("[data-imp]").forEach((cb) => cb.addEventListener("change", () => updateCount(mount)));
    updateCount(mount);
  }

  function selection(mount) {
    const items = [];
    mount.querySelectorAll("[data-imp]:checked").forEach((cb) => {
      const [type, id] = String(cb.dataset.target).split(":");
      if (type && id && id !== "null") items.push({ signnow_id: cb.dataset.imp, target_type: type, target_id: Number(id) });
    });
    Object.keys(chosen).forEach((sid) => items.push({ signnow_id: sid, ...chosen[sid] }));
    return items;
  }

  function updateCount(mount) {
    const n = selection(mount).length;
    const btn = mount.querySelector("#sni-import");
    if (btn) btn.textContent = n ? `Import ${n} document${n === 1 ? "" : "s"}` : "Import ticked";
  }

  async function scan(mount) {
    const st = mount.querySelector("#sni-status");
    const btn = mount.querySelector("#sni-scan");
    btn.disabled = true;
    st.textContent = "Reading SignNow… this takes a minute or two the first time, because every document has to be asked who signed it.";
    try {
      const r = await api("/api/signnow-import/refresh", { method: "POST" });
      st.textContent = `Read ${r.total} documents${r.unreadable ? ` — ${r.unreadable} could not be opened and are listed below` : ""}.`;
      plan = await api("/api/signnow-import/preview");
      renderPlan(mount);
    } catch (e) {
      st.textContent = e.message || "Could not read SignNow.";
    } finally { btn.disabled = false; }
  }

  async function commit(mount) {
    const items = selection(mount);
    const st = mount.querySelector("#sni-status");
    if (!items.length) { st.textContent = "Nothing is ticked yet."; return; }
    if (!confirm(`File ${items.length} document${items.length === 1 ? "" : "s"} onto their records?\n\nThe originals stay in SignNow. Anything you got wrong can be deleted from the client or staff card afterwards.`)) return;
    const btn = mount.querySelector("#sni-import");
    btn.disabled = true;
    st.textContent = `Downloading and filing ${items.length}…`;
    try {
      const r = await api("/api/signnow-import/commit", { method: "POST", body: { items } });
      const mb = Math.round((r.bytes || 0) / 1048576 * 10) / 10;
      st.textContent = `Filed ${r.imported}${r.failed ? `, ${r.failed} failed` : ""}${r.skipped ? `, ${r.skipped} already there` : ""} — ${mb} MB.`;
      if (r.failed) {
        const bad = (r.results || []).filter((x) => !x.ok && !x.already).slice(0, 5).map((x) => x.error);
        st.textContent += " " + bad.join(" · ");
      }
      Object.keys(chosen).forEach((k) => delete chosen[k]);
      plan = await api("/api/signnow-import/preview");
      renderPlan(mount);
    } catch (e) {
      st.textContent = e.message || "Import failed.";
    } finally { btn.disabled = false; }
  }

  async function load(mount) {
    try {
      const [cl, sf] = await Promise.all([api("/api/clients"), api("/api/staff")]);
      clients = (Array.isArray(cl) ? cl : []).slice().sort((a, b) => String(a.child_name).localeCompare(String(b.child_name)));
      staff = Array.isArray(sf) ? sf : [];
    } catch (e) { /* the pickers degrade to empty rather than blocking the page */ }
    render(mount);
    // A previous scan survives a page reload, so show it rather than making
    // someone re-read 212 documents to see where they got to.
    try {
      const p = await api("/api/signnow-import/preview");
      if (!p.empty) { plan = p; renderPlan(mount); }
    } catch (e) { /* not scanned yet */ }
  }

  window.__renderSignNowImport = function (mount) { return load(mount); };
})();
