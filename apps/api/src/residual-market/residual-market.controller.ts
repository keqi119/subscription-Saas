import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  CreateMarketPriceObservationDto,
  ImportMarketPriceCsvDto,
  MarketPriceImportBatchesQueryDto,
  MarketPriceObservationsQueryDto,
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
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
