import type { AnyBlockDefinition } from './contract'
import { actionCommitment } from './types/action-commitment'
import { areaPicker } from './types/area-picker'
import { beliefReview } from './types/belief-review'
import { callback } from './types/callback'
import { choiceCapture } from './types/choice-capture'
import { celebration } from './types/celebration'
import { emotionTrail } from './types/emotion-trail'
import { manifestationLoop } from './types/manifestation-loop'
import { mePortrait } from './types/me-portrait'
import { meRetirement } from './types/me-retirement'
import { mirrorDeclaration } from './types/mirror-declaration'
import { mirrorGaze } from './types/mirror-gaze'
import { myPart } from './types/my-part'
import { protectorProfile } from './types/protector-profile'
import { behaviorCommitment } from './types/behavior-commitment'
import { beliefOrigin } from './types/belief-origin'
import { dualColumnExercise } from './types/dual-column-exercise'
import { evidenceReview } from './types/evidence-review'
import { herChoiceCapture } from './types/her-choice-capture'
import { herReveal } from './types/her-reveal'
import { meVsHerCard } from './types/me-vs-her-card'
import { meVsHerCompare } from './types/me-vs-her-compare'
import { patternSelect } from './types/pattern-select'
import { statementFill } from './types/statement-fill'
import { herCodeBuilder } from './types/her-code-builder'
import { journalPrompt } from './types/journal-prompt'
import { milestone } from './types/milestone'
import { reflectionPrompt } from './types/reflection-prompt'
import { richText } from './types/rich-text'
import { validationAudit } from './types/validation-audit'
import { video } from './types/video'

/**
 * THE BLOCK REGISTRY.
 *
 * A lesson is a list of typed blocks; each type maps to exactly one entry here.
 *
 * - A new PROGRAM needs no code at all. It is rows in the database, assembled
 *   in the admin program builder.
 * - A new BLOCK TYPE is one folder under ./types plus one line below.
 *
 * Every entry must come from a module that is NOT marked 'use client'. The
 * server reads these to build the admin palette and to decide which responses
 * are encrypted; a definition exported from a client module arrives as an
 * opaque reference with every field undefined.
 *
 * Still to build: quiz_question and assessment_embed, audio and download.
 */
const definitions: AnyBlockDefinition[] = [
  // Structure and media
  richText,
  video,
  milestone,
  // ME VS HER — the seven days
  mirrorGaze, // Days 1-6. Silent. Never Day 7.
  patternSelect, // Day 1 - WHICH ONES FEEL LIKE ME? and Day 4
  statementFill, // Day 3 - ME, I see you
  areaPicker, // Day 4 - HERSELF / RELATIONSHIPS / MONEY / SUCCESS
  herReveal, // Day 5 - THIS IS HER
  meVsHerCompare, // Day 7 - the biggest visual moment
  choiceCapture, // Day 7 - WHO ARE YOU CHOOSING?
  meVsHerCard, // Day 7 - the card she takes with her
  callback, // any day after the first
  /*
   * Available in the palette, NOT seeded into ME VS. HER.
   *
   * These teach Academy content - beliefs, subconscious programming, the
   * manifestation loop, the retirement ceremony - and the challenge is
   * explicitly scoped out of all of it. ME VS. HER creates awareness and the
   * first identity shift; naming a belief is the next product, not this one.
   * They stay registered because the Academy is built from the same engine.
   */
  mePortrait,
  protectorProfile,
  emotionTrail,
  beliefReview,
  manifestationLoop,
  celebration,
  dualColumnExercise,
  herChoiceCapture,
  mirrorDeclaration,
  meRetirement,
  evidenceReview,
  herCodeBuilder,
  beliefOrigin,
  validationAudit,
  behaviorCommitment,
  myPart,
  // General purpose
  reflectionPrompt,
  journalPrompt,
  actionCommitment,
]

export const blockRegistry: ReadonlyMap<string, AnyBlockDefinition> = new Map(
  definitions.map((d) => [d.type, d]),
)

export function getBlock(type: string): AnyBlockDefinition | undefined {
  return blockRegistry.get(type)
}

/** The admin block palette. */
export function listBlocks(): readonly AnyBlockDefinition[] {
  return definitions
}

/**
 * True when a block type's responses must be encrypted. Read from the registry
 * rather than duplicated in the database, so the two can never disagree.
 */
export function isSensitiveType(type: string): boolean {
  return getBlock(type)?.isSensitive ?? false
}
