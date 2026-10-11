import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isInvalidAuthSession } from "@/lib/auth/session-error";
import { ResearchDataError } from "@/lib/admin/research-data";
import { EXPORT_MAX_FILE_BYTES, writeResearchWorkbook } from "@/lib/admin/research-workbook";

export const runtime = "nodejs";
export const maxDuration = 120;
const selectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sessions") }).strict(),
  z.object({ kind: z.literal("diaries") }).strict(),
  z.object({ kind: z.literal("session"), id: z.uuid() }).strict(),
  z.object({ kind: z.literal("participant"), id: z.uuid() }).strict(),
]);

export async function GET(request: NextRequest) {
  let directory: string | undefined;
  try {
    const client = await createSupabaseServerClient();
    const auth = await client.auth.getUser();
    if (auth.error || !auth.data.user) {
      if (auth.error && !isInvalidAuthSession(auth.error)) {
        throw new ResearchDataError("EXPORT-AUTH-VERIFY");
      }
      throw new ResearchDataError("EXPORT-AUTH", 401);
    }
    const profile = await client.from("profiles").select("role,status").eq("id", auth.data.user.id).maybeSingle();
    if (profile.error) throw new ResearchDataError("EXPORT-AUTH-VERIFY");
    if (profile.data?.role !== "admin" || profile.data.status !== "active") {
      throw new ResearchDataError("EXPORT-FORBIDDEN", 403);
    }
    const selection = selectionSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!selection.success) throw new ResearchDataError("EXPORT-INPUT", 400);
    directory = await mkdtemp(join(tmpdir(), "whybox-export-"));
    const filename = join(directory, "research.xlsx");
    await writeResearchWorkbook(client, selection.data, filename);
    const info = await stat(filename);
    if (info.size > EXPORT_MAX_FILE_BYTES) throw new ResearchDataError("EXPORT-FILE-LIMIT", 413);
    const cleanupDirectory = directory;
    const file = createReadStream(filename);
    const iterator = file[Symbol.asyncIterator]();
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      file.destroy();
      await rm(cleanupDirectory, { recursive: true, force: true });
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) { await cleanup(); controller.close(); }
          else controller.enqueue(new Uint8Array(next.value));
        } catch (error) {
          console.error("WHY BOX research export: EXPORT-STREAM", error instanceof Error ? error.name : "unknown");
          await cleanup();
          controller.error(new Error("EXPORT-STREAM"));
        }
      },
      async cancel() { await cleanup(); },
    });
    directory = undefined;
    return new Response(stream, { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="whybox-${selection.data.kind}-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      "Content-Length": String(info.size), "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    const safe = error instanceof ResearchDataError ? error : new ResearchDataError("EXPORT-FAILED");
    console.error("WHY BOX research export:", safe.code);
    return NextResponse.json({ errorCode: safe.code, message: safe.status === 413 ?
      "내보내기 한도를 초과했습니다. 참여자별 또는 세션별로 나누어 다운로드해주세요." :
      safe.code === "EXPORT-RESEARCH-ONLY" ? "연구용 Excel은 명시적으로 P로 분류된 참여자의 기록만 제공합니다." :
      safe.status === 403 || safe.status === 401 ? "활성 관리자 로그인이 필요합니다." :
        safe.status === 404 ? "해당 연구 기록을 찾을 수 없습니다." : "연구 데이터를 다운로드하지 못했습니다." },
    { status: safe.status, headers: { "Cache-Control": "no-store" } });
  }
}
