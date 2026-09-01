import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const validator = join(repoRoot, "scripts", "validate-image-build-inputs.mjs");

describe("Docker image build input validation", () => {
  it("rejects a staging API base URL that omits the /api path", () => {
    const result = validate({
      API_BASE_URL: "https://staging-api.subauto.keybox.cloud",
      DEPLOYMENT_ENVIRONMENT: "staging",
      IMAGE_TAG: "Staging-20260901-test"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apiBaseUrl must end with exactly /api");
  });

  it("accepts the canonical staging API base URL", () => {
    const result = validate({
      API_BASE_URL: "https://staging-api.subauto.keybox.cloud/api",
      DEPLOYMENT_ENVIRONMENT: "staging",
      IMAGE_TAG: "Staging-20260901-test"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Image build inputs are valid.");
  });
});

function validate(env: Record<string, string>) {
  return spawnSync(process.execPath, [validator], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}
