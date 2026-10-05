# H1 GitHub 实际读取接线

本次完成已批准 GitHub App 的固定读取接口，并在 H1 使用真实身份调用。App 安装 `168113687`、仓库 `keqi119/subscription-Saas`（ID `1253231368`）已确认，无需再次安装或提供私钥。此记录不代表快照准入、JIT 注册或阶段 1 收口。

## 实现与范围

新增 [snapshot-h1-github.py](../../scripts/release/snapshot-h1-github.py)，仅供 root 控制代码导入，没有 CLI、job 参数或环境令牌入口。受信调用者通过私有回调提供已保护的短期 App JWT。接口核对 App、安装及唯一仓库，并申请该仓库的只读安装令牌：administration/actions/contents/deployments/metadata 均为 read。实际注册 Runner 所需的 write 尚未接入。

HTTP 主机固定为 `api.github.com`，不使用代理环境或跟随重定向，不输出错误正文/凭据。查询路径固定，run/job 读取限定 attempt 1；工作流按完整 commit SHA 读取并核对 Git blob 摘要。超过 100 条或不完整的分页结果拒绝使用。返回 API 原始事实，不把调用方选择的 ID 转换成审批或产物来源证明。

正常退出及初始化中的校验失败均撤销已取得的令牌。撤销最多尝试两次；仍失败则关闭所有读取能力并返回明确失败，私有对象保留后续清理能力。不能把失败或无法确认改记为已撤销。`repository()` 返回独立副本，避免调用方修改内部缓存。

## 有限验证与实际读回

- `c64245`：实现缺失时六项测试失败；实现后通过。真实 API 暴露令牌格式限制，增加一项回归后 `e653c2` 复现；修正后共七项通过。
- GitHub 官方已于 2026 年开始发布更长、含点号的 stateless 安装令牌，旧长度/字符限制不适用。实现只限制头安全字符及大小，不解析其内部身份。[官方接口说明](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- 首次 H1 `55f331` / `11bc32` 返回 `H1_GITHUB_TOKEN_INVALID`。令牌未保存或输出；因失败发生在旧代码捕获令牌之前，**该次撤销状态为 UNKNOWN**。`228a2a` 独立确认主备卷/mapper 已关闭，swap/core 已恢复。后续成功不能覆盖此失败。
- 修正后的实际读取 `5cf1dd` 成功：仅指定仓库；旧 CI run `36805384635`、attempt 1、SHA `f3187bd3778de94083d4a870c573279c16768fce`，真实结论仍是 failure。读取到 1 个 job、0 个 approvals、0 个 artifacts、0 个 Runner。该 PR run 仅用于接口核验，不能作为 producer 准入。
- Environment `23175152803` 的真实策略：仅 `main` 分支，required reviewer 为 keqi119（ID `275060624`），`can_admins_bypass=false`，`prevent_self_review=false`。读取快照 workflow 2998 字节，SHA-256 `68ea4a546ceb42f4c0ef93551fbcd6d62237e2da0aed8a948bdec83509e5a0a6`。仍是旧 workflow，未触发。
- 该次只读令牌收到 DELETE 204 后才记 `tokenRevoked=true`；随后关闭主备卷并恢复 swap/core。未连接业务数据库、注册 Runner 或制作快照。
- 一次限定 Luna 审查提出撤销失败后无法重试和浅副本两点，已修正。前者 `34e67b` 先复现，`167ed4` 七项通过；没有增加全量测试矩阵。

实际 API 调用使用修正令牌格式后的代码 SHA `4f1dc93c945607cb9c73ef2f175d0bb0f26a38c14a28f6a5ddcbab66d61a1529`。随后仅修改撤销失败重试及返回副本，未重复请求云端令牌。最终 `0e3b01` 安装/回读为 root:root 0555：

`/opt/subscription-saas/snapshot-adapter/v2/control/snapshot-h1-github.py`

最终文件 SHA-256：`f219489d8ccd2e6a01d7c4093044e598e9a199d52c40dd1c9c9969c448ebac24`。H1 Python 3.6 实际加载通过，主备卷关闭，attempt 根目录为空，Staging PostgreSQL 健康。源码同时加入仓库合同声明和发现清单。

## 后续接线的事实限制

REST artifact 元数据没有上传 job ID 或 run attempt；必须通过精确 workflow、唯一上传步骤及实际 run/job 事实核对来源，不能复制 caller ID 伪装为 API 字段。[Artifact API](https://docs.github.com/en/rest/actions/artifacts)

run approvals 可以读取真实 `state`、`user` 和 `environments`，因此应保留审核人身份验证；它不直接给出批准时刻或 deployment/job 关联。当前 verifier/test 中的额外字段需要对齐真实可验证关系，不能将观测时间当批准时间，也不能因字段缺失直接去掉人工批准门槛。[审批历史 API](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run)

仍待完成：生产 root policy 与 dispatch/current-revocation 来源、上述准入观测适配、JIT 路由和完整 attempt 工序、三 job workflow、精确 OSS publisher/custody 身份及真实快照。之后仍需同候选 R2/R3、两项待迁移和 R4。前置 `67eabf` 确认 Staging PostgreSQL 17.10、128 项迁移中仅 `20260925090000_stage1_operational_completion_terminal_shape` 与 `20260925091000_stage1_operational_completion_settlement_guard` 待执行；`f5ce73` Prisma validate 通过，本次未改业务代码或应用迁移。

## 追加：对齐产物来源和 deployment 查询

[snapshot-admission-verification.mjs](../../packages/release-foundation/src/snapshot/snapshot-admission-verification.mjs) 已删除对 artifact `jobId` / `runAttempt` 伪字段的依赖。现在读取真实 artifact 的 run、SHA、创建时刻，并验证该时刻落在已成功完成的 admission job 起止范围。来源判断还必须同时满足独立固定的 workflow 摘要、action commit 清单、精确三个 jobs 及 needs 链，以及唯一固定名的 `actions/upload-artifact` 步骤；该步骤只上传 `.release-output/snapshot-admission.v1.json`，显式禁止 overwrite，缺文件报错。时间窗口不能单独证明 job 来源。

推导出的 workflow job、实际 job ID、step index、action 和固定路径作为 `derivedArtifactProvenance` 单独纳入签名摘要，没有冒充 GitHub artifact API 字段。仍先完成真实 GitHub 观测和 workflow 核验，再执行当前 dispatch/revocation 验证、canonical admission 重建，最后才读取签名密钥。原有 actor、attempt 1、五标签唯一队列、nonce、用途和撤销门槛保留。

`a62077` 先复现真实字段形状无法通过旧验证器；修改后相关 18 项测试 `aa999a` / 最终 `cd6bdb` 全部通过。一次限定 Luna 审查未发现可证明的重要问题，并明确来源证明依赖受信 workflow 与时间/实际 job 的组合。对这两个已修改文件的 lint/format 检查 `b55399` 通过；初次 lint 的 Buffer/structuredClone 全局声明与正则空格问题已在原文件内修正，没有扩大到其他文件。

审批关联采用 GitHub 官方 `CheckRun.deployment`，从 attempt jobs 的真实 `check_run_url` 取得 CheckRun node ID，再用固定 GraphQL query 读取其 repository、workflow run、commit 和对应 deployment。不能从相同 SHA、时间相近或展示用 log URL 猜测该关系。[官方 CheckRun 字段](https://docs.github.com/en/graphql/reference/checks)

`54765f` 确认此仓库当前为 public；`6efd57` 用现有 GitHub 登录读取旧 CI job，`f3d8e2` 随后在 H1 以现有 App 的五项只读权限实际读取同一关系成功，无需增加 `checks` 权限或修改 App 安装范围。实际 check ID `110188443914`、node ID `CR_kwDOSrLLCM8AAAAZp745Cg`、run `36805384635`、SHA 与原始 job 一致。该普通 CI job 的 deployment/pending 均为 null，**不能作为快照批准证据**；真实 snapshot queued job 的非空关联仍待其实际 run 核验。该次安装令牌已撤销，主备卷关闭，swap/core 恢复，没有触发 workflow 或读取业务数据。

固定接口新增 `read_job_deployment(run_id, job_id)`，只沿实际 API 关系查询，逐项匹配 repository/run/SHA/job/check/node，不接受调用方提供查询文本或 URL。GraphQL 错误/身份不一致拒绝；缺少 deployment 如实返回 null，后续准入必须拒绝放行。`6b2432` 先复现接口缺失，`e45023` 八项 Python 测试通过；其尾部 `rg` 无匹配退出 1 仅确认这些验证器文件不在既有 worker bundle 内，不是测试失败，无需重装 worker。

最终 Python 读取模块由 `24faa8` 安装/回读：root:root 0555，SHA-256 `c4b29236e41dd2af8460deb6a9f13e2973025e05560fce2c292fe09f9107d816`。H1 Python 实际加载通过，主备卷关闭、attempt 根目录为空、Staging PostgreSQL 健康。实际 API 查询发生在接口封装前；封装后的身份拒绝分支由上述有限测试覆盖，未为同一路径重复签发令牌。

`59eb0d` 合同检查通过：290 文件、91 schemas、13 commands、128 项迁移摘要不变，仓库合同摘要 `sha256:1ac5efa33acc7057b605475de45b0aa912a061d0c22ffa643e0a19369221c3ce`。本轮 preflight `04168d`（2026-10-05T13:23:49.388Z）仍只有原两项待迁移，`0b242a` schema validate 通过，临时隧道已关闭。

下一项是将这些真实关系接入 post-approval observation 与 root `readExact` 工厂，取消并未由 API 提供的批准时刻字段，同时保留实际 reviewer/environment/deployment/queued job 的核验。审批 history 的 user/state/environment 已有正式读取入口；不得移除人工批准要求。生产 dispatch/revocation 来源、JIT、完整制作与阶段 1 其余收口项仍未完成。
