import {
  BillStatus,
  BillType,
  ContractStatus,
  DeliveryStatus,
  OrderStatus,
  PaymentStatus,
  SubscriptionJourneyStatus,
  VehicleHandoverOpsReviewStatus,
  VehicleHandoverWorkOrderStatus,
  VehicleInsurancePolicyStatus,
  VehicleInsurancePolicyType,
  VehicleStatus
} from "@prisma/client";
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { LeaseActivationEngine } from "../src/lease/lease-activation.engine";
import { VehicleAvailabilityPurpose } from "../src/asset-operations/vehicle-availability";

describe("LeaseActivationEngine authoritative gate", () => {
  it("evaluates the complete authoritative fact set inside the caller transaction", async () => {
    const harness = createHarness();

    await expect(
      harness.engine.evaluateInTransaction(harness.tx as never, harness.orderId)
    ).resolves.toEqual({ canActivate: true, missingConditions: [] });
    expect(harness.tx.$queryRaw).toHaveBeenCalled();
  });

  it("accepts equivalent prefixed and case-variant approved evidence hashes", async () => {
    const digest = "a".repeat(64);
    const harness = createHarness({
      approvedManifestHash: `sha256:${digest.toUpperCase()}`,
      handoverManifestHash: digest
    });

    await expect(harness.engine.evaluate(harness.orderId)).resolves.toEqual({
      canActivate: true,
      missingConditions: []
    });
  });

  it.each([null, "", "sha256:not-a-digest", "b".repeat(64)])(
    "rejects non-matching approved evidence hash %s",
    async (approvedManifestHash) => {
      const harness = createHarness({ approvedManifestHash });

      const result = await harness.engine.evaluate(harness.orderId);

      expect(result.missingConditions).toContain("HANDOVER_EVIDENCE_NOT_APPROVED");
    }
  );

  it("rejects SIGNED Stage 1 contracts without an archived PDF", async () => {
    const harness = createHarness({
      contractArchivedAt: null,
      contractFileId: null,
      contractStatus: ContractStatus.SIGNED
    });

    const result = await harness.engine.evaluate(harness.orderId);

    expect(result.missingConditions).toContain("CONTRACT_ARCHIVED_ARTIFACT_MISSING");
    expect(harness.state.writeCount).toBe(0);
  });

  it("rejects every unpaid or partially paid required bill", async () => {
    const harness = createHarness({
      depositRemainingAmount: 1n,
      depositStatus: BillStatus.PARTIALLY_PAID,
      firstRentRemainingAmount: 1n,
      firstRentStatus: BillStatus.PARTIALLY_PAID
    });

    const result = await harness.engine.evaluate(harness.orderId);

    expect(result.missingConditions).toEqual(
      expect.arrayContaining(["DEPOSIT_PAYMENT_MISSING", "FIRST_RENT_PAYMENT_MISSING"])
    );
    expect(harness.state.writeCount).toBe(0);
  });

  it("does not accept legacy money confirmation booleans without confirmed write-offs", async () => {
    const harness = createHarness({
      depositWriteOffConfirmed: false,
      firstRentWriteOffConfirmed: false,
      legacyMoneyBooleans: true
    });

    const result = await harness.engine.evaluate(harness.orderId);

    expect(result.missingConditions).toEqual(
      expect.arrayContaining(["DEPOSIT_PAYMENT_MISSING", "FIRST_RENT_PAYMENT_MISSING"])
    );
  });

  it.each([
    ["unapproved evidence", { workOrderApproved: false }, "HANDOVER_EVIDENCE_NOT_APPROVED"],
    ["missing inspection", { inspectionPassed: false }, "INSPECTION_PASSED"],
    ["lapsed insurance", { insuranceCovered: false }, "INSURANCE_NOT_COVERED"],
    ["mismatched vehicle", { deliveryVehicleMatches: false }, "VEHICLE_MISMATCH"],
    ["missing delivery mileage", { handoverMileageKm: null }, "DELIVERY_MILEAGE_MISSING"],
    [
      "unarchived Stage 2 artifact",
      { handoverArchived: false },
      "HANDOVER_ARCHIVED_ARTIFACT_MISSING"
    ]
  ] as const)("rejects %s with a stable blocker", async (_name, overrides, blocker) => {
    const harness = createHarness(overrides);

    const result = await harness.engine.evaluate(harness.orderId);

    expect(result.missingConditions).toContain(blocker);
    expect(harness.state.writeCount).toBe(0);
  });

  it("atomically activates delivery, order, vehicle, lease, billing, entitlements and journey", async () => {
    const harness = createHarness({ journey: true });

    const result = await harness.prisma.$transaction((tx) =>
      harness.engine.activateFromAuthoritativeHandover(tx as never, {
        actorId: harness.user.id,
        journeyId: "journey-1",
        orderId: harness.orderId
      })
    );

    expect(result).toMatchObject({
      deliveryStatus: "DELIVERED",
      journeyStatus: "COMPLETED",
      leaseStatus: "ACTIVE",
      orderStatus: "ACTIVE",
      vehicleStatus: "LEASED"
    });
    expect(harness.state.billingScheduleCount).toBe(1);
    expect(harness.state.entitlementCount).toBe(1);
    expect(harness.state.journeyCompletedEventCount).toBe(1);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "subscription_activation" }),
      harness.tx
    );
  });

  it("blocks central activation before every write when DELIVERY is operationally restricted", async () => {
    const harness = createHarness({ operationallyRestricted: true });

    await expect(harness.engine.activate(harness.orderId, harness.user)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "VEHICLE_OPERATIONALLY_RESTRICTED" })
    });

    expect(harness.assetOperationsService.assertVehicleAvailable).toHaveBeenCalledWith(
      harness.tx,
      "vehicle-1",
      VehicleAvailabilityPurpose.DELIVERY,
      expect.any(Date)
    );
    expect(harness.state.writeCount).toBe(0);
  });

  it("keeps all authoritative activation records singular on retry", async () => {
    const harness = createHarness({ journey: true });

    await harness.engine.activate(harness.orderId, harness.user);
    await harness.engine.activate(harness.orderId, harness.user);

    expect(harness.state.leaseCount).toBe(1);
    expect(harness.state.billingScheduleCount).toBe(1);
    expect(harness.state.entitlementCount).toBe(1);
    expect(harness.state.journeyCompletedEventCount).toBe(1);
  });

  it("rolls every aggregate back when a write fails after the vehicle update", async () => {
    const harness = createHarness({ failAfterVehicleUpdate: true, journey: true });

    await expect(harness.engine.activate(harness.orderId, harness.user)).rejects.toThrow(
      "injected post-vehicle failure"
    );

    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_DELIVERY);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.RESERVED);
    expect(harness.state.deliveryStatus).toBe(DeliveryStatus.READY);
    expect(harness.state.leaseCount).toBe(0);
    expect(harness.state.billingScheduleCount).toBe(0);
    expect(harness.state.entitlementCount).toBe(0);
    expect(harness.state.journeyStatus).toBe(SubscriptionJourneyStatus.RUNNING);
  });

  it("derives activation time and mileage only from the approved Stage 2 handover", async () => {
    const completedAt = new Date("2026-08-06T08:16:00.000Z");
    const harness = createHarness({ completedAt, handoverMileageKm: 28200 });

    const lease = await harness.engine.activate(harness.orderId, harness.user);

    expect(lease.activatedAt).toBe(completedAt.toISOString());
    expect(harness.state.deliveryMileageKm).toBe(28200);
  });
});

function createHarness(overrides: Partial<State> = {}) {
  const now = new Date("2026-08-06T08:30:00.000Z");
  const orderId = "order-1";
  const vehicleId = "vehicle-1";
  const deliveryId = "delivery-1";
  const manifestHash = "a".repeat(64);
  const state: State = {
    approvedManifestHash: manifestHash,
    billingScheduleCount: 0,
    completedAt: new Date("2026-08-06T08:00:00.000Z"),
    contractArchivedAt: new Date("2026-08-05T09:00:00.000Z"),
    contractFileId: "stage1-file-1",
    contractStatus: ContractStatus.ARCHIVED,
    deliveryMileageKm: null,
    deliveryStatus: DeliveryStatus.READY,
    deliveryVehicleMatches: true,
    depositRemainingAmount: 0n,
    depositStatus: BillStatus.PAID,
    depositWriteOffConfirmed: true,
    entitlementCount: 0,
    failAfterVehicleUpdate: false,
    firstRentRemainingAmount: 0n,
    firstRentStatus: BillStatus.PAID,
    firstRentWriteOffConfirmed: true,
    handoverArchived: true,
    handoverManifestHash: manifestHash,
    handoverMileageKm: 28100,
    inspectionPassed: true,
    insuranceCovered: true,
    journey: false,
    journeyCompletedEventCount: 0,
    journeyStatus: SubscriptionJourneyStatus.RUNNING,
    operationallyRestricted: false,
    leaseCount: 0,
    legacyMoneyBooleans: false,
    orderStatus: OrderStatus.PENDING_DELIVERY,
    vehicleStatus: VehicleStatus.RESERVED,
    workOrderApproved: true,
    writeCount: 0,
    ...overrides
  };
  const user = {
    id: "user-1",
    menus: [],
    name: "Automation",
    permissions: [],
    roles: ["ADMIN"],
    username: "automation"
  };

  const buildJourney = () =>
    state.journey
      ? {
          currentStepCode: "AUTHORITATIVE_ACTIVATION",
          currentStepStatus: "PENDING",
          id: "journey-1",
          status: state.journeyStatus,
          steps: [
            {
              code: "AUTHORITATIVE_ACTIVATION",
              id: "activation-step-1",
              status:
                state.journeyStatus === SubscriptionJourneyStatus.COMPLETED
                  ? "COMPLETED"
                  : "PENDING"
            }
          ],
          version: state.journeyStatus === SubscriptionJourneyStatus.COMPLETED ? 2 : 0
        }
      : null;
  const buildOrder = () => ({
    contract: {
      archivedAt: state.contractArchivedAt,
      deletedAt: null,
      fileId: state.contractFileId,
      id: "contract-1",
      status: state.contractStatus
    },
    deletedAt: null,
    depositAmount: 500000n,
    finalDepositAmount: 500000n,
    id: orderId,
    monthlyFeeAmount: 300000n,
    orderStatus: state.orderStatus,
    subscriptionJourney: buildJourney(),
    vehicle: {
      deletedAt: null,
      id: vehicleId,
      insurancePolicies: buildInsurancePolicies(state, now),
      status: state.vehicleStatus
    },
    vehicleId
  });
  const buildDelivery = () => ({
    contractSignedConfirmed: true,
    customerId: "customer-1",
    customerIdentityConfirmed: true,
    deletedAt: null,
    deliveryNo: "DLV-1",
    deliveryStatus: state.deliveryStatus,
    depositReceivedConfirmed: state.legacyMoneyBooleans,
    deliveredAt: state.deliveryStatus === DeliveryStatus.DELIVERED ? state.completedAt : null,
    firstMonthlyFeeReceivedConfirmed: state.legacyMoneyBooleans,
    handoverDocumentsConfirmed: true,
    handoverMileageKm: state.deliveryMileageKm,
    id: deliveryId,
    insuranceValidConfirmed: true,
    orderId,
    vehicleId: state.deliveryVehicleMatches ? vehicleId : "vehicle-other",
    vehiclePhotosConfirmed: true,
    vehiclePreparedConfirmed: true
  });
  const buildHandover = () => ({
    archiveStatus: state.handoverArchived ? "ARCHIVED" : "NOT_STARTED",
    archivedAt: state.handoverArchived ? state.completedAt : null,
    completedAt: state.completedAt,
    createdAt: now,
    customerSignedAt: state.completedAt,
    deletedAt: null,
    handoverContract: {
      deletedAt: null,
      fileId: "stage2-file-1",
      id: "stage2-contract-1",
      status: state.handoverArchived ? "ARCHIVED" : "SIGNED"
    },
    handoverESignTask: null,
    id: "handover-1",
    manifestHash: state.handoverManifestHash,
    orderId,
    signedDocumentFileId: state.handoverArchived ? "stage2-file-1" : null,
    sourceDocumentFileId: "stage2-source-file-1",
    status: state.handoverArchived ? "ARCHIVED" : "SIGNED",
    vehicleDeliveryId: deliveryId
  });
  const buildBills = () => [
    buildBill(
      "deposit-bill-1",
      BillType.DEPOSIT,
      500000n,
      state.depositStatus,
      state.depositRemainingAmount,
      state.depositWriteOffConfirmed
    ),
    buildBill(
      "rent-bill-1",
      BillType.FIRST_MONTHLY_FEE,
      300000n,
      state.firstRentStatus,
      state.firstRentRemainingAmount,
      state.firstRentWriteOffConfirmed
    )
  ];

  let lease: Record<string, unknown> | null = null;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    auditLog: { create: vi.fn(async () => (state.writeCount += 1)) },
    fileObject: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id ? { id: where.id, objectKey: `objects/${where.id}` } : null
      )
    },
    lease: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.writeCount += 1;
        state.leaseCount = 1;
        lease = {
          activatedAt: data.activatedAt,
          createdAt: now,
          createdBy: data.createdBy ?? null,
          deletedAt: null,
          id: "lease-1",
          orderId,
          status: "ACTIVE",
          updatedAt: now,
          updatedBy: data.updatedBy ?? null
        };
        return lease;
      }),
      findUnique: vi.fn(async () => lease),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.writeCount += 1;
        lease = { ...lease, ...data, updatedAt: now };
        return lease;
      })
    },
    orderEntitlementAccount: {
      updateMany: vi.fn(async () => {
        state.writeCount += 1;
        return { count: state.entitlementCount };
      })
    },
    receivableBill: { findMany: vi.fn(async () => buildBills()) },
    subscriptionOrder: {
      findUnique: vi.fn(async () => buildOrder()),
      update: vi.fn(async () => {
        state.writeCount += 1;
        state.orderStatus = OrderStatus.ACTIVE;
        return { id: orderId, orderStatus: state.orderStatus };
      })
    },
    vehicle: {
      update: vi.fn(async () => {
        state.writeCount += 1;
        state.vehicleStatus = VehicleStatus.LEASED;
        if (state.failAfterVehicleUpdate) {
          throw new Error("injected post-vehicle failure");
        }
        return { id: vehicleId, status: state.vehicleStatus };
      })
    },
    vehicleDelivery: {
      findUnique: vi.fn(async () => buildDelivery()),
      update: vi.fn(async ({ data }: { data: { handoverMileageKm: number } }) => {
        state.writeCount += 1;
        state.deliveryMileageKm = data.handoverMileageKm;
        state.deliveryStatus = DeliveryStatus.DELIVERED;
        return buildDelivery();
      })
    },
    vehicleDeliveryHandover: {
      findFirst: vi.fn(async () => buildHandover())
    },
    vehicleHandoverWorkOrder: {
      findFirst: vi.fn(async () => ({
        createdAt: now,
        handoverId: "handover-1",
        handoverMileageKm: state.handoverMileageKm,
        handoverType: "DELIVERY_OUTBOUND",
        id: "work-order-1",
        metadata: {
          journeyEvidenceManifestHash: state.workOrderApproved
            ? state.approvedManifestHash
            : "b".repeat(64)
        },
        opsReviewStatus: state.workOrderApproved
          ? VehicleHandoverOpsReviewStatus.APPROVED
          : VehicleHandoverOpsReviewStatus.REJECTED,
        orderId,
        status: state.workOrderApproved
          ? VehicleHandoverWorkOrderStatus.OPS_REVIEWED
          : VehicleHandoverWorkOrderStatus.FIELD_IN_PROGRESS,
        vehicleDeliveryId: deliveryId
      }))
    },
    vehicleInspection: {
      findUnique: vi.fn(async () => ({
        deletedAt: null,
        id: "inspection-1",
        orderId,
        status: state.inspectionPassed ? "PASSED" : "FAILED"
      }))
    }
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => {
      const snapshot = snapshotState(state);
      try {
        return await callback(tx);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    })
  };
  const auditService = { write: vi.fn(async () => (state.writeCount += 1)) };
  const billingAutomationService = {
    ensureActiveSchedule: vi.fn(async () => {
      state.writeCount += 1;
      state.billingScheduleCount = 1;
      return { id: "schedule-1" };
    })
  };
  const deliveryEvidenceService = {
    validateEvidenceReadyForDeliveryConfirmation: vi.fn(async () => ({
      blockingDetails: [],
      blockingReasons: [],
      handoverId: "handover-1",
      orderId,
      ready: true
    }))
  };
  const financeService = {
    evaluateInitialBillSettlement: vi.fn(async () => ({
      paid: state.depositRemainingAmount === 0n && state.firstRentRemainingAmount === 0n,
      remainingAmount: state.depositRemainingAmount + state.firstRentRemainingAmount
    }))
  };
  const mileageService = {
    appendConfirmedReading: vi.fn(async () => ({ id: "reading-1" }))
  };
  const mileageReviewService = {
    createFirstReview: vi.fn(async () => ({ id: "review-1" }))
  };
  const entitlementService = {
    ensureInitialEntitlements: vi.fn(async () => {
      state.writeCount += 1;
      state.entitlementCount = 1;
    })
  };
  const journeyRepository = {
    completeActivation: vi.fn(async () => {
      if (state.journeyStatus !== SubscriptionJourneyStatus.COMPLETED) {
        state.writeCount += 1;
        state.journeyStatus = SubscriptionJourneyStatus.COMPLETED;
        state.journeyCompletedEventCount += 1;
      }
    })
  };
  const assetOperationsService = {
    assertVehicleAvailable: vi.fn(async () => {
      if (state.operationallyRestricted) {
        throw new ConflictException({
          code: "VEHICLE_OPERATIONALLY_RESTRICTED",
          message: "Vehicle is operationally restricted."
        });
      }
    })
  };
  const engine = new LeaseActivationEngine(
    auditService as never,
    prisma as never,
    () => now,
    deliveryEvidenceService as never,
    billingAutomationService as never,
    financeService as never,
    { assertDeliveryCanBeConfirmed: vi.fn(async () => undefined) } as never,
    mileageService as never,
    mileageReviewService as never,
    entitlementService as never,
    journeyRepository as never,
    assetOperationsService as never
  );

  return {
    assetOperationsService,
    auditService,
    engine,
    orderId,
    prisma,
    state,
    tx,
    user
  };
}

function buildBill(
  id: string,
  billType: BillType,
  amount: bigint,
  billStatus: BillStatus,
  remainingAmount: bigint,
  confirmed: boolean
) {
  return {
    amount,
    billStatus,
    billType,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    id,
    remainingAmount,
    writeOffs: confirmed
      ? [
          {
            payment: { paymentStatus: PaymentStatus.CONFIRMED },
            writeOffAmount: amount
          }
        ]
      : []
  };
}

function buildInsurancePolicies(state: State, now: Date) {
  const effectiveTo = state.insuranceCovered
    ? new Date("2027-08-06T00:00:00.000Z")
    : new Date("2026-08-01T00:00:00.000Z");
  return [VehicleInsurancePolicyType.COMPULSORY_TRAFFIC, VehicleInsurancePolicyType.COMMERCIAL].map(
    (policyType, index) => ({
      deletedAt: null,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo,
      id: `policy-${index}`,
      policyStatus: VehicleInsurancePolicyStatus.ACTIVE,
      policyType,
      updatedAt: now
    })
  );
}

function snapshotState(state: State): State {
  return structuredClone(state);
}

interface State {
  approvedManifestHash: string | null;
  billingScheduleCount: number;
  completedAt: Date;
  contractArchivedAt: Date | null;
  contractFileId: string | null;
  contractStatus: ContractStatus;
  deliveryMileageKm: number | null;
  deliveryStatus: DeliveryStatus;
  deliveryVehicleMatches: boolean;
  depositRemainingAmount: bigint;
  depositStatus: BillStatus;
  depositWriteOffConfirmed: boolean;
  entitlementCount: number;
  failAfterVehicleUpdate: boolean;
  firstRentRemainingAmount: bigint;
  firstRentStatus: BillStatus;
  firstRentWriteOffConfirmed: boolean;
  handoverArchived: boolean;
  handoverManifestHash: string | null;
  handoverMileageKm: number | null;
  inspectionPassed: boolean;
  insuranceCovered: boolean;
  journey: boolean;
  journeyCompletedEventCount: number;
  journeyStatus: SubscriptionJourneyStatus;
  leaseCount: number;
  legacyMoneyBooleans: boolean;
  orderStatus: OrderStatus;
  operationallyRestricted: boolean;
  vehicleStatus: VehicleStatus;
  workOrderApproved: boolean;
  writeCount: number;
}
