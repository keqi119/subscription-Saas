import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "..", "..");

describe("Fleet Ops no-schema safety", () => {
  it("does not place Prisma schema or migrations under Fleet Ops source", async () => {
    const files = await listEntries(join(process.cwd(), "src", "fleet-ops"));

    expect(files.filter((file) => file.endsWith("schema.prisma"))).toEqual([]);
    expect(files.filter((file) => /(^|\/)migrations(\/|$)/.test(file.replaceAll("\\", "/")))).toEqual([]);
  });

  it("does not modify Prisma schema or migrations in this task diff", () => {
    expect(gitDiff(["apps/api/prisma/schema.prisma"])).toBe("");
    expect(gitDiff(["apps/api/prisma/migrations"])).toBe("");
  });
});

function gitDiff(paths: string[]) {
  return execFileSync("git", ["diff", "--", ...paths], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

async function listEntries(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);

      if (entry.isDirectory()) {
        return [fullPath, ...(await listEntries(fullPath))];
      }

      return [fullPath];
    })
  );

  return nested.flat().sort();
}
