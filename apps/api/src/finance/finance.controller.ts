import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  CloseCollectionCaseDto,
  CollectionCasesQueryDto,
  CreateCollectionActionDto,
  CreatePaymentDto,
  GenerateMonthlyRentBillsDto,
  OverdueBillsQueryDto,
  RefreshOverdueBillsDto,
  WriteOffPaymentDto
} from "./dto/finance.dto";
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

  @Post("orders/:id/generate-next-monthly-bill")
  @RequirePermissions(PermissionCode.BILLING_GENERATE)
  generateNextMonthlyRentBill(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.financeService.generateNextMonthlyRentBill(id, request.user, requestContext(request));
  }

  @Post("billing/monthly-rent/generate")
  @RequirePermissions(PermissionCode.BILLING_GENERATE)
  generateMonthlyRentBills(@Body() dto: GenerateMonthlyRentBillsDto, @Req() request: AuthenticatedRequest) {
    return this.financeService.generateMonthlyRentBills(dto, request.user, requestContext(request));
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

  @Post("billing/overdue/refresh")
  @RequirePermissions("collection:refresh_overdue")
  refreshOverdueBills(@Body() dto: RefreshOverdueBillsDto, @Req() request: AuthenticatedRequest) {
    return this.financeService.refreshOverdueBills(dto, request.user, requestContext(request));
  }

  @Get("billing/overdue-bills")
  @RequirePermissions("collection:view")
  listOverdueBills(@Query() query: OverdueBillsQueryDto, @Req() request: AuthenticatedRequest) {
    return this.financeService.listOverdueBills(query, request.user);
  }

  @Get("collection-cases")
  @RequirePermissions("collection:view")
  listCollectionCases(@Query() query: CollectionCasesQueryDto, @Req() request: AuthenticatedRequest) {
    return this.financeService.listCollectionCases(query, request.user);
  }

  @Get("collection-cases/:id")
  @RequirePermissions("collection:view")
  getCollectionCase(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.financeService.getCollectionCase(id, request.user);
  }

  @Post("collection-cases/:id/actions")
  @RequirePermissions("collection:action_create")
  createCollectionAction(
    @Param("id") id: string,
    @Body() dto: CreateCollectionActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.financeService.createCollectionAction(id, dto, request.user, requestContext(request));
  }

  @Post("collection-cases/:id/close")
  @RequirePermissions("collection:close")
  closeCollectionCase(
    @Param("id") id: string,
    @Body() dto: CloseCollectionCaseDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.financeService.closeCollectionCase(id, dto, request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
