/**
 * Day 1: Current Me / HER. The block whose output becomes her HER profile.
 *
 * Deliberately NOT a 'use client' module. The registry is read on the SERVER
 * to build the admin block palette and to decide which responses get
 * encrypted. A definition exported from a client module crosses the boundary
 * as an opaque client reference, and every field on it reads back undefined -
 * which is exactly the bug this layout prevents.
 */
import type { BlockDefinition } from '../../contract'
import { DualColumnMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const dualColumnExercise: BlockDefinition<typeof configSchema, Response> = {
  type: 'dual_column_exercise',
  label: 'Current Me / HER',
  description:
    'Two columns: how she responds now, how HER responds. Writes to her HER profile.',
  configSchema,
  responseSchema,
  Member: DualColumnMember,
  isSensitive: false,
  writesTo: ['her_patterns'],
}
