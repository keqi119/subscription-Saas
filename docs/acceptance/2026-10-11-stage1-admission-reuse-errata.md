# Stage 1：准入重复验签与分段复用勘误

本条续接 [启动计时勘误](2026-10-10-stage1-startup-timing-errata.md)。RC `38109132623` 已取消，未进入负责人 ACK，没有 R3 CLOSED。本地修复和合成测试不替代正式四链验收。

## 实际失败与分类

| 问题                          | 已有证据与分类                                                                                                                                                                               | 后续方案编写、审核时的检查                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CALLER 再次执行准入在线验签   | H1 在 `H1_CALLER / ADMISSION` 报告 `R3_JOB_ATTESTATION_COMMAND_TIMEOUT`；同一 Node 调用中 IMPORT 已验证准入，但返回字节并关闭 owner，CALLER 再开 reader。属于可修复的生命周期/重复工作问题。 | 不把 bytes-only 返回当成保留已验证对象；检查实际 owner wrapper 是否在 awaited callback 中使用原始 owner。  |
| GitHub TUF 根请求长时间未完成 | gh 子进程约 120 秒后被终止，最后未配对 HTTP 阶段是 `TUF_GITHUB / TUF_ROOT`，约 108 秒。该外部请求停滞的服务/网络根因仍 UNKNOWN。                                                             | 单独记录在线请求事实；不能把未知外部停滞全部归咎于应用代码，也不能因本地测试通过就宣称网络故障已解决。     |
| CLI 的缓存未避免根元数据更新  | 对官方 gh 2.101.0 与 2.102.0 对应源码核对，依赖、嵌入根及相关路径相同；嵌入的旧根会使本地刷新失败后重新在线更新。实际缓存存在且时间新鲜。属于已确认的客户端成本放大机制。                    | 不把“缓存目录存在”或“缓存很新”当成无网络验证；不替换未验证的信任根、不跳过签名、不盲目延长时限或升级 CLI。 |
| 准入持有期间再准备目录        | 固定 reader 会持有受保护路径。稍后创建 observations/snapshots 父目录可能使旧身份快照失效。属于准备顺序问题。                                                                                 | 在最终 admission 打开前准备目录；后续重复准备必须无变更，并用真实文件 reader 验证其仍可 recheck。          |
| 清理覆盖主要诊断              | consumer 运行时间变长后，finally 中的关闭失败可能覆盖原有 H1 错误。属于错误处理问题。                                                                                                        | 同时保留主失败阶段和 cleanupCode；关闭全部句柄，不能把清理失败写成成功。                                   |
| 测试事件残留                  | 同文件前一个 hosted 测试留下 events，后一个 caller 测试把历史事件当成本次序列。属于测试隔离缺陷。                                                                                            | 每项测试初始化事件与计数；单独测试通过后，至少保留一次相关组合执行。                                       |
| 测试挂载目录权限不同          | 从 Windows DrvFS 直接运行受保护路径测试不能满足原生 Linux 路径约束。属于测试环境配置差异。                                                                                                   | 用原生 Linux 目录中的源码快照及原生临时目录运行；前置失败、跳过与真正通过分别记录。                        |

## 本次修复边界

`importR3*Job(input, consume)` 可选传入异步 consumer；准入原件仍执行首次 GitHub 验签。consumer 被完整等待，随后统一关闭原始 owner。原 bytes-only 接口保留。

H1 caller、目标创建、转发租约、创建会话、证据传输及 hosted evidence/cleanup reader 复用同一个原始 WeakMap owner，通过已有 borrower 每次重新检查当前文件、主机/负责人、创建规格、有效期、构建状态与 run/job API。没有磁盘验签缓存、跨进程复用、跨 RC 复用或自动重试。借用者关闭不能关闭原始 owner；原 owner 关闭后不可再借用。最终历史回读仍独立验证。

上述首次修复消除的是同一 live admission 下游重复验证。9c65de4 发起前复查确认，导入阶段三个 creation reader 仍各自验证 proof/receipt，实际 owner wrapper 的 `OWNER_SPEC` 还会各验证一次。同一负责人调用合计 proof 4 次、receipt 4 次、admission 1 次。这是尚未处理完的代码重复调用，不是新的环境抖动；因此 9c65de4 长链尚未发起。

## 构建证明与回执重复验证补修

补修仅在同一 `repoRoot + operationRef`、同一进程的受控异步作用域内，复用成功的 proof/receipt 密码学验证结果。实际 owner wrapper 的 `OWNER_SPEC` 与 importer 必须共同使用该作用域；只改 importer 会遗漏入口处的第四次验证。

每次重新打开仍检查受保护路径、文件身份、原字节摘要、source/contract/profile、有效期，构建成功状态以及当前 run/job 状态仍实时回读。退出作用域后不再可借用；失败结果、跨操作、跨进程及独立历史回读不复用。验签命令参数也必须完全一致。此修复不延长时限、不跳过初次签名检查，也不改变真实终端 SOURCE／SNAPSHOT／ACK 要求。

局部 RED 已用原生 Linux 的真实 reader 复现：importer 内 proof 验签次数为 3，断言预期为 1，admission 仍为 1。补修后，真实 reader 的导入复用、完整 `OWNER_SPEC → IMPORT` 共享、原件变化拒绝三项通过；修正后的清理失败负例单独通过，无跳过。完整入口计数为 proof 1、receipt 1、admission 1，动态 API 回读仍增加。独立代码审查无剩余阻断，四个未绑定新候选的 STOP 入口模板通过语法和结构检查。请求次数减少不能作为外部 TUF 请求停滞已经解决的证据，也不代表正式 R3 已通过。

补修中的定向清理负例曾把“同一路径第一次打开”当成内部验证句柄，实际命中外层 reader，导致 `Missing expected rejection`。这是测试定位缺陷，不是环境抖动或实际发布失败。后续故障注入必须对应被测层的实际关闭阶段，并检查确实触发；只修正、重跑受影响用例，不重复已经通过且源码未变的用例。

现有模拟 writer 用例在导入前被本机 `/dev/shm` 的 1755 权限阻断，代码要求 1777；同环境未修改的 9c65de4 基线也复现相同错误。这是确定的测试环境配置差异，既不算补修回归，也不算通过或偶发网络抖动。未修改共享挂载权限，未重复该组合。补修原始记录位于本工作区 `.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/build-attestation-import-reuse-fix/`。

## 下次发起前

1. 复用未变且仍有效的前段成果，先完成本补丁的局部验证、审查和 CI；失败时只回到受影响分段。
2. 生成新的 create-only owner wrapper，将实际摘要和 run/job 绑定核对置于 awaited consumer 中，再调用对应 `runR3*H1(selector, owner)`。只修改源码而仍使用 bytes-only wrapper，不会消除 IMPORT→CALLER 的重验。
3. 063 已冻结 wrapper、运行、once 目录、签名和失败证据保持原样；新源码须按真实候选重新绑定，不沿用旧候选批准。新 RAM 差额按既有要求单独确认。
4. 发起前核对签名截止与当前时间、GitHub Execute 起点和剩余预算、正式 IDLE/历史消费状态、固定 run/job/ref/digest；不以“窗口正常”代表准入或执行成功。
5. 本地检查通过后仍需实际 SOURCE／SNAPSHOT／ACK；未取得真实 ACK 和独立 CLOSED 前不得宣称 R3 或阶段 1 收口。

## 验证记录

局部记录位于本工作区 `.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/attestation-reuse-fix/`。

- 首次原生 Linux RED：6 项中新增的 2 项失败，原有 4 项通过；实现后同范围 6 项通过、无跳过。真实 reader 验证了一次 admission 验签、动态 API 回读继续增加、借用关闭不影响 owner、owner 关闭或作业终止后拒绝复用。
- 清理覆盖诊断的定向 RED 失败；修正后与两个 callback 生命周期用例组合执行，3 项通过。主失败阶段与 cleanupCode 同时保留。
- 创建/清理证据两个真实 reader 以及 final 目录准备检查通过；创建/清理 reader 的断言确认未追加在线 attestation。
- 实际 launcher 的借用边界检查通过：传递真实 owner 时会动态回读，伪造对象在原生 readiness 前被拒绝。该项主动停在 readiness 前，不模拟发布成功。
- caller、交付及密钥编码组合中 8 项通过；另外 2 项输入安全前置失败，在未修改的 HEAD 代码上同样复现。进一步回读发现共享 WSL `/dev/shm` 为 1755、`stage1-keys` 为 0755，且 swap 已启用，不满足这些测试要求。没有修改共享环境或把这些项写为通过。
- 较大组合测试触及 300 秒本地预算；单条带诊断复核走过目标创建，进入证据导入后触及 150 秒预算。它们未完成，不能归类为通过或声称根因已查明。后续采用上述传递边界与实际 reader 的分段结果，不反复运行完整组合。
- 合同验证、改动文件格式及 diff 空白检查通过。没有触发新 RC，没有实际 ACK 或 R3 CLOSED。

首次补丁开发前 Prisma validate 通过，migrate status 曾因当前 shell 未注入既有 datasource 配置失败。后续补修复用服务器历史配置完成实际回读：共 128 个迁移，仍有 `20260925090000_stage1_operational_completion_terminal_shape` 与 `20260925091000_stage1_operational_completion_settlement_guard` 两项待应用；Prisma validate 再次通过。本补丁不修改业务、迁移或数据库，也不代表这两项已发布。
