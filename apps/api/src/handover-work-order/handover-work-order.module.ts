import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { DeliveryEvidenceModule } from "../delivery-evidence/delivery-evidence.module";
import { DeliveryHandoverService } from "../delivery-handover/delivery-handover.service";
import {
  HandoverWorkOrderAdminController,
  HandoverWorkOrderFieldController
} from "./handover-work-order.controller";
import { HandoverWorkOrderService } from "./handover-work-order.service";

@Module({
  controllers: [HandoverWorkOrderAdminController, HandoverWorkOrderFieldController],
  exports: [HandoverWorkOrderService],
  imports: [AuthModule, DeliveryEvidenceModule],
  providers: [DeliveryHandoverService, HandoverWorkOrderService]
})
export class HandoverWorkOrderModule {}
