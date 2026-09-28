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

`readFixedR3WorkspaceObservation({repoRoot,operationRef,state})` 从既有私有 archive 的 `inputs/r3/{operationRef}/workspace-{state}.json` 和 `workspace-{state}.binding.json` 读取规范 JSON；全部 stdout/stderr、policy、machine-id 和适用的 proc 原件保存在同操作目录的 `raw/{sha256hex}.bin`，空 stderr 也有实际原件。入口先验证固定 job admission，然后用同一批持有字节验签、检查原件摘要与长度、固定命令/参数/成功 close、文件元数据和时间顺序，并重新解析完整拓扑，与声明事实逐项比较。返回原件均为独立副本，内部句柄持续保留；recheck 交错检查当前 job、源码/H1/H2、原件和时窗，失败关闭句柄。

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
