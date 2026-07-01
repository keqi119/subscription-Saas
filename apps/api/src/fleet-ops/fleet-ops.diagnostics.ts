import { FleetOpsInvariantStatus, type FleetOpsInvariantResult } from "./fleet-ops.invariants";

export type FleetOpsReleaseDiagnosticStatus = "FAIL" | "PASS" | "WARN";

export interface FleetOpsDiagnosticsInput {
  facadeReady: boolean;
  healthReady: boolean;
  invariantResults: FleetOpsInvariantResult[];
  knownIssues?: string[];
  moduleLoaded: boolean;
  readonlyViolations: string[];
}

export interface FleetOpsDiagnosticsSummary {
  facadeReady: boolean;
  healthReady: boolean;
  invariantStatus: FleetOpsReleaseDiagnosticStatus;
  knownIssues: string[];
  moduleLoaded: boolean;
  readonlyStatus: FleetOpsReleaseDiagnosticStatus;
}

export function buildFleetOpsDiagnostics(input: FleetOpsDiagnosticsInput): FleetOpsDiagnosticsSummary {
  return {
    facadeReady: input.facadeReady,
    healthReady: input.healthReady,
    invariantStatus: summarizeInvariants(input.invariantResults),
    knownIssues: [...(input.knownIssues ?? [])],
    moduleLoaded: input.moduleLoaded,
    readonlyStatus: input.readonlyViolations.length === 0 ? "PASS" : "FAIL"
  };
}

function summarizeInvariants(results: FleetOpsInvariantResult[]): FleetOpsReleaseDiagnosticStatus {
  if (results.some((result) => result.status === FleetOpsInvariantStatus.FAIL)) {
    return "FAIL";
  }

  return results.length > 0 ? "PASS" : "WARN";
}
