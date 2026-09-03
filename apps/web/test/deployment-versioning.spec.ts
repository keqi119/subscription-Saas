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

  it("only forbids the staging API host in production image checks", () => {
    const workflow = read(".github/workflows/docker-images.yml");
    const checkStep = workflow.slice(
      workflow.indexOf("- name: Check the Web image API base by immutable digest")
    );

    expect(checkStep).toContain("DEPLOYMENT_ENVIRONMENT: ${{ inputs.environment }}");
    expect(checkStep).toContain("check_args=(");
    expect(checkStep).toContain('if [ "$DEPLOYMENT_ENVIRONMENT" = "production" ]; then');
    expect(checkStep).toContain(
      'check_args+=(--must-not-contain "staging-api.subauto.keybox.cloud")'
    );
    expect(checkStep).toContain('"${check_args[@]}"');
  });

  it("builds and verifies the API image revision label against the frozen source SHA", () => {
    const workflow = read(".github/workflows/docker-images.yml");
    const apiBuild = workflow.slice(
      workflow.indexOf("- name: Build and push attested API image"),
      workflow.indexOf("- name: Build and push attested Web image")
    );
    const verification = workflow.slice(
      workflow.indexOf("- name: Resolve registry subjects and attestation manifests")
    );

    expect(apiBuild).toContain("API_SOURCE_REVISION=${{ needs.prepare.outputs.source-sha }}");
    expect(apiBuild).toContain(
      "labels: org.opencontainers.image.revision=${{ needs.prepare.outputs.source-sha }}"
    );
    expect(verification).toContain(
      'await run("docker", ["pull", "--platform", "linux/amd64", subject]'
    );
    expect(verification).toContain("org.opencontainers.image.revision");
    expect(verification).toContain("sourceRevision,");
    expect(verification).toContain("sourceSha: process.env.SOURCE_SHA");
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
