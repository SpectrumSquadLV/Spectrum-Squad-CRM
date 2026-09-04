// The Drive archive reader.
//
//   node test-drive-notes-parser.js
//
// EVERY FIXTURE HERE IS INVENTED. The real archive is a folder of clinical
// notes about named children and does not belong in a repository; what is
// copied from it is the SHAPE -- the folder-per-initials layout, the mix of
// Docs-exported-as-.docx and Sheets-exported-as-.xlsx, the loose notes with
// names like "toilet toleration", the token-board photo with no text in it.
//
// The archives are built here rather than checked in as binaries, so what each
// test feeds the parser is readable in the same file as the assertion.
"use strict";
const { readZip, docxText, xlsxText, kindOf, parseDriveArchive, initialsFor, matchClient } = require("./drive-notes-parser");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
};

const { makeZip, docx, xlsx } = require("./drive-notes-test-fixtures");

console.log("\n== The zip reader ==");
const simple = makeZip({ "a.txt": "hello", "dir/b.txt": "world" });
const read = readZip(simple);
check("reads a deflated archive", read.get("a.txt").toString() === "hello", read.get("a.txt"));
check("keeps full paths", read.get("dir/b.txt").toString() === "world");
const stored = readZip(makeZip({ "s.txt": "uncompressed" }, { store: true }));
check("reads STORED members too, which is what a tiny file becomes",
  stored.get("s.txt").toString() === "uncompressed", stored.get("s.txt"));
let threw = "";
try { readZip(Buffer.from("this is not a zip at all")); } catch (e) { threw = e.message; }
check("says so plainly when handed something that is not a zip", /not a zip/i.test(threw), threw);

console.log("\n== Reading a Word document ==");
const notesDoc = docx(["Toilet toleration", "Sat for 4 minutes on 3 May.", "Tolerated the door closed."]);
const notesText = docxText(notesDoc);
check("pulls the text out", /Sat for 4 minutes/.test(notesText), notesText);
check("EACH PARAGRAPH IS ITS OWN LINE, not one run-on sentence",
  notesText.split("\n").length === 3, JSON.stringify(notesText));
check("an empty document reads as empty, not as an error", docxText(docx([])) === "");
const entities = docxText(docx(["Sat &amp; waited &lt;5 min&gt;"]));
check("entities are decoded", entities === "Sat & waited <5 min>", entities);
const tabbed = docxText(makeZip({
  "word/document.xml": '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>A</w:t></w:r><w:tab/><w:r><w:t>B</w:t></w:r></w:p></w:body></w:document>',
}));
check("a tab stays a tab, so a table row is still readable", tabbed === "A\tB", JSON.stringify(tabbed));

console.log("\n== Reading a spreadsheet ==");
const sup = xlsx({
  "Supervision Notes": [
    ["Date", "Supervisor", "Minutes", "Note"],
    ["2026-05-04", "A. Analyst", 45, "Reviewed pairing procedure"],
    ["", "", "", ""],
    ["2026-05-18", "A. Analyst", 60, "Ran fidelity check"],
  ],
});
const supText = xlsxText(sup);
check("THE WORDS COME BACK, not the shared-string indices",
  /Reviewed pairing procedure/.test(supText), supText);
check("numbers survive as numbers", /\t45\t/.test(supText), supText);
check("the sheet is named", /Supervision Notes/.test(supText), supText.slice(0, 60));
check("a blank row is dropped rather than left as a row of tabs",
  !/\n\t+\n/.test(supText) && supText.split("\n").filter((l) => l.trim()).length === 4, JSON.stringify(supText));
const twoTabs = xlsxText(xlsx({ "Targets": [["Goal"], ["Mand"]], "Data": [["Trial"], ["1"]] }));
check("both tabs of a two-tab workbook are read",
  /Targets/.test(twoTabs) && /Data/.test(twoTabs) && /Mand/.test(twoTabs), twoTabs);

console.log("\n== What kind of file it is ==");
check("supervision notes", kindOf("AlQu Supervision Notes.xlsx") === "supervision");
check("program training", kindOf("JaBa Program Training.xlsx") === "programming");
check("a BIP", kindOf("AlQu_BIP.docx") === "bip");
check("a treatment plan", kindOf("XaJo Treatment Plan Excel Sheet.xlsx") === "treatment_plan");
check("SUPERVISION BEATS PLAN when a name could be read as either",
  kindOf("HaHa Supervision Notes for the Treatment Plan.xlsx") === "supervision");
check("AN UNRECOGNISED NAME IS A NOTE, which is the whole point of the feature",
  kindOf("toilet toleration.docx") === "note" && kindOf("eye sight data.docx") === "note");

console.log("\n== A whole archive ==");
const archive = makeZip({
  "Clients/AlQu/AlQu_BIP.docx": docx(["Behavior plan", "Antecedent strategies"]),
  "Clients/AlQu/toilet toleration.docx": docx(["Sat for 4 minutes on 3 May."]),
  "Clients/AlQu/AlQu Supervision Notes.xlsx": sup,
  "Clients/AlQu/token board.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  "Clients/JaBa/Materials.docx": docx(["Two more token boards"]),
  "Clients/__MACOSX/._junk": "rubbish",
  "Clients/Client Flyer.png": Buffer.from([0x89, 0x50]),
});
const parsed = parseDriveArchive(archive);
const alqu = parsed.clients.find((c) => c.initials === "AlQu");
check("clients come out one per folder", parsed.clients.length === 2, parsed.clients.map((c) => c.initials));
check("every file in the folder is present", alqu.files.length === 4, alqu.files.map((f) => f.filename));
check("the loose note's text is there", alqu.files.some((f) => /Sat for 4 minutes/.test(f.text)));
check("the spreadsheet's text is there", alqu.files.some((f) => /Reviewed pairing/.test(f.text)));

const png = alqu.files.find((f) => f.filename === "token board.png");
check("AN IMAGE IS RECORDED RATHER THAN DROPPED, so nobody thinks it is missing",
  !!png && png.readable === false, png);
check("and it says why there is no text", /no text can be extracted/i.test(png.note), png && png.note);
check("its size is kept, which is all there is to know about it", png.bytes === 4, png && png.bytes);

check("a file loose at the top with no client folder is skipped, and reported",
  parsed.skipped.some((s) => /Client Flyer/.test(s.path)), parsed.skipped);
check("Drive and macOS junk is not reported as a client",
  !parsed.clients.some((c) => /MACOSX/.test(c.initials)), parsed.clients.map((c) => c.initials));

const flat = parseDriveArchive(makeZip({ "AlQu/note.docx": docx(["hello"]) }));
check("an archive of the folder CONTENTS works as well as one of the folder",
  flat.clients.length === 1 && flat.clients[0].initials === "AlQu", flat.clients);

const nested = parseDriveArchive(makeZip({ "Clients/AlQu/2026/May note.docx": docx(["nested"]) }));
check("A FILE IN A SUBFOLDER STILL BELONGS TO ITS CLIENT",
  nested.clients.length === 1 && nested.clients[0].initials === "AlQu", nested.clients);
check("and its folder is kept so it does not look misfiled",
  /2026/.test(nested.clients[0].files[0].folder), nested.clients[0].files[0].folder);

const long = parseDriveArchive(
  makeZip({ "Clients/AlQu/long.docx": docx([Array(500).fill("a sentence about a session.").join(" ")]) }),
  { maxTextChars: 100 }
);
check("an enormous document is truncated rather than refused",
  long.clients[0].files[0].text.length === 100 && long.clients[0].files[0].truncated === true,
  long.clients[0].files[0].text.length);

const broken = parseDriveArchive(makeZip({ "Clients/AlQu/corrupt.docx": Buffer.from("not a docx") }));
check("A FILE THAT CANNOT BE READ IS STILL LISTED, with the reason",
  broken.clients[0].files[0].readable === false && /could not be read/i.test(broken.clients[0].files[0].note),
  broken.clients[0].files[0]);

console.log("\n== Matching a folder to a client ==");
check("initials are first-two plus first-two", initialsFor("Alejandro Quiroz") === "alqu");
check("case and punctuation do not matter", initialsFor("  ALEJANDRO   quiroz ") === "alqu");
check("a middle name is ignored -- the last word is the surname",
  initialsFor("Alejandro Luis Quiroz") === "alqu");
check("a hyphenated surname still works", initialsFor("Sofia Mc-Cabe") === "somc");
check("a single name yields nothing rather than a guess", initialsFor("Alejandro") === null);

const roster = [
  { id: 1, child_name: "Alejandro Quiroz" },
  { id: 2, child_name: "Jaxon Barlew" },
  { id: 3, child_name: "Alma Quill" },
];
check("an unambiguous folder matches", matchClient("AlQu", [roster[0], roster[1]]).client.id === 1);
check("case does not matter", matchClient("alqu", [roster[0]]).ok === true);
const none = matchClient("ZzZz", roster);
check("no match is refused, not guessed at", none.ok === false && /no client/i.test(none.reason), none);
const two = matchClient("AlQu", roster);
check("TWO CHILDREN WITH THE SAME INITIALS IS REFUSED, never picked between",
  two.ok === false && /more than one/i.test(two.reason), two);
check("and both candidates are named so a person can decide",
  two.candidates.length === 2 && /Alejandro Quiroz/.test(two.reason) && /Alma Quill/.test(two.reason), two.reason);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
