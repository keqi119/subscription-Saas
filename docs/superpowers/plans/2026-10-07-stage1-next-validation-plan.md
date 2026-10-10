# 阶段 1 下一轮验证与勘误实施计划

## 当前执行游标（2026-10-10，eb5a 处置之后）

本节取代下文历史候选、待批和截止状态；历史原件仍保留。d789 替代 RC `38018148143` 已失败，eb5a 的精确负责人事故处置于 `2026-10-10T04:53:53Z` 独立回读完成，处置摘要为 `sha256:8466adb0e0443c4abedd9702ff937b0e314b1a0c9d54a3e538badded1aec2f4c`。两枚锁已保留式退役，UNKNOWN、CONSUMED 及未知远端状态不变；这不是 R3 CLOSED。

1. 下一候选必须包含已合并的 ACK/WORKSPACE 诊断修补及 eb5a 精确历史识别代码。仅完成必要的一次整合与实际构建，不重复诊断测试或历史整链。
2. 审核最新实际 d789 替代运行的 collector/freezer/handoff/owner 原件及新的有限诊断解析器。重点固定 30 秒 attestation、实际 Execute 起点、600 秒 startup、90 秒 history 和 480 秒 reserve；检查真实调用链、目录权限、空响应归档和失败传播，不能只核模板表面相等。
3. 新候选的 source/build/ref/owner/同源 snapshot 必须重新精确绑定。当前获批截止为北京时间 10 月 10 日 16:00，剩余已不足既有 24,600 秒完整准备及验证预算，不能据此启动新候选。待实际构建证据齐备，提交具体候选及新截止草案；本计划不自动续期。新增 RAM 固定对象仍单独精确确认，真人 SOURCE/SNAPSHOT/ACK 不代答。
4. 获批后按真实依赖完成 sourceFresh CLOSED → snapshot initial 与 completion custody → sourceSnapshot/finalFresh/finalSnapshot CLOSED → 两项原有 Staging 迁移 → 聚焦 R4。失败或未知先独立对账，不自动重试、不把清理成功当作验收成功。

当前两项 pending 仍为 `20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard`。沿用现有 datasource；不增加业务功能、商业 KMS 或额外测试矩阵。详见[本轮勘误及实际证据](../../acceptance/2026-10-10-stage1-d789-replacement-errata.md)。

> **For agentic workers:** 使用 `superpowers:executing-plans` 逐项执行；已有定向子 agent 只承担明确的离线实现或独立审核，不另开大规模并行复盘。复用已有授权；本计划的技术 HOLD 不要求用户重复批准。

**Goal:** 将已知失败机制前置排除，以有限的必要验证完成阶段 1；不扩功能、不扩大权限、不以整链重跑代替排错。

**Architecture:** 先对现有证据、状态和执行合同做离线审查，再放行单个新操作。R2、R3、迁移与 R4 按真实依赖推进，任何结果未知均先只读对账，保留原始失败。

**Tech Stack:** 固定 Node.js/Prisma、PowerShell→SSH→H1 Python/Linux、Docker、GitHub Actions、阿里云 RAM/OSS；沿用既定 LUKS/RSA 加密方案，不引入 KMS。

**Spec:** [执行勘误 E01–E27](../../acceptance/2026-10-07-stage1-execution-errata.md)；[已批准 R3 证据交付设计](../specs/2026-09-30-stage1-r3-evidence-delivery-design.md)。批准窗口以本机保留的 `ba872d6-window-extension-proposal-v2/proposal.json` 和实际签名为准。

## Global Constraints

- 目标仅阶段 1 收口；无新增产品能力、商业 KMS、通用测试平台或全历史重跑。
- 现有 SSH、Docker、GitHub 推送/合并/触发授权继续有效；新增精确 RAM 对象权限仍由用户确认。真实终端 ACK/选择输入不自动代答。
- 当前候选 `ba872d6cb2c0e054e5ab099a8218b7220a215301`，build `37581130311`，snapshot admission `37661486120`。最近 RC `37697010723` 的 sourceFresh79fe 在 H1 POST 失败，已取消并回读终态；无 ACK/CLOSED，后续链保持未运行。此前 RC `37676724380` 已失败，旧 snapshot `37623325751` 已取消。旧失败/旧草案/once marker 不覆盖。
- 当前批准执行截止 `2026-10-08T06:53:54.742Z`（北京时间 10 月 8 日 14:53:54.742），不得假设文档审核延长窗口。
- H1 全局锁只允许一个受保护操作；加密卷、core/swap、临时身份、转发和证据目录分别验清理。
- 不输出私钥、token、datasource URL、源记录或手机号。文档与证据摘要不改变签名字节。
- 初始勘误轮仅文档/状态核对；当前 E27 轮限定发布控制代码，已按 AGENTS.md 记录 git 状态、Prisma migrate status/validate，仍为既有两项待迁移。禁止 reset，不改业务逻辑。

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

| 门槛                | 覆盖勘误                                              | 所需最便宜证据                                                              | 当前结论                                                                          |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| G1 外部身份/协议    | E01、E02、E05、E08、E09                               | 已保存实际 API/CLI 输入输出约定；需要变更时的一次身份和精确策略回读         | 既有修复复用；每个新动作的实际参数仍需审核                                        |
| G2 字节/入口/宿主   | E03、E04、E06、E10、E11、E12、E15、E17、E19、E24、E25 | 生产入口默认参数、真实 bytes/schema/架构、当前安装/目录语义；只验证实际变化 | 历史修复有证据；新脚本静态 PASS 不足以放行                                        |
| G3 一次性状态与时间 | E07、E13、E14、E16、E20、E23、E25、E26、E27           | once/部分输出/消费/当前 job/全局状态，以及完整预算与到期表                  | E25 双归档/公开安装均已回读；E26 连续交接已执行，E27 连接后时限缺口正在修正，HOLD |
| G4 交互/失联诊断    | E18、E21、E22、E27                                    | EOF/信号分离、退出时序、实际每链提示契约及有限离线检查                      | 79fe 的 POST 具体首因仍 U；保留原失败，先补有限诊断并只读核对消费/槽位，HOLD      |

- [ ] 每个待执行操作列出：目的、原失败编号、精确输入/脚本摘要、状态变更、替代不了的真实验证点、预计与硬时限、一次性目录、停止条件、清理范围、可复用证据。
- [ ] 时间表逐行记录准备、worker、人工交互、清理、传输的上限；外层必须覆盖所有内部受限调用及余量。文件系统无法严格界定的延迟写明保守余量和超时后的只读对账路径。
- [ ] 增加四项专门勘误检查：依赖事件顺序；实际使用时的签名/事实最早到期及 run/attempt/ref 绑定；历史用例残留矩阵；失败定位的阶段/时序/来源。密码学验签通过不能替代时效和当前对象检查，seq 冲突不能误标成到期。
- [ ] 将新执行的当前有效期与历史 reader 的事件时刻校验分开；历史 CLOSED 不能被当前过期一概否定，历史签名也不能授权新 run。复用既有历史 reader 证据，不新增时间放宽开关。
- [ ] 每个失败区分代码瑕疵、编排错误、稳定环境兼容、证据支持的环境抖动或未明。记录对比两次观察时哪些输入、持久状态和授权时刻改变；不得以“重跑后通过”判环境问题已解决。
- [ ] 对照 E01–E27 给出逐组证据；不适用需说明，例如此次纯文档无 STS/数据库 I/O。审核人不得用“规范化差异一致”代替运行前提检查。
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

| 层级        | 本轮/下轮允许范围                                         | 停止规则                                                                   |
| ----------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| 本轮文档    | 证据链接/行号、26 项覆盖、diff/格式检查；一次定向独立审核 | 发现事实错误就在文档纠正，不启动云或业务验证                               |
| 离线修复    | 每个实际变更一组最小必要回归；已有绿色证据复用            | 非目标断言失败先区分夹具、编排、环境或未明，不计产品 RED；不得补跑全套掩盖 |
| 受保护执行  | 每个明确新操作一次 Execute，必要独立 Readback             | 超时/未知先读取实际结果；禁止盲重放/清空 once                              |
| hosted 真链 | 前提齐备才调度；同候选只做所需四组合                      | observer 故障不触发新 run；依赖失败即停止后继                              |

主 agent 已自审：E01–E24 均映射到 G1–G4；R2 可分步准备，R3/full-chain 尚 HOLD；无授权扩大或过度测试要求。该计划的编写完成不代表执行许可条件已经满足。

2026-10-07 定向独立审核（`archive_operation_review`）：发现任务 4 未完整列出 snapshot completion/归档/终态顺序；已对照既有完成协议补齐，并明确不扩大七对象 RAM 范围。修订后复核无阻断问题。四类重点归因、当前事实及 E01–E24 → G1–G4 覆盖通过；这是文档审核结论，不是 H1 recovery 或 R3 执行 PASS。

下一次启动审查时，须把 G1–G4 的笼统“复用/待审”替换为**该操作的具体 SHA、证据路径、预算和判定**。这一步由执行者与审核者完成，已授权的日常实施不再向用户重复确认。

2026-10-08 执行补记：Writer recovery、Reader 实际封存及公件安装均已独立回读完成。新增 E25 是静态发现的 initial 会话接线缺口，映射 G2/G3，未用真实制作来试错；此前 E01–E24 的审核记录仍按当时范围保留。定向代码复核确认外部子类不能覆盖受信入口摘要，修正须更新实际 adapter 及受影响的授权绑定。新 sourceFresh 精确引用差额尚待负责人确认及绑定影响核对；数据环境尚未准入。

### E25 实施状态与下一步

本地受信入口与固定 Node issuer 已实施、定向审核通过；Python 28 项、Node 13 项相关检查通过，Prisma validate 通过，Python 3.6 语法兼容检查通过。实际离线控制 bundle 闭包为 `sha256:9b96ad6aa6347319f0c0a729ad3981f95d7df974b3097085f1e17b7518f3d744`，共 2430 文件；现已完成真实安装及独立回读，控制源码后续如有变化须重新冻结实际摘要。

继续按以下依赖实施，不重复上述已通过检查，除非代码、输入或审核发现发生变化：

1. 依据[绑定影响核定](../../../.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/snapshot-reader-lifecycle-binding-impact-20261008.md)准备并独立回读 H1 新安装。业务 source/build 与 adapter 分别核定；修改主分支或工作流实际 SHA 后不能沿用不匹配的旧结果。
2. 为新 adapter 生成准确的 dispatch/admission/producer 绑定；新精确 OSS 对象若超出现有 RAM 草案，仍单独提交具体差额。已有公件/seq1 是历史前驱，不覆盖或回滚。
3. 新 active parent 必须覆盖实际执行、Reader 最终到期等待、宿主清理和传输。旧 child7200/worker8400/outer10800 模板维持 HOLD；不以本地快速通过证明预算够用。
4. 真实 sourceFresh gate、v2 原件及部署绑定齐备后才执行新的 initial。当前无真实 initial 尝试或数据 Environment 准入。

### 本次执行前审查更新（2026-10-08，北京时间）

- G2 增加实际提案字段形态与全部消费端核对：不得假定可推导字段必然出现在已冻结 JSON；不得只更新内层签名集合却遗漏外层回读断言。E24 的本次两类确定性接口问题在云端/签名前已拦截，限定修正后只检查受影响入口和语法。
- E25 H1 安装、独立回读已 PASS；当前 adapter 为 `sha256:4735954acb680df3fe4566873d09d64febce1ced143a0e0683dfb0242c0dce3f`。保持业务候选 `ba872d6` 和已有成功 build，不为控制变更重复构建业务候选。
- 新 hosted admission `37661486120` 已成功；旧 `37623325751` 已取消并回读。后续只能使用新 admission 与新 auth `78c301df…`；数据 Environment 继续 HOLD，尚无 initial 或 STS 实测。
- 新 auth 独立归档，复用完整 seq1 state packet；禁止无依据推进 seq2、重签或覆盖旧状态对象。新 writer 原件仅包含一个 auth；后续 reader 的完整会话权限须核对既有桶属性授权与新对象授权的并集，不能错误要求“本次增量策略＝全部会话策略”。
- 现有六对象四策略 RAM 草案 `461f37b1…` 和 sourceFresh 新引用 `416b8be8…` 的精确审批请求保持待答复；不得把一般继续实施指令填成这两份精确批准。准备脚本的未知审批、真实回读及 writer receipt 保留 PENDING，不生成虚拟事实，不重放已完成动作。

本次属于准备脚本修正及文档更新；复用已通过的 28 项 Python、13 项 Node 与 CI 结果，不重跑功能/数据库/整链测试。实际执行前仍须按 G1–G4 检查该操作的时效和状态；当前审核不能预先承诺后续运行成功。

### 精确批准后执行顺序（2026-10-08，北京时间）

前节“待批准”描述已被实际用户批准取代：RAM 草案 `461f37b1…` 已应用并独立回读；引用差额 `fabbd0ba…` 已实施，新 sourceFresh `416b8be8…` 的实际 spec 为 `53da9265…`，Execute 与独立 Readback 一致、清理完成。两者均不可重放。

1. 两份新签名已完成执行及独立回读：dispatch `78c301df…`、writer `b3e97df8…`，专用预算为 worker 1200 秒、外层 3300 秒。reader `3f80cff8…` 也已独立签名并核验；均不可重签或重放，seq1 state 保持原字节。
2. 新 Writer archive 已完成 Execute、Seal、独立回读及公开原件收集；reader unsigned 只生成一次并冻结 issuedAt。Reader archive 已完成一次 Execute、独立 Readback、Seal 和原件收集；实际 custody 为 `019b8aa6…`。均绑定当前 bundle `9b96ad6a…`、attempt `46626cc7…` 及全局 revocation `6538a6ee…`；custody 完整后才组装公开输入。
3. 实际公开凭据已组装并经生产校验；专用 public installer 的差异审核通过，正按一次 Execute 安装（session `55653`）。它保留 seq1 原字节，只替换新 auth 及其 authority；旧三份原件保存至独立 history。生产检查已观察到新 auth 和原 seq1，完整成功仍须等待会话到期、清理及独立 Readback。
4. 四个 owner bridge 的有限协议检查和定向审核已完成。当前 RC 为 `37676724380`，source-static 已成功，sourceFresh job `112983811488` 等待 Environment 准入；该 job 的真实 admission 尚待准入后产生，不能与 snapshot admission `37661486120` 混用。H1 就绪后再准入、收集 attestation 并冻结实际绑定。SOURCE、SNAPSHOT、Source／Final ACK 不预填；sourceFresh 新引用只运行一次，失败立即停止依赖链。
5. 真实 sourceFresh gate、当前 v2 输入和部署绑定齐备后，执行 snapshot initial 及其完成协议，再完成其余 R3 必需组合、两项迁移和 R4。原执行截止 `2026-10-08T06:53:54.742Z` 不变，开始前按完整剩余预算核验。

编写和审核每个活动包时，须核对 E07 的嵌套时限、E20 的历史状态复用、E21 的原始输入缓存与真实确认、E24 的全部消费端绑定。只核查变化引入的边界，已通过检查直接复用；未证实的环境原因保持 U。

本轮复核补充：上传后的实际受保护入口再次校验余窗；manifest 的 sourceDigest 从实际 manifest／授权派生并核对，不手工转录；新 RC 的 snapshotRunId 必须来自当前 `37661486120` admission，已取消的 `37623325751` 只保留为历史记录。旧请求与新请求的差额应依据全部当前依赖判定，不能预设只允许一个字段变化而遗留失效身份。

激活前对本次必需的固定本地输入一次核查存在性、摘要格式／原始字节、实际 API JSON 形态和模块相对路径；只将当前阶段必需的未知字段列为阻断。未来 session／receipt 的合法待产生状态不能被宽泛 `PENDING` 搜索误判。reader unsigned 一旦成功生成即冻结其 issuedAt，不因修改下游签名或归档包而再次生成。

### E26 失败后的下一步（以此取代上节未完成状态）

公开安装 Execute 与独立 Readback 均成功；sourceFresh job `112983811488` 已实际准入并失败。H1 的 IMPORT 退出发生在 hosted 600 秒交付等待结束之后；原因范围和证据见勘误 E26。没有测试执行、终端 ACK 或 CLOSED 结果，旧 ref 不得重放。

1. 已完成一次有限受保护只读核查与独立回读：spec、ZIP、admission 摘要/绑定正确；ZIP/admission 晚于 hosted job 终态约 39 秒才写入。此次未扫描 journal，不作全局无消费结论；原失败和 once 均保留。
2. 从生产调用链区分已证实的启动时序缺口与尚未证实的 import 具体错误；不凭当前已结束 job 的重读失败倒推原错误。
3. 下一运行方案须在 Environment 准入前冻结可审查的协调入口，在一个有界进程内衔接实际准入收集、冻结、H1 启动，核对 hosted 实际连接期限；不让模型轮次消耗该窗口。只增加必要的有限诊断/验证，不延长签名字节、不自动放大 TTL、不得重跑旧 once。
4. 若实际残留使必须更换已批准的精确 sourceFresh ref，先完成具体处置及新引用草案，提交负责人确认后才预留/触发。既有 RAM、签名、归档和公开安装保持已完成，不因此重做。

E26 方案编写修正：保留本地完整 attestation 验签；当前记录只证明保存 ZIP 后的验签/回读约 14.57 秒，不能把准入后的全部等待归给 collector。单一协调进程须前置所有模板审核，按实际 run/job/步骤起点、当前状态和总截止核验，完成实际收集→冻结→启动；若无法在既有 600 秒连接窗内给出有依据的启动预算，则保持 HOLD，不能仅删安全步骤或延长 TTL。初始 PRECHECK 与 IMPORT 阶段可在 wrapper 区分；生产 importer 的内部 catch 仍限制首因鉴别，不把外层阶段诊断宣称为完整修复。

### E26 本地修正后的交接状态

单一 PTY 串接 DRAFT 与拟议 `79feaa9a-f5ba-4a48-a781-e406726e6580` owner DRAFT 已完成限定检查和独立静态审核；清单分别为 `2fde6ee2…`、`14d0564f…`。未来步骤开始时间/最早截止、步骤延迟出现、验签后实际步骤终态和有界输出回收已纳入校验。真实本地 collector/freezer、spec/run/job、步骤起点须在对应真实结果产生后固定，DRAFT 当前不可执行。

下一步按[单引用精确草案](../../../.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/source-fresh-416-partial-replacement-proposal-DRAFT/OWNER-review.md)取得负责人确认，再预留一次新 spec 并独立回读、派发一次同候选 RC。Environment 前完成所有固定绑定和入口审核，启动已就绪的协调进程后才准入；保留全部真实验签与 ACK，慢调用只允许有界失败，不自动重试。原 RAM、E25 签名/双归档/公开安装维持完成；两项迁移与 R4 继续等真实 R2/R3 依赖。

后续离线准备已补齐[79fe 固定 collector/freezer](../../../.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/source-fresh-e26-handoff-DRAFT/FIXED-TOOLS-REVIEW.md)，新增清单 SHA `8a586e24…`；原 handoff/owner 清单不变。原始与 canonical 提案摘要分别钉定，批准收据须与真实用户回复核对；输入为实际 request、run/job GET 原件及其摘要。单组本地合成检查走通完整渲染与 freezer 输出、相对导入、运行期步骤时间和三层哈希，独立静态审核通过。审批和真实绑定未取得时不生成可执行输入。代码与固定脚本审核在 Environment 前完成；准入后的产物校验由同一 handoff 自动执行，不再插入模型审核轮次。

### 79fe 单引用批准后的实际进展

负责人已明确批准单引用替换草案，实际批准收据为 `0b02d179…`；此前待批状态已解除。一次新 spec 预留和独立 Readback 均已成功：ref `79feaa9a-f5ba-4a48-a781-e406726e6580`，creation spec `b657a22b…`，readback 原件 `ccd07c6a…`，三项清理完成。仅替换 sourceFresh，其余三个精确引用、业务候选、成功构建、snapshot run 与执行截止均不变。新 RC 请求和单次 dispatcher 已冻结，待有限独立审核通过后触发；Environment 继续 HOLD，待真实 run/job 绑定和全部交接代码审查完成。

### 79fe 本次失败后的最新收口顺序

本节取代前述“79fe 待批准/待执行”状态：单引用批准已执行，一次预留、独立回读和唯一 RC 均完成。source-static 与 admission 验签通过；H1 创建 POST 失败，无 ACK/CLOSED，清理完成，失效 RC 已取消并取得终态日志。事实与归因边界见勘误 E27；不再次启动 79fe 或派发新 RC。

1. 离线核定连接后至少 10 次 GH 复核与 hosted 120 秒 idle 的相容性，以及客户端 5 秒/服务端 10 秒创建请求时限。先确定消除等待的最小改动，保留 authority/revocation/current-job 复核、durable consume 和单次发送语义；不能靠增大超时遮盖另一处缺口。
2. 当前实际首因因诊断合并仍未明。只补必要的阶段耗时/终止原因和两个局部时序用例，先证明修正；不重跑业务构建、全库/全链或已通过协议检查来替代定位。已执行的 PowerShell DateKind String 修正保留，后续入口审核须经过真实 JSON→类型→UTC 消费路径。
3. 修正及独立审核完成后，核定实际源码/控制 bundle/签名/精确对象的绑定影响，再准备所必需的处置及精确差额。不得先选新 ref 再让线上执行发现遗漏；新 RAM 权限仍遵守负责人精确确认要求，原 RAM/签名/归档无无效事实不得重做。
4. 取得真实 sourceFresh CLOSED 后，依次完成 snapshot initial 与完整封存、其余 R3 三组合、两项 Staging 迁移及 R4。阶段 1 尚未收口；当前没有 sourceFresh 成功或数据库验收结果。原截止 `2026-10-08T06:53:54.742Z` 不变，所有真实操作仍按完整预算重新核验。

连接顺序核定：已批准的[创建前原生通道设计](../specs/2026-09-28-stage1-r3-target-policy-slice.zh-CN.md)要求消费前确认连接身份，随后在同一连接单次交付。不得将首次连接简单移到 consume 之后来消除闲置；修正须保留该边界，先完成可审查的时限/握手设计与有限本地验证，再核定新实际绑定。现有首因证据不足，不为补诊断立即触发新线上尝试。

### E27 有限修正设计与验收边界

本次只调整既有 R3 创建控制链，不改变目标能力或业务逻辑。仍按“建立受限连接 → 全部权威/当前 job 复核 → durable consume → 同连接单次 POST”执行；不缓存、删减复核，不放宽签名截止、job 窗口、hosted 120 秒连接 idle 或 UNKNOWN/槽位保留规则。

- 从成功连接起使用进程内单调时钟和固定共享窗口；校验及消费阶段限 90 秒，POST 独立最多 15 秒且不晚于连接后 110 秒。嵌套调用沿用原起点，外部不能注入时钟、I/O 或预算。90 秒是为当前 120 秒 idle 留出 POST 与调度余量的保守上限，不代表慢调用已被证明能成功。
- 同次 admission 内互不依赖的 run/job GET 并行读取，并等待两者都结束后再验证。各次签名/消费前后及租约复核仍执行；独立操作之间不并行。不让返回失败的 Promise 留下无人等待的另一个 GET。
- 受限窗口向已有 GH/租约子命令传递剩余预算；启动前和完成后均检查，窗口外行为保持原样。超时或提交前断连时终止可取消的子进程并等待其实际退出；不能用 `Promise.race` 提前返回而让消费在后台继续。同步持久化不能被普通 JS 定时器强制中止，返回后仍须检查截止和连接；一旦消费已发生，失败必须保留 UNKNOWN，禁止 POST、重消费或重放。
- 首因诊断只增加有界原因分类，区分窗口耗尽、连接预先关闭、POST 超时/请求失败/响应不完整；不写请求正文、URL、令牌或原始堆栈。保留既有公共错误和八字段诊断结构，核对 owner 消费端白名单；不修改已执行的冻结包。

有限验证只覆盖新增风险：共享窗口不可重置、连接后复核至消费的截止/断连、消费后拒绝迟到 POST，以及真实本地同一 socket 成功单次 POST（含合法较慢响应）。保留有效 RED→GREEN 证据；不运行真实 GH/H1/DB、全链或业务矩阵来定位。独立审核后先核对控制入口及候选绑定，再决定后续实际处置。此前 79fe 已在 POST 阶段失败、无 ACK/CLOSED；宿主清理与取消成功不能替代目标清理证据或槽位释放许可。

本轮 preflight：Prisma validate 通过；受控服务器 datasource 的 migrate status 返回 128 项迁移、仍只有 `20260925090000_stage1_operational_completion_terminal_shape` 与 `20260925091000_stage1_operational_completion_settlement_guard` 待应用，临时隧道已关闭。未执行迁移或业务代码修改。

独立[绑定核定](../../../.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/e27-connected-window-binding-impact.md)确认：79fe 固定 owner 加载 ba checkout，trust 要求 exact HEAD/clean，R3 模块属于签名候选合同。不能给旧目录打补丁或使用未绑定的新代码继续旧 ref。修正后必须用实际新候选及其 build/spec/owner/同源 snapshot 授权和 admission；R2 adapter 若未改仍可保留，旧签名和归档保持历史原件。该必要重绑定不等于立即重跑；先完成本地修复和 79fe 精确台账/两锁只读核查，准备完整处置及实际差额后再进入下一次真实链。

E27 当前本地修复、19 项定向测试及独立审核已完成；同连接成功用例增加实际 5100 毫秒等待后的单例验证也通过。合同摘要为 `sha256:e51d63465749061655bad46516a01f3e7eff31dff58eacdaec6dc7b0635c95ad`（326 文件、93 schema、128 migration、13 command contract）。八字段诊断保持不变，以有限首因码定位本次边界；没有新增对历史运行耗时的推断。以后新 owner 包须同步核对原因码白名单，旧冻结包不修改。

79fe 一次只读取证及独立回读已完成，确认消费/UNKNOWN/真实 closing/双槽锁，取证后两加密卷关闭。当前先清理已核验的专用传输进程和空 tmpfs，保留 journal 与锁；随后提交该事故精确处置草案。新的候选整合、构建和授权准备须等待这一残留边界核定，避免独立修复分多次触发无必要 CI 或在状态未闭合时开始新 R3。阶段 1 仍未收口。

清理阶段 G3 补充：首个固定进程退出观察误判后，先取得实际部分状态，再对剩余三个固定身份准备独立续行；保留原 before/失败且不得重跑原退役入口。审核须覆盖 executable 先消失、进程仍处于退出过渡态的情况，发送信号前和退出等待使用不同断言。有限验证只针对这个状态边界，不增加线上 R3、数据库或业务回归次数。完整传输退役仍以实际结果和独立读回为准，不能由部分清理推导。

上述传输续行现已执行并独立读回通过（`444260` / `cc1d4f`）；清理阶段完成，原 UNKNOWN 与双槽锁仍保留。下一步是负责人确认固定 79fe 事故的未决失败处置及双锁保留式退役；现有单引用替换批准已经执行，不能充当新的事故分类批准。处置须保持真实失败、禁止旧 ref 重放且不授予发布成功。随后将必要控制修正一次整合，再以实际新候选绑定准备后续必需链，开始前重算完整余窗，不提前触发新测试。

### f9 失败后的当前顺序（2026-10-09）

此前段落是历史状态；当前实际结果以 [f9 勘误](../../acceptance/2026-10-09-stage1-f9-execution-errata.md)为准。f9 的 RAM、归档、公件安装完成，RC `37905443583` sourceFresh 在 H1 delivery 准入失败，无 ACK/R3 CLOSED。只读台账与正式 IDLE 核查已完成，限定范围内无消费，真实 H1 session CLOSED；不得重放旧 ref。

1. 仅修复已证实的准入诊断丢失：在 attestation、run API、job API 的现有命令与解析边界保留有限原因分类，保留已有可信首因。保持外部错误、八字段诊断、准入条件、单次语义、清理和窗口，不新增重试或保存秘密。
2. 仅做有限诊断单元与真实 reader fixture 定向 RED→GREEN，验证非零退出、timeout、坏 JSON、可信首因和保密性；原生 Linux 使用既有 root-owned 源码及私有 TMPDIR。未到断言、Windows skip、事后已结束 job 的查询均不能充作验证成功或原始首因。
3. 一次独立审查后核定源码、合同和真实构建绑定影响，整合为一个候选；不为补日志提前触发真实 R3。新候选精确签名和新增 RAM 权限仍按实际必要差额确认，不修改历史批准或获批原字节。
4. 新候选须取得实际 sourceFresh CLOSED，才进入同源 snapshot 与其余三条 R3、既定两项 Staging 迁移和必要 R4。固定截止仍为北京时间 10 月 10 日 00:00；按完整预算判断是否可执行，不能自动续期或以子步骤剩余时间替代总预算。
