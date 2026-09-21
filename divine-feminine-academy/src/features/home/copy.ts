/**
 * THE PAIN, IN QUIANA'S WORDS.
 *
 * Behaviours only. No explanation, no diagnosis, no "because you don't love
 * yourself" — the woman reading has to recognise herself before anybody tells
 * her what it means. That is the whole mechanism of this section and it is
 * why every line below is something she DOES rather than something she is.
 *
 * This file is the complete bank, not the home page. Quiana's instruction was
 * explicit: the sharpest five to eight per area go on the site so the section
 * has rhythm, and the rest stay here. Four blocks of twenty lines is
 * exhausting to read and the recognition stops landing about a third of the
 * way down.
 *
 * So each line carries `home`. The ones marked with it render; the rest are
 * the content bank — TikTok, podcast episodes, emails, challenge pages, ads.
 * Changing the home page selection is flipping a flag, not moving text
 * around, so the bank can never drift from what the site shows.
 *
 * `npm run content-bank` writes docs/content-bank.md from this file, which is
 * the version to read on a phone.
 *
 * DUTY OF CARE, which is not a style note.
 * No line here may imply a woman caused abuse, trauma, illness, poverty,
 * discrimination, other people's behaviour, or anything else outside her
 * control. Every one of these is about the part of a pattern that belongs to
 * her, because that is the part she can reach. None of it is about blame.
 */

export type HomeArea = 'love' | 'wealth' | 'self' | 'life'

export interface PainLine {
  text: string
  /** On the home page. Five to eight per area, chosen for rhythm. */
  home?: true
}

export interface PainBlock {
  /** The single word, set at display size. */
  word: string
  /** The area hue, for the hairline. Never a coloured card. */
  area: HomeArea
  lines: readonly PainLine[]
}

/**
 * The four, in the order the storyboard sets: love, money, success, then
 * manifestation — which lands last because it is the one that reframes the
 * other three.
 */
export const pain: readonly PainBlock[] = [
  {
    word: 'Love',
    area: 'love',
    lines: [
      { text: 'You reread the text before you send it.', home: true },
      { text: 'You check whether they’ve watched your story.', home: true },
      { text: 'You notice their response time has changed.' },
      {
        text: 'You send another message because the silence is making you uncomfortable.',
        home: true,
      },
      { text: 'You accept attention whenever they decide to give it.' },
      {
        text: 'You say you’re okay with something because you’re afraid asking for more will make them leave.',
      },
      { text: 'You explain the same boundary more than once.' },
      {
        text: 'You keep giving chances after you’ve already decided something isn’t acceptable.',
      },
      {
        text: 'You chase conversations with people who have already shown you they don’t want to have them.',
      },
      {
        text: 'You look for evidence that they still care after their behaviour has already hurt you.',
      },
      {
        text: 'You check their page even though you know it’s going to upset you.',
      },
      {
        text: 'You ask your friends what they think their text meant.',
        home: true,
      },
      {
        text: 'You start listing everything wrong with them the minute you feel rejected.',
      },
      {
        text: 'You threaten to cut them off instead of saying, “That hurt me.”',
      },
      { text: 'You go quiet and wait to see whether they notice.', home: true },
      { text: 'You keep score.', home: true },
      {
        text: 'You give more because you’re hoping they’ll eventually give more back.',
      },
      {
        text: 'You stay available to people who are only available when it’s convenient for them.',
        home: true,
      },
      { text: 'You change what you need to keep the relationship.' },
      {
        text: 'You try to convince someone to understand your value instead of noticing how they’re treating you.',
      },
      { text: 'You mistake being wanted for being valued.', home: true },
      {
        text: 'You let someone’s decision not to choose you become a conversation about whether you’re good enough.',
      },
    ],
  },
  {
    word: 'Money',
    area: 'wealth',
    lines: [
      {
        text: 'You avoid checking your bank account until you absolutely have to.',
        home: true,
      },
      {
        text: 'You check your bank account over and over because seeing the number temporarily makes you feel safe.',
      },
      { text: 'You spend money when you’re upset.', home: true },
      {
        text: 'You buy something because you want to feel like the woman who can afford it.',
      },
      {
        text: 'You buy the image of success before you’ve built the financial structure to support it.',
      },
      {
        text: 'You say “I deserve it” when what you really mean is “I need to feel better right now.”',
        home: true,
      },
      {
        text: 'You make more money and immediately find somewhere for it to go.',
        home: true,
      },
      { text: 'You get extra money and treat it like it has to be spent.' },
      { text: 'You put off opening bills.' },
      { text: 'You avoid looking at exactly how much debt you have.' },
      {
        text: 'You tell yourself you’ll start managing your money when you make more.',
      },
      {
        text: 'You undercharge and then resent how much you’re giving.',
        home: true,
      },
      { text: 'You hesitate before saying your price.', home: true },
      {
        text: 'You lower your price before anyone has even told you no.',
        home: true,
      },
      {
        text: 'You do extra work you weren’t paid for because saying no feels uncomfortable.',
      },
      { text: 'You spend money to look successful.' },
      {
        text: 'You rescue other people financially and then become anxious about your own money.',
      },
      {
        text: 'You feel guilty keeping money when someone you love needs something.',
      },
      {
        text: 'You make a financial decision based on how it will look to other people.',
      },
      {
        text: 'You use buying something as proof that you’re finally doing well.',
      },
      {
        text: 'You reach a new income level and immediately create a new number you need to hit before you’ll feel secure.',
        home: true,
      },
    ],
  },
  {
    word: 'Success',
    area: 'life',
    lines: [
      {
        text: 'You have an idea and immediately think about what everyone else will think of it.',
      },
      {
        text: 'You ask three people what they think before trusting the answer you already had.',
        home: true,
      },
      {
        text: 'You keep explaining your decision after you’ve already made it.',
      },
      { text: 'You change direction because someone questioned you.' },
      { text: 'You wait until you feel completely ready.', home: true },
      {
        text: 'You keep researching something you already know enough to begin.',
      },
      { text: 'You rewrite the post instead of publishing it.', home: true },
      { text: 'You save the video to drafts.', home: true },
      {
        text: 'You make the offer smaller because you’re afraid nobody will buy the bigger one.',
        home: true,
      },
      {
        text: 'You wait for another certification, degree, course, mentor, strategy or sign before allowing yourself to move.',
      },
      {
        text: 'You compare your beginning to somebody else’s finished product.',
      },
      {
        text: 'You accomplish the thing and immediately start talking about the next thing.',
        home: true,
      },
      { text: 'You dismiss your wins because they weren’t big enough.' },
      {
        text: 'You hit the number you said would make you feel successful and move the number.',
        home: true,
      },
      {
        text: 'You work harder when what you actually need to do is make a decision.',
      },
      {
        text: 'You stay busy doing things that feel productive so you don’t have to do the thing that could actually expose you to rejection.',
      },
      {
        text: 'You make yourself easier to understand instead of allowing people to misunderstand you.',
      },
      {
        text: 'You shrink an idea after someone doesn’t immediately understand the vision.',
      },
      {
        text: 'You wait for someone else’s confidence in you before fully trusting your own.',
      },
      {
        text: 'You keep trying to prove you’re capable instead of operating like you already know you are.',
        home: true,
      },
    ],
  },
  {
    word: 'Manifestation',
    area: 'self',
    lines: [
      {
        text: 'You make the vision board and keep making the same choices.',
        home: true,
      },
      {
        text: 'You write the affirmation and spend the rest of the day looking for evidence that it isn’t true.',
        home: true,
      },
      {
        text: 'You visualise the relationship you want and keep answering the person giving you the relationship you don’t want.',
      },
      {
        text: 'You say you want more money and keep avoiding your money.',
        home: true,
      },
      {
        text: 'You say you want the opportunity and talk yourself out of being seen.',
      },
      {
        text: 'You ask for a sign after you’ve already gotten the answer you didn’t want.',
      },
      {
        text: 'You keep asking for another sign because you don’t like the first one.',
        home: true,
      },
      {
        text: 'You say, “I knew this was going to happen,” every time something confirms what you were already afraid of.',
        home: true,
      },
      {
        text: 'You remember every time it went wrong and barely register the times it didn’t.',
      },
      {
        text: 'You expect someone to disappoint you and start watching for the moment they do.',
      },
      {
        text: 'You enter the new relationship looking for the old relationship.',
        home: true,
      },
      { text: 'You enter the new opportunity expecting the old rejection.' },
      {
        text: 'You get what you asked for and immediately start worrying about losing it.',
        home: true,
      },
      {
        text: 'You say you want more and feel guilty when more actually arrives.',
      },
      {
        text: 'You ask for abundance and become uncomfortable receiving without earning, proving or suffering first.',
      },
      {
        text: 'You say you’re waiting for alignment when you’re actually waiting until the decision stops being scary.',
      },
      { text: 'You confuse familiarity with intuition.' },
      {
        text: 'You keep trying to change your thoughts without changing the choices that keep reinforcing them.',
      },
      {
        text: 'You consume more manifestation content instead of examining the pattern you’re repeating.',
      },
      {
        text: 'You keep asking, “Why does this keep happening to me?” without asking, “What do I keep doing when this happens?”',
        home: true,
      },
    ],
  },
]

/**
 * Where the pain section stops.
 *
 * Deliberately not one of the Manifestation lines. It is the sentence the
 * other eighty are building to, it names ME and HER for the first time on the
 * page, and it is what earns the reframe that follows. It gets its own space.
 */
export const painClose =
  'You keep trying to create HER life while allowing ME to make the decisions.'

/** The lines that actually render, per block. */
export function homeLines(block: PainBlock): readonly PainLine[] {
  return block.lines.filter((line) => line.home)
}

export const painIsWritten = pain.some(
  (block) => homeLines(block).length > 0,
)

/**
 * The after.
 *
 * Same rules as the pain: behaviours, present tense, second person. Still
 * empty, because it has not been written yet — the section does not render
 * until it is, so the page reads from the photograph straight into the Divine
 * Feminine rather than showing a stranger a gap.
 */
export const possibility: readonly PainBlock[] = [
  { word: 'Love', area: 'love', lines: [] },
  { word: 'Money', area: 'wealth', lines: [] },
  { word: 'Success', area: 'life', lines: [] },
  { word: 'Receiving', area: 'self', lines: [] },
]

export const possibilityIsWritten = possibility.some(
  (block) => homeLines(block).length > 0,
)

/** The hairline colour for each area. Thin rules and small marks only. */
export const areaRule: Record<HomeArea, string> = {
  love: 'border-area-love',
  wealth: 'border-area-wealth',
  self: 'border-area-self',
  life: 'border-area-life',
}
