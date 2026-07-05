import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { FleetOpsFacade } from "../src/fleet-ops/fleet-ops.facade";

describe("Fleet Ops dependency boundaries", () => {
  it("keeps lower layers from importing aggregate facade contracts", async () => {
    const imports = await findImports(/fleet-ops\.contracts/);
    const lowerLayerImports = imports.filter(({ file }) => isLowerLayerFile(file));

    expect(lowerLayerImports).toEqual([]);
  });

  it("keeps PR-6 optimization from importing PR-5 execution services or handlers", async () => {
    const files = await listFiles(join(process.cwd(), "src", "fleet-ops", "optimization"));
    const violations = await grepFiles(files, /action-orchestrator\.service|fleet-execution\.service|action\.handlers/);

    expect(violations).toEqual([]);
  });

  it("keeps PR-8 coordination from executing actions", async () => {
    const files = await listFiles(join(process.cwd(), "src", "fleet-ops", "coordination"));
    const violations = await grepFiles(files, /ActionOrchestratorService|FleetExecutionService|executeAction\s*\(/);

    expect(violations).toEqual([]);
  });

  it("does not expose execution through FleetOpsFacade", () => {
    expect(Object.getOwnPropertyNames(FleetOpsFacade.prototype)).not.toContain("executeAction");
  });

  it("keeps health and diagnostics away from execution handlers", async () => {
    const files = [
      join(process.cwd(), "src", "fleet-ops", "fleet-ops.health.service.ts"),
      join(process.cwd(), "src", "fleet-ops", "fleet-ops.diagnostics.ts"),
      join(process.cwd(), "src", "fleet-ops", "fleet-ops.observability.ts")
    ];
    const violations = await grepFiles(files, /action\.handlers|ActionOrchestratorService|FleetExecutionService/);

    expect(violations).toEqual([]);
  });

  it("exposes only the controlled read-only Fleet Ops controller and keeps AppModule registration unchanged", async () => {
    const sourceFiles = await listFiles(join(process.cwd(), "src", "fleet-ops"));
    const controllerFiles = sourceFiles.filter((file) => /controller\.ts$/.test(file));
    const controllerSource = await readFile(join(process.cwd(), "src", "fleet-ops", "fleet-ops.controller.ts"), "utf8");
    const appModule = await readFile(join(process.cwd(), "src", "app.module.ts"), "utf8");

    expect(controllerFiles.map((file) => relative(process.cwd(), file).replaceAll("\\", "/"))).toEqual([
      "src/fleet-ops/fleet-ops.controller.ts"
    ]);
    expect(controllerSource).toContain("@Controller(\"fleet-ops\")");
    expect(controllerSource).not.toMatch(/@(Post|Patch|Put|Delete)\s*\(/);
    expect(controllerSource).not.toMatch(/executeAction|FleetExecutionService|ActionOrchestratorService|action\.handlers/);
    expect(appModule.match(/FleetOpsModule/g)).toHaveLength(2);
  });

  it("keeps vehicle lookup as a narrow identity read helper without execution exposure", async () => {
    const lookupSource = await readFile(join(process.cwd(), "src", "fleet-ops", "fleet-ops.vehicle-lookup.service.ts"), "utf8");
    const controllerSource = await readFile(join(process.cwd(), "src", "fleet-ops", "fleet-ops.controller.ts"), "utf8");

    expect(lookupSource).toContain("PrismaService");
    expect(lookupSource).toMatch(/\.findMany\s*\(/);
    expect(lookupSource).not.toMatch(
      /\.create\s*\(|\.update\s*\(|\.delete\s*\(|\.upsert\s*\(|\.createMany\s*\(|\.updateMany\s*\(|\.deleteMany\s*\(|\$executeRaw|\$queryRawUnsafe|\$transaction/
    );
    expect(lookupSource).not.toMatch(/ActionOrchestratorService|FleetExecutionService|executeAction|action\.handlers/);
    expect(controllerSource).toContain("FleetOpsVehicleLookupService");
    expect(controllerSource).not.toMatch(/constructor\([\s\S]*PrismaService/);
  });

  it("keeps pool overview Prisma access limited to scope resolution and existing Fleet Ops services", async () => {
    const scopeResolverSource = await readFile(join(process.cwd(), "src", "fleet-ops", "fleet-ops.scope-resolver.service.ts"), "utf8");
    const aggregatorSource = await readFile(join(process.cwd(), "src", "fleet-ops", "fleet-ops.pool-aggregator.service.ts"), "utf8");
    const overviewSource = await readFile(join(process.cwd(), "src", "fleet-ops", "fleet-ops.overview.service.ts"), "utf8");
    const controllerSource = await readFile(join(process.cwd(), "src", "fleet-ops", "fleet-ops.controller.ts"), "utf8");

    expect(scopeResolverSource).toContain("PrismaService");
    expect(scopeResolverSource).toMatch(/\.findMany\s*\(/);
    expect(aggregatorSource).not.toContain("PrismaService");
    expect(aggregatorSource).toContain("FleetKpiService");
    expect(aggregatorSource).toContain("FleetRiskService");
    expect(overviewSource).not.toContain("PrismaService");
    expect(controllerSource).not.toMatch(/constructor\([\s\S]*PrismaService/);
    expect(`${scopeResolverSource}\n${aggregatorSource}\n${overviewSource}`).not.toMatch(
      /\.create\s*\(|\.update\s*\(|\.delete\s*\(|\.upsert\s*\(|\.createMany\s*\(|\.updateMany\s*\(|\.deleteMany\s*\(|\$executeRaw|\$queryRawUnsafe|\$transaction/
    );
  });
});

async function findImports(pattern: RegExp) {
  const files = await listFiles(join(process.cwd(), "src", "fleet-ops"));
  const matches: Array<{ file: string; line: number; text: string }> = [];

  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((lineText, index) => {
      if (/^\s*import\b/.test(lineText) && pattern.test(lineText)) {
        matches.push({ file: relative(process.cwd(), file).replaceAll("\\", "/"), line: index + 1, text: lineText.trim() });
      }
    });
  }

  return matches;
}

function isLowerLayerFile(file: string) {
  return (
    /src\/fleet-ops\/(timeline|economics|risk|execution|optimization|governance|coordination)\//.test(file) ||
    /src\/fleet-ops\/vehicle-operational-state\.(confidence|repository|resolver|rules|service|types)\.ts$/.test(file)
  );
}

async function grepFiles(files: string[], pattern: RegExp) {
  const matches: Array<{ file: string; line: number; text: string }> = [];

  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((lineText, index) => {
      if (pattern.test(lineText)) {
        matches.push({ file: relative(process.cwd(), file).replaceAll("\\", "/"), line: index + 1, text: lineText.trim() });
      }
    });
  }

  return matches;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);

      if (entry.isDirectory()) {
        return listFiles(fullPath);
      }

      return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
    })
  );

  return nested.flat().sort();
}
