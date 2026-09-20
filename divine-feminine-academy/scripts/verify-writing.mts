/**
 * The content engine.
 *
 * The markdown half is where the security is. This parser exists so that
 * nothing ever reaches `dangerouslySetInnerHTML`, and the one hole a tree
 * parser can still leave open is a URL — so `javascript:` and `data:` links
 * are the checks that matter most here, not the bold and the italics.
 *
 * The database half is mostly about one word: PUBLISHED. A draft, a future
 * date and an archived piece must all be invisible, in the index, on its own
 * page, in the sitemap and in the feed. Getting that subtly wrong is how a
 * half-written post ends up in a search result.
 *
 * Run: DATABASE_URL=... npm run verify:writing
 */
import { readFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client'
import { articles } from '../src/db/schema/content'
import { contactTags, contacts, tags } from '../src/db/schema/identity'
import { emailEvents } from '../src/db/schema/activity'
import {
  excerpt,
  formatDuration,
  parseInline,
  parseMarkdown,
  plainText,
  readingMinutes,
  safeUrl,
  slugify,
} from '../src/features/writing/markdown'
import {
  getPublishedArticle,
  listPublished,
  listPublishedSlugs,
  slugTaken,
} from '../src/db/queries/writing'
import { announceNewWriting, lettersAudienceSize } from '../src/features/writing/announce'
import { subscribeFromArticle, LETTERS_TAG } from '../src/features/writing/subscribe'
import { findOrCreateLead, tagContact } from '../src/db/queries/leads'

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
const emailFor = (n: string) => `writing-check-${stamp}-${n}@example.test`
const slugFor = (n: string) => `writing-check-${stamp}-${n}`

console.log('\nlinks — the part that matters')

check('an http link survives', safeUrl('http://example.com') === 'http://example.com')
check('an https link survives', safeUrl('https://example.com/x?y=1') === 'https://example.com/x?y=1')
check('a mailto link survives', safeUrl('mailto:her@example.com') === 'mailto:her@example.com')
check('a site-relative link survives', safeUrl('/writing/x') === '/writing/x')
check('an anchor survives', safeUrl('#section') === '#section')
check('a protocol-relative link is refused', safeUrl('//evil.example') === null)
check('javascript: is refused', safeUrl('javascript:alert(1)') === null)
check('JaVaScRiPt: is refused too', safeUrl('JaVaScRiPt:alert(1)') === null)
check('a data: url is refused', safeUrl('data:text/html,<script>alert(1)</script>') === null)
check('a vbscript: url is refused', safeUrl('vbscript:msgbox') === null)
check('a file: url is refused', safeUrl('file:///etc/passwd') === null)
check('an empty url is refused', safeUrl('   ') === null)

{
  const nodes = parseInline('[click me](javascript:alert)')
  const text = nodes.map((n) => (n.type === 'text' ? n.value : '')).join('')
  check('a dangerous link is dropped', !nodes.some((n) => n.type === 'link'))
  check('but her words are kept', text === 'click me')
}

{
  // A URL containing brackets does not match the link pattern at all, so it
  // never becomes a link either. Both routes end with no anchor, which is the
  // property that matters — the stray characters left in the text are cosmetic.
  const nodes = parseInline('[click me](javascript:alert(1))')
  check('a bracketed dangerous url makes no link', !nodes.some((n) => n.type === 'link'))
  check('and her words survive it', nodes.map((n) => (n.type === 'text' ? n.value : '')).join('').startsWith('click me'))
}

{
  const nodes = parseInline('[home](/writing) and [out](https://example.com)')
  const links = nodes.filter((n) => n.type === 'link')
  check('safe links are kept', links.length === 2)
}

console.log('\nmarkdown')

{
  const blocks = parseMarkdown('## A heading\n\nSome words.\n\n### Smaller\n')
  check('headings parse', blocks[0]?.type === 'heading' && blocks[0].level === 2)
  check('paragraphs parse', blocks[1]?.type === 'paragraph')
  check('h3 parses', blocks[2]?.type === 'heading' && blocks[2].level === 3)
}

{
  // A second h1 on a page is a real accessibility fault. `#` is quietly
  // promoted to h2 rather than being allowed to create one.
  const blocks = parseMarkdown('# Not an h1')
  check('a single # becomes a heading level 2', blocks[0]?.type === 'heading' && blocks[0].level === 2)
}

{
  const blocks = parseMarkdown('- one\n- two\n- three')
  check('a bullet list parses', blocks[0]?.type === 'list' && !blocks[0].ordered)
  check('with all its items', blocks[0]?.type === 'list' && blocks[0].items.length === 3)
}

{
  const blocks = parseMarkdown('1. one\n2. two')
  check('a numbered list parses', blocks[0]?.type === 'list' && blocks[0].ordered === true)
}

{
  const blocks = parseMarkdown('> quoted words\n> more of them')
  check('a quote parses', blocks[0]?.type === 'quote')
  check('a quote holds blocks', blocks[0]?.type === 'quote' && blocks[0].children.length === 1)
}

{
  const blocks = parseMarkdown('before\n\n---\n\nafter')
  check('a rule parses', blocks[1]?.type === 'rule')
}

{
  const blocks = parseMarkdown('![a description](https://example.com/x.jpg)')
  check('an image parses', blocks[0]?.type === 'image')
  check('its alt text is kept', blocks[0]?.type === 'image' && blocks[0].alt === 'a description')
}

{
  const blocks = parseMarkdown('![x](javascript:alert)')
  check('an image with a dangerous source is dropped entirely', blocks.length === 0)
}

{
  // The bracketed variant does not match the image pattern, so it stays a
  // paragraph of text. No image element either way.
  const blocks = parseMarkdown('![x](javascript:alert(1))')
  check('a bracketed dangerous image source makes no image', !blocks.some((b) => b.type === 'image'))
}

{
  const blocks = parseMarkdown('![x](data:text/html;base64,PHNjcmlwdD4=)')
  check('a data: image is dropped', blocks.length === 0)
}

{
  const nodes = parseInline('**bold** and *italic* and `code` and [a link](/x)')
  check('bold parses', nodes.some((n) => n.type === 'strong'))
  check('italic parses', nodes.some((n) => n.type === 'em'))
  check('code parses', nodes.some((n) => n.type === 'code'))
  check('links parse', nodes.some((n) => n.type === 'link'))
}

{
  // Raw HTML is not a feature. It must survive as TEXT, so that a pasted
  // script tag is something a reader sees rather than something that runs.
  const blocks = parseMarkdown('<script>alert(1)</script>')
  const text = plainText('<script>alert(1)</script>')
  check('raw html stays a paragraph of text', blocks[0]?.type === 'paragraph')
  check('and its characters are preserved verbatim', text.includes('<script>'))
}

{
  const nasty = [
    '',
    '   ',
    '\n\n\n',
    '**unclosed',
    '[unclosed](',
    '> ',
    '- ',
    '#',
    '![](',
    '---\n---\n---',
    'a'.repeat(5000),
  ]
  let threw = false
  for (const input of nasty) {
    try {
      parseMarkdown(input)
      plainText(input)
      excerpt(input)
      readingMinutes(input)
    } catch {
      threw = true
    }
  }
  check('malformed input never throws', !threw)
}

console.log('\nderived')

check('plain text strips the formatting', plainText('## Hi\n\n**bold** words') === 'Hi bold words')
check('reading time is never zero for real text', readingMinutes('word '.repeat(50)) >= 1)
check('reading time is zero for nothing', readingMinutes('') === 0)
check('a long piece takes longer', readingMinutes('word '.repeat(2000)) > readingMinutes('word '.repeat(100)))

{
  const long = 'word '.repeat(200)
  const cut = excerpt(long, 100)
  check('an excerpt is capped', cut.length <= 101, String(cut.length))
  check('an excerpt ends in an ellipsis', cut.endsWith('…'))
  check('a short piece is not cut', excerpt('Three words here.', 100) === 'Three words here.')
}

check('slugify lowercases and joins', slugify('The Cost of Being Capable') === 'the-cost-of-being-capable')
check('slugify drops apostrophes rather than hyphenating them', slugify("It's fine") === 'its-fine')
check('slugify folds accents', slugify('Café Crème') === 'cafe-creme')
check('slugify trims its own dashes', slugify('  !! hello !!  ') === 'hello')
check('slugify is bounded', slugify('a'.repeat(200)).length <= 80)
check('slugify survives having nothing to work with', slugify('!!!') === '')

check('a duration reads as minutes and seconds', formatDuration(125) === '2:05')
check('a long duration gains an hour', formatDuration(3725) === '1:02:05')
check('no duration reads as nothing', formatDuration(null) === null && formatDuration(0) === null)

console.log('\npublished means published')

async function main() {
  const now = new Date()
  const made: string[] = []

  const insert = async (
    name: string,
    values: Partial<typeof articles.$inferInsert>,
  ) => {
    const [row] = await db
      .insert(articles)
      .values({
        slug: slugFor(name),
        title: `Check ${name}`,
        body: 'Some words for the check.',
        ...values,
      })
      .returning()
    if (row) made.push(row.id)
    return row!
  }

  const live = await insert('live', {
    status: 'published',
    publishedAt: new Date(now.getTime() - 60_000),
  })
  const draft = await insert('draft', { status: 'draft' })
  const future = await insert('future', {
    status: 'published',
    publishedAt: new Date(now.getTime() + 7 * 86_400_000),
  })
  const archived = await insert('archived', {
    status: 'archived',
    publishedAt: new Date(now.getTime() - 86_400_000),
  })

  const listed = await listPublished(db, { limit: 200, now })
  const slugs = new Set(listed.map((a) => a.slug))

  check('a published piece is listed', slugs.has(live.slug))
  check('a draft is not listed', !slugs.has(draft.slug))
  check('a future-dated piece is not listed', !slugs.has(future.slug))
  check('an archived piece is not listed', !slugs.has(archived.slug))

  check('a published piece opens', Boolean(await getPublishedArticle(db, live.slug, now)))
  check('a draft 404s', (await getPublishedArticle(db, draft.slug, now)) === null)
  check('a future-dated piece 404s until its day', (await getPublishedArticle(db, future.slug, now)) === null)
  check('an archived piece 404s', (await getPublishedArticle(db, archived.slug, now)) === null)

  // ...and the same piece, on its day.
  const itsDay = new Date(future.publishedAt!.getTime() + 1000)
  check('a scheduled piece opens on its day', Boolean(await getPublishedArticle(db, future.slug, itsDay)))
  check('and is listed on its day', (await listPublished(db, { limit: 200, now: itsDay })).some((a) => a.slug === future.slug))

  const sitemapSlugs = new Set((await listPublishedSlugs(db, now)).map((s) => s.slug))
  check('the sitemap carries the published piece', sitemapSlugs.has(live.slug))
  check('the sitemap never carries a draft', !sitemapSlugs.has(draft.slug))
  check('the sitemap never carries a scheduled piece', !sitemapSlugs.has(future.slug))

  check('a taken slug is reported', await slugTaken(db, live.slug))
  check('a piece does not clash with itself', !(await slugTaken(db, live.slug, live.id)))
  check('a free slug is free', !(await slugTaken(db, slugFor('never-used'))))

  const episode = await insert('episode', {
    kind: 'episode',
    status: 'published',
    publishedAt: new Date(now.getTime() - 60_000),
    audioUrl: 'https://example.com/ep.mp3',
    audioDurationSeconds: 1800,
  })
  const episodes = await listPublished(db, { kind: 'episode', limit: 50, now })
  check('episodes can be listed on their own', episodes.some((a) => a.slug === episode.slug))
  check('and an article is not one of them', !episodes.some((a) => a.slug === live.slug))

  console.log('\nthe opt-in')

  {
    const address = emailFor('optin')
    const outcome = await subscribeFromArticle({
      data: { slug: live.slug, firstName: 'Ada', email: address },
      articleId: live.id,
      upgradeTag: 'writing-test-tag',
      archetype: null,
    })

    check('she can subscribe from a piece', outcome.ok)

    const [c] = await db
      .select({ id: contacts.id, source: contacts.acquisitionSource })
      .from(contacts)
      .where(eq(contacts.email, address))
      .limit(1)

    check('she exists as a lead', Boolean(c))
    check('her source records the piece', c?.source === `writing:${live.slug}`)

    const tagged = await db
      .select({ slug: tags.slug })
      .from(contactTags)
      .innerJoin(tags, eq(tags.id, contactTags.tagId))
      .where(eq(contactTags.contactId, c!.id))
      .then((rows) => rows.map((r) => r.slug))

    check('she is on the letters list', tagged.includes(LETTERS_TAG))
    check("and carries the piece's own tag", tagged.includes('writing-test-tag'))
    check('no sequence was started for a piece with no archetype', outcome.ok && !outcome.joinedSequence)
  }

  {
    const address = emailFor('archetype')
    const withArchetype = await insert('archetype-piece', {
      status: 'published',
      publishedAt: new Date(now.getTime() - 60_000),
      archetype: 'sulk',
    })

    const outcome = await subscribeFromArticle({
      data: { slug: withArchetype.slug, firstName: 'Bea', email: address },
      articleId: withArchetype.id,
      upgradeTag: null,
      archetype: 'sulk',
    })

    check('a piece about an archetype starts that sequence', outcome.ok && outcome.joinedSequence)

    const [c] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, address))
      .limit(1)

    const [sent] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailEvents)
      .where(eq(emailEvents.contactId, c!.id))

    check('and she is emailed straight away', (sent?.n ?? 0) >= 1)
  }

  console.log('\ntelling the list')

  {
    const address = emailFor('reader')
    const readerId = await findOrCreateLead(db, {
      email: address,
      firstName: 'Cara',
      source: 'test',
    })
    if (!readerId) throw new Error('could not create a contact')
    await tagContact(db, readerId, { slug: LETTERS_TAG, name: 'Letters' })

    check('the audience can be counted', (await lettersAudienceSize(db)) >= 1)

    const fresh = await insert('announce', {
      status: 'published',
      publishedAt: new Date(now.getTime() - 60_000),
      title: 'Something new to read',
    })

    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailEvents)
      .where(eq(emailEvents.contactId, readerId))
      .then((r) => r[0]?.n ?? 0)

    const first = await announceNewWriting(db, SITE, now, { limit: 50 })
    check('it announces the new piece', first.announced >= 1)

    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailEvents)
      .where(eq(emailEvents.contactId, readerId))
      .then((r) => r[0]?.n ?? 0)

    check('the reader was emailed', after > before)

    const [marked] = await db
      .select({ announcedAt: articles.announcedAt })
      .from(articles)
      .where(eq(articles.id, fresh.id))
      .limit(1)
    check('the piece is marked announced', Boolean(marked?.announcedAt))

    const second = await announceNewWriting(db, SITE, now, { limit: 50 })
    check('running it again announces nothing', second.announced === 0)

    const afterSecond = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailEvents)
      .where(eq(emailEvents.contactId, readerId))
      .then((r) => r[0]?.n ?? 0)
    check('and emails nobody twice', afterSecond === after)
  }

  {
    // Back-dating must be safe. Importing an archive cannot mail the list.
    const old = await insert('backdated', {
      status: 'published',
      publishedAt: new Date(now.getTime() - 40 * 86_400_000),
      title: 'An old piece being imported',
    })

    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailEvents)
      .then((r) => r[0]?.n ?? 0)

    const result = await announceNewWriting(db, SITE, now, { limit: 50 })

    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailEvents)
      .then((r) => r[0]?.n ?? 0)

    check('a back-dated piece is skipped, not sent', result.skipped >= 1)
    check('nobody was emailed about it', after === before)

    const [marked] = await db
      .select({ announcedAt: articles.announcedAt })
      .from(articles)
      .where(eq(articles.id, old.id))
      .limit(1)
    check('and it is marked so it is never reconsidered', Boolean(marked?.announcedAt))
  }

  {
    // An unsubscribed reader is not in the audience at all.
    const address = emailFor('optout')
    const id = await findOrCreateLead(db, { email: address, firstName: 'Dee', source: 'test' })
    if (!id) throw new Error('could not create a contact')
    await tagContact(db, id, { slug: LETTERS_TAG, name: 'Letters' })
    await db
      .update(contacts)
      .set({ emailOptedOutAt: new Date() })
      .where(eq(contacts.id, id))

    await insert('announce-2', {
      status: 'published',
      publishedAt: new Date(now.getTime() - 60_000),
      title: 'Another new piece',
    })
    await announceNewWriting(db, SITE, now, { limit: 50 })

    const [sent] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailEvents)
      .where(eq(emailEvents.contactId, id))

    check('an unsubscribed reader is never announced to', (sent?.n ?? 0) === 0)
  }

  console.log('\nthe admin door')

  {
    /*
     * A server action is its own endpoint.
     *
     * The admin layout returning 404 protects the PAGE. Anybody can POST to an
     * action without ever loading it, so every action that writes has to check
     * the role itself. Importing the module here is not possible — it pulls
     * next/navigation and therefore client React into a plain script — so this
     * reads the source instead and asserts the gate is the first thing each
     * exported action does.
     *
     * Crude, and it catches the exact mistake that matters: somebody adds a
     * fifth action next year and forgets.
     */
    const source = await readFile(
      new URL('../src/features/admin/writing-actions.ts', import.meta.url),
      'utf8',
    )

    const exported = [...source.matchAll(/export async function (\w+)\(/g)].map(
      (m) => m[1]!,
    )

    check('the writing actions are found', exported.length >= 2, exported.join(', '))

    const ungated = exported.filter((name) => {
      const at = source.indexOf(`export async function ${name}(`)
      // The gate has to be in the opening lines of the body, not somewhere
      // after the work has already been done.
      const opening = source.slice(at, at + 600)
      return !opening.includes('await requireAdmin()')
    })

    check('every action checks the role first', ungated.length === 0, ungated.join(', '))

    check(
      'and refuses when the check fails',
      (source.match(/You do not have access\./g) ?? []).length === exported.length,
    )

    check('every action writes to the audit log', source.includes('await audit('))
  }

  console.log('\ncleaning up')
  for (const id of made) await db.delete(articles).where(eq(articles.id, id))
  const leads = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(sql`${contacts.email} like ${'writing-check-' + stamp + '-%'}`)
  for (const c of leads) await db.delete(contacts).where(eq(contacts.id, c.id))

  const left = await db
    .select({ id: articles.id })
    .from(articles)
    .where(sql`${articles.slug} like ${'writing-check-' + stamp + '-%'}`)
  check('the test left nothing behind', left.length === 0)

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
