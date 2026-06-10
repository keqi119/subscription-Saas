import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AuditAction,
  FinancingAllocationStatus,
  FinancingInstrument,
  FinancingInstrumentStatus,
  Prisma,
  VehicleAssetPoolStatus,
  VehicleAssetPoolVehicleStatus,
  VehiclePoolAllocationMethod
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import {
  AllocateFinancingInstrumentVehicleDto,
  CreateFinancingInstrumentDto,
  ExecuteVehiclePoolAllocationDto,
  FinancingInstrumentsQueryDto,
  ReleaseFinancingAllocationDto,
  SettleFinancingInstrumentDto,
  UpdateFinancingInstrumentDto,
  VehiclePoolAllocationPreviewDto
} from "./dto/financing.dto";

const instrumentDetailInclude = {
  capitalEvents: {
    orderBy: [{ effectiveFrom: "desc" as const }, { createdAt: "desc" as const }],
    where: { deletedAt: null }
  },
  vehicles: {
    include: {
      vehicle: {
        select: {
          acquisitionMode: true,
          brand: true,
          id: true,
          model: true,
          plateNo: true,
          purchasePriceAmount: true,
          vehicleNo: true,
          vin: true
        }
      }
    },
    orderBy: [{ effectiveFrom: "desc" as const }, { createdAt: "desc" as const }],
    where: { deletedAt: null }
  }
} satisfies Prisma.FinancingInstrumentInclude;

type FinancingInstrumentDetail = Prisma.FinancingInstrumentGetPayload<{
  include: typeof instrumentDetailInclude;
}>;

type VehiclePoolAllocationItem = {
  action: "CREATE" | "SKIP";
  allocatedPrincipalAmount: bigint;
  allocationRatioBps: number | null;
  currentSalePriceAmount: bigint | null;
  plateNo: string | null;
  purchasePriceAmount: bigint | null;
  reason: string | null;
  vehicleAcquisitionMode: string;
  vehicleCoverageBps: number | null;
  vehicleId: string;
  vehicleModel: string | null;
  vehicleNo: string;
  vin: string | null;
};

type VehiclePoolAllocationPlan = {
  activeAllocatedAmount: bigint;
  allocationMethod: VehiclePoolAllocationMethod;
  coverageRateBps: number;
  effectiveFrom: Date;
  exceedsRemainingPrincipalAmount: boolean;
  instrument: FinancingInstrument;
  items: VehiclePoolAllocationItem[];
  plannedAllocatedPrincipalAmount: bigint;
  pool: {
    id: string;
    poolName: string;
    poolNo: string;
    poolStatus: VehicleAssetPoolStatus;
    poolType: string;
  };
  poolVehicleCount: number;
  remainingPrincipalAmount: bigint;
};

@Injectable()
export class FinancingService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async listInstruments(query: FinancingInstrumentsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.FinancingInstrumentWhereInput = {
      deletedAt: null,
      instrumentStatus: query.instrumentStatus,
      instrumentType: query.instrumentType,
      lenderName: query.lenderName ? { contains: query.lenderName, mode: "insensitive" } : undefined
    };

    const [total, instruments] = await Promise.all([
      this.prisma.financingInstrument.count({ where }),
      this.prisma.financingInstrument.findMany({
        orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      })
    ]);

    return {
      items: instruments.map(toInstrumentView),
      page,
      pageSize,
      total
    };
  }

  async getInstrument(id: string) {
    return toInstrumentDetailView(await this.findInstrumentOrThrow(id));
  }

  async createInstrument(
    dto: CreateFinancingInstrumentDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const fields = buildInstrumentCreateData(dto);
    const instrument = await withUniqueBusinessNoRetry(() =>
      this.prisma.financingInstrument.create({
        data: {
          ...fields,
          createdBy: user.id,
          instrumentNo: createBusinessNo("FI"),
          updatedBy: user.id
        }
      })
    );

    await this.writeAudit(AuditAction.CREATE, instrument.id, undefined, toInstrumentView(instrument), user, context, {
      instrumentId: instrument.id,
      remark: dto.remark
    });

    return toInstrumentView(instrument);
  }

  async updateInstrument(
    id: string,
    dto: UpdateFinancingInstrumentDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findInstrumentRecordOrThrow(id);
    const data = buildInstrumentUpdateData(dto, before);
    const instrument = await this.prisma.financingInstrument.update({
      data: {
        ...data,
        updatedBy: user.id
      },
      where: { id }
    });

    await this.writeAudit(AuditAction.UPDATE, id, toInstrumentView(before), toInstrumentView(instrument), user, context, {
      instrumentId: id,
      remark: dto.remark
    });

    return toInstrumentView(instrument);
  }

  async settleInstrument(
    id: string,
    dto: SettleFinancingInstrumentDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findInstrumentRecordOrThrow(id);
    const settledAt = parseDateOnly(dto.settledAt, "settledAt");
    const result = await this.prisma.$transaction(async (tx) => {
      const activeAllocations = await tx.financingInstrumentVehicle.findMany({
        where: activeAllocationWhere(id)
      });
      const instrument = await tx.financingInstrument.update({
        data: {
          instrumentStatus: FinancingInstrumentStatus.SETTLED,
          updatedBy: user.id
        },
        where: { id }
      });

      if (activeAllocations.length > 0) {
        await tx.financingInstrumentVehicle.updateMany({
          data: {
            allocationStatus: FinancingAllocationStatus.RELEASED,
            effectiveTo: settledAt,
            updatedBy: user.id
          },
          where: activeAllocationWhere(id)
        });
      }

      return { activeAllocations, instrument };
    });

    await this.writeAudit(
      AuditAction.UPDATE,
      id,
      toInstrumentView(before),
      {
        ...toInstrumentView(result.instrument),
        releasedAllocationCount: result.activeAllocations.length,
        settledAt
      },
      user,
      context,
      { instrumentId: id, remark: dto.remark }
    );

    for (const allocation of result.activeAllocations) {
      await this.writeAudit(
        AuditAction.UPDATE,
        allocation.id,
        toAllocationView(allocation),
        toAllocationView({
          ...allocation,
          allocationStatus: FinancingAllocationStatus.RELEASED,
          effectiveTo: settledAt,
          updatedBy: user.id
        }),
        user,
        context,
        {
          allocationId: allocation.id,
          instrumentId: id,
          remark: dto.remark,
          vehicleId: allocation.vehicleId
        },
        "financing_instrument_vehicle"
      );
    }

    return this.getInstrument(id);
  }

  async allocateVehicle(
    id: string,
    dto: AllocateFinancingInstrumentVehicleDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const instrument = await this.findInstrumentRecordOrThrow(id);
    if (instrument.instrumentStatus !== FinancingInstrumentStatus.ACTIVE) {
      throw new BadRequestException("融资工具不是生效中状态，不能新增车辆分摊");
    }

    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: dto.vehicleId } });
    if (!vehicle || vehicle.deletedAt) {
      throw new NotFoundException("车辆不存在");
    }

    const activeDuplicate = await this.prisma.financingInstrumentVehicle.findFirst({
      where: {
        allocationStatus: FinancingAllocationStatus.ACTIVE,
        deletedAt: null,
        instrumentId: id,
        vehicleId: dto.vehicleId
      }
    });

    if (activeDuplicate) {
      throw new BadRequestException("同一融资工具与车辆已存在生效分摊");
    }

    assertOptionalPositiveInteger(dto.allocatedPrincipalAmount, "车辆分摊融资本金必须大于 0");
    assertAllocationRatio(dto.allocationRatioBps);
    const allocatedAmount = BigInt(dto.allocatedPrincipalAmount);
    const activeAllocatedAmount = await this.getActiveAllocatedAmount(id);
    if (activeAllocatedAmount + allocatedAmount > instrument.principalAmount) {
      throw new BadRequestException("融资工具车辆分摊金额合计不能超过融资本金");
    }

    const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
    const fields = {
      allocatedPrincipalAmount: allocatedAmount,
      allocationRatioBps: dto.allocationRatioBps ?? null,
      allocationStatus: FinancingAllocationStatus.ACTIVE,
      effectiveFrom,
      remark: dto.remark ?? null
    };
    const allocation = await withUniqueBusinessNoRetry(() =>
      this.prisma.financingInstrumentVehicle.create({
        data: {
          ...fields,
          allocationNo: createBusinessNo("FIA"),
          createdBy: user.id,
          instrumentId: id,
          snapshot: buildAllocationSnapshot(instrument, vehicle, fields),
          updatedBy: user.id,
          vehicleId: dto.vehicleId
        }
      })
    );

    await this.writeAudit(
      AuditAction.CREATE,
      allocation.id,
      undefined,
      toAllocationView(allocation),
      user,
      context,
      {
        allocationId: allocation.id,
        instrumentId: id,
        remark: dto.remark,
        vehicleId: dto.vehicleId
      },
      "financing_instrument_vehicle"
    );

    return toAllocationView(allocation);
  }

  async releaseAllocation(
    id: string,
    allocationId: string,
    dto: ReleaseFinancingAllocationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.findInstrumentRecordOrThrow(id);
    const before = await this.prisma.financingInstrumentVehicle.findFirst({
      where: {
        allocationStatus: FinancingAllocationStatus.ACTIVE,
        deletedAt: null,
        id: allocationId,
        instrumentId: id
      }
    });

    if (!before) {
      throw new NotFoundException("车辆融资分摊不存在或已解除");
    }

    const releasedAt = parseDateOnly(dto.releasedAt, "releasedAt");
    const allocation = await this.prisma.financingInstrumentVehicle.update({
      data: {
        allocationStatus: FinancingAllocationStatus.RELEASED,
        effectiveTo: releasedAt,
        updatedBy: user.id
      },
      where: { id: allocationId }
    });

    await this.writeAudit(
      AuditAction.UPDATE,
      allocationId,
      toAllocationView(before),
      toAllocationView(allocation),
      user,
      context,
      {
        allocationId,
        instrumentId: id,
        remark: dto.remark,
        vehicleId: allocation.vehicleId
      },
      "financing_instrument_vehicle"
    );

    return toAllocationView(allocation);
  }

  async previewVehiclePoolAllocation(id: string, dto: VehiclePoolAllocationPreviewDto) {
    const plan = await this.buildVehiclePoolAllocationPlan(id, dto);
    return toVehiclePoolAllocationPreviewView(plan);
  }

  async executeVehiclePoolAllocation(
    id: string,
    dto: ExecuteVehiclePoolAllocationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const plan = await this.buildVehiclePoolAllocationPlan(id, dto);
    if (plan.exceedsRemainingPrincipalAmount) {
      throw new BadRequestException("池化分摊金额合计不能超过融资工具剩余可分摊本金");
    }

    const created: Array<ReturnType<typeof toAllocationView>> = [];
    const skipped = plan.items
      .filter((item) => item.action === "SKIP")
      .map((item) => toVehiclePoolAllocationItemView(item));
    const failed: Array<ReturnType<typeof toVehiclePoolAllocationItemView>> = [];

    for (const item of plan.items.filter((entry) => entry.action === "CREATE")) {
      try {
        const duplicate = await this.prisma.financingInstrumentVehicle.findFirst({
          where: {
            allocationStatus: FinancingAllocationStatus.ACTIVE,
            deletedAt: null,
            instrumentId: id,
            vehicleId: item.vehicleId
          }
        });
        if (duplicate) {
          skipped.push(
            toVehiclePoolAllocationItemView({
              ...item,
              action: "SKIP",
              reason: "该车辆已存在当前融资工具的生效分摊。"
            })
          );
          continue;
        }

        const fields = {
          allocatedPrincipalAmount: item.allocatedPrincipalAmount,
          allocationRatioBps: item.allocationRatioBps,
          allocationStatus: FinancingAllocationStatus.ACTIVE,
          effectiveFrom: plan.effectiveFrom,
          remark: dto.remark ?? null
        };
        const allocation = await withUniqueBusinessNoRetry(() =>
          this.prisma.financingInstrumentVehicle.create({
            data: {
              ...fields,
              allocationNo: createBusinessNo("FIA"),
              createdBy: user.id,
              instrumentId: id,
              snapshot: buildAllocationSnapshot(
                plan.instrument,
                {
                  acquisitionMode: item.vehicleAcquisitionMode,
                  id: item.vehicleId,
                  purchasePriceAmount: item.purchasePriceAmount ?? 0n,
                  vehicleNo: item.vehicleNo
                },
                fields,
                {
                  allocationMethod: plan.allocationMethod,
                  coverageRateBps: plan.coverageRateBps,
                  poolId: plan.pool.id,
                  poolName: plan.pool.poolName,
                  poolNo: plan.pool.poolNo
                }
              ),
              updatedBy: user.id,
              vehicleId: item.vehicleId
            }
          })
        );
        created.push(toAllocationView(allocation));
      } catch (error) {
        failed.push(
          toVehiclePoolAllocationItemView({
            ...item,
            action: "SKIP",
            reason: error instanceof Error ? error.message : "池化融资分摊失败"
          })
        );
      }
    }

    const totalAllocatedPrincipalAmount = created.reduce(
      (total, allocation) => total + BigInt(allocation.allocatedPrincipalAmount),
      0n
    );
    const result = {
      allocationMethod: plan.allocationMethod,
      coverageRateBps: plan.coverageRateBps,
      created,
      createdCount: created.length,
      failed,
      failedCount: failed.length,
      instrumentId: id,
      poolId: plan.pool.id,
      skipped,
      skippedCount: skipped.length,
      totalAllocatedPrincipalAmount: Number(totalAllocatedPrincipalAmount)
    };

    await this.writeAudit(
      AuditAction.CREATE,
      id,
      undefined,
      result,
      user,
      context,
      {
        allocationMethod: plan.allocationMethod,
        coverageRateBps: plan.coverageRateBps,
        instrumentId: id,
        poolId: plan.pool.id,
        remark: dto.remark
      },
      "financing_vehicle_pool_allocation"
    );

    return result;
  }

  private async findInstrumentOrThrow(id: string) {
    const instrument = await this.prisma.financingInstrument.findUnique({
      include: instrumentDetailInclude,
      where: { id }
    });

    if (!instrument || instrument.deletedAt) {
      throw new NotFoundException("融资工具不存在");
    }

    return instrument;
  }

  private async findInstrumentRecordOrThrow(id: string) {
    const instrument = await this.prisma.financingInstrument.findUnique({
      where: { id }
    });

    if (!instrument || instrument.deletedAt) {
      throw new NotFoundException("融资工具不存在");
    }

    return instrument;
  }

  private async getActiveAllocatedAmount(instrumentId: string) {
    const total = await this.prisma.financingInstrumentVehicle.aggregate({
      _sum: { allocatedPrincipalAmount: true },
      where: activeAllocationWhere(instrumentId)
    });

    return total._sum.allocatedPrincipalAmount ?? 0n;
  }

  private async buildVehiclePoolAllocationPlan(
    id: string,
    dto: VehiclePoolAllocationPreviewDto
  ): Promise<VehiclePoolAllocationPlan> {
    const instrument = await this.findInstrumentRecordOrThrow(id);
    if (instrument.instrumentStatus !== FinancingInstrumentStatus.ACTIVE) {
      throw new BadRequestException("融资工具不是生效中状态，不能执行池化融资分摊");
    }
    if (dto.allocationMethod !== VehiclePoolAllocationMethod.UNIFORM_PURCHASE_PRICE_COVERAGE) {
      throw new BadRequestException("当前分摊方法暂未实现。");
    }
    assertCoverageRateBps(dto.coverageRateBps);
    const coverageRateBps = dto.coverageRateBps as number;
    const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");

    const pool = await this.prisma.vehicleAssetPool.findUnique({
      include: {
        vehicles: {
          include: {
            vehicle: {
              select: {
                acquisitionMode: true,
                currentSalePriceAmount: true,
                id: true,
                plateNo: true,
                purchasePriceAmount: true,
                vehicleModel: true,
                vehicleNo: true,
                vin: true
              }
            }
          },
          orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }],
          where: {
            deletedAt: null,
            membershipStatus: VehicleAssetPoolVehicleStatus.ACTIVE
          }
        }
      },
      where: { id: dto.poolId }
    });
    if (!pool || pool.deletedAt) {
      throw new NotFoundException("车辆池不存在");
    }
    if (pool.poolStatus !== VehicleAssetPoolStatus.ACTIVE) {
      throw new BadRequestException("车辆池不是生效中状态，不能执行池化融资分摊");
    }

    const [activeAllocatedAmount, activeAllocations] = await Promise.all([
      this.getActiveAllocatedAmount(id),
      this.prisma.financingInstrumentVehicle.findMany({
        where: activeAllocationWhere(id)
      })
    ]);
    const remainingPrincipalAmount = instrument.principalAmount - activeAllocatedAmount;
    const activeVehicleIds = new Set(activeAllocations.map((allocation) => allocation.vehicleId));
    const items = pool.vehicles.map((membership): VehiclePoolAllocationItem => {
      const vehicle = membership.vehicle;
      if (activeVehicleIds.has(vehicle.id)) {
        return buildSkippedPoolAllocationItem(vehicle, "该车辆已存在当前融资工具的生效分摊。");
      }
      if (vehicle.purchasePriceAmount <= 0n) {
        return buildSkippedPoolAllocationItem(vehicle, "车辆采购价缺失，无法按采购价覆盖率分摊。");
      }

      const allocatedPrincipalAmount = calculateBpsAmount(vehicle.purchasePriceAmount, coverageRateBps);
      if (allocatedPrincipalAmount <= 0n) {
        return buildSkippedPoolAllocationItem(vehicle, "按当前覆盖率计算的分摊本金为 0，已跳过。");
      }

      return {
        action: "CREATE",
        allocatedPrincipalAmount,
        allocationRatioBps: calculateRatioBps(allocatedPrincipalAmount, instrument.principalAmount),
        currentSalePriceAmount: vehicle.currentSalePriceAmount,
        plateNo: vehicle.plateNo,
        purchasePriceAmount: vehicle.purchasePriceAmount,
        reason: null,
        vehicleAcquisitionMode: vehicle.acquisitionMode,
        vehicleCoverageBps: calculateRatioBps(allocatedPrincipalAmount, vehicle.purchasePriceAmount),
        vehicleId: vehicle.id,
        vehicleModel: vehicle.vehicleModel,
        vehicleNo: vehicle.vehicleNo,
        vin: vehicle.vin
      };
    });
    const plannedAllocatedPrincipalAmount = items
      .filter((item) => item.action === "CREATE")
      .reduce((total, item) => total + item.allocatedPrincipalAmount, 0n);

    return {
      activeAllocatedAmount,
      allocationMethod: dto.allocationMethod,
      coverageRateBps,
      effectiveFrom,
      exceedsRemainingPrincipalAmount: plannedAllocatedPrincipalAmount > remainingPrincipalAmount,
      instrument,
      items,
      plannedAllocatedPrincipalAmount,
      pool: {
        id: pool.id,
        poolName: pool.poolName,
        poolNo: pool.poolNo,
        poolStatus: pool.poolStatus,
        poolType: pool.poolType
      },
      poolVehicleCount: pool.vehicles.length,
      remainingPrincipalAmount
    };
  }

  private async writeAudit(
    action: AuditAction,
    entityId: string,
    before: unknown,
    after: unknown,
    user: RequestUser,
    context: RequestContext,
    payload: {
      allocationId?: string;
      allocationMethod?: string;
      coverageRateBps?: number;
      instrumentId?: string;
      poolId?: string;
      remark?: string | null;
      vehicleId?: string;
    },
    entityType = "financing_instrument"
  ) {
    await this.auditService.write({
      action,
      after: { ...payload, after },
      before: before === undefined ? undefined : { ...payload, before },
      entityId,
      entityType,
      ipAddress: context.ipAddress,
      module: "financing",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }
}

function activeAllocationWhere(instrumentId: string): Prisma.FinancingInstrumentVehicleWhereInput {
  return {
    allocationStatus: FinancingAllocationStatus.ACTIVE,
    deletedAt: null,
    instrumentId
  };
}

function buildInstrumentCreateData(
  dto: CreateFinancingInstrumentDto
): Omit<Prisma.FinancingInstrumentUncheckedCreateInput, "createdBy" | "instrumentNo" | "updatedBy"> {
  const startDate = parseDateOnly(dto.startDate, "startDate");
  const maturityDate = parseOptionalDateOnly(dto.maturityDate, "maturityDate") ?? null;
  assertDateRange(startDate, maturityDate);
  assertOptionalPositiveInteger(dto.principalAmount, "融资本金必须大于 0");
  assertOptionalNonNegativeInteger(dto.annualRateBps, "债务年化利率必须大于等于 0");
  assertOptionalPositiveInteger(dto.termMonths, "融资期限必须大于 0");

  const fields = {
    annualRateBps: dto.annualRateBps ?? null,
    collateralType: dto.collateralType ?? null,
    contractNo: dto.contractNo ?? null,
    instrumentStatus: FinancingInstrumentStatus.ACTIVE,
    instrumentType: dto.instrumentType,
    lenderName: dto.lenderName ?? null,
    maturityDate,
    principalAmount: BigInt(dto.principalAmount),
    remark: dto.remark ?? null,
    repaymentMethod: dto.repaymentMethod ?? null,
    startDate,
    termMonths: dto.termMonths ?? null
  };

  return {
    ...fields,
    snapshot: buildInstrumentSnapshot(fields)
  };
}

function buildInstrumentUpdateData(
  dto: UpdateFinancingInstrumentDto,
  before: FinancingInstrument
): Prisma.FinancingInstrumentUncheckedUpdateInput {
  assertOptionalPositiveInteger(dto.principalAmount, "融资本金必须大于 0");
  assertOptionalNonNegativeInteger(dto.annualRateBps, "债务年化利率必须大于等于 0");
  assertOptionalPositiveInteger(dto.termMonths, "融资期限必须大于 0");

  const data: Prisma.FinancingInstrumentUncheckedUpdateInput = {};
  assignIfDefined(data, "annualRateBps", dto.annualRateBps);
  assignIfDefined(data, "collateralType", dto.collateralType);
  assignIfDefined(data, "contractNo", dto.contractNo);
  assignIfDefined(data, "instrumentStatus", dto.instrumentStatus);
  assignIfDefined(data, "instrumentType", dto.instrumentType);
  assignIfDefined(data, "lenderName", dto.lenderName);
  assignIfDefined(
    data,
    "maturityDate",
    dto.maturityDate === undefined ? undefined : parseOptionalDateOnly(dto.maturityDate, "maturityDate")
  );
  assignIfDefined(
    data,
    "principalAmount",
    dto.principalAmount === undefined ? undefined : BigInt(dto.principalAmount)
  );
  assignIfDefined(data, "remark", dto.remark);
  assignIfDefined(data, "repaymentMethod", dto.repaymentMethod);
  assignIfDefined(data, "startDate", dto.startDate === undefined ? undefined : parseDateOnly(dto.startDate, "startDate"));
  assignIfDefined(data, "termMonths", dto.termMonths);

  const nextStartDate = data.startDate instanceof Date ? data.startDate : before.startDate;
  const nextMaturityDate =
    data.maturityDate === undefined
      ? before.maturityDate
      : data.maturityDate instanceof Date
        ? data.maturityDate
        : null;
  assertDateRange(nextStartDate, nextMaturityDate);

  data.snapshot = buildInstrumentSnapshot({
    annualRateBps: valueOrExisting(data.annualRateBps as number | null | undefined, before.annualRateBps),
    collateralType: valueOrExisting(
      data.collateralType as FinancingInstrument["collateralType"] | undefined,
      before.collateralType
    ),
    contractNo: valueOrExisting(data.contractNo as string | null | undefined, before.contractNo),
    instrumentStatus:
      (data.instrumentStatus as FinancingInstrument["instrumentStatus"] | undefined) ?? before.instrumentStatus,
    instrumentType: (data.instrumentType as FinancingInstrument["instrumentType"] | undefined) ?? before.instrumentType,
    lenderName: valueOrExisting(data.lenderName as string | null | undefined, before.lenderName),
    maturityDate: nextMaturityDate,
    principalAmount:
      typeof data.principalAmount === "bigint" ? data.principalAmount : before.principalAmount,
    remark: valueOrExisting(data.remark as string | null | undefined, before.remark),
    repaymentMethod: valueOrExisting(
      data.repaymentMethod as FinancingInstrument["repaymentMethod"] | undefined,
      before.repaymentMethod
    ),
    startDate: nextStartDate,
    termMonths: valueOrExisting(data.termMonths as number | null | undefined, before.termMonths)
  });

  return data;
}

function buildInstrumentSnapshot(fields: {
  annualRateBps: number | null;
  collateralType: FinancingInstrument["collateralType"];
  contractNo: string | null;
  instrumentStatus: FinancingInstrument["instrumentStatus"];
  instrumentType: FinancingInstrument["instrumentType"];
  lenderName: string | null;
  maturityDate: Date | null;
  principalAmount: bigint;
  remark: string | null;
  repaymentMethod: FinancingInstrument["repaymentMethod"];
  startDate: Date;
  termMonths: number | null;
}): Prisma.InputJsonObject {
  return {
    annualRateBps: fields.annualRateBps,
    collateralType: fields.collateralType,
    contractNo: fields.contractNo,
    instrumentStatus: fields.instrumentStatus,
    instrumentType: fields.instrumentType,
    lenderName: fields.lenderName,
    maturityDate: fields.maturityDate ? formatDateOnly(fields.maturityDate) : null,
    principalAmount: Number(fields.principalAmount),
    remark: fields.remark,
    repaymentMethod: fields.repaymentMethod,
    startDate: formatDateOnly(fields.startDate),
    termMonths: fields.termMonths
  };
}

function buildAllocationSnapshot(
  instrument: FinancingInstrument,
  vehicle: { acquisitionMode: string; id: string; purchasePriceAmount: bigint; vehicleNo: string },
  fields: {
    allocatedPrincipalAmount: bigint;
    allocationRatioBps: number | null;
    allocationStatus: FinancingAllocationStatus;
    effectiveFrom: Date;
    remark: string | null;
  },
  poolContext?: {
    allocationMethod: string;
    coverageRateBps: number;
    poolId: string;
    poolName: string;
    poolNo: string;
  }
): Prisma.InputJsonObject {
  return {
    allocatedPrincipalAmount: Number(fields.allocatedPrincipalAmount),
    allocationRatioBps: fields.allocationRatioBps,
    allocationStatus: fields.allocationStatus,
    effectiveFrom: formatDateOnly(fields.effectiveFrom),
    instrumentId: instrument.id,
    instrumentNo: instrument.instrumentNo,
    principalAmount: Number(instrument.principalAmount),
    purchasePriceAmount: Number(vehicle.purchasePriceAmount),
    remark: fields.remark,
    ...(poolContext
      ? {
          vehicleAssetPoolAllocation: {
            allocationMethod: poolContext.allocationMethod,
            coverageRateBps: poolContext.coverageRateBps,
            poolId: poolContext.poolId,
            poolName: poolContext.poolName,
            poolNo: poolContext.poolNo
          }
        }
      : {}),
    vehicleAcquisitionMode: vehicle.acquisitionMode,
    vehicleId: vehicle.id,
    vehicleNo: vehicle.vehicleNo
  };
}

function buildSkippedPoolAllocationItem(
  vehicle: {
    acquisitionMode: string;
    currentSalePriceAmount: bigint | null;
    id: string;
    plateNo: string | null;
    purchasePriceAmount: bigint;
    vehicleModel: string | null;
    vehicleNo: string;
    vin: string | null;
  },
  reason: string
): VehiclePoolAllocationItem {
  return {
    action: "SKIP",
    allocatedPrincipalAmount: 0n,
    allocationRatioBps: null,
    currentSalePriceAmount: vehicle.currentSalePriceAmount,
    plateNo: vehicle.plateNo,
    purchasePriceAmount: vehicle.purchasePriceAmount,
    reason,
    vehicleAcquisitionMode: vehicle.acquisitionMode,
    vehicleCoverageBps: null,
    vehicleId: vehicle.id,
    vehicleModel: vehicle.vehicleModel,
    vehicleNo: vehicle.vehicleNo,
    vin: vehicle.vin
  };
}

function toVehiclePoolAllocationPreviewView(plan: VehiclePoolAllocationPlan) {
  return {
    activeAllocatedPrincipalAmount: Number(plan.activeAllocatedAmount),
    allocationMethod: plan.allocationMethod,
    allocatableVehicleCount: plan.items.filter((item) => item.action === "CREATE").length,
    coverageRateBps: plan.coverageRateBps,
    effectiveFrom: plan.effectiveFrom,
    exceedsRemainingPrincipalAmount: plan.exceedsRemainingPrincipalAmount,
    instrumentId: plan.instrument.id,
    instrumentNo: plan.instrument.instrumentNo,
    items: plan.items.map(toVehiclePoolAllocationItemView),
    plannedAllocatedPrincipalAmount: Number(plan.plannedAllocatedPrincipalAmount),
    pool: plan.pool,
    poolVehicleCount: plan.poolVehicleCount,
    principalAmount: Number(plan.instrument.principalAmount),
    remainingPrincipalAmount: Number(plan.remainingPrincipalAmount)
  };
}

function toVehiclePoolAllocationItemView(item: VehiclePoolAllocationItem) {
  return {
    action: item.action,
    allocatedPrincipalAmount: Number(item.allocatedPrincipalAmount),
    allocationRatioBps: item.allocationRatioBps,
    currentSalePriceAmount: numberOrNull(item.currentSalePriceAmount),
    plateNo: item.plateNo,
    purchasePriceAmount: numberOrNull(item.purchasePriceAmount),
    reason: item.reason,
    vehicleCoverageBps: item.vehicleCoverageBps,
    vehicleId: item.vehicleId,
    vehicleModel: item.vehicleModel,
    vehicleNo: item.vehicleNo,
    vin: item.vin
  };
}

function toInstrumentDetailView(instrument: FinancingInstrumentDetail) {
  const activeAllocatedPrincipalAmount = instrument.vehicles
    .filter((allocation) => allocation.allocationStatus === FinancingAllocationStatus.ACTIVE && !allocation.deletedAt)
    .reduce((total, allocation) => total + allocation.allocatedPrincipalAmount, 0n);

  return {
    ...toInstrumentView(instrument),
    activeAllocatedPrincipalAmount: Number(activeAllocatedPrincipalAmount),
    capitalEvents: instrument.capitalEvents.map((event) => ({
      debtPrincipalAmount: numberOrNull(event.debtPrincipalAmount),
      effectiveFrom: event.effectiveFrom,
      effectiveTo: event.effectiveTo,
      equityCapitalAmount: numberOrNull(event.equityCapitalAmount),
      eventNo: event.eventNo,
      eventStatus: event.eventStatus,
      eventType: event.eventType,
      id: event.id,
      vehicleId: event.vehicleId
    })),
    vehicles: instrument.vehicles.map((allocation) => ({
      ...toAllocationView(allocation),
      vehicle: {
        ...allocation.vehicle,
        purchasePriceAmount: Number(allocation.vehicle.purchasePriceAmount)
      }
    })),
    remainingPrincipalAmount: Number(instrument.principalAmount - activeAllocatedPrincipalAmount)
  };
}

function toInstrumentView(instrument: FinancingInstrument) {
  return {
    annualRateBps: instrument.annualRateBps,
    collateralType: instrument.collateralType,
    contractNo: instrument.contractNo,
    createdAt: instrument.createdAt,
    createdBy: instrument.createdBy,
    deletedAt: instrument.deletedAt,
    id: instrument.id,
    instrumentNo: instrument.instrumentNo,
    instrumentStatus: instrument.instrumentStatus,
    instrumentType: instrument.instrumentType,
    lenderName: instrument.lenderName,
    maturityDate: instrument.maturityDate,
    principalAmount: Number(instrument.principalAmount),
    remark: instrument.remark,
    repaymentMethod: instrument.repaymentMethod,
    snapshot: instrument.snapshot,
    startDate: instrument.startDate,
    termMonths: instrument.termMonths,
    updatedAt: instrument.updatedAt,
    updatedBy: instrument.updatedBy
  };
}

function toAllocationView(allocation: {
  allocatedPrincipalAmount: bigint;
  allocationNo: string;
  allocationRatioBps: number | null;
  allocationStatus: FinancingAllocationStatus;
  createdAt: Date;
  deletedAt: Date | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  id: string;
  instrumentId: string;
  remark: string | null;
  snapshot: Prisma.JsonValue | null;
  updatedAt: Date;
  updatedBy: string | null;
  vehicleId: string;
}) {
  return {
    allocatedPrincipalAmount: Number(allocation.allocatedPrincipalAmount),
    allocationNo: allocation.allocationNo,
    allocationRatioBps: allocation.allocationRatioBps,
    allocationStatus: allocation.allocationStatus,
    createdAt: allocation.createdAt,
    deletedAt: allocation.deletedAt,
    effectiveFrom: allocation.effectiveFrom,
    effectiveTo: allocation.effectiveTo,
    id: allocation.id,
    instrumentId: allocation.instrumentId,
    remark: allocation.remark,
    snapshot: allocation.snapshot,
    updatedAt: allocation.updatedAt,
    updatedBy: allocation.updatedBy,
    vehicleId: allocation.vehicleId
  };
}

function parseOptionalDateOnly(input: string | null | undefined, fieldName: string) {
  if (input === undefined) {
    return undefined;
  }
  if (input === null || input === "") {
    return null;
  }
  return parseDateOnly(input, fieldName);
}

function parseDateOnly(input: string, fieldName: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);

  if (!match) {
    throw new BadRequestException(`${fieldName} 必须是 YYYY-MM-DD 格式`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${fieldName} 不是有效日期`);
  }

  return date;
}

function assertDateRange(startDate: Date, maturityDate: Date | null | undefined) {
  if (maturityDate && maturityDate.getTime() < startDate.getTime()) {
    throw new BadRequestException("maturityDate 不能早于 startDate");
  }
}

function assertOptionalPositiveInteger(value: number | null | undefined, message: string) {
  if (value === undefined || value === null) {
    return;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequestException(message);
  }
}

function assertOptionalNonNegativeInteger(value: number | null | undefined, message: string) {
  if (value === undefined || value === null) {
    return;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException(message);
  }
}

function assertAllocationRatio(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000) {
    throw new BadRequestException("融资分摊比例必须在 0 到 10000 bps 之间");
  }
}

function assertCoverageRateBps(value: number | null | undefined) {
  if (value === undefined || value === null || !Number.isSafeInteger(value) || value <= 0 || value > 10000) {
    throw new BadRequestException("coverageRateBps 必须在 1 到 10000 bps 之间");
  }
}

function calculateBpsAmount(amount: bigint, bps: number) {
  return (amount * BigInt(bps)) / 10000n;
}

function calculateRatioBps(part: bigint, total: bigint) {
  if (total <= 0n) {
    return null;
  }
  return Number((part * 10000n + total / 2n) / total);
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function numberOrNull(value: bigint | number | null | undefined) {
  return value === undefined || value === null ? null : Number(value);
}

function valueOrExisting<T>(value: T | undefined, existing: T) {
  return value === undefined ? existing : value;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}
