import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../../..");

describe("fleet ops pool overview source structure", () => {
  it("adds the overview, pools, and pool detail routes", () => {
    expect(exists("apps/web/src/app/fleet-ops/overview/page.tsx")).toBe(true);
    expect(exists("apps/web/src/app/fleet-ops/pools/page.tsx")).toBe(true);
    expect(exists("apps/web/src/app/fleet-ops/pools/[poolId]/page.tsx")).toBe(true);
  });

  it("renders required Chinese product copy and passive drilldown wording", () => {
    const overview = read("apps/web/src/app/fleet-ops/overview/page.tsx");
    const poolOverview = read("apps/web/src/components/fleet-ops/fleet-ops-pool-overview.tsx");
    const scopeSelector = read("apps/web/src/components/fleet-ops/fleet-ops-scope-selector.tsx");
    const anomalyTable = read("apps/web/src/components/fleet-ops/fleet-ops-anomaly-table.tsx");
    const viewModel = read("apps/web/src/lib/fleet-ops-view-model.ts");

    expect(`${overview}\n${poolOverview}`).toContain("车队运营总览");
    expect(`${overview}\n${poolOverview}`).toContain("基于车辆池或动态分群查看经营、风险、现金流与数据质量。");
    expect(scopeSelector).toContain("车辆分群");
    expect(`${poolOverview}\n${viewModel}`).toContain("押金已单列，不计入经营收入");
    expect(anomalyTable).toContain("查看单车快照");
  });

  it("uses P2-H2 GET-only helper names from the new UI", () => {
    const overview = read("apps/web/src/components/fleet-ops/fleet-ops-pool-overview.tsx");
    const pools = read("apps/web/src/components/fleet-ops/fleet-ops-pool-list.tsx");

    expect(overview).toContain("getFleetOpsOverview");
    expect(overview).toContain("getFleetOpsOverviewVehicles");
    expect(pools).toContain("getFleetOpsPools");
    expect(pools).not.toMatch(/method\s*:\s*["'](?:POST|PATCH|PUT|DELETE)["']/);
  });
});

function exists(file: string) {
  return existsSync(join(repoRoot, file));
}

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
