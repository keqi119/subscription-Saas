import { ApiError } from "../src/lib/api";
import { listFieldVideoRecoveries } from "../src/lib/field-video-upload-recovery";
import { runFieldVideoUpload } from "../src/lib/field-video-upload-runner";
import { describe, expect, it, vi } from "vitest";

const CHUNK = 8;

describe("field video upload runner", () => {
  it("uploads only missing parts in ascending order", async () => {
    const api = fakeApi({ completedPartNumbers: [1, 3] });

    await runFieldVideoUpload({
      api,
      evidenceItemId: "item-1",
      file: fileOfSize(4 * CHUNK),
      onStateChange: vi.fn(),
      pollIntervalMs: 0,
      storage: memoryStorage(),
      workOrderId: "work-order-1"
    });

    expect(api.uploadPart.mock.calls.map(([input]) => input.partNumber)).toEqual([2, 4]);
  });

  it("retries one part three times without restarting completed parts", async () => {
    const api = fakeApi({ completedPartNumbers: [] });
    let secondPartAttempts = 0;
    api.uploadPart.mockImplementation(async (input) => {
      if (input.partNumber === 2 && secondPartAttempts++ < 2) {
        throw new ApiError("temporary", 503);
      }
      return {
        completedAt: new Date().toISOString(),
        partNumber: input.partNumber,
        sizeBytes: input.blob.size
      };
    });

    await runFieldVideoUpload({
      api,
      evidenceItemId: "item-1",
      file: fileOfSize(3 * CHUNK),
      retryDelaysMs: [0, 0, 0],
      storage: memoryStorage(),
      workOrderId: "work-order-1"
    });

    expect(api.uploadPart).toHaveBeenCalledTimes(5);
  });

  it("pauses by aborting only the active part and preserves recovery", async () => {
    const storage = memoryStorage();
    const controller = new AbortController();
    const api = fakeApi({ completedPartNumbers: [1] });
    api.uploadPart.mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => reject(new ApiError("paused", 0, "VIDEO_UPLOAD_PAUSED")),
            { once: true }
          );
          controller.abort();
        })
    );

    const result = await runFieldVideoUpload({
      api,
      evidenceItemId: "item-1",
      file: fileOfSize(3 * CHUNK),
      signal: controller.signal,
      storage,
      workOrderId: "work-order-1"
    });

    expect(result.status).toBe("PAUSED");
    expect(api.uploadPart).toHaveBeenCalledTimes(1);
    expect(listFieldVideoRecoveries(storage)).toHaveLength(1);
  });

  it("stops before the API when a reselected file fingerprint differs", async () => {
    const api = fakeApi({ completedPartNumbers: [] });
    const storage = memoryStorage();

    await expect(
      runFieldVideoUpload({
        api,
        evidenceItemId: "item-1",
        file: fileOfSize(CHUNK),
        recovery: {
          evidenceItemId: "item-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
          fileName: "video.mov",
          fingerprintSha256: "0".repeat(64),
          lastModifiedMs: 1,
          sessionId: "session-1",
          sizeBytes: CHUNK,
          workOrderId: "work-order-1"
        },
        storage,
        workOrderId: "work-order-1"
      })
    ).rejects.toThrow("VIDEO_UPLOAD_FILE_MISMATCH");
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.uploadPart).not.toHaveBeenCalled();
  });

  it("polls finalization to completion and clears recovery", async () => {
    const storage = memoryStorage();
    const states: string[] = [];
    const api = fakeApi({ completedPartNumbers: [] });
    api.complete.mockResolvedValueOnce(session({ status: "FINALIZE_QUEUED" }));
    api.getStatus
      .mockResolvedValueOnce(session({ status: "PROCESSING" }))
      .mockResolvedValueOnce(session({ status: "COMPLETED" }));

    const result = await runFieldVideoUpload({
      api,
      evidenceItemId: "item-1",
      file: fileOfSize(CHUNK),
      onStateChange: (state) => states.push(state.status),
      pollIntervalMs: 0,
      storage,
      workOrderId: "work-order-1"
    });

    expect(result.status).toBe("COMPLETED");
    expect(states).toEqual(
      expect.arrayContaining(["UPLOADING", "FINALIZING", "PROCESSING", "COMPLETED"])
    );
    expect(listFieldVideoRecoveries(storage)).toEqual([]);
  });

  it("returns validation and retryable failures without losing recoverability rules", async () => {
    const validationStorage = memoryStorage();
    const validationApi = fakeApi({ completedPartNumbers: [1] });
    validationApi.complete.mockResolvedValueOnce(
      session({
        failure: { code: "VIDEO_RESOLUTION_TOO_LOW", message: "请重新录制" },
        status: "VALIDATION_FAILED"
      })
    );
    const validation = await runFieldVideoUpload({
      api: validationApi,
      evidenceItemId: "item-1",
      file: fileOfSize(CHUNK),
      storage: validationStorage,
      workOrderId: "work-order-1"
    });
    expect(validation.status).toBe("VALIDATION_FAILED");
    expect(listFieldVideoRecoveries(validationStorage)).toEqual([]);

    const retryStorage = memoryStorage();
    const retryApi = fakeApi({ completedPartNumbers: [1] });
    retryApi.complete.mockResolvedValueOnce(
      session({
        failure: { code: "VIDEO_UPLOAD_PROCESSING_FAILED", message: "稍后重试" },
        status: "RETRYABLE_FAILED"
      })
    );
    const retryable = await runFieldVideoUpload({
      api: retryApi,
      evidenceItemId: "item-1",
      file: fileOfSize(CHUNK),
      storage: retryStorage,
      workOrderId: "work-order-1"
    });
    expect(retryable.status).toBe("RETRYABLE_FAILED");
    expect(listFieldVideoRecoveries(retryStorage)).toHaveLength(1);
  });
});

function fakeApi(input: { completedPartNumbers: number[] }) {
  const initial = session({ completedPartNumbers: input.completedPartNumbers });
  return {
    complete: vi.fn(async () => session({ status: "COMPLETED" })),
    createSession: vi.fn(async () => initial),
    getStatus: vi.fn(async () => session({ status: "COMPLETED" })),
    retry: vi.fn(async () => session({ status: "PROCESSING" })),
    uploadPart: vi.fn(async (part: { blob: Blob; partNumber: number; signal?: AbortSignal }) => ({
      completedAt: new Date().toISOString(),
      partNumber: part.partNumber,
      sizeBytes: part.blob.size
    }))
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    chunkSizeBytes: CHUNK,
    completedPartNumbers: [],
    evidenceItemId: "item-1",
    evidenceTitle: "车辆环绕视频",
    expiresAt: "2099-01-01T00:00:00.000Z",
    fileName: "video.mov",
    sessionId: "session-1",
    sizeBytes: CHUNK,
    status: "UPLOADING",
    totalParts: 1,
    uploadedBytes: 0,
    workOrderId: "work-order-1",
    ...overrides
  };
}

function fileOfSize(size: number) {
  const bytes = new Uint8Array(size);
  return {
    lastModified: 1,
    name: "video.mov",
    size,
    slice: (start = 0, end = size) => new Blob([bytes.slice(start, end)]),
    type: "video/quicktime"
  } as File;
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
