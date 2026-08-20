import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AssetFactsModule } from "./asset-facts/asset-facts.module";
import { AssetOperationsModule } from "./asset-operations/asset-operations.module";
import { AuditModule } from "./audit/audit.module";
import { AutoDebitModule } from "./auto-debit/auto-debit.module";
import { AuthModule } from "./auth/auth.module";
import { BillingAutomationModule } from "./billing-automation/billing-automation.module";
import { CustomerModule } from "./customer/customer.module";
import { ESignModule } from "./esign/esign.module";
import { FleetOpsModule } from "./fleet-ops/fleet-ops.module";
import { FinanceModule } from "./finance/finance.module";
import { FinancingModule } from "./financing/financing.module";
import { HandoverWorkOrderModule } from "./handover-work-order/handover-work-order.module";
import { LeaseModule } from "./lease/lease.module";
import { NotificationModule } from "./notification/notification.module";
import { OrderModule } from "./order/order.module";
import { PaymentModule } from "./payment/payment.module";
import { PortalModule } from "./portal/portal.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ProductModule } from "./product/product.module";
import { ReportModule } from "./report/report.module";
import { ResidualMarketModule } from "./residual-market/residual-market.module";
import { RevenueRightModule } from "./revenue-right/revenue-right.module";
import { RiskModule } from "./risk/risk.module";
import { ServiceCaseModule } from "./service-case/service-case.module";
import { SystemModule } from "./system/system.module";
import { SubscriptionChangeModule } from "./subscription-change/subscription-change.module";
import { SubscriptionJourneyModule } from "./subscription-journey/subscription-journey.module";
import { VehicleAssetPoolModule } from "./vehicle-asset-pool/vehicle-asset-pool.module";
import { VehicleBaasModule } from "./vehicle-baas/vehicle-baas.module";
import { VehicleDepreciationModule } from "./vehicle-depreciation/vehicle-depreciation.module";
import { VehicleInsuranceModule } from "./vehicle-insurance/vehicle-insurance.module";
import { VehicleModelDefinitionModule } from "./vehicle-model-definition/vehicle-model-definition.module";
import { VehicleMileageModule } from "./vehicle-mileage/vehicle-mileage.module";
import { VehicleValuationReviewModule } from "./vehicle-valuation-review/vehicle-valuation-review.module";
import { VehicleModule } from "./vehicle/vehicle.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: [".env.local", "../../.env", ".env"],
      isGlobal: true
    }),
    PrismaModule,
    AssetFactsModule,
    AssetOperationsModule,
    AuditModule,
    AutoDebitModule,
    AuthModule,
    BillingAutomationModule,
    CustomerModule,
    ESignModule,
    FleetOpsModule,
    FinanceModule,
    FinancingModule,
    HandoverWorkOrderModule,
    LeaseModule,
    NotificationModule,
    OrderModule,
    PaymentModule,
    PortalModule,
    ProductModule,
    ReportModule,
    ResidualMarketModule,
    RevenueRightModule,
    RiskModule,
    ServiceCaseModule,
    SystemModule,
    SubscriptionChangeModule,
    SubscriptionJourneyModule,
    VehicleAssetPoolModule,
    VehicleBaasModule,
    VehicleDepreciationModule,
    VehicleInsuranceModule,
    VehicleModelDefinitionModule,
    VehicleMileageModule,
    VehicleValuationReviewModule,
    VehicleModule
  ],
  controllers: [AppController],
  providers: [AppService]
})
export class AppModule {}
