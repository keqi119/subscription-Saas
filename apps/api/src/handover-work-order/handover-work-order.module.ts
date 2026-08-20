import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AssetOperationsModule } from "../asset-operations/asset-operations.module";
import { DeliveryEvidenceModule } from "../delivery-evidence/delivery-evidence.module";
import { DeliveryHandoverEvidenceArtifactService } from "../delivery-handover/delivery-handover-evidence-artifact.service";
import { DeliveryHandoverPdfRendererService } from "../delivery-handover/delivery-handover-pdf-renderer.service";
import { DeliveryHandoverService } from "../delivery-handover/delivery-handover.service";
import { ESignModule } from "../esign/esign.module";
import { FieldOperatorAuthController } from "../field-operator/field-operator-auth.controller";
import { FieldOperatorAuthGuard } from "../field-operator/field-operator-auth.guard";
import { FieldOperatorAuthService } from "../field-operator/field-operator-auth.service";
import { FieldVideoUploadController } from "../field-operator/field-video-upload.controller";
import { FieldVideoUploadFinalizerService } from "../field-operator/field-video-upload-finalizer.service";
import { FieldVideoUploadRepository } from "../field-operator/field-video-upload.repository";
import { FieldVideoUploadService } from "../field-operator/field-video-upload.service";
import { FieldVideoUploadWorker } from "../field-operator/field-video-upload.worker";
import { FinanceModule } from "../finance/finance.module";
import { NotificationModule } from "../notification/notification.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SmsModule } from "../sms/sms.module";
import { StorageModule } from "../storage/storage.module";
import { SubscriptionJourneySignalModule } from "../subscription-journey/subscription-journey-signal.module";
import {
  HandoverWorkOrderAdminController,
  HandoverWorkOrderFieldController
} from "./handover-work-order.controller";
import { HandoverWorkOrderService } from "./handover-work-order.service";
import { Stage2HandoverESignReadinessService } from "./stage2-handover-esign-readiness.service";
import { Stage2HandoverESignService } from "./stage2-handover-esign.service";
import { Stage2HandoverWorkflowRepository } from "./stage2-handover-workflow.repository";
import { Stage2HandoverWorkflowService } from "./stage2-handover-workflow.service";
import { STAGE2_HANDOVER_WORKFLOW_HANDLER } from "./stage2-handover-workflow.types";
import { Stage2HandoverWorkflowWorker } from "./stage2-handover-workflow.worker";

@Module({
  controllers: [
    HandoverWorkOrderAdminController,
    FieldOperatorAuthController,
    FieldVideoUploadController,
    HandoverWorkOrderFieldController
  ],
  exports: [
    HandoverWorkOrderService,
    Stage2HandoverESignReadinessService,
    Stage2HandoverESignService,
    Stage2HandoverWorkflowRepository,
    Stage2HandoverWorkflowService
  ],
  imports: [
    AuthModule,
    AssetOperationsModule,
    DeliveryEvidenceModule,
    ESignModule,
    FinanceModule,
    NotificationModule,
    PrismaModule,
    SmsModule,
    StorageModule,
    SubscriptionJourneySignalModule
  ],
  providers: [
    DeliveryHandoverEvidenceArtifactService,
    DeliveryHandoverPdfRendererService,
    DeliveryHandoverService,
    FieldOperatorAuthGuard,
    FieldOperatorAuthService,
    FieldVideoUploadFinalizerService,
    FieldVideoUploadRepository,
    FieldVideoUploadService,
    FieldVideoUploadWorker,
    HandoverWorkOrderService,
    Stage2HandoverESignReadinessService,
    Stage2HandoverESignService,
    Stage2HandoverWorkflowRepository,
    Stage2HandoverWorkflowService,
    {
      provide: STAGE2_HANDOVER_WORKFLOW_HANDLER,
      useExisting: Stage2HandoverWorkflowService
    },
    Stage2HandoverWorkflowWorker
  ]
})
export class HandoverWorkOrderModule {}
