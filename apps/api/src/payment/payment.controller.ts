import { Body, Controller, Headers, Param, Post } from "@nestjs/common";

import { PaymentOrderService } from "./payment-order.service";

@Controller("payments")
export class PaymentCallbackController {
  constructor(private readonly paymentOrderService: PaymentOrderService) {}

  @Post("callback/:provider")
  handleCallback(
    @Param("provider") provider: string,
    @Body() payload: unknown,
    @Headers() headers: Record<string, unknown>
  ) {
    return this.paymentOrderService.handleCallback(provider, payload, headers);
  }
}
