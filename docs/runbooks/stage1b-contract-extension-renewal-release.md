# Stage 1B 合同延期/续订发布运行手册

## 安全边界

- 生产默认保持 `SUBSCRIPTION_EXTENSION_ENABLED=false` 和 `SUBSCRIPTION_CHANGE_WORKER_ENABLED=false`。
- 不修改历史 migration，不执行 `prisma migrate reset`，不删除已签合同、分段、报价、通知或审计记录。
- BASE 引导和续订补录只使用已存在的事实；缺失日期、归档主合同、套餐/报价快照时进入异常清单，禁止猜值。
- BASE 引导不创建考虑期、不发站内信或短信。续订补录只写考虑期、提醒和 outbox 任务，不直接调用短信供应商。
- 真实短信和真实电子签只在 staging 获得发布负责人授权后执行。

## 1. 备份与迁移

1. 记录当前镜像、Git SHA、数据库版本和开关值，完成 PostgreSQL 备份并验证备份可恢复。
2. 新库从空库应用全部 migration；存量库先在恢复副本执行下列命令，确认无 drift 和失败 migration：

   ```text
   pnpm prisma:migrate:status
   pnpm prisma:migrate:deploy
   pnpm prisma:migrate:status
   pnpm prisma:validate
   pnpm prisma:generate
   ```

   Before `migrate:deploy`, run this read-only preflight on the restored copy and the target database:

   ```sql
   SELECT
     contract_id,
     array_agg(id ORDER BY created_at) AS task_ids,
     array_agg(task_status ORDER BY created_at) AS task_statuses
   FROM contract_esign_task
   WHERE deleted_at IS NULL
     AND task_status IN ('CREATED', 'WAITING_CUSTOMER', 'SIGNING', 'COMPLETED')
   GROUP BY contract_id
   HAVING COUNT(*) > 1;
   ```

   The query must return zero rows. Do not auto-delete, soft-delete, or rewrite duplicate tasks. If rows are returned, stop the rollout; the release owner must reconcile provider evidence and callbacks, record the single authoritative winner, and cancel every loser through an approved audited repair procedure. If no such procedure exists, ship and verify that repair before retrying the unique-index migration.

3. 生产窗口执行同样的 `migrate:deploy`。迁移失败时停止发布并保留现场，不重置数据库。

## 2. 部署但保持功能关闭

1. 部署 API/Web 镜像，确认 `SUBSCRIPTION_EXTENSION_ENABLED=false` 和
   `SUBSCRIPTION_CHANGE_WORKER_ENABLED=false`。
2. 等待容器 readiness/health 全绿。
3. 从公网入口验证 API `/api/health`、后台登录、Portal 首页和静态资源；随后运行 `pnpm api:smoke`。

## 3. BASE 分段预检与应用

1. 只读预检：

   ```text
   pnpm subscription-segments:bootstrap:dry-run
   ```

2. 保存 JSON 报告。逐行处理 `BASE_SEGMENT_SOURCE_INCOMPLETE`；核对 `START_DATE`、`END_DATE`、`ARCHIVED_MAIN_CONTRACT`、`FINAL_PLAN_SNAPSHOT` 和 `QUOTE_SNAPSHOT`。不要人工补造事实。
3. 对报告中合格订单执行：

   ```text
   pnpm subscription-segments:bootstrap:apply
   pnpm subscription-segments:bootstrap:dry-run
   ```

4. 第二次预检应显示 `eligible=0`，已创建项进入 `existing`。脚本退出码 2 表示仍有需人工处理的异常行。

## 4. 续订补录与一致性巡检

1. 先只读运行：

   ```text
   pnpm subscription-renewals:reconcile
   ```

2. 核对重叠、断档、ACTIVE 数量和 SCHEDULED 合同/EXTENSION 分段异常均为 0。
3. 显式应用考虑期、提醒与 outbox 任务，再复跑只读巡检：

   ```text
   pnpm subscription-renewals:reconcile -- --apply
   pnpm subscription-renewals:reconcile
   ```

4. 迟加入 30 天窗口时，更早提醒必须为 `SKIPPED_LATE_ENROLLMENT`；只有当前最新适用提醒立即 PENDING，后续提醒仍按原计划执行。已到期或已有未来 EXTENSION 的订单不得补建旧续订机会。

## 5. 模板配置与验证

配置并验证五个短信模板代码：

```text
RENEWAL_REMINDER_D30_TEMPLATE_CODE
RENEWAL_REMINDER_D14_TEMPLATE_CODE
RENEWAL_REMINDER_D3_TEMPLATE_CODE
RENEWAL_EXPIRY_RETURN_TEMPLATE_CODE
RENEWAL_RETURN_OVERDUE_D1_TEMPLATE_CODE
```

五个模板都必须接受以下精确变量名：

```text
orderNo
plateNo
endDate
daysRemaining
portalPath
```

同时确认存在当前有效、状态为 ACTIVE、类型严格为 `SUBSCRIPTION_EXTENSION` 的合同版本。不得回退使用 `SUBSCRIPTION_STANDARD` 或 `DELIVERY_HANDOVER` 模板。模板缺失时短信必须记录 `FAILED/CONFIG_MISSING`，站内信可独立成功，业务事务不得回滚。

## 6. Staging 开关与 smoke

1. 仅在 staging 设置 `SUBSCRIPTION_EXTENSION_ENABLED=true` 和
   `SUBSCRIPTION_CHANGE_WORKER_ENABLED=true`，然后重启 API。后者是独立的 runtime 开关，只有精确小写
   `true` 才会轮询、协调、登记和认领受支持的合同变更/关闭任务。
2. 使用准备好的订单场景 JSON（可包含 `orderId`、`considerationId`、`changeId`、`contractId`）运行只读 smoke：

   ```text
   pnpm subscription-extension:smoke -- --scenario-file .tmp/scenarios/subscription-extension.json
   ```

3. 若需覆盖 Portal，设置短期 `PORTAL_CUSTOMER_COOKIE`；设置 `SUBSCRIPTION_EXTENSION_SMOKE_REQUIRE_PORTAL=1` 可将缺少 Portal 会话视为失败。
4. smoke 本身不提交客户决定、不生成报价、不发起电子签、不发短信。真实供应商交互由获授权人员在 staging 手工执行，并核对回调、归档和 EXTENSION 生效。

## 7. 生产放量

1. 所有自动化门禁、只读报告和 staging 验收通过后，再申请生产开关授权。
2. 先限定内部白名单订单，观察失败任务、人工接管、迟到回调、短信成功率和分段一致性指标，再逐步扩大。

## 8. 回滚

1. 立即将 `SUBSCRIPTION_EXTENSION_ENABLED=false` 并滚动重启 API，阻止新续期和新考虑期。若要暂停全部
   受支持的合同变更/关闭任务，将独立的 `SUBSCRIPTION_CHANGE_WORKER_ENABLED=false` 并重启 API；此操作
   也会暂停已有任务的认领和完成，直到重新精确设置为 `true`。
2. 保留新增表、枚举、BASE/EXTENSION 分段、已签合同、报价、通知、任务和审计；不得删除或回写原合同期限。
3. 未关闭 worker 时，已 SCHEDULED 的续期由兼容 worker 继续完成，或进入人工接管；不得取消已归档
   补充协议。关闭 worker 时，记录暂停范围并安排后续恢复或人工接管。
4. 回滚前后运行 `pnpm subscription-renewals:reconcile`，核对分段、账单、权益和到期任务。合法已生成账单与支付委托继续按原规则处理。
5. 记录回滚时间、Git SHA、镜像、开关、受影响订单和所有异常行，待根因修复后重新走完整发布顺序。
