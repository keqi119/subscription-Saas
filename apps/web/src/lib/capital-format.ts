"use client";

import dayjs from "dayjs";

import { ApiError } from "./api";

export function safeText(value?: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === "string" && value.trim() ? value : "-";
}

export function formatYuan(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  return `¥${(value / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}`;
}

export function formatPercentFromBps(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  return `${(value / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}%`;
}

export function formatRatio(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  return `${(value * 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}%`;
}

export function formatDate(value?: string | null) {
  if (!value) {
    return "-";
  }

  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "-";
}

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "-";
  }

  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm") : "-";
}

export function toCentAmount(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : undefined;
}

export function yuanFromCents(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value / 100 : undefined;
}

export function percentToBps(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : undefined;
}

export function percentFromBps(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value / 100 : undefined;
}

export function optionsFromLabels(labels: Record<string, string>) {
  return Object.entries(labels).map(([value, label]) => ({ label, value }));
}

export function buildQuery(values: object) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

export function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.message === "Internal Server Error") {
      return "后端服务异常，请稍后重试";
    }

    if (error.message === "Bad Request") {
      return "请求参数不正确，请检查输入内容";
    }

    return error.message;
  }

  return "操作失败，请稍后重试";
}
