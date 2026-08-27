import {
  SubscriptionJourneyStatus,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  assertJourneyStatusTransition,
  assertTransition,
  JOURNEY_STEP_SEQUENCE,
  manualTaskTypeFor,
  nextStep
} from "../src/subscription-journey/subscription-journey-state-machine";

describe("subscription journey state machine", () => {
  it("advances through every journey step in deterministic order", () => {
    const expected = [
      "FINAL_PLAN_DECISION",
      "FINAL_VEHICLE_ALLOCATION",
      "CUSTOMER_PLAN_CONFIRMATION",
      "ORDER_AND_CONTRACT_CREATION",
      "FADADA_SIGNING_AND_ARCHIVE",
      "INITIAL_BILLING",
      "CUSTOMER_JSAPI_PAYMENT",
      "HANDOVER_AND_STAGE2_CREATION",
      "DELIVERY_EVIDENCE_DECISION",
      "AUTHORITATIVE_ACTIVATION",
      null
    ] as const;

    expect(
      JOURNEY_STEP_SEQUENCE.map((step) =>
        nextStep(step, SubscriptionJourneyStepStatus.COMPLETED)
      )
    ).toEqual(expected);
    expect(
      nextStep(
        SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
        SubscriptionJourneyStepStatus.COMPLETED
      )
    ).toBe(SubscriptionJourneyStepCode.FINAL_PLAN_DECISION);
  });

  it("keeps the current step until it has completed", () => {
    expect(
      nextStep(
        SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION,
        SubscriptionJourneyStepStatus.WAITING_CUSTOMER
      )
    ).toBe(SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION);
  });

  it("rejects step skips and backtracks with a stable public error", () => {
    expect(() =>
      assertTransition(
        SubscriptionJourneyStepCode.INITIAL_BILLING,
        SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION
      )
    ).toThrowError(
      expect.objectContaining({ code: "JOURNEY_INVALID_TRANSITION" })
    );
    expect(() =>
      assertTransition(
        SubscriptionJourneyStepCode.INITIAL_BILLING,
        SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE
      )
    ).toThrowError(
      expect.objectContaining({ code: "JOURNEY_INVALID_TRANSITION" })
    );
  });

  it("resumes a paused journey only to its recorded previous status", () => {
    expect(() =>
      assertJourneyStatusTransition(
        SubscriptionJourneyStatus.PAUSED,
        SubscriptionJourneyStatus.WAITING_CUSTOMER,
        SubscriptionJourneyStatus.WAITING_CUSTOMER
      )
    ).not.toThrow();
    expect(() =>
      assertJourneyStatusTransition(
        SubscriptionJourneyStatus.PAUSED,
        SubscriptionJourneyStatus.RUNNING,
        SubscriptionJourneyStatus.WAITING_CUSTOMER
      )
    ).toThrowError(
      expect.objectContaining({ code: "JOURNEY_INVALID_TRANSITION" })
    );
  });

  it("permits explicit cancellation before completion but not afterward", () => {
    for (const status of [
      SubscriptionJourneyStatus.RUNNING,
      SubscriptionJourneyStatus.WAITING_CUSTOMER,
      SubscriptionJourneyStatus.WAITING_MANUAL,
      SubscriptionJourneyStatus.RETRY_SCHEDULED,
      SubscriptionJourneyStatus.PAUSED,
      SubscriptionJourneyStatus.EXCEPTION
    ]) {
      expect(() =>
        assertJourneyStatusTransition(
          status,
          SubscriptionJourneyStatus.CANCELLED,
          status === SubscriptionJourneyStatus.PAUSED
            ? SubscriptionJourneyStatus.RUNNING
            : undefined
        )
      ).not.toThrow();
    }

    expect(() =>
      assertJourneyStatusTransition(
        SubscriptionJourneyStatus.COMPLETED,
        SubscriptionJourneyStatus.CANCELLED
      )
    ).toThrowError(
      expect.objectContaining({ code: "JOURNEY_INVALID_TRANSITION" })
    );
  });

  it("opens manual work only for the three designated decision steps", () => {
    expect(
      JOURNEY_STEP_SEQUENCE.filter((step) => manualTaskTypeFor(step) !== null)
    ).toEqual([
      SubscriptionJourneyStepCode.FINAL_PLAN_DECISION,
      SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION,
      SubscriptionJourneyStepCode.DELIVERY_EVIDENCE_DECISION
    ]);
    expect(
      manualTaskTypeFor(
        SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION
      )
    ).toBeNull();
    expect(
      manualTaskTypeFor(
        SubscriptionJourneyStepCode.FINAL_VEHICLE_ALLOCATION
      )
    ).toBe("FINAL_VEHICLE_ALLOCATION");
  });
});
