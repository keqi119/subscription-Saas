import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { MileageReviewController } from "./mileage-review.controller";
import { MileageReviewRepository } from "./mileage-review.repository";
import { MileageReviewService } from "./mileage-review.service";

@Module({
  controllers: [MileageReviewController],
  exports: [MileageReviewService],
  imports: [PrismaModule, StorageModule],
  providers: [MileageReviewRepository, MileageReviewService]
})
export class MileageReviewModule {}
