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

  const tone = ["ACTIVE", "COMPLETED"].includes(progress.overallStatus)
    ? "success"
    : ["GO_CONTRACT", "GO_PAYMENT"].includes(progress.nextAction)
      ? "warning"
      : "info";

  return {
    label: progress.nextActionTarget.label,
    message,
    tone,
    url: progress.nextActionTarget.url
  };
}
