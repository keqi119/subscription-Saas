import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { CustomerModule } from "../customer/customer.module";
import { ESignModule } from "../esign/esign.module";
import { PaymentModule } from "../payment/payment.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ServiceCaseModule } from "../service-case/service-case.module";
import { StorageModule } from "../storage/storage.module";
import { WeChatModule } from "../wechat/wechat.module";
import { PortalApplicationController } from "./portal-application.controller";
import { PortalApplicationService } from "./portal-application.service";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { PortalAuthController } from "./portal-auth.controller";
import { PortalAuthService } from "./portal-auth.service";
import { PortalBillingController } from "./portal-billing.controller";
import { PortalBillingService } from "./portal-billing.service";
import { PortalCatalogController } from "./portal-catalog.controller";
import { PortalCatalogService } from "./portal-catalog.service";
import { PortalContractController } from "./portal-contract.controller";
import { PortalController } from "./portal.controller";
import { PortalPaymentController } from "./portal-payment.controller";
import { PortalServiceCaseController } from "./portal-service-case.controller";
import { PortalWechatCallbackController, PortalWechatController } from "./portal-wechat.controller";

@Module({
  controllers: [
    PortalApplicationController,
    PortalAuthController,
    PortalBillingController,
    PortalCatalogController,
    PortalContractController,
    PortalPaymentController,
    PortalServiceCaseController,
    PortalWechatCallbackController,
    PortalWechatController,
    PortalController
  ],
  exports: [CustomerAuthGuard, PortalAuthService],
  imports: [
    AuditModule,
    CustomerModule,
    ESignModule,
    PaymentModule,
    PrismaModule,
    ServiceCaseModule,
    StorageModule,
    WeChatModule
  ],
  providers: [
    CustomerAuthGuard,
    PortalApplicationService,
    PortalAuthService,
    PortalBillingService,
    PortalCatalogService
  ]
})
export class PortalModule {}
