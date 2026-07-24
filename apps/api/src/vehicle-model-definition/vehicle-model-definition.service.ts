import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { Prisma, VehicleModelDefinition } from "@prisma/client";

import { RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  CreateVehicleModelDefinitionDto,
  UpdateVehicleModelDefinitionDto,
  VehicleModelDefinitionsQueryDto
} from "./dto/vehicle-model-definition.dto";

const MODEL_CODE_PATTERN = /^[A-Z0-9_-]+$/;

@Injectable()
export class VehicleModelDefinitionService {
  constructor(private readonly prisma: PrismaService) {}

  async listDefinitions(query: VehicleModelDefinitionsQueryDto) {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.VehicleModelDefinitionWhereInput = {
      deletedAt: null,
      enabled: query.enabled,
      legacyVehicleModel: query.legacyVehicleModel,
      portalVisible: query.portalVisible
    };

    const brand = normalizeOptionalText(query.brand);
    if (brand) {
      where.brand = { contains: brand, mode: "insensitive" };
    }

    const series = normalizeOptionalText(query.series);
    if (series) {
      where.series = { contains: series, mode: "insensitive" };
    }

    const keyword = normalizeOptionalText(query.keyword);
    if (keyword) {
      where.OR = [
        { modelCode: { contains: keyword, mode: "insensitive" } },
        { displayName: { contains: keyword, mode: "insensitive" } },
        { customerDisplayName: { contains: keyword, mode: "insensitive" } },
        { brand: { contains: keyword, mode: "insensitive" } },
        { series: { contains: keyword, mode: "insensitive" } },
        { modelName: { contains: keyword, mode: "insensitive" } }
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.vehicleModelDefinition.count({ where }),
      this.prisma.vehicleModelDefinition.findMany({
        orderBy: [{ sortOrder: "asc" }, { modelCode: "asc" }],
        skip,
        take: pageSize,
        where
      })
    ]);

    return {
      items: items.map(toVehicleModelDefinitionView),
      page,
      pageSize,
      total
    };
  }

  async getDefinition(id: string) {
    return toVehicleModelDefinitionView(await this.findDefinitionOrThrow(id));
  }

  async createDefinition(dto: CreateVehicleModelDefinitionDto, user: RequestUser) {
    const normalized = normalizeCreateInput(dto);

    try {
      const definition = await this.prisma.$transaction(async (tx) => {
        await this.assertCodeNamespaceAvailable(
          [normalized.modelCode],
          undefined,
          tx
        );
        return tx.vehicleModelDefinition.create({
          data: {
            ...normalized,
            createdBy: user.id,
            snapshot: {
              source: "BACK_OFFICE",
              stage: "10X-C"
            },
            updatedBy: user.id
          }
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return toVehicleModelDefinitionView(definition);
    } catch (error) {
      throwVehicleModelDefinitionWriteError(error);
    }
  }

  async updateDefinition(id: string, dto: UpdateVehicleModelDefinitionDto, user: RequestUser) {
    try {
      const definition = await this.prisma.$transaction(async (tx) => {
        const existing = await this.findDefinitionOrThrow(id, tx);
        const nextModelCode =
          dto.modelCode === undefined ? existing.modelCode : normalizeModelCode(dto.modelCode);
        await this.assertCodeNamespaceAvailable(
          [nextModelCode],
          id,
          tx
        );
        const data = normalizeUpdateInput(dto);

        return tx.vehicleModelDefinition.update({
          data: {
            ...data,
            updatedBy: user.id
          },
          where: { id }
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return toVehicleModelDefinitionView(definition);
    } catch (error) {
      throwVehicleModelDefinitionWriteError(error);
    }
  }

  async enableDefinition(id: string, user: RequestUser) {
    await this.findDefinitionOrThrow(id);
    const definition = await this.prisma.vehicleModelDefinition.update({
      data: {
        enabled: true,
        updatedBy: user.id
      },
      where: { id }
    });
    return toVehicleModelDefinitionView(definition);
  }

  async disableDefinition(id: string, user: RequestUser) {
    await this.findDefinitionOrThrow(id);
    const definition = await this.prisma.vehicleModelDefinition.update({
      data: {
        enabled: false,
        updatedBy: user.id
      },
      where: { id }
    });
    return toVehicleModelDefinitionView(definition);
  }

  async deleteDefinition(id: string, user: RequestUser) {
    await this.findDefinitionOrThrow(id);
    const definition = await this.prisma.vehicleModelDefinition.update({
      data: {
        deletedAt: new Date(),
        enabled: false,
        updatedBy: user.id
      },
      where: { id }
    });
    return toVehicleModelDefinitionView(definition);
  }

  private async findDefinitionOrThrow(
    id: string,
    db: VehicleModelDefinitionWriteClient = this.prisma
  ) {
    const definition = await db.vehicleModelDefinition.findFirst({
      where: {
        deletedAt: null,
        id
      }
    });

    if (!definition) {
      throw new NotFoundException("Vehicle model definition not found.");
    }

    return definition;
  }

  private async assertCodeNamespaceAvailable(
    values: Array<string | null | undefined>,
    excludeId?: string,
    db: VehicleModelDefinitionWriteClient = this.prisma
  ) {
    const codes = [...new Set(values.filter((value): value is string => Boolean(value)))];
    if (codes.length === 0) {
      return;
    }

    const existing = await db.vehicleModelDefinition.findFirst({
      select: { id: true },
      where: {
        OR: [
          { modelCode: { in: codes } },
          { legacyVehicleModel: { in: codes } }
        ],
        ...(excludeId ? { id: { not: excludeId } } : {})
      }
    });

    if (existing) {
      throw new BadRequestException(
        "Vehicle model code or legacy alias conflicts with an existing definition."
      );
    }
  }
}

type VehicleModelDefinitionWriteClient = Pick<
  Prisma.TransactionClient,
  "vehicleModelDefinition"
>;

function normalizeCreateInput(dto: CreateVehicleModelDefinitionDto) {
  return {
    batteryCapacityKwh: dto.batteryCapacityKwh ?? null,
    bodyType: normalizeOptionalText(dto.bodyType),
    brand: normalizeRequiredText(dto.brand),
    customerDisplayName: normalizeOptionalText(dto.customerDisplayName),
    displayName: normalizeRequiredText(dto.displayName),
    driveType: normalizeOptionalText(dto.driveType),
    enabled: dto.enabled ?? true,
    energyType: normalizeOptionalText(dto.energyType),
    modelCode: normalizeModelCode(dto.modelCode),
    modelName: normalizeRequiredText(dto.modelName),
    modelYear: dto.modelYear ?? null,
    officialRangeKm: dto.officialRangeKm ?? null,
    portalVisible: dto.portalVisible ?? false,
    remark: normalizeOptionalText(dto.remark),
    seatCount: dto.seatCount ?? null,
    series: normalizeOptionalText(dto.series),
    sortOrder: dto.sortOrder ?? 0,
    variantName: normalizeOptionalText(dto.variantName)
  };
}

function normalizeUpdateInput(dto: UpdateVehicleModelDefinitionDto): Prisma.VehicleModelDefinitionUncheckedUpdateInput {
  const data: Prisma.VehicleModelDefinitionUncheckedUpdateInput = {};

  assignIfDefined(
    data,
    "batteryCapacityKwh",
    dto.batteryCapacityKwh === undefined ? undefined : dto.batteryCapacityKwh
  );
  assignIfDefined(data, "bodyType", normalizeOptionalText(dto.bodyType), dto.bodyType !== undefined);
  assignIfDefined(data, "brand", dto.brand === undefined ? undefined : normalizeRequiredText(dto.brand));
  assignIfDefined(data, "customerDisplayName", normalizeOptionalText(dto.customerDisplayName), dto.customerDisplayName !== undefined);
  assignIfDefined(data, "displayName", dto.displayName === undefined ? undefined : normalizeRequiredText(dto.displayName));
  assignIfDefined(data, "driveType", normalizeOptionalText(dto.driveType), dto.driveType !== undefined);
  assignIfDefined(data, "enabled", dto.enabled);
  assignIfDefined(data, "energyType", normalizeOptionalText(dto.energyType), dto.energyType !== undefined);
  assignIfDefined(data, "modelCode", dto.modelCode === undefined ? undefined : normalizeModelCode(dto.modelCode));
  assignIfDefined(data, "modelName", dto.modelName === undefined ? undefined : normalizeRequiredText(dto.modelName));
  assignIfDefined(data, "modelYear", dto.modelYear ?? null, dto.modelYear !== undefined);
  assignIfDefined(data, "officialRangeKm", dto.officialRangeKm ?? null, dto.officialRangeKm !== undefined);
  assignIfDefined(data, "portalVisible", dto.portalVisible);
  assignIfDefined(data, "remark", normalizeOptionalText(dto.remark), dto.remark !== undefined);
  assignIfDefined(data, "seatCount", dto.seatCount ?? null, dto.seatCount !== undefined);
  assignIfDefined(data, "series", normalizeOptionalText(dto.series), dto.series !== undefined);
  assignIfDefined(data, "sortOrder", dto.sortOrder);
  assignIfDefined(data, "variantName", normalizeOptionalText(dto.variantName), dto.variantName !== undefined);

  return data;
}

function assignIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
  force = false
) {
  if (force || value !== undefined) {
    target[key] = value as T[K];
  }
}

function normalizeModelCode(value: string) {
  const modelCode = normalizeRequiredText(value);
  if (!MODEL_CODE_PATTERN.test(modelCode)) {
    throw new BadRequestException("Vehicle model code must use uppercase letters, numbers, underscores, or hyphens.");
  }
  return modelCode;
}

function normalizeRequiredText(value: string) {
  const text = value.trim();
  if (!text) {
    throw new BadRequestException("Required text field cannot be empty.");
  }
  return text;
}

function normalizeOptionalText(value?: string | null) {
  if (value === undefined || value === null) {
    return value === null ? null : undefined;
  }
  const text = value.trim();
  return text ? text : null;
}

function resolvePagination(query: { page?: number; pageSize?: number }) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize
  };
}

function toVehicleModelDefinitionView(definition: VehicleModelDefinition) {
  return {
    batteryCapacityKwh:
      definition.batteryCapacityKwh === null ? null : Number(definition.batteryCapacityKwh),
    bodyType: definition.bodyType,
    brand: definition.brand,
    createdAt: definition.createdAt,
    customerDisplayName: definition.customerDisplayName,
    displayName: definition.displayName,
    driveType: definition.driveType,
    enabled: definition.enabled,
    energyType: definition.energyType,
    id: definition.id,
    legacyVehicleModel: definition.legacyVehicleModel,
    modelCode: definition.modelCode,
    modelName: definition.modelName,
    modelYear: definition.modelYear,
    officialRangeKm: definition.officialRangeKm,
    portalVisible: definition.portalVisible,
    remark: definition.remark,
    seatCount: definition.seatCount,
    series: definition.series,
    sortOrder: definition.sortOrder,
    updatedAt: definition.updatedAt,
    variantName: definition.variantName
  };
}

function throwVehicleModelDefinitionWriteError(error: unknown): never {
  const code =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null;
  if (code === "P2002") {
    throw new BadRequestException("Vehicle model definition conflicts with an existing record.");
  }
  if (code === "P2034") {
    throw new ConflictException(
      "Vehicle model definition changed concurrently. Please retry."
    );
  }

  throw error;
}
