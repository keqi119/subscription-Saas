import { NotificationType } from "@prisma/client";

export type WechatTemplateDataResult =
  | { data: Record<string, string>; error: null }
  | { data: null; error: `WECHAT_TEMPLATE_DATA_MISSING:${string}` };

interface BuildGoldenPathWechatTemplateDataInput {
  data: Record<string, unknown>;
  notificationType: NotificationType;
  now: Date;
}

const GOLDEN_PATH_NOTIFICATION_TYPES = new Set<NotificationType>([
  NotificationType.APPLICATION_PROGRESS,
  NotificationType.CONTRACT_PENDING,
  NotificationType.FINAL_PLAN_PENDING,
  NotificationType.HANDOVER_ESIGN_PENDING,
  NotificationType.PAYMENT_PENDING
]);

export function buildGoldenPathWechatTemplateData(
  input: BuildGoldenPathWechatTemplateDataInput
): WechatTemplateDataResult | null {
  if (!GOLDEN_PATH_NOTIFICATION_TYPES.has(input.notificationType)) {
    return null;
  }

  if (input.notificationType === NotificationType.APPLICATION_PROGRESS) {
    const applicationNo = requiredString(input.data, "applicationNo", "aggregateNo");
    if (!applicationNo) return missing("applicationNo");
    return success({
      character_string3: truncateCodePoints(applicationNo, 32),
      const4: "已受理",
      const5: "车辆订阅",
      time6: formatWechatTime(input.now)
    });
  }

  if (input.notificationType === NotificationType.FINAL_PLAN_PENDING) {
    const applicationNo = requiredString(input.data, "applicationNo", "aggregateNo");
    if (!applicationNo) return missing("applicationNo");
    const plateNo = requiredString(input.data, "plateNo");
    if (!plateNo) return missing("plateNo");
    return success({
      car_number8: plateNo,
      character_string2: truncateCodePoints(applicationNo, 32),
      phrase5: "待确认",
      thing13: "车辆订阅最终方案",
      time9: formatWechatTime(input.now)
    });
  }

  if (input.notificationType === NotificationType.CONTRACT_PENDING) {
    const orderNo = requiredString(input.data, "orderNo", "aggregateNo");
    if (!orderNo) return missing("orderNo");
    const modelDisplayName = requiredString(input.data, "modelDisplayName");
    if (!modelDisplayName) return missing("modelDisplayName");
    const customerName = requiredString(input.data, "customerName");
    if (!customerName) return missing("customerName");
    return success({
      character_string2: truncateCodePoints(orderNo, 32),
      thing1: truncateThing(customerName),
      thing3: truncateThing(modelDisplayName),
      thing6: "车辆订阅主合同"
    });
  }

  if (input.notificationType === NotificationType.PAYMENT_PENDING) {
    const plateNo = requiredString(input.data, "plateNo");
    if (!plateNo) return missing("plateNo");
    const amount = formatWechatAmountFromCents(input.data.initialBillAmountCents);
    if (amount === null) return missing("initialBillAmountCents");
    const remaining = formatWechatAmountFromCents(input.data.initialBillRemainingCents);
    if (remaining === null) return missing("initialBillRemainingCents");
    const dueAt = validDate(input.data.initialBillDueAt);
    if (!dueAt) return missing("initialBillDueAt");
    return success({
      amount4: amount,
      amount7: remaining,
      car_number1: plateNo,
      thing2: input.data.hasDepositBill === true ? "押金及首期租金" : "首期租金",
      time5: formatWechatTime(dueAt)
    });
  }

  const orderNo = requiredString(input.data, "orderNo", "aggregateNo");
  if (!orderNo) return missing("orderNo");
  const modelDisplayName = requiredString(input.data, "modelDisplayName");
  if (!modelDisplayName) return missing("modelDisplayName");
  const plateNo = requiredString(input.data, "plateNo");
  if (!plateNo) return missing("plateNo");
  const customerName = requiredString(input.data, "customerName");
  if (!customerName) return missing("customerName");
  return success({
    car_number5: plateNo,
    character_string1: truncateCodePoints(orderNo, 32),
    thing11: truncateThing(customerName),
    thing9: truncateThing(modelDisplayName)
  });
}

export function formatWechatAmountFromCents(value: unknown): string | null {
  try {
    const text =
      typeof value === "bigint"
        ? value.toString()
        : typeof value === "number" && Number.isSafeInteger(value)
          ? String(value)
          : typeof value === "string"
            ? value.trim()
            : "";
    if (!/^\d+$/u.test(text)) return null;
    const cents = BigInt(text);
    const yuan = cents / 100n;
    const fraction = String(cents % 100n).padStart(2, "0");
    return `${yuan}.${fraction}`;
  } catch {
    return null;
  }
}

function requiredString(data: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function validDate(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date;
}

function truncateThing(value: string) {
  return truncateCodePoints(value, 20);
}

function truncateCodePoints(value: string, length: number) {
  return Array.from(value).slice(0, length).join("");
}

function formatWechatTime(value: Date) {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function success(data: Record<string, string>): WechatTemplateDataResult {
  return { data, error: null };
}

function missing(field: string): WechatTemplateDataResult {
  return { data: null, error: `WECHAT_TEMPLATE_DATA_MISSING:${field}` };
}
