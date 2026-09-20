/**
 * A video. Display only, so no client split is needed.
 *
 * Deliberately a plain iframe against a hosted player (Mux or Cloudflare
 * Stream) rather than a self-hosted file: adaptive bitrate is what makes this
 * watchable on mobile data, which is how most women will see it.
 */
import { z } from 'zod'

const configSchema = z.object({
  title: z.string().optional(),
  caption: z.string().optional(),
  /** Player embed URL. Never a raw video file. */
  embedUrl: z.string().url(),
  aspect: z.enum(['16/9', '9/16', '1/1']).default('16/9'),
})

type Config = z.infer<typeof configSchema>

import type { BlockDefinition, BlockMemberProps } from '../../contract'

function VideoMember({ config }: BlockMemberProps<Config, undefined>) {
  return (
    <div className="measure-wide">
      {config.title && <h2 className="text-2xl mb-4">{config.title}</h2>}
      <div
        className="overflow-hidden rounded-lg border border-rule bg-ink"
        style={{ aspectRatio: config.aspect }}
      >
        <iframe
          src={config.embedUrl}
          title={config.title ?? 'Video'}
          allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          className="h-full w-full"
        />
      </div>
      {config.caption && (
        <p className="mt-3 text-2xs text-ink-muted">{config.caption}</p>
      )}
    </div>
  )
}

export const video: BlockDefinition<typeof configSchema, undefined> = {
  type: 'video',
  label: 'Video',
  description: 'An embedded video from a hosted player. Display only.',
  configSchema,
  responseSchema: null,
  Member: VideoMember,
  isSensitive: false,
}
