import { Injectable } from "@nestjs/common";

import {
  FLEET_OPS_API_MAX_RANGE_DAYS,
  FLEET_OPS_OVERVIEW_DEFAULT_TOP_N,
  FLEET_OPS_OVERVIEW_MAX_TOP_N
} from "./fleet-ops.api.types";
import {
  FleetOpsApiInvalidDateException,
  FleetOpsApiInvalidRangeException,
  FleetOpsApiRangeTooLargeException
} from "./fleet-ops.api.errors";
import { FleetOpsPoolAggregatorService } from "./fleet-ops.pool-aggregator.service";
import type {
  FleetOpsOverviewQueryInput,
  FleetOpsOverviewReadModel,
  FleetOpsPoolDetailReadModel,
  FleetOpsPoolListQueryInput,
  FleetOpsPoolListReadModel,
  FleetOpsScopedVehicleListReadModel
} from "./fleet-ops.pool-read-model";
import { FleetOpsScopeResolverService } from "./fleet-ops.scope-resolver.service";

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class FleetOpsOverviewService {
  constructor(
    private readonly scopeResolver: FleetOpsScopeResolverService,
    private readonly poolAggregator: FleetOpsPoolAggregatorService
  ) {}

  async getOverview(query: FleetOpsOverviewQueryInput): Promise<FleetOpsOverviewReadModel> {
    const range = parseRange(query);
    const scope = await this.scopeResolver.resolveScope(query);

    return this.poolAggregator.buildOverview(scope, range, {
      topN: normalizeTopN(query.topN)
    });
  }

  async listPools(query: FleetOpsPoolListQueryInput): Promise<FleetOpsPoolListReadModel> {
    return this.scopeResolver.listPools(query);
  }

  async getPoolDetail(poolId: string, query: FleetOpsOverviewQueryInput): Promise<FleetOpsPoolDetailReadModel> {
    const overview = await this.getOverview({
      ...query,
      poolId,
      scopeType: "POOL"
    });
    const pool = overview.scope.pool ?? (await this.scopeResolver.getPoolIdentity(poolId));

    if (!pool) {
      throw new FleetOpsApiInvalidRangeException(query);
    }

    return {
      activeVehicleCount: pool.activeVehicleCount,
      generatedAt: new Date().toISOString(),
      overview,
      pool,
      warnings: overview.warnings
    };
  }

  async listOverviewVehicles(query: FleetOpsOverviewQueryInput): Promise<FleetOpsScopedVehicleListReadModel> {
    return this.scopeResolver.listScopedVehicles(query);
  }
}

function parseRange(query: FleetOpsOverviewQueryInput) {
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

function parseOptionalDate(field: string, value: string | undefined, context: FleetOpsOverviewQueryInput): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new FleetOpsApiInvalidDateException(field, context);
  }

  return date;
}

function normalizeTopN(value: number | undefined) {
  const parsed = Number(value ?? FLEET_OPS_OVERVIEW_DEFAULT_TOP_N);
  if (!Number.isFinite(parsed)) {
    return FLEET_OPS_OVERVIEW_DEFAULT_TOP_N;
  }

  return Math.max(1, Math.min(FLEET_OPS_OVERVIEW_MAX_TOP_N, Math.trunc(parsed)));
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
