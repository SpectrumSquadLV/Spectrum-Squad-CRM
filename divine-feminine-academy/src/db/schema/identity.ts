import { relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryId, roleEnum, timestamps } from './_shared'

/**
 * THE canonical person.
 *
 * A "lead" and a "member" are the same woman at different moments, so they are
 * the same row. `userId` is null until she creates a login, and stays stable
 * afterwards. Never split this table.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: primaryId(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email').notNull(),
    phone: text('phone'),
    timezone: text('timezone').notNull().default('America/Los_Angeles'),

    /** Supabase auth user id. Null for a lead who has never logged in. */
    userId: uuid('user_id'),

    acquisitionSource: text('acquisition_source'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    referrerUrl: text('referrer_url'),

    crmStageId: uuid('crm_stage_id'),
    lifetimeValueCents: integer('lifetime_value_cents').notNull().default(0),

    leadAt: timestamp('lead_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),

    /**
     * She asked to stop receiving lifecycle email.
     *
     * On the CONTACT rather than on `profiles`, because `profiles` requires an
     * auth user and a lead does not have one. A woman who joined an archetype
     * sequence from a shared link has never logged in, and telling her to sign
     * in before she can unsubscribe is both hostile and, in several places she
     * might live, illegal.
     *
     * Transactional mail ignores this, as it must: unsubscribing from a
     * sequence cannot cost her her own sign-in links or her receipts.
     */
    emailOptedOutAt: timestamp('email_opted_out_at', { withTimezone: true }),

    /** Set instead of deleting, so orders and certificates stay intact. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('contacts_email_key').on(t.email),
    uniqueIndex('contacts_user_id_key').on(t.userId),
    index('contacts_stage_idx').on(t.crmStageId),
    index('contacts_last_activity_idx').on(t.lastActivityAt),
  ],
)

/** Member-facing identity. Login lives in Supabase auth; business data does not. */
export const profiles = pgTable(
  'profiles',
  {
    id: primaryId(),
    userId: uuid('user_id').notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    /** { dailyEmail: bool, dailySms: bool, reminderHour: 0-23 } */
    notificationPrefs: jsonb('notification_prefs').notNull().default({}),
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('profiles_user_id_key').on(t.userId),
    uniqueIndex('profiles_contact_id_key').on(t.contactId),
  ],
)

/** RBAC as rows. Never an is_admin boolean. */
export const userRoles = pgTable(
  'user_roles',
  {
    id: primaryId(),
    userId: uuid('user_id').notNull(),
    role: roleEnum('role').notNull(),
    grantedBy: uuid('granted_by'),
    ...timestamps,
  },
  (t) => [uniqueIndex('user_roles_user_role_key').on(t.userId, t.role)],
)

/** Editable by the owner, so the pipeline is not hard-coded. */
export const crmStages = pgTable(
  'crm_stages',
  {
    id: primaryId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    position: integer('position').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex('crm_stages_slug_key').on(t.slug)],
)

/** How you learn where women stall. */
export const contactStageHistory = pgTable(
  'contact_stage_history',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    fromStageId: uuid('from_stage_id'),
    toStageId: uuid('to_stage_id').notNull(),
    changedBy: uuid('changed_by'),
    changedAt: timestamp('changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('contact_stage_history_contact_idx').on(t.contactId)],
)

export const crmNotes = pgTable(
  'crm_notes',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').notNull(),
    body: text('body').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    ...timestamps,
  },
  (t) => [index('crm_notes_contact_idx').on(t.contactId)],
)

export const tags = pgTable(
  'tags',
  {
    id: primaryId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    color: text('color'),
    ...timestamps,
  },
  (t) => [uniqueIndex('tags_slug_key').on(t.slug)],
)

export const contactTags = pgTable(
  'contact_tags',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('contact_tags_key').on(t.contactId, t.tagId)],
)

export const followUpStatusEnum = pgEnum('follow_up_status', [
  'open',
  'done',
  'cancelled',
])

export const followUps = pgTable(
  'follow_ups',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    assignedTo: uuid('assigned_to'),
    note: text('note'),
    status: followUpStatusEnum('status').notNull().default('open'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('follow_ups_due_idx').on(t.dueAt, t.status)],
)

export const commChannelEnum = pgEnum('comm_channel', [
  'email',
  'sms',
  'call',
  'dm',
  'in_person',
])
export const commDirectionEnum = pgEnum('comm_direction', ['inbound', 'outbound'])

/** History without storing full message bodies. */
export const communications = pgTable(
  'communications',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channel: commChannelEnum('channel').notNull(),
    direction: commDirectionEnum('direction').notNull(),
    subject: text('subject'),
    summary: text('summary'),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [index('communications_contact_idx').on(t.contactId, t.occurredAt)],
)

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  profile: one(profiles, {
    fields: [contacts.id],
    references: [profiles.contactId],
  }),
  stage: one(crmStages, {
    fields: [contacts.crmStageId],
    references: [crmStages.id],
  }),
  notes: many(crmNotes),
  tags: many(contactTags),
  followUps: many(followUps),
}))
