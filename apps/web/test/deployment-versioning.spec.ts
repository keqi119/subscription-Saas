import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");

describe("Web deployment versioning", () => {
  it("uses the image tag as the required Next.js deployment ID", () => {
    const workflow = read(".github/workflows/docker-images.yml");
    const dockerfile = read("Dockerfile.web");
    const nextConfig = read("apps/web/next.config.ts");

    expect(workflow).toContain("NEXT_DEPLOYMENT_ID=${{ inputs.imageTag }}");
    expect(dockerfile).toContain("ARG NEXT_DEPLOYMENT_ID=");
    expect(dockerfile).toContain("ENV NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}");
    expect(dockerfile).toContain('RUN test -n "$NEXT_DEPLOYMENT_ID"');
    expect(nextConfig).toContain("deploymentId: process.env.NEXT_DEPLOYMENT_ID");
  });

  it("renders authenticated handover route shells dynamically", () => {
    const layouts = [
      "apps/web/src/app/field/handover/layout.tsx",
      "apps/web/src/app/portal/handover-reviews/layout.tsx"
    ];

    for (const layout of layouts) {
      const absolutePath = join(repoRoot, layout);
      expect(existsSync(absolutePath), `${layout} must exist`).toBe(true);
      if (!existsSync(absolutePath)) {
        return;
      }

      const source = read(layout);
      expect(source).toContain('export const dynamic = "force-dynamic";');
      expect(source).toContain("children: React.ReactNode");
      expect(source).toContain("return children;");
    }
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
