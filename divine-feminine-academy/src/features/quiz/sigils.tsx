/**
 * A MARK FOR EACH OF THE FOUR.
 *
 * Four abstract sigils, one per protective mode. They are deliberately not
 * pictures of anything: no crowns, no doors, no eyes, no storms. A literal
 * icon would name the archetype before she has answered a single question,
 * which is the one thing this page must not do.
 *
 * They exist so the four can be SHOWN before they are named. Four identical
 * cards say "pick a box". Four distinct marks say "four of these are real and
 * one of them is yours", which is the feeling the whole instrument runs on.
 *
 * THE MAPPING IS LOAD-BEARING, and it is the reason these live in their own
 * file rather than inline on the page. The card she sees face-down on the
 * quiz is the card that turns over at her reveal. If the intro and the reveal
 * drew their own marks, they would drift apart the first time either was
 * edited, and the payoff - "that was mine the whole time" - would quietly
 * stop being true without anything failing.
 *
 * Drawn on a 48x48 box, stroked in currentColor, so one mark works at 28px on
 * a card back and at 120px on the reveal without a second asset.
 */

import type { ProtectiveMode } from './archetypes'

type SigilProps = {
  mode: ProtectiveMode
  className?: string
  /** Decorative by default; the reveal passes her archetype's name. */
  title?: string
}

/*
 * Each mark is one idea, held to two or three strokes.
 *
 *   fight    an upright barred by a crossing line - a thing held, and held in
 *            front of something
 *   flight   an arc that does not close - the way out, drawn as an absence
 *   freeze   rings around a centre - held at a distance, watching it
 *   sulk     a coil - nothing escapes, nothing is released, it is all still
 *            in there
 *
 * No mark is "worse" than another, in weight or in complexity. She will
 * compare them, and a spindly one next to a bold one reads as a verdict.
 */
const paths: Record<ProtectiveMode, React.ReactNode> = {
  fight: (
    <>
      <path d="M24 6v36" />
      <path d="M11 19h26" />
    </>
  ),
  flight: (
    <>
      <path d="M38 13a18 18 0 1 0 5 13" />
      <path d="M31 26h12" />
    </>
  ),
  freeze: (
    <>
      <circle cx="24" cy="24" r="17" />
      <circle cx="24" cy="24" r="7" />
    </>
  ),
  sulk: (
    <path d="M24 38a14 14 0 1 0-14-14 10 10 0 0 0 20 0 6 6 0 0 0-12 0" />
  ),
}

export function Sigil({ mode, className, title }: SigilProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      /*
       * Decorative unless it is named. On the quiz these four carry no
       * meaning a screen reader could convey - "four abstract marks" helps
       * nobody - and the page says in words what they are. On the reveal it
       * is her archetype's mark, so it gets the name.
       */
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {paths[mode]}
    </svg>
  )
}
