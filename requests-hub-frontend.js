// requests-hub-frontend.js -- REQUESTS & REPORTS.
//
// The front door to four systems that stay four systems. The spec is explicit
// that the RECORDS must not be combined into one list, and that is not a
// styling preference -- each of these has its own permissions, its own
// statuses, its own dashboard and, in one case, a confidentiality model that a
// merged list would quietly break. So this is a ROUTER. It owns no records,
// no table and no API of its own.
//
// It also deliberately holds no permission logic. Each card's count comes from
// that module's OWN list endpoint, called from the browser, so that module's
// own permission check is the one that answers -- a 403 simply means no
// number. Re-deriving "can this person see supply requests" here would be a
// second copy of a rule that already exists, and second copies drift.
//
// REPORT A CONCERN IS A PLAIN DOOR, with no count and no status. The card is
// for everyone, because raising a concern is a normal act available to all
// staff. But a number on it would leak sideways in exactly the way the rest of
// that feature works to prevent: "2 open" on a screen somebody is looking at
// over your shoulder says a concern exists, and a reviewer's count would say
// how many. Its own dashboard is the only place that answers those questions.
(function () {
  "use strict";
  const HASH = "#/requests";
  const ACCENT = "#1b2a6b";

  function canSee() {
    return typeof state !== "undefined" && !!state.user && !!state.user.id;
  }
  function shellReady() { return typeof state !== "undefined" && !!state.user; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // Each card names the question a person actually arrives with, because
  // "Supply Requests" only tells you where to go if you already know the
  // vocabulary. "I need supplies" does not need explaining to anybody.
  const CARDS = [
    {
      key: "supply", hash: "#/supply", title: "Supply Requests",
      ask: "I need supplies.",
      detail: "Anything the clinic needs ordered or restocked — materials, equipment, household items.",
      color: "#4f46e5",
      count: async () => {
        const d = await fetch("/api/supply/requests?status=open").then((r) => r.ok ? r.json() : null);
        if (!d) return null;
        const c = d.counts || {};
        return d.is_owner
          ? { n: (c.Submitted || 0) + (c.Approved || 0) + (c.Ordered || 0), label: "open" }
          : { n: (d.rows || []).length, label: "yours open" };
      },
    },
    {
      key: "maintenance", hash: "#/maintenance", title: "Maintenance Requests",
      ask: "Something is broken.",
      detail: "Plumbing, electrical, HVAC, doors and locks, furniture, a safety hazard — anything about the building itself.",
      color: "#b45309",
      count: async () => {
        const d = await fetch("/api/maintenance/requests").then((r) => r.ok ? r.json() : null);
        if (!d) return null;
        const c = d.counts || {};
        // Safety is surfaced on the card, not buried a click away. A broken
        // lock on a door children use is the one thing here that should not
        // wait for somebody to go looking.
        return { n: c.open || 0, label: "open", alert: c.safety ? c.safety + " safety" : null };
      },
    },
    {
      key: "policy_changes", hash: "#/policy-changes", title: "Policy Change Requests",
      ask: "I think a policy should change.",
      detail: "Ask for a rule to be created, modified or discontinued. Goes to the monthly policy review.",
      color: "#7c3aed",
      // Said on the card, not only inside: somebody deciding whether to click
      // should already know that asking changes nothing by itself.
      note: "Submitting a request does not change the current policy.",
      color2: true,
      count: async () => {
        const d = await fetch("/api/policy-changes").then((r) => r.ok ? r.json() : null);
        if (!d) return null;
        const c = d.counts || {};
        return d.can_review
          ? { n: c.awaiting || 0, label: "awaiting review" }
          : { n: (d.requests || []).length, label: "yours" };
      },
    },
    {
      key: "concerns", hash: "#/concerns", title: "Report a Concern",
      ask: "I have seen something concerning.",
      detail: "Something that may be inconsistent with our policies, procedures, professional standards, safety expectations, or our commitment to fair and consistent operations.",
      color: "#0f766e",
      note: "Submitting a concern does not mean wrongdoing has occurred.",
      // NO COUNT. See the header. This is the one card that must not carry a
      // number, and leaving `count` undefined is how that is enforced rather
      // than by remembering not to call it.
      count: null,
    },
  ];

  function injectNav() {
    if (!canSee()) return;
    const nav = document.querySelector(".sidebar nav");
    if (!nav || document.getElementById("reqhub-nav-btn")) return;
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.id = "reqhub-nav-btn";
    btn.dataset.nav = "requests";
    btn.innerHTML = "Requests &amp; Reports";
    const sib = nav.querySelector('[data-nav="supply"]') || nav.querySelector(".nav-item");
    if (sib) btn.draggable = sib.draggable;
    btn.addEventListener("click", () => { location.hash = HASH; });
    nav.appendChild(btn);
    if (typeof window.__navPlace === "function") window.__navPlace(btn);
  }

  function cardHtml(c) {
    return '<button class="reqhub-card" data-hash="' + esc(c.hash) + '" data-key="' + esc(c.key) + '" ' +
      'style="all:unset;cursor:pointer;display:block;background:#fff;border:1px solid #e6e1d4;' +
      'border-top:4px solid ' + c.color + ';border-radius:14px;padding:18px 20px;box-sizing:border-box;' +
      'transition:box-shadow .15s,transform .15s;">' +
      '<div style="font-size:17px;font-weight:800;color:' + c.color + ';margin-bottom:2px;">' + esc(c.title) + "</div>" +
      '<div style="font-size:14px;font-weight:700;color:#1f2430;margin-bottom:6px;">' + esc(c.ask) + "</div>" +
      '<div style="font-size:12.5px;color:#767488;line-height:1.5;">' + esc(c.detail) + "</div>" +
      (c.note ? '<div style="font-size:12px;color:#8a8797;margin-top:8px;font-style:italic;">' + esc(c.note) + "</div>" : "") +
      '<div class="reqhub-count" data-for="' + esc(c.key) + '" style="margin-top:12px;min-height:22px;"></div>' +
      "</button>";
  }

  async function render() {
    const mount = document.getElementById("view-mount");
    if (!mount) return;
    mount.dataset.reqhub = "1";
    mount.innerHTML =
      '<div style="padding:24px 28px 60px;max-width:960px;">' +
        '<h1 style="font-size:24px;margin:0;font-weight:800;color:' + ACCENT + ';">Requests &amp; Reports</h1>' +
        '<p style="margin:8px 0 20px;color:#767488;font-size:13.5px;max-width:720px;">' +
          "Four separate systems, each with its own records and its own people looking after them. " +
          "Pick the one that matches what you need." +
        "</p>" +
        '<div id="reqhub-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;">' +
          CARDS.map(cardHtml).join("") +
        "</div>" +
      "</div>";

    mount.querySelectorAll(".reqhub-card").forEach((el) => {
      el.addEventListener("click", () => { location.hash = el.getAttribute("data-hash"); });
      el.addEventListener("mouseenter", () => {
        el.style.boxShadow = "0 6px 18px rgba(27,42,107,.10)"; el.style.transform = "translateY(-1px)";
      });
      el.addEventListener("mouseleave", () => { el.style.boxShadow = "none"; el.style.transform = "none"; });
    });

    // Counts are fetched after the cards are on the screen, each independently.
    // A module that is switched off, or that refuses this person, simply never
    // fills its slot -- it does not block the other three, and it does not
    // turn the hub into an error page.
    CARDS.forEach(async (c) => {
      if (!c.count) return;
      let r = null;
      try { r = await c.count(); } catch (e) { r = null; }
      const slot = mount.querySelector('.reqhub-count[data-for="' + c.key + '"]');
      if (!slot || !r) return;
      slot.innerHTML =
        '<span style="background:' + c.color + '1a;color:' + c.color + ';border-radius:20px;padding:4px 11px;' +
        'font-size:12.5px;font-weight:700;">' + r.n + " " + esc(r.label) + "</span>" +
        (r.alert ? '<span style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;border-radius:20px;' +
          'padding:4px 11px;font-size:12.5px;font-weight:800;margin-left:6px;">' + esc(r.alert) + "</span>" : "");
    });
  }

  function onHash() {
    if (location.hash !== HASH) return;
    if (!shellReady()) { setTimeout(onHash, 250); return; }
    if (!canSee()) { location.hash = "#/dashboard"; return; }
    render();
    [120, 400, 900].forEach((ms) => setTimeout(() => {
      const m = document.getElementById("view-mount");
      if (location.hash === HASH && m && m.dataset.reqhub !== "1") render();
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
