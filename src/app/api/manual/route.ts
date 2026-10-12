import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { MANUAL_PDF_FILENAME } from "@/lib/manual";

export const runtime = "nodejs";

export async function GET() {
  const pdf = await readFile(join(process.cwd(), "public", "images", MANUAL_PDF_FILENAME));
  return new NextResponse(pdf, {
    headers: {
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "Content-Disposition": 'inline; filename="why-box-user-manual.pdf"',
      "Content-Type": "application/pdf",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
