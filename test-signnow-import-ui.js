// The import screen, and the promise it makes: nothing is written until you
// tick it, and the client documents it creates are not readable by anyone who
// shouldn't see them.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
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

  // ---------------- 1. the page exists and writes nothing on arrival ----------
  await page.evaluate(() => { location.hash = "#/signnow-import"; });
  await page.waitForFunction(() => /SignNow document import/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const text = await page.locator("#view-mount").innerText();
  check("the import page renders", /SignNow document import/i.test(text), text.slice(0, 200));
  check("it says nothing is written until you tick it", /until you tick it/i.test(text), text.slice(0, 300));
  check("it does not scan on its own", /Press .*Scan SignNow|Scan SignNow/i.test(text), text.slice(0, 300));

  const imported = await api("/api/signnow-import/preview");
  check("preview is safe to call before scanning", imported.status === 200, JSON.stringify(imported).slice(0, 200));
  check("and reports that nothing has been read yet", imported.body.empty === true, JSON.stringify(imported.body).slice(0, 200));

  // ---------------- 2. commit refuses an empty selection ----------------
  const empty = await api("/api/signnow-import/commit", { method: "POST", body: { items: [] } });
  check("committing nothing is refused, not treated as 'import everything'",
    empty.status === 400, JSON.stringify(empty).slice(0, 200));

  // ---------------- 3. the PHI gate on client documents ----------------
  // The import copies signed enrollment packets in, so this route is the one
  // that decides who can read a family's SSN. Being logged in used to be enough.
  const clientId = await page.evaluate(async () => {
    const list = await (await fetch("/api/clients", { credentials: "include" })).json();
    return (Array.isArray(list) ? list : [])[0].id;
  });
  const made = await api(`/api/clients/${clientId}/documents`, {
    method: "POST",
    body: { label: "PHI gate probe", filename: "probe.txt", content_base64: Buffer.from("secret").toString("base64"), mime_type: "text/plain" },
  });
  check("a document can be attached to a client", made.status === 201, JSON.stringify(made).slice(0, 200));
  const docId = made.body && made.body.id;

  const asOwner = await page.evaluate(async (id) => {
    const r = await fetch(`/api/documents/${id}/download`, { credentials: "include" });
    return r.status;
  }, docId);
  check("someone who can see client records can open it", asOwner === 200, "status=" + asOwner);

  // Every open is written down.
  const auditAfter = await api("/api/hr/audit?limit=20");
  const auditRows = Array.isArray(auditAfter.body) ? auditAfter.body : (auditAfter.body.rows || auditAfter.body.audit || []);
  check("opening it is written to the audit log",
    auditRows.some((a) => a.action === "client_document_viewed" && /PHI gate probe/.test(a.detail || "")),
    JSON.stringify(auditRows.slice(0, 3)));

  // A role with no business in client records must be refused.
  const denied = await page.evaluate(async (id) => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    const r = await fetch(`/api/documents/${id}/download`, { credentials: "include" });
    return r.status;
  }, docId);
  check("signed out, the document is refused", denied === 401 || denied === 403, "status=" + denied);

  // ---------------- 4. the file never became a public asset ----------------
  // Unknown paths fall through to the SPA, so a 200 here proves nothing on its
  // own -- what matters is that the response is the app shell and not the
  // document's bytes. Anything under /data must never come back as a file.
  const asStatic = await page.evaluate(async () => {
    const r = await fetch("/data/documents/probe.txt", { credentials: "omit" });
    const body = await r.text();
    return { status: r.status, type: r.headers.get("content-type") || "", leaked: body.includes("secret") };
  });
  check("the stored file is not reachable as a static asset", !asStatic.leaked, JSON.stringify(asStatic));
  // In practice the allowlist refuses it outright with a 404 -- better than the
  // SPA fallback, since it does not even confirm the path shape. Either is
  // fine; serving the bytes is not.
  check("that path is refused rather than read off disk",
    asStatic.status === 404 || /text\/html/.test(asStatic.type), JSON.stringify(asStatic));

  // tidy up
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2000);
  if (docId) await api(`/api/clients/${clientId}/documents/${docId}`, { method: "DELETE" });

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
