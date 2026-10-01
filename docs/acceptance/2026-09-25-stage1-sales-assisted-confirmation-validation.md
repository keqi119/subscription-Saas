# Stage 1 B2：销售协助进件确认回读修复

执行日期：2026-09-25。按[审计收口计划任务 6 的 B2 限域说明](../superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md)实施。只关闭本次门户确认缺陷，不关闭完整 B2。

## 行为与反例

`PortalApplicationService.confirmFinalPlan` 的前置 owned read、CAS 已允许 SELF_SERVICE 或有 Journey 的进件；事务最终回读却硬编码 SELF_SERVICE。因此销售协助进件完成确认及信号写入后，被自己的回读排除而整笔回滚。`62a7567a` 只把该回读改为既有 `portalApplicationSourceScope`，保留 customerId、deletedAt、id、锁序、revision/hash、状态和无订单校验。影响现有门户确认 API；不改变 Admin 审核或其他门户动作，也不放开无 Journey 的销售进件。

原 unit fixture 未消费查询的 source 条件，掩盖了问题。先补查询契约得到 45/46 RED，再使初始/最终查询 fixture 实际消费 OR/source/relation/ownership/deletedAt 条件，得到 46/47 RED，错误为最终回读 Application not found。无 Journey 的销售进件拒绝且不进入事务、不写 Application、不发信号；已有其他客户拒绝测试保留。

真实 PG fixture 的 B 线从 SALES_ASSISTED、AVAILABLE 车辆、无 soft hold 开始，建立既有 FINAL_PLAN_DECISION 人工待办，调用真实 CustomerService 方案生成、车辆预留及发布；独立核对生产生成的 revision/hash，然后调用真实门户确认与 Journey 建单/合同/权益。A 线原用例保留。进件已审核事实、后续 order step 定位和 job 建立仍是 fixture 边界，不冒称完整人工/队列推进链。

| source / 运行 | 结果 | 实际含义 |
| --- | --- | --- |
| `a040b3e08f976fc577fac38eea0af272a71d6c12` / `f45b51e5-4c02-463d-b132-0255e0930999` | 31/32，exit 1 | 唯一失败为 SALES_ASSISTED 真实确认，Prisma 定位 portal service 最终回读 352/292 行；非前置 fixture 失败 |
| `62a7567a8afb0b4eda44e88a1699a4df52084aad` / `6a9bc9f5-ea37-4d04-9a71-20cbcbcdbfca` | 32/32，exit 0 | A/B 正例、完整旧 F1/F2 漂移/恢复/锁序回归全部通过 |

两轮 fresh 均干净 source、无过滤/跳过/todo/取消，全部 32 项实际执行；各自新目标由原 launcher 完成生命周期并退役。RED 报告原始/canonical/content/readback 摘要 `sha256:9bab0a194d4416cb55d58cac99d588118d1c5ee2adf6afb562b066bcba1cc6f6`，receipt `c2268075-ed90-43dd-bcce-addbf4584bc6`，永久保留原分类。

## 最终验证与原件

完整 fresh 命令为 `node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-integrity.postgres --chain fresh`。本次仅复用此前独立审核的通用非秘密捕获/回读函数，显式传入 integrity suiteId；没有新增数据库生命周期接口、借用 B5 结果或复用退役身份。

| GREEN 绑定 | 值 |
| --- | --- |
| started / closed UTC | `2026-09-25T06:42:02.7801949Z` / `2026-09-25T06:44:43.9821406Z` |
| operationId | `398f672c-2aec-469f-b954-8964c27c70f3` |
| database / OID | `s1ci_c055744e1078ec200552e1a6` / `16386` |
| targetFingerprint | `sha256:378386bea6de2e597894ba21fd3b6c1201185968936395aa836d35aa143b0c23` |
| manifestDigest | `sha256:f4892d83e4943fe8acaf729bf4fd87cc41fb143f6b6abc55e8b8e80929f74116` |
| discoveryDigest | `sha256:4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a` |
| sanitizedLogDigest | `sha256:691841d121fb42cfa5b442f133cd285234fd17db751d89e2d3384682fba9c5ed` |
| report/content/readback/raw/canonical digest | `sha256:e8bf7f35b16deb02270c1e94d81b037e3914469d53560648e297addfebaa581e` |
| report bytes | `974` |
| receiptId / file SHA-256 | `5315506e-5b3a-4a84-a464-d3ca4f5cb8b5` / `2f87b8497c79888e28d2801f9054a121e70cb31112cb4daeabb9294aa71e6151` |

三文件 unit 84/84：portal-application、subscription-journey-order-contract、subscription-journey-application。该运行基于 `1452d320` 加随后原样提交为 `62a7567a` 的一行生产补丁，不将它标成启动时干净 SHA。最终 `62a7567a` 的 API tsc 和三份 owned 文件 ESLint exit 0；`git diff --check` 通过。准备期 Prisma validate 及 fresh 内 migrate deploy/status/diff 通过；无 Schema、迁移、manifest 或生成输入变更。契约验证仍为 126 migrations、174 contract files、68 schemas、13 commands，发现检查无未分类文件。

代码/测试/RED/GREEN 原件及本文终审均 ACCEPT，限定门户确认缺陷关闭；完整 B2 继续开放。原件位于 `D:/Projects/auto-subscription-platform/.worktrees/stage1-audit-closure-20260925/.superpowers/sdd/2026-09-22-stage1-audit-driven-closure-plan/`，前缀 `b2-confirm-pg-red`、`b2-confirm-pg-green`、`b2-confirm-scope-unit-red`、`b2-confirm-unit-green`、`b2-confirm-typecheck` 和 `b2-confirm-final-lint`。正式 report/receipt 位于同树 `.release-local/evidence/`；七项 runtime 权限/ownership 均 false。

B2 仍须补两 Application 争车、并发重复确认/建单、旧 revision/hash 与合同后段失败回滚等联合事实验证。本轮未连接远程服务器或调用供应商；Node24/local-controlled-nonpromotable 证据不替代 Node22 最终镜像、双链、Staging、浏览器及阶段 1 签字。
