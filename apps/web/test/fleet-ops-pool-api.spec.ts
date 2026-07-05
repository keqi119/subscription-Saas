import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getFleetOpsOverview,
  getFleetOpsOverviewVehicles,
  getFleetOpsPoolDetail,
  getFleetOpsPools
} from "../src/lib/fleet-ops-api";

const poolId = "00000000-0000-4000-8000-000000000010";

describe("fleet ops pool API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the overview endpoint with encoded GET-only query parameters", async () => {
    const fetchMock = mockJsonResponse({ data: { scope: { type: "COHORT" } }, generatedAt: "2026-07-05T00:00:00.000Z" });

    await getFleetOpsOverview({
      assetLocation: "Shanghai HQ",
      brand: "NIO",
      createdFrom: "2026-01-01",
      createdTo: "2026-12-31",
      model: "ES6",
      modelYear: 2026,
      page: 2,
      pageSize: 20,
      registrationDateFrom: "2026-01-01",
      registrationDateTo: "2026-12-31",
      requestId: "overview-1",
      scopeType: "COHORT",
      topN: 10,
      vehicleStatus: "AVAILABLE"
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/fleet-ops/overview?scopeType=COHORT&brand=NIO&model=ES6&modelYear=2026&vehicleStatus=AVAILABLE&registrationDateFrom=2026-01-01&registrationDateTo=2026-12-31&createdFrom=2026-01-01&createdTo=2026-12-31&assetLocation=Shanghai+HQ&topN=10&page=2&pageSize=20&requestId=overview-1"
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("method");
  });

  it("calls pool list and pool detail endpoints with GET-only requests", async () => {
    const fetchMock = mockJsonResponse({ data: { items: [], pagination: { page: 1, pageSize: 20, total: 0 } } });

    await getFleetOpsPools({ page: 1, pageSize: 20, poolStatus: "ACTIVE", poolType: "OPERATION" });
    await getFleetOpsPoolDetail(poolId, { scopeType: "POOL", topN: 5 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/fleet-ops/pools?page=1&pageSize=20&poolStatus=ACTIVE&poolType=OPERATION"
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://localhost:3001/api/fleet-ops/pools/${poolId}?scopeType=POOL&topN=5`
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("method");
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("method");
  });

  it("calls the scoped vehicle list endpoint without mutation or saved-view helpers", async () => {
    const fetchMock = mockJsonResponse({ data: { items: [], pagination: { page: 1, pageSize: 20, total: 0 } } });

    await getFleetOpsOverviewVehicles({ page: 1, pageSize: 20, poolId, scopeType: "POOL" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3001/api/fleet-ops/overview/vehicles?scopeType=POOL&poolId=${poolId}&page=1&pageSize=20`
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("method");
  });
});

function mockJsonResponse(body: unknown) {
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200
    }))
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
