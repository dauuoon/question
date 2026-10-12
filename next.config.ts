import type { NextConfig } from "next";
import { MANUAL_PDF_PATH } from "./src/lib/manual";

const nextConfig: NextConfig = {
  logging: { incomingRequests: false },
  async headers() {
    return [{
      source: MANUAL_PDF_PATH,
      headers: [
        { key: "Content-Disposition", value: 'inline; filename="why-box-user-manual.pdf"' },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    }];
  },
};

export default nextConfig;
