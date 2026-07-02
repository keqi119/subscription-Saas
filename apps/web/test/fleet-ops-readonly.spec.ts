import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

const fleetOpsClientFiles = [
  "apps/web/src/lib/fleet-ops-api.ts",
  "apps/web/src/lib/fleet-ops-view-model.ts"
];

const fleetOpsRecursiveSourceRoots = [
  "apps/web/src/app/fleet-ops",
  "apps/web/src/components/fleet-ops"
];

const publicRouteRoots = [
  "apps/web/src/app/customer",
  "apps/web/src/app/portal",
  "apps/web/src/app/public"
];

const sharedProvisioningFiles = [
  "packages/shared/src/auth.ts",
  "packages/shared/src/menus.ts",
  "apps/api/prisma/seed.mjs",
  "apps/api/prisma/sync-fleet-ops-access.mjs"
];

const forbiddenFleetOpsPermissions = [
  "fleet_ops:write",
  "fleet_ops:execute",
  "fleet_ops:admin",
  "fleet_ops:action",
  "fleet_ops:allocate",
  "fleet_ops:collect"
];

const forbiddenFleetOpsMenuStrings = [
  "fleet_ops.execute",
  "fleet_ops.action",
  "fleet_ops.allocate",
  "fleet_ops.collect",
  "vehicles.fleet_ops.execute",
  "vehicles.fleet_ops.action",
  "vehicles.fleet_ops.allocate",
  "vehicles.fleet_ops.collect"
];

describe("fleet ops admin ui readonly boundary", () => {
  it("discovers Fleet Ops UI and client sources without relying on the current git diff", () => {
    const files = fleetOpsSourceFiles();

    expect(files).toContain("apps/web/src/lib/fleet-ops-api.ts");
    expect(files).toContain("apps/web/src/lib/fleet-ops-view-model.ts");
    expect(files).toContain("apps/web/src/app/fleet-ops/page.tsx");
    expect(files).toContain("apps/web/src/components/fleet-ops/fleet-ops-overview.tsx");
  });

  it("keeps the Fleet Ops frontend API client GET-only", () => {
    for (const file of fleetOpsSourceFiles()) {
      const source = readRequiredFile(file);

      expect(source, `${file} must not set a mutation HTTP method`).not.toMatch(
        /\bmethod\s*:\s*["'](?:POST|PATCH|PUT|DELETE)["']/
      );
      expect(source, `${file} must not define mutation Fleet Ops helpers`).not.toMatch(
        /\b(?:post|patch|put|delete)FleetOps[A-Za-z0-9_]*/
      );
    }
  });

  it("does not reference Fleet Ops execution endpoints from frontend source", () => {
    const forbiddenEndpointPatterns = [
      /executeAction/,
      /\/execute\b/,
      /\/allocate\b/,
      /\/activate-lease\b/,
      /\/collection-action\b/,
      /guarded-actions/
    ];

    for (const file of fleetOpsSourceFiles()) {
      const source = readRequiredFile(file);

      for (const pattern of forbiddenEndpointPatterns) {
        expect(source, `${file} contains forbidden endpoint pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("does not render actionable execution or mutation controls", () => {
    const forbiddenControlPatterns = [
      />\s*(?:执行(?:操作|动作)?|分配(?:车辆)?|激活(?:租约)?|催收动作|回收(?:车辆)?|触发(?:维护)?)\s*</,
      /(?:aria-label|title|label|message)\s*=\s*["']\s*(?:执行(?:操作|动作)?|分配(?:车辆)?|激活(?:租约)?|催收动作|回收(?:车辆)?|触发(?:维护)?)\s*["']/,
      />\s*(?:Execute(?: Action)?|Allocate(?: Vehicle)?|Activate(?: Lease)?|Collect Action)\s*</i,
      /(?:aria-label|title|label|message)\s*=\s*["']\s*(?:Execute(?: Action)?|Allocate(?: Vehicle)?|Activate(?: Lease)?|Collect Action)\s*["']/i
    ];

    for (const file of fleetOpsTsxSourceFiles()) {
      const source = readRequiredFile(file);

      for (const pattern of forbiddenControlPatterns) {
        expect(source, `${file} contains forbidden actionable control ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("does not expose Fleet Ops from customer public or portal route trees", () => {
    for (const file of optionalSourceFiles(publicRouteRoots, [".ts", ".tsx"])) {
      const source = readRequiredFile(file);

      expect(source, `${file} exposes Fleet Ops from a customer/public route`).not.toMatch(
        /fleet-ops|FleetOps|getFleetOps/i
      );
    }
  });

  it("keeps shared and provisioning sources free of forbidden Fleet Ops permissions", () => {
    for (const file of existingFiles(sharedProvisioningFiles)) {
      const source = readRequiredFile(file);

      for (const permission of forbiddenFleetOpsPermissions) {
        expect(source, `${file} must not define ${permission}`).not.toContain(permission);
      }
    }
  });

  it("does not add Fleet Ops execution action menu strings", () => {
    for (const file of existingFiles(sharedProvisioningFiles)) {
      const source = readRequiredFile(file);

      for (const menuString of forbiddenFleetOpsMenuStrings) {
        expect(source, `${file} must not define ${menuString}`).not.toContain(menuString);
      }
    }
  });
});

function fleetOpsSourceFiles() {
  return [
    ...fleetOpsClientFiles,
    ...optionalSourceFiles(fleetOpsRecursiveSourceRoots, [".ts", ".tsx"])
  ].filter((file, index, files) => files.indexOf(file) === index);
}

function fleetOpsTsxSourceFiles() {
  return optionalSourceFiles(fleetOpsRecursiveSourceRoots, [".tsx"]);
}

function optionalSourceFiles(roots: readonly string[], extensions: readonly string[]) {
  return roots.flatMap((root) => collectSourceFiles(root, extensions));
}

function collectSourceFiles(root: string, extensions: readonly string[]): string[] {
  const absoluteRoot = join(repoRoot, root);
  if (!existsSync(absoluteRoot)) {
    return [];
  }

  const stat = statSync(absoluteRoot);
  if (stat.isFile()) {
    return extensions.includes(extname(absoluteRoot)) ? [toRepoPath(absoluteRoot)] : [];
  }

  return readdirSync(absoluteRoot)
    .flatMap((entry) => collectSourceFiles(toRepoPath(join(absoluteRoot, entry)), extensions))
    .sort();
}

function existingFiles(files: readonly string[]) {
  return files.filter((file) => existsSync(join(repoRoot, file)));
}

function readRequiredFile(file: string) {
  const path = join(repoRoot, file);
  expect(existsSync(path), `${file} should exist`).toBe(true);
  return readFileSync(path, "utf8");
}

function toRepoPath(path: string) {
  return path
    .replace(repoRoot, "")
    .replace(/^[/\\]/, "")
    .replace(/\\/g, "/");
}
