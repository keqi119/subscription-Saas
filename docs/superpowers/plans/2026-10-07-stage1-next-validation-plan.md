# 阶段 1 下一轮验证与勘误实施计划

> **For agentic workers:** 使用 `superpowers:executing-plans` 逐项执行；已有定向子 agent 只承担明确的离线实现或独立审核，不另开大规模并行复盘。复用已有授权；本计划的技术 HOLD 不要求用户重复批准。

**Goal:** 将已知失败机制前置排除，以有限的必要验证完成阶段 1；不扩功能、不扩大权限、不以整链重跑代替排错。

**Architecture:** 先对现有证据、状态和执行合同做离线审查，再放行单个新操作。R2、R3、迁移与 R4 按真实依赖推进，任何结果未知均先只读对账，保留原始失败。

**Tech Stack:** 固定 Node.js/Prisma、PowerShell→SSH→H1 Python/Linux、Docker、GitHub Actions、阿里云 RAM/OSS；沿用既定 LUKS/RSA 加密方案，不引入 KMS。

**Spec:** [执行勘误 E01–E25](../../acceptance/2026-10-07-stage1-execution-errata.md)；[已批准 R3 证据交付设计](../specs/2026-09-30-stage1-r3-evidence-delivery-design.md)。批准窗口以本机保留的 `ba872d6-window-extension-proposal-v2/proposal.json` 和实际签名为准。

## Global Constraints

- 目标仅阶段 1 收口；无新增产品能力、商业 KMS、通用测试平台或全历史重跑。
- 现有 SSH、Docker、GitHub 推送/合并/触发授权继续有效；新增精确 RAM 对象权限仍由用户确认。真实终端 ACK/选择输入不自动代答。
- 当前候选 `ba872d6cb2c0e054e5ab099a8218b7220a215301`，build `37581130311`，snapshot admission `37623325751`，失败 RC `37631000017`。旧失败/旧草案/once marker 不覆盖。
- 当前批准执行截止 `2026-10-08T06:53:54.742Z`（北京时间 10 月 8 日 14:53:54.742），不得假设文档审核延长窗口。
- H1 全局锁只允许一个受保护操作；加密卷、core/swap、临时身份、转发和证据目录分别验清理。
- 不输出私钥、token、datasource URL、源记录或手机号。文档与证据摘要不改变签名字节。
- 初始勘误轮仅文档/状态核对；当前 E25 轮限定发布控制代码，已按 AGENTS.md 记录 git 状态、Prisma migrate status/validate，仍为既有两项待迁移。禁止 reset，不改业务逻辑。

## Review Focus

1. **静态 PASS 与真实入口不同**：任务 1 核对生产默认参数、API/CLI 形态、真实宿主和 raw/canonical 输入；不以模板相等代替运行证据。
2. **已留下部分状态**：任务 2 必须验证 seq0→1 的实际旧值；任务 3 必须处理旧 import 与已结束 job 的绑定，禁止原 once 重放。
3. **交互与传输失联**：任务 3 区分 EOF/信号；任务 4 检查 SOURCE/SNAPSHOT/ACK 的真实顺序和一次性转发。
4. **外层提前终止或授权提前失效**：任务 1 统一审核完整时间包络；每个操作执行前再核对剩余窗口，不能扩大获批有效期。
5. **局部清理掩盖 UNKNOWN**：各任务返回范围明确的 cleanup 事实，任务 5 不接纳缺失远端结果、伪造 CLOSED 或 synthetic pass。

## 现有证据复用清单

以下是已记录的事实，不需要为了编写本计划重新运行。执行前只核对与待执行动作相关的摘要、时效或状态变化。

| 证据                                                                                                                               | 可复用范围                                            | 不能推出                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| build `37581130311` 成功；contract `6f6c7ceb972268419d4d556d85653b8876297761c03672cc05f9492e44b33cd2`                              | 同候选的 proof/material/receipt 及已通过构建检查      | 独立 custody 或发布成功                                 |
| `r3-build-import-four-specs-37581130311-readback.json`，raw SHA `9b832c171ee96a4ff1319ae3b875fb2b1b1ace9504d50d55699e0fce6d43c5df` | 四份已验证 spec；保留原失败                           | 任意一次性 ref 可重新执行；sourceFresh 新 import 可忽略 |
| dispatch/signature readback raw `68851943ba43c2f757cf4c471c0e8f54dce3a26a3f75d4489c18345459db3d99`                                 | 原 dispatch/revocation/writer 签名                    | 公件已安装、控制对象已归档                              |
| RAM proposal `ed2f5bd66f7a5be71b291a81aa0e4e80e113f0bc7bd3460d93de2007ef9f64b3` 已应用并回读                                       | 已批准的两个控制对象＋五个快照对象                    | 新 run/new key 的权限；策略自动到期                     |
| ba872 H1 历史 reader 实测 PASS、当前宿主 `ss` observer PASS                                                                        | 同安装/宿主未变化的历史兼容与固定路径                 | 后续传输成功                                            |
| 联合 probe 及独立回读                                                                                                              | E20 seq0 冲突、E21 部分 import/匹配记录为空、清理范围 | 原因未明的连接断开已修复                                |
| 270 秒 SSH dummy 通过                                                                                                              | 同类父子 stdin 转发能够保持该时长                     | 生产链通过或原事故根因确定                              |

本节相对证据文件均位于 `.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/`（下称 **H1DIR**）。本计划不将被忽略证据视为已随 Git 归档。

## 任务 1：先填启动审查表，禁止边跑边补前提

**Files:** 本计划、勘误表；只读检查 H1DIR 已有 manifest/actual readback 和 root-continuation.json。

**Interfaces:** 输入为实际候选、操作脚本 SHA、冻结输入、当前状态和授权。输出为下表每项的 PASS/HOLD/不适用、路径/摘要及审核人；缺任何必需项则该操作不放行。

| 门槛                | 覆盖勘误                                              | 所需最便宜证据                                                              | 当前结论                                                  |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| G1 外部身份/协议    | E01、E02、E05、E08、E09                               | 已保存实际 API/CLI 输入输出约定；需要变更时的一次身份和精确策略回读         | 既有修复复用；每个新动作的实际参数仍需审核                |
| G2 字节/入口/宿主   | E03、E04、E06、E10、E11、E12、E15、E17、E19、E24、E25 | 生产入口默认参数、真实 bytes/schema/架构、当前安装/目录语义；只验证实际变化 | 历史修复有证据；新脚本静态 PASS 不足以放行                |
| G3 一次性状态与时间 | E07、E13、E14、E16、E20、E23、E25                     | once/部分输出/消费/当前 job/全局状态，以及完整预算与到期表                  | Writer/Reader、公件安装均已回读；E25 本地修正，安装待完成 |
| G4 交互/失联诊断    | E18、E21、E22                                         | EOF/信号分离、退出时序、实际每链提示契约及有限离线检查                      | HOLD，不能启动下一 R3 真链                                |

- [ ] 每个待执行操作列出：目的、原失败编号、精确输入/脚本摘要、状态变更、替代不了的真实验证点、预计与硬时限、一次性目录、停止条件、清理范围、可复用证据。
- [ ] 时间表逐行记录准备、worker、人工交互、清理、传输的上限；外层必须覆盖所有内部受限调用及余量。文件系统无法严格界定的延迟写明保守余量和超时后的只读对账路径。
- [ ] 增加四项专门勘误检查：依赖事件顺序；实际使用时的签名/事实最早到期及 run/attempt/ref 绑定；历史用例残留矩阵；失败定位的阶段/时序/来源。密码学验签通过不能替代时效和当前对象检查，seq 冲突不能误标成到期。
- [ ] 将新执行的当前有效期与历史 reader 的事件时刻校验分开；历史 CLOSED 不能被当前过期一概否定，历史签名也不能授权新 run。复用既有历史 reader 证据，不新增时间放宽开关。
- [ ] 每个失败区分代码瑕疵、编排错误、稳定环境兼容、证据支持的环境抖动或未明。记录对比两次观察时哪些输入、持久状态和授权时刻改变；不得以“重跑后通过”判环境问题已解决。
- [ ] 对照 E01–E25 给出逐组证据；不适用需说明，例如此次纯文档无 STS/数据库 I/O。审核人不得用“规范化差异一致”代替运行前提检查。
- [ ] 确認权限仍覆盖实际对象，原批准窗口足以完成操作及清理；否则停止依赖动作，先把所需差额做成具体可审查对象。

## 任务 2：修正已确认的 Writer 全局状态冲突

**Files（实际执行状态以本任务结尾及 H1DIR 台账为准）:**

- H1DIR `revocation-transition-verify-fa9a222d.mjs`。
- H1DIR `revocation-transition-fa9a222d86ea11d279bfd31ce87cdb8c0ad686804e4e3133705a6696439b7544.py`。
- H1DIR `invoke-revocation-transition-fa9a222d-45m.ps1`。
- H1DIR `invoke-fixed-archive-fa9a222d86ea11d279bfd31ce87cdb8c0ad686804e4e3133705a6696439b7544-recovery-1-65m.ps1` 及其固定 issuer/controller。

**Interfaces:** 输入为联合 probe 的旧 global raw SHA `8b25292546c872117ac5c22395636cb040bd31476b8dbe1b31231541d5bf2c8a`、已签名新 raw SHA `6538a6eed1f1f53fac84648c0852d74d048d3bfd0217a9b1204953aa0e8f020a`、原授权 `fa9a222d…`、六个 PREFIX 文件与三个原失败文件的固定摘要。输出为保存旧字节的转换结果及独立回读；recovery 仅在该结果完整后可运行。

- [x] root 审查最终字节：两份签名、同 policy/key、seq0→1 单调集合、旧失败不改、同设备 O_EXCL 临时文件/fsync/原子替换/目录 fsync、cleanup 后才完成。Readback 必须分辨“没开始/替换但无完成记录/完整/其他”。
- [x] 用临时目录及现有公件做一组无 H1/OSS 的限定验证：正确旧→新；错误旧 hash 拒绝；已有 once 拒绝；替换后缺结果只报未知；原失败 bytes 不变。只对真正修改行为做必要 RED/GREEN，不重复旧完整安全套件。
- [x] G1–G3 满足后，转换最多一次 Execute＋一次独立 Readback。未知则停止，不靠第二次 Execute“补结果”。
- [x] recovery 必须额外验证转换完整结果、旧 bytes 备份、新 global SHA 和原部分文件，使用独立 `/writer/recovery-1`。审核通过后最多一次 Execute，保留普通 `/writer/execute` 的失败。
- [x] 仅在 Writer 实际结果完备后，按原协议执行必要 Seal 和独立 Reader；各自单独检查准入并记一次预算。任何失败即停，不把管理员读取当 reader custody。

**限额/停止条件:** 离线一组；每个状态转换/协议动作一次真实 Execute。该任务不改 RAM 范围、不新建身份/密钥、不触发 build/R3。转换、Writer recovery 与 Seal 已按审核稿执行并独立回读；Reader 独立 custody 已完成；公开控制安装已完成会话删除、到期等待、宿主清理及独立回读。后续仅使用 [修订调用清单](../../../.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/dispatch-forward-followup-37581130311-reviewed.md) 的预算副本和单份冻结 Reader 输入，不重跑已完成动作。

## 任务 3：补齐 sourceFresh 的可鉴别诊断和恢复设计

**Files:** H1DIR `r3-source-fresh-owner-5b940705.{py,ps1,mjs}` 作为只读失败基线；新诊断/恢复文件单独命名，原 once 不覆盖。生产协议参见 `scripts/release/run-r3-source-fresh.mjs`。

**Interfaces:** 输入为原 failure、联合 probe、terminal RC、现有 spec/ref；输出为明确区分 EOF/信号/child/SSH 的有限诊断字段和新操作设计。未证明原原因前维持 U，不声称修复。

- [ ] 先从现有代码审查确定两处 `OWNER_CONNECTION_LOST_STOP` 的来源；无需再打开加密卷读取同样元数据。
- [ ] 设计并实现 allowlist 事件：发生阶段、EOF 或具体 SIGHUP/SIGTERM、monotonic 时序、child/SSH exit/signal。不写 stdin、命令秘密、环境值或完整错误堆栈；cleanup 不能覆盖首因。
- [ ] 仅一次本地无业务协议检查覆盖主动 EOF、信号和正常交互，证明能区别且均有界收尾。已有 270 秒 idle 结果复用，不再跑同样长等待。
- [ ] 对原故障仍保留 U；新增诊断的通过只证明以后可区分原因。若只有观察器超时而远端成功，则恢复结果读取；若为已消费未知，则保持未知并走相应处置，不能共用“环境抖动重试”路径。
- [ ] 单独审核旧 `job-import` 文件：只能在原件/attestation/来源校验完整且新 current-job 绑定明确的设计下接纳。旧 RC 已失败，其 admission 不能当作新的活跃 job。若必须更换已批准 ref/window，先准备精确差额；不能自动生成未获准的新 ref 绕过原 once。
- [ ] 只有 G4 通过、恢复设计明确且实际授权覆盖时，才允许一次新的 sourceFresh 真链。真实 ACK 出现后由用户输入；异常不自动重试。无消费的当前事实不触发多余的历史 incident 处置申请。

**限额/停止条件:** 当前只允许离线诊断完善；下一真实 run 尚未具备启动条件。不能用“再试一轮看是否复现”替代上面两项产物。

## 任务 4：在调度前补齐 snapshot 初始入口及其余三链协议

**Files:** H1 已装固定 `snapshot-h1-attempt.py` 为生产入口；H1DIR 旧 `snapshot-final-invocation-37431923399.py` 仅作 final/readback 参考，不是已验证初始制作模板。交互依旧遵循 `scripts/release/run-r3-source-fresh.mjs`。

**Interfaces:** snapshot 初始输入只含实际 `{selection, approvalSelection}`，实际 deploymentId 必须来自本次审批对应关系；不得凭空填值。后续 R3 接收真实 snapshot UUID、同链 CLOSED source digest 和终端 ACK。

- [x] 任务 2 的 custody 完备后，审核公开控制安装和 current revocation 的推进；2026-10-07 16:26 UTC 后独立回读确认 seq1、会话删除并到期、三项清理为 true。数据 job 仍须满足下列其他前提。
- [ ] 离线准备初始 protected parent，保留 global lock/加密卷/core/swap/清理；内部已有 JIT/producer 不再外加第二个 launcher。预算覆盖 attach 最多 1200 秒、authority 调用 280 秒及实际路径所需准备/清理，不能照搬旧 final 的超时值。
- [ ] 在数据环境准入前，先取得本候选真实 sourceFresh CLOSED/gate，并逐项绑定 producer v2 的 sourceGate、custody 和本地 RSA 前置原件；旧 RAM 回读、旧候选公件或 digest 格式通过均不能填补缺证。安装模板必须在缺项时 STOP。
- [ ] 按 E25 补齐初始调用的 live reader-session 生命周期；公件安装的会话已经销毁，不能复用。核对实际最后一次 seal 读取、有界更新同步、次数与完整清理预算；只用现有 reader 角色/权限，不扩 TTL 或通用凭据平台。未实现前保持数据环境待准入。
- [ ] E25 修正纳入受信固定入口及安装摘要。互斥范围覆盖会话准备至原 authority 调用返回，不能后台定时替换正在读取的 inode。核定 admission、producer、dispatch、build 和 spec 的具体绑定影响后，再生成必要的新原件；外部子类不得绕过固定 main/adapter 校验。新 sourceFresh 引用草案亦须经过该影响核对，批准旧草案不等于批准换绑新候选。
- [ ] 生产初始 parent 就绪后才对既有 snapshot data environment 做实际准入；读取真实 deploymentId，再冻结请求、完成一次制作/发布。此时仍不声称 snapshot 完成。
- [ ] 按[既有完成协议](../../acceptance/2026-10-06-stage1-snapshot-completion-readback.md)依次完成：三个实际 job 终态成功 → `snapshot-final-readback` 的独立五对象读取 → 子进程退出、原 STS 凭据 inode 删除且 TTL/墙钟到期 → `seal-completion` 生成 private custody/completion → completion 的独立 archive writer/reader → `seal-producer-terminal`。每步绑定实际 run/attempt/原件和前一步结果；保持密文至外部终态 seal。仅 OSS reader 成功不能放行后续 R3 snapshot 链。
- [ ] completion 的实际对象与归档授权若超出现有已批准范围，先制作精确差额由用户确认；现有七对象授权不被扩大解释。final readback/seal 复用保存的真实 RAM/OSS 原件并重验摘要，不为组装结果重复访问同一对象。
- [ ] 为 sourceSnapshot 写明 `SNAPSHOT → Source ACK`，finalFresh 为 `SOURCE → Final ACK`，finalSnapshot 为 `SOURCE → SNAPSHOT → Final ACK`。复用同一有限输入转发逻辑时仍分别核对 phase/chain/ref；提示分片只消费一次，早到/重复/错误 phase 输入拒绝。
- [ ] 用一组无 DB/云 I/O 的有限协议输入覆盖上述三序列；不得以自动 ACK 跑生产。所有依赖准备完毕后才调度 hosted job，防止人为等待消耗其窗口。

**限额/停止条件:** 准备阶段不触发新 run。snapshot 一次初始操作；每条必需 R3 组合一次真实运行，前一必需结果失败即停止其依赖链。四组合是阶段 1 必需覆盖，不扩为任意组合矩阵。

## 任务 5：通过后的迁移与真实验收

**Files:** 既有两项 Stage 1 migration 和现有 R4 验收清单；本计划不新建业务范围。

**Interfaces:** 只接纳同候选完整 R2/R3、公件/custody、源/终态及真实 ACK；输出为 Staging migrate status、两项迁移结果和 R4 实际证据。

- [ ] R2/R3 完整后，从服务器既有 Docker PostgreSQL/`.env` 在受控进程内取得 datasource，确认目标为 `subscription_saas_staging`；不回显 DSN。
- [ ] 按既有发布要求执行两项待迁移并读回；禁止 `migrate reset`。如实际状态不同，先对齐实际差额，不能按旧“两项”假设执行。
- [ ] 运行已有 R4 必需真实验收；复用同候选已通过的构建/静态检查，不追加与修改无关全量测试。受控用户数据边界保持既有约定。
- [ ] 核对验收清单和差距全部闭合后才声明阶段 1 完成；未知结果、跳过或管理员读取不得替代缺少的证据。

## 审核记录与执行预算

| 层级        | 本轮/下轮允许范围                                         | 停止规则                                                |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------- |
| 本轮文档    | 证据链接/行号、25 项覆盖、diff/格式检查；一次定向独立审核 | 发现事实错误就在文档纠正，不启动云或业务验证            |
| 离线修复    | 每个实际变更一组最小必要回归；已有绿色证据复用            | 不在目标断言失败的“RED”按环境错误处理；不得补跑全套掩盖 |
| 受保护执行  | 每个明确新操作一次 Execute，必要独立 Readback             | 超时/未知先读取实际结果；禁止盲重放/清空 once           |
| hosted 真链 | 前提齐备才调度；同候选只做所需四组合                      | observer 故障不触发新 run；依赖失败即停止后继           |

主 agent 已自审：E01–E24 均映射到 G1–G4；R2 可分步准备，R3/full-chain 尚 HOLD；无授权扩大或过度测试要求。该计划的编写完成不代表执行许可条件已经满足。

2026-10-07 定向独立审核（`archive_operation_review`）：发现任务 4 未完整列出 snapshot completion/归档/终态顺序；已对照既有完成协议补齐，并明确不扩大七对象 RAM 范围。修订后复核无阻断问题。四类重点归因、当前事实及 E01–E24 → G1–G4 覆盖通过；这是文档审核结论，不是 H1 recovery 或 R3 执行 PASS。

下一次启动审查时，须把 G1–G4 的笼统“复用/待审”替换为**该操作的具体 SHA、证据路径、预算和判定**。这一步由执行者与审核者完成，已授权的日常实施不再向用户重复确认。

2026-10-08 执行补记：Writer recovery、Reader 实际封存及公件安装均已独立回读完成。新增 E25 是静态发现的 initial 会话接线缺口，映射 G2/G3，未用真实制作来试错；此前 E01–E24 的审核记录仍按当时范围保留。定向代码复核确认外部子类不能覆盖受信入口摘要，修正须更新实际 adapter 及受影响的授权绑定。新 sourceFresh 精确引用差额尚待负责人确认及绑定影响核对；数据环境尚未准入。

### E25 实施状态与下一步

本地受信入口与固定 Node issuer 已实施、定向审核通过；Python 28 项、Node 13 项相关检查通过，Prisma validate 通过，Python 3.6 语法兼容检查通过。实际离线控制 bundle 闭包为 `sha256:9b96ad6aa6347319f0c0a729ad3981f95d7df974b3097085f1e17b7518f3d744`，共 2430 文件，尚未安装；控制源码后续如有变化须重新冻结实际摘要。

继续按以下依赖实施，不重复上述已通过检查，除非代码、输入或审核发现发生变化：

1. 依据[绑定影响核定](../../../.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/snapshot-reader-lifecycle-binding-impact-20261008.md)准备并独立回读 H1 新安装。业务 source/build 与 adapter 分别核定；修改主分支或工作流实际 SHA 后不能沿用不匹配的旧结果。
2. 为新 adapter 生成准确的 dispatch/admission/producer 绑定；新精确 OSS 对象若超出现有 RAM 草案，仍单独提交具体差额。已有公件/seq1 是历史前驱，不覆盖或回滚。
3. 新 active parent 必须覆盖实际执行、Reader 最终到期等待、宿主清理和传输。旧 child7200/worker8400/outer10800 模板维持 HOLD；不以本地快速通过证明预算够用。
4. 真实 sourceFresh gate、v2 原件及部署绑定齐备后才执行新的 initial。当前无真实 initial 尝试或数据 Environment 准入。
