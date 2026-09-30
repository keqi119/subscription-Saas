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

## Snapshot 两端调用增量

后续已接通 snapshot 固定输入和两端调用。H1 使用 `prepareR3SourceSnapshotSpec` / `importR3SourceSnapshotJob`，hosted 使用 `prepareR3SourceSnapshotHostedJob`；沿用同一固定准入器、临时密钥、artifact 和摘要核验，fresh 入口保持原行为。脚本 `run-r3-source-fresh.mjs --side h1 --operation-ref <uuid> --chain snapshot` 启动 H1 snapshot 调用；hosted 同样可用 `--side hosted --chain snapshot` 的固定模式。

H1 创建完成后显示实际 destination digest，在负责人终端等待 `SNAPSHOT <input UUID>`，用于选择已经按既有合同准备的固定输入索引。索引权限必须绑定刚观测的目标和当前 job；此输入不是批准合法来源，也不会自动生成权限。随后运行既有 consume/fetch/decrypt/copy/restore/cleanupSnapshot/completeSnapshot，再执行 source manifest、精确 ACK 和原有清理/CLOSED。

hosted 将 source-gate 与 snapshot metadata 分别以禁止覆盖方式写入 `.release-output/source-snapshot`，两份都 fsync/读回后才发接收回执。第二份失败时，保留失败状态和私钥，不发送回执；第一份已写公开文件不代表成功。input `e98104` 3/3、caller `347e1d` 2/2 通过，无跳过；限定独立审查无可证实 P1/P2。`6a4330` 格式、限定 lint、差异和合同检查通过，仓库合同摘要为 `sha256:995b57023313b9fa34430df8151c0805b798bd91c5ca0864afa807dba60fc03b`。测试外部边界仍为替身，合法快照来源/索引与真实运行仍未完成，工作流接线是下一步。

## Snapshot 工作流接线增量

source-snapshot 随后已改为受保护的 Ubuntu 24.04 hosted job，使用已预留的公开 `sourceSnapshotCreationSpec`、当前 job 的 attestation/import 和 snapshot caller。它在 source-fresh 成功后运行；当前工作流的 H1 并发组也跨候选 SHA 固定，以避免竞争同一 H1 通道。final 的两个旧执行分支仍待改接，尚未据此宣称阶段 1 可发布。

source 的旧明文 dump artifact 下载和旧执行器已移出该 job，由 native snapshot 准入/消费负责验证真实输入。返回 gate/metadata 的固定文件、摘要、规范编码均需一致；metadata.workflowRunRef 继续对齐所选 snapshotRunId，保留旧 final 所需的 run/artifact 输入。公开文件继续走原有 attestation、上传、下载读回和 custody；四个上传均限定具体公开文件并包含其隐藏父目录。

最终 `611fae`：DAG 1/1、YAML 重复键检查、十段 shell 和四段内嵌 JS 语法、限定 lint、差异及合同检查通过。中途复制产生的自依赖被现有 DAG 检查 `d54c3d` 抓到并已修正。限定独立审查无可证实 P1/P2。当前仓库合同摘要 `sha256:adf2800f4563c6eef9c35839ab536b9a27db4f8f6cf79064d0824c7b35ad72c6`，迁移仍为 128 项、未更改。没有推送、合并、实际触发工作流或改动服务器服务。

当前下一项是 final：绑定确切公开 source 原件，并接入既有真实 Compose/API/Web 检查及其证据，之后接两端 final 调用和工作流。合法源库性质、snapshot 索引、同候选真实 R2/R3、两项 Staging 迁移及 R4 验收仍未完成。

## Final 应用库迁移增量

发现并修复一个实际执行缺口：final 目标计划已创建独立应用库，但原迁移循环和终态原件清单均跳过它。现在应用库以明确的 `application` assignment 进入同一候选 runner 镜像的迁移、schema 核验和运行权限准备流程。它绑定自己的库名、OID、角色、带前缀的 marker 和物理锁，不作为数据库测试套件，也不执行测试 schema fixture 或 seed。

独立结果重建和双份保管均要求该应用库的迁移原件；缺失时不能形成成功终态。实际 API/Web 检查仍未接通，因此这一修复仅补齐应用数据库准备，不代表应用验收成功。

前置检查 `4b2e07` 确认工作区干净，本地迁移状态因缺少 datasource.url 在连接前停止；`df0255` Prisma schema 有效。本轮未改业务代码或迁移文件。限定检查先由 `eb6511` 复现应用 assignment 不受支持、终态遗漏应用原件，修复后 `80f31b` 为 14/14 通过，无跳过；补强 marker 负例后仅复查该文件，`62de58` 3/3 通过。数据库、容器和迁移进程边界为合成事实，不是实际 hosted/DB 运行。`5307ee`/`09ce3f` 格式、限定 lint、差异与合同检查通过：263 文件、87 schemas、13 commands、128 migrations，仓库合同摘要 `sha256:ca047a45fb55d64780fa3d4727fa153a9e05774c3fae4377f622789fe68268b5`。

后续工作已集中到 `docs/superpowers/plans/2026-10-01-stage1-final-application-integration.md`。网络核对确认 Web 候选镜像在构建时固化 HTTPS API 地址，不能靠运行时环境变量改指隔离 API。下一步必须保留候选镜像身份并建立真实可达的应用验收路径，再接公开证据、final 调用器和工作流；不能用另一个测试镜像或模拟响应替代。

本增量经一次限定独立审查，无可证实 P1/P2。下一依赖是将构建工作流已验证的 API 地址与 Web 镜像摘要一并留在可信构建证据中，供隔离网络中的真实 TLS 请求使用；不修改生产 DNS，不关闭浏览器 TLS 校验，也不引入商用 KMS。

## Web 构建地址绑定增量

受保护构建 observer 现将已经由 build-web 按不可变镜像核对的 `apiBaseUrl`，与实际选出的 Web 平台镜像摘要一起保存为 `webClient`。构建 proof 同时保留唯一的地址 material，验证时要求与原 observation、Web 镜像和 observation 整体摘要一致，拒绝重复或未绑定地址。历史证据没有此字段时仍能读取，但新的 `assertBuildWebClient` 会明确拒绝其用于应用地址检查；该消费检查尚待 final 应用 runtime 接入。

既有两个 build 测试文件 `95902f` 为 54/54、无跳过；覆盖错误镜像、非预期 URL、地址篡改/重复/丢失和历史兼容。`0cb6db` 工作流重复键、十段 shell、三段内嵌 JS 语法通过；`2d6981` 限定 lint、差异和合同检查通过，`ae4b96` 格式通过。构建 producer/verifier 已纳入合同清单，当前为 265 文件、87 schemas、13 commands、128 migrations；仓库合同摘要 `sha256:6b17be0af3bb9860f04e8837b48e93f974753d7a4a3282f9e23a1598c6241860`。一次限定独立审查无可证实 P1/P2；未实际构建、推送镜像或触发 CI。

另有一项如实保留的既有检查失败：静态 CLI `verify-build-materials.mjs --workflow` 返回 `RUNNER_DEPENDENCY_COPY_TOO_BROAD`（`5f58e2`）。旧检查只接受治理脚本逐文件清单，而当前 Runner 为完整数据库测试已复制整个 scripts/API 源目录；该函数与本增量前相同（`ae4b96`）。工作流 observer 实际使用 `--input`，但完整构建检查仍需对齐此差距，不能记为全部通过。

本轮应用库迁移和构建地址绑定均为代码进展。阶段 1 仍缺实际 API/Web/TLS 验收路径、final 公开证据与两端调用/工作流，以及合法快照输入、同候选 R2/R3、Staging 两项迁移和 R4 真实验收。

## Runner 构建布局检查修复

此前 `RUNNER_DEPENDENCY_COPY_TOO_BROAD` 已修复。检查现在核对当前 Dockerfile 最终阶段的固定、按序 COPY 清单，并确认治理文件、必要资产及数据库测试清单中的源码和夹具均包含在镜像来源目录内；拒绝额外 COPY、ADD、错误目标、未知构建阶段及仓库根复制。Dockerfile 和镜像内容未改变。受保护的 build observer 会在生成构建证据前执行此检查。

`fb7878` 先复现旧检查失败；`79dc99` 两个受影响测试文件 56/56 通过、无跳过，原失败 CLI 也已通过（25 个治理文件、45 个清单源码/夹具、3 个基础镜像观察）。`b9689a`/`40b635` 限定 lint、工作流重复键及十段 shell/三段 JS 语法、差异和合同检查通过，合同为 265 文件、87 schemas、13 commands、128 migrations，仓库合同摘要 `sha256:f768ddcd80baae9c12babcece96ec93c8cacd8689b10bea679c0f48bcda31795`。一次限定独立审查无可证实 P1/P2。没有实际构建镜像、操作数据库、触发 CI 或重跑长组合测试。

下一步仍是接通同候选 API/Web 的真实应用执行、TLS/浏览器检查和保管；本修复不代表阶段 1 已完成。

## 应用容器执行器增量

新增 API/Web 的内部容器执行器，候选镜像内容不变。镜像身份、原命令、运行配置及实际运行状态核对后，API 数据库凭据才通过 attach stdin 发送；不会写入 Docker 配置或命令参数，API 进程环境仍必然持有连接地址。容器为非 root、只读根目录，无宿主机挂载或发布端口。应用输出只记录有界字节数和摘要。验收或停止、删除、回读失败均保持失败，按本次实际拥有的 CID 和镜像引用清理。

固定私密启动器已通过 Windows 和 WSL Node22 的真实进程测试（9477e3/f49a37，各 5/5，无跳过，包含 POSIX 信号转发）；容器执行器 c34b0c 为 3/3，Engine 边界为模拟。限定 lint/格式/差异及合同检查通过，合同为 267 文件、87 schemas、13 commands、128 migrations，摘要 `sha256:7ef28d6cdd058d7e36201783ab7fde0c9c1d623d6a10a0df2de648b2eb508a5c`。一次限定审查无可证实 P1/P2。

该执行器尚未接入 native holder，真实 Engine/PG 库存检查、私密 TLS 和浏览器验证仍待连接，不能据此声称 API/Web 或阶段 1 验收通过。本轮未运行真实容器、操作数据库或触发 CI；前置迁移状态仍在连接前因本地缺少 datasource.url 停止，Prisma schema 校验通过。
