export type PortalJourneyActionType =
  | "CONFIRM_FINAL_PLAN"
  | "CONTACT_SUPPORT"
  | "COOPERATE_HANDOVER"
  | "NONE"
  | "PAY_INITIAL_BILLS"
  | "SIGN_CONTRACT";

export interface PortalJourneyAction {
  href: string;
  label: string;
  type: PortalJourneyActionType;
}

export interface PortalSubscriptionJourney {
  blockerText: string | null;
  currentStepCode: string;
  currentStepStatus: string;
  finalPlanRevision: number;
  id: string;
  links: {
    application: string;
    bills: string[];
    contract: string | null;
    contractSign: string | null;
    order: string | null;
  };
  nextAction: Exclude<PortalJourneyAction, { type: "NONE" }> | null;
  polling: {
    enabled: boolean;
    intervalMs: number;
    maxAttempts: number;
  };
  status: string;
  version: number;
}

export interface PortalJourneyCardModel {
  action: PortalJourneyAction | null;
  description: string;
  title: string;
  tone: "error" | "info" | "success" | "warning";
}

export function nextAction(journey: PortalSubscriptionJourney): PortalJourneyAction {
  if (journey.status === "EXCEPTION") {
    return journey.nextAction ?? {
      href: "/portal/service-cases/new",
      label: "联系客户支持",
      type: "CONTACT_SUPPORT"
    };
  }
  if (
    journey.status === "COMPLETED" ||
    journey.status === "CANCELLED" ||
    journey.status === "PAUSED" ||
    journey.status === "RETRY_SCHEDULED"
  ) {
    return noAction();
  }
  if (journey.currentStepCode === "CUSTOMER_PLAN_CONFIRMATION") {
    return {
      href: journey.links.application,
      label: "确认最终方案",
      type: "CONFIRM_FINAL_PLAN"
    };
  }
  if (
    journey.currentStepCode === "FADADA_SIGNING_AND_ARCHIVE" &&
    journey.links.contractSign
  ) {
    return {
      href: journey.links.contractSign,
      label: "完成电子签署",
      type: "SIGN_CONTRACT"
    };
  }
  if (
    journey.currentStepCode === "CUSTOMER_JSAPI_PAYMENT" &&
    journey.links.order
  ) {
    return {
      href: `${journey.links.order}#bills`,
      label: "支付首期账单",
      type: "PAY_INITIAL_BILLS"
    };
  }
  if (
    journey.currentStepCode === "HANDOVER_AND_STAGE2_CREATION" &&
    journey.links.order
  ) {
    return {
      href: journey.links.order,
      label: "查看交付安排",
      type: "COOPERATE_HANDOVER"
    };
  }
  return journey.nextAction ?? noAction();
}

export function toPortalJourneyCardModel(
  journey: PortalSubscriptionJourney
): PortalJourneyCardModel {
  if (journey.status === "COMPLETED") {
    return {
      action: null,
      description: "订阅已完成交付并正式生效。",
      title: "流程已完成",
      tone: "success"
    };
  }
  if (journey.status === "EXCEPTION") {
    return {
      action: visibleAction(nextAction(journey)),
      description: journey.blockerText ?? "流程暂时受阻，请联系客户支持。",
      title: "需要协助",
      tone: "error"
    };
  }
  if (journey.status === "RETRY_SCHEDULED") {
    return {
      action: null,
      description: journey.blockerText ?? "系统正在自动重试，无需重复操作。",
      title: "正在自动重试",
      tone: "warning"
    };
  }
  if (journey.status === "WAITING_CUSTOMER") {
    return {
      action: visibleAction(nextAction(journey)),
      description: customerActionDescription(journey.currentStepCode),
      title: "需要您处理",
      tone: "warning"
    };
  }
  if (journey.status === "CANCELLED") {
    return {
      action: null,
      description: journey.blockerText ?? "该订阅流程已取消。",
      title: "流程已取消",
      tone: "info"
    };
  }
  return {
    action: visibleAction(nextAction(journey)),
    description: journey.blockerText ?? "平台正在处理当前步骤，请留意后续通知。",
    title: "平台处理中",
    tone: "info"
  };
}

export function buildPortalFinalPlanConfirmationRequest(
  finalPlanRevision: number
): RequestInit {
  if (!Number.isSafeInteger(finalPlanRevision) || finalPlanRevision < 1) {
    throw new Error("最终方案版本无效，请刷新页面后重试。");
  }
  return {
    body: JSON.stringify({ revision: finalPlanRevision }),
    method: "POST"
  };
}

function visibleAction(action: PortalJourneyAction) {
  return action.type === "NONE" ? null : action;
}

function noAction(): PortalJourneyAction {
  return { href: "", label: "", type: "NONE" };
}

function customerActionDescription(stepCode: string) {
  if (stepCode === "CUSTOMER_PLAN_CONFIRMATION") return "请核对并确认最终订阅方案。";
  if (stepCode === "CUSTOMER_JSAPI_PAYMENT") return "请核对首期账单并通过微信支付。";
  return "请进入对应页面完成当前事项。";
}
