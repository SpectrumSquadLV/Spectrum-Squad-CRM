// Renders one course's slides to PNG frames for its training video.
//
//   node scripts/compliance-video/render-slides.js compliance-content/hipaa.json out/hipaa
//
// Called by build.py. Uses the Playwright that ships with the environment; the
// slides are plain HTML so their look can be changed here without touching
// the video pipeline.
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const [, , contentPath, outDir] = process.argv;
if (!contentPath || !outDir) { console.error("usage: render-slides.js <content.json> <outDir>"); process.exit(2); }
const c = JSON.parse(fs.readFileSync(contentPath, "utf8"));
fs.mkdirSync(outDir, { recursive: true });
const logo = "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "..", "..", "logo.png")).toString("base64");
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{width:1280px;height:720px;font-family:"Segoe UI",Arial,Helvetica,sans-serif;background:#f5f4fb;color:#1b2a6b;overflow:hidden}
.s{position:relative;width:1280px;height:720px;display:flex}
.band{width:22px;background:linear-gradient(#7c6cf0,#1b2a6b)}
.main{flex:1;padding:58px 80px 0 70px}
.kick{font-size:19px;letter-spacing:.14em;text-transform:uppercase;color:#7c6cf0;font-weight:700}
h1{font-size:50px;line-height:1.12;margin:14px 0 34px;font-weight:800}
ul{list-style:none}
li{font-size:30px;line-height:1.35;margin:0 0 22px;padding-left:44px;position:relative;color:#26306a}
li::before{content:"";position:absolute;left:4px;top:13px;width:16px;height:16px;border-radius:50%;background:#7c6cf0}
.foot{position:absolute;left:92px;right:60px;bottom:26px;display:flex;justify-content:space-between;align-items:center;font-size:17px;color:#6b6a86}
.foot img{height:40px}
.title{flex-direction:column;justify-content:center;align-items:flex-start;padding:0 110px;background:linear-gradient(135deg,#1b2a6b 0%,#3b2f8f 60%,#7c6cf0 100%);color:#fff}
.title img{height:84px;background:#fff;border-radius:14px;padding:10px 14px;margin-bottom:40px}
.title .kick{color:#cfc9ec}
.title h1{font-size:64px;margin:16px 0 26px;color:#fff}
.title p{font-size:28px;color:#e6e3f7;max-width:980px;line-height:1.4}
`;

function slideHtml(s, i, n) {
  if (i === 0) {
    return `<div class="s title"><img src="${logo}"><div class="kick">Spectrum Squad compliance training</div>
      <h1>${esc(c.title)}</h1><p>${(s.bullets || []).map(esc).join(" &nbsp;·&nbsp; ")}</p></div>`;
  }
  return `<div class="s"><div class="band"></div><div class="main">
    <div class="kick">${esc(c.title)}</div><h1>${esc(s.heading)}</h1>
    <ul>${(s.bullets || []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>
    <div class="foot"><span>${i + 1} / ${n}</span><img src="${logo}"></div></div>`;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  for (let i = 0; i < c.slides.length; i++) {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${slideHtml(c.slides[i], i, c.slides.length)}</body></html>`);
    await page.screenshot({ path: path.join(outDir, `slide-${String(i).padStart(2, "0")}.png`) });
  }
  await browser.close();
  console.log(`rendered ${c.slides.length} slides`);
})().catch((e) => { console.error(e); process.exit(1); });
