import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { BillingAutomationModule } from "../billing-automation/billing-automation.module";
import { DeliveryEvidenceModule } from "../delivery-evidence/delivery-evidence.module";
import { LeaseActivationEngine } from "./lease-activation.engine";
import { LeaseController } from "./lease.controller";

@Module({
  controllers: [LeaseController],
  exports: [LeaseActivationEngine],
  imports: [
    AuditModule,
    AuthModule,
    BillingAutomationModule,
    DeliveryEvidenceModule
  ],
  providers: [LeaseActivationEngine]
})
export class LeaseModule {}
