const CHINA_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface BillingCycle {
  anchorDate: Date;
  cycleNo: number;
  dueDate: Date;
  generateAt: Date;
  overdueAt: Date;
  periodEnd: Date;
  periodStart: Date;
}

export function buildInitialBillingCycle(
  actualDeliveryAt: Date
): BillingCycle {
  return buildBillingCycleForDelivery(actualDeliveryAt, 1);
}

export function buildBillingCycleForDelivery(
  actualDeliveryAt: Date,
  cycleNo: number
): BillingCycle {
  return buildBillingCycle(toBillingBusinessDate(actualDeliveryAt), cycleNo);
}

export function buildNextBillingCycle(current: BillingCycle): BillingCycle {
  assertPositiveCycleNo(current.cycleNo);
  return buildBillingCycle(current.anchorDate, current.cycleNo + 1);
}

export function billingSourceKey(orderId: string, periodStart: Date) {
  return `monthly-rent:${orderId}:${dateKey(periodStart)}`;
}

export function dueNoticeJobKey(billId: string) {
  return `bill-due-notice:${billId}`;
}

export function overdueJobKey(billId: string, dueDate: Date) {
  return `bill-overdue:${billId}:${dateKey(addDays(dueDate, 5))}`;
}

export function overdueNoticeJobKey(billId: string) {
  return `bill-overdue-notice:${billId}`;
}

export function toBillingBusinessDate(value: Date) {
  assertValidDate(value);
  const shifted = new Date(value.getTime() + CHINA_TIME_OFFSET_MS);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate()
    )
  );
}

function buildBillingCycle(anchorDate: Date, cycleNo: number): BillingCycle {
  assertValidDate(anchorDate);
  assertPositiveCycleNo(cycleNo);

  const normalizedAnchor = dateOnly(anchorDate);
  const periodStart = addMonthsClamped(normalizedAnchor, cycleNo);
  const periodEnd = addDays(
    addMonthsClamped(normalizedAnchor, cycleNo + 1),
    -1
  );

  return {
    anchorDate: normalizedAnchor,
    cycleNo,
    dueDate: new Date(periodStart),
    generateAt: addDays(periodStart, -3),
    overdueAt: addDays(periodStart, 5),
    periodEnd,
    periodStart
  };
}

function addMonthsClamped(value: Date, months: number) {
  const targetFirstDay = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1)
  );
  const targetYear = targetFirstDay.getUTCFullYear();
  const targetMonth = targetFirstDay.getUTCMonth();
  const targetLastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0)
  ).getUTCDate();

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(value.getUTCDate(), targetLastDay)
    )
  );
}

function addDays(value: Date, days: number) {
  assertValidDate(value);
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateOnly(value: Date) {
  assertValidDate(value);
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  );
}

function dateKey(value: Date) {
  return dateOnly(value).toISOString().slice(0, 10);
}

function assertPositiveCycleNo(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Billing cycle number must be a positive integer.");
  }
}

function assertValidDate(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("Billing automation date must be valid.");
  }
}
