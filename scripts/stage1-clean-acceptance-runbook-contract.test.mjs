import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runbookUrl = new URL(
  "../docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md",
  import.meta.url
);

async function readRunbook() {
  return readFile(runbookUrl, "utf8").catch(() => "");
}

function assertContainsAll(contents, fragments) {
  for (const fragment of fragments) {
    assert.ok(contents.includes(fragment), `runbook must contain: ${fragment}`);
  }
}

test("requires two independent, exact human approval stops", async () => {
  const contents = await readRunbook();
  const markers = [
    "STOP FOR HUMAN APPROVAL: BASELINE_APPLY_APPROVAL",
    "STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL"
  ];

  for (const marker of markers) {
    assert.equal(contents.split(marker).length - 1, 1, `${marker} must occur exactly once`);
  }
});

test("keeps the old database read-only and makes backup and migration gates fail closed", async () => {
  const contents = await readRunbook();

  assertContainsAll(contents, [
    "旧库全程只读",
    "禁止 repair",
    "TEMPLATE template0",
    "TARGET_DB_REGEX_INVALID",
    "migration deploy",
    "migrate status",
    "prisma:migrate:checksum:verify",
    "prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code",
    'DRIFT_EXIT="$?"',
    'test "$DRIFT_EXIT" -eq 0',
    "124 applied / 0 rolled-back / 0 pending / 0 failed / 0 duplicate",
    "install -d -m 0700",
    "chmod 0600",
    "sha256sum",
    "先备份旧库，再备份空新库"
  ]);
  assert.doesNotMatch(contents, /^\s*(?:migrate\s+resolve|migrate\s+reset|repair\b)/im);
});

test("pins migration execution to the release image and records the fixed preflight", async () => {
  const contents = await readRunbook();

  assertContainsAll(contents, [
    'readonly COMPOSE_FILE="/opt/subscription-saas/docker-compose.staging.images.yml"',
    'readonly ENV_FILE="/opt/subscription-saas/.env.staging.images"',
    'readonly API_CONTAINER_ID="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q api)"',
    'test -n "$API_CONTAINER_ID"',
    "org.opencontainers.image.revision",
    'readonly RUN_UTC="$(date -u +%Y%m%dT%H%M%SZ)"',
    'readonly EVIDENCE_DIR="/opt/subscription-saas/reports/stage1-clean-acceptance-${RUN_UTC}"',
    'readonly TARGET_DB="subscription_saas_staging_acceptance_${RUN_UTC,,}"',
    'install -d -m 0700 "$EVIDENCE_DIR"',
    "docker compose config --services",
    "docker compose ps",
    "目标 API 镜像只运行一次 migration deploy",
    "磁盘、内存、连接数、容器 health、Git/image SHA"
  ]);
});

test("requires discovery, explicit UUID dry-run, manifest approval, apply, replay, and validator", async () => {
  const contents = await readRunbook();

  assertContainsAll(contents, [
    "--discover-vehicles",
    '--vehicle-id "$APPROVED_VEHICLE_UUID"',
    "safeToApply=true",
    "exceptions=[]",
    "禁止域计数全部为 0",
    "manifest SHA 与独立 sha256sum 一致",
    "--apply",
    "--replay",
    "stage1-clean-acceptance-target-validator.mjs",
    "脱敏计数与车辆摘要"
  ]);
});

test("fails closed on candidate worker isolation and forbids business writes", async () => {
  const contents = await readRunbook();

  assertContainsAll(contents, [
    "127.0.0.1",
    "不接入 Nginx",
    "SUBSCRIPTION_JOURNEY_ENABLED=false",
    "SUBSCRIPTION_JOURNEY_WORKER_ENABLED=false",
    "BILLING_AUTOMATION_WORKER_ENABLED=false",
    "FIELD_VIDEO_UPLOAD_WORKER_ENABLED=false",
    "STAGE2_HANDOVER_WORKER_ENABLED=false",
    "MILEAGE_REVIEW_WORKER_ENABLED=false",
    "SubscriptionChangeWorker",
    "apps/api/src/subscription-change/subscription-change.worker.ts",
    "apps/api/src/subscription-change/subscription-change.module.ts",
    "CANDIDATE_API_TIMER_ISOLATION_UNPROVEN",
    "不得启动 candidate API",
    "不提交进件、不锁车、不签合同、不触发短信、电子签或支付"
  ]);
});

test("limits cutover and rollback to an atomic DATABASE_URL pathname change and API-only recreate", async () => {
  const contents = await readRunbook();

  assertContainsAll(contents, [
    "cp --preserve=mode,ownership,timestamps",
    "只替换 DATABASE_URL 的 pathname",
    "保留 protocol/host/port/user/password/query",
    "同目录临时文件",
    "chmod 600",
    "原子 rename",
    "只重建 API service",
    "恢复旧 env",
    "保留新库与证据",
    "不 DROP、不合并回旧库",
    "连续两个 billing maintenance cycle",
    "日志门禁",
    "浏览器验收",
    "禁止在在线 API 容器运行 pnpm 诊断"
  ]);
});

test("prohibits secret and identity output", async () => {
  const contents = await readRunbook();

  assertContainsAll(contents, [
    "不得输出 URL、凭据、环境文件内容、客户/车辆身份或 token",
    "只输出 hash、计数、稳定状态、固定证据路径、Git/image 身份"
  ]);
  assert.doesNotMatch(contents, /^\s*set\s+-x\b/m);
  assert.doesNotMatch(contents, /(?:cat|less|more|head|tail)\s+["']?\$ENV_FILE\b/);
  assert.doesNotMatch(contents, /docker\s+inspect[^\n]+\.Config\.Env/);
  assert.doesNotMatch(contents, /(?:echo|printf)[^\n]+(?:DATABASE_URL|TOKEN|PASSWORD)/i);
});
