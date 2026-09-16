/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // The home page reads the per-board meeting files from disk at request time. On Vercel,
    // public/ is served from the CDN and isn't bundled into server functions unless listed here.
    outputFileTracingIncludes: {
      "/": ["./public/data/boards/*.json"],
      "/api/digest": ["./public/data/boards/*.json"],
    },
  },
};

export default nextConfig;
