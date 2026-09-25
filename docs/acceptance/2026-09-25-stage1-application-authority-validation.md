# Stage 1 F2：进件、确认与建单并发验证

执行日期：2026-09-25。依据已批准的 [审计后续计划](../superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md) 任务 1 及同日限域补充。本文仅记录 F2，本地证据不关闭 F1、B2 整体或阶段 1。

当前状态：18 项通过后，独立审查提出资料上传/组审核的外键锁环，正在增加确定性 PG 反例；F2 仍未收口，下述通过结果仅对应 source `01906140` 的当时覆盖范围。

## 行为变更

- 取消、拒绝、公开直接建单统一按存在的 Journey → Application → Vehicle 取得权威锁；锁内重读进件，重新检查权限、状态和已有订单。终止审计的 before 使用事务内快照。
- 审核、资料组审核、补件重提、要求补件和审批等 Journey 信号写入方，在首次相关写入前采用相同顺序并重新校验进件，避免旧审核请求复活终止进件。资料组审核同时重读组记录。
- 门户确认先锁 Journey，再条件更新 Application；更新要求方案待确认、进件 APPROVED、押金已确认且没有有效订单，保留原 revision 约束。取消先提交时旧确认失败，确认先提交时取消可以随后正常完成。
- 修复既有测试的 CommonJS/import.meta 编译冲突，独立提交 `ad0bc45c`，保留原 Prisma schema 默认值断言。

生产修改限于 `customer.service.ts` 和 `portal-application.service.ts`；不改 schema、历史迁移、枚举或应用权限。新 PG 文件仅登记到既有 `api.subscription-journey-integrity.postgres` 的 files。

## 反例与测试修正历史

每轮使用独立受控 fresh 目标和干净 source。以下保留失败及错误测试判定，不能将早期绿灯作为修复证明。

| source | runId | 通过/执行 | 实际分类 |
| --- | --- | --- | --- |
| `438e0b74` | `b26e181b-2c6a-4eee-9f12-1de8600693d7` | 10/15 | fixture 缺套餐车型成员，五个新用例均未到达目标反例 |
| `6493f37b` | `1a24c351-55aa-4fb3-a9db-489882e84046` | 15/15 | 不充分断言造成假通过：仅断言请求拒绝，实际缺后继步骤 |
| `db5b4d71` | `a752e05c-75dd-4858-b876-55e578f0a0fc` | 13/15 | 收紧领域错误后发现错误拒绝原因，仍非目标业务 RED |
| `c6180aec` | `81a83e83-ee3d-41b9-8d43-0849548328cb` | 13/15 | 真实 bootstrap 完成事件消费后，取消/拒绝均错误成功，进件终止而订单存续；目标 RED |
| `7b591dc3` | `c993c70e-8494-47a9-88de-ac622bf156c1` | 15/16 | 独立审查发现门户确认反向锁序，交错请求失败 |
| `77ca7db1` | `0bea9e44-3cfd-48a0-81d0-79910dd67f16` | 15/16 | 同一失败明确识别为 PostgreSQL deadlock detected；增加权益及审计断言 |
| `358e153b` | `7b453718-1560-4b3d-9520-5196f772251c` | 16/18 | 门户死锁及取消后旧确认错误成功两个 RED；真实资料审核锁序用例通过 |
| `01906140` | `bff8ee35-5eee-4385-b06f-bf5f19883cb9` | 18/18 | 修复后完整 fresh 通过，exit 0 |

另有两个公开直接建单终态 unit 反例、五个终止后旧审核 unit 反例，修复前均错误成功，修复后通过。没有把 fixture 错误视为业务缺陷的 RED。

测试从已审核的进件边界开始，使用真实 Customer、Portal、Journey、Order、Entitlement 服务和实际 PostgreSQL 事务。暂停点在测试侧，数据库读写没有替换。锁序用例通过 `pg_blocking_pids` 观察实际阻塞关系，不依赖随机 sleep。调用真实建单完成信号消费以创建后继步骤，不调用签约供应商。

联合断言包括 Application、Vehicle、Journey、Quote、Order、Contract、权益账户及里程/能源额度、终止审计和事务内 before；重复 bootstrap 不增加订单或权益。这里不是完整 B1 进件到建单端到端证据。

## 最终本地门禁

- Prisma validate：exit 0。受控 launcher 在目标内完成 migrate deploy、migrate status 与 schema diff 后执行测试；未连接 ambient 或历史退役数据库。
- API `tsc --noEmit -p tsconfig.json`：exit 0；此前 TS1343 和新增 fixture 的窄类型错误均已修正，不忽略编译失败。
- 五个改动 TypeScript 文件的 ESLint：exit 0；`git diff --check` 通过。
- 七个 unit 文件：161/161，exit 0。文件为 `application-review-api`、`portal-application`、`self-service-application`、`application-workflow`、`subscription-journey-application`、`subscription-journey-recovery`、`subscription-journey-order-contract`。
- PG：`node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-integrity.postgres --chain fresh`，18 collected/selected/executed/passed，failed/filtered/skipped/todo/cancelled 均 0。

完整通过轮 source：`019061403b8ae68e81d135278de8d19cbfd552a1`；开始 `2026-09-25T04:07:26.2503323Z`，关闭 `2026-09-25T04:08:54.7866694Z`，实际退出码 0。

| 绑定 | 值 |
| --- | --- |
| operationId | `eb4a704e-0ba1-43d1-9334-b1af4c4d2605` |
| database / OID | `s1ci_45d8c61c242559ea21c5e215` / `16386` |
| targetFingerprint | `sha256:242cac788fc1890891cba30c077ad944e7fcea5195ee7e48567f100c11ad1f5d` |
| manifestDigest | `sha256:1907ed65feb925f384dbf4beb1a5f2fa14f5837b0e18414325b242ba2a127d00` |
| discoveryDigest | `sha256:4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a` |
| sanitizedLogDigest | `sha256:990583b18aa32eee39599da70a5fad74dd864ea52ff5476106bc4ba36a8bc1fd` |
| report / content / readback digest | `sha256:1c30384fb84de474933b51d7d9fb8e1ba581111e65cfec313e37ab7b123bc394` |
| report bytes | `974` |
| receiptId | `3535d7cc-74ad-4f53-a317-8d401e5c2a95` |
| receipt file digest | `sha256:e091e86a8e6b6f76d58404798db2bdc0b276ceb665080a3c85f45bec51e4b0be` |

七项 runtime 角色/ownership 权限字段均为 false。报告与 receipt 完整只读回读匹配，run 目录已由 launcher 退役，无手动清理或复活目标。

原始日志和各轮 custody 回读保留在干净实现工作树 `stage1-audit-closure-20260925` 的 `.superpowers/sdd/2026-09-22-stage1-audit-driven-closure-plan/`；最终前缀为 `p1-f2-green`、`p1-f2-final-units`、`p1-f2-final-typecheck`、`p1-f2-final-lint`。正式报告及 receipt 保留在同工作树 `.release-local/evidence/`。这些是 local-controlled-nonpromotable 证据，不是最终 Node 22 镜像或真实渠道验收。

服务器本系统 Docker 仍保持用户告知的停止状态，本轮未连接或恢复线上。后续需要线上联调时先恢复对应 Compose 项目并核验健康；F1 商业漂移及恢复、资金回调、B 线整体证据和发布各门禁继续开放。
