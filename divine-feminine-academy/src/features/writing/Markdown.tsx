import { Fragment, type ReactNode } from 'react'
import { parseMarkdown, type BlockNode, type InlineNode } from './markdown'

/**
 * Render a parsed piece of writing.
 *
 * Every text value below is passed to React as a CHILD, never as HTML, so
 * escaping is structural rather than something anybody has to remember. There
 * is no `dangerouslySetInnerHTML` in this file and there should never be one:
 * the moment there is, the parser's careful URL checks stop being the only
 * thing standing between a pasted paragraph and a script tag.
 */

function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={i}>{node.value}</Fragment>
      case 'strong':
        return <strong key={i}>{renderInline(node.children)}</strong>
      case 'em':
        return <em key={i}>{renderInline(node.children)}</em>
      case 'code':
        return (
          <code
            key={i}
            className="rounded bg-linen px-1.5 py-0.5 font-mono text-[0.9em]"
          >
            {node.value}
          </code>
        )
      case 'link': {
        const external = /^https?:\/\//.test(node.href)
        return (
          <a
            key={i}
            href={node.href}
            className="underline underline-offset-2 decoration-clay hover:decoration-plum"
            {...(external
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : {})}
          >
            {renderInline(node.children)}
          </a>
        )
      }
    }
  })
}

function renderBlocks(blocks: BlockNode[]): ReactNode {
  return blocks.map((block, i) => {
    switch (block.type) {
      case 'heading':
        return block.level === 2 ? (
          <h2 key={i} className="mt-14 font-display text-2xl leading-snug md:text-3xl">
            {renderInline(block.children)}
          </h2>
        ) : (
          <h3 key={i} className="mt-10 font-display text-xl leading-snug">
            {renderInline(block.children)}
          </h3>
        )

      case 'paragraph':
        return (
          <p key={i} className="mt-6 text-lg leading-relaxed text-ink-soft">
            {renderInline(block.children)}
          </p>
        )

      case 'quote':
        return (
          <blockquote
            key={i}
            className="mt-10 border-l-2 border-gilt pl-6 font-display text-xl leading-snug text-ink [&>p]:text-ink [&>p:first-child]:mt-0"
          >
            {renderBlocks(block.children)}
          </blockquote>
        )

      case 'list': {
        const className =
          'mt-6 space-y-2.5 pl-6 text-lg leading-relaxed text-ink-soft'
        const items = block.items.map((item, j) => (
          <li key={j}>{renderInline(item)}</li>
        ))
        return block.ordered ? (
          <ol key={i} className={`${className} list-decimal`}>
            {items}
          </ol>
        ) : (
          <ul key={i} className={`${className} list-disc`}>
            {items}
          </ul>
        )
      }

      case 'rule':
        return <hr key={i} className="my-14 border-0 border-t border-rule" />

      case 'image':
        return (
          <figure key={i} className="my-12">
            {/*
              A plain img rather than next/image: these are pasted by hand into
              a body of text, from hosts nobody has configured, and a remote
              host that is not in next.config would break the whole page
              instead of one picture.
            */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={block.src}
              alt={block.alt}
              className="w-full rounded-xl border border-rule"
              loading="lazy"
            />
            {block.alt && (
              <figcaption className="mt-3 text-2xs text-ink-muted">
                {block.alt}
              </figcaption>
            )}
          </figure>
        )
    }
  })
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source)
  if (blocks.length === 0) return null
  return <div className="measure [&>*:first-child]:mt-0">{renderBlocks(blocks)}</div>
}
