/**
 * The twelve questions.
 *
 * Kept out of the seed script so they can be TESTED rather than only run. The
 * two failures this catches are both quiet ones: an archetype that no set of
 * answers can actually reach, and a question where one mode has no option at
 * all, which silently biases every result taken after it.
 *
 * Two design choices worth keeping if you edit these:
 *
 * 1. The options are in a DIFFERENT ORDER on every question. If fight were
 *    always first, the quiz would measure which position she likes rather than
 *    which version of her is driving.
 * 2. No option is the flattering one. Every answer is a real thing a capable
 *    woman does, which is the only way she answers honestly instead of
 *    answering as the woman she would like to be.
 *
 * Every option carries TWO sets of weights, because this is one instrument
 * that answers two different questions. `weights` says which protector she
 * reaches for - how she defends herself. `areas` says where in her life it is
 * loudest right now - where it is costing her. She needs both, and asking her
 * to sit two separate assessments to get them was the wrong shape.
 */

import type { Area } from '@/features/assessment/scoring'
import type { ModeWeights } from './archetypes'

/**
 * How loud this answer says the pattern is, per area of her life.
 *
 * The QUESTION sets the arena - a bill is money, a person who cancels is
 * love - and the ANSWER sets the volume. That distinction is the whole
 * design: a domain score taken from the question alone would be identical
 * for every woman who finished, because everybody answers every question.
 *
 * Most options weigh one area. Some genuinely spill: "you mentioned it once,
 * lightly, and nobody followed up" is a question about her body and an
 * answer about being unseen, so it carries both.
 *
 * 3 is "this is where it lives", 2 "this is part of it", 1 "a trace".
 */
export type AreaWeights = Partial<Record<Area, number>>

export interface SeedOption {
  value: string
  label: string
  weights: ModeWeights
  areas: AreaWeights
}

export interface SeedQuestion {
  prompt: string
  options: SeedOption[]
}

export const quizQuestions: SeedQuestion[] = [
  {
    prompt: 'Someone you love says something that stings. Ten minutes later, you are…',
    options: [
      { value: 'a', label: 'Building the case. You have three examples ready.', weights: { fight: 2 }, areas: { love: 3, self: 1 } },
      { value: 'b', label: 'Replaying it word by word, trying to work out what they meant.', weights: { freeze: 2 }, areas: { love: 3, self: 2 } },
      { value: 'c', label: 'Fine. Completely fine. Noticeably fine.', weights: { sulk: 2 }, areas: { love: 3 } },
      { value: 'd', label: 'Already picturing your life without them in it.', weights: { flight: 2 }, areas: { love: 3, life: 1 } },
    ],
  },
  {
    prompt: 'The workload is impossible and nobody has noticed. You…',
    options: [
      { value: 'a', label: 'Do exactly what was asked and not one thing more.', weights: { sulk: 2 }, areas: { wealth: 3 } },
      { value: 'b', label: 'Take on more of it. You would rather do it than explain it.', weights: { fight: 2 }, areas: { wealth: 3, life: 2 } },
      { value: 'c', label: 'Start quietly looking at other jobs.', weights: { flight: 2 }, areas: { wealth: 3 } },
      { value: 'd', label: 'Open the list, look at the list, close the list.', weights: { freeze: 2 }, areas: { wealth: 2, life: 2 } },
    ],
  },
  {
    prompt: 'A bill arrives that you were not expecting.',
    options: [
      { value: 'a', label: 'Attack it. Extra hours, extra everything, sorted by Friday.', weights: { fight: 2 }, areas: { wealth: 3, life: 2 } },
      { value: 'b', label: 'Do not open it for a few days.', weights: { freeze: 2 }, areas: { wealth: 3 } },
      { value: 'c', label: 'Move some money around and think about the bigger picture later.', weights: { flight: 2 }, areas: { wealth: 3 } },
      { value: 'd', label: 'Pay it, and feel a fresh wave of who-does-everything-around-here.', weights: { sulk: 2 }, areas: { wealth: 3, love: 2 } },
    ],
  },
  {
    prompt: 'Someone tells you, sincerely, that they are proud of you.',
    options: [
      { value: 'a', label: 'Change the subject. Fast.', weights: { flight: 2 }, areas: { self: 3 } },
      { value: 'b', label: 'Deflect to the next thing you have to get done.', weights: { fight: 2 }, areas: { self: 3, wealth: 1 } },
      { value: 'c', label: 'Think: it would have been nice to hear that a while ago.', weights: { sulk: 2 }, areas: { self: 2, love: 2 } },
      { value: 'd', label: 'Go slightly still. You never know where to put it.', weights: { freeze: 2 }, areas: { self: 3 } },
    ],
  },
  {
    prompt: 'Someone cancels on you at the last minute.',
    options: [
      { value: 'a', label: 'Say “no worries!” and go quiet for two days.', weights: { sulk: 2 }, areas: { love: 3 } },
      { value: 'b', label: 'Say something straight, possibly sharper than you meant.', weights: { fight: 2 }, areas: { love: 3 } },
      { value: 'c', label: 'Feel relieved, honestly.', weights: { flight: 2 }, areas: { love: 2, life: 1 } },
      { value: 'd', label: 'Say nothing, then wonder all evening if they are going off you.', weights: { freeze: 2, sulk: 1 }, areas: { love: 3, self: 1 } },
    ],
  },
  {
    prompt: 'An opportunity you want turns up, and you are not quite qualified.',
    options: [
      { value: 'a', label: 'Go straight at it and work the gaps out later.', weights: { fight: 2 }, areas: { wealth: 3 } },
      { value: 'b', label: 'Research it for three weeks and miss the deadline.', weights: { freeze: 2 }, areas: { wealth: 3, self: 1 } },
      { value: 'c', label: 'Watch somebody less capable get it and say nothing.', weights: { sulk: 2 }, areas: { wealth: 3, self: 2 } },
      { value: 'd', label: 'Decide you wanted something different anyway.', weights: { flight: 2 }, areas: { wealth: 3 } },
    ],
  },
  {
    prompt: 'You get an unexpected free evening.',
    options: [
      { value: 'a', label: 'Lose it to your phone and cannot say where it went.', weights: { freeze: 2 }, areas: { life: 3, self: 1 } },
      { value: 'b', label: 'Use it. There is a list.', weights: { fight: 2 }, areas: { life: 3, wealth: 1 } },
      { value: 'c', label: 'Wait to see whether anybody offers to spend it with you.', weights: { sulk: 2 }, areas: { life: 2, love: 3 } },
      { value: 'd', label: 'Make plans. Several plans.', weights: { flight: 2 }, areas: { life: 3 } },
    ],
  },
  {
    prompt: 'You are criticised at work, in front of other people.',
    options: [
      { value: 'a', label: 'Defend it, point by point.', weights: { fight: 2 }, areas: { wealth: 3 } },
      { value: 'b', label: 'Accept it, and quietly stop volunteering for anything.', weights: { sulk: 2 }, areas: { wealth: 3, self: 2 } },
      { value: 'c', label: 'Go blank, then think of the perfect reply at eleven at night.', weights: { freeze: 2 }, areas: { wealth: 2, self: 3 } },
      { value: 'd', label: 'Start mentally drafting your exit.', weights: { flight: 2 }, areas: { wealth: 3 } },
    ],
  },
  {
    prompt: 'There is something you need, and you have not asked for it.',
    options: [
      { value: 'a', label: 'Rehearse asking. Several times. Do not ask.', weights: { freeze: 2 }, areas: { love: 2, wealth: 2 } },
      { value: 'b', label: 'Hope they work it out. They should know by now.', weights: { sulk: 2 }, areas: { love: 3 } },
      { value: 'c', label: 'Just do it yourself, faster.', weights: { fight: 2 }, areas: { love: 2, life: 2 } },
      { value: 'd', label: 'Decide you did not really need it.', weights: { flight: 2, freeze: 1 }, areas: { self: 3, love: 1 } },
    ],
  },
  {
    prompt: 'Something in your body has been hurting for a while now.',
    options: [
      { value: 'a', label: 'Push through. It will settle.', weights: { fight: 2 }, areas: { life: 3, self: 2 } },
      { value: 'b', label: 'You have googled it. You have not booked anything.', weights: { freeze: 2 }, areas: { life: 3 } },
      { value: 'c', label: 'You will deal with it when things calm down.', weights: { flight: 2 }, areas: { life: 3, wealth: 1 } },
      { value: 'd', label: 'You mentioned it once, lightly, and nobody followed up.', weights: { sulk: 2 }, areas: { life: 2, love: 3 } },
    ],
  },
  {
    prompt: 'The same person lets you down, again.',
    options: [
      { value: 'a', label: 'Stay, give less, and keep a list.', weights: { sulk: 2 }, areas: { love: 3 } },
      { value: 'b', label: 'Confront it. Again.', weights: { fight: 2 }, areas: { love: 3 } },
      { value: 'c', label: 'Stay exactly as you are and hope it changes.', weights: { freeze: 2 }, areas: { love: 3, self: 1 } },
      { value: 'd', label: 'Gradually become unavailable.', weights: { flight: 2, sulk: 1 }, areas: { love: 3 } },
    ],
  },
  {
    prompt: 'You imagine actually having the thing you want. What happens?',
    options: [
      { value: 'a', label: 'You go a bit blank. It is genuinely hard to picture.', weights: { freeze: 2 }, areas: { self: 3 } },
      { value: 'b', label: 'You think about how hard you will have to work for it.', weights: { fight: 2 }, areas: { self: 3, wealth: 2 } },
      { value: 'c', label: 'You picture having it, then picture leaving it.', weights: { flight: 2 }, areas: { self: 3, life: 1 } },
      { value: 'd', label: 'You think about who should have helped you get there by now.', weights: { sulk: 2 }, areas: { self: 2, love: 3 } },
    ],
  },
]
