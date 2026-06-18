import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";

import { CreatePortalPaymentOrderDto, PortalPayableBillsQueryDto } from "../payment/payment.dto";
import { PaymentOrderService } from "../payment/payment-order.service";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { PortalPaymentOrdersQueryDto } from "./portal-billing.dto";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";

@Controller("portal")
@UseGuards(CustomerAuthGuard)
export class PortalPaymentController {
  constructor(private readonly paymentOrderService: PaymentOrderService) {}

  @Get("payment/payable-bills")
  listPayableBills(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalPayableBillsQueryDto
  ) {
    return this.paymentOrderService.listPayableBills(currentCustomer, query);
  }

  @Post("payment-orders")
  createPaymentOrder(
    @Body() dto: CreatePortalPaymentOrderDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.paymentOrderService.createPortalPaymentOrder(dto, currentCustomer, requestContext(request));
  }

  @Get("payment-orders")
  listPaymentOrders(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalPaymentOrdersQueryDto
  ) {
    return this.paymentOrderService.listPortalPaymentOrders(currentCustomer, query);
  }

  @Get("payment-orders/:id")
  getPaymentOrder(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.paymentOrderService.getPortalPaymentOrder(id, currentCustomer);
  }

  @Post("payment-orders/:id/pay")
  startPayment(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.paymentOrderService.startPortalPayment(id, currentCustomer, requestContext(request));
  }

  @Post("payment-orders/:id/mock-pay")
  mockPay(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.paymentOrderService.mockPay(id, currentCustomer, requestContext(request));
  }
}

function requestContext(request: Request) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
