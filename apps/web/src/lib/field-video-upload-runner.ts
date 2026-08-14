import { ApiError } from "./api";
import {
  cancelFieldVideoUploadSession,
  completeFieldVideoUploadSession,
  createFieldVideoUploadSession,
  FieldVideoUploadedPart,
  FieldVideoUploadSession,
  getFieldVideoUploadSession,
  retryFieldVideoUploadSession,
  uploadFieldVideoPart,
  UploadFieldVideoPartInput
} from "./field-video-upload-api";
import {
  clearFieldVideoRecovery,
  FieldVideoUploadRecoveryRecord,
  saveFieldVideoRecovery
} from "./field-video-upload-recovery";
import {
  buildFieldVideoChunkPlan,
  buildFieldVideoResumeFingerprint,
  formatFieldVideoUploadProgress,
  selectMissingFieldVideoParts,
  sha256Blob
} from "./field-video-upload";

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export type FieldVideoUploadRunnerStatus =
  | "SELECTED"
  | "UPLOADING"
  | "PAUSED"
  | "FINALIZING"
  | "PROCESSING"
  | "COMPLETED"
  | "RETRYABLE_FAILED"
  | "VALIDATION_FAILED";

export interface FieldVideoUploadRunnerState {
  completedParts: number;
  errorCode?: string;
  errorMessage?: string;
  loadedBytes: number;
  percent: number;
  session?: FieldVideoUploadSession;
  status: FieldVideoUploadRunnerStatus;
  totalBytes: number;
  totalParts: number;
}

export interface FieldVideoUploadApi {
  complete(
    workOrderId: string,
    evidenceItemId: string,
    sessionId: string
  ): Promise<FieldVideoUploadSession>;
  createSession(
    workOrderId: string,
    evidenceItemId: string,
    input: {
      fileName: string;
      fingerprintSha256: string;
      lastModifiedMs: number;
      mimeType: string;
      replaceEvidenceFileId?: string;
      sizeBytes: number;
    }
  ): Promise<FieldVideoUploadSession>;
  getStatus(
    workOrderId: string,
    evidenceItemId: string,
    sessionId: string
  ): Promise<FieldVideoUploadSession>;
  retry(
    workOrderId: string,
    evidenceItemId: string,
    sessionId: string
  ): Promise<FieldVideoUploadSession>;
  uploadPart(input: UploadFieldVideoPartInput): Promise<FieldVideoUploadedPart>;
}

export interface RunFieldVideoUploadInput {
  api?: FieldVideoUploadApi;
  evidenceItemId: string;
  file: File;
  onStateChange?: (state: FieldVideoUploadRunnerState) => void;
  pollIntervalMs?: number;
  recovery?: FieldVideoUploadRecoveryRecord;
  replaceEvidenceFileId?: string;
  retryDelaysMs?: readonly number[];
  retryFinalization?: boolean;
  signal?: AbortSignal;
  storage?: Storage;
  workOrderId: string;
}

export interface FieldVideoUploadRunResult {
  session: FieldVideoUploadSession;
  status: FieldVideoUploadRunnerStatus;
}

const defaultApi: FieldVideoUploadApi = {
  complete: completeFieldVideoUploadSession,
  createSession: createFieldVideoUploadSession,
  getStatus: getFieldVideoUploadSession,
  retry: retryFieldVideoUploadSession,
  uploadPart: uploadFieldVideoPart
};

export async function runFieldVideoUpload(
  input: RunFieldVideoUploadInput
): Promise<FieldVideoUploadRunResult> {
  const api = input.api ?? defaultApi;
  let session: FieldVideoUploadSession | undefined;
  emit(input, "SELECTED", undefined, 0, 0);
  try {
    const fingerprintSha256 = await buildFieldVideoResumeFingerprint(input.file);
    if (input.recovery && input.recovery.fingerprintSha256 !== fingerprintSha256) {
      throw new Error("VIDEO_UPLOAD_FILE_MISMATCH");
    }
    assertNotPaused(input.signal);
    session = await api.createSession(input.workOrderId, input.evidenceItemId, {
      fileName: input.file.name,
      fingerprintSha256,
      lastModifiedMs: input.file.lastModified,
      mimeType: input.file.type,
      replaceEvidenceFileId: input.replaceEvidenceFileId,
      sizeBytes: input.file.size
    });
    saveFieldVideoRecovery(
      {
        evidenceItemId: input.evidenceItemId,
        expiresAt: session.expiresAt,
        fileName: input.file.name,
        fingerprintSha256,
        lastModifiedMs: input.file.lastModified,
        sessionId: session.sessionId,
        sizeBytes: input.file.size,
        workOrderId: input.workOrderId
      },
      input.storage
    );

    const early = await handleNonUploadingSession(input, api, session);
    if (early) {
      return early;
    }

    const parts = buildFieldVideoChunkPlan(input.file.size, session.chunkSizeBytes);
    const missing = selectMissingFieldVideoParts(parts, session.completedPartNumbers);
    let uploadedBytes = parts
      .filter((part) => session!.completedPartNumbers.includes(part.partNumber))
      .reduce((total, part) => total + part.sizeBytes, 0);
    emit(input, "UPLOADING", session, uploadedBytes, parts.length);

    for (const part of missing) {
      assertNotPaused(input.signal);
      const blob = input.file.slice(part.startByte, part.endByte);
      const sha256 = await sha256Blob(blob);
      await retryPart(
        () =>
          api.uploadPart({
            blob,
            evidenceItemId: input.evidenceItemId,
            onProgress: ({ loadedBytes }) =>
              emit(input, "UPLOADING", session, uploadedBytes + loadedBytes, parts.length),
            partNumber: part.partNumber,
            sessionId: session!.sessionId,
            sha256,
            signal: input.signal,
            workOrderId: input.workOrderId
          }),
        input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
        input.signal
      );
      uploadedBytes += part.sizeBytes;
      session = {
        ...session,
        completedPartNumbers: [...session.completedPartNumbers, part.partNumber],
        uploadedBytes
      };
      emit(input, "UPLOADING", session, uploadedBytes, parts.length);
    }

    emit(input, "FINALIZING", session, input.file.size, parts.length);
    session = await api.complete(input.workOrderId, input.evidenceItemId, session.sessionId);
    return await pollUntilTerminal(input, api, session, parts.length);
  } catch (error) {
    if (isPaused(error, input.signal) && session) {
      emit(input, "PAUSED", session, session.uploadedBytes, session.totalParts);
      return { session, status: "PAUSED" };
    }
    throw error;
  }
}

async function handleNonUploadingSession(
  input: RunFieldVideoUploadInput,
  api: FieldVideoUploadApi,
  session: FieldVideoUploadSession
): Promise<FieldVideoUploadRunResult | null> {
  if (session.status === "UPLOADING") {
    return null;
  }
  if (session.status === "RETRYABLE_FAILED" && input.retryFinalization) {
    const retried = await api.retry(input.workOrderId, input.evidenceItemId, session.sessionId);
    return pollUntilTerminal(input, api, retried, retried.totalParts);
  }
  return resolveTerminalOrPolling(input, api, session, session.totalParts);
}

async function pollUntilTerminal(
  input: RunFieldVideoUploadInput,
  api: FieldVideoUploadApi,
  first: FieldVideoUploadSession,
  totalParts: number
): Promise<FieldVideoUploadRunResult> {
  let session = first;
  for (;;) {
    const resolved = await resolveTerminalOrPolling(input, api, session, totalParts);
    if (resolved) {
      return resolved;
    }
    await wait(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, input.signal);
    session = await api.getStatus(input.workOrderId, input.evidenceItemId, session.sessionId);
  }
}

async function resolveTerminalOrPolling(
  input: RunFieldVideoUploadInput,
  _api: FieldVideoUploadApi,
  session: FieldVideoUploadSession,
  totalParts: number
): Promise<FieldVideoUploadRunResult | null> {
  if (session.status === "COMPLETED") {
    clearFieldVideoRecovery(session.sessionId, input.storage);
    emit(input, "COMPLETED", session, input.file.size, totalParts);
    return { session, status: "COMPLETED" };
  }
  if (session.status === "VALIDATION_FAILED") {
    clearFieldVideoRecovery(session.sessionId, input.storage);
    emit(input, "VALIDATION_FAILED", session, session.uploadedBytes, totalParts);
    return { session, status: "VALIDATION_FAILED" };
  }
  if (session.status === "RETRYABLE_FAILED") {
    emit(input, "RETRYABLE_FAILED", session, session.uploadedBytes, totalParts);
    return { session, status: "RETRYABLE_FAILED" };
  }
  if (session.status === "CANCELLED" || session.status === "EXPIRED") {
    clearFieldVideoRecovery(session.sessionId, input.storage);
    emit(input, "VALIDATION_FAILED", session, session.uploadedBytes, totalParts);
    return { session, status: "VALIDATION_FAILED" };
  }
  emit(
    input,
    session.status === "PROCESSING" || session.status === "OBJECT_READY"
      ? "PROCESSING"
      : "FINALIZING",
    session,
    session.uploadedBytes,
    totalParts
  );
  return null;
}

async function retryPart(
  operation: () => Promise<FieldVideoUploadedPart>,
  delaysMs: readonly number[],
  signal?: AbortSignal
) {
  const attempts = Math.max(1, delaysMs.length);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    assertNotPaused(signal);
    try {
      return await operation();
    } catch (error) {
      if (!isRetryablePartError(error) || attempt === attempts - 1) {
        throw error;
      }
      await wait(delaysMs[attempt] ?? 0, signal);
    }
  }
  throw new Error("VIDEO_UPLOAD_PART_RETRY_EXHAUSTED");
}

function isRetryablePartError(error: unknown) {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

function emit(
  input: RunFieldVideoUploadInput,
  status: FieldVideoUploadRunnerStatus,
  session: FieldVideoUploadSession | undefined,
  loadedBytes: number,
  totalParts: number
) {
  const progress = formatFieldVideoUploadProgress(loadedBytes, input.file.size);
  input.onStateChange?.({
    completedParts: session?.completedPartNumbers.length ?? 0,
    errorCode: session?.failure?.code,
    errorMessage: session?.failure?.message,
    ...progress,
    session,
    status,
    totalParts
  });
}

function assertNotPaused(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new ApiError("视频上传已暂停。", 0, "VIDEO_UPLOAD_PAUSED");
  }
}

function isPaused(error: unknown, signal?: AbortSignal) {
  return (
    signal?.aborted === true || (error instanceof ApiError && error.code === "VIDEO_UPLOAD_PAUSED")
  );
}

function wait(delayMs: number, signal?: AbortSignal) {
  assertNotPaused(signal);
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, delayMs);
    const abort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new ApiError("视频上传已暂停。", 0, "VIDEO_UPLOAD_PAUSED"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export const fieldVideoUploadApi = {
  cancel: cancelFieldVideoUploadSession,
  ...defaultApi
};
