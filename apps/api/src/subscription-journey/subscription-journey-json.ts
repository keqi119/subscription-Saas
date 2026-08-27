import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

const COMMERCIAL_PLAN_KEYS = [
  "contractTermsVersion",
  "contractVersionId",
  "contractVersionNo",
  "depositAmount",
  "depositRuleSnapshot",
  "effectiveDate",
  "effectiveFrom",
  "entitlementSnapshot",
  "entitlements",
  "mileageLimitKm",
  "overMileageFeeAmount",
  "packageSnapshot",
  "periodMonths",
  "pricing",
  "subscriptionPlan",
  "subscriptionPlanId",
  "vehicleId",
  "vehicleSnapshot"
] as const;

export function canonicalJourneyJson(value: unknown): Prisma.InputJsonValue {
  return canonicalize(value, "$") as Prisma.InputJsonValue;
}

export function sameJourneyJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJourneyJson(left)) === JSON.stringify(canonicalJourneyJson(right));
}

export function commercialPlanSnapshot(value: unknown): Prisma.InputJsonObject {
  if (!isPlainRecord(value)) {
    throw invalidJson("commercial plan must be a JSON object");
  }
  const selected = Object.fromEntries(
    COMMERCIAL_PLAN_KEYS.map((key) => [key, value[key] ?? null])
  );
  return canonicalJourneyJson(selected) as Prisma.InputJsonObject;
}

export function commercialPlanHash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(commercialPlanSnapshot(value)), "utf8")
    .digest("hex")}`;
}

function canonicalize(value: unknown, path: string): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidJson(`${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item, `${path}.${key}`)])
    );
  }
  throw invalidJson(`${path} contains ${describeUnsupported(value)}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function describeUnsupported(value: unknown): string {
  if (value instanceof Date) return "a Date";
  return `an unsupported ${typeof value} value`;
}

function invalidJson(detail: string): TypeError {
  return new TypeError(`Journey value must be valid JSON: ${detail}.`);
}
