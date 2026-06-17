import { BadRequestException, Body, Controller, Headers, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";

import { PaymentOrderService } from "./payment-order.service";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Controller("payments")
export class PaymentCallbackController {
  constructor(private readonly paymentOrderService: PaymentOrderService) {}

  @Post("callback/:provider")
  handleCallback(
    @Param("provider") provider: string,
    @Body() payload: unknown,
    @Headers() headers: Record<string, unknown>,
    @Req() request: RawBodyRequest
  ) {
    return this.paymentOrderService
      .handleCallback(provider, payload, headers, request.rawBody)
      .then((result) => {
        if (provider.toLowerCase() !== "wechat-pay" && provider.toLowerCase() !== "wechat_pay") {
          return result;
        }
        if (!result.verified) {
          throw new BadRequestException({ code: "FAIL", message: "微信支付回调验签失败" });
        }
        return { code: "SUCCESS", message: "成功" };
      });
  }
}
