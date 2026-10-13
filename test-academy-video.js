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
const { videoEmbed, videoFile } = mod._internal;

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

  // ==================================================================
  section("AN MP4 BY LINK PLAYS IN THE PAGE");
  // The practice's own training videos are MP4 files. A direct link to one
  // matched none of the hosts above, so it fell through to "open it in a new
  // tab" -- the one case with no player and therefore no play button.
  const mp4 = videoFile("https://files.spectrumsquadlv.com/training/hipaa.mp4");
  check("an https .mp4 link becomes a player", !!(mp4 && mp4.src), mp4);
  check("...pointing at the file itself, unchanged",
    mp4.src === "https://files.spectrumsquadlv.com/training/hipaa.mp4", mp4.src);
  check("...and carries the type, so the browser does not have to guess",
    mp4.type === "video/mp4", mp4.type);
  check("the extension is matched whatever its case",
    !!videoFile("https://x.test/a/B.MP4"), videoFile("https://x.test/a/B.MP4"));
  ["m4v", "webm", "ogv", "ogg"].forEach((e) => {
    check(`.${e} plays too`, !!videoFile(`https://x.test/a/v.${e}`), e);
  });
  check("webm is named as webm rather than shouted",
    (videoFile("https://x.test/a/v.webm") || {}).provider === "WebM video",
    (videoFile("https://x.test/a/v.webm") || {}).provider);

  section("A SIGNED LINK STILL PLAYS, WHICH IS HOW REAL FILE HOSTS HAND THEM OUT");
  // The extension has to be read from the PATH. Testing the whole address
  // would refuse every signed URL there is -- and signed URLs are exactly
  // what S3, R2, Drive and Dropbox give you for a private file.
  const signed = videoFile("https://bucket.s3.amazonaws.com/training/hipaa.mp4?X-Amz-Signature=abc123&X-Amz-Expires=600");
  check("a query string after the extension does not stop it playing", !!signed, signed);
  check("...and the query string is preserved, or the link would 403",
    signed && /X-Amz-Signature=abc123/.test(signed.src), signed && signed.src);

  section("WHAT MUST NOT BECOME A PLAYER");
  check("HTTP IS REFUSED, because the page is https and the player would sit there dead",
    videoFile("http://x.test/a/v.mp4") === null, videoFile("http://x.test/a/v.mp4"));
  ["mov", "avi", "mkv", "wmv", "flv"].forEach((e) => {
    check(`.${e} stays a link, because the browser cannot play it`,
      videoFile(`https://x.test/a/v.${e}`) === null, e);
  });
  check("an address that merely MENTIONS an mp4 in its query is not a video file",
    videoFile("https://x.test/watch?file=hipaa.mp4") === null,
    videoFile("https://x.test/watch?file=hipaa.mp4"));
  check("...nor is one that mentions it in a fragment",
    videoFile("https://x.test/watch#a.mp4") === null, videoFile("https://x.test/watch#a.mp4"));
  check("javascript: is refused", videoFile("javascript:alert(1)//a.mp4") === null);
  check("data: is refused", videoFile("data:video/mp4;base64,AAAA") === null);
  check("nothing at all is refused", videoFile("") === null && videoFile(null) === null);
  check("a YouTube page is not a file, and is left to the embed path",
    videoFile("https://www.youtube.com/watch?v=dQw4w9WgXcQ") === null);

  section("THE TWO PATHS DO NOT FIGHT OVER THE SAME VIDEO");
  check("a host we embed is NOT also offered as a file",
    /file: r\.kind === "video" && !videoEmbed\(r\.url\) \? videoFile\(r\.url\) : null/.test(src),
    "resourcesFor should only consult videoFile when there is no embed");
  check("an mp4 link gets no embed, so it cannot be framed",
    videoEmbed("https://files.spectrumsquadlv.com/training/hipaa.mp4") === null);

  section("THE PLAYER BRINGS A PLAY BUTTON AND A BAR WITH IT");
  const fe = require("fs").readFileSync(require("path").join(__dirname, "academy-frontend.js"), "utf8");
  check("the file player is a <video> element, not an iframe",
    /<video data-ac-vid=/.test(fe));
  check("...with the browser's own controls, which is the play icon",
    /controls preload="metadata" playsinline/.test(fe), "controls attribute");
  check("...and it is NOT sandboxed like an iframe, because a video element needs no sandbox",
    !/<video[^>]*sandbox/.test(fe));
  check("a watched-progress bar is drawn under it", /data-ac-bar=/.test(fe) && /ac-watch/.test(fe));
  check("the player is bound once, so a second render does not double-report",
    /\.__acBound/.test(fe));
  check("progress is reported on a throttle rather than every tick",
    /now - last < 10000/.test(fe), "a report per timeupdate would be several a second");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})();
