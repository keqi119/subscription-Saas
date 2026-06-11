import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { VehicleValuationReviewController } from "./vehicle-valuation-review.controller";
import { VehicleValuationReviewService } from "./vehicle-valuation-review.service";

@Module({
  controllers: [VehicleValuationReviewController],
  imports: [PrismaModule, AuditModule, AuthModule],
  providers: [VehicleValuationReviewService]
})
export class VehicleValuationReviewModule {}
