/**
 * The four archetype email sequences.
 *
 * Five emails over nine days, one set per protective mode. This file is THE
 * COPY — no HTML, no sending, no database. Rewrite it and the emails change.
 *
 * The arc is the same for all four, and it is in this order for a reason:
 *
 *   1. day 0 — deliver. She just gave an email; she gets the whole read back,
 *      immediately, with nothing asked of her.
 *   2. day 1 — where this version of her came from. Compassion before cost,
 *      always. Naming the behaviour before naming its origin reads as an
 *      accusation.
 *   3. day 3 — what it costs. Honest and specific. She already knows; being
 *      vague about it to seem kind is patronising, and she can tell.
 *   4. day 5 — one small move she can make today. A win before an ask.
 *   5. day 8 — the invitation. Eleven dollars, said plainly.
 *
 * Rules this copy follows, which matter more than the individual words:
 *
 *   - Never shame the mode. It is protection that worked. A woman who feels
 *     diagnosed unsubscribes; a woman who feels understood replies.
 *   - Never manufacture urgency. There is nothing being sold here and no
 *     timer, so inventing one would be a lie she would eventually notice.
 *   - Say what is coming next. "Four more over the next week, nothing to buy"
 *     is why she keeps opening them.
 *   - Short paragraphs. She is reading this on a phone, probably between
 *     things.
 *
 * `{{firstName}}` is the only token. It falls back to "you" phrasing that
 * still reads if she never gave a name.
 */

import type { ProtectiveMode } from './archetypes'

export interface SequenceEmail {
  /** 1-5. Part of the idempotency key, so it must never be reused. */
  step: number
  /** Days after she joined the sequence. */
  afterDays: number
  subject: string
  /** The grey line next to the subject in her inbox. */
  preview: string
  heading: string
  paragraphs: string[]
  cta?: { label: string; path: string }
}

export const FIRST_NAME_TOKEN = '{{firstName}}'

export const sequences: Record<ProtectiveMode, SequenceEmail[]> = {
  /* ------------------------------------------------------------------ */
  fight: [
    {
      step: 1,
      afterDays: 0,
      subject: 'You are The Commander',
      preview: 'The one who handles it. Here is the whole read.',
      heading: 'Meet your ME.',
      paragraphs: [
        `${FIRST_NAME_TOKEN}, the version of ME running your show is The Commander — the version of you who gets bigger, faster and more capable the second something threatens you. And does it alone.`,
        'You already know the behaviour. What you might not know is that she is not the enemy, and what she is for.',
        'Control was, at some point, the only thing that kept you safe. So now being out of control does not feel uncomfortable to you. It feels dangerous. That is not a character flaw, it is a nervous system doing exactly what it learned to do.',
        'Your competence is not a performance. It is a shield you have carried so long you forgot you were holding something.',
        'Four more of these over the next week: where she came from, what she costs you, and the one move that puts her down. There is nothing to buy in any of them.',
      ],
      cta: { label: 'Read your full result', path: '/quiz/the-commander' },
    },
    {
      step: 2,
      afterDays: 1,
      subject: 'Nobody gets this capable for free',
      preview: 'She was not born. She was built.',
      heading: 'She was not born. She was built.',
      paragraphs: [
        'Somewhere behind The Commander is a younger version of you who worked out that if she did not handle it, nobody would.',
        'She was probably right.',
        'That is the part people skip when they tell you to let go — they talk as though the belief was irrational. Usually it was not. It was accurate, and then at some point it stopped being accurate, and nobody thought to tell her.',
        'So she is still on duty. Still scanning the room. Still certain that the moment she sits down, the whole thing comes apart.',
        'You do not argue a woman like that off her post. You show her the room is different now — and that takes evidence, repeated, over time.',
      ],
    },
    {
      step: 3,
      afterDays: 3,
      subject: 'The part nobody sees',
      preview: 'Not the workload. The company.',
      heading: 'What she costs you.',
      paragraphs: [
        `Here is the honest version, ${FIRST_NAME_TOKEN}.`,
        'You are tired in a way that does not show, because you have trained everybody around you to believe you do not need anything.',
        'Help feels like an accusation. Softness feels like exposure. Being looked after feels like being caught.',
        'And the people who love you are standing outside a door you keep telling them is not locked.',
        'That is the cost. Not the workload — you can carry the workload, you have proved that. The company.',
        'Nothing to do with that today. Just notice whether it is true.',
      ],
    },
    {
      step: 4,
      afterDays: 5,
      subject: 'Let one thing be done badly',
      preview: 'On purpose. And do not fix it.',
      heading: 'The one move.',
      paragraphs: [
        'Let one thing be done badly by somebody else, on purpose, and do not fix it.',
        'Something small. The dishwasher. A document. A message you would have rewritten.',
        'Your whole body is going to tell you this is unsafe. It is not unsafe. It is unfamiliar — and from the inside those two feel identical.',
        'What you are actually practising is not delegation. It is surviving the discomfort of not being the one in charge, which is the muscle that has never once been trained.',
        'One thing. Today.',
      ],
      cta: { label: 'The rest of the return', path: '/quiz/the-commander' },
    },
    {
      step: 5,
      afterDays: 8,
      subject: 'Seven days, one small thing a day',
      preview: 'You do not fire her. You give her somewhere to sit.',
      heading: 'You do not get rid of her.',
      paragraphs: [
        'She saved you once. You do not fire her.',
        'You learn to notice her arriving — and you build somewhere else to go when she does.',
        'That is the whole of ME VS HER. Seven days, one small thing a day, at your own pace. You write it down, it stays yours, and nobody else reads it.',
        'Day one is naming her. Day six is the one that tends to get people.',
        'It is eleven dollars — less than the coffee you will drink while doing Day 1. And if it is not for you, it is not for you: that is a real answer, and there is a refund window for exactly that reason.',
      ],
      cta: { label: 'Start ME VS HER', path: '/me-vs-her' },
    },
  ],

  /* ------------------------------------------------------------------ */
  flight: [
    {
      step: 1,
      afterDays: 0,
      subject: 'You are The Escape Artist',
      preview: 'The one who finds the exit. Here is the whole read.',
      heading: 'Meet your ME.',
      paragraphs: [
        `${FIRST_NAME_TOKEN}, the version of ME running your show is The Escape Artist — the version of you who finds the exit before anything can find her. A new plan, a new city, a new version of your life.`,
        'You already know the behaviour. What you might not know is that she is not the enemy, and what she is for.',
        'At some point staying cost you something you could not afford. So leaving became the fastest route back to safety, and your body filed it away as the answer.',
        'You are not flaky. You are fast. And you learned to be fast because being trapped once nearly finished you.',
        'Four more of these over the next week: where she came from, what she costs you, and the one move that lets you stay. There is nothing to buy in any of them.',
      ],
      cta: { label: 'Read your full result', path: '/quiz/the-escape-artist' },
    },
    {
      step: 2,
      afterDays: 1,
      subject: 'Leaving used to be the clever move',
      preview: 'It was not cowardice. It was accurate.',
      heading: 'It was not cowardice.',
      paragraphs: [
        'Somewhere behind The Escape Artist is a younger version of you who could not get out of something, and paid for it.',
        'So she got very good at seeing doors. Where they are, how fast they open, what it would take to be through one before anybody noticed she was going.',
        'That skill was not weakness. It was accurate, and at the time it may have been the most intelligent thing about her.',
        'The trouble is that a woman who is always half-out of a room never fully arrives in one.',
        'And she cannot tell the difference between a room she should leave and a room that is simply asking more of her than she is used to giving.',
      ],
    },
    {
      step: 3,
      afterDays: 3,
      subject: 'A history of beginnings',
      preview: 'Almost no endings you actually chose.',
      heading: 'What she costs you.',
      paragraphs: [
        `Here is the honest version, ${FIRST_NAME_TOKEN}.`,
        'Nothing ever gets deep enough to hold you.',
        'You have a history full of beginnings — brilliant ones, the kind other people envy — and almost no endings you actually chose. Things just stopped being current.',
        'And the thing you genuinely want, which is to be somewhere, with someone, and stay, is the exact thing the exit strategy will not let you build. You cannot put down roots while keeping one foot in the corridor.',
        'Nothing to do with that today. Just notice whether it is true.',
      ],
    },
    {
      step: 4,
      afterDays: 5,
      subject: 'Stay past the moment you want to go',
      preview: 'One conversation. That is the whole exercise.',
      heading: 'The one move.',
      paragraphs: [
        'Stay in one uncomfortable conversation past the moment you want to leave it.',
        'You will know the moment. It arrives as a very reasonable thought — that you have said your piece, that this is going nowhere, that you have somewhere to be.',
        'Stay five minutes past it. Say nothing clever. You do not have to resolve anything.',
        'What you are practising is not communication. It is proving to yourself that discomfort is survivable without a door — which is the thing you have never had evidence for, because you have always left before the evidence could arrive.',
        'One conversation. This week.',
      ],
      cta: { label: 'The rest of the return', path: '/quiz/the-escape-artist' },
    },
    {
      step: 5,
      afterDays: 8,
      subject: 'Somewhere to stay, for seven days',
      preview: 'Short enough that leaving is not the point.',
      heading: 'You do not get rid of her.',
      paragraphs: [
        'She got you out once, and you needed her to. You do not fire her.',
        'You learn to notice her reaching for the handle, and you give yourself a reason to stay in the room a bit longer.',
        'That is the whole of ME VS HER. Seven days, one small thing a day, at your own pace. Deliberately short — long enough to mean something, not so long that leaving becomes the interesting option.',
        'You write it down, it stays yours, and nobody else reads it.',
        'It is eleven dollars — less than the coffee you will drink while doing Day 1. And if it is not for you, it is not for you: that is a real answer, and there is a refund window for exactly that reason.',
      ],
      cta: { label: 'Start ME VS HER', path: '/me-vs-her' },
    },
  ],

  /* ------------------------------------------------------------------ */
  freeze: [
    {
      step: 1,
      afterDays: 0,
      subject: 'You are The Watcher',
      preview: 'The one who is almost ready. Here is the whole read.',
      heading: 'Meet your ME.',
      paragraphs: [
        `${FIRST_NAME_TOKEN}, the version of ME running your show is The Watcher — the version of you who goes still. Researching, preparing, almost-ready, because moving in the wrong direction feels worse than not moving at all.`,
        'You already know the behaviour. What you might not know is that she is not the enemy, and what she is for.',
        'Stillness is the oldest safety there is. Somewhere you learned that being seen getting it wrong was dangerous, and so you became extremely good at not being seen.',
        'That is not laziness, and you should stop calling it that. It is a freeze response, and it is doing precisely what it was built to do.',
        'Four more of these over the next week: where she came from, what she costs you, and the one move that gets you off the mark. There is nothing to buy in any of them.',
      ],
      cta: { label: 'Read your full result', path: '/quiz/the-watcher' },
    },
    {
      step: 2,
      afterDays: 1,
      subject: 'It is not laziness. It never was.',
      preview: 'Stillness is the oldest safety there is.',
      heading: 'It was never laziness.',
      paragraphs: [
        'Somewhere behind The Watcher is a younger version of you who was wrong in front of people, and it cost her something.',
        'Maybe it was laughter. Maybe it was a look. Maybe it was one adult who was very hard to predict.',
        'Whatever it was, she drew a sensible conclusion: do not move until you are sure. And then she spent years getting extremely good at the part that comes before moving — the reading, the planning, the almost.',
        'Here is what nobody tells women like you: the preparing is not the problem. Your preparation is genuinely better than most people’s finished work.',
        'The problem is that certainty never arrives, so the signal she is waiting for is one that does not exist.',
      ],
    },
    {
      step: 3,
      afterDays: 3,
      subject: 'The gap',
      preview: 'Between what you know and what you have done.',
      heading: 'What she costs you.',
      paragraphs: [
        `Here is the honest version, ${FIRST_NAME_TOKEN}.`,
        'Time. Quietly, and in enormous quantities.',
        'The life you have been researching is currently being lived by women with half your thought and twice your nerve. You have watched it happen. You have probably watched it happen more than once.',
        'And the gap between what you know and what you have actually done is the thing that keeps you awake, because you are the only person who can see the size of it.',
        'Nothing to do with that today. Just notice whether it is true.',
      ],
    },
    {
      step: 4,
      afterDays: 5,
      subject: 'Sixty per cent ready is the instruction',
      preview: 'And where somebody can see.',
      heading: 'The one move.',
      paragraphs: [
        'Do it at sixty per cent ready, where somebody can see.',
        'Take the smallest version of the thing you have been almost-doing. Set a timer for ten minutes. Finish before the timer does.',
        'It will not be good. That is not an unfortunate side effect of this exercise, it is the entire exercise.',
        'What you are practising is not productivity. It is being witnessed doing something imperfectly and surviving it — which is the evidence your nervous system has been missing for about twenty years.',
        'Ten minutes. Today.',
      ],
      cta: { label: 'The rest of the return', path: '/quiz/the-watcher' },
    },
    {
      step: 5,
      afterDays: 8,
      subject: 'One small thing a day, for seven days',
      preview: 'Small enough that starting is not the hard part.',
      heading: 'You do not get rid of her.',
      paragraphs: [
        'She kept you safe by keeping you still. You do not fire her.',
        'You learn to notice the stillness arriving, and you make the next step small enough that she does not need to stop you.',
        'That is the whole of ME VS HER. Seven days, one small thing a day, at your own pace. Each day is about twenty minutes, and there is no streak to lose if you miss one.',
        'You write it down, it stays yours, and nobody else reads it.',
        'It is eleven dollars — less than the coffee you will drink while doing Day 1. And if it is not for you, it is not for you: that is a real answer, and there is a refund window for exactly that reason.',
      ],
      cta: { label: 'Start ME VS HER', path: '/me-vs-her' },
    },
  ],

  /* ------------------------------------------------------------------ */
  sulk: [
    {
      step: 1,
      afterDays: 0,
      subject: 'You are The Quiet Storm',
      preview: 'The one who says she is fine. Here is the whole read.',
      heading: 'Meet your ME.',
      paragraphs: [
        `${FIRST_NAME_TOKEN}, the version of ME running your show is The Quiet Storm — the version of you who withdraws. Who says she is fine, gives a little less, and waits to be noticed.`,
        'You already know the behaviour. What you might not know is that she is not the enemy, and what she is for.',
        'Asking directly and being refused is a particular kind of humiliation, and you decided some time ago not to risk it again.',
        'Going quiet is not manipulation, whatever anyone has told you. It is what asking turns into when asking stopped working.',
        'Four more of these over the next week: where she came from, what she costs you, and the one move that breaks the silence. There is nothing to buy in any of them.',
      ],
      cta: { label: 'Read your full result', path: '/quiz/the-quiet-storm' },
    },
    {
      step: 2,
      afterDays: 1,
      subject: 'You did ask. Once.',
      preview: 'And then you stopped.',
      heading: 'You did ask, once.',
      paragraphs: [
        'Somewhere behind The Quiet Storm is a younger version of you who said what she wanted, plainly, and did not get it.',
        'Possibly more than once. Possibly from someone who was supposed to be safe.',
        'So she made a quiet decision that seemed reasonable at the time: if they cared, they would know without being told. And if they have to be told, it does not count.',
        'That rule protects her from ever being refused again. It also makes it almost impossible for anybody to get it right.',
        'Nobody can pass a test they were never told they were sitting.',
      ],
    },
    {
      step: 3,
      afterDays: 3,
      subject: 'The ledger',
      preview: 'It is heavy, it is private, and it is eating things.',
      heading: 'What she costs you.',
      paragraphs: [
        `Here is the honest version, ${FIRST_NAME_TOKEN}.`,
        'The one thing you want — to be chosen without having to ask for it — is the exact thing silence guarantees you will not get.',
        'And the ledger is heavy. Every time you gave more than you had. Every time nobody noticed. You could recite it right now, and that is not a small weight to carry around all day.',
        'Resentment is private, it is entirely reasonable from the inside, and it is quietly eating the relationships you are trying to protect.',
        'Nothing to do with that today. Just notice whether it is true.',
      ],
    },
    {
      step: 4,
      afterDays: 5,
      subject: 'Say the want out loud',
      preview: 'Before it turns into a grudge.',
      heading: 'The one move.',
      paragraphs: [
        'Say the unmet want out loud, plainly, before it becomes a grudge.',
        'Find one thing you are quietly angry about. Write the sentence you actually mean, and start it with "I wanted".',
        'Not "you never". Not "it is fine". I wanted.',
        'You do not have to send it to anybody. You have to admit it — because a want you will not name cannot be met by anyone, including you.',
        'And if you do say it out loud to the person: no preamble, no apology, no making it smaller so it is easier to refuse.',
        'One sentence. Today.',
      ],
      cta: { label: 'The rest of the return', path: '/quiz/the-quiet-storm' },
    },
    {
      step: 5,
      afterDays: 8,
      subject: 'Somewhere to put it down',
      preview: 'Seven days. Nobody reads it but you.',
      heading: 'You do not get rid of her.',
      paragraphs: [
        'She protected your dignity when asking was not safe. You do not fire her.',
        'You learn to notice the silence coming down, and you give the want somewhere to go before it becomes a score.',
        'That is the whole of ME VS HER. Seven days, one small thing a day, at your own pace. There is a place to write the things you have not said, and it is encrypted — not private as a promise, private as a fact. Nobody here can read it either.',
        'Day six is the one that tends to get people.',
        'It is eleven dollars — less than the coffee you will drink while doing Day 1. And if it is not for you, it is not for you: that is a real answer, and there is a refund window for exactly that reason.',
      ],
      cta: { label: 'Start ME VS HER', path: '/me-vs-her' },
    },
  ],
}

/** Every email in every sequence, flattened. */
export const allSequenceEmails = Object.entries(sequences).flatMap(
  ([mode, emails]) => emails.map((email) => ({ mode: mode as ProtectiveMode, email })),
)

export function sequenceFor(mode: ProtectiveMode): SequenceEmail[] {
  return sequences[mode]
}

export function sequenceStep(
  mode: ProtectiveMode,
  step: number,
): SequenceEmail | null {
  return sequences[mode].find((e) => e.step === step) ?? null
}

/**
 * Fill the one token.
 *
 * When she never gave a name, the token is removed rather than replaced with
 * "there" or "friend" — "Ada, you came out as" becomes "You came out as",
 * which reads like a sentence instead of like a mail merge that failed.
 */
export function personalise(text: string, firstName: string | null): string {
  const name = firstName?.trim()
  if (name) return text.split(FIRST_NAME_TOKEN).join(name)

  return text
    .split(`${FIRST_NAME_TOKEN}, `)
    .join('')
    .split(FIRST_NAME_TOKEN)
    .join('')
    .replace(/^([a-z])/, (c) => c.toUpperCase())
    .trim()
}
