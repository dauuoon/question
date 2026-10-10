import { contextKey, type ContextSaveResult, type SessionContextInput } from "./input";

export type SaveState = { status: "저장 중" | "저장됨" | "저장 실패"; message: string; savedAt?: string };

export class Autosave<T> {
  private value: T;
  private savedKey: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private disposed = false;
  private failed = false;
  private uncertain = false;
  private savedAt: string | undefined;

  constructor(
    initial: T,
    private save: (value: T) => Promise<ContextSaveResult>,
    private notify: (state: SaveState) => void,
    initialSavedAt: string | undefined,
    private key: (value: T) => string,
  ) {
    this.value = initial;
    this.savedKey = this.key(initial);
    this.savedAt = initialSavedAt;
  }

  get dirty() { return this.uncertain || this.key(this.value) !== this.savedKey; }

  change(value: T, delay: number) {
    this.value = value;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.failed) return;
    if (!this.dirty && !this.inFlight) {
      this.notify({ status: "저장됨", message: "", savedAt: this.savedAt });
      return;
    }
    this.notify({ status: "저장 중", message: "" });
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, delay);
  }

  retry() {
    this.failed = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    void this.flush();
  }

  private async flush() {
    if (this.disposed || this.inFlight || this.failed) return;
    if (!this.dirty) {
      this.notify({ status: "저장됨", message: "", savedAt: this.savedAt });
      return;
    }
    this.inFlight = true;
    const snapshot = this.value;
    this.notify({ status: "저장 중", message: "" });
    let result: ContextSaveResult;
    try {
      result = await this.save(snapshot);
    } catch {
      result = { success: false, message: "네트워크 연결 또는 저장 응답을 확인하지 못했습니다. 입력 내용은 유지됩니다. 다시 시도해주세요. (SAVE-001)" };
    }
    this.inFlight = false;
    if (this.disposed) return;
    if (!result.success) {
      this.failed = true;
      this.uncertain = true;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.notify({ status: "저장 실패", message: result.message });
      return;
    }
    this.savedKey = this.key(snapshot);
    if (result.changed) this.savedAt = new Date().toISOString();
    this.uncertain = false;
    if (this.dirty) {
      if (!this.timer) void this.flush();
    } else {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.notify({
        status: "저장됨",
        savedAt: this.savedAt,
        message: result.activityRecorded ? "" : "최근 사용일을 기록하지 못했습니다. 입력 정보는 저장되었습니다. (SAVE-002)",
      });
    }
  }

  dispose() { this.disposed = true; clearTimeout(this.timer); }
}

export class ContextAutosave extends Autosave<SessionContextInput> {
  constructor(initial: SessionContextInput, save: (value: SessionContextInput) => Promise<ContextSaveResult>,
    notify: (state: SaveState) => void, initialSavedAt?: string) {
    super(initial, save, notify, initialSavedAt, contextKey);
  }
}
