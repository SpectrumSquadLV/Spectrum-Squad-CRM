// Runs the test-*.js suites, each against its own database and its own server.
//
//   node run-tests.js                  # every suite except the skips below
//   node run-tests.js test-people.js   # just these
//   node run-tests.js --all            # include the skipped suites too
//
// Most suites sign in over HTTP and read and write real rows, so they cannot
// share a database: test-people and test-people-ui both claim the same
// department name, and test-people changes the scheduling account's password
// out from under anything that runs after it. A fresh database per suite costs
// about a second and removes the whole class of problem, along with any
// dependence on the order they run in.
//
// Needs DATABASE_URL pointing at a Postgres the runner may create databases on.
"use strict";
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const { Client } = require("pg");
const net = require("net");

const PORT = Number(process.env.PORT || 3011);
const BASE = `http://127.0.0.1:${PORT}`;
const SUITE_TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS || 180000);
const BOOT_TIMEOUT_MS = 60000;

// Suites that cannot pass on a bare checkout, skipped by default and run with
// --all. Empty, and worth keeping that way: a suite nobody runs is a suite
// nobody trusts.
const SKIP = {};

// Extra environment for the suite that verifies a signed third-party webhook.
// A dummy value, not a credential -- the suite signs its own payloads with the
// same string and checks the server rejects anything else. Note what is
// deliberately absent: no STRIPE_SECRET_KEY, so nothing reaches Stripe.
const SUITE_ENV = {
  "test-phase6b-stripe.js": { STRIPE_WEBHOOK_SECRET: "whsec_test" },
};

// The server seeds every account with a random unusable password on a fresh
// install, by design -- nothing is ever written to the deploy log. The suites
// sign in as these accounts, so the runner sets the passwords they expect.
const TEST_LOGINS = [
  ["admin@spectrumsquadlv.com", "TestOwner123!"],
  ["clinical@spectrumsquadlv.com", "TestStaff123!"],
  ["scheduling@spectrumsquadlv.com", "TestOwner123!"],
  ["intake@spectrumsquadlv.com", "TestStaff123!"],
  ["billing@spectrumsquadlv.com", "TestStaff123!"],
];

function adminUrl(dbName) {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = "/" + dbName;
  return u.toString();
}

async function withAdmin(fn) {
  const c = new Client({ connectionString: adminUrl("postgres"), ssl: false });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function createDb(name) {
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}"`);
    await c.query(`CREATE DATABASE "${name}"`);
  });
}

async function dropDb(name) {
  try {
    await withAdmin(async (c) => {
      await c.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name]
      );
      await c.query(`DROP DATABASE IF EXISTS "${name}"`);
    });
  } catch (e) {
    // A leaked database is untidy but not a test failure; CI throws the whole
    // container away anyway.
    console.error(`  (could not drop ${name}: ${e.message})`);
  }
}

// Matches createUser() in server.js: scrypt, 64 bytes, hex, with a hex salt.
async function seedTestLogins(c) {
  for (const [email, password] of TEST_LOGINS) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    await c.query("UPDATE users SET password_hash = $1, password_salt = $2 WHERE email = $3", [hash, salt, email]);
  }
}

// The app's own seed fills in departments, therapists and demo clients, but not
// the staff directory -- a real install builds that from hiring. Several UI
// suites need somebody in it: the supervision log needs an employee to hang a
// session off, the Staff page needs a row to open, and the attendance roster
// needs a second person with a clean record for "Good standing" to appear
// beside the one the suite puts on an improvement plan.
async function seedStaffDirectory(c) {
  const rows = [
    ["Ada Reyes", "ada.reyes@spectrumsquadlv.com", "BCBA", "full_time", "2024-03-04"],
    ["Ben Okafor", "ben.okafor@spectrumsquadlv.com", "RBT", "full_time", "2024-07-15"],
  ];
  for (const [name, email, roleTitle, employmentType, hireDate] of rows) {
    await c.query(
      `INSERT INTO hr_employees (name, email, role_title, employment_type, hire_date, status, created_at)
       SELECT $1, $2, $3, $4, $5, 'active', now()::text
       WHERE NOT EXISTS (SELECT 1 FROM hr_employees WHERE lower(email) = lower($2))`,
      [name, email, roleTitle, employmentType, hireDate]
    );
  }
}

// Only for the suite that needs it. test-people builds its own certifications
// and then asserts exactly which ones the expiry roll-up and the reminder sweep
// pick up, so an extra one seeded for everybody makes that suite wrong -- it
// counts three where it wrote two. Dated relative to the run: a fixed date
// would quietly stop expiring and take the banner with it.
async function seedExpiringCertification(c) {
  await c.query(
    `INSERT INTO staff_certifications (employee_id, name, issuing_body, credential_number, issued_date, expiration_date, status, created_at)
     SELECT e.id, 'RBT', 'BACB', 'RBT-100244', (now() - interval '700 days')::date::text, (now() + interval '30 days')::date::text, 'active', now()::text
       FROM hr_employees e
      WHERE lower(e.email) = 'ben.okafor@spectrumsquadlv.com'
        AND NOT EXISTS (SELECT 1 FROM staff_certifications WHERE employee_id = e.id)`
  );
}

// suite -> extra fixture, for data one suite needs and another would trip over.
const SUITE_FIXTURES = {
  "test-people-ui.js": seedExpiringCertification, // its Staff page asserts the banner renders
};

// Settings a suite needs switched on before it can prove anything. The
// completion digest refuses to send with no recipient configured, which is
// correct behaviour and exactly what the suite is not testing.
async function seedAppSettings(c) {
  const settings = [["completion_digest_recipients", "digest@spectrumsquadlv.com"]];
  for (const [key, value] of settings) {
    await c.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now()::text)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }
}

async function seedFixtures(dbUrl, suite) {
  const c = new Client({ connectionString: dbUrl, ssl: false });
  await c.connect();
  try {
    await seedTestLogins(c);
    await seedStaffDirectory(c);
    await seedAppSettings(c);
    if (SUITE_FIXTURES[suite]) await SUITE_FIXTURES[suite](c);
  } finally {
    await c.end();
  }
}

function startServer(dbUrl, logPath, extraEnv) {
  const log = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      PORT: String(PORT),
      // Keep the suites off the network and out of anyone's inbox. Without
      // credentials the app simulates email and SMS, which is what the suites
      // assert against.
      NODE_ENV: "test",
      APP_BASE_URL: BASE,
      ...extraEnv,
    },
    stdio: ["ignore", log, log],
  });
  child.on("exit", () => { try { fs.closeSync(log); } catch (e) {} });
  return child;
}

async function waitForServer(child, logPath) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited during boot (code ${child.exitCode})\n${tail(logPath, 20)}`);
    }
    try {
      const r = await fetch(BASE + "/", { signal: AbortSignal.timeout(2000) });
      if (r.status) return;
    } catch (e) {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up within ${BOOT_TIMEOUT_MS}ms\n${tail(logPath, 20)}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const ended = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 5000);
  await ended;
  clearTimeout(forced);
}

function tail(path, lines) {
  try {
    return fs.readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch (e) {
    return "(no output)";
  }
}

function runSuite(suite, dbUrl, outPath, extraEnv) {
  return new Promise((resolve) => {
    const out = fs.openSync(outPath, "w");
    const child = spawn(process.execPath, [suite], {
      env: { ...process.env, DATABASE_URL: dbUrl, BASE, APP_BASE_URL: BASE, ...extraEnv },
      stdio: ["ignore", out, out],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 124, timedOut: true });
    }, SUITE_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch (e) {}
      resolve({ code: code === null ? 1 : code, timedOut: false });
    });
  });
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }

  const args = process.argv.slice(2);
  const includeSkipped = args.includes("--all");
  const named = args.filter((a) => !a.startsWith("--"));
  const suites = (named.length ? named : fs.readdirSync(".").filter((f) => /^test-.*\.js$/.test(f)).sort())
    .filter((s) => (named.length || includeSkipped ? true : !SKIP[s]));

  if (!named.length && !includeSkipped) {
    for (const [s, why] of Object.entries(SKIP)) console.log(`SKIP  ${s}  -- ${why}`);
    if (Object.keys(SKIP).length) console.log("");
  }

  // Is something already on our port? Two runs at once produce a whole suite of
  // phantom failures -- every request lands on the other run's server, against
  // the other run's database -- and they look exactly like real breakage. It
  // has cost real debugging time more than once, so it is refused up front.
  await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.error(
          `\nPort ${PORT} is already in use.\n\n`
          + `Something else -- most likely another run-tests.js, or a server left\n`
          + `running -- is on it. Every suite would talk to that instead of its own\n`
          + `server and fail for reasons that have nothing to do with the code.\n\n`
          + `Stop it first, or set PORT to something else.\n`
        );
        process.exit(2);
      }
      resolve();
    });
    probe.once("listening", () => probe.close(resolve));
    probe.listen(PORT, "127.0.0.1");
  });

  fs.mkdirSync("test-logs", { recursive: true });
  const results = [];

  for (let i = 0; i < suites.length; i++) {
    const suite = suites[i];
    const db = `crmtest_${process.pid}_${i}`;
    const dbUrl = adminUrl(db);
    const serverLog = `test-logs/${suite}.server.log`;
    const suiteLog = `test-logs/${suite}.log`;
    const started = Date.now();
    process.stdout.write(`[${String(i + 1).padStart(2)}/${suites.length}] ${suite.padEnd(34)}`);

    let server = null;
    let result = { code: 1, timedOut: false };
    try {
      await createDb(db);
      server = startServer(dbUrl, serverLog, SUITE_ENV[suite] || {});
      await waitForServer(server, serverLog);
      await seedFixtures(dbUrl, suite);
      result = await runSuite(suite, dbUrl, suiteLog, SUITE_ENV[suite] || {});
    } catch (e) {
      fs.writeFileSync(suiteLog, String(e.stack || e));
      result = { code: 1, timedOut: false, bootError: String(e.message || e) };
    } finally {
      if (server) await stopServer(server);
      await dropDb(db);
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const counts = (tail(suiteLog, 40).match(/(\d+) passed, (\d+) failed/) || [])[0] || "";
    const ok = result.code === 0;
    results.push({ suite, ok, ...result, counts });
    console.log(`${ok ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL"}  ${secs}s  ${counts}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} suites passed\n`);
  for (const f of failed) {
    console.log(`--- ${f.suite} ---`);
    if (f.bootError) console.log(f.bootError);
    console.log(tail(`test-logs/${f.suite}.log`, 25));
    const srv = tail(`test-logs/${f.suite}.server.log`, 8);
    if (srv && srv !== "(no output)") console.log(`  [server] ${srv.split("\n").join("\n  [server] ")}`);
    console.log("");
  }
  process.exit(failed.length ? 1 : 0);
})();
