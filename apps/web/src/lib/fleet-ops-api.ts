import { ApiError, apiFetch } from "./api";

export const FLEET_OPS_UI_MAX_RANGE_DAYS = 366;

export interface FleetOpsApiEnvelope<TData = unknown> {
  data: TData;
  generatedAt?: string;
  requestId?: string;
  traceId?: string;
  warnings?: Array<FleetOpsApiWarning | string>;
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

export interface FleetOpsVehicleLookupQuery {
  limit?: number;
  q: string;
}

export type FleetOpsVehicleLookupEnvelope = FleetOpsApiEnvelope<FleetOpsVehicleLookupPayload>;

export interface FleetOpsVehicleLookupPayload {
  items: FleetOpsVehicleLookupItem[];
  limit: number;
  query: string;
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

export type FleetOpsScopeType = "ALL" | "COHORT" | "POOL";
export type FleetOpsAgingBucket = "D1" | "D2" | "D3" | "D4" | "D5" | "NONE";
export type FleetOpsConfidenceBand = "HIGH" | "LOW" | "MEDIUM" | "UNKNOWN";

export interface FleetOpsOverviewQuery extends FleetOpsApiQuery {
  agingBucket?: FleetOpsAgingBucket;
  assetLocation?: string;
  brand?: string;
  collectionLevel?: FleetOpsAgingBucket;
  confidenceBand?: FleetOpsConfidenceBand;
  createdFrom?: string;
  createdTo?: string;
  evidenceMissing?: boolean;
  limit?: number;
  model?: string;
  modelYear?: number;
  overdueStatus?: "NONE" | "OVERDUE";
  page?: number;
  pageSize?: number;
  poolId?: string;
  registrationDateFrom?: string;
  registrationDateTo?: string;
  riskLevel?: string;
  scopeType?: FleetOpsScopeType;
  topN?: number;
  vehicleStatus?: string;
  warningType?: string;
}

export interface FleetOpsPoolListQuery extends Pick<FleetOpsApiQuery, "requestId" | "traceId"> {
  page?: number;
  pageSize?: number;
  poolStatus?: string;
  poolType?: string;
}

export interface FleetOpsPagination {
  page: number;
  pageSize: number;
  total: number;
}

export interface FleetOpsPoolIdentity {
  activeVehicleCount: number;
  poolId: string;
  poolName: string;
  poolNo: string;
  poolStatus: string;
  poolType: string;
}

export interface FleetOpsVehicleScopeItem {
  assetLocation?: string;
  brand?: string;
  model?: string;
  modelYear?: number;
  status?: string;
  vehicleId: string;
  vehicleNo?: string;
  vinSuffix?: string;
}

export interface FleetOpsOverviewAnomalyItem {
  collectionLevel?: string;
  confidence?: number;
  issueCount?: number;
  overdueRemainingAmount?: number;
  riskScore?: number;
  roe?: number;
  roi?: number;
  vehicleId: string;
  vehicleNo?: string;
}

export interface FleetOpsOverviewReadModel {
  anomalies: Record<string, FleetOpsOverviewAnomalyItem[]>;
  cashflow: Record<string, number>;
  dataQuality: Record<string, number>;
  distributions: Record<string, Record<string, number>>;
  evidenceSummary: Record<string, number | boolean>;
  generatedAt: string;
  kpis: Record<string, number>;
  pagination?: FleetOpsPagination;
  range: {
    from: string;
    to: string;
  };
  risk: Record<string, number | Record<string, number>>;
  scope: {
    filters?: Record<string, unknown>;
    pool?: FleetOpsPoolIdentity;
    type: FleetOpsScopeType;
  };
  vehicleCounts: Record<string, number>;
  warnings: string[];
}

export interface FleetOpsPoolListReadModel {
  generatedAt: string;
  items: FleetOpsPoolIdentity[];
  pagination: FleetOpsPagination;
}

export interface FleetOpsPoolDetailReadModel {
  activeVehicleCount: number;
  generatedAt: string;
  overview: FleetOpsOverviewReadModel;
  pool: FleetOpsPoolIdentity;
  warnings: string[];
}

export interface FleetOpsScopedVehicleListReadModel {
  generatedAt: string;
  items: FleetOpsVehicleScopeItem[];
  pagination: FleetOpsPagination;
  scope: FleetOpsOverviewReadModel["scope"];
  warnings: string[];
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

export async function getFleetOpsVehicleLookup(query: FleetOpsVehicleLookupQuery) {
  return apiFetch<FleetOpsVehicleLookupEnvelope>(`/fleet-ops/vehicles/lookup${buildFleetOpsLookupQuery(query)}`);
}

export async function getFleetOpsOverview(query?: FleetOpsOverviewQuery) {
  assertFleetOpsRange(query);
  return apiFetch<FleetOpsApiEnvelope<FleetOpsOverviewReadModel>>(
    `/fleet-ops/overview${buildFleetOpsOverviewQuery(query)}`
  );
}

export async function getFleetOpsOverviewVehicles(query?: FleetOpsOverviewQuery) {
  assertFleetOpsRange(query);
  return apiFetch<FleetOpsApiEnvelope<FleetOpsScopedVehicleListReadModel>>(
    `/fleet-ops/overview/vehicles${buildFleetOpsOverviewQuery(query)}`
  );
}

export async function getFleetOpsPools(query?: FleetOpsPoolListQuery) {
  return apiFetch<FleetOpsApiEnvelope<FleetOpsPoolListReadModel>>(`/fleet-ops/pools${buildFleetOpsPoolQuery(query)}`);
}

export async function getFleetOpsPoolDetail(poolId: string, query?: FleetOpsOverviewQuery) {
  assertFleetOpsRange(query);
  return apiFetch<FleetOpsApiEnvelope<FleetOpsPoolDetailReadModel>>(
    `/fleet-ops/pools/${encodeURIComponent(poolId)}${buildFleetOpsOverviewQuery(query)}`
  );
}

export async function getFleetOpsSnapshot(vehicleId: string, query?: FleetOpsApiQuery) {
  assertFleetOpsRange(query);
  return apiFetch<FleetOpsSnapshotEnvelope>(
    `/fleet-ops/vehicles/${encodeURIComponent(vehicleId)}/snapshot${buildFleetOpsQuery(query)}`
  );
}

export function buildFleetOpsLookupQuery(query: FleetOpsVehicleLookupQuery) {
  const params = new URLSearchParams();
  params.set("q", query.q.trim());

  if (query.limit !== undefined && query.limit !== null) {
    params.set("limit", String(query.limit));
  }

  return `?${params.toString()}`;
}

export function buildFleetOpsOverviewQuery(query?: FleetOpsOverviewQuery) {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();
  const entries: Array<[keyof FleetOpsOverviewQuery, string]> = [
    ["scopeType", "scopeType"],
    ["poolId", "poolId"],
    ["brand", "brand"],
    ["model", "model"],
    ["modelYear", "modelYear"],
    ["vehicleStatus", "vehicleStatus"],
    ["registrationDateFrom", "registrationDateFrom"],
    ["registrationDateTo", "registrationDateTo"],
    ["createdFrom", "createdFrom"],
    ["createdTo", "createdTo"],
    ["assetLocation", "assetLocation"],
    ["riskLevel", "riskLevel"],
    ["collectionLevel", "collectionLevel"],
    ["agingBucket", "agingBucket"],
    ["confidenceBand", "confidenceBand"],
    ["warningType", "warningType"],
    ["evidenceMissing", "evidenceMissing"],
    ["overdueStatus", "overdueStatus"],
    ["from", "from"],
    ["to", "to"],
    ["asOf", "asOf"],
    ["limit", "limit"],
    ["topN", "topN"],
    ["page", "page"],
    ["pageSize", "pageSize"],
    ["traceId", "traceId"],
    ["requestId", "requestId"]
  ];

  appendQueryEntries(params, entries, query);

  const value = params.toString();
  return value ? `?${value}` : "";
}

export function buildFleetOpsPoolQuery(query?: FleetOpsPoolListQuery) {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();
  appendQueryEntries(
    params,
    [
      ["page", "page"],
      ["pageSize", "pageSize"],
      ["poolStatus", "poolStatus"],
      ["poolType", "poolType"],
      ["traceId", "traceId"],
      ["requestId", "requestId"]
    ],
    query
  );

  const value = params.toString();
  return value ? `?${value}` : "";
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
  const disabledByWarning = (envelope.warnings ?? []).some((warning) => {
    const candidates = typeof warning === "string" ? [warning] : [warning.code, warning.message];
    return candidates.some((item) => typeof item === "string" && /disabled|not enabled/i.test(item));
  });

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

function appendQueryEntries<TQuery extends object>(
  params: URLSearchParams,
  entries: Array<[keyof TQuery, string]>,
  query: TQuery
) {
  for (const [key, param] of entries) {
    const value = query[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(param, String(value));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
