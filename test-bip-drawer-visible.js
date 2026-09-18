// The BIP drawers are actually readable.
//
// A drawer has to escape the panel's stacking context to cover the page, so it
// is appended to document.body -- outside .bip-wrap, which is where this
// module's CSS custom properties were defined. Every var() inside a drawer
// therefore resolved to nothing, and a declaration using an invalid var is
// DROPPED rather than defaulted. That is silent by design in CSS.
//
// The visible result: .bip-btn.primary lost its background but kept color:#fff,
// so "Save note" rendered as white text on a white drawer. Present in the DOM,
// focusable, clickable, and invisible to a person -- which is why the practice
// reported that adding a note had no save button.
//
// A count or an isVisible() check would have passed throughout. These assert
// what a person can actually SEE: that the button has a real background, and
// that it contrasts with the surface behind it.
const { chromium } = require("playwright");
const { Pool } = require("pg");

(async () => {
  const BASE = process.env.BASE || "http://localhost:3011";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  let pass = 0, fail = 0;
  const check = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + String(d).slice(0, 300) : "")); } };
  const one = async (s, p = []) => (await pool.query(s, p)).rows[0];

  const c = await one("INSERT INTO clients (child_name, stage) VALUES ('Drawer Vis','active') RETURNING id");
  await one("INSERT INTO client_bips (client_id, status, created_at, updated_at) VALUES ($1,'draft',now(),now()) RETURNING id", [c.id]);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1000, height: 625 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);
  await page.goto(BASE + "/#/client-behavior/" + c.id, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // rgb/rgba -> luminance, and whether it is see-through at all
  const readColor = (css) => {
    const m = String(css).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  console.log("\n== the note drawer's save button can be seen ==");
  const addNote = page.locator('[data-bip="add-note"]').first();
  check("the Add Note button is on the page", (await page.locator('[data-bip="add-note"]').count()) > 0);
  await addNote.click();
  await page.waitForTimeout(600);

  const save = page.locator("#nt-save");
  check("the save button exists", (await save.count()) === 1);
  check("and is on screen", await save.first().isVisible());

  const seen = await save.first().evaluate((el) => {
    const s = getComputedStyle(el);
    const drawer = getComputedStyle(el.closest(".bip-drawer"));
    return { bg: s.backgroundColor, fg: s.color, navy: s.getPropertyValue("--bip-navy").trim(), drawerBg: drawer.backgroundColor };
  });
  const bg = readColor(seen.bg), fg = readColor(seen.fg);
  check("the drawer can see this module's colour variables",
    seen.navy !== "", JSON.stringify(seen));
  check("the save button has a real background, not a dropped declaration",
    !!bg && bg.a > 0, JSON.stringify(seen));
  // The actual defect: white on white. Anything under ~40 points of luminance
  // difference is unreadable regardless of which way round it is.
  //
  // A transparent background is NOT black -- it is whatever is behind it. An
  // earlier version of this check read rgba(0,0,0,0) as black and so scored the
  // broken button as maximum contrast, passing against the very bug it was
  // written for. What a person sees is the drawer showing through, so that is
  // what gets compared.
  const effectiveBg = bg && bg.a > 0 ? bg : readColor(seen.drawerBg);
  const contrast = effectiveBg && fg ? Math.abs(lum(effectiveBg) - lum(fg)) : 0;
  check("its text contrasts with its own background (this is the white-on-white bug)",
    contrast > 40, `contrast=${contrast.toFixed(1)} ${JSON.stringify(seen)}`);

  console.log("\n== the rest of the drawer chrome came through too ==");
  const chrome = await page.locator(".bip-drawer").first().evaluate((el) => {
    const lbl = el.querySelector("label.fl");
    const pre = el.querySelector(".bip-prefill");
    return {
      labelColor: lbl ? getComputedStyle(lbl).color : null,
      prefillBg: pre ? getComputedStyle(pre).backgroundColor : null,
      footerBorder: getComputedStyle(el.querySelector("footer")).borderTopColor,
      footerBorderWidth: getComputedStyle(el.querySelector("footer")).borderTopWidth,
    };
  });
  check("the prefill box has its background", (() => { const p = readColor(chrome.prefillBg); return !!p && p.a > 0; })(), JSON.stringify(chrome));
  check("the footer keeps its divider", chrome.footerBorderWidth !== "0px", JSON.stringify(chrome));

  console.log("\n== and the same is true of the other drawers ==");
  for (const [label, sel, btn] of [
    ["Add Target Behavior", '[data-bip="add-behavior"]', ".bip-drawer footer .bip-btn.primary"],
  ]) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.locator(".bip-scrim").first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    if (!(await page.locator(sel).count())) { check(`${label} button is present`, false, "not found"); continue; }
    await page.locator(sel).first().click();
    await page.waitForTimeout(500);
    const b = page.locator(btn).first();
    if (!(await b.count())) { check(`${label}: primary button present`, false, "none"); continue; }
    const got = await b.evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color,
      behind: getComputedStyle(el.closest(".bip-drawer")).backgroundColor,
    }));
    const raw = readColor(got.bg);
    const bbg = raw && raw.a > 0 ? raw : readColor(got.behind);
    const bfg = readColor(got.fg);
    const cc = bbg && bfg ? Math.abs(lum(bbg) - lum(bfg)) : 0;
    check(`${label}: its primary button is readable`, cc > 40, `contrast=${cc.toFixed(1)} ${JSON.stringify(got)}`);
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
  await page.screenshot({ path: "/tmp/note-drawer-fixed.png" }).catch(() => {});
  await browser.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
