import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Journal bodies and HER responses are decrypted on the server only.
    // Keeping server actions tight is part of that boundary.
    serverActions: { bodySizeLimit: '2mb' },
  },
}

export default nextConfig
