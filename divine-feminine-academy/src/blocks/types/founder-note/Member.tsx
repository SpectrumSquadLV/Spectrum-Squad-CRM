'use client'

import { cn } from '@/lib/utils/cn'
import { founderNote } from '@/features/challenge/founder-notes'
import type { BlockMemberProps } from '../../contract'
import type { Config } from './schema'

/**
 * A person, not a product, immediately before the hardest thing in the day.
 *
 * Everything about this screen is built to read as someone talking rather
 * than as another instruction. The type is smaller than the day's headings,
 * the lines are close, there is no heading in capitals and no button. It is
 * set off with a rule and her name, the way a letter is.
 *
 * The photograph is not decoration here, which is why it degrades the way it
 * does: if she has not uploaded one, the note centres itself and reads as a
 * note. It never holds a grey box open waiting for a face. A missing
 * photograph should cost this screen some of its warmth and none of its
 * meaning.
 *
 * The origin paragraphs are set apart from the rest because they are a
 * different kind of speech - the promise is addressed to the reader, the
 * origin is Quiana telling on herself - and because they are the part that
 * may not exist yet. Absent, the note simply ends sooner.
 */
export function FounderNoteMember({ config, portrait }: BlockMemberProps<Config, undefined>) {
  const note = founderNote(config.note)

  /*
   * A key that no longer matches a note.
   *
   * Renders nothing rather than an error. A woman part-way through Day 4 is
   * not the person who should discover that a content key was renamed, and
   * the day is entirely coherent without this screen - it is the one block in
   * the curriculum that adds nothing she is required to do.
   */
  if (!note) return null

  const photo = config.portrait ? (portrait?.desktop ?? null) : null
  const mobile = portrait?.mobile ?? null

  return (
    <div className="measure mx-auto">
      <figure
        className={cn(
          'flex flex-col gap-8',
          photo && 'sm:flex-row sm:items-start sm:gap-10',
        )}
      >
        {photo && (
          <div className="shrink-0 self-center sm:self-start">
            <picture>
              {mobile && (
                <source
                  media="(max-width: 640px)"
                  srcSet={`/api/images/founder-note?variant=mobile&v=${mobile.version}`}
                />
              )}
              <img
                src={`/api/images/founder-note?variant=desktop&v=${photo.version}`}
                alt={photo.alt}
                width={photo.width}
                height={photo.height}
                loading="lazy"
                decoding="async"
                className="h-32 w-32 rounded-full object-cover sm:h-40 sm:w-40"
                style={{ objectPosition: `${photo.focalX}% ${photo.focalY}%` }}
              />
            </picture>
          </div>
        )}

        {/*
          Body copy stays left-aligned whether or not there is a photograph.
          Centred text is fine for one line and punishing for six: each line
          begins somewhere new, so the eye has to find the start of every one.
          Only the eyebrow and her name centre when the photograph is missing,
          because those ARE one line each and they are what holds the column
          together once the face is gone.
        */}
        <figcaption className="min-w-0">
          <p
            className={cn(
              'text-2xs uppercase tracking-[0.18em] text-ink-muted',
              !photo && 'text-center',
            )}
          >
            {note.eyebrow}
          </p>

          <div className="mt-5 space-y-4">
            {note.paragraphs.map((line, i) => (
              <p key={i} className="text-base leading-relaxed text-ink-soft">
                {line}
              </p>
            ))}
          </div>

          {note.origin.length > 0 && (
            <div className="mt-7 space-y-4 border-l-2 border-clay-deep/30 pl-5">
              {note.origin.map((line, i) => (
                <p key={i} className="text-base leading-relaxed text-ink-soft">
                  {line}
                </p>
              ))}
            </div>
          )}

          <p
            className={cn(
              'mt-7 font-display text-lg text-ink',
              !photo && 'text-center',
            )}
          >
            Quiana
          </p>
        </figcaption>
      </figure>
    </div>
  )
}
