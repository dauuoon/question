import {
  draftFingerprint, draftInputSchema, draftResponseSchema, draftErrorMessages, DraftError,
  type DraftRequest, type DraftErrorCode,
} from "../ai/context-draft-contract";
import type { SessionContextInput } from "./input";

export type DraftViewState = { status: "idle" | "loading" | "success" | "error" | "discarded"; message: string };
type Current = { input: SessionContextInput; editable: boolean; imageCount: number | null; imageRevision: string };
type DraftResult = { request_id: string; draft_text: string } | { request_id: string; skipped: true };

export async function requestContextDraft(body: DraftRequest, signal: AbortSignal): Promise<DraftResult> {
  const response = await fetch("/api/context-draft", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal, cache: "no-store",
  });
  const raw: unknown = await response.json();
  if (!response.ok) {
    const code = typeof raw === "object" && raw !== null && "errorCode" in raw &&
      typeof raw.errorCode === "string" && Object.hasOwn(draftErrorMessages, raw.errorCode) ?
      raw.errorCode as DraftErrorCode : "DRAFT-API";
    throw new DraftError(code);
  }
  const parsed = draftResponseSchema.safeParse(raw);
  if (!parsed.success) throw new DraftError("DRAFT-API");
  return parsed.data;
}

export class ContextDraftController {
  private automaticAttempted = false;
  private editRevision = 0;
  private inputRevision = 0;
  private sequence = 0;
  private abort: AbortController | null = null;
  private disposed = false;
  private lifecycle = 0;

  constructor(
    private readonly sessionId: string,
    private readonly current: () => Current,
    private readonly apply: (text: string) => void,
    private readonly publish: (state: DraftViewState) => void,
    private readonly send = requestContextDraft,
  ) {}

  attach() { this.lifecycle++; this.disposed = false; }
  detach() {
    const lifecycle = ++this.lifecycle;
    // Strict Mode immediately re-attaches; real unmounts invalidate and abort the request.
    queueMicrotask(() => {
      if (lifecycle === this.lifecycle) {
        this.disposed = true;
        this.sequence++;
        this.abort?.abort();
      }
    });
  }
  userEdited() { this.editRevision++; }
  inputsChanged() { this.inputRevision++; }
  automatic(active: boolean) {
    const now = this.current();
    if (!active || this.automaticAttempted || !this.ready(now)) return;
    this.automaticAttempted = true;
    if (now.input.additional_context) return;
    void this.generate("auto");
  }
  private ready(now: Current) {
    return now.editable && now.imageCount !== null && now.imageCount >= 1 && now.imageCount <= 10 &&
      draftInputSchema.safeParse(now.input).success;
  }
  async generate(mode: "auto" | "manual") {
    if (this.disposed) return;
    const now = this.current();
    if (!this.ready(now)) {
      this.publish({ status: "error", message: draftErrorMessages["DRAFT-INPUT"] });
      return;
    }
    this.automaticAttempted = true;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const sequence = ++this.sequence;
    const revision = this.editRevision;
    const inputRevision = this.inputRevision;
    const fingerprint = draftFingerprint(now.input, now.imageRevision);
    const requestId = crypto.randomUUID();
    this.publish({ status: "loading", message: "AI가 작업 맥락을 정리하고 있어요..." });
    try {
      const result = await this.send({
        session_id: this.sessionId, request_id: requestId, mode,
        input: { ...now.input, additional_context: null },
      }, abort.signal);
      if (this.disposed) return;
      if (sequence !== this.sequence) {
        console.info("WHY BOX context draft discarded", { code: "DRAFT-STALE", phase: "apply", requestId });
        return;
      }
      if (result.request_id !== requestId) {
        this.publish({ status: "discarded", message: draftErrorMessages["DRAFT-STALE"] }); return;
      }
      const latest = this.current();
      if (revision !== this.editRevision) {
        this.publish({ status: "discarded", message: draftErrorMessages["DRAFT-EDITED"] }); return;
      }
      if (inputRevision !== this.inputRevision || !latest.editable || !this.ready(latest) ||
        fingerprint !== draftFingerprint(latest.input, latest.imageRevision)) {
        this.publish({ status: "discarded", message: draftErrorMessages["DRAFT-STALE"] }); return;
      }
      if ("skipped" in result) { this.publish({ status: "idle", message: "" }); return; }
      this.apply(result.draft_text);
      this.publish({ status: "success", message:
        "AI가 이미지와 선택한 내용을 바탕으로 작업 맥락을 정리했어요. 내용을 확인하고 필요한 부분을 자유롭게 수정해주세요." });
    } catch (error) {
      if (this.disposed || sequence !== this.sequence) return;
      const code = error instanceof DraftError ? error.code : "DRAFT-API";
      this.publish({ status: "error", message: draftErrorMessages[code] });
    }
  }
}
