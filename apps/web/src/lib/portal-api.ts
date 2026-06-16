export const PORTAL_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";

export class PortalApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export async function portalApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const { headers, ...restInit } = init ?? {};

  try {
    response = await fetch(`${PORTAL_API_BASE_URL}${path}`, {
      ...restInit,
      credentials: "include",
      headers: isFormData
        ? headers
        : {
            "Content-Type": "application/json",
            ...headers
          }
    });
  } catch {
    throw new PortalApiError("无法连接客户门户服务，请稍后重试。", 0);
  }

  if (!response.ok) {
    throw new PortalApiError(await readPortalErrorMessage(response), response.status);
  }

  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (null as T);
}

async function readPortalErrorMessage(response: Response) {
  try {
    const body = (await response.json()) as { message?: unknown };

    if (Array.isArray(body.message)) {
      return body.message
        .map((item) => (typeof item === "string" ? item : "请求参数不正确，请检查输入内容。"))
        .join(", ");
    }

    return typeof body.message === "string" && body.message.trim()
      ? body.message
      : response.statusText;
  } catch {
    return response.statusText;
  }
}
