import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ResidualMarketController } from "./residual-market.controller";
import { ResidualMarketService } from "./residual-market.service";

@Module({
  controllers: [ResidualMarketController],
  imports: [AuditModule, AuthModule],
  providers: [ResidualMarketService]
})
export class ResidualMarketModule {}
