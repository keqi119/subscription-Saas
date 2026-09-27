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
