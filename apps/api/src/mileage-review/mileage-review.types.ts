import { Prisma } from "@prisma/client";

export type MileageReviewTransaction = Prisma.TransactionClient;

export interface CreateFirstMileageReviewInput {
  orderId: string;
  vehicleId: string;
  deliveryReadingId: string;
  actualDeliveryAt: Date;
  actorId: string;
}
