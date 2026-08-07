// email-templates.js -- Spectrum Squad CRM: Email Templates editor
// Progressive-enhancement module, loaded via a single <script> tag added to
// index.html. Does not modify index.html's own inline app -- it injects its
// own nav item and renders its own page into #view-mount when the URL hash
// is #/email-templates, using a MutationObserver to survive the native
// app's own re-renders (same pattern as financial-center.js).
"use strict";

// ---- permission check (bare `state`, not `window.state` -- classic
// <script> tags share one global lexical environment, but `const state`
// declared in index.html's inline script is never attached to `window`). ----
// Highest-privilege roles. Must mirror the server's EMAIL_TEMPLATE_EDIT_ROLES.
// "owner" is essential: the seeded owner account is migrated from "admin" to
// "owner" server-side, so leaving it out would hide this whole area from the
// actual owner.
const ET_EDIT_ROLES = ["owner", "admin", "super_admin"];

function etCanEdit() {
  try {
    return !!(state && state.user && ET_EDIT_ROLES.includes(state.user.role));
  } catch (e) {
    return false;
  }
}

// ---- self-contained fetch helper (doesn't depend on index.html's internal
// api() implementation, which we can't reliably introspect). Cookies are
// sent automatically since this is a same-origin request. ----
async function etApi(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function etEscapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// ---- nav item injection ----
const ET_NAV_ITEMS = [
  { key: "email-templates", label: "Email Templates", hash: "#/email-templates" },
  { key: "failed-emails", label: "Failed Emails", hash: "#/failed-emails" },
];

function etSyncNavButton() {
  const nav = document.querySelector(".sidebar nav");
  if (!nav) return;
  for (const item of ET_NAV_ITEMS) {
    if (!etCanEdit()) {
      const existing = nav.querySelector(`[data-nav="${item.key}"]`);
      if (existing) existing.remove();
      continue;
    }
    if (nav.querySelector(`[data-nav="${item.key}"]`)) continue;
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.dataset.nav = item.key;
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      location.hash = item.hash;
    });
    nav.appendChild(btn);
  }
}

// ---- styles (own <style> block, doesn't touch index.html's existing one) ----
function etInjectStyles() {
  if (document.getElementById("et-styles")) return;
  const style = document.createElement("style");
  style.id = "et-styles";
  style.textContent = `
    .et-wrap { padding: 24px; max-width: 980px; }
    .et-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .et-header h1 { font-size: 22px; margin: 0; }
    .et-back { background: none; border: 1px solid #d1d5db; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; margin-bottom: 16px; }
    .et-category { margin-bottom: 28px; }
    .et-category h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; margin-bottom: 10px; }
    .et-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; background: #fff; }
    .et-card-info strong { display: block; font-size: 14px; margin-bottom: 2px; }
    .et-card-info span { font-size: 12.5px; color: #6b7280; }
    .et-edit-btn { background: #1b2a6b; color: #fff; border: none; border-radius: 6px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
    .et-edit-btn:hover { background: #3a3178; }
    .et-field-label { font-size: 12.5px; font-weight: 600; color: #374151; margin: 14px 0 6px; display: block; }
    .et-subject-input { width: 100%; padding: 9px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
    .et-toolbar { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
    .et-toolbar button { border: 1px solid #d1d5db; background: #f9fafb; border-radius: 6px; padding: 6px 10px; font-size: 12.5px; cursor: pointer; }
    .et-toolbar button:hover { background: #f0f0f3; }
    .et-body-editor { min-height: 220px; border: 1px solid #d1d5db; border-radius: 6px; padding: 12px; font-size: 14px; line-height: 1.5; background: #fff; overflow-y: auto; }
    .et-body-editor img { max-width: 100%; }
    .et-fields-box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; background: #fafafa; margin-top: 16px; }
    .et-fields-box h3 { font-size: 12.5px; text-transform: uppercase; color: #6b7280; margin: 0 0 8px; }
    .et-field-chip { display: inline-block; background: #eef0fb; color: #1b2a6b; border-radius: 5px; padding: 3px 8px; font-size: 12px; margin: 0 6px 6px 0; cursor: pointer; border: none; }
    .et-field-chip:hover { background: #dde0f7; }
    .et-actions { display: flex; gap: 10px; margin-top: 18px; align-items: center; }
    .et-save-btn { background: #22c55e; color: #fff; border: none; border-radius: 6px; padding: 9px 16px; font-size: 13.5px; cursor: pointer; font-weight: 600; }
    .et-preview-btn, .et-test-btn { background: #fff; color: #1b2a6b; border: 1px solid #1b2a6b; border-radius: 6px; padding: 9px 16px; font-size: 13.5px; cursor: pointer; }
    .et-status-msg { font-size: 13px; margin-left: 4px; }
    .et-status-msg.ok { color: #16a34a; }
    .et-status-msg.err { color: #dc2626; }
    .et-preview-panel { margin-top: 18px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
    .et-preview-subject { padding: 10px 14px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; font-size: 13.5px; }
    .et-preview-frame { width: 100%; height: 360px; border: none; }
    input[type="file"].et-hidden-file { display: none; }
    .et-fe-hint { font-size: 13px; color: #6b7280; margin: 0 0 14px; max-width: 680px; line-height: 1.5; }
    .et-fe-empty { padding: 40px; text-align: center; color: #16a34a; font-size: 15px; border: 1px dashed #d1d5db; border-radius: 8px; }
    .et-fe-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .et-fe-table th { text-align: left; padding: 8px 10px; border-bottom: 2px solid #e5e7eb; color: #6b7280; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
    .et-fe-table td { padding: 9px 10px; border-bottom: 1px solid #f0f0f3; vertical-align: top; }
    .et-fe-when { white-space: nowrap; color: #6b7280; }
    .et-fe-err { color: #b91c1c; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .et-fe-table .et-fe-resend { padding: 5px 12px; font-size: 12.5px; }
    .et-fe-resend[disabled] { opacity: 0.6; cursor: default; }
  `;
  document.head.appendChild(style);
}

// ---- data ----
const ET_MERGE_FIELD_LABELS = {
  parent_name: "Parent Name",
  child_name: "Child Name",
  today: "Today's Date",
  dept_name: "Department Name",
  stage_label: "Pipeline Stage",
  task_label: "Task Name",
  due_date: "Due Date",
  initials: "Client Initials",
  milestone_label: "Milestone Label",
  insurance_payer: "Insurance Payer",
  auth_expiration_date: "Authorization Expiration Date",
  days_remaining: "Days Remaining",
  assigned_bcba_name: "Assigned BCBA",
  authorization_status: "Authorization Status",
  client_link: "Link to Client Record",
  waitlist_reason: "Waitlist Reason",
};

// ---- rendering ----
async function etRenderList(mount) {
  mount.innerHTML = `<div class="et-wrap" id="et-view-content"><div class="et-header"><h1>Email Templates</h1></div><div id="et-list-body">Loading…</div></div>`;
  let templates;
  try {
    templates = await etApi("/api/email-templates");
  } catch (e) {
    document.getElementById("et-list-body").textContent = "Failed to load templates: " + e.message;
    return;
  }
  const byCategory = {};
  for (const t of templates) {
    const cat = t.category || "Other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(t);
  }
  const order = ["Parent Milestone Emails", "Waitlist Emails", "Internal Staff Alerts", "Authorization Alerts"];
  const categories = Object.keys(byCategory).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  let html = "";
  for (const cat of categories) {
    html += `<div class="et-category"><h2>${etEscapeHtml(cat)}</h2>`;
    for (const t of byCategory[cat]) {
      html += `
        <div class="et-card">
          <div class="et-card-info">
            <strong>${etEscapeHtml(t.label)}</strong>
            <span>${etEscapeHtml(t.description || "")}</span>
          </div>
          <button class="et-edit-btn" data-key="${etEscapeHtml(t.template_key)}">Edit</button>
        </div>`;
    }
    html += `</div>`;
  }
  const body = document.getElementById("et-list-body");
  if (!body) return;
  body.innerHTML = html || "<p>No templates found.</p>";
  body.querySelectorAll(".et-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      location.hash = "#/email-templates/" + btn.dataset.key;
    });
  });
}

async function etRenderEditor(mount, key) {
  mount.innerHTML = `<div class="et-wrap" id="et-view-content">
    <button class="et-back" id="et-back-btn">&larr; Back to Email Templates</button>
    <div id="et-editor-body">Loading…</div>
  </div>`;
  document.getElementById("et-back-btn").addEventListener("click", () => {
    location.hash = "#/email-templates";
  });

  let template;
  try {
    template = await etApi("/api/email-templates/" + encodeURIComponent(key));
  } catch (e) {
    document.getElementById("et-editor-body").textContent = "Failed to load template: " + e.message;
    return;
  }

  const fields = template.fields || [];
  const fieldChips = fields
    .map(
      (f) =>
        `<button type="button" class="et-field-chip" data-field="${etEscapeHtml(f)}">{{${etEscapeHtml(
          f
        )}}} — ${etEscapeHtml(ET_MERGE_FIELD_LABELS[f] || f)}</button>`
    )
    .join("");

  const body = document.getElementById("et-editor-body");
  body.innerHTML = `
    <div class="et-header"><h1>${etEscapeHtml(template.label)}</h1></div>

    <label class="et-field-label">Subject line</label>
    <input type="text" class="et-subject-input" id="et-subject-input" value="${etEscapeHtml(template.subject_template)}" />

    <label class="et-field-label">Email body</label>
    <div class="et-toolbar">
      <button type="button" data-cmd="bold"><strong>B</strong></button>
      <button type="button" data-cmd="italic"><em>I</em></button>
      <button type="button" id="et-link-btn">Insert Link</button>
      <button type="button" id="et-image-btn">Insert Photo</button>
    </div>
    <div class="et-body-editor" id="et-body-editor" contenteditable="true">${template.body_template}</div>
    <input type="file" accept="image/*" class="et-hidden-file" id="et-image-input" />

    <div class="et-fields-box">
      <h3>Insert a merge field (click to add at cursor)</h3>
      ${fieldChips || "<span>No merge fields for this template.</span>"}
    </div>

    <div class="et-actions">
      <button class="et-save-btn" id="et-save-btn">Save Changes</button>
      <button class="et-preview-btn" id="et-preview-btn">Preview</button>
      <button class="et-test-btn" id="et-test-btn">Send Test to Me</button>
      <span class="et-status-msg" id="et-status-msg"></span>
    </div>
    <div id="et-preview-panel"></div>
  `;

  const editor = document.getElementById("et-body-editor");
  const statusMsg = document.getElementById("et-status-msg");

  function setStatus(msg, ok) {
    statusMsg.textContent = msg;
    statusMsg.className = "et-status-msg " + (ok ? "ok" : "err");
    if (msg) setTimeout(() => (statusMsg.textContent = ""), 4000);
  }

  function focusEditor() {
    editor.focus();
  }

  body.querySelectorAll(".et-toolbar button[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      focusEditor();
      document.execCommand(btn.dataset.cmd, false, null);
    });
  });

  document.getElementById("et-link-btn").addEventListener("click", () => {
    const url = prompt("Link URL (include https://):");
    if (!url) return;
    focusEditor();
    document.execCommand("createLink", false, url);
  });

  const imageInput = document.getElementById("et-image-input");
  document.getElementById("et-image-btn").addEventListener("click", () => imageInput.click());
  imageInput.addEventListener("change", async () => {
    const file = imageInput.files && imageInput.files[0];
    if (!file) return;
    setStatus("Uploading photo…", true);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const result = await etApi("/api/email-templates/upload-image", {
        method: "POST",
        body: { filename: file.name, mime_type: file.type, content_base64: base64 },
      });
      focusEditor();
      document.execCommand("insertHTML", false, `<img src="${result.url}" alt="" />`);
      setStatus("Photo added.", true);
    } catch (e) {
      setStatus("Photo upload failed: " + e.message, false);
    } finally {
      imageInput.value = "";
    }
  });

  body.querySelectorAll(".et-field-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      focusEditor();
      document.execCommand("insertText", false, `{{${chip.dataset.field}}}`);
    });
  });

  document.getElementById("et-save-btn").addEventListener("click", async () => {
    setStatus("Saving…", true);
    try {
      await etApi("/api/email-templates/" + encodeURIComponent(key), {
        method: "PUT",
        body: {
          subject_template: document.getElementById("et-subject-input").value,
          body_template: editor.innerHTML,
        },
      });
      setStatus("Saved.", true);
    } catch (e) {
      setStatus("Save failed: " + e.message, false);
    }
  });

  document.getElementById("et-preview-btn").addEventListener("click", async () => {
    // Preview whatever is currently on screen (including unsaved edits) by
    // saving first, then rendering with sample data.
    setStatus("Saving and rendering preview…", true);
    try {
      await etApi("/api/email-templates/" + encodeURIComponent(key), {
        method: "PUT",
        body: {
          subject_template: document.getElementById("et-subject-input").value,
          body_template: editor.innerHTML,
        },
      });
      const rendered = await etApi("/api/email-templates/" + encodeURIComponent(key) + "/preview", { method: "POST" });
      const panel = document.getElementById("et-preview-panel");
      panel.innerHTML = `
        <div class="et-preview-panel">
          <div class="et-preview-subject"><strong>Subject:</strong> ${etEscapeHtml(rendered.subject)}</div>
          <iframe class="et-preview-frame" id="et-preview-iframe"></iframe>
        </div>`;
      const iframe = document.getElementById("et-preview-iframe");
      iframe.srcdoc = rendered.html;
      setStatus("Preview ready below.", true);
    } catch (e) {
      setStatus("Preview failed: " + e.message, false);
    }
  });

  document.getElementById("et-test-btn").addEventListener("click", async () => {
    setStatus("Saving and sending test…", true);
    try {
      await etApi("/api/email-templates/" + encodeURIComponent(key), {
        method: "PUT",
        body: {
          subject_template: document.getElementById("et-subject-input").value,
          body_template: editor.innerHTML,
        },
      });
      const result = await etApi("/api/email-templates/" + encodeURIComponent(key) + "/send-test", { method: "POST" });
      setStatus(
        result.delivered === "sent"
          ? "Test email sent to your inbox."
          : `Test email status: ${result.delivered || "unknown"}.`,
        result.ok
      );
    } catch (e) {
      setStatus("Send test failed: " + e.message, false);
    }
  });
}

// ---- Failed Emails page (retry / "push" failed sends) ----
function etFormatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

// Stored "delivered" values look like "failed" or "failed: <provider error>".
function etFailureReason(delivered) {
  const text = String(delivered || "").replace(/^failed:?\s*/, "").trim();
  return text || "Unknown error";
}

function etFeStatus(msg, ok) {
  const s = document.getElementById("et-fe-status");
  if (!s) return;
  s.textContent = msg || "";
  s.className = "et-status-msg " + (ok ? "ok" : "err");
  if (msg) setTimeout(() => { if (s) s.textContent = ""; }, 5000);
}

async function etLoadFailedList() {
  const body = document.getElementById("et-fe-body");
  if (!body) return;
  body.textContent = "Loading…";
  let rows;
  try {
    rows = await etApi("/api/failed-emails");
  } catch (e) {
    body.textContent = "Failed to load: " + e.message;
    return;
  }
  if (!rows.length) {
    body.innerHTML = `<div class="et-fe-empty">No failed emails — everything has gone out successfully.</div>`;
    return;
  }
  let html = `<table class="et-fe-table"><thead><tr>
    <th>When</th><th>To</th><th>Type</th><th>Subject</th><th>Error</th><th></th>
  </tr></thead><tbody>`;
  for (const r of rows) {
    const reason = etFailureReason(r.delivered);
    html += `<tr>
      <td class="et-fe-when">${etEscapeHtml(etFormatDate(r.sent_at))}</td>
      <td>${etEscapeHtml(r.recipient)}</td>
      <td>${etEscapeHtml(r.type || "")}</td>
      <td>${etEscapeHtml(r.subject || "")}</td>
      <td class="et-fe-err" title="${etEscapeHtml(reason)}">${etEscapeHtml(reason)}</td>
      <td><button class="et-edit-btn et-fe-resend" data-id="${etEscapeHtml(r.id)}">Resend</button></td>
    </tr>`;
  }
  html += `</tbody></table>`;
  body.innerHTML = html;
  body.querySelectorAll(".et-fe-resend").forEach((btn) => {
    btn.addEventListener("click", () => etResendOne(btn.dataset.id, btn));
  });
}

async function etResendOne(id, btn) {
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const result = await etApi("/api/failed-emails/" + encodeURIComponent(id) + "/resend", { method: "POST" });
    if (result.ok) {
      etFeStatus("Email resent successfully.", true);
    } else {
      etFeStatus("Still failing: " + (result.errorMsg || result.error || "unknown error"), false);
    }
  } catch (e) {
    etFeStatus("Resend failed: " + e.message, false);
  }
  await etLoadFailedList();
}

async function etRenderFailedEmails(mount) {
  mount.innerHTML = `<div class="et-wrap" id="et-view-content">
    <div class="et-header"><h1>Failed Emails</h1></div>
    <p class="et-fe-hint">These are emails the CRM tried to send but the mail provider rejected or errored on. Fix the underlying problem if needed (a bad address, or the email provider configuration), then push them out again. A resend re-uses the original message content and, when successful, clears it from this list.</p>
    <div class="et-actions" style="margin-top:0;">
      <button class="et-save-btn" id="et-fe-resend-all" style="background:#1b2a6b;">Resend All</button>
      <button class="et-preview-btn" id="et-fe-refresh">Refresh</button>
      <span class="et-status-msg" id="et-fe-status"></span>
    </div>
    <div id="et-fe-body" style="margin-top:16px;">Loading…</div>
  </div>`;

  document.getElementById("et-fe-refresh").addEventListener("click", () => etLoadFailedList());

  document.getElementById("et-fe-resend-all").addEventListener("click", async () => {
    const btn = document.getElementById("et-fe-resend-all");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Resending…";
    try {
      const result = await etApi("/api/failed-emails/resend-all", { method: "POST" });
      if (!result.attempted) {
        etFeStatus("Nothing to resend.", true);
      } else {
        etFeStatus(
          `Resent ${result.resent} of ${result.attempted}.` +
            (result.stillFailed ? ` ${result.stillFailed} still failing.` : ""),
          result.stillFailed === 0
        );
      }
    } catch (e) {
      etFeStatus("Resend all failed: " + e.message, false);
    }
    btn.disabled = false;
    btn.textContent = orig;
    await etLoadFailedList();
  });

  await etLoadFailedList();
}

// ---- self-healing view sync (checks a live DOM marker instead of a static
// flag, so it correctly re-renders if the native app's own async route()
// resolves after us and silently overwrites #view-mount -- see the same fix
// applied to financial-center.js). ----
let etRenderInFlight = false;

async function etSyncView() {
  const hash = location.hash || "";
  const isTemplates = hash.startsWith("#/email-templates");
  const isFailed = hash.startsWith("#/failed-emails");
  if (!isTemplates && !isFailed) return;
  if (!etCanEdit()) return;
  if (etRenderInFlight) return;

  const mount = document.getElementById("view-mount") || document.getElementById("app");
  if (!mount) return;

  const alreadyRendered = mount.querySelector("#et-view-content");

  // Distinct render key per view so switching between the list, an editor, and
  // the failed-emails page always triggers a re-render.
  let desiredKey;
  if (isFailed) {
    desiredKey = "__failed__";
  } else {
    const parts = hash.replace(/^#\//, "").split("/"); // ["email-templates"] or ["email-templates", key]
    desiredKey = parts[1] ? "tpl:" + parts[1] : "__list__";
  }
  const renderedKey = mount.dataset.etKey || null;

  if (alreadyRendered && renderedKey === desiredKey) return;

  etRenderInFlight = true;
  try {
    mount.dataset.etKey = desiredKey;
    if (isFailed) {
      await etRenderFailedEmails(mount);
    } else if (desiredKey === "__list__") {
      await etRenderList(mount);
    } else {
      await etRenderEditor(mount, desiredKey.slice(4)); // strip "tpl:"
    }
  } finally {
    etRenderInFlight = false;
  }
}

function etOnAppMutated() {
  etSyncNavButton();
  etSyncView();
}

function initEmailTemplates() {
  etInjectStyles();
  etSyncNavButton();
  etSyncView();

  const app = document.getElementById("app");
  if (app) {
    const observer = new MutationObserver(() => etOnAppMutated());
    observer.observe(app, { childList: true, subtree: true });
  }

  window.addEventListener("hashchange", () => {
    etSyncNavButton();
    etSyncView();
  });

  // Defensive retries in case #app / .sidebar nav aren't mounted yet on
  // first script execution.
  [150, 500, 1200, 2500, 4000].forEach((ms) => {
    setTimeout(() => {
      etSyncNavButton();
      etSyncView();
    }, ms);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initEmailTemplates);
} else {
  initEmailTemplates();
}
