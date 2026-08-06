import type {
  PortalAutoDebitAvailability,
  PortalDebitAttempt,
  PortalPaymentMandate,
  PortalRenewalConsideration,
  PortalRenewalSegment,
  PortalSubscriptionChange
} from "./portal-types";

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

export function getPortalAutoDebitAvailability() {
  return portalApiFetch<PortalAutoDebitAvailability>("/portal/auto-debit/availability");
}

export function getPortalPaymentMandates(orderId?: string) {
  const query = orderId ? `?orderId=${encodeURIComponent(orderId)}` : "";
  return portalApiFetch<PortalPaymentMandate[]>(`/portal/auto-debit/mandates${query}`);
}

export function getPortalDebitAttempts(filters?: { billId?: string; orderId?: string }) {
  const params = new URLSearchParams();
  if (filters?.billId) {
    params.set("billId", filters.billId);
  }
  if (filters?.orderId) {
    params.set("orderId", filters.orderId);
  }
  const query = params.size ? `?${params.toString()}` : "";
  return portalApiFetch<PortalDebitAttempt[]>(`/portal/auto-debit/attempts${query}`);
}

export function createPortalPaymentMandate(orderId: string) {
  return portalApiFetch<PortalPaymentMandate>("/portal/auto-debit/mandates", {
    body: JSON.stringify({ orderId }),
    method: "POST"
  });
}

export function revokePortalPaymentMandate(mandateId: string) {
  return portalApiFetch<PortalPaymentMandate>(
    `/portal/auto-debit/mandates/${encodeURIComponent(mandateId)}/revoke`,
    { method: "POST" }
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
  input: { decision: "RENEW" | "EXPIRE"; version: number }
) {
  return portalApiFetch<PortalRenewalConsideration>(
    `/portal/renewal-considerations/${encodeURIComponent(id)}/decision`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function getPortalSubscriptionChange(id: string) {
  return portalApiFetch<PortalSubscriptionChange>(
    `/portal/subscription-changes/${encodeURIComponent(id)}`
  );
}

export function confirmPortalRenewalQuote(
  id: string,
  input: { quoteId: string; revision: number; version: number }
) {
  return portalApiFetch<PortalSubscriptionChange>(
    `/portal/subscription-changes/${encodeURIComponent(id)}/quote/confirm`,
    { body: JSON.stringify(input), method: "POST" }
  );
}

export function rejectPortalRenewalQuote(
  id: string,
  input: { quoteId: string; reason: string; revision: number; version: number }
) {
  return portalApiFetch<PortalSubscriptionChange>(
    `/portal/subscription-changes/${encodeURIComponent(id)}/quote/reject`,
    { body: JSON.stringify(input), method: "POST" }
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
