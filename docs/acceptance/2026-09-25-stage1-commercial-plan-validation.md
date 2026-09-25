# Stage 1 F1：确认商业事实与重新报价恢复验证

执行日期：2026-09-25。依据已批准的[审计收口计划任务 1](../superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md)及 F1 限域说明。F2 已有[独立限定证据](2026-09-25-stage1-application-authority-validation.md)。本记录不作为 B1/B2 全矩阵、最终 Node22 镜像或阶段 1 签字。

当前状态：F1 限定代码与本地验证完成，source `35353517` 完整 fresh 31/31、exit 0，独立代码/测试评审 ACCEPT。最终联合断言全部执行通过；本轮任务 1 的 F1/F2 修复闭环，B1/B2 剩余矩阵和阶段 1 继续开放。

## 行为与边界

- 两个 CustomerService 建单入口在 Quote、Order 和车辆 RESERVED 写入前，将本次实际使用的 details 与已确认快照比较。投影包含全部价格、押金与规则、周期、套餐、额度及车辆身份；排除车辆 status、assetLocation、currentMileageKm 等运营观测和顶层确认元数据。原发布 commercialPlanHash 算法未变，Journey revision/hash 仍必须绑定有效确认快照。
- 仅已确证的商业投影变化抛内部 `ConfirmedCommercialPlanChanged`，沿用 `FINAL_PLAN_REVISION_STALE`。无效商品、坏 hash、旧 revision 和基础设施错误保留既有拒绝语义，不能统统视作正常等待。
- bootstrap 在原事务和 Journey → Application → Vehicle 锁内，把无订单的流程退回 FINAL_PLAN_DECISION，创建新的人工待办和对应恢复事件。重置可重走的四步，保留历史事件/任务以及 Application 的原确认快照；不自动追认价格、不替客户确认。
- 人工通过现有 decideFinalPlan 发布新 revision 并清除确认，再由门户明确确认和真实信号消费排队建单。正常重报价返回业务等待结果，保留当前 job lease 供 worker 正常完成。旧 job 的重放匹配原恢复事件，即使后续已经建单也不冒认新结果、不重复开任务。
- 直接建单在同一锁内校验 Journey 阶段；商业事实恢复原值也不能绕过人工待办。人工发布的重复请求绑定 publication event sequence 和 dto.version，跨轮旧命令明确拒绝，不能返回当前 revision 冒充旧结果。

生产范围仅为 CustomerService、Journey service/repository/errors/json；无 schema、迁移、DTO、枚举、权限、渠道或 UI 新动作。原 manifest 登记不变。

## 失败、测试修正及修复历史

| source / 前缀 | runId | 通过/执行 | 实际含义 |
| --- | --- | --- | --- |
| `512507a0` / `p1-f1-red` | `b811e3a3-493c-406a-bec2-5ef9d254bcd6` | 20/30 | 八类事实漂移、直接入口及恢复首步均错误成功；真实目标 RED |
| `ab9b0511` / `p1-f1-review-red` | `e96934c5-eba9-47e9-9244-98e79562c6dd` | 26/31 | 八类漂移已阻止；独立审查的商业值回滚绕过是真实 RED；四项领取失败尚未分类 |
| `9bf2876f` / `p1-f1-claim-diagnostic` | `9896917d-4aa0-4b29-8d65-adf855283475` | 28/31 | 剩余三项均目标 PENDING、due=false、lease=false，测试立即领取早于可用时间；不是生产领取算法失效 |
| `407b474c` / `p1-f1-replay-red` | `8f6c3a7b-7e07-42de-ba96-f03bf4155780` | 30/31 | 有界等待实际数据库到期条件后，两轮发布/确认/建单已走通；唯一失败为后续订单生成后旧 job 返回新结果 |
| `35353517` / `p1-f1-final-green` | `ec8303e6-ebac-4a4f-a766-a8c2ef6003b0` | 31/31 | 历史恢复事件优先匹配后完整通过，最终金额/权益/待办/审计断言全部执行，exit 0 |

前四轮实际 exit 1，最后一轮 exit 0；所有 skip/filter/cancel/todo 均 0。报告、receipt、字节摘要完整回读，运行目录由 launcher 退役。未删除失败原件，也没有把尚未抵达的断言称作 RED。

另有人工发布命令 unit RED 24/25：当前发布属于 command version 2，旧 version 0 却返回当前 revision。修复后相关七文件 162/162；此前正例只保存三字段虚构快照，补为真实 finalize 生成的完整快照，保留原建单断言。准备阶段产生的事务调用与被测建单调用分别统计。

领取测试改为最长 5 秒轮询真实 `available_at <= clock_timestamp()`，不修改数据库时间、availableAt、状态或 lease，不使用随机 sleep。仍调用生产 claim、信号派发、job 完成入口。合成 fixture 共享 suite 数据库，全局 claim 会留下未消费 fixture 的租约；这不是上述失败原因，也不代表真实供应商已被调用。

## 验证范围与当前门禁

测试从已审核进件开始，真实生成快照、门户确认、报价/订单/合同/权益、人工决定、信号消费和队列操作。覆盖车价、里程价、能源价、里程/能源额度、超里程费、周期、车辆身份的变化；运营位置/里程观测变化仍可建单。两次重新报价必须分别得到客户确认。联合读取 Application、Vehicle、Journey、Quote、Order、Contract、权益、人工待办、job、exception 与审计。

- Prisma validate exit 0；各 fresh launcher 在精确受控目标执行 migrate deploy/status/schema diff，无 ambient 数据库访问。
- 20 个相关 unit 文件，324/324，exit 0；包括全部 subscription-journey unit 和进件/门户/工作流相关文件。
- 最新九文件 ESLint exit 0，`git diff --check` 通过。
- API 最终 `tsc --noEmit -p tsconfig.json` exit 0。
- 完整 fresh：`node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-integrity.postgres --chain fresh`，31 collected/selected/executed/passed，failed/filtered/skipped/todo/cancelled 均 0。
- 契约校验 exit 0：126 条迁移、174 契约文件、68 schemas、13 commands；发现检查 exit 0：94 candidates = 38 manifested + 56 excepted，0 unclassified。

完整通过 source：`35353517d3499c5fde22a5525bd8e1ab04133c31`；开始 `2026-09-25T04:56:27.8396430Z`，实际关闭 `2026-09-25T04:58:25.0195721Z`，exit 0。启动时 checkout 干净；运行期间只起草本说明文件，业务/测试/manifest 输入保持不变，没有将文档草稿伪称为受测 source。

| 绑定 | 值 |
| --- | --- |
| operationId | `1e29c231-7d9c-467a-9061-1e335c18f2fc` |
| database / OID | `s1ci_ead59ea0838744f356e17c20` / `16386` |
| targetFingerprint | `sha256:4a1645a87f1215a5224f5fdb58a6516c6a9a70108084e5d12975bfdc3d71971f` |
| manifestDigest | `sha256:1907ed65feb925f384dbf4beb1a5f2fa14f5837b0e18414325b242ba2a127d00` |
| discoveryDigest | `sha256:4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a` |
| sanitizedLogDigest | `sha256:24f900e8f9b6c015d21c8a02073f35377484b54ff04c5bc7ab4e3fcc3cc5c8f6` |
| report / content / readback digest | `sha256:e6bfdad297854932094ac13d90fe6bd14fb96d254a3aa6aee5e141b280544cbb` |
| report bytes | `974` |
| receiptId | `496d3a04-35d2-4af2-bde6-8f59c52814df` |
| receipt file digest | `sha256:b6cee9a522d13b544394e5ed7397f18fa1e0e5c26631a9745663dfb9c5ec1d45` |

七项 runtime 角色及 ownership 权限字段均 false，完整 custody 只读回读匹配，run 目录已由 launcher 退役。上述最终结果补交独立评审，不需为文档提交重复相同门禁。

原始日志保留于干净实现工作树 `stage1-audit-closure-20260925/.superpowers/sdd/2026-09-22-stage1-audit-driven-closure-plan/`；最终前缀 `p1-f1-final-green`、`p1-f1-final-units`、`p1-f1-final-typecheck`、`p1-f1-final-lint`，正式 report/receipt 位于同树 `.release-local/evidence/`。本机 Node24 及 local-controlled-nonpromotable 证据不是候选最终制品或真实渠道验收。

本轮未连接服务器、未恢复线上 Docker、未调用供应商或进行资金操作。线上联调需要时将先恢复并核验本系统对应运行环境。F3、F4 完整门禁、B1/B2 剩余矩阵、B4–B6 及发布/外部验收继续开放。
