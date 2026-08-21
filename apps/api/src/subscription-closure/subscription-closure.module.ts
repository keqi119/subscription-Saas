import { Module } from "@nestjs/common";

import { AssetOperationsModule } from "../asset-operations/asset-operations.module";
import { AuditModule } from "../audit/audit.module";
import { HandoverWorkOrderModule } from "../handover-work-order/handover-work-order.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SubscriptionClosureRepository } from "./subscription-closure.repository";
import { SubscriptionClosureService } from "./subscription-closure.service";

@Module({
  exports: [SubscriptionClosureService],
  imports: [AssetOperationsModule, AuditModule, HandoverWorkOrderModule, PrismaModule],
  providers: [SubscriptionClosureRepository, SubscriptionClosureService]
})
export class SubscriptionClosureModule {}
