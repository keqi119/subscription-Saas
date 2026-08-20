import { createHash } from "node:crypto";

import type {
  VehicleCostActionType,
  VehicleCostCategory,
  VehicleCostResponsiblePartyType
} from "@prisma/client";
import type {
  AssetAccountingSnapshotValue,
  AssetAccountingSource,
  VehicleCostLedgerEntrySnapshot,
  VehicleCostLedgerSummary,
  VehicleCostSummaryBucket
} from "./asset-accounting.types";

const OMITTED = Symbol("omitted canonical property");

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalizeValue(
  value: unknown,
  path: string,
  ancestors: Set<object>
): CanonicalValue | typeof OMITTED {
  if (value === undefined) {
    return OMITTED;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonical asset-accounting value at ${path} must be finite`);
    }
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(`canonical asset-accounting date at ${path} is invalid`);
    }
    return value.toISOString();
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical asset-accounting value at ${path} has an unsupported type`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`canonical asset-accounting value at ${path} contains a cycle`);
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const canonical = canonicalizeValue(item, `${path}[${index}]`, nextAncestors);
      // JSON arrays cannot omit a position.  Undefined therefore follows the
      // JSON-compatible null representation while object properties are omitted.
      return canonical === OMITTED ? null : canonical;
    });
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`canonical asset-accounting value at ${path} must be a plain object`);
  }

  const result: { [key: string]: CanonicalValue } = {};
  for (const key of Object.keys(value).sort()) {
    const canonical = canonicalizeValue(value[key], `${path}.${key}`, nextAncestors);
    if (canonical !== OMITTED) {
      result[key] = canonical;
    }
  }
  return result;
}

function quoteCanonicalString(value: string): string {
  // JSON.stringify is applied only to a known string after recursive type and
  // cycle validation; raw caller values (especially BigInt) never reach it.
  const quoted = JSON.stringify(value);
  if (quoted === undefined) {
    throw new TypeError("failed to encode canonical string");
  }
  return quoted;
}

function serializeCanonicalValue(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return quoteCanonicalString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalValue).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${quoteCanonicalString(key)}:${serializeCanonicalValue(value[key]!)}`)
    .join(",")}}`;
}

/** Return deterministic JSON for a plain object snapshot. */
export function canonicalAssetAccountingJson(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("canonical asset-accounting snapshot root must be a non-null object");
  }
  const canonical = canonicalizeValue(value, "$", new Set());
  if (
    canonical === OMITTED ||
    Array.isArray(canonical) ||
    canonical === null ||
    typeof canonical !== "object"
  ) {
    throw new TypeError("canonical asset-accounting snapshot root must be an object");
  }
  return serializeCanonicalValue(canonical);
}

/** Hash a business-exception snapshot without exposing receipt/source internals. */
export function hashBusinessExceptionSnapshot(snapshot: unknown): string {
  return createHash("sha256").update(canonicalAssetAccountingJson(snapshot)).digest("hex");
}

function requireNonBlankString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a nonblank string`);
  }
}

export function assertAssetAccountingSource(
  source: unknown
): asserts source is AssetAccountingSource {
  if (source === null || typeof source !== "object") {
    throw new TypeError("asset accounting source must be an object");
  }
  const candidate = source as Record<string, unknown>;
  requireNonBlankString(candidate.type, "source.type");
  requireNonBlankString(candidate.id, "source.id");
  requireNonBlankString(candidate.key, "source.key");
}

export function isValidAssetAccountingSource(source: unknown): source is AssetAccountingSource {
  try {
    assertAssetAccountingSource(source);
    return true;
  } catch {
    return false;
  }
}

export function assertVehicleCostAmountCents(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value === 0n) {
    throw new TypeError("vehicle cost amountCents must be a nonzero BigInt");
  }
}

export function isValidVehicleCostAmountCents(value: unknown): value is bigint {
  try {
    assertVehicleCostAmountCents(value);
    return true;
  } catch {
    return false;
  }
}

export function assertAccountingPeriod(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) {
    throw new TypeError("accounting period must use YYYY-MM format");
  }
}

export function isValidAccountingPeriod(value: unknown): value is string {
  try {
    assertAccountingPeriod(value);
    return true;
  } catch {
    return false;
  }
}

function toSummaryAmount(value: unknown): bigint {
  assertVehicleCostAmountCents(value);
  return value;
}

function addBucket(
  buckets: Record<string, VehicleCostSummaryBucket>,
  key: string,
  amountCents: bigint
): void {
  const current = buckets[key];
  if (current) {
    buckets[key] = {
      amountCents: current.amountCents + amountCents,
      count: current.count + 1
    };
  } else {
    buckets[key] = { amountCents, count: 1 };
  }
}

const ACTION_TYPES: readonly VehicleCostActionType[] = [
  "ACTUAL_COST",
  "RESPONSIBILITY_CONFIRMED",
  "RECOVERY_EXPOSURE",
  "RECOVERY_RECEIVED",
  "WAIVER",
  "WRITE_OFF"
];

const RESPONSIBILITY_TYPES: readonly VehicleCostResponsiblePartyType[] = [
  "CUSTOMER",
  "INSURER",
  "SUPPLIER",
  "ASSET_OWNER",
  "PLATFORM",
  "OTHER"
];

const COST_CATEGORIES: readonly VehicleCostCategory[] = [
  "DAMAGE",
  "CLEANING",
  "REPAIR",
  "MAINTENANCE",
  "EXCESS_MILEAGE",
  "VIOLATION",
  "TOWING",
  "INSURANCE",
  "BAAS",
  "DEPRECIATION",
  "OTHER"
];

function emptyBuckets(keys: readonly string[]): Record<string, VehicleCostSummaryBucket> {
  return Object.fromEntries(keys.map((key) => [key, { amountCents: 0n, count: 0 }])) as Record<
    string,
    VehicleCostSummaryBucket
  >;
}

/** Summarize signed facts while retaining each accounting dimension. */
export function summarizeVehicleCostEntries(
  entries: readonly VehicleCostLedgerEntrySnapshot[]
): VehicleCostLedgerSummary {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const byActionType = emptyBuckets(ACTION_TYPES) as Record<
    VehicleCostActionType,
    VehicleCostSummaryBucket
  >;
  const byResponsibility = emptyBuckets(RESPONSIBILITY_TYPES) as Record<
    VehicleCostResponsiblePartyType,
    VehicleCostSummaryBucket
  >;
  const byResponsibleParty: Record<string, VehicleCostSummaryBucket> = {};
  const byCategory = emptyBuckets(COST_CATEGORIES) as Record<
    VehicleCostCategory,
    VehicleCostSummaryBucket
  >;
  let totalAmountCents = 0n;

  for (const entry of entries) {
    const amount = toSummaryAmount(entry.amountCents);
    const original =
      entry.entryKind === "REVERSAL" && entry.reversalOfEntryId
        ? byId.get(entry.reversalOfEntryId)
        : undefined;
    const actionType = original?.actionType ?? entry.actionType;
    const costCategory = original?.costCategory ?? entry.costCategory;
    const responsibility = original?.responsiblePartyType ?? entry.responsiblePartyType;
    const responsibilityId = original?.responsiblePartyId ?? entry.responsiblePartyId ?? null;
    const signedAmount = entry.entryKind === "REVERSAL" ? -absBigInt(amount) : amount;

    totalAmountCents += signedAmount;
    addBucket(byActionType, actionType, signedAmount);
    addBucket(byResponsibility, responsibility, signedAmount);
    addBucket(byResponsibleParty, `${responsibility}:${responsibilityId ?? ""}`, signedAmount);
    addBucket(byCategory, costCategory, signedAmount);
  }

  return {
    totalAmountCents,
    byActionType,
    byResponsibility,
    byResponsibleParty,
    byCategory
  };
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

// Keep the snapshot-value type referenced in this module so future callers
// receive compile-time guidance when adding canonicalized helper inputs.
export type CanonicalAssetAccountingInput = AssetAccountingSnapshotValue;
