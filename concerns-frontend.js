// concerns-frontend.js -- Report a Concern (progressive-enhancement).
//
// Two screens behind one route, and which one you get is decided by the
// server, never by anything the browser asserts about itself:
//
//   EVERYONE gets the form. Raising a concern is a normal act available to
//   every member of staff, including about leadership.
//
//   REVIEWERS also get the Concern Review Dashboard -- its own screen, not a
//   section of anybody else's. It is never linked from a dashboard tile, an
//   activity feed or a search result, because the spec rules those out and
//   because the existence of a concern is itself confidential.
//
// The one thing this file must get right on its own is NOT OFFERING WHAT THE
// SERVER WILL REFUSE: a reviewer named in a report is excluded from it at the
// API, so showing them a row they cannot open would tell them a concern about
// them exists. The list simply does not contain it, and the screen says only
// that a number of reports are not being shown to them, with no content.
(function () {
  "use strict";
  const HASH = "#/concerns";
  const ACCENT = "#0f766e";

  // Everyone signed in may raise one. There is no module switch for that --
  // taking away somebody's ability to report a concern is not a setting this
  // should offer.
  function canSee() {
    return typeof state !== "undefined" && !!state.user && !!state.user.id;
  }
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
  function statusColor(s) {
    return { "New": "#dc2626", "Received": "#6366f1", "Under Review": "#0891b2",
      "Additional Information Needed": "#ca8a04", "Investigation/Review In Progress": "#7c3aed",
      "Action Required": "#ea580c", "Resolved": "#16a34a", "Closed": "#64748b" }[s] || "#64748b";
  }
  const pill = (s) => '<span style="display:inline-block;background:' + statusColor(s) + ';color:#fff;font-weight:700;font-size:11.5px;padding:3px 10px;border-radius:20px;">' + esc(s) + "</span>";

  let opts = null, tab = null;

  function injectNav() {
    if (!canSee()) return;
    const nav = document.querySelector(".sidebar nav");
    if (!nav || document.getElementById("concern-nav-btn")) return;
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.id = "concern-nav-btn";
    btn.dataset.nav = "concerns";
    btn.innerHTML = "Report a Concern";
    const sib = nav.querySelector('[data-nav="supply"]') || nav.querySelector(".nav-item");
    if (sib) btn.draggable = sib.draggable;
    btn.addEventListener("click", () => { location.hash = HASH; });
    nav.appendChild(btn);
    if (typeof window.__navPlace === "function") window.__navPlace(btn);
  }

  function modal(inner, width) {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = '<div class="modal" style="max-width:' + (width || 720) + 'px;">' + inner + "</div>";
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
    try { opts = await api("/api/concerns/options"); }
    catch (e) { mount.innerHTML = '<div style="padding:40px;color:#a3282e;">' + esc(e.message) + "</div>"; return; }
    mount.dataset.concern = "1";
    if (tab === null) tab = opts.can_review ? "review" : "raise";

    const tabs = !opts.can_review ? "" :
      '<div style="display:flex;gap:6px;border-bottom:1px solid #e6e1d4;margin-bottom:0;">' +
        ['<button class="cn-tab" data-t="review" style="border:0;background:none;padding:9px 14px;font-size:13.5px;font-weight:700;cursor:pointer;color:' + (tab === "review" ? ACCENT : "#767488") + ';border-bottom:2px solid ' + (tab === "review" ? ACCENT : "transparent") + ';">Concern Review Dashboard</button>',
         '<button class="cn-tab" data-t="raise" style="border:0;background:none;padding:9px 14px;font-size:13.5px;font-weight:700;cursor:pointer;color:' + (tab === "raise" ? ACCENT : "#767488") + ';border-bottom:2px solid ' + (tab === "raise" ? ACCENT : "transparent") + ';">Raise a concern</button>'].join("") +
      "</div>";

    let body;
    try { body = tab === "review" && opts.can_review ? await reviewHtml() : raiseHtml(); }
    catch (e) { body = '<div style="padding:40px;color:#a3282e;">' + esc(e.message) + "</div>"; }

    mount.innerHTML =
      '<div style="padding:24px 28px 0;max-width:1060px;">' +
        '<h1 style="font-size:24px;margin:0;font-weight:800;color:' + ACCENT + ';">Report a Concern</h1>' +
        '<p style="margin:8px 0 14px;color:#767488;font-size:13.5px;max-width:760px;">' + esc(opts.intro || "") + "</p>" +
        tabs +
      "</div>" + body;

    mount.querySelectorAll(".cn-tab").forEach((b) => b.addEventListener("click", () => { tab = b.getAttribute("data-t"); render(); }));
    wire(mount);
  }

  // ---------- raising one ----------
  function raiseHtml() {
    const types = (opts.types || []).map((t) => "<option>" + esc(t) + "</option>").join("");
    const staff = (opts.staff || []).map((s) => '<option value="' + s.employee_id + '">' + esc(s.name) + "</option>").join("");
    const wit = (opts.witness_answers || []).map((w) => "<option>" + esc(w) + "</option>").join("");
    return '<div style="padding:18px 28px 60px;max-width:760px;">' +
      '<div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:13px;color:#312e81;line-height:1.55;">' +
        esc(opts.non_retaliation || "") + "</div>" +
      '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:13px;color:#92400e;line-height:1.55;">' +
        esc(opts.not_an_accusation || "") + "</div>" +

      '<div class="field"><label>How do you want to send this?</label>' +
        '<div style="display:flex;flex-direction:column;gap:6px;">' +
          '<label style="display:flex;gap:8px;align-items:flex-start;border:1px solid #e6e1d4;border-radius:10px;padding:10px 12px;cursor:pointer;">' +
            '<input type="radio" name="cn-mode" value="named" checked />' +
            '<span><b style="display:block;font-size:13.5px;">Submit with my name</b>' +
            '<span style="font-size:12.5px;color:#767488;">Your name is on the report and may be part of the review.</span></span></label>' +
          '<label style="display:flex;gap:8px;align-items:flex-start;border:1px solid #e6e1d4;border-radius:10px;padding:10px 12px;cursor:pointer;">' +
            '<input type="radio" name="cn-mode" value="confidential" />' +
            '<span><b style="display:block;font-size:13.5px;">Submit confidentially</b>' +
            '<span style="font-size:12.5px;color:#767488;">Your name is recorded and visible only to the people who review concerns. It is not shared more widely.</span></span></label>' +
        "</div>" +
        // THE HONEST BIT. There is no "anonymous" radio here, because inside
        // the CRM the request carries a session and the server knows who sent
        // it. Offering the word would be a promise the system cannot keep to
        // somebody taking a risk by reporting.
        '<div style="background:#faf9f5;border:1px solid #e6e1d4;border-radius:10px;padding:10px 12px;margin-top:8px;font-size:12.5px;color:#767488;line-height:1.55;">' +
          '<b>Want to be anonymous?</b> Signed in, your session identifies you to the server whether or not your name is stored — so this page does not offer anonymity it cannot deliver. ' +
          'Use the open page instead: <a href="/report-concern" target="_blank" rel="noopener" id="cn-anon-link">crm.spectrumsquadlv.com/report-concern</a>. It carries no sign-in, and an anonymous report there records nothing identifying you at all.' +
        "</div></div>" +

      '<div class="field"><label>Type of concern</label><select id="cn-type"><option value="">— choose —</option>' + types + "</select></div>" +
      '<div class="field" id="cn-other-wrap" style="display:none;"><label>Describe the type</label><input id="cn-other" /></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
        '<div class="field" style="flex:1;min-width:150px;"><label>Date of incident</label><input type="date" id="cn-date" /></div>' +
        '<div class="field" style="flex:1;min-width:150px;"><label>Approximate time</label><input type="time" id="cn-time" /></div>' +
        '<div class="field" style="flex:2;min-width:180px;"><label>Location</label><input id="cn-loc" placeholder="Clinic, in-home, telehealth, other" /></div>' +
      "</div>" +
      '<div class="field"><label>Person(s) involved</label>' +
        '<select id="cn-staff"><option value="">— choose from staff —</option>' + staff + "</select>" +
        '<div id="cn-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;"></div>' +
        '<div style="font-size:11.5px;color:#8a8797;margin-top:6px;">Choosing someone from the staff list is what keeps the report away from them — a name typed in free text cannot be matched to an account.</div>' +
      "</div>" +
      '<div class="field"><label>Anyone else involved (not staff, or not listed)</label><input id="cn-people-text" /></div>' +
      '<div class="field"><label>What did you observe?</label><textarea id="cn-desc" rows="5"></textarea></div>' +
      '<div class="field"><label>Policy or procedure involved, if you know it</label><input id="cn-policy" /></div>' +
      '<div class="field"><label>Were there witnesses?</label><select id="cn-wit"><option value="">— choose —</option>' + wit + "</select></div>" +
      '<div class="field" id="cn-wit-wrap" style="display:none;"><label>Who witnessed it?</label><input id="cn-wit-who" /></div>' +
      '<div class="field"><label>Was this reported previously?</label><select id="cn-prev"><option value="no">No</option><option value="yes">Yes</option></select></div>' +
      '<div class="field" id="cn-prev-wrap" style="display:none;"><label>To whom, and when?</label><input id="cn-prev-detail" /></div>' +
      '<div class="field"><label>Anything else we should know</label><textarea id="cn-more" rows="2"></textarea></div>' +
      '<div><button class="btn" id="cn-send">Submit concern</button> <span id="cn-res" style="font-size:12.5px;color:var(--text-muted);"></span></div>' +
      "</div>";
  }

  // ---------- the restricted dashboard ----------
  async function reviewHtml() {
    const d = await api("/api/concerns");
    const tile = (label, n, color) =>
      '<div style="flex:1;min-width:130px;background:#fff;border:1px solid #e6e1d4;border-left:3px solid ' + color + ';border-radius:10px;padding:12px 14px;">' +
        '<div style="font-size:22px;font-weight:800;color:' + color + ';">' + n + "</div>" +
        '<div style="font-size:11.5px;color:#767488;font-weight:600;">' + esc(label) + "</div></div>";
    const c = d.counts || {};

    const rows = (d.reports || []).map((r) => {
      const who = r.reporting_mode === "anonymous" ? "Anonymous"
        : (r.reporting_mode === "confidential" ? (r.reporter && r.reporter.name ? r.reporter.name + " (confidential)" : "Confidential") : (r.reporter && r.reporter.name) || "—");
      return '<tr class="cn-row" data-id="' + r.id + '" style="cursor:pointer;border-bottom:1px solid #f0ede3;">' +
        '<td style="padding:10px 12px;"><div style="font-weight:700;">' + esc(r.concern_type) + "</div>" +
          '<div style="font-size:11.5px;color:#8a8797;">' + esc(r.reference_code) + " · " + esc((r.description || "").slice(0, 60)) + "…</div></td>" +
        '<td style="padding:10px 12px;font-size:13px;">' + esc(who) + "</td>" +
        '<td style="padding:10px 12px;font-size:13px;">' + esc((r.involved || []).map((p) => p.name).join(", ") || "—") + "</td>" +
        '<td style="padding:10px 12px;color:#8a8797;font-size:12.5px;">' + fmt(r.created_at) + "</td>" +
        '<td style="padding:10px 12px;font-size:13px;">' + esc(r.assigned_reviewer_name || "—") + "</td>" +
        '<td style="padding:10px 12px;">' + pill(r.status) +
          (r.open && r.unconflicted_reviewers === 0 ? '<div style="font-size:11px;color:#dc2626;font-weight:700;margin-top:3px;">No unconflicted reviewer</div>' : "") +
        "</td></tr>";
    }).join("") || '<tr><td colspan="6" style="padding:24px;text-align:center;color:#8a8797;">No concerns.</td></tr>';

    // Told, not hidden. Somebody who is named in a report should know one
    // exists that is not being shown to them -- that is a different thing from
    // showing it to them, and pretending there is nothing there would be its
    // own kind of dishonesty.
    const hidden = d.hidden_from_you
      ? '<div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:12.5px;color:#312e81;">' +
          "<b>" + d.hidden_from_you + " concern" + (d.hidden_from_you === 1 ? " is" : "s are") + " not shown to you.</b> " +
          "You are named in " + (d.hidden_from_you === 1 ? "it" : "them") + ", so " + (d.hidden_from_you === 1 ? "it is" : "they are") +
          " withheld. Executive leadership can authorize access where there is a reason to." +
        "</div>"
      : "";

    return '<div style="padding:18px 28px 60px;max-width:1060px;">' +
      hidden +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">' +
        tile("Open", c.open || 0, "#0891b2") +
        tile("New", c.new || 0, "#dc2626") +
        tile("Unassigned", c.unassigned || 0, "#ca8a04") +
        tile("Action required", c.action_required || 0, "#ea580c") +
        tile("No unconflicted reviewer", c.no_reviewer || 0, "#7c3aed") +
      "</div>" +
      '<div style="background:#fff;border:1px solid #e6e1d4;border-radius:12px;overflow:hidden;">' +
        '<table style="width:100%;border-collapse:collapse;font-size:13.5px;"><thead><tr style="background:#faf9f5;text-align:left;color:#767488;font-size:12px;">' +
          '<th style="padding:10px 12px;">Concern</th><th style="padding:10px 12px;">Reported by</th>' +
          '<th style="padding:10px 12px;">Named</th><th style="padding:10px 12px;">Submitted</th>' +
          '<th style="padding:10px 12px;">Reviewer</th><th style="padding:10px 12px;">Status</th>' +
        "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  function wire(mount) {
    mount.querySelectorAll(".cn-row").forEach((el) => el.addEventListener("click", () => openReport(el.getAttribute("data-id"))));

    const typeSel = mount.querySelector("#cn-type");
    if (typeSel) typeSel.addEventListener("change", () => {
      mount.querySelector("#cn-other-wrap").style.display = typeSel.value === "Other" ? "" : "none";
    });
    const witSel = mount.querySelector("#cn-wit");
    if (witSel) witSel.addEventListener("change", () => {
      mount.querySelector("#cn-wit-wrap").style.display = witSel.value === "Yes" ? "" : "none";
    });
    const prevSel = mount.querySelector("#cn-prev");
    if (prevSel) prevSel.addEventListener("change", () => {
      mount.querySelector("#cn-prev-wrap").style.display = prevSel.value === "yes" ? "" : "none";
    });

    const staffSel = mount.querySelector("#cn-staff");
    if (staffSel) {
      const people = [];
      const draw = () => {
        const box = mount.querySelector("#cn-chips");
        box.innerHTML = people.map((p, i) =>
          '<span style="background:#ccfbf1;border:1px solid #5eead4;color:#115e59;border-radius:999px;padding:4px 10px;font-size:12.5px;">' +
          esc(p.name) + ' <button data-i="' + i + '" style="all:unset;cursor:pointer;font-weight:800;">×</button></span>').join("");
        box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
          people.splice(Number(b.getAttribute("data-i")), 1); draw();
        }));
      };
      staffSel.addEventListener("change", () => {
        if (!staffSel.value) return;
        const id = Number(staffSel.value), name = staffSel.options[staffSel.selectedIndex].text;
        if (!people.some((p) => p.employee_id === id)) people.push({ employee_id: id, name });
        staffSel.value = ""; draw();
      });
      const send = mount.querySelector("#cn-send");
      if (send) send.addEventListener("click", async () => {
        const res = mount.querySelector("#cn-res");
        const type = mount.querySelector("#cn-type").value;
        const desc = mount.querySelector("#cn-desc").value.trim();
        if (!type) { res.textContent = "Choose what kind of concern this is."; return; }
        if (!desc) { res.textContent = "Describe what you observed."; return; }
        send.disabled = true; res.textContent = "Submitting…";
        try {
          const modeEl = mount.querySelector('input[name="cn-mode"]:checked');
          const d = await api("/api/concerns", { method: "POST", body: {
            reporting_mode: modeEl ? modeEl.value : "named",
            concern_type: type, concern_type_other: mount.querySelector("#cn-other").value,
            incident_date: mount.querySelector("#cn-date").value,
            incident_time: mount.querySelector("#cn-time").value,
            location: mount.querySelector("#cn-loc").value,
            people_involved: people, people_text: mount.querySelector("#cn-people-text").value,
            description: desc, policy_text: mount.querySelector("#cn-policy").value,
            witnesses_present: mount.querySelector("#cn-wit").value,
            witnesses_text: mount.querySelector("#cn-wit-who").value,
            reported_previously: mount.querySelector("#cn-prev").value === "yes",
            reported_previously_detail: mount.querySelector("#cn-prev-detail").value,
            additional_info: mount.querySelector("#cn-more").value,
          } });
          submitted(d);
        } catch (e) { send.disabled = false; res.textContent = e.message || "Could not submit."; }
      });
    }
  }

  function submitted(d) {
    modal(
      '<div class="modal-header"><div><h2>Your concern has been submitted</h2></div><button class="close-btn">✕</button></div>' +
      '<p style="font-size:13.5px;color:#767488;">' +
        (d.reporting_mode === "confidential"
          ? "Your name was recorded and is visible only to the people who review concerns."
          : "Your name is on the report.") + "</p>" +
      '<div style="font-family:ui-monospace,Menlo,monospace;font-size:20px;font-weight:800;background:#f0fdfa;border:2px dashed #0f766e;border-radius:10px;padding:14px;text-align:center;color:#115e59;user-select:all;margin:12px 0;">' +
        esc(d.reference_code) + "</div>" +
      '<p style="font-size:12.5px;color:#767488;">Keep this reference if you want to check the status.</p>' +
      '<div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:10px 12px;font-size:12.5px;color:#312e81;line-height:1.55;">' +
        esc((opts && opts.non_retaliation) || "") + "</div>",
      520
    );
    render();
  }

  // ---------- reading one ----------
  async function openReport(id) {
    let r;
    try { r = await api("/api/concerns/" + id); } catch (e) { alert(e.message); return; }
    const row = (k, v) => v ? '<div style="margin-bottom:8px;"><div style="font-size:11px;color:#8a8797;font-weight:700;text-transform:uppercase;">' + esc(k) + "</div><div style=\"font-size:13.5px;white-space:pre-wrap;\">" + esc(v) + "</div></div>" : "";
    const hist = (r.history || []).map((h) =>
      '<li style="margin-bottom:6px;font-size:12.5px;color:#555;"><b>' + esc(h.action.replace(/_/g, " ")) + "</b> — " +
      esc(h.actor_name || "system") + " · " + fmtT(h.created_at) +
      (h.note ? '<div style="color:#767488;">' + esc(h.note) + "</div>" : "") + "</li>").join("");

    const named = (r.involved || []).map((p) =>
      '<span style="background:#ccfbf1;border:1px solid #5eead4;color:#115e59;border-radius:999px;padding:4px 10px;font-size:12.5px;margin:0 4px 4px 0;display:inline-block;">' +
      esc(p.name || "—") +
      // Said rather than assumed: somebody with no login cannot be excluded by
      // the matcher, and a reviewer should know which names the lock covers.
      (p.matchable ? "" : ' <span style="color:#a56b00;" title="No CRM login — the access exclusion cannot match this person">⚠</span>') +
      "</span>").join("") || '<span style="color:#8a8797;font-size:13px;">—</span>';

    const statusOpts = (opts.statuses || []).map((s) => '<option' + (s === r.status ? " selected" : "") + ">" + esc(s) + "</option>").join("");

    const { back, close } = modal(
      '<div class="modal-header"><div><h2>' + esc(r.concern_type) + "</h2>" +
        '<div style="font-size:12.5px;color:#767488;">' + esc(r.reference_code) + " · submitted " + fmt(r.created_at) + "</div></div>" +
        '<button class="close-btn">✕</button></div>' +
      '<div style="margin-bottom:10px;">' + pill(r.status) +
        (r.confidential ? ' <span style="background:#eef2ff;border:1px solid #c7d2fe;color:#312e81;border-radius:20px;padding:3px 10px;font-size:11.5px;font-weight:700;">Confidential — do not disclose the reporter</span>' : "") +
        (r.reporting_mode === "anonymous" ? ' <span style="background:#f3f4f6;border:1px solid #d1d5db;color:#374151;border-radius:20px;padding:3px 10px;font-size:11.5px;font-weight:700;">Anonymous — no identity was recorded</span>' : "") +
      "</div>" +
      (r.open && r.unconflicted_reviewers === 0
        ? '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12.5px;color:#991b1b;"><b>No unconflicted reviewer.</b> Everyone who can review concerns is named in this one. Somebody not named has to be given the permission before this can be handled properly.</div>'
        : "") +
      row("Reported by", r.reporting_mode === "anonymous" ? "Anonymous" : ((r.reporter && r.reporter.name) || "—")) +
      '<div style="margin-bottom:8px;"><div style="font-size:11px;color:#8a8797;font-weight:700;text-transform:uppercase;">Person(s) involved</div><div style="margin-top:4px;">' + named + "</div></div>" +
      row("Others named (free text)", r.people_text) +
      row("When", [r.incident_date, r.incident_time].filter(Boolean).join(" ")) +
      row("Where", r.location) +
      row("What was observed", r.description) +
      row("Policy or procedure involved", r.policy_text) +
      row("Witnesses", [r.witnesses_present, r.witnesses_text].filter(Boolean).join(" — ")) +
      row("Reported previously", r.reported_previously ? (r.reported_previously_detail || "Yes") : "No") +
      row("Additional information", r.additional_info) +

      '<div style="border-top:1px solid #e6e1d4;margin-top:14px;padding-top:12px;">' +
        '<div style="font-weight:800;font-size:14px;margin-bottom:8px;">The review</div>' +
        '<div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px;">' +
          '<div class="field" style="margin:0;flex:1;min-width:200px;"><label>Status</label><select id="cn-status">' + statusOpts + "</select></div>" +
          '<button class="btn small secondary" id="cn-status-save">Update</button>' +
          '<span id="cn-status-res" style="font-size:12px;color:var(--text-muted);"></span>' +
        "</div>" +
        '<div class="field"><label>Assigned reviewer</label><select id="cn-assign"><option value="">— choose —</option></select>' +
          '<div style="font-size:11.5px;color:#8a8797;margin-top:4px;">Only people who can review concerns and are not named in this one are listed.</div></div>' +
        '<div class="field"><label>Review notes</label><textarea id="cn-notes" rows="3">' + esc(r.review_notes || "") + "</textarea></div>" +
        '<div class="field"><label>Applicable policy</label><input id="cn-apol" value="' + esc(r.applicable_policy_text || "") + '" /></div>' +
        '<div class="field"><label>Findings</label><textarea id="cn-find" rows="3">' + esc(r.findings || "") + "</textarea></div>" +
        '<div class="field"><label>Corrective action</label><textarea id="cn-corr" rows="2">' + esc(r.corrective_action || "") + "</textarea></div>" +
        '<label style="display:block;font-size:13px;margin-bottom:6px;"><input type="checkbox" id="cn-follow"' + (r.follow_up_required ? " checked" : "") + ' /> Follow up required</label>' +
        '<div class="field"><label>Follow-up detail</label><input id="cn-follow-d" value="' + esc(r.follow_up_detail || "") + '" /></div>' +
        '<div class="field"><label>Resolution</label><textarea id="cn-resolution" rows="2">' + esc(r.resolution || "") + "</textarea></div>" +
        '<button class="btn" id="cn-review-save">Save the review record</button> <span id="cn-review-res" style="font-size:12px;color:var(--text-muted);"></span>' +
      "</div>" +

      '<div style="border-top:1px solid #e6e1d4;margin-top:14px;padding-top:12px;">' +
        '<div style="font-weight:800;font-size:14px;margin-bottom:6px;">People interviewed</div>' +
        '<div style="font-size:12.5px;color:#767488;margin-bottom:8px;">' +
          ((r.interviewed || []).map((p) => esc(p.name || "—")).join(", ") || "Nobody recorded yet.") + "</div>" +
        '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">' +
          '<div class="field" style="margin:0;flex:1;min-width:160px;"><label>Add somebody</label><select id="cn-interview">' +
            '<option value="">— choose from staff —</option>' +
            (opts.staff || []).map((s) => '<option value="' + s.employee_id + '">' + esc(s.name) + "</option>").join("") +
          "</select></div>" +
          '<button class="btn small secondary" id="cn-interview-add">Record</button>' +
          '<span id="cn-interview-res" style="font-size:12px;color:var(--text-muted);"></span>' +
        "</div>" +
        '<div style="font-size:11.5px;color:#8a8797;margin-top:6px;">Somebody interviewed about a concern is also excluded from reading it.</div>' +
      "</div>" +

      (hist ? '<details style="margin-top:14px;" open><summary style="cursor:pointer;font-size:13px;font-weight:700;">Audit trail — including every time this was opened</summary><ul style="padding-left:18px;margin:8px 0 0;">' + hist + "</ul></details>" : ""),
      780
    );

    // The reviewer picker is filled from the server's own list, filtered the
    // same way the access rule filters: never offer somebody the assign
    // endpoint will refuse.
    (async () => {
      try {
        const people = await api("/api/concerns/reviewers?report_id=" + id);
        const sel = back.querySelector("#cn-assign");
        (people.reviewers || []).forEach((p) => {
          const o = document.createElement("option");
          o.value = p.id; o.textContent = p.name || p.email;
          if (r.assigned_reviewer_user_id === p.id) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener("change", async () => {
          if (!sel.value) return;
          try { await api("/api/concerns/" + id + "/assign", { method: "POST", body: { user_id: Number(sel.value) } }); render(); }
          catch (e) { alert(e.message); }
        });
      } catch (e) { /* the picker simply stays empty */ }
    })();

    back.querySelector("#cn-status-save").addEventListener("click", async () => {
      const el = back.querySelector("#cn-status-res");
      try {
        await api("/api/concerns/" + id + "/status", { method: "POST", body: {
          status: back.querySelector("#cn-status").value,
          resolution: back.querySelector("#cn-resolution").value,
        } });
        el.textContent = "Saved ✓"; render();
      } catch (e) { el.textContent = e.message; }
    });

    back.querySelector("#cn-review-save").addEventListener("click", async () => {
      const el = back.querySelector("#cn-review-res");
      try {
        await api("/api/concerns/" + id + "/review", { method: "PATCH", body: {
          review_notes: back.querySelector("#cn-notes").value,
          applicable_policy_text: back.querySelector("#cn-apol").value,
          findings: back.querySelector("#cn-find").value,
          corrective_action: back.querySelector("#cn-corr").value,
          follow_up_required: back.querySelector("#cn-follow").checked,
          follow_up_detail: back.querySelector("#cn-follow-d").value,
          resolution: back.querySelector("#cn-resolution").value,
        } });
        el.textContent = "Saved ✓";
      } catch (e) { el.textContent = e.message; }
    });

    back.querySelector("#cn-interview-add").addEventListener("click", async () => {
      const sel = back.querySelector("#cn-interview");
      const el = back.querySelector("#cn-interview-res");
      if (!sel.value) { el.textContent = "Choose somebody."; return; }
      try {
        await api("/api/concerns/" + id + "/interviews", { method: "POST", body: { employee_id: Number(sel.value) } });
        close(); openReport(id);
      } catch (e) { el.textContent = e.message; }
    });
  }

  function onHash() {
    if (location.hash !== HASH) return;
    if (!shellReady()) { setTimeout(onHash, 250); return; }
    if (!canSee()) { location.hash = "#/dashboard"; return; }
    render();
    [120, 400, 900].forEach((ms) => setTimeout(() => {
      const m = document.getElementById("view-mount");
      if (location.hash === HASH && m && m.dataset.concern !== "1") render();
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
