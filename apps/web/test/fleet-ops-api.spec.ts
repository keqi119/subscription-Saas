import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getFleetOpsHealth,
  getFleetOpsSnapshot,
  getFleetOpsState,
  getFleetOpsVehicleLookup,
  isFleetOpsApiDisabled,
  isFleetOpsPermissionDenied
} from "../src/lib/fleet-ops-api";
import { ApiError } from "../src/lib/api";

const vehicleId = "00000000-0000-4000-8000-000000000001";

describe("fleet ops api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the health endpoint with a GET-only request", async () => {
    const fetchMock = mockJsonResponse({
      data: { enabled: false, health: { status: "WARN" } },
      generatedAt: "2026-07-02T00:00:00.000Z",
      warnings: ["FLEET_OPS_API_DISABLED"]
    });

    const result = await getFleetOpsHealth({ requestId: "req-health" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/fleet-ops/health?requestId=req-health",
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({ "Content-Type": "application/json" })
      })
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("method");
    expect(result.data.enabled).toBe(false);
    expect(isFleetOpsApiDisabled(result)).toBe(true);
  });

  it("encodes snapshot query parameters and preserves envelope metadata", async () => {
    const fetchMock = mockJsonResponse({
      data: { vehicleId: "vehicle-1", warnings: ["CURRENT_STATUS_PROJECTED_ACROSS_RANGE"] },
      generatedAt: "2026-07-02T00:00:00.000Z",
      requestId: "req-1",
      traceId: "trace-1",
      warnings: ["CURRENT_STATUS_PROJECTED_ACROSS_RANGE"]
    });

    const result = await getFleetOpsSnapshot("vehicle/with space", {
      asOf: "2026-07-02",
      from: "2026-07-01",
      includeDiagnostics: true,
      requestId: "req-1",
      to: "2026-07-02",
      traceId: "trace-1"
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/fleet-ops/vehicles/vehicle%2Fwith%20space/snapshot?asOf=2026-07-02&from=2026-07-01&to=2026-07-02&traceId=trace-1&requestId=req-1&includeDiagnostics=true"
    );
    expect(result.requestId).toBe("req-1");
    expect(result.traceId).toBe("trace-1");
    expect(result.warnings).toEqual(["CURRENT_STATUS_PROJECTED_ACROSS_RANGE"]);
  });

  it("rejects date ranges longer than 366 days before calling business endpoints", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getFleetOpsSnapshot("vehicle-1", {
        from: "2026-01-01",
        to: "2027-01-03"
      })
    ).rejects.toThrow("Fleet Ops date range must not exceed 366 days.");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps all business helpers GET-only", async () => {
    const fetchMock = mockJsonResponse({
      data: { computedState: "AVAILABLE" },
      generatedAt: "2026-07-02T00:00:00.000Z"
    });

    await getFleetOpsState("vehicle-1", { asOf: "2026-07-02" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/fleet-ops/vehicles/vehicle-1/state?asOf=2026-07-02"
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("method");
  });

  it("calls the vehicle lookup endpoint with encoded GET-only query parameters", async () => {
    const fetchMock = mockJsonResponse({
      data: {
        items: [{ vehicleId, vehicleNo: "VEH-DEMO-001", vinSuffix: "000001" }],
        limit: 10,
        query: "TEST VIN"
      },
      generatedAt: "2026-07-05T00:00:00.000Z"
    });

    const result = await getFleetOpsVehicleLookup({ limit: 10, q: "TEST VIN" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/fleet-ops/vehicles/lookup?q=TEST+VIN&limit=10"
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("method");
    expect(result.data.items[0]).toEqual(expect.objectContaining({ vehicleId, vinSuffix: "000001" }));
  });

  it("recognizes permission-denied API errors without exposing stack traces", () => {
    const error = new ApiError("Forbidden", 403);

    expect(isFleetOpsPermissionDenied(error)).toBe(true);
    expect(String(error.stack ?? "")).not.toContain("FleetOpsController");
  });
});

function mockJsonResponse(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
