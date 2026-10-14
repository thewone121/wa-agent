/** @type {import('next').NextConfig} */
const nextConfig = {
  // The webhook must read the RAW body to verify Meta's signature.
  // Nothing here should transform request bodies.
  experimental: {},
};

export default nextConfig;
