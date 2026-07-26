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
    expect(dockerfile).toMatch(
      /apt-get\s+-o\s+Acquire::Retries=3\s+install\s+-y/
    );
  });
});
