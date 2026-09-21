import { and, desc, eq, isNull } from 'drizzle-orm'
import {
  contactEncryptionKeys,
  journalEntries,
  journalShares,
} from '../schema'
import { auditLog } from '../schema'
import {
  countWords,
  createContactKey,
  decryptEntry,
  encryptEntry,
  unwrapContactKey,
} from '@/lib/crypto/journal'
import { policy, require_ } from '@/lib/permissions/policy'
import type { QueryContext } from './_context'

/**
 * Journal access.
 *
 * Note what is NOT here: there is no function that returns a decrypted body to
 * a staff actor. `listMetadata` is what admin screens call, and it cannot
 * return words because it never touches the ciphertext.
 */

/** Metadata only. This is what the admin contact view is allowed to read. */
export async function listMetadata(
  { db, actor }: QueryContext,
  contactId: string,
) {
  require_(policy.journal.readMetadata(actor, contactId))

  return db
    .select({
      id: journalEntries.id,
      title: journalEntries.title,
      area: journalEntries.area,
      source: journalEntries.source,
      wordCount: journalEntries.wordCount,
      createdAt: journalEntries.createdAt,
    })
    .from(journalEntries)
    .where(eq(journalEntries.contactId, contactId))
    .orderBy(desc(journalEntries.createdAt))
}

async function dataKeyFor(db: QueryContext['db'], contactId: string) {
  const [row] = await db
    .select()
    .from(contactEncryptionKeys)
    .where(eq(contactEncryptionKeys.contactId, contactId))
    .limit(1)

  if (row) return unwrapContactKey(row.wrappedKey)

  const { dataKey, wrappedKey } = createContactKey()
  await db.insert(contactEncryptionKeys).values({ contactId, wrappedKey })
  return dataKey
}

export async function createEntry(
  { db, actor }: QueryContext,
  input: {
    contactId: string
    title?: string
    body: string
    area?: 'herself' | 'relationships' | 'success' | 'money'
    source?: 'free_write' | 'lesson_prompt' | 'return_practice' | 'her_choice'
    programId?: string
    lessonId?: string
  },
) {
  require_(policy.journal.write(actor, input.contactId))

  const dataKey = await dataKeyFor(db, input.contactId)

  const [entry] = await db
    .insert(journalEntries)
    .values({
      contactId: input.contactId,
      title: input.title ?? null,
      bodyEncrypted: encryptEntry(input.body, dataKey),
      area: input.area ?? null,
      source: input.source ?? 'free_write',
      programId: input.programId ?? null,
      lessonId: input.lessonId ?? null,
      wordCount: countWords(input.body),
    })
    .returning()

  return entry
}

/**
 * Read one body. Allowed for the member herself, or for a user she has
 * explicitly and currently shared this entry with. Every share-based read is
 * written to the audit log.
 */
export async function readBody({ db, actor }: QueryContext, entryId: string) {
  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.id, entryId))
    .limit(1)

  if (!entry) return null

  const shares = await db
    .select({ userId: journalShares.sharedWithUserId })
    .from(journalShares)
    .where(
      and(eq(journalShares.entryId, entryId), isNull(journalShares.revokedAt)),
    )

  const sharedWith = shares.map((s) => s.userId)
  require_(policy.journal.readBody(actor, entry.contactId, sharedWith))

  const isOwnEntry = actor.kind === 'user' && actor.contactId === entry.contactId
  if (!isOwnEntry && actor.kind === 'user') {
    await db.insert(auditLog).values({
      actorUserId: actor.userId,
      action: 'journal.read_shared',
      entity: 'journal_entries',
      entityId: entry.id,
      metadata: { contactId: entry.contactId },
    })
  }

  const dataKey = await dataKeyFor(db, entry.contactId)
  return { ...entry, body: decryptEntry(entry.bodyEncrypted, dataKey) }
}
