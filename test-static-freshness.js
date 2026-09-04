// Does a deploy actually reach the people using the CRM?
//
//   DATABASE_URL=... node server.js
//   BASE=http://127.0.0.1:3009 node test-static-freshness.js
//
// index.html and every *-frontend.js bundle keep the SAME URL forever -- there
// is no hash in the filename and no version query on the script tags. So the
// only thing standing between a deploy and the person looking at the screen is
// what the response says about caching, and these responses used to say
// nothing at all: no Cache-Control, no ETag, no Last-Modified.
//
// "Nothing" is not "do not cache". It hands the decision to the browser, and
// browsers do not all decide the same way. The failure that produces is the
// worst-shaped one in this whole application:
//
//   * IT IS INVISIBLE FROM THIS END. The request never arrives, so there is
//     nothing in a log, nothing in a deploy record and nothing to reproduce.
//   * IT IS INVISIBLE FROM THE OTHER END TOO. Yesterday's application renders
//     perfectly. There is no error, no blank page and no stale marker -- it
//     simply does not have the change in it, which reads as the change never
//     having been made.
//   * IT AFFECTS ONE PERSON AT A TIME, so it arrives as "it works for me".
//
// This suite is therefore mostly about ONE assertion -- that when a file
// changes, the browser holding the old one is given the new one -- and about
// making sure the cheap version of that (revalidate every load) stays cheap.
"use strict";
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE || "http://localhost:3009";
let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else {
    fail++;
    const line = "  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 320) : "");
    failures.push(line);
    console.log(line);
  }
};

async function get(p, headers) {
  const res = await fetch(BASE + p, { headers: headers || {}, redirect: "manual" });
  const body = res.status === 304 ? "" : await res.text();
  return {
    status: res.status,
    etag: res.headers.get("etag"),
    cache: res.headers.get("cache-control"),
    modified: res.headers.get("last-modified"),
    type: res.headers.get("content-type"),
    body,
  };
}

// The allowlist in server.js is the list of things a browser is ever given.
// Reading it from the source rather than repeating it here means a bundle
// added next month is covered by this suite the day it is added.
function publicFiles() {
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const block = src.slice(src.indexOf("const PUBLIC_FILES = new Set(["));
  const list = block.slice(0, block.indexOf("]);"));
  return (list.match(/"\/[^"]+"/g) || []).map((s) => s.slice(1, -1));
}

(async () => {
  console.log("\n== The page itself ==");
  const index = await get("/");
  check("the app is served", index.status === 200, index.status);
  check("IT CARRIES AN ETAG, so the browser has something to ask about",
    !!index.etag, index.etag);
  check("and is told to check before reusing it",
    /no-cache|max-age=0|must-revalidate/.test(index.cache || ""), index.cache);
  check("IT IS NOT PINNED FOR A YEAR -- this file has no hash in its name, so a "
    + "long max-age is a deploy nobody receives",
    !/max-age=(?!0\b)\d{3,}/.test(index.cache || ""), index.cache);
  check("with a modified date as well, for anything that prefers one",
    !!index.modified, index.modified);
  check("/index.html answers the same as /", (await get("/index.html")).etag === index.etag);

  console.log("\n== Every bundle, not just the page ==");
  // A tagged index.html and an untagged bundle is the worst of both: the shell
  // updates and the code it loads does not, which is a version mismatch rather
  // than an old version.
  const files = publicFiles();
  check("the allowlist was read from the source", files.length > 10, files.length);
  const untagged = [], uncached = [];
  for (const f of files) {
    if (!fs.existsSync(path.join(__dirname, f))) continue; // not every entry ships
    const r = await get(f);
    if (r.status !== 200) continue;
    if (!r.etag) untagged.push(f);
    if (!/no-cache|max-age=0|must-revalidate/.test(r.cache || "")) uncached.push(f);
  }
  check("EVERY PUBLIC FILE CARRIES A TAG", untagged.length === 0, untagged);
  check("and every one of them revalidates", uncached.length === 0, uncached);

  console.log("\n== Revalidating has to be cheap, or it will be removed again ==");
  const again = await get("/", { "If-None-Match": index.etag });
  check("A BROWSER HOLDING THE CURRENT FILE IS TOLD SO", again.status === 304, again.status);
  check("AND IS NOT SENT THE FILE AGAIN -- a 304 with a body is not a saving",
    again.body === "", again.body.length);
  const bundle = "/bcba-dashboard-frontend.js";
  const b1 = await get(bundle);
  check("a bundle does the same", (await get(bundle, { "If-None-Match": b1.etag })).status === 304);

  console.log("\n== THE ONE THAT MATTERS: a changed file reaches them ==");
  // A deploy rewrites these files. Touching one reproduces exactly what the
  // browser sees on the morning after a release: it asks with the tag it has,
  // and the answer must not be "you are up to date".
  const target = path.join(__dirname, "theme.js");
  const original = fs.statSync(target);
  const oldTag = '"' + original.size.toString(16) + "-" + Math.floor(original.mtimeMs).toString(16) + '"';
  const before = await get("/theme.js");
  check("the tag a browser is holding is the one the file produces",
    before.etag === oldTag, { served: before.etag, computed: oldTag });
  try {
    // A deploy rewrites this file. Moving its timestamp is that, without
    // rewriting a source file a failed run would leave changed.
    const then = new Date(original.mtimeMs + 60000);
    fs.utimesSync(target, then, then);

    const after = await get("/theme.js");
    check("THE TAG CHANGES WHEN THE FILE DOES",
      !!after.etag && after.etag !== oldTag, { before: oldTag, after: after.etag });
    const fresh = await get("/theme.js", { "If-None-Match": oldTag });
    check("A BROWSER ASKING WITH YESTERDAY'S TAG IS NOT TOLD IT IS UP TO DATE",
      fresh.status === 200, fresh.status);
    check("it is given the file, in full", fresh.body.length > 0, fresh.body.length);
    check("and a new tag to ask with next time", fresh.etag === after.etag,
      { fresh: fresh.etag, after: after.etag });
  } finally {
    fs.utimesSync(target, original.atime, original.mtime);
  }

  console.log("\n== What did not change ==");
  const spa = await get("/dashboard");
  check("a deep link still serves the app rather than 404", spa.status === 200, spa.status);
  check("and that copy is tagged too, since it is the one most people get",
    !!spa.etag, spa.etag);
  check("it really is html", /text\/html/.test(spa.type || ""), spa.type);
  const hidden = await get("/server.js");
  check("A FILE THAT IS NOT ON THE ALLOWLIST IS STILL REFUSED",
    hidden.status === 404, hidden.status);
  check("and nothing of it came back", !/PUBLIC_FILES/.test(hidden.body), hidden.body.slice(0, 120));
  const secret = await get("/package.json");
  check("nor package.json", secret.status === 404, secret.status);

  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
