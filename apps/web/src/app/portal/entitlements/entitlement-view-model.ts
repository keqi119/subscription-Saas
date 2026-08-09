import type { PortalEntitlementGrant } from "../../../lib/portal-types";

export type EntitlementPeriodBucket = "CURRENT" | "FUTURE" | "HISTORICAL";

export const PORTAL_ENTITLEMENT_TYPES = ["BENEFIT", "ENERGY", "MILEAGE"] as const;
export type PortalEntitlementType = (typeof PORTAL_ENTITLEMENT_TYPES)[number];

export function shanghaiBusinessDateKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

export function entitlementPeriodBucket(
  grant: PortalEntitlementGrant,
  todayKey: string
): EntitlementPeriodBucket {
  if (!grant.validFrom) {
    return "HISTORICAL";
  }

  if (grant.validFrom > todayKey) {
    return "FUTURE";
  }

  if (grant.validTo && grant.validTo < todayKey) {
    return "HISTORICAL";
  }

  return "CURRENT";
}

export function sortEntitlementGrants(
  rows: PortalEntitlementGrant[],
  todayKey: string
): PortalEntitlementGrant[] {
  const bucketRank: Record<EntitlementPeriodBucket, number> = {
    CURRENT: 0,
    FUTURE: 1,
    HISTORICAL: 2
  };

  return [...rows].sort((left, right) => {
    const leftBucket = entitlementPeriodBucket(left, todayKey);
    const rightBucket = entitlementPeriodBucket(right, todayKey);
    const rankDifference = bucketRank[leftBucket] - bucketRank[rightBucket];

    if (rankDifference !== 0) {
      return rankDifference;
    }

    let dateDifference: number;
    if (leftBucket === "CURRENT") {
      dateDifference = compareDateKeysDescending(left.validFrom, right.validFrom);
    } else if (leftBucket === "FUTURE") {
      dateDifference = compareDateKeys(left.validFrom, right.validFrom, "last");
    } else {
      dateDifference = compareDateKeysDescending(left.validTo, right.validTo);
    }

    return dateDifference || left.grantNo.localeCompare(right.grantNo);
  });
}

export function groupEntitlementGrants(
  rows: PortalEntitlementGrant[],
  todayKey: string
): Record<PortalEntitlementType, PortalEntitlementGrant[]> {
  const groups: Record<PortalEntitlementType, PortalEntitlementGrant[]> = {
    BENEFIT: [],
    ENERGY: [],
    MILEAGE: []
  };

  for (const row of rows) {
    if (PORTAL_ENTITLEMENT_TYPES.includes(row.entitlementType as PortalEntitlementType)) {
      groups[row.entitlementType as PortalEntitlementType].push(row);
    }
  }

  for (const type of PORTAL_ENTITLEMENT_TYPES) {
    groups[type] = sortEntitlementGrants(groups[type], todayKey);
  }

  return groups;
}

export function selectDefaultEntitlementType(
  groups: Record<PortalEntitlementType, PortalEntitlementGrant[]>,
  todayKey: string
): PortalEntitlementType {
  const activeCurrentType = PORTAL_ENTITLEMENT_TYPES.find((type) =>
    groups[type].some(
      (grant) => grant.status === "ACTIVE" && entitlementPeriodBucket(grant, todayKey) === "CURRENT"
    )
  );

  if (activeCurrentType) {
    return activeCurrentType;
  }

  return PORTAL_ENTITLEMENT_TYPES.find((type) => groups[type].length > 0) ?? "BENEFIT";
}

export function isTextEntitlement(grant: PortalEntitlementGrant): boolean {
  return grant.unit === "TEXT";
}

export function isUnavailableEntitlement(grant: PortalEntitlementGrant): boolean {
  return grant.status === "EXPIRED" || grant.status === "CANCELLED";
}

export function entitlementProgress(grant: PortalEntitlementGrant): number | null {
  if (isTextEntitlement(grant) || grant.totalAmount === null || grant.totalAmount <= 0) {
    return null;
  }

  if (grant.status === "EXHAUSTED") {
    return 100;
  }

  const percentage = ((grant.usedAmount ?? 0) / grant.totalAmount) * 100;
  return Math.min(100, Math.max(0, percentage));
}

function compareDateKeysDescending(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return right.localeCompare(left);
}

function compareDateKeys(
  left: string | null,
  right: string | null,
  nulls: "first" | "last"
): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return nulls === "first" ? -1 : 1;
  }
  if (right === null) {
    return nulls === "first" ? 1 : -1;
  }
  return left.localeCompare(right);
}
