// client-behavior-frontend.js -- the Client Behavior navigation section.
//
// THE RULE THIS FILE EXISTS TO KEEP: the Behavior Intervention Plan shown here
// and the one inside a client's card are not two views of the same data that
// happen to agree. They are the SAME RENDERER against the SAME ENDPOINT.
// The plan half of this page is drawn by window.__renderBipSection(el, id),
// which is exactly what the client card calls -- so an edit made here is an
// edit made there, and there is no second copy that could drift.
//
// A shared table would have been enough to satisfy the letter of that; sharing
// the renderer means nobody can accidentally build the second implementation
// later and not notice.
//
// What IS new here is Behavior Modification Notes: dated, structured,
// parent-facing records of what a behavior looks like and what staff should do
// about it, written to be printed and handed to a family. They are deliberately
// not the existing bip_notes, which are a threaded internal clinical
// discussion with categories and an open/resolved state. Different audience,
// different shape, different lifecycle.
//
// Exposes window.__renderClientBehavior(mount) for the native router.
(function () {
  "use strict";

  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function dayLabel(s) {
    if (!s) return "—";
    const p = String(s).slice(0, 10).split("-");
    if (p.length !== 3) return String(s);
    const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return (names[+p[1]] || p[1]) + " " + (+p[2]) + ", " + p[0];
  }
  const todayStr = () => new Date().toISOString().slice(0, 10);

  // The plan statuses bip.js already defines. "No plan" is not one of them --
  // it is the absence of a row, shown so a client without a BIP is visible on
  // the roster rather than quietly missing from it.
  const STATUS = {
    draft:             { bg: "#f1f5f9", fg: "#475569", label: "Draft" },
    active:            { bg: "#dcfce7", fg: "#166534", label: "Active" },
    pending_review:    { bg: "#fef3c7", fg: "#92400e", label: "Pending Review" },
    changes_requested: { bg: "#fee2e2", fg: "#991b1b", label: "Changes Requested" },
    archived:          { bg: "#e5e7eb", fg: "#4b5563", label: "Archived" },
    none:              { bg: "#fff7ed", fg: "#9a3412", label: "No plan yet" },
  };
  function statusTag(s) {
    const k = STATUS[s || "none"] ? (s || "none") : "none";
    const b = STATUS[k];
    return `<span class="tag" style="background:${b.bg}; color:${b.fg};">${esc(b.label)}</span>`;
  }

  function clientIdFromHash() {
    const m = String(location.hash || "").match(/^#\/client-behavior\/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  // ================= roster =================================================
  async function renderRoster(mount) {
    mount.innerHTML = `<div class="page-header">
      <div><h1>Client Behavior</h1>
        <p>Behavior Intervention Plans and behavior modification notes for clients in therapy and clients with a first day scheduled. The plan shown here is the same plan on the client's card — editing either updates both.</p></div>
      </div>
      <div id="cb-body"><div class="empty-state">Loading…</div></div>`;

    const box = mount.querySelector("#cb-body");
    let d;
    try { d = await api("/api/bip/roster"); }
    catch (e) { box.innerHTML = `<div class="empty-state">Couldn't load: ${esc(e.message)}</div>`; return; }

    // A pre-start client is marked rather than silently mixed in: the plan a
    // BCBA is drafting for a child who has not had a session yet is a different
    // thing to read than one already being run, and the roster should say so.
    const startingSoon = `<span class="tag" style="background:#fef3c7; color:#92400e;">Starting soon</span>`;
    const rows = (d.clients || []).map((c) => `<tr>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">
        <strong>${esc(c.child_name || "—")}</strong>${c.stage === "first_day_scheduled" ? " " + startingSoon : ""}
        ${c.behavior_note_count ? `<div style="font-size:11px; color:var(--text-muted);">${c.behavior_note_count} behavior note${c.behavior_note_count === 1 ? "" : "s"}</div>` : ""}
      </td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee); font-size:13px;">
        ${c.assigned_bcba ? esc(c.assigned_bcba) : `<span style="color:var(--text-muted);">Not assigned</span>`}
      </td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee);">${statusTag(c.bip_status)}</td>
      <td style="padding:9px 10px; border-top:1px solid var(--border,#eee); text-align:right;">
        <a class="btn small secondary" href="#/client-behavior/${c.id}">View Behavior</a>
      </td>
    </tr>`).join("");

    box.innerHTML = `<div class="card"><div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:13.5px; min-width:640px;">
        <thead><tr style="text-align:left; color:var(--text-muted); font-size:11px; text-transform:uppercase;">
          <th style="padding:8px 10px;">Client</th>
          <th style="padding:8px 10px;">Assigned BCBA</th>
          <th style="padding:8px 10px;">BIP status</th>
          <th style="padding:8px 10px;"></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="4"><div class="empty-state">No clients to show.</div></td></tr>`}</tbody>
      </table>
    </div></div>`;
  }

  // ================= one client ============================================
  async function renderClient(mount, clientId) {
    mount.innerHTML = `<div class="page-header">
      <div>
        <a href="#/client-behavior" style="font-size:12.5px; text-decoration:none; color:var(--text-muted);">← All clients</a>
        <h1 id="cb-name" style="margin-top:2px;">Client Behavior</h1>
      </div></div>
      <div id="cb-plan"><div class="empty-state">Loading the plan…</div></div>
      <div id="cb-notes" style="margin-top:18px;"><div class="empty-state">Loading notes…</div></div>
      <div id="cb-drive" style="margin-top:18px;"></div>`;

    // The plan half. Same function the client card calls, so this is the same
    // plan and the same editor -- not a copy of either.
    const planBox = mount.querySelector("#cb-plan");
    if (window.__renderBipSection) {
      try { await window.__renderBipSection(planBox, clientId); }
      catch (e) { planBox.innerHTML = `<div class="empty-state">Couldn't load the plan: ${esc(e.message)}</div>`; }
    } else {
      planBox.innerHTML = `<div class="empty-state">The plan editor did not load. Refresh the page.</div>`;
    }

    await fillNotes(mount, clientId);
    await fillDriveNotes(mount, clientId);
  }

  // ================= notes imported from Google Drive =======================
  //
  // A SNAPSHOT, and the panel says so in the heading rather than in a tooltip.
  // The practice keeps working in Drive; this copy was taken on a particular
  // day and does not update itself. Reading a superseded protocol and running
  // it is the failure that matters here, so the date is not decoration.
  //
  // There is no link straight to the document: a Drive folder download carries
  // filenames, not file ids, so a deep link would have to be invented. Each row
  // opens a Drive SEARCH for its filename instead -- which is true, and lands
  // in the right place.
  const DRIVE_KINDS = {
    note:           { label: "Note",           bg: "#eef2ff", fg: "#3730a3" },
    supervision:    { label: "Supervision",    bg: "#ecfdf5", fg: "#065f46" },
    programming:    { label: "Program training", bg: "#fff7ed", fg: "#9a3412" },
    bip:            { label: "BIP",            bg: "#f1f5f9", fg: "#334155" },
    treatment_plan: { label: "Treatment plan", bg: "#fdf2f8", fg: "#9d174d" },
    other:          { label: "File",           bg: "#f1f5f9", fg: "#475569" },
  };

  async function fillDriveNotes(mount, clientId) {
    const box = mount.querySelector("#cb-drive");
    if (!box) return;
    let d;
    try { d = await api(`/api/drive-notes/client/${clientId}`); }
    catch (e) {
      // Not fatal to the page: the plan and the behavior notes above are the
      // clinical record, and this panel is an import of copies.
      box.innerHTML = `<div class="empty-state">Couldn't load the imported Drive notes: ${esc(e.message)}</div>`;
      return;
    }
    const rows = d.rows || [];
    if (!rows.length) {
      box.innerHTML = `
        <h2 style="margin:0 0 8px; font-size:17px;">Notes from Google Drive</h2>
        <div class="empty-state">Nothing has been imported for this client. An owner or admin can import the practice's Drive folder from Admin Settings.</div>`;
      return;
    }

    const searchUrl = (name) =>
      "https://drive.google.com/drive/search?q=" + encodeURIComponent(String(name).replace(/\.[a-z0-9]+$/i, ""));

    const card = (r, i) => {
      const k = DRIVE_KINDS[r.kind] || DRIVE_KINDS.other;
      const hasText = !!String(r.body || "").trim();
      return `<div class="card" style="margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
          <div style="min-width:0;">
            <span class="tag" style="background:${k.bg}; color:${k.fg};">${esc(k.label)}</span>
            <strong style="font-size:14.5px; margin-left:6px; word-break:break-word;">${esc(r.filename)}</strong>
            <div style="font-size:11.5px; color:var(--text-muted); margin-top:3px;">
              From the ${esc(r.source_folder)} folder${r.file_ext ? " · ." + esc(r.file_ext) : ""}${r.bytes ? " · " + Math.max(1, Math.round(r.bytes / 1024)) + " KB" : ""}
            </div>
          </div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            ${hasText ? `<button class="btn small secondary" data-drive-toggle="${i}">Show</button>` : ""}
            <a class="btn small secondary" href="${searchUrl(r.filename)}" target="_blank" rel="noopener">Find in Drive</a>
          </div>
        </div>
        ${r.note ? `<div style="margin-top:8px; font-size:12.5px; color:var(--text-muted);">${esc(r.note)}</div>` : ""}
        ${hasText ? `<pre id="drive-body-${i}" hidden style="margin-top:10px; white-space:pre-wrap; word-break:break-word; font-family:inherit; font-size:13px; background:var(--brand-light,#f7f7fb); padding:12px; border-radius:8px; max-height:420px; overflow:auto;">${esc(r.body)}</pre>` : ""}
        ${r.truncated ? `<div style="margin-top:6px; font-size:11.5px; color:var(--text-muted);">Only the first part of this document was imported. Open it in Drive for the rest.</div>` : ""}
      </div>`;
    };

    box.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:4px;">
        <h2 style="margin:0; font-size:17px;">Notes from Google Drive</h2>
        <span class="tag" style="background:#fff7ed; color:#9a3412;">Snapshot</span>
      </div>
      <p style="margin:0 0 10px; font-size:12.5px; color:var(--text-muted);">
        ${rows.length} file${rows.length === 1 ? "" : "s"} copied from this client's Drive folder on ${esc(dayLabel(d.imported_at))}.
        Drive is still where these are edited &mdash; anything changed there since is not shown here.
      </p>
      <div>${rows.map(card).join("")}</div>`;

    box.querySelectorAll("[data-drive-toggle]").forEach((b) => {
      b.addEventListener("click", () => {
        const pre = box.querySelector("#drive-body-" + b.getAttribute("data-drive-toggle"));
        if (!pre) return;
        pre.hidden = !pre.hidden;
        b.textContent = pre.hidden ? "Show" : "Hide";
      });
    });
  }

  async function fillNotes(mount, clientId) {
    const box = mount.querySelector("#cb-notes");
    let d;
    try { d = await api(`/api/bip/client/${clientId}/behavior-notes`); }
    catch (e) { box.innerHTML = `<div class="empty-state">Couldn't load notes: ${esc(e.message)}</div>`; return; }

    const nameEl = mount.querySelector("#cb-name");
    if (nameEl && d.client) nameEl.textContent = d.client.child_name || "Client Behavior";

    const canEdit = !!d.can_edit;
    const notes = d.notes || [];

    const noteCard = (n) => `<div class="card" data-cb-note="${n.id}" style="margin-bottom:10px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
        <div>
          <div style="font-size:12px; color:var(--text-muted);">${esc(dayLabel(n.note_date))}</div>
          <strong style="font-size:15px;">${esc(n.behavior || "—")}</strong>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${canEdit ? `<button class="btn small secondary" data-cb-edit="${n.id}">✎ Edit</button>` : ""}
          <a class="btn small secondary" href="/api/bip/behavior-notes/${n.id}/pdf" target="_blank" rel="noopener">⇩ Download PDF</a>
        </div>
      </div>
      ${n.strategy ? `<div style="margin-top:9px;">
        <div style="font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); font-weight:700;">Behavior modification / strategy</div>
        <div style="white-space:pre-wrap; font-size:13.5px;">${esc(n.strategy)}</div></div>` : ""}
      ${n.instructions ? `<div style="margin-top:9px;">
        <div style="font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); font-weight:700;">Notes / instructions</div>
        <div style="white-space:pre-wrap; font-size:13.5px;">${esc(n.instructions)}</div></div>` : ""}
      <div style="margin-top:10px; padding-top:8px; border-top:1px solid var(--border,#eee); font-size:11.5px; color:var(--text-muted);">
        Written by ${esc(n.author || "—")}${n.updated_at && n.updated_by ? ` · edited by ${esc(n.updated_by)}` : ""}
      </div>
    </div>`;

    box.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
        <h2 style="margin:0; font-size:17px;">Behavior Modification Notes</h2>
        ${canEdit ? `<button class="btn" id="cb-add">+ Add Note</button>` : ""}
      </div>
      <div id="cb-form"></div>
      <div id="cb-list">${notes.length ? notes.map(noteCard).join("") : `<div class="empty-state">No behavior notes yet.</div>`}</div>`;

    const add = box.querySelector("#cb-add");
    if (add) add.addEventListener("click", () => showForm(mount, clientId, null, d));
    box.querySelectorAll("[data-cb-edit]").forEach((b) => {
      b.addEventListener("click", () => {
        const n = notes.find((x) => String(x.id) === b.getAttribute("data-cb-edit"));
        if (n) showForm(mount, clientId, n, d);
      });
    });
  }

  function showForm(mount, clientId, note, d) {
    const box = mount.querySelector("#cb-form");
    // The behaviours already named in the plan, offered as suggestions. A note
    // may still name something not yet in the BIP -- new behaviour shows up
    // before anybody has written it into the plan, and refusing to record it
    // until the paperwork catches up is how it goes unrecorded.
    const suggestions = (d.behaviors || []).map((b) => `<option value="${esc(b.name)}"></option>`).join("");
    const v = note || {};
    box.innerHTML = `<div class="card" style="margin-bottom:12px; border-left:4px solid var(--accent,#1b2a6b);">
      <h3 style="margin:0 0 10px; font-size:15px;">${note ? "Edit note" : "New behavior note"}</h3>
      <div class="opt-grid" style="display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px;">
        <label style="display:block;"><span style="font-size:11.5px; color:var(--text-muted);">Date</span>
          <input type="date" id="cb-date" value="${esc(v.note_date || todayStr())}" style="width:100%;"></label>
        <label style="display:block;"><span style="font-size:11.5px; color:var(--text-muted);">Behavior</span>
          <input type="text" id="cb-behavior" list="cb-behaviors" value="${esc(v.behavior || "")}" placeholder="e.g. Elopement" style="width:100%;">
          <datalist id="cb-behaviors">${suggestions}</datalist></label>
      </div>
      <label style="display:block; margin-top:10px;"><span style="font-size:11.5px; color:var(--text-muted);">Behavior modification / strategy</span>
        <textarea id="cb-strategy" rows="3" style="width:100%;">${esc(v.strategy || "")}</textarea></label>
      <label style="display:block; margin-top:10px;"><span style="font-size:11.5px; color:var(--text-muted);">Notes / instructions</span>
        <textarea id="cb-instructions" rows="4" style="width:100%;">${esc(v.instructions || "")}</textarea></label>
      <div id="cb-err" style="color:#b91c1c; font-size:12.5px; margin-top:8px;"></div>
      <div style="margin-top:12px; display:flex; gap:8px;">
        <button class="btn" id="cb-save">${note ? "Save changes" : "Save note"}</button>
        <button class="btn secondary" id="cb-cancel">Cancel</button>
      </div>
    </div>`;

    box.querySelector("#cb-cancel").addEventListener("click", () => { box.innerHTML = ""; });
    box.querySelector("#cb-save").addEventListener("click", async () => {
      const body = {
        note_date: box.querySelector("#cb-date").value,
        behavior: box.querySelector("#cb-behavior").value,
        strategy: box.querySelector("#cb-strategy").value,
        instructions: box.querySelector("#cb-instructions").value,
      };
      const err = box.querySelector("#cb-err");
      err.textContent = "";
      const btn = box.querySelector("#cb-save");
      btn.disabled = true;
      try {
        if (note) await api(`/api/bip/behavior-notes/${note.id}`, { method: "PATCH", body });
        else await api(`/api/bip/client/${clientId}/behavior-notes`, { method: "POST", body });
        box.innerHTML = "";
        await fillNotes(mount, clientId);
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    });
  }

  window.__renderClientBehavior = async function (mount) {
    const id = clientIdFromHash();
    if (id) return renderClient(mount, id);
    return renderRoster(mount);
  };
})();
