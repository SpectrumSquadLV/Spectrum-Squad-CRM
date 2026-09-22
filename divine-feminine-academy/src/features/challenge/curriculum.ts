/**
 * ME VS. HER — the seven days.
 *
 * The curriculum lives here rather than inside the seed script for the same
 * reason the quiz questions do: so it can be TESTED rather than only run. The
 * failures this catches are the quiet ones — a callback pointing at a name no
 * screen saves under, a mirror on Day 7, a day that lost its closing screen in
 * an edit. Nobody notices those for weeks, because the challenge still runs.
 *
 * EVERY WORD BELOW IS QUIANA'S, and is reproduced exactly as written. Where
 * this file adds anything it is structural — which block, in which order,
 * saving under which name. If a line here disagrees with CURRICULUM.md, the
 * document wins and this file is wrong.
 *
 * The shape of the week:
 *
 *   1  SEE ME                 observation only, and quick
 *   2  UNDERSTAND ME          the heaviest day; safety rails on every screen
 *   3  LOVE ME                compassion replaces shame
 *   4  RECOGNIZE              ME behaviour -> result, and nothing else
 *   5  MEET HER               the first day HER appears; light and expansive
 *   6  CHOOSE HER             one real choice, short and actionable
 *   7  ME VS. HER             the culmination: one real decision
 *
 * Days 1-6 end at a mirror, climbing 1, 2, 2, 3, 3, 3 minutes. Day 7 has NO
 * mirror: it ends in a decision and an action, not another look.
 *
 * No belief is named anywhere in these seven days. Belief work is Academy
 * content, and the scope guard is deliberate.
 */

export interface BlockSeed {
  type: string
  config: Record<string, unknown>
  isRequired?: boolean
}

export interface DaySeed {
  title: string
  subtitle: string
  minutes: number
  blocks: BlockSeed[]
}

/**
 * Day 1's list, compiled from Quiana's lists. She may edit it in the admin.
 *
 * Seventeen, in the first person, none of them flattering and none of them
 * pathological. Which nine a woman taps is the portrait.
 */
export const ME_BEHAVIOURS = [
  'I overthink',
  'I shut down',
  'I chase',
  'I pull away',
  'I prove myself',
  'I control',
  'I people-please',
  'I seek reassurance',
  "I say I'm fine when I'm not",
  'I stay when I want to leave',
  'I leave before I can be left',
  'I get defensive',
  'I escape or distract myself',
  'I cut people off',
  'I question myself',
  'I avoid',
  'I keep score',
  "I manage how I'm perceived",
] as const

/** Day 4's lists, per area. Final copy. */
export const AREA_BEHAVIOURS: Record<string, string[]> = {
  relationships: [
    'I chase people when they pull away.',
    "I accept things I know I don't want.",
    "I need reassurance that I'm loved.",
    'I stay because leaving feels scarier than being unhappy.',
    'I confuse being wanted with being valued.',
  ],
  herself: [
    "I talk to myself in ways I'd never talk to someone I love.",
    "I put everyone else's needs before my own.",
    'I give up what I want to keep the peace.',
    "I don't trust my own decisions.",
    "I only feel good about myself when I'm getting it right.",
  ],
  money: [
    'I spend to make myself feel better.',
    "I undercharge or don't ask for what I'm worth.",
    'I avoid looking at my accounts.',
    "I give money I don't have to keep people close.",
    "I never feel like there's enough, no matter what I have.",
  ],
  success: [
    "I wait until it's perfect before I start.",
    "I shrink so no one thinks I'm too much.",
    'I quit before anyone can tell me I failed.',
    'I overwork to prove I deserve to be here.',
    "I downplay what I've accomplished.",
  ],
}

export const days: DaySeed[] = [
  // ------------------------------------------------------------------ Day 1
  /*
   * SEE ME. Observation only.
   *
   * The emotional outcome is recognition, not shame, and the day is kept
   * QUICK on purpose. HER is not mentioned beyond the opening phrase, there
   * is no "what would HER do", and nothing here asks WHY she behaves this
   * way — that is tomorrow, and asking it today would turn a woman's first
   * twenty minutes into an excavation.
   */
  {
    title: 'SEE ME',
    subtitle: 'The version of you that shows up automatically.',
    minutes: 15,
    blocks: [
      {
        type: 'rich_text',
        config: {
          // The day opens. Oversized title, and ME's list of ways of moving
          // through the world falls out as a stacked litany rather than a
          // paragraph - compressed, repetitive, which is ME before anybody
          // has explained what ME is.
          scene: 'chapter',
          heading: 'MEET ME',
          body: `Before we can talk about HER, I need you to meet ME.

ME is the version of you that shows up automatically.

She's the one who reacts before you have time to think.

She overthinks.
She shuts down.
She chases.
She pulls away.
She proves.
She controls.
She people-pleases.
She seeks reassurance.
She says she's fine when she's not.
She stays when she wants to leave.
She leaves before she can be left.

Not because there's something wrong with her.

ME has learned ways of moving through the world that, somewhere along the way, made sense to her.

And for today, we're not going to change any of them.

We're just going to notice her.

Because you can't recognize when ME is making the decision if you've never learned how to see her.

Today, you're going to SEE ME.`,
        },
      },
      {
        type: 'pattern_select',
        isRequired: true,
        config: {
          prompt: 'WHICH ONES FEEL LIKE ME?',
          helper: `Don't overthink this.

Tap anything you've caught yourself doing — even if you don't do it all the time.

This isn't a personality test.

There is no score.
There is no "bad" result.

You're simply noticing.`,
          options: ME_BEHAVIOURS,
          allowCustom: true,
          customLabel: 'Anything else?',
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'CATCH ME IN THE MOMENT',
          helper: `NOW LET'S FIND HER IN REAL LIFE.

Think about a recent moment when you felt hurt, rejected, frustrated, insecure, uncomfortable, angry, or out of control.

Nothing huge.

Just a moment when you noticed yourself react.

What happened?`,
          saveAs: 'trigger',
          minWords: 0,
          alsoSaveToJournal: true,
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'WHAT DID ME DO?',
          // Her trigger, shown above the prompt. Callback: the screen before.
          showsEarlier: 'trigger',
          showsEarlierLabel: 'This happened',
          helper: `And what did you do next?

Maybe you:

sent the text.
went quiet.
over-explained.
got defensive.
looked for reassurance.
tried to fix it.
checked their social media.
said yes when you wanted to say no.
pulled away.
tried to regain control.
pretended you didn't care.
started questioning yourself.

Or maybe ME did something completely different.

What did ME do?`,
          saveAs: 'me_response',
          minWords: 0,
          alsoSaveToJournal: true,
        },
      },
      {
        type: 'rich_text',
        config: {
          /*
           * The confrontation, and the reason the scene system exists.
           *
           * She typed the trigger ninety seconds ago. Here it is read back to
           * her at display scale, edge to edge, on near-black, with "That's
           * her." underneath - the whole page darkens for it. As a paragraph
           * on cream this screen passed by; it is the hinge of Day 1.
           */
          scene: 'confront',
          heading: 'REFLECTION',
          body: `THIS HAPPENED:

{{trigger}}

AND ME:

{{me_response}}

That's her.

No judgment.

No fixing.

No figuring out why yet.

Just notice her.

ME showed up.`,
        },
      },
      {
        type: 'founder_note',
        config: { note: 'before-the-first-mirror', portrait: true },
      },
      {
        type: 'rich_text',
        config: {
          // The one line she has to carry into sixty seconds of silence. It
          // gets the screen; the instructions sit small underneath it.
          scene: 'declaration',
          heading: 'LOOK AT HER.',
          body: `For one minute, look into your own eyes.

Not your hair.
Not your skin.
Not the things you normally look at when you see yourself in a mirror.

Your eyes.

You don't need to say anything.
You don't need to feel anything.

Just stay with yourself.

If it feels uncomfortable, that's okay.

Don't look away from her.

Today, you're simply learning to see ME.`,
        },
      },
      {
        type: 'mirror_gaze',
        config: { seconds: 60, extendSeconds: 60, mood: 'still' },
      },
      {
        type: 'rich_text',
        config: {
          /*
           * The day goes quiet, and then HER speaks for the first time.
           *
           * Day 1 is about meeting ME, so this is not a reveal. The last line
           * of the curriculum promises that tomorrow we understand her, and
           * then a hand she has never seen writes "you already know"
           * underneath it. Nothing asks her to do anything about it. By Day 7
           * she should know that handwriting on sight - which only works if
           * it stays this rare.
           */
          scene: 'close',
          herVoice: 'you-already-know',
          body: `Today, you met ME.

Not the whole of you.

Not everything you are.

Just a version of you that you've probably been letting make decisions without even realizing she's there.

For today, that's enough.

You don't need to change her.

You don't need to understand her yet.

You just need to start noticing:

"There she is."

Tomorrow, we're going to understand her.`,
        },
      },
    ],
  },
  // ------------------------------------------------------------------ Day 2
  /*
   * UNDERSTAND ME. Where ME learned to operate this way.
   *
   * The heaviest day in the challenge, and the only one with safety rails on
   * every screen: a warning before it starts, crisis resources on both
   * questions, and a way to stop that keeps her writing.
   *
   * ONLY TWO PROMPTS. That is a hard limit from the curriculum, not an
   * omission — a woman who has just found the earliest time she remembers
   * feeling this way does not need a third question.
   */
  {
    title: 'UNDERSTAND ME',
    subtitle: 'Where ME might have learned it.',
    minutes: 20,
    blocks: [
      {
        type: 'rich_text',
        config: {
          body: `Yesterday: What does ME do?
Today: Where might ME have learned it?`,
        },
      },
      {
        type: 'rich_text',
        config: {
          body: `ME isn't trying to ruin your life.

When she's hurt, lost, or confused, she's usually trying to protect you—to find safety, validation, reassurance, control, or prevent abandonment.

And sometimes the things we do today began as ways of protecting ourselves much earlier in life.`,
        },
      },
      {
        // Her Day 1 ME behaviour, from a different day, so it comes from the
        // server rather than from today's answers.
        type: 'callback',
        config: {
          facet: 'me_response',
          heading: 'Yesterday, ME did this',
          emptyText: '',
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt:
            'Think about the ME behavior you identified yesterday. What’s the earliest time you remember feeling the same way?',
          saveAs: 'origin_memory',
          minWords: 0,
          alsoSaveToJournal: true,
          allowStopForToday: true,
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'What did you need in that moment that you didn’t receive?',
          saveAs: 'unmet_need',
          minWords: 0,
          alsoSaveToJournal: true,
          allowStopForToday: true,
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'LOOK AT HER AGAIN.',
          body: `Yesterday, you saw ME.

Today, you know something about her you didn’t know before.

Some of the things she does may have started because, at some point, she needed something she didn’t receive.

Look into her eyes.

You don’t need to analyze her.
You don’t need to fix her.

Just look at her with a little more understanding than you did yesterday.

Maybe there’s a reason she does what she does.`,
        },
      },
      {
        type: 'mirror_gaze',
        config: { seconds: 120, extendSeconds: 60, mood: 'still' },
      },
    ],
  },

  // ------------------------------------------------------------------ Day 3
  /*
   * LOVE ME. Compassion replaces shame.
   *
   * The mechanism is separating identity from experience: her body, history,
   * mistakes and protective behaviours are things she has experienced, not
   * the whole of who she is. A spiritual framing, deliberately not a clinical
   * one.
   *
   * No letter on Day 3. The statement at the end is the whole ceremony.
   */
  {
    title: 'LOVE ME',
    subtitle: 'Stop fighting the woman who protected you.',
    minutes: 20,
    blocks: [
      {
        type: 'callback',
        config: {
          facet: 'trigger',
          heading: 'This is where you started',
          emptyText: '',
        },
      },
      {
        type: 'rich_text',
        config: {
          body: `Settle in front of a mirror.

For the next few minutes, your only job is to look directly into your own eyes.

Not at your hair.
Not at your skin.
Not at your body.

Your eyes.

At first, this may feel uncomfortable. That’s okay. Don’t force yourself to feel anything profound. Just stay.

Look past the physical version of you and connect with the soul behind her.

The woman underneath everything that has happened.

Underneath everything she’s been called.

Underneath everything she’s done.

Underneath every version of ME she created to survive.

That’s who you’re looking for.

Stay with her for 2 minutes.`,
        },
      },
      {
        type: 'mirror_gaze',
        config: { seconds: 120, extendSeconds: 60, mood: 'still' },
      },
      {
        type: 'reflection_prompt',
        config: {
          prompt: 'Who were you looking at?',
          helper: `Not her name.

Not her roles.

Not what she’s accomplished.

Not what she’s survived.

Who is she underneath all of that?`,
          saveAs: 'who_is_she',
          minWords: 0,
          alsoSaveToJournal: true,
        },
      },
      {
        type: 'statement_fill',
        isRequired: true,
        config: {
          confirmLabel: 'This is true',
          segments: [
            { kind: 'text', text: 'ME, I see you.\n\nYou learned to ' },
            {
              kind: 'blank',
              name: 'learned_to',
              placeholder: 'overthink',
              prefillFrom: 'behaviorTags',
            },
            { kind: 'text', text: '\nbecause I needed ' },
            {
              kind: 'blank',
              name: 'because_i_needed',
              placeholder: 'to feel safe',
              prefillFrom: 'unmetNeed',
            },
            { kind: 'text', text: '.\n\nYou were trying to protect me from ' },
            { kind: 'blank', name: 'protect_me_from', placeholder: '' },
            { kind: 'text', text: '.\n\nThank you for ' },
            { kind: 'blank', name: 'thank_you_for', placeholder: '' },
            { kind: 'text', text: '.\n\nI am not ' },
            { kind: 'blank', name: 'i_am_not', placeholder: '' },
            { kind: 'text', text: '.\n\nI am HER.' },
          ],
        },
      },
    ],
  },

  // ------------------------------------------------------------------ Day 4
  /*
   * RECOGNIZE WHAT ME HAS BEEN CREATING.
   *
   * One realization only: ME is not just reacting to her life, she has been
   * participating in creating it. Kept simple and fast, and explicitly not a
   * lesson on subconscious programming, neuroscience, trauma or manifestation
   * theory. The whole day is ME behaviour -> RESULT.
   */
  {
    title: 'RECOGNIZE WHAT ME HAS BEEN CREATING',
    subtitle: 'Not to blame yourself. To see the pattern.',
    minutes: 20,
    blocks: [
      {
        type: 'rich_text',
        config: {
          body: `Look around at your life.

Not to judge it.

Not to blame yourself for everything that’s happened to you.

But to recognize something incredibly powerful:

The version of you making the decisions influences the life those decisions create.

If ME is afraid of abandonment, she may hold onto people long after they’ve shown her they aren’t right for her.

If ME needs validation, she may keep proving herself to people who were never qualified to determine her worth.

If ME believes safety comes from control, she may exhaust herself trying to control everything around her.

If ME is afraid of failure, she may never fully pursue the thing she says she wants.

And then she looks around at the results and thinks:

“Why does this keep happening to me?”

Today, we’re going to look at what ME has been creating.`,
        },
      },
      {
        type: 'area_picker',
        isRequired: true,
        config: {
          prompt: 'Where do you want to look?',
          allowAnother: true,
          saveAs: 'day4_area',
        },
      },
      {
        type: 'pattern_select',
        isRequired: true,
        config: {
          prompt: 'Where can you see ME showing up here?',
          optionsByArea: AREA_BEHAVIOURS,
          readsArea: 'day4_area',
          allowCustom: true,
          customLabel: 'Write my own',
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'And what has that been creating for you?',
          saveAs: 'creating',
          minWords: 0,
          alsoSaveToJournal: true,
        },
      },
      {
        type: 'founder_note',
        config: { note: 'before-the-hardest-mirror', portrait: true },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'LOOK AT HER WITHOUT JUDGING HER.',
          body: `Today, you saw how some of ME’s choices have been showing up in your life.

It would be easy to look at that and criticize yourself.

Don’t.

Look into your eyes.

You are not here to punish yourself for the choices you’ve made.

You’re here because you’re finally becoming aware that you have a choice.

Stay with her.

Awareness changes what becomes possible.`,
        },
      },
      {
        type: 'mirror_gaze',
        config: { seconds: 180, extendSeconds: 60, mood: 'still' },
      },
      {
        type: 'rich_text',
        config: {
          body: `If ME's choices have been helping create my current reality, different choices can help create a different one.

But first, you need to know who's making them.

Tomorrow, you meet HER.`,
        },
      },
    ],
  },
  // ------------------------------------------------------------------ Day 5
  /*
   * MEET HER. The first day HER appears, and she only SEES her.
   *
   * Nothing here asks what HER would do, who she is choosing, or how she will
   * become anything — all of that is withheld for the culmination. The day is
   * deliberately lighter and more expansive than Days 1-4: possibility, not
   * introspection, and quick rather than a journaling assignment.
   */
  {
    title: 'MEET HER',
    subtitle: 'She is not someone you have to become.',
    minutes: 20,
    blocks: [
      {
        type: 'rich_text',
        config: {
          body: `For the last four days, you've been getting to know ME.

You've seen what she does.
You've started to understand why she does it.
You've looked beyond everything that's happened to you.
And you've started recognizing what ME has been creating in your life.

But here's what I need you to understand:

ME isn't all of you.

There is another version of you underneath the fear.
Underneath the need to prove yourself.
Underneath the need to be chosen.
Underneath the need for validation.
Underneath everything you've learned to do to feel safe.

HER.

And HER isn't some perfect woman you're going to magically become one day.

She's already you.

Today, you're going to meet her.`,
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'WHO IS HER?',
          body: `HER isn't the richer you.

HER isn't the thinner you.

HER isn't the married you.

HER isn't the successful you.

HER isn't the healed, perfect, fearless version of you.

HER is you without the belief that you have to become something else before you're worthy.

HER knows one thing:

“I AM WORTHY OF EVERYTHING I DESIRE.”

Today, I don't want you to worry about HOW you're going to become HER.

I just want you to let yourself see her.`,
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'LET YOURSELF DESIRE',
          body: `Yesterday, you looked at what ME has been creating in your life.

Today, we're going to look at four areas of your life differently.

Not through fear.
Not through what's realistic.
Not through what you've experienced before.
Not through what you think you can have.

Through HER.

Ask yourself:

“If I truly knew I was worthy of everything I desire, what would I allow myself to desire?”`,
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'HERSELF',
          helper: `If you didn't have to prove anything to anyone...

Who would you allow yourself to be?`,
          saveAs: 'desire_herself',
          minWords: 0,
          alsoSaveToJournal: false,
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'RELATIONSHIPS',
          helper: `If you truly knew you were worthy of the love and relationships you desire...

What would you allow yourself to want?`,
          saveAs: 'desire_relationships',
          minWords: 0,
          alsoSaveToJournal: false,
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'MONEY',
          helper: `If you truly knew you were worthy of having more than enough...

What would you allow yourself to desire?`,
          saveAs: 'desire_money',
          minWords: 0,
          alsoSaveToJournal: false,
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'SUCCESS',
          helper: `If you weren't worried about whether you're capable, deserving, realistic, ready, or what anyone else might think...

What would you allow yourself to want?`,
          saveAs: 'desire_success',
          minWords: 0,
          alsoSaveToJournal: false,
        },
      },
      {
        type: 'her_reveal',
        config: {
          heading: 'THIS IS HER.',
          readsFrom: {
            herself: 'desire_herself',
            relationships: 'desire_relationships',
            money: 'desire_money',
            success: 'desire_success',
          },
          close: `Read what you just wrote.

You didn't create HER today.

You gave yourself permission to see her.`,
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'TODAY, LOOK FOR HER.',
          body: `You’ve spent the last few days learning to see ME.

But today, you met HER.

Look into your eyes.

And this time, don’t look for what’s wrong.
Don’t look for what needs to change.
Don’t even look for ME.

Look deeper.

Look at the woman who knows:

I AM WORTHY OF EVERYTHING I DESIRE.

You don’t have to become her right now.

Just let yourself see her.

There she is.`,
        },
      },
      {
        // Lighter and more expansive, matching the day. "There she is" is
        // deliberately the same phrase Day 1 used about ME.
        type: 'mirror_gaze',
        config: { seconds: 180, extendSeconds: 60, mood: 'open' },
      },
      {
        type: 'rich_text',
        config: {
          body: `You've spent four days getting to know ME.

Today, you met HER.

And I don't want you to do anything with her yet.

Don't figure out how to become her.
Don't make a plan.
Don't try to change your entire life tonight.

Just let yourself see her.

Because tomorrow, something changes.

You know ME.

You've met HER.

But what happens when they want two completely different things?`,
        },
      },
    ],
  },
  // ------------------------------------------------------------------ Day 6
  /*
   * CHOOSE HER. One intentional choice.
   *
   * Short and actionable, not another journaling exercise. It introduces the
   * choice point, the pause, WHY AM I DOING THIS, and ONE action — and
   * withholds the full comparison, "what would HER do", and "who am I
   * choosing", all of which belong to Day 7.
   *
   * ME is never judged here. She may still be trying to protect her;
   * protection just does not have to become action.
   */
  {
    title: 'CHOOSE HER',
    subtitle: 'The life of HER is created in moments.',
    minutes: 20,
    blocks: [
      {
        type: 'rich_text',
        config: {
          body: `Yesterday, you met HER.

You allowed yourself to imagine what you actually desire in:

HERSELF.
RELATIONSHIPS.
MONEY.
SUCCESS.

And for once, I didn't ask you to figure out how to get there.

Today, we're going to take ONE step.

Because HER isn't built in one giant transformation.

She's revealed in the small moments when you have an opportunity to choose differently.`,
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'THE CHOICE POINT',
          body: `There are moments in your life when something happens...

and before you even realize it,

ME takes over.

You send the text.

You say yes.

You apologize.

You shut down.

You spend the money.

You don't spend the money.

You don't apply.

You don't speak up.

You over-explain.

You prove yourself.

You walk away before someone can leave you.

You make the decision...

and THEN you think about it.

Today, we're slowing down one of those moments.

Because between what happens...

and what you do next...

there is a choice.`,
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'FIND ONE',
          helper: `Think about your life RIGHT NOW.

Not your childhood.
Not five years ago.
Not something you already resolved.

Right now.

Is there something you're currently:

avoiding?
overthinking?
chasing?
controlling?
tolerating?
procrastinating on?
trying to prove?
afraid to say?
afraid to do?
waiting for permission to want?

Choose ONE.`,
          saveAs: 'current_situation',
          minWords: 0,
          alsoSaveToJournal: true,
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'WHY AM I DOING THIS?',
          showsEarlier: 'current_situation',
          showsEarlierLabel: 'You chose',
          helper: `Don't give me the answer that sounds good.

Pause long enough to notice what's actually underneath it.

Is it something you genuinely want?

Or are you trying to feel:

safe?
chosen?
validated?
reassured?
in control?
accepted?
good enough?

You don't need to fix the feeling.

Just recognize it.`,
          saveAs: 'why_am_i_doing_this',
          minWords: 0,
          alsoSaveToJournal: true,
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'THE PAUSE',
          body: `Now pause.

You do NOT need to solve your entire life today.

You only need to recognize:

I HAVE A CHOICE HERE.

The first response that comes to you isn't always the response you have to follow.

You can feel the fear...

and still pause.

You can want the reassurance...

and still pause.

You can feel uncomfortable...

and still pause.

That pause is where something new becomes possible.`,
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'REMEMBER HER',
          body: `Yesterday, you met HER.

Read what you wrote yesterday.

Remember the woman you saw.

You don't need to become all of her today.

Today, you're going to make ONE decision that moves you toward her.`,
        },
      },
      {
        // Collapsed: the screen's job is ONE small choice, and four
        // paragraphs of everything she wants would swamp it.
        type: 'callback',
        config: {
          facet: 'desires',
          heading: 'What you wrote yesterday',
          collapsed: true,
          emptyText: '',
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt:
            'WHAT IS ONE SMALL CHOICE I CAN MAKE TODAY THAT MOVES ME CLOSER TO HER?',
          showsEarlier: 'current_situation',
          showsEarlierLabel: 'The thing you chose',
          helper: `Not the biggest choice.

Not the scariest choice.

Not the choice that fixes everything.

ONE choice.

Maybe you don't send the text.

Maybe you finally send the email.

Maybe you say no.

Maybe you ask for what you need.

Maybe you stop explaining yourself.

Maybe you apply.

Maybe you look at the bank account instead of avoiding it.

Maybe you allow yourself to rest.

Maybe you tell the truth.

Maybe you simply wait before responding.

What is YOUR one choice?`,
          saveAs: 'one_choice',
          minWords: 0,
          alsoSaveToJournal: true,
        },
      },
      {
        type: 'action_commitment',
        isRequired: true,
        config: {
          prompt: 'TODAY, I CHOOSE TO:',
          echoesFrom: 'one_choice',
          confirmLabel: "I'M DOING IT",
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'LOOK AT THE WOMAN WHO GETS TO CHOOSE.',
          body: `Today, you learned something important.

You can feel the fear without immediately following it.

You can want the reassurance without immediately seeking it.

You can feel uncomfortable without immediately trying to make the discomfort disappear.

Look into your eyes.

ME can have a feeling.

And you can still make a choice.

Think about the one choice you made today that moves you closer to HER.

Stay with the woman who made it.

Tomorrow, she leads.`,
        },
      },
      {
        type: 'mirror_gaze',
        config: { seconds: 180, extendSeconds: 60, mood: 'still' },
      },
      {
        type: 'rich_text',
        config: {
          body: `That's it.

You didn't have to change your entire life today.

You noticed the moment.

You paused.

And you made one intentional choice.

This is how your reality begins to change.

Not because you woke up as a completely different woman.

Because for one moment...

you stopped letting an automatic response make the decision for you.`,
        },
      },
      {
        // The day must end in anticipation. Do not resolve ME vs HER here.
        type: 'rich_text',
        config: {
          body: `Six days ago, you met ME.

Yesterday, you met HER.

Today, you discovered the space between them:

CHOICE.

Tomorrow, I'm going to give you something you can take with you long after this challenge ends.

Because ME isn't going to disappear.

She's going to show up again.

The difference is...

tomorrow, you'll know exactly what to do when she does.`,
        },
      },
    ],
  },
  // ------------------------------------------------------------------ Day 7
  /*
   * ME VS. HER. The culmination.
   *
   * The rules this day is built from, all of which show up in the block
   * order and configuration below:
   *
   *   1. The real decision is the centrepiece. Not a reflection, not a
   *      retirement ceremony, not a summary day.
   *   2. ONE real current decision, not a hypothetical.
   *   3. The same decision stays visible from Screen 4 through Screen 11 -
   *      which is what `showsEarlier: 'decision'` is doing on every one.
   *   4. ME answers FIRST. HER answers second.
   *   5. They are shown side by side before she chooses.
   *   6. The system never decides or suggests what HER would do.
   *   7. HER's choice is never implied to be objectively correct.
   *   8. ME is never shamed. Her response is information.
   *   9. No RETURN. ME VS. HER is the framework.
   *  10. It ends in action, not insight.
   *  11. NO MIRROR. Every other day ends at one; this one does not.
   */
  {
    title: 'ME VS. HER',
    subtitle: 'One real decision, made consciously.',
    minutes: 25,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'ME VS. HER',
          body: `For the last six days, you've been meeting two versions of yourself.

ME:

The version of you shaped by what you've experienced.
The version who learned how to protect you.
The version who reacts when she feels afraid, rejected, uncertain, unseen, unsafe, or out of control.

And HER:

The woman underneath all of it.
The woman who knows:

I AM WORTHY OF EVERYTHING I DESIRE.

Today, they meet.`,
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'THIS IS WHERE IT MATTERS',
          body: `Knowing HER exists isn't enough.

Because your life is built through decisions.

Who you date.
What you tolerate.
What you walk away from.
What you ask for.
What you charge.
What you spend.
What you pursue.
What you say yes to.
What you say no to.
What you do when someone disappoints you.
What you do when you're scared.
What you do when nobody is validating you.

And sometimes...

ME and HER would make two completely different decisions.

Today, you're going to see the difference.`,
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'WHAT ARE YOU DECIDING?',
          helper: `Think about something happening in your life RIGHT NOW.

Something you need to decide.

It can be big.
It can be small.

Maybe you're deciding whether to:

send the text.
stay.
leave.
say yes.
say no.
apply.
ask.
spend.
save.
start.
stop.
speak up.
set the boundary.
have the conversation.
take the opportunity.
walk away.

Choose ONE real decision.

Not a hypothetical.

Something happening in your life right now.`,
          saveAs: 'decision',
          minWords: 0,
          alsoSaveToJournal: true,
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'WHAT DOES ME WANT TO DO?',
          showsEarlier: 'decision',
          showsEarlierLabel: "You're deciding",
          helper: `Before you decide anything...

let ME answer first.`,
          saveAs: 'me_would',
          minWords: 0,
          alsoSaveToJournal: true,
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'WHY?',
          showsEarlier: 'me_would',
          showsEarlierLabel: 'ME would',
          saveAs: 'me_why',
          minWords: 0,
          alsoSaveToJournal: true,
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'LET HER SEE ME',
          body: `ME WOULD:
{{me_would}}

BECAUSE:
{{me_why}}

Don't judge her.

Look at her.

Maybe she's afraid.
Maybe she wants reassurance.
Maybe she wants control.
Maybe she doesn't want to be rejected.
Maybe she wants to prove herself.
Maybe she's trying to protect you.

You've spent this entire week learning how to recognize her.

There she is.

ME.`,
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'NOW, HER',
          body: `Now we're going to ask the same woman...

the same question...

from a completely different place.

Remember who you met on Day 5.

Remember what she knows:

I AM WORTHY OF EVERYTHING I DESIRE.

Now imagine that you already KNOW that.

You don't have to earn it.
You don't have to prove it.
Nobody has to validate it.
Nobody has to choose you first.

You already know.

Now look at the exact same decision.`,
        },
      },
      {
        type: 'callback',
        config: {
          facet: 'desires',
          heading: 'Who you met on Day 5',
          collapsed: true,
          emptyText: '',
        },
      },
      {
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'WHAT WOULD HER DO?',
          showsEarlier: 'decision',
          showsEarlierLabel: "You're deciding",
          helper: 'IF I KNEW I WAS WORTHY OF EVERYTHING I DESIRE...',
          saveAs: 'her_would',
          minWords: 0,
          alsoSaveToJournal: true,
        },
      },
      {
        // Required, and it cannot be skipped: an answer with no reason behind
        // it is a guess, and Day 7 is the day she stops guessing.
        type: 'reflection_prompt',
        isRequired: true,
        config: {
          prompt: 'WHY WOULD HER MAKE THAT CHOICE?',
          showsEarlier: 'her_would',
          showsEarlierLabel: 'HER would',
          saveAs: 'her_why',
          minWords: 1,
          alsoSaveToJournal: true,
        },
      },
      {
        type: 'me_vs_her_compare',
        config: {
          close: `SAME WOMAN.
SAME SITUATION.
TWO DIFFERENT DECISIONS.
TWO DIFFERENT DIRECTIONS.`,
        },
      },
      {
        type: 'choice_capture',
        isRequired: true,
        config: {
          prompt: 'WHO ARE YOU CHOOSING?',
          saveAs: 'who_chosen',
          meResponse: `That's okay.

This challenge was never about pretending ME doesn't exist.

Before you decide, look at both choices one more time.`,
          lookAgainLabel: 'Look at both again',
          continueWithMeLabel: 'Continue with ME',
        },
      },
      {
        type: 'action_commitment',
        config: {
          prompt: 'THEN MAKE THE DECISION.',
          echoesFrom: 'her_would',
          confirmLabel: 'I CHOOSE HER',
          helper: `This is the part that changes everything.

HER isn't the woman you imagine becoming.

HER is the woman you choose to let make the decision.`,
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'SOLIDIFY THE FRAMEWORK',
          body: `ME VS. HER isn't something you only do during this challenge.

This is the question you take into your life.

The next time you're triggered...
The next time you're scared...
The next time you're about to send the text...
accept less...
shrink yourself...
prove yourself...
walk away...
stay...
spend...
hide...
control...
or make a decision you know matters...

PAUSE.

Then ask:

WHY AM I DOING THIS?
WHAT DOES ME WANT TO DO?
WHAT WOULD HER DO?
WHO AM I CHOOSING?

That's ME VS. HER.`,
        },
      },
      {
        type: 'me_vs_her_card',
        config: {
          heading: 'ME VS. HER',
          footer: 'I AM WORTHY OF EVERYTHING I DESIRE.',
        },
      },
      {
        type: 'rich_text',
        config: {
          heading: 'WHAT THIS ACTUALLY MEANS',
          body: `Choosing HER does not mean ME disappears.

ME may still be afraid.
ME may still want to text.
ME may still want reassurance.
ME may still want to run.
ME may still want to prove herself.

You don't have to fight her.
You don't have to hate her.
You don't even have to silence her.

You can hear her...

and still not hand her the decision.`,
        },
      },
      {
        type: 'rich_text',
        config: {
          body: `ME protected me.

HER leads me.

And every time I find myself standing between the two...

I get to choose again.

ME VS. HER.

I AM WORTHY OF EVERYTHING I DESIRE.`,
        },
      },
    ],
  },
]
