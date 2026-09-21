/**
 * The actor context.
 *
 * Every query function in src/db/queries takes one of these as its first
 * argument. There is no overload without it, so "who is asking" cannot be
 * forgotten - the code will not compile. This is the layer where
 * authorization actually lives; middleware is only the coarse gate and
 * Postgres row-level security is only the backstop.
 */

export type Role = 'member' | 'coach' | 'admin' | 'owner'

export type Actor =
  | { kind: 'guest' }
  | {
      kind: 'user'
      userId: string
      contactId: string | null
      roles: Role[]
    }
  /**
   * Trusted server-side work with no human behind it: Stripe webhooks,
   * scheduled automations. Never constructed from a request the public can
   * reach, and never used to read journal bodies.
   */
  | { kind: 'system'; reason: string }

export const guest: Actor = { kind: 'guest' }

export function system(reason: string): Actor {
  return { kind: 'system', reason }
}

export function hasRole(actor: Actor, ...roles: Role[]): boolean {
  return actor.kind === 'user' && actor.roles.some((r) => roles.includes(r))
}

export function isStaff(actor: Actor): boolean {
  return hasRole(actor, 'coach', 'admin', 'owner')
}

export function isAdmin(actor: Actor): boolean {
  return hasRole(actor, 'admin', 'owner')
}

export function isOwner(actor: Actor): boolean {
  return hasRole(actor, 'owner')
}

/** True when the actor is the member the row belongs to. */
export function isSelf(actor: Actor, contactId: string): boolean {
  return actor.kind === 'user' && actor.contactId === contactId
}

export class ForbiddenError extends Error {
  constructor(message = 'You do not have access to that.') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export function assert(condition: boolean, message?: string): asserts condition {
  if (!condition) throw new ForbiddenError(message)
}
