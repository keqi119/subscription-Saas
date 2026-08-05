import {
  ContractSegmentStatus,
  ContractSegmentType,
  ContractStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { ContractSegmentService } from "../src/subscription-change/contract-segment.service";

const BASE_START = date("2026-03-03");
const BASE_END = date("2026-09-02");

describe("ContractSegmentService", () => {
  it("bootstraps one idempotent BASE segment from archived contract facts", async () => {
    const harness = createHarness();

    await expect(harness.service.ensureBaseSegment("order-1", "actor-1")).resolves.toMatchObject({
      segmentType: ContractSegmentType.BASE,
      sequenceNo: 1,
      startDate: BASE_START,
      endDate: BASE_END
    });
    await harness.service.ensureBaseSegment("order-1", "actor-1");

    expect(harness.tx.subscriptionContractSegment.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.subscriptionContractSegment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contractSnapshot: { archivedDocument: "main-contract.pdf" },
        createdBy: "actor-1",
        monthlyFeeAmount: 1_000n,
        orderId: "order-1",
        planSnapshot: { subscriptionPlan: { planNo: "PLAN-1" } },
        quoteSnapshot: { quoteNo: "QUOTE-1" },
        segmentType: ContractSegmentType.BASE,
        sequenceNo: 1,
        sourceContractId: "contract-1",
        status: ContractSegmentStatus.ACTIVE
      })
    });
  });

  it("falls back to the original order end date before BASE bootstrap", async () => {
    const harness = createHarness();

    await expect(
      harness.service.resolveEffectiveServiceEndDate("order-1")
    ).resolves.toEqual(BASE_END);
  });

  it("rejects BASE bootstrap when original dates are missing", async () => {
    const harness = createHarness({ order: { endDate: null } });

    await expect(harness.service.ensureBaseSegment("order-1")).rejects.toMatchObject({
      code: "BASE_SEGMENT_SOURCE_INCOMPLETE"
    });
  });

  it("rejects BASE bootstrap when the main contract is not archived", async () => {
    const harness = createHarness({
      order: { contract: { status: ContractStatus.SIGNED } }
    });

    await expect(harness.service.ensureBaseSegment("order-1")).rejects.toMatchObject({
      code: "BASE_SEGMENT_SOURCE_INCOMPLETE"
    });
  });

  it("rejects BASE bootstrap when the final plan snapshot is incomplete", async () => {
    const harness = createHarness({ order: { finalPlanSnapshot: null } });

    await expect(harness.service.ensureBaseSegment("order-1")).rejects.toMatchObject({
      code: "BASE_SEGMENT_SOURCE_INCOMPLETE"
    });
  });

  it("requires an extension to start on the day after the current last segment", async () => {
    const harness = createHarness({ existingBase: true });

    await expect(
      harness.service.assertAppendableExtension(
        "segment-base",
        date("2026-09-04"),
        date("2027-03-03")
      )
    ).rejects.toMatchObject({ code: "CONTRACT_SEGMENT_NOT_CONTIGUOUS" });

    await expect(
      harness.service.assertAppendableExtension(
        "segment-base",
        date("2026-09-02"),
        date("2027-03-01")
      )
    ).rejects.toMatchObject({ code: "CONTRACT_SEGMENT_OVERLAP" });
  });

  it("accepts a non-overlapping extension adjacent to the current last segment", async () => {
    const harness = createHarness({ existingBase: true });

    await expect(
      harness.service.assertAppendableExtension(
        "segment-base",
        date("2026-09-03"),
        date("2027-03-02")
      )
    ).resolves.toBeUndefined();
  });

  it("resolves immutable terms for the segment containing a billing period start", async () => {
    const harness = createHarness({ existingBase: true });

    await expect(
      harness.service.resolveSegmentForPeriod("order-1", date("2026-08-02"))
    ).resolves.toEqual({
      endDate: BASE_END,
      mileageLimitKm: 1_500,
      monthlyFeeAmount: 1_000n,
      overMileageFeeAmount: 100n,
      planSnapshot: { subscriptionPlan: { planNo: "PLAN-1" } },
      segmentId: "segment-base",
      startDate: BASE_START
    });
  });

  it("rejects a billing period that crosses into the next contract segment", async () => {
    const harness = createHarness({ existingBase: true, existingExtension: true });

    await expect(
      harness.service.resolveSegmentForPeriod(
        "order-1",
        date("2026-08-10"),
        { periodEnd: date("2026-09-09") }
      )
    ).rejects.toMatchObject({
      code: "BILLING_PERIOD_CROSSES_SEGMENT",
      context: {
        changeOrderId: "change-extension",
        segmentId: "segment-base"
      }
    });
  });
});

function createHarness(options?: {
  existingBase?: boolean;
  existingExtension?: boolean;
  order?: Record<string, unknown>;
}) {
  const base = {
    activatedAt: BASE_START,
    cancelledAt: null,
    completedAt: null,
    contractSnapshot: { archivedDocument: "main-contract.pdf" },
    createdAt: new Date("2026-03-03T00:00:00.000Z"),
    createdBy: "actor-1",
    endDate: BASE_END,
    energyLimitCount: null,
    energyLimitKwh: 100,
    id: "segment-base",
    mileageLimitKm: 1_500,
    monthlyFeeAmount: 1_000n,
    orderId: "order-1",
    overMileageFeeAmount: 100n,
    planSnapshot: { subscriptionPlan: { planNo: "PLAN-1" } },
    productId: "product-1",
    productVersionId: "version-1",
    quoteSnapshot: { quoteNo: "QUOTE-1" },
    segmentNo: "SEG-BASE-1",
    segmentType: ContractSegmentType.BASE,
    sequenceNo: 1,
    sourceChangeOrderId: null,
    sourceContractId: "contract-1",
    startDate: BASE_START,
    status: ContractSegmentStatus.ACTIVE,
    subscriptionPlanId: "plan-1"
  };
  const extension = {
    ...base,
    endDate: date("2027-03-02"),
    id: "segment-extension",
    monthlyFeeAmount: 1_200n,
    segmentNo: "SEG-EXTENSION-1",
    segmentType: ContractSegmentType.EXTENSION,
    sequenceNo: 2,
    sourceChangeOrderId: "change-extension",
    sourceContractId: "contract-extension",
    startDate: date("2026-09-03"),
    status: ContractSegmentStatus.SCHEDULED
  };
  let storedBase = options?.existingBase ? base : null;
  const order = deepMerge(
    {
      contract: {
        contractSnapshot: { archivedDocument: "main-contract.pdf" },
        id: "contract-1",
        status: ContractStatus.ARCHIVED
      },
      endDate: BASE_END,
      energyLimitCount: null,
      energyLimitKwh: 100,
      finalPlanSnapshot: { subscriptionPlan: { planNo: "PLAN-1" } },
      id: "order-1",
      mileageLimitKm: 1_500,
      monthlyFeeAmount: 1_000n,
      overMileageFeeAmount: 100n,
      productId: "product-1",
      productVersionId: "version-1",
      quoteSnapshot: { quoteNo: "QUOTE-1" },
      startDate: BASE_START
    },
    options?.order ?? {}
  );
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "order-1" }]),
    subscriptionContractSegment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        storedBase = { ...base, ...data } as typeof base;
        return storedBase;
      }),
      findFirst: vi.fn(async (args: Record<string, unknown>) => {
        const where = args.where as Record<string, unknown> | undefined;
        if (isRecord(where?.id) && "not" in where.id) return null;
        if (where?.startDate || where?.endDate) {
          const startDate = where?.startDate as { gt?: Date; lte?: Date } | undefined;
          if (startDate?.gt && options?.existingExtension) return extension;
          return storedBase;
        }
        return storedBase;
      }),
      findUnique: vi.fn(async () => storedBase)
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => order)
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    subscriptionContractSegment: tx.subscriptionContractSegment,
    subscriptionOrder: tx.subscriptionOrder
  };

  return {
    service: new ContractSegmentService(prisma as never),
    tx
  };
}

function date(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>) {
  const merged = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    merged[key] =
      isRecord(value) && isRecord(merged[key])
        ? deepMerge(merged[key], value)
        : value;
  }
  return merged as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
