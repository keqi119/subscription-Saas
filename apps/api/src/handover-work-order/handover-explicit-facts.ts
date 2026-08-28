import { createHash } from "node:crypto";

export const HANDOVER_EXPLICIT_FACT_SCHEMA_VERSION = 1;

export const HANDOVER_KEY_STATES = [
  "COMPLETE",
  "PARTIAL",
  "MISSING",
  "DAMAGED"
] as const;

export const HANDOVER_REGISTRATION_DOCUMENT_STATES = [
  "HANDED_OVER",
  "NOT_AVAILABLE",
  "DAMAGED"
] as const;

export const HANDOVER_ACCESSORY_STATES = [
  "PRESENT",
  "MISSING",
  "DAMAGED"
] as const;

export type HandoverKeyState = typeof HANDOVER_KEY_STATES[number];
export type HandoverRegistrationDocumentState =
  typeof HANDOVER_REGISTRATION_DOCUMENT_STATES[number];
export type HandoverAccessoryState = typeof HANDOVER_ACCESSORY_STATES[number];

export interface HandoverAccessoryItem {
  code: string;
  name: string;
  quantity: number;
  remark: string | null;
  state: HandoverAccessoryState;
}

export interface HandoverExplicitFactSource {
  accessoryItems?: unknown;
  handoverFactRevision?: number | null;
  keyState?: null | string;
  primaryKeyCount?: number | null;
  registrationDocumentRemarks?: null | string;
  registrationDocumentState?: null | string;
  spareKeyCount?: number | null;
  vehicleConditionConfirmed?: boolean | null;
  vehicleConditionRemarks?: null | string;
}

export interface PhysicalHandoverFactSnapshot {
  accessoryItems: HandoverAccessoryItem[];
  handoverFactRevision: number;
  keyState: HandoverKeyState;
  primaryKeyCount: number;
  registrationDocumentRemarks: string | null;
  registrationDocumentState: HandoverRegistrationDocumentState;
  schemaVersion: number;
  spareKeyCount: number;
  vehicleConditionConfirmed: true;
  vehicleConditionRemarks: string | null;
}

export interface HandoverRegistrationGateBinding {
  allowed: boolean;
  approval: null | {
    approvalNo: string;
    decision: unknown;
    id: string;
    status: unknown;
    subjectSnapshotHash: string;
    version: number;
  };
  documentPresent: boolean;
  snapshotHash: string;
}

export interface BoundHandoverFactSnapshot extends PhysicalHandoverFactSnapshot {
  physicalFactHash: string;
  registrationAuthority: {
    approval: HandoverRegistrationGateBinding["approval"];
    documentPresent: boolean;
    snapshotHash: string;
  } | null;
}

export type ExplicitHandoverFactBlockingCode =
  | "ACCESSORY_CONFIRMATION_MISSING"
  | "KEY_CONFIRMATION_MISSING"
  | "REGISTRATION_DOCUMENT_CONFIRMATION_MISSING"
  | "VEHICLE_CONDITION_CONFIRMATION_MISSING";

export function getExplicitHandoverFactBlockingCodes(
  source: HandoverExplicitFactSource
): ExplicitHandoverFactBlockingCode[] {
  const blockers: ExplicitHandoverFactBlockingCode[] = [];
  if (source.vehicleConditionConfirmed !== true) {
    blockers.push("VEHICLE_CONDITION_CONFIRMATION_MISSING");
  }
  if (
    !isNonNegativeInteger(source.primaryKeyCount) ||
    !isNonNegativeInteger(source.spareKeyCount) ||
    !isOneOf(source.keyState, HANDOVER_KEY_STATES)
  ) {
    blockers.push("KEY_CONFIRMATION_MISSING");
  }
  if (!isOneOf(source.registrationDocumentState, HANDOVER_REGISTRATION_DOCUMENT_STATES)) {
    blockers.push("REGISTRATION_DOCUMENT_CONFIRMATION_MISSING");
  }
  if (!Array.isArray(source.accessoryItems)) {
    blockers.push("ACCESSORY_CONFIRMATION_MISSING");
  }
  return blockers;
}

export function buildPhysicalHandoverFactSnapshot(
  source: HandoverExplicitFactSource
) {
  const blockingCodes = getExplicitHandoverFactBlockingCodes(source);
  if (blockingCodes.length) {
    throw new Error(`HANDOVER_EXPLICIT_FACTS_INVALID: ${blockingCodes.join(",")}`);
  }
  const snapshot: PhysicalHandoverFactSnapshot = {
    accessoryItems: normalizeAccessoryItems(source.accessoryItems),
    handoverFactRevision: requireNonNegativeInteger(
      source.handoverFactRevision ?? 0,
      "handoverFactRevision"
    ),
    keyState: source.keyState as HandoverKeyState,
    primaryKeyCount: requireNonNegativeInteger(source.primaryKeyCount, "primaryKeyCount"),
    registrationDocumentRemarks: normalizeOptionalText(source.registrationDocumentRemarks),
    registrationDocumentState:
      source.registrationDocumentState as HandoverRegistrationDocumentState,
    schemaVersion: HANDOVER_EXPLICIT_FACT_SCHEMA_VERSION,
    spareKeyCount: requireNonNegativeInteger(source.spareKeyCount, "spareKeyCount"),
    vehicleConditionConfirmed: true,
    vehicleConditionRemarks: normalizeOptionalText(source.vehicleConditionRemarks)
  };
  return { hash: hashCanonical(snapshot), snapshot };
}

export function buildBoundHandoverFactSnapshot(
  physical: PhysicalHandoverFactSnapshot,
  registrationGate: HandoverRegistrationGateBinding | null
) {
  const physicalFactHash = hashCanonical(physical);
  const snapshot: BoundHandoverFactSnapshot = {
    ...physical,
    physicalFactHash,
    registrationAuthority: registrationGate
      ? {
          approval: registrationGate.approval
            ? {
                approvalNo: registrationGate.approval.approvalNo,
                decision: registrationGate.approval.decision,
                id: registrationGate.approval.id,
                status: registrationGate.approval.status,
                subjectSnapshotHash: registrationGate.approval.subjectSnapshotHash,
                version: registrationGate.approval.version
              }
            : null,
          documentPresent: registrationGate.documentPresent,
          snapshotHash: registrationGate.snapshotHash
        }
      : null
  };
  return { hash: hashCanonical(snapshot), snapshot };
}

export function hashCanonical(value: unknown) {
  return `sha256:${createHash("sha256").update(stableSerialize(value), "utf8").digest("hex")}`;
}

function normalizeAccessoryItems(value: unknown): HandoverAccessoryItem[] {
  if (!Array.isArray(value)) {
    throw new Error("HANDOVER_EXPLICIT_FACTS_INVALID: accessoryItems");
  }
  const items = value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`HANDOVER_EXPLICIT_FACTS_INVALID: accessoryItems[${index}]`);
    }
    const code = requireText(item.code, `accessoryItems[${index}].code`).toUpperCase();
    const name = requireText(item.name, `accessoryItems[${index}].name`);
    const state = item.state;
    if (!isOneOf(state, HANDOVER_ACCESSORY_STATES)) {
      throw new Error(`HANDOVER_EXPLICIT_FACTS_INVALID: accessoryItems[${index}].state`);
    }
    return {
      code,
      name,
      quantity: requireNonNegativeInteger(item.quantity, `accessoryItems[${index}].quantity`),
      remark: normalizeOptionalText(item.remark),
      state
    };
  });
  items.sort((left, right) => left.code.localeCompare(right.code));
  if (new Set(items.map((item) => item.code)).size !== items.length) {
    throw new Error("HANDOVER_EXPLICIT_FACTS_INVALID: duplicate accessory code");
  }
  return items;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireText(value: unknown, key: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`HANDOVER_EXPLICIT_FACTS_INVALID: ${key}`);
  }
  return value.trim();
}

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireNonNegativeInteger(value: unknown, key: string) {
  if (!isNonNegativeInteger(value)) {
    throw new Error(`HANDOVER_EXPLICIT_FACTS_INVALID: ${key}`);
  }
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
