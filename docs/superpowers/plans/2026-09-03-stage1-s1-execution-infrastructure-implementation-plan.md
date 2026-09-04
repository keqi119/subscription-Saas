# Stage 1 S1 Execution Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

状态：已批准为条件可执行实施计划（内容基线 `31cc3e8c`）；先完成 Task 0 仓库准入，外部操作逐项批准

**Goal:** 实现已批准的方案 A 执行基础设施，使独立 sanitized snapshot producer 能在 public repository 条件下安全运行，并让唯一 RC workflow 在 GitHub-hosted 临时机上完成 source、final、aggregate 与 exit 证明链，从而解除 Task 29R 的基础设施阻断。

**Architecture:** 仓库内只保存版本化契约、可测试的构建源码和无秘密策略模板；GitHub Environment、Aliyun OSS/KMS/RAM、Staging SSH/数据库身份及 WSL root policy 均由受控执行器按 `plan → approval policy → apply → readback proof` 建立。Snapshot 数据 job 只调用预安装、root-owned、digest 固定的单一入口；加密 snapshot 与 purpose lineage 分别进入独立私有 OSS namespace，并由精确绑定 `snapshotRunId` 或 `rcWorkflowRunId` 的短期、单能力身份读写。准确 merged-main SHA 的 API/Web/Runner bundle 经独立计划、批准、构建和保管后才分配 `releaseAttemptId` 与 dispatch 授权；独立 Producer 成功后才启动唯一 RC run。RC 内先产生不可变 raw v1 proof，再形成一对一 purpose claim/envelope、v2 custody/aggregate/exit；qualification 在 Task 30 前强制停止且不可提升。

**Tech Stack:** Node.js 22.23.2、pnpm 11.4.0、Node ESM/`node:test`、PostgreSQL 17、GitHub Actions/JIT ephemeral Runner、WSL2 Ubuntu 24.04、LUKS2、OpenSSH、Docker Buildx/Compose、Aliyun OSS、Alibaba Cloud KMS/RAM/STS、AES-256-GCM、Playwright 1.62.1。

**Spec:** `docs/superpowers/specs/2026-09-03-stage1-s1-execution-infrastructure-security-addendum.zh-CN.md`；本轮批准内容基线 `75aaa956`，批准记录及 admission 勘误提交 `86663d98` 不替代内容基线；旧批准内容 `380c0edb`/状态 `4f037a5c` 仅作历史记录。

**Upstream Plan:** `docs/superpowers/plans/2026-09-02-stage1-s1-trusted-release-foundation-implementation-plan.md`；本轮批准内容 `f50676c6`/元数据 `30a90fae`；旧内容 `24799d0c`/元数据 `c3afabcc` 保留为历史基线。执行时它是只读依赖，Task29R-D 零文件/零提交；本计划为唯一施工所有者，不恢复或实施 Task30。

**Revision Scope:** 用户于 2026-09-04 批准本计划内容基线 `31cc3e8c`，确认 Producer crypto/publisher、source/final proof DAG、构建前 sanitized 输入、私有证据保管与 bootstrap 时序的跨文档收敛通过。本状态记录同步 Task 1 的已批准内容/元数据引用，不改变任务、权限或证明契约；文内批准记录不替代 Task 0 的独立签名批准链。Canary `155acf6a` 交接设计的独立窄授权已确认，按附录同步到 Task 13/I7/I8；其代码和真实云验证仍未实施。本计划仍是唯一施工所有者，上游 Task 29R-D 仅验收。

**Remaining admission gates:** 三份内容已分别批准，但 Task 0 的最新 main/签名批准链/受控数据库、I0 独立签发及私有保管实际 readback、canary 无云交接与真实探测、I15B 合法构建前 sanitized 输入及独立使用授权仍须实际验证，不能由文档或 mock 代替。缺失构建前输入时为 `PREBUILD_SANITIZED_INPUT_UNAVAILABLE`；另行输入补给方案/批准不由本计划自动施工。Qualification 通过后 Task 30 再单独授权，S2/S3 不在本次范围。

## Global Constraints

- 本计划获批前不得执行任何安装或外部状态变更。获批后，每项外部变更仍必须经过本计划列出的独立 human approval checkpoint；不得把“计划批准”当作某次具体 apply 的批准记录。
- 从包含本轮三文档最终批准内容及批准记录的最新 main 创建新的隔离 worktree；旧附录/上游 commits 仅用于追溯，不能代替本轮批准。不得在当前文档 worktree 或保存 Task30 stash 的工作树施工。
- Task 30 stash `paused-task30-before-task29r-20260903` 在整个计划期间保持冻结。禁止 apply/pop/drop、修改 stash 内容或把其中文件加入任何提交。
- S2、S3、产品代码、业务迁移、Prisma 模型/枚举、应用 RBAC、业务权限、业务开关、客户可见行为和业务 API 均不在范围内。
- 所有仓库任务开始前运行 `git status --short`；只允许本任务列出的文件变更。每个任务独立提交，禁止把相邻安全边界合并为一个大提交。
- Task 0 之前不得读取 ambient `DATABASE_URL`、仓库 `.env` 或任何 Staging 凭证。Task 0 建立受控 PostgreSQL 17 目标后，所有 Prisma/database 检查只通过 `scripts/release/with-controlled-target.mjs` 执行。
- 当前 `prisma migrate status` 因缺少 datasource URL 未验证。Task 0 必须在代码写入前用受控目标取得 `migrate deploy → migrate status` 成功证据；失败立即停止，不能把 `prisma validate` 替代为迁移状态。
- Snapshot custody 固定采用 Alibaba Cloud China (Shanghai) 区域的独立私有 OSS bucket、KMS key 和 RAM/STS 身份；不得复用业务上传 bucket、API 的 OSS 身份或生产服务 KMS key。
- Alibaba RAM OIDC Provider 固定名称 `github-actions-subscription-saas-stage1`、issuer `https://token.actions.githubusercontent.com`、唯一 client ID/audience `sts.aliyuncs.com`、Earliest Issuance Time Allowed `1 hour`。Provider 计划固定独立验证的 HTTPS CA fingerprints，readback 必须记录 Provider ARN、实际 fingerprint 集合和 issuance limit；任何漂移均拒绝 STS。
- Dedicated custody bucket 名称由 `subscription-saas-stage1-snapshot-${sha256(accountId).slice(0, 12)}-cn-shanghai` 派生；versioning disabled、forbid-overwrite=true、Locked BucketWorm 210 日只是配置下界。每对象仍须以实际 Last-Modified/GetBucketWorm readback 证明覆盖 ordinary terminal+180 或 snapshot expiry+180 及下游/legal hold，不能直接宣称210日已满足。
- KMS key alias 固定为 `alias/stage1-snapshot-custody`，角色批准绑定 alias readback 后的实际 key 身份。Producer 仅通过独立 `producer-crypto-run-authorization.v1` 和 generate-only identity 使用 `GenerateDataKey(AES_256)`；publisher 禁止全部 KMS 数据权限。Consumer 仍对批准的 wrapped DEK/context 调用 `Decrypt`。不采用会改变已选 recovery API/密钥类型的本地公钥包装替换。KEK 不离开 KMS，DEK 仅短暂存在于独立 crypto process 内存。
- Snapshot payload 的既有身份与 lineage 身份严格分离。`exact-capability-approval.v1` 的 `publisher-sts|oidc-cloud-role|jit-registration`、允许 job、字段及权限保持冻结；lineage 只使用前向 `exact-capability-approval.v2`、`lane=rc`、`capabilityKind=lineage-oss-role` 和唯一 `lineage-create-only-writer|lineage-readback-reader` profile。底层同用 OIDC 不代表复用 v1 kind/approval/role/session/use proof。每个 lineage 进程只持一个 profile，禁止组合凭证、通配 key、List/Delete、跨 node/attempt/run 及 snapshot/KMS/数据库/JIT 权限。`lineage-retention-operator` 不属于日常 v2 能力；本轮不创建其 role/session，未来逐 exact-key 处置须另行批准。
- GitHub OIDC subject 固定包含 immutable repository identity、`workflow_ref`、`workflow_sha`、`ref`、`environment`、`actor_id`、`run_id`、`run_attempt`、`event_name` 和 `runner_environment`。每个 snapshot/RC consumer role 的 trust policy 对本次完整 subject 做精确匹配，不使用 run ID 通配符。
- Repository OIDC customization 是 repo-wide 外部状态。必须先创建并 read back Alibaba OIDC Provider、为预计的新 subject 建立精确 canary RAM trust condition，再切换 GitHub subject template；若当前配置已被其他云角色依赖、无法安全迁移，或 Alibaba RAM 无法对完整 `sub` 做精确比较，立即停止方案 A 并回到设计评审。
- GitHub repository 固定为 `keqi119/subscription-Saas`、repository ID `1253231368`；允许 actor/reviewer 固定为 user ID `275060624`。名称或 login 不能替代 immutable ID。
- Snapshot Environment 固定为 `stage1-snapshot-export`：唯一 branch rule `main`、无 tag rule、`can_admins_bypass=false`、`prevent_self_review=false`、wait timer `0`。本批准接受的单操作员风险不扩展到其他 Environment。
- The Adapter producer uses existing Environment `trusted-image-build`; GitHub-hosted RC jobs use `trusted-source-database-gate`, `trusted-release-execution` and `trusted-release-candidate`. Task 13 inventories and freezes their actual IDs and policies; if any is absent or broader than its approved S1 contract, this plan stops for a separate change plan instead of silently creating or widening it.
- Snapshot job 的完整标签集合必须精确为 GitHub 默认 `self-hosted/linux/x64`、能力标签 `stage1-snapshot-export` 和一次性标签 `stage1-snapshot-export-${snapshotRunId}-${routeNonce}`。Runner 只执行一个 job，随后注销、销毁。
- Snapshot self-hosted job 不 checkout、不调用 `uses`、不执行 package manager、仓库脚本、任意 Shell/SQL 路径或 Docker。唯一支持入口为 `/opt/subscription-saas/snapshot-adapter/v1/bin/snapshot-job launch --admission-ref`。
- GitHub-hosted admission job does not reference an Environment and cannot request OIDC or issue a GitHub artifact attestation. It publishes canonical non-secret input only; the root launcher independently re-fetches GitHub run/job/workflow/artifact facts, then signs `snapshot-admission-verification.v1` with a root-held Ed25519 key whose public-key digest is pinned in root policy.
- GitHub-hosted custody continuation uses `stage1-snapshot-export`, requests only `id-token: write` plus `attestations: write`/read permissions, and issues the GitHub attestation after private object/proof/destruction readback. The data job uses the same Environment but never receives an OIDC token.
- WSL distro 固定为专用 Ubuntu 24.04 rootfs digest；禁用 Windows interop、Windows PATH 注入、Windows 盘自动挂载和 swap。Runner 用户无 sudo、无 Docker group、无宿主密钥读取权。
- Raw dump、临时 PostgreSQL、WAL、排序文件、明文 sanitized dump 和 tokenization material 全部位于每 attempt 独立 LUKS2 volume。销毁证明只声明 key invalidation 与 volume 不可解锁，不声明物理擦除。
- Snapshot source SSH 用户固定为 `stage1_snapshot_tunnel`，数据库角色固定为 `stage1_snapshot_reader`，Staging loopback endpoint 固定为 `127.0.0.1:55432`。禁止复用现有 root SSH key或应用数据库超管身份。
- Source 事务固定为 `REPEATABLE READ READ ONLY`；不得设置或断言 `DEFERRABLE`。真实 PostgreSQL 17 集成测试必须证明同一 exported snapshot 的两次 fingerprint 在并发提交下保持同一 MVCC 视图。
- GitHub-hosted source/final job 固定使用 `ubuntu-24.04`，并记录 runner image、kernel、CPU、Docker、Buildx 和 Compose 实际版本。`ubuntu-latest` 不能作为身份或容量保证。
- 每条 source/final chain 在 pull、restore 或 Compose 写入前生成 `capacity-plan.v1`，满足 `requiredUpperBound + max(3 GiB, totalDisk × 20%) <= availableDisk`。不满足时停止，不删未知 Docker 数据、不减测试；专用 ephemeral VM 需要另行实施计划。
- 明文 sanitized dump、raw 数据、DEK、tokenization key、数据库/SSH凭证不得进入 Actions artifact、cache、log、命令行、环境变量、core dump 或公共 release asset。Actions artifact 只保管非敏感 proof/reference/digest/attestation。
- 每个 qualification 或 release-candidate 尝试必须先由独立受保护 build task 对同一准确 merged-main SHA 生成可信 build proof 与不可拆分 API/Web/Runner bundle，并完成 registry digest、attestation 与 custody readback；随后才分配新的 `releaseAttemptId`，签发并核验绑定该 ID 的 `rc-dispatch-authorization.v1`，再依次启动 Producer 取得 `snapshotRunId`、完成 Producer、启动 RC 取得 `rcWorkflowRunId`。任何 run ID 不得在 dispatch 授权中预先虚构。
- Producer 内 `snapshot-producer-completion.v1` 仅证明 data/scan/encryption/destruction/custody 已完成，不含本 run 或当前 custody job 的未来 terminal 状态。独立控制面在 Producer 结束后读回 GitHub 实际 run/jobs 全部 terminal success，才 dispatch RC；RC 入口再次独立核对该实际终态、completion digest 和私有 custody，不信任 caller 的 `success` 字符串。
- Snapshot producer 的 `run_attempt` 固定为 `1`；GitHub rerun 不可复用原 admission、route nonce、JIT 配置或 cloud role，失败后必须新建 producer run 和 `releaseAttemptId`。
- RC workflow 不接受 `finalExecutionRunId`、`exitEvidenceRunId` 或任何外部 final/aggregate/exit object。Source fresh/snapshot、final fresh/snapshot、final custody、aggregate、generated exit 和 Task 30 tail 必须来自同一 `rcWorkflowRunId`；本计划只做到 Task 29R checkpoint，不执行 Task 30 tail。
- Infrastructure Tasks I16–I24 form one non-promotable Task 29R qualification release attempt; its producer and RC run only prove the infrastructure prefix and cannot be continued, reused or spliced into the final S1 proof after Task 30 approval. After Task 30 is separately approved, implemented and merged, a new source SHA, build proof, bundle, Producer, `releaseAttemptId` and RC run must execute “new Producer → new single complete RC run”, and that complete RC run must execute its own Task 30 audit and final custody.
- Published source/execution/final-compose v1 raw proofs remain immutable and are validated first. Each selected raw digest is then bound exactly once by `purpose-claim.v1` and `execution-purpose-envelope.v1`; only read-back v2 custody of both claim and envelope may enter `release-aggregate-proof.v2` and `s1-exit-evidence.v2`. Raw v1 proof may not enter aggregate/exit directly and may not be rewrapped for another purpose.
- `executionPurpose` is inherited only from a fixed workflow and an approved `rc-dispatch-authorization.v1`; CLI, workflow input, environment variable and caller JSON may not choose it. Qualification lineage is permanently non-promotable; Task 30 must reject it before selecting any input.
- Dispatch authorization, exact capability approval (frozen v1 or forward v2) and database command approval remain three separate runtime approval classes. Prerequisite `external-change-approval.v1` approves only the independent resource mutation. Every exact capability follows `pending deployment → prerequisite plan/change approval → apply/readback → exact approval binding actual readback → Environment approval → post-approval observation → credential use → revoke/expiry`. Runner-database-role execution uses launch/database observations, command policy and applicable `approval-record.v1`, never a synthetic cloud or lineage approval.
- I17 separately prepares JIT, publisher and producer-crypto prerequisites/readbacks and their independent approvals before the data Environment approval. After fresh observation and JIT assignment, the fixed crypto child receives only its generate-only credential. Its key clearing, process exit and session revoke/definite expiry precede publisher issuance. The existing publisher broker remains assume-publisher-only with no OSS/KMS/data permission and no ability to assume the crypto role. It delivers one <=900-second OSS-only STS credential by sealed FD to the ready publisher child; no process holds both data credentials and neither enters workflow environment/secret/argv/workspace.
- `snapshot-data` and the dependent `snapshot-custody` job require two independent pending deployments; for each capability its independent prerequisite change approval/apply/readback precedes the exact-capability approval, which in turn precedes human Environment approval and post-approval observation. Producer custody validates ciphertext/proofs/destruction only and never receives KMS Decrypt; each RC snapshot consumer establishes its own ordered `oidc-cloud-role` chain and is the only party allowed to decrypt its exact object version.
- Purpose claim、envelope、v2 custody、aggregate 与 exit 仅进入私有 lineage 存储；每个固定 store/readback job 独立取得 v2 approval、role、Environment deployment/observation、`lineage-oss-role-use-proof.v1` 和 terminal revoke/expiry。前一 session 终止后下一 job 才能取得凭证。Node canonical bytes/digest/exact-key set 先于 store approval 冻结；后置 `lineage-storage-access-receipt.v1` 只由下一层 node 或终态 audit/stop proof 引用，不嵌入被存储 node，也不改写 raw v1/envelope。
- Claim/envelope 固定两个 job：writer 先条件创建 claim，收到明确成功响应后才创建 envelope；writer 不读回。两个写入都明确成功且 writer 终止后，独立 reader 读回两者，才允许成功 access receipt/custody。部分成功、冲突、UNKNOWN 或读回不匹配均阻断下游；只读诊断不得补写、恢复本尝试或改作成功。后续必须新 operation/run、新 raw proof 和完整 lineage。
- 任何 identity、digest、approval、capacity、source privilege、fingerprint、custody、destruction 或 same-run 约束不满足，均 fail closed。禁止通过 mock JSON、手工“通过”、公共 artifact、常驻 Runner 或服务器 Compose 替代。
- Source fresh/snapshot 只使用准确源码执行器并产生 `source-gate-evidence.v1`；不得创建正式 Manifest 或冒充最终 Runner `execution-proof.v1`。Final 才使用最终 Runner 与正式 Manifest；command leaves 不引用 source/final 父 envelope，final parent 单向引用 source 和已完成 command leaves；任何 self-reference/cycle 均拒绝。
- I15B build 前 source 双链仅接受已合法私有保管、未过期、非 qualification 的 sanitized 输入及独立 input-use approval，prebuild evidence 纳入 build provenance。它不使用尚未创建的本 attempt Producer，不扩大 v1 RC consumer 适用范围。新 Producer 后仍在当前唯一 RC 中完整重跑 source 双链再 final。
- Actions artifact 默认保留 30 日、public repository 上限 90 日，仅作非敏感短期交付。原始 proof、plan/approval、撤销、use/access、失败和下游引用全部由独立控制面逐 exact-key archive writer/reader 私有 OSS/WORM 保管并实际读回；普通证据至少 180 日，snapshot 关联证据至少 expiry+180 日，并不早于下游/legal hold。不得以 `now+180` 声明冒充存储事实，亦不得扩 v1/v2 为 archive 权限。
- I0 在 I1 前独立批准并验证签名/撤销/保管控制面与私有 OSS/WORM；不依赖未来 Adapter、Runner、JIT、GitHub OIDC 或 I13。I5/I6 只复核该存储及批准 KMS/crypto/broker 差额，不重复创建/锁定。Crypto、archive 和 canary 都是独立命名窄合同，不是冻结 v1/v2 的新 variant。

## Fixed Names and Derivations

| Item                      | Fixed value or deterministic derivation                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Snapshot Environment      | `stage1-snapshot-export`                                                                                                 |
| Adapter build Environment | `trusted-image-build`, existing identity must be read back                                                               |
| RC source Environment     | `trusted-source-database-gate`, existing identity must be read back                                                      |
| RC final Environment      | `trusted-release-execution`, existing identity must be read back                                                         |
| RC aggregate Environment  | `trusted-release-candidate`, existing identity must be read back                                                         |
| Repository                | `keqi119/subscription-Saas`, ID `1253231368`                                                                             |
| Actor/reviewer            | `keqi119`, user ID `275060624`                                                                                           |
| Snapshot workflow         | `.github/workflows/sanitized-snapshot.yml` on exact `main` SHA                                                           |
| RC workflow               | `.github/workflows/release-candidate-gate.yml` on exact `main` SHA                                                       |
| Capability label          | `stage1-snapshot-export`                                                                                                 |
| Unique route label        | `stage1-snapshot-export-${snapshotRunId}-${routeNonce}`                                                                  |
| Root policy               | `/etc/subscription-saas/snapshot-adapter/v1/root-policy.v1.json`                                                         |
| Adapter root              | `/opt/subscription-saas/snapshot-adapter/v1/`                                                                            |
| Root secret handoff       | `/run/subscription-saas/snapshot-secrets/${releaseAttemptId}.json`, tmpfs, mode `0400`                                   |
| LUKS backing file         | `/var/lib/subscription-saas/snapshot-volumes/${releaseAttemptId}.luks`                                                   |
| LUKS mapper               | `subscription-s1-${releaseAttemptId}` after strict identifier validation                                                 |
| OSS region                | `oss-cn-shanghai`                                                                                                        |
| Custody bucket            | `subscription-saas-stage1-snapshot-${sha256(accountId).slice(0, 12)}-cn-shanghai`                                        |
| Snapshot object key       | `snapshot-slots/v2/${releaseAttemptId}/${snapshotRunId}/snapshot.enc`                                                    |
| Purpose claim key         | `evidence/claims/v1/${rawProofType}/${rawProofDigest.slice(7)}`; globally derived from raw identity, not attempt/purpose |
| Other lineage objects     | `evidence/v1/${releaseAttemptId}/${rcWorkflowRunId}/${objectType}/${digest.slice(7)}`; exact keys only                   |
| KMS alias                 | `alias/stage1-snapshot-custody`                                                                                          |
| Aliyun OIDC Provider      | `github-actions-subscription-saas-stage1`                                                                                |
| OIDC issuer / audience    | `https://token.actions.githubusercontent.com` / `sts.aliyuncs.com`                                                       |
| Adapter OCI repository    | `ghcr.io/keqi119/subscription-snapshot-adapter`                                                                          |
| Admission signing key     | Ed25519 public-key digest pinned in root policy; private key remains root-held                                           |
| DB loopback endpoint      | `127.0.0.1:55432` on Staging host                                                                                        |
| SSH user                  | `stage1_snapshot_tunnel`                                                                                                 |
| PostgreSQL role           | `stage1_snapshot_reader`                                                                                                 |
| Snapshot expiry           | `createdAt + 30 days`                                                                                                    |
| OSS WORM                  | locked BucketWorm, 210 days                                                                                              |

The claim key is a separate private prefix under the same lineage policy, not a prefix-wide grant.
Snapshot slot v2 explicitly replaces the former ciphertext-digest-derived payload key. The publisher's closed filename set is `snapshot.enc`, `encryption-envelope.json`, `snapshot-proof.json`, `diagnostics.redacted.json`, and `data-result.json`, each under that exact attempt/run directory. Plans authorize only these exact keys, never the directory prefix. Their actual digests/sizes arise after scan/encryption and enter receipts/readback, not prerequisites. `data-result.json` does not attest its own upload or later session termination. Publisher use/terminal and volume-destruction proofs are later archived by the independent control plane; no terminated publisher must write again or self-attest cleanup. Lineage addressing is unchanged.
The purpose writer/reader receives exactly the one raw-derived claim key plus its attempt-bound envelope
key. Reusing a raw digest in another attempt/purpose therefore collides with the original claim; no
alternate path is permitted. Raw type is a closed enum and digests use the existing canonical format.

**Closed v2 execution matrix (contracted in Task 4; enforced in Tasks 13/16B/16C):**

| `permissionProfile`          | Exact RC jobs                                          | Environment                 | `lineageNodeKind`                    |
| ---------------------------- | ------------------------------------------------------ | --------------------------- | ------------------------------------ |
| `lineage-create-only-writer` | `lineage-purpose-store`, `lineage-custody-store`       | `trusted-release-execution` | `purpose`, `custody`, matched to job |
| `lineage-readback-reader`    | `lineage-purpose-readback`, `lineage-custody-readback` | `trusted-release-execution` | `purpose`, `custody`, matched to job |
| `lineage-create-only-writer` | `lineage-aggregate-store`, `lineage-exit-store`        | `trusted-release-candidate` | `aggregate`, `exit`, matched to job  |
| `lineage-readback-reader`    | `lineage-aggregate-readback`, `lineage-exit-readback`  | `trusted-release-candidate` | `aggregate`, `exit`, matched to job  |

No runtime job/profile selection or additional lineage job is allowed. Purpose/custody instances for
multiple raw proofs use a deterministic manifest of exact job-instance IDs; each instance's approval,
role, keys and proofs bind that ID. The canonical workflow job ID must still match the matrix.

## Planned File Map

| Area               | Files and responsibility                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan dependency    | Approved upstream content `f50676c6`, metadata `30a90fae`: verify Task 29R-D zero-file ownership and Task 30 consumer-only block; never edit it                                                                   |
| Routing contracts  | `release/contracts/schemas/environment-policy-*.json`, `snapshot-admission.v1`, `snapshot-admission-verification.v1`, `snapshot-jit-launch-proof.v1`, `snapshot-producer-completion.v1`                           |
| Custody contracts  | Snapshot encryption/private/destruction/retention Schemas plus `evidence-lineage-storage-policy.v1`, lineage access/readback/retention and v2 custody contracts                                                   |
| Shared logic       | `packages/release-foundation/src/snapshot/**`: policy/digest checks, envelope crypto, capacity calculation and proof builders                                                                                     |
| Root-owned adapter | `apps/snapshot-adapter/**`: fixed CLI, GitHub API verifier, JIT lifecycle, SSH/PostgreSQL snapshot pipeline, crypto subprocess, OSS/KMS adapters                                                                  |
| Bundle producers   | Adapter: `build/verify-snapshot-adapter-*`, `.github/workflows/snapshot-adapter-build.yml`; three-image RC bundle: `create-three-image-bundle-build-plan.mjs`, verifier and `.github/workflows/docker-images.yml` |
| Host policy        | `infrastructure/stage1-snapshot/wsl/**`, `infrastructure/stage1-snapshot/server/**`: WSL, LUKS, egress, sshd and loopback database endpoint configuration                                                         |
| Cloud policy       | `infrastructure/stage1-snapshot/aliyun/**`, `manage-snapshot-cloud-custody.mjs`, lineage custody adapters: OSS/KMS/RAM snapshot and evidence policies plus closed lifecycle operations                            |
| GitHub bootstrap   | `scripts/release/bootstrap-snapshot-environment.mjs`, `bootstrap-snapshot-launcher-app.mjs`, `bootstrap-aliyun-oidc-provider.mjs`, `manage-exact-run-capability.mjs` and tests                                    |
| Qualification      | Three distinct approvals; immutable raw v1 proof → one-to-one purpose claim/envelope → v2 custody/aggregate/exit; qualification remains permanently non-promotable                                                |
| Workflows          | `.github/workflows/sanitized-snapshot.yml`, `release-candidate-gate.yml`, `release-final-chain.yml`                                                                                                               |
| Capacity           | `release/contracts/schemas/capacity-plan.v1.schema.json`, `packages/release-foundation/src/capacity-plan.mjs`, `scripts/release/collect-capacity-plan.mjs`                                                        |
| Operations         | `docs/operations/stage1-s1-execution-infrastructure-runbook.md`, bootstrap/attempt evidence templates and failure matrix                                                                                          |

---

### Task 0: Freeze the implementation source and prove a controlled datasource

**Files:**

- No tracked files.
- Creates ignored local records only under `.release-local/`.

**Interfaces:**

- Consumes: clean latest main with all three revised documents matching independently signed actual approval content/blob records; old commits are history only.
- Produces: `.release-local/controlled-target.v1.json` and successful controlled PostgreSQL 17 migration-status evidence.
- Stop rule: no later task starts if the target cannot be created, existing migrations cannot be deployed, final migration status is not current, or Task 30 stash is missing.

- [ ] **Step 1: Create the isolated implementation worktree**

Run from the primary checkout after protecting local Dockerfile changes. Under the existing independent human trust anchor, verify actual review decisions/signatures/revocation for all three revised documents; preserve original records in protected encrypted provisional escrow and the verified non-secret index in `.release-local/input/s1-infrastructure-plan-approval.v1.json` as exactly three `documents` entries `{path,decision,approvedSourceCommit,blobOid,reviewRecordDigest}`. I0 custody does not exist yet and is not a Task0 prerequisite: escrow is not an authoritative 180-day receipt. I0 must import these exact original approval chains and complete independent private readback before I1. These records refer to existing reviewed content, never this plan's future commit or a fabricated approval SHA. Old ancestor presence alone does not approve the new crypto/custody design.

```powershell
git fetch origin main
$approvalPath = '.release-local/input/s1-infrastructure-plan-approval.v1.json'
$approval = Get-Content -LiteralPath $approvalPath -Raw | ConvertFrom-Json
$requiredPaths = @(
  'docs/superpowers/specs/2026-09-03-stage1-s1-execution-infrastructure-security-addendum.zh-CN.md',
  'docs/superpowers/plans/2026-09-03-stage1-s1-execution-infrastructure-implementation-plan.md',
  'docs/superpowers/plans/2026-09-02-stage1-s1-trusted-release-foundation-implementation-plan.md'
)
if (@($approval.documents).Count -ne 3) { throw 'THREE_DOCUMENT_APPROVALS_REQUIRED' }
foreach ($documentPath in $requiredPaths) {
  $records = @($approval.documents | Where-Object { $_.path -eq $documentPath })
  if ($records.Count -ne 1 -or $records[0].decision -ne 'APPROVED') { throw 'DOCUMENT_NOT_INDEPENDENTLY_APPROVED' }
  $documentApproval = $records[0]
  if ($documentApproval.approvedSourceCommit -notmatch '^[0-9a-f]{40,64}$' -or $documentApproval.blobOid -notmatch '^[0-9a-f]{40,64}$') { throw 'APPROVED_DOCUMENT_IDENTITY_INVALID' }
  git merge-base --is-ancestor $documentApproval.approvedSourceCommit origin/main
  if ($LASTEXITCODE -ne 0) { throw 'APPROVED_DOCUMENT_COMMIT_MISSING' }
  $reviewedBlob = git rev-parse "$($documentApproval.approvedSourceCommit):$documentPath"
  if ($LASTEXITCODE -ne 0) { throw 'REVIEWED_DOCUMENT_MISSING' }
  $mainBlob = git rev-parse "origin/main:$documentPath"
  if ($LASTEXITCODE -ne 0 -or $reviewedBlob -ne $documentApproval.blobOid -or $mainBlob -ne $reviewedBlob) { throw 'APPROVED_DOCUMENT_BLOB_MISMATCH' }
}
git worktree add D:\Projects\auto-subscription-platform\.worktrees\stage1-s1-execution-infrastructure-20260903 -b feat/stage1-s1-execution-infrastructure-20260903 origin/main
```

Expected: `origin/main` already contains the exact approved plan and addendum; the new worktree is created directly from that `main`. No documentation branch is merged into the implementation branch, and no existing checkout or Task 30 stash is modified.

- [ ] **Step 2: Verify repository and stash boundaries**

```powershell
Set-Location D:\Projects\auto-subscription-platform\.worktrees\stage1-s1-execution-infrastructure-20260903
git status --short --branch
git log -1 --oneline
git stash list
```

Expected: worktree clean; HEAD contains this plan; `paused-task30-before-task29r-20260903` still exists.

- [ ] **Step 3: Remove ambient database variables and create the controlled PostgreSQL 17 target**

```powershell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Get-ChildItem Env: | Where-Object Name -Match '^(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGSERVICE)$' | Remove-Item
node scripts/release/bootstrap-controlled-postgres.mjs --output .release-local/controlled-target.v1.json
```

Expected: the record identifies the digest-pinned PostgreSQL 17 image, exact container, database marker/OID, roles and `server_version_num`; no repository `.env` is read.

- [ ] **Step 4: Deploy the existing migration catalog through the controlled migration role**

```powershell
node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
```

Expected: PASS; this applies only existing repository migrations to the ephemeral target.

- [ ] **Step 5: Prove migration status and Schema validation through the same target**

```powershell
node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:validate
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:generate
```

Expected: `Database schema is up to date`; validate/generate pass. Record the target-record digest and command logs outside git.

- [ ] **Step 6: Record the preflight checkpoint without committing local secrets**

```powershell
git status --short
git check-ignore .release-local/controlled-target.v1.json .release-local/secrets/migrate.json
```

Expected: both local paths are ignored; tracked worktree remains clean. This checkpoint has no Git commit.

---

### Task 1: Verify the approved upstream-plan dependency and unique implementation ownership

**Files:**

- No tracked files.

**Interfaces:**

- Consumes: approved addendum content `75aaa956`/approval record and erratum `86663d98`, and upstream content `f50676c6`/metadata `30a90fae`.
- Produces: a read-only dependency-verification record proving that this plan is the sole Task 29R-D施工 owner and that the upstream plan remains unchanged.

- [ ] **Step 1: Verify the approved commits and exact upstream file identity**

```powershell
$upstreamPlan = 'docs/superpowers/plans/2026-09-02-stage1-s1-trusted-release-foundation-implementation-plan.md'
git merge-base --is-ancestor f50676c6 HEAD
if ($LASTEXITCODE -ne 0) { throw 'UPSTREAM_APPROVAL_BASELINE_MISSING' }
git diff --exit-code 30a90fae -- $upstreamPlan
if ($LASTEXITCODE -ne 0) { throw 'UPSTREAM_APPROVED_FILE_CHANGED' }
$approvedBody = ((git show "f50676c6:$upstreamPlan") -join "`n") -split '## Global Constraints', 2
$currentBody = (Get-Content -LiteralPath $upstreamPlan -Raw -Encoding utf8) -replace "`r`n", "`n"
$currentBody = $currentBody -split '## Global Constraints', 2
if ($approvedBody[1].TrimEnd() -cne $currentBody[1].TrimEnd()) { throw 'UPSTREAM_APPROVED_BODY_CHANGED' }
```

Expected: PASS; only the separately recorded `30a90fae` approval metadata differs from content baseline `f50676c6`; the approved body and current file identity are unchanged.

- [ ] **Step 2: Verify fixed topology, ownership handoff and Task 30 block**

```powershell
$upstreamText = Get-Content -LiteralPath $upstreamPlan -Raw -Encoding utf8
$gate = [regex]::Match($upstreamText, '(?s)### Task 29R-D:.*?(?=### Task 30:)').Value
if (-not $gate.Contains('owns no files, makes no commit')) { throw 'TASK29R_D_OWNER_HANDOFF_MISSING' }
if ($gate -match '(?m)^- (Create|Modify):|\bgit (add|commit)\b') { throw 'TASK29R_D_DUPLICATE_OWNERSHIP' }
foreach ($requiredText in @('exact-capability-approval.v2', 'lineage-oss-role', 'lineage-storage-access-receipt.v1', 'TASK_30_AUTHORIZATION_REQUIRED')) {
  if (-not $gate.Contains($requiredText)) { throw 'UPSTREAM_LINEAGE_GATE_MISSING' }
}
if (-not $upstreamText.Contains('**Status and authorization:** Blocked.')) { throw 'TASK30_BLOCK_MISSING' }
```

Expected: PASS; upstream plan delegates implementation to this plan, has zero Task 29R-D file/commit events, and still blocks Task 30.

- [ ] **Step 3: Prove this task produced no tracked change**

```powershell
git diff --exit-code -- $upstreamPlan
git status --short
```

Expected: no tracked change and no commit. Any upstream-plan change stops implementation and requires a separate plan revision/review.

---

### Task 2: Add routing, policy and producer-proof contracts

**Files:**

- Create: `release/contracts/schemas/environment-policy-identity.v1.schema.json`
- Create: `release/contracts/schemas/environment-policy-observation.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-admission.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-admission-verification.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-jit-launch-proof.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-producer-completion.v1.schema.json`
- Create: `release/contracts/schemas/producer-terminal-observation.v1.schema.json`
- Create: `release/contracts/schemas/rc-dispatch-authorization.v1.schema.json`
- Create: `release/contracts/schemas/infrastructure-change.v1.schema.json`
- Create: `release/contracts/schemas/external-change-approval.v1.schema.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `packages/release-foundation/src/schema-registry.mjs`
- Modify: `packages/release-foundation/src/index.mjs`
- Create: `packages/release-foundation/src/external-change-approval.mjs`
- Create: `packages/release-foundation/test/external-change-approval.test.mjs`
- Create: `packages/release-foundation/test/snapshot-routing-contracts.test.mjs`
- Create: `scripts/release/create-infrastructure-change.mjs`
- Create: `scripts/release/create-infrastructure-change.test.mjs`

**Interfaces:**

- Produces: the listed strict JSON Schemas registered in `validateContract(name, value)` and included in `repositoryContractDigest`, plus a closed infrastructure-change record generator deliberately distinct from a release attempt.
- Stable identity: `EnvironmentPolicyIdentityV1`; dynamic provenance: `EnvironmentPolicyObservationV1`.
- Producer proof order: verified dispatch authorization → admission/root verification → three independent data prerequisite/readback/approval chains (v1 JIT, v1 publisher, standalone crypto) → data Environment approval/observation → JIT launch → crypto use/process/session terminal → publisher use → encrypted object/destruction custody → separate custody prerequisite/readback/approval → custody Environment approval/observation → custody use → producer-completion. Only a later control-plane GitHub readback produces `producer-terminal-observation.v1`; completion cannot contain its own workflow/custody-job terminal state or that later observation digest. RC independently re-reads GitHub actual run/jobs before accepting the pair.

- [ ] Add RED cases `PRODUCER_COMPLETION_FUTURE_TERMINAL`, `PRODUCER_RUN_NOT_TERMINAL_SUCCESS`, mismatched actual job set/run attempt, skipped/cancelled/UNKNOWN data/custody, and caller-reported success without independent API readback. Terminal observation must bind completion digest, actual repository/run/attempt/workflow/source, all required job IDs/conclusions, API readback digest/time and external custody; no invented future job IDs.

- [ ] **Step 1: Write RED schema strictness tests**

```js
test("environment identity cannot contain observation time", () => {
  assert.throws(
    () => validateContract("environment-policy-identity.v1", { ...validIdentity, observedAt: NOW }),
    /additionalProperties/
  );
});

test("admission cannot reference a future observation", () => {
  assert.throws(
    () =>
      validateContract("snapshot-admission.v1", {
        ...validAdmission,
        environmentPolicyObservationDigest: DIGEST
      }),
    /additionalProperties/
  );
});
```

Run: `node --test packages/release-foundation/test/snapshot-routing-contracts.test.mjs`

Expected: FAIL because the Schemas are not registered.

- [ ] **Step 2: Define `environment-policy-identity.v1`**

Require exactly: schema version, immutable repository ID/name, environment ID/name, reviewer ID, exact branch/tag policy, bypass/self-review flags, actor ID, wait timer, workflow path/blob digest, action commit allowlist and canonicalization version. Reject timestamps, API payloads and approval records.

- [ ] **Step 3: Define `environment-policy-observation.v1`**

Require schema version/identity/observedAt/API-response/deployment/run/job/review identity and only the phase-appropriate actual queued/approved/running state and labels. A post-approval queued job does not require future terminal state. Producer terminal facts belong only to later `producer-terminal-observation.v1`. Enforce valid RFC3339 finite times and runAttempt1; reject cross-phase/future observations.

- [ ] **Step 4: Define admission, launch and completion Schemas**

`rc-dispatch-authorization.v1` is the run-before-run trust root: after trusted build/bundle and a new releaseAttemptId exist, bind purpose/attempt/fixed workflows/source/build/contracts/Adapter/issuer/validity/revocation, never future run IDs/completion/Manifest/command/plan. Admission inherits verified authorization and records actual Producer run/route/Adapter/Environment identity; root verification independently binds API/workflow facts and Ed25519 signature. JIT launch records actual assigned runner and fresh observation. `snapshot-producer-completion.v1` binds completed data/scan/encryption/private custody/destruction facts only; forbid GitHub workflow/current custody-job terminal or the later terminal-observation digest. The independent control-plane terminal observation is a separate subsequent fact.

- [ ] **Step 5: Define and generate the infrastructure change identity**

`infrastructure-change.v1` requires a random 128-bit lowercase hexadecimal `infrastructureChangeId`, exact merged main SHA, repository contract digest, `changeScope=execution-infrastructure-bootstrap`, `createdAt` and owner ID. `create-infrastructure-change.mjs --main-sha --owner-id --output` recomputes the repository contract digest from the registered manifest and generates the record once with `crypto.randomBytes(16)`, exclusive-create semantics and canonical JSON. It MUST NOT contain `executionPurpose`, `releaseAttemptId`, `snapshotRunId` or `rcWorkflowRunId`; those identities are allocated only after a trusted build/bundle exists in Infrastructure Task I16.

`external-change-approval.v1` is the independent approval for an infrastructure prerequisite mutation. It binds exactly one operation ID, bootstrap or release-attempt identity, target/resource kind, canonical plan digest, expected pre-state digest, approver immutable ID, issuance/expiry, revocation policy and custody reference. It cannot approve Environment deployment, issue a runtime credential or substitute for dispatch, exact-capability or database-command approval.

- [ ] **Step 6: Implement the trusted external-change approval verifier**

`verifyExternalChangeApproval` validates the protected issuer/signature/attestation, subject digest, immutable approver ID, current revocation artifact, expiry, operation/target/plan/pre-state bindings and custody readback before any credential lookup or external connection. Missing, inaccessible, stale, revoked or mismatched approval fails closed. The verifier never signs an approval and cannot treat a plan author or workflow actor as the approver.

- [ ] **Step 7: Register every Schema in the contract digest**

Update both `schema-registry.mjs` and `repository-contract-files.v1.json`; registry keys and filenames must be one-to-one.

- [ ] **Step 8: Run contract and digest tests**

```powershell
node --test packages/release-foundation/test/snapshot-routing-contracts.test.mjs packages/release-foundation/test/external-change-approval.test.mjs packages/release-foundation/test/schema-registry.test.mjs packages/release-foundation/test/catalogs.test.mjs scripts/release/create-infrastructure-change.test.mjs
pnpm release:contracts:verify
git diff --check
```

Expected: PASS; removing any new Schema from the contract-file manifest fails `release:contracts:verify`.

- [ ] **Step 9: Commit the routing contracts**

```powershell
git add release/contracts packages/release-foundation/src/schema-registry.mjs packages/release-foundation/src/index.mjs packages/release-foundation/src/external-change-approval.mjs packages/release-foundation/test/snapshot-routing-contracts.test.mjs packages/release-foundation/test/external-change-approval.test.mjs scripts/release/create-infrastructure-change.mjs scripts/release/create-infrastructure-change.test.mjs
git commit -m "build: define snapshot routing proof contracts"
```

---

### Task 3: Implement environment identity, observation and admission verification

**Files:**

- Create: `packages/release-foundation/src/snapshot/environment-policy.mjs`
- Create: `packages/release-foundation/src/snapshot/snapshot-admission.mjs`
- Create: `packages/release-foundation/src/snapshot/snapshot-admission-verification.mjs`
- Create: `packages/release-foundation/test/snapshot-environment-policy.test.mjs`
- Create: `packages/release-foundation/test/snapshot-admission.test.mjs`
- Create: `packages/release-foundation/test/snapshot-admission-verification.test.mjs`
- Modify: `packages/release-foundation/src/index.mjs`

**Interfaces:**

- Produces: `buildEnvironmentPolicyIdentity(input): EnvironmentPolicyIdentityV1`.
- Produces: `buildEnvironmentPolicyObservation(input): EnvironmentPolicyObservationV1`.
- Produces: `verifyPostApprovalObservation({ identity, observation, admission, now, maxAgeMs }): void`.
- Produces: `buildSnapshotAdmission({ dispatchAuthorization, producerRunObservation, rootPolicy }): SnapshotAdmissionV1` and `uniqueRouteLabel(runId, nonce): string`; purpose and attempt are inherited from verified authorization and cannot be supplied independently.
- Produces: `verifyAndSignSnapshotAdmission({ admission, githubObservations, rootPolicy, privateKeyFd }): SnapshotAdmissionVerificationV1`; only the root launcher calls it.

- [ ] **Step 1: Write RED identity/provenance tests**

```js
test("reading the same policy later does not drift identity", () => {
  const a = buildEnvironmentPolicyIdentity(apiPolicyAt("2026-09-03T00:00:00Z"));
  const b = buildEnvironmentPolicyIdentity(apiPolicyAt("2026-09-03T00:04:00Z"));
  assert.equal(sha256Canonical(a), sha256Canonical(b));
});

test("a five-minute-old post-approval observation is rejected", () => {
  assert.throws(
    () =>
      verifyPostApprovalObservation({
        ...fixture,
        now: "2026-09-03T00:05:00.001Z",
        maxAgeMs: 300000
      }),
    /ENVIRONMENT_OBSERVATION_EXPIRED/
  );
});
```

Run: `node --test packages/release-foundation/test/snapshot-environment-policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 2: Normalize only approved stable fields into identity**

The builder must hardcode repository/environment/actor invariants from a supplied root policy, sort action commits and branch rules, and reject environment `ABSENT`, tag rules, wildcard branches, bypass, an unexpected reviewer or a changed `prevent_self_review` value.

- [ ] **Step 3: Build observation after approval without mutating identity**

Observation records API response digest and approval provenance. `verifyPostApprovalObservation` recomputes the stable identity from the latest API response, compares `environmentPolicyIdentityDigest`, checks review/deployment/job fields and enforces `0 <= age <= 300000` milliseconds.

- [ ] **Step 4: Generate a 128-bit route nonce and exact five-label route**

```js
export function uniqueRouteLabel(runId, nonce) {
  if (!/^[1-9][0-9]*$/.test(String(runId)) || !/^[0-9a-f]{32}$/.test(nonce)) {
    throw coded("SNAPSHOT_ROUTE_IDENTITY_INVALID");
  }
  return `stage1-snapshot-export-${runId}-${nonce}`;
}
```

Admission rejects caller-supplied labels, a rerun attempt, non-main ref, unsupported event or a workflow digest absent from root policy.

- [ ] **Step 5: Implement independent root verification and signing**

Treat `snapshot-admission.v1` as untrusted input. Re-fetch the exact repository/run/job/artifact and workflow blob through the root launcher's GitHub App, recompute all digests/labels, verify the root policy and sign only the canonical verification object with a root-held Ed25519 key descriptor. The admission job cannot supply the verification object, signer identity or signature.

- [ ] **Step 6: Add all P1 negative cases**

Cover Environment 404/ID drift, missing reviewer, wrong branch, any tag rule, bypass, changed self-review setting, wrong actor, stale/missing observation, duplicate queued label, rerun attempt, workflow/action digest drift, admission containing observation provenance, admission self-signature, wrong root signer, GitHub API/artifact mismatch and attempted verification before the independent re-fetch.

- [ ] **Step 7: Run focused and repository contract tests**

```powershell
node --test packages/release-foundation/test/snapshot-environment-policy.test.mjs packages/release-foundation/test/snapshot-admission.test.mjs packages/release-foundation/test/snapshot-admission-verification.test.mjs
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
```

- [ ] **Step 8: Commit the policy kernel**

```powershell
git add packages/release-foundation/src/snapshot packages/release-foundation/src/index.mjs packages/release-foundation/test/snapshot-environment-policy.test.mjs packages/release-foundation/test/snapshot-admission.test.mjs packages/release-foundation/test/snapshot-admission-verification.test.mjs
git commit -m "build: verify snapshot environment and admission identity"
```

---

### Task 4: Define private snapshot and purpose-lineage custody contracts

**Files:**

- Create: `release/contracts/schemas/evidence-archive-authorization.v1.schema.json`
- Create: `release/contracts/schemas/evidence-archive-access-receipt.v1.schema.json`
- Create: `release/contracts/schemas/evidence-custody-bootstrap-readback.v1.schema.json`
- Create: `release/contracts/schemas/authoritative-custody-observation.v1.schema.json`
- Create: `release/contracts/schemas/prebuild-sanitized-input-binding.v1.schema.json`
- Create: `release/contracts/schemas/producer-crypto-run-authorization.v1.schema.json`
- Create: `release/contracts/schemas/producer-crypto-use-proof.v1.schema.json`
- Create: `packages/release-foundation/src/snapshot/producer-crypto-contracts.mjs`
- Create: `packages/release-foundation/test/producer-crypto-contracts.test.mjs`
- Create: `release/contracts/policies/snapshot-object-addressing.v2.json`
- Create: `packages/release-foundation/test/evidence-archive-contracts.test.mjs`

- Create: `release/contracts/schemas/snapshot-encryption-envelope.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-private-custody.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-destruction-receipt.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-retention-receipt.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-cloud-policy.v1.schema.json`
- Create: `release/contracts/snapshot-cloud-policy.v1.json`
- Create: `release/contracts/schemas/evidence-lineage-storage-policy.v1.schema.json`
- Create: `release/contracts/schemas/evidence-lineage-access-readback.v1.schema.json`
- Create: `release/contracts/schemas/evidence-lineage-retention-receipt.v1.schema.json`
- Create: `release/contracts/evidence-lineage-storage-policy.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `packages/release-foundation/src/schema-registry.mjs`
- Create: `packages/release-foundation/test/snapshot-custody-contracts.test.mjs`

**Interfaces:**

- `snapshot-encryption-envelope.v1` describes AES-256-GCM ciphertext, wrapped DEK, KMS parameters and authenticated-data digest; it never accepts a plaintext key.
- `snapshot-private-custody.v1` binds OSS bucket fingerprint, exact object key/version or ETag, ciphertext digest/size, WORM readback, access-policy digest and expiry.
- Destruction and retention receipts are distinct: the first proves local attempt-volume key invalidation; the second proves post-retention object/key-access disposition.
- `evidence-lineage-storage-policy.v1` fixes the private claim/object derivations and the exact eight-job matrix above. Runtime access requires forward `exact-capability-approval.v2`/`lineage-oss-role` and one writer or reader profile. Retention is a separate future disposition policy, not a third v2 runtime profile.
- `evidence-lineage-access-readback.v1` records prerequisite role/policy/ACL/WORM observations only. It is not a credential-use proof, object-content readback, or successful `lineage-storage-access-receipt.v1`; those later proofs are implemented by Tasks 13/16B.

- [ ] **Step 1: Write RED secret-exclusion and lifecycle tests**

```js
test("encryption envelope rejects plaintext key material", () => {
  assert.throws(
    () =>
      validateContract("snapshot-encryption-envelope.v1", {
        ...validEnvelope,
        plaintextDek: "secret"
      }),
    /additionalProperties/
  );
});

test("private custody expires no earlier than snapshot expiry plus 180 days", () => {
  assert.throws(
    () => validateSnapshotCustody(shortRetentionFixture),
    /SNAPSHOT_CUSTODY_RETENTION_TOO_SHORT/
  );
});
```

Run: `node --test packages/release-foundation/test/snapshot-custody-contracts.test.mjs`

Expected: FAIL because the contracts do not exist.

- [ ] **Step 2: Define the encryption envelope fields**

Require: `algorithm=AES-256-GCM`, unique 96-bit nonce, 128-bit tag, ciphertext SHA-256/size, `wrappedDek`, actual KMS key ID/alias readback, exact `kmsContext` and its digest, canonical GCM AAD digest, releaseAttemptId, snapshotRunId, source SHA, snapshot digest, sanitization-contract digest, exact slot-v2 key and expiry. `kmsContext` is frozen before data starts: repositoryId/sourceSha/releaseAttemptId/snapshotRunId/sanitizationContractDigest/expiresAt; expiry is actual Producer run allocation time plus 30 days, not an encryption-time guess. GCM AAD additionally binds actual snapshotDigest and kmsContextDigest. All dates must parse to finite instants; missing/NaN/negative intervals fail. All binary values are bounded base64; reject plaintext keys, secrets and arbitrary metadata.

- [ ] **Step 3: Define the cloud policy contract**

`snapshot-cloud-policy.v1.json` fixes region `oss-cn-shanghai`, bucket derivation version, versioning disabled, forbid-overwrite true, BucketWorm 210 days, KMS alias and the four unchanged snapshot-payload profiles: OSS-only `publisher`, `custody-reader`, `rc-consumer`, `retention`. A separate producer-crypto policy is owned by its standalone authorization, never a v1/v2 profile. `snapshot-object-addressing.v2.json` freezes the exact slot-v2 filename set. `evidence-lineage-storage-policy.v1.json` fixes `approvalSchemaVersion=exact-capability-approval.v2`, `lane=rc`, `capabilityKind=lineage-oss-role`, the eight-job/profile/Environment matrix and existing lineage key rules. Grant exact keys, never prefixes. Retention templates authorize no live role/session.

`evidence-archive-authorization.v1` is a separate control-plane contract for exactly one `archive-create-only-writer` or `archive-readback-reader`, fixed executor source/runtime/policy, already-frozen bytes/digests/exact keys, bucket/issuer/expiry/revocation and prior change/readback chain. Keys are `control-evidence/v1/<proof-type>/<canonical-digest>` with closed proof-type/filename derivation, never a prefix grant. It has no GitHub job/RC dispatch requirement and grants no KMS/DB/JIT/management/lineage permission. Management/writer/reader credentials are isolated and ordered. `evidence-archive-access-receipt.v1` records actual object/action/use/session-terminal facts; `authoritative-custody-observation.v1` records independently read original bytes/digest/version, object Last-Modified, GetBucketWorm ID/Locked/days, terminal-based required retention and enforceable retain-until. Task6 `archive-release-evidence.mjs` is their single implementation owner. All referenced original bytes enter this archive; later access/observation records are referenced downstream, never by their own subject.

`producer-crypto-contracts.mjs` defines strict schema and semantic authorization/use validation here, before Tasks6/7/9 consume it. It validates fixed producer/data/encryption phase, pre-existing context/key/prerequisite facts, independent issuer, <=900-second session and prohibited future/secret/v1/v2 fields; RED fixture tests precede implementation. Task13 owns only crypto authorization creation/resource CLI integration, not first definition of this dependency.

`prebuild-sanitized-input-binding.v1` freezes existing legal non-qualification input/source/sanitization/ciphertext/expiry/archive/independent-read-decrypt-use-authority facts and ciphertext/plaintext/restored-database byte upper bounds. It has no current attempt/Producer/build proof requirement; missing or invalid/NaN bounds, unavailable custody or missing authority fails. Task12 consumes this already-defined capacity input; Task17B implements its external-fact verifier without producing new input or authority.

- [ ] **Step 4: Define custody and disposition receipts**

Custody requires successful conditional create, actual Head/Get digest, private ACL and GetBucketWorm `Locked` readback. Enforceable retain-until is actual object Last-Modified plus locked WORM days, not now+180 or requested artifact retention. Require ordinary evidence >=operation terminal+180 days and snapshot-linked evidence >=snapshot expiry+180 days, extended for downstream/legal hold. A preterminal archive is provisional for the final bound; revalidate retention against independently observed terminal time before accepting final custody. Reject missing/invalid/NaN time, unsupported expiry or insufficient protection. WORM is bucket-wide; extension affects all objects and needs separate approval. Actions default30/max90 is short delivery only. Destruction receipt binds volume/mapper/key disposition/residual scan; later retention receipt binds exact key/version, custody, disposition, operator, policy and terminal readback.

- [ ] Add RED archive cases for Actions-only custody, `retention-days: 180` under public repository, fabricated now+180 receipt, unlocked/missing WORM, malformed time, incomplete referenced bytes, writer self-readback, combined identity, archive authorization offered as v1/v2, own-later-receipt reference, and expired snapshot input. Current workflow retention-180 and synthetic expiry behavior are remediation targets for Tasks 6/15/17B tests, not proof they are fixed.

Lineage prerequisite readback binds repository/run/attempt/job, profile/node, exact keys and expected digests, private namespace, Provider/role/trust/permission policy, actual ACL/WORM state, denied actions and observation time. Writer is limited to conditional create of those keys and cannot Head/Get/List/Delete/KMS; reader is limited to exact Head/Get and cannot Put/List/Delete/KMS. Neither role can access database/snapshot/JIT or another node. Real object versions, actions/results, session expiry and revocation belong to the later use/access proofs, not this prerequisite observation. Retention requires the latest whole-lineage/legal-hold boundary and separate approved disposition; no runtime retention role/session is provisioned.

Add contract negatives for v1 lineage authorization, wrong job/profile/node/Environment, wildcard keys,
wrong claim-key derivation, shortened claim/access retention, and a prerequisite observation offered
as successful content readback. These are deterministic contract tests, not cloud operations.

- [ ] **Step 5: Register all contracts and add semantic validators**

Add `validateSnapshotCustody`, `validateSnapshotDestructionReceipt`, `validateSnapshotRetentionReceipt`, `validateLineageStoragePolicy`, `validateLineageAccessReadback` and `validateLineageRetentionReceipt` to `packages/release-foundation/src/snapshot/custody-contracts.mjs`; register the file itself in Task 5 when created. At this step the test may define a local semantic validator fixture, but every JSON Schema must already enter `repository-contract-files.v1.json`.

- [ ] **Step 6: Run contract verification**

```powershell
node --test packages/release-foundation/test/snapshot-custody-contracts.test.mjs packages/release-foundation/test/schema-registry.test.mjs
pnpm release:contracts:verify
git diff --check
```

Expected: PASS; shortening WORM below 210 days or adding a plaintext field fails.

- [ ] **Step 7: Commit the custody contracts**

```powershell
git add release/contracts packages/release-foundation/src/schema-registry.mjs packages/release-foundation/src/snapshot/producer-crypto-contracts.mjs packages/release-foundation/test/snapshot-custody-contracts.test.mjs packages/release-foundation/test/evidence-archive-contracts.test.mjs packages/release-foundation/test/producer-crypto-contracts.test.mjs
git commit -m "build: define private snapshot custody contracts"
```

---

### Task 5: Implement streaming envelope encryption with an isolated crypto process

**Files:**

- Create: `packages/release-foundation/src/snapshot/envelope-crypto.mjs`
- Create: `packages/release-foundation/src/snapshot/custody-contracts.mjs`
- Create: `packages/release-foundation/test/snapshot-envelope-crypto.test.mjs`
- Modify: `packages/release-foundation/src/index.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Produces: `encryptSnapshotStream({ source, destination, aad, kms }): Promise<SnapshotEncryptionEnvelopeV1>`.
- Produces: `decryptSnapshotStream({ source, destination, envelope, kms }): Promise<void>`.
- Produces: `wipeKeyBuffer(buffer): void`; callers must still terminate the short-lived process.
- KMS interface: `generateDataKey({ keyAlias, keySpec, encryptionContext }): Promise<{ plaintext: Buffer; wrapped: KmsWrappedKeyV1 }>` and `decryptDataKey({ wrapped, encryptionContext }): Promise<Buffer>`.

- [ ] **Step 1: Write RED streaming and zeroization tests**

```js
test("producer clears the plaintext DEK after encryption", async () => {
  const plaintext = Buffer.alloc(32, 7);
  await encryptSnapshotStream({ ...fixture, kms: fakeKmsReturning(plaintext) });
  assert.deepEqual(plaintext, Buffer.alloc(32));
});

test("consumer refuses changed authenticated data", async () => {
  await assert.rejects(
    () => decryptSnapshotStream({ ...fixture, aad: { ...AAD, releaseAttemptId: "changed" } }),
    /SNAPSHOT_AAD_MISMATCH/
  );
});
```

Run: `node --test packages/release-foundation/test/snapshot-envelope-crypto.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 2: Implement deterministic authenticated data**

Freeze KMS context exactly `{ repositoryId, sourceSha, releaseAttemptId, snapshotRunId, sanitizationContractDigest, expiresAt }` from already-existing I17 facts (string values only). Separately canonicalize GCM AAD as that context plus `{ snapshotDigest, kmsContextDigest }` after scanning. Never put a future snapshot/ciphertext digest in a prerequisite/approval. Consumer validates both digests and uses the same context for KMS Decrypt. Reject changed run/context, alias drift and locally public-key-wrapped bytes presented to symmetric recovery.

- [ ] **Step 3: Implement streaming AES-256-GCM**

Use `createCipheriv("aes-256-gcm", dek, nonce, { authTagLength: 16 })` and pipeline streams; never call `readFile` for the dump. Write ciphertext to a newly created path with owner-only mode and reject an existing destination.

```js
const dek = await kms.generateDataKey(input);
try {
  await pipeline(source, cipher, destination);
  return freezeEnvelope(cipher, dek.wrapped, aad);
} finally {
  wipeKeyBuffer(dek.plaintext);
}
```

- [ ] **Step 4: Implement consumer decryption with the same memory boundary**

Unwrap only after envelope/AAD/ciphertext digest validation. Decrypt into a new owner-only path, verify the final snapshot digest, zero the DEK in `finally`, close streams, and return no key material.

- [ ] **Step 5: Prove key material cannot enter serialized output**

Add tests that recursively scan success/error/proof/log objects and child-process messages for plaintext DEK bytes, base64, hex, access key fields and raw KMS responses. Disable core dump in the later adapter process; this module only exposes zeroization and serialization guards.

- [ ] **Step 6: Run crypto and contract tests**

```powershell
node --test packages/release-foundation/test/snapshot-envelope-crypto.test.mjs packages/release-foundation/test/snapshot-custody-contracts.test.mjs
pnpm release:contracts:verify
git diff --check
```

- [ ] **Step 7: Commit the crypto kernel**

```powershell
git add packages/release-foundation/src/snapshot packages/release-foundation/src/index.mjs packages/release-foundation/test/snapshot-envelope-crypto.test.mjs release/contracts/repository-contract-files.v1.json
git commit -m "build: add isolated snapshot envelope crypto"
```

---

### Task 6: Add the Aliyun OSS/KMS/RAM custody adapter and exact policy generator

**Files:**

- Create: `apps/snapshot-adapter/package.json`
- Create: `apps/snapshot-adapter/src/cloud/aliyun-kms.mjs`
- Create: `apps/snapshot-adapter/src/cloud/aliyun-oss.mjs`
- Create: `apps/snapshot-adapter/src/cloud/aliyun-sts.mjs`
- Create: `apps/snapshot-adapter/src/cloud/aliyun-publisher-broker.mjs`
- Create: `apps/snapshot-adapter/src/cloud/aliyun-producer-crypto-broker.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-producer-crypto-broker.test.mjs`
- Create: `scripts/release/manage-evidence-custody-bootstrap.mjs`
- Create: `scripts/release/manage-evidence-custody-bootstrap.test.mjs`
- Create: `scripts/release/archive-release-evidence.mjs`
- Create: `scripts/release/archive-release-evidence.test.mjs`
- Modify: `scripts/release/workflow-custody-record.mjs`
- Modify: `scripts/release/workflow-custody-record.test.mjs`
- Modify: `scripts/release/custody-evidence.mjs`
- Modify: `scripts/release/custody-evidence.test.mjs`
- Modify: `packages/release-foundation/src/evidence-custody.mjs`
- Modify: `packages/release-foundation/test/evidence-custody.test.mjs`
- Create: `apps/snapshot-adapter/src/cloud/aliyun-lineage-custody.mjs`
- Create: `apps/snapshot-adapter/src/cloud/policy-generator.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-kms.test.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-oss.test.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-policy.test.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-publisher-broker.test.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-lineage-custody.test.mjs`
- Create: `infrastructure/stage1-snapshot/aliyun/snapshot-cloud-policy-input.v1.json`
- Create: `scripts/release/manage-snapshot-cloud-custody.mjs`
- Create: `scripts/release/manage-snapshot-cloud-custody.test.mjs`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Dependencies pin exactly `ali-oss@6.23.0`, `@alicloud/credentials@2.4.7`, `@alicloud/kms20160120@3.3.0` and `@alicloud/sts20150401@1.2.0`.
- Produces: `AliyunKmsDataKeyClient`, `AliyunOssWriteOncePublisher`, `AliyunOssExactReader`, `AliyunPublisherCredentialBroker`, `AliyunLineageCreateOnlyWriter`, `AliyunLineageExactReader`, `AliyunLineageRetentionOperator` and `buildAttemptRamPolicies(input)`.
- The adapter accepts credentials as open file descriptors or injected SDK credential objects in tests; it never discovers credentials from environment variables or user home files.

- [ ] **Step 1: Scaffold the package and write RED credential-discovery tests**

```js
test("cloud clients reject ambient Alibaba credentials", () => {
  assert.throws(
    () => createCloudClients({ environment: { ALIBABA_CLOUD_ACCESS_KEY_ID: "ambient" } }),
    /AMBIENT_CLOUD_CREDENTIAL_FORBIDDEN/
  );
});
```

Run: `pnpm --filter @subscription-saas/snapshot-adapter test`

Expected: FAIL because the package scripts or modules do not exist.

- [ ] **Step 2: Implement KMS `GenerateDataKey` and `Decrypt` wrappers**

Allow only actual key identity behind approved alias `alias/stage1-snapshot-custody`, `AES_256`, approved region/endpoint and pre-existing exact encryption context. Producer wrapper requires standalone crypto authorization/readback/observation and generate-only credential; no publisher credential is accepted. Disable automatic GenerateDataKey retries; uncertain response is UNKNOWN. Strip SDK secrets from errors. Plaintext is a mutable Buffer owned only by the isolated crypto child; consumer uses its distinct Decrypt identity.

- [ ] **Step 3: Implement conditional OSS publication**

`AliyunOssWriteOncePublisher.putExact` uses the deterministic object key and `x-oss-forbid-overwrite=true`; HTTP 409 is `SNAPSHOT_OBJECT_ALREADY_EXISTS`, never success. After upload, use an independently injected readback adapter in tests to verify ciphertext digest, size, private ACL and WORM state. Publisher methods for Get/List/Delete are absent.

- [ ] **Step 4: Implement exact-object consumer and retention adapters**

Reader only accepts the object key/digest/version from an attested custody record and cannot list prefixes. Retention adapter is a separate constructor and credential profile; it rejects objects whose retain-until or snapshot-expiry-plus-180-days time has not elapsed.

The lineage adapters accept only the Task 4 deterministic claim/object derivations and a frozen exact-key plan. `putExact({ key, bytes, expectedDigest })` verifies canonical-byte digest before sending `x-oss-forbid-overwrite=true`; an existing key is a conflict, never idempotent success. `readExact({ key, expectedVersion, expectedDigest })` performs Head/Get only for that approved object. Neither constructor discovers credentials or exposes another action family. Forward v2 approval/use validation is wired at Task 13/16B, not by extending snapshot v1 clients. Retention requires separate whole-lineage expiry/legal-hold and disposition approval, and is unavailable to RC constructors. Test exact-key denial and separate writer/reader credentials with injected clients only.

- [ ] **Step 5: Implement the root-only publisher credential broker**

The broker reads its assume-role-only principal from a root-opened descriptor, validates the approved exact role ARN/policy/readback/attempt binding, requests a 900-second STS session and writes the resulting publisher-only credential to a sealed child descriptor. The broker principal has no OSS/KMS permission, cannot assume custody/consumer/retention roles and never enters the Runner process, workflow environment, argv, disk or proof.

- [ ] **Step 6: Generate mutually exclusive RAM policies**

`buildAttemptRamPolicies` emits policy templates, not live roles: unchanged four snapshot profiles, separate generate-only crypto, and unchanged three lineage templates. Publisher permits only conditional OSS PutObject on the pre-existing slot-v2 exact-key set and denies every KMS data action. Crypto permits only GenerateDataKey on approved actual key/context, no OSS/Decrypt/Encrypt/AsymmetricDecrypt/JIT/management/role chaining. Custody permits exact ciphertext/proof Head/Get without Decrypt; RC consumer exact Get plus Decrypt; retention is separately approved later disposition. Lineage templates retain the frozen v2 matrix. Archive writer/reader are independently generated control-plane profiles, not snapshot/v2 additions. Reject namespace grants, combined profiles, ambient identities and future content digests. Preserve frozen v1/v2 golden tests.

Effective KMS readback includes actual key policy, all RAM attached/inline policies and narrowing session policy, not merely a newly generated role Allow. Explicitly deny forbidden actions across the effective authorization model; an independent key-policy grant must not restore them. Add RED hidden key-policy Decrypt/Encrypt/OSS grant, wider session and alias/key mismatch cases; no real permission probing is authorized by these contract tests.

- [ ] **Step 7: Implement the closed cloud-resource lifecycle CLI**

`manage-evidence-custody-bootstrap.mjs plan|apply|readback|reconcile` owns I0 signer/control-plane/private-bucket setup and separately approved bucket-wide WORM lock. `archive-release-evidence.mjs freeze|authorize|write|readback|reconcile` uses fixed approved source/runtime, never future Adapter/Runner/OIDC, and separate exact-key writer/reader processes. Initial approval relies on the existing human trust anchor and encrypted provisional escrow, not future bucket custody; I0 closes only after original approval/apply bytes are archived and independently read back. `manage-snapshot-cloud-custody.mjs --resource base-custody|retention-lock` owns only I5 existing-storage verification plus separately approved KMS/crypto/broker delta, and I6 read-only retention revalidation. It may not recreate/relock I0 storage. Future bucket-wide extension requires a new independent plan/approval. UNKNOWN reconciles exact resource identity and never repeats mutation or repairs failed lineage data attempts.

Archive access receipt records only actions/use/terminal and the matching authoritative-custody-observation digest; root signing makes it the operation checkpoint. The authoritative observation is the sole actual-byte/retention conclusion, not duplicated in a second receipt policy. Bootstrap readback closes I0 only through these already-produced facts, with no own-future-receipt reference.

- [ ] Test bootstrap without future custody, rejection of escrow as final custody, management/writer/reader isolation, exact original-byte archive/readback, post-write Last-Modified/WORM calculation and crypto-terminal-before-publisher. Run the new broker/bootstrap/archive tests with injected clients only. Include these named files in this task's `git add`/commit along with existing Task 6 files; no I0 operation occurs during repository tests.

Replace current `workflow-custody-record.mjs` synthetic retention and local-only custody assumptions through `custody-evidence.mjs` and shared `evidence-custody.mjs`: frozen raw v1 receipt bytes/schema remain immutable, but checkpoint acceptance requires the valid receipt together with matching `authoritative-custody-observation.v1`, actual privately read original bytes and operation terminal retention bound. Old synthetic receipt alone cannot pass. Task6 owns this base verifier; Task16B later adds its v2 lineage-specific acceptance without a competing implementation. RED injected readback cases reject local uploader, missing observation, mismatched digest/storage/object, now+180, missing/NaN terminal time and insufficient Locked-WORM bound.

- [ ] **Step 8: Prove exact OIDC subject generation**

```js
assert.equal(
  buildGithubOidcSubject(claims),
  "repository_id:1253231368:workflow_ref:keqi119/subscription-Saas/.github/workflows/release-candidate-gate.yml@refs/heads/main:workflow_sha:0123456789abcdef0123456789abcdef01234567:ref:refs/heads/main:environment:trusted-release-candidate:actor_id:275060624:run_id:33718518322:run_attempt:1:event_name:workflow_dispatch:runner_environment:github-hosted"
);
```

Use the exact `include_claim_keys` order above. A missing claim or wildcard subject fails before emitting policy.

- [ ] **Step 9: Run provider tests and lockfile verification**

```powershell
pnpm install --lockfile-only
pnpm --filter @subscription-saas/snapshot-adapter test
node --test scripts/release/manage-snapshot-cloud-custody.test.mjs
pnpm release:contracts:verify
git diff --check
```

- [ ] **Step 10: Commit the cloud provider adapter**

```powershell
git add apps/snapshot-adapter infrastructure/stage1-snapshot/aliyun scripts/release/manage-snapshot-cloud-custody.mjs scripts/release/manage-snapshot-cloud-custody.test.mjs scripts/release/manage-evidence-custody-bootstrap.mjs scripts/release/manage-evidence-custody-bootstrap.test.mjs scripts/release/archive-release-evidence.mjs scripts/release/archive-release-evidence.test.mjs scripts/release/workflow-custody-record.mjs scripts/release/workflow-custody-record.test.mjs scripts/release/custody-evidence.mjs scripts/release/custody-evidence.test.mjs packages/release-foundation/src/evidence-custody.mjs packages/release-foundation/test/evidence-custody.test.mjs pnpm-lock.yaml
git commit -m "build: add private snapshot cloud custody adapter"
```

---

### Task 7: Build the closed root-owned snapshot adapter bundle

**Files:**

- Create: `apps/snapshot-adapter/src/cli.mjs`
- Create: `apps/snapshot-adapter/src/snapshot-job.mjs`
- Create: `apps/snapshot-adapter/src/secret-fd.mjs`
- Create: `apps/snapshot-adapter/src/process-policy.mjs`
- Create: `apps/snapshot-adapter/test/cli.test.mjs`
- Create: `apps/snapshot-adapter/test/secret-fd.test.mjs`
- Create: `scripts/release/build-snapshot-adapter.mjs`
- Create: `scripts/release/verify-snapshot-adapter-bundle.mjs`
- Create: `scripts/release/snapshot-adapter-bundle.test.mjs`
- Create: `release/contracts/schemas/snapshot-adapter-build.v1.schema.json`
- Create: `release/contracts/snapshot-adapter-build.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `package.json`

**Interfaces:**

- Supported Runner-facing command is represented as argv `['launch', '--admission-ref', value]`; `value` must match `^https://api\.github\.com/repos/keqi119/subscription-Saas/actions/artifacts/[1-9][0-9]*$` and is supplied by the trusted root launcher from the protected admission descriptor. No other Runner-facing subcommand exists.
- Admin-facing installer/launcher paths are root-only and cannot be invoked by the Runner user. The only qualification form is the fixed `snapshot-job qualify --suite closed-security-rehearsal-v1 --request-fd 3`; policy rejects every other suite, path or argument and the production JIT route never invokes it.
- Build output: `.release-output/snapshot-adapter/snapshot-adapter-v1.tar.zst` plus canonical file/digest/ownership manifest.

- [ ] **Step 1: Write RED CLI grammar tests**

Test rejection of arbitrary script path, SQL path, database URL, SSH host, output path, extra argument, stdin data, `--help` execution escape, shell metacharacters and environment credentials. Separately prove that the root qualification form accepts only the single registered suite and cannot be selected from a Runner-facing launch descriptor.

```js
for (const argv of [
  ["node", "evil.mjs"],
  ["launch", "--sql", "x.sql"],
  ["launch", "--admission-ref", GOOD, "--shell"]
]) {
  assert.throws(() => parseSnapshotJobArgv(argv), /SNAPSHOT_JOB_CLI_FORBIDDEN/);
}
```

- [ ] **Step 2: Read secret material only from inherited root-opened descriptors**

`readSecretFd(name, fd)` validates `fstat`: regular or sealed memfd, owned by root, mode no broader than `0400`, no symlink/path lookup, bounded JSON length, expected secret reference and releaseAttemptId. Close the descriptor after parsing and overwrite the Buffer.

- [ ] **Step 3: Isolate crypto in a short-lived subprocess**

Spawn the fixed crypto module by absolute adapter path with only data descriptors and the separately issued generate-only credential FD. No plaintext DEK crosses IPC or a descriptor. Set core size zero and verify limits. Child messages contain envelope/proof data only; scan output, clear key buffers, exit and verify session revoke/definite expiry before starting publisher child or issuing publisher STS. Root orchestration holds neither child data credential; the independent crypto broker cannot assume publisher/custody/consumer roles. Add RED missing-terminal, simultaneous-credential, secret-message and repeated-GenerateDataKey cases.

- [ ] **Step 4: Implement a fixed snapshot pipeline**

The job resolves admission/root policy/secret references internally, opens the SSH tunnel, asserts the source role, holds one `REPEATABLE READ READ ONLY` transaction, exports raw rows into the LUKS mount, restores a temporary PostgreSQL 17 database, transforms/scans, encrypts, publishes to OSS, writes narrow proof, closes the source transaction and emits no user-selected paths.

- [ ] **Step 5: Build a dependency-closed install bundle**

Use `pnpm --filter @subscription-saas/snapshot-adapter deploy --prod` into a clean staging directory. Vendor the official Linux x64 Node.js 22.23.2 runtime after verifying its signed `SHASUMS256` material, record the archive and signing-material digests in `snapshot-adapter-build.v1`, and invoke that private runtime by an absolute adapter path. Do not depend on a system Node/package manager. Manifest every file path, mode, owner expectation and SHA-256, then archive deterministically; reject symlinks, setuid files, package lifecycle hooks and undeclared executable files.

- [ ] **Step 6: Add bundle tamper and negative-capability tests**

Verify a changed byte, writable parent directory, extra executable, missing dependency, wrong Node version or unknown CLI command fails. The test also asserts the bundle contains no repository `.git`, `.env`, test data, raw snapshot or package-manager binary.

- [ ] **Step 7: Run package, bundle and contract gates**

```powershell
pnpm --filter @subscription-saas/snapshot-adapter test
node --test scripts/release/snapshot-adapter-bundle.test.mjs
node scripts/release/build-snapshot-adapter.mjs --output .release-output/snapshot-adapter
node scripts/release/verify-snapshot-adapter-bundle.mjs --manifest .release-output/snapshot-adapter/snapshot-adapter-build.v1.json --archive .release-output/snapshot-adapter/snapshot-adapter-v1.tar.zst
pnpm release:contracts:verify
git diff --check
```

- [ ] **Step 8: Commit the closed adapter bundle source**

```powershell
git add apps/snapshot-adapter scripts/release/build-snapshot-adapter.mjs scripts/release/verify-snapshot-adapter-bundle.mjs scripts/release/snapshot-adapter-bundle.test.mjs release/contracts package.json pnpm-lock.yaml
git commit -m "build: package the closed snapshot adapter"
```

---

### Task 8: Define the dedicated WSL host, LUKS and egress policy as code

**Files:**

- Create: `release/contracts/schemas/snapshot-host-policy.v1.schema.json`
- Create: `infrastructure/stage1-snapshot/wsl/wsl.conf`
- Create: `infrastructure/stage1-snapshot/wsl/wslconfig.stage1`
- Create: `infrastructure/stage1-snapshot/wsl/snapshot-egress-policy.v1.json`
- Create: `infrastructure/stage1-snapshot/wsl/configure-distro.sh`
- Create: `infrastructure/stage1-snapshot/wsl/install-adapter.sh`
- Create: `infrastructure/stage1-snapshot/wsl/create-attempt-volume.sh`
- Create: `infrastructure/stage1-snapshot/wsl/destroy-attempt-volume.sh`
- Create: `infrastructure/stage1-snapshot/wsl/snapshot-launcher@.service`
- Create: `infrastructure/stage1-snapshot/wsl/audit-host.ps1`
- Create: `scripts/release/manage-snapshot-wsl-host.mjs`
- Create: `scripts/release/manage-snapshot-wsl-host.test.mjs`
- Create: `scripts/release/snapshot-host-policy.test.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- `snapshot-host-policy.v1` fixes distro/base-rootfs digest, runner user/group, adapter paths, WSL settings, runner binary digest, egress policy digest, LUKS parameters and prohibited host capabilities.
- `create-attempt-volume.sh` accepts only a validated releaseAttemptId through a root-only file descriptor and prints a non-secret mount receipt.
- `destroy-attempt-volume.sh` consumes the exact creation receipt and emits `snapshot-destruction-receipt.v1`; it never accepts a glob or arbitrary path.

- [ ] **Step 1: Write RED static host-policy tests**

```js
test("WSL policy disables host integration and swap", async () => {
  assert.match(wslConf, /\[interop\][\s\S]*enabled=false/);
  assert.match(wslConf, /\[automount\][\s\S]*enabled=false/);
  assert.match(wslConfig, /swap=0/);
});
```

Also reject `sudo`, Docker socket/group, Windows mounts, mutable runner versions, auto-update, unpinned base rootfs and writable `/opt/subscription-saas`.

Run: `node --test scripts/release/snapshot-host-policy.test.mjs`

Expected: FAIL because the policy files do not exist.

- [ ] **Step 2: Pin the Ubuntu 24.04 WSL rootfs and GitHub Runner binary**

`configure-distro.sh --plan` queries only official Ubuntu/GitHub release endpoints, records resolved download URL and SHA-256 in a generated external host-policy candidate, and refuses prerelease/unsupported Runner versions. An operator reviews and signs the exact candidate before install; no mutable `latest` URL survives in root policy.

- [ ] **Step 3: Disable WSL integration and unsafe persistence**

The committed configuration sets `interop.enabled=false`, `interop.appendWindowsPath=false`, `automount.enabled=false`, `automount.mountFsTab=false`, systemd enabled and WSL2 swap size zero. `audit-host.ps1` verifies the dedicated distro is not Docker Desktop or a daily-development distro and checks Windows hibernation/pagefile/crash-dump/device-encryption facts required by the addendum.

- [ ] **Step 4: Create exact LUKS2 lifecycle scripts**

The create script allocates one backing file, formats LUKS2 with an attempt-only random key read from root memory, opens exactly `subscription-s1-${releaseAttemptId}`, creates ext4 and mounts under `/run/subscription-saas/attempts/${releaseAttemptId}`. The destroy script stops PostgreSQL/processes, unmounts, closes the mapper, invalidates the key and confirms no mount/mapper remains before emitting a receipt.

- [ ] **Step 5: Enforce a domain-aware egress allowlist**

The policy permits TCP 443 only to current GitHub Actions required domains obtained from the GitHub Meta API and pinned by digest for the attempt, Aliyun OSS/KMS/STS endpoints in the selected region, and the approved external log endpoint; SSH is limited to the frozen Staging host fingerprint/address. A weekly policy review can update the root policy only outside a running attempt. DNS/API failure fails closed.

- [ ] **Step 6: Define the one-shot systemd unit**

The unit runs under root only for registration/cleanup orchestration, sets `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `LimitCORE=0`, a bounded timeout and explicit writable paths. The runner subprocess drops to the non-privileged `stage1snapshot` user and never receives root credentials or `/etc` access.

- [ ] **Step 7: Add a closed host plan/apply/readback interface**

`manage-snapshot-wsl-host.mjs` exposes `plan`, `apply`, `readback` and `reconcile` for exactly one `--resource distro|admission-signer|adapter-install`. Each resource uses a separate operation ID and approval. `distro` creates only the dedicated WSL boundary; `admission-signer` creates a non-exportable root-held Ed25519 key and records only its public-key digest; `adapter-install` accepts only the attested OCI digest/custody proof produced by Task 17A. Apply is delegated to the root-owned fixed scripts through a protected descriptor. UNKNOWN state requires readback/reconcile and never permits blind uninstall/reinstall.

- [ ] **Step 8: Run static and contract gates**

```powershell
node --test scripts/release/snapshot-host-policy.test.mjs
node --test scripts/release/manage-snapshot-wsl-host.test.mjs
pnpm release:contracts:verify
git diff --check
```

- [ ] **Step 9: Commit host policy as code**

```powershell
git add infrastructure/stage1-snapshot/wsl release/contracts scripts/release/snapshot-host-policy.test.mjs scripts/release/manage-snapshot-wsl-host.mjs scripts/release/manage-snapshot-wsl-host.test.mjs
git commit -m "build: define isolated snapshot WSL host policy"
```

---

### Task 9: Implement the trusted GitHub JIT launcher and exclusive route verifier

**Files:**

- Create: `apps/snapshot-adapter/src/github/github-api.mjs`
- Create: `apps/snapshot-adapter/src/github/workflow-policy.mjs`
- Create: `apps/snapshot-adapter/src/github/jit-runner.mjs`
- Create: `apps/snapshot-adapter/src/root-launcher.mjs`
- Create: `apps/snapshot-adapter/test/workflow-policy.test.mjs`
- Create: `apps/snapshot-adapter/test/jit-runner.test.mjs`
- Create: `release/contracts/schemas/snapshot-github-app-policy.v1.schema.json`
- Create: `infrastructure/stage1-snapshot/github/snapshot-launcher-app-policy.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- `verifyQueuedSnapshotJob({ run, jobs, admission, identity, observation }): VerifiedSnapshotJob`.
- `generateJitConfig({ repositoryId, verifiedJob, labels, githubAppToken }): JitConfig`.
- `runOneShotRunner({ jitConfigFd, runnerBinary, expectedDigest }): Promise<RunnerTerminalObservation>`.
- Root launcher accepts only a decimal `snapshotRunId`; label, nonce, workflow path, SHA and job ID come from the independently verified root-signed admission/GitHub API, never from an admission self-attestation.

- [ ] **Step 1: Write RED public-repository route tests**

Cover PR/fork/`pull_request_target`/comment/schedule/repository-dispatch/tag/non-main/rerun, two matching queued jobs, stale admission, wrong workflow blob/action SHA, missing environment approval, bypass review, unexpected label, already-consumed releaseAttemptId and API timeout.

```js
assert.throws(
  () => verifyQueuedSnapshotJob({ ...fixture, jobs: [matchingJob, { ...matchingJob, id: 2 }] }),
  /SNAPSHOT_ROUTE_NOT_EXCLUSIVE/
);
```

- [ ] **Step 2: Fetch and verify workflow content independently**

The root launcher downloads the admission artifact, run/job metadata and workflow blob for the exact source SHA through the GitHub API, computes SHA-256, parses `uses` commit pins and compares them against root policy. It then emits the Ed25519-signed `snapshot-admission-verification.v1`; it does not trust workflow outputs, a local checkout, GitHub OIDC/attestation from the admission job or a caller-provided digest.

- [ ] **Step 3: Re-read the protected Environment after approval**

Fetch Environment/deployment/review/run/job state, recompute identity and require observation age <=300 seconds. Revalidate separate v1 publisher/JIT approvals and standalone crypto authorization with all three prerequisite readbacks; then verify exact five labels and one queued job before JIT configuration. A crypto authorization can never satisfy either frozen v1 approval.

- [ ] **Step 4: Generate one-use JIT configuration**

Use a root-held GitHub App private key to obtain a short-lived installation token with only repository Administration write, Actions read, Contents read, Deployments read and Metadata read. Request repository JIT config for the five exact labels, disable updates and pass the config to the Runner through a root-only descriptor; neither token nor config reaches job environment/workspace/logs.

- [ ] **Step 5: Prove terminal cleanup**

After one job, cancellation, timeout or signal, capture redacted `_diag` logs to external custody, verify the Runner is no longer routable through GitHub API, delete it if necessary, destroy the attempt volume and terminate the disposable layer. API/job terminal mismatch becomes `INTERRUPTED_UNKNOWN`.

- [ ] **Step 6: Test secret and override rejection**

Assert no supported entrypoint accepts runner name, label, registration token, command override, service mode or second job. Verify GitHub App keys/tokens/JIT config never appear in serialized proofs or child environment.

- [ ] **Step 7: Run adapter and contract tests**

```powershell
pnpm --filter @subscription-saas/snapshot-adapter test
pnpm release:contracts:verify
git diff --check
```

- [ ] **Step 8: Commit the JIT launcher**

```powershell
git add apps/snapshot-adapter infrastructure/stage1-snapshot/github release/contracts
git commit -m "build: enforce exclusive snapshot JIT routing"
```

---

### Task 10: Define and verify the restricted SSH and Staging database source identity

**Files:**

- Create: `release/contracts/schemas/snapshot-target-policy.v1.schema.json`
- Create: `infrastructure/stage1-snapshot/server/sshd-stage1-snapshot.conf`
- Create: `infrastructure/stage1-snapshot/server/stage1-snapshot-reader.sql`
- Create: `infrastructure/stage1-snapshot/server/verify-stage1-snapshot-reader.sql`
- Create: `infrastructure/stage1-snapshot/server/staging-loopback-endpoint.compose.yml`
- Create: `apps/snapshot-adapter/src/source/target-policy.mjs`
- Create: `apps/snapshot-adapter/src/source/ssh-tunnel.mjs`
- Create: `apps/snapshot-adapter/src/source/postgres-privileges.mjs`
- Create: `apps/snapshot-adapter/test/source-boundary.test.mjs`
- Create: `apps/snapshot-adapter/test/source-boundary.postgres.test.mjs`
- Create: `scripts/release/provision-snapshot-source-test-target.mjs`
- Create: `scripts/release/provision-snapshot-source-test-target.test.mjs`
- Create: `scripts/release/run-snapshot-reader-postgres-test.mjs`
- Create: `scripts/release/run-snapshot-reader-postgres-test.test.mjs`
- Create: `scripts/release/verify-snapshot-source-test-target.mjs`
- Create: `scripts/release/verify-snapshot-source-test-target.test.mjs`
- Create: `scripts/release/manage-staging-snapshot-boundary.mjs`
- Create: `scripts/release/manage-staging-snapshot-boundary.test.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/database-test-manifest.v1.json`

**Interfaces:**

- `SnapshotTargetPolicyV1` stores only non-secret exact fingerprints: SSH host key, approved source address, loopback endpoint, database name/OID, TLS policy, role name/OID and expected privilege digest.
- `verifyEffectiveReadOnly(session): Promise<SourcePrivilegeObservationV1>` performs positive SELECT plus negative DML/DDL/ownership/role/RLS checks inside rolled-back probes.
- `openSnapshotTunnel(policy, keyFd): Promise<{ localPort, close, observation }>` selects a random loopback client port but only forwards to policy-fixed `127.0.0.1:55432`.

- [ ] **Step 1: Write RED config and privilege tests**

The static test requires `AllowTcpForwarding local`, exact `PermitOpen 127.0.0.1:55432`, no PTY/agent/X11/tunnel/gateway, no remote command and `MaxSessions 0`. PostgreSQL tests create the planned role on the controlled target and assert it cannot write, create/drop Schema, own objects, `SET ROLE`, bypass RLS or invoke write-capable functions.

- [ ] **Step 2: Add a fixed Staging loopback endpoint**

The compose fragment publishes the Staging PostgreSQL container only as `127.0.0.1:55432:5432`, never `0.0.0.0`. Its verifier checks the actual Docker publish address/network/project and rejects a production container or unknown compose project.

- [ ] **Step 3: Define the SSH account boundary**

Use user `stage1_snapshot_tunnel` with no interactive shell, no sudo/group access and a dedicated Ed25519 public key. `authorized_keys` must contain `restrict,port-forwarding,permitopen="127.0.0.1:55432",no-agent-forwarding,no-X11-forwarding,no-pty`; sshd Match rules deny remote/dynamic forwarding and all other destinations.

- [ ] **Step 4: Define the PostgreSQL role without a business migration**

The SQL is an operator-run infrastructure script: create `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 1`, set `default_transaction_read_only=on`, fixed timeouts and safe search path, grant CONNECT/USAGE/SELECT only. It records grants in external proof and never enters Prisma migration history.

- [ ] **Step 5: Implement effective privilege verification**

Check role attributes/memberships/ownership, database/Schema/table/sequence/function/large-object privileges, PUBLIC-derived capabilities and RLS visibility. Explicit negative statements must fail with read-only/permission errors; unexpected success is `SNAPSHOT_SOURCE_EFFECTIVE_WRITE_CAPABILITY`.

- [ ] **Step 6: Implement the closed Staging boundary lifecycle CLI**

`manage-staging-snapshot-boundary.mjs` exposes only `plan`, `apply`, `readback` and `reconcile`, with exactly one `--resource loopback-endpoint|ssh-account|database-reader`. Each resource has its own operation ID, human approval, credential descriptor and evidence directory. The CLI validates the server/database identity before reading the capability credential, applies only the fixed committed configuration/SQL, and writes a post-apply proof. UNKNOWN must reconcile exact Docker publish state, account/key fingerprint or PostgreSQL role/grant OIDs; it may not repeat apply or combine server root and database administrator credentials.

- [ ] **Step 7: Provision the test target with isolated identities**

`provision-snapshot-source-test-target.mjs` launches three non-overlapping child processes: the existing bootstrap/provisioner creates the ephemeral database/roles, the migration profile owns/applies Schema-only DDL and exits, then the runtime-test profile performs seed/reset DML and exits. No child receives another profile's secret, and the resulting test descriptor contains only references/digests.

- [ ] **Step 8: Run tests without a migration credential**

```powershell
node --test scripts/release/provision-snapshot-source-test-target.test.mjs scripts/release/run-snapshot-reader-postgres-test.test.mjs scripts/release/verify-snapshot-source-test-target.test.mjs
node --test scripts/release/manage-staging-snapshot-boundary.test.mjs
node scripts/release/provision-snapshot-source-test-target.mjs --record .release-local/controlled-target.v1.json --output .release-local/snapshot-source-test-target.v1.json
node scripts/release/with-controlled-target.mjs --profile runtime-test -- pnpm --filter @subscription-saas/snapshot-adapter test
node scripts/release/run-snapshot-reader-postgres-test.mjs --target .release-local/snapshot-source-test-target.v1.json --test apps/snapshot-adapter/test/source-boundary.postgres.test.mjs
node scripts/release/with-controlled-target.mjs --profile verify -- node scripts/release/verify-snapshot-source-test-target.mjs --target .release-local/snapshot-source-test-target.v1.json
node scripts/release/discover-database-tests.mjs --mode verify
pnpm release:contracts:verify
git diff --check
```

Expected: migration credentials are revoked before tests begin; runtime-equivalent and snapshot-reader processes read approved objects but every write/owner/elevation probe fails. Administrator/catalog readback runs as a separate verify process. Statement/process logs prove no test process received provisioner or migration credentials.

- [ ] **Step 9: Add credential-separation negative tests**

Reject combined secret descriptors, migration credential inherited by a test child, runtime-test role becoming owner, snapshot-reader role running seed/reset, provisioner surviving test setup and catalog readback executed by the test process.

- [ ] **Step 10: Commit the source boundary**

```powershell
git add infrastructure/stage1-snapshot/server apps/snapshot-adapter scripts/release/provision-snapshot-source-test-target.mjs scripts/release/provision-snapshot-source-test-target.test.mjs scripts/release/run-snapshot-reader-postgres-test.mjs scripts/release/run-snapshot-reader-postgres-test.test.mjs scripts/release/verify-snapshot-source-test-target.mjs scripts/release/verify-snapshot-source-test-target.test.mjs scripts/release/manage-staging-snapshot-boundary.mjs scripts/release/manage-staging-snapshot-boundary.test.mjs release/contracts
git commit -m "build: define read only staging snapshot boundary"
```

---

### Task 11: Correct snapshot transaction semantics and prove PostgreSQL 17 MVCC behavior

**Files:**

- Modify: `packages/release-foundation/src/snapshot/export-sanitized.mjs`
- Modify: `packages/release-foundation/src/snapshot/source-readonly-guard.mjs`
- Modify: `packages/release-foundation/test/snapshot-export.test.mjs`
- Modify: `packages/release-foundation/test/snapshot-source-readonly-guard.test.mjs`
- Create: `packages/release-foundation/test/snapshot-mvcc.postgres.test.mjs`
- Modify: `release/contracts/database-test-manifest.v1.json`

**Interfaces:**

- `assertReadOnlySnapshotSource` returns actual `transactionIsolation`, `transactionReadOnly` and exported snapshot ID; it must not require `transaction_deferrable=on`.
- `attachExportedSnapshot(session, snapshotId)` starts `REPEATABLE READ READ ONLY` and executes `SET TRANSACTION SNAPSHOT` before any read.
- Test barrier coordinates exporter, attached reader and concurrent writer deterministically without depending on one test worker.

- [ ] **Step 1: Change the existing unit test to RED on `DEFERRABLE`**

```js
assert.deepEqual(snapshot.transaction, {
  isolationLevel: "REPEATABLE READ",
  readOnly: true
});
assert.equal("deferrable" in snapshot.transaction, false);
```

Run: `node --test packages/release-foundation/test/snapshot-export.test.mjs packages/release-foundation/test/snapshot-source-readonly-guard.test.mjs`

Expected: FAIL because the implementation still requires `deferrable === true`.

- [ ] **Step 2: Remove the ineffective requirement**

Start transactions with `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`; query and record `SHOW transaction_isolation` and `SHOW transaction_read_only`; reject any attempt to add `DEFERRABLE` or change to `READ COMMITTED`/read-write.

- [ ] **Step 3: Add a real exported-snapshot barrier test**

Use three independent connections on the controlled PostgreSQL 17 database:

1. exporter begins read-only repeatable-read and calls `pg_export_snapshot()`;
2. reader begins the same isolation and attaches the snapshot before its first query;
3. writer commits an update after both initial fingerprints;
4. exporter and reader recompute the fingerprint and must retain the pre-write value;
5. a new read-committed observer must see the committed write.

- [ ] **Step 4: Add negative integration cases**

Reject invalid/changed snapshot ID, attach after a query, read-write transaction, wrong database identity and code that checks `transaction_deferrable=on`. Record actual `server_version_num=170000` family and pinned image digest.

- [ ] **Step 5: Register the test in the discovery universe**

Mark `snapshot-mvcc.postgres.test.mjs` applicable to both `fresh` and `snapshot`; it cannot be skipped or filtered due to missing Staging credentials because it runs on the controlled temporary database.

- [ ] **Step 6: Run RED/GREEN and release discovery gates**

```powershell
node scripts/release/with-controlled-target.mjs --profile runtime-test -- node --test packages/release-foundation/test/snapshot-mvcc.postgres.test.mjs
node --test packages/release-foundation/test/snapshot-export.test.mjs packages/release-foundation/test/snapshot-source-readonly-guard.test.mjs
node scripts/release/discover-database-tests.mjs --mode verify
pnpm release:contracts:verify
git diff --check
```

- [ ] **Step 7: Commit the MVCC correction alone**

```powershell
git add packages/release-foundation/src/snapshot packages/release-foundation/test release/contracts/database-test-manifest.v1.json
git commit -m "fix(release): use valid snapshot MVCC semantics"
```

---

### Task 12: Add a deterministic capacity plan and GitHub-hosted runner provenance

**Files:**

- Create: `release/contracts/schemas/capacity-plan.v1.schema.json`
- Create: `release/contracts/schemas/runner-provenance.v1.schema.json`
- Create: `packages/release-foundation/src/capacity-plan.mjs`
- Create: `packages/release-foundation/src/runner-provenance.mjs`
- Create: `packages/release-foundation/test/capacity-plan.test.mjs`
- Create: `packages/release-foundation/test/runner-provenance.test.mjs`
- Create: `scripts/release/collect-capacity-plan.mjs`
- Create: `scripts/release/collect-capacity-plan.test.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `package.json`

**Interfaces:**

- `calculateCapacityPlan(input): CapacityPlanV1` uses byte integers and returns every component, the safety reserve, the required upper bound and a machine-readable admission result.
- Preserve any published raw capacity v1 schema/bytes; the closed phase/input-policy validator and attached observation express bindings the raw schema cannot carry. Never widen raw v1 to fit a new prebuild field; checkpoint verifies raw arithmetic together with phase/input observation.
- `collectRunnerProvenance(): RunnerProvenanceV1` records the exact runner image release, kernel, architecture, CPU, memory, filesystem, Docker data root, Docker Engine, Buildx and Compose versions.
- CLI is a closed `--phase prebuild-source|rc-source|final` union with `--chain fresh|snapshot`. Prebuild takes `--input-binding` and fixed source-tool/PostgreSQL image digest/size inputs, forbidding future bundle/current-Producer proof. RC-source/final take existing bundle/registry plan and current Producer completion for snapshot. Fresh sets snapshot terms zero but retains its verified restored-database/tooling bounds. All inputs are evidence references; no caller-selected phase may widen workflow policy.

- [ ] **Step 1: Write RED arithmetic and input-validation tests**

Cover integer overflow, missing relevant image/layer/uncompressed/tool estimates, missing ciphertext/plaintext/restored bounds, negative/NaN values, unsupported filesystem and output outside evidence directory. Add RED prebuild demanding/accepting future bundle/Producer, RC consuming prebuild binding, cross-phase fields and absent legal input/authority. Fixed workflow derives phase; unknown or mixed variants fail.

- [ ] **Step 2: Implement the fixed capacity equation**

For each chain calculate:

```text
requiredUpperBound = imageCompressedBytes
                   + imageExpandedUpperBoundBytes
                   + snapshotCiphertextBytes
                   + snapshotPlaintextUpperBoundBytes
                   + restoredDatabaseUpperBoundBytes
                   + dependencyAndBuildUpperBoundBytes
                   + temporaryAndEvidenceUpperBoundBytes
safetyReserve = max(3 GiB, floor(totalDiskBytes * 0.20))
admitted = requiredUpperBound + safetyReserve <= availableDiskBytes
```

Equation and reserve are identical across phases. Fresh zeroes snapshot terms but still supplies restore bounds. `prebuild-source` uses only legal input-binding bounds plus fixed PostgreSQL/source-tool image and dependency estimates; no future bundle/Producer fact. `rc-source|final` uses already-existing bundle/current Producer/sanitization bounds. No values are guessed from free disk or replaced with zero when unknown.

- [ ] **Step 3: Collect actual capacity without deleting data**

Read df/Docker storage and registry-reported manifests for the phase's fixed image set. Prebuild reads fixed PostgreSQL/source-tool digests and Task4 input-binding, never a future build proof; RC/final reads the existing bundle/current Producer facts. The collector is read-only and cannot prune/shrink fixtures/change storage/select fewer tests.

- [ ] **Step 4: Bind runner provenance to every plan**

Require `ImageOS=ubuntu24`, a concrete `ImageVersion`, `uname -a`, `/proc/cpuinfo`, Docker/Buildx/Compose versions and the filesystem/device identities used in capacity calculation. Reject `ubuntu-latest`, missing image metadata or a different runner provenance between plan and execution.

- [ ] **Step 5: Add pre-write fail-closed tests**

Instrument the restore/pull adapter with a write sentinel. When capacity fails, assert the sentinel remains empty: no image pull, snapshot download/decrypt, database creation, Compose volume or package cache write may begin.

- [ ] **Step 6: Register contracts and package commands**

Add both schemas to the repository contract manifest and expose `release:capacity:collect`. The exact file list and normalized serialization become part of `repositoryContractDigest`.

- [ ] **Step 7: Verify and commit**

```powershell
node --test packages/release-foundation/test/capacity-plan.test.mjs packages/release-foundation/test/runner-provenance.test.mjs scripts/release/collect-capacity-plan.test.mjs
pnpm release:contracts:verify
pnpm prettier --check release/contracts packages/release-foundation scripts/release package.json
git diff --check
git add release/contracts packages/release-foundation scripts/release package.json
git commit -m "build: gate release chains on measured capacity"
```

---

### Task 13: Implement closed GitHub/Aliyun trust and exact-run capability tooling

**Files:**

- Create: `release/contracts/schemas/github-bootstrap-plan.v1.schema.json`
- Create: `release/contracts/schemas/github-bootstrap-readback.v1.schema.json`
- Create: `release/contracts/schemas/aliyun-oidc-provider-plan.v1.schema.json`
- Create: `release/contracts/schemas/aliyun-oidc-provider-readback.v1.schema.json`
- Create: `release/contracts/schemas/exact-run-capability-plan.v1.schema.json`
- Create: `release/contracts/schemas/exact-run-capability-readback.v1.schema.json`
- Create: `release/contracts/schemas/exact-run-capability-revocation.v1.schema.json`
- Create: `release/contracts/schemas/exact-capability-approval.v1.schema.json`
- Create: `release/contracts/schemas/exact-capability-approval.v2.schema.json`
- Create: `release/contracts/schemas/lineage-oss-role-use-proof.v1.schema.json`
- Create: `release/contracts/schemas/publisher-sts-use-proof.v1.schema.json`
- Create: `release/contracts/schemas/oidc-cloud-role-use-proof.v1.schema.json`
- Create: `release/contracts/schemas/jit-registration-use-proof.v1.schema.json`
- Create: `release/contracts/schemas/bootstrap-canary-run-authorization.v1.schema.json`
- Create: `release/contracts/schemas/bootstrap-canary-execution-proof.v1.schema.json`
- Create: `release/contracts/schemas/bootstrap-canary-checkpoint.v1.schema.json`
- Create: `release/contracts/schemas/bootstrap-canary-read-contract.v1.schema.json`
- Create: `scripts/release/manage-canary-handoff.mjs`
- Create: `scripts/release/manage-canary-handoff.test.mjs`
- Create: `scripts/release/read-canary-checkpoint.mjs`
- Create: `scripts/release/read-canary-checkpoint.test.mjs`
- Create: `scripts/release/verify-canary-no-cloud-handoff.mjs`
- Create: `scripts/release/verify-canary-no-cloud-handoff.test.mjs`
- Create: `scripts/release/create-producer-crypto-authorization.mjs`
- Create: `scripts/release/create-producer-crypto-authorization.test.mjs`
- Create: `scripts/release/manage-producer-crypto-capability.mjs`
- Create: `scripts/release/manage-producer-crypto-capability.test.mjs`
- Create: `scripts/release/create-bootstrap-canary-authorization.mjs`
- Create: `scripts/release/create-bootstrap-canary-authorization.test.mjs`
- Create: `scripts/release/bootstrap-snapshot-environment.mjs`
- Create: `scripts/release/bootstrap-snapshot-environment.test.mjs`
- Create: `scripts/release/bootstrap-snapshot-launcher-app.mjs`
- Create: `scripts/release/bootstrap-snapshot-launcher-app.test.mjs`
- Create: `scripts/release/bootstrap-github-oidc-subject.mjs`
- Create: `scripts/release/bootstrap-github-oidc-subject.test.mjs`
- Create: `scripts/release/verify-github-oidc-subject.mjs`
- Create: `scripts/release/verify-github-oidc-subject.test.mjs`
- Create: `scripts/release/bootstrap-aliyun-oidc-provider.mjs`
- Create: `scripts/release/bootstrap-aliyun-oidc-provider.test.mjs`
- Create: `scripts/release/manage-exact-run-capability.mjs`
- Create: `scripts/release/manage-exact-run-capability.test.mjs`
- Create: `scripts/release/create-exact-capability-approval.mjs`
- Create: `scripts/release/create-exact-capability-approval.test.mjs`
- Create: `scripts/release/run-aliyun-oidc-canary.mjs`
- Create: `scripts/release/run-aliyun-oidc-canary.test.mjs`
- Create: `.github/workflows/snapshot-oidc-canary.yml`
- Create: `scripts/release/prepare-snapshot-run.mjs`
- Create: `scripts/release/prepare-snapshot-run.test.mjs`
- Create: `scripts/release/prepare-rc-snapshot-consumer-role.mjs`
- Create: `scripts/release/prepare-rc-snapshot-consumer-role.test.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `package.json`

**Interfaces:**

- `bootstrap-snapshot-environment.mjs plan` is read-only and emits a deterministic plan from GitHub API readback plus the approved root policy.
- `bootstrap-snapshot-launcher-app.mjs` exposes `plan`, `apply`, `readback` and `reconcile` for the dedicated App/installation only; private-key delivery to the root broker is a separately attested, descriptor-only step.
- `bootstrap-github-oidc-subject.mjs` exposes the same closed lifecycle for repository subject customization and refuses `apply` unless Provider plus future-subject canary role readbacks are valid.
- `apply` accepts only a plan digest and human approval record through file descriptors; `readback` emits stable identity separately from observation provenance.
- `prepare-snapshot-run` and `prepare-rc-snapshot-consumer-role` emit mechanism-specific capability plans bound to one exact run, job, pending deployment and attempt; they never create roles themselves.
- `bootstrap-aliyun-oidc-provider.mjs` and `manage-exact-run-capability.mjs` each expose only `plan`, `apply`, `readback` and `reconcile`; the capability tool additionally exposes `revoke`. Prerequisite apply/revoke requires an `external-change-approval.v1` bound to its plan and creates separate execution proofs/readbacks; this infrastructure-change approval never authorizes capability use.
- `exact-capability-approval.v1` is the frozen `additionalProperties=false` union over the three approved snapshot/JIT kinds and their exact lane/job scopes; it binds stable Environment identity and pending deployment, never a future observation or a lineage profile.
- Forward `exact-capability-approval.v2` is a separate closed Schema: `lane=rc`, `capabilityKind=lineage-oss-role`, one Task 4 matrix job/profile/node. Neither validator falls back to the other version. Both versions and the new use-proof Schema enter the repository-contract manifest in this task.
- `create-exact-capability-approval.mjs` accepts only an already allocated run/job/pending-deployment observation, verified dispatch authorization, the canonical mechanism-prerequisite plan, its independently approved apply proof, the actual per-run prerequisite readback, already-existing base Provider/broker/App readbacks and a protected signer descriptor. It derives lane/kind/profile from the registered workflow job and exclusive-creates a signed, short-lived, revocable approval containing issuer, validity, revocation and custody bindings; lane, kind, profile and purpose are not caller-selectable strings. Missing, UNKNOWN, stale or plan-mismatched prerequisite readback fails before approval creation. The later use proof must bind the same approval and actual readback.
- Every token/key reference is a protected file descriptor or secret-manager reference, never a command argument or environment variable.
- `create-producer-crypto-authorization.mjs` signs the standalone closed `producer/snapshot-data/encryption` authorization only after actual run/pending deployment and crypto role/key/context prerequisite readback exist. Bind dispatch/source/build/attempt/run, immutable key/region/endpoint/context, issuer/validity/revocation, receiver code/FD policy and <=900-second session; reject future content digests/observations/use proofs. `manage-producer-crypto-capability.mjs plan|apply|readback|revoke|reconcile` uses separate change approval and isolated issuer principal; it cannot alter v1/v2. Crypto use proof records actual GenerateDataKey result fingerprint, observation, process identity/exit, buffer disposition and session terminal facts without secret bytes.
- Exact-run resource plans/readbacks bind the expected approval Schema version plus exact job/profile/node and object set; they are prerequisite resource facts, not runtime permission. `createExactCapabilityApproval({ pendingDeployment, dispatchAuthorization, prerequisitePlan, changeApproval, applyProof, readback, policy, signer })` derives the only allowed version/kind/profile from the fixed job matrix and signs after all bindings pass. CLI cannot override version, kind, profile, purpose, key set or policy.

- [ ] **Step 1: Write RED tests for the currently absent Environment**

Mock the current `404/ABSENT` snapshot Environment state and require `plan` to propose exactly `stage1-snapshot-export`, repository ID `1253231368`, reviewer ID `275060624`, `main` only, `can_admins_bypass=false`, `prevent_self_review=false` and wait timer `0`. Also require read-only inventory records for `trusted-image-build`, `trusted-source-database-gate`, `trusted-release-execution` and `trusted-release-candidate`; this plan may not propose creating or widening them. Absence is a plan input, not an implicit apply authorization.

- [ ] **Step 2: Implement identity/provenance readback**

Normalize immutable Environment and OIDC policy fields into one identity digest per Environment; keep `observedAt`, raw API response digest and review/deployment records in the observation digest. Comparing two observations uses only identity fields for drift and provenance fields for freshness. Snapshot bootstrap can apply only the approved snapshot Environment; RC environment mismatch emits `RC_ENVIRONMENT_CHANGE_PLAN_REQUIRED`.

- [ ] **Step 3: Plan the dedicated launcher GitHub App**

Generate the exact App/installation permission plan: repository Administration write only for JIT registration, Actions read, Contents read, Deployments read and Metadata read; no source write, workflow write, checks, issues or organization scope. Bind App ID, installation ID, repository ID and key public fingerprint. Apply/readback and private-key delivery are separate proofs; UNKNOWN reconciles the exact installation and never creates a second App.

- [ ] **Step 4: Plan and read back the Aliyun OIDC Provider**

Generate the exact Provider identity: name `github-actions-subscription-saas-stage1`, issuer `https://token.actions.githubusercontent.com`, audience/client ID `sts.aliyuncs.com`, Earliest Issuance Time Allowed `1 hour`, independently computed HTTPS CA fingerprints and account-scoped Provider ARN. `apply` must be idempotent by exact ARN; `readback` verifies every value, and `reconcile` handles uncertain create/update without deleting a pre-existing provider.

- [ ] **Step 5: Generate the exact repository OIDC customization plan**

Require the subject template to include repository identity, `workflow_ref`, `workflow_sha`, `ref`, `environment`, `actor_id`, `run_id`, `run_attempt`, `event_name` and `runner_environment`. The GitHub apply path additionally requires valid Aliyun Provider readback and exact future-subject canary role readback digests; it refuses to switch first. The plan inventories existing OIDC consumers and fails with `OIDC_CONSUMER_MIGRATION_REQUIRED` instead of overwriting a shared policy.

- [ ] **Step 6: Add apply/readback separation and human-approval checks**

The apply path verifies plan digest, repository identity, immutable reviewer identity, approval expiry/revocation and a fresh pre-apply observation before the first write. After each API mutation it reads back the actual policy and stores a content-addressed proof; partial apply is `INTERRUPTED_UNKNOWN` and must reconcile before retry.

- [ ] **Step 7: Freeze v1 mechanisms and implement the forward v2 lineage contract**

Implement and validate the closed matrix from the approved addendum:

- `publisher-sts` is allowed only for `producer/snapshot-data`; it binds root broker/publisher role readback, exact attempt object namespace/KMS context, `maxSessionSeconds=900` and sealed-FD contract. It forbids OIDC, GitHub App/JIT fields and Get/List/Delete/KMS data permissions.
- v1 `oidc-cloud-role` serves only `producer/snapshot-custody` and exact RC snapshot-consumer jobs. Producer reads ciphertext/proofs without KMS Decrypt; source/final RC consumers use separate read/decrypt approvals. No lineage job, profile, namespace or write permission is accepted; OIDC's shared transport does not expand v1.
- `jit-registration` is allowed only for `producer/snapshot-data`; it binds GitHub App/installation readback, root launcher, repository, route nonce, exact five labels and JIT policy. It forbids any cloud role/STS data permission.

The data job retains separate publisher/JIT v1 approvals/readbacks/use proofs and adds a third standalone crypto authorization/readback/use proof. All three approvals precede data Environment release. Crypto and publisher data credentials never coexist; their issuers cannot assume each other's roles. The lineage DAG retains separate ordered writer/readback jobs and credential termination between them. Reject cross-contract substitution, multiple kinds, simultaneous data credentials and combined roles.

The new v2 Schema requires all of: schemaVersion, issuer/validity/revocation/custody, dispatch digest and
inherited purpose, releaseAttemptId, RC run/attempt, workflow path/ref/blob, source/build/contract,
exact job and instance, pending deployment, stable Environment identity, fixed kind/profile/node,
canonical node digest and exact-key set, private namespace/bucket/region/WORM identity,
Provider/subject/role/trust/permission policy, prerequisite plan/change approval/apply/readback digests.
No observation or use proof exists at approval time. Reject missing, null, extra or cross-variant fields.

`lineage-oss-role-use-proof.v1` binds that v2 approval, prerequisite apply/readback, post-approval
Environment observation, actual OIDC claims/Provider/role/policy, STS fingerprint/issued/expires,
exact key/version/digest and action/result entries, plus terminal revoke/expiry receipt. Writer action
entries are conditional-create only; reader entries are Head/Get only. No token/secret, database,
snapshot/KMS, root broker/FD, JIT or other-kind use-proof fields are accepted. These proofs are
generated after credential termination by Task 16B; they cannot be embedded in the already-frozen node.

Add RED cases in the existing exact-capability test files before implementing the new validator:

```js
test("v1 OIDC approval cannot authorize lineage", () => {
  assert.throws(
    () =>
      validateContract("exact-capability-approval.v1", {
        ...validSnapshotConsumerApproval,
        permissionProfile: "lineage-create-only-writer"
      }),
    /additionalProperties|const|enum/
  );
});
test("v2 approval binds actual prior readback, never a future observation", () => {
  assert.throws(
    () =>
      createExactCapabilityApproval({
        ...validLineagePrerequisites,
        readback: undefined
      }),
    /PREREQUISITE_READBACK_REQUIRED/
  );
  assert.throws(
    () =>
      validateContract("exact-capability-approval.v2", {
        ...validLineageApproval,
        environmentObservationDigest: futureDigest
      }),
    /additionalProperties/
  );
});
```

The test files define canonical local fixtures for these named inputs and their complete required
fields; production code never accepts fixture flags. Run
`node --test scripts/release/create-exact-capability-approval.test.mjs scripts/release/manage-exact-run-capability.test.mjs`
first expecting missing-v2/validator failures, then expecting all cases to pass.

- [ ] **Step 8: Implement canary and exact-run lifecycle checks**

Implement the confirmed addendum canary contract, not v1/v2: fixed `.github/workflows/snapshot-oidc-canary.yml`, job `oidc-canary`, protected exact main SHA, repository1253231368/actor275060624, `ubuntu-24.04`, attempt1 and `stage1-snapshot-export`. `create-bootstrap-canary-authorization.mjs` uses the I0 independent Ed25519 signer/revocation/custody root, never tested OIDC/STS or future I13. Bind infrastructureChangeId, actual canaryRunId/pending deployment, workflow/action/entrypoint digests, stable Environment identity, actual Provider/exact-role/subject prerequisite readbacks, validity/revocation and audience. Forbid releaseAttemptId, Producer/RC IDs, dispatch/build/Manifest/database and future observation fields.

Canary order: independently approved dispatch intent → actual pending deployment → separately approved Provider/exact future-subject role apply/readback → separately approved repository subject switch/readback → independently signed/custodied canary authorization → its own Environment approval/fresh observation → once AssumeRoleWithOIDC and once GetCallerIdentity → credential terminal/actual GitHub run terminal and externally archived result. Role has no business Allow, managed data policy or role chaining; verify all attached/inline policy and explicit narrowing session policy. No OSS/KMS/database/JIT/RAM mutation or real denied-action probing; no retry/rerun after UNKNOWN. Logs never contain JWT/STS secrets. This is infrastructure-only evidence, not qualification/RC proof.

`manage-canary-handoff.mjs` implements only the approved canary transport: independently plan/approve/apply/read back exact data ref `refs/heads/infra-bootstrap-canary-state`, tree only `canary-state.json`, root publisher/protection/genesis/checkpoint/read-contract identity. It never creates a general service or executable data ref. Fixed publisher makes signed single-parent non-force fast-forward checkpoints; serialized READY/revocation queue prevents pending revocation from being overwritten by old READY. Ref publication UNKNOWN blocks/cancels run and new assume. Private I0 archive retains original evidence; public ref is not long-term custody.

Before Environment approval, separately plan/approve/write/read back the complete digest of non-secret `BOOTSTRAP_CANARY_AUTHORIZATION_CAPSULE` (<=48KB): authorization, independent signature, authorization custody/readback, issuance revocation baseline and read-contract identity. No future observation/READY commit or control-plane secret. One nonterminal canary per Environment, no overwrite in-use capsule, no same-name repo/org/workflow shadow and no shell interpolation. Capsule is immutable after approval; 15-minute authorization expiry cancels rather than updating it.

After actual Environment approval/job allocation, independent observer reads real reviewer immutable ID/review/deployment/status/run/job and stable identity, signs bound post-approval observation and publishes BLOCKED→READY or REVOKED/CLOSED checkpoint. Terminal states cannot return READY. `read-canary-checkpoint.mjs` uses only job GITHUB_TOKEN contents/actions/deployments read and exact api.github.com GET allowlist. Read authority H1, verify canonical signature/parent/monotonic sequence/current revocation/authorization/capsule/run/deployment/job/reviewer, independently GET actual approval facts, then re-read H2; only H1=H2 passes. Changed head retries read verification, never uses old READY. Require new200, no304/cache/artifact/CDN/old caller commit, observation age<=60seconds, wait<=300seconds, clock skew<=60seconds. Recheck cancel/timeout next to OIDC request. No linearizability or future nonrevocation claim.

`verify-canary-no-cloud-handoff.mjs` drives a separately approved actual GitHub Environment/API handoff test of that identical reader/transport with id-token:none and fail-on-call hooks for OIDC/STS/identity/cloud-credential access. It cannot run the probe or report canary success; positive result is only `HANDOFF_VERIFIED_NO_OIDC`. Deterministic barriers test capsule-write→revoke→read and H1→revoke→H2, wrong/missing approval observation, 403, bypass, replay/old sequence, partial publish/UNKNOWN, stale60seconds and timeout300seconds; every rejection must record OIDC/AssumeRole/GetCallerIdentity/cloud-credential count zero. This real no-cloud test is a separately authorized I7 prerequisite before enabling the real I8 probe; static YAML/unit tests do not satisfy it.

`bootstrap-canary-execution-proof.v1` binds actual probe facts, H1/H2/read-admission/observation digests, independent revocation and later process/session/run terminal facts; it is independently signed/archived after execution and never references its own final receipt. Failure branches require only reached facts and use NOT_EXECUTED/UNKNOWN without invented job IDs or expiry. Actual expiry/possible-session upper bound must pass before downstream; trust closure is not immediate STS revocation.

For the already-approved Producer/RC jobs only, exact-run lifecycle remains `pending deployment →
prerequisite plan/change approval → apply/readback → exact approval binding actual readback →
Environment approval → observation → use → terminal revoke/readback`. Resource apply/revoke UNKNOWN
uses registered reconcile; the use proof binds the same actual readback and approval.

- [ ] **Step 9: Add negative tests**

Reject wrong repository/environment/reviewer, tag/ref, workflow SHA, actor, run attempt, self-hosted versus GitHub-hosted mismatch, admin bypass, stale observation, missing approval, wildcard trust, ambient token, Provider issuer/client ID/fingerprint/issuance/ARN mismatch, GitHub subject switch before cloud condition readback, credential/JIT use before Environment approval, role/JIT plan before pending deployment, prerequisite apply without change approval, exact approval before actual matching readback, future observation, publisher OIDC, Producer KMS Decrypt, RC reuse of Producer identity, and broker data permission. For v2 enumerate all eight job/profile/Environment bindings and reject wrong lane/node, cross-instance/run/key, v1 credentials, writer read/reader write, List/Delete/KMS/snapshot/database/JIT, simultaneous credentials, missing revoke/expiry, and any retention role request. Test that every refusal occurs before STS/credential access and that v1 golden contract cases retain their original results.

Also reject publisher GenerateDataKey, crypto OSS/Decrypt, future snapshot/ciphertext context, crypto/publisher overlap, canary v1/v2 fallback, canary use without I0 signer/archive, incomplete subject readback, Environment approval before standalone authorization, extra API, second STS call and canary proof admitted to aggregate. Run the new crypto/canary authorization/lifecycle tests with injected clients; include all named Task13 files in its commit manifest. No cloud call is a repository test.

Run `node --test scripts/release/create-producer-crypto-authorization.test.mjs scripts/release/manage-producer-crypto-capability.test.mjs scripts/release/create-bootstrap-canary-authorization.test.mjs scripts/release/manage-canary-handoff.test.mjs scripts/release/read-canary-checkpoint.test.mjs scripts/release/verify-canary-no-cloud-handoff.test.mjs` RED before implementing the listed fixed adapters, then GREEN with injected transports; real GitHub handoff is only in separately authorized I7. Task13's existing `git add scripts/release release/contracts` includes this complete file list.

- [ ] **Step 10: Verify and commit repository-only tooling**

```powershell
node --test scripts/release/bootstrap-snapshot-environment.test.mjs scripts/release/bootstrap-snapshot-launcher-app.test.mjs scripts/release/bootstrap-github-oidc-subject.test.mjs scripts/release/verify-github-oidc-subject.test.mjs scripts/release/bootstrap-aliyun-oidc-provider.test.mjs scripts/release/create-exact-capability-approval.test.mjs scripts/release/manage-exact-run-capability.test.mjs scripts/release/run-aliyun-oidc-canary.test.mjs scripts/release/prepare-snapshot-run.test.mjs scripts/release/prepare-rc-snapshot-consumer-role.test.mjs
pnpm release:contracts:verify
pnpm prettier --check release/contracts scripts/release package.json
git diff --check
git add .github/workflows/snapshot-oidc-canary.yml release/contracts scripts/release package.json
git commit -m "build: plan trusted snapshot environment bootstrap"
```

Expected: only deterministic plan/readback tooling exists; no GitHub Environment, OIDC policy, GitHub App, secret or cloud role has been created.

---

### Task 14: Replace the snapshot workflow with a three-job private-custody producer

**Files:**

- Modify: `.github/workflows/sanitized-snapshot.yml`
- Create: `scripts/release/verify-snapshot-workflow.mjs`
- Create: `scripts/release/verify-snapshot-workflow.test.mjs`
- Modify: `scripts/release/approval-workflows.test.mjs`
- Modify: `scripts/release/release-dag-assemblers.test.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Workflow contract:**

1. `snapshot-admission` runs on `ubuntu-24.04` before Environment approval, verifies the exact approved main SHA, expected Environment identity contract, owner facts, adapter build proof, target policy and capacity inputs, then publishes only a canonical non-sensitive admission artifact. It has no Environment, OIDC token or attestation authority; the artifact remains untrusted until the root launcher independently verifies and signs it.
2. `snapshot-data` has its own pending deployment. Separate publisher/JIT/crypto prerequisite plans require independent change approvals/apply/readbacks; unchanged publisher/JIT v1 approvals and standalone crypto authorization must all bind those facts before human Environment approval. The exact five-label JIT job has one fixed root-owned adapter invocation and no checkout/uses/package-manager/Docker/free-form input. Crypto process/session terminates before publisher STS; later publisher-terminal and destruction records go through independent control-plane archive.
3. `snapshot-custody` is a later, separately approved deployment on `ubuntu-24.04` under `stage1-snapshot-export`. It cannot become pending until data, encrypted-object and host-destruction proofs are durable; its independent cloud-role change is approved/applied/read back first, the actual readback is then bound into its `oidc-cloud-role` approval, and only the second human Environment approval may release the job. It verifies encrypted OSS object/proofs/destruction receipt, issues a GitHub artifact attestation and emits `snapshot-producer-completion.v1`. It never downloads or decrypts the snapshot and has no KMS Decrypt permission.

- [ ] **Step 1: Make existing workflow tests fail on plaintext custody**

Assert the workflow contains no plaintext dump upload, public Actions artifact containing snapshot bytes, 30-day snapshot artifact retention, repository checkout in `snapshot-data`, `pnpm`, `npm`, `node scripts/`, arbitrary `run` input or persistent self-hosted label.

- [ ] **Step 2: Implement the admission job**

Declare only `contents: read` and `actions: read`; omit `id-token` and `attestations`, and do not set `environment`. Admission output contains only digests, IDs, allowed labels, immutable workflow identity, exact adapter digest, expiry and protected object references. The root launcher retrieves it with its GitHub App, verifies run/job/workflow/artifact facts and produces the separate root-signed admission-verification proof before requesting JIT configuration.

- [ ] **Step 3: Implement the single-entry data job**

Set `runs-on` to the exact default labels, capability label and derived unique label; set `environment: stage1-snapshot-export`; disable container/service/default shell customization. The only command is the literal installed adapter path with the admission artifact reference. It receives root handoff through the launcher, not workflow secrets or environment variables. Workflow/policy tests require the data deployment ID, its exact-capability approval digests and fresh data observation to be distinct from custody.

- [ ] **Step 4: Implement custody verification**

Declare `environment: stage1-snapshot-export` and exact permissions `contents: read`, `actions: read`, `id-token: write`, `attestations: write`. Require a second pending deployment, second exact-capability approval and post-approval custody observation; neither the data review nor data observation can satisfy it. Verify the private OSS object using `HEAD` and range-read ciphertext hash, KMS/OSS receipt, root-signed admission verification, producer proof, sanitization proof, source fingerprint, GitHub job/runner identity, destruction receipt, 30-day expiry and 210-day retention state. The custody role can read only ciphertext/proofs and explicitly cannot call KMS Decrypt. Then issue a GitHub artifact attestation for only the non-sensitive completion proof/reference and upload that small artifact to GitHub Actions.

- [ ] **Step 5: Add structural and policy negative tests**

Mutate a workflow fixture to add admission Environment/OIDC/attestation authority, data-job checkout/second command/mutable label/plaintext upload/Docker, shared data/custody approval or observation, custody beginning before durable data/destruction proof, custody without `stage1-snapshot-export`, custody KMS Decrypt, missing `attestations: write`, broader token permission or missing custody job; every mutation must fail with a stable code.

- [ ] **Step 6: Verify and commit without dispatching**

```powershell
node --test scripts/release/verify-snapshot-workflow.test.mjs scripts/release/approval-workflows.test.mjs scripts/release/release-dag-assemblers.test.mjs
node scripts/release/verify-snapshot-workflow.mjs --workflow .github/workflows/sanitized-snapshot.yml
pnpm release:contracts:verify
pnpm prettier --check .github/workflows/sanitized-snapshot.yml scripts/release release/contracts
git diff --check
git add .github/workflows/sanitized-snapshot.yml scripts/release release/contracts
git commit -m "ci: isolate sanitized snapshot production"
```

Expected: static/contract tests pass, but the workflow remains undispatched because external infrastructure is not yet authorized or present.

---

### Task 15: Move source and final chains to GitHub-hosted runners with encrypted snapshot consumption

**Files:**

- Modify: `.github/workflows/release-candidate-gate.yml`
- Modify: `.github/workflows/release-final-chain.yml`
- Modify: `.github/workflows/release-operation-approval.yml`
- Modify: `.github/workflows/release-approval-revocations.yml`
- Modify: `.github/workflows/release-owner-attestations.yml`
- Create: `scripts/release/download-private-snapshot.mjs`
- Create: `scripts/release/download-private-snapshot.test.mjs`
- Create: `scripts/release/verify-release-runner-hosting.mjs`
- Create: `scripts/release/verify-release-runner-hosting.test.mjs`
- Create: `scripts/release/verify-producer-terminal.mjs`
- Create: `scripts/release/verify-producer-terminal.test.mjs`
- Modify: `scripts/release/run-source-database-gate.mjs`
- Modify: `scripts/release/run-final-compose-gate.mjs`
- Modify: `scripts/release/final-compose-custody-adapters.mjs`
- Modify: `scripts/release/final-compose-custody-adapters.test.mjs`
- Modify: `scripts/release/final-compose-production-adapters.mjs`
- Modify: `scripts/release/final-compose-gate.test.mjs`
- Modify: `scripts/release/release-dag-assemblers.test.mjs`
- Create: `scripts/release/release-final-chain.test.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- RC workflow input is `rcDispatchAuthorizationDigest`, `snapshotProducerCompletionDigest` plus its private custody reference and the already frozen `snapshotRunId`; there is no caller-selected purpose, plaintext artifact name or external final/exit run ID.
- `verify-producer-terminal.mjs` independently reads actual GitHub run/jobs at dispatch and again at RC entry, verifies attempt1/workflow/source/all required job success and completion private archive, then emits a new terminal observation. The Producer-internal completion contains no run terminal/self-reference. Controller dispatch and RC admission fail on pending/skipped/cancelled/UNKNOWN or stale/mismatched facts.
- `download-private-snapshot.mjs` validates exact-run OIDC, custody/admission/expiry/digest before KMS unwrap, streams decrypt output into the isolated restore pipeline and removes the plaintext FIFO/process on every terminal path.
- Both source and final jobs run on `ubuntu-24.04`; no self-hosted runner sees build, repository or final-chain work.

- [ ] **Step 1: Add RED hosting and input tests**

Reject `self-hosted`, `ubuntu-latest`, mutable image identity, plaintext snapshot artifact inputs, external `finalExecutionRunId`/`exitEvidenceRunId`, missing producer completion digest, wildcard OIDC role and snapshot download before capacity admission.

- [ ] **Step 2: Add capacity/provenance before any write**

Fresh and snapshot chains independently collect runner provenance and `capacity-plan.v1`. Capacity must pass before registry pulls, dependency install, snapshot fetch/decrypt, temporary database provisioning or Compose volume creation.

- [ ] **Step 3: Implement exact-run private snapshot consumption**

For each source-snapshot and final-snapshot job, first allocate the job and pending deployment, generate a deterministic exact-role prerequisite plan, obtain its independent infrastructure-change approval, apply/read back the exact Provider/subject/role/policy, and only then sign that job's RC-lane `oidc-cloud-role` approval binding the readback. After the corresponding Environment receives its own human approval and a fresh post-approval observation passes, the job may request OIDC. Each role trust policy matches the current `rcWorkflowRunId`, attempt, job and Environment; no Producer custody approval, role, observation, credential or use proof is reusable. Allow one exact object key/version and one KMS ciphertext context; deny bucket listing and other attempt prefixes. Verify ciphertext digest before decrypt, sanitized content digest while streaming and fail if plaintext is addressable as an Actions artifact/cache.

- [ ] **Step 4: Run source fresh and source snapshot gates in the same RC run**

Fresh and snapshot use separate temporary databases and the exact source checkout/executor, not final Runner commands. They emit only immutable `source-gate-evidence.v1` with source/database/migration/test/snapshot identities, no formal Manifest or Runner execution proof. Current RC binds the newly completed Producer input and reruns both chains; prebuild source results cannot substitute. Add RED Manifest/Runner-command/execution-proof masquerading and cross-run/prebuild-source reuse cases.

- [ ] **Step 5: Run final fresh and final snapshot Compose gates**

Use registry-resolved API/Web/Runner platform digests, no local build and no bind-mounted repository scripts. Runner performs migration/verify, API proves its actual database session identity, Web performs a real Playwright public API request, and runtime-equivalent database tests report the complete zero-skip equation.

Final owns formal Manifest and `execution-proof.v1` leaves. Command-leaf envelopes reference neither source/final parent envelope nor themselves. After all leaves finish, final-compose parent/envelope references matching same-RC source plus fixed ordered completed command leaves. Reject self digest, final→command→final cycles, missing/mismatched parent source binding and any source proof pretending to be a leaf. Task6 private archive retains raw inputs/approvals/use/revocation/access/failures; Actions retention180/fake now+180 is a RED workflow/custody test, not durable evidence.

Wire `final-compose-production-adapters.mjs`/`final-compose-custody-adapters.mjs` to the fixed external archive transport and Task6 verifier; remove local default uploader as a qualifying custody path. Final checkpoint requires unchanged raw v1 receipt + matching authoritative-custody-observation + independent original-byte readback/terminal retention. Add named adapter/gate tests rejecting local-only upload, Actions-only retention, valid-looking receipt with missing/mismatched observation and successful test execution without authoritative custody. Workflow approval/revocation/owner-attestation original bytes use the same control-plane archive; no new workflow archive data role is inferred.

- [ ] **Step 6: Preserve all failure evidence**

On failure or cancellation, upload only redacted proof/log artifacts after digest verification. Database commit ambiguity becomes `INTERRUPTED_UNKNOWN`; snapshot plaintext and credentials are never uploaded. A retry uses a new attempt/proof and reruns the complete failed stage without replacing bundle components. Unknown OIDC/KMS use is reconciled against the same run/job/role/object; unresolved state makes the release attempt non-promotable and may not be hidden by a new purpose envelope.

- [ ] **Step 7: Verify and commit without executing the RC**

```powershell
node --test scripts/release/download-private-snapshot.test.mjs scripts/release/verify-release-runner-hosting.test.mjs scripts/release/verify-producer-terminal.test.mjs scripts/release/release-dag-assemblers.test.mjs scripts/release/release-final-chain.test.mjs scripts/release/final-compose-custody-adapters.test.mjs scripts/release/final-compose-gate.test.mjs
node scripts/release/verify-release-runner-hosting.mjs --rc-workflow .github/workflows/release-candidate-gate.yml --final-workflow .github/workflows/release-final-chain.yml
pnpm release:contracts:verify
pnpm prettier --check .github/workflows scripts/release release/contracts
git diff --check
git add .github/workflows scripts/release release/contracts
git commit -m "ci: run release gates on immutable hosted runners"
```

---

### Task 16A: Implement dispatch authorization and typed purpose envelopes

**Files:**

- Create: `release/contracts/schemas/release-attempt.v1.schema.json`
- Create: `release/contracts/schemas/purpose-claim.v1.schema.json`
- Create: `release/contracts/schemas/execution-purpose-envelope.v1.schema.json`
- Create: `packages/release-foundation/src/dispatch-authorization.mjs`
- Create: `packages/release-foundation/src/execution-purpose.mjs`
- Create: `packages/release-foundation/test/dispatch-authorization.test.mjs`
- Create: `packages/release-foundation/test/execution-purpose.test.mjs`
- Create: `scripts/release/create-rc-dispatch-authorization.mjs`
- Create: `scripts/release/create-rc-dispatch-authorization.test.mjs`
- Create: `scripts/release/create-release-attempt.mjs`
- Create: `scripts/release/create-release-attempt.test.mjs`
- Create: `scripts/release/create-execution-purpose-envelope.mjs`
- Create: `scripts/release/create-execution-purpose-envelope.test.mjs`
- Modify: `packages/release-foundation/src/schema-registry.mjs`
- Modify: `packages/release-foundation/src/index.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Approval model:**

1. `rc-dispatch-authorization.v1` is signed after build/bundle and `releaseAttemptId` exist but before Producer/RC run creation. It fixes the purpose and immutable expected identities; it cannot contain future run IDs, database, Manifest, command or plan fields.
2. Exact-capability approval uses frozen v1 for snapshot/cloud/JIT, or separate v2 for lineage storage. Both are signed only after run/job/pending deployment and independently approved prerequisite apply/readback, before that job's Environment approval. Version/kind/profile is derived from Task 13's closed job contract, never selected by the caller; no future observation is included.
3. Existing `approval-record.v1` is signed only after database identity, baseline Manifest, `commandId@version`, capability and deterministic plan digest exist. It approves only that command and cannot substitute for either earlier approval.

- [ ] **Step 1: Write RED dispatch-order and approval-separation tests**

Reject dispatch authorization before build/bundle, caller-supplied purpose, authorization containing a future run ID, capability approval without pending deployment or actual matching prerequisite readback, capability approval issued before prerequisite apply/readback, capability approval containing observation, command approval without Manifest/plan, and any one record used for two approval roles.

- [ ] **Step 2: Implement closed dispatch authorization creation and verification**

`create-release-attempt.mjs` first verifies the trusted source/build/bundle/Adapter custody inputs and allocates a 128-bit ID by exclusive create; it cannot be called before those inputs exist. `create-rc-dispatch-authorization.mjs` then accepts only that attempt record, a canonical request and signer/revocation descriptors. It derives `executionPurpose` from the fixed workflow contract, binds the attempt and approved identities, and exclusive-creates the signed authorization. Missing, stale, revoked or mismatched authorization fails before Producer/RC dispatch.

- [ ] **Step 3: Define typed envelopes without changing raw v1 contracts**

Validate each published raw v1 proof first, recompute its canonical digest and verify immutable custody. Every envelope requires purpose, attempt, RC run/attempt, source SHA, build proof, repository contract and raw proof type/digest/run/job identity. Type-specific required bindings are closed, not optional:

- source-gate: exact source executor/source database identity, migration/test/snapshot/sanitization identities; forbid formal Manifest and Runner command/execution bindings;
- execution: operation, `commandId@version`, profile, database, Manifest, plan, post-state, approval policy and tagged capability binding;
- final-compose: fresh/snapshot chain, API/Web/Runner digests, database/Manifest, network capture, test equation, matching source envelope and ordered completed command-leaf digests. Leaves contain no source/final parent envelope reference; parent owns source/leaf references. Reject self-reference/cycles.

Execution uses exactly one capability branch: `external-capability` binds only Task 13 v1 approval and its actual snapshot/cloud/JIT prerequisite/observation/use proof; `runner-database-role` binds launch attestation, database-role observation, command policy and applicable `approval-record.v1`, and forbids cloud placeholders. V2 lineage storage cannot authorize a database command and cannot be placed in a raw proof or envelope. Its approval/use evidence belongs only to the later access receipt. Add a negative test rejecting a v2 lineage binding passed to the envelope builder.

- [ ] **Step 4: Derive purpose only from two trusted sources**

The generator compares the workflow's statically compiled purpose with the verified dispatch authorization. CLI/input/env cannot carry purpose. Qualification workflow rejects release-candidate authorization and vice versa.

- [ ] **Step 5: Run focused tests and commit the envelope kernel**

```powershell
node --test packages/release-foundation/test/dispatch-authorization.test.mjs packages/release-foundation/test/execution-purpose.test.mjs scripts/release/create-release-attempt.test.mjs scripts/release/create-rc-dispatch-authorization.test.mjs scripts/release/create-execution-purpose-envelope.test.mjs
pnpm release:contracts:verify
git diff --check
git add release/contracts packages/release-foundation/src packages/release-foundation/test/dispatch-authorization.test.mjs packages/release-foundation/test/execution-purpose.test.mjs scripts/release/create-release-attempt.mjs scripts/release/create-release-attempt.test.mjs scripts/release/create-rc-dispatch-authorization.mjs scripts/release/create-rc-dispatch-authorization.test.mjs scripts/release/create-execution-purpose-envelope.mjs scripts/release/create-execution-purpose-envelope.test.mjs
git commit -m "build: bind release proofs to approved execution purpose"
```

---

### Task 16B: Enforce one-to-one purpose claims and v2 custody

**Files:**

- Create: `release/contracts/schemas/custody-receipt.v2.schema.json`
- Create: `release/contracts/schemas/lineage-storage-access-receipt.v1.schema.json`
- Create: `packages/release-foundation/src/purpose-claim.mjs`
- Create: `packages/release-foundation/test/purpose-claim.test.mjs`
- Modify: `packages/release-foundation/src/evidence-custody.mjs`
- Modify: `packages/release-foundation/test/evidence-custody.test.mjs`
- Create: `scripts/release/lineage-custody-adapters.mjs`
- Create: `scripts/release/lineage-custody-adapters.test.mjs`
- Create: `scripts/release/custody-purpose-envelope.mjs`
- Create: `scripts/release/custody-purpose-envelope.test.mjs`
- Modify: `.github/workflows/release-candidate-gate.yml`
- Modify: `packages/release-foundation/src/schema-registry.mjs`
- Modify: `packages/release-foundation/src/index.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- `preparePurposePair({ rawProof, rawCustody, dispatchAuthorization, workflow, typedBindings })` in
  `purpose-claim.mjs` validates v1 and trusted raw custody, derives purpose, and returns immutable
  canonical claim/envelope bytes, digests and exact keys; no cloud credential is read.
- `storePurposePair({ pair, writer, journal })` writes only claim then envelope and returns write
  acknowledgments, not readback or successful custody. `readbackPurposePair({ pair, writeProof,
writerTerminal, reader, journal })` validates both frozen objects in the separate reader job.
- `createLineageStorageAccessReceipt({ frozenSubject, writeUseProof, readUseProof, approvals, journal })`
  in `lineage-custody-adapters.mjs` verifies successful exact writes/readback and terminal sessions,
  then emits the canonical receipt. It cannot receive the subject's future receipt as an input.
- `verifyLineageStorageAccessReceipt({ receipt, proofResolver, expectedBindings })` in the same module
  validates Schema, canonical digest, trusted receipt/use/approval custody and the complete typed
  subject chain, returning verified bindings only. `proofResolver` accepts approved non-sensitive
  proof references; it grants no private-node/cloud access or caller-asserted success.
- `custody-purpose-envelope.mjs` exposes only fixed `prepare`, `store`, `readback`, `custody`, and
  `diagnose` phases, selected by the approved workflow job. Requests/plans/approvals use protected
  descriptors; no caller-selected purpose, key, bucket, profile, script or SQL. `diagnose` is read-only
  and permanently ineligible for successful receipt/downstream output.

- [ ] **Step 1: Write RED one-to-one and no-cycle tests**

Reject a second purpose/envelope for one raw digest across attempts, altered key derivation,
overwrite/delete/recreate, missing independent readback, self/circular access references, retention
shorter than downstream lineage, public artifact bytes, v1 lineage credentials, wrong v2 matrix entry
and combined credentials. Add ordered-call and fault-injection tests before implementation:

```js
test("claim conflict stops before envelope; no writer reads", async () => {
  const calls = [];
  const writer = {
    putExact: async (object) => {
      calls.push(object.key);
      throw Object.assign(new Error("conflict"), { code: "LINEAGE_OBJECT_CONFLICT" });
    }
  };
  await assert.rejects(storePurposePair({ pair, writer, journal: freshJournal() }), /conflict/);
  assert.deepEqual(calls, [pair.claim.key]);
});
test("diagnosis cannot turn a partial pair into successful custody", async () => {
  const journal = partialPairJournal();
  await assert.rejects(
    createLineageStorageAccessReceipt({
      ...successfulReadbackInputs,
      journal
    }),
    /LINEAGE_ATTEMPT_NOT_ADMISSIBLE/
  );
});
```

The test file defines these deterministic pair/journal/proof fixtures locally. Run
`node --test packages/release-foundation/test/purpose-claim.test.mjs scripts/release/custody-purpose-envelope.test.mjs`
first expecting missing pair/receipt functions; then test the full fault matrix in Step 5.

- [ ] **Step 2: Implement deterministic claim and storage derivation**

Compute and freeze envelope first, then a claim referencing its digest. The claim key derives only
from raw type/digest under `evidence/claims/v1/`; the envelope key derives from its attempt/run/type/
digest. Freeze both canonical byte strings, digests and exact-key set before writer plan/approval.
Same raw identity under a new attempt must still derive the same claim key. No envelope→claim or own
storage-proof reference is permitted. The two keys are not an atomic transaction.

`lineage-purpose-store` holds only the v2 writer. `storePurposePair` requires a fresh operation journal,
condition-creates claim, records an explicit successful write acknowledgment, and only then creates
envelope. Its adapter has no Head/Get methods. Any non-success or ambiguous first response stops the
second call. Two explicit create responses move the journal to `WRITES_ACKNOWLEDGED`, not `SUCCESS`;
writer revoke/expiry proof must be recorded before the reader is eligible.

- [ ] **Step 3: Create v2 custody as the only aggregate-eligible input**

`lineage-purpose-readback` obtains a separate v2 reader approval/credential after writer termination.
Read exactly the two planned objects; compare canonical bytes, digests, versions and all claim→envelope/
purpose/attempt/run bindings. Write acknowledgments never substitute for this readback. Successful
reader termination and an unfailed journal allow the purpose access receipt; only then build
`custody-receipt.v2`, binding envelope digest, `purposeClaimDigest`, derived keys/versions,
condition-create/readback proofs, purpose access receipt, raw custody and retention/legal-hold policy.

`lineage-storage-access-receipt.v1` is a closed per-node subject union, not arbitrary metadata. It binds
both v2 approvals, both use-proof digests, frozen node digest/exact-key set, actual versions,
conditional-create/readback results and typed validated bindings (purpose/dispatch/run/source/build/
contract and predecessor digests). Purpose subject requires both claim and envelope, not an optional
second key. The trusted reader validates these facts against the bytes it just read; a caller success
flag or unattested projection is rejected. Only field-reviewed non-sensitive bindings/references enter
Actions receipt custody; node bytes, secrets and raw source data never do. The receipt is generated
after the node; raw proof/envelope/node must not embed its own v2 approval/use/access receipt.

- [ ] **Step 4: Implement mutually exclusive lineage custody identities**

The runtime adapter exports only writer and reader constructors for Task 4's exact matrix. Retention
helpers from Task 6 are not imported by this RC entrypoint. Every store/readback job follows its own
pending deployment → change approval/apply/readback → v2 approval → Environment review/observation →
one credential → use proof → revoke/expiry chain. `lineage-custody-store` stores only the already-built
custody node; `lineage-custody-readback` reads only that node and emits its later access receipt.
Aggregate and exit use their own fixed pairs in Task 16C. No reader may fetch another node family's
keys merely to help aggregation.

Writer and reader job outputs contain only approved digests/references and the field-reviewed receipt
bindings. Builders consume verified same-run raw proofs and prior access receipts, reconstruct the
next canonical node in memory, and verify it against the frozen plan digest before store; do not pass
private node bytes through public artifacts or create an extra cloud fetch profile. The trusted
custody channel validates receipt attestation, signer/run/job and subject digest before accepting any
binding. Receipt custody is non-recursive and is distinct from private node custody.

- [ ] **Step 5: Preserve UNKNOWN and whole-lineage retention**

Fault-inject at claim create, between writes, envelope create, each readback and each receipt-custody
acknowledgment. Claim conflict/failure/UNKNOWN stops envelope creation. Claim success plus envelope
failure/conflict is `FAILED`; uncertain writes/readbacks or lost process are `INTERRUPTED_UNKNOWN`,
recorded by the trusted launcher if the child cannot emit a proof. Any partial/conflicting/failed/
UNKNOWN pair or readback mismatch forbids successful access/custody/aggregate/exit. Preserve written
objects, raw proof, approval and failure history; no retries that fill a missing object, overwrite,
delete or rewrap. An identical existing claim is diagnostic evidence only; a different claim raises
`RAW_PROOF_PURPOSE_ALREADY_CLAIMED`. Read-only diagnosis cannot change the failed terminal admission
decision even when both objects are later found. New execution requires new operation/run/raw proof
and complete lineage. Generic resource/DB reconcile rules do not override this rule.

Verify with spies that denied scenarios make no downstream builder/store calls. Claim, versions,
readbacks, use/access receipts and failed-attempt records retain custody through the latest dependent
lineage expiry/legal hold; legal disposition later needs separate exact-key approval and receipt.

- [ ] **Step 6: Verify and commit custody separately**

```powershell
node --test packages/release-foundation/test/purpose-claim.test.mjs packages/release-foundation/test/evidence-custody.test.mjs scripts/release/lineage-custody-adapters.test.mjs scripts/release/custody-purpose-envelope.test.mjs
pnpm release:contracts:verify
git diff --check
git add .github/workflows/release-candidate-gate.yml release/contracts packages/release-foundation/src packages/release-foundation/test/purpose-claim.test.mjs packages/release-foundation/test/evidence-custody.test.mjs scripts/release/lineage-custody-adapters.mjs scripts/release/lineage-custody-adapters.test.mjs scripts/release/custody-purpose-envelope.mjs scripts/release/custody-purpose-envelope.test.mjs
git commit -m "build: custody one purpose envelope per raw proof"
```

---

### Task 16C: Aggregate the qualification DAG and stop before Task 30

**Files:**

- Create: `release/contracts/schemas/release-aggregate-proof.v2.schema.json`
- Create: `release/contracts/schemas/s1-exit-evidence.v2.schema.json`
- Modify: `scripts/release/aggregate-release-proof.mjs`
- Modify: `scripts/release/generate-s1-exit-evidence.mjs`
- Modify: `scripts/release/aggregate-release-proof.test.mjs`
- Modify: `scripts/release/generate-s1-exit-evidence.test.mjs`
- Modify: `scripts/release/release-dag-assemblers.test.mjs`
- Modify: `scripts/release/approval-workflows.test.mjs`
- Modify: `.github/workflows/release-candidate-gate.yml`
- Modify: `packages/release-foundation/src/schema-registry.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**DAG:**

```text
trusted build/bundle
  -> releaseAttemptId -> rc-dispatch-authorization.v1
  -> independent Producer completion/custody
  -> unique RC run raw source/execution/final-compose v1 proofs
  -> freeze one-to-one claim/envelope -> claim success then envelope store
  -> writer terminal -> independent pair readback -> purpose access receipt
  -> v2 custody -> custody store/readback/access receipt
  -> release-aggregate-proof.v2 -> aggregate store/readback/access receipt
  -> s1-exit-evidence.v2 -> exit store/readback/access receipt -> qualification stop proof
  -X-> Task 30 audit/final custody (blocked)
```

The independent Producer may supply only its attested encrypted snapshot/completion references. Build proof and narrow owner/manual attestations remain dispatch-bound prerequisites. Every raw source/execution/final proof, envelope, v2 custody, aggregate and exit node is created in one `rcWorkflowRunId`; no external final/aggregate/exit is accepted.

- [ ] **Step 1: Write RED cross-run, direct-v1 and purpose-splice tests**

Reject different RC run/attempt, imported source/final proof, raw v1 selected directly, missing claim/
envelope, mismatched producer/build/contract/snapshot, external aggregate/exit, qualification relabel,
public private-node bytes, missing/mismatched per-node access receipts, unverified receipt projections,
v1 lineage approvals, missing v2 use/termination proof, cross-profile credentials and overwritten
evidence. Reject a node containing its own storage/use/access proof; reject writer acknowledgments
offered as readback, aggregation reading arbitrary private keys, and any failed pair diagnosed later
as apparently complete. Each negative must fail before aggregate/exit storage.

- [ ] **Step 2: Recompute aggregation from v2 custody lineage**

Consume only the verified same-run v2 custody subjects and their external access receipts delivered
by `lineage-custody-readback`. Call Task 16B's `verifyLineageStorageAccessReceipt` and traverse
purpose/claim/envelope/raw bindings and per-job v2 approvals/use proofs; no second broad cloud reader
or v1 snapshot role is permitted. Reconstruct and recompute the aggregate from these validated
non-sensitive facts in memory; a caller-provided JSON success flag is never a fact. Freeze aggregate
bytes/digest/key before `lineage-aggregate-store` prerequisite planning and v2 approval. That job
condition-creates only its aggregate; after writer termination, `lineage-aggregate-readback` validates
only that object and emits the later aggregate access receipt. Both use `trusted-release-candidate`
with separate deployment approvals. The aggregate contains prior custody access receipts, never its
own. Producer completion remains only a prerequisite; every execution input shares one RC lineage.

- [ ] **Step 3: Generate qualification exit evidence inside the RC run**

Remove `exitEvidenceRunId` and complete external exit downloads. Generate `s1-exit-evidence.v2` only
after aggregate readback/access receipt, binding qualification/current RC/dispatch/build/contracts,
aggregate digest **and its access receipt**, plus narrow approved attestations. Freeze exit then run
`lineage-exit-store` and, after its session terminates, `lineage-exit-readback` with separate v2
approvals/deployments in `trusted-release-candidate`. Exit's own later access receipt goes only into
the qualification stop proof (or the separately authorized future Task 30 audit), never into exit.
No private node bytes or credential enter public Actions artifacts; reviewed access receipts use
non-recursive trusted evidence custody.

- [ ] **Step 4: Keep qualification permanently non-promotable**

`assertPromotionEligible` first rejects qualification, missing/mixed purpose, direct raw v1, different
dispatch/attempt and incomplete claim/access custody. Keep `task30 rejects qualification evidence`.
The qualification stop proof must bind the successfully custodied exit access receipt and all
terminal role/session receipts before `TASK_30_AUTHORIZATION_REQUIRED`. No Task 30 audit, stash,
promotion, S1-completion mark or follow-up dispatch is allowed. An access/custody UNKNOWN remains a
failed attempt, not a successful checkpoint after repair.

- [ ] **Step 5: Run DAG tests and commit**

```powershell
node --test scripts/release/aggregate-release-proof.test.mjs scripts/release/generate-s1-exit-evidence.test.mjs scripts/release/release-dag-assemblers.test.mjs scripts/release/approval-workflows.test.mjs
pnpm release:contracts:verify
pnpm prettier --check .github/workflows/release-candidate-gate.yml scripts/release release/contracts
git diff --check
git add .github/workflows/release-candidate-gate.yml packages/release-foundation/src/schema-registry.mjs scripts/release release/contracts
git commit -m "ci: aggregate purpose-bound stage1 qualification evidence"
```

---

### Task 17A: Add the trusted main Adapter build, publication and custody producer

**Files:**

- Create: `.github/workflows/snapshot-adapter-build.yml`
- Create: `release/contracts/schemas/snapshot-adapter-build-plan.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-adapter-build-proof.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-adapter-artifact-custody.v1.schema.json`
- Create: `scripts/release/create-snapshot-adapter-build-plan.mjs`
- Create: `scripts/release/create-snapshot-adapter-build-plan.test.mjs`
- Create: `scripts/release/create-snapshot-adapter-build-proof.mjs`
- Create: `scripts/release/create-snapshot-adapter-build-proof.test.mjs`
- Create: `scripts/release/verify-snapshot-adapter-build-workflow.mjs`
- Create: `scripts/release/verify-snapshot-adapter-build-workflow.test.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `packages/release-foundation/src/schema-registry.mjs`
- Modify: `scripts/release/build-snapshot-adapter.mjs`
- Modify: `scripts/release/verify-snapshot-adapter-bundle.mjs`

**Artifact identity:**

- OCI repository: `ghcr.io/keqi119/subscription-snapshot-adapter`.
- Immutable identity: registry-resolved OCI artifact digest containing the archive, SBOM and metadata; tag is discovery-only.
- Build proof binds exact `main` SHA, workflow path/blob SHA, run ID/attempt, Adapter archive/SBOM/file-manifest digests, Node.js runtime/version/archive/signing-material digests, dependency lock digest, builder/runner provenance, OCI digest and GitHub attestation subject.

- [ ] **Step 1: Write RED workflow trust tests**

Reject PR/fork/`pull_request_target`/comment/schedule/repository-dispatch/tag/non-main/rerun, mutable checkout/action refs, `ubuntu-latest`, missing `trusted-image-build`, missing `packages: write`/`id-token: write`/`attestations: write`, caller-selected script/archive and any output not bound to the final OCI digest.

- [ ] **Step 2: Add the pre-dispatch external-change contract**

`snapshot-adapter-build-plan.v1` binds an `infrastructureChangeId`, deterministic operation ID, exact merged main/workflow SHA, workflow path/blob/action digests, target OCI repository/tag policy, source/runtime/lock inputs, `trusted-image-build` Environment identity and no-overwrite policy. `create-snapshot-adapter-build-plan.mjs` performs read-only registry/workflow/Environment observations and exclusive-creates the canonical plan; the external I1 approval signs this digest before the deployment is released. A workflow dispatch without the approved plan is rejected.

- [ ] **Step 3: Implement a protected main-only build workflow**

Use manual `workflow_dispatch` on exact `refs/heads/main`, `run_attempt=1`, repository ID/actor checks and `ubuntu-24.04` under existing `trusted-image-build`. Checkout the exact workflow SHA with credentials disabled, run only the fixed Task 7 build/verify entrypoints and use pinned actions.

- [ ] **Step 4: Publish the dependency-closed Adapter as an OCI artifact**

Push the deterministic archive, SBOM and manifest together to the fixed GHCR repository, resolve the registry platform/artifact digest after upload and reject tag-only identity. Never publish from a PR artifact or local developer build.

- [ ] **Step 5: Issue attestation and complete custody readback**

Use GitHub artifact attestation, independently pull/re-hash archive/SBOM/manifest by OCI digest and verify provenance. Before accepting `snapshot-adapter-artifact-custody.v1`, the I0 control plane privately archives original build-plan/approval/proof/attestation/custody bytes with exact writer/reader separation and actual WORM readback. Actions carries only non-sensitive short delivery references (default30/max90), never the sole >=180-day evidence. Installable artifact remains digest-addressed in GHCR.

- [ ] **Step 6: Bind admission and root policy to the trusted artifact**

`snapshot-admission.v1` and the installed root policy must reference the Adapter OCI digest plus build-proof/custody digests. A local Task 7 bundle, PR artifact, mutable tag, same archive under a different unattested OCI manifest or proof from another main SHA must fail.

- [ ] **Step 7: Run workflow and proof tests**

```powershell
node --test scripts/release/create-snapshot-adapter-build-plan.test.mjs scripts/release/create-snapshot-adapter-build-proof.test.mjs scripts/release/verify-snapshot-adapter-build-workflow.test.mjs scripts/release/snapshot-adapter-bundle.test.mjs
node scripts/release/verify-snapshot-adapter-build-workflow.mjs --workflow .github/workflows/snapshot-adapter-build.yml
pnpm release:contracts:verify
pnpm prettier --check .github/workflows/snapshot-adapter-build.yml scripts/release release/contracts
git diff --check
```

- [ ] **Step 8: Commit without dispatching the producer**

```powershell
git add .github/workflows/snapshot-adapter-build.yml packages/release-foundation/src/schema-registry.mjs scripts/release/create-snapshot-adapter-build-plan.mjs scripts/release/create-snapshot-adapter-build-plan.test.mjs scripts/release/create-snapshot-adapter-build-proof.mjs scripts/release/create-snapshot-adapter-build-proof.test.mjs scripts/release/verify-snapshot-adapter-build-workflow.mjs scripts/release/verify-snapshot-adapter-build-workflow.test.mjs scripts/release/build-snapshot-adapter.mjs scripts/release/verify-snapshot-adapter-bundle.mjs release/contracts
git commit -m "ci: publish trusted snapshot adapter artifacts"
```

Expected: repository tests prove the producer contract, but no Adapter artifact is trusted until this commit is merged to `main` and Infrastructure Task I1 executes the protected workflow.

---

### Task 17B: Bind the API/Web/Runner bundle build to an approved merged-main plan

**Files:**

- Modify: `.github/workflows/docker-images.yml`
- Create: `release/contracts/schemas/three-image-bundle-build-plan.v1.schema.json`
- Create: `scripts/release/create-three-image-bundle-build-plan.mjs`
- Create: `scripts/release/create-three-image-bundle-build-plan.test.mjs`
- Create: `scripts/release/verify-three-image-bundle-workflow.mjs`
- Create: `scripts/release/verify-three-image-bundle-workflow.test.mjs`
- Create: `scripts/release/verify-prebuild-sanitized-input.mjs`
- Create: `scripts/release/verify-prebuild-sanitized-input.test.mjs`
- Modify: `scripts/release/create-build-proof.mjs`
- Modify: `scripts/release/verify-build-proof.mjs`
- Modify: `scripts/release/build-proof.test.mjs`
- Modify: `packages/release-foundation/src/schema-registry.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- `create-three-image-bundle-build-plan.mjs` performs read-only GitHub/registry/contract observations and exclusive-creates a canonical plan bound to `infrastructureChangeId`; it never allocates a `releaseAttemptId`.
- The existing `build-proof.v1` remains the immutable three-image identity. This task does not create a competing bundle fact; it makes the existing manual workflow reject any dispatch that lacks the approved plan for its exact merged-main SHA and inputs.
- Infrastructure Task I15B is the sole real execution of this producer before qualification I16.
- `verify-prebuild-sanitized-input.mjs` only validates an already-existing legal non-qualification input: original sanitization/source/ciphertext/expiry/private-custody facts and independently approved existing read/decrypt-use authority, against the exact prebuild source executor and input use. It creates `prebuild-sanitized-input-binding.v1`, never an input/credential/early attempt or new capability. No qualifying input or separate authority means `PREBUILD_SANITIZED_INPUT_UNAVAILABLE`; stop and request independent input design/approval, not v1 RC-consumer reuse or future Producer output.

- [ ] **Step 1: Write RED build-admission and workflow tests**

Reject a dispatch without a plan digest/custody reference, PR or non-main source, caller-selected checkout SHA, run attempt other than 1, mutable action/base-image material, tag-only identity, a plan produced for another workflow blob or source SHA, a changed Web public API Base, registry namespace/image coordinate drift, a partial API/Web/Runner set and any build proof not derived from all three registry-resolved platform digests.

Add RED unavailable/expired/qualification/public-only prebuild input, missing independent input-use/read/decrypt authority, fabricated existing artifact, future Producer reference, v1 capability widening, source Manifest/Runner proof, missing prebuild fresh or snapshot proof in build provenance, public retention180 and synthetic now+180 retention. These tests record current workflow shortcomings for later implementation; this document does not alter actual workflows.

- [ ] **Step 2: Define the pre-attempt bundle build plan**

`three-image-bundle-build-plan.v1` binds infrastructureChangeId/operation/exact merged-main/source-contract/lock/workflow/action/Environment/image-coordinate/API-Base/platform/no-overwrite/attestation identities, plus the already-existing `prebuild-sanitized-input-binding.v1` and independent input-use authority. It forbids current releaseAttemptId/Producer/RC IDs and future source results. The same protected build run must execute source fresh/snapshot before image build; their completed `source-gate-evidence.v1` digests enter build provenance/custody only after they exist. Neither creates Manifest/Runner execution proof nor carries current RC purpose.

- [ ] **Step 3: Require the approved plan before any build**

Keep `workflow_dispatch`, but replace ad hoc manual inputs with a content-addressed plan digest/reference plus the exact source SHA. The protected prepare job independently downloads/verifies plan custody, schema, signature/revocation, workflow blob and `GITHUB_SHA` before dependency download or Docker build. The human approval for its `trusted-image-build` deployment is distinct from plan approval and is allowed only after the pending deployment still matches the plan.

- [ ] **Step 4: Build and aggregate all three immutable images in one run**

After same-run source fresh/snapshot succeed using exact source checkout and approved prebuild input, build API/Web/Runner in parallel from that checkout. The aggregator reads registry platform digests, OCI source/base provenance/SBOMs and both completed prebuild source proofs plus input-binding/private archive receipts, then generates the existing build proof/provenance package. No future Producer supplies prebuild input. Missing chain/image, source/run mismatch or tag substitution fails the whole bundle. These prebuild proofs never substitute for post-Producer same-RC source rerun.

- [ ] **Step 5: Attest and read back bundle custody**

Use GitHub attestation and independently read back the build-plan/three-image/prebuild-input/source-provenance package. The I0 control-plane archive writer/reader preserves all original referenced bytes and actual Last-Modified/Locked-WORM retention evidence before bundle acceptance. Public Actions artifact is only non-secret short delivery (default30/max90); remove current retention180 and reject synthetic now+180 custody in workflow tests. Images remain GHCR digest-addressed. Include prebuild verifier/schema/source-workflow files in this task's explicit commit.

`create-build-proof.mjs` retains frozen build-proof.v1 image identity while preserving prebuild source/input provenance in its separately validated materials. `verify-build-proof.mjs` checkpoint requires raw build/custody proof plus authoritative private-custody observation and source/input provenance, not only an artifact receipt. Add build-proof tests for absent either prebuild chain, future input, synthetic retention, missing original bytes/observation and a valid v1 raw proof with failed authoritative checkpoint. Do not add unsupported fields to published raw v1.

- [ ] **Step 6: Run focused gates**

```powershell
node --test scripts/release/create-three-image-bundle-build-plan.test.mjs scripts/release/verify-three-image-bundle-workflow.test.mjs scripts/release/verify-prebuild-sanitized-input.test.mjs scripts/release/build-proof.test.mjs
node scripts/release/verify-three-image-bundle-workflow.mjs --workflow .github/workflows/docker-images.yml
pnpm release:contracts:verify
pnpm prettier --check .github/workflows/docker-images.yml scripts/release release/contracts
git diff --check
```

- [ ] **Step 7: Commit without dispatching a build**

```powershell
git add .github/workflows/docker-images.yml release/contracts packages/release-foundation/src/schema-registry.mjs scripts/release/create-three-image-bundle-build-plan.mjs scripts/release/create-three-image-bundle-build-plan.test.mjs scripts/release/verify-three-image-bundle-workflow.mjs scripts/release/verify-three-image-bundle-workflow.test.mjs scripts/release/verify-prebuild-sanitized-input.mjs scripts/release/verify-prebuild-sanitized-input.test.mjs scripts/release/create-build-proof.mjs scripts/release/verify-build-proof.mjs scripts/release/build-proof.test.mjs
git commit -m "ci: admit three-image builds from an approved main plan"
```

Expected: repository checks prove that an arbitrary manual invocation can no longer produce an eligible bundle. No image is built until the merged workflow is separately planned and approved in I15B.

---

### Task 18: Publish the operational runbook and pass the repository implementation gate

**Files:**

- Create: `docs/operations/stage1-s1-execution-infrastructure-runbook.md`
- Create: `docs/operations/templates/stage1-snapshot-bootstrap-approval.v1.json`
- Create: `docs/operations/templates/stage1-external-change-approval.v1.json`
- Create: `docs/operations/templates/stage1-three-image-bundle-build-plan.v1.json`
- Create: `docs/operations/templates/stage1-rc-dispatch-authorization-request.v1.json`
- Create: `docs/operations/templates/stage1-exact-capability-approval.v1.json`
- Create: `docs/operations/templates/stage1-exact-capability-approval.v2.json`
- Create: `docs/operations/templates/stage1-command-approval.v1.json`
- Create: `docs/operations/templates/stage1-snapshot-failure-record.v1.json`
- Create: `docs/operations/README.md`
- Create: `scripts/release/audit-task29r-qualification-package.mjs`
- Create: `scripts/release/audit-task29r-qualification-package.test.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Runbook boundary:**

The runbook documents commands that generate plans and readbacks, but every real `apply` section is a separately checked human gate. It may not embed credentials, mutable image tags, raw SQL/Shell payload paths or instructions to weaken a failed control.

- [ ] **Step 1: Document prerequisites and exact identity inventory**

Include approved content versus metadata commits, the observed Environment `ABSENT` baseline (re-read
before external work), immutable IDs, stash fingerprint, controlled datasource gate and no external
state at this checkpoint. Explain I15B build-before-attempt and the separate change/dispatch/exact/
command approvals. Provide distinct v1 snapshot/JIT and v2 lineage templates, never a v1 write profile;
validate both templates and all new Schemas/matrix/use/access contracts through repository digest tests.

- [ ] **Step 2: Document the ordered external change sequence**

Use exactly the Infrastructure Task I1–I24 order below, including the mandatory I15B bundle producer between I15 and I16. Each external mutation section names its plan/apply/readback CLI, proof path, operation ID, independent approval and UNKNOWN boundary; no paragraph may combine separate GitHub, Alibaba, Staging or WSL writes under one approval.

- [ ] **Step 3: Add failure and UNKNOWN recovery tables**

Cover Environment partial apply, OIDC drift, JIT route mismatch, cancelled jobs, snapshot/KMS/source/
LUKS/database/build/capacity ambiguity and lineage storage failure. Resource/DB UNKNOWN permits its
registered reconcile; claim/envelope partial/conflict/UNKNOWN permits diagnosis only and can never
become successful or resume writes/downstream. Document the exact write-response/readback difference
and the purpose→custody→aggregate→exit→stop/audit access-receipt order.

Implement qualification package audit negatives in the listed audit test file: v1 lineage credentials,
early approval, absent use/terminal/access proof, wrong matrix/key/version, public private-node bytes,
writer acknowledgment as readback, failed pair after diagnosis, qualification promotion and Task 30
stash mutation. Audit must verify trusted digest/attestation chains, not status flags.

- [ ] **Step 4: Add retention and access operations**

State snapshot expiry fixed from Producer run allocation+30 days; actual object Last-Modified plus GetBucketWorm Locked days must cover expiry+180 and downstream/legal hold. Ordinary referenced evidence needs >=180 days and actual private archive readback; Actions default30/max90 is never authority. Inventory original raw/plan/approval/revocation/use/access/failed/custody bytes and verify retention for each. WORM is bucket-wide; extension needs separate approval. Archive and crypto standalone contracts cannot widen v1/v2. Record current workflow retention180/fake now+180 as unresolved until Tasks4/6/15/17B implementation and real readback satisfy these gates.

- [ ] **Step 5: Run the complete repository gate**

```powershell
git status --short
pnpm install --frozen-lockfile
node --test scripts/release/audit-task29r-qualification-package.test.mjs
pnpm release:contracts:verify
pnpm release:database-tests:discover -- --mode verify
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm prettier --check .github apps packages scripts release infrastructure docs package.json
git diff --check
```

Then run all database suites against the controlled PostgreSQL 17 target through `with-controlled-target.mjs`. Required report equation: `collected = selected = executed = passed + failed`, with `failed=skipped=todo=filtered=cancelled=0` for every required fresh/snapshot suite.

- [ ] **Step 6: Audit the built artifacts without installing them**

Build the adapter bundle and API/Web/Runner images in CI-compatible local mode; verify the adapter allowlist/SBOM/digest and API image negative assertions. Do not copy the bundle into `/opt`, configure WSL, create an Environment, provision cloud resources or dispatch either workflow.

- [ ] **Step 7: Request code review and merge only after green CI**

Use the review checklist against the approved addendum, resolve findings task by task, push a PR and require every main-required check to pass. Record the merge SHA as the only eligible external-infrastructure source; do not use a pre-merge PR artifact as an installable trusted bundle.

- [ ] **Step 8: Stop at the external-change approval checkpoint**

Deliver the repository gate report, exact merged main SHA, controlled datasource migration status and proposed GitHub/Alibaba/Staging plan digests. Obtain new explicit authorization before I0; neither plan approval nor PR merge permits I0/I1 or other external action.

---

## External Infrastructure and Qualification Tasks

Repository Tasks 0–15, 16A–16C, 17A–17B and 18 must first be merged to `main` with required CI green. The user must then grant a new external-change authorization; plan approval or merge is not authorization to mutate GitHub, Alibaba Cloud, Staging or WSL. External tasks create no repository commits.

Bootstrap Tasks I0–I15B use `infrastructureChangeId`, never `releaseAttemptId`. At I0 create the non-secret change identity:

```powershell
$stage1MainSha = git rev-parse origin/main
node scripts/release/create-infrastructure-change.mjs --main-sha $stage1MainSha --owner-id 275060624 --output .release-local/infrastructure-change.v1.json
$stage1InfrastructureChangeId = (Get-Content -Raw .release-local/infrastructure-change.v1.json | ConvertFrom-Json).infrastructureChangeId
```

For each bootstrap mutation, create `.release-local/evidence/$stage1InfrastructureChangeId/$stage1OperationId/`, write canonical `plan.json`, obtain a separately signed human `approval.json`, pass approval/capability only by protected descriptors, then store `apply-proof.json`, `readback.json` and trusted-custody receipt. Lost/ambiguous apply becomes `INTERRUPTED_UNKNOWN`; only same-operation `reconcile` is legal until resolved.

### Infrastructure Task I0: Establish independent signing and private evidence custody

**CLIs:** fixed approved-source/runtime `manage-evidence-custody-bootstrap.mjs plan|apply|readback|reconcile` and `archive-release-evidence.mjs freeze|authorize|write|readback|reconcile`; no Adapter/Runner/OIDC dependency.

**Operation IDs:** independent `i0-signing-root-${infrastructureChangeId}`, `i0-private-store-${infrastructureChangeId}`, `i0-worm-lock-${infrastructureChangeId}` and exact archive writer/readback operations.

- [ ] Verify the existing human trust anchor and independently approve signer/public-key/revocation policy/executor source-runtime plan; establish protected Ed25519 signing with public-key challenge/readback. Initial approval/apply bytes are preserved in encrypted provisional escrow, not yet authoritative custody and not dependent on a future bucket receipt.
- [ ] Separately plan/approve actual private OSS bucket/ACL/logging/management and archive identity policies, apply/read back. Separately approve the irreversible bucket-wide 210-day WORM lock and read back GetBucketWorm Locked/ID/days. Management credentials never enter archive writer/reader processes. Existing matching infrastructure is verified and adopted by explicit approval, not silently replaced.
- [ ] Freeze the original three-document approval/signature/revocation chains from Task0 plus bootstrap plan/approval/apply/readback bytes and exact archive keys. Import originals unchanged from provisional escrow; no retroactive approval or replacement signatures. Independently authorize an exact conditional-create writer, terminate its session, then independently authorize reader Head/Get and verify bytes/digests/Last-Modified/actual WORM retention. Archive roles have no KMS/database/JIT/OIDC/management/lineage permissions.
- [ ] Close I0 only after original evidence and terminal/access receipts have authoritative private custody and the bootstrap readback is complete. Escrow alone, missing signer, future Adapter/I13/OIDC dependency, UNKNOWN mutation or deficient retention blocks I1 and canary. No mutation is retried under ambiguity; no bucket recreation or blind relock.

### Infrastructure Task I1: Plan, approve, publish and custody the trusted Adapter

**CLI:** `create-snapshot-adapter-build-plan.mjs`, then the exact merged-main `.github/workflows/snapshot-adapter-build.yml`.

**Operation ID:** `i1-adapter-build-${infrastructureChangeId}-${mainSha}`.

- [ ] Verify I0 terminal private custody/signing-root readback before I1. Use infrastructureChangeId; Adapter and three-image bundle must exist before I16 allocates any releaseAttemptId.
- [ ] Create a canonical plan that freezes exact main/workflow SHA, workflow blob/actions, OCI coordinate, source/runtime/lock inputs, `trusted-image-build` identity and forbid-overwrite policy; sign its digest before workflow dispatch.
- [ ] Dispatch only that workflow/ref, observe its pending `trusted-image-build` deployment, verify it still matches the plan, then separately approve the deployment. No PR/local artifact or caller-selected path is accepted.
- [ ] Read back the registry-resolved OCI digest, GitHub attestation, archive/SBOM/file-manifest/source provenance and content-addressed custody before accepting I1.
- [ ] Cancellation or publication ambiguity is UNKNOWN; reconcile workflow run and registry digest. Never overwrite a tag/digest or substitute a local rebuild.

### Infrastructure Task I2: Create and read back the Aliyun OIDC Provider

**Operation ID:** `i2-aliyun-oidc-provider-${infrastructureChangeId}`. Use `bootstrap-aliyun-oidc-provider.mjs plan|apply|readback|reconcile`; approve exact issuer, sole audience, independently derived fingerprints, one-hour issuance limit and ARN. Complete readback before subject customization; UNKNOWN never deletes a possibly pre-existing provider.

### Infrastructure Task I3: Create and read back the snapshot Environment

**Operation ID:** `i3-snapshot-environment-${infrastructureChangeId}`. Use `bootstrap-snapshot-environment.mjs`; approve only repository `1253231368`, Environment `stage1-snapshot-export`, reviewer `275060624`, main-only/no-tags, no admin bypass, `prevent_self_review=false`, timer zero. Freeze stable identity separately from observations; do not dispatch/approve a job here.

### Infrastructure Task I4: Create the dedicated launcher GitHub App

**Operation ID:** `i4-launcher-app-${infrastructureChangeId}`. Use `bootstrap-snapshot-launcher-app.mjs`; approve only repository Administration write for JIT and Actions/Contents/Deployments/Metadata read. Read back App/installation/repository/permission/key-public-fingerprint; deliver private key separately to root broker by descriptor. UNKNOWN may not create a second App/installation.

### Infrastructure Task I5: Verify existing storage and prepare KMS/crypto/broker delta

**Operation ID:** `i5-aliyun-base-custody-${infrastructureChangeId}`. Read back I0's existing private bucket/ACL/logging/versioning/WORM/archive identities; do not create them again. Independently plan/approve/apply/read back only missing KMS actual-key/alias and separate crypto-issuer/publisher-broker policies plus snapshot/v2 templates. No per-run session or retention role. Crypto issuer and publisher broker cannot assume one another's role. UNKNOWN stops; storage mismatch returns a separate change plan instead of duplicate ownership.

### Infrastructure Task I6: Revalidate actual bucket-wide retention

**Operation ID:** `i6-aliyun-retention-readback-${infrastructureChangeId}`. Read-only `--resource retention-lock` revalidates I0 exact GetBucketWorm ID/Locked/days and I5 identity. It does not lock a namespace or repeat I0 apply. Demonstrate Last-Modified+locked days covers required object retention, downstream and legal hold; insufficient protection needs a separately approved bucket-wide extension affecting all objects. No retention runtime role/session; UNKNOWN blocks later work.

### Infrastructure Task I7: Allocate and provision the OIDC canary identity

**Operation ID:** `i7-oidc-canary-role-${infrastructureChangeId}-${canaryRunId}`. Verify I0 independent signer/archive and I2/I3 readbacks; obtain a separately approved fixed dispatch intent, dispatch exact canary workflow/main SHA, record actual canaryRunId/attempt1 and pending deployment. Independently approve/apply/read back the exact future-subject canary role and all attached/inline policies with no data/business Allow or chaining. Do not request token or approve Environment. This step creates no release attempt and uses no v1/v2 runtime approval.

- [ ] Before the real probe dispatch, independently approve/establish/read back exact canary-state ref/genesis/protection/publisher and run the Task13 actual no-cloud capsule/checkpoint/review/H1/H2 handoff suite with id-token:none and all cloud/OIDC counters zero. Stop on every unavailable/failed/UNKNOWN case; `HANDOFF_VERIFIED_NO_OIDC` is not canary success. Then allocate the real probe run via separately approved dispatch intent identified by preallocated operation nonce; only the post-dispatch role operation above uses actual canaryRunId.

### Infrastructure Task I8: Switch repository subject and complete the canary

**Operation ID:** `i8-github-oidc-subject-${infrastructureChangeId}`. After I2/I7 actual readbacks, separately approve/apply/read back repository subject customization, preserving existing-consumer compatibility. Now sign/custody `bootstrap-canary-run-authorization.v1` with I0 root and actual prerequisite/run/pending-deployment facts; independently approve only this Environment deployment, obtain fresh observation, perform one AssumeRoleWithOIDC then one GetCallerIdentity. Archive redacted use/session-terminal/actual GitHub terminal proof externally; canary cannot self-certify its unfinished run. UNKNOWN requires independent exact-fact reconciliation and a new authorized attempt, not replay. No cloud testing has occurred merely because this design is written; real success is required before later data execution.

- [ ] After authorization custody and before deployment approval, independently approve/write/read back immutable <=48KB capsule; freeze exact read contract, prohibit shadowing/overwrite. After real review/job IDs exist, publish signed checkpoint, independently GET review/deployment facts and perform H1/H2 online revocation admission. Missing/stale/403/revoked/changed/unverifiable state or timeout is PREFLIGHT_REJECTED before OIDC. Only after the separate no-cloud I7 checkpoint and real online admission pass may the two-API probe run. Archive final `bootstrap-canary-execution-proof.v1` and actual expiry/terminal proof; no v1/v2 fallback.

### Infrastructure Task I9: Publish the Staging loopback database endpoint

**Operation ID:** `i9-staging-loopback-${infrastructureChangeId}`. Use `manage-staging-snapshot-boundary.mjs --resource loopback-endpoint`; plan/approve exact host/project/container and `127.0.0.1:55432:5432`, apply/read back binding and health, and prove no external reachability. UNKNOWN precedes any restart.

### Infrastructure Task I10: Create the forwarding-only SSH account

**Operation ID:** `i10-staging-ssh-${infrastructureChangeId}`. Use `--resource ssh-account`; approve exact user/key/permit-open, apply validated sshd policy, read back account/key/options, and prove Shell/PTY/SFTP/agent/X11/remote/dynamic/other-destination denial. Never touch administrator SSH.

### Infrastructure Task I11: Create the read-only Staging database role

**Operation ID:** `i11-staging-db-reader-${infrastructureChangeId}`. Use `--resource database-reader`; approve only exact database/OID and committed infra SQL. Apply with separate admin descriptor, revoke it, read back through verify identity, and prove SELECT succeeds while DML/DDL/owner/role/large-object/RLS bypass fails.

### Infrastructure Task I12: Create and qualify the dedicated WSL distro

**Operation ID:** `i12-wsl-distro-${infrastructureChangeId}`. Use `manage-snapshot-wsl-host.mjs --resource distro`; bind host/rootfs/Runner/capacity/isolation/egress facts, approve/apply/read back exact distro, and prove no Docker/sudo/Windows mount/PATH/swap/auto-update/general Runner. UNKNOWN never affects another distro.

### Infrastructure Task I13: Install WSL admission signing policy beneath the existing root

**Operation ID:** `i13-admission-signer-${infrastructureChangeId}`. Use `--resource admission-signer`; independently approve the WSL admission signer/policy placement under I0's already-established trust chain, apply/read back public digest/challenge, and prove Runner/workflow cannot read/replace/invoke it outside fixed verification. I13 does not bootstrap the I0/canary signer or archive and is not their dependency. UNKNOWN never regenerates over an unknown key.

### Infrastructure Task I14: Install the attested Adapter by digest

**Operation ID:** `i14-adapter-install-${infrastructureChangeId}`. Use `--resource adapter-install`; bind I1 OCI/build/custody and I12 host readback, approve/pull strictly by digest, verify and install allowlisted root-owned files, then read back path/owner/mode/digest/unit/root policy. Local/tag/PR fallback is forbidden.

### Infrastructure Task I15: Run the closed synthetic qualification rehearsal

**Operation ID:** `i15-synthetic-rehearsal-${infrastructureChangeId}`. Invoke the installed fixed rehearsal by request FD against isolated PostgreSQL 17 only. Separately approve its closed suite/fault matrix; prove success and every cancellation/route/SSH/write/sanitizer/KMS/OSS/destruction/cross-run denial; reconcile all UNKNOWN and leave host idle before real data.

### Infrastructure Task I15B: Build and custody the exact API/Web/Runner bundle

**CLIs:** `create-three-image-bundle-build-plan.mjs`, exact merged-main `.github/workflows/docker-images.yml`, `verify-three-image-bundle-workflow.mjs`, existing build-proof/custody verifiers.

**Operation ID:** `i15b-three-image-bundle-build-${infrastructureChangeId}-${mainSha}`.

**Required proofs:** existing legal non-qualification sanitized input/private custody/independent read-decrypt-use authority, prebuild input binding, signed build plan/revocation, protected deployment, same-run source fresh/snapshot proofs, workflow/run identity, three registry digests/source revisions, build provenance/attestation, actual private archive retention readback and externally observed workflow terminal state.

- [ ] Before build dispatch, run `verify-prebuild-sanitized-input.mjs` on an already-existing legally retained, unexpired, non-qualification input and independently approved existing input-use/read/decrypt authority. Availability is not established by this plan. Missing any input/authority stops with `PREBUILD_SANITIZED_INPUT_UNAVAILABLE`; request separate input-supply design/approval, do not dispatch future Producer, mint an early attempt, fabricate artifact or borrow v1 RC-consumer authority.
- [ ] Create/custody the canonical build plan bound to that input binding, exact workflow/actions/registry/API-Base/source/contract/lock/no-overwrite facts; obtain independent human approval before dispatch.
- [ ] Dispatch only `.github/workflows/docker-images.yml@main` with the approved plan digest/reference and exact SHA. Observe the pending `trusted-image-build` deployment, verify plan/Environment identity, then approve that deployment separately. No ad hoc manual build input, PR artifact, local image or rerun is eligible.
- [ ] Require same-run prebuild source fresh/snapshot success using exact source executor before all three image builds; include both source proofs/input binding in build provenance. Resolve all three registry digests, attest and privately archive/read back original provenance and actual retention. No Manifest/Runner execution proof in prebuild source, no current attempt Producer input and no substitution for later same-RC source rerun.
- [ ] If build/publication/custody is UNKNOWN, preserve its run and registry facts and reconcile this operation only; never overwrite or substitute one image. I16 remains blocked until one complete I15B proof set is terminal success.

I16 begins a distinct qualification release attempt. Its evidence root is `.release-local/evidence/${releaseAttemptId}/`; every operation below has its own plan/approval/apply/readback/custody chain where applicable. `releaseAttemptId` MUST NOT exist before I16 verifies the final I15B source build proof and bundle.

### Infrastructure Task I16: Allocate qualification attempt and dispatch authorization

**CLIs:** `create-release-attempt.mjs`, `create-rc-dispatch-authorization.mjs`.

**Operation ID:** `i16-qualification-dispatch-${releaseAttemptId}`.

- [ ] Verify exact merged main/source SHA, the I15B trusted API/Web/Runner build proof and immutable bundle, repository/migration/test/sanitization digests, I1 Adapter custody and I2–I15 readbacks.
- [ ] Only now allocate a new `releaseAttemptId`; generate/sign/custody `rc-dispatch-authorization.v1` with `executionPurpose=qualification`, fixed Producer/RC workflows and expected identities.
- [ ] Verify issuer, validity, revocation set and custody. The authorization contains no `snapshotRunId`, `rcWorkflowRunId`, database, Manifest, command or plan. Failure stops before any Producer dispatch.

### Infrastructure Task I17: Dispatch Producer and provision data-job prerequisites

**CLIs:** fixed Producer dispatch, root launcher `prepare`, `create-exact-capability-approval.mjs`, `manage-exact-run-capability.mjs plan|apply|readback`, `create-producer-crypto-authorization.mjs`, `manage-producer-crypto-capability.mjs plan|apply|readback`.

**Operation IDs:** pre-dispatch `i17-producer-dispatch-${releaseAttemptId}-${operationNonce}` uses an already allocated fixed operation nonce; its later receipt binds actual snapshotRunId. Only subsequent role operations use `i17-publisher-role-${releaseAttemptId}-${snapshotRunId}`, `i17-jit-prerequisite-${releaseAttemptId}-${snapshotRunId}` and `i17-producer-crypto-${releaseAttemptId}-${snapshotRunId}`. Dispatch plans never contain a future run ID.

**Required proofs:** actual Producer run/allocation time/pending deployment, root admission verification, three independent prerequisite plan/change-approval/apply/readback chains, unchanged v1 publisher/JIT approvals and standalone crypto authorization. No content digest or credential-use proof exists yet.

- [ ] Dispatch exact Producer from the authorization, obtain `snapshotRunId`/attempt 1, complete admission and observe only the `snapshot-data` pending deployment; custody is dependency-blocked and cannot yet be pending or approved.
- [ ] Freeze slot-v2 exact output keys and KMS context from actual run/attempt/source/sanitization policy and expiry=run allocation+30 days. No ciphertext/snapshot digest or future result enters role/policy/approval. Separately plan/approve/apply/read back publisher, JIT and crypto prerequisites; do not issue credentials/JIT config or approve data. UNKNOWN blocks I18.
- [ ] Bind each actual readback into its own v1 publisher/JIT approval or standalone crypto authorization, with exact job/pending deployment/Environment identity. Keep deployment pending; v1/v2 contract matrices remain unchanged.

### Infrastructure Task I18: Separately approve and execute snapshot-data

**CLIs:** GitHub deployment review API through the closed launcher, root launcher `launch-data`, root broker `issue-publisher-sts --credential-fd`, Adapter fixed `snapshot-job launch --admission-ref`.

**Operation IDs:** `i18-data-deployment-${releaseAttemptId}-${snapshotRunId}`, plus separate crypto, publisher and JIT use-proof/archive operations.

**Required proofs:** data Environment review/observation, JIT launch/terminal, crypto GenerateDataKey/process/session terminal, publisher use/session terminal, exact-slot encrypted/sanitization/source proofs, external control-plane archive/readback and LUKS destruction.

- [ ] Human-approve only data after all three independent prerequisite/readback/approval chains; read back fresh observation and revalidate all three without cross-contract substitution.
- [ ] Root launcher verifies exclusive route, requests one JIT configuration, starts the ephemeral Runner and confirms the fixed Adapter child owns the job and is ready on its sealed credential FD.
- [ ] Export/sanitize/scan inside the isolated volume. Only the fixed crypto child receives separate generate-only short credential, obtains one DEK and encrypts with layered context/AAD. Clear key, terminate crypto process and revoke/confirm session expiry before any publisher STS. UNKNOWN GenerateDataKey is not automatically retried.
- [ ] Only then issue one <=900-second OSS-only publisher session to its ready sealed-FD child and conditionally create only frozen exact slots. `data-result` cannot contain its own upload/session-terminal fact. After publishing, independent control plane records/archives publisher/JIT/crypto terminal and volume-destruction proofs; no completed publisher is restarted to attest itself. No prefix grants or future-digest targets.
- [ ] STS/JIT/upload/destruction ambiguity is UNKNOWN; do not mint another credential or rerun data under this attempt. Reconcile exact session/runner/object/volume facts.

### Infrastructure Task I19: Separately approve custody and freeze Producer completion

**CLIs:** `create-exact-capability-approval.mjs`, `manage-exact-run-capability.mjs plan|apply|readback|revoke`, GitHub deployment review API and fixed custody-continuation workflow job.

**Operation IDs:** `i19-custody-role-${releaseAttemptId}-${snapshotRunId}`, `i19-custody-deployment-${releaseAttemptId}-${snapshotRunId}`.

**Required proofs:** custody exact-capability approval/prerequisite readback, separate Environment review/observation, OIDC cloud-role use/revocation proof, ciphertext-only custody/attestation and Producer completion.

- [ ] Only after I18 data/object/destruction proofs are durable, observe custody pending deployment; plan its exact Provider/subject/role/policy, obtain an independent external-change approval, apply/read back the role, and only then create its Producer-lane `oidc-cloud-role` approval bound to that readback.
- [ ] Role allows exact ciphertext/proof readback and attestation only; KMS Decrypt, plaintext restore, publisher write and list are denied. Human-approve custody separately, generate its own fresh observation, then request OIDC.
- [ ] Read back ciphertext/proofs plus independently archived crypto/publisher/JIT terminal and destruction receipts; attest non-sensitive internal completion without current custody-job/run terminal fields. Complete custody credential termination and external archive. After actual Producer workflow terminates, the independent controller reads actual run/jobs terminal success before dispatch; RC entry repeats that readback. Unresolved UNKNOWN blocks dispatch/admission.

### Infrastructure Task I20: Dispatch qualification RC and provision source-snapshot consumer

**CLIs:** `gh workflow run release-candidate-gate.yml --ref main`, `create-exact-capability-approval.mjs`, `manage-exact-run-capability.mjs plan|apply|readback|revoke`, fixed source-gate launcher.

**Operation IDs:** pre-dispatch `i20-rc-dispatch-${releaseAttemptId}-${operationNonce}` has an already allocated fixed nonce; the receipt adds actual rcWorkflowRunId. The later role operation is `i20-source-consumer-${releaseAttemptId}-${rcWorkflowRunId}`; reject a dispatch plan requiring future run ID.

**Required proofs:** independent actual Producer run/jobs terminal readback at dispatch and RC entry, RC allocation/admission, source consumer approval/readback/Environment observation/use/revocation, two `source-gate-evidence.v1` proofs and source/database observations; no formal Manifest or Runner execution proof.

- [ ] Independently verify actual Producer GitHub run/all required jobs terminal success plus I19 completion/private archive against dispatch authorization, then dispatch RC and obtain actual rcWorkflowRunId/attempt1. RC entry independently repeats terminal/source/run verification before protected work; no external source/final/aggregate/exit proof is accepted.
- [ ] For source-snapshot only, after its job/pending deployment exists, plan the exact object/version/KMS-decrypt role, obtain an independent external-change approval, apply/read back the role, then create the RC-lane `oidc-cloud-role` approval binding that readback. Separately approve `trusted-source-database-gate`, then create a fresh observation before OIDC use.
- [ ] Rerun source fresh/snapshot using exact source executor and separate temporary databases; emit only source-gate-evidence.v1, never Manifest/Runner execution proofs. Use new Producer input, not prebuild or qualification evidence. Revoke/read back source consumer and privately archive raw/use/terminal evidence.

### Infrastructure Task I21: Provision final-snapshot consumer and execute final chains

**CLIs:** `create-exact-capability-approval.mjs`, `manage-exact-run-capability.mjs plan|apply|readback|revoke`, fixed final-compose launcher and Playwright verifier.

**Operation ID:** `i21-final-consumer-${releaseAttemptId}-${rcWorkflowRunId}`.

**Required proofs:** final consumer approval/readback/Environment observation/use/revocation, final fresh/snapshot raw v1 proof sets, image/session/network/test-equation evidence and failure custody if applicable.

- [ ] Repeat the full RC-lane `pending deployment → prerequisite plan/change approval/apply/readback → exact-capability approval → separate trusted-release-execution approval → fresh observation → credential use` sequence for final-snapshot; it cannot reuse I19 or I20 role, approval, observation, credential or use proof.
- [ ] Run final fresh/snapshot on digest-pinned API/Web/Runner with separate database/Manifest/operation IDs, real API session identity, Playwright network capture and complete zero-skip equation. Fresh database roles use only the runner-database branch.
- [ ] Command-leaf envelopes reference neither source/final parent nor self; completed final parent references matching same-RC source and ordered command leaves. Reject cycles, source masquerading as execution and cross-run/prebuild-source substitution.
- [ ] Preserve failure/UNKNOWN proof, revoke/read back final consumer and never replace a bundle component or import final evidence.

### Infrastructure Task I22: Wrap and custody every raw v1 proof

**CLIs:** `create-execution-purpose-envelope.mjs`, `custody-purpose-envelope.mjs prepare|store|readback|custody|diagnose`, `manage-exact-run-capability.mjs plan|apply|readback|revoke`, `create-exact-capability-approval.mjs`; phases are selected only by the fixed workflow job and signed request descriptors.

**Operation IDs:** `i22-purpose-envelope-${releaseAttemptId}-${rcWorkflowRunId}-${rawProofDigest}`, with separate `-claim-envelope-write`, `-claim-envelope-readback`, `-v2-custody-write` and `-v2-custody-readback` capability operations.

**Required proofs:** raw custody; for each exact job instance, frozen plan/exact keys and digests,
change approval/apply/readback, **v2** approval, separate Environment observation,
`lineage-oss-role-use-proof.v1`, terminal revoke/expiry, conditional-create and independent readback.
Purpose and custody each have their own later `lineage-storage-access-receipt.v1`. Under the existing
attempt evidence root, each operation separately retains `plan.json`, `approval.json`,
`apply-proof.json`, `readback.json`, `capability-approval.v2.json`, `environment-observation.json`,
`use-proof.json`, `terminal.json` and non-sensitive receipt/custody references; no secrets/node bodies.

- [ ] In the same RC run, validate/read back each raw source/execution/final-compose v1 proof; derive `qualification` only from fixed workflow plus dispatch authorization.
- [ ] Freeze typed envelope, raw-derived claim and both exact keys/digests. At `lineage-purpose-store`
      pending deployment, independently approve/apply/read back its writer prerequisite, then issue v2
      `lineage-oss-role` approval before that job's `trusted-release-execution` review/observation. Do not
      preapprove the later reader or grant a namespace prefix.
- [ ] Writer condition-creates claim, receives an explicit successful response, then creates envelope.
      It cannot read either object. On any failure/conflict/UNKNOWN stop as specified by Task 16B, without
      continuing a partial pair. Record writer use and revoke/expiry before reader credential eligibility.
- [ ] At `lineage-purpose-readback` pending deployment, independently plan/approve/apply/read back
      its reader role, issue v2 approval, obtain its own Environment review/observation, and read only the
      two frozen keys. Validate canonical bytes, versions, digests and bindings; terminate reader and
      generate purpose access receipt only for an entirely successful attempt.
- [ ] Build custody referencing that receipt and both objects, freeze custody bytes/key/digest, then
      run `lineage-custody-store` and `lineage-custody-readback` with independent v2/Environment/use/
      terminal chains. Emit custody's external access receipt; never embed it back into custody.
- [ ] Reject direct raw-v1, second purpose, changed key, public bytes, v1 lineage credentials, wrong
      matrix/profile/instance, combined credentials, or any partial/conflicting/UNKNOWN/mismatched
      lineage. Read-only `diagnose` may preserve findings but cannot generate successful receipt or resume
      this attempt; next execution requires new operation/run/raw proofs and complete lineage.

### Infrastructure Task I23: Aggregate qualification and stop before Task 30

**CLIs:** `aggregate-release-proof.mjs`, `generate-s1-exit-evidence.mjs`, `manage-exact-run-capability.mjs plan|apply|readback|revoke`, fixed lineage store/readback jobs, final capability revoke/readback and exact temporary-database cleanup.

**Operation ID:** `i23-qualification-tail-${releaseAttemptId}-${rcWorkflowRunId}`.

**Required proofs:** same-run custody access receipts; aggregate and exit each have independent v2
writer/reader approval/use/Environment/terminal proofs and their later access receipt. Include
promotion rejection, successful receipt custody, exact cleanup and stop proof bound to exit access.

- [ ] Verify I22's same-run custody/access chain and reconstruct aggregate in memory through the pure
      builder; no additional cloud reader or arbitrary private fetch. Freeze digest/key before the exact
      `lineage-aggregate-store` prerequisite and v2 approval. Independently approve its Environment, store
      and terminate writer; only then admit separately approved `lineage-aggregate-readback`. Both jobs
      use `trusted-release-candidate`. Verify access receipt after actual readback.
- [ ] Generate exit with aggregate digest and **aggregate access receipt**. Freeze it and repeat the
      ordered gates for `lineage-exit-store` then `lineage-exit-readback`; generate exit's later access
      receipt for the stop proof, not exit itself. No external final/aggregate/exit, same-node storage
      reference, v1 fallback, combined role or repaired failed pair is accepted.
- [ ] Require `assertPromotionEligible` to return `QUALIFICATION_EVIDENCE_NOT_PROMOTABLE`; also reject raw-v1 direct input, missing/mixed purpose and different dispatch/attempt.
- [ ] Verify all sessions revoked/expired and private node plus non-sensitive access-receipt custody
      durable before exact marker-bound cleanup. Prove no lineage-retention role/session was created;
      later disposition needs a separate whole-lineage/legal-hold plan and human approval. Emit
      `TASK_30_AUTHORIZATION_REQUIRED` bound to exit access receipt and stop; do not run Task 30 audit.

### Infrastructure Task I24: Deliver the Task 29R package and request authorization

**CLI:** read-only `scripts/release/audit-task29r-qualification-package.mjs --attempt ... --rc-run ...`; no mutation, stash or Task 30 command is supported.

**Required proof:** signed package index and audit report covering every I0-I23 digest plus explicit `TASK_30_AUTHORIZATION_REQUIRED` terminal state.

- [ ] Assemble main/I15B build/bundle/Adapter identities, I2–I15 readbacks, I16 authorization, I19
      Producer completion, I20–I23 raw/envelope/custody/aggregate/exit plus every v2 approval/use/access
      receipt, terminal and private storage/retention fact. Preserve failed-pair diagnostic records and
      prove none was reclassified as successful or reused by the selected lineage.
- [ ] Prove no JIT Runner, unlocked volume, plaintext, active per-run credential or unresolved UNKNOWN remains; Task 30 stash fingerprint is unchanged.
- [ ] Report manual/N/A evidence, accepted single-operator risk, retained WORM objects and owners. Ask for explicit Task 30 authorization; until granted, do not apply/pop/drop stash, implement Task 30, declare S1 complete or start S2/S3.

## Specification Coverage Matrix

Coverage below is routing for this cross-document revision, not approval/completion. Canary uses its confirmed independent narrow contract and still requires real cloud evidence; it is not a v1/v2 runtime job.

| Approved addendum requirement                                 | Implementation tasks                     | Completion evidence                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Independent I0 signing/archive with non-circular bootstrap    | 4, 6, 13, 17A-18; I0-I1                  | Existing human anchor, original escrow bytes privately archived/read back, actual WORM, no future Adapter/OIDC |
| Separate crypto and fixed pre-existing snapshot slots         | 2, 4-7, 9, 13-14; I17-I19                | Standalone crypto authorization/terminal then OSS-only publisher, context/AAD separation, exact five keys      |
| Source/final leaf-parent DAG and Producer terminal separation | 2, 15-16A; I19-I23                       | Independent source and command leaves→final parent, independent actual Producer terminal admission             |
| Conditional lawful prebuild sanitized input                   | 17B; I15B                                | Existing input/independent read-decrypt-use authority, prebuild source provenance, unavailable hard stop       |
| Confirmed narrow canary and real cloud gate                   | 13; I0, I7-I8                            | Independent authorization, prerequisite readbacks, two API calls, externally archived terminal observation     |
| Build/bundle before attempt and dispatch authorization        | 2, 16A, 17B; I15B, I16                   | Approved build plan, three registry digests, custody, new attempt and authorization                            |
| Independent Producer, then one same-run RC chain              | 2, 3, 9, 14-16C; I17-I23                 | Admission/JIT/Producer proofs plus same-run DAG checkpoint                                                     |
| Public-repository exclusive JIT routing                       | 2, 3, 8, 9, 13-14; I3-I4, I7-I8, I12-I19 | Environment identity, route observation, exact labels, terminal cleanup                                        |
| No arbitrary repository code on data host                     | 7-9, 14, 17A; I1, I12-I15                | Adapter allowlist/SBOM, workflow structural audit, negative launch tests                                       |
| Trusted Adapter main artifact chain                           | 7, 17A; I1, I14                          | Approved build plan, OCI digest, attestation, custody and installed-file readback                              |
| Dedicated WSL, LUKS and truthful destruction                  | 8; I12-I19                               | Host policy, LUKS lifecycle proof, destruction receipt                                                         |
| Restricted SSH/read-only PostgreSQL source                    | 10-11; I9-I11, I17-I19                   | Target policy, privilege negatives, source fingerprints, MVCC proof                                            |
| Valid PostgreSQL 17 snapshot semantics                        | 0, 10-11, 15; I15, I20-I21               | Controlled migration status and three-session MVCC test                                                        |
| Private encrypted and purpose-lineage custody                 | 4-6, 14-16C; I5-I6, I15-I23              | Snapshot plus create-only writer/read-only reader lineage and retention proofs                                 |
| Producer custody never decrypts                               | 6, 13-15; I19-I21                        | Producer KMS-decrypt denial and independent RC consumer decrypt proofs                                         |
| Prerequisite readback before exact capability approval        | 2, 13-16B; I7-I8, I17-I23                | Change approval/apply/readback precedes exact approval and Environment release                                 |
| Three approval types and capabilityKind union                 | 2, 13, 16A; I7-I8, I16-I23               | Dispatch, exact-capability and command approvals with mutually exclusive use proofs                            |
| Frozen v1 and forward v2 lineage-only job/profile matrix      | 4, 6, 13, 16A-16C, 18; I22-I24           | Separate v2 Schema, exact keys, prerequisite-before-approval and per-job use/terminal proofs                   |
| Two-job claim/envelope; failed pairs cannot resume            | 16B, 18; I22-I24                         | Claim-success-before-envelope trace, independent pair readback, permanent failed/UNKNOWN admission denial      |
| Downstream-only access receipts; no own-storage cycle         | 13, 16B-16C, 18; I22-I24                 | Purpose access → custody; custody access → aggregate; aggregate access → exit; exit access → stop              |
| Double Producer Environment approval                          | 3, 13-14; I17-I19                        | Separate data/custody pending deployments, approvals, observations and use proofs                              |
| Environment identity versus observation                       | 2-3, 13-14; I3, I7-I8, I17-I21           | Stable identity digest, per-deployment fresh observation and drift negatives                                   |
| Capacity and fixed GitHub-hosted identity                     | 12, 15, 17A-17B; I1, I15-I15B, I20-I23   | Capacity plans and runner provenance for build/source/final/custody chains                                     |
| One-to-one raw v1 purpose wrapping                            | 16A-16C; I22-I23                         | Raw custody, create-only claim, typed envelope, v2 custody and no direct-v1 aggregation                        |
| Machine-isolated qualification evidence                       | 16C; I20-I24                             | Qualification aggregate/exit and expected promotion rejection                                                  |
| Snapshot and lineage retention/disposition                    | 4, 6, 16B, 17A; I5-I6, I15-I24           | 30-day expiry, locked 210-day WORM and whole-lineage disposition receipts                                      |
| Failure, cancellation, UNKNOWN and reconcile                  | 2-9, 13-18; I1-I24 including I15B        | Failure proofs, reconciliation chain and preserved immutable attempts                                          |
| Task 29R dependency gate; Task 30 blocked                     | 1, 16C, 18; I23-I24                      | `TASK_30_AUTHORIZATION_REQUIRED`, non-promotable qualification and stash audit                                 |

## External Approval Checkpoints

| Checkpoint | Bound plan/change                                                     | Approval does not authorize                                           |
| ---------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| I0         | Independent signer/store/Locked-WORM and exact archive chain          | I1 build, data use, future Adapter/OIDC, escrow as final custody      |
| I1         | Adapter build plan plus protected deployment                          | Local artifact, Adapter install or infrastructure creation            |
| I2         | Aliyun OIDC Provider exact identity                                   | GitHub subject customization or RAM role creation                     |
| I3         | Snapshot Environment creation                                         | Any workflow deployment approval                                      |
| I4         | Launcher App/installation and private-key delivery                    | JIT registration or workflow execution                                |
| I5         | Existing-storage verification plus approved KMS/crypto/broker delta   | Recreate/relock I0 storage, per-run credential, Staging/data use      |
| I6         | Actual bucket-wide WORM retention readback                            | Lock/relock/extend without new approval, Producer/RC execution        |
| I7         | Exact canary cloud capability                                         | Repository subject change or Environment approval                     |
| I8         | Repository subject switch and canary deployment                       | Any data workflow                                                     |
| I9-I11     | Three separate Staging endpoint/SSH/database changes                  | Another resource, export or business write                            |
| I12-I14    | Distro, signer and Adapter install as separate changes                | JIT registration or data access                                       |
| I15        | Synthetic rehearsal                                                   | Staging credentials/data                                              |
| I15B       | Exact merged-main API/Web/Runner build plan and protected run         | `releaseAttemptId`, Producer/RC dispatch or partial-bundle use        |
| I16        | Qualification attempt and dispatch authorization                      | Producer/RC dispatch                                                  |
| I17        | Producer dispatch plus independent publisher/JIT/crypto prerequisites | Data Environment release, credentials, future digest or prefix grants |
| I18        | Data approval; JIT then isolated crypto terminal then publisher       | Combined credentials, custody/RC approval or retry under ambiguity    |
| I19        | Separate custody capability/deployment and Producer completion        | KMS Decrypt, RC dispatch before terminal readback or changed data     |
| I20        | RC dispatch and independent source-snapshot consumer                  | Final consumer, aggregate, promotion or Task 30                       |
| I21        | Independent final-snapshot consumer and final execution               | External final evidence, promotion or Task 30                         |
| I22        | Per-node lineage writer/readback roles and purpose custody            | Combined credentials, public storage, rewrapping or direct-v1 use     |
| I23        | Aggregate/exit lineage roles, custody and terminal cleanup            | Promotion, Task 30, S1 completion or evidence reuse                   |
| I24        | Review decision                                                       | Only a new explicit authorization may resume Task 30                  |

## Stop and Recovery Matrix

Before execution this cross-document revision requires approval; I0, real canary and legal prebuild input remain evidence gates. No row permits v1/v2 widening, substitute approvals, assumed input availability or an early attempt.

| Condition                                                                        | Required response                                                                                                                                                         | Prohibited shortcut                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| I0 signer/archive or actual retention unavailable                                | Stop I1; preserve provisional escrow; reconcile separately approved exact bootstrap operation                                                                             | Future Adapter/OIDC/I13 root, escrow as final custody, fake now+180                                       |
| Prebuild sanitized input/use authority absent or expired                         | `PREBUILD_SANITIZED_INPUT_UNAVAILABLE`; stop I15B, request separate input design/approval                                                                                 | Future Producer, qualification reuse, fabricated artifact or expanded v1 consumer                         |
| Publisher KMS permission, future digest slot/context or crypto/publisher overlap | Reject before credentials; preserve denial                                                                                                                                | Expand v1/v2, grant prefix, preissue STS, retry GenerateDataKey                                           |
| Producer completion self-certifies current run terminal                          | Reject; obtain later independent actual GitHub terminal readback                                                                                                          | RC dispatch on unfinished/unknown/caller-asserted run                                                     |
| Source masquerades as final execution or proof DAG is cyclic                     | Reject source/final/aggregate admission                                                                                                                                   | Manifest on source, command referencing final parent/self                                                 |
| Controlled PostgreSQL 17 migration status fails                                  | Stop before code implementation and diagnose migrations                                                                                                                   | Treating Prisma validation as migration proof                                                             |
| Existing OIDC consumer cannot accept exact subject                               | Stop 方案 A，return to infrastructure design                                                                                                                              | Replacing exact claims with wildcard                                                                      |
| Environment absent/misconfigured or bypass occurs                                | Reject admission; reconcile GitHub state                                                                                                                                  | Manual assertion that approval occurred                                                                   |
| Exact approval predates prerequisite readback                                    | Reject approval and keep deployment pending; redo from a new operation                                                                                                    | Reusing the early approval or approving Environment                                                       |
| Data/custody approval or observation is shared                                   | Reject Producer attempt and preserve deployment facts                                                                                                                     | Treating sequential jobs as one Environment approval                                                      |
| Publisher credential is issued before Adapter ready                              | Revoke/wait expiry; mark attempt unusable                                                                                                                                 | Reusing approval/session or injecting credential into job env                                             |
| Producer custody receives KMS Decrypt                                            | Revoke role and reject Producer completion                                                                                                                                | Claiming ciphertext verification also required decryption                                                 |
| OSS/KMS/RAM policy broader than contract                                         | Disable new principals; preserve readback/failure proof                                                                                                                   | Reusing business bucket or application credentials                                                        |
| WORM configured incorrectly after lock                                           | Disable access and retain until disposition is legal                                                                                                                      | Deleting/recreating evidence or claiming rollback                                                         |
| Source identity has write/owner/RLS bypass                                       | Disable role/account and block snapshot                                                                                                                                   | Continuing because the export query is read-only                                                          |
| Host encryption/pagefile/route isolation unprovable                              | Stop 方案 A，prepare dedicated infrastructure proposal                                                                                                                    | Ordinary file deletion as sanitization                                                                    |
| Capacity plan rejects a GitHub-hosted chain                                      | Fail RC attempt and request a separate VM plan                                                                                                                            | Pruning unknown data, skipping tests or self-hosting final jobs                                           |
| Producer attempt fails before durable object commit                              | Preserve failure proof, destroy local volume, use new attempt                                                                                                             | Reuse admission/JIT token or same object key                                                              |
| Producer commit/result is uncertain                                              | Mark `INTERRUPTED_UNKNOWN` and reconcile OSS/GitHub/source facts                                                                                                          | Blindly rerun export/upload                                                                               |
| RC stage infrastructure failure                                                  | Preserve failure, rerun complete stage on same immutable bundle with new proof                                                                                            | Replace one image or edit prior proof                                                                     |
| Proof custody cannot be verified                                                 | Do not clean databases or promote result                                                                                                                                  | Depending on transient runner workspace                                                                   |
| Claim/envelope partial success, conflict, UNKNOWN or readback mismatch           | Preserve raw/objects/approvals/failure; only independent read-only diagnosis, never successful downstream; next execution needs new operation/run/raw proofs/full lineage | Repair missing object, retry writes, turn identical diagnostic readback into success, rewrap/delete claim |
| V1 lineage credential or wrong v2 job/profile/node/key                           | Reject before credential issuance; retain denial evidence                                                                                                                 | Widen v1, combine roles, use snapshot/KMS or prefix grants                                                |
| Missing or circular storage access receipt                                       | Reject custody/aggregate/exit/stop; preserve failure                                                                                                                      | Embed own later receipt, accept write acknowledgment as readback, trust unattested projections            |
| Task 29R evidence checkpoint succeeds                                            | Stop and request Task 30 authorization                                                                                                                                    | Run exit audit, apply stash or declare S1 complete                                                        |

## Completion Boundary

This plan is complete only when:

This cross-document revision must be approved before construction. Confirmed canary design is not a cloud-success claim; I0 actual private archive/signing and legal prebuild input must be proven, not inferred.

1. Tasks 0-15, 16A-16C, 17A-17B and 18 have merged with required CI green; I0 is closed, real canary passed, I1 produced trusted Adapter, and I15B proved legal prebuild input/independent authority and both source chains before the complete bundle. All original referenced evidence has actual private retention readback.
2. Each external operation has its applicable independent approval/readback/custody; lineage uses the closed v2 matrix, separate terminated writer/reader credentials and complete use/access receipts. No unresolved prerequisite UNKNOWN or failed/partial/conflicting/UNKNOWN pair is admitted, including after diagnosis.
3. One real Producer succeeds, followed by one immutable RC run with source/final raw v1 proofs, two-job one-to-one claim/envelope and privately read-back v2 custody/aggregate/exit. Every node has a later external access receipt, with exit access bound into the qualification stop proof. Purpose remains `qualification` and machine-non-promotable; private bytes never use public artifacts.
4. The environment is idle: no JIT Runner, unlocked LUKS volume, plaintext snapshot or active per-run credential remains.
5. Task 30 stash is unchanged and I24 has stopped at an explicit authorization request.

Completion of this plan proves the execution infrastructure and Task 29R checkpoint only. It does **not** complete S1, authorize Task 30, approve S2/S3, change product behavior or constitute Stage 1 acceptance.

## Primary Implementation References

- [GitHub: Security hardening for self-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
- [GitHub: Ephemeral self-hosted runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- [GitHub: OIDC claims and subject customization](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub: Artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [GitHub: Environment protection rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Alibaba Cloud KMS: Envelope encryption](https://www.alibabacloud.com/help/en/kms/key-management-service/use-cases/use-envelope-encryption)
- [Alibaba Cloud KMS: GenerateDataKey](https://www.alibabacloud.com/help/en/kms/key-management-service/developer-reference/api-kms-2016-01-20-generatedatakey)
- [Alibaba Cloud RAM: OIDC-based SSO](https://www.alibabacloud.com/help/en/ram/overview-of-oidc-based-sso)
- [Alibaba Cloud RAM: Manage an OIDC identity provider](https://www.alibabacloud.com/help/en/ram/manage-an-oidc-idp)
- [Alibaba Cloud OSS: Conditional PutObject](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject)
- [Alibaba Cloud OSS: Retention policy](https://www.alibabacloud.com/help/en/oss/user-guide/oss-retention-policies)
- [PostgreSQL 17: Transaction isolation and `DEFERRABLE`](https://www.postgresql.org/docs/17/runtime-config-client.html)
- [Node.js: v22 release archive](https://nodejs.org/en/download/archive/v22)
