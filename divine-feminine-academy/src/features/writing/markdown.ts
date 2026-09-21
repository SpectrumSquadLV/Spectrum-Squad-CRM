/**
 * A deliberately small Markdown.
 *
 * Two choices worth defending.
 *
 * FIRST: she writes Markdown, not blocks. The rest of this platform stores
 * content as typed blocks, and that is right for a lesson, where each block
 * does something. An essay is not that. Asking somebody to fill in thirty
 * little forms to write a thousand words is how a blog stops being updated in
 * week three — and the whole value of publishing is that it keeps happening.
 *
 * SECOND: this parses to a TREE, and the renderer turns that tree into React
 * elements. It never produces an HTML string, so there is no
 * `dangerouslySetInnerHTML` anywhere and no sanitiser to get wrong. Text is
 * escaped because React escapes text. The only hole that could exist is a URL,
 * and URLs are checked against a scheme allowlist below.
 *
 * The subset is: `##`/`###` headings, paragraphs, `>` quotes, `-` and `1.`
 * lists, `---` rules, images, and inline bold, italic, code and links. No raw
 * HTML, on purpose — it is the one feature that would reintroduce every
 * problem this design avoids.
 */

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: InlineNode[] }

export type BlockNode =
  | { type: 'heading'; level: 2 | 3; children: InlineNode[] }
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'quote'; children: BlockNode[] }
  | { type: 'list'; ordered: boolean; items: InlineNode[][] }
  | { type: 'rule' }
  | { type: 'image'; src: string; alt: string }

/**
 * Which links are allowed to survive.
 *
 * `javascript:` is the obvious one. `data:` is the one people forget — a
 * `data:text/html` link is a stored cross-site scripting hole wearing a
 * different hat. Anything not on this list is rendered as plain text, so the
 * words are kept and the link is not.
 */
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:']

export function safeUrl(raw: string): string | null {
  const url = raw.trim()
  if (!url) return null

  // Site-relative links are fine and are the common case internally.
  if (url.startsWith('/') && !url.startsWith('//')) return url
  if (url.startsWith('#')) return url

  try {
    const parsed = new URL(url)
    return SAFE_SCHEMES.includes(parsed.protocol) ? url : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

const INLINE_PATTERN =
  /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)|(`[^`]+`)|(\[[^\]]*\]\([^)\s]*\))/

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let rest = source

  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest)
    if (!match || match.index === undefined) break

    if (match.index > 0) {
      nodes.push({ type: 'text', value: rest.slice(0, match.index) })
    }

    const token = match[0]

    if (token.startsWith('**')) {
      nodes.push({ type: 'strong', children: parseInline(token.slice(2, -2)) })
    } else if (token.startsWith('`')) {
      nodes.push({ type: 'code', value: token.slice(1, -1) })
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](')
      const label = token.slice(1, split)
      const href = safeUrl(token.slice(split + 2, -1))
      if (href) {
        nodes.push({ type: 'link', href, children: parseInline(label) })
      } else {
        // The link is dropped, the words are kept. A reader losing a sentence
        // because somebody pasted a bad URL would be a worse outcome.
        nodes.push(...parseInline(label))
      }
    } else {
      nodes.push({ type: 'em', children: parseInline(token.slice(1, -1)) })
    }

    rest = rest.slice(match.index + token.length)
  }

  if (rest.length > 0) nodes.push({ type: 'text', value: rest })
  return nodes
}

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/

export function parseMarkdown(source: string): BlockNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: BlockNode[] = []

  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ').trim()) })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trimEnd()
    const trimmed = line.trim()

    if (trimmed === '') {
      flushParagraph()
      continue
    }

    if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) {
      flushParagraph()
      blocks.push({ type: 'rule' })
      continue
    }

    const image = IMAGE_LINE.exec(trimmed)
    if (image) {
      const src = safeUrl(image[2] ?? '')
      flushParagraph()
      // An image with no usable source is dropped entirely rather than
      // rendered broken.
      if (src) blocks.push({ type: 'image', src, alt: image[1] ?? '' })
      continue
    }

    const heading = /^(#{2,3})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flushParagraph()
      blocks.push({
        type: 'heading',
        level: heading[1]!.length === 2 ? 2 : 3,
        children: parseInline(heading[2]!.trim()),
      })
      continue
    }

    // A single `#` is treated as `##`. The page already has an h1 — the title
    // — and a second one is a real accessibility fault, so this quietly does
    // the right thing rather than letting her create one by habit.
    const bigHeading = /^#\s+(.*)$/.exec(trimmed)
    if (bigHeading) {
      flushParagraph()
      blocks.push({ type: 'heading', level: 2, children: parseInline(bigHeading[1]!.trim()) })
      continue
    }

    if (trimmed.startsWith('>')) {
      flushParagraph()
      const quoted: string[] = []
      let j = i
      while (j < lines.length && (lines[j] ?? '').trim().startsWith('>')) {
        quoted.push((lines[j] ?? '').trim().replace(/^>\s?/, ''))
        j++
      }
      blocks.push({ type: 'quote', children: parseMarkdown(quoted.join('\n')) })
      i = j - 1
      continue
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed)
    if (bullet || numbered) {
      flushParagraph()
      const ordered = Boolean(numbered)
      const items: InlineNode[][] = []
      let j = i
      while (j < lines.length) {
        const candidate = (lines[j] ?? '').trim()
        const b = /^[-*+]\s+(.*)$/.exec(candidate)
        const n = /^\d+[.)]\s+(.*)$/.exec(candidate)
        const matched = ordered ? n : b
        if (!matched) break
        items.push(parseInline(matched[1]!.trim()))
        j++
      }
      blocks.push({ type: 'list', ordered, items })
      i = j - 1
      continue
    }

    paragraph.push(trimmed)
  }

  flushParagraph()
  return blocks
}

/* ------------------------------------------------------------------ */
/* Derived                                                             */
/* ------------------------------------------------------------------ */

function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return n.value
      if (n.type === 'code') return n.value
      return inlineText(n.children)
    })
    .join('')
}

/** The whole piece as plain prose — for excerpts, meta tags and RSS. */
export function plainText(source: string): string {
  const parts: string[] = []

  const walk = (blocks: BlockNode[]) => {
    for (const block of blocks) {
      switch (block.type) {
        case 'heading':
        case 'paragraph':
          parts.push(inlineText(block.children))
          break
        case 'quote':
          walk(block.children)
          break
        case 'list':
          for (const item of block.items) parts.push(inlineText(item))
          break
        case 'image':
          if (block.alt) parts.push(block.alt)
          break
        case 'rule':
          break
      }
    }
  }

  walk(parseMarkdown(source))
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export function excerpt(source: string, maxLength = 180): string {
  const text = plainText(source)
  if (text.length <= maxLength) return text

  const cut = text.slice(0, maxLength)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * Reading time, rounded up, never zero.
 *
 * 220 words a minute, which is the usual estimate for screen reading. "0 min
 * read" on a short piece would look broken.
 */
export function readingMinutes(source: string, wordsPerMinute = 220): number {
  const words = plainText(source).split(/\s+/).filter(Boolean).length
  if (words === 0) return 0
  return Math.max(1, Math.ceil(words / wordsPerMinute))
}

/** A slug from a title. Stable, lowercase, no surprises. */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** mm:ss or h:mm:ss, for an episode. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
