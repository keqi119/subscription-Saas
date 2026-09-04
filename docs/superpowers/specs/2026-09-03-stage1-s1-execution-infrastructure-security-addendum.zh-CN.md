# Stage 1 S1 执行基础设施与 Public Repository 安全附录

日期：2026-09-03

状态：待复审（bootstrap canary 独立授权补充；仅文档设计，不授权实施）

方案方向：A 基础设施拓扑、`execution-purpose-envelope` 证明模型及前向 `exact-capability-approval.v2` lineage 私有存储能力已获设计批准；仍未批准实施

最近已批准内容基线：`380c0edb`（包含 claim/envelope 两个 job 存储协议；状态提交 `4f037a5c` 不替代内容基线）。本次 canary 补充尚未批准。

既有批准内容基线：`8366d87d`（状态提交 `e8a322f2`）

本次修订边界：仅补充 RC dispatch 之前的 bootstrap canary 独立运行授权；不改变既有 v1/v2 批准、purpose-envelope、custody/aggregate/exit 契约或权限矩阵，不修订两份实施计划。

本轮局部复审修订：针对 `acf2008b` 的批准后证据交接 P1，保持预批准 capsule 不可变，补充独立运行 checkpoint 的来源、只读传输、撤销读取语义及无云凭证验证。该补充仍待批准，不代表任何通道已部署。

设计基线：`9b8a0c282f85f1794066ea23550af1d81e105ddf`

上位规格与计划：

- [Stage 1 收敛治理主 ADR](./2026-09-01-stage1-convergence-governance-adr.zh-CN.md)
- [S1 可信发布底座与测试隔离规格](./2026-09-01-stage1-s1-trusted-release-foundation-and-test-isolation-design.zh-CN.md)
- [S1 实施计划](../plans/2026-09-02-stage1-s1-trusted-release-foundation-implementation-plan.md)

本附录只补充 S1 的执行基础设施、安全边界和停止条件，不替代上位规格。与上位规格冲突时，以更严格且已获批准的规则为准；冲突无法通过更严格规则消解时，停止实施并重新评审。

## 批准边界

本轮只获准编写并独立提交 canary 授权设计供复审，不表示新增内容已获批准。基础设施计划 `4786e21e` 的整份复审尚未完成；上游计划已批准内容基线 `24799d0c`（状态提交 `c3afabcc`）不因此扩大授权。Task 29R、Task 30及外部施工继续阻断，不授权：

- 注册或启动 GitHub self-hosted Runner；
- 安装 `/opt/subscription-saas/snapshot-adapter/v1/`；
- 创建或修改 Staging 数据库身份、权限、网络或 SSH 配置；
- 修改实际 GitHub Actions 门禁工作流；
- 创建 Environment、签发 canary 实际运行授权、dispatch canary、修改 OIDC Provider/subject/role 或取得探测凭证；
- 运行 sanitized snapshot、source gate 或 final Compose；
- 恢复 Task 30、应用其 stash 或聚合 S1 退出证据；
- 修改业务代码、业务迁移、模型、枚举、应用 RBAC、S2 或 S3。

本次补充获批后，才允许修订受影响的现有 S1 实施计划与独立基础设施实施计划，并分别提交复审；不能在本轮顺带修改计划或处理其他实施项。两份计划批准前不允许安装或执行。

## 背景与已核实现状

设计基线已具备以下已验证事实：

- [PR #315](https://github.com/keqi119/subscription-Saas/pull/315) 已合并，merge SHA 为 `9b8a0c282f85f1794066ea23550af1d81e105ddf`；
- 对应 [main CI](https://github.com/keqi119/subscription-Saas/actions/runs/33718518322) 终态为 `success`；
- 仓库为 public，且只有一个管理员协作者；
- 仓库当前没有 self-hosted Runner；
- GitHub API 对 `stage1-snapshot-export` environment 当前返回 `404 Not Found`，该受保护环境尚不存在；
- [sanitized snapshot 工作流](../../../.github/workflows/sanitized-snapshot.yml) 要求 `stage1-snapshot-export` self-hosted Runner；
- 当前 snapshot workflow 将明文 sanitized dump 上传为 public repository 的 Actions artifact，保留期为 30 日；GitHub 允许所有已登录且具有仓库读取权限的用户下载 workflow artifact，因此该位置不满足 S1 最小读取权限与失效后 180 日保留规则，参见 [Downloading workflow artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)；
- 当前 WSL/服务器均未安装固定 snapshot adapter；
- Staging PostgreSQL 当前只有应用超管身份，没有 S1 snapshot 专用严格只读身份；
- 现有部署服务器同时承载 production、staging 和 sandbox，只有 2 CPU、约 1.8 GiB 内存，核实时可用内存约 170 MiB，不得作为 source/final Compose 执行主机；
- Staging 数据库核实时约 45 MiB；该尺寸只用于当前容量观察，不能替代每次执行前的真实预检。

现有 snapshot 工作流会在 self-hosted Runner 上 checkout 仓库、安装依赖并执行仓库内脚本。该行为不满足本附录“self-hosted 数据平面不执行仓库任意代码”的目标边界，属于实施前必须修正的 P1 偏差，而不是可以通过运维说明豁免的现状。

## 决策摘要

方案 A 采用混合执行拓扑：

1. source fresh、source snapshot 和 fresh/snapshot final Compose 使用 GitHub-hosted `ubuntu-24.04` 临时虚拟机；
2. 只有 sanitized snapshot 数据平面使用本地专用 WSL Linux 环境；
3. WSL Runner 每个 release attempt 只以 JIT/ephemeral 方式注册一次，最多接收一个精确 snapshot job，完成后自动注销并销毁本次实例；
4. snapshot 数据处理只允许进入 root-owned、Runner 用户不可修改且 digest 固定的 adapter；
5. Staging 只通过专用受限 SSH 本地转发和严格只读数据库身份访问；
6. 原始数据和明文 sanitized dump 只进入本地加密隔离卷；完成脱敏与扫描后，只有按 attempt 独立加密的 snapshot 密文、非敏感证明和受控引用可以离开该边界；
7. public repository 下的标签匹配不是充分安全证明；必须把环境批准、精确 workflow/job 身份、唯一不可预测标签、JIT 单任务注册和运行后销毁组合为排他路由证明；
8. sanitized snapshot 固定由独立受保护的 `snapshotRunId` producer run 先完成；随后才启动 RC workflow run，不允许实施时改成可选的 same-run reusable workflow；
9. Task 29R 基础设施 qualification 与可提升 RC 是两个不同 purpose、不同 source SHA、不同 build proof、不同 producer、不同 `releaseAttemptId` 和不同 `rcWorkflowRunId` 的执行。Qualification 永久不可提升；Task 30 合并后必须从新的可信构建完整重跑；
10. 已发布的 source、execution、final-compose v1 原始证明保持不可变。Purpose 只由固定 workflow 和 RC dispatch 授权继承，另两类批准分别约束 capability 与命令执行；一对一的 purpose claim 和 `execution-purpose-envelope.v1` 固化全部绑定，v2 custody 同时保管并证明 claim/envelope，aggregate 和 exit 不直接把 v1 原始证明解释为可提升证据；
11. 对可提升的 `release-candidate` run，Task 29R 前缀、purpose envelope、v2 custody/aggregate/exit、Task 30 audit 和 final custody 必须全部属于同一 `rcWorkflowRunId`；
12. 任一排他性、加密处置、只读能力、purpose lineage 或容量条件不可证明时，方案 A fail closed，转私有仓库或受控非 Actions 快照操作；仅更换为专用 VM 不能消除 public repository 的任务路由风险。
13. `exact-capability-approval.v1` 保持不可变，只服务既有 snapshot/JIT 能力；RC lineage 私有存储只能使用前向 `exact-capability-approval.v2` 的 `lineage-oss-role`，不得把 create-only 写权限解释为 v1 `oidc-cloud-role` 的新 permission profile。

## 信任边界与威胁模型

### 受保护资产

- Staging 原始数据库内容及其结构、计数和业务关联；
- snapshot 只读数据库凭证、SSH 私钥和 tokenization key；
- root-owned adapter 及其允许命令、契约和 digest；
- JIT Runner 注册凭证和本次唯一路由标签；
- 明文 sanitized dump、加密 sanitized snapshot、扫描证据、source fingerprint、custody receipt 和 runner diagnostic log；
- build proof、source-gate evidence、execution proof、final-compose evidence 与 Task 30 聚合输入；
- RC dispatch 授权、v1/v2 精确 capability 身份批准、命令执行批准、purpose claim、purpose envelope、lineage 存储访问证明，以及 v2 custody/aggregate/exit lineage。

### 主要攻击与故障

- public fork 或不受信事件将恶意 job 路由到 self-hosted Runner；
- 旧 queued job、另一个 workflow 或错误 ref 抢占临时 Runner；
- 持久 Runner 保留上次任务的凭证、原始数据或恶意进程；
- 仓库代码、package lifecycle script、任意 Shell/SQL 路径在数据平面执行；
- adapter 被 Runner 用户替换，或通过参数注入扩大命令和目标；
- SSH 凭证取得交互 Shell、任意端口转发或 production 网络访问；
- 数据库身份拥有 owner、DDL、写入或 RLS 绕过能力；
- 原始快照写入未加密存储、Windows 挂载、普通临时目录或 CI artifact；
- 删除普通文件后错误宣称完成可靠数据销毁；
- GitHub-hosted Runner 的 14 GB SSD 被镜像、快照、依赖或 Compose 卷耗尽；
- 不同 run、SHA、snapshot 或 operation 的证据被拼接进 Task 30；
- workflow 或 CLI 自报 `executionPurpose`，绕过已批准 dispatch 授权；
- 同一个原始 v1 proof digest 被重新包装为另一 purpose，或 qualification lineage 被重新解释、拼接为可提升 RC；
- 一个含糊批准对象同时授权 dispatch、云端 capability 和数据库命令，导致尚未产生的数据库、Manifest 或计划身份被提前批准；
- 通过 v1 `oidc-cloud-role`、snapshot consumer role 或组合凭证向 lineage 私有 namespace 写入，绕过前向 v2 的封闭 job/profile 矩阵。

### 信任根

- GitHub 受保护环境的人工批准记录；
- root policy 固定的 `environmentPolicyIdentityDigest`，以及批准后独立生成的 `environmentPolicyObservationDigest`；
- 固定 `main` SHA、workflow path、workflow ref、run ID、run attempt 和 job name；
- GitHub API 返回并由本地可信启动器复核的 workflow/job/deployment 状态；
- 由本地 root policy 预先批准的 workflow blob digest、允许的 action commit 清单和 `snapshot-admission.v1` Schema digest；
- JIT/ephemeral Runner 配置及本次唯一高熵标签；
- WSL root-owned 本地策略、adapter digest 和最小网络策略；
- 受限 SSH authorized-key/sshd 规则及 Staging 只读数据库角色；
- 私有 content-addressed object store、独立加密密钥信任链、对象版本/保留策略，以及后续 attestation 和 digest readback；
- S1 已批准的 repository contract、build proof 和原始 v1 proof Schema；
- 受信签发、不可覆盖且可撤销的 `rc-dispatch-authorization.v1`、`exact-capability-approval.v1`、前向 `exact-capability-approval.v2`、独立 prerequisite 变更批准和既有 `approval-record.v1` 命令执行批准；
- 纳入 repository contract digest 的 `execution-purpose-envelope.v1`、purpose claim、lineage use/access proof、v2 custody、v2 aggregate 和 v2 exit Schema；
- 固定 workflow 的 path/ref/blob digest、受保护运行身份，以及可信保管中原始 proof、envelope 和下游证明的 digest readback。

普通 tag、Runner 自报标签、环境变量、自报 SHA、持久 Runner 注册状态、文件名或单独的人工口头确认均不能构成信任根。

## 目标执行拓扑

```text
Qualification（Task 29R 基础设施验证；永久不可提升）
  qualification RC dispatch authorization
  → 独立 qualification snapshot producer
    → qualification releaseAttemptId / snapshotRunId
    → snapshot admission / environment approval / JIT WSL
    → private encrypted snapshot + producer proof/custody
  独立 qualification RC workflow run
    → Task 29R source/final 原始 v1 proofs
    → 一对一 purpose claims/envelopes（purpose=qualification）
    → v2 custody → v2 aggregate → v2 exit
    → TASK_30_AUTHORIZATION_REQUIRED → 停止并保管历史验证记录

Task 30 获批、合并到 main 后（不得复用上面的任何 RC 输入）
  新 main SHA / 新 build proof / 新 bundle
    → 新 release-candidate RC dispatch authorization
    → 新 release-candidate snapshot producer
    → 新 releaseAttemptId / 新 snapshotRunId
    → 唯一 release-candidate RC workflow run（rcWorkflowRunId，attempt=1）
      → Task 29R 前缀原始 v1 proofs
      → 一对一 purpose claims/envelopes（purpose=release-candidate）
      → v2 custody → v2 aggregate → v2 exit
      → Task 30 audit → final custody
```

两条链共享基础设施协议，但不共享可被选择为证明输入的 producer、source SHA、build proof、bundle、`releaseAttemptId`、`snapshotRunId`、`rcWorkflowRunId`、原始 proof、envelope、custody、aggregate 或 exit。Qualification 只能证明基础设施曾按获批边界运行，不能作为可提升 RC 的前序节点。

production/staging 服务器不能运行 source database test 或 final Compose。WSL snapshot 边界也不能取得 production 凭证、production 网络路径或 Docker 宿主权限。

## Bootstrap Canary 独立授权（本次待复审补充）

### 适用边界与唯一运行身份

Canary 只验证 GitHub subject 切换后能否取得预期 Aliyun 临时身份；它发生在 RC dispatch 授权之前，不是 Producer、RC、Runner 命令或 lineage job。采用独立、窄范围 `bootstrap-canary-run-authorization.v1`，不扩大 `exact-capability-approval.v1/v2`，也不提前生成 Release Attempt。把 canary 塞入 v1/v2 会改变已批准权限矩阵；推迟到 RC 内则使 RC 的信任前置条件依赖 RC 自身，均不采用。

固定边界如下，任何变化先修订本附录，不接受 CLI 自选 workflow、action 或能力：

- 仓库为 `keqi119/subscription-Saas`，immutable repository ID `1253231368`；dispatch actor/reviewer 为 `keqi119`，immutable user ID `275060624`；
- workflow 为 `.github/workflows/snapshot-oidc-canary.yml`，唯一探测 job key 为 `oidc-canary`；只允许 `workflow_dispatch`、受保护 `refs/heads/main` 上冻结的准确 SHA、GitHub-hosted `ubuntu-24.04`、`run_attempt=1`；workflow blob、action 完整 commit、探测入口及依赖 digest 必须预先批准。不得自动追随新 main；
- 使用已完成独立变更批准及 readback 的 `stage1-snapshot-export` Environment，但每次 canary 有自己的 pending deployment、人工批准和 observation；不得复用 Producer 两次批准或 RC consumer 批准。沿用该 Environment 的 ID/reviewer/main-only、禁 bypass、identity/observation 分层；`prevent_self_review=false` 的单操作员设计风险在本补充中仅申请覆盖这个无数据权限 canary，不扩大到其他 Environment；
- 以已分配的 `infrastructureChangeId` 关联本次基础设施变更，以 GitHub 实际返回并独立核对的 `canaryRunId` 标识运行。授权绑定固定 job key 和实际 pending deployment ID；尚未分配的数字 job ID 不得伪造，实际启动后进入 observation/use proof；
- 禁止 PR、fork、`pull_request_target`、评论、任意 ref、reusable workflow、rerun 和 self-hosted/JIT；禁止 `releaseAttemptId`、`snapshotRunId`、`rcWorkflowRunId`、RC dispatch digest、build proof、Manifest 或数据库身份等不适用字段。Canary 不声称三镜像 bundle 已存在；
- 结果只能作为基础设施配置验证记录，不能被包装成 qualification/release-candidate envelope，不能代替真实 Producer/RC 验证，也不能作为 v2 aggregate/exit 的执行证明输入。

### 四个不同的授权对象与不可倒置时序

“无凭证 dispatch”是指不授予 OIDC/STS/数据凭证，不是匿名调用 GitHub：操作员仍使用既有、独立认证的控制面身份发起固定 workflow。Dispatch 输入仅包含 `infrastructureChangeId` 和受信 canary intent 引用；intent 冻结预期 source/workflow/root-policy identity，不引用未来 run、deployment、readback 或成功证明。

| 对象                                          | 生成时点与已存在的绑定                                                                                                                     | 不能授权的内容                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 无探测凭证的 dispatch intent/回执             | 先批准固定变更意图，再 dispatch；回执记录实际 `canaryRunId`、attempt、source 和 pending deployment                                         | 不允许取 OIDC/STS；不替代运行授权或 Environment 批准                          |
| prerequisite 的 `external-change-approval.v1` | 每项 Provider、精确 role/trust、Environment 或 repository subject 变更各自 `plan → 人工批准 → apply/readback`；plan 只引用当时已存在的事实 | 只批准该项控制面变更，不允许探测、签发临时凭证或放行 job                      |
| `bootstrap-canary-run-authorization.v1`       | 实际 run/pending deployment 已存在，全部 prerequisite 和 subject 切换已完成 readback 后，由独立信任根签发                                  | 不引用未来 Environment observation、token、调用结果；不授权资源修改或数据操作 |
| 该 canary job 的 Environment 人工批准         | 核对上述运行授权及其实际 readback 后才放行；批准后生成新 observation                                                                       | 不能补发、扩大或替代运行授权；不能放行 Producer/RC 或第二个 job               |

完整顺序固定为：

```text
独立控制面签发/撤销/保管机制就绪并 readback + infrastructureChangeId
  → 现有 OIDC consumer 盘点/owner 确认 + 固定 main/workflow/intent
  → 无探测凭证 dispatch → 实际 canaryRunId / attempt=1 / pending deployment
  → Provider 与 future-subject 精确 role 的独立变更批准 → apply/readback
  → 确认既有消费者的兼容条件就绪
  → repository subject 独立变更批准 → apply/readback
  → 独立签发 canary 精确运行授权并完成保管/readback
  → 单独批准 canary Environment deployment → 独立控制面读取批准记录及实际 job
  → 单独发布签名运行 checkpoint（批准后 observation + 已提交撤销状态），不更新 capsule
  → job 只读取得并复核 checkpoint / GitHub 批准记录 / 当前 authority head
  → 固定入口完成 OIDC 前准入 → 单次 OIDC → AssumeRoleWithOIDC → GetCallerIdentity
  → 禁止继续签发 / 凭证失效 / 进程处置 → 独立证据保管/readback
```

Provider/Environment 等共享 prerequisite 可更早就绪，但必须在该运行授权前重新读取并核对；不能把计划中的预期 readback 当实际值。Role 与 subject 变更是不同 operation，执行前各自重读并重算确定性计划；基线不一致则重新计划/批准，不直接覆盖。Canary 环境提前获批、run 启动超前、授权缺失或 prerequisite 为 UNKNOWN 时，立即拒绝凭证请求；后补批准不能追认本次运行。

### 独立签发信任根与精确授权契约

使用受控操作员签发端的 Ed25519 key descriptor，公钥指纹、签发者、策略 digest 和撤销 authority 通过独立人工变更批准固定在受保护验证策略中；私钥不进入 workflow、环境变量、仓库、artifact 或 canary VM。建立/更换这个签发端必须先有独立批准和 public-key challenge/readback。它复用现有设计中的 root 签名/控制面 journal 模式，但不得依赖尚未实施的 I13 WSL admission signer、Snapshot Adapter、GitHub App/JIT、被测 GitHub OIDC、云端 STS 或 KMS 授权链。

该独立签发/保管前置条件必须在附录获批后的计划修订中排到 canary 前面；不存在已验证的签发端时停止，不把计划中的组件记为就绪。GitHub OIDC JWT 只作为被测身份输入验证，不能作为批准签名、撤销制品或 canary 成功证明的信任根。

`bootstrap-canary-run-authorization.v1` 使用 `additionalProperties=false`，必填分组如下：

| 分组              | 必填内容                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约与变更        | Schema version、authorization ID、`infrastructureChangeId`、本次唯一 operation ID、intent/dispatch receipt digest、canary policy/repository contract digest                                                                   |
| 精确运行          | repository/actor immutable ID、准确 source SHA、workflow path/ref/blob digest、固定入口/依赖 digest、实际 `canaryRunId`、attempt=1、job key、pending deployment ID、Environment stable identity digest                        |
| 实际 prerequisite | 每项 external-change approval、apply proof、readback digest；Provider ARN/issuer/audience/证书指纹/issuance-limit；精确 role ID/ARN、trust/permission policy digest、subject template readback、既有 consumer 保护记录 digest |
| 探测约束          | 预期完整 `sub`/issuer/audience、精确 STS endpoint/account/role/session-name；固定两项 API、各最多一次、`DurationSeconds=900`、禁止刷新/自动重试、探测超时最多 300 秒及最大时钟偏差 60 秒                                      |
| 签发与保管        | 独立 issuer/key fingerprint、签发/失效时间、撤销 policy digest 和签发时序号、只增 journal 引用、批准对象的预期保管策略                                                                                                        |

授权的 canonical bytes 不引用尚未产生的自身 signature/custody digest；先计算 SHA-256，再以独立签名信封绑定该 digest，最后生成独立 readback receipt。Run 前 intent、变更批准、运行授权和 Environment observation 各自有不同类型及生成时点，验证器不允许互换，也不能用 `approvalMode=ci-policy` 跳过本次人工运行批准。

签发时验证可信撤销来源：受同一独立 root policy 约束的签名撤销记录须绑定 issuer、policy digest、单调 sequence、issuedAt/notAfter 和撤销 ID/digest；在受保护控制面 journal 中记录已观察最高序号。Capsule 中的序号只是签发基线，不是运行时撤销结论。取 OIDC 前必须按下节在线读取独立运行 checkpoint 及 authority head；60 秒只是拒绝陈旧观察的上限，不证明快照是最新状态。缺失、不可访问、过期、错误签名/subject/policy 或回放旧空集合一律 `PREFLIGHT_REJECTED`。授权最多有效 15 分钟；超时、撤销或策略漂移需取消旧 run，不能延长旧授权继续执行。

签发端以 `infrastructureChangeId/canaryRunId/attempt/job-key` 条件创建唯一授权 journal 项；Environment 放行前记录本次许可已分配，其他 run/attempt 不得消费，失败不退回可用。固定 job 无循环、matrix 或重试入口；保管网络重试只允许相同字节的只读核对，不能再次运行探测。签名和撤销检查不能只由 CLI 自报通过。

批准前交接固定为该 Environment 的非秘密变量 `BOOTSTRAP_CANARY_AUTHORIZATION_CAPSULE`：仅携带 canonical 授权、独立签名、授权保管/readback receipt、签发基线撤销序号，以及预先批准的运行证据读取契约 identity；不含批准后 observation、未来 checkpoint digest、私钥、JWT/STS 或控制面凭证。其字段须全部通过非敏感白名单检查；每次写入须有独立、精确 run/digest 的变更计划/批准，读取 API 核对完整值的 digest 后才能批准 deployment；同一 Environment 同时最多有一个未结束的 canary，禁止覆盖在用 capsule。该传输 readback 后置于运行授权，不反向写进授权 bytes。固定 job 在运行时把变量值作为数据读取，不插值为 Shell，依据预先固定的公钥验证；变量不是信任根，job 已启动也不是 Environment 批准证据。大小超限、缺失、签名错误或运行身份不匹配均停止，不改用公开完整 artifact 或长效授权兜底。排队不会更新 capsule；后续观察通过独立通道取得，授权过期则取消并使用新 run。

交接值不得超过单变量 48 KB；禁止 repository/organization/workflow 的同名变量遮蔽，也不能在 job 启动前用变量值计算授权事实。Environment 变量的可用时点及容量按 [GitHub 配置变量规则](https://docs.github.com/en/actions/reference/workflows-and-actions/variables) 验证，后续须做真实无云凭证交接测试；不能把静态 YAML 测试当成交接已可执行的证据。

### 批准后证据的独立只读交接

固定采用既有 GitHub API 的数据发布/读取能力，不覆盖 capsule、不向 job 注入控制面 token，也不新建回调服务。独立控制面把 canary 专用的签名 checkpoint 发布到同一 repository 的精确数据 ref `refs/heads/infra-bootstrap-canary-state`，tree 只允许 `canary-state.json`，不得包含 workflow、脚本或可执行文件。它不是 main/source SHA，不得 checkout、执行、合并到 main 或作为 RC 制品；仅为 canary 的非敏感运行状态通道。创建/保护该 ref、限定 publisher 身份及发布策略须先经独立外部变更批准/readback，纳入 capsule 的读取契约；本轮不创建它。完整授权、原始响应及最终证明仍只在既定本地私密保管区保存。

读取契约必须固定 repository immutable ID、API host、精确 ref/path、实际 genesis commit/checkpoint digest、publisher/key identity、保护规则 readback 和 Schema digest；这些均在 capsule 冻结前就绪，不引用未来 `READY` commit。动态 checkpoint、发布/读取回执及其 hash 链同步进入原有私密保管/备份与 180 日保留规则，数据 ref 不是最终证据保管的替代品。

| 参与方                        | 身份、来源与允许动作                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 独立控制面 observer/publisher | 使用既有非 OIDC 控制面身份读取 GitHub Environment 配置、精确 run 的 review history、deployment/status 和实际 job；读取独立撤销 journal，以原 Ed25519 root 签名。发布身份与探测身份分离，固定入口只允许该数据 ref 的单父提交和非 force fast-forward；规则禁止其他写入者、删除、回退、merge commit 和 workflow 内容，不能向 job 交付写凭证 |
| job 内的证据读取入口          | 仅使用本 job 的 `GITHUB_TOKEN`，仓库权限显式为 `contents: read`、`actions: read`、`deployments: read`；未列权限关闭。固定 HTTPS `api.github.com` 的 GET allowlist 读取精确 ref/commit/blob、当前 run/attempt/job、review history 及目标 deployment/status；不使用 OIDC、PAT、root key、GitHub App 管理凭证或云端凭证                     |

`id-token: write` 仍只声明在这个受保护 job；证据读取阶段不得调用 OIDC token endpoint。读取身份的范围由 workflow 固定，不允许遇到 403 时注入管理员 token 或放宽权限。API 端点和所需只读权限依 [GitHub Git references](https://docs.github.com/en/rest/git/refs#get-a-reference) 与 [workflow review history](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run) 做实际无云凭证验证；不能只依据 job 环境变量推断已经获批。

**来源与绑定。** Environment 获批且实际 job ID 可读取后，observer 重新取得 GitHub 返回的 review record、reviewer immutable ID、审批状态、deployment 与 run/job 关联，并重读 Environment stable identity。签名的 post-approval observation 必须绑定 repository ID、`infrastructureChangeId`、`canaryRunId`/attempt、source SHA、workflow/job key、实际 job ID、原 pending deployment identity、实际 deployment ID、authorization/capsule digest、Environment identity digest，以及规范化 API response digest、读取时间和审核记录。批准记录不能证明其属于该 deployment、存在 bypass、身份漂移或 API 尚未提供记录时，不发布允许准入的状态；只能等待或拒绝。Job 用自己的只读 GET 复核 GitHub 的审核/部署/run/job 事实，与签名 observation 比对，不信任 caller-provided JSON。

**状态不是第二份授权。** `canary-state.json` 是独立的封闭签名运行 checkpoint，绑定上述 observation、撤销 authority/policy、当前已提交 sequence、该授权是否撤销、累计撤销 ID/digest、前序 checkpoint digest、签发/失效时间及 `BLOCKED|READY|REVOKED|CLOSED`。它只能收紧已签发的授权，不改变 scope、有效期或 run；同一授权初始状态为 `BLOCKED`，`READY` 必须有真实批准后 observation，`REVOKED/CLOSED` 不可返回 `READY`。后续新 run 必须有新授权并从 `BLOCKED` 开始，仍保留旧授权的累计撤销/关闭记录。Payload 不引用自己的 commit/receipt；先 canonical digest/签名、再提交、更新 ref、独立 readback，后置 receipt 引用 commit 与 payload digest。完整原始证据先入本地保管，公开数据仅含经过字段审查的身份、digest、状态和时间；不发布完整授权、策略或任何秘密。

**撤销的权威读取及发布。** 对 canary 取用者，固定受保护 ref 中通过 root 签名校验的单调提交序列是撤销的在线已提交视图；本地 journal 保留意图/批准、已提交序号和发布回执，不能把尚未提交的本地快照冒充远端已生效状态。发布 `READY` 与撤销使用同一串行控制面队列：在锁内重读 journal、取得实际 GitHub 观察并检查所有待办撤销；有待办撤销不得生成 `READY`，先发布 `REVOKED`。每次提交仅以刚读取的 head 为唯一 parent，`force=false` 更新并 readback；冲突时重读事实、重新计算，不能把旧 `READY` 覆盖到撤销之后。撤销只有在否决状态发布/readback 后才记为已提交；发布失败或结果不明须取消/阻断 run、关闭新 assume 并保留 UNKNOWN，不得报告撤销完成或继续许可。不得批量恢复旧 head。

**job 取用算法。** 在尚未请求 OIDC 的有界等待阶段（最多 300 秒），入口从固定 API 精确读取当前 ref `H1`，按该 commit 读取固定 blob，验证 canonical digest、root 签名、parent/sequence、capsule 基线及本 job 已观察最高序号；检查授权有效、状态为 `READY`、未撤销以及全部 run/deployment/job/observation 绑定。只接受 API 的新 200 响应，不使用本地 cache、artifact、调用者传入的旧 commit、304 响应或 `raw.githubusercontent.com` CDN 内容代替 authority 读取。随后复核实际 GitHub 审核/部署状态，再直接重读同一 authority ref 为 `H2`；仅 `H1=H2` 且所有核对通过时才能做 OIDC 前准入决定。Head 改变就重新读取并校验，不是继续使用旧内容；观察超过 60 秒、缺失、不可访问、签名/sequence 不符、撤销或超时都在取 OIDC 前失败。

此算法只证明本次两次在线读取所见的已提交状态和签名观察，不把 HTTP 时间、两次相同 head 或 60 秒 TTL 声称为全局线性一致/未来持续未撤销。准入记录必须保留 `H1/H2`、sequence、response/request 时间与 digest，并在紧邻 OIDC 请求处再检查本地超时/取消状态；不能把许可缓存给后续步骤或别的 run。发布/readback 与取用的竞态、GitHub API 一致性必须通过下列真实交接测试；若无法满足已提交撤销的可见性门槛，则停止，不改成快照准入。准入读之后发生的撤销按取消 job、停止新 assume 和既定 expiry/UNKNOWN 处理；不宣称能追溯阻止已经获准或已发出的请求。

**无云凭证交接验收（后续计划门槛，本轮不执行）。** 使用同一固定只读入口和实际 GitHub Environment/API 通道，`id-token: none`，不配置云凭证，探测器以 fail-on-call hook 记录 OIDC/STS 调用次数。必须验证：

- capsule 在批准前冻结，批准后不变；job 通过独立通道拿到真实 review/deployment/job observation，成功路径只输出 `HANDOFF_VERIFIED_NO_OIDC`，不报告 canary 成功；
- capsule 写入后、运行读取前提交撤销，即使旧 capsule/checkpoint 尚未超过 60 秒，也必须因当前 head 的撤销记录拒绝；在 `H1` 与 `H2` 之间提交撤销也必须重读并拒绝；
- 批准后 observation 缺失、wrong run/job/deployment/reviewer、bypass、读取身份 403、签名错误、旧 sequence/commit 回放、首次 checkpoint 发布部分失败/UNKNOWN 而未取得可验证 `READY`、60 秒陈旧及 300 秒等待超时均拒绝；
- 所有拒绝场景都断言 OIDC endpoint 请求数、AssumeRoleWithOIDC/GetCallerIdentity 调用数、云凭证读取数为 0。使用确定性 barrier 安排撤销/读取顺序；不能用 sleep 或模拟“job 已启动”替代事实验证。

该补充只增加 canary checkpoint 的封闭数据契约及只读交接检查，复用已有 Git API、签名、journal 和 digest 组件，不新建通用 bootstrap 服务。所有通道创建、publisher 配置与真实交接测试须先进入获批后的计划修订；Task 29R/Task 30不因此解除阻断。

### 验证组件复用边界

实现复用现有 canonical JSON、SHA-256、binding/time 检查、只增 journal、撤销防回退和 custody readback 组件。现有 `approval.mjs`/`approval-revocations.mjs` 的正式入口固定为数据库批准及 GitHub artifact attestation，不能原地放宽或假装独立签名也是该 attestation。未来只增加这个封闭 canary 类型的薄验证适配，复用可独立提取的纯检查；不新增通用 bootstrap command registry、服务、任意 Shell/SQL 或应用 RBAC。本轮只规定设计，以上新契约与验证适配均未实施。

### Subject 切换、消费者保护与探测权限

切换前由独立控制面身份盘点 repository-wide subject 的所有既有 OIDC consumer、旧模板、精确 trust 条件和 owner。已运行/排队消费者必须先完成或受控暂停；逐 consumer 取得迁移/兼容确认并先在云端配置经批准的新条件。禁止 wildcard 扩权作为兼容方案，禁止覆盖未知消费者。清单未知、owner 未确认或无法安全暂停时，以 `OIDC_CONSUMER_MIGRATION_REQUIRED` 停止。

固定 Provider 为已批准配置的实际 ARN，issuer 为 `https://token.actions.githubusercontent.com`、audience/client ID 为 `sts.aliyuncs.com`；证书指纹、issuance limit 与其受信读取时间分别记录，不将这些字段交给 canary 参数覆盖。完整 subject 按批准模板的字段顺序、转义和仓库实际 immutable-subject 格式计算，绑定 repository identity、workflow_ref/workflow_sha、ref、environment、actor_id、run_id/run_attempt、event_name 和 runner_environment；不能拼猜缺失 claim 或用名称取代实际 immutable ID。

先完成 Provider 与本次 future-subject role 的 apply/readback，再改变 repository template；切换后再次 readback，精确运行授权只引用这些已存在的事实。该顺序遵循 [GitHub OIDC subject 配置说明](https://docs.github.com/en/actions/reference/security/oidc)。共享 subject/provider 在 canary 结束后不自动删除；失败恢复旧模板同样需要独立计划/批准、当前状态核对及消费者兼容证明，不能盲目回滚其他消费者的合法变更。

探测进程只有两项 Aliyun API：一次 `AssumeRoleWithOIDC`，随后用所得凭证一次 `GetCallerIdentity`。Role 仅信任本次精确 Provider/sub/audience，不附加任何业务 Allow、管理策略或角色链式扮演权限；请求显式使用收窄 session policy，并复核 role 所有附加/内联策略。禁止 OSS（包括 lineage）、KMS、数据库、JIT、RAM 管理、业务 API 或“验证禁止权限”的真实试调用。`GetCallerIdentity` 本身不需要 RAM 权限，不能为使其通过添加通用 STS/云资源权限，参见 [Aliyun GetCallerIdentity](https://www.alibabacloud.com/help/en/ram/developer-reference/api-sts-2015-04-01-getcalleridentity)。

两 API 是固定执行入口的 allowlist，不宣称仅凭 RAM policy 就能约束所有无授权 API。GitHub 的 `id-token: write` 仅在受 Environment 保护的探测 job 声明；其他 job 不得请求 token。入口先验证运行授权、当前 readback 和批准后 observation，再取唯一 OIDC token；验证 JWT 签名、时效和精确 claims 后才调用 STS。JWT/STS secret 只在内存中使用，禁止磁盘、命令行、日志、core dump、SDK credential cache 和自动刷新；控制面管理员/签发/保管凭证不进入该进程。

Provider/role/template 的读取、变更及证据收集由独立控制面进程使用既有、非被测 OIDC 的窄身份完成；它们不是 canary probe 的第三项 API。Probe 只返回白名单化观察与 request ID，独立核对 GitHub 实际 run/job、云侧审计关联和预期 account/role/session；不能凭外部 JSON 或 job 的一句“成功”形成通过证明。记录实际 runner image、kernel 和工具版本。该结果仅证明身份链及策略 readback，不证明 snapshot、KMS、数据库或最终发布物可用。

### 凭证失效、UNKNOWN 与非循环保管

`AssumeRoleWithOIDC` 显式请求 900 秒，不使用默认 3600 秒；该 API 的最短请求期限为 900 秒，见 [Aliyun AssumeRoleWithOIDC](https://www.alibabacloud.com/help/en/ram/developer-reference/api-sts-2015-04-01-assumerolewithoidc)。运行授权有效期不是 STS 有效期；分别记录 token/STS 的实际签发和到期时间。Role 最大 session 配置及 SDK 固定请求共同限制有效期；返回超出已批准期限的凭证视为失败，不继续调用。

- 未请求 OIDC/STS 就失败：记录 `PREFLIGHT_REJECTED`，取消 run，不补发授权追认。
- 结果已确定的调用失败：记录 `FAILED`；禁止自动重新请求 token、重新 assume 或刷新 STS。
- 进程丢失、Assume 响应丢失、调用/保管结果不明：记录 `INTERRUPTED_UNKNOWN`，立即停止新增使用。独立控制面只读 reconcile run/job、request/audit 和 role 状态；不能重新探测把旧 run 改成成功。
- 每个 prerequisite role 计划同时明确终态关闭新 assume 的独立操作与批准边界。关闭 trust/角色 readback 不等于已签发 STS 被即时撤销；必须保留实际 expiry 或最坏到期上界。UNKNOWN 时以上一次可能签发时间至入口终止/签发路径关闭的可信上界、已批准最大 session 及 clock skew 计算等待窗口；不能证明上界时继续阻断。
- 调用完成或中断时立即 best-effort 清除内存并终止探测进程/销毁本次 VM，不为等待云端 expiry 保留秘密。独立控制面关闭新签发并确认所有可能 session 已失效后才允许下游；不把内存清除或删除 role 描述为密码学撤销。合法再试必须重新分配 `canaryRunId` 和 operation、重新 readback/签发/Environment 批准；相同基础设施变更范围可保留 `infrastructureChangeId`，但不能复用旧运行授权或证据。

Canary 证据固定走独立控制面签名及本地私密保管，不使用被测 OIDC attestation、OSS/KMS session 或 v2 lineage writer。保管区是操作员受控的加密证据卷，与仓库、Runner workspace、临时目录及同步盘隔离；实际卷身份/路径、ACL、备份位置、签发/写入服务身份、独立只读复核身份和 retention owner 先纳入独立批准的 root policy 并 readback。复用控制面变更 journal/文件保管接口，不新建常驻服务；该通道未就绪即禁止 dispatch。

每个对象使用 canonical digest 命名及 exclusive-create，受限写身份只能新增；读取身份从保管区重新读取字节核对 digest/签名并签发独立 receipt。离线受控备份同样需 readback；普通目录权限不被描述为能抵御宿主管理员的 WORM，签名、hash 链与独立备份负责篡改检出。保管/签发密钥不交给探测 job；可经 GitHub 传输的中间观察仅含字段白名单化非敏感 request ID、digest、时间和错误分类，仍是不可信输入，不能上传完整授权、策略、原始 JWT/STS 响应或秘密。

单向证明顺序为 `intent/dispatch receipt → prerequisite approval/apply/readback → 独立签名运行授权 → authorization custody/readback → Environment observation → 独立运行 checkpoint/发布回执 → job 在线读取/准入记录 → probe observation → expiry/处置记录 → bootstrap-canary-execution-proof.v1 → 独立签名/最终 custody receipt`。最终 proof 绑定全部前序 digest、实际 run/job、策略 readback、两个调用的请求/身份核对、撤销观察及终态；不引用自身最终 receipt，也不引用未来 RC。签发端独立验证来源观察后签名，未观察到的结果不得补造；UNKNOWN 的诊断以追加记录引用旧 proof，不覆盖旧终态。Checkpoint 和 job 准入记录后置引用 capsule/authorization digest，不回写批准对象。

失败 proof 按已到达阶段使用封闭判别分支：未执行的动作必须是 `NOT_EXECUTED`，结果不明的动作为 `UNKNOWN`；仅已完成阶段要求对应实际 digest/ID。不得为了满足成功 proof 字段而伪造 Environment observation、job ID、STS expiry 或第二次调用结果。Capsule 的独立变更/readback 由 use proof 后置引用；其撤除亦按独立控制面变更留痕，不能被解释为 STS 已撤销。

成功、失败、拒绝和 UNKNOWN 使用相同保管规则：owner 为指定 S1 基础设施负责人；仅批准的操作员与只读复核人访问；至少保留至 canary 授权及所有潜在凭证失效后 180 日，调查/legal hold 延长而非缩短保留。到期由独立 retention 身份按批准处置并保存删除/转存 receipt。保管/readback/备份未完成不得记为成功或继续 subject 迁移后的下游运行；云审计暂不可取得时保持未完成，不以网络故障豁免。

### 局部设计验收与退出

后续计划必须为本节增加封闭负向验证：假 run/未来事实、错误 workflow/ref/actor/attempt、提前 Environment 放行、签名依赖被测 OIDC、缺少实际 prerequisite readback、旧撤销集合回放、过期授权/observation、旧消费者未保护、role 业务权限/组合凭证、第三项 API、自动刷新/重试、保管覆盖及 UNKNOWN 重跑，均 fail closed。允许路径必须证明零 Release Attempt 字段、零数据库连接、零数据权限、两 API 各最多一次以及完整独立 custody。

本节授权/proof Schema、封闭 canary checkpoint/读取契约、固定 job/API 矩阵、独立签名/撤销/时效策略和负向检查纳入后续 repository contract digest，但既有 v1/v2 Schema/验证语义不变。设计只服务这个窄范围探测的授权、运行交接和结果；不能推广为其他 bootstrap 命令、日常运维身份或通用特权入口。不能满足独立签发、消费者保护、精确 subject 或凭证失效/保管时，停止 canary 和后续施工，回到设计评审。

## Public Repository 排他路由协议

GitHub 明确建议 self-hosted Runner 只用于 private repository，因为 public fork 可能通过 workflow 执行危险代码。GitHub 同时推荐 ephemeral self-hosted Runner；它只接收一个 job，完成后自动注销，有助于限制跨任务残留和被攻陷 Runner 再次接单的风险。标签路由只保证 job 与 Runner 标签匹配，不能单独证明 job 可信。参见 [Adding self-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners) 和 [Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)。

因此方案 A 必须同时满足以下条件。

### Protected Environment 目标契约

GitHub environment 保护规则可以要求人工审批、限制部署分支并禁止管理员绕过；在 required reviewer 启用时，environment secret 也只能在批准后交给 job。参见 [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)。但 environment 名称本身不是信任根，当前 API `404` 也不得被解释为“稍后自动创建即可”。

目标配置固定为：

- repository：`keqi119/subscription-Saas`，immutable repository ID `1253231368`；
- environment name：`stage1-snapshot-export`；
- environment ID：当前显式状态为 `ABSENT`；在另行批准的实施步骤创建后，由 GitHub 分配的数字 ID 必须先进入 `environment-policy-identity.v1` 和 WSL root policy 并再次人工批准，之后才允许首次 JIT 注册；删除后以相同名称重建得到的新 ID 视为不同环境，必须重新评审；
- required reviewer：GitHub user `keqi119`，immutable user ID `275060624`、node ID `U_kgDOEGUXkA`；禁止 team、可变 login 或仅凭显示名替代；
- deployment branch/tag policy：使用 selected branches and tags，唯一 branch rule 为精确 `main`，tag rule 数量为零；不得使用“protected branches only”，避免在没有或改变 branch protection 时扩大允许范围；
- `can_admins_bypass=false`；任何 bypass deployment 均无效；
- `prevent_self_review=false`；
- 唯一允许的 dispatch actor：同一 immutable user ID `275060624`；
- wait timer：`0`；environment 不保存数据库、SSH、tokenization 或 publisher 原始 secret。

当前只有一个管理员协作者，因此上述 `prevent_self_review=false` 明确保留“同一操作者 dispatch 并审批”的单操作员风险。批准本附录即表示仅对该固定 workflow、固定 actor/reviewer 和本次 JIT 协议接受该风险；它不等同于独立双人复核，也不得推广到其他环境。若不接受该风险，唯一合法替代是先增加独立 reviewer、将 `prevent_self_review` 改为 `true` 并重新批准 environment policy；实施者不得临场选择。

Environment policy 固定拆成两层，均使用规范化序列化：

- `environment-policy-identity.v1` 只包含稳定规则：immutable repository ID、environment ID/name、required reviewer ID、精确 branch/tag policy、`can_admins_bypass`、`prevent_self_review`、允许 dispatch actor ID、wait timer、workflow blob digest 和允许 action 清单；其 `environmentPolicyIdentityDigest` 由 WSL root policy 固定；
- `environment-policy-observation.v1` 记录一次具体读取：`environmentPolicyIdentityDigest`、`observedAt`、GitHub API response digest、deployment/run/job identity、实际 approval/review record、queued labels 和读取终态；其 `environmentPolicyObservationDigest` 是运行证明，不反向改变稳定身份。

`snapshot-admission.v1` 在人工批准前生成，只绑定 `environmentPolicyIdentityDigest`、source/workflow identity、`releaseAttemptId`、route nonce，以及已批准 `rc-dispatch-authorization.v1` 的 digest/purpose，不得引用尚不存在的 RC run ID 或批准后 observation。人工批准后、申请 Runner 注册凭证前，可信启动器重新读取 environment、deployment、review 和 branch policy，从响应中重算稳定 identity 并与 root policy 比较；匹配后才生成 post-approval observation。该 observation 的 `observedAt` 距申请 JIT 配置不得超过 5 分钟；超时必须重新读取并生成新的 observation，不能修改旧记录。

JIT launch proof 同时绑定 `snapshotAdmissionDigest`、`environmentPolicyIdentityDigest` 和最新 `environmentPolicyObservationDigest`。策略漂移只比较 identity digest；审批、queued 状态和时效只检查 observation provenance，二者不得合并成一个自相漂移的 digest。

下列任一情况必须在取得 JIT 注册凭证前 `PREFLIGHT_REJECTED`：environment `404`/ID 变化、无 required reviewer、reviewer ID 不匹配、branch/tag 规则多于或不同于精确 `main`、`can_admins_bypass=true`、`prevent_self_review` 与获批值不同、dispatch actor 不匹配、批准记录为 bypass、approval 尚未完成、identity digest 漂移、observation 超时/缺失/与 admission 不一致，或 GitHub API 无法读取。负向门禁必须逐项覆盖这些情况。

### 固定事件与运行身份

snapshot admission 只接受：

- repository：`keqi119/subscription-Saas`；
- event：人工 `workflow_dispatch`；
- ref：`refs/heads/main`；
- source：触发时冻结的 40 位完整 commit SHA；
- workflow run ID：冻结为不可复用的 `snapshotRunId`；
- run attempt：`1`；
- workflow path：固定的 sanitized snapshot workflow；
- job name：固定的 snapshot export job；
- environment：`stage1-snapshot-export`；
- environment deployment 已由允许的 reviewer 人工批准；
- 本次 `releaseAttemptId` 尚未消费 snapshot runner。

固定 source SHA 本身不能证明 workflow 内容安全。admission 必须计算并记录该 SHA 下 snapshot workflow 的 Git blob/content digest；本地可信启动器还必须独立从 GitHub API读取该 SHA 的实际 workflow blob，重新计算 digest，并与 WSL root policy 中预先批准的 digest 精确匹配，不能只相信 workflow 自报值。workflow 路径或内容发生任何变化都必须先独立评审并更新 root policy，不能由本次 workflow 自行批准自身。工作流内引用的 action 必须按完整 commit SHA 固定，并进入同一允许清单；启动器对实际 workflow 重新解析和核对该清单。

`pull_request`、fork、`pull_request_target`、`issue_comment`、`workflow_run`、schedule、任意 tag、任意 branch、rerun attempt 和 repository dispatch 均不得取得 self-hosted 路由。

### 唯一路由标签

固定通用标签 `stage1-snapshot-export` 只表达能力类别，不足以路由本次实例。GitHub-hosted admission job 必须为每次运行生成至少 128 bit 随机 nonce，并将下列唯一标签同时绑定到 `snapshot-admission.v1` 和待批准的 snapshot job：

`stage1-snapshot-export-<runId>-<nonce>`

workflow job 的 `runs-on` 必须精确要求五个标签：GitHub 默认标签 `self-hosted`、`linux`、`x64`，固定自定义能力标签 `stage1-snapshot-export`，以及本次唯一标签。JIT Runner 保留上述三个默认标签，自定义标签集合只能是能力标签和本次唯一标签，不得携带其他通用或历史标签。nonce 只能由已通过 workflow digest 校验的 GitHub-hosted admission job生成，不得由 PR、仓库脚本、调用输入或任意 ref 选择。snapshot job 通过 `needs` 取得该标签，在 environment 人工批准后才进入等待分配状态；本地可信启动器只从 GitHub API 和已 attest admission 读取标签，不接受人工复制或命令行传入的标签。

注册前，可信启动器必须从 GitHub API 重新读取并核对：repository、workflow path/ref、source SHA、run ID、attempt、job name、environment deployment、审批者、queued 状态和 labels。任一字段不一致、存在第二个相同标签 job、审批被撤销或 API 不可用时，不注册 Runner。

### JIT/ephemeral 生命周期

- 只能使用 GitHub JIT 配置 API或带 `--ephemeral` 的一次性配置；优先使用 JIT 配置；
- 在 environment 人工批准并完成上述 job 身份核对前，不得申请注册凭证；
- 本地启动器只能使用短期、最小范围的 GitHub App/等价受信令牌取得 JIT 配置；管理令牌、注册令牌和 JIT 配置不得进入 Runner job、环境变量、workspace 或日志；
- Runner 的自定义标签只能包含固定能力标签和本次唯一标签；其完整标签集合必须与本节声明的五项完全一致，不保留可接受其他通用任务的在线实例；
- 使用固定且仍在 GitHub 支持窗口内的 Runner 版本，记录二进制 digest；
- 禁止自动更新改变本次实例内容；版本过期或需要安全更新时，在注册前重新制作并批准基础镜像；
- Runner 最多执行一个 job；job 终止、取消、超时或 GitHub 分配结果不明时立即视为已污染；
- Runner 自动注销后，可信启动器还必须从 GitHub API确认其不再可路由；
- 诊断日志必须实时或在销毁前进入外部受控保管；发布前完成秘密/原始数据脱敏和扫描，只允许记录引用、不可逆指纹、计数、状态与已批准错误分类；
- 禁止将 ephemeral Runner 重新注册、复用或转为 service。

如果 GitHub API 无法证明唯一 queued job 与实际分配 job 相同，或 workflow 无法使用本次唯一标签，方案 A 不得实施。

## Snapshot Job 封闭执行面

### 三段式工作流

后续获批实施时，现有 snapshot workflow 必须拆为下列三个 job，并作为独立 `workflow_dispatch` producer run 完整结束。它不作为 RC run 内的 reusable workflow，RC run 也不得在启动后临时选择内联或外部 snapshot 模式：

1. **GitHub-hosted admission job**：checkout 固定 SHA，计算并记录 workflow digest 和允许 action 清单、验证 repository contracts、生成 route nonce 并 attest `snapshot-admission.v1`；实际 workflow blob 与本地 root policy 的独立一致性判断仍由可信启动器完成；
2. **self-hosted data job**：不 checkout repository、不运行任何 `uses` action、不运行 `pnpm install`、不加载仓库 Node 模块、不执行仓库 package scripts，只调用固定 root-owned adapter；
3. **GitHub-hosted producer custody continuation**：从受控交接位置只接收加密对象引用、已完成脱敏/扫描的非敏感 proof、publisher receipt 和销毁证明，复核密文 digest/object version、attestation 与处置终态后形成 producer completion proof。该 job 不下载明文 dump、不取得 KMS Decrypt、不解包 DEK，也不解密 snapshot。

本附录明确选择独立 `snapshotRunId` producer；S1 实施计划必须在 Task 29R 恢复前按此拓扑局部修订并重新批准。该修订只负责把唯一执行方式写入计划，不授权修改 workflow 或运行 snapshot。

self-hosted 数据 job 的数据处理命令只能是固定入口，例如：

`/opt/subscription-saas/snapshot-adapter/v1/launch --admission-ref <opaque-reference>`

self-hosted data job 必须只有一个固定 `run` 入口调用上述 adapter；不得在该 job 中下载或执行 checkout、artifact、attestation 或第三方 action。加密 sanitized snapshot、snapshot proof 和 diagnostic log 的发布由 adapter 内置、digest 固定且最小权限的 publisher 完成，写入预先批准的 content-addressed 交接位置；publisher 不得暴露 raw 路径、明文 sanitized dump、通用上传接口或任意目标参数。后续 GitHub-hosted producer custody continuation 才允许使用按完整 commit SHA 固定的官方 action 读取非敏感交接证明、复核私有密文对象 digest 并形成 Actions attestation；它不是 snapshot consumer，禁止 KMS Decrypt 和任何明文恢复。若无法提供这种封闭交接协议，方案 A 停止，不得退回到 self-hosted job 执行上传 action。

self-hosted job 的 GitHub `permissions` 必须显式收缩为固定入口运行所需的最小集合；不得取得 repository contents、packages、actions mutation 或 attestation 签发权限。workflow/environment 只向 job 提供 opaque admission reference，不注入数据库 URL、SSH 私钥、tokenization key、GitHub 管理令牌或长期 publisher credential。敏感值由本地 root-owned secret broker 在重新验证 admission 后按本次 attempt 解出，只交给固定 adapter 进程；任何需要把原始 secret 暴露给通用 job 环境或 Runner workspace 的实现都不获准。

publisher credential 必须是本 attempt、固定 subject 和固定交接 namespace 的短期 write-once 能力，禁止覆盖、列举其他 attempt 或上传未通过扫描的路径。GitHub-hosted producer custody continuation 使用独立的密文只读/attestation 身份完成 digest readback，不能复用 publisher credential，也不能取得 KMS Decrypt。

### Capability 准入与双 Environment 批准时序

引用受保护 Environment 的 job 在批准后即可开始，因此每个 exact capability 的机制专属前置资源和策略必须在批准 job 之前准备完成，不能把批准后 observation 作为创建前置输入。每个需要外部 capability 的 job 固定执行：

```text
run/job 分配并出现 pending deployment
  → mechanism-specific prerequisite 变更计划与独立批准
  → prerequisite apply/readback
  → exact-capability approval 绑定 lane + capabilityKind + 稳定 Environment identity + pending deployment + 实际 readback
  → 人工批准该 job 的 Environment deployment
  → 生成 post-approval Environment observation
  → 核对 approval/prerequisite readback/observation 后才允许取得或使用该 kind 的凭证
```

精确 capability approval 不引用尚未产生的 post-approval observation，但必须引用已完成的独立 prerequisite 变更批准、apply proof 和实际 readback digest；后续 mechanism-specific credential-use/JIT launch proof 必须同时绑定 exact capability approval digest、该 `capabilityKind` 要求的 readback digest 和最新 observation digest。固定 workflow 或 root launcher 的第一项受信动作必须完成该核对，随后才能按 kind 从 root broker 接收 STS、请求 GitHub OIDC，或申请 JIT configuration。前置资源不存在、独立批准/apply/readback 未完成、Environment 被提前批准、observation 缺失/过期或 job/deployment 身份漂移时 fail closed。

`snapshot-data` 与依赖其完成的 `snapshot-custody` 是两个顺序 job，也是两个独立 deployment：

1. 先分别完成 `snapshot-data` 所需 `publisher-sts` 与 `jit-registration` prerequisite 变更的独立批准、apply/readback，再签发绑定实际 readback 的两个 exact capability approval；之后才单独批准 data deployment 并生成 data observation；两个 kind 仍是两个批准和两份 use proof，不能合并为组合凭证；
2. data、加密对象发布和销毁 proof 入库后，才为 `snapshot-custody` 分配/核对 pending deployment，完成其 Provider/role/policy 变更的独立批准与 apply/readback，再签发绑定实际 readback 的 `oidc-cloud-role` approval；之后才进行第二次人工批准并生成 custody observation；
3. 第一次 Environment 批准和 observation 不得提前放行或复用于第二个 job；两个 job 及三个 capability kind 的 approval、readback、credential、deployment、observation 和 use-proof digest 均按实际机制分离。

Publisher STS 不能在 data job 等待 Environment、JIT Runner 尚未接单或 adapter 接收进程不存在时提前签发。只有 `snapshot-data` 已获批准、data observation 通过、JIT Runner 已分配且 root-owned adapter 子进程已创建并准备从专用 FD 接收凭证后，root broker 才即时签发短期 write-once STS 并通过该 FD 单次交付。凭证不得进入 job 环境、workspace、命令行或日志；超时或接收失败即撤销/等待失效并使用新的 operation/run 重来。

### Sanitized Snapshot 私密保管

Sanitized 不等于公开。GitHub artifact attestation 只提供来源和完整性证明，不提供内容保密性；明文 sanitized dump 不得进入 public repository 的 Actions artifact、cache、log、release asset 或任何继承 repository read 权限的存储。

方案 A 固定采用“本地逐 attempt 信封加密 + 私有 content-addressed object store”，不能在实施时降级为二选一：

1. adapter 在 WSL 加密隔离卷内完成扫描后，由独立、短生命周期的 producer crypto process 为本 attempt 生成 256-bit data-encryption key，以 AES-256-GCM 和本对象唯一的 96-bit nonce 加密 sanitized dump；authenticated data 至少绑定 repository ID、source SHA、`releaseAttemptId`、snapshot digest、sanitization contract digest 和 expiry；nonce、算法和加密信封 Schema 进入 proof，但明文 key 不进入；
2. data-encryption key 由 KMS/等价受控系统中的 key-encryption key 包装并与密文共同保存；KEK 永不离开 KMS，wrapped DEK 可以保存，明文 DEK 不得持久化。普通 envelope encryption 不得被描述为“KMS 远程完成整个 dump 解密”；KMS 只负责包装/解包 DEK；
3. 明文 DEK 只允许短暂存在于获准的 producer 加密进程和 GitHub-hosted consumer 解密进程内存。禁止写入磁盘、swap、pagefile、环境变量、命令行、stdin、日志、artifact、crash/core dump 或其他进程可读的共享区；进程禁用 core dump，并在平台支持时锁定含 key 的内存页；使用完成后立即 best-effort 覆写 key buffer、关闭进程，随后销毁本次 Runner/VM。best-effort 内存清除不得被表述为可证明的物理擦除；
4. write-only publisher 只能向本 attempt 的固定 namespace 以“若对象不存在才创建”的条件写入密文 digest 寻址的新对象和 metadata，不能读取、列举、覆盖或删除；对象存储必须 private，并启用 versioning/等价 object-lock 保留策略，repository read 权限不授予对象读取权；
5. producer custody continuation 只核对密文 digest、object version、KMS key reference、访问策略 digest、expiry、write receipt、扫描与销毁证明；它不取得 wrapped DEK 的解包权限，不生成明文，并在上述第二次独立 Environment 批准后形成 producer completion proof；
6. 只有随后 RC workflow 的 snapshot consumer 才能使用与 publisher/custody 不同的只读对象身份，并通过受保护的短期 OIDC/KMS identity 取得 admission 指定的唯一 object version/digest 与 wrapped DEK；KMS 验证该身份后将解包所得明文 DEK 仅返回给本次短生命周期 consumer crypto process。OIDC 信任策略至少绑定 immutable repository ID、固定 workflow path/ref、`refs/heads/main`、environment、actor ID、`rcWorkflowRunId` 和 run attempt；consumer 不能写、删除、列举其他 attempt 或取得 publisher/custody 权限；
7. RC snapshot consumer 在独立临时目录中核对并解密；明文 sanitized dump 只存在于本次 GitHub-hosted ephemeral VM 的受控 RC snapshot chain，禁止再次上传；
8. Actions artifact 只允许承载经过字段级审查的非敏感 proof、object reference、digest、attestation 和 custody receipt；任何可恢复明文的 key material、数据库内容或 dump 均不得进入。

上述生命周期采用标准 envelope encryption：producer 和 consumer 都会在各自进程内存中短暂持有明文 DEK，只有 KEK 保持在 KMS 内。参见 [Google Cloud KMS envelope encryption](https://docs.cloud.google.com/kms/docs/envelope-encryption) 和 [AWS KMS data keys](https://docs.aws.amazon.com/kms/latest/developerguide/data-keys.html)。若实现要求“明文 DEK 永不离开本地 broker”，则它不属于本方案，必须另行设计能远程执行完整数据解密的密码服务并重新评审。

snapshot object、wrapped key、sanitization/ownership proof 和必需 custody 记录至少保留至 snapshot 失效后 180 日。到期后只能由独立 retention identity 按批准策略执行：安全删除密文并使 wrapped key/解密授权失效，或转入批准的长期合规存储；两种路径都必须生成包含 object version/digest、策略、操作者身份、时间、key 处置和终态的删除/转存 receipt。receipt 作为执行证据继续按 S1 证据保留策略保存；legal hold 会阻止删除但必须有独立批准。publisher、consumer 均不得拥有 retention 权限。

若不能提供私有对象 ACL、逐 attempt 加密、独立 write/read/retention 身份、到期处置或 receipt readback，方案 A 停止。不得以 public Actions artifact、缩短保留期或“已经脱敏”作为豁免。

### Adapter 完整性

- `/opt/subscription-saas`、`snapshot-adapter`、`v1` 及内部文件归 root 所有；Runner 用户无写权限；
- adapter 可执行文件、依赖闭包、配置 Schema 和 root policy 分别记录 SHA-256，组合为 `snapshotAdapterDigest`；
- `snapshotAdapterDigest` 绑定 snapshot admission 和人工批准；
- adapter 启动后再次核对自身文件、父目录所有权、mode、挂载属性和 digest；
- 禁止 `node <caller-path>`、任意 Shell、交互 stdin、SQL 文件路径、脚本路径、模块路径、数据库 URL、SSH host 或输出目录由 workflow 输入指定；
- adapter 只接受不透明 admission reference，并从受信 API/本地 root policy 解出固定参数；
- Runner 用户不得使用 `sudo`、Docker socket、宿主互操作、Windows 文件挂载或 package manager；
- adapter 任何 UNKNOWN 终态都禁止直接重试数据导出；必须先销毁本次实例和加密卷，再以新 attempt、nonce、批准和 JIT Runner 重来。

## WSL 隔离与加密临时存储

### 专用环境

- 使用专用 WSL distro，不与开发 Ubuntu、Docker Desktop distro 或日常 Shell 用户共享；
- 使用专用非特权 Runner 用户，无 sudo、无 Docker group、无宿主 SSH 私钥读取权；
- 禁止 WSL Windows interop、Windows PATH 注入和自动挂载 Windows 盘；
- 只开放 GitHub Actions 必需的出站 HTTPS、受控日志端点和本地 SSH tunnel 端点；
- base distro 与 root-owned adapter 只读；每次运行使用新的可丢弃实例层；
- 不允许挂载仓库工作区、用户主目录、Docker socket、production 配置或长期凭证目录。

### 原始数据隔离

原始 dump、临时 PostgreSQL data directory、WAL、排序临时文件和转换中间值必须位于本次独立加密卷。推荐实现为每次运行新建的 LUKS2 加密卷或等价的加密块设备：

- 每次使用独立随机密钥；
- 密钥只由 root 启动器短暂持有，不写入 runner workspace、日志或 artifact；
- Runner 只获得已挂载的数据目录，不获得解锁密钥；
- raw 数据不得进入普通 WSL filesystem、Windows 盘、GitHub cache、Actions artifact 或日志；
- 明文 sanitized dump 只有在转换完成、扫描为零 findings、source fingerprint 前后一致并关闭 source snapshot 后才能进入加密步骤；上传区只接收最终密文和非敏感证明；
- 上传区禁止同时包含 raw、临时数据库文件或 tokenization key。

### 数据处置证明

普通 `rm`、workspace cleanup、distro unregister 或删除 VHDX 不能单独证明可靠数据销毁。成功、失败、取消和 UNKNOWN 都必须执行：

1. 停止临时 PostgreSQL 和所有持有卷的进程；
2. 卸载加密卷；
3. 销毁本次密钥材料并关闭映射；
4. 记录卷 identity、关闭结果、密钥销毁方法和残留挂载检查；
5. 只在日志完成外部保管后销毁 Runner 实例。

证明只声明“加密密钥已失效且卷不可解锁”；不得把普通文件删除包装成物理擦除。若宿主磁盘、pagefile、swap、休眠或 crash dump 可能保存未加密页面且没有已验证的设备加密，停止方案 A。

## SSH 与 Staging 数据库最小权限

### SSH 边界

使用 snapshot 专用密钥和服务账号，禁止复用现有 root 密钥。服务端必须通过 `authorized_keys` 选项和 sshd policy 同时限制：

- 只允许本地端口转发到唯一 Staging PostgreSQL loopback endpoint；
- 禁止交互 Shell、远程命令、PTY、agent forwarding、X11、remote/dynamic forwarding 和额外 `PermitOpen`；
- 禁止访问 production Docker network、production PostgreSQL 或宿主其他端口；
- 单次连接、固定源、连接超时和空闲超时；
- 每次记录不含秘密的 key fingerprint、目标策略 digest、开始/结束时间和字节计数。

不能使用易变容器 IP 作为长期信任目标。应由服务器 root 提供仅监听 `127.0.0.1` 的固定 Staging PostgreSQL endpoint，再将 snapshot key 的 `PermitOpen` 限定到该 endpoint；该 endpoint 不得绑定公网或 production network。

### Staging 数据库身份

snapshot source 角色必须是独立基础设施身份，不增加应用 RBAC。最低要求：

- `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`；
- `CONNECTION LIMIT 1`；
- 只授予目标 Staging database CONNECT、批准 Schema USAGE 与 snapshot 所需对象 SELECT；
- 不得是 database、Schema、table、sequence、function、type、extension 或 migration table owner；
- 不得拥有 INSERT、UPDATE、DELETE、TRUNCATE、DDL、SET ROLE、复制到服务器文件、程序执行或大对象写入能力；
- 不得成为应用角色、migration role、`pg_read_server_files`、`pg_execute_server_program` 或其他高权限角色成员；
- `default_transaction_read_only=on`，并固定 `statement_timeout`、`lock_timeout`、`idle_in_transaction_session_timeout` 和安全 `search_path`；
- 所有 source 读取发生在 `REPEATABLE READ READ ONLY` 事务；该路径只要求稳定 MVCC snapshot，不声明 serializable safe snapshot，因此不得设置或证明 `DEFERRABLE`；
- adapter SQL 由固定 statement registry 生成，不接受调用方 SQL 文本或路径；
- 连接前后分别验证角色能力、实际 database identity、TLS/SSH 路径、migration head 和 source fingerprint。

若现有 `PUBLIC` 权限、可写函数、RLS policy 或对象 owner 使角色仍具有有效写入/绕过能力，不得通过 adapter 自报空集合绕过；应停止并单独设计数据库权限收敛，或改用已验证只读副本。

PostgreSQL 17 明确规定 `DEFERRABLE` 在低于 `SERIALIZABLE` 的隔离级别没有效果，参见 [Client Connection Defaults](https://www.postgresql.org/docs/17/runtime-config-client.html)。当前 S1 实施计划 Task 13、`export-sanitized.mjs` 和对应单元测试仍把 `REPEATABLE READ + READ ONLY + DEFERRABLE` 作为通过条件；这是 Task 29R 开工前必须先修订实施计划并另行获批的 P1，不在本设计提交中修改产品或工具代码。

后续获批实现必须增加真实 PostgreSQL 17 集成测试，而不是只注入 mock 字段：实际开启 `REPEATABLE READ READ ONLY` 事务，核对 `SHOW transaction_isolation` 与 `SHOW transaction_read_only`，导出/复用同一 snapshot，并通过并发写事务证明两次 source fingerprint 读取保持同一 MVCC 视图；`READ COMMITTED`、可写事务、snapshot ID 不一致或代码继续要求 `transaction_deferrable=on` 均必须失败。

## GitHub-hosted Source/Final 门禁

source fresh、source snapshot 和 fresh/snapshot final Compose 不使用 public repository self-hosted Runner。实施时将它们收敛为 GitHub-hosted `ubuntu-24.04`，并继续满足：

- 固定 `main` SHA和 protected environment；
- build proof 中的三个 image platform digest 不可替换；
- source fresh/snapshot 使用独立 database、Manifest、operationId 和证据；
- final fresh/snapshot 在不同临时虚拟机上运行，分别生成完整证明；
- Runner 镜像仍通过固定 entrypoint 和封闭 command registry 执行 migration/verify；
- database-test 是可信启动方编排的封闭执行模式，不新增第六种 capability；
- API/Web/Playwright 结果从本次真实容器和网络请求采集，不接受外部 JSON 声称成功；
- 原始 snapshot 永不进入 GitHub-hosted Runner；这里只从私有对象存储读取已 attest、扫描通过且匹配精确 object version/digest 的加密 sanitized snapshot；
- 每条 source/final 执行证明记录 `ubuntu-24.04` label、GitHub runner image release/version、CPU 架构、`uname` kernel、Docker Engine、Buildx 和 Compose 的实际版本；label 不能替代这些执行 provenance，也不能作为不可变镜像身份。

public repository 的标准 Linux Runner 当前提供 4 CPU、16 GiB 内存和 14 GB SSD，且每个 job 使用新的 VM；容量最紧约束是 14 GB SSD，而不是内存。参见 [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。`ubuntu-24.04` 仍会接收 runner image 更新，因此容量预检和执行证明必须使用本次实际环境数据，不能把固定 label 当成资源或软件版本保证。

## 容量预检与超限回退

每条 GitHub-hosted chain 必须在 pull、restore 或启动 Compose 前生成 `capacity-plan.v1`。计划至少记录：

- 实际 `df` 可用字节和 Docker data-root 可用字节；
- API、Web、Runner、PostgreSQL、Playwright 等所有镜像的 registry digest；
- 按 digest 去重后的压缩 layer 总量；
- 受控估算或前次证明的解压 layer 上界；
- sanitized dump 字节数和恢复后 database 大小上界；
- pnpm store、checkout/build 临时量、Compose writable layer 和 evidence 上界；
- 不少于 3 GiB 且不少于总盘 20% 的剩余安全空间；
- 估算公式版本、输入 digest 和决策结果。

建议的保守门槛为：

`requiredUpperBound + max(3 GiB, totalDisk × 20%) <= availableDisk`

其中 `requiredUpperBound` 必须包含去重镜像解压上界、两份 snapshot 工作空间、恢复后数据库、依赖与证据；不得只比较压缩镜像大小。无法获得可信上界、Docker 报告与文件系统报告不一致、执行中剩余空间低于安全线时，在写数据库前失败并保管容量证据。

超限后不得在运行中删除未知 Docker 数据、缩减测试清单或跳过 snapshot chain。合法回退是使用容量充足的专用 ephemeral Linux VM，再重新生成本次 capacity plan。专用 VM 仍必须执行固定 SHA、受保护环境、JIT/ephemeral、唯一标签和单任务销毁；它只解决容量/主机隔离，不解决 public repository 路由风险。

## Execution Purpose 与无环证明时序

### 原始 v1 与 Purpose Envelope

已发布的 `source-gate-evidence.v1`、`execution-proof.v1` 和 `final-compose-evidence.v1` 保持不可变，不增加 `executionPurpose`，也不能因为缺少该字段而被 CLI、聚合器或人工默认解释为可提升证据。固定顺序为：

```text
验证并保管 raw v1 proof
  → 从固定 workflow 与已批准 dispatch 授权继承 executionPurpose
  → 冻结一对一 execution-purpose-envelope.v1 与 purpose-claim.v1
  → lineage-purpose-store：claim 条件创建确认成功后，再条件创建 envelope
  → writer session 撤销或确定失效
  → lineage-purpose-readback：独立读回并验证 claim 与 envelope
  → 成功 lineage-storage-access-receipt.v1
  → v2 custody 同时绑定 envelope 与 claim
  → v2 aggregate
  → v2 exit
  → Task 30 audit / final custody（仅 release-candidate）
```

`executionPurpose` 只有 `qualification` 和 `release-candidate` 两个值。它必须由受保护 workflow 的静态 purpose、workflow path/ref/blob digest 与 `rc-dispatch-authorization.v1` 的 purpose 三方精确一致后继承；CLI、workflow input、环境变量、文件名、artifact metadata 或调用方 JSON 均不得提供或覆盖 purpose。Qualification workflow 只能接受 `qualification` 授权；完整 RC workflow 只能接受 `release-candidate` 授权。

每个 envelope 在生成前必须先按已发布 Schema 验证原始 proof、重算规范化 digest，并完成原始 proof 的不可改写 custody readback。`execution-purpose-envelope.v1` 使用固定规范化序列化和 `additionalProperties=false`；以下公共字段全部必填：

- `schemaVersion`、原始 proof type、原始 proof digest、原始 proof custody receipt digest；
- `executionPurpose`、`releaseAttemptId`、`rcWorkflowRunId`、`rcWorkflowRunAttempt`、产生原始 proof 的 job/run identity；
- 固定 source SHA、build proof digest、repository contract digest；
- `rcDispatchAuthorizationDigest`、workflow path/ref/blob digest；
- 与原始 proof 共同决定 envelope 语义的 typed binding variant。

Typed binding 必须使用封闭的 `oneOf`/判别联合，而不是一组大量可选字段：

| 原始 proof type             | 该 variant 额外强制绑定的身份                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-gate-evidence.v1`   | `fresh\|snapshot` chain、数据库身份 digest、基线/环境 Manifest digest、数据库测试清单与报告 digest、按固定顺序列出的 command execution envelope digest，以及下述 tagged capability binding 集合                                                                                                                                                                                              |
| `execution-proof.v1`        | `operationId`、`commandId@commandVersion`、capability profile、数据库身份 digest、基线 Manifest digest、plan digest、post-state observation digest、一个 tagged capability binding，以及按原始命令 `approvalMode` 判别的 command approval binding：`none` 必须绑定 approval policy digest 并禁止 approval record；`ci-policy\|human` 必须绑定 approval policy 与 `approval-record.v1` digest |
| `final-compose-evidence.v1` | `fresh\|snapshot` chain、数据库身份 digest、环境 Manifest digest、API/Web/Runner image digest、对应 source envelope digest、按固定顺序列出的 command execution envelope digest，以及下述 tagged capability binding 集合                                                                                                                                                                      |

每个 tagged capability binding 必须且只能命中一个分支：

- `external-capability`：仅用于实际调用 publisher STS、snapshot object/KMS、OIDC 云端角色或 JIT 注册能力的步骤，强制绑定 `exact-capability-approval.v1`、`capabilityKind`、该 kind 的 prerequisite readback、post-approval observation 和 mechanism-specific credential-use/JIT launch proof digest；
- `runner-database-role`：用于只依赖最终 Runner 内数据库连接角色的 fresh migration/verify/test 等命令，强制绑定可信 launch attestation、实际数据库角色 observation、command policy digest 和对应 execution envelope；该分支禁止 `exact-capability-approval.v1`、OIDC role 或云端 policy 占位。

某一 variant 缺少其必填身份、携带另一 variant 字段、使用 `null` 占位，或 envelope 与原始 proof 内已有身份不一致时，必须 fail closed。Schema、规范化规则和所有 variant 都进入 repository contract digest；任何语义变更只能前向发布新 envelope 版本。

一对一关系由可信、create-only 的 `purpose-claim.v1` 强制执行。claim 的存储 key 由原始 proof digest 按版本化派生规则唯一确定，内容绑定原始 proof type/digest、purpose、envelope digest、`releaseAttemptId` 和 run/attempt。生成器先确定 envelope 的规范化内容和 digest，再生成并冻结指向该 envelope 的 claim；两者的 canonical bytes、digest 与 exact-key set 必须在 store approval 前固定。同一原始 proof digest 不得产生第二个 envelope，不得被重新包装为另一 purpose，也不得通过删除索引、改变对象路径或换聚合器绕过 claim。

Claim/envelope 存储固定采用两个 job，不拆分为四阶段，也不允许运行时另选协议：`lineage-purpose-store` 只持有 writer profile，先条件创建 claim，且只有获得该次创建成功的明确响应后才条件创建 envelope；禁止并发写入两者、提前写 envelope，或在 writer 中执行 Head/Get/readback。两个创建都明确成功后，先完成 writer session 撤销或确定失效，再由独立批准的 `lineage-purpose-readback` 持 reader profile，按冻结的 exact-key set 与预期 digest 读回两者，核对 canonical bytes、对象版本和 claim→envelope/purpose/attempt/run 全部绑定。强制 readback 门槛位于成功 `lineage-storage-access-receipt.v1` 与 `custody-receipt.v2` 生成之前，不位于两次写入之间；写入响应本身不得替代 readback 证明。

两次写入不是跨对象原子事务。Claim 写入失败、已存在冲突或结果 UNKNOWN 时，writer 必须停止，不能继续写 envelope；claim 已创建但 envelope 失败或冲突属于部分成功，两个对象写入/读回任一结果不明则按 `INTERRUPTED_UNKNOWN` 处理。上述状态及任一读回缺失、不匹配都不得生成成功 access receipt、custody 或进入 aggregate/exit；保留已写对象、原始 proof、批准链与失败记录，禁止补写、覆盖、删除 claim 或重新包装。冲突和 UNKNOWN 只允许 reader 在独立只读身份下按冻结目标诊断/reconcile：已存在的完全相同 claim 也只作只读记录，任何字段不同均以 `RAW_PROOF_PURPOSE_ALREADY_CLAIMED` 拒绝；reconcile 不得恢复本次失败尝试的写入或下游准入。后续执行按“失败、取消与 UNKNOWN”中的新 operation/run 与完整 proof lineage 规则处理。

为保持无环，envelope 不反向引用尚未创建的 claim；claim 单向引用 envelope，随后 `custody-receipt.v2` 把两者纳入同一个可审计 subject。每份 v2 custody 必须同时绑定 envelope digest、`purposeClaimDigest`、按原始 proof digest 派生的 claim/envelope storage key/object version、条件创建证明 digest、claim/envelope readback digest 及其 `lineage-storage-access-receipt.v1` digest，并重新验证 claim 中的 envelope/purpose/run 身份与被保管 envelope 完全一致。缺少任一字段、派生 key 不一致、object version 被覆盖、v2 writer/reader capability lineage 不完整或 readback 不匹配时，aggregate 不得选择该证据。

`purpose-claim.v1`、`execution-purpose-envelope.v1`、`exact-capability-approval.v2`、`lineage-oss-role-use-proof.v1`、`lineage-storage-access-receipt.v1`、`custody-receipt.v2`、`release-aggregate-proof.v2` 和 `s1-exit-evidence.v2` 都是前向新增契约并进入 repository contract digest。`release-aggregate-proof.v2` 只从已 readback、claim 链和 lineage storage access receipt 均完整的 v2 custody 选择 purpose-bearing 执行输入；`s1-exit-evidence.v2` 只引用同 purpose 的 aggregate digest、aggregate access receipt 和其窄输入。Build proof、snapshot producer completion 和 owner/manual attestation 仍是经 dispatch 授权绑定的前置事实，不得绕过 envelope 把原始 source/execution/final proof 直接送入 aggregate。

Purpose claim、条件创建/readback 证明和 storage version 的保留期不得短于其 envelope、custody、aggregate、exit、Task 30 audit、final custody 及适用 legal hold 中最晚到期的对象。任一仍被 lineage 引用时不得先行删除、覆盖、缩短保留期或释放 storage key；到期处置必须与整条 evidence lineage 一起生成删除/转存 receipt。

### 三类独立运行批准与前置变更批准

三种运行批准拥有不同的生成时点、subject 和权限语义，禁止复用一个含糊的 `approval-record.v2`。Role/policy 等 prerequisite 的 `external-change-approval.v1` 是独立的外部资源变更批准，只能先行授权其确定性变更计划，不属于下列运行批准，也不能替代其中任一项：

1. **RC dispatch 授权：`rc-dispatch-authorization.v1`**。在本 purpose 的 snapshot producer 与 RC run 创建前签发，绑定 `executionPurpose`、`releaseAttemptId`、固定 producer/RC workflow path/ref/blob digest、source SHA、build proof、三镜像 bundle、repository contract、预期 snapshot/sanitization/adapter 身份、有效期、签发者和撤销策略；它不预先虚构 producer/RC run ID、实际 producer completion digest、数据库、Manifest、命令或 plan。Producer 完成后，RC 启动门禁再验证实际完成证明与该授权的预期 subject、attempt 和 digest 身份一致。
2. **精确 capability 身份批准：v1 冻结合同与 v2 lineage 前向合同**。`exact-capability-approval.v1` 只适用于实际需要既有 snapshot/cloud/JIT 能力的 job。目标 run/job 已分配并出现 pending deployment 后，先对该机制的 prerequisite 变更完成独立批准、apply 和 readback，再在 Environment 人工批准前签发 v1 approval；公共必填字段绑定 purpose、dispatch 授权、`producer|rc` lane、对应 `snapshotRunId|rcWorkflowRunId`/attempt、精确 job、稳定 `environmentPolicyIdentityDigest`、pending deployment identity、唯一 `capabilityKind`、实际 prerequisite readback、有效期、签发者、撤销与 custody。它不绑定尚未产生的 post-approval observation，也不含通用 OIDC/role 字段。Lane 下再使用 `additionalProperties=false` 的封闭 `capabilityKind` 判别联合：

   | `capabilityKind`   | 允许 lane/job                                    | 批准前必填身份与 prerequisite readback                                                                                                                                                         | 批准后的唯一 credential-use proof                                                                                                                                                        | 明确禁止                                                                         |
   | ------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
   | `publisher-sts`    | `producer/snapshot-data`                         | root broker identity/policy digest、STS issuer、broker 可假设的精确 publisher role/policy readback、attempt object namespace/KMS context、`maxSessionSeconds=900`、FD delivery contract digest | data observation、broker/session subject fingerprint、role/policy readback、issued/expires time、精确 namespace、adapter process identity 和 sealed FD delivery receipt；不得包含 secret | GitHub OIDC subject/provider、GitHub App/JIT 字段、Get/List/Delete/KMS data 权限 |
   | `oidc-cloud-role`  | `producer/snapshot-custody` 或 `rc` consumer job | OIDC Provider issuer/audience/fingerprint/ARN readback、精确 GitHub subject、云端 role/trust/permission policy readback、唯一对象/KMS action scope                                             | post-approval token claims digest、Provider/role readback、STS session fingerprint、issued/expires time、精确 object/KMS action 与终态 revoke/expiry receipt                             | root broker/FD、GitHub App/JIT 字段、publisher 写权限或通配 subject              |
   | `jit-registration` | `producer/snapshot-data`                         | GitHub App/installation immutable ID、key public fingerprint、最小 permission/readback、root launcher policy/digest、repository ID、route nonce、精确五标签和 JIT request policy               | data observation、GitHub App installation token request fingerprint、JIT configuration digest、ephemeral runner ID/labels、实际 job assignment，以及注销/销毁 readback；不得包含 token   | OIDC Provider/subject、云端 role/STS 数据权限、publisher/custody/consumer 权限   |

   `producer` lane 可使用上述三个 kind 中与精确 job 匹配的项；`rc` lane 只允许需要对象读取/KMS 解密的 `oidc-cloud-role` consumer。一个 job 同时需要 `publisher-sts` 与 `jit-registration` 时必须使用两个 approval、两个 prerequisite readback 和两个 use proof；禁止一个 approval 声明多个 kind、跨 variant 字段、组合凭证或把某 kind 的 proof 当作另一 kind。每种机制完成 prerequisite apply/readback 后才允许人工批准对应 job；实际凭证或 JIT configuration 只能在批准后 observation 通过时按本 kind 的时序签发。

   `exact-capability-approval.v1` Schema、lane/kind 允许矩阵、三个 variant 的必填/禁止字段、规范化规则及各自 credential-use proof Schema 全部进入 repository contract digest。已发布的 kind 不得原地增加另一种身份机制、允许 job、permission profile 或写权限；任何此类变化只能前向发布新版本并重新批准。特别是，v1 `oidc-cloud-role` 不得用于写入 purpose claim、envelope、v2 custody、aggregate 或 exit。

   **Lineage 前向能力：`exact-capability-approval.v2`。** 该版本只为 RC 内的私有 lineage 对象提供封闭能力，不替代、不继承也不重新解释 v1。它的 `lane` 必须为 `rc`，`capabilityKind` 必须为新 kind `lineage-oss-role`；底层可以使用 GitHub OIDC 获取短期 RAM 凭证，但这不使它成为 v1 `oidc-cloud-role`。任何 v1 approval、role、session、use proof 或 snapshot object/KMS 权限都不得作为 v2 lineage 写入或读取凭证。

   每份 v2 approval 使用 `additionalProperties=false`，除签发、有效期、撤销和 custody 公共字段外，必须绑定：
   - 从固定 workflow 和 `rc-dispatch-authorization.v1` 继承的 `executionPurpose`，以及 dispatch authorization digest；
   - `releaseAttemptId`、唯一 `rcWorkflowRunId`、run attempt、固定 workflow path/ref/blob digest、source SHA、build proof 和 repository contract digest；
   - 精确 job ID、pending deployment identity、稳定 `environmentPolicyIdentityDigest`；
   - `capabilityKind=lineage-oss-role`、唯一 `permissionProfile`、唯一 `lineageNodeKind`、预期对象 digest 与确定性 exact-key set；
   - 私有 namespace、Bucket/region/WORM policy identity、Aliyun OIDC Provider readback、精确 GitHub subject、RAM role/trust/permission policy identity；
   - 该 job 的独立 prerequisite 变更计划 digest、`external-change-approval.v1` digest、apply proof digest 与实际 role/policy readback digest。

   `external-change-approval.v1` 只批准该 prerequisite 计划所描述的外部资源变更，不能授予凭证、批准 Environment deployment，也不能代替 dispatch、exact capability 或数据库命令批准；实际 capability 使用仍必须取得后续 v2 approval。

   v2 approval 不得引用尚未产生的 Environment observation 或 credential-use proof。其固定时序为：

   ```text
   RC job 分配并出现 pending deployment
     → 独立 prerequisite 变更计划与 human approval
     → apply/readback 精确 OIDC subject、role、policy 与对象范围
     → exact-capability-approval.v2 绑定实际 readback
     → 人工批准该 job 的 Environment deployment
     → post-approval Environment observation
     → 请求并使用唯一 lineage profile 的短期 OIDC/RAM credential
     → revoke/expiry readback
   ```

   v2 lane/job/profile/Environment 矩阵是封闭集合：

   | `permissionProfile`          | 允许的精确 RC job ID                                   | 固定 Environment            | 允许动作                                                                                                                                        | 明确禁止                                                                                         |
   | ---------------------------- | ------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
   | `lineage-create-only-writer` | `lineage-purpose-store`、`lineage-custody-store`       | `trusted-release-execution` | 仅对 exact-key set 条件创建（`x-oss-forbid-overwrite=true`）；purpose store 先 claim 确认成功再写 envelope，不读回；custody store 只写对应 node | Head/Get/List、覆盖、Delete、KMS、snapshot namespace、其他 node/job、跨 attempt/run、通配 prefix |
   | `lineage-readback-reader`    | `lineage-purpose-readback`、`lineage-custody-readback` | `trusted-release-execution` | 仅对前序固定 store job 的 exact-key set 执行 Head/Get 并核对版本/digest；purpose readback 独立验证两者后才准入 custody；禁止追加 key            | Put/覆盖/List/Delete、KMS、snapshot namespace、其他 node/job、跨 attempt/run、通配 prefix        |
   | `lineage-create-only-writer` | `lineage-aggregate-store`、`lineage-exit-store`        | `trusted-release-candidate` | 仅对本 job 的单一 aggregate 或 exit exact key 执行带 `x-oss-forbid-overwrite=true` 的条件创建                                                   | Head/Get/List、覆盖、Delete、KMS、snapshot namespace、其他 node/job、跨 attempt/run、通配 prefix |
   | `lineage-readback-reader`    | `lineage-aggregate-readback`、`lineage-exit-readback`  | `trusted-release-candidate` | 仅对前序固定 store job 的单一 exact key/version/digest 执行 Head/Get 和字节/digest readback                                                     | Put/覆盖/List/Delete、KMS、snapshot namespace、其他 node/job、跨 attempt/run、通配 prefix        |

   `lineageNodeKind` 与 job ID 必须一一对应：`purpose` 只能命中 purpose store/readback，`custody`、`aggregate`、`exit` 同理。每个 store 和 readback job 都使用独立 v2 approval、独立 role/readback、独立 Environment deployment/observation 和独立 credential；前一 session 撤销或确定失效后，下一 job 才能取得凭证。一个 approval、job、进程或 credential 不得同时包含两个 profile、两个 node kind、多个 action 族或 v1/v2 capability。

   v2 的唯一使用证明为 `lineage-oss-role-use-proof.v1`。它必须绑定 v2 approval digest、prerequisite apply/readback、post-approval Environment observation、实际 OIDC token claims digest、Provider/role/policy readback、STS session fingerprint、issued/expires time、精确 key/version/digest、实际 action/result，以及 terminal revoke/expiry receipt；不得记录 token 或 secret。Writer proof 必须记录条件创建结果且不包含读取动作；reader proof 必须记录 exact readback 结果且不包含写入动作。

   每个 lineage node 的 canonical bytes 和 digest 必须先于 store approval 冻结；store/readback 完成后再生成非敏感、内容寻址的 `lineage-storage-access-receipt.v1`，绑定 writer/reader v2 approval digest、两份 use proof digest、对象 key/version/digest 与条件创建/readback 结果。v2 approval、use proof 和 access receipt 不得反向嵌入本次被写入 node 的 canonical bytes；该 receipt 只由下一层 proof 或 Task 30 audit 单向引用，从而避免循环：purpose access receipt 进入 `custody-receipt.v2`，custody access receipt 进入 aggregate，aggregate access receipt 进入 exit，exit access receipt 进入 Task 30 audit 或 qualification 停止证明。Receipt 本身可作为经字段审查的非敏感 Actions evidence 以 digest/reference 保管，不递归要求另一个 lineage writer。

   `external-change-approval.v1`、`exact-capability-approval.v2`、`lineage-oss-role-use-proof.v1`、`lineage-storage-access-receipt.v1`、lane/job/profile 矩阵、规范化规则和负向策略全部进入 repository contract digest。以下情况必须在凭证请求前失败：v1 approval 申请 lineage 写/读、v2 访问 snapshot/KMS、profile/job/node 不匹配、writer 读取、reader 写入、List/Delete/通配范围、覆盖、跨 run/attempt、组合凭证、缺失或不匹配的 prerequisite readback，以及 approval 早于 prerequisite apply/readback。

   `lineage-retention-operator` 不属于 v2 的日常 RC 能力，RC 期间不得创建其 role 或 session。保留期或 legal hold 结束后的处置必须使用独立、逐 exact-key 的 disposition 计划、human approval、apply/readback 和终态 receipt；若未来需要把 retention 纳入 exact-capability 契约，必须另行发布前向版本并重新批准。

3. **命令执行批准：既有 `approval-record.v1`**。只在数据库身份、基线 Manifest、`commandId@commandVersion`、capability 和确定性 plan digest 产生后签发，并沿用已批准的撤销、时效和 apply 重算规则。它只能批准该命令执行，不能代替 dispatch 或 capability 身份批准，也不修改既有 v1 Schema 的语义。

数据库 execution envelope 必须先通过 dispatch 授权和适用的 command approval binding，再按实际能力来源二选一：使用外部 snapshot/cloud/JIT 能力时，必须绑定 v1 exact-capability approval、唯一 v1 `capabilityKind`、该机制的 prerequisite readback、post-approval observation 和 mechanism-specific credential-use/JIT launch proof；只使用最终 Runner 数据库角色时，必须绑定 launch attestation、数据库角色 observation 和 command policy，并明确禁止伪造 exact-capability approval。v2 `lineage-oss-role` 不能授权数据库连接或命令。`approvalMode=ci-policy\|human` 时还必须绑定 `approval-record.v1`；`approvalMode=none` 时禁止伪造批准记录。

不直接执行数据库命令的 source/final envelope 不得伪造 command approval；它们通过按顺序引用的 execution envelopes 继承每条命令的数据库角色/外部能力事实，若自身另行调用 snapshot/cloud/JIT 能力才增加对应 v1 exact-capability binding。Lineage 存储使用的 v2 approval 和 use proof 只进入后置 `lineage-storage-access-receipt.v1`，不得反向改变 raw proof 或 envelope。三类批准各自进入可信保管并以 digest 单向引用，不得相互循环或由 Runner 自签发。

### Qualification 与可提升 RC

`releaseAttemptId` 只用于跨受保护 producer 的关联和防重放，不能代替 GitHub workflow run 身份。每个 chain、database、Manifest 和 `operationId` 保持独立。固定执行分为两次，不能运行时选择、续接或复用。

第一次只做 Task 29R 基础设施 qualification：

```text
qualification dispatch authorization
  → 独立 qualification snapshot producer（snapshotRunId success）
  → 唯一 qualification rcWorkflowRunId（attempt=1）
  → Task 29R source/final raw v1 proofs
  → qualification purpose envelopes
  → qualification v2 custody / aggregate / exit
  → TASK_30_AUTHORIZATION_REQUIRED
  → 停止；作为不可提升的历史基础设施验证记录保管
```

Task 30 另行批准、实现并合并到 `main` 后，必须从新状态完整重跑：

```text
新的 main/source SHA、build proof、API/Web/Runner bundle
  → 新 release-candidate dispatch authorization / releaseAttemptId
  → 新 snapshot producer / snapshotRunId
  → 新且唯一的 release-candidate rcWorkflowRunId（attempt=1）
  → 同 run 的 Task 29R source/final raw v1 proofs
  → release-candidate purpose envelopes
  → 同 run 的 v2 custody / aggregate / exit
  → 同 run 的 Task 30 audit / final custody
```

Qualification 的 envelope、custody、aggregate 和 exit 必须永久标记为 `qualification`。提升门禁在选择任何证据前就必须拒绝 `qualification`、缺失 purpose、混合 purpose、v1 原始 proof 直投、不同 dispatch 授权或不同 attempt 的 lineage。Qualification 证据不能成为新 producer、新 RC 或 Task 30 的输入，也不能通过重新包装转为 `release-candidate`。

可提升 run 中，Task 29R 前缀、所有原始 proof 对应的 envelope、v2 custody/aggregate/exit、Task 30 audit 和 final custody 必须全部由同一个 `rcWorkflowRunId` 的实际 job 产生或聚合。允许来自独立受保护 producer run 的外部输入只有：该新 attempt 的加密 sanitized snapshot 及其窄 proof/custody、同一新 source SHA 的可信 build proof、窄 owner/manual attestation。source-gate、execution、final-compose、envelope、aggregate 和 exit 均不属于外部豁免。

RC workflow 不得声明或接受 `finalExecutionRunId`、`finalExecutionArtifactName`、`exitEvidenceRunId`、`exitEvidenceArtifactName` 或等价的外部最终证明定位输入；也不得接受调用方直接提供完整 raw final proof、purpose envelope、aggregate 或 exit。相同 `releaseAttemptId`、文件名、自报 digest 或 qualification 成功记录均不能放宽 same-run 约束。

## 失败、取消与 UNKNOWN

- 人工批准前失败：不注册 Runner，只记录 admission rejection；
- JIT 注册后、接单前失败：撤销或等待凭证失效，确认 Runner 不可路由并销毁实例；
- source snapshot 尚未打开时失败：记录 `FAILED`，执行实例/加密卷处置；
- source snapshot 已打开但结果确定未发布：关闭事务并记录 `FAILED`；
- 加密 sanitized snapshot 是否发布不明：记录 `INTERRUPTED_UNKNOWN`，禁止用同一 Runner 或相同 operation 直接重传；
- runner job 与 GitHub API 终态不一致：以 `UNKNOWN` 处理；
- 销毁证明、日志保管或 runner 注销任一缺失：即使加密 sanitized snapshot 已生成，也不得进入 source snapshot/final chain；
- GitHub-hosted 容量、镜像、数据库、API/Web 或 Playwright 失败：保留本次失败证明，不得转为外部 JSON 或人工“通过”。
- Claim/envelope 成对写入部分成功或发生已存在冲突：记录 `FAILED`，保留已写对象且禁止补写、回滚删除或下游准入；reader 只读诊断/reconcile 不得把该失败尝试改作成功；
- 原始 v1 proof 已完成但 envelope 生成、claim/envelope 任一次条件创建或成对 readback 结果不明：记录 `INTERRUPTED_UNKNOWN`，保留原始 proof、批准链和失败记录；只能以相同 operation 做只读 reconcile，禁止再次创建、覆盖、改 purpose 或下游准入；
- envelope 已生成但 v2 custody 写入/readback 结果不明：同样记录 `INTERRUPTED_UNKNOWN`，禁止重新包装原始 proof 或覆盖 custody。若只读 reconcile 仍不能确定终态，本 attempt 永久不可提升；
- 上述成对写入失败、冲突和 UNKNOWN 不能通过同一 run 的新 operation“补成功”。合法恢复必须使用新的 operation/run，重新生成对应原始 proof 和完整 purpose lineage；旧对象继续按失败/UNKNOWN 保留策略保存，不得删除或覆盖。

## 当前实现到目标的偏差

| 原子事项                | 当前实现                                                                                                    | 目标                                                                                                                   | 阻断路由                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| bootstrap canary 授权   | 基础设施计划 `4786e21e` 已登记 P1，Task 13/I7/I8 停止；既有 v1/v2 均不适用，整份计划复审未完成              | 本节独立 canary 授权先经设计批准，再独立修订/复审受影响计划；不虚构 Release Attempt                                    | 本次补充待复审 P1；全部施工仍阻断 |
| 仓库可见性              | public                                                                                                      | public 下必须证明 JIT 排他路由；不能则转 private/非 Actions                                                            | 本附录实施前 P1                   |
| snapshot environment    | `stage1-snapshot-export` API 404、未创建                                                                    | 稳定 identity digest 与批准后 observation digest 分层；固定 ID/reviewer/main policy/禁 bypass/单操作员风险             | 环境 bootstrap 后再次批准 P1      |
| snapshot Runner         | 固定 self-hosted 能力标签，无实例                                                                           | 每次唯一标签、人工批准后 JIT/ephemeral、单 job 后注销销毁                                                              | 本附录实施前 P1                   |
| snapshot job 代码       | checkout、pnpm、仓库脚本                                                                                    | self-hosted 数据面不 checkout、不装依赖，只调用 root-owned adapter                                                     | 工作流修订 P1                     |
| snapshot adapter        | 固定路径缺失                                                                                                | root-owned、不可修改、依赖闭包与 digest 固定                                                                           | adapter 独立设计/实现 P1          |
| sanitized snapshot 保管 | public Actions artifact、明文 dump、30 日                                                                   | 逐 attempt 加密、私有 content-addressed store、分离 publisher/consumer/retention、失效后 180 日                        | custody 实施前 P1                 |
| Producer custody/解密   | 现有计划与前版附录曾混淆 producer custody 和 RC consumer                                                    | producer custody 只读密文/证明且不解密；只有后续 RC snapshot consumer 可取得 KMS Decrypt                               | 本附录复审后修订计划 P1           |
| Environment job 批准    | data/custody 顺序 job 的 capability 与批准时序尚未落地                                                      | 机制专属 prerequisite 先 apply/readback；data 与 custody 各自批准/observation；publisher STS 在 adapter 就绪后即时签发 | 本附录复审后修订计划 P1           |
| WSL 隔离                | 未建立                                                                                                      | 专用 distro、非特权身份、无 Docker/interop/Windows mount                                                               | 基础设施实施 P1                   |
| raw 存储                | 未建立                                                                                                      | 每 attempt 独立加密卷与密钥失效证明                                                                                    | 基础设施实施 P1                   |
| SSH                     | 现有 root key 可取得 Shell                                                                                  | snapshot 专用 key，仅固定 Staging DB 本地转发                                                                          | 服务器配置 P1                     |
| Staging 数据库身份      | 只有应用超管身份                                                                                            | snapshot 专用严格只读角色及有效能力证明                                                                                | 数据库配置 P1                     |
| snapshot 事务语义       | 计划、实现和测试要求无效的 `REPEATABLE READ + DEFERRABLE`                                                   | `REPEATABLE READ READ ONLY` 稳定 MVCC snapshot，并以真实 PostgreSQL 17 集成测试证明                                    | Task 29R 前置计划修订 P1          |
| source/final 主机       | 工作流要求 self-hosted                                                                                      | GitHub-hosted `ubuntu-24.04` ephemeral VM + 实际版本证明 + 容量预检                                                    | 工作流修订 P1                     |
| 容量                    | 未生成 capacity plan                                                                                        | 每 chain 写前预检，超限切专用 ephemeral VM                                                                             | final gate P1                     |
| Purpose 权威            | v1 原始证明没有 purpose；基础设施计划曾拟以混合 v2 proof 字段解释 purpose                                   | v1 原始证明先验证；由固定 workflow + dispatch 授权继承 purpose；claim/envelope 及其 v2 custody 后才可聚合              | 本附录复审后修订两份计划 P1       |
| 批准分层                | 基础设施计划曾拟复用含糊 `approval-record.v2`，附录曾把外部机制统一为 OIDC/role                             | dispatch、exact capability、命令执行分别独立；exact capability 再按三个互斥 kind 分流；Runner 数据库身份使用非云端分支 | 本附录复审后修订计划 P1           |
| Lineage 存储身份        | 基础设施计划把 create-only writer/readback reader 作为 v1 `oidc-cloud-role` 新 profile，原地扩大已批准 kind | v1 保持不可变；使用 v2 `lineage-oss-role` 的封闭 RC job/profile 矩阵、独立 readback/use proof、无环 storage receipt    | 本附录复审后修订基础设施计划 P1   |
| Qualification/RC 边界   | Task 29R 尚未真实执行，上游计划仍保留与 Task 30 续接的旧语义                                                | qualification 永久不可提升；Task 30 合并后以新 main/build/bundle/producer/attempt/run 完整重跑                         | 本附录复审后修订两份计划 P1       |
| Snapshot/RC 运行边界    | Task 29R 尚未真实执行                                                                                       | 每个 purpose 都由独立 `snapshotRunId` 先完成；对应 RC 内部 source/final/envelope/v2 tail 保持 same-run                 | Task 29R-D P1                     |
| Task 30                 | stash 冻结                                                                                                  | qualification 后另行批准、实现并合并；新 RC 的 Task 29R 前缀与 Task 30 tail 全部同一 `rcWorkflowRunId`                 | 持续阻断                          |

## 方案 A 退出条件

出现以下任一情况，立即停止方案 A；不得以运维豁免、模拟 JSON、持久 Runner 或当前 production/staging 服务器代替：

- bootstrap canary 借用 RC/v1/v2 授权、签发根依赖被测 OIDC、批准引用未来事实、取得两项探测 API 之外的能力，或消费者保护/凭证失效/独立保管未闭环；
- 不能证明唯一 queued snapshot job 与 JIT Runner 实际接收 job 完全一致；
- `stage1-snapshot-export` environment 缺失、ID/策略漂移、reviewer 不匹配、允许错误分支或管理员 bypass；
- environment 稳定身份与运行观察仍使用一个 digest，或 admission 依赖批准后才能生成的 observation；
- public repository 允许 PR、fork、评论事件、任意 ref 或旧 run 获得相同路由；
- snapshot workflow 的实际 blob/content digest、action commit 清单或 admission Schema 与本地 root policy 不一致；
- self-hosted job 必须 checkout/执行仓库任意代码或 package lifecycle script；
- Runner 用户可修改 adapter、取得 Shell/SQL 路径、sudo、Docker socket 或 Windows/宿主数据；
- 原始数据可能落入未加密磁盘、swap/pagefile、cache、artifact 或日志；
- 明文 sanitized dump 进入 public Actions artifact，或私有存储、逐 attempt 加密、读写/retention 身份分离及失效后 180 日处置无法证明；
- producer custody continuation 取得 KMS Decrypt、解包 DEK、下载/产生明文，或 RC snapshot consumer 与 publisher/custody 共用身份；
- `snapshot-data` 与 `snapshot-custody` 共用一次 Environment 批准/observation，或 mechanism-specific prerequisite 在 job 获批后才 apply/readback；
- publisher STS 在 data job approval、post-approval observation、JIT 分配和 adapter 接收进程就绪前签发，或通过 FD 以外的 job 环境/workspace 交付；
- 只能证明普通文件删除，不能证明加密密钥失效；
- SSH 能取得交互 Shell、任意端口转发或 production 网络路径；
- Staging source 角色存在 owner、DDL、写入、SET ROLE 或 RLS 绕过能力；
- snapshot 实现继续把 `DEFERRABLE` 与低于 `SERIALIZABLE` 的事务组合并宣称获得安全延迟保证，或缺少真实 PostgreSQL 17 MVCC 集成证据；
- GitHub-hosted capacity plan 不通过或无法获取可信上界；
- 同一 purpose attempt 内的 snapshot、source、build、final 或 Task 30 证据不能绑定同一 `releaseAttemptId` 和固定 source SHA；
- 原始 v1 proof 未先验证/保管就生成 envelope，envelope 允许 CLI 传入 purpose，或 typed variant 缺少该 proof 类型必需的 Manifest、数据库、命令/能力身份；
- 同一原始 proof digest 能生成多个 envelope、改变 purpose，或 purpose claim/custody 不具备 create-only、派生 key/version、条件创建/readback 证明与不短于 lineage 的保留期；
- claim/envelope 未按两个 job 的固定协议依次条件创建并独立读回，writer 为完成顺序而取得读取权限，或部分成功、冲突、UNKNOWN、读回不匹配仍能生成成功 custody/下游证明；
- dispatch、exact capability 和命令执行批准使用同一个含糊对象，或批准生成时点早于其必须绑定的身份；
- exact capability 缺少唯一 `capabilityKind`、接受跨 variant 字段/组合凭证，或把 Publisher/JIT 强制包装成 OIDC cloud role；
- v1 `oidc-cloud-role` 被用于 lineage Put/readback、增加 lineage permission profile 或允许新的 RC lineage job；v2 `lineage-oss-role` 缺少封闭 job/profile/node 矩阵，writer/reader 凭证共存，或 storage access receipt 与其所证明的 node 形成循环；
- 仅使用 Runner 数据库角色的 fresh migration/verify/test 被强制要求或允许伪造云端 exact-capability approval，或缺少 launch attestation、数据库角色 observation 与 command policy；
- qualification producer、proof、envelope、custody、aggregate 或 exit 被可提升 RC 复用、重新包装或作为输入；
- 可提升 RC 的 Task 29R 前缀、envelope、v2 custody/aggregate/exit、Task 30 audit 或 final custody 不是来自同一 `rcWorkflowRunId`，或 workflow 重新接受外部完整最终证明输入；
- RC run 在独立 snapshot producer 完成前启动，或实现保留外部 `snapshotRunId` 与 same-run reusable snapshot 的运行时选择；
- Task 30 合并后未使用新的 main/source SHA、build proof、bundle、producer、`releaseAttemptId` 和 RC run 完整重跑；
- 需要修改业务代码、业务迁移、模型、枚举或应用 RBAC 才能完成基础设施门禁。

退出后的合法选择只有：

1. 将仓库转为 private，并重新评审 Runner 路由、成本和访问控制；或
2. 使用不受 GitHub Actions public job 路由影响的受控非 Actions snapshot 操作，输出独立 attestation 后再由 GitHub-hosted 门禁消费；或
3. 为容量/主机隔离使用专用 ephemeral Linux VM，同时仍满足 public repository 的全部排他路由规则。

专用 VM 本身不是 public repository 路由风险的修复。

## 本次修订的批准与后续文档顺序

1. 先独立复审本次 bootstrap canary 补充；保留 `380c0edb` 既有批准内容与 v1/v2 权限矩阵，不把本次提交记为新增内容已经获批；
2. 本次补充获批后，再修订并分别复审受影响的上游 S1 实施计划和基础设施实施计划，落实 Task 13/I7/I8 的独立授权、提前就绪的非 OIDC 签发/保管、subject 切换和停止点；本轮不改计划。基础设施计划 `4786e21e` 整份复审未完成，不得因一个设计 P1 闭环宣称该计划整体获批；
3. 两份计划另行批准及对应外部变更批准前，不得 dispatch canary、创建 Environment/云端身份、切换 subject、安装 adapter、注册 Runner 或修改工作流；Task 29R、Task 30继续阻断；
4. Task 29R 只运行真实 protected infrastructure qualification，生成永久不可提升的 qualification envelope/v2 tail，然后以 `TASK_30_AUTHORIZATION_REQUIRED` 停止；
5. Task 30 仍需另行批准、实现、审查并合并到 `main`；不得把 qualification lineage 续接到 Task 30；
6. Task 30 合并后，从新的 main/source SHA、可信 build proof、三镜像 bundle、producer、`releaseAttemptId` 和 RC run 完整执行 Task 29R 前缀与 Task 30 tail；
7. 新 RC 成功仍只证明 S1 退出门槛，不代表 S2/S3 获准。

## 文档阶段验收标准

本附录只有在以下问题都得到明确批准后才能关闭：

- 本次 canary 是否使用 `infrastructureChangeId` 与真实 `canaryRunId`，且 dispatch、资源变更、精确运行授权和 Environment 批准互不替代、不引用未来事实；
- canary 的签发/撤销/保管是否在被测 OIDC 之外先就绪；是否避免修改 v1/v2 或依赖较晚的 WSL/I13、Adapter、Release Attempt；
- 预批准 capsule 是否保持不变，批准后 observation 和撤销 checkpoint 是否通过独立只读通道按精确 run/job 取得；是否明确在线读取的时间边界，且无云凭证测试覆盖 capsule 写入后撤销、缺失及超时并证明 OIDC 请求数为 0；
- cloud 条件先行、既有 consumer 保护、固定两 API、短期凭证失效、UNKNOWN 不重跑及独立只读 readback/180 日保管是否闭环；
- public repository 下的 JIT 排他路由是否足以实施；
- environment 当前缺失状态、目标 ID 冻结流程、策略字段和单操作员风险是否被明确接受；
- environment policy 的稳定 identity、批准后 observation、admission 和 JIT launch proof 是否形成无循环且可判定时效的证明链；
- self-hosted snapshot job 是否完全退出仓库代码执行面；
- workflow digest、允许 action 清单、route nonce 生成和本地 root policy 是否形成不可自签发的路由信任链；
- adapter 信任根、参数面、digest 和安装所有权是否唯一；
- WSL 原始数据加密、密钥失效、swap/pagefile 和日志保管是否可证明；
- sanitized snapshot 的逐 attempt 加密、私有对象 ACL、读写/retention 身份分离及失效后 180 日处置是否可证明；
- producer custody 是否保持密文只读且无 KMS Decrypt，RC snapshot consumer 是否是唯一解密方；
- data/custody 两个 job 是否分别执行“机制专属 prerequisite 变更独立批准 → apply/readback → exact approval → Environment 批准 → post-approval observation → 凭证使用”，publisher STS 是否只在 adapter 子进程就绪后即时签发；
- KEK/DEK 角色、producer/consumer 明文 DEK 内存边界及进程/VM 销毁语义是否准确；
- SSH endpoint 与 Staging 角色是否满足有效只读而非自报只读；
- `REPEATABLE READ READ ONLY` 的真实 PostgreSQL 17 MVCC 测试是否作为 Task 29R 前置门槛；
- GitHub-hosted 容量公式、停止阈值和专用 VM 回退是否可执行；
- 三类运行批准是否具有独立契约、正确生成时点和不可互相替代的权限语义，前置外部变更批准是否只能授权确定性 prerequisite 计划；
- v1 exact-capability approval 是否在 lane 下使用 `publisher-sts`、`oidc-cloud-role`、`jit-registration` 三个互斥 kind，并分别验证专属 readback/use proof 与禁止字段；
- v1 三个 kind 是否保持不可变，v2 `lineage-oss-role` 是否仅允许封闭的 RC store/readback job、互斥 writer/reader profile、实际 prerequisite readback 和专属 use proof；
- lineage node 是否先冻结再写入，`lineage-storage-access-receipt.v1` 是否由下一层单向引用且不递归写入自身；
- 原始 v1 → 一对一 purpose envelope → v2 custody/aggregate/exit 是否无环、内容寻址且可机器验证；
- v2 custody 是否同时绑定 envelope、purpose claim、派生 key/version、条件创建/readback 证明，且 claim 保留期覆盖完整 lineage；
- 两个 purpose job 是否严格实现“claim 创建确认 → envelope 创建确认 → writer session 退出 → 独立读回两者 → 成功 access receipt/custody”，并拒绝部分成功、冲突、UNKNOWN 或读回失败进入下游；
- typed envelope 是否按原始 proof 类型强制绑定 Manifest、数据库、命令/能力身份，而非依赖可选字段；
- 外部 capability 与 Runner 数据库角色是否采用封闭分支，禁止 fresh 数据库命令伪造云端批准；
- purpose 是否只能由固定 workflow 和 dispatch 授权继承，同一原始 digest 是否被永久限制为单一 envelope/purpose；
- qualification 是否在所有 envelope、custody、aggregate、exit 和提升门禁中永久不可提升；
- `releaseAttemptId`、`rcWorkflowRunId` 与修订后的 S1 证明 DAG 是否无循环、无未批准的跨 run 拼接；
- 独立 `snapshotRunId` 是否先完成，且实施计划明确禁止切换为 RC run 内 reusable snapshot；
- Task 30 合并后的可提升运行是否明确使用新 main/build/bundle/producer/attempt，并把 Task 29R 前缀到 final custody 固定在同一 `rcWorkflowRunId`；
- 所有安装、数据库和工作流修改仍处于未授权状态，等待现有两份实施计划修订并重新批准。
