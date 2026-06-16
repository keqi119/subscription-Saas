import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuditModule } from "../audit/audit.module";
import { FinanceModule } from "../finance/finance.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MockPaymentProvider } from "./mock-payment.provider";
import { PaymentCallbackController } from "./payment.controller";
import { PaymentOrderService } from "./payment-order.service";
import { PAYMENT_PROVIDER_CLIENT } from "./payment-provider";

@Module({
  controllers: [PaymentCallbackController],
  exports: [PaymentOrderService],
  imports: [AuditModule, FinanceModule, PrismaModule],
  providers: [
    PaymentOrderService,
    {
      inject: [ConfigService],
      provide: PAYMENT_PROVIDER_CLIENT,
      useFactory: (configService: ConfigService) => new MockPaymentProvider(configService)
    }
  ]
})
export class PaymentModule {}
