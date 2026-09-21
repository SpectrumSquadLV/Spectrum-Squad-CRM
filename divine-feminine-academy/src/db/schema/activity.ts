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
import { primaryId, timestamps } from './_shared'
import { contacts } from './identity'

/**
 * THE ANALYTICS SPINE.
 *
 * Every funnel number in the business plan is a query over this one table.
 * Every meaningful action writes a row here, so analytics stays a reporting
 * problem instead of an instrumentation scramble six months from now.
 */
export const activityEvents = pgTable(
  'activity_events',
  {
    id: primaryId(),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'cascade',
    }),
    eventType: text('event_type').notNull(),
    entity: text('entity'),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata').notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('activity_events_contact_idx').on(t.contactId, t.occurredAt),
    index('activity_events_type_idx').on(t.eventType, t.occurredAt),
  ],
)

export const automationActionEnum = pgEnum('automation_action', [
  'send_email',
  'send_sms',
  'add_tag',
  'remove_tag',
  'change_stage',
  'enroll_in_program',
  'create_follow_up',
])

export const automationRules = pgTable(
  'automation_rules',
  {
    id: primaryId(),
    name: text('name').notNull(),
    triggerEvent: text('trigger_event').notNull(),
    /** Extra predicates evaluated against the event and the contact. */
    conditions: jsonb('conditions').notNull().default({}),
    delayMinutes: integer('delay_minutes').notNull().default(0),
    action: automationActionEnum('action').notNull(),
    actionConfig: jsonb('action_config').notNull().default({}),
    isActive: boolean('is_active').notNull().default(false),
    ...timestamps,
  },
  (t) => [index('automation_rules_trigger_idx').on(t.triggerEvent, t.isActive)],
)

export const automationRunStatusEnum = pgEnum('automation_run_status', [
  'scheduled',
  'succeeded',
  'failed',
  'skipped',
])

/** `idempotencyKey` is what stops a woman receiving the same email twice. */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: primaryId(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    status: automationRunStatusEnum('status').notNull().default('scheduled'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    error: text('error'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('automation_runs_idempotency_key').on(t.idempotencyKey),
    index('automation_runs_scheduled_idx').on(t.status, t.scheduledFor),
  ],
)

export const emailTemplates = pgTable(
  'email_templates',
  {
    id: primaryId(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    /** Name of the React Email component that renders this template. */
    component: text('component').notNull(),
    previewText: text('preview_text'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('email_templates_slug_key').on(t.slug)],
)

export const emailEventTypeEnum = pgEnum('email_event_type', [
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced',
  'complained',
])

export const emailEvents = pgTable(
  'email_events',
  {
    id: primaryId(),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'cascade',
    }),
    templateId: uuid('template_id').references(() => emailTemplates.id),
    providerMessageId: text('provider_message_id'),
    type: emailEventTypeEnum('type').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('email_events_contact_idx').on(t.contactId, t.occurredAt)],
)

/**
 * Every admin view of sensitive data lands here, including every read of a
 * journal entry a member chose to share.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryId(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata').notNull().default({}),
    ip: text('ip'),
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_log_actor_idx').on(t.actorUserId, t.occurredAt),
    index('audit_log_entity_idx').on(t.entity, t.entityId),
  ],
)

export const testimonialStatusEnum = pgEnum('testimonial_status', [
  'pending',
  'approved',
  'rejected',
])

export const testimonials = pgTable(
  'testimonials',
  {
    id: primaryId(),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    authorName: text('author_name').notNull(),
    authorLocation: text('author_location'),
    quote: text('quote').notNull(),
    programSlug: text('program_slug'),
    status: testimonialStatusEnum('status').notNull().default('pending'),
    /**
     * Placeholder copy used during design must be flagged, so invented
     * testimonials can never ship by accident.
     */
    isPlaceholder: boolean('is_placeholder').notNull().default(false),
    consentedAt: timestamp('consented_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('testimonials_status_idx').on(t.status, t.isPlaceholder)],
)
