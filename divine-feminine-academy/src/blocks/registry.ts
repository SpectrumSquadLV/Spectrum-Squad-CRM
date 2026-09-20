import type { AnyBlockDefinition } from './contract'
import { actionCommitment } from './types/action-commitment'
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
 * Still to build: quiz_question and assessment_embed (Phase 4), audio and
 * download.
 */
const definitions: AnyBlockDefinition[] = [
  // Structure and media
  richText,
  video,
  milestone,
  // The seven days
  dualColumnExercise, // Day 1 - meet her
  beliefOrigin, // Day 2 - where it started
  validationAudit, // Day 3 - whose approval
  behaviorCommitment, // Day 4 - the behaviour
  returnPractice, // Day 5 - the way back
  herChoiceCapture, // Day 6 - I chose HER
  evidenceReview, // Day 7 - her evidence
  herCodeBuilder, // Day 7 - her code
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
