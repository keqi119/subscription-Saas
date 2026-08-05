import { describe, expect, it } from "vitest";

import { renewalSchedule } from "../src/subscription-change/renewal-calendar";

describe("renewalSchedule", () => {
  it("schedules D-30, D-14 and D-3 at 09:00 Shanghai with a next-day deadline", () => {
    const schedule = renewalSchedule(new Date("2026-09-02T00:00:00.000Z"));

    expect(schedule.considerationStartAt.toISOString()).toBe("2026-08-03T01:00:00.000Z");
    expect(schedule.reminders.D30.toISOString()).toBe("2026-08-03T01:00:00.000Z");
    expect(schedule.reminders.D14.toISOString()).toBe("2026-08-19T01:00:00.000Z");
    expect(schedule.reminders.D3.toISOString()).toBe("2026-08-30T01:00:00.000Z");
    expect(schedule.completionDeadlineAt.toISOString()).toBe("2026-09-02T16:00:00.000Z");
  });

  it("uses calendar dates across month and year boundaries", () => {
    const schedule = renewalSchedule(new Date("2027-01-15T00:00:00.000Z"));

    expect(schedule.reminders.D30.toISOString()).toBe("2026-12-16T01:00:00.000Z");
    expect(schedule.completionDeadlineAt.toISOString()).toBe("2027-01-15T16:00:00.000Z");
  });
});
