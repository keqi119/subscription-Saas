import { HttpStatus, Inject, Injectable, Optional } from "@nestjs/common";
import {
  AuditAction,
  BusinessType,
  ContractStatus,
  ESignTaskStatus,
  OrderStatus,
  Prisma,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  VehicleStatus
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { createHash } from "node:crypto";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo } from "../common/business-number";
import {
  isSubscriptionChangeTypeEnabled,
  SUBSCRIPTION_CHANGE_FLAG_NAMES,
  SUBSCRIPTION_CHANGE_CONFIG,
  SubscriptionChangeConfig
} from "./subscription-change.config";
import { projectSubscriptionChange } from "./subscription-change.domain";
import { SubscriptionChangeError } from "./subscription-change.errors";
import { SubscriptionChangeRepository } from "./subscription-change.repository";
import { SubscriptionEarlyTerminationChangeService } from "./subscription-early-termination-change.service";
import { normalizeManagedOtherRequest } from "./subscription-managed-other.service";
import {
  CreateSubscriptionChangeInput,
  CreateVehicleSwapChangeInput
} from "./subscription-change.types";
import { QuoteInput, SubscriptionExtensionService } from "./subscription-extension.service";
import { SubscriptionVehicleSwapService } from "./subscription-vehicle-swap.service";

const CREATE_OPERATION = "CREATE_SUBSCRIPTION_CHANGE";
const CANCEL_OPERATION = "CANCEL_SUBSCRIPTION_CHANGE";
const MANUAL_TAKEOVER_OPERATION = "MANUAL_TAKEOVER_SUBSCRIPTION_CHANGE";

const CANCELLABLE_STATUSES = new Set<SubscriptionChangeStatus>([
  SubscriptionChangeStatus.DRAFT,
  SubscriptionChangeStatus.QUOTED,
  SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
  SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
  SubscriptionChangeStatus.MANUAL_TAKEOVER
]);

interface CancelSubscriptionChangeInput {
  idempotencyKey?: string;
  reason: string;
  version: number;
}

@Injectable()
export class SubscriptionChangeService {
  constructor(
    private readonly repository: SubscriptionChangeRepository,
    private readonly auditService: AuditService,
    private readonly extensionService: SubscriptionExtensionService,
    @Inject(SUBSCRIPTION_CHANGE_CONFIG)
    private readonly config: SubscriptionChangeConfig,
    @Optional() private readonly vehicleSwapService?: SubscriptionVehicleSwapService,
    @Optional()
    private readonly earlyTerminationService?: SubscriptionEarlyTerminationChangeService
  ) {}

  async create(input: CreateSubscriptionChangeInput, actor: RequestUser, context: RequestContext) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_CREATE);
    assertIdempotencyKey(input.idempotencyKey);
    assertChangeTypeEnabled(this.config, input.changeType);

    if (input.changeType === SubscriptionChangeType.EXTENSION) {
      const change = await this.extensionService.createExtension(
        {
          ...input.detail,
          idempotencyKey: input.idempotencyKey,
          orderId: input.orderId
        },
        actor,
        context
      );
      return projectChange(change, actor, this.config);
    }

    validateCreateInput(input);
    const requestHash = commandHash(input);
    const replay = await this.replay(CREATE_OPERATION, input.idempotencyKey!, actor, requestHash);
    if (replay) return replay;

    try {
      const created = await this.repository.transaction(async (tx) => {
        await this.repository.lockCreationScope(tx, input.orderId);
        const order = await this.repository.findOrder(tx, input.orderId);
        assertActiveOrder(order);

        const command = await this.repository.createCommand(tx, {
          actorId: actor.id,
          idempotencyKey: input.idempotencyKey!,
          operation: CREATE_OPERATION,
          requestHash
        });

        const active = await this.repository.findActiveChange(tx, input.orderId);
        if (active) throw activeChangeExists();

        const detailData =
          input.changeType === SubscriptionChangeType.VEHICLE_SWAP
            ? await this.vehicleSwapDetail(tx, input, order.vehicleId!)
            : createDetailData(input, actor, this.config.now());
        const change = await this.repository.createChange(tx, {
          changeNo: createBusinessNo("SCO"),
          changeType: input.changeType,
          completionDeadlineAt: completionDeadline(input),
          createdBy: actor.id,
          order: { connect: { id: input.orderId } },
          status: SubscriptionChangeStatus.DRAFT,
          updatedBy: actor.id,
          ...detailData
        });
        await this.auditService.write(
          auditInput(AuditAction.CREATE, change.id, actor, context, undefined, change),
          tx
        );
        await this.repository.completeCommand(tx, command.id, change.id, this.config.now());
        return change;
      });
      return projectChange(created, actor, this.config);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const duplicate = await this.replay(
        CREATE_OPERATION,
        input.idempotencyKey!,
        actor,
        requestHash
      );
      if (duplicate) return duplicate;
      throw activeChangeExists();
    }
  }

  async get(id: string, actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_VIEW);
    const change = await this.repository.findChange(id);
    if (!change) throw changeNotFound();
    return projectChange(change, actor, this.config);
  }

  async listForOrder(orderId: string, actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_VIEW);
    const changes = await this.repository.listForOrder(orderId);
    return changes.map((change) => projectChange(change, actor, this.config));
  }

  capabilities(actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_VIEW);
    return {
      changeTypes: Object.fromEntries(
        Object.values(SubscriptionChangeType).map((changeType) => [
          changeType,
          changeTypeAvailability(this.config, changeType)
        ])
      )
    };
  }

  async timeline(id: string, actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_VIEW);
    const change = await this.repository.findChange(id);
    if (!change) throw changeNotFound();
    return this.repository.listTimeline([
      change.id,
      ...change.quotes.map((quote) => quote.id),
      ...change.automationJobs.map((job) => job.id)
    ]);
  }

  async previewQuote(id: string, input: QuoteInput, actor: RequestUser) {
    const changeType = await this.getChangeType(id);
    if (changeType === SubscriptionChangeType.EARLY_TERMINATION) {
      return this.requireEarlyTerminationService().previewEstimate(id, actor);
    }
    if (changeType === SubscriptionChangeType.VEHICLE_SWAP) {
      return this.requireVehicleSwapService().previewQuote(id, actor);
    }
    return this.extensionService.previewQuote(id, input, actor);
  }

  async createFormalQuote(
    id: string,
    input: QuoteInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    const changeType = await this.getChangeType(id);
    if (changeType === SubscriptionChangeType.EARLY_TERMINATION) {
      return this.requireEarlyTerminationService().createEstimate(
        id,
        { idempotencyKey: input.idempotencyKey, version: input.version! },
        actor,
        context
      );
    }
    if (changeType === SubscriptionChangeType.VEHICLE_SWAP) {
      return this.requireVehicleSwapService().createFormalQuote(
        id,
        { idempotencyKey: input.idempotencyKey, version: input.version! },
        actor,
        context
      );
    }
    return this.extensionService.createFormalQuote(id, input, actor, context);
  }

  async submitCustomerConfirmation(
    id: string,
    input: { idempotencyKey?: string; version: number },
    actor: RequestUser,
    context: RequestContext
  ) {
    const changeType = await this.getChangeType(id);
    if (changeType === SubscriptionChangeType.EARLY_TERMINATION) {
      return this.requireEarlyTerminationService().publishCustomerConfirmation(
        id,
        input,
        actor,
        context
      );
    }
    if (changeType === SubscriptionChangeType.VEHICLE_SWAP) {
      return this.requireVehicleSwapService().publishCustomerConfirmation(
        id,
        input,
        actor,
        context
      );
    }
    return this.extensionService.submitCustomerConfirmation(id, input, actor, context);
  }

  async cancel(
    id: string,
    input: CancelSubscriptionChangeInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_CANCEL);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    const reason = input.reason.trim();
    if (!reason) {
      throw new SubscriptionChangeError(
        "CANCEL_REASON_REQUIRED",
        "A cancellation reason is required."
      );
    }

    const current = await this.repository.findChange(id);
    if (!current) throw changeNotFound();
    assertChangeTypeEnabled(this.config, current.changeType);
    if (current.changeType === SubscriptionChangeType.EXTENSION) {
      const cancelled = await this.extensionService.cancel(id, input, actor, context);
      return projectChange(cancelled, actor, this.config);
    }
    if (current.changeType === SubscriptionChangeType.VEHICLE_SWAP) {
      const cancelled = await this.requireVehicleSwapService().cancel(id, input, actor, context);
      return projectChange(cancelled, actor, this.config);
    }
    if (current.changeType === SubscriptionChangeType.EARLY_TERMINATION) {
      const cancelled = await this.requireEarlyTerminationService().cancel(
        id,
        input,
        actor,
        context
      );
      return projectChange(cancelled, actor, this.config);
    }

    const requestHash = commandHash({ id, ...input });
    const replay = await this.replay(CANCEL_OPERATION, input.idempotencyKey!, actor, requestHash);
    if (replay) return replay;

    try {
      const cancelled = await this.repository.transaction(async (tx) => {
        await this.repository.lockChange(tx, id);
        const change = await this.repository.findChange(id, tx);
        if (!change) throw changeNotFound();
        if (change.version !== input.version) throw versionConflict();
        const scheduledManagedOther =
          change.changeType === SubscriptionChangeType.MANAGED_OTHER &&
          change.status === SubscriptionChangeStatus.SCHEDULED &&
          !change.contractId;
        if (!CANCELLABLE_STATUSES.has(change.status) && !scheduledManagedOther) {
          throw new SubscriptionChangeError(
            "SUBSCRIPTION_CHANGE_NOT_CANCELLABLE",
            "The change can no longer be cancelled directly.",
            HttpStatus.CONFLICT
          );
        }
        const command = await this.repository.createCommand(tx, {
          actorId: actor.id,
          idempotencyKey: input.idempotencyKey!,
          operation: CANCEL_OPERATION,
          requestHash
        });
        const archivedManagedOtherSupplement =
          change.changeType === SubscriptionChangeType.MANAGED_OTHER &&
          change.contractId &&
          change.contract?.status === ContractStatus.ARCHIVED;
        if (
          archivedManagedOtherSupplement &&
          change.status !== SubscriptionChangeStatus.MANUAL_TAKEOVER
        ) {
          throw new SubscriptionChangeError(
            "MANAGED_OTHER_ARCHIVED_SUPPLEMENT_REQUIRES_TAKEOVER",
            "An archived managed-other supplement can only be abandoned from governed manual takeover.",
            HttpStatus.CONFLICT
          );
        }
        if (
          change.changeType === SubscriptionChangeType.MANAGED_OTHER &&
          change.contractId &&
          !archivedManagedOtherSupplement
        ) {
          await tx.contractESignTask.updateMany({
            data: {
              cancelledAt: this.config.now(),
              taskStatus: ESignTaskStatus.CANCELLED,
              updatedBy: actor.id
            },
            where: {
              contractId: change.contractId,
              taskStatus: {
                in: [
                  ESignTaskStatus.CREATED,
                  ESignTaskStatus.WAITING_CUSTOMER,
                  ESignTaskStatus.SIGNING,
                  ESignTaskStatus.FAILED
                ]
              }
            }
          });
          const contractCancelled = await tx.contract.updateMany({
            data: { status: ContractStatus.CANCELLED, updatedBy: actor.id },
            where: { id: change.contractId, status: ContractStatus.GENERATED }
          });
          if (contractCancelled.count !== 1) {
            throw new SubscriptionChangeError(
              "MANAGED_OTHER_SUPPLEMENT_CANCEL_CONFLICT",
              "The managed-other supplement could not be cancelled before archival.",
              HttpStatus.CONFLICT
            );
          }
        }
        const updated = await this.repository.updateChange(tx, id, {
          cancelReason: reason,
          status: SubscriptionChangeStatus.CANCELLED,
          updatedBy: actor.id,
          version: { increment: 1 }
        });
        await this.auditService.write(
          auditInput(AuditAction.UPDATE, id, actor, context, change, updated),
          tx
        );
        await this.repository.completeCommand(tx, command.id, id, this.config.now());
        return updated;
      });
      return projectChange(cancelled, actor, this.config);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const duplicate = await this.replay(
        CANCEL_OPERATION,
        input.idempotencyKey!,
        actor,
        requestHash
      );
      if (duplicate) return duplicate;
      throw error;
    }
  }

  async manualTakeover(
    id: string,
    input: CancelSubscriptionChangeInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_MANUAL_TAKEOVER);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.version);
    const reason = input.reason.trim();
    if (!reason) {
      throw new SubscriptionChangeError(
        "MANUAL_TAKEOVER_REASON_REQUIRED",
        "A manual takeover reason is required."
      );
    }

    const current = await this.repository.findChange(id);
    if (!current) throw changeNotFound();
    assertChangeTypeEnabled(this.config, current.changeType);
    if (current.changeType === SubscriptionChangeType.EXTENSION) {
      const takenOver = await this.extensionService.manualTakeover(id, input, actor, context);
      return projectChange(takenOver, actor, this.config);
    }

    const requestHash = commandHash({ id, ...input, reason });
    const replay = await this.replay(
      MANUAL_TAKEOVER_OPERATION,
      input.idempotencyKey!,
      actor,
      requestHash
    );
    if (replay) return replay;

    try {
      const takenOver = await this.repository.transaction(async (tx) => {
        await this.repository.lockChange(tx, id);
        const change = await this.repository.findChange(id, tx);
        if (!change) throw changeNotFound();
        if (change.version !== input.version) throw versionConflict();
        if (
          change.status === SubscriptionChangeStatus.COMPLETED ||
          change.status === SubscriptionChangeStatus.CANCELLED ||
          change.status === SubscriptionChangeStatus.FAILED
        ) {
          throw new SubscriptionChangeError(
            "SUBSCRIPTION_CHANGE_FINAL",
            "A final change cannot enter manual takeover.",
            HttpStatus.CONFLICT
          );
        }
        const command = await this.repository.createCommand(tx, {
          actorId: actor.id,
          idempotencyKey: input.idempotencyKey!,
          operation: MANUAL_TAKEOVER_OPERATION,
          requestHash
        });
        const updated = await this.repository.updateChange(tx, id, {
          manualTakeoverAt: this.config.now(),
          manualTakeoverReason: reason,
          manualTakeoverUser: { connect: { id: actor.id } },
          status: SubscriptionChangeStatus.MANUAL_TAKEOVER,
          updatedBy: actor.id,
          version: { increment: 1 }
        });
        await this.auditService.write(
          auditInput(AuditAction.UPDATE, id, actor, context, change, updated),
          tx
        );
        await this.repository.completeCommand(tx, command.id, id, this.config.now());
        return updated;
      });
      return projectChange(takenOver, actor, this.config);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const duplicate = await this.replay(
        MANUAL_TAKEOVER_OPERATION,
        input.idempotencyKey!,
        actor,
        requestHash
      );
      if (duplicate) return duplicate;
      throw error;
    }
  }

  async getChangeType(id: string) {
    const change = await this.repository.findChange(id);
    if (!change) throw changeNotFound();
    if (
      change.changeType !== SubscriptionChangeType.EXTENSION &&
      change.changeType !== SubscriptionChangeType.VEHICLE_SWAP &&
      change.changeType !== SubscriptionChangeType.EARLY_TERMINATION
    ) {
      throw new SubscriptionChangeError(
        "SUBSCRIPTION_CHANGE_QUOTE_UNSUPPORTED",
        "This subscription-change type does not support quote operations.",
        HttpStatus.CONFLICT
      );
    }
    return change.changeType;
  }

  async getWorkflowChangeType(id: string) {
    const change = await this.repository.findChange(id);
    if (!change) throw changeNotFound();
    return change.changeType;
  }

  private requireVehicleSwapService() {
    if (!this.vehicleSwapService) {
      throw new Error("SUBSCRIPTION_VEHICLE_SWAP_SERVICE_MISSING");
    }
    return this.vehicleSwapService;
  }

  private requireEarlyTerminationService() {
    if (!this.earlyTerminationService) {
      throw new Error("SUBSCRIPTION_EARLY_TERMINATION_SERVICE_MISSING");
    }
    return this.earlyTerminationService;
  }

  private async vehicleSwapDetail(
    tx: Prisma.TransactionClient,
    input: CreateVehicleSwapChangeInput,
    sourceVehicleId: string
  ) {
    const discoveredPlan = await this.repository.findTargetPlan(
      tx,
      input.detail.targetSubscriptionPlanId
    );
    if (!discoveredPlan) {
      throw new SubscriptionChangeError(
        "TARGET_SUBSCRIPTION_PLAN_NOT_FOUND",
        "The target subscription plan was not found.",
        HttpStatus.NOT_FOUND
      );
    }
    const targetVehiclePackageId =
      input.detail.targetVehiclePackageId ?? discoveredPlan.vehiclePackageId;
    await this.repository.lockVehicleSwapResources(tx, {
      sourceVehicleId,
      targetSubscriptionPlanId: input.detail.targetSubscriptionPlanId,
      targetVehicleId: input.detail.targetVehicleId,
      targetVehiclePackageId
    });
    const lockedPlan = await this.repository.findTargetPlan(
      tx,
      input.detail.targetSubscriptionPlanId
    );
    if (!lockedPlan || lockedPlan.vehiclePackageId !== targetVehiclePackageId) {
      throw new SubscriptionChangeError(
        "TARGET_SUBSCRIPTION_PLAN_CHANGED",
        "The target subscription plan changed while the request was being created.",
        HttpStatus.CONFLICT
      );
    }
    const commercialSnapshot = {
      sourceVehicleId,
      stage: "DRAFT_PENDING_QUOTE",
      targetSubscriptionPlanId: input.detail.targetSubscriptionPlanId,
      targetVehicleId: input.detail.targetVehicleId,
      targetVehiclePackageId
    };
    return {
      vehicleSwapDetail: {
        create: {
          commercialSnapshot,
          commercialSnapshotHash: commandHash(commercialSnapshot),
          plannedSwapAt: parseDateTime(input.detail.plannedSwapAt, "PLANNED_SWAP_AT_INVALID"),
          sourceVehicleId,
          targetSubscriptionPlanId: input.detail.targetSubscriptionPlanId,
          targetVehicleId: input.detail.targetVehicleId,
          targetVehiclePackageId
        }
      }
    };
  }

  private async replay(
    operation: string,
    idempotencyKey: string,
    actor: RequestUser,
    requestHash: string
  ) {
    const command = await this.repository.findCommand(actor.id, operation, idempotencyKey);
    if (!command) return null;
    if (command.requestHash !== requestHash) {
      throw new SubscriptionChangeError(
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency key was already used with a different request.",
        HttpStatus.CONFLICT
      );
    }
    if (command.resourceType !== "CHANGE" || !command.resourceId) {
      throw new SubscriptionChangeError(
        "IDEMPOTENCY_COMMAND_IN_PROGRESS",
        "The idempotent subscription change command has not completed.",
        HttpStatus.CONFLICT
      );
    }
    const change = await this.repository.findChange(command.resourceId);
    if (!change) {
      throw new SubscriptionChangeError(
        "IDEMPOTENCY_RESOURCE_MISSING",
        "The idempotent subscription change result is missing.",
        HttpStatus.CONFLICT
      );
    }
    return projectChange(change, actor, this.config);
  }
}

function assertChangeTypeEnabled(
  config: SubscriptionChangeConfig,
  changeType: SubscriptionChangeType
) {
  if (isSubscriptionChangeTypeEnabled(config, changeType)) return;
  const codeByType: Record<SubscriptionChangeType, string> = {
    [SubscriptionChangeType.EARLY_TERMINATION]: "SUBSCRIPTION_EARLY_TERMINATION_DISABLED",
    [SubscriptionChangeType.EXTENSION]: "SUBSCRIPTION_EXTENSION_DISABLED",
    [SubscriptionChangeType.MANAGED_OTHER]: "SUBSCRIPTION_MANAGED_OTHER_DISABLED",
    [SubscriptionChangeType.VEHICLE_SWAP]: "SUBSCRIPTION_VEHICLE_SWAP_DISABLED"
  };
  throw new SubscriptionChangeError(
    codeByType[changeType],
    `Subscription change type ${changeType} is disabled.`,
    HttpStatus.SERVICE_UNAVAILABLE
  );
}

function projectChange<T extends Parameters<typeof projectSubscriptionChange>[0]>(
  change: T,
  actor: RequestUser,
  config: SubscriptionChangeConfig
) {
  const availability = changeTypeAvailability(config, change.changeType);
  const projected = projectSubscriptionChange(change, actor);
  const managedOtherSupplementStatus =
    change.changeType === SubscriptionChangeType.MANAGED_OTHER &&
    (
      change as typeof change & {
        contract?: { status?: ContractStatus } | null;
        contractId?: string | null;
      }
    ).contractId
      ? (change as typeof change & { contract?: { status?: ContractStatus } | null }).contract
          ?.status
      : null;
  const finalizedManagedOtherSupplement =
    change.changeType === SubscriptionChangeType.MANAGED_OTHER &&
    change.status === SubscriptionChangeStatus.SCHEDULED &&
    managedOtherSupplementStatus === ContractStatus.ARCHIVED;
  const customerConfirmationAlreadyPublished = Boolean(
    (change as typeof change & { customerConfirmationPublishedAt?: Date | null })
      .customerConfirmationPublishedAt
  );
  return {
    ...projected,
    allowedActions: availability.enabled
      ? projected.allowedActions.filter(
          (action) =>
            !(finalizedManagedOtherSupplement && action === "CANCEL") &&
            !(change.changeType === SubscriptionChangeType.MANAGED_OTHER && action === "RETRY") &&
            !(
              customerConfirmationAlreadyPublished &&
              ["APPROVE", "CREATE_QUOTE", "PUBLISH_CUSTOMER_CONFIRMATION"].includes(action)
            )
        )
      : [],
    featureAvailability: availability
  };
}

function changeTypeAvailability(
  config: SubscriptionChangeConfig,
  changeType: SubscriptionChangeType
) {
  const flagName =
    changeType === SubscriptionChangeType.EXTENSION
      ? SUBSCRIPTION_CHANGE_FLAG_NAMES.extension
      : changeType === SubscriptionChangeType.VEHICLE_SWAP
        ? SUBSCRIPTION_CHANGE_FLAG_NAMES.vehicleSwap
        : changeType === SubscriptionChangeType.EARLY_TERMINATION
          ? SUBSCRIPTION_CHANGE_FLAG_NAMES.earlyTermination
          : SUBSCRIPTION_CHANGE_FLAG_NAMES.managedOther;
  return {
    enabled: isSubscriptionChangeTypeEnabled(config, changeType),
    flagName
  };
}

function createDetailData(
  input: Exclude<CreateSubscriptionChangeInput, CreateVehicleSwapChangeInput>,
  actor: RequestUser,
  now: Date
) {
  if (input.changeType === SubscriptionChangeType.EARLY_TERMINATION) {
    return {
      earlyTerminationDetail: {
        create: {
          effectiveDate: parseDate(input.detail.effectiveDate, "EFFECTIVE_DATE_INVALID"),
          reasonSnapshot: {
            reason: input.detail.reason.trim(),
            requestedAt: now.toISOString(),
            requestedBy: actor.id
          }
        }
      }
    };
  }
  if (input.changeType === SubscriptionChangeType.MANAGED_OTHER) {
    const normalized = normalizeManagedOtherRequest(input.detail);
    return {
      managedOtherDetail: {
        create: {
          approvedOperationSnapshot: {
            approval: null,
            request: {
              operation: normalized.operation,
              operationPayload: normalized.operationPayload
            }
          },
          beforeSnapshot: normalized.beforeSnapshot,
          effectiveDate: parseDate(input.detail.effectiveDate, "EFFECTIVE_DATE_INVALID"),
          evidenceSnapshot: toJson(normalized.evidence),
          reason: input.detail.reason.trim()
        }
      }
    };
  }
  throw new SubscriptionChangeError(
    "SUBSCRIPTION_CHANGE_TYPE_UNSUPPORTED",
    "The subscription change type is not supported."
  );
}

function completionDeadline(input: CreateSubscriptionChangeInput) {
  switch (input.changeType) {
    case SubscriptionChangeType.VEHICLE_SWAP:
      return parseDateTime(input.detail.plannedSwapAt, "PLANNED_SWAP_AT_INVALID");
    case SubscriptionChangeType.EARLY_TERMINATION:
    case SubscriptionChangeType.MANAGED_OTHER:
      return shanghaiStartOfDate(parseDate(input.detail.effectiveDate, "EFFECTIVE_DATE_INVALID"));
    case SubscriptionChangeType.EXTENSION:
      throw new SubscriptionChangeError(
        "SUBSCRIPTION_CHANGE_TYPE_UNSUPPORTED",
        "Extension deadlines are owned by the extension workflow."
      );
  }
}

function validateCreateInput(input: CreateSubscriptionChangeInput) {
  if (input.changeType === SubscriptionChangeType.EARLY_TERMINATION) {
    if (!input.detail.reason.trim()) required("EARLY_TERMINATION_REASON_REQUIRED");
    parseDate(input.detail.effectiveDate, "EFFECTIVE_DATE_INVALID");
  }
  if (input.changeType === SubscriptionChangeType.MANAGED_OTHER) {
    if (!input.detail.reason.trim()) required("MANAGED_OTHER_REASON_REQUIRED");
    normalizeManagedOtherRequest(input.detail);
    parseDate(input.detail.effectiveDate, "EFFECTIVE_DATE_INVALID");
  }
  if (input.changeType === SubscriptionChangeType.VEHICLE_SWAP) {
    if (input.detail.targetVehicleId === "") required("TARGET_VEHICLE_REQUIRED");
    if (input.detail.targetSubscriptionPlanId === "") required("TARGET_PLAN_REQUIRED");
    parseDateTime(input.detail.plannedSwapAt, "PLANNED_SWAP_AT_INVALID");
  }
}

interface ActiveOrderCandidate {
  businessType: BusinessType;
  deletedAt: Date | null;
  orderStatus: OrderStatus;
  vehicle: null | { status: VehicleStatus };
  vehicleId: string | null;
}

function assertActiveOrder(
  order: ActiveOrderCandidate | null
): asserts order is ActiveOrderCandidate & {
  vehicle: { status: VehicleStatus };
  vehicleId: string;
} {
  if (!order || order.deletedAt) {
    throw new SubscriptionChangeError(
      "SUBSCRIPTION_ORDER_NOT_FOUND",
      "Subscription order was not found.",
      HttpStatus.NOT_FOUND
    );
  }
  if (
    order.businessType !== BusinessType.SUBSCRIPTION ||
    order.orderStatus !== OrderStatus.ACTIVE
  ) {
    throw new SubscriptionChangeError(
      "SUBSCRIPTION_ORDER_NOT_ACTIVE",
      "Only an active subscription order can create an active-term change.",
      HttpStatus.CONFLICT
    );
  }
  if (!order.vehicleId || !order.vehicle || order.vehicle.status !== VehicleStatus.LEASED) {
    throw new SubscriptionChangeError(
      "LEASED_VEHICLE_REQUIRED",
      "The active subscription order must have its leased vehicle.",
      HttpStatus.CONFLICT
    );
  }
}

function assertPermission(actor: RequestUser, permission: PermissionCode) {
  if (!actor.permissions.includes(permission)) {
    throw new SubscriptionChangeError(
      "SUBSCRIPTION_CHANGE_PERMISSION_DENIED",
      `Permission ${permission} is required.`,
      HttpStatus.FORBIDDEN
    );
  }
}

function assertIdempotencyKey(value: string | undefined) {
  if (!value?.trim() || value.length > 128) {
    throw new SubscriptionChangeError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header is required."
    );
  }
}

function assertVersion(version: number) {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new SubscriptionChangeError("VERSION_INVALID", "A non-negative version is required.");
  }
}

function parseDate(value: string, code: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new SubscriptionChangeError(code, "A valid calendar date is required.");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new SubscriptionChangeError(code, "A valid calendar date is required.");
  }
  return date;
}

function parseDateTime(value: string, code: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SubscriptionChangeError(code, "A valid timestamp is required.");
  }
  return date;
}

function shanghaiStartOfDate(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - 8 * 3_600_000
  );
}

function commandHash(input: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

function toJson(value: unknown) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))
  ) as Prisma.InputJsonValue;
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function activeChangeExists() {
  return new SubscriptionChangeError(
    "ACTIVE_SUBSCRIPTION_CHANGE_EXISTS",
    "The order already has an active subscription change.",
    HttpStatus.CONFLICT
  );
}

function changeNotFound() {
  return new SubscriptionChangeError(
    "SUBSCRIPTION_CHANGE_NOT_FOUND",
    "Subscription change was not found.",
    HttpStatus.NOT_FOUND
  );
}

function versionConflict() {
  return new SubscriptionChangeError(
    "VERSION_CONFLICT",
    "The subscription change was updated by another request.",
    HttpStatus.CONFLICT
  );
}

function required(code: string): never {
  throw new SubscriptionChangeError(code, "A required subscription change field is missing.");
}

function auditInput(
  action: AuditAction,
  entityId: string,
  actor: RequestUser,
  context: RequestContext,
  before: unknown,
  after: unknown
) {
  return {
    action,
    after: toJson(after),
    before: before === undefined ? undefined : toJson(before),
    entityId,
    entityType: "subscription_change_order",
    ipAddress: context.ipAddress,
    module: "subscription_change",
    operatorId: actor.id,
    userAgent: context.userAgent
  };
}
