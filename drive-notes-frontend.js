// drive-notes-frontend.js -- the one-time Drive notes import screen.
//
// Exposes window.__renderDriveNotesImport(mount) for #/drive-notes-import.
//
// THE SHAPE OF THIS SCREEN IS THE SAFETY. Nothing is written until somebody has
// seen, folder by folder, which child each one was matched to -- and the
// folders that matched NOBODY, or matched two children, are shown first rather
// than buried under the ones that worked. A screen that opens on a reassuring
// green summary and hides the twenty-six problems below the fold is how a
// child's notes end up on another child's record.
(function () {
  "use strict";

  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

  // The archive is posted as a raw body, which is the convention the rest of
  // this codebase uses for uploads -- there is no multipart parser in it.
  async function postArchive(path, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", path);
      xhr.setRequestHeader("Content-Type", "application/zip");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || "{}"); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("The upload did not reach the server."));
      xhr.send(file);
    });
  }

  function folderCard(f) {
    const readable = f.files.filter((x) => x.readable).length;
    const head = f.matched
      ? `<span class="tag" style="background:#dcfce7; color:#166534;">${esc(f.client_name)}</span>`
      : `<span class="tag" style="background:#fee2e2; color:#991b1b;">Not matched</span>`;
    return `<div class="card" style="margin-bottom:10px; ${f.matched ? "" : "border-left:3px solid #ef4444;"}">
      <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:flex-start;">
        <div style="min-width:0;">
          <strong style="font-size:15px;">${esc(f.initials)}</strong> ${head}
          <div style="font-size:12px; color:var(--text-muted); margin-top:3px;">
            ${f.files.length} file${f.files.length === 1 ? "" : "s"} · ${readable} with readable text
          </div>
        </div>
      </div>
      ${f.matched ? "" : `<div style="margin-top:8px; font-size:13px; color:#991b1b;">${esc(f.reason || "")}</div>`}
      <ul style="margin:10px 0 0; padding-left:18px; font-size:12.5px; color:var(--text-muted);">
        ${f.files.map((x) => `<li style="margin-bottom:2px;">
          ${esc(x.filename)} <span style="opacity:.7;">· ${esc(x.kind)} · ${esc(kb(x.bytes))}</span>
          ${x.readable ? `<span style="opacity:.7;"> · ${x.characters.toLocaleString()} characters</span>`
                       : `<span style="color:#9a3412;"> · ${esc(x.note || "no text")}</span>`}
        </li>`).join("")}
      </ul>
    </div>`;
  }

  function renderPreview(box, plan, onApply) {
    const t = plan.totals;
    const bad = plan.folders.filter((f) => !f.matched);
    const good = plan.folders.filter((f) => f.matched);

    box.innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-title" style="margin-top:0;">What this would import</div>
        <div class="stat-grid" style="margin-bottom:6px;">
          <div class="stat-card"><div class="label">Client folders</div><div class="value">${t.folders}</div></div>
          <div class="stat-card"><div class="label">Files</div><div class="value">${t.files}</div></div>
          <div class="stat-card"><div class="label">With readable text</div><div class="value">${t.readable}</div></div>
          <div class="stat-card ${t.unmatched_folders ? "danger" : ""}"><div class="label">Not matched to a client</div><div class="value">${t.unmatched_folders}</div></div>
        </div>
        <p style="font-size:12.5px; color:var(--text-muted); margin:8px 0 0;">
          Nothing has been written yet. Files in an unmatched folder are still imported, and wait on the review list
          below until somebody says which child they belong to &mdash; they are never guessed at.
        </p>
        <div style="margin-top:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn" id="dn-apply">Import these ${t.files} files</button>
          <button class="btn secondary" id="dn-cancel">Cancel</button>
          <span id="dn-apply-status" style="font-size:12.5px; color:var(--text-muted);"></span>
        </div>
      </div>
      ${bad.length ? `<h3 style="font-size:15px; margin:16px 0 8px;">Needs a decision (${bad.length})</h3>${bad.map(folderCard).join("")}` : ""}
      ${plan.skipped && plan.skipped.length ? `<div class="card" style="margin-bottom:10px;">
        <div class="section-title" style="margin-top:0;">Skipped, because they sit outside any client folder (${plan.skipped.length})</div>
        <ul style="margin:0; padding-left:18px; font-size:12.5px; color:var(--text-muted);">
          ${plan.skipped.slice(0, 25).map((s) => `<li>${esc(s.path)}</li>`).join("")}
        </ul></div>` : ""}
      ${good.length ? `<h3 style="font-size:15px; margin:16px 0 8px;">Matched (${good.length})</h3>${good.map(folderCard).join("")}` : ""}`;

    box.querySelector("#dn-cancel").addEventListener("click", () => { box.innerHTML = ""; });
    box.querySelector("#dn-apply").addEventListener("click", onApply);
  }

  async function renderReview(mount) {
    const box = mount.querySelector("#dn-review");
    if (!box) return;
    let d;
    try { d = await api("/api/drive-notes/review"); }
    catch (e) { box.innerHTML = `<div class="empty-state">Couldn't load the review list: ${esc(e.message)}</div>`; return; }
    const rows = d.rows || [];
    if (!rows.length) {
      box.innerHTML = `<div class="empty-state">Nothing is waiting. Every imported folder is filed under a client.</div>`;
      return;
    }
    const options = (d.clients || [])
      .map((c) => `<option value="${c.id}">${esc(c.child_name)}</option>`).join("");
    box.innerHTML = rows.map((r) => `<div class="card" style="margin-bottom:10px; border-left:3px solid #ef4444;">
      <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:flex-start;">
        <div>
          <strong style="font-size:15px;">${esc(r.source_folder)}</strong>
          <div style="font-size:12.5px; color:var(--text-muted); margin-top:3px;">
            ${r.files} file${Number(r.files) === 1 ? "" : "s"} · ${esc(r.unmatched_reason || "Not matched")}
          </div>
        </div>
        <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
          <select data-dn-client="${esc(r.source_folder)}" style="max-width:220px;">
            <option value="">Choose a client…</option>${options}
          </select>
          <button class="btn small" data-dn-assign="${esc(r.source_folder)}">File under this client</button>
        </div>
      </div>
      <div class="login-error" data-dn-err="${esc(r.source_folder)}" style="margin:8px 0 0;"></div>
    </div>`).join("");

    box.querySelectorAll("[data-dn-assign]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const folder = btn.getAttribute("data-dn-assign");
        const sel = box.querySelector(`[data-dn-client="${CSS.escape(folder)}"]`);
        const err = box.querySelector(`[data-dn-err="${CSS.escape(folder)}"]`);
        err.textContent = "";
        if (!sel.value) { err.textContent = "Choose a client first."; return; }
        btn.disabled = true;
        try {
          const r = await api(`/api/drive-notes/review/${encodeURIComponent(folder)}/assign`,
            { method: "POST", body: { client_id: Number(sel.value) } });
          await renderReview(mount);
          const done = mount.querySelector("#dn-review-status");
          if (done) done.textContent = `Filed ${r.moved} file${r.moved === 1 ? "" : "s"} under ${r.client}.`;
        } catch (e) {
          err.textContent = e.message;
          btn.disabled = false;
        }
      });
    });
  }

  window.__renderDriveNotesImport = async function (mount) {
    mount.innerHTML = `
      <div class="page-header">
        <div>
          <a href="#/admin" style="font-size:12.5px; text-decoration:none; color:var(--text-muted);">&larr; Admin Settings</a>
          <h1 style="margin-top:2px;">Import client notes from Google Drive</h1>
          <p>A one-time copy of each client's Drive folder into Programming.</p>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <div class="section-title" style="margin-top:0;">How to do this</div>
        <ol style="font-size:13.5px; line-height:1.7; margin:0; padding-left:20px;">
          <li>In Google Drive, open <strong>Spectrum Squad Shared Folder</strong>.</li>
          <li>Right-click the <strong>Clients</strong> folder and choose <strong>Download</strong>. Drive zips it up
              &mdash; Docs come out as .docx and Sheets as .xlsx, which is what this reads.</li>
          <li>Upload that .zip below. You will see exactly which child each folder was matched to
              <em>before</em> anything is saved.</li>
        </ol>
        <p style="font-size:12.5px; color:var(--text-muted); margin:12px 0 0;">
          This is a <strong>snapshot</strong>, not a connection. Drive stays where these documents are written and
          edited; what lands in the CRM is a copy stamped with today's date, shown under each client in Programming.
          Run it again whenever you want a fresher copy &mdash; files are matched on their name, so re-importing
          updates them in place rather than creating duplicates.
        </p>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <div class="section-title" style="margin-top:0;">Upload the archive</div>
        <input type="file" id="dn-file" accept=".zip,application/zip" style="font-size:13px;" />
        <div style="margin-top:10px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn" id="dn-preview">Check the archive</button>
          <span id="dn-status" style="font-size:12.5px; color:var(--text-muted);"></span>
        </div>
        <div class="login-error" id="dn-error" style="margin-top:8px;"></div>
      </div>

      <div id="dn-plan"></div>

      <h2 style="font-size:17px; margin:22px 0 4px;">Waiting on a decision</h2>
      <p style="font-size:12.5px; color:var(--text-muted); margin:0 0 10px;">
        Folders whose initials matched no client, or more than one. Their files were imported and are held here
        &mdash; they are not on anybody's record until you say whose they are.
        <span id="dn-review-status" style="color:#166534;"></span>
      </p>
      <div id="dn-review"><div class="empty-state">Loading…</div></div>`;

    const fileInput = mount.querySelector("#dn-file");
    const status = mount.querySelector("#dn-status");
    const error = mount.querySelector("#dn-error");
    const planBox = mount.querySelector("#dn-plan");

    mount.querySelector("#dn-preview").addEventListener("click", async () => {
      error.textContent = "";
      const file = fileInput.files && fileInput.files[0];
      if (!file) { error.textContent = "Choose the .zip you downloaded from Drive."; return; }
      status.textContent = `Uploading ${kb(file.size)}…`;
      planBox.innerHTML = "";
      try {
        const plan = await postArchive("/api/drive-notes/import/preview", file,
          (p) => { status.textContent = p < 100 ? `Uploading ${kb(file.size)}… ${p}%` : "Reading the archive…"; });
        status.textContent = "";
        renderPreview(planBox, plan, async () => {
          const applyStatus = planBox.querySelector("#dn-apply-status");
          const applyBtn = planBox.querySelector("#dn-apply");
          applyBtn.disabled = true;
          applyStatus.textContent = "Uploading again to import…";
          try {
            // THE ARCHIVE IS SENT A SECOND TIME on purpose. The server re-reads
            // and re-matches it rather than trusting a plan posted back from
            // here, so the matching rules are enforced instead of advisory --
            // otherwise anything could be posted to /apply naming any client.
            const r = await postArchive("/api/drive-notes/import/apply", file,
              (p) => { applyStatus.textContent = p < 100 ? `Uploading… ${p}%` : "Importing…"; });
            applyStatus.textContent =
              `Imported. ${r.inserted} new, ${r.updated} updated${r.unmatched ? `, ${r.unmatched} waiting on a decision` : ""}.`;
            applyBtn.textContent = "Imported";
            await renderReview(mount);
          } catch (e) {
            applyStatus.textContent = "";
            applyBtn.disabled = false;
            error.textContent = e.message;
          }
        });
      } catch (e) {
        status.textContent = "";
        error.textContent = e.message;
      }
    });

    await renderReview(mount);
  };
})();
