# 阶段 1：R3 证据交付增量

已批准的 H1 与 hosted job 双向证据交付现已延伸到 source/final 两条链、原生聚合和工作流接线。用户已批准 GitHub 推送、合并和工作流触发；分支已推送并创建 PR #318，正在修复真实 CI 发现的问题，尚未合并或完成候选构建。下文按增量保留实现与验证记录；阶段 1 尚未收口。

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

## 应用资源观察增量

应用镜像、容器状态、完整 Engine 库存及私有网络成员现在可通过独立检查绑定，并继续要求两个实际 PG 查询途径给出一致身份。native 的内部观察入口已支持此模式，返回完整回读原件，供后续保管与重建；完整应用调用和 TLS/浏览器执行尚未接通。

相关观察测试 1ccf06 为 11/11、无跳过。整合时复现了提前清零缓冲区可能破坏尚未发送的凭据（0c87ef）；传输层改持独立副本后，延迟读取回归与容器短测 f0a884 为 3/3。限定 lint、格式、差异及合同检查通过，最终合同摘要 `sha256:0b1c8c5185df7014346cd85fee25b83e5f6e608ebb0bb3887b3d32e71d64ada2`，迁移文件仍为 128 项。尚无真实 Engine/API/Web/数据库验收结论。

本增量经一次限定独立审查，无可证实 P1/P2。后续需把应用阶段的完整资源登记贯穿实际执行和复查，再完成浏览器验收与公开 final 证据。

## 浏览器与 TLS 执行增量

固定版本 Playwright 的三个 npm 包现按真实 lockfile 的 SHA-512、版本和依赖关系下载校验。新增本次操作专用的短期证书/NSS 信任库与浏览器执行器；私密材料通过 stdin 传入，不写进容器配置。容器内代理只允许固化 API 地址和隔离 Web 两个目的地，保留实际 HTTPS 请求及证书校验，执行既有浏览器测试并导出 trace。浏览器作为第三个明确登记的容器参与完整库存核对与清理。

H1 实际探测发现并修复两项兼容问题：OpenSSL 1.1.1 继承系统配置会生成重复 CA 约束；Playwright 的脚本下载也使用 CONNECT。修复后 `ded92e` 使用固定镜像和真实浏览器通过健康检查、HTTPS、CORS、脚本内容及 trace 检查。页面和 API 数据均为合成夹具，不能算候选项目的正式应用验收。`5df7c8` 已清理临时容器、网络、证书目录和本次拉取的浏览器镜像，原 Staging PostgreSQL 保持健康。服务器新增依赖仅为 NSS 工具，未修改系统信任库。

限定测试 `310c03` 为 20/20，WSL 下证书测试 4/4，无跳过；真实 H1 的 OpenSSL/NSS 另外通过 `fd2eb8` 验证。`19f88e` 限定 lint、差异及合同检查通过：270 文件、87 schemas、13 commands、128 migrations，合同摘要 `sha256:831f7fa4a27871aee1457d5246a054fcd65311de17a70f6df476ffd9d0222c69`。一次限定审查无可证实 P1/P2。没有重跑长组合测试或改动业务功能。

下一步仍需接入 native final：实际应用清单、API 专用角色、PG TLS 会话观察、浏览器原件与双份保管，以及公开 final 证据和两端调用/工作流。随后才是合法快照输入、同候选 R2/R3、两项 Staging 迁移及 R4 真实验收。阶段 1 尚未完成。

## Native final 应用接线增量

现已把同候选 API/Web、迁移后的独立应用库、专用 API 角色、PG TLS 会话和实际浏览器执行接入 native final。每次容器状态变更先更新本次资源登记，再独立回读完整 Engine/PG 库存；应用阶段前后仍核对全部数据库目标。只有应用执行、资源清理、原件独立重建及双份保管均通过，才允许形成 native final 终态。缺少应用原件或执行中断会保持未完成。

新增重建器核对原始 HTTP/会话结果、浏览器 trace 与源码、固定包摘要、公开证书链、容器生命周期和 PG 库存，并重跑既有应用适配器。限定验证 `4f024b`、`dfe821`、`ed5312` 共 12/12 通过、无跳过；正向原件使用合成 Engine/PG/HTTP 事实及公开测试证书，不代表真实候选验收。限定 lint/格式/语法/差异检查通过，一次限定审查未发现可证实 P1/P2。

另保留一项未通过的既有入口用例：Windows 在读取操作输入前会进行 ACL 进程探测，与该测试的“零进程”断言冲突；同用例的 WSL 重试又触及其 10 秒子进程超时。没有绕过生产检查或据此声明全部测试通过。其余 17 项限定入口检查通过。未重跑长组合测试，未推送或触发 CI。本地迁移状态仍因缺少 datasource.url 在连接前停止，Prisma schema 校验通过；128 项迁移未改变。

下一缺口是公开 final 合同与实际 native 执行的对齐：旧合同仍要求 Compose 配置和旧式执行证明，不能将本次原生执行伪装为 Compose。还需绑定实际公开 source 原件、接通 H1/hosted final 调用并串行化工作流，再完成合法快照输入、同候选 R2/R3、两项 Staging 迁移及 R4 验收。

## Source 原件绑定增量

final 现在要求公开 source 原件与已认证、已关闭的 source 执行历史一致。历史核验端用实际 source 结果、独立重建、候选 build 和 snapshot 消费结果重新生成预期公开证据；final 接收规范化原件字节，逐项匹配并保留于两份证据存储。final 清单、独立重建、终态 claims 和保管记录均要求该原件。原生 source 终态摘要和公开 source 证据摘要保持独立。

限定 source 原件检查 `800814`、final 读取检查 `355c81` 和核心匹配 `c2c8f9` 共 10/10 通过、无跳过。格式、语法、差异及合同检查通过，迁移仍为 128 项。限定 Node lint 仅发现核心测试中三项既有未使用变量，已对照 HEAD 复现；没有据此声称全部 lint 通过。一次限定审查未发现明确 P1/P2。长核心夹具已适配但未重跑，没有真实候选或 CI 验收结论。

接下来对齐实际原生执行的公开 final 合同与聚合器，再完成两端调用和工作流。阶段 1 仍未完成。

## 原生 final 公开合同增量

新增 `final-native-evidence.v1`，保留实际内部 Web 地址、同候选镜像、测试计数、PG/Engine 身份、应用观察及原件保管摘要。独立读取端将公开事实纳入重建摘要；生成器要求终态、结果、source 原件、负责人 ACK、清理回执和 CLOSED 会话一致。它是数据生成与核对工具，调用端仍须认证持久化历史和实际清理结果；尚未接通公开发布或旧聚合器。

不填造 Compose 证明，也不把成功请求解释成“无历史失败”。重试历史留待后续从已认证台账提取。不同 PG 集群允许数据库 OID 相同，仍要求 Engine、容器、system identifier 与数据库指纹独立。

组合限定检查 `446600` 为 9/9、无跳过；限定 lint、格式、语法、差异及合同检查通过。合同目录登记时发现的顺序和集合差异已修正，最终为 274 文件、88 schemas、13 commands、128 migrations，摘要 `sha256:4dc73a3d2454479e918d95ee24a7a4d78475ca7a26bcef4bda3a96dba8c55ef2`。一次限定审查无新增明确 P1/P2。未执行长组合测试、真实候选或 CI；本地 migration status 仍在缺少 datasource.url 时连接前停止，Prisma 校验通过。

剩余顺序：原生聚合器及真实重试历史 → final 两端调用和串行工作流 → 合法快照输入与同候选 R2/R3 → 两项已批准的 Staging 迁移及 R4 验收。阶段 1 尚未收口。

## 原生 final 历史与聚合接线

新增 final 完整历史读取及 H1/H2 认证包装，要求同一 source/build/chain/CI 上只有一个匹配的候选使用记录，且实际成功终态、结果、负责人 ACK、清理和 CLOSED 记录完整。未完成或重复的匹配记录不能被当成无失败历史；本增量没有增加重试恢复能力。公开 final 证据必须内嵌这份历史，并逐项绑定选定记录。

新增 `release-native-aggregate-proof.v1`，保留同候选构建、镜像、合同、计数、快照有效期和六份保管检查，以实际原生记录摘要生成聚合证明。制品组装与 S1 退出证据入口已接受该合同，拒绝混合新旧执行模式；既有 Compose 模式继续按原合同读取。S1 输出仍只是 `CHECKPOINT_EVIDENCED`，不等于阶段 1 已完成。

限定组合检查 `273e56` 为 37/37、无跳过，覆盖历史选择、公开证据、聚合、制品组装和退出证据。lint 首次发现同一测试文件既有未使用参数，移除该参数后 `7e32c4` 限定 lint 与差异检查通过；格式检查通过。合同 `597a87` 为 277 文件、90 schemas、13 commands、128 项未改变迁移，摘要 `sha256:4d7973fabf57974861387dd40864b8af6aba0290661ea9a5abce714d86251b1b`。一次限定独立审查无新增明确 P1/P2。完整历史读取复用既有原件认证链，本轮未执行长核心夹具、真实候选、数据库或 CI；本地前置迁移检查仍因缺少 datasource.url 在连接前停止，Prisma schema 校验通过。

下一项为 final H1/hosted 调用与 CLOSED 证据交付，再接串行工作流。合法快照源事实与输入索引、同候选 R2/R3、两项 Staging 迁移和 R4 真实验收仍待完成。

## Final 两端调用与工作流接线

final fresh/snapshot 现复用既有 H1/hosted 生命周期。H1 在启动新会话前选择 source 终态，从完整认证历史取得公开 source 原件，并要求 source 已关闭；实际 native 准入仍独立核对同候选匹配。执行完成后继续要求负责人精确 ACK、实际清理和 CLOSED，再认证 final 历史，以保留的 request/result/ACK/session 和真实独立重建生成公开 final。已有 UNKNOWN source 历史仍可读取，只是不能用于 final。

CLOSED 通道要求 final 原件与请求、终态、结果、ACK、会话和 CI 身份逐项一致，完整消息仍受 1 MiB 上限限制。hosted 将公开 final 文件独占写入、同步并读回后才发接收回执；已存在文件或保存失败不能发回执。新的 final Spec/Job/Import 入口沿用已有密钥、机器、只写一次文件及 H1 attestation 准入检查。正式 SFTP 账号沿用此前已批准并回读成功的配置，本轮没有重复修改服务器账号。

两个 final 工作流现使用 Ubuntu 24.04 hosted 隔离路径，接收预留的 final creation-spec，沿 source fresh → source snapshot → final fresh → final snapshot 串行执行。快照走已有准入、解密及恢复路径；公开 final 经 attestation、上传、独立下载回读后记录保管。聚合与退出入口统一使用 `release-native-aggregate-proof.v1.json`。H1 运行方式为原脚本加 `--phase final --chain fresh|snapshot`，对应 `prepareR3FinalFreshSpec` / `prepareR3FinalSnapshotSpec` 和 `importR3FinalFreshJob` / `importR3FinalSnapshotJob`；不会自动代替负责人确认。

限定验证：作业输入 `191f3c` 3/3，交付与两端调用组合 `386acf` 12/12，均无跳过；工作流检查由 `9d2b08` 失败转为 `3b7be5` 通过。YAML 重复键、31 段 shell、7 段内嵌 JS 及其本地导出检查 `b90eb8` 通过。限定 lint/差异 `7960b1`、格式及合同 `d537a2` 通过；合同仍为 277 文件、90 schemas、13 commands、128 项未变迁移，摘要 `sha256:3be9934bc1d1ed117ccc354c42c0dc76c58cc6f8da4bc0ed4d7a20b0db26b570`。一次分段限定独立审查无新增明确 P1/P2。

作业测试最初同时暴露缺少 final 入口和本地 WSL swap 已恢复；在限定测试期间暂停该零使用量 swap，检查完成后已恢复。caller 早期失败为运行身份/夹具问题，不记为功能性 RED。本轮 GitHub/SSH/native/数据库边界仍有替身，真实文件与临时密钥检查不能替代实际候选运行；未重跑长核心夹具，也未操作 H1、业务库或启动 CI。

下一步进入实际候选准备与验收：补齐真实数据库快照制作与输入索引，再固定同一候选执行 R2/R3、应用两项已批准的 Staging 迁移，完成 R4。当前没有新的 RAM 或 OAuth 审批需求；阶段 1 尚未完成。

## 实际 GitHub CI 与来源确认

2026-10-01 用户批准推送、合并及工作流触发后，已推送候选并创建 [PR #318](https://github.com/keqi119/subscription-Saas/pull/318)。首轮 CI 暴露旧迁移总数断言；`4088406d` 改为验证原收敛迁移仍处于第 126 位，允许后续已批准迁移追加。第二轮全部 4,575 个 API 单元测试通过，数据库检查发现一个未登记的纯进程测试；`f3187bd3` 补齐其分类，实际发现结果为 100 candidates、39 manifested、61 excepted、0 unclassified，数据库门槛未删减。

[第三轮 CI](https://github.com/keqi119/subscription-Saas/actions/runs/36805384635) 完成真实数据库运行后失败：车辆可用性套件 28 项中 3 项缺少当前申请锁所需的真实 application 夹具；干净验收套件 10 项中 1 项仍把迁移总数固定为 126。已补齐测试夹具，保留车辆锁竞争、冲突和零写入断言，并让迁移检查继续逐项比较当前目录、校验和及应用状态。CI 删除独立的重复 API 调用，保留 `release:check` 内的完整 API／数据库检查，避免同一轮重复执行全部套件。

本次限定单元检查 3/3、迁移目录加载检查 1/1 及相关 ESLint、格式和差异检查通过。WSL 本地复跑因跨系统 Git、pnpm 和 Prisma 生成环境问题在数据库启动前退出，不计为真实 PostgreSQL 通过；修复后的数据库结果仍以新一轮 CI 为准。

用户已确认 `subscription_saas_staging` 除受控手机号尾号 0212 对应用户外均为模拟数据，可用于功能和验收测试。该受控标识及关联字段仍须执行现有脱敏转换和扫描。现行非商用 v2 密钥、RAM 读取身份、H1 输入准入及消费链已有实现；实际来源适配器、导出至 v2 加密的制作入口、OSS 不可覆盖发布与独立读回及私有输入索引仍需接通。旧工作流的明文脱敏 dump artifact 不能替代该流程，既有 OSS 恢复卷也不是数据库快照。

[第四轮 CI](https://github.com/keqi119/subscription-Saas/actions/runs/36807554362) 仍在三个 Customer 车辆边界夹具失败：事务内重新加载申请时未返回完整测试申请，且已确认方案缺少当前商业快照字段。现已补齐事务读取、完整方案快照、revision 和生产算法生成的 hash，保留真实申请锁、车辆限制查询、商业一致性校验及冲突／零写入断言。随后 Windows 原生受控单套 PostgreSQL 运行 `183fc7` 成功：28 collected、28 executed、28 passed、0 skipped，进程退出 0；Docker 回读仅剩原有两个容器。此前 27/28 的真实失败与两个启动失败记录仍保留，不计为通过；完整 PR CI 尚待本次推送后确认。
