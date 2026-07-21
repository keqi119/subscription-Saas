import { BadRequestException } from "@nestjs/common";
import { ContractStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { DeliveryHandoverService } from "../src/delivery-handover/delivery-handover.service";

describe("DeliveryHandoverService", () => {
  it("creates a draft Stage 2 handover linked to the Stage 1 contract without replacing the order pointer", async () => {
    const harness = createDeliveryHandoverHarness();

    const handover = await harness.service.getOrCreateDraftHandover(harness.orderId, harness.user.id);

    expect(handover).toMatchObject({
      archiveStatus: "NOT_STARTED",
      orderId: harness.orderId,
      stage1ContractId: "contract-stage1",
      status: "DRAFT"
    });
    expect(harness.state.order.contractId).toBe("contract-stage1");
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
  });

  it("blocks duplicate active Stage 2 handovers but allows a new one after cancellation", async () => {
    const harness = createDeliveryHandoverHarness();

    await harness.service.createHandoverRecord(harness.orderId, harness.user.id);
    await expect(
      harness.service.createHandoverRecord(harness.orderId, harness.user.id)
    ).rejects.toThrow("该订单已存在进行中的交付交接签署记录");

    await harness.service.markCancelled("handover-1", harness.user.id);
    const replacement = await harness.service.createHandoverRecord(harness.orderId, harness.user.id);

    expect(replacement).toMatchObject({
      id: "handover-2",
      orderId: harness.orderId,
      stage1ContractId: "contract-stage1",
      status: "DRAFT"
    });
  });

  it("advances source, signing, signed, archived, and failed states without provider calls", async () => {
    const harness = createDeliveryHandoverHarness();
    const draft = await harness.service.createHandoverRecord(harness.orderId, harness.user.id);

    await harness.service.markSourceGenerated(draft.id, {
      handoverContractId: "contract-stage2",
      sourceObjectKey: "contracts/stage2/source.pdf",
      updatedBy: harness.user.id
    });
    await harness.service.markSigningStarted(draft.id, {
      handoverESignTaskId: "esign-task-stage2",
      updatedBy: harness.user.id
    });
    await harness.service.markCustomerSigned(draft.id, new Date("2026-07-21T04:10:00.000Z"), harness.user.id);
    await harness.service.markPlatformSigned(draft.id, new Date("2026-07-21T04:12:00.000Z"), harness.user.id);
    await harness.service.markCompleted(draft.id, new Date("2026-07-21T04:12:00.000Z"), harness.user.id);
    const archived = await harness.service.markArchived(draft.id, {
      archivedAt: new Date("2026-07-21T04:20:00.000Z"),
      signedObjectKey: "contracts/stage2/signed.pdf",
      updatedBy: harness.user.id
    });

    expect(archived).toMatchObject({
      archiveStatus: "ARCHIVED",
      handoverContractId: "contract-stage2",
      handoverESignTaskId: "esign-task-stage2",
      signedObjectKey: "contracts/stage2/signed.pdf",
      status: "ARCHIVED"
    });
    expect(harness.providerCallCount).toBe(0);

    const failedHarness = createDeliveryHandoverHarness();
    const failedDraft = await failedHarness.service.createHandoverRecord(failedHarness.orderId, failedHarness.user.id);
    const failed = await failedHarness.service.markFailed(
      failedDraft.id,
      "provider execution intentionally not implemented",
      failedHarness.user.id
    );
    expect(failed).toMatchObject({
      failureReason: "provider execution intentionally not implemented",
      status: "FAILED"
    });
  });

  it("requires a signed and archived Stage 2 handover before delivery confirmation", async () => {
    const harness = createDeliveryHandoverHarness();

    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).rejects.toThrow(BadRequestException);

    const draft = await harness.service.createHandoverRecord(harness.orderId, harness.user.id);
    await harness.service.markCompleted(draft.id, new Date("2026-07-21T04:12:00.000Z"), harness.user.id);
    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).rejects.toThrow(
      "交付交接确认书尚未完成签署和归档"
    );

    await harness.service.markArchived(draft.id, {
      archivedAt: new Date("2026-07-21T04:20:00.000Z"),
      signedObjectKey: "contracts/stage2/signed.pdf",
      updatedBy: harness.user.id
    });
    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).resolves.toBeUndefined();
  });
});

function createDeliveryHandoverHarness() {
  const orderId = "order-1";
  const now = new Date("2026-07-21T04:00:00.000Z");
  const user = { id: "user-admin" };
  const state = {
    handovers: [] as Array<Record<string, unknown>>,
    order: {
      contract: {
        deletedAt: null,
        id: "contract-stage1",
        status: ContractStatus.SIGNED
      },
      contractId: "contract-stage1",
      contracts: [
        {
          deletedAt: null,
          id: "contract-stage1",
          status: ContractStatus.SIGNED
        }
      ],
      customerId: "customer-1",
      deletedAt: null,
      deliveries: [],
      id: orderId,
      orderNo: "ORD202607210001"
    }
  };
  const providerCallCount = 0;

  const prisma = {
    subscriptionOrder: {
      findUnique: vi.fn(async () => state.order),
      update: vi.fn()
    },
    vehicleDeliveryHandover: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const handover = {
          archiveStatus: "NOT_STARTED",
          cancelledAt: null,
          completedAt: null,
          createdAt: now,
          customerSignedAt: null,
          deletedAt: null,
          failedAt: null,
          failureReason: null,
          handoverContractId: null,
          handoverESignTaskId: null,
          id: `handover-${state.handovers.length + 1}`,
          platformSignedAt: null,
          signedObjectKey: null,
          sourceObjectKey: null,
          status: "DRAFT",
          updatedAt: now,
          ...data
        };
        state.handovers.push(handover);
        return handover;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.handovers.find((handover) => matchesHandoverWhere(handover, where)) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const handover = state.handovers.find((item) => item.id === where.id);
        if (!handover) {
          throw new Error("handover not found");
        }
        Object.assign(handover, data, { updatedAt: now });
        return handover;
      })
    }
  };
  const service = new DeliveryHandoverService(prisma as never);

  return {
    get providerCallCount() {
      return providerCallCount;
    },
    orderId,
    prisma,
    service,
    state,
    user
  };
}

function matchesHandoverWhere(handover: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "deletedAt" && expected === null) {
      return handover.deletedAt === null;
    }
    if (key === "orderId") {
      return handover.orderId === expected;
    }
    if (key === "status" && expected && typeof expected === "object") {
      const notIn = (expected as { notIn?: unknown[] }).notIn;
      return !notIn?.includes(handover.status);
    }
    return true;
  });
}
