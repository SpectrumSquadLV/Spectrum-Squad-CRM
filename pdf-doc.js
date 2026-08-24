// pdf-doc.js -- a small multi-page text PDF writer.
//
// Written because the clinical screener has to leave the CRM as a document a
// BCBA can read, print and file, and a screener runs to several pages.
//
// hr-attendance.js has its own single-page builder. It is deliberately left
// alone: it embeds a signature image into a legally meaningful acknowledgment,
// which is a different job, and refactoring working evidence-generating code to
// share plumbing with a report writer is a poor trade.
//
// Only what is needed: US Letter, Helvetica, headings, key/value rows,
// wrapping, and page breaks with a footer. No images, no tables, no unicode
// beyond WinAnsi -- see asciiSafe().
"use strict";

const PAGE_W = 612;   // US Letter, points
const PAGE_H = 792;
const MARGIN = 54;
const LINE = 14;

function pdfEscape(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// The base-14 fonts are WinAnsi. Text from a parent's own typing routinely
// carries curly quotes, en-dashes and emoji, and passing those through
// produces mojibake in a clinical record. They are folded to their closest
// plain equivalent instead, and anything left unmappable is dropped rather
// than rendered as a wrong character.
function asciiSafe(s) {
  return String(s == null ? "" : s)
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E]/g, "");
}

// Helvetica is proportional, so character counts only approximate the width.
// The factor is deliberately conservative: a line that wraps a word early
// looks fine, one that overruns the margin looks broken.
function wrapText(str, widthPts, size) {
  const perChar = size * 0.5;
  const max = Math.max(8, Math.floor(widthPts / perChar));
  const words = asciiSafe(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > max) { lines.push(cur); cur = w; }
    else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// blocks: [{ type: "title"|"heading"|"row"|"text"|"space"|"rule", ... }]
function buildPdf({ title = "", subtitle = "", footer = "", blocks = [] } = {}) {
  const pages = [];
  let content = [];
  let y = PAGE_H - MARGIN;
  const usable = PAGE_W - MARGIN * 2;

  const newPage = () => {
    if (content.length) pages.push(content.join("\n"));
    content = [];
    y = PAGE_H - MARGIN;
  };
  const need = (h) => { if (y - h < MARGIN + 24) newPage(); };
  const draw = (text, x, size, font) => {
    content.push(`BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscape(asciiSafe(text))}) Tj ET`);
  };

  if (title) {
    need(30); draw(title, MARGIN, 17, "FB"); y -= 22;
  }
  if (subtitle) {
    need(18); draw(subtitle, MARGIN, 10, "F"); y -= 18;
  }
  if (title || subtitle) {
    need(10);
    content.push(`0.80 0.80 0.85 RG 1 w ${MARGIN} ${y} m ${PAGE_W - MARGIN} ${y} l S`);
    y -= 18;
  }

  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "space") { need(b.size || 10); y -= (b.size || 10); continue; }

    if (b.type === "rule") {
      need(12);
      content.push(`0.85 0.85 0.90 RG 1 w ${MARGIN} ${y} m ${PAGE_W - MARGIN} ${y} l S`);
      y -= 12;
      continue;
    }

    if (b.type === "heading") {
      need(30);
      y -= 6;
      draw(b.text, MARGIN, 12, "FB");
      y -= 16;
      continue;
    }

    if (b.type === "text") {
      for (const line of wrapText(b.text, usable, 10)) {
        need(LINE); draw(line, MARGIN, 10, "F"); y -= LINE;
      }
      continue;
    }

    if (b.type === "row") {
      // The question, then the answer indented under it. Two columns would be
      // tidier until a question runs long, and screener questions do.
      const qLines = wrapText(b.label, usable, 10);
      const aLines = wrapText(b.value == null || b.value === "" ? "-" : b.value, usable - 14, 10);
      // Keep a question with at least its first answer line rather than
      // stranding a heading at the foot of a page.
      need(LINE * (qLines.length + 1));
      for (const line of qLines) { need(LINE); draw(line, MARGIN, 10, "FB"); y -= LINE; }
      for (const line of aLines) { need(LINE); draw(line, MARGIN + 14, 10, "F"); y -= LINE; }
      y -= 5;
      continue;
    }
  }

  if (content.length) pages.push(content.join("\n"));
  if (!pages.length) pages.push("");

  // ---- assemble ----
  const enc = (s) => Buffer.from(s, "latin1");
  const chunks = [];
  const xref = [];
  let offset = 0;
  const push = (buf) => { chunks.push(buf); offset += buf.length; };
  const obj = (n, body) => {
    xref[n] = offset;
    push(enc(`${n} 0 obj\n`));
    push(body);
    push(enc("\nendobj\n"));
  };

  const pageCount = pages.length;
  // 1 catalog, 2 pages, 3..(2+n) page objects, then content streams, then fonts
  const firstPage = 3;
  const firstContent = firstPage + pageCount;
  const fontR = firstContent + pageCount;
  const fontB = fontR + 1;

  push(enc("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"));
  obj(1, enc("<< /Type /Catalog /Pages 2 0 R >>"));
  const kids = pages.map((_, i) => `${firstPage + i} 0 R`).join(" ");
  obj(2, enc(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`));

  pages.forEach((_, i) => {
    obj(firstPage + i, enc(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + `/Resources << /Font << /F ${fontR} 0 R /FB ${fontB} 0 R >> >> `
      + `/Contents ${firstContent + i} 0 R >>`));
  });

  pages.forEach((body, i) => {
    let full = body;
    if (footer || pageCount > 1) {
      const foot = `${footer}${footer && pageCount > 1 ? "   ·   " : ""}${pageCount > 1 ? `Page ${i + 1} of ${pageCount}` : ""}`;
      full += `\nBT /F 8 Tf 1 0 0 1 ${MARGIN} ${MARGIN - 18} Tm 0.45 0.45 0.5 rg (${pdfEscape(asciiSafe(foot))}) Tj ET`;
    }
    const buf = enc(full);
    xref[firstContent + i] = offset;
    push(enc(`${firstContent + i} 0 obj\n<< /Length ${buf.length} >>\nstream\n`));
    push(buf);
    push(enc("\nendstream\nendobj\n"));
  });

  obj(fontR, enc("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
  obj(fontB, enc("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));

  const xrefStart = offset;
  const total = fontB + 1;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    table += String(xref[i] || 0).padStart(10, "0") + " 00000 n \n";
  }
  table += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(enc(table));

  return Buffer.concat(chunks);
}

module.exports = { buildPdf, wrapText, asciiSafe, pdfEscape };
