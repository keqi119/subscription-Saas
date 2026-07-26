import { describe, expect, it, vi } from "vitest";

import {
  abandonFieldEvidenceUploadRecovery,
  canStartFieldEvidenceUploadBatch,
  canSubmitWithFieldEvidenceUploadBatch,
  cancelFieldEvidenceUploadRequest,
  hasFieldEvidenceUploadRecoveries,
  retryFieldEvidenceUploadBatch,
  retryFieldEvidenceUploadRefresh,
  runFieldEvidenceUploadBatch,
  startFieldEvidenceUploadBatch,
  type FieldEvidenceUploadSnapshot
} from "../src/lib/field-handover-upload-batch";
import { buildFieldEvidenceUploadRetryDisplay } from "../src/lib/field-handover-upload";

describe("field evidence upload reconciliation", () => {
  it("refreshes a sent first upload and removes it when an append committed", async () => {
    const refreshDetail = vi.fn(async () => snapshot(["existing", "committed-first"]));
    const result = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch(
        "damage",
        ["first.jpg", "second.jpg"],
        true,
        snapshot(["existing"]),
        { type: "APPEND" }
      ),
      {
        getFailureMessage: () => "upload failed",
        getInterruptionReason: () => "FAILURE",
        refreshDetail,
        uploadFile: async () => {
          throw new Error("network failed after send");
        }
      }
    );

    expect(refreshDetail).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("IDLE");
    expect(result.batch).toBeNull();
    expect(result.recoveries.damage?.files).toEqual(["second.jpg"]);
  });

  it("authoritatively failed uploads become recoverable without locking other items", async () => {
    const result = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch("front", ["front.jpg"], false, snapshot([])),
      {
        getFailureMessage: () => "media processing failed",
        getInterruptionReason: () => "FAILURE",
        refreshDetail: async () => snapshot([]),
        uploadFile: async () => {
          throw new Error("rejected");
        }
      }
    );

    expect(result.status).toBe("IDLE");
    expect(result.recoveries.front).toEqual({
      baseline: snapshot([]),
      errorMessage: "media processing failed",
      files: ["front.jpg"],
      itemViewId: "front",
      operation: { type: "APPEND" }
    });
    expect(canStartFieldEvidenceUploadBatch(result, "side")).toBe(true);
    expect(canStartFieldEvidenceUploadBatch(result, "front")).toBe(false);
    expect(canSubmitWithFieldEvidenceUploadBatch(result)).toBe(false);
    expect(hasFieldEvidenceUploadRecoveries(result)).toBe(true);
  });

  it("abandons a recovery and restores submission", () => {
    const abandoned = abandonFieldEvidenceUploadRecovery(failedState(), "front");

    expect(abandoned.recoveries).toEqual({});
    expect(canSubmitWithFieldEvidenceUploadBatch(abandoned)).toBe(true);
    expect(hasFieldEvidenceUploadRecoveries(abandoned)).toBe(false);
  });

  it("retries one recovery while preserving failures for other items", () => {
    const state = {
      ...failedState(),
      recoveries: {
        ...failedState().recoveries,
        side: recovery("side", ["side.jpg"])
      }
    };

    const retried = retryFieldEvidenceUploadBatch(state, "front", true, {
      replaceEvidenceFileId: "old-front",
      type: "REPLACE"
    });

    expect(retried.status).toBe("UPLOADING");
    expect(retried.batch).toEqual({
      baseline: snapshot([]),
      files: ["front.jpg"],
      itemViewId: "front",
      operation: {
        replaceEvidenceFileId: "old-front",
        type: "REPLACE"
      }
    });
    expect(retried.recoveries).toEqual({
      side: recovery("side", ["side.jpg"])
    });
    expect(canSubmitWithFieldEvidenceUploadBatch(retried)).toBe(false);
  });

  it("reconciles partial append success against the latest successful response", async () => {
    const result = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch(
        "damage",
        ["first.jpg", "second.jpg", "third.jpg"],
        true,
        snapshot(["existing"]),
        { type: "APPEND" }
      ),
      {
        getFailureMessage: () => "upload failed",
        getInterruptionReason: () => "FAILURE",
        refreshDetail: async () => snapshot(["existing", "committed-first", "committed-second"]),
        uploadFile: async (file) => {
          if (file === "second.jpg") {
            throw new Error("response lost");
          }
          return snapshot(["existing", "committed-first"]);
        }
      }
    );

    expect(result.status).toBe("IDLE");
    expect(result.recoveries.damage?.files).toEqual(["third.jpg"]);
    expect(
      result.recoveries.damage
        ? buildFieldEvidenceUploadRetryDisplay(
            result.recoveries.damage.itemViewId,
            result.recoveries.damage.files.map((name) => ({
              name,
              size: name.length
            }))
          )
        : null
    ).toMatchObject({
      fileCount: 1,
      fileIndex: 1,
      fileName: "third.jpg",
      phase: "RETRY_PENDING"
    });
  });

  it("distinguishes committed and uncommitted singleton replacement IDs", async () => {
    const committed = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch("single", ["replacement.jpg"], false, snapshot(["old-id"]), {
        replaceEvidenceFileId: "old-id",
        type: "REPLACE"
      }),
      {
        getFailureMessage: () => "upload failed",
        getInterruptionReason: () => "FAILURE",
        refreshDetail: async () => snapshot(["new-id"]),
        uploadFile: async () => {
          throw new Error("response lost");
        }
      }
    );
    const uncommitted = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch("single", ["replacement.jpg"], false, snapshot(["old-id"]), {
        replaceEvidenceFileId: "old-id",
        type: "REPLACE"
      }),
      {
        getFailureMessage: () => "upload failed",
        getInterruptionReason: () => "FAILURE",
        refreshDetail: async () => snapshot(["old-id"]),
        uploadFile: async () => {
          throw new Error("request rejected");
        }
      }
    );

    expect(committed).toEqual({
      batch: null,
      fileIndex: 0,
      recoveries: {},
      status: "IDLE"
    });
    expect(uncommitted.status).toBe("IDLE");
    expect(uncommitted.recoveries.single?.files).toEqual(["replacement.jpg"]);
  });

  it("does not treat an append snapshot decrease as a committed upload", async () => {
    const result = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch(
        "damage",
        ["first.jpg", "second.jpg"],
        true,
        snapshot(["old-id"]),
        { type: "APPEND" }
      ),
      {
        getFailureMessage: () => "upload failed",
        getInterruptionReason: () => "FAILURE",
        refreshDetail: async () => snapshot([]),
        uploadFile: async () => {
          throw new Error("response lost while another file was deleted");
        }
      }
    );

    expect(result.status).toBe("IDLE");
    expect(result.recoveries.damage?.files).toEqual(["first.jpg", "second.jpg"]);
    expect(result.recoveries.damage?.operation).toEqual({ type: "APPEND" });
  });

  it("does not treat an empty replacement snapshot as a committed upload", async () => {
    const result = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch("single", ["replacement.jpg"], false, snapshot(["old-id"]), {
        replaceEvidenceFileId: "old-id",
        type: "REPLACE"
      }),
      {
        getFailureMessage: () => "upload failed",
        getInterruptionReason: () => "FAILURE",
        refreshDetail: async () => snapshot([]),
        uploadFile: async () => {
          throw new Error("response lost while old evidence was deleted");
        }
      }
    );

    expect(result.status).toBe("IDLE");
    expect(result.recoveries.single?.files).toEqual(["replacement.jpg"]);
    expect(result.recoveries.single?.operation).toEqual({
      replaceEvidenceFileId: "old-id",
      type: "REPLACE"
    });

    const retried = retryFieldEvidenceUploadBatch(result, "single", true, { type: "APPEND" });
    expect(retried.batch?.operation).toEqual({ type: "APPEND" });
  });

  it("retains the barrier and uncertain queue until refresh succeeds", async () => {
    const initial = startFieldEvidenceUploadBatch(
      "damage",
      ["first.jpg", "second.jpg"],
      true,
      snapshot(["existing"]),
      { type: "APPEND" }
    );
    const failed = await runFieldEvidenceUploadBatch(initial, {
      getFailureMessage: () => "upload failed",
      getInterruptionReason: () => "FAILURE",
      refreshDetail: async () => null,
      uploadFile: async () => {
        throw new Error("network failed");
      }
    });

    expect(failed.status).toBe("REFRESH_FAILED");
    expect(failed.batch?.files).toEqual(["first.jpg", "second.jpg"]);
    expect(canSubmitWithFieldEvidenceUploadBatch(failed)).toBe(false);
    expect(canStartFieldEvidenceUploadBatch(failed, "side")).toBe(false);

    const recovered = await retryFieldEvidenceUploadRefresh(failed, {
      refreshDetail: async () => snapshot(["existing", "committed-first"])
    });
    expect(recovered.status).toBe("IDLE");
    expect(recovered.batch).toBeNull();
    expect(recovered.recoveries.damage?.files).toEqual(["second.jpg"]);
  });

  it("silently refreshes after an unmount abort that was already sent", async () => {
    const refreshDetail = vi.fn(async () => snapshot([]));
    const onUploadInterrupted = vi.fn();
    const result = await runFieldEvidenceUploadBatch(
      startFieldEvidenceUploadBatch("single", ["first.jpg"], false, snapshot([]), {
        type: "APPEND"
      }),
      {
        getFailureMessage: () => "upload interrupted",
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
    expect(result.status).toBe("IDLE");
    expect(result.recoveries.single?.files).toEqual(["first.jpg"]);
  });

  it("sets the cancellation reason before aborting the active controller", () => {
    const controller = new AbortController();
    const reasons: string[] = [];

    expect(cancelFieldEvidenceUploadRequest(controller, (reason) => reasons.push(reason))).toBe(
      true
    );
    expect(reasons).toEqual(["USER_CANCEL"]);
    expect(controller.signal.aborted).toBe(true);
  });
});

function snapshot(ids: string[]): FieldEvidenceUploadSnapshot {
  return { count: ids.length, ids };
}

function recovery(itemViewId: string, files: string[]) {
  return {
    baseline: snapshot([]),
    errorMessage: "upload failed",
    files,
    itemViewId,
    operation: { type: "APPEND" as const }
  };
}

function failedState() {
  return {
    batch: null,
    fileIndex: 0,
    recoveries: {
      front: recovery("front", ["front.jpg"])
    },
    status: "IDLE" as const
  };
}
