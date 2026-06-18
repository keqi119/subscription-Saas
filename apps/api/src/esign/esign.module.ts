import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuditModule } from "../audit/audit.module";
import { NotificationModule } from "../notification/notification.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ESignAdminController, ESignCallbackController } from "./esign.controller";
import { ESIGN_PROVIDER_CLIENT } from "./esign.provider";
import { ESignService } from "./esign.service";
import { MockESignProvider } from "./mock-esign.provider";

@Module({
  controllers: [ESignAdminController, ESignCallbackController],
  exports: [ESignService],
  imports: [AuditModule, NotificationModule, PrismaModule],
  providers: [
    ESignService,
    {
      inject: [ConfigService],
      provide: ESIGN_PROVIDER_CLIENT,
      useFactory: (configService: ConfigService) => new MockESignProvider(configService)
    }
  ]
})
export class ESignModule {}
