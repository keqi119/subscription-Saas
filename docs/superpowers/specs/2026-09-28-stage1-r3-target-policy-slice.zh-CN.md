# R3 固定目标策略切片

本切片落实已批准的阶段 1 非商用发布路线。仅补充固定目标策略的契约和必要拒绝用例，不创建目标、不签发能力、不修改 H1 身份、不接通现有 workflow。实际启用须由新的可信 `build-proof.v1` 锚定已审查策略和入口，且逐操作目标原件满足下述规则。旧 R2 白名单继续独立有效。

## 固定文件与边界

新增 `release/contracts/manual-stage1-r3-target-policy.v1.json` 及同名 schema，登记既有 repository-contract manifest；用现有 `schema-registry.test.mjs` 验证闭合字段和错身份/错通道拒绝。策略引用原 H1 profile digest，不要求 profile 反向引用新策略，因而保留已批准 profile、owner binding、公私钥及批准原件。策略本身不是一次操作批准。

数据库规则引用现有 `database-target-policies.v1.json` 的 `s1-release-compose-ephemeral`，不复制 PG17、镜像摘要、marker 或库名权威。全量 suite 集合引用现有 `database-test-manifest.v1.json`；不新增或删除业务测试。候选仍只有一个 `buildProofDigest`，不恢复 prebuild / full-RC 依赖。

| 项目         | 唯一允许值或规则                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI 仓库      | `keqi119/subscription-Saas`，repository ID `1253231368`，`refs/heads/main`，run attempt 1，GitHub-hosted                                                                   |
| source       | `.github/workflows/release-candidate-gate.yml` 的 `source-fresh` / `source-snapshot`；`trusted-source-database-gate` environment                                           |
| final        | 上述 workflow 的 `final-fresh` / `final-snapshot` 调用 `.github/workflows/release-final-chain.yml` 的 `execute`；`trusted-release-execution` environment                   |
| H1 transport | Engine `tcp://127.0.0.1:55440`，PG observer `127.0.0.1:55441`，`stage1-r3-forward` 连接身份                                                                                |
| hosted 存储  | 每操作独立 LUKS2；classic `overlay2`；数据、WAL、临时文件、日志、明文和凭据均在核实的 mount 内；禁用 swap/core，拒绝 containerd image store 和外部持久数据路径             |
| 路径         | 沿用 `/var/lib/stage1-snapshots`、`/srv/stage1-snapshot`、`/dev/shm/stage1-keys` 和 `s1snap_`；具体叶路径绑定 creation record 的独立 32 位十六进制标识，不复用其他操作路径 |
| 目标         | fresh/snapshot、source/final 独立；TLS required；两端映射核对同一 PG system identifier、真实 server address/port、DB OID/marker、角色与实际 CID                            |

final 不只匹配字面 `execute`：必须核实调用方 run、展开后的实际 job ID、chain、工作流及 checkout/source；现有 self-hosted 执行不满足策略。source 开始前也先验证唯一 build proof，构建仍不等待快照。

## 无循环的操作顺序

1. 同一 manual 签名/撤销/一次消费机制先处理**创建**：绑定固定 creation spec、目标 phase/chain、实际 job/host、候选、精确路径、容量、期限与清理规则。此时不引用尚未产生的 Engine ID、PG OID 或 destination digest；它不允许读来源、下载 payload、解密或执行候选数据库测试。
2. 创建后独立读回实际 hosted provenance、mount/backing file、Engine、容器/网络、两端 PG 映射和完整 target set，冻结本次 destination admission。`controlled-target-record.v1` 的旧 `s1dev_`/本地 secretFiles 格式不能冒充 R3 目标原件。
3. 随后的 read/decrypt/use 才绑定该实际 destination、合法输入 index、唯一 build proof 和本次 source/final；final 另绑定匹配的 source 证据。沿用既有 v3 consumer 请求和同一撤销台账，不新增授权服务。
4. H1 先持有固定 55440/55441 通道槽互斥锁，再按稳定排序持有实际目标集合锁。目标锁的身份至少包括 Engine ID、PG system identifier、DB OID 和 marker；不沿用 R2 回环端点锁，不允许两次操作把不同 Engine 解释成同一空闲通道。lifecycle suite 的内部目标也须进入本操作资源记录。
5. 每次使用前重新核实通道、job、目标及输入。失联保留 UNKNOWN 和锁；CLI 退出不证明远端停止，禁止切换本地 Engine、换 ID 重试或改写旧失败。按同一 Engine/CID 读回停止与清理后才能释放对应资源。

## 本切片不能证明的事项

这里不实现 creation/request/session 的前向记录、实际 hosted job attestation 读取、destination reader、RSA 私钥释放、远端 restore 或最终 suite 执行。后续接线须复用现有 H1/H2 和 manual 会话，明确版本分支；不能把此 JSON 或调用方传来的摘要作为已验证能力。实际 hosted job、加密工作区和目标原件仍未取得，阶段 1 未因此完成。

## 固定读取入口接续

`manual-stage1-trust.mjs` 已新增 `readFixedR3TargetPolicy({repoRoot,proofBytes,materialBytes})`。它保持 Linux H1 原身份校验，从固定源码位置读取策略、数据库策略和 suite manifest，核对 profile 摘要与 repository-contract 登记，再复用 `verifyManualBuild` 对私有档案中的实际 proof/material/receipt 和 H2 attestation/run 做验证。没有新增信任路径、候选身份或外部授权服务。

返回的是冻结事实及 `recheck/close`，不是创建或消费能力。持有原件在每次重查中独立读回，同时核对实际主机、profile 有效期、仓库/迁移摘要和 Git checkout；失败关闭自有句柄。新接口不读取签名私钥、RSA 私钥、数据库凭据或 payload，不创建会话，也不把当前 self-hosted workflow 当作已满足 hosted 条件。

首次定向 native 测试发现，现有数据库策略文件含 Compose 分支，但其 schema 仅接受旧分支。现以两个互斥分支分别绑定既有 policyId、环境集合和主机范围；原 catalog 字节、旧分支约束及 H1 原件不变，不跳过校验。该 schema 回归先 RED 后 GREEN（1/1）；随后读取器三个 Linux 用例全部通过（0 skip）。测试中的 H1/H2 原件为合成夹具，不能充当真实 CI 或目标准入证据。

## 创建合同接续

`manual-runner-request.v4` 和 `manual-launch-authorization.v4` 表达 `target-create / create-isolated-target`。请求绑定 profile、会话、一次尝试、唯一 build proof、source/final、fresh/snapshot、目标策略、creation spec 和实际 job admission 的摘要。创建请求不携带 snapshot 输入、消费 scope 或尚不存在的 destination admission；它们属于随后独立核验的消费阶段。

`validateManualTargetCreationRequest` 与 `verifyManualTargetCreationAuthorizationBinding` 只提供闭合结构和纯签名绑定检查；签名域、profile 密钥和五分钟上限沿用现有实现。它们不出现在公共 barrel，不产生 branded decision，也没有让旧 R2 runtime 接受 v4。实际 creation spec/job 原件读取、会话台账及执行仍需后续接线。合同回归 81/81 通过，不代替这些执行证据。

## 创建规范原件

创建规范固定保存在既有私有 archive 下的 `inputs/r3/{operationRef}/creation-spec.json`。入口只接受 repoRoot 和规范小写 UUID selector，不接收路径、IO、已验证结果或调用方时钟。规范采用 canonical JSON，版本 `manual-r3-creation-spec.v1`；其闭合字段为 operationRef、profileDigest、ownerId、sourceSha、buildProofDigest、proofRawDigest、materialRawDigest、targetPolicyDigest、phase、chain、createdAt、expiresAt、workspace、cleanup。targetPolicyDigest 是固定策略原始字节的 SHA-256，三个构建字段分别引用同一 H2 的 canonical proof 与两份原始文件。

workspace 只声明 id、capacityBytes、backingFile、mountPath、keyFile、mapperName。id 为 operationRef 去除横线后的 32 位值，四个名字由固定策略根目录和 id 唯一导出；capacityBytes 为至少 64 MiB 的安全整数且按 MiB 对齐，实际创建仍须检查主机容量和格式化结果。有效窗必须位于既有 profile 内且当前有效。cleanup 仅允许 `stop-owned-engine-and-remove-workspace`，执行时只能清理本次实际拥有的资源。

读取器复用 H1 和固定策略/H2 读取器，持有规范及构建原件，在 recheck 中重新核对实际主机、原件、时窗及源码绑定。规范不含 jobAdmissionDigest、实际 Engine/PG/destination、输入或密钥；随后同 job 的已签名 descriptor 可以绑定 creationSpecDigest，不形成未来事实循环。此读取结果只是计划事实，仍须实际 job 准入及同一 manual 会话消费后才能创建；它不读取私钥或 payload，不开启目标或获得锁。

该入口 `readFixedR3CreationSpec({repoRoot,operationRef})` 已实现，API 拒绝用例先 RED 后 GREEN，3 个 Linux 定向用例全部通过（0 skip）。用例只证明规范与实际固定读取边界，GH 响应仍使用合成夹具；实际当前 job 准入读取器尚未接线。现有 `successfulRun` 强制 completed/success，用于已完成构建，不能复用于创建前正在运行的 job。

## 当前作业原件读取

`readFixedR3JobAdmission({repoRoot,operationRef})` 现从同一私有操作目录读取 canonical `job-admission.json`，版本为 `manual-r3-job-admission.v1`。它绑定已读 creationSpecDigest、原 profile/owner、唯一 build proof/sourceSha、phase/chain 与有效窗。ci 闭合字段为 repository、repositoryId、runId、runAttempt、workflowPath、callerWorkflowPath、jobKey、jobId、jobName、environment、runnerClass；host 闭合字段为 machineIdFingerprint、forwardingPublicKeyPem、forwardingKeyFingerprint、runnerId、runnerName。只接受指纹匹配的规范 Ed25519 SPKI 公钥，不读或返回连接私钥。

H1 原生 `gh attestation verify` 校验该完整文件。source 的 signer/caller 均为固定 candidate workflow；final 的 signer 为 reusable final workflow，caller 仍为 candidate workflow。保留原 Docker Images 校验默认分支，核对签名 subject、源码、仓库 ID、hosted 证书和同一 run attempt。该分工依据 [GitHub CLI attestation 说明](https://cli.github.com/manual/gh_attestation_verify)，不把 reusable signer 误认为 caller。

随后独立读取固定 GitHub run-attempt 和 [job API](https://docs.github.com/en/rest/actions/workflow-jobs)，要求当前 in_progress、相同仓库/源码/run/job/runner，并核对 source 名称或 final 展开名称与 chain。签名声明承担 environment、主机指纹和临时公钥的来源绑定；API 不单独证明这些字段，也不代替后续目的地实际读回。声明生产器必须从实际 job/host 生成，不能让调用者提交任意已验证标记；生产器和 hosted workflow 目前尚未接线。

`recheck` 重新核对固定原件、H1/H2/源码、时窗及当前 run/job；结束、错位或无法观察均拒绝。返回的 observations 绑定完整 admission、attestation、run、job 原始响应摘要与长度，rawInputs 为独立副本，供后续私有台账保管；副本不是授权对象，归档时仍须核对摘要。没有 manual decision、签名私钥、payload、资源创建或消费能力。4 个 Linux 定向用例全部通过（0 skip），GH 响应为合成夹具，不构成实际 CI 验收。

## 会话记录与尝试分配

R3 会话使用 `manual-operation-record.v3`，范围仅包括 session、consumption、execution、custody。session 的 scope 固定 policy/spec/job/build 四个摘要、sourceSha、phase 和 chain；不沿用 R2 的 targetIntent。撤销仍读取原 `manual-operation-record.v2`、原 GENESIS 和 checkpoint，不另起撤销链。创建和消费使用同一 session，其一次消费槽继续按 profile 与 authorizationId 去重。

`manual-runner-evidence.v2` 只表达尝试分配，不扩展原 MS2 子进程协议。分配绑定该 sessionRecordDigest、会话/操作/attempt/run、源码和候选、policy/spec/job、phase/chain 与分配时间。target-create 不得携带输入、目的地或前序执行；snapshot-consumer 只允许 snapshot chain，并须绑定已存在的创建执行、destination、scope authorization 和固定输入 selector/index 摘要；final 消费还需 matchingSourceEvidenceDigest。

父方校验的 R3 分支复用原签名域和 parent decision 类型，严格检查新 session scope 与原撤销链。创建没有前序执行；消费必须引用同 session 的成功创建，其 resultDigest 对应请求的 destinationAdmissionDigest。完整原件图、实际目标及来源权限必须仍由 native session 校验；纯父方判定不是已消费或已获准读 payload 的证据。旧 v1/v2 记录及 R2 handoff 语义保持，native session 接线完成前不能用新记录启动执行。

## 加密工作区的原始观察

仓库原先没有 LUKS 的生产观察入口。`r3-encrypted-workspace-observer.mjs` 现提供 hosted 侧只读 `observeR3EncryptedWorkspace({operationRef,capacityBytes,state})`，其中 state 仅为 active 或 absent。路径均由固定策略及 UUID 派生；入口不接收路径、命令、环境或 IO adapter，也不创建、关闭或删除资源。原始观察必须随后由同 job 的签名原件、H1 固定读取器和完整目标图共同绑定，不能单独授予创建、消费或释放锁。

active 读取完整内核 mount/loop/block 表、指定 mapper 元数据、LUKS2 header JSON 和独立 UUID，将 mount 的设备号、dm UUID、parent loop 与 backing file 精确对应。只接受 ext4、rw/nodev/nosuid、正常单 crypt segment、AES-XTS 的 64 字节 volume key；拒绝外部别名挂载、额外子挂载、重复或 deleted backing loop、重加密状态、启用 swap/core。key 文件的最长挂载前缀必须实际为 tmpfs；只检查其 root 所有权、私有权限和 64 字节长度，不读取内容。后续固定创建命令须使用同一算法及随机 64 字节操作 key，不能从观察器反推密钥熵已被证明。

命令采用固定 executable/argv 和隔离环境；采集实际 PID、启动/close 时间、退出码/signal、完整 stdout/stderr 及其摘要。backing、key、mount 和 mapper 路径的身份在观察前后检查；backing/key 仅读取元数据。失败保留 INCOMPLETE 及已获得的原件，不补造退出或成功。`assessR3WorkspaceObservation` 是无副作用解析函数，返回冻结事实，不生成 manual decision。

absent 要求完整拓扑命令成功，并且指定 mount、mapper、loop/backing 关联均不存在；指定文件/目录缺失仅接受 ENOENT，权限错误或命令失败不能视为已清理。这只证明本次指定存储名称的观察状态，不能证明原 Engine/CID、进程、数据库及完整资源集合已经停止或清理。完整 cleanup 仍须绑定创建时的实际资源身份，并经独立读回才可释放锁；当前入口不具备此能力。

命令格式依据 [util-linux findmnt 文档](https://kernel.googlesource.com/pub/scm/utils/util-linux/util-linux/+/refs/heads/master/misc-utils/findmnt.8.adoc) 和 [cryptsetup luksDump 文档](https://gitlab.com/cryptsetup/cryptsetup/-/raw/main/man/cryptsetup-luksDump.8.adoc)：显式列名避免默认输出变化；findmnt 的非零退出不能证明不存在；LUKS2 JSON 不包含 UUID，因此使用独立 UUID 读回。未使用任何导出 volume key 的选项。

## 工作区原件的 job 绑定与固定读取

`r3-workspace-report.mjs` 使用 job admission 已声明的临时 Ed25519 公钥校验观察绑定，签名域为 `subscription-saas/r3-workspace-observation/v1\n`。绑定原件只含 schemaVersion、operationRef、state、observationDigest、jobAdmissionDigest、creationSpecDigest 和 signature。它证明同一 job key 对这些原件的绑定，不替代 GitHub attestation、当前 job API 或 manual 授权。签名辅助函数只接受对应的 Node 私钥对象；H1 读取器只用已验证 admission 内的公钥。

`readFixedR3WorkspaceObservation({repoRoot,operationRef,state})` 从既有私有 archive 的 `inputs/r3/{operationRef}/observations/{state}/workspace-{state}.json` 和同目录 `workspace-{state}.binding.json` 读取规范 JSON；全部 stdout/stderr、policy、machine-id 和适用的 proc 原件保存在该观察子目录的 `raw/{sha256hex}.bin`，空 stderr 也有实际原件。观察子目录在固定 job 句柄打开前保留，避免后续导入改变 `job-admission.json` 的父目录身份。入口先验证固定 job admission，然后用同一批持有字节验签、检查原件摘要与长度、固定命令/参数/成功 close、文件元数据和时间顺序，并重新解析完整拓扑，与声明事实逐项比较。返回原件均为独立副本，内部句柄持续保留；recheck 交错检查当前 job、源码/H1/H2、原件和时窗，失败关闭句柄。

active 和 absent 都要求同一原 job 仍在运行且处于原有效窗内。absent 仍只表示指定工作区名的观察结果；job 已终止或原件改变时拒绝读取，不能据此释放锁。终止 job 后的清理恢复、实际 hosted producer/保管、Engine/PG 目标图、创建执行及 manual 会话接线仍待完成。本片不读取 H1 私钥、快照解密钥或 payload，不启用旧 workflow，也不新增服务。

## 创建会话接线顺序

上述规范和 job 读取器已接入同一个创建会话；下一步在创建执行路径采集 Engine/PG 原件。既有 `observeH3Resources` 只承认 H1 本机 Docker 端口发布和 R2 命名卷，不能通过替换环境变量将它当成 R3 两端映射，也不把未来 destination 事实放入创建前的请求。

固定入口为 `openTrustedR3CreationSession({repoRoot,operationRef})`：先读规范、当前 job、H1/H2 和源码，再打开原 profile 指定的 H1 Ed25519 私钥。七项 scope 由已验证规范/job/构建派生，不接受调用方 scope、路径、时钟、密钥或 IO 覆盖。`openManualSession` 增加显式 `r3CreationContext:{scope,creationSpec,jobAdmission}` 分支；owner observation 绑定同一 scope，旧 R2 targetIntent 路径保持独立。公开结果只含 profileDigest、sessionId、sessionNonce、scope 及 sign/consume/record/close。

R3 复用原私有 fileStore、v2 撤销链与 checkpoint、一次消费槽；会话记录采用已有 v3，创建请求采用 v4，尝试分配采用已有 evidence v2。先独占固定 55440/55441 通道槽，再签发和消费；消费读回必须已有唯一永久消费槽和 UNKNOWN execution 原件。混合历史须保留原请求、分配、签名、撤销及消费关系；错误或缺图不得忽略。当前分支只准 target-create，snapshot-consumer 和成功创建 execution 等待后续完整原件图接线。

固定入口在每次 sign/consume/record 前后重查当前 job 及持有原件；不通过调用方布尔值代替。close 不要求 job 继续运行，始终能尝试本地收尾：未消费会话可关闭并释放自己的通道槽，已消费但实际结果未知的会话保留 UNKNOWN 和通道槽，不能用新操作绕过。实际 hosted 创建、同 Engine/CID 读回、两端 PG 身份/TLS、完整目标集合锁以及真实清理结果仍是后续必要工作；本会话入口本身不能证明这些操作完成。

本切片核心定向 4/4、唯一 Linux 整合 7/7 通过，覆盖未解历史拒绝、旧 R2 reconcile 兼容、一次消费持久化和 job 结束后的本地关闭；独立只读审查通过。Linux 使用真实文件系统/Git 及合成 job/资源原件，不是实际 hosted 创建验收。未新增 schema、数据库 suite 或例外，未重跑已有 R2 长链。

## 创建前的原生通道交接

实际创建不能依赖尚不存在的 Engine。实施顺序固定为：hosted job 发布既有 admission；H1 核实后仅安装该 job 的受限 SSH 公钥并持有双槽；同一 `-R 127.0.0.1:55440:<每操作固定 Unix socket>` 先连接短生命周期控制入口，H1 完成原 session 的 sign/consume 后才交付固定创建请求。控制入口仅接受该 job/spec/profile 的创建请求，不提供 shell、命令参数、第二签名机制或其他端口。连接身份由已经核实的 job 公钥和现有 H1 root-only 端口边界绑定，不能仅凭签名 v4 推断消费已经完成。

控制入口结束后安全关闭并移除自己的 Unix socket，由本次加密工作区中的独立 Engine 绑定同一路径。SSH 连接和 H1 55440 监听保持，后续新连接由 OpenSSH 连接新的 Unix listener。此处选择一次固定 HTTP 请求/响应，不扩展 MS2 数据库子进程帧，也不建立常驻控制服务。生产接线仍需完成受限公钥的逐操作安装/撤销、控制入口和 Engine 启动、实际目标独立读回；本段设计不直接启用旧 workflow。

控制响应只确认指令已接收，不代表资源创建成功。实现须先完成该响应并关闭已有控制连接，再等待 HTTP server 完全关闭、核对并移除自己的 socket 后启动 Engine，避免一边等待 server.close 一边等待当前响应形成死锁。H1 保持原消费 UNKNOWN 和锁，独立读取实际 Engine、工作区、PG 及完整结果图后才能升级状态；断线或交接失败不触发新操作重试。

2026-09-27 23:00 UTC 已在指定 H1 做一次同主机原生交接维护验证：同一 SSH PID 2303107 先收到 HTTP 204，控制 socket inode 5315196 关闭并移除；独立空 dockerd PID 2303127 随后绑定同一路径的新 inode 5315219。H1 转发与直接 Unix 读取的 Engine ID 相同，且与系统原 Engine 不同。临时 Engine 为 vfs、0 容器/0 镜像，只验证交接机制，不证明 hosted、LUKS 或 overlay2 准入。临时 daemon/SSH 正常退出 0；独立 SSH 读回确认进程、临时 key、socket 和两端口监听均不存在，授权文件恢复为空，原 Engine 的 ID、容器数与镜像数不变。原件和脚本摘要见 [通路核查](../../acceptance/2026-09-27-stage1-r3-remote-engine-feasibility.md)。

## Hosted 工作区创建原语

`r3-hosted-workspace-create.mjs` 提供内部 `createR3HostedWorkspace({requestBytes,authorizationBytes,creationSpecBytes,jobAdmissionBytes})`。四份 canonical 原件均限 1 MiB，复用既有 v4 签名绑定、固定 profile/policy、当前机器指纹和 job 环境核对；不接受路径、命令、IO 或时钟覆盖。final 的 `GITHUB_WORKFLOW_REF` 核对 caller，admission 的 signer 仍核对固定 final workflow，符合 [GitHub reusable workflow 的 caller context 语义](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)。上层只能在已验证 root-only 控制连接且 H1 持久消费之后调用；本函数的签名核对不能单独证明消费，尚未作为 workflow 或 CLI 启用。

副作用前要求 Linux/root、无 swap/core、三个预先安装的私有根、完整 absent 拓扑、keyRoot 为实际 tmpfs，以及容量足够。只创建本 UUID 的叶子：原生随机 64 字节 key、排他创建 backing、fallocate、LUKS2 AES-XTS-512 格式化和打开、ext4 格式化、nodev/nosuid 挂载。挂载后对实际 filesystem 根执行并核实 root:0700，再复用 active 观察器核对完整事实。它不启动 Engine、不读快照、不恢复数据库，也不记录目标成功。

返回中的 `observation` 是原观察器的完整结果；`creation` 包含只读过程诊断和已创建路径，`rawInputs` 按 `absent.*`、`creation.<命令>.stdout/stderr`、`active.*` 保存副本。失败携带同类原件和已知部分状态，不自动关闭、删除或释放锁。真实 PID/退出与原件摘要可重核，诊断不含 key bytes。定向合成测试最终为 4 个顶层用例、6 个通过计数；文件系统/拓扑被模拟，子进程为真实 Node，不能作为真实 LUKS 创建证据。

## 创建控制入口与受限连接

H1 的 `launchR3TargetCreate({repoRoot,operationRef})` 复用既有固定 job 读取器、R3 创建 session 和私有 archive。它在 session 已持有 55440/55441 双锁后调用 `openR3H1ForwardLease`，以实际 PID、同一 scope 和原件读回核实锁，再核对 H1 有效 sshd 配置、两个链的首条完整规则、无旧监听和无既存 forward 用户进程。只向固定、原本为空的 root:0644 authorized_keys 安装该 job 的 Ed25519 公钥；不改 sshd/firewall 配置。

H1 只连接固定 127.0.0.1:55440，将 allocation v2 和 request v4 归档、签名并持久消费后，才在该连接发送 canonical `{request,authorization}`。消费返回前既有台账已写入唯一 consumption、读回和 pending UNKNOWN。202 空响应仅确认送达。旧控制器交接中的空 409 和连接暂不可用可在原操作内有界等待，不能重复 POST、重新消费或换 operation。实际 Engine 的 ID、加密 data-root、classic overlay2、json-file、零容器/镜像由同一固定通道读回；这些事实尚不构成目标成功记录或快照消费权限。

hosted 的 `openR3HostedCreationControl({creationSpecBytes,jobAdmissionBytes})` 在实际 tmpfs 的固定 UUID socket 上只接收一次请求。它完成 202 响应和旧连接关闭后，关闭并核实自身 socket，调用已实现的 workspace creator，再以固定配置启动独立 dockerd。daemon 的 data/exec/pid/config/log/home/tmp 均在该操作的加密挂载内；不使用系统 Engine，不接收命令或路径覆盖。返回 `created` 中的工作区原件、实际 Engine readback 和自有进程诊断。

两侧 `close` 只处理自有句柄/资源：H1 仅撤回未漂移的本次 key，不能把 key 撤回当作 SSH 已断开；已消费的 session 仍保留 UNKNOWN 和双锁。hosted 只停止自己实际启动的 child 并等待退出，保留工作区和 key 供后续清理证据，不声明完成资源清理。尚未启用 CLI 或 workflow；job admission 生产、PG 目的地身份、成功/consumer/cleanup 结果图及真实 hosted 双链仍待完成。

## PG 创建、固定转发与两端观察接续

H1 创建句柄增加无参数、每句柄仅一次的 `provisionPostgres()`。使用已验证数据库策略中的 PG17 镜像摘要，创建本 UUID 的内部 bridge、local 命名卷和 PG 容器；卷实际 Mountpoint 必须在该工作区的 `docker/volumes/<name>/_data`，不接受调用方路径。密码在原 H1 credentialRoot 的本操作目录排他落盘并持有读回，使用一个 0600 tar 成员写入新容器；请求/tar 不进入诊断档案，内存 tar 使用后清零。TLS 私钥与证书由容器生成在加密 writable layer，数据目录使用命名卷挂载根。

Docker 26 的内部网络跳过外部端口编程，因此容器不设置 PortBindings。hosted 的既有控制进程启动临时透明 TCP 转发，只监听 `127.0.0.1:55441`，目标固定为当前操作实际观察到的 PG IPv4:5432；每次接受连接重新核对 Engine、镜像、CID、内部网络唯一成员和卷。没有第三端口、独立进程或常驻服务。到期或控制器关闭时停止监听和自有连接；不能据此声称远端数据库或工作区已清理。

两端分别是 H1 固定通道的原 PostgreSQL connector，以及通过同 Engine 对同 CID 的固定只读 TLS psql 查询。共同查询 system identifier、PG17 版本、真实服务端地址/端口、数据库/OID、角色、TLS 与 cluster marker；结果必须完全相同。地址用 `host(inet_server_addr())` 输出裸 IP；显式 `inet::text` 会带掩码，不能与 Docker IP 字段直接比较（[PostgreSQL 17 官方说明](https://www.postgresql.org/docs/17/functions-net.html)）。只归档实际响应及两端身份，单独查询失败或重查漂移均拒绝。

hosted 启动 Engine 前后还要求 `/run/containerd/containerd.sock` 不存在，避免 dockerd 自动采用系统 containerd，使持久元数据离开加密目录。实际 job 准备须关闭其默认 Docker/socket/containerd 服务，并读回本操作 managed containerd 的实际目录；当前未接线 workflow，不改变 H1 系统服务。保持 classic overlay2、iptables/ip6tables/IP forwarding/userland proxy 禁用。

返回 `POSTGRES_OBSERVED` 与 `promotionEligible:false`，不写 SUCCEEDED、不授予 consumer。当前资源观察限定创建阶段的一容器/一镜像；后续 suite/API/Web 的完整目标集合必须显式入图，不能全局放松该检查。`close` 等待本句柄正在执行的 PG 操作、清零并关闭密码句柄，再关闭原 lease/session；不自动删数据库、释放已消费锁或改写 UNKNOWN。完整目标集合锁、结果与保管原件、实际 hosted producer、恢复和清理仍待实现。

## 数据库目标集合创建接续

固定 policy/spec/job 读取链现在持有并透传已校验 manifest 及其原始摘要。H1 句柄的 `provisionDatabases()` 无参数、仅在同句柄 PG 已观察后允许一次；不接受 batch、库名、凭据、SQL 或端点覆盖。规划读取全部 manifest suites，复用 `suiteDatabaseName` 的 operation/suite/shard 命名和原角色前缀。当前 35 个普通单库，加 clean-acceptance 的 source/target，共预建 37 库；final 另外建独立 application 库，分别配置 migration、test runtime、API runtime、verify，snapshot 分支还配置 restore 角色。

lifecycle suite 保留其真实运行中创建两库、拒绝伪造清理、先删一库而 sibling 仍可读、最终回收的语义。规划只登记两项确定性 reservation，不声明已有 OID/marker；后续执行必须沿同一受控 H1/session 创建、观察并加入目标及清理记录。不能把预建库或旧测试自启的未加密 cluster 替代该过程。

数据库 helper 仅提供确定性计划和固定 SQL，不产生授权。H1 用已经持有的 provisioner 经 `127.0.0.1:55441` 连接；每次切换数据库连接先核对同一 system identifier、服务器地址/端口、PG17 版本、角色、TLS、cluster marker 及当前数据库。CREATE DATABASE 独立执行，不放入事务或包含其他 SQL 的调用。每库前后重查原 H1/job/源码边界，顺序执行，失败保留已创建角色/数据库和完成记录，不自动 rollback/drop。

首个凭据或 SQL 变更前，先在原 archive 持久保存 UNKNOWN attempt，包含 operationRef、完整计划、manifest 原始摘要及统一 createdAt。即使首库中途失败，也能按原时间和集合重建预定 marker，不依赖已经完成的记录。各库私有凭据在 H1 原 credentialRoot 的本操作 `database-credentials` 内排他写入、持有并重读；返回引用，不返回密码。仅归档固定 SELECT 的非秘密响应，密码 SQL、驱动错误和 connector statement log 不入诊断。关闭等待正在执行的操作，清零并关闭自有凭据句柄；不宣称数据库已停止。

凭据保管沿用严格父目录身份检查：PG 创建阶段先保留空 `database-credentials` 子目录，再固定 provisioner 密码句柄；数据库阶段先排他写完完整计划的凭据文件，再逐个固定句柄。后续不新增同级凭据，避免自身写入改变已经绑定的目录元数据。失败不重绑或放松检查，仍保留原 UNKNOWN 和已写凭据供后续核实。

创建后读取真实数据库 OID、COMMENT、owner、schema owner，以及各角色 OID、LOGIN/特权属性、membership 和数据库/schema 权限。membership 同时检查本角色加入其他角色和其他角色获授本角色两个方向，均须为零；非迁移角色不得 CREATE 或 TEMP，runtime/API/verify 需已有 CONNECT 与 schema USAGE。重读按原始事实比较，任何身份或权限漂移拒绝。suite COMMENT 采用既有 canonical JSON marker；application 的真实 COMMENT 使用 `subscription-s1-ephemeral/v1:` 加同类 canonical 内容，直接满足现有 final target 的前缀要求，不能在出具原件时换成不同 marker。

返回 `DATABASES_OBSERVED`、`promotionEligible:false`、`targetSetComplete:false`。这不表示已迁移、恢复或可消费，也不包括 lifecycle 的实际创建或成功创建结果图；初始目标锁现按下节接入，其余事项和 actual hosted/runtime 接线仍必须完成。

## 初始目标排他锁

沿用原 H1 session 的私有 journal/locks，不创建新的锁服务或授权机制。已有创建消费读回完成后，`holdTargets` 仅允许一次初始集合获取；物理锁键以 Engine ID、PG system identifier、数据库 OID 和完整 COMMENT marker 的 canonical digest 派生。规划拒绝重复库名、重复物理 OID、其他操作的 marker 以及占用 lifecycle 两个保留名的初始目标。

lifecycle 的两个库名由同一 operation 的既有命名函数推导，使用独立 namespace identity，仅带 Engine/system identifier/name，不伪造 OID/marker。创建阶段不提前执行该 suite；后续受控执行必须在保留名下创建，加入实际身份锁，执行其伪造清理拒绝与 sibling 隔离断言，再记录实际回收。该动态接线仍未实现，不能将 namespace 锁视为已有数据库或测试通过。

锁按 digest 固定顺序，以 `wx` 和 0600 排他创建。文件写入实际 session/nonce/scope/PID、operation、原 UNKNOWN execution 摘要及目标身份，fsync 后独立读回；持有 descriptor 并在 active/recheck 时核对同一 inode/dev 与 canonical 字节。创建文件后立即登记句柄，部分写入或碰撞保留已获取前缀，不覆盖既有文件，不重新获取另一集合。普通关闭仅关闭句柄，保留已消费会话的 UNKNOWN、两条通道槽及目标锁；释放须由后续真实清理证据支撑。

H1 的 `provisionDatabases()` 自动传入本句柄观察到的 PG 和数据库事实，调用方仍没有目标或路径覆盖参数。取得锁后再次通过固定 PG 通道读取数据库身份，后续原生 recheck 同时检查本地锁、job/源码、两端 PG 和数据库事实。返回的 targetLocks 仅描述当前排他集合，不能替代 destination admission、保管读回或 snapshot 权限。创建 SUCCEEDED 与消费必须在同一会话内另行验证完整原件关系，当前实现继续保留 UNKNOWN。

## Hosted 观察原件交接

现有控制句柄通过 `exportEvidence({privateKey})` 生成至多 1 MiB 的 canonical bundle，包含 active 工作区报告、原绑定、空 Engine 和 managed containerd 事实及对应非秘密原件。数据来自控制句柄自身创建结果的私有副本，导出前后重新检查当前 job 和 Engine；调用者不能替换观察结果。整体签名使用已准入 job 的同一临时 Ed25519 key 和独立证据域，不产生 manual 授权或创建成功记录。

H1 的 `prepareR3HostedEvidenceImport` 在打开 job/session 句柄前保留 archive 和既有加密 backup 的观察子目录。`importR3HostedEvidence` 先核实固定 H1/job/policy 和 bundle，再以排他创建写入开始标记、完整备份、archive 原件及摘要寻址 raw。失败保留已写前缀，同一操作不得覆盖或重试；写入后独立读回，核对当前 job，才返回固定读取句柄。导入不改变 job 父目录，也不放松既有 inode、权限和目录身份检查。

`readFixedR3HostedEvidence` 同时持有工作区、archive bundle 与 backup bundle，要求备份与原件字节相同，重查签名和完整原件关系。containerd 的 PID、父进程、starttime、命令行、配置路径及监听归属从已有 raw 重新解析；原生采集器复用同一解析。文件与 executable 元数据仍是该 job 采集并签名的事实，H1 不声称能够直接访问 hosted 的内核。

原生 launch 句柄的 `importHostedEvidence(bytes)` 仅允许一次导入，并与同一固定转发读取的 Engine ID/version 对照；之后持续保留读取句柄用于 recheck。返回 `HOSTED_EVIDENCE_OBSERVED` 和 `promotionEligible:false`，原 session、消费记录和 UNKNOWN 保持。实际 artifact 交付、destination admission、SUCCEEDED/consumer/cleanup 和 hosted workflow 尚未完成；不得把导入成功当作这些执行通过。

## 目的地原件记录

创建句柄的 `recordDestination()` 不接受参数，仅在同句柄 hosted 导入成功、PG/数据库创建读回完成并持有初始目标锁后允许一次。它再次检查当前 H1/job、凭据和锁，通过实际 Engine/CID 与固定 PG 通道核对身份，并读取数据库 OID/marker、角色及权限。目的地原件仍不代表创建成功、consumer 准入或 lifecycle 执行完成。

`r3-destination.mjs` 的纯构建器把本次原始 PG resource/exec 响应和只读 SELECT transcript 重新解析：复用现有 PG assessor 比对 Docker multiplex stdout 中的身份与转发身份；按真实 helper 请求的库名、SQL 和顺序重放 SELECT，拒绝缺项、多项、目标混用和权限不符。完整计划重新由固定 manifest 派生，库凭据仅保留固定私有引用；物理锁及两个 lifecycle namespace reservation 必须与现有锁规划逐项相同。

`manual-r3-destination.v1` 绑定 spec/profile/owner、job、唯一候选、source/final、fresh/snapshot、同 session/nonce、原始 UNKNOWN execution、消费记录、hosted bundle、manifest 和观察原件摘要，包含核实的 PG 事实及初始数据库集合。`manual-r3-destination-observations.v1` 保存对应的非秘密 PG 读回与 SELECT transcript。两份 canonical 对象各不超过 1 MiB，使用既有摘要对象路径排他写入 archive 和 profile 指定的加密 backup，再独立读回相同字节；不新增信任根、签名机制或存储服务。

记录失败保留已经写入的对象和一次尝试状态，普通关闭等待正在执行的记录工作，保留原 UNKNOWN 与已消费锁。成功只返回 `DESTINATION_OBSERVED` 和摘要，之后的 recheck 同时读回 archive/backup 原件及当前资源身份。后续同会话 SUCCEEDED/custody/consumer 图必须验证这组真实原件；不能仅凭目的地对象的字段或此返回值授予快照访问。

## 同会话创建完成记录（2026-09-28 接续）

原生句柄增加无参数、仅一次的 `completeCreation()`，在已有目的地原件的前提下，完成前后重新检查当前 job、通道、凭据、PG/数据库身份及持有的锁。会话只接收该目的地摘要，独立读取 archive/backup 原件、验证 hosted 签名、重放 PG 和数据库观察，并重建同一 manifest 的目的地；调用方不能提交成功状态或替换观察。

原最初 UNKNOWN 保持不变。会话追加 v3 `SUCCEEDED` execution，前序指向原 UNKNOWN，结果和过程证据分别指向 destination 与 observations。两份证据分别生成 archive/backup 的四条实际 MATCH custody，保留期为 90 天，不冒充负责人确认。完成记录在 journal、archive 和 backup 分别落盘、读回；历史校验要求原消费槽、分配、授权、同 session/nonce、精确前序及保管关系全部存在，部分写入不能授予后续权限。

R2 历史继续使用原校验器。仅在独立重放 R3 目的地之后，才从 R2 输入中排除这两份 R3 对象及已经核实的 Docker exec 流摘要；未知或无关原件仍被拒绝。该选择函数本身不核准证据，也不授予能力。

原生入口成功返回 `TARGET_CREATED` 和 `promotionEligible:false`；后续重查继续读回完成原件。普通关闭仍保留已消费会话、UNKNOWN 和所有锁，等待实际清理结果。此实现不接通 snapshot-consumer、lifecycle 动态执行或实际 hosted workflow，不能作为真实 CI/数据库验收成绩。

## Source 快照消费记录接续

创建完成后，同一句柄的 `consumeSnapshot({inputReference})` 只接受固定输入 UUID；source/snapshot、目的地、候选及创建完成前序均由当前会话取得。复用 request/auth v3、allocation v2 和 record v3，`scopeAuthorizationDigest` 指向既有 permission 原件，不新增授权体系。输入读取器核对完整原件图，再要求 permission 中本 phase 的精确目的地和主体：H1 读取、解密为 `manual-h1:<profileDigest>`，使用方为 `manual-r3-job:<jobAdmissionDigest>`。这些标识不替代后续实际 OSS 读取身份校验。

会话独立从可信 wrapper 捕获的仓库根打开固定读取器；调用方不能提供 reader、批准布尔或回调。签发和消费均重放已完成的创建、保管及锁，校验分配、签名、时间、撤销、输入和同 session/nonce。消费沿用永久一次性槽及实际读回，追加前序为创建 SUCCEEDED 的消费 UNKNOWN，保留创建最初 UNKNOWN 和完成原件。返回 `SNAPSHOT_INPUT_CONSUMED`、`executionStatus:INTERRUPTED_UNKNOWN` 与 `promotionEligible:false`，尚无密文读取、私钥释放或 restore API。任何部分写入或再次尝试都不能重试消费或释放锁。

准备阶段先保留 `inputs/snapshots` 父目录，允许目的地生成后再导入准确 permission。输入 pin 建立后，目标重查继续执行固定 Engine/PG/数据库查询，但不再向其共享 raw 目录追加重复诊断；既有创建观察原件保留。目录身份与文件字节检查没有放宽。

本切片限定 source。final 必须先接入同候选、同输入且实际通过的 source 执行证明读取器；当前入口继续拒绝 final，不能用 schema 有效的摘要或调用方成功声明替代。认证解密恢复、生命周期实际执行与清理、真实 hosted workflow 和 Stage 1 验收仍未完成。

## 生产者加密原件读取

固定输入读取器现在按 envelope v2 的 `authorizationDigest`，从既有 `archiveRoot/raw/<digest>.bin` 读取 canonical 生产者授权原件，继续使用 1 MiB、128 引用上限和严格私有文件 pin。只接受本地 RSA 方案的 v2 授权/envelope，并验证摘要、snapshot/source/context、密钥指纹和两份 key readback 引用的一致性；缺失、超限或错配拒绝。

返回新增冻结的 `cryptoInputs: {authorization,envelope,aad}`，AAD 由已校验的原件派生，供既有解密器消费。短期生产者执行窗允许作为历史原件存在，不扩大当前 input/permission/profile 的有效窗。这些参数不代表当前消费许可、实际 OSS 身份或私钥持有，也没有新增私钥释放入口。真实 RSA/AES-GCM 合成字节回归通过；线上合法快照、独立读取身份、同会话下载/解密/数据库 restore 仍待接通。

## 同会话密文下载

`fetchSnapshot()` 无参数、仅一次，要求当前 source/snapshot 会话已完成创建与输入消费。bucket、region、对象键、版本、ETag、长度、摘要、修改时间和 writer 主体均来自已核验且持续持有的原件，调用者不能覆盖路径、端点、身份或观察结果。创建阶段提前保留 `consumer/ciphertext`、`consumer/plaintext` 和 `consumer/observations`，不放宽已持有目录身份检查。

内部下载器从固定私有 `credentialRoot/snapshot-reader/bootstrap.json` 读取已配置凭据，只能请求既定账号中 `subscription-saas-stage1-snapshot-consumer` 的 900 秒会话，并在下载前后调用 STS 核对精确 ARN/账号。reader 不能与 writer 使用同一 RAM 角色，即使 session 名不同。bootstrap 缺失、过期、目录或文件发生变化均拒绝；实际云端角色与最小权限仍须另行配置并读回，代码常量不构成云端存在证明。

下载使用固定 HTTPS SDK 请求，关闭重试并限制完整密文为 1 GiB。原始 ACL/WORM/versioning XML 经独立解析；bucket/object 必须私有、owner 对应既定账号、WORM Locked/210 天、版本未启用，HEAD/GET 的长度、ETag、修改时间、AES256 加密标记必须对应输入。临时文件排他创建、0600，流式检查完整长度和 SHA-256 后发布到固定 `snapshot.enc` 并 fsync 文件及目录；原件和文件身份继续持有。所有回读流由下载器管理，关闭等待正在打开的流并关闭其 descriptor，发布后的密文保留。

原生句柄在独立 observations 目录写入 canonical 非秘密读回，绑定 session/input 和既有 consumer execution 摘要，随后再次核对当前资源。返回 `CIPHERTEXT_OBSERVED`、`executionStatus:INTERRUPTED_UNKNOWN`、`promotionEligible:false`；不追加成功 execution，不更改全局 raw 原件，不释放锁。后续私钥释放、认证解密、数据库恢复与真实验收仍须完成。

## 同会话认证解密

无参数 `decryptSnapshot()` 只在同一 source/snapshot 会话已消费且已完成下载后允许一次。固定仓库/操作 selector 在首次异步操作前捕获，调用者不能覆盖 key、路径、适配器或观察结果。现有公钥读取器增加闭合的 creation/recovery 原始摘要 selector，复用 profile、owner、host 和持有原件检查；公钥记录本身不授予私钥访问能力。

内部 H1 helper 在固定 RSA 文件打开前检查当前主 LUKS UUID、mapper/loop/backing/mount 关系、固定路径和权限、swap 为空、进程 core 软硬限制为零以及最终 coredump 配置禁用存储和处理。原始非秘密 proc/命令输出受大小限制并写入读回。只读取既有 RSA-3072/65537 PKCS8 basename，核对派生 SPKI 指纹、profile 和 envelope 的两份公钥原件摘要；不使用商用 KMS，不声明软件内存已物理清除或硬件不可导出。

既有两遍摘要/GCM 解密器在 `consumer/plaintext/snapshot.dump` 排他发布完成认证的文件。随后从实际保留的 descriptor 重新计算明文长度和摘要，并核对前后文件及父目录身份，防止在异步检查间替换输出。原生入口将读回写入预先创建的 `consumer/observations/decryption/readback.json`，保留文件和原件句柄；关闭会中止并等待解密，再关闭自有资源，不删除证据或释放已消费锁。

返回 `PLAINTEXT_AUTHENTICATED`、`executionStatus:INTERRUPTED_UNKNOWN` 和 `promotionEligible:false`。这一结果不等于实际远端复制、`pg_restore`、所有权归一、凭据撤销或成功 consumer 执行；这些接线和真实验收仍未完成。

## 认证明文的远端复制

`copySnapshot()` 无参数、仅一次，要求同 source/snapshot 会话已完成消费、下载和认证解密。明文提供受持有句柄约束的读取流，关闭会等待正在打开的文件并关闭所有流。原生固定 55440 Engine 通道新增有确切长度上限的流式请求，保留响应上限、当前身份检查和无重试；响应与上传均完整结束才允许返回，提前响应、截断或超长均拒绝。

复制器在已核实容器的加密 overlay2 内排他创建 `/tmp/stage1-r3-<operationRef去横线>`，通过同一 Engine executor 发送唯一的 root/0600 ustar 成员 `snapshot.dump`。随后以同一 executor 执行固定 `stat`/`sha256sum`，核对 root/0700 父目录及文件类型、权限、长度、硬链接数、设备/inode/时间和实际摘要；所有 exec 均核对实际 container ID、Running=false、ExitCode=0 及无 stderr。调用方不能传目标或源路径。

读回绑定 Engine、CID、operation、session、input、既有消费和解密读回摘要，写入预先保留的 `consumer/observations/copy/readback.json`。`recheckResources` 持续核对远端副本，`check` 持有本地读回，避免回调递归。返回 `PLAINTEXT_COPIED` 与原 UNKNOWN/nonpromotable 状态，不声明数据库恢复成功。普通关闭中止并等待复制，保留远端暂存和原锁；明确的恢复、角色撤销、所有权和清理证明仍待接通。

## 同会话目标库恢复

`restoreSnapshot()` 无参数、仅一次，要求 source/snapshot 的消费、下载、认证解密和远端复制均已完成。元数据及 ownership map 来自持续持有的输入原件。对完整目标集合逐库校验精确物理锁摘要和已持有的 migrate/restore 凭据，复用既有 Engine executor；不接受调用者传入目标、路径、凭据或结果。

每库在独立 root/0700 临时目录发送两个 0600 pgpass 文件，密码不进入 exec argv、Env 或诊断。先读取 PG17 系统标识、地址、TLS、数据库 OID/标记、角色 OID/权限和 schema owner，再临时授予 restore 到 migrate 的 `INHERIT FALSE, SET TRUE` 成员资格。以 restore 登录、`--role=migrate --exit-on-error --no-owner --no-acl` 执行 `pg_restore`；已有 public schema 不做 DROP/CLEAN。所有权清单交由已有 normalizer 验证，禁止任意改写所有者。

恢复后撤销成员关系和 CONNECT、设置 NOLOGIN/PASSWORD NULL，并读回实际状态。迁移身份必须重新连接成功，旧恢复凭据必须得到精确主机/用户名的认证拒绝；网络失败不算拒绝证明。清理只删除自身持有的 pgpass 文件与目录，核对文件身份和目录消失。完整结果写入预留的每库私有读回目录。目标重查仅允许已观察到的精确 GRANTED/REVOKED 变化，其余字段继续与原始创建记录比较；原记录不修改。

关闭立即阻止新入口和下一个库；当前库保留原通道与持续的身份校验，以完成有界恢复和撤销/凭据清理，然后才中断通道并关闭句柄。身份失效或远端进程状态不明时继续保留 UNKNOWN 和锁。返回 `SNAPSHOT_DATABASES_RESTORED`、`executionStatus:INTERRUPTED_UNKNOWN`、`promotionEligible:false` 仅表示本目标集合读回；lifecycle 预留库执行、远端 dump 清理、最终 consumer 保管记录、匹配 source 的 final 执行和实际云端双链仍须完成。

远端副本句柄另有一次性 `cleanup()`，目前尚未接入原生入口。它先重查身份、原文件/目录和摘要，再只 unlink 该文件；确认文件消失并再次核对目录身份后才 rmdir，最终读取两个路径均不存在的原件。成功后的 recheck 改为确认不存在。普通 close 不触发删除，清理失败或与 close 重叠不允许重试，也不声明成功；清理读回仍须进入后续消费保管记录。

## 原生清理与消费终结接线

后续增量已接入无参数、一次性的 `cleanupSnapshot()` 和 `completeSnapshot()`，组合验证正在进行。清理入口只在完整恢复集合完成后执行，使用同一持有的副本和通道，读回绑定全部恢复摘要并保存在预留的私有目录。普通关闭不触发远端删除；关闭与显式操作重叠时等待其结束，不再发布成功回执。

消费终结由既有 session 自行读取固定私有原件，调用内部纯结果构建器，重算 fetch/decryption/copy/restore/cleanup 摘要链、精确目标和物理锁、所有权清单及角色撤销/进程/清理事实。历史快照的生产源码与当前候选源码可以不同；用途继续由既有输入授权绑定当前 destination。每份原件分别写入并读回 archive 与 backup，避免将整个集合合并成超过现有 1 MiB 限制的单文件。result/process 两个摘要索引各保留两份既有 v3 custody 记录；历史核验按索引重新读取所有原件双副本并重算结果。

成功时仅追加既有 v3 的 `snapshot-consumer/SUCCEEDED` execution，前驱是原 UNKNOWN，result/processEvidence 摘要均指向实际保管原件。原 UNKNOWN 和锁不删除，后续重查持续读取终结原件。`SNAPSHOT_CONSUMED` 回执仍为 `promotionEligible:false`，不能据此宣布 lifecycle、source/final 双链、hosted handoff 或阶段 1 完成。

STS 下载凭据必须在密文下载及发布完成时仍有效。下载后的本地重放不再次请求云端，持续约束来自固定文件与 bootstrap 身份、会话撤销及目的地核验；不能因短期下载凭据到期而让长时间恢复在本地重查处失败。

lifecycle 入口仅允许同一持有主机无参数调用，源快照链须先完成消费。实际 suite 创建两个预留库并读回身份后，既有会话才登记对应 Engine/system/OID/marker 物理锁；不修改原目的地或用库名代替物理身份。运行既有文件的两个用例，保存真实 TAP、事件、权限/清理/兄弟库读回和两份保管原件。仅收到两个实际终止事件后才结束内部 Node 测试运行信号，让 Node 生成原始汇总；持有主机会话及其撤销信号保持独立。单 suite 观察不构成 source/final 全清单通过。
