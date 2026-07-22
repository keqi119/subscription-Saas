import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { CustomerModule } from "../customer/customer.module";
import { ESignModule } from "../esign/esign.module";
import { HandoverWorkOrderModule } from "../handover-work-order/handover-work-order.module";
import { NotificationModule } from "../notification/notification.module";
import { PortalNotificationController } from "../notification/notification.controller";
import { PaymentModule } from "../payment/payment.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ServiceCaseModule } from "../service-case/service-case.module";
import { SmsModule } from "../sms/sms.module";
import { StorageModule } from "../storage/storage.module";
import { VehicleInsuranceModule } from "../vehicle-insurance/vehicle-insurance.module";
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
import { PortalESignOnboardingController } from "./portal-esign-onboarding.controller";
import { PortalHandoverReviewController } from "./portal-handover-review.controller";
import { PortalHandoverReviewService } from "./portal-handover-review.service";
import { PortalPaymentController } from "./portal-payment.controller";
import { PortalOrderDocumentController } from "./portal-order-document.controller";
import { PortalProfileMaterialController } from "./portal-profile-material.controller";
import { PortalProfileMaterialService } from "./portal-profile-material.service";
import { PortalProfileService } from "./portal-profile.service";
import { PortalServiceCaseController } from "./portal-service-case.controller";
import { PortalWechatCallbackController, PortalWechatController } from "./portal-wechat.controller";

@Module({
  controllers: [
    PortalApplicationController,
    PortalAuthController,
    PortalBillingController,
    PortalCatalogController,
    PortalContractController,
    PortalNotificationController,
    PortalOrderDocumentController,
    PortalPaymentController,
    PortalHandoverReviewController,
    PortalProfileMaterialController,
    PortalServiceCaseController,
    PortalWechatCallbackController,
    PortalWechatController,
    PortalController,
    PortalESignOnboardingController
  ],
  exports: [CustomerAuthGuard, PortalAuthService],
  imports: [
    AuditModule,
    CustomerModule,
    ESignModule,
    HandoverWorkOrderModule,
    NotificationModule,
    PaymentModule,
    PrismaModule,
    ServiceCaseModule,
    SmsModule,
    StorageModule,
    VehicleInsuranceModule,
    WeChatModule
  ],
  providers: [
    CustomerAuthGuard,
    PortalApplicationService,
    PortalAuthService,
    PortalBillingService,
    PortalCatalogService,
    PortalHandoverReviewService,
    PortalProfileService,
    PortalProfileMaterialService
  ]
})
export class PortalModule {}
