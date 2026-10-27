// peer-review-frontend.js -- Peer Reviews, the leadership screen.
//
// Runs a review cycle from start to finish:
//   1. Sections   put each person in exactly one section (or leave them out)
//   2. Survey     send everyone their private link, chase the stragglers
//   3. Approve    read each person's combined scores, review their comments
//   4. Send       one results email per person, never two
//
// Staff never come here. They fill in the survey and read their report on
// private-link pages (peer-review-survey.html, peer-review-report.html),
// because most of them have no CRM login.
//
// Everything sensitive is decided by the server: this screen draws what
// /api/peer-review answers and nothing else. In particular, when the person
// running the cycle is themselves in it, the server sends their own row
// without scores or comments, and this screen just says so.
(function () {
  "use strict";
  const HASH = "#/peer-review";
  const NAVY = "#1b2a6b";
  const SECTION_ORDER = ["rbt", "squad_leader", "admin"];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, { method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "Request failed");
    return d;
  }
  const fmt = (s) => { if (!s) return ""; const d = new Date(s.length === 10 ? s + "T12:00:00" : s); return isNaN(d) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
  const two = (n) => (n == null ? "—" : Number(n).toFixed(2));
  const pill = (txt, bg, fg) => '<span style="display:inline-block;background:' + bg + ";color:" + (fg || "#fff") + ';font-weight:700;font-size:11.5px;padding:3px 10px;border-radius:20px;">' + esc(txt) + "</span>";
  const STATUS = { draft: ["Setting up", "#64748b"], open: ["Survey open", "#0891b2"], closed: ["Closed", NAVY] };

  let opts = null;
  let cycleId = null;
  let filter = "all";

  async function render() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    mount.dataset.peer = "1";
    mount.innerHTML = '<div style="padding:40px;color:#767488;">Loading…</div>';
    try { if (!opts) opts = await api("/api/peer-review/options"); }
    catch (e) { mount.innerHTML = '<div style="padding:40px;color:#a3282e;">' + esc(e.message) + "</div>"; return; }
    if (cycleId) return renderCycle(mount);
    return renderList(mount);
  }

  // ------------------------------------------------------------------ list
  async function renderList(mount) {
    let d;
    try { d = await api("/api/peer-review/cycles"); }
    catch (e) { mount.innerHTML = '<div style="padding:40px;color:#a3282e;">' + esc(e.message) + "</div>"; return; }
    mount.innerHTML =
      '<div class="page-header"><div><h1 style="margin:0;">Peer Reviews</h1>' +
      '<div style="color:var(--text-muted);font-size:13.5px;">Peer Performance Consensus Reports: everyone rates their coworkers, and each person gets one combined report.</div></div></div>' +
      '<div class="card" style="padding:16px 18px;margin-bottom:14px;"><div style="font-weight:700;margin-bottom:8px;">Start a review cycle</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;">' +
        '<div class="field" style="margin:0;flex:1;min-width:180px;"><label>Name</label><input id="pr-new-name" placeholder="Q4 2026" /></div>' +
        '<div class="field" style="margin:0;"><label>Finish by</label><input id="pr-new-date" type="date" /></div>' +
        '<button class="btn" id="pr-new">Create</button><span id="pr-new-res" style="font-size:12.5px;color:#a3282e;"></span>' +
      "</div></div>" +
      (d.cycles.length ? d.cycles.map((c) =>
        '<div class="card" data-cycle="' + c.id + '" style="padding:14px 18px;margin-bottom:10px;cursor:pointer;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">' +
          '<div style="flex:1;min-width:180px;"><div style="font-weight:700;font-size:15px;">' + esc(c.name) + "</div>" +
          '<div style="font-size:12.5px;color:var(--text-muted);">' + c.assigned + " people · " + c.submitted + " submitted" +
          (c.status === "closed" ? " · " + c.sent + " reports sent" : "") + (c.closes_on ? " · finish by " + fmt(c.closes_on) : "") + "</div></div>" +
          pill(STATUS[c.status][0], STATUS[c.status][1]) + "</div>").join("")
        : '<div style="color:var(--text-muted);padding:10px 2px;">No review cycles yet.</div>');

    mount.querySelector("#pr-new").addEventListener("click", async () => {
      const el = mount.querySelector("#pr-new-res");
      try {
        const c = await api("/api/peer-review/cycles", { method: "POST", body: {
          name: mount.querySelector("#pr-new-name").value, closes_on: mount.querySelector("#pr-new-date").value } });
        cycleId = c.id; render();
      } catch (e) { el.textContent = e.message; }
    });
    mount.querySelectorAll("[data-cycle]").forEach((n) => n.addEventListener("click", () => { cycleId = Number(n.dataset.cycle); render(); }));
  }

  // ----------------------------------------------------------------- cycle
  function steps(status) {
    const at = { draft: 0, open: 1, closed: 2 }[status];
    return '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 16px;">' +
      ["1. Sections", "2. Survey", "3. Review & approve", "4. Send reports"].map((s, i) => {
        const on = i === at || (at === 2 && i === 3);
        return '<span style="font-size:12.5px;font-weight:700;padding:5px 12px;border-radius:99px;background:' + (on ? NAVY : i < at ? "#dbeafe" : "#f1f5f9") + ";color:" + (on ? "#fff" : i < at ? NAVY : "#64748b") + ';">' + s + "</span>";
      }).join("") + "</div>";
  }

  async function renderCycle(mount) {
    let d;
    try { d = await api("/api/peer-review/cycles/" + cycleId); }
    catch (e) { mount.innerHTML = '<div style="padding:40px;color:#a3282e;">' + esc(e.message) + "</div>"; return; }
    const c = d.cycle;
    let h = '<button class="btn small secondary" id="pr-back" style="margin-bottom:10px;">← All review cycles</button>' +
      '<div class="page-header"><div><h1 style="margin:0;">' + esc(c.name) + " " + pill(STATUS[c.status][0], STATUS[c.status][1]) + "</h1>" +
      '<div style="color:var(--text-muted);font-size:13.5px;">' + d.progress.assigned + " people in this review" +
      (c.closes_on ? " · finish by " + fmt(c.closes_on) : "") + "</div></div></div>" + steps(c.status);

    if (c.status === "draft" || c.status === "open") h += await rosterBlock(c);
    if (c.status === "open") h += progressBlock(d);
    if (c.status === "closed") h += resultsBlock(d);
    mount.innerHTML = h;
    mount.querySelector("#pr-back").addEventListener("click", () => { cycleId = null; render(); });
    wireCycle(mount, d);
  }

  async function rosterBlock(c) {
    const r = await api("/api/peer-review/cycles/" + c.id + "/roster");
    const locked = c.status === "open";
    const options = (row) => {
      const cur = row.section || (locked ? "" : row.suggested || "");
      return '<select data-emp="' + row.employee_id + '"' + (locked && row.section ? " disabled" : "") + ' style="min-width:150px;">' +
        '<option value="">Not included</option>' +
        SECTION_ORDER.map((k) => '<option value="' + k + '"' + (cur === k ? " selected" : "") + ">" + esc(opts.sections[k].label) + "</option>").join("") + "</select>";
    };
    const counts = {};
    r.roster.forEach((x) => { const s = x.section || (locked ? "" : x.suggested || ""); if (s) counts[s] = (counts[s] || 0) + 1; });
    return '<div class="card" style="padding:16px 18px;margin-bottom:14px;">' +
      '<div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;align-items:center;">' +
        '<div><div style="font-weight:700;">' + (locked ? "Who's in this review" : "Put each person in one section") + "</div>" +
        '<div style="font-size:12.5px;color:var(--text-muted);">' + (locked ? "Sections are locked now that the survey is open. You can still add people." :
          "Each person is rated in exactly one section. Guesses from job titles are filled in for you, so check them before saving.") + "</div></div>" +
        '<div style="font-size:12.5px;color:var(--text-muted);">' + SECTION_ORDER.map((k) => esc(opts.sections[k].label) + ": <b>" + (counts[k] || 0) + "</b>").join(" · ") + "</div>" +
      "</div>" +
      '<div style="max-height:420px;overflow:auto;margin-top:10px;border-top:1px solid var(--border,#e6e1d4);">' +
      r.roster.map((x) => '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #f1eee6;">' +
        '<div style="flex:1;min-width:160px;"><div style="font-weight:600;">' + esc(x.name) + "</div>" +
        '<div style="font-size:12px;color:var(--text-muted);">' + esc(x.role_title || "No job title") + (x.email ? "" : ' · <span style="color:#a3282e;">no email on file</span>') +
        (!x.section && x.suggested && !locked ? ' · <span style="color:#b45309;">suggested</span>' : "") + "</div></div>" + options(x) + "</div>").join("") +
      "</div>" +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:12px;">' +
        '<button class="btn secondary" id="pr-save">Save sections</button>' +
        (c.status === "draft" ? '<button class="btn" id="pr-open">Open survey and email links</button>' : '<button class="btn secondary" id="pr-invite">Email links to anyone new</button>') +
        '<span id="pr-roster-res" style="font-size:12.5px;"></span>' +
      "</div></div>";
  }

  function progressBlock(d) {
    const people = d.people.slice().sort((a, b) => (a.submitted_at ? 1 : 0) - (b.submitted_at ? 1 : 0));
    const waiting = people.filter((p) => !p.submitted_at).length;
    return '<div class="card" style="padding:16px 18px;margin-bottom:14px;">' +
      '<div style="font-weight:700;">' + d.progress.submitted + " of " + d.progress.assigned + " have submitted</div>" +
      '<div style="height:8px;background:#ece8dc;border-radius:99px;overflow:hidden;margin:8px 0 12px;"><div style="height:100%;width:' +
        (d.progress.assigned ? Math.round(d.progress.submitted / d.progress.assigned * 100) : 0) + '%;background:#e0a430;"></div></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + people.map((p) =>
        '<span style="font-size:12.5px;padding:4px 10px;border-radius:99px;background:' + (p.submitted_at ? "#dcfce7" : p.email ? "#fef3c7" : "#fee2e2") + ';">' +
        esc(p.name) + (p.submitted_at ? " · done" : p.email ? "" : " · no email") + "</span>").join("") + "</div>" +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:14px;">' +
        (waiting ? '<button class="btn secondary" id="pr-remind">Remind the ' + waiting + " who haven't finished</button>" : "") +
        '<button class="btn" id="pr-close">Close survey and calculate scores</button>' +
        '<span id="pr-prog-res" style="font-size:12.5px;"></span></div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:8px;">Closing locks every answer and calculates each person\'s combined scores once. It can\'t be undone.</div></div>';
  }

  function resultsBlock(d) {
    const ready = d.people.filter((p) => p.result && p.result.approved_at && !p.result.emailed_at).length;
    const sent = d.people.filter((p) => p.result && p.result.emailed_at).length;
    const pendingAll = d.people.reduce((n, p) => n + (p.pending_comments || 0), 0);
    let h = '<div class="card" style="padding:16px 18px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;">' +
      '<div style="flex:1;min-width:200px;"><div style="font-weight:700;">' + sent + " of " + d.people.length + " reports sent</div>" +
      '<div style="font-size:12.5px;color:var(--text-muted);">' + (pendingAll ? pendingAll + " comments still need review · " : "") + ready + " approved and ready to send</div></div>" +
      '<button class="btn" id="pr-send"' + (ready ? "" : " disabled") + ">Send " + ready + " report" + (ready === 1 ? "" : "s") + "</button>" +
      '<span id="pr-send-res" style="font-size:12.5px;width:100%;"></span></div>';

    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">' +
      [["all", "Everyone"], ["todo", "Needs approval"], ["ready", "Ready to send"], ["sent", "Sent"]].map(([k, l]) =>
        '<button class="btn small ' + (filter === k ? "" : "secondary") + '" data-filter="' + k + '">' + l + "</button>").join("") + "</div>";

    const show = d.people.filter((p) => {
      const r = p.result;
      if (filter === "todo") return r && !r.approved_at;
      if (filter === "ready") return r && r.approved_at && !r.emailed_at;
      if (filter === "sent") return r && r.emailed_at;
      return true;
    });
    h += show.map((p) => personCard(p, d)).join("") || '<div style="color:var(--text-muted);padding:8px;">Nobody here.</div>';

    if (d.general_comments.length) {
      h += '<div class="card" style="padding:16px 18px;margin-top:14px;"><div style="font-weight:700;">General feedback for leadership</div>' +
        '<div style="font-size:12.5px;color:var(--text-muted);margin-bottom:6px;">Not about a specific person. These never appear in anyone\'s report.</div>' +
        d.general_comments.map((g) => '<div style="padding:8px 0;border-top:1px solid #f1eee6;font-size:13.5px;">' + esc(g.body) + "</div>").join("") + "</div>";
    }
    return h;
  }

  function personCard(p, d) {
    const r = p.result;
    const head = '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">' +
      '<div style="flex:1;min-width:160px;"><div style="font-weight:700;font-size:15px;">' + esc(p.name) + "</div>" +
      '<div style="font-size:12px;color:var(--text-muted);">' + esc(p.section_label) + (r && !r.withheld_from_you ? " · " + r.reviewer_count + " reviewers" : "") + "</div></div>" +
      (r && r.emailed_at ? pill("Sent " + fmt(r.emailed_at), "#15803d") : r && r.approved_at ? pill("Approved", "#0891b2") : pill("Needs approval", "#b45309")) + "</div>";

    if (r && r.withheld_from_you) {
      return '<div class="card" style="padding:14px 18px;margin-bottom:10px;">' + head +
        '<div style="font-size:13px;color:var(--text-muted);margin-top:8px;">This is your own report, so your scores and comments are hidden here. ' +
        "Someone else approves it, and you'll get it by email like everyone else.</div>" + approverRow(p) + "</div>";
    }
    if (!r) return '<div class="card" style="padding:14px 18px;margin-bottom:10px;">' + head + "</div>";

    const comps = r.competencies.map((c) =>
      '<tr><td style="padding:5px 8px;">' + esc(c.label) + "</td>" +
      '<td style="padding:5px 8px;text-align:right;font-weight:700;">' + two(c.avg) + "</td>" +
      '<td style="padding:5px 8px;text-align:right;color:var(--text-muted);">' + c.n + "</td>" +
      '<td style="padding:5px 8px;text-align:right;color:var(--text-muted);">' + (c.n ? c.min + "–" + c.max : "—") + "</td>" +
      '<td style="padding:5px 8px;">' + (c.withheld ? pill("Hidden from employee", "#f1f5f9", "#475569") + " " : "") +
        (c.divided ? pill("Divided", "#fee2e2", "#b42318") : c.n >= 2 ? pill("Consistent", "#dcfce7", "#15803d") : "") + "</td></tr>").join("");

    const comments = p.comments.map((cm) => {
      const final = cm.status !== "pending";
      return '<div style="padding:9px 0;border-top:1px solid #f1eee6;" data-comment="' + cm.id + '">' +
        '<div style="font-size:11.5px;font-weight:700;color:var(--text-muted);">' + esc(cm.kind_label) + (cm.competency_label ? " · " + esc(cm.competency_label) : "") + " " +
        (cm.status === "approved" ? pill("Approved", "#dcfce7", "#15803d") : cm.status === "rejected" ? pill("Not shown", "#f1f5f9", "#475569") : "") + "</div>" +
        (r.approved_at ? '<div style="font-size:13.5px;margin-top:3px;">' + esc(cm.approved_body || cm.body) + "</div>" :
          '<textarea data-cm-body="' + cm.id + '" style="width:100%;min-height:52px;margin-top:4px;font:inherit;font-size:13.5px;">' + esc(cm.approved_body || cm.body) + "</textarea>" +
          '<div style="display:flex;gap:8px;margin-top:4px;">' +
            '<button class="btn small" data-cm="' + cm.id + '" data-d="approve">' + (cm.status === "approved" ? "Save edit" : "Approve") + "</button>" +
            '<button class="btn small secondary" data-cm="' + cm.id + '" data-d="reject">' + (final && cm.status === "rejected" ? "Rejected" : "Don't show") + "</button></div>") +
        "</div>";
    }).join("");

    return '<div class="card" style="padding:14px 18px;margin-bottom:10px;">' + head +
      '<div style="display:flex;flex-wrap:wrap;gap:22px;margin:10px 0 6px;">' +
        '<div><div style="font-size:11.5px;color:var(--text-muted);">Employee sees</div><div style="font-size:24px;font-weight:800;color:' + NAVY + ';">' + two(r.overall) + "</div></div>" +
        (r.overall_all !== r.overall ? '<div><div style="font-size:11.5px;color:var(--text-muted);">All ratings (leadership)</div><div style="font-size:24px;font-weight:800;color:#64748b;">' + two(r.overall_all) + "</div></div>" : "") +
      "</div>" +
      '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="color:var(--text-muted);font-size:11.5px;text-align:left;">' +
        '<th style="padding:4px 8px;">Competency</th><th style="padding:4px 8px;text-align:right;">Avg</th><th style="padding:4px 8px;text-align:right;">Ratings</th><th style="padding:4px 8px;text-align:right;">Range</th><th></th></tr></thead><tbody>' + comps + "</tbody></table></div>" +
      (p.comments.length ? '<div style="margin-top:10px;font-weight:700;font-size:13.5px;">Written feedback (' + p.comments.length + ")" +
        (p.pending_comments ? ' <span style="color:#b45309;font-weight:600;">· ' + p.pending_comments + " to review</span>" : "") + "</div>" +
        '<div style="font-size:12px;color:var(--text-muted);">Edit out anything that could identify who wrote it before approving.</div>' + comments
        : '<div style="font-size:12.5px;color:var(--text-muted);margin-top:8px;">No written feedback.</div>') +
      approverRow(p) +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:12px;">' +
        (!r.approved_at ? (p.can_approve ? '<button class="btn" data-approve="' + r.id + '"' + (p.pending_comments ? ' disabled title="Review every comment first" style="opacity:.45;cursor:not-allowed;"' : "") + ">Approve report</button>" :
          '<span style="font-size:12.5px;color:var(--text-muted);">' + (p.section === "admin" && !p.approver_user_id ? "The owner approves Administration reports unless someone else is assigned." : "Waiting on " + esc(p.approver_name || "the approver") + ".") + "</span>") : "") +
        (r.emailed_at ? '<button class="btn small secondary" data-resend="' + r.id + '">Resend report</button>' : "") +
        '<span data-res="' + r.id + '" style="font-size:12.5px;"></span></div></div>';
  }

  let approverList = null;
  function approverRow(p) {
    if (p.result && p.result.approved_at) return "";
    const list = (approverList || []);
    return '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;font-size:12.5px;">' +
      '<span style="color:var(--text-muted);">Approver:</span><select data-approver="' + p.employee_id + '" style="min-width:170px;">' +
      '<option value="">' + (p.section === "admin" ? "Owner (default)" : "Anyone running reviews (default)") + "</option>" +
      list.map((u) => '<option value="' + u.id + '"' + (p.approver_user_id === u.id ? " selected" : "") + ">" + esc(u.name) + "</option>").join("") + "</select></div>";
  }

  function wireCycle(mount, d) {
    const say = (sel, txt, bad) => { const el = mount.querySelector(sel); if (el) { el.style.color = bad ? "#a3282e" : "#15803d"; el.textContent = txt; } };
    const collect = () => Array.from(mount.querySelectorAll("select[data-emp]")).filter((s) => !s.disabled)
      .map((s) => ({ employee_id: Number(s.dataset.emp), section: s.value || null }));
    const save = async () => api("/api/peer-review/cycles/" + cycleId + "/assignments", { method: "PUT", body: { assignments: collect() } });

    const on = (sel, fn) => { const el = mount.querySelector(sel); if (el) el.addEventListener("click", fn); };
    on("#pr-save", async () => { try { const r = await save(); say("#pr-roster-res", "Saved. " + r.roster_count + " people in this review."); } catch (e) { say("#pr-roster-res", e.message, true); } });
    on("#pr-open", async () => {
      if (!confirm("Open the survey and email everyone their private link?")) return;
      try {
        await save();
        const r = await api("/api/peer-review/cycles/" + cycleId + "/open", { method: "POST" });
        alert(r.invited + " links sent." + (r.missing_email.length ? "\n\nNo email on file for: " + r.missing_email.join(", ") + ". Add their email in the HR Hub, then use \"Email links to anyone new\"." : ""));
        render();
      } catch (e) { say("#pr-roster-res", e.message, true); }
    });
    on("#pr-invite", async () => {
      try {
        await save();
        const r = await api("/api/peer-review/cycles/" + cycleId + "/invite", { method: "POST" });
        say("#pr-roster-res", r.invited + " new links sent." + (r.missing_email.length ? " No email for: " + r.missing_email.join(", ") : ""), !!r.missing_email.length);
        setTimeout(render, 1200);
      } catch (e) { say("#pr-roster-res", e.message, true); }
    });
    on("#pr-remind", async () => { try { const r = await api("/api/peer-review/cycles/" + cycleId + "/remind", { method: "POST" }); say("#pr-prog-res", r.reminded + " reminders sent."); } catch (e) { say("#pr-prog-res", e.message, true); } });
    on("#pr-close", async () => {
      if (!confirm("Close the survey? Answers lock and scores are calculated. This can't be undone.")) return;
      try { await api("/api/peer-review/cycles/" + cycleId + "/close", { method: "POST" }); render(); } catch (e) { say("#pr-prog-res", e.message, true); }
    });
    on("#pr-send", async () => {
      if (!confirm("Email each approved report to its employee? Each person only ever gets one.")) return;
      try {
        const r = await api("/api/peer-review/cycles/" + cycleId + "/send", { method: "POST" });
        alert(r.sent + " reports sent." + (r.problems.length ? "\n\nNot sent:\n" + r.problems.join("\n") : ""));
        render();
      } catch (e) { say("#pr-send-res", e.message, true); }
    });

    mount.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.filter; render(); }));
    mount.querySelectorAll("[data-cm]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.cm;
      const body = mount.querySelector('[data-cm-body="' + id + '"]');
      try { await api("/api/peer-review/comments/" + id, { method: "POST", body: { decision: b.dataset.d, body: body ? body.value : "" } }); render(); }
      catch (e) { alert(e.message); }
    }));
    mount.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", async () => {
      try { await api("/api/peer-review/results/" + b.dataset.approve + "/approve", { method: "POST" }); render(); }
      catch (e) { const el = mount.querySelector('[data-res="' + b.dataset.approve + '"]'); if (el) { el.style.color = "#a3282e"; el.textContent = e.message; } }
    }));
    mount.querySelectorAll("[data-resend]").forEach((b) => b.addEventListener("click", async () => {
      const el = mount.querySelector('[data-res="' + b.dataset.resend + '"]');
      try { await api("/api/peer-review/results/" + b.dataset.resend + "/resend", { method: "POST" }); el.style.color = "#15803d"; el.textContent = "Resent, same report."; }
      catch (e) { el.style.color = "#a3282e"; el.textContent = e.message; }
    }));
    const sels = mount.querySelectorAll("select[data-approver]");
    if (sels.length && !approverList) {
      api("/api/peer-review/approvers").then((r) => { approverList = r.approvers; render(); }).catch(() => { approverList = []; });
    }
    sels.forEach((s) => s.addEventListener("change", async () => {
      try { await api("/api/peer-review/cycles/" + cycleId + "/approver", { method: "PUT", body: { employee_id: Number(s.dataset.approver), approver_user_id: s.value ? Number(s.value) : null } }); render(); }
      catch (e) { alert(e.message); render(); }
    }));
  }

  window.__renderPeerReview = async function () { await render(); };
  window.addEventListener("hashchange", () => { if (location.hash !== HASH) { cycleId = null; filter = "all"; } });
})();
