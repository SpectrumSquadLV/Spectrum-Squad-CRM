// Signing in with the Dashboard switched off lands somewhere.
//
// REPORTED AS: "I am having an issue trying to log Mia in with her username
// and password and it just keeps it stuck on the first page."
//
// No error, no red text -- the sign-in card simply stayed put. The login
// handler sends everybody to #/dashboard, and the route guard bounced anybody
// whose Dashboard was switched off to... #/dashboard. Setting the hash to the
// hash you are already on fires no hashchange, so route() returned having
// drawn nothing, and the sign-in card was still the last thing on the screen.
//
// A person with the Dashboard off now lands on the first section they were
// granted, and a person with nothing at all is told so in words.
//
//   DATABASE_URL=... node run-tests.js test-dashboard-off-login.js
"use strict";

const { chromium } = require("playwright");

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

async function ownerApi() {
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
    return { status: r.status, body };
  };
  const r = await call("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  if (r.status !== 200) throw new Error("owner login failed: " + r.status);
  return call;
}

(async () => {
  const owner = await ownerApi();
  const users = await owner("/api/admin/users");
  const rows = Array.isArray(users.body) ? users.body : (users.body && (users.body.users || users.body.data)) || [];
  // Stands in for Mia.
  const mia = rows.find((u) => String(u.email).startsWith("clinical"));
  check("her account is visible to the owner", !!mia, users.body);

  const setAccess = (module_access) =>
    owner("/api/admin/users/" + mia.id, { method: "PATCH", body: { module_access } });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const signIn = async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(BASE + "/", { waitUntil: "networkidle" });
    await p.fill('#login-form input[name="email"]', "clinical@spectrumsquadlv.com");
    await p.fill('#login-form input[name="password"]', "TestStaff123!");
    await p.click('#login-form button[type="submit"]');
    await p.waitForTimeout(1500);
    return { p, ctx };
  };

  try {
    section("Dashboard off, Tasks granted");
    {
      const s = await setAccess({ dashboard: false, tasks: true });
      check("the access saves", s.status === 200, s);
      const { p, ctx } = await signIn();
      check("THE SIGN-IN CARD GOES AWAY -- the bug that was reported",
        (await p.locator("#login-form").count()) === 0);
      check("she lands on the section she was granted", (await p.evaluate(() => location.hash)) === "#/tasks",
        await p.evaluate(() => location.hash));
      await ctx.close();
    }

    section("Dashboard off, Clients granted");
    {
      await setAccess({ dashboard: false, pipeline: true });
      const { p, ctx } = await signIn();
      check("she lands on Clients, not bounced between two guards",
        (await p.evaluate(() => location.hash)) === "#/pipeline-v2", await p.evaluate(() => location.hash));
      await ctx.close();
    }

    section("Dashboard off and nothing else granted");
    {
      await setAccess({ dashboard: false });
      const { p, ctx } = await signIn();
      check("the sign-in card still goes away", (await p.locator("#login-form").count()) === 0);
      const text = await p.locator("#view-mount").innerText().catch(() => "");
      check("she is told in words why there is nothing to see",
        /No sections are switched on for your account/.test(text), text);
      await ctx.close();
    }

    section("A browser that does not keep the session cookie");
    {
      await setAccess({});
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      // Stands in for blocked cookies: the sign-in succeeds, the cookie never lands.
      await p.route("**/api/auth/login", async (route) => {
        const r = await route.fetch();
        // route.fetch() shares the context's cookie jar, so drop what it kept.
        await ctx.clearCookies();
        const headers = { ...r.headers() };
        delete headers["set-cookie"];
        await route.fulfill({ response: r, headers });
      });
      await p.goto(BASE + "/", { waitUntil: "networkidle" });
      await p.fill('#login-form input[name="email"]', "clinical@spectrumsquadlv.com");
      await p.fill('#login-form input[name="password"]', "TestStaff123!");
      await p.click('#login-form button[type="submit"]');
      await p.waitForTimeout(1500);
      const err = await p.locator("#login-error").innerText().catch(() => "");
      check("she is told the browser did not keep her signed in, instead of a silent reload",
        /did not keep you signed in/.test(err), err);
      await ctx.close();
    }

    section("Something breaks while the first page is drawn");
    {
      await setAccess({});
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      // Stands in for whatever breaks on one person's account: a request the
      // first page needs fails outright.
      await p.route("**/api/stages**", (route) => route.fulfill({ status: 500, body: "{}" }));
      await p.goto(BASE + "/", { waitUntil: "networkidle" });
      await p.fill('#login-form input[name="email"]', "clinical@spectrumsquadlv.com");
      await p.fill('#login-form input[name="password"]', "TestStaff123!");
      await p.click('#login-form button[type="submit"]');
      await p.waitForTimeout(1500);
      const text = await p.locator("#app").innerText().catch(() => "");
      check("she is shown the error instead of a frozen login card",
        /This page could not load/.test(text) && (await p.locator("#login-form").count()) === 0, text);
      await p.reload({ waitUntil: "networkidle" });
      await p.waitForTimeout(1000);
      const after = await p.locator("#app").innerText().catch(() => "");
      check("...and after a reload, instead of a blank page", /This page could not load/.test(after), after);
      await p.click("#route-error-signout");
      await p.waitForTimeout(1500);
      check("Sign out gets her back to the login card", (await p.locator("#login-form").count()) === 1);
      await ctx.close();
    }

    section("Dashboard left alone");
    {
      await setAccess({});
      const { p, ctx } = await signIn();
      check("an ordinary sign-in still lands on the Dashboard",
        (await p.evaluate(() => location.hash)) === "#/dashboard", await p.evaluate(() => location.hash));
      await ctx.close();
    }
  } finally {
    await setAccess({}).catch(() => {});
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
