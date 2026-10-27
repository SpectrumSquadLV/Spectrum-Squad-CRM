// Two-step sign-in: a password, then a six-digit code from an authenticator
// app (Google Authenticator, Microsoft Authenticator, 1Password -- anything
// that speaks RFC 6238 TOTP).
//
// REQUIRED FOR EVERYBODY. The CRM holds children's health information and
// every role reaches some of it, or reaches staff records; a password alone
// is one leaked credential away from all of it. MFA_REQUIRED=0 turns off the
// FORCED enrolment (the test runner uses it, because 180 suites sign in with
// a password); somebody who has set MFA up is asked for a code regardless.
//
// HOW A SIGN-IN NOW RUNS
//   1. /api/auth/login checks the password. It no longer hands out a session
//      to anybody with MFA on (or required): it hands out a CHALLENGE -- a
//      random token good for a few minutes and a handful of guesses.
//   2a. Already set up: /api/auth/mfa/verify trades the challenge and a code
//       (or one recovery code) for the session.
//   2b. Not set up yet: /api/auth/mfa/setup returns a secret and its QR code;
//       /api/auth/mfa/setup/confirm proves the app was set up with it, turns
//       MFA on, returns ten recovery codes ONCE, and starts the session.
//
// THE SECRET IS ENCRYPTED AT REST when MFA_ENCRYPTION_KEY is set, so a copy
// of the database alone does not hand over everybody's second factor. Without
// that variable it is stored as-is and the server says so on boot. Challenge
// tokens and recovery codes are stored only as SHA-256 hashes, for the same
// reason the reset-password tokens are.
"use strict";

const crypto = require("crypto");

module.exports = function initMfa(ctx) {
  const { dbGet, dbRun, nowISO, readBody, json } = ctx;
  const ISSUER = "Spectrum Squad CRM";
  const STEP_SECONDS = 30;
  const DIGITS = 6;
  const MAX_ATTEMPTS = 5;
  const VERIFY_TTL_MS = 5 * 60 * 1000;
  // Long enough to find the app, install it and scan.
  const ENROLL_TTL_MS = 15 * 60 * 1000;
  const RECOVERY_CODES = 10;

  const required = () => !["0", "false", "off", "no"].includes(String(process.env.MFA_REQUIRED || "").trim().toLowerCase());

  // ---- base32, as every authenticator app expects the secret ------------
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function base32Encode(buf) {
    let bits = 0, value = 0, out = "";
    for (const byte of buf) {
      value = (value << 8) | byte; bits += 8;
      while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
  }
  function base32Decode(str) {
    const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
      value = (value << 5) | B32.indexOf(ch); bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
  }

  // ---- RFC 6238 ---------------------------------------------------------
  function codeAt(secretB32, step) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const h = crypto.createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
    const off = h[h.length - 1] & 15;
    const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    return String(n % 10 ** DIGITS).padStart(DIGITS, "0");
  }
  // One step either side, for a phone clock a few seconds out. Returns the
  // step that matched, so it can be recorded and never accepted twice.
  function matchStep(secretB32, code, lastStep, now = Date.now()) {
    const c = String(code || "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(c)) return null;
    const cur = Math.floor(now / 1000 / STEP_SECONDS);
    for (const s of [cur - 1, cur, cur + 1]) {
      if (lastStep != null && s <= Number(lastStep)) continue;
      const expect = codeAt(secretB32, s);
      if (crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(c))) return s;
    }
    return null;
  }

  // ---- the secret at rest ----------------------------------------------
  function keyBytes() {
    const raw = String(process.env.MFA_ENCRYPTION_KEY || "");
    return raw ? crypto.createHash("sha256").update(raw).digest() : null;
  }
  function sealSecret(secretB32) {
    const key = keyBytes();
    if (!key) return "plain:" + secretB32;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([c.update(secretB32, "utf8"), c.final()]);
    return "v1:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
  }
  function openSecret(stored) {
    const s = String(stored || "");
    if (s.startsWith("plain:")) return s.slice(6);
    if (!s.startsWith("v1:")) return null;
    const key = keyBytes();
    if (!key) throw new Error("MFA_ENCRYPTION_KEY is not set, so the stored MFA secrets cannot be read.");
    const b = Buffer.from(s.slice(3), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  }

  const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
  // Recovery codes: ten groups like "7KQ4-M2XD", stored hashed, case and
  // dash insensitive when typed back.
  const normRecovery = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  function newRecoveryCodes() {
    const out = [];
    for (let i = 0; i < RECOVERY_CODES; i++) {
      const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8);
      out.push(raw.slice(0, 4) + "-" + raw.slice(4));
    }
    return out;
  }

  async function initTables() {
    await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT");
    await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at TEXT");
    await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT");
    await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recovery_codes TEXT");
    await dbRun(`CREATE TABLE IF NOT EXISTS mfa_challenges (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      purpose TEXT NOT NULL,          -- verify | enroll
      pending_secret TEXT,            -- enroll only, sealed like the real one
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      expires_at TEXT NOT NULL
    )`);
    if (!keyBytes()) {
      console.warn("[mfa] MFA_ENCRYPTION_KEY is not set: authenticator secrets are stored unencrypted. " +
        "Add MFA_ENCRYPTION_KEY in Railway's variables (any long random string) before people enrol.");
    }
  }

  async function issueChallenge(userId, purpose) {
    const raw = crypto.randomBytes(32).toString("hex");
    const ttl = purpose === "enroll" ? ENROLL_TTL_MS : VERIFY_TTL_MS;
    // One live challenge per person: a new sign-in supersedes the last.
    await dbRun("DELETE FROM mfa_challenges WHERE user_id = ?", [userId]);
    await dbRun(
      "INSERT INTO mfa_challenges (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      [sha(raw), userId, purpose, nowISO(), new Date(Date.now() + ttl).toISOString()]
    );
    return raw;
  }

  async function loadChallenge(raw, purpose) {
    if (!/^[a-f0-9]{64}$/i.test(String(raw || ""))) return { error: "That sign-in has expired. Please sign in again." };
    const row = await dbGet("SELECT * FROM mfa_challenges WHERE token_hash = ?", [sha(raw)]);
    if (!row || row.purpose !== purpose) return { error: "That sign-in has expired. Please sign in again." };
    if (new Date(row.expires_at) < new Date()) {
      await dbRun("DELETE FROM mfa_challenges WHERE token_hash = ?", [row.token_hash]);
      return { error: "That sign-in has expired. Please sign in again." };
    }
    if (Number(row.attempts) >= MAX_ATTEMPTS) {
      await dbRun("DELETE FROM mfa_challenges WHERE token_hash = ?", [row.token_hash]);
      return { error: "Too many wrong codes. Please sign in again." };
    }
    const user = await dbGet("SELECT * FROM users WHERE id = ?", [row.user_id]);
    if (!user) return { error: "That sign-in has expired. Please sign in again." };
    return { row, user };
  }
  const spendAttempt = (row) => dbRun("UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?", [row.token_hash]);
  const finish = (row) => dbRun("DELETE FROM mfa_challenges WHERE token_hash = ?", [row.token_hash]);

  // Called by /api/auth/login once the password is right. Returns the body to
  // send instead of a session, or null when this person signs straight in.
  async function afterPassword(user) {
    if (user.mfa_enabled_at && user.mfa_secret) {
      return { mfa_required: true, challenge: await issueChallenge(user.id, "verify") };
    }
    if (required()) {
      return { mfa_setup_required: true, challenge: await issueChallenge(user.id, "enroll") };
    }
    return null;
  }

  // startSession(res, user) is the server's: it creates the session, sets the
  // cookie and returns the sanitised user.
  async function handleApi(req, res, pathname, method, user, { startSession, onFailure }) {
    if (pathname === "/api/auth/mfa/verify" && method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      const c = await loadChallenge(b.challenge, "verify");
      if (c.error) return json(res, 400, { error: c.error, restart: true }), true;
      const secret = openSecret(c.user.mfa_secret);
      const step = secret ? matchStep(secret, b.code, c.user.mfa_last_step) : null;
      if (step != null) {
        await dbRun("UPDATE users SET mfa_last_step = ? WHERE id = ?", [step, c.user.id]);
        await finish(c.row);
        return json(res, 200, { user: await startSession(res, c.user) }), true;
      }
      // Not a code from the app: perhaps one of the recovery codes.
      const typed = normRecovery(b.code);
      let codes = [];
      try { codes = JSON.parse(c.user.mfa_recovery_codes || "[]"); } catch (e) { codes = []; }
      const i = typed.length === 8 ? codes.indexOf(sha(typed)) : -1;
      if (i >= 0) {
        codes.splice(i, 1);
        await dbRun("UPDATE users SET mfa_recovery_codes = ? WHERE id = ?", [JSON.stringify(codes), c.user.id]);
        await finish(c.row);
        return json(res, 200, { user: await startSession(res, c.user), recovery_codes_left: codes.length }), true;
      }
      await spendAttempt(c.row);
      if (onFailure) onFailure(c.user);
      return json(res, 400, { error: "That code is not right. Check the app and try the newest code." }), true;
    }

    if (pathname === "/api/auth/mfa/setup" && method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      const c = await loadChallenge(b.challenge, "enroll");
      if (c.error) return json(res, 400, { error: c.error, restart: true }), true;
      const secret = base32Encode(crypto.randomBytes(20));
      await dbRun("UPDATE mfa_challenges SET pending_secret = ? WHERE token_hash = ?", [sealSecret(secret), c.row.token_hash]);
      const label = encodeURIComponent(ISSUER + ":" + c.user.email);
      const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
      let qr = "";
      try { qr = await require("qrcode").toString(uri, { type: "svg", margin: 1, width: 220 }); } catch (e) { qr = ""; }
      return json(res, 200, { secret, otpauth: uri, qr_svg: qr, email: c.user.email }), true;
    }

    if (pathname === "/api/auth/mfa/setup/confirm" && method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      const c = await loadChallenge(b.challenge, "enroll");
      if (c.error) return json(res, 400, { error: c.error, restart: true }), true;
      if (!c.row.pending_secret) return json(res, 400, { error: "Start the setup again." }), true;
      const secret = openSecret(c.row.pending_secret);
      const step = matchStep(secret, b.code, null);
      if (step == null) {
        await spendAttempt(c.row);
        if (onFailure) onFailure(c.user);
        return json(res, 400, { error: "That code is not right. Make sure you scanned this QR code, then type the newest code." }), true;
      }
      const recovery = newRecoveryCodes();
      await dbRun(
        `UPDATE users SET mfa_secret = ?, mfa_enabled_at = ?, mfa_last_step = ?, mfa_recovery_codes = ? WHERE id = ?`,
        [c.row.pending_secret, nowISO(), step, JSON.stringify(recovery.map((r) => sha(normRecovery(r)))), c.user.id]
      );
      await finish(c.row);
      return json(res, 200, { user: await startSession(res, c.user), recovery_codes: recovery }), true;
    }

    // RESETTING somebody's MFA -- a lost or replaced phone. Owner and super
    // admin only: it is the step that lets the next person to know the
    // password set up a new authenticator, so it is not an admin chore.
    const reset = pathname.match(/^\/api\/admin\/users\/(\d+)\/mfa-reset$/);
    if (reset && method === "POST") {
      if (!user || !["owner", "super_admin"].includes(user.role)) {
        return json(res, 403, { error: "Only the owner can reset somebody's two-step sign-in." }), true;
      }
      const id = Number(reset[1]);
      await dbRun(
        "UPDATE users SET mfa_secret = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL, mfa_recovery_codes = NULL WHERE id = ?",
        [id]
      );
      await dbRun("DELETE FROM mfa_challenges WHERE user_id = ?", [id]);
      // Whoever was signed in on the old phone's say-so is signed out.
      await dbRun("DELETE FROM sessions WHERE user_id = ?", [id]);
      return json(res, 200, { ok: true }), true;
    }

    return false;
  }

  return { initTables, afterPassword, handleApi, required, _test: { codeAt, base32Encode, matchStep } };
};
