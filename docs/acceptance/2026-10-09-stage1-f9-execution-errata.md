# f9 本轮执行勘误与后续验证边界

本记录续接 [多轮勘误总表](2026-10-07-stage1-execution-errata.md) 和 [5d 勘误](2026-10-09-stage1-5d-execution-errata.md)。实际候选 `f9acdbc08114d79add1072cd16fdd653a451b606`，构建 `37890379457`，快照准入 `37895921665`，RC `37905443583`。C 表示已证实的问题，P 表示执行前拦截，U 表示原因未确定；后续成功不能反向证明先前只是环境抖动。

## 本轮事实

六对象四策略 RAM 精确差额已获批准、应用一次并独立回读。H1 双签、归档 writer/reader、公件安装完成；撤销序列仍为 1。四规格已预留并独立回收，这些准备事实不表示 R3 通过。

source-static 成功；sourceFresh job `113738652375` 失败，RC 自然结束为 failure，未额外取消。H1 原始诊断为 `H1_CALLER / DELIVERY / R3_JOB_ADMISSION_UNAVAILABLE`。Hosted 在约 600 秒交付等待结束后报告交付不可用，属于后续现象，不能代替 H1 首因。没有真实 ACK 或 R3 CLOSED 结果，快照 data 未放行，其余三条 R3、两项迁移、R4 未执行。

初始六份准入原件于 `08:37:30.102Z` 收齐并验真，比实际 Execute 起点 `08:37:06Z` 晚约 24 秒。H1 阶段累计记录为 evidence gate 109399ms、session ready 117440ms、lease ready 127821ms、attempt allocated 159265ms、sign started 159266ms；它们是累计时间，不能当成各单项耗时。authorization persisted / socket connected 未完成，不能凭 sign started 推断签名成功。

一次受保护只读核查及独立原件回读确认：spec、admission、ZIP 与实际绑定一致；本次 session `04b1c444-8802-46fa-b5b3-cb39f94b32eb` 有 OPEN→CLOSED 记录，CLOSED 时间为 `08:46:11.811Z`；两个固定转发槽均不存在。限定时间窗发现 attempt allocation 和 request，未发现对应已签 authorization；该 profile 消费槽的限定扫描无本 ref 记录。此结论有明确扫描范围，不作全局无记录声明。临时证据 tmpfs 已卸载、目录为空、SSH 授权公钥文件为空，独立生产 `check-idle` 返回 IDLE。两加密卷关闭，swap/core 保护已恢复。**H1 session CLOSED 不等于 R3 验证 CLOSED。**

## 合并勘误

| 类别                     | 本轮事实与归类                                                                                                                                     | 下一轮编写和审核要求                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 时序差错                 | C：H1 delivery 与签名并发；外层首因是 DELIVERY。sign started 不能替代签名结果，Hosted 的后续 600 秒失败也不能替代 H1 原始错误。                    | 使用实际 run/job/Execute 起点和各阶段原件；区分累计与单项耗时、并行分支与首因。保留 90/600 秒及签名截止，不靠延长窗口掩盖问题。                              |
| 绑定过期或错误的签名     | P：PowerShell 日期解析曾丢失 `.000Z`；模板保留旧 issuedAt、authority 摘要；先替换 run ID 会破坏复合 authorization ID。                             | 原文字节和获批摘要为准；日期显式保留字符串，完整标识优先替换。验证 source/build/ref/issuedAt/notAfter/authority 的实际值、摘要和来源，拒绝部分重绑。         |
| 历史状态残留             | P：checkpoint 顶层仍停在 5d；旧对账中的第四规格 ABSENT 后已有成功 continuation。C：本次失败已有独立会话、槽位、传输及 IDLE 回读。                  | 保存历史后更新当前入口；按证据时间顺序判断状态。旧失败/ref/once 不重放，不删除台账；H1 清理完成不等于目标验证成功。                                          |
| 不稳定定位与形状假设     | P：混用回读包装文件 raw 与内嵌远端原件 raw；Environment 待批时实际 run 为 waiting，草稿却要求 in_progress。                                        | 精确区分文件原字节、嵌入原件和 canonical 摘要；用真实 API 合同及必要数量核对，不能拿语法通过代替绑定审查。                                                   |
| 错误诊断丢失             | C：`readFixedR3JobAdmission` 包装未分类子进程/解析错误时丢失原始 cause；owner 仅保留有限安全字段，完整 PTY 不持久化。U：本次具体底层失败无法恢复。 | 在现有三个 gh 命令和响应解析边界保留有限原因分类；保持外部失败码、准入和清理行为。不得落盘 token、响应正文、stderr 原文或堆栈，不为补日志直接重跑 R3。       |
| 环境故障与未知原因       | C：部分独立 STS/GitHub 查询有 TCP timeout 原件；U：reader 公开原件采集首次失败、本次 H1 准入底层失败均缺少足够细节。                               | 有明确网络错误才归为环境问题。先读回同一次已完成结果；不得把后续读取成功写成已证明的环境抖动，也不自动重复执行/Seal。                                        |
| 本地采集与验证编排       | C：只读迁移采集后的仓库祖先索引错误，原 stdout/exit 已保存，直接离线对账恢复；WSL 首次多层命令参数引用损坏，在测试前退出。                         | 使用已核定工作区根；多行 WSL 脚本经 stdin 传入。保留首次错误，只补本地解析；未到目标断言的失败不是产品 RED，不触发云端重跑。                                 |
| 测试注入定位与消费端漏接 | C：首轮两个故障注入匹配所有 attestation/run 查询，先击中 build 前置认证；旧 Python owner 白名单拒绝新增诊断码。                                    | 故障注入按实际 admission 文件和 ci.runId/jobId 精确匹配，不能按调用次数或模糊命令名定位；核对 Node→Python 全链消费端，旧冻结包不改，新包同步白名单和摘要链。 |

## 本轮查询异常

Prisma schema validate 通过。复用既有服务器 datasource 的 `prisma migrate status` 返回通用 Schema engine error，exit 1；临时隧道已关闭，不能标成该命令通过。随后一次服务器容器内只读迁移台账查询确认：数据库容器 healthy，128 个本地迁移中 126 个已完成，没有未知已应用项或未完成记录；仍仅待应用 `20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard`。该查询未执行迁移，CLI engine 错误具体原因仍 U。

## 原件索引

下列文件保留在本机 `.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/`，不随本文自动发布。摘要均为所指文件原始字节。

| 原件                                                                       | SHA-256                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `candidate-f9acdbc-sourcefresh-failure-ACTUAL/failure-diagnostic.json`     | `1c01c7dc7fa5d1a135ea5b2599ba6a7902917a2e7565a7ee1f5c5797ba217e5e` |
| `candidate-f9acdbc-sourcefresh-failure-ACTUAL/startup-timing.json`         | `d2b7061c1c482334f8fa125483e9cd9eb7964ceb0434d06344a2f084ea8a41b9` |
| `r3-sourcefresh750d95a8-journal-readonly-ACTIVE/remote-result.raw.json`    | `3aa1a85c9460278d6a653745d4ac3ae67fca7f15e4480bc5483906238f600ceb` |
| `r3-sourcefresh750d95a8-journal-readonly-ACTIVE/independent-readback.json` | `46e8eb5ea60e09f03993640813f8a1f0ed3477ba1487c0dd9383d0766eb8dc23` |

下一轮只验证新增诊断风险与保密边界，优先复用原生 Linux、root-owned 源码和私有 TMPDIR；Windows 跳过不得记为通过。修复及一次独立审查后核定实际绑定影响，再准备必要的候选差额。现有 f9 远端目录、签名和失败 once 均不打补丁或重放；本记录不授予新源码执行权，也不自动延长 `2026-10-09T16:00:00.000Z` 截止。

## 有限修复验证结果

准入命令/解析边界的安全诊断修复已完成。精确 admission 文件、run、job 定位的原生 Linux reader fixture 在原 f9 源码下 3 项失败，到达预期原因码断言；修复后 3 项通过、0 跳过。诊断单元 8 项通过，既有受信首因优先且秘密字串不进入公开诊断。合法 JSON 的业务语义或签名断言失败仍可保留原泛码，不能宣称所有无效响应都有细分诊断。

下一 owner 的 parser-only 硬停止草稿已完成 Node→Python 桥接：9 个新增码接受，5 类未知码、重复/额外字段等异常输入拒绝，Python 3.6 语法通过。它没有修改或执行旧 f9 owner；未来新候选必须合入精确白名单并重新冻结 Python/调用器摘要链。一次独立静态审查无阻断。以上均为局部验证，不证明 f9 原失败属于环境抖动，也不表示 R3 或阶段 1 已通过。

格式、语法、差额检查及 release contracts 校验通过。额外直接对根目录 release 脚本运行 ESLint 返回 104 个错误；同配置逐文件对比原 f9 为 104 个，新增诊断为 0（59 个在 trust 源码、45 个在既有测试）。主要包括 Node 全局和既有未使用变量，保留为基线问题，不扩展本轮修改，也不把该 lint 命令标成通过。仓库要求的 CI 另按实际运行结果判定。
