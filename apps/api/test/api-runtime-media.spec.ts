import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "..", "..");

function runtimeStage(dockerfile: string) {
  const marker = /^FROM\s+node:22-bookworm-slim@sha256:[0-9a-f]{64}\s+AS\s+runtime\s*$/m.exec(
    dockerfile
  );
  expect(marker).not.toBeNull();
  return dockerfile.slice(marker!.index);
}

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
      /apt-get\s+-o\s+Acquire::Retries=3\s+-o\s+Binary::apt::APT::Keep-Downloaded-Packages=true\s+install\s+-y/
    );
  });

  it("keeps Prisma Client but excludes governance tooling from the API runtime", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile.api"), "utf8");
    const runtime = runtimeStage(dockerfile);
    expect(runtime).not.toMatch(/COPY[^\n]*(?:\/app\/)?scripts(?:\/|\s)/);
    expect(runtime).not.toMatch(
      /COPY[^\n]*(?:\/(?:\.superpowers|tests?|reports?|tmp|output|credentials?)(?:\/|\s)|\/\.env(?:[./\s]))/i
    );
    expect(runtime).toContain("COPY --from=production-deps /prod/api/node_modules");
    expect(runtime).toContain("test ! -e /app/apps/api/node_modules/.bin/prisma");
    expect(runtime).toContain("test ! -e /app/scripts");
    expect(runtime).toContain("! command -v psql");
    expect(runtime).toContain("require('/app/apps/api/node_modules/@prisma/client')");
  });

  it("requires and publishes an immutable API source revision label", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile.api"), "utf8");
    const runtime = runtimeStage(dockerfile);

    expect(runtime).toMatch(/ARG\s+API_SOURCE_REVISION/);
    expect(runtime).toContain('RUN test "${#API_SOURCE_REVISION}" -eq 40');
    expect(runtime).toContain('LABEL org.opencontainers.image.revision="${API_SOURCE_REVISION}"');
  });
});
