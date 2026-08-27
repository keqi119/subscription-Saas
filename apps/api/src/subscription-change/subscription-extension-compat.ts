import { SubscriptionChangePricingMode, SubscriptionChangeType } from "@prisma/client";

import { SubscriptionChangeError } from "./subscription-change.errors";

interface ExtensionDetailProjection {
  extensionMonths: number;
  pricingMode: SubscriptionChangePricingMode;
  sourceSegment?: unknown | null;
  targetEndDate: Date;
  targetStartDate: Date;
}

interface ExtensionChangeProjectionInput {
  changeType: SubscriptionChangeType;
  extensionDetail?: ExtensionDetailProjection | null;
  extensionMonths: number | null;
  pricingMode: SubscriptionChangePricingMode | null;
  sourceSegment: unknown | null;
  targetEndDate: Date | null;
  targetStartDate: Date | null;
}

export type ExtensionChangeProjection<TChange extends ExtensionChangeProjectionInput> = TChange & {
  extensionMonths: number;
  pricingMode: SubscriptionChangePricingMode;
  sourceSegment: NonNullable<TChange["sourceSegment"]>;
  targetEndDate: Date;
  targetStartDate: Date;
};

/**
 * Projects the extension-owned fields from the typed detail while keeping
 * legacy root columns readable during the rollout window.
 */
export function requireExtensionChangeProjection<TChange extends ExtensionChangeProjectionInput>(
  change: TChange
): ExtensionChangeProjection<TChange> {
  if (change.changeType !== SubscriptionChangeType.EXTENSION) {
    throw invalidExtensionShape("Only extension changes can use the extension workflow.");
  }

  const detail = change.extensionDetail;
  const extensionMonths = detail?.extensionMonths ?? change.extensionMonths;
  const pricingMode = detail?.pricingMode ?? change.pricingMode;
  const sourceSegment = (detail?.sourceSegment ?? change.sourceSegment) as NonNullable<
    TChange["sourceSegment"]
  >;
  const targetEndDate = detail?.targetEndDate ?? change.targetEndDate;
  const targetStartDate = detail?.targetStartDate ?? change.targetStartDate;

  if (
    extensionMonths == null ||
    pricingMode == null ||
    sourceSegment == null ||
    targetEndDate == null ||
    targetStartDate == null
  ) {
    throw invalidExtensionShape("The extension change detail is incomplete.");
  }

  return {
    ...change,
    extensionMonths,
    pricingMode,
    sourceSegment,
    targetEndDate,
    targetStartDate
  };
}

function invalidExtensionShape(message: string) {
  return new SubscriptionChangeError("SUBSCRIPTION_EXTENSION_DETAIL_INVALID", message, 409);
}
