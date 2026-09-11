// hire-packet-content.js -- the packet's own words, read out of the form.
//
// Same reasoning as screener-questions.js, and the same trade. A submission is
// stored as { field_name: answer }, and printing that gets you a personnel
// document reading "Employer1 May Contact: No", which is no use to anybody
// deciding whether to hire someone. The questions have to come from somewhere.
//
// They are PARSED FROM hire-packet.html rather than copied into a map here.
// A copied map is correct exactly once: reword a question, add an employer
// block, renumber a reference, and the map keeps printing last year's wording
// against this year's answers. On an employment application -- which is a
// record of what somebody was actually asked and what they actually agreed to
// -- that is worse than printing the raw field name.
//
// The acknowledgement clauses are read the same way, for a stronger version of
// the same reason: the PDF that goes in the personnel file has to say what the
// applicant read on screen, not what a second copy of it says.
//
// The cost is a dependency on the form's markup shape. test-hire-packet.js
// fails if any field stops resolving to a question, or if any clause stops
// resolving to its text.
"use strict";

const fs = require("fs");
const path = require("path");

const FORM_FILE = path.join(__dirname, "hire-packet.html");

const stripTags = (s) => String(s || "").replace(/<[^>]*>/g, " ");
const tidy = (s) =>
  stripTags(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

function readForm() {
  return fs.readFileSync(FORM_FILE, "utf8");
}

// field name -> the question as it appears on screen.
//
// Three things can name a field, in this order of preference:
//   1. aria-label, used by the education grid where the visible label is a
//      table row and column rather than a <label>.
//   2. The nearest preceding <label class="lbl"> or <span class="qtext">.
//   3. Nothing, which is a bug -- the test asserts this never happens.
// A repeating block (an employer, a reference) prefixes its <h4>, so the
// printed document distinguishes "Employer 2 - Reason for leaving" from
// employer 3's.
function packetQuestions(html) {
  const src = html == null ? readForm() : html;
  const out = {};
  let block = "";
  let label = "";

  const token = /<h4>([\s\S]*?)<\/h4>|<label class="lbl">([\s\S]*?)<\/label>|<span class="qtext">([\s\S]*?)<\/span>|<section\b[^>]*>|<(?:input|textarea|select)\b([^>]*)>/g;
  let m;
  while ((m = token.exec(src))) {
    if (m[1] !== undefined) { block = tidy(m[1]); label = ""; continue; }
    if (m[2] !== undefined) { label = tidy(m[2]); continue; }
    if (m[3] !== undefined) { label = tidy(m[3]); continue; }
    if (m[0].startsWith("<section")) { block = ""; label = ""; continue; }

    const attrs = m[4] || "";
    const nameMatch = attrs.match(/\bname="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    if (out[name]) continue;  // radio groups repeat the name; the first wins

    const aria = attrs.match(/\baria-label="([^"]+)"/);
    if (aria) { out[name] = tidy(aria[1]); continue; }
    if (!label) continue;
    out[name] = block ? `${block} - ${label}` : label;
  }
  return out;
}

// clause key -> the paragraph the applicant initialled.
function packetClauses(html) {
  const src = html == null ? readForm() : html;
  const out = {};
  const re = /<div class="clause" data-clause="([a-z0-9_]+)">[\s\S]*?<div class="ctext">([\s\S]*?)<span class="hint">/g;
  let m;
  while ((m = re.exec(src))) out[m[1]] = tidy(m[2]);
  return out;
}

// The steps the form can show, in the order it shows them. The module's own
// section list is checked against this, so a section that exists on screen and
// nowhere on the server (or the reverse) is a test failure rather than a
// silently skipped page.
function packetSections(html) {
  const src = html == null ? readForm() : html;
  const out = [];
  const re = /<section class="step[^"]*"[^>]*data-section="([a-z0-9_]+)"/g;
  let m;
  while ((m = re.exec(src))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
  return out;
}

// The policy text, as lines, for the copy that goes in the personnel file.
//
// A policy acknowledgment that records only "signed on the 3rd" is worth very
// little five years later when the policy has been revised twice. What is
// filed here is the wording that was on screen on the day it was signed.
function packetPolicy(key, html) {
  const src = html == null ? readForm() : html;
  const pane = new RegExp(`<div class="policy" data-read="${key}">([\\s\\S]*?)</div>`).exec(src);
  if (!pane) return [];
  const out = [];
  const re = /<(h3|h4|p|li)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(pane[1]))) {
    const text = tidy(m[2]);
    if (!text) continue;
    out.push({ kind: m[1] === "li" ? "bullet" : (m[1] === "p" ? "text" : "heading"), text });
  }
  return out;
}

module.exports = { packetQuestions, packetClauses, packetSections, packetPolicy, FORM_FILE };
