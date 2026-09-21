import { Button, Field, Input } from '@/design-system/primitives'
import { siteImageMap } from '@/db/queries/images'

import {
  cropFor,
  focusChoicesX,
  focusChoicesY,
  imageSlots,
  variants,
  type Variant,
} from '@/features/images/slots'
import { maxUploadBytes } from '@/features/images/process'

export const metadata = { title: 'Photographs' }
export const dynamic = 'force-dynamic'

/**
 * Where the photographs on the public site get set.
 *
 * Every slot is on this page whether or not it is filled, with what to
 * photograph written next to the empty frame. That is the point: the shot list
 * lives here, beside the thing it fills, rather than in a document that has to
 * be found first.
 */

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`

export default async function ImagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [images, params] = await Promise.all([siteImageMap(), searchParams])

  const one = (k: string) => {
    const v = params[k]
    return Array.isArray(v) ? v[0] : v
  }
  const errorSlot = one('slot')
  const error = one('error')
  const saved = one('saved')
  const removed = one('removed')

  const filled = imageSlots.filter((s) => images.get(s.key)?.desktop).length

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 md:px-8">
      <h1 className="font-display text-2xl">Photographs</h1>
      <p className="measure mt-3 text-sm text-ink-soft">
        {filled} of {imageSlots.length} places on the site have a photograph in
        them. Each one below says where it appears and what to shoot. You do not
        have to do them all at once — a slot with nothing in it simply leaves
        that part of the page as words.
      </p>
      <p className="measure mt-3 text-xs text-ink-muted">
        Anything you upload here is public. The site strips the hidden data out
        of your photographs first, including the location tag a phone attaches —
        so uploading a picture taken at home does not publish where you live.
        Files are resized and converted for you; send the biggest version you
        have, up to {megabytes(maxUploadBytes)}.
      </p>

      {saved && (
        <p className="mt-6 rounded-md border border-rule bg-alabaster px-4 py-3 text-xs text-ink">
          Saved. It is live on the site now.
        </p>
      )}
      {removed && (
        <p className="mt-6 rounded-md border border-rule bg-alabaster px-4 py-3 text-xs text-ink">
          Removed. That part of the page is back to words only.
        </p>
      )}

      <div className="mt-10 space-y-px">
        {imageSlots.map((slot) => {
          const held = images.get(slot.key)
          const slotError = errorSlot === slot.key ? error : undefined

          return (
            <section
              key={slot.key}
              aria-labelledby={`slot-${slot.key}`}
              className="border-t border-rule py-10"
            >
              <h2 id={`slot-${slot.key}`} className="font-display text-lg">
                {slot.label}
              </h2>
              <p className="mt-1 text-2xs uppercase tracking-[0.18em] text-clay-deep">
                {slot.where}
              </p>
              <p className="measure mt-3 text-sm text-ink-soft">{slot.brief}</p>
              {slot.protectsSubject && (
                <p className="measure mt-2 text-2xs text-ink-muted">
                  Words sit over this one. Leave a plain, empty area for them —
                  nothing is ever placed over your face.
                </p>
              )}

              {slotError && (
                <p
                  role="alert"
                  className="mt-4 rounded-md border border-clay bg-alabaster px-4 py-3 text-xs text-ink"
                >
                  {slotError}
                </p>
              )}

              <div className="mt-6 grid gap-8 md:grid-cols-2">
                {variants.map((variant: Variant) => {
                  const current = variant === 'mobile' ? held?.mobile : held?.desktop
                  const crop = cropFor(slot, variant)
                  const id = `${slot.key}-${variant}`

                  return (
                    <div key={variant} className="rounded-xl border border-rule p-5">
                      <p className="text-xs font-medium text-ink">
                        {variant === 'mobile' ? 'Phone' : 'Desktop'}
                        <span className="ml-2 font-normal text-ink-muted">
                          {crop.ratio.replace(/\s/g, '')}
                        </span>
                      </p>
                      <p className="mt-1 text-2xs text-ink-muted">{crop.framing}</p>

                      <div className="mt-4">
                        {current ? (
                          <img
                            src={`/api/images/${slot.key}?variant=${variant}&v=${current.version}`}
                            alt={current.alt}
                            style={{ aspectRatio: crop.ratio }}
                            className="w-full rounded-lg bg-linen object-cover"
                          />
                        ) : (
                          <div
                            style={{ aspectRatio: crop.ratio }}
                            className="flex w-full items-center justify-center rounded-lg border border-dashed border-rule-strong bg-linen/40 text-2xs text-ink-muted"
                          >
                            {variant === 'mobile' && held?.desktop
                              ? 'Using the desktop one'
                              : 'Nothing here yet'}
                          </div>
                        )}
                      </div>

                      {current && (
                        <p className="mt-2 text-2xs text-ink-muted">
                          {current.width}×{current.height}, {megabytes(current.byteSize)}
                        </p>
                      )}

                      <form
                        action="/admin/images/manage"
                        method="post"
                        encType="multipart/form-data"
                        className="mt-4 grid gap-4"
                      >
                        <input type="hidden" name="slot" value={slot.key} />
                        <input type="hidden" name="variant" value={variant} />

                        <Field
                          htmlFor={`file-${id}`}
                          label={current ? 'Replace it' : 'Choose a photograph'}
                          hint={
                            current
                              ? 'Leave empty to change only the description or framing.'
                              : undefined
                          }
                        >
                          <input
                            type="file"
                            name="file"
                            accept="image/*"
                            className="block w-full text-xs text-ink-soft file:mr-3 file:min-h-9 file:rounded-md file:border file:border-rule-strong file:bg-alabaster file:px-3 file:text-xs file:text-ink"
                          />
                        </Field>

                        <Field
                          htmlFor={`alt-${id}`}
                          label="Describe it"
                          hint="What someone who cannot see it gets instead."
                        >
                          <Input
                            name="alt"
                            defaultValue={current?.alt ?? ''}
                            maxLength={300}
                            required
                            placeholder="Quiana, seated by a window, looking at the camera."
                          />
                        </Field>

                        <fieldset>
                          <legend className="text-xs text-ink-soft">Keep in frame</legend>
                          <div className="mt-2 grid gap-2">
                            {(
                              [
                                ['focusX', 'Across', focusChoicesX, current?.focalX ?? 50],
                                ['focusY', 'Down', focusChoicesY, current?.focalY ?? 50],
                              ] as const
                            ).map(([field, axis, choices, selected]) => (
                              <div key={field} className="flex flex-wrap items-center gap-3">
                                <span className="w-14 text-2xs uppercase tracking-[0.18em] text-ink-muted">
                                  {axis}
                                </span>
                                {choices.map((choice) => (
                                  <label
                                    key={choice.value}
                                    className="inline-flex min-h-9 items-center gap-1.5 text-xs text-ink-soft"
                                  >
                                    <input
                                      type="radio"
                                      name={field}
                                      value={choice.value}
                                      defaultChecked={selected === choice.value}
                                    />
                                    {choice.label}
                                  </label>
                                ))}
                              </div>
                            ))}
                          </div>
                        </fieldset>

                        <div className="flex flex-wrap items-center gap-3">
                          <Button type="submit" size="sm">
                            {current ? 'Save' : 'Put it on the site'}
                          </Button>
                          {current && (
                            <Button
                              type="submit"
                              name="intent"
                              value="remove"
                              size="sm"
                              variant="secondary"
                              formNoValidate
                            >
                              Remove
                            </Button>
                          )}
                        </div>
                      </form>
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
