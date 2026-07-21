import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ContractModule } from "../contract/contract.module";
import { DeliveryEvidenceModule } from "../delivery-evidence/delivery-evidence.module";
import { ESignModule } from "../esign/esign.module";
import { HandoverWorkOrderModule } from "../handover-work-order/handover-work-order.module";
import { StorageModule } from "../storage/storage.module";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";

@Module({
  controllers: [OrderController],
  imports: [
    AuditModule,
    AuthModule,
    ContractModule,
    DeliveryEvidenceModule,
    ESignModule,
    HandoverWorkOrderModule,
    StorageModule
  ],
  providers: [OrderService]
})
export class OrderModule {}
