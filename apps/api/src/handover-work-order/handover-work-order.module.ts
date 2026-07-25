import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { DeliveryEvidenceModule } from "../delivery-evidence/delivery-evidence.module";
import { DeliveryHandoverEvidenceArtifactService } from "../delivery-handover/delivery-handover-evidence-artifact.service";
import { DeliveryHandoverPdfRendererService } from "../delivery-handover/delivery-handover-pdf-renderer.service";
import { DeliveryHandoverService } from "../delivery-handover/delivery-handover.service";
import { ESignModule } from "../esign/esign.module";
import { FieldOperatorAuthController } from "../field-operator/field-operator-auth.controller";
import { FieldOperatorAuthGuard } from "../field-operator/field-operator-auth.guard";
import { FieldOperatorAuthService } from "../field-operator/field-operator-auth.service";
import { SmsModule } from "../sms/sms.module";
import { StorageModule } from "../storage/storage.module";
import {
  HandoverWorkOrderAdminController,
  HandoverWorkOrderFieldController
} from "./handover-work-order.controller";
import { HandoverWorkOrderService } from "./handover-work-order.service";
import { Stage2HandoverESignReadinessService } from "./stage2-handover-esign-readiness.service";
import { Stage2HandoverESignService } from "./stage2-handover-esign.service";

@Module({
  controllers: [
    HandoverWorkOrderAdminController,
    FieldOperatorAuthController,
    HandoverWorkOrderFieldController
  ],
  exports: [
    HandoverWorkOrderService,
    Stage2HandoverESignReadinessService,
    Stage2HandoverESignService
  ],
  imports: [AuthModule, DeliveryEvidenceModule, ESignModule, SmsModule, StorageModule],
  providers: [
    DeliveryHandoverEvidenceArtifactService,
    DeliveryHandoverPdfRendererService,
    DeliveryHandoverService,
    FieldOperatorAuthGuard,
    FieldOperatorAuthService,
    HandoverWorkOrderService,
    Stage2HandoverESignReadinessService,
    Stage2HandoverESignService
  ]
})
export class HandoverWorkOrderModule {}
