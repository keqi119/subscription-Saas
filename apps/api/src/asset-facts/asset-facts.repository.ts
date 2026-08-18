import { ConflictException, Injectable } from "@nestjs/common";
import {
  Prisma,
  type VehicleOwnershipPeriod,
  type VehicleSubscriptionPeriod
} from "@prisma/client";
import { isDeepStrictEqual } from "node:util";

import type {
  CloseOwnershipPeriodInput,
  CloseSubscriptionPeriodInput,
  OpenOwnershipPeriodInput,
  OpenSubscriptionPeriodInput,
  StableFactSource
} from "./asset-facts.types";

export const ASSET_FACT_CONFLICT_CODE = {
  OWNERSHIP_CLOSE_REPLAY: "OWNERSHIP_PERIOD_CLOSE_REPLAY_CONFLICT",
  OWNERSHIP_END_SOURCE: "OWNERSHIP_PERIOD_END_SOURCE_CONFLICT",
  OWNERSHIP_OPEN_VEHICLE: "OWNERSHIP_PERIOD_OPEN_VEHICLE_CONFLICT",
  OWNERSHIP_OVERLAP: "OWNERSHIP_PERIOD_OVERLAP_CONFLICT",
  OWNERSHIP_RANGE: "OWNERSHIP_PERIOD_RANGE_CONFLICT",
  OWNERSHIP_START_SOURCE: "OWNERSHIP_PERIOD_START_SOURCE_CONFLICT",
  OWNERSHIP_WRITE: "OWNERSHIP_PERIOD_WRITE_CONFLICT",
  TRANSACTION_CONTRACT: "ASSET_FACT_TRANSACTION_CONTRACT_VIOLATION",
  SUBSCRIPTION_CLOSE_REPLAY: "SUBSCRIPTION_PERIOD_CLOSE_REPLAY_CONFLICT",
  SUBSCRIPTION_END_SOURCE: "SUBSCRIPTION_PERIOD_END_SOURCE_CONFLICT",
  SUBSCRIPTION_OPEN_ORDER: "SUBSCRIPTION_PERIOD_OPEN_ORDER_CONFLICT",
  SUBSCRIPTION_OPEN_VEHICLE: "SUBSCRIPTION_PERIOD_OPEN_VEHICLE_CONFLICT",
  SUBSCRIPTION_OVERLAP: "SUBSCRIPTION_PERIOD_OVERLAP_CONFLICT",
  SUBSCRIPTION_RANGE: "SUBSCRIPTION_PERIOD_RANGE_CONFLICT",
  SUBSCRIPTION_START_SOURCE: "SUBSCRIPTION_PERIOD_START_SOURCE_CONFLICT",
  SUBSCRIPTION_WRITE: "SUBSCRIPTION_PERIOD_WRITE_CONFLICT"
} as const;

type AssetFactConflictCode =
  (typeof ASSET_FACT_CONFLICT_CODE)[keyof typeof ASSET_FACT_CONFLICT_CODE];
type PeriodKind = "ownership" | "subscription";

const CONSTRAINT_CONFLICT_CODES: Readonly<Record<string, AssetFactConflictCode>> = {
  vehicle_ownership_period_end_after_start_chk: ASSET_FACT_CONFLICT_CODE.OWNERSHIP_RANGE,
  vehicle_ownership_period_end_source_key: ASSET_FACT_CONFLICT_CODE.OWNERSHIP_END_SOURCE,
  vehicle_ownership_period_no_overlap_excl: ASSET_FACT_CONFLICT_CODE.OWNERSHIP_OVERLAP,
  vehicle_ownership_period_one_open_per_vehicle_uidx:
    ASSET_FACT_CONFLICT_CODE.OWNERSHIP_OPEN_VEHICLE,
  vehicle_ownership_period_start_source_key: ASSET_FACT_CONFLICT_CODE.OWNERSHIP_START_SOURCE,
  vehicle_subscription_period_end_after_start_chk: ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_RANGE,
  vehicle_subscription_period_end_source_key: ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_END_SOURCE,
  vehicle_subscription_period_no_overlap_excl: ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OVERLAP,
  vehicle_subscription_period_one_open_per_order_uidx:
    ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OPEN_ORDER,
  vehicle_subscription_period_one_open_per_vehicle_uidx:
    ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OPEN_VEHICLE,
  vehicle_subscription_period_start_source_key: ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE
};

const CONFLICT_MESSAGES: Readonly<Record<AssetFactConflictCode, string>> = {
  [ASSET_FACT_CONFLICT_CODE.OWNERSHIP_CLOSE_REPLAY]:
    "The ownership period was already closed by a different command.",
  [ASSET_FACT_CONFLICT_CODE.OWNERSHIP_END_SOURCE]:
    "The ownership end source identity is already bound to different facts.",
  [ASSET_FACT_CONFLICT_CODE.OWNERSHIP_OPEN_VEHICLE]:
    "The vehicle already has an open ownership period.",
  [ASSET_FACT_CONFLICT_CODE.OWNERSHIP_OVERLAP]:
    "The ownership period overlaps another period for the vehicle.",
  [ASSET_FACT_CONFLICT_CODE.OWNERSHIP_RANGE]:
    "The ownership period end must be later than its start.",
  [ASSET_FACT_CONFLICT_CODE.OWNERSHIP_START_SOURCE]:
    "The ownership start source identity is already bound to different facts.",
  [ASSET_FACT_CONFLICT_CODE.OWNERSHIP_WRITE]:
    "The ownership period conflicts with the current database state.",
  [ASSET_FACT_CONFLICT_CODE.TRANSACTION_CONTRACT]:
    "Asset fact commands require a caller-provided PostgreSQL READ COMMITTED interactive transaction.",
  [ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_CLOSE_REPLAY]:
    "The subscription period was already closed by a different command.",
  [ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_END_SOURCE]:
    "The subscription end source identity is already bound to different facts.",
  [ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OPEN_ORDER]:
    "The order already has an open subscription period.",
  [ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OPEN_VEHICLE]:
    "The vehicle already has an open subscription period.",
  [ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OVERLAP]:
    "The subscription period overlaps another period for the vehicle.",
  [ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_RANGE]:
    "The subscription period end must be later than its start.",
  [ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE]:
    "The subscription start source identity is already bound to different facts.",
  [ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_WRITE]:
    "The subscription period conflicts with the current database state."
};

/**
 * Every command requires a caller-provided Prisma interactive transaction running at PostgreSQL
 * READ COMMITTED. The repository never starts or owns a transaction. Start-source advisory locks
 * and close compare-and-set semantics are valid only inside that caller-owned transaction.
 */
@Injectable()
export class AssetFactsRepository {
  async openSubscriptionPeriod(
    tx: Prisma.TransactionClient,
    input: OpenSubscriptionPeriodInput
  ): Promise<VehicleSubscriptionPeriod> {
    await assertTransactionContract(tx);
    const normalizedInput = { ...input, snapshot: normalizeSnapshot(input.snapshot) };
    await lockStartSource(tx, "subscription", normalizedInput.source);
    const existing = await findSubscriptionByStartSource(tx, normalizedInput);
    if (existing) return replaySubscriptionStart(existing, normalizedInput);

    try {
      return await tx.vehicleSubscriptionPeriod.create({
        data: {
          contractId: normalizedInput.contractId,
          contractSegmentId: normalizedInput.contractSegmentId,
          createdBy: normalizedInput.actorId,
          customerId: normalizedInput.customerId,
          orderId: normalizedInput.orderId,
          startConfirmedAt: normalizedInput.confirmedAt,
          startConfirmedBy: normalizedInput.actorId,
          startReason: normalizedInput.reason,
          startSnapshot: normalizedInput.snapshot,
          startSourceId: normalizedInput.source.id,
          startSourceKey: normalizedInput.source.key,
          startSourceType: normalizedInput.source.type,
          startedAt: normalizedInput.startedAt,
          vehicleId: normalizedInput.vehicleId
        }
      });
    } catch (error) {
      throw normalizeDatabaseConflict(error, "subscription");
    }
  }

  async closeSubscriptionPeriod(
    tx: Prisma.TransactionClient,
    input: CloseSubscriptionPeriodInput
  ): Promise<VehicleSubscriptionPeriod> {
    await assertTransactionContract(tx);
    const normalizedInput = { ...input, snapshot: normalizeSnapshot(input.snapshot) };
    const replay = await findSubscriptionByEndSource(tx, normalizedInput);
    if (replay) return replaySubscriptionClose(replay, normalizedInput);

    const period = await findSubscriptionById(tx, normalizedInput.periodId);
    if (!period || period.endedAt) {
      throw conflict(ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_CLOSE_REPLAY);
    }

    try {
      const updated = await tx.vehicleSubscriptionPeriod.updateMany({
        data: {
          endConfirmedAt: normalizedInput.confirmedAt,
          endConfirmedBy: normalizedInput.actorId,
          endReason: normalizedInput.reason,
          endSnapshot: normalizedInput.snapshot,
          endSourceId: normalizedInput.source.id,
          endSourceKey: normalizedInput.source.key,
          endSourceType: normalizedInput.source.type,
          endedAt: normalizedInput.endedAt
        },
        where: { endedAt: null, id: normalizedInput.periodId }
      });
      if (updated.count !== 1) {
        return await resolveSubscriptionCloseRace(tx, normalizedInput);
      }
    } catch (error) {
      throw normalizeDatabaseConflict(error, "subscription");
    }

    const closed = await findSubscriptionById(tx, normalizedInput.periodId);
    if (!closed) throw conflict(ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_CLOSE_REPLAY);
    return closed;
  }

  async openOwnershipPeriod(
    tx: Prisma.TransactionClient,
    input: OpenOwnershipPeriodInput
  ): Promise<VehicleOwnershipPeriod> {
    await assertTransactionContract(tx);
    const normalizedInput = { ...input, snapshot: normalizeSnapshot(input.snapshot) };
    await lockStartSource(tx, "ownership", normalizedInput.source);
    const existing = await findOwnershipByStartSource(tx, normalizedInput);
    if (existing) return replayOwnershipStart(existing, normalizedInput);

    try {
      return await tx.vehicleOwnershipPeriod.create({
        data: {
          assetOwnerId: normalizedInput.assetOwnerId,
          createdBy: normalizedInput.actorId,
          startConfirmedAt: normalizedInput.confirmedAt,
          startConfirmedBy: normalizedInput.actorId,
          startReason: normalizedInput.reason,
          startSnapshot: normalizedInput.snapshot,
          startSourceId: normalizedInput.source.id,
          startSourceKey: normalizedInput.source.key,
          startSourceType: normalizedInput.source.type,
          startedAt: normalizedInput.startedAt,
          vehicleId: normalizedInput.vehicleId
        }
      });
    } catch (error) {
      throw normalizeDatabaseConflict(error, "ownership");
    }
  }

  async closeOwnershipPeriod(
    tx: Prisma.TransactionClient,
    input: CloseOwnershipPeriodInput
  ): Promise<VehicleOwnershipPeriod> {
    await assertTransactionContract(tx);
    const normalizedInput = { ...input, snapshot: normalizeSnapshot(input.snapshot) };
    const replay = await findOwnershipByEndSource(tx, normalizedInput);
    if (replay) return replayOwnershipClose(replay, normalizedInput);

    const period = await findOwnershipById(tx, normalizedInput.periodId);
    if (!period || period.endedAt) {
      throw conflict(ASSET_FACT_CONFLICT_CODE.OWNERSHIP_CLOSE_REPLAY);
    }

    try {
      const updated = await tx.vehicleOwnershipPeriod.updateMany({
        data: {
          endConfirmedAt: normalizedInput.confirmedAt,
          endConfirmedBy: normalizedInput.actorId,
          endReason: normalizedInput.reason,
          endSnapshot: normalizedInput.snapshot,
          endSourceId: normalizedInput.source.id,
          endSourceKey: normalizedInput.source.key,
          endSourceType: normalizedInput.source.type,
          endedAt: normalizedInput.endedAt
        },
        where: { endedAt: null, id: normalizedInput.periodId }
      });
      if (updated.count !== 1) {
        return await resolveOwnershipCloseRace(tx, normalizedInput);
      }
    } catch (error) {
      throw normalizeDatabaseConflict(error, "ownership");
    }

    const closed = await findOwnershipById(tx, normalizedInput.periodId);
    if (!closed) throw conflict(ASSET_FACT_CONFLICT_CODE.OWNERSHIP_CLOSE_REPLAY);
    return closed;
  }
}

const SUBSCRIPTION_LIVE_AGGREGATE_FILTER = {
  customer: { deletedAt: null },
  order: { deletedAt: null },
  vehicle: { deletedAt: null }
} satisfies Prisma.VehicleSubscriptionPeriodWhereInput;

const OWNERSHIP_LIVE_AGGREGATE_FILTER = {
  vehicle: { deletedAt: null }
} satisfies Prisma.VehicleOwnershipPeriodWhereInput;

async function assertTransactionContract(tx: Prisma.TransactionClient) {
  const [firstProbe] = await tx.$queryRaw<Array<{ isolationLevel: string; transactionId: string }>>(
    Prisma.sql`
      SELECT
        current_setting('transaction_isolation') AS "isolationLevel",
        txid_current()::text AS "transactionId"
    `
  );
  const [secondProbe] = await tx.$queryRaw<Array<{ transactionId: string }>>(
    Prisma.sql`SELECT txid_current()::text AS "transactionId"`
  );
  if (
    firstProbe?.isolationLevel !== "read committed" ||
    !firstProbe.transactionId ||
    firstProbe.transactionId !== secondProbe?.transactionId
  ) {
    throw conflict(ASSET_FACT_CONFLICT_CODE.TRANSACTION_CONTRACT);
  }
}

function normalizeSnapshot(snapshot: Prisma.InputJsonObject): Prisma.JsonObject {
  const normalized: unknown = JSON.parse(JSON.stringify(snapshot));
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError("Asset fact snapshots must serialize to a JSON object.");
  }
  return normalized as Prisma.JsonObject;
}

async function lockStartSource(
  tx: Prisma.TransactionClient,
  periodKind: PeriodKind,
  source: StableFactSource
) {
  const lockKey = JSON.stringify([
    "asset-facts",
    periodKind,
    "start",
    source.type,
    source.id,
    source.key
  ]);
  await tx.$queryRaw(
    Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
  );
}

function subscriptionLiveWhere(
  where: Prisma.VehicleSubscriptionPeriodWhereInput
): Prisma.VehicleSubscriptionPeriodWhereInput {
  return {
    ...where,
    ...SUBSCRIPTION_LIVE_AGGREGATE_FILTER,
    OR: [{ contractId: null }, { contract: { deletedAt: null } }]
  };
}

function findSubscriptionByStartSource(
  tx: Prisma.TransactionClient,
  input: OpenSubscriptionPeriodInput
) {
  return tx.vehicleSubscriptionPeriod.findFirst({
    where: subscriptionLiveWhere({
      startSourceId: input.source.id,
      startSourceKey: input.source.key,
      startSourceType: input.source.type
    })
  });
}

function findSubscriptionByEndSource(
  tx: Prisma.TransactionClient,
  input: CloseSubscriptionPeriodInput
) {
  return tx.vehicleSubscriptionPeriod.findFirst({
    where: subscriptionLiveWhere({
      endSourceId: input.source.id,
      endSourceKey: input.source.key,
      endSourceType: input.source.type
    })
  });
}

function findSubscriptionById(tx: Prisma.TransactionClient, periodId: string) {
  return tx.vehicleSubscriptionPeriod.findFirst({
    where: subscriptionLiveWhere({ id: periodId })
  });
}

function findOwnershipByStartSource(tx: Prisma.TransactionClient, input: OpenOwnershipPeriodInput) {
  return tx.vehicleOwnershipPeriod.findFirst({
    where: {
      ...OWNERSHIP_LIVE_AGGREGATE_FILTER,
      startSourceId: input.source.id,
      startSourceKey: input.source.key,
      startSourceType: input.source.type
    }
  });
}

function findOwnershipByEndSource(tx: Prisma.TransactionClient, input: CloseOwnershipPeriodInput) {
  return tx.vehicleOwnershipPeriod.findFirst({
    where: {
      ...OWNERSHIP_LIVE_AGGREGATE_FILTER,
      endSourceId: input.source.id,
      endSourceKey: input.source.key,
      endSourceType: input.source.type
    }
  });
}

function findOwnershipById(tx: Prisma.TransactionClient, periodId: string) {
  return tx.vehicleOwnershipPeriod.findFirst({
    where: { ...OWNERSHIP_LIVE_AGGREGATE_FILTER, id: periodId }
  });
}

function replaySubscriptionStart(
  existing: VehicleSubscriptionPeriod,
  input: OpenSubscriptionPeriodInput
) {
  if (sameSubscriptionStart(existing, input)) return existing;
  throw conflict(ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE);
}

function replaySubscriptionClose(
  existing: VehicleSubscriptionPeriod,
  input: CloseSubscriptionPeriodInput
) {
  if (sameSubscriptionClose(existing, input)) return existing;
  throw conflict(ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_END_SOURCE);
}

function replayOwnershipStart(existing: VehicleOwnershipPeriod, input: OpenOwnershipPeriodInput) {
  if (sameOwnershipStart(existing, input)) return existing;
  throw conflict(ASSET_FACT_CONFLICT_CODE.OWNERSHIP_START_SOURCE);
}

function replayOwnershipClose(existing: VehicleOwnershipPeriod, input: CloseOwnershipPeriodInput) {
  if (sameOwnershipClose(existing, input)) return existing;
  throw conflict(ASSET_FACT_CONFLICT_CODE.OWNERSHIP_END_SOURCE);
}

async function resolveSubscriptionCloseRace(
  tx: Prisma.TransactionClient,
  input: CloseSubscriptionPeriodInput
) {
  const replay = await findSubscriptionByEndSource(tx, input);
  if (replay) return replaySubscriptionClose(replay, input);
  throw conflict(ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_CLOSE_REPLAY);
}

async function resolveOwnershipCloseRace(
  tx: Prisma.TransactionClient,
  input: CloseOwnershipPeriodInput
) {
  const replay = await findOwnershipByEndSource(tx, input);
  if (replay) return replayOwnershipClose(replay, input);
  throw conflict(ASSET_FACT_CONFLICT_CODE.OWNERSHIP_CLOSE_REPLAY);
}

function sameSubscriptionStart(
  existing: VehicleSubscriptionPeriod,
  input: OpenSubscriptionPeriodInput
) {
  return (
    existing.vehicleId === input.vehicleId &&
    existing.orderId === input.orderId &&
    existing.contractId === input.contractId &&
    existing.contractSegmentId === input.contractSegmentId &&
    existing.customerId === input.customerId &&
    sameDate(existing.startedAt, input.startedAt) &&
    existing.startReason === input.reason &&
    existing.startSourceType === input.source.type &&
    existing.startSourceId === input.source.id &&
    existing.startSourceKey === input.source.key &&
    isDeepStrictEqual(existing.startSnapshot, input.snapshot) &&
    existing.startConfirmedBy === input.actorId &&
    sameNullableDate(existing.startConfirmedAt, input.confirmedAt)
  );
}

function sameSubscriptionClose(
  existing: VehicleSubscriptionPeriod,
  input: CloseSubscriptionPeriodInput
) {
  return (
    existing.id === input.periodId &&
    sameNullableDate(existing.endedAt, input.endedAt) &&
    existing.endReason === input.reason &&
    existing.endSourceType === input.source.type &&
    existing.endSourceId === input.source.id &&
    existing.endSourceKey === input.source.key &&
    isDeepStrictEqual(existing.endSnapshot, input.snapshot) &&
    existing.endConfirmedBy === input.actorId &&
    sameNullableDate(existing.endConfirmedAt, input.confirmedAt)
  );
}

function sameOwnershipStart(existing: VehicleOwnershipPeriod, input: OpenOwnershipPeriodInput) {
  return (
    existing.vehicleId === input.vehicleId &&
    existing.assetOwnerId === input.assetOwnerId &&
    sameDate(existing.startedAt, input.startedAt) &&
    existing.startReason === input.reason &&
    existing.startSourceType === input.source.type &&
    existing.startSourceId === input.source.id &&
    existing.startSourceKey === input.source.key &&
    isDeepStrictEqual(existing.startSnapshot, input.snapshot) &&
    existing.startConfirmedBy === input.actorId &&
    sameNullableDate(existing.startConfirmedAt, input.confirmedAt)
  );
}

function sameOwnershipClose(existing: VehicleOwnershipPeriod, input: CloseOwnershipPeriodInput) {
  return (
    existing.id === input.periodId &&
    sameNullableDate(existing.endedAt, input.endedAt) &&
    existing.endReason === input.reason &&
    existing.endSourceType === input.source.type &&
    existing.endSourceId === input.source.id &&
    existing.endSourceKey === input.source.key &&
    isDeepStrictEqual(existing.endSnapshot, input.snapshot) &&
    existing.endConfirmedBy === input.actorId &&
    sameNullableDate(existing.endConfirmedAt, input.confirmedAt)
  );
}

function sameDate(left: Date, right: Date) {
  return left.getTime() === right.getTime();
}

function sameNullableDate(left: Date | null, right: Date) {
  return left?.getTime() === right.getTime();
}

function normalizeDatabaseConflict(error: unknown, periodKind: PeriodKind): Error {
  const constraintName = findKnownConstraintName(error);
  if (constraintName) return conflict(CONSTRAINT_CONFLICT_CODES[constraintName]!);

  const targetConflict = conflictFromPrismaTarget(error, periodKind);
  if (targetConflict) return conflict(targetConflict);

  const databaseCode = findDatabaseCode(error);
  if (databaseCode === "23P01") {
    return conflict(
      periodKind === "subscription"
        ? ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OVERLAP
        : ASSET_FACT_CONFLICT_CODE.OWNERSHIP_OVERLAP
    );
  }
  if (databaseCode === "23514") {
    return conflict(
      periodKind === "subscription"
        ? ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_RANGE
        : ASSET_FACT_CONFLICT_CODE.OWNERSHIP_RANGE
    );
  }
  if (databaseCode === "23505" || prismaErrorCode(error) === "P2002") {
    return conflict(
      periodKind === "subscription"
        ? ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_WRITE
        : ASSET_FACT_CONFLICT_CODE.OWNERSHIP_WRITE
    );
  }
  return error instanceof Error
    ? error
    : new Error("Asset fact database write failed", { cause: error });
}

function conflictFromPrismaTarget(error: unknown, periodKind: PeriodKind) {
  const values = [
    ...findStringsAtKey(error, "constraint"),
    ...findStringsAtKey(error, "target")
  ].map((value) => value.toLowerCase());
  const target = values.join(" ");
  if (target.includes("startsource") || target.includes("start_source")) {
    return periodKind === "subscription"
      ? ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE
      : ASSET_FACT_CONFLICT_CODE.OWNERSHIP_START_SOURCE;
  }
  if (target.includes("endsource") || target.includes("end_source")) {
    return periodKind === "subscription"
      ? ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_END_SOURCE
      : ASSET_FACT_CONFLICT_CODE.OWNERSHIP_END_SOURCE;
  }
  if (
    periodKind === "subscription" &&
    (target.includes("orderid") || target.includes("order_id"))
  ) {
    return ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OPEN_ORDER;
  }
  if (target.includes("vehicleid") || target.includes("vehicle_id")) {
    return periodKind === "subscription"
      ? ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OPEN_VEHICLE
      : ASSET_FACT_CONFLICT_CODE.OWNERSHIP_OPEN_VEHICLE;
  }
  return undefined;
}

function findKnownConstraintName(error: unknown) {
  const strings = collectStrings(error);
  return Object.keys(CONSTRAINT_CONFLICT_CODES).find((name) =>
    strings.some((value) => value.includes(name))
  );
}

function findDatabaseCode(error: unknown) {
  const codes = collectStrings(error);
  return codes.find((value) => value === "23505" || value === "23514" || value === "23P01");
}

function prismaErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function findStringsAtKey(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = key in record ? collectStrings(record[key]) : [];
  return [
    ...own,
    ...Object.entries(record).flatMap(([childKey, child]) =>
      childKey === key ? [] : findStringsAtKey(child, key)
    )
  ];
}

function collectStrings(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>).flatMap((child) =>
    collectStrings(child, seen)
  );
}

function conflict(code: AssetFactConflictCode) {
  return new ConflictException({ code, message: CONFLICT_MESSAGES[code] });
}
