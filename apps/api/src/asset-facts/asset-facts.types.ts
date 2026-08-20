import {
  Prisma,
  VehicleOwnershipPeriodEndReason,
  VehicleOwnershipPeriodStartReason,
  VehicleSubscriptionPeriodEndReason,
  VehicleSubscriptionPeriodStartReason
} from "@prisma/client";

export type ImmutableFactSnapshot = Readonly<Prisma.InputJsonObject>;

export interface StableFactSource {
  readonly id: string;
  readonly key: string;
  readonly type: string;
}

interface FactCommandMetadata {
  readonly actorId: string | null;
  readonly confirmedAt: Date;
  readonly snapshot: ImmutableFactSnapshot;
  readonly source: StableFactSource;
}

export interface OpenSubscriptionPeriodInput extends FactCommandMetadata {
  readonly contractId: string | null;
  readonly contractSegmentId: string | null;
  readonly customerId: string;
  readonly orderId: string;
  readonly reason: VehicleSubscriptionPeriodStartReason;
  readonly startedAt: Date;
  readonly vehicleId: string;
}

export interface CloseSubscriptionPeriodInput extends FactCommandMetadata {
  readonly endedAt: Date;
  readonly periodId: string;
  readonly reason: VehicleSubscriptionPeriodEndReason;
}

export interface OpenOwnershipPeriodInput extends FactCommandMetadata {
  readonly assetOwnerId: string;
  readonly reason: VehicleOwnershipPeriodStartReason;
  readonly startedAt: Date;
  readonly vehicleId: string;
}

export interface CloseOwnershipPeriodInput extends FactCommandMetadata {
  readonly endedAt: Date;
  readonly periodId: string;
  readonly reason: VehicleOwnershipPeriodEndReason;
}
