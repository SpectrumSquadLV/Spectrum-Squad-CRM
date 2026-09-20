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

/** SELF / LOVE / LIFE / WEALTH - the four areas, used across the whole app. */
export const areaEnum = pgEnum('area', ['self', 'love', 'life', 'wealth'])

export const roleEnum = pgEnum('role', ['member', 'coach', 'admin', 'owner'])
