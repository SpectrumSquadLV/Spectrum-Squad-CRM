// bcba-hub-frontend.js -- the BCBA Hub.
//
// A pre-submission tool, not a document viewer. The question it exists to
// answer, in seconds: for THIS payer, what does the assessment need, how many
// units are there, what has to be attached, what has to be in the plan, what
// does this reviewer care about, and is the plan ready to send.
//
// THE RULE THAT SHAPES EVERY SCREEN HERE: payers differ, and the differences
// are the point. Nothing is merged into a universal checklist, nothing is
// borrowed from one payer to fill a gap in another, and a payer the cheat
// sheet says nothing about SAYS SO. Molina has no treatment-plan components in
// the document; this page tells you that instead of showing you CareSource's.
//
// The checklist is a review aid. It is never sent to the server and never
// stored against a client -- it is a BCBA ticking off their own draft, so it
// lives in this browser and nowhere else.
//
// Exposes window.__renderBcbaHub(mount) for the native router.
(function () {
  "use strict";

  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function attr(s) { return esc(s).replace(/"/g, "&quot;"); }

  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, {
      method: opts.method || "GET",
      credentials: "include",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "Request failed");
    return d;
  }

  // Monochrome line icons. Deliberately not emoji: every screen this app serves
  // is scanned for them, and a glyph that renders differently on each machine
  // is not an icon anyway.
  const ICON = {
    clipboard: '<path d="M8 3h4a1 1 0 011 1v1H7V4a1 1 0 011-1z"/><path d="M6 5H5a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1h-1"/>',
    folder: '<path d="M3 6a1 1 0 011-1h4l2 2h6a1 1 0 011 1v7a1 1 0 01-1 1H4a1 1 0 01-1-1V6z"/>',
    book: '<path d="M4 4h5a2 2 0 012 2v10a2 2 0 00-2-2H4V4z"/><path d="M16 4h-5a2 2 0 00-2 2v10a2 2 0 012-2h5V4z"/>',
    people: '<circle cx="7" cy="7" r="2.5"/><circle cx="13.5" cy="8" r="2"/><path d="M3 16c0-2.2 1.8-4 4-4s4 1.8 4 4"/><path d="M12 16c0-1.7 1.1-3 2.5-3S17 14.3 17 16"/>',
    check: '<path d="M4 10.5l4 4 8-9"/>',
    doc: '<path d="M6 3h5l3 3v11a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M11 3v3h3"/>',
    clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>',
    shield: '<path d="M10 3l6 2v5c0 3.3-2.4 6.2-6 7-3.6-.8-6-3.7-6-7V5l6-2z"/>',
    print: '<path d="M6 8V3h8v5"/><path d="M6 14H4a1 1 0 01-1-1V9a1 1 0 011-1h12a1 1 0 011 1v4a1 1 0 01-1 1h-2"/><path d="M6 12h8v5H6z"/>',
    download: '<path d="M10 3v9"/><path d="M6.5 8.5L10 12l3.5-3.5"/><path d="M4 15h12"/>',
    scales: '<path d="M10 4v12"/><path d="M4 7h12"/><path d="M4 7l-2 5h4l-2-5z"/><path d="M16 7l-2 5h4l-2-5z"/>',
    bulb: '<path d="M7.5 13a5 5 0 115 0v2h-5v-2z"/><path d="M8.5 17h3"/>',
    alert: '<path d="M10 3l7 13H3l7-13z"/><path d="M10 8v4"/><circle cx="10" cy="14.5" r=".6" fill="currentColor"/>',
    search: '<circle cx="9" cy="9" r="5"/><path d="M13 13l4 4"/>',
    plus: '<path d="M10 4v12"/><path d="M4 10h12"/>',
    link: '<path d="M8.5 11.5a3 3 0 004.2 0l2.3-2.3a3 3 0 10-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 00-4.2 0L5 10.8a3 3 0 104.2 4.2l1-1"/>',
    chat: '<path d="M4 5h12a1 1 0 011 1v6a1 1 0 01-1 1H9l-4 3v-3H4a1 1 0 01-1-1V6a1 1 0 011-1z"/>',
    external: '<path d="M12 4h4v4"/><path d="M16 4l-6 6"/><path d="M14 11v4a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h4"/>',
  };
  function icon(name, size) {
    return '<svg class="bh-i" width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 20 20" fill="none" ' +
      'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICON[name] || "") + "</svg>";
  }

  // ---- state ------------------------------------------------------------
  const state = {
    tab: "cheatsheet",
    payers: [],
    canManageForms: false,
    payerKey: null,
    mode: "initial",          // initial | reauth
    compare: null,            // [keyA, keyB] while the comparison is open
    forms: [],
    categories: [],
    formFilter: "all",
    formQuery: "",
    showArchived: false,
    payerSearch: "",
  };

  // ---- checklist memory --------------------------------------------------
  // Per payer and per authorization type, in this browser only. A BCBA
  // reviewing an initial plan and a reauthorization is doing two different
  // reviews, so they do not share ticks.
  function checkKey() { return "ss-bcba-check:" + state.payerKey + ":" + state.mode; }

  // The ticks survive a reload, so WHERE YOU WERE has to survive it too.
  // Restoring the checklist onto a different payer than the one being reviewed
  // shows 0% and looks like the work was lost.
  const PLACE_KEY = "ss-bcba-place";
  function savePlace() {
    try { localStorage.setItem(PLACE_KEY, JSON.stringify({ payer: state.payerKey, mode: state.mode, tab: state.tab })); }
    catch (e) { /* private mode */ }
  }
  function loadPlace() {
    try { return JSON.parse(localStorage.getItem(PLACE_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function loadChecks() {
    try { return new Set(JSON.parse(localStorage.getItem(checkKey()) || "[]")); }
    catch (e) { return new Set(); }
  }
  function saveChecks(set) {
    try { localStorage.setItem(checkKey(), JSON.stringify([...set])); } catch (e) { /* private mode */ }
  }

  const payer = () => state.payers.find((p) => p.key === state.payerKey) || null;

  // Which sections apply to the authorization type on screen.
  //
  // Initial: the treatment-plan components. Reauthorization: those PLUS what
  // the payer additionally wants for continued authorization -- the document's
  // own words, "CareSource ALSO expects the following for continued
  // authorization". A reauthorization plan is still a treatment plan.
  function sectionsFor(p) {
    if (!p) return [];
    return p.sections.filter((s) => (state.mode === "reauth" ? true : s.group !== "reauth"));
  }
  function itemsOf(section) {
    return section.items.filter((i) => i.kind === "item" && (state.mode === "reauth" || !i.reauth_only));
  }
  const itemId = (sec, idx) => sec.key + "#" + idx;

  // ---- styles ------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("bh-styles")) return;
    const el = document.createElement("style");
    el.id = "bh-styles";
    el.textContent = `
    /* The app's own universal box-sizing rule never applies: a stray
       declaration after the :root block makes the CSS parser swallow that rule
       (verified in a browser, not assumed). Until that is fixed globally --
       which shifts every screen in the app and wants its own change -- padding
       adds OUTSIDE a declared width here, which is what pushed the upload
       dialog and the quick-reference cards past the edge on a phone. Scoped to
       this section so the fix cannot move anything outside it. */
    .bh, .bh *, .bh-modal, .bh-modal * { box-sizing: border-box; }
    /* An icon-plus-label flex box holds its text in an ANONYMOUS flex item,
       which cannot be given min-width:0 and so refuses to wrap. In a column
       this narrow that is what pushes the page sideways -- not the icon, the
       label beside it. Wrapping lets the label drop under the icon instead. */
    .bh-qr h4, .bh-callout h4, .bh-btn, .bh-tab, .bh-hero-pt { flex-wrap: wrap; }
    .bh { padding: 22px; max-width: 1180px; min-width: 0; overflow-wrap: break-word; }
    .bh * { min-width: 0; }
    .bh-i { flex: 0 0 auto; }
    .bh-head h1 { margin: 0 0 3px; font-size: 26px; color: var(--brand-navy, #1b2a6b); }
    .bh-head p { margin: 0 0 16px; color: var(--text-muted, #6b6a86); font-size: 13.5px; }

    /* The app keeps a fixed 240px sidebar at every width, so on a phone this
       strip has about 90px to render four tabs in. It wraps first, and scrolls
       inside itself when even one tab cannot fit, rather than making the whole
       page scroll sideways. */
    .bh-tabs { display: flex; gap: 6px; flex-wrap: wrap; overflow-x: auto;
      border-bottom: 1px solid var(--border, #e5e7eb); margin-bottom: 20px; }
    .bh-tab { display: inline-flex; align-items: center; gap: 7px; background: none; border: none; cursor: pointer;
      padding: 10px 14px; font-size: 13.5px; font-weight: 600; color: var(--text-muted, #6b6a86);
      border-bottom: 2px solid transparent; margin-bottom: -1px; font-family: inherit; }
    .bh-tab:hover { color: var(--brand-navy, #1b2a6b); }
    .bh-tab.on { color: var(--brand-navy, #1b2a6b); border-bottom-color: var(--brand-navy, #1b2a6b); }
    .bh-tab[disabled] { cursor: default; opacity: .65; }
    .bh-soon { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px; background: #f3e8ff; color: #6b21a8; }

    .bh-hero { background: linear-gradient(120deg, #f4f2fd 0%, #eef6fb 55%, #f0faf5 100%);
      border: 1px solid #e7e3f7; border-radius: 16px; padding: 22px 24px; margin-bottom: 22px; }
    .bh-hero .eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: #7c6bb5; }
    .bh-hero h2 { margin: 6px 0 6px; font-size: clamp(19px, 5.5vw, 27px); color: var(--brand-navy, #1b2a6b); }
    .bh-hero h2 span { color: #7c5cd6; }
    .bh-hero p { margin: 0; color: #4a4a68; font-size: 13.5px; max-width: 560px; }
    .bh-hero-pts { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 16px; }
    .bh-hero-pt { display: flex; align-items: center; gap: 9px; font-size: 12.5px; font-weight: 600; color: #3a3a5c; }
    .bh-hero-pt .b { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; }

    .bh-sec-title { font-size: 16px; font-weight: 700; color: var(--brand-navy, #1b2a6b); margin: 0 0 3px; }
    .bh-sec-sub { font-size: 12.5px; color: var(--text-muted, #6b6a86); margin: 0 0 12px; }

    /* The mock's two-column shape: the payer's requirements on the left, the
       things you reach for beside them on the right. It collapses to one
       column early, because the app keeps a fixed 240px sidebar at every width
       and the content column is narrow long before the viewport is. */
    .bh-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 290px); gap: 18px; align-items: start; }
    @media (max-width: 1080px) { .bh-layout { grid-template-columns: minmax(0, 1fr); } }
    .bh-rail { display: flex; flex-direction: column; gap: 12px; position: sticky; top: 14px; }
    @media (max-width: 1080px) { .bh-rail { position: static; } }
    .bh-rail .bh-card { padding: 14px 15px; }
    .bh-rail h4 { margin: 0 0 9px; font-size: 12.5px; font-weight: 800; display: flex; align-items: center;
      gap: 7px; flex-wrap: wrap; color: var(--brand-navy, #1b2a6b); }
    .bh-rail ul { margin: 0; padding-left: 17px; font-size: 12.5px; line-height: 1.6; color: #33334f; }
    .bh-rail a { color: #1b2a6b; }
    .bh-linkrow { display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 7px 0; border-bottom: 1px solid #f2efe6; font-size: 12.5px; }
    .bh-linkrow:last-child { border-bottom: 0; }
    .bh-linkrow a { text-decoration: none; font-weight: 600; }
    .bh-linkrow a:hover { text-decoration: underline; }

    /* The payer search from the mock. With seven payers it is not strictly
       needed, so it hides itself below a handful rather than sitting there
       looking like the list is longer than it is. */
    .bh-payerbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .bh-payersearch { position: relative; flex: 0 1 260px; min-width: 0; }
    .bh-payersearch input { width: 100%; padding: 7px 10px 7px 30px; border: 1px solid var(--border, #e5e7eb);
      border-radius: 9px; font-size: 12.5px; font-family: inherit; }
    .bh-payersearch .ic { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); opacity: .5; }

    /* A payer's own logo when one has been uploaded, the coloured initials mark
       until then -- so a card never renders as an empty square. */
    .bh-payer .mk img, .bh-logo img { width: 100%; height: 100%; object-fit: contain; border-radius: inherit; background: #fff; }
    .bh-payer .mk.has-logo, .bh-logo.has-logo { background: #fff !important; border: 1px solid var(--border, #e5e7eb); padding: 3px; }

    .bh-cta { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
      background: linear-gradient(120deg, #f4f2fd 0%, #eef6fb 100%); border: 1px solid #e7e3f7;
      border-radius: 14px; padding: 15px 18px; margin-top: 16px; }
    .bh-cta .t { font-size: 13.5px; font-weight: 700; color: var(--brand-navy, #1b2a6b); }
    .bh-cta .s { font-size: 12.5px; color: #4a4a68; }
    .bh-payers { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(124px, 100%), 1fr)); gap: 10px; margin: 12px 0 22px; }
    .bh-payer { background: #fff; border: 1.5px solid var(--border, #e5e7eb); border-radius: 13px; padding: 15px 10px;
      cursor: pointer; text-align: center; font-family: inherit; transition: border-color .12s, box-shadow .12s, transform .12s; }
    .bh-payer:hover { border-color: #c3bbe8; box-shadow: 0 4px 14px rgba(41,34,92,.09); transform: translateY(-1px); }
    .bh-payer.on { border-color: var(--brand-navy, #1b2a6b); box-shadow: 0 0 0 3px #e7e4f7; }
    .bh-payer .mk { width: 40px; height: 40px; margin: 0 auto 9px; border-radius: 11px; display: grid; place-items: center;
      font-weight: 800; font-size: 14px; color: #fff; }
    .bh-payer .nm { font-size: 12.5px; font-weight: 700; color: var(--text, #201a4d); line-height: 1.25; }
    .bh-payer .ct { font-size: 10.5px; color: var(--text-muted, #6b6a86); margin-top: 3px; }

    .bh-card { background: #fff; border: 1px solid var(--border, #e5e7eb); border-radius: 14px; padding: 16px 18px; margin-bottom: 14px; }
    .bh-grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr)); gap: 12px; margin-bottom: 16px; }
    .bh-qr { border-radius: 13px; padding: 14px 15px; border: 1px solid; }
    .bh-qr h4 { margin: 0 0 8px; font-size: 12.5px; font-weight: 700; display: flex; align-items: center; gap: 7px; }
    .bh-qr ul { margin: 0; padding-left: 17px; font-size: 12.5px; line-height: 1.5; color: #33334f; }
    .bh-qr li { margin-bottom: 4px; }
    .bh-qr.a { background: #f5f2fe; border-color: #e3dbfa; color: #4c3d8f; }
    .bh-qr.b { background: #fff9ec; border-color: #f6e5bd; color: #8a6414; }
    .bh-qr.c { background: #eefaf3; border-color: #cdeedd; color: #1c6b45; }
    .bh-none { font-size: 12.5px; color: var(--text-muted, #6b6a86); font-style: italic; }

    .bh-toggle { display: flex; flex-wrap: wrap; width: fit-content; max-width: 100%;
      background: #f1f0f8; border-radius: 999px; padding: 3px; margin-bottom: 16px; }
    .bh-toggle button { border: none; background: none; cursor: pointer; font-family: inherit; font-size: 12.5px;
      font-weight: 700; padding: 7px 16px; border-radius: 999px; color: var(--text-muted, #6b6a86); }
    .bh-toggle button.on { background: #fff; color: var(--brand-navy, #1b2a6b); box-shadow: 0 1px 3px rgba(41,34,92,.14); }

    .bh-ready { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .bh-bar { flex: 1 1 220px; height: 9px; background: #eeecf6; border-radius: 999px; overflow: hidden; min-width: 0; }
    .bh-bar i { display: block; height: 100%; border-radius: 999px; transition: width .25s ease; }
    .bh-pct { font-size: 20px; font-weight: 800; color: var(--brand-navy, #1b2a6b); }
    .bh-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700;
      padding: 3px 10px; border-radius: 999px; }
    .bh-pill .dot { width: 8px; height: 8px; border-radius: 50%; }
    .bh-pill.ok { background: #dcfce7; color: #166534; } .bh-pill.ok .dot { background: #22c55e; }
    .bh-pill.mid { background: #fef3c7; color: #92400e; } .bh-pill.mid .dot { background: #e0a430; }
    .bh-pill.low { background: #fee2e2; color: #991b1b; } .bh-pill.low .dot { background: #ef4444; }

    .bh-sect { border: 1px solid var(--border, #e5e7eb); border-radius: 12px; margin-bottom: 9px; overflow: hidden; background: #fff; }
    .bh-sect > summary { cursor: pointer; padding: 12px 15px; display: flex; align-items: center; gap: 10px;
      font-size: 13.5px; font-weight: 700; color: var(--text, #201a4d); list-style: none; }
    .bh-sect > summary::-webkit-details-marker { display: none; }
    .bh-sect > summary:hover { background: #fafaff; }
    .bh-sect .chev { margin-left: auto; color: var(--text-muted, #6b6a86); font-size: 11px; }
    .bh-sect[open] .chev { transform: rotate(90deg); }
    .bh-sect .body { padding: 4px 15px 14px; }
    .bh-sect .reauth-tag { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: #ede9fe; color: #5b21b6; }
    .bh-sect .cnt { font-size: 11px; font-weight: 600; color: var(--text-muted, #6b6a86); }
    .bh-item { display: flex; gap: 9px; align-items: flex-start; padding: 5px 0; font-size: 13px; line-height: 1.45; cursor: pointer; }
    .bh-item.d1 { padding-left: 24px; }
    .bh-item input { margin: 2px 0 0; flex: 0 0 auto; cursor: pointer; }
    .bh-item.done span { color: var(--text-muted, #6b6a86); }
    .bh-lead { font-size: 12.5px; font-weight: 700; color: #4a4a68; padding: 9px 0 2px; }
    .bh-lead.d1 { padding-left: 24px; }

    .bh-callout { border-radius: 13px; padding: 14px 16px; margin-bottom: 12px; border: 1px solid; }
    .bh-callout h4 { margin: 0 0 7px; font-size: 12.5px; font-weight: 800; display: flex; align-items: center; gap: 7px;
      letter-spacing: .01em; }
    .bh-callout p { margin: 0 0 7px; font-size: 12.5px; }
    .bh-callout ul { margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.55; }
    .bh-callout.hot { background: #fff5f5; border-color: #fbd5d5; color: #9b2c2c; }
    .bh-callout.tip { background: #fffbeb; border-color: #fcecc4; color: #8a6414; }
    .bh-callout.info { background: #eff6ff; border-color: #d6e4fb; color: #1e40af; }

    .bh-btn { display: inline-flex; align-items: center; gap: 7px; border-radius: 9px; border: 1px solid var(--border, #e5e7eb);
      background: #fff; color: var(--brand-navy, #1b2a6b); font-family: inherit; font-size: 12.5px; font-weight: 600;
      padding: 7px 13px; cursor: pointer; text-decoration: none; }
    .bh-btn:hover { border-color: #c3bbe8; background: #fafaff; }
    .bh-btn.pri { background: var(--brand-navy, #1b2a6b); color: #fff; border-color: var(--brand-navy, #1b2a6b); }
    .bh-btn.pri:hover { background: var(--brand-navy-dark, #101c4d); }
    .bh-btn.sm { padding: 5px 10px; font-size: 11.5px; }
    .bh-btn.dgr { color: #991b1b; border-color: #fbd5d5; }
    .bh-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

    .bh-formbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
    .bh-search { position: relative; flex: 1 1 240px; min-width: 0; }
    .bh-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-muted, #6b6a86); }
    .bh-search input { width: 100%; padding: 8px 12px 8px 34px; border-radius: 9px; border: 1px solid var(--border, #e5e7eb);
      font-family: inherit; font-size: 13px; }
    .bh-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .bh-chip { border: 1px solid var(--border, #e5e7eb); background: #fff; border-radius: 999px; padding: 5px 13px;
      font-size: 12px; font-weight: 600; color: var(--text-muted, #6b6a86); cursor: pointer; font-family: inherit; }
    .bh-chip.on { background: var(--brand-navy, #1b2a6b); color: #fff; border-color: var(--brand-navy, #1b2a6b); }
    .bh-forms { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap: 12px; }
    .bh-form { background: #fff; border: 1px solid var(--border, #e5e7eb); border-radius: 13px; padding: 15px 16px;
      display: flex; flex-direction: column; gap: 9px; }
    .bh-form:hover { border-color: #c3bbe8; }
    .bh-form .nm { font-size: 13.5px; font-weight: 700; color: var(--text, #201a4d); }
    .bh-form .ds { font-size: 12.5px; color: var(--text-muted, #6b6a86); line-height: 1.45; flex: 1 1 auto; }
    .bh-tag { display: inline-flex; align-items: center; font-size: 10.5px; font-weight: 700; padding: 2px 9px;
      border-radius: 999px; background: var(--brand-navy-light, #edecf8); color: var(--brand-navy, #1b2a6b); }
    .bh-tag.arch { background: #e5e7eb; color: #4b5563; }
    .bh-tag.pay { background: #eefaf3; color: #1c6b45; }

    /* Wraps rather than nowrap: this sits in a card about 200px wide on a
       phone, and an unbreakable pill there takes the whole page sideways. */
    .bh-preauth { display: inline-flex; align-items: center; gap: 4px; font-weight: 800; padding: 3px 10px;
      border-radius: 999px; max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: left; }
    .bh-preauth-note { font-size: 11.5px; color: var(--text-muted, #6b6a86); margin: -6px 0 12px;
      padding-left: 2px; }
    /* A changed requirement is marked where it is read, not only on an audit
       screen. A correction that looks identical to the payer's own published
       wording is how somebody submits against it without knowing. */
    .bh-edited { border-left: 2px solid #c98f22; padding-left: 7px; }
    .bh-edited-note { font-size: 10.5px; color: var(--text-muted, #6b6a86); display: block; margin-top: 2px; }
    .bh-reqacts { display: inline-flex; gap: 4px; margin-left: 6px; vertical-align: middle; flex-wrap: wrap; max-width: 100%; }
    .bh-reqacts button { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border, #e5e7eb);
      background: #fff; color: var(--text-muted, #6b6a86); cursor: pointer; }
    .bh-reqacts button:hover { color: var(--brand-navy, #1b2a6b); border-color: #c9c6e2; }

    .bh-cmp .scroll { overflow-x: auto; }
    .bh-cmp table { width: 100%; border-collapse: collapse; font-size: 12.5px; min-width: 460px; }
    .bh-cmp th, .bh-cmp td { text-align: left; vertical-align: top; padding: 10px 12px; border-top: 1px solid var(--border, #e5e7eb); }
    .bh-cmp th.rowh { width: 200px; color: var(--text-muted, #6b6a86); font-weight: 700; }
    .bh-cmp ul { margin: 0; padding-left: 16px; }
    .bh-cmp select { padding: 7px 10px; border-radius: 9px; border: 1px solid var(--border, #e5e7eb); font-family: inherit; font-size: 12.5px; }

    .bh-quote { background: #eefaf5; border-radius: 12px; padding: 13px 16px; font-size: 13px; color: #1c6b45;
      font-style: italic; margin-bottom: 14px; }

    .bh-empty { padding: 30px; text-align: center; color: var(--text-muted, #6b6a86); font-size: 13px; }
    .bh-err { padding: 14px 16px; border-radius: 12px; background: #fdecec; color: #a3282e; font-size: 13px; margin-bottom: 12px; }
    .bh-modal { position: fixed; inset: 0; background: rgba(24,20,54,.45); display: grid; place-items: center; z-index: 90; padding: 20px; }
    .bh-modal .box { background: #fff; border-radius: 16px; padding: 22px 24px; width: 100%; max-width: 520px; max-height: 90vh; overflow: auto; }
    .bh-modal h3 { margin: 0 0 14px; font-size: 17px; color: var(--brand-navy, #1b2a6b); }
    .bh-fld { margin-bottom: 12px; }
    .bh-fld label { display: block; font-size: 12px; font-weight: 700; color: #4a4a68; margin-bottom: 4px; }
    .bh-fld input[type=text], .bh-fld input[type=file], .bh-fld select, .bh-fld textarea {
      width: 100%; padding: 8px 11px; border-radius: 9px; border: 1px solid var(--border, #e5e7eb);
      font-family: inherit; font-size: 13px; }
    .bh-fld .hint { font-size: 11.5px; color: var(--text-muted, #6b6a86); margin-top: 3px; }

    @media print {
      .sidebar, .bh-tabs, .bh-hero, .bh-payers, .bh-toggle, .bh-btn, .bh-chips, .bh-formbar, .bh-noprint { display: none !important; }
      .bh { padding: 0; max-width: none; }
      .bh-sect { break-inside: avoid; border-color: #999; }
      .bh-sect .body { display: block !important; }
      .bh-card, .bh-qr, .bh-callout { break-inside: avoid; }
      body { background: #fff; }
    }
    `;
    document.head.appendChild(el);
  }

  // ---- payer marks -------------------------------------------------------
  // A colour and an initial per payer, derived from the name so the list is
  // scannable. Purely presentational: it carries no requirement of its own.
  const MARK_COLORS = ["#5b4bbd", "#3f8f89", "#c98a1b", "#2563eb", "#be5a97", "#0f766e", "#7c3aed"];
  function markFor(p, i) {
    const letters = p.name.replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("");
    return { color: MARK_COLORS[i % MARK_COLORS.length], letters: (letters || p.name.slice(0, 2)).toUpperCase() };
  }

  // ================= cheat sheet ==========================================
  function heroHtml() {
    const pt = (name, bg, fg, text) =>
      '<div class="bh-hero-pt"><span class="b" style="background:' + bg + ';color:' + fg + ';">' + icon(name, 16) + "</span>" + esc(text) + "</div>";
    return '<div class="bh-hero">' +
      '<div class="eyebrow">Treatment Plan Cheat Sheet</div>' +
      '<h2>Plan with <span>confidence.</span></h2>' +
      "<p>Payer-specific requirements in one place, straight from the practice's cheat sheet. " +
      "Right information, better outcomes.</p>" +
      '<div class="bh-hero-pts">' +
        pt("doc", "#ece7fb", "#5b4bbd", "Know what's required") +
        pt("check", "#e2f6ec", "#1c6b45", "Check before you send") +
        pt("clock", "#fdf1dc", "#8a6414", "One less thing to second guess") +
      "</div></div>";
  }

  // A payer's own logo if one has been uploaded, the coloured initials mark
  // otherwise. Never an empty square: a card with nothing in it reads as a
  // broken image rather than as "no logo yet".
  function payerMarkHtml(p, i, size) {
    const m = markFor(p, i);
    const px = size || 40;
    if (p.logo_url) {
      return '<span class="mk has-logo" style="width:' + px + "px;height:" + px + 'px;">' +
        '<img src="' + attr(p.logo_url) + '" alt="' + attr(p.name) + '" loading="lazy" />' + "</span>";
    }
    return '<span class="mk" style="background:' + m.color + ";width:" + px + "px;height:" + px + 'px;">' + esc(m.letters) + "</span>";
  }

  function payerPickerHtml() {
    const q = String(state.payerSearch || "").trim().toLowerCase();
    const shown = state.payers.filter((p) => !q || p.name.toLowerCase().includes(q));
    const cards = shown.map((p) => {
      const i = state.payers.indexOf(p);
      const n = p.sections.reduce((a, s) => a + s.items.filter((x) => x.kind === "item").length, 0);
      return '<button class="bh-payer' + (state.payerKey === p.key ? " on" : "") + '" data-payer="' + attr(p.key) + '">' +
        payerMarkHtml(p, i) +
        '<div class="nm">' + esc(p.name) + "</div>" +
        '<div class="ct">' + (n ? n + " requirement" + (n === 1 ? "" : "s") : "No components listed") + "</div>" +
        '<div style="margin-top:5px;">' + preauthTagHtml(p, true) + "</div>" +
      "</button>";
    }).join("");
    // Only offered once the list is long enough to be worth searching.
    const search = state.payers.length >= 8
      ? '<div class="bh-payersearch"><span class="ic">' + icon("search", 14) + "</span>" +
        '<input id="bh-payer-search" placeholder="Search payers…" value="' + attr(state.payerSearch || "") + '" /></div>'
      : "";
    return '<div class="bh-noprint">' +
      '<div class="bh-payerbar"><div><div class="bh-sec-title">Select a Payer</div>' +
      '<p class="bh-sec-sub">Choose an insurance provider to see what that payer needs before a treatment plan goes out.</p></div>' +
      search + "</div>" +
      '<div class="bh-payers">' + (cards || '<div class="bh-none">No payer matches that.</div>') + "</div></div>";
  }

  // A line is a plain string until somebody edits it, at which point it
  // becomes an object carrying the original wording and who changed it.
  function txt(v) { return v && typeof v === "object" ? v.text : v; }

  // WHETHER THIS PAYER NEEDS A PRE-AUTHORIZATION, as a marker you can see
  // without reading anything.
  //
  // Three states, not two. "Not recorded" is its own answer: a payer with no
  // marker at all is indistinguishable from one that needs no pre-auth, and
  // guessing wrong in that direction is a denied claim.
  const PREAUTH = {
    // Two labels each. The app keeps a fixed 240px sidebar at every screen
    // size, so the payer cards are about 200px wide on a phone -- "No pre-auth
    // for assessment" is 159px of unbreakable text there and pushed the whole
    // page sideways. The short form is used wherever the space is a card.
    required:     { label: "Pre-auth required", short: "Pre-auth", bg: "#fef3c7", fg: "#92400e" },
    not_required: { label: "No pre-auth for assessment", short: "No pre-auth", bg: "#dcfce7", fg: "#166534" },
    unknown:      { label: "Pre-auth not recorded", short: "Not recorded", bg: "#f1f5f9", fg: "#475569" },
  };

  function preauthTagHtml(p, small) {
    const pa = p.preauth || { required: "unknown" };
    const t = PREAUTH[pa.required] || PREAUTH.unknown;
    // The provenance is part of the marker. "The cheat sheet says so" and
    // "we decided this at setup" carry different weight when a claim is
    // denied, and showing them identically would launder the second into the
    // first.
    const src = pa.source === "document" ? "from the cheat sheet"
      : pa.source === "setup" ? "set at setup"
      : pa.source === "edited" ? "set by the practice" : "";
    return '<span class="bh-preauth" title="' + attr((pa.note || "") + (src ? " (" + src + ")" : "")) + '"' +
      ' style="background:' + t.bg + ";color:" + t.fg + ';font-size:' + (small ? "10.5px" : "11.5px") + ';">' +
      esc(small ? t.short : t.label) +
      (small || !src ? "" : ' <em style="opacity:.75;font-style:normal;">· ' + esc(src) + "</em>") +
    "</span>";
  }

  // The server addresses a line by a hash of the text it is replacing, so the
  // page has to send the ORIGINAL wording back, not the hash -- computing SHA-1
  // in the browser to match the server's would be a second implementation of an
  // identity rule, and the day they disagreed an edit would silently miss.
  function originalOf(e) {
    if (e && typeof e === "object") return e.original_text != null ? e.original_text : e.text;
    return e;
  }

  // Edit / remove, on the line itself. Only drawn for someone who may change
  // them; the API refuses the rest regardless of what is on screen.
  function reqActsHtml(listKey, entry) {
    if (!state.canEditRequirements) return "";
    const payerKey = state.payerKey;
    if (entry && entry.added) {
      return '<span class="bh-reqacts bh-noprint">' +
        '<button data-req-undo="' + attr(String(entry.edit_id)) + '" title="Remove this addition">Undo</button></span>';
    }
    const orig = attr(originalOf(entry));
    const common = ' data-req-payer="' + attr(payerKey) + '" data-req-list="' + attr(listKey) + '" data-req-orig="' + orig + '"';
    return '<span class="bh-reqacts bh-noprint">' +
      "<button data-req-edit=\"1\"" + common + ">Edit</button>" +
      "<button data-req-remove=\"1\"" + common + ">Remove</button>" +
      (entry && entry.edited
        ? '<button data-req-undo="' + attr(String(entry.edit_id)) + '" title="Put back the cheat sheet wording">Revert</button>'
        : "") +
    "</span>";
  }

  // "Changed on 4 Sep by someone" under a line somebody corrected.
  function editedNoteHtml(entry) {
    if (!entry || typeof entry !== "object") return "";
    if (entry.added) {
      return '<span class="bh-edited-note">Added by ' + esc(entry.edited_by || "the practice") +
        ". Not in the cheat sheet.</span>";
    }
    if (entry.edited) {
      return '<span class="bh-edited-note">Changed by ' + esc(entry.edited_by || "the practice") +
        ". The cheat sheet says: " + esc(entry.original_text || "") + "</span>";
    }
    return "";
  }

  function addReqHtml(listKey, label) {
    if (!state.canEditRequirements) return "";
    return '<button class="bh-btn sm bh-noprint" style="margin-top:8px;" data-req-add="' + attr(listKey) +
      '" data-req-payer="' + attr(state.payerKey) + '">+ ' + esc(label || "Add a requirement") + "</button>";
  }

  function qrList(entries, emptyText, listKey) {
    if (!entries || !entries.length) {
      return '<div class="bh-none">' + esc(emptyText) + "</div>" + addReqHtml(listKey);
    }
    return "<ul>" + entries.map((e) => {
      const text = typeof e === "string" ? e : e.text;
      const form = typeof e === "string" ? null : e.form;
      const marked = e && typeof e === "object" && (e.edited || e.added);
      return '<li' + (marked ? ' class="bh-edited"' : "") + ">" + esc(text) + reqActsHtml(listKey, e) + editedNoteHtml(e) +
        (form
          // The cheat sheet named a form and the Form Library has it, so the
          // download comes from there. One copy, one place to update it.
          ? ' <a class="bh-btn sm" style="margin-left:4px;" href="/api/bcba/forms/' + form.id + '/file" download>' +
            icon("download", 13) + (form.editable ? "Download Editable" : "Download Form") + "</a>"
          : "") +
      "</li>";
    }).join("") + "</ul>" + addReqHtml(listKey);
  }

  function quickRefHtml(p) {
    return '<div class="bh-grid3">' +
      '<div class="bh-qr a"><h4>' + icon("shield", 15) + "Assessment Authorization</h4>" +
        qrList(p.assessment_authorization, "The cheat sheet does not list assessment authorization requirements for this payer.", "assessment_authorization") + "</div>" +
      '<div class="bh-qr b"><h4>' + icon("clock", 15) + "Assessment Units</h4>" +
        qrList(p.assessment_units, "The cheat sheet does not list assessment units for this payer.", "assessment_units") + "</div>" +
      '<div class="bh-qr c"><h4>' + icon("doc", 15) + "Required Documents</h4>" +
        qrList(p.required_documents, "The cheat sheet does not list documents for this payer.", "required_documents") + "</div>" +
    "</div>";
  }

  // Callouts. Every one of these is the cheat sheet's own text, surfaced --
  // never advice written here. A payer with no hot buttons in the document gets
  // no hot buttons on screen; inventing plausible ones would be inventing payer
  // requirements, which is the one thing this feature must not do.
  function calloutsHtml(p) {
    let out = "";
    if (p.hot_buttons) {
      out += '<div class="bh-callout hot"><h4>' + icon("alert", 15) + "Reviewer Hot Button</h4>" +
        (p.hot_buttons.lead ? "<p>" + esc(p.hot_buttons.lead) + "</p>" : "") +
        "<ul>" + p.hot_buttons.points.map((t) => "<li>" + esc(txt(t)) + "</li>").join("") + "</ul></div>";
    }
    // Restrictions and billing instructions sit inside the quick-reference
    // text where they are easy to skim past, so they are repeated as a
    // "Don't Forget" -- quoted, not paraphrased.
    const notes = []
      .concat(p.assessment_authorization.map(txt))
      // .map(txt) on both, not just the first: an EDITED unit is an object
      // carrying who changed it, and the regex below would otherwise be run
      // against "[object Object]" and quietly match nothing.
      .concat((p.assessment_units || []).map(txt))
      .filter((t) => /\b\d+\s*days?\b|billed|increment|separately|same day|different days/i.test(t));
    if (notes.length) {
      out += '<div class="bh-callout tip"><h4>' + icon("bulb", 15) + "Don't Forget</h4>" +
        "<ul>" + notes.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul></div>";
    }
    return out;
  }

  function readinessHtml(p) {
    const checks = loadChecks();
    let total = 0, done = 0;
    sectionsFor(p).forEach((s) => itemsOf(s).forEach((it, i) => {
      total++;
      if (checks.has(itemId(s, s.items.indexOf(it)))) done++;
    }));
    const pct = total ? Math.round((done / total) * 100) : 0;
    const band = pct >= 100 ? "ok" : pct >= 50 ? "mid" : "low";
    const label = pct >= 100 ? "Complete" : pct >= 50 ? "Needs attention" : "Missing";
    const color = band === "ok" ? "#22c55e" : band === "mid" ? "#e0a430" : "#ef4444";
    return '<div class="bh-card"><div class="bh-ready">' +
      '<div class="bh-pct">' + pct + "%</div>" +
      '<div style="flex:1 1 220px;min-width:0;">' +
        '<div style="font-size:12.5px;font-weight:700;color:#4a4a68;margin-bottom:5px;">Treatment Plan Readiness ' +
          '<span class="bh-pill ' + band + '"><span class="dot"></span>' + label + "</span></div>" +
        '<div class="bh-bar"><i style="width:' + pct + "%;background:" + color + ';"></i></div>' +
        '<div style="font-size:11.5px;color:var(--text-muted,#6b6a86);margin-top:5px;">' + done + " of " + total +
          " requirements ticked. This is a review aid — it is not the client's plan and nothing here is saved to their record.</div>" +
      "</div>" +
      '<button class="bh-btn sm bh-noprint" id="bh-reset">Reset checklist</button>' +
    "</div></div>";
  }

  function checklistHtml(p) {
    const sections = sectionsFor(p);
    if (!sections.length) {
      return '<div class="bh-card"><div class="bh-empty">' +
        "<strong>The cheat sheet does not list treatment plan components for " + esc(p.name) + ".</strong><br>" +
        "Nothing is shown here rather than borrowing another payer's requirements. " +
        "Add them to the cheat sheet and they will appear." +
      "</div></div>";
    }
    const checks = loadChecks();
    const body = sections.map((s) => {
      const items = itemsOf(s);
      const done = items.filter((it) => checks.has(itemId(s, s.items.indexOf(it)))).length;
      const rows = s.items.map((it, idx) => {
        if (it.kind === "lead") return '<div class="bh-lead d' + it.depth + '">' + esc(it.text) + "</div>";
        if (state.mode !== "reauth" && it.reauth_only) return "";
        const id = itemId(s, idx);
        const on = checks.has(id);
        return '<label class="bh-item d' + it.depth + (on ? " done" : "") + (it.edited || it.added ? " bh-edited" : "") + '">' +
          '<input type="checkbox" data-check="' + attr(id) + '"' + (on ? " checked" : "") + " />" +
          "<span>" + esc(it.text) + reqActsHtml("section:" + s.key, it) + editedNoteHtml(it) + "</span></label>";
      }).join("");
      return '<details class="bh-sect"' + (done && done === items.length ? "" : " open") + ">" +
        "<summary>" + esc(s.title) +
          (s.group === "reauth" ? ' <span class="reauth-tag">Reauthorization</span>' : "") +
          ' <span class="cnt">' + done + "/" + items.length + "</span>" +
          '<span class="chev">&#9656;</span></summary>' +
        '<div class="body">' + rows + addReqHtml("section:" + s.key, "Add to this section") + "</div></details>";
    }).join("");
    return '<div style="margin-bottom:16px;">' +
      '<div class="bh-sec-title">Treatment Plan Checklist</div>' +
      '<p class="bh-sec-sub">Only what ' + esc(p.name) + " asks for. Tick items off as you review the draft.</p>" +
      body + "</div>";
  }

  // The rail beside the requirements: the things you reach for while reading
  // them. Two of its panels hold content THIS APPLICATION DOES NOT HAVE -- the
  // payer's own reference links, and the denial reasons that payer actually
  // gives. Neither is in the cheat sheet, and inventing either would put made-up
  // payer facts on a clinical screen, so each renders an empty state that says
  // what it is for and who can fill it in. A panel that admits it is empty is
  // worth more than one that quietly looks authoritative.
  function railHtml(p) {
    const links = Array.isArray(p.links) ? p.links : [];
    const denials = Array.isArray(p.denial_reasons) ? p.denial_reasons : [];
    const linkRows = links.length
      ? links.map((l) =>
          '<div class="bh-linkrow"><a href="' + attr(l.url) + '" target="_blank" rel="noopener noreferrer">' +
          esc(l.label) + "</a>" + icon("external", 13) + "</div>").join("")
      : '<div class="bh-none">No reference links saved for this payer yet.' +
        (state.canManageForms ? " An admin can add them in Admin Settings." : "") + "</div>";
    const denialRows = denials.length
      ? "<ul>" + denials.map((d) => "<li>" + esc(d) + "</li>").join("") + "</ul>"
      : '<div class="bh-none">No denial reasons recorded for this payer yet.' +
        (state.canManageForms ? " An admin can add the ones you actually see." : "") + "</div>";

    return '<aside class="bh-rail bh-noprint">' +
      '<div class="bh-actions" style="display:flex;flex-direction:column;gap:8px;">' +
        '<button class="bh-btn" id="bh-print">' + icon("print", 15) + "Print / Download View</button>" +
      "</div>" +
      '<div class="bh-card"><h4>' + icon("link", 14) + "Helpful Links</h4>" + linkRows + "</div>" +
      '<div class="bh-callout tip"><h4>' + icon("bulb", 14) + "Pro Tip</h4>" +
        "<p>Run this cheat sheet against the plan before you submit it. The readiness figure above only counts what you have ticked, so it is a check on your own reading rather than a score.</p></div>" +
      '<div class="bh-card"><h4>' + icon("alert", 14) + "Common Denial Reasons</h4>" + denialRows + "</div>" +
      '<div class="bh-callout info"><h4>' + icon("chat", 14) + "Still Unsure?</h4>" +
        "<p>Ask the Clinical Director, or check the payer's most recent bulletin. This sheet is only as current as the last time somebody updated it.</p></div>" +
    "</aside>";
  }

  function payerPanelHtml(p) {
    const i = state.payers.indexOf(p);
    const m = markFor(p, i);
    return '<div class="bh-card" style="padding:18px 20px;">' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;">' +
        payerMarkHtml(p, i, 38) +
        "<div><div style=\"font-size:18px;font-weight:800;color:var(--brand-navy,#1b2a6b);\">" + esc(p.name) + "</div>" +
        '<div style="font-size:12px;color:var(--text-muted,#6b6a86);">Quick reference for assessment authorization and treatment plan requirements.</div></div>' +
        '<div style="margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
          preauthTagHtml(p) +
          (state.canEditRequirements
            ? '<button class="bh-btn sm bh-noprint" data-preauth="' + attr(p.key) + '">Change</button>' : "") +
        "</div>" +
      "</div>" +
      (p.preauth && p.preauth.note
        ? '<div class="bh-preauth-note">' + esc(p.preauth.note) + "</div>" : "") +
      '<div class="bh-toggle bh-noprint" role="tablist">' +
        '<button data-mode="initial"' + (state.mode === "initial" ? ' class="on"' : "") + ">Initial Authorization</button>" +
        '<button data-mode="reauth"' + (state.mode === "reauth" ? ' class="on"' : "") + ">Reauthorization</button>" +
      "</div>" +
      (state.mode === "reauth"
        ? '<div class="bh-callout info"><h4>' + icon("book", 15) + "Reauthorization view</h4>" +
          "<p>A reauthorization is still a treatment plan, so everything an initial plan needs is shown here as well. " +
          "The sections this payer adds for continued authorization are marked.</p></div>"
        : "") +
      quickRefHtml(p) +
      calloutsHtml(p) +
    "</div>" +
    readinessHtml(p) +
    checklistHtml(p) +
    '<div class="bh-quote">A well-documented plan today means fewer barriers tomorrow.</div>';
  }

  // Main column and rail side by side, with the compare invitation underneath
  // where it reads as an offer rather than as another control in the header.
  function cheatsheetLayoutHtml(p) {
    return '<div class="bh-layout"><div>' + payerPanelHtml(p) + "</div>" + railHtml(p) + "</div>" +
      '<div class="bh-cta bh-noprint"><div>' +
        '<div class="t">Need to compare payers?</div>' +
        '<div class="s">See what two payers ask for side by side, so the differences are the thing you read.</div>' +
      "</div>" +
      '<button class="bh-btn primary" id="bh-compare">' + icon("scales", 15) + "Compare Payers</button></div>";
  }

  // ---- compare -----------------------------------------------------------
  function compareHtml() {
    const [a, b] = state.compare;
    const pa = state.payers.find((p) => p.key === a), pb = state.payers.find((p) => p.key === b);
    const opts = (sel) => state.payers.map((p) =>
      '<option value="' + attr(p.key) + '"' + (p.key === sel ? " selected" : "") + ">" + esc(p.name) + "</option>").join("");
    const list = (vals, empty) => {
      const arr = (vals || []).map((v) => (typeof v === "string" ? v : v.text));
      return arr.length ? "<ul>" + arr.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>"
        : '<span class="bh-none">' + esc(empty) + "</span>";
    };
    const majorSections = (p) => {
      const s = p.sections.filter((x) => x.group === "plan" && x.title);
      return s.length ? "<ul>" + s.map((x) => "<li>" + esc(x.title) + "</li>").join("") + "</ul>"
        : (p.sections.length
          ? '<span class="bh-none">One list, no named sections (' +
            p.sections.reduce((n, x) => n + x.items.filter((i) => i.kind === "item").length, 0) + " requirements)</span>"
          : '<span class="bh-none">Not listed in the cheat sheet</span>');
    };
    const reauth = (p) => {
      const s = p.sections.filter((x) => x.group === "reauth");
      const items = s.reduce((n, x) => n + x.items.filter((i) => i.kind === "item").length, 0);
      return s.length ? "<ul>" + s.map((x) => "<li>" + esc(x.title) + "</li>").join("") + "</ul>" +
        '<div style="font-size:11.5px;color:var(--text-muted,#6b6a86);margin-top:4px;">' + items + " added requirements</div>"
        : '<span class="bh-none">Nothing additional listed</span>';
    };
    const row = (label, fa, fb) => "<tr><th class=\"rowh\">" + esc(label) + "</th><td>" + fa + "</td><td>" + fb + "</td></tr>";
    return '<div class="bh-card bh-cmp">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;">' +
        '<div class="bh-sec-title" style="margin:0;">Compare Payers</div>' +
        '<div style="margin-left:auto;display:flex;gap:8px;align-items:center;">' +
          '<select id="bh-cmp-a">' + opts(a) + "</select><span style=\"color:var(--text-muted,#6b6a86);\">vs</span>" +
          '<select id="bh-cmp-b">' + opts(b) + "</select>" +
          '<button class="bh-btn sm" id="bh-cmp-close">Close</button>' +
        "</div>" +
      "</div>" +
      '<div class="scroll">' +
      "<table><thead><tr><th class=\"rowh\"></th><th>" + esc(pa.name) + "</th><th>" + esc(pb.name) + "</th></tr></thead><tbody>" +
        row("Assessment authorization", list(pa.assessment_authorization, "Not listed"), list(pb.assessment_authorization, "Not listed")) +
        row("Assessment units", list(pa.assessment_units, "Not listed"), list(pb.assessment_units, "Not listed")) +
        row("Required forms / documents", list(pa.required_documents, "Not listed"), list(pb.required_documents, "Not listed")) +
        row("Treatment plan sections", majorSections(pa), majorSections(pb)) +
        row("Reauthorization", reauth(pa), reauth(pb)) +
      "</tbody></table></div>" +
      '<p class="bh-sec-sub" style="margin:12px 0 0;">Differences are shown as the cheat sheet records them. ' +
      "A blank on one side means that payer's entry does not cover it, not that the requirement does not exist.</p>" +
    "</div>";
  }

  // ================= form library =========================================
  function formCardHtml(f) {
    const acts = [];
    if (f.has_file) {
      acts.push('<a class="bh-btn sm" href="/api/bcba/forms/' + f.id + '/file" download>' +
        icon("download", 13) + (f.editable ? "Download Editable" : "Download") + "</a>");
      if (f.can_print) {
        acts.push('<a class="bh-btn sm" href="/api/bcba/forms/' + f.id + '/file?disposition=inline" target="_blank" rel="noopener">' +
          icon("print", 13) + "Print</a>");
      }
    }
    if (state.canManageForms) {
      acts.push('<button class="bh-btn sm" data-edit-form="' + f.id + '">Edit</button>');
      acts.push('<button class="bh-btn sm" data-archive-form="' + f.id + '">' + (f.archived ? "Restore" : "Archive") + "</button>");
      if (f.archived) acts.push('<button class="bh-btn sm dgr" data-delete-form="' + f.id + '">Delete</button>');
    }
    return '<div class="bh-form">' +
      '<div style="display:flex;gap:8px;align-items:flex-start;">' +
        '<span style="color:#5b4bbd;margin-top:1px;">' + icon("doc", 17) + "</span>" +
        '<div class="nm">' + esc(f.name) + "</div>" +
      "</div>" +
      '<div class="ds">' + (f.description ? esc(f.description) : '<span class="bh-none">No description</span>') + "</div>" +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
        '<span class="bh-tag">' + esc(f.category_label) + "</span>" +
        (f.payer_name ? '<span class="bh-tag pay">' + esc(f.payer_name) + "</span>" : "") +
        (f.form_code ? '<span class="bh-tag">' + esc(f.form_code) + "</span>" : "") +
        (f.archived ? '<span class="bh-tag arch">Archived</span>' : "") +
      "</div>" +
      '<div class="bh-actions">' + acts.join("") + "</div>" +
    "</div>";
  }

  function formsHtml() {
    const q = state.formQuery.trim().toLowerCase();
    const visible = state.forms.filter((f) => {
      if (!state.showArchived && f.archived) return false;
      if (state.formFilter !== "all" && f.category !== state.formFilter) return false;
      if (!q) return true;
      return [f.name, f.description, f.form_code, f.payer_name, f.category_label]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    });
    const chips = [{ key: "all", label: "All" }].concat(state.categories)
      .map((c) => '<button class="bh-chip' + (state.formFilter === c.key ? " on" : "") + '" data-cat="' + attr(c.key) + '">' + esc(c.label) + "</button>").join("");
    return '<div class="bh-formbar">' +
        '<div class="bh-search">' + icon("search", 16) +
          '<input id="bh-form-q" type="text" placeholder="Search forms" value="' + attr(state.formQuery) + '" />' +
        "</div>" +
        (state.canManageForms
          ? '<button class="bh-btn pri" id="bh-add-form">' + icon("plus", 15) + "Add Form</button>" +
            '<label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted,#6b6a86);">' +
            '<input type="checkbox" id="bh-show-arch"' + (state.showArchived ? " checked" : "") + " /> Show archived</label>"
          : "") +
      "</div>" +
      '<div class="bh-chips" style="margin-bottom:14px;">' + chips + "</div>" +
      (visible.length
        ? '<div class="bh-forms">' + visible.map(formCardHtml).join("") + "</div>"
        : '<div class="bh-card"><div class="bh-empty">' +
          (state.forms.length
            ? "No forms match that search."
            : "The Form Library is empty." + (state.canManageForms ? " Use Add Form to upload the first one." : " An admin can add forms to it.")) +
          "</div></div>");
  }

  // ---- add / edit a form -------------------------------------------------
  // One text box. A requirement is a sentence, and an editor with a rich
  // toolbar would invite formatting that the payer's own document does not use.
  function requirementDialog(opts) {
    const wrap = document.createElement("div");
    wrap.className = "bh-modal";
    wrap.innerHTML = '<div class="box">' +
      "<h3>" + esc(opts.title) + "</h3>" +
      '<div class="bh-err" id="bh-rq-err" style="display:none;"></div>' +
      (opts.original
        ? '<div style="font-size:12px;color:var(--text-muted,#6b6a86);margin-bottom:10px;">' +
          "The cheat sheet says: <em>" + esc(opts.original) + "</em></div>"
        : "") +
      '<div class="bh-fld"><label>Requirement</label>' +
        '<textarea id="bh-rq-text" rows="4">' + esc(opts.value || "") + "</textarea>" +
        '<div class="hint">Written as the payer words it. This replaces what BCBAs see for this payer only.</div></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">' +
        '<button class="bh-btn sm" id="bh-rq-cancel">Cancel</button>' +
        '<button class="bh-btn primary sm" id="bh-rq-save">Save</button>' +
      "</div></div>";
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
    wrap.querySelector("#bh-rq-cancel").addEventListener("click", close);
    const err = wrap.querySelector("#bh-rq-err");
    wrap.querySelector("#bh-rq-save").addEventListener("click", async () => {
      const text = wrap.querySelector("#bh-rq-text").value.trim();
      if (!text) { err.style.display = "block"; err.textContent = "A requirement needs some text."; return; }
      try { await opts.onSave(text); close(); }
      catch (e) { err.style.display = "block"; err.textContent = e.message; }
    });
    setTimeout(() => { const t = wrap.querySelector("#bh-rq-text"); if (t) t.focus(); }, 30);
  }

  function preauthDialog(p, after) {
    const cur = (p.preauth && p.preauth.required) || "unknown";
    const opt = (v, label) =>
      '<label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;font-size:13.5px;">' +
      '<input type="radio" name="bh-pa" value="' + v + '"' + (cur === v ? " checked" : "") + " />" +
      "<span>" + esc(label) + "</span></label>";
    const wrap = document.createElement("div");
    wrap.className = "bh-modal";
    wrap.innerHTML = '<div class="box">' +
      "<h3>Pre-authorization &mdash; " + esc(p.name) + "</h3>" +
      '<div class="bh-err" id="bh-pa-err" style="display:none;"></div>' +
      opt("required", "A pre-authorization is required before the assessment") +
      opt("not_required", "No pre-authorization is required for the assessment") +
      opt("unknown", "Not known / not recorded") +
      '<div class="bh-fld" style="margin-top:10px;"><label>Note</label>' +
        '<textarea id="bh-pa-note" rows="3">' + esc((p.preauth && p.preauth.note) || "") + "</textarea>" +
        '<div class="hint">What the payer actually says, and where it came from. This is shown under the marker.</div></div>' +
      '<p style="font-size:11.5px;color:var(--text-muted,#6b6a86);margin:8px 0 0;">Saving records this as set by the practice rather than quoted from the cheat sheet.</p>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">' +
        '<button class="bh-btn sm" id="bh-pa-cancel">Cancel</button>' +
        '<button class="bh-btn primary sm" id="bh-pa-save">Save</button>' +
      "</div></div>";
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
    wrap.querySelector("#bh-pa-cancel").addEventListener("click", close);
    const err = wrap.querySelector("#bh-pa-err");
    wrap.querySelector("#bh-pa-save").addEventListener("click", async () => {
      const sel = wrap.querySelector('input[name="bh-pa"]:checked');
      try {
        await api("/api/bcba/payers/" + encodeURIComponent(p.key) + "/preauth", {
          method: "PUT",
          body: { required: sel ? sel.value : "unknown", note: wrap.querySelector("#bh-pa-note").value.trim() },
        });
        close();
        await after();
      } catch (e) { err.style.display = "block"; err.textContent = e.message; }
    });
  }

  function formDialog(existing) {
    const f = existing || {};
    const cats = state.categories.map((c) =>
      '<option value="' + attr(c.key) + '"' + (f.category === c.key ? " selected" : "") + ">" + esc(c.label) + "</option>").join("");
    const payers = '<option value="">Not payer-specific</option>' + state.payers.map((p) =>
      '<option value="' + attr(p.key) + '"' + (f.payer_key === p.key ? " selected" : "") + ">" + esc(p.name) + "</option>").join("");
    const wrap = document.createElement("div");
    wrap.className = "bh-modal";
    wrap.innerHTML = '<div class="box">' +
      "<h3>" + (existing ? "Edit form" : "Add a form") + "</h3>" +
      '<div class="bh-err" id="bh-fd-err" style="display:none;"></div>' +
      '<div class="bh-fld"><label>Form name</label><input type="text" id="bh-fd-name" value="' + attr(f.name || "") + '" /></div>' +
      '<div class="bh-fld"><label>Short description</label><textarea id="bh-fd-desc" rows="2">' + esc(f.description || "") + "</textarea></div>" +
      '<div class="bh-fld"><label>Category</label><select id="bh-fd-cat">' + cats + "</select></div>" +
      '<div class="bh-fld"><label>Associated payer</label><select id="bh-fd-payer">' + payers + "</select></div>" +
      '<div class="bh-fld"><label>Form code</label><input type="text" id="bh-fd-code" value="' + attr(f.form_code || "") + '" />' +
        '<div class="hint">A Nevada form code such as FA-11F. When the cheat sheet names this code, the requirement links straight to this file.</div></div>' +
      '<div class="bh-fld"><label style="display:inline-flex;align-items:center;gap:7px;font-weight:600;">' +
        '<input type="checkbox" id="bh-fd-edit"' + (f.editable ? " checked" : "") + " /> This file can be edited and filled in</label>" +
        '<div class="hint">Shows as "Download Editable" rather than "Download".</div></div>' +
      '<div class="bh-fld"><label>' + (existing ? "Replace the file (optional)" : "File") + "</label><input type=\"file\" id=\"bh-fd-file\" />" +
        (existing && f.filename ? '<div class="hint">Currently: ' + esc(f.filename) + "</div>" : "") + "</div>" +
      '<div class="bh-actions" style="justify-content:flex-end;margin-top:16px;">' +
        '<button class="bh-btn" id="bh-fd-cancel">Cancel</button>' +
        '<button class="bh-btn pri" id="bh-fd-save">' + (existing ? "Save changes" : "Add form") + "</button>" +
      "</div></div>";
    document.body.appendChild(wrap);

    const close = () => wrap.remove();
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
    wrap.querySelector("#bh-fd-cancel").addEventListener("click", close);

    wrap.querySelector("#bh-fd-save").addEventListener("click", async () => {
      const err = wrap.querySelector("#bh-fd-err");
      const show = (m) => { err.textContent = m; err.style.display = "block"; };
      const name = wrap.querySelector("#bh-fd-name").value.trim();
      if (!name) return show("A form needs a name.");
      const file = wrap.querySelector("#bh-fd-file").files[0] || null;
      if (!existing && !file) return show("Choose a file to upload.");
      const meta = {
        name: name,
        description: wrap.querySelector("#bh-fd-desc").value.trim(),
        category: wrap.querySelector("#bh-fd-cat").value,
        payer_key: wrap.querySelector("#bh-fd-payer").value,
        form_code: wrap.querySelector("#bh-fd-code").value.trim(),
        editable: wrap.querySelector("#bh-fd-edit").checked,
      };
      const btn = wrap.querySelector("#bh-fd-save");
      btn.disabled = true;
      try {
        if (existing) {
          await api("/api/bcba/forms/" + existing.id, { method: "PATCH", body: meta });
          if (file) await uploadFile("/api/bcba/forms/" + existing.id + "/file", file, {});
        } else {
          await uploadFile("/api/bcba/forms", file, meta);
        }
        close();
        await reloadBoth();
        render();
      } catch (e) {
        btn.disabled = false;
        show(e.message);
      }
    });
  }

  // The file goes up as the raw body with its metadata on the query string --
  // the shape the server already accepts for the onboarding portal, so there is
  // no multipart parser anywhere in this codebase.
  async function uploadFile(url, file, meta) {
    const qs = new URLSearchParams();
    Object.keys(meta || {}).forEach((k) => {
      const v = meta[k];
      if (v === true) qs.set(k, "1");
      else if (v === false || v == null || v === "") { /* omitted */ }
      else qs.set(k, String(v));
    });
    qs.set("filename", file.name);
    qs.set("mime", file.type || "application/octet-stream");
    const res = await fetch(url + "?" + qs.toString(), {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "Upload failed");
    return d;
  }

  // ================= shell ================================================
  const TABS = [
    { key: "cheatsheet", label: "Treatment Plan Cheat Sheet", icon: "clipboard" },
    { key: "forms", label: "Form Library", icon: "folder" },
    { key: "resources", label: "Clinical Resources", icon: "book", soon: true },
    { key: "student", label: "Student Analyst", icon: "people", soon: true },
  ];

  let mountEl = null;

  function comingSoonHtml(label) {
    return '<div class="bh-card"><div class="bh-empty">' +
      "<strong>" + esc(label) + " is coming soon.</strong><br>" +
      "This space is reserved. Nothing is here yet, so nothing here is out of date." +
    "</div></div>";
  }

  function render() {
    if (!mountEl) return;
    const tabs = TABS.map((t) =>
      '<button class="bh-tab' + (state.tab === t.key ? " on" : "") + '" data-tab="' + attr(t.key) + '"' + (t.soon ? " disabled" : "") + ">" +
      icon(t.icon, 16) + esc(t.label) + (t.soon ? ' <span class="bh-soon">Coming soon</span>' : "") + "</button>").join("");

    let body = "";
    if (state.tab === "cheatsheet") {
      const p = payer();
      body = heroHtml() + payerPickerHtml() +
        (state.compare ? compareHtml() : "") +
        (p ? cheatsheetLayoutHtml(p)
           : '<div class="bh-card"><div class="bh-empty">Pick a payer above to see what they require.</div></div>');
    } else if (state.tab === "forms") {
      body = formsHtml();
    } else {
      body = comingSoonHtml((TABS.find((t) => t.key === state.tab) || {}).label || "This area");
    }

    mountEl.innerHTML = '<div class="bh">' +
      '<div class="bh-head bh-noprint"><h1>BCBA Hub</h1>' +
      "<p>Clinical reference, tools and forms in one place.</p></div>" +
      '<div class="bh-tabs bh-noprint">' + tabs + "</div>" + body + "</div>";
    wire();
  }

  function wire() {
    const q = (sel) => mountEl.querySelector(sel);
    mountEl.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      if (b.disabled) return;
      state.tab = b.dataset.tab;
      state.compare = null;
      savePlace();
      render();
    }));
    mountEl.querySelectorAll("[data-payer]").forEach((b) => b.addEventListener("click", () => {
      state.payerKey = state.payerKey === b.dataset.payer ? null : b.dataset.payer;
      state.compare = null;
      savePlace();
      render();
    }));
    // ---- editing a payer's requirements ---------------------------------
    // Every one of these reloads the cheat sheet from the server afterwards
    // rather than patching the page. The overlay is applied server-side, and a
    // page that guessed at the result would drift from what the next person to
    // open it sees.
    const reloadCheatsheet = async () => { await loadCheatsheet(); render(); };

    mountEl.querySelectorAll("[data-req-edit]").forEach((b) => b.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      requirementDialog({
        title: "Change this requirement",
        value: b.dataset.reqOrig,
        original: b.dataset.reqOrig,
        onSave: async (text) => {
          await api("/api/bcba/requirements", { method: "POST", body: {
            payer_key: b.dataset.reqPayer, list_key: b.dataset.reqList,
            op: "edit", original_text: b.dataset.reqOrig, text,
          } });
          await reloadCheatsheet();
        },
      });
    }));

    mountEl.querySelectorAll("[data-req-remove]").forEach((b) => b.addEventListener("click", async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      // Confirmed, because it takes a line off what every BCBA is told to
      // submit. It is recoverable -- the original is kept and Revert puts it
      // back -- and the wording says so, so nobody is scared off a correction.
      if (!window.confirm("Take this requirement off " + b.dataset.reqPayer + "'s list?\n\n" +
        b.dataset.reqOrig + "\n\nThe cheat sheet's wording is kept and you can put it back.")) return;
      await api("/api/bcba/requirements", { method: "POST", body: {
        payer_key: b.dataset.reqPayer, list_key: b.dataset.reqList,
        op: "remove", original_text: b.dataset.reqOrig,
      } });
      await reloadCheatsheet();
    }));

    mountEl.querySelectorAll("[data-req-add]").forEach((b) => b.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      requirementDialog({
        title: "Add a requirement",
        value: "",
        onSave: async (text) => {
          await api("/api/bcba/requirements", { method: "POST", body: {
            payer_key: b.dataset.reqPayer, list_key: b.dataset.reqAdd, op: "add", text,
          } });
          await reloadCheatsheet();
        },
      });
    }));

    mountEl.querySelectorAll("[data-req-undo]").forEach((b) => b.addEventListener("click", async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      await api("/api/bcba/requirements/" + encodeURIComponent(b.dataset.reqUndo), { method: "DELETE" });
      await reloadCheatsheet();
    }));

    mountEl.querySelectorAll("[data-preauth]").forEach((b) => b.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const p = state.payers.find((x) => x.key === b.dataset.preauth);
      preauthDialog(p, reloadCheatsheet);
    }));

    mountEl.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      savePlace();
      render();
    }));
    mountEl.querySelectorAll("[data-check]").forEach((cb) => cb.addEventListener("change", () => {
      const set = loadChecks();
      if (cb.checked) set.add(cb.dataset.check); else set.delete(cb.dataset.check);
      saveChecks(set);
      // Redraw so the readiness figure and the per-section counts move with the
      // tick rather than after a reload. The open/closed state of a section is
      // driven by whether it is finished, so it stays coherent.
      render();
    }));
    const reset = q("#bh-reset");
    if (reset) reset.addEventListener("click", () => { saveChecks(new Set()); render(); });

    const print = q("#bh-print");
    if (print) print.addEventListener("click", () => {
      // Everything opens first: a collapsed section prints as a heading with
      // nothing under it, which is worse than not printing at all.
      mountEl.querySelectorAll("details.bh-sect").forEach((d) => { d.open = true; });
      window.print();
    });

    const cmp = q("#bh-compare");
    if (cmp) cmp.addEventListener("click", () => {
      const others = state.payers.filter((p) => p.key !== state.payerKey);
      state.compare = [state.payerKey, others.length ? others[0].key : state.payerKey];
      render();
      const el = mountEl.querySelector(".bh-cmp");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const cmpClose = q("#bh-cmp-close");
    if (cmpClose) cmpClose.addEventListener("click", () => { state.compare = null; render(); });
    ["#bh-cmp-a", "#bh-cmp-b"].forEach((sel, i) => {
      const el = q(sel);
      if (el) el.addEventListener("change", () => { state.compare[i] = el.value; render(); });
    });

    // ---- payer search: same focus-restoring pattern the form search uses,
    // because re-rendering on every keystroke otherwise drops the caret.
    const psearch = q("#bh-payer-search");
    if (psearch) psearch.addEventListener("input", () => {
      state.payerSearch = psearch.value;
      const at = psearch.selectionStart;
      render();
      const again = mountEl.querySelector("#bh-payer-search");
      if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (e) { /* not a text input */ } }
    });

    // ---- forms
    mountEl.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
      state.formFilter = b.dataset.cat;
      render();
    }));
    const search = q("#bh-form-q");
    if (search) search.addEventListener("input", () => {
      state.formQuery = search.value;
      const at = search.selectionStart;
      render();
      const again = mountEl.querySelector("#bh-form-q");
      if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (e) { /* not a text input */ } }
    });
    const arch = q("#bh-show-arch");
    if (arch) arch.addEventListener("change", async () => {
      state.showArchived = arch.checked;
      await loadForms();
      render();
    });
    const add = q("#bh-add-form");
    if (add) add.addEventListener("click", () => formDialog(null));
    mountEl.querySelectorAll("[data-edit-form]").forEach((b) => b.addEventListener("click", () =>
      formDialog(state.forms.find((f) => f.id === Number(b.dataset.editForm)))));
    mountEl.querySelectorAll("[data-archive-form]").forEach((b) => b.addEventListener("click", async () => {
      const f = state.forms.find((x) => x.id === Number(b.dataset.archiveForm));
      b.disabled = true;
      try {
        await api("/api/bcba/forms/" + f.id, { method: "PATCH", body: { archived: !f.archived } });
        await reloadBoth();
        render();
      } catch (e) { b.disabled = false; alert(e.message); }
    }));
    mountEl.querySelectorAll("[data-delete-form]").forEach((b) => b.addEventListener("click", async () => {
      const f = state.forms.find((x) => x.id === Number(b.dataset.deleteForm));
      if (!window.confirm("Delete \"" + f.name + "\" permanently? It is already archived, so leaving it archived keeps the record.")) return;
      b.disabled = true;
      try {
        await api("/api/bcba/forms/" + f.id, { method: "DELETE" });
        await reloadBoth();
        render();
      } catch (e) { b.disabled = false; alert(e.message); }
    }));
  }

  async function loadForms() {
    const d = await api("/api/bcba/forms" + (state.showArchived ? "?archived=1" : ""));
    state.forms = d.forms || [];
    state.categories = d.categories || state.categories;
    state.canManageForms = !!d.can_manage;
  }

  async function loadCheatsheet() {
    const d = await api("/api/bcba/cheatsheet");
    state.payers = d.payers || [];
    state.categories = d.categories || state.categories;
    state.canManageForms = !!d.can_manage_forms;
    state.canEditRequirements = !!d.can_edit_requirements;
    state.orphanedEdits = d.orphaned_edits || [];
  }

  // The two halves are joined by the form codes, so a change to the library
  // changes the cheat sheet as well: uploading FA-11F is what makes NV
  // Medicaid's requirement downloadable, and archiving it is what stops the
  // requirement offering a file that is no longer current. Refreshing only the
  // library would leave the payer page showing yesterday's answer.
  async function reloadBoth() {
    await Promise.all([loadForms(), loadCheatsheet()]);
  }

  window.__renderBcbaHub = async function (mount) {
    injectStyles();
    mountEl = mount;
    mount.innerHTML = '<div class="bh"><div class="bh-empty">Loading the BCBA Hub…</div></div>';
    try {
      await loadCheatsheet();
      await loadForms();
    } catch (e) {
      mount.innerHTML = '<div class="bh"><div class="bh-err">Couldn\'t load the BCBA Hub: ' + esc(e.message) + "</div></div>";
      return;
    }
    // Come back to where the reviewer was, but only to somewhere that still
    // exists: a payer dropped from the cheat sheet falls back to the first one
    // rather than to a blank page.
    const place = loadPlace();
    if (place.payer && state.payers.some((p) => p.key === place.payer)) state.payerKey = place.payer;
    if (place.mode === "initial" || place.mode === "reauth") state.mode = place.mode;
    if (place.tab === "cheatsheet" || place.tab === "forms") state.tab = place.tab;
    if (!state.payerKey && state.payers.length) state.payerKey = state.payers[0].key;
    render();
  };
})();
