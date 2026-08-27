import type {
  AdminSubscriptionChange,
  AdminSubscriptionChangeQuote
} from "./subscription-change-api";

export type SubscriptionChangeNextActionKind =
  | "QUOTE"
  | "APPROVE_PRICE"
  | "APPROVE_MANAGED_OTHER"
  | "WAIT_CUSTOMER"
  | "GENERATE_CONTRACT"
  | "START_ESIGN"
  | "EXECUTE_MANAGED_OTHER"
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
  const serverDriven = Array.isArray(change.allowedActions);
  const allowed = (action: NonNullable<AdminSubscriptionChange["allowedActions"]>[number]) =>
    !serverDriven || change.allowedActions!.includes(action);
  const blocked = (): SubscriptionChangeNextAction => ({
    enabled: false,
    kind: "MANUAL",
    label: "等待后台开放操作",
    reason: "当前状态未开放人工操作"
  });
  switch (change.status) {
    case "DRAFT": {
      if (change.changeType === "MANAGED_OTHER") {
        return allowed("APPROVE")
          ? { enabled: true, kind: "APPROVE_MANAGED_OTHER", label: "审批受控变更" }
          : blocked();
      }
      return allowed("CREATE_QUOTE")
        ? {
            enabled: true,
            kind: "QUOTE",
            label:
              change.changeType === "VEHICLE_SWAP"
                ? "生成换车报价"
                : change.changeType === "EARLY_TERMINATION"
                  ? "生成提前结束试算"
                  : "生成正式报价"
          }
        : blocked();
    }
    case "QUOTED":
      if (change.changeType === "EARLY_TERMINATION") {
        if (allowed("PUBLISH_CUSTOMER_CONFIRMATION")) {
          return { enabled: true, kind: "WAIT_CUSTOMER", label: "发布提前结束方案" };
        }
        return change.customerConfirmationPublishedAt
          ? {
              enabled: false,
              kind: "WAIT_CUSTOMER",
              label: "等待客户确认提前结束方案"
            }
          : blocked();
      }
      if (!change.currentQuote) {
        return allowed("CREATE_QUOTE")
          ? {
              enabled: true,
              kind: "QUOTE",
              label: change.changeType === "VEHICLE_SWAP" ? "生成换车报价" : "生成正式报价"
            }
          : blocked();
      }
      if (
        change.currentQuote.status !== "FORMAL" ||
        new Date(change.currentQuote.validUntil).getTime() <= Date.now()
      ) {
        return allowed("CREATE_QUOTE")
          ? { enabled: true, kind: "QUOTE", label: "更新正式报价" }
          : blocked();
      }
      if (
        change.changeType === "EXTENSION" &&
        change.pricingMode !== "CURRENT_VERSION" &&
        (!change.priceOverrideApprovedAt || !change.priceOverrideApprovedBy)
      ) {
        return allowed("APPROVE")
          ? { enabled: true, kind: "APPROVE_PRICE", label: "审批价格例外" }
          : blocked();
      }
      if (change.customerConfirmationPublishedAt) {
        return {
          enabled: false,
          kind: "WAIT_CUSTOMER",
          label: "等待客户确认",
          reason: "报价已发布，等待客户在 Portal 确认当前 revision。"
        };
      }
      return allowed("PUBLISH_CUSTOMER_CONFIRMATION")
        ? {
            enabled: true,
            kind: "WAIT_CUSTOMER",
            label: change.changeType === "VEHICLE_SWAP" ? "发布换车方案" : "发布给客户确认"
          }
        : blocked();
    case "CUSTOMER_CONFIRMED":
      return change.contract
        ? allowed("START_ESIGN")
          ? { enabled: true, kind: "START_ESIGN", label: "发起电子签" }
          : blocked()
        : allowed("GENERATE_CONTRACT")
          ? {
            enabled: true,
            kind: "GENERATE_CONTRACT",
            label: change.changeType === "EARLY_TERMINATION" ? "生成提前结束协议" : "生成补充协议"
            }
          : blocked();
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
        return allowed("START_ESIGN")
          ? { enabled: true, kind: "START_ESIGN", label: "发起电子签" }
          : blocked();
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
      if (change.changeType === "MANAGED_OTHER") {
        return allowed("EXECUTE")
          ? {
              enabled: true,
              kind: "EXECUTE_MANAGED_OTHER",
              label: "记录受控变更结果"
            }
          : blocked();
      }
      return {
        enabled: false,
        kind: "WAIT_EFFECTIVE",
        label:
          change.changeType === "VEHICLE_SWAP"
            ? "等待换车工单完成"
            : change.changeType === "EARLY_TERMINATION"
              ? "等待提前结束生效"
              : "等待续期生效"
      };
    case "EXECUTING":
      return {
        enabled: false,
        kind: "WAIT_EFFECTIVE",
        label:
          change.changeType === "VEHICLE_SWAP"
            ? "换车执行处理中"
            : change.changeType === "EARLY_TERMINATION"
              ? "提前结束处理中"
              : "续期生效处理中"
      };
    case "FAILED":
      return allowed("RETRY") && getLatestFailedSubscriptionChangeJob(change)
        ? { enabled: true, kind: "RETRY", label: "重试失败任务" }
        : serverDriven
          ? blocked()
          : {
            enabled: false,
            kind: "MANUAL",
            label: "需要人工接管",
            reason: change.failureMessage ?? "没有可安全重试的失败任务。"
            };
    case "MANUAL_TAKEOVER":
      return allowed("RETRY") && getLatestFailedSubscriptionChangeJob(change)
        ? {
            enabled: true,
            kind: "RETRY",
            label: "重试失败任务",
            reason: change.manualTakeoverReason ?? change.failureMessage ?? undefined
          }
        : serverDriven
          ? blocked()
          : {
            enabled: false,
            kind: "MANUAL",
            label: "需要人工接管",
            reason: change.manualTakeoverReason ?? change.failureMessage ?? undefined
            };
    case "COMPLETED":
      return {
        enabled: false,
        kind: "DONE",
        label:
          change.changeType === "VEHICLE_SWAP"
            ? "换车已完成"
            : change.changeType === "EARLY_TERMINATION"
              ? "提前结束已进入退车闭环"
              : change.changeType === "MANAGED_OTHER"
                ? "受控变更已完成"
                : "续期已完成"
      };
    case "CANCELLED":
      return { enabled: false, kind: "DONE", label: "变更已取消" };
  }
}

export function getSubscriptionChangeContractDates(change: AdminSubscriptionChange) {
  return {
    contractedThrough: change.targetSegment?.endDate ?? change.sourceSegment?.endDate ?? null,
    originalEndDate: change.sourceSegment?.endDate ?? null,
    proposedEndDate: change.targetEndDate ?? null
  };
}

export function getSubscriptionChangePriceApproval(change: AdminSubscriptionChange) {
  if (change.changeType !== "EXTENSION" || !change.pricingMode) return null;
  const quote = change.currentQuote;
  if (!quote) return null;
  const baseline = snapshotAmount(quote.priceRuleSnapshot, "baselineMonthlyFeeAmount") ??
    snapshotAmount(quote.quoteSnapshot, "baselineMonthlyFeeAmount") ??
    (change.pricingMode === "ORIGINAL_PRICE" ? change.sourceSegment?.monthlyFeeAmount ?? null : null);
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
