# Stage 1 在租期合同变更发布运行手册

本手册用于发布续期、换车、提前结束和其他受管变更四类能力，并修复既有 ACTIVE
订单缺失的上游权威事实。所有命令均在目标 API 容器内执行；报告和备份必须落在持久化、受控目录。

代码、PR、合并或镜像发布批准均不等同于任何业务数据 `apply` 批准。下述三个数据写入步骤
（源事实、BASE 分段、Stage 1C 车辆期间）必须分别取得人工明确批准。

## 1. 统一停止规则

- 任一命令退出码为 `1` 或 `2`，立即停止发布。
- 任一报告存在 exception、blocker、overlap、segment omission、invariant violation 或候选数异常，立即停止。
- apply 后 replay 仍产生新增写入或审计数量不匹配，立即停止。
- 不允许推断或手工编造合同、日期、交付、Lease、车辆期间或商业条款。
- 未取得当前步骤的独立 apply 批准，不得执行后续写命令。

以下示例假设服务器发布目录已定义实际 compose 文件；执行前按服务器路径设置：

```bash
export COMPOSE_FILE=/opt/subscription-saas/docker-compose.staging.images.yml
export ENV_FILE=/opt/subscription-saas/.env.staging.images
export REPORT_DIR=/opt/subscription-saas/reports/stage1-active-source-facts-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$REPORT_DIR"
```

## 2. 迁移与校验和门槛

先确认目标 API/Web 镜像标识、数据库主机和数据库名；证据中不得记录密码或完整连接串。

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api pnpm prisma:migrate:status
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api pnpm prisma:migrate:checksum:verify
```

必须同时满足：数据库 schema 已是最新状态、迁移数量符合发布预期、所有已应用迁移校验和一致。
任何 pending、failed、diverged 或 checksum mismatch 均停止。

## 3. 新鲜备份门槛

在第一个 apply 前创建当前数据库的新鲜自包含备份，并单独记录 SHA-256。已有历史备份不能替代
当前状态备份；如果 dry-run 后数据库事实发生变化，必须重新备份。

```bash
export BACKUP_FILE=/opt/subscription-saas/backups/pre-stage1-active-source-facts-$(date -u +%Y%m%dT%H%M%SZ).dump
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T db \
  sh -lc 'pg_dump --format=custom --no-owner --no-privileges --username="$POSTGRES_USER" "$POSTGRES_DB"' \
  > "$BACKUP_FILE"
sha256sum "$BACKUP_FILE" | tee "${BACKUP_FILE}.sha256"
test -s "$BACKUP_FILE"
```

若目标 compose 的数据库服务名不是 `db`，只替换服务名，不改变备份格式与校验要求。

## 4. 源事实修复：dry-run、独立批准、apply、replay

### 4.1 dry-run（零写入）

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api \
  node scripts/stage1-active-source-facts-repair.mjs --dry-run \
  > "$REPORT_DIR/01-source-facts-dry-run.json"
```

逐项核对候选动作 `ARCHIVE_CONTRACT`、`BIND_CONTRACT`、`SET_ORDER_DATES`、证据摘要和数量。
报告必须零异常，且不得出现对象存储原始 key、数据库连接串或客户敏感字段。此处停止，取得“源事实
apply”独立人工批准。

### 4.2 apply 与 replay

仅在批准后执行：

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_APPLY=1 api \
  node scripts/stage1-active-source-facts-repair.mjs --apply \
  > "$REPORT_DIR/02-source-facts-apply.json"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api \
  node scripts/stage1-active-source-facts-repair.mjs --dry-run \
  > "$REPORT_DIR/03-source-facts-replay.json"
```

replay 必须 `candidates=0`、`exceptions=0`，且全部目标订单为 `unchanged`；合同和订单审计数量必须
分别等于实际发生变化的实体数量。

## 5. BASE 分段：dry-run、独立批准、apply、replay

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api \
  node scripts/subscription-segment-bootstrap.mjs --dry-run \
  > "$REPORT_DIR/04-base-segments-dry-run.json"
```

报告必须零异常，并与源事实候选订单一一对应。此处停止，取得“BASE 分段 apply”独立人工批准。
批准后执行：

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e SUBSCRIPTION_SEGMENT_BOOTSTRAP_APPLY=1 api \
  node scripts/subscription-segment-bootstrap.mjs --apply \
  > "$REPORT_DIR/05-base-segments-apply.json"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api \
  node scripts/subscription-segment-bootstrap.mjs --dry-run \
  > "$REPORT_DIR/06-base-segments-replay.json"
```

replay 必须零新增候选；每个实际创建的 BASE 分段必须有且仅有一条
`subscription_contract_segment` 创建审计。

## 6. Stage 1C 车辆期间：dry-run、独立批准、apply、replay

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api \
  node scripts/stage1c-period-backfill.mjs --dry-run \
  > "$REPORT_DIR/07-stage1c-periods-dry-run.json"
```

报告必须零 ambiguity、overlap、segment omission 和 invariant violation。此处停止，取得“Stage 1C
车辆期间 apply”独立人工批准。批准后执行：

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e STAGE1C_PERIOD_BACKFILL_APPLY=1 api \
  node scripts/stage1c-period-backfill.mjs --apply \
  > "$REPORT_DIR/08-stage1c-periods-apply.json"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api \
  node scripts/stage1c-period-backfill.mjs --dry-run \
  > "$REPORT_DIR/09-stage1c-periods-replay.json"
```

replay 必须零 `CREATE`、零冲突、零遗漏和零不变量异常。

## 7. 合同变更 bootstrap 与功能旗标门槛

完成前三组 replay 后只运行合同变更 bootstrap dry-run：

```bash
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api \
  node scripts/stage1-contract-change-bootstrap.mjs --dry-run \
  > "$REPORT_DIR/10-contract-change-bootstrap-dry-run.json"
```

必须零 blocker、零待创建基础事实。四个旗标必须在 Staging 显式设置为精确小写 `true`：

```text
SUBSCRIPTION_EXTENSION_ENABLED=true
SUBSCRIPTION_VEHICLE_SWAP_ENABLED=true
SUBSCRIPTION_EARLY_TERMINATION_ENABLED=true
SUBSCRIPTION_MANAGED_OTHER_ENABLED=true
SUBSCRIPTION_CHANGE_WORKER_ENABLED=true
```

五个开关缺失、空值、其他大小写或非布尔字符串均视为 fail-closed。`SUBSCRIPTION_CHANGE_WORKER_ENABLED`
是独立于四个业务功能开关的 worker runtime 开关；只有精确小写 `true` 才会轮询、协调、登记和认领
受支持的合同变更/关闭任务。将它设为 `false` 会暂停全部此类任务（不只是新建续期），且必须重启 API
后才生效。生产环境默认保持 `false`，除非另有正式发布批准。

## 8. 发布后观察与冒烟

1. 记录 API/Web 镜像不可变标识和健康检查结果。
2. 连续观察至少两个账单维护周期：允许出现按订单聚合的
   `BILLING_SCHEDULE_RECONCILIATION_BLOCKED` 警告，但不得再出现由单一缺失分段导致的整轮
   `BILLING_EXECUTION_ERROR`；健康订单必须正常入队。
3. 分别完成续期、换车、提前结束、其他受管变更的创建权限与最小业务冒烟。
4. 验证 Portal/Admin 入口、合同/报价、库存或回收状态、车辆期间、账单与审计事实可追溯到同一提交。
5. 所有报告、备份 SHA-256、迁移证据、旗标快照、日志观察和冒烟结果进入同一发布证据包。

任一冒烟失败或 blocker 数量不符合已审阅报告，停止人工验收并回滚应用镜像/关闭对应旗标；不得
删除合同变更、合同、车辆期间、账单任务或审计事实。
