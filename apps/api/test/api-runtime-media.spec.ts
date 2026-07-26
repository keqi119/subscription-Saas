import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "..", "..");

describe("API runtime media contract", () => {
  it("packages ffmpeg and ffprobe in the API runtime image", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile.api"), "utf8");

    expect(dockerfile).toMatch(/apt-get install[^\n]*ffmpeg/);
    expect(dockerfile).toContain("command -v ffmpeg");
    expect(dockerfile).toContain("command -v ffprobe");
  });
});
