/*
 * NOT a 'use client' module, deliberately - see the note in registry.ts. The
 * server reads these definitions to build the admin palette and to decide
 * which responses are encrypted, and a definition exported from a client
 * module arrives with every field undefined. This one can stay in a single
 * file because it holds no state: it renders what she already wrote.
 */
import type { BlockDefinition, BlockMemberProps } from '../../contract'
import { configSchema, type Config } from './schema'

/**
 * Two columns that do not resolve.
 *
 * ME is not drawn as the wrong answer. Same weight, same type, same space:
 * the only difference between the two sides is which version of her wrote
 * them. Shading ME as a warning and HER as a reward would decide the thing
 * the day exists to let her decide herself.
 *
 * Stacked on a phone, but still visibly opposed — the VS. sits between them
 * either way, because that is the whole picture.
 */
function Member({ config, today }: BlockMemberProps<Config, undefined>) {
  const get = (name: string) => (today?.[name] ?? '').trim()

  const decision = get(config.decisionFrom)
  const meWould = get(config.meWouldFrom)
  const meWhy = get(config.meWhyFrom)
  const herWould = get(config.herWouldFrom)
  const herWhy = get(config.herWhyFrom)

  if (!meWould && !herWould) {
    return (
      <p className="measure text-sm text-ink-muted">
        This is where the two answers sit side by side, once you have written
        them.
      </p>
    )
  }

  return (
    <div className="measure">
      {decision && (
        <div className="mb-10">
          <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
            You are deciding
          </p>
          <p className="mt-3 whitespace-pre-line font-display text-xl leading-snug">
            {decision}
          </p>
        </div>
      )}

      <div className="grid items-stretch gap-5 md:grid-cols-[1fr_auto_1fr]">
        <section className="rounded-xl border border-rule bg-alabaster p-6">
          <h3 className="font-display text-2xl tracking-tight">{config.meLabel}</h3>
          <p className="mt-4 whitespace-pre-line text-lg leading-relaxed text-ink">
            {meWould}
          </p>
          {meWhy && (
            <p className="mt-5 whitespace-pre-line text-sm text-ink-muted">
              <span className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
                Because
              </span>
              <br />
              {meWhy}
            </p>
          )}
        </section>

        <div
          aria-hidden
          className="flex items-center justify-center py-2 font-display text-sm tracking-[0.3em] text-clay-deep md:px-2"
        >
          VS.
        </div>

        <section className="rounded-xl border border-rule bg-alabaster p-6">
          <h3 className="font-display text-2xl tracking-tight">{config.herLabel}</h3>
          <p className="mt-4 whitespace-pre-line text-lg leading-relaxed text-ink">
            {herWould}
          </p>
          {herWhy && (
            <p className="mt-5 whitespace-pre-line text-sm text-ink-muted">
              <span className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
                Because
              </span>
              <br />
              {herWhy}
            </p>
          )}
        </section>
      </div>

      {config.close && (
        <p className="mt-10 whitespace-pre-line font-display text-lg leading-relaxed tracking-tight text-ink-soft">
          {config.close}
        </p>
      )}
    </div>
  )
}

export const meVsHerCompare: BlockDefinition<typeof configSchema, undefined> = {
  type: 'me_vs_her_compare',
  label: 'ME vs HER',
  description:
    'Her two answers to the same decision, side by side. Display only.',
  configSchema,
  responseSchema: null,
  Member,
  isSensitive: false,
}
