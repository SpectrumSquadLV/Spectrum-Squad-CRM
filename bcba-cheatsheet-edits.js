// bcba-cheatsheet-edits.js -- payer requirements that the practice can change.
//
// bcba-cheatsheet-data.js is a CONVERSION of the practice's Authorization &
// Treatment Plan Cheat Sheet, verbatim, regenerated from that document. Payers
// change their requirements between conversions, so the Hub needs a way to
// correct a line without anybody editing a file -- and without losing what the
// document actually said.
//
// SO EDITS ARE AN OVERLAY, NOT A REWRITE. The converted data stays exactly as
// it is and a small table records what a person changed on top of it: this line
// now reads that, this one no longer applies, this one is new. Three things
// fall out of that, all of which matter more than they look:
//
//   1. THE ORIGINAL IS ALWAYS RECOVERABLE. An edit can be reverted to the
//      document's own wording, and the screen can show what it used to say.
//      A destructive edit to a payer requirement is otherwise unrecoverable
//      without a database restore.
//   2. REGENERATING THE FILE DOES NOT SILENTLY REAPPLY OLD EDITS. An edit is
//      keyed by a hash of the text it replaced. If the document is reconverted
//      and that line has changed, the edit no longer matches anything and is
//      reported as ORPHANED rather than being applied to whatever now sits in
//      that position. Position-keyed edits would quietly attach last year's
//      correction to a different requirement.
//   3. NOTHING IS INVENTED. This module moves text a person typed. It does not
//      merge payers, infer a requirement from another payer, or fill a gap.
//
// Pure functions, no database and no server: bcba-hub.js supplies the rows.
"use strict";

const crypto = require("crypto");

// The lists on a payer that can be edited, and where each one lives.
// "section:<key>" addresses the items of one titled section.
const TOP_LEVEL_LISTS = [
  "assessment_authorization",
  "assessment_units",
  "required_documents",
  // The reviewer hot buttons are not a bare array -- they are
  // { title, lead, points } -- so the editable list is the points inside it.
  // Naming it "hot_buttons" and hoping would make every edit an orphan.
  "hot_buttons_points",
];

function normalize(text) {
  // Whitespace only. The wording itself is never touched -- two requirements
  // that differ by a word are two requirements.
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

// Identity of a line, within its list. Hashing the text rather than the index
// is the whole point: see (2) above.
function itemHash(text) {
  return crypto.createHash("sha1").update(normalize(text)).digest("hex").slice(0, 16);
}

function listKeysFor(payer) {
  const keys = TOP_LEVEL_LISTS.filter((k) => readList(payer, k) !== null);
  (payer.sections || []).forEach((s) => keys.push("section:" + s.key));
  return keys;
}

// The plain text of one line, whichever shape the list holds. Top-level lists
// are strings; section items are objects carrying depth and kind as well.
const textOf = (item) => (item && typeof item === "object" ? item.text : item);

function readList(payer, listKey) {
  if (listKey.startsWith("section:")) {
    const s = (payer.sections || []).find((x) => "section:" + x.key === listKey);
    return s ? s.items || [] : null;
  }
  if (listKey === "hot_buttons_points") {
    return payer.hot_buttons && Array.isArray(payer.hot_buttons.points)
      ? payer.hot_buttons.points : null;
  }
  return Array.isArray(payer[listKey]) ? payer[listKey] : null;
}

// Apply one payer's edits. Returns the payer with the overlay applied, plus the
// edits that matched nothing so the caller can put them in front of a person.
function applyEdits(payer, edits) {
  const mine = (edits || []).filter((e) => e.payer_key === payer.key);
  if (!mine.length) return { payer, orphaned: [] };

  const used = new Set();
  const out = { ...payer };
  const orphaned = [];

  const rewrite = (items, listKey) => {
    const byHash = new Map();
    mine.forEach((e) => {
      if (e.list_key === listKey && e.op !== "add" && e.original_hash) byHash.set(e.original_hash, e);
    });

    const kept = [];
    for (const item of items) {
      const edit = byHash.get(itemHash(textOf(item)));
      if (!edit) { kept.push(item); continue; }
      used.add(edit.id);
      if (edit.op === "remove") continue;         // no longer required by this payer
      kept.push({
        ...(typeof item === "object" ? item : { text: item }),
        text: edit.text,
        edited: true,
        original_text: textOf(item),
        edited_by: edit.updated_by || null,
        edited_at: edit.updated_at || null,
        edit_id: edit.id,
      });
    }

    // Additions go at the end of their list, in the order they were added. A
    // person adding "Aetna now wants X" is appending to a list, not inserting
    // into the document's own sequence.
    mine
      .filter((e) => e.list_key === listKey && e.op === "add")
      .sort((a, b) => (a.id || 0) - (b.id || 0))
      .forEach((e) => {
        used.add(e.id);
        kept.push({
          text: e.text,
          depth: 0,
          kind: "item",
          reauth_only: false,
          added: true,
          edited_by: e.updated_by || null,
          edited_at: e.updated_at || null,
          edit_id: e.id,
        });
      });

    return kept;
  };

  for (const listKey of listKeysFor(payer)) {
    const items = readList(payer, listKey);
    if (!items) continue;
    const next = rewrite(items, listKey);
    if (listKey.startsWith("section:")) {
      out.sections = (out.sections || []).map((s) =>
        "section:" + s.key === listKey ? { ...s, items: next } : s
      );
    } else if (listKey === "hot_buttons_points") {
      out.hot_buttons = { ...out.hot_buttons, points: next.map((x) =>
        x && typeof x === "object" && (x.edited || x.added) ? x : textOf(x)) };
    } else {
      // A top-level list is strings today. An edited or added line becomes an
      // object so the page can show that it was changed and by whom; a line
      // nobody touched stays exactly the string the conversion produced.
      out[listKey] = next.map((x) =>
        x && typeof x === "object" && (x.edited || x.added) ? x : textOf(x)
      );
    }
  }

  mine.forEach((e) => {
    if (!used.has(e.id)) {
      orphaned.push({
        id: e.id, payer_key: e.payer_key, list_key: e.list_key, op: e.op,
        text: e.text, original_text: e.original_text,
        reason: "The line this change was made against is no longer in the cheat sheet.",
      });
    }
  });

  return { payer: out, orphaned };
}

// Does this list exist on this payer? Checked before an edit is stored, so a
// typo in a list name is refused at the point of writing rather than becoming
// an orphan nobody can explain.
function listExists(payer, listKey) {
  return readList(payer, listKey) !== null;
}

// Is there a line with this hash to edit or remove?
function findByHash(payer, listKey, hash) {
  const items = readList(payer, listKey);
  if (!items) return null;
  const found = items.find((i) => itemHash(textOf(i)) === hash);
  return found === undefined ? null : textOf(found);
}

module.exports = {
  TOP_LEVEL_LISTS,
  normalize,
  itemHash,
  listKeysFor,
  applyEdits,
  listExists,
  findByHash,
};
