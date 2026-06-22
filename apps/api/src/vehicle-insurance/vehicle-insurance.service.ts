import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  InsuranceClaimStatus,
  Prisma,
  ServiceCaseType,
  VehicleDocument,
  VehicleDocumentStatus,
  VehicleInsurancePolicyStatus
} from "@prisma/client";
import type { Readable } from "node:stream";

import { RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import {
  CreateInsuranceClaimDto,
  CreateVehicleInsurancePolicyDto,
  InsuranceClaimsQueryDto,
  PutVehicleInsuranceCoveragesDto,
  UpdateInsuranceClaimDto,
  UpdateInsuranceClaimStatusDto,
  UpdateVehicleDocumentDto,
  UpdateVehicleInsurancePolicyDto,
  UploadVehicleDocumentDto,
  VehicleInsuranceCoverageInputDto,
  VehicleInsurancePoliciesQueryDto
} from "./dto/vehicle-insurance.dto";

export interface UploadedVehicleDocumentFile {
  buffer: Buffer;
  mimetype?: string;
  originalname: string;
  size: number;
}

export interface VehicleDocumentPreview {
  filename: string;
  mimeType?: string | null;
  sizeBytes: number;
  stream: Readable;
}

const policyInclude = {
  claims: {
    orderBy: { createdAt: "desc" as const },
    select: {
      claimNo: true,
      claimStatus: true,
      id: true,
      insurerClaimNo: true
    },
    where: { deletedAt: null }
  },
  coverages: {
    orderBy: { createdAt: "asc" as const },
    where: { deletedAt: null }
  },
  documents: {
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  vehicle: {
    select: {
      brand: true,
      id: true,
      model: true,
      plateNo: true,
      series: true,
      vehicleNo: true
    }
  }
} satisfies Prisma.VehicleInsurancePolicyInclude;

const documentInclude = {
  policy: {
    select: {
      id: true,
      insurerName: true,
      policyNo: true,
      policyType: true
    }
  },
  vehicle: {
    select: {
      brand: true,
      id: true,
      model: true,
      plateNo: true,
      series: true,
      vehicleNo: true
    }
  }
} satisfies Prisma.VehicleDocumentInclude;

const claimInclude = {
  customer: {
    select: {
      customerNo: true,
      id: true,
      mobile: true,
      name: true
    }
  },
  order: {
    select: {
      id: true,
      orderNo: true,
      orderStatus: true
    }
  },
  policy: {
    select: {
      id: true,
      insurerName: true,
      policyNo: true,
      policyType: true
    }
  },
  serviceCase: {
    select: {
      caseNo: true,
      caseStatus: true,
      caseType: true,
      id: true,
      insuranceReportNo: true,
      occurredAt: true
    }
  },
  vehicle: {
    select: {
      brand: true,
      id: true,
      model: true,
      plateNo: true,
      series: true,
      vehicleNo: true
    }
  }
} satisfies Prisma.InsuranceClaimInclude;

type PolicyWithRelations = Prisma.VehicleInsurancePolicyGetPayload<{ include: typeof policyInclude }>;
type DocumentWithRelations = Prisma.VehicleDocumentGetPayload<{ include: typeof documentInclude }>;
type ClaimWithRelations = Prisma.InsuranceClaimGetPayload<{ include: typeof claimInclude }>;

@Injectable()
export class VehicleInsuranceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService
  ) {}

  async listPolicies(query: VehicleInsurancePoliciesQueryDto) {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.VehicleInsurancePolicyWhereInput = {
      deletedAt: null,
      policyStatus: query.policyStatus,
      policyType: query.policyType,
      vehicleId: query.vehicleId
    };

    const effectiveTo = buildDateRange(query.effectiveToFrom, query.effectiveToTo, "effectiveTo");
    if (query.expiringWithinDays !== undefined) {
      const today = startOfUtcDay(new Date());
      effectiveTo.gte = today;
      effectiveTo.lte = addDays(today, query.expiringWithinDays);
    }
    if (Object.keys(effectiveTo).length > 0) {
      where.effectiveTo = effectiveTo;
    }

    const [total, items] = await Promise.all([
      this.prisma.vehicleInsurancePolicy.count({ where }),
      this.prisma.vehicleInsurancePolicy.findMany({
        include: policyInclude,
        orderBy: [{ effectiveTo: "asc" }, { createdAt: "desc" }],
        skip,
        take: pageSize,
        where
      })
    ]);

    return {
      items: items.map(toPolicyView),
      page,
      pageSize,
      total
    };
  }

  async getPolicy(id: string) {
    return toPolicyView(await this.findPolicyOrThrow(id));
  }

  async createPolicy(vehicleId: string, dto: CreateVehicleInsurancePolicyDto, user: RequestUser) {
    await this.findVehicleOrThrow(vehicleId);
    const policyNo = normalizeRequiredText(dto.policyNo, "policyNo");
    const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
    const effectiveTo = parseDateOnly(dto.effectiveTo, "effectiveTo");
    assertDateOrder(effectiveFrom, effectiveTo);

    const policy = await this.prisma.vehicleInsurancePolicy.create({
      data: {
        ...buildPolicyCreateData(dto, user.id, effectiveFrom, effectiveTo),
        policyNo,
        vehicleId,
        coverages: dto.coverages?.length
          ? {
              create: dto.coverages.map(buildCoverageCreateData)
            }
          : undefined
      },
      include: policyInclude
    });

    return toPolicyView(policy);
  }

  async updatePolicy(id: string, dto: UpdateVehicleInsurancePolicyDto, user: RequestUser) {
    const before = await this.findPolicyOrThrow(id);
    const data = buildPolicyUpdateData(dto, user.id);

    if (dto.effectiveFrom !== undefined || dto.effectiveTo !== undefined) {
      const effectiveFrom = parseDateOnly(dto.effectiveFrom ?? toIsoDate(before.effectiveFrom)!, "effectiveFrom");
      const effectiveTo = parseDateOnly(dto.effectiveTo ?? toIsoDate(before.effectiveTo)!, "effectiveTo");
      assertDateOrder(effectiveFrom, effectiveTo);
      data.effectiveFrom = effectiveFrom;
      data.effectiveTo = effectiveTo;
    }

    if (dto.policyNo !== undefined) {
      data.policyNo = normalizeRequiredText(dto.policyNo, "policyNo");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleInsurancePolicy.update({
        data,
        where: { id }
      });
      if (dto.coverages !== undefined) {
        await replaceCoverages(tx, id, dto.coverages);
      }
    });

    return this.getPolicy(id);
  }

  async archivePolicy(id: string, user: RequestUser) {
    await this.findPolicyOrThrow(id);
    const policy = await this.prisma.vehicleInsurancePolicy.update({
      data: {
        policyStatus: VehicleInsurancePolicyStatus.ARCHIVED,
        updatedBy: user.id
      },
      include: policyInclude,
      where: { id }
    });
    return toPolicyView(policy);
  }

  async putCoverages(id: string, dto: PutVehicleInsuranceCoveragesDto) {
    await this.findPolicyOrThrow(id);
    await this.prisma.$transaction((tx) => replaceCoverages(tx, id, dto.coverages));
    return this.getPolicy(id);
  }

  async listDocuments(vehicleId: string) {
    await this.findVehicleOrThrow(vehicleId);
    const documents = await this.prisma.vehicleDocument.findMany({
      include: documentInclude,
      orderBy: [{ createdAt: "desc" }],
      where: {
        deletedAt: null,
        vehicleId
      }
    });
    return documents.map(toDocumentView);
  }

  async uploadDocument(
    vehicleId: string,
    dto: UploadVehicleDocumentDto,
    files: UploadedVehicleDocumentFile[] | undefined,
    user: RequestUser
  ) {
    await this.findVehicleOrThrow(vehicleId);
    await this.validatePolicyForVehicle(vehicleId, dto.policyId);
    const file = (files ?? []).find((item) => item.buffer?.length);
    if (!file) {
      throw new BadRequestException("vehicle document file is required");
    }
    assertSupportedVehicleDocumentFile(file);

    const stored = await this.storageService.putVehicleDocument({
      buffer: file.buffer,
      contentType: file.mimetype,
      metadata: { originalName: file.originalname },
      originalName: file.originalname,
      vehicleId
    });

    const document = await this.prisma.vehicleDocument.create({
      data: {
        bucket: stored.bucket,
        customerVisible: dto.customerVisible ?? false,
        description: normalizeOptionalText(dto.description),
        documentType: dto.documentType,
        effectiveFrom: parseOptionalDateOnly(dto.effectiveFrom, "effectiveFrom"),
        effectiveTo: parseOptionalDateOnly(dto.effectiveTo, "effectiveTo"),
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype ?? null,
        objectKey: stored.objectKey,
        originalName: file.originalname,
        policyId: normalizeOptionalText(dto.policyId),
        title: normalizeOptionalText(dto.title),
        uploadedBy: user.id,
        vehicleId
      },
      include: documentInclude
    });

    return toDocumentView(document);
  }

  async updateDocument(id: string, dto: UpdateVehicleDocumentDto) {
    const before = await this.findDocumentOrThrow(id);
    if (dto.policyId !== undefined) {
      await this.validatePolicyForVehicle(before.vehicleId, dto.policyId);
    }

    const data: Prisma.VehicleDocumentUncheckedUpdateInput = {};
    assignIfDefined(data, "customerVisible", dto.customerVisible);
    assignIfDefined(data, "description", normalizeOptionalText(dto.description));
    assignIfDefined(data, "documentStatus", dto.documentStatus);
    assignIfDefined(data, "documentType", dto.documentType);
    assignIfDefined(data, "effectiveFrom", parseOptionalDateOnly(dto.effectiveFrom, "effectiveFrom"));
    assignIfDefined(data, "effectiveTo", parseOptionalDateOnly(dto.effectiveTo, "effectiveTo"));
    assignIfDefined(data, "policyId", normalizeOptionalText(dto.policyId));
    assignIfDefined(data, "title", normalizeOptionalText(dto.title));

    const document = await this.prisma.vehicleDocument.update({
      data,
      include: documentInclude,
      where: { id }
    });
    return toDocumentView(document);
  }

  async deleteDocument(id: string) {
    await this.findDocumentOrThrow(id);
    const document = await this.prisma.vehicleDocument.update({
      data: {
        customerVisible: false,
        deletedAt: new Date(),
        documentStatus: VehicleDocumentStatus.ARCHIVED
      },
      include: documentInclude,
      where: { id }
    });
    return toDocumentView(document);
  }

  async previewDocument(id: string): Promise<VehicleDocumentPreview> {
    const document = await this.findDocumentOrThrow(id);
    return this.buildDocumentPreview(document);
  }

  async listClaims(query: InsuranceClaimsQueryDto) {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.InsuranceClaimWhereInput = {
      claimStatus: query.claimStatus,
      customerId: query.customerId,
      deletedAt: null,
      orderId: query.orderId,
      serviceCaseId: query.serviceCaseId,
      vehicleId: query.vehicleId
    };
    const [total, items] = await Promise.all([
      this.prisma.insuranceClaim.count({ where }),
      this.prisma.insuranceClaim.findMany({
        include: claimInclude,
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: pageSize,
        where
      })
    ]);

    return {
      items: items.map(toClaimView),
      page,
      pageSize,
      total
    };
  }

  async getClaim(id: string) {
    return toClaimView(await this.findClaimOrThrow(id));
  }

  async createClaimFromServiceCase(serviceCaseId: string, dto: CreateInsuranceClaimDto, user: RequestUser) {
    const serviceCase = await this.prisma.serviceCase.findFirst({
      include: {
        customer: { select: { customerNo: true, id: true, mobile: true, name: true } },
        order: { select: { id: true, orderNo: true, vehicleId: true } },
        vehicle: { select: { id: true, vehicleNo: true } }
      },
      where: {
        deletedAt: null,
        id: serviceCaseId
      }
    });

    if (!serviceCase) {
      throw new NotFoundException("service case not found");
    }
    if (serviceCase.caseType !== ServiceCaseType.ACCIDENT_REPORT) {
      throw new BadRequestException("insurance claim can only be created from accident service case");
    }

    const vehicleId = serviceCase.vehicleId ?? serviceCase.order?.vehicleId;
    if (!vehicleId) {
      throw new BadRequestException("service case has no vehicle to claim");
    }
    await this.validatePolicyForVehicle(vehicleId, dto.policyId);

    const useAutoNo = !normalizeOptionalText(dto.claimNo);
    const claim = await withUniqueBusinessNoRetry(() =>
      this.prisma.insuranceClaim.create({
        data: {
          accidentAt: parseOptionalDateTime(dto.accidentAt ?? serviceCase.occurredAt?.toISOString(), "accidentAt"),
          claimNo: useAutoNo ? createBusinessNo("IC") : normalizeRequiredText(dto.claimNo, "claimNo"),
          claimStatus: dto.claimStatus ?? InsuranceClaimStatus.DRAFT,
          createdBy: user.id,
          customerId: serviceCase.customerId,
          estimatedAmount: moneyOrNull(dto.estimatedAmount),
          insurerClaimNo: normalizeOptionalText(dto.insurerClaimNo),
          orderId: serviceCase.orderId,
          policyId: normalizeOptionalText(dto.policyId),
          remark: normalizeOptionalText(dto.remark),
          serviceCaseId,
          snapshot: {
            createdFrom: "SERVICE_CASE",
            serviceCaseNo: serviceCase.caseNo
          },
          submittedAt: parseOptionalDateTime(dto.submittedAt, "submittedAt"),
          updatedBy: user.id,
          vehicleId
        },
        include: claimInclude
      })
    );

    return toClaimView(await this.applyClaimStatusTimestamps(claim.id, claim.claimStatus, user.id));
  }

  async updateClaim(id: string, dto: UpdateInsuranceClaimDto, user: RequestUser) {
    const before = await this.findClaimOrThrow(id);
    if (dto.policyId !== undefined) {
      await this.validatePolicyForVehicle(before.vehicleId, dto.policyId);
    }

    const data: Prisma.InsuranceClaimUncheckedUpdateInput = {
      updatedBy: user.id
    };
    assignIfDefined(data, "accidentAt", parseOptionalDateTime(dto.accidentAt, "accidentAt"));
    assignIfDefined(data, "acceptedAt", parseOptionalDateTime(dto.acceptedAt, "acceptedAt"));
    assignIfDefined(data, "approvedAmount", moneyOrNull(dto.approvedAmount));
    assignIfDefined(data, "claimStatus", dto.claimStatus);
    assignIfDefined(data, "closedAt", parseOptionalDateTime(dto.closedAt, "closedAt"));
    assignIfDefined(data, "estimatedAmount", moneyOrNull(dto.estimatedAmount));
    assignIfDefined(data, "insurerClaimNo", normalizeOptionalText(dto.insurerClaimNo));
    assignIfDefined(data, "paidAmount", moneyOrNull(dto.paidAmount));
    assignIfDefined(data, "policyId", normalizeOptionalText(dto.policyId));
    assignIfDefined(data, "remark", normalizeOptionalText(dto.remark));
    assignIfDefined(data, "submittedAt", parseOptionalDateTime(dto.submittedAt, "submittedAt"));

    await this.prisma.insuranceClaim.update({
      data,
      where: { id }
    });

    if (dto.claimStatus) {
      return toClaimView(await this.applyClaimStatusTimestamps(id, dto.claimStatus, user.id));
    }

    return this.getClaim(id);
  }

  async updateClaimStatus(id: string, dto: UpdateInsuranceClaimStatusDto, user: RequestUser) {
    await this.findClaimOrThrow(id);
    const claim = await this.applyClaimStatusTimestamps(id, dto.claimStatus, user.id, dto.remark);
    return toClaimView(claim);
  }

  async buildPortalOrderDocuments(orderId: string, customerId: string) {
    const order = await this.prisma.subscriptionOrder.findFirst({
      select: {
        id: true,
        vehicleId: true
      },
      where: {
        customerId,
        deletedAt: null,
        id: orderId
      }
    });

    if (!order) {
      throw new NotFoundException("order not found");
    }
    if (!order.vehicleId) {
      return [];
    }

    const documents = await this.prisma.vehicleDocument.findMany({
      include: documentInclude,
      orderBy: [{ documentType: "asc" }, { createdAt: "desc" }],
      where: {
        customerVisible: true,
        deletedAt: null,
        documentStatus: VehicleDocumentStatus.ACTIVE,
        vehicleId: order.vehicleId
      }
    });

    return documents.map((document) => toPortalDocumentView(document, order.id));
  }

  async previewPortalOrderDocument(orderId: string, documentId: string, customerId: string) {
    const order = await this.prisma.subscriptionOrder.findFirst({
      select: {
        id: true,
        vehicleId: true
      },
      where: {
        customerId,
        deletedAt: null,
        id: orderId
      }
    });

    if (!order?.vehicleId) {
      throw new NotFoundException("order document not found");
    }

    const document = await this.prisma.vehicleDocument.findFirst({
      where: {
        customerVisible: true,
        deletedAt: null,
        documentStatus: VehicleDocumentStatus.ACTIVE,
        id: documentId,
        vehicleId: order.vehicleId
      }
    });

    if (!document) {
      throw new NotFoundException("order document not found");
    }

    return this.buildDocumentPreview(document);
  }

  private async findVehicleOrThrow(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        deletedAt: null,
        id: vehicleId
      }
    });
    if (!vehicle) {
      throw new NotFoundException("vehicle not found");
    }
    return vehicle;
  }

  private async findPolicyOrThrow(id: string) {
    const policy = await this.prisma.vehicleInsurancePolicy.findFirst({
      include: policyInclude,
      where: {
        deletedAt: null,
        id
      }
    });
    if (!policy) {
      throw new NotFoundException("vehicle insurance policy not found");
    }
    return policy;
  }

  private async findDocumentOrThrow(id: string) {
    const document = await this.prisma.vehicleDocument.findFirst({
      include: documentInclude,
      where: {
        deletedAt: null,
        id
      }
    });
    if (!document) {
      throw new NotFoundException("vehicle document not found");
    }
    return document;
  }

  private async findClaimOrThrow(id: string) {
    const claim = await this.prisma.insuranceClaim.findFirst({
      include: claimInclude,
      where: {
        deletedAt: null,
        id
      }
    });
    if (!claim) {
      throw new NotFoundException("insurance claim not found");
    }
    return claim;
  }

  private async validatePolicyForVehicle(vehicleId: string, policyId?: string | null) {
    const normalized = normalizeOptionalText(policyId);
    if (!normalized) {
      return null;
    }
    const policy = await this.prisma.vehicleInsurancePolicy.findFirst({
      where: {
        deletedAt: null,
        id: normalized,
        vehicleId
      }
    });
    if (!policy) {
      throw new BadRequestException("policy must belong to the same vehicle");
    }
    return policy;
  }

  private async buildDocumentPreview(document: Pick<VehicleDocument, "bucket" | "fileName" | "fileSize" | "mimeType" | "objectKey" | "originalName">) {
    if (!document.bucket || !document.objectKey) {
      throw new NotFoundException("vehicle document object is missing");
    }
    const downloaded = await this.storageService.getVehicleDocumentStream(document.bucket, document.objectKey);
    return {
      filename: document.originalName ?? document.fileName,
      mimeType: downloaded.contentType ?? document.mimeType,
      sizeBytes: downloaded.contentLength ?? document.fileSize ?? 0,
      stream: downloaded.stream
    };
  }

  private async applyClaimStatusTimestamps(
    id: string,
    claimStatus: InsuranceClaimStatus,
    userId: string,
    remark?: string | null
  ) {
    const now = new Date();
    const data: Prisma.InsuranceClaimUncheckedUpdateInput = {
      claimStatus,
      updatedBy: userId
    };
    if (remark !== undefined) {
      data.remark = normalizeOptionalText(remark);
    }
    if (claimStatus === InsuranceClaimStatus.SUBMITTED) {
      data.submittedAt = now;
    }
    if (claimStatus === InsuranceClaimStatus.ACCEPTED || claimStatus === InsuranceClaimStatus.IN_PROGRESS) {
      data.acceptedAt = now;
    }
    if (
      claimStatus === InsuranceClaimStatus.CLOSED ||
      claimStatus === InsuranceClaimStatus.SETTLED ||
      claimStatus === InsuranceClaimStatus.REJECTED ||
      claimStatus === InsuranceClaimStatus.CANCELLED
    ) {
      data.closedAt = now;
    }
    return this.prisma.insuranceClaim.update({
      data,
      include: claimInclude,
      where: { id }
    });
  }
}

async function replaceCoverages(
  tx: Prisma.TransactionClient,
  policyId: string,
  coverages: VehicleInsuranceCoverageInputDto[]
) {
  await tx.vehicleInsuranceCoverage.updateMany({
    data: { deletedAt: new Date() },
    where: {
      deletedAt: null,
      policyId
    }
  });
  if (coverages.length > 0) {
    await tx.vehicleInsuranceCoverage.createMany({
      data: coverages.map((coverage) => ({
        coverageName: normalizeOptionalText(coverage.coverageName),
        coverageType: coverage.coverageType,
        deductibleAmount: moneyOrNull(coverage.deductibleAmount),
        insuredAmount: moneyOrNull(coverage.insuredAmount),
        policyId,
        remark: normalizeOptionalText(coverage.remark)
      }))
    });
  }
}

function buildPolicyCreateData(
  dto: CreateVehicleInsurancePolicyDto,
  userId: string,
  effectiveFrom: Date,
  effectiveTo: Date
): Omit<Prisma.VehicleInsurancePolicyUncheckedCreateInput, "policyNo" | "vehicleId"> {
  return {
    currency: normalizeOptionalText(dto.currency) ?? "CNY",
    effectiveFrom,
    effectiveTo,
    insuredAmount: moneyOrNull(dto.insuredAmount),
    insuredName: normalizeOptionalText(dto.insuredName),
    insurerName: normalizeOptionalText(dto.insurerName),
    policyHolderName: normalizeOptionalText(dto.policyHolderName),
    policyStatus: dto.policyStatus ?? VehicleInsurancePolicyStatus.ACTIVE,
    policyType: dto.policyType,
    premiumAmount: moneyOrNull(dto.premiumAmount),
    remark: normalizeOptionalText(dto.remark),
    renewalReminderAt: parseOptionalDateTime(dto.renewalReminderAt, "renewalReminderAt"),
    snapshot: {
      source: "BACK_OFFICE",
      stage: "10M-B"
    },
    createdBy: userId,
    updatedBy: userId
  };
}

function buildPolicyUpdateData(dto: UpdateVehicleInsurancePolicyDto, userId: string) {
  const data: Prisma.VehicleInsurancePolicyUncheckedUpdateInput = {
    updatedBy: userId
  };
  assignIfDefined(data, "currency", normalizeOptionalText(dto.currency));
  assignIfDefined(data, "insuredAmount", moneyOrNull(dto.insuredAmount));
  assignIfDefined(data, "insuredName", normalizeOptionalText(dto.insuredName));
  assignIfDefined(data, "insurerName", normalizeOptionalText(dto.insurerName));
  assignIfDefined(data, "policyHolderName", normalizeOptionalText(dto.policyHolderName));
  assignIfDefined(data, "policyStatus", dto.policyStatus);
  assignIfDefined(data, "policyType", dto.policyType);
  assignIfDefined(data, "premiumAmount", moneyOrNull(dto.premiumAmount));
  assignIfDefined(data, "remark", normalizeOptionalText(dto.remark));
  assignIfDefined(data, "renewalReminderAt", parseOptionalDateTime(dto.renewalReminderAt, "renewalReminderAt"));
  return data;
}

function buildCoverageCreateData(coverage: VehicleInsuranceCoverageInputDto) {
  return {
    coverageName: normalizeOptionalText(coverage.coverageName),
    coverageType: coverage.coverageType,
    deductibleAmount: moneyOrNull(coverage.deductibleAmount),
    insuredAmount: moneyOrNull(coverage.insuredAmount),
    remark: normalizeOptionalText(coverage.remark)
  };
}

function toPolicyView(policy: PolicyWithRelations) {
  const daysUntilExpiry = differenceInDays(startOfUtcDay(new Date()), startOfUtcDay(policy.effectiveTo));
  return {
    claimCount: policy.claims.length,
    coverages: policy.coverages.map(toCoverageView),
    createdAt: policy.createdAt,
    createdBy: policy.createdBy,
    currency: policy.currency,
    daysUntilExpiry,
    documents: policy.documents.map(toPolicyDocumentView),
    documentCount: policy.documents.length,
    effectiveFrom: toIsoDate(policy.effectiveFrom),
    effectiveTo: toIsoDate(policy.effectiveTo),
    id: policy.id,
    insuredAmount: numberOrNull(policy.insuredAmount),
    insuredName: policy.insuredName,
    insurerName: policy.insurerName,
    isExpiringSoon: daysUntilExpiry >= 0 && daysUntilExpiry <= 30,
    policyHolderName: policy.policyHolderName,
    policyNo: policy.policyNo,
    policyStatus: policy.policyStatus,
    policyType: policy.policyType,
    premiumAmount: numberOrNull(policy.premiumAmount),
    remark: policy.remark,
    renewalReminderAt: toIsoDateTime(policy.renewalReminderAt),
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy,
    vehicle: toVehicleBrief(policy.vehicle),
    vehicleId: policy.vehicleId
  };
}

function toCoverageView(coverage: {
  coverageName: string | null;
  coverageType: string;
  deductibleAmount: bigint | null;
  id: string;
  insuredAmount: bigint | null;
  policyId: string;
  remark: string | null;
}) {
  return {
    coverageName: coverage.coverageName,
    coverageType: coverage.coverageType,
    deductibleAmount: numberOrNull(coverage.deductibleAmount),
    id: coverage.id,
    insuredAmount: numberOrNull(coverage.insuredAmount),
    policyId: coverage.policyId,
    remark: coverage.remark
  };
}

function toPolicyDocumentView(document: {
  createdAt: Date;
  customerVisible: boolean;
  description: string | null;
  documentStatus: string;
  documentType: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  fileName: string;
  fileSize: number | null;
  id: string;
  mimeType: string | null;
  originalName: string | null;
  policyId: string | null;
  title: string | null;
  updatedAt: Date;
  uploadedBy: string | null;
  vehicleId: string;
}) {
  return {
    createdAt: document.createdAt,
    customerVisible: document.customerVisible,
    description: document.description,
    documentStatus: document.documentStatus,
    documentType: document.documentType,
    effectiveFrom: toIsoDate(document.effectiveFrom),
    effectiveTo: toIsoDate(document.effectiveTo),
    fileName: document.fileName,
    fileSize: document.fileSize,
    id: document.id,
    mimeType: document.mimeType,
    originalName: document.originalName,
    policyId: document.policyId,
    previewUrl: `/api/vehicle-documents/${document.id}/preview`,
    title: document.title,
    updatedAt: document.updatedAt,
    uploadedBy: document.uploadedBy,
    vehicleId: document.vehicleId
  };
}

function toDocumentView(document: DocumentWithRelations) {
  return {
    createdAt: document.createdAt,
    customerVisible: document.customerVisible,
    description: document.description,
    documentStatus: document.documentStatus,
    documentType: document.documentType,
    effectiveFrom: toIsoDate(document.effectiveFrom),
    effectiveTo: toIsoDate(document.effectiveTo),
    fileName: document.fileName,
    fileSize: document.fileSize,
    id: document.id,
    mimeType: document.mimeType,
    originalName: document.originalName,
    policy: document.policy,
    policyId: document.policyId,
    previewUrl: `/api/vehicle-documents/${document.id}/preview`,
    title: document.title,
    updatedAt: document.updatedAt,
    uploadedBy: document.uploadedBy,
    vehicle: toVehicleBrief(document.vehicle),
    vehicleId: document.vehicleId
  };
}

function toPortalDocumentView(document: DocumentWithRelations, orderId: string) {
  return {
    createdAt: document.createdAt,
    description: document.description,
    documentType: document.documentType,
    effectiveFrom: toIsoDate(document.effectiveFrom),
    effectiveTo: toIsoDate(document.effectiveTo),
    fileName: document.fileName,
    fileSize: document.fileSize,
    id: document.id,
    mimeType: document.mimeType,
    originalName: document.originalName,
    policy: document.policy
      ? {
          insurerName: document.policy.insurerName,
          policyNo: document.policy.policyNo,
          policyType: document.policy.policyType
        }
      : null,
    previewUrl: `/api/portal/orders/${orderId}/documents/${document.id}/preview`,
    title: document.title
  };
}

function toClaimView(claim: ClaimWithRelations) {
  return {
    acceptedAt: toIsoDateTime(claim.acceptedAt),
    accidentAt: toIsoDateTime(claim.accidentAt),
    approvedAmount: numberOrNull(claim.approvedAmount),
    claimNo: claim.claimNo,
    claimStatus: claim.claimStatus,
    closedAt: toIsoDateTime(claim.closedAt),
    createdAt: claim.createdAt,
    createdBy: claim.createdBy,
    customer: claim.customer,
    customerId: claim.customerId,
    estimatedAmount: numberOrNull(claim.estimatedAmount),
    id: claim.id,
    insurerClaimNo: claim.insurerClaimNo,
    order: claim.order,
    orderId: claim.orderId,
    paidAmount: numberOrNull(claim.paidAmount),
    policy: claim.policy,
    policyId: claim.policyId,
    remark: claim.remark,
    serviceCase: claim.serviceCase,
    serviceCaseId: claim.serviceCaseId,
    submittedAt: toIsoDateTime(claim.submittedAt),
    updatedAt: claim.updatedAt,
    updatedBy: claim.updatedBy,
    vehicle: toVehicleBrief(claim.vehicle),
    vehicleId: claim.vehicleId
  };
}

function toVehicleBrief(vehicle: {
  brand: string;
  id: string;
  model: string | null;
  plateNo?: string | null;
  series: string | null;
  vehicleNo: string;
}) {
  return {
    displayName: [vehicle.brand, vehicle.series, vehicle.model].filter(Boolean).join(" "),
    id: vehicle.id,
    plateNo: vehicle.plateNo ?? null,
    vehicleNo: vehicle.vehicleNo
  };
}

function resolvePagination(query: { page?: number; pageSize?: number }) {
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20)));
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize
  };
}

function buildDateRange(from?: string, to?: string, field = "date") {
  const range: Prisma.DateTimeFilter = {};
  if (from) {
    range.gte = parseDateOnly(from, `${field}From`);
  }
  if (to) {
    range.lte = parseDateOnly(to, `${field}To`);
  }
  return range;
}

function assertDateOrder(from: Date, to: Date) {
  if (from.getTime() > to.getTime()) {
    throw new BadRequestException("effectiveFrom must be earlier than or equal to effectiveTo");
  }
}

function assertSupportedVehicleDocumentFile(file: UploadedVehicleDocumentFile) {
  if (file.mimetype?.startsWith("video/") || file.mimetype?.startsWith("audio/")) {
    throw new BadRequestException("vehicle documents do not support video or audio files");
  }
  if (!file.mimetype?.startsWith("image/") && file.mimetype !== "application/pdf") {
    throw new BadRequestException("vehicle documents only support image or PDF files");
  }
}

function parseDateOnly(value: string, field: string) {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return date;
}

function parseOptionalDateOnly(value: string | null | undefined, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value.trim() === "") {
    return null;
  }
  return parseDateOnly(value, field);
}

function parseOptionalDateTime(value: string | null | undefined, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value.trim() === "") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return date;
}

function normalizeRequiredText(value: string | null | undefined, field: string) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new BadRequestException(`${field} is required`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function moneyOrNull(value: number | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? null : BigInt(value);
}

function numberOrNull(value: bigint | null) {
  return value === null ? null : Number(value);
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function toIsoDate(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function toIsoDateTime(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function startOfUtcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function differenceInDays(from: Date, to: Date) {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}
