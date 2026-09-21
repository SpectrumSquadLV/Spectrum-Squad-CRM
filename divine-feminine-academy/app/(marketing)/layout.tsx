import { SiteFooter, SiteHeader } from '@/design-system/patterns'

/**
 * Public pages stay statically prerendered - that is the point of the
 * marketing site, and reading the session here would make every page dynamic.
 *
 * The header resolves signed-in state in the browser instead, so the HTML that
 * Google sees is the same for everybody.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-plum focus:px-4 focus:py-2 focus:text-bone"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </>
  )
}
