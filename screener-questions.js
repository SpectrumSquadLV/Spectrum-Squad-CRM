// screener-questions.js -- the clinical screener's questions, read from the
// form itself.
//
// A submission is stored as { field_name: answer }. Printing that is how you
// get a page reading "Aba: Yes", which is no use to a BCBA reading a child's
// history. The real questions have to come from somewhere.
//
// They are PARSED FROM clinical-screener.html rather than copied into a map
// here, and that is the whole point: a copied map is correct exactly once.
// Someone reorders a question, adds one, or rewords "Does your child have
// siblings?" and the map silently keeps printing last year's wording against
// this year's answers -- which, on a clinical document, is worse than printing
// the raw field name.
//
// The trade is that this depends on the form's markup shape. That is covered
// by test-screener-pdf.js, which fails if any field stops resolving to a
// question.
"use strict";

const fs = require("fs");
const path = require("path");

// Nothing is excluded, and that is deliberate.
//
// An earlier version of this carried a skip-list of names that looked like
// section headings ("medical", "services", "behavior"...). All but one were
// never inputs at all -- they are `data-name` attributes on <section>, which
// the anchored regex below does not match anyway -- and the one real entry was
// `behavior`, the checkbox group holding the parent's selected behaviours of
// concern. So the list did nothing except silently drop the single most
// clinically important answer on the form from the printed record.
//
// If a genuine non-question ever appears, it should be excluded by name here
// with a reason, and test-screener-pdf.js should say why.

const stripTags = (s) => String(s || "").replace(/<[^>]*>/g, " ");
const tidy = (s) =>
  stripTags(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

// Build { field_name: "The question as the parent saw it" }.
//
// For each named input, the question is the nearest <label class="lbl"> before
// it. Where there is none -- the reveal follow-ups, which are bare inputs --
// the placeholder is the question the parent actually read, so that is used
// instead. Both are what appeared on screen, which is the only wording worth
// printing next to an answer.
function parseQuestions(html) {
  const out = {};
  if (!html) return out;

  const inputRe = /<(input|textarea|select)\b[^>]*\bname="([a-zA-Z0-9_]+)"[^>]*>/g;
  let m;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0];
    const name = m[2];
    if (out[name]) continue; // radio groups repeat the name; the first wins

    const before = html.slice(0, m.index);

    // Which context does this input belong to? Two kinds exist, and the right
    // answer is whichever is NEAREST -- not whichever is checked first.
    //
    // This is the part that matters most. The behaviour matrix nests its
    // follow-ups (describe / how often / severity) inside a block whose
    // checkbox names the behaviour, with no label of its own. Reaching for the
    // nearest <label class="lbl"> there walks back out of the section entirely
    // and picks up an unrelated question -- which on a clinical document is
    // worse than printing the raw field name, because it reads as true.
    // Three kinds of context, and the NEAREST one wins:
    //   .lbl        the ordinary question label
    //   behavior=   the behaviour matrix, whose follow-ups have no label and
    //               belong to the behaviour their checkbox names
    //   .q-title    a whole section's question, for a group that carries no
    //               label of its own -- the "Any behaviors of concern?"
    //               checkboxes being the case that matters
    const lblAt = before.lastIndexOf('class="lbl"');
    const behAt = before.lastIndexOf('name="behavior" value="');
    const titleAt = before.lastIndexOf('class="q-title"');
    const nearest = Math.max(lblAt, behAt, titleAt);

    let question = "";
    if (nearest === -1) {
      question = "";
    } else if (nearest === behAt) {
      const v = /name="behavior" value="([^"]*)"/.exec(before.slice(behAt));
      if (v) question = tidy(v[1]);
    } else if (nearest === lblAt) {
      const close = before.indexOf(">", lblAt);
      const end = before.indexOf("</label>", close);
      if (close !== -1 && end !== -1) question = tidy(before.slice(close + 1, end));
    } else {
      const close = before.indexOf(">", titleAt);
      const end = before.indexOf("</h1>", close);
      if (close !== -1 && end !== -1) question = tidy(before.slice(close + 1, end));
    }

    // A follow-up input has no label of its own; its placeholder is the
    // question the parent actually read.
    const ph = /placeholder="([^"]*)"/.exec(tag);
    if (ph && ph[1]) {
      const phText = tidy(ph[1]);
      if (!question) question = phText;
      else if (phText && phText.length > 3) question = `${question} — ${phText}`;
    }

    out[name] = question || name;
  }
  return out;
}

let _cache = null;
function screenerQuestions(htmlPath) {
  if (_cache) return _cache;
  const file = htmlPath || path.join(__dirname, "clinical-screener.html");
  let html = "";
  try { html = fs.readFileSync(file, "utf8"); }
  catch (e) { console.error("[screener] could not read the form for its questions:", e.message); }
  _cache = parseQuestions(html);
  return _cache;
}

// The order the parent answered them in, which is the order they should print.
function questionOrder(htmlPath) {
  return Object.keys(screenerQuestions(htmlPath));
}

module.exports = { screenerQuestions, questionOrder, parseQuestions };
