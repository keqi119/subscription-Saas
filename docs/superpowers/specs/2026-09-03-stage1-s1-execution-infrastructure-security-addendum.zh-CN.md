# Stage 1 S1 执行基础设施与 Public Repository 安全附录

日期：2026-09-03

状态：待评审

方案方向：A 已获准进入本附录设计；本附录尚未批准实施

设计基线：`9b8a0c282f85f1794066ea23550af1d81e105ddf`

上位规格与计划：

- [Stage 1 收敛治理主 ADR](./2026-09-01-stage1-convergence-governance-adr.zh-CN.md)
- [S1 可信发布底座与测试隔离规格](./2026-09-01-stage1-s1-trusted-release-foundation-and-test-isolation-design.zh-CN.md)
- [S1 实施计划](../plans/2026-09-02-stage1-s1-trusted-release-foundation-implementation-plan.md)

本附录只补充 S1 的执行基础设施、安全边界和停止条件，不替代上位规格。与上位规格冲突时，以更严格且已获批准的规则为准；冲突无法通过更严格规则消解时，停止实施并重新评审。

## 批准边界

本轮批准只允许编写、评审和提交本设计附录，不授权：

- 注册或启动 GitHub self-hosted Runner；
- 安装 `/opt/subscription-saas/snapshot-adapter/v1/`；
- 创建或修改 Staging 数据库身份、权限、网络或 SSH 配置；
- 修改实际 GitHub Actions 门禁工作流；
- 运行 sanitized snapshot、source gate 或 final Compose；
- 恢复 Task 30、应用其 stash 或聚合 S1 退出证据；
- 修改业务代码、业务迁移、模型、枚举、应用 RBAC、S2 或 S3。

本附录获批后，仍需形成独立、可逐项复核的基础设施实施计划；只有该计划另行批准后，才允许安装或执行。

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
8. sanitized snapshot 固定由独立受保护的 `snapshotRunId` producer run 先完成；随后才启动唯一 RC workflow run，并在该 RC run 内完成 source、final、aggregate 和 exit 全链；不允许实施时改成可选的 same-run reusable workflow；
9. 任一排他性、加密处置、只读能力或容量条件不可证明时，方案 A fail closed，转私有仓库或受控非 Actions 快照操作；仅更换为专用 VM 不能消除 public repository 的任务路由风险。

## 信任边界与威胁模型

### 受保护资产

- Staging 原始数据库内容及其结构、计数和业务关联；
- snapshot 只读数据库凭证、SSH 私钥和 tokenization key；
- root-owned adapter 及其允许命令、契约和 digest；
- JIT Runner 注册凭证和本次唯一路由标签；
- 明文 sanitized dump、加密 sanitized snapshot、扫描证据、source fingerprint、custody receipt 和 runner diagnostic log；
- build proof、source-gate evidence、final execution proof 与 Task 30 聚合输入。

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
- 不同 run、SHA、snapshot 或 operation 的证据被拼接进 Task 30。

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
- S1 已批准的 repository contract、build proof 和 execution-proof Schema。

普通 tag、Runner 自报标签、环境变量、自报 SHA、持久 Runner 注册状态、文件名或单独的人工口头确认均不能构成信任根。

## 目标执行拓扑

```text
独立 protected snapshot producer run（snapshotRunId）
  GitHub-hosted snapshot admission
    ├─ 固定 main SHA / workflow digest / repository contract
    └─ 生成 releaseAttemptId、route nonce 与 snapshot-admission.v1
                           │
                           ▼
                人工批准 snapshot environment
                           │
                           ▼
  本地可信启动器 ──核对 policy/observation/job── 生成唯一 JIT 配置
                           │
                           ▼
  专用 WSL ephemeral Runner（仅一个 snapshot job）
    ├─ root-owned adapter
    ├─ 受限 SSH 本地转发
    ├─ Staging 严格只读事务
    └─ 加密隔离卷：raw → restore → sanitize → scan → encrypt
                           │
                           ▼
  private encrypted snapshot + proof/log custody（producer 完成）
                           │
                           ▼
唯一 RC workflow run（rcWorkflowRunId，attempt=1）
  source fresh + source snapshot
    → build admission
    → final fresh + final snapshot
    → final custody
    → aggregate
    → generated exit evidence
    → Task 30 exit audit/final custody
```

production/staging 服务器不能运行 source database test 或 final Compose。WSL snapshot 边界也不能取得 production 凭证、production 网络路径或 Docker 宿主权限。

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

`snapshot-admission.v1` 在人工批准前生成，只绑定 `environmentPolicyIdentityDigest`、source/workflow identity、`releaseAttemptId` 和 route nonce，不得引用尚不存在的批准后 observation。人工批准后、申请 Runner 注册凭证前，可信启动器重新读取 environment、deployment、review 和 branch policy，从响应中重算稳定 identity 并与 root policy 比较；匹配后才生成 post-approval observation。该 observation 的 `observedAt` 距申请 JIT 配置不得超过 5 分钟；超时必须重新读取并生成新的 observation，不能修改旧记录。

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
3. **GitHub-hosted custody continuation**：从受控交接位置只接收已完成脱敏和扫描的 artifact/proof，执行 attestation readback 与后续编排。

本附录明确选择独立 `snapshotRunId` producer；S1 实施计划必须在 Task 29R 恢复前按此拓扑局部修订并重新批准。该修订只负责把唯一执行方式写入计划，不授权修改 workflow 或运行 snapshot。

self-hosted 数据 job 的数据处理命令只能是固定入口，例如：

`/opt/subscription-saas/snapshot-adapter/v1/launch --admission-ref <opaque-reference>`

self-hosted data job 必须只有一个固定 `run` 入口调用上述 adapter；不得在该 job 中下载或执行 checkout、artifact、attestation 或第三方 action。加密 sanitized snapshot、snapshot proof 和 diagnostic log 的发布由 adapter 内置、digest 固定且最小权限的 publisher 完成，写入预先批准的 content-addressed 交接位置；publisher 不得暴露 raw 路径、明文 sanitized dump、通用上传接口或任意目标参数。后续 GitHub-hosted custody continuation 才允许使用按完整 commit SHA 固定的官方 action 读取非敏感交接证明、复核私有对象 digest 并形成 Actions attestation。若无法提供这种封闭交接协议，方案 A 停止，不得退回到 self-hosted job 执行上传 action。

self-hosted job 的 GitHub `permissions` 必须显式收缩为固定入口运行所需的最小集合；不得取得 repository contents、packages、actions mutation 或 attestation 签发权限。workflow/environment 只向 job 提供 opaque admission reference，不注入数据库 URL、SSH 私钥、tokenization key、GitHub 管理令牌或长期 publisher credential。敏感值由本地 root-owned secret broker 在重新验证 admission 后按本次 attempt 解出，只交给固定 adapter 进程；任何需要把原始 secret 暴露给通用 job 环境或 Runner workspace 的实现都不获准。

publisher credential 必须是本 attempt、固定 subject 和固定交接 namespace 的短期 write-once 能力，禁止覆盖、列举其他 attempt 或上传未通过扫描的路径。GitHub-hosted custody continuation 使用独立只读身份完成 digest readback，不能复用 publisher credential。

### Sanitized Snapshot 私密保管

Sanitized 不等于公开。GitHub artifact attestation 只提供来源和完整性证明，不提供内容保密性；明文 sanitized dump 不得进入 public repository 的 Actions artifact、cache、log、release asset 或任何继承 repository read 权限的存储。

方案 A 固定采用“本地逐 attempt 信封加密 + 私有 content-addressed object store”，不能在实施时降级为二选一：

1. adapter 在 WSL 加密隔离卷内完成扫描后，由独立、短生命周期的 producer crypto process 为本 attempt 生成 256-bit data-encryption key，以 AES-256-GCM 和本对象唯一的 96-bit nonce 加密 sanitized dump；authenticated data 至少绑定 repository ID、source SHA、`releaseAttemptId`、snapshot digest、sanitization contract digest 和 expiry；nonce、算法和加密信封 Schema 进入 proof，但明文 key 不进入；
2. data-encryption key 由 KMS/等价受控系统中的 key-encryption key 包装并与密文共同保存；KEK 永不离开 KMS，wrapped DEK 可以保存，明文 DEK 不得持久化。普通 envelope encryption 不得被描述为“KMS 远程完成整个 dump 解密”；KMS 只负责包装/解包 DEK；
3. 明文 DEK 只允许短暂存在于获准的 producer 加密进程和 GitHub-hosted consumer 解密进程内存。禁止写入磁盘、swap、pagefile、环境变量、命令行、stdin、日志、artifact、crash/core dump 或其他进程可读的共享区；进程禁用 core dump，并在平台支持时锁定含 key 的内存页；使用完成后立即 best-effort 覆写 key buffer、关闭进程，随后销毁本次 Runner/VM。best-effort 内存清除不得被表述为可证明的物理擦除；
4. write-only publisher 只能向本 attempt 的固定 namespace 以“若对象不存在才创建”的条件写入密文 digest 寻址的新对象和 metadata，不能读取、列举、覆盖或删除；对象存储必须 private，并启用 versioning/等价 object-lock 保留策略，repository read 权限不授予对象读取权；
5. GitHub-hosted snapshot consumer 使用与 publisher 不同的只读对象身份，并通过受保护的短期 OIDC/KMS identity 只取得 admission 指定的唯一 object version/digest 与 wrapped DEK；KMS 验证该身份后将解包所得明文 DEK 仅返回给本次短生命周期 consumer crypto process。OIDC 信任策略至少绑定 immutable repository ID、固定 workflow path/ref、`refs/heads/main`、environment、actor ID、`rcWorkflowRunId` 和 run attempt；consumer 不能写、删除、列举其他 attempt 或取得 publisher 权限；
6. custody continuation 先核对密文 digest、object version、KMS key reference、访问策略 digest、expiry 和 write receipt，再在独立临时目录解密；明文 sanitized dump 只存在于本次 GitHub-hosted ephemeral VM 的受控 snapshot chain，禁止再次上传；
7. Actions artifact 只允许承载经过字段级审查的非敏感 proof、object reference、digest、attestation 和 custody receipt；任何可恢复明文的 key material、数据库内容或 dump 均不得进入。

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

## 单次 Release Attempt 证明时序

`releaseAttemptId` 只用于跨受保护 producer 的关联和防重放，不能代替 GitHub workflow run 身份。每个 chain、database、Manifest 和 `operationId` 仍保持独立；同时必须冻结唯一 `rcWorkflowRunId` 和 `rcWorkflowRunAttempt=1`。固定逻辑时序为：

```text
独立 protected snapshot producer run：
  snapshot admission
  → 人工批准 snapshot environment
  → JIT WSL snapshot export / sanitization / scan
  → encrypted sanitized snapshot + snapshot proof + runner log custody
  → producer completion proof
  → snapshotRunId 终态 success

随后启动唯一 RC workflow run：
  GitHub-hosted source-gate fresh + snapshot chains
  → build admission
  → GitHub-hosted final fresh execution
  → GitHub-hosted final snapshot execution
  → final evidence custody
  → aggregate proof
  → 本次生成 s1-exit-evidence
  → exit audit
  → 最终保管
```

其中：

- snapshot producer 必须先完成且其 `snapshotRunId` 达到 `success` 终态；只有加密 snapshot、窄 proof/custody 和 producer completion proof 全部进入可信保管后，才允许创建或 dispatch RC run；
- snapshot admission 绑定 source SHA、repository contract digest、`releaseAttemptId`、adapter digest、route nonce、`environmentPolicyIdentityDigest`；JIT launch proof 在人工批准后另行绑定 `environmentPolicyObservationDigest`，不得让 admission 反向引用批准后观察；
- WSL job 只能消费该批准，不能接收完整最终 evidence；
- source gate 的 fresh 与 snapshot chains 均在随后启动的唯一 RC run 内生成；RC run 不复用 snapshot producer 的 source-gate evidence，也不得在运行时切换为内联 reusable snapshot workflow；
- source fresh/snapshot evidence、build admission、final fresh、final snapshot、两者 final custody、aggregate proof、本次生成的 `s1-exit-evidence.v1`、Task 30 exit audit 和最终 custody 必须全部由同一个 `rcWorkflowRunId` 的实际 job 产生或聚合；
- final fresh/snapshot 只能消费该 RC run 前序 job 新生成的 source evidence 和已准入的窄 producer 输入，不得下载其他 run 的 final execution、final custody、aggregate 或完整 exit evidence；
- Task 30 只能在两条 final chain 和 custody 成功后恢复；
- owner/manual attestations只能作为窄输入事实，不得提供完整 `s1-exit-evidence.v1`；
- 任一步失败使本 attempt 不可提升；合法重试使用新 attempt/run/operation ID，并保留旧失败或 UNKNOWN 证明；
- 禁止跨 attempt、跨 source SHA、跨 adapter digest、跨 snapshot 或跨 build proof 拼接证据。

允许来自独立受保护 producer run 的外部输入只有三类：终态为 `success` 的 `snapshotRunId` 所生成的加密 sanitized snapshot 及其窄 proof/custody、同一 source SHA 的 build proof、窄 owner/manual attestation。每类必须绑定精确 producer repository/workflow/run/attempt/artifact subject 和 custody digest，并在 RC run 内重新验证。source-gate evidence 不属于外部豁免，必须在 RC run 内生成。

RC workflow 不得声明或接受 `finalExecutionRunId`、`finalExecutionArtifactName`、`exitEvidenceRunId`、`exitEvidenceArtifactName` 或等价的外部最终证明定位输入；也不得接受调用方直接提供完整 final evidence、aggregate proof 或 `s1-exit-evidence.v1`。这些对象只能由本次 RC run 根据前序实际结果按固定 DAG 生成。相同 `releaseAttemptId`、文件名或 digest 自报值均不能放宽 same-run 约束。

## 失败、取消与 UNKNOWN

- 人工批准前失败：不注册 Runner，只记录 admission rejection；
- JIT 注册后、接单前失败：撤销或等待凭证失效，确认 Runner 不可路由并销毁实例；
- source snapshot 尚未打开时失败：记录 `FAILED`，执行实例/加密卷处置；
- source snapshot 已打开但结果确定未发布：关闭事务并记录 `FAILED`；
- 加密 sanitized snapshot 是否发布不明：记录 `INTERRUPTED_UNKNOWN`，禁止用同一 Runner 或相同 operation 直接重传；
- runner job 与 GitHub API 终态不一致：以 `UNKNOWN` 处理；
- 销毁证明、日志保管或 runner 注销任一缺失：即使加密 sanitized snapshot 已生成，也不得进入 source snapshot/final chain；
- GitHub-hosted 容量、镜像、数据库、API/Web 或 Playwright 失败：保留本次失败证明，不得转为外部 JSON 或人工“通过”。

## 当前实现到目标的偏差

| 原子事项                | 当前实现                                                  | 目标                                                                                                       | 阻断路由                     |
| ----------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 仓库可见性              | public                                                    | public 下必须证明 JIT 排他路由；不能则转 private/非 Actions                                                | 本附录实施前 P1              |
| snapshot environment    | `stage1-snapshot-export` API 404、未创建                  | 稳定 identity digest 与批准后 observation digest 分层；固定 ID/reviewer/main policy/禁 bypass/单操作员风险 | 环境 bootstrap 后再次批准 P1 |
| snapshot Runner         | 固定 self-hosted 能力标签，无实例                         | 每次唯一标签、人工批准后 JIT/ephemeral、单 job 后注销销毁                                                  | 本附录实施前 P1              |
| snapshot job 代码       | checkout、pnpm、仓库脚本                                  | self-hosted 数据面不 checkout、不装依赖，只调用 root-owned adapter                                         | 工作流修订 P1                |
| snapshot adapter        | 固定路径缺失                                              | root-owned、不可修改、依赖闭包与 digest 固定                                                               | adapter 独立设计/实现 P1     |
| sanitized snapshot 保管 | public Actions artifact、明文 dump、30 日                 | 逐 attempt 加密、私有 content-addressed store、分离 publisher/consumer/retention、失效后 180 日            | custody 实施前 P1            |
| WSL 隔离                | 未建立                                                    | 专用 distro、非特权身份、无 Docker/interop/Windows mount                                                   | 基础设施实施 P1              |
| raw 存储                | 未建立                                                    | 每 attempt 独立加密卷与密钥失效证明                                                                        | 基础设施实施 P1              |
| SSH                     | 现有 root key 可取得 Shell                                | snapshot 专用 key，仅固定 Staging DB 本地转发                                                              | 服务器配置 P1                |
| Staging 数据库身份      | 只有应用超管身份                                          | snapshot 专用严格只读角色及有效能力证明                                                                    | 数据库配置 P1                |
| snapshot 事务语义       | 计划、实现和测试要求无效的 `REPEATABLE READ + DEFERRABLE` | `REPEATABLE READ READ ONLY` 稳定 MVCC snapshot，并以真实 PostgreSQL 17 集成测试证明                        | Task 29R 前置计划修订 P1     |
| source/final 主机       | 工作流要求 self-hosted                                    | GitHub-hosted `ubuntu-24.04` ephemeral VM + 实际版本证明 + 容量预检                                        | 工作流修订 P1                |
| 容量                    | 未生成 capacity plan                                      | 每 chain 写前预检，超限切专用 ephemeral VM                                                                 | final gate P1                |
| Snapshot/RC 运行边界    | Task 29R 尚未真实执行                                     | 独立 `snapshotRunId` 先完成；随后 RC 的 source/final/custody/aggregate/exit 全部同一 `rcWorkflowRunId`     | Task 29R-D P1                |
| Task 30                 | stash 冻结                                                | 仅在本 attempt 全链证明和 custody 后恢复                                                                   | 持续阻断                     |

## 方案 A 退出条件

出现以下任一情况，立即停止方案 A；不得以运维豁免、模拟 JSON、持久 Runner 或当前 production/staging 服务器代替：

- 不能证明唯一 queued snapshot job 与 JIT Runner 实际接收 job 完全一致；
- `stage1-snapshot-export` environment 缺失、ID/策略漂移、reviewer 不匹配、允许错误分支或管理员 bypass；
- environment 稳定身份与运行观察仍使用一个 digest，或 admission 依赖批准后才能生成的 observation；
- public repository 允许 PR、fork、评论事件、任意 ref 或旧 run 获得相同路由；
- snapshot workflow 的实际 blob/content digest、action commit 清单或 admission Schema 与本地 root policy 不一致；
- self-hosted job 必须 checkout/执行仓库任意代码或 package lifecycle script；
- Runner 用户可修改 adapter、取得 Shell/SQL 路径、sudo、Docker socket 或 Windows/宿主数据；
- 原始数据可能落入未加密磁盘、swap/pagefile、cache、artifact 或日志；
- 明文 sanitized dump 进入 public Actions artifact，或私有存储、逐 attempt 加密、读写/retention 身份分离及失效后 180 日处置无法证明；
- 只能证明普通文件删除，不能证明加密密钥失效；
- SSH 能取得交互 Shell、任意端口转发或 production 网络路径；
- Staging source 角色存在 owner、DDL、写入、SET ROLE 或 RLS 绕过能力；
- snapshot 实现继续把 `DEFERRABLE` 与低于 `SERIALIZABLE` 的事务组合并宣称获得安全延迟保证，或缺少真实 PostgreSQL 17 MVCC 集成证据；
- GitHub-hosted capacity plan 不通过或无法获取可信上界；
- snapshot、source、build、final 或 Task 30 证据不能绑定同一 releaseAttemptId 和固定 source SHA；
- final execution/custody、aggregate、exit evidence 或 Task 30 tail 不是来自同一 `rcWorkflowRunId`，或 workflow 重新接受外部完整最终证明输入；
- RC run 在独立 snapshot producer 完成前启动，或实现保留外部 `snapshotRunId` 与 same-run reusable snapshot 的运行时选择；
- 需要修改业务代码、业务迁移、模型、枚举或应用 RBAC 才能完成基础设施门禁。

退出后的合法选择只有：

1. 将仓库转为 private，并重新评审 Runner 路由、成本和访问控制；或
2. 使用不受 GitHub Actions public job 路由影响的受控非 Actions snapshot 操作，输出独立 attestation 后再由 GitHub-hosted 门禁消费；或
3. 为容量/主机隔离使用专用 ephemeral Linux VM，同时仍满足 public repository 的全部排他路由规则。

专用 VM 本身不是 public repository 路由风险的修复。

## 本附录批准后的文档顺序

1. 先审批本附录的边界、拓扑、排他路由、加密处置和退出条件；
2. 再编写独立实施计划，至少拆为：GitHub 路由/environment bootstrap 与 identity/observation 复核、root-owned adapter、WSL 加密隔离、私有 snapshot custody/KMS/DEK 内存生命周期与 180 日处置、独立 snapshot producer 到 RC run 的固定交接、SSH/数据库只读身份、PostgreSQL 17 snapshot 事务修正、GitHub-hosted capacity/final gate、same-run 证明 DAG、故障销毁演练；
3. 实施计划逐项评审通过后，才允许创建环境身份、安装 adapter、注册首个 JIT Runner或修改工作流；
4. Task 29R 必须通过真实 protected execution gate 后，才能恢复 Task 30；
5. Task 30 完成仍不代表 S2/S3 获准。

## 文档阶段验收标准

本附录只有在以下问题都得到明确批准后才能关闭：

- public repository 下的 JIT 排他路由是否足以实施；
- environment 当前缺失状态、目标 ID 冻结流程、策略字段和单操作员风险是否被明确接受；
- environment policy 的稳定 identity、批准后 observation、admission 和 JIT launch proof 是否形成无循环且可判定时效的证明链；
- self-hosted snapshot job 是否完全退出仓库代码执行面；
- workflow digest、允许 action 清单、route nonce 生成和本地 root policy 是否形成不可自签发的路由信任链；
- adapter 信任根、参数面、digest 和安装所有权是否唯一；
- WSL 原始数据加密、密钥失效、swap/pagefile 和日志保管是否可证明；
- sanitized snapshot 的逐 attempt 加密、私有对象 ACL、读写/retention 身份分离及失效后 180 日处置是否可证明；
- KEK/DEK 角色、producer/consumer 明文 DEK 内存边界及进程/VM 销毁语义是否准确；
- SSH endpoint 与 Staging 角色是否满足有效只读而非自报只读；
- `REPEATABLE READ READ ONLY` 的真实 PostgreSQL 17 MVCC 测试是否作为 Task 29R 前置门槛；
- GitHub-hosted 容量公式、停止阈值和专用 VM 回退是否可执行；
- `releaseAttemptId`、`rcWorkflowRunId` 与现有 S1 证明 DAG 是否无循环、无未批准的跨 run 拼接；
- 独立 `snapshotRunId` 是否先完成，且实施计划明确禁止切换为 RC run 内 reusable snapshot；
- 所有安装、数据库和工作流修改仍处于未授权状态，等待独立实施计划批准。
