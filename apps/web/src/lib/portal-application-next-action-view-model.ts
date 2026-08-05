import type { PortalApplicationProgress } from "./portal-types";

export interface PortalApplicationNextActionCard {
  label: string;
  message: string;
  tone: "info" | "success" | "warning";
  url: string;
}

export function buildPortalApplicationNextActionCard(
  progress: PortalApplicationProgress | undefined,
  message: string
): PortalApplicationNextActionCard | null {
  if (!progress?.nextActionTarget) {
    return null;
  }

  const tone = ["GO_CONTRACT", "GO_PAYMENT", "SUBMIT_MILEAGE_REVIEW"].includes(progress.nextAction)
      ? "warning"
    : ["ACTIVE", "COMPLETED"].includes(progress.overallStatus)
      ? "success"
      : "info";

  return {
    label: progress.nextActionTarget.label,
    message:
      progress.nextAction === "SUBMIT_MILEAGE_REVIEW"
        ? "本月里程复核待提交，请填写累计里程并上传仪表盘照片。"
        : message,
    tone,
    url: progress.nextActionTarget.url
  };
}

export function mergePortalApplicationGuidance<T>(primary: T | null, renewal: T | null): T[] {
  return [renewal, primary].filter((item): item is T => item !== null);
}
