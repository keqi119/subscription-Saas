import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequireAnyPermissions, RequirePermissions } from "../auth/auth.decorators";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { OrderReportQueryDto, ReportDateRangeQueryDto } from "./dto/report.dto";
import { ReportService } from "./report.service";

@Controller("reports")
@UseGuards(AuthGuard, PermissionsGuard)
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @Get("dashboard-summary")
  @RequirePermissions(PermissionCode.REPORT_VIEW)
  getDashboardSummary(@Query() query: ReportDateRangeQueryDto) {
    return this.reportService.getDashboardSummary(query);
  }

  @Get("orders")
  @RequirePermissions(PermissionCode.REPORT_VIEW)
  getOrderReport(@Query() query: OrderReportQueryDto) {
    return this.reportService.getOrderReport(query);
  }

  @Get("finance")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  getFinanceReport(@Query() query: ReportDateRangeQueryDto) {
    return this.reportService.getFinanceReport(query);
  }

  @Get("deposit-pool")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  getDepositPoolReport(@Query() query: ReportDateRangeQueryDto) {
    return this.reportService.getDepositPoolReport(query);
  }

  @Get("collections")
  @RequireAnyPermissions(PermissionCode.REPORT_FINANCE, PermissionCode.COLLECTION_VIEW)
  getCollectionReport(@Query() query: ReportDateRangeQueryDto) {
    return this.reportService.getCollectionReport(query);
  }

  @Get("vehicle-assets")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  getVehicleAssetReport(@Query() query: ReportDateRangeQueryDto) {
    return this.reportService.getVehicleAssetReport(query);
  }
}
