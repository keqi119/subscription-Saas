# Stage 1 R1 固定信任与人工授权实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development，子 agent 逐任务实施，主 agent 审查；也可在用户明确改变模式后使用 superpowers:executing-plans。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一个可离线反例验证、但不能用测试身份放行真实操作的人工授权内核，供 R2 的两个数据库命令消费。

**Architecture:** 不替换现有 `build-proof.v1`，不改旧 full-RC/approval 验证规则。新增的本地人工入口使用固定 profile、Node Ed25519 和在场父会话；首次真实身份与可信 CI 构建是单独的人工作业门槛，不在单元测试成功后自动建立。

**Tech Stack:** 现有 Node 22 发布运行时、Node `crypto`/`fs`、现有 Ajv 与 canonical JSON/digest kernel、GitHub CLI attestation verifier。无新 npm 依赖、云 KMS 或常驻服务。

**Spec:** [最小受控发布决策 §3](../specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md)、[覆盖路线图 R1/R2](./2026-09-06-stage1-mainline-minimal-release-implementation-plan.md)、[P0/P1 实际执行索引](../../acceptance/2026-09-06-stage1-mainline-execution-index.md)。决策文档仍保留其自身审批状态；本稿不代替对新增人工路径的批准。

## Global Constraints

- 状态：**2026-09-07 窄范围 DOC-ONLY 契约修订待复审；R1.1 保持 `PAUSED_BEFORE_RED / SPECIFICATION_INPUT_REQUIRED`**。R1 原代码计划已批准基线为 `f969b655`，不因历史待批抬头撤销；本次核查 HEAD 为 `fb15ea3adbb6b2c823b3b433350818f33ea1c1f4`。本修订只补齐八种记录、既有 verifier 输入及单次消费接缝，不代表实现或新的代码开工批准；复审通过后由主控重新派发 R1.1。
- P0/P1 本地准入已结束，两个测试目标均退役。不能读取归档凭证、重建旧 record，或访问 ambient `DATABASE_URL`；R1 所有代码测试均不连接数据库。
- Task 6、29R/30、I 系列和冻结 stash `b299ceeed80374d181998f8ef485629beba56b5f` 不动。API/Web、业务模型、迁移、应用 RBAC、工作流、OSS/WORM 均不在文件修改范围内。
- 单 JSON 输入/输出实际 UTF-8 字节数最多 `1048576`，读取、规范化前后均计数；不能只在 Schema 写上限。私钥不得进入 Git、镜像、环境变量、argv、日志、聊天或测试报告。
- 只交付人工路径；decision、operation record 和人工业务结果固定 `promotionEligible:false`（不向 Buffer/KeyObject/void 附加字段）。R4/A3 才可能对指定 Staging 签字，不将本路径结果包装为旧 full-RC 或 Task 30 证明。
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

### 2.1 封闭表示与摘要字节

下表是三个 R1 Schema 和共享投影的唯一字段词典，不新增导出函数、Schema 文件或生产 factory。`{a:T,b:U}` 列出的键均必填、递归 `additionalProperties:false`；仅显式写 `?` 的条件键可以缺省，`T|null` 必须有键且允许 JSON null。禁止 undefined、任意 metadata/payload、自由附加属性；失败时不得用空字符串、零 UUID、虚构 digest 补事实。

| 记号                                   | 唯一表示/运行时约束                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `D` / `UUID` / `N`                     | `^sha256:[0-9a-f]{64}$`；小写 RFC UUID；密码学随机 32 bytes 的 64 位小写 hex。摘要不是 UUID，nonce/challenge 不是调用者自选 ID                                                                                                                                                                             |
| `T` / `S` / `E`                        | `T` 为 UTC `YYYY-MM-DDTHH:mm:ss.sssZ`，必须实际解析为有限时间且 round-trip 完全相等；`S` 为 1–256 字符非秘密非空字符串；`E` 为 `^[A-Z][A-Z0-9_]{0,127}$` 的非秘密错误码。Schema 的 `format` 不代替运行时有限时间检查                                                                                       |
| `Path` / `Ref`                         | 无令牌的规范绝对路径；`Ref` 为固定根内非空相对路径，禁止绝对路径、空段、`.`、`..`。只描述位置，真实 realpath/ACL/句柄检查归 R1.2/3；不能由请求覆盖                                                                                                                                                         |
| `TargetIntent`                         | `{endpointPolicyId:S,databaseName:S}`；DB OID 未知前，父锁以固定 profile 解析并规范化的 `endpoint + databaseName` 定位同一目标，不把 profileDigest/role/授权摘要放入锁键。已批准的端点别名必须映射到同一锁键，不能证明唯一时拒绝；profile/root/别名变更仍需 H1 独立审批，不靠换 profile 绕过原锁或 UNKNOWN |
| `PhysicalIdentity` / `RoleObservation` | `{endpointPolicyId:S,databaseName:S,databaseOid:string,clusterFingerprint:D}`，OID 为十进制正整数文本；`{role:S,tls:true,schemaObservationDigest:D}`。tls 是实际连接观察的布尔值，不是 profile 的 TLS 策略字符串；后者是本次角色/catalog 观察，不是 Prisma script/diff digest                              |
| `ChildObservation`                     | `{containerId:string,runnerImageDigest:D,childChallenge:N}`，containerId 为实际完整 64 位小写 hex ID。父方由固定 Docker inspect/已建立管道取得；子方由本次固定启动上下文和自己生成的 challenge 取得，不从授权抄回作为 observation                                                                          |
| `SessionBinding` / `OperationBinding`  | 分别为 `{sessionId:UUID,sessionNonce:N}` / `{operationId:UUID,idempotencyKey:S}`；下文 `&` 仅展开这些精确键，不引入任意属性                                                                                                                                                                                |

所有 digest 均为 `sha256Canonical(完整对象)`，即现有 canonical JSON 的 UTF-8 bytes SHA-256，以 `sha256:` 加小写 hex 表示；输入原始 bytes 和 canonical bytes 各自执行 1 MiB 上限。对象内**不保存自身 digest**。`profileDigest` 覆盖完整 profile；`requestDigest` 覆盖完整 R2 请求（含共享投影及全部 R2 命令输入，不含自摘要键）；`authorizationDigest` 覆盖整个已签 `{payload,signature}`；record digest 覆盖完整 record，handoff 也包括 signature。对原始工具 stdout 等非 JSON，R2 保留原始 bytes hash，不拿它冒充 canonical record digest。

授权外壳唯一为 `{payload:AuthorizationPayload,signature:string}`；signature 为 64 bytes Ed25519 签名的 RFC 4648 标准 base64（含 `==` padding，解码后重编码必须相同），不接收 base64url、hex、PEM 签名。授权签名 bytes 是 `UTF8("subscription-saas/manual-launch/v1\n") || UTF8(canonicalJson(payload))`。handoff 签名 bytes 是 `UTF8("subscription-saas/manual-consumption/v1\n") || UTF8(canonicalJson(receipt 去掉 signature 键))`；仅此签名字段被排除，两个域不得互换。profile 公钥为 Ed25519 SPKI PEM；fingerprint 为 `sha256:` 加 `createPublicKey(publicKeyPem).export({type:"spki",format:"der"})` 原始 DER bytes 的 SHA-256，小写 hex。签发前私钥导出公钥以同一算法匹配，不从授权取公钥。

### 2.2 profile、授权与 R2 请求的共享投影

`manual-stage1-profile.v1` 精确字段如下；这是非秘密配置形状，不提供任何真实实例值。H1 未批准仍不得建立生产文件。

| 字段                                                                              | 类型及条件                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion,profileId,ownerId,publicKeyPem,keyFingerprint,validFrom,expiresAt` | 分别为字面量 `manual-stage1-profile.v1`、`UUID`、`S`、SPKI PEM、`D`、`T`、`T`；`validFrom < expiresAt`                                                                                                                                                                 |
| `buildTrust`                                                                      | `{repository:"keqi119/subscription-Saas",workflow:"keqi119/subscription-Saas/.github/workflows/docker-images.yml",sourceRef:"refs/heads/main",oidcIssuer:"https://token.actions.githubusercontent.com",runnerClass:"github-hosted"}`；不含未来 proof/source SHA        |
| `allowedCommands`                                                                 | 恰为 `[{commandId:"db.migrate.deploy",commandVersion:"1",capability:"migrate"},{commandId:"db.schema.verify",commandVersion:"1",capability:"verify"}]`，不重复、不扩展                                                                                                 |
| `allowedTargets`                                                                  | 非空数组，元素 `{endpointPolicyId:S,endpoint:S,databaseName:S,purposes:Purpose[],roles:{observer:S,migrate:S,verify:S},tls:"required"}`；endpointPolicyId 唯一，purposes 非空且不重复；endpoint 为固定无凭证端点。精确集群/H3 分配原件仍由 R2 读回，不以本字段自报代替 |
| `storage`                                                                         | `{keyRoot:Path,keyRef:Ref,journalRoot:Path,archiveRoot:Path,backupRoot:Path,credentialRoot:Path,retentionDays:180}`；backupRoot 独立于执行/主档案目录，私钥引用只能在 keyRoot 内。加密/权限/恢复是否真实成立由 H1 和 R1.2/3 检查，不增加成功布尔值                     |

`Purpose = "synthetic-fresh" | "staging-mainline"`。`ManualBinding` 为下列共用键与**恰一个** stage 行的并集：共用键 `profileDigest:D,ownerId:S,sessionId:UUID,sessionNonce:N,operationId:UUID,idempotencyKey:S,purpose:Purpose,targetIntent:TargetIntent`。

| stage                | 额外必填键及互斥条件                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `target-observe`     | `stage:"target-observe",capability:"verify"`。禁止 command/version/phase、buildProof/baseline/observation/DB OID/plan/前序 execution/container/challenge 字段；只能先消费后读 observer 凭证并连接                                                                                                                                                                                                                        |
| `runner-command`     | `stage:"runner-command",commandId,commandVersion:"1",capability,phase,buildProofDigest:D,baselineManifestDigest:D,targetObservationDigest:D,physicalIdentity:PhysicalIdentity,roleObservation:RoleObservation,containerId,runnerImageDigest,childChallenge`；末三项类型同 ChildObservation，必须已实际产生。physicalIdentity 的 endpointPolicyId/databaseName 等于 targetIntent                                          |
| runner 的 phase 条件 | `db.migrate.deploy` 恰配 `migrate` 与 `dry-run\|apply\|replay\|reconcile`；`db.schema.verify` 恰配 `verify` 与 `verify`。仅 apply 另必填 `dryRunRecordDigest:D,approvedPlanDigest:D`；仅 replay/reconcile 另必填 `predecessorExecutionRecordDigest:D,originalIdempotencyKey:S` 且等于 idempotencyKey。verify 如核验迁移后状态，另必填 `predecessorExecutionRecordDigest:D`；首次只读核验无该字段。其他分支禁止这些条件键 |

`AuthorizationPayload = {schemaVersion:"manual-launch-authorization.v1",authorizationId:UUID,issuedAt:T,expiresAt:T,requestDigest:D} & ManualBinding`，不另放第二份自由 payload。授权窗口必须满足 `profile.validFrom <= issuedAt <= now < expiresAt <= profile.expiresAt`，且 `expiresAt <= issuedAt + 300000ms`；两个 verifier 都核对此五分钟上界，不能只约束 session.sign 而接受更长的已签授权。所有身份、stage、用途、命令和 phase 既属于签名覆盖，也属于实际 request 的摘要覆盖。

R1 六函数中的 `request` 输入精确为 `{canonicalBytes:Buffer,binding:ManualBinding}`：bytes 是 R2 完整请求的 canonical JSON，R1 重解析、重新规范化并要求 bytes 相等；逐一从请求**同名顶层键**抽取共用及该 stage 的全部键，与封闭 binding 比较，禁止另一 stage 的键，重算完整 requestDigest。R2 独占 `manual-runner-request.v1` 完整 Schema、命令输入、manifest、observer 和构造映射；R1.1 不调用尚未存在的 R2 Schema，不新建第二份 request Schema/factory。R1-only 单测中通过投影验签**不代表**完整请求可执行；生产父方在签发/交凭证前、子方在构造 connector 前都必须经 R2 完整 Schema 和 handler 映射检查，额外 command/stage 或未验证的命令输入不能靠纯 decision 放行。

R2 完整请求中的稳定领域 plan input 与本次授权/实际 child envelope 分层：不得把新 authorizationId/challenge/container 或记录 attempt 混入既有领域 plan 摘要，亦不得伪造/复用 attemptId 绕过状态机。原迁移状态机继续要求同 operationId/idempotencyKey 和唯一 attemptId；R2 必须核对现有 handler 的完整 input 摘要映射，不能在 R1 新建 plan 构造器或改 handler。`schemaObservationDigest` 只绑定实时 catalog，不能填充 `verifySchema` 所需的 expected Prisma schema digest；后者的已有构建/命令输入来源归 R2，缺失即拒绝，不倒填 baseline。

### 2.3 八种 operation record 的封闭表

每行都包含公共键 `schemaVersion:"manual-operation-record.v1",kind:<该行字面量>,profileDigest:D,recordedAt:T,promotionEligible:false`；表中附加键全部必填，只有明确条件键例外。每一记录在所列生产时点 create-only，digest 覆盖公共键及该行**全部实际键**；任何前序引用必须已经存在且独立读回，不能引用自己或未来 record。这里独立读回指重开读取并重算原始/canonical bytes，不要求为每个 custody 再造 custody。`session.record(kind,value)` 的 value 即该完整 record，kind 必须相等，固定 IO 层核对身份/时间/前序而非信任 caller 声明。profile/session/request 尚未可信产生的入口 preflight 错误只输出固定受限错误及实际进程日志，不强造 UUID/digest 或计作 manual execution；完整 record 仅在其全部非空身份前提已经建立后可写。

| kind                  | 附加字段、合法分支和生产时点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session`             | `SessionBinding & {ownerId:S,targetIntent:TargetIntent,status:"OPEN"\|"CLOSED"\|"INTERRUPTED_UNKNOWN",openedAt:T,previousSessionRecordDigest:D\|null,reasonCode:E\|null}`。R1.2 持锁且真实 owner/路径核对后写 OPEN：previous/reason 均 null，recordedAt=openedAt。close 写 CLOSED：引用上一 session record，reason null；存活父方或恢复核对写 UNKNOWN：引用前序、reason 非 null。后两者 recordedAt>=openedAt；异常死亡不能假造已写 CLOSED，缺关闭记录按未知拒绝旧 session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `revocation`          | `{ownerId:S,sequence:integer>=0,previousRevocationDigest:D\|null,action:"GENESIS"\|"REVOKE_AUTHORIZATION"\|"REVOKE_PROFILE",authorizationId:UUID\|null,reasonCode:E\|null}`。H1 初始台账 GENESIS：sequence=0、三个 nullable 字段为 null；R1.2 受控 owner 撤销追加：sequence=前序+1、previous 非 null、reason 非 null，仅 REVOKE_AUTHORIZATION 的 authorizationId 非 null。其他两分支 authorizationId=null；缺链、回退或未知均拒绝，不生成“未撤销”伪成功记录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `consumption`         | `SessionBinding & OperationBinding & {ownerId:S,authorizationDigest:D,requestDigest:D,stage:"target-observe"\|"runner-command",sessionRecordDigest:D,revocationRecordDigest:D,revocationSequence:integer>=0,status:"CONSUMED"}`。R1.2 锁内最终核验后原子占用该 authorizationId 对应唯一消费槽、写原件；授权 ID 由 authorizationDigest 的原件解析，不能允许同 ID 换签名产生第二槽。这里只记已发生的消费承诺，没有 receipt/结果/未来读回字段；写是否成功不明即占用未知，不写另一条 CONSUMED 代替                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `consumption-handoff` | `SessionBinding & OperationBinding & {authorizationDigest:D,requestDigest:D,containerId,runnerImageDigest,childChallenge,consumptionRecordDigest:D,consumptionReadbackDigest:D,revocationSequence:integer>=0,issuedAt:T,expiresAt:T,signature:string}`（类型同 §2.1）。R1.2 在消费原件与成功独立读回后签发；recordedAt=issuedAt，`expiresAt=min(授权 expiresAt, issuedAt+30000ms)`，只适用于 runner-command。signature 算法见 §2.1；不含自己的 custody、post-state 或 execution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `post-state`          | `SessionBinding & OperationBinding & {requestDigest:D,consumptionRecordDigest:D,outcome:"OBSERVED"\|"UNAVAILABLE",observationDigest:D\|null,observedAt:T\|null,reasonCode:E\|null}`。R2 实际观察后由 R1.2 归档；OBSERVED 必须有已读回的 R2 observation digest/真实 observedAt、reason null；UNAVAILABLE 的前两项 null、reason 非 null。recordedAt>=observedAt（有值时），只记录确实发生的观察，不合成 OID/role/迁移成功                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `execution`           | `SessionBinding & OperationBinding & {attemptId:UUID,requestDigest:D,authorizationDigest:D\|null,consumptionRecordDigest:D\|null,handoffRecordDigest:D\|null,handoffReadbackDigest:D\|null,postStateRecordDigest:D\|null,predecessorExecutionRecordDigest:D\|null,startedAt:T\|null,finishedAt:T\|null,status:"PREFLIGHT_REJECTED"\|"FAILED"\|"SUCCEEDED"\|"INTERRUPTED_UNKNOWN",reasonCode:E\|null,resultDigest:D\|null,processEvidenceDigest:D\|null}`。R1.2 保管 R2 真实结果/父进程事件；startedAt/finishedAt 只记录可证明的实际开始/结束，有值均不晚于 recordedAt，两者都有值时 startedAt<=finishedAt。null 表示事实尚未产生/不可证，绝非成功空值。SUCCEEDED 必须有开始/结束、授权/消费/post-state/result，reason null；runner SUCCEEDED 另必须有 handoff、其成功 custody 和实际 processEvidence，target-observe 三者均 null。PREFLIGHT_REJECTED 必须 reason 非 null、startedAt/finishedAt/result null；只允许引用失败前实际存在的授权/消费/handoff。FAILED 必须非 null reason 和足以证明未执行或已知失败的 result/process evidence（目标只读失败可只有 result）；一旦无法证明是否提交/证据丢失则用 UNKNOWN，不准 FAILED。UNKNOWN 必须 reason 非 null，无法证明进程结束时 finishedAt=null，未获得的后置/process/result 等字段保持 null；不是成功结果。apply/replay/reconcile 的前序引用与 §2.4 对照；失败记录在默认180日保管治理期内不覆盖，不新增永久保留政策 |
| `custody`             | `{ownerId:S,subjectDigest:D,subjectType:"profile"\|"authorization"\|"record"\|"r2-artifact",purpose:"consumption-readback"\|"handoff-readback"\|"archive-readback"\|"backup-readback"\|"owner-acknowledgement",outcome:"MATCH"\|"FAILED"\|"UNKNOWN",observedDigest:D\|null,observedAt:T\|null,storageRole:"journal"\|"archive"\|"backup",retentionDays:180,reasonCode:E\|null}`。R1.2 独立重开读取或 owner 真实签收后追加，不使用写入响应。MATCH 要求 observedDigest=subjectDigest、真实 observedAt<=recordedAt、reason null；FAILED/UNKNOWN 必须 reason 非 null，观察不到的 digest/time 为 null，若有不同 digest 必须保留且不可称 MATCH。consumption-readback 只指已存在消费原件、journal；handoff-readback 只指已存在 receipt、archive；backup-readback 只取独立 backup。subject 不得为 custody 自己或另一 custody，避免无限“读回自己的读回”；签收/180日是承诺与当时观察，不是未来保管证明                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `signoff`             | `SessionBinding & OperationBinding & {ownerId:S,executionRecordDigest:D,executionReadbackDigest:D,backupReadbackDigest:D,decision:"ACCEPTED"\|"REJECTED",reasonCode:E\|null}`。owner 在 execution、archive/backup 的 MATCH custody 均实际存在后签收本次结果；两个读回均必须指向该 execution 原件。ACCEPTED 仅允许完整 SUCCEEDED，reason null；REJECTED 必须 reason 非 null，可引用失败/UNKNOWN 但不能赋予成功含义。recordedAt 不早于全部前序记录；这不是 R4/A3 Staging 验收签字或新密码学签名域                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`post-state/execution` 的 R2 artifact 只以已存在的 digest 引用；具体工具版本、PID/退出码、stdout/stderr 计数、DB catalog、H3 权限原件和结果清单由 R2.1–3 定义/独立读回，R1 不复制其 Schema。记录前序必须核对 kind、profile/session/operation 及同请求关系；custody 无 session 键时通过 subject 原件归属。**R1.2 写 SUCCEEDED 和 R2 result reader 接受该状态前，还必须独立读回 post-state=OBSERVED、其实际 observation，以及 command/phase 相符且满足该 phase 全部成功断言的真实 result/process artifact**；非空 digest、Schema 合法、工具退出0或同链身份本身不足。UNAVAILABLE post-state、失败 artifact、错误 phase/subject、MATCH custody 指向另一原件均拒绝成功/ACCEPTED signoff。根 profile 不引用 build；OPEN/GENESIS → 授权和请求 → consumption → 该 consumption 的 custody → handoff → 该 handoff 的 custody → 实际操作 → post-state → execution → execution 的 archive/backup custody → signoff。target-observe 跳过 handoff；拒绝/UNKNOWN 链在实际已有节点结束，后续恢复只追加，不能回写缺失事实。撤销链独立按 sequence 单向追加并由 consumption 引用当时头，后来的撤销不能倒写进旧 receipt。

### 2.4 六函数的输入、结论和拒绝分层

`verifyManualAuthorization` 的 `session` 为封闭 `{record:SessionRecord,recordDigest:D,readAt:T,predecessor:ExecutionRecord|null}`；`revocation` 为 `{records:RevocationRecord[],headDigest:D,checkpoint:{sequence:integer>=0,digest:D},readAt:T}`，records 必须从 GENESIS 至当前头完整连续非空，checkpoint 必须是其中同序同 digest 节点。R1.2 从固定 owner-only IO 在锁内生成二者；session.record 是最新可证明 OPEN，readAt 不晚于 now、不早于该 record；revocation 同样约束，固定 IO 还保证实际“当前读回”，纯 kernel 不声称时间戳或路径来源真实。

| 既有公开签名/输入                                                                                                                                                     | 确定性行为与成功结果                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `encodeManualJson(value):Buffer`                                                                                                                                      | 拒绝非 I-JSON/超限，返回现有 canonical UTF-8 bytes；不签发或建立品牌                                                                                                                                                                                                                                                                                  |
| `signManualAuthorization({payload:AuthorizationPayload,privateKey:KeyObject}):Authorization`                                                                          | 封闭 Schema/有限时间表示和 Ed25519 私钥类型通过后按 §2.1 签名；无 IO，不证明允许签发；profile/key/session 的真实准入仍由 session.sign 校验                                                                                                                                                                                                            |
| `verifyManualAuthorization({authorization:Authorization,profile:Profile,request:RequestInput,session:SessionInput,revocation:RevocationInput,now:T}):ParentDecision`  | 完整限额/结构 → profile 时间/指纹 → 授权签名 → requestDigest及全部绑定 → OPEN session/前序/撤销链/时序。返回深冻结 `{kind:"manual-parent-decision",authorizationDigest:D,requestDigest:D,profileDigest:D,stage,sessionId,sessionNonce,operationId,idempotencyKey,promotionEligible:false}`，仅模块内 parent WeakSet 品牌；不是“已消费”证明            |
| `assertManualDecision(decision):void`                                                                                                                                 | 仅接受 parent WeakSet 内对象；JSON/复制/child 对象拒绝，不读取日志或改变消费状态                                                                                                                                                                                                                                                                      |
| `verifyManualHandoff({authorization:Authorization,receipt:HandoffRecord,profile:Profile,request:RequestInput,childObservation:ChildObservation,now:T}):ChildDecision` | 复验结构/profile/授权签名/完整请求及 stage runner-command → 独立域 receipt 签名 → 下表全部绑定及窗口。返回深冻结 `{kind:"manual-child-decision",authorizationDigest:D,requestDigest:D,profileDigest:D,receiptDigest:D,containerId,runnerImageDigest,childChallenge,promotionEligible:false}`，仅 child WeakSet 品牌；不读取宿主台账，也不重新消费授权 |
| `assertManualHandoffDecision(decision):void`                                                                                                                          | 仅接受 child WeakSet 内对象；parent/复制对象拒绝。六函数均不导出品牌构造器；Buffer、KeyObject、void 返回不附加字段，两个 decision 固定 promotionEligible=false                                                                                                                                                                                        |

| 必验等式/状态           | 规则及输入权威                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| profile/owner/目标/能力 | 授权与 request.binding 所有 ManualBinding 键逐项相等；profileDigest=完整 profile digest，ownerId=profile.ownerId；targetIntent/用途/角色/TLS/command-version-capability 均在固定 profile 的同一目标项内。target-observe 无需未来 DB/Runner；runner 实际镜像 digest 与已核验 build 的对应项由 R2 在签发前读取并比对，内核不把一个 buildProofDigest 当 build 验真                                                                                                                                                                                                                                                                                                                                        |
| session                 | recordDigest=record digest；profile、owner、sessionId/nonce、targetIntent 等于授权；status=OPEN；openedAt<=authorization.issuedAt<=session.readAt<=now。生产最新 session/lock/存活性不能由 caller JSON 自报                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 前序                    | dry-run 和 target-observe 的 predecessor=null；apply 的 predecessor 是同会话、同 operation/idempotency、同 request 所绑定 build/baseline/physical target 的 SUCCEEDED dry-run execution，digest=dryRunRecordDigest，已读回 result 的 plan digest=approvedPlanDigest；replay 仅从同 operation/key 的 SUCCEEDED 原件，reconcile 仅从 INTERRUPTED_UNKNOWN 原件，digest=predecessorExecutionRecordDigest。verify 有前序时必须同 operation 链所引用的已知迁移结果；其自身可以使用新的只读 operationId，不能冒用迁移 capability。前序 request/result 原件检查和现有 `assertApplyAllowed/transitionExecution` 在 R1.2/R2 完成；纯 kernel 只检查所传 execution 的可见字段/digest，不从不存在的未来 result 推断 |
| 撤销                    | records 全链 digest/sequence/前序相连、profile/owner 相等、时间单调不晚于 readAt；headDigest=最后 record digest，checkpoint 不得缺失/越过/回退。任一 REVOKE_PROFILE 或授权 ID 的 REVOKE_AUTHORIZATION 即拒绝；纯函数不能证明记录没被 caller 截短，当前头/checkpoint 的真实读取由父 IO 保证                                                                                                                                                                                                                                                                                                                                                                                                             |
| handoff                 | receipt 的 authorization/request/profile digest、sessionId/nonce、operationId/idempotencyKey 全等于授权；containerId/image/challenge 同时等于授权绑定及本次 childObservation；receipt.issuedAt>=authorization.issuedAt，recordedAt=issuedAt，issuedAt<=now<expiresAt，expiresAt=min(授权到期,issuedAt+30秒)。consumptionRecordDigest/consumptionReadbackDigest 是签名覆盖的父方承诺，子 verifier 无原件输入不能伪称独立证实其存在；父 IO 在签发前已完成对应 kind/digest/MATCH 检查，R2 result reader 后续再次读取                                                                                                                                                                                      |

拒绝按首次失败的层分类，不把“Schema 通过”记为验签或消费通过：结构复用 `validateContract` 的既有结构化错误（测试断言其 `code` 与 `details.errors[].keyword`）；字节超限 `MANUAL_JSON_LIMIT`；Ed25519 类型/PEM/指纹/签名编码/验签失败 `MANUAL_SIGNATURE_INVALID`；有限时间/窗口 `MANUAL_TIME_INVALID`；身份、字段、摘要、stage/命令或前序不等 `MANUAL_BINDING_MISMATCH`；完整链中命中撤销 `MANUAL_AUTHORIZATION_REVOKED`；不可证明的 session/revocation 结构外状态/链/回退 `MANUAL_SESSION_UNVERIFIED` / `MANUAL_REVOCATION_UNVERIFIED`；两种品牌分别 `MANUAL_DECISION_UNTRUSTED` / `MANUAL_HANDOFF_UNTRUSTED`。真实 IO 的权限/读回失败仍 `MANUAL_STORAGE_UNVERIFIED`，消费槽重复 `MANUAL_AUTHORIZATION_CONSUMED`，重复协议 frame `MANUAL_HANDOFF_REUSED`；后两者不由纯 verifier 发出。

纯 verifier 对同一合法输入重复调用可以再次产生各自品牌 decision，**不修改持久或模块级 anti-replay 状态**；WeakSet 只证明本模块判定来源。重复使用授权的权威拒绝属于 R1.2 单一 journal/锁；单一 Runner 本次管道只接受一个授权/credential 交接属于 R2.2 的现有单次 handler。不能以 WeakSet 代替实际消费，也不新增 seen-receipt 全局表、第二持久防重放机制或新服务。

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
- Produces: §2.4 精确定义的 `encodeManualJson`、`signManualAuthorization`、`verifyManualAuthorization`、`assertManualDecision`、`verifyManualHandoff`、`assertManualHandoffDecision`，仍仅六个公开函数。parent/child 为不同 WeakSet 品牌，JSON 或 `{verified:true}` 无法还原；签名验证不是 journal 消费或管道使用。
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
- [ ] **3. 增加逐项签名反例并运行 RED。** 改签名字节、profile key、purpose、request digest、过期/未来授权、会话 nonce、撤销 ID、stage 额外字段、migrate apply 缺 plan、verify 带写 capability。另以合法 key 签出超过五分钟上界 1ms 的授权，父/子 verifier 均拒绝 `MANUAL_TIME_INVALID`，不以签名有效放行。每个反例使用真正签名基线后仅变一个字段；结构、签名、时间、绑定、撤销分层按 §2.4 断言，不以 Schema 成功代表授权有效。
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

- [ ] **5. GREEN 与归属检查。** 重跑该测试、`pnpm release:contracts:verify`；新 Schema 与模块路径显式纳入 contract manifest。六个函数均有精确导出，不导出可伪造两种 decision 的构造器；补未签消费 receipt、错授权/挑战、父/子 decision 互换、域错、超期负例。相同合法 handoff 重复纯验证应可再次产生 childDecision，但不产生任何消费/DB/凭证 IO；真正重复使用的拒绝断言归 R1.2/R2.2，不增加 kernel replay cache。
- [ ] **6. 独立审查后提交。** 精确七文件运行 Prettier、`git diff --check`；只暂存 Files 中七文件，`git diff --cached --check` 及 staged 清单复核后提交 `feat(release): define closed manual authorization contracts`。无 profile 实例、真实 key、DB 或工作流修改。

## Task R1.2：单父会话、撤销消费与私密记录

**Files:**

- Create: `packages/release-foundation/src/manual-stage1-session.mjs`
- Create/Test: `packages/release-foundation/test/manual-stage1-session.test.mjs`
- Modify: `packages/release-foundation/src/index.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: R1.1 函数及 `createExecutionState/transitionExecution/assertApplyAllowed`。既有状态机只处理迁移执行状态；只读 verify/observe 不捏造 dry-run。
- Produces: `openManualSession({profile,ownerObservation,io,now,signingKey}):Promise<Session>`；`session.sign(request:RequestInput):Promise<Authorization>`；`session.consume({authorization:Authorization,request:RequestInput,childObservation?:ChildObservation}):Promise<ConsumptionResult>`；`session.record(kind,value):Promise<RecordRef>`；`session.close():Promise<RecordRef>`。consume 仅 runner-command 必须传实际 childObservation，target-observe 禁止该键；这是给既有消费接口补齐真实子上下文的 typed input，不增加权限、stage、服务或导出。signingKey 只接受内存中的 Ed25519 KeyObject；生产加载唯一归 R1.3，测试使用进程内临时 key。`io` 是同模块生产文件适配器或本文件测试私有工厂，正式 CLI 无 IO/module 路径选择项。
- `ownerObservation` 精确为 `{ownerId:S,principal:({platform:"win32",sid:S}|{platform:"posix",uid:integer>=0}),targetIntent:TargetIntent,observedAt:T}`。R1.3 固定本机读取实际 SID/uid，并与 H1 owner/权限映射核对；targetIntent 只从现有 operationRef 的固定索引独立读回、匹配 profile，不能由索引自报 owner 有效。它唯一确定本次 open 的目标，不在多个 allowedTargets 中猜选。`now` 是生产固定时钟函数 `():T`，每次 sign/consume/record/close 重读，再向纯 kernel 传该时刻的 T；测试时钟只允许单测注入。session.sign 在人工确认之后生成新随机 UUID authorizationId，以当次时钟为 issuedAt、`min(profile.expiresAt,issuedAt+300000ms)` 为 expiresAt（固定最长5分钟，不提供 argv/env 延长选项），复制核对后的 binding 并重算完整 requestDigest；时间已无有效区间即拒绝。
- session 产生 UUID/随机 nonce、持有精确目标排他锁和当前授权队列；主进程结束后不再签发/消费。`consume` 返回封闭联合：`target-observe` 仅为 `{stage,parentDecision,consumptionReadbackDigest}`，供父方只读目标探测，不引用尚不存在的子进程；`runner-command` 为 `{stage,parentDecision,handoffReceipt}`，先持久化消费原件并独立读回，再签发并 create-only 保管交接 receipt，最后才交出使用权。禁止跨 stage 字段，只有后一分支可交接子进程凭证。
- `Session` 仅暴露深冻结身份 `{sessionId,sessionNonce,profileDigest,targetIntent}` 及上述四个方法，锁/队列/密钥/IO 不可取出；`ConsumptionResult` 即上行封闭联合。`RecordRef={recordDigest:D}` 仅在 create-only 原件写入并独立读回成功后返回；record 不自动递归生成 custody。close 持锁写 CLOSED/独立读回后释放锁与内存 key，再返回其 RecordRef；失败则拒绝 Promise、尽力保留 UNKNOWN，不能返回 CLOSED 成功。底层 fs 不是新公共 IO 框架；固定适配器和故障注入工厂仅限本模块私有构造及本任务既有测试受控临时目录，生产只由 R1.3 构造，无 CLI/env/module 路径注入。

交接 receipt 的唯一封闭形状、字节域和 30 秒窗口见 §2.1/2.3；不得在此或 R2 再定义另一 receipt。`consume` 的固定顺序和中断含义如下。

| 时点           | 唯一责任与失败结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 签发前         | R2 先真实 target-observe/归档读回，再冻结 baseline（其中 authorizationDigest 指已存在的 target-observe 授权，不是未来 Runner 授权），再启动零凭证 child。R2 读回实际 image/container/challenge 并完成完整请求 Schema；R1.2 sign 在活跃父锁内读当前 session/撤销、核对固定 profile/key、人工确认后签发。目标观察与 Runner 期间不释放重取目标锁，不用含 role 的 fingerprint 分锁                                                                                                                                                      |
| 消费承诺       | R1.2 在同一锁内从固定 journal 独立读回 current session、完整撤销链/checkpoint、该目标全部未决 operation 历史，调用纯 verifier 并核对已有状态机前序。以 `profileDigest/authorizationId` 为同一 journal 内唯一 CreateNew 消费槽，槽内写完整 consumption 原件，再按规范 digest 建档；内容寻址本身不能取代唯一槽。槽存在或写成败不明均拒绝再次消费，禁止换签名/recordedAt/digest 创建第二个槽                                                                                                                                           |
| 交接准备       | 消费原件 → 独立重开读回并写 MATCH custody → 使用同一内存 key 签 handoff → create-only 保管 receipt → 独立读回并写 MATCH custody。任一 write/readback/sign 中断，保留已有节点、标记该 operation INTERRUPTED_UNKNOWN，不交凭证、不重新签 receipt。target-observe 只做到消费读回，不触及未来 child                                                                                                                                                                                                                                     |
| 最后释放界点   | consume 在上述结果齐全后、仍持父目标锁时最后重读当前撤销/会话并检查原子消费槽；重查发现撤销/关闭即拒绝释放，保留已消费事实。成功返回是本次不可重试释放承诺的线性化点，固定 R2 launcher 随即仅向同一管道交当前 capability 的一次凭证；不能缓存返回值另开 child/重复发送。返回后至实际写管道之间中断也按 UNKNOWN，不重试消费/receipt；这不宣称撤销能与跨进程字节交付或 DB commit 原子化                                                                                                                                               |
| 子方一次使用   | R2.2 同一前台 entrypoint 只接一个 challenge 对应的授权/receipt 和一个 credential frame；完整请求检查及 verifyManualHandoff 通过后才建 connector/调用一次 handler，随后结束。第二授权/receipt/credential frame 或换管道触发 MANUAL_HANDOFF_REUSED，未打开新 DB 调用；这是已有单次管道流程的使用约束，不是另一持久消费表。child 不加载宿主 key/journal/backup                                                                                                                                                                         |
| 中断与重新进入 | 父死亡/锁或 journal 不可证则旧未消费授权失效；已消费凭证是否到达/DB是否提交未知不能说回滚。新可信父会话可从同一目标 journal 独立读回原件，用**同一既有 execution-state-machine** 恢复已知状态，不新建迁移状态机。UNKNOWN 禁止换 authorizationId/operationId/idempotencyKey 重新 apply；只允许新的只读 reconcile 授权/attempt/challenge，绑定原 operationId/key/前序 UNKNOWN、原 build/baseline/physical target。同会话要求只限定 dry-run→apply；后续 verify/replay/reconcile 可用新 session/nonce，但不复活旧授权，不覆盖原失败历史 |

reconcile 本次只读尝试失败与原 apply 是否提交是不同事实：缺权限、schema 检查 PASSED 或不足的 observation 均不能把原 UNKNOWN 写成 SUCCEEDED/FAILED。无法证明 committed/not-committed 时原链保持 UNKNOWN。R2.1 若现有 handler 的稳定 plan input 映射、expectedSchemaDigest 来源或三态 reconcile 证据不能满足这些断言，沿用其“给精确反例并停止”门槛，**不在本 R1 修订中修改 handler/状态机或设计补救机制**。R2 第二阶段 H3-B 原件只能在真实产生后作为其独立人工批准/权限读回输入；不得新增 R1 第三 stage 或要求首个消费记录引用未来 H3-B/signoff。

R1.2 `manual-stage1-session.test.mjs` 和 R2.3 `scripts/release/verify-manual-runner-result.test.mjs` 均须增加同身份但 post-state=UNAVAILABLE、result 实际失败/错 phase、custody=MATCH 但 subject 指另一原件的反例；断言拒绝写入/接受 SUCCEEDED 和 ACCEPTED signoff，不因外层 digest 齐全通过。

恢复身份例外必须显式停止：execution.attemptId 只能取 R2 在调用开始前已实际分配并保管的完整 request/启动事件原件（包括 target-observe），受完整 requestDigest/原件摘要覆盖，不是事后生成的补位 UUID。消费成功而 execution 尚未落档时，只有原 attempt/请求/身份可独立证实时才能追加该原 attempt 的 UNKNOWN，再按现有规则申请只读 reconcile；任一必填身份未产生或不可证，只保留已消费槽、已有 session/未关闭事实并 STOP，不能伪造完整 execution 或声称已具备 reconcile 前序。存活恢复者在能够满足 session kind 的身份条件时可追加 session UNKNOWN，不回写旧记录。此分支由 R1.2 既有测试覆盖，重复消费仍被原槽拒绝，不新增恢复服务或 record kind。

| 计划测试归属（本 DOC-ONLY 修订不执行/不生成测试）                                                                           | 精确断言                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1.1 `manual-stage1-contracts.test.mjs`                                                                                     | 八 kind 各一个合法 factory；逐一删除必填键/添加额外键/错 kind/错误 nullable 分支均拒绝；未来/自身引用由记录 IO 验证测试补充。覆盖 SPKI DER fingerprint、两个签名域、签名整外壳 digest、完整 request 一字节/非投影字段改变、target-observe 未来字段、时间 round-trip/边界、前序/nonce/撤销链/两种品牌及重复纯验证无 IO |
| R1.2 `manual-stage1-session.test.mjs`                                                                                       | 同 ID 并发/跨 session/换签名消费槽只成功一次；写成败不明/原件读回失败/receipt 保管失败/最后撤销均释放凭证计数 0；原 UNKNOWN 换 ID apply 仍拒绝；新 session 同原 key 的只读 reconcile可准入。八 kind 的生产时点、MATCH 原件等式、前序同链、拒绝未来/self/custody递归引用，缺失字段不伪造，所有失败 create-only 保留    |
| R2.1 `apps/release-runner/test/manual-command-adapter.test.mjs`、`apps/release-runner/test/manual-target-observer.test.mjs` | 完整 request Schema/封闭映射先于 DB；稳定领域 plan input 不被新 envelope 自漂移且不复用 attempt；preState catalog 不冒充 expected schema script；缺少 reconcile 原提交证据不能以 schema PASSED 消除 UNKNOWN。只列消费者断言，不增文件/构造器                                                                          |
| R2.2 `scripts/release/launch-manual-stage1.test.mjs`、`apps/release-runner/test/manual-entrypoint.test.mjs`                 | 未过完整 request Schema 时 credential-read/DB-connect=0；actual child 上下文不可从 receipt 复制；第二 frame/换 child/challenge 拒绝；父锁跨角色/别名排他，最后撤销与返回后断管保留已消费/UNKNOWN                                                                                                                      |
| R2.3 `scripts/release/verify-manual-runner-result.test.mjs`                                                                 | reader 独立核对真实 artifact/读回与失败历史；未知不能被 schema PASSED 判成功；第一阶段不要求未来 H3-B，第二阶段缺 H3-B/真实权限读回不能整体 PASS                                                                                                                                                                      |

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
- Produces: `loadFixedManualProfile({repoRoot}):Promise<Profile>`（固定相对位置，未建立时报 `MANUAL_PROFILE_NOT_PROVISIONED`）；`verifyManualBuild({proofBytes,materialBytes,repoRoot}):Promise<trustedBuildDecision>`；`openTrustedManualSession({repoRoot,proofBytes,materialBytes,operationRef}):Promise<Session>`。operationRef 仅为 R2 已有的固定根内非秘密 UUID/digest 索引 ID：这是多目标 profile 下唯一选定已批准目标所需的 typed-input completion，不增加 CLI 参数或任意目标覆盖。最后一个函数先真实 build/profile 验真，再从固定索引独立读回 targetIntent、核对 profile，使用固定本地主体/H1 映射观察、非导出 `loadFixedSigningKey(profile)` 和真实文件 IO 构造 R1.2 session；生产请求不能传 signingKey/IO/ownerObservation/targetIntent。R2.2 调用方只传它已有的 operationRef；索引本身不能建立 owner 信任。
- 从旧 verifier 提取 `assertBuildIdentity({proof,buildMaterialObservation}):void`，只包含原 Schema/三镜像/source/catalog/material 绑定。旧 `verifyBuildProof()` 继续调用它及原 attestation/custody 校验，旧 fixture 路径仍不可提升；新接口名明确不含 trusted/verified，不返回通行证。
- 同一任务把新入口 `scripts/release/manual-stage1-trust.mjs` **及其实际共享依赖 `scripts/release/verify-build-proof.mjs`** 同时纳入 `RELEASE_GATE_ENTRY_POINTS` 与 `repository-contract-files.v1.json`。旧 verifier 当前未纳管；不能只登记新入口，不能用 dependency 的自报摘要代替实际源码重算。此变化会改变 repository contract digest，必须进入 H2 新可信构建。

- [ ] **1. 写固定输入/CLI 边界 RED。** 实际子进程执行 trust 文件；不存在 profile、argv `--trust-root/--profile-file/--archive-root`、环境 override、额外 JSON 属性均拒绝。合法测试用隔离 Git 工作区和临时 fixture profile，不向真实仓库固定路径写测试 key。
- [ ] **1a. 补既有入口的 typed-input RED → GREEN。** R1.3 仅在本任务已有 `manual-stage1-trust.test.mjs` 覆盖 operationRef 缺失/越界/错目标、多目标 profile 不猜选、索引伪造 owner、实际 SID/uid 不符均拒绝；build/profile 未通过时 private-key-read=0。R1.2 既有 session 测试覆盖每次重读时钟、5分钟/到期较早界、禁止 caller 替换 nonce/授权 ID，以及真实 childObservation 的仅 runner 分支；R2.2 在其消费阶段单独于 `launch-manual-stage1.test.mjs` 复验 operationRef 传递；R1.3 不创建或修改 R2 文件，不新增测试文件或生产构造器。
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
