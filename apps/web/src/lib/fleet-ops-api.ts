import { ApiError, apiFetch } from "./api";

export const FLEET_OPS_UI_MAX_RANGE_DAYS = 366;

export interface FleetOpsApiEnvelope<TData = unknown> {
  data: TData;
  generatedAt?: string;
  requestId?: string;
  traceId?: string;
  warnings?: FleetOpsApiWarning[];
}

export interface FleetOpsApiWarning {
  code?: string;
  message?: string;
  severity?: string;
}

export interface FleetOpsApiHealth {
  enabled?: boolean;
  status?: string;
  service?: string;
  [key: string]: unknown;
}

export interface FleetOpsApiQuery {
  asOf?: string;
  from?: string;
  includeDiagnostics?: boolean;
  includeEconomics?: boolean;
  includeRisk?: boolean;
  includeTimeline?: boolean;
  requestId?: string;
  to?: string;
  traceId?: string;
}

export type FleetOpsSnapshotEnvelope = FleetOpsApiEnvelope<FleetOpsSnapshot>;

export interface FleetOpsSnapshot {
  economics?: Record<string, unknown>;
  evidence?: FleetOpsEvidence[];
  generatedAt?: string;
  risk?: Record<string, unknown>;
  state?: Record<string, unknown>;
  system?: Record<string, unknown>;
  timeline?: Record<string, unknown>;
  warnings?: FleetOpsApiWarning[];
  [key: string]: unknown;
}

export interface FleetOpsEvidence {
  evidenceType?: string;
  layer?: string;
  source?: string;
  sourceId?: string;
  sourceType?: string;
  [key: string]: unknown;
}

export async function getFleetOpsHealth(query?: Pick<FleetOpsApiQuery, "requestId" | "traceId">) {
  return apiFetch<FleetOpsApiEnvelope<FleetOpsApiHealth>>(`/fleet-ops/health${buildFleetOpsQuery(query)}`);
}

export async function getFleetOpsSnapshot(vehicleId: string, query?: FleetOpsApiQuery) {
  assertFleetOpsRange(query);
  return apiFetch<FleetOpsSnapshotEnvelope>(
    `/fleet-ops/vehicles/${encodeURIComponent(vehicleId)}/snapshot${buildFleetOpsQuery(query)}`
  );
}

export async function getFleetOpsState(vehicleId: string, query?: FleetOpsApiQuery) {
  assertFleetOpsRange(query);
  return apiFetch<FleetOpsApiEnvelope<Record<string, unknown>>>(
    `/fleet-ops/vehicles/${encodeURIComponent(vehicleId)}/state${buildFleetOpsQuery(query)}`
  );
}

export async function getFleetOpsTimeline(vehicleId: string, query?: FleetOpsApiQuery) {
  assertFleetOpsRange(query);
  return apiFetch<FleetOpsApiEnvelope<Record<string, unknown>>>(
    `/fleet-ops/vehicles/${encodeURIComponent(vehicleId)}/timeline${buildFleetOpsQuery(query)}`
  );
}

export async function getFleetOpsEconomics(vehicleId: string, query?: FleetOpsApiQuery) {
  assertFleetOpsRange(query);
  return apiFetch<FleetOpsApiEnvelope<Record<string, unknown>>>(
    `/fleet-ops/vehicles/${encodeURIComponent(vehicleId)}/economics${buildFleetOpsQuery(query)}`
  );
}

export async function getFleetOpsRisk(vehicleId: string, query?: FleetOpsApiQuery) {
  assertFleetOpsRange(query);
  return apiFetch<FleetOpsApiEnvelope<Record<string, unknown>>>(
    `/fleet-ops/vehicles/${encodeURIComponent(vehicleId)}/risk${buildFleetOpsQuery(query)}`
  );
}

export function isFleetOpsApiDisabled(value: unknown) {
  if (value instanceof ApiError) {
    return value.status === 403 && /disabled|not enabled/i.test(value.message);
  }

  if (!isObject(value)) {
    return false;
  }

  const envelope = value as unknown as FleetOpsApiEnvelope<FleetOpsApiHealth>;
  const disabledByHealth = isObject(envelope.data) && envelope.data.enabled === false;
  const disabledByWarning = (envelope.warnings ?? []).some((warning) =>
    [warning.code, warning.message].some((item) => typeof item === "string" && /disabled|not enabled/i.test(item))
  );

  return disabledByHealth || disabledByWarning;
}

export function isFleetOpsPermissionDenied(error: unknown) {
  return error instanceof ApiError && error.status === 403;
}

export function buildFleetOpsQuery(query?: FleetOpsApiQuery) {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();
  const entries: Array<[keyof FleetOpsApiQuery, string]> = [
    ["asOf", "asOf"],
    ["from", "from"],
    ["to", "to"],
    ["traceId", "traceId"],
    ["requestId", "requestId"],
    ["includeTimeline", "includeTimeline"],
    ["includeEconomics", "includeEconomics"],
    ["includeRisk", "includeRisk"],
    ["includeDiagnostics", "includeDiagnostics"]
  ];

  for (const [key, param] of entries) {
    const value = query[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(param, String(value));
  }

  const value = params.toString();
  return value ? `?${value}` : "";
}

function assertFleetOpsRange(query?: Pick<FleetOpsApiQuery, "from" | "to">) {
  if (!query?.from || !query.to) {
    return;
  }

  const days = daysBetween(query.from, query.to);
  if (days > FLEET_OPS_UI_MAX_RANGE_DAYS) {
    throw new Error(`Fleet Ops date range must not exceed ${FLEET_OPS_UI_MAX_RANGE_DAYS} days.`);
  }
}

function daysBetween(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.round((end - start) / 86_400_000);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
