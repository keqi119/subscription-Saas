import { describe, expect, it, vi } from "vitest";

import {
  canRetryFieldEvidenceUploadBatch,
  canSubmitWithFieldEvidenceUploadBatch,
  cancelFieldEvidenceUploadRequest,
  retryFieldEvidenceUploadRefresh,
  runFieldEvidenceUploadBatch,
  startFieldEvidenceUploadBatch,
  type FieldEvidenceUploadSnapshot
} from "../src/lib/field-handover-upload-batch";

describe("field evidence upload reconciliation", () => {
  it("refreshes a sent first upload and removes it when an append committed", async () => {
    const refreshDetail = vi.fn(async () => snapshot(["existing", "committed-first"]));
    const result = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch(
        "damage",
        ["first.jpg", "second.jpg"],
        true,
        snapshot(["existing"])
      ),
      {
        getInterruptionReason: () => "FAILURE",
        refreshDetail,
        uploadFile: async () => {
          throw new Error("network failed after send");
        }
      }
    );

    expect(refreshDetail).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("RETRY_PENDING");
    expect(result.batch?.files).toEqual(["second.jpg"]);
  });

  it("keeps the current append when refresh proves it did not commit", async () => {
    const result = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch(
        "damage",
        ["first.jpg", "second.jpg"],
        true,
        snapshot(["existing"])
      ),
      {
        getInterruptionReason: () => "USER_CANCEL",
        refreshDetail: async () => snapshot(["existing"]),
        uploadFile: async () => {
          throw new Error("aborted after send");
        }
      }
    );

    expect(result.status).toBe("RETRY_PENDING");
    expect(result.batch?.files).toEqual(["first.jpg", "second.jpg"]);
  });

  it("reconciles partial append success against the latest successful response", async () => {
    const result = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch(
        "damage",
        ["first.jpg", "second.jpg", "third.jpg"],
        true,
        snapshot(["existing"])
      ),
      {
        getInterruptionReason: () => "FAILURE",
        refreshDetail: async () =>
          snapshot(["existing", "committed-first", "committed-second"]),
        uploadFile: async (file) => {
          if (file === "second.jpg") {
            throw new Error("response lost");
          }
          return snapshot(["existing", "committed-first"]);
        }
      }
    );

    expect(result.status).toBe("RETRY_PENDING");
    expect(result.batch?.files).toEqual(["third.jpg"]);
  });

  it("distinguishes committed and uncommitted singleton replacement IDs", async () => {
    const committed = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch(
        "single",
        ["replacement.jpg"],
        false,
        snapshot(["old-id"])
      ),
      {
        getInterruptionReason: () => "FAILURE",
        refreshDetail: async () => snapshot(["new-id"]),
        uploadFile: async () => {
          throw new Error("response lost");
        }
      }
    );
    const uncommitted = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch(
        "single",
        ["replacement.jpg"],
        false,
        snapshot(["old-id"])
      ),
      {
        getInterruptionReason: () => "FAILURE",
        refreshDetail: async () => snapshot(["old-id"]),
        uploadFile: async () => {
          throw new Error("request rejected");
        }
      }
    );

    expect(committed).toEqual({ batch: null, fileIndex: 0, status: "IDLE" });
    expect(uncommitted.status).toBe("RETRY_PENDING");
    expect(uncommitted.batch?.files).toEqual(["replacement.jpg"]);
  });

  it("retains the barrier and uncertain queue until refresh succeeds", async () => {
    const initial = startFieldEvidenceUploadBatch(
      "damage",
      ["first.jpg", "second.jpg"],
      true,
      snapshot(["existing"])
    );
    const failed = await runFieldEvidenceUploadBatch(initial, {
      getInterruptionReason: () => "FAILURE",
      refreshDetail: async () => null,
      uploadFile: async () => {
        throw new Error("network failed");
      }
    });

    expect(failed.status).toBe("REFRESH_FAILED");
    expect(failed.batch?.files).toEqual(["first.jpg", "second.jpg"]);
    expect(canSubmitWithFieldEvidenceUploadBatch(failed)).toBe(false);
    expect(canRetryFieldEvidenceUploadBatch(failed, true)).toBe(false);

    const recovered = await retryFieldEvidenceUploadRefresh(failed, {
      refreshDetail: async () => snapshot(["existing", "committed-first"])
    });
    expect(recovered.status).toBe("RETRY_PENDING");
    expect(recovered.batch?.files).toEqual(["second.jpg"]);
  });

  it("silently refreshes after an unmount abort that was already sent", async () => {
    const refreshDetail = vi.fn(async () => snapshot([]));
    const onUploadInterrupted = vi.fn();
    const result = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch("single", ["first.jpg"], false, snapshot([])),
      {
        getInterruptionReason: () => "UNMOUNT",
        onUploadInterrupted,
        refreshDetail,
        uploadFile: async () => {
          throw new Error("unmounted");
        }
      }
    );

    expect(refreshDetail).toHaveBeenCalledTimes(1);
    expect(onUploadInterrupted).not.toHaveBeenCalled();
    expect(result.status).toBe("RETRY_PENDING");
  });

  it("sets the cancellation reason before aborting the active controller", () => {
    const controller = new AbortController();
    const reasons: string[] = [];

    expect(
      cancelFieldEvidenceUploadRequest(controller, (reason) => reasons.push(reason))
    ).toBe(true);
    expect(reasons).toEqual(["USER_CANCEL"]);
    expect(controller.signal.aborted).toBe(true);
  });
});

function snapshot(ids: string[]): FieldEvidenceUploadSnapshot {
  return { count: ids.length, ids };
}
