import { permanentRedirect } from 'next/navigation'

/**
 * /assessment now goes to the quiz.
 *
 * WHAT WAS HERE, and why it is gone.
 *
 * A second instrument - slug `where-are-you`, "Where are you, honestly?" -
 * scoring Self, Love, Life and Wealth. It was real and it worked, but its
 * questions were stand-ins, and it said so IN PUBLIC: a staff note sat on the
 * live page telling any stranger who found it that these questions "are not a
 * validated instrument and should be replaced before launch". That note is
 * the development artifact that has been showing on the site.
 *
 * It is also redundant. The archetype quiz already produces BOTH the four
 * area scores and the archetype from one set of answers - that was the point
 * of consolidating onto one instrument - so this page asked a woman to answer
 * a second, weaker set of questions for information the first set already
 * gives. Two instruments also means two results in her inbox and no way to
 * tell which one is "hers".
 *
 * So the four archetypes were never lost. They were never on this page. They
 * live in src/features/quiz/archetypes.ts, intact, and the experience that
 * reveals them is /quiz. This route existing separately is what made it look
 * as though they had gone missing.
 *
 * permanent, not temporary: the split is a decision, not an outage, and the
 * 308 lets search engines move the ranking rather than sit on a dead URL.
 *
 * /assessment/results/[token] is deliberately NOT redirected. Those links are
 * in women's inboxes and they still resolve to real, completed results. A
 * result a woman was emailed must not stop opening because the page that
 * produced it was retired.
 */
export default function AssessmentPage(): never {
  permanentRedirect('/quiz')
}
