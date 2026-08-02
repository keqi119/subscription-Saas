import { describe, expect, it } from "vitest";

import { calculateMileageSettlement } from "../src/mileage-review/mileage-review.calculator";

describe("monthly mileage settlement calculator", () => {
  it("settles a zero-usage cycle without overage", () => {
    expect(
      calculateMileageSettlement({
        baselineMileageKm: 10_000,
        submittedMileageKm: 10_000,
        allowanceKm: 1_000,
        overMileageFeeAmount: 125n
      })
    ).toEqual({
      actualUsageKm: 0,
      consumedAllowanceKm: 0,
      unusedAllowanceKm: 1_000,
      overMileageKm: 0,
      overMileageAmount: 0n
    });
  });

  it("consumes only actual mileage within the allowance", () => {
    expect(
      calculateMileageSettlement({
        baselineMileageKm: 10_000,
        submittedMileageKm: 10_250,
        allowanceKm: 1_000,
        overMileageFeeAmount: 125n
      })
    ).toEqual({
      actualUsageKm: 250,
      consumedAllowanceKm: 250,
      unusedAllowanceKm: 750,
      overMileageKm: 0,
      overMileageAmount: 0n
    });
  });

  it("settles exact allowance usage without overage", () => {
    expect(
      calculateMileageSettlement({
        baselineMileageKm: 10_000,
        submittedMileageKm: 11_000,
        allowanceKm: 1_000,
        overMileageFeeAmount: 125n
      })
    ).toMatchObject({
      actualUsageKm: 1_000,
      consumedAllowanceKm: 1_000,
      unusedAllowanceKm: 0,
      overMileageKm: 0,
      overMileageAmount: 0n
    });
  });

  it("calculates overage in integer cents", () => {
    expect(
      calculateMileageSettlement({
        baselineMileageKm: 10_000,
        submittedMileageKm: 11_550,
        allowanceKm: 1_000,
        overMileageFeeAmount: 125n
      })
    ).toEqual({
      actualUsageKm: 1_550,
      consumedAllowanceKm: 1_000,
      unusedAllowanceKm: 0,
      overMileageKm: 550,
      overMileageAmount: 68_750n
    });
  });

  it("rejects mileage regression and unsafe or negative values", () => {
    expect(() =>
      calculateMileageSettlement({
        baselineMileageKm: 10_000,
        submittedMileageKm: 9_999,
        allowanceKm: 1_000,
        overMileageFeeAmount: 125n
      })
    ).toThrow("Submitted mileage cannot be lower than the confirmed baseline.");
    expect(() =>
      calculateMileageSettlement({
        baselineMileageKm: 0,
        submittedMileageKm: Number.MAX_SAFE_INTEGER + 1,
        allowanceKm: 1_000,
        overMileageFeeAmount: 125n
      })
    ).toThrow("Mileage values must be non-negative safe integers.");
    expect(() =>
      calculateMileageSettlement({
        baselineMileageKm: 0,
        submittedMileageKm: 1,
        allowanceKm: -1,
        overMileageFeeAmount: 125n
      })
    ).toThrow("Mileage values must be non-negative safe integers.");
    expect(() =>
      calculateMileageSettlement({
        baselineMileageKm: 0,
        submittedMileageKm: 1,
        allowanceKm: 1,
        overMileageFeeAmount: -1n
      })
    ).toThrow("Over-mileage fee must be non-negative.");
  });
});
