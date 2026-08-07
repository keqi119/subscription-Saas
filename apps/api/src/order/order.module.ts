import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { BillingAutomationModule } from "../billing-automation/billing-automation.module";
import { ContractModule } from "../contract/contract.module";
import { DeliveryEvidenceModule } from "../delivery-evidence/delivery-evidence.module";
import { ESignModule } from "../esign/esign.module";
import { HandoverWorkOrderModule } from "../handover-work-order/handover-work-order.module";
import { MileageReviewModule } from "../mileage-review/mileage-review.module";
import { LeaseModule } from "../lease/lease.module";
import { ServiceCaseModule } from "../service-case/service-case.module";
import { StorageModule } from "../storage/storage.module";
import { VehicleMileageModule } from "../vehicle-mileage/vehicle-mileage.module";
import { OrderController } from "./order.controller";
import { OrderWorkspaceResolver, OrderWorkspaceService } from "./order-workspace.service";
import { OrderService } from "./order.service";
import { OrderEntitlementService } from "./order-entitlement.service";

@Module({
  controllers: [OrderController],
  exports: [OrderEntitlementService, OrderService],
  imports: [
    AuditModule,
    AuthModule,
    BillingAutomationModule,
    ContractModule,
    DeliveryEvidenceModule,
    ESignModule,
    HandoverWorkOrderModule,
    LeaseModule,
    MileageReviewModule,
    ServiceCaseModule,
    StorageModule,
    VehicleMileageModule
  ],
  providers: [
    OrderEntitlementService,
    OrderService,
    OrderWorkspaceResolver,
    OrderWorkspaceService
  ]
})
export class OrderModule {}
