// policy-change-requests-frontend.js -- Policy Change Requests + the Policy
// Exception log (progressive-enhancement, same shape as the supply module).
//
// One sidebar button, two tabs, because they are two answers to "the rule does
// not fit this situation" and reading one without the other gives a false
// picture of what happened to a policy.
//
// The screen is built around the one property the feature exists to protect:
// SUBMITTING A REQUEST CHANGES NOTHING. That is said on the form, said again on
// the requester's own list, and said on an approved request too -- approved is
// not published, and a staff member who reads "Approved" and starts behaving
// differently is the failure mode. The decision box refuses to save without a
// written response for the same reason the server refuses it.
(function () {
  "use strict";
  const HASH = "#/policy-changes";
  const ACCENT = "#7c3aed";

  function canSee() {
    if (typeof state === "undefined" || !state.user || !state.user.id) return false;
    const ma = typeof getModuleAccess === "function" ? getModuleAccess(state.user) : null;
    return !(ma && ma.policy_changes === false);
  }
  // Distinguishes "the shell has not booted yet" from "this person may not be
  // here". Without it the first hashchange after a cold load bounces the user
  // to the dashboard because state.user is not populated yet.
  function shellReady() { return typeof state !== "undefined" && !!state.user; }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "Request failed");
    return d;
  }
  function fmt(s) { if (!s) return "—"; try { return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch (e) { return s; } }
  function fmtT(s) { if (!s) return ""; try { return new Date(s).toLocaleString(); } catch (e) { return s; } }
  function cycleName(c) {
    if (!c) return "—";
    const m = /^(\d{4})-(\d{2})$/.exec(String(c));
    if (!m) return c;
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return MONTHS[Number(m[2]) - 1] + " " + m[1];
  }
  function statusColor(s) {
    return {
      "Submitted": "#6366f1", "Pending Monthly Review": "#8b5cf6", "Under Review": "#0891b2",
      "Additional Information Requested": "#ca8a04", "Approved": "#16a34a",
      "Approved With Modification": "#15803d", "Deferred": "#64748b",
      "Declined": "#dc2626", "Implemented": "#047857",
      "Active": "#16a34a", "Expired": "#64748b", "Revoked": "#dc2626",
    }[s] || "#64748b";
  }
  const pill = (s) => '<span style="display:inline-block;background:' + statusColor(s) + ';color:#fff;font-weight:700;font-size:11.5px;padding:3px 10px;border-radius:20px;">' + esc(s) + "</span>";
  const NOT_CHANGED = "Submitting a request does not change the current policy. The policy in force stays in force until an approved revision is published.";

  let tab = "requests";
  let opts = null;   // cached /api/policy-changes/options

  function injectNav() {
    if (!canSee()) return;
    const nav = document.querySelector(".sidebar nav");
    if (!nav || document.getElementById("pcr-nav-btn")) return;
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.id = "pcr-nav-btn";
    btn.dataset.nav = "policy_changes";
    btn.innerHTML = "Policy Change Requests";
    // Mirrored from a neighbour rather than hardcoded: the shell makes nav
    // items draggable for admins only, and asserting it here would hand a
    // staff member a handle the rest of the sidebar does not have.
    const sib = nav.querySelector('[data-nav="supply"]') || nav.querySelector(".nav-item");
    if (sib) btn.draggable = sib.draggable;
    btn.addEventListener("click", () => { location.hash = HASH; });
    nav.appendChild(btn);
    if (typeof window.__navPlace === "function") window.__navPlace(btn);
  }

  function modal(inner, width) {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = '<div class="modal" style="max-width:' + (width || 680) + 'px;">' + inner + "</div>";
    document.body.appendChild(back);
    const close = () => back.remove();
    const cb = back.querySelector(".close-btn"); if (cb) cb.addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    return { back, close };
  }

  async function render() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    mount.innerHTML = '<div style="padding:40px;color:#767488;">Loading…</div>';
    if (!opts) { try { opts = await api("/api/policy-changes/options"); } catch (e) { opts = null; } }
    mount.dataset.pcr = "1";

    const head =
      '<div style="padding:24px 28px 0;max-width:1060px;">' +
        '<div style="display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;">' +
          '<h1 style="font-size:24px;margin:0;font-weight:800;color:' + ACCENT + ';">Policy Change Requests</h1>' +
          '<div style="display:flex;gap:8px;"><button class="btn small" id="pcr-new">Request a policy change</button></div>' +
        "</div>" +
        '<p style="margin:8px 0 14px;color:#767488;font-size:13.5px;">' + esc(NOT_CHANGED) + "</p>" +
        '<div style="display:flex;gap:6px;border-bottom:1px solid #e6e1d4;margin-bottom:0;">' +
          ['<button class="pcr-tab" data-t="requests" style="border:0;background:none;padding:9px 14px;font-size:13.5px;font-weight:700;cursor:pointer;color:' + (tab === "requests" ? ACCENT : "#767488") + ';border-bottom:2px solid ' + (tab === "requests" ? ACCENT : "transparent") + ';">Change Requests</button>',
           '<button class="pcr-tab" data-t="exceptions" style="border:0;background:none;padding:9px 14px;font-size:13.5px;font-weight:700;cursor:pointer;color:' + (tab === "exceptions" ? ACCENT : "#767488") + ';border-bottom:2px solid ' + (tab === "exceptions" ? ACCENT : "transparent") + ';">Policy Exceptions</button>'].join("") +
        "</div>" +
      "</div>";

    let body;
    try { body = tab === "requests" ? await requestsHtml() : await exceptionsHtml(); }
    catch (e) { body = '<div style="padding:40px;color:#a3282e;">' + esc(e.message) + "</div>"; }
    mount.innerHTML = head + body;

    mount.querySelectorAll(".pcr-tab").forEach((b) => b.addEventListener("click", () => { tab = b.getAttribute("data-t"); render(); }));
    const nb = mount.querySelector("#pcr-new");
    if (nb) nb.addEventListener("click", () => (tab === "exceptions" ? newException() : newRequest()));
    mount.querySelectorAll(".pcr-row").forEach((el) => el.addEventListener("click", () => openRequest(el.getAttribute("data-id"))));
    mount.querySelectorAll(".pex-row").forEach((el) => el.addEventListener("click", () => openException(el.getAttribute("data-id"))));
  }

  // ---------- change requests ----------
  async function requestsHtml() {
    const d = await api("/api/policy-changes");
    const tile = (label, n, color) =>
      '<div style="flex:1;min-width:130px;background:#fff;border:1px solid #e6e1d4;border-left:3px solid ' + color + ';border-radius:10px;padding:12px 14px;">' +
        '<div style="font-size:22px;font-weight:800;color:' + color + ';">' + n + "</div>" +
        '<div style="font-size:11.5px;color:#767488;font-weight:600;">' + esc(label) + "</div></div>";

    const rows = (d.requests || []).map((r) => {
      const what = r.policy ? r.policy.title : (r.proposed_title || "New policy");
      const type = { create: "Create new", modify: "Modify", discontinue: "Discontinue" }[r.request_type] || r.request_type;
      return '<tr class="pcr-row" data-id="' + r.id + '" style="cursor:pointer;border-bottom:1px solid #f0ede3;">' +
        '<td style="padding:10px 12px;"><div style="font-weight:700;">' + esc(what) +
          (r.is_emergency ? ' <span style="color:#dc2626;font-size:11px;font-weight:700;">● Emergency</span>' : "") + "</div>" +
          '<div style="font-size:11.5px;color:#8a8797;">' + esc(type) + " · " + esc((r.reason || "").slice(0, 70)) + "</div></td>" +
        '<td style="padding:10px 12px;">' + esc(r.requester_name || "—") +
          '<div style="font-size:11.5px;color:#8a8797;">' + esc(r.department || "") + "</div></td>" +
        '<td style="padding:10px 12px;color:#8a8797;font-size:12.5px;">' + fmt(r.created_at) + "</td>" +
        '<td style="padding:10px 12px;color:#8a8797;font-size:12.5px;">' + esc(cycleName(r.review_cycle)) + "</td>" +
        '<td style="padding:10px 12px;">' + pill(r.status) + "</td></tr>";
    }).join("") || '<tr><td colspan="5" style="padding:24px;text-align:center;color:#8a8797;">Nothing here yet.</td></tr>';

    const c = d.counts || {};
    return '<div style="padding:18px 28px 60px;max-width:1060px;">' +
      (d.can_review
        ? '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">' +
            tile("Awaiting review", c.awaiting || 0, "#8b5cf6") +
            tile(cycleName(d.cycle) + " cycle", c.this_cycle || 0, "#0891b2") +
            tile("Emergency", c.emergency || 0, "#dc2626") +
            tile("Approved", c.approved_not_implemented || 0, "#16a34a") +
          "</div>"
        : '<p style="margin:0 0 14px;color:#767488;font-size:13px;">These are the requests you have raised.</p>') +
      '<div style="background:#fff;border:1px solid #e6e1d4;border-radius:12px;overflow:hidden;">' +
        '<table style="width:100%;border-collapse:collapse;font-size:13.5px;"><thead><tr style="background:#faf9f5;text-align:left;color:#767488;font-size:12px;">' +
          '<th style="padding:10px 12px;">Request</th><th style="padding:10px 12px;">Requestor</th>' +
          '<th style="padding:10px 12px;">Submitted</th><th style="padding:10px 12px;">Review cycle</th><th style="padding:10px 12px;">Status</th>' +
        "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  function newRequest() {
    const o = opts || { request_types: [], policies: [], impact_areas: [] };
    const polOpts = (o.policies || []).map((p) =>
      '<option value="' + p.id + '">' + esc((p.doc_number ? p.doc_number + " — " : "") + p.title) + (p.kind === "sop" ? " (SOP)" : "") + "</option>").join("");
    const impacts = (o.impact_areas || []).map((a) =>
      '<label style="display:inline-flex;align-items:center;gap:5px;margin:0 12px 6px 0;font-size:13px;font-weight:500;"><input type="checkbox" class="pcr-impact" value="' + esc(a) + '" /> ' + esc(a) + "</label>").join("");

    const { back, close } = modal(
      '<div class="modal-header"><div><h2>Request a policy change</h2></div><button class="close-btn">✕</button></div>' +
      '<div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:12.5px;color:#4c1d95;">' +
        "<b>This does not change the policy.</b> " + esc(NOT_CHANGED) + " Requests go to the monthly policy review." +
      "</div>" +
      '<div class="field"><label>What are you asking for?</label><select id="pcr-type">' +
        // Modify is pre-selected rather than whatever happens to be first in
        // the list: asking for a change to an existing policy is the common
        // case, and defaulting to "create" hid the policy picker behind a
        // dropdown change nobody would think to make.
        (o.request_types || []).map((t) => '<option value="' + t.key + '"' + (t.key === "modify" ? " selected" : "") + ">" + esc(t.label) + "</option>").join("") +
      "</select></div>" +
      '<div class="field" id="pcr-pol-wrap"><label>Which policy or SOP?</label><select id="pcr-policy"><option value="">— choose —</option>' + polOpts + "</select></div>" +
      '<div class="field" id="pcr-title-wrap" style="display:none;"><label>What would the new policy be called?</label><input id="pcr-title" /></div>' +
      '<div class="field"><label>Your department or role</label><input id="pcr-dept" placeholder="e.g. Clinical, Billing, Admin" /></div>' +
      '<div class="field"><label>Requested change</label><textarea id="pcr-change" rows="3" placeholder="What specifically should the rule say instead?"></textarea></div>' +
      '<div class="field"><label>Reason for request</label><textarea id="pcr-reason" rows="2"></textarea></div>' +
      '<div class="field"><label>What problem does this solve?</label><textarea id="pcr-problem" rows="2"></textarea></div>' +
      '<div class="field"><label>Potential impact on</label><div>' + impacts +
        '</div><input id="pcr-impact-other" placeholder="Other — describe" style="margin-top:6px;" /></div>' +
      '<div class="field"><label>Proposed solution (optional)</label><textarea id="pcr-solution" rows="2"></textarea></div>' +
      '<div style="margin-top:12px;"><button class="btn" id="pcr-send">Submit request</button> <span id="pcr-res" style="font-size:12px;color:var(--text-muted);"></span></div>'
    );

    const typeSel = back.querySelector("#pcr-type");
    const sync = () => {
      const create = typeSel.value === "create";
      back.querySelector("#pcr-pol-wrap").style.display = create ? "none" : "";
      back.querySelector("#pcr-title-wrap").style.display = create ? "" : "none";
    };
    typeSel.addEventListener("change", sync); sync();

    const send = back.querySelector("#pcr-send");
    send.addEventListener("click", async () => {
      const resEl = back.querySelector("#pcr-res");
      send.disabled = true; resEl.textContent = "Submitting…";
      try {
        await api("/api/policy-changes", { method: "POST", body: {
          request_type: typeSel.value,
          policy_id: back.querySelector("#pcr-policy").value || null,
          proposed_title: back.querySelector("#pcr-title").value,
          department: back.querySelector("#pcr-dept").value,
          requested_change: back.querySelector("#pcr-change").value,
          reason: back.querySelector("#pcr-reason").value,
          problem_solved: back.querySelector("#pcr-problem").value,
          proposed_solution: back.querySelector("#pcr-solution").value,
          impact_areas: Array.from(back.querySelectorAll(".pcr-impact:checked")).map((c) => c.value),
          impact_other: back.querySelector("#pcr-impact-other").value,
        } });
        close(); render();
      } catch (e) { send.disabled = false; resEl.textContent = e.message || "Could not submit."; }
    });
  }

  async function openRequest(id) {
    let r;
    try { r = await api("/api/policy-changes/" + id); } catch (e) { alert(e.message); return; }
    const o = opts || {};
    const what = r.policy ? r.policy.title : (r.proposed_title || "New policy");
    const row = (k, v) => v ? '<div style="margin-bottom:8px;"><div style="font-size:11px;color:#8a8797;font-weight:700;text-transform:uppercase;">' + esc(k) + "</div><div style=\"font-size:13.5px;white-space:pre-wrap;\">" + esc(v) + "</div></div>" : "";

    const hist = (r.history || []).map((h) =>
      '<li style="margin-bottom:6px;font-size:12.5px;color:#555;"><b>' + esc(h.action.replace(/_/g, " ")) + "</b> — " +
      esc(h.actor_name || "system") + " · " + fmtT(h.created_at) +
      (h.note ? '<div style="color:#767488;">' + esc(h.note) + "</div>" : "") + "</li>").join("");

    // Approved is NOT published. Said here as plainly as on the form, because
    // this is the screen somebody reads before deciding how to behave.
    const standing = /^Approved/.test(r.status)
      ? '<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12.5px;color:#065f46;"><b>Approved — not yet published.</b> The current policy still applies until the revised policy is published' + (r.effective_date ? " (effective " + esc(r.effective_date) + ")" : "") + '.</div>'
      : r.status === "Implemented"
        ? '<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12.5px;color:#065f46;"><b>Implemented.</b> The revised policy is published and in force.</div>'
        : '<div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12.5px;color:#4c1d95;"><b>The current policy is unchanged.</b> ' + esc(NOT_CHANGED) + "</div>";

    const decided = !!r.decision;

    const decideBox = (o.can_decide && !decided)
      ? '<div style="border-top:1px solid #e6e1d4;margin-top:14px;padding-top:12px;">' +
          '<div style="font-weight:800;font-size:14px;margin-bottom:8px;">Record the decision</div>' +
          '<div class="field"><label>Decision</label><select id="pcr-dec">' +
            (o.decisions || []).map((x) => '<option>' + esc(x) + "</option>").join("") + "</select></div>" +
          '<div class="field"><label>Decision / response <span style="color:#dc2626;">(required)</span></label>' +
            '<textarea id="pcr-dec-notes" rows="3" placeholder="What was decided, and why. This is sent to the requester."></textarea></div>' +
          '<div class="field"><label>Effective date (if approved)</label><input type="date" id="pcr-eff" /></div>' +
          '<label style="display:block;font-size:13px;margin-bottom:4px;"><input type="checkbox" id="pcr-ack" /> Requires staff acknowledgment</label>' +
          '<label style="display:block;font-size:13px;margin-bottom:8px;"><input type="checkbox" id="pcr-train" /> Requires training</label>' +
          '<button class="btn" id="pcr-dec-save">Save decision</button> <span id="pcr-dec-res" style="font-size:12px;color:var(--text-muted);"></span>' +
        "</div>"
      : "";

    const implBox = (o.can_decide && /^Approved/.test(r.status))
      ? '<div style="margin-top:12px;"><button class="btn small" id="pcr-impl">Mark implemented (revision published)</button></div>' : "";

    const emergBox = (o.can_emergency && !decided && !r.is_emergency)
      ? '<details style="margin-top:12px;"><summary style="cursor:pointer;font-size:13px;font-weight:700;color:#b45309;">Emergency change — outside the monthly review</summary>' +
          '<div style="padding:10px 0 0;font-size:12.5px;color:#767488;">Use only for safety, compliance, a payer requirement, a legal or regulatory obligation, or urgent business operations. The grounds and the reason are recorded.</div>' +
          '<div class="field"><label>Grounds</label><select id="pcr-eg">' +
            (o.emergency_grounds || []).map((g) => "<option>" + esc(g) + "</option>").join("") + "</select></div>" +
          '<div class="field"><label>Why this cannot wait</label><textarea id="pcr-er" rows="2"></textarea></div>' +
          '<button class="btn small" id="pcr-eg-save">Start emergency review</button> <span id="pcr-eg-res" style="font-size:12px;color:var(--text-muted);"></span>' +
        "</details>" : "";

    const reviewControls = o.can_review && !decided
      ? '<div style="border-top:1px solid #e6e1d4;margin-top:14px;padding-top:12px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">' +
          '<div class="field" style="margin:0;flex:1;min-width:160px;"><label>Assigned reviewer</label><input id="pcr-rev" value="' + esc(r.assigned_reviewer || "") + '" /></div>' +
          '<div class="field" style="margin:0;flex:1;min-width:200px;"><label>Status</label><select id="pcr-stat">' +
            (o.statuses || []).filter((x) => !["Approved", "Approved With Modification", "Declined", "Implemented"].includes(x))
              .map((x) => '<option' + (x === r.status ? " selected" : "") + ">" + esc(x) + "</option>").join("") + "</select></div>" +
          '<button class="btn small secondary" id="pcr-patch">Save</button> <span id="pcr-patch-res" style="font-size:12px;color:var(--text-muted);"></span>' +
        "</div>" : "";

    const { back, close } = modal(
      '<div class="modal-header"><div><h2>' + esc(what) + "</h2>" +
        '<div style="font-size:12.5px;color:#767488;">' + esc({ create: "Create new policy", modify: "Modify existing policy", discontinue: "Discontinue policy" }[r.request_type] || r.request_type) +
        " · " + esc(cycleName(r.review_cycle)) + " review · " + esc(r.requester_name || "—") + "</div></div>" +
        '<button class="close-btn">✕</button></div>' +
      '<div style="margin-bottom:10px;">' + pill(r.status) + (r.is_emergency ? ' <span style="color:#dc2626;font-weight:700;font-size:12px;">Emergency</span>' : "") + "</div>" +
      standing +
      row("Requested change", r.requested_change) +
      row("Reason", r.reason) +
      row("Problem it solves", r.problem_solved) +
      row("Proposed solution", r.proposed_solution) +
      row("Potential impact", (r.impact_areas || []).join(", ") + (r.impact_other ? (r.impact_areas.length ? "; " : "") + r.impact_other : "")) +
      (r.is_emergency ? row("Emergency grounds", r.emergency_grounds + " — " + (r.emergency_reason || "")) : "") +
      (decided
        ? '<div style="background:#faf9f5;border:1px solid #e6e1d4;border-radius:10px;padding:10px 12px;margin:10px 0;">' +
            row("Decision", r.decision) + row("Response", r.decision_notes) +
            row("Decided by", (r.decided_by || "") + (r.decision_date ? " · " + fmt(r.decision_date) : "")) +
            row("Effective date", r.effective_date) +
            ((r.requires_acknowledgment || r.requires_training)
              ? row("Follow-up required", [r.requires_acknowledgment ? "Staff acknowledgment" : null, r.requires_training ? "Training" : null].filter(Boolean).join(" · "))
              : "") +
          "</div>" : "") +
      reviewControls + decideBox + implBox + emergBox +
      (hist ? '<details style="margin-top:14px;"><summary style="cursor:pointer;font-size:13px;font-weight:700;">Audit trail</summary><ul style="padding-left:18px;margin:8px 0 0;">' + hist + "</ul></details>" : ""),
      720
    );

    const patch = back.querySelector("#pcr-patch");
    if (patch) patch.addEventListener("click", async () => {
      const el = back.querySelector("#pcr-patch-res");
      try {
        await api("/api/policy-changes/" + id, { method: "PATCH", body: {
          assigned_reviewer: back.querySelector("#pcr-rev").value,
          status: back.querySelector("#pcr-stat").value,
        } });
        el.textContent = "Saved ✓"; render();
      } catch (e) { el.textContent = e.message; }
    });

    const decSave = back.querySelector("#pcr-dec-save");
    if (decSave) decSave.addEventListener("click", async () => {
      const el = back.querySelector("#pcr-dec-res");
      const notes = back.querySelector("#pcr-dec-notes").value.trim();
      // Refused here as well as on the server, so the person finds out before
      // the round trip rather than after it.
      if (!notes) { el.textContent = "Write the decision response first."; return; }
      decSave.disabled = true;
      try {
        await api("/api/policy-changes/" + id + "/decide", { method: "POST", body: {
          decision: back.querySelector("#pcr-dec").value,
          decision_notes: notes,
          effective_date: back.querySelector("#pcr-eff").value,
          requires_acknowledgment: back.querySelector("#pcr-ack").checked,
          requires_training: back.querySelector("#pcr-train").checked,
        } });
        close(); render();
      } catch (e) { decSave.disabled = false; el.textContent = e.message; }
    });

    const impl = back.querySelector("#pcr-impl");
    if (impl) impl.addEventListener("click", async () => {
      try { await api("/api/policy-changes/" + id + "/implement", { method: "POST", body: {} }); close(); render(); }
      catch (e) { alert(e.message); }
    });

    const egSave = back.querySelector("#pcr-eg-save");
    if (egSave) egSave.addEventListener("click", async () => {
      const el = back.querySelector("#pcr-eg-res");
      try {
        await api("/api/policy-changes/" + id + "/emergency", { method: "POST", body: {
          grounds: back.querySelector("#pcr-eg").value,
          reason: back.querySelector("#pcr-er").value,
        } });
        close(); render();
      } catch (e) { el.textContent = e.message; }
    });
  }

  // ---------- policy exceptions ----------
  async function exceptionsHtml() {
    const d = await api("/api/policy-exceptions");
    const c = d.counts || {};
    const tile = (label, n, color) =>
      '<div style="flex:1;min-width:130px;background:#fff;border:1px solid #e6e1d4;border-left:3px solid ' + color + ';border-radius:10px;padding:12px 14px;">' +
        '<div style="font-size:22px;font-weight:800;color:' + color + ';">' + n + "</div>" +
        '<div style="font-size:11.5px;color:#767488;font-weight:600;">' + esc(label) + "</div></div>";

    const rows = (d.exceptions || []).map((e) => {
      const who = (e.employee_names || []).join(", ") || e.situation || "—";
      return '<tr class="pex-row" data-id="' + e.id + '" style="cursor:pointer;border-bottom:1px solid #f0ede3;">' +
        '<td style="padding:10px 12px;"><div style="font-weight:700;">' + esc(e.policy ? e.policy.title : "—") + "</div>" +
          '<div style="font-size:11.5px;color:#8a8797;">' + esc((e.reason || "").slice(0, 80)) + "</div></td>" +
        '<td style="padding:10px 12px;font-size:13px;">' + esc(who) + "</td>" +
        '<td style="padding:10px 12px;font-size:13px;">' + esc(e.authorized_by || "—") + "</td>" +
        '<td style="padding:10px 12px;color:#8a8797;font-size:12.5px;">' + fmt(e.start_date) + " → " +
          (e.end_date ? esc(e.end_date) : '<span style="color:#b45309;font-weight:700;">no end date</span>') + "</td>" +
        '<td style="padding:10px 12px;">' + pill(e.status) + "</td></tr>";
    }).join("") || '<tr><td colspan="5" style="padding:24px;text-align:center;color:#8a8797;">No exceptions recorded.</td></tr>';

    return '<div style="padding:18px 28px 60px;max-width:1060px;">' +
      '<p style="margin:0 0 14px;color:#767488;font-size:13px;">An exception leaves the policy in force and departs from it once, on the record. The point is not to prevent leadership discretion — it is to make it intentional, documented and reviewable.</p>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">' +
        tile("Active", c.active || 0, "#16a34a") +
        tile("Ending within 30 days", c.expiring_soon || 0, "#ca8a04") +
        tile("No end date", c.open_ended || 0, "#b45309") +
        tile("Awaiting executive approval", c.awaiting_exec || 0, "#dc2626") +
      "</div>" +
      '<div style="background:#fff;border:1px solid #e6e1d4;border-radius:12px;overflow:hidden;">' +
        '<table style="width:100%;border-collapse:collapse;font-size:13.5px;"><thead><tr style="background:#faf9f5;text-align:left;color:#767488;font-size:12px;">' +
          '<th style="padding:10px 12px;">Policy</th><th style="padding:10px 12px;">Who / situation</th>' +
          '<th style="padding:10px 12px;">Authorized by</th><th style="padding:10px 12px;">In force</th><th style="padding:10px 12px;">Status</th>' +
        "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  function newException() {
    const o = opts || { policies: [] };
    const polOpts = (o.policies || []).map((p) =>
      '<option value="' + p.id + '">' + esc((p.doc_number ? p.doc_number + " — " : "") + p.title) + (p.kind === "sop" ? " (SOP)" : "") + "</option>").join("");
    const { back, close } = modal(
      '<div class="modal-header"><div><h2>Record a policy exception</h2></div><button class="close-btn">✕</button></div>' +
      '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:12.5px;color:#92400e;">' +
        "The policy stays in force for everyone else. This records that it was not applied here, and why." +
      "</div>" +
      '<div class="field"><label>Policy</label><select id="pex-policy"><option value="">— choose —</option>' + polOpts + "</select></div>" +
      '<div class="field"><label>Who it covers</label><input id="pex-who" placeholder="Names, comma-separated" /></div>' +
      '<div class="field"><label>Or the situation it covers</label><input id="pex-sit" placeholder="e.g. after-hours coverage at the Henderson clinic" /></div>' +
      '<div class="field"><label>Reason</label><textarea id="pex-reason" rows="3"></textarea></div>' +
      '<div class="field"><label>Authorized by</label><input id="pex-auth" /></div>' +
      '<div style="display:flex;gap:10px;"><div class="field" style="flex:1;"><label>Start date</label><input type="date" id="pex-start" /></div>' +
      '<div class="field" style="flex:1;"><label>End date (leave blank if permanent)</label><input type="date" id="pex-end" /></div></div>' +
      '<label style="display:block;font-size:13px;margin-bottom:8px;"><input type="checkbox" id="pex-exec" /> Executive approval required</label>' +
      '<div><button class="btn" id="pex-save">Record exception</button> <span id="pex-res" style="font-size:12px;color:var(--text-muted);"></span></div>'
    );
    const save = back.querySelector("#pex-save");
    save.addEventListener("click", async () => {
      const el = back.querySelector("#pex-res");
      save.disabled = true;
      try {
        await api("/api/policy-exceptions", { method: "POST", body: {
          policy_id: back.querySelector("#pex-policy").value || null,
          employee_names: back.querySelector("#pex-who").value.split(",").map((s) => s.trim()).filter(Boolean),
          situation: back.querySelector("#pex-sit").value,
          reason: back.querySelector("#pex-reason").value,
          authorized_by: back.querySelector("#pex-auth").value,
          start_date: back.querySelector("#pex-start").value,
          end_date: back.querySelector("#pex-end").value,
          executive_approval_required: back.querySelector("#pex-exec").checked,
        } });
        close(); render();
      } catch (e) { save.disabled = false; el.textContent = e.message; }
    });
  }

  async function openException(id) {
    let e;
    try { e = await api("/api/policy-exceptions/" + id); } catch (err) { alert(err.message); return; }
    const row = (k, v) => v ? '<div style="margin-bottom:8px;"><div style="font-size:11px;color:#8a8797;font-weight:700;text-transform:uppercase;">' + esc(k) + "</div><div style=\"font-size:13.5px;white-space:pre-wrap;\">" + esc(v) + "</div></div>" : "";
    const hist = (e.history || []).map((h) =>
      '<li style="margin-bottom:6px;font-size:12.5px;color:#555;"><b>' + esc(h.action.replace(/_/g, " ")) + "</b> — " +
      esc(h.actor_name || "system") + " · " + fmtT(h.created_at) +
      (h.note ? '<div style="color:#767488;">' + esc(h.note) + "</div>" : "") + "</li>").join("");
    const o = opts || {};
    const canWrite = o.can_review || o.can_decide;

    const { back, close } = modal(
      '<div class="modal-header"><div><h2>' + esc(e.policy ? e.policy.title : "Policy exception") + "</h2>" +
        '<div style="font-size:12.5px;color:#767488;">Exception · ' + esc(e.status) + "</div></div><button class=\"close-btn\">✕</button></div>" +
      '<div style="margin-bottom:10px;">' + pill(e.status) + (e.open_ended && e.status === "Active" ? ' <span style="color:#b45309;font-weight:700;font-size:12px;">No end date — a permanent exception is a policy by another name</span>' : "") + "</div>" +
      row("Who it covers", (e.employee_names || []).join(", ")) +
      row("Situation", e.situation) +
      row("Reason", e.reason) +
      row("Authorized by", e.authorized_by + (e.authorized_at ? " · " + fmt(e.authorized_at) : "")) +
      row("In force", fmt(e.start_date) + " → " + (e.end_date || "no end date")) +
      (e.executive_approval_required
        ? row("Executive approval", e.executive_approved_at ? e.executive_approved_by + " · " + fmt(e.executive_approved_at) : "REQUIRED — not yet given")
        : "") +
      (e.status === "Revoked" ? row("Withdrawn", e.revoked_by + " · " + fmt(e.revoked_at) + "\n" + (e.revoke_reason || "")) : "") +
      (canWrite && e.executive_approval_required && !e.executive_approved_at && o.can_decide
        ? '<div style="margin-top:12px;"><button class="btn small" id="pex-approve">Give executive approval</button></div>' : "") +
      (canWrite && e.status === "Active"
        ? '<details style="margin-top:12px;"><summary style="cursor:pointer;font-size:13px;font-weight:700;">Withdraw this exception</summary>' +
            '<div style="font-size:12.5px;color:#767488;padding:8px 0;">It stays on the record as withdrawn — exceptions are never deleted.</div>' +
            '<div class="field"><label>Why</label><textarea id="pex-rev" rows="2"></textarea></div>' +
            '<button class="btn small secondary" id="pex-rev-save">Withdraw</button> <span id="pex-rev-res" style="font-size:12px;color:var(--text-muted);"></span>' +
          "</details>" : "") +
      (hist ? '<details style="margin-top:14px;"><summary style="cursor:pointer;font-size:13px;font-weight:700;">Audit trail</summary><ul style="padding-left:18px;margin:8px 0 0;">' + hist + "</ul></details>" : ""),
      700
    );

    const ap = back.querySelector("#pex-approve");
    if (ap) ap.addEventListener("click", async () => {
      try { await api("/api/policy-exceptions/" + id + "/executive-approval", { method: "POST", body: {} }); close(); render(); }
      catch (err) { alert(err.message); }
    });
    const rev = back.querySelector("#pex-rev-save");
    if (rev) rev.addEventListener("click", async () => {
      const el = back.querySelector("#pex-rev-res");
      try {
        await api("/api/policy-exceptions/" + id + "/revoke", { method: "POST", body: { reason: back.querySelector("#pex-rev").value } });
        close(); render();
      } catch (err) { el.textContent = err.message; }
    });
  }

  function onHash() {
    if (location.hash !== HASH) return;
    if (!shellReady()) { setTimeout(onHash, 250); return; }
    if (!canSee()) { location.hash = "#/dashboard"; return; }
    render();
    // The shell's router falls through to the dashboard for hashes it does not
    // know, and repaints over this view a beat after it is drawn. The marker
    // tells us it happened.
    [120, 400, 900].forEach((ms) => setTimeout(() => {
      const m = document.getElementById("view-mount");
      if (location.hash === HASH && m && m.dataset.pcr !== "1") render();
    }, ms));
  }
  function boot() {
    [200, 700, 1500, 3000].forEach((ms) => setTimeout(injectNav, ms));
    new MutationObserver(injectNav).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", onHash);
    if (location.hash === HASH) onHash();
  }
  boot();
})();
