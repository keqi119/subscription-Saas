import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  FleetOpsApiInvalidDateException,
  FleetOpsApiInvalidRangeException,
  FleetOpsApiRangeTooLargeException
} from "../src/fleet-ops/fleet-ops.api.errors";
import { FleetOpsController } from "../src/fleet-ops/fleet-ops.controller";

describe("Fleet Ops API contract", () => {
  it("exposes only the approved read endpoints", () => {
    expect(Reflect.getMetadata(PATH_METADATA, FleetOpsController)).toBe("fleet-ops");
    expect(controllerRoutes()).toEqual([
      { method: RequestMethod.GET, path: "diagnostics" },
      { method: RequestMethod.GET, path: "health" },
      { method: RequestMethod.GET, path: "vehicles/:vehicleId/economics" },
      { method: RequestMethod.GET, path: "vehicles/:vehicleId/risk" },
      { method: RequestMethod.GET, path: "vehicles/:vehicleId/snapshot" },
      { method: RequestMethod.GET, path: "vehicles/:vehicleId/state" },
      { method: RequestMethod.GET, path: "vehicles/:vehicleId/timeline" }
    ]);
  });

  it("returns stable response and error envelope shapes", () => {
    const controller = createController();
    const health = controller.getHealth({ requestId: "req-1", traceId: "trace-1" });

    expect(health).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ enabled: true }),
        generatedAt: expect.any(String),
        requestId: "req-1",
        traceId: "trace-1"
      })
    );
    expect(new FleetOpsApiRangeTooLargeException(366, { requestId: "req-2" }).getResponse()).toEqual({
      code: "FLEET_OPS_RANGE_TOO_LARGE",
      details: { maxRangeDays: 366 },
      message: "Fleet Ops timeline range must not exceed 366 days.",
      requestId: "req-2"
    });
  });

  it("validates date inputs and the 366-day max range before facade calls", async () => {
    const controller = createController();
    const params = { vehicleId: "00000000-0000-4000-8000-000000000001" };

    await expect(
      controller.getVehicleTimeline(params, {
        from: "2026-07-03T00:00:00.000Z",
        to: "2026-07-01T00:00:00.000Z"
      })
    ).rejects.toThrow(FleetOpsApiInvalidRangeException);
    await expect(
      controller.getVehicleTimeline(params, {
        from: "not-a-date",
        to: "2026-07-01T00:00:00.000Z"
      })
    ).rejects.toThrow(FleetOpsApiInvalidDateException);
    await expect(
      controller.getVehicleTimeline(params, {
        from: "2026-01-01T00:00:00.000Z",
        to: "2027-01-03T00:00:00.000Z"
      })
    ).rejects.toThrow(FleetOpsApiRangeTooLargeException);
  });
});

function controllerRoutes() {
  const prototype = FleetOpsController.prototype;

  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== "constructor")
    .map((name) => ({
      method: Reflect.getMetadata(METHOD_METADATA, prototype[name as keyof FleetOpsController]),
      path: Reflect.getMetadata(PATH_METADATA, prototype[name as keyof FleetOpsController])
    }))
    .filter((route) => route.path !== undefined)
    .sort((left, right) => String(left.path).localeCompare(String(right.path)));
}

function createController() {
  return new FleetOpsController(
    {
      getVehicleTimeline: vi.fn().mockResolvedValue([]),
      query: vi.fn()
    } as never,
    {
      getHealth: vi.fn().mockReturnValue({ stateEngine: "OK" })
    } as never,
    {
      get: vi.fn(() => "true")
    } as never
  );
}
