import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import type { Response } from "express";

import { RequireAnyPermissions, RequirePermissions } from "../auth/auth.decorators";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  BillDetailQueryDto,
  CollectionCaseDetailQueryDto,
  DepositLedgerDetailQueryDto,
  OrderDetailQueryDto,
  OrderReportQueryDto,
  OverdueBillDetailQueryDto,
  ReportDateRangeQueryDto,
  VehicleDetailQueryDto
} from "./dto/report.dto";
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

  @Get("details/orders")
  @RequirePermissions(PermissionCode.REPORT_VIEW)
  getOrderDetails(@Query() query: OrderDetailQueryDto) {
    return this.reportService.getOrderDetails(query);
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

  @Get("details/bills")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  getBillDetails(@Query() query: BillDetailQueryDto) {
    return this.reportService.getBillDetails(query);
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

  @Get("details/deposit-ledgers")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  getDepositLedgerDetails(@Query() query: DepositLedgerDetailQueryDto) {
    return this.reportService.getDepositLedgerDetails(query);
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

  @Get("details/overdue-bills")
  @RequireAnyPermissions(PermissionCode.REPORT_FINANCE, PermissionCode.COLLECTION_VIEW)
  getOverdueBillDetails(@Query() query: OverdueBillDetailQueryDto) {
    return this.reportService.getOverdueBillDetails(query);
  }

  @Get("details/collection-cases")
  @RequireAnyPermissions(PermissionCode.REPORT_FINANCE, PermissionCode.COLLECTION_VIEW)
  getCollectionCaseDetails(@Query() query: CollectionCaseDetailQueryDto) {
    return this.reportService.getCollectionCaseDetails(query);
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

  @Get("details/vehicles")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  getVehicleDetails(@Query() query: VehicleDetailQueryDto) {
    return this.reportService.getVehicleDetails(query);
  }
}

function csvResponse(response: Response, file: { content: string; filename: string }) {
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  response.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  return file.content;
}
