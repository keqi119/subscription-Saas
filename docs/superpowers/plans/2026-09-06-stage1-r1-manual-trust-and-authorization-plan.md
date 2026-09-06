# Stage 1 R1 固定信任与人工授权实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development，子 agent 逐任务实施，主 agent 审查；也可在用户明确改变模式后使用 superpowers:executing-plans。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一个可离线反例验证、但不能用测试身份放行真实操作的人工授权内核，供 R2 的两个数据库命令消费。

**Architecture:** 不替换现有 `build-proof.v1`，不改旧 full-RC/approval 验证规则。新增的本地人工入口使用固定 profile、Node Ed25519 和在场父会话；首次真实身份与可信 CI 构建是单独的人工作业门槛，不在单元测试成功后自动建立。

**Tech Stack:** 现有 Node 22 发布运行时、Node `crypto`/`fs`、现有 Ajv 与 canonical JSON/digest kernel、GitHub CLI attestation verifier。无新 npm 依赖、云 KMS 或常驻服务。

**Spec:** [最小受控发布决策 §3](../specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md)、[覆盖路线图 R1/R2](./2026-09-06-stage1-mainline-minimal-release-implementation-plan.md)、[P0/P1 实际执行索引](../../acceptance/2026-09-06-stage1-mainline-execution-index.md)。决策文档仍保留其自身审批状态；本稿不代替对新增人工路径的批准。

## Global Constraints

- 状态：**局部修订待复审，未授权代码施工**。原计划 `11ef95e6`；本轮按用户评审补齐共享 verifier 纳管，不改变 H1/H2 独立批准。当前修订核查 HEAD `dce7ba1a4d3f5848dd5225e535dd43146a095974`；历史代码基线 `4b93f8abf4697d3970205d3d37e78e8a55b4ebd6`。
- P0/P1 本地准入已结束，两个测试目标均退役。不能读取归档凭证、重建旧 record，或访问 ambient `DATABASE_URL`；R1 所有代码测试均不连接数据库。
- Task 6、29R/30、I 系列和冻结 stash `b299ceeed80374d181998f8ef485629beba56b5f` 不动。API/Web、业务模型、迁移、应用 RBAC、工作流、OSS/WORM 均不在文件修改范围内。
- 单 JSON 输入/输出实际 UTF-8 字节数最多 `1048576`，读取、规范化前后均计数；不能只在 Schema 写上限。私钥不得进入 Git、镜像、环境变量、argv、日志、聊天或测试报告。
- 只交付人工路径；所有返回值固定 `promotionEligible:false`。R4/A3 才可能对指定 Staging 签字，不将本路径结果包装为旧 full-RC 或 Task 30 证明。
- 本稿内 Task R1.1–R1.3 是代码实施审批单元；H1/H2 是尚未具备输入的人工停止点。计划批准不等于真实 key、目录、签发、上传或构建操作批准。

## 1. 当前事实与交付界面

| 现有位置                                                      | 已有能力                                                                                       | R1 的精确增量                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `scripts/release/verify-build-proof.mjs`                      | 三镜像/source/catalog/contract 绑定；旧路径接收 `verifiedAttestation` 对象及旧 custody receipt | 实际执行密码学验证；仅提取共享的纯身份校验，不以调用方对象建立信任、不放宽旧 custody |
| `packages/release-foundation/src/execution-state-machine.mjs` | plan 漂移、apply/replay/UNKNOWN 的纯状态机                                                     | 外层本地会话、真实撤销/消费日志与内容读回；不另造第二个迁移状态机                    |
| `packages/release-foundation/src/schema-registry.mjs`         | 自动发现 Schema、实际有限时间检查、结构化错误                                                  | 新人工契约复用；错误断言使用 `code` 和 `details.errors[].keyword`                    |
| `scripts/release/trusted-launch-runner.mjs`、Runner 生产入口  | 旧受信执行路径已存在                                                                           | R1 不声称它们是占位代码；R2 才接入新的人工消费路径                                   |
| `.github/workflows/docker-images.yml`                         | 手工触发三镜像构建；仍有 Actions `retention-days:180` 及实际到期检查                           | 仅登记实际构建阻断，不在 R1 修改工作流或伪造完成证明                                 |

Public Actions 的 artifact/log 保留期不能提供 180 日权威保管。现有工作流该问题必须在实际 H2 前通过**另行批准的窄范围构建保管修正**或已存在、符合要求的真实产物证明解决；本计划不提前宣称 CI 可用，也不让 R2 自行绕过。见 [GitHub 保留规则](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-repository)。本地人工档案与旧 CI custody 是不同事实，不能把本地文件签收伪装为旧不可变存储 receipt。

R1 交付顺序：`R1.1 契约 → R1.2 会话/签发/消费 → R1.3 固定入口及真实验签适配 → H1 精确身份批准/读回 → H2 新 main 可信构建及独立验证`。R2 代码开发只依赖前三项已审查；R2 真实最终镜像执行还必须通过 H1/H2。

## 2. 唯一字段契约

以下新类型只属于人工路径，已有 v1/v2 文件语义保持不变。

| 类型                             | 必填信息与约束                                                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manual-stage1-profile.v1`       | owner immutable ID、公钥 PEM/指纹、有效期、仓库/workflow/main/issuer 固定约束、允许目标、仅 `db.migrate.deploy@1`/`db.schema.verify@1`、固定 key 引用/journal/archive/独立加密 backup/credential root 位置；不含秘密、不引用未来 build proof |
| `manual-launch-authorization.v1` | `profileDigest`、owner、`authorizationId`、`sessionId/sessionNonce`、`operationId/idempotencyKey`、issued/expires、单一 stage/capability、请求 digest；Ed25519 签名覆盖整个 canonical payload，不覆盖签名自身                                |
| `manual-operation-record.v1`     | 固定 kind 判别的 session、revocation、consumption、consumption-handoff、post-state、execution、custody、signoff 记录；每种 kind 的必填字段封闭定义，无通用自由 JSON payload                                                                  |

R1 只启用两个互斥 stage：

1. `target-observe`：`verify`、精确目标意图和用途 `synthetic-fresh` 或 `staging-mainline`；不引用尚未知的 DB OID/Manifest/plan。R2 在连接后生成 observation，不由审批者填“已验证”。
2. `runner-command`：已核验 `buildProofDigest`、baseline manifest digest、目标观察 digest、实际 DB 标识/OID、预期角色/TLS、命令版本和 phase。`migrate/apply` 另需相同会话 dry-run record digest、确定性 plan digest；`verify` 不假装存在 apply plan；`replay/reconcile` 引用前序执行记录及原幂等键。

`source-read/export`、`restore/sanitize/scan`、`candidate-use` 数据消费尚归 R3：本实现拒绝这些 stage，不能靠自由 `stage` 字符串扩权。`qualification`/`release-candidate` 属旧证明体系，不能作为本地授权 purpose 别名。

数据库跨角色比较使用不含角色的目标身份 `{endpointPolicyId, databaseName, databaseOid, clusterFingerprint}`；每次执行仍单独绑定 `{role, tls, schemaObservationDigest}`。不能修改现有 connector 中包含 role 的 `databaseIdentityFingerprint` 定义，R2 必须保留两层区别。

## Task R1.1：封闭契约和无副作用签名 kernel

**Files:**

- Create: `release/contracts/schemas/manual-stage1-profile.v1.schema.json`
- Create: `release/contracts/schemas/manual-launch-authorization.v1.schema.json`
- Create: `release/contracts/schemas/manual-operation-record.v1.schema.json`
- Create: `packages/release-foundation/src/manual-stage1-contracts.mjs`
- Create/Test: `packages/release-foundation/test/manual-stage1-contracts.test.mjs`
- Modify: `packages/release-foundation/src/index.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: `canonicalJson(value)`、`sha256Canonical(value)`、`validateContract(schemaId,value)`、Node `createPrivateKey/createPublicKey/sign/verify`。
- Produces: `encodeManualJson(value):Buffer`；`signManualAuthorization({payload,privateKey}):authorization`；`verifyManualAuthorization({authorization,profile,request,session,revocation,now}):frozen parentDecision`；`assertManualDecision(decision):void`。parentDecision 以模块内 WeakSet 标记，JSON 或 `{verified:true}` 无法还原。
- Produces: `verifyManualHandoff({authorization,receipt,profile,request,childObservation,now}):frozen childDecision`；`assertManualHandoffDecision(decision):void`。childDecision 使用另一 WeakSet，只在真实 Ed25519 消费交接签名和本进程挑战全部核对后产生，不能和 parentDecision 混用。
- 本模块只验字节/签名/字段，不宣称会话、撤销来自真实 IO；真实可信读取在 R1.2，R2 不能直接将请求体作为这些参数。

- [ ] **1. 写 RED：用测试进程临时生成 Ed25519 KeyObject，不落私钥文件。** 使用相同测试局部的合法 profile/payload factory；工厂逐字段填 §2 必需值，不导出为生产 profile。

```js
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { encodeManualJson, assertManualDecision } from "../src/manual-stage1-contracts.mjs";

test("rejects caller-made verification and counts UTF-8 bytes", () => {
  assert.throws(() => assertManualDecision({ verified: true }), {
    code: "MANUAL_DECISION_UNTRUSTED"
  });
  assert.throws(() => encodeManualJson({ value: "汉".repeat(400000) }), {
    code: "MANUAL_JSON_LIMIT"
  });
  const keys = generateKeyPairSync("ed25519");
  assert.equal(keys.privateKey.asymmetricKeyType, "ed25519");
});
```

- [ ] **2. 运行入口 RED。** `node --test packages/release-foundation/test/manual-stage1-contracts.test.mjs`，预期缺模块；记录原件后建立模块/三个 Schema，先只通过上述两个拒绝断言。
- [ ] **3. 增加逐项签名反例并运行 RED。** 改签名字节、profile key、purpose、request digest、过期/未来授权、会话 nonce、撤销 ID、stage 额外字段、migrate 缺 plan、verify 带写 capability。每个反例使用真正签名基线后仅变一个字段；Schema 错误与 `MANUAL_SIGNATURE_INVALID`、`MANUAL_BINDING_MISMATCH`、`MANUAL_AUTHORIZATION_REVOKED` 分开断言。
- [ ] **4. 实现最小验签顺序。** 原始字节限额 → Schema → 固定 profile 有效期/指纹 → 真正验签 → 请求/会话/撤销/命令绑定 → 对应 WeakSet decision。授权签发与验证使用完全相同字节：

```js
const bytes = Buffer.concat([
  Buffer.from("subscription-saas/manual-launch/v1\n", "utf8"),
  Buffer.from(canonicalJson(payload), "utf8")
]);
const signature = sign(null, bytes, privateKey);
const valid = verify(null, bytes, publicKey, signature);
```

交接 receipt 的域独立为 `subscription-saas/manual-consumption/v1\n`，不能跨域重放。禁止从 payload 读取公钥、profile 路径或信任策略。对应签名仅证明 parent 消费承诺，不把子进程自报 session/revocation 当本机台账读回。

- [ ] **5. GREEN 与归属检查。** 重跑该测试、`pnpm release:contracts:verify`；新 Schema 与模块路径显式纳入 contract manifest。六个函数均有精确导出，不导出可伪造两种 decision 的构造器；补未签消费 receipt、错授权/挑战、父/子 decision 互换、域错、超期/重复交接的负向断言。
- [ ] **6. 独立审查后提交。** 精确七文件运行 Prettier、`git diff --check`；只暂存 Files 中七文件，`git diff --cached --check` 及 staged 清单复核后提交 `feat(release): define closed manual authorization contracts`。无 profile 实例、真实 key、DB 或工作流修改。

## Task R1.2：单父会话、撤销消费与私密记录

**Files:**

- Create: `packages/release-foundation/src/manual-stage1-session.mjs`
- Create/Test: `packages/release-foundation/test/manual-stage1-session.test.mjs`
- Modify: `packages/release-foundation/src/index.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: R1.1 函数及 `createExecutionState/transitionExecution/assertApplyAllowed`。既有状态机只处理迁移执行状态；只读 verify/observe 不捏造 dry-run。
- Produces: `openManualSession({profile,ownerObservation,io,now,signingKey}):session`；`session.sign(request)`；`session.consume({authorization,request})`；`session.record(kind,value)`；`session.close()`。signingKey 只接受内存中的 Ed25519 KeyObject；生产加载唯一归 R1.3，测试使用进程内临时 key。`io` 是同模块生产文件适配器或本文件测试私有工厂，正式 CLI 无 IO/module 路径选择项。
- session 产生 UUID/随机 nonce、持有精确目标排他锁和当前授权队列；主进程结束后不再签发/消费。`consume` 返回封闭联合：`target-observe` 仅为 `{stage,parentDecision,consumptionReadbackDigest}`，供父方只读目标探测，不引用尚不存在的子进程；`runner-command` 为 `{stage,parentDecision,handoffReceipt}`，先持久化消费原件并独立读回，再签发并 create-only 保管交接 receipt，最后才交出使用权。禁止跨 stage 字段，只有后一分支可交接子进程凭证。

交接 receipt 是 `manual-operation-record.v1` 的封闭 `consumption-handoff` kind，必填 `authorizationDigest/requestDigest/profileDigest/sessionId/sessionNonce/operationId/idempotencyKey/containerId/runnerImageDigest/childChallenge/consumptionRecordDigest/consumptionReadbackDigest/revocationSequence/issuedAt/expiresAt/signature`。最长期限取原授权到期和签发后 30 秒的较早者。顺序固定为消费原件 → 独立读回记录 → 签名 receipt → receipt 保管读回 → 凭证交接；receipt 不引用自己的读回或未来执行记录，后者由执行记录引用。原始消费成功但 receipt/读回失败只能 UNKNOWN，不得重新签发 receipt 或换 ID 重试 apply。父方交凭证前最后一次锁内撤销检查，子方只信该已签消费承诺及同一管道，不声称自己在线读过 Windows 台账；凭证交出后撤销不能保证已执行事务回滚。

- [ ] **1. 为未实现的父会话写 RED。** `node --test packages/release-foundation/test/manual-stage1-session.test.mjs`。用 `mkdtemp` 的测试根及测试 owner observation，覆盖第二父进程抢同一目标、请求指定 archiveRoot、路径逃逸/链接、已关闭会话消费；预期缺模块，不连接数据库。
- [ ] **2. 建立最小父会话并 GREEN。** 排他创建锁文件，真实 owner-only 权限观察、文件句柄/nonce 与内存会话绑定；固定 profile 路径逐级 realpath/reparse 核对，原子 CreateNew 记录。不要把 `chmod` 在 Windows 上当作 ACL 验证：Windows 用固定 `icacls` 参数数组读回，POSIX 用 uid/mode；读回未知即 `MANUAL_STORAGE_UNVERIFIED`。
- [ ] **3. 写撤销/一次性 RED。** 先签后撤销、台账缺失/损坏/序号回退、并发消费同一 ID、write 成功/readback 失败、父进程死亡后旧授权、新 operation 尝试绕过原 UNKNOWN；消费后/凭证交接前撤销、未消费授权生成 handoff、错挑战重放同一 receipt 也拒绝。断言任何失败均未交凭证；失败历史与原消费文件不被覆盖。
- [ ] **4. 实现后 GREEN。** 消费前在父会话锁内重新读取 owner-only 日志，核对 hash 链/单调序号和已观察 checkpoint，禁止使用请求内 revocation。消费/记录文件以规范化 digest 内容寻址；记录失败不能称为“未执行”，使用 `INTERRUPTED_UNKNOWN`。原 execution-state-machine 保持不变，UNKNOWN 仅允许相同幂等键的只读 reconcile，不能创建新 apply。
- [ ] **5. 写保管 RED → GREEN。** session/post-state/execution/signoff 按前序 digest 单向连接，签字晚于执行记录；输入/批准/失败/撤销引用均纳入档案。独立读回不使用写入响应；恢复测试使用第二测试根，修改一字节即拒绝。真实档案保留期默认 180 日需 owner 签收、权限及备份读回，本地文件不标为 WORM；不凭 `now+180d` 宣称已证明未来保管。
- [ ] **6. 格式/契约/独立审查后提交。** 两个 R1 测试全部执行，`pnpm release:contracts:verify`。精确四文件 Prettier、unstaged/staged diff 检查后提交 `feat(release): bind manual approval to live local session`。

测试 IO 只允许单测直接调用，不能由生产参数/环境加载。跨进程生产消费只能由 R2 固定父会话交接；R1.2 不创建通用 broker、HTTP 服务或后台签名进程。对控制宿主或签名 owner 的攻击不作不成立的抵抗承诺。

## Task R1.3：固定 profile loader 与真实构建验签适配

**Files:**

- Create: `scripts/release/manual-stage1-trust.mjs`
- Create/Test: `scripts/release/manual-stage1-trust.test.mjs`
- Modify: `scripts/release/verify-build-proof.mjs`
- Modify/Test: `scripts/release/build-proof.test.mjs`
- Modify: `packages/release-foundation/src/catalogs.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: R1.1–2；现有 `verifyBuildProof()` 的身份绑定逻辑。
- Produces: `loadFixedManualProfile({repoRoot}):profile`（固定相对位置，未建立时报 `MANUAL_PROFILE_NOT_PROVISIONED`）；`verifyManualBuild({proofBytes,materialBytes,repoRoot}):trustedBuildDecision`；`openTrustedManualSession({repoRoot,proofBytes,materialBytes}):session`。最后一个函数先真实验真，再使用本文件非导出的 `loadFixedSigningKey(profile)` 和真实 owner/文件 IO 构造 R1.2 session；生产请求不能传 signingKey/IO/ownerObservation。
- 从旧 verifier 提取 `assertBuildIdentity({proof,buildMaterialObservation}):void`，只包含原 Schema/三镜像/source/catalog/material 绑定。旧 `verifyBuildProof()` 继续调用它及原 attestation/custody 校验，旧 fixture 路径仍不可提升；新接口名明确不含 trusted/verified，不返回通行证。
- 同一任务把新入口 `scripts/release/manual-stage1-trust.mjs` **及其实际共享依赖 `scripts/release/verify-build-proof.mjs`** 同时纳入 `RELEASE_GATE_ENTRY_POINTS` 与 `repository-contract-files.v1.json`。旧 verifier 当前未纳管；不能只登记新入口，不能用 dependency 的自报摘要代替实际源码重算。此变化会改变 repository contract digest，必须进入 H2 新可信构建。

- [ ] **1. 写固定输入/CLI 边界 RED。** 实际子进程执行 trust 文件；不存在 profile、argv `--trust-root/--profile-file/--archive-root`、环境 override、额外 JSON 属性均拒绝。合法测试用隔离 Git 工作区和临时 fixture profile，不向真实仓库固定路径写测试 key。
- [ ] **2. 实现 loader 与纯身份提取，GREEN。** 生产只接受固定入口当前代码根；从 proof 指定且 attested 的 source tree 读 profile blob、catalog/contract 并与当前执行入口逐项对照。入口自身尚未可信前仅允许读取/验签，不能读私钥、DB credential 或执行写入。不是仅比较 profile 自报的 digest。
- [ ] **2a. 固定私钥读取 RED → GREEN。** 错 key 类型/指纹、替换文件、链接/重解析点、越界 keyRef、非 owner-only、未通过 build 验真即调用均拒绝，断言签名次数为 0。`loadFixedSigningKey` 仅解析 profile 固定 keyRef；逐级 realpath/ACL → 打开只读文件句柄 → 对句柄/路径身份复核 → 内存 `createPrivateKey` → Ed25519 类型/导出公钥指纹匹配。不得从 argv/env/stdin 收取替代 key，不在错误中输出字节；会话关闭后释放 KeyObject/清零原始 Buffer，说明托管内存清除为 best effort，不伪称物理擦除。
- [ ] **3. 写实际 verifier argv/结果反例 RED。** `gh` exit 非零、证书 issuer/workflow/source ref/source digest 不符、self-hosted、材料/subject 字节 hash 不符、public artifact 无 custody、进程超时/输出超限、仅返回 `{verified:true}` 全部拒绝。测试使用固定进程 adapter 检查 argv 和解析器，明确这部分是适配器单测而非真实 attestation 验证成功。
- [ ] **3a. 共享依赖摘要 RED → GREEN。** 在 `manual-stage1-trust.test.mjs` 的隔离真实 Git/contract fixture 中，先冻结 proof/material/profile，随后**只修改 `scripts/release/verify-build-proof.mjs` 字节**，保持新入口、profile 和请求不变。重新执行真实 `computeRepositoryContract`/加载绑定分支，断言摘要变化且 `BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH`，private-key-read、sign、credential-read 均为 0。不要 mock 一个“dependency changed”布尔值。新旧两个入口同一 manifest 纳管后，恢复原件的正向例和既有 `build-proof.test.mjs` 必须仍通过。
- [ ] **4. 实现固定进程调用，GREEN。** 使用 `spawn` 参数数组，无 Shell；对准确 build proof 原始字节执行下列固定验证，SHA 从 proof 解析后还必须与验证结果及材料相等：

```text
gh attestation verify <受限非秘密 proof 文件>
  --repo keqi119/subscription-Saas
  --signer-workflow keqi119/subscription-Saas/.github/workflows/docker-images.yml
  --source-ref refs/heads/main
  --source-digest <proof.identity.sourceSha>
  --cert-oidc-issuer https://token.actions.githubusercontent.com
  --deny-self-hosted-runners --format json
```

上面是参数映射说明，不是允许用户传入尖括号参数或任意文件路径的命令行。正式函数由固定受控输入索引解析只读文件，实际计数 1 MiB。校验 `verificationResult` 的已验证证书/subject，不能把可由 workflow 填写的 predicate 当成证书身份；固定 repo/workflow 的 run 终态还须真实 GitHub 只读核验。具体 CLI 选项见 [官方 gh verifier](https://cli.github.com/manual/gh_attestation_verify)。真实版本/输出格式必须在 H2 留证；不兼容直接停止，不采用宽松字段猜测。

- [ ] **5. 证明旧边界未放宽。** `node --test scripts/release/build-proof.test.mjs scripts/release/manual-stage1-trust.test.mjs`；旧 issuer/custody/full-RC 负向测试仍拒绝。人工路径使用本地 manual record，不能为了复用旧 verifier 伪造 `custody-receipt.v1`。成功结果通过内部品牌返回，仍固定不可直接提升。
- [ ] **6. 纳管并提交。** 新 trust 入口和共享 `verify-build-proof.mjs` 两者均进入 `RELEASE_GATE_ENTRY_POINTS`、contract manifest；`pnpm release:contracts:verify`；精确六文件 Prettier、unstaged/staged 检查、独立审查后提交 `feat(release): verify attested build for fixed manual profile`。保留旧 verifier 回归；本任务没有扩大文件数量或建立第二个 build verifier。

## H1：首次实际身份、路径与备份——人工停止点

这不是自动执行任务。R1.1–3 通过后只提交一份**非秘密精确摘要**请求用户批准：owner ID、加密主存储/私钥引用/固定 journal 与 archive/独立加密 backup/credential root 的绝对目标、权限观察、生成与恢复校验步骤、凭证丢失/撤销处置。credential root 此时不包含数据库凭证；R2 H3 单独批准四种精确身份和其内部引用，不改变 profile 根。当前这些输入尚未提供，不猜目录、owner key 或公钥指纹。

- [ ] 用户分别批准真实 key 创建和精确私密保管位置后，才可形成该次一次性操作单；本计划不自动生成 key、执行 `icacls` 写权限、安装磁盘加密或上传。
- [ ] 真实 owner 环境生成 Ed25519、非秘密指纹、初始台账，恢复到独立加密位置后验证同一公钥及测试签名；只输出非秘密 readback。任何失败保留停止状态，不伪造 profile。
- [ ] H1 仅允许届时新建 `release/contracts/manual-stage1-profile.v1.json`、更新 `repository-contract-files.v1.json`，独立提交审查；代码测试 fixture 绝不复制成生产 profile。

## H2：可信构建与消费验真——真实执行前的停止点

- [ ] H1 非秘密 profile 经审查合并后冻结准确 main SHA，由既有可信 CI 生成三镜像和证明。CI Actions 保管问题未闭环、构建失败、真实 attestation/材料/受保护来源不足时标记 `TRUSTED_BUILD_UNAVAILABLE`；不得运行本地替代候选或修改旧工作流来“临时放行”。
- [ ] 实际运行 R1.3 验证器，保管实际 gh 版本、可信证书/subject/材料、准确输出计数/退出状态和私密独立读回。只读验证失败不得进入凭证读取。
- [ ] 独立 reviewer 同时确认 H1 owner/ACL/恢复读回、H2 CI 原件和固定代码/profile。R1 内核测试通过不代表 H1/H2 通过；只有这两项也通过，R2 才可申请真实最终镜像竖切操作。

## 完成与交接

代码审查报告分别列：R1.1/2/3 测试计数、实际 Node 版本、contract digest 变更、旧路径回归、H1/H2 状态；没有真实验证的项目保持 `NOT_RUN/INPUT_UNAVAILABLE`。不引用 P1 的历史 4074/104 测试数作为本任务通过数。

R2 只由 `openTrustedManualSession` 建立父方，保留 parentDecision 作为交凭证条件；子方消费已签 handoff 并生成不同的 childDecision。子方不加载 host key/journal/backup，不把 Windows 路径当镜像内文件。B1/B3/B5 不依赖真实 key/CI 完成，可独立进行批准后的业务测试。R3 的数据 stage、隔离副本、主机安全及 R4/A3 外部批准没有在 R1 暗中实现。
