import { type Actor, ForbiddenError, isAdmin, isSelf, isStaff } from './actor'

/**
 * Named policies, so permission rules live in one readable place rather than
 * scattered through route handlers.
 *
 * The journal rules are the ones worth reading twice: no staff role, owner
 * included, can read a journal body. The only path is an explicit, revocable
 * share created by the member herself.
 */
export const policy = {
  contact: {
    read: (actor: Actor, contactId: string) =>
      isSelf(actor, contactId) || isStaff(actor),
    write: (actor: Actor, contactId: string) =>
      isSelf(actor, contactId) || isAdmin(actor),
  },

  journal: {
    /** Only she reads her own words, unless she shared this exact entry. */
    readBody: (actor: Actor, ownerContactId: string, sharedWithUserIds: string[]) =>
      isSelf(actor, ownerContactId) ||
      (actor.kind === 'user' && sharedWithUserIds.includes(actor.userId)),
    /** Counts, dates, categories and word counts. Never the words. */
    readMetadata: (actor: Actor, ownerContactId: string) =>
      isSelf(actor, ownerContactId) || isStaff(actor),
    write: (actor: Actor, ownerContactId: string) => isSelf(actor, ownerContactId),
  },

  herProfile: {
    read: (actor: Actor, ownerContactId: string) =>
      isSelf(actor, ownerContactId) || isStaff(actor),
    write: (actor: Actor, ownerContactId: string) => isSelf(actor, ownerContactId),
  },

  program: {
    readPublished: () => true,
    readDraft: (actor: Actor) => isStaff(actor),
    write: (actor: Actor) => isAdmin(actor),
  },

  order: {
    read: (actor: Actor, contactId: string) =>
      isSelf(actor, contactId) || isAdmin(actor),
    refund: (actor: Actor) => isAdmin(actor),
  },

  admin: {
    viewPipeline: (actor: Actor) => isStaff(actor),
    manageRoles: (actor: Actor) => actor.kind === 'user' && actor.roles.includes('owner'),
    viewAuditLog: (actor: Actor) => actor.kind === 'user' && actor.roles.includes('owner'),
  },
} as const

/** Throw unless the policy allows it. */
export function require_(allowed: boolean, message?: string): void {
  if (!allowed) throw new ForbiddenError(message)
}
