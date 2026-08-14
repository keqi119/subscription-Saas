export const FIELD_VIDEO_RECOVERY_STORAGE_KEY = "subscription-saas:field-video-upload:v1";

export interface FieldVideoUploadRecoveryRecord {
  evidenceItemId: string;
  expiresAt: string;
  fileName: string;
  fingerprintSha256: string;
  lastModifiedMs: number;
  sessionId: string;
  sizeBytes: number;
  workOrderId: string;
}

export type FieldVideoUploadRecoveryPrompt = Pick<
  FieldVideoUploadRecoveryRecord,
  "evidenceItemId" | "expiresAt" | "fileName" | "sessionId" | "sizeBytes" | "workOrderId"
>;

export function mergeFieldVideoRecoveryPrompts(
  localRecords: FieldVideoUploadRecoveryRecord[],
  activeSessions: FieldVideoUploadRecoveryPrompt[]
): FieldVideoUploadRecoveryPrompt[] {
  const localBySessionId = new Map(localRecords.map((record) => [record.sessionId, record]));
  return activeSessions.map((session) => localBySessionId.get(session.sessionId) ?? { ...session });
}

export function synchronizeFieldVideoRecoveryPrompts(
  activeSessions: FieldVideoUploadRecoveryPrompt[],
  storage = browserStorage()
): FieldVideoUploadRecoveryPrompt[] {
  const localRecords = listFieldVideoRecoveries(storage);
  const activeSessionIds = new Set(activeSessions.map((session) => session.sessionId));
  if (storage) {
    writeRecords(
      storage,
      localRecords.filter((record) => activeSessionIds.has(record.sessionId))
    );
  }
  return mergeFieldVideoRecoveryPrompts(localRecords, activeSessions);
}

export function saveFieldVideoRecovery(
  record: FieldVideoUploadRecoveryRecord,
  storage = browserStorage()
) {
  if (!storage || !isRecovery(record)) {
    return;
  }
  const records = listFieldVideoRecoveries(storage).filter(
    (entry) => entry.sessionId !== record.sessionId
  );
  records.push({ ...record });
  writeRecords(storage, records);
}

export function listFieldVideoRecoveries(
  storage = browserStorage(),
  now = new Date()
): FieldVideoUploadRecoveryRecord[] {
  if (!storage) {
    return [];
  }
  const raw = storage.getItem(FIELD_VIDEO_RECOVERY_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    storage.removeItem(FIELD_VIDEO_RECOVERY_STORAGE_KEY);
    return [];
  }
  if (!Array.isArray(value)) {
    storage.removeItem(FIELD_VIDEO_RECOVERY_STORAGE_KEY);
    return [];
  }
  const records = value
    .filter(isRecovery)
    .filter((record) => new Date(record.expiresAt).getTime() > now.getTime());
  writeRecords(storage, records);
  return records.map((record) => ({ ...record }));
}

export function clearFieldVideoRecovery(sessionId: string, storage = browserStorage()) {
  if (!storage) {
    return;
  }
  writeRecords(
    storage,
    listFieldVideoRecoveries(storage).filter((record) => record.sessionId !== sessionId)
  );
}

function browserStorage(): Storage | undefined {
  return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage;
}

function writeRecords(storage: Storage, records: FieldVideoUploadRecoveryRecord[]) {
  if (records.length === 0) {
    storage.removeItem(FIELD_VIDEO_RECOVERY_STORAGE_KEY);
    return;
  }
  storage.setItem(FIELD_VIDEO_RECOVERY_STORAGE_KEY, JSON.stringify(records));
}

function isRecovery(value: unknown): value is FieldVideoUploadRecoveryRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.evidenceItemId === "string" &&
    typeof record.expiresAt === "string" &&
    Number.isFinite(new Date(record.expiresAt).getTime()) &&
    typeof record.fileName === "string" &&
    typeof record.fingerprintSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.fingerprintSha256) &&
    Number.isSafeInteger(record.lastModifiedMs) &&
    typeof record.sessionId === "string" &&
    Number.isSafeInteger(record.sizeBytes) &&
    Number(record.sizeBytes) > 0 &&
    typeof record.workOrderId === "string"
  );
}
