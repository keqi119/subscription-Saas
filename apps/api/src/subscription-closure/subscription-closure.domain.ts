import { createHash } from "node:crypto";

import type { SubscriptionClosureStatus } from "@prisma/client";

import type {
  SubscriptionClosureJsonObject,
  SubscriptionClosureJsonValue,
  SubscriptionClosureProfile,
  SubscriptionClosureSnapshotValue,
  SubscriptionClosureSource
} from "./subscription-closure.types";

const OMITTED = Symbol("omitted canonical property");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MutableJsonValue =
  | null
  | boolean
  | number
  | string
  | MutableJsonValue[]
  | { [key: string]: MutableJsonValue };

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoAccessors(value: object, path: string): void {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get || descriptor?.set) {
      throw new TypeError(`canonical subscription-closure value at ${path} contains an accessor`);
    }
  }
}

function canonicalize(
  value: SubscriptionClosureSnapshotValue,
  path: string,
  ancestors: ReadonlySet<object>
): MutableJsonValue | typeof OMITTED {
  if (value === undefined) return OMITTED;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonical subscription-closure value at ${path} must be finite`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) {
    const time = Date.prototype.getTime.call(value);
    if (Number.isNaN(time)) {
      throw new TypeError(`canonical subscription-closure date at ${path} is invalid`);
    }
    return new Date(time).toISOString();
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical subscription-closure value at ${path} is unsupported`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`canonical subscription-closure value at ${path} contains a cycle`);
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  assertNoAccessors(value, path);
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const normalized = canonicalize(entry, `${path}[${index}]`, nextAncestors);
      return normalized === OMITTED ? null : normalized;
    });
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`canonical subscription-closure value at ${path} must be a plain object`);
  }
  const result = Object.create(null) as { [key: string]: MutableJsonValue };
  for (const key of Object.keys(value).sort()) {
    const normalized = canonicalize(
      value[key] as SubscriptionClosureSnapshotValue,
      `${path}.${key}`,
      nextAncestors
    );
    if (normalized !== OMITTED) result[key] = normalized;
  }
  return result;
}

function encode(value: MutableJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encode(value[key]!)}`)
    .join(",")}}`;
}

export function canonicalSubscriptionClosureJson(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("canonical subscription-closure snapshot root must be an object");
  }
  const normalized = canonicalize(
    value as SubscriptionClosureSnapshotValue,
    "$",
    new Set<object>()
  );
  if (normalized === OMITTED || normalized === null || Array.isArray(normalized)) {
    throw new TypeError("canonical subscription-closure snapshot root must be an object");
  }
  return encode(normalized);
}

export function hashSubscriptionClosureSnapshot(value: unknown): string {
  return createHash("sha256").update(canonicalSubscriptionClosureJson(value)).digest("hex");
}

export function canonicalSubscriptionClosureSource(source: unknown): SubscriptionClosureSource {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("subscription closure source is required");
  }
  const candidate = source as Partial<Record<"type" | "id" | "key", unknown>>;
  const type = requiredTrimmed(candidate.type, "source.type", 64);
  const id = requiredTrimmed(candidate.id, "source.id", 36).toLowerCase();
  const key = requiredTrimmed(candidate.key, "source.key", 255);
  if (!UUID_PATTERN.test(id)) throw new TypeError("source.id must be a UUID");
  return Object.freeze({ id, key, type });
}

function requiredTrimmed(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-blank string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximumLength) throw new TypeError(`${field} is too long`);
  return trimmed;
}

function freezeJson(value: MutableJsonValue): SubscriptionClosureJsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = freezeJson(value[index]!) as MutableJsonValue;
    }
    return Object.freeze(value) as readonly SubscriptionClosureJsonValue[];
  }
  for (const key of Object.keys(value)) {
    value[key] = freezeJson(value[key]!) as MutableJsonValue;
  }
  return Object.freeze(value) as SubscriptionClosureJsonObject;
}

export function freezeSubscriptionClosureOutcome(value: unknown): SubscriptionClosureJsonObject {
  const parsed = JSON.parse(canonicalSubscriptionClosureJson(value)) as MutableJsonValue;
  return freezeJson(parsed) as SubscriptionClosureJsonObject;
}

type TransitionMatrix = Readonly<
  Partial<Record<SubscriptionClosureStatus, readonly SubscriptionClosureStatus[]>>
>;

function transitions(
  ...statuses: SubscriptionClosureStatus[]
): readonly SubscriptionClosureStatus[] {
  return Object.freeze(statuses);
}

const NORMAL_VOLUNTARY: TransitionMatrix = Object.freeze({
  PREPARING_RETURN: transitions("RETURN_INSPECTION", "CANCELLED", "MANUAL_TAKEOVER"),
  RETURN_INSPECTION: transitions("RECONDITIONING", "PENDING_SETTLEMENT", "MANUAL_TAKEOVER"),
  RECONDITIONING: transitions("PENDING_SETTLEMENT", "MANUAL_TAKEOVER"),
  PENDING_SETTLEMENT: transitions("COMPLETED", "MANUAL_TAKEOVER")
});

const EARLY_VOLUNTARY: TransitionMatrix = Object.freeze({
  ...NORMAL_VOLUNTARY,
  PENDING_SETTLEMENT: transitions("TERMINATED", "MANUAL_TAKEOVER")
});

const RECOVERY: TransitionMatrix = Object.freeze({
  RECOVERY_ASSESSMENT_PENDING: transitions(
    "RECOVERY_APPROVAL_PENDING",
    "REJECTED",
    "CANCELLED",
    "MANUAL_TAKEOVER"
  ),
  RECOVERY_APPROVAL_PENDING: transitions(
    "RECOVERY_APPROVED",
    "REJECTED",
    "CANCELLED",
    "MANUAL_TAKEOVER"
  ),
  RECOVERY_APPROVED: transitions("RECOVERY_IN_PROGRESS", "CANCELLED", "MANUAL_TAKEOVER"),
  RECOVERY_IN_PROGRESS: transitions("VEHICLE_SECURED", "CANCELLED", "MANUAL_TAKEOVER"),
  VEHICLE_SECURED: transitions("RETURN_INSPECTION", "MANUAL_TAKEOVER"),
  RETURN_INSPECTION: transitions("RECONDITIONING", "PENDING_SETTLEMENT", "MANUAL_TAKEOVER"),
  RECONDITIONING: transitions("PENDING_SETTLEMENT", "MANUAL_TAKEOVER"),
  PENDING_SETTLEMENT: transitions("TERMINATED", "MANUAL_TAKEOVER")
});

export function allowedSubscriptionClosureTransitions(
  profile: SubscriptionClosureProfile
): TransitionMatrix {
  if (profile.physicalControlMode === "RECOVERY") {
    if (profile.finalDisposition !== "TERMINATE") throw new TypeError("invalid recovery profile");
    return RECOVERY;
  }
  if (profile.closureType === "NORMAL_COMPLETION" && profile.finalDisposition === "COMPLETE") {
    return NORMAL_VOLUNTARY;
  }
  if (profile.closureType === "EARLY_TERMINATION" && profile.finalDisposition === "TERMINATE") {
    return EARLY_VOLUNTARY;
  }
  throw new TypeError("invalid subscription closure profile");
}

export function assertSubscriptionClosureTransition(
  profile: SubscriptionClosureProfile,
  from: SubscriptionClosureStatus,
  to: SubscriptionClosureStatus
): void {
  if (!allowedSubscriptionClosureTransitions(profile)[from]?.includes(to)) {
    throw new TypeError(`subscription closure transition ${from} -> ${to} is not allowed`);
  }
}

export function assertSubscriptionClosureEscalation(
  before: SubscriptionClosureProfile & {
    readonly physicalControlledAt: Date | string | null;
    readonly status: SubscriptionClosureStatus;
  },
  after: SubscriptionClosureProfile
): void {
  if (
    before.closureType !== "NORMAL_COMPLETION" ||
    before.physicalControlMode !== "VOLUNTARY_RETURN" ||
    before.finalDisposition !== "COMPLETE" ||
    before.status !== "PREPARING_RETURN" ||
    before.physicalControlledAt !== null ||
    after.closureType !== "NORMAL_COMPLETION" ||
    after.physicalControlMode !== "RECOVERY" ||
    after.finalDisposition !== "TERMINATE"
  ) {
    throw new TypeError(
      "only normal voluntary completion may use the approved recovery escalation"
    );
  }
}
