import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { ReportController } from "./report.controller";
import { ReportService } from "./report.service";

@Module({
  controllers: [ReportController],
  imports: [PrismaModule],
  providers: [ReportService]
})
export class ReportModule {}
