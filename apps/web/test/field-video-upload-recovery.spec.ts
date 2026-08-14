import { describe, expect, it } from "vitest";

import {
  clearFieldVideoRecovery,
  FIELD_VIDEO_RECOVERY_STORAGE_KEY,
  listFieldVideoRecoveries,
  saveFieldVideoRecovery
} from "../src/lib/field-video-upload-recovery";

describe("field video upload recovery storage", () => {
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
