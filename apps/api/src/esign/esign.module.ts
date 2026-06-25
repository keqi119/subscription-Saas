import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { NotificationModule } from "../notification/notification.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ESignAdminController, ESignCallbackController } from "./esign.controller";
import { ESIGN_PROVIDER_CLIENT, ESignProvider } from "./esign.provider";
import { ESignService } from "./esign.service";
import { loadFadadaConfig, selectedESignProvider } from "./fadada/fadada.config";
import { FadadaESignProvider } from "./fadada/fadada-esign.provider";
import { MockESignProvider } from "./mock-esign.provider";

export function createESignProviderClient(configService: ConfigService): ESignProvider {
  const provider = selectedESignProvider(configService);

  switch (provider) {
    case "mock":
      return new MockESignProvider(configService);
    case "fadada":
      return new FadadaESignProvider(loadFadadaConfig(configService));
    default:
      throw new Error(`ESIGN_PROVIDER_UNSUPPORTED: ${provider}`);
  }
}

@Module({
  controllers: [ESignAdminController, ESignCallbackController],
  exports: [ESignService],
  imports: [AuditModule, AuthModule, NotificationModule, PrismaModule],
  providers: [
    ESignService,
    {
      inject: [ConfigService],
      provide: ESIGN_PROVIDER_CLIENT,
      useFactory: createESignProviderClient
    }
  ]
})
export class ESignModule {}
