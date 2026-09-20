import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryId, timestamps } from './_shared'
import { contacts } from './identity'
import { programs } from './programs'

export const requirementTypeEnum = pgEnum('requirement_type', [
  'lessons_completed_pct',
  'required_blocks_answered',
  'post_assessment_submitted',
  'her_choices_logged',
  'her_code_finalized',
])

export const certificateRequirements = pgTable(
  'certificate_requirements',
  {
    id: primaryId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    requirementType: requirementTypeEnum('requirement_type').notNull(),
    threshold: integer('threshold').notNull().default(100),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('certificate_requirements_key').on(t.programId, t.requirementType),
  ],
)

export const certificates = pgTable(
  'certificates',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id),
    certificateNumber: text('certificate_number').notNull(),
    /** Powers the public /verify/[token] page, which is what makes it credible. */
    verificationToken: text('verification_token').notNull(),
    recipientName: text('recipient_name').notNull(),
    pdfUrl: text('pdf_url'),
    issuedAt: timestamp('issued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('certificates_number_key').on(t.certificateNumber),
    uniqueIndex('certificates_verification_key').on(t.verificationToken),
    index('certificates_contact_idx').on(t.contactId),
  ],
)
