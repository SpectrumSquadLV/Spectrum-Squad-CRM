import type { NextConfig } from 'next'

/**
 * Security headers.
 *
 * No Content-Security-Policy yet: Next injects inline scripts for hydration,
 * so a correct CSP needs nonces threaded through the document. Shipping a
 * permissive one with 'unsafe-inline' would look like protection while
 * providing almost none, so it is listed as outstanding in the README instead
 * of faked here.
 */
const securityHeaders = [
  // Do not let the browser guess a content type; a user upload served as HTML
  // is how stored XSS happens.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nothing here needs a camera, a microphone or a location.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  // Two years, and only over HTTPS. Harmless locally, where it is not sent.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Journal bodies and HER responses are decrypted on the server only.
    // Keeping server actions tight is part of that boundary.
    serverActions: { bodySizeLimit: '2mb' },
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        // Her own pages must never be cached by a shared proxy. The path has
        // to match the route group on disk: this said /my-academy for a while
        // after the member area was renamed, which matched nothing at all.
        source: '/my-practice/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      {
        source: '/admin/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ]
  },
}

export default nextConfig
