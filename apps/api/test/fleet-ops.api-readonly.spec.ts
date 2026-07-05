import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FLEET_OPS_FORBIDDEN_WRITE_PATTERNS,
  classifyFleetOpsStaticScanHit,
  type FleetOpsStaticScanFinding
} from "../src/fleet-ops/fleet-ops.shared-contracts";

const apiFiles = [
  "src/fleet-ops/fleet-ops.controller.ts",
  "src/fleet-ops/fleet-ops.api.guard.ts",
  "src/fleet-ops/fleet-ops.api.errors.ts",
  "src/fleet-ops/fleet-ops.api.types.ts",
  "src/fleet-ops/fleet-ops.vehicle-lookup.service.ts",
  "src/fleet-ops/dto/fleet-ops-query.dto.ts",
  "src/fleet-ops/dto/fleet-ops-range-query.dto.ts",
  "src/fleet-ops/dto/fleet-ops-response.dto.ts",
  "src/fleet-ops/dto/fleet-ops-vehicle-lookup.dto.ts"
];

describe("Fleet Ops API read-only boundary", () => {
  it("keeps API files free of write patterns and mutation route decorators", async () => {
    const findings: FleetOpsStaticScanFinding[] = [];

    for (const file of apiFiles) {
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
    }

    expect(findings.filter((finding) => finding.classification === "unsafe")).toEqual([]);
    await expect(grepApiFiles(/@(Post|Patch|Put|Delete)\s*\(/)).resolves.toEqual([]);
  });

  it("keeps controller dependencies facade-only for business data", async () => {
    const controllerSource = await readFile(join(process.cwd(), "src", "fleet-ops", "fleet-ops.controller.ts"), "utf8");

    expect(controllerSource).toContain("FleetOpsFacade");
    expect(controllerSource).toContain("FleetOpsHealthService");
    expect(controllerSource).toContain("FleetOpsVehicleLookupService");
    expect(controllerSource).not.toMatch(
      /VehicleOperationalStateService|VehicleTimelineService|FleetKpiService|FleetRiskService|FleetExecutionService|ActionOrchestratorService|PrismaService|FinanceService|PaymentService|ReportService|OrderService/
    );
    expect(controllerSource).not.toMatch(/executeAction|action\.handlers|FleetExecutionService/);
  });
});

async function grepApiFiles(pattern: RegExp) {
  const matches: Array<{ file: string; line: number; text: string }> = [];

  for (const file of apiFiles) {
    const fullPath = join(process.cwd(), file);
    const lines = (await readFile(fullPath, "utf8")).split(/\r?\n/);

    lines.forEach((lineText, index) => {
      if (pattern.test(lineText)) {
        matches.push({
          file,
          line: index + 1,
          text: lineText.trim()
        });
      }
    });
  }

  return matches;
}
