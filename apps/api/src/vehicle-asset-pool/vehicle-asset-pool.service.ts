import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AuditAction,
  Prisma,
  VehicleAssetPoolStatus,
  VehicleAssetPoolVehicleStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import {
  AddVehicleAssetPoolVehicleDto,
  ArchiveVehicleAssetPoolDto,
  BatchAddVehicleAssetPoolVehiclesDto,
  CreateVehicleAssetPoolDto,
  RemoveVehicleAssetPoolVehicleDto,
  UpdateVehicleAssetPoolDto,
  VehicleAssetPoolsQueryDto
} from "./dto/vehicle-asset-pool.dto";

const poolDetailInclude = {
  vehicles: {
    include: {
      vehicle: {
        select: {
          brand: true,
          currentSalePriceAmount: true,
          id: true,
          model: true,
          modelDefinition: {
            select: {
              displayName: true,
              modelCode: true
            }
          },
          modelDefinitionId: true,
          plateNo: true,
          purchasePriceAmount: true,
          series: true,
          status: true,
          vehicleNo: true,
          vin: true
        }
      }
    },
    orderBy: [{ effectiveFrom: "desc" as const }, { createdAt: "desc" as const }],
    where: { deletedAt: null }
  }
} satisfies Prisma.VehicleAssetPoolInclude;

type VehicleAssetPoolDetail = Prisma.VehicleAssetPoolGetPayload<{
  include: typeof poolDetailInclude;
}>;

@Injectable()
export class VehicleAssetPoolService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async listPools(query: VehicleAssetPoolsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.VehicleAssetPoolWhereInput = {
      deletedAt: null,
      poolName: query.poolName ? { contains: query.poolName, mode: "insensitive" } : undefined,
      poolStatus: query.poolStatus,
      poolType: query.poolType
    };

    const [total, pools] = await Promise.all([
      this.prisma.vehicleAssetPool.count({ where }),
      this.prisma.vehicleAssetPool.findMany({
        include: {
          vehicles: {
            select: { membershipStatus: true },
            where: { deletedAt: null }
          }
        },
        orderBy: [{ createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      })
    ]);

    return {
      items: pools.map((pool) => ({
        ...toPoolView(pool),
        activeVehicleCount: pool.vehicles.filter(
          (membership) => membership.membershipStatus === VehicleAssetPoolVehicleStatus.ACTIVE
        ).length,
        vehicleCount: pool.vehicles.length
      })),
      page,
      pageSize,
      total
    };
  }

  async getPool(id: string) {
    const pool = await this.findPoolDetailOrThrow(id);
    return toPoolDetailView(pool);
  }

  async createPool(dto: CreateVehicleAssetPoolDto, user: RequestUser, context: RequestContext) {
    const poolName = normalizeRequiredText(dto.poolName, "poolName");
    const fields = {
      poolName,
      poolStatus: VehicleAssetPoolStatus.ACTIVE,
      poolType: dto.poolType,
      purpose: dto.purpose ?? null,
      remark: dto.remark ?? null
    };
    const pool = await withUniqueBusinessNoRetry(() =>
      this.prisma.vehicleAssetPool.create({
        data: {
          ...fields,
          createdBy: user.id,
          poolNo: createBusinessNo("VPOOL"),
          snapshot: buildPoolSnapshot(fields),
          updatedBy: user.id
        }
      })
    );

    await this.writeAudit(AuditAction.CREATE, pool.id, undefined, toPoolView(pool), user, context, {
      poolId: pool.id,
      remark: dto.remark
    });

    return toPoolView(pool);
  }

  async updatePool(
    id: string,
    dto: UpdateVehicleAssetPoolDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findPoolRecordOrThrow(id);
    const data: Prisma.VehicleAssetPoolUncheckedUpdateInput = {};
    if (dto.poolName !== undefined) {
      data.poolName = normalizeRequiredText(dto.poolName, "poolName");
    }
    assignIfDefined(data, "poolType", dto.poolType);
    assignIfDefined(data, "poolStatus", dto.poolStatus);
    assignIfDefined(data, "purpose", dto.purpose);
    assignIfDefined(data, "remark", dto.remark);

    const snapshot = buildPoolSnapshot({
      poolName: (data.poolName as string | undefined) ?? before.poolName,
      poolStatus:
        (data.poolStatus as VehicleAssetPoolStatus | undefined) ?? before.poolStatus,
      poolType: (data.poolType as typeof before.poolType | undefined) ?? before.poolType,
      purpose: valueOrExisting(data.purpose as string | null | undefined, before.purpose),
      remark: valueOrExisting(data.remark as string | null | undefined, before.remark)
    });

    const pool = await this.prisma.vehicleAssetPool.update({
      data: {
        ...data,
        snapshot,
        updatedBy: user.id
      },
      where: { id }
    });

    await this.writeAudit(AuditAction.UPDATE, id, toPoolView(before), toPoolView(pool), user, context, {
      poolId: id,
      remark: dto.remark
    });

    return toPoolView(pool);
  }

  async archivePool(
    id: string,
    dto: ArchiveVehicleAssetPoolDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findPoolRecordOrThrow(id);
    const pool = await this.prisma.vehicleAssetPool.update({
      data: {
        poolStatus: VehicleAssetPoolStatus.ARCHIVED,
        updatedBy: user.id
      },
      where: { id }
    });

    await this.writeAudit(AuditAction.UPDATE, id, toPoolView(before), toPoolView(pool), user, context, {
      poolId: id,
      remark: dto.remark
    });

    return toPoolView(pool);
  }

  async addVehicleToPool(
    id: string,
    dto: AddVehicleAssetPoolVehicleDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const pool = await this.findActivePoolOrThrow(id);
    const vehicle = await this.findVehicleOrThrow(dto.vehicleId);
    const duplicate = await this.findActiveMembership(id, dto.vehicleId);
    if (duplicate) {
      throw new BadRequestException("同一车辆已在该车辆池中生效，不能重复加入");
    }

    const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
    const membership = await this.createMembership(pool, vehicle, effectiveFrom, dto.remark ?? null, user.id);

    await this.writeAudit(
      AuditAction.CREATE,
      membership.id,
      undefined,
      toMembershipView(membership, vehicle),
      user,
      context,
      {
        membershipId: membership.id,
        poolId: id,
        remark: dto.remark,
        vehicleId: dto.vehicleId
      },
      "vehicle_asset_pool_vehicle"
    );

    return toMembershipView(membership, vehicle);
  }

  async batchAddVehiclesToPool(
    id: string,
    dto: BatchAddVehicleAssetPoolVehiclesDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const pool = await this.findActivePoolOrThrow(id);
    const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
    const seenVehicleIds = new Set<string>();
    const added: unknown[] = [];
    const skipped: Array<{ reason: string; vehicleId: string }> = [];
    const failed: Array<{ reason: string; vehicleId: string }> = [];

    for (const vehicleId of dto.vehicleIds) {
      if (seenVehicleIds.has(vehicleId)) {
        skipped.push({ reason: "请求中重复车辆，已跳过", vehicleId });
        continue;
      }
      seenVehicleIds.add(vehicleId);

      try {
        const vehicle = await this.findVehicleOrThrow(vehicleId);
        const duplicate = await this.findActiveMembership(id, vehicleId);
        if (duplicate) {
          skipped.push({ reason: "车辆已在该车辆池中生效，已跳过", vehicleId });
          continue;
        }
        const membership = await this.createMembership(pool, vehicle, effectiveFrom, dto.remark ?? null, user.id);
        added.push(toMembershipView(membership, vehicle));
      } catch (error) {
        failed.push({ reason: error instanceof Error ? error.message : "加入车辆池失败", vehicleId });
      }
    }

    const result = {
      added,
      addedCount: added.length,
      failed,
      failedCount: failed.length,
      poolId: id,
      skipped,
      skippedCount: skipped.length
    };

    await this.writeAudit(AuditAction.CREATE, id, undefined, result, user, context, {
      poolId: id,
      remark: dto.remark
    });

    return result;
  }

  async removeVehicleFromPool(
    id: string,
    membershipId: string,
    dto: RemoveVehicleAssetPoolVehicleDto,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.findPoolRecordOrThrow(id);
    const before = await this.prisma.vehicleAssetPoolVehicle.findFirst({
      include: {
        vehicle: {
          select: {
            brand: true,
            currentSalePriceAmount: true,
            id: true,
            model: true,
            modelDefinition: {
              select: {
                displayName: true,
                modelCode: true
              }
            },
            modelDefinitionId: true,
            plateNo: true,
            purchasePriceAmount: true,
            series: true,
            status: true,
            vehicleNo: true,
            vin: true
          }
        }
      },
      where: {
        deletedAt: null,
        id: membershipId,
        membershipStatus: VehicleAssetPoolVehicleStatus.ACTIVE,
        poolId: id
      }
    });
    if (!before) {
      throw new NotFoundException("池内车辆不存在或已移出");
    }

    const effectiveTo = parseDateOnly(dto.effectiveTo, "effectiveTo");
    const membership = await this.prisma.vehicleAssetPoolVehicle.update({
      data: {
        effectiveTo,
        membershipStatus: VehicleAssetPoolVehicleStatus.REMOVED,
        updatedBy: user.id
      },
      where: { id: membershipId }
    });

    await this.writeAudit(
      AuditAction.UPDATE,
      membershipId,
      toMembershipView(before, before.vehicle),
      toMembershipView(membership, before.vehicle),
      user,
      context,
      {
        membershipId,
        poolId: id,
        remark: dto.remark,
        vehicleId: before.vehicleId
      },
      "vehicle_asset_pool_vehicle"
    );

    return toMembershipView(membership, before.vehicle);
  }

  private async findPoolDetailOrThrow(id: string) {
    const pool = await this.prisma.vehicleAssetPool.findUnique({
      include: poolDetailInclude,
      where: { id }
    });
    if (!pool || pool.deletedAt) {
      throw new NotFoundException("车辆池不存在");
    }
    return pool;
  }

  private async findPoolRecordOrThrow(id: string) {
    const pool = await this.prisma.vehicleAssetPool.findUnique({ where: { id } });
    if (!pool || pool.deletedAt) {
      throw new NotFoundException("车辆池不存在");
    }
    return pool;
  }

  private async findActivePoolOrThrow(id: string) {
    const pool = await this.findPoolRecordOrThrow(id);
    if (pool.poolStatus !== VehicleAssetPoolStatus.ACTIVE) {
      throw new BadRequestException("车辆池不是生效中状态，不能执行该操作");
    }
    return pool;
  }

  private async findVehicleOrThrow(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      include: {
        modelDefinition: {
          select: {
            displayName: true,
            modelCode: true
          }
        }
      },
      where: { id: vehicleId }
    });
    if (!vehicle || vehicle.deletedAt) {
      throw new NotFoundException("车辆不存在");
    }
    return vehicle;
  }

  private findActiveMembership(poolId: string, vehicleId: string) {
    return this.prisma.vehicleAssetPoolVehicle.findFirst({
      where: {
        deletedAt: null,
        membershipStatus: VehicleAssetPoolVehicleStatus.ACTIVE,
        poolId,
        vehicleId
      }
    });
  }

  private async createMembership(
    pool: { id: string; poolName: string; poolNo: string },
    vehicle: { id: string; purchasePriceAmount: bigint; vehicleNo: string },
    effectiveFrom: Date,
    remark: string | null,
    userId: string
  ) {
    const fields = {
      effectiveFrom,
      membershipStatus: VehicleAssetPoolVehicleStatus.ACTIVE,
      remark
    };
    return this.prisma.vehicleAssetPoolVehicle.create({
      data: {
        ...fields,
        createdBy: userId,
        poolId: pool.id,
        snapshot: buildMembershipSnapshot(pool, vehicle, fields),
        updatedBy: userId,
        vehicleId: vehicle.id
      }
    });
  }

  private async writeAudit(
    action: AuditAction,
    entityId: string,
    before: unknown,
    after: unknown,
    user: RequestUser,
    context: RequestContext,
    payload: {
      membershipId?: string;
      poolId?: string;
      remark?: string | null;
      vehicleId?: string;
    },
    entityType = "vehicle_asset_pool"
  ) {
    await this.auditService.write({
      action,
      after: { ...payload, after },
      before: before === undefined ? undefined : { ...payload, before },
      entityId,
      entityType,
      ipAddress: context.ipAddress,
      module: "vehicle_asset_pool",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }
}

function buildPoolSnapshot(fields: {
  poolName: string;
  poolStatus: VehicleAssetPoolStatus;
  poolType: string;
  purpose: string | null;
  remark: string | null;
}): Prisma.InputJsonObject {
  return {
    poolName: fields.poolName,
    poolStatus: fields.poolStatus,
    poolType: fields.poolType,
    purpose: fields.purpose,
    remark: fields.remark
  };
}

function buildMembershipSnapshot(
  pool: { id: string; poolName: string; poolNo: string },
  vehicle: { id: string; purchasePriceAmount: bigint; vehicleNo: string },
  fields: {
    effectiveFrom: Date;
    membershipStatus: VehicleAssetPoolVehicleStatus;
    remark: string | null;
  }
): Prisma.InputJsonObject {
  return {
    effectiveFrom: formatDateOnly(fields.effectiveFrom),
    membershipStatus: fields.membershipStatus,
    poolId: pool.id,
    poolName: pool.poolName,
    poolNo: pool.poolNo,
    purchasePriceAmount: Number(vehicle.purchasePriceAmount),
    remark: fields.remark,
    vehicleId: vehicle.id,
    vehicleNo: vehicle.vehicleNo
  };
}

function toPoolView(pool: {
  createdAt: Date;
  createdBy: string | null;
  deletedAt: Date | null;
  id: string;
  poolName: string;
  poolNo: string;
  poolStatus: VehicleAssetPoolStatus;
  poolType: string;
  purpose: string | null;
  remark: string | null;
  snapshot: Prisma.JsonValue | null;
  updatedAt: Date;
  updatedBy: string | null;
}) {
  return {
    createdAt: pool.createdAt,
    createdBy: pool.createdBy,
    deletedAt: pool.deletedAt,
    id: pool.id,
    poolName: pool.poolName,
    poolNo: pool.poolNo,
    poolStatus: pool.poolStatus,
    poolType: pool.poolType,
    purpose: pool.purpose,
    remark: pool.remark,
    snapshot: pool.snapshot,
    updatedAt: pool.updatedAt,
    updatedBy: pool.updatedBy
  };
}

function toPoolDetailView(pool: VehicleAssetPoolDetail) {
  const activeMemberships = pool.vehicles.filter(
    (membership) => membership.membershipStatus === VehicleAssetPoolVehicleStatus.ACTIVE
  );
  const purchasePriceAmountTotal = activeMemberships.reduce(
    (total, membership) => total + membership.vehicle.purchasePriceAmount,
    0n
  );
  const currentSalePriceAmountTotal = activeMemberships.reduce(
    (total, membership) => total + (membership.vehicle.currentSalePriceAmount ?? 0n),
    0n
  );

  return {
    ...toPoolView(pool),
    activeVehicleCount: activeMemberships.length,
    currentSalePriceAmountTotal: Number(currentSalePriceAmountTotal),
    purchasePriceAmountTotal: Number(purchasePriceAmountTotal),
    vehicleCount: pool.vehicles.length,
    vehicles: pool.vehicles.map((membership) => toMembershipView(membership, membership.vehicle))
  };
}

function toMembershipView(
  membership: {
    createdAt: Date;
    createdBy: string | null;
    deletedAt: Date | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    id: string;
    membershipStatus: VehicleAssetPoolVehicleStatus;
    poolId: string;
    remark: string | null;
    snapshot: Prisma.JsonValue | null;
    updatedAt: Date;
    updatedBy: string | null;
    vehicleId: string;
  },
  vehicle?: {
    brand?: string | null;
    currentSalePriceAmount?: bigint | null;
    id: string;
    model?: string | null;
    modelDefinition: {
      displayName: string;
      modelCode: string;
    };
    modelDefinitionId: string;
    plateNo?: string | null;
    purchasePriceAmount: bigint;
    series?: string | null;
    status?: string;
    vehicleNo: string;
    vin?: string | null;
  }
) {
  return {
    createdAt: membership.createdAt,
    createdBy: membership.createdBy,
    deletedAt: membership.deletedAt,
    effectiveFrom: membership.effectiveFrom,
    effectiveTo: membership.effectiveTo,
    id: membership.id,
    membershipStatus: membership.membershipStatus,
    poolId: membership.poolId,
    remark: membership.remark,
    snapshot: membership.snapshot,
    updatedAt: membership.updatedAt,
    updatedBy: membership.updatedBy,
    vehicle: vehicle
      ? {
          brand: vehicle.brand ?? null,
          currentSalePriceAmount: numberOrNull(vehicle.currentSalePriceAmount),
          id: vehicle.id,
          model: vehicle.model ?? null,
          modelCode: vehicle.modelDefinition.modelCode,
          modelDefinitionId: vehicle.modelDefinitionId,
          modelDisplayName: vehicle.modelDefinition.displayName,
          plateNo: vehicle.plateNo ?? null,
          purchasePriceAmount: Number(vehicle.purchasePriceAmount),
          series: vehicle.series ?? null,
          status: vehicle.status ?? null,
          vehicleNo: vehicle.vehicleNo,
          vin: vehicle.vin ?? null
        }
      : undefined,
    vehicleId: membership.vehicleId
  };
}

function normalizeRequiredText(value: string, fieldName: string) {
  const text = value.trim();
  if (!text) {
    throw new BadRequestException(`${fieldName} 不能为空`);
  }
  return text;
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
