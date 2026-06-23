import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  Prisma,
  VehicleDepreciationMethod,
  VehicleDepreciationPolicyStatus,
  VehicleDepreciationRecord,
  VehicleDepreciationRecordSource,
  VehicleDepreciationRecordStatus,
  VehicleDepreciationSchedule,
  VehicleDepreciationScheduleStatus
} from "@prisma/client";

import { RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import {
  CreateVehicleDepreciationPolicyDto,
  CreateVehicleDepreciationRecordDto,
  GenerateVehicleDepreciationSchedulesDto,
  UpdateVehicleDepreciationPolicyDto,
  UpdateVehicleDepreciationRecordDto,
  VehicleDepreciationPoliciesQueryDto,
  VehicleDepreciationRecordActionDto,
  VehicleDepreciationRecordsQueryDto,
  VehicleDepreciationScheduleActionDto
} from "./dto/vehicle-depreciation.dto";

const vehicleBriefSelect = {
  brand: true,
  id: true,
  model: true,
  plateNo: true,
  purchasePriceAmount: true,
  series: true,
  vehicleNo: true
} satisfies Prisma.VehicleSelect;

const policyInclude = {
  records: {
    orderBy: [{ periodStart: "asc" as const }, { createdAt: "asc" as const }],
    where: { deletedAt: null }
  },
  schedules: {
    orderBy: [{ periodStart: "asc" as const }, { createdAt: "asc" as const }],
    where: { deletedAt: null }
  },
  vehicle: {
    select: vehicleBriefSelect
  }
} satisfies Prisma.VehicleDepreciationPolicyInclude;

const scheduleInclude = {
  policy: {
    select: {
      depreciationMethod: true,
      id: true,
      policyNo: true
    }
  },
  records: {
    orderBy: [{ createdAt: "desc" as const }],
    where: { deletedAt: null }
  },
  vehicle: {
    select: vehicleBriefSelect
  }
} satisfies Prisma.VehicleDepreciationScheduleInclude;

const recordInclude = {
  policy: {
    select: {
      depreciationMethod: true,
      id: true,
      policyNo: true
    }
  },
  schedule: {
    select: {
      id: true,
      scheduleNo: true
    }
  },
  vehicle: {
    select: vehicleBriefSelect
  }
} satisfies Prisma.VehicleDepreciationRecordInclude;

type PolicyWithRelations = Prisma.VehicleDepreciationPolicyGetPayload<{ include: typeof policyInclude }>;
type ScheduleWithRelations = Prisma.VehicleDepreciationScheduleGetPayload<{ include: typeof scheduleInclude }>;
type RecordWithRelations = Prisma.VehicleDepreciationRecordGetPayload<{ include: typeof recordInclude }>;

@Injectable()
export class VehicleDepreciationService {
  constructor(private readonly prisma: PrismaService) {}

  async listPolicies(query: VehicleDepreciationPoliciesQueryDto) {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.VehicleDepreciationPolicyWhereInput = {
      deletedAt: null,
      depreciationMethod: query.depreciationMethod,
      policyStatus: query.policyStatus,
      vehicleId: query.vehicleId
    };

    const [total, items] = await Promise.all([
      this.prisma.vehicleDepreciationPolicy.count({ where }),
      this.prisma.vehicleDepreciationPolicy.findMany({
        include: policyInclude,
        orderBy: [{ policyStatus: "asc" }, { depreciationStartDate: "desc" }, { createdAt: "desc" }],
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

  async listVehiclePolicies(vehicleId: string, query: VehicleDepreciationPoliciesQueryDto) {
    await this.findVehicleOrThrow(vehicleId);
    return this.listPolicies({ ...query, vehicleId });
  }

  async getPolicy(id: string) {
    return toPolicyView(await this.findPolicyOrThrow(id));
  }

  async createPolicy(vehicleId: string, dto: CreateVehicleDepreciationPolicyDto, user: RequestUser) {
    const vehicle = await this.findVehicleOrThrow(vehicleId);
    const normalized = normalizePolicyInput(dto, vehicle.purchasePriceAmount);
    assertPolicyRules(normalized);

    const policyNo = normalizeOptionalText(dto.policyNo);
    const policy = await withUniqueBusinessNoRetry(() =>
      this.prisma.vehicleDepreciationPolicy.create({
        data: {
          assetCostProfileId: normalized.assetCostProfileId,
          basisSource: normalized.basisSource,
          createdBy: user.id,
          currency: normalized.currency,
          depreciationBasisAmount: normalized.depreciationBasisAmount,
          depreciationEndDate: normalized.depreciationEndDate,
          depreciationMethod: normalized.depreciationMethod,
          depreciationStartDate: normalized.depreciationStartDate,
          monthlyDepreciationAmount: normalized.monthlyDepreciationAmount,
          policyNo: policyNo ?? createBusinessNo("VDP"),
          policyStatus: VehicleDepreciationPolicyStatus.DRAFT,
          remark: normalized.remark,
          residualValueAmount: normalized.residualValueAmount,
          snapshot: {
            source: "BACK_OFFICE",
            stage: "10N-C-A"
          },
          updatedBy: user.id,
          usefulLifeMonths: normalized.usefulLifeMonths,
          vehicleId
        },
        include: policyInclude
      })
    );

    return toPolicyView(policy);
  }

  async updatePolicy(id: string, dto: UpdateVehicleDepreciationPolicyDto, user: RequestUser) {
    const before = await this.findPolicyOrThrow(id);
    const normalized = normalizePolicyInput(
      {
        assetCostProfileId:
          dto.assetCostProfileId === undefined ? before.assetCostProfileId : dto.assetCostProfileId,
        basisSource: dto.basisSource ?? before.basisSource,
        currency: dto.currency === undefined ? before.currency : dto.currency,
        depreciationBasisAmount:
          dto.depreciationBasisAmount === undefined
            ? numberFromBigInt(before.depreciationBasisAmount)
            : dto.depreciationBasisAmount,
        depreciationEndDate:
          dto.depreciationEndDate === undefined ? toIsoDate(before.depreciationEndDate) : dto.depreciationEndDate,
        depreciationMethod: dto.depreciationMethod ?? before.depreciationMethod,
        depreciationStartDate:
          dto.depreciationStartDate ?? toRequiredIsoDate(before.depreciationStartDate),
        remark: dto.remark === undefined ? before.remark : dto.remark,
        residualValueAmount:
          dto.residualValueAmount === undefined
            ? numberFromBigInt(before.residualValueAmount)
            : dto.residualValueAmount,
        usefulLifeMonths:
          dto.usefulLifeMonths === undefined ? before.usefulLifeMonths : dto.usefulLifeMonths
      },
      before.vehicle.purchasePriceAmount
    );
    assertPolicyRules(normalized);

    const data: Prisma.VehicleDepreciationPolicyUncheckedUpdateInput = {
      assetCostProfileId: normalized.assetCostProfileId,
      basisSource: normalized.basisSource,
      currency: normalized.currency,
      depreciationBasisAmount: normalized.depreciationBasisAmount,
      depreciationEndDate: normalized.depreciationEndDate,
      depreciationMethod: normalized.depreciationMethod,
      depreciationStartDate: normalized.depreciationStartDate,
      monthlyDepreciationAmount: normalized.monthlyDepreciationAmount,
      policyNo: normalizeOptionalText(dto.policyNo) ?? before.policyNo,
      remark: normalized.remark,
      residualValueAmount: normalized.residualValueAmount,
      updatedBy: user.id,
      usefulLifeMonths: normalized.usefulLifeMonths
    };

    const policy = await this.prisma.vehicleDepreciationPolicy.update({
      data,
      include: policyInclude,
      where: { id }
    });
    return toPolicyView(policy);
  }

  async activatePolicy(id: string, user: RequestUser) {
    const policy = await this.findPolicyOrThrow(id);
    assertPolicyRules(policyValuesFromPolicy(policy));
    const activeCount = await this.prisma.vehicleDepreciationPolicy.count({
      where: {
        deletedAt: null,
        id: { not: id },
        policyStatus: VehicleDepreciationPolicyStatus.ACTIVE,
        vehicleId: policy.vehicleId
      }
    });
    if (activeCount > 0) {
      throw new BadRequestException("Only one ACTIVE depreciation policy is allowed for a vehicle.");
    }

    return this.updatePolicyStatus(id, {
      activatedAt: new Date(),
      policyStatus: VehicleDepreciationPolicyStatus.ACTIVE,
      updatedBy: user.id
    });
  }

  async suspendPolicy(id: string, user: RequestUser) {
    return this.updatePolicyStatus(id, {
      policyStatus: VehicleDepreciationPolicyStatus.SUSPENDED,
      suspendedAt: new Date(),
      updatedBy: user.id
    });
  }

  async terminatePolicy(id: string, user: RequestUser) {
    return this.updatePolicyStatus(id, {
      policyStatus: VehicleDepreciationPolicyStatus.TERMINATED,
      terminatedAt: new Date(),
      updatedBy: user.id
    });
  }

  async archivePolicy(id: string, user: RequestUser) {
    return this.updatePolicyStatus(id, {
      archivedAt: new Date(),
      policyStatus: VehicleDepreciationPolicyStatus.ARCHIVED,
      updatedBy: user.id
    });
  }

  async listPolicySchedules(policyId: string) {
    await this.findPolicyOrThrow(policyId);
    const schedules = await this.prisma.vehicleDepreciationSchedule.findMany({
      include: scheduleInclude,
      orderBy: [{ periodStart: "asc" }, { createdAt: "asc" }],
      where: { deletedAt: null, policyId }
    });
    return schedules.map(toScheduleView);
  }

  async generateSchedules(
    policyId: string,
    dto: GenerateVehicleDepreciationSchedulesDto,
    user: RequestUser
  ) {
    const policy = await this.findPolicyOrThrow(policyId);
    if (policy.depreciationMethod !== VehicleDepreciationMethod.STRAIGHT_LINE) {
      return {
        dryRun: Boolean(dto.dryRun),
        generatedCount: 0,
        message: `${policy.depreciationMethod} policies do not generate depreciation schedules.`,
        schedules: [],
        skippedCount: 0
      };
    }

    assertPolicyRules(policyValuesFromPolicy(policy));
    const candidates = buildStraightLineScheduleCandidates(policy);
    const existing = await this.prisma.vehicleDepreciationSchedule.findMany({
      where: {
        costPeriod: { in: candidates.map((candidate) => candidate.costPeriod) },
        deletedAt: null,
        policyId
      }
    });
    const existingPeriods = new Set(existing.map((schedule) => schedule.costPeriod));
    const missing = candidates.filter((candidate) => !existingPeriods.has(candidate.costPeriod));

    if (dto.dryRun ?? false) {
      return {
        dryRun: true,
        generatedCount: 0,
        schedules: candidates.map((candidate) => ({
          ...candidate,
          scheduledAmount: numberFromBigInt(candidate.scheduledAmount),
          exists: existingPeriods.has(candidate.costPeriod),
          periodEnd: toIsoDate(candidate.periodEnd),
          periodStart: toIsoDate(candidate.periodStart)
        })),
        skippedCount: candidates.length - missing.length
      };
    }

    const created: ScheduleWithRelations[] = [];
    for (const candidate of missing) {
      const schedule = await withUniqueBusinessNoRetry(() =>
        this.prisma.vehicleDepreciationSchedule.create({
          data: {
            costPeriod: candidate.costPeriod,
            createdBy: user.id,
            currency: policy.currency ?? "CNY",
            generatedAt: new Date(),
            periodEnd: candidate.periodEnd,
            periodStart: candidate.periodStart,
            policyId,
            scheduleNo: createBusinessNo("VDS"),
            scheduleStatus: VehicleDepreciationScheduleStatus.SCHEDULED,
            scheduledAmount: candidate.scheduledAmount,
            snapshot: {
              source: "STRAIGHT_LINE",
              stage: "10N-C-A"
            },
            updatedBy: user.id,
            vehicleId: policy.vehicleId
          },
          include: scheduleInclude
        })
      );
      created.push(schedule);
    }

    return {
      dryRun: false,
      generatedCount: created.length,
      schedules: created.map(toScheduleView),
      skippedCount: candidates.length - missing.length
    };
  }

  async confirmSchedule(id: string, dto: VehicleDepreciationScheduleActionDto, user: RequestUser) {
    const schedule = await this.findScheduleOrThrow(id);
    assertScheduleStatus(
      schedule,
      [VehicleDepreciationScheduleStatus.SCHEDULED, VehicleDepreciationScheduleStatus.CONFIRMED],
      "Only scheduled depreciation schedules can be confirmed."
    );

    const existingRecord = schedule.records.find(
      (record) =>
        record.recordSource === VehicleDepreciationRecordSource.SCHEDULED &&
        record.recordStatus !== VehicleDepreciationRecordStatus.VOIDED
    );
    if (existingRecord?.recordStatus === VehicleDepreciationRecordStatus.LOCKED) {
      throw new BadRequestException("Locked depreciation records cannot be replaced.");
    }

    if (existingRecord?.recordStatus === VehicleDepreciationRecordStatus.CONFIRMED) {
      await this.prisma.vehicleDepreciationRecord.update({
        data: {
          remark: normalizeOptionalText(dto.remark),
          updatedBy: user.id
        },
        where: { id: existingRecord.id }
      });
    } else if (existingRecord) {
      await this.prisma.vehicleDepreciationRecord.update({
        data: {
          confirmedAt: new Date(),
          currency: schedule.currency ?? "CNY",
          depreciationAmount: schedule.scheduledAmount,
          recordStatus: VehicleDepreciationRecordStatus.CONFIRMED,
          remark: normalizeOptionalText(dto.remark),
          updatedBy: user.id
        },
        where: { id: existingRecord.id }
      });
    } else {
      await withUniqueBusinessNoRetry(() =>
        this.prisma.vehicleDepreciationRecord.create({
          data: {
            confirmedAt: new Date(),
            costPeriod: schedule.costPeriod,
            createdBy: user.id,
            currency: schedule.currency ?? "CNY",
            depreciationAmount: schedule.scheduledAmount,
            periodEnd: schedule.periodEnd,
            periodStart: schedule.periodStart,
            policyId: schedule.policyId,
            recordNo: createBusinessNo("VDR"),
            recordSource: VehicleDepreciationRecordSource.SCHEDULED,
            recordStatus: VehicleDepreciationRecordStatus.CONFIRMED,
            remark: normalizeOptionalText(dto.remark),
            scheduleId: schedule.id,
            snapshot: {
              scheduleNo: schedule.scheduleNo,
              source: "SCHEDULE_CONFIRM",
              stage: "10N-C-A"
            },
            updatedBy: user.id,
            vehicleId: schedule.vehicleId
          }
        })
      );
    }

    await this.prisma.vehicleDepreciationSchedule.update({
      data: {
        confirmedAt: new Date(),
        remark: normalizeOptionalText(dto.remark),
        scheduleStatus: VehicleDepreciationScheduleStatus.CONFIRMED,
        updatedBy: user.id
      },
      where: { id: schedule.id }
    });
    return toScheduleView(await this.findScheduleOrThrow(id));
  }

  async voidSchedule(id: string, dto: VehicleDepreciationScheduleActionDto, user: RequestUser) {
    const schedule = await this.findScheduleOrThrow(id);
    assertScheduleStatus(
      schedule,
      [VehicleDepreciationScheduleStatus.SCHEDULED, VehicleDepreciationScheduleStatus.CONFIRMED],
      "Only scheduled or confirmed depreciation schedules can be voided."
    );
    const blockingRecord = schedule.records.find(isConfirmedOrLockedRecord);
    if (blockingRecord) {
      throw new BadRequestException("Confirmed or locked records must be handled before voiding a schedule.");
    }

    const updated = await this.prisma.vehicleDepreciationSchedule.update({
      data: {
        remark: normalizeOptionalText(dto.remark),
        scheduleStatus: VehicleDepreciationScheduleStatus.VOIDED,
        updatedBy: user.id,
        voidedAt: new Date()
      },
      include: scheduleInclude,
      where: { id }
    });
    return toScheduleView(updated);
  }

  async lockSchedule(id: string, dto: VehicleDepreciationScheduleActionDto, user: RequestUser) {
    const schedule = await this.findScheduleOrThrow(id);
    if (schedule.scheduleStatus === VehicleDepreciationScheduleStatus.VOIDED) {
      throw new BadRequestException("Voided depreciation schedules cannot be locked.");
    }
    const updated = await this.prisma.vehicleDepreciationSchedule.update({
      data: {
        lockedAt: new Date(),
        remark: normalizeOptionalText(dto.remark),
        scheduleStatus: VehicleDepreciationScheduleStatus.LOCKED,
        updatedBy: user.id
      },
      include: scheduleInclude,
      where: { id }
    });
    return toScheduleView(updated);
  }

  async listRecords(query: VehicleDepreciationRecordsQueryDto) {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.VehicleDepreciationRecordWhereInput = {
      costPeriod: query.costPeriod,
      deletedAt: null,
      policyId: query.policyId,
      recordSource: query.recordSource,
      recordStatus: query.recordStatus,
      scheduleId: query.scheduleId,
      vehicleId: query.vehicleId
    };

    const [total, items] = await Promise.all([
      this.prisma.vehicleDepreciationRecord.count({ where }),
      this.prisma.vehicleDepreciationRecord.findMany({
        include: recordInclude,
        orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
        skip,
        take: pageSize,
        where
      })
    ]);

    return {
      items: items.map(toRecordView),
      page,
      pageSize,
      total
    };
  }

  async listPolicyRecords(policyId: string, query: VehicleDepreciationRecordsQueryDto) {
    await this.findPolicyOrThrow(policyId);
    return this.listRecords({ ...query, policyId });
  }

  async createRecord(policyId: string, dto: CreateVehicleDepreciationRecordDto, user: RequestUser) {
    const policy = await this.findPolicyOrThrow(policyId);
    const recordSource = dto.recordSource ?? VehicleDepreciationRecordSource.MANUAL;
    if (recordSource === VehicleDepreciationRecordSource.SCHEDULED) {
      throw new BadRequestException("SCHEDULED depreciation records must be created by schedule confirmation.");
    }
    if (
      recordSource === VehicleDepreciationRecordSource.MANUAL &&
      policy.depreciationMethod !== VehicleDepreciationMethod.MANUAL
    ) {
      throw new BadRequestException("Manual depreciation records require a MANUAL depreciation policy.");
    }

    const periodStart = parseDateOnly(dto.periodStart, "periodStart");
    const periodEnd = parseDateOnly(dto.periodEnd, "periodEnd");
    assertDateOrder(periodStart, periodEnd);
    parseCostPeriod(dto.costPeriod);

    const record = await withUniqueBusinessNoRetry(() =>
      this.prisma.vehicleDepreciationRecord.create({
        data: {
          costPeriod: dto.costPeriod,
          createdBy: user.id,
          currency: normalizeOptionalText(dto.currency) ?? policy.currency ?? "CNY",
          depreciationAmount: moneyOrThrow(dto.depreciationAmount, "depreciationAmount"),
          periodEnd,
          periodStart,
          policyId,
          recordNo: createBusinessNo("VDR"),
          recordSource,
          recordStatus: dto.recordStatus ?? VehicleDepreciationRecordStatus.DRAFT,
          remark: normalizeOptionalText(dto.remark),
          snapshot: {
            source: "BACK_OFFICE",
            stage: "10N-C-A"
          },
          updatedBy: user.id,
          vehicleId: policy.vehicleId
        },
        include: recordInclude
      })
    );
    return toRecordView(record);
  }

  async updateRecord(id: string, dto: UpdateVehicleDepreciationRecordDto, user: RequestUser) {
    const before = await this.findRecordOrThrow(id);
    if (
      dto.depreciationAmount !== undefined &&
      isConfirmedOrLockedRecord(before)
    ) {
      throw new BadRequestException("Confirmed or locked depreciation records cannot change amount.");
    }

    const nextPeriodStart = dto.periodStart ? parseDateOnly(dto.periodStart, "periodStart") : before.periodStart;
    const nextPeriodEnd = dto.periodEnd ? parseDateOnly(dto.periodEnd, "periodEnd") : before.periodEnd;
    assertDateOrder(nextPeriodStart, nextPeriodEnd);
    if (dto.costPeriod) {
      parseCostPeriod(dto.costPeriod);
    }

    const data: Prisma.VehicleDepreciationRecordUncheckedUpdateInput = {
      updatedBy: user.id
    };
    assignIfDefined(data, "costPeriod", dto.costPeriod);
    assignIfDefined(data, "periodStart", dto.periodStart ? nextPeriodStart : undefined);
    assignIfDefined(data, "periodEnd", dto.periodEnd ? nextPeriodEnd : undefined);
    assignIfDefined(
      data,
      "depreciationAmount",
      dto.depreciationAmount === undefined
        ? undefined
        : moneyOrThrow(dto.depreciationAmount, "depreciationAmount")
    );
    assignIfDefined(data, "currency", normalizeOptionalText(dto.currency));
    assignIfDefined(data, "recordStatus", dto.recordStatus);
    assignIfDefined(data, "recordSource", dto.recordSource);
    assignIfDefined(data, "remark", normalizeOptionalText(dto.remark));

    const record = await this.prisma.vehicleDepreciationRecord.update({
      data,
      include: recordInclude,
      where: { id }
    });
    return toRecordView(record);
  }

  async confirmRecord(id: string, dto: VehicleDepreciationRecordActionDto, user: RequestUser) {
    const record = await this.findRecordOrThrow(id);
    assertRecordStatus(record, [VehicleDepreciationRecordStatus.DRAFT], "Only draft depreciation records can be confirmed.");
    return this.updateRecordAction(record.id, {
      confirmedAt: new Date(),
      recordStatus: VehicleDepreciationRecordStatus.CONFIRMED,
      remark: normalizeOptionalText(dto.remark),
      updatedBy: user.id
    });
  }

  async voidRecord(id: string, dto: VehicleDepreciationRecordActionDto, user: RequestUser) {
    const record = await this.findRecordOrThrow(id);
    if (record.recordStatus === VehicleDepreciationRecordStatus.LOCKED) {
      throw new BadRequestException("Locked depreciation records cannot be voided.");
    }
    return this.updateRecordAction(record.id, {
      recordStatus: VehicleDepreciationRecordStatus.VOIDED,
      remark: normalizeOptionalText(dto.remark),
      updatedBy: user.id,
      voidedAt: new Date()
    });
  }

  async lockRecord(id: string, dto: VehicleDepreciationRecordActionDto, user: RequestUser) {
    const record = await this.findRecordOrThrow(id);
    if (record.recordStatus === VehicleDepreciationRecordStatus.VOIDED) {
      throw new BadRequestException("Voided depreciation records cannot be locked.");
    }
    return this.updateRecordAction(record.id, {
      lockedAt: new Date(),
      recordStatus: VehicleDepreciationRecordStatus.LOCKED,
      remark: normalizeOptionalText(dto.remark),
      updatedBy: user.id
    });
  }

  async getVehicleDepreciationSummary(vehicleId: string) {
    await this.findVehicleOrThrow(vehicleId);
    const policies = await this.prisma.vehicleDepreciationPolicy.findMany({
      include: policyInclude,
      orderBy: [{ policyStatus: "asc" }, { depreciationStartDate: "desc" }],
      where: { deletedAt: null, vehicleId }
    });
    const activePolicy =
      policies.find((policy) => policy.policyStatus === VehicleDepreciationPolicyStatus.ACTIVE) ?? null;
    const activeRecords = activePolicy?.records ?? [];
    return {
      activePolicy: activePolicy ? toPolicyView(activePolicy) : null,
      confirmedRecordCount: activeRecords.filter(isConfirmedOrLockedRecord).length,
      lockedRecordCount: activeRecords.filter(
        (record) => record.recordStatus === VehicleDepreciationRecordStatus.LOCKED
      ).length,
      policies: policies.slice(0, 5).map(toPolicyView),
      policyCount: policies.length,
      scheduleCount: activePolicy?.schedules.length ?? 0
    };
  }

  private async updatePolicyStatus(id: string, data: Prisma.VehicleDepreciationPolicyUncheckedUpdateInput) {
    await this.findPolicyOrThrow(id);
    const policy = await this.prisma.vehicleDepreciationPolicy.update({
      data,
      include: policyInclude,
      where: { id }
    });
    return toPolicyView(policy);
  }

  private async updateRecordAction(id: string, data: Prisma.VehicleDepreciationRecordUncheckedUpdateInput) {
    const record = await this.prisma.vehicleDepreciationRecord.update({
      data,
      include: recordInclude,
      where: { id }
    });
    return toRecordView(record);
  }

  private async findPolicyOrThrow(id: string) {
    const policy = await this.prisma.vehicleDepreciationPolicy.findFirst({
      include: policyInclude,
      where: { deletedAt: null, id }
    });
    if (!policy) {
      throw new NotFoundException("Depreciation policy not found.");
    }
    return policy;
  }

  private async findScheduleOrThrow(id: string) {
    const schedule = await this.prisma.vehicleDepreciationSchedule.findFirst({
      include: scheduleInclude,
      where: { deletedAt: null, id }
    });
    if (!schedule) {
      throw new NotFoundException("Depreciation schedule not found.");
    }
    return schedule;
  }

  private async findRecordOrThrow(id: string) {
    const record = await this.prisma.vehicleDepreciationRecord.findFirst({
      include: recordInclude,
      where: { deletedAt: null, id }
    });
    if (!record) {
      throw new NotFoundException("Depreciation record not found.");
    }
    return record;
  }

  private async findVehicleOrThrow(id: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      select: vehicleBriefSelect,
      where: { deletedAt: null, id }
    });
    if (!vehicle) {
      throw new NotFoundException("Vehicle not found.");
    }
    return vehicle;
  }
}

interface NormalizedPolicyValues {
  assetCostProfileId?: string | null;
  basisSource: Prisma.VehicleDepreciationPolicyUncheckedCreateInput["basisSource"];
  currency: string;
  depreciationBasisAmount: bigint;
  depreciationEndDate: Date | null;
  depreciationMethod: VehicleDepreciationMethod;
  depreciationStartDate: Date;
  monthlyDepreciationAmount: bigint | null;
  remark?: string | null;
  residualValueAmount: bigint;
  usefulLifeMonths?: number | null;
}

function normalizePolicyInput(
  dto: Pick<
    CreateVehicleDepreciationPolicyDto,
    | "assetCostProfileId"
    | "basisSource"
    | "currency"
    | "depreciationBasisAmount"
    | "depreciationEndDate"
    | "depreciationMethod"
    | "depreciationStartDate"
    | "remark"
    | "residualValueAmount"
    | "usefulLifeMonths"
  >,
  purchasePriceAmount: bigint | number
): NormalizedPolicyValues {
  const depreciationBasisAmount =
    dto.depreciationBasisAmount === undefined
      ? BigInt(numberFromBigInt(purchasePriceAmount))
      : moneyOrThrow(dto.depreciationBasisAmount, "depreciationBasisAmount");
  const residualValueAmount = moneyOrThrow(dto.residualValueAmount ?? 0, "residualValueAmount");
  const usefulLifeMonths = dto.usefulLifeMonths ?? null;
  const depreciationStartDate = parseDateOnly(dto.depreciationStartDate, "depreciationStartDate");
  const inferredEndDate =
    usefulLifeMonths && usefulLifeMonths > 0
      ? addDays(addMonths(firstDayOfMonth(depreciationStartDate), usefulLifeMonths), -1)
      : null;
  const depreciationEndDate =
    dto.depreciationEndDate === undefined
      ? inferredEndDate
      : dto.depreciationEndDate
        ? parseDateOnly(dto.depreciationEndDate, "depreciationEndDate")
        : null;
  const monthlyDepreciationAmount = monthlyDepreciationAmountFor(
    dto.depreciationMethod,
    depreciationBasisAmount,
    residualValueAmount,
    usefulLifeMonths
  );

  return {
    assetCostProfileId: dto.assetCostProfileId ?? null,
    basisSource: dto.basisSource ?? "PURCHASE_COST",
    currency: normalizeOptionalText(dto.currency) ?? "CNY",
    depreciationBasisAmount,
    depreciationEndDate,
    depreciationMethod: dto.depreciationMethod,
    depreciationStartDate,
    monthlyDepreciationAmount,
    remark: normalizeOptionalText(dto.remark),
    residualValueAmount,
    usefulLifeMonths
  };
}

function policyValuesFromPolicy(policy: PolicyWithRelations): NormalizedPolicyValues {
  return {
    assetCostProfileId: policy.assetCostProfileId,
    basisSource: policy.basisSource,
    currency: policy.currency ?? "CNY",
    depreciationBasisAmount: policy.depreciationBasisAmount,
    depreciationEndDate: policy.depreciationEndDate,
    depreciationMethod: policy.depreciationMethod,
    depreciationStartDate: policy.depreciationStartDate,
    monthlyDepreciationAmount: policy.monthlyDepreciationAmount,
    remark: policy.remark,
    residualValueAmount: policy.residualValueAmount,
    usefulLifeMonths: policy.usefulLifeMonths
  };
}

function assertPolicyRules(policy: NormalizedPolicyValues) {
  if (policy.depreciationBasisAmount < 0n || policy.residualValueAmount < 0n) {
    throw new BadRequestException("Depreciation amounts must be non-negative cents.");
  }
  if (policy.depreciationMethod === VehicleDepreciationMethod.STRAIGHT_LINE) {
    if (!policy.usefulLifeMonths || policy.usefulLifeMonths <= 0) {
      throw new BadRequestException("STRAIGHT_LINE depreciation requires usefulLifeMonths > 0.");
    }
    if (policy.depreciationBasisAmount <= policy.residualValueAmount) {
      throw new BadRequestException("STRAIGHT_LINE depreciation basis must exceed residual value.");
    }
  }
  if (policy.depreciationEndDate) {
    assertDateOrder(policy.depreciationStartDate, policy.depreciationEndDate);
  }
}

function monthlyDepreciationAmountFor(
  method: VehicleDepreciationMethod,
  basis: bigint,
  residual: bigint,
  usefulLifeMonths?: number | null
) {
  if (method === VehicleDepreciationMethod.NONE) {
    return 0n;
  }
  if (method === VehicleDepreciationMethod.MANUAL || !usefulLifeMonths) {
    return null;
  }
  return (basis - residual) / BigInt(usefulLifeMonths);
}

interface ScheduleCandidate {
  costPeriod: string;
  periodEnd: Date;
  periodStart: Date;
  scheduledAmount: bigint;
}

function buildStraightLineScheduleCandidates(policy: PolicyWithRelations): ScheduleCandidate[] {
  const usefulLifeMonths = policy.usefulLifeMonths ?? 0;
  const depreciableAmount = policy.depreciationBasisAmount - policy.residualValueAmount;
  const monthlyBaseAmount = depreciableAmount / BigInt(usefulLifeMonths);
  const roundingRemainder = depreciableAmount - monthlyBaseAmount * BigInt(usefulLifeMonths);
  const firstMonth = firstDayOfMonth(policy.depreciationStartDate);
  const schedules: ScheduleCandidate[] = [];

  for (let index = 0; index < usefulLifeMonths; index += 1) {
    const monthStart = addMonths(firstMonth, index);
    const periodStart = index === 0 ? policy.depreciationStartDate : monthStart;
    const periodEnd = lastDayOfMonth(monthStart);
    schedules.push({
      costPeriod: formatCostPeriod(monthStart),
      periodEnd,
      periodStart,
      scheduledAmount:
        index === usefulLifeMonths - 1 ? monthlyBaseAmount + roundingRemainder : monthlyBaseAmount
    });
  }

  return schedules;
}

function toPolicyView(policy: PolicyWithRelations) {
  return {
    activatedAt: toIso(policy.activatedAt),
    archivedAt: toIso(policy.archivedAt),
    assetCostProfileId: policy.assetCostProfileId,
    basisSource: policy.basisSource,
    confirmedRecordCount: policy.records.filter(isConfirmedOrLockedRecord).length,
    createdAt: toIso(policy.createdAt),
    currency: policy.currency,
    depreciationBasisAmount: numberFromBigInt(policy.depreciationBasisAmount),
    depreciationEndDate: toIsoDate(policy.depreciationEndDate),
    depreciationMethod: policy.depreciationMethod,
    depreciationStartDate: toIsoDate(policy.depreciationStartDate),
    id: policy.id,
    monthlyDepreciationAmount:
      policy.monthlyDepreciationAmount === null ? null : numberFromBigInt(policy.monthlyDepreciationAmount),
    policyNo: policy.policyNo,
    policyStatus: policy.policyStatus,
    recordCount: policy.records.length,
    records: policy.records.map(toRecordSummary),
    remark: policy.remark,
    residualValueAmount: numberFromBigInt(policy.residualValueAmount),
    scheduleCount: policy.schedules.length,
    schedules: policy.schedules.map(toScheduleSummary),
    suspendedAt: toIso(policy.suspendedAt),
    terminatedAt: toIso(policy.terminatedAt),
    updatedAt: toIso(policy.updatedAt),
    usefulLifeMonths: policy.usefulLifeMonths,
    vehicle: toVehicleBrief(policy.vehicle),
    vehicleId: policy.vehicleId
  };
}

function toScheduleView(schedule: ScheduleWithRelations) {
  return {
    confirmedAt: toIso(schedule.confirmedAt),
    costPeriod: schedule.costPeriod,
    createdAt: toIso(schedule.createdAt),
    currency: schedule.currency,
    generatedAt: toIso(schedule.generatedAt),
    id: schedule.id,
    lockedAt: toIso(schedule.lockedAt),
    periodEnd: toIsoDate(schedule.periodEnd),
    periodStart: toIsoDate(schedule.periodStart),
    policy: schedule.policy,
    policyId: schedule.policyId,
    records: schedule.records.map(toRecordSummary),
    remark: schedule.remark,
    scheduleNo: schedule.scheduleNo,
    scheduleStatus: schedule.scheduleStatus,
    scheduledAmount: numberFromBigInt(schedule.scheduledAmount),
    updatedAt: toIso(schedule.updatedAt),
    vehicle: toVehicleBrief(schedule.vehicle),
    vehicleId: schedule.vehicleId,
    voidedAt: toIso(schedule.voidedAt)
  };
}

function toRecordView(record: RecordWithRelations) {
  return {
    confirmedAt: toIso(record.confirmedAt),
    costPeriod: record.costPeriod,
    createdAt: toIso(record.createdAt),
    currency: record.currency,
    depreciationAmount: numberFromBigInt(record.depreciationAmount),
    id: record.id,
    lockedAt: toIso(record.lockedAt),
    periodEnd: toIsoDate(record.periodEnd),
    periodStart: toIsoDate(record.periodStart),
    policy: record.policy,
    policyId: record.policyId,
    recordNo: record.recordNo,
    recordSource: record.recordSource,
    recordStatus: record.recordStatus,
    remark: record.remark,
    schedule: record.schedule,
    scheduleId: record.scheduleId,
    updatedAt: toIso(record.updatedAt),
    vehicle: toVehicleBrief(record.vehicle),
    vehicleId: record.vehicleId,
    voidedAt: toIso(record.voidedAt)
  };
}

function toScheduleSummary(schedule: VehicleDepreciationSchedule) {
  return {
    costPeriod: schedule.costPeriod,
    currency: schedule.currency,
    id: schedule.id,
    periodEnd: toIsoDate(schedule.periodEnd),
    periodStart: toIsoDate(schedule.periodStart),
    scheduleNo: schedule.scheduleNo,
    scheduleStatus: schedule.scheduleStatus,
    scheduledAmount: numberFromBigInt(schedule.scheduledAmount)
  };
}

function toRecordSummary(record: VehicleDepreciationRecord) {
  return {
    costPeriod: record.costPeriod,
    currency: record.currency,
    depreciationAmount: numberFromBigInt(record.depreciationAmount),
    id: record.id,
    periodEnd: toIsoDate(record.periodEnd),
    periodStart: toIsoDate(record.periodStart),
    recordNo: record.recordNo,
    recordSource: record.recordSource,
    recordStatus: record.recordStatus,
    scheduleId: record.scheduleId
  };
}

function toVehicleBrief(vehicle: {
  brand: string;
  id: string;
  model?: string | null;
  plateNo?: string | null;
  purchasePriceAmount: bigint | number;
  series?: string | null;
  vehicleNo: string;
}) {
  return {
    brand: vehicle.brand,
    displayName: [vehicle.vehicleNo, vehicle.plateNo, vehicle.brand, vehicle.series, vehicle.model]
      .filter(Boolean)
      .join(" / "),
    id: vehicle.id,
    model: vehicle.model,
    plateNo: vehicle.plateNo,
    purchasePriceAmount: numberFromBigInt(vehicle.purchasePriceAmount),
    series: vehicle.series,
    vehicleNo: vehicle.vehicleNo
  };
}

function assertScheduleStatus(
  schedule: VehicleDepreciationSchedule,
  allowed: VehicleDepreciationScheduleStatus[],
  message: string
) {
  if (!allowed.includes(schedule.scheduleStatus)) {
    throw new BadRequestException(message);
  }
}

function assertRecordStatus(record: VehicleDepreciationRecord, allowed: VehicleDepreciationRecordStatus[], message: string) {
  if (!allowed.includes(record.recordStatus)) {
    throw new BadRequestException(message);
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

function parseCostPeriod(value: string) {
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new BadRequestException("costPeriod must use YYYY-MM format.");
  }
  const [yearText, monthText] = value.split("-");
  const month = Number(monthText);
  if (Number(yearText) < 1900 || month < 1 || month > 12) {
    throw new BadRequestException("costPeriod month must be between 01 and 12.");
  }
  return new Date(Date.UTC(Number(yearText), month - 1, 1));
}

function formatCostPeriod(value: Date) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseDateOnly(value: string | null | undefined, field: string) {
  if (!value) {
    throw new BadRequestException(`${field} is required.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date.`);
  }
  return parsed;
}

function firstDayOfMonth(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function lastDayOfMonth(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));
}

function addMonths(value: Date, months: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function assertDateOrder(from: Date, to: Date) {
  if (from.getTime() > to.getTime()) {
    throw new BadRequestException("periodStart cannot be later than periodEnd.");
  }
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
    throw new BadRequestException(`${field} must be a non-negative integer amount in cents.`);
  }
  return BigInt(value);
}

function numberFromBigInt(value: bigint | number) {
  return typeof value === "bigint" ? Number(value) : value;
}

function toIso(value?: Date | null) {
  return value ? value.toISOString() : null;
}

function toIsoDate(value?: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function toRequiredIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function isConfirmedOrLockedRecord(record: Pick<VehicleDepreciationRecord, "recordStatus">) {
  return (
    record.recordStatus === VehicleDepreciationRecordStatus.CONFIRMED ||
    record.recordStatus === VehicleDepreciationRecordStatus.LOCKED
  );
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) {
    target[key] = value;
  }
}
