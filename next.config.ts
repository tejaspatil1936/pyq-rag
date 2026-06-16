import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // onnxruntime (pulled in by @huggingface/transformers) ships native
  // binaries that must not be bundled by webpack/turbopack.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node"],
};

export default nextConfig;
