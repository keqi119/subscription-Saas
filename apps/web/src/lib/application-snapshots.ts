export function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return toRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function readPath(source: unknown, path: string) {
  let current: unknown = source;
  for (const key of path.split(".")) {
    const record = toRecord(current);
    if (!record || !(key in record)) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

export function snapshotValue(source: unknown, ...paths: string[]) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

export function safeText(value?: unknown) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (typeof value === "object") {
    return "-";
  }
  return String(value);
}

export function joinText(...values: unknown[]) {
  const parts = values
    .map((value) => safeText(value))
    .filter((value, index, array) => value !== "-" && array.indexOf(value) === index);

  return parts.length > 0 ? parts.join(" / ") : "-";
}

export function toNumber(value?: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const number = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

export function formatMoneyCent(value?: unknown) {
  const amount = toNumber(value);
  if (amount === null) {
    return "-";
  }
  return `${(amount / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })} 元`;
}

export function formatMonths(value?: unknown) {
  const months = toNumber(value);
  return months === null ? "-" : `${months.toLocaleString("zh-CN")} 个月`;
}
