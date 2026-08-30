# Stage 1 干净 Staging 验收数据库发布、候选验证、切换与回滚手册

> 状态：**仅供未来另行明确批准的 Staging 执行窗口使用**。合并、部署、批准设计/计划/PR 或阅读本手册均不构成执行批准。本手册当前还包含一个不可豁免的 candidate API 硬停止；在对应源码缺口修复且本手册经独立评审前，流程不能到达切换。

## 1. 不变量与人工职责

- 旧库全程只读。创建新库、备份、迁移和 baseline 操作不得向旧库提交写事务；禁止 repair，禁止 `migrate resolve`，禁止 `migrate reset`。
- 新库从零创建，只能以 `TEMPLATE template0` 初始化；不得以旧库或任何业务库作为模板，也不得复制旧库全量数据。
- 不得输出 URL、凭据、环境文件内容、客户/车辆身份或 token。终端与持久证据只输出 hash、计数、稳定状态、固定证据路径、Git/image 身份。关闭 shell trace，禁止复制原始容器日志或环境变量。
- 所有证据目录必须为 root 所有、`0700`；证据文件必须为 root 所有、`0600`。发现权限、owner、符号链接或目标已存在不符合预期时立即停止。
- 管理员连接 URL、owner role、源/目标 URL 和既有登录 token 只从 root-owned shell 环境或既有浏览器会话读取，不写入报告。
- 两个人工批准是独立批准：baseline apply 批准不能替代 API 数据库切换批准，部署/PR/计划批准也不能替代任一批准。
- 禁止在在线 API 容器运行 pnpm 诊断。Prisma、baseline 和 validator 只能在与目标 Git SHA 相同的目标 API 镜像的一次性容器内运行。
- 任意命令非零、断言不满足或证据无法证明时立即停止。不得修改固定路径、service 名称或变量去猜测其他运行对象。

本节之后的所有命令只能由获得当次窗口明确授权的 root 执行者在服务器本地运行。**本任务只编写手册与测试，不授权运行以下命令。**

## 2. 服务器只读预检与证据目录

首先由 root shell 注入已批准的 `APPROVED_RELEASE_SHA` 以及数据库相关秘密变量；不得启用 `set -x`。下列初始化块固定使用指定 compose 文件和 `api` service：

```bash
set -euo pipefail
umask 077
readonly COMPOSE_FILE="/opt/subscription-saas/docker-compose.staging.images.yml"
readonly ENV_FILE="/opt/subscription-saas/.env.staging.images"
readonly API_CONTAINER_ID="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q api)"
test -n "$API_CONTAINER_ID"
readonly RELEASE_SHA="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$API_CONTAINER_ID")"
readonly RUN_UTC="$(date -u +%Y%m%dT%H%M%SZ)"
readonly EVIDENCE_DIR="/opt/subscription-saas/reports/stage1-clean-acceptance-${RUN_UTC}"
readonly TARGET_DB="subscription_saas_staging_acceptance_${RUN_UTC,,}"
install -d -m 0700 "$EVIDENCE_DIR"
```

固定对象验证；必须用 `docker compose config --services` 和 `docker compose ps` 的等价固定文件调用确认。若 `api` 不存在、不是唯一运行实例或固定路径不存在，停止，不改变量猜测：

```bash
test -f "$COMPOSE_FILE"
test -f "$ENV_FILE"
readonly COMPOSE_SERVICES="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --services)"
grep -Fxq 'api' <<<"$COMPOSE_SERVICES"
test "$(grep -Fxc 'api' <<<"$COMPOSE_SERVICES")" -eq 1

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --format json \
  | jq '[.[] | {Health,Service,State}]' \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/compose-ps.safe.json"

readonly OBSERVED_API_CONTAINER_ID="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q api)"
test "$OBSERVED_API_CONTAINER_ID" = "$API_CONTAINER_ID"
test "$(docker inspect --format '{{.State.Running}}' "$API_CONTAINER_ID")" = 'true'
test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$API_CONTAINER_ID")" = 'healthy'
```

记录磁盘、内存、连接数、容器 health、Git/image SHA；只保留安全字段：

```bash
: "${APPROVED_RELEASE_SHA:?approved release SHA is required}"
: "${STAGE1_ACCEPTANCE_ADMIN_DATABASE_URL:?root-owned admin URL is required}"
: "${STAGE1_ACCEPTANCE_DATABASE_OWNER:?root-owned owner role is required}"
: "${STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL:?root-owned source URL is required}"
: "${STAGE1_ACCEPTANCE_TARGET_DATABASE_URL:?root-owned target URL is required}"
: "${STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME:?approved database hostname is required}"

[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { printf '%s\n' 'STOP: RELEASE_SHA_INVALID'; exit 1; }
[[ "$APPROVED_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { printf '%s\n' 'STOP: APPROVED_RELEASE_SHA_INVALID'; exit 1; }
test "$RELEASE_SHA" = "$APPROVED_RELEASE_SHA"
[[ "$TARGET_DB" =~ ^subscription_saas_staging_acceptance_[0-9]{8}t[0-9]{6}z$ ]] \
  || { printf '%s\n' 'STOP: TARGET_DB_REGEX_INVALID'; exit 1; }

readonly API_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$API_CONTAINER_ID")"
readonly API_IMAGE_REF="$(docker image inspect --format '{{index .RepoDigests 0}}' "$API_IMAGE_ID")"
[[ "$API_IMAGE_REF" =~ @sha256:[0-9a-f]{64}$ ]] \
  || { printf '%s\n' 'STOP: API_IMAGE_DIGEST_INVALID'; exit 1; }
readonly COMPOSE_API_IMAGE="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --format json | jq -er '.services.api.image')"
readonly COMPOSE_API_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$COMPOSE_API_IMAGE")"
test "$COMPOSE_API_IMAGE_ID" = "$API_IMAGE_ID"

df -Pk /opt/subscription-saas \
  | awk 'NR==1 || NR==2 {print $2, $3, $4, $5}' \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/disk-counts.txt"
docker stats --no-stream --format '{{.MemUsage}}' "$API_CONTAINER_ID" \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/api-memory.txt"
psql "$STAGE1_ACCEPTANCE_ADMIN_DATABASE_URL" -XAtq \
  -c 'SELECT count(*) FROM pg_stat_activity' \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/database-connection-count.txt"

{
  printf 'git_sha=%s\n' "$RELEASE_SHA"
  printf 'image_ref=%s\n' "$API_IMAGE_REF"
  printf 'api_state=running\napi_health=healthy\n'
  printf 'evidence_dir=%s\n' "$EVIDENCE_DIR"
} | install -m 0600 /dev/stdin "$EVIDENCE_DIR/preflight.safe.env"
```

不得运行会展开环境文件的命令，也不得检查容器 `.Config.Env`。到这里仍然只是只读服务器预检；没有创建或修改数据库。

## 3. 创建空新库、前置备份与 migration 门禁

先以 Node URL parser 静默断言源/目标 hostname 相同、目标 pathname 精确等于 `TARGET_DB`，并保留目标 URL 的 protocol/host/port/user/password/query；该检查无 stdout：

```bash
TARGET_DB="$TARGET_DB" node <<'NODE'
const source = new URL(process.env.STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL);
const target = new URL(process.env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL);
const expectedHost = process.env.STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME;
if (source.hostname !== expectedHost || target.hostname !== expectedHost) process.exit(21);
if (target.pathname !== `/${process.env.TARGET_DB}`) process.exit(22);
for (const key of ["protocol", "hostname", "port", "username", "password", "search", "hash"]) {
  if (source[key] !== target[key]) process.exit(23);
}
NODE
```

只把受控 shell 变量作为 `psql` identifier 参数，再由 PostgreSQL `format('%I', ...)` quote；禁止 shell SQL 字符串拼接：

```bash
psql "$STAGE1_ACCEPTANCE_ADMIN_DATABASE_URL" \
  --set=target_db="$TARGET_DB" \
  --set=owner_role="$STAGE1_ACCEPTANCE_DATABASE_OWNER" <<'SQL'
SELECT format(
  'CREATE DATABASE %I OWNER %I TEMPLATE template0 ENCODING %L',
  :'target_db',
  :'owner_role',
  'UTF8'
) \gexec
SQL
```

创建后立刻证明新库为空。先备份旧库，再备份空新库；两份 backup 都发生在任何 migration 或 baseline apply 之前，备份前后不得对旧库执行写事务：

```bash
readonly OLD_DB_BACKUP="$EVIDENCE_DIR/old-database.pre-apply.dump"
readonly EMPTY_NEW_DB_BACKUP="$EVIDENCE_DIR/empty-new-database.pre-migration.dump"

pg_dump "$STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL" --format=custom --file="$OLD_DB_BACKUP"
chmod 0600 "$OLD_DB_BACKUP"
sha256sum "$OLD_DB_BACKUP" | install -m 0600 /dev/stdin "$EVIDENCE_DIR/old-database.pre-apply.sha256"

pg_dump "$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" --format=custom --file="$EMPTY_NEW_DB_BACKUP"
chmod 0600 "$EMPTY_NEW_DB_BACKUP"
sha256sum "$EMPTY_NEW_DB_BACKUP" | install -m 0600 /dev/stdin "$EVIDENCE_DIR/empty-new-database.pre-migration.sha256"
```

以下四个 migration 检查均在目标 API 镜像的一次性容器内运行；不得进入在线 API 容器。目标 API 镜像只运行一次 migration deploy。所有原始输出被抑制或解析为安全计数，任意非零立即停止：

```bash
if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL \
  --env DATABASE_URL="$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" api \
  sh -lc 'cd /app/apps/api && pnpm exec prisma migrate deploy --schema prisma/schema.prisma' \
  >/dev/null 2>&1; then
  printf '%s\n' 'migration_deploy=applied_once' \
    | install -m 0600 /dev/stdin "$EVIDENCE_DIR/migration-deploy.state"
else
  printf '%s\n' 'STOP: MIGRATION_DEPLOY_FAILED'
  exit 1
fi

if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --env DATABASE_URL="$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" api \
  sh -lc 'cd /app/apps/api && pnpm exec prisma migrate status --schema prisma/schema.prisma' \
  >/dev/null 2>&1; then
  printf '%s\n' 'migrate_status=up_to_date' \
    | install -m 0600 /dev/stdin "$EVIDENCE_DIR/migrate-status.state"
else
  printf '%s\n' 'STOP: MIGRATE_STATUS_FAILED'
  exit 1
fi

CHECKSUM_RESULT="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --env DATABASE_URL="$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" api \
  sh -lc 'cd /app && pnpm prisma:migrate:checksum:verify')"
jq -e '.safe == true and .localMigrationCount == 124 and .appliedMigrationCount == 124 and (.duplicateAppliedNames|length)==0 and (.mismatchedNames|length)==0 and (.missingFromDatabase|length)==0 and (.missingLocally|length)==0' \
  <<<"$CHECKSUM_RESULT" >/dev/null
jq '{appliedMigrationCount,duplicateCount:(.duplicateAppliedNames|length),localMigrationCount,mismatchCount:(.mismatchedNames|length),missingDatabaseCount:(.missingFromDatabase|length),missingLocalCount:(.missingLocally|length),safe}' \
  <<<"$CHECKSUM_RESULT" \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/migration-checksum.safe.json"
unset CHECKSUM_RESULT
```

真实 drift 检查必须保留 Prisma 原始退出码，并在 API 包目录运行。退出码 `2` 是 drift，`1` 是命令失败；两者都停止，不能用 pipeline 或 workspace wrapper 归一化：

```bash
set +e
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --env DATABASE_URL="$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" api \
  sh -lc 'cd /app/apps/api && pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code' \
  >/dev/null 2>&1
DRIFT_EXIT="$?"
set -e
readonly DRIFT_EXIT
test "$DRIFT_EXIT" -eq 0
printf 'drift_exit=%s\n' "$DRIFT_EXIT" \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/migration-diff.state"
```

最后直接读取 `_prisma_migrations` 的安全计数；pending 同时由 `migrate status` 与 checksum 的 missing count 证明为零：

```bash
readonly MIGRATION_COUNTS="$(psql "$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" -XAtq <<'SQL'
WITH duplicate_names AS (
  SELECT migration_name FROM _prisma_migrations GROUP BY migration_name HAVING count(*) > 1
)
SELECT
  count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
  count(*) FILTER (WHERE rolled_back_at IS NOT NULL),
  count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL),
  (SELECT count(*) FROM duplicate_names)
FROM _prisma_migrations;
SQL
)"
test "$MIGRATION_COUNTS" = '124|0|0|0'
printf '%s\n' '124 applied / 0 rolled-back / 0 pending / 0 failed / 0 duplicate' \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/migration-counts.state"
```

## 4. Discovery、正式 dry-run 与 baseline 批准

将证据目录以相同绝对语义挂入目标镜像；一次性容器以 root 写入 `0600` 文件。先运行 `--discover-vehicles`。该模式按设计以退出码 `3` 返回 `VEHICLE_SELECTION_REQUIRED`，只允许打印脱敏 count/digest：

```bash
export STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL
export STAGE1_ACCEPTANCE_TARGET_DATABASE_URL
export STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME
export STAGE1_ACCEPTANCE_GIT_SHA="$RELEASE_SHA"
export STAGE1_ACCEPTANCE_IMAGE_REF="$API_IMAGE_REF"

set +e
DISCOVERY_SUMMARY="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --user 0:0 --volume "$EVIDENCE_DIR:/evidence" \
  --env STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL \
  --env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL \
  --env STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME \
  --env STAGE1_ACCEPTANCE_GIT_SHA \
  --env STAGE1_ACCEPTANCE_IMAGE_REF api \
  sh -lc 'cd /app && node scripts/stage1-clean-acceptance-baseline.mjs --dry-run --discover-vehicles --output /evidence/vehicle-discovery.json')"
DISCOVERY_EXIT="$?"
set -e
test "$DISCOVERY_EXIT" -eq 3
jq -e '.safe == false and .mode == "dry-run" and .errorCode == "VEHICLE_SELECTION_REQUIRED" and (.candidateCount >= 1) and (.candidateDigest|test("^[0-9a-f]{64}$"))' \
  <<<"$DISCOVERY_SUMMARY" >/dev/null
jq '{candidateCount,candidateDigest,errorCode,mode,safe}' <<<"$DISCOVERY_SUMMARY" \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/vehicle-discovery.safe.json"
unset DISCOVERY_SUMMARY
chmod 0600 "$EVIDENCE_DIR/vehicle-discovery.json"
```

候选原始文件包含 vehicle UUID，因此不得输出、复制到日志或发送到聊天。授权执行者在 root-only 受控会话中完成选择，以隐藏输入录入显式 UUID，并验证 UUID 确实来自 discovery；本手册不会显示该值：

```bash
read -r -s -p 'Approved vehicle UUID (hidden): ' APPROVED_VEHICLE_UUID
printf '\n'
[[ "$APPROVED_VEHICLE_UUID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || { printf '%s\n' 'STOP: VEHICLE_UUID_INVALID'; exit 1; }
jq -e --arg selected "$APPROVED_VEHICLE_UUID" \
  '[.candidates[] | select(.id == $selected)] | length == 1' \
  "$EVIDENCE_DIR/vehicle-discovery.json" >/dev/null
readonly APPROVED_VEHICLE_UUID
export APPROVED_VEHICLE_UUID
```

使用显式 UUID 生成正式 dry-run：

```bash
readonly DRY_RUN_REPORT="$EVIDENCE_DIR/baseline-dry-run.json"
readonly DRY_RUN_SUMMARY="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --user 0:0 --volume "$EVIDENCE_DIR:/evidence" \
  --env STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL \
  --env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL \
  --env STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME \
  --env STAGE1_ACCEPTANCE_GIT_SHA \
  --env STAGE1_ACCEPTANCE_IMAGE_REF \
  --env APPROVED_VEHICLE_UUID api \
  sh -lc 'cd /app && node scripts/stage1-clean-acceptance-baseline.mjs --dry-run --vehicle-id "$APPROVED_VEHICLE_UUID" --output /evidence/baseline-dry-run.json')"
chmod 0600 "$DRY_RUN_REPORT"
jq -e '.safe == true and .mode == "dry-run" and (.manifestSha256|test("^[0-9a-f]{64}$"))' \
  <<<"$DRY_RUN_SUMMARY" >/dev/null
jq -e '.safe == true and .manifest.safeToApply == true and .manifest.exceptions == []' \
  "$DRY_RUN_REPORT" >/dev/null
```

`safeToApply=true`、`exceptions=[]` 且禁止域计数全部为 0 是 apply 前的硬门禁。后者由 baseline 分类器的 safe 判定、空 exceptions 和目标 validator 共同证明。用独立 `sha256sum` 对 canonical manifest bytes 复核，要求 manifest SHA 与独立 sha256sum 一致；文件保持 `0600`：

```bash
readonly MANIFEST_SHA="$(jq -r '.manifestSha256' "$DRY_RUN_REPORT")"
readonly INDEPENDENT_MANIFEST_SHA="$(jq -j -cS '.manifest' "$DRY_RUN_REPORT" | sha256sum | awk '{print $1}')"
test "$MANIFEST_SHA" = "$INDEPENDENT_MANIFEST_SHA"
export MANIFEST_SHA

jq '{counts:.manifest.counts,exceptionsCount:(.manifest.exceptions|length),manifestSha256,safeToApply:.manifest.safeToApply,vehicleSummary:.manifest.selection.vehicleDigests}' \
  "$DRY_RUN_REPORT" \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/baseline-approval.safe.json"
```

批准报告只含 SHA、脱敏计数与车辆摘要（salted digest，不含 UUID），不得附客户、车辆或 token 身份。

**STOP FOR HUMAN APPROVAL: BASELINE_APPLY_APPROVAL**

到此必须停止，等待本次窗口对 `MANIFEST_SHA` 的独立明确批准。之前的设计、计划、PR、部署或服务器预检批准都不能替代它。没有批准不得设置 apply confirmation，不得运行下一节。

## 5. Apply、replay 与 target validator

收到批准后，仅对批准的 dry-run manifest 执行一次 apply，随后立即 replay 和 validator。三者都使用同一目标镜像、同一 manifest SHA，并只打印公共安全摘要：

```bash
readonly APPLY_SUMMARY="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --user 0:0 --volume "$EVIDENCE_DIR:/evidence" \
  --env STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL \
  --env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL \
  --env STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME \
  --env STAGE1_ACCEPTANCE_GIT_SHA \
  --env STAGE1_ACCEPTANCE_IMAGE_REF \
  --env APPROVED_VEHICLE_UUID \
  --env MANIFEST_SHA \
  --env STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY=1 api \
  sh -lc 'cd /app && node scripts/stage1-clean-acceptance-baseline.mjs --apply --vehicle-id "$APPROVED_VEHICLE_UUID" --approved-manifest /evidence/baseline-dry-run.json --approved-manifest-sha256 "$MANIFEST_SHA" --output /evidence/baseline-apply.json')"
jq -e '.safe == true and .mode == "apply" and .manifestSha256 == $sha' --arg sha "$MANIFEST_SHA" \
  <<<"$APPLY_SUMMARY" >/dev/null
chmod 0600 "$EVIDENCE_DIR/baseline-apply.json"

readonly REPLAY_SUMMARY="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --user 0:0 --volume "$EVIDENCE_DIR:/evidence" \
  --env STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL \
  --env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL \
  --env STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME \
  --env STAGE1_ACCEPTANCE_GIT_SHA \
  --env STAGE1_ACCEPTANCE_IMAGE_REF \
  --env APPROVED_VEHICLE_UUID \
  --env MANIFEST_SHA \
  --env STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY=1 api \
  sh -lc 'cd /app && node scripts/stage1-clean-acceptance-baseline.mjs --replay --vehicle-id "$APPROVED_VEHICLE_UUID" --approved-manifest /evidence/baseline-dry-run.json --approved-manifest-sha256 "$MANIFEST_SHA" --output /evidence/baseline-replay.json')"
jq -e '.safe == true and .mode == "replay" and .manifestSha256 == $sha' --arg sha "$MANIFEST_SHA" \
  <<<"$REPLAY_SUMMARY" >/dev/null
chmod 0600 "$EVIDENCE_DIR/baseline-replay.json"

readonly VALIDATOR_SUMMARY="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --user 0:0 --volume "$EVIDENCE_DIR:/evidence" \
  --env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL \
  --env STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME \
  --env MANIFEST_SHA api \
  sh -lc 'cd /app && node scripts/stage1-clean-acceptance-target-validator.mjs --approved-manifest /evidence/baseline-dry-run.json --approved-manifest-sha256 "$MANIFEST_SHA" --output /evidence/target-validator.json')"
jq -e '.safe == true and .mode == "target-validator" and .manifestSha256 == $sha' --arg sha "$MANIFEST_SHA" \
  <<<"$VALIDATOR_SUMMARY" >/dev/null
chmod 0600 "$EVIDENCE_DIR/target-validator.json"
```

## 6. Candidate API 静态 worker/timer 证明与硬停止

预期 candidate 约束是：独立容器名、只绑定 `127.0.0.1` 备用端口、`DATABASE_URL` 指向新库、不接入 Nginx、不创建业务数据，并显式设置：

```text
SUBSCRIPTION_JOURNEY_ENABLED=false
SUBSCRIPTION_JOURNEY_WORKER_ENABLED=false
BILLING_AUTOMATION_WORKER_ENABLED=false
FIELD_VIDEO_UPLOAD_WORKER_ENABLED=false
STAGE2_HANDOVER_WORKER_ENABLED=false
MILEAGE_REVIEW_WORKER_ENABLED=false
```

静态核查依据（本手册编写时的目标源码）：

- `apps/api/src/app.module.ts` 导入 `BillingAutomationModule`、`HandoverWorkOrderModule`、`MileageReviewModule`、`SubscriptionChangeModule` 和 `SubscriptionJourneyModule`。
- `apps/api/src/subscription-journey/subscription-journey.worker.ts` 只在 `SubscriptionJourneyRuntimeConfig.workerEnabled` 为 true 时从 `onModuleInit()` 调度；该 getter 读取 `SUBSCRIPTION_JOURNEY_WORKER_ENABLED`。业务 enrollment 另由 `SUBSCRIPTION_JOURNEY_ENABLED` 关闭。
- `apps/api/src/billing-automation/billing-automation.worker.ts`、`apps/api/src/field-operator/field-video-upload.worker.ts`、`apps/api/src/handover-work-order/stage2-handover-workflow.worker.ts`、`apps/api/src/mileage-review/mileage-review.worker.ts` 均在 `onModuleInit()` 中先检查各自明确的 `*_WORKER_ENABLED`，只有精确值 `true` 才调度。
- 对应 worker 由 `billing-automation.module.ts`、`handover-work-order.module.ts` 和 `mileage-review.module.ts` 注册；因此必须显式传入上列 false，不能依赖缺省值。
- `apps/api/src/auto-debit/auto-debit.module.ts` 没有 bootstrap timer；`auto-debit.config.ts` 强制 `AUTO_DEBIT_ENABLED=false`、provider `disabled`、mock false。`AutoDebitScheduler` 只是被显式业务调用的 enqueue helper。
- `stage2-handover-workflow.service.ts` 的 `setInterval` 只在已进入 workflow operation 后做 lease heartbeat；`delivery-handover-evidence-artifact.service.ts` 的 timeout 只包围显式 media child process，二者都不是 bootstrap 定时入口。
- **缺口：**`apps/api/src/subscription-change/subscription-change.module.ts` 注册 `SubscriptionChangeWorker`；`apps/api/src/subscription-change/subscription-change.worker.ts` 的 `onModuleInit()` 无条件执行 `schedulePoll(0)`。`SUBSCRIPTION_EXTENSION_ENABLED=false` 只跳过 enrollment enqueue，仍会执行 `reconcileActiveChanges()` 和 `claimDue()`。当前没有显式 worker off flag，也没有独立的无 worker bootstrap module。

因此，不得把不存在的 `SUBSCRIPTION_CHANGE_WORKER_ENABLED` 当作 flag，也不得以人工口头批准绕过。当前证据无法证明 candidate 不执行写入型定时任务：

```bash
printf '%s\n' 'STOP: CANDIDATE_API_TIMER_ISOLATION_UNPROVEN'
exit 1
```

在一个另行批准的代码变更提供明确 off flag 或独立无 worker bootstrap、静态测试覆盖并更新本手册之前，**不得启动 candidate API**，不得创建 candidate acceptance 文件，也不得进入切换准备。

缺口修复后的新版手册仍必须要求 candidate：独立容器、loopback 备用端口、不接 Nginx、全部 worker/timer 静默；只验证 `/health`、admin/portal 既有 token、RBAC 菜单、产品/车辆列表以及空进件/订单列表。不提交进件、不锁车、不签合同、不触发短信、电子签或支付。既有 token 只能留在浏览器/秘密环境，不得进命令、日志或证据。

## 7. API 数据库 URL 单字段切换批准与执行

本节在当前源码状态不可到达。未来修订版必须先产生 root-owned、`0600` 的 `$EVIDENCE_DIR/candidate-api.accepted`，内容只能是 candidate health/RBAC/list/count 和静默 worker 证明；没有该文件立即停止：

```bash
test -f "$EVIDENCE_DIR/candidate-api.accepted" \
  || { printf '%s\n' 'STOP: CANDIDATE_ACCEPTANCE_MISSING'; exit 1; }
test "$(stat -c '%u:%a' "$EVIDENCE_DIR/candidate-api.accepted")" = '0:600'
```

先对 `.env.staging.images` 做 root-only 备份并生成 SHA-256；不得显示内容：

```bash
readonly ENV_BACKUP="$EVIDENCE_DIR/.env.staging.images.pre-switch"
readonly ENV_TEMP="${ENV_FILE}.stage1-clean-acceptance-${RUN_UTC}.tmp"
cp --preserve=mode,ownership,timestamps "$ENV_FILE" "$ENV_BACKUP"
chmod 0600 "$ENV_BACKUP"
test "$(stat -c '%u:%a' "$ENV_BACKUP")" = '0:600'
sha256sum "$ENV_BACKUP" \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/env.pre-switch.sha256"
test ! -e "$ENV_TEMP"

psql "$STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL" -XAtq \
  -c "SELECT current_database(), current_schema(), count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), count(*) FILTER (WHERE rolled_back_at IS NOT NULL) FROM _prisma_migrations GROUP BY current_database(), current_schema()" \
  | sha256sum | awk '{print $1}' \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/old-database.fingerprint.sha256"
```

以下受控脚本解析恰好一个 `DATABASE_URL`，只替换 DATABASE_URL 的 pathname 为目标 database name，并断言保留 protocol/host/port/user/password/query。它把完整环境写入同目录临时文件、`chmod 600`，无 stdout；不在参数、报告或日志中暴露 URL：

```bash
ENV_FILE="$ENV_FILE" ENV_TEMP="$ENV_TEMP" TARGET_DB="$TARGET_DB" node <<'NODE'
const fs = require("node:fs");
const sourcePath = process.env.ENV_FILE;
const tempPath = process.env.ENV_TEMP;
const targetDb = process.env.TARGET_DB;
const text = fs.readFileSync(sourcePath, "utf8");
const newline = text.includes("\r\n") ? "\r\n" : "\n";
const lines = text.split(/\r?\n/);
const indexes = lines.flatMap((line, index) => /^DATABASE_URL=/.test(line) ? [index] : []);
if (indexes.length !== 1) process.exit(31);
const index = indexes[0];
const encoded = lines[index].slice("DATABASE_URL=".length);
const quote = encoded.startsWith('"') && encoded.endsWith('"') ? '"'
  : encoded.startsWith("'") && encoded.endsWith("'") ? "'" : "";
const raw = quote ? encoded.slice(1, -1) : encoded;
const before = new URL(raw);
const after = new URL(raw);
after.pathname = `/${targetDb}`;
for (const key of ["protocol", "hostname", "port", "username", "password", "search", "hash"]) {
  if (before[key] !== after[key]) process.exit(32);
}
lines[index] = `DATABASE_URL=${quote}${after.toString()}${quote}`;
const fd = fs.openSync(tempPath, "wx", 0o600);
try {
  fs.writeFileSync(fd, lines.join(newline), "utf8");
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
fs.chmodSync(tempPath, 0o600);
NODE
test "$(stat -c '%u:%a' "$ENV_TEMP")" = '0:600'
```

该临时文件还没有影响在线 API。此时记录固定证据路径、备份 hash、目标 Git/image 身份和 candidate 安全计数，不记录 URL。

**STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL**

等待与 baseline apply 分离的明确切换批准；没有批准不得 rename、不得 recreate。

收到批准后才执行原子 rename，并只重建 API service。不得重建 postgres/web，不得修改或 reload Nginx：

```bash
mv -f -- "$ENV_TEMP" "$ENV_FILE"
sync -f "$(dirname "$ENV_FILE")"

if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api \
  >/dev/null 2>&1; then
  printf '%s\n' 'api_recreate=complete' \
    | install -m 0600 /dev/stdin "$EVIDENCE_DIR/api-switch.state"
else
  printf '%s\n' 'STOP: API_RECREATE_FAILED; START ROLLBACK'
  exit 1
fi
```

## 8. 切换后门禁与浏览器验收

只验证公共 health 的状态码，不显示 body、headers 或 URL；随后等待并覆盖连续两个 billing maintenance cycle（源码间隔 60 秒，使用 130 秒观察窗）：

```bash
readonly SWITCHED_API_CONTAINER_ID="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q api)"
test -n "$SWITCHED_API_CONTAINER_ID"
test "$(docker inspect --format '{{.State.Running}}' "$SWITCHED_API_CONTAINER_ID")" = 'true'
test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$SWITCHED_API_CONTAINER_ID")" = 'healthy'
readonly HEALTH_CODE="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3101/api/health)"
test "$HEALTH_CODE" = '200'
readonly LOG_GATE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sleep 130
```

日志门禁只计数固定错误/成功状态，不落原始日志：

```bash
readonly BILLING_ERROR_COUNT="$(docker logs --since "$LOG_GATE_STARTED_AT" "$SWITCHED_API_CONTAINER_ID" 2>&1 \
  | grep -Ec 'BILLING_AUTOMATION_POLL|BILLING_CONFIGURATION_ERROR|BILLING_EXECUTION_ERROR' || true)"
test "$BILLING_ERROR_COUNT" -eq 0
{
  printf 'billing_cycles_observed=2\n'
  printf 'billing_error_count=%s\n' "$BILLING_ERROR_COUNT"
  printf 'health_code=%s\n' "$HEALTH_CODE"
} | install -m 0600 /dev/stdin "$EVIDENCE_DIR/post-switch-gates.state"
```

浏览器验收必须由已有登录会话完成，不把 token 复制到 shell：

1. 公共 `/health` 正常；admin 与 portal 既有 token 仍有效。
2. RBAC 菜单与权限边界符合已批准角色。
3. 产品与所选车辆列表可读；进件与订单列表为空。
4. 不提交进件、不锁车、不签合同、不发送短信、不触发电子签或支付。
5. 验收证据只记页面状态、计数和 hash，不截图/记录客户或车辆身份、token、URL query。

任一 health、日志门禁、两个连续 maintenance cycle 或浏览器验收失败，立即执行回滚。

## 9. 回滚

回滚只恢复旧 env 并只重建 API。保留新库与证据；不 DROP、不合并回旧库，也不对旧库 repair：

```bash
readonly ENV_ROLLBACK_TEMP="${ENV_FILE}.rollback-${RUN_UTC}.tmp"
test ! -e "$ENV_ROLLBACK_TEMP"
cp --preserve=mode,ownership,timestamps "$ENV_BACKUP" "$ENV_ROLLBACK_TEMP"
chmod 0600 "$ENV_ROLLBACK_TEMP"
test "$(stat -c '%u:%a' "$ENV_ROLLBACK_TEMP")" = '0:600'
mv -f -- "$ENV_ROLLBACK_TEMP" "$ENV_FILE"
sync -f "$(dirname "$ENV_FILE")"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api \
  >/dev/null 2>&1
readonly ROLLED_BACK_API_CONTAINER_ID="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q api)"
test -n "$ROLLED_BACK_API_CONTAINER_ID"
test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$ROLLED_BACK_API_CONTAINER_ID")" = 'healthy'
test "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3101/api/health)" = '200'
```

旧库指纹只由数据库名、schema 与 migration 安全计数生成 hash，不输出这些原始值。应在切换前把同一查询 hash 保存为 `$EVIDENCE_DIR/old-database.fingerprint.sha256`，回滚后复算并逐字节比较：

```bash
psql "$STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL" -XAtq \
  -c "SELECT current_database(), current_schema(), count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), count(*) FILTER (WHERE rolled_back_at IS NOT NULL) FROM _prisma_migrations GROUP BY current_database(), current_schema()" \
  | sha256sum | awk '{print $1}' \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/old-database.rollback.fingerprint.sha256"
cmp --silent "$EVIDENCE_DIR/old-database.fingerprint.sha256" "$EVIDENCE_DIR/old-database.rollback.fingerprint.sha256"
printf '%s\n' 'rollback_state=old_env_restored_api_only_new_database_preserved' \
  | install -m 0600 /dev/stdin "$EVIDENCE_DIR/rollback.state"
```

## 10. 关闭窗口

- 核对证据目录仍为 `0700`、所有文件为 `0600` 且 root 所有。
- 报告只引用固定证据路径、hash、计数、稳定状态与 Git/image identity；不得粘贴原始日志、URL、env、token 或客户/车辆身份。
- 成功窗口保留旧库 pre-apply backup、空新库 pre-migration backup、manifest、apply/replay/validator 和 env backup。
- 回滚窗口额外保留新库与全部证据，交由后续另行批准的调查处理；不得删除新库。
- 无论成功或回滚，都不在在线 API 容器执行任何 `pnpm`、Prisma 或临时诊断命令。
