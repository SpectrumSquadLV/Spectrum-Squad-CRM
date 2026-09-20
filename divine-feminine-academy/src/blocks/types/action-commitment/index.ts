import type { BlockDefinition } from '../../contract'
import { ActionCommitmentMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const actionCommitment: BlockDefinition<typeof configSchema, Response> = {
  type: 'action_commitment',
  label: 'Action commitment',
  description: 'One concrete thing she will do, with a when and a done box.',
  configSchema,
  responseSchema,
  Member: ActionCommitmentMember,
  isSensitive: false,
}
