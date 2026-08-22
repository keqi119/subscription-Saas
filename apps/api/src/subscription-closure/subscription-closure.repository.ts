import { ConflictException, Injectable } from "@nestjs/common";
import {
  Prisma,
  type SubscriptionClosureCommandType,
  type SubscriptionClosureDocumentStage,
  type SubscriptionClosureDocumentType,
  type SubscriptionClosureEventType,
  type SubscriptionClosureSettlementStage,
  type SubscriptionClosureSettlementType,
  type SubscriptionClosureStatus
} from "@prisma/client";

import {
  assertSubscriptionClosureEscalation,
  assertRecoveryPauseTransition,
  assertSubscriptionClosureTransition,
  canonicalSubscriptionClosureJson,
  canonicalSubscriptionClosureSource,
  freezeSubscriptionClosureOutcome,
  hashSubscriptionClosureSnapshot
} from "./subscription-closure.domain";
import type {
  SubscriptionClosureCaseSnapshot,
  SubscriptionClosureDocumentSnapshot,
  SubscriptionClosureEventSnapshot,
  SubscriptionClosureJsonObject,
  SubscriptionClosureProfile,
  SubscriptionClosureSettlementSnapshot,
  SubscriptionClosureSnapshotObject,
  SubscriptionClosureSource,
  SubscriptionClosureWriteOutcome
} from "./subscription-closure.types";

export interface CreateSubscriptionClosureCaseCommand extends SubscriptionClosureProfile {
  readonly actorId: string;
  readonly authoritySnapshot: SubscriptionClosureSnapshotObject;
  readonly contractId: string;
  readonly customerId: string;
  readonly effectiveAt: Date;
  readonly orderId: string;
  readonly reconditioningAssetWorkOrderId?: string | null;
  readonly recoveryAssetWorkOrderId?: string | null;
  readonly returnAssetWorkOrderId?: string | null;
  readonly returnHandoverWorkOrderId?: string | null;
  readonly source: SubscriptionClosureSource;
  readonly vehicleId: string;
  readonly vehicleReturnId?: string | null;
}

export interface SubscriptionClosureCaseFilters {
  readonly contractId?: string;
  readonly customerId?: string;
  readonly orderId?: string;
  readonly status?: SubscriptionClosureStatus;
  readonly vehicleId?: string;
}

export interface AppendSubscriptionClosureEventCommand {
  readonly actorId: string;
  readonly afterStatus: SubscriptionClosureStatus;
  readonly closureCaseId: string;
  readonly detailSnapshot: SubscriptionClosureSnapshotObject;
  readonly eventType: SubscriptionClosureEventType;
  readonly expectedStatus: SubscriptionClosureStatus;
  readonly expectedVersion: number;
  readonly occurredAt: Date;
  readonly reconditioningAssetWorkOrderId?: string | null;
  readonly recoveryAssetWorkOrderId?: string | null;
  readonly source: SubscriptionClosureSource;
}

export interface EscalateSubscriptionClosureRecoveryCommand {
  readonly actorId: string;
  readonly closureCaseId: string;
  readonly detailSnapshot: SubscriptionClosureSnapshotObject;
  readonly expectedStatus: SubscriptionClosureStatus;
  readonly expectedVersion: number;
  readonly occurredAt: Date;
  readonly source: SubscriptionClosureSource;
}

export interface AppendSubscriptionClosureDocumentCommand {
  readonly actorId: string;
  readonly archivedAt: Date | null;
  readonly archivedBy: string | null;
  readonly closureCaseId: string;
  readonly contractESignTaskId: string;
  readonly documentRevisionId?: string;
  readonly documentSnapshot: SubscriptionClosureSnapshotObject;
  readonly documentType: SubscriptionClosureDocumentType;
  readonly expectedCurrentRevisionId: string | null;
  readonly expectedVersion: number;
  readonly generatedAt: Date;
  readonly handoverWorkOrderId: string | null;
  readonly signedAt: Date | null;
  readonly signedBy: string | null;
  readonly signedFileHash: string | null;
  readonly signedFileId: string | null;
  readonly source: SubscriptionClosureSource;
  readonly sourceFileHash: string;
  readonly sourceFileId: string;
  readonly stage: SubscriptionClosureDocumentStage;
  readonly vehicleReturnId: string | null;
}

export interface AppendSubscriptionClosureSettlementCommand {
  readonly actorId: string;
  readonly amountDueCents: bigint;
  readonly amountRefundableCents: bigint;
  readonly billInputSnapshot: SubscriptionClosureSnapshotObject;
  readonly closureCaseId: string;
  readonly costTotalCents: bigint;
  readonly depositAppliedCents: bigint;
  readonly depositInputSnapshot: SubscriptionClosureSnapshotObject;
  readonly depositRefundCents: bigint;
  readonly expectedCurrentRevisionId: string | null;
  readonly expectedVersion: number;
  readonly finalizedAt: Date | null;
  readonly finalizedBy: string | null;
  readonly ledgerInputSnapshot: SubscriptionClosureSnapshotObject;
  readonly managedOccurredAt?: Date;
  readonly paidTotalCents: bigint;
  readonly receivableTotalCents: bigint;
  readonly recordedAt?: Date;
  readonly responsibilitySnapshot: SubscriptionClosureSnapshotObject;
  readonly resultSnapshot: SubscriptionClosureSnapshotObject;
  readonly settledAt: Date | null;
  readonly settledBy: string | null;
  readonly settlementType: SubscriptionClosureSettlementType;
  readonly source: SubscriptionClosureSource;
  readonly stage: SubscriptionClosureSettlementStage;
  readonly waiverApprovalId: string | null;
  readonly waiverTotalCents: bigint;
  readonly writeOffApprovalId: string | null;
  readonly writeOffTotalCents: bigint;
}

export type SubscriptionClosureMutationAuditHook = (
  tx: Prisma.TransactionClient,
  mutation: Readonly<{
    action: SubscriptionClosureCommandType;
    closureCaseId: string;
    eventId: string;
    outcome: SubscriptionClosureJsonObject;
    source: SubscriptionClosureSource;
  }>
) => Promise<void>;

const CASE_INCLUDE = {
  currentDocuments: {
    include: { documentRevision: true },
    orderBy: { documentType: "asc" }
  },
  currentSettlementRevision: true
} satisfies Prisma.SubscriptionClosureCaseInclude;

type CaseRecord = Prisma.SubscriptionClosureCaseGetPayload<{ include: typeof CASE_INCLUDE }>;

export const SUBSCRIPTION_CLOSURE_ERROR_CODE = {
  AUTHORITY_BUSY: "SUBSCRIPTION_CLOSURE_AUTHORITY_BUSY",
  AUTHORITY_MISMATCH: "SUBSCRIPTION_CLOSURE_AUTHORITY_MISMATCH",
  AUTHORITY_NOT_FOUND: "SUBSCRIPTION_CLOSURE_AUTHORITY_NOT_FOUND",
  CAPABILITY_INVALID: "SUBSCRIPTION_CLOSURE_CAPABILITY_INVALID",
  CASE_ALREADY_EXISTS: "SUBSCRIPTION_CLOSURE_CASE_ALREADY_EXISTS",
  CASE_NOT_FOUND: "SUBSCRIPTION_CLOSURE_CASE_NOT_FOUND",
  CURRENT_DOCUMENT_CONFLICT: "SUBSCRIPTION_CLOSURE_CURRENT_DOCUMENT_CONFLICT",
  CURRENT_SETTLEMENT_CONFLICT: "SUBSCRIPTION_CLOSURE_CURRENT_SETTLEMENT_CONFLICT",
  INVALID_COMMAND: "SUBSCRIPTION_CLOSURE_INVALID_COMMAND",
  SOURCE_CONFLICT: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT",
  STATUS_CONFLICT: "SUBSCRIPTION_CLOSURE_STATUS_CONFLICT",
  TRANSACTION_REQUIRED: "SUBSCRIPTION_CLOSURE_TRANSACTION_REQUIRED",
  VERSION_CONFLICT: "SUBSCRIPTION_CLOSURE_VERSION_CONFLICT",
  WRITE_CONFLICT: "SUBSCRIPTION_CLOSURE_WRITE_CONFLICT"
} as const;

type SubscriptionClosureErrorCode =
  (typeof SUBSCRIPTION_CLOSURE_ERROR_CODE)[keyof typeof SUBSCRIPTION_CLOSURE_ERROR_CODE];

const ERROR_MESSAGES: Readonly<Record<SubscriptionClosureErrorCode, string>> = {
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_BUSY]:
    "A subscription-closure authority row is being updated. Review the current state and retry.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH]:
    "The supplied subscription-closure authorities do not describe the same aggregate.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_NOT_FOUND]:
    "A supplied subscription-closure authority was not found.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID]:
    "The prepared subscription-closure capability is invalid.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.CASE_ALREADY_EXISTS]:
    "The order already has a subscription-closure case.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.CASE_NOT_FOUND]: "The subscription-closure case was not found.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.CURRENT_DOCUMENT_CONFLICT]:
    "The current subscription-closure document family has changed.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.CURRENT_SETTLEMENT_CONFLICT]:
    "The current subscription-closure settlement has changed.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND]: "The subscription-closure command is invalid.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT]:
    "The stable subscription-closure source is already bound to another command or payload.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT]:
    "The subscription-closure status does not allow this command.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.TRANSACTION_REQUIRED]:
    "Subscription-closure commands require a caller-provided PostgreSQL READ COMMITTED interactive transaction.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.VERSION_CONFLICT]:
    "The subscription-closure version has changed.",
  [SUBSCRIPTION_CLOSURE_ERROR_CODE.WRITE_CONFLICT]:
    "The subscription-closure command conflicts with the current database state."
};

export type SubscriptionClosureAuthorityTable =
  | "subscription_change_order"
  | "renewal_consideration"
  | "subscription_closure_case"
  | "subscription_order"
  | "vehicle"
  | "lease"
  | "contract"
  | "subscription_contract_segment"
  | "billing_schedule"
  | "order_entitlement_account"
  | "subscription_automation_job"
  | "vehicle_return"
  | "vehicle_return_damage"
  | "vehicle_subscription_period"
  | "vehicle_mileage_reading"
  | "collection_case"
  | "collection_action"
  | "business_exception_approval"
  | "vehicle_handover_work_order"
  | "asset_work_order"
  | "asset_owner"
  | "asset_work_order_evidence"
  | "subscription_closure_current_document"
  | "subscription_closure_document_revision"
  | "vehicle_operational_restriction"
  | "subscription_closure_settlement_revision"
  | "vehicle_cost_ledger_entry"
  | "receivable_bill"
  | "payment_record"
  | "payment_write_off"
  | "deposit_ledger"
  | "customer"
  | "file_object"
  | "contract_esign_task"
  | "user";

export type SubscriptionClosureAuthorityLock = Readonly<{
  table: SubscriptionClosureAuthorityTable;
  id: string;
  mode: "SHARE" | "UPDATE";
}>;

export type SubscriptionClosureAuthorityRequirement = Readonly<{
  command: SubscriptionClosureSnapshotObject;
  key: string;
  locks: readonly SubscriptionClosureAuthorityLock[];
}>;

declare const closureAuthoritySessionBrand: unique symbol;
export type SubscriptionClosureAuthoritySession = Readonly<{
  [closureAuthoritySessionBrand]: true;
}>;

declare const preparedClosureSourceCapabilityBrand: unique symbol;
export type PreparedClosureSourceCapability = Readonly<{
  [preparedClosureSourceCapabilityBrand]: true;
}>;

declare const closureAuthorityAttestationBrand: unique symbol;
export type ClosureAuthorityAttestation = Readonly<{
  [closureAuthorityAttestationBrand]: true;
}>;

type PreparedClosureSourceState = Readonly<{
  source: SubscriptionClosureSource;
  transaction: Prisma.TransactionClient;
}>;

type ClosureAuthorityAttestationState = Readonly<{
  commandFingerprint: string;
  consumer: object | null;
  issuer: SubscriptionClosureRepository;
  key: string;
  lockFingerprint: string;
  session: SubscriptionClosureAuthoritySession;
  transaction: Prisma.TransactionClient;
}>;

type ClosureAuthoritySessionState = Readonly<{
  issuer: SubscriptionClosureRepository;
  transaction: Prisma.TransactionClient;
}>;

const CLOSURE_AUTHORITY_ATTESTATIONS = new WeakMap<
  ClosureAuthorityAttestation,
  ClosureAuthorityAttestationState
>();
const CLOSURE_AUTHORITY_REQUIREMENT_CONSUMERS = new WeakMap<
  SubscriptionClosureAuthorityRequirement,
  object
>();
const CLOSURE_AUTHORITY_REQUIREMENT_SESSIONS = new WeakMap<
  SubscriptionClosureAuthorityRequirement,
  SubscriptionClosureAuthoritySession
>();
const CLOSURE_AUTHORITY_SESSIONS = new WeakMap<
  SubscriptionClosureAuthoritySession,
  ClosureAuthoritySessionState
>();
const CONSUMED_CLOSURE_AUTHORITY_SESSIONS = new WeakSet<SubscriptionClosureAuthoritySession>();

const PREPARED_EXECUTION = Symbol("subscription-closure-prepared-execution");

const AUTHORITY_TABLE_RANK: Readonly<Record<SubscriptionClosureAuthorityTable, number>> = {
  subscription_change_order: 1,
  renewal_consideration: 2,
  subscription_closure_case: 10,
  subscription_order: 20,
  vehicle: 30,
  lease: 40,
  contract: 50,
  subscription_contract_segment: 60,
  billing_schedule: 64,
  order_entitlement_account: 66,
  subscription_automation_job: 68,
  vehicle_return: 70,
  vehicle_return_damage: 75,
  vehicle_subscription_period: 80,
  vehicle_mileage_reading: 85,
  collection_case: 90,
  collection_action: 95,
  business_exception_approval: 100,
  vehicle_handover_work_order: 110,
  asset_work_order: 120,
  subscription_closure_current_document: 129,
  asset_owner: 140,
  asset_work_order_evidence: 145,
  subscription_closure_document_revision: 130,
  vehicle_operational_restriction: 150,
  subscription_closure_settlement_revision: 160,
  vehicle_cost_ledger_entry: 165,
  receivable_bill: 170,
  payment_record: 172,
  payment_write_off: 174,
  deposit_ledger: 176,
  customer: 180,
  file_object: 190,
  contract_esign_task: 200,
  user: 210
};

@Injectable()
export class SubscriptionClosureRepository {
  private readonly preparedSources = new WeakMap<
    PreparedClosureSourceCapability,
    PreparedClosureSourceState
  >();
  createAuthoritySessionInTransaction(
    tx: Prisma.TransactionClient
  ): SubscriptionClosureAuthoritySession {
    const session = Object.freeze({}) as SubscriptionClosureAuthoritySession;
    CLOSURE_AUTHORITY_SESSIONS.set(session, Object.freeze({ issuer: this, transaction: tx }));
    return session;
  }

  bindAuthorityRequirement(
    session: SubscriptionClosureAuthoritySession,
    requirement: SubscriptionClosureAuthorityRequirement
  ) {
    const state = CLOSURE_AUTHORITY_SESSIONS.get(session);
    if (!state || state.issuer !== this) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID);
    }
    return bindSubscriptionClosureAuthoritySession(requirement, session);
  }

  async prepareSourceInTransaction(
    tx: Prisma.TransactionClient,
    source: SubscriptionClosureSource
  ): Promise<PreparedClosureSourceCapability> {
    const normalized = canonicalSubscriptionClosureSource(source);
    await this.lockSourceOwnership(tx, normalized);
    const capability = Object.freeze({}) as PreparedClosureSourceCapability;
    this.preparedSources.set(capability, Object.freeze({ source: normalized, transaction: tx }));
    return capability;
  }

  async prepareAuthorityInTransaction(
    tx: Prisma.TransactionClient,
    session: SubscriptionClosureAuthoritySession,
    locks: readonly SubscriptionClosureAuthorityLock[],
    requirements: readonly SubscriptionClosureAuthorityRequirement[]
  ): Promise<ReadonlyMap<string, ClosureAuthorityAttestation>> {
    const sessionState = CLOSURE_AUTHORITY_SESSIONS.get(session);
    if (
      !sessionState ||
      sessionState.issuer !== this ||
      sessionState.transaction !== tx ||
      CONSUMED_CLOSURE_AUTHORITY_SESSIONS.has(session)
    ) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID);
    }
    CONSUMED_CLOSURE_AUTHORITY_SESSIONS.add(session);
    const normalizedLocks = normalizeAuthorityLocks(locks);
    const normalizedRequirements = requirements.map((requirement) =>
      normalizeAuthorityRequirement(requirement, session)
    );
    const normalizedKeys = normalizedRequirements.map(({ key }) => key);
    if (
      normalizedRequirements.length === 0 ||
      new Set(normalizedKeys).size !== normalizedKeys.length ||
      normalizedRequirements.some(({ locks: requiredLocks }) =>
        requiredLocks.some((required) => !authorityLockIsCovered(normalizedLocks, required))
      )
    ) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID);
    }
    const plannedDocumentAuthorities = new Set(
      normalizedRequirements
        .filter(
          ({ key }) =>
            key === "manifest-create" ||
            key.startsWith("recovery-authority-") ||
            key.startsWith("early-termination-agreement-")
        )
        .flatMap(({ locks: requiredLocks }) => requiredLocks)
        .filter(
          ({ table }) =>
            table === "file_object" ||
            table === "contract_esign_task" ||
            table === "subscription_closure_document_revision"
        )
        .map(({ id, table }) => `${table}\u0000${id}`)
    );
    const plannedWorkOrderAuthorities = new Set(
      normalizedRequirements.flatMap(({ key }, index) => {
        if (key !== "asset-create") return [];
        const workOrderId = requirements[index]?.command.workOrderId;
        return typeof workOrderId === "string"
          ? [`asset_work_order\u0000${canonicalUuid(workOrderId, "workOrderId")}`]
          : [];
      })
    );
    await this.lockCoordinatorAuthorityRows(
      tx,
      normalizedLocks,
      new Set([...plannedDocumentAuthorities, ...plannedWorkOrderAuthorities])
    );
    const result = new Map<string, ClosureAuthorityAttestation>();
    for (const requirement of normalizedRequirements) {
      const capability = Object.freeze({}) as ClosureAuthorityAttestation;
      CLOSURE_AUTHORITY_ATTESTATIONS.set(
        capability,
        Object.freeze({
          commandFingerprint: requirement.commandFingerprint,
          consumer: requirement.consumer,
          issuer: this,
          key: requirement.key,
          lockFingerprint: requirement.lockFingerprint,
          session,
          transaction: tx
        })
      );
      result.set(requirement.key, capability);
    }
    return result;
  }

  async consumeAuthorityAttestationInTransaction(
    tx: Prisma.TransactionClient,
    session: SubscriptionClosureAuthoritySession,
    capability: ClosureAuthorityAttestation,
    requirement: SubscriptionClosureAuthorityRequirement
  ): Promise<void> {
    consumeSubscriptionClosureAuthorityAttestation(
      tx,
      session,
      capability,
      () => this.bindAuthorityRequirement(session, requirement),
      this
    );
  }

  async createPreparedCaseInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    input: CreateSubscriptionClosureCaseCommand,
    sourceCapability: PreparedClosureSourceCapability,
    authorityAttestation: ClosureAuthorityAttestation,
    caseId: string,
    audit?: SubscriptionClosureMutationAuditHook
  ) {
    await this.consumeAuthorityAttestationInTransaction(
      tx,
      authoritySession,
      authorityAttestation,
      subscriptionClosureCaseAuthorityRequirement(input, caseId)
    );
    this.consumePreparedSource(tx, sourceCapability, input.source);
    return this.createCase(tx, input, audit, PREPARED_EXECUTION, caseId);
  }

  async createCase(
    tx: Prisma.TransactionClient,
    input: CreateSubscriptionClosureCaseCommand,
    audit?: SubscriptionClosureMutationAuditHook,
    execution?: typeof PREPARED_EXECUTION,
    caseId?: string
  ): Promise<SubscriptionClosureWriteOutcome<SubscriptionClosureCaseSnapshot>> {
    const command = normalizeCreateCaseCommand(input);
    const prepared = prepareCommand(command);
    if (execution !== PREPARED_EXECUTION) await this.lockSourceOwnership(tx, command.source);
    const replay = await replayReceipt<SubscriptionClosureCaseSnapshot>(
      tx,
      command.source,
      "CREATE_CASE",
      prepared
    );
    if (replay) return replay;

    if (execution !== PREPARED_EXECUTION) {
      await this.lockAuthorityRows(tx, createCaseAuthorityLocks(command));
    }
    const order = await tx.subscriptionOrder.findUnique({
      select: { contractId: true, customerId: true, vehicleId: true },
      where: { id: command.orderId }
    });
    if (!order) throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_NOT_FOUND);
    if (
      order.contractId !== command.contractId ||
      order.customerId !== command.customerId ||
      order.vehicleId !== command.vehicleId
    ) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
    }
    await assertCreateLinkCoherence(tx, command);
    if (await tx.subscriptionClosureCase.findUnique({ where: { orderId: command.orderId } })) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CASE_ALREADY_EXISTS);
    }

    try {
      const status = initialStatus(command);
      const authoritySnapshot = jsonInput(command.authoritySnapshot);
      const created = await tx.subscriptionClosureCase.create({
        data: {
          ...(caseId ? { id: caseId } : {}),
          authoritySnapshot,
          authoritySnapshotHash: hashSubscriptionClosureSnapshot(command.authoritySnapshot),
          caseNo: subscriptionClosureCaseNo(command.source),
          closureType: command.closureType,
          contractId: command.contractId,
          createSourceId: command.source.id,
          createSourceKey: command.source.key,
          createSourceType: command.source.type,
          createdBy: command.actorId,
          customerId: command.customerId,
          effectiveAt: command.effectiveAt,
          finalDisposition: command.finalDisposition,
          orderId: command.orderId,
          physicalControlMode: command.physicalControlMode,
          reconditioningAssetWorkOrderId: command.reconditioningAssetWorkOrderId,
          recoveryAssetWorkOrderId: command.recoveryAssetWorkOrderId,
          returnAssetWorkOrderId: command.returnAssetWorkOrderId,
          returnHandoverWorkOrderId: command.returnHandoverWorkOrderId,
          status,
          updatedBy: command.actorId,
          vehicleId: command.vehicleId,
          vehicleReturnId: command.vehicleReturnId
        },
        include: CASE_INCLUDE
      });
      const occurredAt = await databaseEventOccurrence(tx, created.id);
      const event = await createEvent(tx, {
        actorId: command.actorId,
        afterStatus: status,
        beforeStatus: null,
        closureCaseId: created.id,
        detailSnapshot: command.authoritySnapshot,
        eventType: "CASE_CREATED",
        occurredAt,
        sequence: 1,
        source: command.source
      });
      const outcome = projectCase(created);
      await runAudit(audit, tx, "CREATE_CASE", created.id, event.id, outcome, command.source);
      await createReceipt(tx, {
        actorId: command.actorId,
        closureCaseId: created.id,
        commandType: "CREATE_CASE",
        eventId: event.id,
        outcome,
        prepared,
        source: command.source
      });
      return { outcome, wrote: true };
    } catch (error) {
      throw normalizeWriteError(error);
    }
  }

  async getCase(
    tx: Prisma.TransactionClient,
    id: string
  ): Promise<SubscriptionClosureCaseSnapshot | null> {
    await assertTransactionContract(tx);
    const record = await tx.subscriptionClosureCase.findUnique({
      include: CASE_INCLUDE,
      where: { id: canonicalUuid(id, "closureCaseId") }
    });
    return record ? projectCase(record) : null;
  }

  async getCaseByOrder(
    tx: Prisma.TransactionClient,
    orderId: string
  ): Promise<SubscriptionClosureCaseSnapshot | null> {
    await assertTransactionContract(tx);
    const record = await tx.subscriptionClosureCase.findUnique({
      include: CASE_INCLUDE,
      where: { orderId: canonicalUuid(orderId, "orderId") }
    });
    return record ? projectCase(record) : null;
  }

  async listCases(
    tx: Prisma.TransactionClient,
    filters: SubscriptionClosureCaseFilters = {}
  ): Promise<SubscriptionClosureCaseSnapshot[]> {
    await assertTransactionContract(tx);
    const records = await tx.subscriptionClosureCase.findMany({
      include: CASE_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: {
        contractId: optionalUuid(filters.contractId, "filters.contractId"),
        customerId: optionalUuid(filters.customerId, "filters.customerId"),
        orderId: optionalUuid(filters.orderId, "filters.orderId"),
        status: filters.status,
        vehicleId: optionalUuid(filters.vehicleId, "filters.vehicleId")
      }
    });
    return records.map(projectCase);
  }

  async appendEvent(
    tx: Prisma.TransactionClient,
    input: AppendSubscriptionClosureEventCommand,
    audit?: SubscriptionClosureMutationAuditHook,
    execution?: typeof PREPARED_EXECUTION
  ): Promise<SubscriptionClosureWriteOutcome<SubscriptionClosureJsonObject>> {
    const command = normalizeEventCommand(input);
    const prepared = prepareCommand(command);
    if (execution !== PREPARED_EXECUTION) await this.lockSourceOwnership(tx, command.source);
    const replay = await replayReceipt<SubscriptionClosureJsonObject>(
      tx,
      command.source,
      "TRANSITION_CASE",
      prepared
    );
    if (replay) return replay;
    if (execution !== PREPARED_EXECUTION) {
      await this.lockAuthorityRows(tx, [
        { id: command.closureCaseId, mode: "UPDATE", table: "subscription_closure_case" },
        { id: command.actorId, mode: "SHARE", table: "user" }
      ]);
    }
    const current = await requiredCase(tx, command.closureCaseId);
    assertExpectedCase(current, command.expectedVersion, command.expectedStatus);
    await assertDatabaseEventTime(tx, current.id, command.occurredAt);
    await validateEventTransition(tx, current, command);
    await assertRecoveryWorkOrderLink(tx, current, command);
    assertTerminalSettlementAuthority(current, command.afterStatus);

    try {
      const changed = await tx.subscriptionClosureCase.update({
        data: {
          closedAt: terminalStatus(command.afterStatus) ? command.occurredAt : current.closedAt,
          physicalControlledAt:
            physicalControlledStatus(command.afterStatus) && current.physicalControlledAt === null
              ? command.occurredAt
              : current.physicalControlledAt,
          settledAt:
            command.afterStatus === "COMPLETED" || command.afterStatus === "TERMINATED"
              ? command.occurredAt
              : current.settledAt,
          ...(command.eventType === "INSPECTION_RECORDED"
            ? {
                reconditioningAssetWorkOrderId:
                  command.reconditioningAssetWorkOrderId ?? current.reconditioningAssetWorkOrderId
              }
            : {}),
          ...(command.recoveryAssetWorkOrderId
            ? { recoveryAssetWorkOrderId: command.recoveryAssetWorkOrderId }
            : {}),
          status: command.afterStatus,
          updatedBy: command.actorId,
          version: { increment: 1 }
        },
        include: CASE_INCLUDE,
        where: { id: current.id }
      });
      const event = await createEvent(tx, {
        ...command,
        beforeStatus: current.status,
        sequence: current.version + 2
      });
      const outcome = freezeSubscriptionClosureOutcome({
        case: projectCase(changed),
        event: projectEvent(event)
      });
      await runAudit(audit, tx, "TRANSITION_CASE", current.id, event.id, outcome, command.source);
      await createReceipt(tx, {
        actorId: command.actorId,
        closureCaseId: current.id,
        commandType: "TRANSITION_CASE",
        eventId: event.id,
        outcome,
        prepared,
        source: command.source
      });
      return { outcome, wrote: true };
    } catch (error) {
      throw normalizeWriteError(error);
    }
  }

  async appendPreparedEventInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    input: AppendSubscriptionClosureEventCommand,
    sourceCapability: PreparedClosureSourceCapability,
    authorityAttestation: ClosureAuthorityAttestation,
    audit?: SubscriptionClosureMutationAuditHook,
    authorityKey = "physical-receipt"
  ) {
    await this.consumeAuthorityAttestationInTransaction(
      tx,
      authoritySession,
      authorityAttestation,
      subscriptionClosureEventAuthorityRequirement(input, authorityKey)
    );
    this.consumePreparedSource(tx, sourceCapability, input.source);
    return this.appendEvent(tx, input, audit, PREPARED_EXECUTION);
  }

  async appendSourcePreparedEventInTransaction(
    tx: Prisma.TransactionClient,
    input: AppendSubscriptionClosureEventCommand,
    sourceCapability: PreparedClosureSourceCapability,
    audit?: SubscriptionClosureMutationAuditHook
  ) {
    this.consumePreparedSource(tx, sourceCapability, input.source);
    return this.appendEvent(tx, input, audit, PREPARED_EXECUTION);
  }

  async escalateRecovery(
    tx: Prisma.TransactionClient,
    input: EscalateSubscriptionClosureRecoveryCommand,
    audit?: SubscriptionClosureMutationAuditHook,
    execution?: typeof PREPARED_EXECUTION
  ): Promise<SubscriptionClosureWriteOutcome<SubscriptionClosureJsonObject>> {
    const command = normalizeEscalationCommand(input);
    const prepared = prepareCommand(command);
    if (execution !== PREPARED_EXECUTION) await this.lockSourceOwnership(tx, command.source);
    const replay = await replayReceipt<SubscriptionClosureJsonObject>(
      tx,
      command.source,
      "ESCALATE_RECOVERY",
      prepared
    );
    if (replay) return replay;
    if (execution !== PREPARED_EXECUTION) {
      await this.lockAuthorityRows(tx, [
        { id: command.closureCaseId, mode: "UPDATE", table: "subscription_closure_case" },
        { id: command.actorId, mode: "SHARE", table: "user" }
      ]);
    }
    const current = await requiredCase(tx, command.closureCaseId);
    assertExpectedCase(current, command.expectedVersion, command.expectedStatus);
    await assertDatabaseEventTime(tx, current.id, command.occurredAt);
    try {
      assertSubscriptionClosureEscalation(
        {
          ...profileOf(current),
          physicalControlledAt: current.physicalControlledAt,
          status: current.status
        },
        {
          closureType: current.closureType,
          finalDisposition: "TERMINATE",
          physicalControlMode: "RECOVERY"
        }
      );
    } catch {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT);
    }

    try {
      const changed = await tx.subscriptionClosureCase.update({
        data: {
          finalDisposition: "TERMINATE",
          physicalControlMode: "RECOVERY",
          status: "RECOVERY_ASSESSMENT_PENDING",
          updatedBy: command.actorId,
          version: { increment: 1 }
        },
        include: CASE_INCLUDE,
        where: { id: current.id }
      });
      const event = await createEvent(tx, {
        actorId: command.actorId,
        afterStatus: "RECOVERY_ASSESSMENT_PENDING",
        beforeStatus: current.status,
        closureCaseId: current.id,
        detailSnapshot: command.detailSnapshot,
        eventType: "RECOVERY_ESCALATED",
        occurredAt: command.occurredAt,
        sequence: current.version + 2,
        source: command.source
      });
      const outcome = freezeSubscriptionClosureOutcome({
        case: projectCase(changed),
        event: projectEvent(event)
      });
      await runAudit(audit, tx, "ESCALATE_RECOVERY", current.id, event.id, outcome, command.source);
      await createReceipt(tx, {
        actorId: command.actorId,
        closureCaseId: current.id,
        commandType: "ESCALATE_RECOVERY",
        eventId: event.id,
        outcome,
        prepared,
        source: command.source
      });
      return { outcome, wrote: true };
    } catch (error) {
      throw normalizeWriteError(error);
    }
  }

  async escalatePreparedRecoveryInTransaction(
    tx: Prisma.TransactionClient,
    input: EscalateSubscriptionClosureRecoveryCommand,
    sourceCapability: PreparedClosureSourceCapability,
    audit?: SubscriptionClosureMutationAuditHook
  ) {
    this.consumePreparedSource(tx, sourceCapability, input.source);
    return this.escalateRecovery(tx, input, audit, PREPARED_EXECUTION);
  }

  async appendPreparedDocumentRevisionInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    input: AppendSubscriptionClosureDocumentCommand,
    sourceCapability: PreparedClosureSourceCapability,
    authorityAttestation: ClosureAuthorityAttestation,
    audit?: SubscriptionClosureMutationAuditHook,
    authorityKey = "manifest-create",
    extraAuthorityLocks: readonly SubscriptionClosureAuthorityLock[] = []
  ) {
    await this.consumeAuthorityAttestationInTransaction(
      tx,
      authoritySession,
      authorityAttestation,
      subscriptionClosureDocumentAuthorityRequirement(input, authorityKey, extraAuthorityLocks)
    );
    this.consumePreparedSource(tx, sourceCapability, input.source);
    return this.appendDocumentRevision(tx, input, audit, PREPARED_EXECUTION);
  }

  async appendDocumentRevision(
    tx: Prisma.TransactionClient,
    input: AppendSubscriptionClosureDocumentCommand,
    audit?: SubscriptionClosureMutationAuditHook,
    execution?: typeof PREPARED_EXECUTION
  ): Promise<SubscriptionClosureWriteOutcome<SubscriptionClosureDocumentSnapshot>> {
    const command = normalizeDocumentCommand(input);
    const prepared = prepareCommand(command);
    if (execution !== PREPARED_EXECUTION) await this.lockSourceOwnership(tx, command.source);
    await assertDocumentLifecycleAtDatabaseClock(tx, command);
    const replay = await replayReceipt<SubscriptionClosureDocumentSnapshot>(
      tx,
      command.source,
      "CREATE_DOCUMENT_REVISION",
      prepared
    );
    if (replay) return replay;

    if (execution !== PREPARED_EXECUTION) {
      await this.lockAuthorityRows(tx, [
        { id: command.closureCaseId, mode: "UPDATE", table: "subscription_closure_case" }
      ]);
    }
    const currentCase = await requiredCase(tx, command.closureCaseId);
    assertExpectedCase(currentCase, command.expectedVersion);
    const lowerDocumentLocks: SubscriptionClosureAuthorityLock[] = [];
    if (command.vehicleReturnId) {
      lowerDocumentLocks.push({
        id: command.vehicleReturnId,
        mode: "SHARE",
        table: "vehicle_return"
      });
    }
    if (command.handoverWorkOrderId) {
      lowerDocumentLocks.push({
        id: command.handoverWorkOrderId,
        mode: "SHARE",
        table: "vehicle_handover_work_order"
      });
    }
    if (execution !== PREPARED_EXECUTION) await this.lockAuthorityRows(tx, lowerDocumentLocks);
    const currentProjection =
      execution === PREPARED_EXECUTION
        ? await tx.subscriptionClosureCurrentDocument.findUnique({
            where: {
              closureCaseId_documentType: {
                closureCaseId: command.closureCaseId,
                documentType: command.documentType
              }
            }
          })
        : await lockCurrentDocumentProjection(tx, command.closureCaseId, command.documentType);
    if ((currentProjection?.documentRevisionId ?? null) !== command.expectedCurrentRevisionId) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CURRENT_DOCUMENT_CONFLICT);
    }
    if (currentProjection && execution !== PREPARED_EXECUTION) {
      await this.lockAuthorityRows(tx, [
        {
          id: currentProjection.documentRevisionId,
          mode: "SHARE",
          table: "subscription_closure_document_revision"
        }
      ]);
    }
    const higherDocumentLocks: SubscriptionClosureAuthorityLock[] = [
      { id: command.actorId, mode: "SHARE", table: "user" },
      { id: command.contractESignTaskId, mode: "SHARE", table: "contract_esign_task" },
      { id: command.sourceFileId, mode: "SHARE", table: "file_object" }
    ];
    if (command.signedFileId) {
      higherDocumentLocks.push({
        id: command.signedFileId,
        mode: "SHARE",
        table: "file_object"
      });
    }
    for (const actorId of [command.signedBy, command.archivedBy]) {
      if (actorId) higherDocumentLocks.push({ id: actorId, mode: "SHARE", table: "user" });
    }
    if (execution !== PREPARED_EXECUTION) {
      await this.lockAuthorityRows(tx, higherDocumentLocks);
    }
    await assertDocumentAuthorityCoherence(tx, currentCase, command);

    const predecessor = currentProjection
      ? await tx.subscriptionClosureDocumentRevision.findUnique({
          where: { id: currentProjection.documentRevisionId }
        })
      : null;
    if (currentProjection && (!predecessor || predecessor.documentType !== command.documentType)) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
    }

    try {
      const created = await tx.subscriptionClosureDocumentRevision.create({
        data: {
          archivedAt: command.archivedAt,
          archivedBy: command.archivedBy,
          closureCaseId: currentCase.id,
          contractESignTaskId: command.contractESignTaskId,
          documentSnapshot: jsonInput(command.documentSnapshot),
          documentSnapshotHash: hashSubscriptionClosureSnapshot(command.documentSnapshot),
          documentType: command.documentType,
          generatedAt: command.generatedAt,
          generatedBy: command.actorId,
          handoverWorkOrderId: command.handoverWorkOrderId,
          id: command.documentRevisionId,
          revisionNumber: (predecessor?.revisionNumber ?? 0) + 1,
          signedAt: command.signedAt,
          signedBy: command.signedBy,
          signedFileHash: command.signedFileHash,
          signedFileId: command.signedFileId,
          sourceFileHash: command.sourceFileHash,
          sourceFileId: command.sourceFileId,
          sourceId: command.source.id,
          sourceKey: command.source.key,
          sourceType: command.source.type,
          stage: command.stage,
          supersedesRevisionId: predecessor?.id ?? null,
          vehicleReturnId: command.vehicleReturnId
        }
      });
      await tx.subscriptionClosureCurrentDocument.upsert({
        create: {
          closureCaseId: currentCase.id,
          documentRevisionId: created.id,
          documentType: command.documentType,
          updatedBy: command.actorId
        },
        update: { documentRevisionId: created.id, updatedBy: command.actorId },
        where: {
          closureCaseId_documentType: {
            closureCaseId: currentCase.id,
            documentType: command.documentType
          }
        }
      });
      await tx.subscriptionClosureCase.update({
        data: { updatedBy: command.actorId, version: { increment: 1 } },
        where: { id: currentCase.id }
      });
      const occurredAt = await databaseEventOccurrence(tx, currentCase.id);
      const event = await createEvent(tx, {
        actorId: command.actorId,
        afterStatus: currentCase.status,
        beforeStatus: currentCase.status,
        closureCaseId: currentCase.id,
        detailSnapshot: {
          documentRevisionId: created.id,
          documentType: command.documentType,
          revisionNumber: created.revisionNumber
        },
        eventType: "DOCUMENT_REVISION_CREATED",
        occurredAt,
        sequence: currentCase.version + 2,
        source: command.source
      });
      const outcome = projectDocument(created);
      await runAudit(
        audit,
        tx,
        "CREATE_DOCUMENT_REVISION",
        currentCase.id,
        event.id,
        outcome,
        command.source
      );
      await createReceipt(tx, {
        actorId: command.actorId,
        closureCaseId: currentCase.id,
        commandType: "CREATE_DOCUMENT_REVISION",
        eventId: event.id,
        outcome,
        prepared,
        source: command.source
      });
      return { outcome, wrote: true };
    } catch (error) {
      throw normalizeWriteError(error);
    }
  }

  async appendSettlementRevision(
    tx: Prisma.TransactionClient,
    input: AppendSubscriptionClosureSettlementCommand,
    audit?: SubscriptionClosureMutationAuditHook,
    execution?: typeof PREPARED_EXECUTION
  ): Promise<SubscriptionClosureWriteOutcome<SubscriptionClosureSettlementSnapshot>> {
    const command = normalizeSettlementCommand(input);
    const repositoryClock = await assertSettlementLifecycleAtDatabaseClock(tx, command);
    const prepared = prepareCommand(command);
    if (execution !== PREPARED_EXECUTION) await this.lockSourceOwnership(tx, command.source);
    const replay = await replayReceipt<SubscriptionClosureSettlementSnapshot>(
      tx,
      command.source,
      "CREATE_SETTLEMENT_REVISION",
      prepared
    );
    if (replay) return replay;
    if (execution !== PREPARED_EXECUTION) {
      await this.lockAuthorityRows(tx, [
        { id: command.closureCaseId, mode: "UPDATE", table: "subscription_closure_case" }
      ]);
    }
    const currentCase = await requiredCase(tx, command.closureCaseId);
    assertExpectedCase(currentCase, command.expectedVersion);
    if (currentCase.currentSettlementRevisionId !== command.expectedCurrentRevisionId) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CURRENT_SETTLEMENT_CONFLICT);
    }
    const authorityLocks: SubscriptionClosureAuthorityLock[] = [
      { id: command.actorId, mode: "SHARE", table: "user" }
    ];
    if (currentCase.currentSettlementRevisionId) {
      authorityLocks.push({
        id: currentCase.currentSettlementRevisionId,
        mode: "SHARE",
        table: "subscription_closure_settlement_revision"
      });
    }
    for (const approvalId of [command.waiverApprovalId, command.writeOffApprovalId]) {
      if (approvalId) {
        authorityLocks.push({
          id: approvalId,
          mode: "SHARE",
          table: "business_exception_approval"
        });
      }
    }
    for (const actorId of [command.finalizedBy, command.settledBy]) {
      if (actorId) authorityLocks.push({ id: actorId, mode: "SHARE", table: "user" });
    }
    if (execution !== PREPARED_EXECUTION) await this.lockAuthorityRows(tx, authorityLocks);
    const predecessor = currentCase.currentSettlementRevisionId
      ? await tx.subscriptionClosureSettlementRevision.findUnique({
          where: { id: currentCase.currentSettlementRevisionId }
        })
      : null;
    if (currentCase.currentSettlementRevisionId && !predecessor) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
    }
    assertSettlementPredecessorChronology(command, predecessor);
    try {
      const inputSnapshot = {
        bill: command.billInputSnapshot,
        deposit: command.depositInputSnapshot,
        ledger: command.ledgerInputSnapshot,
        responsibility: command.responsibilitySnapshot
      };
      const created = await tx.subscriptionClosureSettlementRevision.create({
        data: {
          amountDueCents: command.amountDueCents,
          amountRefundableCents: command.amountRefundableCents,
          billInputSnapshot: jsonInput(command.billInputSnapshot),
          closureCaseId: currentCase.id,
          costTotalCents: command.costTotalCents,
          createdBy: command.actorId,
          depositAppliedCents: command.depositAppliedCents,
          depositInputSnapshot: jsonInput(command.depositInputSnapshot),
          depositRefundCents: command.depositRefundCents,
          finalizedAt: command.finalizedAt,
          finalizedBy: command.finalizedBy,
          inputSnapshotHash: hashSubscriptionClosureSnapshot(inputSnapshot),
          ledgerInputSnapshot: jsonInput(command.ledgerInputSnapshot),
          paidTotalCents: command.paidTotalCents,
          createdAt: command.recordedAt ?? repositoryClock,
          receivableTotalCents: command.receivableTotalCents,
          responsibilitySnapshot: jsonInput(command.responsibilitySnapshot),
          resultHash: hashSubscriptionClosureSnapshot(command.resultSnapshot),
          resultSnapshot: jsonInput(command.resultSnapshot),
          revisionNumber: (predecessor?.revisionNumber ?? 0) + 1,
          settledAt: command.settledAt,
          settledBy: command.settledBy,
          settlementType: command.settlementType,
          sourceId: command.source.id,
          sourceKey: command.source.key,
          sourceType: command.source.type,
          stage: command.stage,
          supersedesRevisionId: predecessor?.id ?? null,
          waiverApprovalId: command.waiverApprovalId,
          waiverTotalCents: command.waiverTotalCents,
          writeOffApprovalId: command.writeOffApprovalId,
          writeOffTotalCents: command.writeOffTotalCents
        }
      });
      await tx.subscriptionClosureCase.update({
        data: {
          currentSettlementRevisionId: created.id,
          updatedBy: command.actorId,
          version: { increment: 1 }
        },
        where: { id: currentCase.id }
      });
      const event = await createEvent(tx, {
        actorId: command.actorId,
        afterStatus: currentCase.status,
        beforeStatus: currentCase.status,
        closureCaseId: currentCase.id,
        detailSnapshot: {
          revisionNumber: created.revisionNumber,
          settlementRevisionId: created.id,
          settlementType: created.settlementType,
          stage: created.stage
        },
        eventType: "SETTLEMENT_REVISION_CREATED",
        occurredAt: created.createdAt,
        sequence: currentCase.version + 2,
        source: command.source
      });
      const outcome = projectSettlement(created);
      await runAudit(
        audit,
        tx,
        "CREATE_SETTLEMENT_REVISION",
        currentCase.id,
        event.id,
        outcome,
        command.source
      );
      await createReceipt(tx, {
        actorId: command.actorId,
        closureCaseId: currentCase.id,
        commandType: "CREATE_SETTLEMENT_REVISION",
        eventId: event.id,
        outcome,
        prepared,
        source: command.source
      });
      return { outcome, wrote: true };
    } catch (error) {
      throw normalizeWriteError(error);
    }
  }

  async appendPreparedSettlementRevisionInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    input: AppendSubscriptionClosureSettlementCommand,
    sourceCapability: PreparedClosureSourceCapability,
    authorityAttestation: ClosureAuthorityAttestation,
    extraAuthorityLocks: readonly SubscriptionClosureAuthorityLock[],
    audit?: SubscriptionClosureMutationAuditHook,
    authorityKey = "settlement-revision"
  ) {
    await this.consumeAuthorityAttestationInTransaction(
      tx,
      authoritySession,
      authorityAttestation,
      subscriptionClosureSettlementAuthorityRequirement(input, extraAuthorityLocks, authorityKey)
    );
    this.consumePreparedSource(tx, sourceCapability, input.source);
    return this.appendSettlementRevision(tx, input, audit, PREPARED_EXECUTION);
  }

  async lockSourceOwnership(
    tx: Prisma.TransactionClient,
    source: SubscriptionClosureSource
  ): Promise<void> {
    const normalized = canonicalSubscriptionClosureSource(source);
    await assertTransactionContract(tx);
    const exactTuple = JSON.stringify([normalized.type, normalized.id, normalized.key]);
    await tx.$queryRaw(
      Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${exactTuple}, 0))`
    );
  }

  private consumePreparedSource(
    tx: Prisma.TransactionClient,
    capability: PreparedClosureSourceCapability,
    source: SubscriptionClosureSource
  ) {
    const state = this.preparedSources.get(capability);
    this.preparedSources.delete(capability);
    const normalized = canonicalSubscriptionClosureSource(source);
    if (
      !state ||
      state.transaction !== tx ||
      state.source.id !== normalized.id ||
      state.source.key !== normalized.key ||
      state.source.type !== normalized.type
    ) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID);
    }
  }

  async lockAuthorityRows(
    tx: Prisma.TransactionClient,
    locks: readonly SubscriptionClosureAuthorityLock[]
  ): Promise<void> {
    return this.lockCoordinatorAuthorityRows(tx, locks, new Set());
  }

  private async lockCoordinatorAuthorityRows(
    tx: Prisma.TransactionClient,
    locks: readonly SubscriptionClosureAuthorityLock[],
    plannedAuthorities: ReadonlySet<string>
  ): Promise<void> {
    await assertTransactionContract(tx);
    const normalized = normalizeAuthorityLocks(locks);
    if (normalized.length === 0) return;
    try {
      const rankedUnion = normalized.map((lock) => {
        const lockedRow =
          lock.table === "subscription_closure_current_document"
            ? lock.mode === "UPDATE"
              ? Prisma.sql`
                  SELECT "closure_case_id" AS "id"
                  FROM "subscription_closure_current_document"
                  WHERE "closure_case_id" = ${lock.id}::uuid
                  FOR UPDATE NOWAIT
                `
              : Prisma.sql`
                  SELECT "closure_case_id" AS "id"
                  FROM "subscription_closure_current_document"
                  WHERE "closure_case_id" = ${lock.id}::uuid
                  FOR SHARE NOWAIT
                `
            : lock.mode === "UPDATE"
              ? Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${lock.table}"`)} WHERE "id" = ${lock.id}::uuid FOR UPDATE NOWAIT`
              : Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${lock.table}"`)} WHERE "id" = ${lock.id}::uuid FOR SHARE NOWAIT`;
        return Prisma.sql`
          SELECT ${lock.table}::text AS "authorityTable",
                 ranked_authority."id"::text AS "requestedId"
          FROM (${lockedRow}) ranked_authority
        `;
      });
      const rows = await tx.$queryRaw<Array<{ authorityTable: string; requestedId: string }>>(
        Prisma.sql`${Prisma.join(rankedUnion, " UNION ALL ")}`
      );
      const locked = new Set(rows.map((row) => `${row.authorityTable}\u0000${row.requestedId}`));
      for (const lock of normalized) {
        const key = `${lock.table}\u0000${lock.id}`;
        if (!locked.has(key) && !plannedAuthorities.has(key)) {
          throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_NOT_FOUND);
        }
      }
    } catch (error) {
      if (databaseCode(error) === "55P03") {
        throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_BUSY);
      }
      throw error;
    }
  }
}

async function assertDocumentLifecycleAtDatabaseClock(
  tx: Prisma.TransactionClient,
  command: Pick<AppendSubscriptionClosureDocumentCommand, "archivedAt" | "generatedAt" | "signedAt">
) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "now"
  `);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
  }
  for (const lifecycleAt of [command.generatedAt, command.signedAt, command.archivedAt]) {
    if (lifecycleAt && lifecycleAt.getTime() > now.getTime()) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
    }
  }
}

type PreparedCommand = Readonly<{
  payloadHash: string;
  payloadSnapshot: SubscriptionClosureJsonObject;
}>;

function normalizeAttestationKey(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID);
  }
  return normalized;
}

export function consumeSubscriptionClosureAuthorityAttestation(
  tx: Prisma.TransactionClient,
  session: SubscriptionClosureAuthoritySession,
  capability: ClosureAuthorityAttestation,
  requirementFactory: () => SubscriptionClosureAuthorityRequirement,
  issuer: SubscriptionClosureRepository | null
): void {
  const state = CLOSURE_AUTHORITY_ATTESTATIONS.get(capability);
  CLOSURE_AUTHORITY_ATTESTATIONS.delete(capability);
  const sessionState = CLOSURE_AUTHORITY_SESSIONS.get(session);
  if (
    !state ||
    !sessionState ||
    state.transaction !== tx ||
    sessionState.transaction !== tx ||
    state.session !== session ||
    state.issuer !== sessionState.issuer ||
    (issuer && state.issuer !== issuer)
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID);
  }
  const requirement = normalizeAuthorityRequirement(requirementFactory(), session);
  if (
    state.key !== requirement.key ||
    state.consumer !== requirement.consumer ||
    state.commandFingerprint !== requirement.commandFingerprint ||
    state.lockFingerprint !== requirement.lockFingerprint
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID);
  }
}

function normalizeAuthorityRequirement(
  requirement: SubscriptionClosureAuthorityRequirement,
  session: SubscriptionClosureAuthoritySession
) {
  const key = normalizeAttestationKey(requirement.key);
  const locks = normalizeAuthorityLocks(requirement.locks);
  if (locks.length === 0 || CLOSURE_AUTHORITY_REQUIREMENT_SESSIONS.get(requirement) !== session) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID);
  }
  return Object.freeze({
    commandFingerprint: canonicalSubscriptionClosureJson(requirement.command),
    consumer: CLOSURE_AUTHORITY_REQUIREMENT_CONSUMERS.get(requirement) ?? null,
    key,
    lockFingerprint: authorityLockFingerprint(locks),
    locks
  });
}

export function bindSubscriptionClosureAuthorityConsumer(
  requirement: SubscriptionClosureAuthorityRequirement,
  consumer: object,
  session: SubscriptionClosureAuthoritySession
) {
  const bound = bindSubscriptionClosureAuthoritySession(requirement, session);
  CLOSURE_AUTHORITY_REQUIREMENT_CONSUMERS.set(bound, consumer);
  return bound;
}

export function bindSubscriptionClosureAuthoritySession(
  requirement: SubscriptionClosureAuthorityRequirement,
  session: SubscriptionClosureAuthoritySession
) {
  if (!CLOSURE_AUTHORITY_SESSIONS.has(session)) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID);
  }
  const bound = Object.freeze({ ...requirement });
  CLOSURE_AUTHORITY_REQUIREMENT_SESSIONS.set(bound, session);
  return bound;
}

function authorityLockFingerprint(locks: readonly SubscriptionClosureAuthorityLock[]) {
  return canonicalSubscriptionClosureJson({
    locks: locks.map(({ id, mode, table }) => ({ id, mode, table }))
  });
}

function authorityLockIsCovered(
  union: readonly SubscriptionClosureAuthorityLock[],
  required: SubscriptionClosureAuthorityLock
) {
  return union.some(
    (actual) =>
      actual.table === required.table &&
      actual.id === required.id &&
      (actual.mode === required.mode || (actual.mode === "UPDATE" && required.mode === "SHARE"))
  );
}

function normalizeCreateCaseCommand(
  input: CreateSubscriptionClosureCaseCommand
): CreateSubscriptionClosureCaseCommand {
  const command = {
    actorId: canonicalUuid(input.actorId, "actorId"),
    authoritySnapshot: canonicalSnapshot(input.authoritySnapshot, "authoritySnapshot"),
    closureType: enumValue(
      input.closureType,
      ["NORMAL_COMPLETION", "EARLY_TERMINATION"] as const,
      "closureType"
    ),
    contractId: canonicalUuid(input.contractId, "contractId"),
    customerId: canonicalUuid(input.customerId, "customerId"),
    effectiveAt: validDate(input.effectiveAt, "effectiveAt"),
    finalDisposition: enumValue(
      input.finalDisposition,
      ["COMPLETE", "TERMINATE"] as const,
      "finalDisposition"
    ),
    orderId: canonicalUuid(input.orderId, "orderId"),
    physicalControlMode: enumValue(
      input.physicalControlMode,
      ["VOLUNTARY_RETURN", "RECOVERY"] as const,
      "physicalControlMode"
    ),
    reconditioningAssetWorkOrderId: nullableUuid(
      input.reconditioningAssetWorkOrderId,
      "reconditioningAssetWorkOrderId"
    ),
    recoveryAssetWorkOrderId: nullableUuid(
      input.recoveryAssetWorkOrderId,
      "recoveryAssetWorkOrderId"
    ),
    returnAssetWorkOrderId: nullableUuid(input.returnAssetWorkOrderId, "returnAssetWorkOrderId"),
    returnHandoverWorkOrderId: nullableUuid(
      input.returnHandoverWorkOrderId,
      "returnHandoverWorkOrderId"
    ),
    source: canonicalSubscriptionClosureSource(input.source),
    vehicleId: canonicalUuid(input.vehicleId, "vehicleId"),
    vehicleReturnId: nullableUuid(input.vehicleReturnId, "vehicleReturnId")
  } satisfies CreateSubscriptionClosureCaseCommand;
  initialStatus(command);
  return command;
}

function normalizeEventCommand(
  input: AppendSubscriptionClosureEventCommand
): AppendSubscriptionClosureEventCommand {
  return {
    actorId: canonicalUuid(input.actorId, "actorId"),
    afterStatus: closureStatus(input.afterStatus),
    closureCaseId: canonicalUuid(input.closureCaseId, "closureCaseId"),
    detailSnapshot: canonicalSnapshot(input.detailSnapshot, "detailSnapshot"),
    eventType: enumValue(
      input.eventType,
      [
        "STATUS_TRANSITIONED",
        "PHYSICAL_CONTROL_CONFIRMED",
        "INSPECTION_RECORDED",
        "INVENTORY_RELEASED",
        "NOTE_ADDED"
      ] as const,
      "eventType"
    ),
    expectedStatus: closureStatus(input.expectedStatus),
    expectedVersion: version(input.expectedVersion),
    occurredAt: validDate(input.occurredAt, "occurredAt"),
    reconditioningAssetWorkOrderId: nullableUuid(
      input.reconditioningAssetWorkOrderId,
      "reconditioningAssetWorkOrderId"
    ),
    recoveryAssetWorkOrderId: nullableUuid(
      input.recoveryAssetWorkOrderId,
      "recoveryAssetWorkOrderId"
    ),
    source: canonicalSubscriptionClosureSource(input.source)
  };
}

function normalizeEscalationCommand(
  input: EscalateSubscriptionClosureRecoveryCommand
): EscalateSubscriptionClosureRecoveryCommand {
  return {
    actorId: canonicalUuid(input.actorId, "actorId"),
    closureCaseId: canonicalUuid(input.closureCaseId, "closureCaseId"),
    detailSnapshot: canonicalSnapshot(input.detailSnapshot, "detailSnapshot"),
    expectedStatus: closureStatus(input.expectedStatus),
    expectedVersion: version(input.expectedVersion),
    occurredAt: validDate(input.occurredAt, "occurredAt"),
    source: canonicalSubscriptionClosureSource(input.source)
  };
}

function normalizeDocumentCommand(
  input: AppendSubscriptionClosureDocumentCommand
): AppendSubscriptionClosureDocumentCommand {
  const command: AppendSubscriptionClosureDocumentCommand = {
    actorId: canonicalUuid(input.actorId, "actorId"),
    archivedAt: nullableDate(input.archivedAt, "archivedAt"),
    archivedBy: nullableUuid(input.archivedBy, "archivedBy"),
    closureCaseId: canonicalUuid(input.closureCaseId, "closureCaseId"),
    contractESignTaskId: canonicalUuid(input.contractESignTaskId, "contractESignTaskId"),
    ...(input.documentRevisionId
      ? { documentRevisionId: canonicalUuid(input.documentRevisionId, "documentRevisionId") }
      : {}),
    documentSnapshot: canonicalSnapshot(input.documentSnapshot, "documentSnapshot"),
    documentType: enumValue(
      input.documentType,
      ["RETURN_MANIFEST", "EARLY_TERMINATION_AGREEMENT", "RECOVERY_AUTHORITY"] as const,
      "documentType"
    ),
    expectedCurrentRevisionId: nullableUuid(
      input.expectedCurrentRevisionId,
      "expectedCurrentRevisionId"
    ),
    expectedVersion: version(input.expectedVersion),
    generatedAt: validDate(input.generatedAt, "generatedAt"),
    handoverWorkOrderId: nullableUuid(input.handoverWorkOrderId, "handoverWorkOrderId"),
    signedAt: nullableDate(input.signedAt, "signedAt"),
    signedBy: nullableUuid(input.signedBy, "signedBy"),
    signedFileHash: nullableHash(input.signedFileHash, "signedFileHash"),
    signedFileId: nullableUuid(input.signedFileId, "signedFileId"),
    source: canonicalSubscriptionClosureSource(input.source),
    sourceFileHash: hash(input.sourceFileHash, "sourceFileHash"),
    sourceFileId: canonicalUuid(input.sourceFileId, "sourceFileId"),
    stage: enumValue(input.stage, ["GENERATED", "SIGNED", "ARCHIVED"] as const, "stage"),
    vehicleReturnId: nullableUuid(input.vehicleReturnId, "vehicleReturnId")
  };
  assertDocumentShape(command);
  return command;
}

function normalizeSettlementCommand(
  input: AppendSubscriptionClosureSettlementCommand
): AppendSubscriptionClosureSettlementCommand {
  const command: AppendSubscriptionClosureSettlementCommand = {
    actorId: canonicalUuid(input.actorId, "actorId"),
    amountDueCents: nonnegativeBigInt(input.amountDueCents, "amountDueCents"),
    amountRefundableCents: nonnegativeBigInt(input.amountRefundableCents, "amountRefundableCents"),
    billInputSnapshot: canonicalSnapshot(input.billInputSnapshot, "billInputSnapshot"),
    closureCaseId: canonicalUuid(input.closureCaseId, "closureCaseId"),
    costTotalCents: nonnegativeBigInt(input.costTotalCents, "costTotalCents"),
    depositAppliedCents: nonnegativeBigInt(input.depositAppliedCents, "depositAppliedCents"),
    depositInputSnapshot: canonicalSnapshot(input.depositInputSnapshot, "depositInputSnapshot"),
    depositRefundCents: nonnegativeBigInt(input.depositRefundCents, "depositRefundCents"),
    expectedCurrentRevisionId: nullableUuid(
      input.expectedCurrentRevisionId,
      "expectedCurrentRevisionId"
    ),
    expectedVersion: version(input.expectedVersion),
    finalizedAt: nullableDate(input.finalizedAt, "finalizedAt"),
    finalizedBy: nullableUuid(input.finalizedBy, "finalizedBy"),
    ledgerInputSnapshot: canonicalSnapshot(input.ledgerInputSnapshot, "ledgerInputSnapshot"),
    managedOccurredAt:
      input.managedOccurredAt === undefined
        ? undefined
        : validDate(input.managedOccurredAt, "managedOccurredAt"),
    paidTotalCents: nonnegativeBigInt(input.paidTotalCents, "paidTotalCents"),
    receivableTotalCents: nonnegativeBigInt(input.receivableTotalCents, "receivableTotalCents"),
    recordedAt:
      input.recordedAt === undefined ? undefined : validDate(input.recordedAt, "recordedAt"),
    responsibilitySnapshot: canonicalSnapshot(
      input.responsibilitySnapshot,
      "responsibilitySnapshot"
    ),
    resultSnapshot: canonicalSnapshot(input.resultSnapshot, "resultSnapshot"),
    settledAt: nullableDate(input.settledAt, "settledAt"),
    settledBy: nullableUuid(input.settledBy, "settledBy"),
    settlementType: enumValue(
      input.settlementType,
      ["ESTIMATE", "FINAL"] as const,
      "settlementType"
    ),
    source: canonicalSubscriptionClosureSource(input.source),
    stage: enumValue(input.stage, ["PROPOSED", "FINALIZED", "SETTLED"] as const, "stage"),
    waiverApprovalId: nullableUuid(input.waiverApprovalId, "waiverApprovalId"),
    waiverTotalCents: nonnegativeBigInt(input.waiverTotalCents, "waiverTotalCents"),
    writeOffApprovalId: nullableUuid(input.writeOffApprovalId, "writeOffApprovalId"),
    writeOffTotalCents: nonnegativeBigInt(input.writeOffTotalCents, "writeOffTotalCents")
  };
  assertSettlementShape(command);
  return command;
}

function prepareCommand(command: object): PreparedCommand {
  const payloadSnapshot = JSON.parse(
    canonicalSubscriptionClosureJson(command)
  ) as SubscriptionClosureJsonObject;
  return {
    payloadHash: hashSubscriptionClosureSnapshot(command),
    payloadSnapshot
  };
}

export function subscriptionClosureCaseNo(source: SubscriptionClosureSource): string {
  return `SC-${hashSubscriptionClosureSnapshot(source).slice(0, 61)}`;
}

function initialStatus(command: SubscriptionClosureProfile): SubscriptionClosureStatus {
  if (
    command.closureType === "NORMAL_COMPLETION" &&
    command.physicalControlMode === "VOLUNTARY_RETURN" &&
    command.finalDisposition === "COMPLETE"
  ) {
    return "PREPARING_RETURN";
  }
  if (
    command.closureType === "EARLY_TERMINATION" &&
    command.physicalControlMode === "VOLUNTARY_RETURN" &&
    command.finalDisposition === "TERMINATE"
  ) {
    return "PREPARING_RETURN";
  }
  if (
    command.closureType === "EARLY_TERMINATION" &&
    command.physicalControlMode === "RECOVERY" &&
    command.finalDisposition === "TERMINATE"
  ) {
    return "RECOVERY_ASSESSMENT_PENDING";
  }
  throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
}

function assertDocumentShape(command: AppendSubscriptionClosureDocumentCommand): void {
  const signing = nullableGroup([
    command.signedFileId,
    command.signedFileHash,
    command.signedBy,
    command.signedAt
  ]);
  const archiving = nullableGroup([command.archivedBy, command.archivedAt]);
  if (
    signing === "PARTIAL" ||
    archiving === "PARTIAL" ||
    (command.signedAt !== null && command.signedAt.getTime() < command.generatedAt.getTime()) ||
    (command.archivedAt !== null &&
      command.signedAt !== null &&
      command.archivedAt.getTime() < command.signedAt.getTime()) ||
    (command.stage === "GENERATED" && (signing === "PRESENT" || archiving === "PRESENT")) ||
    (command.stage === "SIGNED" && (signing !== "PRESENT" || archiving === "PRESENT")) ||
    (command.stage === "ARCHIVED" && (signing !== "PRESENT" || archiving !== "PRESENT"))
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
  }
  const returnLinks = command.vehicleReturnId !== null && command.handoverWorkOrderId !== null;
  if (
    (command.documentType === "RETURN_MANIFEST" && !returnLinks) ||
    (command.documentType !== "RETURN_MANIFEST" &&
      (command.vehicleReturnId !== null || command.handoverWorkOrderId !== null))
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
  }
}

function assertSettlementShape(command: AppendSubscriptionClosureSettlementCommand): void {
  const finalization = nullableGroup([command.finalizedBy, command.finalizedAt]);
  const settlement = nullableGroup([command.settledBy, command.settledAt]);
  if (
    finalization === "PARTIAL" ||
    settlement === "PARTIAL" ||
    (command.stage === "PROPOSED" && (finalization === "PRESENT" || settlement === "PRESENT")) ||
    (command.stage === "FINALIZED" &&
      (command.settlementType !== "FINAL" ||
        finalization !== "PRESENT" ||
        settlement === "PRESENT")) ||
    (command.stage === "SETTLED" &&
      (command.settlementType !== "FINAL" ||
        finalization !== "PRESENT" ||
        settlement !== "PRESENT")) ||
    (command.waiverTotalCents === 0n) !== (command.waiverApprovalId === null) ||
    (command.writeOffTotalCents === 0n) !== (command.writeOffApprovalId === null) ||
    (command.managedOccurredAt === undefined) !== (command.recordedAt === undefined) ||
    (command.managedOccurredAt !== undefined &&
      command.recordedAt !== undefined &&
      command.managedOccurredAt.getTime() > command.recordedAt.getTime()) ||
    (command.recordedAt !== undefined &&
      [command.finalizedAt, command.settledAt].some(
        (value) => value !== null && value.getTime() > command.recordedAt!.getTime()
      )) ||
    (command.finalizedAt !== null &&
      command.settledAt !== null &&
      command.settledAt.getTime() < command.finalizedAt.getTime())
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
  }
}

async function assertSettlementLifecycleAtDatabaseClock(
  tx: Prisma.TransactionClient,
  command: AppendSubscriptionClosureSettlementCommand
) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "now"
  `);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
  }
  for (const lifecycleAt of [
    command.managedOccurredAt,
    command.recordedAt,
    command.finalizedAt,
    command.settledAt
  ]) {
    if (lifecycleAt && lifecycleAt.getTime() > now.getTime()) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
    }
  }
  return now;
}

function assertSettlementPredecessorChronology(
  command: AppendSubscriptionClosureSettlementCommand,
  predecessor: Readonly<{
    createdAt: Date;
    finalizedAt: Date | null;
    finalizedBy: string | null;
    id: string;
    stage: SubscriptionClosureSettlementStage;
  }> | null
) {
  if (command.stage === "PROPOSED") return;
  if (
    !predecessor ||
    (command.stage === "FINALIZED" &&
      (predecessor.stage !== "PROPOSED" ||
        command.finalizedAt!.getTime() < predecessor.createdAt.getTime())) ||
    (command.stage === "SETTLED" &&
      (predecessor.stage !== "FINALIZED" ||
        predecessor.finalizedAt === null ||
        predecessor.finalizedBy === null ||
        command.finalizedAt!.getTime() !== predecessor.finalizedAt.getTime() ||
        command.finalizedBy !== predecessor.finalizedBy ||
        command.settledAt!.getTime() < predecessor.finalizedAt.getTime()))
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
  }
}

function nullableGroup(values: readonly unknown[]): "ABSENT" | "PARTIAL" | "PRESENT" {
  const present = values.filter((value) => value !== null).length;
  if (present === 0) return "ABSENT";
  return present === values.length ? "PRESENT" : "PARTIAL";
}

const CLOSURE_STATUSES = [
  "PREPARING_RETURN",
  "RECOVERY_ASSESSMENT_PENDING",
  "RECOVERY_APPROVAL_PENDING",
  "RECOVERY_APPROVED",
  "RECOVERY_IN_PROGRESS",
  "VEHICLE_SECURED",
  "RETURN_INSPECTION",
  "RECONDITIONING",
  "PENDING_SETTLEMENT",
  "COMPLETED",
  "TERMINATED",
  "REJECTED",
  "PAUSED",
  "CANCELLED",
  "MANUAL_TAKEOVER"
] as const;

function closureStatus(value: unknown): SubscriptionClosureStatus {
  return enumValue(value, CLOSURE_STATUSES, "status");
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND, `${field} is invalid.`);
  }
  return value as T[number];
}

function canonicalSnapshot(value: unknown, field: string): SubscriptionClosureJsonObject {
  try {
    return JSON.parse(canonicalSubscriptionClosureJson(value)) as SubscriptionClosureJsonObject;
  } catch {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND, `${field} is invalid.`);
  }
}

function validDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND, `${field} is invalid.`);
  }
  return new Date(value.getTime());
}

function nullableDate(value: unknown, field: string): Date | null {
  return value === null || value === undefined ? null : validDate(value, field);
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : canonicalUuid(value, field);
}

function optionalUuid(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : canonicalUuid(value, field);
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND, "expectedVersion is invalid.");
  }
  return value;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/i;

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value.trim())) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND, `${field} is invalid.`);
  }
  return value.trim().toLowerCase();
}

function nullableHash(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : hash(value, field);
}

function nonnegativeBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND, `${field} is invalid.`);
  }
  return value;
}

function jsonInput(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(canonicalSubscriptionClosureJson(value)) as Prisma.InputJsonObject;
}

function projectCase(record: CaseRecord): SubscriptionClosureCaseSnapshot {
  const currentDocuments: Record<string, SubscriptionClosureDocumentSnapshot> = {};
  for (const current of record.currentDocuments) {
    currentDocuments[current.documentType] = projectDocument(current.documentRevision);
  }
  return freezeSubscriptionClosureOutcome({
    authoritySnapshot: record.authoritySnapshot,
    authoritySnapshotHash: record.authoritySnapshotHash,
    caseNo: record.caseNo,
    closedAt: iso(record.closedAt),
    closureType: record.closureType,
    contractId: record.contractId,
    createSource: {
      id: record.createSourceId,
      key: record.createSourceKey,
      type: record.createSourceType
    },
    createdAt: iso(record.createdAt),
    createdBy: record.createdBy,
    currentDocuments,
    currentSettlement: record.currentSettlementRevision
      ? projectSettlement(record.currentSettlementRevision)
      : null,
    currentSettlementRevisionId: record.currentSettlementRevisionId,
    customerId: record.customerId,
    effectiveAt: iso(record.effectiveAt),
    finalDisposition: record.finalDisposition,
    id: record.id,
    orderId: record.orderId,
    physicalControlledAt: iso(record.physicalControlledAt),
    physicalControlMode: record.physicalControlMode,
    reconditioningAssetWorkOrderId: record.reconditioningAssetWorkOrderId,
    recoveryAssetWorkOrderId: record.recoveryAssetWorkOrderId,
    returnAssetWorkOrderId: record.returnAssetWorkOrderId,
    returnHandoverWorkOrderId: record.returnHandoverWorkOrderId,
    settledAt: iso(record.settledAt),
    status: record.status,
    updatedAt: iso(record.updatedAt),
    updatedBy: record.updatedBy,
    vehicleId: record.vehicleId,
    vehicleReturnId: record.vehicleReturnId,
    version: record.version
  }) as unknown as SubscriptionClosureCaseSnapshot;
}

function projectDocument(
  record: Prisma.SubscriptionClosureDocumentRevisionGetPayload<Record<string, never>>
): SubscriptionClosureDocumentSnapshot {
  return freezeSubscriptionClosureOutcome({
    archivedAt: iso(record.archivedAt),
    archivedBy: record.archivedBy,
    closureCaseId: record.closureCaseId,
    contractESignTaskId: record.contractESignTaskId,
    createdAt: iso(record.createdAt),
    documentSnapshot: record.documentSnapshot,
    documentSnapshotHash: record.documentSnapshotHash,
    documentType: record.documentType,
    generatedAt: iso(record.generatedAt),
    generatedBy: record.generatedBy,
    handoverWorkOrderId: record.handoverWorkOrderId,
    id: record.id,
    revisionNumber: record.revisionNumber,
    signedAt: iso(record.signedAt),
    signedBy: record.signedBy,
    signedFileHash: record.signedFileHash,
    signedFileId: record.signedFileId,
    source: { id: record.sourceId, key: record.sourceKey, type: record.sourceType },
    sourceFileHash: record.sourceFileHash,
    sourceFileId: record.sourceFileId,
    stage: record.stage,
    supersedesRevisionId: record.supersedesRevisionId,
    vehicleReturnId: record.vehicleReturnId
  }) as unknown as SubscriptionClosureDocumentSnapshot;
}

function projectSettlement(
  record: Prisma.SubscriptionClosureSettlementRevisionGetPayload<Record<string, never>>
): SubscriptionClosureSettlementSnapshot {
  return freezeSubscriptionClosureOutcome({
    amountDueCents: record.amountDueCents,
    amountRefundableCents: record.amountRefundableCents,
    billInputSnapshot: record.billInputSnapshot,
    closureCaseId: record.closureCaseId,
    costTotalCents: record.costTotalCents,
    createdAt: iso(record.createdAt),
    createdBy: record.createdBy,
    depositAppliedCents: record.depositAppliedCents,
    depositInputSnapshot: record.depositInputSnapshot,
    depositRefundCents: record.depositRefundCents,
    finalizedAt: iso(record.finalizedAt),
    finalizedBy: record.finalizedBy,
    id: record.id,
    inputSnapshotHash: record.inputSnapshotHash,
    ledgerInputSnapshot: record.ledgerInputSnapshot,
    paidTotalCents: record.paidTotalCents,
    receivableTotalCents: record.receivableTotalCents,
    responsibilitySnapshot: record.responsibilitySnapshot,
    resultHash: record.resultHash,
    resultSnapshot: record.resultSnapshot,
    revisionNumber: record.revisionNumber,
    settledAt: iso(record.settledAt),
    settledBy: record.settledBy,
    settlementType: record.settlementType,
    source: { id: record.sourceId, key: record.sourceKey, type: record.sourceType },
    stage: record.stage,
    supersedesRevisionId: record.supersedesRevisionId,
    waiverApprovalId: record.waiverApprovalId,
    waiverTotalCents: record.waiverTotalCents,
    writeOffApprovalId: record.writeOffApprovalId,
    writeOffTotalCents: record.writeOffTotalCents
  }) as unknown as SubscriptionClosureSettlementSnapshot;
}

function projectEvent(
  record: Prisma.SubscriptionClosureEventGetPayload<Record<string, never>>
): SubscriptionClosureEventSnapshot {
  return freezeSubscriptionClosureOutcome({
    actorId: record.actorId,
    afterStatus: record.afterStatus,
    beforeStatus: record.beforeStatus,
    closureCaseId: record.closureCaseId,
    detailSnapshot: record.detailSnapshot,
    eventType: record.eventType,
    id: record.id,
    occurredAt: iso(record.occurredAt),
    recordedAt: iso(record.recordedAt),
    sequence: record.sequence,
    source: { id: record.sourceId, key: record.sourceKey, type: record.sourceType }
  }) as unknown as SubscriptionClosureEventSnapshot;
}

function iso(value: Date): string;
function iso(value: Date | null): string | null;
function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

async function replayReceipt<T extends object>(
  tx: Prisma.TransactionClient,
  source: SubscriptionClosureSource,
  commandType: SubscriptionClosureCommandType,
  prepared: PreparedCommand
): Promise<SubscriptionClosureWriteOutcome<T> | null> {
  const receipt = await tx.subscriptionClosureCommandReceipt.findUnique({
    where: {
      sourceType_sourceId_sourceKey: {
        sourceId: source.id,
        sourceKey: source.key,
        sourceType: source.type
      }
    }
  });
  if (!receipt) return null;
  let storedPayload: string;
  try {
    storedPayload = canonicalSubscriptionClosureJson(receipt.payloadSnapshot);
  } catch {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT);
  }
  if (
    receipt.commandType !== commandType ||
    receipt.payloadHash !== prepared.payloadHash ||
    storedPayload !== canonicalSubscriptionClosureJson(prepared.payloadSnapshot)
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT);
  }
  try {
    return {
      outcome: freezeSubscriptionClosureOutcome(receipt.outcomeSnapshot) as unknown as T,
      wrote: false
    };
  } catch {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT);
  }
}

async function createReceipt(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    actorId: string;
    closureCaseId: string;
    commandType: SubscriptionClosureCommandType;
    eventId: string;
    outcome: object;
    prepared: PreparedCommand;
    source: SubscriptionClosureSource;
  }>
): Promise<void> {
  await tx.subscriptionClosureCommandReceipt.create({
    data: {
      actorId: input.actorId,
      closureCaseId: input.closureCaseId,
      commandType: input.commandType,
      eventId: input.eventId,
      outcomeSnapshot: JSON.parse(
        canonicalSubscriptionClosureJson(input.outcome)
      ) as Prisma.InputJsonObject,
      payloadHash: input.prepared.payloadHash,
      payloadSnapshot: jsonInput(input.prepared.payloadSnapshot),
      sourceId: input.source.id,
      sourceKey: input.source.key,
      sourceType: input.source.type
    }
  });
}

async function createEvent(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    actorId: string;
    afterStatus: SubscriptionClosureStatus;
    beforeStatus: SubscriptionClosureStatus | null;
    closureCaseId: string;
    detailSnapshot: SubscriptionClosureSnapshotObject;
    eventType: SubscriptionClosureEventType;
    occurredAt: Date;
    sequence: number;
    source: SubscriptionClosureSource;
  }>
) {
  return tx.subscriptionClosureEvent.create({
    data: {
      actorId: input.actorId,
      afterStatus: input.afterStatus,
      beforeStatus: input.beforeStatus,
      closureCaseId: input.closureCaseId,
      detailSnapshot: jsonInput(canonicalSnapshot(input.detailSnapshot, "detailSnapshot")),
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      sequence: input.sequence,
      sourceId: input.source.id,
      sourceKey: input.source.key,
      sourceType: input.source.type
    }
  });
}

async function runAudit(
  audit: SubscriptionClosureMutationAuditHook | undefined,
  tx: Prisma.TransactionClient,
  action: SubscriptionClosureCommandType,
  closureCaseId: string,
  eventId: string,
  outcome: object,
  source: SubscriptionClosureSource
): Promise<void> {
  if (!audit) return;
  await audit(tx, {
    action,
    closureCaseId,
    eventId,
    outcome: freezeSubscriptionClosureOutcome(outcome),
    source
  });
}

function createCaseAuthorityLocks(
  command: CreateSubscriptionClosureCaseCommand
): SubscriptionClosureAuthorityLock[] {
  const locks: SubscriptionClosureAuthorityLock[] = [
    { id: command.orderId, mode: "UPDATE", table: "subscription_order" },
    { id: command.vehicleId, mode: "SHARE", table: "vehicle" },
    { id: command.contractId, mode: "SHARE", table: "contract" },
    { id: command.customerId, mode: "SHARE", table: "customer" },
    { id: command.actorId, mode: "SHARE", table: "user" }
  ];
  if (command.vehicleReturnId) {
    locks.push({ id: command.vehicleReturnId, mode: "SHARE", table: "vehicle_return" });
  }
  if (command.returnHandoverWorkOrderId) {
    locks.push({
      id: command.returnHandoverWorkOrderId,
      mode: "SHARE",
      table: "vehicle_handover_work_order"
    });
  }
  for (const id of [
    command.returnAssetWorkOrderId,
    command.recoveryAssetWorkOrderId,
    command.reconditioningAssetWorkOrderId
  ]) {
    if (id) locks.push({ id, mode: "SHARE", table: "asset_work_order" });
  }
  return locks;
}

export function subscriptionClosureCaseAuthorityRequirement(
  input: CreateSubscriptionClosureCaseCommand,
  caseId: string
): SubscriptionClosureAuthorityRequirement {
  const command = normalizeCreateCaseCommand(input);
  return {
    command: { ...command, caseId },
    key: "case-create",
    locks: [
      { id: command.orderId, mode: "UPDATE", table: "subscription_order" },
      { id: command.vehicleId, mode: "SHARE", table: "vehicle" },
      { id: command.contractId, mode: "SHARE", table: "contract" },
      { id: command.customerId, mode: "SHARE", table: "customer" },
      { id: command.actorId, mode: "SHARE", table: "user" }
    ]
  };
}

export function subscriptionClosureDocumentAuthorityRequirement(
  input: AppendSubscriptionClosureDocumentCommand,
  key = "manifest-create",
  extraLocks: readonly SubscriptionClosureAuthorityLock[] = []
): SubscriptionClosureAuthorityRequirement {
  const command = normalizeDocumentCommand(input);
  return {
    command: { ...command },
    key,
    locks: [
      ...extraLocks,
      { id: command.sourceFileId, mode: "SHARE", table: "file_object" },
      { id: command.contractESignTaskId, mode: "SHARE", table: "contract_esign_task" },
      ...(command.signedFileId
        ? [{ id: command.signedFileId, mode: "SHARE" as const, table: "file_object" as const }]
        : []),
      { id: command.actorId, mode: "SHARE", table: "user" }
    ]
  };
}

export function subscriptionClosureEventAuthorityRequirement(
  input: AppendSubscriptionClosureEventCommand,
  key = "physical-receipt"
): SubscriptionClosureAuthorityRequirement {
  const command = normalizeEventCommand(input);
  return {
    command: { ...command },
    key,
    locks: [
      {
        id: command.closureCaseId,
        mode: "UPDATE",
        table: "subscription_closure_case"
      },
      { id: command.actorId, mode: "SHARE", table: "user" }
    ]
  };
}

export function subscriptionClosureSettlementAuthorityRequirement(
  input: AppendSubscriptionClosureSettlementCommand,
  extraAuthorityLocks: readonly SubscriptionClosureAuthorityLock[],
  key = "settlement-revision"
): SubscriptionClosureAuthorityRequirement {
  const command = normalizeSettlementCommand(input);
  const locks: SubscriptionClosureAuthorityLock[] = [
    {
      id: command.closureCaseId,
      mode: "UPDATE",
      table: "subscription_closure_case"
    },
    ...extraAuthorityLocks,
    { id: command.actorId, mode: "SHARE", table: "user" }
  ];
  if (command.expectedCurrentRevisionId) {
    locks.push({
      id: command.expectedCurrentRevisionId,
      mode: "SHARE",
      table: "subscription_closure_settlement_revision"
    });
  }
  for (const approvalId of [command.waiverApprovalId, command.writeOffApprovalId]) {
    if (approvalId) {
      locks.push({
        id: approvalId,
        mode: "SHARE",
        table: "business_exception_approval"
      });
    }
  }
  for (const actorId of [command.finalizedBy, command.settledBy]) {
    if (actorId) locks.push({ id: actorId, mode: "SHARE", table: "user" });
  }
  return { command: { ...command }, key, locks };
}

async function assertCreateLinkCoherence(
  tx: Prisma.TransactionClient,
  command: CreateSubscriptionClosureCaseCommand
): Promise<void> {
  if (command.recoveryAssetWorkOrderId !== null && command.physicalControlMode !== "RECOVERY") {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
  }
  const contract = await tx.contract.findUnique({
    select: { customerId: true, orderId: true },
    where: { id: command.contractId }
  });
  if (
    !contract ||
    contract.orderId !== command.orderId ||
    contract.customerId !== command.customerId
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
  }
  if (command.vehicleReturnId) {
    const vehicleReturn = await tx.vehicleReturn.findUnique({
      select: { customerId: true, orderId: true, vehicleId: true },
      where: { id: command.vehicleReturnId }
    });
    if (
      !vehicleReturn ||
      vehicleReturn.orderId !== command.orderId ||
      vehicleReturn.vehicleId !== command.vehicleId ||
      vehicleReturn.customerId !== command.customerId
    ) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
    }
  }
  if (command.returnHandoverWorkOrderId) {
    const handover = await tx.vehicleHandoverWorkOrder.findUnique({
      select: { handoverType: true, orderId: true },
      where: { id: command.returnHandoverWorkOrderId }
    });
    if (
      !handover ||
      handover.orderId !== command.orderId ||
      handover.handoverType !== "RETURN_INBOUND"
    ) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
    }
  }
  for (const [id, expectedType] of [
    [command.returnAssetWorkOrderId, "RETURN_INBOUND"],
    [command.recoveryAssetWorkOrderId, "RECOVERY"],
    [command.reconditioningAssetWorkOrderId, "RECONDITIONING"]
  ] as const) {
    if (!id) continue;
    const workOrder = await tx.assetWorkOrder.findUnique({
      select: {
        contractId: true,
        customerId: true,
        orderId: true,
        vehicleId: true,
        workOrderType: true
      },
      where: { id }
    });
    if (
      !workOrder ||
      workOrder.orderId !== command.orderId ||
      workOrder.vehicleId !== command.vehicleId ||
      workOrder.contractId !== command.contractId ||
      workOrder.customerId !== command.customerId ||
      workOrder.workOrderType !== expectedType
    ) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
    }
  }
}

async function assertDocumentAuthorityCoherence(
  tx: Prisma.TransactionClient,
  closureCase: CaseRecord,
  command: AppendSubscriptionClosureDocumentCommand
): Promise<void> {
  const esign = await tx.contractESignTask.findUnique({
    select: {
      contractId: true,
      customerId: true,
      deletedAt: true,
      documentName: true,
      documentObjectKey: true,
      documentType: true,
      orderId: true,
      requestSnapshot: true,
      signingStage: true,
      sourceId: true,
      sourceKey: true,
      sourceType: true
    },
    where: { id: command.contractESignTaskId }
  });
  if (
    !esign ||
    esign.contractId !== closureCase.contractId ||
    esign.orderId !== closureCase.orderId ||
    esign.customerId !== closureCase.customerId
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
  }
  if (
    command.documentType === "RETURN_MANIFEST" &&
    (esign.deletedAt !== null ||
      !esign.documentName ||
      !esign.documentObjectKey ||
      esign.documentType !== "DELIVERY_HANDOVER" ||
      esign.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
      esign.sourceId !== command.source.id ||
      esign.sourceKey !== command.source.key ||
      esign.sourceType !== command.source.type ||
      canonicalSubscriptionClosureJson(esign.requestSnapshot) !==
        canonicalSubscriptionClosureJson({
          closureCaseId: command.closureCaseId,
          documentSnapshotHash: hashSubscriptionClosureSnapshot(command.documentSnapshot),
          documentType: "RETURN_MANIFEST",
          returnManifestSource: command.source,
          revisionNumber: 1
        }))
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
  }
  if (command.documentType === "RETURN_MANIFEST") {
    const file = await tx.fileObject.findUnique({
      select: {
        id: true,
        objectKey: true,
        originalName: true
      },
      where: { id: command.sourceFileId }
    });
    if (
      !file ||
      file.id !== command.sourceFileId ||
      esign.documentObjectKey !== file.objectKey ||
      esign.documentName !== file.originalName
    ) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
    }
  }
  if (command.vehicleReturnId !== null && command.vehicleReturnId !== closureCase.vehicleReturnId) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
  }
  if (
    command.handoverWorkOrderId !== null &&
    command.handoverWorkOrderId !== closureCase.returnHandoverWorkOrderId
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
  }
  if (
    command.documentType === "EARLY_TERMINATION_AGREEMENT" &&
    closureCase.closureType !== "EARLY_TERMINATION"
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
  }
  if (
    command.documentType === "RECOVERY_AUTHORITY" &&
    closureCase.physicalControlMode !== "RECOVERY"
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
  }
}

async function lockCurrentDocumentProjection(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  documentType: SubscriptionClosureDocumentType
): Promise<{ documentRevisionId: string } | null> {
  try {
    const [row] = await tx.$queryRaw<Array<{ documentRevisionId: string }>>(Prisma.sql`
      SELECT "document_revision_id" AS "documentRevisionId"
      FROM "subscription_closure_current_document"
      WHERE "closure_case_id" = ${closureCaseId}::uuid
        AND "document_type" = ${documentType}::"subscription_closure_document_type"
      FOR UPDATE NOWAIT
    `);
    return row ?? null;
  } catch (error) {
    if (databaseCode(error) === "55P03") {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_BUSY);
    }
    throw error;
  }
}

async function requiredCase(tx: Prisma.TransactionClient, id: string): Promise<CaseRecord> {
  const record = await tx.subscriptionClosureCase.findUnique({
    include: CASE_INCLUDE,
    where: { id }
  });
  if (!record) throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CASE_NOT_FOUND);
  return record;
}

async function assertDatabaseEventTime(
  tx: Prisma.TransactionClient,
  closureCaseId: string | null,
  occurredAt: Date
): Promise<void> {
  const boundary = await databaseEventBoundary(tx, closureCaseId);
  const reusesLatestHistoricalTime =
    boundary.latestOccurredAt !== null &&
    occurredAt.getTime() === boundary.latestOccurredAt.getTime();
  if (
    (occurredAt.getTime() > boundary.clockTimestamp.getTime() && !reusesLatestHistoricalTime) ||
    (boundary.latestOccurredAt !== null &&
      occurredAt.getTime() < boundary.latestOccurredAt.getTime())
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
  }
}

async function databaseEventOccurrence(
  tx: Prisma.TransactionClient,
  closureCaseId: string
): Promise<Date> {
  const boundary = await databaseEventBoundary(tx, closureCaseId);
  if (
    boundary.latestOccurredAt !== null &&
    boundary.clockTimestamp.getTime() < boundary.latestOccurredAt.getTime()
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
  }
  return boundary.clockTimestamp;
}

async function databaseEventBoundary(
  tx: Prisma.TransactionClient,
  closureCaseId: string | null
): Promise<{ clockTimestamp: Date; latestOccurredAt: Date | null }> {
  const [boundary] = await tx.$queryRaw<
    Array<{ clockTimestamp: Date; latestOccurredAt: Date | null }>
  >(Prisma.sql`
    SELECT clock_timestamp() AS "clockTimestamp",
           CASE WHEN ${closureCaseId}::uuid IS NULL THEN NULL ELSE (
             SELECT MAX("occurred_at")
             FROM "subscription_closure_event"
             WHERE "closure_case_id" = ${closureCaseId}::uuid
           ) END AS "latestOccurredAt"
  `);
  if (!boundary) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
  }
  return boundary;
}

function assertExpectedCase(
  current: CaseRecord,
  expectedVersion: number,
  expectedStatus?: SubscriptionClosureStatus
): void {
  if (current.version !== expectedVersion) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.VERSION_CONFLICT);
  }
  if (expectedStatus !== undefined && current.status !== expectedStatus) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT);
  }
}

function profileOf(record: CaseRecord): SubscriptionClosureProfile {
  return {
    closureType: record.closureType,
    finalDisposition: record.finalDisposition,
    physicalControlMode: record.physicalControlMode
  };
}

async function assertRecoveryWorkOrderLink(
  tx: Prisma.TransactionClient,
  current: CaseRecord,
  command: AppendSubscriptionClosureEventCommand
): Promise<void> {
  const workOrderId = command.recoveryAssetWorkOrderId;
  if (!workOrderId) return;
  if (
    command.afterStatus !== "RECOVERY_IN_PROGRESS" ||
    current.physicalControlMode !== "RECOVERY" ||
    (current.recoveryAssetWorkOrderId !== null && current.recoveryAssetWorkOrderId !== workOrderId)
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
  }
  const workOrder = await tx.assetWorkOrder.findUnique({ where: { id: workOrderId } });
  if (
    !workOrder ||
    workOrder.workOrderType !== "RECOVERY" ||
    workOrder.orderId !== current.orderId ||
    workOrder.vehicleId !== current.vehicleId ||
    workOrder.contractId !== current.contractId ||
    workOrder.customerId !== current.customerId
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
  }
}

async function validateEventTransition(
  tx: Prisma.TransactionClient,
  current: CaseRecord,
  command: AppendSubscriptionClosureEventCommand
): Promise<void> {
  if (
    command.eventType === "PHYSICAL_CONTROL_CONFIRMED" &&
    current.physicalControlMode === "RECOVERY" &&
    current.status === "RECOVERY_IN_PROGRESS" &&
    command.afterStatus === "RETURN_INSPECTION"
  ) {
    return;
  }
  if (command.eventType === "STATUS_TRANSITIONED" && command.afterStatus === "PAUSED") {
    const detail = command.detailSnapshot as Readonly<Record<string, unknown>>;
    if (detail.recoveryAction !== "PAUSE" || detail.pausedFromStatus !== current.status) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT);
    }
    try {
      assertRecoveryPauseTransition(profileOf(current), current.status, "PAUSED", null);
    } catch {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT);
    }
    return;
  }
  if (command.eventType === "STATUS_TRANSITIONED" && current.status === "PAUSED") {
    const pauseEvent = await tx.subscriptionClosureEvent.findFirst({
      orderBy: [{ sequence: "desc" }, { id: "desc" }],
      select: { detailSnapshot: true },
      where: { afterStatus: "PAUSED", closureCaseId: current.id }
    });
    const pauseDetail = pauseEvent?.detailSnapshot;
    const remembered =
      pauseDetail && !Array.isArray(pauseDetail) && typeof pauseDetail === "object"
        ? pauseDetail.pausedFromStatus
        : null;
    const detail = command.detailSnapshot as Readonly<Record<string, unknown>>;
    if (
      detail.recoveryAction !== "RESUME" ||
      detail.resumedStage !== remembered ||
      remembered !== command.afterStatus
    ) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT);
    }
    try {
      assertRecoveryPauseTransition(
        profileOf(current),
        "PAUSED",
        command.afterStatus,
        remembered as SubscriptionClosureStatus
      );
    } catch {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT);
    }
    return;
  }
  if (
    command.eventType === "STATUS_TRANSITIONED" ||
    command.eventType === "PHYSICAL_CONTROL_CONFIRMED" ||
    command.eventType === "INSPECTION_RECORDED"
  ) {
    try {
      assertSubscriptionClosureTransition(profileOf(current), current.status, command.afterStatus);
    } catch {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT);
    }
    return;
  }
  if (command.afterStatus !== current.status) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT);
  }
}

function terminalStatus(status: SubscriptionClosureStatus): boolean {
  return ["COMPLETED", "TERMINATED", "REJECTED", "CANCELLED"].includes(status);
}

function assertTerminalSettlementAuthority(
  current: CaseRecord,
  target: SubscriptionClosureStatus
): void {
  if (target !== "COMPLETED" && target !== "TERMINATED") return;
  if (
    current.currentSettlementRevision?.settlementType !== "FINAL" ||
    current.currentSettlementRevision.stage !== "SETTLED"
  ) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CURRENT_SETTLEMENT_CONFLICT);
  }
}

function physicalControlledStatus(status: SubscriptionClosureStatus): boolean {
  return [
    "VEHICLE_SECURED",
    "RETURN_INSPECTION",
    "RECONDITIONING",
    "PENDING_SETTLEMENT",
    "COMPLETED",
    "TERMINATED"
  ].includes(status);
}

async function assertTransactionContract(tx: Prisma.TransactionClient): Promise<void> {
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
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.TRANSACTION_REQUIRED);
  }
}

function normalizeAuthorityLocks(
  locks: readonly SubscriptionClosureAuthorityLock[]
): SubscriptionClosureAuthorityLock[] {
  const unique = new Map<string, SubscriptionClosureAuthorityLock>();
  for (const lock of locks) {
    if (!(lock.table in AUTHORITY_TABLE_RANK)) {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
    }
    const id = canonicalUuid(lock.id, "authority.id");
    if (lock.mode !== "SHARE" && lock.mode !== "UPDATE") {
      throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
    }
    const key = `${lock.table}:${id}`;
    const existing = unique.get(key);
    if (!existing || lock.mode === "UPDATE") unique.set(key, { ...lock, id });
  }
  return [...unique.values()].sort((left, right) => {
    const rank = AUTHORITY_TABLE_RANK[left.table] - AUTHORITY_TABLE_RANK[right.table];
    return rank === 0 ? compare(left.id, right.id) : rank;
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND, `${field} must be a UUID.`);
  }
  return value.trim().toLowerCase();
}

function normalizeWriteError(error: unknown): unknown {
  if (error instanceof ConflictException) return error;
  const code = databaseCode(error) ?? prismaErrorCode(error);
  const constraint = exactConstraint(error);
  const description = JSON.stringify(
    error,
    error instanceof Error ? Object.getOwnPropertyNames(error) : undefined
  );
  if (code === "55P03") return conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_BUSY);
  if (code === "P2002" || code === "23505") {
    if (constraint === "subscription_closure_case_order_id_key") {
      return conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CASE_ALREADY_EXISTS);
    }
    if (
      constraint?.includes("source") ||
      constraint?.includes("receipt") ||
      description.includes("source")
    ) {
      return conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT);
    }
    return conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.WRITE_CONFLICT);
  }
  if (code === "P2003" || code === "23503") {
    return conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_NOT_FOUND);
  }
  if (code === "P2014" || code === "23514") {
    if (
      constraint === "subscription_closure_case_authority_chk" ||
      constraint?.includes("document_authority")
    ) {
      return conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH);
    }
    if (constraint?.includes("current_document")) {
      return conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CURRENT_DOCUMENT_CONFLICT);
    }
    if (constraint?.includes("settlement_current") || constraint?.includes("terminal_settlement")) {
      return conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.CURRENT_SETTLEMENT_CONFLICT);
    }
    if (constraint?.includes("version")) {
      return conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.VERSION_CONFLICT);
    }
    if (
      constraint?.includes("shape") ||
      constraint?.includes("nonnegative") ||
      constraint?.includes("chronology")
    ) {
      return conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND);
    }
    return conflict(SUBSCRIPTION_CLOSURE_ERROR_CODE.WRITE_CONFLICT);
  }
  return error;
}

function databaseCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.code === "string" && /^[0-9]{2}[0-9A-Z]{3}$/.test(error.code)) {
    return error.code;
  }
  const cause = driverAdapterCause(error);
  return cause && typeof cause.originalCode === "string" ? cause.originalCode : undefined;
}

function prismaErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function driverAdapterCause(error: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(error.cause) && typeof error.cause.originalCode === "string") return error.cause;
  if (!isRecord(error.meta)) return undefined;
  const adapter = error.meta.driverAdapterError;
  return isRecord(adapter) && isRecord(adapter.cause) ? adapter.cause : undefined;
}

function exactConstraint(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.constraint === "string") return error.constraint;
  if (isRecord(error.meta) && typeof error.meta.constraint === "string") {
    return error.meta.constraint;
  }
  const cause = driverAdapterCause(error);
  return cause && typeof cause.constraint === "string" ? cause.constraint : undefined;
}

function conflict(code: SubscriptionClosureErrorCode, message = ERROR_MESSAGES[code]) {
  return new ConflictException({ code, message });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
