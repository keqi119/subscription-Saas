# Stage 1 B3 Task3S 归档后继步骤验证

实际执行日期：2026-09-25（Asia/Shanghai）。文件名沿用已批准 Task3S 的唯一预留路径。

本次本地 fresh 验证 **PASSED，3/3**。归档完成后的步骤应为 `INITIAL_BILLING`；后续唯一事件及无 Lease/Period 写入断言全部到达并通过。此结果不代表真实供应商、最终镜像或 Stage 1 验收通过。

## 批准、源码和边界

- 用户于 2026-09-25 批准 [审计驱动收口计划](../superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md)；任务 5 续接 [B3 Task3S](../superpowers/plans/2026-09-06-stage1-b3-contract-archive-validation-plan.md)。批准记录提交为 `c36d9e33dc865f6e65356a0520cf46c830919261`，旧 B3 独立计划提交 `2886d911` 是其祖先。旧文档“待批准”是历史状态，不重写。
- 唯一测试修改及运行 source：`05af3223f79b3f166c4271de1fb2400d2b83429c`，只将 `stage1-contract-archive.integration.spec.ts:758` 的期待从 `CUSTOMER_JSAPI_PAYMENT` 改为 `INITIAL_BILLING`；其他字节保持。主控与独立只读审查接受暂存差异后才提交和运行。
- 运行 checkout：`D:/Projects/auto-subscription-platform/.worktrees/stage1-audit-closure-20260925`。原 checkout 必须保留 9 月 9 日未跟踪调度文档，因此使用独立干净 checkout；没有隐藏、移动或提交该文档。
- 原 Task3S 的“HEAD 只含旧 B3 计划”检查按新的批准来源前向解释为：旧独立计划为祖先、最新收口计划已批准、当前运行 source 干净。其余单行边界、独立审查、六文件单测和唯一 fresh 保持。
- 历史两份 note、两份 report、两份 receipt 在原 checkout 实际重新计算六个 SHA-256，全部匹配原计划。历史原件未复制、覆盖或删除；两次旧 2/3 失败仍有效保留。
- Task30 stash 保持 `b299ceeed80374d181998f8ef485629beba56b5f`。无 ambient DATABASE_URL/DIRECT_URL/SHADOW_DATABASE_URL/TEST_DATABASE_URL；五个退役固定路径与本次预留 note 在准入时均不存在。
- 依赖只从现有 store 按 frozen lockfile 离线物化：798 reused、0 downloaded、ignore-scripts；未改变依赖、lockfile 或 Node 版本。

## 实际检查

运行时：Node `v24.14.0`、pnpm `11.4.0`、Prisma Client/CLI 包 `7.8.0`。这是 Windows 本地验证，**不是 Ubuntu Node22 最终镜像证据**。

| 命令                                                                                   | 结果                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `pnpm exec prettier --check apps/api/test/stage1-contract-archive.integration.spec.ts` | exit 0                                                        |
| `git diff --check` / cached diff review                                                | 单行差异，无其他源码修改                                      |
| `pnpm --filter @subscription-saas/shared build`                                        | exit 0                                                        |
| `pnpm prisma:generate`（禁用 dotenv 自动加载）                                         | exit 0，Prisma Client 7.8.0                                   |
| 六文件 unit（下列命令）                                                                | exit 0，6 files / 171 tests passed；无失败/跳过/todo，7.91 秒 |
| 唯一 fresh（下列命令）                                                                 | exit 0，3 collected/selected/executed/passed                  |

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/esign.spec.ts test/fadada-archive.spec.ts test/subscription-journey-esign.spec.ts test/lease-activation.spec.ts test/subscription-journey-state-machine.spec.ts test/subscription-journey-payment.spec.ts
node scripts/release/run-database-suite.mjs --suite-id api.stage1-contract-archive.postgres --chain fresh
```

相对历史四文件集合新增的只读选择是 `subscription-journey-state-machine.spec.ts` 和 `subscription-journey-payment.spec.ts`，没有新增 suite/manifest。fresh 开始前及结束后 status 均为空，HEAD 保持运行 source。fresh 窗口为 `2026-09-24T20:59:15.4421928Z` 至 `2026-09-24T21:01:06.7569650Z`。

数据库只由既有 self-provisioning launcher 创建和访问，未直接调用数据库 Vitest、未知连接或退役目标。该成功生命周期包含 migrate deploy/status/schema diff；没有另外向已回收目标查询，也不把此次结果当作其他业务测试的通过证据。

## 当前 report 与独立 custody 读回

| 字段                                | 实际值                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| schemaVersion                       | `database-suite-report.v1`                                                                                        |
| runId                               | `3e309002-b950-486d-9b4c-201a3263f511`                                                                            |
| operationId                         | `e6eb72fd-901c-4d2b-8fe7-c8700b1b900a`                                                                            |
| suiteId / chain / terminalStatus    | `api.stage1-contract-archive.postgres` / `fresh` / `PASSED`                                                       |
| databaseName / databaseOid          | `s1ci_6324f90495f5a2948ebfbb97` / `16386`                                                                         |
| targetFingerprint                   | `sha256:21a2cb041714f4e7d06003993d4098575a0dfc52bb71c82e845ab62ef08f20ca`                                         |
| manifestDigest                      | `sha256:276e49d1ddf8ff9ee845629179cb4deeda0da67c2394807f81e1ca270bcb5351`                                         |
| discoveryDigest                     | `sha256:4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a`                                         |
| sanitizedLogDigest                  | `sha256:da605237d07e10119cd14dd83aebdb15cb88e94dffb27eac9bfc84f528d1bbef`                                         |
| report file/content/readback digest | `sha256:550a61c814536de14274812293f533fbeb6d5badba2248983e0e9d6657e85910`                                         |
| receiptId                           | `d8b7687c-5a9b-4b3b-95a3-9aea8bc92a18`                                                                            |
| receipt file digest                 | `sha256:4dbc534de91ca27d3d67027e5652437cfb47fcc5e2432b8756a14c79e6a224e2`                                         |
| receipt schema / contentSizeBytes   | `custody-receipt.v1` / `963`                                                                                      |
| storeRef                            | `local-controlled-nonpromotable://evidence/550a61c814536de14274812293f533fbeb6d5badba2248983e0e9d6657e85910.json` |
| attestationRef                      | `local-controlled-nonpromotable://3e309002-b950-486d-9b4c-201a3263f511/api.stage1-contract-archive.postgres`      |

九项 counts：`cancelled=0, collected=3, executed=3, failed=0, filtered=0, passed=3, selected=3, skipped=0, todo=0`。

角色事实：`superuser=false, createdb=false, createrole=false, bypassrls=false, canCreateSchema=false, schemaOwner=false, objectOwner=false`。

原件根位于上述独立 checkout 的 `.release-local/evidence/`：

- report：`evidence/550a61c814536de14274812293f533fbeb6d5badba2248983e0e9d6657e85910.json`
- receipt：`receipts/d8b7687c-5a9b-4b3b-95a3-9aea8bc92a18.json`

先按 stdout 分类，再确认本次仅新增一个 receipt；执行原 Task3S Step6 的完整只读校验。两个文件独立 SHA-256、receipt content/readback、精确 run/suite attestation、stored/stdout 的身份、counts、目标权限和全部 digest 均一致。运行目录 `.release-local/runs/3e309002-b950-486d-9b4c-201a3263f511` 已不存在，launcher 已完成回收；未做手工清理。

辅助原件保留在独立 checkout 的 `.superpowers/sdd/2026-09-22-stage1-audit-driven-closure-plan/`：`b3-history-readback.json`、`b3-shared-build.log`、`b3-prisma-generate.log`、`b3-units.log`、`b3-before-receipts.json`、`b3-fresh.stdout.json`、`b3-fresh.stderr.log`、`b3-fresh.close.json`、`b3-custody-readback.json`。

## 限制

本次使用既有最小 PDF fixture 与确定性 provider，只验证平台归档准入和流程后继；不证明真实法大大/OSS、供应商有效或可渲染 PDF。`stage1.esign=must-external-verify` 保持。snapshot、B4/B5 实际链路、真实浏览器/付款/通知、Node22 三镜像、外部/发布提升及 Task30 均未执行。退款仍独立。旧失败记录不改判。
