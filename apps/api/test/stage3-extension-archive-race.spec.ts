import {
  ContractSegmentStatus,
  ContractSegmentType,
  ContractStatus,
  ESignDocumentType,
  ESignSigningStage,
  ESignTaskStatus,
  RenewalConsiderationStatus,
  SubscriptionChangeStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { Stage3ExtensionArchiveService } from "../src/esign/stage3-extension-archive.service";

describe("Stage3ExtensionArchiveService deadline arbitration", () => {
  it("atomically archives the agreement and appends one scheduled extension segment", async () => {
    const harness = archiveHarness();

    const result = await harness.service.finalizeArchivedContract({
      completedAt: new Date("2026-09-02T15:59:59.000Z"),
      contractId: "contract-extension",
      source: "CALLBACK",
      taskId: "task-extension"
    });

    expect(result).toMatchObject({ outcome: "SCHEDULED", segmentId: "segment-extension" });
    expect(harness.state.segments).toHaveLength(1);
    expect(harness.state.segments[0]).toMatchObject({
      endDate: new Date("2027-03-02T00:00:00.000Z"),
      segmentType: ContractSegmentType.EXTENSION,
      sourceContractId: "contract-extension",
      sourceChangeOrderId: "change-1",
      startDate: new Date("2026-09-03T00:00:00.000Z"),
      status: ContractSegmentStatus.SCHEDULED
    });
    expect(harness.state.change.status).toBe(SubscriptionChangeStatus.SCHEDULED);
    expect(harness.state.consideration.status).toBe(RenewalConsiderationStatus.EXTENDED);
    expect(harness.state.contract.status).toBe(ContractStatus.ARCHIVED);
    expect(harness.state.order.endDate).toEqual(new Date("2026-09-02T00:00:00.000Z"));
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
    expect((harness.tx.subscriptionAutomationJob as {
      updateMany: ReturnType<typeof vi.fn>;
    }).updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { changeOrderId: "change-1" },
          { renewalConsiderationId: "consideration-1" }
        ])
      })
    }));
    expect((harness.tx.subscriptionAutomationJob as {
      upsert: ReturnType<typeof vi.fn>;
    }).upsert).toHaveBeenCalledWith({
      create: expect.objectContaining({
        availableAt: new Date("2026-09-02T16:00:00.000Z"),
        changeOrderId: "change-1",
        contractSegmentId: "segment-extension",
        idempotencyKey: "extension-activate:segment-extension:2026-09-03",
        jobType: "EXTENSION_SEGMENT_ACTIVATE",
        orderId: "order-1"
      }),
      update: {},
      where: {
        idempotencyKey: "extension-activate:segment-extension:2026-09-03"
      }
    });
  });

  it("is idempotent for duplicate and out-of-order callbacks", async () => {
    const harness = archiveHarness();
    const input = {
      completedAt: new Date("2026-09-02T15:59:59.000Z"),
      contractId: "contract-extension",
      source: "CALLBACK" as const,
      taskId: "task-extension"
    };

    await harness.service.finalizeArchivedContract(input);
    const duplicate = await harness.service.finalizeArchivedContract(input);

    expect(duplicate).toMatchObject({ outcome: "DUPLICATE", segmentId: "segment-extension" });
    expect(harness.state.segments).toHaveLength(1);
  });

  it("lets a callback completed before the deadline win", async () => {
    const harness = archiveHarness({
      databaseNow: new Date("2026-09-02T15:59:59.999Z")
    });

    await expect(harness.service.finalizeArchivedContract({
      completedAt: new Date("2026-09-02T15:59:59.999Z"),
      contractId: "contract-extension",
      source: "RECONCILE",
      taskId: "task-extension"
    })).resolves.toMatchObject({ outcome: "SCHEDULED" });
  });

  it("treats completion exactly at the deadline as late evidence only", async () => {
    const harness = archiveHarness({
      databaseNow: new Date("2026-09-02T16:00:00.000Z")
    });

    const result = await harness.service.finalizeArchivedContract({
      completedAt: new Date("2026-09-02T16:00:00.000Z"),
      contractId: "contract-extension",
      source: "CALLBACK",
      taskId: "task-extension"
    });

    expect(result).toEqual({ outcome: "LATE_EVIDENCE_ONLY" });
    expect(harness.state.segments).toHaveLength(0);
    expect(harness.state.change.status).toBe(SubscriptionChangeStatus.SIGNING_OR_PAYMENT);
    expect(harness.state.consideration.status).toBe(RenewalConsiderationStatus.EXTENSION_IN_PROGRESS);
    expect(harness.state.contract.status).toBe(ContractStatus.ARCHIVED);
  });

  it("keeps an early provider signature as late evidence when PDF archival reaches the lock after the deadline", async () => {
    const harness = archiveHarness({
      databaseNow: new Date("2026-09-02T16:00:00.001Z")
    });

    const result = await harness.service.finalizeArchivedContract({
      completedAt: new Date("2026-09-02T15:55:00.000Z"),
      contractId: "contract-extension",
      source: "RECONCILE",
      taskId: "task-extension"
    });

    expect(result).toEqual({ outcome: "LATE_EVIDENCE_ONLY" });
    expect(harness.state.segments).toHaveLength(0);
    expect(harness.state.contract).toMatchObject({
      archivedAt: new Date("2026-09-02T16:00:00.001Z"),
      signedAt: new Date("2026-09-02T15:55:00.000Z")
    });
  });

  it("lets expiry win when the expiry path acquired and committed the business state first", async () => {
    const harness = archiveHarness({
      changeStatus: SubscriptionChangeStatus.CANCELLED,
      considerationStatus: RenewalConsiderationStatus.EXPIRED
    });

    const result = await harness.service.finalizeArchivedContract({
      completedAt: new Date("2026-09-02T15:59:59.000Z"),
      contractId: "contract-extension",
      source: "CALLBACK",
      taskId: "task-extension"
    });

    expect(result).toEqual({ outcome: "LATE_EVIDENCE_ONLY" });
    expect(harness.state.segments).toHaveLength(0);
    expect(harness.state.change.status).toBe(SubscriptionChangeStatus.CANCELLED);
  });

  it("requires a completed typed Stage 3 task and a retained signed artifact", async () => {
    const harness = archiveHarness({ signedDocumentObjectKey: null });

    await expect(harness.service.finalizeArchivedContract({
      completedAt: new Date("2026-09-02T15:59:59.000Z"),
      contractId: "contract-extension",
      source: "CALLBACK",
      taskId: "task-extension"
    })).rejects.toMatchObject({ code: "STAGE3_SIGNED_ARTIFACT_REQUIRED" });
    expect(harness.state.segments).toHaveLength(0);
  });
});

interface ArchiveHarnessOptions {
  changeStatus?: SubscriptionChangeStatus;
  considerationStatus?: RenewalConsiderationStatus;
  databaseNow?: Date;
  signedDocumentObjectKey?: string | null;
}

function archiveHarness(options: ArchiveHarnessOptions = {}) {
  const state = {
    change: {
      completionDeadlineAt: new Date("2026-09-02T16:00:00.000Z"),
      confirmedQuote: {
        energyLimitCount: 2,
        energyLimitKwh: null,
        mileageLimitKm: 1_500,
        monthlyFeeAmount: 97_000n,
        overMileageFeeAmount: 100n,
        planSnapshot: { planCode: "PLAN-EXTENSION" },
        productId: "product-1",
        productVersionId: "product-version-1",
        quoteSnapshot: { quoteNo: "SCQ202608050001" },
        subscriptionPlanId: "plan-1"
      },
      contract: {
        contractSnapshot: {
          confirmedQuoteNo: "SCQ202608050001",
          extensionEndDate: "2027-03-02",
          extensionStartDate: "2026-09-03"
        },
        id: "contract-extension"
      },
      contractId: "contract-extension",
      id: "change-1",
      orderId: "order-1",
      renewalConsiderationId: "consideration-1",
      sourceSegment: {
        endDate: new Date("2026-09-02T00:00:00.000Z"),
        id: "segment-base",
        orderId: "order-1",
        sequenceNo: 1
      },
      status: options.changeStatus ?? SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
      targetEndDate: new Date("2027-03-02T00:00:00.000Z"),
      targetStartDate: new Date("2026-09-03T00:00:00.000Z"),
      version: 3
    },
    consideration: {
      id: "consideration-1",
      status: options.considerationStatus ?? RenewalConsiderationStatus.EXTENSION_IN_PROGRESS,
      version: 2
    },
    contract: {
      archivedAt: null as Date | null,
      contractSnapshot: { confirmedQuoteNo: "SCQ202608050001" },
      id: "contract-extension",
      status: ContractStatus.SIGNED
    },
    order: {
      endDate: new Date("2026-09-02T00:00:00.000Z"),
      id: "order-1"
    },
    segments: [] as Array<Record<string, unknown>>,
    task: {
      completedAt: new Date("2026-09-02T15:59:59.000Z"),
      contractId: "contract-extension",
      documentType: ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT,
      id: "task-extension",
      signedDocumentObjectKey: options.signedDocumentObjectKey === undefined
        ? "contracts/contract-extension/signed.pdf"
        : options.signedDocumentObjectKey,
      signingStage: ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION,
      taskStatus: ESignTaskStatus.COMPLETED
    }
  };

  const tx: Record<string, unknown> = {};
  Object.assign(tx, {
    $queryRaw: vi.fn(async () => [{ now: options.databaseNow ?? new Date("2026-09-02T15:59:59.000Z") }]),
    contract: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.contract, data);
        return state.contract;
      })
    },
    contractESignTask: {
      findUnique: vi.fn(async () => state.task)
    },
    renewalConsideration: {
      findUnique: vi.fn(async () => state.consideration),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.consideration, data);
        return state.consideration;
      })
    },
    renewalReminder: {
      updateMany: vi.fn(async () => ({ count: 3 }))
    },
    subscriptionAutomationJob: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        ...create,
        id: "job-activate"
      })),
      updateMany: vi.fn(async () => ({ count: 4 }))
    },
    subscriptionChangeOrder: {
      findUnique: vi.fn(async () => state.change),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.change, data);
        return state.change;
      })
    },
    subscriptionContractSegment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const segment = { ...data, id: "segment-extension" };
        state.segments.push(segment);
        return segment;
      }),
      findFirst: vi.fn(async () => state.segments[0] ?? null)
    }
  });
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    subscriptionOrder: { update: vi.fn() }
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const service = new Stage3ExtensionArchiveService(prisma as never, auditService as never);

  return { auditService, prisma, service, state, tx };
}
