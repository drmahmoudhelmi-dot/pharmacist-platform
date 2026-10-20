import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/shared/i18n/request.ts");

const nextConfig: NextConfig = {
  // Self-contained server bundle for the container image (ADR-001 section 2).
  output: "standalone",
  poweredByHeader: false,
};

export default withNextIntl(nextConfig);
