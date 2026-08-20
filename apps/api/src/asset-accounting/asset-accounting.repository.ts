import { ConflictException, Injectable } from "@nestjs/common";
import {
  Prisma,
  type VehicleCostActionType,
  type VehicleCostCategory,
  type VehicleCostLedgerEntry,
  type VehicleCostResponsiblePartyType
} from "@prisma/client";
import { randomUUID } from "node:crypto";

import {
  assertAccountingPeriod,
  assertAssetAccountingSource,
  assertVehicleCostAmountCents,
  canonicalAssetAccountingJson,
  hashBusinessExceptionSnapshot
} from "./asset-accounting.domain";
import type {
  AssetAccountingSnapshotObject,
  AssetAccountingSnapshotValue,
  AssetAccountingSource,
  VehicleCostLedgerEntrySnapshot
} from "./asset-accounting.types";

export const ASSET_ACCOUNTING_ERROR_CODE = {
  AUTHORITY_BUSY: "ASSET_ACCOUNTING_AUTHORITY_BUSY",
  AUTHORITY_MISMATCH: "ASSET_ACCOUNTING_AUTHORITY_MISMATCH",
  AUTHORITY_NOT_FOUND: "ASSET_ACCOUNTING_AUTHORITY_NOT_FOUND",
  AUTHORITY_NOT_LIVE: "ASSET_ACCOUNTING_AUTHORITY_NOT_LIVE",
  COST_ENTRY_NOT_FOUND: "ASSET_ACCOUNTING_COST_ENTRY_NOT_FOUND",
  INVALID_COST_COMMAND: "ASSET_ACCOUNTING_INVALID_COST_COMMAND",
  REVERSAL_ALREADY_EXISTS: "ASSET_ACCOUNTING_REVERSAL_ALREADY_EXISTS",
  REVERSAL_INVALID: "ASSET_ACCOUNTING_REVERSAL_INVALID",
  SOURCE_CONFLICT: "ASSET_ACCOUNTING_SOURCE_CONFLICT",
  TRANSACTION_REQUIRED: "ASSET_ACCOUNTING_TRANSACTION_REQUIRED",
  WRITE_CONFLICT: "ASSET_ACCOUNTING_WRITE_CONFLICT"
} as const;

type AssetAccountingErrorCode =
  (typeof ASSET_ACCOUNTING_ERROR_CODE)[keyof typeof ASSET_ACCOUNTING_ERROR_CODE];

const ERROR_MESSAGES: Readonly<Record<AssetAccountingErrorCode, string>> = {
  [ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY]:
    "An asset-accounting authority row is being updated. Review the current state and retry.",
  [ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_MISMATCH]:
    "The supplied asset-accounting authority identities do not describe the same facts.",
  [ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND]:
    "A supplied asset-accounting authority identity was not found.",
  [ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_LIVE]:
    "A supplied asset-accounting authority identity is not live.",
  [ASSET_ACCOUNTING_ERROR_CODE.COST_ENTRY_NOT_FOUND]:
    "The vehicle cost ledger entry was not found.",
  [ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND]: "The vehicle cost command is invalid.",
  [ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_ALREADY_EXISTS]:
    "The vehicle cost ledger entry already has a reversal.",
  [ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_INVALID]: "The requested vehicle cost reversal is invalid.",
  [ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT]:
    "The stable asset-accounting source is already bound to a different command or payload.",
  [ASSET_ACCOUNTING_ERROR_CODE.TRANSACTION_REQUIRED]:
    "Asset-accounting commands require a caller-provided PostgreSQL READ COMMITTED interactive transaction.",
  [ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT]:
    "The asset-accounting command conflicts with the current database state."
};

export interface AppendCostEntryCommand {
  readonly actionType: VehicleCostActionType;
  readonly accountingPeriod: string;
  readonly actorId: string;
  readonly amountCents: bigint;
  readonly assetOwnerId?: string | null;
  readonly assetOwnerSnapshot?: AssetAccountingSnapshotObject | null;
  readonly confirmedAt: Date;
  readonly contractId?: string | null;
  readonly costCategory: VehicleCostCategory;
  readonly customerId?: string | null;
  readonly evidenceId?: string | null;
  readonly evidenceSnapshot?: AssetAccountingSnapshotObject | null;
  readonly occurredOn: Date;
  readonly orderId?: string | null;
  readonly responsiblePartyId?: string | null;
  readonly responsiblePartyType: VehicleCostResponsiblePartyType;
  readonly responsibilitySnapshot: AssetAccountingSnapshotObject;
  readonly source: AssetAccountingSource;
  readonly vehicleId: string;
  readonly workOrderId?: string | null;
}

export interface ReverseCostEntryCommand {
  readonly actorId: string;
  readonly confirmedAt: Date;
  readonly originalEntryId: string;
  readonly source: AssetAccountingSource;
}

export interface AssetAccountingCostCommandOutcome {
  readonly outcome: VehicleCostLedgerEntrySnapshot;
  readonly wrote: boolean;
}

type NormalizedAppendCommand = Omit<
  AppendCostEntryCommand,
  "assetOwnerSnapshot" | "evidenceSnapshot" | "responsibilitySnapshot"
> & {
  readonly assetOwnerId: string | null;
  readonly assetOwnerSnapshot: Prisma.JsonObject | null;
  readonly contractId: string | null;
  readonly customerId: string | null;
  readonly evidenceId: string | null;
  readonly evidenceSnapshot: Prisma.JsonObject | null;
  readonly orderId: string | null;
  readonly responsiblePartyId: string | null;
  readonly responsibilitySnapshot: Prisma.JsonObject;
  readonly workOrderId: string | null;
};

type AuthorityTable =
  | "asset_owner"
  | "asset_work_order"
  | "asset_work_order_evidence"
  | "contract"
  | "customer"
  | "subscription_order"
  | "user"
  | "vehicle";

type AuthorityLock = Readonly<{ id: string; table: AuthorityTable }>;

const CONSTRAINT_CODES: Readonly<Record<string, AssetAccountingErrorCode>> = {
  asset_accounting_command_receipt_payload_hash_chk: ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT,
  asset_accounting_command_receipt_source_key: ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT,
  asset_accounting_command_receipt_source_key_not_blank_chk:
    ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND,
  asset_accounting_command_receipt_target_shape_chk: ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT,
  vehicle_cost_ledger_entry_accounting_period_chk: ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND,
  vehicle_cost_ledger_entry_amount_nonzero_chk: ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND,
  vehicle_cost_ledger_entry_kind_amount_shape_chk: ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND,
  vehicle_cost_ledger_entry_reversal_amount_chk: ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_INVALID,
  vehicle_cost_ledger_entry_reversal_of_entry_id_key:
    ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_ALREADY_EXISTS,
  vehicle_cost_ledger_entry_reversal_reference_chk: ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_INVALID,
  vehicle_cost_ledger_entry_reversal_target_fkey: ASSET_ACCOUNTING_ERROR_CODE.COST_ENTRY_NOT_FOUND,
  vehicle_cost_ledger_entry_reverse_of_reversal_chk: ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_INVALID,
  vehicle_cost_ledger_entry_source_key_not_blank_chk:
    ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND,
  vehicle_cost_ledger_entry_asset_owner_id_fkey: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND,
  vehicle_cost_ledger_entry_confirmed_by_fkey: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND,
  vehicle_cost_ledger_entry_contract_id_fkey: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND,
  vehicle_cost_ledger_entry_customer_id_fkey: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND,
  vehicle_cost_ledger_entry_evidence_id_fkey: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND,
  vehicle_cost_ledger_entry_order_id_fkey: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND,
  vehicle_cost_ledger_entry_reversal_of_entry_id_fkey:
    ASSET_ACCOUNTING_ERROR_CODE.COST_ENTRY_NOT_FOUND,
  vehicle_cost_ledger_entry_vehicle_id_fkey: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND,
  vehicle_cost_ledger_entry_work_order_id_fkey: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND
};

/**
 * Immutable vehicle-cost persistence. Mutations require a caller-owned
 * PostgreSQL READ COMMITTED interactive transaction; this repository never
 * opens, commits, or rolls back a transaction.
 */
@Injectable()
export class AssetAccountingRepository {
  async lockSourceOwnership(
    tx: Prisma.TransactionClient,
    source: AssetAccountingSource
  ): Promise<void> {
    assertAssetAccountingSource(source);
    await assertTransactionContract(tx);
    const exactTuple = JSON.stringify([source.type, source.id, source.key]);
    await tx.$queryRaw(
      Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${exactTuple}, 0))`
    );
  }

  async appendCostEntry(
    tx: Prisma.TransactionClient,
    command: AppendCostEntryCommand
  ): Promise<AssetAccountingCostCommandOutcome> {
    const normalized = normalizeAppendCommand(command);
    const payload = appendPayload(normalized);
    await this.lockSourceOwnership(tx, normalized.source);
    const replay = await replayReceipt(tx, normalized.source, "COST_APPEND", payload);
    if (replay) return replay;

    const authoritativeOrderId = await contractAuthoritativeOrderId(tx, normalized.contractId);
    await lockAuthorityRows(tx, appendAuthorityLocks(normalized, authoritativeOrderId));
    await validateAppendAuthorities(tx, normalized, authoritativeOrderId);

    try {
      const entry = await tx.vehicleCostLedgerEntry.create({
        data: {
          actionType: normalized.actionType,
          accountingPeriod: normalized.accountingPeriod,
          amountCents: normalized.amountCents,
          assetOwnerId: normalized.assetOwnerId,
          assetOwnerSnapshot: jsonNullable(normalized.assetOwnerSnapshot),
          confirmedAt: normalized.confirmedAt,
          confirmedBy: normalized.actorId,
          contractId: normalized.contractId,
          costCategory: normalized.costCategory,
          customerId: normalized.customerId,
          entryKind: "ORIGINAL",
          evidenceId: normalized.evidenceId,
          evidenceSnapshot: jsonNullable(normalized.evidenceSnapshot),
          id: randomUUID(),
          occurredOn: normalized.occurredOn,
          orderId: normalized.orderId,
          responsiblePartyId: normalized.responsiblePartyId,
          responsiblePartyType: normalized.responsiblePartyType,
          responsibilitySnapshot: normalized.responsibilitySnapshot,
          reversalOfEntryId: null,
          sourceId: normalized.source.id,
          sourceKey: normalized.source.key,
          sourceType: normalized.source.type,
          vehicleId: normalized.vehicleId,
          workOrderId: normalized.workOrderId
        }
      });
      const outcome = projectEntry(entry);
      await createReceipt(
        tx,
        normalized.source,
        "COST_APPEND",
        payload,
        outcome,
        entry.id,
        normalized.actorId
      );
      return { outcome, wrote: true };
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async reverseCostEntry(
    tx: Prisma.TransactionClient,
    command: ReverseCostEntryCommand
  ): Promise<AssetAccountingCostCommandOutcome> {
    const normalized = normalizeReverseCommand(command);
    const payload = reversePayload(normalized);
    await this.lockSourceOwnership(tx, normalized.source);
    const replay = await replayReceipt(tx, normalized.source, "COST_REVERSE", payload);
    if (replay) return replay;

    await lockOriginalEntry(tx, normalized.originalEntryId);
    const original = await tx.vehicleCostLedgerEntry.findUnique({
      where: { id: normalized.originalEntryId }
    });
    if (!original) throw conflict(ASSET_ACCOUNTING_ERROR_CODE.COST_ENTRY_NOT_FOUND);
    if (original.entryKind !== "ORIGINAL") {
      throw conflict(ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_INVALID);
    }

    await lockAuthorityRows(tx, reverseAuthorityLocks(original, normalized.actorId));
    await validateReverseActor(tx, normalized.actorId);

    try {
      const reversal = await tx.vehicleCostLedgerEntry.create({
        data: {
          actionType: original.actionType,
          accountingPeriod: original.accountingPeriod,
          amountCents: -original.amountCents,
          assetOwnerId: original.assetOwnerId,
          assetOwnerSnapshot: jsonNullable(original.assetOwnerSnapshot),
          confirmedAt: normalized.confirmedAt,
          confirmedBy: normalized.actorId,
          contractId: original.contractId,
          costCategory: original.costCategory,
          customerId: original.customerId,
          entryKind: "REVERSAL",
          evidenceId: original.evidenceId,
          evidenceSnapshot: jsonNullable(original.evidenceSnapshot),
          id: randomUUID(),
          occurredOn: original.occurredOn,
          orderId: original.orderId,
          responsiblePartyId: original.responsiblePartyId,
          responsiblePartyType: original.responsiblePartyType,
          responsibilitySnapshot: jsonObject(original.responsibilitySnapshot),
          reversalOfEntryId: original.id,
          sourceId: normalized.source.id,
          sourceKey: normalized.source.key,
          sourceType: normalized.source.type,
          vehicleId: original.vehicleId,
          workOrderId: original.workOrderId
        }
      });
      const outcome = projectEntry(reversal);
      await createReceipt(
        tx,
        normalized.source,
        "COST_REVERSE",
        payload,
        outcome,
        reversal.id,
        normalized.actorId
      );
      return { outcome, wrote: true };
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async getCostEntry(
    tx: Prisma.TransactionClient,
    entryId: string
  ): Promise<VehicleCostLedgerEntrySnapshot | null> {
    await assertTransactionContract(tx);
    const entry = await tx.vehicleCostLedgerEntry.findUnique({ where: { id: entryId } });
    return entry ? projectEntry(entry) : null;
  }

  async listVehicleEntries(tx: Prisma.TransactionClient, vehicleId: string) {
    return listEntries(tx, { vehicleId });
  }

  async listOrderEntries(tx: Prisma.TransactionClient, orderId: string) {
    return listEntries(tx, { orderId });
  }

  async listWorkOrderEntries(tx: Prisma.TransactionClient, workOrderId: string) {
    return listEntries(tx, { workOrderId });
  }
}

async function listEntries(
  tx: Prisma.TransactionClient,
  where: Prisma.VehicleCostLedgerEntryWhereInput
) {
  await assertTransactionContract(tx);
  const entries = await tx.vehicleCostLedgerEntry.findMany({
    orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    where
  });
  return entries.map(projectEntry);
}

async function assertTransactionContract(tx: Prisma.TransactionClient) {
  const [first] = await tx.$queryRaw<Array<{ isolationLevel: string; transactionId: string }>>(
    Prisma.sql`
      SELECT current_setting('transaction_isolation') AS "isolationLevel",
             txid_current()::text AS "transactionId"
    `
  );
  const [second] = await tx.$queryRaw<Array<{ transactionId: string }>>(
    Prisma.sql`SELECT txid_current()::text AS "transactionId"`
  );
  if (
    first?.isolationLevel !== "read committed" ||
    !first.transactionId ||
    first.transactionId !== second?.transactionId
  ) {
    throw conflict(ASSET_ACCOUNTING_ERROR_CODE.TRANSACTION_REQUIRED);
  }
}

function normalizeAppendCommand(command: AppendCostEntryCommand): NormalizedAppendCommand {
  assertAssetAccountingSource(command.source);
  requireNonBlank(command.actorId);
  requireNonBlank(command.vehicleId);
  assertVehicleCostAmountCents(command.amountCents);
  if (command.amountCents <= 0n) throw conflict(ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND);
  assertAccountingPeriod(command.accountingPeriod);
  assertValidDate(command.occurredOn);
  assertValidDate(command.confirmedAt);
  const assetOwnerId = command.assetOwnerId ?? null;
  const evidenceId = command.evidenceId ?? null;
  const assetOwnerSnapshot = normalizeNullableSnapshot(command.assetOwnerSnapshot);
  const evidenceSnapshot = normalizeNullableSnapshot(command.evidenceSnapshot);
  if ((assetOwnerId === null) !== (assetOwnerSnapshot === null)) {
    throw conflict(ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND);
  }
  if ((evidenceId === null) !== (evidenceSnapshot === null)) {
    throw conflict(ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND);
  }
  return {
    ...command,
    assetOwnerId,
    assetOwnerSnapshot,
    contractId: command.contractId ?? null,
    customerId: command.customerId ?? null,
    evidenceId,
    evidenceSnapshot,
    orderId: command.orderId ?? null,
    responsiblePartyId: command.responsiblePartyId ?? null,
    responsibilitySnapshot: normalizeSnapshot(command.responsibilitySnapshot),
    workOrderId: command.workOrderId ?? null
  };
}

function normalizeReverseCommand(command: ReverseCostEntryCommand): ReverseCostEntryCommand {
  assertAssetAccountingSource(command.source);
  requireNonBlank(command.actorId);
  requireNonBlank(command.originalEntryId);
  assertValidDate(command.confirmedAt);
  return command;
}

function normalizeSnapshot(snapshot: unknown): Prisma.JsonObject {
  return JSON.parse(canonicalAssetAccountingJson(snapshot)) as Prisma.JsonObject;
}

function normalizeNullableSnapshot(snapshot: unknown): Prisma.JsonObject | null {
  return snapshot === null || snapshot === undefined ? null : normalizeSnapshot(snapshot);
}

function appendPayload(command: NormalizedAppendCommand) {
  return {
    actionType: command.actionType,
    accountingPeriod: command.accountingPeriod,
    actorId: command.actorId,
    amountCents: command.amountCents,
    assetOwnerId: command.assetOwnerId,
    assetOwnerSnapshot: command.assetOwnerSnapshot,
    confirmedAt: command.confirmedAt,
    contractId: command.contractId,
    costCategory: command.costCategory,
    customerId: command.customerId,
    evidenceId: command.evidenceId,
    evidenceSnapshot: command.evidenceSnapshot,
    occurredOn: command.occurredOn,
    orderId: command.orderId,
    responsiblePartyId: command.responsiblePartyId,
    responsiblePartyType: command.responsiblePartyType,
    responsibilitySnapshot: command.responsibilitySnapshot,
    vehicleId: command.vehicleId,
    workOrderId: command.workOrderId
  };
}

function reversePayload(command: ReverseCostEntryCommand) {
  return {
    actorId: command.actorId,
    confirmedAt: command.confirmedAt,
    originalEntryId: command.originalEntryId
  };
}

async function replayReceipt(
  tx: Prisma.TransactionClient,
  source: AssetAccountingSource,
  commandType: "COST_APPEND" | "COST_REVERSE",
  payload: object
): Promise<AssetAccountingCostCommandOutcome | null> {
  const receipt = await tx.assetAccountingCommandReceipt.findUnique({
    where: {
      sourceType_sourceId_sourceKey: {
        sourceId: source.id,
        sourceKey: source.key,
        sourceType: source.type
      }
    }
  });
  if (!receipt) return null;
  const canonicalPayload = canonicalAssetAccountingJson(payload);
  if (
    receipt.commandType !== commandType ||
    receipt.payloadHash !== hashBusinessExceptionSnapshot(payload) ||
    canonicalAssetAccountingJson(receipt.payloadSnapshot) !== canonicalPayload
  ) {
    throw conflict(ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT);
  }
  return { outcome: outcomeFromReceipt(receipt.outcomeSnapshot), wrote: false };
}

async function createReceipt(
  tx: Prisma.TransactionClient,
  source: AssetAccountingSource,
  commandType: "COST_APPEND" | "COST_REVERSE",
  payload: object,
  outcome: VehicleCostLedgerEntrySnapshot,
  costEntryId: string,
  actorId: string
) {
  const payloadSnapshot = JSON.parse(canonicalAssetAccountingJson(payload)) as Prisma.JsonObject;
  const outcomeSnapshot = publicOutcomeJson(outcome);
  await tx.assetAccountingCommandReceipt.create({
    data: {
      actorId,
      approvalId: null,
      commandType,
      costEntryId,
      id: randomUUID(),
      outcomeSnapshot,
      payloadHash: hashBusinessExceptionSnapshot(payload),
      payloadSnapshot,
      sourceId: source.id,
      sourceKey: source.key,
      sourceType: source.type
    }
  });
}

function appendAuthorityLocks(
  command: NormalizedAppendCommand,
  authoritativeOrderId: string | null
): AuthorityLock[] {
  return compactLocks([
    lock(command.assetOwnerId, "asset_owner"),
    lock(command.workOrderId, "asset_work_order"),
    lock(command.evidenceId, "asset_work_order_evidence"),
    lock(command.contractId, "contract"),
    lock(responsibleAuthorityId(command, "CUSTOMER"), "customer"),
    lock(command.customerId, "customer"),
    lock(authoritativeOrderId, "subscription_order"),
    lock(command.orderId, "subscription_order"),
    lock(command.actorId, "user"),
    lock(command.vehicleId, "vehicle"),
    lock(responsibleAuthorityId(command, "ASSET_OWNER"), "asset_owner")
  ]);
}

function reverseAuthorityLocks(original: VehicleCostLedgerEntry, actorId: string): AuthorityLock[] {
  return compactLocks([lock(original.workOrderId, "asset_work_order"), lock(actorId, "user")]);
}

function responsibleAuthorityId(
  command: NormalizedAppendCommand,
  type: "ASSET_OWNER" | "CUSTOMER"
) {
  return command.responsiblePartyType === type ? command.responsiblePartyId : null;
}

function lock(id: string | null | undefined, table: AuthorityTable): AuthorityLock | null {
  return id ? { id, table } : null;
}

function compactLocks(locks: ReadonlyArray<AuthorityLock | null>): AuthorityLock[] {
  const unique = new Map<string, AuthorityLock>();
  for (const item of locks) if (item) unique.set(`${item.table}:${item.id}`, item);
  return [...unique.values()].sort((left, right) =>
    left.table === right.table ? compare(left.id, right.id) : compare(left.table, right.table)
  );
}

async function lockAuthorityRows(tx: Prisma.TransactionClient, locks: readonly AuthorityLock[]) {
  try {
    for (const item of locks) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${item.table}"`)} WHERE "id" = ${item.id}::uuid FOR SHARE NOWAIT`
      );
    }
  } catch (error) {
    if (databaseCode(error) === "55P03") {
      throw conflict(ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY);
    }
    throw error;
  }
}

async function lockOriginalEntry(tx: Prisma.TransactionClient, originalEntryId: string) {
  try {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "vehicle_cost_ledger_entry" WHERE "id" = ${originalEntryId}::uuid FOR SHARE NOWAIT`
    );
  } catch (error) {
    if (databaseCode(error) === "55P03") {
      throw conflict(ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY);
    }
    throw error;
  }
}

async function validateAppendAuthorities(
  tx: Prisma.TransactionClient,
  command: NormalizedAppendCommand,
  authoritativeOrderId: string | null
) {
  const actor = await tx.user.findUnique({ where: { id: command.actorId } });
  const vehicle = await tx.vehicle.findUnique({ where: { id: command.vehicleId } });
  const order = command.orderId
    ? await tx.subscriptionOrder.findUnique({ where: { id: command.orderId } })
    : null;
  const contract = command.contractId
    ? await tx.contract.findUnique({ where: { id: command.contractId } })
    : null;
  const authoritativeOrder = authoritativeOrderId
    ? authoritativeOrderId === command.orderId
      ? order
      : await tx.subscriptionOrder.findUnique({ where: { id: authoritativeOrderId } })
    : null;
  const customer = command.customerId
    ? await tx.customer.findUnique({ where: { id: command.customerId } })
    : null;
  const owner = command.assetOwnerId
    ? await tx.assetOwner.findUnique({ where: { id: command.assetOwnerId } })
    : null;
  const workOrder = command.workOrderId
    ? await tx.assetWorkOrder.findUnique({ where: { id: command.workOrderId } })
    : null;
  const evidence = command.evidenceId
    ? await tx.assetWorkOrderEvidence.findUnique({
        include: { supersededBy: { select: { id: true } } },
        where: { id: command.evidenceId }
      })
    : null;

  requireAuthority(actor, isLiveUser(actor));
  requireAuthority(vehicle, hasNoDeletion(vehicle));
  if (command.orderId) requireAuthority(order, hasNoDeletion(order));
  if (command.contractId) requireAuthority(contract, hasNoDeletion(contract));
  if (contract) {
    if (contract.orderId !== authoritativeOrderId) {
      throw conflict(ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT);
    }
    if (command.orderId && contract.orderId !== command.orderId) {
      throw conflict(ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_MISMATCH);
    }
    requireAuthority(authoritativeOrder, hasNoDeletion(authoritativeOrder));
  }
  if (command.customerId) requireAuthority(customer, hasNoDeletion(customer));
  if (command.assetOwnerId) requireAuthority(owner, owner?.status === "ACTIVE");
  if (command.workOrderId) requireAuthority(workOrder, workOrder?.status !== "CANCELLED");
  if (command.evidenceId) requireAuthority(evidence, evidenceIsLive(evidence));

  if (
    (order && order.vehicleId !== command.vehicleId) ||
    (order && command.customerId && order.customerId !== command.customerId) ||
    (authoritativeOrder && authoritativeOrder.vehicleId !== command.vehicleId) ||
    (contract && command.customerId && contract.customerId !== command.customerId) ||
    (workOrder && workOrder.vehicleId !== command.vehicleId) ||
    (workOrder && command.orderId && workOrder.orderId !== command.orderId) ||
    (workOrder && command.contractId && workOrder.contractId !== command.contractId) ||
    (workOrder && command.customerId && workOrder.customerId !== command.customerId) ||
    (workOrder && command.assetOwnerId && workOrder.assetOwnerId !== command.assetOwnerId) ||
    (evidence && evidence.workOrderId !== command.workOrderId) ||
    (command.responsiblePartyType === "CUSTOMER" &&
      command.responsiblePartyId &&
      command.customerId &&
      command.responsiblePartyId !== command.customerId) ||
    (command.responsiblePartyType === "ASSET_OWNER" &&
      command.responsiblePartyId &&
      command.assetOwnerId &&
      command.responsiblePartyId !== command.assetOwnerId)
  ) {
    throw conflict(ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_MISMATCH);
  }

  if (
    command.responsiblePartyType === "CUSTOMER" &&
    command.responsiblePartyId &&
    !command.customerId
  ) {
    const responsibleCustomer = await tx.customer.findUnique({
      where: { id: command.responsiblePartyId }
    });
    requireAuthority(responsibleCustomer, hasNoDeletion(responsibleCustomer));
  }
  if (
    command.responsiblePartyType === "ASSET_OWNER" &&
    command.responsiblePartyId &&
    !command.assetOwnerId
  ) {
    const responsibleOwner = await tx.assetOwner.findUnique({
      where: { id: command.responsiblePartyId }
    });
    requireAuthority(responsibleOwner, responsibleOwner?.status === "ACTIVE");
  }
}

async function contractAuthoritativeOrderId(
  tx: Prisma.TransactionClient,
  contractId: string | null
) {
  if (!contractId) return null;
  const contract = await tx.contract.findUnique({
    select: { orderId: true },
    where: { id: contractId }
  });
  return contract?.orderId ?? null;
}

async function validateReverseActor(tx: Prisma.TransactionClient, actorId: string) {
  const actor = await tx.user.findUnique({ where: { id: actorId } });
  requireAuthority(actor, isLiveUser(actor));
}

function requireAuthority(value: unknown, live: boolean) {
  if (!value) throw conflict(ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND);
  if (!live) throw conflict(ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_LIVE);
}

function hasNoDeletion(value: { deletedAt?: Date | null } | null) {
  return value?.deletedAt === null;
}

function isLiveUser(value: { deletedAt?: Date | null; status?: string } | null) {
  return value?.deletedAt === null && value.status === "ACTIVE";
}

function evidenceIsLive(value: unknown) {
  if (!isRecord(value)) return false;
  if (value.action === "REMOVE") return false;
  if ("supersededBy" in value) return value.supersededBy === null;
  return value.supersededById === null || value.supersededById === undefined;
}

function projectEntry(entry: VehicleCostLedgerEntry): VehicleCostLedgerEntrySnapshot {
  return {
    actionType: entry.actionType,
    accountingPeriod: entry.accountingPeriod,
    amountCents: entry.amountCents,
    assetOwnerId: entry.assetOwnerId,
    assetOwnerSnapshot: jsonSnapshotValue(entry.assetOwnerSnapshot),
    confirmedAt: entry.confirmedAt,
    confirmedBy: entry.confirmedBy,
    contractId: entry.contractId,
    costCategory: entry.costCategory,
    customerId: entry.customerId,
    entryKind: entry.entryKind,
    evidenceId: entry.evidenceId,
    evidenceSnapshot: jsonSnapshotValue(entry.evidenceSnapshot),
    id: entry.id,
    occurredOn: entry.occurredOn,
    orderId: entry.orderId,
    responsiblePartyId: entry.responsiblePartyId,
    responsiblePartyType: entry.responsiblePartyType,
    responsibilitySnapshot: jsonSnapshotValue(entry.responsibilitySnapshot),
    reversalOfEntryId: entry.reversalOfEntryId,
    sourceId: entry.sourceId,
    sourceKey: entry.sourceKey,
    sourceType: entry.sourceType,
    vehicleId: entry.vehicleId,
    workOrderId: entry.workOrderId
  };
}

function publicOutcomeJson(outcome: VehicleCostLedgerEntrySnapshot): Prisma.JsonObject {
  return JSON.parse(canonicalAssetAccountingJson(outcome)) as Prisma.JsonObject;
}

function outcomeFromReceipt(value: Prisma.JsonValue): VehicleCostLedgerEntrySnapshot {
  if (!isRecord(value)) throw conflict(ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT);
  const amountCents = value.amountCents;
  const confirmedAt = value.confirmedAt;
  const occurredOn = value.occurredOn;
  if (
    typeof amountCents !== "string" ||
    typeof confirmedAt !== "string" ||
    typeof occurredOn !== "string"
  ) {
    throw conflict(ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT);
  }
  const confirmedDate = new Date(confirmedAt);
  const occurredDate = new Date(occurredOn);
  if (Number.isNaN(confirmedDate.getTime()) || Number.isNaN(occurredDate.getTime())) {
    throw conflict(ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT);
  }
  return {
    actionType: value.actionType as VehicleCostActionType,
    accountingPeriod: String(value.accountingPeriod),
    amountCents: BigInt(amountCents),
    assetOwnerId: nullableString(value.assetOwnerId),
    assetOwnerSnapshot: jsonSnapshotValue(value.assetOwnerSnapshot),
    confirmedAt: confirmedDate,
    confirmedBy: String(value.confirmedBy),
    contractId: nullableString(value.contractId),
    costCategory: value.costCategory as VehicleCostCategory,
    customerId: nullableString(value.customerId),
    entryKind: value.entryKind as VehicleCostLedgerEntrySnapshot["entryKind"],
    evidenceId: nullableString(value.evidenceId),
    evidenceSnapshot: jsonSnapshotValue(value.evidenceSnapshot),
    id: String(value.id),
    occurredOn: occurredDate,
    orderId: nullableString(value.orderId),
    responsiblePartyId: nullableString(value.responsiblePartyId),
    responsiblePartyType: value.responsiblePartyType as VehicleCostResponsiblePartyType,
    responsibilitySnapshot: jsonSnapshotValue(value.responsibilitySnapshot),
    reversalOfEntryId: nullableString(value.reversalOfEntryId),
    sourceId: String(value.sourceId),
    sourceKey: String(value.sourceKey),
    sourceType: String(value.sourceType),
    vehicleId: String(value.vehicleId),
    workOrderId: nullableString(value.workOrderId)
  };
}

function normalizeDatabaseError(error: unknown): unknown {
  const code = databaseCode(error);
  const constraint = code ? knownConstraint(error, code) : undefined;
  if (constraint) return conflict(CONSTRAINT_CODES[constraint]!);
  if (code === "23514") {
    const message = databaseMessage(error, code);
    if (message === "reversal amount must be the exact opposite of the original") {
      return conflict(ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_INVALID);
    }
    if (message === "reversal must preserve the original accounting and authority references") {
      return conflict(ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_INVALID);
    }
    if (message === "a reversal cannot target another reversal") {
      return conflict(ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_INVALID);
    }
  }
  if (code === "55P03") {
    return conflict(ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY);
  }
  if (prismaErrorCode(error) === "P2002") {
    const target = prismaUniqueTarget(error);
    if (isReversalUniqueTarget(target)) {
      return conflict(ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_ALREADY_EXISTS);
    }
    if (isSourceUniqueTarget(target)) {
      return conflict(ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT);
    }
    return conflict(ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT);
  }
  if (code === "23505") return conflict(ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT);
  return error;
}

function knownConstraint(error: unknown, code: string) {
  const candidate =
    exactConstraint(error) ?? constraintFromServerMessage(databaseMessage(error, code));
  return candidate && candidate in CONSTRAINT_CODES && constraintSupportsCode(candidate, code)
    ? candidate
    : undefined;
}

function databaseCode(error: unknown) {
  if (!isRecord(error)) return undefined;
  if (isSqlState(error.code)) return error.code;
  const cause = driverAdapterCause(error);
  return cause && isSqlState(cause.originalCode) ? cause.originalCode : undefined;
}

function prismaErrorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function driverAdapterCause(error: Record<string, unknown>) {
  if (error.code !== "P2010") return undefined;
  const meta = error.meta;
  if (!isRecord(meta)) return undefined;
  const adapterError = meta.driverAdapterError;
  if (!isRecord(adapterError) || !isRecord(adapterError.cause)) return undefined;
  return adapterError.cause;
}

function constraintSupportsCode(constraint: string, code: string) {
  if (constraint.endsWith("_fkey")) return code === "23503";
  if (constraint.endsWith("_key")) return code === "23505";
  if (constraint.endsWith("_chk")) return code === "23514";
  return false;
}

function isSqlState(value: unknown): value is string {
  return typeof value === "string" && ["23503", "23505", "23514", "55000", "55P03"].includes(value);
}

function exactConstraint(error: unknown) {
  if (!isRecord(error)) return undefined;
  if (typeof error.constraint === "string") return error.constraint;
  if (isRecord(error.meta) && typeof error.meta.constraint === "string") {
    return error.meta.constraint;
  }
  const cause = driverAdapterCause(error);
  return cause && typeof cause.constraint === "string" ? cause.constraint : undefined;
}

function databaseMessage(error: unknown, code: string) {
  if (!isRecord(error)) return undefined;
  if (error.code === code && typeof error.message === "string") return error.message;
  const cause = driverAdapterCause(error);
  if (!cause || cause.originalCode !== code) return undefined;
  if (typeof cause.originalMessage === "string") return cause.originalMessage;
  return typeof cause.message === "string" ? cause.message : undefined;
}

function constraintFromServerMessage(message: string | undefined) {
  if (!message) return undefined;
  for (const pattern of [
    /^duplicate key value violates unique constraint "([a-z0-9_]+)"$/,
    /^new row(?: for relation "[a-z0-9_]+")? violates check constraint "([a-z0-9_]+)"$/,
    /^insert or update on table "[a-z0-9_]+" violates foreign key constraint "([a-z0-9_]+)"$/
  ]) {
    const match = pattern.exec(message);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function prismaUniqueTarget(error: unknown): readonly string[] {
  if (!isRecord(error) || !isRecord(error.meta)) return [];
  const evidence: UniqueTargetKind[] = [];
  if (error.meta.target !== undefined) {
    const target = directStringTarget(error.meta.target);
    const targetKind = target ? uniqueTargetKind(target) : undefined;
    if (!targetKind) return [];
    evidence.push(targetKind);
  }
  if (error.meta.driverAdapterError !== undefined) {
    const adapterEvidence = p2002AdapterEvidence(error);
    if (!adapterEvidence) return [];
    evidence.push(...adapterEvidence);
  }
  const kind = consistentUniqueTargetKind(evidence);
  if (kind === "reversal") return ["vehicle_cost_ledger_entry_reversal_of_entry_id_key"];
  return kind === "source" ? ["asset_accounting_command_receipt_source_key"] : [];
}

function p2002AdapterCause(error: Record<string, unknown>) {
  if (error.code !== "P2002" || !isRecord(error.meta)) return undefined;
  const adapterError = error.meta.driverAdapterError;
  if (!isRecord(adapterError) || !isRecord(adapterError.cause)) return undefined;
  const cause = adapterError.cause;
  return cause.originalCode === "23505" && cause.kind === "UniqueConstraintViolation"
    ? cause
    : undefined;
}

function p2002AdapterEvidence(error: Record<string, unknown>) {
  const cause = p2002AdapterCause(error);
  if (!cause) return undefined;
  const evidence: UniqueTargetKind[] = [];
  if (cause.constraint !== undefined) {
    const target = adapterConstraintTarget(cause.constraint);
    const constraintKind = target ? uniqueTargetKind(target) : undefined;
    if (!constraintKind) return undefined;
    evidence.push(constraintKind);
  }
  for (const candidate of [cause.originalMessage, cause.message]) {
    if (candidate === undefined) continue;
    if (typeof candidate !== "string") return undefined;
    const constraint = constraintFromServerMessage(candidate);
    if (!constraint) continue;
    const messageKind = uniqueTargetKind([constraint]);
    if (!messageKind) return undefined;
    evidence.push(messageKind);
  }
  return consistentUniqueTargetKind(evidence) ? evidence : undefined;
}

function directStringTarget(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((candidate) => typeof candidate === "string")
    ? value
    : undefined;
}

function adapterConstraintTarget(value: unknown) {
  if (typeof value === "string") return [value];
  return isRecord(value) ? directStringTarget(value.fields) : undefined;
}

type UniqueTargetKind = "reversal" | "source";

function uniqueTargetKind(target: readonly string[]): UniqueTargetKind | undefined {
  if (isReversalUniqueTarget(target)) return "reversal";
  if (isSourceUniqueTarget(target)) return "source";
  return undefined;
}

function consistentUniqueTargetKind(evidence: readonly UniqueTargetKind[]) {
  const first = evidence[0];
  return first && evidence.every((kind) => kind === first) ? first : undefined;
}

function isReversalUniqueTarget(target: readonly string[]) {
  return (
    target.length === 1 &&
    [
      "reversalOfEntryId",
      "reversal_of_entry_id",
      "vehicle_cost_ledger_entry_reversal_of_entry_id_key"
    ].includes(target[0] ?? "")
  );
}

function isSourceUniqueTarget(target: readonly string[]) {
  if (target.length === 1 && target[0] === "asset_accounting_command_receipt_source_key") {
    return true;
  }
  const normalized = [...target].sort().join(":");
  return (
    normalized === ["sourceId", "sourceKey", "sourceType"].sort().join(":") ||
    normalized === ["source_id", "source_key", "source_type"].sort().join(":")
  );
}

function jsonNullable(
  value: Prisma.JsonValue | null
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function jsonObject(value: Prisma.JsonValue): Prisma.JsonObject {
  if (!isRecord(value)) throw conflict(ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT);
  return value as Prisma.JsonObject;
}

function jsonSnapshotValue(value: unknown): AssetAccountingSnapshotValue {
  return value as AssetAccountingSnapshotValue;
}

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function requireNonBlank(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw conflict(ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND);
  }
}

function assertValidDate(value: unknown): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw conflict(ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND);
  }
}

function conflict(code: AssetAccountingErrorCode) {
  return new ConflictException({ code, message: ERROR_MESSAGES[code] });
}

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
