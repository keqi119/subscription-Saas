import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PermissionCode } from "@subscription-saas/shared";
import {
  AuditAction,
  BusinessType,
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  Prisma,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  VehicleStatus,
  type Contract,
  type ContractVersion
} from "@prisma/client";

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
import { SUBSCRIPTION_CHANGE_CONFIG, SubscriptionChangeConfig } from "./subscription-change.config";
import { SubscriptionChangeError } from "./subscription-change.errors";

const CONTRACT_PDF_CJK_FONT_PATH_ENV = "CONTRACT_PDF_CJK_FONT_PATH";
const GENERATION_OPERATION = "GENERATE_VEHICLE_SWAP_CONTRACT";

const swapContractInclude = Prisma.validator<Prisma.SubscriptionChangeOrderInclude>()({
  confirmedQuote: true,
  contract: true,
  order: {
    include: {
      customer: {
        include: {
          identity: { select: { idCardNo: true } },
          profile: { select: { residenceAddress: true } }
        }
      }
    }
  },
  sourceSegment: { include: { sourceContract: true } },
  vehicleSwapDetail: {
    include: {
      sourceVehicle: true,
      targetVehicle: true
    }
  }
});

type SwapContractChange = Prisma.SubscriptionChangeOrderGetPayload<{
  include: typeof swapContractInclude;
}>;

export interface GenerateVehicleSwapContractInput {
  idempotencyKey?: string;
  version: number;
}

export interface VehicleSwapContractSnapshot {
  confirmedQuote: {
    id: string;
    quoteNo: string;
    revision: number;
  };
  originalContract: {
    contractId: string;
    contractNo: string;
  };
  order: {
    customerId: string;
    orderId: string;
    orderNo: string;
  };
  swap: {
    abnormalConditionFeeBasis: string;
    commercial: Prisma.JsonValue;
    deliveryConditions: string[];
    plannedSwapAt: string;
    returnObligations: string[];
    sourceVehicle: VehicleContractIdentity;
    targetVehicle: VehicleContractIdentity;
  };
}

interface VehicleContractIdentity {
  brand: string;
  id: string;
  model: string | null;
  modelDefinitionId: string;
  plateNo: string | null;
  vehicleNo: string;
  vin: string | null;
}

interface RenderReservation {
  change: SwapContractChange;
  commandId: string;
  contract: Contract;
  generatedAt: Date;
  kind: "render";
  snapshot: VehicleSwapContractSnapshot;
  template: ContractVersion;
}

@Injectable()
export class SubscriptionVehicleSwapContractService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly artifactWriter: ContractPdfArtifactWriterService,
    private readonly vehicleInsuranceService: VehicleInsuranceService,
    private readonly configService: ConfigService,
    @Inject(SUBSCRIPTION_CHANGE_CONFIG)
    private readonly changeConfig: SubscriptionChangeConfig
  ) {}

  async generate(
    changeOrderId: string,
    input: GenerateVehicleSwapContractInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertEnabled();
    assertPermission(actor);
    assertGenerationInput(input);
    const requestHash = commandHash({ changeOrderId, version: input.version });
    const replay = await this.findCommandResult(actor.id, input.idempotencyKey, requestHash);
    if (replay) return replay;

    const reservation = await this.reserveGeneration(changeOrderId, input, actor, requestHash);
    if (reservation.kind === "replay") return reservation.contract;

    try {
      const artifact = await this.artifactWriter.writeGeneratedContractPdfArtifact({
        cjkFontPath: this.configService.get<string>(CONTRACT_PDF_CJK_FONT_PATH_ENV),
        contractStatus: reservation.contract.status,
        existingContractFileId: reservation.contract.fileId,
        recoverExistingObject: true,
        renderModel: buildVehicleSwapPdfRenderModel(
          reservation.contract,
          reservation.change,
          reservation.template,
          reservation.snapshot,
          reservation.generatedAt
        ),
        uploadedBy: actor.id
      });
      return await this.finalizeGeneration(reservation, artifact, input, actor, context);
    } catch (error) {
      await this.abortGenerationReservation(
        reservation.commandId,
        changeOrderId,
        reservation.contract.id,
        actor.id
      );
      throw error;
    }
  }

  async startOrRetryESign<T extends { id: string }>(
    changeOrderId: string,
    input: GenerateVehicleSwapContractInput,
    actor: RequestUser,
    start: (contractId: string) => Promise<T>,
    replay: (taskId: string) => Promise<T>,
    recover?: (contractId: string) => Promise<T | null>
  ) {
    this.assertEnabled();
    assertESignPermission(actor);
    assertGenerationInput(input);
    const operation = "START_VEHICLE_SWAP_ESIGN";
    const requestHash = commandHash({ changeOrderId, version: input.version });
    const existing = await this.prisma.subscriptionChangeCommand.findUnique({
      where: {
        actorId_operation_idempotencyKey: {
          actorId: actor.id,
          idempotencyKey: input.idempotencyKey,
          operation
        }
      }
    });
    if (existing) {
      assertMatchingCommand(existing.requestHash, requestHash);
      if (existing.resourceType === "ESIGN_TASK" && existing.resourceId) {
        return replay(existing.resourceId);
      }
      if (existing.resourceType !== "ESIGN_CONTRACT" || !existing.resourceId) {
        throw generationInProgress();
      }
      const recovered = recover ? await recover(existing.resourceId) : null;
      const task = recovered ?? (await start(existing.resourceId));
      await completeESignCommand(this.prisma, existing.id, task.id, this.changeConfig.now());
      return task;
    }

    const reserved = await this.prisma.$transaction(async (tx) => {
      const command = await tx.subscriptionChangeCommand.create({
        data: {
          actorId: actor.id,
          idempotencyKey: input.idempotencyKey,
          operation,
          requestHash
        }
      });
      await lockChange(tx, changeOrderId);
      const change = await findSwapChange(tx, changeOrderId);
      if (change.version !== input.version) {
        throw conflict(
          "VERSION_CONFLICT",
          "The subscription change was updated by another request."
        );
      }
      if (
        change.status !== SubscriptionChangeStatus.SIGNING_OR_PAYMENT ||
        !change.contract ||
        !change.contract.fileId ||
        change.contract.status === ContractStatus.CANCELLED
      ) {
        throw conflict(
          "VEHICLE_SWAP_ESIGN_NOT_ALLOWED",
          "The vehicle-swap supplement is not ready for electronic signature."
        );
      }
      await tx.subscriptionChangeCommand.update({
        data: { resourceId: change.contract.id, resourceType: "ESIGN_CONTRACT" },
        where: { id: command.id }
      });
      return { commandId: command.id, contractId: change.contract.id };
    }, serializableTransaction);

    const recovered = recover ? await recover(reserved.contractId) : null;
    const task = recovered ?? (await start(reserved.contractId));
    await completeESignCommand(this.prisma, reserved.commandId, task.id, this.changeConfig.now());
    return task;
  }

  async getContractSnapshot(changeOrderId: string) {
    return buildVehicleSwapContractSnapshot(await this.findChange(changeOrderId));
  }

  private async reserveGeneration(
    changeOrderId: string,
    input: GenerateVehicleSwapContractInput & { idempotencyKey: string },
    actor: RequestUser,
    requestHash: string
  ): Promise<{ contract: Contract; kind: "replay" } | RenderReservation> {
    return this.prisma.$transaction(async (tx) => {
      const identity = {
        actorId: actor.id,
        idempotencyKey: input.idempotencyKey,
        operation: GENERATION_OPERATION
      };
      const existingCommand = await tx.subscriptionChangeCommand.findUnique({
        where: { actorId_operation_idempotencyKey: identity }
      });
      if (existingCommand) {
        assertMatchingCommand(existingCommand.requestHash, requestHash);
        if (existingCommand.resourceType === "CONTRACT" && existingCommand.resourceId) {
          return {
            contract: await findCommandContract(tx, existingCommand.resourceId),
            kind: "replay" as const
          };
        }
        throw generationInProgress();
      }
      const command = await tx.subscriptionChangeCommand.create({
        data: { ...identity, requestHash }
      });
      await lockChange(tx, changeOrderId);
      const change = await findSwapChange(tx, changeOrderId);
      if (change.version !== input.version) {
        throw conflict(
          "VERSION_CONFLICT",
          "The subscription change was updated by another request."
        );
      }
      if (change.contract && change.contract.status !== ContractStatus.CANCELLED) {
        if (!change.contract.fileId) throw generationInProgress();
        await completeGenerationCommand(
          tx,
          command.id,
          change.contract.id,
          this.changeConfig.now()
        );
        return { contract: change.contract, kind: "replay" as const };
      }
      assertGeneratable(change, this.changeConfig.now());
      const detail = requireSwapDetail(change);
      await this.vehicleInsuranceService.assertVehicleCoveredThrough(
        detail.targetVehicleId,
        detail.plannedSwapAt
      );
      const generatedAt = this.changeConfig.now();
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
          "VEHICLE_SWAP_TEMPLATE_NOT_FOUND",
          "No active subscription supplement template is available.",
          404
        );
      }
      const snapshot = buildVehicleSwapContractSnapshot(change);
      const contract = await tx.contract.create({
        data: {
          businessType: BusinessType.SUBSCRIPTION,
          contractNo: createBusinessNo("CON"),
          contractSnapshot: toJsonValue({
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
          }),
          contractTitle: `换车补充协议 ${template.versionNo}`,
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
  }

  private async finalizeGeneration(
    reservation: RenderReservation,
    artifact: ContractPdfArtifactWriteResult,
    input: GenerateVehicleSwapContractInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockCommand(tx, reservation.commandId);
      await lockChange(tx, reservation.change.id);
      const command = await tx.subscriptionChangeCommand.findUnique({
        where: { id: reservation.commandId }
      });
      if (command?.resourceType === "CONTRACT" && command.resourceId) {
        return findCommandContract(tx, command.resourceId);
      }
      if (
        !command ||
        command.resourceType !== "CONTRACT_RENDERING" ||
        command.resourceId !== reservation.contract.id
      ) {
        throw generationInProgress();
      }
      const change = await findSwapChange(tx, reservation.change.id);
      if (change.version !== input.version || change.contractId !== reservation.contract.id) {
        throw conflict("VERSION_CONFLICT", "The subscription change was updated during rendering.");
      }
      assertGeneratable(change, this.changeConfig.now());
      const contract = await tx.contract.update({
        data: {
          contractSnapshot: appendArtifact(reservation.contract.contractSnapshot, artifact),
          fileId: artifact.fileId,
          updatedBy: actor.id
        },
        where: { id: reservation.contract.id }
      });
      await tx.subscriptionChangeOrder.update({
        data: {
          status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
          updatedBy: actor.id,
          version: change.version + 1
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
            sourceVehicleId: requireSwapDetail(change).sourceVehicleId,
            targetVehicleId: requireSwapDetail(change).targetVehicleId
          },
          entityId: contract.id,
          entityType: "subscription_vehicle_swap_contract",
          ipAddress: context.ipAddress,
          module: "subscription_change",
          operatorId: actor.id,
          userAgent: context.userAgent
        },
        tx
      );
      await completeGenerationCommand(tx, command.id, contract.id, this.changeConfig.now());
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

  private async findCommandResult(actorId: string, key: string, requestHash: string) {
    const command = await this.prisma.subscriptionChangeCommand.findUnique({
      where: {
        actorId_operation_idempotencyKey: {
          actorId,
          idempotencyKey: key,
          operation: GENERATION_OPERATION
        }
      }
    });
    if (!command) return null;
    assertMatchingCommand(command.requestHash, requestHash);
    if (command.resourceType !== "CONTRACT" || !command.resourceId) {
      throw generationInProgress();
    }
    return findCommandContract(this.prisma, command.resourceId);
  }

  private findChange(changeOrderId: string) {
    return findSwapChange(this.prisma, changeOrderId);
  }

  private assertEnabled() {
    if (!this.changeConfig.enabled) {
      throw new SubscriptionChangeError(
        "SUBSCRIPTION_CHANGE_DISABLED",
        "Subscription changes are disabled.",
        503
      );
    }
  }
}

function assertGeneratable(change: SwapContractChange, now: Date) {
  const detail = requireSwapDetail(change);
  if (change.status !== SubscriptionChangeStatus.CUSTOMER_CONFIRMED) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_CUSTOMER_CONFIRMATION_REQUIRED",
      "The exact vehicle-swap quote must be confirmed before generating the supplement."
    );
  }
  if (
    !change.confirmedQuote ||
    change.confirmedQuoteId !== change.confirmedQuote.id ||
    change.confirmedQuote.status !== SubscriptionChangeQuoteStatus.CUSTOMER_CONFIRMED
  ) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_CONFIRMED_QUOTE_REQUIRED",
      "A customer-confirmed vehicle-swap quote is required."
    );
  }
  if (detail.targetVehicle.status !== VehicleStatus.REVIEW_RESERVED) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_TARGET_RESERVATION_REQUIRED",
      "The target vehicle reservation must remain valid while generating the supplement."
    );
  }
  if (now >= change.completionDeadlineAt) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_DEADLINE_PASSED",
      "The vehicle-swap completion deadline has passed."
    );
  }
  if (
    !change.sourceSegment?.sourceContract ||
    change.sourceSegment.sourceContract.status !== ContractStatus.ARCHIVED
  ) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_ORIGINAL_CONTRACT_REQUIRED",
      "An archived original contract is required for the vehicle-swap supplement."
    );
  }
  if (!change.order.customer.identity?.idCardNo?.trim()) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_CUSTOMER_ID_NUMBER_REQUIRED",
      "Customer identity information is required for the vehicle-swap supplement."
    );
  }
}

function buildVehicleSwapContractSnapshot(change: SwapContractChange): VehicleSwapContractSnapshot {
  const detail = requireSwapDetail(change);
  const quote = change.confirmedQuote;
  const original = change.sourceSegment?.sourceContract;
  if (!quote) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_CONFIRMED_QUOTE_REQUIRED",
      "A customer-confirmed vehicle-swap quote is required."
    );
  }
  if (!original) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_ORIGINAL_CONTRACT_REQUIRED",
      "An original contract is required for the vehicle-swap supplement."
    );
  }
  return {
    confirmedQuote: { id: quote.id, quoteNo: quote.quoteNo, revision: quote.revision },
    originalContract: { contractId: original.id, contractNo: original.contractNo },
    order: {
      customerId: change.order.customerId,
      orderId: change.order.id,
      orderNo: change.order.orderNo
    },
    swap: {
      abnormalConditionFeeBasis:
        "原车异状费用按原订单合同、交付车况证据、退回车况证据及经确认的费用标准计算。",
      commercial: commercialSnapshot(quote.quoteSnapshot),
      deliveryConditions: [
        "目标车辆保持有效预占且不存在阻断交付的运营限制。",
        "完成目标车辆交付查验、钥匙、行驶证及随车附件确认。"
      ],
      plannedSwapAt: detail.plannedSwapAt.toISOString(),
      returnObligations: [
        "客户应按预约时间交还原车辆并配合现场车况、里程和证据确认。",
        "客户应交还原车辆钥匙、行驶证及随车附件；争议不阻断车辆实际取回。"
      ],
      sourceVehicle: vehicleIdentity(detail.sourceVehicle),
      targetVehicle: vehicleIdentity(detail.targetVehicle)
    }
  };
}

function buildVehicleSwapPdfRenderModel(
  contract: Pick<Contract, "contractNo" | "id">,
  change: SwapContractChange,
  template: Pick<ContractVersion, "contentTemplate" | "templateName" | "versionNo">,
  snapshot: VehicleSwapContractSnapshot,
  generatedAt: Date
): ContractPdfRenderModel {
  const commercial = isRecord(snapshot.swap.commercial) ? snapshot.swap.commercial : {};
  const deltas = isRecord(commercial.deltas) ? commercial.deltas : {};
  return {
    agreementKind: "VEHICLE_SWAP_SUPPLEMENT",
    appendix: {
      sections: [
        section("Vehicle swap reference", [
          row("Original contract no.", snapshot.originalContract.contractNo),
          row("Confirmed quote no.", snapshot.confirmedQuote.quoteNo),
          row("Confirmed quote revision", snapshot.confirmedQuote.revision),
          row("Planned swap at", requireSwapDetail(change).plannedSwapAt)
        ]),
        section("Source vehicle", vehicleRows(snapshot.swap.sourceVehicle)),
        section("Target vehicle", vehicleRows(snapshot.swap.targetVehicle)),
        section("Commercial and entitlement changes", [
          row("Classification", commercial.classification),
          row("Monthly fee delta (CNY)", minorDeltaAsYuan(deltas.monthlyFeeAmount)),
          row("Deposit delta (CNY)", minorDeltaAsYuan(deltas.depositAmount)),
          row("Mileage allowance delta (km/month)", deltas.mileageLimitKm),
          row("Energy count delta", deltas.energyLimitCount),
          row("Energy kWh delta", deltas.energyLimitKwh)
        ]),
        section("Return and delivery obligations", [
          ...snapshot.swap.returnObligations.map((value, index) =>
            row(`Return ${index + 1}`, value)
          ),
          ...snapshot.swap.deliveryConditions.map((value, index) =>
            row(`Delivery ${index + 1}`, value)
          ),
          row("Abnormal-condition fee basis", snapshot.swap.abnormalConditionFeeBasis)
        ])
      ]
    },
    contentTemplate: template.contentTemplate,
    contractId: contract.id,
    contractNo: contract.contractNo,
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
    swapTerms: {
      confirmedQuoteNo: snapshot.confirmedQuote.quoteNo,
      depositDeltaAmount: deltaString(deltas.depositAmount),
      mileageLimitDeltaKm: deltaString(deltas.mileageLimitKm),
      monthlyFeeDeltaAmount: deltaString(deltas.monthlyFeeAmount),
      plannedSwapAt: requireSwapDetail(change).plannedSwapAt,
      sourceVehicleNo: snapshot.swap.sourceVehicle.vehicleNo,
      targetVehicleNo: snapshot.swap.targetVehicle.vehicleNo
    },
    templateName: template.templateName,
    templateVersion: template.versionNo
  };
}

function requireSwapDetail(change: SwapContractChange) {
  if (change.changeType !== SubscriptionChangeType.VEHICLE_SWAP || !change.vehicleSwapDetail) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_CHANGE_REQUIRED",
      "This operation requires a vehicle-swap subscription change."
    );
  }
  return change.vehicleSwapDetail;
}

async function findSwapChange(
  client: PrismaService | Prisma.TransactionClient,
  changeOrderId: string
) {
  const change = await client.subscriptionChangeOrder.findUnique({
    include: swapContractInclude,
    where: { id: changeOrderId }
  });
  if (!change) {
    throw new SubscriptionChangeError(
      "SUBSCRIPTION_CHANGE_NOT_FOUND",
      "Subscription change order was not found.",
      404
    );
  }
  requireSwapDetail(change);
  return change;
}

function commercialSnapshot(quoteSnapshot: Prisma.JsonValue) {
  return isRecord(quoteSnapshot) && isRecord(quoteSnapshot.commercialSnapshot)
    ? (quoteSnapshot.commercialSnapshot as Prisma.JsonObject)
    : ({} as Prisma.JsonObject);
}

function vehicleIdentity(
  vehicle: SwapContractChange["vehicleSwapDetail"] extends infer Detail
    ? Detail extends { sourceVehicle: infer Vehicle }
      ? Vehicle
      : never
    : never
): VehicleContractIdentity {
  return {
    brand: vehicle.brand,
    id: vehicle.id,
    model: vehicle.model,
    modelDefinitionId: vehicle.modelDefinitionId,
    plateNo: vehicle.plateNo,
    vehicleNo: vehicle.vehicleNo,
    vin: vehicle.vin
  };
}

function vehicleRows(vehicle: VehicleContractIdentity) {
  return [
    row("Vehicle no.", vehicle.vehicleNo),
    row("VIN", vehicle.vin),
    row("Brand/model", [vehicle.brand, vehicle.model].filter(Boolean).join(" ")),
    row("Plate no.", maskPlate(vehicle.plateNo))
  ];
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

function minorDeltaAsYuan(value: unknown) {
  const raw = deltaString(value);
  if (!/^-?\d+$/.test(raw)) return raw;
  const amount = BigInt(raw);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function deltaString(value: unknown) {
  return value === null || value === undefined ? "0" : String(value);
}

function maskPlate(value: string | null) {
  if (!value) return null;
  if (value.length <= 3) return "***";
  return `${value.slice(0, 2)}***${value.slice(-1)}`;
}

function appendArtifact(
  snapshot: Prisma.InputJsonValue | Prisma.JsonValue,
  artifact: ContractPdfArtifactWriteResult
) {
  const base = isRecord(snapshot) ? snapshot : {};
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

function assertPermission(actor: RequestUser) {
  if (
    !actor.roles.includes("ADMIN") &&
    !actor.permissions.includes(PermissionCode.CONTRACT_GENERATE)
  ) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_CONTRACT_FORBIDDEN",
      "Contract generation permission is required.",
      403
    );
  }
}

function assertESignPermission(actor: RequestUser) {
  if (
    !actor.roles.includes("ADMIN") &&
    !actor.permissions.includes(PermissionCode.SUBSCRIPTION_CHANGE_ESIGN_RETRY)
  ) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_ESIGN_FORBIDDEN",
      "Subscription-change e-sign permission is required.",
      403
    );
  }
}

function assertGenerationInput(
  input: GenerateVehicleSwapContractInput
): asserts input is GenerateVehicleSwapContractInput & { idempotencyKey: string } {
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
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
      "The Idempotency-Key was already used with a different request."
    );
  }
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

async function completeESignCommand(
  client: Pick<Prisma.TransactionClient, "subscriptionChangeCommand">,
  commandId: string,
  taskId: string,
  completedAt: Date
) {
  await client.subscriptionChangeCommand.update({
    data: { completedAt, resourceId: taskId, resourceType: "ESIGN_TASK" },
    where: { id: commandId }
  });
}

async function findCommandContract(
  client: Pick<Prisma.TransactionClient, "contract">,
  contractId: string
) {
  const contract = await client.contract.findUnique({ where: { id: contractId } });
  if (!contract)
    throw conflict("IDEMPOTENCY_RESOURCE_MISSING", "The generated contract is missing.");
  return contract;
}

async function lockChange(tx: Prisma.TransactionClient, id: string) {
  if (typeof tx.$queryRaw !== "function") return;
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "subscription_change_order" WHERE "id" = ${id}::uuid FOR UPDATE`
  );
}

async function lockCommand(tx: Prisma.TransactionClient, id: string) {
  if (typeof tx.$queryRaw !== "function") return;
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "subscription_change_command" WHERE "id" = ${id}::uuid FOR UPDATE`
  );
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

function toJsonValue(value: unknown) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))
  ) as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function conflict(code: string, message: string) {
  return new SubscriptionChangeError(code, message, 409);
}

function generationInProgress() {
  return conflict(
    "IDEMPOTENCY_COMMAND_IN_PROGRESS",
    "The idempotent vehicle-swap contract command has not completed."
  );
}

const serializableTransaction = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable
};
