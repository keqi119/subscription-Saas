import { Module } from "@nestjs/common";

import { ContractSegmentModule } from "./contract-segment.module";

@Module({
  imports: [ContractSegmentModule]
})
export class SubscriptionChangeModule {}
