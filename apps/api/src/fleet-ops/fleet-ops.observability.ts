import type { FleetOpsHealthContract } from "./fleet-ops.contracts";

export type FleetOpsObservationStatus = "OK" | "WARN" | "ERROR";
export type FleetOpsEngineName = keyof FleetOpsHealthContract;

export interface FleetOpsObservationInput {
  durationMs: number;
  engineName: FleetOpsEngineName;
  operationName: string;
  requestId: string;
  status: FleetOpsObservationStatus;
  traceId: string;
  warnings?: string[];
}

export interface FleetOpsObservationEvent {
  durationMs: number;
  engineName: FleetOpsEngineName;
  operationName: string;
  requestId: string;
  status: FleetOpsObservationStatus;
  traceId: string;
  warnings: string[];
}

export function createFleetOpsObservation(input: FleetOpsObservationInput): FleetOpsObservationEvent {
  return {
    durationMs: Math.max(0, Math.round(input.durationMs)),
    engineName: input.engineName,
    operationName: input.operationName,
    requestId: input.requestId,
    status: input.status,
    traceId: input.traceId,
    warnings: [...(input.warnings ?? [])]
  };
}
