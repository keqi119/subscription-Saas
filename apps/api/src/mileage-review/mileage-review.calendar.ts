const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const REVIEW_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface MileageReviewCycle {
  periodStart: Date;
  periodEnd: Date;
  scheduledReviewAt: Date;
  dueAt: Date;
}

export function buildMileageReviewCycle(input: {
  actualDeliveryAt: Date;
  cycleNo: number;
}): MileageReviewCycle {
  assertValidDeliveryTime(input.actualDeliveryAt);
  assertPositiveCycleNo(input.cycleNo);

  const periodStart = addShanghaiMonthsClamped(
    input.actualDeliveryAt,
    input.cycleNo - 1
  );
  const scheduledReviewAt = addShanghaiMonthsClamped(
    input.actualDeliveryAt,
    input.cycleNo
  );

  return {
    periodStart,
    periodEnd: new Date(scheduledReviewAt.getTime() - 1),
    scheduledReviewAt,
    dueAt: new Date(scheduledReviewAt.getTime() + REVIEW_GRACE_PERIOD_MS)
  };
}

function addShanghaiMonthsClamped(value: Date, months: number) {
  const local = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  const targetFirstDay = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + months, 1)
  );
  const targetYear = targetFirstDay.getUTCFullYear();
  const targetMonth = targetFirstDay.getUTCMonth();
  const targetLastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0)
  ).getUTCDate();
  const localTimestamp = Date.UTC(
    targetYear,
    targetMonth,
    Math.min(local.getUTCDate(), targetLastDay),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds()
  );

  return new Date(localTimestamp - SHANGHAI_OFFSET_MS);
}

function assertValidDeliveryTime(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("Delivery time must be valid.");
  }
}

function assertPositiveCycleNo(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      "Mileage review cycle number must be a positive integer."
    );
  }
}
