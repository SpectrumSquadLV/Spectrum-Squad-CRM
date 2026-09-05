// Who sees what, written down: scheduling, HR, and the OT roles.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-role-matrix-support.js
//
// Every permission bug reported against this CRM has had the same shape, and
// not one of them was a crash. The code did exactly what it was written to do:
//
//   * "the reorder menu shows on marissas menu as well"
//   * "i need the option to add files ... to show up on all ends not just mine"
//   * "marissa can see my task"
//   * "the billable requirement is only for BCBAs"
//   * "terminated employees should no longer show"
//
// Each was found by a person opening a screen as somebody else and noticing.
// Nothing here was looking, because THE CONSEQUENCE OF A PERMISSION CHANGE IS
// INVISIBLE IN A DIFF: you add a control, gate it on a role, and the only
// place the result shows up is on a screen you never opened.
//
// So the consequence is written down. This signs in as each role and records
// the sidebar it gets, the shell controls on it, and what a fixed list of
// endpoints answers -- including the can_* flags a page uses to decide whether
// to draw a button. The result is compared against role-matrix.json, committed
// beside it.
//
// A CHANGE HERE IS NOT A FAILURE, IT IS THE POINT. When this goes red it is
// telling you somebody's access changed, and the diff says whose and to what.
// If that is what you meant, re-run with UPDATE_MATRIX=1 and commit the new
// role-matrix.json in the same change -- the difference is then visible in
// review forever after. If any line is a surprise, you have caught the bug
// before somebody on a desk did.
//
// The other half of the catalogue is test-role-matrix-core.js, which carries the Both are
// thin: the machinery is in role-matrix-lib.js, split only because rendering
// the shell costs ~13s per role and twelve of them overruns the runner's cap.
"use strict";
const { runMatrix } = require("./role-matrix-lib.js");

let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else {
    const line = "  FAIL  " + n + (d !== undefined ? "\n" + (typeof d === "string" ? d : JSON.stringify(d, null, 2)) : "");
    fail++; failures.push(line); console.log(line);
  }
};

runMatrix("support", check).then(() => {
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
