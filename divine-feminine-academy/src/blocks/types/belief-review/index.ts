/** Day 4 — REVIEW THE BELIEF. */
import type { BlockDefinition } from '../../contract'
import { BeliefReviewMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const beliefReview: BlockDefinition<typeof configSchema, Response> = {
  type: 'belief_review',
  label: 'Review the belief',
  description:
    'The belief on trial: origin, evidence for and against, whether it moves her toward HER, and whether she is carrying or releasing it. Encrypted.',
  configSchema,
  responseSchema,
  Member: BeliefReviewMember,
  isSensitive: true,
  writesTo: ['journal_entries'],
}
