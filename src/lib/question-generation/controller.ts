import { z } from "zod";
import { questionGenerationErrorMessages, type QuestionGenerationErrorCode } from "../ai/question-generation-contract";
import { generationViewSchema, type GenerationView } from "./view-contract";

export type GenerationUI = { view: GenerationView; message: string; checking: boolean };
export const GENERATION_POLL_MS = 5_000;
export const GENERATION_MAX_READS = 12;
export const GENERATION_REQUEST_MS = 90_000;
export const recoveryMessage = "질문 생성 상태를 확인하고 있어요. 상태 확인으로 다시 확인해주세요. 계속되면 연구자에게 알려주세요.";
export function generationMessage(code: QuestionGenerationErrorCode) {
  if (["QGEN-DB", "QGEN-STAGE", "QGEN-COMMIT", "QGEN-RECOVERY"].includes(code)) return recoveryMessage;
  if (code === "QGEN-INPUT") return "저장된 입력과 이미지를 확인한 뒤 다시 시도해주세요.";
  return questionGenerationErrorMessages[code];
}
class RequestError extends Error {
  constructor(readonly code: QuestionGenerationErrorCode) { super(code); }
}
function isErrorCode(code: unknown): code is QuestionGenerationErrorCode {
  return typeof code === "string" && Object.hasOwn(questionGenerationErrorMessages, code);
}
const responseSchema = z.discriminatedUnion("status", [
  z.object({ request_id: z.uuid(), attempt_id: z.uuid(), status: z.literal("running"), retry_same_request: z.literal(true) }).strict(),
  z.object({ request_id: z.uuid(), attempt_id: z.uuid(), status: z.literal("completed"), question_ids: z.array(z.uuid()).min(1).max(5) }).strict(),
]);
export async function sendGeneration(sessionId: string, requestId: string, signal: AbortSignal) {
  const response = await fetch("/api/question-generation", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, request_id: requestId }), cache: "no-store", signal,
  });
  const raw: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ errorCode: z.string() }).safeParse(raw);
    throw new RequestError(parsed.success && isErrorCode(parsed.data.errorCode) ? parsed.data.errorCode : "QGEN-DB");
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.request_id !== requestId ||
    response.status !== (parsed.data.status === "running" ? 202 : 200)) throw new RequestError("QGEN-DB");
  return parsed.data;
}
export async function readGeneration(sessionId: string, signal: AbortSignal): Promise<GenerationView> {
  const response = await fetch(`/api/question-generation?session_id=${encodeURIComponent(sessionId)}`, { cache: "no-store", signal });
  if (!response.ok) throw new RequestError("QGEN-DB");
  const parsed = generationViewSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.session_id !== sessionId) throw new RequestError("QGEN-DB");
  return parsed.data;
}

export class GenerationController {
  private view: GenerationView;
  private busy = false;
  private disposed = false;
  private lifecycle = 0;
  private reads = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | null = null;
  private requestId: string | null = null;
  private uncertainRequest = false;
  private expectedIds: string[] | null = null;
  constructor(initial: GenerationView, private ready: () => boolean,
    private publish: (value: GenerationUI) => void,
    private send = sendGeneration, private read = readGeneration) { this.view = initial; }

  attach() {
    this.lifecycle++; this.disposed = false;
    if (this.view.state === "running" && !this.busy && !this.timer) this.schedule();
  }
  detach() {
    const lifecycle = ++this.lifecycle;
    queueMicrotask(() => {
      if (lifecycle !== this.lifecycle) return;
      this.disposed = true; clearTimeout(this.timer); this.timer = undefined; this.abort?.abort();
    });
  }
  private emit(message = "", checking = false) {
    if (!this.disposed) this.publish({ view: this.view, message, checking });
  }
  private schedule() {
    if (this.disposed || this.reads >= GENERATION_MAX_READS) {
      this.view = { ...this.view, state: "recovery" }; this.emit(recoveryMessage); return;
    }
    this.timer = setTimeout(() => { this.timer = undefined; void this.check(); }, GENERATION_POLL_MS);
  }
  async start() {
    if (this.disposed || this.busy || this.view.state !== "editable" || !this.ready()) return;
    this.busy = true;
    clearTimeout(this.timer); this.timer = undefined; this.reads = 0;
    this.requestId = crypto.randomUUID();
    this.uncertainRequest = true;
    this.expectedIds = null;
    this.view = { ...this.view, state: "running" };
    const abort = new AbortController(); this.abort = abort; this.emit();
    const timeout = setTimeout(() => abort.abort(), GENERATION_REQUEST_MS);
    let message = "";
    try {
      const response = await this.send(this.view.session_id, this.requestId, abort.signal);
      if (response.status === "completed") this.expectedIds = response.question_ids;
    }
    catch (error) {
      message = generationMessage(error instanceof RequestError ? error.code : "QGEN-DB");
      if (error instanceof RequestError && ["QGEN-AUTH", "QGEN-INPUT", "QGEN-BEGIN"].includes(error.code)) {
        this.uncertainRequest = false;
      }
    }
    finally { clearTimeout(timeout); this.busy = false; }
    if (!this.disposed) await this.check(message);
  }
  async check(message = "") {
    if (this.disposed || this.busy) return;
    clearTimeout(this.timer); this.timer = undefined;
    this.busy = true; this.reads++;
    const abort = new AbortController(); this.abort = abort; this.emit(message, true);
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      this.view = await this.read(this.view.session_id, abort.signal);
      if (this.view.state === "editable" && this.uncertainRequest &&
        this.view.failed_request_id !== this.requestId) this.view = { ...this.view, state: "recovery" };
      if (this.view.state === "completed" && this.expectedIds &&
        (this.view.questions.length !== this.expectedIds.length ||
          this.view.questions.some((q, i) => q.id !== this.expectedIds?.[i]))) {
        this.view = { ...this.view, state: "recovery", questions: [] };
      }
      this.emit(this.view.state === "recovery" ? recoveryMessage : this.view.state === "editable" ? message : "");
    } catch {
      this.view = { ...this.view, state: "recovery" }; this.emit(recoveryMessage);
    } finally { clearTimeout(timeout); this.busy = false; }
    if (!this.disposed && this.view.state === "running") this.schedule();
  }
}
