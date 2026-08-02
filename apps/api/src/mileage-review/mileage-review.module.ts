import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { NotificationModule } from "../notification/notification.module";
import { StorageModule } from "../storage/storage.module";
import { VehicleMileageModule } from "../vehicle-mileage/vehicle-mileage.module";
import { MileageReviewController } from "./mileage-review.controller";
import { MileageReviewRepository } from "./mileage-review.repository";
import { MileageReviewService } from "./mileage-review.service";
import { MileageReviewSettlementService } from "./mileage-review-settlement.service";
import { MileageReviewWorker } from "./mileage-review.worker";

@Module({
  controllers: [MileageReviewController],
  exports: [MileageReviewService],
  imports: [NotificationModule, PrismaModule, StorageModule, VehicleMileageModule],
  providers: [
    MileageReviewRepository,
    MileageReviewService,
    MileageReviewSettlementService,
    MileageReviewWorker
  ]
})
export class MileageReviewModule {}
