import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { CreatePaymentDto, WriteOffPaymentDto } from "./dto/finance.dto";
import { FinanceService } from "./finance.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  @Post("orders/:id/generate-initial-bills")
  @RequirePermissions(PermissionCode.BILLING_GENERATE)
  generateInitialBills(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.financeService.generateInitialBills(id, request.user, requestContext(request));
  }

  @Get("orders/:id/bills")
  @RequirePermissions(PermissionCode.BILLING_VIEW)
  listOrderBills(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.financeService.listOrderBills(id, request.user);
  }

  @Get("orders/:id/finance-summary")
  @RequirePermissions(PermissionCode.BILLING_VIEW)
  getOrderFinanceSummary(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.financeService.getOrderFinanceSummary(id, request.user);
  }

  @Post("payments")
  @RequirePermissions(PermissionCode.PAYMENT_CREATE)
  createPayment(@Body() dto: CreatePaymentDto, @Req() request: AuthenticatedRequest) {
    return this.financeService.createPayment(dto, request.user, requestContext(request));
  }

  @Post("payments/:id/write-off")
  @RequirePermissions(PermissionCode.PAYMENT_WRITE_OFF)
  writeOffPayment(@Param("id") id: string, @Body() dto: WriteOffPaymentDto, @Req() request: AuthenticatedRequest) {
    return this.financeService.writeOffPayment(id, dto, request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
