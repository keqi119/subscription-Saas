# Stage 1 R2 最终 Runner migrate/verify 竖切实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development，子 agent 按提交边界施工，主 agent 逐项审查；如用户改变模式才使用 superpowers:executing-plans。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 R1 人工授权接入最终 Runner 的两个既有数据库命令，实际证明权限隔离、迁移重算和只读核验；不启动完整 RC、Staging 或 Task 30。

**Architecture:** 保留旧可信启动路径不变，在固定 Runner entrypoint 内增加封闭的人工交接分支。复用现有 PostgreSQL connector、runtime adapter、migration/schema 函数；不以云 approval、预制测试 JSON 或 `verified:true` 代替 R1 的真实验证和会话消费。

**Tech Stack:** 现有最终 Runner Node 22/Prisma 7.8.0/psql 17，PostgreSQL 17 digest-pinned 合成 fresh 目标，Docker 原生固定参数启动，Node 流/子进程测试。无新依赖、数据库迁移或云服务。

**Spec:** [最小受控发布决策 §3、§5](../specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md)、[R1 计划](./2026-09-06-stage1-r1-manual-trust-and-authorization-plan.md)、[覆盖路线图](./2026-09-06-stage1-mainline-minimal-release-implementation-plan.md)、[P0/P1 实际索引](../../acceptance/2026-09-06-stage1-mainline-execution-index.md)。

## 本轮 H3 交接修订状态（2026-09-13，待复审）

用户已批准 R1.3 `aebbb6b0` 的本地实现；R2.0 `5a16ca8a` 不重复施工。本轮只修订 R1/R2 两份计划，分别提交复审，不写代码。当前接续为：**两份 H3 交接修订复审 → R1.3H 共享纯契约实施及独立审查 → R2.1 → R2.2 → R2.3**。R1.3H 未通过前不得以测试夹具补通道并启动 R2.1；真实 H1/H2/H3、R2.4、外部操作和 Task 30 不随文档批准放行。

历史 R1.1/E/2/RP 记录原样保留；以下 RP6 断点文字是当时事实，不能覆盖上段当前状态。R1.3 已有四文件实现不返工。本轮明确申请的共享前向改动由 R1.3H 独占，R2.1/2/3 的既定可写文件清单不扩大。

## Global Constraints

- 历史 RP6 断点（当前状态以上节为准）：**RP1–RP5 已按获批的 90 日同步计划交付代码；RP6 初次 frozen compatibility 183/185、exit 1 的 STOP 原件保留为历史，随后获批的同字节 scratch-only 完整重验 185/185、exit 0，后置核验 exit 0，独立 evidence review 为 `PASS/LEGACY_SCRATCH_RETRY_CONFIRMED`。RP6 获批的本地执行/审查范围 `LOCAL_COMPLETE`，仅待本地文档提交与 metadata final check；R1.3 的“90 天代码同步”前置已解除，但 R1.3 尚未实施且未因本结论获得施工批准，R2.1–R2.4 不因本稿恢复**。R1.1 `a7dae491`、R1.1E `f618b2d2`、R1.2 `a42c2041`、R2.0 `5a16ca8a` 的历史范围不改写；RP1–RP5 实现提交为 `0ce02461`/`fb5c3d36`、`41dfaf37`/`8f5402c0`、`b9aaa55e`、`a7377cc1`、`6f834aaa`。H1/H2/H3、真实 profile/key/credentials、DB/Docker/网络操作与 Task 30 仍未批准。
- P1 两个合成目标已经退役。没有可复用的 active record 或 credentials；不读取归档秘密，不访问 ambient DB URL，不以旧删除批准覆盖新目标创建/退役。
- R2.0 已交付；R2.1–R2.3 的代码/适配器测试不连接外部目标，消费已交付的 R1.1/R1.1E/R1.2 及 RP1–RP4 前向接口。R1.3 的可写范围现为固定 trust loader/reader 及其 catalog/manifest 登记四文件；RP4 已独占共享 build 断言、verifier 修改及 verifier 登记，R1.3 不重复施工。R1.2 不反向导入 R2 runtime；R1.3 独占固定输入 reader/parser、build 原件验真和可信 session bootstrap。R2.4 真实运行还须 H1/H2/H3、独立 expected-schema 输入及原进程/写者排他事实；缺任何输入 STOP。
- Task 6/29R/30/I、业务代码、API/Web、历史迁移、Schema 模型、RBAC、工作流、旧 final Compose DAG、OSS/WORM 和冻结 stash 均不动。
- 仅允许 `db.migrate.deploy@1`、`db.schema.verify@1`；只有 `migrate`、`verify` 两种既有 capability，一调用一凭证。没有新的 `database-test` capability，没有任意 Shell/SQL/模块路径或容器 entrypoint override。
- 所有 manual JSON 实际字节上限 1 MiB；新 R2 固定 MS2、历史 MS1 的每帧及 stdin/stdout 各自完整流（全部 header/payload/base64 包装）均受同一 1 MiB 上限，不静默放大。日志不泄漏凭证、不保存 CREDENTIAL 原件/摘要/完整 stdin 或双向合并 transcript。真实 source/snapshot、API/Web 联测、供应商、浏览器、双链全量及 Stage 1 签字均非本计划完成条件。
- 本轮权限修订采用 **两个固定真实测试阶段 + 中间 H3-B 人工精确授权**，取代原 R2.4 单命令；不增加 permission worker、签名协议、Runner capability 或通用 SQL 入口。H3-A 仅准备目标，H3-B 必须等迁移表实际产生后另行批准；两阶段都完成才可能形成完整 R2 结论。

## 1. 基线事实与不能省略的门槛

| 位置                                                                     | 本次只读确认                                                          | 处理                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/release-runner/src/cli.mjs`                                        | `runProductionEntrypoint` 已调用真实 runtime adapters                 | 不是“默认占位器”；保留现有生产模式，新增分支显式隔离                                  |
| `apps/release-runner/src/postgres-connector.mjs`                         | 实际读取 DB OID/role/TLS，fingerprint 包含角色                        | physical DB identity 与各 profile observation 分开比较，禁止改写既有 fingerprint 含义 |
| `apps/release-runner/src/commands/db-migrate-deploy.mjs`                 | 确定性 plan、锁内重算、真实 Prisma 调用、replay/reconcile             | 直接复用，不能另写 SQL migration runner                                               |
| `apps/release-runner/src/commands/db-schema-verify.mjs`                  | catalog/checksum/owner/diff/版本/只读 statement 检查                  | 直接复用，verify 身份必须有实际读取所需的最小权限                                     |
| `apps/release-runner/test/db-migrate-schema.integration.test.mjs`        | 测试 context 是内存对象                                               | 可作回归，不能称真实 PG/镜像测试                                                      |
| `apps/release-runner/test/database-runtime-adapter.integration.test.mjs` | Prisma/psql 子进程也被注入替代                                        | R2.4 才采集真实最终镜像执行                                                           |
| P1/bootstrap 与 suite launcher                                           | P1 verify 没有迁移表读取授权；普通 fresh launcher 使用非 TLS 本地通道 | 不把它们直接当最终只读/TLS 门禁；H3 独立建立并读回目标权限，R2 不改 P1 record         |

用户已于 2026-09-10 将新执行保留策略统一调整为 **90 日**，不再以 180 日作为新候选目标。RP1–RP4 已交付 v2/90 profile/record、session/live/archive 当前链绑定、显式 retention90 custody 分支和共享 build 断言；RP5 只交付两份 90 天 public Actions artifact，固定返回 `authorityCustody:"INPUT_REQUIRED"` 和 `promotionEligible:false`。R2 只消费 R1 §1.1/§2.6 的固定 v2 政策与已验证 retention90 receipt，不另设策略或第二 verifier。历史 R1.2 v1/180 原件及收口不改写、不追认，新执行须匹配同步后的 source/contract/profile/build。读回仍须覆盖各类证据原起算事件后的 90 日，不接受 caller 数值、`now+90d`、仅 Actions 参数或公共存储替代最小读取权限。RP6 本地执行/审查范围已 `LOCAL_COMPLETE`，只解除 R1.3 的“90 天代码同步”前置；R1.3 已在 `aebbb6b0` 本地通过，H1/H2/H3 仍未完成，真实候选不可用仍 `TRUSTED_BUILD_UNAVAILABLE`。

**历史工具偏差与当前状态：** `Dockerfile.runner` 的 `/app` 工作目录和 `apps/api/prisma.config.ts` 固定 config 已由 `5a16ca8a` 的 R2.0 参数修正覆盖；当前源码有 `configRelativePath` 与三处固定 `--config`，script 不再传非法 `--schema`。适配器测试仍不证明真实 Prisma/镜像/DB 兼容，真实门禁未因此通过。另默认 `node --test test/*.test.mjs` 不得选入人工真实门禁，专用子目录与 discovery 例外各司其职。

## 2. 固定交接与证据顺序

唯一字段/producer/时间/digest/nullable/phase/三态谓词规范是 [R1 §2.5](./2026-09-06-stage1-r1-manual-trust-and-authorization-plan.md#25-r1r2-唯一共享请求原件与派生判定契约r11e-所有)，其中 §2.5.4 保留 MS1 历史规范，§2.5.5 定义本次前向 MS2/H3 非秘密输入；二者复用同一 framing/ACK/结果提取实现，禁止复制第二套 parser。R1.1E 七文件是已完成的历史范围；本次 R1.3H 独占共享前向 codec/validator、cluster fingerprint 纯函数及兼容测试，独立通过后才交 R2 消费；R2.2 现有 launcher/entrypoint 两文件拥有实际 collect/send/store/readback/ACK，R2.3 复用同一 validator/assessor，R2.1 仅领域 adapter/原结果映射。R2 不复制 grammar/Schema/成功谓词，也不引入 callback、CLI parser 路径或 verified flag。

R1.3 新 public reader `readFixedManualOperation({repoRoot,operationRef})` 是固定输入形状和路径的唯一 production parser；`operationRef` 只接受 lowercase RFC UUID，并只读 `profile.storage.archiveRoot/inputs/operations/{operationRef}/index.json`。它返回 `{operation,indexDigest,proofBytes,materialBytes}`；H2 固定输入还包括 `inputs/build/{proofRawHex}.custody-receipt.retention90.v1.json`，须为同一 CI run 的独立真实 attestation，且不向旧 `.custody-receipt.v1.json` 或其他名称 fallback。既有 `verifyManualBuild` 在 index 尚不存在时以无写入/无临时文件方式核验三份固定原件并返回 `custodyReceiptRawDigest`；当前该 receipt 不存在即 STOP。R2 只消费完整 verifier 结果并冻结其 digest，不自行加载/验证 custody、不补建 receipt，也不复制 parser、增加 export/file、以 latest discovery 选记录或建立第二个 build/session bootstrap。H1 固定 profile 为 `release/contracts/manual-stage1-profile.v2.json`，新增非秘密 `release/contracts/manual-stage1-owner-binding.v1.json`；owner-binding.v1 结构不变，其 `profileDigest` 绑定 v2 canonical bytes。

固定顺序为 `H1/H2 验真 → 单独获准的本地非授权 metadata prepare（不连接 H3）→ 冻结 index/readback → H3-A 精确批准及实际 create/readback → R1 reader/bootstrap → session/attempt → migration → H3-B 另批及实际 readback → 同 index 的 readonly verify`。H3-A/B 后生原件绝不回写 index；index 只选择输入，不批准任何外部操作。

`R1 build/profile 验真 → 父会话锁 → observe attempt allocation 读回 → 完整 observe request 读回/签发/消费 → 实际 observation → baseline → 新 runner attempt allocation 读回 → null-request PREPARED 读回 → 零凭证 Runner/challenge → 完整 request 读回 → request-bound 快照读回/签发/消费 → 单 capability 交接 → PREPARED 持久化 → 实际调用与进程事件 → observation/result → R1 post-state/execution → 独立读回`

- Runner 在 challenge 阶段没有 DB 凭证/连接；首帧 CHALLENGE 恰为 `{childChallenge:N}`，仅含其本进程自产并保留的随机nonce。完整container ID/resolved platform digest由父方本次真实create/start/inspect与registry读回取得，不要求child自行发现。父方上述两事实及已收到nonce全都产生后才冻结request，不审批未来container ID；AUTHORIZE额外的闭合 `launchContext:{containerId:N,runnerImageDigest:D}` 将原父IO事实交给同一child，不从待签request/授权/receipt复制生成。
- 固定 entrypoint、无额外 argv，通过已建立的 stdin/stdout 管道交接；不建本地 HTTP broker。父进程仅运行在 R1 已验证 owner 会话。本轮新 R2 仅接受 R1 §2.5.5 的 MS2，沿用 §2.5.4 的 ASCII length header + canonical UTF-8 JSON payload，只前向增加 AUTHORIZE.targetContext；没有版本参数/环境覆盖或 MS1 fallback。CHALLENGE/READY/CREDENTIAL_RECEIVED/PREPARED/EVENT/OBSERVATION/ACK_RECEIVED/RESULT 仅 child→parent，AUTHORIZE/CREDENTIAL/ACK 仅 parent→child。Node data chunk 不是 frame，双方使用共享 parser 处理 split/coalesce；完整 stdout 必须保留所有 frame，secret 只经 stdin 内存交付。
- 授权被 R1 原子消费并读回后，父方生成并保管签名 `consumption-handoff` receipt，最后重查撤销再交凭证。父进程的 `parentDecision` 仅控制凭证释放；Runner 用镜像内固定 profile 校验原授权、receipt 的不同签名域、有效期和自身 challenge，生成独立 `childDecision`。不能跨进程传 WeakSet decision，也不能让子进程声称已直接读取宿主撤销账本。
- 管道关闭/父会话死亡：未交凭证时拒绝，已交接后停止进一步动作并保留本次真实原件；父进程能存活时仅可停止记录中的精确子容器。仅原 apply 提交未知可按原 operation/key 另获只读 reconcile；不能靠断管宣称回滚。replay 失联只记 fresh replay attempt 的 INTERRUPTED_UNKNOWN（结束不可证则 finishedAt=null），保留原 apply 已提交/成功 checkpoint，但未决 replay 全历史使后续签发/消费 STOP；不发 PROCESS_LOST/ATTEMPT_FAILED，不自动转原 apply reconcile。
- 人工 baseline 只引用唯一 `buildProofDigest`，保存真实 pre-state、目标、角色观察及批准引用，不复制 source/三镜像/catalog 的第二份权威。新型记录不进入旧 full-RC 聚合，不伪造旧 `approval-record.v1` 或 `launch-attestation.v1`。
- apply 不重新生成审批身份：锁内重算 plan，并对照冻结 baseline/批准 digest；post-state 是新观察。verify/replay/reconcile 引用前序结果，不因合法迁移头变化拒绝，也不覆盖旧 baseline。

### 2.1 H3 非秘密身份投影的固定来源与单次交接

类型、字段和唯一 `computeManualClusterFingerprint(cluster):D` 算法归 R1 §2.5.5/R1.3H，本计划不再定义另一套 Shape/hash。这里明确真正 IO 的来源和时点；非秘密 `targetContext` 不是授权、品牌或自由输入文件。

1. 父 launcher 先用 R1 reader 取得当前固定 `operationRef/indexDigest/runId/profileDigest/targetIntent`。H3 仅从该 index 所在目录的 `h3-a-approval.json` 和 `h3-a-readback.json` 读回；拒绝路径覆盖、链接/重解析点、越界、非 owner-only、超 1 MiB、无独立重开或来源不明。两个 RawRef 覆盖各自**完整实际文件 bytes**；不对部分字段重编码冒充原件。审批来源和实际操作证据仍须满足既有 H3 人工门槛，文件存在、格式正确或摘要相同不等于批准。
2. H3-A 批准的 creation spec 只含创建前可知的容器名、专属卷、PG image digest、marker、profile 精确端点与内部 PG 端口等批准对象；**不能要求批准引用将来才有的 systemIdentifier、实际 containerId、serverAddress 或 databaseOid**。创建后 readback 才保存实际值。H3-A 后生 readback 必须绑定同 ref/index/run/profile/target，并将这些值逐项对应实际 create/inspect/SQL 原件；parent 才能形成 §2.5.5 的 TargetContext。任何所需字段缺失或无法确认真实来源均 STOP，不填占位值。
3. `serverAddress/serverPort` 指批准集群真实 PostgreSQL 会话返回的 `host(inet_server_addr())/inet_server_port()`，不把宿主 published port 当内部端口。固定 profile 的 `endpoint` 是连接意图，parent 通过实际 Docker 网络/端口/专属卷挂载读回验证它只指向该 container/volume/PG digest/marker；这里只对 H3 合成 fresh 支持已证明的精确映射。涉及 DNS/代理/地址转换但无法证明唯一目标时 STOP，不接收 caller DNS 结果或扩大网络策略。
4. 每个 Runner request 冻结及 AUTHORIZE 写出前，父方重新打开固定 H3 原件、复核 R1 index，并实际核对容器/卷/镜像/marker/映射仍一致；record/readback 变化或来源不明停止，不覆盖旧 H3-A。这里比较**稳定物理身份**，不要求 migration head、catalog、角色权限在迁移后仍等于 H3-A；它们由本次实际观察及 H3-B 独立规则判定。迁移、合法 H3-B、换 migrate/verify 角色不改变 cluster tuple；换容器/卷/PG digest/系统标识/endpoint 则不属于原目标，不能靠新 context 恢复原 apply。
5. 初始父方 observer 由已消费的 target-observe 授权连接；其 `observeManualTarget` 直接消费父方固定 IO 取得的同一 TargetContext；此时 request.stage=target-observe，只绑定已有 ref/index/run/profile/target 与实际 SQL，对照 H3-A 的 databaseOid/cluster，不要求不存在的 runner request.physicalIdentity、domainInput 或 baseline。成功观察后才构造 baseline。Runner 的 child 则只从本次 MS2 AUTHORIZE 取得它，先将 run/profile/target 与 request 及固定镜像 profile 绑定，将 databaseOid/clusterFingerprint 与 request.physicalIdentity 和 baseline.identity.physicalIdentity 绑定，才 READY/交凭证；childDecision 后再以本次获准角色实际查询 DB OID/name、system identifier、内部 address/port、role/TLS，全部相符才进 handler。child 不把 context 内的 DB 字段抄成实际观察，也不自行验证宿主 Docker 或 H3 人工审批；这些来源由既有可信父 IO 和后续独立 reader 负责。
6. `operationRef/indexDigest`、两份 H3 RawRef 的真实来源由父方针对 R1 reader 逐项核对；child 没有宿主 index/H3 文件访问权，不将包内自报字段当作独立证明。它只验证管道材料的封闭形状、同 request 绑定、已签 physical fingerprint 和授权后的真实 DB 值。context 只放 AUTHORIZE，禁止 CREDENTIAL、任意路径、额外挂载、Docker socket 或 env 旁路；完整 AUTHORIZE frame 使用现有 raw 保管并进入 process.protocol，不能生成第二种批准或独立证据平台。
7. H3 原件、其既有 create/inspect/SQL 来源、完整 AUTHORIZE 与引用链按既有私密 90 日规则保管/读回；不上传 public artifact。本次 context 不引用未来工具结果或父 close，未产生/读回失败不制造成功。缺失在交凭证前拒绝；实际 DB 比较失败在领域调用前拒绝；交付或执行是否发生不明保持原 UNKNOWN，不能降级 MS1。独立 archive reader 必须重新打开同 ref 的两份固定 H3 原件，核完整 bytes/RawRef 与实际投影，不能仅比较 AUTHORIZE 中自报的相同摘要或信任 writer 返回成功。

**H3-A 两原件的本轮最小封闭输入。** 复用 H1 已批准 owner 受控导入模型：先向用户展示含精确非秘密操作单的 canonical approval 原件并取得真实批准，owner 才按固定路径 CreateNew/独立重开；runtime 核固定来源/ACL/绑定，不自称能证明用户点击。两对象均 fatal UTF-8、canonical、完整文件不超过 1 MiB、递归 closed；D/T/S/RawRef/Report 沿 R1，Report 保留完整非秘密文本且与完整 JSON 共同计数，不能执行其中的 Shell/SQL。以下 recordVersion 只是现有两 H3 文件的局部判别值，不新增共享 Schema、签名域或 artifact kind：

```text
H3AApproval={recordVersion:"manual-h3-a-approval.v1",operationRef:UUID,
 indexDigest:D,runId:UUID,profileDigest:D,targetIntent:TargetIntent,ownerId:S,
 approvedAt:T,creationSpec:{databaseContainerName:S,dataVolumeName:S,
 postgresImageDigest:D,marker:S,endpoint:S,serverPort:integer1..65535},
 operationSheet:Report,promotionEligible:false}
H3AReadback={recordVersion:"manual-h3-a-readback.v1",operationRef:UUID,
 indexDigest:D,runId:UUID,profileDigest:D,targetIntent:TargetIntent,ownerId:S,
 approval:RawRef,databaseContainerName:S,endpoint:S,databaseOid:positive-decimal-string,
 cluster:ClusterOrigin,resourceObservedAt:T,sqlObservedAt:T,readbackAt:T,
 readbackReport:Report,promotionEligible:false}
```

operationSheet 保留既有 H3-A 精确角色/凭证引用/权限/TLS/暂停与退役边界，readbackReport 保留受批操作的非秘密命令/退出/实际读回来源；不得包含密码、完整连接串、Docker Env 或原始秘密输出。这两个文本不是任意执行入口，也不能替代 H3 段已要求的实际独立确认；新身份投影通过不表示四角色、权限、TLS 或 H3 全部通过。H3-B 仍使用自己的另批原件，不能以这两个 H3-A 对象提前证明它已完成。

两原件共同字段逐一等于当前 R1 index，ownerId 等于已核 H1 profile.ownerId；readback.approval 必须等于固定完整 approval bytes 的 RawRef。creationSpec.endpoint 等于固定 profile 对应目标端点，readback.endpoint 与之相同且由实际 Docker published 映射复核；readback.databaseContainerName 等于 creationSpec 同字段，cluster 的 dataVolumeName/postgresImageDigest/marker/serverPort 等于 creationSpec，同一实际 inspect 输出提供 databaseContainerId 和其容器名对应。cluster.systemIdentifier/serverAddress/serverPort 与 databaseOid 由受批 H3-A SQL 查询原件按同名列保存，不由名称、digest 或执行中 request 推断。approvedAt 不晚于 resourceObservedAt/sqlObservedAt，两个观察时间不晚于 readbackAt，全部不得晚于当次读取时间；不引入 session/attempt/未来 baseline/result 的字段或引用。

R2.2 对这两份完整固定输入执行上述私有 closed 解析及实际来源比对，H3 本身的人工审批/执行者/独立复核信任边界不变；拥有已批准 owner/宿主管理权限的人同时伪造全部源记录并不在纯 hash/ACL 可以证明防御的范围，不能作此安全声明。负向测试以受控导入的固定原件为锚，检查另一来源、替换、projection、实际资源或时间不符，不能仅将伪造 JSON 自校验称为来源测试。

R2.2 在 AUTHORIZE 前经既有 raw 保管路径把完整两个输入 bytes 写入 archiveRoot/raw/{rawDigestHex}.bin，独立重开并与固定 inputs 两原件逐字节相等后才交接。该副本是现有 raw blob，不另增 H3 文件命名、共享 kind 或 session 实现；同 digest 已存在只可读回核等，冲突/缺失/UNKNOWN 停止不覆盖。R1.2 原 archiveInput 才能从 raw 目录枚举到新增明确 RawRef；R2.3 同时重开固定 inputs 与 raw 副本，完整 bytes/大小/hash/projection 必须一致，不以 writer 成功响应替代读回。

### 2.2 本轮唯一归属与回归节点

| 内容                                                          | 唯一施工 owner                         | 不重复施工的消费者                                |
| ------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| MS2 closed payload、双流版本/ACK/archive 校验、cluster 纯函数 | R1.3H 的四文件单元，见 R1 计划         | R2 不修改共享模块/Schema/index 或重写 parser/hash |
| 实际 H3 固定原件、即时物理 readback、TargetContext 生成/运输  | R2.2 已列 launcher/entrypoint 及其测试 | H3 外部创建/权限仍人工另批，不增加 worker         |
| 同 context 的真实 SQL 观察与 handler 前比较                   | R2.1 已列 observer/adapter 及其测试    | 不修改 connector、runtime 或只读 guard            |
| archive 中 context 与固定 H3 原件的独立重新核对               | R2.3 已列 verifier 及其测试            | 不只相信 parent/child 已经返回成功                |
| 实际最终镜像/PG/H3 两场景验证                                 | R2.4，原 H1/H2/H3 停止点不变           | 纯内存/受控管道通过不冒称实测                     |

小修先跑相应 RED/GREEN 和负向组合并保留记录；R1.3H、R2.1、R2.2 各自收口节点跑该任务完整门禁，后续集成再集中跑跨任务回归。不得把延后全量记作通过，也不每修一个小问题重复长时间全套。

### 2.3 R2.2 私有输入补充范围（2026-09-26，DOC-ONLY 独立审查通过）

本节至 §2.6 只明确现有 R2.2 launcher/entrypoint 私有 IO 的输入，不增加生产文件、公开 export、共享 Schema/artifact kind、CLI 参数、Runner capability、签名域或自动 provision/grant。R2.2 仍只有其 Files 中八文件，R2.3 在原 verifier/test 中独立重读相同来源；R1 reader/build verifier/session bootstrap 与 MS2 parser/assessor 不复制。2026-09-25 真实 schedule 与 `3b20c1f7` 的最后 observation/ACK 快照 P1 说明及其门禁保持原样。

沿用 R1 的 `D/T/S/Report/RawRef/UUID/TargetIntent/ClusterOrigin`：RawRef 永远为完整实际 bytes 的 `{digest:D,bytes:I}`；T 必须是真实、可往返的 UTC 毫秒时间，I 为非负安全整数。以下另用 `OID` 表示正十进制字符串、`SHA` 表示 40 位 lowercase source SHA、`PID` 表示正安全整数；所有对象递归 closed，列出的字段全部必填，仅明确写 `null` 的位置可空。局部 `recordVersion` 只用于固定私有文件分流，不登记新通用契约。JSON fatal UTF-8 解码后须与 `encodeManualJson(value)` 逐字节相等，重复键、BOM、额外键、非法 Unicode 和完整 JSON 超 1 MiB 均拒绝；供应商/工具原始 stdout 不强制 canonical，但原 bytes 与严格解码后的 JSON 分别受既有上限约束。

固定私有文件都由已核 profile 派生绝对位置，不从 caller/环境变量/record 内路径选根；拒绝目录越界、symlink/reparse、硬链接、非普通文件、宽 ACL 或前后文件身份/大小/内容变化。沿 H1 已批准 owner 受控导入：CreateNew、完整读取、独立重开、所有父目录/文件 ACL 与实际身份前后核对；格式/摘要不证明人已批准或外部操作已发生。R2 只核固定来源及下述绑定，不能声称 hash/ACL 能防御已获 owner/宿主管理权限者同时伪造全部人工源记录。读取现有非秘密 raw 仅走 `archiveRoot/raw/{digestHex}.bin` 或本节指定 input 子目录，digestHex 只能来自已验闭合 RawRef；不递归扫描、不从正文发现 URL/路径执行操作。

### 2.4 独立 expected-schema 的固定私有输入

**来源与先后。** 消费已审 [Task 10 预备方案 Task 3](./2026-09-25-stage1-trusted-build-input-preparation-plan.md#task-3-independent-expected-schema-production-and-fixed-input-admission) 的未来 producer/两次独立 reference DB 及私密 custody。先实际调用 R1 `verifyManualBuild({repoRoot,proofBytes,materialBytes})` 成功并锁定返回的 `proofRawDigest/buildProofDigest` 和同一 proof bytes，才解析该已核 proof 的 `identity.sourceSha` 与 `provenance.ciRunRef`。后者必须为同一成功 run 的精确 HTTPS URL；R1 已核该 run 的 attempt 1/成功结论，不从 caller 提供 run/source/verified JSON。当前 producer、CI/私密原件尚未实现或未提供时保持 `MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED`，不从 H3 target script/catalog 或 fixture 反填期望。

固定目录为 `profile.storage.archiveRoot/inputs/expected-schema/{proofRawHex}/`，其中 proofRawHex 仅取 R1 返回 digest 去前缀。仅以下四个数据文件与一个导入读回文件；没有 latest/current 别名、命令行路径或另一个 expected digest 输入：

| 固定相对名              | 完整 bytes 与用途                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `provenance.json`       | 下述 ExpectedProvenance 的 canonical producer 原件；单独 raw-subject attestation                                          |
| `expected.sql`          | reference DB 的精确 Prisma script stdout Buffer；无 trim/换行转换；单独 raw-subject attestation                           |
| `schema.prisma`         | 同 attested checkout 的 `apps/api/prisma/schema.prisma` 原 bytes；不是另一个 schema 路径                                  |
| `prisma-version.stdout` | 完整 `prisma --version` 原 stdout，严格解码后只在 Report 边界 trim                                                        |
| `import-readback.json`  | 下述 ExpectedImport，批准的 Task 10 私密 Get/Head/ACL/保留期与 owner 导入/重开事实；不是替代 attestation 的 verified 标志 |

其余 finite RawRef（reference 创建/迁移/读回原件、catalog、argv/stdout/stderr、配置/lock 原 bytes、私密读回原件）只读该目录下 `raw/{digestHex}.bin`；四个固定数据文件与所有 RawRef 均重算 hash/大小。配置与 lock 还须等于已核 source checkout 中固定路径的实际 bytes。允许同一 raw 被多次引用，不允许缺 ref、未受 provenance/导入表覆盖的隐式输入或凭证内容。需要的实际 raw 未提供即 INPUT_REQUIRED。

```text
ExpectedProvenance={recordVersion:"manual-expected-schema-provenance.v1",
 buildProofDigest:D,proofRaw:RawRef,sourceSha:SHA,
 ci:{repository:"keqi119/subscription-Saas",workflowPath:".github/workflows/docker-images.yml",
     sourceRef:"refs/heads/main",runId:positive-decimal-string,runAttempt:1,
     runnerClass:"github-hosted"},
 sourceSchema:{path:"apps/api/prisma/schema.prisma",raw:RawRef},
 config:{path:"apps/api/prisma.config.ts",raw:RawRef},
 lockfile:{path:"pnpm-lock.yaml",raw:RawRef},migrationCatalogDigest:D,
 toolchain:{runnerImageDigest:D,postgresImageDigest:D,nodeVersion:Report,
            postgresqlVersion:Report,prismaVersion:Report,prismaVersionRaw:RawRef},
 expectedScript:RawRef,references:[ExpectedReference,ExpectedReference],
 generatedAt:T,promotionEligible:false}
ExpectedReference={referenceRunId:UUID,identity:{cluster:ExpectedReferenceOrigin,databaseName:S,databaseOid:OID},
 createdAt:T,readbackAt:T,creationEvidence:RawRef,readbackEvidence:RawRef,
 migrationCatalog:RawRef,migrationHead:S|null,migrationOwner:S,allowedExtensions:S[],
 calls:[ExpectedCall,ExpectedCall,ExpectedCall,ExpectedCall]}
ExpectedReferenceOrigin={systemIdentifier:positive-decimal-uint64-string,
 databaseContainerId:N,runnerImageDigest:D,postgresImageDigest:D,
 dataDirectory:S,socketDirectory:S,listenAddresses:"",configuredPort:5432}
ExpectedCall={tool:"prisma-version"|"prisma-deploy"|"prisma-diff"|"prisma-script",
 argv:RawRef,stdout:RawRef,stderr:RawRef,pid:PID,preparedAt:T,spawnedAt:T,closedAt:T,
 exitCode:0,signal:null}
ExpectedImport={recordVersion:"manual-expected-schema-import.v1",buildProofDigest:D,
 proofRawDigest:D,profileDigest:D,ownerId:S,importApprovalRef:S,importedAt:T,readbackAt:T,
 objects:{subject:RawRef,storeRef:S,writerIdentity:S,auditReaderIdentity:"audit-reader",
          storedAt:T,retainUntil:T,readbackAt:T,getEvidence:RawRef,
          headEvidence:RawRef,aclEvidence:RawRef}[],promotionEligible:false}
```

**2026-09-27 参考库接口实施对齐。** 上述 `ExpectedReferenceOrigin` 仅用于本节的独立参考库，替换此处原先误用的 H3 `ClusterOrigin`。已实现的参考库位于同候选 Runner 的只读、无网络容器内，使用两个固定 tmpfs 和私有 Unix socket，不能提供 H3 的专属卷或实际 TCP 地址。R1/H3 的类型、指纹、授权及所有共享 Schema 均不改；不得将该 reference origin 传给 `computeManualClusterFingerprint`，也不得填假卷名、marker、地址或 TLS 事实。

该 origin 的 `databaseContainerId` 来自本次真实 create/inspect；Runner digest 等于同 proof 的 platform digest，PG digest 等于同 proof 的固定 PG17.11 基础镜像。`systemIdentifier` 为实测 uint64，`dataDirectory/socketDirectory/listenAddresses/configuredPort` 来自 SQL 对 `data_directory/unix_socket_directories/listen_addresses/port` 的实际读回。路径必须落在本次固定 `/tmp/manual-schema-reference-` 临时根下，分别为 `data` 和 `socket`；端口 5432 是配置读回，不冒充 `inet_server_port()`。初始与最终身份一致，两个 referenceRunId/containerId 不同，两个 `(systemIdentifier,databaseOid)` tuple 及其与 H3 的 tuple 不同；不同 cluster 可有相同 databaseOid。

实际容器 user=postgres、network=none、只读根、无 host bind/持久卷、两个固定 tmpfs、镜像与 OCI revision 的 selective inspect 原件属于下述 creation/readback raw 图。只读取非秘密投影，不采集 Env 或凭据。四个 Prisma call 的 argv RawRef 明确是 canonical 完整字符串数组 `["/app/apps/release-runner/node_modules/.bin/prisma",...固定参数]`；version 在 CREATE DATABASE 完成后执行，最终身份/迁移读回在 script close 后执行，diff 除 exit 0 外须原 stdout 严格解码后 trim 为空。PID 与 prepared/spawn/close 时间来自真实 spawn 事件，禁止事后回填时间或重建 stdout/stderr。

creationEvidence/readbackEvidence 使用两个仅本 producer/consumer 私有的闭合收集对象，不登记共享契约：

```text
ReferenceEvidence={recordVersion:"manual-expected-reference-creation.v1"|"manual-expected-reference-readback.v1",
 referenceRunId:UUID,calls:ReferenceProcess[]}
ReferenceProcess={tool:S,argv:RawRef,stdout:RawRef,stderr:RawRef,pid:PID,
 preparedAt:T,spawnedAt:T,closedAt:T,exitCode:0,signal:null}
```

creation 的 tool 恰依序为 `container-create/container-inspect/image-inspect/node-version/psql-version/initdb/pg-start/database-create/identity-before`；readback 恰依序为 `identity-after/migration-readback/pg-stop/container-exit-inspect/container-stop/container-remove`。每项保留实际完整 invocation 数组和原 stdout/stderr；各 invocation 在 producer 固定，不从记录执行命令。native JSON 原文不强制 canonical，但其解析结果须符合对应固定 SQL/inspect 投影，原件不被重新序列化替换。source/config/lock/proof 使用已核宿主 checkout 的完整 bytes；两次参考调用的完整 version/script bytes 须相等。migrationCatalog raw 是从已逐条校验实际迁移名、路径、顺序和 checksum 的事实形成的 canonical catalog identity，其 digest 与 proof 一致；实际 migration SQL 原文另由 migration-readback 保留。migrationOwner 取实际 `_prisma_migrations` relation owner，不用 public schema owner 替代。

raw 取回保持每个原件和每个完整 canonical JSON 至多 1 MiB。实际 schema 已达 462831 bytes、lock 为 274737 bytes，不能把全部原件塞入同一个 base64 JSON，也不提高限制。相同两容器的固定 `--reference` 模式接收一份 canonical envelope 加 LF；参考 PG 停止成功后，将有限闭合原件 CreateNew 写入固定 `/tmp/manual-expected-schema-output/{digestHex}.bin`，输出一个只有元数据/RawRefs 的 canonical manifest 加 LF。源码/配置/lock/proof 不在此重复传输。容器仅在固定期限内等待精确 `RELEASE\n`；未知输入、额外帧、提前 EOF、超时均拒绝。

宿主保持这条实际管道，在 inner 仍运行时按闭合集合逐对象执行固定 Docker cp，从精确 container ID 和上述固定路径取至 owner-only 临时目录；拒绝非普通文件、软/硬链接、路径或 size/hash 不符，并独立重开原件。全部取回后才发送 release/结束 stdin，等待真实 close 及容器 exited/exit 0，随后原有 finally 对精确 ID 分别 stop 和 forced rm；任一不确定不返回成功。不能在容器停止后才取 tmpfs 原件，[Docker tmpfs 文档](https://docs.docker.com/engine/storage/tmpfs/)明确停止后不保留数据。该握手只用于固定输出生命周期，不提供存储、签名或准入权威，不增加通用协议、CLI 选择项、容器、持久卷、TCP 或 host mount。

后续实现仍仅修改既有 `manual-expected-schema-producer.mjs` 及其 test：输出精确 ExpectedProvenance、完整 version 与去重 raw 集合，保留现有 expectation 和清理修复。复用既有四例，仅补真实格式/PID/raw、时序、非空 diff 和实际大小传输反例；此处不要求重复业务或完整发布套件。私有存储、import、两 subject attestation、R2 固定 reader 和真实参考运行仍分别待完成；文档对齐不等于验收通过。

上述是 producer 与 consumer 的精确接口约束，未来 Task 10 producer 在自身已列文件中产出；R2 不实现 producer。`references` 恰为两次独立 fresh reference DB 的实际创建/读取，referenceRunId 与 `(systemIdentifier,databaseOid)` 各自不同；与本次 H3 目标的实际物理 tuple 也不得相同。每轮 calls 恰依序为版本、deploy、零 diff、script，argv raw 为 canonical 字符串数组，与固定 `/app`、现有 Prisma 7.8 config/schema/CLI 路径和 Task 10 四命令逐项相等；不执行 provenance 内的 argv/SQL。每个实际 call 满足 `createdAt <= preparedAt <= spawnedAt <= closedAt <= readbackAt <= generatedAt`；PID/close/raw 必须齐全，diff stdout.trim 为空。两轮 script stdout 等于同一 expected.sql 原 bytes；版本 stdout 等于同一完整 version 原件，其 Report 与 toolchain.prismaVersion 完全相等。Node22、Prisma7.8.0、PG17.11 与 pinned Runner/PG 镜像来自同次 producer 实测/读回；runner digest 等于已核 proof 的 Runner platform digest。两轮 migration catalog 的稳定 path/order/checksum/head/owner/extensions 相同且 catalog identity digest 等于 proof；UUID/OID/创建时间等非确定性原件保留各自真实值，不按字节相等压成一轮。

ExpectedImport.objects 精确覆盖 provenance 本身及其可达 raw 集合（重复 digest 只一项），不包含 import 文件自身；按 subject.digest 排序且无重复。其 getEvidence/headEvidence/aclEvidence 是批准 Task 10 私密服务的非秘密原始读回，不是本地文件 copy 成功、Actions metadata 或 writer 自报。独立 audit-reader Get 的实际 bytes 等于 subject，Head 大小/digest/实际保留期与 ACL 对应同对象，writer 与 audit reader 分离；有效保留期覆盖既定 90 日审查区间，不使用现在加 90 日代替原起算事件。Task 10 独立读取/批准来源不能核实就拒绝；R2 不新增私密存储 client、重签 custody receipt 或将此本地导入表当新的存储权威。所有 importedAt/readbackAt/对象时间不在未来，且 `storedAt <= readbackAt <= importedAt <= ExpectedImport.readbackAt`；owner/profile/build 必须等于 H1/R1 已核值。

**两个新 subject 的唯一验真接缝。** 本次细化的 expected attestation 集合恰为 producer provenance 原 bytes 与 expected.sql 原 bytes 两项。Task 10 原概述中“record and both raw byte subjects”的宽措辞在本接口按此两项细化：schema 原 bytes 与完整 Prisma version 原 bytes 由已 attested provenance 的 RawRef 闭合，再与 R1 已核同 checkout schema/config/lock bytes逐字节比对；不无故要求第三份 schema attestation，也不把 proof attestation 当 expected attestation。

R1 trust 内 `verifyAttestedInput/attestation` 当前为 private，无可调用 export。本轮允许仅在现有 R2.2 launcher 内为上述两个新 subject 实现固定 `gh` 验真 IO/局部检查，不复制 `verifyManualBuild`、proof/material/custody 验真、successfulRun、固定 operation reader 或 session bootstrap。对每一个由固定目录派生的 subjectFile，spawn `gh` 的精确 argv 为：

```text
["attestation","verify",subjectFile,"--repo","keqi119/subscription-Saas",
 "--signer-workflow","keqi119/subscription-Saas/.github/workflows/docker-images.yml",
 "--source-ref","refs/heads/main","--source-digest",verifiedSourceSha,
 "--cert-oidc-issuer","https://token.actions.githubusercontent.com",
 "--deny-self-hosted-runners","--format","json"]
```

subjectFile/verifiedSourceSha 仅来自固定 IO 与已成功 R1 的同一 proof，不是新增 CLI 参数。使用固定 github.com、禁交互且无 `GH_REPO/GH_HOST` 覆盖的受控进程环境、`shell:false`；退出非 0、signal/timeout、超限、非 UTF-8 或非 JSON 即拒绝。保存实际 gh stdout/stderr/close 的非秘密原件到现有 raw 保管路径，拒绝 caller“已验证 JSON”、fixture 文件替代真实 spawn、旧 launch-envelope verifier、bundle_url 下载地址或混用两个 result 的证书/statement。每份实际 stdout 必须为单元素结果数组，该项具有：

- 精确 issuer、repository URI、workflow/main signer SAN/buildSignerURI/buildConfigURI，所有 source/build signer/config digest 等于已核 source，runnerEnvironment 为 github-hosted；
- `runInvocationURI` 恰为已核 proof.ciRunRef 加 `/attempts/1`；两 subject 都属于该相同已成功 run/attempt，不能仅同 source 或同 workflow；
- statement 的 `_type` 为 `https://in-toto.io/Statement/v1`，subject 恰一个且 sha256 为当前完整 subject raw digest；
- verifiedTimestamps 非空，每个真实 timestamp 不早于 provenance.generatedAt、不晚于实际验真时间；bundle 的 dsse payloadType 为 `application/vnd.in-toto+json`，严格 base64 解码 payload 与该项 verified statement 的 canonical JSON 全等；
- 私有 attestationRef 仅取该已验证 bundle 的 `sha256Canonical`；原 stdout 与 bundle/statement 对应关系及两个 subject 的不同 digest 均保留，不能用 provenance 的自报引用代替。

两次 gh 前后都重核固定 inputs/同 proof/source bytes、路径身份与 ACL，独立重开 subject 后再比较精确 bytes；验证完成后、request freeze 前再核。成功才从实际 sourceSchema/version/script 构造既有 `schema-expectation`、调用共享 validator、将完整 JSON 与 sourceSchema/script raw 及有关非秘密 raw 按既有保管路径独立读回，使 `raws.has(sourceSchemaDigest)` 成立。任何 missing/mismatch 都在 runner request freeze/sign、命令 credential read、命令 DB connect 前拒绝，三类计数为 0；target-observe/session-open 的既定边界不改。

**历史原件的确定性定位。** 两次实际 gh 调用与已保存 expectation 的非秘密读回，在同 expected 目录下固定为 `admissions/{operationRef}/{attemptId}.json`，只由已有 R1 fixed index 和该 runner-command attempt allocation 派生，不能传路径、枚举 latest 或先造 request 来定位。它不是另一个外部 input selector；R2.2 在所有原件已保管/重开后、request freeze 前 CreateNew 并独立重开，失败时只保留真实 partial raw，不补成功 sidecar。其 closed 私有形状为：

```text
ExpectedAdmission={recordVersion:"manual-expected-schema-readback.v1",
 operationRef:UUID,indexDigest:D,runId:UUID,profileDigest:D,
 attemptId:UUID,attemptAllocationDigest:D,buildProofDigest:D,proofRawDigest:D,
 provenance:RawRef,sourceSchema:RawRef,prismaVersion:RawRef,script:RawRef,
 schemaExpectation:RawRef,calls:[AttestationCall,AttestationCall],recordedAt:T,
 promotionEligible:false}
AttestationCall={subject:RawRef,argv:RawRef,stdout:RawRef,stderr:RawRef,pid:PID,
 startedAt:T,closedAt:T,exitCode:0,signal:null,bundleDigest:D}
```

calls 恰按 provenance、expected.sql 顺序，subject 与固定 bytes 等式一致；argv 是上文固定数组的 canonical raw，stdout/stderr 是本次实际 process 的完整原 bytes，bundleDigest 由对应 stdout 已核 bundle 计算。两 call 的时间与实际非并行调用相符且均不晚于 recordedAt，所有 RawRef 指现有 raw 保管目录并核完整 bytes；schemaExpectation 指既有共享类型，不在 sidecar 重定义。跨 allocation/ref/run/proof、漏 call、改 raw 或 writer 未读回均拒绝。sidecar **只解决历史原件定位，不是当前密码学验真权威**，里面没有 `verified` 字段；真实 gh 原输出、self-reported exit 0、原件 digest 或一份 canonical sidecar 均不能独自放行。

**R2.3 独立只读验真。** 在其原有 `scripts/release/verify-manual-runner-result.mjs` 和对应 test 内明确允许固定 gh 子进程及验 attestation 所需的 GitHub 只读网络读取；不扩文件/export/命令选择。它先实际消费 R1 `verifyManualBuild` 的当前成功结果及同 proof bytes，重开上述 fixed inputs、既有 raw 和 allocation 精确定位的 sidecar，独立核 bytes/digest/来源/历史调用闭合；随后**独立重新执行上文两个 subject 的固定 gh 验真**，使用已核 source/ciRunRef 并执行同一 issuer/repo/workflow/main/hosted/run-attempt/单 subject/bundle↔statement/时间政策，前后 ACL/bytes 再核，全部通过才调用共享 assessor。历史 gh 输出仅保留为历史证据，不据其 JSON 或 exit 字段宣称当前验真，也不以 fresh gh 成功覆盖缺失/被改的历史。

**被评估请求与原件图必须是同一 expectation。** R2.3 独立重开 sidecar.schemaExpectation 的完整 canonical bytes，交共享 validator 并核 RawRef 大小/digest，要求 `sidecar.schemaExpectation.digest === request.expectedSchemaEvidenceDigest`，且 request 图中该 digest 的完整 bytes 与重开 bytes 相等。不能只证明 sidecar 与 graph 各自合法。令该同一对象为 E、当前重新 attested 的 provenance 为 P：`E.buildProofDigest === P.buildProofDigest === sidecar.buildProofDigest === request.buildProofDigest === R1 已核 buildProofDigest`；`E.sourceSchemaDigest === P.sourceSchema.raw.digest === sidecar.sourceSchema.digest`，对应 RawRef/完整 bytes 同时核等且等于 R1 已核同 checkout schema bytes；`E.prismaVersion === P.toolchain.prismaVersion === strictDecode(versionRaw).trim()`，其中 versionRaw 完整 RawRef/bytes 必须同时等于 P.toolchain.prismaVersionRaw、sidecar.prismaVersion 与固定 prisma-version.stdout；`E.script` 的完整 RawRef/bytes 等于 P.expectedScript、sidecar.script 与已单独 attested 的固定 expected.sql，且 `E.script.digest === request.domainInput.expectedSchemaDigest`；`E.sourceSchemaPath === P.sourceSchema.path === "apps/api/prisma/schema.prisma"`。这五字段逐项闭合后才交共享 assessor；不增加字段/export，也不借共享图内部相等替代固定来源与当前密码学验真。

此 R2.3 接缝只验两个新 expected subjects，不复制 build/custody/session bootstrap、不调用 launcher；不创建 session、签发、读取 credential/key、连接 DB、启动 Runner 或写/覆盖 fixed inputs、admissions、journal。其当前固定 gh 网络读取也须处于对应获批只读窗口；gh 缺失、网络/认证不可用、输入变化或验真失败就拒绝，不能退回历史输出或 caller verified JSON。新鲜验证的必要 process 输出由现有执行证据保管流程保留，不另建成功记录平台。

### 2.5 H3-B 固定批准与独立读回的封闭字段

仍仅使用 §2.1 同一 operation 目录的 `h3-b-approval.json`、`h3-b-readback.json`；不新增 H3 文件名、输入参数或共享 TargetContext 字段。先由真实用户批准完整非秘密操作单，owner 才 CreateNew approval；人工独立操作及撤权/退出/读回完成后才 CreateNew readback。两者与 H3-A 一样以完整 RawRef 入现有 raw 目录并重开；R2.2/R2.3 既重开 fixed inputs 也核 raw bytes，不凭文件存在、签名样例或字段为 true 放行。

```text
H3BApproval={recordVersion:"manual-h3-b-approval.v1",operationRef:UUID,indexDigest:D,
 runId:UUID,profileDigest:D,targetIntent:TargetIntent,ownerId:S,
 h3AApproval:RawRef,h3AReadback:RawRef,approvedAt:T,expiresAt:T,
 branch:"normal-success"|"apply-unknown-recovery",migration:MigrationBasis,
 preApprovalEvidence:RawRef,investigationApprovalRef:S|null,
 target:{cluster:ClusterOrigin,databaseName:S,databaseOid:OID},
 migrationTable:{schema:"public",name:"_prisma_migrations",oid:OID,owner:RoleIdentity},
 roles:{provision:RoleIdentity,migrate:RoleIdentity,verify:RoleIdentity,observer:RoleIdentity},
 grant:{privileges:["SELECT"],grantees:["verify","observer"],grantOption:false},
 operationSheet:Report,promotionEligible:false}
MigrationBasis={operationId:UUID,idempotencyKey:S,attemptId:UUID,
 allocationDigest:D,requestDigest:D,approvedPlanDigest:D,
 processEvidenceDigest:D,resultDigest:D|null,executionRecordDigest:D}
RoleIdentity={name:S,oid:OID}
H3BReadback={recordVersion:"manual-h3-b-readback.v1",operationRef:UUID,indexDigest:D,
 runId:UUID,profileDigest:D,targetIntent:TargetIntent,ownerId:S,approval:RawRef,
 migration:MigrationBasis,target:{cluster:ClusterOrigin,databaseName:S,databaseOid:OID},
 migrationTable:{schema:"public",name:"_prisma_migrations",oid:OID,owner:RoleIdentity},
 writerQuiescence:{observedAt:T,containerId:hex64,containerState:"exited",
                  processEvidence:RawRef,databaseSessions:0,sessionReadback:RawRef},
 before:PermissionReadback,grantStartedAt:T,grantCompletedAt:T,grantEvidence:RawRef,
 after:PermissionReadback,provisionExit:ProvisionExit,readbackAt:T,
 readbackReport:Report,promotionEligible:false}
PermissionReadback={observedAt:T,source:RawRef,roles:[ReadonlyRoleFacts,ReadonlyRoleFacts]}
ReadonlyRoleFacts={kind:"verify"|"observer",identity:RoleIdentity,tls:true,
 superuser:false,createdb:false,createrole:false,replication:false,bypassrls:false,
 memberships:[],ownedSchemas:[],ownedRelations:[],
 databasePrivileges:{connect:true,create:false,temporary:false},
 publicSchemaPrivileges:{usage:true,create:false},
 migrationTablePrivileges:{select:boolean,insert:false,update:false,delete:false,
                          truncate:false,references:false,trigger:false,maintain:false,
                          grantOptions:[],columnPrivileges:[]},
 pgControlSystem:{functionOid:OID,signature:"pg_catalog.pg_control_system()",execute:true},
 otherUserRelationPrivileges:[],privilegeInventory:RawRef,selectReadback:RawRef|null}
ProvisionExit={identity:RoleIdentity,revokedAt:T,canLogin:false,superuser:false,
 createdb:false,createrole:false,replication:false,bypassrls:false,memberships:[],
 process:{pid:PID,startedAt:T,closedAt:T,exitCode:0,signal:null},
 observedAt:T,activeSessions:0,credentialState:"SEALED_RETAINED"|"REMOVED",
 roleReadback:RawRef,sessionReadback:RawRef,processReadback:RawRef,
 credentialStateReadback:RawRef}
```

**共同绑定与实际来源。** Approval 的 operation/index/run/profile/target/owner 等于 R1 fixed index/H1；H3-A 两 RawRef 等于固定原件，target 等于 H3-A 的稳定物理身份且每次请求前仍由现有实际 inspect 核等。四 role name/OID 互异，migrate/verify/observer 的 name 等于 profile 精确 target.roles 对应值，provision 等于 H3-A 已批准操作单中的临时管理角色，不能新增 profile.provision。table OID/owner 是表实际产生后按真实 catalog 读取的值，owner 必须为该 migrate name/OID。preApprovalEvidence 包含当时真实 table/owner/角色/cluster 与原进程已退出的查询原件；它必须早于 approvedAt，不能将将来的 grant/readback 倒填进批准。

MigrationBasis 的每个 digest 必须打开既有 R1/R2 原件并核全件 hash、同 operation/key/attempt/run/build/target、phase=apply 及既定前序链；不是按字符串相等接受。normal 分支只来自 frozen scenario=normal 的实际 SUCCEEDED apply，resultDigest 必填，已完成内部自检且原 Runner/连接退出；`investigationApprovalRef=null`。unknown 分支只来自 frozen scenario=apply-interrupted 的该原 apply `INTERRUPTED_UNKNOWN` 历史，允许尚未产生的 result 为 null，但已有的实际 result 不能删除；`investigationApprovalRef` 必填并对应对该 UNKNOWN 的另批只读调查，preApprovalEvidence 是该调查的实际原件。调查确认原 writer/连接已停、表真实存在且 OID/owner/cluster 可确定后，才可能批准本次精确单表 SELECT 及撤权；不能借正常 H3-B 成功前置或 normal 的结果。未知 writer、错表/owner、缺实际调查许可或 table 不存在均保持阻断；H3-B 管理调查不将原 apply 改为成功，后续只能按原身份 readonly reconcile。

Readback.approval 等于完整固定 approval RawRef；其 migration/target/table 与批准逐项相同。before/after.roles 恰按 `[verify,observer]` 两项，before.select=false、before.selectReadback=null 表示 H3-A 的待表授权尚未完成，不执行预期失败 SELECT 来伪造证据；after.select=true 且 selectReadback 为各角色各自真实 TLS 连接完整读取 `_prisma_migrations` 的原件。`source/privilegeInventory` 保留 `pg_roles/pg_auth_members`、实际 owner、database/schema/table/column ACL 与 effective `has_*_privilege`、pg_control_system 函数 OID/EXECUTE、PUBLIC/继承影响及所有非系统用户关系的完整读回；“otherUserRelationPrivileges=[]” 表示此完整清单中无业务表权限，不是省略查询。table/column grant option、PUBLIC 宽授权、额外成员关系、业务表 SELECT、DDL/DML/TEMP 或所有权均拒绝。SQL/Report 只是批准人工原件，不成为 Runner 任意 SQL 执行入口；R2 不安装权限、不发 grant、不自动用 provision 探测。

`writerQuiescence` 绑定原 apply 的实际 containerId/进程链，normal 要求原成功退出，unknown 允许实际终止的非零 exit/signal 但须有可核终态与数据库无原写者连接；不得把观察到 exit 的时间写回旧 UNKNOWN execution。人工 grant 的唯一范围为本表 SELECT 给两个精确角色，无全 schema/table、default privileges、grant option 或新函数授权；H3-A 所需固定函数权限必须此前已获批且读回，缺失回 H3 人工门槛。

provisionExit 证明独立人工进程完成本次撤销登录/管理权限并退出：复核其真实 role OID、`pg_roles/pg_auth_members` 和该角色活动会话为 0、准确 PID/退出原件，以及 §2.6 固定 provision 文件的实际状态。`SEALED_RETAINED` 只表示按批准 ACL 密封保留至精确退役，DB 登录已禁；`REMOVED` 只在该文件删除本身已获精确批准且实际 readback 缺失时使用，R2 从不删除。owner-only 文件本身不证明 DB 撤权，退出日志也不证明没有其他会话。

时间要求：`preApprovalEvidence 的实际观察/原 writer 停止 <= approvedAt < expiresAt <= profile.expiresAt`；`approvedAt <= before.observedAt <= grantStartedAt <= grantCompletedAt <= after.observedAt <= provisionExit.revokedAt <= process.closedAt <= provisionExit.observedAt <= readbackAt`，人工进程 startedAt 位于批准窗口内且不晚于 grantStartedAt；readbackAt 不晚于 expiresAt/本次读取时间。第二阶段 request 必须仍在批准窗口，过期不重写原件延长授权。after/provision 的独立读回可使用其明确批准的只读身份，不能由已退出 provision 自证；文件审批来源及原始命令/exit/权限读回还须人工独立复核。

第一 migration 阶段不要求未来 H3-B；第二 verification 阶段必须在 request freeze/sign 和 verify/migrate 能力凭证读取前具备两份完整 H3-B 原件并通过上述绑定。GRANT/撤权/退出/归档任一失败或 UNKNOWN，只保管真实 partial raw、停止，不发布成功 readback或自动再 grant；固定 approval/readback 不覆盖。已有 H3-B 之后若需改变范围或恢复，先另行明确审查恢复记录方案，不靠新 operationRef 或静默重写文件绕过原历史。

### 2.6 四角色私有文件、CREDENTIAL 字符串映射及测试矩阵

**固定位置与唯一 closed JSON。** 四个相对名为 `operations/{operationRef}/observer.json`、`operations/{operationRef}/migrate.json`、`operations/{operationRef}/verify.json`、`operations/{operationRef}/provision.json`，共同根只能是 H1 验真的 `profile.storage.credentialRoot`，operationRef 只能由 R1 fixed reader 确定。H3-A 人工操作单必须列这四个不同位置及实际角色，但文件 JSON 仅为 `{username:S,password:Secret}`，不含 role selector、capabilityProfile、URL、host/port/database/TLS、过期布尔值或其他字段。Secret 为非空、无 NUL、可按严格 UTF-8/canonical JSON 往返的字符串，不 trim/正规化/转义改值；文件与完整 wire frame/累计流分别遵守既有 1 MiB 上限，不能因内层小于上限忽略外层 JSON 转义膨胀。

| 场景                  | 谁可读哪个文件                                                                                                                         | connector 的唯一映射与限制                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 父方 target-observe   | 在该观察授权消费/读回及最后撤销检查后只读 observer.json                                                                                | username 必须等于 `target.roles.observer`；构造 `{username,password,capabilityProfile:"verify"}`。这只是 connector 的只读 profile，不把 observer 角色替换为 roles.verify；不发给 Runner |
| 已授权 runner-command | READY、R1 消费/handoff 读回、最后撤销检查和所有本阶段 fixed input 门槛通过后，只读 request.capability 对应 migrate.json 或 verify.json | username 必须等于 `target.roles[request.capability]`，childDecision 后子方从本次 request 派生 capabilityProfile；dry-run/apply/replay/reconcile 的既有 command/capability 映射不改      |
| 人工 H3-A/H3-B        | 仅其独立人工操作进程按批准读取 provision.json                                                                                          | 不是 Runner capability，不进入 connector/管道/测试；R2 永不打开、解析或尝试 provision 密码，H3-B 只读其非秘密文件状态证明                                                               |

父方先完成文件/目录 ACL、单链接普通文件、前后身份检查和严格 canonical closed 解析，再把**同一 canonical 两字段 JSON 的 UTF-8 文本**作为既有 `CREDENTIAL.credential:string` 发送。没有 URL、base64、内层 frame 或多凭证列表分支。子方只在本次唯一 CREDENTIAL frame、WireBinding、childDecision 及协议时序通过后，将该字符串严格编码/解析并以 `encodeManualJson` 对比原文本 bytes；校验两字段与精确预期 username，再构造深冻结 `{username,password,capabilityProfile:request.capability}` 交既有 `createPostgresConnector()` 和 `createDatabaseRuntimeAdapter()`。target 独立来自已授权 profile/H3，不能由 credential 改写；旧 runtime 自身在内存组装工具 DATABASE_URL，不扩大为 caller URL/env 覆盖。

**父/子连接地址的可达性。** 父 observer 的 connector target 为 `{hostname,port,databaseName:targetIntent.databaseName,tlsMode:"require"}`，hostname/port 只由当前已核 profile.endpoint 的明确 `host:port`（IPv6 为 `[address]:port`）解析；端口必须显式且在 1..65535，禁止 userinfo、路径、query、fragment、scheme 或环境覆盖。H1 尚无真实 profile 值，不能以测试中的 `db.invalid` 或 `127.0.0.1:5432` 填入。该 endpoint 是父机 published 连接意图，不直接带入 child。child 的 connector/runtime target 固定为 `{hostname:AUTHORIZE.targetContext.cluster.serverAddress,port:AUTHORIZE.targetContext.cluster.serverPort,databaseName:request.targetIntent.databaseName,tlsMode:"require"}`，仅在共享 MS2 绑定/profile/H3/childDecision 全通过后使用；父方必须已通过实际 Docker inspect 证明同 container/volume/image/marker 的 published endpoint 与这个内部 PG address/port 映射一致。授权后真实 SQL 再次核 system identifier、DB OID/name、内部 address/port、角色和 TLS，不能以连接建立代替身份核验。

H3-A 的既有 operationSheet/readbackReport 与实际资源原件须明确本次唯一专用 Docker 内部 network 的 name/ID/归属和 DB container 的唯一 attachment；父方在 create/start/inspect Runner 时只加入这一已批准 network，并即时核它与 DB attachment/内部 IP 对应。缺固定网络事实、多个无法消歧的地址、child loopback/published-port 误用、DNS/代理无法证明唯一映射时 STOP；不启 host-network、额外网络、socket 或 caller endpoint，不把本文变成创建网络/资源的批准。这只是 §2.1 既有实际映射的技术落地，不扩 TargetContext/profile/H3 JSON shape。

不调用旧 `createReadOnceCredentialReader()`：它的 finally unlink 语义既不适用于管道，也未获授权删除长期角色文件。父方一次 release 只读所需角色，子方一次 request 只交一个能力；跨阶段或合法后续只读连接可在新授权/撤销及 H3 门槛通过后重新读取同一受控角色文件，不能把“读一次”误写成整个生命周期只有一次连接。角色凭证保留至该目标精确退役或已批准撤销处置，R2 不自动 unlink/rename/归档凭证。密码不进入任何 raw/Report/错误/argv/URL日志或 credential digest；不记录 CREDENTIAL bytes/hash、完整 stdin 或双向 transcript。finally 关闭连接、移除引用、可控 Buffer 尽力清零，但 JS 字符串、第三方连接库和 OS 缓冲不能保证物理擦除，不作此声明。

**既有测试文件中的补充矩阵（先聚焦 RED→GREEN，再纳入原完整门禁）。** 下面的 fixed filesystem/OS/gh/数据库/管道 double 只证明真实 IO 代码的顺序及拒绝行为，不能成为 H1/H2/H3 或供应商事实。测试不得新增 production 路径/flag；R2.3 的重读测试在其既有 verifier.test 范围内，R2.2 八文件不扩大。

| 归属测试                                                           | 正例与必须拒绝的反例                                                                                                                                                                                                                                                                                          | 副作用/证据断言                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/release/launch-manual-stage1.test.mjs`：expected 来源     | 真实 R1 verifier 成功后同 proof/source/run、两独立 reference、两个实际 gh 调用输出及全部 raw/custody 读回闭合；缺任一文件/raw/第二复现、target-derived script、错源/schema/config/lock/catalog/tool版本、只有短 Prisma 报告、producer 未实现                                                                  | 缺来源时 runner request freeze/sign、命令 credential read、命令 DB connect 全 0，不要求未来 expected 阻断 target-observe                                                                                                                         |
| 同上：expected 验真                                                | 精确命令 argv/环境与单结果/单 subject；错 issuer/repo/workflow/main/source/hosted、同 source 不同 run/attempt、混合 bundle/statement、无效 base64/时间、caller verified JSON、旧 launch envelope                                                                                                              | 实际固定 gh 路径被调用且 exit/raw 保管；任一 mismatch 三类计数全 0；不借 proof attestation 省去两次新 subject 验真                                                                                                                               |
| 同上：私有文件来源                                                 | 固定路径 raw 重开；软/硬链接、reparse、ACL 变化、gh 期间替换、同 hash 不同固定来源、读后替换、missing custody、只用 writer Head、保留期不足、重复 JSON 键/非 canonical                                                                                                                                        | freeze/sign 前拒绝；真实原始失败保存，不能导入自报 success；无请求路径或 profile override                                                                                                                                                        |
| 同上：H3-B                                                         | normal 完整 SUCCEEDED apply 与 unknown 原 apply 两种独立链；缺 H3-B、跨 ref/scenario/attempt、借另一目标成功、伪表 OID/owner、未来时间、无调查批准、无 writer 终态、replay UNKNOWN 冒充 apply UNKNOWN                                                                                                         | migration 第一阶段不需未来 H3-B；第二阶段 freeze/sign/能力 credential read 为 0；未知历史不被局部成功覆盖                                                                                                                                        |
| 同上：权限/撤权                                                    | 两角色真实独立读表、无业务权限且 provision 退出；额外成员/PUBLIC/column grant、grant option、业务 SELECT/TEMP/owner、缺 function EXECUTE、grant 超时、provision 仍可登录/有会话/未退出、密码文件状态自报                                                                                                      | 不调用 grant/provision；不发第二阶段 AUTHORIZE/CREDENTIAL；不把私有 true/空数组当实时权限证明                                                                                                                                                    |
| 同上及 `apps/release-runner/test/manual-entrypoint.test.mjs`：凭证 | 四角色独立；observer 的 verify profile 与独立 username、migrate/verify 请求单次两字段 JSON 映射；错用户名/能力、附加 URL/target/capabilityProfile、两个 credential、provision 注入、非法 UTF-8/NUL/超限/外层膨胀                                                                                              | 未到消费/READY 门槛 credential read=0；子方解析失败 connector/handler/deploy=0；provision read/unlink 恒为 0；全错误/日志/raw 不含秘密或其摘要                                                                                                   |
| 同上：多阶段与中断                                                 | observer 关闭后迁移、另会话 verify/replay 或同原 apply reconcile 的合法重新读取；EOF/撤销/父死亡/文件变化                                                                                                                                                                                                     | 不删除长期角色文件；断管不声称事务回滚，保留原 UNKNOWN；每 request 单 credential、单 capability，不跨 attempt 复用 decision                                                                                                                      |
| 同上：父/子网络映射                                                | 同一获准 DB 的父 published 地址与 child 内部 address/port 分别传入实际 connector；child 被传父 loopback/宿主端口、错误 network ID/attachment/IP、额外网络、caller URL/env 覆盖                                                                                                                                | actual createClient 参数与 approved H3 映射一致；错误在对应连接前拒绝，连接后物理身份错则 handler/deploy=0；无创建网络或网络策略旁路                                                                                                             |
| `scripts/release/verify-manual-runner-result.test.mjs`：独立重读   | 重新打开同 fixed inputs 和 allocation 定位的 admission/raw/provenance/两个历史 gh 原件/H3-B 链；只替换副本、删 sourceSchema raw、缺 provision 退出、改权限/表OID/owner；同 build/同 allocation 的 sidecar 指另一合法 expectation，或 graph 引用不同 script/schema/version，五字段任一未与已 attested 来源闭合 | 不读 key/credential、不连接 DB、不打开 session、不调用 launcher；历史链不能缺件，sidecar.schemaExpectation.digest 与 request.expectedSchemaEvidenceDigest 严格相等且五字段/完整 raw 独立核等后，共享 graph/assessor 与真实固定来源同时通过才验收 |
| 同上：当前独立 expected 验真                                       | 用真实只读 IO 路径和离线 process transport double 验两个固定 gh 调用；历史 JSON 全部貌似成功但当前 subject/签名/issuer/run/bundle 校验失败、gh 不存在、认证/网络不可用                                                                                                                                        | expected-subject gh 恰 2 次（R1 自己的 build 验真调用另计）；失败时 assessor 成功返回 0，session/sign/credential/DB/Runner/输入或 journal 写入均 0；无历史 fallback，不新增外部参数                                                              |

- [ ] R2.2 owner 先在既有 launcher/entrypoint tests 为上述三类私有 IO 写聚焦 RED，记录具体缺实现断言；不手写“生产成功 JSON”让未实现来源先通过。
- [ ] 在现有两个 production 文件内最小实现私有读取/映射，复用所有现有 R1 codec/validator/reader，聚焦 GREEN 后运行原 R2.2 全门禁；现有动态 ACK/最终 observation 与真实 runtime 组合继续必跑。
- [ ] R2.3 owner 在原 verifier/tests 增加同源独立重开矩阵；R2.4 只有真实 H1/H2/expected/H3-A/B 全部输入和操作批准实际就绪才执行，missing 仍 INPUT_REQUIRED，不跳过或据离线 GREEN 宣称通过。

## Task R2.0：修正既有 Prisma 7.8 固定配置和参数

**历史交付：** 已由 `5a16ca8a` 实施；以下保留原任务范围/参数依据，不在此次 DOC-ONLY 回合重跑或重新提交，也不宣称真实外部门禁通过。

**Files:**

- Modify: `apps/release-runner/src/database-runtime-adapter.mjs`
- Modify/Test: `apps/release-runner/test/database-runtime-adapter.integration.test.mjs`
- Read/Test: `apps/release-runner/test/db-migrate-schema.integration.test.mjs`
- Read: `Dockerfile.runner`
- Read: `apps/api/prisma.config.ts`
- Read: `apps/api/prisma-env-policy.ts`
- Read: `packages/release-foundation/src/catalogs.mjs`
- Read: `release/contracts/repository-contract-files.v1.json`

**Interfaces:** 保持 `prismaMigrateDeployArgs({schema,repoRoot})`、`prismaSchemaDiffArgs({schema,repoRoot})` 和 `createDatabaseRuntimeAdapter(...)` 签名不变；script argv 私有函数仍不导出。只修三个参数数组，config 从固定 `repoRoot/apps/api/prisma.config.ts` 解析，不接收 caller config/工作目录覆盖，不改变锁/事务、凭证、错误分类或旧 handler 语义。runtime 已纳入 repository contract；修改将改变摘要，H2 必须基于新代码构建。

- [ ] **1. 写参数 RED。** 原测试的 deploy/diff 两数组增加固定 `--config`；经 `adapter.observeSchema()` 捕获 `--script` 调用，新增完整 script argv 断言，确保没有 `--schema`。使用跨平台 `path.resolve(repoRoot, ...)`；错误 schema 仍拒绝，凭证仍只在既有受控子进程环境中、不进入 argv。执行 `node --test apps/release-runner/test/database-runtime-adapter.integration.test.mjs`，记录实际缺 config/多 schema 的断言失败，不把 mock 子进程通过视为真实 Prisma 验证。
- [ ] **2. 最小 GREEN。** 保留 `assertSchemaPath`，由同一固定 repoRoot 生成 config；目标参数为：

```js
const config = path.resolve(repoRoot, "apps/api/prisma.config.ts");
// deploy: --schema 在此子命令合法；同时固定 datasource/migration config。
["migrate", "deploy", "--schema", schema, "--config", config];
// diff-to-schema: 不得增加独立 --schema。
[
  "migrate",
  "diff",
  "--from-config-datasource",
  "--to-schema",
  schema,
  "--exit-code",
  "--config",
  config
];
// 当前数据库的 script/digest：仍读取真实 datasource，不改成从 schema 生成。
["migrate", "diff", "--from-empty", "--to-config-datasource", "--script", "--config", config];
```

第三数组仍先执行现有固定 schema 路径校验，只是不再将该路径当非法 flag 传入。三处均无需依赖 shell cwd；保留 `STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV=1`。不更新 Prisma 版本、不改 config 文件或 Dockerfile。参数依据：[Prisma 7 migrate/diff](https://docs.prisma.io/docs/cli/v7/migrate/diff)。

- [ ] **3. 旧路径回归与精确提交。** 运行 `node --test apps/release-runner/test/database-runtime-adapter.integration.test.mjs apps/release-runner/test/db-migrate-schema.integration.test.mjs`，再运行默认 `pnpm --filter @subscription-saas/release-runner test`；`pnpm release:contracts:verify`。只有两文件可暂存；Prettier、unstaged/staged diff、独立审查后提交 `fix(runner): bind Prisma commands to fixed v7 config`。记录此时仍只是参数/适配器证据，真实 Linux `/app`、Prisma 7.8 和 datasource 连接留给 R2.4 最终镜像，不能提前声明工具实测完成。

## Task R2.1：人工请求、baseline 与 handler 映射

**前置：** R1.3 `aebbb6b0` 已通过；新增 R1.3H 必须先获批、实施、独立审查通过。其四文件只由 R1 施工，本任务不得提前补写 codec/hash、扩大现有八文件或修改 MS1 历史契约。

**Files:**

- Read（唯一创建/修改 owner 为 R1.1E）: `release/contracts/schemas/manual-runner-request.v1.schema.json`
- Read（唯一创建/修改 owner 为 R1.1E）: `release/contracts/schemas/manual-baseline-manifest.v1.schema.json`
- Read: `release/contracts/schemas/manual-runner-evidence.v1.schema.json`
- Read: `packages/release-foundation/src/manual-runner-evidence.mjs`
- Create: `apps/release-runner/src/manual-command-adapter.mjs`
- Create/Test: `apps/release-runner/test/manual-command-adapter.test.mjs`
- Create: `apps/release-runner/src/manual-target-observer.mjs`
- Create/Test: `apps/release-runner/test/manual-target-observer.test.mjs`
- Modify（本修订新增计划范围）: `apps/release-runner/src/commands/db-migrate-deploy.mjs`
- Modify/Test（本修订新增计划范围）: `apps/release-runner/test/db-migrate-schema.integration.test.mjs`
- Modify: `packages/release-foundation/src/catalogs.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: R1 `verifyManualHandoff/assertManualHandoffDecision`、R1.3H `computeManualClusterFingerprint`、R1.1E 唯一 request/manifest/evidence Schema 和两个纯函数；现有 `planMigration/applyMigration`、`verifySchema` 与 catalog/registry。父 decision 不得用于 command adapter。
- Produces: `buildManualBaseline({request,trustedBuildDecision,targetObservation,roleObservation,preState,authorizationDigest}):manifest`；`executeManualCommand({request,decision,baseline,database,runtime}):{result,observation}`，manifest/result 形状完全见 R1 §2.5。该任务只构造真实原件、不输出自报 committed boolean；父方/独立 reader 通过共享 assessor 推导结论，不构造旧 execution-proof。
- 2026-09-25 接口补全裁定：既有 verified build decision 和 Observation 均不携带 baseline 必填 purpose，因此 factory 显式接收已独立读回的完整 target-observe request；经共享校验确认 stage，并使全件 canonical digest 严格匹配 targetObservation.requestDigest，方可取 request.purpose。禁止裸 purpose、默认值或在 build decision 上伪造该字段；其余 target/build/role/catalog 绑定保持。adapter 的内部返回值为封闭 `{result,observation}`，两项各按共享 Schema 验证且 result.observationDigest 严格匹配同次 observation 全件；缺失 observation 依共享规则用 null，不伪造成功。该 bundle 不是新增共享 artifact/协议帧；R2.2 分别持久化并发送既有 OBSERVATION/RESULT，R2.3 仍独立重新验证。不新增 success/override/callback，不修改共享 Schema。这是原八文件内为后续消费者补齐真实输入/输出的实施裁定。
- Produces: `observeManualTarget({request,database,endpointPolicy,approvedClusterObservation}):Observation`（R1 §2.5 的完整 observation）；request 只提供经验证 A/requestDigest，physical/role/catalog 必须实际读取，不能复制授权作为观察。固定查询为 `SELECT system_identifier::text FROM pg_control_system()`、本连接 `host(inet_server_addr())/inet_server_port()`、database OID/name、current_user/TLS，再收集全部 catalog。`approvedClusterObservation` 精确指 R1 §2.5.5 的完整 TargetContext，来自 §2.1 固定父 IO 或已核对 MS2 AUTHORIZE；不是 caller `verified` 标记。用真实查询值替换其 cluster 内的 systemIdentifier/serverAddress/serverPort，调用同一 `computeManualClusterFingerprint`，同时独立核对实际 DB name/OID，再与批准 context 比较；只有 stage=runner-command 才另比较 request/baseline physical identity，target-observe 仅使用既有 A/target 绑定并在本次成功观察后形成 baseline。其余 container/volume/image/marker 只能作为已验证父 IO 的来源事实，不宣称 child 自行 inspect；角色/TLS 分开。endpointPolicy 来自固定 profile，不能由请求自报；baseline factory 的 preState 即 observation.catalog，不重造观察。
- `preState` 是共享 CatalogObservation，observer 在真实 `REPEATABLE READ READ ONLY` 中读取 `to_regclass`/真实迁移表 OID、**全部** migrationRows（含未完成/失败/回滚）、owner/inventory、extensions/version；固定查询不得采用旧 runtime 仅成功行过滤。只用现有 connector 的 `$transaction(callback)`，不传当前不支持的 Prisma transaction options；其 callback 首条为无插值常量 `SET TRANSACTION READ ONLY, ISOLATION LEVEL REPEATABLE READ`，随后在同一 tx 执行 `SHOW transaction_isolation` 和 `SHOW transaction_read_only`，分别读回 `repeatable read`/`on` 才读 catalog。`withReadOnlyTransaction` 只有 read only，不能冒称含 RR。保留完整 statementLog（包括 setter/SHOW），不清空或过滤，不修改 guard/connector/runtime。既有 readStatement 正则接受 `SET TRANSACTION READ ONLY` 前缀，但不证明能拒绝所有任意附加子句；正式 observer 仅此固定 SQL，不增加 caller SQL 入口。迁移表不存在与查询/权限失败严格分离，失败不得返回空前缀。完整 catalog 摘要不是 schemaScript digest。基线只取实际归档读回；子方各角色独立观察，跨角色 identity 不伪造。
- 完整 request 的顶层 ManualBinding 保持 R1.1 既有结构，target-observe 无 command/phase；fresh attemptId/runId/attemptAllocationDigest 与稳定 DomainInput 按共享契约。允许目标来自固定 profile，CLI 不覆盖 host/db。
- **最小 handler 接缝（新增两文件范围，唯一 owner R2.1）：** `planMigration(context, domainInput)` 不改签名/摘要；`applyMigration(context, approved, {executionIdentity} = {})` 新增可选第三参数，executionIdentity 精确 `{operationId:UUID,attemptId:UUID,runId:UUID}`，只供手工 adapter 从已验证完整请求复制。省略时继续读取原 approved.input 的三字段，旧两参数 handler/input/plan/proof 行为不变；提供时禁止 domainInput 内再放同名三字段，防止双重身份。post-state 身份只从有效 executionIdentity 取，其余 input/postconditions/锁内重算/Prisma 顺序不变。旧 `dbMigrateDeployHandler` 不启用此参数，command registry/v1 不改。

```js
// R2.1 手工分支的唯一领域调用映射；不是新 handler/plan 算法。
const input = request.domainInput;
const executionIdentity = {
  operationId: request.operationId,
  attemptId: request.attemptId,
  runId: request.runId
};
// dry-run: await planMigration(runtime, input)
// apply:
await applyMigration(
  runtime,
  { input, planDigest: request.approvedPlanDigest },
  { executionIdentity }
);
// verify/replay: await verifySchema(runtime, input)
// reconcile: 先独立收集全行 catalog，再尝试 verifySchema；抛错仍保管已真实获得的观察。
```

- **预期 Schema 输入硬门槛：** 签发 runner request 前固定输入读回核对共享 schema-expectation 的真实来源、同 build/source Schema、Prisma 输出格式与 raw script bytes。现有 runtime 的 datasource→script 仅是实际态，不是预期来源；当前没有确认合格生产原件，报 `MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED`，禁止 freeze runner request/sign/credential-read。不新建生成器、不将 catalog/profile/baseline digest 冒充 expectedSchemaDigest；来源决定仍需单独精确输入，离线测试只证明该 gate 拒绝/接受受控测试原件。
- **私有当前快照接缝：** R2.2 固定 entrypoint 在已验证 AUTHORIZE 后构造内部 `runtime.manualContext={endpointPolicy,approvedClusterObservation,processEvidence}`；前两项分别为镜像固定 profile 的目标项和本次 TargetContext，`processEvidence` 是 AUTHORIZE.process，随后只由实际已接收且通过共享 live 校验的 ACK.subject.process 更新为新的深冻结快照。OBSERVATION ACK 不替换 process；此属性不是 CLI/env 输入或成功 callback。R2.1 每次形成 observation/result 时取当时快照全件 canonical digest，不能等待未来父 close，也不能由调用方传裸 digest 替代原件。target-observe 仍 processEvidenceDigest=null。replay/reconcile 的 originalExecutionRecordDigest 直接取已验证 request.predecessorExecutionRecordDigest（共享 assessor 已要求其直接指原 apply）；不新建历史传输或重复成功判定。

- **进程收集分工：** R2.1 定义固定调用对应的证据需求并保存 handler 原返回/抛错、完整 observation 与 statements 快照；R2.2 在已有 runtime `runProcess` 注入点安装同文件私有的真实 spawn collector，先保管/ACK PREPARED 再 spawn，保存 Buffer/真实 PID/close/超时/超限，再返回旧 runtime 所需 `{exitCode,signal,stdout,stderr}`。必须在 `requireSuccess` 抛错之前保管全部已产生事实；旧 executeProcess 的解码字符串/statementLog 不是完整原始进程或外部 Prisma SQL 证据。生产不能从 CLI/env 选择替代 collector。

- [x] **1. 建立模块入口 RED。**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { executeManualCommand } from "../src/manual-command-adapter.mjs";

test("rejects fabricated approval before database access", async () => {
  let databaseCalls = 0;
  await assert.rejects(
    () =>
      executeManualCommand({
        request: { commandId: "db.migrate.deploy", commandVersion: "1", phase: "apply" },
        decision: { verified: true },
        database: {
          observeIdentity() {
            databaseCalls += 1;
          }
        }
      }),
    { code: "MANUAL_HANDOFF_UNTRUSTED" }
  );
  assert.equal(databaseCalls, 0);
});
```

`node --test apps/release-runner/test/manual-command-adapter.test.mjs` 首次预期缺模块；最小实现先调用 R1 `assertManualHandoffDecision`，然后补齐 Schema。

- [x] **2. 为身份/映射增加 RED。** `node --test apps/release-runner/test/manual-target-observer.test.mjs apps/release-runner/test/manual-command-adapter.test.mjs`：相同 DB name/OID 但不同 system identifier、相同 identifier 但非批准 Docker endpoint，拒绝 `MANUAL_CLUSTER_IDENTITY_MISMATCH`；同 Schema 错 DB、错误 role/OID/TLS、baseline 被修改、请求第三命令、组合 credentials、replay 缺前序记录、伪造云批准均拒绝。另测 parentDecision 冒充 childDecision、未消费/过期 receipt、旧 challenge 和改签名域。migration 与 verify 角色不同但 physical identity 相同的合法分支必须通过。runner-command 签发前按 R1 §2.5 的既有四字段算法计算 expected fingerprint，role 必须等于固定 profile `target.roles[request.capability]` 且与 H3 批准一致；target-observe 单独使用 `roles.observer`，不复用 capability 推导。只使用已读回 physical name/OID 和批准 role/TLS，不预连接 migrate/verify，不借 observer fingerprint。childDecision 后真实 `await observeIdentity()`（connect 返回尚无 fingerprint），逐字段/集群比较实际值；错 role/OID/TLS 在领域 handler/deploy 前拒绝，测试断言无预授权连接且 handler/deploy=0。
- [x] **2a. H3 实际值组合 RED → GREEN。** 在上述两个测试文件中，用真实 connector 加离线 createClient 返回固定 SQL 结果，再调用 observer/adapter：合法同 context、不同获准 migrate/verify 角色通过；只替换实际 systemIdentifier、serverAddress、内部端口或 DB OID/name，期望 `MANUAL_CLUSTER_IDENTITY_MISMATCH` 且 handler/deploy=0。context 身份篡改的纯帧校验由 R1.3H 覆盖，固定原件来源/实际 inspect 属 R2.2；本任务不声称 mock 证明 H3 来源。补齐同目标迁移后 catalog/head、合法 H3-B 权限发生变化仍能独立观测，不用 H3-A 旧 catalog 阻断 reconcile；原批准 plan/owner/expected-schema 的既有检查仍完整保留。命令：`node --test apps/release-runner/test/manual-target-observer.test.mjs apps/release-runner/test/manual-command-adapter.test.mjs`；必须先见反例失败再最小实现，不先改期望让 GREEN。

- [x] **3. 实现 observer 和封闭映射并 GREEN。** observer 查询缺权限/字段或 H3 原件缺失直接拒绝，不能退回只比较 DB OID 或改用超级凭证。本轮仅准入 H3 合成 fresh 集群，不推断其覆盖副本/远端数据库。只调用现有两个 command handler 的领域函数；固定命令版本必须存在于 JSON registry/handler map。manual 授权是新路径外层门禁，不通过把旧 approvalMode 改成 none 规避旧验证。`database/runtime` 注入只用于内部构造及测试，正式 CLI 不接收 adapter 路径。
- [x] **3a. preState/readback RED → GREEN。** 修改 H3 旧 head 不改变实时读取结果；缺 migration 表与无 SELECT 权限分别处理；篡改 preState、缺独立 readback 或首次 dry-run/apply 前新读取 owner/head 与所批准 baseline/plan 不同，必须拒绝，deploy 计数为 0；已完成迁移后的 verify/replay/reconcile 不将合法变化强行与旧空库 preState 相等，而按原计划/全部实际迁移行及共享谓词判定。增加“合法空前缀 → live preState 归档读回 → baseline → dry-run”的正向用例，避免基线使用尚未产生的命令结果。
- [x] **3b. 固定事务 SQL 组合 RED → GREEN。** 在已列 `manual-target-observer.test.mjs` / `manual-command-adapter.test.mjs` 中，用真实 createPostgresConnector（只注入离线 createClient）→ observer → 同一 database/runtime → 真实 verifySchema。断言首条精确 setter、同 tx 两个 SHOW 读回 `repeatable read`/`on`，setter 和全部 SHOW/查询保留在 statementLog 且经过真实 readonly guard 后合法链通过；错误 mode/read_write/read_committed 读回拒绝，UPDATE 仍被 guard 拒绝。不得清空/过滤日志以让测试通过，不声称前缀正则阻止所有额外子句，不修改 guard/connector/runtime 或新增文件。真实 PG 的两个 SHOW 读回留 R2.4。
- [x] **4. 增加 plan/identity/reconcile RED → GREEN。** 两个 fresh attempt/child envelope 的相同 domainInput 产生相同 plan，apply postState 的 attempt/run 必须取新的完整请求，旧两参数路径快照/错误码全部保持；合法身份前提下改变 domainInput/catalog/owner/预期 fingerprint 触发 PLAN_CHANGED_SINCE_APPROVAL，deploy=0；实际连接不匹配批准 expected 时先按身份拒绝，不等待 plan handler。共享 assessor 正反例覆盖完整已提交、完整未 dispatch 证明、部分迁移/失败行/DML可能/缺终态仍 UNKNOWN；不在 adapter 重写谓词。R2.1 验证已签发 request/decision 与领域输入 expectedSchemaDigest 等字段的精确绑定，拒绝缺字段、摘要不符及伪 decision；本 adapter 不持有完整 expected-schema 来源原件，不能仅凭 digest 宣称已校验来源。来源缺失或把实时 catalog/datasource 冒充预期导致签发/凭证/DB=0 的组合测试由 R2.2 固定输入 IO 在 runner request 签发前拥有；该跨任务硬门槛未实测前，不宣称完整 R2 接入通过。超出可选身份接缝的问题 STOP，不改事务/锁顺序。
- [x] **4a. Prisma 完整报告组合 RED → GREEN。** 由已列 `manual-command-adapter.test.mjs` 持有正例：读取本地已安装固定 Prisma 7.8.0 CLI 的实际 `--version` stdout，必须 >256 字符且多行；未来测试允许在受控空 cwd、白名单且无 DB 凭证环境调用该已安装 CLI，不安装/下载、不连接数据库，缺 CLI/版本不符即 STOP，不能换短 fixture。经真实 runtime.readToolVersions 返回映射（仅工具进程入口受控、DB 为离线客户端），再通过真实 planMigration/verifySchema 和共享 validator；完整报告原样进入 MigrationPlan/SchemaObservation 的 toolVersions.prisma 与对应 schema-expectation.prismaVersion。按 R1 §2.5 `rawBytes → 严格 UTF-8 解码 → 既有 trim → Report` 逐字相等，不抽取单个版本号、不裁剪/改生产 runtime 输出。R2.1 覆盖多行完整合法正例以及本层可达的短报告/完整 canonical JSON 超限拒绝。旧 runtime 的 runProcess 接口已是解码字符串且随后 trim，不能由此声称覆盖原始 Buffer 非法 UTF-8 或 raw 1 MiB 边界；这两类真实原字节组合拒绝由 R2.2 的固定 spawn collector 在严格解码/交 runtime 前拥有，R1 既有纯校验反例继续保留。含 JSON 转义后的完整 canonical JSON 与 raw bytes 两层既有 1 MiB 实际计数均不放宽。E 既有测试拥有纯 Report 类型/等式，本文件拥有真实 runtime 映射组合，不另增测试/fixture 文件；本 DOC-ONLY 回合不运行 CLI。
- **2026-09-25 真实工具调用组合前置：** R2.1真实runtime已证明非空apply遵循原handler顺序，实际为版本探测三组、diff/script两组、deploy一次；原共享MS2协议全串行PREPARED守卫及每tool恰一次的成功谓词与既有Promise.all不兼容。由R1独立owner在原evidence模块及既有evidence/session测试内限域修复，详情见R1计划前向schedule说明；R2不删调用、不缓存Schema事实、不改锁/事务、不复制成功谓词。MS2仅允许固定组内并行、全部前组已成功关闭后才跨组PREPARED；完整成功须逐次验证保管、版本全文一致及每轮schema/script，旧MS1保持。R1修复与这八文件集成至同源后，完整共享/旧handler/实际runtime组合门禁通过且独立审查，才可关闭R2.1；聚焦60项只是该门槛之前的适配器证据。

- **2026-09-25 实际 ACK 快照组合补漏：** 首轮适配器测试使用不变的 process 快照，工具轨迹测试又由共享 fixture 构造 observation，因此未覆盖实际适配器输出的最后 ACK 绑定。`observeManualTarget` 取得 catalog 后，dry-run 的版本探测及 apply/verify/replay/reconcile 的 Schema 工具会推进 process/ACK；原 adapter 返回的 observation 仍引用较早 process 和 observedAt，与既有 OBSERVATION live 规则不符。限定在本任务 `manual-command-adapter.mjs` 及其既有 test 中先建立动态 ACK/时钟的 RED：实际 runtime 调用经共享 live 校验推进快照，直接将 adapter 返回的 observation 交 OBSERVATION ACK 校验，不由 fixture 重造。最终 RETURNED/THREW 封装时，仅对已实际获得的非 null observation 形成新的不可变完成封套，取当时已验证 process 全件摘要与实际完成时间；保留 catalog/schema/identity/角色和合法 partial/postState 原值，再计算 result.observationDigest。runner 的 observedAt 表示本阶段 catalog 与 plan/schema 所需实际查询/工具的整体观察完成时刻，使用实际时钟，不取 ACK 时间或 max 拼造；target-observe 仍为其 SQL 完成时刻。该完成时间不宣称重查 catalog；不得重排 SQL、重读后清日志、修改共享时间/摘要谓词、制造 null 观察或引用未来 parent close。工具已推进后的失败路径同样验证。R2.2 collector 必须先让本次已开始的工具调用停止推进，再发送最终 observation，不能事后回填已发送原件。修复与同源完整回归、独立审查通过前 R2.1 保持开放。

- [x] **5. 注册、回归、提交。** 两个新测试与修改后的 `db-migrate-schema.integration.test.mjs`、只读回归 `database-runtime-adapter.integration.test.mjs` 及共享 evidence/kernel/state-machine 测试通过；两个新模块纳入 RELEASE_GATE_ENTRY_POINTS/manifest，原 handler 已纳管。`pnpm release:contracts:verify`，Files 中八个 Create/Modify 文件格式/unstaged/staged diff 与独立审查后由主控提交 `feat(runner): map manual requests to existing database commands`；四个共享 Read 文件不重复修改/暂存，Schema 变更退回 R1.1E owner。

2026-09-26 前向验收：R2.1 与独立 R1 MS2 调用兼容修复的本地范围完成。实际 source `ba57efea` 于9月25日完整八文件343/343、exit0；恢复后独立重算日志/14输入摘要、代码及原件终审ACCEPT，契约/发现和语法检查通过。见[本地组合验收](../../acceptance/2026-09-26-stage1-r21-offline-integration-validation.md)。339项旧轮未覆盖动态观察ACK缺陷，历史原件保留；默认lint/既有格式例外、Node24及离线double边界如实登记。R2.2/R2.3、expected来源/raw采集、真实Node22/H1/H2/H3与阶段1继续开放。

## Task R2.2：固定父启动方与零凭证 Runner 交接

**Files:**

- Create: `scripts/release/launch-manual-stage1.mjs`
- Create/Test: `scripts/release/launch-manual-stage1.test.mjs`
- Create: `apps/release-runner/src/manual-entrypoint.mjs`
- Create/Test: `apps/release-runner/test/manual-entrypoint.test.mjs`
- Modify: `apps/release-runner/src/cli.mjs`
- Modify/Test: `apps/release-runner/test/cli.test.mjs`
- Modify: `packages/release-foundation/src/catalogs.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: R1 `loadFixedManualProfile({repoRoot})`、`readFixedManualOperation({repoRoot,operationRef})`、`verifyManualBuild({proofBytes,materialBytes,repoRoot})`、`openTrustedManualSession({repoRoot,proofBytes,materialBytes,operationRef})`（reader 返回固定 bytes 后传入，session bootstrap 再独立核对同一 index/build、owner binding/ACL；不接收调用方私钥、owner 布尔值、target 或 proof/material 路径）、`verifyManualHandoff`，R1.1 的 `encodeManualJson`，以及 R1.1E/RP2 的 frame parser/validator 与 request validator/assessor；R2.1 request/adapter/observer，`createPostgresConnector()`、`createDatabaseRuntimeAdapter()`。R2 不实现固定 reader 或 build bootstrap；原有 input/output 是本次固定 Node 管道，不是 caller JSON/替代 IO 模块选择项。
- Produces: `launchManualStage1({operationRef}):manual record reference`，`runManualEntrypoint({input,output,environment}):result`。正式 CLI 唯一用法为 `node scripts/release/launch-manual-stage1.mjs --operation-ref <固定档案内非秘密记录ID>`；不接受绝对请求路径、profile/roots、raw credentials、JSON 证明结果或随意命令。
- `operationRef` 仅为上述 UUID；launcher 与 standalone verifier 每次都经 R1 reader 取得同一 frozen index，不接受 UUID/digest 二选一、latest/current 指针或任意输入路径。没有有效 index 或 H3-A approval/readback 时明确拒绝且不开启 session/attempt；expected-schema 原件只在 runner request 冻结/签发前另作硬门槛，不是 target-observe/session-open 的未来前置。
- Produces（同一现有 launcher 文件内、非 CLI metadata helper）: `prepareManualOperation({proofBytes,materialBytes,targetIntent,scenario}):Promise<{operationRef,indexDigest,promotionEligible:false}>`。它只在本次本地 metadata preparation 获单独批准后运行，且必须先调用 R1 `verifyManualBuild`；该 verifier 内部先经 `loadFixedManualProfile` 完成 H1 门禁，再完成 H2 proof/material/custody receipt 绑定并返回 `custodyReceiptRawDigest`，prepare 仅把此已验证 digest 随 R1 定义的其余字段冻结进 index。全部成功后才生成 fresh `operationRef/runId` 与三个 operationId 并写 index；prepare 不读取/验证 custody、不读取 signing key、不 open session。固定幂等键与两个批准 scenario 保持不变，不增加 command、capability、权限、export/parser/file 或任意故障 hook。
- Frozen `manual-operation-input.v1` 的唯一 closed shape 归 R1.3 定义；R2 producer 只提供其中已列的 build/profile/raw digest、target、purpose/scenario、ref/run 及 observe/migrate/verify identity，不加入 owner/session/attempt/DB OID、H3/readback/baseline/result 或未来字段。producer 以 CreateNew 写入固定 operation 目录，随后必须调用 R1 reader 独立读回并逐字节/摘要/消费字段核对，成功后才返回上述三键；write/readback 不确定时 metadata 完成状态按 unknown 处理并 STOP，保留 create-only partial/reserved ref，不生成 execution/未定义日志，也不自动换 ref 重试或把 WIP 当成功。R1 reader 是唯一 validator，不在 R2 复制 index shape parser、record kind 或状态机。
- Produces（同文件非 CLI 导出阶段）: `connectAndObserveManualTarget({session,operationRef}):{observation,readbackDigest}`。observation 为 R1 §2.5 封闭 Observation。父方从固定索引及绑定其 digest 的真实 H3-A readback 取得精确目标意图，分配本次 attempt/归档请求后签发并消费 target-observe；检查 parentDecision/撤销后才读取固定 observer 凭证、连接并向 R2.1 observer 传已冻结 request。首次真实 observation 归档/独立读回后才生成原始 baseline；关闭连接并释放凭证。正式调用不接受既有连接/caller preState/decision，尚未通过本阶段不得冻结 baseline/启动 Runner；后续 invocation 只消费该 baseline，不得重建。
- **2026-09-25 跨任务验收归属：** R2.2 固定父输入 IO 必须在 runner request 冻结/签发、命令凭证读取或命令 DB 连接之前，独立读回并验证真实 expected-schema 来源、build/source 及原始 script/Prisma 报告；缺来源、用实时 catalog/datasource 冒充预期均须以组合测试证明这三类副作用为 0。target-observe/session-open 的既有阶段边界保持。R2.2 固定 spawn collector 持有原始 Buffer，必须保存事实后验证 raw 上限及严格 UTF-8，再交旧 runtime 所需字符串；非法 UTF-8、raw 超 1 MiB 与完整 canonical JSON 超限的组合拒绝不得以 R2.1 已解码字符串测试替代。R2.1 的完整报告真实映射和摘要绑定为前置，以上来源/字节门槛仍是完整 R2 通过的必要证据，不扩 R2.1 八文件或 manualContext。
- **唯一生产所有权：** 本任务的现有 launcher/entrypoint 两文件分别拥有 metadata producer、父方 allocation/完整请求 create-only 与子方 process collector，所有形状引用 R1，不新建额外 production 文件/共享 Schema/构造器。index/H3-A 在 open session 前固定读回；首次真实 observe 后产生 baseline，后续 invocation 只创建 fresh attempt，不重建 index/baseline 或改变原 ref/run/operation/key；readonly verify 可开新 session，但仍用同 ref/run、原 migrate identity/前序和 frozen verify identity。R1.2 既有全目标 journal/锁仍在凭证释放前跨 operationRef 检查同 target 的完整未决历史；换新 ref 不能绕过 UNKNOWN，R2 不增加 pre-open 历史检查或第二防重机制。allocation 先于签发/消费/DB；零凭证 Runner 启动先写并重开 requestDigest=null、同 attemptAllocationDigest/A 的 PREPARED，实际 spawn 后追加 SPAWNED。取得实际 child/challenge、冻结并读回 request 后，以 previousProcessEvidenceDigest 连接不可变 null 原件，新写 requestDigest=D 绑定快照并读回；既有事件/时间不改，此后禁止回 null/换 request。R1 sign 只生成授权 ID，不事后分配执行 attempt。每次工具调用在既有 runProcess 注入点用固定 spawn 参数数组，PREPARED 通过管道由父方持锁保管、重开并 ACK 后才 spawn；真实 SPAWNED/原始流/CLOSED 再 append，collector 保存输出后才允许旧 runtime 返回或抛错。parent 原件记录实际容器 create/start/inspect/challenge/exit 与非秘密协议时序，secret frame 不记录。R1.2/R2.3 各自独立重开最终 process 链；子方输出不能建立宿主存储成功事实。
- 凭证释放前因实际校验失败而终止的 DISPATCH_CLOSED 要记录本次控制流真实拒绝、最后 consumption/handoff 原件及管道/child 关闭，且没有 deploy PREPARED；该完整证据才可供共享谓词判未 dispatch。缺日志、PREPARED 后死亡、ACK/写入成败未知全部保留 UNKNOWN；不能以派生布尔值覆盖原件。原 attempt/request 丢失只保留已有 slot/session 并 STOP，不生成恢复 UUID。

- **MS2 的实际 IO 闭环。** 初始 parent runner PREPARED 在无 child 时只要求 create-only/独立重开，不能等不存在的 ACK；完整 CHALLENGE 到达后才冻结 request，AUTHORIZE/READY/最后撤销通过后发送唯一 CREDENTIAL。子方实际接收后发非秘密 CREDENTIAL_RECEIVED，再进入既有受控 connector/handler。子方工具 PREPARED 不含未来 process digest，父方追加其确切 event、保存原 raw/快照、独立重开并生成既有 archive-readback custody 后，才留存并发送携该原件/custody 的 ACK；child 用共享封闭规则核对 exact frame/A/allocation/request/tool/sequence/processSequence/快照/custody 后才 spawn。EVENT/CLOSED 用标准 base64 运输完整工具 raw stdout/stderr，在 requireSuccess 前保存；包装后的帧/整流超限仍停止，不改限额、不另开旁路。OBSERVATION 先保管/独立读回再 ACK。后续 stdout previousAck 证明 child 实际收 ACK，最后 DISPATCH_CLOSED ACK 由 ACK_RECEIVED 显式确认；父写响应或 custody 单独不证明接收，ACK 从不冒充 consumption-handoff。
- **完整输出与旧路径隔离。** R2.2 唯一写 manual framed stdout，`cli.mjs` manual 分支不得落入现有共用 `.then(result => JSON+LF)` 尾部重复写结果；旧分支字节行为仍一个 JSON+LF。旧 `scripts/release/trusted-launch-production-adapters.mjs` 的完整 stdout JSON.parse/stdin-ignore collector 不在 Files 内，不修改、不借用来解析 MS2 或历史 MS1，不做自动 fallback。父方保存从 CHALLENGE 至 EOF 的完整 stdout raw bytes/digest（含所有 header/payload），只以共享 parser 返回的唯一末尾 RESULT.payloadBytes 核归档原件；stderr 只作真实受限日志，不能提供 result。R2.1 原 result 保持 handler 生成时的快照引用，不添加/回填未来 parent close 或完整 stdout digest。子方 RESULT/唯一 result 都不证明父 close；真实最终 runner CLOSED/最终 process.protocol 与全部既有谓词仍必需。

- **当前 ACK 的 live-ack 接缝。** launcher 每次先通过 `loadFixedManualProfile({repoRoot})` 只读取得固定 `manual-stage1-profile.v2.json`，再以 `encodeManualJson(profile)` 取得唯一 canonical `profileBytes`；同一请求的父子 live 核验与最终 archive 核验必须传入字节相同的该 `profileBytes`，并逐次核对 `sha256Bytes(profileBytes) === request.profileDigest === authorization.payload.profileDigest`。双方均调用同一 `validateManualRunnerProtocol` 的 RP2 `LiveAckProtocolInput` 九键分支：`mode:"live-ack"`、`profileBytes`、实际 requestBytes/authorizationBytes/previousProcessBytes、当前 childFrameBytes/ackFrameBytes、截至当前待 ACK frame 的实际 stdoutPrefixBytes、此前非秘密 parentFrameBytes。父方在 subject/custody 真实持久化并独立重开后、发送前调用；child 在实际完整收到 ACK 后、spawn/继续前调用。不为找到当前 ACK 而伪造后继 process.parentFrames 或等待未来 result/close；live 返回 void 只证明当前字节关系，实际发送/收到与含秘密 stdin 完整计数仍由本任务固定 IO 承担。公开 parent 帧用共享私有单帧 decoder 逐个解析 0 号 AUTHORIZE、从 2 连续的 ACK，不能拼成完整 stdin 或补 CREDENTIAL。归档时使用四键 `ArchiveProtocolInput`：`{profileBytes,requestBytes,artifactBytes,rawBlobs}`；assessor/R2.3 只走 archive。DISPATCH_CLOSED 固定 runner/0 且 null argv，是原有终止事件例外，不需新 PREPARED，不改变真实 runner CLOSED 参数/退出核验。

- **H3 TargetContext 的实际映射。** 本任务 launcher 私有固定 IO 按 §2.1 生成 context；不得新增 CLI 导出/参数或把 R1 reader 扩成 H3 parser。entrypoint 从 MS2 AUTHORIZE 取得完整 context，经 R1.3H 共享校验后把镜像固定 endpointPolicy、同 context 和真实 ACK 快照交 R2.1，设置内部 manualContext；未完成输入/版本核对不调用 connector。保持 request/authorization/baseline/所有 v1/v2 Schema 字节语义，context 不塞入这些封闭对象或秘密帧。新请求任一方向遇 MS1 即 `MANUAL_FRAME_INVALID`，绝不自动 retry/fallback；archive 历史兼容不能变成 active 入口降级。一个 attempt 的双向帧、公开 AUTHORIZE/ACK、live 当前 ACK 及 process 快照始终同一流版本；历史按实际原 frame 版本而非 profile v1/v2 推断。空/截断早期流不降为“未执行”；同目标旧 MS1 UNKNOWN 仍由现有全历史检查阻断新 MS2，不能换 ref/profile/协议绕过。

- **launchContext 的实际映射。** launcher 在冻结request前把本次create/start所得完整containerId与同一容器inspect、已验真registry/platform镜像及OCI source真实读回对应，形成两字段非秘密launchContext；entrypoint不访问Docker socket、不依赖旧envelope/HOSTNAME/镜像自报digest，而将自己原先保留的nonce与当前私密父管道AUTHORIZE.launchContext组成既有ChildObservation。先核镜像内固定profile、context/request/authorization/receipt及nonce逐项相等，再调用既有verifyManualHandoff并发READY；父方还须将READY与其实际读回来源核对，之后才交凭证。固定父管道是原有可信IO边界，不新增INIT/序号/record/信任根，不把child视作自主inspect。实际父观察与公开AUTHORIZE/完整stdout仍保管并供R1.2/R2.3独立读回；纯live/archive相等或合法签名不能代替这些来源。

- [ ] **1. CLI 负向 RED。** 实际 Node 子进程调用新入口的 `--command`、`--entrypoint`、`--shell`、`--adapter`、`--profile-file`、`--archive-root`、未知 operation-ref；断言错误码且 spawn Docker/secret-read/DB 三计数为 0。已有无 envelope/多余 argv 负向测试保留。
- [ ] **1a. 固定 metadata producer RED → GREEN。** 在 `launch-manual-stage1.test.mjs` 用 synthetic key/mock gh 与临时固定 roots，先测 H1 sidecar/approval/actual host-principal/root ACL 任一失败以及 H2 proof/material/同-run custody receipt 缺失、替换或 digest/binding 不匹配、target/scenario 缺失或不匹配时 index-write/session/signing-key-read/H3/DB 均为 0；再断言合法 prepare 的 exact closed index 固定 R1 verifier 返回的 `custodyReceiptRawDigest`、三个 fresh operationId、上述 deterministic keys 与返回三键。覆盖第二次同 ref、partial write、独立 readback/ACL/path identity 失败：保留 reserved ref 并 STOP，不返回成功或另生 ref；篡改/增加未来字段由 R1 reader 拒绝。测试不使用真实 key、网络、Docker/DB，不自行加载/验证 custody、不复制 R1 parser，也不新增 export/file。
- [ ] **2. 实现固定解析并 GREEN。** 父方只设置常量 `RUNNER_EXECUTION_MODE=manual-stage1`，它是模式选择而非授权；与旧 `RUNNER_LAUNCH_ENVELOPE_FILE` 同时出现必须拒绝。不允许 Docker command/entrypoint override；旧分支原样保留。新分支没有 raw secret 文件/环境路径消费能力，等待受限管道授权。测试仅设置该模式仍不能读凭证或连接 DB。
- [ ] **2a. 目标预观察 RED → GREEN。** `node --test scripts/release/launch-manual-stage1.test.mjs`：伪造、过期、已撤销、错目标及未消费的 target-observe 授权均断言 secret-read/DB-connect 为 0。实现上述父方阶段，测试正确授权只取得 observer 凭证、不取得 migrate/verify/provision 凭证；观察写入或读回失败不启动 Runner。只读 observer 本身不是第三个 Runner 命令，不要求未来 container/challenge。
- [ ] **2a-H3. 固定原件到 child 的组合 RED → GREEN。** 仍只修改 launcher/entrypoint 两个已列测试文件，采用真实临时固定目录、R1 reader 和受控真实 Node 管道，仅把 Docker/DB 外部最底层观察换成离线 adapter；不运行真实资源。先构造完整 H3 来源的合法 MS2 通路，再分别改变：原件路径/ACL/文件 bytes、审批 ref/index/run/profile、实际 container/volume/PG digest/marker/端口映射、缺独立重开、H3 原件 closed/approval RawRef/时间顺序、inputs 有原件但 raw 副本缺失/错 bytes、AUTHORIZE context、已签 physical fingerprint，必须在各自界面拒绝。父来源失败、MS1 CHALLENGE/AUTHORIZE、混版本、context 缺失/超限时 credential-read/DB=0；实际 SQL 不匹配时 handler/deploy=0。只将合法 request fingerprint 抄为 observation 不能通过组合正例。另保留“同物理目标、不同角色/已迁移 catalog/合法 H3-B”正例，以及 AUTHORIZE 写出前 readback 变化和 ACK/断管 UNKNOWN。命令：`node --test scripts/release/launch-manual-stage1.test.mjs apps/release-runner/test/manual-entrypoint.test.mjs apps/release-runner/test/cli.test.mjs`；定向 RED/GREEN 后收口时统一全文件回归，不改共享 validator 来迁就 fixture。

- [ ] **2b. allocation/process 原件 RED → GREEN。** 两个既有新测试文件先覆盖 launcher 只接受 R1 reader 返回的同 ref/run/原三 operation identity，H3-A 缺失/错 indexDigest/profile/target/container/DB 或 databaseName 不在已批准 profile 时在 session/attempt 前 STOP；另 ref 的同目标未决历史由 R1.2 既有 journal/锁在凭证释放前 STOP。再覆盖 allocation 写/读回失败、request 缺 attempt、重复 attempt、消费后原身份丢失、PREPARED ACK 前调用、实际 spawn 失败/非0/超时/输出限额/非法UTF-8、只有stdout字符串没有raw Buffer、close丢失。再覆盖合法 null 启动→实际 challenge→D 绑定正例，以及缺 null 原件、错 allocation/A、null 分支提前 DB/工具/凭证、spawn 后补 PREPARED、D 绑定后回 null/换 digest、重写旧事件时间的反例；断言这些拒绝或证据缺失不会补 UUID/close/成功原件，每次 invocation 只新增 attempt、不重建 index/baseline，ACK 失败 deploy=0；在临时目录真实 Node 子进程采集 PID/原始 bytes/实际 close，正例证明完整事件链可被共享 assessor 消费。仅使用本任务固定测试辅助子进程，不访问 Docker/DB，不将该测试报为真实 Runner。
- [ ] **2c. MS2 收发/存储组合 RED → GREEN。** 在同一两个 R2.2 test 文件，用真实临时目录和受控 Node 双向管道，把共享 parser 与实际 collector/store/readback/ACK 串联；正例逐 byte split/多帧 coalesce（含跨 chunk UTF-8）、两次相同工具的不同 processSequence、完整多行 stdout/base64、observation/ACK、ACK_RECEIVED/唯一 RESULT/真实 close 通过。逐项注入 PREPARED 写失败、独立重开失败、仅写响应、ACK错event/tool/attempt/序号/subject/custody、ACK写出后child未收、工具raw缺失/非法UTF-8、包装或整流1MiB+1、截断/尾垃圾/duplicate或missing RESULT，断言未经有效ACK spawn=0、已可能执行且证据不足 UNKNOWN，绝不由缺SPAWNED推未执行。检查档案没有 CREDENTIAL/hash/完整stdin/双向transcript，仍能由非秘密帧和真实R1原件证明消费/交付/ACK控制流。`cli.test.mjs` 断言 manual 只输出MS2且无额外JSON/LF，旧模式仍单JSON+LF，无自动fallback。所有新增断言仅在既有 Files 测试内，本DOC-ONLY回合不运行。
- [ ] **2d. 当前 ACK live 组合 RED → GREEN。** 同一 R2.2 两测试文件在真实临时文件写入/重开后形成候选 ACK 并调用 live，child 只在实际收到后以同一九键（含固定 canonical `profileBytes`）形状再校验；两端合法 ACK 均在没有后继 SPAWNED/RESULT/close、当前 ACK 尚不在 process.parentFrames 时通过，之后才观察 spawn。只改候选/收到 ACK 的 frameRef、subject 前件/事件/工具序号、custody、stdout 前缀、`profileBytes` 或公开 parent 帧顺序均拒绝且 spawn=0；写入/重开失败不得以 live 字节合法替代真实 IO 前置，父 live 通过后断管仍不能推定 child 收到。archive/live 混形拒绝，公开 seq0/2/3 与零工具 DISPATCH_CLOSED/ACK 正例通过；不新增测试文件或第六导出。
- [ ] **3. challenge/父会话 RED。** 假 container ID、错误实际 Runner digest/OCI revision、旧 challenge、父退出、授权消费后取消、第二 credential frame、输入 1 MiB+1、credential 写入日志均拒绝。容器/challenge/签名绑定与预期 fingerprint 等式不匹配在读取 DB 凭证前失败；实际 DB role/OID/TLS 只能在 childDecision 后获准连接并 await observeIdentity() 才比较，错值必须在领域 handler/deploy 前失败。测试禁止为计算 expected 而提前连接 capability 角色，不篡改 baseline observer 的实际 identity。
- [ ] **3a. nonce/launchContext 来源 RED → GREEN。** 同一launcher/entrypoint测试用受控真实Node管道覆盖child在任何AUTHORIZE之前实际生成并保留32-byte随机nonce、首帧只发该键，父方从本次固定create/start/inspect/registry适配器读回构造context后再冻结request，child由自留nonce+受信context调用真实kernel。错context/nonce/缺键/额外键拒绝且READY/凭证/DB=0；仅将合法授权中的ID/image复制成context而没有实际父IO读回，即使纯等式一致也在父方冻结/签发/交凭证门禁拒绝。旧envelope、HOSTNAME、镜像自摘要或child自报ID不得作为context来源；无这些来源的正常手工管道仍可成功，证明不隐含旧入口依赖。测试仍使用本任务已列文件与受控adapter，不运行Docker/DB，也不把来源模拟报为真实inspect成功。
- [ ] **4. 实现单次交接并 GREEN。** 父方从 R1 trusted build 获取 Runner registry/platform digest，实际 registry/inspect 与 OCI source 一致；先将 R1 §2.5 严格 null 分支的零凭证 PREPARED 保管/重开，再启动固定镜像、内部网络、只读 rootfs/受控 tmpfs、无 Docker socket/privileged/host-network/额外挂载，argv 为空。收到实际 child challenge 后在同一 owner 会话生成并重开规范化 request，再新写并重开 request-bound 快照（原 null 事件前缀不变），才人工确认、签发、撤销重查及消费读回；按 R1 生成签名 consumption-handoff receipt 并独立保管读回，再重查撤销，仅以 stdin 交当前能力凭证。子进程复验固定 profile、原授权、receipt 的消费/readback 身份和 container/challenge/时效，取得 childDecision 后才构造真实 connector/runtime adapter，单次获准 connect 后必须 await observeIdentity() 再对照批准 expected 四字段及真实 physical cluster/endpoint；connect 返回时的未观测 fingerprint 不作比较依据。不传宿主 KeyObject、WeakSet 品牌或账本路径。签名 receipt 不是云 launch attestation。
- [ ] **5. 异常/取消 RED → GREEN。** 从 credential-read 前、DB connect 后、deploy 后/记录前分别注入断管；只有实际完整拒绝/关闭链能证明未 dispatch，任何不确定用 UNKNOWN。仅 apply 提交未知的恢复使用同原 operation/key/plan 与新 reconcile attempt；只读 query 失败不对原状态发 ATTEMPT_FAILED。另测 replay 完整成功与断管/丢结果/丢 close 对照：后者 create-only 记录 fresh replay INTERRUPTED_UNKNOWN（不可证结束为 null），原 apply 成功 checkpoint 不变，不向 REPLAYING 发 PROCESS_LOST 或 ATTEMPT_FAILED，不自动 reconcile；完整未决历史阻断后续签发/消费及再次 replay/apply，旧成功不能绕过 STOP。父方容器退出码/原 stderr/受限日志来自实际进程，不接收外部成功 JSON。验证“全部原迁移完成+原进程退出+完整排他历史”和“schema虽一致但未知写者/部分行”两个对照，后者保留 UNKNOWN；secret frame 不入档。
- [ ] **6. 提交门禁。** `node --test scripts/release/launch-manual-stage1.test.mjs apps/release-runner/test/manual-entrypoint.test.mjs apps/release-runner/test/cli.test.mjs`；契约纳管、Files 八文件格式/unstaged/staged 检查、独立审查后提交 `feat(runner): add closed foreground manual launch handoff`。

宿主 Docker 管理员本身可以绕过容器限制，本方案信任已批准 owner/宿主，不能声称容器能阻止其 `docker exec`。本入口必须拒绝这些参数并对实际容器 spec 读回，不把工具允许项当实际部署证据。

## Task R2.3：真实执行测试入口与计数，尚不运行外部目标

**Files:**

- Create: `scripts/release/verify-manual-runner-result.mjs`
- Create/Test: `scripts/release/verify-manual-runner-result.test.mjs`
- Create: `apps/release-runner/test/manual/manual-runner-migration-postgres.integration.test.mjs`
- Create: `apps/release-runner/test/manual/manual-runner-verification-postgres.integration.test.mjs`
- Modify: `release/contracts/database-test-exceptions.v1.json`
- Modify: `packages/release-foundation/src/catalogs.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: R1.3 同一个 `loadFixedManualProfile({repoRoot})`、`readFixedManualOperation({repoRoot,operationRef})`、`verifyManualBuild({proofBytes,materialBytes,repoRoot})`、R2.2 `launchManualStage1({operationRef})` 产生的固定同 ref/run/原三 operation identity 档案、R1.1 `encodeManualJson` 与 R1.1E/RP2 `assessManualRunnerEvidence`。R2.3 从固定 loader 取得 v2 Profile 并取 canonical `profileBytes`，对当前请求只以四键 `{profileBytes,requestBytes,artifactBytes,rawBlobs}` ArchiveProtocolInput 调用同一兼容 MS1 历史且支持 MS2 的 validator/assessor，且这些 `profileBytes` 必须与 R2.2 live 路径使用的固定 canonical bytes 相同并匹配 request/authorization digest；禁止 live-ack 作为终态证据。历史重评估遵守 RP3 已确立的“按被评估 request 使用原 profile”规则：旧 v1 链走明确的旧三键只读分支，非当前 v2 若缺可核原 profile 则 STOP，不得传当前 v2 `profileBytes` 替换；这不新增导出、不调用 session 私有 `history()`，也不 open session/read signing key。R2.3 固定 IO 取得 reader 返回的 proof/material bytes 后重用同一 build verifier，核其 H2 receipt 并比较 `operation.custodyReceiptRawDigest`；这是只读消费，不自行复写 custody 验证。随后从该 index 地址独立重新枚举/读回同目标全历史、真实原进程停止、H1/H2/H3-A 及已发生时的 H3-B/expected-schema 来源门槛，再调用唯一纯判定器；不接受 latest/current、另一个 ref/run、外部 Assessment、`--evidence-input-file` 或 injected successful adapters，不复制固定 index、framing、结果搜索或三态分类代码。
- 同一对真实测试文件分别用于两个独立批准的 index：一个 `normal` ref 和一个 `apply-interrupted` ref；每次 invocation 只读取 selector 指定的单 ref/run/目标和该 index 的 frozen scenario，禁止读取、要求或混入另一 ref 的原件。每条链内部保持同一 build/baseline/原始 apply 身份；第二场景未获独立 H3 批准时仅该场景显式 NOT_RUN，不自动运行。
- Produces: `verifyManualRunnerResult({operationRef}):{status,counts,recordDigest,promotionEligible:false}`。此只读函数只输出该 operationRef 所冻结 scenario 的结果与报告摘要，从固定 R1 索引独立读回实际工具/DB/容器记录，并把报告绑定到 index 内的 `custodyReceiptRawDigest`；receipt 被替换或 R1 open 时重验所有绑定失败，须在任何 signing-key read/DB 前拒绝。不能仅验 JSON Schema 即通过，也不能在单 ref 调用中形成双场景或 overall PASS。第一阶段仅形成该 ref 的 migration 阶段记录，verification 未运行显式为 `NOT_RUN`。单场景完成结果必须关联本 ref 的 allocation/build/原始 baseline/migration operation，以及该 scenario 实际需要的 H3-B 原件和独立权限读回；不得接收 caller 提供的权限通过布尔值。

- [ ] **1. 先写 result verifier RED。** 构造受控测试档案：R1 reader 返回错 ref/run/operation identity、发现 latest 结果但固定 index 不含它、缺 child PID/实际镜像 digest/版本、少一项命令、统计 dropped/skipped、改写结果字节、工具 stdout 为预制但没有对应进程记录、只给 liveness均拒绝。`node --test scripts/release/verify-manual-runner-result.test.mjs` 首次缺模块；断言 `MANUAL_RESULT_INCOMPLETE`/`MANUAL_RESULT_IDENTITY_MISMATCH`，并断言 verifier 无 write/index rewrite/session/attempt/DB allocation。
- [ ] **1a-H3. H3 固定来源与归档 MS2 RED → GREEN。** 在同一 verifier test 的两个场景原件中，重新经 R1 reader 与 §2.1 固定 H3 文件读回，然后从完整公开 AUTHORIZE 原 frame 按共享 parser 取得 context；精确核 ref/index/run/profile/target、完整 H3 RawRef、实际物理 readback 和 request/baseline fingerprint。合法 MS2 及其迁移后/H3-B 同物理链通过；inputs/raw 任一原件缺失、替换、时间先后或 approval RawRef 不符、跨 ref 同名DB、只重算 frame/raw digest 但未改已签 physical identity、MS1 冒作本轮结果、missing context 均拒绝本轮 PASS，且不得 open session/read key/连接 DB。历史 MS1 全目标记录仍按其原字节/profile进入既有 UNKNOWN/消费检查，不删、不改、不转换成 MS2。固定 IO 的 readback 不能被纯 validator 的 void 返回替代；不新增 artifact 类型或 aggregate。命令：`node --test scripts/release/verify-manual-runner-result.test.mjs`。

- [ ] **1a. 独立 framed 原件读回 RED → GREEN。** 同一 verifier test 保留完整合法 stdout（含CHALLENGE/PREPARED/EVENT等）/非秘密ACK原件并调用共享 assessor；移除任一帧/ACK custody、把结果截取冒充完整stdout、stderr result、duplicate/missing RESULT、尾垃圾、ACK无child接收边、合法唯一result但缺真实close分别不得成功。独立重开与create-only来源检查仍由本任务固定IO承担，不允许caller传“已通过parser”标记；R1.1E拥有语法算法，本任务只验证实际读回组合。
- [ ] **2. 最小校验实现并 GREEN。** 按 frozen scenario 分支核对完整历史并调用共享 assessor：`normal` 只要求 target-observe、non-empty migration dry-run/apply、H3-B 独立权限读回、readonly verify 与 migration readonly replay，不强制 reconcile；`apply-interrupted` 要求自己的 target-observe/dry-run、一次真实 interrupted apply、获批恢复/H3-B 原件及针对该原 apply 的只读 reconcile，不要求先制造一次 successful apply，也不借 normal 链 checkpoint。分别用两个 ref 的完整单场景档案作正例；另 ref/run/目标混入、scenario 与步骤错配、删 H3-B、改表 OID/owner/角色、缺 provision 退出、第二阶段重新 apply/baseline、reconcile 本次 SUCCEEDED 但原 not-committed、未知原进程终态、仅 schema PASSED、normal replay 失联未决，均拒绝该场景 PASS。replay UNKNOWN 不能被原 SUCCEEDED checkpoint 覆盖或自动作为原 apply reconcile；第一阶段不要求未来 H3-B，本次只读调查签收不等于原迁移成功。本任务不新增双场景聚合函数/Schema或分类算法。
- [ ] **3. 写两个实际 PG 测试文件。** 精确位置为 Files 列出的 `test/manual/` 两文件，该子目录不被默认 `test/*.test.mjs` 覆盖；相对导入按新增层级修正。仅这两份手工测试读取 `STAGE1_MANUAL_OPERATION_REF` 这个非秘密 lowercase UUID selector，默认测试、production CLI/launcher 均不读取；该变量不接受路径/digest/target/approval，值只交 R1 reader，禁止 latest discovery。migration 文件读取 frozen index/H3-A 后仅执行 target-observe、原始 baseline、dry-run/apply、保管读回并结束；verification 文件重新调用同一 reader，消费同一 ref/run/build/原始 baseline/迁移 IDs 和完成后的 H3-B 原件，再按 Step 2 的 frozen scenario 选择：`normal` 只执行 readonly verify + replay，`apply-interrupted` 只在本 ref 的独立恢复门槛完成后对其原 apply 执行 readonly reconcile，不借另一 ref。后者禁止 apply、重新分配目标或重建 baseline/index。使用 Node test；selector 或本阶段实际 H1/H2/H3 输入缺失即 throw `MANUAL_REAL_GATE_INPUT_REQUIRED`，没有 `.skip`/`.only`/test-name filter 或 Boolean 外部开关。测试真实调用 launcher，不能提供 `createClient/runProcess/handler` mock。测试进程不持有 migration/provision credential；Runner 能力凭证只由 R1 父会话交给对应单次 Runner。H3-B 是测试之间单独批准的人工操作，不伪装为 R1 `target-observe`/`runner-command` 批准，也不以 discovery 写回最新结果。
- [ ] **4. 独立登记适用性。** 两文件属于真实最终镜像门禁，不混入 source CI DB 清单。分别按精确路径登记为有 owner、原因、复核日期和各自唯一执行命令的例外；manifest 不伪造 source/fresh 执行条目。`release:database-tests:discover` 必须发现并分类两文件，不能靠目录漏选。例外理由只覆盖 source 测试集合，不豁免 R2.4 两阶段实际执行。
- [ ] **5. 无数据库提交门禁。** 运行 result verifier 单测、契约与测试发现，并在没有 H1/H2/H3 的开发环境执行默认 `pnpm --filter @subscription-saas/release-runner test`；默认运行必须不包含 `test/manual/` 两个真实门禁且不得出现 `MANUAL_REAL_GATE_INPUT_REQUIRED`。不能改 package glob、加 skip 或靠 discovery 例外控制 Node 选择。精确七文件 Prettier、unstaged/staged diff、独立审查后提交 `test(runner): define real manual migration verification gate`。报告明确两阶段真实数据库计数均为 NOT_RUN；真实文件仅由 R2.4 的两个精确命令执行。

例外及 contract manifest 修改与 B3/B5 串行集成，保留先前已合入条目；不重写整张清单。现有 `database-test-exceptions.v1.json` 的条目固定为 `path/owner/reason/scope/reviewDate`：新增两个精确测试路径，owner 为 `stage1-r2-owner`，scope 为 `manual-final-image-gate`，reviewDate 为 `2026-12-06`；各 reason 写明 source 集合不适用、由 R2.4 对应的唯一 Node 命令实际执行。R2 不修改 source suite manifest，也不让例外成为最终门禁的 skip。

## H3：精确合成目标准备与回收批准

在 R2.4 前停下提交本次精确摘要。H3-A 的批准与后生 readback 按 §2.1 交付可核对的 creation-spec→actual-context 来源，不能填入未来事实；本轮文档不授权生成这些真实原件或创建资源。R1 H1/H2 任一未完成，不能进入 H3 实际目标创建。H3 不是把 P1 已删除的目标恢复，也不是 Stage1 实际副本。

prepare 成功后，既有 H3 人工流程只使用同一 `inputs/operations/{operationRef}/` 下四个固定子名：先向用户展示 H3-A 精确操作单并取得真实批准，才 CreateNew `h3-a-approval.json`；实际 create 完成后才 CreateNew `h3-a-readback.json`。迁移表真实产生后再以同样顺序取得 H3-B 真实批准并保存 `h3-b-approval.json`，实际 DCL/撤权/退出完成后才保存 `h3-b-readback.json`。这些仍是既有 H3 受控原件，不新增一般 approval Schema/服务；固定 IO 必须核其实际批准来源、路径/ACL/readback，并绑定 frozen `indexDigest/operationRef/runId/profileDigest/targetIntent` 及各阶段真实对象。外部操作只引用已冻结 index，不能再次 prepare、回写 index 或预填未来证据。

- [ ] 列明单次批准的新临时 cluster/container/专属 volume 或创建参数、PostgreSQL 17 digest、loopback/内部网络、TLS、精确 marker、database 名、provision/migrate/verify/observer 四个不同角色及四个独立凭证位置（仅位于 R1 固定 credential root 内）和回收计划。所有资源命名/marker 必须复制 frozen `operationRef/runId` 的确定性派生值；databaseName 必须已是 profile 允许的精确值，任何不匹配都 STOP，H3-A 不能覆盖 profile、换端点/DB 或另生 run。observer 仅供父方预观察，verify 仅供 Runner schema 命令；不组合凭证，不复用 migration 身份。用户批准 H3-A 后才执行该次一次性操作单并实际读回，不把 approval/index 自报当真实 Docker/DB 来源。
- [ ] **H3-A 初始权限。** migration 拥有目标 Schema；verify/observer 为固定身份/catalog 只读角色，均非 owner、无 DDL/DML/SUPERUSER/CREATEDB/BYPASSRLS/额外 role membership。fresh 库确认 `_prisma_migrations` 不存在，将该表 SELECT 明确记为 `PENDING_TABLE_CREATION`，不能提前记已授权；observer 此时可以通过 `to_regclass` 记录真实空前缀。provision 初始进程退出并清除内存凭证，其 credential 在固定 root 中密封保留，仅可在另行批准的 H3-B 人工进程重新开启；不得交给测试或 Runner。迁移不承担业务 seed，R2 不写业务数据。
- [ ] **H3-B 的权限发行者前置披露。** migrate 将成为迁移表 owner，普通建库 provision 身份并不自动拥有授权资格。本方案在 H3-A 精确审批中声明该单次隔离合成集群的临时 provision 管理身份及实际 PostgreSQL `SUPERUSER` 属性，仅用于已批准建库/权限安装/撤权操作；不声称数据库把它限制成单表 grant-only。该管理凭证不得跨集群，不得成为 migration/test/verify/observer 身份。若用户不接受此临时管理身份保留到 H3-B，停止真实运行，不借用 migrate 凭证或 `SET ROLE` 绕过，也不另建权限框架。
- [ ] 独立读回 cluster system identifier、精确 Docker/container/volume/image/marker/endpoint、DB OID、role、TLS、PG17 实际版本、owner/扩展/权限。migration/verify 各角色必须能执行 observer 固定只读函数；若需精确 `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system()`，列入本次 H3 权限批准、独立读回 `has_function_privilege`，不能运行时提权。角色权限以 `pg_roles`、`pg_auth_members`、owner、`has_schema_privilege/has_table_privilege` 固定查询核验；错误 TLS/owner/角色必须阻断。旧 suite launcher 的 `tlsMode:disable` 或 P1 migrate 自检不是替代。
- [ ] **H3-B 表创建后的独立批准。** migration 阶段实际 apply/内部自检完成并保管、其 Runner 与连接退出后，停止并向用户展示绑定同 indexDigest/ref/run、原 migrate operationId/key/attempt/result、真实 cluster/DB/table OID、migrate owner、verify/observer 精确受让角色、权限发行者、固定 `GRANT SELECT ON TABLE public._prisma_migrations`、读回及撤权顺序的操作单。取得真实批准后才 CreateNew 固定 H3-B approval，随后独立人工操作进程才使用密封 provision credential；实际完成后才 CreateNew 固定 readback，不回写 index/H3-A。仍不新增自动 worker、R1 签名 kind 或 Runner 命令；禁止全表/default/grant option/业务 DML/DDL，实际授权前再核对目标/表 owner/OID。
- [ ] **H3-B 完成与退出。** verify/observer 各自连接实际读迁移表，核对成功 SELECT、无表 owner/额外成员关系、无业务表 SELECT，并保存本次人工批准来源、真实命令/退出码、前后权限及独立读回。原件归档到已批准固定档案并绑定 allocation/迁移记录，不接受 caller JSON 代替实时权限事实。provision 在独立操作进程中撤销自身登录/管理权限、关闭最后连接；凭证按本次精确清单处置，随后由只读身份读回 `pg_roles`/活动会话和宿主精确文件状态。只有撤权/退出/独立读回全部完成，才允许第二个 verification 测试。GRANT、提交、撤权或读回不确定均记 UNKNOWN，阻断后续；另获精确恢复批准，不自动重跑 migration apply。
- [ ] **apply UNKNOWN 独立恢复分支。** 正向 allocation 与受控中断 allocation 分别申请 H3，不在已完成正向迁移的库中伪造 pending 条目。中断场景在第一阶段真实 Prisma 提交后、父方完成记录前中断，保存该 apply 的 operation/idempotency/批准 plan/实际进程和 UNKNOWN 原件，立即停止。此时不得使用正常 H3-B 成功前置；另行向用户申请本次 UNKNOWN 的精确只读调查及必要单表授权/撤权操作单，绑定未知 apply 和其实际目标，由独立 provision 操作进程核对迁移表存在、owner/OID、实际 catalog/head/checksum，再完成获准的 H3-B 恢复步骤。第二阶段只读 reconcile 判定的是原 apply，不是 replay 的 UNKNOWN；不能根据管理方读回自动抹除旧 UNKNOWN 或重新 apply。目标/表状态不足以授权时保持阻断。
- [ ] 执行前批准消费者暂停范围；成功保管后按精确清单另行确认退役窗口。失败/UNKNOWN 保留原件并停止；禁止 `docker compose down --remove-orphans`、prune、通配删除或“自动清干净”。回收后独立确认容器/专属卷/凭证与 record 状态，不能只信删除命令退出码。

H3 精确对象在本稿编写时不存在，因此这里不提供可直接误执行的 Docker 删除命令。所有实际创建、权限写入及销毁仍需用户另行批准；不足以制定精确操作单时停止，不扩建新的 provision/cleanup 平台。

## Task R2.4：最终镜像、真实 PG17 migrate/verify 与独立审查

**Files:** 无产品或工具代码修改；只新增执行后报告 `docs/acceptance/2026-09-06-stage1-r2-manual-runner-verification.md`。保密原件进入 R1 固定档案，不提交凭证或原始 DB 连接串。

**Interfaces:** 两个既有 real-PG test 文件各自只从执行环境读取 `STAGE1_MANUAL_OPERATION_REF` 这个非秘密 UUID selector，再由 R1 reader 独立读回该 ref 的 frozen index/build 原件并核 exact ref/run/profile/target/operation identities；变量不是路径、批准或信任输入，production CLI/launcher 不读取它。每个 scenario/ref 的第一阶段另消费自己的固定 H3-A approval/readback，第二阶段还必须消费该 ref 后续形成的固定 H3-B approval/readback 及原始 migration 记录。任一 selector/fixed file/path/ACL/digest/real-origin 不符都在命令前 STOP，且不改 index。单 ref verifier 只产该 scenario 的结果；现有 R2.4 人工报告最终仍须显式引用 normal 与 apply-interrupted **两个独立 `operationRef`** 及各自 recordDigest，核对二者恰为同一 build/source/v2 profile/repository-contract digest 且为两个不同 physical target 后才人工汇总；不新增聚合函数/Schema/平台，也不把两场景压成一个 ref。

- [ ] **1. 核验准入后运行 migration 阶段。** normal 与 apply-interrupted 各自在其独立 H3-A 批准和目标上重复本步骤，不复用 selector/目标/原件。当前 ref 的 H3-A 已批准操作单必须先记录精确 PowerShell：把该实际 lowercase UUID 赋给 `STAGE1_MANUAL_OPERATION_REF`，在 `try` 中运行 `node --test apps/release-runner/test/manual/manual-runner-migration-postgres.integration.test.mjs`，并在 `finally` 删除该环境变量；owner 逐字执行，不让 selector 跨 H3-B 等待长期存在。测试进程只把 selector 交 R1 reader，重读该 ref 的 fixed index/build 与 H3-A approval/readback，不接受 path/target 参数或 latest discovery。缺失时不运行以制造可预知失败，也不得记通过。此阶段只到该 scenario 的真实 apply/内部自检、原件保管读回并退出，不提前运行第二阶段。任何失败/UNKNOWN 停止该 ref 的正常序列，只能另获精确只读调查/恢复批准。
- [ ] **1a. 人工权限停止点。** 每个 ref 分别展示其 H3-B/恢复操作单并等待用户真实批准，获批后保存固定 approval；不得把另一 scenario、H3-A、index 或本计划批准当作该 DCL/恢复操作批准。完成该 ref 的实际授权、两个角色独立读取、provision 撤权/退出和固定 readback 后，从其 H3-A 原件重新取得同一 UUID，并在操作单记录另一条精确 PowerShell：重新赋值 `STAGE1_MANUAL_OPERATION_REF`，在 `try` 中运行 `node --test apps/release-runner/test/manual/manual-runner-verification-postgres.integration.test.mjs`，`finally` 删除变量。测试再次经 R1 reader 重读该 index；不得替换为 glob/filter/skip、latest discovery 或重建 baseline/index/apply。该 ref 的 H3-B/恢复门槛未完成时其第二阶段为 NOT_RUN，不影响另一 ref 的事实，但 R2 overall 不通过。
- [ ] **2. 检查 normal ref 的真实正向结果。** 实际最终 Runner Node22、Prisma7.8.0、psql17、PG17 版本，三镜像同一 build proof/实际 Runner digest，真实 pending migrations 应用与 checksum/head、Schema diff=0、迁移 owner 完整、verify 只读及 readonly replay 无重复迁移；本链不要求 reconcile。若 replay 中断，它只属于 replay 自己，不能替代 apply-interrupted 场景或改写原 apply：create-only 保存 fresh replay attempt 的 `INTERRUPTED_UNKNOWN`，结束不可证时 `finishedAt=null`，保留原 apply 已提交的 SUCCEEDED checkpoint；该未决历史必须 STOP 后续签发/消费及再次 replay/apply，不为失联 replay 发 `PROCESS_LOST`/`ATTEMPT_FAILED`，也不向原 apply 自动发这些事件或转原 apply reconcile。此时 normal 场景不得 PASS。实际 Prisma 完整多行 stdout.trim() 按 Report 原样归档/验证；observer 同一实际 PG tx 的固定 setter 后，SHOW transaction_isolation/transaction_read_only 必须实际读回 repeatable read/on，保留完整 statementLog。API/Web 本轮不启动；完整 bundle 匹配不意味着完整 RC 通过。
- [ ] **3. 独立核验反例。** 通过 H3 权限只读 readback 与实际 verify 查询证明角色边界；固定 verify handler 不接受任意 DDL/DML，不能为了负向测试新增 SQL 入口。若还需实际写拒绝探测，应先提交 H3 独立精确探测批准，不将其伪装成 Runner 命令；当前两命令测试不自动执行。错误 cluster/DB/OID/TLS/镜像/批准/组合凭证在指定边界失败；不符合权限 readback 时停止保留现场。测试进程不持有 migration credential。
- [ ] **4. 检查 apply-interrupted ref 的 plan 与真实 UNKNOWN。** 对其 H3 独立批准的合成中断目标，以相同两个固定命令执行非空 pending 的提交后/父记录前中断；固定 scenario 由该 index 识别，无任意 hook，且不要求此前在本 ref 制造 successful apply。第一阶段只形成原 apply UNKNOWN，立即进入本 ref 的 H3 恢复停止点。第二阶段先独立读回原 attempt/request/批准 plan、原进程真实停止、全目标排他历史、H3 权限/退出，再读取全部 migration rows 与真实 schema，以共享谓词只读 reconcile 原结果；不能借 normal ref、仅看完成行/exit0/schemaPASSED，或把父事务回滚解释为 Prisma 全回滚。部分提交/失败行/仅 schema 一致/无法归因保持 UNKNOWN，该场景 BLOCKED；未 dispatch 的完整拒绝才可能 not-committed，本次调查成功仍不能计原迁移成功。本链不要求 readonly replay；replay 中断规则仍仅适用于实际发生的 replay。未获批准或证据不足明确 NOT_RUN/BLOCKED，不重跑 apply、不改原 operation/key/plan。
- [ ] **5. 先保管、读回再人工汇总与回收。** 两个 ref 各自的两个测试阶段分别报告完整计数与单场景 recordDigest；各自满足 `collected=selected=executed=passed+failed`，failed/skipped/todo/filtered/cancelled 全为 0，且本 ref 的 H3-B/恢复门槛完成才可能通过。现有报告手工引用两个 ref/indexDigest/recordDigest，核对同 buildProofDigest、`custodyReceiptRawDigest`、source/三镜像、profileDigest、repository-contract digest 且 physical target/DB identity 不同，并明确 normal PASS 与 apply-interrupted PASS 后才写 overall PASS；任一 custody 不同/缺失、场景 NOT_RUN/FAILED/UNKNOWN/BLOCKED 都不得 overall PASS。此处不增加聚合函数/Schema/自动平台。失败原件仍保留；R1 私密档案/加密备份/owner 签收、两目标 H3 精确退役及独立读回分别有事实，不能用一条“成功”代替。
- [ ] **6. 独立 reviewer 签报告后结束。** 报告列两个 operationRef/scenario/indexDigest/recordDigest、实际运行 source/build/profile/contract/工具版本、每次命令/phase/op/独立目标、统计、失败历史、保管/退出状态及上述人工 overall 结论。仅报告文件格式与 staged diff 检查后提交 `docs(acceptance): record manual runner vertical slice evidence`。若任一门槛失败，不提交“通过”结论，停止并请求该 ref 的精确修复或重跑批准。

## 交接与停止点

R2.0–3 的单元/适配器通过只说明代码可进入真实门禁，不解除 H1/H2/H3。R2.4 成功后也只交付 fresh migrate/verify；真实 snapshot、独立数据授权/隔离、API/Web 公共路径、全量双链归 R3/A2，Staging 部署/签字归 R4/A3。旧 Task 29R/30、KMS、自动化工作流及外部施工继续冻结。
