const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function deriveOriginalSubscriptionPeriod(
  activatedAt: Date,
  periodMonths: number
) {
  assertActivationDate(activatedAt);
  if (!Number.isSafeInteger(periodMonths) || periodMonths <= 0) {
    throw new RangeError("SUBSCRIPTION_PERIOD_MONTHS_INVALID");
  }

  const shifted = new Date(activatedAt.getTime() + SHANGHAI_OFFSET_MS);
  const startDate = new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate()
    )
  );
  const exclusiveEnd = addMonthsClampedUtc(startDate, periodMonths);

  return {
    endDate: addDaysUtc(exclusiveEnd, -1),
    startDate
  };
}

function addMonthsClampedUtc(value: Date, months: number) {
  const targetFirstDay = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1)
  );
  const targetLastDay = new Date(
    Date.UTC(
      targetFirstDay.getUTCFullYear(),
      targetFirstDay.getUTCMonth() + 1,
      0
    )
  ).getUTCDate();

  return new Date(
    Date.UTC(
      targetFirstDay.getUTCFullYear(),
      targetFirstDay.getUTCMonth(),
      Math.min(value.getUTCDate(), targetLastDay)
    )
  );
}

function addDaysUtc(value: Date, days: number) {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate() + days
    )
  );
}

function assertActivationDate(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("SUBSCRIPTION_ACTIVATION_DATE_INVALID");
  }
}
