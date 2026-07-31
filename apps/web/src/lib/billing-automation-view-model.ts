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
  SEND_BILL_DUE_NOTICE: "发送到期提醒",
  SEND_BILL_OVERDUE_NOTICE: "发送逾期提醒"
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
