import { DebitRetrySlot } from "@prisma/client";

const CHINA_TIME_OFFSET_MINUTES = 8 * 60;

export interface DebitRunSlot {
  availableAt: Date;
  retrySlot: DebitRetrySlot;
}

export function buildDebitRunSchedule(
  dueDate: Date,
  runTime: string
): DebitRunSlot[] {
  assertValidDate(dueDate);
  const { hour, minute } = parseRunTime(runTime);
  const localDate = new Date(
    dueDate.getTime() + CHINA_TIME_OFFSET_MINUTES * 60_000
  );
  const year = localDate.getUTCFullYear();
  const month = localDate.getUTCMonth();
  const day = localDate.getUTCDate();

  return [
    slot(DebitRetrySlot.DUE, 0),
    slot(DebitRetrySlot.D1, 1),
    slot(DebitRetrySlot.D3, 3)
  ];

  function slot(retrySlot: DebitRetrySlot, days: number) {
    return {
      availableAt: new Date(
        Date.UTC(
          year,
          month,
          day + days,
          hour - CHINA_TIME_OFFSET_MINUTES / 60,
          minute
        )
      ),
      retrySlot
    };
  }
}

export function debitJobKey(billId: string, retrySlot: DebitRetrySlot) {
  return `debit:${billId}:${retrySlot}`;
}

function parseRunTime(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (
    !match ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new RangeError("Auto debit run time must use valid HH:mm format.");
  }
  return { hour, minute };
}

function assertValidDate(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("Auto debit due date must be valid.");
  }
}
