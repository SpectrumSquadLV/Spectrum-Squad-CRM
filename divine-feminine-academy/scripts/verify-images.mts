/**
 * The photographs.
 *
 * The thing actually worth proving here is the privacy one. A photograph taken
 * on a phone carries EXIF, and EXIF routinely carries the GPS coordinates of
 * where it was taken. Publishing an untouched picture of yourself at home
 * publishes your address to anybody who downloads it and runs exiftool, and
 * nobody involved would ever know it had happened. So: build a JPEG that has
 * GPS in it, put it through the upload path, and read the result back looking
 * for those coordinates.
 *
 * Then the orientation flag, which is the reason stripping EXIF is not free.
 * A phone stores the pixels sideways and sets a flag saying how far to turn
 * them. Drop the flag without applying it and the photograph lands on its
 * side, looking fine everywhere the woman checked it.
 *
 * And then the round trip: bytes in, row in Postgres, metadata back out
 * without dragging the bytes along.
 *
 * Run: DATABASE_URL=... npm run verify:images
 */
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { db } from '../src/db/client'
import { siteImages } from '../src/db/schema/media'
import { siteImageBytes, siteImageMap } from '../src/db/queries/images'
import { ImageRejected, processUpload } from '../src/features/images/process'
import { imageSlot, imageSlots } from '../src/features/images/slots'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * A JPEG shaped like something off a phone: a full EXIF block with GPS
 * coordinates in it, and an orientation flag saying the pixels are sideways.
 *
 * The GPS tags go in IFD2, which is where libvips keeps the GPS IFD. Passing
 * them under a `GPS` key - the obvious guess, and what this script did at
 * first - is accepted and silently dropped, which would have left this whole
 * file asserting that no coordinates survived a photograph that never had any.
 */
function phonePhotograph({ withGps }: { withGps: boolean }): Promise<Buffer> {
  const gps = {
    GPSLatitudeRef: 'N',
    GPSLatitude: '36/1 10/1 2345/100',
    GPSLongitudeRef: 'W',
    GPSLongitude: '115/1 8/1 5678/100',
  }

  return sharp({
    create: {
      // Landscape pixels flagged "turn me upright", which is the shape a phone
      // produces for a photograph taken in portrait.
      width: 400,
      height: 300,
      channels: 3,
      background: { r: 180, g: 120, b: 90 },
    },
  })
    .withExif({
      IFD0: { Make: 'VerifyPhone', Model: 'Model X' },
      ...(withGps ? { IFD2: gps } : {}),
    })
    // sharp writes the orientation flag through withMetadata rather than
    // through the EXIF block, so both calls are needed.
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer()
}

console.log('\nthe slot registry')

check('every slot key is unique', new Set(imageSlots.map((s) => s.key)).size === imageSlots.length)
check('every slot has a brief worth reading', imageSlots.every((s) => s.brief.length > 60))
check('an unknown slot is null, not a guess', imageSlot('home-hero-2') === null)
check('a known slot resolves', imageSlot('home-hero')?.shape === 'portrait')

console.log('\nwhat a phone attaches, and what survives')

const original = await phonePhotograph({ withGps: true })

{
  const withGps = await sharp(original).metadata()
  const without = await sharp(await phonePhotograph({ withGps: false })).metadata()

  check(
    'the test photograph really does carry GPS',
    // Proved by weighing it against the same photograph without coordinates,
    // rather than by trusting that the tags were accepted. They were not, the
    // first time this was written.
    withGps.exif !== undefined &&
      without.exif !== undefined &&
      withGps.exif.length > without.exif.length,
    `${withGps.exif?.length} vs ${without.exif?.length} bytes of EXIF`,
  )
  check('and really is flagged sideways', withGps.orientation === 6, String(withGps.orientation))
}

const processed = await processUpload(original, 'portrait')

{
  const after = await sharp(processed.bytes).metadata()

  check('the location data is gone', after.exif === undefined)
  check(
    'and is not hiding in the bytes',
    // "VerifyPhone" is a string written into the same EXIF block as the GPS
    // coordinates. GPS tags are binary and have no string to search for, so
    // this is the tracer: if the camera make is gone, the block is gone.
    !processed.bytes.includes(Buffer.from('VerifyPhone')),
  )
  check(
    'the orientation flag was applied, not merely dropped',
    // 400x300 flagged "turn upright" must come out 300 wide by 400 tall. If
    // the flag were dropped without being applied it would still be 400x300,
    // which is exactly the sideways photograph nobody notices until it ships.
    processed.width === 300 && processed.height === 400,
    `${processed.width}x${processed.height}`,
  )
  check('it is served as one format, whatever arrived', processed.contentType === 'image/webp')
  check('the dimensions recorded match the bytes', after.width === processed.width && after.height === processed.height)
  check('a version was minted for cache busting', processed.version.length >= 12)
}

console.log('\noversized and unreadable')

{
  const big = await sharp({
    create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .jpeg()
    .toBuffer()
  const out = await processUpload(big, 'landscape')
  check('a camera original is resized down', Math.max(out.width, out.height) <= 1600, `${out.width}x${out.height}`)
  check('a square slot is resized harder', Math.max((await processUpload(big, 'square')).width, 0) <= 900)
}

{
  let rejected: unknown
  try {
    await processUpload(Buffer.from('this is not a photograph, it is a sentence'), 'portrait')
  } catch (error) {
    rejected = error
  }
  check('a file that is not an image is refused', rejected instanceof ImageRejected)
  check(
    'and the refusal says what to do about it',
    rejected instanceof ImageRejected && /JPEG|PNG/.test(rejected.message),
    rejected instanceof Error ? rejected.message : '',
  )
}

{
  let rejected: unknown
  try {
    await processUpload(Buffer.alloc(0), 'portrait')
  } catch (error) {
    rejected = error
  }
  check('an empty file is refused', rejected instanceof ImageRejected)
}

console.log('\nthe round trip through Postgres')

const slot = 'home-hero'
await db.delete(siteImages).where(eq(siteImages.slot, slot))

await db.insert(siteImages).values({
  slot,
  alt: 'A test photograph.',
  contentType: processed.contentType,
  bytes: processed.bytes,
  byteSize: processed.byteSize,
  width: processed.width,
  height: processed.height,
  focalY: 25,
  version: processed.version,
})

{
  const stored = await siteImageBytes(slot)
  check('the bytes come back', stored !== null)
  check(
    'byte for byte',
    stored !== null && Buffer.from(stored.bytes).equals(processed.bytes),
    stored ? `${stored.bytes.length} vs ${processed.bytes.length}` : '',
  )
  check('with the recorded length', stored?.byteSize === processed.byteSize)
}

{
  const map = await siteImageMap()
  const meta = map.get(slot)
  check('the metadata query finds it', meta !== undefined)
  check('and carries the framing', meta?.focalY === 25)
  check(
    'and does NOT carry the bytes',
    meta !== undefined && !Object.prototype.hasOwnProperty.call(meta, 'bytes'),
    'every page render would otherwise pull a megabyte per photograph',
  )
}

{
  // Replacing must be an upsert, not a second row: the slot is the identity.
  const second = await processUpload(original, 'portrait')
  const values = {
    slot,
    alt: 'Replaced.',
    contentType: second.contentType,
    bytes: second.bytes,
    byteSize: second.byteSize,
    width: second.width,
    height: second.height,
    version: second.version,
  }
  await db.insert(siteImages).values(values).onConflictDoUpdate({ target: siteImages.slot, set: values })

  const rows = await db.select({ id: siteImages.id, version: siteImages.version }).from(siteImages).where(eq(siteImages.slot, slot))
  check('replacing leaves one row, not two', rows.length === 1, `${rows.length} rows`)
  check('and mints a new version, so caches cannot serve the old one', rows[0]?.version === second.version && second.version !== processed.version)
}

await db.delete(siteImages).where(eq(siteImages.slot, slot))

check('a removed photograph is simply absent', (await siteImageBytes(slot)) === null)

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
