// dob-check-frontend.js -- which birthdays on file might be the wrong way round.
//
// <input type="date"> renders in the BROWSER's locale, so on a day-first
// browser this CRM asked for DD/MM/YYYY while everybody here reads dates
// month-first. That is fixed at the point of entry now, but every birthday
// typed before it may have its month and day swapped -- and a transposed
// birthday is invisible: it saves cleanly, looks plausible on every screen, and
// is caught only by somebody who knows the child's real birthday.
//
// THIS SCREEN CHANGES NOTHING AND GUESSES NOTHING. It cannot know which reading
// is right; it can only say which records are CAPABLE of being wrong. The
// valuable half of that answer is the other one: everything not listed here is
// provably correct, because a day above 12 cannot be a month.
//
// Exposes window.__renderDobCheck(mount) for the native router.
(function () {
  "use strict";
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }

  async function renderDobCheck(mount) {
    mount.innerHTML = `<div class="page-header">
      <div><h1>Date of birth check</h1>
      <p>Birthdays that could have been entered the wrong way round, from when the form asked day-first. Nothing on this screen changes any record.</p></div>
    </div><div id="dob-body"><div class="empty-state">Checking…</div></div>`;

    let d;
    try { d = await api("/api/clients/dob-check"); }
    catch (e) {
      mount.querySelector("#dob-body").innerHTML = `<div class="empty-state">Couldn't run the check: ${esc(e.message)}</div>`;
      return;
    }

    const amb = d.ambiguous || [];
    const rows = amb.map((c) => `<tr style="border-top:1px solid var(--border,#e5e7eb);">
        <td style="padding:9px 10px;"><a href="#/pipeline/${c.id}" style="font-weight:600;">${esc(c.child_name)}</a></td>
        <td style="padding:9px 10px;">${esc(c.stored_reading)}</td>
        <td style="padding:9px 10px; color:#b45309;">${esc(c.swapped_reading)}</td>
        <td style="padding:9px 10px; color:var(--text-muted); font-size:12px;">${esc(c.stage || "—")}</td>
      </tr>`).join("");

    mount.querySelector("#dob-body").innerHTML = `
      <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px;">
        <div style="flex:1; min-width:150px; background:var(--bg,#f7f8fb); border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:14px 16px;">
          <div style="font-size:26px; font-weight:800; color:${amb.length ? "#b45309" : "var(--brand-navy,#1b2a6b)"};">${amb.length}</div>
          <div style="font-size:12px; color:var(--text-muted);">Worth checking</div>
        </div>
        <div style="flex:1; min-width:150px; background:var(--bg,#f7f8fb); border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:14px 16px;">
          <div style="font-size:26px; font-weight:800; color:#166534;">${d.unambiguous}</div>
          <div style="font-size:12px; color:var(--text-muted);">Provably correct</div>
        </div>
        <div style="flex:1; min-width:150px; background:var(--bg,#f7f8fb); border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:14px 16px;">
          <div style="font-size:26px; font-weight:800; color:var(--text-muted);">${d.no_dob}</div>
          <div style="font-size:12px; color:var(--text-muted);">No birthday on file</div>
        </div>
      </div>

      <div style="background:#eff6ff; border:1px solid #bfdbfe; color:#1e40af; border-radius:8px; padding:11px 14px; margin-bottom:14px; font-size:13px;">
        A birthday is only listed when swapping the month and day gives a <strong>different, real date</strong> — a day above 12 cannot be a month, so those are certain either way. Being listed does <strong>not</strong> mean a record is wrong; it means the CRM cannot tell. Check these against what the family gave you.
      </div>

      ${amb.length ? `<div class="card">
        <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:13px; min-width:560px;">
          <thead><tr style="text-align:left; color:var(--text-muted); font-size:11px; text-transform:uppercase;">
            <th style="padding:8px 10px;">Client</th>
            <th style="padding:8px 10px;">On file as</th>
            <th style="padding:8px 10px;">Or possibly</th>
            <th style="padding:8px 10px;">Stage</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>` : `<div class="empty-state">No birthday on file could have been entered the wrong way round. Every one of the ${d.with_dob} on record has a day above 12, or the same month and day, so none of them is ambiguous.</div>`}`;
  }

  window.__renderDobCheck = renderDobCheck;
})();
