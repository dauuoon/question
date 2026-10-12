import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  logging: { incomingRequests: false },
  outputFileTracingIncludes: {
    "/api/manual": ["./public/why-box-user-manual.pdf"],
  },
};

export default nextConfig;
