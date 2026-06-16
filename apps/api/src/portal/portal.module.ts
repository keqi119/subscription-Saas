import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { CustomerModule } from "../customer/customer.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { PortalApplicationController } from "./portal-application.controller";
import { PortalApplicationService } from "./portal-application.service";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { PortalAuthController } from "./portal-auth.controller";
import { PortalAuthService } from "./portal-auth.service";
import { PortalCatalogController } from "./portal-catalog.controller";
import { PortalCatalogService } from "./portal-catalog.service";
import { PortalController } from "./portal.controller";

@Module({
  controllers: [
    PortalApplicationController,
    PortalAuthController,
    PortalCatalogController,
    PortalController
  ],
  exports: [CustomerAuthGuard, PortalAuthService],
  imports: [AuditModule, CustomerModule, PrismaModule, StorageModule],
  providers: [
    CustomerAuthGuard,
    PortalApplicationService,
    PortalAuthService,
    PortalCatalogService
  ]
})
export class PortalModule {}
