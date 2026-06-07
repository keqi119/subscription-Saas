import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import type { Response } from "express";

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

  @Get("orders/export")
  @RequirePermissions(PermissionCode.REPORT_VIEW)
  async exportOrderReport(@Query() query: OrderReportQueryDto, @Res({ passthrough: true }) response: Response) {
    return csvResponse(response, await this.reportService.exportOrderReport(query));
  }

  @Get("finance")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  getFinanceReport(@Query() query: ReportDateRangeQueryDto) {
    return this.reportService.getFinanceReport(query);
  }

  @Get("finance/export")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  async exportFinanceReport(@Query() query: ReportDateRangeQueryDto, @Res({ passthrough: true }) response: Response) {
    return csvResponse(response, await this.reportService.exportFinanceReport(query));
  }

  @Get("deposit-pool")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  getDepositPoolReport(@Query() query: ReportDateRangeQueryDto) {
    return this.reportService.getDepositPoolReport(query);
  }

  @Get("deposit-pool/export")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  async exportDepositPoolReport(
    @Query() query: ReportDateRangeQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportDepositPoolReport(query));
  }

  @Get("collections")
  @RequireAnyPermissions(PermissionCode.REPORT_FINANCE, PermissionCode.COLLECTION_VIEW)
  getCollectionReport(@Query() query: ReportDateRangeQueryDto) {
    return this.reportService.getCollectionReport(query);
  }

  @Get("collections/export")
  @RequireAnyPermissions(PermissionCode.REPORT_FINANCE, PermissionCode.COLLECTION_VIEW)
  async exportCollectionReport(
    @Query() query: ReportDateRangeQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportCollectionReport(query));
  }

  @Get("vehicle-assets")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  getVehicleAssetReport(@Query() query: ReportDateRangeQueryDto) {
    return this.reportService.getVehicleAssetReport(query);
  }

  @Get("vehicle-assets/export")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  async exportVehicleAssetReport(
    @Query() query: ReportDateRangeQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportVehicleAssetReport(query));
  }
}

function csvResponse(response: Response, file: { content: string; filename: string }) {
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  response.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  return file.content;
}
