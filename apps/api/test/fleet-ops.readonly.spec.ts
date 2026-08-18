import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FLEET_OPS_FORBIDDEN_WRITE_PATTERNS,
  classifyFleetOpsStaticScanHit,
  type FleetOpsStaticScanFinding
} from "../src/fleet-ops/fleet-ops.shared-contracts";

describe("Fleet Ops read-only safety", () => {
  it(
    "keeps Fleet Ops integration and intelligence modules free of unsafe write patterns",
    async () => {
      const files = await listTypescriptFiles(join(process.cwd(), "src", "fleet-ops"));
      const findings: FleetOpsStaticScanFinding[] = [];

      for (const file of files) {
        const lines = (await readFile(file, "utf8")).split(/\r?\n/);

        for (const [index, lineText] of lines.entries()) {
          for (const pattern of FLEET_OPS_FORBIDDEN_WRITE_PATTERNS) {
            if (pattern.expression.test(lineText)) {
              findings.push(
                classifyFleetOpsStaticScanHit({
                  context: lineText.trim(),
                  file,
                  line: index + 1,
                  pattern
                })
              );
            }
          }
        }
      }

      const unsafeFindings = findings.filter((finding) => finding.classification === "unsafe");
      const auditSinkFinding = findings.find(
        (finding) =>
          finding.pattern.label === "audit-sink-write" &&
          finding.file.replaceAll("\\", "/").endsWith("execution/execution-log.service.ts")
      );

      expect(unsafeFindings).toEqual([]);
      expect(auditSinkFinding).toEqual(
        expect.objectContaining({
          classification: "safe",
          reason: expect.stringContaining("explicit PR-5 execution log")
        })
      );
    },
    15_000
  );
});

async function listTypescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);

      if (entry.isDirectory()) {
        return listTypescriptFiles(fullPath);
      }

      return entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
        ? [fullPath]
        : [];
    })
  );

  return nested.flat().sort();
}
