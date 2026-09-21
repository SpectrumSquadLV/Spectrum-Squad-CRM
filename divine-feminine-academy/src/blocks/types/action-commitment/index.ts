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
  /*
   * Sensitive, and it did not used to be.
   *
   * When this block only asked "what will you do and when", a plaintext row
   * was defensible. It does not only do that any more: on Day 6 it echoes the
   * one choice she made, and on Day 7 what HER would do about a real decision
   * in her life right now. Those are her words, about the most private thing
   * in the week, and they were going into Postgres in the clear.
   */
  isSensitive: true,
}
