import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function indexOfUnique(contents, fragment) {
  const first = contents.indexOf(fragment);
  assert.notEqual(first, -1, `runbook must contain: ${fragment}`);
  assert.equal(
    contents.indexOf(fragment, first + fragment.length),
    -1,
    `runbook must contain once: ${fragment}`
  );
  return first;
}

function assertStrictOrder(contents, fragments) {
  let cursor = 0;
  for (const fragment of fragments) {
    const index = contents.indexOf(fragment, cursor);
    assert.notEqual(index, -1, `runbook must contain in control-flow order: ${fragment}`);
    cursor = index + fragment.length;
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
  assertStrictOrder(contents, [
    markers[0],
    "--apply --vehicle-id",
    "--replay --vehicle-id",
    "stage1-clean-acceptance-target-validator.mjs",
    "STOP: CANDIDATE_API_TIMER_ISOLATION_UNPROVEN",
    markers[1],
    'mv -f -- "$ENV_TEMP" "$ENV_FILE"'
  ]);
});

test("defines idempotent rollback before rename and routes every switched failure through it", async () => {
  const contents = await readRunbook();
  assertStrictOrder(contents, [
    "rollback_api_database_switch() {",
    "rollback_and_stop() {",
    "trap 'rollback_after_switch_error' ERR",
    "SWITCH_ACTIVE=1",
    'mv -f -- "$ENV_TEMP" "$ENV_FILE"',
    "post_switch_database_gates;",
    "SWITCH_ACTIVE=0"
  ]);
  assert.match(
    contents,
    /if\s+!\s+docker compose[\s\S]{0,500}force-recreate api[\s\S]{0,200}then\s+rollback_and_stop\s+'API_RECREATE_FAILED'/
  );
  assert.match(
    contents,
    /rollback_after_switch_error\(\)[\s\S]{0,500}rollback_and_stop\s+'POST_SWITCH_GATE_FAILED'/
  );
  assertContainsAll(contents, [
    "ROLLBACK_ENV_RESTORE_FAILED",
    "ROLLBACK_API_RECREATE_FAILED",
    "ROLLBACK_PUBLIC_HEALTH_FAILED",
    "ROLLBACK_OLD_DATABASE_FINGERPRINT_FAILED",
    "ROLLBACK_FAILED"
  ]);
});

test("never infers completed billing cycles from elapsed time", async () => {
  const contents = await readRunbook();
  assert.doesNotMatch(contents, /\bsleep\s+130\b/);
  assert.doesNotMatch(contents, /billing_cycles_observed=2/);
  assertStrictOrder(contents, [
    "STOP: BILLING_COMPLETED_CYCLE_EVIDENCE_UNAVAILABLE",
    "STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL"
  ]);
  assertContainsAll(contents, [
    "两个不同的 completed cycle ID",
    "blockedCount=0",
    "禁止写域前后计数摘要一致",
    "ERROR|FATAL|Unhandled|PrismaClientKnownRequestError|HTTP 5",
    "PII_LOG_SCAN_CLEAR",
    "DOCKER_LOG_READ_FAILED"
  ]);
  assert.doesNotMatch(contents, /docker logs[^\n]*(?:\n[^\n]*){0,3}\|\| true/);
});

test("runs complete post-switch gates under rollback protection", async () => {
  const contents = await readRunbook();
  const start = indexOfUnique(contents, "post_switch_database_gates() {");
  const end = contents.indexOf("SWITCH_ACTIVE=0", start);
  assert.notEqual(end, -1);
  const body = contents.slice(start, end);
  assertContainsAll(body, [
    "stage1-clean-acceptance-target-validator.mjs",
    "prisma migrate status",
    "prisma:migrate:checksum:verify",
    "prisma migrate diff",
    "124 applied / 0 rolled-back / 0 pending / 0 failed / 0 duplicate",
    "RestartCount",
    "SUBSCRIPTION_JOURNEY_ENABLED",
    "SUBSCRIPTION_JOURNEY_WORKER_ENABLED",
    "BILLING_AUTOMATION_WORKER_ENABLED",
    "FIELD_VIDEO_UPLOAD_WORKER_ENABLED",
    "STAGE2_HANDOVER_WORKER_ENABLED",
    "MILEAGE_REVIEW_WORKER_ENABLED",
    "SUBSCRIPTION_EXTENSION_ENABLED",
    "SUBSCRIPTION_VEHICLE_SWAP_ENABLED",
    "SUBSCRIPTION_EARLY_TERMINATION_ENABLED",
    "SUBSCRIPTION_MANAGED_OTHER_ENABLED",
    "PUBLIC_API_HEALTH",
    "PUBLIC_ADMIN_HEALTH",
    "PUBLIC_PORTAL_HEALTH",
    "READ_ONLY_AUTH_RBAC_PROFILE_CATALOG_EMPTY_DOMAINS"
  ]);
});

test("uses the tested env transformer and binds approved source and target before rename", async () => {
  const contents = await readRunbook();
  assertContainsAll(contents, [
    "buildStage1AcceptanceDatabaseEnvSwitch",
    "STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL",
    "STAGE1_ACCEPTANCE_TARGET_DATABASE_URL",
    "ENV_DATABASE_URL_SOURCE_MISMATCH",
    "APPROVED_DATABASE_URL_PAIR_INVALID"
  ]);
  assertStrictOrder(contents, [
    "buildStage1AcceptanceDatabaseEnvSwitch",
    "STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL",
    'mv -f -- "$ENV_TEMP" "$ENV_FILE"'
  ]);
});

test("requires replay zero-write evidence before candidate and switch", async () => {
  const contents = await readRunbook();
  assertStrictOrder(contents, [
    ".auditCreated == 0 and .inserted == 0 and .updated == 0 and .deleted == 0",
    "STOP: CANDIDATE_API_TIMER_ISOLATION_UNPROVEN",
    "STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL"
  ]);
});

test("makes evidence creation immutable and records complete backup metadata", async () => {
  const contents = await readRunbook();
  assertStrictOrder(contents, [
    'test ! -e "$EVIDENCE_DIR"',
    'install -d -o root -g root -m 0700 "$EVIDENCE_DIR"',
    'assert_private_directory "$EVIDENCE_DIR"'
  ]);
  assertContainsAll(contents, [
    "assert_new_evidence_path",
    "publish_private_evidence",
    "test ! -L",
    "uid=0",
    "gid=0",
    "mode=0700",
    "mode=0600",
    "backup_started_at_utc",
    "backup_completed_at_utc",
    "backup_size_bytes",
    "EVIDENCE_PERMISSION_SCAN_FAILED"
  ]);
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
    "install -d -o root -g root -m 0700",
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
    'install -d -o root -g root -m 0700 "$EVIDENCE_DIR"',
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
    "仅 pathname 不同",
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
  assert.doesNotMatch(
    contents,
    /(?:echo|printf)[^\n]+\$(?:\{)?[^\s}"']*(?:DATABASE_URL|TOKEN|PASSWORD)/i
  );
});

test("all executable bash fences are syntactically valid without executing them", async () => {
  const contents = await readRunbook();
  const blocks = [...contents.matchAll(/```bash\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.ok(blocks.length > 0);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  for (const [index, block] of blocks.entries()) {
    const result = spawnSync(bash, ["-n"], { encoding: "utf8", input: block });
    assert.equal(result.status, 0, `bash fence ${index + 1} must parse: ${result.stderr}`);
  }
});
