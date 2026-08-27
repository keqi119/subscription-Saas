import {
  SubscriptionChangePricingMode,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";

import { RequestUser } from "../auth/auth.types";
import { SubscriptionChangeError } from "./subscription-change.errors";
import { SubscriptionChangeAction } from "./subscription-change.types";
import { requireExtensionChangeProjection } from "./subscription-extension-compat";

const FINAL_STATUSES = new Set<SubscriptionChangeStatus>([
  SubscriptionChangeStatus.COMPLETED,
  SubscriptionChangeStatus.CANCELLED,
  SubscriptionChangeStatus.FAILED
]);

const CANCELLABLE_STATUSES = new Set<SubscriptionChangeStatus>([
  SubscriptionChangeStatus.DRAFT,
  SubscriptionChangeStatus.QUOTED,
  SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
  SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
  SubscriptionChangeStatus.MANUAL_TAKEOVER
]);

interface ChangeProjectionSource {
  changeType: SubscriptionChangeType;
  earlyTerminationDetail?: unknown | null;
  extensionDetail?: {
    extensionMonths: number;
    priceOverrideApprovedAt?: Date | null;
    priceOverrideApprovedBy?: string | null;
    priceOverrideReason?: string | null;
    pricingMode: SubscriptionChangePricingMode;
    sourceSegment?: unknown | null;
    targetEndDate: Date;
    targetStartDate: Date;
  } | null;
  extensionMonths: number | null;
  managedOtherDetail?: unknown | null;
  pricingMode: SubscriptionChangePricingMode | null;
  sourceSegment: unknown | null;
  sourceSegmentId: string | null;
  status: SubscriptionChangeStatus;
  targetEndDate: Date | null;
  targetStartDate: Date | null;
  vehicleSwapDetail?: unknown | null;
}

export function projectSubscriptionChange<T extends ChangeProjectionSource>(
  change: T,
  actor: RequestUser
) {
  const compatible =
    change.changeType === SubscriptionChangeType.EXTENSION
      ? requireExtensionChangeProjection(change)
      : change;
  return {
    ...compatible,
    allowedActions: subscriptionChangeAllowedActions(compatible, actor),
    detail: changeDetail(compatible)
  };
}

export function subscriptionChangeAllowedActions(
  change: Pick<ChangeProjectionSource, "changeType" | "status">,
  actor: RequestUser
): SubscriptionChangeAction[] {
  if (FINAL_STATUSES.has(change.status)) return [];

  const actions: SubscriptionChangeAction[] = [];
  if (
    change.status === SubscriptionChangeStatus.DRAFT &&
    change.changeType !== SubscriptionChangeType.MANAGED_OTHER &&
    hasPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_QUOTE)
  ) {
    actions.push("CREATE_QUOTE");
  }
  if (
    (change.status === SubscriptionChangeStatus.DRAFT ||
      change.status === SubscriptionChangeStatus.QUOTED) &&
    hasPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_APPROVE)
  ) {
    actions.push("APPROVE");
  }
  if (
    change.status === SubscriptionChangeStatus.QUOTED &&
    hasPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_SUBMIT)
  ) {
    actions.push("PUBLISH_CUSTOMER_CONFIRMATION");
  }
  if (
    change.status === SubscriptionChangeStatus.CUSTOMER_CONFIRMED &&
    hasPermission(actor, PermissionCode.CONTRACT_GENERATE)
  ) {
    actions.push("GENERATE_CONTRACT");
  }
  if (
    change.status === SubscriptionChangeStatus.SIGNING_OR_PAYMENT &&
    hasPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_ESIGN_RETRY)
  ) {
    actions.push("START_ESIGN");
  }
  if (
    (change.status === SubscriptionChangeStatus.SCHEDULED ||
      change.status === SubscriptionChangeStatus.EXECUTING) &&
    hasPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE)
  ) {
    actions.push("EXECUTE");
  }
  if (
    change.status === SubscriptionChangeStatus.MANUAL_TAKEOVER &&
    hasPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE)
  ) {
    actions.push("RETRY");
  }
  if (
    (CANCELLABLE_STATUSES.has(change.status) ||
      (change.changeType === SubscriptionChangeType.EARLY_TERMINATION &&
        change.status === SubscriptionChangeStatus.SCHEDULED)) &&
    hasPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_CANCEL)
  ) {
    actions.push("CANCEL");
  }
  if (
    change.status !== SubscriptionChangeStatus.MANUAL_TAKEOVER &&
    hasPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_MANUAL_TAKEOVER)
  ) {
    actions.push("MANUAL_TAKEOVER");
  }
  return actions;
}

function changeDetail(change: ChangeProjectionSource) {
  switch (change.changeType) {
    case SubscriptionChangeType.EXTENSION:
      return (
        change.extensionDetail ?? {
          extensionMonths: change.extensionMonths,
          pricingMode: change.pricingMode,
          sourceSegmentId: change.sourceSegmentId,
          targetEndDate: change.targetEndDate,
          targetStartDate: change.targetStartDate
        }
      );
    case SubscriptionChangeType.VEHICLE_SWAP:
      return requireDetail(change.vehicleSwapDetail, change.changeType);
    case SubscriptionChangeType.EARLY_TERMINATION:
      return requireDetail(change.earlyTerminationDetail, change.changeType);
    case SubscriptionChangeType.MANAGED_OTHER:
      return requireDetail(change.managedOtherDetail, change.changeType);
  }
}

function requireDetail(detail: unknown | null | undefined, changeType: SubscriptionChangeType) {
  if (detail) return detail;
  throw new SubscriptionChangeError(
    "SUBSCRIPTION_CHANGE_DETAIL_INVALID",
    `The ${changeType} change detail is missing.`,
    409
  );
}

function hasPermission(actor: RequestUser, permission: PermissionCode) {
  return actor.permissions.includes(permission);
}
