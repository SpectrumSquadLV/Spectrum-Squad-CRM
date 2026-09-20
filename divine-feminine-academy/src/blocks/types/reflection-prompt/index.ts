/**
 * An open written reflection, encrypted at rest.
 *
 * Deliberately NOT a 'use client' module - see dual-column-exercise/index.ts
 * for why. `isSensitive` in particular is read on the server to decide whether
 * a response is encrypted, so it must survive as real data.
 */
import type { BlockDefinition } from '../../contract'
import { ReflectionMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const reflectionPrompt: BlockDefinition<typeof configSchema, Response> = {
  type: 'reflection_prompt',
  label: 'Reflection',
  description: 'An open written reflection. Encrypted; only she can read it.',
  configSchema,
  responseSchema,
  Member: ReflectionMember,
  isSensitive: true,
  writesTo: ['journal_entries'],
}
