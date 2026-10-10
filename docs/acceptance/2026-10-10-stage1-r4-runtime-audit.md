# Stage 1 R4 维护证据运行链勘误

审计基线：`b539a0124850b4bb9238f3048ba1e101439ce799`。本次核查发生在首次 b539 RC 已取消、一次替代执行仍未获批且未派发之后。没有运行 R4、启用维护 evidence、应用 Staging 迁移或制造新的业务样本。

## 已证实的代码差距

| 差距                     | 实际调用链证据                                                                                                                                                                                                                                                | 分类及影响                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 已注册命令缺生产查询适配 | `runtime-adapters.mjs` 的 `connectProductionDatabase` 经 `postgres-connector.mjs` 与 `database-runtime-adapter.mjs` 创建数据库上下文；该上下文没有 `queryBillingMaintenanceFacts`，但 `commands/stage1-billing-maintenance-evidence.mjs` 在查询前要求该函数。 | 运行接线瑕疵；当前生产路径会报 `RUNNER_COMMAND_ADAPTER_MISSING`。命令注册和手工注入查询方法的测试不能证明实际可运行。 |
| 两种数据库身份被混用     | Connector 的指纹是带 `sha256:` 前缀的 databaseName/OID/role/TLS 摘要；维护事实与 core 契约要求 databaseName/systemIdentifier/version 的裸 64 位摘要。                                                                                                         | 身份契约瑕疵，既有格式差别，也有语义差别。仅删摘要前缀不能修复。                                                      |

Root 与独立静态复核结果一致。证据保管能力已经存在，不需另造保管协议。手工迁移入口只支持 migrate/verify 是其既定边界，不应为修复本问题扩大权限。上述差距属于 R4，不能用来解释此前 IMPORT_SPEC 失败；其历史首因仍为 UNKNOWN。

## 最小修补与验证边界

沿用原 R4 计划任务 6：补齐已有生产适配器的维护身份观察和指定 run 的参数化事实读取，复用现有身份 hash、事实校验及 custody；保留迁移指纹和可信入口。查询使用只读事务及现有查询时间预算，不能通过截掉额外事实、放宽只读检查、伪造 sequence 或手工生成维护结果使验收通过。

新增聚焦用例必须经过实际生产适配器及命令 handler，再进入 collector；不得在夹具中预先注入缺失的 `queryBillingMaintenanceFacts`。验证准确的身份绑定、只读事务、指定 run 的参数化读取和保管结果。修补结果与运行记录在完成后追加，不预先登记通过。

修补的独立复核另识别了时序边界：身份查询若放在轮询截止建立前，会在原预算之外增加等待。最终实现把身份查询纳入首次 `queryFacts` 的同一截止计时器，扣除其耗时后才允许事实读取；剩余预算耗尽即停止，不能继续查询或保管。只在命令局部上下文保留维护身份，不覆盖 connector 的迁移指纹或其他身份字段。该差额已独立静态复核，无剩余 P1/P2 阻断。

本轮预检：工作区变更前干净；Prisma schema 校验通过；迁移状态 exit 1，128 项中仅以下已知两项待应用，临时 SSH 隧道已关闭：

- `20260925090000_stage1_operational_completion_terminal_shape`
- `20260925091000_stage1_operational_completion_settlement_guard`

前者调整运营结束的终态约束，后者保留 current/latest/same-case FINAL 结算权威并允许合法运营完成后的 FINALIZED。迁移原件不修改，仍待同候选 R3 门槛完成后按既有发布要求应用。

最终本地验证：原缺失适配的聚焦用例先以 `RUNNER_COMMAND_ADAPTER_MISSING` 失败；修补后 `stage1-billing-maintenance-evidence.integration.test.mjs` 与 `database-runtime-adapter.integration.test.mjs` 合计 11/11 通过，fail/cancel/skip/todo 均为 0。新用例覆盖真实 adapter→handler→collector 调用链以及身份查询耗尽 1 秒预算时不读取 facts、不生成 custody；底层事务由夹具提供，不声称已完成真实 PostgreSQL 或 R4 验收。格式、语法及差异检查通过。

## 后续方案审核勘误

- **时序：** 在启用维护 evidence 前安排两轮真实 due 对象；同 run 的首两条 COMPLETED 事实不能由后续轮次覆盖。当前不启动 worker，也不为等待批准制造维护轮次。
- **候选与签名：** 若修补改变候选，旧 b539 签名、批准与 R3 结果不得移用。先完成所需代码修补和聚焦验证，再生成一次实际候选构建与精确绑定。
- **历史残留：** 原 RC、失败、once、已有业务关联和 UNKNOWN 均保留。b539 一次替代草案保持原字节，但因已知 R4 缺口而暂不派发。
- **稳定定位：** 用固定候选、runId、sequence、数据库身份与 API digest 关联事实；不使用 latest 或目录排序选记录。
- **归因：** 上述生产接线与身份错配是代码瑕疵；没有对应失败外部证据，不得归为环境抖动。后续绿色测试也不能改写历史失败归因。

完整收口顺序仍为：最终候选可信输入及同候选 R3 四链 → 两项既有 Staging 迁移 → A/B 新单、成熟正常结束、五模板、两轮非空维护、恢复演练及真实职责签字。本文不降低任何原验收条件，也不宣称阶段 1 已完成。
