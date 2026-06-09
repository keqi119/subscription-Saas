import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  AllocateFinancingInstrumentVehicleDto,
  CreateFinancingInstrumentDto,
  FinancingInstrumentsQueryDto,
  ReleaseFinancingAllocationDto,
  SettleFinancingInstrumentDto,
  UpdateFinancingInstrumentDto
} from "./dto/financing.dto";
import { FinancingService } from "./financing.service";

const FINANCING_VIEW_PERMISSION = "financing:view";
const FINANCING_MANAGE_PERMISSION = "financing:manage";

@Controller("financing-instruments")
@UseGuards(AuthGuard, PermissionsGuard)
export class FinancingController {
  constructor(private readonly financingService: FinancingService) {}

  @Get()
  @RequirePermissions(FINANCING_VIEW_PERMISSION)
  listInstruments(@Query() query: FinancingInstrumentsQueryDto) {
    return this.financingService.listInstruments(query);
  }

  @Get(":id")
  @RequirePermissions(FINANCING_VIEW_PERMISSION)
  getInstrument(@Param("id") id: string) {
    return this.financingService.getInstrument(id);
  }

  @Post()
  @RequirePermissions(FINANCING_MANAGE_PERMISSION)
  createInstrument(@Body() dto: CreateFinancingInstrumentDto, @Req() request: AuthenticatedRequest) {
    return this.financingService.createInstrument(dto, request.user, requestContext(request));
  }

  @Put(":id")
  @RequirePermissions(FINANCING_MANAGE_PERMISSION)
  updateInstrument(
    @Param("id") id: string,
    @Body() dto: UpdateFinancingInstrumentDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.financingService.updateInstrument(id, dto, request.user, requestContext(request));
  }

  @Post(":id/settle")
  @RequirePermissions(FINANCING_MANAGE_PERMISSION)
  settleInstrument(
    @Param("id") id: string,
    @Body() dto: SettleFinancingInstrumentDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.financingService.settleInstrument(id, dto, request.user, requestContext(request));
  }

  @Post(":id/vehicles")
  @RequirePermissions(FINANCING_MANAGE_PERMISSION)
  allocateVehicle(
    @Param("id") id: string,
    @Body() dto: AllocateFinancingInstrumentVehicleDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.financingService.allocateVehicle(id, dto, request.user, requestContext(request));
  }

  @Post(":id/vehicles/:allocationId/release")
  @RequirePermissions(FINANCING_MANAGE_PERMISSION)
  releaseAllocation(
    @Param("id") id: string,
    @Param("allocationId") allocationId: string,
    @Body() dto: ReleaseFinancingAllocationDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.financingService.releaseAllocation(id, allocationId, dto, request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
