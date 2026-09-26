// rethink-staff-frontend.js -- Owner/Admin screen for putting Rethink's staff
// into the CRM.
//
// WHY THIS READS THE SCHEDULE AND NOT A STAFF LIST: this Rethink account has
// no staff endpoint. The activity scan next door already records the finding in
// production terms -- Appointments is the one endpoint this account can read --
// so the roster is derived from who actually delivered sessions. That turns out
// to be the better list anyway: it contains exactly the people seeing clients,
// rather than a directory that still holds leavers.
//
// NOTHING IS CREATED UNTIL SOMEBODY PRESSES A BUTTON. An hr_employees row is
// the anchor for documents, attendance, PTO, benefits and termination, so one
// created by an automation is a personnel file for a person who may already
// have one under a different spelling.
//
// Exposes window.__renderRethinkStaff(mount) for the native router.
(function () {
  "use strict";
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function attr(s) { return esc(s).replace(/"/g, "&quot;"); }
  function dayLabel(s) {
    if (!s) return "—"; const p = String(s).slice(0, 10).split("-"); if (p.length !== 3) return String(s);
    const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return (names[+p[1]] || p[1]) + " " + (+p[2]) + ", " + p[0];
  }

  async function renderRethinkStaff(mount) {
    mount.innerHTML = `<div class="page-header">
      <div><h1>Rethink Staff</h1>
        <p>Find the people delivering sessions in Rethink and put them in the CRM. Nothing is saved until you approve it.</p></div>
      <div style="display:flex; gap:8px; align-items:center;">
        <button class="btn" id="rs-scan">⟳ Scan Rethink for employees</button>
      </div></div>
      <div id="rs-body"><div class="empty-state">Loading…</div></div>
      <div id="rs-discovery"></div>`;
    mount.querySelector("#rs-scan").addEventListener("click", () => runScan(mount));
    await fill(mount);
    await fillDiscovery(mount);
  }

  // ---- what this account's Rethink API can actually be asked for ----------
  //
  // Sits here because this is the screen where the limits of the integration
  // already show: the staff list is derived from appointments precisely
  // BECAUSE there is no staff endpoint. Whether there is a PROGRAMMING
  // endpoint is the same kind of question and deserves the same kind of
  // answer -- asked, not assumed.
  //
  // Owner/super-admin at the server. The panel is not rendered at all for
  // anyone else, and it is the 403 that decides that rather than a guess in
  // the browser about who is reading.
  async function fillDiscovery(mount) {
    const box = mount.querySelector("#rs-discovery");
    if (!box) return;
    let d;
    try { d = await api("/api/rethink/discovery"); }
    catch (e) { box.innerHTML = ""; return; }

    const results = d.results || [];
    const controls = results.filter((r) => r.is_control);
    const found = results.filter((r) => !r.is_control && r.ok);
    const run = d.last_run || null;

    const row = (r) => {
      const status = r.ok
        ? `<span class="tag" style="background:#dcfce7; color:#166534;">HTTP 200</span>`
        : `<span class="tag" style="background:#f1f1f4; color:#4b5563;">${r.http_status ? "HTTP " + r.http_status : esc(r.error_kind || "error")}</span>`;
      return `<div style="padding:6px 0; border-bottom:1px solid var(--border,#eee); font-size:12.5px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <strong>${esc(r.endpoint)}</strong>
          ${r.is_control ? `<span class="tag" style="background:#eef1fb; color:#1b2a6b;">already in use</span>` : ""}
          ${status}
          ${r.ok ? `<span style="color:var(--text-muted);">${r.rows_seen} row(s) read${
            r.envelope_counters && r.envelope_counters.totalCount != null ? `, ${r.envelope_counters.totalCount} available` : ""}</span>` : ""}
        </div>
        ${r.ok && (r.row_keys || []).length ? `<div style="margin-top:3px; color:var(--text-muted); font-family:ui-monospace,monospace; font-size:11.5px; word-break:break-word;">${
          esc(r.row_keys.join(", "))}</div>` : ""}
      </div>`;
    };

    box.innerHTML = `<details class="card" style="margin-top:18px;">
      <summary style="cursor:pointer; font-weight:700;">What this Rethink account can be asked for${
        run ? ` — last checked ${esc(new Date(run.finished_at || run.started_at).toLocaleString())}` : ""}</summary>
      <p style="font-size:12.5px; color:var(--text-muted); margin:8px 0 10px;">
        Asks each endpoint for <strong>one row</strong> and records whether it answered and
        <strong>what its fields are called</strong> — names only, never values, so nothing about a child appears here.
        It only ever reads; it cannot change anything in Rethink.
      </p>
      ${run && run.note ? `<div style="background:#fef2f2; border:1px solid #fecaca; color:#991b1b; border-radius:8px; padding:9px 11px; font-size:12.5px; margin-bottom:10px;">${esc(run.note)}</div>` : ""}
      ${results.length ? `<div style="background:#eff6ff; border:1px solid #bfdbfe; color:#1e40af; border-radius:8px; padding:10px 12px; font-size:12.5px; margin-bottom:10px;">
        ${esc(verdictOf(d))}</div>` : ""}
      ${results.length ? `<div>${controls.map(row).join("")}${results.filter((r) => !r.is_control).map(row).join("")}</div>`
        : `<div class="empty-state">Not checked yet.</div>`}
      <div style="margin-top:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <button class="btn secondary" id="rs-probe">${results.length ? "Check again" : "Check what Rethink exposes"}</button>
        <input id="rs-probe-extra" placeholder="Also try these names (comma separated)"
          style="flex:1; min-width:220px; padding:6px 8px; border:1px solid var(--border,#e5e7eb); border-radius:8px; font-size:12.5px;" />
      </div>
      ${found.length ? "" : `<p style="font-size:12px; color:var(--text-muted); margin:9px 0 0;">
        If Rethink support gives you the name of a programming endpoint, type it above and check again.</p>`}
    </details>`;

    const btn = box.querySelector("#rs-probe");
    if (btn) btn.addEventListener("click", async () => {
      const extraEl = box.querySelector("#rs-probe-extra");
      const extra = (extraEl && extraEl.value ? extraEl.value : "").split(",").map((x) => x.trim()).filter(Boolean);
      btn.disabled = true; btn.textContent = "Checking… this takes about a minute";
      try {
        await api("/api/rethink/discovery/probe", { method: "POST", body: { extra_endpoints: extra } });
      } catch (e) {
        alert((e && e.message) || "The check could not run.");
      }
      await fillDiscovery(mount);
    });
  }

  // The server already decides what the run means; the panel repeats its
  // sentence rather than inventing a second opinion from the same rows.
  function verdictOf(d) {
    const results = d.results || [];
    const controlsOk = results.filter((r) => r.is_control && r.ok).length;
    const found = results.filter((r) => !r.is_control && r.ok);
    if (!controlsOk) return "None of the endpoints the CRM already uses answered, so this check says nothing about programming — fix the connection and run it again.";
    if (!found.length) return `The ${controlsOk} endpoint(s) the CRM already uses answered normally, and none of the candidate programming endpoints did. On this account, programming does not appear to be reachable through the Rethink API under any of the names tried.`;
    return `${found.length} endpoint(s) answered: ${found.map((r) => r.endpoint).join(", ")}. Their field names are listed above.`;
  }

  async function runScan(mount) {
    const btn = mount.querySelector("#rs-scan");
    btn.disabled = true; btn.textContent = "Scanning…";
    let out = null;
    try {
      out = await api("/api/rethink/staff-match/scan", { method: "POST", body: {} });
    } catch (e) {
      out = { ok: false, error: (e && e.message) || "The scan could not be run." };
    }
    btn.disabled = false; btn.textContent = "⟳ Scan Rethink for employees";
    await fill(mount, out);
  }

  function scanSummary(out) {
    if (!out) return "";
    if (!out.ok) {
      return `<div style="background:#fef2f2; border:1px solid #fecaca; color:#991b1b; border-radius:8px; padding:11px 14px; margin-bottom:14px; font-size:13px;">
        <strong>The scan did not run.</strong> ${esc(out.error || "No reason was given.")}</div>`;
    }
    const warn = (out.warnings || []).length
      ? `<ul style="margin:8px 0 0; padding-left:18px;">${out.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`
      : "";
    return `<div style="background:#eff6ff; border:1px solid #bfdbfe; color:#1e40af; border-radius:8px; padding:11px 14px; margin-bottom:14px; font-size:13px;">
      Read ${out.appointments_read} appointment(s) from ${esc(dayLabel(out.from))} to ${esc(dayLabel(out.to))} and found
      <strong>${out.providers_seen}</strong> provider(s): ${out.already_linked} already in the CRM,
      <strong>${out.needs_linking}</strong> not yet.${warn}</div>`;
  }

  async function fill(mount, scanOut) {
    const box = mount.querySelector("#rs-body");
    if (!box) return;
    let d;
    try { d = await api("/api/rethink/staff-match"); }
    catch (e) { box.innerHTML = `<div class="empty-state">Couldn't load this screen: ${esc(e.message)}</div>`; return; }

    const unmatched = d.unmatched || [];
    const employees = d.employees || [];
    const unlinkedStaff = employees.filter((e) => !e.linked);

    // Everybody on the roster is offered, with the already-linked shown but
    // unselectable -- hiding them would read as "not in the CRM" and invite a
    // second record for somebody who is already there.
    const options = employees.map((e) =>
      `<option value="${e.id}"${e.linked ? " disabled" : ""}>${esc(e.name)}${e.linked ? " — already linked" : ""}</option>`
    ).join("");

    const rows = unmatched.map((u) => {
      const named = !!u.name_hint;
      const who = named ? esc(u.name_hint) : `Rethink staff ${esc(u.rethink_staff_id)}`;
      const clients = Array.isArray(u.clients) ? u.clients : [];
      const noteAuthors = Array.isArray(u.note_authors) ? u.note_authors : [];
      const unnamedClients = Math.max(0, (u.distinct_clients || 0) - clients.length);
      // A likely match is marked where it sits rather than in a legend, so
      // nobody reads a guess as settled fact halfway down a list of names.
      const clientNames = clients
        .map((c) => esc(c.name) + (c.via === "likely" ? `<span style="opacity:.75;" title="Matched on name and date of birth, not yet linked">?</span>` : ""))
        .join(", ");
      const sg = u.suggestion || null;
      // A bare staff ID identifies nobody. Whose children they see is what
      // makes a person recognisable here. Note authors are shown as evidence
      // and labelled as such -- Rethink records whoever touched the note,
      // which is often a supervisor rather than the provider, so printing one
      // as this person's name would put the wrong name on the ID.
      const evidence = (clientNames.length || noteAuthors.length)
        ? `<div style="font-size:12px; color:var(--text-muted); margin-top:5px; line-height:1.6;">
            ${clients.length ? `<div><strong style="font-weight:600;">Works with:</strong> ${clientNames}${unnamedClients ? ` <span style="opacity:.8;">(+${unnamedClients} more)</span>` : ""}</div>` : ""}
            ${noteAuthors.length ? `<div><strong style="font-weight:600;">Session notes signed by:</strong> ${esc(noteAuthors.join(", "))} <span style="opacity:.8;">— a clue, not necessarily their name</span></div>` : ""}
          </div>`
        : `<div style="font-size:12px; color:var(--text-muted); margin-top:5px;">Rethink sent nothing else to go on — no name, no client the CRM recognises, no note author.</div>`;
      return `<div class="card" style="margin-bottom:10px; padding:12px 14px;">
        <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:flex-start;">
          <div style="min-width:200px;">
            <strong>${who}</strong>
            ${named ? "" : `<span class="tag" style="background:#fef3c7; color:#92400e; margin-left:6px;" title="Rethink sent no name on these appointments">no name in Rethink</span>`}
            <div style="font-size:12px; color:var(--text-muted); margin-top:3px;">
              Staff ID ${esc(u.rethink_staff_id)} · ${u.appointments} session${u.appointments === 1 ? "" : "s"}
              · ${u.hours} hrs · ${u.distinct_clients} client${u.distinct_clients === 1 ? "" : "s"}
              · ${esc(dayLabel(u.first_seen))} – ${esc(dayLabel(u.last_seen))}
            </div>
            ${named ? "" : evidence}
          </div>
        </div>
        ${!named && sg ? `<div style="margin-top:9px; padding:9px 11px; border-radius:8px; background:#ecfdf5; border:1px solid #a7f3d0; font-size:12.5px; color:#065f46;">
          <strong>Probably ${esc(sg.name)}</strong> — the CRM has them as the ${esc(sg.role)} on
          ${sg.on_care_team_of} of the ${sg.of_named_clients} client${sg.of_named_clients === 1 ? "" : "s"} this staff id works with.${
            sg.already_linked ? " They already have a Rethink id, so this would be a second Rethink record for the same person — which happens, and is why hours get split." : ""}${
            sg.in_crm ? "" : " They are not on the CRM roster under that name."}
          ${sg.employee_id ? `<button class="btn small secondary" data-rs-accept="${attr(u.rethink_staff_id)}" data-rs-emp-id="${attr(sg.employee_id)}" style="margin-left:6px;">Choose them below</button>` : ""}
        </div>` : ""}
        <div style="display:flex; gap:16px; flex-wrap:wrap; margin-top:10px; padding-top:10px; border-top:1px solid var(--border,#e5e7eb);">
          <div style="flex:1; min-width:250px;">
            <div style="font-size:12px; font-weight:700; margin-bottom:5px;">Already in the CRM?</div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <select data-rs-emp="${attr(u.rethink_staff_id)}" style="flex:1; min-width:150px; padding:6px 8px; border:1px solid var(--border,#e5e7eb); border-radius:8px; font-size:12.5px;">
                <option value="">Choose the staff member…</option>${options}
              </select>
              <button class="btn small secondary" data-rs-link="${attr(u.rethink_staff_id)}">Link</button>
            </div>
          </div>
          <div style="flex:1; min-width:250px;">
            <div style="font-size:12px; font-weight:700; margin-bottom:5px;">Or add them to the staff directory</div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <input data-rs-name="${attr(u.rethink_staff_id)}" placeholder="Full name" value="${attr(u.name_hint || "")}"
                style="flex:1; min-width:130px; padding:6px 8px; border:1px solid var(--border,#e5e7eb); border-radius:8px; font-size:12.5px;" />
              <input data-rs-title="${attr(u.rethink_staff_id)}" placeholder="Job title (e.g. RBT)"
                style="flex:1; min-width:120px; padding:6px 8px; border:1px solid var(--border,#e5e7eb); border-radius:8px; font-size:12.5px;" />
              <button class="btn small" data-rs-create="${attr(u.rethink_staff_id)}">Add</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join("");

    box.innerHTML = `${scanSummary(scanOut)}
      ${!d.configured ? `<div style="background:#fef3c7; color:#92400e; border-radius:8px; padding:11px 14px; margin-bottom:14px; font-size:13px;">
        Rethink credentials are not configured on the server, so a scan cannot run.</div>` : ""}
      <div class="section-title" style="margin-top:0;">In Rethink, not in the CRM${unmatched.length ? ` (${unmatched.length})` : ""}</div>
      ${unmatched.length ? rows : `<div class="empty-state">${
        d.last_scan_at
          ? "Every provider found in the last scan is already in the CRM."
          : "Press “Scan Rethink for employees” to see who is delivering sessions in Rethink."
      }</div>`}
      ${unlinkedStaff.length ? `<div class="card" style="margin-top:16px;">
        <div class="section-title" style="margin-top:0;">In the CRM, not linked to Rethink (${unlinkedStaff.length})</div>
        <p style="font-size:12.5px; color:var(--text-muted); margin:-4px 0 10px;">
          These staff have no Rethink ID, so their verified hours can never be matched and they read as 0% on the supervision tracker however much they work. Link one above when their provider appears in a scan.</p>
        <div style="font-size:12.5px;">${unlinkedStaff.map((e) => esc(e.name)).join(" · ")}</div>
      </div>` : ""}
      ${d.last_scan_at ? `<p style="font-size:12px; color:var(--text-muted); margin-top:14px;">Last scanned ${esc(new Date(d.last_scan_at).toLocaleString())}. The scan reads the last 90 days of appointments.</p>` : ""}`;

    wire(mount, box);
  }

  function wire(mount, box) {
    // The suggestion SELECTS the staff member and stops there. It does not
    // link them: the confirm on the Link button is where somebody reads back
    // whose compliance record is about to receive these hours, and a shortcut
    // past it would be a guess applied silently.
    box.querySelectorAll("[data-rs-accept]").forEach((b) => b.addEventListener("click", () => {
      const sel = box.querySelector(`[data-rs-emp="${CSS.escape(b.dataset.rsAccept)}"]`);
      if (!sel) return;
      sel.value = b.dataset.rsEmpId;
      sel.focus();
      if (!sel.value) alert("That staff member is already linked to another Rethink id, so they are not selectable here.");
    }));

    box.querySelectorAll("[data-rs-link]").forEach((b) => b.addEventListener("click", async () => {
      const sid = b.dataset.rsLink;
      const sel = box.querySelector(`[data-rs-emp="${CSS.escape(sid)}"]`);
      if (!sel || !sel.value) { alert("Choose which staff member this Rethink provider is."); return; }
      const who = sel.options[sel.selectedIndex].textContent.trim();
      // Read the choice back before writing it: attaching a provider to the
      // wrong person moves real verified hours onto the wrong compliance record.
      if (!confirm(`Link Rethink staff ID ${sid} to ${who}?\n\nTheir Rethink hours will count towards ${who} from now on, including months already synced.`)) return;
      b.disabled = true;
      try {
        await api("/api/rethink/staff-match/link", { method: "POST", body: { rethink_staff_id: sid, employee_id: Number(sel.value) } });
        await fill(mount);
      } catch (e) {
        b.disabled = false;
        if (/already linked/i.test((e && e.message) || "") && confirm(e.message + "\n\nReplace it?")) {
          try { await api("/api/rethink/staff-match/link", { method: "POST", body: { rethink_staff_id: sid, employee_id: Number(sel.value), replace: true } }); await fill(mount); return; }
          catch (e2) { alert(e2.message || "Couldn't link that."); return; }
        }
        alert((e && e.message) || "Couldn't link that.");
      }
    }));

    box.querySelectorAll("[data-rs-create]").forEach((b) => b.addEventListener("click", async () => {
      const sid = b.dataset.rsCreate;
      const nameEl = box.querySelector(`[data-rs-name="${CSS.escape(sid)}"]`);
      const titleEl = box.querySelector(`[data-rs-title="${CSS.escape(sid)}"]`);
      const name = nameEl ? nameEl.value.trim() : "";
      if (!name) {
        // Never invented. A record called "Staff 41207" looks like a person and
        // cannot be recognised as anybody.
        alert("Type their full name first — a staff record cannot be created from a staff ID alone.");
        if (nameEl) nameEl.focus();
        return;
      }
      if (!confirm(`Add ${name} to the staff directory and link them to Rethink staff ID ${sid}?`)) return;
      b.disabled = true;
      try {
        await api("/api/rethink/staff-match/create", {
          method: "POST",
          body: { rethink_staff_id: sid, name, role_title: titleEl ? titleEl.value.trim() : "" },
        });
        await fill(mount);
      } catch (e) {
        b.disabled = false;
        alert((e && e.message) || "Couldn't add that person.");
      }
    }));
  }

  window.__renderRethinkStaff = renderRethinkStaff;
})();
