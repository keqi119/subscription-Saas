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

  it("routes vehicle lookup through the read-only lookup service", async () => {
    const { controller, facade, vehicleLookupService } = createController("true");

    await expect(controller.lookupVehicles({ limit: 5, q: "VEH-DEMO" })).resolves.toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          items: [expect.objectContaining({ vehicleId, vehicleNo: "VEH-DEMO-001" })],
          limit: 5,
          query: "VEH-DEMO"
        })
      })
    );

    expect(vehicleLookupService.lookup).toHaveBeenCalledWith({ limit: 5, q: "VEH-DEMO" });
    expect(facade.query).not.toHaveBeenCalled();
  });

  it("routes pool overview reads through the read-only overview service", async () => {
    const { controller, facade, overviewService } = createController("true");

    await expect(controller.getOverview({ scopeType: "ALL", topN: 5 })).resolves.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ scope: expect.objectContaining({ type: "ALL" }) }) })
    );
    await expect(controller.listPools({ page: 1, pageSize: 20 })).resolves.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ items: expect.any(Array) }) })
    );
    await expect(controller.getPoolDetail({ poolId: "00000000-0000-4000-8000-000000000010" }, { scopeType: "POOL" })).resolves.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ pool: expect.objectContaining({ poolId: "pool-1" }) }) })
    );
    await expect(controller.listOverviewVehicles({ scopeType: "ALL", page: 1, pageSize: 10 })).resolves.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ items: expect.any(Array) }) })
    );

    expect(overviewService.getOverview).toHaveBeenCalledWith({ scopeType: "ALL", topN: 5 });
    expect(overviewService.listPools).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
    expect(overviewService.getPoolDetail).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000010", { scopeType: "POOL" });
    expect(overviewService.listOverviewVehicles).toHaveBeenCalledWith({ scopeType: "ALL", page: 1, pageSize: 10 });
    expect(facade.query).not.toHaveBeenCalled();
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
  const vehicleLookupService = {
    lookup: vi.fn().mockResolvedValue({
      items: [{ vehicleId, vehicleNo: "VEH-DEMO-001" }],
      limit: 5,
      query: "VEH-DEMO"
    })
  };
  const overviewService = {
    getOverview: vi.fn().mockResolvedValue({
      evidenceSummary: { fullEvidenceIncluded: false },
      scope: { type: "ALL" },
      vehicleCounts: { total: 0 }
    }),
    getPoolDetail: vi.fn().mockResolvedValue({
      overview: { scope: { type: "POOL" } },
      pool: { poolId: "pool-1" }
    }),
    listOverviewVehicles: vi.fn().mockResolvedValue({
      items: [],
      pagination: { page: 1, pageSize: 10, total: 0 }
    }),
    listPools: vi.fn().mockResolvedValue({
      items: [],
      pagination: { page: 1, pageSize: 20, total: 0 }
    })
  };
  const config = {
    get: vi.fn((key: string) => (key === "FLEET_OPS_API_ENABLED" ? featureFlag : undefined))
  };

  return {
    config,
    controller: new FleetOpsController(
      facade as never,
      healthService as never,
      vehicleLookupService as never,
      overviewService as never,
      config as never
    ),
    facade,
    healthService,
    overviewService,
    vehicleLookupService
  };
}
