import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { CustomerModule } from "./customer/customer.module";
import { FinanceModule } from "./finance/finance.module";
import { FinancingModule } from "./financing/financing.module";
import { OrderModule } from "./order/order.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ProductModule } from "./product/product.module";
import { ReportModule } from "./report/report.module";
import { ResidualMarketModule } from "./residual-market/residual-market.module";
import { RevenueRightModule } from "./revenue-right/revenue-right.module";
import { RiskModule } from "./risk/risk.module";
import { SystemModule } from "./system/system.module";
import { VehicleAssetPoolModule } from "./vehicle-asset-pool/vehicle-asset-pool.module";
import { VehicleValuationReviewModule } from "./vehicle-valuation-review/vehicle-valuation-review.module";
import { VehicleModule } from "./vehicle/vehicle.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: [".env.local", "../../.env", ".env"],
      isGlobal: true
    }),
    PrismaModule,
    AuditModule,
    AuthModule,
    CustomerModule,
    FinanceModule,
    FinancingModule,
    OrderModule,
    ProductModule,
    ReportModule,
    ResidualMarketModule,
    RevenueRightModule,
    RiskModule,
    SystemModule,
    VehicleAssetPoolModule,
    VehicleValuationReviewModule,
    VehicleModule
  ],
  controllers: [AppController],
  providers: [AppService]
})
export class AppModule {}
