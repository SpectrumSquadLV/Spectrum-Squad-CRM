// test-screener-template.js -- the Clinical Screener emails are editable.
//
// They were built as hardcoded strings inside screener.js, so they never
// appeared in Settings -> Email Templates and their wording could not be
// changed without a deploy. These checks pin the two things that matter: the
// owner can edit them, and no edit can produce an email the parent cannot act
// on -- the screener link is put back if it is removed.
//
//   DATABASE_URL=... node server.js
//   node test-screener-template.js
"use strict";

const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

async function login(email, password) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("login failed: " + res.status);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => ({})) : await r.text() };
  };
}

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", OWNER_PW);
  const stamp = Date.now().toString().slice(-6);

  // ---------------- it is in the editor ----------------
  section("The screener emails appear in the template editor");

  let r = await owner("/api/email-templates");
  const list = Array.isArray(r.data) ? r.data : (r.data.templates || []);
  const byKey = Object.fromEntries(list.map((t) => [t.template_key, t]));

  check("the template list loads", r.status === 200 && list.length > 0, r.data);
  check("the screener invitation is listed", !!byKey.screener_invite, Object.keys(byKey));
  check("the screener reminder is listed", !!byKey.screener_reminder, Object.keys(byKey));
  check("they are grouped under their own category",
    byKey.screener_invite && byKey.screener_invite.category === "Clinical Screener Emails",
    byKey.screener_invite && byKey.screener_invite.category);
  check("the editor offers the screener link as a merge field",
    (byKey.screener_invite.fields || []).includes("screener_link"), byKey.screener_invite.fields);
  check("and the parent/child fields", 
    ["parent_name", "child_name"].every((f) => (byKey.screener_invite.fields || []).includes(f)),
    byKey.screener_invite.fields);
  check("the description warns the link is required",
    /screener_link/.test(byKey.screener_invite.description || ""), byKey.screener_invite.description);

  check("the seeded invitation keeps the wording families already receive",
    /enrollment packet/i.test(byKey.screener_invite.body_template) && /clinical screener/i.test(byKey.screener_invite.body_template),
    byKey.screener_invite.body_template.slice(0, 160));
  check("the seeded reminder keeps its wording",
    /gentle reminder/i.test(byKey.screener_reminder.body_template),
    byKey.screener_reminder.body_template.slice(0, 160));
  check("both seeded bodies carry the link", 
    byKey.screener_invite.body_template.includes("{{screener_link}}") && byKey.screener_reminder.body_template.includes("{{screener_link}}"));

  // ---------------- editing it changes what goes out ----------------
  section("Editing the template changes the email a parent receives");

  const client = await owner("/api/clients", {
    method: "POST",
    body: { child_name: "Screener Tpl " + stamp, parent_name: "Tpl Parent", parent_email: `tpl.${stamp}@example.invalid` },
  });
  const clientId = client.data.id;

  const sentMails = async () => {
    const d = await owner(`/api/clients/${clientId}`);
    return (d.data.notifications || []).filter((n) => String(n.type || "").startsWith("screener"));
  };

  r = await owner(`/api/email-templates/screener_invite`, {
    method: "PUT",
    body: {
      subject_template: "Custom subject for {{child_name}} " + stamp,
      body_template: "<p>Dear {{parent_name}}, this is our own wording for {{child_name}}.</p><p><a href=\"{{screener_link}}\">Open the screener</a></p>",
    },
  });
  check("the owner can save an edit", r.status === 200, r.data);

  r = await owner(`/api/screener/send/${clientId}`, { method: "POST", body: {} });
  check("the screener sends", r.status === 200 && r.data.ok, r.data);

  let mails = await sentMails();
  check("exactly one screener email went out", mails.length === 1, mails.map((m) => m.subject));
  check("it used the edited subject", mails[0].subject === "Custom subject for Screener Tpl " + stamp + " " + stamp, mails[0].subject);
  check("it used the edited body", /this is our own wording/i.test(mails[0].body), mails[0].body.slice(0, 200));
  check("the merge fields were filled in", /Dear Tpl Parent/.test(mails[0].body), mails[0].body.slice(0, 200));
  check("the screener link is in the email", /\/screener\/[a-f0-9]{20,}/.test(mails[0].body), "no tokenised link found");

  // ---------------- the link guard ----------------
  section("An edit cannot produce an email with no screener link");

  r = await owner(`/api/email-templates/screener_reminder`, {
    method: "PUT",
    body: {
      subject_template: "Reminder with no link " + stamp,
      body_template: "<p>Hi {{parent_name}}, please complete the screener when you can.</p>",
    },
  });
  check("a template with the link removed can be saved", r.status === 200, r.data);

  // force=true -> sent as a reminder, using the template we just broke
  r = await owner(`/api/screener/send/${clientId}`, { method: "POST", body: { force: true } });
  check("the resend still succeeds", r.status === 200 && r.data.ok, r.data);

  mails = await sentMails();
  const reminder = mails.find((m) => m.subject === "Reminder with no link " + stamp);
  check("the reminder used the edited wording", !!reminder, mails.map((m) => m.subject));
  check("the CRM put the screener link back rather than sending a dead end",
    reminder && /\/screener\/[a-f0-9]{20,}/.test(reminder.body), reminder && reminder.body.slice(0, 300));
  check("the parent's own wording is still there too",
    reminder && /please complete the screener when you can/i.test(reminder.body));

  // ---------------- restore + preview ----------------
  section("Preview and permissions");

  r = await owner(`/api/email-templates/screener_invite/preview`, { method: "POST", body: {} });
  check("the invitation can be previewed in the editor", r.status === 200 && !!r.data.html, r.data);

  const anon = await fetch(BASE + "/api/email-templates", { headers: { "Content-Type": "application/json" } });
  check("signed out, the template list is refused", anon.status === 401, anon.status);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
