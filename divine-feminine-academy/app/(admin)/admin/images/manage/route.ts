import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema/activity'
import { siteImages } from '@/db/schema/media'
import { getActor } from '@/lib/auth/actor-server'
import { isAdmin } from '@/lib/permissions/actor'
import { ImageRejected, processUpload } from '@/features/images/process'
import { focusChoicesX, focusChoicesY, imageSlot } from '@/features/images/slots'

export const dynamic = 'force-dynamic'

/**
 * Uploading and removing photographs.
 *
 * A route handler taking a plain multipart form rather than a server action,
 * for two reasons. Server actions are capped by `serverActions.bodySizeLimit`,
 * and raising that globally to fit a camera photograph would raise it for
 * journal entries too. And a plain form posts without any JavaScript, which
 * means this keeps working on a bad connection, on an old phone, and in the
 * five seconds before the page has finished hydrating.
 *
 * Because it is its own endpoint it does its own checks. The admin layout
 * returning 404 protects the page; it protects nothing here.
 */

function back(request: Request, params: Record<string, string>) {
  const url = new URL('/admin/images', request.url)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  // 303 so the browser follows with a GET and a refresh does not re-upload.
  return Response.redirect(url, 303)
}

export async function POST(request: Request) {
  const actor = await getActor()
  if (!isAdmin(actor)) return new Response('Not found', { status: 404 })

  /*
   * Cross-site request forgery.
   *
   * A form on someone else's site can post here, and the browser would send
   * the session cookie with it. Server actions have an origin check built in;
   * a route handler has whatever it writes. Both headers below are set by
   * every browser that has shipped in years, and a request carrying neither
   * did not come from a page.
   */
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') {
    return new Response('Cross-origin request refused', { status: 403 })
  }
  const origin = request.headers.get('origin')
  if (origin) {
    const host = request.headers.get('host')
    if (!host || new URL(origin).host !== host) {
      return new Response('Cross-origin request refused', { status: 403 })
    }
  }

  const form = await request.formData()
  const slotKey = String(form.get('slot') ?? '')
  const spec = imageSlot(slotKey)
  if (!spec) return new Response('Unknown slot', { status: 400 })

  const actorUserId = actor.kind === 'user' ? actor.userId : null

  if (form.get('intent') === 'remove') {
    await db.delete(siteImages).where(eq(siteImages.slot, slotKey))
    await db.insert(auditLog).values({
      actorUserId,
      action: 'site_image.removed',
      entity: 'site_images',
      entityId: null,
      metadata: { slot: slotKey },
    })
    revalidatePath('/', 'layout')
    return back(request, { removed: slotKey })
  }

  const alt = String(form.get('alt') ?? '').trim()
  if (alt.length === 0) {
    return back(request, {
      slot: slotKey,
      error: 'Describe the photograph first — that description is what someone using a screen reader gets instead of the picture.',
    })
  }
  if (alt.length > 300) {
    return back(request, { slot: slotKey, error: 'That description is too long. A sentence is plenty.' })
  }

  // Never trusted from the form: an unexpected value falls back to centred
  // rather than going into object-position as-is.
  const pick = (
    field: string,
    choices: readonly { value: number }[],
  ): number => {
    const raw = Number(form.get(field))
    return choices.some((c) => c.value === raw) ? raw : 50
  }
  const focalX = pick('focusX', focusChoicesX)
  const focalY = pick('focusY', focusChoicesY)

  const file = form.get('file')
  const hasNewFile = file instanceof File && file.size > 0

  const [existing] = await db
    .select({ id: siteImages.id })
    .from(siteImages)
    .where(eq(siteImages.slot, slotKey))
    .limit(1)

  // Changing only the description or the framing must not require choosing the
  // file again. Browsers cannot prefill a file input, so requiring it would
  // mean re-uploading a photograph to fix a typo.
  if (!hasNewFile) {
    if (!existing) {
      return back(request, { slot: slotKey, error: 'Choose a photograph to upload.' })
    }
    await db
      .update(siteImages)
      .set({ alt, focalX, focalY, updatedAt: new Date() })
      .where(eq(siteImages.slot, slotKey))
    revalidatePath('/', 'layout')
    return back(request, { saved: slotKey })
  }

  let processed
  try {
    processed = await processUpload(
      Buffer.from(await file.arrayBuffer()),
      spec.shape,
    )
  } catch (error) {
    if (error instanceof ImageRejected) {
      return back(request, { slot: slotKey, error: error.message })
    }
    console.error('[images] upload failed', error)
    return back(request, {
      slot: slotKey,
      error: 'Something went wrong handling that photograph. Try once more.',
    })
  }

  const values = {
    slot: slotKey,
    alt,
    contentType: processed.contentType,
    bytes: processed.bytes,
    byteSize: processed.byteSize,
    width: processed.width,
    height: processed.height,
    focalX,
    focalY,
    version: processed.version,
    uploadedBy: actorUserId,
    updatedAt: new Date(),
  }

  await db
    .insert(siteImages)
    .values(values)
    .onConflictDoUpdate({ target: siteImages.slot, set: values })

  await db.insert(auditLog).values({
    actorUserId,
    action: existing ? 'site_image.replaced' : 'site_image.added',
    entity: 'site_images',
    entityId: null,
    metadata: {
      slot: slotKey,
      byteSize: processed.byteSize,
      width: processed.width,
      height: processed.height,
    },
  })

  revalidatePath('/', 'layout')
  return back(request, { saved: slotKey })
}
