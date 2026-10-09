// Reading the text out of a PDF, whatever it is wrapped in.
//
// A PDF stream may be encoded by a CHAIN of filters, not one:
//
//   /Filter [ /ASCII85Decode /FlateDecode ]
//
// means ASCII85 first, then inflate. The extractor matched /FlateDecode
// anywhere in the dictionary and inflated the RAW bytes, which throws on the
// first byte of ASCII85 text. The stream was dropped, every page with it, and
// the file was then reported as having no readable pages -- a true statement
// about what the code managed and a false one about the PDF.
//
// It surfaced on the SOP library: a perfectly ordinary text PDF was refused
// with a message telling the reader to download a CSV from their bank.
//
// The fixtures are built byte by byte rather than with a PDF library, so each
// one exercises exactly ONE encoding path and a failure names the encoding
// rather than the generator.
//
//   node test-pdf-filters.js
"use strict";
const zlib = require("zlib");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + String(detail).slice(0, 260) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

const LINES = [
  "Standard Operating Procedure: Session Opening",
  "Purpose: to make sure every session starts the same way.",
  "1. Arrive five minutes before the session start time.",
  "Responsibility: the assigned RBT, supervised by the BCBA.",
];

function contentStream() {
  const out = ["BT", "/F1 11 Tf", "72 720 Td", "14 TL"];
  for (const l of LINES) out.push("(" + l.replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ") Tj T*");
  out.push("ET");
  return Buffer.from(out.join("\n"), "latin1");
}

function ascii85(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.slice(i, i + 4);
    const n = chunk.length, pad = 4 - n;
    const padded = Buffer.concat([chunk, Buffer.alloc(pad)]);
    let v = padded.readUInt32BE(0);
    if (v === 0 && n === 4) { out.push(0x7a); continue; }
    const enc = [];
    for (let k = 0; k < 5; k++) { enc.unshift(33 + (v % 85)); v = Math.floor(v / 85); }
    out.push(...enc.slice(0, 5 - pad));
  }
  return Buffer.concat([Buffer.from(out), Buffer.from("~>", "latin1")]);
}

// A minimal but structurally real PDF: catalog, pages, one page, the content
// stream under test, and a font.
function buildPdf(streamBytes, filterEntry) {
  const objs = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", "latin1"),
    Buffer.concat([
      Buffer.from(`<< ${filterEntry} /Length ${streamBytes.length} >>\nstream\n`, "latin1"),
      streamBytes,
      Buffer.from("\nendstream", "latin1"),
    ]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "latin1"),
  ];
  let buf = Buffer.from("%PDF-1.4\n", "latin1");
  const offs = [];
  objs.forEach((body, n) => {
    offs.push(buf.length);
    buf = Buffer.concat([buf, Buffer.from(`${n + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
  });
  const xref = buf.length;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) tail += String(o).padStart(10, "0") + " 00000 n \n";
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([buf, Buffer.from(tail, "latin1")]);
}

// The extractor is reached through the module that owns it.
const fa = require("./financial-advisor")({
  dbGet: async () => null, dbAll: async () => [], dbRun: async () => {},
  nowISO: () => new Date().toISOString(), json: () => {}, readBody: async () => ({}),
});
const extract = fa.extractPdfLines || (fa._internal && fa._internal.extractPdfLines);

(async () => {
  section("The extractor is reachable");
  check("extractPdfLines is exported", typeof extract === "function", typeof extract);
  if (typeof extract !== "function") {
    console.log(`\n${pass} passed, ${fail + 1} failed`);
    process.exit(1);
  }

  const raw = contentStream();
  const textOf = (pdf) => extract(pdf).join("\n");

  section("Every encoding a generator actually emits");
  const CASES = [
    ["no filter at all", buildPdf(raw, "")],
    ["/FlateDecode on its own — what Word and most printers emit", buildPdf(zlib.deflateSync(raw), "/Filter /FlateDecode")],
    // THE ONE THAT WAS BROKEN. reportlab emits this by default, and plenty of
    // other generators do too.
    ["A CHAIN: [ /ASCII85Decode /FlateDecode ]", buildPdf(ascii85(zlib.deflateSync(raw)), "/Filter [ /ASCII85Decode /FlateDecode ]")],
    ["/ASCIIHexDecode", buildPdf(Buffer.from(raw.toString("hex") + ">", "latin1"), "/Filter /ASCIIHexDecode")],
  ];
  for (const [label, pdf] of CASES) {
    let text = "";
    let threw = null;
    try { text = textOf(pdf); } catch (e) { threw = e.message; }
    check(label + " — reads without throwing", threw === null, threw);
    check(label + " — and the words come out", /Standard Operating Procedure/.test(text), text.slice(0, 120));
    check(label + " — every line of it, not just the first",
      LINES.every((l) => text.includes(l.slice(0, 30))), text.slice(0, 200));
  }

  section("The chain is applied IN ORDER");
  // Decoding in the wrong order, or applying only the last filter, produces
  // nothing readable. This is the assertion that fails if somebody
  // "simplifies" decodeStream back to a single filter match.
  const chained = textOf(buildPdf(ascii85(zlib.deflateSync(raw)), "/Filter [ /ASCII85Decode /FlateDecode ]"));
  const flateOnly = textOf(buildPdf(zlib.deflateSync(raw), "/Filter /FlateDecode"));
  check("a chained PDF yields the same text as an unchained one",
    chained.trim() === flateOnly.trim(), { chained: chained.slice(0, 80), flateOnly: flateOnly.slice(0, 80) });

  section("What it cannot read, it says so about");
  // The old message named a bank in a policy library. Each refusal now names
  // the actual cause, because the reader can only act on one of them.
  let lzwErr = "";
  try { textOf(buildPdf(Buffer.from([0x80, 0x0b, 0x60, 0x50]), "/Filter /LZWDecode")); }
  catch (e) { lzwErr = e.message; }
  check("an encoding it does not implement is named", /LZWDecode/.test(lzwErr), lzwErr);
  check("and it says what to do about it", /re-save|print it to PDF/i.test(lzwErr), lzwErr);

  let scanErr = "";
  try {
    textOf(buildPdf(Buffer.from("\xff\xd8\xff\xe0 not really a jpeg", "latin1"),
                    "/Filter /DCTDecode /Subtype /Image"));
  } catch (e) { scanErr = e.message; }
  check("a page that is only an image is called a scan, not a broken file",
    /image|scan/i.test(scanErr), scanErr);

  check("NO REFUSAL MENTIONS A BANK — this extractor serves the policy library too",
    !/bank|statement|CSV/i.test(lzwErr) && !/bank|statement|CSV/i.test(scanErr),
    [lzwErr, scanErr].join(" | "));

  section("A file that is not a PDF");
  let notPdf = "";
  try { extract(Buffer.from("PK\x03\x04 this is a zip", "latin1")); } catch (e) { notPdf = e.message; }
  check("is refused on its header", /isn't a PDF/i.test(notPdf), notPdf);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
