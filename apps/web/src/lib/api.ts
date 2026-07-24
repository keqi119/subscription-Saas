export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type ApiFetchInit = RequestInit & {
  timeoutMs?: number;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
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
    throw new ApiError(await readErrorMessage(response), response.status);
  }

  const text = await response.text();
  if (!text) {
    return null as T;
  }

  return JSON.parse(text) as T;
}

async function readErrorMessage(response: Response) {
  try {
    const body = (await response.json()) as { message?: unknown };

    if (Array.isArray(body.message)) {
      return body.message
        .map((item) => (typeof item === "string" ? item : "请求参数不正确，请检查输入内容"))
        .join(", ");
    }

    return typeof body.message === "string" && body.message.trim()
      ? body.message
      : response.statusText;
  } catch {
    return response.statusText;
  }
}
