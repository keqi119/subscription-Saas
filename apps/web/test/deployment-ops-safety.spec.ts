import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");

describe("Deployment operations safety", () => {
  it("pins staging and production Compose project names", () => {
    for (const file of [
      "docker-compose.staging.example.yml",
      "docker-compose.staging.images.example.yml"
    ]) {
      expect(read(file)).toMatch(/^name: subauto-staging$/m);
    }

    for (const file of [
      "docker-compose.prod.example.yml",
      "docker-compose.production.images.example.yml"
    ]) {
      expect(read(file)).toMatch(/^name: subauto-production$/m);
    }
  });

  it("keeps staging host ports isolated from production", () => {
    const compose = read("docker-compose.staging.images.example.yml");
    const environment = read(".env.staging.images.example");
    const nginx = read("nginx/staging-subauto.example.conf");

    expect(compose).toContain("${API_HOST_PORT:-3101}:3001");
    expect(compose).toContain("${WEB_HOST_PORT:-3100}:3000");
    expect(environment).toContain("API_HOST_PORT=3101");
    expect(environment).toContain("WEB_HOST_PORT=3100");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3100;");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3101;");
    expect(nginx).not.toContain("proxy_pass http://127.0.0.1:3001;");
  });

  it("disables inherited proxy caching for staging Web and API", () => {
    const nginx = read("nginx/staging-subauto.example.conf");
    const cacheDirectives = nginx.match(/^\s*proxy_cache off;$/gm) ?? [];

    expect(cacheDirectives).toHaveLength(2);
  });

  it("uses an explicit staging project name in image deployment commands", () => {
    const runbook = read("docs/staging-deployment-runbook.md");
    const imageCommands =
      runbook.match(
        /^docker compose .*docker-compose\.staging\.images\.example\.yml.*$/gm
      ) ?? [];

    expect(imageCommands.length).toBeGreaterThan(0);
    for (const command of imageCommands) {
      expect(command).toContain("-p subauto-staging");
    }
  });

  it("configures the public Stage 2 handover evidence URL for staging", () => {
    for (const file of [
      ".env.staging.example",
      ".env.staging.images.example"
    ]) {
      expect(read(file)).toContain(
        "STAGE2_HANDOVER_PUBLIC_WEB_BASE_URL=https://staging-app.subauto.keybox.cloud"
      );
    }
  });

  it("routes staging WeChat OAuth through the authorized Portal domain", () => {
    const nginx = read("nginx/staging-app-wechat-oauth.example.conf");

    for (const file of [
      ".env.staging.example",
      ".env.staging.images.example"
    ]) {
      const environment = read(file);

      expect(environment).toContain(
        "WECHAT_PAY_OAUTH_REDIRECT_URI=https://staging-app.subauto.keybox.cloud/api/portal/wechat/oauth/callback"
      );
      expect(environment).not.toContain(
        "WECHAT_PAY_OAUTH_REDIRECT_URI=https://staging-api.subauto.keybox.cloud"
      );
    }
    expect(nginx).toContain("location = /api/portal/wechat/oauth/callback");
    expect(nginx).toContain(
      "proxy_pass http://127.0.0.1:3101/api/portal/wechat/oauth/callback;"
    );
    expect(nginx).toContain("proxy_set_header Host staging-app.subauto.keybox.cloud;");
    expect(nginx).not.toContain("127.0.0.1:3001");
    expect(nginx).not.toContain("proxy_set_header Host app.subauto.keybox.cloud;");
  });

  it("pins the three approved Stage 2 SMS templates for Staging only", () => {
    const requiredStaging = [
      "FIELD_OPERATOR_SMS_ENABLED=true",
      "FIELD_OPERATOR_SMS_PROVIDER=aliyun",
      "ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE=SMS_511185078",
      "ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510815118",
      "ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510795093"
    ];
    for (const file of [
      ".env.staging.example",
      ".env.staging.images.example"
    ]) {
      const environment = read(file);
      for (const line of requiredStaging) {
        expect(environment).toContain(line);
      }
      expect(environment).toContain("PORTAL_SMS_ENABLED=true");
      expect(environment).toContain("PORTAL_SMS_PROVIDER=aliyun");
    }

    for (const file of [
      ".env.example",
      "apps/api/.env.example",
      "apps/api/.env.production.example"
    ]) {
      const environment = read(file);
      expect(environment).toContain("FIELD_OPERATOR_SMS_ENABLED=false");
      expect(environment).not.toContain("FIELD_OPERATOR_SMS_ENABLED=true");
      expect(environment).not.toMatch(/ALIYUN_SMS_ACCESS_KEY_ID=LTAI/i);
      expect(environment).not.toMatch(/ALIYUN_SMS_ACCESS_KEY_SECRET=[A-Za-z0-9]{16,}/i);
    }
  });

  it("documents worker-off migration, one-worker recovery, and menu verification only", () => {
    const runbook = read("docs/stage2-field-esign-rollout-runbook.md");
    const workerOff = runbook.indexOf("STAGE2_HANDOVER_WORKER_ENABLED=false");
    const migrate = runbook.indexOf("prisma migrate deploy", workerOff);
    const dryRun = runbook.indexOf("--dry-run", migrate);
    const workerOn = runbook.indexOf("STAGE2_HANDOVER_WORKER_ENABLED=true", dryRun);

    expect(workerOff).toBeGreaterThanOrEqual(0);
    expect(migrate).toBeGreaterThan(workerOff);
    expect(dryRun).toBeGreaterThan(migrate);
    expect(workerOn).toBeGreaterThan(dryRun);
    expect(runbook).toContain("STAGE2_HANDOVER_WORKER_CONCURRENCY=1");
    expect(runbook).toContain("ORD20260731173351SMF2");
    expect(runbook).toContain("SMS_511185078");
    expect(runbook).toContain("SMS_510815118");
    expect(runbook).toContain("SMS_510795093");
    expect(runbook).toContain("/field/handover");
    expect(runbook).toMatch(/verification-only/i);
    expect(runbook).toMatch(/do not (change|update).*menu/i);
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
