export interface JourneyStatusPresentation {
  color: string;
  label: string;
}

export interface AdminSubscriptionJourneyStep {
  attemptCount: number;
  code: string;
  completedAt: string | null;
  id: string;
  lastErrorCode: string | null;
  startedAt: string | null;
  status: string;
  waitingAt: string | null;
  waitingReasonSnapshot?: Record<string, unknown> | null;
}

export interface AdminSubscriptionJourneyTask {
  id: string;
  inputSnapshot: Record<string, unknown>;
  status: string;
  taskType: string;
  version: number;
}

export interface AdminSubscriptionJourney {
  application: {
    applicationNo: string;
    applicationSource?: string;
    customerId?: string;
    finalPlanSnapshot?: Record<string, unknown> | null;
    finalPlanCommercialHash?: string | null;
    finalPlanRevision?: number;
    finalVehicleId?: string | null;
    id: string;
    softReservedVehicleId?: string | null;
    status: string;
  };
  availableActions: string[];
  cancelledAt: string | null;
  completedAt: string | null;
  currentStepCode: string;
  currentStepStatus: string;
  currentTask: AdminSubscriptionJourneyTask | null;
  customerNextAction: string | null;
  events: Array<{
    actorType: string;
    createdAt: string;
    eventType: string;
    id: string;
    payload: Record<string, unknown>;
    sequence: number;
  }>;
  exceptions: AdminSubscriptionJourneyException[];
  id: string;
  jobs: Array<{
    attemptCount: number;
    availableAt: string;
    id: string;
    jobType: string;
    lastErrorCode: string | null;
    status: string;
  }>;
  order: {
    contract: { id: string; status: string } | null;
    id: string;
    orderNo: string;
    orderStatus: string;
    vehicleId: string | null;
  } | null;
  orderId: string | null;
  pausedFromStatus: string | null;
  startedAt: string;
  status: string;
  steps: AdminSubscriptionJourneyStep[];
  version: number;
}

export interface AdminSubscriptionJourneyException {
  code: string;
  firstOccurredAt: string;
  id: string;
  lastOccurredAt: string;
  message: string;
  occurrenceCount: number;
  retryable: boolean;
  status: string;
}

export interface JourneyVehicleConfirmation {
  actionLabel: string | null;
  blockedReason: string | null;
  title: string | null;
  vehicle: {
    brandAndModel: string;
    plateNo: string;
    vehicleNo: string;
    vin: string;
  };
  vehicleId: string | null;
}

const JOURNEY_STATUS_PRESENTATIONS: Record<string, JourneyStatusPresentation> = {
  CANCELLED: { color: "default", label: "已取消" },
  COMPLETED: { color: "green", label: "已完成" },
  EXCEPTION: { color: "red", label: "异常" },
  PAUSED: { color: "default", label: "已暂停" },
  RETRY_SCHEDULED: { color: "cyan", label: "等待重试" },
  RUNNING: { color: "blue", label: "进行中" },
  WAITING_CUSTOMER: { color: "gold", label: "等待客户" },
  WAITING_MANUAL: { color: "orange", label: "等待人工处理" }
};

const STEP_STATUS_PRESENTATIONS: Record<string, JourneyStatusPresentation> = {
  CANCELLED: { color: "default", label: "已取消" },
  COMPLETED: { color: "green", label: "已完成" },
  EXCEPTION: { color: "red", label: "异常" },
  PENDING: { color: "default", label: "待处理" },
  RETRY_SCHEDULED: { color: "cyan", label: "等待重试" },
  RUNNING: { color: "blue", label: "处理中" },
  SKIPPED: { color: "default", label: "已跳过" },
  WAITING_CUSTOMER: { color: "gold", label: "等待客户" },
  WAITING_MANUAL: { color: "orange", label: "等待人工" }
};

const STEP_PRESENTATIONS: Record<string, JourneyStatusPresentation> = {
  APPLICATION_VALIDATION: { color: "blue", label: "进件校验" },
  AUTHORITATIVE_ACTIVATION: { color: "blue", label: "权威事实激活" },
  CUSTOMER_JSAPI_PAYMENT: { color: "gold", label: "客户首付款" },
  CUSTOMER_PLAN_CONFIRMATION: { color: "gold", label: "客户确认最终方案" },
  DELIVERY_EVIDENCE_DECISION: { color: "orange", label: "交付证据复核" },
  FADADA_SIGNING_AND_ARCHIVE: { color: "purple", label: "法大大签署与归档" },
  FINAL_PLAN_DECISION: { color: "orange", label: "确定最终方案" },
  FINAL_VEHICLE_ALLOCATION: { color: "orange", label: "分配最终车辆" },
  HANDOVER_AND_STAGE2_CREATION: { color: "blue", label: "创建交接与二阶段合同" },
  INITIAL_BILLING: { color: "blue", label: "生成初始账单" },
  ORDER_AND_CONTRACT_CREATION: { color: "blue", label: "创建订单与合同" }
};

const SAFE_EXCEPTION_MESSAGES: Record<string, string> = {
  FADADA_ARCHIVE_FAILED: "签署文件归档失败，请检查电子签任务后重试",
  FADADA_PROVIDER_ERROR: "电子签服务暂时不可用，请检查配置或稍后重试",
  INITIAL_BILLING_FAILED: "初始账单生成失败，请检查订单财务事实",
  JOURNEY_ACTIVATION_PREREQUISITE_FAILED: "订阅激活条件尚未满足，请核对交付事实",
  PAYMENT_SETTLEMENT_FAILED: "付款核销状态异常，请核对支付与账单记录"
};

const OPERATOR_ACTION_LABELS: Record<string, string> = {
  CANCEL: "取消流程",
  DELIVERY_EVIDENCE_DECISION: "复核交付证据",
  FINAL_PLAN_DECISION: "提交最终方案",
  LEGACY_FINAL_VEHICLE_ALLOCATION: "恢复车辆分配",
  PAUSE: "暂停流程",
  RESUME: "恢复流程",
  RETRY: "重试失败步骤"
};

const ACTION_PRIORITY = [
  "FINAL_PLAN_DECISION",
  "LEGACY_FINAL_VEHICLE_ALLOCATION",
  "DELIVERY_EVIDENCE_DECISION",
  "RETRY",
  "RESUME",
  "PAUSE",
  "CANCEL"
];

export function getJourneyStatusPresentation(status: string): JourneyStatusPresentation {
  return JOURNEY_STATUS_PRESENTATIONS[status] ?? { color: "default", label: "未知状态" };
}

export function getStepStatusPresentation(status: string): JourneyStatusPresentation {
  return STEP_STATUS_PRESENTATIONS[status] ?? { color: "default", label: "未知状态" };
}

export function getSubscriptionJourneyStepPresentation(step: string): JourneyStatusPresentation {
  return STEP_PRESENTATIONS[step] ?? { color: "default", label: "未知步骤" };
}

export function getCurrentJourneyStepSummary(journey: AdminSubscriptionJourney) {
  const step = getSubscriptionJourneyStepPresentation(journey.currentStepCode);
  const status = getStepStatusPresentation(journey.currentStepStatus);
  return `${step.label} · ${status.label}`;
}

const APPLICATION_WAIT_REASON_LABELS: Record<string, string> = {
  CREDIT_REVIEW_PENDING: "信用审核",
  CREDIT_SUPPLEMENT_REQUIRED: "信用资料补充",
  DEPOSIT_CONFIRMATION_PENDING: "押金方案确认",
  MATERIAL_REVIEW_PENDING: "材料审核",
  MATERIAL_SUPPLEMENT_REQUIRED: "申请资料补充",
  PRICING_CONFIGURATION_INVALID: "价格配置处理",
  PRODUCT_SELECTION_INVALID: "订阅套餐调整",
  PRODUCT_SELECTION_REQUIRED: "订阅套餐确认",
  VEHICLE_SELECTION_INVALID: "车辆选择调整",
  VEHICLE_UNAVAILABLE: "车辆库存处理"
};

export function getApplicationValidationWaitPresentation(
  journey: AdminSubscriptionJourney
) {
  if (
    journey.currentStepCode !== "APPLICATION_VALIDATION" ||
    !["WAITING_MANUAL", "WAITING_CUSTOMER"].includes(
      journey.currentStepStatus
    )
  ) {
    return null;
  }
  const step = journey.steps.find(
    ({ code }) => code === "APPLICATION_VALIDATION"
  );
  const snapshot = readRecord(step?.waitingReasonSnapshot);
  const reasonCodes = Array.isArray(snapshot?.reasonCodes)
    ? snapshot.reasonCodes.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  const reasons = reasonCodes.map(
    (code) => APPLICATION_WAIT_REASON_LABELS[code] ?? "业务资料处理"
  );
  const waitingForCustomer =
    journey.currentStepStatus === "WAITING_CUSTOMER";
  return {
    description:
      reasons.length > 0
        ? `等待${[...new Set(reasons)].join("、")}`
        : waitingForCustomer
          ? "等待客户补充申请资料"
          : "等待人工完成进件审核",
    factVersion: readNonNegativeInteger(snapshot?.factVersion),
    title: waitingForCustomer
      ? "进件校验 · 等待客户补件"
      : "进件校验 · 等待人工",
    waitingAt: step?.waitingAt ?? null
  };
}

export function getJourneyVehicleConfirmation(
  journey: Pick<AdminSubscriptionJourney, "application" | "currentStepCode">
): JourneyVehicleConfirmation {
  const { application } = journey;
  const vehicleId = readString(application.finalVehicleId);
  const finalPlanSnapshot = readRecord(application.finalPlanSnapshot);
  const vehicleSnapshot = readRecord(finalPlanSnapshot?.vehicleSnapshot);
  const brand = readString(vehicleSnapshot?.brand);
  const model =
    readString(vehicleSnapshot?.modelDisplayNameSnapshot) ??
    readString(vehicleSnapshot?.model) ??
    readString(vehicleSnapshot?.series);
  const vehicle = {
    brandAndModel: [brand, model].filter(Boolean).join(" ") || "-",
    plateNo: readString(vehicleSnapshot?.plateNo) ?? "-",
    vehicleNo: readString(vehicleSnapshot?.vehicleNo) ?? "-",
    vin: readString(vehicleSnapshot?.vin) ?? "-"
  };

  if (!vehicleId) {
    return {
      actionLabel: null,
      blockedReason: "最终方案缺少车辆，请返回最终方案步骤选择车辆",
      title: null,
      vehicle,
      vehicleId: null
    };
  }

  const reusesSoftReservedVehicle =
    journey.currentStepCode === "FINAL_VEHICLE_ALLOCATION" &&
    application.applicationSource === "SELF_SERVICE" &&
    vehicleId === readString(application.softReservedVehicleId);

  return {
    actionLabel: reusesSoftReservedVehicle ? "确认沿用已软锁车辆" : "确认最终车辆",
    blockedReason: null,
    title: reusesSoftReservedVehicle ? "已软锁车辆" : "最终车辆",
    vehicle,
    vehicleId
  };
}

export function getCustomerWaitLabel(step: string) {
  if (step === "CUSTOMER_PLAN_CONFIRMATION") return "等待客户确认最终方案";
  if (step === "CUSTOMER_JSAPI_PAYMENT") return "等待客户完成首付款";
  if (step === "FADADA_SIGNING_AND_ARCHIVE") return "等待客户完成电子签署";
  return "等待客户继续处理";
}

export function getSafeJourneyExceptionMessage(
  exception: Pick<AdminSubscriptionJourneyException, "code" | "message">
) {
  void exception.message;
  return SAFE_EXCEPTION_MESSAGES[exception.code] ?? "自动化处理异常，请联系技术支持";
}

export type ParsedJourneyManualTaskInput =
  | {
      applicationId: string;
      finalPlanRevision: number;
      kind: "FINAL_PLAN_DECISION" | "FINAL_VEHICLE_ALLOCATION";
    }
  | {
      applicationId: string;
      finalPlanRevision: number;
      handoverId: string;
      kind: "DELIVERY_EVIDENCE_DECISION";
      manifestHash: string;
      workOrderId: string;
    }
  | { kind: "UNAVAILABLE"; reason: string };

export function parseJourneyManualTaskInput(
  task: Pick<AdminSubscriptionJourneyTask, "inputSnapshot" | "taskType">
): ParsedJourneyManualTaskInput {
  const applicationId = readString(task.inputSnapshot.applicationId);
  const finalPlanRevision = readPositiveInteger(task.inputSnapshot.finalPlanRevision);
  if (!applicationId || finalPlanRevision === null) return unavailableTask();
  if (task.taskType === "FINAL_PLAN_DECISION" || task.taskType === "FINAL_VEHICLE_ALLOCATION") {
    return { applicationId, finalPlanRevision, kind: task.taskType };
  }
  if (task.taskType === "DELIVERY_EVIDENCE_DECISION") {
    const handoverId = readString(task.inputSnapshot.handoverId);
    const manifestHash = readString(task.inputSnapshot.manifestHash);
    const workOrderId = readString(task.inputSnapshot.workOrderId);
    if (
      !handoverId ||
      !manifestHash ||
      !/^sha256:[a-f\d]{64}$/i.test(manifestHash) ||
      !workOrderId
    ) {
      return unavailableTask();
    }
    return {
      applicationId,
      finalPlanRevision,
      handoverId,
      kind: task.taskType,
      manifestHash,
      workOrderId
    };
  }
  return unavailableTask();
}

export function getRecommendedOperatorAction(journey: AdminSubscriptionJourney) {
  const action = ACTION_PRIORITY.find((candidate) => journey.availableActions.includes(candidate));
  if (!action) {
    return {
      action: null,
      label: "当前无需人工操作",
      reason: "流程正在自动推进或等待客户处理"
    };
  }
  return { action, label: OPERATOR_ACTION_LABELS[action] ?? "处理当前任务" };
}

function unavailableTask(): ParsedJourneyManualTaskInput {
  return { kind: "UNAVAILABLE", reason: "任务数据不可用，请刷新后重试" };
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function readNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
