import { Prisma, VehicleMileageSourceType } from "@prisma/client";

export interface AppendVehicleMileageReadingInput {
  confirmedBy?: string | null;
  evidenceSnapshot?: Prisma.InputJsonValue;
  mileageKm: number;
  orderId?: string | null;
  recordedAt: Date;
  sourceRecordId: string;
  sourceType: VehicleMileageSourceType;
  vehicleId: string;
}
