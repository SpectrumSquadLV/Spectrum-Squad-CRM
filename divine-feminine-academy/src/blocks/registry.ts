import type { AnyBlockDefinition } from './contract'
import { dualColumnExercise } from './types/dual-column-exercise'
import { reflectionPrompt } from './types/reflection-prompt'
import { richText } from './types/rich-text'

/**
 * THE BLOCK REGISTRY.
 *
 * This is the single most important piece of the architecture. A lesson is a
 * list of typed blocks; each type maps to exactly one entry here.
 *
 * - A new PROGRAM needs no code at all. It is rows in the database, assembled
 *   in the admin program builder.
 * - A new BLOCK TYPE is one folder under ./types plus one line below.
 *
 * Block types still to build (see the Phase 1 architecture doc):
 *   video, audio, download, belief_origin, validation_audit,
 *   behavior_commitment, return_practice, her_choice_capture,
 *   evidence_review, her_code_builder, journal_prompt, quiz_question,
 *   assessment_embed, action_commitment, milestone
 */
const definitions: AnyBlockDefinition[] = [
  richText,
  dualColumnExercise,
  reflectionPrompt,
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
