import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { AutoDebitConfig, readAutoDebitConfig } from "./auto-debit.config";
import {
  AUTO_DEBIT_CONFIG,
  MandateDebitProvider,
  MANDATE_DEBIT_PROVIDER
} from "./auto-debit-provider";
import { MockAutoDebitProvider } from "./mock-auto-debit.provider";
import { AutoDebitController } from "./auto-debit.controller";
import { AutoDebitHandlers } from "./auto-debit.handlers";
import { AutoDebitScheduler } from "./auto-debit.scheduler";
import { DebitAttemptService } from "./debit-attempt.service";
import { PaymentMandateService } from "./payment-mandate.service";

@Module({
  controllers: [AutoDebitController],
  exports: [
    AUTO_DEBIT_CONFIG,
    MANDATE_DEBIT_PROVIDER,
    AutoDebitHandlers,
    AutoDebitScheduler,
    PaymentMandateService
  ],
  imports: [AuditModule, AuthModule, ConfigModule],
  providers: [
    AutoDebitHandlers,
    AutoDebitScheduler,
    DebitAttemptService,
    PaymentMandateService,
    {
      inject: [ConfigService],
      provide: AUTO_DEBIT_CONFIG,
      useFactory: (configService: ConfigService) =>
        readAutoDebitConfig({
          APP_ENV: configService.get<string>("APP_ENV"),
          AUTO_DEBIT_ENABLED: configService.get<string>("AUTO_DEBIT_ENABLED"),
          AUTO_DEBIT_RUN_TIME: configService.get<string>("AUTO_DEBIT_RUN_TIME"),
          NODE_ENV: configService.get<string>("NODE_ENV"),
          PAYMENT_MANDATE_MOCK_ENABLED: configService.get<string>(
            "PAYMENT_MANDATE_MOCK_ENABLED"
          ),
          PAYMENT_MANDATE_PROVIDER: configService.get<string>(
            "PAYMENT_MANDATE_PROVIDER"
          ),
          WECHAT_AUTO_RENEW_TEMPLATE_ID: configService.get<string>(
            "WECHAT_AUTO_RENEW_TEMPLATE_ID"
          )
        })
    },
    {
      inject: [AUTO_DEBIT_CONFIG],
      provide: MANDATE_DEBIT_PROVIDER,
      useFactory: (config: AutoDebitConfig): MandateDebitProvider => {
        if (!config.enabled) {
          return new DisabledAutoDebitProvider();
        }
        if (config.provider === "mock") {
          return new MockAutoDebitProvider();
        }
        throw new Error("AUTO_DEBIT_WECHAT_PROVIDER_NOT_IMPLEMENTED");
      }
    }
  ]
})
export class AutoDebitModule {}

class DisabledAutoDebitProvider implements MandateDebitProvider {
  async createMandate() {
    return unavailable();
  }

  async queryMandate() {
    return unavailable();
  }

  async revokeMandate() {
    return unavailable();
  }

  async submitDebit() {
    return unavailable();
  }

  async queryDebit() {
    return unavailable();
  }

  async verifyCallback() {
    return unavailable();
  }
}

function unavailable(): never {
  throw new Error("AUTO_DEBIT_DISABLED");
}
