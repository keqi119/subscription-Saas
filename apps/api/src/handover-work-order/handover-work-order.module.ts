import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { DeliveryEvidenceModule } from "../delivery-evidence/delivery-evidence.module";
import { DeliveryHandoverService } from "../delivery-handover/delivery-handover.service";
import { FieldOperatorAuthController } from "../field-operator/field-operator-auth.controller";
import { FieldOperatorAuthGuard } from "../field-operator/field-operator-auth.guard";
import { FieldOperatorAuthService } from "../field-operator/field-operator-auth.service";
import { SmsModule } from "../sms/sms.module";
import {
  HandoverWorkOrderAdminController,
  HandoverWorkOrderFieldController
} from "./handover-work-order.controller";
import { HandoverWorkOrderService } from "./handover-work-order.service";

@Module({
  controllers: [
    HandoverWorkOrderAdminController,
    FieldOperatorAuthController,
    HandoverWorkOrderFieldController
  ],
  exports: [HandoverWorkOrderService],
  imports: [AuthModule, DeliveryEvidenceModule, SmsModule],
  providers: [DeliveryHandoverService, FieldOperatorAuthGuard, FieldOperatorAuthService, HandoverWorkOrderService]
})
export class HandoverWorkOrderModule {}
