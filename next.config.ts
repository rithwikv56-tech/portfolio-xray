import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / heavy deps used only in server routes must not be bundled.
  serverExternalPackages: ["@napi-rs/canvas", "tesseract.js", "pdfjs-dist", "pdf-parse"],
};

export default nextConfig;
