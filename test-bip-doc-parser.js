// Reading a Behavior Intervention Plan document into structured fields.
//
// Every fixture here is INVENTED. Real plans are children's clinical records
// and do not belong in a repository, so the shapes are copied from the real
// documents and the content is not.
//
// The assertions that matter are the refusals. Getting a well-formed table
// right is easy; the ways this goes wrong are putting a consequence strategy
// into the antecedent field -- where it reads to staff as what to do BEFORE a
// behaviour -- and inventing a name for a row that never had one. Both would
// be invisible on screen and wrong in a child's plan.
//
//   node test-bip-doc-parser.js
"use strict";
const { parseBipDoc, tidy, splitBehaviorCell } = require("./bip-doc-parser");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

// The shape the real documents arrive in: markdown table, escaped bold, and
// newlines encoded as &#10;.
const DOC = [
  "|  |  |  |",
  "| :-: | :-: | :-: |",
  "| \\*\\*Antecedent Strategies:\\*\\* | \\*\\*Behavior:\\*\\* | \\*\\*Consequences:\\*\\* |",
  "| - Offer a break&#10;  - Use a visual timer | \\*\\*Flopping:\\*\\* - Flopping is defined as dropping to the floor.&#10;  - For example, dropping when asked to line up.&#10;  - Non example, sitting down to play. | - Stay neutral&#10;  - Guide back to the task |",
  "| - Give a two minute warning | \\*\\*Screaming:\\*\\* - Any vocalisation above conversational volume for 3 seconds.&#10;  - For example, screaming when a toy is removed. | - Wait for a calm voice before responding |",
].join("\n");

(async () => {
  section("A well-formed plan");
  const r = parseBipDoc(DOC, { initials: "TeCh", source_name: "TeCh BIP" });
  check("it reads", r.ok === true, r.reason);
  check("one entry per behaviour row", r.behaviors.length === 2, r.behaviors.map((b) => b.name));
  const [flop, scream] = r.behaviors;
  check("the behaviour name is what the document put in bold", flop.name === "Flopping", flop.name);
  check("the definition is kept", /dropping to the floor/.test(flop.operational_definition), flop.operational_definition);
  check("examples are split out of the definition", /line up/.test(flop.examples), flop.examples);
  check("and non-examples are kept apart from examples",
    /sitting down to play/.test(flop.non_examples) && !/sitting down to play/.test(flop.examples), flop);
  check("the definition does not swallow the examples",
    !/line up/.test(flop.operational_definition), flop.operational_definition);

  section("The columns land in the right fields");
  // The failure that matters: a consequence strategy in the antecedent field
  // reads to an RBT as what to do BEFORE the behaviour happens.
  check("antecedents become prevention strategies",
    /Offer a break/.test(flop.prevention_strategies), flop.prevention_strategies);
  check("consequences become the response strategy",
    /Stay neutral/.test(flop.response_strategy), flop.response_strategy);
  check("AND THE TWO ARE NOT SWAPPED",
    !/Stay neutral/.test(flop.prevention_strategies) && !/Offer a break/.test(flop.response_strategy), flop);
  check("the second row is read too", scream.name === "Screaming" && /two minute warning/.test(scream.prevention_strategies), scream);

  section("Column order is read, never assumed");
  const REORDERED = [
    "| \\*\\*Consequences:\\*\\* | \\*\\*Behavior:\\*\\* | \\*\\*Antecedent Strategies:\\*\\* |",
    "| - Stay neutral | \\*\\*Flopping:\\*\\* - Dropping to the floor. | - Offer a break |",
  ].join("\n");
  const rr = parseBipDoc(REORDERED, {});
  check("a document with the columns in a different order still lands correctly",
    rr.ok && /Offer a break/.test(rr.behaviors[0].prevention_strategies)
          && /Stay neutral/.test(rr.behaviors[0].response_strategy), rr.behaviors[0]);

  section("What it refuses");
  const noTable = parseBipDoc("Amir has a behaviour plan. Please see the BCBA.", {});
  check("prose with no table is refused, not guessed at", noTable.ok === false, noTable);
  check("and says why", /No table found/.test(noTable.reason), noTable.reason);

  const unknownHeader = [
    "| Column A | Column B | Column C |",
    "| x | \\*\\*Flopping:\\*\\* - dropping | y |",
  ].join("\n");
  const uh = parseBipDoc(unknownHeader, {});
  check("A TABLE WHOSE COLUMNS CANNOT BE IDENTIFIED IS REFUSED ENTIRELY",
    uh.ok === false, uh);
  check("because guessing would put a consequence in the antecedent field",
    /which column is which/i.test(uh.reason), uh.reason);

  const noName = [
    "| \\*\\*Antecedent Strategies:\\*\\* | \\*\\*Behavior:\\*\\* | \\*\\*Consequences:\\*\\* |",
    "| - Offer a break | some text with no label at all | - Stay neutral |",
    "| - Warn first | \\*\\*Screaming:\\*\\* - loud vocalisation | - Wait |",
  ].join("\n");
  const nn = parseBipDoc(noName, {});
  check("a row with no labelled name is skipped, never given one",
    nn.ok && nn.behaviors.length === 1 && nn.behaviors[0].name === "Screaming", nn.behaviors);
  check("and the skip is reported rather than silent",
    nn.warnings.some((w) => /no labelled behaviour name/.test(w)), nn.warnings);

  const emptyCells = [
    "| \\*\\*Antecedent Strategies:\\*\\* | \\*\\*Behavior:\\*\\* | \\*\\*Consequences:\\*\\* |",
    "| | \\*\\*Flopping:\\*\\* - dropping to the floor | |",
  ].join("\n");
  const ec = parseBipDoc(emptyCells, {});
  check("an empty cell stays empty rather than being filled from another row",
    ec.ok && ec.behaviors[0].prevention_strategies === "" && ec.behaviors[0].response_strategy === "",
    ec.behaviors[0]);

  const missingCol = [
    "| \\*\\*Behavior:\\*\\* | \\*\\*Consequences:\\*\\* |",
    "| \\*\\*Flopping:\\*\\* - dropping | - Stay neutral |",
  ].join("\n");
  const mc = parseBipDoc(missingCol, {});
  check("a document with no antecedent column still reads the rest",
    mc.ok && mc.behaviors[0].response_strategy === "- Stay neutral", mc.behaviors[0]);
  check("and says the missing field was left blank rather than invented",
    mc.warnings.some((w) => /prevention strategies/.test(w)), mc.warnings);

  // Both variations below were found on REAL documents after the first version
  // of this parser silently dropped them.
  section("Real-world variations in how a behaviour is labelled");
  const VARIANTS = [
    "| \\*\\*Antecedent Strategies:\\*\\* | \\*\\*Behavior:\\*\\* | \\*\\*Consequence Interventions:\\*\\* |",
    // no colon after the bolded name
    "| - Warn first | \\*\\*Climbing\\*\\*&#10;  - Both feet on something not meant to be climbed.&#10;  - \\*\\*Ex\\*\\*: standing on a chair.&#10;  - \\*\\*Non-ex\\*\\*: climbing the gym frame. | - Block attempts |",
  ].join("\n");
  const v = parseBipDoc(VARIANTS, {});
  check("a bolded name with NO colon is still read", v.ok && v.behaviors[0].name === "Climbing",
    v.ok ? v.behaviors[0].name : v.reason);
  check("the abbreviation Ex: is recognised as an example",
    /standing on a chair/.test(v.behaviors[0].examples), v.behaviors[0].examples);
  check("and Non-ex: as a non-example, not as an example",
    /climbing the gym frame/.test(v.behaviors[0].non_examples)
      && !/climbing the gym frame/.test(v.behaviors[0].examples), v.behaviors[0]);
  check("SO THE EXAMPLES DO NOT LEAK INTO THE DEFINITION, where they would read as what the behaviour IS",
    !/standing on a chair/.test(v.behaviors[0].operational_definition)
      && /Both feet on something/.test(v.behaviors[0].operational_definition),
    v.behaviors[0].operational_definition);
  check("the consequence column is still not confused with the antecedent one",
    v.behaviors[0].prevention_strategies === "- Warn first"
      && v.behaviors[0].response_strategy === "- Block attempts", v.behaviors[0]);

  section("It cannot hand the matcher a confident match");
  // bip.js scores full name 100 + initials 55 = 155, and calls >= 135
  // "confident" -- which skips human confirmation. Emitting only initials and a
  // first name caps at 90, so a person confirms every link.
  const ident = parseBipDoc(DOC, { initials: "TeCh", first_name: "Tessa" });
  check("initials are passed through", ident.initials === "TeCh", ident.initials);
  check("A FULL CLIENT NAME IS NEVER EMITTED", ident.client_name === undefined, Object.keys(ident));
  check("nor a date of birth", ident.dob === undefined, Object.keys(ident));

  section("Document encoding");
  check("encoded newlines become real ones", tidy("a&#10;b") === "a\nb", tidy("a&#10;b"));
  check("escaped bold markers are removed", tidy("\\*\\*Bold:\\*\\*") === "Bold:", tidy("\\*\\*Bold:\\*\\*"));
  check("escaped hyphens survive as hyphens", tidy("\\-item") === "-item", tidy("\\-item"));
  // Google's export writes an escaped hyphen as a DOUBLE escape. One unescape
  // pass leaves "\\-" in the text, which renders in the plan as stray
  // punctuation in front of every strategy line. Found on a real document.
  check("a double-escaped hyphen is fully unescaped, not half",
    tidy("\\\\-Make transitions fun") === "-Make transitions fun", tidy("\\\\-Make transitions fun"));
  check("and a double-escaped bold marker too",
    tidy("\\\\*\\\\*Bold\\\\*\\\\*") === "Bold", tidy("\\\\*\\\\*Bold\\\\*\\\\*"));
  check("a cell that is only whitespace reads as empty", tidy("   \n  ") === "", JSON.stringify(tidy("   \n  ")));
  check("a behaviour cell with no colon yields nothing rather than a guess",
    splitBehaviorCell("just some words") === null, splitBehaviorCell("just some words"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
