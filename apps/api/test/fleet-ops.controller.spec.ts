import { describe, expect, it, vi } from "vitest";

import { FleetOpsController } from "../src/fleet-ops/fleet-ops.controller";

const vehicleId = "00000000-0000-4000-8000-000000000001";
const from = "2026-07-01T00:00:00.000Z";
const to = "2026-07-03T00:00:00.000Z";

describe("FleetOpsController", () => {
  it("keeps health read-only and available with disabled state", () => {
    const { controller, facade, healthService } = createController();

    const response = controller.getHealth({ requestId: "health-1", traceId: "trace-1" });

    expect(response).toEqual(
      expect.objectContaining({
        requestId: "health-1",
        traceId: "trace-1",
        warnings: ["FLEET_OPS_API_DISABLED"]
      })
    );
    expect(response.data).toEqual({
      enabled: false,
      health: expect.objectContaining({ stateEngine: "OK", timelineEngine: "OK" })
    });
    expect(healthService.getHealth).toHaveBeenCalledTimes(1);
    expect(facade.query).not.toHaveBeenCalled();
    expect(facade.getVehicleState).not.toHaveBeenCalled();
  });

  it("routes business reads through the root FleetOpsFacade", async () => {
    const { controller, facade } = createController("true");
    const params = { vehicleId };
    const query = { from, requestId: "req-1", to };

    await expect(controller.getVehicleSnapshot(params, query)).resolves.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ vehicleId }) })
    );
    await expect(controller.getVehicleState(params, { asOf: to })).resolves.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ vehicleId }) })
    );
    await expect(controller.getVehicleTimeline(params, query)).resolves.toEqual(
      expect.objectContaining({ data: expect.any(Array) })
    );
    await expect(controller.getVehicleEconomics(params, query)).resolves.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ vehicleId }) })
    );
    await expect(controller.getVehicleRisk(params, query)).resolves.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ vehicleId }) })
    );

    expect(facade.query).toHaveBeenCalledWith(vehicleId, {
      asOf: new Date(to),
      from: new Date(from),
      to: new Date(to)
    });
    expect(facade.getVehicleState).toHaveBeenCalledWith(vehicleId, new Date(to));
    expect(facade.getVehicleTimeline).toHaveBeenCalledWith(vehicleId, new Date(from), new Date(to));
    expect(facade.getVehicleKpi).toHaveBeenCalledWith(vehicleId, { from: new Date(from), to: new Date(to) });
    expect(facade.getVehicleRisk).toHaveBeenCalledWith(vehicleId, { from: new Date(from), to: new Date(to) });
  });

  it("keeps diagnostics away from business and execution paths", () => {
    const { controller, facade, healthService } = createController("true");

    const response = controller.getDiagnostics({ requestId: "diagnostics-1" });

    expect(response.data).toEqual(
      expect.objectContaining({
        diagnostics: expect.objectContaining({
          facadeReady: true,
          healthReady: true,
          moduleLoaded: true
        }),
        enabled: true,
        health: expect.objectContaining({ stateEngine: "OK" })
      })
    );
    expect(healthService.getHealth).toHaveBeenCalledTimes(1);
    expect(facade.query).not.toHaveBeenCalled();
    expect(facade.coordinateFleetDecision).not.toHaveBeenCalled();
  });
});

function createController(featureFlag?: string) {
  const facade = {
    coordinateFleetDecision: vi.fn(),
    getVehicleKpi: vi.fn().mockResolvedValue({ vehicleId }),
    getVehicleRisk: vi.fn().mockResolvedValue({ vehicleId }),
    getVehicleState: vi.fn().mockResolvedValue({ vehicleId }),
    getVehicleTimeline: vi.fn().mockResolvedValue([{ date: "2026-07-01" }]),
    query: vi.fn().mockResolvedValue({ vehicleId })
  };
  const healthService = {
    getHealth: vi.fn().mockReturnValue({
      coordinationEngine: "OK",
      economicsEngine: "OK",
      executionEngine: "OK",
      governanceEngine: "OK",
      optimizationEngine: "OK",
      riskEngine: "OK",
      stateEngine: "OK",
      timelineEngine: "OK"
    })
  };
  const config = {
    get: vi.fn((key: string) => (key === "FLEET_OPS_API_ENABLED" ? featureFlag : undefined))
  };

  return {
    config,
    controller: new FleetOpsController(facade as never, healthService as never, config as never),
    facade,
    healthService
  };
}
