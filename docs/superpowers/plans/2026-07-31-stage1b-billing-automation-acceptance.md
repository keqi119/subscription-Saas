# 阶段 1B-A 月租账单与逾期自动化验收及发布记录

日期：2026-07-31

## 1. 本期能力边界

本期以已生效订阅合同和已激活租约为入口，落地以下自动化闭环：

- 交付激活时初始化月租账单计划，存量有效订单可通过协调任务补齐；
- 按中国业务日历在账期开始前 D-3 生成月租应收账单；
- 账单生成、计划推进和后续通知/逾期任务在同一事务内提交；
- 到期通知和逾期通知使用稳定幂等键，重复执行不会重复创建逻辑通知；
- 账单在 D+5 仍有未核销金额时自动转逾期并进入催收台账；
- 账单足额核销后取消尚未执行的到期、逾期和逾期通知任务；
- 后台可预览/执行计划协调、暂停/恢复计划、查看任务及人工重试死信；
- 保留人工生成月租账单、人工刷新逾期和人工核销入口作为降级通道。

本期不包含真实委托扣款、银行 API、短信通道、退款自动化及资本债务/收益权分配能力。

## 2. 自动化验证证据

### 2.1 功能与回归测试

| 验证项 | 结果 |
| --- | --- |
| 阶段 1B-A API 聚焦测试 | 9 个测试文件、107 项测试通过 |
| 阶段 1B-A Web 聚焦测试 | 1 个测试文件、3 项测试通过 |
| API 全量测试 | 158 个测试文件、2041 项测试通过 |
| Web 全量测试 | 38 个测试文件、413 项测试通过 |
| PostgreSQL 数据库项目 | 4 个测试文件、14 项测试通过 |
| Stage 2 任务领取稳定性复测 | 连续 3 轮，每轮 8 项测试通过 |

数据库稳定性复测同时覆盖应用主机和 PostgreSQL 存在亚秒级时钟偏差的场景。任务入队的 `availableAt` 已统一取 PostgreSQL 时间，领取和租约判断使用数据库实时时钟，避免刚创建的任务被短暂判定为“尚未到期”。

### 2.2 静态质量和构建

以下命令均已通过：

```bash
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/api --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
pnpm build
git diff --check
```

生产构建完成 API 编译和 Web 55 个路由的静态/动态构建。

### 2.3 数据库迁移

本地隔离验证库已执行全部 72 个 migration：

```text
72 migrations found in prisma/migrations
Database schema is up to date!
```

当前 staging 镜像仍只包含此前的 71 个 migration；发布包含本分支的新镜像后，必须先执行 `pnpm prisma:migrate:deploy`，确认第 72 个 migration 已完成，再启用 Worker。

## 3. Staging 发布顺序

1. 构建并部署包含本期代码的新 API/Web 镜像。
2. 保持 `BILLING_AUTOMATION_WORKER_ENABLED=false`。
3. 在 API 容器内执行：

   ```bash
   pnpm prisma:migrate:deploy
   pnpm prisma:migrate:status
   ```

4. 确认状态显示 72 个 migration 且数据库已同步。
5. 进入后台“月租账单自动化”，先执行“协调预览”。
6. 核对符合条件订单、首个账期、D-3 时间和月租金额来源后执行“账单计划协调”。
7. 检查同一订单只有一条有效计划，重复协调不产生重复记录。
8. 设置 `BILLING_AUTOMATION_WORKER_ENABLED=true` 并重启 API。
9. 先以并发数 1 运行，观察任务完成、重试和死信情况。

建议首期配置：

```dotenv
BILLING_AUTOMATION_WORKER_ENABLED=true
BILLING_AUTOMATION_WORKER_CONCURRENCY=1
BILLING_AUTOMATION_WORKER_LEASE_MS=120000
BILLING_AUTOMATION_WORKER_POLL_INTERVAL_MS=5000
```

## 4. 人工验收清单

- [ ] 已激活订单自动存在一条 `ACTIVE` 月租计划。
- [ ] 重复执行协调不会产生重复计划或重复生成任务。
- [ ] D-3 到达后只生成一张对应账期的月租账单。
- [ ] 重复执行生成任务仍保持同一 `sourceKey` 和同一账单。
- [ ] 到期通知重复执行只保留一个逻辑通知。
- [ ] 足额核销后，未执行的账单生命周期任务变为 `CANCELLED`。
- [ ] 部分核销不会错误关闭账单或取消逾期任务。
- [ ] D+5 仍有余额时账单进入逾期，并形成可追踪催收记录。
- [ ] 暂停计划后不再领取该计划的账单生成任务，恢复后可以继续运行。
- [ ] 可在后台对死信任务执行人工重试，且复用原幂等身份。
- [ ] Worker 关闭时，人工生成、逾期刷新、收款和核销仍可正常使用。

## 5. 回滚与降级

自动化异常时：

1. 设置 `BILLING_AUTOMATION_WORKER_ENABLED=false` 并重启 API；
2. 不回滚已经生成的合法账单和已经完成的任务历史；
3. 使用后台暂停问题计划，核对任务和账单事实；
4. 临时恢复人工月租生成、人工逾期刷新和人工核销；
5. 修正原因后通过协调预览确认差异，再恢复计划或重试死信。

数据库迁移为新增表、枚举、索引和可空字段，不要求在停用 Worker 时执行破坏性回滚。若需回退应用镜像，旧镜像可忽略新增结构。

## 6. 发布判定

代码级验收和隔离数据库回归已通过。进入 staging 人工验收的前置条件是：新镜像部署完成、第 72 个 migration 已同步、协调预览结果经人工核对，并保持 Worker 默认关闭直至上述检查完成。
