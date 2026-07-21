import { Module } from "@nestjs/common";

import { DeliveryEvidenceService } from "./delivery-evidence.service";

@Module({
  exports: [DeliveryEvidenceService],
  providers: [DeliveryEvidenceService]
})
export class DeliveryEvidenceModule {}
