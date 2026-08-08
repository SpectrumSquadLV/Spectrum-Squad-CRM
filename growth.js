// growth.js -- Two additive sections:
//   1. Lead Management (School / Private / Other contracts + general leads)
//   2. Policies, SOPs & Procedures (with a public, QR-linkable viewer)
//
// Additive per RULE ZERO: new tables crm_leads / crm_policies, routes under
// /api/leads/* and /api/policies/*, and a PUBLIC page at /policies for the
// printable QR code. Reuses nothing existing.

module.exports = function initGrowth(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, crypto, readBody, json, extractPdfLines, unzip } = ctx;

  const LEAD_TYPES = ["School", "Private Pay", "Insurance", "Community Partner", "Other"];
  const LEAD_STAGES = ["New", "Contacted", "Meeting Set", "Proposal Sent", "Won", "Lost"];
  const POLICY_CATEGORIES = ["HR", "Clinical", "Safety", "Billing", "Operations", "Compliance", "Other"];
  // One colour per category, so the cards read at a glance and stay consistent
  // between the staff view and the public QR page.
  const CATEGORY_COLORS = {
    HR: "#3f56b5",
    Clinical: "#3f8f89",
    Safety: "#d94f4f",
    Billing: "#c98a1b",
    Operations: "#6a5acd",
    Compliance: "#217a5b",
    Other: "#6b7280",
  };
  function colorFor(category, explicit) {
    if (explicit && /^#[0-9a-fA-F]{6}$/.test(explicit)) return explicit;
    return CATEGORY_COLORS[category] || CATEGORY_COLORS.Other;
  }
  // Guess a category from the document's own words, so an upload lands in a
  // sensible bucket instead of always "Other". The owner can change it after.
  const CATEGORY_HINTS = [
    ["Safety", /\bsafety|emergency|evacuat|fire drill|incident|injur|first aid|crisis|restraint|hazard/i],
    ["Clinical", /\bclinical|aba\b|bcba|rbt\b|treatment|behavior plan|session note|supervis|assessment|therapy protocol/i],
    ["Billing", /\bbilling|invoice|claim|authorization|insurance|copay|coding|cpt\b|reimburse/i],
    ["Compliance", /\bhipaa|compliance|confidential|privacy|mandated report|audit|regulat|consent/i],
    ["HR", /\bemployee|payroll|time off|pto\b|attendance|onboarding|dress code|conduct|hiring|benefits|disciplin/i],
    ["Operations", /\boperations|opening|closing|cleaning|supplies|scheduling|checklist|procedure for|daily/i],
  ];
  function guessCategory(text) {
    const t = String(text || "").slice(0, 4000);
    for (const [cat, re] of CATEGORY_HINTS) if (re.test(t)) return cat;
    return "Other";
  }

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS crm_leads (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      lead_type TEXT,
      stage TEXT DEFAULT 'New',
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      est_value NUMERIC,
      next_follow_up TEXT,
      notes TEXT,
      owner_name TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("crm_leads:", e.message));
    await dbRun(`CREATE TABLE IF NOT EXISTS crm_policies (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      body TEXT,
      slug TEXT UNIQUE,
      published BOOLEAN DEFAULT TRUE,
      updated_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("crm_policies:", e.message));
    // Colour-coded cards. Additive; existing rows fall back to their category colour.
    await dbRun(`ALTER TABLE crm_policies ADD COLUMN IF NOT EXISTS color TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE crm_policies ADD COLUMN IF NOT EXISTS source_file TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE crm_policies ADD COLUMN IF NOT EXISTS summary TEXT`).catch(() => {});
  }

  function role(u) { return (u && (u.role || u.role_key || "")) || ""; }

  // A per-user grant from the Access editor unlocks this module's ordinary
  // access tier even when the role list wouldn't. Manage/sensitive tiers stay
  // role-gated.
  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  function canLeads(u) { return ["owner", "super_admin", "admin", "intake", "scheduling"].includes(role(u)) || granted(u, "leads"); }
  function canPolicyManage(u) { return ["owner", "super_admin", "admin", "hr_admin"].includes(role(u)) || granted(u, "policies"); }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function slugify(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "policy"; }

  // ---- uploaded document readers -------------------------------------
  // .docx is a zip; the text lives in word/document.xml with one <w:p> per
  // paragraph. Tabs become spaces and paragraphs become newlines so the policy
  // body reads the way it did in Word.
  function docxToText(buffer) {
    let files;
    try { files = unzip(buffer); }
    catch (e) { throw new Error("That doesn't look like a Word .docx file."); }
    const xmlBuf = files["word/document.xml"];
    if (!xmlBuf) throw new Error("Couldn't find the text inside that Word file.");
    let xml = xmlBuf.toString("utf8");
    xml = xml
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "");
    return xml
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }

  // First non-trivial line makes a better title than the filename usually does.
  function firstHeading(text) {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const l of lines.slice(0, 8)) {
      if (l.length >= 4 && l.length <= 90 && !/^page\s*\d/i.test(l)) return l;
    }
    return "";
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/leads") && !pathname.startsWith("/api/policies")) return false;
    try {
      // ---- PUBLIC: published policies (for the QR viewer). No auth. ----
      if (pathname === "/api/policies/public" && method === "GET") {
        const rows = await dbAll("SELECT id, title, category, slug, color, summary, updated_at FROM crm_policies WHERE published = TRUE ORDER BY category, title");
        return json(res, 200, rows);
      }
      const pubOne = pathname.match(/^\/api\/policies\/public\/([a-z0-9-]+)$/);
      if (pubOne && method === "GET") {
        const p = await dbGet("SELECT id, title, category, body, slug, color, updated_at FROM crm_policies WHERE slug = ? AND published = TRUE", [pubOne[1]]);
        if (!p) return json(res, 404, { error: "Not found" });
        return json(res, 200, p);
      }

      if (!user) return json(res, 401, { error: "Not authenticated" });

      // ================= LEADS =================
      if (pathname.startsWith("/api/leads")) {
        if (!canLeads(user)) return json(res, 403, { error: "Not permitted" });
        if (pathname === "/api/leads" && method === "GET") {
          const rows = await dbAll("SELECT * FROM crm_leads ORDER BY (stage IN ('Won','Lost')), COALESCE(next_follow_up,'9999'), id DESC");
          return json(res, 200, { leads: rows, types: LEAD_TYPES, stages: LEAD_STAGES });
        }
        if (pathname === "/api/leads" && method === "POST") {
          const b = await readBody(req);
          if (!b.name) return json(res, 400, { error: "Name is required." });
          const row = await dbRun(
            `INSERT INTO crm_leads (name, lead_type, stage, contact_name, contact_email, contact_phone, est_value, next_follow_up, notes, owner_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            [b.name, b.lead_type || "Other", b.stage || "New", b.contact_name || null, b.contact_email || null, b.contact_phone || null, num(b.est_value), b.next_follow_up || null, b.notes || null, user.name || null, nowISO(), nowISO()]
          );
          return json(res, 201, { ok: true, id: row.rows[0].id });
        }
        const leadMatch = pathname.match(/^\/api\/leads\/(\d+)$/);
        if (leadMatch && method === "PATCH") {
          const b = await readBody(req);
          const allowed = ["name", "lead_type", "stage", "contact_name", "contact_email", "contact_phone", "est_value", "next_follow_up", "notes"];
          const fields = Object.keys(b).filter((k) => allowed.includes(k));
          if (!fields.length) return json(res, 400, { error: "Nothing to update." });
          const vals = fields.map((f) => (f === "est_value" ? num(b[f]) : b[f]));
          await dbRun(`UPDATE crm_leads SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...vals, nowISO(), Number(leadMatch[1])]);
          return json(res, 200, { ok: true });
        }
        if (leadMatch && method === "DELETE") { await dbRun("DELETE FROM crm_leads WHERE id = ?", [Number(leadMatch[1])]); return json(res, 200, { ok: true }); }
        return false;
      }

      // ================= POLICIES (authed management) =================
      if (pathname === "/api/policies" && method === "GET") {
        const rows = await dbAll("SELECT * FROM crm_policies ORDER BY category, title");
        return json(res, 200, { policies: rows, categories: POLICY_CATEGORIES, category_colors: CATEGORY_COLORS });
      }
      if (pathname === "/api/policies/upload" && method === "POST") {
        if (!canPolicyManage(user)) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!b.content_base64) return json(res, 400, { error: "No file provided." });
        const name = String(b.filename || "policy");
        let buf;
        try {
          let raw = String(b.content_base64);
          const ci = raw.indexOf(",");
          if (raw.startsWith("data:") && ci >= 0) raw = raw.slice(ci + 1);
          buf = Buffer.from(raw, "base64");
        } catch (e) { return json(res, 400, { error: "Could not read that file." }); }

        let text = "";
        try {
          if (/\.pdf$/i.test(name) || buf.slice(0, 5).toString("latin1") === "%PDF-") {
            text = extractPdfLines(buf).join("\n");
          } else if (/\.docx$/i.test(name)) {
            text = docxToText(buf);
          } else if (/\.(txt|md)$/i.test(name)) {
            text = buf.toString("utf8");
          } else {
            return json(res, 400, { error: "Upload a PDF, a Word .docx, or a plain text file. (Old .doc files need to be saved as .docx first.)" });
          }
        } catch (e) { return json(res, 400, { error: e.message || "Could not read that file." }); }

        text = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
        if (text.replace(/\s/g, "").length < 40) {
          return json(res, 400, { error: "That file didn't have readable text in it. If it's a scan or a photo, it needs to be a text document to become a policy card." });
        }

        const fileTitle = name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
        const title = String(b.title || firstHeading(text) || fileTitle || "Untitled policy").slice(0, 120);
        const category = POLICY_CATEGORIES.includes(b.category) ? b.category : guessCategory(title + "\n" + text);
        const summary = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 220);

        let slug = slugify(title);
        if (await dbGet("SELECT id FROM crm_policies WHERE slug = ?", [slug])) {
          slug = slug + "-" + crypto.randomBytes(3).toString("hex");
        }
        const row = await dbGet(
          `INSERT INTO crm_policies (title, category, body, slug, published, color, source_file, summary, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [title, category, text, slug, b.published === false ? false : true, colorFor(category, b.color), name,
           summary, (user && user.name) || null, nowISO(), nowISO()]
        );
        return json(res, 201, { ok: true, policy: row });
      }

      if (pathname === "/api/policies" && method === "POST") {
        if (!canPolicyManage(user)) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!b.title) return json(res, 400, { error: "Title is required." });
        let slug = slugify(b.title);
        // Ensure unique slug.
        const exists = await dbGet("SELECT id FROM crm_policies WHERE slug = ?", [slug]);
        if (exists) slug = slug + "-" + crypto.randomBytes(2).toString("hex");
        const row = await dbRun(
          `INSERT INTO crm_policies (title, category, body, slug, published, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [b.title, b.category || "Other", b.body || "", slug, b.published === false ? false : true, user.name || null, nowISO(), nowISO()]
        );
        return json(res, 201, { ok: true, id: row.rows[0].id, slug });
      }
      const polMatch = pathname.match(/^\/api\/policies\/(\d+)$/);
      if (polMatch && method === "PATCH") {
        if (!canPolicyManage(user)) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        const allowed = ["title", "category", "body", "published", "color", "summary"];
        const fields = Object.keys(b).filter((k) => allowed.includes(k));
        if (!fields.length) return json(res, 400, { error: "Nothing to update." });
        await dbRun(`UPDATE crm_policies SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_by = ?, updated_at = ? WHERE id = ?`, [...fields.map((f) => b[f]), user.name || null, nowISO(), Number(polMatch[1])]);
        return json(res, 200, { ok: true });
      }
      if (polMatch && method === "DELETE") {
        if (!canPolicyManage(user)) return json(res, 403, { error: "Not permitted" });
        await dbRun("DELETE FROM crm_policies WHERE id = ?", [Number(polMatch[1])]);
        return json(res, 200, { ok: true });
      }
      return false;
    } catch (e) {
      console.error("growth handleApi error:", e);
      return json(res, 500, { error: "Error: " + e.message });
    }
  }

  // Public, printable policies viewer (the QR code target).
  function servePage(req, res, pathname) {
    if (pathname === "/policies" || pathname.startsWith("/policies/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(policiesHtml());
      return true;
    }
    return false;
  }

  function policiesHtml() {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Policies & Procedures — Spectrum Squad</title>
<style>
  :root{--navy:#1b2a6b;--gold:#e0a430;--ink:#1e293b;--muted:#64748b;--line:#e2e8f0;--bg:#f5f6fb;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:var(--bg);color:var(--ink);}
  .wrap{max-width:820px;margin:0 auto;padding:20px 16px 60px;}
  .logo{display:block;max-width:180px;margin:8px auto 6px;}
  h1{color:var(--navy);text-align:center;font-size:24px;margin:6px 0 2px;}
  .sub{text-align:center;color:var(--muted);margin:0 0 18px;}
  .search{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:15px;margin-bottom:16px;}
  .cat{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:18px 0 6px;font-weight:700;}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;}
  .item{position:relative;background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 16px 13px 20px;cursor:pointer;overflow:hidden;transition:transform .12s ease,box-shadow .12s ease;}
  .item:hover{border-color:var(--pc,var(--navy));transform:translateY(-2px);box-shadow:0 8px 20px rgba(27,42,107,.14);}
  .item .stripe{position:absolute;left:0;top:0;bottom:0;width:6px;background:var(--pc,var(--navy));}
  .item h3{margin:6px 0 0;font-size:15px;color:var(--navy);line-height:1.3;}
  .item .when{font-size:12px;color:var(--muted);margin-top:4px;}
  .item .snip{font-size:12px;color:var(--muted);margin-top:6px;line-height:1.45;}
  .pill{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;background:var(--pc,var(--navy));color:#fff;opacity:.92;}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:7px;vertical-align:middle;}
  .back{background:none;border:0;color:var(--navy);font-weight:700;cursor:pointer;font-size:14px;padding:0;margin-bottom:10px;}
  .body{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px;white-space:pre-wrap;line-height:1.6;}
  .body h2{color:var(--navy);margin-top:0;}
</style></head>
<body>
<div class="wrap" id="app"><p style="text-align:center;color:#64748b;">Loading…</p></div>
<script>
(function(){
  var app=document.getElementById("app");
  function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
  function when(s){try{return "Updated "+new Date(s).toLocaleDateString();}catch(e){return "";}}
  var slug=(location.pathname.split("/policies/")[1]||"").replace(/\\/+$/,"");
  if(slug){ showOne(slug); } else { showList(); }
  function header(){return '<img class="logo" src="/logo.png" alt="Spectrum Squad"/><h1>Policies &amp; Procedures</h1><p class="sub">Spectrum Squad</p>';}
  function showList(){
    fetch("/api/policies/public").then(function(r){return r.json();}).then(function(rows){
      if(!rows.length){app.innerHTML=header()+'<p style="text-align:center;color:#64748b;">No policies published yet.</p>';return;}
      var byCat={};rows.forEach(function(p){(byCat[p.category||"Other"]=byCat[p.category||"Other"]||[]).push(p);});
      var html=header()+'<input class="search" id="q" placeholder="Search policies…"/>';
      html+='<div id="list">'+renderCats(byCat)+'</div>';
      app.innerHTML=html;
      document.getElementById("q").addEventListener("input",function(e){
        var t=e.target.value.toLowerCase();
        var filtered={};rows.filter(function(p){return p.title.toLowerCase().indexOf(t)>=0||(p.category||"").toLowerCase().indexOf(t)>=0;}).forEach(function(p){(filtered[p.category||"Other"]=filtered[p.category||"Other"]||[]).push(p);});
        document.getElementById("list").innerHTML=renderCats(filtered);
        wire();
      });
      wire();
    }).catch(function(){app.innerHTML=header()+'<p style="text-align:center;color:#b91c1c;">Could not load policies.</p>';});
  }
  var CATCOLORS=${JSON.stringify(CATEGORY_COLORS)};
  function colorOf(p){
    if(p.color&&/^#[0-9a-fA-F]{6}$/.test(p.color))return p.color;
    return CATCOLORS[p.category]||"#6b7280";
  }
  function renderCats(byCat){
    return Object.keys(byCat).sort().map(function(cat){
      var cc=CATCOLORS[cat]||"#6b7280";
      return '<div class="cat"><span class="dot" style="background:'+cc+'"></span>'+esc(cat)+'</div><div class="grid">'+byCat[cat].map(function(p){
        var c=colorOf(p);
        return '<div class="item" data-slug="'+esc(p.slug)+'" style="--pc:'+c+'"><span class="stripe"></span><span class="pill">'+esc(p.category||"Other")+'</span><h3>'+esc(p.title)+'</h3>'+(p.summary?'<div class="snip">'+esc(String(p.summary).slice(0,120))+'</div>':'')+'<div class="when">'+esc(when(p.updated_at))+'</div></div>';
      }).join("")+'</div>';
    }).join("")||'<p style="color:#64748b;">No matches.</p>';
  }
  function wire(){Array.prototype.forEach.call(document.querySelectorAll("[data-slug]"),function(el){el.addEventListener("click",function(){history.pushState({},"","/policies/"+el.getAttribute("data-slug"));showOne(el.getAttribute("data-slug"));});});}
  function showOne(s){
    fetch("/api/policies/public/"+encodeURIComponent(s)).then(function(r){return r.ok?r.json():Promise.reject();}).then(function(p){
      app.innerHTML=header()+'<button class="back" id="back">← All policies</button><div class="body" style="border-top:6px solid '+colorOf(p)+'"><h2><span class="dot" style="background:'+colorOf(p)+'"></span>'+esc(p.title)+'</h2><div style="color:#64748b;font-size:12px;margin-bottom:12px;">'+esc(p.category||"")+' · '+esc(when(p.updated_at))+'</div>'+esc(p.body)+'</div>';
      document.getElementById("back").addEventListener("click",function(){history.pushState({},"","/policies");showList();});
    }).catch(function(){app.innerHTML=header()+'<button class="back" id="back">← All policies</button><p style="text-align:center;color:#b91c1c;">Policy not found.</p>';var b=document.getElementById("back");if(b)b.addEventListener("click",function(){history.pushState({},"","/policies");showList();});});
  }
  window.addEventListener("popstate",function(){var s=(location.pathname.split("/policies/")[1]||"").replace(/\\/+$/,"");if(s)showOne(s);else showList();});
})();
</script>
</body></html>`;
  }

  return { initTables, handleApi, servePage };
};
