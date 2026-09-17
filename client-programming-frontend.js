// client-programming-frontend.js -- Client Programming, rendered inline in the
// client card, beside the BIP.
//
// A supervision note is a BCBA's record of sitting in on a session: the date
// and the RBT at the top, then the programs that were run and the modification
// made to each one, side by side. The two columns are one table rather than two
// lists, because a modification belongs to a program and a pair of unlinked
// columns would lose which belongs to which.
//
// Behaviours are shown read-only from the client's BIP. The BIP owns them; a
// supervision note is not the place to rewrite a behaviour plan.
//
// Exposes window.__renderProgrammingSection(container, clientId).

(function () {
  "use strict";

  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function nl2br(s) { return esc(s).replace(/\n/g, "<br>"); }
  function fmtDate(d) {
    if (!d) return "—";
    const t = Date.parse(String(d).slice(0, 10) + "T00:00:00Z");
    if (isNaN(t)) return String(d).slice(0, 10);
    return new Date(t).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", month: "long", day: "numeric", year: "numeric" });
  }
  const today = () => new Date().toISOString().slice(0, 10);

  // Line icons, matching the BIP module. No emoji anywhere.
  const ICON = {
    program: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7M9 11h5"/></svg>',
    tune: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>',
    person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    behavior: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a5 5 0 0 0-5 5c0 1.6.8 3 2 3.9V13a3 3 0 1 0 6 0v-2.1c1.2-.9 2-2.3 2-3.9a5 5 0 0 0-5-5z"/><path d="M9 21h6M12 16v5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  };
  const icon = (n, s) => `<span class="cp-ico" style="width:${s || 16}px;height:${s || 16}px;">${ICON[n] || ""}</span>`;

  let styled = false;
  function injectStyles() {
    if (styled) return; styled = true;
    const css = `
.cp-ico{display:inline-flex;align-items:center;justify-content:center;vertical-align:-2px}
.cp-ico svg{width:100%;height:100%;display:block}
.cp-wrap{font-size:13.5px;color:var(--text,#1f2330)}

/* --- a note ------------------------------------------------------------- */
.cp-note{border:1px solid var(--border,#e5e7eb);border-radius:12px;overflow:hidden;margin-bottom:14px;background:var(--card,#fff);
  box-shadow:0 1px 2px rgba(16,24,40,.04)}
.cp-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;padding:12px 16px;
  background:linear-gradient(180deg,#f7f8fc 0%,#f1f3fa 100%);border-bottom:1px solid var(--border,#e5e7eb)}
.cp-head .cp-date{display:flex;align-items:center;gap:7px;font-weight:700;font-size:14.5px;color:#1b2a6b;letter-spacing:.01em}
.cp-head .cp-rbt{display:flex;align-items:center;gap:7px;font-size:13px;color:#3c4257}
.cp-head .cp-rbt b{font-weight:650;color:#1f2330}
/* margin-left:auto rather than a spacer element: when the header wraps, the
   actions stay flush right on their own line instead of stranding themselves
   on the left under the date. */
.cp-head .cp-acts{margin-left:auto;display:flex;gap:6px;align-items:center}
.cp-tag{font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:700;color:#6b7280}

/* --- the two columns ---------------------------------------------------- */
.cp-cols{display:grid;grid-template-columns:1fr 1fr;gap:0}
.cp-col-h{padding:9px 16px;font-size:11px;font-weight:750;letter-spacing:.09em;text-transform:uppercase;
  color:#1b2a6b;background:#fbfbfe;border-bottom:1px solid var(--border,#e5e7eb);display:flex;align-items:center;gap:7px}
.cp-col-h + .cp-col-h{border-left:1px solid var(--border,#e5e7eb)}
.cp-cell{padding:11px 16px;border-bottom:1px solid #f0f1f6;line-height:1.5;min-height:44px}
.cp-cell.right{border-left:1px solid var(--border,#e5e7eb);background:#fdfdff}
.cp-cell.empty{color:#9ca3af;font-style:italic}
.cp-row:last-child .cp-cell{border-bottom:none}
.cp-none{padding:16px;color:#6b7280;font-style:italic}

/* --- general notes ------------------------------------------------------ */
.cp-gen{padding:11px 16px;border-top:1px solid var(--border,#e5e7eb);background:#fcfcfe;font-size:13px;color:#3c4257}
.cp-gen b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#6b7280;margin-bottom:3px;font-weight:750}

/* --- editor ------------------------------------------------------------- */
.cp-editor{border:1px solid #c7cbe4;border-radius:12px;padding:14px 16px;background:#fbfbff;margin-bottom:16px}
.cp-f{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:12px}
.cp-f label{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;margin-bottom:4px}
.cp-f input,.cp-f select,.cp-wrap textarea{border:1px solid var(--border,#d6d9e6);border-radius:8px;padding:7px 10px;font:inherit;font-size:13.5px;background:#fff;color:inherit}
.cp-erow{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:8px;align-items:start}
.cp-erow textarea{width:100%;min-height:52px;resize:vertical}
.cp-x{border:none;background:transparent;color:#b91c1c;cursor:pointer;padding:6px;border-radius:6px;line-height:0}
.cp-x:hover{background:#fee2e2}
.cp-eh{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:5px}
.cp-eh span{font-size:11px;font-weight:750;letter-spacing:.08em;text-transform:uppercase;color:#1b2a6b}

/* --- behaviours --------------------------------------------------------- */
.cp-beh{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.cp-behcard{border:1px solid var(--border,#e5e7eb);border-left:3px solid #7c8ad9;border-radius:9px;padding:10px 12px;background:var(--card,#fff)}
.cp-behcard h5{margin:0 0 4px;font-size:13.5px;font-weight:700}
.cp-behcard p{margin:0;font-size:12.5px;color:#5b6070;line-height:1.45}
.cp-src{font-size:12px;color:#6b7280;margin:2px 0 10px}

@media (max-width:640px){
  .cp-cols{grid-template-columns:1fr}
  .cp-col-h + .cp-col-h,.cp-cell.right{border-left:none}
  .cp-erow,.cp-eh{grid-template-columns:1fr}
}
@media (prefers-color-scheme:dark){
  .cp-head{background:linear-gradient(180deg,#232741 0%,#1e2138 100%)}
  .cp-head .cp-date{color:#aeb9f2}
  .cp-col-h{background:#1d2034;color:#aeb9f2}
  .cp-cell.right,.cp-gen{background:#1a1d30}
  .cp-editor{background:#1a1d30;border-color:#3a3f60}
  .cp-f input,.cp-f select,.cp-wrap textarea{background:#14172a;border-color:#3a3f60}
}`;
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
  }

  async function api(path, opts) {
    const r = await fetch(path, {
      method: (opts && opts.method) || "GET",
      headers: opts && opts.body ? { "Content-Type": "application/json" } : {},
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let d = null; try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error((d && d.error) || `Request failed (${r.status})`);
    return d;
  }

  function entryRows(entries) {
    const rows = entries && entries.length ? entries : [];
    if (!rows.length) {
      return `<div class="cp-none">No programs recorded on this note.</div>`;
    }
    return rows.map((e) => `
      <div class="cp-row" style="display:contents">
        <div class="cp-cell${e.program ? "" : " empty"}">${e.program ? nl2br(e.program) : "—"}</div>
        <div class="cp-cell right${e.modification ? "" : " empty"}">${e.modification ? nl2br(e.modification) : "No change"}</div>
      </div>`).join("");
  }

  function noteHtml(n, canEdit) {
    return `<div class="cp-note" data-note="${n.id}">
      <div class="cp-head">
        <span class="cp-date">${icon("calendar", 15)}${esc(fmtDate(n.session_date))}</span>
        <span class="cp-rbt">${icon("person", 15)}<span class="cp-tag">RBT</span> <b>${esc(n.rbt_name || "—")}</b></span>
        ${n.bcba_name ? `<span class="cp-rbt"><span class="cp-tag">Supervisor</span> <b>${esc(n.bcba_name)}</b></span>` : ""}
        ${canEdit ? `<span class="cp-acts">
          <button class="btn small secondary" data-edit="${n.id}">${icon("edit", 14)} Edit</button>
          <button class="btn small secondary" data-del="${n.id}" style="color:#b91c1c;">${icon("trash", 14)}</button>
        </span>` : ""}
      </div>
      <div class="cp-cols">
        <div class="cp-col-h">${icon("program", 14)} Programs</div>
        <div class="cp-col-h">${icon("tune", 14)} Modifications</div>
        ${entryRows(n.entries)}
      </div>
      ${n.general_notes ? `<div class="cp-gen"><b>Session notes</b>${nl2br(n.general_notes)}</div>` : ""}
    </div>`;
  }

  function editorHtml(rbts, note) {
    const entries = (note && note.entries && note.entries.length ? note.entries : [{ program: "", modification: "" }]);
    const opts = rbts.map((r) =>
      `<option value="${esc(r.name)}" data-email="${esc(r.email || "")}"${note && note.rbt_name === r.name ? " selected" : ""}>${esc(r.name)}${r.assigned ? " — assigned" : ""}${r.role_title ? ` (${esc(r.role_title)})` : ""}</option>`
    ).join("");
    return `<div class="cp-editor" data-editor="${note ? note.id : "new"}">
      <div class="cp-f">
        <div><label>Session date</label><input type="date" data-f="date" value="${esc((note && note.session_date) || today())}" /></div>
        <div style="min-width:240px;"><label>RBT supervised</label>
          <select data-f="rbt"><option value="">Choose…</option>${opts}</select></div>
        <div style="flex:1 1 auto;"></div>
      </div>
      <div class="cp-eh"><span>${icon("program", 13)} Programs</span><span>${icon("tune", 13)} Modifications</span><span></span></div>
      <div data-rows>
        ${entries.map((e) => rowHtml(e)).join("")}
      </div>
      <div style="margin:4px 0 12px;"><button class="btn small secondary" data-addrow>${icon("plus", 13)} Add a program</button></div>
      <div><label style="display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;margin-bottom:4px;">Session notes (optional)</label>
        <textarea data-f="general" style="width:100%;min-height:60px;" placeholder="Anything else worth recording about the session">${esc((note && note.general_notes) || "")}</textarea></div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center;">
        <button class="btn" data-save>${note ? "Save changes" : "Save supervision note"}</button>
        <button class="btn secondary" data-cancel>Cancel</button>
        <span data-status style="font-size:13px;"></span>
      </div>
    </div>`;
  }

  function rowHtml(e) {
    return `<div class="cp-erow">
      <textarea data-p placeholder="Program run">${esc((e && e.program) || "")}</textarea>
      <textarea data-m placeholder="Modification made (leave blank if none)">${esc((e && e.modification) || "")}</textarea>
      <button class="cp-x" data-rm title="Remove this row">${icon("close", 15)}</button>
    </div>`;
  }

  function behavioursHtml(d) {
    if (!d.behaviours || !d.behaviours.length) {
      return `<div class="cp-src">No behaviours recorded yet. They come from this client's Behavior Intervention Plan — add them in the BIP section above and they appear here.</div>`;
    }
    return `<div class="cp-src">From this client's Behavior Intervention Plan${d.bip_status ? ` (${esc(d.bip_status)})` : ""}. Edit them in the BIP section above.</div>
      <div class="cp-beh">${d.behaviours.map((b) => `
        <div class="cp-behcard">
          <h5>${esc(b.name || "Unnamed behaviour")}</h5>
          ${b.operational_definition ? `<p>${esc(String(b.operational_definition).slice(0, 220))}${String(b.operational_definition).length > 220 ? "…" : ""}</p>` : ""}
          ${b.hypothesized_function ? `<p style="margin-top:5px;"><span class="cp-tag">Function</span> ${esc(b.hypothesized_function)}</p>` : ""}
        </div>`).join("")}</div>`;
  }

  window.__renderProgrammingSection = async function (container, clientId) {
    if (!container) return;
    injectStyles();
    container.innerHTML = `<div class="cp-wrap"><div style="color:#6b7280;font-size:13px;">Loading…</div></div>`;

    let data;
    try {
      data = await api(`/api/client-programming/${clientId}`);
    } catch (e) {
      container.innerHTML = `<div class="cp-wrap"><div style="color:#b91c1c;font-size:13px;">Could not load programming: ${esc(e.message)}</div></div>`;
      return;
    }

    let editing = null; // null = closed, "new", or a note id

    function paint() {
      const note = editing && editing !== "new" ? data.notes.find((n) => String(n.id) === String(editing)) : null;
      container.innerHTML = `<div class="cp-wrap">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <div style="font-size:11px;font-weight:750;letter-spacing:.09em;text-transform:uppercase;color:#1b2a6b;">${icon("behavior", 14)} Behaviors</div>
        </div>
        ${behavioursHtml(data)}
        <div style="display:flex;align-items:center;gap:10px;margin:20px 0 10px;">
          <div style="font-size:11px;font-weight:750;letter-spacing:.09em;text-transform:uppercase;color:#1b2a6b;">${icon("program", 14)} Supervision notes</div>
          <div style="flex:1 1 auto;"></div>
          ${editing ? "" : `<button class="btn small" data-new>${icon("plus", 13)} New supervision note</button>`}
        </div>
        ${editing ? editorHtml(data.rbt_options || [], note) : ""}
        ${data.notes.length ? data.notes.map((n) => noteHtml(n, !editing)).join("")
          : (editing ? "" : `<div class="cp-none" style="border:1px dashed var(--border,#e5e7eb);border-radius:10px;">No supervision notes for this client yet.</div>`)}
      </div>`;
      wire();
    }

    function collect(ed) {
      const rows = [...ed.querySelectorAll("[data-rows] .cp-erow")].map((r) => ({
        program: r.querySelector("[data-p]").value,
        modification: r.querySelector("[data-m]").value,
      }));
      const sel = ed.querySelector('[data-f="rbt"]');
      const opt = sel.selectedOptions[0];
      return {
        session_date: ed.querySelector('[data-f="date"]').value,
        rbt_name: sel.value,
        rbt_email: opt ? opt.getAttribute("data-email") || "" : "",
        general_notes: ed.querySelector('[data-f="general"]').value,
        entries: rows,
      };
    }

    function wire() {
      const nb = container.querySelector("[data-new]");
      if (nb) nb.addEventListener("click", () => { editing = "new"; paint(); });

      container.querySelectorAll("[data-edit]").forEach((b) =>
        b.addEventListener("click", () => { editing = b.dataset.edit; paint(); }));

      container.querySelectorAll("[data-del]").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm("Delete this supervision note? This cannot be undone.")) return;
          b.disabled = true;
          try {
            const out = await api(`/api/client-programming/notes/${b.dataset.del}`, { method: "DELETE" });
            data.notes = out.notes; paint();
          } catch (e) { alert(e.message); b.disabled = false; }
        }));

      const ed = container.querySelector("[data-editor]");
      if (!ed) return;
      const status = ed.querySelector("[data-status]");
      const say = (m, ok) => { status.textContent = m; status.style.color = ok ? "#16a34a" : "#b91c1c"; };

      ed.querySelector("[data-addrow]").addEventListener("click", () => {
        ed.querySelector("[data-rows]").insertAdjacentHTML("beforeend", rowHtml());
        bindRemove();
      });
      function bindRemove() {
        ed.querySelectorAll("[data-rm]").forEach((x) => {
          x.onclick = () => {
            const rows = ed.querySelectorAll("[data-rows] .cp-erow");
            // Always leave one row: an editor with nothing in it is a dead end.
            if (rows.length <= 1) { x.closest(".cp-erow").querySelectorAll("textarea").forEach((t) => (t.value = "")); return; }
            x.closest(".cp-erow").remove();
          };
        });
      }
      bindRemove();

      ed.querySelector("[data-cancel]").addEventListener("click", () => { editing = null; paint(); });

      ed.querySelector("[data-save]").addEventListener("click", async () => {
        const body = collect(ed);
        if (!body.session_date) return say("Please choose the session date.", false);
        if (!body.rbt_name) return say("Please choose which RBT was supervised.", false);
        const btn = ed.querySelector("[data-save]");
        btn.disabled = true; say("Saving…", true);
        try {
          const out = editing === "new"
            ? await api(`/api/client-programming/${clientId}/notes`, { method: "POST", body })
            : await api(`/api/client-programming/notes/${editing}`, { method: "PATCH", body });
          data.notes = out.notes;
          editing = null;
          paint();
        } catch (e) { btn.disabled = false; say(e.message, false); }
      });
    }

    paint();
  };
})();
