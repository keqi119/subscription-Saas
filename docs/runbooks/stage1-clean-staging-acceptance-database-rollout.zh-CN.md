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
readonly EVIDENCE_PARENT="/opt/subscription-saas/reports"
readonly EVIDENCE_DIR="/opt/subscription-saas/reports/stage1-clean-acceptance-${RUN_UTC}"
readonly TARGET_DB="subscription_saas_staging_acceptance_${RUN_UTC,,}"
```

以下证据 helper 是后续 cutover 实际复用的固定实现；测试抽取并执行这一原始 fence，不允许从环境选择替代函数：

<!-- STAGE1_EVIDENCE_HELPERS_EXECUTABLE_BEGIN -->

```bash

assert_private_directory() {
  local path="$1"
  test -d "$path" || return 1
  test ! -L "$path" || return 1
  test "$(stat -c '%u:%g:%a' "$path")" = '0:0:700' || return 1
}

assert_new_evidence_path() {
  local path="$1"
  test ! -e "$path" || return 1
  test ! -L "$path" || return 1
}

assert_private_file() {
  local path="$1"
  test -f "$path" || return 1
  test ! -L "$path" || return 1
  test "$(stat -c '%u:%g:%a' "$path")" = '0:0:600' || return 1
}

publish_private_evidence() {
  local target="$1"
  local temporary
  assert_new_evidence_path "$target"
  temporary="$(mktemp --tmpdir="$EVIDENCE_DIR" '.evidence.XXXXXX')"
  if ! cat >"$temporary"; then rm -f -- "$temporary"; return 1; fi
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  if ! ln -- "$temporary" "$target"; then rm -f -- "$temporary"; return 1; fi
  rm -f -- "$temporary"
  assert_private_file "$target"
}
```

<!-- STAGE1_EVIDENCE_HELPERS_EXECUTABLE_END -->

创建当次全新证据目录；目标已存在或为符号链接时失败关闭：

```bash

assert_private_directory "$EVIDENCE_PARENT"
test ! -e "$EVIDENCE_DIR"
test ! -L "$EVIDENCE_DIR"
install -d -o root -g root -m 0700 "$EVIDENCE_DIR"
assert_private_directory "$EVIDENCE_DIR"
printf '%s\n' 'uid=0 gid=0 mode=0700' | publish_private_evidence "$EVIDENCE_DIR/directory-security.state"
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
  | publish_private_evidence "$EVIDENCE_DIR/compose-ps.safe.json"

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
: "${STAGE1_ACCEPTANCE_PUBLIC_API_HEALTH_URL:?approved public API health URL is required}"
: "${STAGE1_ACCEPTANCE_PUBLIC_ADMIN_HEALTH_URL:?approved public Admin health URL is required}"
: "${STAGE1_ACCEPTANCE_PUBLIC_PORTAL_HEALTH_URL:?approved public Portal health URL is required}"

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
  | publish_private_evidence "$EVIDENCE_DIR/disk-counts.txt"
docker stats --no-stream --format '{{.MemUsage}}' "$API_CONTAINER_ID" \
  | publish_private_evidence "$EVIDENCE_DIR/api-memory.txt"
psql "$STAGE1_ACCEPTANCE_ADMIN_DATABASE_URL" -XAtq \
  -c 'SELECT count(*) FROM pg_stat_activity' \
  | publish_private_evidence "$EVIDENCE_DIR/database-connection-count.txt"

{
  printf 'git_sha=%s\n' "$RELEASE_SHA"
  printf 'image_ref=%s\n' "$API_IMAGE_REF"
  printf 'api_state=running\napi_health=healthy\n'
  printf 'evidence_dir=%s\n' "$EVIDENCE_DIR"
} | publish_private_evidence "$EVIDENCE_DIR/preflight.safe.env"
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

backup_database() {
  local database_url="$1"
  local backup_path="$2"
  local evidence_stem="$3"
  local backup_started_at_utc backup_completed_at_utc backup_size_bytes
  assert_new_evidence_path "$backup_path"
  assert_new_evidence_path "$EVIDENCE_DIR/${evidence_stem}.sha256"
  assert_new_evidence_path "$EVIDENCE_DIR/${evidence_stem}.metadata"
  backup_started_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ( set -o noclobber; pg_dump "$database_url" --format=custom >"$backup_path" )
  chown root:root "$backup_path"
  chmod 0600 "$backup_path"
  assert_private_file "$backup_path"
  backup_completed_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  backup_size_bytes="$(stat -c '%s' "$backup_path")"
  [[ "$backup_size_bytes" =~ ^[1-9][0-9]*$ ]]
  sha256sum "$backup_path" | publish_private_evidence "$EVIDENCE_DIR/${evidence_stem}.sha256"
  {
    printf 'backup_file_token=%s.dump\n' "$evidence_stem"
    printf 'backup_started_at_utc=%s\n' "$backup_started_at_utc"
    printf 'backup_completed_at_utc=%s\n' "$backup_completed_at_utc"
    printf 'backup_size_bytes=%s\n' "$backup_size_bytes"
    printf '%s\n' 'uid=0 gid=0 mode=0600'
  } | publish_private_evidence "$EVIDENCE_DIR/${evidence_stem}.metadata"
}

backup_database "$STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL" "$OLD_DB_BACKUP" 'old-database.pre-apply'
backup_database "$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" "$EMPTY_NEW_DB_BACKUP" 'empty-new-database.pre-migration'
```

以下四个 migration 检查均在目标 API 镜像的一次性容器内运行；不得进入在线 API 容器。目标 API 镜像只运行一次 migration deploy。所有原始输出被抑制或解析为安全计数，任意非零立即停止：

```bash
if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL \
  --env DATABASE_URL="$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" api \
  sh -lc 'cd /app/apps/api && pnpm exec prisma migrate deploy --schema prisma/schema.prisma' \
  >/dev/null 2>&1; then
  printf '%s\n' 'migration_deploy=applied_once' \
    | publish_private_evidence "$EVIDENCE_DIR/migration-deploy.state"
else
  printf '%s\n' 'STOP: MIGRATION_DEPLOY_FAILED'
  exit 1
fi

if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --env DATABASE_URL="$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" api \
  sh -lc 'cd /app/apps/api && pnpm exec prisma migrate status --schema prisma/schema.prisma' \
  >/dev/null 2>&1; then
  printf '%s\n' 'migrate_status=up_to_date' \
    | publish_private_evidence "$EVIDENCE_DIR/migrate-status.state"
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
  | publish_private_evidence "$EVIDENCE_DIR/migration-checksum.safe.json"
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
  | publish_private_evidence "$EVIDENCE_DIR/migration-diff.state"
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
  | publish_private_evidence "$EVIDENCE_DIR/migration-counts.state"
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
  | publish_private_evidence "$EVIDENCE_DIR/vehicle-discovery.safe.json"
unset DISCOVERY_SUMMARY
chmod 0600 "$EVIDENCE_DIR/vehicle-discovery.json"
assert_private_file "$EVIDENCE_DIR/vehicle-discovery.json"
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
assert_private_file "$DRY_RUN_REPORT"
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
  | publish_private_evidence "$EVIDENCE_DIR/baseline-approval.safe.json"
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
assert_private_file "$EVIDENCE_DIR/baseline-apply.json"

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
jq -e '.safe == true and .mode == "replay" and .manifestSha256 == $sha and .auditCreated == 0 and .inserted == 0 and .updated == 0 and .deleted == 0' --arg sha "$MANIFEST_SHA" \
  <<<"$REPLAY_SUMMARY" >/dev/null
chmod 0600 "$EVIDENCE_DIR/baseline-replay.json"
assert_private_file "$EVIDENCE_DIR/baseline-replay.json"
jq -e '.auditCreated == 0 and .inserted == 0 and .updated == 0 and .deleted == 0' \
  "$EVIDENCE_DIR/baseline-replay.json" >/dev/null

readonly VALIDATOR_SUMMARY="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --user 0:0 --volume "$EVIDENCE_DIR:/evidence" \
  --env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL \
  --env STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME \
  --env MANIFEST_SHA api \
  sh -lc 'cd /app && node scripts/stage1-clean-acceptance-target-validator.mjs --approved-manifest /evidence/baseline-dry-run.json --approved-manifest-sha256 "$MANIFEST_SHA" --output /evidence/target-validator.json')"
jq -e '.safe == true and .mode == "target-validator" and .manifestSha256 == $sha' --arg sha "$MANIFEST_SHA" \
  <<<"$VALIDATOR_SUMMARY" >/dev/null
chmod 0600 "$EVIDENCE_DIR/target-validator.json"
assert_private_file "$EVIDENCE_DIR/target-validator.json"
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

另一个独立缺口来自 `apps/api/src/billing-automation/billing-automation.worker.ts`：`runMaintenanceIfDue()` 只在 blocked 时记录 `BILLING_SCHEDULE_RECONCILIATION_BLOCKED`，成功完成 reconciliation/enqueue 时没有 completed cycle ID 或 `blockedCount=0` 的机器可验证事实。等待 60 秒或 130 秒只能证明时间经过，不能证明一次 maintenance cycle 完成。因此在另行批准的治理观测能力提供两个不同的 completed cycle ID、每周期 `blockedCount=0`、禁止写域前后计数摘要一致之前，流程还有以下不可豁免停止：

```bash
printf '%s\n' 'STOP: BILLING_COMPLETED_CYCLE_EVIDENCE_UNAVAILABLE'
exit 1
```

该能力必须另行批准；不得为本手册修改 billing worker 或伪造观测结果。未来证据还必须在两个 completed cycle 前后证明禁止写域计数未变，并对完整观察窗执行 `ERROR|FATAL|Unhandled|PrismaClientKnownRequestError|HTTP 5` 与 PII 扫描。读取 Docker 日志失败必须关闭门禁（`DOCKER_LOG_READ_FAILED`），扫描通过才允许记录 `PII_LOG_SCAN_CLEAR`。

## 7. API 数据库 URL 单字段切换批准与执行

本节因上一节两个硬停止在当前源码状态不可到达。未来修订版必须先产生 root-owned、`0600` 的 `$EVIDENCE_DIR/candidate-api.accepted`，内容只能是 candidate health/RBAC/list/count 和静默 worker 证明；没有该文件立即停止：

```bash
test -f "$EVIDENCE_DIR/candidate-api.accepted" \
  || { printf '%s\n' 'STOP: CANDIDATE_ACCEPTANCE_MISSING'; exit 1; }
assert_private_file "$EVIDENCE_DIR/candidate-api.accepted"
```

先对 `.env.staging.images` 做 root-only、no-clobber 备份并生成 SHA-256；不得显示内容。切换前同时保存旧库安全指纹和 API 当前 restart count：

```bash
readonly ENV_BACKUP="$EVIDENCE_DIR/.env.staging.images.pre-switch"
readonly ENV_TEMP="${ENV_FILE}.stage1-clean-acceptance-${RUN_UTC}.tmp"
assert_new_evidence_path "$ENV_BACKUP"
assert_new_evidence_path "$EVIDENCE_DIR/env.pre-switch.sha256"
cp --no-clobber --preserve=mode,ownership,timestamps "$ENV_FILE" "$ENV_BACKUP"
chown root:root "$ENV_BACKUP"
chmod 0600 "$ENV_BACKUP"
assert_private_file "$ENV_BACKUP"
sha256sum "$ENV_BACKUP" | publish_private_evidence "$EVIDENCE_DIR/env.pre-switch.sha256"
assert_new_evidence_path "$ENV_TEMP"

psql "$STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL" -XAtq \
  -c "SELECT current_database(), current_schema(), count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), count(*) FILTER (WHERE rolled_back_at IS NOT NULL) FROM _prisma_migrations GROUP BY current_database(), current_schema()" \
  | sha256sum | awk '{print $1}' \
  | publish_private_evidence "$EVIDENCE_DIR/old-database.fingerprint.sha256"
readonly PRE_SWITCH_API_RESTART_COUNT="$(docker inspect --format '{{.RestartCount}}' "$API_CONTAINER_ID")"
[[ "$PRE_SWITCH_API_RESTART_COUNT" =~ ^[0-9]+$ ]]
printf 'pre_switch_restart_count=%s\n' "$PRE_SWITCH_API_RESTART_COUNT" \
  | publish_private_evidence "$EVIDENCE_DIR/pre-switch-restart-count.state"
```

以下脚本在固定目标镜像的一次性容器内调用已被单元测试覆盖的 `buildStage1AcceptanceDatabaseEnvSwitch`。它要求实际 env 的 before 与批准 source URL 全语义一致、after 与批准 target URL 全语义一致，且批准 pair 仅 pathname 不同并保留 protocol/host/port/user/password/query；错误 pathname/host/credential/query、引号或 percent encoding 均按 URL 语义处理。`ENV_DATABASE_URL_SOURCE_MISMATCH`、`APPROVED_DATABASE_URL_PAIR_INVALID` 等错误只作为稳定错误码，不输出 URL。完整环境写入同目录临时文件（必须是新文件）并 `chmod 600`：

<!-- STAGE1_ENV_TRANSFORM_EXECUTABLE_BEGIN -->

```bash
if ! docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps -T \
  --user 0:0 --volume '/opt/subscription-saas:/host' \
  --env RUN_UTC="$RUN_UTC" \
  --env STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL \
  --env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL api \
  sh -lc 'cd /app && node --input-type=module' >/dev/null 2>&1 <<'NODE'
import fs from "node:fs";
import { buildStage1AcceptanceDatabaseEnvSwitch } from "./scripts/stage1-clean-acceptance-cli-core.mjs";
const sourcePath = "/host/.env.staging.images";
const tempPath = `/host/.env.staging.images.stage1-clean-acceptance-${process.env.RUN_UTC}.tmp`;
const before = fs.readFileSync(sourcePath, "utf8");
const after = buildStage1AcceptanceDatabaseEnvSwitch(
  before,
  process.env.STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL,
  process.env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL
);
const fd = fs.openSync(tempPath, "wx", 0o600);
try { fs.writeFileSync(fd, after, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.chownSync(tempPath, 0, 0);
fs.chmodSync(tempPath, 0o600);
NODE
then
  printf '%s\n' 'STOP: ENV_DATABASE_URL_TRANSFORM_FAILED'
  exit 1
fi
assert_private_file "$ENV_TEMP"
```

<!-- STAGE1_ENV_TRANSFORM_EXECUTABLE_END -->

该临时文件还没有影响在线 API。此时记录固定证据路径、备份 hash、目标 Git/image 身份和 candidate 安全计数，不记录 URL。

**STOP FOR HUMAN APPROVAL: API_DATABASE_SWITCH_APPROVAL**

等待与 baseline apply 分离的明确切换批准；没有批准不得 rename、不得 recreate。

## 8. 切换、即时门禁与浏览器验收

收到批准后才执行原子 rename，并只重建 API service。不得重建 postgres/web，不得修改或 reload Nginx。下面是唯一完整 cutover executable fence；契约测试只抽取该 fence，以纯本地依赖注入验证失败回滚，不从 prose 或 shell comments 推断控制流。函数内重新运行 target validator、migration status/checksum/diff/count，检查新 API 没有 restart，精确验证六个 worker/journey flags 和四个 subscription-change flags，验证公共 API/Admin/Portal health，并消费另行批准的 billing completed-cycle 事实。所有 curl 丢弃 body/headers且不输出 URL：

<!-- STAGE1_CUTOVER_EXECUTABLE_BEGIN -->

```bash
cutover_api_recreate() {
  test "$1" = 'api' || return 1
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api \
    >/dev/null 2>&1
}

cutover_api_container_id() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q api
}

cutover_verify_public_health() {
  local container_id health_code
  container_id="$(cutover_api_container_id)" || return 1
  test -n "$container_id" || return 1
  test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")" = 'healthy' \
    || return 1
  health_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    "$STAGE1_ACCEPTANCE_PUBLIC_API_HEALTH_URL")" || return 1
  test "$health_code" = '200' || return 1
}

cutover_old_database_fingerprint() {
  psql "$STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL" -XAtq \
    -c "SELECT current_database(), current_schema(), count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), count(*) FILTER (WHERE rolled_back_at IS NOT NULL) FROM _prisma_migrations GROUP BY current_database(), current_schema()" \
    | sha256sum | awk '{print $1}'
}

cutover_secure_file() {
  chown root:root "$1" || return 1
  chmod 0600 "$1" || return 1
  assert_private_file "$1"
}

cutover_sync_directory() {
  sync -f "$1"
}

cutover_utc_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

cutover_nonce() {
  openssl rand -hex 32
}

rollback_api_database_switch() {
  local failed=0 rollback_temp
  local expected_old_fingerprint observed_old_fingerprint
  set +e

  if ! cmp --silent "$ENV_FILE" "$ENV_BACKUP" || ! assert_private_file "$ENV_FILE"; then
    rollback_temp="$(mktemp --tmpdir="$(dirname "$ENV_FILE")" '.env.staging.images.rollback.XXXXXX')" || failed=1
    if test "$failed" -eq 0; then
      cp --preserve=mode,ownership,timestamps "$ENV_BACKUP" "$rollback_temp" \
        && cutover_secure_file "$rollback_temp" \
        && test ! -L "$rollback_temp" \
        && mv -f -- "$rollback_temp" "$ENV_FILE" \
        && cutover_sync_directory "$(dirname "$ENV_FILE")" \
        || failed=1
    fi
  fi
  if ! cmp --silent "$ENV_FILE" "$ENV_BACKUP" || ! assert_private_file "$ENV_FILE"; then
    printf '%s\n' 'STOP: ROLLBACK_ENV_RESTORE_FAILED'
    failed=1
  fi

  if ! cutover_api_recreate api; then
    printf '%s\n' 'STOP: ROLLBACK_API_RECREATE_FAILED'
    failed=1
  fi
  if ! cutover_verify_public_health; then
    printf '%s\n' 'STOP: ROLLBACK_PUBLIC_HEALTH_FAILED'
    failed=1
  fi

  expected_old_fingerprint="$(awk 'NF {print $1; exit}' "$EVIDENCE_DIR/old-database.fingerprint.sha256")"
  observed_old_fingerprint="$(cutover_old_database_fingerprint)"
  if test -z "$expected_old_fingerprint" || test "$observed_old_fingerprint" != "$expected_old_fingerprint"; then
    printf '%s\n' 'STOP: ROLLBACK_OLD_DATABASE_FINGERPRINT_FAILED'
    failed=1
  fi
  if test "$failed" -ne 0; then
    printf '%s\n' 'STOP: ROLLBACK_FAILED'
    set -e
    return 1
  fi
  set -e
  return 0
}

rollback_and_stop() {
  local reason="$1"
  trap - ERR
  if rollback_api_database_switch; then
    printf 'STOP: %s; rollback_state=verified\n' "$reason"
  else
    printf 'STOP: %s; rollback_state=failed\n' "$reason"
  fi
  exit 1
}

rollback_after_switch_error() {
  local status="$?"
  if test "${SWITCH_ACTIVE:-0}" -eq 1; then
    rollback_and_stop 'POST_SWITCH_GATE_FAILED'
  fi
  exit "$status"
}

revalidate_switched_api_identity() {
  local requested_container_id="$1"
  local full_container_id switched_image_id switched_release_sha compose_image compose_image_id
  [[ "$requested_container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
  full_container_id="$(docker inspect --format '{{.Id}}' "$requested_container_id")" || return 1
  switched_image_id="$(docker inspect --format '{{.Image}}' "$requested_container_id")" || return 1
  switched_release_sha="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$requested_container_id")" \
    || return 1
  compose_image="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --format json \
    | jq -er '.services.api.image')" || return 1
  compose_image_id="$(docker image inspect --format '{{.Id}}' "$compose_image")" || return 1
  test "$full_container_id" = "$requested_container_id" || return 1
  test "$switched_image_id" = "$API_IMAGE_ID" || return 1
  test "$switched_release_sha" = "$RELEASE_SHA" || return 1
  test "$compose_image_id" = "$API_IMAGE_ID" || return 1
  SWITCHED_API_CONTAINER_ID="$full_container_id"
  SWITCHED_API_IMAGE_ID="$switched_image_id"
  SWITCHED_RELEASE_SHA="$switched_release_sha"
}

write_browser_acceptance_challenge() {
  local target="$1" nonce="$2" switched_container_id="$3" switched_image_id="$4"
  local switched_release_sha="$5" challenge_created_at_utc="$6"
  [[ "$RUN_UTC" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
  [[ "$MANIFEST_SHA" =~ ^[0-9a-f]{64}$ ]]
  [[ "$switched_release_sha" =~ ^[0-9a-f]{40}$ ]]
  [[ "$switched_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
  [[ "$switched_container_id" =~ ^[0-9a-f]{64}$ ]]
  [[ "$nonce" =~ ^[0-9a-f]{64}$ ]]
  [[ "$SWITCH_STARTED_AT_UTC" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
  [[ "$LOG_GATE_STARTED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
  [[ "$challenge_created_at_utc" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
  {
    printf '{"schemaVersion":1,"runUtc":"%s","manifestSha256":"%s",' "$RUN_UTC" "$MANIFEST_SHA"
    printf '"releaseSha":"%s","imageId":"%s","switchedContainerId":"%s",' \
      "$switched_release_sha" "$switched_image_id" "$switched_container_id"
    printf '"switchStartedAtUtc":"%s","logObservationStartedAtUtc":"%s",' \
      "$SWITCH_STARTED_AT_UTC" "$LOG_GATE_STARTED_AT"
    printf '"challengeCreatedAtUtc":"%s","nonce":"%s"}\n' "$challenge_created_at_utc" "$nonce"
  } | publish_private_evidence "$target"
}

validate_browser_acceptance_fact() {
  local fact_path="$1" challenge_path="$2" switch_started_at_utc="$3"
  local received_at_utc="$4" approved_timeout_seconds="$5"
  assert_private_file "$fact_path" || return 1
  assert_private_file "$challenge_path" || return 1
  node - "$fact_path" "$challenge_path" "$switch_started_at_utc" \
    "$received_at_utc" "$approved_timeout_seconds" >/dev/null 2>&1 <<'NODE'
const fs = require("node:fs");
const { isDeepStrictEqual } = require("node:util");
const [factPath, challengePath, switchedAt, receivedAtUtc, timeoutText] = process.argv.slice(2);
const fact = JSON.parse(fs.readFileSync(factPath, "utf8"));
const challenge = JSON.parse(fs.readFileSync(challengePath, "utf8"));
const completedAt = Date.parse(fact.completedAtUtc);
const switchedAtMillis = Date.parse(switchedAt);
const challengeCreatedAt = Date.parse(challenge.challengeCreatedAtUtc);
const receivedAt = Date.parse(receivedAtUtc);
const timeoutSeconds = Number(timeoutText);
const canonicalUtc = (value, millis) => Number.isFinite(millis) &&
  new Date(millis).toISOString().replace(".000Z", "Z") === value;
const domainKeys = ["applications", "billing", "contracts", "orders", "returns", "subscriptionChanges"];
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const allDomains = (value, predicate) => exactKeys(value, domainKeys) && domainKeys.every((key) => predicate(value[key]));
const safe =
  exactKeys(fact, ["auth", "businessWrites", "catalog", "challenge", "completedAtUtc", "console", "decision", "eSign", "emptyDomains", "entryPoints", "profile", "publicHealth", "rawEnumerations", "rbac", "schemaVersion", "visualReview"]) &&
  exactKeys(fact.publicHealth, ["admin", "api", "portal"]) &&
  exactKeys(fact.catalog, ["contractTemplates", "packages", "products", "vehicles"]) &&
  exactKeys(fact.console, ["errorCount", "warnCount"]) &&
  exactKeys(fact.visualReview, ["admin", "portal", "responsive"]) &&
  fact.schemaVersion === 1 && fact.decision === "accepted" &&
  isDeepStrictEqual(fact.challenge, challenge) &&
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(fact.completedAtUtc) &&
  Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 900 &&
  canonicalUtc(fact.completedAtUtc, completedAt) && canonicalUtc(switchedAt, switchedAtMillis) &&
  canonicalUtc(challenge.challengeCreatedAtUtc, challengeCreatedAt) &&
  canonicalUtc(receivedAtUtc, receivedAt) && challengeCreatedAt >= switchedAtMillis &&
  completedAt >= challengeCreatedAt && completedAt <= receivedAt &&
  completedAt <= challengeCreatedAt + timeoutSeconds * 1000 &&
  fact.publicHealth.api === 200 && fact.publicHealth.admin === 200 && fact.publicHealth.portal === 200 &&
  fact.auth === true && fact.rbac === true && fact.profile === true && fact.eSign === true &&
  Object.values(fact.catalog).every((value) => value === true) &&
  allDomains(fact.emptyDomains, (value) => value === 0) &&
  allDomains(fact.entryPoints, (value) => value === "absent") &&
  allDomains(fact.rawEnumerations, (value) => Array.isArray(value) && value.length === 0) &&
  fact.console.errorCount === 0 && fact.console.warnCount === 0 &&
  fact.visualReview.admin === true && fact.visualReview.portal === true &&
  fact.visualReview.responsive === true && fact.businessWrites === 0;
if (!safe) process.exit(1);
NODE
}

post_switch_database_gates() {
  local switched_api_container_id restart_count status_code checksum_result drift_exit migration_counts
  local billing_facts
  local -a log_pipeline_status
  switched_api_container_id="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q api)"
  test -n "$switched_api_container_id"
  test "$switched_api_container_id" = "$SWITCHED_API_CONTAINER_ID"
  test "$(docker inspect --format '{{.State.Running}}' "$switched_api_container_id")" = 'true'
  test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$switched_api_container_id")" = 'healthy'
  restart_count="$(docker inspect --format '{{.RestartCount}}' "$switched_api_container_id")"
  test "$restart_count" = '0'

  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
    --env DATABASE_URL="$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" api \
    sh -lc 'cd /app/apps/api && pnpm exec prisma migrate status --schema prisma/schema.prisma' \
    >/dev/null 2>&1
  checksum_result="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
    --env DATABASE_URL="$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" api \
    sh -lc 'cd /app && pnpm prisma:migrate:checksum:verify')"
  jq -e '.safe == true and .localMigrationCount == 124 and .appliedMigrationCount == 124 and (.duplicateAppliedNames|length)==0 and (.mismatchedNames|length)==0 and (.missingFromDatabase|length)==0 and (.missingLocally|length)==0' \
    <<<"$checksum_result" >/dev/null
  set +e
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
    --env DATABASE_URL="$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" api \
    sh -lc 'cd /app/apps/api && pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code' \
    >/dev/null 2>&1
  drift_exit="$?"
  set -e
  test "$drift_exit" -eq 0
  migration_counts="$(psql "$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" -XAtq <<'SQL'
WITH duplicate_names AS (
  SELECT migration_name FROM _prisma_migrations GROUP BY migration_name HAVING count(*) > 1
)
SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
  count(*) FILTER (WHERE rolled_back_at IS NOT NULL),
  count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL),
  (SELECT count(*) FROM duplicate_names)
FROM _prisma_migrations;
SQL
)"
  test "$migration_counts" = '124|0|0|0'
  printf '%s\n' '124 applied / 0 rolled-back / 0 pending / 0 failed / 0 duplicate' \
    | publish_private_evidence "$EVIDENCE_DIR/post-switch-migration-counts.state"

  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
    --user 0:0 --volume "$EVIDENCE_DIR:/evidence" \
    --env STAGE1_ACCEPTANCE_TARGET_DATABASE_URL \
    --env STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME \
    --env MANIFEST_SHA api \
    sh -lc 'cd /app && node scripts/stage1-clean-acceptance-target-validator.mjs --approved-manifest /evidence/baseline-dry-run.json --approved-manifest-sha256 "$MANIFEST_SHA" --output /evidence/target-validator.post-switch.json' \
    >/dev/null
  chown root:root "$EVIDENCE_DIR/target-validator.post-switch.json"
  chmod 0600 "$EVIDENCE_DIR/target-validator.post-switch.json"
  assert_private_file "$EVIDENCE_DIR/target-validator.post-switch.json"
  jq -e '.operation == "STAGE1_CLEAN_ACCEPTANCE_TARGET_VALIDATOR" and .result.safe == true and .result.manifestSha256 == $sha' \
    --arg sha "$MANIFEST_SHA" "$EVIDENCE_DIR/target-validator.post-switch.json" >/dev/null

  docker exec "$switched_api_container_id" node -e '
    const expected = {
      SUBSCRIPTION_JOURNEY_ENABLED: "true",
      SUBSCRIPTION_JOURNEY_WORKER_ENABLED: "true",
      BILLING_AUTOMATION_WORKER_ENABLED: "true",
      FIELD_VIDEO_UPLOAD_WORKER_ENABLED: "true",
      STAGE2_HANDOVER_WORKER_ENABLED: "true",
      MILEAGE_REVIEW_WORKER_ENABLED: "true",
      SUBSCRIPTION_EXTENSION_ENABLED: "true",
      SUBSCRIPTION_VEHICLE_SWAP_ENABLED: "true",
      SUBSCRIPTION_EARLY_TERMINATION_ENABLED: "true",
      SUBSCRIPTION_MANAGED_OTHER_ENABLED: "true"
    };
    if (Object.entries(expected).some(([key, value]) => process.env[key] !== value)) process.exit(1);
  '
  printf 'post_switch_restart_count=%s\nruntime_flags=verified\n' "$restart_count" \
    | publish_private_evidence "$EVIDENCE_DIR/post-switch-runtime.state"

  for health_url_name in STAGE1_ACCEPTANCE_PUBLIC_API_HEALTH_URL STAGE1_ACCEPTANCE_PUBLIC_ADMIN_HEALTH_URL STAGE1_ACCEPTANCE_PUBLIC_PORTAL_HEALTH_URL; do
    status_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${!health_url_name}")"
    test "$status_code" = '200'
  done
  printf '%s\n' 'PUBLIC_API_HEALTH=200 PUBLIC_ADMIN_HEALTH=200 PUBLIC_PORTAL_HEALTH=200' \
    | publish_private_evidence "$EVIDENCE_DIR/public-health.state"

  billing_facts="$EVIDENCE_DIR/billing-completed-cycles.json"
  assert_private_file "$billing_facts"
  jq -e '
    .schemaVersion == 1 and
    (.cycles | length) == 2 and
    .cycles[0].completedCycleId != .cycles[1].completedCycleId and
    ([.cycles[].state] | all(. == "completed")) and
    ([.cycles[].blockedCount] | all(. == 0)) and
    .forbiddenDomainCountsBeforeSha256 == .forbiddenDomainCountsAfterSha256
  ' "$billing_facts" >/dev/null
  printf '%s\n' 'billing_completed_cycles=2 blockedCount=0 禁止写域前后计数摘要一致' \
    | publish_private_evidence "$EVIDENCE_DIR/billing-cycle-gate.state"

  set +e
  docker logs --since "$LOG_GATE_STARTED_AT" "$switched_api_container_id" 2>&1 \
    | awk '
      tolower($0) ~ /(error|fatal|unhandled|prismaclient|http 5[0-9][0-9]|status(code)?["=: ]+5[0-9][0-9])/ { unsafe_error=1 }
      tolower($0) ~ /(authorization|cookie|bearer[[:space:]]|token|password|postgres(ql)?:\/\/|customer(id|name)|vehicle(id|vin)|e-?mail)/ { pii=1 }
      /1[3-9][0-9]{9}/ { pii=1 }
      END { if (unsafe_error) exit 41; if (pii) exit 42 }
    ' >/dev/null
  log_pipeline_status=("${PIPESTATUS[@]}")
  set -e
  if test "${log_pipeline_status[0]}" -ne 0; then
    printf '%s\n' 'STOP: DOCKER_LOG_READ_FAILED'
    return 1
  fi
  if test "${log_pipeline_status[1]}" -eq 41; then
    printf '%s\n' 'STOP: POST_SWITCH_ERROR_LOG_SCAN_FAILED'
    return 1
  fi
  if test "${log_pipeline_status[1]}" -eq 42; then
    printf '%s\n' 'STOP: POST_SWITCH_PII_LOG_SCAN_FAILED'
    return 1
  fi
  test "${log_pipeline_status[1]}" -eq 0
  printf '%s\n' 'PII_LOG_SCAN_CLEAR errors=0 http_5xx=0 prisma_errors=0' \
    | publish_private_evidence "$EVIDENCE_DIR/log-scan.state"
}

set -E
trap 'rollback_after_switch_error' ERR
SWITCH_ACTIVE=1
export SWITCH_ACTIVE
readonly LOG_GATE_STARTED_AT="$(cutover_utc_now)"
readonly SWITCH_STARTED_AT_UTC="$(cutover_utc_now)"
mv -f -- "$ENV_TEMP" "$ENV_FILE"
cutover_sync_directory "$(dirname "$ENV_FILE")"

if ! cutover_api_recreate api; then rollback_and_stop 'API_RECREATE_FAILED'; fi

SWITCHED_API_CONTAINER_ID="$(cutover_api_container_id)"
[[ "$SWITCHED_API_CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] \
  || rollback_and_stop 'SWITCHED_API_CONTAINER_ID_INVALID'
if ! revalidate_switched_api_identity "$SWITCHED_API_CONTAINER_ID"; then
  rollback_and_stop 'SWITCHED_API_IDENTITY_MISMATCH'
fi
readonly SWITCHED_API_CONTAINER_ID SWITCHED_API_IMAGE_ID SWITCHED_RELEASE_SHA
readonly BROWSER_CHALLENGE_PATH="$EVIDENCE_DIR/browser-acceptance.challenge.json"
readonly BROWSER_FACT_PATH="$EVIDENCE_DIR/browser-acceptance.fact.json"
assert_new_evidence_path "$BROWSER_CHALLENGE_PATH"
assert_new_evidence_path "$BROWSER_FACT_PATH"
readonly BROWSER_CHALLENGE_NONCE="$(cutover_nonce)"
readonly BROWSER_CHALLENGE_CREATED_AT_UTC="$(cutover_utc_now)"
write_browser_acceptance_challenge \
  "$BROWSER_CHALLENGE_PATH" \
  "$BROWSER_CHALLENGE_NONCE" \
  "$SWITCHED_API_CONTAINER_ID" \
  "$SWITCHED_API_IMAGE_ID" \
  "$SWITCHED_RELEASE_SHA" \
  "$BROWSER_CHALLENGE_CREATED_AT_UTC"
assert_private_file "$BROWSER_CHALLENGE_PATH"

post_switch_database_gates

readonly BROWSER_ACCEPTANCE_TIMEOUT_RAW="${BROWSER_ACCEPTANCE_TIMEOUT_SECONDS:-900}"
if ! [[ "$BROWSER_ACCEPTANCE_TIMEOUT_RAW" =~ ^[1-9][0-9]{0,2}$ ]]; then
  rollback_and_stop 'BROWSER_ACCEPTANCE_TIMEOUT_INVALID'
fi
BROWSER_ACCEPTANCE_TIMEOUT_SECONDS="$((10#$BROWSER_ACCEPTANCE_TIMEOUT_RAW))"
readonly BROWSER_ACCEPTANCE_TIMEOUT_SECONDS
if (( BROWSER_ACCEPTANCE_TIMEOUT_SECONDS > 900 )); then
  rollback_and_stop 'BROWSER_ACCEPTANCE_TIMEOUT_INVALID'
fi
printf 'browser_acceptance_challenge=%s timeout_seconds=%s\n' \
  "$BROWSER_CHALLENGE_PATH" "$BROWSER_ACCEPTANCE_TIMEOUT_SECONDS"
if ! IFS= read -r -s -t "$BROWSER_ACCEPTANCE_TIMEOUT_SECONDS" BROWSER_ACCEPTANCE_PAYLOAD; then
  rollback_and_stop 'BROWSER_ACCEPTANCE_TIMEOUT'
fi
printf '\n'
if test "$BROWSER_ACCEPTANCE_PAYLOAD" = 'REJECT'; then
  unset BROWSER_ACCEPTANCE_PAYLOAD
  rollback_and_stop 'BROWSER_ACCEPTANCE_REJECTED'
fi
readonly BROWSER_ACCEPTANCE_RECEIVED_AT_UTC="$(cutover_utc_now)"
printf '%s\n' "$BROWSER_ACCEPTANCE_PAYLOAD" \
  | publish_private_evidence "$BROWSER_FACT_PATH"
unset BROWSER_ACCEPTANCE_PAYLOAD
if ! validate_browser_acceptance_fact \
  "$BROWSER_FACT_PATH" "$BROWSER_CHALLENGE_PATH" "$SWITCH_STARTED_AT_UTC" \
  "$BROWSER_ACCEPTANCE_RECEIVED_AT_UTC" "$BROWSER_ACCEPTANCE_TIMEOUT_SECONDS"; then
  rollback_and_stop 'BROWSER_ACCEPTANCE_FACT_INVALID'
fi
printf '%s\n' 'READ_ONLY_AUTH_RBAC_PROFILE_CATALOG_EMPTY_DOMAINS=verified browser_challenge=matched' \
  | publish_private_evidence "$EVIDENCE_DIR/read-only-browser.state"

SWITCH_ACTIVE=0
export SWITCH_ACTIVE
trap - ERR
printf '%s\n' 'api_switch=verified' | publish_private_evidence "$EVIDENCE_DIR/api-switch.state"
```

<!-- STAGE1_CUTOVER_EXECUTABLE_END -->

浏览器验收必须由已有登录会话在上述隐藏输入的有界等待期间完成，不把 token 复制到 shell。API recreate 后先从 compose 结果取得切换后 container ID，再由该 ID 重新读取完整 `.Id`、`.Image` 与 revision label，并重新解析固定 compose 的 API image；完整 `.Id` 必须等于 compose 返回值，`.Image`、revision 和 compose image ID 必须分别精确匹配已批准的 image/release 身份，否则在 trap 内回滚。challenge 只能由本次复核后的 switched container/image/release 事实、`RUN_UTC`、manifest SHA、switch/log observation UTC 与随机 nonce 以 create-once 方式生成；fact 目标在 challenge 创建前必须不存在。预置或旧 JSON 无法匹配本次 nonce/container/time，且主 shell 只会把本次隐藏输入通过 no-clobber publisher 写成 root/`0600` fact。

浏览器执行者必须逐项验证公共 API/Admin/Portal、既有 auth、RBAC、profile/e-sign、产品/车辆/套餐/合同模板 catalog、application/order/contract/billing/subscription-change/return 全部空域；同时保存这些空域入口 absent、原始枚举为空、console error/warn 均为 0，以及 Admin/Portal/响应式视觉复验。fact 只能含 challenge、安全布尔值/计数、完成 UTC 和稳定状态，不得含截图、URL/query、token 或客户/车辆身份。timeout 只接受整数 `1..900`；fact 完成 UTC 不得早于 challenge 创建 UTC，不得晚于主 shell 收到 payload 后生成的受信任 UTC，也不得晚于 challenge 创建 UTC 加批准 timeout。输入 `REJECT`、事实校验失败或最多 900 秒无输入都会在 `SWITCH_ACTIVE=1` 且 ERR trap 有效时实际调用 `rollback_and_stop`；仅全部通过后才清除 trap。

不提交进件、不锁车、不签合同、不发送短信、不触发电子签或支付。

连续两个 billing maintenance cycle 必须各有不同的 completed cycle ID，且来自另行批准的机器事实，不得由 elapsed time 推断。任一 health、migration/validator、restart/flag、完整日志门禁、周期、禁止写域计数或浏览器只读验收失败，都会由上面的显式分支或 ERR trap 调用回滚。

## 9. 回滚

回滚函数在 rename 前定义并可幂等重入：它恢复旧 env；若 env 已与备份相同则不重复替换，但仍重新验证 env、API-only recreate、公共 health 和旧库指纹。它保留新库与证据；不 DROP、不合并回旧库，也不对旧库 repair。任一 rollback 子步骤失败会保留对应稳定 STOP 和总括 `ROLLBACK_FAILED`，不得把仅打印“开始回滚”视为成功。

## 10. 关闭窗口

- 核对证据目录仍为 `0700`、所有普通证据文件为 `0600` 且 root 所有；拒绝符号链接、子目录和其他 owner/mode。扫描失败硬停止：

```bash
if ! assert_private_directory "$EVIDENCE_DIR" \
  || find "$EVIDENCE_DIR" -mindepth 1 ! -type f -print -quit | grep -q '^'; then
  printf '%s\n' 'STOP: EVIDENCE_PERMISSION_SCAN_FAILED'
  exit 1
fi
while IFS= read -r -d '' evidence_file; do
  if ! assert_private_file "$evidence_file"; then
    printf '%s\n' 'STOP: EVIDENCE_PERMISSION_SCAN_FAILED'
    exit 1
  fi
done < <(find "$EVIDENCE_DIR" -mindepth 1 -maxdepth 1 -type f -print0)
```

- 报告只引用固定证据路径、hash、计数、稳定状态与 Git/image identity；不得粘贴原始日志、URL、env、token 或客户/车辆身份。
- 成功窗口保留旧库 pre-apply backup、空新库 pre-migration backup、manifest、apply/replay/validator 和 env backup。
- 回滚窗口额外保留新库与全部证据，交由后续另行批准的调查处理；不得删除新库。
- 无论成功或回滚，都不在在线 API 容器执行任何 `pnpm`、Prisma 或临时诊断命令。
