import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { ContractSegmentService } from "./contract-segment.service";

@Module({
  exports: [ContractSegmentService],
  imports: [PrismaModule],
  providers: [ContractSegmentService]
})
export class ContractSegmentModule {}
