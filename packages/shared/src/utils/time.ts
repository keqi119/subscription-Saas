import { DEFAULT_TIME_ZONE } from "../platform";

export function formatShanghaiDateTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: DEFAULT_TIME_ZONE
  }).format(date);
}
