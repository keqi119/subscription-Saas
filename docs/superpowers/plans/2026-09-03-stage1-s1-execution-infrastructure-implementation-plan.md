# Stage 1 S1 Execution Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

状态：待评审

**Goal:** 实现已批准的方案 A 执行基础设施，使独立 sanitized snapshot producer 能在 public repository 条件下安全运行，并让唯一 RC workflow 在 GitHub-hosted 临时机上完成 source、final、aggregate 与 exit 证明链，从而解除 Task 29R 的基础设施阻断。

**Architecture:** 仓库内只保存版本化契约、可测试的构建源码和无秘密策略模板；GitHub Environment、Aliyun OSS/KMS/RAM、Staging SSH/数据库身份及 WSL root policy 均由受控执行器按 `plan → human approval → apply → readback proof` 建立。Snapshot 数据 job 只调用预安装、root-owned、digest 固定的单一入口；加密 snapshot 进入独立私有 OSS custody，随后由精确绑定 `snapshotRunId` 或 `rcWorkflowRunId` 的短期身份消费。独立 snapshot producer 成功并完成保管后，才允许启动一个 `rcWorkflowRunId`，该 run 内重新生成 source evidence、执行两条 final chain、聚合并生成 exit evidence。

**Tech Stack:** Node.js 22.23.2、pnpm 11.4.0、Node ESM/`node:test`、PostgreSQL 17、GitHub Actions/JIT ephemeral Runner、WSL2 Ubuntu 24.04、LUKS2、OpenSSH、Docker Buildx/Compose、Aliyun OSS、Alibaba Cloud KMS/RAM/STS、AES-256-GCM、Playwright 1.62.1。

**Spec:** `docs/superpowers/specs/2026-09-03-stage1-s1-execution-infrastructure-security-addendum.zh-CN.md`，批准基线 `1ac4a5d40f615f944cb8af8cafdba682abd310ab`，状态提交 `a0c8522108c18f8ab81bbb6cc0320b91f305f173`。

**Upstream Plan:** `docs/superpowers/plans/2026-09-02-stage1-s1-trusted-release-foundation-implementation-plan.md`；本计划只替换其中 Task 13 的错误 snapshot 事务语义并补齐 Task 29R-A 至 29R-D 的执行基础设施，不恢复或实施 Task 30。

## Global Constraints

- 本计划获批前不得执行任何安装或外部状态变更。获批后，每项外部变更仍必须经过本计划列出的独立 human approval checkpoint；不得把“计划批准”当作某次具体 apply 的批准记录。
- 从包含提交 `a0c85221` 的最新 `main` 创建新的隔离 worktree。不得在当前文档 worktree 或保存 Task 30 stash 的工作树中施工。
- Task 30 stash `paused-task30-before-task29r-20260903` 在整个计划期间保持冻结。禁止 apply/pop/drop、修改 stash 内容或把其中文件加入任何提交。
- S2、S3、产品代码、业务迁移、Prisma 模型/枚举、应用 RBAC、业务权限、业务开关、客户可见行为和业务 API 均不在范围内。
- 所有仓库任务开始前运行 `git status --short`；只允许本任务列出的文件变更。每个任务独立提交，禁止把相邻安全边界合并为一个大提交。
- Task 0 之前不得读取 ambient `DATABASE_URL`、仓库 `.env` 或任何 Staging 凭证。Task 0 建立受控 PostgreSQL 17 目标后，所有 Prisma/database 检查只通过 `scripts/release/with-controlled-target.mjs` 执行。
- 当前 `prisma migrate status` 因缺少 datasource URL 未验证。Task 0 必须在代码写入前用受控目标取得 `migrate deploy → migrate status` 成功证据；失败立即停止，不能把 `prisma validate` 替代为迁移状态。
- Snapshot custody 固定采用 Alibaba Cloud China (Shanghai) 区域的独立私有 OSS bucket、KMS key 和 RAM/STS 身份；不得复用业务上传 bucket、API 的 OSS 身份或生产服务 KMS key。
- Alibaba RAM OIDC Provider 固定名称 `github-actions-subscription-saas-stage1`、issuer `https://token.actions.githubusercontent.com`、唯一 client ID/audience `sts.aliyuncs.com`、Earliest Issuance Time Allowed `1 hour`。Provider 计划固定独立验证的 HTTPS CA fingerprints，readback 必须记录 Provider ARN、实际 fingerprint 集合和 issuance limit；任何漂移均拒绝 STS。
- Dedicated custody bucket 的名称由 `subscription-saas-stage1-snapshot-${sha256(accountId).slice(0, 12)}-cn-shanghai` 确定性生成。Bucket 必须保持 versioning disabled，使用 `x-oss-forbid-overwrite=true`，并锁定 210 日 BucketWorm；30 日 snapshot 有效期加失效后 180 日保留由此覆盖。
- KMS key alias 固定为 `alias/stage1-snapshot-custody`。Producer 使用 `GenerateDataKey(AES_256)`；consumer 只对 admission 指定的 wrapped DEK 调用 `Decrypt`。KEK 不离开 KMS，明文 DEK 只短暂存在于独立 crypto process 内存。
- Snapshot publisher、snapshot custody reader、RC decrypt consumer、retention operator 是四个不同 RAM capability。每次只发放一种短期凭证；禁止组合凭证、通用 OSS 列举、跨 attempt 读取或 KMS 管理权限。
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
- Snapshot producer 必须先完成并取得 `snapshotRunId=success`、私有 OSS object readback、proof/log custody 和 destruction receipt；之后才能 dispatch RC workflow。
- Snapshot producer 的 `run_attempt` 固定为 `1`；GitHub rerun 不可复用原 admission、route nonce、JIT 配置或 cloud role，失败后必须新建 producer run 和 `releaseAttemptId`。
- RC workflow 不接受 `finalExecutionRunId`、`exitEvidenceRunId` 或任何外部 final/aggregate/exit object。Source fresh/snapshot、final fresh/snapshot、final custody、aggregate、generated exit 和 Task 30 tail 必须来自同一 `rcWorkflowRunId`；本计划只做到 Task 29R checkpoint，不执行 Task 30 tail。
- Infrastructure Tasks I19–I21 form one non-promotable Task 29R qualification release attempt; its producer and RC run only prove the infrastructure prefix and cannot be continued, reused or spliced into the final S1 proof after Task 30 approval. After Task 30 is separately approved and merged, a new `releaseAttemptId` must rerun “new producer → new single complete RC run”, and that complete RC run must execute its own exit audit and final custody.
- Qualification approval, aggregate, exit evidence and every custody receipt use versioned v2 contracts with required `executionPurpose=qualification`. Missing purpose and v1 proof are historical/non-promotable; Task 30 must require `executionPurpose=release-candidate` and reject qualification lineage before selecting any evidence.
- The self-hosted publisher uses a 15-minute STS session assumed by a root-only local credential broker. The broker principal may only assume the exact per-attempt publisher role and has no OSS/KMS/data permission; the resulting single-capability credential is passed through a root-opened descriptor, never workflow environment/secret/argv/workspace.
- 任何 identity、digest、approval、capacity、source privilege、fingerprint、custody、destruction 或 same-run 约束不满足，均 fail closed。禁止通过 mock JSON、手工“通过”、公共 artifact、常驻 Runner 或服务器 Compose 替代。

## Fixed Names and Derivations

| Item                      | Fixed value or deterministic derivation                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Snapshot Environment      | `stage1-snapshot-export`                                                               |
| Adapter build Environment | `trusted-image-build`, existing identity must be read back                             |
| RC source Environment     | `trusted-source-database-gate`, existing identity must be read back                    |
| RC final Environment      | `trusted-release-execution`, existing identity must be read back                       |
| RC aggregate Environment  | `trusted-release-candidate`, existing identity must be read back                       |
| Repository                | `keqi119/subscription-Saas`, ID `1253231368`                                           |
| Actor/reviewer            | `keqi119`, user ID `275060624`                                                         |
| Snapshot workflow         | `.github/workflows/sanitized-snapshot.yml` on exact `main` SHA                         |
| RC workflow               | `.github/workflows/release-candidate-gate.yml` on exact `main` SHA                     |
| Capability label          | `stage1-snapshot-export`                                                               |
| Unique route label        | `stage1-snapshot-export-${snapshotRunId}-${routeNonce}`                                |
| Root policy               | `/etc/subscription-saas/snapshot-adapter/v1/root-policy.v1.json`                       |
| Adapter root              | `/opt/subscription-saas/snapshot-adapter/v1/`                                          |
| Root secret handoff       | `/run/subscription-saas/snapshot-secrets/${releaseAttemptId}.json`, tmpfs, mode `0400` |
| LUKS backing file         | `/var/lib/subscription-saas/snapshot-volumes/${releaseAttemptId}.luks`                 |
| LUKS mapper               | `subscription-s1-${releaseAttemptId}` after strict identifier validation               |
| OSS region                | `oss-cn-shanghai`                                                                      |
| Custody bucket            | `subscription-saas-stage1-snapshot-${sha256(accountId).slice(0, 12)}-cn-shanghai`      |
| Snapshot object key       | `v1/${releaseAttemptId}/${ciphertextDigest.slice(7)}/snapshot.enc`                     |
| KMS alias                 | `alias/stage1-snapshot-custody`                                                        |
| Aliyun OIDC Provider      | `github-actions-subscription-saas-stage1`                                              |
| OIDC issuer / audience    | `https://token.actions.githubusercontent.com` / `sts.aliyuncs.com`                     |
| Adapter OCI repository    | `ghcr.io/keqi119/subscription-snapshot-adapter`                                        |
| Admission signing key     | Ed25519 public-key digest pinned in root policy; private key remains root-held         |
| DB loopback endpoint      | `127.0.0.1:55432` on Staging host                                                      |
| SSH user                  | `stage1_snapshot_tunnel`                                                               |
| PostgreSQL role           | `stage1_snapshot_reader`                                                               |
| Snapshot expiry           | `createdAt + 30 days`                                                                  |
| OSS WORM                  | locked BucketWorm, 210 days                                                            |

## Planned File Map

| Area               | Files and responsibility                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan alignment     | Existing S1 implementation plan: remove invalid `DEFERRABLE`, bind Task 29R to this plan, retain Task 30 block                                                                                                 |
| Routing contracts  | `release/contracts/schemas/environment-policy-*.json`, `snapshot-admission.v1`, `snapshot-admission-verification.v1`, `snapshot-jit-launch-proof.v1`, `snapshot-producer-completion.v1`                        |
| Custody contracts  | `release/contracts/schemas/snapshot-encryption-envelope.v1.schema.json`, `snapshot-private-custody.v1.schema.json`, `snapshot-destruction-receipt.v1.schema.json`, `snapshot-retention-receipt.v1.schema.json` |
| Shared logic       | `packages/release-foundation/src/snapshot/**`: policy/digest checks, envelope crypto, capacity calculation and proof builders                                                                                  |
| Root-owned adapter | `apps/snapshot-adapter/**`: fixed CLI, GitHub API verifier, JIT lifecycle, SSH/PostgreSQL snapshot pipeline, crypto subprocess, OSS/KMS adapters                                                               |
| Bundle             | `scripts/release/build-snapshot-adapter.mjs`, `verify-snapshot-adapter-bundle.mjs`, `.github/workflows/snapshot-adapter-build.yml`, Adapter build/custody proof contracts                                      |
| Host policy        | `infrastructure/stage1-snapshot/wsl/**`, `infrastructure/stage1-snapshot/server/**`: WSL, LUKS, egress, sshd and loopback database endpoint configuration                                                      |
| Cloud policy       | `infrastructure/stage1-snapshot/aliyun/**`, `scripts/release/manage-snapshot-cloud-custody.mjs`: OSS/KMS/RAM policy documents and closed plan/apply/readback/reconcile operations                              |
| GitHub bootstrap   | `scripts/release/bootstrap-snapshot-environment.mjs`, `bootstrap-snapshot-launcher-app.mjs`, `bootstrap-aliyun-oidc-provider.mjs`, `manage-exact-run-capability.mjs` and tests                                 |
| Qualification      | v2 approval/custody/aggregate/exit contracts with required `executionPurpose`; v1 remains historical and non-promotable                                                                                        |
| Workflows          | `.github/workflows/sanitized-snapshot.yml`, `release-candidate-gate.yml`, `release-final-chain.yml`                                                                                                            |
| Capacity           | `release/contracts/schemas/capacity-plan.v1.schema.json`, `packages/release-foundation/src/capacity-plan.mjs`, `scripts/release/collect-capacity-plan.mjs`                                                     |
| Operations         | `docs/operations/stage1-s1-execution-infrastructure-runbook.md`, bootstrap/attempt evidence templates and failure matrix                                                                                       |

---

### Task 0: Freeze the implementation source and prove a controlled datasource

**Files:**

- No tracked files.
- Creates ignored local records only under `.release-local/`.

**Interfaces:**

- Consumes: a clean worktree based on the latest `main` containing `a0c85221` and the approved content digest of this plan.
- Produces: `.release-local/controlled-target.v1.json` and successful controlled PostgreSQL 17 migration-status evidence.
- Stop rule: no later task starts if the target cannot be created, existing migrations cannot be deployed, final migration status is not current, or Task 30 stash is missing.

- [ ] **Step 1: Create the isolated implementation worktree**

Run from the primary checkout after protecting local Dockerfile changes. The human review record is preserved as `.release-local/input/s1-infrastructure-plan-approval.v1.json`; it contains `decision=APPROVED`, the approved source commit, plan blob OID, approver identity and review time. Its review-system attestation and custody receipt must be verified before this local check.

```powershell
git fetch origin main
$planPath = 'docs/superpowers/plans/2026-09-03-stage1-s1-execution-infrastructure-implementation-plan.md'
$approvalPath = '.release-local/input/s1-infrastructure-plan-approval.v1.json'
$approval = Get-Content -LiteralPath $approvalPath -Raw | ConvertFrom-Json
if ($approval.decision -ne 'APPROVED') { throw 'INFRASTRUCTURE_PLAN_NOT_APPROVED' }
if ($approval.approvedSourceCommit -notmatch '^[0-9a-f]{40,64}$' -or $approval.planBlobOid -notmatch '^[0-9a-f]{40,64}$') { throw 'APPROVED_PLAN_IDENTITY_INVALID' }
git cat-file -e "origin/main:$planPath"
if ($LASTEXITCODE -ne 0) { throw 'PLAN_MISSING_FROM_MAIN' }
git merge-base --is-ancestor a0c8522108c18f8ab81bbb6cc0320b91f305f173 origin/main
if ($LASTEXITCODE -ne 0) { throw 'APPROVED_ADDENDUM_MISSING_FROM_MAIN' }
git merge-base --is-ancestor $approval.approvedSourceCommit origin/main
if ($LASTEXITCODE -ne 0) { throw 'APPROVED_PLAN_COMMIT_MISSING_FROM_MAIN' }
$approvedBlob = git rev-parse "$($approval.approvedSourceCommit):$planPath"
$mainBlob = git rev-parse "origin/main:$planPath"
if ($approvedBlob -ne $approval.planBlobOid -or $mainBlob -ne $approvedBlob) { throw 'APPROVED_PLAN_BLOB_MISMATCH' }
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

### Task 1: Align the upstream S1 plan with the approved infrastructure topology

**Files:**

- Modify: `docs/superpowers/plans/2026-09-02-stage1-s1-trusted-release-foundation-implementation-plan.md`

**Interfaces:**

- Consumes: approved addendum `1ac4a5d4` and this implementation plan.
- Produces: a non-contradictory upstream plan that references this plan as the only Task 29R infrastructure route.

- [ ] **Step 1: Write a failing documentation contract check**

Run before editing:

```powershell
$plan='docs/superpowers/plans/2026-09-02-stage1-s1-trusted-release-foundation-implementation-plan.md'
if (Select-String -LiteralPath $plan -SimpleMatch 'REPEATABLE READ, READ ONLY, DEFERRABLE') { throw 'STALE_DEFERRABLE_PLAN' }
if (-not (Select-String -LiteralPath $plan -SimpleMatch '2026-09-03-stage1-s1-execution-infrastructure-implementation-plan.md')) { throw 'INFRASTRUCTURE_PLAN_LINK_MISSING' }
```

Expected: FAIL with `STALE_DEFERRABLE_PLAN` and/or `INFRASTRUCTURE_PLAN_LINK_MISSING`.

- [ ] **Step 2: Correct Task 13 snapshot semantics**

Replace the Task 13 transaction requirement with:

```text
Begin REPEATABLE READ READ ONLY, export the PostgreSQL snapshot identifier, and record the
transaction isolation/read-only observations. Do not set or require DEFERRABLE. A real PostgreSQL 17
barrier test must prove that readers attached to the same exported snapshot observe the same source
fingerprint while a concurrent writer commits outside that snapshot.
```

- [ ] **Step 3: Bind Task 29R to the fixed producer/RC order**

Add a normative cross-reference stating:

```text
Task 29R infrastructure is implemented only through the approved 2026-09-03 execution-infrastructure
plan: one independent snapshotRunId producer must finish and enter custody before a unique
rcWorkflowRunId starts. The RC run generates source, final, aggregate and exit nodes in-run and does
not offer a reusable/same-run snapshot alternative.
```

- [ ] **Step 4: Keep Task 30 explicitly blocked**

Require the upstream plan to say that completion of this infrastructure plan and a real Task 29R checkpoint only creates a review request to resume Task 30; it does not apply the stash or execute Task 30.

- [ ] **Step 5: Run documentation checks**

```powershell
pnpm exec prettier --check docs/superpowers/plans/2026-09-02-stage1-s1-trusted-release-foundation-implementation-plan.md
git diff --check
rg -n 'REPEATABLE READ READ ONLY|snapshotRunId|rcWorkflowRunId|Task 30' docs/superpowers/plans/2026-09-02-stage1-s1-trusted-release-foundation-implementation-plan.md
```

Expected: no invalid `REPEATABLE READ, READ ONLY, DEFERRABLE` wording; fixed topology and Task 30 block are present.

- [ ] **Step 6: Commit the plan alignment alone**

```powershell
git add docs/superpowers/plans/2026-09-02-stage1-s1-trusted-release-foundation-implementation-plan.md
git commit -m "docs: align S1 plan with execution infrastructure"
```

---

### Task 2: Add routing, policy and producer-proof contracts

**Files:**

- Create: `release/contracts/schemas/environment-policy-identity.v1.schema.json`
- Create: `release/contracts/schemas/environment-policy-observation.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-admission.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-admission-verification.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-jit-launch-proof.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-producer-completion.v1.schema.json`
- Create: `release/contracts/schemas/infrastructure-attempt.v1.schema.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `packages/release-foundation/src/schema-registry.mjs`
- Create: `packages/release-foundation/test/snapshot-routing-contracts.test.mjs`
- Create: `scripts/release/create-infrastructure-attempt.mjs`
- Create: `scripts/release/create-infrastructure-attempt.test.mjs`

**Interfaces:**

- Produces: seven strict JSON Schemas registered in `validateContract(name, value)` and included in `repositoryContractDigest`, plus a closed attempt-record generator.
- Stable identity: `EnvironmentPolicyIdentityV1`; dynamic provenance: `EnvironmentPolicyObservationV1`.
- Proof order: untrusted admission digest → root-signed admission verification digest → post-approval observation digest → JIT launch proof digest → producer completion digest.

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

Require exactly: schema version, identity digest, `observedAt`, API response digest, deployment/run/job identity, review record digest, queued labels and observed terminal state. Enforce RFC 3339 timestamps and `runAttempt=1`.

- [ ] **Step 4: Define admission, launch and completion Schemas**

`snapshot-admission.v1` binds source SHA, repository contract digest, workflow blob/action digests, releaseAttemptId, snapshotRunId, route nonce/label, adapter digest and environment identity digest, but carries no claim that GitHub attested it. `snapshot-admission-verification.v1` binds that digest to root launcher's independent GitHub API/workflow/artifact observations, root-policy digest, signer public-key digest and Ed25519 signature. `snapshot-jit-launch-proof.v1` adds the verified-admission digest, environment observation digest, actual runner ID/version/binary digest and exact labels. `snapshot-producer-completion.v1` binds private custody, proof/log custody, destruction receipt and GitHub run terminal state.

- [ ] **Step 5: Define and generate the infrastructure attempt identity**

`infrastructure-attempt.v1` requires a random 128-bit lowercase hexadecimal `releaseAttemptId`, exact merged main SHA, repository contract digest, `executionPurpose=qualification`, `createdAt` and owner ID. `create-infrastructure-attempt.mjs --main-sha --owner-id --output` recomputes the repository contract digest from the registered manifest and generates the record once with `crypto.randomBytes(16)`, exclusive-create semantics and canonical JSON; it refuses an existing path and has no release-candidate mode.

- [ ] **Step 6: Register every Schema in the contract digest**

Update both `schema-registry.mjs` and `repository-contract-files.v1.json`; registry keys and filenames must be one-to-one.

- [ ] **Step 7: Run contract and digest tests**

```powershell
node --test packages/release-foundation/test/snapshot-routing-contracts.test.mjs packages/release-foundation/test/schema-registry.test.mjs packages/release-foundation/test/catalogs.test.mjs scripts/release/create-infrastructure-attempt.test.mjs
pnpm release:contracts:verify
git diff --check
```

Expected: PASS; removing any new Schema from the contract-file manifest fails `release:contracts:verify`.

- [ ] **Step 8: Commit the routing contracts**

```powershell
git add release/contracts packages/release-foundation/src/schema-registry.mjs packages/release-foundation/test/snapshot-routing-contracts.test.mjs scripts/release/create-infrastructure-attempt.mjs scripts/release/create-infrastructure-attempt.test.mjs
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
- Produces: `buildSnapshotAdmission(input): SnapshotAdmissionV1` and `uniqueRouteLabel(runId, nonce): string`.
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
git add packages/release-foundation/src/snapshot packages/release-foundation/src/index.mjs packages/release-foundation/test/snapshot-environment-policy.test.mjs packages/release-foundation/test/snapshot-admission.test.mjs
git commit -m "build: verify snapshot environment and admission identity"
```

---

### Task 4: Define private snapshot encryption, custody and retention contracts

**Files:**

- Create: `release/contracts/schemas/snapshot-encryption-envelope.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-private-custody.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-destruction-receipt.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-retention-receipt.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-cloud-policy.v1.schema.json`
- Create: `release/contracts/snapshot-cloud-policy.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `packages/release-foundation/src/schema-registry.mjs`
- Create: `packages/release-foundation/test/snapshot-custody-contracts.test.mjs`

**Interfaces:**

- `snapshot-encryption-envelope.v1` describes AES-256-GCM ciphertext, wrapped DEK, KMS parameters and authenticated-data digest; it never accepts a plaintext key.
- `snapshot-private-custody.v1` binds OSS bucket fingerprint, exact object key/version or ETag, ciphertext digest/size, WORM readback, access-policy digest and expiry.
- Destruction and retention receipts are distinct: the first proves local attempt-volume key invalidation; the second proves post-retention object/key-access disposition.

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

Require: `algorithm=AES-256-GCM`, unique 96-bit nonce, 128-bit tag, ciphertext SHA-256/size, `wrappedDek`, KMS key ARN/alias, KMS algorithm/IV/AAD needed to unwrap, canonical AAD digest, releaseAttemptId, source SHA, snapshot digest, sanitization-contract digest and expiry. All binary values are base64 with bounded lengths; the Schema rejects `dek`, `plaintext`, `secret`, `accessKey` and arbitrary metadata.

- [ ] **Step 3: Define the cloud policy contract**

`snapshot-cloud-policy.v1.json` fixes region `oss-cn-shanghai`, bucket derivation version, versioning disabled, forbid-overwrite true, BucketWorm 210 days, KMS alias and four mutually exclusive capabilities: `publisher`, `custody-reader`, `rc-consumer`, `retention`. The repository contract stores logical policy and digests, not account ID, bucket name, access keys or endpoints containing credentials.

- [ ] **Step 4: Define custody and disposition receipts**

Custody requires a successful conditional create, HEAD/readback digest, private ACL, WORM locked state, retention-until time, publisher policy digest and a proof that the writer cannot Get/List/Delete. Destruction receipt requires volume identity, mapper close, key invalidation method and residual mount scan. Retention receipt requires object key/version, prior custody digest, disposition `DELETED` or `TRANSFERRED`, operator identity digest, approved policy and terminal readback.

- [ ] **Step 5: Register all contracts and add semantic validators**

Add `validateSnapshotCustody`, `validateSnapshotDestructionReceipt` and `validateSnapshotRetentionReceipt` to `packages/release-foundation/src/snapshot/custody-contracts.mjs`; register the file itself in Task 5 when created. At this step the test may define a local semantic validator fixture, but every JSON Schema must already enter `repository-contract-files.v1.json`.

- [ ] **Step 6: Run contract verification**

```powershell
node --test packages/release-foundation/test/snapshot-custody-contracts.test.mjs packages/release-foundation/test/schema-registry.test.mjs
pnpm release:contracts:verify
git diff --check
```

Expected: PASS; shortening WORM below 210 days or adding a plaintext field fails.

- [ ] **Step 7: Commit the custody contracts**

```powershell
git add release/contracts packages/release-foundation/src/schema-registry.mjs packages/release-foundation/test/snapshot-custody-contracts.test.mjs
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

Canonicalize exactly `{ repositoryId, sourceSha, releaseAttemptId, snapshotDigest, sanitizationContractDigest, expiresAt }`; hash the canonical bytes and pass them as GCM AAD and KMS encryption context. Provenance timestamps not listed here cannot change ciphertext identity.

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
- Create: `apps/snapshot-adapter/src/cloud/policy-generator.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-kms.test.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-oss.test.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-policy.test.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-publisher-broker.test.mjs`
- Create: `infrastructure/stage1-snapshot/aliyun/snapshot-cloud-policy-input.v1.json`
- Create: `scripts/release/manage-snapshot-cloud-custody.mjs`
- Create: `scripts/release/manage-snapshot-cloud-custody.test.mjs`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Dependencies pin exactly `ali-oss@6.23.0`, `@alicloud/credentials@2.4.7`, `@alicloud/kms20160120@3.3.0` and `@alicloud/sts20150401@1.2.0`.
- Produces: `AliyunKmsDataKeyClient`, `AliyunOssWriteOncePublisher`, `AliyunOssExactReader`, `AliyunPublisherCredentialBroker` and `buildAttemptRamPolicies(input)`.
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

Allow only key alias `alias/stage1-snapshot-custody`, `AES_256`, approved region/endpoint and exact encryption context. Strip raw SDK responses from errors. Producer wrapper exposes plaintext only as a mutable Buffer to the crypto module; consumer wrapper returns the same bounded type.

- [ ] **Step 3: Implement conditional OSS publication**

`AliyunOssWriteOncePublisher.putExact` uses the deterministic object key and `x-oss-forbid-overwrite=true`; HTTP 409 is `SNAPSHOT_OBJECT_ALREADY_EXISTS`, never success. After upload, use an independently injected readback adapter in tests to verify ciphertext digest, size, private ACL and WORM state. Publisher methods for Get/List/Delete are absent.

- [ ] **Step 4: Implement exact-object consumer and retention adapters**

Reader only accepts the object key/digest/version from an attested custody record and cannot list prefixes. Retention adapter is a separate constructor and credential profile; it rejects objects whose retain-until or snapshot-expiry-plus-180-days time has not elapsed.

- [ ] **Step 5: Implement the root-only publisher credential broker**

The broker reads its assume-role-only principal from a root-opened descriptor, validates the approved exact role ARN/policy/readback/attempt binding, requests a 900-second STS session and writes the resulting publisher-only credential to a sealed child descriptor. The broker principal has no OSS/KMS permission, cannot assume custody/consumer/retention roles and never enters the Runner process, workflow environment, argv, disk or proof.

- [ ] **Step 6: Generate mutually exclusive RAM policies**

`buildAttemptRamPolicies` emits four canonical policy documents. Publisher permits only KMS GenerateDataKey and OSS PutObject for one exact key. Custody reader permits HEAD/Get for the exact encrypted object and narrow proof objects without KMS Decrypt. RC consumer permits exact Get plus KMS Decrypt. Retention permits post-retention delete and receipt write; no profile can manage bucket/KMS or assume another role.

- [ ] **Step 7: Implement the closed cloud-resource lifecycle CLI**

`manage-snapshot-cloud-custody.mjs` exposes only `plan`, `apply`, `readback` and `reconcile`, with required `--resource base-custody|retention-lock`. `base-custody` covers the private bucket, KMS key/alias, non-WORM access policy and root broker principal; `retention-lock` covers only the separately approved 210-day BucketWorm transition. Each resource has an independent `operationId`, plan digest, approval, execution proof and readback. An UNKNOWN apply must reconcile by exact resource ID and may not run apply again. The CLI rejects credentials before plan/approval verification and never combines the irreversible WORM operation with reversible creation.

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
git add apps/snapshot-adapter infrastructure/stage1-snapshot/aliyun scripts/release/manage-snapshot-cloud-custody.mjs scripts/release/manage-snapshot-cloud-custody.test.mjs pnpm-lock.yaml
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

Spawn the fixed internal module by absolute adapter path with an IPC channel and inherited data/key descriptors. Before cryptography, set core size to zero through the root launcher and assert `/proc/self/coredump_filter`/limits. Child messages contain only envelope/proof data; after exit, scan output and terminate the attempt on any secret-shaped field.

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

`manage-snapshot-wsl-host.mjs` exposes `plan`, `apply`, `readback` and `reconcile` for exactly one `--resource distro|admission-signer|adapter-install`. Each resource uses a separate operation ID and approval. `distro` creates only the dedicated WSL boundary; `admission-signer` creates a non-exportable root-held Ed25519 key and records only its public-key digest; `adapter-install` accepts only the attested OCI digest/custody proof produced by Task 17. Apply is delegated to the root-owned fixed scripts through a protected descriptor. UNKNOWN state requires readback/reconcile and never permits blind uninstall/reinstall.

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

Fetch Environment, deployment, review, workflow run and job state; recompute stable identity, generate a new observation and require age at JIT request at most 300 seconds. Check exact five labels and exactly one queued job before requesting Runner configuration.

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
- `collectRunnerProvenance(): RunnerProvenanceV1` records the exact runner image release, kernel, architecture, CPU, memory, filesystem, Docker data root, Docker Engine, Buildx and Compose versions.
- CLI: `pnpm release:capacity:collect -- --chain snapshot --registry-plan .release-local/evidence/registry-plan.v1.json --snapshot-proof .release-local/evidence/snapshot-producer-completion.v1.json --output .release-local/evidence/capacity-plan.v1.json`; the fresh-chain invocation uses `--chain fresh --snapshot-proof none`.

- [ ] **Step 1: Write RED arithmetic and input-validation tests**

Cover integer overflow, missing registry layer sizes, missing uncompressed estimates, snapshot chain without a ciphertext/plaintext upper bound, negative values, an unsupported filesystem and output paths outside the evidence directory.

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

Fresh sets both snapshot terms to zero but still supplies a restored-database upper bound. Snapshot upper bounds come only from the producer proof and sanitization contract; they are never guessed from free disk.

- [ ] **Step 3: Collect actual capacity without deleting data**

Read `df` for the workspace and Docker data root, `docker system df --format json`, registry-reported compressed manifests and the build proof. The collector is read-only: it must not prune images, delete caches, shrink fixtures, change Docker storage or silently choose fewer tests.

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
- `prepare-snapshot-run` and `prepare-rc-snapshot-consumer-role` emit cloud-role trust-policy plans bound to one exact run and attempt; they never create roles themselves.
- `bootstrap-aliyun-oidc-provider.mjs` and `manage-exact-run-capability.mjs` each expose only `plan`, `apply`, `readback` and `reconcile`; the capability tool additionally exposes `revoke`. Apply/revoke require a bound approval record and create separate execution proofs.
- Every token/key reference is a protected file descriptor or secret-manager reference, never a command argument or environment variable.

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

- [ ] **Step 7: Bind per-run role plans to exact OIDC subjects**

For snapshot custody and RC consumers, compute the full subject from the already allocated numeric `run_id`, `run_attempt`, exact workflow SHA/ref, event, environment and runner environment. The self-hosted publisher plan instead binds the exact broker principal, role ARN, releaseAttemptId/object/KMS context and 900-second maximum session; it does not use GitHub OIDC. The RC consumer capability is instantiated for exactly two approved jobs: source-snapshot under `trusted-source-database-gate` and final-snapshot under `trusted-release-execution`; each invocation gets its own short-lived credential while both have the same narrow exact-object/decrypt permission profile. Assert every OIDC RAM trust clause contains one exact `StringEquals` subject and no wildcard for run, ref, workflow, environment or actor.

- [ ] **Step 8: Implement canary and exact-run lifecycle checks**

The canary workflow is GitHub-hosted `ubuntu-24.04`, main-only, run-attempt 1, under `stage1-snapshot-export`, and requests an OIDC token only after the future subject's RAM role is applied/read back. It uses audience `sts.aliyuncs.com`, calls only `AssumeRoleWithOIDC` and `GetCallerIdentity`, and emits redacted claims/Provider/role/session proof. Exact-run lifecycle is fixed as `run allocated and jobs paused → plan → approval → apply → readback → single capability credential → Environment release → terminal revoke/readback`; apply/revoke UNKNOWN must reconcile.

- [ ] **Step 9: Add negative tests**

Reject wrong repository/environment/reviewer, tag/ref, workflow SHA, actor, run attempt, self-hosted versus GitHub-hosted mismatch, admin bypass, stale observation, missing approval, wildcard trust, ambient token, Provider issuer/client ID/fingerprint/issuance/ARN mismatch, GitHub subject switch before cloud condition readback, OIDC token before Environment approval, publisher OIDC, broker with data permission, role apply before run ID, Environment release before role readback and terminal without revocation readback.

- [ ] **Step 10: Verify and commit repository-only tooling**

```powershell
node --test scripts/release/bootstrap-snapshot-environment.test.mjs scripts/release/bootstrap-snapshot-launcher-app.test.mjs scripts/release/bootstrap-github-oidc-subject.test.mjs scripts/release/verify-github-oidc-subject.test.mjs scripts/release/bootstrap-aliyun-oidc-provider.test.mjs scripts/release/manage-exact-run-capability.test.mjs scripts/release/run-aliyun-oidc-canary.test.mjs scripts/release/prepare-snapshot-run.test.mjs scripts/release/prepare-rc-snapshot-consumer-role.test.mjs
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
2. `snapshot-data` runs after Environment approval on the exact five-label JIT Runner, has no checkout, `uses`, package-manager, Docker or free-form input, and contains one fixed invocation of the root-owned adapter.
3. `snapshot-custody` runs on `ubuntu-24.04` under `stage1-snapshot-export`, uses an exact-run read-only custody identity to verify encrypted OSS object/proofs/destruction receipt, issues a GitHub artifact attestation and emits `snapshot-producer-completion.v1`; it never downloads or decrypts the snapshot.

- [ ] **Step 1: Make existing workflow tests fail on plaintext custody**

Assert the workflow contains no plaintext dump upload, public Actions artifact containing snapshot bytes, 30-day snapshot artifact retention, repository checkout in `snapshot-data`, `pnpm`, `npm`, `node scripts/`, arbitrary `run` input or persistent self-hosted label.

- [ ] **Step 2: Implement the admission job**

Declare only `contents: read` and `actions: read`; omit `id-token` and `attestations`, and do not set `environment`. Admission output contains only digests, IDs, allowed labels, immutable workflow identity, exact adapter digest, expiry and protected object references. The root launcher retrieves it with its GitHub App, verifies run/job/workflow/artifact facts and produces the separate root-signed admission-verification proof before requesting JIT configuration.

- [ ] **Step 3: Implement the single-entry data job**

Set `runs-on` to the exact default labels, capability label and derived unique label; set `environment: stage1-snapshot-export`; disable container/service/default shell customization. The only command is the literal installed adapter path with the admission artifact reference. It receives root handoff through the launcher, not workflow secrets or environment variables.

- [ ] **Step 4: Implement custody verification**

Declare `environment: stage1-snapshot-export` and exact permissions `contents: read`, `actions: read`, `id-token: write`, `attestations: write`. Verify the private OSS object using `HEAD` and range-read ciphertext hash, KMS/OSS receipt, root-signed admission verification, producer proof, sanitization proof, source fingerprint, GitHub job/runner identity, destruction receipt, 30-day expiry and 210-day retention state. Then issue a GitHub artifact attestation for only the non-sensitive completion proof/reference and upload that small artifact to GitHub Actions.

- [ ] **Step 5: Add structural and policy negative tests**

Mutate a workflow fixture to add admission Environment/OIDC/attestation authority, data-job checkout/second command/mutable label/plaintext upload/Docker, custody without `stage1-snapshot-export`, missing `attestations: write`, broader token permission or missing custody job; every mutation must fail with a stable code.

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
- Create: `scripts/release/download-private-snapshot.mjs`
- Create: `scripts/release/download-private-snapshot.test.mjs`
- Create: `scripts/release/verify-release-runner-hosting.mjs`
- Create: `scripts/release/verify-release-runner-hosting.test.mjs`
- Modify: `scripts/release/run-source-database-gate.mjs`
- Modify: `scripts/release/run-final-compose-gate.mjs`
- Modify: `scripts/release/release-dag-assemblers.test.mjs`
- Create: `scripts/release/release-final-chain.test.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- RC workflow input is `snapshotProducerCompletionDigest` plus its private custody reference and the already frozen `snapshotRunId`; there is no plaintext artifact name or external final/exit run ID.
- `download-private-snapshot.mjs` validates exact-run OIDC, custody/admission/expiry/digest before KMS unwrap, streams decrypt output into the isolated restore pipeline and removes the plaintext FIFO/process on every terminal path.
- Both source and final jobs run on `ubuntu-24.04`; no self-hosted runner sees build, repository or final-chain work.

- [ ] **Step 1: Add RED hosting and input tests**

Reject `self-hosted`, `ubuntu-latest`, mutable image identity, plaintext snapshot artifact inputs, external `finalExecutionRunId`/`exitEvidenceRunId`, missing producer completion digest, wildcard OIDC role and snapshot download before capacity admission.

- [ ] **Step 2: Add capacity/provenance before any write**

Fresh and snapshot chains independently collect runner provenance and `capacity-plan.v1`. Capacity must pass before registry pulls, dependency install, snapshot fetch/decrypt, temporary database provisioning or Compose volume creation.

- [ ] **Step 3: Implement exact-run private snapshot consumption**

Use an RC-consumer role whose trust policy matches the current `rcWorkflowRunId` and attempt. Allow one exact object key and one KMS ciphertext context; deny bucket listing and other attempt prefixes. Verify ciphertext digest before decrypt, sanitized content digest while streaming and fail if plaintext is addressable as an Actions artifact/cache.

- [ ] **Step 4: Run source fresh and source snapshot gates in the same RC run**

Fresh creates its own Manifest/database identity/operation ID. Snapshot restores into a different temporary database with its own Manifest/database identity/operation ID. Both use final Runner image commands and emit execution proofs for the current build proof; no job consumes external source-gate JSON claiming success.

- [ ] **Step 5: Run final fresh and final snapshot Compose gates**

Use registry-resolved API/Web/Runner platform digests, no local build and no bind-mounted repository scripts. Runner performs migration/verify, API proves its actual database session identity, Web performs a real Playwright public API request, and runtime-equivalent database tests report the complete zero-skip equation.

- [ ] **Step 6: Preserve all failure evidence**

On failure or cancellation, upload only redacted proof/log artifacts after digest verification. Database commit ambiguity becomes `INTERRUPTED_UNKNOWN`; snapshot plaintext and credentials are never uploaded. A retry uses a new attempt/proof and reruns the complete failed stage without replacing bundle components.

- [ ] **Step 7: Verify and commit without executing the RC**

```powershell
node --test scripts/release/download-private-snapshot.test.mjs scripts/release/verify-release-runner-hosting.test.mjs scripts/release/release-dag-assemblers.test.mjs scripts/release/release-final-chain.test.mjs
node scripts/release/verify-release-runner-hosting.mjs --rc-workflow .github/workflows/release-candidate-gate.yml --final-workflow .github/workflows/release-final-chain.yml
pnpm release:contracts:verify
pnpm prettier --check .github/workflows scripts/release release/contracts
git diff --check
git add .github/workflows scripts/release release/contracts
git commit -m "ci: run release gates on immutable hosted runners"
```

---

### Task 16: Close the producer-to-RC evidence prefix and same-run aggregation boundary

**Files:**

- Create: `release/contracts/schemas/approval-record.v2.schema.json`
- Create: `release/contracts/schemas/custody-receipt.v2.schema.json`
- Create: `release/contracts/schemas/release-aggregate-proof.v2.schema.json`
- Create: `release/contracts/schemas/s1-exit-evidence.v2.schema.json`
- Create: `packages/release-foundation/src/execution-purpose.mjs`
- Create: `packages/release-foundation/test/execution-purpose.test.mjs`
- Modify: `packages/release-foundation/src/approval.mjs`
- Modify: `packages/release-foundation/src/evidence-custody.mjs`
- Modify: `packages/release-foundation/src/schema-registry.mjs`
- Modify: `packages/release-foundation/src/index.mjs`
- Modify: `packages/release-foundation/test/approval.test.mjs`
- Modify: `packages/release-foundation/test/evidence-custody.test.mjs`
- Modify: `scripts/release/aggregate-release-proof.mjs`
- Modify: `scripts/release/generate-s1-exit-evidence.mjs`
- Modify: `scripts/release/aggregate-release-proof.test.mjs`
- Modify: `scripts/release/generate-s1-exit-evidence.test.mjs`
- Modify: `scripts/release/release-dag-assemblers.test.mjs`
- Modify: `scripts/release/approval-workflows.test.mjs`
- Modify: `.github/workflows/release-candidate-gate.yml`
- Modify: `release/contracts/repository-contract-files.v1.json`

**DAG:**

```text
independent snapshot producer success and custody
  -> unique RC run source evidence
  -> build admission
  -> final fresh and final snapshot execution
  -> final evidence custody
  -> aggregate proof
  -> generated s1-exit-evidence checkpoint custody
  -X-> Task 30 exit audit and final custody (blocked)
```

The independent producer may supply only its attested completion/object references; build proof and narrow owner/manual attestations may also be external inputs. All source, final, aggregate and generated exit-evidence nodes are created in one `rcWorkflowRunId` and one attempt lineage. This qualification path uses only v2 proof contracts with `executionPurpose=qualification`; v1 remains readable as historical evidence but is never promotion-eligible. The independent exit audit and final custody tail remain Task 30 work and are not created here.

- [ ] **Step 1: Add forward-only execution-purpose contracts**

Create v2 rather than changing published v1 semantics. `approval-record.v2.bindings`, `custody-receipt.v2`, `release-aggregate-proof.v2` and `s1-exit-evidence.v2` all require `executionPurpose` with enum `qualification|release-candidate`. Every referenced proof/receipt must carry the same value; a missing purpose, v1 object or mismatch is non-promotable.

- [ ] **Step 2: Write RED cross-run and purpose-splice tests**

Reject different RC workflow run/attempt, source evidence imported from another run, final evidence artifact inputs, externally supplied aggregate/exit evidence, mismatched producer completion, changed build/contract/snapshot digest, retry evidence that overwrites an earlier failure, qualification approval paired with release-candidate custody, missing purpose and any v1 evidence selected for promotion.

- [ ] **Step 3: Make aggregation recompute lineage**

Read every selected proof from this run's content-addressed custody, verify subject/digest/operation/purpose lineage and recompute the v2 aggregate rather than trusting a summary JSON. A successful producer completion is a prerequisite fact, not a source/final execution proof.

- [ ] **Step 4: Generate qualification exit evidence inside the RC run**

Remove any `exitEvidenceRunId` or complete exit-evidence download. Generate `s1-exit-evidence.v2` only after the aggregate digest exists, binding `executionPurpose=qualification`, the current RC run, build proof, repository contract, test manifest, snapshot version, all v2 custody receipts and approved manual/owner attestations.

- [ ] **Step 5: Add the promotion-rejection kernel but keep Task 30 disabled**

`assertPromotionEligible` accepts only v2 evidence with `executionPurpose=release-candidate`; it rejects `qualification`, v1, missing/mixed purpose and a different attempt. Add a test named `task30 rejects qualification evidence`, but do not restore or modify the Task 30 stash. The workflow stops after producing the Task 29R checkpoint evidence and an explicit `TASK_30_AUTHORIZATION_REQUIRED` state; it must not run Task 30 commands, mark S1 complete or automatically dispatch a follow-up workflow.

- [ ] **Step 6: Run DAG tests and commit**

```powershell
node --test packages/release-foundation/test/execution-purpose.test.mjs packages/release-foundation/test/approval.test.mjs packages/release-foundation/test/evidence-custody.test.mjs scripts/release/aggregate-release-proof.test.mjs scripts/release/generate-s1-exit-evidence.test.mjs scripts/release/release-dag-assemblers.test.mjs scripts/release/approval-workflows.test.mjs
pnpm release:contracts:verify
pnpm prettier --check .github/workflows/release-candidate-gate.yml scripts/release release/contracts
git diff --check
git add .github/workflows/release-candidate-gate.yml packages/release-foundation scripts/release release/contracts
git commit -m "ci: close the stage1 release evidence dag"
```

---

### Task 17: Add the trusted main Adapter build, publication and custody producer

**Files:**

- Create: `.github/workflows/snapshot-adapter-build.yml`
- Create: `release/contracts/schemas/snapshot-adapter-build-proof.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-adapter-artifact-custody.v1.schema.json`
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

- [ ] **Step 2: Implement a protected main-only build workflow**

Use manual `workflow_dispatch` on exact `refs/heads/main`, `run_attempt=1`, repository ID/actor checks and `ubuntu-24.04` under existing `trusted-image-build`. Checkout the exact workflow SHA with credentials disabled, run only the fixed Task 7 build/verify entrypoints and use pinned actions.

- [ ] **Step 3: Publish the dependency-closed Adapter as an OCI artifact**

Push the deterministic archive, SBOM and manifest together to the fixed GHCR repository, resolve the registry platform/artifact digest after upload and reject tag-only identity. Never publish from a PR artifact or local developer build.

- [ ] **Step 4: Issue attestation and complete custody readback**

Use GitHub artifact attestation with the workflow permissions above. Pull metadata by digest in a separate readback job, re-hash the archive/SBOM/manifest, verify source/workflow/runtime provenance and emit `snapshot-adapter-artifact-custody.v1`. Store only the non-sensitive build proof/custody records in Actions artifact; the installable artifact remains digest-addressed in GHCR.

- [ ] **Step 5: Bind admission and root policy to the trusted artifact**

`snapshot-admission.v1` and the installed root policy must reference the Adapter OCI digest plus build-proof/custody digests. A local Task 7 bundle, PR artifact, mutable tag, same archive under a different unattested OCI manifest or proof from another main SHA must fail.

- [ ] **Step 6: Run workflow and proof tests**

```powershell
node --test scripts/release/create-snapshot-adapter-build-proof.test.mjs scripts/release/verify-snapshot-adapter-build-workflow.test.mjs scripts/release/snapshot-adapter-bundle.test.mjs
node scripts/release/verify-snapshot-adapter-build-workflow.mjs --workflow .github/workflows/snapshot-adapter-build.yml
pnpm release:contracts:verify
pnpm prettier --check .github/workflows/snapshot-adapter-build.yml scripts/release release/contracts
git diff --check
```

- [ ] **Step 7: Commit without dispatching the producer**

```powershell
git add .github/workflows/snapshot-adapter-build.yml packages/release-foundation/src/schema-registry.mjs scripts/release/create-snapshot-adapter-build-proof.mjs scripts/release/create-snapshot-adapter-build-proof.test.mjs scripts/release/verify-snapshot-adapter-build-workflow.mjs scripts/release/verify-snapshot-adapter-build-workflow.test.mjs scripts/release/build-snapshot-adapter.mjs scripts/release/verify-snapshot-adapter-bundle.mjs release/contracts
git commit -m "ci: publish trusted snapshot adapter artifacts"
```

Expected: repository tests prove the producer contract, but no Adapter artifact is trusted until this commit is merged to `main` and Infrastructure Task I1 executes the protected workflow.

---

### Task 18: Publish the operational runbook and pass the repository implementation gate

**Files:**

- Create: `docs/operations/stage1-s1-execution-infrastructure-runbook.md`
- Create: `docs/operations/templates/stage1-snapshot-bootstrap-approval.v1.json`
- Create: `docs/operations/templates/stage1-snapshot-attempt-approval.v1.json`
- Create: `docs/operations/templates/stage1-snapshot-failure-record.v1.json`
- Create: `docs/operations/README.md`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Runbook boundary:**

The runbook documents commands that generate plans and readbacks, but every real `apply` section is a separately checked human gate. It may not embed credentials, mutable image tags, raw SQL/Shell payload paths or instructions to weaken a failed control.

- [ ] **Step 1: Document prerequisites and exact identity inventory**

Include approved SHA/spec/plan references, current Environment `ABSENT` baseline, required GitHub/Alibaba/Staging immutable IDs, Task 30 stash fingerprint, expected PostgreSQL 17 datasource verification and the rule that this repository-only checkpoint creates no external state.

- [ ] **Step 2: Document the ordered external change sequence**

Use exactly the Infrastructure Task I1–I22 order below. Each external mutation section names its plan/apply/readback CLI, proof path, operation ID, independent approval and UNKNOWN boundary; no paragraph may combine separate GitHub, Alibaba, Staging or WSL writes under one approval.

- [ ] **Step 3: Add failure and UNKNOWN recovery tables**

Cover Environment partial apply, OIDC drift, JIT route mismatch, cancelled self-hosted job, incomplete OSS upload, KMS denial, source fingerprint drift, LUKS cleanup failure, database result ambiguity, capacity rejection and GitHub-hosted infrastructure outage. UNKNOWN must reconcile; it cannot rerun a write step directly.

- [ ] **Step 4: Add retention and access operations**

State snapshot 30-day validity, 210-day locked WORM, invalidation plus 180-day retention, reader/publisher separation, access-log review, and deletion/transition receipt after retention. Explicitly record the existing public Actions artifact/30-day approach as closed only after Task 14 and a real negative audit.

- [ ] **Step 5: Run the complete repository gate**

```powershell
git status --short
pnpm install --frozen-lockfile
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

Deliver the repository gate report, exact merged main SHA, controlled datasource migration status and proposed GitHub/Alibaba/Staging plan digests. Obtain a new explicit authorization before Infrastructure Task I1; plan approval or PR merge alone is insufficient.

---

## External Infrastructure and Qualification Tasks

Tasks I1–I22 run only after Tasks 0–18 are merged to `main`, required CI is green and the user grants a new external-change authorization. They do not create repository commits.

For every mutating task below:

1. Set `releaseAttemptId` and an immutable task-specific `operationId` before planning.
2. Write the canonical plan to `.release-local/evidence/${releaseAttemptId}/${operationId}/plan.json`.
3. Place the separately signed human approval in `approval.json`; approval of this plan is never sufficient.
4. Pass approval and capability credentials only as protected file descriptors to `apply`.
5. Store `apply-proof.json`, `readback.json` and the trusted-custody receipt before moving to the next task.
6. On a lost or ambiguous apply response, write `INTERRUPTED_UNKNOWN.json` and run only `reconcile` with the same operation ID. A new apply requires a new plan and approval after reconciliation.

At the start of I1, create one non-secret attempt record through the registered generator and derive every proof directory consistently:

```powershell
$stage1MainSha = git rev-parse origin/main
node scripts/release/create-infrastructure-attempt.mjs --main-sha $stage1MainSha --owner-id 275060624 --output .release-local/infrastructure-attempt.v1.json
$stage1ReleaseAttemptId = (Get-Content -Raw .release-local/infrastructure-attempt.v1.json | ConvertFrom-Json).releaseAttemptId
```

For each task set `$stage1OperationId` to its declared deterministic value and `$stage1OperationEvidence = ".release-local/evidence/$stage1ReleaseAttemptId/$stage1OperationId"`; the CLI creates only that exact directory. These values are identifiers, not credentials.

### Infrastructure Task I1: Produce and custody the trusted Adapter artifact

**Command:** `.github/workflows/snapshot-adapter-build.yml` from the exact merged `main` SHA.

**Proof directory:** `.release-local/evidence/${releaseAttemptId}/i1-adapter-build-${mainSha}/`.

- [ ] Dispatch `gh workflow run snapshot-adapter-build.yml --ref main` only after recording the current `mainSha`; do not supply an archive, script path or PR artifact.
- [ ] Wait for the exact `run_id`/attempt 1, then verify the protected `trusted-image-build` deployment, workflow SHA, runner provenance and successful conclusion.
- [ ] Resolve `ghcr.io/keqi119/subscription-snapshot-adapter` from the registry to its immutable OCI digest; verify its GitHub attestation, archive/SBOM/file-manifest hashes and source SHA.
- [ ] Store `snapshot-adapter-build-proof.v1` and `snapshot-adapter-artifact-custody.v1` under the proof directory and re-download/read back both before accepting I1.
- [ ] Treat a cancelled or ambiguous publication as `INTERRUPTED_UNKNOWN`; inspect workflow and registry state by run ID/digest. Never rebuild locally or overwrite the OCI tag.

### Infrastructure Task I2: Create and read back the Aliyun OIDC Provider

**CLI:** `scripts/release/bootstrap-aliyun-oidc-provider.mjs`.

**Operation ID:** `i2-aliyun-oidc-provider-${releaseAttemptId}`.

- [ ] Run `node scripts/release/bootstrap-aliyun-oidc-provider.mjs plan --operation-id $stage1OperationId --output $stage1OperationEvidence/plan.json` using read-only account observation.
- [ ] Review the fixed provider name, issuer, sole audience/client ID `sts.aliyuncs.com`, independently derived CA fingerprints, one-hour issuance limit and target ARN; sign only this plan digest.
- [ ] Run `node scripts/release/bootstrap-aliyun-oidc-provider.mjs apply --plan $stage1OperationEvidence/plan.json --approval-fd 3 --credential-fd 4 --proof $stage1OperationEvidence/apply-proof.json`, followed by `node scripts/release/bootstrap-aliyun-oidc-provider.mjs readback --operation-id $stage1OperationId --output $stage1OperationEvidence/readback.json`.
- [ ] Verify every provider field and ARN before any GitHub subject customization. UNKNOWN uses `reconcile`; it must not delete or replace a possibly pre-existing provider.

### Infrastructure Task I3: Create and read back the snapshot Environment

**CLI:** `scripts/release/bootstrap-snapshot-environment.mjs`.

**Operation ID:** `i3-snapshot-environment-${releaseAttemptId}`.

- [ ] Run `plan` against repository ID `1253231368` and the current `ABSENT` or readback state; store the plan under the common evidence directory.
- [ ] Approve only Environment `stage1-snapshot-export`, reviewer ID `275060624`, `main` deployment branch, no tags, `can_admins_bypass=false`, `prevent_self_review=false` and wait timer `0`.
- [ ] Run `apply` with separate approval/admin descriptors, then `readback`; freeze the stable identity digest separately from observation provenance.
- [ ] Do not dispatch or approve a workflow in this task. Partial creation is UNKNOWN and must reconcile exact Environment, reviewer and branch-policy IDs.

### Infrastructure Task I4: Create the dedicated launcher GitHub App

**CLI:** `scripts/release/bootstrap-snapshot-launcher-app.mjs`.

**Operation ID:** `i4-launcher-app-${releaseAttemptId}`.

- [ ] Run `plan` and approve only repository Administration write, Actions/Contents/Deployments/Metadata read, repository ID `1253231368` and no organization or source-write scope.
- [ ] Run `apply`, then `readback`; record App ID, installation ID, repository selection, permission digest and public key fingerprint.
- [ ] Deliver the private key through the approved root secret broker in a separate descriptor-only action and store only its delivery receipt; the workflow and Runner never receive it.
- [ ] UNKNOWN reconciles the exact App/installation before any retry and must not create a second installation.

### Infrastructure Task I5: Create reversible private custody resources

**CLI:** `scripts/release/manage-snapshot-cloud-custody.mjs --resource base-custody`.

**Operation ID:** `i5-aliyun-base-custody-${releaseAttemptId}`.

- [ ] Run `plan` after I2 readback; approve the deterministic private bucket, KMS key/alias, access logging, root broker principal and mutually exclusive base capability policies. WORM is explicitly absent from this plan.
- [ ] Run `apply`, then `readback`; verify account/region/resource IDs, private ACL, public-access block, versioning disabled, KMS state, broker assume-role-only policy and absence of business bucket/key reuse.
- [ ] Use synthetic ciphertext to prove publisher cannot Get/List/Delete, reader cannot Put or manage KMS, and broker has no OSS/KMS permission.
- [ ] On UNKNOWN, disable only newly proven principals and run exact-resource reconcile. Do not infer success from resource names.

### Infrastructure Task I6: Lock the 210-day retention policy

**CLI:** `scripts/release/manage-snapshot-cloud-custody.mjs --resource retention-lock`.

**Operation ID:** `i6-aliyun-retention-lock-${releaseAttemptId}`.

- [ ] Re-read I5 resources and generate a separate plan containing only the BucketWorm 210-day transition and its irreversible effect.
- [ ] Obtain a new human approval bound to bucket ID, current empty or synthetic-only state, duration and plan digest; I5 approval is invalid here.
- [ ] Run `apply`, then `readback`; record server-side retention ID/state/duration and custody receipt.
- [ ] A lost response is UNKNOWN. Run `reconcile` against the retention ID; never re-run the lock or recreate the bucket.

### Infrastructure Task I7: Allocate and provision the OIDC canary identity

**CLIs:** `gh workflow run snapshot-oidc-canary.yml --ref main` and `scripts/release/manage-exact-run-capability.mjs`.

**Operation ID:** `i7-oidc-canary-role-${releaseAttemptId}-${canaryRunId}`.

- [ ] Dispatch the canary workflow only far enough to allocate numeric `canaryRunId`; confirm its token job is paused behind `stage1-snapshot-export` and has not received Environment approval or OIDC.
- [ ] Generate the exact future customized subject using provider ARN, workflow/ref/SHA, actor/repository IDs, Environment, run ID/attempt 1, event and GitHub-hosted runner claim.
- [ ] Run capability `plan`, obtain a separate approval, then `apply` and `readback` the exact canary RAM role. Wildcards or a different run/attempt fail.
- [ ] Keep the canary job paused. UNKNOWN role creation must reconcile before GitHub repository settings can change.

### Infrastructure Task I8: Switch the repository subject and complete the canary

**CLIs:** `scripts/release/bootstrap-github-oidc-subject.mjs` and `scripts/release/run-aliyun-oidc-canary.mjs`.

**Operation ID:** `i8-github-oidc-subject-${releaseAttemptId}`.

- [ ] Run subject `plan` with I2 Provider and I7 canary-role readbacks, plus the complete existing-consumer inventory. Stop with `OIDC_CONSUMER_MIGRATION_REQUIRED` if any current consumer cannot match the future subject.
- [ ] Obtain independent approval, run subject `apply`, then `readback`; compare the exact ordered claim keys and repository identity.
- [ ] Only after successful readback, approve the pending canary deployment. The job requests audience `sts.aliyuncs.com`, calls `AssumeRoleWithOIDC` and identity readback only, and emits redacted claims/session proof.
- [ ] Run `manage-exact-run-capability.mjs revoke` for the canary role and read back denial/expiry. Subject-update UNKNOWN must reconcile repository settings before approving the job; do not delete shared settings speculatively.

### Infrastructure Task I9: Publish the Staging loopback database endpoint

**CLI:** `scripts/release/manage-staging-snapshot-boundary.mjs --resource loopback-endpoint`.

**Operation ID:** `i9-staging-loopback-${releaseAttemptId}`.

- [ ] Run `plan` against the exact Staging host, Compose project/container and current bindings; reject production/unknown host or port collision.
- [ ] Approve only `127.0.0.1:55432:5432`, apply through the server-admin descriptor, then read back Docker binding/project/container identities and application health.
- [ ] Verify the port is not externally reachable. UNKNOWN reconciles actual Compose/runtime state before any restart.

### Infrastructure Task I10: Create the forwarding-only SSH account

**CLI:** `scripts/release/manage-staging-snapshot-boundary.mjs --resource ssh-account`.

**Operation ID:** `i10-staging-ssh-${releaseAttemptId}`.

- [ ] Plan and approve only user `stage1_snapshot_tunnel`, the dedicated key fingerprint and exact `127.0.0.1:55432` permit-open target.
- [ ] Apply the committed sshd/authorized_keys policy, validate configuration before reload and read back account, group, key, option and Match-policy state.
- [ ] Prove Shell, PTY, SFTP, agent/X11, remote/dynamic forwarding and every other destination fail; local forwarding to the exact endpoint succeeds.
- [ ] UNKNOWN reconciles the exact account/key/config before reload or disable; it never modifies the administrator SSH path.

### Infrastructure Task I11: Create the read-only Staging database role

**CLI:** `scripts/release/manage-staging-snapshot-boundary.mjs --resource database-reader`.

**Operation ID:** `i11-staging-db-reader-${releaseAttemptId}`.

- [ ] Plan against the exact database name/OID and store the proposed role/grant delta. Approve only the committed infrastructure SQL; no business DML/DDL or Prisma migration is allowed.
- [ ] Apply with a database-admin descriptor, revoke that descriptor, then read back role OID/attributes/memberships/ownership/grants/timeouts/RLS through the independent verify identity.
- [ ] Prove `SELECT` works and every DML, DDL, owner, role, large-object and bypass probe fails. UNKNOWN reconciles catalog facts with the same operation ID.

### Infrastructure Task I12: Create and qualify the dedicated WSL distro

**CLI:** `scripts/release/manage-snapshot-wsl-host.mjs --resource distro`.

**Operation ID:** `i12-wsl-distro-${releaseAttemptId}`.

- [ ] Run host audit and `plan`; bind Windows host facts, pinned Ubuntu rootfs/Runner digests, dedicated import directory, capacity, interop/automount/swap, pagefile/hibernation/crash-dump/device-encryption and egress policy.
- [ ] Obtain approval, run `apply`, restart only the dedicated distro, then `readback` the distro/kernel/filesystem/network/systemd/non-privileged-user facts.
- [ ] Prove no Docker group/socket, sudo, Windows mounts/PATH, swap, auto-update or unrelated Runner service exists.
- [ ] UNKNOWN reconciles exact distro/import/service state; it does not unregister or delete any other distro.

### Infrastructure Task I13: Create the root admission signer

**CLI:** `scripts/release/manage-snapshot-wsl-host.mjs --resource admission-signer`.

**Operation ID:** `i13-admission-signer-${releaseAttemptId}`.

- [ ] Plan the non-exportable root-held Ed25519 key path and public-key digest placement in root policy; obtain a separate approval.
- [ ] Run `apply`, then `readback`; store the public-key digest and a challenge-signature verification proof, never the private key.
- [ ] Verify Runner user and workflow cannot read, invoke or replace the key except through the fixed admission-verification operation. UNKNOWN reconciles key/public digest existence and never regenerates over an unknown key.

### Infrastructure Task I14: Install the attested Adapter by digest

**CLI:** `scripts/release/manage-snapshot-wsl-host.mjs --resource adapter-install`.

**Operation ID:** `i14-adapter-install-${releaseAttemptId}`.

- [ ] Plan against the I1 OCI/build/custody digests and I12 host-policy readback. A local bundle, tag, PR artifact or different main SHA is rejected.
- [ ] Obtain approval, pull by OCI digest, verify attestation/archive/SBOM/file manifest, then install the allowlisted files under `/opt/subscription-saas/snapshot-adapter/v1/`.
- [ ] Read back every path/owner/mode/digest, systemd unit, root-policy digest and absence of mutable package managers/update hooks in the installed runtime.
- [ ] UNKNOWN reconciles the exact install manifest; it may quarantine the incomplete target but must not overwrite it or fall back to the repository checkout.

### Infrastructure Task I15: Run the closed synthetic qualification rehearsal

**Command:** `/opt/subscription-saas/snapshot-adapter/v1/bin/snapshot-job qualify --suite closed-security-rehearsal-v1 --request-fd 3`.

**Operation ID:** `i15-synthetic-rehearsal-${releaseAttemptId}`.

- [ ] Prepare an isolated PostgreSQL 17 synthetic source containing versioned representative records and unique sanitization canaries; no Staging identity is injected.
- [ ] Approve the fixed suite, exact labels, synthetic roles/object keys and fault matrix; run each scenario as a fresh sub-operation with its own evidence directory.
- [ ] Prove success plus cancellation before/after JIT, route collision, SSH/write denial, sanitizer/raw-partial-output rejection, KMS denial, OSS conflict/network ambiguity, destruction failure and custody-consumer cross-run denial.
- [ ] Reconcile every UNKNOWN, revoke all synthetic per-run identities, prove host idle/non-routable and store retained WORM-object disposition. Any missing scenario blocks I16.

### Infrastructure Task I16: Allocate the real producer and provision its publisher identity

**CLIs:** `gh workflow run sanitized-snapshot.yml --ref main` and `scripts/release/manage-exact-run-capability.mjs --capability snapshot-publisher`.

**Operation ID:** `i16-producer-publisher-${releaseAttemptId}-${snapshotRunId}`.

- [ ] Dispatch only the admission portion from exact merged `main`; record numeric `snapshotRunId`, attempt 1 and queued data/custody jobs. Neither job may pass `stage1-snapshot-export` yet.
- [ ] Verify and sign the non-sensitive admission through the root launcher, then plan the exact broker-assumable publisher role bound to release attempt, object key, KMS context and 900-second maximum session.
- [ ] Obtain a producer-specific approval, run role `apply` and `readback`, then let the root broker assume and deliver the publisher-only STS credential through the sealed descriptor. Record delivery proof without secret material.
- [ ] Keep Environment blocked until I17 finishes its independent custody-reader role. UNKNOWN role or STS delivery must reconcile; no new credential may be minted under the same approval after ambiguity.

### Infrastructure Task I17: Provision producer custody identity and release the real run

**CLI:** `scripts/release/manage-exact-run-capability.mjs --capability snapshot-custody-reader`.

**Operation ID:** `i17-producer-custody-${releaseAttemptId}-${snapshotRunId}`.

- [ ] Plan the exact GitHub OIDC custody-reader subject for the already allocated run, attempt, workflow, Environment and job. Do not reuse the publisher plan or combine policies.
- [ ] Obtain a new approval, run `apply` and `readback`, and confirm both publisher-delivery and custody-reader proofs match the same immutable admission.
- [ ] After both role readbacks and the publisher credential-delivery proof exist, approve the pending `stage1-snapshot-export` Environment deployment once. The root launcher verifies post-approval observation and exclusive route, creates one JIT Runner and executes the fixed export, sanitize, encrypt and write-once path.
- [ ] The custody job remains ordered by an explicit `needs` dependency until data and host-destruction proofs are durable; it then obtains only its exact OIDC role, performs private readback, attestation and custody, and emits `snapshot-producer-completion.v1`. Environment approval alone cannot bypass that dependency.
- [ ] Any ambiguous upload, job, Runner or destruction result is UNKNOWN and blocks producer completion until reconciled; never rerun export or upload under this attempt.

### Infrastructure Task I18: Revoke producer identities and freeze successful completion

**CLI:** `scripts/release/manage-exact-run-capability.mjs revoke|readback`.

**Operation IDs:** the exact I16 publisher and I17 custody operation IDs.

- [ ] Revoke both per-run roles through separate revoke proofs, verify the broker can no longer assume publisher and wait or read back expiry of every issued STS session.
- [ ] Verify GitHub reports the JIT Runner removed, no matching labels or job remain routable, LUKS unlock fails, source before/after fingerprints match and no plaintext, raw or partial artifact exists.
- [ ] Re-read private OSS/KMS/proof custody and freeze the successful `snapshot-producer-completion.v1`; otherwise mark the attempt unusable and return to I16 with a new `releaseAttemptId`.
- [ ] UNKNOWN revocation is reconciled before any RC dispatch.

### Infrastructure Task I19: Allocate the qualification RC and provision source-snapshot access

**CLIs:** `gh workflow run release-candidate-gate.yml --ref main` and `scripts/release/manage-exact-run-capability.mjs --capability rc-source-snapshot-consumer`.

**Operation ID:** `i19-rc-source-consumer-${releaseAttemptId}-${rcWorkflowRunId}`.

- [ ] Freeze a v2 `approval-record` with `executionPurpose=qualification`, exact successful producer completion, main/build proof, API/Web/Runner digests, repository/migration/test/sanitization digests and snapshot digest.
- [ ] Dispatch one RC run only far enough to allocate numeric `rcWorkflowRunId`; all Environment-protected consumer jobs remain paused and no external final, aggregate or exit input is accepted.
- [ ] Plan, separately approve, apply and read back the exact source-snapshot consumer role under `trusted-source-database-gate` for this run, attempt and job.
- [ ] Keep its Environment deployment blocked until I20 provisions the other consumer. UNKNOWN role state reconciles before release.

### Infrastructure Task I20: Provision final-snapshot access and release RC execution

**CLI:** `scripts/release/manage-exact-run-capability.mjs --capability rc-final-snapshot-consumer`.

**Operation ID:** `i20-rc-final-consumer-${releaseAttemptId}-${rcWorkflowRunId}`.

- [ ] Plan, independently approve, apply and read back the exact final-snapshot consumer role under `trusted-release-execution`; it may read and decrypt only the I18 snapshot object.
- [ ] Verify source and final roles have separate credentials and operation IDs, and both exact subjects match the same qualification approval, run, attempt and build proof.
- [ ] Release the approved source/final Environments. Every job first emits runner provenance and capacity admission; rejection fails the RC without pruning data, skipping tests or moving to self-hosted execution.
- [ ] Run source fresh/snapshot and final fresh/snapshot chains with separate databases, Manifests, operation IDs and proofs; final gates use digest-pinned images, capability-separated migration/verify/runtime-test identities and real Playwright network capture.

### Infrastructure Task I21: Aggregate the qualification DAG and revoke RC identities

**Command:** the fixed same-run tail of `.github/workflows/release-candidate-gate.yml` plus `manage-exact-run-capability.mjs revoke|readback`.

**Operation ID:** `i21-qualification-tail-${releaseAttemptId}-${rcWorkflowRunId}`.

- [ ] In the same `rcWorkflowRunId`, produce v2 custody receipts, `release-aggregate-proof.v2` and `s1-exit-evidence.v2`, all with `executionPurpose=qualification`. Never import a source, final, aggregate or exit proof from another run.
- [ ] Run `assertPromotionEligible` and require the expected rejection `QUALIFICATION_EVIDENCE_NOT_PROMOTABLE`; also prove v1, missing-purpose, mixed-purpose and cross-attempt evidence are rejected.
- [ ] Revoke source and final consumer roles separately, read back denial and session expiry, then verify proof custody before deleting only exact marker-bound temporary databases.
- [ ] Emit `TASK_30_AUTHORIZATION_REQUIRED` and stop. Do not execute exit audit or final custody, apply the Task 30 stash, mark S1 complete or reuse this producer/RC evidence in a future release-candidate run.

### Infrastructure Task I22: Deliver the Task 29R package and request authorization

**Files:** none unless a separately approved documentation correction is required.

- [ ] Assemble merged main SHA, Adapter proof, API/Web/Runner digests, contract digests, I2–I14 infrastructure readbacks, I15 rehearsal, I18 producer completion, I19–I21 source/final/custody/aggregate/qualification-exit proofs and every failure/reconcile record.
- [ ] Prove no JIT Runner, unlocked LUKS volume, plaintext snapshot, active per-run role/session or unreconciled UNKNOWN remains; verify the Task 30 stash fingerprint is unchanged.
- [ ] Report accepted manual/N/A evidence, single-operator Environment risk, retained WORM objects and expiry/disposition owners without summarizing missing evidence as success.
- [ ] Ask for explicit approval or rejection of resuming Task 30. Until granted, do not apply, pop or drop the stash; implement Task 30; declare S1 complete; or start S2/S3.

## Specification Coverage Matrix

| Approved addendum requirement                          | Implementation tasks                     | Completion evidence                                                          |
| ------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------- |
| Independent producer, then one same-run RC chain       | 2, 3, 9, 14–16; I16–I21                  | Admission/JIT/producer proofs plus same-run DAG checkpoint                   |
| Public-repository exclusive JIT routing                | 2, 3, 8, 9, 13–14; I3–I4, I7–I8, I12–I18 | Environment identity, route observation, exact labels, terminal cleanup      |
| No arbitrary repository code on data host              | 7–9, 14, 17; I1, I12–I15                 | Adapter allowlist/SBOM, workflow structural audit, negative launch tests     |
| Trusted Adapter main artifact chain                    | 7, 17; I1, I14                           | Protected-main OCI digest, attestation, custody and installed-file readback  |
| Dedicated WSL, LUKS and truthful destruction           | 8; I12–I18                               | Host policy, LUKS lifecycle proof, destruction receipt                       |
| Restricted SSH/read-only PostgreSQL source             | 10–11; I9–I11, I16–I18                   | Target policy, privilege negatives, source fingerprints, MVCC proof          |
| Valid PostgreSQL 17 snapshot semantics                 | 0, 10–11, 15; I15, I20                   | Controlled migration status and three-session MVCC test                      |
| Private encrypted custody, not public artifact         | 4–6, 14–15; I5–I6, I15–I21               | Envelope/custody proofs, private OSS/KMS readback, workflow audit            |
| KEK/DEK lifecycle and isolated crypto                  | 4–6; I5, I15–I21                         | Synthetic/real crypto proof and leak scan                                    |
| Environment identity versus observation                | 2–3, 13–14; I3, I7–I8, I16–I21           | Stable identity digest, fresh observation, drift negatives                   |
| Exact OIDC and least-privilege identities              | 3, 6, 13; I2, I7–I8, I16–I21             | Provider/readback, exact subject and cross-run/capability denials            |
| Capacity and fixed GitHub-hosted identity              | 12, 15, 17; I1, I15, I20                 | Capacity plans and runner provenance for every chain                         |
| Machine-isolated qualification evidence                | 16; I19–I22                              | v2 purpose bindings and expected promotion rejection                         |
| Snapshot retention and disposition                     | 4, 6, 17; I5–I6, I15–I22                 | 30-day expiry, locked 210-day WORM, retention receipts                       |
| Failure, cancellation, UNKNOWN and reconcile           | 2–9, 13–18; I1–I22                       | Failure proofs, reconciliation chain, preserved attempts                     |
| Task 29R allowed only after real gate; Task 30 blocked | 1, 16, 18; I19–I22                       | `TASK_30_AUTHORIZATION_REQUIRED`, non-promotable v2 evidence and stash audit |

## External Approval Checkpoints

| Checkpoint | Bound plan/change                                              | Approval does not authorize                                  |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| I1         | Protected-main Adapter producer dispatch                       | Local build substitution, install or infrastructure creation |
| I2         | Aliyun OIDC Provider exact identity                            | GitHub subject customization or RAM role creation            |
| I3         | Snapshot Environment creation                                  | Workflow approval, App or cloud changes                      |
| I4         | Launcher App/installation and private-key delivery             | JIT registration or workflow execution                       |
| I5         | Reversible OSS/KMS/RAM base custody                            | WORM lock, Staging access or snapshot data                   |
| I6         | Irreversible 210-day WORM lock                                 | Producer or RC execution                                     |
| I7         | One exact future-subject canary role                           | Repository subject change or Environment release             |
| I8         | Repository subject switch and one canary deployment            | Any data workflow                                            |
| I9         | Staging loopback endpoint                                      | SSH/DB identities or data access                             |
| I10        | Forwarding-only SSH account                                    | Database role or snapshot export                             |
| I11        | Read-only database role                                        | Business DML/DDL, migration or export                        |
| I12        | Dedicated WSL distro                                           | Signer, Adapter install or JIT registration                  |
| I13        | Root admission signer                                          | Adapter install or workflow execution                        |
| I14        | Attested Adapter installation                                  | JIT registration or data access                              |
| I15        | Synthetic qualification rehearsal                              | Staging credentials/data                                     |
| I16        | Exact real-producer publisher role and one credential delivery | Environment release or RC execution                          |
| I17        | Exact producer custody role and staged Environment releases    | Retry with changed inputs or RC dispatch                     |
| I18        | Producer role revocation and completion freeze                 | RC dispatch until revocation readback succeeds               |
| I19        | Qualification approval/run and exact source consumer role      | Final consumer role, promotion or Task 30                    |
| I20        | Exact final consumer role and RC source/final execution        | External proof import, promotion or Task 30                  |
| I21        | Same-run qualification aggregate/exit and role revocation      | Promotion, Task 30, S1 completion or evidence reuse          |
| I22        | Review decision                                                | Only a new explicit authorization may resume Task 30         |

## Stop and Recovery Matrix

| Condition                                           | Required response                                                              | Prohibited shortcut                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Controlled PostgreSQL 17 migration status fails     | Stop before code implementation and diagnose migrations                        | Treating Prisma validation as migration proof                   |
| Existing OIDC consumer cannot accept exact subject  | Stop 方案 A，return to infrastructure design                                   | Replacing exact claims with wildcard                            |
| Environment absent/misconfigured or bypass occurs   | Reject admission; reconcile GitHub state                                       | Manual assertion that approval occurred                         |
| OSS/KMS/RAM policy broader than contract            | Disable new principals; preserve readback/failure proof                        | Reusing business bucket or application credentials              |
| WORM configured incorrectly after lock              | Disable access and retain until disposition is legal                           | Deleting/recreating evidence or claiming rollback               |
| Source identity has write/owner/RLS bypass          | Disable role/account and block snapshot                                        | Continuing because the export query is read-only                |
| Host encryption/pagefile/route isolation unprovable | Stop 方案 A，prepare dedicated infrastructure proposal                         | Ordinary file deletion as sanitization                          |
| Capacity plan rejects a GitHub-hosted chain         | Fail RC attempt and request a separate VM plan                                 | Pruning unknown data, skipping tests or self-hosting final jobs |
| Producer attempt fails before durable object commit | Preserve failure proof, destroy local volume, use new attempt                  | Reuse admission/JIT token or same object key                    |
| Producer commit/result is uncertain                 | Mark `INTERRUPTED_UNKNOWN` and reconcile OSS/GitHub/source facts               | Blindly rerun export/upload                                     |
| RC stage infrastructure failure                     | Preserve failure, rerun complete stage on same immutable bundle with new proof | Replace one image or edit prior proof                           |
| Proof custody cannot be verified                    | Do not clean databases or promote result                                       | Depending on transient runner workspace                         |
| Task 29R evidence checkpoint succeeds               | Stop and request Task 30 authorization                                         | Run exit audit, apply stash or declare S1 complete              |

## Completion Boundary

This plan is complete only when:

1. Tasks 0–18 have merged to `main` with required CI green; I1 has produced the immutable Adapter build and custody proof.
2. Each I2–I21 external mutation or execution has its own approved plan, apply journal, readback proof and trusted custody receipt; no UNKNOWN remains unresolved.
3. One real producer attempt has a successful `snapshot-producer-completion.v1`, and one immutable RC run has completed both source/final chains plus same-run `release-aggregate-proof.v2` and `s1-exit-evidence.v2`, all bound to `executionPurpose=qualification` and proven non-promotable.
4. The environment is idle: no JIT Runner, unlocked LUKS volume, plaintext snapshot or active per-run credential remains.
5. Task 30 stash is unchanged and I22 has stopped at an explicit authorization request.

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
