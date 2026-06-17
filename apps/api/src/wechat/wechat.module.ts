import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { WeChatOAuthService } from "./wechat-oauth.service";

@Module({
  exports: [WeChatOAuthService],
  imports: [PrismaModule],
  providers: [WeChatOAuthService]
})
export class WeChatModule {}
