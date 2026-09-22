import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { contacts } from '@/db/schema'
import { getChallengeState } from '@/db/queries/challenge'
import { choiceSummary, journalSummary } from '@/db/queries/her'
import { Aperture } from '@/features/academy/Aperture'
import { library } from '@/features/academy/library'
import { LibraryEntry, type EntryProgress } from '@/features/academy/LibraryEntry'
import { Place } from '@/features/academy/Place'
import { Reveal } from '@/features/academy/Reveal'
import { EnrollButton } from '@/features/challenge/EnrollButton'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

const PROGRAM = 'me-vs-her'

/**
 * DIVINE FEMININE. The place she has entered.
 *
 * This page used to open on "Day 3 is open. About twenty minutes." and that
 * one line was the whole problem with it. It made the platform the authority
 * and the woman the person being taken somewhere - and it quietly declared
 * that the product IS a seven-day course, since the course was the page and
 * everything else was two cards at the bottom.
 *
 * The philosophy underneath Divine Feminine is the opposite. HER already
 * exists. Nothing here manufactures a new woman; it makes visible what is
 * already true. A place built on that cannot open by telling her what to do
 * next, because being told what to do next is the experience of being led,
 * and she is not being led anywhere. She has arrived somewhere that is hers.
 *
 * So the order of the page is the argument:
 *
 *   1. Her name, and one statement. No instruction.
 *   2. THE LIBRARY - what is here to enter.
 *   3. HER, and her private pages - what is already hers.
 *
 * The next day is still one tap away, and for a woman mid-challenge the open
 * numeral is the most legible thing in the library entry. Nothing was made
 * harder to reach. It simply stopped being the first thing the platform says
 * to her.
 *
 * WHAT DID NOT CHANGE, deliberately: enrollment, the twenty-four hour locks,
 * test mode, every route, the curriculum, HER, the journal, and every policy
 * check behind them. This is presentation. The engine underneath is the one
 * that was already verified.
 */
export default async function DivineFemininePage() {
  const actor = await getActor()
  const ctx = await getQueryContext()
  const contactId = actor.kind === 'user' ? actor.contactId : null

  let firstName: string | null = null
  if (contactId) {
    const [contact] = await db
      .select({ firstName: contacts.firstName })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1)
    firstName = contact?.firstName ?? null
  }

  const state = contactId
    ? await getChallengeState(ctx, contactId, PROGRAM)
    : null
  const choices = contactId
    ? await choiceSummary(ctx, contactId)
    : { total: 0, byArea: [] }
  const journal = contactId
    ? await journalSummary(ctx, contactId)
    : { entries: 0, words: 0 }

  const progress: EntryProgress | null = state
    ? {
        total: state.durationDays,
        completed: state.completed,
        unlockedThrough: state.unlock.unlockedThrough,
        current: state.unlock.currentDay,
        isComplete: state.unlock.isComplete,
      }
    : null

  const meVsHer = library[0]!

  /*
   * Where ENTER goes.
   *
   * Into the open day when there is one, because that is the room she is
   * standing in - not into an index page that then asks her to click the day.
   * Once the seven are done it goes to the tool, which is the part of ME VS.
   * HER that was always meant to outlive the challenge.
   */
  const dayIsOpen =
    state !== null && state.unlock.currentDay <= state.unlock.unlockedThrough
  const entryHref = !state
    ? meVsHer.href
    : state.unlock.isComplete
      ? '/my-academy/me-vs-her/tool'
      : dayIsOpen
        ? `/my-academy/${PROGRAM}/day/${state.unlock.currentDay}`
        : '/my-academy/her'

  const entryAction = !state
    ? 'Enter'
    : state.unlock.isComplete
      ? 'Enter'
      : dayIsOpen
        ? 'Enter'
        : 'Return to what you have named'

  return (
    <div className="mx-auto max-w-3xl px-5 py-16 md:px-8 md:py-24">
      {/* ------------------------------------------------ the opening */}
      <Reveal>
        <p className="text-2xs uppercase tracking-[0.22em] text-ink-muted">
          {firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
        </p>
      </Reveal>

      {/*
        ONE statement, at the largest scale on the site, and no instruction
        under it. The temptation is to follow it with a line explaining what
        to do; the restraint IS the design. A woman who reads this and then
        chooses where to go has had the experience the page is for.
      */}
      <Reveal delay={1}>
        <h1 className="mt-6 max-w-[16ch] font-display text-4xl leading-[1.04] text-ink md:text-5xl">
          Nothing here creates her.
          <br />
          <span className="text-plum">It reveals her.</span>
        </h1>
      </Reveal>

      {/* ------------------------------------------------ the library */}
      <Reveal delay={2}>
        <div className="mt-20 flex items-center gap-4 md:mt-28">
          <h2 className="text-2xs uppercase tracking-[0.22em] text-ink-muted">
            The library
          </h2>
          <span className="h-px flex-1 bg-rule" aria-hidden />
        </div>
      </Reveal>

      <Reveal delay={3}>
        <div className="mt-10">
          {progress === null && !state ? (
            <UnenteredEntry />
          ) : (
            <LibraryEntry
              entry={meVsHer}
              progress={progress}
              href={entryHref}
              action={entryAction}
            />
          )}
        </div>
      </Reveal>

      {/*
        The room the library will grow into.
        
        Air and a hairline, and no placeholder cards. Greyed-out tiles for work
        that does not exist would be the fastest way to make a library of one
        look like a shop with nothing in it - and would be a promise of
        specific things nobody has written yet.
      */}
      <Reveal delay={4}>
        <div className="mt-16 flex items-center gap-5 md:mt-20">
          <span className="h-px flex-1 bg-rule" aria-hidden />
          <Aperture size={26} className="opacity-75" />
          <span className="h-px flex-1 bg-rule" aria-hidden />
        </div>
      </Reveal>

      {/* ------------------------------------------------ what is hers */}
      <Reveal delay={5}>
        <div className="mt-16 space-y-12 md:mt-20">
          <Place
            title="HER"
            line="She is not someone you are becoming. She is what becomes visible when you stop hiding her."
            action="Enter her"
            href="/my-academy/her"
            standing={
              choices.total > 0
                ? `Chosen ${choices.total} time${choices.total === 1 ? '' : 's'}`
                : null
            }
          />

          <Place
            title="The private pages"
            line="Some things are meant to be written before they are ready to be spoken."
            action="Open"
            href="/my-academy/journal"
            standing={
              journal.entries > 0
                ? `${journal.entries} page${journal.entries === 1 ? '' : 's'}`
                : null
            }
          />
        </div>
      </Reveal>

      {/*
        THE PRIVACY LINE, corrected.
        
        This used to read "Encrypted. Only you can read it - that includes us."
        The second half was not true. Every woman's entries are encrypted under
        a key of her own, and that key is wrapped with a master key the server
        holds - which is what lets her read her pages on a new device without
        ever being handed a passphrase to lose. It also means the claim "not
        even us" describes end-to-end encryption this does not have.
        
        What IS true is worth saying plainly and is said plainly: her own key,
        and no staff screen anywhere in the product that can read a word. The
        line below claims exactly that and not one word further. A privacy
        promise a woman would be right to doubt is worse than a smaller one she
        can rely on, and she is writing about her childhood in there.
      */}
      <Reveal delay={6}>
        <p className="mt-10 text-2xs leading-relaxed text-ink-muted">
          Your pages are encrypted with a key of your own. No admin screen in
          Divine Feminine can read them.
        </p>
      </Reveal>
    </div>
  )
}

/**
 * She has not entered ME VS. HER yet.
 *
 * Still an invitation rather than an instruction, and the enrollment action
 * itself is untouched - the same EnrollButton, the same server action, the
 * same enrollment row.
 */
function UnenteredEntry() {
  const entry = library[0]!
  return (
    <article>
      <p className="text-2xs uppercase tracking-[0.22em] text-ink-muted">
        {entry.measure}
      </p>
      <h3 className="mt-3 font-display text-3xl leading-[1.05] text-ink md:text-4xl">
        {entry.title}
      </h3>
      <p className="measure mt-5 text-base leading-relaxed text-ink-soft">
        {entry.line}
      </p>
      <EnrollButton className="mt-8" programSlug={PROGRAM} />
    </article>
  )
}
