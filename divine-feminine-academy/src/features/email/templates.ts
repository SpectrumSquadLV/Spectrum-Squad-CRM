/**
 * Email templates.
 *
 * Plain typed functions returning subject, html and text — not a rendering
 * library. Three reasons: they are trivially testable, they produce a text
 * part (which some women's clients still show, and which keeps us out of spam
 * folders), and there is no build step between writing one and sending it.
 *
 * Every template takes `siteUrl` rather than reading the environment, so the
 * same template can be rendered in a test without one.
 */

import { personalise, type SequenceEmail as SequenceEmailContent } from '@/features/quiz/sequences'

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** One house style, so every email looks like it came from the same place. */
function layout({
  preview,
  heading,
  paragraphs,
  cta,
  footer,
  siteUrl,
  unsubscribeUrl,
}: {
  preview: string
  heading: string
  paragraphs: string[]
  cta?: { label: string; url: string }
  footer?: string
  siteUrl: string
  unsubscribeUrl?: string
}): string {
  const body = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 20px;font-size:16px;line-height:1.65;color:#443c37">${escapeHtml(p)}</p>`,
    )
    .join('')

  const button = cta
    ? `<p style="margin:32px 0"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#4a2f44;color:#faf7f2;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px">${escapeHtml(cta.label)}</a></p>`
    : ''

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;background:#faf7f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preview)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f2">
<tr><td align="center" style="padding:40px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdfa;border:1px solid #e4dcd0;border-radius:14px">
<tr><td style="padding:40px 32px">
<p style="margin:0 0 28px;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#8b6558">Divine Feminine</p>
<h1 style="margin:0 0 24px;font-size:26px;line-height:1.25;font-weight:400;color:#1a1614">${escapeHtml(heading)}</h1>
${body}${button}
</td></tr></table>
<p style="margin:24px 0 0;font-size:12px;color:#6f645d">${escapeHtml(footer ?? 'Education, not therapy.')}</p>
<p style="margin:8px 0 0;font-size:12px;color:#a0948c">${
  unsubscribeUrl
    ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#a0948c">Unsubscribe</a>`
    : `<a href="${escapeHtml(siteUrl)}/my-academy/account" style="color:#a0948c">Change what we send you</a>`
}</p>
</td></tr></table></body></html>`
}

function plain({
  heading,
  paragraphs,
  cta,
  footer,
  siteUrl,
  unsubscribeUrl,
}: {
  heading: string
  paragraphs: string[]
  cta?: { label: string; url: string }
  footer?: string
  siteUrl: string
  unsubscribeUrl?: string
}): string {
  const parts = [heading, '', ...paragraphs]
  if (cta) parts.push('', `${cta.label}: ${cta.url}`)
  parts.push('', footer ?? 'Education, not therapy.')
  parts.push(
    unsubscribeUrl
      ? `Unsubscribe: ${unsubscribeUrl}`
      : `Change what we send you: ${siteUrl}/my-academy/account`,
  )
  return parts.join('\n')
}

const firstNameOr = (name: string | null | undefined, fallback = 'there') =>
  name?.trim() || fallback

/** A new day has opened. The one email the challenge depends on. */
export function dayReminder(input: {
  firstName: string | null
  dayNumber: number
  dayTitle: string
  totalDays: number
  programSlug: string
  siteUrl: string
}): RenderedEmail {
  const cta = {
    label: `Open Day ${input.dayNumber}`,
    url: `${input.siteUrl}/my-academy/${input.programSlug}/day/${input.dayNumber}`,
  }

  const content = {
    preview: `Day ${input.dayNumber}: ${input.dayTitle}`,
    heading: `Day ${input.dayNumber} is open.`,
    paragraphs: [
      `${firstNameOr(input.firstName)}, today is ${input.dayTitle}.`,
      'About twenty minutes, and somewhere to be honest.',
    ],
    cta,
    siteUrl: input.siteUrl,
  }

  return {
    subject: `Day ${input.dayNumber} of ${input.totalDays}: ${input.dayTitle}`,
    html: layout(content),
    text: plain(content),
  }
}

/** She has not come back. Said once, without guilt. */
export function nudge(input: {
  firstName: string | null
  dayNumber: number
  programSlug: string
  daysSince: number
  siteUrl: string
}): RenderedEmail {
  const cta = {
    label: `Pick up at Day ${input.dayNumber}`,
    url: `${input.siteUrl}/my-academy/${input.programSlug}/day/${input.dayNumber}`,
  }

  const content = {
    preview: 'It is still here whenever you are.',
    heading: 'Still here.',
    paragraphs: [
      `${firstNameOr(input.firstName)}, Day ${input.dayNumber} has been waiting a few days.`,
      'There is no streak to lose and nothing to catch up on. You pick up exactly where you left off.',
      'And if now is not the time, that is a real answer too.',
    ],
    cta,
    siteUrl: input.siteUrl,
  }

  return {
    subject: 'Still here, whenever you are',
    html: layout(content),
    text: plain(content),
  }
}

/** She finished. */
/**
 * The day after Day 7.
 *
 * Sent in her timezone, once, and skipped entirely if she has already
 * enrolled in the Academy — nobody should be sold something they just bought.
 *
 * The opening line is conditional on who she chose, and everything after it
 * is identical. That is not a personalisation trick: Day 7 lets her
 * consciously choose ME and tells her that is allowed, so an email that
 * opened "Yesterday, you chose HER" for a woman who chose ME would contradict
 * the product to her face, on the one subject where being contradicted would
 * cost her the most.
 */
export function academyInvitation(input: {
  firstName: string | null
  /** From Day 7's choice_capture. Decides only the opening line. */
  choseHer: boolean
  siteUrl: string
}): RenderedEmail {
  const cta = {
    label: 'ENTER THE DIVINE FEMININE ACADEMY',
    url: `${input.siteUrl}/academy`,
  }

  const opening = input.choseHer
    ? 'Yesterday, you chose HER.'
    : 'Yesterday, you finished ME VS. HER.'

  const content = {
    preview: 'ME is going to show up again. Now you know what to do.',
    heading: 'You found HER. Now what?',
    paragraphs: [
      opening,
      'But today is where this actually matters.',
      'Because life is going to keep happening.',
      'Someone is going to trigger you.',
      "Something isn't going to go according to plan.",
      'You’re going to want something that scares you.',
      'ME is going to show up again.',
      'And now you know what to do.',
      'Why am I doing this?',
      'What does ME want to do?',
      'What would HER do?',
      'Who am I choosing?',
      "But here's the part we intentionally didn't go deeply into during ME VS. HER:",
      'Why does ME keep showing up in the first place?',
      'Why do the same patterns appear in your relationships, your money, your success, and the way you see yourself?',
      'What have you accepted as true about yourself without ever stopping to question whether it was actually true?',
      'And how much of your life has been created from those beliefs?',
      "That's where the Divine Feminine Academy begins.",
      "We're going deeper than recognizing the pattern.",
      "We're going underneath it.",
      "We're uncovering the stories and beliefs you've carried, looking at how they've shaped what you've accepted, chosen, pursued, avoided, and created — and beginning the work of changing them.",
      'Not so you can become HER.',
      "Because if ME VS. HER taught you anything, I hope it's this:",
      'She was already there.',
      'The work now is learning how to let HER lead in every area of your life.',
      'You are worthy of everything you desire.',
      "Let's build from there.",
    ],
    cta,
    siteUrl: input.siteUrl,
  }

  return {
    subject: 'You found HER. Now what?',
    html: layout(content),
    text: plain(content),
  }
}

/** She started paying and stopped. Once, and only once. */
export function abandonedCheckout(input: {
  firstName: string | null
  programTitle: string
  siteUrl: string
}): RenderedEmail {
  const cta = { label: 'Pick up where you left off', url: `${input.siteUrl}/the-divine-feminine` }

  const content = {
    preview: 'Nothing was charged.',
    heading: 'Nothing was charged.',
    paragraphs: [
      `${firstNameOr(input.firstName)}, you started signing up for ${input.programTitle} and stopped. Nothing left your account.`,
      'If something got in the way, or you just changed your mind, both are fine. This is the only email you will get about it.',
    ],
    cta,
    siteUrl: input.siteUrl,
  }

  return {
    subject: 'You left something unfinished',
    html: layout(content),
    text: plain(content),
  }
}

/** A receipt. Always sent, never optional. */
export function orderReceipt(input: {
  firstName: string | null
  programTitle: string
  amountLabel: string
  orderReference: string
  refundWindowDays: number
  siteUrl: string
}): RenderedEmail {
  const cta = { label: 'Go to your practice', url: `${input.siteUrl}/my-academy` }

  const content = {
    preview: `Your receipt for ${input.programTitle}`,
    heading: 'You are in.',
    paragraphs: [
      `${firstNameOr(input.firstName)}, this is your receipt for ${input.programTitle}.`,
      `Paid: ${input.amountLabel}. Reference: ${input.orderReference}.`,
      input.refundWindowDays > 0
        ? `If it is not right for you, you have ${input.refundWindowDays} days to say so and get your money back.`
        : 'Reply to this email if anything is not right.',
    ],
    cta,
    footer: 'Education, not therapy. Keep this email for your records.',
    siteUrl: input.siteUrl,
  }

  return {
    subject: `Your receipt — ${input.programTitle}`,
    html: layout(content),
    text: plain(content),
  }
}

/** Her certificate is ready. */
export function certificateIssued(input: {
  firstName: string | null
  programTitle: string
  certificateNumber: string
  verificationToken: string
  siteUrl: string
}): RenderedEmail {
  const cta = {
    label: 'See your certificate',
    url: `${input.siteUrl}/verify/${input.verificationToken}`,
  }

  const content = {
    preview: `Your certificate for ${input.programTitle}`,
    heading: 'Your certificate is ready.',
    paragraphs: [
      `${firstNameOr(input.firstName)}, you finished ${input.programTitle}.`,
      `Certificate ${input.certificateNumber}. Anyone you send that link to can confirm it is genuine — it shows your name, the programme and the date, and nothing else about you.`,
    ],
    cta,
    siteUrl: input.siteUrl,
  }

  return {
    subject: `Your certificate — ${input.programTitle}`,
    html: layout(content),
    text: plain(content),
  }
}

/**
 * One email from an archetype sequence.
 *
 * The words come from `src/features/quiz/sequences.ts` — this only dresses
 * them. Keeping the copy out of here means it can be rewritten by somebody who
 * has never seen an HTML table in their life.
 *
 * `unsubscribeUrl` is REQUIRED, not optional, because this is the one kind of
 * mail that regularly reaches a woman who has no account: she recognised
 * herself on a page a friend sent and put her email in. An account-settings
 * link would be a dead end for her.
 */
export function archetypeSequence(input: {
  firstName: string | null
  email: SequenceEmailContent
  siteUrl: string
  unsubscribeUrl: string
}): RenderedEmail {
  const fill = (text: string) => personalise(text, input.firstName)

  const content = {
    preview: fill(input.email.preview),
    heading: fill(input.email.heading),
    paragraphs: input.email.paragraphs.map(fill),
    cta: input.email.cta
      ? {
          label: input.email.cta.label,
          url: `${input.siteUrl.replace(/\/$/, '')}${input.email.cta.path}`,
        }
      : undefined,
    siteUrl: input.siteUrl,
    unsubscribeUrl: input.unsubscribeUrl,
  }

  return {
    subject: fill(input.email.subject),
    html: layout(content),
    text: plain(content),
  }
}

/**
 * There is something new to read.
 *
 * Short on purpose. The job of this email is to get her to the piece, not to
 * be the piece — a long summary means she has already had the idea and has no
 * reason to click.
 */
export function newWriting(input: {
  firstName: string | null
  title: string
  dek: string | null
  url: string
  kind: 'article' | 'episode'
  unsubscribeUrl: string
}): RenderedEmail {
  const listening = input.kind === 'episode'

  const content = {
    preview: input.dek?.trim() || input.title,
    heading: input.title,
    paragraphs: [
      `${firstNameOr(input.firstName)}, there is something new.`,
      input.dek?.trim() ||
        (listening
          ? 'A new episode is up.'
          : 'A new piece is up.'),
    ],
    cta: {
      label: listening ? 'Listen to it' : 'Read it',
      url: input.url,
    },
    siteUrl: input.url,
    unsubscribeUrl: input.unsubscribeUrl,
  }

  return {
    subject: input.title,
    html: layout(content),
    text: plain(content),
  }
}

export const templates = {
  dayReminder,
  nudge,
  academyInvitation,
  abandonedCheckout,
  orderReceipt,
  certificateIssued,
  archetypeSequence,
  newWriting,
} as const

export type TemplateName = keyof typeof templates
