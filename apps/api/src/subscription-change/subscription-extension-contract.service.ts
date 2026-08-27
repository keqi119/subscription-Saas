import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PermissionCode } from "@subscription-saas/shared";
import { createHash } from "node:crypto";
import {
  AuditAction,
  BusinessType,
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  Prisma,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import type { Contract, ContractVersion } from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo } from "../common/business-number";
import { ContractPdfArtifactWriterService } from "../contract/contract-pdf-artifact-writer.service";
import type { ContractPdfArtifactWriteResult } from "../contract/contract-pdf-artifact.types";
import {
  ContractPdfAppendixRow,
  ContractPdfRenderModel,
  ContractPdfValue,
  createStage1ContractPdfSigningSlots
} from "../contract/contract-pdf-render-model";
import { PrismaService } from "../prisma/prisma.service";
import { VehicleInsuranceService } from "../vehicle-insurance/vehicle-insurance.service";
import { SubscriptionChangeError } from "./subscription-change.errors";
import {
  isSubscriptionChangeTypeEnabled,
  SUBSCRIPTION_CHANGE_CONFIG,
  SubscriptionChangeConfig
} from "./subscription-change.config";
import {
  ExtensionChangeProjection,
  requireExtensionChangeProjection
} from "./subscription-extension-compat";

const CONTRACT_PDF_CJK_FONT_PATH_ENV = "CONTRACT_PDF_CJK_FONT_PATH";

const extensionContractInclude = Prisma.validator<Prisma.SubscriptionChangeOrderInclude>()({
  confirmedQuote: true,
  contract: true,
  extensionDetail: {
    include: {
      sourceSegment: {
        include: { sourceContract: true }
      }
    }
  },
  order: {
    include: {
      customer: {
        include: {
          identity: { select: { idCardNo: true } },
          profile: { select: { residenceAddress: true } }
        }
      },
      vehicle: {
        select: {
          brand: true,
          id: true,
          model: true,
          plateNo: true,
          vehicleNo: true
        }
      }
    }
  },
  sourceSegment: {
    include: {
      sourceContract: true
    }
  }
});

type ExtensionContractChange = Prisma.SubscriptionChangeOrderGetPayload<{
  include: typeof extensionContractInclude;
}>;
type ProjectedExtensionContractChange = ExtensionChangeProjection<ExtensionContractChange>;

interface GenerationRenderReservation {
  change: ProjectedExtensionContractChange;
  commandId: string;
  contract: Contract;
  generatedAt: Date;
  kind: "render";
  snapshot: ExtensionContractSnapshot;
  template: ContractVersion;
}

const GENERATION_COMMAND_RECOVERY_MS = 120_000;

export interface ExtensionContractSnapshot {
  confirmedQuote: {
    id: string;
    quoteNo: string;
    revision: number;
  };
  extension: {
    endDate: string;
    energyLimitCount: number | null;
    energyLimitKwh: number | null;
    mileageLimitKm: number;
    monthlyFeeAmount: string;
    overMileageFeeAmount: string;
    planSnapshot: Prisma.JsonValue;
    startDate: string;
    subscriptionPlanId: string | null;
  };
  originalContract: {
    contractId: string;
    contractNo: string;
    endDate: string;
  };
  order: {
    customerId: string;
    orderId: string;
    orderNo: string;
    vehicleId: string;
  };
}

export const SUBSCRIPTION_EXTENSION_NOW = Symbol("SUBSCRIPTION_EXTENSION_NOW");

export interface GenerateExtensionContractInput {
  idempotencyKey?: string;
  version: number;
}

@Injectable()
export class SubscriptionExtensionContractService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly artifactWriter: ContractPdfArtifactWriterService,
    private readonly vehicleInsuranceService: VehicleInsuranceService,
    private readonly configService: ConfigService,
    @Inject(SUBSCRIPTION_CHANGE_CONFIG)
    private readonly changeConfig: SubscriptionChangeConfig,
    @Optional()
    @Inject(SUBSCRIPTION_EXTENSION_NOW)
    private readonly nowProvider?: () => Date
  ) {}

  async generate(
    changeOrderId: string,
    input: GenerateExtensionContractInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertEnabled();
    assertPermission(actor);
    assertGenerationInput(input);
    const operation = "GENERATE_EXTENSION_CONTRACT";
    const requestHash = commandHash({ changeOrderId, version: input.version });
    const reservation = await this.reserveGeneration(
      changeOrderId,
      input,
      actor,
      operation,
      requestHash
    );
    if (reservation.kind === "replay") return reservation.contract;

    let artifact: ContractPdfArtifactWriteResult;
    try {
      artifact = await this.artifactWriter.writeGeneratedContractPdfArtifact({
        cjkFontPath: this.configService.get<string>(CONTRACT_PDF_CJK_FONT_PATH_ENV),
        contractStatus: reservation.contract.status,
        existingContractFileId: reservation.contract.fileId,
        recoverExistingObject: true,
        renderModel: buildExtensionPdfRenderModel(
          reservation.contract,
          reservation.change,
          reservation.template,
          reservation.snapshot,
          reservation.generatedAt
        ),
        uploadedBy: actor.id
      });
    } catch (error) {
      await this.abortGenerationReservation(
        reservation.commandId,
        changeOrderId,
        reservation.contract.id,
        actor.id
      );
      throw error;
    }

    return this.finalizeGeneration(reservation, artifact, input, actor, context);
  }

  async getContractSnapshot(changeOrderId: string): Promise<ExtensionContractSnapshot> {
    const change = await this.findChange(changeOrderId);
    return buildExtensionContractSnapshot(change);
  }

  private async findChange(changeOrderId: string) {
    const change = await this.prisma.subscriptionChangeOrder.findUnique({
      include: extensionContractInclude,
      where: { id: changeOrderId }
    });
    if (!change) {
      throw new SubscriptionChangeError(
        "SUBSCRIPTION_CHANGE_NOT_FOUND",
        "Subscription change order was not found.",
        404
      );
    }
    return requireExtensionChangeProjection(change);
  }

  private async reserveGeneration(
    changeOrderId: string,
    input: GenerateExtensionContractInput & { idempotencyKey: string },
    actor: RequestUser,
    operation: string,
    requestHash: string
  ): Promise<{ contract: Contract; kind: "replay" } | GenerationRenderReservation> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const identity = {
            actorId: actor.id,
            idempotencyKey: input.idempotencyKey,
            operation
          };
          let command = await tx.subscriptionChangeCommand.findUnique({
            where: { actorId_operation_idempotencyKey: identity }
          });
          const recovering = Boolean(command);
          if (command) {
            assertMatchingCommand(command.requestHash, requestHash);
            if (command.resourceType === "CONTRACT" && command.resourceId) {
              return {
                contract: await findCommandContract(tx, command.resourceId),
                kind: "replay" as const
              };
            }
            if (
              command.resourceType !== "CONTRACT_RENDERING" ||
              !command.resourceId ||
              this.now().getTime() - command.updatedAt.getTime() < GENERATION_COMMAND_RECOVERY_MS
            ) {
              throw generationInProgress();
            }
            await lockCommand(tx, command.id);
            command = await tx.subscriptionChangeCommand.findUnique({ where: { id: command.id } });
            if (!command) {
              throw conflict(
                "IDEMPOTENCY_RESOURCE_MISSING",
                "The contract generation command is missing."
              );
            }
            if (command.resourceType === "CONTRACT" && command.resourceId) {
              return {
                contract: await findCommandContract(tx, command.resourceId),
                kind: "replay" as const
              };
            }
            if (command.resourceType !== "CONTRACT_RENDERING" || !command.resourceId) {
              throw generationInProgress();
            }
          } else {
            command = await tx.subscriptionChangeCommand.create({
              data: { ...identity, requestHash }
            });
          }

          await lockChange(tx, changeOrderId);
          const storedChange = await tx.subscriptionChangeOrder.findUnique({
            include: extensionContractInclude,
            where: { id: changeOrderId }
          });
          if (!storedChange) {
            throw new SubscriptionChangeError(
              "SUBSCRIPTION_CHANGE_NOT_FOUND",
              "Subscription change order was not found.",
              404
            );
          }
          const change = requireExtensionChangeProjection(storedChange);

          if (recovering) {
            if (
              !change.contract ||
              change.contract.id !== command.resourceId ||
              change.contract.status === ContractStatus.CANCELLED
            ) {
              throw conflict(
                "IDEMPOTENCY_RESOURCE_MISSING",
                "The reserved extension contract no longer exists."
              );
            }
            const template = await tx.contractVersion.findUnique({
              where: { id: change.contract.contractVersionId }
            });
            if (!template) {
              throw conflict(
                "IDEMPOTENCY_RESOURCE_MISSING",
                "The reserved extension contract template no longer exists."
              );
            }
            await tx.subscriptionChangeCommand.update({
              data: { resourceType: "CONTRACT_RENDERING" },
              where: { id: command.id }
            });
            return {
              change,
              commandId: command.id,
              contract: change.contract,
              generatedAt: change.contract.createdAt,
              kind: "render" as const,
              snapshot: buildExtensionContractSnapshot(change),
              template
            };
          }

          if (change.contract && change.contract.status !== ContractStatus.CANCELLED) {
            if (
              !change.contract.fileId ||
              change.status === SubscriptionChangeStatus.CUSTOMER_CONFIRMED
            ) {
              throw generationInProgress();
            }
            await completeGenerationCommand(tx, command.id, change.contract.id, this.now());
            return { contract: change.contract, kind: "replay" as const };
          }
          if (change.version !== input.version) {
            throw conflict(
              "VERSION_CONFLICT",
              "The subscription change was updated by another request."
            );
          }
          assertGeneratable(change, this.now());
          const snapshot = buildExtensionContractSnapshot(change);
          await this.vehicleInsuranceService.assertVehicleCoveredThrough(
            change.order.vehicleId!,
            change.targetEndDate
          );
          const generatedAt = this.now();
          const template = await tx.contractVersion.findFirst({
            orderBy: { effectiveFrom: "desc" },
            where: {
              businessType: BusinessType.SUBSCRIPTION,
              deletedAt: null,
              effectiveFrom: { lte: generatedAt },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: generatedAt } }],
              status: ContractVersionStatus.ACTIVE,
              templateType: ContractTemplateType.SUBSCRIPTION_EXTENSION
            }
          });
          if (!template) {
            throw new SubscriptionChangeError(
              "SUBSCRIPTION_EXTENSION_TEMPLATE_NOT_FOUND",
              "No active subscription extension agreement template is available."
            );
          }
          const contractSnapshot = toJsonValue({
            ...snapshot,
            changeOrderId: change.id,
            contentTemplate: template.contentTemplate,
            generatedAt: generatedAt.toISOString(),
            template: {
              id: template.id,
              name: template.templateName,
              type: template.templateType,
              version: template.versionNo
            }
          });
          const contract = await tx.contract.create({
            data: {
              businessType: BusinessType.SUBSCRIPTION,
              contractNo: createBusinessNo("CON"),
              contractSnapshot,
              contractTitle: `${template.templateName} ${template.versionNo}`,
              contractVersionId: template.id,
              createdBy: actor.id,
              customerId: change.order.customerId,
              orderId: change.order.id,
              status: ContractStatus.GENERATED,
              updatedBy: actor.id
            }
          });
          await tx.subscriptionChangeOrder.update({
            data: { contractId: contract.id, updatedBy: actor.id },
            where: { id: change.id }
          });
          await tx.subscriptionChangeCommand.update({
            data: { resourceId: contract.id, resourceType: "CONTRACT_RENDERING" },
            where: { id: command.id }
          });
          return {
            change: { ...change, contract, contractId: contract.id },
            commandId: command.id,
            contract,
            generatedAt,
            kind: "render" as const,
            snapshot,
            template
          };
        }, serializableTransaction);
      } catch (error) {
        if (!isPrismaUniqueConstraintError(error) || attempt === 3) throw error;
        const replay = await this.findCommandResult(
          actor.id,
          operation,
          input.idempotencyKey,
          requestHash
        );
        if (replay) return replay;
      }
    }
    throw new Error("Contract generation reservation retry exhausted.");
  }

  private async findCommandResult(
    actorId: string,
    operation: string,
    idempotencyKey: string,
    requestHash: string
  ): Promise<{ contract: Contract; kind: "replay" } | null> {
    const command = await this.prisma.subscriptionChangeCommand.findUnique({
      where: {
        actorId_operation_idempotencyKey: { actorId, idempotencyKey, operation }
      }
    });
    if (!command) return null;
    assertMatchingCommand(command.requestHash, requestHash);
    if (command.resourceType !== "CONTRACT" || !command.resourceId) {
      throw generationInProgress();
    }
    return {
      contract: await findCommandContract(this.prisma, command.resourceId),
      kind: "replay"
    };
  }

  private async finalizeGeneration(
    reservation: GenerationRenderReservation,
    artifact: ContractPdfArtifactWriteResult,
    input: GenerateExtensionContractInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockCommand(tx, reservation.commandId);
      const command = await tx.subscriptionChangeCommand.findUnique({
        where: { id: reservation.commandId }
      });
      if (!command) {
        throw conflict(
          "IDEMPOTENCY_RESOURCE_MISSING",
          "The contract generation command is missing."
        );
      }
      if (command.resourceType === "CONTRACT" && command.resourceId) {
        return findCommandContract(tx, command.resourceId);
      }
      if (
        command.resourceType !== "CONTRACT_RENDERING" ||
        command.resourceId !== reservation.contract.id
      ) {
        throw generationInProgress();
      }
      await lockChange(tx, reservation.change.id);
      const storedChange = await tx.subscriptionChangeOrder.findUnique({
        include: extensionContractInclude,
        where: { id: reservation.change.id }
      });
      if (
        !storedChange ||
        storedChange.contractId !== reservation.contract.id ||
        !storedChange.contract
      ) {
        throw conflict(
          "IDEMPOTENCY_RESOURCE_MISSING",
          "The reserved extension contract is missing."
        );
      }
      const change = requireExtensionChangeProjection(storedChange);
      if (change.version !== input.version) {
        throw conflict(
          "VERSION_CONFLICT",
          "The subscription change was updated by another request."
        );
      }
      assertGeneratable(change, this.now());
      const contract = await tx.contract.update({
        data: {
          contractSnapshot: appendArtifact(storedChange.contract.contractSnapshot, artifact),
          fileId: artifact.fileId,
          updatedBy: actor.id
        },
        where: { id: reservation.contract.id }
      });
      await tx.subscriptionChangeOrder.update({
        data: {
          status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
          updatedBy: actor.id,
          version: { increment: 1 }
        },
        where: {
          id: change.id,
          status: SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
          version: change.version
        }
      });
      await this.auditService.write(
        {
          action: AuditAction.CREATE,
          after: {
            changeOrderId: change.id,
            contractId: contract.id,
            contractNo: contract.contractNo,
            originalContractId: reservation.snapshot.originalContract.contractId
          },
          entityId: contract.id,
          entityType: "subscription_extension_contract",
          ipAddress: context.ipAddress,
          module: "subscription_change",
          operatorId: actor.id,
          userAgent: context.userAgent
        },
        tx
      );
      await completeGenerationCommand(tx, command.id, contract.id, this.now());
      return contract;
    }, serializableTransaction);
  }

  private async abortGenerationReservation(
    commandId: string,
    changeOrderId: string,
    contractId: string,
    actorId: string
  ) {
    await this.prisma.$transaction(async (tx) => {
      await lockCommand(tx, commandId);
      await lockChange(tx, changeOrderId);
      const command = await tx.subscriptionChangeCommand.findUnique({ where: { id: commandId } });
      if (
        !command ||
        command.resourceType !== "CONTRACT_RENDERING" ||
        command.resourceId !== contractId
      ) {
        return;
      }
      await tx.contract.update({
        data: { status: ContractStatus.CANCELLED, updatedBy: actorId },
        where: { id: contractId }
      });
      await tx.subscriptionChangeOrder.updateMany({
        data: { contractId: null, updatedBy: actorId },
        where: { contractId, id: changeOrderId }
      });
      await tx.subscriptionChangeCommand.delete({ where: { id: commandId } });
    }, serializableTransaction);
  }

  private assertEnabled() {
    if (
      !isSubscriptionChangeTypeEnabled(this.changeConfig, SubscriptionChangeType.EXTENSION)
    ) {
      throw new SubscriptionChangeError(
        "SUBSCRIPTION_EXTENSION_DISABLED",
        "Subscription extensions are disabled.",
        503
      );
    }
  }

  private now() {
    return this.nowProvider?.() ?? new Date();
  }
}

function assertPermission(actor: RequestUser) {
  if (!actor.permissions.includes(PermissionCode.CONTRACT_GENERATE)) {
    throw new SubscriptionChangeError(
      "SUBSCRIPTION_EXTENSION_CONTRACT_FORBIDDEN",
      "Contract generation permission is required.",
      403
    );
  }
}

function assertGenerationInput(
  input: GenerateExtensionContractInput
): asserts input is GenerateExtensionContractInput & { idempotencyKey: string } {
  if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 128) {
    throw new SubscriptionChangeError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header is required.",
      400
    );
  }
  if (!Number.isSafeInteger(input.version) || input.version < 0) {
    throw new SubscriptionChangeError(
      "VERSION_INVALID",
      "A non-negative optimistic-lock version is required.",
      400
    );
  }
}

function assertMatchingCommand(actualHash: string, expectedHash: string) {
  if (actualHash !== expectedHash) {
    throw conflict(
      "IDEMPOTENCY_KEY_REUSED",
      "The Idempotency-Key was already used with a different request."
    );
  }
}

async function lockChange(tx: Prisma.TransactionClient, changeOrderId: string) {
  if (typeof tx.$queryRaw !== "function") return;
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "subscription_change_order" WHERE "id" = ${changeOrderId}::uuid FOR UPDATE`
  );
}

async function lockCommand(tx: Prisma.TransactionClient, commandId: string) {
  if (typeof tx.$queryRaw !== "function") return;
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "subscription_change_command" WHERE "id" = ${commandId}::uuid FOR UPDATE`
  );
}

async function findCommandContract(
  prisma: Pick<Prisma.TransactionClient, "contract">,
  contractId: string
) {
  const contract = await prisma.contract.findUnique({ where: { id: contractId } });
  if (!contract) {
    throw conflict(
      "IDEMPOTENCY_RESOURCE_MISSING",
      "The generated extension contract no longer exists."
    );
  }
  return contract;
}

async function completeGenerationCommand(
  tx: Prisma.TransactionClient,
  commandId: string,
  contractId: string,
  completedAt: Date
) {
  await tx.subscriptionChangeCommand.update({
    data: { completedAt, resourceId: contractId, resourceType: "CONTRACT" },
    where: { id: commandId }
  });
}

function commandHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
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

function conflict(code: string, message: string) {
  return new SubscriptionChangeError(code, message, 409);
}

function generationInProgress() {
  return conflict(
    "IDEMPOTENCY_COMMAND_IN_PROGRESS",
    "The idempotent contract generation command has not completed."
  );
}

function isPrismaUniqueConstraintError(error: unknown) {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === "P2002"
  );
}

function assertGeneratable(change: ProjectedExtensionContractChange, now: Date) {
  if (change.status !== SubscriptionChangeStatus.CUSTOMER_CONFIRMED) {
    throw new SubscriptionChangeError(
      "EXTENSION_CUSTOMER_CONFIRMATION_REQUIRED",
      "The exact extension quote must be confirmed before generating the agreement."
    );
  }
  if (
    !change.confirmedQuote ||
    change.confirmedQuoteId !== change.confirmedQuote.id ||
    change.confirmedQuote.status !== SubscriptionChangeQuoteStatus.CUSTOMER_CONFIRMED
  ) {
    throw new SubscriptionChangeError(
      "EXTENSION_CONFIRMED_QUOTE_REQUIRED",
      "A customer-confirmed extension quote is required."
    );
  }
  if (now.getTime() >= change.completionDeadlineAt.getTime()) {
    throw new SubscriptionChangeError(
      "EXTENSION_DEADLINE_PASSED",
      "The extension completion deadline has passed."
    );
  }
  if (!change.order.vehicleId || !change.order.vehicle) {
    throw new SubscriptionChangeError(
      "EXTENSION_VEHICLE_REQUIRED",
      "The extension order must have a vehicle."
    );
  }
  const sourceContract = change.sourceSegment.sourceContract;
  if (!sourceContract || sourceContract.status !== ContractStatus.ARCHIVED) {
    throw new SubscriptionChangeError(
      "EXTENSION_ORIGINAL_CONTRACT_REQUIRED",
      "An archived original contract is required for an extension agreement."
    );
  }
  if (!change.order.customer.identity?.idCardNo?.trim()) {
    throw new SubscriptionChangeError(
      "EXTENSION_CUSTOMER_ID_NUMBER_REQUIRED",
      "Customer identity information is required for the extension agreement."
    );
  }
}

const serializableTransaction = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable
};

function buildExtensionContractSnapshot(
  change: ProjectedExtensionContractChange
): ExtensionContractSnapshot {
  const quote = change.confirmedQuote;
  const original = change.sourceSegment.sourceContract;
  if (!quote) {
    throw new SubscriptionChangeError(
      "EXTENSION_CONFIRMED_QUOTE_REQUIRED",
      "A customer-confirmed extension quote is required."
    );
  }
  if (!original) {
    throw new SubscriptionChangeError(
      "EXTENSION_ORIGINAL_CONTRACT_REQUIRED",
      "An original contract is required for an extension agreement."
    );
  }
  if (!change.order.vehicleId) {
    throw new SubscriptionChangeError(
      "EXTENSION_VEHICLE_REQUIRED",
      "The extension order must have a vehicle."
    );
  }

  return {
    confirmedQuote: {
      id: quote.id,
      quoteNo: quote.quoteNo,
      revision: quote.revision
    },
    extension: {
      endDate: dateOnly(change.targetEndDate),
      energyLimitCount: quote.energyLimitCount,
      energyLimitKwh: quote.energyLimitKwh,
      mileageLimitKm: quote.mileageLimitKm,
      monthlyFeeAmount: quote.monthlyFeeAmount.toString(),
      overMileageFeeAmount: quote.overMileageFeeAmount.toString(),
      planSnapshot: quote.planSnapshot,
      startDate: dateOnly(change.targetStartDate),
      subscriptionPlanId: quote.subscriptionPlanId
    },
    originalContract: {
      contractId: original.id,
      contractNo: original.contractNo,
      endDate: dateOnly(change.sourceSegment.endDate)
    },
    order: {
      customerId: change.order.customerId,
      orderId: change.order.id,
      orderNo: change.order.orderNo,
      vehicleId: change.order.vehicleId
    }
  };
}

function buildExtensionPdfRenderModel(
  contract: {
    contractNo: string;
    id: string;
  },
  change: ProjectedExtensionContractChange,
  template: {
    contentTemplate: string;
    templateName: string;
    versionNo: string;
  },
  snapshot: ExtensionContractSnapshot,
  generatedAt: Date
): ContractPdfRenderModel {
  const quote = change.confirmedQuote!;
  const original = change.sourceSegment.sourceContract!;
  const vehicle = change.order.vehicle!;

  return {
    agreementKind: "SUBSCRIPTION_EXTENSION",
    appendix: {
      sections: [
        section("Extension agreement reference", [
          row("Original contract no.", original.contractNo),
          row("Original service end date", change.sourceSegment.endDate),
          row("Confirmed quote no.", quote.quoteNo),
          row("Confirmed quote revision", quote.revision)
        ]),
        section("Extension terms", [
          row("Extension start date", change.targetStartDate),
          row("Extension end date", change.targetEndDate),
          row("Extension months", change.extensionMonths),
          row("Monthly fee (CNY)", formatMinorAmountAsYuan(quote.monthlyFeeAmount)),
          row("Mileage allowance (km/month)", quote.mileageLimitKm),
          row("Over-mileage fee (CNY/km)", formatMinorAmountAsYuan(quote.overMileageFeeAmount)),
          row("Plan snapshot", JSON.stringify(quote.planSnapshot))
        ]),
        section("Vehicle", [
          row("Vehicle no.", vehicle.vehicleNo),
          row("Brand/model", [vehicle.brand, vehicle.model].filter(Boolean).join(" ")),
          row("Plate no.", maskPlate(vehicle.plateNo))
        ])
      ]
    },
    contentTemplate: template.contentTemplate,
    contractId: contract.id,
    contractNo: contract.contractNo,
    extensionTerms: {
      confirmedQuoteNo: snapshot.confirmedQuote.quoteNo,
      extensionEndDate: change.targetEndDate,
      extensionStartDate: change.targetStartDate,
      monthlyFeeAmount: quote.monthlyFeeAmount.toString(),
      originalContractNo: snapshot.originalContract.contractNo,
      originalEndDate: change.sourceSegment.endDate,
      planSnapshot: quote.planSnapshot
    },
    generatedAt,
    orderNo: change.order.orderNo,
    signingSlots: createStage1ContractPdfSigningSlots(),
    signingStage: "STAGE1_CONTRACT",
    subscriberParty: {
      subscriberContactAddress: change.order.customer.profile?.residenceAddress ?? null,
      subscriberContactName: change.order.customer.name,
      subscriberContactPhone: change.order.customer.mobile,
      subscriberEmail: null,
      subscriberIdNumber: change.order.customer.identity!.idCardNo,
      subscriberName: change.order.customer.name,
      subscriberWechat: null
    },
    templateName: template.templateName,
    templateVersion: template.versionNo
  };
}

function section(title: string, rows: Array<ContractPdfAppendixRow | null>) {
  return { rows: rows.filter((item): item is ContractPdfAppendixRow => Boolean(item)), title };
}

function row(label: string, value: unknown): ContractPdfAppendixRow | null {
  const formatted = pdfValue(value);
  return formatted === null ? null : { label, value: formatted };
}

function pdfValue(value: unknown): ContractPdfValue | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date || ["boolean", "number", "string"].includes(typeof value)) {
    return value as ContractPdfValue;
  }
  return String(value);
}

function appendArtifact(
  snapshot: Prisma.InputJsonValue | Prisma.JsonValue,
  artifact: ContractPdfArtifactWriteResult
): Prisma.InputJsonValue {
  const base = isJsonObject(snapshot) ? snapshot : {};
  return toJsonValue({
    ...base,
    generatedPdfArtifact: {
      bucket: artifact.bucket,
      diagnostics: artifact.diagnostics,
      fileId: artifact.fileId,
      mimeType: artifact.mimeType,
      objectKey: artifact.objectKey,
      originalName: artifact.originalName,
      sizeBytes: artifact.sizeBytes
    }
  });
}

function isJsonObject(
  value: Prisma.InputJsonValue | Prisma.JsonValue
): value is Prisma.InputJsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))
  ) as Prisma.InputJsonValue;
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function formatMinorAmountAsYuan(value: bigint) {
  const yuan = value / 100n;
  const cents = (value % 100n).toString().padStart(2, "0");
  return `${yuan.toString()}.${cents}`;
}

function maskPlate(value: string | null) {
  if (!value) return null;
  return value.length <= 3 ? "***" : `${value.slice(0, 2)}***${value.slice(-1)}`;
}
