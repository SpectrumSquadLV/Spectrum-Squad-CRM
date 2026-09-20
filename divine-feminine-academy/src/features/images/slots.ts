/**
 * Every photograph the site has a place for.
 *
 * Pure data, no imports, safe on either side of the server boundary.
 *
 * This list is the contract in both directions. A page asks for a slot by key
 * and gets whatever is in it, so swapping a photograph never touches a page;
 * and the admin renders this list, so a slot nobody has filled shows up there
 * as an empty frame with instructions rather than as nothing at all.
 *
 * It is deliberately short. Seven photographs is a morning with a decent
 * camera and somebody to press the button. Twenty would be a project that
 * never gets started, and the site would stay plain.
 */

export type SlotShape = 'portrait' | 'landscape' | 'square'

export interface ImageSlot {
  key: string
  /** What to call it in the admin. */
  label: string
  /** Where on the site it appears, in words she can check against. */
  where: string
  shape: SlotShape
  /** What to actually photograph. Written to be read on a phone, on set. */
  brief: string
  /** Roughly how wide it renders, so the upload can be sized sensibly. */
  rendersAtPx: number
}

export const aspectRatio: Record<SlotShape, string> = {
  portrait: '4 / 5',
  landscape: '3 / 2',
  square: '1 / 1',
}

export const imageSlots: readonly ImageSlot[] = [
  {
    key: 'home-hero',
    label: 'The first photograph anyone sees',
    where: 'Home page, beside "She is not someone you become."',
    shape: 'portrait',
    brief:
      'You, looking straight down the lens. Head and shoulders, or waist up. Plain wall or soft daylight from a window — nothing busy behind you. This is the one doing the most work on the whole site, so it should look like you on a good day rather than like a photograph of a businesswoman.',
    rendersAtPx: 420,
  },
  {
    key: 'statement-portrait',
    label: 'The statement band',
    where: 'Home page, the full-width "The problem is you." band under the hero',
    shape: 'portrait',
    brief:
      'You seated, relaxed, owning the frame — and a lot of empty wall. The words sit in that empty space, so the photograph needs somewhere for them to go: keep yourself to one side and leave the other side plain. A warm, flat backdrop works far better here than anything with a pattern in it.',
    rendersAtPx: 560,
  },
  {
    key: 'home-close',
    label: 'The invitation at the bottom of the home page',
    where: 'Home page, in the "Seven days." card above the Begin button',
    shape: 'landscape',
    brief:
      'Wider and warmer. Seated, hands visible, caught mid-thought rather than posed. It sits directly above the button that starts everything, so it wants to feel like someone inviting you in, not selling to you.',
    rendersAtPx: 720,
  },
  {
    key: 'about-portrait',
    label: 'The big one, on About',
    where: 'About page, above your bio',
    shape: 'portrait',
    brief:
      'The largest photograph on the site, and the one people look at while they decide whether to trust you. Full length or seated, somewhere that actually means something to you rather than a studio. Give it room — this is the one worth paying someone for.',
    rendersAtPx: 560,
  },
  {
    key: 'me-vs-her-hero',
    label: 'ME VS HER',
    where: 'The $11 challenge page, under the headline',
    shape: 'landscape',
    brief:
      'This page is about the gap between who you are being and who you are. A little tension suits it. Not smiling is completely fine here — in fact it is better than a grin, which would undercut what the page is asking of her.',
    rendersAtPx: 720,
  },
  {
    key: 'divine-feminine-hero',
    label: 'The Divine Feminine',
    where: 'The full course page, under the headline',
    shape: 'landscape',
    brief:
      'The most polished photograph you have. This is the expensive thing, and the picture should look like the thing costs money. Colour and styling closer to the site than to your feed.',
    rendersAtPx: 720,
  },
  {
    key: 'quiz-intro',
    label: 'Beside the quiz',
    where: 'The quiz page, next to the opening question',
    shape: 'square',
    brief:
      'Small, close, friendly. Head and shoulders is plenty. Its whole job is to make the quiz feel like a person asking rather than a form, so warmth beats polish here.',
    rendersAtPx: 220,
  },
  {
    key: 'quiz-result',
    label: 'On the quiz result',
    where: 'Every quiz result page, beside the invitation to go further',
    shape: 'square',
    brief:
      'She has just been told something true about herself and is deciding whether to keep going. Your face next to that ask is the entire point. Same energy as the quiz photograph, different frame — or the same one again, which is also fine.',
    rendersAtPx: 220,
  },
] as const

const bySlot = new Map(imageSlots.map((s) => [s.key, s]))

/** The slot, or null - never a guess. Uploads are checked against this. */
export function imageSlot(key: string): ImageSlot | null {
  return bySlot.get(key) ?? null
}

/**
 * Where to keep in frame when a slot crops.
 *
 * Three choices on each axis rather than a number, because the question a
 * person is actually answering is "which bit of this must not get cut off",
 * and nobody knows the answer in percent.
 *
 * Both axes matter and for different reasons. Vertically, faces sit above the
 * middle far more often than not, and a centred crop is what beheads them.
 * Horizontally, a portrait shot with the subject to one side - so there is
 * room for words beside her - is exactly the photograph a centred crop ruins.
 */
export const focusChoicesY = [
  { value: 25, label: 'Top' },
  { value: 50, label: 'Middle' },
  { value: 75, label: 'Bottom' },
] as const

export const focusChoicesX = [
  { value: 25, label: 'Left' },
  { value: 50, label: 'Centre' },
  { value: 75, label: 'Right' },
] as const
