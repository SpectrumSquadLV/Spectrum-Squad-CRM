/** Day 3 — FOLLOW THE EMOTION. */
import type { BlockDefinition } from '../../contract'
import { EmotionTrailMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const emotionTrail: BlockDefinition<typeof configSchema, Response> = {
  type: 'emotion_trail',
  label: 'Follow the emotion',
  description:
    'Event, emotion, reaction, what she was protecting, the earlier time, and what she learned about herself. Encrypted.',
  configSchema,
  responseSchema,
  Member: EmotionTrailMember,
  isSensitive: true,
  writesTo: ['journal_entries'],
}
