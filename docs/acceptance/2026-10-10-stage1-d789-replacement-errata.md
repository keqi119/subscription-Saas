# d789 替代执行失败核查与下一轮勘误

本记录承接[多轮勘误总表](2026-10-07-stage1-execution-errata.md)及[启动计时勘误](2026-10-10-stage1-startup-timing-errata.md)。C 为证据已确认的代码或编排缺陷，P 为执行前拦截或取证工具错误，U 为实际首因未确定。环境抖动须有独立证据，不能从慢调用、泛化错误或后一次成功倒推。

## 当前实际结论

负责人批准的唯一一次替代 RC **38018148143**，源码 `d789f752c477bd58294eb267d06e75da1a0b42f0`、构建 `37966656094`、sourceFresh job `114113872845`，已经 **completed/failure**。source-static 成功，后续七项任务被跳过。用户报告终端窗口错误；未取得人工 ACK、source gate 或 R3 CLOSED。

这次不能沿用原 RC `38015957129` 的“未绑定、未消费”结论。受保护只读探针及独立回读确认：

- operationRef：`eb5a1850-8fb0-4bbd-a832-9e99be5d166a`；session：`717ac0f0-a136-4f87-ba89-fe5daef4cc97`。
- 存在一个 `CONSUMED` 槽、一个 `INTERRUPTED_UNKNOWN` execution，原生 session 最终也为 `INTERRUPTED_UNKNOWN`，不是 CLOSED。
- 两个固定 forward-slot 锁存在，均绑定本次作用域，原内容摘要均为 `sha256:36a008ab0032f5451eb87da7ba1949d2f69f1e86ea78d1e147f12957141e8a0e`。没有移动、删除或重置这些锁及历史记录。
- 签名于 `03:02:18.098Z` 签发、`03:07:18.098Z` 到期；实际错误发生在 `03:03:27Z` 附近。本次签名过期可排除。
- H1 主加密卷与恢复卷已关闭、swap/core 设置恢复。空 evidence tmpfs 已在全局互斥下保存清单、只读重挂、普通卸载；未删除文件内容。独立正式检查为 exit 0、明确 IDLE。这仅证明本地传输收尾，不证明 hosted 工作区不存在或已销毁。
- 快照 `37973517957` 的 data job `113966064003` 在 `03:14:35Z` 独立回读仍为 waiting，未放行。

全部时间为 2026-10-10 UTC，北京时间加八小时。失败引用不得重放；本轮没有再次触发 RC、快照数据任务、迁移或 R4。

## 时序与错误边界

| 事实                   | 观测结果                                   | 可得结论                                                                 |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| Execute 开始与启动截止 | `02:52:49Z` → `03:02:49Z`                  | 600 秒起点来自实际 job step。                                            |
| 采集准入               | attestation 实际耗时 29264 ms，采集完成    | 本轮未重现原 15 秒采集预算失败；30 秒上限未改变。                        |
| SIGN_HISTORY           | `02:58:56.343Z` → `03:02:18.098Z`，成功    | 201754 ms 是实际阶段耗时；不能将其当成本次失败根因。                     |
| socket_connected       | `03:02:44.069Z`，余量 4931 ms              | 本轮启动连接通过。代码在连接时清除启动 timer；后续错误不能归为启动超时。 |
| 授权消费               | `03:03:14.717Z`                            | 一次性授权已经使用，不具备重试资格。                                     |
| H1 失败                | `H1_CREATE / ACK / H1_INPUT_UNAVAILABLE`   | 已进入 ACK 阶段；细分校验失败位置未保留。                                |
| hosted 失败            | `HOSTED_CREATE / WORKSPACE / UNCLASSIFIED` | HTTP ACK 发出后进入工作区创建；具体子步骤未保留。                        |
| 原生 session 收束      | `03:03:31.944Z`，`INTERRUPTED_UNKNOWN`     | 只能确认未知失败收束，不能冒称成功 CLOSED。                              |

两端并发，现有证据不能证明哪端先失败。H1 在 ACK 内保存响应时会再次校验固定输入与租约；hosted 工作区创建也有独立校验和命令。两条可能路径均保留，不能因看到更细的 hosted 标签就认定它是全局首因。

## 按机制合并的勘误

| 类别                 | 本轮事实与归类                                                                                                                                                                   | 下一轮方案编写、审核时必须落实                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 时序差错             | C：原 d789 采集器从此前实际使用的 30 秒 attestation 退回 15 秒；已在替代执行前修正。U：原慢调用原因不明。                                                                        | 从最后实际执行原件提取 API/attestation/外层预算；逐层核对，不从较旧模板复制。保存各阶段起点、结束和单调耗时。                                                                             |
| 绑定过期签名         | 本轮已通过持久原件排除到期；不能因此放宽其他运行的期限。                                                                                                                         | 同时核对 source/build/ref/run/job/attempt、原件摘要、issuedAt/expiresAt 及实际使用时刻；不得仅凭“签过名”判断可用。                                                                        |
| 历史状态残留         | 本次确有消费和 UNKNOWN，且失败后空 evidence tmpfs 保留。原取消运行的未消费结论已失效。                                                                                           | 当前 ref/session 独立对账；将传输 IDLE、加密卷关闭、事故处置、R3 CLOSED 分开。失败取证不要求先删除现场，新执行必须重新通过正式 IDLE。                                                     |
| 不稳定错误定位       | C：workspace catch 统一改写为 `R3_HOSTED_WORKSPACE_CREATE_INVALID`；诊断白名单缺少该码。caller 再包装时丢弃 `creatorFailure`；失败 job 的正常 gate/custody 上传步骤被跳过。      | 在现有边界保留固定子阶段和安全错误码，验证它们能通过最终 caller/owner 收集器。禁止直接输出原始异常、命令参数、stdout/stderr、私钥或请求正文。仅补白名单不足以定位子步骤。                 |
| 同类历史漏点         | C：588 事故也曾报告 `HOSTED_CREATE / WORKSPACE / UNCLASSIFIED`；之前的局部消费诊断修补没有覆盖这一条失败传播路径。                                                               | 审查对象应是完整错误传播链，而非单个 formatter；用离线故障注入验证 workspace → control → caller 与 H1 ACK → owner 的结果。不能再靠一次整链运行发现同一诊断空洞。                          |
| 取证路径、字节与合同 | P：root 审查拦截 `/main/raw` 误定位、拒绝合法 0 字节 raw、允许任意字符串 HTTP status、说明文件时间字符串被规范化。另一次 root 激活漏填 hash 占位符，被本地守卫拒绝，未发起 SSH。 | 按生产实际 `archiveRoot/raw` 和原始 JSON 字符核对；固定占位符替换必须断言次数及最终值；普通 JSON 非空约束不能套到 HTTP 空响应。                                                           |
| 取证结果误判         | P：本地 stdout 与服务器 compact JSON 的原始摘要误直接比较；独立 IDLE 采集又错误要求 stderr 全空，重复遗漏已有 RSAAuthentication 弃用提示规则。                                   | 区分原文件、传输文本、解析记录的摘要；验证原字节和内容一致性各自的合同。按 exit 0、精确 IDLE 和已知有界提示判定，未知错误继续拒绝。两个误判均利用已保存返回纠正，没有重复执行探针或清理。 |
| 环境抖动             | U：现有证据不足以证明网络抖动、签名过期、死锁、磁盘不足或历史对象数量是首因。                                                                                                    | 未知保持 UNKNOWN；后续成功不能改写这次失败原因。实际扫描为 archive 38、journal 38 个 JSON，不能据此声称海量历史导致超时。                                                                 |

本轮取证准备中的漏点属于实施和审查质量问题，不能算作产品验收失败或环境问题。首次失败原件和纠正记录均保留。

## 后续收口顺序与开销约束

1. 保留本次 UNKNOWN 图和两锁；按现有事故处置机制准备本 ref 的精确负责人决定与现场绑定。原替代执行批准已经使用，不能覆盖新的事故处置或新 RC。
2. 正式测试保持停止。先离线补齐已证实的错误传播缺口，并对本次 ACK/WORKSPACE 路径作一次合同核查。限定验证：安全诊断不泄密、真实包装链不丢子阶段、原动作/错误与失败停止语义不变。已有通过且未改动的长集成测试不扩大重跑。该步骤只能修复定位能力，不能宣称已经修复本次未知运行根因。
3. 新运行前把勘误表逐项映射到实际生产入口、实际模板和实际审核证据；任何 unresolved 输入、旧 ref、已消费签名或未收束锁均阻断。不凭新的候选编号自动获得一次执行权，不通过延长窗口掩盖未解释的失败。
4. 完成适用的精确处置与新执行批准后，才按同候选四条 R3 链推进。四链全部通过后执行既定两项 Staging 迁移，再做聚焦 R4。datasource 复用已确认的服务器配置，不新建凭据；不新增业务功能、商用 KMS 或额外测试矩阵。

阶段 1 仍未收口。两项待迁移为 `20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard`。后续离线修补轮按仓库预检要求复用既有安全 datasource 读取器再次查询，仍为 128 项中这两项 pending，查询隧道已关闭；Prisma validate 通过。没有执行迁移或修改业务代码。

## 离线诊断修补及验证边界

已将工作区创建的失败拆为有限阶段，包含输入、前置检查、原状态观察、分配、各固定命令、挂载及最终观察。命令执行前的复查仍标为 PREFLIGHT，避免把未启动命令的失败记成命令失败；固定错误码和原私有证据保持不变。真实 control 和最终 caller 继承内部诊断，不输出原始异常或 raw 证据。

H1 的 ACK 记录顺序保持为响应头归档、响应体归档、校验 202 与空响应体，新增 ACK_RESPONSE、ACK_BODY、ACK_VALIDATE 三个定位边界。202 仍只表示送达。owner 解析器已准备纯 DRAFT 适配，尚未安装；冻结的实际执行文件未改变。此修补不能恢复本次已丢失的子步骤，不能据此宣布运行根因已修复。

限定验证结果：

- 工作区原有失败样例先 RED（没有诊断），修补后 GREEN；受影响工作区文件共 10 项通过。
- ACK 旧行为提取后两项 RED，增加诊断后所在文件 10 项通过，覆盖空响应归档、先归档后拒绝、有限码和不泄密。
- 本机隔离 Linux 中，真实 control 两种失败与真实 caller 失败传播共 3 项通过。固定工具、云端和密钥依赖为夹具，Unix socket 为本机实际通信，不等同于 H1 或 hosted 实际验收。
- owner 旧解析器拒绝新增阶段；DRAFT 接受 3 个 ACK 和 10 个工作区阶段，继续拒绝额外私有字段及重复键。实际替代窗口 owner 原件 SHA-256 为 `ce109747c9020f1a7cc5a9ee2ae70d2ce7d6dcd9a65e9110694e8373d44a33f0`，DRAFT 为 `8220e0a32f5e39510a9bd83025c289ab898c911b9e29e6cdffa34521e599cf98`。
- 发布合同校验通过（328 文件、93 schema、128 migration、13 command）；七个受影响脚本的 Node 专项静态检查通过。独立代码审查未发现阻断项。

本轮另外记录两项工具/夹具勘误，不能记作环境抖动：

1. 首次本机 control 检查因既有 `/dev/shm/stage1-keys` 为 0755，夹具遇到 EEXIST 后直接复用，在 INPUT 拒绝，未到预期错误路径。改在私有 mount namespace 的独立 tmpfs 中运行后通过；未改旧目录。后续此类测试须先保证目录隔离及权限，不能把 setup 失败当作目标用例 RED 或运行根因。
2. 直接套用仓库 ESLint 默认配置检查这些 `.mjs` 会缺少 Node globals；第一次专项配置又漏掉 object-rest 的既有排除惯例。这两次检查均失败，随后使用 Node globals、ignoreRestSiblings 和已有两个未用导入（http、canonicalH3）的显式排除才通过。仅报告该专项检查通过，不宣称仓库全量 lint 通过；下轮直接复用已核对的脚本检查配置。

本轮未触发新的 RC、快照或长链测试。事故处置仍等待本 ref 的精确负责人决定，已消费记录和两锁保持。

### 合并动作勘误与 CI 后续终态

PR #343 的 `gh pr merge --auto --squash --match-head-commit` 被 GitHub 立即合并为 `eac0159a16d600e87d946bd1f0d1ddfd7297f5e6`，并未等待当时仍运行的 PR CI。随后回读有效规则只含 deletion、non_fast_forward、pull_request，没有 required_status_checks；经典分支保护接口返回 Branch not protected。将 `--auto` 当作“无论配置如何都等待 CI”是操作判断错误，不是环境抖动。后续必须先检查有效规则，并在实际 CI 成功后显式合并；不依赖该参数提供额外保护。本轮没有改变仓库保护规则。

PR head 与合并提交的文件树均为 `6b8d29c7cbf12280c4aa95293f2bbd699063fb5a`。旧 PR CI `38021994846` 的重复检查已取消；合并提交 [CI 38022396411](https://github.com/keqi119/subscription-Saas/actions/runs/38022396411) 于 `2026-10-10T04:16:07Z` 全部成功，head 精确为 `eac0159a16d600e87d946bd1f0d1ddfd7297f5e6`。后续成功不改变合并时未等待 CI 的事实。初次 PowerShell 读取树摘要未给 `^{tree}` 加引号，读取失败；改用 `git show -s --format='%T'` 核对成功，首次输出未用于判定。此补充暂留本地，避免仅因勘误文案再次触发同一批 CI。

随后核对旧快照 `37973517957`：data job `113966064003` 仍为 waiting、没有执行步骤。为停止旧候选残留，已精确取消该运行；独立回读确认 completed/cancelled，data job 的 runner_id 为 0、步骤列表为空。没有放行快照数据处理，也没有删除已有准入原件或修改 RAM。完整失败 job 日志亦已保留：38355 字节，SHA-256 `393a6af8236fef513ea3deff7a71890acbd94aa23108a5ebafdaf56874acc357`；其未提供工作区子步骤或实际磁盘余量，不能补造首因。

## 证据索引

### 本次精确事故批准及执行前勘误

负责人随后确认 eb5a 精确事故草案（proposal `e73900c4…`，批准原件 `bedce8cb…`），仅允许保留 UNKNOWN 和已消费原件、将两枚固定锁按同一签名意向移入事故保留目录。专用处置入口已补入固定事故登记，未扩大为一般 UNKNOWN 豁免；新候选执行、RC 和 RAM 权限不在本次范围内。实际线上结果以本机事故目录的 `RECONCILIATION.json` 为准，不能把离线测试或 EXECUTED 标签当作独立回读完成。

执行前审查发现并修正两项可复发问题，均属于代码或操作模板瑕疵，不是环境抖动：旧 once 控制器会阻断已批准的部分移锁恢复，现仅提供必须持有同一批准、同一处置代码及既有签名意向的显式 Resume；顺序执行器不自动重试。安装回读模板曾把 Node 和公共清单套用私有 JSON 的 0600 权限，现场只读核实分别为 0555 和 0444，必须各自校验权限与原字节摘要。专用入口定向测试通过，涵盖原件保留、单锁中断、身份替换拒绝、同意向恢复和完成后的只读核验。发布合同校验为 329 文件、93 schema、128 migration、13 command，未触发新整链测试。

以下为本机保留原件；不会因本文提交自动发布到 GitHub。原始失败日志、probe 初版及读回误判均未覆盖。

- [实际失败 run/job/log 及快照状态](../../.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/candidate-d789f75-replacement-failure-38018148143-ACTUAL/)
- [受保护台账核查与字节表示纠正](../../.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/candidate-d789f75-replacement-failure-probe-v2-ACTIVE/RECONCILIATION.json)：服务器 result raw SHA-256 `95f537f20ba22241df661e30531b4bd66d38f48c7001955d5f839fcd51f140c4`，本地 stdout `813d93bb2c37fcbde452bbdb6562449f42bd3931d4338ece12c01a36db76e7c9`，独立回读 `2a9b7b3b407a6572c2129121dc4e5316b3f869e12c31771f3e775060068b3ded`。
- [空传输挂载收尾及独立 IDLE 回读](../../.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/candidate-d789f75-empty-evidence-retirement-ACTIVE/RECONCILIATION.json)：服务器 result raw SHA-256 `754c69c50c0bd780d5dc41645ec562c7427284151c57d7144bd9905f5c1ecae2`，独立回读 `1e668ae6ca27b84a003f620e725fa3f57f96db48c53127047c031a48eaf1e3f1`。
- [启动连接事实](../../.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/candidate-d789f75-replacement-window-ACTIVE/STARTUP-CONNECTION-VERIFIED.json)

可复核代码边界：`r3-hosted-workspace-create.mjs` 的失败包装、`r3-hosted-creation-control.mjs` 的 ACK 后 WORKSPACE、`run-r3-source-fresh.mjs` 的 caller catch，以及 `launch-manual-stage1.mjs` 的 `saveExchange("creation-ack")`。公开原件无法恢复已退出 hosted 进程中丢失的 `creatorFailure`，不以推测补造。
