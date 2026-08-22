import { ApiError, apiFetch } from "./api";
import { portalApiFetch } from "./portal-api";
import {
  buildAdminSubscriptionClosureView,
  buildCustomerSubscriptionClosureView
} from "./subscription-closure-view-model";

export async function loadAdminSubscriptionClosureByOrder(
  orderId: string,
  permissions: ReadonlySet<string>
) {
  try {
    const value = await apiFetch<unknown>(
      `/subscription-closures/by-order/${encodeURIComponent(orderId)}`
    );
    return buildAdminSubscriptionClosureView(value, permissions);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function loadPortalSubscriptionClosureByOrder(orderId: string) {
  const value = await portalApiFetch<unknown>(
    `/portal/orders/${encodeURIComponent(orderId)}/subscription-closure`
  );
  return value === null ? null : buildCustomerSubscriptionClosureView(value);
}
