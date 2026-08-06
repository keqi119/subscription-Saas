import { ConfigService } from "@nestjs/config";
import {
  ApplicationSource,
  SubscriptionJourneyEventType,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionJourneyRuntimeConfig } from "../src/subscription-journey/subscription-journey.config";
import { SubscriptionJourneyRepository } from "../src/subscription-journey/subscription-journey.repository";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import { SubscriptionJourneySignalService } from "../src/subscription-journey/subscription-journey-signal.service";

describe("subscription journey enrollment", () => {
  it("does not enroll a new application while the feature flag is false", async () => {
    const harness = enrollmentHarness({ enabled: false });

    await harness.service.record(harness.tx as never, submittedSignal("application-1"));

    expect(harness.repository.createOrGetForApplication).not.toHaveBeenCalled();
    expect(harness.tx.application.findUnique).not.toHaveBeenCalled();
  });

  it("enrolls an application allowlisted by customer id", async () => {
    const harness = enrollmentHarness({
      applicationId: "application-1",
      customerAllowlist: ["customer-1"]
    });

    await harness.service.record(harness.tx as never, submittedSignal("application-1"));

    expect(harness.repository.createOrGetForApplication).toHaveBeenCalledWith(
      harness.tx,
      "application-1",
      "application:application-1:submitted"
    );
  });

  it("enrolls an application allowlisted by application id", async () => {
    const harness = enrollmentHarness({
      applicationAllowlist: ["application-1"],
      applicationId: "application-1",
      customerId: "customer-not-listed"
    });

    await harness.service.record(harness.tx as never, submittedSignal("application-1"));

    expect(harness.repository.createOrGetForApplication).toHaveBeenCalledOnce();
  });

  it("does not enroll a non-allowlisted application when rollout lists are active", async () => {
    const harness = enrollmentHarness({
      applicationAllowlist: ["application-allowed"],
      applicationId: "application-1",
      customerAllowlist: ["customer-allowed"],
      customerId: "customer-1"
    });

    await harness.service.record(harness.tx as never, submittedSignal("application-1"));

    expect(harness.repository.createOrGetForApplication).not.toHaveBeenCalled();
  });

  it.each([
    ApplicationSource.SELF_SERVICE,
    ApplicationSource.SALES_ASSISTED
  ])("uses the same enrollment contract for %s intake", async (applicationSource) => {
    const harness = enrollmentHarness({ applicationSource });

    await harness.service.record(harness.tx as never, submittedSignal("application-1"));

    expect(harness.repository.createOrGetForApplication).toHaveBeenCalledWith(
      harness.tx,
      "application-1",
      "application:application-1:submitted"
    );
  });

  it("keeps an existing journey alive after rollout is disabled", async () => {
    const harness = enrollmentHarness({ enabled: false, existingJourney: true });

    await harness.service.record(harness.tx as never, {
      applicationId: "application-1",
      eventKey: "application:application-1:plan-confirmed:1",
      payload: { revision: 1 },
      type: "CUSTOMER_PLAN_CONFIRMED"
    });

    expect(harness.repository.recordSignal).toHaveBeenCalledOnce();
  });

  it("keeps duplicate APPLICATION_SUBMITTED idempotent after rollout is disabled", async () => {
    const harness = enrollmentHarness({ enabled: false, existingJourney: true });

    await harness.service.record(harness.tx as never, submittedSignal("application-1"));

    expect(harness.repository.createOrGetForApplication).toHaveBeenCalledOnce();
  });
});

describe("SubscriptionJourneyService dispatch", () => {
  it("enqueues one stable handler job when the start signal is replayed", async () => {
    const sourceKeys = new Set<string>();
    const jobs = new Map<string, unknown>();
    const repository = {
      enqueueJob: vi.fn(async (_tx, input: { payload: unknown; sourceKey: string }) => {
        const existing = jobs.get(input.sourceKey);
        if (existing && JSON.stringify(existing) !== JSON.stringify(input.payload)) {
          throw new Error("stable source key received a different payload");
        }
        jobs.set(input.sourceKey, input.payload);
        sourceKeys.add(input.sourceKey);
        return input;
      }),
      enqueueNotificationOutbox: vi.fn(async () => undefined)
    };
    const journey = {
      application: { finalPlanRevision: 3 },
      applicationId: "application-1",
      currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
      currentStepStatus: SubscriptionJourneyStepStatus.PENDING,
      id: "journey-1",
      orderId: null,
      steps: [
        {
          code: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
          id: "step-1",
          journeyId: "journey-1"
        }
      ],
      version: 7
    };
    const tx = {
      subscriptionJourney: {
        findUnique: vi.fn(async () => journey)
      }
    };
    const service = new SubscriptionJourneyService(repository as never);
    const outbox = {
      eventKey: "application:application-1:submitted:outbox",
      eventType: SubscriptionJourneyEventType.JOURNEY_STARTED,
      id: "outbox-application-started",
      journeyId: journey.id,
      payload: { applicationId: journey.applicationId }
    };

    await service.dispatchSignalOutbox(tx as never, outbox as never);
    await service.dispatchSignalOutbox(
      tx as never,
      {
        ...outbox,
        eventKey: "application:application-1:materials-updated:outbox",
        id: "outbox-application-materials-updated"
      } as never
    );

    expect(sourceKeys).toEqual(
      new Set([
        "journey:journey-1:step:APPLICATION_VALIDATION:revision:3"
      ])
    );
    expect(repository.enqueueJob).toHaveBeenLastCalledWith(
      tx,
      expect.objectContaining({
        jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION,
        journeyId: journey.id,
        stepId: "step-1"
      })
    );
    expect(repository.enqueueNotificationOutbox).toHaveBeenCalledTimes(2);
  });

  it("creates a missing next step before scheduling its automatic handler", async () => {
    const createdStep = {
      code: SubscriptionJourneyStepCode.ORDER_AND_CONTRACT_CREATION,
      id: "step-order-contract",
      journeyId: "journey-1"
    };
    const repository = {
      enqueueJob: vi.fn(async (_tx, input) => input),
      enqueueNotificationOutbox: vi.fn(async () => undefined)
    };
    const tx = {
      subscriptionJourney: {
        findUnique: vi.fn(async () => ({
          application: { finalPlanRevision: 4 },
          applicationId: "application-1",
          currentStepCode:
            SubscriptionJourneyStepCode.ORDER_AND_CONTRACT_CREATION,
          id: "journey-1",
          orderId: null,
          steps: [],
          version: 8
        }))
      },
      subscriptionJourneyStep: {
        upsert: vi.fn(async () => createdStep)
      }
    };
    const service = new SubscriptionJourneyService(repository as never);

    await service.dispatchSignalOutbox(tx as never, {
      eventKey: "journey:journey-1:step:vehicle:completed:outbox",
      eventType: SubscriptionJourneyEventType.STEP_COMPLETED,
      id: "outbox-step-completed",
      journeyId: "journey-1",
      payload: {}
    } as never);

    expect(tx.subscriptionJourneyStep.upsert).toHaveBeenCalledWith({
      create: {
        code: SubscriptionJourneyStepCode.ORDER_AND_CONTRACT_CREATION,
        journeyId: "journey-1"
      },
      update: {},
      where: {
        journeyId_code: {
          code: SubscriptionJourneyStepCode.ORDER_AND_CONTRACT_CREATION,
          journeyId: "journey-1"
        }
      }
    });
    expect(repository.enqueueJob).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        jobType: SubscriptionJourneyJobType.CREATE_ORDER_AND_CONTRACT,
        sourceKey:
          "journey:journey-1:step:ORDER_AND_CONTRACT_CREATION:revision:4",
        stepId: createdStep.id
      })
    );
  });

  it("schedules a fresh validation job when approved application facts advance the journey version", async () => {
    const sourceKeys: string[] = [];
    let version = 0;
    const repository = {
      enqueueJob: vi.fn(async (_tx, input: { sourceKey: string }) => {
        sourceKeys.push(input.sourceKey);
        return input;
      }),
      enqueueNotificationOutbox: vi.fn(async () => undefined)
    };
    const tx = {
      subscriptionJourney: {
        findUnique: vi.fn(async () => ({
          application: { finalPlanRevision: 0 },
          applicationId: "application-1",
          currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
          id: "journey-1",
          orderId: null,
          steps: [
            {
              code: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
              id: "step-validation"
            }
          ],
          version
        }))
      }
    };
    const service = new SubscriptionJourneyService(repository as never);

    await service.dispatchSignalOutbox(tx as never, {
      eventKey: "application:application-1:submitted:outbox",
      id: "outbox-submitted",
      journeyId: "journey-1",
      payload: {}
    } as never);
    version = 1;
    await service.dispatchSignalOutbox(tx as never, {
      eventKey: "application:application-1:facts:credit:outbox",
      id: "outbox-credit",
      journeyId: "journey-1",
      payload: { journeyVersion: 1 }
    } as never);

    expect(sourceKeys).toEqual([
      "journey:journey-1:step:APPLICATION_VALIDATION:revision:0",
      "journey:journey-1:step:APPLICATION_VALIDATION:revision:0:facts:1"
    ]);
  });

  it("attaches an order idempotently after order creation", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const service = new SubscriptionJourneyService({} as SubscriptionJourneyRepository);

    await service.attachOrder(
      { subscriptionJourney: { updateMany } } as never,
      "journey-1",
      "order-1"
    );

    expect(updateMany).toHaveBeenCalledWith({
      data: { orderId: "order-1" },
      where: {
        id: "journey-1",
        OR: [{ orderId: null }, { orderId: "order-1" }]
      }
    });
  });
});

interface EnrollmentOptions {
  applicationAllowlist?: string[];
  applicationId?: string;
  applicationSource?: ApplicationSource;
  customerAllowlist?: string[];
  customerId?: string;
  enabled?: boolean;
  existingJourney?: boolean;
}

function enrollmentHarness(options: EnrollmentOptions = {}) {
  const applicationId = options.applicationId ?? "application-1";
  const customerId = options.customerId ?? "customer-1";
  const existingJourney = options.existingJourney
    ? { applicationId, id: "journey-existing" }
    : null;
  const tx = {
    application: {
      findUnique: vi.fn(async () => ({
        applicationSource:
          options.applicationSource ?? ApplicationSource.SELF_SERVICE,
        customerId,
        id: applicationId
      }))
    },
    subscriptionJourney: {
      findUnique: vi.fn(async () => existingJourney)
    }
  };
  const repository = {
    createOrGetForApplication: vi.fn(async () => existingJourney ?? { applicationId }),
    recordSignal: vi.fn(async () => undefined)
  };
  const runtimeConfig = new SubscriptionJourneyRuntimeConfig(
    new ConfigService({
      SUBSCRIPTION_JOURNEY_ALLOWLIST_APPLICATION_IDS:
        options.applicationAllowlist?.join(",") ?? "",
      SUBSCRIPTION_JOURNEY_ALLOWLIST_CUSTOMER_IDS:
        options.customerAllowlist?.join(",") ?? "",
      SUBSCRIPTION_JOURNEY_CLAIM_LIMIT: "10",
      SUBSCRIPTION_JOURNEY_ENABLED: String(options.enabled ?? true),
      SUBSCRIPTION_JOURNEY_LEASE_MS: "120000",
      SUBSCRIPTION_JOURNEY_POLL_INTERVAL_MS: "5000",
      SUBSCRIPTION_JOURNEY_WORKER_ENABLED: "false"
    })
  );
  const service = new SubscriptionJourneySignalService(
    repository as unknown as SubscriptionJourneyRepository,
    runtimeConfig
  );
  return { repository, service, tx };
}

function submittedSignal(applicationId: string) {
  return {
    applicationId,
    eventKey: `application:${applicationId}:submitted`,
    payload: { source: "APPLICATION_SUBMISSION" },
    type: "APPLICATION_SUBMITTED" as const
  };
}
