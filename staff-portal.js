// ===================== THE STAFF PORTAL =====================
//
// One QR code on the office wall, and the pages behind it.
//
// Everything here is WRITE-ONLY AND ANONYMOUS, and that is what makes it safe
// to leave wide open: somebody who scans the code can put something IN and
// read nothing back. No session is issued, nothing is remembered about who
// scanned, and no page behind this one displays a record of any kind.
//
// That property is a constraint rather than a coincidence. A page added here
// that shows somebody their own information would need a way to prove who
// they are, and the whole door would have to change shape. This module held
// exactly one such page -- a PTO balance behind an emailed one-time code --
// and it was removed when PTO moved back to Rethink. If a reading page is
// ever wanted here again, the sign-in it needs is in the history of this
// file rather than something to design from scratch.
"use strict";

module.exports = function (ctx) {
  const dbRun = (ctx && ctx.dbRun) || (async () => {});
  const fs = require("fs");
  const path = require("path");

  // Nothing to create: the pages served here submit into the supply,
  // maintenance and concern modules, which own their own tables.
  //
  // There is something to REMOVE, though. The PTO page that used to live
  // here kept one-time codes and portal sessions, and those tables are full
  // of staff email addresses that nothing reads any more. A table nobody
  // queries is not harmless when it holds personal data, so the removal
  // takes them with it rather than leaving them for somebody to find in two
  // years and wonder about.
  //
  // IF IT IS EVER REBUILT, it gets fresh tables. Nothing here is worth
  // keeping: a one-time code is dead in ten minutes and a session in an
  // hour.
  async function initTables() {
    await dbRun("DROP TABLE IF EXISTS portal_login_codes").catch(() => {});
    await dbRun("DROP TABLE IF EXISTS portal_sessions").catch(() => {});
  }

  // No API of its own either. Kept so server.js has one shape to call for
  // every add-on rather than a special case for this one.
  async function handleApi() { return false; }

  function servePage(req, res, pathname) {
    if (pathname !== "/staff" && pathname !== "/staff/") return false;
    const f = path.join(__dirname, "staff-hub.html");
    if (!fs.existsSync(f)) return false;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      // Not indexed: this is the practice's internal front door, and a search
      // listing for it is noise at best.
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store",
    });
    res.end(fs.readFileSync(f, "utf8"));
    return true;
  }

  return { initTables, handleApi, servePage };
};
