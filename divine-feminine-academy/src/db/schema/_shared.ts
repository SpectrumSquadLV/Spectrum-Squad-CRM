import { pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core'

/** Every table gets these. */
export const primaryId = () => uuid('id').primaryKey().defaultRandom()

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}

/**
 * HERSELF / RELATIONSHIPS / MONEY / SUCCESS - the four areas, used across
 * the whole app. These are the curriculum's official areas; they replaced an
 * earlier self/love/life/wealth set, and migration 0012 renames the values in
 * place so existing rows keep their meaning.
 */
export const areaEnum = pgEnum('area', [
  'herself',
  'relationships',
  'money',
  'success',
])

export const roleEnum = pgEnum('role', ['member', 'coach', 'admin', 'owner'])
