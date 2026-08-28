import type {
  PortalRenewalConsideration,
  PortalRenewalSegment,
  PortalSubscriptionChange
} from "./portal-types";
import type { PortalSubscriptionJourney } from "./portal-journey-view-model";

export const PORTAL_API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";

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

export function buildPortalAssetUrl(url: string) {
  if (/^https?:\/\//.test(url)) {
    return url;
  }
  return `${PORTAL_API_BASE_URL.replace(/\/api$/, "")}${url}`;
}

export function getPortalJourneyByApplication(applicationId: string) {
  return portalApiFetch<PortalSubscriptionJourney>(
    `/portal/subscription-journeys/by-application/${encodeURIComponent(applicationId)}`
  );
}

export function getPortalJourneyByOrder(orderId: string) {
  return portalApiFetch<PortalSubscriptionJourney>(
    `/portal/subscription-journeys/by-order/${encodeURIComponent(orderId)}`
  );
}

export function listPortalRenewals() {
  return portalApiFetch<PortalRenewalConsideration[]>("/portal/renewal-considerations");
}

export function getPortalRenewal(id: string) {
  return portalApiFetch<PortalRenewalConsideration>(
    `/portal/renewal-considerations/${encodeURIComponent(id)}`
  );
}

export function submitPortalRenewalDecision(
  id: string,
  input: { decision: "RENEW" | "EXPIRE"; version: number },
  idempotencyKey = crypto.randomUUID()
) {
  return portalApiFetch<PortalRenewalConsideration>(
    `/portal/renewal-considerations/${encodeURIComponent(id)}/decision`,
    {
      body: JSON.stringify(input),
      headers: { "Idempotency-Key": idempotencyKey },
      method: "POST"
    }
  );
}

export function getPortalSubscriptionChange(id: string) {
  return portalApiFetch<PortalSubscriptionChange>(
    `/portal/subscription-changes/${encodeURIComponent(id)}`
  );
}

export function confirmPortalRenewalQuote(
  id: string,
  input: {
    commercialSnapshotHash?: string;
    quoteId: string;
    revision: number;
    version: number;
  },
  idempotencyKey = crypto.randomUUID()
) {
  return portalApiFetch<PortalSubscriptionChange>(
    `/portal/subscription-changes/${encodeURIComponent(id)}/quote/confirm`,
    {
      body: JSON.stringify(input),
      headers: { "Idempotency-Key": idempotencyKey },
      method: "POST"
    }
  );
}

export function rejectPortalRenewalQuote(
  id: string,
  input: {
    commercialSnapshotHash?: string;
    quoteId: string;
    reason: string;
    revision: number;
    version: number;
  },
  idempotencyKey = crypto.randomUUID()
) {
  return portalApiFetch<PortalSubscriptionChange>(
    `/portal/subscription-changes/${encodeURIComponent(id)}/quote/reject`,
    {
      body: JSON.stringify(input),
      headers: { "Idempotency-Key": idempotencyKey },
      method: "POST"
    }
  );
}

export function listPortalContractSegments(orderId: string) {
  return portalApiFetch<PortalRenewalSegment[]>(
    `/portal/orders/${encodeURIComponent(orderId)}/contract-segments`
  );
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
