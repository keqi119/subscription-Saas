import { Controller, Get, Param, Query, Res, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import type { Response } from "express";

import { RequireAnyPermissions, RequirePermissions } from "../auth/auth.decorators";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  BillDetailQueryDto,
  AssetReturnTrialQueryDto,
  AssetReturnTrialVehicleDetailQueryDto,
  AssetReturnTrialVehicleListQueryDto,
  AssetProfitabilityQueryDto,
  AssetProfitabilityVehicleDetailQueryDto,
  AssetProfitabilityVehicleListQueryDto,
  CollectionCaseDetailQueryDto,
  DepositLedgerDetailQueryDto,
  EntitlementGrantDetailQueryDto,
  EntitlementReportQueryDto,
  EntitlementUsageDetailQueryDto,
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
  async exportOrderReport(
    @Query() query: OrderReportQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportOrderReport(query));
  }

  @Get("details/orders")
  @RequirePermissions(PermissionCode.REPORT_VIEW)
  getOrderDetails(@Query() query: OrderDetailQueryDto) {
    return this.reportService.getOrderDetails(query);
  }

  @Get("details/orders/export")
  @RequirePermissions(PermissionCode.REPORT_VIEW)
  async exportOrderDetails(
    @Query() query: OrderDetailQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportOrderDetails(query));
  }

  @Get("finance")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  getFinanceReport(@Query() query: ReportDateRangeQueryDto) {
    return this.reportService.getFinanceReport(query);
  }

  @Get("finance/export")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  async exportFinanceReport(
    @Query() query: ReportDateRangeQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportFinanceReport(query));
  }

  @Get("details/bills")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  getBillDetails(@Query() query: BillDetailQueryDto) {
    return this.reportService.getBillDetails(query);
  }

  @Get("details/bills/export")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  async exportBillDetails(
    @Query() query: BillDetailQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportBillDetails(query));
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

  @Get("details/deposit-ledgers/export")
  @RequirePermissions(PermissionCode.REPORT_FINANCE)
  async exportDepositLedgerDetails(
    @Query() query: DepositLedgerDetailQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportDepositLedgerDetails(query));
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

  @Get("details/overdue-bills/export")
  @RequireAnyPermissions(PermissionCode.REPORT_FINANCE, PermissionCode.COLLECTION_VIEW)
  async exportOverdueBillDetails(
    @Query() query: OverdueBillDetailQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportOverdueBillDetails(query));
  }

  @Get("details/collection-cases")
  @RequireAnyPermissions(PermissionCode.REPORT_FINANCE, PermissionCode.COLLECTION_VIEW)
  getCollectionCaseDetails(@Query() query: CollectionCaseDetailQueryDto) {
    return this.reportService.getCollectionCaseDetails(query);
  }

  @Get("details/collection-cases/export")
  @RequireAnyPermissions(PermissionCode.REPORT_FINANCE, PermissionCode.COLLECTION_VIEW)
  async exportCollectionCaseDetails(
    @Query() query: CollectionCaseDetailQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportCollectionCaseDetails(query));
  }

  @Get("vehicle-assets")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  getVehicleAssetReport(@Query() query: ReportDateRangeQueryDto) {
    return this.reportService.getVehicleAssetReport(query);
  }

  @Get("asset-profitability/summary")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  getAssetProfitabilitySummary(@Query() query: AssetProfitabilityQueryDto) {
    return this.reportService.getAssetProfitabilitySummary(query);
  }

  @Get("asset-profitability/summary/export")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  async exportAssetProfitabilitySummary(
    @Query() query: AssetProfitabilityQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportAssetProfitabilitySummary(query));
  }

  @Get("asset-profitability/returns/summary")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  getAssetReturnTrialSummary(@Query() query: AssetReturnTrialQueryDto) {
    return this.reportService.getAssetReturnTrialSummary(query);
  }

  @Get("asset-profitability/returns/summary/export")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  async exportAssetReturnTrialSummary(
    @Query() query: AssetReturnTrialQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportAssetReturnTrialSummary(query));
  }

  @Get("asset-profitability/returns/vehicles")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  getAssetReturnTrialVehicles(@Query() query: AssetReturnTrialVehicleListQueryDto) {
    return this.reportService.getAssetReturnTrialVehicles(query);
  }

  @Get("asset-profitability/returns/vehicles/export")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  async exportAssetReturnTrialVehicles(
    @Query() query: AssetReturnTrialVehicleListQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportAssetReturnTrialVehicles(query));
  }

  @Get("asset-profitability/returns/vehicles/:id/export")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  async exportAssetReturnTrialVehicleDetail(
    @Param("id") id: string,
    @Query() query: AssetReturnTrialVehicleDetailQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(
      response,
      await this.reportService.exportAssetReturnTrialVehicleDetail(id, query)
    );
  }

  @Get("asset-profitability/returns/vehicles/:id")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  getAssetReturnTrialVehicleDetail(
    @Param("id") id: string,
    @Query() query: AssetReturnTrialVehicleDetailQueryDto
  ) {
    return this.reportService.getAssetReturnTrialVehicleDetail(id, query);
  }

  @Get("asset-profitability/vehicles")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  getAssetProfitabilityVehicles(@Query() query: AssetProfitabilityVehicleListQueryDto) {
    return this.reportService.getAssetProfitabilityVehicles(query);
  }

  @Get("asset-profitability/vehicles/export")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  async exportAssetProfitabilityVehicles(
    @Query() query: AssetProfitabilityVehicleListQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportAssetProfitabilityVehicles(query));
  }

  @Get("asset-profitability/vehicles/:id/export")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  async exportAssetProfitabilityVehicleDetail(
    @Param("id") id: string,
    @Query() query: AssetProfitabilityVehicleDetailQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(
      response,
      await this.reportService.exportAssetProfitabilityVehicleDetail(id, query)
    );
  }

  @Get("asset-profitability/vehicles/:id")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  getAssetProfitabilityVehicleDetail(
    @Param("id") id: string,
    @Query() query: AssetProfitabilityVehicleDetailQueryDto
  ) {
    return this.reportService.getAssetProfitabilityVehicleDetail(id, query);
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

  @Get("details/vehicles/export")
  @RequirePermissions(PermissionCode.REPORT_ASSET)
  async exportVehicleDetails(
    @Query() query: VehicleDetailQueryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    return csvResponse(response, await this.reportService.exportVehicleDetails(query));
  }

  @Get("entitlements")
  @RequirePermissions(PermissionCode.REPORT_VIEW, PermissionCode.ENTITLEMENT_VIEW)
  getEntitlementReport(@Query() query: EntitlementReportQueryDto) {
    return this.reportService.getEntitlementReport(query);
  }

  @Get("details/entitlement-grants")
  @RequirePermissions(PermissionCode.REPORT_VIEW, PermissionCode.ENTITLEMENT_VIEW)
  getEntitlementGrantDetails(@Query() query: EntitlementGrantDetailQueryDto) {
    return this.reportService.getEntitlementGrantDetails(query);
  }

  @Get("details/entitlement-usages")
  @RequirePermissions(PermissionCode.REPORT_VIEW, PermissionCode.ENTITLEMENT_VIEW)
  getEntitlementUsageDetails(@Query() query: EntitlementUsageDetailQueryDto) {
    return this.reportService.getEntitlementUsageDetails(query);
  }
}

function csvResponse(response: Response, file: { content: string; filename: string }) {
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  response.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  return file.content;
}
