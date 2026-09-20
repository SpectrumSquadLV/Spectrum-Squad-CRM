import {
  customType,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryId, timestamps } from './_shared'

/**
 * Raw bytes.
 *
 * postgres-js hands bytea back as a Uint8Array, which is what the serving
 * route wants anyway - it goes straight into a Response body without a copy.
 */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'bytea'
  },
})

/**
 * The photographs on the public site, stored in the database.
 *
 * In the database rather than in `public/` because the container filesystem is
 * rebuilt on every deploy: a photograph uploaded through the admin would
 * survive until the next push and then silently vanish. And in the database
 * rather than in object storage because that would mean a second provider, a
 * second set of credentials and a second thing to go wrong, for what is at
 * most a couple of dozen portraits. If this ever grows past that, the serving
 * route is the only thing that has to change.
 *
 * One row per slot and variant - see src/features/images/slots.ts. The slot is
 * the whole addressing scheme: pages ask for `home-hero`, not for an id, so
 * replacing a photograph is an upload and never an edit to any page.
 *
 * `bytes` is deliberately never selected by the page queries. It is a megabyte
 * or so per row and the pages only ever need the dimensions and the alt text.
 */
export const siteImages = pgTable(
  'site_images',
  {
    id: primaryId(),
    slot: text('slot').notNull(),
    /**
     * Which composition this is: 'desktop' or 'mobile'.
     *
     * Art direction rather than resizing. A photograph framed for a wide band,
     * with the subject to one side and the type in the air beside her, has
     * nothing left once it is squeezed onto a phone - so a phone is given its
     * own crop, chosen deliberately, and picks it up through <picture>.
     */
    variant: text('variant').notNull().default('desktop'),
    /** Required, always. A decorative photograph of a person is not decorative. */
    alt: text('alt').notNull(),
    contentType: text('content_type').notNull(),
    bytes: bytea('bytes').notNull(),
    byteSize: integer('byte_size').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /**
     * Where to keep in frame when the slot crops. Percentages, so they go
     * straight into object-position. Faces sit above centre far more often
     * than not, which is exactly what a centred crop beheads.
     */
    focalX: integer('focal_x').notNull().default(50),
    focalY: integer('focal_y').notNull().default(50),
    /**
     * Changes on every upload, and rides in the URL as ?v=.
     *
     * That is what makes it safe to serve these as immutable for a year: a
     * replaced photograph is a different URL, so no browser and no proxy can
     * be holding the old one.
     */
    version: text('version').notNull(),
    uploadedBy: uuid('uploaded_by'),
    ...timestamps,
  },
  (t) => [uniqueIndex('site_images_slot_key').on(t.slot, t.variant)],
)
