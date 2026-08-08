// financial-center.js -- Owner-only Financial Center (advisor).
// Rewritten to drop the ClickUp integration. Reads uploaded bank / QuickBooks
// (CSV) + Rethink payroll (.xlsx) data via /api/fin/* and presents a plain-
// English money advisor: overview, budgets & goals, wage-cost simulator, and
// "where you're losing money" insights. The native router in index.html calls
// window.__renderFinancialCenter(mount) directly (first-class route).

function canViewFinancial() {
  if (typeof state === "undefined" || !state.user) return false;
  if (["owner", "super_admin"].includes(state.user.role)) return true;
  // An explicit per-user grant from the Access editor also opens it. The
  // server enforces the same rule; this only keeps the UI in step.
  try {
    const ma = typeof state.user.module_access === "string" ? JSON.parse(state.user.module_access) : state.user.module_access;
    return !!ma && ma["financial-center"] === true;
  } catch (e) { return false; }
}

(function () {
  "use strict";
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function money(n) { const v = Math.round((Number(n) || 0) * 100) / 100; return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function curMonth() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
  function monthLabel(m) { if (!m) return ""; const [y, mo] = m.split("-"); const n = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]; return (n[+mo] || mo) + " " + y; }

  let month = curMonth();
  let tab = "overview";

  const TABS = [
    { key: "overview", label: "Overview" },
    { key: "reconcile", label: "Reconciliation" },
    { key: "documents", label: "Documents" },
    { key: "transactions", label: "Transactions" },
    { key: "budgets", label: "Budgets & Goals" },
    { key: "wagesim", label: "Wage Simulator" },
  ];

  function shell(inner) {
    return `<div class="page-header">
        <div><h1>💰 Financial Center</h1><p>Owner-only. Upload your bank, QuickBooks, and payroll exports to see where the money goes — in plain English.</p></div>
        <input type="month" id="fc-month" value="${month}" />
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; border-bottom:1px solid var(--border,#e5e7eb); margin-bottom:16px;">
        ${TABS.map((t) => `<button class="fc-tab" data-fc-tab="${t.key}" style="background:none; border:none; border-bottom:3px solid ${t.key === tab ? "var(--brand-navy,#1b2a6b)" : "transparent"}; color:${t.key === tab ? "var(--brand-navy,#1b2a6b)" : "var(--text-muted)"}; font-weight:700; font-size:13.5px; padding:8px 12px; cursor:pointer;">${t.label}</button>`).join("")}
      </div>
      <div id="fc-body">${inner}</div>`;
  }

  async function render(mount) {
    if (!canViewFinancial()) { mount.innerHTML = `<div class="page-header"><div><h1>Financial Center</h1></div></div><div class="empty-state">Financials are owner-only.</div>`; return; }
    mount.innerHTML = shell(`<div class="empty-state">Loading…</div>`);
    mount.querySelector("#fc-month").addEventListener("change", (e) => { month = e.target.value || curMonth(); render(mount); });
    mount.querySelectorAll("[data-fc-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.fcTab; render(mount); }));
    const body = mount.querySelector("#fc-body");
    try {
      if (tab === "overview") await renderOverview(body, mount);
      else if (tab === "reconcile") await renderReconcile(body, mount);
      else if (tab === "documents") await renderDocuments(body, mount);
      else if (tab === "transactions") await renderTransactions(body, mount);
      else if (tab === "budgets") await renderBudgets(body);
      else if (tab === "wagesim") renderWageSim(body);
    } catch (e) { body.innerHTML = `<div class="empty-state">Couldn't load: ${esc(e.message)}</div>`; }
  }

  function tile(val, label, color) {
    return `<div style="flex:1; min-width:150px; background:var(--bg,#f7f8fb); border:1px solid var(--border,#e5e7eb); border-radius:12px; padding:16px 18px;">
      <div style="font-size:26px; font-weight:800; color:${color || "var(--brand-navy,#1b2a6b)"};">${val}</div>
      <div style="font-size:12.5px; color:var(--text-muted);">${label}</div></div>`;
  }

  async function renderOverview(body, mount) {
    const d = await api("/api/fin/overview?month=" + encodeURIComponent(month));
    const insightColor = { good: "#166534", warn: "#92400e", bad: "#991b1b", info: "#3730a3" };
    const insightBg = { good: "#dcfce7", warn: "#fef3c7", bad: "#fee2e2", info: "#e0e7ff" };
    const cats = d.categories.length ? d.categories.map((c) => {
      const pct = c.budget ? Math.min(100, Math.round((c.spent / c.budget) * 100)) : 0;
      return `<div style="margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:3px;">
          <span>${esc(c.category)}</span>
          <strong>${money(c.spent)}${c.budget ? ` <span style="color:var(--text-muted); font-weight:400;">/ ${money(c.budget)}</span>` : ""}</strong>
        </div>
        ${c.budget ? `<div style="background:#eef0f5; border-radius:999px; height:8px; overflow:hidden;"><div style="width:${pct}%; height:8px; border-radius:999px; background:${c.over ? "#dc2626" : "var(--brand-navy,#1b2a6b)"};"></div></div>` : ""}
      </div>`;
    }).join("") : `<div class="empty-state">No expenses recorded for ${esc(monthLabel(month))} yet.</div>`;

    const recon = d.payroll_recon ? `<div class="card" style="margin-top:16px;">
      <div class="section-title" style="margin-top:0;">Payroll reconciliation</div>
      <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:8px;">
        ${tile(money(d.payroll_recon.rethink_gross), "Rethink gross")}
        ${tile(money(d.payroll_recon.bank_payroll), "Bank payroll")}
        ${tile(money(d.payroll_recon.difference), "Difference", Math.abs(d.payroll_recon.difference) < 1 ? "#166534" : "#b45309")}
      </div>
      <div style="font-size:12.5px; color:var(--text-muted);">${esc(d.payroll_recon.note)}</div>
    </div>` : "";

    body.innerHTML = `
      <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px;">
        ${tile(money(d.income), "Income", "#166534")}
        ${tile(money(d.expense), "Expenses", "#991b1b")}
        ${tile(money(d.net), d.net >= 0 ? "Kept (profit)" : "Shortfall", d.net >= 0 ? "#166534" : "#991b1b")}
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px;">
        <button class="btn secondary" id="fc-up-bank">⬆ Upload bank / QuickBooks (CSV or PDF)</button>
        <button class="btn secondary" id="fc-up-payroll">⬆ Upload Rethink payroll (.xlsx)</button>
        <span id="fc-up-status" style="font-size:12.5px; color:var(--text-muted); align-self:center;"></span>
      </div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
        <div class="card" style="margin:0;">
          <div class="section-title" style="margin-top:0;">What the numbers say</div>
          ${d.insights.map((i) => `<div style="background:${insightBg[i.level] || "#eef0f5"}; color:${insightColor[i.level] || "#333"}; border-radius:8px; padding:9px 12px; font-size:12.5px; margin-bottom:8px;">${esc(i.text)}</div>`).join("") || `<div class="empty-state">—</div>`}
        </div>
        <div class="card" style="margin:0;">
          <div class="section-title" style="margin-top:0;">Spending by category (vs. budget)</div>
          ${cats}
        </div>
      </div>
      ${recon}`;

    body.querySelector("#fc-up-bank").addEventListener("click", () => uploadCsv(mount));
    body.querySelector("#fc-up-payroll").addEventListener("click", () => uploadPayroll(mount));
  }

  function uploadCsv(mount) {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".csv,text/csv,.pdf,application/pdf";
    inp.addEventListener("change", () => {
      const f = inp.files[0]; if (!f) return;
      const st = mount.querySelector("#fc-up-status");
      const isPdf = /\.pdf$/i.test(f.name) || f.type === "application/pdf";
      const r = new FileReader();

      if (isPdf) {
        // PDF statements get a confirm-before-saving preview: layouts vary a lot
        // more than CSV, so the figures get checked before they hit the books.
        if (st) st.textContent = "Reading PDF…";
        r.onload = async () => {
          try {
            const res = await api("/api/fin/parse-pdf", {
              method: "POST",
              body: { content_base64: String(r.result).split(",")[1] },
            });
            if (st) st.textContent = "";
            showPdfPreview(mount, res.txns || [], f.name);
          } catch (e) { if (st) st.textContent = e.message || "Could not read that PDF."; }
        };
        r.readAsDataURL(f);
        return;
      }

      if (st) st.textContent = "Importing…";
      r.onload = async () => {
        try {
          const res = await api("/api/fin/import", { method: "POST", body: { csv: String(r.result), source: "bank" } });
          if (st) st.textContent = `Imported ${res.imported} transactions.`;
          if (res.months && res.months.length && res.months.indexOf(month) < 0) month = res.months[0];
          render(mount);
        } catch (e) { if (st) st.textContent = e.message || "Import failed."; }
      };
      r.readAsText(f);
    });
    inp.click();
  }

  // Preview + confirm for PDF statements. Each row can be flipped between
  // money in / money out, or dropped entirely, before anything is saved.
  function showPdfPreview(mount, txns, fileName) {
    if (!txns.length) return;
    const back = document.createElement("div");
    back.style.cssText = "position:fixed; inset:0; background:rgba(15,20,45,0.45); z-index:9000; display:flex; align-items:center; justify-content:center; padding:24px;";
    const money2 = (n) => (n < 0 ? "-" : "") + "$" + Math.abs(Number(n) || 0).toFixed(2);
    back.innerHTML = `
      <div style="background:#fff; border-radius:12px; max-width:900px; width:100%; max-height:86vh; display:flex; flex-direction:column; box-shadow:0 18px 50px rgba(0,0,0,0.3);">
        <div style="padding:16px 20px; border-bottom:1px solid #e6e8f0;">
          <div style="font-weight:600; font-size:15px;">Check these before saving</div>
          <div style="font-size:12.5px; color:#666; margin-top:3px;">
            Found <strong>${txns.length}</strong> transactions in ${esc(fileName)}.
            PDF statements don't always say which way the money went &mdash; fix any that look wrong, then save.
          </div>
        </div>
        <div style="overflow:auto; padding:6px 20px; flex:1;">
          <table class="data-table" style="width:100%; font-size:12.5px;">
            <thead><tr><th>Date</th><th>Description</th><th style="text-align:right;">Amount</th><th>Direction</th><th></th></tr></thead>
            <tbody id="fcp-rows">
              ${txns.map((t, i) => `
                <tr data-i="${i}">
                  <td style="white-space:nowrap;">${esc(t.txn_date)}</td>
                  <td>${esc(t.description)}</td>
                  <td style="text-align:right; white-space:nowrap;" data-amt>${money2(t.amount)}</td>
                  <td>
                    <select data-dir style="font-size:12px;">
                      <option value="out"${t.amount < 0 ? " selected" : ""}>Money out</option>
                      <option value="in"${t.amount >= 0 ? " selected" : ""}>Money in</option>
                    </select>
                  </td>
                  <td><button class="btn small secondary" data-drop>Remove</button></td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div style="padding:14px 20px; border-top:1px solid #e6e8f0; display:flex; justify-content:flex-end; gap:8px;">
          <span id="fcp-status" style="margin-right:auto; font-size:12.5px; color:#666;"></span>
          <button class="btn secondary" id="fcp-cancel">Cancel</button>
          <button class="btn" id="fcp-save">Save transactions</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const close = () => back.remove();

    back.querySelectorAll("[data-drop]").forEach((b) => {
      b.addEventListener("click", () => { b.closest("tr").remove(); });
    });
    back.querySelectorAll("[data-dir]").forEach((sel) => {
      sel.addEventListener("change", () => {
        const tr = sel.closest("tr");
        const i = Number(tr.dataset.i);
        const mag = Math.abs(Number(txns[i].amount) || 0);
        txns[i].amount = sel.value === "in" ? mag : -mag;
        tr.querySelector("[data-amt]").textContent = money2(txns[i].amount);
      });
    });
    back.querySelector("#fcp-cancel").addEventListener("click", close);
    back.querySelector("#fcp-save").addEventListener("click", async () => {
      const keep = [...back.querySelectorAll("#fcp-rows tr")].map((tr) => txns[Number(tr.dataset.i)]);
      const st2 = back.querySelector("#fcp-status");
      if (!keep.length) { st2.textContent = "Nothing left to save."; return; }
      st2.textContent = "Saving…";
      try {
        const res = await api("/api/fin/import", { method: "POST", body: { txns: keep, source: "pdf" } });
        close();
        const st = mount.querySelector("#fc-up-status");
        if (st) st.textContent = `Imported ${res.imported} transactions.`;
        if (res.months && res.months.length && res.months.indexOf(month) < 0) month = res.months[0];
        render(mount);
      } catch (e) { st2.textContent = e.message || "Import failed."; }
    });
  }

  function uploadPayroll(mount) {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".xlsx";
    inp.addEventListener("change", () => {
      const f = inp.files[0]; if (!f) return;
      const st = mount.querySelector("#fc-up-status"); if (st) st.textContent = "Importing payroll…";
      const r = new FileReader();
      r.onload = async () => {
        try {
          const res = await api("/api/fin/import-payroll", { method: "POST", body: { month, content_base64: String(r.result).split(",")[1] } });
          if (st) st.textContent = `Payroll gross ${money(res.gross)} recorded for ${monthLabel(res.month)}.`;
          render(mount);
        } catch (e) { if (st) st.textContent = e.message || "Import failed."; }
      };
      r.readAsDataURL(f);
    });
    inp.click();
  }

  async function renderTransactions(body, mount) {
    const d = await api("/api/fin/transactions?month=" + encodeURIComponent(month));
    const opts = (sel) => d.categories.map((c) => `<option ${c === sel ? "selected" : ""}>${esc(c)}</option>`).join("");
    body.innerHTML = `<div class="card">
      <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:12.5px;">
        <thead><tr style="text-align:left; color:var(--text-muted); font-size:11px; text-transform:uppercase;">
          <th style="padding:6px 8px;">Date</th><th style="padding:6px 8px;">Description</th><th style="padding:6px 8px; text-align:right;">Amount</th><th style="padding:6px 8px;">Category</th><th></th>
        </tr></thead><tbody>
        ${d.transactions.length ? d.transactions.map((t) => `<tr>
          <td style="padding:6px 8px; border-top:1px solid var(--border,#eee);">${esc((t.txn_date || "").slice(0, 10))}</td>
          <td style="padding:6px 8px; border-top:1px solid var(--border,#eee);">${esc(t.description)}</td>
          <td style="padding:6px 8px; border-top:1px solid var(--border,#eee); text-align:right; color:${Number(t.amount) >= 0 ? "#166534" : "#991b1b"}; font-weight:600;">${money(t.amount)}</td>
          <td style="padding:6px 8px; border-top:1px solid var(--border,#eee);"><select data-cat="${t.id}">${opts(t.category)}</select></td>
          <td style="padding:6px 8px; border-top:1px solid var(--border,#eee);"><button class="btn small secondary" data-del="${t.id}">✕</button></td>
        </tr>`).join("") : `<tr><td colspan="5"><div class="empty-state">No transactions for ${esc(monthLabel(month))}. Upload a CSV on the Overview tab.</div></td></tr>`}
        </tbody></table></div>
    </div>`;
    body.querySelectorAll("[data-cat]").forEach((sel) => sel.addEventListener("change", async () => {
      try { await api("/api/fin/transactions/" + sel.dataset.cat, { method: "PATCH", body: { category: sel.value } }); } catch (e) { alert(e.message); }
    }));
    body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Delete this transaction?")) return;
      try { await api("/api/fin/transactions/" + b.dataset.del, { method: "DELETE" }); renderTransactions(body, mount); } catch (e) { alert(e.message); }
    }));
  }

  async function renderBudgets(body) {
    const d = await api("/api/fin/budgets");
    const map = {}; d.budgets.forEach((b) => { map[b.category] = b.monthly_limit; });
    body.innerHTML = `<div class="card">
      <div class="section-title" style="margin-top:0;">Monthly budgets &amp; goals</div>
      <p style="font-size:12.5px; color:var(--text-muted); margin-top:0;">Set a monthly spending limit per category. The Overview tab shows actual vs. budget and flags anything over.</p>
      <div class="form-grid" style="gap:10px;">
        ${d.categories.filter((c) => c !== "Income").map((c) => `<div class="field"><label>${esc(c)}</label>
          <div style="display:flex; gap:6px;"><input type="number" step="1" data-budget="${esc(c)}" value="${map[c] != null ? map[c] : ""}" placeholder="0" style="flex:1;" /><button class="btn small secondary" data-save-budget="${esc(c)}">Save</button></div></div>`).join("")}
      </div>
    </div>`;
    body.querySelectorAll("[data-save-budget]").forEach((b) => b.addEventListener("click", async () => {
      const cat = b.dataset.saveBudget;
      const val = body.querySelector(`[data-budget="${cat}"]`).value || 0;
      b.disabled = true; b.textContent = "…";
      try { await api("/api/fin/budgets", { method: "POST", body: { category: cat, monthly_limit: Number(val) } }); b.textContent = "✓"; }
      catch (e) { alert(e.message); b.textContent = "Save"; } finally { b.disabled = false; setTimeout(() => { b.textContent = "Save"; }, 1200); }
    }));
  }

  function renderWageSim(body) {
    body.innerHTML = `<div class="card" style="max-width:640px;">
      <div class="section-title" style="margin-top:0;">Wage cost simulator</div>
      <p style="font-size:12.5px; color:var(--text-muted); margin-top:0;">See what a hire (or a raise) really costs the company per month and year — including employer burden — and, for billable roles, the revenue and margin it could generate.</p>
      <div class="form-grid" style="gap:10px;">
        <div class="field"><label>Hourly rate ($)</label><input type="number" id="ws-rate" value="25" step="0.5" /></div>
        <div class="field"><label>Hours per week</label><input type="number" id="ws-hours" value="30" step="1" /></div>
        <div class="field"><label>How many people</label><input type="number" id="ws-count" value="1" step="1" /></div>
        <div class="field"><label>Employer burden %</label><input type="number" id="ws-burden" value="12" step="1" /></div>
      </div>
      <button class="btn" id="ws-go" style="margin-top:12px;">Calculate</button>
      <div id="ws-out" style="margin-top:16px;"></div>
    </div>`;
    body.querySelector("#ws-go").addEventListener("click", async () => {
      const out = body.querySelector("#ws-out"); out.innerHTML = `<div class="empty-state">Calculating…</div>`;
      try {
        const r = await api("/api/fin/wage-sim", { method: "POST", body: {
          rate: body.querySelector("#ws-rate").value, hours_per_week: body.querySelector("#ws-hours").value,
          count: body.querySelector("#ws-count").value, burden_pct: body.querySelector("#ws-burden").value,
        } });
        out.innerHTML = `<div style="display:flex; gap:12px; flex-wrap:wrap;">
          ${tile(money(r.monthly_total_cost), "Total monthly cost", "#991b1b")}
          ${tile(money(r.annual_total_cost), "Total annual cost", "#991b1b")}
          ${r.monthly_revenue_potential != null ? tile(money(r.monthly_revenue_potential), "Billable revenue potential/mo", "#166534") : ""}
          ${r.monthly_margin != null ? tile(money(r.monthly_margin), "Est. monthly margin", r.monthly_margin >= 0 ? "#166534" : "#991b1b") : ""}
        </div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:8px;">Monthly gross ${money(r.monthly_gross)} + burden ${money(r.monthly_burden)}.${r.rev_per_hour ? ` Revenue uses your avg $${r.rev_per_hour}/billable-hour setting.` : " Set an avg revenue/hour in Financial Settings to see revenue potential."}</div>`;
      } catch (e) { out.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
    });
  }


  // ================= RECONCILIATION =================
  // The point of this tab: does what the paperwork says match what the bank
  // actually did. Status is a traffic light, the explanation is plain English,
  // and every figure can be opened to show the rows it came from.
  const PILL = {
    MATCHED:      { bg: "#e9f9ee", fg: "#177a3c", label: "Matched" },
    DISCREPANCY:  { bg: "#fdecec", fg: "#a3282e", label: "Needs investigating" },
    INCOMPLETE:   { bg: "#fef3e0", fg: "#946213", label: "Not enough data yet" },
  };
  function pill(status) {
    const p = PILL[status] || PILL.INCOMPLETE;
    return `<span style="background:${p.bg}; color:${p.fg}; border-radius:999px; padding:3px 11px; font-size:11.5px; font-weight:700;">${p.label}</span>`;
  }
  function figure(label, value, opts) {
    const o = opts || {};
    return `<div style="min-width:132px;">
      <div style="font-size:11.5px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em;">${esc(label)}</div>
      <div style="font-size:${o.big ? "21px" : "17px"}; font-weight:${o.big ? 800 : 700}; color:${o.color || "var(--brand-navy,#1b2a6b)"};">${value}</div>
    </div>`;
  }

  async function renderReconcile(body, mount) {
    body.innerHTML = `<div class="empty-state">Checking the numbers…</div>`;
    const d = await api("/api/fin/reconcile/overview");
    if (!d.months.length) {
      body.innerHTML = `<div class="card" style="margin:0;">
        <div class="section-title" style="margin-top:0;">Nothing to reconcile yet</div>
        <p style="font-size:13px; color:var(--text-muted);">Upload a bank statement and a payroll export on the <strong>Documents</strong> tab and this page will tell you whether they agree with each other.</p>
      </div>`;
      return;
    }
    body.innerHTML = d.months.map((m) => {
      const b = m.bank, p = m.payroll;
      const bankRow = `
        <div class="card" style="margin:0 0 12px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
            <div class="section-title" style="margin:0;">Bank — ${esc(monthLabel(m.month))}</div>
            ${pill(b.status)}
          </div>
          <div style="display:flex; gap:22px; flex-wrap:wrap; margin:12px 0 10px;">
            ${figure("Beginning", b.statement ? money(b.statement.beginning_balance) : "—")}
            ${figure("Money in", money(b.computed ? b.computed.deposits : 0), { color: "#177a3c" })}
            ${figure("Money out", money(b.computed ? b.computed.withdrawals : 0), { color: "#a3282e" })}
            ${figure("Fees", money(b.computed ? b.computed.fees : 0), { color: "#946213" })}
            ${figure("Should end at", b.expected_ending != null ? money(b.expected_ending) : "—", { big: true })}
            ${figure("Statement says", b.statement ? money(b.statement.ending_balance) : "—", { big: true })}
            ${b.difference != null && Math.abs(b.difference) >= 0.01 ? figure("Unexplained", money(b.difference), { big: true, color: "#a3282e" }) : ""}
          </div>
          <div style="font-size:13px; line-height:1.6; color:#2b2f3a; background:var(--bg,#f7f8fb); border-radius:10px; padding:12px 14px;">${esc(b.explanation)}</div>
          ${b.evidence && b.evidence.transaction_ids && b.evidence.transaction_ids.length
            ? `<button class="btn small secondary" style="margin-top:10px;" data-trace="transactions" data-ids="${b.evidence.transaction_ids.join(",")}">Show me the numbers (${b.evidence.transaction_ids.length} transactions)</button>` : ""}
        </div>`;
      const payRow = `
        <div class="card" style="margin:0 0 20px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
            <div class="section-title" style="margin:0;">Payroll — ${esc(monthLabel(m.month))}</div>
            ${pill(p.status)}
          </div>
          ${p.expected != null ? `<div style="display:flex; gap:22px; flex-wrap:wrap; margin:12px 0 10px;">
            ${figure("Payroll report says", money(p.expected), { big: true })}
            ${figure("Left the bank", money(p.actual), { big: true })}
            ${figure("Difference", money(p.difference), { big: true, color: Math.abs(p.difference || 0) < 0.01 ? "#177a3c" : "#a3282e" })}
            ${figure("Employees", p.employee_count == null ? "—" : p.employee_count)}
            ${p.totals ? figure("Hours paid", p.totals.hours ? p.totals.hours : "—") : ""}
          </div>` : ""}
          <div style="font-size:13px; line-height:1.6; color:#2b2f3a; background:var(--bg,#f7f8fb); border-radius:10px; padding:12px 14px;">${esc(p.explanation)}</div>
          ${p.matched_transactions && p.matched_transactions.length ? `
            <div style="margin-top:10px; font-size:12.5px;">
              <div style="color:var(--text-muted); margin-bottom:4px;">Withdrawals counted as payroll:</div>
              ${p.matched_transactions.map((t) => `<div style="display:flex; justify-content:space-between; gap:10px; padding:3px 0; border-bottom:1px dashed var(--border,#e5e7eb);"><span>${esc(t.date)} &middot; ${esc(t.description)}</span><span style="font-weight:600;">${money(t.amount)}</span></div>`).join("")}
            </div>` : ""}
          ${p.evidence && p.evidence.payroll_line_ids && p.evidence.payroll_line_ids.length
            ? `<button class="btn small secondary" style="margin-top:10px;" data-trace="payroll" data-ids="${p.evidence.payroll_line_ids.join(",")}">Show me the numbers (${p.evidence.payroll_line_ids.length} payroll rows)</button>` : ""}
        </div>`;
      return bankRow + payRow;
    }).join("");

    body.querySelectorAll("[data-trace]").forEach((b) =>
      b.addEventListener("click", () => showTrace(b.dataset.trace, b.dataset.ids)));
  }

  // Click a number, see exactly which source rows produced it — including the
  // untouched original line from the uploaded file.
  async function showTrace(kind, ids) {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal" style="width:900px; max-width:96vw;">
      <div class="modal-header"><h2>Where this number comes from</h2><button class="close-btn">✕</button></div>
      <div id="fc-trace-body"><div class="empty-state">Loading…</div></div>
    </div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector(".close-btn").addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    try {
      const d = await api(`/api/fin/trace?kind=${encodeURIComponent(kind)}&ids=${encodeURIComponent(ids)}`);
      const rows = d.rows || [];
      back.querySelector("#fc-trace-body").innerHTML = rows.length ? `
        <p style="font-size:12.5px; color:var(--text-muted); margin-top:0;">${rows.length} source record${rows.length === 1 ? "" : "s"}. The grey line under each is the original row exactly as it appeared in the file you uploaded.</p>
        <div style="max-height:60vh; overflow:auto;">
        ${rows.map((r) => `
          <div style="border-bottom:1px solid var(--border,#e5e7eb); padding:9px 0;">
            <div style="display:flex; justify-content:space-between; gap:12px; font-size:13px;">
              <span><strong>${esc(r.employee_name || r.description || r.client_name || "—")}</strong>
                ${r.txn_date ? ` &middot; ${esc(r.txn_date)}` : ""}${r.category ? ` &middot; ${esc(r.category)}` : ""}</span>
              <span style="font-weight:700; white-space:nowrap;">${money(r.amount != null ? r.amount : (r.total_employer_cost != null ? r.total_employer_cost : r.amount_billed))}</span>
            </div>
            <div style="font-size:11.5px; color:var(--text-muted); margin-top:3px;">
              ${esc(r.filename || "")} &middot; row ${esc(r.source_row)} &middot; confidence: ${esc(r.confidence || "—")}
            </div>
            <div style="font-family:ui-monospace,Menlo,monospace; font-size:11px; color:#555; background:var(--bg,#f7f8fb); border-radius:6px; padding:6px 8px; margin-top:5px; white-space:pre-wrap; word-break:break-word;">${esc(r.source_text || "")}</div>
          </div>`).join("")}
        </div>` : `<div class="empty-state">No source rows found.</div>`;
    } catch (e) {
      back.querySelector("#fc-trace-body").innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
    }
  }

  // ================= DOCUMENTS =================
  const DOC_LABELS = {
    bank_statement: "Bank statement", credit_card_statement: "Credit card statement",
    payroll: "Payroll", profit_loss: "Profit & Loss", billing_export: "Billing export",
    ar_aging: "A/R aging", claims_report: "Claims report", remittance: "Remittance / ERA",
    general_ledger: "General ledger", expense_report: "Expense report", invoice: "Invoice",
    merchant_statement: "Merchant statement", unknown: "Not identified",
  };
  const STATUS_STYLE = {
    processed: { bg: "#e9f9ee", fg: "#177a3c", label: "Imported" },
    needs_review: { bg: "#fef3e0", fg: "#946213", label: "Needs review" },
    failed: { bg: "#fdecec", fg: "#a3282e", label: "Couldn't read" },
    received: { bg: "#eef0f5", fg: "#555", label: "Received" },
  };

  async function renderDocuments(body, mount) {
    body.innerHTML = `<div class="empty-state">Loading…</div>`;
    const [d, unrec] = await Promise.all([
      api("/api/fin/documents"),
      api("/api/fin/unrecognized").catch(() => ({ rows: [], count: 0 })),
    ]);
    const docs = d.documents || [];
    body.innerHTML = `
      <div class="card" style="margin:0 0 16px;">
        <div class="section-title" style="margin-top:0;">Upload financial documents</div>
        <p style="font-size:13px; color:var(--text-muted); margin-top:0;">
          Bank and credit card statements, payroll exports, billing and claims exports, A/R aging, P&amp;L, general ledger, invoices.
          PDF, CSV and Excel. I work out what each one is, pull the rows out, and tell you what I couldn't read — nothing gets quietly dropped.
        </p>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn" id="fc-doc-upload">⬆ Upload documents</button>
          <span id="fc-doc-status" style="font-size:12.5px; color:var(--text-muted);"></span>
        </div>
      </div>

      ${unrec.count ? `<div class="card" style="margin:0 0 16px; border-left:4px solid #e0a430;">
        <div class="section-title" style="margin-top:0;">Rows I couldn't read (${unrec.count})</div>
        <p style="font-size:12.5px; color:var(--text-muted); margin-top:0;">These were in your files but I couldn't interpret them, so they are <strong>not</strong> counted in any total. Nothing was thrown away.</p>
        <div style="max-height:260px; overflow:auto;">
        ${unrec.rows.map((r) => `<div style="border-bottom:1px solid var(--border,#e5e7eb); padding:7px 0; font-size:12.5px;">
          <div><strong>${esc(r.filename || "")}</strong> &middot; row ${esc(r.source_row)} — ${esc(r.reason)}</div>
          <div style="font-family:ui-monospace,Menlo,monospace; font-size:11px; color:#555; margin-top:3px; word-break:break-word;">${esc(r.source_text || "")}</div>
          <button class="btn small secondary" style="margin-top:5px;" data-unrec="${r.id}">Mark handled</button>
        </div>`).join("")}
        </div>
      </div>` : ""}

      <div class="card" style="margin:0;">
        <div class="section-title" style="margin-top:0;">Document ledger</div>
        ${docs.length ? `<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:12.5px;">
          <thead><tr style="text-align:left; color:var(--text-muted);">
            <th style="padding:6px 8px;">File</th><th>Type</th><th>Period</th><th>Rows</th><th>Unreadable</th><th>Status</th><th>Uploaded</th><th></th>
          </tr></thead><tbody>
          ${docs.map((x) => {
            const st = STATUS_STYLE[x.status] || STATUS_STYLE.received;
            return `<tr style="border-top:1px solid var(--border,#e5e7eb);">
              <td style="padding:7px 8px;">${esc(x.filename)}</td>
              <td>${esc(DOC_LABELS[x.doc_type] || x.doc_type)}<div style="font-size:11px; color:var(--text-muted);">${esc(x.doc_type_confidence || "")}</div></td>
              <td>${x.period_start ? esc(x.period_start + " → " + (x.period_end || "")) : "—"}</td>
              <td>${x.record_count || 0}</td>
              <td style="color:${x.error_count ? "#a3282e" : "inherit"};">${x.error_count || 0}</td>
              <td><span style="background:${st.bg}; color:${st.fg}; border-radius:999px; padding:2px 9px; font-size:11px; font-weight:700;">${st.label}</span></td>
              <td>${esc(String(x.uploaded_at || "").slice(0, 10))}</td>
              <td style="white-space:nowrap;"><button class="btn small secondary" data-doc-del="${x.id}" style="color:#b91c1c;">Remove</button></td>
            </tr>${x.notes ? `<tr><td colspan="8" style="padding:0 8px 8px; font-size:12px; color:var(--text-muted);">${esc(x.notes)}</td></tr>` : ""}`;
          }).join("")}
          </tbody></table></div>` : `<div class="empty-state">No documents uploaded yet.</div>`}
      </div>`;

    body.querySelector("#fc-doc-upload").addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type = "file"; inp.multiple = true;
      inp.accept = ".pdf,.csv,.tsv,.txt,.xlsx,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      inp.addEventListener("change", async () => {
        const files = [...inp.files];
        if (!files.length) return;
        const st = body.querySelector("#fc-doc-status");
        let ok = 0; const problems = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          st.textContent = `Reading ${f.name} (${i + 1} of ${files.length})…`;
          try {
            const b64 = await new Promise((res, rej) => {
              const r = new FileReader();
              r.onload = () => res(String(r.result).split(",")[1]);
              r.onerror = () => rej(new Error("Could not read " + f.name));
              r.readAsDataURL(f);
            });
            await api("/api/fin/documents/upload", { method: "POST", body: { filename: f.name, content_base64: b64 } });
            ok++;
          } catch (e) { problems.push(`${f.name}: ${e.message}`); }
        }
        await renderDocuments(body, mount);
        const st2 = body.querySelector("#fc-doc-status");
        if (st2) st2.textContent = `Imported ${ok} document${ok === 1 ? "" : "s"}.` + (problems.length ? ` ${problems.join(" · ")}` : "");
      });
      inp.click();
    });

    body.querySelectorAll("[data-doc-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Remove this document and everything imported from it? Your other documents are unaffected.")) return;
      try { await api("/api/fin/documents/" + b.dataset.docDel, { method: "DELETE" }); renderDocuments(body, mount); }
      catch (e) { alert(e.message); }
    }));
    body.querySelectorAll("[data-unrec]").forEach((b) => b.addEventListener("click", async () => {
      try { await api("/api/fin/unrecognized/" + b.dataset.unrec + "/resolve", { method: "POST" }); renderDocuments(body, mount); }
      catch (e) { alert(e.message); }
    }));
  }

  window.__renderFinancialCenter = function (mount) { return render(mount); };
})();
