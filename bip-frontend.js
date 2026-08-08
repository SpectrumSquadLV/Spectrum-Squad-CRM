// bip-frontend.js -- the Behavior Intervention Plan workspace, rendered inline
// inside the client card.
//
// The rule this file is written to: a BCBA should never leave the client's
// page. Everything here is an expandable section, an inline editor, a side
// panel or a drawer. No separate BIP page exists.
//
// Exposes window.__renderBipSection(container, clientId).

(function () {
  "use strict";

  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function nl2br(s) { return esc(s).replace(/\n/g, "<br>"); }
  function fmtDate(d) {
    if (!d) return "—";
    const t = Date.parse(String(d).slice(0, 10) + "T00:00:00Z");
    if (isNaN(t)) return String(d).slice(0, 10);
    return new Date(t).toLocaleDateString(undefined, { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  }
  function fmtWhen(d) {
    if (!d) return "";
    const t = Date.parse(d);
    if (isNaN(t)) return String(d).slice(0, 16).replace("T", " ");
    return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // Professional line icons, no emoji anywhere in this module.
  const ICON = {
    plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>',
    export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    behavior: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a5 5 0 0 0-5 5c0 1.6.8 3 2 3.9V13a3 3 0 1 0 6 0v-2.1c1.2-.9 2-2.3 2-3.9a5 5 0 0 0-5-5z"/><path d="M9 21h6"/><path d="M12 16v5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  };
  function icon(name, size) {
    return `<span class="bip-ico" style="width:${size || 16}px;height:${size || 16}px;">${ICON[name] || ""}</span>`;
  }

  const STATUS_STYLE = {
    active: { bg: "#e7f6ee", fg: "#177a3c", label: "Active" },
    draft: { bg: "#eef0f5", fg: "#5b6272", label: "Draft" },
    pending_review: { bg: "#fff2dd", fg: "#8a5d10", label: "Pending Review" },
    changes_requested: { bg: "#fdecec", fg: "#a3282e", label: "Changes Requested" },
    archived: { bg: "#eef0f5", fg: "#8a8797", label: "Archived" },
  };

  let STATE = {};   // per-open-client working state

  // ============================ STYLES ============================
  function styles() {
    return `<style id="bip-styles">
      .bip-wrap { --bip-navy:#1b2a6b; --bip-ink:#1f2430; --bip-muted:#6b7280; --bip-line:#e8eaf1;
        --bip-soft:#f7f8fc; --bip-accent:#4c63c7; margin: 4px 0 8px; }
      .bip-ico { display:inline-flex; align-items:center; justify-content:center; vertical-align:-2px; }
      .bip-ico svg { width:100%; height:100%; display:block; }

      .bip-shell { border:1px solid var(--bip-line); border-radius:18px; background:#fff;
        box-shadow:0 2px 14px rgba(27,42,107,.06); overflow:hidden; }

      .bip-top { padding:18px 20px 16px; background:linear-gradient(180deg,#fbfcff,#fff); border-bottom:1px solid var(--bip-line); }
      .bip-title { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .bip-title h3 { margin:0; font-size:15px; letter-spacing:.02em; text-transform:uppercase; color:var(--bip-navy); font-weight:800; }
      .bip-pill { border-radius:999px; padding:3px 11px; font-size:11.5px; font-weight:700; letter-spacing:.01em; }

      .bip-facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(126px,1fr)); gap:14px 18px; margin-top:14px; }
      .bip-fact .k { font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--bip-muted); font-weight:700; }
      .bip-fact .v { font-size:13.5px; color:var(--bip-ink); font-weight:600; margin-top:2px; }

      .bip-health { margin-top:16px; background:var(--bip-soft); border:1px solid var(--bip-line); border-radius:14px; padding:13px 15px; }
      .bip-bar { height:8px; border-radius:999px; background:#e6e9f2; overflow:hidden; margin:8px 0 0; }
      .bip-bar > i { display:block; height:100%; border-radius:999px; transition:width .5s cubic-bezier(.2,.8,.2,1); }
      .bip-issue { display:flex; gap:8px; align-items:flex-start; background:#fff; border:1px solid var(--bip-line);
        border-radius:10px; padding:8px 11px; margin-top:7px; font-size:12.5px; cursor:pointer; transition:border-color .15s, transform .15s; }
      .bip-issue:hover { border-color:var(--bip-accent); transform:translateX(2px); }

      .bip-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:15px; }
      .bip-btn { display:inline-flex; align-items:center; gap:7px; border-radius:11px; border:1px solid var(--bip-line);
        background:#fff; color:var(--bip-ink); font-size:12.5px; font-weight:650; padding:8px 13px; cursor:pointer;
        font-family:inherit; transition:border-color .15s, background .15s, transform .1s; }
      .bip-btn:hover { border-color:var(--bip-accent); color:var(--bip-accent); }
      .bip-btn:active { transform:scale(.98); }
      .bip-btn.primary { background:var(--bip-navy); border-color:var(--bip-navy); color:#fff; }
      .bip-btn.primary:hover { background:#22337f; color:#fff; }
      .bip-btn.ghost { background:transparent; }
      .bip-btn.sm { font-size:11.5px; padding:5px 10px; border-radius:9px; }
      .bip-btn[disabled] { opacity:.5; cursor:default; }

      .bip-jump { display:flex; gap:5px; flex-wrap:wrap; padding:10px 20px; border-bottom:1px solid var(--bip-line);
        background:#fcfdff; position:sticky; top:0; z-index:5; }
      .bip-jump button { border:none; background:transparent; font:inherit; font-size:12px; font-weight:650;
        color:var(--bip-muted); padding:5px 10px; border-radius:8px; cursor:pointer; transition:background .15s,color .15s; }
      .bip-jump button:hover { background:#eef1fb; color:var(--bip-navy); }

      .bip-sticky { display:none; position:sticky; top:38px; z-index:6; align-items:center; gap:10px; flex-wrap:wrap;
        padding:9px 20px; background:rgba(255,255,255,.94); backdrop-filter:blur(8px);
        border-bottom:1px solid var(--bip-line); }
      .bip-sticky.on { display:flex; }
      .bip-sticky .nm { font-weight:750; font-size:13px; color:var(--bip-navy); }

      .bip-sec { border-top:1px solid var(--bip-line); }
      .bip-sec:first-of-type { border-top:none; }
      .bip-sec > header { display:flex; align-items:center; gap:10px; padding:14px 20px; cursor:pointer; user-select:none;
        transition:background .15s; }
      .bip-sec > header:hover { background:#fbfcff; }
      .bip-sec > header .t { font-size:12.5px; font-weight:750; text-transform:uppercase; letter-spacing:.04em; color:var(--bip-ink); }
      .bip-sec > header .count { background:#eef1fb; color:var(--bip-accent); border-radius:999px; padding:1px 8px; font-size:11px; font-weight:700; }
      .bip-sec > header .chev { margin-left:auto; color:var(--bip-muted); transition:transform .25s cubic-bezier(.2,.8,.2,1); width:16px; height:16px; }
      .bip-sec.open > header .chev { transform:rotate(180deg); }
      .bip-sec > .body { display:none; padding:2px 20px 20px; }
      .bip-sec.open > .body { display:block; animation:bipIn .22s ease; }
      @keyframes bipIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }

      .bip-bcard { border:1px solid var(--bip-line); border-radius:15px; margin-bottom:11px; overflow:hidden; background:#fff;
        transition:box-shadow .18s, border-color .18s; }
      .bip-bcard:hover { box-shadow:0 5px 18px rgba(27,42,107,.08); }
      .bip-bcard > header { display:flex; align-items:center; gap:10px; padding:13px 15px; cursor:pointer; }
      .bip-bcard > header .nm { font-weight:700; font-size:14px; color:var(--bip-ink); }
      .bip-bcard > header .miss { background:#fff2dd; color:#8a5d10; border-radius:999px; padding:2px 9px; font-size:10.5px; font-weight:700; }
      .bip-bcard > header .ok { background:#e7f6ee; color:#177a3c; border-radius:999px; padding:2px 9px; font-size:10.5px; font-weight:700; }
      .bip-bcard > .body { display:none; padding:0 15px 15px; }
      .bip-bcard.open > .body { display:block; animation:bipIn .22s ease; }
      .bip-bcard.flash { border-color:var(--bip-accent); box-shadow:0 0 0 3px rgba(76,99,199,.14); }

      .bip-field { padding:9px 0; border-top:1px dashed var(--bip-line); }
      .bip-field:first-child { border-top:none; }
      .bip-field .k { font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--bip-muted); font-weight:700; display:flex; gap:7px; align-items:center; }
      .bip-field .v { font-size:13.5px; line-height:1.62; color:var(--bip-ink); margin-top:4px; white-space:pre-wrap; }
      .bip-field .v.empty { color:#a6abb8; font-style:italic; }
      .bip-field textarea, .bip-field input[type=text] { width:100%; font:inherit; font-size:13.5px; line-height:1.6;
        border:1px solid var(--bip-line); border-radius:10px; padding:9px 11px; margin-top:5px; background:#fff; resize:vertical; }
      .bip-field textarea:focus, .bip-field input:focus { outline:none; border-color:var(--bip-accent); box-shadow:0 0 0 3px rgba(76,99,199,.12); }
      .bip-core { background:#eef1fb; color:var(--bip-accent); border-radius:5px; padding:0 5px; font-size:9.5px; letter-spacing:.04em; }

      .bip-note { border:1px solid var(--bip-line); border-radius:12px; padding:11px 13px; margin-bottom:8px; background:#fff; }
      .bip-note .meta { font-size:11.5px; color:var(--bip-muted); display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .bip-note .cat { background:#eef1fb; color:var(--bip-accent); border-radius:999px; padding:1px 8px; font-size:10.5px; font-weight:700; }
      .bip-note .bd { font-size:13.5px; line-height:1.6; margin-top:6px; white-space:pre-wrap; color:var(--bip-ink); }

      .bip-q { border:1px solid var(--bip-line); border-left:3px solid #c9a227; border-radius:12px; padding:12px 14px; margin-bottom:9px; background:#fff; }
      .bip-q.answered { border-left-color:#217a5b; }
      .bip-q.resolved { border-left-color:#9aa0ad; }
      .bip-q .ans { background:#eef7f2; border-radius:10px; padding:10px 12px; margin-top:9px; font-size:13.5px; line-height:1.6; color:#14503a; }

      .bip-drawer { position:fixed; top:0; right:0; bottom:0; width:min(460px,94vw); background:#fff; z-index:12000;
        box-shadow:-16px 0 44px rgba(15,20,45,.22); display:flex; flex-direction:column; animation:bipSlide .26s cubic-bezier(.2,.8,.2,1); }
      @keyframes bipSlide { from { transform:translateX(100%); } to { transform:none; } }
      .bip-drawer header { padding:16px 20px; border-bottom:1px solid var(--bip-line); display:flex; align-items:center; gap:10px; }
      .bip-drawer header h4 { margin:0; font-size:15px; color:var(--bip-navy); }
      .bip-drawer .inner { padding:16px 20px; overflow:auto; flex:1; }
      .bip-drawer footer { padding:14px 20px; border-top:1px solid var(--bip-line); display:flex; gap:8px; align-items:center; }
      .bip-scrim { position:fixed; inset:0; background:rgba(15,20,45,.34); z-index:11999; animation:bipFade .2s ease; }
      @keyframes bipFade { from { opacity:0; } to { opacity:1; } }
      .bip-drawer label.fl { display:block; font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.04em;
        color:var(--bip-muted); margin:13px 0 5px; }
      .bip-drawer textarea, .bip-drawer input, .bip-drawer select { width:100%; font:inherit; font-size:13.5px;
        border:1px solid var(--bip-line); border-radius:10px; padding:9px 11px; background:#fff; }
      .bip-drawer textarea:focus, .bip-drawer input:focus, .bip-drawer select:focus { outline:none; border-color:var(--bip-accent); box-shadow:0 0 0 3px rgba(76,99,199,.12); }
      .bip-prefill { background:var(--bip-soft); border:1px solid var(--bip-line); border-radius:12px; padding:11px 13px; font-size:12.5px; color:var(--bip-muted); }
      .bip-prefill b { color:var(--bip-ink); }

      .bip-saved { display:inline-flex; align-items:center; gap:5px; color:#177a3c; font-size:12px; font-weight:650;
        opacity:0; transition:opacity .25s; }
      .bip-saved.on { opacity:1; }
      .bip-empty { text-align:center; padding:26px 18px; color:var(--bip-muted); font-size:13.5px; }
      .bip-hist { border-left:2px solid var(--bip-line); padding:0 0 14px 14px; position:relative; }
      .bip-hist::before { content:""; position:absolute; left:-5px; top:3px; width:8px; height:8px; border-radius:50%; background:var(--bip-accent); }
      .bip-diff { font-size:12px; line-height:1.55; margin-top:4px; }
      .bip-diff .old { color:#a3282e; text-decoration:line-through; }
      .bip-diff .new { color:#177a3c; }
    </style>`;
  }

  // ============================ RENDER ============================
  async function render(container, clientId) {
    container.innerHTML = `<div class="bip-wrap"><div class="bip-shell"><div class="bip-empty">Loading plan…</div></div></div>`;
    let d;
    try { d = await api(`/api/bip/client/${clientId}`); }
    catch (e) {
      container.innerHTML = `<div class="bip-wrap"><div class="bip-shell"><div class="bip-empty">${esc(e.message)}</div></div></div>`;
      return;
    }
    STATE[clientId] = d;

    if (!document.getElementById("bip-styles")) document.head.insertAdjacentHTML("beforeend", styles());

    if (!d.bip) { renderEmpty(container, clientId, d); return; }
    renderPlan(container, clientId, d);
  }

  function renderEmpty(container, clientId, d) {
    container.innerHTML = `
      <div class="bip-wrap"><div class="bip-shell">
        <div class="bip-top">
          <div class="bip-title">${icon("plan", 17)}<h3>Behavior Intervention Plan</h3>
            <span class="bip-pill" style="background:#eef0f5;color:#5b6272;">No BIP Found</span></div>
          <div style="font-size:13.5px;color:var(--bip-muted);margin-top:10px;max-width:60ch;">
            Nothing has been recorded for ${esc(d.client.child_name)} yet. Start one here and it stays on this card —
            no separate page, no other system.
          </div>
          <div class="bip-actions">
            ${d.can_edit ? `<button class="bip-btn primary" data-bip="create">${icon("plus", 15)} Create BIP</button>` : ""}
            <button class="bip-btn" data-bip="ask-empty">${icon("ask", 15)} Ask Clinical Director</button>
          </div>
        </div>
      </div></div>`;
    const create = container.querySelector('[data-bip="create"]');
    if (create) create.addEventListener("click", async () => {
      create.disabled = true;
      try { await api(`/api/bip/client/${clientId}`, { method: "POST", body: {} }); render(container, clientId); }
      catch (e) { alert(e.message); create.disabled = false; }
    });
    const ask = container.querySelector('[data-bip="ask-empty"]');
    if (ask) ask.addEventListener("click", () => alert("Create the BIP first, then you can ask the Clinical Director about it right from here."));
  }

  function renderPlan(container, clientId, d) {
    const { bip, behaviors, notes, questions, health, client } = d;
    const st = STATUS_STYLE[bip.status] || STATUS_STYLE.draft;
    const openQ = questions.filter((q) => q.status === "Awaiting Response" || q.status === "Follow-Up Needed").length;
    const openN = notes.filter((n) => n.status !== "resolved").length;
    const healthColor = health.percent >= 90 ? "#22a565" : health.percent >= 65 ? "#d99a1c" : "#d0553f";

    const jump = [
      ["overview", "Overview"], ["behaviors", "Target Behaviors"], ["safety", "Safety"],
      ["notes", "Notes"], ["questions", "Questions"], ["history", "History"],
    ];

    container.innerHTML = `
      <div class="bip-wrap"><div class="bip-shell" id="bip-shell">
        <div class="bip-top" id="bip-overview">
          <div class="bip-title">
            ${icon("plan", 17)}<h3>Behavior Intervention Plan</h3>
            <span class="bip-pill" style="background:${st.bg};color:${st.fg};">${st.label}</span>
            ${openQ ? `<span class="bip-pill" style="background:#fff2dd;color:#8a5d10;">${openQ} question${openQ === 1 ? "" : "s"} waiting</span>` : ""}
          </div>

          <div class="bip-facts">
            <div class="bip-fact"><div class="k">Last updated</div><div class="v">${fmtDate(bip.updated_at)}</div></div>
            <div class="bip-fact"><div class="k">By</div><div class="v">${esc(bip.last_updated_by || "—")}</div></div>
            <div class="bip-fact"><div class="k">Next review</div><div class="v" ${overdueStyle(bip.next_review_date)}>${fmtDate(bip.next_review_date)}</div></div>
            <div class="bip-fact"><div class="k">Assigned BCBA</div><div class="v">${esc(bip.assigned_bcba || "—")}</div></div>
            <div class="bip-fact"><div class="k">Target behaviors</div><div class="v">${behaviors.length}</div></div>
            <div class="bip-fact"><div class="k">Open notes</div><div class="v">${openN}</div></div>
          </div>

          <div class="bip-health">
            <div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;">
              <span style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--bip-muted);font-weight:700;">BIP Health</span>
              <span style="font-size:21px;font-weight:800;color:${healthColor};">${health.percent}%</span>
              <span style="font-size:12px;color:var(--bip-muted);">Complete</span>
              ${health.optional.total ? `<span style="margin-left:auto;font-size:11.5px;color:var(--bip-muted);">${health.optional.met} of ${health.optional.total} optional fields documented</span>` : ""}
            </div>
            <div class="bip-bar"><i style="width:${health.percent}%;background:${healthColor};"></i></div>
            ${health.issues.length ? `
              <div style="margin-top:11px;font-size:11.5px;font-weight:700;color:var(--bip-muted);text-transform:uppercase;letter-spacing:.04em;">
                ${health.issues.length} item${health.issues.length === 1 ? "" : "s"} need attention
              </div>
              ${health.issues.slice(0, 6).map((i) => `
                <div class="bip-issue" data-goto="${esc(i.anchor)}">
                  <span style="color:${i.severity === "high" ? "#d0553f" : "#d99a1c"};width:15px;height:15px;flex:none;">${ICON.alert}</span>
                  <span>${esc(i.text)}</span>
                </div>`).join("")}
              ${health.issues.length > 6 ? `<div style="font-size:11.5px;color:var(--bip-muted);margin-top:7px;">and ${health.issues.length - 6} more</div>` : ""}
            ` : `<div style="margin-top:10px;font-size:12.5px;color:#177a3c;display:flex;gap:6px;align-items:center;">${icon("check", 14)} Everything required is documented.</div>`}
          </div>

          <div class="bip-actions">
            ${d.can_edit ? `<button class="bip-btn primary" data-bip="add-behavior">${icon("plus", 15)} Add Target Behavior</button>` : ""}
            <button class="bip-btn" data-bip="add-note">${icon("note", 15)} Add Note</button>
            <button class="bip-btn" data-bip="ask">${icon("ask", 15)} Ask Clinical Director</button>
            <button class="bip-btn ghost" data-bip="history">${icon("history", 15)} View History</button>
            <button class="bip-btn ghost" data-bip="export">${icon("export", 15)} Export BIP</button>
            ${reviewButtons(d)}
            <span class="bip-saved" id="bip-saved">${icon("check", 13)} Saved</span>
          </div>

          ${changesRequestedBanner(d)}
        </div>

        <div class="bip-jump">
          ${jump.map(([a, l]) => `<button data-goto="${a}">${l}</button>`).join("")}
        </div>
        <div class="bip-sticky" id="bip-sticky">
          <span class="nm">${esc(client.child_name)}</span>
          <span class="bip-pill" style="background:${st.bg};color:${st.fg};">${st.label}</span>
          <span style="font-size:12px;color:var(--bip-muted);font-weight:650;">${health.percent}% complete</span>
          <span style="margin-left:auto;display:flex;gap:6px;">
            <button class="bip-btn sm" data-bip="add-note">${icon("note", 13)} Note</button>
            <button class="bip-btn sm primary" data-bip="ask">${icon("ask", 13)} Ask Director</button>
          </span>
        </div>

        ${section("behaviors", "Target Behaviors", behaviors.length, behaviorsHtml(d), true)}
        ${section("safety", "Safety Plan", null, safetyHtml(d))}
        ${section("notes", "Team Notes", notes.length, notesHtml(d))}
        ${section("questions", "Clinical Questions", questions.length, questionsHtml(d))}
        ${section("history", "Change History", null, `<div class="bip-empty">Open the history drawer to see every change with its before and after value.<div style="margin-top:11px;"><button class="bip-btn" data-bip="history">${icon("history", 15)} Open Change History</button></div></div>`)}
      </div></div>`;

    wire(container, clientId, d);
  }

  function overdueStyle(date) {
    if (!date) return "";
    const t = Date.parse(String(date).slice(0, 10) + "T00:00:00Z");
    if (isNaN(t)) return "";
    return t < Date.now() ? 'style="color:#d0553f;"' : "";
  }

  function reviewButtons(d) {
    const s = d.bip.status;
    let out = "";
    if (d.can_edit && s !== "pending_review") {
      out += `<button class="bip-btn" data-bip="submit-review">${icon("check", 15)} Submit for Review</button>`;
    }
    if (d.can_direct && s === "pending_review") {
      out += `<button class="bip-btn primary" data-bip="approve">${icon("check", 15)} Approve</button>`;
      out += `<button class="bip-btn" data-bip="request-changes">${icon("edit", 15)} Request Changes</button>`;
    }
    return out;
  }

  function changesRequestedBanner(d) {
    if (d.bip.status !== "changes_requested" || !d.review || !d.review.note) return "";
    return `<div style="margin-top:14px;background:#fdecec;border:1px solid #f3cfcf;border-radius:13px;padding:12px 15px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;font-weight:800;color:#a3282e;">Changes requested by ${esc(d.review.decided_by || "Clinical Director")}</div>
      <div style="font-size:13.5px;line-height:1.6;color:#7a2126;margin-top:5px;white-space:pre-wrap;">${esc(d.review.note)}</div>
      ${d.can_edit ? `<button class="bip-btn sm" style="margin-top:9px;" data-bip="submit-review">Resubmit</button>` : ""}
    </div>`;
  }

  function section(id, title, count, body, open) {
    return `<div class="bip-sec ${open ? "open" : ""}" id="bip-${id}">
      <header data-sec="${id}">
        <span class="t">${esc(title)}</span>
        ${count != null ? `<span class="count">${count}</span>` : ""}
        <span class="chev">${ICON.chevron}</span>
      </header>
      <div class="body">${body}</div>
    </div>`;
  }

  // ---------------- target behaviours ----------------
  function behaviorsHtml(d) {
    if (!d.behaviors.length) {
      return `<div class="bip-empty">No target behaviors yet.${d.can_edit ? `<div style="margin-top:11px;"><button class="bip-btn primary" data-bip="add-behavior">${icon("plus", 15)} Add the first one</button></div>` : ""}</div>`;
    }
    return d.behaviors.map((b) => {
      const missing = d.meta.fields.filter((f) => f.core && !String(b[f.key] || "").trim());
      return `<div class="bip-bcard" id="bip-behavior-${b.id}" data-bid="${b.id}">
        <header data-bcard="${b.id}">
          <span style="color:var(--bip-accent);width:16px;height:16px;flex:none;">${ICON.behavior}</span>
          <span class="nm">${esc(b.name)}</span>
          ${missing.length ? `<span class="miss">${missing.length} field${missing.length === 1 ? "" : "s"} missing</span>` : `<span class="ok">Complete</span>`}
          <span class="chev" style="margin-left:auto;width:16px;height:16px;color:var(--bip-muted);">${ICON.chevron}</span>
        </header>
        <div class="body">
          ${d.meta.fields.map((f) => fieldHtml(b, f, d.can_edit)).join("")}
          <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:13px;">
            <button class="bip-btn sm" data-bip="note-behavior" data-bid="${b.id}">${icon("note", 13)} Add Note</button>
            <button class="bip-btn sm" data-bip="ask-behavior" data-bid="${b.id}">${icon("ask", 13)} Ask Clinical Director</button>
            ${d.can_edit ? `<button class="bip-btn sm ghost" data-bip="delete-behavior" data-bid="${b.id}" style="margin-left:auto;color:#a3282e;">Remove</button>` : ""}
          </div>
        </div>
      </div>`;
    }).join("");
  }

  function fieldHtml(b, f, canEdit) {
    const val = String(b[f.key] == null ? "" : b[f.key]);
    const has = val.trim().length > 0;
    return `<div class="bip-field" data-field="${f.key}" data-bid="${b.id}">
      <div class="k">${esc(f.label)}${f.core ? `<span class="bip-core">REQUIRED</span>` : ""}</div>
      <div class="v ${has ? "" : "empty"}" data-view>${has ? nl2br(val) : "Not documented"}</div>
      ${canEdit ? `<div data-editor style="display:none;">
        <textarea rows="${f.long ? 4 : 2}" data-input>${esc(val)}</textarea>
        <div style="display:flex;gap:7px;margin-top:6px;">
          <button class="bip-btn sm primary" data-save>Save</button>
          <button class="bip-btn sm ghost" data-cancel>Cancel</button>
        </div>
      </div>
      <button class="bip-btn sm ghost" data-edit style="margin-top:6px;padding:3px 9px;">${icon("edit", 12)} ${has ? "Edit" : "Add"}</button>` : ""}
    </div>`;
  }

  // ---------------- safety ----------------
  function safetyHtml(d) {
    const rows = [["safety_plan", "Safety Plan"], ["crisis_procedures", "Crisis Procedures"], ["general_notes", "General Plan Notes"]];
    return rows.map(([key, label]) => {
      const val = String(d.bip[key] || "");
      const has = val.trim().length > 0;
      return `<div class="bip-field" data-bipfield="${key}">
        <div class="k">${icon("shield", 13)} ${esc(label)}</div>
        <div class="v ${has ? "" : "empty"}" data-view>${has ? nl2br(val) : "Not documented"}</div>
        ${d.can_edit ? `<div data-editor style="display:none;">
          <textarea rows="4" data-input>${esc(val)}</textarea>
          <div style="display:flex;gap:7px;margin-top:6px;">
            <button class="bip-btn sm primary" data-save>Save</button>
            <button class="bip-btn sm ghost" data-cancel>Cancel</button>
          </div>
        </div>
        <button class="bip-btn sm ghost" data-edit style="margin-top:6px;padding:3px 9px;">${icon("edit", 12)} ${has ? "Edit" : "Add"}</button>` : ""}
      </div>`;
    }).join("") + `
      <div class="bip-field">
        <div class="k">Next Review Date<span class="bip-core">REQUIRED</span></div>
        <input type="date" id="bip-review-date" value="${esc((d.bip.next_review_date || "").slice(0, 10))}"
          style="font:inherit;font-size:13.5px;border:1px solid var(--bip-line);border-radius:10px;padding:8px 11px;margin-top:5px;" ${d.can_edit ? "" : "disabled"} />
      </div>`;
  }

  // ---------------- notes ----------------
  function notesHtml(d) {
    const byId = {}; d.behaviors.forEach((b) => { byId[b.id] = b.name; });
    if (!d.notes.length) return `<div class="bip-empty">No notes yet. Notes stay attached to this plan.</div>`;
    return d.notes.map((n) => `
      <div class="bip-note" style="${n.status === "resolved" ? "opacity:.62;" : ""}">
        <div class="meta">
          <span class="cat">${esc(n.category || "Other")}</span>
          <strong style="color:var(--bip-ink);">${esc(n.author || "")}</strong>
          <span>${fmtWhen(n.created_at)}</span>
          ${n.behavior_id && byId[n.behavior_id] ? `<span>· ${esc(byId[n.behavior_id])}</span>` : ""}
          ${n.status === "resolved" ? `<span style="color:#177a3c;font-weight:700;">Resolved</span>` : ""}
          <button class="bip-btn sm ghost" style="margin-left:auto;" data-bip="toggle-note" data-nid="${n.id}" data-st="${n.status === "resolved" ? "open" : "resolved"}">
            ${n.status === "resolved" ? "Reopen" : "Mark resolved"}
          </button>
        </div>
        <div class="bd">${nl2br(n.body)}</div>
      </div>`).join("");
  }

  // ---------------- questions ----------------
  function questionsHtml(d) {
    const byId = {}; d.behaviors.forEach((b) => { byId[b.id] = b.name; });
    if (!d.questions.length) {
      return `<div class="bip-empty">Nothing asked yet. Use <strong>Ask Clinical Director</strong> and the answer comes back here.</div>`;
    }
    return d.questions.map((q) => {
      const cls = q.status === "Answered" ? "answered" : q.status === "Resolved" ? "resolved" : "";
      return `<div class="bip-q ${cls}" id="bip-question-${q.id}">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11.5px;color:var(--bip-muted);">
          <span class="bip-pill" style="background:${q.status === "Answered" ? "#e7f6ee" : q.status === "Resolved" ? "#eef0f5" : "#fff2dd"};color:${q.status === "Answered" ? "#177a3c" : q.status === "Resolved" ? "#5b6272" : "#8a5d10"};">${esc(q.status)}</span>
          ${q.urgency && q.urgency !== "Routine" ? `<span class="bip-pill" style="background:#fdecec;color:#a3282e;">${esc(q.urgency)}</span>` : ""}
          <strong style="color:var(--bip-ink);">${esc(q.asked_by || "")}</strong>
          <span>${fmtWhen(q.created_at)}</span>
          ${q.section ? `<span>· ${esc(q.section)}</span>` : ""}
          ${q.behavior_id && byId[q.behavior_id] ? `<span>· ${esc(byId[q.behavior_id])}</span>` : ""}
        </div>
        <div style="font-size:13.5px;line-height:1.6;margin-top:7px;color:var(--bip-ink);white-space:pre-wrap;">${esc(q.question)}</div>
        ${q.tried ? `<div style="font-size:12.5px;color:var(--bip-muted);margin-top:5px;"><strong>Tried:</strong> ${esc(q.tried)}</div>` : ""}
        ${q.context ? `<div style="font-size:12.5px;color:var(--bip-muted);margin-top:3px;"><strong>Context:</strong> ${esc(q.context)}</div>` : ""}
        ${q.response ? `<div class="ans"><div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:800;margin-bottom:4px;">Clinical Director response — ${esc(q.responded_by || "")}</div>${nl2br(q.response)}</div>` : ""}
        ${d.can_direct && !q.response ? `
          <div style="margin-top:9px;">
            <textarea rows="3" data-answer="${q.id}" placeholder="Write your response…" style="width:100%;font:inherit;font-size:13.5px;border:1px solid var(--bip-line);border-radius:10px;padding:9px 11px;"></textarea>
            <button class="bip-btn sm primary" style="margin-top:6px;" data-bip="answer" data-qid="${q.id}">Send Response</button>
          </div>` : ""}
        ${q.response && q.status !== "Resolved" ? `<button class="bip-btn sm ghost" style="margin-top:8px;" data-bip="resolve-q" data-qid="${q.id}">Mark resolved</button>` : ""}
      </div>`;
    }).join("");
  }

  // ============================ WIRING ============================
  function wire(container, clientId, d) {
    const shell = container.querySelector("#bip-shell");
    const flash = () => {
      const s = container.querySelector("#bip-saved");
      if (!s) return;
      s.classList.add("on");
      setTimeout(() => s.classList.remove("on"), 1600);
    };
    const reload = () => render(container, clientId);

    // accordions
    container.querySelectorAll("[data-sec]").forEach((h) =>
      h.addEventListener("click", () => h.parentElement.classList.toggle("open")));
    container.querySelectorAll("[data-bcard]").forEach((h) =>
      h.addEventListener("click", () => h.parentElement.classList.toggle("open")));

    // quick jump + health issue jumps
    container.querySelectorAll("[data-goto]").forEach((b) =>
      b.addEventListener("click", () => {
        const a = b.dataset.goto;
        let el = container.querySelector(`#bip-${a}`);
        if (a.startsWith("behavior-")) {
          const sec = container.querySelector("#bip-behaviors");
          if (sec) sec.classList.add("open");
          el = container.querySelector(`#bip-${a}`);
          if (el) { el.classList.add("open", "flash"); setTimeout(() => el.classList.remove("flash"), 1400); }
        } else if (el) el.classList.add("open");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }));

    // sticky header appears once the overview scrolls out of the modal viewport
    const modal = container.closest(".modal");
    const sticky = container.querySelector("#bip-sticky");
    const overview = container.querySelector("#bip-overview");
    if (modal && sticky && overview) {
      const onScroll = () => {
        const past = overview.getBoundingClientRect().bottom < modal.getBoundingClientRect().top + 70;
        sticky.classList.toggle("on", past);
      };
      modal.addEventListener("scroll", onScroll);
      onScroll();
    }

    // inline field editing (behaviors)
    container.querySelectorAll(".bip-field[data-field]").forEach((f) => {
      const editBtn = f.querySelector("[data-edit]");
      if (!editBtn) return;
      const editor = f.querySelector("[data-editor]");
      const view = f.querySelector("[data-view]");
      editBtn.addEventListener("click", () => { editor.style.display = "block"; editBtn.style.display = "none"; view.style.display = "none"; editor.querySelector("[data-input]").focus(); });
      f.querySelector("[data-cancel]").addEventListener("click", () => { editor.style.display = "none"; editBtn.style.display = ""; view.style.display = ""; });
      f.querySelector("[data-save]").addEventListener("click", async () => {
        const body = {}; body[f.dataset.field] = f.querySelector("[data-input]").value;
        try { await api(`/api/bip/behaviors/${f.dataset.bid}`, { method: "PATCH", body }); flash(); reload(); }
        catch (e) { alert(e.message); }
      });
    });

    // inline field editing (plan-level: safety etc.)
    container.querySelectorAll(".bip-field[data-bipfield]").forEach((f) => {
      const editBtn = f.querySelector("[data-edit]");
      if (!editBtn) return;
      const editor = f.querySelector("[data-editor]");
      const view = f.querySelector("[data-view]");
      editBtn.addEventListener("click", () => { editor.style.display = "block"; editBtn.style.display = "none"; view.style.display = "none"; editor.querySelector("[data-input]").focus(); });
      f.querySelector("[data-cancel]").addEventListener("click", () => { editor.style.display = "none"; editBtn.style.display = ""; view.style.display = ""; });
      f.querySelector("[data-save]").addEventListener("click", async () => {
        const body = {}; body[f.dataset.bipfield] = f.querySelector("[data-input]").value;
        try { await api(`/api/bip/${d.bip.id}`, { method: "PATCH", body }); flash(); reload(); }
        catch (e) { alert(e.message); }
      });
    });

    const reviewInput = container.querySelector("#bip-review-date");
    if (reviewInput) reviewInput.addEventListener("change", async () => {
      try { await api(`/api/bip/${d.bip.id}`, { method: "PATCH", body: { next_review_date: reviewInput.value } }); flash(); reload(); }
      catch (e) { alert(e.message); }
    });

    // actions
    container.querySelectorAll("[data-bip]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const act = btn.dataset.bip;
        try {
          if (act === "add-behavior") return addBehaviorDrawer(d, reload);
          if (act === "add-note") return noteDrawer(d, null, reload);
          if (act === "note-behavior") return noteDrawer(d, Number(btn.dataset.bid), reload);
          if (act === "ask") return askDrawer(d, null, reload);
          if (act === "ask-behavior") return askDrawer(d, Number(btn.dataset.bid), reload);
          if (act === "history") return historyDrawer(d);
          if (act === "export") return exportPlan(d);
          if (act === "toggle-note") {
            await api(`/api/bip/notes/${btn.dataset.nid}`, { method: "PATCH", body: { status: btn.dataset.st } });
            return reload();
          }
          if (act === "answer") {
            const ta = container.querySelector(`[data-answer="${btn.dataset.qid}"]`);
            if (!ta || !ta.value.trim()) return alert("Write your response first.");
            btn.disabled = true;
            await api(`/api/bip/questions/${btn.dataset.qid}`, { method: "PATCH", body: { response: ta.value } });
            return reload();
          }
          if (act === "resolve-q") {
            await api(`/api/bip/questions/${btn.dataset.qid}`, { method: "PATCH", body: { status: "Resolved" } });
            return reload();
          }
          if (act === "delete-behavior") {
            if (!confirm("Remove this target behavior from the plan? The change is recorded in history.")) return;
            await api(`/api/bip/behaviors/${btn.dataset.bid}`, { method: "DELETE" });
            return reload();
          }
          if (act === "submit-review") {
            btn.disabled = true;
            const r = await api(`/api/bip/${d.bip.id}/submit-review`, { method: "POST", body: {} });
            alert(r.emailed ? "Sent to the Clinical Director for review." : "Submitted. No Clinical Director email is set in Admin Settings, so no email went out.");
            return reload();
          }
          if (act === "approve") {
            await api(`/api/bip/${d.bip.id}/review-decision`, { method: "POST", body: { decision: "approved" } });
            return reload();
          }
          if (act === "request-changes") return requestChangesDrawer(d, reload);
        } catch (e) { alert(e.message); }
      });
    });

    // If we arrived from a "Review question" email, open that question.
    const m = location.hash.match(/[?&]bipq=(\d+)/);
    if (m) {
      const sec = container.querySelector("#bip-questions");
      if (sec) sec.classList.add("open");
      const q = container.querySelector(`#bip-question-${m[1]}`);
      if (q) setTimeout(() => q.scrollIntoView({ behavior: "smooth", block: "center" }), 240);
    }
  }

  // ============================ DRAWERS ============================
  function drawer(title, inner, footer) {
    const scrim = document.createElement("div"); scrim.className = "bip-scrim";
    const el = document.createElement("div"); el.className = "bip-drawer";
    el.innerHTML = `<header><h4>${esc(title)}</h4>
        <button class="bip-btn ghost sm" data-close style="margin-left:auto;">${icon("close", 14)}</button></header>
      <div class="inner">${inner}</div>
      ${footer ? `<footer>${footer}</footer>` : ""}`;
    document.body.appendChild(scrim); document.body.appendChild(el);
    const close = () => { el.remove(); scrim.remove(); };
    scrim.addEventListener("click", close);
    el.querySelector("[data-close]").addEventListener("click", close);
    return { el, close };
  }

  function addBehaviorDrawer(d, reload) {
    const { el, close } = drawer("Add Target Behavior",
      `<label class="fl">Behavior name</label>
       <input id="bh-name" type="text" placeholder="e.g. Property Destruction" />
       <label class="fl">Operational definition <span style="color:#4c63c7;">required</span></label>
       <textarea id="bh-def" rows="4" placeholder="Observable, measurable description…"></textarea>
       <label class="fl">Prevention strategies <span style="color:#4c63c7;">required</span></label>
       <textarea id="bh-prev" rows="4"></textarea>
       <label class="fl">Response strategy <span style="color:#4c63c7;">required</span></label>
       <textarea id="bh-resp" rows="4"></textarea>
       <p style="font-size:12px;color:#6b7280;margin-top:14px;">The other fields — function, replacement behaviors, teaching procedures and the rest — can be filled in on the card afterwards. Leave anything blank rather than guessing.</p>`,
      `<button class="bip-btn primary" id="bh-save">Add behavior</button><span id="bh-status" style="font-size:12.5px;color:#6b7280;"></span>`);
    el.querySelector("#bh-save").addEventListener("click", async () => {
      const name = el.querySelector("#bh-name").value.trim();
      if (!name) { el.querySelector("#bh-status").textContent = "Give it a name first."; return; }
      try {
        await api(`/api/bip/${d.bip.id}/behaviors`, { method: "POST", body: {
          name,
          operational_definition: el.querySelector("#bh-def").value,
          prevention_strategies: el.querySelector("#bh-prev").value,
          response_strategy: el.querySelector("#bh-resp").value,
        }});
        close(); reload();
      } catch (e) { el.querySelector("#bh-status").textContent = e.message; }
    });
  }

  function noteDrawer(d, behaviorId, reload) {
    const b = behaviorId ? d.behaviors.find((x) => x.id === behaviorId) : null;
    const { el, close } = drawer("Add Note",
      `<div class="bip-prefill">
         <div><b>${esc(d.client.child_name)}</b></div>
         ${b ? `<div style="margin-top:3px;">Behavior: <b>${esc(b.name)}</b></div>` : ""}
       </div>
       <label class="fl">Category</label>
       <select id="nt-cat">${d.meta.note_categories.map((c) => `<option>${esc(c)}</option>`).join("")}</select>
       <label class="fl">Note</label>
       <textarea id="nt-body" rows="6" placeholder="What happened, what changed, what to watch…"></textarea>`,
      `<button class="bip-btn primary" id="nt-save">Save note</button><span id="nt-status" style="font-size:12.5px;color:#6b7280;"></span>`);
    el.querySelector("#nt-body").focus();
    el.querySelector("#nt-save").addEventListener("click", async () => {
      const body = el.querySelector("#nt-body").value.trim();
      if (!body) { el.querySelector("#nt-status").textContent = "Write something first."; return; }
      try {
        await api(`/api/bip/${d.bip.id}/notes`, { method: "POST", body: {
          body, category: el.querySelector("#nt-cat").value, behavior_id: behaviorId || null,
        }});
        close(); reload();
      } catch (e) { el.querySelector("#nt-status").textContent = e.message; }
    });
  }

  function askDrawer(d, behaviorId, reload) {
    const b = behaviorId ? d.behaviors.find((x) => x.id === behaviorId) : null;
    const cd = d.clinical_director_email;
    const { el, close } = drawer("Ask Clinical Director",
      `<div class="bip-prefill">
         <div>Client: <b>${esc(d.client.child_name)}</b></div>
         <div style="margin-top:3px;">BCBA: <b>${esc((d.current_user && d.current_user.name) || "")}</b></div>
         <div style="margin-top:3px;">Date: <b>${fmtDate(new Date().toISOString())}</b></div>
         <div style="margin-top:3px;">Section: <b>${b ? "Target Behavior" : "Whole plan"}</b></div>
         ${b ? `<div style="margin-top:3px;">Behavior: <b>${esc(b.name)}</b></div>` : ""}
       </div>
       ${cd ? "" : `<div style="background:#fff2dd;border:1px solid #f0dfc0;border-radius:11px;padding:10px 12px;margin-top:12px;font-size:12.5px;color:#8a5d10;">
         No Clinical Director email is set in Admin Settings. Your question will be saved here, but no email will go out until one is configured.</div>`}
       <label class="fl">Your question</label>
       <textarea id="q-body" rows="5" placeholder="Ask it the way you'd ask in person…"></textarea>
       <label class="fl">What have you tried? <span style="font-weight:500;text-transform:none;">(optional)</span></label>
       <textarea id="q-tried" rows="3"></textarea>
       <label class="fl">Additional context <span style="font-weight:500;text-transform:none;">(optional)</span></label>
       <textarea id="q-ctx" rows="3"></textarea>
       <label class="fl">Urgency</label>
       <select id="q-urg">${d.meta.urgencies.map((u) => `<option>${esc(u)}</option>`).join("")}</select>`,
      `<button class="bip-btn primary" id="q-send">${icon("ask", 14)} Send Question</button><span id="q-status" style="font-size:12.5px;color:#6b7280;"></span>`);
    el.querySelector("#q-body").focus();
    el.querySelector("#q-send").addEventListener("click", async () => {
      const question = el.querySelector("#q-body").value.trim();
      if (!question) { el.querySelector("#q-status").textContent = "Type your question first."; return; }
      const btn = el.querySelector("#q-send"); btn.disabled = true;
      el.querySelector("#q-status").textContent = "Sending…";
      try {
        const r = await api(`/api/bip/${d.bip.id}/questions`, { method: "POST", body: {
          question,
          tried: el.querySelector("#q-tried").value,
          context: el.querySelector("#q-ctx").value,
          urgency: el.querySelector("#q-urg").value,
          behavior_id: behaviorId || null,
          section: b ? "Target Behavior" : "Plan",
        }});
        close();
        reload();
        if (r.note) alert(r.note);
      } catch (e) { el.querySelector("#q-status").textContent = e.message; btn.disabled = false; }
    });
  }

  function requestChangesDrawer(d, reload) {
    const { el, close } = drawer("Request Changes",
      `<div class="bip-prefill">Tell the BCBA what needs to change. It appears at the top of this plan on their screen.</div>
       <label class="fl">What needs changing</label>
       <textarea id="rc-note" rows="6" placeholder="e.g. Response strategy for Elopement needs a safety step for the parking lot."></textarea>`,
      `<button class="bip-btn primary" id="rc-send">Request changes</button>`);
    el.querySelector("#rc-note").focus();
    el.querySelector("#rc-send").addEventListener("click", async () => {
      try {
        await api(`/api/bip/${d.bip.id}/review-decision`, { method: "POST", body: {
          decision: "changes_requested", note: el.querySelector("#rc-note").value,
        }});
        close(); reload();
      } catch (e) { alert(e.message); }
    });
  }

  async function historyDrawer(d) {
    const { el } = drawer("Change History", `<div class="bip-empty">Loading…</div>`);
    try {
      const r = await api(`/api/bip/${d.bip.id}/history`);
      const rows = r.history || [];
      el.querySelector(".inner").innerHTML = rows.length ? rows.map((h) => `
        <div class="bip-hist">
          <div style="font-size:12.5px;"><strong>${esc(h.changed_by || "")}</strong>
            <span style="color:#6b7280;">· ${fmtWhen(h.changed_at)}</span></div>
          <div style="font-size:12.5px;color:#4c63c7;font-weight:650;margin-top:2px;">
            ${esc(h.section || "")}${h.behavior_name ? ` — ${esc(h.behavior_name)}` : ""}</div>
          <div class="bip-diff">
            ${h.old_value ? `<div class="old">${esc(String(h.old_value).slice(0, 320))}</div>` : `<div style="color:#9aa0ad;">(was empty)</div>`}
            <div class="new">${esc(String(h.new_value || "").slice(0, 320))}</div>
          </div>
        </div>`).join("") : `<div class="bip-empty">No changes recorded yet.</div>`;
    } catch (e) {
      el.querySelector(".inner").innerHTML = `<div class="bip-empty">${esc(e.message)}</div>`;
    }
  }

  // ---------------- export ----------------
  function exportPlan(d) {
    const w = window.open("", "_blank");
    if (!w) { alert("Allow pop-ups to export the plan."); return; }
    const f = d.meta.fields;
    w.document.write(`<html><head><title>BIP — ${esc(d.client.child_name)}</title>
      <style>
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2430;max-width:820px;margin:0 auto;padding:38px 28px;line-height:1.6;}
        h1{color:#1b2a6b;font-size:23px;margin:0 0 3px;} .sub{color:#6b7280;font-size:13px;margin-bottom:22px;}
        h2{color:#1b2a6b;font-size:16px;margin:26px 0 8px;border-bottom:2px solid #e8eaf1;padding-bottom:5px;}
        h3{font-size:14.5px;margin:18px 0 6px;color:#1f2430;}
        .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:700;margin-top:10px;}
        .v{white-space:pre-wrap;font-size:13.5px;} .empty{color:#a6abb8;font-style:italic;}
        @media print{body{padding:0;}}
      </style></head><body>
      <h1>Behavior Intervention Plan</h1>
      <div class="sub">${esc(d.client.child_name)} · Status: ${esc((d.meta.status_label || {})[d.bip.status] || d.bip.status)}
        · Last updated ${fmtDate(d.bip.updated_at)} by ${esc(d.bip.last_updated_by || "")}
        · Next review ${fmtDate(d.bip.next_review_date)}
        ${d.bip.assigned_bcba ? `· BCBA ${esc(d.bip.assigned_bcba)}` : ""}</div>
      ${d.behaviors.map((b) => `<h2>${esc(b.name)}</h2>` + f.map((x) => {
        const val = String(b[x.key] || "").trim();
        return `<div class="k">${esc(x.label)}</div><div class="v ${val ? "" : "empty"}">${val ? esc(val) : "Not documented"}</div>`;
      }).join("")).join("")}
      ${d.bip.safety_plan || d.bip.crisis_procedures ? `<h2>Safety</h2>
        <div class="k">Safety Plan</div><div class="v">${esc(d.bip.safety_plan || "Not documented")}</div>
        <div class="k">Crisis Procedures</div><div class="v">${esc(d.bip.crisis_procedures || "Not documented")}</div>` : ""}
      ${d.bip.source_document_name ? `<h2>Source</h2><div class="v">${esc(d.bip.source_document_name)}${d.bip.source_document_date ? ` — ${esc(d.bip.source_document_date)}` : ""}</div>` : ""}
      </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
  }

  window.__renderBipSection = function (container, clientId) { return render(container, clientId); };
})();
