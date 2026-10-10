"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Toast } from "@/app/toast";
import { errorCatalog, getErrorDefinition } from "@/lib/errors/catalog";
import { MAX_IMAGE_COUNT, validateImageFile, type SessionImage } from "@/lib/images/limits";
import {
  prepareImageUploads, unsavedImageUploads, type PendingImageUpload,
} from "@/lib/images/upload-request";
import { uploadImageDirect } from "@/lib/images/direct-upload";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const listSchema = z.object({
  images: z.array(z.object({
    id: z.uuid(), original_filename: z.string(), sort_order: z.number(),
    previewUrl: z.string().url().nullable(), deletionPending: z.boolean().optional(),
  })),
  deletionEnabled: z.boolean().optional(),
});
const errorSchema = z.object({ errorCode: z.string(), message: z.string(), retryable: z.boolean() });

export function ImageUploader({ sessionId, editable, onImageCountChange, onImageRevisionChange, onAvailabilityChange }: {
  sessionId: string; editable: boolean; onImageCountChange?: (count: number) => void;
  onImageRevisionChange?: (revision: string) => void;
  onAvailabilityChange?: (available: boolean) => void;
}) {
  const [images, setImages] = useState<SessionImage[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failedUploads, setFailedUploads] = useState<PendingImageUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [deletionEnabled, setDeletionEnabled] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionImage | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<SessionImage | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const locked = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onAvailabilityChange?.(ready && !busy && deleting === null && failedUploads.length === 0 &&
      !images.some((image) => image.deletionPending));
  }, [ready, busy, deleting, failedUploads, images, onAvailabilityChange]);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/session-images?session_id=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
    const body: unknown = await response.json();
    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      throw new Error(parsed.success ? parsed.data.message : `${errorCatalog["UPLOAD-001"].participantMessage} (UPLOAD-001)`);
    }
    const parsed = listSchema.safeParse(body);
    if (!parsed.success) throw new Error(`${errorCatalog["UPLOAD-001"].participantMessage} (UPLOAD-001)`);
    setImages(parsed.data.images);
    setDeletionEnabled(parsed.data.deletionEnabled ?? false);
    setReady(true);
    onImageCountChange?.(parsed.data.images.filter((image) => !image.deletionPending).length);
    onImageRevisionChange?.(JSON.stringify(parsed.data.images.map((image) => [image.id, image.sort_order])));
    return parsed.data.images.map((image) => image.id);
  }, [sessionId, onImageCountChange, onImageRevisionChange]);

  useEffect(() => {
    let active = true;
    refresh().catch(() => {
      if (active) setMessage(`${errorCatalog["UPLOAD-001"].participantMessage} (UPLOAD-001)`);
    });
    return () => { active = false; };
  }, [refresh]);

  async function deleteImage(image: SessionImage) {
    if (!editable || !deletionEnabled || locked.current) return;
    locked.current = true;
    onAvailabilityChange?.(false);
    setDeleting(image.id);
    setDeleteTarget(null);
    setMessage("");
    setDeleteFailure(null);
    onImageRevisionChange?.(`deleting:${image.id}:${Date.now()}`);
    try {
      const response = await fetch(`/api/session-images?session_id=${encodeURIComponent(sessionId)}&image_id=${encodeURIComponent(image.id)}`,
        { method: "DELETE" });
      const body: unknown = await response.json();
      if (!response.ok) {
        const parsed = errorSchema.safeParse(body);
        setMessage(parsed.success ? parsed.data.message : `${errorCatalog["UPLOAD-008"].participantMessage} (UPLOAD-008)`);
        if (!parsed.success || parsed.data.retryable) setDeleteFailure(image);
        await refresh();
        return;
      }
      const result = z.object({ success: z.literal(true), activityRecorded: z.boolean() }).safeParse(body);
      if (!result.success) throw new Error("Invalid deletion response");
      setFailedUploads((current) => current.filter((upload) => upload.requestId !== image.id));
      await refresh();
      setMessage(`이미지를 삭제했습니다.${result.data.activityRecorded ? "" : ` ${errorCatalog["SAVE-002"].participantMessage} (SAVE-002)`}`);
    } catch {
      setDeleteFailure(image);
      setMessage(`${errorCatalog["UPLOAD-008"].participantMessage} (UPLOAD-008)`);
    } finally {
      locked.current = false;
      setDeleting(null);
    }
  }

  async function uploadFiles(uploads: PendingImageUpload[]) {
    if (!editable || locked.current || !ready || uploads.length === 0) return;
    if (images.some((image) => image.deletionPending)) {
      setMessage(`${errorCatalog["UPLOAD-008"].participantMessage} (UPLOAD-008)`);
      return;
    }
    const pending = unsavedImageUploads(uploads, images.map((image) => image.id));
    if (pending.length + images.length > MAX_IMAGE_COUNT) {
      setMessage(`${errorCatalog["UPLOAD-004"].participantMessage} (UPLOAD-004)`);
      return;
    }
    for (const upload of pending) {
      const code = validateImageFile(upload.file);
      if (code) { setMessage(`${getErrorDefinition(code).participantMessage} (${code})`); return; }
    }
    locked.current = true;
    onAvailabilityChange?.(false);
    setBusy(true);
    setMessage("");
    setFailedUploads([]);
    let saved = 0;
    let activityWarning = false;
    try {
      for (let index = 0; index < pending.length; index++) {
        let response: Response;
        try {
          response = await uploadImageDirect(createSupabaseBrowserClient(), sessionId, pending[index]);
        } catch {
          // Keep IDs across ambiguous responses so retries cannot consume another slot.
          setFailedUploads(pending.slice(index));
          setMessage(`${errorCatalog["NETWORK-001"].participantMessage} 실패한 이미지 다시 시도를 눌러주세요. (NETWORK-001)`);
          const savedIds = await refresh();
          setFailedUploads(unsavedImageUploads(pending.slice(index), savedIds));
          return;
        }
        if (!response.ok) {
          setFailedUploads(pending.slice(index));
          const parsed = errorSchema.safeParse(await response.json());
          setMessage(parsed.success ? parsed.data.message : `${errorCatalog["UPLOAD-001"].participantMessage} (UPLOAD-001)`);
          if (parsed.success && !parsed.data.retryable) setFailedUploads([]);
          const savedIds = await refresh();
          if (!parsed.success || parsed.data.retryable) {
            setFailedUploads(unsavedImageUploads(pending.slice(index), savedIds));
          }
          return;
        }
        const uploaded = z.object({ success: z.literal(true), activityRecorded: z.boolean() })
          .safeParse(await response.json());
        if (!uploaded.success) {
          setFailedUploads(pending.slice(index));
          throw new Error("Invalid upload response");
        }
        if (!uploaded.data.activityRecorded) activityWarning = true;
        saved++;
      }
      setMessage(`${saved}개 이미지를 저장했습니다.${activityWarning ?
        ` ${errorCatalog["SAVE-002"].participantMessage} (SAVE-002)` : ""}`);
      await refresh();
    } catch {
      setMessage(`${errorCatalog["UPLOAD-001"].participantMessage} 저장된 이미지 목록을 새로고침해주세요. (UPLOAD-001)`);
    } finally {
      locked.current = false;
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  }

  return (
    <section className="content-stack" aria-label="세션 이미지">
      <div className={`image-dropzone${dragging ? " is-dragging" : ""}`}
        tabIndex={0}
        aria-label="이미지 업로드 영역. 파일을 놓거나 클립보드 이미지를 붙여넣으세요."
        aria-disabled={!editable || busy || deleting !== null || !ready || images.some((image) => image.deletionPending)}
        onDragOver={(event) => { event.preventDefault(); if (editable && !busy && deleting === null && !images.some((image) => image.deletionPending)) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void uploadFiles(prepareImageUploads(Array.from(event.dataTransfer.files))); }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (files.length) { event.preventDefault(); void uploadFiles(prepareImageUploads(files)); }
        }}>
        {editable ? (
          <>
            <button type="button" className="upload-picker" disabled={busy || deleting !== null || !ready || images.some((image) => image.deletionPending)}
              onClick={() => picker.current?.click()}>
              <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
                <circle cx="18" cy="18" r="18" fill="currentColor" />
                <path d="M18 25V11m-6 6 6-6 6 6" fill="none" stroke="var(--color-surface)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>파일을 선택하거나 여기로 끌어다 놓으세요.</span>
              <small className="upload-format">JPG · PNG / 최대 10MB</small>
            </button>
            <input className="upload-file-input" ref={picker} id="session-images" type="file"
              aria-label="디자인 이미지 파일 선택" tabIndex={-1} accept=".jpg,.jpeg,.png,image/jpeg,image/png" multiple
              disabled={busy || deleting !== null || !ready || images.some((image) => image.deletionPending)}
              onChange={(event) => void uploadFiles(prepareImageUploads(Array.from(event.target.files ?? [])))} />
          </>
        ) : <p className="upload-hint">이 세션의 이미지는 변경할 수 없습니다.</p>}
        <div className="upload-details">
          {!editable ? <p>JPG · PNG / 최대 10MB</p> : null}
          {editable ? <p className="paste-shortcut" aria-label="Control 또는 Command와 V 키로 붙여넣기">
            <span>붙여넣기</span><kbd>Ctrl</kbd><span aria-hidden="true">/</span><kbd>⌘</kbd>
            <span aria-hidden="true">+</span><kbd>V</kbd>
          </p> : null}
        </div>
      </div>
      {busy || (!ready && !message) ? <Toast message="이미지를 불러오는 중입니다…" error={false} persistent /> : null}
      {message ? <Toast key={message} message={message} error={/\([A-Z]+-\d+\)/.test(message)} /> : null}
      {deleteTarget ? <Toast message="이 이미지를 삭제하시겠어요? 삭제한 이미지는 복구할 수 없습니다." error={false}
        action={<>
          <button type="button" className="button-secondary" onClick={() => setDeleteTarget(null)}>취소</button>
          <button type="button" disabled={!editable || busy || deleting !== null}
            onClick={() => void deleteImage(deleteTarget)}>삭제</button>
        </>} /> : null}
      <div className="image-actions">
        <p className="upload-count" aria-live="polite">이미지 {images.length} / {MAX_IMAGE_COUNT}</p>
        <button className="button-secondary" type="button" disabled hidden
          onClick={() => { setMessage(""); void refresh().then(() => setMessage("이미지 목록을 갱신했습니다.")).catch(() => setMessage(`${errorCatalog["UPLOAD-001"].participantMessage} (UPLOAD-001)`)); }}>
          이미지 목록 새로고침
        </button>
        {failedUploads.length > 0 ? <button type="button" disabled={!editable || busy || deleting !== null || images.some((image) => image.deletionPending)}
          onClick={() => void uploadFiles(failedUploads)}>실패한 이미지 다시 시도</button> : null}
        {deleteFailure ? <button type="button" disabled={!editable || busy || deleting !== null}
          onClick={() => void deleteImage(deleteFailure)}>삭제 다시 시도</button> : null}
      </div>
      <div className="image-grid">
        {images.map((image) => (
          <figure className="image-preview" key={image.id}>
            {/* Private signed URLs expire after five minutes; refresh explicitly renews previews. */}
            {image.previewUrl ? <img src={image.previewUrl} alt={`등록 이미지: ${image.original_filename}`} /> :
              <div className="image-deletion-placeholder">삭제 대기</div>}
            {editable ? <button type="button" className="image-delete button-secondary"
              disabled={!deletionEnabled || busy || deleting !== null}
              aria-label={`${image.original_filename} ${image.deletionPending ? "삭제 다시 시도" : "삭제"}`}
              title={!deletionEnabled ? "삭제 기능은 migration 적용 후 활성화됩니다." : "이미지 삭제"}
              onClick={() => image.deletionPending ? void deleteImage(image) : setDeleteTarget(image)}>
              <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button> : null}
            <figcaption>{image.original_filename}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
