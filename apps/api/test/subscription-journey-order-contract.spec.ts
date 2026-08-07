import {
  BusinessType,
  OrderStatus,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStepCode
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionJourneyHandlers } from "../src/subscription-journey/subscription-journey.handlers";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import type { ClaimedJourneyJob } from "../src/subscription-journey/subscription-journey.types";

describe("subscription journey order and contract bootstrap", () => {
  it("creates the order, generated contract, and prepared entitlements in one transaction", async () => {
    const tx = orderContractTransaction();
    const prisma = transactionHost(tx);
    const order = {
      businessType: BusinessType.SUBSCRIPTION,
      id: "order-1",
      orderStatus: OrderStatus.PENDING_CONTRACT,
      vehicleId: "vehicle-1"
    };
    const contract = { id: "contract-1", orderId: order.id, status: "GENERATED" };
    const customerService = {
      createOrderFromApplicationInTransaction: vi.fn(async () => order)
    };
    const orderService = {
      createJourneyContractInTransaction: vi.fn(async () => contract)
    };
    const entitlementService = {
      ensureInitialEntitlements: vi.fn(async () => undefined)
    };
    const repository = {
      completeStep: vi.fn(async () => undefined)
    };
    const service = new SubscriptionJourneyService(
      repository as never,
      prisma as never,
      customerService as never,
      orderService as never,
      entitlementService as never
    );

    await expect(service.createOrderAndContractJob(orderContractJob())).resolves.toEqual({
      action: "ORDER_AND_CONTRACT_CREATED",
      applicationId: "application-1",
      contractId: "contract-1",
      orderId: "order-1"
    });

    expect(customerService.createOrderFromApplicationInTransaction).toHaveBeenCalledWith(
      tx,
      "application-1",
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000000001" }),
      expect.objectContaining({ userAgent: "subscription-journey-worker" })
    );
    expect(orderService.createJourneyContractInTransaction).toHaveBeenCalledWith(
      tx,
      "order-1",
      "00000000-0000-4000-8000-000000000001",
      orderContractJob().sourceKey
    );
    expect(entitlementService.ensureInitialEntitlements).toHaveBeenCalledWith(
      tx,
      "order-1",
      "00000000-0000-4000-8000-000000000001"
    );
    expect(tx.subscriptionJourney.updateMany).toHaveBeenCalledWith({
      data: { orderId: "order-1" },
      where: { id: "journey-1", OR: [{ orderId: null }, { orderId: "order-1" }] }
    });
    expect(repository.completeStep).toHaveBeenCalledWith(tx, {
      eventKey:
        "journey:journey-1:step:ORDER_AND_CONTRACT_CREATION:revision:1:completed",
      expectedVersion: 4,
      journeyId: "journey-1",
      payload: { contractId: "contract-1", orderId: "order-1" },
      stepId: "step-order-contract"
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("treats a replay after advancement as completed and creates no duplicates", async () => {
    const tx = orderContractTransaction({
      currentStepCode: SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
      orderId: "order-1"
    });
    const customerService = {
      createOrderFromApplicationInTransaction: vi.fn()
    };
    const orderService = { createJourneyContractInTransaction: vi.fn() };
    const entitlementService = { ensureInitialEntitlements: vi.fn() };
    const repository = { completeStep: vi.fn() };
    const service = new SubscriptionJourneyService(
      repository as never,
      transactionHost(tx) as never,
      customerService as never,
      orderService as never,
      entitlementService as never
    );

    await expect(service.createOrderAndContractJob(orderContractJob())).resolves.toEqual({
      action: "ORDER_AND_CONTRACT_ALREADY_COMPLETED",
      applicationId: "application-1",
      orderId: "order-1"
    });
    expect(customerService.createOrderFromApplicationInTransaction).not.toHaveBeenCalled();
    expect(orderService.createJourneyContractInTransaction).not.toHaveBeenCalled();
    expect(entitlementService.ensureInitialEntitlements).not.toHaveBeenCalled();
    expect(repository.completeStep).not.toHaveBeenCalled();
  });

  it("routes CREATE_ORDER_AND_CONTRACT to the implemented handler", async () => {
    const service = {
      createOrderAndContractJob: vi.fn(async () => ({
        action: "ORDER_AND_CONTRACT_CREATED"
      }))
    };
    const handlers = new SubscriptionJourneyHandlers(service as never);

    await expect(handlers.handle(orderContractJob())).resolves.toEqual({
      action: "ORDER_AND_CONTRACT_CREATED"
    });
    expect(service.createOrderAndContractJob).toHaveBeenCalledOnce();
  });

  it.each([
    "FINAL_PLAN_REVISION_STALE",
    "JOURNEY_APPLICATION_VEHICLE_UNAVAILABLE",
    "JOURNEY_APPLICATION_PRODUCT_INVALID",
    "JOURNEY_CONTRACT_TEMPLATE_INACTIVE"
  ])("does not advance when bootstrap rejects with %s", async (code) => {
    const tx = orderContractTransaction();
    const repository = { completeStep: vi.fn() };
    const customerService = {
      createOrderFromApplicationInTransaction: vi.fn(async () => {
        throw Object.assign(new Error(code), { code });
      })
    };
    const service = new SubscriptionJourneyService(
      repository as never,
      transactionHost(tx) as never,
      customerService as never,
      {} as never,
      {} as never
    );

    await expect(service.createOrderAndContractJob(orderContractJob())).rejects.toMatchObject({
      code
    });
    expect(repository.completeStep).not.toHaveBeenCalled();
  });
});

function orderContractTransaction(
  overrides: {
    currentStepCode?: SubscriptionJourneyStepCode;
    orderId?: string | null;
  } = {}
) {
  const journey = {
    application: {
      finalPlanRevision: 1,
      salesUserId: "00000000-0000-4000-8000-000000000001"
    },
    applicationId: "application-1",
    currentStepCode:
      overrides.currentStepCode ??
      SubscriptionJourneyStepCode.ORDER_AND_CONTRACT_CREATION,
    id: "journey-1",
    orderId: overrides.orderId ?? null,
    steps: [
      {
        code: SubscriptionJourneyStepCode.ORDER_AND_CONTRACT_CREATION,
        id: "step-order-contract"
      }
    ],
    version: 4
  };
  return {
    $queryRaw: vi.fn(async () => [{ id: journey.id }]),
    subscriptionJourney: {
      findUnique: vi.fn(async () => journey),
      updateMany: vi.fn(async () => ({ count: 1 }))
    }
  };
}

function transactionHost(tx: unknown) {
  return {
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(tx))
  };
}

function orderContractJob(): ClaimedJourneyJob {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    completedAt: null,
    createdAt: now,
    id: "job-order-contract",
    jobType: SubscriptionJourneyJobType.CREATE_ORDER_AND_CONTRACT,
    journeyId: "journey-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-08-06T00:02:00.000Z"),
    leaseToken: "lease-order-contract",
    maxAttempts: 5,
    payload: { applicationId: "application-1", finalPlanRevision: 1 },
    sourceKey:
      "journey:journey-1:step:ORDER_AND_CONTRACT_CREATION:revision:1",
    status: SubscriptionJourneyJobStatus.PROCESSING,
    stepId: "step-order-contract",
    updatedAt: now
  };
}
