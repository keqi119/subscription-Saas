import { afterEach, describe, expect, it, vi } from "vitest";

import * as adminStage2Module from "../src/lib/admin-stage2-handover-esign";
import * as fieldApiModule from "../src/lib/field-handover-api";
import {
  buildFieldStage2HandoverView
} from "../src/lib/field-handover-view-model";
import * as portalWorkflowModule from "../src/lib/portal-handover-review-view-model";

afterEach(() => {
  vi.useRealTimers();
});

describe("Portal Stage 2 workflow request controller", () => {
  it("serializes polling, fences invalidated responses, and stops updates after disposal", async () => {
    vi.useFakeTimers();
    const first = deferred<{ canStartSigning: boolean; statusLabel: string }>();
    const second = deferred<{ canStartSigning: boolean; statusLabel: string }>();
    const load = vi
      .fn<() => Promise<{ canStartSigning: boolean; statusLabel: string }>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onApply = vi.fn();
    const factory = (
      portalWorkflowModule as Record<string, unknown>
    ).createPortalWorkflowRequestController;

    expect(factory).toBeTypeOf("function");
    if (typeof factory !== "function") {
      return;
    }

    const controller = factory({ load, onApply, onError: vi.fn() }) as {
      dispose(): void;
      invalidate(): void;
      refresh(): Promise<void>;
      startPolling(intervalMs: number): void;
    };
    const firstRefresh = controller.refresh();
    controller.startPolling(3_000);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(load).toHaveBeenCalledTimes(1);

    controller.invalidate();
    first.resolve({
      canStartSigning: true,
      statusLabel: "待客户签署"
    });
    await firstRefresh;
    expect(onApply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(2);
    second.resolve({
      canStartSigning: false,
      statusLabel: "签署已完成"
    });
    await vi.runAllTicks();
    expect(onApply).toHaveBeenLastCalledWith({
      canStartSigning: false,
      statusLabel: "签署已完成"
    });

    controller.dispose();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not apply an in-flight response that resolves after disposal", async () => {
    const pending = deferred<{
      canStartSigning: boolean;
      statusLabel: string;
    }>();
    const onApply = vi.fn();
    const onError = vi.fn();
    const controller =
      portalWorkflowModule.createPortalWorkflowRequestController({
        load: vi.fn(() => pending.promise),
        onApply,
        onError
      });

    const refresh = controller.refresh();
    controller.dispose();
    pending.resolve({
      canStartSigning: false,
      statusLabel: "签署已完成"
    });
    await refresh;

    expect(onApply).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("Field Stage 2 interaction controller", () => {
  it("requires explicit server capabilities instead of inferring missing booleans", () => {
    const detail = {
      stage2Pdf: {
        artifactVersion: 1,
        downloadUrl: "/api/field/handover/work-orders/work-1/pdf/download",
        previewUrl: "/api/field/handover/work-orders/work-1/pdf/preview",
        sourcePdfHash: "b".repeat(64),
        status: "GENERATED"
      },
      status: "CUSTOMER_CONFIRMED"
    } as never;

    expect(buildFieldStage2HandoverView(detail)).toMatchObject({
      canDownload: false,
      canPreview: false,
      canStartESign: false
    });
    expect(buildFieldStage2HandoverView({
      ...detail,
      stage2Capabilities: {
        canDownload: true,
        canPreview: true,
        canStartESign: true
      }
    })).toMatchObject({
      canDownload: true,
      canPreview: true,
      canStartESign: true
    });
  });

  it("blocks unacknowledged submit, coalesces duplicate clicks, and permits retry after failure", async () => {
    const first = deferred<{ taskId: string }>();
    const submit = vi
      .fn<() => Promise<{ taskId: string }>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ taskId: "stage2-task-retry" });
    const factory = (
      fieldApiModule as Record<string, unknown>
    ).createFieldESignSubmissionController;

    expect(factory).toBeTypeOf("function");
    if (typeof factory !== "function") {
      return;
    }

    const controller = factory({ submit }) as {
      submit(input: {
        acknowledgement: boolean;
        artifactVersion: number;
        sourcePdfHash: string;
      }): Promise<unknown> | null;
    };
    const input = {
      acknowledgement: true,
      artifactVersion: 1,
      sourcePdfHash: "b".repeat(64)
    };

    expect(controller.submit({ ...input, acknowledgement: false })).toBeNull();
    const firstAttempt = controller.submit(input);
    const duplicateAttempt = controller.submit(input);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(duplicateAttempt).toBe(firstAttempt);

    first.reject(new Error("temporary failure"));
    await expect(firstAttempt).rejects.toThrow("temporary failure");
    await expect(controller.submit(input)).resolves.toEqual({
      taskId: "stage2-task-retry"
    });
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

describe("Admin Stage 2 delivery and recovery controllers", () => {
  it("fails closed on unknown/load errors and permits legacy empty only after a successful response", async () => {
    const factory = (
      adminStage2Module as Record<string, unknown>
    ).createAdminStage2DeliveryVerifier;

    expect(factory).toBeTypeOf("function");
    if (typeof factory !== "function") {
      return;
    }

    const failed = factory({
      loadESignStatus: vi.fn(),
      loadWorkOrders: vi.fn(async () => {
        throw new Error("network");
      })
    }) as { verify(orderId: string): Promise<{ allowed: boolean; reason: string }> };
    await expect(failed.verify("order-1")).resolves.toMatchObject({
      allowed: false,
      reason: "LOAD_ERROR"
    });

    const legacy = factory({
      loadESignStatus: vi.fn(),
      loadWorkOrders: vi.fn(async () => [])
    }) as { verify(orderId: string): Promise<{ allowed: boolean; reason: string }> };
    await expect(legacy.verify("order-1")).resolves.toMatchObject({
      allowed: true,
      reason: "NO_STAGE2_WORK_ORDER"
    });
  });

  it("uses the production boundary controller to recheck modal-open and immediately-before-POST", async () => {
    const loadWorkOrders = vi.fn(async () => [
      { id: "work-order-1", status: "CUSTOMER_CONFIRMED" }
    ]);
    const loadESignStatus = vi
      .fn()
      .mockResolvedValueOnce({
        customerSigner: {
          signedAt: "2026-07-27T09:00:00.000Z",
          slotId: "STAGE2_HANDOVER_CUSTOMER",
          status: "SIGNED"
        },
        documentType: "DELIVERY_HANDOVER",
        platformSigner: {
          signedAt: "2026-07-27T09:00:01.000Z",
          slotId: "STAGE2_HANDOVER_PLATFORM",
          status: "SIGNED"
        },
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        status: "COMPLETED",
        taskId: "stage2-task-1"
      })
      .mockResolvedValueOnce({
        customerSigner: {
          signedAt: "2026-07-27T09:00:00.000Z",
          slotId: "STAGE2_HANDOVER_CUSTOMER",
          status: "SIGNED"
        },
        documentType: "DELIVERY_HANDOVER",
        platformSigner: {
          signedAt: null,
          slotId: "STAGE2_HANDOVER_PLATFORM",
          status: "PENDING"
        },
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        status: "SIGNING",
        taskId: "stage2-task-1"
      })
      .mockResolvedValueOnce({
        customerSigner: {
          signedAt: "2026-07-27T09:00:00.000Z",
          slotId: "STAGE2_HANDOVER_CUSTOMER",
          status: "SIGNED"
        },
        documentType: "DELIVERY_HANDOVER",
        platformSigner: {
          signedAt: "2026-07-27T09:00:01.000Z",
          slotId: "STAGE2_HANDOVER_PLATFORM",
          status: "SIGNED"
        },
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        status: "COMPLETED",
        taskId: "stage2-task-1"
      });
    const verifierFactory = (
      adminStage2Module as Record<string, unknown>
    ).createAdminStage2DeliveryVerifier;
    const controllerFactory = (
      adminStage2Module as Record<string, unknown>
    ).createAdminStage2DeliveryConfirmationController;

    expect(verifierFactory).toBeTypeOf("function");
    expect(controllerFactory).toBeTypeOf("function");
    if (
      typeof verifierFactory !== "function" ||
      typeof controllerFactory !== "function"
    ) {
      return;
    }

    const verifier = verifierFactory({ loadESignStatus, loadWorkOrders }) as {
      verify(orderId: string): Promise<{ allowed: boolean; reason: string }>;
    };
    const onBlocked = vi.fn();
    const controller = controllerFactory({
      onBlocked,
      verifier
    }) as {
      run(input: {
        boundary: "BEFORE_POST" | "MODAL_OPEN";
        onAllowed: () => Promise<void> | void;
        orderId: string;
      }): Promise<boolean>;
    };
    const openModal = vi.fn();
    const postDelivery = vi.fn(async () => undefined);

    await expect(controller.run({
      boundary: "MODAL_OPEN",
      onAllowed: openModal,
      orderId: "order-1"
    })).resolves.toBe(true);
    expect(openModal).toHaveBeenCalledTimes(1);

    await expect(controller.run({
      boundary: "BEFORE_POST",
      onAllowed: postDelivery,
      orderId: "order-1"
    })).resolves.toBe(false);
    expect(postDelivery).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenLastCalledWith(
      { allowed: false, reason: "NOT_SIGNED" },
      "BEFORE_POST"
    );

    await expect(controller.run({
      boundary: "BEFORE_POST",
      onAllowed: postDelivery,
      orderId: "order-1"
    })).resolves.toBe(true);
    expect(postDelivery).toHaveBeenCalledTimes(1);
    expect(loadWorkOrders).toHaveBeenCalledTimes(3);
    expect(loadESignStatus).toHaveBeenCalledTimes(3);
  });

  it("fails the production delivery boundary closed when its authoritative load fails", async () => {
    const verifier =
      adminStage2Module.createAdminStage2DeliveryVerifier({
        loadESignStatus: vi.fn(),
        loadWorkOrders: vi.fn(async () => {
          throw new Error("network");
        })
      });
    const onBlocked = vi.fn();
    const factory = (
      adminStage2Module as Record<string, unknown>
    ).createAdminStage2DeliveryConfirmationController;

    expect(factory).toBeTypeOf("function");
    if (typeof factory !== "function") {
      return;
    }
    const controller = factory({ onBlocked, verifier }) as {
      run(input: {
        boundary: "BEFORE_POST" | "MODAL_OPEN";
        onAllowed: () => Promise<void> | void;
        orderId: string;
      }): Promise<boolean>;
    };
    const openModal = vi.fn();

    await expect(controller.run({
      boundary: "MODAL_OPEN",
      onAllowed: openModal,
      orderId: "order-1"
    })).resolves.toBe(false);
    expect(openModal).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledWith({
      allowed: false,
      reason: "LOAD_ERROR"
    }, "MODAL_OPEN");
  });

  it("enforces recovery permission in the executable handler", async () => {
    const execute = vi.fn(async () => undefined);
    const run = (
      adminStage2Module as Record<string, unknown>
    ).runAdminStage2WorkflowRecovery;

    expect(run).toBeTypeOf("function");
    if (typeof run !== "function") {
      return;
    }

    const recovery = {
      jobId: "workflow-job-1",
      jobType: "ARCHIVE_SIGNED_PDF",
      kind: "RETRY_JOB",
      label: "重试签署文件归档"
    };
    await expect(run({
      allowed: false,
      execute,
      recovery,
      workOrderId: "work-order-1"
    })).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();

    await expect(run({
      allowed: true,
      execute,
      recovery,
      workOrderId: "work-order-1"
    })).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith("work-order-1", recovery);
  });
});

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    reject = nextReject;
    resolve = nextResolve;
  });
  return { promise, reject, resolve };
}
