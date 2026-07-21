import { BillStatus, BillType, ContractStatus, DeliveryStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { LeaseActivationEngine } from "../src/lease/lease-activation.engine";

describe("LeaseActivationEngine", () => {
  it("rejects activation when the contract is not signed", async () => {
    const harness = createLeaseActivationHarness({ contractStatus: ContractStatus.GENERATED });

    const result = await harness.engine.evaluate(harness.orderId);

    expect(result.canActivate).toBe(false);
    expect(result.missingConditions).toEqual(["CONTRACT_SIGNED"]);
  });

  it("rejects activation when deposit or first rent is not fully paid", async () => {
    const harness = createLeaseActivationHarness({
      depositBillStatus: BillStatus.PARTIALLY_PAID,
      depositRemainingAmount: 100000n,
      firstRentBillStatus: BillStatus.PENDING,
      firstRentRemainingAmount: 300000n
    });

    const result = await harness.engine.evaluate(harness.orderId);

    expect(result.canActivate).toBe(false);
    expect(result.missingConditions).toEqual(["DEPOSIT_PAID", "FIRST_RENT_PAID"]);
  });

  it("rejects activation when delivery is not confirmed", async () => {
    const harness = createLeaseActivationHarness({ deliveryStatus: DeliveryStatus.READY });

    const result = await harness.engine.evaluate(harness.orderId);

    expect(result.canActivate).toBe(false);
    expect(result.missingConditions).toEqual(["DELIVERY_CONFIRMED"]);
  });

  it("rejects activation when inspection is not passed", async () => {
    const harness = createLeaseActivationHarness({ inspectionStatus: "FAILED" });

    const result = await harness.engine.evaluate(harness.orderId);

    expect(result.canActivate).toBe(false);
    expect(result.missingConditions).toEqual(["INSPECTION_PASSED"]);
  });

  it("rejects activation when Stage 2 handover is missing", async () => {
    const harness = createLeaseActivationHarness({ handover: null });

    const result = await harness.engine.evaluate(harness.orderId);

    expect(result.canActivate).toBe(false);
    expect(result.missingConditions).toEqual(["HANDOVER_SIGNED_MISSING", "HANDOVER_ARCHIVED_MISSING"]);
  });

  it("rejects activation when Stage 2 handover is signed but not archived", async () => {
    const harness = createLeaseActivationHarness({
      handover: {
        archiveStatus: "NOT_STARTED",
        deletedAt: null,
        status: "SIGNED"
      }
    });

    const result = await harness.engine.evaluate(harness.orderId);

    expect(result.canActivate).toBe(false);
    expect(result.missingConditions).toEqual(["HANDOVER_ARCHIVED_MISSING"]);
  });

  it("allows activation when all activation conditions are satisfied", async () => {
    const harness = createLeaseActivationHarness();

    const result = await harness.engine.evaluate(harness.orderId);

    expect(result).toEqual({ canActivate: true, missingConditions: [] });
    await expect(harness.engine.canActivate(harness.orderId)).resolves.toBe(true);
  });

  it("activate persists and returns an ACTIVE lease", async () => {
    const harness = createLeaseActivationHarness();

    const lease = await harness.engine.activate(harness.orderId, harness.user, harness.context);

    expect(lease).toMatchObject({
      activatedAt: "2026-06-30T06:30:00.000Z",
      orderId: harness.orderId,
      status: "ACTIVE"
    });
    expect(harness.prisma.lease.create).toHaveBeenCalledTimes(1);
    expect(harness.auditService.write).toHaveBeenCalledWith(expect.objectContaining({
      action: "CREATE",
      entityId: "lease-1",
      entityType: "lease",
      module: "lease"
    }));
  });
});

function createLeaseActivationHarness(overrides: Partial<LeaseActivationState> = {}) {
  const now = new Date("2026-06-30T06:30:00.000Z");
  const orderId = "order-1";
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: ["ADMIN"],
    username: "admin"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const state: LeaseActivationState = {
    contractStatus: ContractStatus.SIGNED,
    depositBillStatus: BillStatus.PAID,
    depositRemainingAmount: 0n,
    deliveryStatus: DeliveryStatus.DELIVERED,
    firstRentBillStatus: BillStatus.PAID,
    firstRentRemainingAmount: 0n,
    handover: {
      archiveStatus: "ARCHIVED",
      deletedAt: null,
      status: "ARCHIVED"
    },
    inspectionStatus: "PASSED",
    lease: null,
    ...overrides
  };

  function buildOrder() {
    return {
      contract: {
        deletedAt: null,
        id: "contract-1",
        status: state.contractStatus
      },
      contractId: "contract-1",
      customerId: "customer-1",
      deletedAt: null,
      id: orderId,
      orderNo: "ORD202606300001"
    };
  }

  function buildBills() {
    return [
      {
        billStatus: state.depositBillStatus,
        billType: BillType.DEPOSIT,
        deletedAt: null,
        id: "deposit-bill-1",
        remainingAmount: state.depositRemainingAmount
      },
      {
        billStatus: state.firstRentBillStatus,
        billType: BillType.FIRST_MONTHLY_FEE,
        deletedAt: null,
        id: "first-rent-bill-1",
        remainingAmount: state.firstRentRemainingAmount
      }
    ];
  }

  const prisma = {
    lease: {
      create: vi.fn(async ({ data }) => {
        state.lease = {
          activatedAt: data.activatedAt,
          createdAt: now,
          id: "lease-1",
          orderId: data.orderId,
          status: data.status,
          updatedAt: now
        };
        return state.lease;
      }),
      findUnique: vi.fn(async () => state.lease)
    },
    receivableBill: {
      findMany: vi.fn(async () => buildBills())
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => buildOrder())
    },
    vehicleDelivery: {
      findUnique: vi.fn(async () => ({
        deletedAt: null,
        deliveredAt: state.deliveryStatus === DeliveryStatus.DELIVERED ? now : null,
        deliveryStatus: state.deliveryStatus,
        id: "delivery-1",
        orderId
      }))
    },
    vehicleDeliveryHandover: {
      findFirst: vi.fn(async () => state.handover)
    },
    vehicleInspection: {
      findUnique: vi.fn(async () => ({
        deletedAt: null,
        id: "inspection-1",
        inspectedAt: state.inspectionStatus === "PASSED" ? now : null,
        orderId,
        status: state.inspectionStatus
      }))
    }
  };
  const auditService = {
    write: vi.fn(async () => undefined)
  };
  const engine = new LeaseActivationEngine(auditService as never, prisma as never, () => now);

  return { auditService, context, engine, orderId, prisma, state, user };
}

interface LeaseActivationState {
  contractStatus: ContractStatus;
  depositBillStatus: BillStatus;
  depositRemainingAmount: bigint;
  deliveryStatus: DeliveryStatus;
  firstRentBillStatus: BillStatus;
  firstRentRemainingAmount: bigint;
  handover: Record<string, unknown> | null;
  inspectionStatus: "PENDING" | "PASSED" | "FAILED";
  lease: Record<string, unknown> | null;
}
