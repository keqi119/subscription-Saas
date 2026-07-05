export const FLEET_OPS_API_ENABLED_KEY = "FLEET_OPS_API_ENABLED";
export const FLEET_OPS_API_MAX_RANGE_DAYS = 366;
export const FLEET_OPS_VEHICLE_LOOKUP_DEFAULT_LIMIT = 10;
export const FLEET_OPS_VEHICLE_LOOKUP_MAX_LIMIT = 20;
export const FLEET_OPS_VEHICLE_LOOKUP_MIN_PARTIAL_QUERY_LENGTH = 2;
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

export interface FleetOpsVehicleLookupItem {
  brand?: string;
  model?: string;
  modelYear?: number;
  operationalState?: string;
  plateMasked?: string;
  statusLabel?: string;
  vehicleId: string;
  vehicleNo?: string;
  vinSuffix?: string;
}

export interface FleetOpsVehicleLookupPayload {
  items: FleetOpsVehicleLookupItem[];
  limit: number;
  query: string;
}
