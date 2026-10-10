import { CreateSessionForm } from "./create-session-form";
import { ActivityMarker } from "../../activity-marker";
import { requireRole } from "@/lib/auth/role";

export default async function NewSessionPage() {
  const { user } = await requireRole("participant");
  return (
    <section className="content-stack">
      <ActivityMarker path="/sessions/new" participantId={user.id} />
      <p role="status" className="supporting-copy">1단계 디자인 업로드를 준비하고 있어요.</p>
      <CreateSessionForm autoStart label="다시 시도" />
    </section>
  );
}
