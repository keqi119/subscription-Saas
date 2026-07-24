import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  deploymentId: process.env.NEXT_DEPLOYMENT_ID,
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: ["@subscription-saas/shared"]
};

export default nextConfig;
