// financial-center.js -- Owner-only Financial Center (advisor).
// Rewritten to drop the ClickUp integration. Reads uploaded bank / QuickBooks
// (CSV) + Rethink payroll (.xlsx) data via /api/fin/* and presents a plain-
// English money advisor: overview, budgets & goals, wage-cost simulator, and
// "where you're losing money" insights. The native router in index.html calls
// window.__renderFinancialCenter(mount) directly (first-class route).

function canViewFinancial() {
  return typeof state !== "undefined" && !!state.user && ["owner", "super_admin"].includes(state.user.role);
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
        <button class="btn secondary" id="fc-up-bank">⬆ Upload bank / QuickBooks (CSV)</button>
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
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".csv,text/csv";
    inp.addEventListener("change", () => {
      const f = inp.files[0]; if (!f) return;
      const st = mount.querySelector("#fc-up-status"); if (st) st.textContent = "Importing…";
      const r = new FileReader();
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

  window.__renderFinancialCenter = function (mount) { return render(mount); };
})();
