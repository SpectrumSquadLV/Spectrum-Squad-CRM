import { z } from 'zod'
import { cn } from '@/lib/utils/cn'
import { herLine } from '@/features/challenge/her-voice'
import type { BlockDefinition, BlockMemberProps } from '../../contract'
import {
  answersLabel,
  classify,
  isDark,
  lines,
  paragraphs,
  promotedBeats,
  type Scene,
} from './scene'

const configSchema = z.object({
  heading: z.string().optional(),
  body: z.string(),
  align: z.enum(['left', 'center']).default('left'),
  /** The environment this passage lives in. See ./scene.ts. */
  scene: z
    .enum(['page', 'chapter', 'confront', 'declaration', 'close'])
    .default('page'),
  /** A key from her-voice.ts. HER, in handwriting, after the copy. */
  herVoice: z.string().optional(),
})

type Config = z.infer<typeof configSchema>

/**
 * Her own words, dropped into the copy.
 *
 * Day 1 Screen 5 is "THIS HAPPENED: [trigger] AND ME: [me_response]", and it
 * only lands because those are the sentences SHE typed twenty seconds ago.
 * `{{trigger}}` in the body is replaced with what she saved under that name
 * today.
 *
 * A placeholder with nothing behind it renders as nothing rather than as
 * "{{trigger}}": a woman who skipped a screen should never be shown the
 * machinery.
 */
function fill(body: string, today: Record<string, string> | undefined): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    (today?.[name] ?? '').trim(),
  )
}

/** HER, in her own hand. Never small, never often. See her-voice.ts. */
function HerVoice({ voiceKey, dark }: { voiceKey: string; dark: boolean }) {
  const line = herLine(voiceKey)
  if (!line) return null
  return (
    <p
      className={cn(
        'mt-14 font-script text-4xl leading-[1.15] md:text-5xl',
        dark ? 'text-bone/70' : 'text-clay-deep/80',
      )}
    >
      {line.text}
    </p>
  )
}

/**
 * One paragraph, set according to what it is rather than where it sits.
 *
 * The kinds come from ./scene.ts and are judged by shape alone, so a screen
 * nobody has written yet gets the same treatment as Day 1 without anybody
 * adding a case for it.
 */
function Paragraph({
  text,
  scene,
  dark,
  loud,
  answer,
}: {
  text: string
  scene: Scene
  dark: boolean
  /** This beat is the pivot of its run. See promotedBeats. */
  loud: boolean
  /** This prose is the answer to the label above it. See answersLabel. */
  answer: boolean
}) {
  const kind = classify(text)
  const body = dark ? 'text-bone/75' : 'text-ink-soft'
  const strong = dark ? 'text-bone' : 'text-ink'

  if (kind === 'label') {
    return (
      <p
        className={cn(
          'mb-4 mt-10 text-2xs uppercase tracking-[0.24em] first:mt-0',
          dark ? 'text-bone/60' : 'text-ink-muted',
        )}
      >
        {/* The colon framed her answer on screen; the type does that now. */}
        {text.trim().replace(/:$/, '')}
      </p>
    )
  }

  if (kind === 'litany') {
    /*
     * ME's list, stacked.
     *
     * Tight leading, a hairline down the left, and each way ME moves on its
     * own line. Set as prose this was one long run-on sentence; stacked it is
     * the drumbeat it was written as - and the compression is ME's visual
     * language before that language has been explained to anyone.
     */
    return (
      <ul
        className={cn(
          'mb-8 space-y-1.5 border-l pl-5',
          dark ? 'border-bone/20' : 'border-rule-strong',
        )}
      >
        {lines(text).map((line, i) => (
          <li key={i} className={cn('text-base leading-snug', body)}>
            {line.trim()}
          </li>
        ))}
      </ul>
    )
  }

  if (kind === 'beat') {
    /*
     * The pivots. "That's her." "There she is."
     *
     * Only the first beat of a run is loud - see promotedBeats. The rest sit
     * underneath it at reading size with the spacing closed up, so a run
     * reads as one gesture rather than six competing headlines.
     */
    if (!loud) {
      return (
        <p className={cn('mb-2 leading-snug last:mb-0', body)}>{text.trim()}</p>
      )
    }
    return (
      <p
        className={cn(
          'mb-6 mt-10 font-display leading-[1.12] first:mt-0',
          scene === 'confront' ? 'text-3xl md:text-4xl' : 'text-2xl',
          strong,
        )}
      >
        {text.trim()}
      </p>
    )
  }

  if (answer) {
    return (
      <p
        className={cn(
          'mb-10 whitespace-pre-line font-display leading-[1.2]',
          scene === 'confront' ? 'text-2xl md:text-3xl' : 'text-xl',
          strong,
        )}
      >
        {text.trim()}
      </p>
    )
  }

  return (
    <p className={cn('mb-6 whitespace-pre-line leading-relaxed last:mb-0', body)}>
      {text.trim()}
    </p>
  )
}

/** The emphasis decisions for one body, made once, in order. */
function useEmphasis(paras: readonly string[], scene: Scene) {
  const kinds = paras.map(classify)
  return { loud: promotedBeats(kinds, scene), answer: answersLabel(kinds) }
}

function Member({ config, today }: BlockMemberProps<Config, undefined>) {
  const body = fill(config.body, today)
  const scene = config.scene
  const dark = isDark(scene)
  const paras = paragraphs(body)
  const { loud, answer } = useEmphasis(paras, scene)

  const heading = config.heading && (
    <h2
      className={cn(
        'font-display leading-[1.03]',
        scene === 'declaration'
          ? 'text-5xl md:text-7xl'
          : scene === 'chapter'
            ? 'mb-10 text-4xl md:text-5xl'
            : scene === 'confront'
              ? 'mb-12 text-2xs uppercase tracking-[0.24em] text-bone/60'
              : 'mb-4 text-2xl',
        dark && scene !== 'confront' && 'text-bone',
      )}
    >
      {config.heading}
    </h2>
  )

  if (scene === 'declaration') {
    /*
     * "LOOK AT HER." alone.
     *
     * The instruction before the first mirror is the one line on Day 1 a
     * woman has to carry with her into sixty seconds of silence, and it used
     * to be a 24px heading above five paragraphs. Now the body sits small and
     * far below it, so the line is the only thing on the screen at the size
     * she will remember.
     */
    return (
      <div className="flex min-h-[26rem] flex-col justify-center">
        {heading}
        {/*
          The instructions under the line.
          
          Reading size, not fine print. They were text-sm under a 7xl heading
          and read as the small print beneath a poster - but a woman is about
          to follow them for sixty seconds with nothing else on screen, so
          they have to be comfortable to read. No beat inside here is ever
          promoted (see promotedBeats): the screen has one loud thing on it
          and this is not it.
        */}
        <div className="measure mt-16 space-y-1">
          {paras.map((p, i) => (
            <Paragraph
              key={i}
              text={p}
              scene={scene}
              dark={dark}
              loud={loud[i] ?? false}
              answer={answer[i] ?? false}
            />
          ))}
        </div>
        {config.herVoice && <HerVoice voiceKey={config.herVoice} dark={dark} />}
      </div>
    )
  }

  if (scene === 'confront') {
    /*
     * Edge to edge, and dark.
     *
     * The runner's column is 42rem of cream; a screen that is supposed to
     * stop a woman cannot be a paragraph inside it. The negative margins take
     * this passage out to the full width of the viewport, and the runner
     * darkens the page around it so the ground goes with it.
     */
    return (
      <div className="-mx-5 bg-plum-deep px-5 py-20 md:-mx-8 md:px-14 md:py-28">
        <div className="measure">
          {heading}
          {paras.map((p, i) => (
            <Paragraph
              key={i}
              text={p}
              scene={scene}
              dark={dark}
              loud={loud[i] ?? false}
              answer={answer[i] ?? false}
            />
          ))}
          {config.herVoice && <HerVoice voiceKey={config.herVoice} dark={dark} />}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        config.align === 'center' ? 'measure mx-auto text-center' : 'measure',
        scene === 'close' && 'py-6',
      )}
    >
      {heading}
      {paras.map((p, i) => (
        <Paragraph
          key={i}
          text={p}
          scene={scene}
          dark={dark}
          loud={loud[i] ?? false}
          answer={answer[i] ?? false}
        />
      ))}
      {config.herVoice && <HerVoice voiceKey={config.herVoice} dark={dark} />}
    </div>
  )
}

export const richText: BlockDefinition<typeof configSchema, undefined> = {
  type: 'rich_text',
  label: 'Text',
  description:
    'A heading and body copy, set in one of several scenes. Display only.',
  configSchema,
  responseSchema: null,
  Member,
  isSensitive: false,
}
