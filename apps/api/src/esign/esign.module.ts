import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { NotificationModule } from "../notification/notification.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { StorageModule } from "../storage/storage.module";
import { SubscriptionJourneySignalModule } from "../subscription-journey/subscription-journey-signal.module";
import { ContractPdfArtifactService } from "./contract-pdf-artifact.service";
import { CustomerESignProviderAccountController } from "./customer-esign-provider-account.controller";
import { CustomerESignProviderAccountService } from "./customer-esign-provider-account.service";
import { FadadaCustomerReadinessService } from "./fadada-customer-readiness.service";
import { CustomerESignOnboardingController } from "./customer-esign-onboarding.controller";
import { CustomerESignOnboardingService } from "./customer-esign-onboarding.service";
import { ESignAdminController, ESignCallbackController } from "./esign.controller";
import { ESIGN_PROVIDER_CLIENT, ESignProvider } from "./esign.provider";
import { ESignService } from "./esign.service";
import { FadadaApiClient } from "./fadada/fadada-api.client";
import { loadFadadaConfig, selectedESignProvider } from "./fadada/fadada.config";
import { FadadaESignProvider } from "./fadada/fadada-esign.provider";
import { FadadaHttpClient } from "./fadada/fadada-http-client";
import { FadadaSignedArtifactService } from "./fadada/fadada-signed-artifact.service";
import { MockESignProvider } from "./mock-esign.provider";
import { Stage3ExtensionArchiveService } from "./stage3-extension-archive.service";

export function createESignProviderClient(
  configService: ConfigService,
  pdfArtifactService?: ContractPdfArtifactService,
  prismaService?: PrismaService
): ESignProvider {
  const provider = selectedESignProvider(configService);

  switch (provider) {
    case "mock":
      return new MockESignProvider(configService);
    case "fadada":
      {
        const fadadaConfig = loadFadadaConfig(configService);
        const httpClient = new FadadaHttpClient(fadadaConfig);
        const apiClient = new FadadaApiClient(fadadaConfig, httpClient);
        return new FadadaESignProvider(fadadaConfig, apiClient, pdfArtifactService, prismaService);
      }
    default:
      throw new Error(`ESIGN_PROVIDER_UNSUPPORTED: ${provider}`);
  }
}

@Module({
  controllers: [
    ESignAdminController,
    ESignCallbackController,
    CustomerESignProviderAccountController,
    CustomerESignOnboardingController
  ],
  exports: [
    ESIGN_PROVIDER_CLIENT,
    ESignService,
    CustomerESignOnboardingService,
    FadadaCustomerReadinessService,
    FadadaSignedArtifactService,
    Stage3ExtensionArchiveService
  ],
  imports: [
    AuditModule,
    AuthModule,
    NotificationModule,
    PrismaModule,
    StorageModule,
    SubscriptionJourneySignalModule
  ],
  providers: [
    ContractPdfArtifactService,
    CustomerESignProviderAccountService,
    CustomerESignOnboardingService,
    ESignService,
    FadadaCustomerReadinessService,
    FadadaSignedArtifactService,
    Stage3ExtensionArchiveService,
    {
      inject: [ConfigService, ContractPdfArtifactService, PrismaService],
      provide: ESIGN_PROVIDER_CLIENT,
      useFactory: createESignProviderClient
    }
  ]
})
export class ESignModule {}
