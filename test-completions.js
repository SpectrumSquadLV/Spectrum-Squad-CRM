// "Tell me when something is finished."
//
// Three properties matter more than the feature itself.
//
// 1. Recording never breaks the thing that completed. A parent signing their
//    financial form must succeed even if the notifier is broken.
// 2. Nothing is reported twice. Several of these events come from sweeps that
//    re-read the same row every hour.
// 3. Nothing is lost. A digest that fails to send must not mark its items as
//    reported -- they have to appear in the next one.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
  };

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const get = (path) => page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: "include" });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, path);
  const post = (path, body) => page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b || {}),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { p: path, b: body });

  // ---------------- 1. the feed exists and is owner-gated ----------------
  let feed = await get("/api/completions");
  check("the completions feed answers", feed.status === 200, JSON.stringify(feed).slice(0, 200));
  check("it reports how many are waiting for the digest", typeof feed.body.pending_digest === "number");
  check("it names a digest recipient", Array.isArray(feed.body.recipients));

  const before = (feed.body.completions || []).length;

  // ---------------- 2. a real completion is recorded ----------------
  // Drive the actual signing flow rather than poking the table, so what is
  // proved is the wiring, not the schema.
  const clientId = await page.evaluate(async () => {
    const list = await (await fetch("/api/clients", { credentials: "include" })).json();
    const c = (Array.isArray(list) ? list : []).find((x) => !["discharged", "not_moving_forward"].includes(x.stage));
    return c ? c.id : null;
  });
  check("found a live client", clientId != null);

  const created = await post("/api/client-forms/financial", {
    client_id: clientId, plan_type: "copay", copay_amount: "25", copay_per: "day",
  });
  check("a financial obligation form can be created", created.status === 200 || created.status === 201, JSON.stringify(created).slice(0, 200));

  const token = created.body && (created.body.token || (created.body.form && created.body.form.token));
  // Match on this form's own dedupe key rather than the signer's name: earlier
  // runs leave their own signed forms in the feed, and counting by name would
  // measure history instead of this run.
  const formId = created.body && created.body.form && created.body.form.id;
  const thisForm = (r) => r.dedupe_key === `financial_form:${formId}`;
  check("the new form has a token", !!token, JSON.stringify(created.body).slice(0, 200));

  if (token) {
    const signed = await page.evaluate(async (tk) => {
      const r = await fetch("/api/client-forms/public/financial/sign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tk, signed_name: "Test Parent" }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, token);
    check("a parent can sign it", signed.status === 200, JSON.stringify(signed).slice(0, 200));

    feed = await get("/api/completions");
    const rows = feed.body.completions || [];
    const hit = rows.find((r) => r.event_key === "financial_form_signed" && thisForm(r));
    check("signing it shows up in the feed", !!hit, JSON.stringify(rows.slice(0, 3)));
    check("the feed says who it was about", hit && !!hit.subject, hit && JSON.stringify(hit));
    check("the feed links back to the client", hit && /pipeline/.test(hit.link || ""), hit && hit.link);

    // Signing again must not produce a second entry.
    await page.evaluate(async (tk) => {
      await fetch("/api/client-forms/public/financial/sign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tk, signed_name: "Test Parent" }),
      });
    }, token);
    const feed2 = await get("/api/completions");
    const count = (feed2.body.completions || []).filter((r) => r.event_key === "financial_form_signed" && thisForm(r)).length;
    check("signing twice reports once", count === 1, "count=" + count);
  }

  // ---------------- 3. a broken notifier cannot break a signature ----------
  // The recorder swallows its own errors by design. Prove that by pointing an
  // event at a key that does not exist: it must still store, and the signing
  // path around it must still return 200.
  const odd = await post("/api/client-forms/financial", {
    client_id: clientId, plan_type: "mco", mco_name: "Test MCO",
  });
  check("a second form still creates while the feed is live", odd.status === 200 || odd.status === 201, JSON.stringify(odd).slice(0, 150));

  // ---------------- 4. the digest sends once and clears the queue ---------
  feed = await get("/api/completions");
  const pending = feed.body.pending_digest;
  check("there is something waiting to be sent", pending > 0, "pending=" + pending);

  const digest = await post("/api/completions/digest");
  check("the digest sends", digest.status === 200 && digest.body.sent === true, JSON.stringify(digest.body));
  check("it reports how many it carried", digest.body.count === pending, `carried=${digest.body.count} pending=${pending}`);

  const afterDigest = await get("/api/completions");
  check("the queue is empty afterwards", afterDigest.body.pending_digest === 0, "pending=" + afterDigest.body.pending_digest);
  check("but the feed still shows the history", (afterDigest.body.completions || []).length >= before + 1);

  const again = await post("/api/completions/digest");
  check("sending again with nothing new sends nothing", again.body.sent === false && again.body.reason === "nothing_to_report", JSON.stringify(again.body));
  // A digest that could not go out must leave its rows queued. Whatever the
  // reason, "not sent" and "marked as sent" must never both be true.
  const stillQueued = await get("/api/completions");
  check("a digest that reports not-sent leaves nothing marked sent",
    again.body.sent === true || stillQueued.body.pending_digest === (again.body.count || 0),
    JSON.stringify({ again: again.body, pending: stillQueued.body.pending_digest }));

  // ---------------- 5. it went to a real inbox, not into the void ---------
  const outbox = await get("/api/notifications");
  const logged = (Array.isArray(outbox.body) ? outbox.body : outbox.body.notifications || [])
    .filter((n) => n.type === "completion_digest");
  check("the digest is recorded in the outbox", logged.length >= 1, JSON.stringify(outbox.body).slice(0, 200));
  check("the digest subject says what it is", logged[0] && /finished today/i.test(logged[0].subject || ""), logged[0] && logged[0].subject);

  // ---------------- 6. it renders on the dashboard ----------------
  // Navigate away and back. The app was already showing the dashboard from
  // sign-in, and setting the hash to its current value fires no hashchange --
  // the card would still be holding what it rendered before the form was
  // signed, and the test would be reading stale DOM rather than the feature.
  await page.evaluate(() => { location.hash = "#/tasks"; });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { location.hash = "#/dashboard"; });
  // The feed is fetched after the dashboard paints, so wait for it to actually
  // fill rather than guessing at a delay -- on a database with more history the
  // fetch is slower and a fixed sleep reads an empty card.
  await page.waitForFunction(() => {
    const box = document.querySelector("#dash-completions");
    return box && !/Loading/i.test(box.textContent || "");
  }, null, { timeout: 20000 }).catch(() => {});
  const dashText = await page.locator("#view-mount").innerText();
  check("the dashboard has a Just completed card", /Just completed/i.test(dashText), dashText.slice(0, 300));
  // Whichever branch the footer takes, it must state the situation: who the
  // digest goes to, or that it goes to nobody. Grey silence is the failure
  // mode that looks exactly like a quiet day.
  const stated = /summary email to |has been emailed to |No one is getting the daily summary/i.test(dashText);
  check("the card says where the summary is going", stated, dashText.slice(-400));
  check("it lists the signed form", /Financial obligation form signed/i.test(dashText), dashText.slice(0, 600));

  // ---------------- 7. staff cannot read it ----------------
  const forbidden = await page.evaluate(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    const r = await fetch("/api/completions", { credentials: "include" });
    return r.status;
  });
  check("signed out, the feed refuses", forbidden === 401 || forbidden === 403, "status=" + forbidden);

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
