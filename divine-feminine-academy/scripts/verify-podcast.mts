/**
 * The podcast feed, and what a sync is allowed to touch.
 *
 * The show is hosted at RSS.com and that feed is what Apple and Spotify have,
 * so it owns the episodes. This site owns everything a feed has no concept of:
 * the transcript, which door an episode points a listener at, whether it is
 * featured. The single most important claim in this file is that a sync never
 * overwrites any of those — losing an hour of transcript because somebody
 * re-uploaded an episode is not a bug anybody would forgive.
 *
 * The fixture is shaped like a real RSS.com feed, including the things that
 * break hand-rolled parsers: CDATA show notes with markup in them, an
 * ampersand in a title, a duration as hh:mm:ss and another as plain seconds,
 * an episode with no audio at all.
 *
 * Run: DATABASE_URL=... npm run verify:podcast
 */
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { articles } from '../src/db/schema/content'
import { parseDuration, parseFeed } from '../src/features/podcast/feed'
import { syncFeed } from '../src/features/podcast/sync'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Brown Girls Need Healing Too</title>
    <link>https://rss.com/podcasts/brown-girls-need-healing-too/</link>
    <description>A conversation about what we carry.</description>
    <itunes:author>Quiana Blake</itunes:author>
    <itunes:image href="https://media.rss.com/art/show.jpg"/>
    <item>
      <title>Boundaries &amp; the guilt that follows</title>
      <guid isPermaLink="false">bgnht-0001</guid>
      <pubDate>Mon, 05 May 2026 09:00:00 +0000</pubDate>
      <description><![CDATA[<p>On saying no, and the forty-eight hours afterwards.</p>]]></description>
      <enclosure url="https://media.rss.com/audio/ep1.mp3" length="28311552" type="audio/mpeg"/>
      <itunes:duration>00:41:12</itunes:duration>
      <itunes:episode>1</itunes:episode>
      <itunes:season>1</itunes:season>
      <itunes:image href="https://media.rss.com/art/ep1.jpg"/>
    </item>
    <item>
      <title>Money and the part that is mine</title>
      <guid isPermaLink="false">bgnht-0002</guid>
      <pubDate>Mon, 12 May 2026 09:00:00 +0000</pubDate>
      <content:encoded><![CDATA[<p>Not a budgeting episode.</p>]]></content:encoded>
      <enclosure url="https://media.rss.com/audio/ep2.mp3" length="30000000" type="audio/mpeg"/>
      <itunes:duration>2570</itunes:duration>
      <itunes:episode>2</itunes:episode>
    </item>
    <item>
      <title>An episode with no audio</title>
      <guid isPermaLink="false">bgnht-0003</guid>
      <pubDate>Mon, 19 May 2026 09:00:00 +0000</pubDate>
      <description>Nothing attached.</description>
    </item>
  </channel>
</rss>`

console.log('\nreading the feed')

const feed = parseFeed(FEED)

check('the show is named', feed.show.title === 'Brown Girls Need Healing Too', feed.show.title)
check('the show artwork is found on the itunes tag', feed.show.artworkUrl === 'https://media.rss.com/art/show.jpg')
check('the author comes through', feed.show.author === 'Quiana Blake')
check('every item with a guid is read', feed.episodes.length === 3, String(feed.episodes.length))

{
  const first = feed.episodes[0]!
  check(
    'an ampersand in a title survives',
    first.title === 'Boundaries & the guilt that follows',
    first.title,
  )
  check('CDATA show notes keep their markup', first.descriptionHtml.includes('<p>'))
  check('the enclosure gives the audio url', first.audioUrl === 'https://media.rss.com/audio/ep1.mp3')
  check('and its size', first.audioBytes === 28311552)
  check('hh:mm:ss becomes seconds', first.durationSeconds === 2472, String(first.durationSeconds))
  check('the publish date parses', first.publishedAt?.getUTCFullYear() === 2026)
  check('episode artwork wins over show artwork', first.artworkUrl === 'https://media.rss.com/art/ep1.jpg')
  check('episode and season numbers', first.episodeNumber === 1 && first.seasonNumber === 1)
}

check('plain seconds also parse', feed.episodes[1]!.durationSeconds === 2570)
check('content:encoded is preferred for notes', feed.episodes[1]!.descriptionHtml.includes('Not a budgeting'))
check('a missing season is null, not zero', feed.episodes[1]!.seasonNumber === null)

console.log('\nduration formats')
check('mm:ss', parseDuration('41:12') === 2472)
check('hh:mm:ss', parseDuration('01:01:01') === 3661)
check('seconds', parseDuration('90') === 90)
check('nonsense is null rather than NaN', parseDuration('soon') === null)
check('absent is null', parseDuration(null) === null)

console.log('\nthe first sync')

for (const guid of ['bgnht-0001', 'bgnht-0002', 'bgnht-0003']) {
  await db.delete(articles).where(eq(articles.feedGuid, guid))
}

const first = await syncFeed(db, { feed })
check('two episodes land', first.added === 2, JSON.stringify(first))
check('the one with no audio is skipped, not invented', first.skipped === 1)
check('and the skip says why', first.errors.some((e) => e.includes('no audio')))

{
  const [row] = await db
    .select()
    .from(articles)
    .where(eq(articles.feedGuid, 'bgnht-0001'))
    .limit(1)
  check('it is stored as an episode', row?.kind === 'episode')
  check(
    'and PUBLISHED, because the feed is already public',
    row?.status === 'published',
    'importing a public episode as a draft hides something the world can already hear',
  )
  check('the slug reads like a url', row?.slug === 'boundaries-the-guilt-that-follows', row?.slug)
  check('duration is stored in seconds', row?.audioDurationSeconds === 2472)
}

console.log('\nrunning it again changes nothing')

const second = await syncFeed(db, { feed })
check('nothing is added twice', second.added === 0, JSON.stringify(second))
check('both are seen as unchanged', second.unchanged === 2)

console.log('\nwhat the sync must never touch')

{
  const [row] = await db
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.feedGuid, 'bgnht-0001'))
    .limit(1)

  // The work a person does here, which exists nowhere in any feed.
  await db
    .update(articles)
    .set({
      transcript: 'A full transcript somebody spent an hour on.',
      ctaProgramSlug: 'me-vs-her',
      featuredAt: new Date('2026-06-01T00:00:00Z'),
      area: 'relationships',
      upgradeHeadline: 'A line written for this episode',
    })
    .where(eq(articles.id, row!.id))

  // And the feed changes, as it does when a typo is fixed at the host.
  const edited = parseFeed(FEED.replace('Boundaries &amp; the guilt that follows', 'Boundaries, and the guilt that follows'))
  const third = await syncFeed(db, { feed: edited })
  check('a changed title is picked up', third.updated === 1, JSON.stringify(third))

  const [after] = await db
    .select()
    .from(articles)
    .where(eq(articles.feedGuid, 'bgnht-0001'))
    .limit(1)

  check('the new title is stored', after?.title === 'Boundaries, and the guilt that follows')
  check('THE TRANSCRIPT SURVIVES', after?.transcript === 'A full transcript somebody spent an hour on.')
  check('the episode still points at its own door', after?.ctaProgramSlug === 'me-vs-her')
  check('it is still featured', after?.featuredAt !== null)
  check('its area is untouched', after?.area === 'relationships')
  check('and the line written for it', after?.upgradeHeadline === 'A line written for this episode')
  check(
    'the slug did NOT move with the title',
    after?.slug === 'boundaries-the-guilt-that-follows',
    'a renamed episode must not break every link anybody shared',
  )
}

for (const guid of ['bgnht-0001', 'bgnht-0002', 'bgnht-0003']) {
  await db.delete(articles).where(eq(articles.feedGuid, guid))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
