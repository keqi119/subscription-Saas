import { describe, expect, it } from "vitest";

import {
  allowedSubscriptionClosureTransitions,
  assertSubscriptionClosureEscalation,
  assertSubscriptionClosureTransition,
  canonicalSubscriptionClosureJson,
  canonicalSubscriptionClosureSource,
  freezeSubscriptionClosureOutcome,
  hashSubscriptionClosureSnapshot
} from "../src/subscription-closure/subscription-closure.domain";

describe("subscription closure domain contract", () => {
  it("canonicalizes source identity before locks, payloads, and lookups", () => {
    expect(
      canonicalSubscriptionClosureSource({
        id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
        key: "  expiry:2026-08-21  ",
        type: "  SUBSCRIPTION_EXPIRY  "
      })
    ).toEqual({
      id: "a06e8ee8-3d7d-4aa1-b463-59a64f66f890",
      key: "expiry:2026-08-21",
      type: "SUBSCRIPTION_EXPIRY"
    });

    expect(() =>
      canonicalSubscriptionClosureSource({ id: "not-uuid", key: "x", type: "T" })
    ).toThrow(/source\.id/i);
    expect(() =>
      canonicalSubscriptionClosureSource({
        id: "a06e8ee8-3d7d-4aa1-b463-59a64f66f890",
        key: " ",
        type: "T"
      })
    ).toThrow(/source\.key/i);
  });

  it("canonicalizes JSON independently of key order without invoking accessors", () => {
    expect(
      canonicalSubscriptionClosureJson({
        z: 2n,
        nested: { when: new Date("2026-08-21T02:03:04.000Z"), a: true },
        ignored: undefined
      })
    ).toBe('{"nested":{"a":true,"when":"2026-08-21T02:03:04.000Z"},"z":"2"}');
    expect(hashSubscriptionClosureSnapshot({ b: 2, a: 1 })).toBe(
      hashSubscriptionClosureSnapshot({ a: 1, b: 2 })
    );

    const withGetter = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(withGetter, "secret", { enumerable: true, get: () => "leak" });
    expect(() => canonicalSubscriptionClosureJson(withGetter)).toThrow(/accessor/i);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalSubscriptionClosureJson(cyclic)).toThrow(/cycle/i);
    expect(() => canonicalSubscriptionClosureJson({ amount: Number.NaN })).toThrow(/finite/i);
  });

  it("returns a recursively frozen JSON-safe outcome without BigInt or mutable Date values", () => {
    const input = {
      amountCents: 9223372036854775807n,
      at: new Date("2026-08-21T02:03:04.000Z"),
      nested: { values: [1, { ok: true }] }
    };

    const outcome = freezeSubscriptionClosureOutcome(input);

    expect(outcome).toEqual({
      amountCents: "9223372036854775807",
      at: "2026-08-21T02:03:04.000Z",
      nested: { values: [1, { ok: true }] }
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen((outcome as { nested: object }).nested)).toBe(true);
    expect(Object.isFrozen((outcome as { nested: { values: object } }).nested.values)).toBe(true);
    expect(() => {
      (outcome as { amountCents: string }).amountCents = "0";
    }).toThrow();
  });

  it("pins normal voluntary completion and early voluntary termination transitions", () => {
    expect(
      allowedSubscriptionClosureTransitions({
        closureType: "NORMAL_COMPLETION",
        finalDisposition: "COMPLETE",
        physicalControlMode: "VOLUNTARY_RETURN"
      }).PREPARING_RETURN
    ).toEqual(["RETURN_INSPECTION", "CANCELLED", "MANUAL_TAKEOVER"]);
    expect(() =>
      assertSubscriptionClosureTransition(
        {
          closureType: "NORMAL_COMPLETION",
          finalDisposition: "COMPLETE",
          physicalControlMode: "VOLUNTARY_RETURN"
        },
        "PENDING_SETTLEMENT",
        "TERMINATED"
      )
    ).toThrow(/transition/i);

    expect(() =>
      assertSubscriptionClosureTransition(
        {
          closureType: "EARLY_TERMINATION",
          finalDisposition: "TERMINATE",
          physicalControlMode: "VOLUNTARY_RETURN"
        },
        "PENDING_SETTLEMENT",
        "TERMINATED"
      )
    ).not.toThrow();
  });

  it("pins recovery transitions for normal escalation and early recovery initiation", () => {
    for (const closureType of ["NORMAL_COMPLETION", "EARLY_TERMINATION"] as const) {
      expect(() =>
        assertSubscriptionClosureTransition(
          {
            closureType,
            finalDisposition: "TERMINATE",
            physicalControlMode: "RECOVERY"
          },
          "RECOVERY_APPROVED",
          "RECOVERY_IN_PROGRESS"
        )
      ).not.toThrow();
      expect(() =>
        assertSubscriptionClosureTransition(
          {
            closureType,
            finalDisposition: "TERMINATE",
            physicalControlMode: "RECOVERY"
          },
          "RECOVERY_IN_PROGRESS",
          "COMPLETED"
        )
      ).toThrow(/transition/i);
    }
  });

  it("allows only the approved normal voluntary-to-recovery escalation", () => {
    expect(() =>
      assertSubscriptionClosureEscalation(
        {
          closureType: "NORMAL_COMPLETION",
          finalDisposition: "COMPLETE",
          physicalControlMode: "VOLUNTARY_RETURN",
          physicalControlledAt: null,
          status: "PREPARING_RETURN"
        },
        {
          closureType: "NORMAL_COMPLETION",
          finalDisposition: "TERMINATE",
          physicalControlMode: "RECOVERY"
        }
      )
    ).not.toThrow();

    expect(() =>
      assertSubscriptionClosureEscalation(
        {
          closureType: "EARLY_TERMINATION",
          finalDisposition: "TERMINATE",
          physicalControlMode: "VOLUNTARY_RETURN",
          physicalControlledAt: null,
          status: "PREPARING_RETURN"
        },
        {
          closureType: "EARLY_TERMINATION",
          finalDisposition: "TERMINATE",
          physicalControlMode: "RECOVERY"
        }
      )
    ).toThrow(/escalation/i);
  });

  it("rejects recovery escalation from every source state except uncontrolled PREPARING_RETURN", () => {
    const after = {
      closureType: "NORMAL_COMPLETION",
      finalDisposition: "TERMINATE",
      physicalControlMode: "RECOVERY"
    } as const;
    for (const status of [
      "RECOVERY_ASSESSMENT_PENDING",
      "RECOVERY_APPROVAL_PENDING",
      "RECOVERY_APPROVED",
      "RECOVERY_IN_PROGRESS",
      "VEHICLE_SECURED",
      "RETURN_INSPECTION",
      "RECONDITIONING",
      "PENDING_SETTLEMENT",
      "COMPLETED",
      "TERMINATED",
      "REJECTED",
      "PAUSED",
      "CANCELLED",
      "MANUAL_TAKEOVER"
    ] as const) {
      expect(() =>
        assertSubscriptionClosureEscalation(
          {
            closureType: "NORMAL_COMPLETION",
            finalDisposition: "COMPLETE",
            physicalControlMode: "VOLUNTARY_RETURN",
            physicalControlledAt: null,
            status
          },
          after
        )
      ).toThrow(/escalation/i);
    }
    expect(() =>
      assertSubscriptionClosureEscalation(
        {
          closureType: "NORMAL_COMPLETION",
          finalDisposition: "COMPLETE",
          physicalControlMode: "VOLUNTARY_RETURN",
          physicalControlledAt: new Date("2026-08-21T03:00:00.000Z"),
          status: "PREPARING_RETURN"
        },
        after
      )
    ).toThrow(/escalation/i);
  });

  it("rejects history-free pause entry and every generic pause resume target", () => {
    const normal = {
      closureType: "NORMAL_COMPLETION",
      finalDisposition: "COMPLETE",
      physicalControlMode: "VOLUNTARY_RETURN"
    } as const;
    const recovery = {
      closureType: "EARLY_TERMINATION",
      finalDisposition: "TERMINATE",
      physicalControlMode: "RECOVERY"
    } as const;

    expect(() => assertSubscriptionClosureTransition(normal, "PREPARING_RETURN", "PAUSED")).toThrow(
      /transition/i
    );
    expect(() =>
      assertSubscriptionClosureTransition(normal, "PAUSED", "PENDING_SETTLEMENT")
    ).toThrow(/transition/i);
    for (const target of [
      "RECOVERY_APPROVAL_PENDING",
      "RECOVERY_IN_PROGRESS",
      "VEHICLE_SECURED",
      "PENDING_SETTLEMENT"
    ] as const) {
      expect(() => assertSubscriptionClosureTransition(recovery, "PAUSED", target)).toThrow(
        /transition/i
      );
    }
  });
});
