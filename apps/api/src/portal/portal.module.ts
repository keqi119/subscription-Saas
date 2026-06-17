import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { CustomerModule } from "../customer/customer.module";
import { ESignModule } from "../esign/esign.module";
import { PaymentModule } from "../payment/payment.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { PortalApplicationController } from "./portal-application.controller";
import { PortalApplicationService } from "./portal-application.service";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { PortalAuthController } from "./portal-auth.controller";
import { PortalAuthService } from "./portal-auth.service";
import { PortalCatalogController } from "./portal-catalog.controller";
import { PortalCatalogService } from "./portal-catalog.service";
import { PortalContractController } from "./portal-contract.controller";
import { PortalController } from "./portal.controller";
import { PortalPaymentController } from "./portal-payment.controller";

@Module({
  controllers: [
    PortalApplicationController,
    PortalAuthController,
    PortalCatalogController,
    PortalContractController,
    PortalPaymentController,
    PortalController
  ],
  exports: [CustomerAuthGuard, PortalAuthService],
  imports: [AuditModule, CustomerModule, ESignModule, PaymentModule, PrismaModule, StorageModule],
  providers: [
    CustomerAuthGuard,
    PortalApplicationService,
    PortalAuthService,
    PortalCatalogService
  ]
})
export class PortalModule {}
