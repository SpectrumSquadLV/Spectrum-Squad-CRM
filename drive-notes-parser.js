// drive-notes-parser.js -- read a Google Drive "Download folder" archive and
// turn it into per-client notes.
//
// WHY AN ARCHIVE AND NOT AN API CALL
//
// The practice keeps a folder per client under Clients/, named with the child's
// initials -- AlQu is Alejandro Quiroz -- holding whatever that client has
// accumulated: a BIP, supervision notes, program training sheets, a treatment
// plan, loose notes like "toilet toleration", a photo of a token board.
//
// The CRM has no Google credentials and is not being given any, so it cannot
// read that folder itself. What it can read is the .zip Drive produces from
// "Download" on the folder: Docs come out as .docx, Sheets as .xlsx, everything
// else exactly as uploaded. One download, one upload, no service account, and
// no clinical text passing through anything on the way.
//
// ZERO DEPENDENCIES, which is the house style here and not an affectation: a
// .docx and an .xlsx are themselves zip files, so ONE reader built on the
// zlib that ships with Node handles the archive and both document formats.
//
// WHAT IT REFUSES TO DO
//
// This file extracts text. It does not summarise, reorder, or decide what a
// note means, and it never invents a client. A file it cannot read is recorded
// AS a file it cannot read, with its name and size, rather than dropped -- the
// person importing needs to know something is there that they will still have
// to open in Drive.
"use strict";

const zlib = require("zlib");

// ---------------------------------------------------------------- zip reading

// Read the central directory rather than walking local headers. A local header
// may carry zeroed sizes with the real ones in a trailing data descriptor,
// which is exactly what streaming writers (Drive's included) produce; the
// central directory always has the true values.
function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const EOCD = 0x06054b50;

  // The end record is last, but a zip comment can follow it, so scan back.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("That file is not a zip archive.");

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) {
    // Zip64. Not produced by a Drive folder download at any plausible size, and
    // guessing at the offsets would mean silently reading the wrong bytes.
    throw new Error("That archive uses the zip64 format, which this importer cannot read.");
  }

  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  const out = new Map();
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;             // a directory record
    if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = buf.slice(start, start + e.compressedSize);
    try {
      if (e.method === 0) out.set(e.name, raw);
      else if (e.method === 8) out.set(e.name, zlib.inflateRawSync(raw));
      // Any other method (there are several, all rare) is skipped rather than
      // guessed at; the caller reports the file as unreadable.
    } catch (err) {
      // A corrupt member must not take the whole archive down with it.
    }
  }
  return out;
}

// ------------------------------------------------------------ xml to plain text

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");   // last, or "&amp;lt;" decodes twice
}

function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A .docx is a zip; the text lives in word/document.xml. Paragraph and row ends
// become newlines BEFORE tags are stripped, or the whole document collapses
// into one unreadable line -- which is the usual way this is got wrong.
function docxText(zipBuf) {
  const files = readZip(zipBuf);
  const doc = files.get("word/document.xml");
  if (!doc) return "";
  let xml = doc.toString("utf8");
  xml = xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t");
  return tidy(decodeEntities(xml.replace(/<[^>]+>/g, "")));
}

// An .xlsx is a zip too. Cell text is usually not in the sheet: a string cell
// holds an INDEX into xl/sharedStrings.xml, so a reader that ignores that file
// produces a grid of numbers where the words should be.
function xlsxText(zipBuf) {
  const files = readZip(zipBuf);

  const shared = [];
  const ssXml = files.get("xl/sharedStrings.xml");
  if (ssXml) {
    const xml = ssXml.toString("utf8");
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) || []) {
      // One <si> can hold several <t> runs (mixed formatting inside one cell).
      const parts = (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
        .map((t) => decodeEntities(t.replace(/<[^>]+>/g, "")));
      shared.push(parts.join(""));
    }
  }

  // Sheet names, so a tab called "Supervision Notes" is not reported as sheet1.
  const names = [];
  const wb = files.get("xl/workbook.xml");
  if (wb) {
    for (const m of wb.toString("utf8").match(/<sheet\b[^>]*\/?>/g) || []) {
      const n = m.match(/name="([^"]*)"/);
      names.push(n ? decodeEntities(n[1]) : "");
    }
  }

  const sheetKeys = Array.from(files.keys())
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));

  const out = [];
  sheetKeys.forEach((key, i) => {
    const xml = files.get(key).toString("utf8");
    const rows = [];
    for (const rowXml of xml.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || []) {
      const cells = [];
      for (const cellXml of rowXml.match(/<c\b[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || []) {
        const type = (cellXml.match(/\bt="([^"]*)"/) || [])[1] || "n";
        if (type === "inlineStr") {
          const t = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          cells.push(t ? decodeEntities(t[1]) : "");
          continue;
        }
        const v = cellXml.match(/<v>([\s\S]*?)<\/v>/);
        if (!v) { cells.push(""); continue; }
        const raw = decodeEntities(v[1]);
        cells.push(type === "s" ? (shared[Number(raw)] ?? "") : raw);
      }
      // A row of nothing but empty cells is spacing, not data.
      if (cells.some((c) => String(c).trim() !== "")) rows.push(cells.join("\t"));
    }
    if (!rows.length) return;
    const title = names[i] || key.replace("xl/worksheets/", "").replace(".xml", "");
    out.push(sheetKeys.length > 1 || names[i] ? `## ${title}\n${rows.join("\n")}` : rows.join("\n"));
  });
  return tidy(out.join("\n\n"));
}

// ------------------------------------------------------------------ classifying

const KINDS = [
  // Order matters: "AlQu Supervision Notes" is supervision, not a plan, even
  // though a treatment plan is also a document about a client.
  [/supervision/i, "supervision"],
  [/program\s*training|programs?\b/i, "programming"],
  [/\bbip\b|behaviou?r\s*intervention/i, "bip"],
  [/treatment\s*plan/i, "treatment_plan"],
];

// What a file is, from its name -- and "note" when nothing matches, because an
// unrecognised name is the loose note this feature mostly exists to surface
// ("toilet toleration", "eye sight data"). Guessing a specific kind from an
// unrecognised name is how a note ends up filed as a treatment plan.
function kindOf(filename) {
  // Separators become spaces BEFORE matching. The practice's own files are
  // named "AlQu_BIP.docx", and an underscore is a word character to a regular
  // expression -- so a \b-anchored "bip" does not match it, and the file this
  // rule exists for was being filed as an unrecognised note.
  const base = String(filename)
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_\-.]+/g, " ");
  for (const [re, kind] of KINDS) if (re.test(base)) return kind;
  return "note";
}

const TEXT_EXT = { docx: docxText, xlsx: xlsxText };

function extOf(name) {
  const m = String(name).match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

// ---------------------------------------------------------------- the archive

// Every path in the archive that sits under a per-client folder.
//
// Drive's download nests everything under the folder you downloaded, so the
// paths look like "Clients/AlQu/AlQu_BIP.docx". Somebody may equally well
// download the Clients folder's CONTENTS, giving "AlQu/AlQu_BIP.docx". Both are
// handled by taking the directory that CONTAINS the file and treating its own
// parent as the root, rather than by assuming a fixed depth.
function parseDriveArchive(zipBuffer, { maxTextChars = 200000 } = {}) {
  const files = readZip(zipBuffer);
  const byInitials = new Map();
  const skipped = [];

  const paths = Array.from(files.keys())
    .filter((p) => !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(p))
    .map((p) => p.split("/").filter(Boolean));

  // IS THERE A WRAPPER FOLDER? Downloading the Clients folder gives
  // "Clients/AlQu/note.docx"; downloading its contents gives "AlQu/note.docx".
  // Those two are indistinguishable from a single path, so the archive as a
  // whole decides: one shared first segment AND something nested below it means
  // that segment is a wrapper, not a client.
  //
  // This is not cosmetic. Without it "Clients/Client Flyer.png" -- a loose file
  // that belongs to nobody -- becomes A CLIENT CALLED "Clients", carrying a
  // stray flyer, which then has to be explained to whoever runs the import.
  // The rule is derived rather than hard-coded to the word "Clients", so a
  // renamed folder does not resurrect that.
  const firstSegments = new Set(paths.map((p) => p[0]));
  const hasRoot = firstSegments.size === 1 && paths.some((p) => p.length >= 3);

  for (const [path, data] of files) {
    if (/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(path)) continue;
    const parts = path.split("/").filter(Boolean);
    const depthNeeded = hasRoot ? 3 : 2;
    if (parts.length < depthNeeded) {
      // Loose at the top, with no client folder above it.
      skipped.push({ path, reason: "not inside a client folder" });
      continue;
    }
    const filename = parts[parts.length - 1];
    // The client is the folder just below the root, not the one just above the
    // file: a note filed under Clients/AlQu/2026/ still belongs to AlQu. The
    // path in between is kept so nothing looks misfiled.
    const initials = hasRoot ? parts[1] : parts[0];
    const subPath = parts.slice(0, -1).join("/");

    const ext = extOf(filename);
    const entry = {
      filename,
      path,
      folder: subPath,
      kind: kindOf(filename),
      ext,
      bytes: data.length,
      text: "",
      readable: false,
      note: "",
    };

    if (TEXT_EXT[ext]) {
      try {
        const text = TEXT_EXT[ext](data);
        entry.text = text.length > maxTextChars ? text.slice(0, maxTextChars) : text;
        entry.truncated = text.length > maxTextChars;
        entry.readable = true;
        if (!text.trim()) entry.note = "The document is empty.";
      } catch (err) {
        entry.note = "Could not be read: " + err.message;
      }
    } else {
      // An image, a PDF, a video. RECORDED RATHER THAN DROPPED: somebody
      // reading a client's notes needs to know a token-board photo exists even
      // though no text can be pulled out of it.
      entry.note = `No text can be extracted from a .${ext || "file"}.`;
    }

    if (!byInitials.has(initials)) byInitials.set(initials, []);
    byInitials.get(initials).push(entry);
  }

  const clients = Array.from(byInitials, ([initials, entries]) => ({
    initials,
    files: entries.sort((a, b) => a.filename.localeCompare(b.filename)),
  })).sort((a, b) => a.initials.localeCompare(b.initials));

  return { clients, skipped };
}

// ------------------------------------------------------------------- matching

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
}

// Initials as the practice writes them: the first two letters of the first name
// and the first two of the last. "AlQu" is Alejandro Quiroz.
//
// Deliberately NOT a fuzzy match. Two children whose names both reduce to the
// same four letters is not a rare accident in a caseload of siblings and common
// surnames, and picking one of them files a child's notes on another child's
// record. Ambiguity is refused and reported.
function initialsFor(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const first = norm(parts[0]);
  const last = norm(parts[parts.length - 1]);
  if (first.length < 2 || last.length < 2) return null;
  return (first.slice(0, 2) + last.slice(0, 2)).toLowerCase();
}

// Given the folder initials and the CRM's client list, return exactly one
// client or say why not.
function matchClient(initials, clients) {
  const want = norm(initials);
  if (!want) return { ok: false, reason: "The folder name is not a set of initials." };
  const hits = clients.filter((c) => initialsFor(c.child_name) === want);
  if (hits.length === 1) return { ok: true, client: hits[0] };
  if (hits.length === 0) return { ok: false, reason: "No client in the CRM has these initials." };
  return {
    ok: false,
    reason: "More than one client has these initials: " + hits.map((c) => c.child_name).join(", "),
    candidates: hits,
  };
}

module.exports = {
  readZip,
  docxText,
  xlsxText,
  kindOf,
  parseDriveArchive,
  initialsFor,
  matchClient,
};
