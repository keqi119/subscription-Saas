# Stage 1 B2：进件至订单真实服务矩阵

执行日期：2026-09-25。按[审计收口计划任务 6](../superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md)补齐本地真实服务矩阵，生产修复沿用 [B2 门户确认记录](./2026-09-25-stage1-sales-assisted-confirmation-validation.md)及 F1/F2 记录。本轮两份实现提交 `933c261d`、`a92b2f66` 仅修改 `apps/api/test/stage1-application-order-authority.integration.spec.ts`，没有新增生产逻辑、迁移或 manifest 变更。

## 补齐的事实

- 旧 revision 使用当前有效 hash，错误 hash 使用当前 revision，分别拒绝并保持业务及工作流事实；随后合法新 revision/hash 确认成功。
- 同一进件并发确认：真实数据库阻塞可观测，只有一次确认动作/信号，另一请求得到明确状态变化错误，后续真实建单成功。
- 重复 CREATE_ORDER_AND_CONTRACT：真实事务锁串行化，两次返回同一订单，合同、完成事件和 job 不重复，真实完成信号推进后联合事实正确。
- 两条 SALES_ASSISTED 进件竞争同一 AVAILABLE 车辆：真实方案发布入口只有一方取得预留；败方进件、旧预留和工作流保持不变，胜方新方案仍待客户确认，不提前创建正式订单/合同/权益。旧 job 无法消费未经确认的新预留。此例覆盖发布/预留竞争，不单独声称胜方新订单全链完成。
- 建单事务已写入 Quote、Order 并更新车辆，真实合同方法随后完成 Contract 写入后，测试侧抛确定异常；所有业务和工作流事实回滚，真实重试成功。

保留既有 A/B 成功、商业漂移/重新发布确认、取消/拒绝竞争及材料上传锁序覆盖。竞争通过实际 PostgreSQL backend PID 与 `pg_blocking_pids` 观测；Prisma 写入不替换，barrier 无随机 sleep，finally 释放并等待所有已启动请求关闭。Application、Vehicle、Quote、Order、Contract、Journey、job/event/outbox/人工任务/动作日志联合检查。已审核进件及 order step/job 定位仍为 fixture 边界；不将切片称为完整人工流程或真实渠道。

## 完整运行及失败历史

原命令：`node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-integrity.postgres --chain fresh`。复用已审核的非秘密捕获/回读函数，显式传入该 suite；数据库 lifecycle 由原 launcher 独占。

| source | 结果 | 定性 |
| --- | --- | --- |
| `933c261d637c59f07e4ab83691342aadaa1fea2c` | 38 执行，37 通过，1 失败，exit 1 | 新共享车辆继承 DRAFT 默认值，在写入 barrier 前被可用性校验拒绝。属 FIXTURE_PRECONDITION_FAILURE，不是业务 RED；原捕获分类和失败原件保留 |
| `a92b2f66fdf80716c6b530c63a358da0ef26072c` | collected=selected=executed=passed=38，exit 0 | 仅显式设共享车辆 AVAILABLE 并独立读回后，完整套件通过 |

两轮均无 filter/skip/todo/cancel，各自干净 source、新受控目标、完整报告、custody/readback 和退役。首轮 run `a6614f33-0d2d-45bc-96b8-f9b40265a350`，operation `df9acc04-4e19-4b55-b6f4-d2e503040fdc`，报告摘要 `sha256:9b010a769eba0ebe364c84723207f19d40cadb5d712b0ed31f64c69623e7977d`，receipt `b010c144-dd37-4368-a0c9-b92816e2a1c8`。

| 最终绑定 | 值 |
| --- | --- |
| started / closed UTC | `2026-09-25T07:05:07.8807021Z` / `2026-09-25T07:07:52.4170371Z` |
| runId / operationId | `8abc97b0-b415-498b-8f53-e7be53bd0445` / `a7b2f45c-40e9-434e-aa85-539b2d070295` |
| database / OID | `s1ci_8a2608c191c61c483e52e85f` / `16386` |
| targetFingerprint | `sha256:f5148b4ad4253b5d41a923f755b63ba965a0d7a80a0d871114247f4a3cfd7333` |
| manifestDigest | `sha256:f4892d83e4943fe8acaf729bf4fd87cc41fb143f6b6abc55e8b8e80929f74116` |
| discoveryDigest | `sha256:4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a` |
| sanitizedLogDigest | `sha256:5e3b13c7393f9aa828ca87a917dd0a1c62402ff46164bcf885eb6172dc1cae10` |
| report/content/readback/raw/canonical digest | `sha256:9ead35c0a6697645a8e2f09736f143e8b4a0b3d26db242b1a906c1c666a4a043` |
| report bytes | `974` |
| receiptId / file SHA-256 | `38b2da30-5701-465c-8941-be15f169ac1a` / `eb5879b8d1d147c7bf5af1d90d8c99ca1c9964e628f92c3e8d83bced66fd6cd3` |

最终 source 的 API tsc 和该 owned PG 文件 ESLint 均 exit 0；`git diff --check` 通过。七项 runtime 权限/ownership 均 false，报告终态 PASSED，run directory 已由 launcher 移除。准备期生成输入未变，沿用此前 Prisma validate；每次 fresh 内独立 migrate deploy/status/diff。契约/发现 preflight 通过，当前 repositoryContractDigest `3778c7b48e731073b722d3edd3f5b6fe393d1015ae19a4fc81367439a00678e8`。

原件在 `D:/Projects/auto-subscription-platform/.worktrees/stage1-audit-closure-20260925/.superpowers/sdd/2026-09-22-stage1-audit-driven-closure-plan/`，前缀 `b2-matrix-first`、`b2-matrix-final`、`b2-matrix-final-typecheck`、`b2-matrix-final-lint`；正式 report/receipt 在同树 `.release-local/evidence/`。历史 B2 确认修复 84/84 unit 与 32/32 PG 保留其原 source；不改标成最终 a92b2f66 的运行。[B1 记录](./2026-09-25-stage1-intake-business-wait-validation.md)的 112/112 unit、原 Task4 golden-path fresh 1/1 同样保留 source `7ad53559`，未为文档变化重跑。

代码与夹具、最终原件及本文独立终审均 ACCEPT，已按终审修正合同后段失败的写入归属表述。仅关闭任务 6 的本地 B1/B2 证据范围；B4/B6、R2、Node22 最终镜像、双链、真实渠道、Staging 浏览器及阶段 1 签字继续开放。未连接线上服务器或调用供应商。
