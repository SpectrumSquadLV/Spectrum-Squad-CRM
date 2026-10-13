// compliance-frontend.js -- the Compliance Training library at #/compliance.
//
// The screen where somebody decides what training this practice requires of
// whom, and how often. One library for everybody who works here: HIPAA is
// required of an RBT, a BCBA, the front desk and the Clinical Director alike.
//
// TWO THINGS THE SCREEN HAS TO SAY OUT LOUD.
//
//   WHO A COURSE IS REQUIRED OF, on the row, in words. A course in the
//   library that is required of nobody looks exactly like one required of
//   everybody if the screen only lists titles -- and the whole failure mode
//   of compliance software is believing training is assigned when it is not.
//   So every row says either who, or "Nobody yet -- no rule set".
//
//   WHETHER A RENEWAL INTERVAL HAS BEEN SET. The intervals follow law,
//   contracts and company policy, so none is shipped: the field is blank and
//   the row says "Once, no renewal set" until a person fills it in. That is a
//   prompt, not a default pretending to be a decision.
(function () {
  "use strict";

  // `flash` survives the re-render. Saving reloads the library so the row
  // above updates, which re-draws this panel -- and the confirmation you just
  // earned went with it, so every save looked like it had done nothing.
  const S = { data: null, mount: null, q: "", scope: "", busy: false, open: null, flash: null };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function api(path, opts) {
    opts = opts || {};
    const r = await fetch(path, {
      method: opts.method || "GET",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let d = null; try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error((d && d.error) || `Request failed (${r.status})`);
    return d;
  }

  function styles() {
    if (document.getElementById("cmp-styles")) return;
    const el = document.createElement("style");
    el.id = "cmp-styles";
    // Deliberately its own prefix. A generic class name in a bundle loaded
    // beside thirty others reaches every one of them -- this app has had that
    // happen, with a 15px ".hint" circle squashing full sentences across four
    // unrelated screens.
    el.textContent = `
    .cmp-head { display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; justify-content:space-between; margin-bottom:14px; }
    .cmp-panel { background:#fff; border:1px solid #eceef5; border-radius:16px; box-shadow:0 1px 3px rgba(41,34,92,.06); }
    .cmp-filters { display:flex; flex-wrap:wrap; gap:8px; padding:12px; border-bottom:1px solid #f0f1f6; align-items:center; }
    .cmp-filters input, .cmp-filters select, .cmp-f input, .cmp-f select, .cmp-f textarea {
      font:inherit; font-size:13px; padding:7px 10px; border:1px solid #dcdfea; border-radius:10px; background:#fff; color:inherit; min-width:0; }
    .cmp-filters .grow { flex:1 1 220px; }
    .cmp-table { width:100%; border-collapse:collapse; }
    .cmp-table th { text-align:left; font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:#6b6a86; padding:10px 12px; border-bottom:1px solid #eceef5; font-weight:700; }
    .cmp-table td { padding:12px; border-bottom:1px solid #f3f4f8; font-size:13.5px; vertical-align:top; }
    .cmp-table tbody tr:hover { background:#fafaff; }
    .cmp-title { font-weight:700; color:var(--brand-navy, #1b2a6b); }
    .cmp-muted { color:#6b6a86; font-size:12px; }
    .cmp-pill { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:700; white-space:nowrap; }
    .cmp-none { background:#fef3c7; color:#92400e; }
    .cmp-set { background:#dcfce7; color:#166534; }
    .cmp-opt { background:#eef0f4; color:#5b6472; }
    .cmp-btn { font:inherit; font-size:13px; font-weight:700; border:0; border-radius:999px; padding:9px 16px; background:var(--brand-navy, #1b2a6b); color:#fff; cursor:pointer; }
    .cmp-btn.ghost { background:#fff; color:var(--brand-navy, #1b2a6b); border:1px solid #dcdfea; }
    .cmp-btn.small { padding:5px 12px; font-size:12.5px; }
    .cmp-btn:disabled { opacity:.55; cursor:default; }
    .cmp-empty { padding:28px; text-align:center; color:#6b6a86; }
    .cmp-f { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:10px; }
    .cmp-f label { display:flex; flex-direction:column; gap:4px; font-size:11.5px; color:#6b6a86; font-weight:600; }
    .cmp-f label.wide { grid-column:1 / -1; }
    .cmp-rule { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:8px 0; border-bottom:1px solid #f3f4f8; }
    .cmp-msg { font-size:12.5px; }
    .cmp-note { font-size:12.5px; color:#6b6a86; background:#f7f8fb; border-radius:10px; padding:10px 12px; margin-bottom:12px; }
    @media (max-width: 760px) {
      .cmp-f { grid-template-columns:1fr; }
      .cmp-table thead { display:none; }
      .cmp-table tr { display:grid; gap:4px; padding:10px 12px; border-bottom:1px solid #f0f1f6; }
      .cmp-table td { border:0; padding:2px 0; }
      .cmp-table td::before { content:attr(data-l); display:block; font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; color:#6b6a86; font-weight:700; }
    }`;
    document.head.appendChild(el);
  }

  const requiredPill = (c) => {
    if (c.rules.some((r) => r.scope !== "optional")) return `<span class="cmp-pill cmp-set">${esc(c.required_of)}</span>`;
    if (c.rules.length) return `<span class="cmp-pill cmp-opt">Optional</span>`;
    return `<span class="cmp-pill cmp-none">${esc(c.required_of)}</span>`;
  };

  function rows(list) {
    if (!list.length) return `<tr><td colspan="5"><div class="cmp-empty">No courses match.</div></td></tr>`;
    return list.map((c) => `<tr data-course="${c.id}">
      <td data-l="Course"><div class="cmp-title">${esc(c.title)}</div>
        ${c.summary ? `<div class="cmp-muted">${esc(c.summary)}</div>` : ""}
        ${!c.active ? `<div class="cmp-muted"><strong>Retired</strong> — kept so completed records still resolve</div>` : ""}</td>
      <td data-l="Required of">${requiredPill(c)}</td>
      <td data-l="Renews">${c.renews ? esc(c.renews) : `<span class="cmp-muted">—</span>`}</td>
      <td data-l="How">${esc(c.delivery_label)}${c.passing_score != null ? `<div class="cmp-muted">Pass mark ${c.passing_score}%</div>` : ""}
        ${c.provider ? `<div class="cmp-muted">${esc(c.provider)}</div>` : ""}</td>
      <td data-l="Version"><span class="cmp-muted">v${c.version}</span></td>
    </tr>`).join("");
  }

  function filtered() {
    const q = S.q.trim().toLowerCase();
    return (S.data.courses || []).filter((c) => {
      if (q && !(`${c.title} ${c.summary || ""} ${c.provider || ""}`.toLowerCase().includes(q))) return false;
      if (S.scope === "unassigned") return !c.rules.some((r) => r.scope !== "optional");
      if (S.scope === "norenewal") return c.rules.some((r) => r.scope !== "optional") && c.rules.every((r) => r.renewal_months == null);
      if (S.scope) return c.rules.some((r) => r.scope === S.scope);
      return true;
    });
  }

  function render() {
    const d = S.data;
    const list = filtered();
    const unassigned = (d.courses || []).filter((c) => !c.rules.some((r) => r.scope !== "optional")).length;
    const noRenewal = (d.courses || []).filter((c) => c.rules.some((r) => r.scope !== "optional") && c.rules.every((r) => r.renewal_months == null)).length;

    S.mount.innerHTML = `
      <div class="cmp-head">
        <div><h1>Compliance Training</h1>
          <p>One library of the training this practice requires, for everybody who works here.</p></div>
        <div style="display:flex; gap:8px; align-items:center;">
          ${d.can_manage ? `<button class="cmp-btn" id="cmp-add">Add a course</button>` : `<span class="cmp-muted">The course library is set by the owner, an admin or HR.</span>`}
        </div>
      </div>

      ${unassigned ? `<div class="cmp-note"><strong>${unassigned} course${unassigned === 1 ? " is" : "s are"} required of nobody yet.</strong>
        A course in the library assigns nothing until somebody says who it is for — nothing has been handed out on its own.</div>` : ""}
      ${noRenewal ? `<div class="cmp-note"><strong>${noRenewal} course${noRenewal === 1 ? "" : "s"} with no renewal interval.</strong>
        Renewal periods follow law, contracts and company policy, so none is filled in for you. A course with none is required once and never again.</div>` : ""}

      <div class="cmp-panel">
        <div class="cmp-filters">
          <input class="grow" id="cmp-q" placeholder="Search a course" value="${esc(S.q)}" />
          <label>Show
            <select id="cmp-scope">
              <option value="">Everything</option>
              <option value="unassigned"${S.scope === "unassigned" ? " selected" : ""}>Required of nobody</option>
              <option value="norenewal"${S.scope === "norenewal" ? " selected" : ""}>No renewal set</option>
              <option value="all"${S.scope === "all" ? " selected" : ""}>Required of everybody</option>
              <option value="position"${S.scope === "position" ? " selected" : ""}>By position</option>
              <option value="department"${S.scope === "department" ? " selected" : ""}>By department</option>
              <option value="optional"${S.scope === "optional" ? " selected" : ""}>Optional</option>
            </select>
          </label>
          <span class="cmp-muted">${list.length} of ${(d.courses || []).length}</span>
        </div>
        <div style="overflow-x:auto;">
          <table class="cmp-table">
            <thead><tr><th>Course</th><th>Required of</th><th>Renews</th><th>How it is done</th><th>Version</th></tr></thead>
            <tbody id="cmp-rows">${rows(list)}</tbody>
          </table>
        </div>
      </div>
      <div id="cmp-drawer"></div>`;

    const qEl = S.mount.querySelector("#cmp-q");
    qEl.addEventListener("input", () => { S.q = qEl.value; const b = S.mount.querySelector("#cmp-rows"); if (b) b.innerHTML = rows(filtered()); wireRows(); });
    S.mount.querySelector("#cmp-scope").addEventListener("change", (e) => { S.scope = e.target.value; render(); });
    const add = S.mount.querySelector("#cmp-add");
    if (add) add.addEventListener("click", () => openCourse(null));
    wireRows();
    if (S.open) { const c = (d.courses || []).find((x) => x.id === S.open); if (c) openCourse(c); else S.open = null; }
  }

  function wireRows() {
    S.mount.querySelectorAll("#cmp-rows tr[data-course]").forEach((tr) => {
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () => {
        const c = (S.data.courses || []).find((x) => x.id === Number(tr.dataset.course));
        if (c) openCourse(c);
      });
    });
  }

  // ---- one course: what it is, and who it is required of ------------------
  function openCourse(c) {
    const d = S.data;
    const v = d.vocabulary;
    const edit = !!d.can_manage;
    if (S.flash && S.open !== (c ? c.id : null)) S.flash = null;
    S.open = c ? c.id : null;
    const host = S.mount.querySelector("#cmp-drawer");
    const ruleRow = (r, i) => `<div class="cmp-rule" data-rule="${i}">
      <select data-r="scope" ${edit ? "" : "disabled"}>
        ${v.scopes.map((s) => `<option value="${s.key}"${r && r.scope === s.key ? " selected" : ""}>${esc(s.label)}</option>`).join("")}
      </select>
      <select data-r="position_group" ${edit ? "" : "disabled"}>
        <option value="">— position —</option>
        ${v.positions.map((p) => `<option value="${esc(p.key)}"${r && r.position_group === p.key ? " selected" : ""}>${esc(p.label)}</option>`).join("")}
      </select>
      <select data-r="department_key" ${edit ? "" : "disabled"}>
        <option value="">— department —</option>
        ${v.departments.map((x) => `<option value="${esc(x.key)}"${r && r.department_key === x.key ? " selected" : ""}>${esc(x.name)}</option>`).join("")}
      </select>
      <label class="cmp-muted" style="display:flex;align-items:center;gap:5px;">Renews every
        <input data-r="renewal_months" type="number" min="1" max="120" style="width:72px;" value="${r && r.renewal_months != null ? r.renewal_months : ""}" placeholder="—" ${edit ? "" : "disabled"} /> months</label>
      <label class="cmp-muted" style="display:flex;align-items:center;gap:5px;">Due within
        <input data-r="due_days" type="number" min="0" max="365" style="width:72px;" value="${r && r.due_days != null ? r.due_days : ""}" placeholder="—" ${edit ? "" : "disabled"} /> days</label>
      ${edit ? `<button class="cmp-btn ghost small" data-rule-del="${i}">Remove</button>` : ""}
    </div>`;

    host.innerHTML = `
      <div class="cmp-panel" style="margin-top:16px; padding:16px;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start; flex-wrap:wrap;">
          <h2 style="margin:0; font-size:17px; color:var(--brand-navy,#1b2a6b);">${c ? esc(c.title) : "Add a course"}</h2>
          <button class="cmp-btn ghost small" id="cmp-close">Close</button>
        </div>
        <div class="cmp-f" style="margin-top:12px;">
          <label class="wide">Title<input data-f="title" value="${c ? esc(c.title) : ""}" ${edit ? "" : "disabled"} /></label>
          <label class="wide">What it covers<textarea data-f="summary" rows="2" ${edit ? "" : "disabled"}>${c ? esc(c.summary || "") : ""}</textarea></label>
          <label>How it is done<select data-f="delivery" ${edit ? "" : "disabled"}>
            ${v.delivery.map((x) => `<option value="${x.key}"${c && c.delivery === x.key ? " selected" : ""}>${esc(x.label)}</option>`).join("")}
          </select></label>
          <label>Provider (for an outside certificate)<input data-f="provider" value="${c ? esc(c.provider || "") : ""}" ${edit ? "" : "disabled"} /></label>
          <label>Link, if it is taken elsewhere<input data-f="external_url" value="${c ? esc(c.external_url || "") : ""}" placeholder="https://…" ${edit ? "" : "disabled"} /></label>
          <label>Pass mark, if it has a quiz<input data-f="passing_score" type="number" min="1" max="100" value="${c && c.passing_score != null ? c.passing_score : ""}" placeholder="—" ${edit ? "" : "disabled"} /></label>
        </div>
        ${edit ? `<div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
          <button class="cmp-btn" id="cmp-save">${c ? "Save course" : "Add course"}</button>
          ${c ? `<button class="cmp-btn ghost" id="cmp-retire">${c.active ? "Retire" : "Bring back"}</button>` : ""}
          <span class="cmp-msg" id="cmp-msg"></span>
        </div>` : ""}

        ${c ? `<div style="margin-top:20px;">
          <div style="font-weight:800; color:var(--brand-navy,#1b2a6b); font-size:15px;">Who it is required of</div>
          <div class="cmp-muted" style="margin:4px 0 8px;">Leave the renewal blank for training that is done once. Nothing is assumed: with no rule at all, this course is required of nobody.</div>
          <div id="cmp-rules">${(c.rules.length ? c.rules : []).map(ruleRow).join("")}</div>
          ${edit ? `<div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
            <button class="cmp-btn ghost small" id="cmp-rule-add">Add a rule</button>
            <button class="cmp-btn small" id="cmp-rules-save">Save who it is for</button>
            <span class="cmp-msg" id="cmp-rules-msg"></span>
          </div>` : ""}
        </div>
        <div style="margin-top:20px;">
          <div style="font-weight:800; color:var(--brand-navy,#1b2a6b); font-size:15px;">Change history</div>
          <div id="cmp-history" class="cmp-muted" style="margin-top:6px;">Loading…</div>
        </div>` : ""}
      </div>`;

    host.querySelector("#cmp-close").addEventListener("click", () => { S.open = null; S.flash = null; host.innerHTML = ""; });
    host.scrollIntoView({ behavior: "smooth", block: "nearest" });

    const msg = (id, t, bad) => {
      const m = host.querySelector(id);
      if (m) { m.textContent = t; m.style.color = bad ? "#b91c1c" : "#166534"; }
      // Remembered so a reload that re-draws this panel does not swallow it.
      S.flash = { id, text: t, bad: !!bad };
    };
    if (S.flash) { const m = host.querySelector(S.flash.id); if (m) { m.textContent = S.flash.text; m.style.color = S.flash.bad ? "#b91c1c" : "#166534"; } }
    const body = () => {
      const out = {};
      host.querySelectorAll("[data-f]").forEach((el) => { out[el.dataset.f] = el.value; });
      if (out.passing_score === "") out.passing_score = null;
      return out;
    };

    const save = host.querySelector("#cmp-save");
    if (save) save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        if (c) {
          const r = await api(`/api/compliance/courses/${c.id}`, { method: "PATCH", body: body() });
          msg("#cmp-msg", r.unchanged ? "Nothing to change." : r.forked
            ? `Saved. This changed what completing it means, so it is now version ${r.version}; records already earned keep their version.`
            : "Saved.");
        } else {
          await api("/api/compliance/courses", { method: "POST", body: body() });
          msg("#cmp-msg", "Added. It is required of nobody until you say who it is for.");
        }
        await reload();
      } catch (e) { msg("#cmp-msg", e.message, true); }
      save.disabled = false;
    });

    const retire = host.querySelector("#cmp-retire");
    if (retire) retire.addEventListener("click", async () => {
      retire.disabled = true;
      try {
        await api(`/api/compliance/courses/${c.id}/retire`, { method: "POST", body: { retire: !!c.active } });
        msg("#cmp-msg", c.active ? "Retired. Everything already completed against it is kept." : "Back in the library.");
        S.open = null;
        await reload();
      } catch (e) { msg("#cmp-msg", e.message, true); retire.disabled = false; }
    });

    if (c) {
      const wireRules = () => {
        host.querySelectorAll("[data-rule-del]").forEach((b) => b.addEventListener("click", () => {
          b.closest("[data-rule]").remove();
        }));
      };
      wireRules();
      const addRule = host.querySelector("#cmp-rule-add");
      if (addRule) addRule.addEventListener("click", () => {
        const wrap = host.querySelector("#cmp-rules");
        wrap.insertAdjacentHTML("beforeend", ruleRow(null, wrap.children.length));
        wireRules();
      });
      const saveRules = host.querySelector("#cmp-rules-save");
      if (saveRules) saveRules.addEventListener("click", async () => {
        saveRules.disabled = true;
        const rules = [...host.querySelectorAll("#cmp-rules [data-rule]")].map((row) => {
          const g = (k) => { const el = row.querySelector(`[data-r="${k}"]`); return el ? el.value : ""; };
          return {
            scope: g("scope"),
            position_group: g("position_group") || null,
            department_key: g("department_key") || null,
            renewal_months: g("renewal_months") === "" ? null : Number(g("renewal_months")),
            due_days: g("due_days") === "" ? null : Number(g("due_days")),
          };
        });
        try {
          await api(`/api/compliance/courses/${c.id}/rules`, { method: "PUT", body: { rules } });
          msg("#cmp-rules-msg", rules.length ? "Saved." : "Saved — this course is now required of nobody.");
          await reload();
        } catch (e) { msg("#cmp-rules-msg", e.message, true); }
        saveRules.disabled = false;
      });

      api(`/api/compliance/courses/${c.id}/history`).then((h) => {
        const el = host.querySelector("#cmp-history");
        if (!el) return;
        el.innerHTML = (h.history || []).length
          ? `<ul style="margin:0 0 0 18px; padding:0;">${h.history.map((x) => `<li style="margin:3px 0;"><strong>${esc(String(x.changed_at || "").slice(0, 10))}</strong> · ${esc(x.changed_by || "—")}<br>${esc(x.change)}</li>`).join("")}</ul>`
          : "Nothing recorded yet.";
      }).catch(() => {
        const el = host.querySelector("#cmp-history");
        if (el) el.textContent = "Could not load the history.";
      });
    }
  }

  async function reload() {
    S.data = await api("/api/compliance/courses?retired=1");
    render();
  }

  window.__renderCompliance = async function (mount) {
    styles();
    S.mount = mount;
    mount.innerHTML = `<div class="cmp-empty">Loading the course library…</div>`;
    try {
      await reload();
    } catch (e) {
      mount.innerHTML = `<div class="cmp-panel" style="padding:20px;"><strong>${esc(e.message)}</strong></div>`;
    }
  };

  // ========================================================================
  // MY TRAINING -- what one person has to do, for the person themselves.
  //
  // This is the page an employee account exists for, so it has to stand on
  // its own: what is required, why, by when, and what to do about it. It
  // deliberately shows a self-report as a CLAIM awaiting a check rather than
  // as a tick, because a certificate is only earned on verified completion.
  // ========================================================================
  const T = { data: null, mount: null, busy: false, flash: null, open: null, err: null };

  function trStyles() {
    if (document.getElementById("mytr-styles")) return;
    const el = document.createElement("style");
    el.id = "mytr-styles";
    el.textContent = `
      .mytr-strip{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px;}
      .mytr-stat{flex:1 1 120px;min-width:120px;border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--surface);}
      .mytr-stat b{display:block;font-size:22px;line-height:1.1;}
      .mytr-stat span{font-size:12px;color:var(--text-muted);}
      .mytr-card{border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:12px;background:var(--surface);}
      .mytr-top{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between;}
      .mytr-title{font-weight:600;font-size:15.5px;}
      .mytr-why{font-size:12.5px;color:var(--text-muted);margin-top:2px;}
      .mytr-sum{font-size:13.5px;margin:8px 0 0;color:var(--text);}
      .mytr-badge{font-size:11.5px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;
        padding:3px 9px;border-radius:999px;white-space:nowrap;}
      .mytr-overdue{background:#fee2e2;color:#991b1b;}
      .mytr-due{background:#fef3c7;color:#92400e;}
      .mytr-submitted{background:#e0f2fe;color:#075985;}
      .mytr-complete{background:#dcfce7;color:#166534;}
      .mytr-none{background:#f1f5f9;color:#475569;}
      .mytr-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}
      .mytr-note{font-size:12.5px;color:var(--text-muted);margin-top:8px;}
      .mytr-form{margin-top:12px;border-top:1px solid var(--border);padding-top:12px;}
      .mytr-row{display:flex;flex-wrap:wrap;gap:10px;}
      .mytr-row label{font-size:12px;color:var(--text-muted);display:block;}
      .mytr-row input{padding:7px 9px;border:1px solid var(--border);border-radius:8px;font:inherit;max-width:100%;}
      .mytr-hist{margin-top:10px;font-size:12.5px;color:var(--text-muted);}
      .mytr-hist table{border-collapse:collapse;width:100%;margin-top:6px;}
      .mytr-hist th,.mytr-hist td{text-align:left;padding:4px 8px 4px 0;font-weight:400;}
      .mytr-flash{border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:13.5px;}
      .mytr-err{border:1px solid #fecaca;background:#fef2f2;color:#991b1b;border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:13.5px;}
      @media (max-width:640px){
        .mytr-stat{flex:1 1 calc(50% - 10px);}
        .mytr-top{flex-direction:column;align-items:flex-start;}
      }`;
    document.head.appendChild(el);
  }

  const BADGE = {
    overdue: ["mytr-overdue", "Overdue"],
    due: ["mytr-due", "Due"],
    submitted: ["mytr-submitted", "Waiting to be checked"],
    complete: ["mytr-complete", "Complete"],
    no_deadline: ["mytr-none", "No deadline set"],
    optional: ["mytr-none", "Optional"],
  };

  function whenText(r) {
    if (r.state === "complete") {
      const next = r.renewal_months && r.due_on ? ` · renews ${r.due_on}` : " · no renewal set";
      return `Completed ${r.completed_on}${next}`;
    }
    if (r.state === "submitted") {
      return `You reported completing this on ${r.submitted.completed_on}. It is waiting to be checked.`;
    }
    if (r.state === "overdue") {
      return `Was due ${r.due_on} — ${Math.abs(r.days_left)} day${Math.abs(r.days_left) === 1 ? "" : "s"} ago`;
    }
    if (r.state === "due") {
      return `Due ${r.due_on} — ${r.days_left} day${r.days_left === 1 ? "" : "s"} left`;
    }
    if (r.state === "optional") return "Optional — take it if you want it";
    return "No deadline has been set for this yet";
  }

  // What this person actually has to DO, which depends entirely on how the
  // course is delivered.
  function actionsFor(r) {
    const out = [];
    if (r.delivery === "policy_ack") {
      const acked = r.policy && r.policy.acknowledged_version && r.state !== "complete";
      out.push(`<a class="btn" href="#/policies">${acked ? "Read the new version and acknowledge it" : "Read and acknowledge the policy"}</a>`);
      if (acked) {
        out.push(`<span class="mytr-note">You acknowledged version ${esc(r.policy.acknowledged_version)};`
          + ` the current version is ${esc(r.policy.version)}.</span>`);
      }
      return out.join("");
    }
    if (r.external_url) {
      out.push(`<a class="btn" href="${esc(r.external_url)}" target="_blank" rel="noopener noreferrer">Open the training${r.provider ? ` at ${esc(r.provider)}` : ""}</a>`);
    }
    if (r.state !== "submitted" && r.can_self_report) {
      const label = r.delivery === "external_certificate" ? "File my certificate"
        : r.state === "complete" ? "Record a renewal" : "I have completed this";
      out.push(`<button class="btn btn-secondary mytr-report" data-c="${r.course_id}">${label}</button>`);
    }
    return out.join("");
  }

  function reportForm(r) {
    const cert = r.delivery === "external_certificate";
    return `<div class="mytr-form">
      <div class="mytr-row">
        <div><label for="mytr-on-${r.course_id}">Date completed</label>
          <input id="mytr-on-${r.course_id}" type="date" data-f="completed_on" max="${esc(new Date().toISOString().slice(0, 10))}" value="${esc(new Date().toISOString().slice(0, 10))}"></div>
        <div><label for="mytr-h-${r.course_id}">Hours (optional)</label>
          <input id="mytr-h-${r.course_id}" type="number" step="0.25" min="0" data-f="hours" style="width:110px;"></div>
        ${cert ? `<div><label for="mytr-x-${r.course_id}">Certificate expires</label>
          <input id="mytr-x-${r.course_id}" type="date" data-f="expires_on"></div>` : ""}
      </div>
      <div class="mytr-row" style="margin-top:8px;">
        <div style="flex:1 1 260px;"><label for="mytr-n-${r.course_id}">Anything to add (optional)</label>
          <input id="mytr-n-${r.course_id}" type="text" data-f="evidence_note" placeholder="${cert ? "Certificate number, or where you have sent it" : "Where you took it, for example"}" style="width:100%;"></div>
      </div>
      <div class="mytr-acts">
        <button class="btn mytr-send" data-c="${r.course_id}">Send it to HR</button>
        <button class="btn btn-secondary mytr-cancel">Cancel</button>
      </div>
      <div class="mytr-note">This tells HR you have done it. They check it before it counts as complete${cert ? " — have the certificate ready to hand over" : ""}.</div>
    </div>`;
  }

  function historyHtml(r) {
    if (!r.history.length) return "";
    return `<details class="mytr-hist"><summary>Your record for this course (${r.history.length})</summary>
      <table><thead><tr><th>Completed</th><th>How</th><th>Hours</th><th>Checked</th></tr></thead><tbody>
      ${r.history.slice().reverse().map((h) => `<tr>
        <td>${esc(h.completed_on)}</td>
        <td>${esc(h.source === "self_report" ? "You reported it" : h.source === "recorded" ? "HR recorded it" : h.source)}</td>
        <td>${h.hours == null ? "—" : esc(h.hours)}</td>
        <td>${h.verified_at ? `Yes, by ${esc(h.verified_by)}` : "Not yet"}</td>
      </tr>`).join("")}
      </tbody></table></details>`;
  }

  function cardHtml(r) {
    const [cls, label] = BADGE[r.state] || BADGE.no_deadline;
    return `<div class="mytr-card" data-course="${r.course_id}">
      <div class="mytr-top">
        <div><div class="mytr-title">${esc(r.title)}</div>
          <div class="mytr-why">${esc(r.required_because)} · ${esc(r.delivery_label)}</div></div>
        <span class="mytr-badge ${cls}">${label}</span>
      </div>
      ${r.summary ? `<p class="mytr-sum">${esc(r.summary)}</p>` : ""}
      <div class="mytr-note">${esc(whenText(r))}</div>
      ${r.superseded ? `<div class="mytr-note">You completed version ${r.earned_version} of this; it is now at version ${r.version}. It still counts unless Spectrum Squad asks you to retake it.</div>` : ""}
      ${r.delivery === "internal" && !r.external_url ? `<div class="mytr-note">The material for this is being added here. Until then, ask HR how to take it.</div>` : ""}
      <div class="mytr-acts">${actionsFor(r)}</div>
      ${T.open === r.course_id ? reportForm(r) : ""}
      ${historyHtml(r)}
    </div>`;
  }

  function trRender() {
    const d = T.data;
    const head = `<div class="page-head"><div><h1>My Training</h1>
      <p>Your required compliance training, and your own record of what you have completed.</p></div></div>`;
    if (!d.linked) {
      T.mount.innerHTML = head + `<div class="card" style="max-width:640px;"><div class="empty-state" style="padding:26px 20px;text-align:left;">
        <strong style="display:block;margin-bottom:6px;">We cannot work out your training yet.</strong>
        <span style="color:var(--text-muted);font-size:13.5px;">${esc(d.message || "")}</span></div></div>`;
      return;
    }
    const s = d.summary;
    const emp = d.employee;
    const who = [emp.position_label || emp.role_title, emp.department].filter(Boolean).join(" · ");
    const stat = (n, label) => `<div class="mytr-stat"><b>${n}</b><span>${label}</span></div>`;
    const body = !d.required.length && !d.optional.length
      ? `<div class="card" style="max-width:640px;"><div class="empty-state" style="padding:26px 20px;text-align:left;">
          <strong style="display:block;margin-bottom:6px;">No training is required of you right now.</strong>
          <span style="color:var(--text-muted);font-size:13.5px;">When Spectrum Squad requires a course of
          ${esc(emp.position_label || "your position")}, it will appear here with what it covers and when it is due.</span></div></div>`
      : `<div class="mytr-strip">
          ${s.overdue ? stat(s.overdue, "overdue") : ""}
          ${s.due ? stat(s.due, "coming up") : ""}
          ${s.submitted ? stat(s.submitted, "waiting to be checked") : ""}
          ${stat(s.complete, "complete")}
          ${stat(s.total, "required of you")}
        </div>
        ${d.required.map(cardHtml).join("")}
        ${d.optional.length ? `<h2 style="font-size:16px;margin:22px 0 10px;">Optional professional development</h2>
          ${d.optional.map(cardHtml).join("")}` : ""}`;
    T.mount.innerHTML = head
      + (T.flash ? `<div class="mytr-flash">${esc(T.flash)}</div>` : "")
      + (T.err ? `<div class="mytr-err">${esc(T.err)}</div>` : "")
      + (who ? `<p class="mytr-note" style="margin:-6px 0 14px;">${esc(emp.name)} — ${esc(who)}</p>` : "")
      + body;
    T.flash = null;
    T.err = null;
    wireTraining();
  }

  function wireTraining() {
    T.mount.querySelectorAll(".mytr-report").forEach((b) => b.addEventListener("click", () => {
      T.open = Number(b.dataset.c); trRender();
    }));
    T.mount.querySelectorAll(".mytr-cancel").forEach((b) => b.addEventListener("click", () => {
      T.open = null; trRender();
    }));
    T.mount.querySelectorAll(".mytr-send").forEach((b) => b.addEventListener("click", async () => {
      if (T.busy) return;
      const card = b.closest(".mytr-card");
      const body = {};
      card.querySelectorAll("[data-f]").forEach((i) => { if (i.value) body[i.dataset.f] = i.value; });
      T.busy = true; b.disabled = true; b.textContent = "Sending…";
      try {
        await api(`/api/compliance/my-training/${Number(b.dataset.c)}/report`, { method: "POST", body });
        T.open = null;
        T.flash = "Thank you — that has gone to HR to be checked. It will show as complete once they have.";
        await trReload();
      } catch (e) {
        T.err = e.message;
        trRender();
      } finally { T.busy = false; }
    }));
  }

  async function trReload() {
    T.data = await api("/api/compliance/my-training");
    trRender();
  }

  window.__renderMyTraining = async function (mount) {
    trStyles();
    T.mount = mount;
    T.open = null;
    mount.innerHTML = `<div class="cmp-empty">Loading your training…</div>`;
    try {
      await trReload();
    } catch (e) {
      mount.innerHTML = `<div class="mytr-err">${esc(e.message)}</div>`;
    }
  };
})();
