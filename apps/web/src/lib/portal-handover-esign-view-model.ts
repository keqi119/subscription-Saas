import type {
  Stage2PortalESignBlockerCode,
  Stage2PortalESignView
} from "./portal-handover-review-api";

const SAFE_BLOCKER_MESSAGES: Record<Stage2PortalESignBlockerCode, string> = {
  CUSTOMER_CONFIRMATION_MISSING: "请先完成车辆交接资料确认",
  CUSTOMER_OBJECTION_ACTIVE: "车辆交接异议处理中，暂不能签署",
  EVIDENCE_NOT_READY: "交接资料仍在准备，暂不能签署",
  STAGE2_SIGNING_NOT_AVAILABLE: "签署暂未开放，请稍后刷新"
};

export interface PortalHandoverESignDisplay {
  blockers: string[];
  description: string;
  signedDocumentPreviewUrl: string | null;
  statusLabel: string;
  statusTone: string;
}

export function buildPortalHandoverESignView(
  status: Stage2PortalESignView
): PortalHandoverESignDisplay {
  const blockers = status.blockers.map(
    (blocker) =>
      SAFE_BLOCKER_MESSAGES[blocker.code] ??
      SAFE_BLOCKER_MESSAGES.STAGE2_SIGNING_NOT_AVAILABLE
  );

  if (
    status.archiveStatus === "ARCHIVED" &&
    status.signedArtifactAvailable
  ) {
    return {
      blockers: [],
      description: "车辆交接确认单已完成双方签署并归档。",
      signedDocumentPreviewUrl: status.signedDocumentPreviewUrl,
      statusLabel: "签署已完成",
      statusTone: "success"
    };
  }

  if (
    status.platformSigner.status === "SIGNED" ||
    status.status === "COMPLETED"
  ) {
    return {
      blockers,
      description:
        status.archiveStatus === "FAILED"
          ? "双方已完成签署，签署文件仍在处理中。"
          : "双方已完成签署，正在准备归档文件。",
      signedDocumentPreviewUrl: null,
      statusLabel: "平台盖章处理中",
      statusTone: "processing"
    };
  }

  if (status.customerSigner.status === "SIGNED") {
    return {
      blockers,
      description: "您已完成签署，正在等待平台签署。",
      signedDocumentPreviewUrl: null,
      statusLabel: "平台盖章处理中",
      statusTone: "processing"
    };
  }

  if (
    status.taskId &&
    status.status &&
    !["CANCELLED", "EXPIRED", "FAILED"].includes(status.status)
  ) {
    return {
      blockers,
      description: status.capability.canStartSigning
        ? "请核对状态后进入电子签署页面。"
        : "签署任务正在准备，请稍后刷新。",
      signedDocumentPreviewUrl: null,
      statusLabel: "待客户签署",
      statusTone: status.capability.canStartSigning ? "warning" : "default"
    };
  }

  if (status.taskId) {
    return {
      blockers: blockers.length > 0
        ? blockers
        : [SAFE_BLOCKER_MESSAGES.STAGE2_SIGNING_NOT_AVAILABLE],
      description: "当前签署任务暂不可用，请稍后刷新。",
      signedDocumentPreviewUrl: null,
      statusLabel: "签署暂不可用",
      statusTone: "default"
    };
  }

  return {
    blockers,
    description: "客户确认完成后，工作人员将发起车辆交接确认单签署。",
    signedDocumentPreviewUrl: null,
    statusLabel: "等待经办人发起签署",
    statusTone: "default"
  };
}

export function validatePortalHandoverSigningRedirect(signUrl: string) {
  try {
    const redirect = new URL(signUrl);
    const isDevelopmentLoopback =
      process.env.NODE_ENV !== "production" &&
      redirect.protocol === "http:" &&
      isLoopbackHost(redirect.hostname);
    if (
      (redirect.protocol !== "https:" && !isDevelopmentLoopback) ||
      redirect.username ||
      redirect.password
    ) {
      throw new Error("unsafe signing redirect");
    }
    return redirect.href;
  } catch {
    throw new Error("签署链接无效，请稍后重试");
  }
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}
