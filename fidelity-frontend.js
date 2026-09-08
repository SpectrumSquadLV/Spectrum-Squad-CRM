// fidelity-frontend.js -- RBT Fidelity: the dashboard, the scoring screen, and
// the employee-profile section.
//
// EVERY NUMBER ON THIS PAGE ARRIVES ALREADY CALCULATED. There is no arithmetic
// in this file beyond laying figures out -- the server computes section totals,
// the total out of 60, the percentage, the rating, the change since last time,
// the trend and the raise, because two implementations of the same sum drift
// and the one on screen is the one people act on.
//
// Exposes window.__renderFidelity(mount) and window.__renderFidelityEmployee.
(function () {
  "use strict";
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function attr(s) { return esc(s).replace(/"/g, "&quot;"); }
  function dayLabel(s) {
    if (!s) return "—"; const p = String(s).slice(0, 10).split("-"); if (p.length !== 3) return String(s);
    const n = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return (n[+p[1]] || p[1]) + " " + (+p[2]) + ", " + p[0];
  }
  const pct = (v) => (v == null ? "—" : v + "%");

  // One vocabulary for what a rating means, used by the table, the cards, the
  // snapshot and the history. A rating that is amber in one place and red in
  // another is a rating nobody trusts.
  const RATING_STYLE = {
    exceptional:       { bg: "#dcfce7", fg: "#166534" },
    meets:             { bg: "#e0e7ff", fg: "#3730a3" },
    needs_improvement: { bg: "#fef3c7", fg: "#92400e" },
    critical:          { bg: "#fee2e2", fg: "#991b1b" },
  };
  function ratingChip(key, label) {
    if (!label) return '<span style="color:var(--text-muted);">—</span>';
    const s = RATING_STYLE[key] || { bg: "#e5e7eb", fg: "#374151" };
    return `<span style="font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;background:${s.bg};color:${s.fg};white-space:nowrap;">${esc(label)}</span>`;
  }
  // The arrow is the point of the column: nobody should compare two numbers.
  function trendChip(t) {
    if (!t || t.key === "none") return '<span style="color:var(--text-muted);">—</span>';
    const map = { improving: ["↑", "#166534"], declining: ["↓", "#991b1b"], stable: ["→", "#6b7280"] };
    const [arrow, col] = map[t.key] || ["→", "#6b7280"];
    const delta = t.change == null ? "" : ` ${t.change > 0 ? "+" : ""}${t.change}`;
    return `<span style="color:${col};font-weight:700;white-space:nowrap;">${arrow} ${esc(t.label)}${delta}</span>`;
  }

  let state = { data: null, filters: {}, search: "" };

  async function renderFidelity(mount) {
    mount.innerHTML = `<div class="page-header">
      <div><h1>RBT Fidelity</h1>
        <p>Current performance, trends and follow-up for every active RBT. Every figure here is calculated for you.</p></div>
      <div style="display:flex; gap:8px; align-items:center;">
        <button class="btn secondary" id="fid-random">Select random RBT</button>
        <button class="btn" id="fid-new">+ New Fidelity Check</button>
      </div></div>
      <div id="fid-body"><div class="empty-state">Loading…</div></div>`;
    mount.querySelector("#fid-new").addEventListener("click", () => openNewCheck(mount));
    mount.querySelector("#fid-random").addEventListener("click", () => pickRandom(mount));
    await fill(mount);
  }

  async function fill(mount) {
    const box = mount.querySelector("#fid-body");
    if (!box) return;
    let d;
    try { d = await api("/api/fidelity/dashboard"); }
    catch (e) {
      box.innerHTML = `<div class="empty-state">${esc(e.message || "Couldn't load RBT Fidelity.")}</div>`;
      return;
    }
    state.data = d;
    box.innerHTML = cardsHTML(d.cards) + filterBarHTML(d) + tableHTML(d);
    wire(mount, box);
  }

  function card(label, value, tone) {
    const col = tone === "bad" ? "#b91c1c" : tone === "warn" ? "#b45309" : tone === "good" ? "#166534" : "var(--brand-navy,#1b2a6b)";
    return `<div style="flex:1; min-width:150px; background:var(--bg,#f7f8fb); border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:13px 15px;">
      <div style="font-size:25px; font-weight:800; color:${col};">${value == null ? "—" : esc(String(value))}</div>
      <div style="font-size:12px; color:var(--text-muted);">${esc(label)}</div>
    </div>`;
  }

  function cardsHTML(c) {
    // Ordered so the ones that need somebody to DO something sit together,
    // rather than being scattered among the neutral counts.
    return `<div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:14px;">
      ${card("Active RBTs", c.active_rbts)}
      ${card("Average Fidelity score", c.average_score == null ? "—" : c.average_score + "%",
        c.average_score == null ? null : c.average_score >= 90 ? "good" : c.average_score < 80 ? "warn" : null)}
      ${card("Checks this month", c.checks_this_month)}
      ${card("Checks due", c.checks_due, c.checks_due ? "warn" : null)}
      ${card("Never checked", c.never_checked, c.never_checked ? "bad" : null)}
    </div>
    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:18px;">
      ${card("Below standard", c.below_standard, c.below_standard ? "warn" : null)}
      ${card("Critical concerns", c.critical_concerns, c.critical_concerns ? "bad" : null)}
      ${card("Open action plans", c.open_action_plans, c.open_action_plans ? "warn" : null)}
      ${card("Overdue action plans", c.overdue_action_plans, c.overdue_action_plans ? "bad" : null)}
      ${card("Trending down", c.trending_down, c.trending_down ? "warn" : null)}
      ${card("Reviews within 60 days", c.upcoming_reviews)}
    </div>`;
  }

  function filterBarHTML() {
    const f = state.filters;
    const sel = (id, label, opts, cur) =>
      `<select id="${id}" style="padding:7px 9px;border:1px solid var(--border,#e5e7eb);border-radius:8px;font-size:12.5px;">
        <option value="">${esc(label)}</option>
        ${opts.map((o) => `<option value="${attr(o.v)}"${cur === o.v ? " selected" : ""}>${esc(o.l)}</option>`).join("")}
      </select>`;
    return `<div class="card" style="display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-bottom:14px;padding:12px 14px;">
      <input id="fid-search" type="search" placeholder="Search RBTs…" value="${attr(state.search)}"
        style="flex:1;min-width:190px;padding:7px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;font-size:13px;" />
      ${sel("fid-f-rating", "Any rating", [
        { v: "exceptional", l: "Exceptional" }, { v: "meets", l: "Meets Standard" },
        { v: "needs_improvement", l: "Needs Improvement" }, { v: "critical", l: "Critical" }], f.rating)}
      ${sel("fid-f-trend", "Any trend", [
        { v: "improving", l: "↑ Improving" }, { v: "stable", l: "→ Stable" }, { v: "declining", l: "↓ Declining" }], f.trend)}
      ${sel("fid-f-flag", "Anything flagged", [
        { v: "critical", l: "Critical Fail" }, { v: "plan", l: "Open action plan" },
        { v: "overdue_plan", l: "Overdue action plan" }, { v: "due", l: "Check due" },
        { v: "never", l: "Never checked" }], f.flag)}
      <button type="button" id="fid-f-clear" style="margin-left:auto;background:none;border:none;color:var(--brand-navy,#1b2a6b);text-decoration:underline;font-size:12.5px;cursor:pointer;">Clear</button>
    </div>`;
  }

  function applyFilters(rows) {
    const f = state.filters, q = state.search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !String(r.name || "").toLowerCase().includes(q)) return false;
      if (f.rating && r.current_rating_key !== f.rating) return false;
      if (f.trend && (!r.trend || r.trend.key !== f.trend)) return false;
      if (f.flag === "critical" && !r.critical_fail) return false;
      if (f.flag === "plan" && !r.open_action_plans) return false;
      if (f.flag === "overdue_plan" && !r.overdue_action_plans) return false;
      if (f.flag === "due" && !r.overdue_check) return false;
      if (f.flag === "never" && r.checks !== 0) return false;
      return true;
    });
  }

  function tableHTML(d) {
    const rows = applyFilters(d.employees);
    if (!rows.length) {
      return `<div class="empty-state">${d.employees.length ? "No RBT matches those filters." : "No active RBTs found. RBT Fidelity reads the job title on the staff record, the same way the supervision tracker does."}</div>`;
    }
    const body = rows.map((r) => {
      // Never checked is said in words, not shown as a row of dashes that
      // reads like a rendering fault.
      const never = r.checks === 0;
      const score = never ? '<span style="color:var(--text-muted);">Never checked</span>'
        : `<strong>${r.current_score}/${r.current_max}</strong> <span style="color:var(--text-muted);">${pct(r.current_percentage)}</span>`;
      const prev = r.previous_percentage == null ? "—"
        : `${r.previous_score}/${r.current_max} <span style="color:var(--text-muted);">${pct(r.previous_percentage)}</span>`;
      const due = r.overdue_check
        ? `<span style="color:#b45309;font-weight:600;">${never ? "Now" : "Due"}</span>`
        : dayLabel(r.next_due);
      return `<tr data-fid-emp="${r.employee_id}" style="cursor:pointer;">
        <td style="padding:9px 10px;"><strong>${esc(r.name)}</strong>
          <div style="font-size:11.5px;color:var(--text-muted);">${esc(r.role_title || "")}</div></td>
        <td style="padding:9px 10px;">${score}</td>
        <td style="padding:9px 10px;">${ratingChip(r.current_rating_key, r.current_rating)}</td>
        <td style="padding:9px 10px;">${prev}</td>
        <td style="padding:9px 10px;">${trendChip(r.trend)}</td>
        <td style="padding:9px 10px;text-align:right;">${r.average == null ? "—" : pct(r.average)}</td>
        <td style="padding:9px 10px;text-align:right;">${r.checks}</td>
        <td style="padding:9px 10px;">${never ? "—" : dayLabel(r.last_check_date)}
          ${r.days_since_last == null ? "" : `<div style="font-size:11.5px;color:${r.days_since_last > 120 ? "#b45309" : "var(--text-muted)"};">${r.days_since_last} days ago</div>`}</td>
        <td style="padding:9px 10px;">${due}</td>
        <td style="padding:9px 10px;">
          ${r.critical_fail ? '<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;background:#fee2e2;color:#991b1b;">CRITICAL</span>' : ""}
          ${r.overdue_action_plans ? `<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;background:#fee2e2;color:#991b1b;">${r.overdue_action_plans} overdue</span>`
            : r.open_action_plans ? `<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;background:#fef3c7;color:#92400e;">${r.open_action_plans} plan${r.open_action_plans === 1 ? "" : "s"}</span>` : ""}
        </td>
      </tr>`;
    }).join("");

    return `<div class="card">
      <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:980px;">
        <thead><tr style="text-align:left;color:var(--text-muted);font-size:11px;text-transform:uppercase;">
          <th style="padding:8px 10px;">RBT</th><th style="padding:8px 10px;">Current</th>
          <th style="padding:8px 10px;">Rating</th><th style="padding:8px 10px;">Previous</th>
          <th style="padding:8px 10px;">Trend</th><th style="padding:8px 10px;text-align:right;">Average</th>
          <th style="padding:8px 10px;text-align:right;">Checks</th><th style="padding:8px 10px;">Last check</th>
          <th style="padding:8px 10px;">Next due</th><th style="padding:8px 10px;">Flags</th>
        </tr></thead><tbody>${body}</tbody>
      </table></div>
    </div>`;
  }

  function wire(mount, box) {
    const s = box.querySelector("#fid-search");
    if (s) s.addEventListener("input", () => {
      state.search = s.value;
      box.querySelector(".card:last-child") && redrawTable(mount, box);
    });
    [["fid-f-rating", "rating"], ["fid-f-trend", "trend"], ["fid-f-flag", "flag"]].forEach(([id, key]) => {
      const el = box.querySelector("#" + id);
      if (el) el.addEventListener("change", () => { state.filters[key] = el.value; redrawTable(mount, box); });
    });
    const clear = box.querySelector("#fid-f-clear");
    if (clear) clear.addEventListener("click", () => { state.filters = {}; state.search = ""; fill(mount); });
    box.querySelectorAll("[data-fid-emp]").forEach((tr) =>
      tr.addEventListener("click", () => openEmployee(mount, tr.dataset.fidEmp)));
  }

  // Only the table is redrawn while filtering, so the search box keeps focus
  // and the caret does not jump on every keystroke.
  function redrawTable(mount, box) {
    const cards = box.querySelector(".card:last-of-type");
    const fresh = document.createElement("div");
    fresh.innerHTML = tableHTML(state.data);
    if (cards && cards.parentNode) cards.replaceWith(fresh.firstElementChild || fresh);
    box.querySelectorAll("[data-fid-emp]").forEach((tr) =>
      tr.addEventListener("click", () => openEmployee(mount, tr.dataset.fidEmp)));
  }

  async function pickRandom(mount) {
    const btn = mount.querySelector("#fid-random");
    btn.disabled = true; btn.textContent = "Choosing…";
    try {
      const r = await api("/api/fidelity/random", { method: "POST", body: {} });
      btn.disabled = false; btn.textContent = "Select random RBT";
      if (!r.ok) { alert(r.error || "Nobody to choose from."); return; }
      const queue = (r.longest_waiting || [])
        .map((x) => `  ${x.name} — ${x.days_since_last == null ? "never checked" : x.days_since_last + " days ago"}`)
        .join("\n");
      // The pick is a SUGGESTION and says so. Leadership can always ignore it.
      if (confirm(`Selected: ${r.picked.name}\n\nDrawn at random from ${r.drawn_from} (${r.pool_size}).\n\nLongest waiting:\n${queue}\n\nStart a Fidelity Check for ${r.picked.name}?`)) {
        openNewCheck(mount, r.picked.employee_id);
      }
    } catch (e) {
      btn.disabled = false; btn.textContent = "Select random RBT";
      alert(e.message || "Couldn't choose an RBT.");
    }
  }

  // ======================= THE SCORING SCREEN =======================
  // The running total sits at the top and updates on every tap. The evaluator
  // never adds anything up, and never wonders what the score is "so far".
  let cur = { id: null, rubric: null, check: null, employee: null, scores: {}, calc: null, saveTimer: null };

  async function openNewCheck(mount, presetEmployeeId) {
    let rubric, staff;
    try {
      [rubric, staff] = await Promise.all([
        api("/api/fidelity/rubric"),
        api("/api/hr/employees").catch(() => []),
      ]);
    } catch (e) { alert(e.message || "Couldn't open a new Fidelity Check."); return; }

    const rbts = (Array.isArray(staff) ? staff : []).filter((e) =>
      String(e.status || "active") !== "terminated" &&
      /\bRBT\b|registered behavior technician|behavior tech|\bBT\b|student|in[- ]training|trainee/i.test(String(e.role_title || "")));

    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal" style="max-width:560px;">
      <div class="modal-header"><h2>New Fidelity Check</h2><button class="close-btn">✕</button></div>
      <div class="form-grid">
        <div class="field full"><label>RBT *</label>
          <select id="fid-emp">
            <option value="">Choose the RBT being observed…</option>
            ${rbts.map((e) => `<option value="${e.id}"${String(e.id) === String(presetEmployeeId) ? " selected" : ""}>${esc(e.name)}${e.role_title ? " — " + esc(e.role_title) : ""}</option>`).join("")}
          </select>
          ${rbts.length ? "" : '<div style="font-size:12px;color:#b45309;margin-top:5px;">No active RBTs found. Fidelity reads the job title on the staff record.</div>'}
        </div>
        <div class="field"><label>Session type</label>
          <select id="fid-session">${rubric.session_types.map((t) => `<option>${esc(t)}</option>`).join("")}</select></div>
        <div class="field"><label>Observation length</label>
          <select id="fid-len">${rubric.observation_lengths.map((m) => `<option value="${m}">${m} minutes</option>`).join("")}</select></div>
        <div class="field"><label>Client initials</label>
          <input id="fid-client" maxlength="6" placeholder="e.g. AB" />
          <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">Initials only — a client's full name never goes on this document.</div></div>
        <div class="field"><label>Date</label><input id="fid-date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
        <div class="field full"><label>Your credentials (optional)</label><input id="fid-creds" placeholder="e.g. BCBA, LBA" /></div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
        <button class="btn secondary" data-x>Cancel</button>
        <button class="btn" id="fid-start">Start the observation →</button>
      </div></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector(".close-btn").addEventListener("click", close);
    back.querySelector("[data-x]").addEventListener("click", close);

    back.querySelector("#fid-start").addEventListener("click", async () => {
      const empId = back.querySelector("#fid-emp").value;
      if (!empId) { alert("Choose which RBT is being observed."); return; }
      const btn = back.querySelector("#fid-start");
      btn.disabled = true; btn.textContent = "Starting…";
      try {
        const r = await api("/api/fidelity/check", { method: "POST", body: {
          employee_id: Number(empId),
          session_type: back.querySelector("#fid-session").value,
          observation_minutes: Number(back.querySelector("#fid-len").value),
          client_initials: back.querySelector("#fid-client").value.trim().toUpperCase(),
          assessment_date: back.querySelector("#fid-date").value,
          evaluator_credentials: back.querySelector("#fid-creds").value.trim(),
        }});
        close();
        openScoring(mount, r.id);
      } catch (e) { btn.disabled = false; btn.textContent = "Start the observation →"; alert(e.message || "Couldn't start."); }
    });
  }

  async function openScoring(mount, checkId) {
    let rubric, d;
    try {
      [rubric, d] = await Promise.all([api("/api/fidelity/rubric"), api("/api/fidelity/check/" + checkId)]);
    } catch (e) { alert(e.message || "Couldn't open that Fidelity Check."); return; }
    cur = { id: checkId, rubric, check: d.check, employee: d.employee, prior: d.prior,
            scores: d.check.scores || {}, calc: d.check.calc };

    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.id = "fid-scoring";
    back.innerHTML = `<div class="modal" style="max-width:860px;">
      <div class="modal-header">
        <h2>Fidelity Check — ${esc(d.employee ? d.employee.name : "RBT")}</h2>
        <button class="close-btn">✕</button>
      </div>
      <div id="fid-live"></div>
      <div id="fid-rubric"></div>
      <div id="fid-feedback"></div>
      <div id="fid-signoff"></div>
    </div>`;
    document.body.appendChild(back);
    back.querySelector(".close-btn").addEventListener("click", () => {
      // Everything is saved as it is tapped, so closing loses nothing.
      back.remove();
      if (mount) fill(mount);
    });
    drawScoring(mount, back);
  }

  function liveHTML() {
    const c = cur.calc || {};
    const done = c.answered || 0, all = c.items_total || 30;
    const complete = c.complete;
    const s = RATING_STYLE[c.rating_key] || { bg: "#eef2ff", fg: "#3730a3" };
    const prior = cur.prior && cur.prior.current ? cur.prior.current : null;
    return `<div style="position:sticky;top:0;z-index:5;background:${complete ? s.bg : "#eef2ff"};border-radius:12px;padding:13px 16px;margin-bottom:14px;">
      <div style="display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;">
        <div>
          <div style="font-size:11px;text-transform:uppercase;color:${complete ? s.fg : "#3730a3"};opacity:.75;">Current score</div>
          <div style="font-size:26px;font-weight:800;color:${complete ? s.fg : "#3730a3"};">
            ${c.total_score || 0} / ${c.max_score || 60}
            ${complete ? `<span style="font-size:19px;"> · ${c.percentage}%</span>` : ""}
          </div>
        </div>
        <div style="flex:1;min-width:150px;">
          ${complete
            ? `<div style="font-size:15px;font-weight:800;color:${s.fg};">${esc(String(c.rating_label || "").toUpperCase())}</div>
               <div style="font-size:12px;color:${s.fg};opacity:.85;">${esc(c.rating_action || "")}</div>`
            : `<div style="font-size:13px;color:#3730a3;">${done} of ${all} scored — the rating appears once every item has a score.</div>`}
        </div>
        ${prior ? `<div style="text-align:right;">
          <div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);">Last time</div>
          <div style="font-size:14px;font-weight:700;">${prior.score}/${prior.max} · ${prior.percentage}%</div>
        </div>` : ""}
      </div>
      ${c.critical_fail ? `<div style="margin-top:10px;background:#fee2e2;color:#991b1b;border-radius:8px;padding:9px 12px;font-size:13px;font-weight:700;">
        CRITICAL FIDELITY CONCERN — IMMEDIATE REVIEW REQUIRED
        <div style="font-weight:400;font-size:12.5px;margin-top:3px;">${esc((c.critical_fail_reasons || []).join(" · "))}</div>
      </div>` : ""}
    </div>`;
  }

  function rubricHTML() {
    return cur.rubric.sections.map((sec) => {
      const ss = (cur.calc && cur.calc.section_scores && cur.calc.section_scores[sec.key]) || { score: 0, max: sec.max };
      return `<div class="card" style="margin-bottom:12px;padding:13px 15px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px;">
          <strong style="font-size:14px;">${esc(sec.label)}</strong>
          <span style="font-size:13px;font-weight:700;color:var(--brand-navy,#1b2a6b);">${ss.score} / ${sec.max}</span>
        </div>
        ${sec.items.map((item) => {
          const v = cur.scores[item.key];
          const btn = (n, label, colour) => `<button type="button" data-fid-score="${item.key}" data-v="${n}"
            title="${attr(label)}"
            style="min-width:38px;padding:5px 0;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;
                   border:1px solid ${v === n ? colour : "var(--border,#e5e7eb)"};
                   background:${v === n ? colour : "#fff"};color:${v === n ? "#fff" : "#374151"};">${n}</button>`;
          return `<div style="display:flex;gap:10px;align-items:center;padding:5px 0;border-top:1px solid var(--border,#f1f1f4);">
            <div style="flex:1;font-size:13px;">${esc(item.label)}
              ${item.critical ? '<span title="A score of 0 here is a Critical Fail" style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:20px;background:#fee2e2;color:#991b1b;margin-left:5px;">CRITICAL ITEM</span>' : ""}
            </div>
            <div style="display:flex;gap:5px;">
              ${btn(0, "Does not meet — incorrect, missing or inappropriate", "#b91c1c")}
              ${btn(1, "Needs improvement — inconsistent or minor errors", "#b45309")}
              ${btn(2, "Meets expectation — independent, consistent, high quality", "#166534")}
            </div>
          </div>`;
        }).join("")}
      </div>`;
    }).join("");
  }

  function feedbackHTML() {
    const c = cur.check, calc = cur.calc || {};
    const need = calc.complete && (calc.critical_fail || calc.rating_key === "needs_improvement" || calc.rating_key === "critical");
    const chosen = c.action_plan_options || [];
    return `<div class="card" style="margin-bottom:12px;padding:13px 15px;">
      <strong style="font-size:14px;">Feedback</strong>
      <div class="field full" style="margin-top:9px;"><label>Strengths observed</label>
        <textarea id="fid-strengths" rows="3">${esc(c.strengths || "")}</textarea></div>
      <div class="field full"><label>Areas for improvement</label>
        <textarea id="fid-areas" rows="3">${esc(c.areas_for_improvement || "")}</textarea></div>
      <div class="field full"><label>Action plan${need ? " *" : ""}</label>
        <textarea id="fid-plan" rows="3">${esc(c.action_plan_narrative || "")}</textarea></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
        ${cur.rubric.action_plan_options.map((o) => `<label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;background:var(--bg,#f7f8fb);border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:5px 10px;cursor:pointer;">
          <input type="checkbox" data-fid-plan value="${attr(o)}"${chosen.includes(o) ? " checked" : ""} /> ${esc(o)}</label>`).join("")}
      </div>
      ${need ? `<div style="margin-top:9px;background:#fef3c7;color:#92400e;border-radius:8px;padding:8px 11px;font-size:12.5px;">
        This result requires an Action Plan before it can be finalized.</div>` : ""}
      <div class="field full" style="margin-top:10px;">
        <label>Was any unsafe or unethical practice observed?</label>
        <select id="fid-unsafe">
          <option value="no"${c.unsafe_practice ? "" : " selected"}>No</option>
          <option value="yes"${c.unsafe_practice ? " selected" : ""}>Yes</option>
        </select>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">Asked directly because it is not one of the scored competencies — no score on the rubric can carry it.</div>
      </div>
      <div class="field full" id="fid-unsafe-detail-wrap" style="${c.unsafe_practice ? "" : "display:none;"}">
        <label>Describe what was observed *</label>
        <textarea id="fid-unsafe-detail" rows="2">${esc(c.unsafe_practice_detail || "")}</textarea></div>
      ${calc.critical_fail ? `<div class="field full"><label>Describe the critical concern *</label>
        <textarea id="fid-critical-detail" rows="2">${esc(c.critical_fail_detail || "")}</textarea></div>` : ""}
    </div>`;
  }

  function signoffHTML() {
    const calc = cur.calc || {};
    return `<div class="card" style="padding:13px 15px;">
      <strong style="font-size:14px;">BCBA / Supervising Clinician signature</strong>
      <div class="form-grid" style="margin-top:9px;">
        <div class="field"><label>Printed name *</label><input id="fid-sign-name" value="${attr(cur.check.evaluator_name || "")}" /></div>
        <div class="field"><label>Credentials</label><input id="fid-sign-creds" value="${attr(cur.check.evaluator_credentials || "")}" /></div>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin:6px 0 12px;">
        Signing locks this assessment. The CRM then files the PDF in ${esc(cur.employee ? cur.employee.name + "'s" : "the")} personnel record, emails it to them for acknowledgment, and opens any follow-up the result requires.
      </p>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <span id="fid-save-state" style="font-size:12px;color:var(--text-muted);align-self:center;"></span>
        <button class="btn" id="fid-finalize"${calc.complete ? "" : " disabled"}>Sign &amp; finalize</button>
      </div>
      ${calc.complete ? "" : '<div style="font-size:12px;color:var(--text-muted);text-align:right;margin-top:5px;">Every competency must be scored first.</div>'}
    </div>`;
  }

  function drawScoring(mount, back) {
    back.querySelector("#fid-live").innerHTML = liveHTML();
    back.querySelector("#fid-rubric").innerHTML = rubricHTML();
    back.querySelector("#fid-feedback").innerHTML = feedbackHTML();
    back.querySelector("#fid-signoff").innerHTML = signoffHTML();

    back.querySelectorAll("[data-fid-score]").forEach((b) => b.addEventListener("click", async () => {
      const key = b.dataset.fidScore, v = Number(b.dataset.v);
      // Tapping the same value again clears it, so a mis-tap is correctable
      // without a separate "clear" control.
      cur.scores[key] = cur.scores[key] === v ? undefined : v;
      if (cur.scores[key] === undefined) delete cur.scores[key];
      await save(back, { scores: { [key]: cur.scores[key] === undefined ? null : cur.scores[key] } }, true);
    }));

    const unsafe = back.querySelector("#fid-unsafe");
    if (unsafe) unsafe.addEventListener("change", async () => {
      const yes = unsafe.value === "yes";
      back.querySelector("#fid-unsafe-detail-wrap").style.display = yes ? "" : "none";
      await save(back, { unsafe_practice: yes }, true);
    });

    [["fid-strengths", "strengths"], ["fid-areas", "areas_for_improvement"],
     ["fid-plan", "action_plan_narrative"], ["fid-unsafe-detail", "unsafe_practice_detail"],
     ["fid-critical-detail", "critical_fail_detail"]].forEach(([id, field]) => {
      const el = back.querySelector("#" + id);
      if (!el) return;
      el.addEventListener("input", () => {
        cur.check[field] = el.value;
        clearTimeout(cur.saveTimer);
        cur.saveTimer = setTimeout(() => save(back, { [field]: el.value }, false), 700);
      });
    });
    back.querySelectorAll("[data-fid-plan]").forEach((cb) => cb.addEventListener("change", () => {
      const picked = [...back.querySelectorAll("[data-fid-plan]")].filter((x) => x.checked).map((x) => x.value);
      cur.check.action_plan_options = picked;
      save(back, { action_plan_options: picked }, false);
    }));

    const fin = back.querySelector("#fid-finalize");
    if (fin) fin.addEventListener("click", () => finalize(mount, back));
  }

  // Saved on every tap. A Fidelity Check is conducted while watching somebody
  // work, and losing an observation to a closed laptop is not acceptable.
  async function save(back, patch, redraw) {
    const st = back.querySelector("#fid-save-state");
    if (st) st.textContent = "Saving…";
    try {
      // A cleared score is sent as null and the server drops it from the merge,
      // because only 0, 1 and 2 are stored. An earlier version of this invented
      // a `clear_score` field the server does not read, so un-tapping a score
      // silently left the old value in place.
      const r = await api("/api/fidelity/check/" + cur.id, { method: "PATCH", body: patch });
      if (r.calc) { cur.calc = r.calc; }
      if (st) st.textContent = "Saved";
      if (redraw) {
        // Only the live header, the section totals and the sign-off change on a
        // score tap. Redrawing the narrative fields would throw away whatever
        // the evaluator is halfway through typing.
        back.querySelector("#fid-live").innerHTML = liveHTML();
        const sections = back.querySelectorAll("#fid-rubric .card");
        cur.rubric.sections.forEach((sec, i) => {
          const ss = (cur.calc.section_scores || {})[sec.key];
          const el = sections[i] && sections[i].querySelector("span");
          if (el && ss) el.textContent = `${ss.score} / ${sec.max}`;
        });
        back.querySelectorAll("[data-fid-score]").forEach((b) => {
          const on = cur.scores[b.dataset.fidScore] === Number(b.dataset.v);
          const colour = b.dataset.v === "0" ? "#b91c1c" : b.dataset.v === "1" ? "#b45309" : "#166534";
          b.style.background = on ? colour : "#fff";
          b.style.color = on ? "#fff" : "#374151";
          b.style.borderColor = on ? colour : "var(--border,#e5e7eb)";
        });
        const finBtn = back.querySelector("#fid-finalize");
        if (finBtn) finBtn.disabled = !cur.calc.complete;
      }
    } catch (e) {
      if (st) st.textContent = "Not saved — " + (e.message || "try again");
    }
  }

  async function finalize(mount, back) {
    const calc = cur.calc || {};
    const name = (back.querySelector("#fid-sign-name") || {}).value || "";
    if (!name.trim()) { alert("Type your name to sign this Fidelity Check."); return; }
    const who = cur.employee ? cur.employee.name : "this RBT";
    if (!confirm(`Sign and finalize this Fidelity Check for ${who}?

${calc.total_score}/${calc.max_score} · ${calc.percentage}% · ${calc.rating_label}` +
      (calc.critical_fail ? `

CRITICAL FIDELITY CONCERN: ${(calc.critical_fail_reasons || []).join("; ")}` : "") +
      `

This locks the assessment, files the PDF in their personnel record and emails it to them. It cannot be edited afterwards.`)) return;

    const btn = back.querySelector("#fid-finalize");
    btn.disabled = true; btn.textContent = "Finalizing…";
    try {
      const r = await api("/api/fidelity/check/" + cur.id + "/finalize", { method: "POST", body: {
        bcba_signed_name: name.trim(),
        evaluator_credentials: (back.querySelector("#fid-sign-creds") || {}).value || "",
        strengths: (back.querySelector("#fid-strengths") || {}).value || "",
        areas_for_improvement: (back.querySelector("#fid-areas") || {}).value || "",
        action_plan_narrative: (back.querySelector("#fid-plan") || {}).value || "",
        action_plan_options: [...back.querySelectorAll("[data-fid-plan]")].filter((x) => x.checked).map((x) => x.value),
        unsafe_practice: (back.querySelector("#fid-unsafe") || {}).value === "yes",
        unsafe_practice_detail: (back.querySelector("#fid-unsafe-detail") || {}).value || "",
        critical_fail_detail: (back.querySelector("#fid-critical-detail") || {}).value || "",
      }});
      // Said plainly, including the parts that did NOT happen, rather than a
      // blanket "done" that hides a failed email.
      const lines = ["Signed and finalized."];
      lines.push(r.pdf_document_id ? "PDF filed in the personnel record." : "The PDF could not be generated — the assessment is saved and signed.");
      lines.push(r.emailed ? "Emailed to the employee for acknowledgment." : "Not emailed — check the employee has an email address on file.");
      if (r.action_plan_id) lines.push("An Action Plan has been opened.");
      alert(lines.join("\n"));
      back.remove();
      if (mount) fill(mount);
    } catch (e) {
      btn.disabled = false; btn.textContent = "Sign & finalize";
      alert(e.message || "Couldn't finalize.");
    }
  }

  // ======================= ONE EMPLOYEE =======================
  // The five questions this screen exists to answer, in order: how are they
  // doing, are they getting better or worse, is anything concerning, what
  // happens next, and what does it mean for their raise.
  async function openEmployee(mount, employeeId) {
    let d;
    try { d = await api("/api/fidelity/employee/" + employeeId); }
    catch (e) { alert(e.message || "Couldn't open that RBT."); return; }

    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal" style="max-width:900px;">
      <div class="modal-header">
        <h2>${esc(d.employee.name)} — RBT Fidelity</h2>
        <button class="close-btn">✕</button>
      </div>
      ${snapshotHTML(d)}
      ${graphHTML(d.trend_points)}
      ${historyHTML(d)}
      ${plansHTML(d)}
      <div style="margin-bottom:12px;">
        <button class="btn secondary" id="fid-raise-btn">Show the raise recommendation</button>
        <span style="font-size:11.5px;color:var(--text-muted);margin-left:8px;">Calculated from Fidelity and whatever else is weighted, with the working shown in plain English.</span>
      </div>
      <div id="fid-raise"></div>
    </div>`;
    document.body.appendChild(back);
    back.querySelector(".close-btn").addEventListener("click", () => back.remove());
    back.querySelectorAll("[data-fid-open]").forEach((el) =>
      el.addEventListener("click", () => openReadOnly(el.dataset.fidOpen)));
    const raiseBtn = back.querySelector("#fid-raise-btn");
    if (raiseBtn) raiseBtn.addEventListener("click", () => loadRaise(back, employeeId));
  }

  function snapshotHTML(d) {
    const s = d.summary;
    if (!s.current) {
      return `<div class="card" style="margin-bottom:12px;"><div class="empty-state">
        No Fidelity Check has ever been completed for ${esc(d.employee.name)}. That is a gap in the record, not a good score.
      </div></div>`;
    }
    const st = RATING_STYLE[s.current.rating_key] || { bg: "#eef2ff", fg: "#3730a3" };
    const cell = (label, value, sub) => `<div style="flex:1;min-width:130px;">
      <div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);">${esc(label)}</div>
      <div style="font-size:19px;font-weight:800;">${value}</div>
      ${sub ? `<div style="font-size:11.5px;color:var(--text-muted);">${sub}</div>` : ""}</div>`;
    return `<div class="card" style="margin-bottom:12px;background:${st.bg};">
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        ${cell("Current", `${s.current.score} / ${s.current.max}`, pct(s.current.percentage))}
        ${cell("Rating", ratingChip(s.current.rating_key, s.current.rating_label))}
        ${cell("Previous", s.previous ? `${s.previous.score} / ${s.previous.max}` : "—", s.previous ? pct(s.previous.percentage) : "first check")}
        ${cell("Change", s.change == null ? "—" : `${s.change > 0 ? "+" : ""}${s.change} pts`)}
        ${cell("Trend", trendChip(s.trend))}
        ${cell("Average", pct(s.average), `${s.checks} check${s.checks === 1 ? "" : "s"}`)}
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid rgba(0,0,0,.08);font-size:12.5px;">
        <div>Last check <strong>${esc(dayLabel(s.last_check_date))}</strong> ${s.days_since_last == null ? "" : `(${s.days_since_last} days ago)`}</div>
        <div>Evaluator <strong>${esc(s.last_evaluator || "—")}</strong></div>
        <div>Range <strong>${pct(s.lowest)}–${pct(s.highest)}</strong></div>
        ${s.critical_fails_12mo ? `<div style="color:#991b1b;font-weight:700;">${s.critical_fails_12mo} Critical Fail${s.critical_fails_12mo === 1 ? "" : "s"} in 12 months</div>` : ""}
      </div>
    </div>`;
  }

  // A small inline SVG rather than a charting library: the shape of the line is
  // the whole message, and a dependency for five points is not worth it.
  function graphHTML(points) {
    if (!points || points.length < 2) return "";
    const W = 640, H = 150, pad = 26;
    const xs = (i) => pad + (i * (W - pad * 2)) / (points.length - 1);
    // Fixed 50–100 scale. An auto-scaled axis makes a wobble between 88 and 91
    // look like a cliff, which is exactly the misreading this graph exists to
    // prevent.
    const ys = (v) => H - pad - ((Math.max(50, Math.min(100, v)) - 50) / 50) * (H - pad * 2);
    const line = points.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.percentage).toFixed(1)}`).join(" ");
    const dots = points.map((p, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(p.percentage).toFixed(1)}" r="4.5"
        fill="${p.percentage >= 90 ? "#166534" : p.percentage >= 80 ? "#3730a3" : p.percentage >= 60 ? "#b45309" : "#b91c1c"}">
        <title>${attr(dayLabel(p.date))} — ${p.score}/60 · ${p.percentage}% · ${attr(p.rating || "")}${p.evaluator ? " · " + attr(p.evaluator) : ""}</title>
      </circle>`).join("");
    const grid = [60, 80, 90].map((v) => `<line x1="${pad}" y1="${ys(v)}" x2="${W - pad}" y2="${ys(v)}" stroke="#e5e7eb" stroke-dasharray="3 3"/>
      <text x="2" y="${ys(v) + 4}" font-size="9" fill="#9ca3af">${v}%</text>`).join("");
    return `<div class="card" style="margin-bottom:12px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:6px;">Fidelity score over time</div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;">
        ${grid}<path d="${line}" fill="none" stroke="#1b2a6b" stroke-width="2"/>${dots}
      </svg>
      <div style="font-size:11.5px;color:var(--text-muted);">Hover a point for the date, score, rating and evaluator. The scale is fixed at 50–100% so a small change does not look like a cliff.</div>
    </div>`;
  }

  function historyHTML(d) {
    if (!d.history.length) return "";
    return `<div class="card" style="margin-bottom:12px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px;">Fidelity history</div>
      <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:620px;">
        <thead><tr style="text-align:left;color:var(--text-muted);font-size:11px;text-transform:uppercase;">
          <th style="padding:6px 8px;">Date</th><th style="padding:6px 8px;">Score</th><th style="padding:6px 8px;">%</th>
          <th style="padding:6px 8px;">Rating</th><th style="padding:6px 8px;">Change</th>
          <th style="padding:6px 8px;">Evaluator</th><th style="padding:6px 8px;">Critical</th><th style="padding:6px 8px;">Status</th>
        </tr></thead><tbody>
        ${d.history.map((h, i) => {
          const next = d.history[i + 1];
          const chg = next && h.percentage != null && next.percentage != null
            ? Math.round((h.percentage - next.percentage) * 10) / 10 : null;
          return `<tr data-fid-open="${h.id}" style="cursor:pointer;border-top:1px solid var(--border,#f1f1f4);">
            <td style="padding:6px 8px;">${esc(dayLabel(h.assessment_date))}</td>
            <td style="padding:6px 8px;">${h.total_score}/${h.max_score}</td>
            <td style="padding:6px 8px;">${pct(h.percentage)}</td>
            <td style="padding:6px 8px;">${ratingChip(h.rating_key, h.rating_label)}</td>
            <td style="padding:6px 8px;${chg == null ? "color:var(--text-muted);" : chg > 0 ? "color:#166534;font-weight:600;" : chg < 0 ? "color:#991b1b;font-weight:600;" : ""}">${chg == null ? "—" : (chg > 0 ? "+" : "") + chg + " pts"}</td>
            <td style="padding:6px 8px;">${esc(h.evaluator_name || "—")}</td>
            <td style="padding:6px 8px;">${h.critical_fail ? '<span style="color:#991b1b;font-weight:700;">Yes</span>' : "No"}</td>
            <td style="padding:6px 8px;color:var(--text-muted);">${esc(h.employee_ack_at ? "Acknowledged" : h.emailed_at ? "Awaiting acknowledgment" : h.finalized_at ? "Finalized" : h.status)}</td>
          </tr>`;
        }).join("")}
      </tbody></table></div>
      <div style="font-size:11.5px;color:var(--text-muted);margin-top:6px;">Every Fidelity Check is kept. A new one never replaces an old score.</div>
    </div>`;
  }

  function plansHTML(d) {
    const open = (d.action_plans || []).filter((p) => p.status !== "completed");
    if (!open.length) return "";
    return `<div class="card" style="margin-bottom:12px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px;">Open action plans</div>
      ${open.map((p) => `<div style="padding:7px 0;border-top:1px solid var(--border,#f1f1f4);font-size:12.5px;">
        <div><strong>${esc((p.plan_types || []).join(", ") || "Action plan")}</strong>
          ${p.overdue ? '<span style="font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:20px;background:#fee2e2;color:#991b1b;margin-left:6px;">OVERDUE</span>' : ""}</div>
        <div style="color:var(--text-muted);">${esc(p.description || "—")}</div>
        <div style="color:var(--text-muted);">Assigned ${esc(dayLabel(p.date_assigned))}${p.due_date ? " · due " + esc(dayLabel(p.due_date)) : ""}${p.responsible_supervisor ? " · " + esc(p.responsible_supervisor) : ""}</div>
      </div>`).join("")}
    </div>`;
  }

  async function loadRaise(back, employeeId) {
    const box = back.querySelector("#fid-raise");
    box.innerHTML = '<div class="card"><div class="empty-state">Calculating…</div></div>';
    try {
      const r = await api(`/api/fidelity/raise/${employeeId}`);
      box.innerHTML = raiseHTML(r);
      const why = box.querySelector("#fid-why");
      if (why) why.addEventListener("click", () => {
        const p = box.querySelector("#fid-why-text");
        p.style.display = p.style.display === "none" ? "" : "none";
      });
    } catch (e) {
      box.innerHTML = `<div class="card"><div class="empty-state">${esc(e.message || "Couldn't calculate a raise.")}</div></div>`;
    }
  }

  function raiseHTML(r) {
    const money = (n) => (n == null ? "—" : "$" + Number(n).toFixed(2));
    const cell = (label, value, tone) => `<div style="flex:1;min-width:135px;">
      <div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);">${esc(label)}</div>
      <div style="font-size:19px;font-weight:800;${tone ? "color:" + tone + ";" : ""}">${value}</div></div>`;
    return `<div class="card">
      <div style="font-size:13px;font-weight:700;margin-bottom:10px;">Annual raise recommendation</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        ${cell("Fidelity", pct(r.fidelity.value), null)}
        ${cell("Trend", trendChip(r.trend))}
        ${cell("Critical fails", r.critical_fails_12mo, r.critical_fails_12mo ? "#991b1b" : null)}
        ${cell("Performance score", pct(r.performance_score))}
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--border,#e5e7eb);">
        ${cell("Current pay", r.current_rate == null ? "—" : money(r.current_rate) + "/hr")}
        ${cell("Recommended raise", r.recommended_percent == null ? "Leadership review" : r.recommended_percent + "%", r.recommended_percent == null ? "#b45309" : "#166534")}
        ${cell("Increase", r.recommended_increase == null ? "—" : "+" + money(r.recommended_increase) + "/hr")}
        ${cell("New rate", r.recommended_new_rate == null ? "—" : money(r.recommended_new_rate) + "/hr")}
      </div>
      ${r.estimated_weekly_increase == null ? "" : `<div style="font-size:12.5px;color:var(--text-muted);margin-top:8px;">
        About ${money(r.estimated_weekly_increase)} more a week and ${money(r.estimated_annual_increase)} a year, using an assumed ${r.assumed_weekly_hours}-hour week.</div>`}
      ${r.flags && r.flags.length ? `<div style="margin-top:10px;background:#fef3c7;color:#92400e;border-radius:8px;padding:9px 12px;font-size:12.5px;">
        <strong>Flagged for leadership review.</strong> ${esc(r.flags.join(" "))}</div>` : ""}
      <div style="margin-top:11px;">
        <button type="button" id="fid-why" style="background:none;border:none;color:var(--brand-navy,#1b2a6b);text-decoration:underline;font-size:12.5px;cursor:pointer;padding:0;">Why am I seeing this recommendation?</button>
        <p id="fid-why-text" style="display:none;font-size:13px;line-height:1.55;background:var(--bg,#f7f8fb);border-radius:8px;padding:11px 13px;margin-top:8px;">${esc(r.explanation)}</p>
      </div>
      <div style="font-size:11.5px;color:var(--text-muted);margin-top:9px;">This is a recommendation. Leadership makes the final decision, and whatever is approved is recorded with the figures it was based on.</div>
    </div>`;
  }

  async function openReadOnly(checkId) {
    let d;
    try { d = await api("/api/fidelity/check/" + checkId); }
    catch (e) { alert(e.message || "Couldn't open that Fidelity Check."); return; }
    const c = d.check, calc = c.calc || {};
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal" style="max-width:780px;">
      <div class="modal-header"><h2>Fidelity Check — ${esc(dayLabel(c.assessment_date))}</h2><button class="close-btn">✕</button></div>
      <div class="card" style="margin-bottom:12px;">
        <div style="font-size:20px;font-weight:800;">${c.total_score}/${c.max_score} · ${pct(c.percentage)} ${ratingChip(c.rating_key, c.rating_label)}</div>
        <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;">
          ${esc(c.session_type || "—")} · ${c.observation_minutes || "—"} min · client ${esc(c.client_initials || "—")} · ${esc(c.evaluator_name || "—")}
        </div>
        ${c.critical_fail ? `<div style="margin-top:9px;background:#fee2e2;color:#991b1b;border-radius:8px;padding:9px 12px;font-size:12.5px;">
          <strong>Critical fidelity concern.</strong> ${esc((c.critical_fail_reasons || []).join("; "))}
          ${c.critical_fail_detail ? "<br>" + esc(c.critical_fail_detail) : ""}</div>` : ""}
      </div>
      ${(d.check.section_scores ? Object.keys(d.check.section_scores) : []).length ? "" : ""}
      <div class="card" style="margin-bottom:12px;">
        ${(calc.section_scores ? Object.entries(calc.section_scores) : []).map(([k, ss]) => {
          const sec = (window.__fidelitySections || []).find((x) => x.key === k);
          return `<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;">
            <span>${esc(sec ? sec.label : k)}</span><strong>${ss.score} / ${ss.max}</strong></div>`;
        }).join("")}
      </div>
      ${["strengths", "areas_for_improvement", "action_plan_narrative"].map((f) => c[f] ? `<div class="card" style="margin-bottom:12px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">${esc(f.replace(/_/g, " "))}</div>
        <div style="font-size:13px;white-space:pre-wrap;">${esc(c[f])}</div></div>` : "").join("")}
      <div class="card">
        <div style="font-size:12.5px;">Signed by <strong>${esc(c.bcba_signed_name || "—")}</strong> ${c.bcba_signed_at ? "on " + esc(dayLabel(c.bcba_signed_at)) : ""}</div>
        <div style="font-size:12.5px;color:var(--text-muted);">${c.employee_ack_at
          ? "Acknowledged by " + esc(c.employee_ack_name) + " on " + esc(dayLabel(c.employee_ack_at))
          : "Awaiting employee acknowledgment"}</div>
        ${c.pdf_document_id ? `<a class="btn small secondary" style="margin-top:9px;display:inline-block;" href="/api/hr/employee-documents/${c.pdf_document_id}" target="_blank">Download PDF</a>` : ""}
      </div>
    </div>`;
    document.body.appendChild(back);
    back.querySelector(".close-btn").addEventListener("click", () => back.remove());
  }

  window.__renderFidelity = renderFidelity;
  window.__fidelityHelpers = { ratingChip, trendChip, dayLabel, pct, esc, attr, RATING_STYLE };
})();
