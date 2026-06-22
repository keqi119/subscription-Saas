import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  Prisma,
  VehicleBaasBillingCycle,
  VehicleBaasContractAttachment,
  VehicleBaasContractAttachmentType,
  VehicleBaasContractStatus,
  VehicleBaasCostRecord,
  VehicleBaasCostRecordStatus,
  VehicleBaasCostSource,
  VehicleBatteryUsageType
} from "@prisma/client";
import type { Readable } from "node:stream";

import { RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import {
  CreateVehicleBaasContractDto,
  CreateVehicleBaasCostRecordDto,
  GenerateVehicleBaasCostRecordsDto,
  UpdateVehicleBaasContractDto,
  UpdateVehicleBaasCostRecordDto,
  UploadVehicleBaasContractAttachmentDto,
  VehicleBaasContractsQueryDto,
  VehicleBaasCostRecordActionDto,
  VehicleBaasCostRecordsQueryDto
} from "./dto/vehicle-baas.dto";

export interface UploadedVehicleBaasAttachmentFile {
  buffer: Buffer;
  mimetype?: string;
  originalname: string;
  size: number;
}

export interface VehicleBaasAttachmentPreview {
  filename: string;
  mimeType?: string | null;
  sizeBytes: number;
  stream: Readable;
}

const contractInclude = {
  attachments: {
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  costRecords: {
    orderBy: [{ dueDate: "asc" as const }, { createdAt: "asc" as const }],
    where: { deletedAt: null }
  },
  vehicle: {
    select: {
      batteryUsageType: true,
      brand: true,
      id: true,
      model: true,
      plateNo: true,
      series: true,
      vehicleNo: true
    }
  }
} satisfies Prisma.VehicleBaasContractInclude;

const attachmentInclude = {
  contract: {
    select: {
      contractNo: true,
      id: true,
      vehicleId: true
    }
  }
} satisfies Prisma.VehicleBaasContractAttachmentInclude;

const costRecordInclude = {
  contract: {
    select: {
      contractNo: true,
      id: true,
      providerName: true
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
} satisfies Prisma.VehicleBaasCostRecordInclude;

type ContractWithRelations = Prisma.VehicleBaasContractGetPayload<{ include: typeof contractInclude }>;
type AttachmentWithRelations = Prisma.VehicleBaasContractAttachmentGetPayload<{ include: typeof attachmentInclude }>;
type CostRecordWithRelations = Prisma.VehicleBaasCostRecordGetPayload<{ include: typeof costRecordInclude }>;

@Injectable()
export class VehicleBaasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService
  ) {}

  async listContracts(query: VehicleBaasContractsQueryDto) {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.VehicleBaasContractWhereInput = {
      contractStatus: query.contractStatus,
      deletedAt: null,
      vehicleId: query.vehicleId
    };
    if (query.providerName) {
      where.providerName = { contains: query.providerName, mode: "insensitive" };
    }
    if (query.effectiveFrom || query.effectiveTo) {
      where.effectiveFrom = buildDateRange(query.effectiveFrom, query.effectiveTo, "effective");
    }

    const [total, items] = await Promise.all([
      this.prisma.vehicleBaasContract.count({ where }),
      this.prisma.vehicleBaasContract.findMany({
        include: contractInclude,
        orderBy: [{ contractStatus: "asc" }, { effectiveFrom: "desc" }, { createdAt: "desc" }],
        skip,
        take: pageSize,
        where
      })
    ]);

    return {
      items: items.map(toContractView),
      page,
      pageSize,
      total
    };
  }

  async getContract(id: string) {
    return toContractView(await this.findContractOrThrow(id));
  }

  async createContract(vehicleId: string, dto: CreateVehicleBaasContractDto, user: RequestUser) {
    await this.findVehicleOrThrow(vehicleId);
    const data = buildContractCreateData(dto, user.id);
    const contractNo = normalizeOptionalText(dto.contractNo);

    const contract = await withUniqueBusinessNoRetry(() =>
      this.prisma.vehicleBaasContract.create({
        data: {
          ...data,
          contractNo: contractNo ?? createBusinessNo("BAAS"),
          vehicleId
        },
        include: contractInclude
      })
    );

    return toContractView(contract);
  }

  async updateContract(id: string, dto: UpdateVehicleBaasContractDto, user: RequestUser) {
    const before = await this.findContractOrThrow(id);
    const data = buildContractUpdateData(dto, user.id);
    const nextEffectiveFrom =
      data.effectiveFrom instanceof Date ? data.effectiveFrom : before.effectiveFrom;
    const nextEffectiveTo =
      data.effectiveTo instanceof Date || data.effectiveTo === null
        ? data.effectiveTo
        : before.effectiveTo;
    assertOptionalDateOrder(nextEffectiveFrom, nextEffectiveTo);

    const contract = await this.prisma.vehicleBaasContract.update({
      data,
      include: contractInclude,
      where: { id }
    });
    return toContractView(contract);
  }

  async activateContract(id: string, user: RequestUser) {
    const contract = await this.findContractOrThrow(id);
    if (contract.vehicle.batteryUsageType !== VehicleBatteryUsageType.BAAS) {
      throw new BadRequestException("车辆电池使用方式为 BAAS 时才能激活 BaaS 合同。");
    }
    const activeCount = await this.prisma.vehicleBaasContract.count({
      where: {
        contractStatus: VehicleBaasContractStatus.ACTIVE,
        deletedAt: null,
        id: { not: id },
        vehicleId: contract.vehicleId
      }
    });
    if (activeCount > 0) {
      throw new BadRequestException("同一车辆同一时间只能存在一个 ACTIVE BaaS 合同。");
    }

    const now = new Date();
    const updated = await this.prisma.vehicleBaasContract.update({
      data: {
        activatedAt: now,
        contractStatus: VehicleBaasContractStatus.ACTIVE,
        updatedBy: user.id
      },
      include: contractInclude,
      where: { id }
    });
    return toContractView(updated);
  }

  async suspendContract(id: string, user: RequestUser) {
    return this.updateContractStatus(id, {
      contractStatus: VehicleBaasContractStatus.SUSPENDED,
      suspendedAt: new Date(),
      updatedBy: user.id
    });
  }

  async terminateContract(id: string, user: RequestUser) {
    return this.updateContractStatus(id, {
      contractStatus: VehicleBaasContractStatus.TERMINATED,
      terminatedAt: new Date(),
      updatedBy: user.id
    });
  }

  async archiveContract(id: string, user: RequestUser) {
    return this.updateContractStatus(id, {
      archivedAt: new Date(),
      contractStatus: VehicleBaasContractStatus.ARCHIVED,
      updatedBy: user.id
    });
  }

  async listAttachments(contractId: string) {
    await this.findContractOrThrow(contractId);
    const attachments = await this.prisma.vehicleBaasContractAttachment.findMany({
      include: attachmentInclude,
      orderBy: { createdAt: "desc" },
      where: { contractId, deletedAt: null }
    });
    return attachments.map(toAttachmentView);
  }

  async uploadAttachment(
    contractId: string,
    dto: UploadVehicleBaasContractAttachmentDto,
    files: UploadedVehicleBaasAttachmentFile[] | undefined,
    user: RequestUser
  ) {
    await this.findContractOrThrow(contractId);
    const file = firstFileOrThrow(files);
    assertAllowedDocumentMime(file.mimetype);
    const stored = await this.storageService.putVehicleBaasContractAttachment({
      buffer: file.buffer,
      contractId,
      contentType: file.mimetype,
      originalName: file.originalname
    });

    const attachment = await this.prisma.vehicleBaasContractAttachment.create({
      data: {
        attachmentType: dto.attachmentType ?? VehicleBaasContractAttachmentType.CONTRACT,
        bucket: stored.bucket,
        contractId,
        description: normalizeOptionalText(dto.description),
        fileName: stored.stored.key.split("/").pop() ?? file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype,
        objectKey: stored.objectKey,
        originalName: file.originalname,
        title: normalizeOptionalText(dto.title),
        uploadedBy: user.id
      },
      include: attachmentInclude
    });
    return toAttachmentView(attachment);
  }

  async deleteAttachment(id: string) {
    const attachment = await this.findAttachmentOrThrow(id);
    const updated = await this.prisma.vehicleBaasContractAttachment.update({
      data: { deletedAt: new Date() },
      include: attachmentInclude,
      where: { id: attachment.id }
    });
    return toAttachmentView(updated);
  }

  async previewAttachment(id: string): Promise<VehicleBaasAttachmentPreview> {
    const attachment = await this.findAttachmentOrThrow(id);
    if (!attachment.bucket || !attachment.objectKey) {
      throw new NotFoundException("附件文件不存在。");
    }
    const object = await this.storageService.getVehicleBaasContractAttachmentStream(
      attachment.bucket,
      attachment.objectKey
    );
    return {
      filename: attachment.originalName ?? attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: object.contentLength ?? attachment.fileSize ?? 0,
      stream: object.stream
    };
  }

  async listCostRecords(query: VehicleBaasCostRecordsQueryDto) {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.VehicleBaasCostRecordWhereInput = {
      contractId: query.contractId,
      costPeriod: query.costPeriod,
      costStatus: query.costStatus,
      deletedAt: null,
      vehicleId: query.vehicleId
    };
    const dueRange = buildDateRange(query.dueFrom, query.dueTo, "dueDate");
    if (Object.keys(dueRange).length > 0) {
      where.dueDate = dueRange;
    }

    const [total, items] = await Promise.all([
      this.prisma.vehicleBaasCostRecord.count({ where }),
      this.prisma.vehicleBaasCostRecord.findMany({
        include: costRecordInclude,
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        skip,
        take: pageSize,
        where
      })
    ]);

    return {
      items: items.map(toCostRecordView),
      page,
      pageSize,
      total
    };
  }

  async listContractCostRecords(contractId: string, query: VehicleBaasCostRecordsQueryDto) {
    await this.findContractOrThrow(contractId);
    return this.listCostRecords({ ...query, contractId });
  }

  async generateCostRecords(contractId: string, dto: GenerateVehicleBaasCostRecordsDto, user: RequestUser) {
    const contract = await this.findContractOrThrow(contractId);
    assertCanGenerateCostRecords(contract);
    const periods = buildBillingPeriods(dto.fromPeriod, dto.toPeriod, contract.billingCycle);
    const existing = await this.prisma.vehicleBaasCostRecord.findMany({
      where: {
        contractId,
        costPeriod: { in: periods.map((period) => period.costPeriod) },
        deletedAt: null
      }
    });
    const existingPeriods = new Set(existing.map((record) => record.costPeriod));
    const candidates = periods.map((period) => buildGeneratedCostRecordCandidate(contract, period));
    const missing = candidates.filter((candidate) => !existingPeriods.has(candidate.costPeriod));

    if (dto.dryRun ?? false) {
      return {
        dryRun: true,
        generatedCount: 0,
        records: candidates.map((candidate) => ({
          ...candidate,
          exists: existingPeriods.has(candidate.costPeriod)
        })),
        skippedCount: candidates.length - missing.length
      };
    }

    const created: CostRecordWithRelations[] = [];
    for (const candidate of missing) {
      const record = await withUniqueBusinessNoRetry(() =>
        this.prisma.vehicleBaasCostRecord.create({
          data: {
            costAmount: candidate.costAmount,
            costPeriod: candidate.costPeriod,
            costRecordNo: createBusinessNo("BCR"),
            costSource: VehicleBaasCostSource.GENERATED,
            costStatus: VehicleBaasCostRecordStatus.SCHEDULED,
            contractId,
            createdBy: user.id,
            currency: candidate.currency,
            dueDate: candidate.dueDate,
            periodEnd: candidate.periodEnd,
            periodStart: candidate.periodStart,
            snapshot: {
              billingCycle: contract.billingCycle,
              paymentDayOfMonth: contract.paymentDayOfMonth,
              source: "GENERATED",
              stage: "10M-C-A"
            },
            updatedBy: user.id,
            vehicleId: contract.vehicleId
          },
          include: costRecordInclude
        })
      );
      created.push(record);
    }

    return {
      dryRun: false,
      generatedCount: created.length,
      records: created.map(toCostRecordView),
      skippedCount: candidates.length - missing.length
    };
  }

  async createCostRecord(contractId: string, dto: CreateVehicleBaasCostRecordDto, user: RequestUser) {
    const contract = await this.findContractOrThrow(contractId);
    const month = parseCostPeriod(dto.costPeriod);
    const periodStart = dto.periodStart ? parseDateOnly(dto.periodStart, "periodStart") : firstDayOfMonth(month);
    const periodEnd = dto.periodEnd ? parseDateOnly(dto.periodEnd, "periodEnd") : lastDayOfMonth(month);
    const dueDate = dto.dueDate ? parseDateOnly(dto.dueDate, "dueDate") : dueDateForMonth(month, contract.paymentDayOfMonth);
    assertDateOrder(periodStart, periodEnd);

    const record = await withUniqueBusinessNoRetry(() =>
      this.prisma.vehicleBaasCostRecord.create({
        data: {
          costAmount: moneyOrThrow(dto.costAmount ?? numberFromBigInt(contract.rentalAmount), "costAmount"),
          costPeriod: dto.costPeriod,
          costRecordNo: createBusinessNo("BCR"),
          costSource: dto.costSource ?? VehicleBaasCostSource.MANUAL,
          costStatus: dto.costStatus ?? VehicleBaasCostRecordStatus.SCHEDULED,
          contractId,
          createdBy: user.id,
          currency: normalizeOptionalText(dto.currency) ?? contract.currency ?? "CNY",
          dueDate,
          invoiceNo: normalizeOptionalText(dto.invoiceNo),
          paymentRefNo: normalizeOptionalText(dto.paymentRefNo),
          periodEnd,
          periodStart,
          remark: normalizeOptionalText(dto.remark),
          snapshot: {
            source: "BACK_OFFICE",
            stage: "10M-C-A"
          },
          updatedBy: user.id,
          vehicleId: contract.vehicleId
        },
        include: costRecordInclude
      })
    );
    return toCostRecordView(record);
  }

  async updateCostRecord(id: string, dto: UpdateVehicleBaasCostRecordDto, user: RequestUser) {
    const data: Prisma.VehicleBaasCostRecordUncheckedUpdateInput = {
      updatedBy: user.id
    };
    assignIfDefined(data, "costAmount", dto.costAmount === undefined ? undefined : moneyOrThrow(dto.costAmount, "costAmount"));
    assignIfDefined(data, "currency", normalizeOptionalText(dto.currency));
    assignIfDefined(data, "costStatus", dto.costStatus);
    assignIfDefined(data, "dueDate", dto.dueDate ? parseDateOnly(dto.dueDate, "dueDate") : undefined);
    assignIfDefined(data, "invoiceNo", normalizeOptionalText(dto.invoiceNo));
    assignIfDefined(data, "paymentRefNo", normalizeOptionalText(dto.paymentRefNo));
    assignIfDefined(data, "remark", normalizeOptionalText(dto.remark));

    const record = await this.prisma.vehicleBaasCostRecord.update({
      data,
      include: costRecordInclude,
      where: { id }
    });
    return toCostRecordView(record);
  }

  async confirmCostRecord(id: string, dto: VehicleBaasCostRecordActionDto, user: RequestUser) {
    const record = await this.findCostRecordOrThrow(id);
    assertCostRecordStatus(record, [VehicleBaasCostRecordStatus.SCHEDULED], "只有待计划成本可以确认。");
    return this.updateCostRecordAction(record.id, {
      confirmedAt: new Date(),
      costStatus: VehicleBaasCostRecordStatus.CONFIRMED,
      invoiceNo: normalizeOptionalText(dto.invoiceNo),
      paymentRefNo: normalizeOptionalText(dto.paymentRefNo),
      remark: normalizeOptionalText(dto.remark),
      updatedBy: user.id
    });
  }

  async markCostRecordPaid(id: string, dto: VehicleBaasCostRecordActionDto, user: RequestUser) {
    const record = await this.findCostRecordOrThrow(id);
    assertCostRecordStatus(
      record,
      [VehicleBaasCostRecordStatus.SCHEDULED, VehicleBaasCostRecordStatus.CONFIRMED],
      "只有计划或已确认成本可以标记已支付。"
    );
    return this.updateCostRecordAction(record.id, {
      costStatus: VehicleBaasCostRecordStatus.PAID,
      invoiceNo: normalizeOptionalText(dto.invoiceNo),
      paidAt: new Date(),
      paymentRefNo: normalizeOptionalText(dto.paymentRefNo),
      remark: normalizeOptionalText(dto.remark),
      updatedBy: user.id
    });
  }

  async voidCostRecord(id: string, dto: VehicleBaasCostRecordActionDto, user: RequestUser) {
    const record = await this.findCostRecordOrThrow(id);
    assertCostRecordStatus(
      record,
      [VehicleBaasCostRecordStatus.SCHEDULED, VehicleBaasCostRecordStatus.CONFIRMED],
      "只有计划或已确认成本可以作废。"
    );
    return this.updateCostRecordAction(record.id, {
      costStatus: VehicleBaasCostRecordStatus.VOIDED,
      invoiceNo: normalizeOptionalText(dto.invoiceNo),
      paymentRefNo: normalizeOptionalText(dto.paymentRefNo),
      remark: normalizeOptionalText(dto.remark),
      updatedBy: user.id,
      voidedAt: new Date()
    });
  }

  async getVehicleBaasSummary(vehicleId: string) {
    await this.findVehicleOrThrow(vehicleId);
    const contracts = await this.prisma.vehicleBaasContract.findMany({
      include: contractInclude,
      orderBy: [{ contractStatus: "asc" }, { effectiveFrom: "desc" }],
      where: { deletedAt: null, vehicleId }
    });
    const activeContract =
      contracts.find((contract) => contract.contractStatus === VehicleBaasContractStatus.ACTIVE) ?? null;
    return {
      activeContract: activeContract ? toContractView(activeContract) : null,
      contractCount: contracts.length,
      contracts: contracts.slice(0, 5).map(toContractView),
      unpaidCostCount: contracts.reduce(
        (sum, contract) => sum + unpaidCostRecords(contract.costRecords).length,
        0
      )
    };
  }

  private async updateContractStatus(id: string, data: Prisma.VehicleBaasContractUncheckedUpdateInput) {
    await this.findContractOrThrow(id);
    const contract = await this.prisma.vehicleBaasContract.update({
      data,
      include: contractInclude,
      where: { id }
    });
    return toContractView(contract);
  }

  private async updateCostRecordAction(id: string, data: Prisma.VehicleBaasCostRecordUncheckedUpdateInput) {
    const record = await this.prisma.vehicleBaasCostRecord.update({
      data,
      include: costRecordInclude,
      where: { id }
    });
    return toCostRecordView(record);
  }

  private async findContractOrThrow(id: string) {
    const contract = await this.prisma.vehicleBaasContract.findFirst({
      include: contractInclude,
      where: { deletedAt: null, id }
    });
    if (!contract) {
      throw new NotFoundException("BaaS 合同不存在。");
    }
    return contract;
  }

  private async findAttachmentOrThrow(id: string) {
    const attachment = await this.prisma.vehicleBaasContractAttachment.findFirst({
      include: attachmentInclude,
      where: { deletedAt: null, id }
    });
    if (!attachment) {
      throw new NotFoundException("BaaS 合同附件不存在。");
    }
    return attachment;
  }

  private async findCostRecordOrThrow(id: string) {
    const record = await this.prisma.vehicleBaasCostRecord.findFirst({
      include: costRecordInclude,
      where: { deletedAt: null, id }
    });
    if (!record) {
      throw new NotFoundException("BaaS 成本记录不存在。");
    }
    return record;
  }

  private async findVehicleOrThrow(id: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { deletedAt: null, id }
    });
    if (!vehicle) {
      throw new NotFoundException("车辆不存在。");
    }
    return vehicle;
  }
}

function buildContractCreateData(
  dto: CreateVehicleBaasContractDto,
  userId: string
): Omit<Prisma.VehicleBaasContractUncheckedCreateInput, "contractNo" | "vehicleId"> {
  const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
  const effectiveTo = dto.effectiveTo ? parseDateOnly(dto.effectiveTo, "effectiveTo") : null;
  assertOptionalDateOrder(effectiveFrom, effectiveTo);
  return {
    batteryPackageName: normalizeOptionalText(dto.batteryPackageName),
    batterySerialNo: normalizeOptionalText(dto.batterySerialNo),
    billingCycle: dto.billingCycle ?? VehicleBaasBillingCycle.MONTHLY,
    contractStatus: dto.contractStatus ?? VehicleBaasContractStatus.DRAFT,
    createdBy: userId,
    currency: normalizeOptionalText(dto.currency) ?? "CNY",
    effectiveFrom,
    effectiveTo,
    graceDays: dto.graceDays ?? 0,
    invoiceRequired: dto.invoiceRequired ?? false,
    paymentDayOfMonth: dto.paymentDayOfMonth,
    providerContractNo: normalizeOptionalText(dto.providerContractNo),
    providerName: normalizeRequiredText(dto.providerName, "providerName"),
    remark: normalizeOptionalText(dto.remark),
    rentalAmount: moneyOrThrow(dto.rentalAmount, "rentalAmount"),
    snapshot: {
      source: "BACK_OFFICE",
      stage: "10M-C-A"
    },
    taxIncluded: dto.taxIncluded ?? true,
    updatedBy: userId
  };
}

function buildContractUpdateData(dto: UpdateVehicleBaasContractDto, userId: string) {
  const data: Prisma.VehicleBaasContractUncheckedUpdateInput = {
    updatedBy: userId
  };
  assignIfDefined(data, "batteryPackageName", normalizeOptionalText(dto.batteryPackageName));
  assignIfDefined(data, "batterySerialNo", normalizeOptionalText(dto.batterySerialNo));
  assignIfDefined(data, "billingCycle", dto.billingCycle);
  assignIfDefined(data, "contractNo", dto.contractNo ? normalizeRequiredText(dto.contractNo, "contractNo") : undefined);
  assignIfDefined(data, "contractStatus", dto.contractStatus);
  assignIfDefined(data, "currency", normalizeOptionalText(dto.currency));
  assignIfDefined(data, "effectiveFrom", dto.effectiveFrom ? parseDateOnly(dto.effectiveFrom, "effectiveFrom") : undefined);
  assignIfDefined(data, "effectiveTo", dto.effectiveTo ? parseDateOnly(dto.effectiveTo, "effectiveTo") : dto.effectiveTo);
  assignIfDefined(data, "graceDays", dto.graceDays);
  assignIfDefined(data, "invoiceRequired", dto.invoiceRequired);
  assignIfDefined(data, "paymentDayOfMonth", dto.paymentDayOfMonth);
  assignIfDefined(data, "providerContractNo", normalizeOptionalText(dto.providerContractNo));
  assignIfDefined(data, "providerName", dto.providerName ? normalizeRequiredText(dto.providerName, "providerName") : undefined);
  assignIfDefined(data, "remark", normalizeOptionalText(dto.remark));
  assignIfDefined(data, "rentalAmount", dto.rentalAmount === undefined ? undefined : moneyOrThrow(dto.rentalAmount, "rentalAmount"));
  assignIfDefined(data, "taxIncluded", dto.taxIncluded);
  return data;
}

function buildGeneratedCostRecordCandidate(contract: ContractWithRelations, period: BillingPeriod) {
  return {
    costAmount: numberFromBigInt(contract.rentalAmount),
    costPeriod: period.costPeriod,
    currency: contract.currency ?? "CNY",
    dueDate: dueDateForMonth(period.periodStart, contract.paymentDayOfMonth),
    periodEnd: period.periodEnd,
    periodStart: period.periodStart
  };
}

function toContractView(contract: ContractWithRelations) {
  const unpaid = unpaidCostRecords(contract.costRecords);
  const nextCost = unpaid.sort((left, right) => left.dueDate.getTime() - right.dueDate.getTime())[0] ?? null;
  return {
    activatedAt: toIso(contract.activatedAt),
    archivedAt: toIso(contract.archivedAt),
    attachmentCount: contract.attachments.length,
    attachments: contract.attachments.map(toAttachmentView),
    batteryPackageName: contract.batteryPackageName,
    batterySerialNo: contract.batterySerialNo,
    billingCycle: contract.billingCycle,
    contractNo: contract.contractNo,
    contractStatus: contract.contractStatus,
    costRecordCount: contract.costRecords.length,
    costRecords: contract.costRecords.map(toCostRecordSummary),
    createdAt: toIso(contract.createdAt),
    currency: contract.currency,
    effectiveFrom: toIsoDate(contract.effectiveFrom),
    effectiveTo: toIsoDate(contract.effectiveTo),
    graceDays: contract.graceDays,
    id: contract.id,
    invoiceRequired: contract.invoiceRequired,
    nextDueDate: nextCost ? toIsoDate(nextCost.dueDate) : null,
    paymentDayOfMonth: contract.paymentDayOfMonth,
    providerContractNo: contract.providerContractNo,
    providerName: contract.providerName,
    remark: contract.remark,
    rentalAmount: numberFromBigInt(contract.rentalAmount),
    suspendedAt: toIso(contract.suspendedAt),
    taxIncluded: contract.taxIncluded,
    terminatedAt: toIso(contract.terminatedAt),
    unpaidCostCount: unpaid.length,
    updatedAt: toIso(contract.updatedAt),
    vehicle: {
      batteryUsageType: contract.vehicle.batteryUsageType,
      displayName: vehicleDisplayName(contract.vehicle),
      id: contract.vehicle.id,
      plateNo: contract.vehicle.plateNo,
      vehicleNo: contract.vehicle.vehicleNo
    },
    vehicleId: contract.vehicleId
  };
}

function toAttachmentView(attachment: VehicleBaasContractAttachment | AttachmentWithRelations) {
  return {
    attachmentType: attachment.attachmentType,
    contractId: attachment.contractId,
    createdAt: toIso(attachment.createdAt),
    description: attachment.description,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    id: attachment.id,
    mimeType: attachment.mimeType,
    originalName: attachment.originalName,
    previewUrl: `/api/vehicle-baas-contract-attachments/${attachment.id}/preview`,
    title: attachment.title
  };
}

function toCostRecordView(record: CostRecordWithRelations) {
  return {
    confirmedAt: toIso(record.confirmedAt),
    contract: {
      contractNo: record.contract.contractNo,
      id: record.contract.id,
      providerName: record.contract.providerName
    },
    contractId: record.contractId,
    costAmount: numberFromBigInt(record.costAmount),
    costPeriod: record.costPeriod,
    costRecordNo: record.costRecordNo,
    costSource: record.costSource,
    costStatus: record.costStatus,
    createdAt: toIso(record.createdAt),
    currency: record.currency,
    dueDate: toIsoDate(record.dueDate),
    id: record.id,
    invoiceNo: record.invoiceNo,
    paidAt: toIso(record.paidAt),
    paymentRefNo: record.paymentRefNo,
    periodEnd: toIsoDate(record.periodEnd),
    periodStart: toIsoDate(record.periodStart),
    remark: record.remark,
    updatedAt: toIso(record.updatedAt),
    vehicle: {
      displayName: vehicleDisplayName(record.vehicle),
      id: record.vehicle.id,
      plateNo: record.vehicle.plateNo,
      vehicleNo: record.vehicle.vehicleNo
    },
    vehicleId: record.vehicleId,
    voidedAt: toIso(record.voidedAt)
  };
}

function toCostRecordSummary(record: VehicleBaasCostRecord) {
  return {
    costAmount: numberFromBigInt(record.costAmount),
    costPeriod: record.costPeriod,
    costRecordNo: record.costRecordNo,
    costStatus: record.costStatus,
    currency: record.currency,
    dueDate: toIsoDate(record.dueDate),
    id: record.id
  };
}

function unpaidCostRecords(records: VehicleBaasCostRecord[]) {
  const unpaidStatuses: VehicleBaasCostRecordStatus[] = [
    VehicleBaasCostRecordStatus.SCHEDULED,
    VehicleBaasCostRecordStatus.CONFIRMED,
    VehicleBaasCostRecordStatus.OVERDUE
  ];
  return records.filter((record) =>
    unpaidStatuses.includes(record.costStatus)
  );
}

interface BillingPeriod {
  costPeriod: string;
  periodEnd: Date;
  periodStart: Date;
}

function buildBillingPeriods(fromPeriod: string, toPeriod: string, cycle: VehicleBaasBillingCycle) {
  const from = parseCostPeriod(fromPeriod);
  const to = parseCostPeriod(toPeriod);
  if (from.getTime() > to.getTime()) {
    throw new BadRequestException("fromPeriod 不能晚于 toPeriod。");
  }
  const step = cycle === VehicleBaasBillingCycle.YEARLY ? 12 : cycle === VehicleBaasBillingCycle.QUARTERLY ? 3 : 1;
  const periods: BillingPeriod[] = [];
  for (let cursor = from; cursor.getTime() <= to.getTime(); cursor = addMonths(cursor, step)) {
    periods.push({
      costPeriod: formatCostPeriod(cursor),
      periodEnd: addDays(addMonths(cursor, step), -1),
      periodStart: cursor
    });
  }
  return periods;
}

function parseCostPeriod(value: string) {
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new BadRequestException("账期格式必须为 YYYY-MM。");
  }
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (month < 1 || month > 12) {
    throw new BadRequestException("账期月份必须在 01-12 之间。");
  }
  return new Date(Date.UTC(year, month - 1, 1));
}

function formatCostPeriod(value: Date) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dueDateForMonth(month: Date, paymentDayOfMonth: number) {
  const lastDay = lastDayOfMonth(month).getUTCDate();
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(paymentDayOfMonth, lastDay)));
}

function firstDayOfMonth(month: Date) {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
}

function lastDayOfMonth(month: Date) {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
}

function addMonths(value: Date, months: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function assertCanGenerateCostRecords(contract: ContractWithRelations) {
  const allowedStatuses: VehicleBaasContractStatus[] = [
    VehicleBaasContractStatus.ACTIVE,
    VehicleBaasContractStatus.SUSPENDED
  ];
  if (!allowedStatuses.includes(contract.contractStatus)) {
    throw new BadRequestException("只有 ACTIVE 或 SUSPENDED BaaS 合同可以生成成本记录。");
  }
}

function assertCostRecordStatus(
  record: VehicleBaasCostRecord,
  allowed: VehicleBaasCostRecordStatus[],
  message: string
) {
  if (!allowed.includes(record.costStatus)) {
    throw new BadRequestException(message);
  }
}

function firstFileOrThrow(files: UploadedVehicleBaasAttachmentFile[] | undefined) {
  const file = files?.[0];
  if (!file) {
    throw new BadRequestException("请上传 BaaS 合同附件。");
  }
  return file;
}

function assertAllowedDocumentMime(mimeType: string | undefined) {
  if (!mimeType) {
    return;
  }
  if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) {
    throw new BadRequestException("不支持上传视频或音频文件。");
  }
  if (!mimeType.startsWith("image/") && mimeType !== "application/pdf" && mimeType !== "application/octet-stream") {
    throw new BadRequestException("仅支持图片或 PDF 文件。");
  }
}

function buildDateRange(from: string | undefined, to: string | undefined, field: string) {
  const range: Prisma.DateTimeFilter = {};
  if (from) {
    range.gte = parseDateOnly(from, `${field}From`);
  }
  if (to) {
    range.lte = parseDateOnly(to, `${field}To`);
  }
  return range;
}

function parseDateOnly(value: string, field: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} 日期格式无效。`);
  }
  return parsed;
}

function assertDateOrder(from: Date, to: Date) {
  if (from.getTime() > to.getTime()) {
    throw new BadRequestException("开始日期不能晚于结束日期。");
  }
}

function assertOptionalDateOrder(from: Date, to: Date | null) {
  if (to && from.getTime() > to.getTime()) {
    throw new BadRequestException("生效日期不能晚于结束日期。");
  }
}

function resolvePagination(query: { page?: number; pageSize?: number }) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize
  };
}

function normalizeRequiredText(value: string | null | undefined, field: string) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new BadRequestException(`${field} 不能为空。`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function moneyOrThrow(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException(`${field} 必须是非负整数分。`);
  }
  return BigInt(value);
}

function numberFromBigInt(value: bigint | number) {
  return typeof value === "bigint" ? Number(value) : value;
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function toIso(value?: Date | null) {
  return value ? value.toISOString() : null;
}

function toIsoDate(value?: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function vehicleDisplayName(vehicle: { brand: string; model?: string | null; plateNo?: string | null; series?: string | null; vehicleNo: string }) {
  return [vehicle.vehicleNo, vehicle.plateNo, vehicle.brand, vehicle.series, vehicle.model].filter(Boolean).join(" / ");
}
