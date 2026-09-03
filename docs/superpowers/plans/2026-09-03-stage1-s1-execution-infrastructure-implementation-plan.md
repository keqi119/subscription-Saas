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
- Dedicated custody bucket 的名称由 `subscription-saas-stage1-snapshot-${sha256(accountId).slice(0, 12)}-cn-shanghai` 确定性生成。Bucket 必须保持 versioning disabled，使用 `x-oss-forbid-overwrite=true`，并锁定 210 日 BucketWorm；30 日 snapshot 有效期加失效后 180 日保留由此覆盖。
- KMS key alias 固定为 `alias/stage1-snapshot-custody`。Producer 使用 `GenerateDataKey(AES_256)`；consumer 只对 admission 指定的 wrapped DEK 调用 `Decrypt`。KEK 不离开 KMS，明文 DEK 只短暂存在于独立 crypto process 内存。
- Snapshot publisher、snapshot custody reader、RC decrypt consumer、retention operator 是四个不同 RAM capability。每次只发放一种短期凭证；禁止组合凭证、通用 OSS 列举、跨 attempt 读取或 KMS 管理权限。
- GitHub OIDC subject 固定包含 immutable repository identity、`workflow_ref`、`workflow_sha`、`ref`、`environment`、`actor_id`、`run_id`、`run_attempt`、`event_name` 和 `runner_environment`。每个 snapshot/RC consumer role 的 trust policy 对本次完整 subject 做精确匹配，不使用 run ID 通配符。
- Repository OIDC customization 是 repo-wide 外部状态。若当前配置已被其他云角色依赖、无法安全迁移，或 Alibaba RAM 无法对完整 `sub` 做精确比较，立即停止方案 A 并回到设计评审。
- GitHub repository 固定为 `keqi119/subscription-Saas`、repository ID `1253231368`；允许 actor/reviewer 固定为 user ID `275060624`。名称或 login 不能替代 immutable ID。
- Snapshot Environment 固定为 `stage1-snapshot-export`：唯一 branch rule `main`、无 tag rule、`can_admins_bypass=false`、`prevent_self_review=false`、wait timer `0`。本批准接受的单操作员风险不扩展到其他 Environment。
- GitHub-hosted RC jobs continue to use the already designed environments `trusted-source-database-gate`, `trusted-release-execution` and `trusted-release-candidate`. Task 13 inventories and freezes their actual IDs/policies; if any is absent or broader than its approved S1 contract, this plan stops for a separate change plan instead of silently creating or widening it.
- Snapshot job 的完整标签集合必须精确为 GitHub 默认 `self-hosted/linux/x64`、能力标签 `stage1-snapshot-export` 和一次性标签 `stage1-snapshot-export-${snapshotRunId}-${routeNonce}`。Runner 只执行一个 job，随后注销、销毁。
- Snapshot self-hosted job 不 checkout、不调用 `uses`、不执行 package manager、仓库脚本、任意 Shell/SQL 路径或 Docker。唯一支持入口为 `/opt/subscription-saas/snapshot-adapter/v1/bin/snapshot-job launch --admission-ref`。
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
- Task 24 是一个不可提升的 Task 29R qualification release attempt；它的 producer 与 RC run 只证明基础设施前缀，不能在 Task 30 获批后继续、复用或拼接为最终 S1 证明。Task 30 后续获批并合并时，必须以新的 `releaseAttemptId` 重跑“新 producer → 新且唯一完整 RC run”，由该完整 RC run 原生执行 exit audit 与最终 custody。
- 任何 identity、digest、approval、capacity、source privilege、fingerprint、custody、destruction 或 same-run 约束不满足，均 fail closed。禁止通过 mock JSON、手工“通过”、公共 artifact、常驻 Runner 或服务器 Compose 替代。

## Fixed Names and Derivations

| Item                     | Fixed value or deterministic derivation                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Snapshot Environment     | `stage1-snapshot-export`                                                               |
| RC source Environment    | `trusted-source-database-gate`, existing identity must be read back                    |
| RC final Environment     | `trusted-release-execution`, existing identity must be read back                       |
| RC aggregate Environment | `trusted-release-candidate`, existing identity must be read back                       |
| Repository               | `keqi119/subscription-Saas`, ID `1253231368`                                           |
| Actor/reviewer           | `keqi119`, user ID `275060624`                                                         |
| Snapshot workflow        | `.github/workflows/sanitized-snapshot.yml` on exact `main` SHA                         |
| RC workflow              | `.github/workflows/release-candidate-gate.yml` on exact `main` SHA                     |
| Capability label         | `stage1-snapshot-export`                                                               |
| Unique route label       | `stage1-snapshot-export-${snapshotRunId}-${routeNonce}`                                |
| Root policy              | `/etc/subscription-saas/snapshot-adapter/v1/root-policy.v1.json`                       |
| Adapter root             | `/opt/subscription-saas/snapshot-adapter/v1/`                                          |
| Root secret handoff      | `/run/subscription-saas/snapshot-secrets/${releaseAttemptId}.json`, tmpfs, mode `0400` |
| LUKS backing file        | `/var/lib/subscription-saas/snapshot-volumes/${releaseAttemptId}.luks`                 |
| LUKS mapper              | `subscription-s1-${releaseAttemptId}` after strict identifier validation               |
| OSS region               | `oss-cn-shanghai`                                                                      |
| Custody bucket           | `subscription-saas-stage1-snapshot-${sha256(accountId).slice(0, 12)}-cn-shanghai`      |
| Snapshot object key      | `v1/${releaseAttemptId}/${ciphertextDigest.slice(7)}/snapshot.enc`                     |
| KMS alias                | `alias/stage1-snapshot-custody`                                                        |
| DB loopback endpoint     | `127.0.0.1:55432` on Staging host                                                      |
| SSH user                 | `stage1_snapshot_tunnel`                                                               |
| PostgreSQL role          | `stage1_snapshot_reader`                                                               |
| Snapshot expiry          | `createdAt + 30 days`                                                                  |
| OSS WORM                 | locked BucketWorm, 210 days                                                            |

## Planned File Map

| Area               | Files and responsibility                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan alignment     | Existing S1 implementation plan: remove invalid `DEFERRABLE`, bind Task 29R to this plan, retain Task 30 block                                                                                                 |
| Routing contracts  | `release/contracts/schemas/environment-policy-*.json`, `snapshot-admission.v1`, `snapshot-jit-launch-proof.v1`, `snapshot-producer-completion.v1`                                                              |
| Custody contracts  | `release/contracts/schemas/snapshot-encryption-envelope.v1.schema.json`, `snapshot-private-custody.v1.schema.json`, `snapshot-destruction-receipt.v1.schema.json`, `snapshot-retention-receipt.v1.schema.json` |
| Shared logic       | `packages/release-foundation/src/snapshot/**`: policy/digest checks, envelope crypto, capacity calculation and proof builders                                                                                  |
| Root-owned adapter | `apps/snapshot-adapter/**`: fixed CLI, GitHub API verifier, JIT lifecycle, SSH/PostgreSQL snapshot pipeline, crypto subprocess, OSS/KMS adapters                                                               |
| Bundle             | `scripts/release/build-snapshot-adapter.mjs`, `verify-snapshot-adapter-bundle.mjs`, `release/contracts/snapshot-adapter-build.v1.json`                                                                         |
| Host policy        | `infrastructure/stage1-snapshot/wsl/**`, `infrastructure/stage1-snapshot/server/**`: WSL, LUKS, egress, sshd and loopback database endpoint configuration                                                      |
| Cloud policy       | `infrastructure/stage1-snapshot/aliyun/**`: OSS/KMS/RAM policy documents and deterministic policy generator inputs; no credentials                                                                             |
| GitHub bootstrap   | `scripts/release/bootstrap-snapshot-environment.mjs`, `prepare-snapshot-run.mjs`, `prepare-rc-snapshot-consumer-role.mjs` and tests                                                                            |
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
- Create: `release/contracts/schemas/snapshot-jit-launch-proof.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-producer-completion.v1.schema.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `packages/release-foundation/src/schema-registry.mjs`
- Create: `packages/release-foundation/test/snapshot-routing-contracts.test.mjs`

**Interfaces:**

- Produces: five strict JSON Schemas registered in `validateContract(name, value)` and included in `repositoryContractDigest`.
- Stable identity: `EnvironmentPolicyIdentityV1`; dynamic provenance: `EnvironmentPolicyObservationV1`.
- Proof order: admission digest → post-approval observation digest → JIT launch proof digest → producer completion digest.

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

`snapshot-admission.v1` binds source SHA, repository contract digest, workflow blob/action digests, releaseAttemptId, snapshotRunId, route nonce/label, adapter digest and environment identity digest. `snapshot-jit-launch-proof.v1` adds observation digest, actual runner ID/version/binary digest and exact labels. `snapshot-producer-completion.v1` binds private custody, proof/log custody, destruction receipt and GitHub run terminal state.

- [ ] **Step 5: Register every Schema in the contract digest**

Update both `schema-registry.mjs` and `repository-contract-files.v1.json`; registry keys and filenames must be one-to-one.

- [ ] **Step 6: Run contract and digest tests**

```powershell
node --test packages/release-foundation/test/snapshot-routing-contracts.test.mjs packages/release-foundation/test/schema-registry.test.mjs packages/release-foundation/test/catalogs.test.mjs
pnpm release:contracts:verify
git diff --check
```

Expected: PASS; removing any new Schema from the contract-file manifest fails `release:contracts:verify`.

- [ ] **Step 7: Commit the routing contracts**

```powershell
git add release/contracts packages/release-foundation/src/schema-registry.mjs packages/release-foundation/test/snapshot-routing-contracts.test.mjs
git commit -m "build: define snapshot routing proof contracts"
```

---

### Task 3: Implement environment identity, observation and admission verification

**Files:**

- Create: `packages/release-foundation/src/snapshot/environment-policy.mjs`
- Create: `packages/release-foundation/src/snapshot/snapshot-admission.mjs`
- Create: `packages/release-foundation/test/snapshot-environment-policy.test.mjs`
- Create: `packages/release-foundation/test/snapshot-admission.test.mjs`
- Modify: `packages/release-foundation/src/index.mjs`

**Interfaces:**

- Produces: `buildEnvironmentPolicyIdentity(input): EnvironmentPolicyIdentityV1`.
- Produces: `buildEnvironmentPolicyObservation(input): EnvironmentPolicyObservationV1`.
- Produces: `verifyPostApprovalObservation({ identity, observation, admission, now, maxAgeMs }): void`.
- Produces: `buildSnapshotAdmission(input): SnapshotAdmissionV1` and `uniqueRouteLabel(runId, nonce): string`.

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

- [ ] **Step 5: Add all P1 negative cases**

Cover Environment 404/ID drift, missing reviewer, wrong branch, any tag rule, bypass, changed self-review setting, wrong actor, stale/missing observation, duplicate queued label, rerun attempt, workflow/action digest drift and admission containing observation provenance.

- [ ] **Step 6: Run focused and repository contract tests**

```powershell
node --test packages/release-foundation/test/snapshot-environment-policy.test.mjs packages/release-foundation/test/snapshot-admission.test.mjs
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
```

- [ ] **Step 7: Commit the policy kernel**

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
- Create: `apps/snapshot-adapter/src/cloud/policy-generator.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-kms.test.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-oss.test.mjs`
- Create: `apps/snapshot-adapter/test/aliyun-policy.test.mjs`
- Create: `infrastructure/stage1-snapshot/aliyun/snapshot-cloud-policy-input.v1.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Dependencies pin exactly `ali-oss@6.23.0`, `@alicloud/credentials@2.4.7`, `@alicloud/kms20160120@3.3.0` and `@alicloud/sts20150401@1.2.0`.
- Produces: `AliyunKmsDataKeyClient`, `AliyunOssWriteOncePublisher`, `AliyunOssExactReader` and `buildAttemptRamPolicies(input)`.
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

- [ ] **Step 5: Generate mutually exclusive RAM policies**

`buildAttemptRamPolicies` emits four canonical policy documents. Publisher permits only KMS GenerateDataKey and OSS PutObject for one exact key. Custody reader permits HEAD/Get for the exact encrypted object and narrow proof objects without KMS Decrypt. RC consumer permits exact Get plus KMS Decrypt. Retention permits post-retention delete and receipt write; no profile can manage bucket/KMS or assume another role.

- [ ] **Step 6: Prove exact OIDC subject generation**

```js
assert.equal(
  buildGithubOidcSubject(claims),
  "repository_id:1253231368:workflow_ref:keqi119/subscription-Saas/.github/workflows/release-candidate-gate.yml@refs/heads/main:workflow_sha:0123456789abcdef0123456789abcdef01234567:ref:refs/heads/main:environment:trusted-release-candidate:actor_id:275060624:run_id:33718518322:run_attempt:1:event_name:workflow_dispatch:runner_environment:github-hosted"
);
```

Use the exact `include_claim_keys` order above. A missing claim or wildcard subject fails before emitting policy.

- [ ] **Step 7: Run provider tests and lockfile verification**

```powershell
pnpm install --lockfile-only
pnpm --filter @subscription-saas/snapshot-adapter test
pnpm release:contracts:verify
git diff --check
```

- [ ] **Step 8: Commit the cloud provider adapter**

```powershell
git add apps/snapshot-adapter infrastructure/stage1-snapshot/aliyun pnpm-lock.yaml
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
- Admin-facing installer/launcher binaries are separate root-only entrypoints and cannot be invoked by the Runner user.
- Build output: `.release-output/snapshot-adapter/snapshot-adapter-v1.tar.zst` plus canonical file/digest/ownership manifest.

- [ ] **Step 1: Write RED CLI grammar tests**

Test rejection of arbitrary script path, SQL path, database URL, SSH host, output path, extra argument, stdin data, `--help` execution escape, shell metacharacters and environment credentials.

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

- [ ] **Step 7: Run static and contract gates**

```powershell
node --test scripts/release/snapshot-host-policy.test.mjs
pnpm release:contracts:verify
git diff --check
```

- [ ] **Step 8: Commit host policy as code**

```powershell
git add infrastructure/stage1-snapshot/wsl release/contracts scripts/release/snapshot-host-policy.test.mjs
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
- Root launcher accepts only a decimal `snapshotRunId`; label, nonce, workflow path, SHA and job ID come from attested admission/GitHub API.

- [ ] **Step 1: Write RED public-repository route tests**

Cover PR/fork/`pull_request_target`/comment/schedule/repository-dispatch/tag/non-main/rerun, two matching queued jobs, stale admission, wrong workflow blob/action SHA, missing environment approval, bypass review, unexpected label, already-consumed releaseAttemptId and API timeout.

```js
assert.throws(
  () => verifyQueuedSnapshotJob({ ...fixture, jobs: [matchingJob, { ...matchingJob, id: 2 }] }),
  /SNAPSHOT_ROUTE_NOT_EXCLUSIVE/
);
```

- [ ] **Step 2: Fetch and verify workflow content independently**

The root launcher downloads the workflow blob for the exact source SHA through the GitHub API, computes SHA-256, parses `uses` commit pins and compares both against root policy. It does not trust workflow outputs, a local checkout or a caller-provided digest.

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

- [ ] **Step 6: Run controlled PostgreSQL tests**

```powershell
node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/snapshot-adapter test
node scripts/release/discover-database-tests.mjs --mode verify
pnpm release:contracts:verify
git diff --check
```

Expected: runtime-equivalent snapshot role reads approved objects but every write/owner/elevation probe fails.

- [ ] **Step 7: Commit the source boundary**

```powershell
git add infrastructure/stage1-snapshot/server apps/snapshot-adapter release/contracts
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

### Task 13: Implement plan-only GitHub Environment and OIDC bootstrap tooling

**Files:**

- Create: `release/contracts/schemas/github-bootstrap-plan.v1.schema.json`
- Create: `release/contracts/schemas/github-bootstrap-readback.v1.schema.json`
- Create: `scripts/release/bootstrap-snapshot-environment.mjs`
- Create: `scripts/release/bootstrap-snapshot-environment.test.mjs`
- Create: `scripts/release/verify-github-oidc-subject.mjs`
- Create: `scripts/release/verify-github-oidc-subject.test.mjs`
- Create: `scripts/release/prepare-snapshot-run.mjs`
- Create: `scripts/release/prepare-snapshot-run.test.mjs`
- Create: `scripts/release/prepare-rc-snapshot-consumer-role.mjs`
- Create: `scripts/release/prepare-rc-snapshot-consumer-role.test.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `package.json`

**Interfaces:**

- `bootstrap-snapshot-environment.mjs plan` is read-only and emits a deterministic plan from GitHub API readback plus the approved root policy.
- `apply` accepts only a plan digest and human approval record through file descriptors; `readback` emits stable identity separately from observation provenance.
- `prepare-snapshot-run` and `prepare-rc-snapshot-consumer-role` emit cloud-role trust-policy plans bound to one exact run and attempt; they never create roles themselves.
- Every token/key reference is a protected file descriptor or secret-manager reference, never a command argument or environment variable.

- [ ] **Step 1: Write RED tests for the currently absent Environment**

Mock the current `404/ABSENT` snapshot Environment state and require `plan` to propose exactly `stage1-snapshot-export`, repository ID `1253231368`, reviewer ID `275060624`, `main` only, `can_admins_bypass=false`, `prevent_self_review=false` and wait timer `0`. Also require read-only inventory records for `trusted-source-database-gate`, `trusted-release-execution` and `trusted-release-candidate`; this plan may not propose creating or widening those RC environments. Absence is a plan input, not an implicit apply authorization.

- [ ] **Step 2: Implement identity/provenance readback**

Normalize immutable Environment and OIDC policy fields into one identity digest per Environment; keep `observedAt`, raw API response digest and review/deployment records in the observation digest. Comparing two observations uses only identity fields for drift and provenance fields for freshness. Snapshot bootstrap can apply only the approved snapshot Environment; RC environment mismatch emits `RC_ENVIRONMENT_CHANGE_PLAN_REQUIRED`.

- [ ] **Step 3: Generate the exact repository OIDC customization plan**

Require the subject template to include repository identity, `workflow_ref`, `workflow_sha`, `ref`, `environment`, `actor_id`, `run_id`, `run_attempt`, `event_name` and `runner_environment`. The plan must first inventory existing OIDC consumers and fail with `OIDC_CONSUMER_MIGRATION_REQUIRED` instead of overwriting a shared policy.

- [ ] **Step 4: Add apply/readback separation and human-approval checks**

The apply path verifies plan digest, repository identity, immutable reviewer identity, approval expiry/revocation and a fresh pre-apply observation before the first write. After each API mutation it reads back the actual policy and stores a content-addressed proof; partial apply is `INTERRUPTED_UNKNOWN` and must reconcile before retry.

- [ ] **Step 5: Bind per-run role plans to exact OIDC subjects**

For snapshot producer and RC consumers, compute the full subject from the already allocated numeric `run_id`, `run_attempt`, exact workflow SHA/ref, event, environment and runner environment. The RC consumer capability is instantiated for exactly two approved jobs: source-snapshot under `trusted-source-database-gate` and final-snapshot under `trusted-release-execution`; each invocation gets its own short-lived credential while both have the same narrow exact-object/decrypt permission profile. Assert every RAM trust clause contains one exact `StringEquals` subject and no wildcard for run, ref, workflow, environment or actor.

- [ ] **Step 6: Add negative tests**

Reject wrong repository/environment/reviewer, tag/ref, workflow SHA, actor, run attempt, self-hosted versus GitHub-hosted mismatch, admin bypass, stale observation, missing approval, wildcard trust, ambient token, and apply before plan custody.

- [ ] **Step 7: Verify and commit repository-only tooling**

```powershell
node --test scripts/release/bootstrap-snapshot-environment.test.mjs scripts/release/verify-github-oidc-subject.test.mjs scripts/release/prepare-snapshot-run.test.mjs scripts/release/prepare-rc-snapshot-consumer-role.test.mjs
pnpm release:contracts:verify
pnpm prettier --check release/contracts scripts/release package.json
git diff --check
git add release/contracts scripts/release package.json
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

1. `snapshot-admission` runs on `ubuntu-24.04`, verifies the exact approved main SHA, Environment identity, owner facts, adapter build proof, target policy and capacity inputs, then publishes only a non-sensitive attested admission artifact.
2. `snapshot-data` runs after Environment approval on the exact five-label JIT Runner, has no checkout, `uses`, package-manager, Docker or free-form input, and contains one fixed invocation of the root-owned adapter.
3. `snapshot-custody` runs on `ubuntu-24.04`, uses an exact-run read-only custody identity to verify encrypted OSS object/proofs/destruction receipt and emits `snapshot-producer-completion.v1`; it never downloads or decrypts the snapshot.

- [ ] **Step 1: Make existing workflow tests fail on plaintext custody**

Assert the workflow contains no plaintext dump upload, public Actions artifact containing snapshot bytes, 30-day snapshot artifact retention, repository checkout in `snapshot-data`, `pnpm`, `npm`, `node scripts/`, arbitrary `run` input or persistent self-hosted label.

- [ ] **Step 2: Implement the admission job**

Use least-privilege permissions (`contents: read`, `actions: read`, `id-token: write`, no write permission) and the fixed Environment policy verifier. Admission output contains only digests, IDs, allowed labels, immutable workflow identity, exact adapter digest, expiry and protected object references.

- [ ] **Step 3: Implement the single-entry data job**

Set `runs-on` to the exact default labels, capability label and derived unique label; set `environment: stage1-snapshot-export`; disable container/service/default shell customization. The only command is the literal installed adapter path with the admission artifact reference. It receives root handoff through the launcher, not workflow secrets or environment variables.

- [ ] **Step 4: Implement custody verification**

Verify the private OSS object using `HEAD` and range-read ciphertext hash, KMS/OSS attestation, producer proof, sanitization proof, source fingerprint, GitHub job/runner identity, destruction receipt, 30-day expiry and 210-day retention state. Upload only the small non-sensitive completion proof and references to GitHub Actions.

- [ ] **Step 5: Add structural and policy negative tests**

Mutate a workflow fixture to add checkout, a second command, mutable label, plaintext upload, Docker, broader token permission, missing Environment or missing custody job; every mutation must fail with a stable code.

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

The independent producer may supply only its attested completion/object references; build proof and narrow owner/manual attestations may also be external inputs. All source, final, aggregate and generated exit-evidence nodes are created in one `rcWorkflowRunId` and one attempt lineage. The independent exit audit and final custody tail remain Task 30 work and are not created here.

- [ ] **Step 1: Write RED cross-run splice tests**

Reject different RC workflow run/attempt, source evidence imported from another run, final evidence artifact inputs, externally supplied aggregate/exit evidence, mismatched producer completion, changed build/contract/snapshot digest and retry evidence that overwrites an earlier failure.

- [ ] **Step 2: Make aggregation recompute lineage**

Read every selected proof from this run's content-addressed custody, verify subject/digest/operation lineage and recompute the aggregate rather than trusting a summary JSON. A successful producer completion is a prerequisite fact, not a source/final execution proof.

- [ ] **Step 3: Generate exit evidence inside the RC run**

Remove any `exitEvidenceRunId` or complete exit-evidence download. Generate `s1-exit-evidence.v1` only after the aggregate digest exists, binding the current RC run, build proof, repository contract, test manifest, snapshot version, all custody receipts and approved manual/owner attestations.

- [ ] **Step 4: Keep Task 30 tail disabled**

The workflow stops after producing the Task 29R checkpoint evidence and an explicit `TASK_30_AUTHORIZATION_REQUIRED` state. It must not restore the stash, run Task 30 commands, mark S1 complete or automatically dispatch a follow-up workflow.

- [ ] **Step 5: Run DAG tests and commit**

```powershell
node --test scripts/release/aggregate-release-proof.test.mjs scripts/release/generate-s1-exit-evidence.test.mjs scripts/release/release-dag-assemblers.test.mjs scripts/release/approval-workflows.test.mjs
pnpm release:contracts:verify
pnpm prettier --check .github/workflows/release-candidate-gate.yml scripts/release release/contracts
git diff --check
git add .github/workflows/release-candidate-gate.yml scripts/release release/contracts
git commit -m "ci: close the stage1 release evidence dag"
```

---

### Task 17: Publish the operational runbook and pass the repository implementation gate

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

Use exactly: GitHub trust bootstrap → private OSS/KMS/RAM custody → Staging SSH/read-only DB source → WSL/adapter install → synthetic rehearsal → real producer attempt → unique RC run. Each section states `plan evidence → human approval → apply → readback proof → custody` and its stop condition.

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

Deliver the repository gate report, exact merged main SHA, artifact/build-proof digests, controlled datasource migration status and proposed GitHub/Alibaba/Staging plan digests. Obtain a new explicit authorization before Task 18; plan approval or PR merge alone is insufficient.

---

### Task 18: Apply and verify the GitHub trust boundary

**External systems:** GitHub repository settings, `stage1-snapshot-export` Environment, repository OIDC customization and a dedicated snapshot-launcher GitHub App installation.

**Tracked files:** None. All inputs must come from the merged main SHA produced by Task 17.

**Required approval:** One human approval record bound to the GitHub bootstrap plan digest, repository ID, Environment identity, OIDC identity, GitHub App permission plan and expiration. This approval does not authorize a JIT Runner registration or workflow dispatch.

- [ ] **Step 1: Re-read and freeze current GitHub state**

Run the plan-only bootstrap tool with a short-lived administrator token supplied through a protected file descriptor. Confirm the Environment remains absent or exactly matches the expected identity, inventory all existing OIDC consumers, and compare the newly calculated plan digest with the Task 17 proposal.

- [ ] **Step 2: Obtain the bound human approval**

Present the normalized changes, immutable repository/reviewer IDs, single-operator risk, branch/bypass/self-review rules, exact OIDC claims, App permissions and rollback limits. Any plan or observation change invalidates the approval and returns to Step 1.

- [ ] **Step 3: Create and read back the Environment**

Apply exactly `stage1-snapshot-export`: protected `main` deployment branch only, reviewer ID `275060624`, `can_admins_bypass=false`, `prevent_self_review=false`, wait timer `0`. Read back using GitHub API, separately store identity and provenance observations, and fail if the UI/API result is broader.

- [ ] **Step 4: Apply repository OIDC subject customization**

Only proceed if every existing cloud consumer has an approved migration. Apply the exact claim set and verify the returned configuration plus a sample token subject from a non-data admission job. A missing claim, mutable login name or wildcard dependency stops the plan.

- [ ] **Step 5: Create the dedicated launcher App identity**

Configure only repository Administration write, Actions read, Contents read, Deployments read and Metadata read for this repository. Store the App private key in the Windows/root secret broker, never GitHub job secrets, WSL user files or repository settings. Read back installation repository and permissions.

- [ ] **Step 6: Store bootstrap proof before proceeding**

Upload signed plan, approval, apply journal, final identity/observation, API response digests and owner/access metadata to the approved non-snapshot proof store. Verify content digests and access policy before declaring Task 18 complete.

**Stop/rollback:** If partial apply occurs, disable the Environment from dispatch, reconcile exact GitHub state and issue a new plan. Do not guess rollback by deleting settings that may be shared with other OIDC consumers.

---

### Task 19: Provision and prove private Aliyun snapshot custody

**External systems:** Dedicated OSS bucket in `oss-cn-shanghai`, dedicated KMS key, four RAM capability families and their audit/log policies.

**Tracked files:** None. Generate every plan from the merged policy generator and Task 18 OIDC identity proof.

**Required approvals:** Separate human approvals for (a) reversible OSS/KMS/RAM creation and (b) irreversible BucketWorm lock. A single approval cannot cover both.

- [ ] **Step 1: Discover immutable Alibaba account and region identity**

Using a protected operator identity, read the Alibaba account ID, region, existing object-store policies, KMS aliases and OIDC provider state. Compute the fixed bucket name from the account ID and reject collision, an existing non-empty bucket or an alias owned by another system.

- [ ] **Step 2: Generate and approve the reversible creation plan**

Plan a private bucket with public ACL disabled, versioning disabled, TLS-only access, access logging and no website/public endpoint. Plan a dedicated symmetric KMS key/alias and distinct publisher, custody-reader, RC-consumer and retention capability families. The RC-consumer family issues separate exact-subject sessions for source-snapshot and final-snapshot jobs; credentials are never shared between jobs. Policies deny bucket listing, unrelated prefixes, KMS administration and mixed capabilities.

- [ ] **Step 3: Apply reversible resources and verify negative access**

Create the empty bucket/key/roles, configure `x-oss-forbid-overwrite=true` usage and verify publisher write-only, custody-reader ciphertext/proof read-only, RC consumer one-object plus one-context decrypt, and retention operator lifecycle-only behavior. Cross-attempt, overwrite, list, delete, public read and unauthorized decrypt must fail.

- [ ] **Step 4: Exercise envelope encryption with synthetic bytes**

Run `GenerateDataKey(AES_256)`, encrypt a deterministic non-sensitive payload with AES-256-GCM, upload using conditional create, decrypt using the exact-run test consumer, compare digest and terminate both crypto processes. Scan environment, command line, disk, logs and proof for plaintext DEK/payload leakage.

- [ ] **Step 5: Plan and separately approve the irreversible WORM lock**

Read back an empty, private, versioning-disabled bucket and verify the 210-day retention contract. Present the irreversible operation, cost/retention consequences and exact bucket resource ID for a second approval. Do not lock if any property differs.

- [ ] **Step 6: Lock retention and verify custody lifecycle**

Lock BucketWorm for 210 days, verify actual policy state and create a synthetic object lifecycle proof covering 30-day validity, invalidation, 180-day post-expiry retention and eventual retention-operator transition/deletion receipt. Do not claim early deletion is possible.

- [ ] **Step 7: Store cloud bootstrap proof**

Record resource IDs, stable policy digests, redacted readbacks, audit-log destinations, owners, review date, cost/alert configuration and the two approvals. No access key or decrypted data key may enter proof custody.

**Stop/rollback:** Before WORM lock, unused reversible resources may be disabled after exact identity verification. After lock, never attempt destructive rollback; disable principals, preserve the bucket until retention permits disposition and file an operator incident if configuration is wrong.

---

### Task 20: Establish the restricted Staging snapshot source boundary

**External systems:** Staging host SSH configuration, loopback-only PostgreSQL endpoint and database role `stage1_snapshot_reader`.

**Tracked files:** None. Operator applies the exact merged infrastructure assets; this task creates no application migration, business row or RBAC permission.

**Required approval:** Human approval bound to host fingerprint, Compose project/container identity, database name/OID, current network binding, planned loopback binding, SSH/DB role plans, downtime risk and restore point.

- [ ] **Step 1: Read-only host/database discovery**

Use the existing server administrator path only for discovery. Record host key, Docker/Compose versions, exact PostgreSQL container/project/network, database identity, current published ports, role/ownership topology and health. Abort on an unknown host, production identity or existing public database binding.

- [ ] **Step 2: Verify backup and maintenance boundary**

Create and test a database/container configuration recovery point before changing port publication. Because a loopback publish change may recreate the PostgreSQL container, obtain a maintenance window and define the exact health/rollback checks; do not conflate configuration rollback with database restore.

- [ ] **Step 3: Apply the loopback-only endpoint**

Apply the fixed fragment so the database is published only at `127.0.0.1:55432`. Verify using Docker inspect and an external connection-negative test. Restore the previous compatible Compose config if health or identity changes; database restore is not the normal rollback.

- [ ] **Step 4: Create the dedicated SSH forwarding account**

Install a new public key for `stage1_snapshot_tunnel`; do not reuse `D:\139.196.227.195_id_ed25519`. Apply the forced restrictions and `PermitOpen` policy, reload sshd, then prove shell, PTY, agent/X11, remote/dynamic forwarding and every destination except loopback port 55432 fail.

- [ ] **Step 5: Create and validate the PostgreSQL read-only role**

Execute the approved infrastructure SQL using a one-time database administrator session. Verify exact role OID/attributes, connection limit, timeouts, default read-only transaction, grants, ownership, memberships, RLS behavior and effective negative DML/DDL/role probes. Revoke the setup credential before continuing.

- [ ] **Step 6: Prove a real read-only source session**

Through the restricted SSH tunnel, connect as `stage1_snapshot_reader`, open `REPEATABLE READ READ ONLY`, export a snapshot, compute only approved fingerprints/counts and close. Compare source before/after fingerprints to prove no source change.

- [ ] **Step 7: Store infrastructure proof**

Store the host/database target policy, approval, apply/readback journal, negative-test results, post-change health, recovery-point reference and credential revocation receipt in the approved proof store.

**Stop/rollback:** Any write-capable privilege, unexpected PUBLIC grant, RLS bypass, non-loopback exposure or unsupported SSH capability disables the account/role and blocks Task 21. Do not loosen a control to make export succeed.

---

### Task 21: Install the dedicated WSL host and immutable snapshot adapter

**External systems:** Dedicated Ubuntu 24.04 WSL distro, encrypted attempt storage, root policy, adapter bundle and local launcher service.

**Tracked files:** None. Install only the Task 17 merged artifact whose digest appears in the build proof.

**Required approval:** Human approval bound to Windows host identity, Ubuntu rootfs digest, adapter/SBOM digest, host-policy plan, egress destinations, encryption/storage plan and GitHub App secret reference.

- [ ] **Step 1: Audit host suitability before install**

Verify supported Windows/WSL versions, device encryption, pagefile/hibernation/crash-dump policy, available physical and WSL virtual-disk capacity, filesystem permissions and outbound network policy. If raw/sanitized plaintext could be paged or hibernated outside the LUKS attempt volume, stop 方案 A。

- [ ] **Step 2: Import a dedicated Ubuntu 24.04 distro**

Import the pinned rootfs digest under a dedicated path/identity, not an existing developer distro. Apply disabled interop/PATH/automount/swap settings, update WSL, restart the distro and verify effective state from both Windows and Linux.

- [ ] **Step 3: Create non-privileged identities and directories**

Create separate root launcher and unprivileged runner/adapter processes with no sudo, Docker, Windows mount, SSH-agent or secret-broker access. Install tmpfs handoff, LUKS backing, proof spool and audit directories with fixed owners/modes.

- [ ] **Step 4: Install and verify the root-owned adapter bundle**

Fetch by build-proof digest, verify provenance, SBOM, allowlist and bundle hash, then install atomically to `/opt/subscription-saas/snapshot-adapter/v1/`. Files are root-owned and non-writable by runner/adapter users. Verify the installed digest independently.

- [ ] **Step 5: Install root policy, egress and launcher service**

Apply the approved root policy, nftables/Windows firewall rules and hardened systemd unit. Do not place the GitHub App private key in the distro; the Windows/root broker exposes only a short-lived protected handoff. Container exec, Docker socket and arbitrary entrypoint mechanisms must remain absent.

- [ ] **Step 6: Exercise LUKS lifecycle with synthetic content**

Create one attempt volume, prove raw/temp/plaintext paths resolve inside it, force cancellation, destroy the key and verify the mapper cannot reopen. The receipt records key invalidation and unlock failure, not physical erasure.

- [ ] **Step 7: Audit an idle non-routable host**

Confirm no persistent Actions Runner process/service/registration/token exists, no unique route label is registered, no listening database tunnel remains and no secret/material is present outside approved root locations.

- [ ] **Step 8: Store installation proof**

Store approval, host identity, rootfs/adapter/policy digests, effective settings, egress test, filesystem/identity audit and synthetic destruction receipt before Task 22.

**Stop/rollback:** Remove the idle adapter/distro only after exact installation identity checks. A failed JIT or real data attempt is not repaired by reusing contaminated storage; destroy its volume and create a new attempt.

---

### Task 22: Complete a synthetic end-to-end security and failure rehearsal

**Systems:** Installed WSL/adapter, private custody and GitHub trust boundary, but only a synthetic local PostgreSQL 17 database containing generated non-sensitive data.

**Required approval:** CI-policy for synthetic resources plus human authorization to register one synthetic JIT Runner. Staging SSH/DB credentials are not injected.

- [ ] **Step 1: Generate a synthetic producer admission**

Use the exact workflow SHA, Environment and five-label route with a dedicated synthetic `snapshotRunId`. Create exact-run cloud roles and admission proof whose source target policy points only to the synthetic database.

- [ ] **Step 2: Test exclusive routing and single-job destruction**

Approve the Environment, create the JIT configuration immediately before launch, run exactly one job, verify GitHub terminal state and destroy the Runner/volume. Submit malicious queued-job fixtures for wrong repo/ref/workflow/actor/labels and prove the launcher refuses registration before credentials or data access.

- [ ] **Step 3: Exercise source and crypto failure injection**

Test write-capable source credential rejection, DML attempt, source fingerprint drift, invalid sanitization rule, KMS denial, wrong encryption context, truncated ciphertext, GCM tag failure, OSS overwrite and partial upload. No plaintext/public artifact may be published.

- [ ] **Step 4: Exercise host and cancellation failures**

Test adapter tampering, root-policy drift, egress violation, insufficient capacity, signal during export/encryption/upload and GitHub cancellation after OSS commit but before proof publication. Each outcome must be `FAILED` or `INTERRUPTED_UNKNOWN` with reconcile instructions and preserved redacted evidence.

- [ ] **Step 5: Exercise a synthetic private-custody consumer**

On `ubuntu-24.04`, use an exact-run RC test identity to read one encrypted synthetic object, decrypt only in process/FIFO, restore and verify content. Cross-run, expired, wrong object, list and second-read requests must fail according to policy.

- [ ] **Step 6: Verify retention and clean synthetic resources**

Preserve objects subject to locked WORM as synthetic evidence; disable per-run credentials and record lifecycle disposition rather than attempting early deletion. Destroy all local attempt volumes and prove the host returns to idle/non-routable state.

- [ ] **Step 7: Review the rehearsal evidence**

Require an independent code/security review of all failure results and access logs. Any missing negative test, UNKNOWN without reconcile, secret scan finding or broadened cloud/host policy blocks real Staging use.

---

### Task 23: Run one real sanitized snapshot producer attempt

**Systems:** Read-only Staging source, one manually admitted ephemeral JIT Runner and private OSS/KMS custody.

**Required approvals:** A fresh human approval for the exact producer plan and Environment deployment review. Prior bootstrap/rehearsal approvals do not authorize Staging data export.

- [ ] **Step 1: Allocate the immutable producer identity**

Dispatch only the admission job from the exact merged `main` SHA to obtain numeric `snapshotRunId` and `run_attempt`. Freeze workflow/ref/actor/repository/environment observations, route nonce, adapter/build/policy/sanitization digests, source target identity and snapshot expiry.

- [ ] **Step 2: Generate plan and exact-run cloud/route resources**

Create deterministic publisher/custody-reader trust-policy plans for the full OIDC subject, JIT label set and target policy. Perform capacity checks for encrypted output/local LUKS. Store plans and readbacks before approval.

- [ ] **Step 3: Obtain the bound human and Environment approvals**

Present database identity, read-only privilege observation, exact data scope/sanitization contract, object key, KMS context, expected size bounds, route labels, retention and failure handling. Any changed field requires a new attempt rather than editing the approved admission.

- [ ] **Step 4: Start the JIT Runner only after job approval is queued**

The root launcher verifies the queued job through GitHub API, post-approval Environment observation and exact workflow blob, then requests one JIT config. It must not register if another queued job matches the labels or any immutable identity differs.

- [ ] **Step 5: Execute export, sanitization, encryption and conditional publish**

Use the restricted tunnel/role and one read-only repeatable-read exported snapshot. Transform only within the LUKS-isolated pipeline, scan the final sanitized stream, encrypt in the isolated crypto process and upload once with overwrite forbidden. Record source before/after fingerprints and output digests.

- [ ] **Step 6: Destroy local state, then complete producer custody**

After the adapter closes the source session, the root launcher first sends redacted diagnostic/proof records to private proof custody, then stops all attempt processes, unmounts the volume, invalidates the LUKS key, proves unlock failure and confirms the Runner is no longer routable. It publishes the resulting destruction receipt from root-only state. The GitHub-hosted custody job waits for and verifies that receipt together with the encrypted object/attestation, producer/sanitization/source proofs, TTL and WORM state before emitting producer completion. Never publish plaintext to Actions.

- [ ] **Step 7: Reconcile uncertain terminal states**

If cancellation/network loss makes upload/Runner status uncertain, mark the attempt `INTERRUPTED_UNKNOWN`, read OSS object state and GitHub job/Runner terminal state with the same operation ID, then produce a reconciliation proof. Do not rerun export or upload under the same attempt.

- [ ] **Step 8: Approve producer completion or discard the attempt**

Only a fully matched `snapshot-producer-completion.v1` with private readback, proof/log custody and destruction receipt yields `snapshotRunId=success`. Otherwise disable exact-run roles, preserve failure evidence under retention and create a new attempt from Step 1.

---

### Task 24: Execute one immutable RC run through the Task 29R evidence checkpoint

**Systems:** GitHub-hosted `ubuntu-24.04` source/final chains, registry digest-pinned API/Web/Runner bundle, controlled fresh and restored snapshot databases.

**Required approval:** Human approval bound to the successful producer completion, exact merged source SHA, build-proof digest, three platform image digests, repository/test/sanitization contract digests and the RC workflow plan. The approval marks this attempt `qualificationOnly=true` and forbids promotion or later evidence reuse.

- [ ] **Step 1: Freeze the qualification candidate and allocate one RC run**

Verify main CI is green, resolve API/Web/Runner platform image digests from the registry and generate the immutable build admission. Dispatch exactly one qualification RC workflow to allocate `rcWorkflowRunId`; create the exact-run custody/decrypt role only for that run/attempt. This producer/RC pair is the sole RC for its `releaseAttemptId` and is permanently non-promotable.

- [ ] **Step 2: Run independent capacity gates**

On each fresh/snapshot source/final job, collect actual runner provenance and capacity before writes. Reject the run if any chain lacks the fixed reserve. Do not prune, downgrade tests or automatically switch to a larger/self-hosted machine; that requires a separate approved plan.

- [ ] **Step 3: Run source fresh and snapshot evidence chains**

Fresh applies all migrations to a new PostgreSQL 17 database. Snapshot downloads one encrypted object through the exact-run role, decrypts in memory/FIFO and restores to a separate temporary database with controlled owner normalization. Each chain gets its own Manifest, database identity, operation ID, execution proof and custody receipt.

- [ ] **Step 4: Run final fresh and snapshot Compose gates**

Start the digest-pinned final images with no builds or repository mounts. Use Runner migration/verify capability profiles, real API runtime identity, runtime-equivalent database test identity and Playwright Web-to-public-API network capture. Record Prisma/psql/PostgreSQL versions and zero-skip test equations.

- [ ] **Step 5: Aggregate only same-run proof nodes**

Verify every source/final/custody proof has the current `rcWorkflowRunId`, build proof, contract/test/snapshot digests and valid lineage. Generate aggregate and `s1-exit-evidence.v1` within the same run; preserve retry failures rather than overwriting them.

- [ ] **Step 6: Stop before the Task 30 exit audit**

Store and read back the generated `s1-exit-evidence.v1` checkpoint, then output `TASK_30_AUTHORIZATION_REQUIRED`, even if every Task 29R check is green. Do not run the independent exit audit or its final custody tail; the workflow must not apply the Task 30 stash, execute Task 30 or mark S1 complete.

- [ ] **Step 7: Retain evidence and clean ephemeral databases**

First verify all execution proofs are in trusted immutable custody. Then drop only exact CI databases bearing this run's ephemeral marker and revoke the exact-run RC role. Never delete using a prefix/glob or touch Staging/source data.

---

### Task 25: Deliver the Task 29R review package and request the next authorization

**Files:** None unless reviewers require a separately approved documentation correction PR.

- [ ] **Step 1: Assemble the final review package**

Include merged main SHA, build proof, API/Web/Runner digests, repository/migration/test/sanitization contract digests, GitHub/Alibaba/Staging/WSL bootstrap proofs, successful producer completion, both source/final chain proofs, capacity/runner provenance, aggregate, exit evidence, access logs, retention state and cleanup receipts.

- [ ] **Step 2: Reconcile repository and external state**

Prove the repository worktree is clean, Task 30 stash remains unchanged, Environment/cloud/host identities match approved readbacks, no JIT Runner remains registered, no local plaintext/unlocked volume survives and no per-run credential remains active.

- [ ] **Step 3: Report residual risks and exceptions**

List every accepted N/A/manual/external validation, single-operator Environment risk, retained encrypted/synthetic objects, unsuccessful attempt proof and infrastructure UNKNOWN resolution. No missing proof may be summarized as success.

- [ ] **Step 4: Request explicit Task 30 authorization**

Ask the user/reviewer to approve or reject resuming Task 30 from its frozen stash. Until that explicit authorization, do not apply/pop/drop the stash, implement Task 30, declare S1 complete or start S2/S3.

## Specification Coverage Matrix

| Approved addendum requirement                          | Implementation tasks      | Completion evidence                                                      |
| ------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------ |
| Independent producer, then one same-run RC chain       | 2, 3, 9, 14–16, 23–24     | Admission/JIT/producer proofs plus same-run DAG checkpoint               |
| Public-repository exclusive JIT routing                | 2, 3, 8, 9, 14, 18, 21–23 | Environment identity, route observation, exact labels, terminal cleanup  |
| No arbitrary repository code on data host              | 7–9, 14, 21–22            | Adapter allowlist/SBOM, workflow structural audit, negative launch tests |
| Dedicated WSL, LUKS and truthful destruction           | 8, 21–23                  | Host policy, LUKS lifecycle proof, destruction receipt                   |
| Restricted SSH/read-only PostgreSQL source             | 10, 11, 20, 23            | Target policy, privilege negatives, source fingerprints, MVCC proof      |
| Valid PostgreSQL 17 snapshot semantics                 | 0, 10, 11, 22–24          | Controlled migration status and three-session MVCC test                  |
| Private encrypted custody, not public artifact         | 4–6, 14–15, 19, 22–24     | Envelope/custody proofs, private OSS/KMS readback, workflow audit        |
| KEK/DEK lifecycle and isolated crypto                  | 4–6, 19, 22–23            | Synthetic/real crypto proof and leak scan                                |
| Environment identity versus observation                | 2, 3, 13, 18, 23          | Stable identity digest, fresh observation, drift negatives               |
| Exact OIDC and least-privilege identities              | 3, 6, 13, 18–19, 23–24    | Exact subject/readback and cross-run/capability denials                  |
| Capacity and fixed GitHub-hosted identity              | 12, 15, 17, 22, 24        | Capacity plans and runner provenance for every chain                     |
| Snapshot retention and disposition                     | 4, 6, 17, 19, 22–25       | 30-day expiry, locked 210-day WORM, retention receipts                   |
| Failure, cancellation, UNKNOWN and reconcile           | 2–9, 14–17, 22–25         | Failure proofs, reconciliation chain, preserved attempts                 |
| Task 29R allowed only after real gate; Task 30 blocked | 1, 16–17, 24–25           | Exit-evidence state `TASK_30_AUTHORIZATION_REQUIRED` and stash audit     |

## External Approval Checkpoints

| Checkpoint | Bound plan/change                             | Approval does not authorize                              |
| ---------- | --------------------------------------------- | -------------------------------------------------------- |
| A          | Task 18 GitHub Environment/OIDC/App bootstrap | Runner registration, workflow dispatch, cloud/DB changes |
| B1         | Task 19 reversible OSS/KMS/RAM creation       | BucketWorm lock or Staging export                        |
| B2         | Task 19 irreversible 210-day WORM lock        | Snapshot production or RC run                            |
| C          | Task 20 Staging loopback/SSH/read-only role   | Business migration, write role or data repair            |
| D          | Task 21 WSL/adapter installation              | JIT registration or workflow execution                   |
| E          | Task 22 synthetic JIT rehearsal               | Staging credentials/data                                 |
| F          | Task 23 exact real snapshot attempt           | Retry with changed inputs or RC execution                |
| G          | Task 24 exact RC candidate/run                | Task 30, S1 completion, S2/S3                            |
| H          | Task 25 review decision                       | Only a new explicit authorization may resume Task 30     |

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

1. Tasks 0–17 have merged to `main` with required CI green and an immutable build proof.
2. Each Task 18–24 external mutation/execution has its own approved plan, apply journal, readback proof and trusted custody receipt.
3. One real producer attempt has a successful `snapshot-producer-completion.v1`, and one immutable RC run has completed both source/final chains plus same-run aggregate and generated exit-evidence checkpoint custody.
4. The environment is idle: no JIT Runner, unlocked LUKS volume, plaintext snapshot or active per-run credential remains.
5. Task 30 stash is unchanged and Task 25 has stopped at an explicit authorization request.

Completion of this plan proves the execution infrastructure and Task 29R checkpoint only. It does **not** complete S1, authorize Task 30, approve S2/S3, change product behavior or constitute Stage 1 acceptance.

## Primary Implementation References

- [GitHub: Security hardening for self-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
- [GitHub: Ephemeral self-hosted runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- [GitHub: OIDC claims and subject customization](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub: Environment protection rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Alibaba Cloud KMS: Envelope encryption](https://www.alibabacloud.com/help/en/kms/key-management-service/use-cases/use-envelope-encryption)
- [Alibaba Cloud KMS: GenerateDataKey](https://www.alibabacloud.com/help/en/kms/key-management-service/developer-reference/api-kms-2016-01-20-generatedatakey)
- [Alibaba Cloud RAM: OIDC-based SSO](https://www.alibabacloud.com/help/en/ram/overview-of-oidc-based-sso)
- [Alibaba Cloud OSS: Conditional PutObject](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject)
- [Alibaba Cloud OSS: Retention policy](https://www.alibabacloud.com/help/en/oss/user-guide/oss-retention-policies)
- [PostgreSQL 17: Transaction isolation and `DEFERRABLE`](https://www.postgresql.org/docs/17/runtime-config-client.html)
- [Node.js: v22 release archive](https://nodejs.org/en/download/archive/v22)
