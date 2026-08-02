import { describe, expect, it } from "vitest";

import { buildMileageReviewCycle } from "../src/mileage-review/mileage-review.calendar";

describe("monthly mileage review calendar", () => {
  it.each([29, 30, 31])(
    "clamps a non-leap January %i anchor to February 28",
    (day) => {
      const cycle = buildMileageReviewCycle({
        actualDeliveryAt: new Date(`2026-01-${day}T02:15:00.000Z`),
        cycleNo: 1
      });

      expect(cycle.scheduledReviewAt).toEqual(
        new Date("2026-02-28T02:15:00.000Z")
      );
    }
  );

  it("clamps a leap-year January anchor to February 29", () => {
    const cycle = buildMileageReviewCycle({
      actualDeliveryAt: new Date("2024-01-31T02:15:00.000Z"),
      cycleNo: 1
    });

    expect(cycle.scheduledReviewAt).toEqual(
      new Date("2024-02-29T02:15:00.000Z")
    );
  });

  it("anchors every cycle directly to delivery after a shorter month", () => {
    const delivery = new Date("2026-08-31T04:30:00.000Z");

    expect(
      buildMileageReviewCycle({ actualDeliveryAt: delivery, cycleNo: 1 })
        .scheduledReviewAt
    ).toEqual(new Date("2026-09-30T04:30:00.000Z"));
    expect(
      buildMileageReviewCycle({ actualDeliveryAt: delivery, cycleNo: 2 })
        .scheduledReviewAt
    ).toEqual(new Date("2026-10-31T04:30:00.000Z"));
  });

  it("preserves the Shanghai local date and time across a UTC date boundary", () => {
    const cycle = buildMileageReviewCycle({
      actualDeliveryAt: new Date("2026-01-31T20:30:00.000Z"),
      cycleNo: 1
    });

    expect(cycle).toMatchObject({
      periodStart: new Date("2026-01-31T20:30:00.000Z"),
      scheduledReviewAt: new Date("2026-02-28T20:30:00.000Z"),
      dueAt: new Date("2026-03-01T20:30:00.000Z")
    });
  });

  it("uses an inclusive period end immediately before the review boundary", () => {
    const cycle = buildMileageReviewCycle({
      actualDeliveryAt: new Date("2026-01-31T02:15:00.000Z"),
      cycleNo: 2
    });

    expect(cycle).toEqual({
      periodStart: new Date("2026-02-28T02:15:00.000Z"),
      periodEnd: new Date("2026-03-31T02:14:59.999Z"),
      scheduledReviewAt: new Date("2026-03-31T02:15:00.000Z"),
      dueAt: new Date("2026-04-01T02:15:00.000Z")
    });
    expect(cycle.dueAt.getTime() - cycle.scheduledReviewAt.getTime()).toBe(
      24 * 60 * 60 * 1000
    );
  });

  it("rejects invalid delivery times and cycle numbers", () => {
    expect(() =>
      buildMileageReviewCycle({
        actualDeliveryAt: new Date("invalid"),
        cycleNo: 1
      })
    ).toThrow("Delivery time must be valid.");
    expect(() =>
      buildMileageReviewCycle({
        actualDeliveryAt: new Date(),
        cycleNo: 0
      })
    ).toThrow("Mileage review cycle number must be a positive integer.");
    expect(() =>
      buildMileageReviewCycle({
        actualDeliveryAt: new Date(),
        cycleNo: 1.5
      })
    ).toThrow("Mileage review cycle number must be a positive integer.");
  });
});
