import { SubscriptionAutomationJobType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionChangeJobService } from "../src/subscription-change/subscription-change-job.service";

describe("SubscriptionChangeJobService recovery assessment dispatch", () => {
  it("supports the D+7 job and passes only its immutable server-owned boundary", async () => {
    const recovery = { assessRecoveryJob: vi.fn(async () => ({ action: "ASSESSED" })) };
    const service = new SubscriptionChangeJobService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      recovery as never
    );
    const job = {
      billId: "10000000-0000-4000-8000-000000000002",
      id: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "closure-recovery-assessment:case:D7",
      jobType: SubscriptionAutomationJobType.CLOSURE_RECOVERY_ASSESSMENT_D7,
      orderId: "10000000-0000-4000-8000-000000000003",
      payload: {
        actorId: "10000000-0000-4000-8000-000000000004",
        authoritySnapshot: { forged: true },
        authoritySnapshotHash: "f".repeat(64),
        billId: "10000000-0000-4000-8000-000000000002",
        closureCaseId: "10000000-0000-4000-8000-000000000005",
        dueDate: "2026-09-01T00:00:00.000Z",
        snapshotVersion: 1
      }
    } as never;

    expect(service.supportedJobTypes).toContain(
      SubscriptionAutomationJobType.CLOSURE_RECOVERY_ASSESSMENT_D7
    );
    await expect(service.handle(job)).resolves.toEqual({ action: "ASSESSED" });
    expect(recovery.assessRecoveryJob).toHaveBeenCalledWith({
      actorId: "10000000-0000-4000-8000-000000000004",
      closureCaseId: "10000000-0000-4000-8000-000000000005",
      governingBillId: "10000000-0000-4000-8000-000000000002",
      governingDueDate: new Date("2026-09-01T00:00:00.000Z"),
      jobId: "10000000-0000-4000-8000-000000000001",
      jobKey: "closure-recovery-assessment:case:D7",
      orderId: "10000000-0000-4000-8000-000000000003"
    });
  });

  it("dispatches the durable return-manifest e-sign job with only its persisted authority", async () => {
    const recovery = { assessRecoveryJob: vi.fn() };
    const returnManifest = {
      reconcile: vi.fn(async () => ({
        signUrl: "https://sign.test/manifest",
        taskId: "task",
        wrote: true
      }))
    };
    const service = new SubscriptionChangeJobService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      recovery as never,
      returnManifest as never
    );
    const job = {
      id: "20000000-0000-4000-8000-000000000001",
      idempotencyKey: "closure-return-manifest-esign:20000000-0000-4000-8000-000000000002",
      jobType: SubscriptionAutomationJobType.CLOSURE_RETURN_MANIFEST_ESIGN,
      orderId: "20000000-0000-4000-8000-000000000003",
      payload: {
        actorId: "20000000-0000-4000-8000-000000000004",
        closureCaseId: "20000000-0000-4000-8000-000000000005",
        generatedRevisionId: "20000000-0000-4000-8000-000000000002",
        ignoredClientHash: "f".repeat(64)
      }
    } as never;

    expect(service.supportedJobTypes).toContain(
      SubscriptionAutomationJobType.CLOSURE_RETURN_MANIFEST_ESIGN
    );
    await expect(service.handle(job)).resolves.toEqual({
      signUrl: "https://sign.test/manifest",
      taskId: "task",
      wrote: true
    });
    expect(returnManifest.reconcile).toHaveBeenCalledWith({
      actorId: "20000000-0000-4000-8000-000000000004",
      closureCaseId: "20000000-0000-4000-8000-000000000005",
      idempotencyKey: "20000000-0000-4000-8000-000000000002"
    });
  });
});
