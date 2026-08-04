export interface StatusView {
  color: string;
  label: string;
}

const scheduleStatuses: Record<string, StatusView> = {
  ACTIVE: { color: "green", label: "运行中" },
  CANCELLED: { color: "default", label: "已取消" },
  COMPLETED: { color: "blue", label: "已完成" },
  PAUSED: { color: "orange", label: "已暂停" }
};

const jobStatuses: Record<string, StatusView> = {
  CANCELLED: { color: "default", label: "已取消" },
  COMPLETED: { color: "green", label: "已完成" },
  DEAD_LETTER: { color: "red", label: "需人工处理" },
  PENDING: { color: "blue", label: "待执行" },
  PROCESSING: { color: "gold", label: "执行中" }
};

const jobTypes: Record<string, string> = {
  GENERATE_MONTHLY_RENT_BILL: "生成月租账单",
  MARK_BILL_OVERDUE: "确认账单逾期",
  QUERY_DEBIT_ATTEMPT: "查询扣款结果",
  SEND_BILL_DUE_NOTICE: "发送到期提醒",
  SEND_BILL_OVERDUE_NOTICE: "发送逾期提醒",
  SEND_DEBIT_FAILURE_NOTICE: "发送扣款失败通知",
  SUBMIT_BILL_DEBIT: "发起自动扣款",
  SYNC_PAYMENT_MANDATE: "同步扣款授权"
};

const autoDebitMandateStatuses: Record<string, StatusView> = {
  ACTIVE: { color: "green", label: "已生效" },
  EXPIRED: { color: "default", label: "已过期" },
  FAILED: { color: "red", label: "授权失败" },
  PENDING: { color: "blue", label: "待确认" },
  REVOKED: { color: "default", label: "已解约" },
  SUSPENDED: { color: "orange", label: "已暂停" }
};

const autoDebitAttemptStatuses: Record<string, StatusView> = {
  CANCELLED: { color: "default", label: "已取消" },
  CREATED: { color: "blue", label: "待提交" },
  FAILED_FINAL: { color: "red", label: "最终失败" },
  FAILED_RETRYABLE: { color: "orange", label: "待重试" },
  PROCESSING: { color: "blue", label: "处理中" },
  SUBMITTING: { color: "cyan", label: "提交中" },
  SUCCEEDED: { color: "green", label: "已成功" },
  UNKNOWN: { color: "gold", label: "结果不明" }
};

export function scheduleStatusView(status?: string | null) {
  return (
    (status ? scheduleStatuses[status] : undefined) ?? {
      color: "default",
      label: "未知状态"
    }
  );
}

export function jobStatusView(status?: string | null) {
  return (
    (status ? jobStatuses[status] : undefined) ?? {
      color: "default",
      label: "未知状态"
    }
  );
}

export function jobTypeLabel(jobType?: string | null) {
  return jobType ? (jobTypes[jobType] ?? "未知任务") : "-";
}

export function autoDebitMandateStatusView(status?: string | null) {
  return statusView(autoDebitMandateStatuses, status);
}

export function autoDebitAttemptStatusView(status?: string | null) {
  return statusView(autoDebitAttemptStatuses, status);
}

export function isAutoDebitJobType(jobType?: string | null) {
  return Boolean(
    jobType &&
    [
      "QUERY_DEBIT_ATTEMPT",
      "SEND_DEBIT_FAILURE_NOTICE",
      "SUBMIT_BILL_DEBIT",
      "SYNC_PAYMENT_MANDATE"
    ].includes(jobType)
  );
}

export function buildAutoDebitSummaryView(
  input?: {
    attempts: Record<string, number>;
    deadLetterCount: number;
    mandates: Record<string, number>;
    unallocatedPayments: { amount: string; count: number };
    unknownCount: number;
  } | null
) {
  const attempts = input?.attempts ?? {};
  const mandates = input?.mandates ?? {};
  return {
    activeMandates: mandates.ACTIVE ?? 0,
    failedAttempts: (attempts.FAILED_RETRYABLE ?? 0) + (attempts.FAILED_FINAL ?? 0),
    pendingMandates: mandates.PENDING ?? 0,
    processingAttempts:
      (attempts.CREATED ?? 0) + (attempts.SUBMITTING ?? 0) + (attempts.PROCESSING ?? 0),
    unknownAttempts: input?.unknownCount ?? attempts.UNKNOWN ?? 0,
    unallocatedAmount: safeInteger(input?.unallocatedPayments.amount),
    unallocatedCount: input?.unallocatedPayments.count ?? 0
  };
}

export function formatAutomationDate(value?: string | null) {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }
  const parts = new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric"
  })
    .formatToParts(parsed)
    .reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function automationErrorText(code?: string | null, message?: string | null) {
  void message;
  switch (code) {
    case "BILLING_CONFIGURATION_ERROR":
      return "账单自动化配置不完整，请修复后重试。";
    case "BILLING_EXECUTION_ERROR":
      return "账单自动化执行失败，可稍后重试。";
    default:
      return code ? "自动化任务执行失败，请检查配置或重试。" : "-";
  }
}

function statusView(statuses: Record<string, StatusView>, status?: string | null) {
  return (
    (status ? statuses[status] : undefined) ?? {
      color: "default",
      label: "未知状态"
    }
  );
}

function safeInteger(value?: string) {
  if (!value || !/^-?\d+$/.test(value)) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}
