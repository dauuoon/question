import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { recordParticipantActivity } from "@/lib/activity/record";
import { researchScreenSession } from "@/lib/activity/screen";
import { reportError } from "@/lib/errors/report";

export async function POST(request: NextRequest) {
  const protocol = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.slice(0, -1);
  if (request.headers.get("origin") !== `${protocol}://${request.headers.get("host")}`) {
    return NextResponse.json(await reportError("AUTH-002", "activity.origin"), { status: 403 });
  }
  let body: unknown;
  try {
    if (Number(request.headers.get("content-length")) > 1024) throw new Error("Activity input too large");
    const text = await request.text();
    if (text.length > 1024) throw new Error("Activity input too large");
    body = JSON.parse(text);
  } catch {
    return NextResponse.json(await reportError("SAVE-002", "activity.input"), { status: 400 });
  }
  const input = z.object({ path: z.string().max(200) }).strict().safeParse(body);
  const sessionId = input.success ? researchScreenSession(input.data.path) : undefined;
  if (!input.success || sessionId === undefined) {
    return NextResponse.json(await reportError("SAVE-002", "activity.screen"), { status: 400 });
  }
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json(await reportError("AUTH-002", "activity.auth"), { status: 403 });
  const profile = await supabase.from("profiles").select("role, status").eq("id", user.id).maybeSingle();
  if (profile.error || profile.data?.role !== "participant" || profile.data.status !== "active") {
    return NextResponse.json(await reportError("AUTH-002", "activity.role"), { status: 403 });
  }
  if (sessionId) {
    const session = await supabase.from("sessions").select("id")
      .eq("id", sessionId).eq("participant_id", user.id).maybeSingle();
    if (session.error || !session.data) {
      return NextResponse.json(await reportError("AUTH-002", "activity.session"), { status: 403 });
    }
  }
  if (!await recordParticipantActivity("screen_access")) {
    return NextResponse.json(await reportError("SAVE-002", "activity.screen_record"), { status: 503 });
  }
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
