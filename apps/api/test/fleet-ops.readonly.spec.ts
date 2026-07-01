import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FLEET_OPS_FORBIDDEN_WRITE_PATTERNS } from "../src/fleet-ops/fleet-ops.contracts";

describe("Fleet Ops read-only safety", () => {
  it("keeps Fleet Ops integration and intelligence modules free of forbidden database write patterns", async () => {
    const files = await listTypescriptFiles(join(process.cwd(), "src", "fleet-ops"));
    const violations: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");

      for (const pattern of FLEET_OPS_FORBIDDEN_WRITE_PATTERNS) {
        if (pattern.expression.test(content)) {
          violations.push(`${file}:${pattern.label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

async function listTypescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);

      if (entry.isDirectory()) {
        return listTypescriptFiles(fullPath);
      }

      return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
    })
  );

  return nested.flat().sort();
}
