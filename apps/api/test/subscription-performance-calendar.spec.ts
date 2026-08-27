import { describe, expect, it } from "vitest";

import { deriveOriginalSubscriptionPeriod } from "../src/lease/subscription-performance-calendar";

describe("deriveOriginalSubscriptionPeriod", () => {
  it("uses the Shanghai date across a UTC boundary", () => {
    expect(
      deriveOriginalSubscriptionPeriod(
        new Date("2026-08-25T19:53:26.694Z"),
        12
      )
    ).toEqual({
      endDate: new Date("2027-08-25T00:00:00.000Z"),
      startDate: new Date("2026-08-26T00:00:00.000Z")
    });
  });

  it("clamps month ends before subtracting the inclusive final day", () => {
    expect(
      deriveOriginalSubscriptionPeriod(
        new Date("2024-01-31T04:00:00.000Z"),
        1
      )
    ).toEqual({
      endDate: new Date("2024-02-28T00:00:00.000Z"),
      startDate: new Date("2024-01-31T00:00:00.000Z")
    });
  });

  it.each([0, -1, 1.5])(
    "rejects invalid periodMonths %s",
    (periodMonths) => {
      expect(() =>
        deriveOriginalSubscriptionPeriod(new Date(), periodMonths)
      ).toThrow("SUBSCRIPTION_PERIOD_MONTHS_INVALID");
    }
  );

  it("rejects an invalid activation timestamp", () => {
    expect(() =>
      deriveOriginalSubscriptionPeriod(new Date("invalid"), 12)
    ).toThrow("SUBSCRIPTION_ACTIVATION_DATE_INVALID");
  });
});
