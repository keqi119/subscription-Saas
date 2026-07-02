export const FLEET_OPS_API_ENABLED_KEY = "FLEET_OPS_API_ENABLED";
export const FLEET_OPS_API_MAX_RANGE_DAYS = 366;
export const FLEET_OPS_READ_PERMISSION = "fleet_ops:read";

export interface FleetOpsApiRequestContext {
  requestId?: string;
  traceId?: string;
}

export interface FleetOpsApiResponseEnvelope<TData> extends FleetOpsApiRequestContext {
  data: TData;
  generatedAt: string;
  warnings?: string[];
}

export interface FleetOpsApiErrorEnvelope extends FleetOpsApiRequestContext {
  code: string;
  details?: Record<string, unknown>;
  message: string;
}

export interface FleetOpsApiHealthPayload<THealth> {
  enabled: boolean;
  health: THealth;
}

export interface FleetOpsApiDiagnosticsPayload<TDiagnostics, THealth> {
  diagnostics: TDiagnostics;
  enabled: boolean;
  health: THealth;
}
