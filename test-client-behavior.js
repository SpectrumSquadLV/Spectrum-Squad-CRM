// The Client Behavior section.
//
// THE PROPERTY THAT MATTERS, and the reason this suite exists: the Behavior
// Intervention Plan reachable from the Client Behavior tab and the one on the
// client's card must be ONE record, not two that are kept in step. The spec
// was explicit that a second BIP system must not appear, and "we'll remember
// to keep them in sync" is exactly the promise that quietly stops being true.
//
// So this asserts the structural version of it: there is one plan table, one
// plan endpoint, and one renderer, and the new section adds no plan storage of
// its own. A future change that forked the plan would break these.
//
// Behavior modification notes ARE new, and the assertions on them are about
// what they refuse: an empty note, a note on a client that does not exist, a
// write by somebody without clinical edit rights, and a PDF that is a real
// file rather than an HTML page with the wrong header.
//
//   node test-client-behavior.js
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + String(detail).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");

(async () => {
  // ================= one plan, not two ==================================
  section("The plan is one record with one owner");
  const bipSrc = read("bip.js");
  const cbSrc = read("client-behavior-frontend.js");

  check("the new section defines no plan table of its own",
    !/CREATE TABLE[^;]*client_bips/i.test(cbSrc) && !/CREATE TABLE/i.test(cbSrc));
  check("client_bips is created in exactly one place",
    (bipSrc.match(/CREATE TABLE IF NOT EXISTS client_bips/g) || []).length === 1);
  check("and it is one row per client, so a second plan cannot exist",
    /client_id INTEGER NOT NULL UNIQUE/.test(bipSrc));

  // The strong form: the page does not re-render the plan, it calls the very
  // function the client card calls.
  check("the Client Behavior page renders the plan via __renderBipSection",
    /window\.__renderBipSection\(/.test(cbSrc), "must reuse the card's renderer");
  check("that renderer is defined by bip-frontend.js",
    /window\.__renderBipSection\s*=/.test(read("bip-frontend.js")));
  check("the page never fetches plan fields into its own editor",
    !/\/api\/bip\/client\/\$\{[^}]*\}(?!\/behavior-notes)["'`]/.test(cbSrc.replace(/behavior-notes/g, "BN")),
    "the plan must come from the shared renderer, not a private copy");

  // ================= wiring =============================================
  section("The tab is wired the way every other section is");
  const idx = read("index.html");
  check("the bundle is served by the server",
    /"\/client-behavior-frontend\.js"/.test(read("server.js")));
  check("the script is loaded after bip-frontend.js, which it depends on",
    idx.indexOf("client-behavior-frontend.js") > idx.indexOf("bip-frontend.js"));
  check("the router has a #/client-behavior branch",
    /hash\.startsWith\("#\/client-behavior"\)/.test(idx));
  check("the nav entry exists", /key: "client-behavior"/.test(idx));
  check("the nav entry is gated on canAccessClients(), the same rule bip.js enforces",
    /canAccessClients\(\)\)\s*\n[^\n]*navItems\.push\(\{ key: "client-behavior"/.test(idx));
  // Where it sits is a stated requirement, not decoration: it is client
  // clinical information and belongs with the client sections.
  check("it sits with the client sections, right after Client Pipeline",
    idx.indexOf('key: "client-behavior"') > idx.indexOf('key: "pipeline"') &&
    idx.indexOf('key: "client-behavior"') < idx.indexOf('key: "tasks"'));

  // ================= who is on the roster ===============================
  // A BIP is a plan for a child who is in therapy or about to start. Everyone
  // still moving through intake, and anyone parked on the waitlist, has no
  // behaviour to plan for yet -- and listing them buries the clients a BCBA is
  // actually working.
  section("Only clients in therapy or starting appear");
  const roster = bipSrc.slice(bipSrc.indexOf('"/api/bip/roster"'), bipSrc.indexOf('"/api/bip/roster"') + 1800);
  check("the roster selects clients in therapy",
    /stage IN \('active', 'first_day_scheduled'\)/.test(roster), roster.slice(0, 300));
  // The week before day one is when the plan is being WRITTEN, so a client with
  // a start date on the books has to be reachable from this tab.
  check("and clients with a first day scheduled, who are the ones being drafted for",
    /first_day_scheduled/.test(roster));
  check("intake stages are still excluded",
    !/new_submission|clinical_screener|insurance_verification|assessment_scheduling|authorization/.test(roster));
  check("and so are discharged and closed clients",
    !/discharged|not_moving_forward/.test(roster));
  check("WAITLISTED CLIENTS ARE EXCLUDED, and by their own flag rather than by stage",
    /COALESCE\(c\.waitlisted, false\) = false/.test(roster), roster.slice(0, 400));
  // waitlisted is a boolean a client can carry at any stage, including active
  // when therapy is paused, so checking the stage alone would not have caught it.
  check("the waitlist check is separate from the stage check, because the flag is",
    /stage IN \([^)]*\)[\s\S]{0,120}COALESCE\(c\.waitlisted/.test(roster));
  // Two stages on one list is only readable if a row says which it is.
  check("the roster reports the stage, so a pre-start client can be marked as one",
    /c\.stage/.test(roster) && /stage: r\.stage/.test(roster), roster.slice(0, 600));

  // ================= permissions ========================================
  section("Reads and writes are gated on the existing roles");
  check("every /api/bip route is behind canViewBip",
    /if \(!canViewBip\(user\)\) \{ json\(res, 403/.test(bipSrc));
  const gateAt = bipSrc.indexOf("Only clinical staff can change a BIP");
  check("the roster is a read, above the edit gate",
    bipSrc.indexOf('"/api/bip/roster"') < gateAt && bipSrc.indexOf('"/api/bip/roster"') > 0);
  check("reading notes is above the edit gate",
    bipSrc.indexOf("behavior-notes$/") < gateAt);
  check("WRITING a note is below it",
    bipSrc.indexOf("notesMatch && method === \"POST\"") > gateAt);
  check("editing a note is below it",
    bipSrc.indexOf("behaviorNoteEdit && method === \"PATCH\"") > gateAt);
  check("the PDF is above the edit gate but still inside the view gate",
    bipSrc.indexOf("behavior-notes\\/(\\d+)\\/pdf") < gateAt || bipSrc.indexOf("/pdf$/") < gateAt);

  // ================= the notes are not the other notes ==================
  section("Behavior notes are their own table, not bolted onto bip_notes");
  check("a bip_behavior_notes table exists",
    /CREATE TABLE IF NOT EXISTS bip_behavior_notes/.test(bipSrc));
  check("the threaded clinical bip_notes table is untouched",
    /CREATE TABLE IF NOT EXISTS bip_notes/.test(bipSrc) && /parent_id INTEGER/.test(bipSrc));
  check("behavior notes carry the fields the spec asked for",
    ["note_date", "behavior", "strategy", "instructions", "author"]
      .every((f) => new RegExp(f + "\\s+TEXT").test(bipSrc)));
  check("and record who edited one, so an edit is attributable",
    /updated_by TEXT/.test(bipSrc));
  check("an edit is written to the plan's change history",
    /logChange\([^)]*Behavior note/.test(bipSrc));

  // ================= the refusals =======================================
  section("What a note refuses to be");
  check("a note with nothing in it is rejected on create",
    /!filled\(b\.behavior\) && !filled\(b\.strategy\) && !filled\(b\.instructions\)/.test(bipSrc));
  check("and cannot be emptied by an edit either",
    /!filled\(next\.behavior\) && !filled\(next\.strategy\) && !filled\(next\.instructions\)/.test(bipSrc));
  check("a note for a client that does not exist is a 404, not a stray row",
    /if \(!client\) \{ json\(res, 404, \{ error: "Client not found" \}\); return true; \}/.test(bipSrc));

  // ================= the PDF is a real file =============================
  // Exercised for real rather than pattern-matched: a Content-Type of
  // application/pdf on something that is not a PDF is worse than no download.
  section("The PDF is a real PDF");
  const initBip = require("./bip.js");
  const mod = initBip({
    dbGet: async () => null, dbAll: async () => [], dbRun: async () => ({}),
    nowISO: () => "2026-09-04T12:00:00.000Z", crypto: require("crypto"),
    readBody: async () => ({}), json: () => {},
    sendEmail: async () => {}, APP_BASE_URL: "http://x", getAppSetting: async () => "",
    canAccessClients: () => true,
  });
  const build = mod._test && mod._test.buildNotePdf;
  check("the builder is reachable for testing", typeof build === "function");
  if (typeof build === "function") {
    const long = ("Reinforce the replacement behavior every single time it appears, " +
      "including when it is imperfect, and record the antecedent. ").repeat(40);
    const buf = build({ child_name: "Ada Nguyen" }, {
      note_date: "2026-09-04", behavior: "Elopement",
      strategy: long, instructions: "Ask before opening the door.",
      author: "R. Vega",
    });
    check("it starts with a PDF header", buf.slice(0, 5).toString("latin1") === "%PDF-");
    check("and ends with the EOF marker", buf.slice(-6).toString("latin1").trim() === "%%EOF");
    check("it declares a cross-reference table", buf.includes(Buffer.from("xref")));
    const pageCount = (buf.toString("latin1").match(/\/Type \/Page[^s]/g) || []).length;
    check("long text paginates instead of being truncated", pageCount > 1, "pages: " + pageCount);
    check("the /Count matches the pages actually written",
      new RegExp("/Count " + pageCount + "\\b").test(buf.toString("latin1")),
      buf.toString("latin1").match(/\/Count \d+/));
    check("the instructions survive to the last page",
      buf.toString("latin1").includes("Ask before opening the door."));

    // The structural check that matters. A hand-rolled PDF is rejected by real
    // readers when an xref offset does not land exactly on its object header,
    // and nothing about the file looks wrong until something tries to open it.
    const t = buf.toString("latin1");
    const sx = Number((t.match(/startxref\s+(\d+)/) || [])[1]);
    check("startxref points at the xref table", t.slice(sx, sx + 4) === "xref", t.slice(sx, sx + 12));
    const head = t.slice(sx).match(/xref\n0 (\d+)\n/);
    const declared = Number(head[1]);
    const entries = t.slice(sx + head[0].length, sx + head[0].length + 20 * declared)
      .match(/(\d{10}) (\d{5}) ([nf])/g) || [];
    check("the xref table has one entry per declared object",
      entries.length === declared, `${entries.length} vs ${declared}`);
    const badOffsets = [];
    entries.forEach((e, i) => {
      const [, off, , kind] = e.match(/(\d{10}) (\d{5}) ([nf])/);
      if (kind === "f") return;
      if (!new RegExp("^" + i + " 0 obj").test(t.slice(Number(off), Number(off) + 24))) {
        badOffsets.push(i);
      }
    });
    check("EVERY xref offset lands on its object header -- the thing that makes a reader reject a file",
      badOffsets.length === 0, "objects: " + badOffsets.join(","));
    const kids = ((t.match(/\/Kids \[([^\]]*)\]/) || [])[1] || "").match(/\d+ 0 R/g) || [];
    check("the page tree, /Count and /Kids all agree",
      kids.length === pageCount && Number((t.match(/\/Count (\d+)/) || [])[1]) === pageCount,
      `kids=${kids.length} count=${(t.match(/\/Count (\d+)/) || [])[1]} pages=${pageCount}`);

    // A name with an accent must not corrupt the byte stream.
    const accented = build({ child_name: "David Sánchez" }, {
      note_date: "2026-09-04", behavior: "Elopement", strategy: "s", instructions: "i", author: "Quiana",
    });
    check("an accented name still produces a valid PDF",
      accented.slice(0, 5).toString("latin1") === "%PDF-" && accented.length > 400);
    check("fonts declare WinAnsi so those characters render",
      accented.toString("latin1").includes("/WinAnsiEncoding"));

    // Parentheses and backslashes are PDF syntax; unescaped they break the file.
    const tricky = build({ child_name: "Test" }, {
      note_date: "2026-09-04", behavior: "Hits (open hand) \\ pushes",
      strategy: "Redirect (calmly)", instructions: "x", author: "A",
    });
    check("parentheses and backslashes are escaped, not left to break the stream",
      tricky.toString("latin1").includes("Hits \\(open hand\\) \\\\ pushes"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR:", e); process.exit(1); });
