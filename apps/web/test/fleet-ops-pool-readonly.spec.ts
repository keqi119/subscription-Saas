import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const fleetOpsPoolSourceRoots = [
  "apps/web/src/app/fleet-ops/overview",
  "apps/web/src/app/fleet-ops/pools",
  "apps/web/src/components/fleet-ops",
  "apps/web/src/lib/fleet-ops-api.ts",
  "apps/web/src/lib/fleet-ops-view-model.ts"
];

const forbiddenCopy = [
  "保存视图",
  "批量操作",
  "执行动作",
  "催收动作",
  "分配车辆",
  "激活租赁",
  "触发维修",
  "限制车辆"
];

describe("fleet ops pool UI readonly boundary", () => {
  it("keeps new Fleet Ops pool frontend calls GET-only", () => {
    for (const file of poolSourceFiles()) {
      const source = read(file);

      expect(source, `${file} must not set mutation methods`).not.toMatch(
        /\bmethod\s*:\s*["'](?:POST|PATCH|PUT|DELETE)["']/
      );
      expect(source, `${file} must not define mutation helpers`).not.toMatch(
        /\b(?:post|patch|put|delete)FleetOps[A-Za-z0-9_]*/
      );
    }
  });

  it("does not render saved-view, batch, execution, or collection controls", () => {
    for (const file of poolSourceFiles().filter((item) => item.endsWith(".tsx"))) {
      const source = read(file);

      for (const copy of forbiddenCopy) {
        expect(source, `${file} must not render ${copy}`).not.toContain(copy);
      }
      expect(source, `${file} must not expose execution endpoints`).not.toMatch(
        /executeAction|\/execute\b|\/allocate\b|\/activate-lease\b|\/collection-action\b|guarded-actions/
      );
    }
  });

  it("does not add saved view helpers or customer/public Fleet Ops exposure", () => {
    for (const file of poolSourceFiles()) {
      const source = read(file);

      expect(source, `${file} must not mention saved view persistence`).not.toMatch(/SavedCustomView|savedView|customView/i);
      expect(source, `${file} must not expose customer/public Fleet Ops links`).not.toMatch(/\/(?:customer|portal|public)\/fleet-ops/i);
    }
  });
});

function poolSourceFiles() {
  return fleetOpsPoolSourceRoots
    .flatMap((root) => collectSourceFiles(root))
    .filter((file, index, files) => files.indexOf(file) === index)
    .sort();
}

function collectSourceFiles(root: string): string[] {
  const absoluteRoot = join(repoRoot, root);
  if (!existsSync(absoluteRoot)) {
    return [];
  }

  const stat = statSync(absoluteRoot);
  if (stat.isFile()) {
    return [".ts", ".tsx"].includes(extname(absoluteRoot)) ? [toRepoPath(absoluteRoot)] : [];
  }

  return readdirSync(absoluteRoot).flatMap((entry) => collectSourceFiles(toRepoPath(join(absoluteRoot, entry))));
}

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}

function toRepoPath(path: string) {
  return path.replace(repoRoot, "").replace(/^[/\\]/, "").replace(/\\/g, "/");
}
