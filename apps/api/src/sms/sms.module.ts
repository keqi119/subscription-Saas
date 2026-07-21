import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { PrismaModule } from "../prisma/prisma.module";
import { AliyunSmsProvider } from "./aliyun-sms.provider";
import { MockSmsProvider } from "./mock-sms.provider";
import { SMS_PROVIDER_CLIENT } from "./sms-provider";
import { SmsService, normalizeProviderName } from "./sms.service";

@Module({
  exports: [SmsService],
  imports: [PrismaModule],
  providers: [
    SmsService,
    {
      inject: [ConfigService],
      provide: SMS_PROVIDER_CLIENT,
      useFactory: (configService: ConfigService) =>
        normalizeProviderName(
          configService.get<string>("FIELD_OPERATOR_SMS_PROVIDER") ??
            configService.get<string>("PORTAL_SMS_PROVIDER")
        ) === "aliyun"
          ? new AliyunSmsProvider(configService)
          : new MockSmsProvider()
    }
  ]
})
export class SmsModule {}
