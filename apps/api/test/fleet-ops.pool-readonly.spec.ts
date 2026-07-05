import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import {
  FLEET_OPS_FORBIDDEN_WRITE_PATTERNS,
  classifyFleetOpsStaticScanHit,
  type FleetOpsStaticScanFinding
} from "../src/fleet-ops/fleet-ops.shared-contracts";
import { FleetOpsController } from "../src/fleet-ops/fleet-ops.controller";

const newSourceFiles = [
  "src/fleet-ops/fleet-ops.scope-resolver.service.ts",
  "src/fleet-ops/fleet-ops.pool-aggregator.service.ts",
  "src/fleet-ops/fleet-ops.overview.service.ts",
  "src/fleet-ops/fleet-ops.pool-read-model.ts",
  "src/fleet-ops/dto/fleet-ops-overview-query.dto.ts",
  "src/fleet-ops/dto/fleet-ops-pool-query.dto.ts"
];

describe("Fleet Ops pool overview read-only boundary", () => {
  it("keeps new pool overview routes GET-only", () => {
    const prototype = FleetOpsController.prototype;
    const routes = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== "constructor")
      .map((name) => ({
        method: Reflect.getMetadata(METHOD_METADATA, prototype[name as keyof FleetOpsController]),
        path: Reflect.getMetadata(PATH_METADATA, prototype[name as keyof FleetOpsController])
      }))
      .filter((route) => route.path !== undefined);

    expect(routes).toEqual(
      expect.arrayContaining([
        { method: RequestMethod.GET, path: "overview" },
        { method: RequestMethod.GET, path: "overview/vehicles" },
        { method: RequestMethod.GET, path: "pools" },
        { method: RequestMethod.GET, path: "pools/:poolId" }
      ])
    );
    expect(routes.filter((route) => route.path?.toString().startsWith("overview") || route.path?.toString().startsWith("pools")).every((route) => route.method === RequestMethod.GET)).toBe(true);
  });

  it("keeps new pool overview source free of write paths, execution calls, and saved-view persistence", async () => {
    const findings: FleetOpsStaticScanFinding[] = [];

    for (const file of newSourceFiles) {
      const fullPath = join(process.cwd(), file);
      const lines = (await readFile(fullPath, "utf8")).split(/\r?\n/);

      for (const [index, lineText] of lines.entries()) {
        for (const pattern of FLEET_OPS_FORBIDDEN_WRITE_PATTERNS) {
          if (pattern.expression.test(lineText)) {
            findings.push(
              classifyFleetOpsStaticScanHit({
                context: lineText.trim(),
                file: relative(process.cwd(), fullPath).replaceAll("\\", "/"),
                line: index + 1,
                pattern
              })
            );
          }
        }
      }

      const source = lines.join("\n");
      expect(source).not.toMatch(/ActionOrchestratorService|FleetExecutionService|executeAction|action\.handlers/);
      expect(source).not.toMatch(/SavedCustomView|customView|savedView|customerId|Customer/);
    }

    expect(findings.filter((finding) => finding.classification === "unsafe")).toEqual([]);
  });
});
