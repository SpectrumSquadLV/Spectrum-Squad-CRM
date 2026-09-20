import type { Db } from '../client'
import type { Actor } from '@/lib/permissions/actor'

/**
 * Every query function takes this as its first argument.
 *
 * Because the signature demands it, there is no way to run a query without
 * saying who is asking. That is the whole point: authorization is enforced by
 * the type system, not by remembering to check.
 */
export interface QueryContext {
  db: Db
  actor: Actor
}

export type Query<Args extends unknown[], Result> = (
  ctx: QueryContext,
  ...args: Args
) => Promise<Result>
