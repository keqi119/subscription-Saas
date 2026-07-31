import { describe, expect, it } from "vitest";

import {
  billingSourceKey,
  buildInitialBillingCycle,
  buildNextBillingCycle,
  dueNoticeJobKey,
  overdueJobKey,
  overdueNoticeJobKey
} from "../src/billing-automation/billing-automation.calendar";

describe("billing automation calendar", () => {
  it("keeps the delivery-day anchor across a shorter month", () => {
    const first = buildInitialBillingCycle(
      new Date("2026-01-31T03:00:00.000Z")
    );
    const second = buildNextBillingCycle(first);

    expect(first).toMatchObject({
      anchorDate: new Date("2026-01-31T00:00:00.000Z"),
      cycleNo: 1,
      dueDate: new Date("2026-02-28T00:00:00.000Z"),
      generateAt: new Date("2026-02-25T00:00:00.000Z"),
      overdueAt: new Date("2026-03-05T00:00:00.000Z"),
      periodEnd: new Date("2026-03-30T00:00:00.000Z"),
      periodStart: new Date("2026-02-28T00:00:00.000Z")
    });
    expect(second).toMatchObject({
      anchorDate: new Date("2026-01-31T00:00:00.000Z"),
      cycleNo: 2,
      dueDate: new Date("2026-03-31T00:00:00.000Z"),
      generateAt: new Date("2026-03-28T00:00:00.000Z"),
      overdueAt: new Date("2026-04-05T00:00:00.000Z"),
      periodEnd: new Date("2026-04-29T00:00:00.000Z"),
      periodStart: new Date("2026-03-31T00:00:00.000Z")
    });
  });

  it("uses the China business date when activation crosses UTC midnight", () => {
    const cycle = buildInitialBillingCycle(
      new Date("2026-01-31T20:30:00.000Z")
    );

    expect(cycle).toMatchObject({
      anchorDate: new Date("2026-02-01T00:00:00.000Z"),
      dueDate: new Date("2026-03-01T00:00:00.000Z"),
      generateAt: new Date("2026-02-26T00:00:00.000Z"),
      periodEnd: new Date("2026-03-31T00:00:00.000Z"),
      periodStart: new Date("2026-03-01T00:00:00.000Z")
    });
  });

  it("clamps a leap-year January anchor to February 29", () => {
    const cycle = buildInitialBillingCycle(
      new Date("2024-01-31T00:00:00.000Z")
    );

    expect(cycle.periodStart).toEqual(
      new Date("2024-02-29T00:00:00.000Z")
    );
    expect(cycle.periodEnd).toEqual(
      new Date("2024-03-30T00:00:00.000Z")
    );
  });

  it("rejects non-positive or non-integer cycle numbers", () => {
    const first = buildInitialBillingCycle(
      new Date("2026-06-10T02:00:00.000Z")
    );

    expect(() => buildNextBillingCycle({ ...first, cycleNo: 0 })).toThrow(
      "Billing cycle number must be a positive integer."
    );
    expect(() => buildNextBillingCycle({ ...first, cycleNo: 1.5 })).toThrow(
      "Billing cycle number must be a positive integer."
    );
  });

  it("generates stable business keys from normalized business dates", () => {
    expect(
      billingSourceKey(
        "order-1",
        new Date("2026-02-28T00:00:00.000Z")
      )
    ).toBe("monthly-rent:order-1:2026-02-28");
    expect(dueNoticeJobKey("bill-1")).toBe("bill-due-notice:bill-1");
    expect(
      overdueJobKey("bill-1", new Date("2026-02-28T00:00:00.000Z"))
    ).toBe("bill-overdue:bill-1:2026-03-05");
    expect(overdueNoticeJobKey("bill-1")).toBe(
      "bill-overdue-notice:bill-1"
    );
  });
});
