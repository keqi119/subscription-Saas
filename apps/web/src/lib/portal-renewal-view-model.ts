import type {
  PortalRenewalConsideration,
  PortalRenewalDetail,
  PortalExtensionSubscriptionChange,
  PortalSubscriptionChange
} from "./portal-types";

export interface PortalRenewalNextAction {
  helper: string;
  href?: string;
  step:
    | "DECIDE"
    | "WAIT_QUOTE"
    | "CONFIRM_QUOTE"
    | "SIGN"
    | "WAIT_ARCHIVE"
    | "EXTENDED"
    | "RETURN";
  title: string;
}

export function getPortalRenewalNextAction(
  input: PortalRenewalDetail
): PortalRenewalNextAction {
  if (
    input.decision === "EXPIRE" ||
    input.status === "EXPIRY_CONFIRMED" ||
    input.status === "EXPIRED"
  ) {
    return {
      href: `/portal/renewals/${encodeURIComponent(input.id)}`,
      helper:
        input.status === "EXPIRED"
          ? "当前合同已到期，请按退车指引完成车辆交还。"
          : "您已选择到期结束，合同到期前仍可正常使用车辆，请提前准备退车。",
      step: "RETURN",
      title: input.status === "EXPIRED" ? "合同已到期，等待退车" : "已选择到期结束"
    };
  }

  const change = input.change;
  if (input.status === "EXTENDED" || change?.status === "COMPLETED") {
    return {
      href: change ? `/portal/subscription-changes/${encodeURIComponent(change.id)}` : undefined,
      helper: change?.targetSegment
        ? `续期已完成，当前已签约至 ${change.targetSegment.endDate}。`
        : "续期已完成，新合同分段将在约定日期生效。",
      step: "EXTENDED",
      title: "续期已完成"
    };
  }

  if (!input.decision) {
    return {
      href: `/portal/renewals/${encodeURIComponent(input.id)}`,
      helper: `请在 ${formatDateTime(input.completionDeadlineAt)} 前选择申请续订或到期结束。`,
      step: "DECIDE",
      title: "请选择到期安排"
    };
  }

  if (!change) {
    return waitForQuote(input);
  }

  switch (change.status) {
    case "QUOTED":
      return {
        href: `/portal/subscription-changes/${encodeURIComponent(change.id)}`,
        helper: change.currentQuote
          ? `请核对并确认报价 ${change.currentQuote.quoteNo}（revision ${change.currentQuote.revision}）。`
          : "报价已准备，请进入详情核对。",
        step: "CONFIRM_QUOTE",
        title: "续期报价待确认"
      };
    case "SIGNING_OR_PAYMENT":
      if (change.contractId) {
        return {
          href: `/portal/contracts/${encodeURIComponent(change.contractId)}`,
          helper: "请先查看续期补充协议，再进入现有电子签页面完成签署。",
          step: "SIGN",
          title: "续期补充协议待签署"
        };
      }
      return waitForArchive(change);
    case "SCHEDULED":
    case "EXECUTING":
      return {
        href: `/portal/subscription-changes/${encodeURIComponent(change.id)}`,
        helper: "补充协议已归档，续期将在约定起始日衔接生效。",
        step: "WAIT_ARCHIVE",
        title: "补充协议已归档，等待续期生效"
      };
    case "CUSTOMER_CONFIRMED":
      return change.contractId
        ? {
            href: `/portal/contracts/${encodeURIComponent(change.contractId)}`,
            helper: "补充协议已生成，请查看并完成签署。",
            step: "SIGN",
            title: "续期补充协议待签署"
          }
        : waitForArchive(change);
    case "CANCELLED":
      return {
        href: `/portal/renewals/${encodeURIComponent(input.id)}`,
        helper: rejectedReason(change.cancelReason)
          ? `您已拒绝上一版报价：${rejectedReason(change.cancelReason)}。请等待运营提供新报价。`
          : "当前续期变更已取消，请联系运营确认后续安排。",
        step: "WAIT_QUOTE",
        title: "等待更新续期报价"
      };
    case "DRAFT":
    case "FAILED":
    case "MANUAL_TAKEOVER":
      return waitForQuote(input);
    default:
      return waitForArchive(change);
  }
}

export function toPortalRenewalDetail(
  renewal: PortalRenewalConsideration,
  change: PortalSubscriptionChange | null
): PortalRenewalDetail {
  if (change?.changeType && change.changeType !== "EXTENSION") {
    throw new Error("A renewal consideration can only reference an extension change.");
  }
  return { ...renewal, change: change as PortalExtensionSubscriptionChange | null };
}

export function getPortalRenewalApplicationCard(input: PortalRenewalDetail) {
  const action = getPortalRenewalNextAction(input);
  return {
    label: action.title,
    message: action.helper,
    tone: action.step === "EXTENDED" ? "success" as const : action.step === "RETURN" ? "warning" as const : "info" as const,
    url: action.href ?? `/portal/renewals/${encodeURIComponent(input.id)}`
  };
}

function waitForQuote(input: Pick<PortalRenewalDetail, "id">): PortalRenewalNextAction {
  return {
    href: `/portal/renewals/${encodeURIComponent(input.id)}`,
    helper: "续订申请已提交，运营正在准备正式报价，请稍后刷新。",
    step: "WAIT_QUOTE",
    title: "等待续期报价"
  };
}

function waitForArchive(change: Pick<PortalSubscriptionChange, "id">): PortalRenewalNextAction {
  return {
    href: `/portal/subscription-changes/${encodeURIComponent(change.id)}`,
    helper: "报价已确认，平台正在生成或归档续期补充协议。",
    step: "WAIT_ARCHIVE",
    title: "等待补充协议归档"
  };
}

function rejectedReason(value: string | null) {
  const prefix = "CUSTOMER_QUOTE_REJECTED:";
  return value?.startsWith(prefix) ? value.slice(prefix.length).trim() : null;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        month: "2-digit",
        year: "numeric"
      }).format(date);
}
