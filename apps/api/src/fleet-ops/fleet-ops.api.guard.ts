import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { FleetOpsApiDisabledException } from "./fleet-ops.api.errors";
import { FLEET_OPS_API_ENABLED_KEY, type FleetOpsApiRequestContext } from "./fleet-ops.api.types";

interface FleetOpsConfigReader {
  get<T = unknown>(key: string): T | undefined;
}

@Injectable()
export class FleetOpsApiEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (isFleetOpsApiEnabled(this.config)) {
      return true;
    }

    throw new FleetOpsApiDisabledException(requestContextFromExecutionContext(context));
  }
}

export function isFleetOpsApiEnabled(config: FleetOpsConfigReader): boolean {
  const value = config.get<string | boolean | number>(FLEET_OPS_API_ENABLED_KEY);

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value === 1;
  }

  if (typeof value !== "string") {
    return false;
  }

  return ["1", "enabled", "on", "true", "yes"].includes(value.trim().toLowerCase());
}

function requestContextFromExecutionContext(context: ExecutionContext): FleetOpsApiRequestContext {
  const request = context.switchToHttp().getRequest<{
    headers?: Record<string, string | string[] | undefined>;
    query?: Record<string, unknown>;
  }>();

  return {
    requestId: firstString(request.query?.requestId) ?? firstString(request.headers?.["x-request-id"]),
    traceId: firstString(request.query?.traceId) ?? firstString(request.headers?.["x-trace-id"])
  };
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return firstString(value[0]);
  }

  return undefined;
}
