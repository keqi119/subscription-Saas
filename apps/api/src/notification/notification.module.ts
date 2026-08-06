import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SmsModule } from "../sms/sms.module";
import { MockNotificationProvider } from "./mock-notification.provider";
import { NotificationAdminController } from "./notification.controller";
import { NOTIFICATION_PROVIDER_CLIENT } from "./notification.provider";
import { NotificationService } from "./notification.service";
import { WeChatOfficialAccountProvider } from "./wechat-official-account.provider";

@Module({
  controllers: [NotificationAdminController],
  exports: [NotificationService],
  imports: [AuthModule, PrismaModule, SmsModule],
  providers: [
    NotificationService,
    {
      inject: [ConfigService],
      provide: NOTIFICATION_PROVIDER_CLIENT,
      useFactory: (configService: ConfigService) => {
        const provider = (configService.get<string>("NOTIFICATION_PROVIDER") ?? "mock").toLowerCase().replace(/-/g, "_");
        return provider === "wechat" || provider === "wechat_official" || provider === "wechat_official_account"
          ? new WeChatOfficialAccountProvider(configService)
          : new MockNotificationProvider();
      }
    }
  ]
})
export class NotificationModule {}
