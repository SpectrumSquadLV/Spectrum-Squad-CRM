// theme.js -- Spectrum Squad CRM: cream palette + real logo + gold brand
// Progressive-enhancement module, loaded via a single <script> tag added to
// index.html (same pattern as financial-center.js / email-templates.js).
// Does not touch index.html's own <style> block or markup -- instead it
// overrides CSS custom properties at runtime, injects a small override
// stylesheet for the handful of rules that reference --brand-navy directly
// instead of --brand, and swaps the sidebar's emoji placeholder for the
// real logo image (logo.png, uploaded alongside this file to the repo root).
"use strict";

// ---- warm cream palette (keeps the existing navy/gold/teal brand accents,
// which already match the logo, and only warms up the backgrounds/borders
// that were previously a cool gray) ----
function applyCreamTheme() {
  const root = document.documentElement.style;
  root.setProperty("--bg", "#faf5ea");
  root.setProperty("--surface", "#fffdf7");
  root.setProperty("--border", "#ecdfc7");
  root.setProperty("--brand-navy-light", "#efeaf9");
}

// ---- switch the primary brand color from navy to the logo's gold, and
// swap the script header font + hardcoded navy body text for a clean
// modern sans-serif. index.html hardcodes several rules (sidebar gradient,
// login-screen gradient, nav-item colors, body font-family) instead of
// referencing var(--brand)/var(--font-header), so a CSS-variable override
// alone won't reach them -- this injects a small override stylesheet for
// just those rules. ----
function applyGoldBrand() {
  const root = document.documentElement.style;
  root.setProperty("--brand", "#e0a430");
  root.setProperty("--brand-dark", "#c98a1b");
  root.setProperty("--brand-light", "#fdf1da");
  root.setProperty("--text", "#1f2430");
  root.setProperty("--font-header", '"Styrene A", "Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif');

  if (document.getElementById("ssq-gold-overrides")) return;
  const style = document.createElement("style");
  style.id = "ssq-gold-overrides";
  style.textContent = `
    body {
      font-family: "Styrene A", "Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif !important;
    }
    .sidebar {
      background: linear-gradient(180deg, var(--brand-gold) 0%, var(--brand-gold-dark) 100%) !important;
      color: #3d2c05 !important;
    }
    .login-wrap {
      background: linear-gradient(135deg, var(--brand-gold) 0%, var(--brand-gold-dark) 60%, var(--brand-teal) 100%) !important;
    }
    .brand { color: #2a1d02 !important; }
    .brand-mark { background: rgba(255,255,255,0.28) !important; }
    .nav-item { color: #6b4a12 !important; }
    .nav-item:hover { background: rgba(0,0,0,0.08) !important; color: #2a1d02 !important; }
    .nav-item.active { background: rgba(0,0,0,0.18) !important; color: #2a1d02 !important; font-weight: 700 !important; }
    .sidebar-footer { border-top: 1px solid rgba(0,0,0,0.15) !important; color: #7a5a1e !important; }
    .btn { color: #2a1d02 !important; }
    .btn.secondary { color: var(--text) !important; }
    .btn.danger { color: #fff !important; }
  `;
  document.head.appendChild(style);
}

// ---- swap the emoji placeholder for the real uploaded logo ----
function applyLogo() {
  const brand = document.querySelector(".sidebar .brand");
  if (!brand) return false;
  if (brand.dataset.themed === "1") return true; // already done

  const mark = brand.querySelector(".brand-mark");
  const word = brand.querySelector(".brand-word");
  if (!mark) return false;

  const img = document.createElement("img");
  img.src = "logo.png";
  img.alt = "Spectrum Squad";
  img.style.height = "38px";
  img.style.width = "auto";
  img.style.display = "block";
  img.onerror = () => {
    // If the logo file hasn't been uploaded yet, silently keep the original
    // emoji + text branding instead of showing a broken image icon.
    img.remove();
    mark.style.display = "";
    if (word) word.style.display = "";
    brand.dataset.themed = "";
  };

  mark.replaceWith(img);
  if (word) word.style.display = "none"; // logo image already includes the wordmark
  brand.dataset.themed = "1";
  return true;
}

function syncTheme() {
  applyCreamTheme();
  applyGoldBrand();
  applyLogo();
}

function initTheme() {
  syncTheme();
  const app = document.getElementById("app");
  if (app) {
    const observer = new MutationObserver(() => syncTheme());
    observer.observe(app, { childList: true, subtree: true });
  }
  [150, 500, 1200, 2500, 4000].forEach((ms) => setTimeout(syncTheme, ms));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTheme);
} else {
  initTheme();
}
