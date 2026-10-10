import { notFound } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth/role";
import { ActivityMarker } from "../../activity-marker";
import { errorCatalog } from "@/lib/errors/catalog";
import { SessionWizard } from "./session-wizard";
import { Toast } from "@/app/toast";
import { readGenerationView } from "@/lib/question-generation/read";
import { QuestionResult } from "./question-result";

type SessionPageProps = {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ activity_error?: string }>;
};

export default async function ParticipantSessionPage({
  params,
  searchParams,
}: SessionPageProps) {
  const { sessionId } = await params;
  const { activity_error: activityError } = await searchParams;
  if (!z.uuid().safeParse(sessionId).success) notFound();
  const { supabase, user } = await requireRole("participant");
  const { data: session, error } = await supabase.from("sessions")
    .select("status, updated_at, summary_text, primary_category_id, subcategory_id, other_category_text, stage_id, additional_context")
    .eq("id", sessionId).eq("participant_id", user.id).maybeSingle();
  if (error) throw new Error("Unable to load this reflection session.");
  if (!session) notFound();
  const generation = await readGenerationView(supabase, user.id, sessionId);
  if (generation.state === "completed") return <section className="content-stack">
    <ActivityMarker path={`/sessions/${sessionId}`} participantId={user.id} />
    <QuestionResult result={generation} sessionStatus={session.status} />
  </section>;
  if (session.status === "completed") throw new Error("Completed session has no saved question result.");
  const { data: contexts, error: contextError } = await supabase.from("session_contexts")
    .select("context_id").eq("session_id", sessionId);
  if (contextError) throw new Error("Unable to load reflection context selections.");

  return (
    <section className="content-stack">
      <ActivityMarker path={`/sessions/${sessionId}`} participantId={user.id} />
      {activityError === "SAVE-002" ? <Toast error message={`${errorCatalog["SAVE-002"].participantMessage} (SAVE-002)`} /> : null}
      <SessionWizard key={sessionId} sessionId={sessionId} initialGeneration={generation}
        sessionStatus={session.status}
        initialSavedAt={session.updated_at} initial={{
        primary_category_id: session.primary_category_id,
        subcategory_id: session.subcategory_id,
        other_category_text: session.other_category_text,
        stage_id: session.stage_id,
        additional_context: session.additional_context,
        context_ids: contexts.map((item) => item.context_id),
      }} />
    </section>
  );
}
