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
      runbook.match(/^docker compose .*docker-compose\.staging\.images\.example\.yml.*$/gm) ?? [];

    expect(imageCommands.length).toBeGreaterThan(0);
    for (const command of imageCommands) {
      expect(command).toContain("-p subauto-staging");
    }
  });

  it("configures the public Stage 2 handover evidence URL for staging", () => {
    for (const file of [".env.staging.example", ".env.staging.images.example"]) {
      expect(read(file)).toContain(
        "STAGE2_HANDOVER_PUBLIC_WEB_BASE_URL=https://staging-app.subauto.keybox.cloud"
      );
    }
  });

  it("pins parsed auto debit defaults without coupling the billing worker or active payment", () => {
    const staging = parseEnvironment(read(".env.staging.images.example"));
    const production = parseEnvironment(read(".env.production.images.example"));

    expect(staging).toMatchObject({
      APP_ENV: "staging",
      AUTO_DEBIT_ENABLED: "false",
      BILLING_AUTOMATION_WORKER_ENABLED: "true",
      PAYMENT_MANDATE_MOCK_ENABLED: "false",
      PAYMENT_MANDATE_PROVIDER: "disabled",
      PAYMENT_PROVIDER: "mock"
    });
    expect(production).toMatchObject({
      APP_ENV: "production",
      AUTO_DEBIT_ENABLED: "false",
      BILLING_AUTOMATION_WORKER_ENABLED: "true",
      PAYMENT_MANDATE_MOCK_ENABLED: "false",
      PAYMENT_MANDATE_PROVIDER: "disabled",
      PAYMENT_PROVIDER: "wechat_pay"
    });
  });

  it("declares the Stage 1 post-switch target profile only in the staging image example", () => {
    const target = parseEnvironment(read(".env.staging.images.example"));

    expect(target).toMatchObject({
      FIELD_VIDEO_UPLOAD_WORKER_ENABLED: "true",
      MILEAGE_REVIEW_WORKER_ENABLED: "true",
      STAGE2_HANDOVER_WORKER_ENABLED: "true",
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true",
      SUBSCRIPTION_CHANGE_WORKER_ENABLED: "true",
      SUBSCRIPTION_JOURNEY_ENABLED: "true",
      SUBSCRIPTION_JOURNEY_WORKER_ENABLED: "true",
      SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED: "true"
    });
    expect(read(".env.staging.images.example")).toContain("目标配置");

    for (const file of [
      ".env.example",
      ".env.production.example",
      ".env.production.images.example",
      "apps/api/.env.example",
      "apps/api/.env.production.example"
    ]) {
      expect(parseEnvironment(read(file))).toMatchObject({
        FIELD_VIDEO_UPLOAD_WORKER_ENABLED: "false",
        MILEAGE_REVIEW_WORKER_ENABLED: "false",
        STAGE2_HANDOVER_WORKER_ENABLED: "false",
        STAGE2_HANDOVER_WORKFLOW_ENABLED: "false",
        SUBSCRIPTION_CHANGE_WORKER_ENABLED: "false",
        SUBSCRIPTION_JOURNEY_ENABLED: "false",
        SUBSCRIPTION_JOURNEY_WORKER_ENABLED: "false",
        SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED: "false"
      });
    }
  });

  it("pins the complete auto-debit retirement policy in source-build env examples", () => {
    for (const file of [".env.production.example", ".env.staging.example"]) {
      const environment = parseEnvironment(read(file));

      expect(environment).toMatchObject({
        AUTO_DEBIT_ENABLED: "false",
        PAYMENT_MANDATE_MOCK_ENABLED: "false",
        PAYMENT_MANDATE_PROVIDER: "disabled"
      });
    }
  });

  it("passes explicit auto debit defaults from both image Compose files", () => {
    const staging = parseComposeEnvironment(read("docker-compose.staging.images.example.yml"));
    const production = parseComposeEnvironment(
      read("docker-compose.production.images.example.yml")
    );

    expect(staging).toMatchObject({
      AUTO_DEBIT_ENABLED: "false",
      PAYMENT_MANDATE_MOCK_ENABLED: "false",
      PAYMENT_MANDATE_PROVIDER: "disabled"
    });
    expect(production).toMatchObject({
      AUTO_DEBIT_ENABLED: "false",
      PAYMENT_MANDATE_MOCK_ENABLED: "false",
      PAYMENT_MANDATE_PROVIDER: "disabled"
    });

    for (const compose of [
      read("docker-compose.staging.images.example.yml"),
      read("docker-compose.production.images.example.yml")
    ]) {
      expect(compose).not.toMatch(/AUTO_DEBIT_ENABLED:\s*\$\{[^}]*:-true/);
      expect(compose).not.toMatch(/PAYMENT_MANDATE_PROVIDER:\s*\$\{[^}]*:-mock/);
      expect(compose).not.toMatch(/PAYMENT_MANDATE_MOCK_ENABLED:\s*\$\{[^}]*:-true/);
    }
  });

  it("documents the fixed release order and auto-debit retirement operations", () => {
    const deployment = read("docs/deployment.md");
    const runbook = read("docs/operations/stage1b-auto-debit-runbook.zh-CN.md");
    const migration = deployment.indexOf(
      "prisma:migrate:deploy",
      deployment.indexOf("镜像发布固定顺序")
    );
    const healthy = deployment.indexOf("healthy", migration);
    const publicHealth = deployment.indexOf("staging-api.subauto.keybox.cloud/api/health", healthy);

    expect(migration).toBeGreaterThanOrEqual(0);
    expect(healthy).toBeGreaterThan(migration);
    expect(publicHealth).toBeGreaterThan(healthy);
    expect(runbook).toContain("stage1:auto-debit-retirement:dry-run");
    expect(runbook).toContain("stage1:auto-debit-retirement:apply");
    expect(runbook).toContain("postcondition.executableJobCount");
    expect(runbook).toContain("账单提醒 + 主动支付");
    expect(runbook).toContain("历史自动扣款");
    expect(runbook).toContain("不得重新启用自动扣款");
  });

  it("routes staging WeChat OAuth through the authorized Portal domain", () => {
    const nginx = read("nginx/staging-app-wechat-oauth.example.conf");

    for (const file of [".env.staging.example", ".env.staging.images.example"]) {
      const environment = read(file);

      expect(environment).toContain(
        "WECHAT_PAY_OAUTH_REDIRECT_URI=https://staging-app.subauto.keybox.cloud/api/portal/wechat/oauth/callback"
      );
      expect(environment).not.toContain(
        "WECHAT_PAY_OAUTH_REDIRECT_URI=https://staging-api.subauto.keybox.cloud"
      );
    }
    expect(nginx).toContain("location = /api/portal/wechat/oauth/callback");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3101/api/portal/wechat/oauth/callback;");
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
    for (const file of [".env.staging.example", ".env.staging.images.example"]) {
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

    const production = read("apps/api/.env.production.example");
    expect(production).toContain("PORTAL_SMS_PROVIDER=aliyun");
    expect(production).toContain("FIELD_OPERATOR_SMS_PROVIDER=aliyun");
    expect(production).toContain("FIELD_OPERATOR_SMS_ENABLED=false");
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
    expect(runbook).toContain("export COMPOSE_FILE=docker-compose.staging.images.example.yml");
    expect(runbook).toContain("export ENV_FILE=.env.staging.images");
    expect(runbook).toContain("ORD20260731173351SMF2");
    expect(runbook).toContain("SMS_511185078");
    expect(runbook).toContain("SMS_510815118");
    expect(runbook).toContain("SMS_510795093");
    expect(runbook).toContain("/field/handover");
    expect(runbook).toMatch(/verification-only/i);
    expect(runbook).toMatch(/do not (change|update).*menu/i);

    for (const script of [
      "scripts/stage2-handover-workflow-backfill.mjs",
      "scripts/stage2-handover-workflow-backfill-executor.mjs",
      "scripts/stage2-handover-workflow-backfill-apply.mjs",
      "scripts/stage2-handover-workflow-backfill-core.mjs",
      "scripts/stage2-handover-workflow-contract.mjs"
    ]) {
      expect(runbook).toContain(script);
    }
    expect(runbook).not.toMatch(/three release-matched backfill scripts/i);

    const composeCommands = runbook
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith("docker compose "));
    expect(composeCommands.length).toBeGreaterThan(0);
    for (const command of composeCommands) {
      expect(command).toContain("-p subauto-staging");
      expect(command).toContain('--env-file "$ENV_FILE"');
    }
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}

function parseEnvironment(source: string) {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function parseComposeEnvironment(source: string) {
  const result: Record<string, string> = {};
  const apiEnvironment =
    source.match(/\n  api:\n[\s\S]*?\n    environment:\n([\s\S]*?)\n    ports:/)?.[1] ?? "";
  for (const line of apiEnvironment.split(/\r?\n/)) {
    const variable = /^      ([A-Z0-9_]+): \$\{\1:-([^}]*)\}$/.exec(line);
    const literal = /^      ([A-Z0-9_]+): "([^"]*)"$/.exec(line);
    const match = variable ?? literal;
    if (match) {
      result[match[1]] = match[2];
    }
  }
  return result;
}
