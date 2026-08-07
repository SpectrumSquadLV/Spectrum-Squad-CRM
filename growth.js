// growth.js -- Two additive sections:
//   1. Lead Management (School / Private / Other contracts + general leads)
//   2. Policies, SOPs & Procedures (with a public, QR-linkable viewer)
//
// Additive per RULE ZERO: new tables crm_leads / crm_policies, routes under
// /api/leads/* and /api/policies/*, and a PUBLIC page at /policies for the
// printable QR code. Reuses nothing existing.

module.exports = function initGrowth(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, crypto, readBody, json } = ctx;

  const LEAD_TYPES = ["School", "Private Pay", "Insurance", "Community Partner", "Other"];
  const LEAD_STAGES = ["New", "Contacted", "Meeting Set", "Proposal Sent", "Won", "Lost"];
  const POLICY_CATEGORIES = ["HR", "Clinical", "Safety", "Billing", "Operations", "Compliance", "Other"];

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
  }

  function role(u) { return (u && (u.role || u.role_key || "")) || ""; }
  function canLeads(u) { return ["owner", "super_admin", "admin", "intake", "scheduling"].includes(role(u)); }
  function canPolicyManage(u) { return ["owner", "super_admin", "admin", "hr_admin"].includes(role(u)); }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function slugify(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "policy"; }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/leads") && !pathname.startsWith("/api/policies")) return false;
    try {
      // ---- PUBLIC: published policies (for the QR viewer). No auth. ----
      if (pathname === "/api/policies/public" && method === "GET") {
        const rows = await dbAll("SELECT id, title, category, slug, updated_at FROM crm_policies WHERE published = TRUE ORDER BY category, title");
        return json(res, 200, rows);
      }
      const pubOne = pathname.match(/^\/api\/policies\/public\/([a-z0-9-]+)$/);
      if (pubOne && method === "GET") {
        const p = await dbGet("SELECT id, title, category, body, slug, updated_at FROM crm_policies WHERE slug = ? AND published = TRUE", [pubOne[1]]);
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
        return json(res, 200, { policies: rows, categories: POLICY_CATEGORIES });
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
        const allowed = ["title", "category", "body", "published"];
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
  .item{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:8px;cursor:pointer;}
  .item:hover{border-color:var(--navy);}
  .item h3{margin:0;font-size:15px;color:var(--navy);}
  .item .when{font-size:12px;color:var(--muted);margin-top:2px;}
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
  function renderCats(byCat){
    return Object.keys(byCat).sort().map(function(cat){
      return '<div class="cat">'+esc(cat)+'</div>'+byCat[cat].map(function(p){
        return '<div class="item" data-slug="'+esc(p.slug)+'"><h3>'+esc(p.title)+'</h3><div class="when">'+esc(when(p.updated_at))+'</div></div>';
      }).join("");
    }).join("")||'<p style="color:#64748b;">No matches.</p>';
  }
  function wire(){Array.prototype.forEach.call(document.querySelectorAll("[data-slug]"),function(el){el.addEventListener("click",function(){history.pushState({},"","/policies/"+el.getAttribute("data-slug"));showOne(el.getAttribute("data-slug"));});});}
  function showOne(s){
    fetch("/api/policies/public/"+encodeURIComponent(s)).then(function(r){return r.ok?r.json():Promise.reject();}).then(function(p){
      app.innerHTML=header()+'<button class="back" id="back">← All policies</button><div class="body"><h2>'+esc(p.title)+'</h2><div style="color:#64748b;font-size:12px;margin-bottom:12px;">'+esc(p.category||"")+' · '+esc(when(p.updated_at))+'</div>'+esc(p.body)+'</div>';
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
