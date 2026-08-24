// signnow-status.js -- reading SignNow's answer to "is this signed yet?"
//
// Small and pure on purpose. This is the line that broke, and it broke
// silently: families signed their enrollment packets, the CRM kept saying
// "Awaiting signature", the clinical screener (which fires on packet
// completion) never went out, and the daily "please sign" reminder kept
// arriving for people who already had.
"use strict";

// Has SignNow finished with this document? Returns "completed", "declined",
// or null for "not yet".
//
// This is a pure function on purpose. It is the line that broke: it used to
// read only `field_invites[].status === "fulfilled"`, which is how a document
// sent as a ROLE-BASED invite reports itself. The enrollment packets are sent
// as FREEFORM invites, and those report completion differently -- SignNow puts
// them under `requests`, and a signed one is identified by carrying a
// signature id rather than by a status string. So every packet a family
// actually signed still looked unsigned to the CRM: no screener went out, the
// daily "please sign" reminders kept going to people who already had, and the
// card said "Awaiting signature" indefinitely.
//
// Four shapes are accepted, because SignNow's own API is not consistent about
// this and guessing wrong is what caused the outage:
//   1. field_invites[].status === "fulfilled"   (role-based invite)
//   2. requests[].status === "fulfilled"        (some freeform responses)
//   3. requests[] carrying a signature id       (freeform, the packets' case)
//   4. a non-empty signatures[] on the document (belt and braces: somebody
//      signed it, whatever the invite bookkeeping says)
//
// Declines are checked FIRST. A document can carry both a decline and a
// stale signature from an earlier round, and treating that as completed
// would mark a family enrolled who has explicitly refused.
function readSignNowCompletion(doc) {
  if (!doc || typeof doc !== "object") return null;
  const invites = []
    .concat(Array.isArray(doc.field_invites) ? doc.field_invites : [])
    .concat(Array.isArray(doc.requests) ? doc.requests : []);
  const statusOf = (i) => String((i && i.status) || "").toLowerCase();

  if (invites.some((i) => statusOf(i) === "declined")) return "declined";

  if (invites.some((i) => statusOf(i) === "fulfilled")) return "completed";
  // A freeform invite that has been signed carries the signature it produced.
  if (invites.some((i) => i && (i.signature_id || i.signature_ids || i.signed))) return "completed";
  // And if the document itself has a signature on it, somebody signed it.
  if (Array.isArray(doc.signatures) && doc.signatures.length > 0) return "completed";

  return null;
}

// The sibling question, asked at SEND time rather than at poll time: did an
// invite actually get created?
//
// This exists because of what the account looked like on 2026-08-24. Five
// families sat in the CRM as "sent, awaiting signature" against SignNow
// documents that carried no invite of any kind -- the document had been copied
// from the template, every field was empty, and nothing had ever been emailed
// to the parent. The CRM chased them daily for a document they had never
// received, and the 7-day rule was lined up to close them out for not signing
// it. Three duplicate copies of one child's packet sat beside it, from retries.
//
// The send code could not have noticed: it POSTs the invite, and if that does
// not throw it records "sent". So the only defence is to read the document
// back and look.
//
//   true  -- an invite exists; the family has been written to
//   false -- the document is there and carries no invite at all
//   null  -- could not tell (the read failed, or the shape is unfamiliar)
//
// The three-way answer matters: a failed read must not be reported as "no
// invite", or a blip at SignNow would mark a genuinely-sent packet failed and
// send the family a second copy.
function readSignNowInviteDelivered(doc) {
  if (!doc || typeof doc !== "object") return null;
  const fieldInvites = Array.isArray(doc.field_invites) ? doc.field_invites : null;
  const requests = Array.isArray(doc.requests) ? doc.requests : null;
  // Neither key present at all is a response we do not understand, not a
  // document without an invite.
  if (fieldInvites === null && requests === null) return null;
  if ((fieldInvites || []).length > 0 || (requests || []).length > 0) return true;
  return false;
}

module.exports = { readSignNowCompletion, readSignNowInviteDelivered };
