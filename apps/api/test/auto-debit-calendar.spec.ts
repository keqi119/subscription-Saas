import { DebitRetrySlot } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  buildDebitRunSchedule,
  debitJobKey
} from "../src/auto-debit/auto-debit.calendar";

describe("auto debit calendar", () => {
  it("runs D, D+1, and D+3 at 09:00 Asia/Shanghai", () => {
    expect(
      buildDebitRunSchedule(
        new Date("2026-09-02T00:00:00.000Z"),
        "09:00"
      )
    ).toEqual([
      {
        availableAt: new Date("2026-09-02T01:00:00.000Z"),
        retrySlot: DebitRetrySlot.DUE
      },
      {
        availableAt: new Date("2026-09-03T01:00:00.000Z"),
        retrySlot: DebitRetrySlot.D1
      },
      {
        availableAt: new Date("2026-09-05T01:00:00.000Z"),
        retrySlot: DebitRetrySlot.D3
      }
    ]);
  });

  it("creates stable keys without time or randomness", () => {
    expect(debitJobKey("bill-1", DebitRetrySlot.DUE)).toBe(
      "debit:bill-1:DUE"
    );
    expect(debitJobKey("bill-1", DebitRetrySlot.D3)).toBe(
      "debit:bill-1:D3"
    );
  });
});
