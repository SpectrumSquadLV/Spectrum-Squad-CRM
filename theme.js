// theme.js -- Spectrum Squad CRM: cream palette + real logo + watermark
// Progressive-enhancement module, loaded via a single <script> tag added to
// index.html (same pattern as financial-center.js / email-templates.js).
// Does not touch index.html's own <style> block or markup -- instead it
// overrides CSS custom properties at runtime, swaps the sidebar's emoji
// placeholder for the real logo image (logo.png, uploaded alongside this
// file to the repo root), and adds a faint logo watermark behind the main
// content area.
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

// ---- faint centered logo watermark behind the main content area ----
function applyWatermark() {
  if (document.getElementById("ssq-watermark")) return;
  const style = document.createElement("style");
  style.id = "ssq-watermark";
  style.textContent = `
    #view-mount { position: relative; }
    #view-mount::before {
      content: "";
      position: fixed;
      top: 0;
      left: 240px;
      right: 0;
      bottom: 0;
      background-image: url('logo.png');
      background-repeat: no-repeat;
      background-position: center;
      background-size: 420px;
      opacity: 0.05;
      pointer-events: none;
      z-index: 0;
    }
  `;
  document.head.appendChild(style);
}

function syncTheme() {
  applyCreamTheme();
  applyLogo();
  applyWatermark();
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
