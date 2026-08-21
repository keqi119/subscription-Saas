import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  Prisma,
  VehicleMileageReading,
  VehicleMileageReadingStatus,
  VehicleMileageSourceType
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import {
  bindSubscriptionClosureAuthorityConsumer,
  consumeSubscriptionClosureAuthorityAttestation,
  type ClosureAuthorityAttestation,
  type SubscriptionClosureAuthoritySession
} from "../subscription-closure/subscription-closure.repository";
import { canonicalSubscriptionClosureJson } from "../subscription-closure/subscription-closure.domain";
import {
  VehicleMileageRepository,
  type VehicleMileageCommandSource,
  type VehicleMileageSourceCapability
} from "./vehicle-mileage.repository";
import { AppendVehicleMileageReadingInput } from "./vehicle-mileage.types";

const PROJECTION_ONLY_SOURCES = new Set<VehicleMileageSourceType>([
  VehicleMileageSourceType.VEHICLE_INITIALIZATION,
  VehicleMileageSourceType.LEGACY_MIGRATION
]);

export type PreparedVehicleMileageAppendCommand = AppendVehicleMileageReadingInput &
  Readonly<{
    receiptVehicleStatus?: "MAINTENANCE" | "RETURNED";
    source: VehicleMileageCommandSource;
  }>;

declare const vehicleMileageTransactionCapabilityBrand: unique symbol;
export type VehicleMileageTransactionCapability = Readonly<{
  [vehicleMileageTransactionCapabilityBrand]: true;
}>;
type VehicleMileageTransactionCapabilityState = Readonly<{
  repositoryCapability: VehicleMileageSourceCapability;
  source: VehicleMileageCommandSource;
  transaction: Prisma.TransactionClient;
}>;

declare const preparedVehicleMileageAppendBrand: unique symbol;
export type PreparedVehicleMileageAppendCapability = Readonly<{
  [preparedVehicleMileageAppendBrand]: true;
}>;
type PreparedVehicleMileageAppendState = Readonly<{
  command: PreparedVehicleMileageAppendCommand;
  transaction: Prisma.TransactionClient;
}>;

@Injectable()
export class VehicleMileageService {
  private readonly closureAuthorityConsumer = Object.freeze({});
  private readonly callerOwnedCapabilities = new WeakMap<
    VehicleMileageTransactionCapability,
    VehicleMileageTransactionCapabilityState
  >();
  private readonly preparedAppendCapabilities = new WeakMap<
    PreparedVehicleMileageAppendCapability,
    PreparedVehicleMileageAppendState
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: VehicleMileageRepository = new VehicleMileageRepository()
  ) {}

  async prepareCallerOwnedTransaction(
    tx: Prisma.TransactionClient,
    source: VehicleMileageCommandSource
  ): Promise<VehicleMileageTransactionCapability> {
    const normalized = normalizePreparedSource(source);
    const repositoryCapability = await this.repository.prepareCallerOwnedCommand(tx, normalized);
    const capability = Object.freeze({}) as VehicleMileageTransactionCapability;
    this.callerOwnedCapabilities.set(
      capability,
      Object.freeze({ repositoryCapability, source: normalized, transaction: tx })
    );
    return capability;
  }

  appendAuthorityRequirement(
    session: SubscriptionClosureAuthoritySession,
    command: PreparedVehicleMileageAppendCommand,
    key = "physical-mileage"
  ) {
    const normalized = normalizePreparedCommand(command);
    return bindSubscriptionClosureAuthorityConsumer(
      {
        command: normalized as never,
        key,
        locks: [
          { id: normalized.vehicleId, mode: "UPDATE" as const, table: "vehicle" as const },
          ...(normalized.orderId
            ? [
                {
                  id: normalized.orderId,
                  mode: "SHARE" as const,
                  table: "subscription_order" as const
                }
              ]
            : []),
          ...(normalized.confirmedBy
            ? [{ id: normalized.confirmedBy, mode: "SHARE" as const, table: "user" as const }]
            : [])
        ]
      },
      this.closureAuthorityConsumer,
      session
    );
  }

  async attestPreparedAppendInTransaction(
    tx: Prisma.TransactionClient,
    session: SubscriptionClosureAuthoritySession,
    command: PreparedVehicleMileageAppendCommand,
    sourceCapability: VehicleMileageTransactionCapability,
    attestation: ClosureAuthorityAttestation,
    key = "physical-mileage"
  ): Promise<PreparedVehicleMileageAppendCapability> {
    const normalized = normalizePreparedCommand(command);
    try {
      consumeSubscriptionClosureAuthorityAttestation(
        tx,
        session,
        attestation,
        () => this.appendAuthorityRequirement(session, normalized, key),
        null
      );
    } catch {
      throw capabilityInvalid();
    }
    const state = this.callerOwnedCapabilities.get(sourceCapability);
    this.callerOwnedCapabilities.delete(sourceCapability);
    if (
      !state ||
      state.transaction !== tx ||
      canonicalSubscriptionClosureJson(state.source as never) !==
        canonicalSubscriptionClosureJson(normalized.source as never)
    ) {
      throw capabilityInvalid();
    }
    this.repository.attestCallerOwnedCommand(tx, normalized.source, state.repositoryCapability);
    const capability = Object.freeze({}) as PreparedVehicleMileageAppendCapability;
    this.preparedAppendCapabilities.set(
      capability,
      Object.freeze({ command: normalized, transaction: tx })
    );
    return capability;
  }

  async appendPreparedReadingInTransaction(
    tx: Prisma.TransactionClient,
    capability: PreparedVehicleMileageAppendCapability
  ): Promise<VehicleMileageReading> {
    const state = this.preparedAppendCapabilities.get(capability);
    this.preparedAppendCapabilities.delete(capability);
    if (!state || state.transaction !== tx) throw capabilityInvalid();
    const { receiptVehicleStatus, source: _source, ...input } = state.command;
    void _source;
    return this.appendConfirmedReadingCommand(tx, input, true, receiptVehicleStatus);
  }

  async appendConfirmedReading(
    tx: Prisma.TransactionClient,
    input: AppendVehicleMileageReadingInput
  ): Promise<VehicleMileageReading> {
    return this.appendConfirmedReadingCommand(tx, input, false);
  }

  private async appendConfirmedReadingCommand(
    tx: Prisma.TransactionClient,
    input: AppendVehicleMileageReadingInput,
    authorityAlreadyLocked: boolean,
    receiptVehicleStatus?: "MAINTENANCE" | "RETURNED"
  ): Promise<VehicleMileageReading> {
    assertMileage(input.mileageKm);
    assertRecordedAt(input.recordedAt);

    if (!authorityAlreadyLocked) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "vehicle" WHERE "id" = ${input.vehicleId}::uuid FOR UPDATE`
      );
    }

    const vehicle = await tx.vehicle.findUnique({ where: { id: input.vehicleId } });
    if (!vehicle || vehicle.deletedAt) {
      throw new NotFoundException("车辆不存在或已删除");
    }

    const existing = await tx.vehicleMileageReading.findUnique({
      where: {
        sourceType_sourceRecordId: {
          sourceRecordId: input.sourceRecordId,
          sourceType: input.sourceType
        }
      }
    });
    if (existing) {
      if (existing.status !== VehicleMileageReadingStatus.ACTIVE) {
        throw new ConflictException("同一来源单据的车辆里程记录已失效");
      }
      if (sameBusinessReading(existing, input)) {
        return existing;
      }
      throw new ConflictException("同一来源单据已记录不同的车辆里程");
    }

    const latest = await tx.vehicleMileageReading.findFirst({
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
      where: {
        status: VehicleMileageReadingStatus.ACTIVE,
        vehicleId: input.vehicleId
      }
    });
    if (latest && input.mileageKm < latest.mileageKm) {
      throw new BadRequestException(`车辆里程不能小于上一条有效里程 ${latest.mileageKm} km`);
    }
    if (latest && input.recordedAt.getTime() < latest.recordedAt.getTime()) {
      throw new BadRequestException("里程记录时间不能早于上一条有效记录");
    }

    const now = new Date();
    const reading = await tx.vehicleMileageReading.create({
      data: {
        confirmedAt: now,
        confirmedBy: input.confirmedBy ?? null,
        createdBy: input.confirmedBy ?? null,
        deltaKm: input.mileageKm - (latest?.mileageKm ?? 0),
        evidenceSnapshot: input.evidenceSnapshot,
        mileageKm: input.mileageKm,
        orderId: input.orderId ?? null,
        previousReadingId: latest?.id ?? null,
        recordedAt: input.recordedAt,
        sourceRecordId: input.sourceRecordId,
        sourceType: input.sourceType,
        status: VehicleMileageReadingStatus.ACTIVE,
        updatedBy: input.confirmedBy ?? null,
        vehicleId: input.vehicleId
      }
    });

    await tx.vehicle.update({
      data: PROJECTION_ONLY_SOURCES.has(input.sourceType)
        ? {
            currentMileageKm: input.mileageKm,
            ...(receiptVehicleStatus ? { status: receiptVehicleStatus } : {}),
            updatedBy: input.confirmedBy ?? undefined
          }
        : {
            currentMileageKm: input.mileageKm,
            salePriceReinitRequiredAt: now,
            ...(receiptVehicleStatus ? { status: receiptVehicleStatus } : {}),
            updatedBy: input.confirmedBy ?? undefined
          },
      where: { id: input.vehicleId }
    });

    return reading;
  }

  async voidReadingAndRestoreProjection(
    tx: Prisma.TransactionClient,
    input: {
      actorId: string;
      reason: string;
      readingId: string;
      vehicleId: string;
      voidedAt: Date;
    }
  ) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "vehicle" WHERE "id" = ${input.vehicleId}::uuid FOR UPDATE`
    );
    const reading = await tx.vehicleMileageReading.findFirst({
      where: {
        id: input.readingId,
        status: VehicleMileageReadingStatus.ACTIVE,
        vehicleId: input.vehicleId
      }
    });
    if (!reading) {
      throw new NotFoundException("Active mileage reading was not found.");
    }
    const latest = await tx.vehicleMileageReading.findFirst({
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
      where: {
        status: VehicleMileageReadingStatus.ACTIVE,
        vehicleId: input.vehicleId
      }
    });
    if (latest?.id !== reading.id) {
      throw new ConflictException("A later active mileage reading prevents this rollback.");
    }
    const previous = await tx.vehicleMileageReading.findFirst({
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
      where: {
        id: { not: reading.id },
        status: VehicleMileageReadingStatus.ACTIVE,
        vehicleId: input.vehicleId
      }
    });
    if (!previous) {
      throw new ConflictException("The preceding active mileage reading is unavailable.");
    }

    await tx.vehicleMileageReading.update({
      data: {
        status: VehicleMileageReadingStatus.VOIDED,
        updatedBy: input.actorId,
        voidedAt: input.voidedAt,
        voidedBy: input.actorId,
        voidReason: input.reason
      },
      where: { id: reading.id }
    });
    await tx.vehicle.update({
      data: {
        currentMileageKm: previous.mileageKm,
        salePriceReinitRequiredAt: input.voidedAt,
        updatedBy: input.actorId
      },
      where: { id: input.vehicleId }
    });
    return previous;
  }

  listVehicleReadings(vehicleId: string) {
    return this.prisma.vehicleMileageReading.findMany({
      include: {
        order: { select: { id: true, orderNo: true } }
      },
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
      where: { vehicleId }
    });
  }
}

function normalizePreparedCommand(
  command: PreparedVehicleMileageAppendCommand
): PreparedVehicleMileageAppendCommand {
  assertMileage(command.mileageKm);
  assertRecordedAt(command.recordedAt);
  return Object.freeze({
    confirmedBy: command.confirmedBy ?? null,
    evidenceSnapshot:
      command.evidenceSnapshot === undefined
        ? undefined
        : (structuredClone(command.evidenceSnapshot) as Prisma.InputJsonValue),
    mileageKm: command.mileageKm,
    orderId: command.orderId ?? null,
    recordedAt: new Date(command.recordedAt),
    receiptVehicleStatus: command.receiptVehicleStatus,
    source: normalizePreparedSource(command.source),
    sourceRecordId: command.sourceRecordId,
    sourceType: command.sourceType,
    vehicleId: command.vehicleId
  });
}

function normalizePreparedSource(source: VehicleMileageCommandSource): VehicleMileageCommandSource {
  return Object.freeze({
    id: source.id.trim().toLowerCase(),
    key: source.key.trim(),
    type: source.type.trim().toUpperCase()
  });
}

function capabilityInvalid() {
  return new ConflictException({
    code: "VEHICLE_MILEAGE_CAPABILITY_INVALID",
    message: "The caller-owned vehicle-mileage capability is invalid."
  });
}

function assertMileage(mileageKm: number) {
  if (!Number.isSafeInteger(mileageKm) || mileageKm < 0) {
    throw new BadRequestException("车辆里程必须是非负整数");
  }
}

function assertRecordedAt(recordedAt: Date) {
  if (!(recordedAt instanceof Date) || Number.isNaN(recordedAt.getTime())) {
    throw new BadRequestException("里程记录时间无效");
  }
}

function sameBusinessReading(
  existing: VehicleMileageReading,
  input: AppendVehicleMileageReadingInput
) {
  return (
    existing.vehicleId === input.vehicleId &&
    existing.orderId === (input.orderId ?? null) &&
    existing.sourceType === input.sourceType &&
    existing.sourceRecordId === input.sourceRecordId &&
    existing.recordedAt.getTime() === input.recordedAt.getTime() &&
    existing.mileageKm === input.mileageKm
  );
}
