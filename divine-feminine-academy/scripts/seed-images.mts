/**
 * Photographs committed to the repository, put into their slots.
 *
 * The admin page is the way to change a photograph once the site has a login
 * on it. This is the other way in: drop a file into assets/photographs named
 * after the slot it belongs to, push, and it is on the site when the deploy
 * finishes. Useful before there is an account to sign in with, and useful
 * afterwards for anything that should travel with the code.
 *
 *     assets/photographs/home-hero.jpg         ->  the hero, desktop crop
 *     assets/photographs/home-hero.mobile.jpg  ->  the hero, phone crop
 *
 * A name with no `.mobile` in it is the desktop crop. The phone crop is
 * optional; without one the desktop crop is used everywhere, which is a worse
 * picture on a phone but never a broken page.
 *
 * The description comes from a .txt file beside it with the same name. That
 * file is not optional: a photograph with no description is refused rather
 * than given an invented one, because a made-up description is worse than
 * none for the person relying on it.
 *
 * Idempotent, by content. The stored version is a hash of the source file, so
 * running this on every deploy does nothing until a file actually changes -
 * and when one does, the hash changes, which is also exactly what busts the
 * caches holding the old picture.
 *
 * Never overwrites a photograph uploaded through the admin. Once a real
 * person has chosen something, a file sitting in the repository does not get
 * to quietly replace it.
 *
 * Run: DATABASE_URL=... npm run seed:images
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { siteImages } from '../src/db/schema/media'
import { processUpload } from '../src/features/images/process'
import {
  cropFor,
  focusChoicesX,
  focusChoicesY,
  imageSlot,
  type Variant,
} from '../src/features/images/slots'

/**
 * The description file, and an optional line saying how to frame the crop.
 *
 *     Quiana, seated in a white chair against a warm plaster wall.
 *     focus: right bottom
 *
 * Needed because a photograph composed with the subject to one side - so the
 * words have somewhere to go - is precisely the one a centred crop ruins, and
 * before there is a login there is no other way to say so.
 */
function readDescription(raw: string): { alt: string; focalX: number; focalY: number } | null {
  let focalX = 50
  let focalY = 50
  const lines: string[] = []

  for (const line of raw.split('\n')) {
    const focus = /^focus:\s*(.+)$/i.exec(line.trim())
    if (!focus) {
      lines.push(line)
      continue
    }
    for (const word of focus[1]!.toLowerCase().split(/[\s,]+/)) {
      const x = focusChoicesX.find((c) => c.label.toLowerCase() === word)
      if (x) focalX = x.value
      const y = focusChoicesY.find((c) => c.label.toLowerCase() === word)
      if (y) focalY = y.value
    }
  }

  const alt = lines.join(' ').trim()
  return alt.length > 0 ? { alt, focalX, focalY } : null
}

const here = dirname(fileURLToPath(import.meta.url))
const folder = resolve(here, '..', 'assets', 'photographs')

const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.avif', '.tif', '.tiff'])

let added = 0
let replaced = 0
let unchanged = 0
let skipped = 0

let files: string[]
try {
  files = await readdir(folder)
} catch {
  console.log('no assets/photographs folder — nothing to do')
  process.exit(0)
}

const photographs = files.filter((f) => imageExtensions.has(extname(f).toLowerCase()))

if (photographs.length === 0) {
  console.log('assets/photographs is empty — nothing to do')
  process.exit(0)
}

for (const file of photographs) {
  let key = file.slice(0, file.length - extname(file).length)

  let variant: Variant = 'desktop'
  if (key.endsWith('.mobile')) {
    variant = 'mobile'
    key = key.slice(0, -'.mobile'.length)
  }

  const spec = imageSlot(key)

  if (!spec) {
    console.error(`  skip  ${file} — there is no slot called "${key}"`)
    skipped++
    continue
  }

  const source = await readFile(join(folder, file))
  const version = createHash('sha256').update(source).digest('hex').slice(0, 16)

  const [existing] = await db
    .select({
      version: siteImages.version,
      uploadedBy: siteImages.uploadedBy,
      alt: siteImages.alt,
    })
    .from(siteImages)
    .where(and(eq(siteImages.slot, key), eq(siteImages.variant, variant)))
    .limit(1)

  if (existing?.version === version) {
    console.log(`  same  ${key} (${variant})`)
    unchanged++
    continue
  }

  if (existing && existing.uploadedBy !== null) {
    console.log(`  kept  ${key} (${variant}) — someone uploaded this one through the admin`)
    skipped++
    continue
  }

  let raw: string
  try {
    raw = await readFile(join(folder, `${key}.txt`), 'utf8')
  } catch {
    console.error(`  skip  ${key} — no ${key}.txt, so there is no description for it`)
    skipped++
    continue
  }

  const described = readDescription(raw)
  if (!described) {
    console.error(`  skip  ${key} — ${key}.txt has no description in it`)
    skipped++
    continue
  }
  const { alt, focalX, focalY } = described

  const processed = await processUpload(source, cropFor(spec, variant).maxPx)

  const values = {
    slot: key,
    variant,
    alt,
    contentType: processed.contentType,
    bytes: processed.bytes,
    byteSize: processed.byteSize,
    width: processed.width,
    height: processed.height,
    focalX,
    focalY,
    version,
    uploadedBy: null,
    updatedAt: new Date(),
  }

  await db
    .insert(siteImages)
    .values(values)
    .onConflictDoUpdate({
      target: [siteImages.slot, siteImages.variant],
      set: values,
    })

  console.log(
    `  ${existing ? 'new ' : 'add '} ${key} (${variant}) — ${processed.width}×${processed.height}, ${(processed.byteSize / 1024).toFixed(0)}KB`,
  )
  if (existing) replaced++
  else added++
}

console.log(`\nphotographs: ${added} added, ${replaced} updated, ${unchanged} unchanged, ${skipped} skipped`)
console.log('location data and orientation flags are stripped on the way in')

process.exit(0)
