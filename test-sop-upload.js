// Getting an SOP into the library.
//
// Two guards stood between a real document and the library, and both refused
// files they were never meant to refuse:
//
//   1. looksLikeProse demanded 25 occurrences of words like "the" and "and".
//      That is a test of LENGTH wearing the costume of a test of readability.
//      A one-page SOP has about eleven in sixty words, so every short
//      procedure -- the commonest thing anybody uploads -- was thrown away.
//
//   2. It ran on .docx and .txt as well as PDFs. Those store real characters;
//      there is no font mapping to go wrong, so the check can only ever
//      produce a FALSE refusal on them. A Word file came back told to "save
//      it as .docx", which it already was.
//
// The guard itself is worth keeping: a PDF whose fonts use a custom encoding
// extracts as symbols, and sixty policies of gibberish that look real until
// somebody opens one is worse than sixty missing policies. So the suite
// asserts both directions -- short real documents go in, glyph soup does not.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-sop-upload.js
"use strict";
const zlib = require("zlib");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}

// ---- fixtures, built here so each one is exactly what it claims to be ----

// A .docx is a zip of XML. Hand-built with stored (uncompressed) entries so
// the fixture has no dependency on a document library.
function makeDocx(paragraphs) {
  const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
    + paragraphs.map((p) => `<w:p><w:r><w:t>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`).join("")
    + "</w:body></w:document>";
  const entries = [
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ["word/document.xml", xml],
  ];
  const chunks = [], central = [];
  let offset = 0;
  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    chunks.push(local, nameBuf, data);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

function makePdf(lines) {
  const content = Buffer.from(
    ["BT", "/F1 11 Tf", "72 720 Td", "14 TL",
     ...lines.map((l) => "(" + l.replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ") Tj T*"),
     "ET"].join("\n"), "latin1");
  const stream = zlib.deflateSync(content);
  const objs = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", "latin1"),
    Buffer.concat([Buffer.from(`<< /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`, "latin1"), stream, Buffer.from("\nendstream", "latin1")]),
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

// A SHORT one-page procedure. This is the shape that was being refused.
const SOP = [
  "Session Opening SOP",
  "Purpose: to make sure every session starts the same way, whoever runs it.",
  "Arrive five minutes early and check the schedule.",
  "Greet the client and caregiver by name.",
  "Lay out materials for the programs due today.",
  "Record the start time when the session actually begins.",
  "Responsibility: the assigned RBT, supervised by the BCBA.",
];

// What the guard is FOR: a PDF whose fonts map to symbols. No words at all.
const GLYPHS = Array.from({ length: 12 }, () => "ÃÄÅÆ ÇÈÉÊ ËÌÍÎ ÏÐÑÒ");

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);

  const up = (filename, buf) => owner("/api/policies/documents", {
    method: "POST", body: { filename, content_base64: buf.toString("base64") } });

  section("A SHORT ONE-PAGE SOP GOES IN — in every format");
  // Sixty words. Eleven of them are "the", "and", "to" and the like. That is
  // ordinary English and was being thrown away.
  const asDocx = await up("session-opening.docx", makeDocx(SOP));
  check("as a Word .docx", asDocx.status === 201, asDocx.data);
  check("and the words are stored, not mangled",
    asDocx.status === 201 && /Arrive five minutes early/.test(asDocx.data.document.body), asDocx.data);

  const asPdf = await up("session-opening.pdf", makePdf(SOP));
  check("as a PDF", asPdf.status === 201, asPdf.data);
  check("and the words are stored",
    asPdf.status === 201 && /Arrive five minutes early/.test(asPdf.data.document.body), asPdf.data);

  const asTxt = await up("session-opening.txt", Buffer.from(SOP.join("\n"), "utf8"));
  check("as plain text", asTxt.status === 201, asTxt.data);

  section("THE GUARD STILL BITES on what it was written for");
  const soup = await up("glyphs.pdf", makePdf(GLYPHS));
  check("a PDF that extracts as symbols is STILL refused", soup.status === 400, soup.data);
  check("and the refusal explains the encoding, not the reader's typing",
    /symbols rather than words/i.test(String(soup.data && soup.data.error || "")), soup.data);
  check("it does not tell somebody to save a PDF as a PDF",
    /\.docx or \.txt/i.test(String(soup.data && soup.data.error || "")), soup.data);

  section("A Word file is never told to save itself as Word");
  // The old message did exactly that, because the PDF-shaped check ran on
  // .docx too. The fix is that it does not run on .docx at all -- so a short
  // Word file cannot produce that message however few common words it has.
  // A CHECKLIST, WHICH IS MOSTLY NOUNS. Twenty-two words and not one "the",
  // "and" or "of" -- it scores zero on the prose test. That is the point:
  // this document can only be accepted if the test does not run on .docx at
  // all, so removing the isPdf condition makes this assertion fail.
  const terse = await up("terse.docx", makeDocx([
    "Clinic Opening Checklist",
    "Lights", "Thermostat", "Sanitizer stations", "Toy bins",
    "Data clipboards", "Timers", "Token boards", "Snack cupboard",
    "Waiting room chairs", "Sign-in tablet", "Door codes",
    "First aid kit", "Emergency contacts sheet",
  ]));
  check("A WORD CHECKLIST WITH NO PROSE IN IT AT ALL is still accepted",
    terse.status === 201, terse.data);
  check("and it is not told to convert to the format it already is",
    terse.status !== 400 || !/save it as \.docx/i.test(String(terse.data.error || "")), terse.data);

  section("What is genuinely not supported says so plainly");
  const oldDoc = await up("legacy.doc", Buffer.from("\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + "\0".repeat(600), "latin1"));
  check("an old binary .doc is refused", oldDoc.status === 400, oldDoc.data);
  check("and told to save as .docx", /\.docx/i.test(String(oldDoc.data.error || "")), oldDoc.data);

  // A .doc renamed to .docx is a very common mistake and must not look like a
  // bug in the CRM.
  const renamed = await up("renamed.docx", Buffer.from("\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + "\0".repeat(600), "latin1"));
  check("a .doc renamed to .docx is refused as not being a Word file",
    renamed.status === 400 && /Word \.docx file/i.test(String(renamed.data.error || "")), renamed.data);

  section("Something with no text at all");
  const empty = await up("blank.txt", Buffer.from("   \n\n  \n", "utf8"));
  check("an empty file is refused", empty.status === 400, empty.data);
  check("and is called empty rather than unreadable",
    /didn't have readable text/i.test(String(empty.data.error || "")), empty.data);

  await pool.query("DELETE FROM crm_policy_documents WHERE filename IN ('session-opening.docx','session-opening.pdf','session-opening.txt','terse.docx')").catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
