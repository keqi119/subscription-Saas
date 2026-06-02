import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { CustomerModule } from "./customer/customer.module";
import { OrderModule } from "./order/order.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ProductModule } from "./product/product.module";
import { RiskModule } from "./risk/risk.module";
import { SystemModule } from "./system/system.module";
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
    OrderModule,
    ProductModule,
    RiskModule,
    SystemModule,
    VehicleModule
  ],
  controllers: [AppController],
  providers: [AppService]
})
export class AppModule {}
