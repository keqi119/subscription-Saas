import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { ServiceCaseController } from "./service-case.controller";
import { ServiceCaseService } from "./service-case.service";

@Module({
  controllers: [ServiceCaseController],
  exports: [ServiceCaseService],
  imports: [AuditModule, PrismaModule, StorageModule],
  providers: [ServiceCaseService]
})
export class ServiceCaseModule {}
