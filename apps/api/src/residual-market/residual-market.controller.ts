import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  ActivateResidualCurveDto,
  ArchiveResidualCurveDto,
  CreateMarketPriceObservationDto,
  GenerateResidualCurveDto,
  ImportMarketPriceCsvDto,
  MarketPriceImportBatchesQueryDto,
  MarketPriceObservationsQueryDto,
  ResidualCurveQueryDto,
  VoidMarketPriceObservationDto
} from "./dto/residual-market.dto";
import { ResidualMarketService } from "./residual-market.service";

@Controller("residual-market")
@UseGuards(AuthGuard, PermissionsGuard)
export class ResidualMarketController {
  constructor(private readonly residualMarketService: ResidualMarketService) {}

  @Get("observations")
  @RequirePermissions(PermissionCode.RESIDUAL_MARKET_VIEW)
  listObservations(@Query() query: MarketPriceObservationsQueryDto) {
    return this.residualMarketService.listObservations(query);
  }

  @Get("observations/:id")
  @RequirePermissions(PermissionCode.RESIDUAL_MARKET_VIEW)
  getObservation(@Param("id") id: string) {
    return this.residualMarketService.getObservation(id);
  }

  @Post("observations")
  @RequirePermissions(PermissionCode.RESIDUAL_MARKET_MANAGE)
  createObservation(@Body() dto: CreateMarketPriceObservationDto, @Req() request: AuthenticatedRequest) {
    return this.residualMarketService.createObservation(dto, request.user, requestContext(request));
  }

  @Post("observations/import-csv")
  @RequirePermissions(PermissionCode.RESIDUAL_MARKET_IMPORT)
  importCsv(@Body() dto: ImportMarketPriceCsvDto, @Req() request: AuthenticatedRequest) {
    return this.residualMarketService.importCsv(dto, request.user, requestContext(request));
  }

  @Post("observations/:id/void")
  @RequirePermissions(PermissionCode.RESIDUAL_MARKET_MANAGE)
  voidObservation(
    @Param("id") id: string,
    @Body() dto: VoidMarketPriceObservationDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.residualMarketService.voidObservation(id, dto, request.user, requestContext(request));
  }

  @Get("import-batches")
  @RequirePermissions(PermissionCode.RESIDUAL_MARKET_VIEW)
  listImportBatches(@Query() query: MarketPriceImportBatchesQueryDto) {
    return this.residualMarketService.listImportBatches(query);
  }

  @Get("import-batches/:id")
  @RequirePermissions(PermissionCode.RESIDUAL_MARKET_VIEW)
  getImportBatch(@Param("id") id: string) {
    return this.residualMarketService.getImportBatch(id);
  }

  @Post("curves/generate")
  @RequirePermissions(PermissionCode.RESIDUAL_CURVE_GENERATE)
  generateCurve(@Body() dto: GenerateResidualCurveDto, @Req() request: AuthenticatedRequest) {
    return this.residualMarketService.generateCurve(dto, request.user, requestContext(request));
  }

  @Get("curves")
  @RequirePermissions(PermissionCode.RESIDUAL_CURVE_VIEW)
  listCurves(@Query() query: ResidualCurveQueryDto) {
    return this.residualMarketService.listCurves(query);
  }

  @Get("curves/:id")
  @RequirePermissions(PermissionCode.RESIDUAL_CURVE_VIEW)
  getCurve(@Param("id") id: string) {
    return this.residualMarketService.getCurve(id);
  }

  @Post("curves/:id/activate")
  @RequirePermissions(PermissionCode.RESIDUAL_CURVE_MANAGE)
  activateCurve(
    @Param("id") id: string,
    @Body() dto: ActivateResidualCurveDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.residualMarketService.activateCurve(id, dto, request.user, requestContext(request));
  }

  @Post("curves/:id/archive")
  @RequirePermissions(PermissionCode.RESIDUAL_CURVE_MANAGE)
  archiveCurve(
    @Param("id") id: string,
    @Body() dto: ArchiveResidualCurveDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.residualMarketService.archiveCurve(id, dto, request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
