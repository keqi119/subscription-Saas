import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { NotificationModule } from "../notification/notification.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { ServiceCaseController } from "./service-case.controller";
import { ServiceCaseService } from "./service-case.service";

@Module({
  controllers: [ServiceCaseController],
  exports: [ServiceCaseService],
  imports: [AuditModule, AuthModule, NotificationModule, PrismaModule, StorageModule],
  providers: [ServiceCaseService]
})
export class ServiceCaseModule {}
