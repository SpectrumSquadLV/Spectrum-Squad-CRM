import type { AnyBlockDefinition } from './contract'
import { actionCommitment } from './types/action-commitment'
import { beliefReview } from './types/belief-review'
import { callback } from './types/callback'
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
import { herCodeBuilder } from './types/her-code-builder'
import { journalPrompt } from './types/journal-prompt'
import { milestone } from './types/milestone'
import { reflectionPrompt } from './types/reflection-prompt'
import { returnPractice } from './types/return-practice'
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
  mirrorGaze, // Days 1-6, daily, one intention each
  mePortrait, // Day 1 - MEET ME
  protectorProfile, // Day 2 - MEET YOUR PROTECTOR
  emotionTrail, // Day 3 - FOLLOW THE EMOTION
  beliefReview, // Day 4 - REVIEW THE BELIEF
  manifestationLoop, // Day 5 - THE PROBLEM IS YOU
  celebration, // Day 5 - her power, in her own numbers
  dualColumnExercise, // Day 6 - ME | HER
  herChoiceCapture, // Day 6 - I CHOSE HER
  mirrorDeclaration, // Day 7 - spoken, as HER
  meRetirement, // Day 7 - understood, loved, thanked, released
  evidenceReview, // Day 7 - her week, read back
  herCodeBuilder, // Day 7 - her code
  callback, // any day after the first
  // Available in the palette, not seeded into a day
  beliefOrigin,
  validationAudit,
  behaviorCommitment,
  returnPractice,
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
