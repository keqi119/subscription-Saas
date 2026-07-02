import { BadRequestException, ForbiddenException } from "@nestjs/common";

import type { FleetOpsApiErrorEnvelope, FleetOpsApiRequestContext } from "./fleet-ops.api.types";

export const FleetOpsApiErrorCode = {
  Disabled: "FLEET_OPS_API_DISABLED",
  InvalidDate: "FLEET_OPS_INVALID_DATE",
  InvalidRange: "FLEET_OPS_INVALID_RANGE",
  RangeTooLarge: "FLEET_OPS_RANGE_TOO_LARGE"
} as const;

export type FleetOpsApiErrorCode = (typeof FleetOpsApiErrorCode)[keyof typeof FleetOpsApiErrorCode];

export class FleetOpsApiDisabledException extends ForbiddenException {
  constructor(context: FleetOpsApiRequestContext = {}) {
    super(
      fleetOpsApiError(FleetOpsApiErrorCode.Disabled, "Fleet Ops API is disabled.", context, {
        configKey: "FLEET_OPS_API_ENABLED"
      })
    );
  }
}

export class FleetOpsApiInvalidDateException extends BadRequestException {
  constructor(field: string, context: FleetOpsApiRequestContext = {}) {
    super(
      fleetOpsApiError(FleetOpsApiErrorCode.InvalidDate, `Invalid Fleet Ops date query parameter: ${field}.`, context, {
        field
      })
    );
  }
}

export class FleetOpsApiInvalidRangeException extends BadRequestException {
  constructor(context: FleetOpsApiRequestContext = {}) {
    super(fleetOpsApiError(FleetOpsApiErrorCode.InvalidRange, "Fleet Ops date range must have from <= to.", context));
  }
}

export class FleetOpsApiRangeTooLargeException extends BadRequestException {
  constructor(maxRangeDays: number, context: FleetOpsApiRequestContext = {}) {
    super(
      fleetOpsApiError(FleetOpsApiErrorCode.RangeTooLarge, `Fleet Ops timeline range must not exceed ${maxRangeDays} days.`, context, {
        maxRangeDays
      })
    );
  }
}

export function fleetOpsApiError(
  code: FleetOpsApiErrorCode,
  message: string,
  context: FleetOpsApiRequestContext = {},
  details?: Record<string, unknown>
): FleetOpsApiErrorEnvelope {
  return {
    code,
    ...(details ? { details } : {}),
    message,
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.traceId ? { traceId: context.traceId } : {})
  };
}
