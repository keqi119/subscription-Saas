import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearFieldVideoRecovery,
  FIELD_VIDEO_RECOVERY_STORAGE_KEY,
  listFieldVideoRecoveries,
  mergeFieldVideoRecoveryPrompts,
  saveFieldVideoRecovery,
  synchronizeFieldVideoRecoveryPrompts
} from "../src/lib/field-video-upload-recovery";

describe("field video upload recovery storage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves records, removes terminal records, and filters expired records", () => {
    const storage = memoryStorage();
    saveFieldVideoRecovery(recovery("live", "2026-08-16T00:00:00.000Z"), storage);
    saveFieldVideoRecovery(recovery("expired", "2026-08-14T00:00:00.000Z"), storage);

    expect(listFieldVideoRecoveries(storage, new Date("2026-08-15T00:00:00.000Z"))).toEqual([
      expect.objectContaining({ sessionId: "live" })
    ]);

    clearFieldVideoRecovery("live", storage);
    expect(listFieldVideoRecoveries(storage)).toEqual([]);
  });

  it("drops malformed localStorage JSON safely", () => {
    const storage = memoryStorage();
    storage.setItem(FIELD_VIDEO_RECOVERY_STORAGE_KEY, "{malformed");

    expect(listFieldVideoRecoveries(storage)).toEqual([]);
    expect(storage.getItem(FIELD_VIDEO_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it("merges server-active sessions with local resume fingerprints", () => {
    const local = recovery("local-session", "2026-08-16T00:00:00.000Z");
    const serverOnly = {
      evidenceItemId: "item-2",
      expiresAt: "2026-08-16T00:00:00.000Z",
      fileName: "server-only.mov",
      sessionId: "server-session",
      sizeBytes: 100,
      workOrderId: "work-order-2"
    };

    expect(
      mergeFieldVideoRecoveryPrompts(
        [local],
        [
          {
            evidenceItemId: local.evidenceItemId,
            expiresAt: local.expiresAt,
            fileName: local.fileName,
            sessionId: local.sessionId,
            sizeBytes: local.sizeBytes,
            workOrderId: local.workOrderId
          },
          serverOnly
        ]
      )
    ).toEqual([local, serverOnly]);
  });

  it("removes stale local recovery after an authoritative active-session refresh", () => {
    const storage = memoryStorage();
    const live = recovery("live", "2099-01-01T00:00:00.000Z");
    saveFieldVideoRecovery(live, storage);
    saveFieldVideoRecovery(recovery("terminal", "2099-01-01T00:00:00.000Z"), storage);

    expect(
      synchronizeFieldVideoRecoveryPrompts(
        [
          {
            evidenceItemId: live.evidenceItemId,
            expiresAt: live.expiresAt,
            fileName: live.fileName,
            sessionId: live.sessionId,
            sizeBytes: live.sizeBytes,
            workOrderId: live.workOrderId
          }
        ],
        storage
      )
    ).toEqual([live]);
    expect(listFieldVideoRecoveries(storage)).toEqual([live]);
  });
});

function recovery(sessionId: string, expiresAt: string) {
  return {
    evidenceItemId: "item-1",
    expiresAt,
    fileName: "IMG_0284.MOV",
    fingerprintSha256: "a".repeat(64),
    lastModifiedMs: 1,
    sessionId,
    sizeBytes: 226_900_000,
    workOrderId: "work-order-1"
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
