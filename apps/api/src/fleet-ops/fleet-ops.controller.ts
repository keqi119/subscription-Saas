import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { buildFleetOpsDiagnostics } from "./fleet-ops.diagnostics";
import { FleetOpsApiEnabledGuard, isFleetOpsApiEnabled } from "./fleet-ops.api.guard";
import {
  FleetOpsApiInvalidDateException,
  FleetOpsApiInvalidRangeException,
  FleetOpsApiRangeTooLargeException
} from "./fleet-ops.api.errors";
import {
  FLEET_OPS_API_MAX_RANGE_DAYS,
  FLEET_OPS_READ_PERMISSION,
  type FleetOpsApiDiagnosticsPayload,
  type FleetOpsApiHealthPayload,
  type FleetOpsApiRequestContext,
  type FleetOpsApiResponseEnvelope
} from "./fleet-ops.api.types";
import { FleetOpsFacade } from "./fleet-ops.facade";
import { FleetOpsHealthService } from "./fleet-ops.health.service";
import { FleetOpsOverviewService } from "./fleet-ops.overview.service";
import { FleetOpsVehicleLookupService } from "./fleet-ops.vehicle-lookup.service";
import type { FleetOpsHealthContract } from "./fleet-ops.contracts";
import { FleetOpsOverviewQueryDto } from "./dto/fleet-ops-overview-query.dto";
import { FleetOpsPoolParamDto, FleetOpsPoolQueryDto } from "./dto/fleet-ops-pool-query.dto";
import { FleetOpsQueryDto, FleetOpsVehicleParamDto } from "./dto/fleet-ops-query.dto";
import { FleetOpsRangeQueryDto } from "./dto/fleet-ops-range-query.dto";
import { FleetOpsVehicleLookupQueryDto } from "./dto/fleet-ops-vehicle-lookup.dto";

const DAY_MS = 24 * 60 * 60 * 1000;

@Controller("fleet-ops")
@UseGuards(AuthGuard, PermissionsGuard)
@RequirePermissions(FLEET_OPS_READ_PERMISSION)
export class FleetOpsController {
  constructor(
    private readonly facade: FleetOpsFacade,
    private readonly healthService: FleetOpsHealthService,
    private readonly vehicleLookupService: FleetOpsVehicleLookupService,
    private readonly overviewService: FleetOpsOverviewService,
    private readonly config: ConfigService
  ) {}

  @Get("health")
  getHealth(@Query() query: FleetOpsQueryDto): FleetOpsApiResponseEnvelope<FleetOpsApiHealthPayload<FleetOpsHealthContract>> {
    const enabled = isFleetOpsApiEnabled(this.config);

    return responseEnvelope(
      {
        enabled,
        health: this.healthService.getHealth()
      },
      query,
      enabled ? [] : ["FLEET_OPS_API_DISABLED"]
    );
  }

  @Get("diagnostics")
  @UseGuards(FleetOpsApiEnabledGuard)
  getDiagnostics(@Query() query: FleetOpsQueryDto) {
    const health = this.healthService.getHealth();

    return responseEnvelope<FleetOpsApiDiagnosticsPayload<ReturnType<typeof buildFleetOpsDiagnostics>, FleetOpsHealthContract>>(
      {
        diagnostics: buildFleetOpsDiagnostics({
          facadeReady: true,
          healthReady: true,
          invariantResults: [],
          knownIssues: [],
          moduleLoaded: true,
          readonlyViolations: []
        }),
        enabled: true,
        health
      },
      query
    );
  }

  @Get("vehicles/lookup")
  @UseGuards(FleetOpsApiEnabledGuard)
  async lookupVehicles(@Query() query: FleetOpsVehicleLookupQueryDto) {
    return responseEnvelope(await this.vehicleLookupService.lookup(query));
  }

  @Get("overview")
  @UseGuards(FleetOpsApiEnabledGuard)
  async getOverview(@Query() query: FleetOpsOverviewQueryDto) {
    return responseEnvelope(await this.overviewService.getOverview(query), query);
  }

  @Get("overview/vehicles")
  @UseGuards(FleetOpsApiEnabledGuard)
  async listOverviewVehicles(@Query() query: FleetOpsOverviewQueryDto) {
    return responseEnvelope(await this.overviewService.listOverviewVehicles(query), query);
  }

  @Get("pools")
  @UseGuards(FleetOpsApiEnabledGuard)
  async listPools(@Query() query: FleetOpsPoolQueryDto) {
    return responseEnvelope(await this.overviewService.listPools(query), query);
  }

  @Get("pools/:poolId")
  @UseGuards(FleetOpsApiEnabledGuard)
  async getPoolDetail(@Param() params: FleetOpsPoolParamDto, @Query() query: FleetOpsOverviewQueryDto) {
    return responseEnvelope(await this.overviewService.getPoolDetail(params.poolId, query), query);
  }

  @Get("vehicles/:vehicleId/snapshot")
  @UseGuards(FleetOpsApiEnabledGuard)
  async getVehicleSnapshot(@Param() params: FleetOpsVehicleParamDto, @Query() query: FleetOpsRangeQueryDto) {
    const range = parseRange(query);

    return responseEnvelope(
      await this.facade.query(params.vehicleId, {
        asOf: parseOptionalDate("asOf", query.asOf, query) ?? range.to,
        from: range.from,
        to: range.to
      }),
      query
    );
  }

  @Get("vehicles/:vehicleId/state")
  @UseGuards(FleetOpsApiEnabledGuard)
  async getVehicleState(@Param() params: FleetOpsVehicleParamDto, @Query() query: FleetOpsQueryDto) {
    return responseEnvelope(await this.facade.getVehicleState(params.vehicleId, parseOptionalDate("asOf", query.asOf, query)), query);
  }

  @Get("vehicles/:vehicleId/timeline")
  @UseGuards(FleetOpsApiEnabledGuard)
  async getVehicleTimeline(@Param() params: FleetOpsVehicleParamDto, @Query() query: FleetOpsRangeQueryDto) {
    const range = parseRange(query);

    return responseEnvelope(await this.facade.getVehicleTimeline(params.vehicleId, range.from, range.to), query);
  }

  @Get("vehicles/:vehicleId/economics")
  @UseGuards(FleetOpsApiEnabledGuard)
  async getVehicleEconomics(@Param() params: FleetOpsVehicleParamDto, @Query() query: FleetOpsRangeQueryDto) {
    const range = parseRange(query);

    return responseEnvelope(await this.facade.getVehicleKpi(params.vehicleId, range), query);
  }

  @Get("vehicles/:vehicleId/risk")
  @UseGuards(FleetOpsApiEnabledGuard)
  async getVehicleRisk(@Param() params: FleetOpsVehicleParamDto, @Query() query: FleetOpsRangeQueryDto) {
    const range = parseRange(query);

    return responseEnvelope(await this.facade.getVehicleRisk(params.vehicleId, range), query);
  }
}

function responseEnvelope<TData>(
  data: TData,
  context: FleetOpsApiRequestContext = {},
  warnings: string[] = []
): FleetOpsApiResponseEnvelope<TData> {
  return {
    data,
    generatedAt: new Date().toISOString(),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.traceId ? { traceId: context.traceId } : {}),
    ...(warnings.length > 0 ? { warnings: [...warnings].sort() } : {})
  };
}

function parseRange(query: FleetOpsRangeQueryDto) {
  const asOf = parseOptionalDate("asOf", query.asOf, query) ?? new Date();
  const to = parseOptionalDate("to", query.to, query) ?? asOf;
  const from = parseOptionalDate("from", query.from, query) ?? startOfUtcDay(to);

  if (from.getTime() > to.getTime()) {
    throw new FleetOpsApiInvalidRangeException(query);
  }

  if ((to.getTime() - from.getTime()) / DAY_MS > FLEET_OPS_API_MAX_RANGE_DAYS) {
    throw new FleetOpsApiRangeTooLargeException(FLEET_OPS_API_MAX_RANGE_DAYS, query);
  }

  return { from, to };
}

function parseOptionalDate(field: string, value: string | undefined, context: FleetOpsApiRequestContext): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new FleetOpsApiInvalidDateException(field, context);
  }

  return date;
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
