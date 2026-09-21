/**
 * Quiana's own words, and nothing else.
 *
 * Both arrays are empty, and that is the correct state until she writes them.
 * An invented origin story or a plausible-sounding bio is the single most
 * damaging thing that could ship on this site: it is the one part a reader
 * would be entirely right to distrust everything else for, and it cannot be
 * un-published from the minds of the people who read it first.
 *
 * One string per paragraph. Filling either one replaces the structural copy on
 * /about and removes the admin note pointing at it. No component changes, no
 * layout work - the page is already built around the shape of both.
 */
export const about = {
  /**
   * The origin. What happened, what she made it mean at the time, and when
   * she noticed she had been running that meaning ever since.
   *
   * It sits beside the childhood photograph, which is doing half the work
   * already - so this can be short, and short is usually better here.
   */
  origin: [] as readonly string[],

  /**
   * Who she is now, and why she built this rather than another course. This
   * is the part people actually read before deciding whether to trust her.
   */
  bio: [] as readonly string[],
} as const
