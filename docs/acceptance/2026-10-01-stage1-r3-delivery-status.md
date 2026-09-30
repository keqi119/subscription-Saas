# 阶段 1：R3 证据交付增量

本轮范围是用户已批准的 H1 与 hosted job 双向证据交付，以及 source/fresh 调用器。阶段 1 尚未收口；本轮不推送、合并或触发工作流。

## 已实现

- 固定文件名的 SFTP 交付、完整作用域和摘要校验；文件到达后仍由既有 native 导入器验证。
- H1 先启动既有 native holder，再开放独立的证据通道。hosted 保持一个 SFTP 连接和一个独立转发连接。
- H1 成功执行后要求负责人在真实终端输入准确的 `ACK sha256:...`。成功、错误摘要和 EOF 均不能代替确认。
- hosted 等待 H1 导入清理证据，关闭转发并确认真实进程退出；H1 复查原 UID 994 和固定端口关闭条件后才能生成 CLOSED。
- hosted 收取 CLOSED 后写入绑定其确切摘要的交付回执；回执只允许清理临时交换目录，不赋予执行权限。
- 固定 creation spec、当前 hosted job 描述、同一临时 Ed25519 密钥的 SSH/签名格式和 H1 artifact 导入；不接受路径、主机、命令或凭据替换参数。

## 验证边界

本轮 Linux 短测 `93e639` 自然退出 0：12/12，通过且无跳过，耗时约 12.3 秒。覆盖传输编码、稳定文件读取、临时密钥、固定输入和调用顺序。SSH 私钥格式通过真实 `ssh-keygen` 校验；artifact 解码使用真实 Python ZIP 读取。GitHub、核心 holder 和部分外部进程边界使用测试替身，这些结果不代表真实 CI 或数据库验收。

原完整 core/private-file 组合 `bed605` 已通过并保留，本轮未重跑。限定 Node lint 和格式检查 `19f3ed` 通过；测试后的 WSL swap 恢复已由 `5256e5` 读回。数据库测试发现 `3ee409` 为 99 candidates、39 manifested、60 excepted、0 unclassified，迁移文件未变。

隔离 H1 OpenSSH 探针 `50c003` 完整输出 `PROBE_PASS`，自然退出 0。同一个持久 SFTP 会话完成上传、改名和读取，独立转发进程退出后仍可取得 CLOSED；已认证连接的 shell、转发、链接和 outbox 写入均被拒绝。只读清理回查 `658de9` 确认临时账号、组、目录、挂载和 sshd 进程均无残留。早期探针因脚本传递和清理诊断问题失败，未计为通过；成功探针的临时日志按约定清理，结论保存在工具输出中。

整合审查发现并修正三个权限兼容点：H1 出站目录和文件显式设为 0750/0640，避免父进程 umask 0077 去掉 SFTP 读取权限；hosted SFTP 子进程继承 umask 0077，启动后立即恢复父进程原值，保证下载文件为 0600。后者先由 `ed1205` 复现失败，再由 `d4557b` 短测通过（2/2，无跳过）。H1 通知完整写入 `.part` 并复核后，通过原子、禁止覆盖的链接发布最终名，再删除临时名，避免轮询读到半份通知。

H1 正式配置已应用（`c0064c`），备份位于 `/var/backups/stage1-r3-evidence/apply.K5WXwwXV`。新管理 SSH 会话回读 `0bbaa7` 通过：证据账号 UID 993、GID 989，仅自己的组，密码锁定且无 sudo 权限；公钥为空、交换目录未挂载。维护脚本比较 root 与原转发账号配置的前后输出一致，`sshd -t` 通过，只有原有 RSAAuthentication 弃用提示。

首次应用 `9fcf00` 因把 `sudo -l` 的成功退出误当成具有授权而回滚；`439fd1` 确认账号/目录不存在、主配置与备份一致。修复后要求 C locale 的完整单行拒绝结果，其他输出拒绝通过。随后只读检查发现循环读取同一 process-substitution 流会耗尽内容，已改为完整读取一次再逐项核对；最终 `0bbaa7` 才是成功回读。本轮未操作数据库、原转发账号或业务容器。

整合审查完成，已报告的问题均已修正，没有剩余可证实的 P1/P2。最后仅复查受影响的适配器：`d07184` 为 4/4、无跳过，自然退出 0；维护脚本语法及差异检查通过。限定源码 lint 与合同检查 `645eeb` 通过：263 文件、87 schemas、13 commands、128 migrations，仓库合同摘要为 `sha256:d708f308a7e6e0b3d33135717c0bb71f9cd3a6d6c1ed3ec7d6ee0129af62931b`。真实 native Node 双端调用仍待受控 CI 接线后的运行，不能用隔离 OpenSSH 探针替代。

## 阶段 1 剩余顺序

同日后续增量已将 source/fresh 的实际完成结果映射为既有 `source-gate-evidence.v1`。来源是 native 持有并核验的 execution、result、重建 manifest、实际 PostgreSQL 身份和固定 job；完整计数等式、候选、CI run 与摘要必须一致。H1 仍须经过负责人 ACK、清理和真实 CLOSED 才交付，不能把 CLOSED 状态直接当作数据库通过。

hosted 现在先以禁止覆盖方式保存并读回固定公开文件 `.release-output/source-fresh/source-gate-fresh.v1.json`，随后才发送确切 CLOSED 回执、关闭通道并删除临时私钥。公开目录/文件显式为 0755/0644，兼容私有进程的 umask 0077；不会复制私有原件。保存失败或已有文件时没有回执，保留失败状态与交换现场。这一顺序调整防止交换清理早于公开原件落盘。

source 原件短测 `5a726e` 为 1/1；caller `2b4b06` 先复现缺少交付字段，`df0075` 修复为 2/2。最终受影响的 transport/adapter/caller 短测 `769b9b` 为 8/8、无跳过，约 11.7 秒。独立限定审查未见可证实的 P1/P2。格式、限定 lint 和合同检查 `2016b0` 通过，仍为 263 文件、87 schemas、13 commands、128 migrations；本增量仓库合同摘要为 `sha256:cbd874834bce9c87a9af42136be8ad0207ffbfc03adae58d497d0e0e689129d6`。外部 GitHub、SSH、native 和数据库边界仍有测试替身，未据此宣称真实 RC 成功。本增量未修改服务器、工作流、迁移或业务代码。

随后 source/fresh 工作流接线已完成：使用受保护的 Ubuntu 24.04 hosted job、既有 H1 creation-spec 输入、当前 job 公开描述的 attestation/单文件上传，以及 CLOSED 公开文件核对；之后继续原有 RC attestation、上传、回读和 custody。它不会自动代替 H1 import、owner 启动或负责人 ACK。初次 SFTP 等待放宽为最多十分钟，并始终受准入到期时间限制。root Node 使用 setup-node 选出的绝对路径；三个公开文件上传显式包含隐藏目录内的准确路径。

工作流 DAG 短测由 `94556b` 失败转为 `e29a9c` 通过。`sudo` PATH 覆盖已由 `e6462b` 实际复现，修正后的绝对 Node 路径由 `2be64c` 运行成功。最后 `afee9d` 为 DAG 1/1、YAML 重复键检查、五段 shell 和两段内嵌 JavaScript 语法通过。增量独立审查无剩余可证实 P1/P2。工作流尚未推送或触发，hosted Engine/containerd 的实际兼容性仍待真实执行；本地与服务器的服务、swap、数据未因 YAML 修改而变化。

1. source/fresh 接线已具备代码与静态验证；真实 CI 运行仍待同候选执行，H1 需先用既有 `prepareR3SourceFreshSpec` 预留操作，运行中用 `importR3SourceFreshJob` 导入准确 job artifact，再启动 `run-r3-source-fresh.mjs --side h1 --operation-ref ...` 并由负责人确认实际终态。
2. 沿同一路径接通 source/snapshot 和两个 final 分支；快照必须有明确、合法的数据库来源。现有 OSS 加密恢复卷不是数据库快照。
3. 固定同一候选完成实际 R2/R3 双链。此前模拟外部边界的检查不得替代真实执行。
4. 按已批准范围对齐 Staging 两项待迁移，再完成 R4 真实验收与收口记录。

不新增业务功能，不引入商用 KMS，不扩大测试矩阵。已批准的 SSH、Docker 和账号配置无需重复申请。

## Snapshot 公开结果增量

source/snapshot 已沿用 fresh 的公开结果投影入口。native holder 保留已有双保管核验的 snapshot 完成 execution/result，与源测试的准备前驱摘要、同一操作/会话/目标和实际 admitted 元数据逐项绑定。bundle 摘要来自既有准入声明，只有实际 consumer 完成记录匹配时才用于公开结果；它本身不冒充保管回执。公开 ownership 摘要取自该完成结果内各数据库的真实观察摘要。当前返回精确元数据，后续仍需接通两端 snapshot 调用和 hosted 固定文件保存。

既有 source-original 测试增加纯投影用例：缺少消费结果、错误前驱、跨会话、final 消费结果、目标或元数据不符、空/重复观察及时间倒置均拒绝。`7d36d7` 先复现缺少 helper，`cd4a0a` 为 1/1 通过且无跳过；该用例的数据库和 CI 边界是合成输入，不是实际快照验收。`bda41c` 限定 lint、差异和合同检查通过：263 文件、87 schemas、13 commands、128 migrations。没有重跑长组合、变更数据库或启动 CI。

既有 CLOSED 消息与 H1 适配器已支持共同交付 source/snapshot 的公开 gate 和精确元数据。元数据摘要、迁移头、ownership map 必须与 gate 一致；fresh/final 消息不允许混入元数据。仍使用原文件名、完整消息的精确回执和 1 MiB 限制，不增加权限。codec `d8bec6` 先失败，`1cb3ce` 为 4/4 通过；最终 Linux codec/hosted adapter/既有 fresh callers `a1f3d6` 为 8/8，无跳过，约 19.2 秒。限定独立审查与小范围补充核对均无可证实 P1/P2。`1cf632` 限定 lint、差异和合同检查通过，仓库合同摘要 `sha256:da90f03f8d10e2abab1be886173aed698de06197bfcafbd0dba0a25b6d36952a`，迁移摘要未变。

final 字段追踪确认还有独立执行缺口：native `matchingSourceEvidenceDigest` 指向 source 终态 execution，aggregate 所需摘要指向公开 source-gate 原件，两者不能直接互换。native final 数据库 manifest 成功也不包含旧 final-compose 的 Compose、API 进程/会话/就绪检查、真实浏览器请求和分阶段保管证据；后续必须复用并执行这些既有检查，不能填充虚构的 `PASSED`。
