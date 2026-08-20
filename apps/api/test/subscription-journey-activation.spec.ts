import { SubscriptionJourneyJobType } from "@prisma/client";
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionJourneyHandlers } from "../src/subscription-journey/subscription-journey.handlers";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";

describe("subscription journey authoritative activation", () => {
  it("routes ACTIVATE_SUBSCRIPTION to the transaction-backed activation job", async () => {
    const service = {
      activateSubscriptionJob: vi.fn(async () => ({
        action: "SUBSCRIPTION_ACTIVATED",
        orderId: "order-1"
      }))
    };
    const handlers = new SubscriptionJourneyHandlers(service as never);
    const job = {
      id: "job-1",
      jobType: SubscriptionJourneyJobType.ACTIVATE_SUBSCRIPTION,
      journeyId: "journey-1",
      stepId: "step-1"
    };

    await expect(handlers.handle(job as never)).resolves.toEqual({
      action: "SUBSCRIPTION_ACTIVATED",
      orderId: "order-1"
    });
    expect(service.activateSubscriptionJob).toHaveBeenCalledWith(job);
  });

  it("activates the exact Journey order inside one caller transaction", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      subscriptionJourney: {
        findUnique: vi.fn(async () => ({
          application: { finalPlanRevision: 4, salesUserId: "user-1" },
          currentStepCode: "AUTHORITATIVE_ACTIVATION",
          id: "journey-1",
          orderId: "order-1",
          status: "RUNNING",
          steps: [
            {
              code: "AUTHORITATIVE_ACTIVATION",
              id: "step-1",
              status: "PENDING"
            }
          ]
        }))
      }
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx)
      )
    };
    const activation = {
      activateFromAuthoritativeHandover: vi.fn(async () => ({
        deliveryId: "delivery-1",
        leaseId: "lease-1",
        orderId: "order-1",
        vehicleId: "vehicle-1"
      }))
    };
    const service = new SubscriptionJourneyService(
      {} as never,
      prisma as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      activation as never
    );
    const job = {
      jobType: SubscriptionJourneyJobType.ACTIVATE_SUBSCRIPTION,
      journeyId: "journey-1",
      payload: { finalPlanRevision: 4, orderId: "order-1" },
      stepId: "step-1"
    };

    await expect(service.activateSubscriptionJob(job as never)).resolves.toEqual({
      action: "SUBSCRIPTION_ACTIVATED",
      deliveryId: "delivery-1",
      leaseId: "lease-1",
      orderId: "order-1",
      vehicleId: "vehicle-1"
    });
    expect(activation.activateFromAuthoritativeHandover).toHaveBeenCalledWith(
      tx,
      {
        actorId: "user-1",
        journeyId: "journey-1",
        orderId: "order-1"
      }
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("converges an operational restriction to a durable PAUSED business wait", async () => {
    const journey = {
      application: { finalPlanRevision: 4, salesUserId: "user-1" },
      currentStepCode: "AUTHORITATIVE_ACTIVATION",
      id: "journey-1",
      orderId: "order-1",
      status: "RUNNING",
      steps: [{ code: "AUTHORITATIVE_ACTIVATION", id: "step-1", status: "PENDING" }],
      version: 7
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      subscriptionJourney: { findUnique: vi.fn(async () => journey) }
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx))
    };
    const repository = {
      pauseForOperationalRestriction: vi.fn(async () => undefined)
    };
    const activation = {
      activateFromAuthoritativeHandover: vi.fn(async () => {
        throw new ConflictException({
          code: "VEHICLE_OPERATIONALLY_RESTRICTED",
          reasons: [{ code: "ACTIVE_OPERATIONAL_RESTRICTION", restrictionId: "restriction-1" }]
        });
      })
    };
    const service = new SubscriptionJourneyService(
      repository as never,
      prisma as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      activation as never
    );
    const job = {
      jobType: SubscriptionJourneyJobType.ACTIVATE_SUBSCRIPTION,
      journeyId: "journey-1",
      payload: { finalPlanRevision: 4, orderId: "order-1" },
      stepId: "step-1"
    };

    await expect(service.activateSubscriptionJob(job as never)).resolves.toEqual({
      action: "SUBSCRIPTION_ACTIVATION_WAITING_OPERATIONAL_CLEARANCE",
      journeyId: "journey-1",
      orderId: "order-1"
    });
    expect(repository.pauseForOperationalRestriction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        expectedVersion: 7,
        journeyId: "journey-1",
        reasons: expect.arrayContaining([
          expect.objectContaining({ restrictionId: "restriction-1" })
        ]),
        stepId: "step-1"
      })
    );
  });
});
