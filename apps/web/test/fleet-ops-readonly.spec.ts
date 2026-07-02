import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

const approvedChangedFiles = new Set([
  "apps/web/src/lib/fleet-ops-api.ts",
  "apps/web/src/lib/fleet-ops-view-model.ts",
  "apps/web/src/app/fleet-ops/page.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-overview.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-state-card.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-timeline-card.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-economics-card.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-risk-card.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-evidence-panel.tsx",
  "apps/web/test/fleet-ops-api.spec.ts",
  "apps/web/test/fleet-ops-view-model.spec.ts",
  "apps/web/test/fleet-ops-readonly.spec.ts",
  "apps/api/src/fleet-ops/fleet-ops.release-checklist.md",
  "docs/fleet-ops/next-stage/codex_tasks.md",
  "docs/permission-matrix.md"
]);

const fleetOpsUiFiles = [
  "apps/web/src/lib/fleet-ops-api.ts",
  "apps/web/src/lib/fleet-ops-view-model.ts",
  "apps/web/src/app/fleet-ops/page.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-overview.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-state-card.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-timeline-card.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-economics-card.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-risk-card.tsx",
  "apps/web/src/components/fleet-ops/fleet-ops-evidence-panel.tsx"
];

describe("fleet ops admin ui readonly boundary", () => {
  it("keeps current P1-H9 changes inside the approved file list", () => {
    const changedFiles = changedOrUntrackedFiles();

    for (const file of changedFiles) {
      expect(approvedChangedFiles.has(file), `${file} is outside the approved P1-H9 file list`).toBe(true);
    }
  });

  it("does not define mutation HTTP methods in the Fleet Ops UI client or page surface", () => {
    for (const file of fleetOpsUiFiles) {
      const source = readApprovedFile(file);

      expect(source).not.toMatch(/\bmethod\s*:\s*["'](?:POST|PATCH|PUT|DELETE)["']/);
      expect(source).not.toMatch(/\b(?:post|patch|put|delete)FleetOps[A-Za-z0-9_]*/);
      expect(source).not.toMatch(/\/fleet-ops\/[^"']*(?:execute|allocate|activate|collection-action)/i);
    }
  });

  it("does not render execution or mutation action labels", () => {
    const forbiddenLabels = [
      /execute action/i,
      /allocate vehicle/i,
      /activate lease/i,
      /collect action/i,
      /trigger maintenance/i,
      /recover vehicle/i,
      /restrict vehicle/i
    ];

    for (const file of fleetOpsUiFiles) {
      const source = readApprovedFile(file);

      for (const pattern of forbiddenLabels) {
        expect(source, `${file} contains forbidden read-write label ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("does not add Fleet Ops customer portal routes", () => {
    expect(gitDiffNames(["apps/web/src/app/portal"])).toEqual([]);
  });

  it("does not change shared menu seed or backend Fleet Ops runtime files", () => {
    expect(
      gitDiffNames([
        "packages/shared/src/auth.ts",
        "packages/shared/src/menus.ts",
        "apps/api/prisma/seed.mjs",
        "apps/api/src/fleet-ops"
      ]).filter((file) => file !== "apps/api/src/fleet-ops/fleet-ops.release-checklist.md")
    ).toEqual([]);
  });
});

function readApprovedFile(file: string) {
  const path = join(repoRoot, file);
  expect(existsSync(path), `${file} should exist`).toBe(true);
  return readFileSync(path, "utf8");
}

function changedOrUntrackedFiles() {
  const output = execFileSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeGitStatusPath(line.slice(2).trim()))
    .filter((file) => file.length > 0);
}

function gitDiffNames(paths: string[]) {
  const output = execFileSync("git", ["diff", "--name-only", "--", ...paths], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  return output
    .split(/\r?\n/)
    .map((line) => normalizeGitStatusPath(line.trim()))
    .filter(Boolean);
}

function normalizeGitStatusPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.includes(" -> ")) {
    return normalized;
  }

  return normalized.split(" -> ").at(-1) ?? normalized;
}
