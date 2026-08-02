import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { MileageReviewRepository } from "./mileage-review.repository";
import { MileageReviewService } from "./mileage-review.service";

@Module({
  exports: [MileageReviewService],
  imports: [PrismaModule],
  providers: [MileageReviewRepository, MileageReviewService]
})
export class MileageReviewModule {}
