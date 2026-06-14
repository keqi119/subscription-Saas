import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RiskModule } from "../risk/risk.module";
import { StorageModule } from "../storage/storage.module";
import { CustomerController } from "./customer.controller";
import { CustomerService } from "./customer.service";

@Module({
  controllers: [CustomerController],
  imports: [PrismaModule, AuditModule, AuthModule, RiskModule, StorageModule],
  providers: [CustomerService]
})
export class CustomerModule {}
