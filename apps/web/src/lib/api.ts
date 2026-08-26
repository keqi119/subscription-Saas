import type { AdminSubscriptionJourney } from "./subscription-journey-view-model";

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type ApiFetchInit = RequestInit & {
  timeoutMs?: number;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init?: ApiFetchInit): Promise<T> {
  let response: Response;
  const {
    headers,
    signal: callerSignal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ...requestInit
  } = init ?? {};
  const hasBody = requestInit.body !== undefined && requestInit.body !== null;
  const isFormData = hasBody && requestInit.body instanceof FormData;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      credentials: "include",
      headers: {
        ...(hasBody && !isFormData ? { "Content-Type": "application/json" } : {}),
        ...headers
      },
      ...requestInit,
      signal: controller.signal
    });
  } catch {
    if (timedOut) {
      throw new ApiError("请求超时，请检查网络后重试。", 0);
    }
    throw new ApiError("无法连接 API 服务，请确认后端 3001 端口已启动。", 0);
  } finally {
    globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }

  if (!response.ok) {
    const error = await readError(response);
    throw new ApiError(error.message, response.status, error.code);
  }

  const text = await response.text();
  if (!text) {
    return null as T;
  }

  return JSON.parse(text) as T;
}

export async function loadAdminJourneyByApplication(applicationId: string) {
  return loadOptionalAdminJourney(
    `/subscription-journeys/by-application/${encodeURIComponent(applicationId)}`
  );
}

export async function loadAdminJourneyByOrder(orderId: string) {
  return loadOptionalAdminJourney(
    `/subscription-journeys/by-order/${encodeURIComponent(orderId)}`
  );
}

export function decideJourneyFinalPlan(
  journeyId: string,
  input: {
    finalPeriodMonths: number;
    finalSubscriptionPlanId: string;
    finalVehicleId: string;
    version: number;
  }
) {
  return postJourneyAction(journeyId, "final-plan-decision", input);
}

export function allocateJourneyVehicle(
  journeyId: string,
  input: { vehicleId: string; version: number }
) {
  return postJourneyAction(journeyId, "vehicle-allocation", input);
}

export function decideJourneyDeliveryEvidence(
  journeyId: string,
  input: {
    decision: "APPROVED" | "REJECTED";
    manifestHash: string;
    notes?: string;
    version: number;
    workOrderId: string;
  }
) {
  return postJourneyAction(journeyId, "delivery-evidence-decision", input);
}

export function recoverSubscriptionJourney(
  journeyId: string,
  action: "retry" | "pause" | "resume" | "cancel",
  input: { reason: string; version: number }
) {
  return postJourneyAction(journeyId, action, input);
}

async function loadOptionalAdminJourney(path: string) {
  try {
    return await apiFetch<AdminSubscriptionJourney>(path);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function postJourneyAction(
  journeyId: string,
  action: string,
  input: Record<string, unknown>
) {
  return apiFetch<Record<string, unknown>>(
    `/subscription-journeys/${encodeURIComponent(journeyId)}/${action}`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

async function readError(response: Response) {
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    const code =
      typeof body.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(body.code)
        ? body.code
        : undefined;

    if (Array.isArray(body.message)) {
      return {
        code,
        message: body.message
          .map((item) => (typeof item === "string" ? item : "请求参数不正确，请检查输入内容"))
          .join(", ")
      };
    }

    return {
      code,
      message:
        typeof body.message === "string" && body.message.trim()
          ? body.message
          : response.statusText
    };
  } catch {
    return { code: undefined, message: response.statusText };
  }
}
