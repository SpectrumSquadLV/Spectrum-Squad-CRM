import { permanentRedirect } from 'next/navigation'

/**
 * /academy is the name the curriculum uses for the destination.
 *
 * The Academy's actual page is /the-divine-feminine and has been since it was
 * built. Rather than run two pages that drift apart, this is the name the
 * challenge links to and the other is where it lands — so the copy can say
 * ENTER THE DIVINE FEMININE ACADEMY without a second page to keep in sync.
 */
export default function AcademyPage(): never {
  permanentRedirect('/the-divine-feminine')
}
