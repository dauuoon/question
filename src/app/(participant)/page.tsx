import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/role";
import { CreateSessionForm } from "./sessions/new/create-session-form";

export default async function ParticipantHomePage() {
  const { supabase, user } = await requireRole("participant");
  const { data: sessions, error } = await supabase.from("sessions")
    .select("id").eq("participant_id", user.id).neq("status", "completed")
    .order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (error) throw new Error("Unable to load the latest in-progress session.");
  if (sessions?.[0]) redirect(`/sessions/${sessions[0].id}`);

  return (
    <section className="content-stack">
      <p role="status" className="supporting-copy">1단계 이미지 입력을 준비하고 있어요.</p>
      <CreateSessionForm autoStart label="다시 시도" />
    </section>
  );
}
