export type ServiceStatus = "ok" | "degraded" | "down";

export function getStatusTone(status: ServiceStatus): "success" | "warning" | "error" {
  if (status === "ok") {
    return "success";
  }

  if (status === "degraded") {
    return "warning";
  }

  return "error";
}
