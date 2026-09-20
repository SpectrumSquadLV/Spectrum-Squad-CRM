/**
 * Every photograph the site has a place for, and how each one is framed.
 *
 * Pure data, no imports, safe on either side of the server boundary.
 *
 * Two crops per slot, not one. A photograph composed for a wide band — subject
 * to one side, type in the air beside her — has nothing left when it is
 * squeezed to a phone: the type lands on her face or the crop throws her out
 * of frame. So a phone gets its own composition, chosen here, rather than the
 * desktop one scaled down.
 *
 * `protectsSubject` marks the slots that carry typography over the image. For
 * those, the crop exists to preserve a field of empty ground for the words,
 * and the face and body are never to be covered.
 */

export type Variant = 'desktop' | 'mobile'

export interface ImageCrop {
  /** CSS aspect-ratio, exactly as it is written into the style attribute. */
  ratio: string
  /** Longest edge stored, in pixels. Twice the rendered size, for sharp screens. */
  maxPx: number
  /** What to keep in frame, in the photographer's words. */
  framing: string
}

export interface ImageSlot {
  key: string
  label: string
  where: string
  brief: string
  desktop: ImageCrop
  mobile: ImageCrop
  /** Typography sits over this photograph. Her face and body are protected. */
  protectsSubject?: boolean
}

export const imageSlots: readonly ImageSlot[] = [
  {
    key: 'home-hero',
    label: 'The hero',
    where: 'The first thing on the home page, edge to edge, with the headline over it',
    protectsSubject: true,
    brief:
      'Open, expansive, looking up or out rather than at the lens. This one has to feel like arriving somewhere, so it wants air around you — the headline lives in that air. Keep yourself to one side or low in the frame and leave the rest plain.',
    /*
     * 3:2 rather than the 16:9 a hero usually wants.
     *
     * A wide window cut from a tall photograph has to span the full width, so
     * it can only ever crop height — which means a 16:9 hero from a portrait
     * source throws away well over half the frame and still cannot move the
     * subject off centre. 3:2 keeps enough of the photograph for the empty
     * ground above her head to survive, and that band is where the headline
     * goes. A source shot wide in the first place could go wider here.
     */
    desktop: {
      ratio: '3 / 2',
      maxPx: 2400,
      framing: 'You centred and low. Empty ground across the top for the headline.',
    },
    mobile: {
      ratio: '4 / 5',
      maxPx: 1200,
      framing: 'You in the lower third, upright. Empty ground above for the type.',
    },
  },
  {
    key: 'statement-portrait',
    label: 'The manifesto',
    where: 'The full-width band — "The problem is you." — with the type beside you',
    protectsSubject: true,
    brief:
      'The opposite energy to the hero: straight down the lens, settled, unbothered. Sit or stand to one side of a plain wall and leave the other side completely empty. That empty half is where the largest type on the site goes, so the more of it there is, the better this works.',
    desktop: {
      ratio: '3 / 2',
      maxPx: 2400,
      framing: 'You on the right. The left half empty.',
    },
    mobile: {
      ratio: '4 / 5',
      maxPx: 1200,
      framing: 'You lower right, upright. Empty ground above.',
    },
  },
  {
    key: 'about-portrait',
    label: 'The portrait on About',
    where: 'About, beside your story',
    brief:
      'The photograph people look at while deciding whether to trust you. Full length or seated, somewhere that means something to you rather than a studio backdrop. This is the one worth paying someone for.',
    desktop: {
      ratio: '4 / 5',
      maxPx: 1400,
      framing: 'You, full length or seated, centred.',
    },
    mobile: {
      ratio: '4 / 5',
      maxPx: 1000,
      framing: 'The same, a little tighter.',
    },
  },
  {
    key: 'me-vs-her-hero',
    label: 'ME VS HER',
    where: 'The $11 challenge page, edge to edge under the headline',
    brief:
      'Some tension in it. Not smiling is better than smiling here — this page asks something of her, and a grin undercuts the ask.',
    desktop: {
      ratio: '3 / 2',
      maxPx: 2000,
      framing: 'Waist up or seated, you off-centre.',
    },
    mobile: {
      ratio: '3 / 4',
      maxPx: 1000,
      framing: 'Closer. You fill more of the frame.',
    },
  },
  {
    key: 'divine-feminine-hero',
    label: 'The Divine Feminine',
    where: 'The full course page, under the headline',
    brief:
      'The most polished frame you have. This is the expensive thing and the photograph should look like it costs money.',
    desktop: {
      ratio: '3 / 2',
      maxPx: 2000,
      framing: 'Waist up, composed.',
    },
    mobile: {
      ratio: '3 / 4',
      maxPx: 1000,
      framing: 'Closer.',
    },
  },
  {
    key: 'quiz-intro',
    label: 'Beside the quiz',
    where: 'The quiz page, next to the opening question',
    brief:
      'Small, close, looking at the lens. Its whole job is to make the quiz feel like a person asking rather than a form, so warmth beats polish.',
    desktop: { ratio: '1 / 1', maxPx: 600, framing: 'Head and shoulders.' },
    mobile: { ratio: '1 / 1', maxPx: 400, framing: 'Head and shoulders.' },
  },
  {
    key: 'quiz-result',
    label: 'On the quiz result',
    where: 'Every result page, beside the invitation to go further',
    brief:
      'She has just been told something true about herself and is deciding whether to keep going. Your face next to that ask is the point.',
    desktop: { ratio: '1 / 1', maxPx: 600, framing: 'Head and shoulders.' },
    mobile: { ratio: '1 / 1', maxPx: 400, framing: 'Head and shoulders.' },
  },
] as const

const bySlot = new Map(imageSlots.map((s) => [s.key, s]))

/** The slot, or null - never a guess. Uploads are checked against this. */
export function imageSlot(key: string): ImageSlot | null {
  return bySlot.get(key) ?? null
}

export function cropFor(slot: ImageSlot, variant: Variant): ImageCrop {
  return variant === 'mobile' ? slot.mobile : slot.desktop
}

export const variants: readonly Variant[] = ['desktop', 'mobile'] as const

export function isVariant(value: string): value is Variant {
  return value === 'desktop' || value === 'mobile'
}

/**
 * Where to keep in frame when a slot crops.
 *
 * Three choices on each axis rather than a number, because the question being
 * answered is "which part of this must not be cut off", and nobody knows that
 * in percent. Vertically, faces sit above the middle far more often than not,
 * and a centred crop is what beheads them. Horizontally, a portrait composed
 * with the subject to one side - so there is room for words - is exactly the
 * one a centred crop ruins.
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
