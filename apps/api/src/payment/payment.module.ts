import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuditModule } from "../audit/audit.module";
import { FinanceModule } from "../finance/finance.module";
import { PrismaModule } from "../prisma/prisma.module";
import { WeChatModule } from "../wechat/wechat.module";
import { MockPaymentProvider } from "./mock-payment.provider";
import { PaymentCallbackController } from "./payment.controller";
import { PaymentOrderService } from "./payment-order.service";
import { PAYMENT_PROVIDER_CLIENT } from "./payment-provider";
import { WeChatPayProvider } from "./wechat-pay.provider";

@Module({
  controllers: [PaymentCallbackController],
  exports: [PaymentOrderService],
  imports: [AuditModule, FinanceModule, PrismaModule, WeChatModule],
  providers: [
    PaymentOrderService,
    {
      inject: [ConfigService],
      provide: PAYMENT_PROVIDER_CLIENT,
      useFactory: (configService: ConfigService) => {
        const provider = (configService.get<string>("PAYMENT_PROVIDER") ?? "mock").toLowerCase();
        return provider === "wechat_pay" || provider === "wechat-pay" || provider === "wechat" || provider === "wxpay"
          ? new WeChatPayProvider(configService)
          : new MockPaymentProvider(configService);
      }
    }
  ]
})
export class PaymentModule {}
