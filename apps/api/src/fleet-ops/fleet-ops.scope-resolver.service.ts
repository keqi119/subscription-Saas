import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  Prisma,
  VehicleAssetPoolStatus,
  VehicleAssetPoolVehicleStatus,
  VehicleStatus
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import {
  FLEET_OPS_OVERVIEW_DEFAULT_PAGE_SIZE,
  FLEET_OPS_OVERVIEW_DEFAULT_SCOPE_CAP,
  FLEET_OPS_OVERVIEW_HARD_SCOPE_CAP,
  FLEET_OPS_OVERVIEW_MAX_PAGE_SIZE
} from "./fleet-ops.api.types";
import type {
  FleetOpsOverviewQueryInput,
  FleetOpsPagination,
  FleetOpsPoolIdentity,
  FleetOpsPoolListQueryInput,
  FleetOpsPoolListReadModel,
  FleetOpsResolvedScope,
  FleetOpsScopedVehicleListReadModel,
  FleetOpsScopeType,
  FleetOpsVehicleScopeItem
} from "./fleet-ops.pool-read-model";

const vehicleScopeSelect = {
  assetLocation: true,
  brand: true,
  createdAt: true,
  id: true,
  model: true,
  modelDefinition: {
    select: {
      bodyType: true,
      displayName: true,
      modelName: true,
      modelYear: true
    }
  },
  modelYear: true,
  registrationDate: true,
  status: true,
  vehicleNo: true,
  vin: true
} satisfies Prisma.VehicleSelect;

const poolSelect = {
  id: true,
  poolName: true,
  poolNo: true,
  poolStatus: true,
  poolType: true,
  vehicles: {
    where: {
      deletedAt: null,
      membershipStatus: VehicleAssetPoolVehicleStatus.ACTIVE,
      vehicle: {
        deletedAt: null
      }
    },
    select: {
      membershipStatus: true,
      vehicleId: true
    }
  }
} satisfies Prisma.VehicleAssetPoolSelect;

type VehicleScopeRow = Prisma.VehicleGetPayload<{ select: typeof vehicleScopeSelect }>;
type PoolRow = Prisma.VehicleAssetPoolGetPayload<{ select: typeof poolSelect }>;

@Injectable()
export class FleetOpsScopeResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveScope(input: FleetOpsOverviewQueryInput): Promise<FleetOpsResolvedScope> {
    const scopeType = resolveScopeType(input);
    const cap = normalizeScopeCap(input.limit);
    const pool = scopeType === "POOL" ? await this.requirePool(input.poolId) : undefined;
    const where = buildVehicleWhere(input, scopeType);
    const vehicles = await this.prisma.vehicle.findMany({
      orderBy: [{ vehicleNo: "asc" }, { id: "asc" }],
      select: vehicleScopeSelect,
      take: cap + 1,
      where
    });

    if (vehicles.length > cap) {
      throw new BadRequestException({
        code: "FLEET_OPS_SCOPE_TOO_LARGE",
        details: {
          maxVehicleScope: cap,
          scopeType
        },
        message: `Fleet Ops overview scope exceeds the synchronous cap of ${cap} vehicles. Narrow the scope or use a smaller pool/cohort.`
      });
    }

    return {
      scope: {
        ...(Object.keys(scopeFilters(input)).length > 0 ? { filters: scopeFilters(input) } : {}),
        ...(pool ? { pool } : {}),
        type: scopeType
      },
      vehicleIds: vehicles.map((vehicle) => vehicle.id),
      vehicles: vehicles.map(toVehicleScopeItem),
      warnings: deferredFilterWarnings(input)
    };
  }

  async listPools(input: FleetOpsPoolListQueryInput): Promise<FleetOpsPoolListReadModel> {
    const pagination = normalizePagination(input);
    const where: Prisma.VehicleAssetPoolWhereInput = {
      deletedAt: null,
      poolStatus: (input.poolStatus as VehicleAssetPoolStatus | undefined) ?? VehicleAssetPoolStatus.ACTIVE,
      ...(input.poolType ? { poolType: input.poolType as never } : {})
    };
    const [total, pools] = await Promise.all([
      this.prisma.vehicleAssetPool.count({ where }),
      this.prisma.vehicleAssetPool.findMany({
        orderBy: [{ poolNo: "asc" }, { id: "asc" }],
        select: poolSelect,
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
        where
      })
    ]);

    return {
      generatedAt: new Date().toISOString(),
      items: pools.map(toPoolIdentity),
      pagination: {
        ...pagination,
        total
      }
    };
  }

  async listScopedVehicles(input: FleetOpsOverviewQueryInput): Promise<FleetOpsScopedVehicleListReadModel> {
    const pagination = normalizePagination(input);
    const scopeType = resolveScopeType(input);
    const pool = scopeType === "POOL" ? await this.requirePool(input.poolId) : undefined;
    const where = buildVehicleWhere(input, scopeType);
    const [total, vehicles] = await Promise.all([
      this.prisma.vehicle.count({ where }),
      this.prisma.vehicle.findMany({
        orderBy: [{ vehicleNo: "asc" }, { id: "asc" }],
        select: vehicleScopeSelect,
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
        where
      })
    ]);

    return {
      generatedAt: new Date().toISOString(),
      items: vehicles.map(toVehicleScopeItem),
      pagination: {
        ...pagination,
        total
      },
      scope: {
        ...(Object.keys(scopeFilters(input)).length > 0 ? { filters: scopeFilters(input) } : {}),
        ...(pool ? { pool } : {}),
        type: scopeType
      },
      warnings: deferredFilterWarnings(input)
    };
  }

  async getPoolIdentity(poolId: string): Promise<FleetOpsPoolIdentity | null> {
    const pool = await this.prisma.vehicleAssetPool.findFirst({
      select: poolSelect,
      where: {
        deletedAt: null,
        id: poolId,
        poolStatus: VehicleAssetPoolStatus.ACTIVE
      }
    });

    return pool ? toPoolIdentity(pool) : null;
  }

  private async requirePool(poolId: string | undefined) {
    if (!poolId) {
      throw new BadRequestException({
        code: "FLEET_OPS_POOL_ID_REQUIRED",
        message: "Fleet Ops POOL scope requires poolId."
      });
    }

    const pool = await this.getPoolIdentity(poolId);
    if (!pool) {
      throw new NotFoundException({
        code: "FLEET_OPS_POOL_NOT_FOUND",
        message: "Fleet Ops vehicle pool was not found or is inactive."
      });
    }

    return pool;
  }
}

function buildVehicleWhere(input: FleetOpsOverviewQueryInput, scopeType: FleetOpsScopeType): Prisma.VehicleWhereInput {
  const where: Prisma.VehicleWhereInput = {
    deletedAt: null
  };

  if (scopeType === "POOL" || input.poolId) {
    where.assetPoolMemberships = {
      some: {
        deletedAt: null,
        membershipStatus: VehicleAssetPoolVehicleStatus.ACTIVE,
        pool: {
          deletedAt: null,
          poolStatus: VehicleAssetPoolStatus.ACTIVE
        },
        ...(input.poolId ? { poolId: input.poolId } : {})
      }
    };
  }

  if (input.brand) {
    where.brand = { contains: input.brand, mode: "insensitive" };
  }

  if (input.model) {
    where.model = { contains: input.model, mode: "insensitive" };
  }

  if (typeof input.modelYear === "number") {
    where.modelYear = input.modelYear;
  }

  if (input.vehicleStatus && Object.values(VehicleStatus).includes(input.vehicleStatus as VehicleStatus)) {
    where.status = input.vehicleStatus as VehicleStatus;
  }

  if (input.assetLocation) {
    where.assetLocation = { contains: input.assetLocation, mode: "insensitive" };
  }

  if (input.registrationDateFrom || input.registrationDateTo) {
    where.registrationDate = dateRange(input.registrationDateFrom, input.registrationDateTo);
  }

  if (input.createdFrom || input.createdTo) {
    where.createdAt = dateRange(input.createdFrom, input.createdTo);
  }

  return where;
}

function dateRange(from: string | undefined, to: string | undefined) {
  return {
    ...(from ? { gte: new Date(from) } : {}),
    ...(to ? { lte: new Date(to) } : {})
  };
}

function resolveScopeType(input: FleetOpsOverviewQueryInput): FleetOpsScopeType {
  if (input.scopeType) {
    return input.scopeType;
  }

  if (input.poolId) {
    return "POOL";
  }

  return Object.keys(scopeFilters(input)).length > 0 ? "COHORT" : "ALL";
}

function scopeFilters(input: FleetOpsOverviewQueryInput): Record<string, unknown> {
  return compactRecord({
    assetLocation: input.assetLocation,
    brand: input.brand,
    createdFrom: input.createdFrom,
    createdTo: input.createdTo,
    model: input.model,
    modelYear: input.modelYear,
    poolId: input.poolId,
    registrationDateFrom: input.registrationDateFrom,
    registrationDateTo: input.registrationDateTo,
    vehicleStatus: input.vehicleStatus
  });
}

function deferredFilterWarnings(input: FleetOpsOverviewQueryInput) {
  return [
    ["agingBucket", input.agingBucket],
    ["collectionLevel", input.collectionLevel],
    ["confidenceBand", input.confidenceBand],
    ["evidenceMissing", input.evidenceMissing],
    ["overdueStatus", input.overdueStatus],
    ["riskLevel", input.riskLevel],
    ["warningType", input.warningType]
  ]
    .filter(([, value]) => value !== undefined)
    .map(([field]) => `FLEET_OPS_FILTER_DEFERRED:${field}`);
}

function normalizeScopeCap(value: number | undefined) {
  const parsed = Number(value ?? FLEET_OPS_OVERVIEW_DEFAULT_SCOPE_CAP);
  if (!Number.isFinite(parsed)) {
    return FLEET_OPS_OVERVIEW_DEFAULT_SCOPE_CAP;
  }

  return Math.max(1, Math.min(FLEET_OPS_OVERVIEW_HARD_SCOPE_CAP, Math.trunc(parsed)));
}

function normalizePagination(input: { page?: number; pageSize?: number }): Omit<FleetOpsPagination, "total"> {
  const page = Math.max(1, Math.trunc(Number(input.page ?? 1)));
  const pageSizeInput = Number(input.pageSize ?? FLEET_OPS_OVERVIEW_DEFAULT_PAGE_SIZE);
  const pageSize = Number.isFinite(pageSizeInput)
    ? Math.max(1, Math.min(FLEET_OPS_OVERVIEW_MAX_PAGE_SIZE, Math.trunc(pageSizeInput)))
    : FLEET_OPS_OVERVIEW_DEFAULT_PAGE_SIZE;

  return { page, pageSize };
}

function toPoolIdentity(pool: PoolRow): FleetOpsPoolIdentity {
  return {
    activeVehicleCount: pool.vehicles.filter((membership) => membership.membershipStatus === VehicleAssetPoolVehicleStatus.ACTIVE).length,
    poolId: pool.id,
    poolName: pool.poolName,
    poolNo: pool.poolNo,
    poolStatus: pool.poolStatus,
    poolType: pool.poolType
  };
}

function toVehicleScopeItem(vehicle: VehicleScopeRow): FleetOpsVehicleScopeItem {
  return {
    ...(vehicle.assetLocation ? { assetLocation: vehicle.assetLocation } : {}),
    ...(vehicle.brand ? { brand: vehicle.brand } : {}),
    ...(vehicle.modelDefinition?.displayName || vehicle.modelDefinition?.modelName || vehicle.model
      ? { model: vehicle.modelDefinition?.displayName ?? vehicle.modelDefinition?.modelName ?? vehicle.model ?? undefined }
      : {}),
    ...(vehicle.modelDefinition?.modelYear ?? vehicle.modelYear ? { modelYear: vehicle.modelDefinition?.modelYear ?? vehicle.modelYear ?? undefined } : {}),
    status: vehicle.status,
    vehicleId: vehicle.id,
    ...(vehicle.vehicleNo ? { vehicleNo: vehicle.vehicleNo } : {}),
    ...(vehicle.vin ? { vinSuffix: vehicle.vin.trim().toUpperCase().slice(-6) } : {})
  };
}

function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== ""));
}
