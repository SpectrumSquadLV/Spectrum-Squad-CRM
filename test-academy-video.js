// Training videos play inside the Academy.
//
// A video attached to a week used to be a link that opened a new tab, which
// is a worse way to deliver training than it sounds: the employee leaves
// their checklist to watch it, and the page they come back to knows nothing
// about where they went.
//
// WHY THIS IS AN ALLOWLIST OF HOSTS. An embed is an iframe on a signed-in
// page, so handing an arbitrary pasted address an iframe there hands whoever
// controls that address a frame inside the CRM. Four hosts cover what a
// practice actually has -- YouTube, Vimeo, Loom, and a file already sitting
// in Google Drive -- and everything else stays what it was: a link.
//
// AND IT IS DERIVED, NEVER STORED. The row keeps the address somebody
// pasted; the player address is worked out on every read. If this parser
// gets a host wrong, fixing it fixes every video already attached.
//
//   DATABASE_URL=... node run-tests.js test-academy-video.js
"use strict";

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++; failures.push(name);
    console.log("  FAIL  " + name + (detail !== undefined
      ? "  -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : ""));
  }
};
const section = (t) => console.log("\n== " + t + " ==");

const mod = require("./academy.js")({
  dbGet: async () => null, dbAll: async () => [], dbRun: async () => {},
  nowISO: () => new Date().toISOString(), readBody: async () => ({}), json: () => {},
});
const { videoEmbed } = mod._internal;

(async () => {
  // ==================================================================
  section("The addresses somebody actually pastes");
  const YT = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
  const ok = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube", YT, "copied from the address bar"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ", "YouTube", YT, "without the www"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube", YT, "from a phone"],
    ["https://youtu.be/dQw4w9WgXcQ", "YouTube", YT, "the share link"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "YouTube", YT, "already an embed address"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "YouTube", YT, "a short"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "YouTube", YT, "with a timestamp on it"],
    ["https://vimeo.com/123456789", "Vimeo", "https://player.vimeo.com/video/123456789", "a Vimeo page"],
    ["https://player.vimeo.com/video/123456789", "Vimeo", "https://player.vimeo.com/video/123456789", "a Vimeo player address"],
    ["https://www.loom.com/share/abcdef1234567890", "Loom", "https://www.loom.com/embed/abcdef1234567890", "a Loom share link"],
    ["https://www.loom.com/embed/abcdef1234567890", "Loom", "https://www.loom.com/embed/abcdef1234567890", "a Loom embed link"],
    ["https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view?usp=sharing",
     "Google Drive", "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/preview", "a Drive file shared from the UI"],
  ];
  ok.forEach(([url, provider, src, what]) => {
    const e = videoEmbed(url);
    check(`${what} plays in the page`, e && e.provider === provider && e.src === src, { got: e, want: { provider, src } });
  });
  check("a YouTube timestamp does not end up in the player address", !/t=42/.test(videoEmbed(ok[6][0]).src));
  check("YouTube is embedded through the no-cookie host",
    videoEmbed(ok[0][0]).src.startsWith("https://www.youtube-nocookie.com/"), videoEmbed(ok[0][0]).src);

  // ==================================================================
  section("Everything else stays a link, which is the safe answer");
  const no = [
    ["https://example.com/training.mp4", "a video file on somebody's own website"],
    ["https://my-training-host.test/watch/1", "a host nobody allowlisted"],
    ["https://notyoutube.com/watch?v=dQw4w9WgXcQ", "a lookalike domain"],
    ["https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ", "a domain that only ENDS in youtube.com's name"],
    ["https://evil.test/?x=https://youtube.com/watch?v=dQw4w9WgXcQ", "a real YouTube address inside a query string"],
    ["javascript:alert(1)", "a javascript: address"],
    ["data:text/html;base64,PHNjcmlwdD4=", "a data: address"],
    ["//youtube.com/watch?v=dQw4w9WgXcQ", "a protocol-relative address"],
    ["https://www.youtube.com/", "YouTube's front page, with no video on it"],
    ["https://www.youtube.com/watch?v=../../etc/passwd", "an id that is not an id"],
    ["https://vimeo.com/channels/staffpicks", "a Vimeo page with no video number"],
    ["https://drive.google.com/drive/folders/1AbCdEfGhIjKl", "a Drive FOLDER rather than a file"],
    ["", "nothing at all"],
    ["   ", "whitespace"],
    ["not a url", "something that is not an address"],
  ];
  no.forEach(([url, what]) => check(`${what} is not embedded`, videoEmbed(url) === null, { url, got: videoEmbed(url) }));
  // An http:// YouTube address is still a YouTube address. Refusing it would
  // turn her video into a plain link over a detail she cannot see; the player
  // we build is https either way, so accepting it costs nothing.
  const insecure = videoEmbed("http://www.youtube.com/watch?v=dQw4w9WgXcQ");
  check("an http address still plays", insecure && insecure.provider === "YouTube", insecure);
  check("...through an https player, not the address as pasted",
    insecure && insecure.src.startsWith("https://"), insecure && insecure.src);
  check("null and undefined are survivable", videoEmbed(null) === null && videoEmbed(undefined) === null);

  // ==================================================================
  section("Only a video is treated as one");
  // The payload only asks for an embed on kind === "video", so a LINK to
  // YouTube stays a link -- somebody who chose "Link" meant a link.
  const src = require("fs").readFileSync(require("path").join(__dirname, "academy.js"), "utf8");
  check("the embed is only worked out for a video resource",
    /embed: r\.kind === "video" \? videoEmbed\(r\.url\) : null/.test(src));
  check("...and is derived on read rather than stored on the row",
    !/INSERT INTO academy_resources[\s\S]{0,400}embed/.test(src));
  check("the player is sandboxed where it is drawn",
    /sandbox="allow-scripts allow-same-origin allow-presentation"/.test(
      require("fs").readFileSync(require("path").join(__dirname, "academy-frontend.js"), "utf8")));
  check("...and the link is kept beside it, so a frame that will not load is not a dead end",
    /open it in a new tab/.test(require("fs").readFileSync(require("path").join(__dirname, "academy-frontend.js"), "utf8")));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})();
