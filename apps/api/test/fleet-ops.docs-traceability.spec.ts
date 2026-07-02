import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "..", "..");
const sourceOfTruthDocs = [
  "docs/fleet-ops/source/plan_design.md",
  "docs/fleet-ops/source/code_review_202607011626.md",
  "docs/fleet-ops/next-stage/dev_spec.md",
  "docs/fleet-ops/next-stage/agents.md",
  "docs/fleet-ops/next-stage/codex_tasks.md",
  "docs/fleet-ops/README.md"
];

describe("Fleet Ops docs traceability", () => {
  it("keeps every source-of-truth planning document available in this branch", async () => {
    await expect(Promise.all(sourceOfTruthDocs.map((docPath) => readFile(join(repoRoot, docPath), "utf8")))).resolves.toHaveLength(
      sourceOfTruthDocs.length
    );
  });

  it("references source-of-truth docs from runtime docs and release checklist", async () => {
    const readme = await readFile(join(process.cwd(), "src", "fleet-ops", "fleet-ops.readme.md"), "utf8");
    const releaseChecklist = await readFile(join(process.cwd(), "src", "fleet-ops", "fleet-ops.release-checklist.md"), "utf8");

    for (const docPath of sourceOfTruthDocs) {
      expect(readme, `${docPath} missing from Fleet Ops README`).toContain(docPath);
    }

    expect(releaseChecklist).toContain("Docs traceability");
    for (const docPath of sourceOfTruthDocs) {
      expect(releaseChecklist, `${docPath} missing from release checklist`).toContain(docPath);
    }
  });
});
