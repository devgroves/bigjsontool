/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["duckdb"],
  "output": "standalone"
};

module.exports = nextConfig;
