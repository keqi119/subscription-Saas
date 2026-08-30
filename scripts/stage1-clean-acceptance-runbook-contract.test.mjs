import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
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

function extractExecutableFence(contents, name) {
  const begin = `<!-- ${name}_BEGIN -->`;
  const end = `<!-- ${name}_END -->`;
  assert.equal(contents.split(begin).length - 1, 1, `${begin} must occur once`);
  assert.equal(contents.split(end).length - 1, 1, `${end} must occur once`);
  const marked = contents.slice(contents.indexOf(begin) + begin.length, contents.indexOf(end));
  const matches = [...marked.matchAll(/```bash\r?\n([\s\S]*?)```/g)];
  assert.equal(matches.length, 1, `${name} must contain exactly one bash fence`);
  return matches[0][1];
}

function validateExecutableContracts(contents) {
  const transformer = extractExecutableFence(contents, "STAGE1_ENV_TRANSFORM_EXECUTABLE");
  const cutover = extractExecutableFence(contents, "STAGE1_CUTOVER_EXECUTABLE");
  assert.match(transformer, /^import \{ buildStage1AcceptanceDatabaseEnvSwitch \}/m);
  assert.match(transformer, /^const after = buildStage1AcceptanceDatabaseEnvSwitch\($/m);
  assert.doesNotMatch(transformer, /^\s*(?:#|\/\/).*buildStage1AcceptanceDatabaseEnvSwitch/m);

  const trapIndex = cutover.indexOf("trap 'rollback_after_switch_error' ERR");
  const activeIndex = cutover.indexOf("SWITCH_ACTIVE=1");
  const renameIndex = cutover.indexOf('mv -f -- "$ENV_TEMP" "$ENV_FILE"');
  assert.ok(trapIndex >= 0 && trapIndex < activeIndex && activeIndex < renameIndex);
  assert.match(cutover, /^"\$CUTOVER_POST_SWITCH_GATES_FN"$/m);
  assert.match(cutover, /^if ! "\$CUTOVER_BROWSER_FACT_VALIDATOR_FN" \\/m);
  assert.doesNotMatch(
    cutover,
    /^\s*#.*(?:CUTOVER_POST_SWITCH_GATES_FN|rollback_after_switch_error)/m
  );
  assertContainsAll(cutover, [
    '"runUtc"',
    '"manifestSha256"',
    '"releaseSha"',
    '"imageId"',
    '"switchedContainerId"',
    '"switchStartedAtUtc"',
    '"logObservationStartedAtUtc"',
    '"challengeCreatedAtUtc"',
    '"nonce"',
    "isDeepStrictEqual(fact.challenge, challenge)",
    "Number.isFinite(completedAt)",
    "completedAt > switchedAtMillis",
    "allDomains(fact.entryPoints",
    "allDomains(fact.rawEnumerations",
    "fact.console.errorCount === 0",
    "fact.console.warnCount === 0",
    "fact.visualReview.admin === true",
    "fact.visualReview.portal === true",
    "BROWSER_ACCEPTANCE_TIMEOUT",
    "BROWSER_ACCEPTANCE_REJECTED",
    "BROWSER_ACCEPTANCE_FACT_INVALID"
  ]);
  const activeCutover = cutover.slice(trapIndex);
  assertStrictOrder(activeCutover, [
    "SWITCH_ACTIVE=1",
    'mv -f -- "$ENV_TEMP" "$ENV_FILE"',
    "write_browser_acceptance_challenge",
    '"$CUTOVER_POST_SWITCH_GATES_FN"',
    "BROWSER_ACCEPTANCE_TIMEOUT_SECONDS",
    "BROWSER_ACCEPTANCE_PAYLOAD",
    '"$CUTOVER_PUBLISH_EVIDENCE_FN" "$BROWSER_FACT_PATH"',
    '"$CUTOVER_BROWSER_FACT_VALIDATOR_FN"',
    "SWITCH_ACTIVE=0",
    "trap - ERR"
  ]);
  return { cutover, transformer };
}

function toGitBashPath(path) {
  return path
    .replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`)
    .replaceAll("\\", "/");
}

function runCutoverFailure(cutover, scenario) {
  const hostDirectory = mkdtempSync(join(tmpdir(), "stage1-cutover-contract-"));
  const directory = toGitBashPath(hostDirectory);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const challenge = {
    schemaVersion: 1,
    runUtc: "20260830T120000Z",
    manifestSha256: "a".repeat(64),
    releaseSha: "b".repeat(40),
    imageId: `sha256:${"c".repeat(64)}`,
    switchedContainerId: "e".repeat(64),
    switchStartedAtUtc: "2026-08-30T12:00:01Z",
    logObservationStartedAtUtc: "2026-08-30T12:00:01Z",
    challengeCreatedAtUtc: "2026-08-30T12:00:01Z",
    nonce: "d".repeat(64)
  };
  const validBrowserFact = JSON.stringify({
    schemaVersion: 1,
    decision: "accepted",
    challenge,
    completedAtUtc: "2026-08-30T12:00:02Z",
    publicHealth: { api: 200, admin: 200, portal: 200 },
    auth: true,
    rbac: true,
    profile: true,
    eSign: true,
    catalog: { products: true, vehicles: true, packages: true, contractTemplates: true },
    emptyDomains: {
      applications: 0,
      orders: 0,
      contracts: 0,
      billing: 0,
      subscriptionChanges: 0,
      returns: 0
    },
    entryPoints: {
      applications: "absent",
      orders: "absent",
      contracts: "absent",
      billing: "absent",
      subscriptionChanges: "absent",
      returns: "absent"
    },
    rawEnumerations: {
      applications: [],
      orders: [],
      contracts: [],
      billing: [],
      subscriptionChanges: [],
      returns: []
    },
    console: { errorCount: 0, warnCount: 0 },
    visualReview: { admin: true, portal: true, responsive: true },
    businessWrites: 0
  });
  const wrapper = `
set -Eeuo pipefail
HARNESS_DIR=${JSON.stringify(directory)}
EVIDENCE_DIR="$HARNESS_DIR/evidence"
ENV_FILE="$HARNESS_DIR/live.env"
ENV_BACKUP="$HARNESS_DIR/old.env"
ENV_TEMP="$HARNESS_DIR/target.env"
TRACE_FILE="$HARNESS_DIR/trace"
mkdir -p "$EVIDENCE_DIR"
printf '%s\\n' old >"$ENV_FILE"
printf '%s\\n' old >"$ENV_BACKUP"
printf '%s\\n' target >"$ENV_TEMP"
printf '%s\\n' deadbeef >"$EVIDENCE_DIR/old-database.fingerprint.sha256"
RUN_UTC=20260830T120000Z
MANIFEST_SHA=${"a".repeat(64)}
RELEASE_SHA=${"b".repeat(40)}
API_IMAGE_ID=sha256:${"c".repeat(64)}
COMPOSE_FILE=fake-compose
STAGE1_ACCEPTANCE_PUBLIC_API_HEALTH_URL=secret-health-url
STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL=secret-database-url
BROWSER_ACCEPTANCE_TIMEOUT_SECONDS=1
FAILURE_SCENARIO=${JSON.stringify(scenario)}
BROWSER_INPUT=${JSON.stringify(validBrowserFact)}
test "$FAILURE_SCENARIO" = browser_reject && BROWSER_INPUT=REJECT
test "$FAILURE_SCENARIO" = browser_timeout && BROWSER_INPUT=__TIMEOUT__
test "$FAILURE_SCENARIO" = browser_invalid && BROWSER_INPUT='{}'
test "$FAILURE_SCENARIO" = browser_preseed && printf '%s\n' stale >"$EVIDENCE_DIR/browser-acceptance.fact.json"
test "$FAILURE_SCENARIO" = challenge_preseed && printf '%s\n' stale >"$EVIDENCE_DIR/browser-acceptance.challenge.json"

assert_new_evidence_path() { test ! -e "$1" && test ! -L "$1"; }
assert_private_file() { test -f "$1" && test ! -L "$1"; }
publish_private_evidence() { local target="$1"; assert_new_evidence_path "$target"; ( set -o noclobber; cat >"$target" ); chmod 0600 "$target"; }
fake_secure_file() { chmod 0600 "$1"; }
fake_sync_directory() { :; }
fake_utc_now() { printf '%s\\n' 2026-08-30T12:00:01Z; }
fake_nonce() { printf '%s\\n' ${"d".repeat(64)}; }
fake_container_id() { printf '%s\\n' ${"e".repeat(64)}; }
fake_api_recreate() {
  printf 'recreate:%s\\n' "$1" >>"$TRACE_FILE"
  if test "$FAILURE_SCENARIO" = api_recreate && test ! -e "$HARNESS_DIR/api-failed"; then
    : >"$HARNESS_DIR/api-failed"
    return 1
  fi
}
fake_post_switch_gates() { printf '%s\\n' post-switch >>"$TRACE_FILE"; test "$FAILURE_SCENARIO" != post_switch; }
fake_public_health() { printf '%s\\n' old-public-health >>"$TRACE_FILE"; }
fake_old_fingerprint() { printf '%s\\n' old-database-fingerprint >>"$TRACE_FILE"; printf '%s\\n' deadbeef; }
fake_after_rename() { test "$FAILURE_SCENARIO" != unexpected_after_rename; }
read() {
  local destination="\${@: -1}"
  test "$BROWSER_INPUT" != __TIMEOUT__ || return 1
  printf -v "$destination" '%s' "$BROWSER_INPUT"
}

STAGE1_CUTOVER_API_RECREATE_FN=fake_api_recreate
STAGE1_CUTOVER_POST_SWITCH_GATES_FN=fake_post_switch_gates
STAGE1_CUTOVER_PUBLIC_HEALTH_FN=fake_public_health
STAGE1_CUTOVER_OLD_FINGERPRINT_FN=fake_old_fingerprint
STAGE1_CUTOVER_CONTAINER_ID_FN=fake_container_id
STAGE1_CUTOVER_NONCE_FN=fake_nonce
STAGE1_CUTOVER_UTC_NOW_FN=fake_utc_now
STAGE1_CUTOVER_SECURE_FILE_FN=fake_secure_file
STAGE1_CUTOVER_SYNC_FN=fake_sync_directory
STAGE1_CUTOVER_AFTER_RENAME_HOOK_FN=fake_after_rename
STAGE1_CUTOVER_PUBLISH_EVIDENCE_FN=publish_private_evidence
STAGE1_CUTOVER_ASSERT_PRIVATE_FILE_FN=assert_private_file
STAGE1_CUTOVER_ASSERT_NEW_PATH_FN=assert_new_evidence_path
${cutover}
`;
  try {
    const result = spawnSync(bash, ["-s"], { encoding: "utf8", input: wrapper });
    const tracePath = join(hostDirectory, "trace");
    return {
      env: readFileSync(join(hostDirectory, "live.env"), "utf8"),
      result,
      trace: readFileSync(tracePath, "utf8").trim().split(/\r?\n/).filter(Boolean)
    };
  } finally {
    const resolvedDirectory = resolve(hostDirectory);
    const resolvedTemp = resolve(tmpdir());
    assert.ok(
      resolvedDirectory.startsWith(`${resolvedTemp}${sep}`) &&
        basename(resolvedDirectory).startsWith("stage1-cutover-contract-")
    );
    rmSync(resolvedDirectory, { force: true, recursive: true });
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
  const { cutover } = validateExecutableContracts(contents);
  assertStrictOrder(cutover, [
    "rollback_api_database_switch() {",
    "rollback_and_stop() {",
    "trap 'rollback_after_switch_error' ERR",
    "SWITCH_ACTIVE=1",
    'mv -f -- "$ENV_TEMP" "$ENV_FILE"',
    '"$CUTOVER_POST_SWITCH_GATES_FN"',
    "SWITCH_ACTIVE=0"
  ]);
  assert.match(
    cutover,
    /if\s+!\s+"\$CUTOVER_API_RECREATE_FN"\s+api;\s+then\s+rollback_and_stop\s+'API_RECREATE_FAILED'/
  );
  assert.match(
    cutover,
    /rollback_after_switch_error\(\)[\s\S]{0,500}rollback_and_stop\s+'POST_SWITCH_GATE_FAILED'/
  );
  assertContainsAll(cutover, [
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
  const { cutover } = validateExecutableContracts(contents);
  const start = indexOfUnique(cutover, "post_switch_database_gates() {");
  const end = cutover.indexOf("SWITCH_ACTIVE=0", start);
  assert.notEqual(end, -1);
  const body = cutover.slice(start, end);
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
  const { transformer } = validateExecutableContracts(contents);
  assertContainsAll(transformer, [
    "buildStage1AcceptanceDatabaseEnvSwitch",
    "STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL",
    "STAGE1_ACCEPTANCE_TARGET_DATABASE_URL"
  ]);
  const transformerEnd = contents.indexOf("<!-- STAGE1_ENV_TRANSFORM_EXECUTABLE_END -->");
  const approval = contents.indexOf("STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL");
  const cutoverBegin = contents.indexOf("<!-- STAGE1_CUTOVER_EXECUTABLE_BEGIN -->");
  assert.ok(transformerEnd < approval && approval < cutoverBegin);
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

test("parses only designated executable fences and rejects critical control-flow mutations", async () => {
  const contents = await readRunbook();
  const { cutover, transformer } = validateExecutableContracts(contents);
  assert.throws(() =>
    validateExecutableContracts(
      contents.replace(
        "const after = buildStage1AcceptanceDatabaseEnvSwitch(",
        "// const after = buildStage1AcceptanceDatabaseEnvSwitch("
      )
    )
  );
  assert.throws(() =>
    validateExecutableContracts(
      contents.replace('"$CUTOVER_POST_SWITCH_GATES_FN"', '# "$CUTOVER_POST_SWITCH_GATES_FN"')
    )
  );
  assert.throws(() =>
    validateExecutableContracts(
      contents
        .replace("trap 'rollback_after_switch_error' ERR", "# trap moved")
        .replace(
          'mv -f -- "$ENV_TEMP" "$ENV_FILE"',
          'mv -f -- "$ENV_TEMP" "$ENV_FILE"\ntrap \'rollback_after_switch_error\' ERR'
        )
    )
  );
  assert.throws(() =>
    validateExecutableContracts(
      contents.replace('"challengeCreatedAtUtc":"%s","nonce":"%s"', '"challengeCreatedAtUtc":"%s"')
    )
  );
  assert.throws(() =>
    validateExecutableContracts(
      contents.replace("fact.console.warnCount === 0", "fact.console.warnCount >= 0")
    )
  );
  assert.throws(() =>
    validateExecutableContracts(
      contents.replace("completedAt > switchedAtMillis", "fact.completedAtUtc > switchedAt")
    )
  );
  assert.ok(transformer.length > 0 && cutover.length > 0);
});

test("executes the designated cutover locally and rolls back every injected failure", async () => {
  const contents = await readRunbook();
  const { cutover } = validateExecutableContracts(contents);
  const scenarios = [
    "api_recreate",
    "post_switch",
    "browser_reject",
    "browser_timeout",
    "browser_invalid",
    "browser_preseed",
    "challenge_preseed",
    "unexpected_after_rename"
  ];
  for (const scenario of scenarios) {
    const outcome = runCutoverFailure(cutover, scenario);
    assert.notEqual(outcome.result.status, 0, `${scenario} must exit nonzero`);
    assert.equal(outcome.env, "old\n", `${scenario} must restore the old env`);
    assert.ok(
      outcome.trace.includes("old-public-health"),
      `${scenario} must verify old public health`
    );
    assert.ok(
      outcome.trace.includes("old-database-fingerprint"),
      `${scenario} must verify old database fingerprint`
    );
    const recreates = outcome.trace.filter((entry) => entry.startsWith("recreate:"));
    assert.equal(
      recreates.length,
      scenario === "unexpected_after_rename" ? 1 : 2,
      `${scenario} must recreate once for switch when reached and once for rollback`
    );
    assert.equal(
      recreates.every((entry) => entry === "recreate:api"),
      true,
      `${scenario} may recreate only api`
    );
    assert.doesNotMatch(
      `${outcome.result.stdout}\n${outcome.result.stderr}`,
      /secret-(?:health|database)-url/
    );
  }
});

test("clears rollback protection only after the injected browser fact validator succeeds", async () => {
  const contents = await readRunbook();
  const { cutover } = validateExecutableContracts(contents);
  const outcome = runCutoverFailure(cutover, "success");
  assert.equal(outcome.result.status, 0);
  assert.equal(outcome.env, "target\n");
  assert.deepEqual(outcome.trace, ["recreate:api", "post-switch"]);
});
