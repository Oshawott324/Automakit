import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  transpilePackages: ["@agentic-polymarket/ui"],
};

export default nextConfig;
