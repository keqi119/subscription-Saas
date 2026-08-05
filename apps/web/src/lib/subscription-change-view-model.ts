import type {
  AdminSubscriptionChange,
  AdminSubscriptionChangeQuote
} from "./subscription-change-api";

export type SubscriptionChangeNextActionKind =
  | "QUOTE"
  | "APPROVE_PRICE"
  | "WAIT_CUSTOMER"
  | "GENERATE_CONTRACT"
  | "START_ESIGN"
  | "WAIT_ARCHIVE"
  | "WAIT_EFFECTIVE"
  | "RETRY"
  | "MANUAL"
  | "DONE";

export interface SubscriptionChangeNextAction {
  enabled: boolean;
  kind: SubscriptionChangeNextActionKind;
  label: string;
  reason?: string;
}

const RETRYABLE_EXTENSION_JOB_TYPES = new Set([
  "EXTENSION_SEGMENT_ACTIVATE",
  "EXTENSION_BILLING_RESUME",
  "EXTENSION_ENTITLEMENT_RENEW",
  "EXTENSION_EFFECTIVE_NOTICE"
]);

export function getSubscriptionChangeNextAction(
  change: AdminSubscriptionChange
): SubscriptionChangeNextAction {
  switch (change.status) {
    case "DRAFT":
      return { enabled: true, kind: "QUOTE", label: "生成正式报价" };
    case "QUOTED":
      if (!change.currentQuote) {
        return { enabled: true, kind: "QUOTE", label: "生成正式报价" };
      }
      if (
        change.currentQuote.status !== "FORMAL" ||
        new Date(change.currentQuote.validUntil).getTime() <= Date.now()
      ) {
        return { enabled: true, kind: "QUOTE", label: "更新正式报价" };
      }
      if (
        change.pricingMode !== "CURRENT_VERSION" &&
        (!change.priceOverrideApprovedAt || !change.priceOverrideApprovedBy)
      ) {
        return { enabled: true, kind: "APPROVE_PRICE", label: "审批价格例外" };
      }
      return change.customerConfirmationPublishedAt
        ? {
            enabled: false,
            kind: "WAIT_CUSTOMER",
            label: "等待客户确认",
            reason: "报价已发布，等待客户在 Portal 确认当前 revision。"
          }
        : { enabled: true, kind: "WAIT_CUSTOMER", label: "发布给客户确认" };
    case "CUSTOMER_CONFIRMED":
      return change.contract
        ? { enabled: true, kind: "START_ESIGN", label: "发起电子签" }
        : { enabled: true, kind: "GENERATE_CONTRACT", label: "生成补充协议" };
    case "SIGNING_OR_PAYMENT":
      if (!change.contract) {
        return {
          enabled: false,
          kind: "MANUAL",
          label: "需要人工接管",
          reason: "签约状态缺少补充协议，请核查合同生成记录。"
        };
      }
      if (change.contract.status === "GENERATED" || change.contract.status === "PENDING_SIGN") {
        return { enabled: true, kind: "START_ESIGN", label: "发起电子签" };
      }
      if (change.contract.status === "ARCHIVED") {
        return { enabled: false, kind: "WAIT_EFFECTIVE", label: "等待续期生效" };
      }
      return {
        enabled: false,
        kind: "WAIT_ARCHIVE",
        label: "等待签署归档",
        reason: "补充协议进入电子签流程后，只能通过签署和归档事件推进。"
      };
    case "SCHEDULED":
    case "EXECUTING":
      return {
        enabled: false,
        kind: "WAIT_EFFECTIVE",
        label: change.status === "SCHEDULED" ? "等待续期生效" : "续期生效处理中"
      };
    case "FAILED":
      return getLatestFailedSubscriptionChangeJob(change)
        ? { enabled: true, kind: "RETRY", label: "重试失败任务" }
        : {
            enabled: false,
            kind: "MANUAL",
            label: "需要人工接管",
            reason: change.failureMessage ?? "没有可安全重试的失败任务。"
          };
    case "MANUAL_TAKEOVER":
      return getLatestFailedSubscriptionChangeJob(change)
        ? {
            enabled: true,
            kind: "RETRY",
            label: "重试失败任务",
            reason: change.manualTakeoverReason ?? change.failureMessage ?? undefined
          }
        : {
            enabled: false,
            kind: "MANUAL",
            label: "需要人工接管",
            reason: change.manualTakeoverReason ?? change.failureMessage ?? undefined
          };
    case "COMPLETED":
      return { enabled: false, kind: "DONE", label: "续期已完成" };
    case "CANCELLED":
      return { enabled: false, kind: "DONE", label: "变更已取消" };
  }
}

export function getSubscriptionChangeContractDates(change: AdminSubscriptionChange) {
  return {
    contractedThrough: change.targetSegment?.endDate ?? change.sourceSegment.endDate,
    originalEndDate: change.sourceSegment.endDate,
    proposedEndDate: change.targetEndDate
  };
}

export function getSubscriptionChangePriceApproval(change: AdminSubscriptionChange) {
  const quote = change.currentQuote;
  if (!quote) return null;
  const baseline = snapshotAmount(quote.priceRuleSnapshot, "baselineMonthlyFeeAmount") ??
    snapshotAmount(quote.quoteSnapshot, "baselineMonthlyFeeAmount") ??
    (change.pricingMode === "ORIGINAL_PRICE" ? change.sourceSegment.monthlyFeeAmount : null);
  return {
    approvedBy: change.priceOverrideApprovedBy,
    baselineMonthlyFeeAmount: baseline,
    createdBy: quote.createdBy ?? null,
    differenceAmount: baseline
      ? (BigInt(quote.monthlyFeeAmount) - BigInt(baseline)).toString()
      : null,
    proposedMonthlyFeeAmount: quote.monthlyFeeAmount,
    reason: change.priceOverrideReason
  };
}

export function getLatestFailedSubscriptionChangeJob(change: AdminSubscriptionChange) {
  return change.automationJobs.find(
    (job) =>
      job.jobStatus === "DEAD_LETTER" && RETRYABLE_EXTENSION_JOB_TYPES.has(job.jobType)
  ) ?? null;
}

export function getLatestESignFailure(tasks: Array<{ taskStatus: string }>) {
  return tasks.find((task) => task.taskStatus === "FAILED") ?? null;
}

export function formatSubscriptionChangeMoney(value?: string | null) {
  if (!value || !/^-?\d+$/.test(value)) return "-";
  const cents = BigInt(value);
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  const yuan = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${sign}¥${yuan.toLocaleString("zh-CN")}.${fraction}`;
}

function snapshotAmount(snapshot: AdminSubscriptionChangeQuote["priceRuleSnapshot"], key: string) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}
