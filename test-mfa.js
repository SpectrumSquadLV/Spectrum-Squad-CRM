// Two-step sign-in: a password, then a code from an authenticator app.
//
// ASKED FOR AS: "can we set up MFA on the CRM?" -- authenticator app,
// required for everybody, after a hosting-provider incident put the
// environment's credentials in doubt. The CRM holds children's health
// information; a password alone was all that stood in front of it.
//
// This suite runs with MFA_REQUIRED=1 (run-tests.js), as production does.
//
//   DATABASE_URL=... node run-tests.js test-mfa.js
"use strict";

const crypto = require("crypto");
const { chromium } = require("playwright");
const { Client } = require("pg");

const BASE = process.env.BASE || "http://localhost:3009";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    console.log("  FAIL  " + name + (detail !== undefined
      ? "\n          -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : ""));
  }
};
const section = (t) => console.log("\n== " + t + " ==");

// An authenticator app, written out independently of mfa.js so the suite
// checks the server against RFC 6238 rather than against itself.
function b32decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0; const out = [];
  for (const ch of s.replace(/\s+/g, "").toUpperCase()) {
    val = (val << 5) | A.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, offsetSteps = 0) {
  const step = Math.floor(Date.now() / 1000 / 30) + offsetSteps;
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}

function client() {
  let jar = "";
  const call = async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(jar ? { Cookie: jar } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (setC && setC.length) jar = setC.map((c) => c.split(";")[0]).join("; ");
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    return { status: r.status, body, cookie: setC.join(";") };
  };
  call.jar = () => jar;
  return call;
}

// Signs somebody all the way in, enrolling them if they are not yet. Returns
// the client and the secret their "app" holds.
async function enrol(email, password) {
  const c = client();
  const r = await c("/api/auth/login", { method: "POST", body: { email, password } });
  if (!r.body || !r.body.mfa_setup_required) throw new Error("expected setup for " + email + ": " + JSON.stringify(r.body));
  const s = await c("/api/auth/mfa/setup", { method: "POST", body: { challenge: r.body.challenge } });
  const ok = await c("/api/auth/mfa/setup/confirm", { method: "POST", body: { challenge: r.body.challenge, code: totp(s.body.secret) } });
  if (ok.status !== 200) throw new Error("enrol failed for " + email + ": " + JSON.stringify(ok.body));
  return { c, secret: s.body.secret, recovery: ok.body.recovery_codes };
}

(async () => {
  const OWNER = ["admin@spectrumsquadlv.com", "TestOwner123!"];
  const CLIN = ["clinical@spectrumsquadlv.com", "TestStaff123!"];

  section("A right password is no longer enough on its own");
  const c = client();
  let challenge, secret;
  {
    const bad = await c("/api/auth/login", { method: "POST", body: { email: OWNER[0], password: "wrong-password" } });
    check("a wrong password is still refused, with no challenge", bad.status === 401 && !(bad.body && bad.body.challenge), bad);

    const r = await c("/api/auth/login", { method: "POST", body: { email: OWNER[0], password: OWNER[1] } });
    check("a right password asks somebody new to set up two-step sign-in", r.status === 200 && r.body.mfa_setup_required === true && /^[a-f0-9]{64}$/.test(r.body.challenge), r.body);
    check("...and hands out NO session", !/session=/.test(r.cookie) && !r.body.user, r);
    const me = await c("/api/auth/me");
    check("so nothing is reachable yet", !me.body || !me.body.user, me.body);
    challenge = r.body.challenge;
  }

  section("Setting it up");
  {
    const s = await c("/api/auth/mfa/setup", { method: "POST", body: { challenge } });
    secret = s.body && s.body.secret;
    check("setup returns a secret", s.status === 200 && /^[A-Z2-7]{32}$/.test(secret || ""), s.body);
    check("...an otpauth link an app understands", /^otpauth:\/\/totp\/.+secret=[A-Z2-7]+&issuer=/.test(s.body.otpauth || ""), s.body.otpauth);
    check("...and a QR code to scan", /<svg/.test(s.body.qr_svg || ""));

    const wrong = await c("/api/auth/mfa/setup/confirm", { method: "POST", body: { challenge, code: "000000" } });
    check("a wrong code does not turn it on", wrong.status === 400 && !(wrong.body && wrong.body.user), wrong.body);

    const ok = await c("/api/auth/mfa/setup/confirm", { method: "POST", body: { challenge, code: totp(secret) } });
    check("the app's code turns it on and signs her in", ok.status === 200 && ok.body.user && ok.body.user.email === OWNER[0], ok.body);
    check("ten recovery codes are shown, once", Array.isArray(ok.body.recovery_codes) && ok.body.recovery_codes.length === 10, ok.body.recovery_codes);
    globalThis.recovery = ok.body.recovery_codes;

    const me = await c("/api/auth/me");
    check("the session works", me.body && me.body.user && me.body.user.email === OWNER[0]);
    check("the secret and recovery codes never leave the server",
      me.body && me.body.user && !("mfa_secret" in me.body.user) && !("mfa_recovery_codes" in me.body.user) && !("mfa_last_step" in me.body.user),
      Object.keys((me.body && me.body.user) || {}));

    const again = await c("/api/auth/mfa/setup/confirm", { method: "POST", body: { challenge, code: totp(secret) } });
    check("the challenge cannot be used twice", again.status === 400, again.body);
  }

  section("At rest");
  {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const row = (await db.query("SELECT mfa_secret, mfa_recovery_codes FROM users WHERE email = $1", [OWNER[0]])).rows[0];
    check("the secret is stored encrypted, not as the key itself", row && /^v1:/.test(row.mfa_secret) && !row.mfa_secret.includes(secret), row && row.mfa_secret);
    check("recovery codes are stored hashed", row && !globalThis.recovery.some((r) => row.mfa_recovery_codes.includes(r.replace("-", ""))));
    const ch = (await db.query("SELECT token_hash FROM mfa_challenges")).rows;
    check("challenge tokens are stored hashed", !ch.some((x) => x.token_hash === challenge));
    await db.end();
  }

  section("Signing in again");
  {
    const d = client();
    const r = await d("/api/auth/login", { method: "POST", body: { email: OWNER[0], password: OWNER[1] } });
    check("next time it asks for a code", r.status === 200 && r.body.mfa_required === true && !r.body.user, r.body);
    const replay = await d("/api/auth/mfa/verify", { method: "POST", body: { challenge: r.body.challenge, code: totp(secret) } });
    check("the code already used to set up cannot be replayed", replay.status === 400, replay.body);
    const ok = await d("/api/auth/mfa/verify", { method: "POST", body: { challenge: r.body.challenge, code: totp(secret, 1) } });
    check("a fresh code signs her in", ok.status === 200 && ok.body.user && ok.body.user.email === OWNER[0], ok.body);
  }

  section("A recovery code, once");
  {
    const code = globalThis.recovery[0];
    const d = client();
    let r = await d("/api/auth/login", { method: "POST", body: { email: OWNER[0], password: OWNER[1] } });
    const ok = await d("/api/auth/mfa/verify", { method: "POST", body: { challenge: r.body.challenge, code: code.toLowerCase() } });
    check("a recovery code signs her in (any case)", ok.status === 200 && ok.body.user, ok.body);
    check("...and says how many are left", ok.body && ok.body.recovery_codes_left === 9, ok.body);
    const e = client();
    r = await e("/api/auth/login", { method: "POST", body: { email: OWNER[0], password: OWNER[1] } });
    const twice = await e("/api/auth/mfa/verify", { method: "POST", body: { challenge: r.body.challenge, code } });
    check("the same recovery code does not work twice", twice.status === 400, twice.body);
  }

  section("Guessing");
  {
    const d = client();
    const r = await d("/api/auth/login", { method: "POST", body: { email: OWNER[0], password: OWNER[1] } });
    let last;
    for (let i = 0; i < 6; i++) last = await d("/api/auth/mfa/verify", { method: "POST", body: { challenge: r.body.challenge, code: "111111" } });
    const late = await d("/api/auth/mfa/verify", { method: "POST", body: { challenge: r.body.challenge, code: totp(secret, 1) } });
    check("after five wrong codes the challenge is dead, even for the right code", late.status === 400 && late.body.restart === true, late.body);
  }

  section("A lost phone: the owner resets it");
  {
    const clin = await enrol(CLIN[0], CLIN[1]);
    check("a second person can set it up too", !!clin.secret);
    const owner = client();
    const r = await owner("/api/auth/login", { method: "POST", body: { email: OWNER[0], password: OWNER[1] } });
    // Wait out the step the earlier sign-ins used.
    await owner("/api/auth/mfa/verify", { method: "POST", body: { challenge: r.body.challenge, code: totp(secret, 1) } })
      .then(async (x) => { if (x.status !== 200) { await new Promise((ok) => setTimeout(ok, 31000)); const r2 = await owner("/api/auth/login", { method: "POST", body: { email: OWNER[0], password: OWNER[1] } }); await owner("/api/auth/mfa/verify", { method: "POST", body: { challenge: r2.body.challenge, code: totp(secret, 1) } }); } });
    const users = await owner("/api/admin/users");
    const rows = Array.isArray(users.body) ? users.body : (users.body && (users.body.users || users.body.data)) || [];
    const her = rows.find((u) => u.email === CLIN[0]);
    check("the user list shows who has it on", her && her.mfa_enabled === true, her);

    const byHer = await clin.c("/api/admin/users/" + her.id + "/mfa-reset", { method: "POST", body: {} });
    check("somebody who is not the owner cannot reset it", byHer.status === 403, byHer.body);

    const reset = await owner("/api/admin/users/" + her.id + "/mfa-reset", { method: "POST", body: {} });
    check("the owner can", reset.status === 200, reset.body);
    const gone = await clin.c("/api/auth/me");
    check("...which signs her out", !gone.body || !gone.body.user, gone.body);
    const fresh = client();
    const again = await fresh("/api/auth/login", { method: "POST", body: { email: CLIN[0], password: CLIN[1] } });
    check("...and she sets it up again with her new phone", again.body && again.body.mfa_setup_required === true, again.body);
  }

  section("In the browser");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE + "/", { waitUntil: "networkidle" });
    await p.fill('#login-form input[name="email"]', CLIN[0]);
    await p.fill('#login-form input[name="password"]', CLIN[1]);
    await p.click('#login-form button[type="submit"]');
    await p.waitForSelector("#mfa-secret", { timeout: 10000 }).catch(() => {});
    check("the setup screen shows a QR code", (await p.locator(".login-card svg").count()) > 0);
    const shown = (await p.locator("#mfa-secret").innerText().catch(() => "")).replace(/\s+/g, "");
    check("...and the key for typing in by hand", /^[A-Z2-7]{32}$/.test(shown), shown);
    await p.fill('#mfa-form input[name="code"]', totp(shown));
    await p.click('#mfa-form button[type="submit"]');
    await p.waitForSelector("#mfa-recovery", { timeout: 10000 }).catch(() => {});
    const codes = await p.locator("#mfa-recovery").innerText().catch(() => "");
    check("the recovery codes are shown", codes.trim().split(/\s+/).length === 10, codes);
    check("Continue waits until she says she saved them", await p.locator("#mfa-continue").isDisabled());
    await p.check("#mfa-saved");
    await p.click("#mfa-continue");
    await p.waitForTimeout(2000);
    check("she is in the CRM", (await p.locator("#view-mount").count()) === 1 && (await p.locator("#login-form").count()) === 0);

    // And the everyday screen.
    const ctx2 = await browser.newContext();
    const q = await ctx2.newPage();
    q.on("pageerror", (e) => errors.push(e.message));
    await q.goto(BASE + "/", { waitUntil: "networkidle" });
    await q.fill('#login-form input[name="email"]', CLIN[0]);
    await q.fill('#login-form input[name="password"]', CLIN[1]);
    await q.click('#login-form button[type="submit"]');
    await q.waitForSelector("#mfa-form", { timeout: 10000 }).catch(() => {});
    check("next time she is asked for a code", /sign-in code/i.test(await q.locator(".login-card").innerText().catch(() => "")));
    await q.fill('#mfa-form input[name="code"]', "000000");
    await q.click('#mfa-form button[type="submit"]');
    await q.waitForTimeout(800);
    check("a wrong code says so", /not right/i.test(await q.locator("#login-error").innerText().catch(() => "")));
    await q.fill('#mfa-form input[name="code"]', totp(shown, 1));
    await q.click('#mfa-form button[type="submit"]');
    await q.waitForTimeout(2000);
    check("the right code lets her in", (await q.locator("#view-mount").count()) === 1);
    check("no uncaught errors", errors.length === 0, errors);
  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
