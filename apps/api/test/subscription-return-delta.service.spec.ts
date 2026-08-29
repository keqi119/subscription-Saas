import { describe, expect, it } from "vitest";

import {
  applyConditionDeltaDecisions,
  buildConditionDelta
} from "../src/subscription-closure/subscription-return-delta.service";

describe("return condition delta", () => {
  it("compares delivery and return quantities deterministically", () => {
    const result = buildConditionDelta({
      delivery: [
        { itemCode: "KEY", quantity: 2, state: "NORMAL" },
        { itemCode: "REGISTRATION_CERTIFICATE", quantity: 1, state: "NORMAL" }
      ],
      return: [
        { itemCode: "REGISTRATION_CERTIFICATE", quantity: 1, state: "NORMAL" },
        { itemCode: "KEY", quantity: 1, state: "MISSING" }
      ]
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        itemCode: "KEY",
        quantityDifference: -1,
        responsibility: "CUSTOMER",
        wearClassification: "MISSING"
      }),
      expect.objectContaining({
        itemCode: "REGISTRATION_CERTIFICATE",
        quantityDifference: 0,
        responsibility: "NORMAL_WEAR",
        wearClassification: "UNCHANGED"
      })
    ]);
    expect(result.resultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks mileage above the signed delivery baseline as a customer pricing input", () => {
    const result = buildConditionDelta({
      delivery: [{ itemCode: "MILEAGE", quantity: 12_000, state: "NORMAL" }],
      return: [{ itemCode: "MILEAGE", quantity: 13_250, state: "NORMAL" }]
    });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        itemCode: "MILEAGE",
        quantityDifference: 1_250,
        responsibility: "CUSTOMER",
        wearClassification: "MANUAL_REVIEW"
      })
    );
  });

  it("creates a deterministic resolved successor without mutating the base items", () => {
    const base = buildConditionDelta({
      delivery: [{ itemCode: "VEHICLE_EXTERIOR", quantity: 1, state: "NORMAL" }],
      return: [{ itemCode: "VEHICLE_EXTERIOR", quantity: 1, state: "DAMAGED" }]
    });

    const resolved = applyConditionDeltaDecisions(base.items, [
      {
        decisionReason: "现场证据与交车归档对比后确认由客户承担。",
        itemCode: "VEHICLE_EXTERIOR",
        responsibility: "CUSTOMER"
      }
    ]);

    expect(base.items[0]?.responsibility).toBe("UNDETERMINED");
    expect(resolved.items[0]).toEqual(
      expect.objectContaining({
        decisionReason: "现场证据与交车归档对比后确认由客户承担。",
        responsibility: "CUSTOMER"
      })
    );
    expect(resolved.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      applyConditionDeltaDecisions(base.items, [
        {
          decisionReason: "现场证据与交车归档对比后确认由客户承担。",
          itemCode: "VEHICLE_EXTERIOR",
          responsibility: "CUSTOMER"
        }
      ]).resultHash
    ).toBe(resolved.resultHash);
  });

  it("rejects incomplete or unrelated responsibility decisions", () => {
    const base = buildConditionDelta({
      delivery: [
        { itemCode: "VEHICLE_EXTERIOR", quantity: 1, state: "NORMAL" },
        { itemCode: "VEHICLE_INTERIOR", quantity: 1, state: "NORMAL" }
      ],
      return: [
        { itemCode: "VEHICLE_EXTERIOR", quantity: 1, state: "DAMAGED" },
        { itemCode: "VEHICLE_INTERIOR", quantity: 1, state: "DAMAGED" }
      ]
    });

    expect(() =>
      applyConditionDeltaDecisions(base.items, [
        {
          decisionReason: "仅处理一项",
          itemCode: "VEHICLE_EXTERIOR",
          responsibility: "PLATFORM"
        }
      ])
    ).toThrow("RETURN_DELTA_UNRESOLVED_RESPONSIBILITY");
    expect(() =>
      applyConditionDeltaDecisions(base.items, [
        {
          decisionReason: "不属于当前版本",
          itemCode: "KEY",
          responsibility: "CUSTOMER"
        }
      ])
    ).toThrow("RETURN_DELTA_DECISION_ITEM_MISMATCH");
  });
});
