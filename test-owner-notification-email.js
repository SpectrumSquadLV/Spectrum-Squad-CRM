// Where owner notifications actually go.
//
// The Admin Settings screen has a field called "Owner notification email". It
// writes to app_settings. hr.js -- which sends the daily recruiting summary and
// three other owner alerts -- read the same key out of hr_settings, a table
// nothing has ever written it into. So the field could be filled in correctly
// and the recruiting summary would still ignore it and fall through to the
// seeded admin@ login, which hard-bounced on 7 August 2026 and has been
// discarding mail silently ever since.
//
// A box you can type an address into that is not consulted is worse than no
// box: it looks handled. These assert the resolution order end to end.
//
// Run: node test-owner-notification-email.js   (no database, no network)

"use strict";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
};

const initHr = require("./hr");

// Only the statements ownerEmail() issues are understood; anything else lands
// in state.unknown so a silent change of query shows up as a failure.
function makeHr({ appSettings = {}, hrSettings = {}, users = [] } = {}) {
  const state = { unknown: [] };
  const norm = (q) => q.replace(/\s+/g, " ").trim();

  const dbGet = async (sql, params = []) => {
    const q = norm(sql);
    if (q.includes("FROM hr_settings WHERE key = ?")) {
      const k = params[0];
      return k in hrSettings ? { value: hrSettings[k] } : undefined;
    }
    if (q.includes("FROM users WHERE role = 'owner' AND email <> 'admin@spectrumsquadlv.com'")) {
      return users.find((u) => u.role === "owner" && u.email !== "admin@spectrumsquadlv.com");
    }
    if (q.includes("FROM users WHERE role = 'owner'")) {
      return users.find((u) => u.role === "owner");
    }
    if (q.includes("FROM users WHERE role = 'admin'")) {
      return users.find((u) => u.role === "admin");
    }
    state.unknown.push(q);
    return undefined;
  };

  const hr = initHr({
    dbGet, dbAll: async () => [], dbRun: async () => ({ rowCount: 0 }),
    sendEmail: async () => ({ delivered: "sent" }),
    nowISO: () => "2026-09-17T00:00:00.000Z",
    crypto: require("crypto"),
    APP_BASE_URL: "https://crm.example",
    readBody: async () => ({}), json: () => {}, sendFile: () => {}, PUBLIC_DIR: __dirname,
    moduleGranted: () => false,
    getAppSetting: async (k, fb = null) => (k in appSettings ? appSettings[k] : fb),
  });
  return { hr, state };
}

const ADMIN = { role: "owner", email: "admin@spectrumsquadlv.com" };

(async () => {
  console.log("\n--- the Admin Settings field is actually read ---");
  {
    // The regression. Before the fix this returned admin@ -- the configured
    // value was in app_settings and nothing looked there.
    const { hr, state } = makeHr({
      appSettings: { owner_notification_email: "somebody@spectrumsquadlv.com" },
      users: [ADMIN],
    });
    const to = await hr._internal.ownerEmail();
    check("an address saved in Admin Settings wins over the fallback chain",
      to === "somebody@spectrumsquadlv.com", to);
    check("and the resolution issues no query the test does not model",
      state.unknown.length === 0, JSON.stringify(state.unknown));
  }
  {
    const { hr } = makeHr({
      appSettings: { owner_notification_email: "  spaced@spectrumsquadlv.com  " },
      users: [ADMIN],
    });
    check("it is trimmed, so a stray space does not become an invalid address",
      (await hr._internal.ownerEmail()) === "spaced@spectrumsquadlv.com");
  }
  {
    // An empty string is "not set", not "send to nowhere".
    const { hr } = makeHr({
      appSettings: { owner_notification_email: "   " },
      users: [{ role: "owner", email: "real@spectrumsquadlv.com" }, ADMIN],
    });
    check("a blank setting falls through instead of resolving to nothing",
      (await hr._internal.ownerEmail()) === "real@spectrumsquadlv.com");
  }

  console.log("\n--- the old table still works, so nothing stored is lost ---");
  {
    const { hr } = makeHr({
      hrSettings: { owner_notification_email: "legacy@spectrumsquadlv.com" },
      users: [ADMIN],
    });
    check("a value in hr_settings is still honoured",
      (await hr._internal.ownerEmail()) === "legacy@spectrumsquadlv.com");
  }
  {
    const { hr } = makeHr({
      appSettings: { owner_notification_email: "new@spectrumsquadlv.com" },
      hrSettings: { owner_notification_email: "legacy@spectrumsquadlv.com" },
      users: [ADMIN],
    });
    check("when both are set, the one Admin Settings writes wins",
      (await hr._internal.ownerEmail()) === "new@spectrumsquadlv.com");
  }

  console.log("\n--- the fallback chain, unchanged ---");
  {
    const { hr } = makeHr({ users: [ADMIN, { role: "owner", email: "real@spectrumsquadlv.com" }] });
    check("with nothing configured, a real owner beats the seeded admin@ login",
      (await hr._internal.ownerEmail()) === "real@spectrumsquadlv.com");
  }
  {
    // Not a happy answer, but the honest one: admin@ is where it lands when it
    // is the only owner account. The fix for THAT is a real mailbox, not code.
    const { hr } = makeHr({ users: [ADMIN] });
    check("with only the admin@ account, it still resolves rather than returning nothing",
      (await hr._internal.ownerEmail()) === "admin@spectrumsquadlv.com");
  }

  console.log("\n--- the wiring ---");
  {
    const src = require("fs").readFileSync(__dirname + "/hr.js", "utf8");
    check("ownerEmail reads the app_settings key by name",
      /getAppSetting\("owner_notification_email"/.test(src));
    const server = require("fs").readFileSync(__dirname + "/server.js", "utf8");
    check("Admin Settings saves that same key to app_settings",
      /setAppSetting\("owner_notification_email"/.test(server));
    check("hr is constructed with getAppSetting so the read is possible at all",
      /require\("\.\/hr"\)\(\{[\s\S]{0,900}?getAppSetting/.test(server));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
