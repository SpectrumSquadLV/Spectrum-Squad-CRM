/** Daily, all seven days. */
import type { BlockDefinition } from '../../contract'
import { MirrorGazeMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const mirrorGaze: BlockDefinition<typeof configSchema, Response> = {
  type: 'mirror_gaze',
  label: 'Mirror gaze',
  description:
    'A timed look in the mirror with the day\'s intention held on screen. Records how long she actually stayed.',
  configSchema,
  responseSchema,
  Member: MirrorGazeMember,
  // What she writes afterwards is hers alone; the seconds are metadata.
  isSensitive: true,
  writesTo: ['mirror_sessions'],
}
