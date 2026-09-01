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

  it.each([
    ["a bare query delimiter", "https://staging-api.subauto.keybox.cloud/api?"],
    ["a bare fragment delimiter", "https://staging-api.subauto.keybox.cloud/api#"]
  ])("rejects %s after the /api path", (_case, apiBaseUrl) => {
    const result = validate({
      API_BASE_URL: apiBaseUrl,
      DEPLOYMENT_ENVIRONMENT: "staging",
      IMAGE_TAG: "Staging-20260901-test"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apiBaseUrl must end with exactly /api");
  });

  it("rejects surrounding whitespace in the API base URL", () => {
    const result = validate({
      API_BASE_URL: " https://staging-api.subauto.keybox.cloud/api ",
      DEPLOYMENT_ENVIRONMENT: "staging",
      IMAGE_TAG: "Staging-20260901-test"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apiBaseUrl must not include leading or trailing whitespace");
  });

  it("preserves the production guard against a staging API URL", () => {
    const result = validate({
      API_BASE_URL: "https://staging-api.subauto.keybox.cloud/api",
      DEPLOYMENT_ENVIRONMENT: "production",
      IMAGE_TAG: "Production-20260901-test"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Production build cannot use staging API base URL");
  });

  it.each([
    ["an HTTP URL", "http://staging-api.subauto.keybox.cloud/api"],
    ["a trailing slash", "https://staging-api.subauto.keybox.cloud/api/"],
    ["credentials", "https://user:password@staging-api.subauto.keybox.cloud/api"],
    ["a custom port", "https://staging-api.subauto.keybox.cloud:8443/api"],
    ["query parameters", "https://staging-api.subauto.keybox.cloud/api?mode=test"],
    ["a fragment", "https://staging-api.subauto.keybox.cloud/api#test"]
  ])("rejects %s in the API base URL", (_case, apiBaseUrl) => {
    const result = validate({
      API_BASE_URL: apiBaseUrl,
      DEPLOYMENT_ENVIRONMENT: "staging",
      IMAGE_TAG: "Staging-20260901-test"
    });

    expect(result.status).toBe(1);
  });
});

function validate(env: Record<string, string>) {
  return spawnSync(process.execPath, [validator], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}
