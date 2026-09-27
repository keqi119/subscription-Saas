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
