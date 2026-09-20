/**
 * The permission layer.
 *
 * `/admin` is gated in two places: `proxy.ts` only knows whether somebody is
 * signed in, and the admin layout does the real check with `isStaff`. A
 * signed-in MEMBER reaching the admin would be a straightforward breach, so
 * the predicate behind that gate is worth testing on its own.
 *
 * The journal rules matter just as much: no staff role, owner included, may
 * read a body.
 *
 * Run: npm run verify:permissions
 */
import assert from 'node:assert/strict'
import {
  guest,
  hasRole,
  isAdmin,
  isOwner,
  isSelf,
  isStaff,
  system,
  type Actor,
} from '../src/lib/permissions/actor'
import { policy } from '../src/lib/permissions/policy'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok   ${name}`)
}

const HER = 'contact-her'
const SOMEONE_ELSE = 'contact-else'

const member: Actor = {
  kind: 'user',
  userId: 'u-member',
  contactId: HER,
  roles: ['member'],
}
const coach: Actor = {
  kind: 'user',
  userId: 'u-coach',
  contactId: 'contact-coach',
  roles: ['member', 'coach'],
}
const admin: Actor = {
  kind: 'user',
  userId: 'u-admin',
  contactId: 'contact-admin',
  roles: ['member', 'admin'],
}
const owner: Actor = {
  kind: 'user',
  userId: 'u-owner',
  contactId: 'contact-owner',
  roles: ['member', 'owner'],
}

console.log('the admin gate:')

check('a signed-in MEMBER is not staff', () => {
  assert.equal(isStaff(member), false, 'a member could reach the admin')
  assert.equal(isAdmin(member), false)
  assert.equal(isOwner(member), false)
})

check('a guest is not staff', () => {
  assert.equal(isStaff(guest), false)
  assert.equal(isAdmin(guest), false)
})

check('system work is not staff either', () => {
  const sys = system('stripe webhook')
  assert.equal(isStaff(sys), false, 'a webhook must not inherit admin rights')
  assert.equal(isAdmin(sys), false)
})

check('a coach is staff but not an admin', () => {
  assert.equal(isStaff(coach), true)
  assert.equal(isAdmin(coach), false)
})

check('an admin is staff and admin, but not owner', () => {
  assert.equal(isStaff(admin), true)
  assert.equal(isAdmin(admin), true)
  assert.equal(isOwner(admin), false)
})

check('an owner is everything', () => {
  assert.ok(isStaff(owner) && isAdmin(owner) && isOwner(owner))
})

check('hasRole does not match a role she does not hold', () => {
  assert.equal(hasRole(member, 'admin', 'owner'), false)
  assert.equal(hasRole(coach, 'coach'), true)
})

console.log('\nthe journal:')

check('NOBODY on staff can read a journal body', () => {
  for (const actor of [coach, admin, owner]) {
    assert.equal(
      policy.journal.readBody(actor, HER, []),
      false,
      'a staff role could read her journal',
    )
  }
})

check('she can read her own', () => {
  assert.equal(policy.journal.readBody(member, HER, []), true)
})

check('another member cannot read hers', () => {
  const other: Actor = {
    kind: 'user',
    userId: 'u-other',
    contactId: SOMEONE_ELSE,
    roles: ['member'],
  }
  assert.equal(policy.journal.readBody(other, HER, []), false)
})

check('an explicit share is the ONLY way in', () => {
  assert.equal(policy.journal.readBody(coach, HER, [coach.userId!]), true)
  assert.equal(policy.journal.readBody(coach, HER, ['somebody-else']), false)
})

check('staff can read journal METADATA', () => {
  assert.equal(policy.journal.readMetadata(coach, HER), true)
  assert.equal(policy.journal.readMetadata(admin, HER), true)
})

check('only she can write to her journal', () => {
  assert.equal(policy.journal.write(member, HER), true)
  assert.equal(policy.journal.write(admin, HER), false)
  assert.equal(policy.journal.write(coach, HER), false)
})

console.log('\neverything else:')

check('isSelf compares the contact, not the user', () => {
  assert.equal(isSelf(member, HER), true)
  assert.equal(isSelf(member, SOMEONE_ELSE), false)
  assert.equal(isSelf(guest, HER), false)
})

check('drafts are staff-only, published programmes are public', () => {
  assert.equal(policy.program.readDraft(guest), false)
  assert.equal(policy.program.readDraft(member), false)
  assert.equal(policy.program.readDraft(coach), true)
  assert.equal(policy.program.readPublished(), true)
})

check('only an admin may change a programme', () => {
  assert.equal(policy.program.write(coach), false)
  assert.equal(policy.program.write(admin), true)
})

check('a coach cannot see orders or refund them', () => {
  assert.equal(policy.order.read(coach, HER), false)
  assert.equal(policy.order.refund(coach), false)
  assert.equal(policy.order.refund(admin), true)
})

check('she can see her own orders', () => {
  assert.equal(policy.order.read(member, HER), true)
})

check('only the owner manages roles and reads the audit log', () => {
  assert.equal(policy.admin.manageRoles(admin), false)
  assert.equal(policy.admin.manageRoles(owner), true)
  assert.equal(policy.admin.viewAuditLog(admin), false)
  assert.equal(policy.admin.viewAuditLog(owner), true)
})

check('her HER profile is readable by staff but writable only by her', () => {
  assert.equal(policy.herProfile.read(coach, HER), true)
  assert.equal(policy.herProfile.write(coach, HER), false)
  assert.equal(policy.herProfile.write(member, HER), true)
})

console.log(`\npermissions: all ${passed} checks passed`)
