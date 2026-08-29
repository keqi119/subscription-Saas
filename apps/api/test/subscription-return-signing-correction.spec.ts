import { ESignTaskStatus, SubscriptionClosureStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionReturnGovernanceService } from "../src/subscription-closure/subscription-return-governance.service";

describe("return-manifest signing correction", () => {
  it("cancels an unfinished task, invalidates its signer links, and exactly replays", async () => {
    const harness = correctionHarness(ESignTaskStatus.WAITING_CUSTOMER);

    await expect(
      harness.service.cancelReturnManifestSigning(
        harness.closureCaseId,
        { idempotencyKey: "cancel-attempt-1", reason: "现场清单里程需要更正" },
        harness.actorId
      )
    ).resolves.toMatchObject({ replayed: false, taskId: harness.task.id });
    expect(harness.task).toMatchObject({
      deletedAt: expect.any(Date),
      signUrl: null,
      signUrlExpiresAt: null,
      taskStatus: ESignTaskStatus.CANCELLED,
      updatedBy: harness.actorId
    });
    expect(harness.signerUpdate).toHaveBeenCalledWith({
      data: { deletedAt: expect.any(Date), updatedAt: expect.any(Date) },
      where: { deletedAt: null, taskId: harness.task.id }
    });
    expect(harness.jobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jobStatus: "COMPLETED" }),
        where: expect.objectContaining({
          payload: { equals: harness.closureCaseId, path: ["closureCaseId"] }
        })
      })
    );
    expect(harness.auditCreate).toHaveBeenCalledTimes(1);

    await expect(
      harness.service.cancelReturnManifestSigning(
        harness.closureCaseId,
        { idempotencyKey: "cancel-attempt-1", reason: "现场清单里程需要更正" },
        harness.actorId
      )
    ).resolves.toMatchObject({ replayed: true, taskId: harness.task.id });
    expect(harness.auditCreate).toHaveBeenCalledTimes(1);
  });

  it("preserves a completed signed task as immutable evidence", async () => {
    const harness = correctionHarness(ESignTaskStatus.COMPLETED);
    harness.task.completedAt = new Date("2026-08-29T00:01:00.000Z");

    await expect(
      harness.service.cancelReturnManifestSigning(
        harness.closureCaseId,
        { idempotencyKey: "cancel-completed", reason: "try to replace signed evidence" },
        harness.actorId
      )
    ).rejects.toMatchObject({
      response: {
        code: "RETURN_MANIFEST_SIGNING_ALREADY_COMPLETED",
        message: expect.stringContaining("继续确认车辆取回")
      },
      status: 409
    });
    expect(harness.auditCreate).not.toHaveBeenCalled();
  });

  it("confirms provider cancellation before retiring a started signing task", async () => {
    const harness = correctionHarness(ESignTaskStatus.WAITING_CUSTOMER, true);

    await expect(
      harness.service.cancelReturnManifestSigning(
        harness.closureCaseId,
        { idempotencyKey: "cancel-provider-attempt", reason: "清单需要更正" },
        harness.actorId
      )
    ).resolves.toMatchObject({ replayed: false, taskId: harness.task.id });
    expect(harness.providerCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEnvelopeId: "provider-envelope-1",
        providerTaskId: "provider-task-1",
        taskId: harness.task.id
      })
    );
    expect(harness.task).toMatchObject({ taskStatus: ESignTaskStatus.CANCELLED });
  });
});

function correctionHarness(taskStatus: ESignTaskStatus, started = false) {
  const closureCaseId = "10000000-0000-4000-8000-000000000001";
  const actorId = "10000000-0000-4000-8000-000000000002";
  const task: Record<string, unknown> & {
    cancelledAt: Date | null;
    completedAt: Date | null;
    deletedAt: Date | null;
    errorSnapshot: Record<string, unknown> | null;
    id: string;
    taskStatus: ESignTaskStatus;
  } = {
    cancelledAt: null,
    completedAt: null,
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    deletedAt: null,
    errorSnapshot: null,
    id: "10000000-0000-4000-8000-000000000003",
    providerEnvelopeId: started ? "provider-envelope-1" : null,
    providerTaskId: started ? "provider-task-1" : null,
    signUrl: "https://sign.test/current",
    signUrlExpiresAt: new Date("2026-08-30T00:00:00.000Z"),
    signers: [{ id: "10000000-0000-4000-8000-000000000004" }],
    sourceId: closureCaseId,
    sourceKey: "return-manifest-esign",
    sourceType: "SUBSCRIPTION_CLOSURE_ESIGN",
    taskStatus,
    updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    updatedBy: actorId
  };
  const signerUpdate = vi.fn(async () => ({ count: 1 }));
  const jobUpdate = vi.fn(async () => ({ count: 1 }));
  const auditCreate = vi.fn(async () => ({}));
  const providerCancel = vi.fn(async () => ({ cancelled: true, rawResponse: { ok: true } }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: closureCaseId }]),
    auditLog: { create: auditCreate },
    contractESignSigner: { updateMany: signerUpdate },
    contractESignTask: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.deletedAt === null) return task.deletedAt === null ? task : null;
        return task.deletedAt !== null && task.taskStatus === ESignTaskStatus.CANCELLED ? task : null;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(task, data);
        return task;
      })
    },
    subscriptionAutomationJob: { updateMany: jobUpdate },
    subscriptionClosureCase: {
      findUnique: vi.fn(async () => ({
        id: closureCaseId,
        orderId: "10000000-0000-4000-8000-000000000005",
        retiredAt: null,
        status: SubscriptionClosureStatus.PREPARING_RETURN
      }))
    }
  };
  const prisma = {
    contractESignTask: {
      findFirst: vi.fn(async () => (task.deletedAt === null ? task : null))
    },
    subscriptionClosureCase: {
      findUnique: vi.fn(async () => ({
        id: closureCaseId,
        retiredAt: null,
        status: SubscriptionClosureStatus.PREPARING_RETURN
      }))
    },
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx))
  };
  return {
    actorId,
    auditCreate,
    closureCaseId,
    jobUpdate,
    providerCancel,
    service: new SubscriptionReturnGovernanceService(
      prisma as never,
      {} as never,
      undefined,
      { cancelReturnManifestTask: providerCancel } as never
    ),
    signerUpdate,
    task
  };
}
