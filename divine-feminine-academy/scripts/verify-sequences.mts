/**
 * The four archetype email sequences.
 *
 * Two halves. The first tests the COPY — because the most likely thing to go
 * wrong with twenty emails is not the code, it is a half-finished edit: a
 * token nobody replaced, a link to a page that does not exist, a subject line
 * so long her phone cuts it in half.
 *
 * The second half drives the whole thing against a real database and a fake
 * email provider: she joins, she gets one email now and four later, and she
 * gets each of them exactly once however many times the cron runs.
 *
 * Run: DATABASE_URL=... npm run verify:sequences
 */
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client'
import { activityEvents, automationRules, automationRuns, emailEvents } from '../src/db/schema/activity'
import { contactTags, contacts, tags } from '../src/db/schema/identity'
import { archetypes, modes, type ProtectiveMode } from '../src/features/quiz/archetypes'
import {
  FIRST_NAME_TOKEN,
  allSequenceEmails,
  personalise,
  sequences,
} from '../src/features/quiz/sequences'
import { archetypeSequence } from '../src/features/email/templates'
import {
  unsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from '../src/lib/email/unsubscribe'
import { joinArchetypeSequence, subscribeToArchetype } from '../src/features/quiz/subscribe'
import { runArchetypeRule } from '../src/features/quiz/sequence-send'
import { runDue, sweepEventsForAutomation } from '../src/features/automation/runner'
import { findOrCreateLead } from '../src/db/queries/leads'
import { unsubscribeByToken } from '../src/features/email/optout'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const SITE = 'https://example.test'
const stamp = Date.now()
const emailFor = (n: string) => `seq-check-${stamp}-${n}@example.test`

/* Every path a sequence is allowed to link to. A link to a page that does not
 * exist is a 404 in front of a woman who trusted the email enough to tap. */
const KNOWN_PATHS = new Set([
  '/me-vs-her',
  '/the-divine-feminine',
  '/quiz',
  '/quiz/the-commander',
  '/quiz/the-escape-artist',
  '/quiz/the-watcher',
  '/quiz/the-quiet-storm',
])

console.log('\nthe copy')

check('there are four sequences', Object.keys(sequences).length === 4)
check('one per mode', modes.every((m) => Array.isArray(sequences[m])))
check('five emails each', modes.every((m) => sequences[m].length === 5))
check('twenty emails in total', allSequenceEmails.length === 20)

for (const mode of modes) {
  const seq = sequences[mode]
  const name = archetypes[mode].name

  check(
    `${name}: steps are 1 to 5, each once`,
    JSON.stringify(seq.map((e) => e.step)) === JSON.stringify([1, 2, 3, 4, 5]),
  )
  check(`${name}: the first arrives immediately`, seq[0]!.afterDays === 0)
  check(
    `${name}: they arrive in order`,
    seq.every((e, i) => i === 0 || e.afterDays > seq[i - 1]!.afterDays),
  )
  /*
   * "Unwritten" is measured per EMAIL, not per paragraph.
   *
   * The first version of this check required every paragraph to be over
   * twenty characters and failed three sequences — on "One thing. Today.",
   * "Ten minutes. Today." and "One sentence. Today.", which are the single
   * best lines in those emails. A short closing instruction is the point, not
   * an unfinished draft. What actually indicates an unfinished draft is an
   * email with no body in it.
   */
  check(
    `${name}: nothing is left unwritten`,
    seq.every(
      (e) =>
        e.subject.trim().length > 5 &&
        e.preview.trim().length > 5 &&
        e.heading.trim().length > 3 &&
        e.paragraphs.length >= 3 &&
        e.paragraphs.every((p) => p.trim().length > 3) &&
        e.paragraphs.join(' ').length > 300,
    ),
  )
  check(
    `${name}: it ends with the invitation`,
    seq[4]!.cta?.path === '/me-vs-her',
  )
}

check(
  'every subject fits a phone',
  allSequenceEmails.every(({ email }) => email.subject.length <= 60),
  allSequenceEmails
    .filter(({ email }) => email.subject.length > 60)
    .map(({ email }) => `${email.subject.length}: ${email.subject}`)
    .join(' | '),
)

check(
  'no placeholder markers survived',
  !allSequenceEmails
    .map(({ email }) => [email.subject, email.heading, ...email.paragraphs].join(' '))
    .join(' ')
    .toUpperCase()
    .includes('PLACEHOLDER'),
)

check(
  'the only token is the first name',
  allSequenceEmails.every(({ email }) => {
    const text = [email.subject, email.preview, email.heading, ...email.paragraphs].join(' ')
    const tokens = text.match(/\{\{[^}]*\}\}/g) ?? []
    return tokens.every((t) => t === FIRST_NAME_TOKEN)
  }),
)

check(
  'every link goes somewhere that exists',
  allSequenceEmails.every(({ email }) => !email.cta || KNOWN_PATHS.has(email.cta.path)),
  allSequenceEmails
    .filter(({ email }) => email.cta && !KNOWN_PATHS.has(email.cta.path))
    .map(({ email }) => email.cta!.path)
    .join(' | '),
)

check(
  'each sequence links to its own archetype page and no other',
  modes.every((mode) =>
    sequences[mode]
      .map((e) => e.cta?.path)
      .filter((p): p is string => Boolean(p) && p!.startsWith('/quiz/'))
      .every((p) => p === `/quiz/${archetypes[mode].slug}`),
  ),
)

// The copy promises there is nothing to buy. If that ever stops being true,
// this should fail loudly rather than quietly become a lie.
check(
  'nothing in the sequence asks for money',
  !allSequenceEmails
    .map(({ email }) => [email.subject, ...email.paragraphs].join(' '))
    .join(' ')
    .toLowerCase()
    .match(/\$|£|\bbuy now\b|\bcheckout\b|\benrol now\b/),
)

console.log('\nher name')

check(
  'a name is filled in',
  personalise(`${FIRST_NAME_TOKEN}, you came out as The Commander.`, 'Ada') ===
    'Ada, you came out as The Commander.',
)
check(
  'no name still reads like a sentence',
  personalise(`${FIRST_NAME_TOKEN}, you came out as The Commander.`, null) ===
    'You came out as The Commander.',
  personalise(`${FIRST_NAME_TOKEN}, you came out as The Commander.`, null),
)
check('a blank name is treated as no name', personalise(`${FIRST_NAME_TOKEN}, hello.`, '   ') === 'Hello.')
check(
  'no token ever survives to her inbox',
  allSequenceEmails.every(({ email }) =>
    [email.subject, email.preview, email.heading, ...email.paragraphs]
      .map((t) => personalise(t, null))
      .every((t) => !t.includes('{{')),
  ),
)

console.log('\nunsubscribing')

{
  const id = '11111111-2222-3333-4444-555555555555'
  const other = '66666666-7777-8888-9999-000000000000'
  const token = unsubscribeToken(id)

  check('a token names the contact it was made for', verifyUnsubscribeToken(token) === id)
  check('two contacts get different tokens', unsubscribeToken(other) !== token)
  check('a tampered signature is refused', verifyUnsubscribeToken(`${token}x`) === null)
  check(
    'a swapped contact id is refused',
    verifyUnsubscribeToken(
      `${Buffer.from(other, 'utf8').toString('base64url')}.${token.split('.')[1]}`,
    ) === null,
  )
  check('a token with no signature is refused', verifyUnsubscribeToken(id) === null)
  check('an empty token is refused', verifyUnsubscribeToken('') === null)
  check('a url is absolute and has no double slash', /^https:\/\/example\.test\/unsubscribe\/[^/]+$/.test(unsubscribeUrl(SITE + '/', id)))
}

console.log('\nrendering')

{
  const rendered = archetypeSequence({
    firstName: 'Ada',
    email: sequences.sulk[0]!,
    siteUrl: SITE,
    unsubscribeUrl: unsubscribeUrl(SITE, 'abc'),
  })

  check('it has a subject, html and text', Boolean(rendered.subject && rendered.html && rendered.text))
  check('her name reached the body', rendered.html.includes('Ada'))
  check('the unsubscribe link is in the html', rendered.html.includes('/unsubscribe/'))
  check('the unsubscribe link is in the text part', rendered.text.includes('/unsubscribe/'))
  check(
    'it does not fall back to the account page',
    !rendered.html.includes('/my-practice/account'),
  )
  check('the cta became a full url', rendered.html.includes(`${SITE}/quiz/the-quiet-storm`))

  const injected = archetypeSequence({
    firstName: '<script>alert(1)</script>',
    email: sequences.fight[0]!,
    siteUrl: SITE,
    unsubscribeUrl: unsubscribeUrl(SITE, 'abc'),
  })
  check('a name is escaped, not executed', !injected.html.includes('<script>'))
}

console.log('\nend to end')

async function sentCount(contactId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailEvents)
    .where(and(eq(emailEvents.contactId, contactId), eq(emailEvents.type, 'sent')))
  return row?.n ?? 0
}

async function main() {
  const rules = await db
    .select()
    .from(automationRules)
    .where(eq(automationRules.triggerEvent, 'archetype.assigned'))

  check('sixteen rules are seeded', rules.length === 16, `found ${rules.length} — run npm run seed:sequences`)
  if (rules.length !== 16) {
    console.log(`\n${passed} passed, ${failed} failed\n`)
    process.exit(1)
  }

  check('every rule is active', rules.every((r) => r.isActive))
  check('no rule covers step 1', rules.every((r) => Number((r.actionConfig as Record<string, unknown>).step) !== 1))
  check(
    'every rule is conditioned on one archetype',
    rules.every((r) => {
      const c = (r.conditions ?? {}) as { equals?: Record<string, unknown> }
      return typeof c.equals?.archetype === 'string'
    }),
  )
  check(
    'each archetype has four rules',
    modes.every(
      (m) =>
        rules.filter(
          (r) => (r.conditions as { equals?: Record<string, string> }).equals?.archetype === m,
        ).length === 4,
    ),
  )

  const joinedAt = new Date()
  const email = emailFor('fight')
  const contactId = await findOrCreateLead(db, {
    email,
    firstName: 'Ada',
    source: 'test',
  })
  if (!contactId) throw new Error('could not create a contact')

  const result = await joinArchetypeSequence({
    db,
    contactId,
    mode: 'fight',
    source: 'test',
    siteUrl: SITE,
  })

  check('she joined', result.joined)
  check('the first email went straight away', result.firstEmailSent)
  check('exactly one email so far', (await sentCount(contactId)) === 1)

  const [assigned] = await db
    .select()
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.contactId, contactId),
        eq(activityEvents.eventType, 'archetype.assigned'),
      ),
    )
    .limit(1)

  check('an archetype.assigned event was written', Boolean(assigned))
  check(
    'the event carries the archetype the rules match on',
    (assigned?.metadata as Record<string, unknown>)?.archetype === 'fight',
  )

  const scheduled = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.contactId, contactId))

  check('four more are scheduled', scheduled.length === 4, `got ${scheduled.length}`)

  const handlers = {
    send_email: async (ctx: { db: typeof db; contactId: string; rule: { actionConfig: Record<string, unknown> } }) => {
      await runArchetypeRule({
        db: ctx.db,
        contactId: ctx.contactId,
        actionConfig: ctx.rule.actionConfig,
        siteUrl: SITE,
      })
    },
  }

  // Nothing is due yet: the next one is a day out.
  await runDue(db, handlers, new Date(joinedAt.getTime() + 60_000))
  check('nothing else goes out on the first day', (await sentCount(contactId)) === 1)

  // Walk forward to each step's due time and run the cron there.
  for (const step of sequences.fight.slice(1)) {
    const at = new Date(joinedAt.getTime() + step.afterDays * 86_400_000 + 60_000)
    await runDue(db, handlers, at)
  }

  check('all five have now been sent', (await sentCount(contactId)) === 5, String(await sentCount(contactId)))

  // The cron running again must not repeat anything.
  const sweptAgain = await sweepEventsForAutomation(db, new Date(joinedAt.getTime() + 9 * 86_400_000))
  for (const step of sequences.fight.slice(1)) {
    const at = new Date(joinedAt.getTime() + step.afterDays * 86_400_000 + 120_000)
    await runDue(db, handlers, at)
  }
  check('running the cron again sends nothing twice', (await sentCount(contactId)) === 5)
  check('the sweep does not re-schedule what it already scheduled', sweptAgain.scheduled === 0, String(sweptAgain.scheduled))

  // And joining again does not re-send the welcome.
  const again = await joinArchetypeSequence({
    db,
    contactId,
    mode: 'fight',
    source: 'test',
    siteUrl: SITE,
  })
  check('joining twice does not repeat the first email', !again.firstEmailSent)
  check('still five emails', (await sentCount(contactId)) === 5)

  console.log('\nshe only gets her own sequence')

  {
    const sulkId = await findOrCreateLead(db, {
      email: emailFor('sulk'),
      firstName: 'Beatrice',
      source: 'test',
    })
    if (!sulkId) throw new Error('could not create a contact')

    const at = new Date()
    await joinArchetypeSequence({ db, contactId: sulkId, mode: 'sulk', source: 'test', siteUrl: SITE })

    for (const step of sequences.sulk.slice(1)) {
      await runDue(db, handlers, new Date(at.getTime() + step.afterDays * 86_400_000 + 60_000))
    }

    const subjects = await db
      .select({ metadata: emailEvents.metadata })
      .from(emailEvents)
      .where(and(eq(emailEvents.contactId, sulkId), eq(emailEvents.type, 'sent')))

    const sent = subjects
      .map((s) => (s.metadata as Record<string, string | undefined>).subject)
      .filter((s): s is string => typeof s === 'string')
    const hers = new Set(sequences.sulk.map((e) => e.subject))

    check('she got five', sent.length === 5, String(sent.length))
    check('all five were hers', sent.every((s) => hers.has(s)), sent.join(' | '))
    check(
      'none of them belonged to another archetype',
      !sent.some((s) => sequences.fight.some((e) => e.subject === s)),
    )
  }

  console.log('\nunsubscribed means unsubscribed')

  {
    const optOutId = await findOrCreateLead(db, {
      email: emailFor('optout'),
      firstName: 'Cara',
      source: 'test',
    })
    if (!optOutId) throw new Error('could not create a contact')

    await db
      .update(contacts)
      .set({ emailOptedOutAt: new Date() })
      .where(eq(contacts.id, optOutId))

    const r = await joinArchetypeSequence({
      db,
      contactId: optOutId,
      mode: 'freeze',
      source: 'test',
      siteUrl: SITE,
    })

    check('an unsubscribed woman is not emailed', !r.firstEmailSent)
    check('and nothing was recorded as sent', (await sentCount(optOutId)) === 0)
  }

  console.log('\nthe unsubscribe link itself')

  {
    const linkId = await findOrCreateLead(db, {
      email: emailFor('link'),
      firstName: 'Eve',
      source: 'test',
    })
    if (!linkId) throw new Error('could not create a contact')

    await joinArchetypeSequence({ db, contactId: linkId, mode: 'flight', source: 'test', siteUrl: SITE })
    check('she is receiving mail to begin with', (await sentCount(linkId)) === 1)

    check('a forged token changes nothing', !(await unsubscribeByToken(db, 'nonsense.token')))
    check('an empty token changes nothing', !(await unsubscribeByToken(db, '')))

    const [before] = await db
      .select({ optedOut: contacts.emailOptedOutAt })
      .from(contacts)
      .where(eq(contacts.id, linkId))
      .limit(1)
    check('and she is still subscribed after the forgeries', before?.optedOut === null)

    check('her real link works', await unsubscribeByToken(db, unsubscribeToken(linkId)))

    const [after] = await db
      .select({ optedOut: contacts.emailOptedOutAt })
      .from(contacts)
      .where(eq(contacts.id, linkId))
      .limit(1)
    check('she is marked opted out', Boolean(after?.optedOut))

    check('clicking it twice is harmless', await unsubscribeByToken(db, unsubscribeToken(linkId)))

    // The rest of her sequence must now go nowhere.
    const at = new Date()
    for (const step of sequences.flight.slice(1)) {
      await runDue(db, handlers, new Date(at.getTime() + step.afterDays * 86_400_000 + 60_000))
    }
    check('no further sequence email reaches her', (await sentCount(linkId)) === 1, String(await sentCount(linkId)))

    const [logged] = await db
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.contactId, linkId),
          eq(activityEvents.eventType, 'email.unsubscribed'),
        ),
      )
      .limit(1)
    check('the unsubscribe is on her record', Boolean(logged))
  }

  console.log('\nopting in without the quiz')

  {
    const optInEmail = emailFor('optin')
    const outcome = await subscribeToArchetype({
      archetype: 'the-watcher',
      firstName: 'Dee',
      email: optInEmail,
    })

    check('she can join from the page', outcome.ok && outcome.archetype === 'freeze')

    const [c] = await db
      .select({ id: contacts.id, source: contacts.acquisitionSource })
      .from(contacts)
      .where(eq(contacts.email, optInEmail))
      .limit(1)

    check('she exists as a lead', Boolean(c))
    check('her source records the opt-in', c?.source === 'archetype-opt-in:the-watcher')
    check('she got the first email', (await sentCount(c!.id)) === 1)

    const tagged = await db
      .select({ slug: tags.slug })
      .from(contactTags)
      .innerJoin(tags, eq(tags.id, contactTags.tagId))
      .where(eq(contactTags.contactId, c!.id))

    check('she is tagged with the archetype', tagged.some((t) => t.slug === 'archetype-the-watcher'))
    check(
      'and marked as having chosen it herself',
      tagged.some((t) => t.slug === 'archetype-self-identified'),
      JSON.stringify(tagged),
    )

    const bad = await subscribeToArchetype({
      archetype: 'the-nonexistent',
      firstName: 'Dee',
      email: emailFor('bad'),
    })
    check('an archetype that does not exist is refused', !bad.ok)
  }

  console.log('\ncleaning up')
  const created = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(sql`${contacts.email} like ${'seq-check-' + stamp + '-%'}`)
  for (const c of created) await db.delete(contacts).where(eq(contacts.id, c.id))

  const left = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(sql`${contacts.email} like ${'seq-check-' + stamp + '-%'}`)
  check('the test left nothing behind', left.length === 0)

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
