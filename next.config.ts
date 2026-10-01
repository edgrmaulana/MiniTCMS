import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module: bundling it breaks the .node binding at runtime.
  serverExternalPackages: ["better-sqlite3"],
  // Pin the root, or a stray lockfile in a parent directory gets picked up.
  turbopack: { root: __dirname },
};

export default nextConfig;
