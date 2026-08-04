import type {
  PortalAutoDebitAvailability,
  PortalBillListItem,
  PortalDebitAttempt,
  PortalDebitRetrySlot,
  PortalPaymentMandate
} from "./portal-types";

export type PortalAutoDebitViewState =
  | "DISABLED"
  | "NOT_ENROLLED"
  | "ACTIVE"
  | "PROCESSING"
  | "RETRY_SCHEDULED"
  | "FAILED_FINAL"
  | "ENDED";

export interface PortalAutoDebitView {
  canEnroll: boolean;
  canPay: boolean;
  canRevoke: boolean;
  description: string;
  helper: string;
  nextActionAt: string | null;
  state: PortalAutoDebitViewState;
  title: string;
  tone: "info" | "success" | "warning" | "error";
}

export function buildPortalAutoDebitView(input: {
  attempt?: PortalDebitAttempt | null;
  availability: PortalAutoDebitAvailability;
  bill?: PortalBillListItem | null;
  mandate?: PortalPaymentMandate | null;
}): PortalAutoDebitView {
  const canPay = input.bill?.canPay ?? true;
  if (!input.availability.enabled) {
    return view({
      canPay,
      state: "DISABLED",
      title: "自动扣款暂未开通",
      description: "当前暂不支持开通自动扣款，您仍可在账单页面主动支付。",
      helper: "待商户完成微信委托代扣能力开通后，系统会在此提供授权入口。"
    });
  }

  if (!input.mandate) {
    return view({
      canEnroll: true,
      canPay,
      state: "NOT_ENROLLED",
      title: "尚未开通自动扣款",
      description: "开通后，系统会按账单到期日自动发起扣款。",
      helper: "开通前及扣款处理期间，主动支付始终可用。"
    });
  }

  const attempt = input.attempt;
  if (attempt && ["CREATED", "SUBMITTING", "PROCESSING", "UNKNOWN"].includes(attempt.status)) {
    return view({
      canPay,
      canRevoke: input.mandate.status === "ACTIVE",
      state: "PROCESSING",
      title: "扣款结果确认中",
      description: "系统正在向支付渠道确认本次扣款结果，请勿重复操作。",
      helper: "如需立即完成账单，仍可选择主动支付；系统结算时会避免重复核销。"
    });
  }

  if (attempt?.status === "FAILED_RETRYABLE") {
    return view({
      canPay,
      canRevoke: input.mandate.status === "ACTIVE",
      state: "RETRY_SCHEDULED",
      title: "本次扣款未成功",
      description: "系统将按计划再次尝试扣款。",
      helper: "您也可以现在主动支付，成功后后续自动重试将停止。",
      nextActionAt: input.bill ? nextRetryAt(input.bill.dueDate, attempt.retrySlot) : null
    });
  }

  if (attempt?.status === "FAILED_FINAL") {
    return view({
      canPay,
      canRevoke: input.mandate.status === "ACTIVE",
      state: "FAILED_FINAL",
      title: "自动扣款已停止重试",
      description: "本期自动扣款未完成，请主动支付待付账单。",
      helper: "支付完成后，本期账单将正常核销。",
      tone: "error"
    });
  }

  if (input.mandate.status === "ACTIVE") {
    return view({
      canPay,
      canRevoke: true,
      state: "ACTIVE",
      title: "自动扣款已开通",
      description: input.bill?.canPay
        ? "系统将在账单到期日发起扣款。"
        : "授权状态正常，后续账单将按到期日发起扣款。",
      helper: "主动支付始终可用；账单提前结清后不会重复扣款。",
      nextActionAt: input.bill?.dueDate ?? null,
      tone: "success"
    });
  }

  return view({
    canEnroll: ["REVOKED", "EXPIRED", "FAILED"].includes(input.mandate.status),
    canPay,
    state: "ENDED",
    title: input.mandate.status === "PENDING" ? "自动扣款授权确认中" : "自动扣款未生效",
    description:
      input.mandate.status === "PENDING"
        ? "授权结果正在确认，请稍后刷新。"
        : "当前授权无法用于自动扣款。",
    helper: "您仍可在账单页面主动支付。",
    tone: input.mandate.status === "PENDING" ? "info" : "warning"
  });
}

export function nextRetryAt(dueDate: string | null, retrySlot: PortalDebitRetrySlot) {
  if (!dueDate || retrySlot === "D3" || retrySlot === "MANUAL") {
    return null;
  }
  const date = new Date(dueDate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const daysAfterDue = retrySlot === "DUE" ? 1 : 3;
  const retry = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + daysAfterDue, 1)
  );
  return retry.toISOString();
}

function view(
  value: Partial<PortalAutoDebitView> &
    Pick<PortalAutoDebitView, "description" | "helper" | "state" | "title">
): PortalAutoDebitView {
  return {
    canEnroll: false,
    canPay: true,
    canRevoke: false,
    nextActionAt: null,
    tone: "warning",
    ...value
  };
}
