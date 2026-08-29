import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "..", "..");

describe("API runtime media contract", () => {
  it("packages ffmpeg and ffprobe in the API runtime image", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile.api"), "utf8");

    expect(dockerfile).toMatch(/apt-get[^\n]*install[^\n]*ffmpeg/);
    expect(dockerfile).toContain("command -v ffmpeg");
    expect(dockerfile).toContain("command -v ffprobe");
  });

  it("uses finite apt retries for both repository downloads", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile.api"), "utf8");

    expect(dockerfile).toMatch(/apt-get\s+-o\s+Acquire::Retries=3\s+update/);
    expect(dockerfile).toMatch(/apt-get\s+-o\s+Acquire::Retries=3\s+install\s+-y/);
  });

  it("packages the Stage 1 contract-change release tooling", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile.api"), "utf8");

    for (const script of [
      "prisma-migration-checksums.mjs",
      "stage1-active-source-facts-repair-core.mjs",
      "stage1-active-source-facts-repair-executor.mjs",
      "stage1-active-source-facts-repair.mjs",
      "stage1-contract-change-bootstrap-core.mjs",
      "stage1-contract-change-bootstrap.mjs",
      "stage1-return-closure-backfill-core.mjs",
      "stage1-return-closure-backfill.mjs",
      "stage1-staging-invalid-test-order-retirement-core.mjs",
      "stage1-staging-invalid-test-order-retirement-executor.mjs",
      "stage1-staging-invalid-test-order-retirement.mjs",
      "stage1c-period-backfill-core.mjs",
      "stage1c-period-backfill-executor.mjs",
      "stage1c-period-backfill.mjs",
      "subscription-segment-bootstrap-core.mjs",
      "subscription-segment-bootstrap.mjs"
    ]) {
      expect(dockerfile).toContain(`COPY --from=build /app/scripts/${script} ./scripts/${script}`);
    }
  });
});
