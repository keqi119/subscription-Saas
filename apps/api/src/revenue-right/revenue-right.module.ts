import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { RevenueRightController } from "./revenue-right.controller";
import { RevenueRightService } from "./revenue-right.service";

@Module({
  controllers: [RevenueRightController],
  imports: [AuditModule, AuthModule],
  providers: [RevenueRightService]
})
export class RevenueRightModule {}
