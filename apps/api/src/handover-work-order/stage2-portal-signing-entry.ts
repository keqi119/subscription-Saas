import { Prisma } from "@prisma/client";

export const STAGE2_PORTAL_SIGNING_REENTRY_COOLDOWN_MS = 60_000;

export interface PortalSigningEntryMetadata {
  claimToken: string | null;
  claimUntil: Date | null;
  lastIssuedAt: Date | null;
}

type PortalSigningSnapshot =
  | Prisma.InputJsonValue
  | Prisma.JsonValue
  | null;

export function readPortalSigningEntry(
  snapshot: PortalSigningSnapshot
): PortalSigningEntryMetadata {
  const entry = asRecord(asRecord(snapshot)?.portalSigningEntry);
  return {
    claimToken: stringValue(entry?.claimToken),
    claimUntil: dateValue(entry?.claimUntil),
    lastIssuedAt: dateValue(entry?.lastIssuedAt)
  };
}

export function withPortalSigningEntryClaim(
  snapshot: PortalSigningSnapshot,
  input: { claimToken: string; claimUntil: Date }
): Prisma.InputJsonValue {
  const current = readPortalSigningEntry(snapshot);
  return withEntry(snapshot, {
    claimToken: input.claimToken,
    claimUntil: input.claimUntil.toISOString(),
    lastIssuedAt: current.lastIssuedAt?.toISOString() ?? null
  });
}

export function withPortalSigningEntryIssued(
  snapshot: PortalSigningSnapshot,
  input: { lastIssuedAt: Date }
): Prisma.InputJsonValue {
  return withEntry(snapshot, {
    claimToken: null,
    claimUntil: null,
    lastIssuedAt: input.lastIssuedAt.toISOString()
  });
}

export function withoutPortalSigningEntryClaim(
  snapshot: PortalSigningSnapshot
): Prisma.InputJsonValue {
  const current = readPortalSigningEntry(snapshot);
  return withEntry(snapshot, {
    claimToken: null,
    claimUntil: null,
    lastIssuedAt: current.lastIssuedAt?.toISOString() ?? null
  });
}

export function getPortalSigningReentryAvailability(
  snapshot: PortalSigningSnapshot,
  databaseNow: Date
) {
  const entry = readPortalSigningEntry(snapshot);
  const issuedAvailableAt = entry.lastIssuedAt
    ? new Date(
        entry.lastIssuedAt.getTime() +
          STAGE2_PORTAL_SIGNING_REENTRY_COOLDOWN_MS
      )
    : null;
  const activeCandidates = [issuedAvailableAt, entry.claimUntil].filter(
    (value): value is Date =>
      Boolean(value && value.getTime() > databaseNow.getTime())
  );
  const availableAt = activeCandidates.length
    ? new Date(Math.max(...activeCandidates.map((value) => value.getTime())))
    : null;
  return {
    availableAt,
    remainingSeconds: availableAt
      ? Math.ceil(
          (availableAt.getTime() - databaseNow.getTime()) / 1_000
        )
      : 0
  };
}

function withEntry(
  snapshot: PortalSigningSnapshot,
  entry: Record<string, Prisma.InputJsonValue | null>
): Prisma.InputJsonObject {
  return {
    ...toInputObject(snapshot),
    portalSigningEntry: entry
  };
}

function toInputObject(
  value: PortalSigningSnapshot
): Prisma.InputJsonObject {
  const record = asRecord(value);
  return record ? { ...record } as Prisma.InputJsonObject : {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function dateValue(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
