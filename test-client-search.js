// Finding a client by name, including one who has been deactivated.
//
// Two things were wrong and they had the same cause.
//
// The Clients board had no search at all: a name was found by scanning
// milestone columns. And a DEACTIVATED client could not be found by any means,
// because the board's endpoint excluded discharged and not-moving-forward
// clients in SQL -- they were not hidden by a filter, they were absent from
// the data. The discharged view that does exist lives on the older #/pipeline
// board, which was dropped from the sidebar when this became the default, so
// it was reachable only by typing the URL.
//
// The property that matters most here: "we have no record of that child" and
// "that child was discharged in March" are different answers, and a search
// that cannot reach deactivated clients gives the first one when the second is
// true. So deactivated clients are searched, and shown greyed rather than
// omitted.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
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

  const api = (path, opts) => page.evaluate(async ({ p, o }) => {
    const r = await fetch(p, {
      method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: o && o.body ? JSON.stringify(o.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { p: path, o: opts });

  const stamp = String(await page.evaluate(() => Date.now())).slice(-6);
  const liveName = "Searchable Live " + stamp;
  const goneName = "Searchable Gone " + stamp;

  const mk = async (child, parent) => {
    const r = await api("/api/clients", {
      method: "POST",
      body: { child_name: child, parent_name: parent, parent_email: `${child.replace(/\s+/g, ".").toLowerCase()}@example.invalid` },
    });
    return r.body && r.body.id;
  };
  const liveId = await mk(liveName, "Parent Live " + stamp);
  const goneId = await mk(goneName, "Parent Gone " + stamp);
  // Deactivate one of them. Discharging goes through its own endpoint with a
  // reason -- a PATCH of `stage` is silently ignored, which is how the first
  // run of this suite "passed" two assertions about a client who had never
  // actually been discharged.
  const dis = await api(`/api/clients/${goneId}/discharge`, {
    method: "POST", body: { reason: "Test fixture", stage: "discharged" },
  });
  check("the fixture client really was discharged",
    dis.status === 200 && dis.body && dis.body.stage === "discharged",
    JSON.stringify(dis.body || {}).slice(0, 200));

  // ---------------- the data reaches the board at all ----------------
  const board = await api("/api/dashboard/pipeline-v2");
  const names = (board.body || []).map((c) => c.child_name);
  check("the board's data includes active clients", names.includes(liveName), names.length);
  check("and deactivated clients too — they used to be excluded in SQL",
    names.includes(goneName), JSON.stringify(names).slice(0, 300));
  const goneRow = (board.body || []).find((c) => c.child_name === goneName);
  check("a deactivated client is flagged as such", goneRow && goneRow.inactive === true, JSON.stringify(goneRow || {}).slice(0, 200));
  check("and says which kind of deactivated they are", goneRow && goneRow.stage === "discharged", goneRow && goneRow.stage);
  const liveRow = (board.body || []).find((c) => c.child_name === liveName);
  check("an active client is not flagged", liveRow && liveRow.inactive === false, JSON.stringify(liveRow || {}).slice(0, 160));

  // ---------------- the board itself is unchanged ----------------
  await page.evaluate(() => { location.hash = "#/pipeline-v2"; });
  await page.waitForTimeout(2200);
  let text = await page.locator("#view-mount").innerText();
  check("the board renders", /Client pipeline/i.test(text), text.slice(0, 200));
  check("an active client is on the board", text.includes(liveName), text.slice(0, 400));
  check("a deactivated client is NOT in the milestone columns",
    !text.includes(goneName), "deactivated client leaked into the board");

  // ---------------- searching ----------------
  check("there is a search box", await page.locator("#pv2-search").count() === 1);
  await page.fill("#pv2-search", "Searchable Live " + stamp);
  await page.waitForTimeout(600);
  text = await page.locator("#view-mount").innerText();
  check("searching finds an active client", text.includes(liveName), text.slice(0, 400));
  check("and drops the ones that do not match", !text.includes(goneName), text.slice(0, 400));

  // The heart of it: the deactivated client is findable.
  await page.fill("#pv2-search", goneName);
  await page.waitForTimeout(600);
  text = await page.locator("#view-mount").innerText();
  check("searching finds a DEACTIVATED client", text.includes(goneName), text.slice(0, 500));
  // Read off the RESULT ROW, not the page: "Show deactivated (1)" is also on
  // screen, so a page-wide regex passes whether or not the row says anything.
  const goneRowText = await page.evaluate((id) => {
    const el = document.querySelector('[data-pv2-open="' + id + '"]');
    return el ? el.innerText : "";
  }, goneId);
  check("and the row itself says they are discharged",
    /DISCHARGED/i.test(goneRowText), goneRowText);

  // Greyed, not merely labelled.
  const dimmed = await page.evaluate((id) => {
    const el = document.querySelector('[data-pv2-open="' + id + '"]');
    if (!el) return null;
    return Number(getComputedStyle(el).opacity);
  }, goneId);
  check("the deactivated result is greyed out", dimmed !== null && dimmed < 1, dimmed);

  // Searching by parent name, not only the child.
  await page.fill("#pv2-search", "Parent Gone " + stamp);
  await page.waitForTimeout(600);
  text = await page.locator("#view-mount").innerText();
  check("a client is findable by their parent's name", text.includes(goneName), text.slice(0, 400));

  // Every word must match, so a search narrows rather than widening.
  await page.fill("#pv2-search", "Searchable " + stamp);
  await page.waitForTimeout(600);
  text = await page.locator("#view-mount").innerText();
  check("a two-word search returns both matching clients",
    text.includes(liveName) && text.includes(goneName), text.slice(0, 500));

  await page.fill("#pv2-search", "Searchable ZZZNOTHING" + stamp);
  await page.waitForTimeout(600);
  text = await page.locator("#view-mount").innerText();
  check("every word has to match, so an unmatched word finds nothing",
    !text.includes(liveName) && !text.includes(goneName), text.slice(0, 400));
  check("and it says nothing matched rather than showing an empty screen",
    /No client matches/i.test(text), text.slice(0, 400));

  // ---------------- the deactivated view ----------------
  await page.fill("#pv2-search", "");
  await page.waitForTimeout(600);
  check("there is a way to see deactivated clients", await page.locator("#pv2-show-inactive").count() === 1);
  await page.check("#pv2-show-inactive");
  await page.waitForTimeout(700);
  text = await page.locator("#view-mount").innerText();
  check("turning it on lists the deactivated clients", text.includes(goneName), text.slice(-700));
  check("it says they are kept rather than deleted", /kept, never deleted/i.test(text), text.slice(-500));
  check("the active client is still on the board alongside", text.includes(liveName));

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
