import type { ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";

import { FleetOpsApiDisabledException } from "../src/fleet-ops/fleet-ops.api.errors";
import { FleetOpsApiEnabledGuard, isFleetOpsApiEnabled } from "../src/fleet-ops/fleet-ops.api.guard";
import { FleetOpsController } from "../src/fleet-ops/fleet-ops.controller";

describe("Fleet Ops API feature gate", () => {
  it("is disabled by default unless explicitly enabled", () => {
    expect(isFleetOpsApiEnabled(configValue(undefined))).toBe(false);
    expect(isFleetOpsApiEnabled(configValue("false"))).toBe(false);
    expect(isFleetOpsApiEnabled(configValue("0"))).toBe(false);
    expect(isFleetOpsApiEnabled(configValue("true"))).toBe(true);
    expect(isFleetOpsApiEnabled(configValue("1"))).toBe(true);
    expect(isFleetOpsApiEnabled(configValue("enabled"))).toBe(true);
  });

  it("blocks business endpoints with a stable disabled response", () => {
    const guard = new FleetOpsApiEnabledGuard(configValue(undefined) as never);

    expect(() => guard.canActivate(executionContext({ requestId: "req-1", traceId: "trace-1" }))).toThrow(
      FleetOpsApiDisabledException
    );

    try {
      guard.canActivate(executionContext({ requestId: "req-1", traceId: "trace-1" }));
    } catch (error) {
      expect((error as FleetOpsApiDisabledException).getResponse()).toEqual({
        code: "FLEET_OPS_API_DISABLED",
        details: { configKey: "FLEET_OPS_API_ENABLED" },
        message: "Fleet Ops API is disabled.",
        requestId: "req-1",
        traceId: "trace-1"
      });
    }
  });

  it("allows business endpoints when the feature flag is explicitly enabled", () => {
    const guard = new FleetOpsApiEnabledGuard(configValue("true") as never);

    expect(guard.canActivate(executionContext())).toBe(true);
  });

  it("feature-gates diagnostics and business endpoints while leaving health status readable", () => {
    const prototype = FleetOpsController.prototype;
    const gatedMethods = [
      "getDiagnostics",
      "getVehicleEconomics",
      "getVehicleRisk",
      "getVehicleSnapshot",
      "getVehicleState",
      "getVehicleTimeline"
    ];

    for (const method of gatedMethods) {
      expect(Reflect.getMetadata(GUARDS_METADATA, prototype[method as keyof FleetOpsController])).toContain(FleetOpsApiEnabledGuard);
    }

    expect(Reflect.getMetadata(GUARDS_METADATA, prototype.getHealth) ?? []).not.toContain(FleetOpsApiEnabledGuard);
  });
});

function configValue(value: string | undefined): { get<T = unknown>(key: string): T | undefined } {
  return {
    get: <T = unknown>() => value as T | undefined
  };
}

function executionContext(query: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: {},
        query
      })
    })
  } as never;
}
