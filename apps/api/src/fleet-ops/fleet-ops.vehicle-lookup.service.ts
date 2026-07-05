import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import {
  FLEET_OPS_VEHICLE_LOOKUP_DEFAULT_LIMIT,
  FLEET_OPS_VEHICLE_LOOKUP_MAX_LIMIT,
  FLEET_OPS_VEHICLE_LOOKUP_MIN_PARTIAL_QUERY_LENGTH,
  type FleetOpsVehicleLookupItem,
  type FleetOpsVehicleLookupPayload
} from "./fleet-ops.api.types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const vehicleLookupSelect = {
  brand: true,
  id: true,
  model: true,
  modelDefinition: {
    select: {
      displayName: true,
      modelName: true,
      modelYear: true
    }
  },
  modelYear: true,
  plateNo: true,
  series: true,
  status: true,
  vehicleNo: true,
  vin: true
} satisfies Prisma.VehicleSelect;

type VehicleLookupRow = Prisma.VehicleGetPayload<{ select: typeof vehicleLookupSelect }>;

export interface FleetOpsVehicleLookupInput {
  limit?: number;
  q: string;
}

@Injectable()
export class FleetOpsVehicleLookupService {
  constructor(private readonly prisma: PrismaService) {}

  async lookup(input: FleetOpsVehicleLookupInput): Promise<FleetOpsVehicleLookupPayload> {
    const query = normalizeQuery(input.q);
    if (!query) {
      throw new BadRequestException("Fleet Ops vehicle lookup query is required.");
    }

    const limit = normalizeLimit(input.limit);
    if (!isUuid(query) && query.length < FLEET_OPS_VEHICLE_LOOKUP_MIN_PARTIAL_QUERY_LENGTH) {
      return { items: [], limit, query };
    }

    const vehicles = await this.prisma.vehicle.findMany({
      orderBy: { vehicleNo: "asc" },
      select: vehicleLookupSelect,
      take: limit,
      where: {
        deletedAt: null,
        OR: buildLookupFilters(query)
      }
    });

    return {
      items: vehicles.sort((left, right) => sortScore(left, query) - sortScore(right, query)).map(toLookupItem),
      limit,
      query
    };
  }
}

function normalizeQuery(value: string) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLimit(value: number | undefined) {
  const parsed = Number(value ?? FLEET_OPS_VEHICLE_LOOKUP_DEFAULT_LIMIT);

  if (!Number.isFinite(parsed)) {
    return FLEET_OPS_VEHICLE_LOOKUP_DEFAULT_LIMIT;
  }

  return Math.max(1, Math.min(FLEET_OPS_VEHICLE_LOOKUP_MAX_LIMIT, Math.trunc(parsed)));
}

function buildLookupFilters(query: string): Prisma.VehicleWhereInput[] {
  const filters: Prisma.VehicleWhereInput[] = [
    { vehicleNo: { contains: query, mode: "insensitive" } },
    { vin: { contains: query, mode: "insensitive" } },
    { plateNo: { contains: query, mode: "insensitive" } }
  ];

  if (isUuid(query)) {
    filters.unshift({ id: query });
  }

  return filters;
}

function toLookupItem(vehicle: VehicleLookupRow): FleetOpsVehicleLookupItem {
  const model = vehicle.modelDefinition?.displayName ?? vehicle.modelDefinition?.modelName ?? vehicle.model ?? undefined;
  const modelYear = vehicle.modelDefinition?.modelYear ?? vehicle.modelYear ?? undefined;
  const status = vehicle.status ? String(vehicle.status) : undefined;

  return {
    ...(vehicle.brand ? { brand: vehicle.brand } : {}),
    ...(model ? { model } : {}),
    ...(modelYear ? { modelYear } : {}),
    ...(status ? { operationalState: status, statusLabel: status } : {}),
    ...(vehicle.plateNo ? { plateMasked: maskPlate(vehicle.plateNo) } : {}),
    vehicleId: vehicle.id,
    ...(vehicle.vehicleNo ? { vehicleNo: vehicle.vehicleNo } : {}),
    ...(vehicle.vin ? { vinSuffix: suffixVin(vehicle.vin) } : {})
  };
}

function maskPlate(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= 2) {
    return "*".repeat(normalized.length);
  }

  return `${"*".repeat(Math.max(2, normalized.length - 2))}${normalized.slice(-2)}`;
}

function suffixVin(value: string) {
  const normalized = value.trim().toUpperCase();
  return normalized ? normalized.slice(-6) : undefined;
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function sortScore(vehicle: VehicleLookupRow, query: string) {
  const normalizedQuery = query.toLowerCase();
  const fields = [vehicle.id, vehicle.vehicleNo, vehicle.vin, vehicle.plateNo].map((value) => value?.toLowerCase());

  const exactIndex = fields.findIndex((value) => value === normalizedQuery);
  if (exactIndex >= 0) {
    return exactIndex;
  }

  if (vehicle.vin?.toLowerCase().endsWith(normalizedQuery)) {
    return 4;
  }

  return 10;
}
