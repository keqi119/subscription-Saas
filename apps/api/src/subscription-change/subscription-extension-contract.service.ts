import { Inject, Injectable, Optional } from "@nestjs/common";
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
  SubscriptionChangeStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
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

const CONTRACT_PDF_CJK_FONT_PATH_ENV = "CONTRACT_PDF_CJK_FONT_PATH";

const extensionContractInclude = Prisma.validator<Prisma.SubscriptionChangeOrderInclude>()({
  confirmedQuote: true,
  contract: true,
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

@Injectable()
export class SubscriptionExtensionContractService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly artifactWriter: ContractPdfArtifactWriterService,
    private readonly vehicleInsuranceService: VehicleInsuranceService,
    private readonly configService: ConfigService,
    @Optional() @Inject(SUBSCRIPTION_EXTENSION_NOW)
    private readonly nowProvider?: () => Date
  ) {}

  async generate(changeOrderId: string, actor: RequestUser, context: RequestContext) {
    assertPermission(actor);
    const change = await this.findChange(changeOrderId);
    if (change.contract && change.contract.status !== ContractStatus.CANCELLED) {
      return change.contract;
    }
    assertGeneratable(change, this.now());

    const snapshot = buildExtensionContractSnapshot(change);
    await this.vehicleInsuranceService.assertVehicleCoveredThrough(
      change.order.vehicleId!,
      change.targetEndDate
    );

    const generatedAt = this.now();
    const template = await this.prisma.contractVersion.findFirst({
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
      contentTemplate: template.contentTemplate,
      generatedAt: generatedAt.toISOString(),
      template: {
        id: template.id,
        name: template.templateName,
        type: template.templateType,
        version: template.versionNo
      }
    });
    const created = await withUniqueBusinessNoRetry(() =>
      this.prisma.contract.create({
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
      })
    );

    try {
      const artifact = await this.artifactWriter.writeGeneratedContractPdfArtifact({
        cjkFontPath: this.configService.get<string>(CONTRACT_PDF_CJK_FONT_PATH_ENV),
        contractStatus: created.status,
        existingContractFileId: created.fileId,
        renderModel: buildExtensionPdfRenderModel(
          created,
          change,
          template,
          snapshot,
          generatedAt
        ),
        uploadedBy: actor.id
      });

      const result = await this.prisma.$transaction(async (tx) => {
        const contract = await tx.contract.update({
          data: {
            contractSnapshot: appendArtifact(contractSnapshot, artifact),
            fileId: artifact.fileId,
            updatedBy: actor.id
          },
          where: { id: created.id }
        });
        await tx.subscriptionChangeOrder.update({
          data: {
            contractId: contract.id,
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
        return contract;
      });

      await this.auditService.write({
        action: AuditAction.CREATE,
        after: {
          changeOrderId: change.id,
          contractId: result.id,
          contractNo: result.contractNo,
          originalContractId: snapshot.originalContract.contractId
        },
        entityId: result.id,
        entityType: "subscription_extension_contract",
        ipAddress: context.ipAddress,
        module: "subscription_change",
        operatorId: actor.id,
        userAgent: context.userAgent
      });
      return result;
    } catch (error) {
      await this.cancelAfterFailure(created.id, actor.id);
      throw error;
    }
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
    return change;
  }

  private async cancelAfterFailure(contractId: string, actorId: string) {
    try {
      await this.prisma.contract.update({
        data: { status: ContractStatus.CANCELLED, updatedBy: actorId },
        where: { id: contractId }
      });
    } catch {
      // Preserve the original artifact or persistence error for the caller.
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

function assertGeneratable(change: ExtensionContractChange, now: Date) {
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

function buildExtensionContractSnapshot(change: ExtensionContractChange): ExtensionContractSnapshot {
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
  change: ExtensionContractChange,
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
  snapshot: Prisma.InputJsonValue,
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

function isJsonObject(value: Prisma.InputJsonValue): value is Prisma.InputJsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)
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
