// rethink-match-frontend.js -- Owner/Admin screen for linking CRM clients to
// Rethink clients.
//
// Nothing on this screen writes anything until a human presses Approve & Link.
// The scan only ever proposes. That is the whole point: a wrong link sends one
// child's authorization dates onto another child's record, and no alert would
// ever look wrong enough for anyone to notice.
//
// Exposes window.__renderRethinkMatch(mount) for the native router.
(function () {
  "use strict";
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function dayLabel(s) {
    if (!s) return "—"; const p = String(s).slice(0, 10).split("-"); if (p.length !== 3) return String(s);
    const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return (names[+p[1]] || p[1]) + " " + (+p[2]) + ", " + p[0];
  }

  let filter = "all";

  // Rethink client status, colour-coded so a closed record cannot be mistaken
  // for an open one at a glance. Only Active is ever auto-approvable; anything
  // else -- including a status we have not seen before -- reads as caution.
  function statusTag(s) {
    if (!s) return "";
    const v = String(s).trim();
    const k = v.toLowerCase();
    const style = k === "active" ? "background:#dcfce7; color:#166534;"
      : k === "inactive" ? "background:#fee2e2; color:#991b1b;"
      : "background:#fef3c7; color:#92400e;";
    return `<span class="tag" style="${style} margin-left:4px;" title="Client status in Rethink">${esc(v)}</span>`;
  }

  const BADGE = {
    ready:    { bg: "#dcfce7", fg: "#166534", label: "Ready to Link" },
    review:   { bg: "#fef3c7", fg: "#92400e", label: "Needs Review" },
    linked:   { bg: "#e0e7ff", fg: "#3730a3", label: "Linked" },
    no_match: { bg: "#f1f5f9", fg: "#475569", label: "No match found" },
  };

  async function renderRethinkMatch(mount) {
    mount.innerHTML = `<div class="page-header">
      <div><h1>Rethink Client Matching</h1>
        <p>Link CRM clients to their Rethink record. Nothing is saved until you approve it.</p></div>
      <div style="display:flex; gap:8px; align-items:center;">
        <button class="btn secondary" id="rm-scan">⟳ Scan Rethink clients</button>
      </div></div>
      <div id="rm-body"><div class="empty-state">Loading…</div></div>`;
    mount.querySelector("#rm-scan").addEventListener("click", () => runScan(mount));
    await fill(mount);
  }

  async function runScan(mount) {
    const btn = mount.querySelector("#rm-scan");
    btn.disabled = true; btn.textContent = "Scanning…";
    try {
      const out = await api("/api/rethink/client-match/scan", { method: "POST", body: {} });
      await fill(mount, out);
    } catch (e) {
      const box = mount.querySelector("#rm-body");
      box.innerHTML = `<div class="card" style="border-left:4px solid #dc2626;">
        <strong>Scan failed.</strong>
        <div style="font-size:13px; margin-top:6px;">${esc(e.message)}</div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:6px;">
          The full upstream response is in the Railway deploy logs — filter for <code>[rethink]</code>.</div>
      </div>` + box.innerHTML;
    }
    btn.disabled = false; btn.textContent = "⟳ Scan Rethink clients";
  }

  async function fill(mount, scanOut) {
    const box = mount.querySelector("#rm-body");
    let d;
    try { d = await api("/api/rethink/client-match"); }
    catch (e) { box.innerHTML = `<div class="empty-state">Couldn't load: ${esc(e.message)}</div>`; return; }

    const c = d.counts;
    const visible = d.items.filter((i) => filter === "all" || i.status === filter);

    const rows = visible.map((i) => {
      const b = BADGE[i.status] || BADGE.no_match;
      const cands = i.candidates || [];

      // Ready = exactly one high-confidence candidate, so it gets a one-click
      // approve. Everything else makes you pick, on purpose.
      const action = i.status === "linked"
        ? `<span style="font-size:12px; color:var(--text-muted);">${esc(i.linked_rethink_client_id)}</span>
           <button class="btn small secondary" data-rm-relink="${i.crm_client_id}">Change</button>`
        : cands.length
          ? cands.map((x) => `<div style="display:flex; align-items:center; gap:6px; margin:2px 0;">
              <button class="btn small ${i.status === "ready" ? "" : "secondary"}"
                data-rm-approve="${i.crm_client_id}" data-rm-rid="${esc(x.rethink_client_id)}">
                Approve &amp; Link</button>
              <span style="font-size:11.5px; color:var(--text-muted);">${esc(x.rethink_client_id)}</span>
            </div>`).join("")
          : `<span style="font-size:12px; color:var(--text-muted);">—</span>`;

      const candCells = cands.length
        ? cands.map((x) => `<div style="margin:2px 0;">
            <strong>${esc(x.name || "—")}</strong>
            <span class="tag" style="background:${x.confidence === "high" ? "#dcfce7" : "#fef3c7"}; color:${x.confidence === "high" ? "#166534" : "#92400e"}; margin-left:4px;">${esc(x.confidence)}</span>
            ${statusTag(x.status)}
            <div style="font-size:11px; color:var(--text-muted);">${esc(x.reason || "")}</div>
            ${x.status_blocks_ready ? `<div style="font-size:11px; color:#b45309; margin-top:2px;">
              ⚠ Held for review — ${esc(x.status_blocks_ready)}. Confirm this is the right historical record before linking.</div>` : ""}
          </div>`).join("")
        : `<span style="color:var(--text-muted);">No candidate</span>`;

      const dobCells = cands.length
        ? cands.map((x) => `<div style="margin:2px 0;">${esc(dayLabel(x.dob))}</div>`).join("")
        : "—";

      return `<tr>
        <td style="padding:9px 10px; border-top:1px solid var(--border,#eee); vertical-align:top;">
          <strong>${esc(i.crm_name)}</strong>
          <div style="font-size:11px; color:var(--text-muted);">DOB ${esc(dayLabel(i.crm_dob))}</div>
        </td>
        <td style="padding:9px 10px; border-top:1px solid var(--border,#eee); vertical-align:top; font-size:13px;">${candCells}</td>
        <td style="padding:9px 10px; border-top:1px solid var(--border,#eee); vertical-align:top; font-size:12.5px;">${dobCells}</td>
        <td style="padding:9px 10px; border-top:1px solid var(--border,#eee); vertical-align:top;">
          <span class="tag" style="background:${b.bg}; color:${b.fg};">${b.label}</span></td>
        <td style="padding:9px 10px; border-top:1px solid var(--border,#eee); vertical-align:top; text-align:right;">${action}</td>
      </tr>`;
    }).join("");

    const tab = (key, label, n) => `<button class="btn small ${filter === key ? "" : "secondary"}" data-rm-filter="${key}">${label} (${n})</button>`;

    // Rethink clients with no CRM counterpart. Read-only: no approve action,
    // no create action, nothing that writes. An Active client here may be an
    // established therapy client omitted from the CRM, which is why the
    // priority colouring exists.
    const oc = d.rethink_only_counts || { total: 0, active: 0, pending: 0, inactive: 0 };
    // A coloured dot, drawn rather than typed. These three priorities were
    // //-- the same information as emoji. This keeps the colour coding
    // and drops the pictures.
    const dotSpan = (c) => `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};vertical-align:middle;" aria-hidden="true"></span>`;
    const PRIORITY = [
      { dot: dotSpan("#dc2626"), label: "Needs attention", note: "Active in Rethink with no CRM record — may be an established therapy client missing from the CRM." },
      { dot: dotSpan("#d97706"), label: "Review", note: "Pending Acceptance in Rethink — likely not yet an active therapy client." },
      { dot: dotSpan("#9ca3af"), label: "Informational", note: "Inactive in Rethink — historical record." },
    ];
    const rethinkOnlyTable = () => {
      const rows = (d.rethink_only || []).map((r) => {
        const p = PRIORITY[r.priority] || PRIORITY[2];
        return `<tr>
          <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">
            <span title="${esc(p.label)}">${p.dot}</span> <strong>${esc(r.name || "—")}</strong></td>
          <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">${esc(dayLabel(r.dob))}</td>
          <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);"><code>${esc(r.rethink_client_id)}</code></td>
          <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">${statusTag(r.status)}</td>
          <td style="padding:9px 10px; border-top:1px solid var(--border,#eee); font-size:12.5px;">
            <span class="tag" style="background:#fee2e2; color:#991b1b;">No CRM record found</span>
            ${r.possible_closed_crm ? `<div style="font-size:11px; color:#b45309; margin-top:3px;">
              ⚠ A closed CRM client looks like this person: <strong>${esc(r.possible_closed_crm.name)}</strong>
              (#${r.possible_closed_crm.id}). Check before creating anything — it may be the same child.</div>` : ""}
          </td>
        </tr>`;
      }).join("");

      return `<div style="background:#eef4ff; color:#1b3a7b; border:1px solid #c7d8f5; border-radius:8px; padding:9px 13px; font-size:12.5px; margin-bottom:12px;">
          Clients that exist in Rethink but have no CRM record, and are not already linked or awaiting review.
          <strong>Read-only</strong> — nothing here creates or links a client.
          ${oc.active ? ` <strong style="color:#991b1b;">${oc.active} Active</strong> need attention.` : ""}
        </div>
        <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:11.5px; color:var(--text-muted); margin-bottom:10px;">
          ${PRIORITY.map((p) => `<span>${p.dot} ${esc(p.label)} — ${esc(p.note)}</span>`).join("")}
        </div>
        <div class="card"><div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:13px; min-width:760px;">
            <thead><tr style="text-align:left; color:var(--text-muted); font-size:11px; text-transform:uppercase;">
              <th style="padding:8px 10px;">Rethink client</th>
              <th style="padding:8px 10px;">DOB</th>
              <th style="padding:8px 10px;">Rethink client ID</th>
              <th style="padding:8px 10px;">Rethink status</th>
              <th style="padding:8px 10px;">CRM</th>
            </tr></thead>
            <tbody>${rows || `<tr><td colspan="5"><div class="empty-state">Every Rethink client has a CRM record or a pending match.</div></td></tr>`}</tbody>
          </table>
        </div></div>`;
    };

    box.innerHTML = `
      ${scanOut && scanOut.ok ? `<div style="background:#eef4ff; color:#1b3a7b; border:1px solid #c7d8f5; border-radius:8px; padding:9px 13px; font-size:12.5px; margin-bottom:12px;">
        Scanned ${scanOut.rethink_clients} Rethink clients against ${scanOut.crm_clients_considered} unlinked CRM clients —
        <strong>${scanOut.ready_to_link} ready</strong>, ${scanOut.needs_review} need review, ${scanOut.no_match} with no match.
        ${scanOut.already_linked ? ` ${scanOut.already_linked} already linked.` : ""}
        ${scanOut.rethink_only ? `<div style="margin-top:4px;">${scanOut.rethink_only} Rethink client(s) have no CRM record${scanOut.rethink_only_active ? `, <strong style="color:#991b1b;">${scanOut.rethink_only_active} of them Active</strong>` : ""} — see “Missing from CRM”.</div>` : ""}
      </div>` : ""}

      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px;">
        ${tab("all", "All", d.items.length)}
        ${tab("ready", "Ready to Link", c.ready)}
        ${tab("review", "Needs Review", c.review)}
        ${tab("no_match", "No match", c.no_match)}
        ${tab("linked", "Linked", c.linked)}
        ${tab("rethink_only", "Missing from CRM", oc.total)}
      </div>

      ${c.ready && filter !== "rethink_only" ? `<div style="margin-bottom:12px;">
        <button class="btn" id="rm-approve-all">Approve all ${c.ready} ready-to-link</button>
        <span style="font-size:12px; color:var(--text-muted); margin-left:8px;">Only exact first + last + DOB matches with no competing candidate.</span>
      </div>` : ""}

      <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">
        ${d.last_scanned_at ? `Last scan: ${esc(new Date(d.last_scanned_at).toLocaleString())}` : "No scan yet — press “Scan Rethink clients”."}
      </div>

      ${filter === "rethink_only" ? rethinkOnlyTable() : `<div class="card"><div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px; min-width:820px;">
          <thead><tr style="text-align:left; color:var(--text-muted); font-size:11px; text-transform:uppercase;">
            <th style="padding:8px 10px;">CRM client</th>
            <th style="padding:8px 10px;">Rethink client</th>
            <th style="padding:8px 10px;">Rethink DOB</th>
            <th style="padding:8px 10px;">Match</th>
            <th style="padding:8px 10px; text-align:right;">Action</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="5"><div class="empty-state">Nothing here.</div></td></tr>`}</tbody>
        </table>
      </div></div>`}`;

    box.querySelectorAll("[data-rm-filter]").forEach((el) => el.addEventListener("click", () => {
      filter = el.getAttribute("data-rm-filter"); fill(mount);
    }));

    box.querySelectorAll("[data-rm-approve]").forEach((el) => el.addEventListener("click", () => approve(mount, [{
      crm_client_id: Number(el.getAttribute("data-rm-approve")),
      rethink_client_id: el.getAttribute("data-rm-rid"),
    }])));

    box.querySelectorAll("[data-rm-relink]").forEach((el) => el.addEventListener("click", () => {
      const id = el.getAttribute("data-rm-relink");
      const rid = prompt("Replace the Rethink client ID for this client with:");
      if (rid && rid.trim()) approve(mount, [{ crm_client_id: Number(id), rethink_client_id: rid.trim() }], true);
    }));

    const all = box.querySelector("#rm-approve-all");
    if (all) all.addEventListener("click", () => {
      const links = d.items.filter((i) => i.status === "ready")
        .map((i) => ({ crm_client_id: i.crm_client_id, rethink_client_id: i.candidates[0].rethink_client_id }));
      if (links.length && confirm(`Link ${links.length} client(s) to Rethink?`)) approve(mount, links);
    });
  }

  async function approve(mount, links, allowOverwrite) {
    try {
      let out = await api("/api/rethink/client-match/approve", {
        method: "POST", body: { links, confirm_overwrite: !!allowOverwrite },
      });

      // The server refuses to replace an existing link, or to point two CRM
      // clients at one Rethink client, without an explicit second yes.
      const blocked = (out.results || []).filter((r) => r.needs_confirmation);
      if (blocked.length) {
        const msg = blocked.map((r) => r.error).join("\n\n");
        if (confirm(msg + "\n\nProceed anyway?")) {
          out = await api("/api/rethink/client-match/approve", {
            method: "POST", body: { links, confirm_overwrite: true, confirm_duplicate: true },
          });
        }
      }

      const failed = (out.results || []).filter((r) => !r.ok && !r.needs_confirmation);
      if (failed.length) alert(failed.map((r) => r.error).join("\n"));
      else if (out.authorization_sync && out.authorization_sync.ok === false) {
        alert("Linked, but the 97153 authorization sync failed:\n" + out.authorization_sync.error);
      }
    } catch (e) { alert(e.message); }
    await fill(mount);
  }

  window.__renderRethinkMatch = renderRethinkMatch;
})();
