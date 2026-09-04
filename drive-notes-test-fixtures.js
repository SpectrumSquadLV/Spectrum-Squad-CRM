// drive-notes-test-fixtures.js -- builds the archives the Drive-notes suites
// feed the parser and the API.
//
// Shared by test-drive-notes-parser.js and test-drive-notes.js so there is ONE
// definition of "what a .docx looks like". Two hand-rolled builders would drift,
// and the day they disagreed one suite would be testing a shape the other had
// already stopped producing.
//
// EVERY FIXTURE BUILT WITH THIS IS INVENTED. The practice's real archive is
// clinical notes about named children and does not belong in a repository; what
// is copied from it is the structure -- a folder per set of initials, Docs
// exported as .docx and Sheets as .xlsx, loose notes, an image with no text.
"use strict";
const zlib = require("zlib");

// ------------------------------------------------------------- a zip writer
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

// Writes a real zip: deflated members, a central directory, an end record.
function makeZip(entries, { store = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const body = store ? data : zlib.deflateRawSync(data);
    const method = store ? 0 : 8;
    const crc = CRC(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

// ------------------------------------------------------- document builders
const docx = (paragraphs) => makeZip({
  "[Content_Types].xml": "<Types/>",
  "word/document.xml":
    '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
    paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("") +
    "</w:body></w:document>",
});

// Sheets whose cells are SHARED STRINGS, which is what Excel and Google both
// actually emit -- a reader that only looks at the sheet gets a grid of indices.
const xlsx = (sheets) => {
  const strings = [];
  const idx = (s) => {
    const at = strings.indexOf(s);
    if (at !== -1) return at;
    strings.push(s);
    return strings.length - 1;
  };
  const sheetXml = Object.values(sheets).map((rows) =>
    '<worksheet><sheetData>' +
    rows.map((cells, r) =>
      `<row r="${r + 1}">` +
      cells.map((c, i) =>
        typeof c === "number"
          ? `<c r="${String.fromCharCode(65 + i)}${r + 1}"><v>${c}</v></c>`
          : `<c r="${String.fromCharCode(65 + i)}${r + 1}" t="s"><v>${idx(c)}</v></c>`
      ).join("") + "</row>"
    ).join("") + "</sheetData></worksheet>"
  );
  const files = {
    "xl/workbook.xml": "<workbook><sheets>" +
      Object.keys(sheets).map((n, i) => `<sheet name="${n}" sheetId="${i + 1}"/>`).join("") +
      "</sheets></workbook>",
    "xl/sharedStrings.xml": "<sst>" + strings.map((s) => `<si><t>${s}</t></si>`).join("") + "</sst>",
  };
  sheetXml.forEach((x, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = x; });
  return makeZip(files);
};


module.exports = { makeZip, docx, xlsx, CRC };
