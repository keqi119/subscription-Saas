import type { FleetOpsApiErrorEnvelope, FleetOpsApiResponseEnvelope } from "../fleet-ops.api.types";

export class FleetOpsApiResponseDto<TData = unknown> implements FleetOpsApiResponseEnvelope<TData> {
  data!: TData;
  generatedAt!: string;
  requestId?: string;
  traceId?: string;
  warnings?: string[];
}

export class FleetOpsApiErrorResponseDto implements FleetOpsApiErrorEnvelope {
  code!: string;
  details?: Record<string, unknown>;
  message!: string;
  requestId?: string;
  traceId?: string;
}
