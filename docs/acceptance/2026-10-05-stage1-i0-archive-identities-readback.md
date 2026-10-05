# 阶段 1 独立控制证据身份初始化回读

用户已在当前线程明确批准[精确草案](2026-10-05-stage1-i0-archive-identities-proposal.md)，配置 JSON 的 SHA-256 为 `8c816d475f604bd7c7fc33b29157cb38f9f07730216f4d47bae6c6395b26db04`。本记录是该初始化变更的事实说明，**不是 I0_CLOSED 或 OSS 保管成功证明**。

## 实际云端状态

管理登录 `GetCallerIdentity` 确认为账号 `1457643390906675`。创建前 `20a23f` 于 2026-10-05T15:30:00.178Z 确认两用户、两角色、两策略均不存在。批准后创建了这六个对象并完成两次用户策略附加；没有创建 AccessKey、登录配置、用户组或 OSS 权限策略。

最终 `5be00e` 于 2026-10-05T15:44:47.504Z 对两套配置逐项重新读取并核对：

| 用途           | 用户 ID              | 角色 ID              | 唯一用户权限                                            |
| -------------- | -------------------- | -------------------- | ------------------------------------------------------- |
| archive writer | `205912291214740625` | `300475092111787593` | AssumeRole 到 `subscription-saas-stage1-archive-writer` |
| archive reader | `202310391214743912` | `300385676904604192` | AssumeRole 到 `subscription-saas-stage1-archive-reader` |

用户全名、角色及策略名称与草案 JSON 相同。两角色仅信任本行用户，MaxSessionDuration 均为 3600 秒、AllowConsoleLogin 均为 false，角色附加策略列表为空。两用户无组、无控制台登录配置、AccessKey 数量均为 0；仅附对应 AssumeRole 的 Custom policy 默认版本 v1，实际 JSON 与草案完全匹配。GetUser 本身不返回 ARN，记录中用户 ARN 明确是从已验证账号和 UserName 推导；角色 ARN 来自 GetRole。

这里证明的是精确 RAM 配置，尚未做对象读写能力验证；不把空角色策略替代 bucket/resource policy 的有效权限审查。本轮没有触碰服务器加密卷、数据库、Docker、GitHub workflow 或快照对象。

## 实测失败、修复及记录来源

首次应用后的本机记录保存 `6d6178` 失败；读取现存对象 `257c15` 证实创建已经发生。未重复 CreateUser/CreateRole/CreatePolicy。CreateRole 调用遗漏显式 `AllowConsoleLogin=false`，实际返回默认 true；本轮对两个已经核对 RoleId/ARN/trust 的角色执行 UpdateRole，收紧为草案的 false。[官方 CreateRole 参数](https://help.aliyun.com/zh/ram/developer-reference/api-ram-2015-05-01-createrole)、[UpdateRole 参数](https://help.aliyun.com/zh/ram/developer-reference/api-ram-2015-05-01-updaterole)。

第二次记录保存 `d7402d` 仍失败。最小诊断 `1e5f42` 定位旧 Windows PowerShell 无法加载 Get-Acl 所在模块；仅加载 System.Security 的加密原语探针不足以证明整个保存路径可用。改用当前固定 pwsh 运行时后，`3ec24d` 在同一专用目录完成 owner-only ACL 检查、DPAPI 加密创建、解密字节比对；随后 `5be00e` 的完整回读和加密保存通过。没有明文凭据生成或输出。

原进程内 Create/Update 调用响应没有成功保全，不能补写成原始传输字节。为恢复变更事实，查询了精确时间窗 15:38:55Z–15:43:30Z 的 RAM 写操作审计。上海查询 `0f96f9` 返回 0 条，随后按[全局事件查询地域规则](https://help.aliyun.com/zh/actiontrail/product-overview/announcement-update-of-the-event-query-feature)改查杭州；`dae1c1` 返回恰好 10 条，无后续分页：2 CreateUser、2 CreateRole、2 CreatePolicy、2 AttachPolicyToUser、2 UpdateRole，均为目标账号 root-account，无错误。

独立本机验证 `724bef` 从 DPAPI 解密原始 ActionTrail 记录并重算摘要，逐项核对用户名、UserId、RoleId、信任文档、策略 JSON、附加关系、3600 秒及最终禁止控制台登录；10 个事件 ID 唯一，response RequestId 与事件 requestId 匹配。因而创建/修改事实有云审计来源；最初本地传输响应缺失的历史仍保留，不把后来审计响应冒充原进程输出。

临时加密保全文件：

- `C:/Users/keqi_119/AppData/Local/Stage1VaultKeys/i0-archive-identities-20261005-reconciled.dpapi`，解密原件摘要 `sha256:ed47313824273151c2b1aa4cbca10166a2d302ddc0f5a8c118f543a4ecf20281`。
- `C:/Users/keqi_119/AppData/Local/Stage1VaultKeys/i0-archive-identities-20261005-actiontrail-global.dpapi`，解密原件摘要 `sha256:bea1a974256563eb08cac11658c45651e910793c7048d26398990ca8f69b9062`。

以上为 CurrentUser DPAPI 与本人专有 ACL 的 provisional escrow；尚未上传 OSS，也没有 Locked WORM 保留期结论。签名/归档前仍须核对实际原件和后续精确授权。

## 本轮代码接线

[evidence-archive-ram-policy.mjs](../../scripts/release/evidence-archive-ram-policy.mjs) 为现有互斥 writer/reader 授权生成待审核的精确 RAM policy。它先验证现有合同及固定 bucket/身份，再核对有限原件集合、原始 SHA-256、大小、schemaVersion 和 canonical digest。拒绝缺失/额外/重复对象、访问器、未来摘要及超过 STS 2048 字节的结果；不自动拆分或扩大成目录通配权限。

writer 仅生成精确对象 PutObject、HTTPS/private ACL 条件；reader 的 HeadObject 在实际 RAM policy 中映射为 GetObject，并包含合同现有的 bucket ACL/WORM 读取动作。[OSS 授权元素](https://help.aliyun.com/zh/oss/user-guide/authorization-syntax-and-elements)规定 ARN 的 region 位只支持 `*`，固定账号、bucket 和对象键仍完整保留。最初错误的显式 region ARN 已在限定反例失败后修正。未编造 `oss:ForbidOverwrite` 条件；真正的 forbid-overwrite header、Locked WORM、对象 ACL 和完整资源 readback 仍属于后续固定 transport 与精确授权对齐工作。编译器本身不签发批准、不访问云、不提供保管成功结论。

`i0-revocation-state.v1` 登记的是原 dispatch verifier 已有的五字段持久状态，保持原 domain、序号、摘要与集合边界；纳入现有归档 proofType 清单并由同一 verifier 调用 schema 校验。实时带 nonce 的响应不能冒充持久状态，也没有创建实际撤销初始记录。此项裁定修复既有 verifier 必须读回该状态、而归档合同拒绝其类型的不一致；不新增另一条撤销链。

限定验证：新状态/归档清单两个反例 `ff3012` 失败后 `0a44e8` 通过；受影响 dispatch 和 archive tests 共 40 项通过（`9b8a96`）；policy 编译器 3 项及其 scoped lint/format 通过。合同清单顺序错误 `9bf323` 修正后通过。受触及 dispatch 模块原有全局 Buffer/timer 与未使用解构的 lint 问题修正后，`46122d` scoped lint 及签名成功/超时两个相关测试通过。没有业务行为修改或全量测试矩阵。

前置检查 `ad8ec0` 于 2026-10-05T15:22:30.618Z 实际读取 Staging PostgreSQL 17.10，128 项迁移仍只有 `20260925090000_stage1_operational_completion_terminal_shape` 和 `20260925091000_stage1_operational_completion_settlement_guard` 未执行；临时隧道已关闭。`0137c4` Prisma validate 通过。

最终 `13fddb` 合同检查通过：300 文件、92 schemas、13 commands、128 项迁移摘要不变；repository contract digest 为 `sha256:60d9c9324dc1f09c81d9402393e6da92e58c844ba87a5298fb3c4dee122d9b2b`。`1f2797` 全部本轮文件格式和批准 JSON 原摘要复核通过，`cacdbd` diff 检查通过；Luna 限定整合审查未发现重要问题。临时 DPAPI 合成诊断文件已清理，真实回读与 ActionTrail 加密原件保留。

## 剩余收口项

本轮新增 RAM 初始化批准已落实，无待答复问题。下一步是实际有限原件归档流程、独立 writer/reader 进程和真实资源 readback，冻结完整对象键后另给用户精确 RAM 差额。需对齐原始人工/API 证据的归档类型及 reader 所需实际 ACL 等只读动作，不能只靠本轮的 schema-tagged proof 编译器宣称 I0 完成。继而接 dispatch 签发/当前撤销源、固定 root policy、JIT 与完整 attempt、三个真实 jobs、实际 producer、同候选 R2/R3、两条获准迁移和 R4。

已安装 H1 控制包仍是上一轮 `cf12e7ac2bc26b4c008d78a4447d14ef5ce352b11d94b0dfdd148f2cd12761db`；本轮尚未重装新增合同/工具。生产 dispatch checkpoint 未初始化，旧明文 sanitized-snapshot workflow 仍禁止触发。阶段 1 保持未完成。
