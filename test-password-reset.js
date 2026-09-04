// Forgotten password: the emailed reset link.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-password-reset.js
//
// The interesting assertions here are not "a password can be changed". They
// are the four ways a reset flow leaks something:
//
//   1. TELLING AN ANONYMOUS CALLER WHETHER AN ADDRESS HAS AN ACCOUNT. These are
//      staff addresses at a named practice, so that is worth protecting, and it
//      is given away by a different message, a different status, or nothing at
//      all in the response but a row in a table.
//   2. STORING THE LINK. The raw token in the database, or in the Message
//      Outbox that every admin can read, is a working key to somebody else's
//      account -- an admin could take over the owner's login without ever
//      knowing the password.
//   3. LETTING A LINK BE USED TWICE, after it expires, or after a newer one
//      replaced it.
//   4. LEAVING OLD SESSIONS ALIVE. Somebody resetting a password may be doing
//      it because they think another person is in their account.
//
// Every one of those passes a naive implementation and a manual test.
"use strict";
const { Pool } = require("pg");
const crypto = require("crypto");

const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;

function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 300) : "")); }
}

function client() {
  let jar = "";
  return async (path, { method = "GET", body } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(jar ? { Cookie: jar } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) jar = sc.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data, jar };
  };
}

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// The raw token never leaves the server, so a test has to reconstruct the row
// the way the server would find it -- which is itself the point being made.
async function rowsFor(email) {
  return (await pool.query(
    `SELECT t.* FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
      WHERE lower(u.email) = lower($1) ORDER BY t.id DESC`, [email]
  )).rows;
}

// Ask for a link, then mint one directly so the test holds a raw token the
// server considers real. The route's own token is never readable by anything
// but the mailbox, which is the property under test -- so the flow-level checks
// use a token inserted here with the same hashing rule the server uses.
async function issueToken(email, { ttlMs = 3600 * 1000, used = false } = {}) {
  const u = (await pool.query("SELECT id FROM users WHERE lower(email) = lower($1)", [email])).rows[0];
  const raw = crypto.randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, created_at, expires_at, used_at, requested_email)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [u.id, sha256(raw), now, new Date(Date.now() + ttlMs).toISOString(), used ? now : null, email]
  );
  return raw;
}

const EMAIL = "scheduling@spectrumsquadlv.com";
const ORIGINAL = "TestOwner123!";

(async () => {
  const anon = client();

  console.log("\n== The endpoint is reachable without signing in ==");
  let r = await anon("/api/auth/forgot-password", { method: "POST", body: { email: EMAIL } });
  check("a signed-out caller can ask for a link (not 401)", r.status === 200, r);
  const knownBody = JSON.stringify(r.data);

  console.log("\n== It does not say who works here ==");
  const unknown = await anon("/api/auth/forgot-password", {
    method: "POST", body: { email: "definitely-nobody@example.invalid" },
  });
  check("an unknown address gets 200 as well", unknown.status === 200, unknown);
  check("AND THE EXACT SAME BODY, so the answer carries no signal",
    JSON.stringify(unknown.data) === knownBody, { known: knownBody, unknown: JSON.stringify(unknown.data) });
  check("the message does not name the address or the account",
    !/nobody|not found|no account|does not exist/i.test(JSON.stringify(unknown.data)), unknown.data);

  const junk = await anon("/api/auth/forgot-password", { method: "POST", body: { email: "not-an-email" } });
  check("a malformed address gets the same answer too",
    junk.status === 200 && JSON.stringify(junk.data) === knownBody, junk);

  check("NOTHING WAS WRITTEN for the unknown address", (await rowsFor("definitely-nobody@example.invalid")).length === 0);
  const issued = await rowsFor(EMAIL);
  check("but a real request did create a token row", issued.length >= 1, issued.length);

  console.log("\n== The link itself is never stored ==");
  const row = issued[0];
  check("the row holds a 64-character hash, not a URL",
    /^[a-f0-9]{64}$/.test(String(row.token_hash || "")), row.token_hash);
  const allCols = JSON.stringify(row);
  check("no column on the row contains a link", !/https?:\/\//.test(allCols), allCols.slice(0, 200));
  check("the request is attributed (address + ip) for the record",
    !!row.requested_email && !!row.requested_ip, { e: row.requested_email, ip: row.requested_ip });
  check("and it expires within the hour",
    new Date(row.expires_at) - new Date(row.created_at) <= 3600 * 1000 + 5000,
    { created: row.created_at, expires: row.expires_at });

  // The Message Outbox renders notifications_log to every admin.
  let logged = null;
  for (let i = 0; i < 40 && !logged; i++) {
    logged = (await pool.query(
      "SELECT * FROM notifications_log WHERE type = 'password_reset' AND recipient = $1 ORDER BY id DESC LIMIT 1", [EMAIL]
    )).rows[0] || null;
    if (!logged) await new Promise((s) => setTimeout(s, 100));
  }
  check("the send is recorded, so nobody wonders why they got an email", !!logged, logged);
  if (logged) {
    check("THE OUTBOX COPY CARRIES NO TOKEN -- an admin cannot read it and take the account",
      !/[a-f0-9]{64}/i.test(String(logged.body || "")), String(logged.body || "").slice(0, 200));
    check("and no reset link either",
      !/reset-password\?token=/.test(String(logged.body || "")), String(logged.body || "").slice(0, 200));
  }

  console.log("\n== Checking a link does not spend it ==");
  const raw = await issueToken(EMAIL);
  const peek1 = await anon("/api/auth/reset-password/check", { method: "POST", body: { token: raw } });
  check("a valid link reports itself valid", peek1.data && peek1.data.valid === true, peek1.data);
  check("with a masked address, so you know which account it is",
    /^\w{2}\*+@/.test(String(peek1.data.email_hint || "")), peek1.data.email_hint);
  check("THE FULL ADDRESS IS NOT RETURNED", String(peek1.data.email_hint || "") !== EMAIL, peek1.data.email_hint);
  const peek2 = await anon("/api/auth/reset-password/check", { method: "POST", body: { token: raw } });
  check("checking twice is still valid -- a peek is not a use", peek2.data.valid === true, peek2.data);

  console.log("\n== Bad links ==");
  const nonsense = await anon("/api/auth/reset-password/check", { method: "POST", body: { token: "not-a-real-token" } });
  check("a made-up token is refused", nonsense.data.valid === false, nonsense.data);
  const expired = await issueToken(EMAIL, { ttlMs: -1000 });
  const expiredPeek = await anon("/api/auth/reset-password/check", { method: "POST", body: { token: expired } });
  check("an expired token is refused, and says so", expiredPeek.data.valid === false && expiredPeek.data.reason === "expired", expiredPeek.data);
  const spent = await issueToken(EMAIL, { used: true });
  const spentPeek = await anon("/api/auth/reset-password/check", { method: "POST", body: { token: spent } });
  check("an already-used token is refused, and says so", spentPeek.data.valid === false && spentPeek.data.reason === "used", spentPeek.data);

  const tooShort = await anon("/api/auth/reset-password", { method: "POST", body: { token: raw, password: "short" } });
  check("a password under 8 characters is refused", tooShort.status === 400, tooShort);
  check("and it is refused WITHOUT spending the link",
    (await anon("/api/auth/reset-password/check", { method: "POST", body: { token: raw } })).data.valid === true);

  const expiredPost = await anon("/api/auth/reset-password", { method: "POST", body: { token: expired, password: "BrandNewPass123!" } });
  check("an expired link cannot set a password", expiredPost.status === 400, expiredPost);

  console.log("\n== Asking twice invalidates the first link ==");
  const first = await issueToken(EMAIL);
  const second = await issueToken(EMAIL);
  await anon("/api/auth/forgot-password", { method: "POST", body: { email: EMAIL } });
  // The route invalidates outstanding links before issuing its own.
  const firstPeek = await anon("/api/auth/reset-password/check", { method: "POST", body: { token: first } });
  const secondPeek = await anon("/api/auth/reset-password/check", { method: "POST", body: { token: second } });
  check("AN OLDER LINK STOPS WORKING once a newer one is sent",
    firstPeek.data.valid === false && firstPeek.data.reason === "superseded", firstPeek.data);
  check("and so does the one before it", secondPeek.data.valid === false, secondPeek.data);

  console.log("\n== Actually resetting ==");
  // Sign in first, so there is a live session to be ended by the reset.
  const victim = client();
  const signedIn = await victim("/api/auth/login", { method: "POST", body: { email: EMAIL, password: ORIGINAL } });
  check("the account signs in with its current password", signedIn.status === 200, signedIn.data);
  check("and that session works", (await victim("/api/auth/me")).status === 200);

  const good = await issueToken(EMAIL);
  const NEWPASS = "ResetByTest!2026";
  const done = await anon("/api/auth/reset-password", { method: "POST", body: { token: good, password: NEWPASS } });
  check("the reset succeeds", done.status === 200, done.data);

  const after = client();
  check("THE NEW PASSWORD WORKS",
    (await after("/api/auth/login", { method: "POST", body: { email: EMAIL, password: NEWPASS } })).status === 200);
  const oldTry = client();
  check("and the old one no longer does",
    (await oldTry("/api/auth/login", { method: "POST", body: { email: EMAIL, password: ORIGINAL } })).status === 401);

  check("EVERY SESSION THAT ACCOUNT HAD WAS ENDED",
    (await victim("/api/auth/me")).status === 401, "the pre-reset session still works");

  const reuse = await anon("/api/auth/reset-password", { method: "POST", body: { token: good, password: "AnotherOne!99" } });
  check("THE LINK CANNOT BE USED A SECOND TIME", reuse.status === 400, reuse);
  check("and the second attempt did not change anything",
    (await client()("/api/auth/login", { method: "POST", body: { email: EMAIL, password: NEWPASS } })).status === 200);

  console.log("\n== The record is kept ==");
  const kept = await rowsFor(EMAIL);
  check("used and superseded rows are still there, not deleted", kept.length >= 5, kept.length);
  check("the used one is marked used rather than removed",
    kept.some((t) => t.used_at), kept.map((t) => ({ used: !!t.used_at, inv: !!t.invalidated_at })));

  console.log("\n== Requesting is rate limited ==");
  // The endpoint sends mail, so an unlimited one buries an inbox. Counted per
  // address as well as per IP; this address has already spent several.
  const spam = "ratelimit-probe@example.invalid";
  let sawLimit = false;
  for (let i = 0; i < 8; i++) {
    const rr = await anon("/api/auth/forgot-password", { method: "POST", body: { email: spam } });
    if (rr.status === 429) { sawLimit = true; break; }
  }
  check("repeated requests are eventually throttled", sawLimit, "no 429 in 8 attempts");

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
