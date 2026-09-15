/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // The home page reads meetings.json from disk at request time. On Vercel, public/ is served
    // from the CDN and isn't bundled into server functions unless listed here.
    outputFileTracingIncludes: {
      "/": ["./public/data/meetings.json"],
      "/api/digest": ["./public/data/meetings.json"],
    },
  },
};

export default nextConfig;
