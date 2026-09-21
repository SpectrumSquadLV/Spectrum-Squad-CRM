/** Day 4. Server-readable definition. */
import type { BlockDefinition } from '../../contract'
import { BehaviorCommitmentMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const behaviorCommitment: BlockDefinition<typeof configSchema, Response> = {
  type: 'behavior_commitment',
  label: 'Behaviour commitment',
  description: 'One behaviour she commits to changing, named specifically.',
  configSchema,
  responseSchema,
  Member: BehaviorCommitmentMember,
  isSensitive: false,
  writesTo: ['her_patterns'],
}
