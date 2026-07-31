# 阶段 1B-A 月租账单与逾期自动化验收及发布记录

日期：2026-07-31

## 1. 本期能力边界

本期以已生效订阅合同和已激活租约为入口，落地以下自动化闭环：

- 交付激活时初始化月租账单计划，存量有效订单可通过协调任务补齐；
- 按中国业务日历在账期开始前 D-3 生成月租应收账单；
- 账单生成、计划推进和后续通知/逾期任务在同一事务内提交；
- 到期通知和逾期通知使用稳定幂等键，重复执行不会重复发送；
- 账单在 D+5 仍有未核销金额时自动转逾期并进入催收台账；
- 账单足额核销后取消尚未执行的到期、逾期和逾期通知任务；
- 后台可预览/执行计划协调、暂停/恢复计划、分页查看待处理任务及人工重试死信；
- 保留人工生成月租账单、人工刷新逾期和人工核销入口作为降级通道。

本期不包含真实委托扣款、银行 API、短信通道、退款自动化及资本债务/收益权分配能力。

## 2. 关键一致性与故障边界

### 2.1 账期和合同边界

- 自动账期和人工账期共用交付日锚定的日历算法，月末日期会按目标月份最后一天钳制；
- 当前账期开始日已经晚于合同结束日时，计划直接完成，不再生成账单或后续任务；
- 协调存量订单时，以现有月租账单作为进度依据；没有账单的历史合同从当前仍开放账期起步，不补开已经过去的账期；
- 协调预览展示订单、下一账期、生成时间、金额来源、现有账单依据和基线原因，执行前必须人工核对。

### 2.2 并发和唯一性

- Worker 使用 PostgreSQL `FOR UPDATE OF ... SKIP LOCKED` 领取任务，避免多个实例重复执行；
- 逾期刷新和收款核销对同一订单/账单加事务锁，并在加锁后重新读取；若核销先完成，则逾期处理跳过；
- 数据库限制同一订单只能存在一个未删除的 `ACTIVE` 催收案件；
- 数据库限制同一催收案件与账单只能关联一次；
- 自动逾期会记录 `SYSTEM` 审计事件、任务 ID 和催收案件 ID。

### 2.3 暂停、重试和通知

- 暂停计划后，对应账单生成任务不会被领取；
- 已领取任务遇到暂停时会回到 `PENDING` 且不增加尝试次数，恢复计划后可继续执行；
- 通知先写入确定性记录，再以 `PENDING/FAILED → PROCESSING` 原子状态变更取得发送权；
- 渠道返回成功但数据库未能记录结果时，通知保持 `PROCESSING`，自动重试不会再次发送，需人工核对渠道结果后处置；
- 该策略优先避免重复触达客户，不能把 `PROCESSING` 直接视为已发送。

## 3. 自动化验证证据

### 3.1 功能与回归测试

| 验证项 | 结果 |
| --- | --- |
| 阶段 1B-A API 聚焦测试 | 9 个测试文件、123 项测试通过 |
| API 全量测试 | 159 个测试文件、2061 项测试通过 |
| Web 全量测试 | 38 个测试文件、413 项测试通过 |
| PostgreSQL 数据库项目 | 5 个测试文件、18 项测试通过 |
| 阶段 1B-A 真实 PostgreSQL 集成测试 | 4 项测试通过 |

真实数据库测试覆盖任务领取 SQL、暂停任务领取门禁、无损延后和催收唯一索引。数据库回归同时覆盖应用主机与 PostgreSQL 存在亚秒级时钟偏差的场景，任务入队、领取和租约判断统一使用数据库实时钟。

### 3.2 静态质量和构建

以下命令均已通过：

```bash
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
pnpm build
git diff --check
```

生产构建完成 API 编译和 Web 55 个路由的静态/动态构建。

### 3.3 数据库迁移

全新本地隔离验证库已从零执行全部 72 个 migration：

```text
72 migrations found in prisma/migrations
Database schema is up to date!
```

当前 staging 镜像仍只包含此前的 71 个 migration。发布包含本分支的新镜像后，必须先执行 `pnpm prisma:migrate:deploy`，确认第 72 个 migration 已完成，再启用 Worker。

若目标数据库已经存在同一订单的多条有效催收案件，唯一索引会阻止 migration。遇到该情况必须停止发布、核对并人工归并脏数据，不得删除索引或跳过 migration。

执行 migration 前先运行以下只读预检；两条查询都必须返回 0 行：

```sql
SELECT order_id, COUNT(*) AS duplicate_count
FROM collection_case
WHERE case_status = 'ACTIVE' AND deleted_at IS NULL
GROUP BY order_id
HAVING COUNT(*) > 1;

SELECT case_id, bill_id, COUNT(*) AS duplicate_count
FROM collection_case_bill
WHERE deleted_at IS NULL
GROUP BY case_id, bill_id
HAVING COUNT(*) > 1;
```

第二个唯一索引只约束未删除的催收账单关联；已软删除的历史关联可以保留，并允许后续重新建立一条有效关联。migration 内仍包含同样的防御性检查，若发现重复会返回 `STAGE1B_DUPLICATE_ACTIVE_COLLECTION_CASE` 或 `STAGE1B_DUPLICATE_ACTIVE_COLLECTION_CASE_BILL`。

第 72 个 migration 使用显式 `BEGIN/COMMIT` 包裹全部 DDL，并在事务开始时以 `SHARE ROW EXCLUSIVE` 锁定 `collection_case` 和 `collection_case_bill`。因此重复检查与唯一索引创建之间不会出现并发写入窗口；任何检查或 DDL 失败都会整体回滚，不留下部分应用状态。

## 4. Staging 发布顺序

1. 构建并部署包含本期代码的新 API/Web 镜像。
2. 保持 `BILLING_AUTOMATION_WORKER_ENABLED=false`。
3. 在数据库执行上一节两条只读重复数据预检并保存结果。
4. 在 API 容器内执行：

   ```bash
   pnpm prisma:migrate:deploy
   pnpm prisma:migrate:status
   ```

5. 确认状态显示 72 个 migration 且数据库已同步。
6. 进入后台“月租账单自动化”，先执行“协调预览”。
7. 核对订单、下一账期、D-3 时间、金额来源、现有账单依据及基线原因；金额来源必须与实际出账共用同一口径。
8. 执行“账单计划协调”，检查同一订单只有一条有效计划，重复协调不产生重复记录。
9. 在“通知中心”核对是否存在异常 `PROCESSING` 通知；只有查询渠道事实后，才可选择“确认已发送”或“确认未发送”。
10. 核对待处理任务列表，确认没有无法解释的死信。
11. 设置 `BILLING_AUTOMATION_WORKER_ENABLED=true` 并重启 API。
12. 先以并发数 1 运行，观察任务完成、重试、死信和通知结果。

建议首期配置：

```dotenv
BILLING_AUTOMATION_WORKER_ENABLED=true
BILLING_AUTOMATION_WORKER_CONCURRENCY=1
BILLING_AUTOMATION_WORKER_LEASE_MS=120000
BILLING_AUTOMATION_WORKER_POLL_INTERVAL_MS=5000
```

## 5. 人工验收清单

- [ ] 已激活订单自动存在一条 `ACTIVE` 月租计划。
- [ ] 重复执行协调不会产生重复计划或重复生成任务。
- [ ] 存量订单协调预览未补开历史已过账期，且账期依据可解释。
- [ ] 月末交付订单的自动账期与人工账期一致。
- [ ] 合同结束日之后不再生成月租账单。
- [ ] D-3 到达后只生成一张对应账期的月租账单。
- [ ] 重复执行生成任务仍保持同一 `sourceKey` 和同一账单。
- [ ] 到期通知重复执行只保留一个逻辑通知，渠道只触达一次。
- [ ] 足额核销后，未执行的账单生命周期任务变为 `CANCELLED`。
- [ ] 部分核销不会错误关闭账单或取消逾期任务。
- [ ] 核销与逾期并发时，足额核销结果优先且不会创建错误催收。
- [ ] D+5 仍有余额时账单进入逾期，并形成唯一、可追踪的催收记录和系统审计。
- [ ] 暂停计划后不再领取该计划的账单生成任务，恢复后可以继续运行且尝试次数未被错误消耗。
- [ ] 后台默认分页展示待处理任务，可切换查看已完成历史。
- [ ] 后台可对死信任务执行人工重试，且复用原幂等身份。
- [ ] 若通知停留在 `PROCESSING`，先核对渠道事实，再人工处置，不直接重试发送。
- [ ] Worker 关闭时，人工生成、逾期刷新、收款和核销仍可正常使用。

## 6. 回滚与降级

自动化异常时：

1. 设置 `BILLING_AUTOMATION_WORKER_ENABLED=false` 并重启 API；
2. 不回滚已经生成的合法账单和已经完成的任务历史；
3. 使用后台暂停问题计划，核对任务、账单和通知事实；
4. 临时恢复人工月租生成、人工逾期刷新和人工核销；
5. 修正原因后先运行协调预览，再恢复计划或重试死信；
6. 对不确定是否已送达的 `PROCESSING` 通知，先查渠道结果，禁止直接改回 `PENDING`。

数据库迁移为新增表、枚举、索引和可空字段，不要求在停用 Worker 时执行破坏性回滚。若需回退应用镜像，旧镜像可忽略新增结构；已执行的 migration 采用 forward-fix，不执行 `migrate reset` 或手工删除业务事实。

## 7. 发布判定

代码级验收和隔离数据库回归已通过。进入 staging 人工验收的前置条件是：新镜像部署完成、第 72 个 migration 已同步、协调预览结果经人工核对，并保持 Worker 默认关闭直至上述检查完成。
