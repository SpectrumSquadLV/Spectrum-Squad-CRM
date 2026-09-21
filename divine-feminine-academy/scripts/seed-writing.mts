/**
 * Seeds three example pieces, AS DRAFTS.
 *
 * Drafts on purpose. These are written to give the engine something real to
 * render and to show the shape of a piece that does its job — a standfirst, an
 * area, an archetype, an opt-in that leads somewhere. They are not her voice
 * and nothing written by a machine should appear under her name without her
 * having read it, so nothing here is public until she presses Publish.
 *
 * SEED_PUBLISH=1 publishes them instead, which is what the tests and a local
 * look-around want.
 *
 * Idempotent: re-running updates the same three by slug rather than making
 * more of them.
 *
 * Run: DATABASE_URL=... npm run seed:writing
 */
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { articles } from '../src/db/schema/content'

const publish = process.env.SEED_PUBLISH === '1'

type Seed = {
  slug: string
  title: string
  dek: string
  area: 'herself' | 'relationships' | 'success' | 'money'
  archetype: 'fight' | 'flight' | 'freeze' | 'sulk'
  upgradeHeadline: string
  upgradeBlurb: string
  upgradeTag: string
  body: string
}

const pieces: Seed[] = [
  {
    slug: 'the-cost-of-being-the-capable-one',
    title: 'The cost of being the capable one',
    dek: 'Everybody calls you. Nobody checks on you. Here is how that happened, and what it is quietly taking.',
    area: 'herself',
    archetype: 'fight',
    upgradeHeadline: 'Five emails for the capable one',
    upgradeBlurb:
      'Where she came from, what she is costing you, and the one move that puts her down. Free, and nothing to buy in any of them.',
    upgradeTag: 'writing-commander',
    body: `There is a particular kind of tiredness that does not show.

It is not the tiredness of a long week. It is the tiredness of being the person who handles it — every time, for everyone, without being asked and without being thanked, because at some point handling it stopped being a thing you did and became a thing you are.

## How she got here

Nobody becomes this capable for free.

Somewhere behind the woman who takes over the moment something wobbles, there is a younger one who worked out that if she did not do it, it would not get done. She was probably right. That is the part people skip when they tell you to let go — they talk as though the belief was irrational.

Usually it was not. It was accurate. And then at some point it stopped being accurate, and nobody thought to tell her.

> Control was, at some point, the only thing that kept you safe. So now being out of control does not feel uncomfortable. It feels dangerous.

## What it actually costs

Not the workload. You can carry the workload — you have proved that for years, and some part of you is proud of it.

What it costs is:

- Help, which now arrives feeling like an accusation.
- Softness, which now feels like exposure.
- Being looked after, which now feels like being caught.

The people who love you are standing outside a door you keep telling them is not locked.

## What to do about it today

Let one thing be done badly by somebody else, on purpose, and do not fix it.

Something small. The dishwasher. A document. A message you would have rewritten. Your whole body will tell you this is unsafe — it is not unsafe, it is unfamiliar, and from the inside those two are identical.

What you are practising is not delegation. It is surviving the discomfort of not being the one in charge, which is a muscle that has never once been trained.`,
  },
  {
    slug: 'almost-ready-is-a-decision',
    title: 'Almost ready is a decision',
    dek: 'You are not procrastinating. You are waiting for a signal that does not exist.',
    area: 'money',
    archetype: 'freeze',
    upgradeHeadline: 'Five emails for the one who is almost ready',
    upgradeBlurb:
      'Why stillness is the oldest safety there is, what it is quietly costing, and how to move at sixty per cent. Free.',
    upgradeTag: 'writing-watcher',
    body: `You have the folder. The drafts. The screenshots. You have read more about this than most of the people currently doing it.

And you have not started.

## This is not laziness

Call it that one more time and see if it helps. It will not, because it is not true.

Stillness is the oldest safety there is. Somewhere you learned that being seen getting something wrong was dangerous — a laugh, a look, one adult who was difficult to predict — and you drew an extremely sensible conclusion: **do not move until you are sure.**

Then you got very good at the part that comes before moving.

## The signal is not coming

Here is the trap. Certainty is not a feeling that arrives once you have read enough. It arrives *afterwards*, from having done the thing badly and survived.

So the condition you are waiting for is produced by the action you are waiting to be certain enough to take.

> The life you are researching is being lived by women with half your thought and twice your nerve.

## Sixty per cent, where somebody can see

Take the smallest version of the thing you have been almost-doing. Set a timer for ten minutes. Finish before the timer does.

1. It will not be good.
2. That is not an unfortunate side effect of the exercise. That is the exercise.
3. Do it where one other person can see it.

What you are practising is being witnessed being imperfect and surviving it — which is the evidence your nervous system has been missing for about twenty years.`,
  },
  {
    slug: 'i-am-fine-and-other-things-that-are-not-true',
    title: 'I am fine, and other things that are not true',
    dek: 'On going quiet, keeping score, and the one sentence that breaks the pattern.',
    area: 'relationships',
    archetype: 'sulk',
    upgradeHeadline: 'Five emails for the one who went quiet',
    upgradeBlurb:
      'Why asking stopped working, what the silence is costing, and the sentence that ends it. Free.',
    upgradeTag: 'writing-quiet-storm',
    body: `"It's fine."

It is not fine. Everybody in the room knows it is not fine. That is, in a way, the point — because saying it out loud would mean asking, and asking is the thing that stopped being safe.

## You did ask. Once.

Somewhere behind the woman who goes short and polite and very, very quiet, there is a younger one who said what she wanted plainly and did not get it.

Possibly more than once. Possibly from somebody who was supposed to be safe.

So she made a quiet decision that seemed entirely reasonable at the time: **if they cared, they would know without being told. And if they have to be told, it does not count.**

## The problem with that rule

It protects you from ever being refused again.

It also makes it nearly impossible for anybody to get it right, because nobody can pass a test they were never told they were sitting.

> Going quiet is not manipulation. It is what asking turns into when asking stopped working.

## The ledger

You could recite it right now. Every time you gave more than you had. Every time nobody noticed.

That is not a small thing to carry around all day, and it is quietly eating the relationships you are trying to protect.

## One sentence

Find one thing you are quietly angry about. Write the sentence you actually mean, and start it with **I wanted**.

Not "you never". Not "it's fine". I wanted.

You do not have to send it to anybody. You have to admit it — because a want you will not name cannot be met by anyone, including you.`,
  },
]

async function main() {
  let created = 0
  let updated = 0

  for (const piece of pieces) {
    const values = {
      slug: piece.slug,
      kind: 'article' as const,
      status: (publish ? 'published' : 'draft') as 'published' | 'draft',
      title: piece.title,
      dek: piece.dek,
      body: piece.body,
      authorName: 'Divine Feminine',
      area: piece.area,
      archetype: piece.archetype,
      upgradeHeadline: piece.upgradeHeadline,
      upgradeBlurb: piece.upgradeBlurb,
      upgradeTag: piece.upgradeTag,
      publishedAt: publish ? new Date() : null,
      updatedAt: new Date(),
    }

    const [existing] = await db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.slug, piece.slug))
      .limit(1)

    if (existing) {
      await db.update(articles).set(values).where(eq(articles.id, existing.id))
      updated++
    } else {
      await db.insert(articles).values(values)
      created++
    }
  }

  console.log(
    `writing: ${created} created, ${updated} updated, as ${publish ? 'PUBLISHED' : 'drafts'}`,
  )
  if (!publish) {
    console.log('they are drafts: nothing is public until you press Publish')
  }
  console.log('these are examples in somebody else’s voice — edit them or delete them')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
