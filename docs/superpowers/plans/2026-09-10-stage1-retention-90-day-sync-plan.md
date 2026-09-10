# Stage1 新执行 90 天保留策略同步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前最小人工发布路径的新执行统一为 90 天逻辑保留策略，完成生产者、消费者、Schema、保管与 CI 交付的同步，并保留历史证据及冻结路径的严格兼容性。

**Architecture:** 复用已有 manual kernel、session、evidence custody 和 build verifier，使用前向版本区分新执行与历史证据，不把旧 v1 的 180 改成任选数值。Actions 只提供非秘密构建材料的短期交付；其下载、签名或实际 90 天到期时间不证明私有权威保管。实际权威保管材料未交付时，H2 继续停止，不在本计划建立存储平台。

**Tech Stack:** 现有 Node.js ESM、Node test runner、Ajv、Ed25519、GitHub Actions；无新增依赖。验收使用已准备的 Ubuntu/Node 22，本机其他版本仅作辅助记录。

**Spec:** 用户批准的新执行 90 天政策及 [R1 计划 §1.1/§2.6](./2026-09-06-stage1-r1-manual-trust-and-authorization-plan.md)（内容基线 `9c78f917`）、[R2 计划](./2026-09-06-stage1-r2-runner-migrate-verify-plan.md)（内容基线 `a721ae07`）。历史安全边界参见 [安全附录](../specs/2026-09-03-stage1-s1-execution-infrastructure-security-addendum.zh-CN.md)；本计划不恢复其冻结的云端实施任务。

## Global Constraints

- 状态：**待复审，尚不授权实施**。编写基线 `a721ae07fa9b6fd56bc460849df9e958871c4b99`；本次只新增本文件并独立本地提交，不推送。
- 获批后的执行顺序为 RP1 → RP2 → RP3 → RP4 → RP5 → RP6；各任务独立提交、主控核验及独立审查，全部通过后才解除 R1.3 的“90 天代码同步”前置阻断。H1/H2/H3、真实密钥、数据库、外部操作及 Task 30 不因该解除而获得批准。
- 新政策仅适用新的 profile/执行/证明链。历史 180 天原件、摘要、签名、起算事件、实际到期时间不改写、不缩短、不重签；既有 210 天 WORM 不改配置、不缩短。新政策不构成删除授权。
- R1.2 `a42c2041` 历史验收保持有效。下列未来修改是有明确差异的新版本兼容工作，不能把历史通过计数登记为本次通过；Windows 既有失败与 Ubuntu 成功记录均保留。
- 不改业务代码、API、数据库 Schema/迁移、RBAC、支付退款、供应商配置；不创建真实 profile、私钥、凭证、存储或身份；不运行数据库、Docker、商户操作或 workflow dispatch。
- 不安装、下载或修补依赖；Node/Prisma 超时不放宽。所需既有 Node 22 环境不可用时停止，不以排除版本测试或修改缓存补救。
- 保持同一目标锁、唯一授权消费、UNKNOWN 阻断、真实验签、独立读回、完整 stdout/ACK/CLOSE、1 MiB 及现有状态机，不新增授权或清理机制。
- 不动冻结 stash `b299ceeed80374d181998f8ef485629beba56b5f`。既有未跟踪调度文档保持原样、不纳入提交；状态应称“受跟踪文件无改动”，不能称完全干净。

## 1. 先固定可实现的政策边界

### 1.1 起算、最低要求与实际保管不是同一个字段

| 对象                                                               | 新执行要求                                                                                                                                            | 不允许的替代                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 通用 evidence/receipt                                              | 沿用真实上传/存储时间起算，至少 90 个 UTC 日；receipt 本身覆盖其引用对象的实际保管截止时间                                                            | 用调用者当前时间加 90，冒充存储 readback                                     |
| manual session、批准/撤销、process、archive/backup、FAILED/UNKNOWN | 原记录仍用原来的 `recordedAt/observedAt` 等事件，不移动事件；新 profile 和新 custody record 的策略值固定 90；一条链必要原件不得早于其下游使用要求失效 | 按文件复制时间重新起算，或把本地签名 receipt 称为实际 WORM 证明              |
| Actions 构建交付                                                   | 请求 `retention-days: 90`；核对服务实际 `created_at/expires_at`，要求有效有限时间且覆盖该 artifact 创建后 90 日                                       | 只验证 YAML 数字、忽略无效时间、把 public artifact 的 readers 声明当私密 ACL |
| 冻结 snapshot/lineage                                              | 暂不生成新执行；恢复前再消费获批的新逻辑策略，原到期事件与 downstream/legal hold 下限继续适用                                                         | 把 snapshot 有效期和证据保留期合并，或把已有 210 天物理锁改成 90             |
| 历史证据                                                           | 原版本按原 180 天规则验证，实际更长锁定不变                                                                                                           | 将旧 receipt 重新包装成新政策以绕过旧要求                                    |

90 是新的**最低逻辑期限**，不是强制把较长的实际保管截为 90。实际到期值从存储取得并原样记录；未知、短于要求或失去必要前序原件均停止。单纯持有新 receipt 不证明其引用的 approval、revocation、raw proof、material、access receipt 等均已保管；H2/R2 必须沿既有引用闭包逐件核对。没有这些事实不得完成 H2 或宣布提升。

### 1.2 前向契约，禁止原地放宽

| 契约                                                                   | 处置                                                                          | 唯一选择依据                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `manual-stage1-profile.v1` / `manual-operation-record.v1`              | Schema 原字节保持，仍严格 180，保留历史校验                                   | 历史原件版本及原 profile digest                                        |
| `manual-stage1-profile.v2` / `manual-operation-record.v2`              | 本计划新增；复制既有封闭结构，仅版本与策略常量变为 90；record 保留原八种 kind | H1 批准的固定 profile 原件及其 digest，不由 receipt 反推               |
| `manual-launch-authorization.v1`、manual Runner request/result、MS1 帧 | 不改版本、字段、签名域或协议                                                  | 已有 `profileDigest` 绑定新 profile；record 原件自身 digest 包含其版本 |
| `custody-receipt.v1`                                                   | 原 13 个字段与上传后 180 日验证语义保持                                       | 旧二参数 API 默认；只供冻结路径及历史兼容，不供新的固定人工入口回退    |
| `custody-receipt.retention90.v1`                                       | 新增同 13 字段类型；实际 `retainUntil >= uploadedAt + 90 日`                  | 消费者固定的预期契约，不从收件版本自动授权                             |
| `custody-receipt.v2`                                                   | **不使用**；已留给 purpose-lineage，不占用或改变其语义                        | 冻结基础设施计划所有者                                                 |
| `build-proof.v1`、build material、attestation                          | 原身份与签名契约不变                                                          | 仍来自同一可信 main/source/run，不能由本地重签替代                     |

新 manual 入口只能加载 v2/90。底层保留 v1 纯校验及旧路径回归不是给新的入口提供降级开关。不得接受 `90 | 180` 任意选择的 profile 字段，也不得新增 CLI/env `retentionDays` 参数。

### 1.3 当前调用方全景与冻结处置

| 当前文件/调用族                                                                                                  | 本计划处置、验收归属                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `manual-stage1-contracts.mjs`、`manual-runner-evidence.mjs`、`manual-stage1-session.mjs`                         | RP2–RP3 同步新执行；必须同时测试签名、实时 ACK、归档、恢复及全历史 UNKNOWN 出口                           |
| `evidence-custody.mjs` 的 `redactEvidence/custodyEvidence/assertCustodyComplete`                                 | RP1 增加严格新分支；默认旧分支不变；不增加删除接口                                                        |
| 同文件 `verifyAuthoritativeCustodyObservation`                                                                   | 冻结旧 I 链，原 terminal/snapshot/downstream/legal hold、真实 WORM 算法不变，不借此为新 H2 造权威观察     |
| `verify-build-proof.mjs`、`docker-images.yml`                                                                    | RP4–RP5；共享 custody 断言支持新政策，完整旧 verifier 保持旧版；CI 实现 90 天**交付**，不伪造权威保管完成 |
| `workflow-custody-record.mjs`、`final-compose-custody-adapters.mjs`                                              | 旧 RC/final 的 180 producer 暂不改；仅兼容测试，不将本地 `now + 180` helper 改称新 90 天权威 producer     |
| `approval.mjs`、`approval-revocations.mjs`、`dispatch-authorization.mjs`；旧 approval/revocation/owner workflows | 保留旧版本语义及回归，冻结自动化调用；新人工 approval/revocation 归 RP2–RP3，不恢复第二条签发路径         |
| `database-test-launcher.mjs`、本地数据库 suite runtime、snapshot export/restore                                  | 保留原策略/清理顺序，兼容测试不运行数据库；本计划不重新启动 B 线 fresh 或生成新的 180 天准入证据          |
| aggregate/exit、Runner runtime/Stage1 command 的旧 custody 消费                                                  | 保留旧分支，禁止通过新 receipt 混入旧证明链；Task 30 不施工                                               |
| `snapshot-cloud-policy.v1.json`、`evidence-lineage-storage-policy.v1.json`、相关 observation/access Schema       | 已有 210 天物理锁及冻结的 180 天旧逻辑均不改；恢复其执行前必须另做前向适配，不能声称本计划已迁完冻结平台  |

本次覆盖的是**当前最小发布主线的生产与消费**，不是全仓库 `180 → 90`。冻结的旧入口不得用于新的 90 天人工发布；若发现当前主线实际依赖上表冻结 producer，停止并列出调用证据，不能临时接回旧入口。

## 2. 文件、依赖与审查规则

任务中的 Create/Modify 是未来获批后的施工清单，本次只新增本文。没有列出的代码/Schema/workflow 不可修改。重复 Modify 是有序集成，不是多个 agent 并写；`repository-contract-files.v1.json` 由主控逐提交串行更新。

每个任务提交前按其 Files 列出的精确路径逐项执行：Prettier、`git diff --check`、精确暂存、`git diff --cached --check`、暂存清单全等检查，再本地提交。不得 `git add .`。共享 `release:contracts:verify` 与 `release:database-tests:discover` 是离线检查；失败不得登记通过。

未来测试执行前固定记录 `node --version`、源码 SHA、工作树/冻结文件与 stash 摘要；Node 22 版本检查失败即停止。以下命令中的 `node/pnpm` 仅使用既有受控环境，不触发安装。单任务 RED 可按测试名定位；GREEN 和 RP6 必须全文件执行，不靠筛选隐藏旧用例失败。每次失败报告另存，不能覆盖历史 150/150、44/44、Windows 失败原件。

## RP1：三份前向 Schema 与通用 custody 分支

**Files**

- Create: `release/contracts/schemas/manual-stage1-profile.v2.schema.json`
- Create: `release/contracts/schemas/manual-operation-record.v2.schema.json`
- Create: `release/contracts/schemas/custody-receipt.retention90.v1.schema.json`
- Modify: `packages/release-foundation/src/evidence-custody.mjs`
- Modify/Test: `packages/release-foundation/test/evidence-custody.test.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces**：不新增公开导出；原调用保持旧语义。只给以下既有接口增加可选闭合参数：

```js
redactEvidence(value, policy, { receiptContract = "custody-receipt.v1" } = {});
assertCustodyComplete(receipt, expectedDigest, { receiptContract = "custody-receipt.v1" } = {});
custodyEvidence({ value, policy, storage, now, createReceiptId, attestationRef,
  receiptContract = "custody-receipt.v1" });
```

该 selector 只能为表中两个精确类型；额外 options 字段拒绝。固定生产调用传新类型，旧未传调用保留旧行为。不得根据 `receipt.schemaVersion` 自动决定预期政策。storage 仍是已批准注入边界，不增加云适配器。

- [ ] **1. RED：在既有测试文件新增真实 Schema 与 custody 反例。** 复用现有 `fixture/memoryStore/policy/fixedNow`，保留所有旧夹具。本步骤读取新旧 Schema JSON，删除其 `$id` 与 `schemaVersion.const` 差异、把新 retention 常量还原为180后作深全等检查，并由既有 Schema 编译门禁编译；因此不额外导入会自动执行的 manual 测试文件。完整 v2 profile/八种 record 的真实正反例归 RP2，其他 Schema 约束不得放宽。

```js
test("new custody requires explicit 90-day contract and never upgrades legacy input", async () => {
  const options = { receiptContract: "custody-receipt.retention90.v1" };
  const receipt = await custodyEvidence(
    fixture({
      policy: { ...policy, retentionDays: 90 },
      ...options
    })
  );
  validateContract(options.receiptContract, receipt);
  assertCustodyComplete(receipt, receipt.contentDigest, options);
  assert.throws(() => assertCustodyComplete(receipt, receipt.contentDigest), {
    code: "CUSTODY_RECEIPT_INCOMPLETE"
  });
  const old = await custodyEvidence(fixture());
  assert.throws(() => assertCustodyComplete(old, old.contentDigest, options), {
    code: "CUSTODY_RECEIPT_INCOMPLETE"
  });
});
```

- [ ] **2. 运行 RED。** `node --test packages/release-foundation/test/evidence-custody.test.mjs`；当前应拒绝 90 policy 或找不到新 Schema，不接受环境失败作为 RED。记录实际退出码/用例名。
- [ ] **3. 最小实现 Schema/固定分支。** 新 profile/record 的 `$id`、`schemaVersion.const` 与新文件名一致，custody 策略 `const:90`；旧文件不改。内部私有 selector 返回 `{schemaId,days,legacy}`，只接受两个精确分支；原默认 180 的所有错误、secret guard 和读取次数保持。

```js
const receiptPolicies = Object.freeze({
  "custody-receipt.v1": Object.freeze({ days: 180, legacy: true }),
  "custody-receipt.retention90.v1": Object.freeze({ days: 90, legacy: false })
});
// 先以受信 selector 取策略，再核 policy.retentionDays、receipt.schemaVersion。
// legacy: retainUntil === uploadedAt + 180d；new: retainUntil >= uploadedAt + 90d。
```

- [ ] **4. 完成新 producer 的实际存储分支及故障测试。** 只在新分支调用既有 storage 的 `readMetadata({key,identity:"audit-reader"})`；返回 closed `{storeRef,contentSizeBytes,storedAt,retainUntil}`，必须与 createOnly 响应逐字段一致。未实现该只读接口的新 store 拒绝；旧分支不改变接口。所有时间严格有限且合法。新 receipt 采用实际 metadata，不用请求截止时间覆盖。实际创建延迟导致不足 `storedAt + 90d` 时失败，不能自动延长、覆盖或重传。较长的实际 180/210 日可接受并原样记录。

content、receipt 均做独立 bytes + metadata readback，receipt 对象实际保留截止不得早于 content 的实际截止及其自身创建后 90 日。receipt bytes 不引用其尚未产生的 readback，验证完成才返回；任一缺失/短期/漂移留失败，不返回成功。memoryStore 为新测试补 `readMetadata` 和元数据 Map，这只是测试 IO，不称真实 WORM。`assertCustodyDeletionAllowed` 不扩展，新类型必须拒绝。

- [ ] **5. GREEN 与提交。** 全文件覆盖新90、旧180、新策略旧type、旧策略新type、89日、日期 NaN、210不截断、内容/receipt独立读回失败、延迟创建、FAILED/UNKNOWN、secret及未知selector。运行上述完整测试及两项离线契约/发现命令。精确提交本任务六文件：`feat(release): add forward 90-day custody contracts`。

## RP2：manual 契约、实时与归档校验同步

**Files**

- Modify: `packages/release-foundation/src/manual-stage1-contracts.mjs`
- Modify: `packages/release-foundation/src/manual-runner-evidence.mjs`
- Modify/Test: `packages/release-foundation/test/manual-stage1-contracts.test.mjs`
- Modify/Test: `packages/release-foundation/test/manual-runner-evidence.test.mjs`

**Interfaces**：manual contracts 原六个公开导出、evidence 原五个公开导出保持，不新建验证器。`validateManualRunnerRequest/encodeManualRunnerFrame/parseManualRunnerFrames` 的参数不变；后两者仅识别封闭 v1/v2 record 结构，不授予政策。以下三个调用模式增加 **`profileBytes`**，由固定 loader/session 传入原始 canonical Buffer，不能由 receipt 或 request 内容冒充：

```js
assessManualRunnerEvidence({ profileBytes, artifactBytes, rawBlobs, requestBytes });
validateManualRunnerProtocol({ profileBytes, requestBytes, artifactBytes, rawBlobs });
validateManualRunnerProtocol({
  mode: "live-ack",
  profileBytes,
  requestBytes,
  authorizationBytes,
  previousProcessBytes,
  childFrameBytes,
  ackFrameBytes,
  stdoutPrefixBytes,
  parentFrameBytes
});
```

旧三字段/八字段调用只保留历史 v1/180 严格行为；含任一 v2 当前链节点而无 profileBytes 必须拒绝。新调用字段全闭合，fatal UTF-8、canonical、1 MiB；`sha256Bytes(profileBytes) === request.profileDigest === authorization.payload.profileDigest`（授权尚不存在的阶段只核已存在的绑定，不引用未来事实）。返回类型及各层决定能力不变。

- [ ] **1. RED：扩展原 fixture，独立保留 legacy fixture。** 新 `profile90/fixture90` 从原 helper 创建完整合成对象，将新 profile v2 的 digest 重新绑定 request/authorization/records，再用测试已有 Ed25519 私钥按**原签名域**签名。不得只替换数字而保留不匹配签名；真实密钥不参与。
- [ ] **2. RED 反例矩阵。** 全链新90正例应当前失败；分别覆盖 missing/wrong profileBytes、v1 record装入v2链、custody90装v1链、未授权receipt选择版本、签名正确但profileDigest错、live ACK 与 archive 接受结果不一致；保留原 owner/Schema/reconcile/replay及容器绑定反例。

```js
// 在已有 new-90 正例对象 newInput 上逐次只改一项；每次从 fixture90 重建。
assert.throws(() => validateManualRunnerProtocol({ ...newInput, profileBytes: undefined }), {
  code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
});
```

`newInput` 唯一来源为本步骤新增的 `fixture90` 输出（原 observe/runner/live fixture 的新政策变体），不是新增生产 factory。结构非法继续使用既有结构错误；上述缺失合法政策上下文统一 binding 错误。

- [ ] **3. 运行两个完整文件并确认 RED 在预期版本/政策检查。**

```powershell
node --test packages/release-foundation/test/manual-stage1-contracts.test.mjs packages/release-foundation/test/manual-runner-evidence.test.mjs
if ($LASTEXITCODE -eq 0) { throw 'RP2_EXPECTED_RED_NOT_OBSERVED' }
```

- [ ] **4. 最小实现所有出口。** 在 `verifyBase/verifyManualAuthorization/verifyManualHandoff` 以传入且已验签绑定的 profile 分支选择完整 record Schema；evidence 私有 profile resolver 校验上述 bytes 等式，并让 `readbackMatches`、frame payload、artifact kind判别、assessor与live/archive共用同一当前链政策。v2→90、v1→180；不能只修最终返回处。

```js
// 私有映射，不增加 exported API，也不由 custody.record 推导。
const manualVersions = Object.freeze({
  "manual-stage1-profile.v1": Object.freeze({ record: "manual-operation-record.v1", days: 180 }),
  "manual-stage1-profile.v2": Object.freeze({ record: "manual-operation-record.v2", days: 90 })
});
```

- [ ] **5. GREEN、旧回归与提交。** 重跑两文件完整用例；无 skip/cancel/todo、退出0；运行契约/发现、格式、暂存检查，独立四文件提交 `feat(release): bind manual evidence retention to profile version`。MS1 bytes、secret分离及1MiB不变，新增 profile 参数是本任务明确的消费接口增量，不隐含 R2 运行时施工。

## RP3：session 生产与跨政策历史阻断

**Files**

- Modify: `packages/release-foundation/src/manual-stage1-session.mjs`
- Modify/Test: `packages/release-foundation/test/manual-stage1-session.test.mjs`

**Interfaces**：`openManualSession({profile,ownerObservation,io,now,signingKey})` 和 session methods 不变。新 v2 profile 生产 v2 全部八类记录及 90 custody；评估当前请求时传当前 session 已验证的 canonical profileBytes。评估历史请求必须按下述历史路由处理，不得一律传当前 profile。旧 v1分支只保留原兼容路径，不成为新的固定 loader 后备。

- [ ] **1. RED：新增新 profile 的 session 全流程。** 扩展现有 `fixture` 为显式 `profileVersion` 测试参数，默认仍旧版；`manualRecord/custody/archive` 按 fixture 的 profile 生成版本，禁止全局替换旧测试数字。新案例必须覆盖 sign→consume→handoff→archive/readback→signoff，不以 Schema alone 替代。
- [ ] **2. RED：新增三类历史安全反例与已恢复正例。** 同一 endpoint+database 在旧 v1 store 中已有 apply UNKNOWN、replay UNKNOWN、已消费授权，随后以合法新 v2 profile 使用同一受控 roots：前两者仍阻断后续 sign/consume/ACCEPTED，后者不能被重新消费。另完整构造“旧v1 UNKNOWN → 旧v1合法reconcile结案 → 新v2独立操作通过”，保留未结案的对照；不能让目录内存在任何v1或曾经UNKNOWN就永远失败。原 profile 不同的恢复请求仍拒绝，不新增跨 profile reconcile。
- [ ] **3. 运行完整 session 文件确认 RED。** `node --test packages/release-foundation/test/manual-stage1-session.test.mjs`。保留失败输出，不借重置 journal/root、过滤历史或另建索引解决反例。
- [ ] **4. 最小实现。** session打开后确定私有 `{recordSchema,retentionDays,profileBytes}`，替换该 session 的记录构造/校验常量及当前请求的 RP2 调用；原时间字段保持。`history()` 仍按目标扫描全部已持久化消费槽，旧 v1 节点逐件按旧180结构验证，不把当前v2要求套给无关旧链。尤其 history 内对 `recoveryRequest`、`prior.original` 的重评估：当前profile的请求传当前profileBytes；历史v1请求使用明确的旧三字段**只读**评估分支，并要求该被评估链全部为旧版本；历史非当前v2如缺少可核验的原profile则STOP，不用当前profile或receipt自报版本替代。此路由不授予旧链新的签发/恢复权限。

`archiveInput()` 保持完整证据集合；当前 request/attempt 的连通链必须同一 profileDigest/版本，独立历史节点不得靠过滤消失。RP2“含v2缺上下文拒绝”只针对被评估链，不按整个目录中是否有v2粗判。

```js
// 调用处增加上下文；保留既有 artifactBytes/rawBlobs/requestBytes 原件与读取逻辑。
assessManualRunnerEvidence({ profileBytes, artifactBytes, rawBlobs, requestBytes });
// 记录的 retentionDays 来自已核 profile；不是从旧文件或 caller override 读取。
```

- [ ] **5. GREEN、独立审查、提交。** 完整 session 与 RP2 两文件联合运行，检查相同目标锁、重复消费、最后撤销、读回/交接中断、缺 RESULT/CLOSE、UNKNOWN与合法终态。测试0失败/跳过/取消后精确两文件提交 `feat(release): produce 90-day manual session records safely`。任何旧 unresolved chain 不可恢复即继续STOP，不清档、不补成功。

## RP4：build 消费者和固定 policy 纳管

**Files**

- Modify: `scripts/release/verify-build-proof.mjs`
- Modify/Test: `scripts/release/build-proof.test.mjs`
- Modify: `packages/release-foundation/src/catalogs.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces**：现有 `verifyBuildProof` 及CLI的两个scope都保持旧v1/180；必须显式拒绝新selector/type，不能让新90经 `full-rc` 返回 `promotionEligible:true`。新90仅由既有私有 `assertProofCustody({proofDigest,custodyReceipt,trustRoot,verifiedAttestation})` **原地导出**后供未来固定 R1.3 消费：其新root.custody恰含原四字段及 `receiptContract:"custody-receipt.retention90.v1"`，retentionDays固定90；旧无selector root严格180。固定R1.3不能接受调用者root或从收件选择政策。

同时将原 `assertCompleteIdentity(proof,observation)` 原地改名/导出为已计划的 `assertBuildIdentity({proof,buildMaterialObservation})`，保留原identity检查和错误，旧verifyBuildProof改为调用同一函数；RP5复用此纯身份断言，不复制校验器。以上两个导出的施工归属从 R1.3 移交 RP4，R1.3只消费，无新增build/授权语义。identity断言不验证custody、不输出提升决定。

- [ ] **1. RED：保留 `trustFixture()` 的旧180版本，增加完整新90变体。** 新变体用实际 canonical proof bytes 计算 `contentSizeBytes`；新90正例只直接调用 `assertProofCustody`，不调用完整提升verifier。分别测新policy配v1收件/180policy/未知selector/多字段/错误owner/readers/subject/短期限拒绝；两个旧scope都拒绝新selector/type。`assertBuildIdentity` 的正反例仍覆盖三镜像、material、catalog/source，不接受仅Schema一致。对共享verifier本身的单文件变化增加catalog发现测试，不允许其绕过repository contract。
- [ ] **2. 运行 RED。** `node --test scripts/release/build-proof.test.mjs`，应在新策略处失败；不是网络/gh执行失败（本文件用合成输入，不调用真实账户）。
- [ ] **3. 最小实现。** `assertProofCustody` 在核固定root后向 RP1 传显式预期类型；完整verifyBuildProof在进入该共享断言前强制旧root/receipt。source/main/workflow/issuer/run、完整三镜像、material、catalog、contract及scope检查保留在既有分层；helper不能替代真实入口其他层，Schema通过不是验签。新导出仅断言，不返回自报 trusted 布尔值。

```js
// policy 先按封闭旧/新形态核验，不能通过接收方 Schema 自动推断。
assertCustodyComplete(custodyReceipt, proofDigest, {
  receiptContract: policy.receiptContract ?? "custody-receipt.v1"
});
```

把该文件加入既有 `RELEASE_GATE_ENTRY_POINTS` 和 manifest；目录发现仍用既有实现，不增加第二套catalog。共享文件修改后两项离线门禁必须过；旧root新receipt、新root旧receipt均不可回退；完整旧verifier即使收到结构合法新root也必须拒绝。

- [ ] **4. GREEN 与提交。** 完整 `build-proof.test.mjs` 和 RP1 custody文件测试；精确四文件提交 `feat(release): verify explicit 90-day build custody policy`。本任务不声称合成 verifiedAttestation 是真实签名，不解决 H2 的实际权威原件缺失。

## RP5：Actions 90 天交付，不冒充私有权威保管

**Files**

- Create: `scripts/release/verify-build-delivery.mjs`
- Create/Test: `scripts/release/verify-build-delivery.test.mjs`
- Modify/Test: `scripts/release/build-proof.test.mjs`
- Modify: `.github/workflows/docker-images.yml`
- Modify: `packages/release-foundation/src/catalogs.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**明确能力边界**：仅修改现有 build workflow 的证据交付尾段。保护 Environment、固定 main/SHA、三镜像构建、真实 attestation/gh验证保留；不改其他 workflow、不加 secret、权限、云资源或触发器。删除把 public artifact 的固定 readers 声明当权威receipt的生成/验真步骤；不生成假的 `custody-receipt.retention90.v1`。保留构建产物可供人工取得，但工作流的“complete-bundle promotion已通过”声明不得保留。完整H2仍由固定私有原件及真实CI保管链满足；本计划不补建该存储。

**Interfaces**：新文件只拥有本workflow的纯交付核验和薄 CLI，不作通用custody框架，不进入foundation公开API。

```js
verifyBuildDelivery({ expected, entries, observedAt });
// 返回深冻结 {status:"delivery-verified", buildProofDigest, sourceSha,
// workflowRunId, runAttempt, promotionEligible:false, authorityCustody:"INPUT_REQUIRED",
// artifacts:[{artifactId,name,createdAt,expiresAt,metadataDigest,files:[{path,rawDigest,sizeBytes}]}]}
// expected = {repository,workflowRunId,runAttempt:1,sourceSha,buildProofDigest}
// entries 恰两个元素：kind:"proof" 或 "supporting-evidence"。
// 每项 = {kind,artifactId,name,metadataBytes,originalFiles,readbackFiles}
// originalFiles/readbackFiles 均为 closed {path,bytes} 数组；bytes 是实际 Buffer。
```

proof artifact仅 `build-proof.v1.json`；supporting artifact恰 `build-material-observation.v1.json`、`build-proof-attestation-verification.json`。不允许任意目录/文件/密钥被加入公开交付。proof/material先经既有Schema校验和RP4的 `assertBuildIdentity({proof,buildMaterialObservation})`，再核raw/canonical/digest，不复制规则、不调用需要custody的完整verifier。supporting材料属于同一source/run，`metadata.workflow_run.id/head_sha`与expected逐项一致。原件和readback逐字节全等；metadata为本轮 `gh api` 返回原bytes，不接受调用者 `verified/retainUntil` 布尔或日期覆盖。所有JSON/单文件入口保持1MiB，不记录secret。

CLI 固定 `--directory` 指向workspace下本次 `.release-output`；允许根恰为该目录与其兄弟 `.release-readback`，不把兄弟路径当任意escape。原件为output下上述三文件；metadata固定为 `build-proof-artifact-metadata.json` 与 `build-evidence-artifact-metadata.json`；readback为 `.release-readback/proof/build-proof.v1.json`、`.release-readback/evidence/build-material-observation.v1.json` 和 `.release-readback/evidence/build-proof-attestation-verification.json`。逐级拒绝symlink/reparse/越出两允许根、额外选项及不完整文件。

expected来自同一次job的既有 `GITHUB_REPOSITORY/GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT/SOURCE_SHA/PROOF_DIGEST`；另 `PROOF_ARTIFACT_ID/EVIDENCE_ARTIFACT_ID` 分别只由两个upload step outputs提供，必须与服务metadata ID相等。name从固定前缀 `build-proof-` / `build-proof-evidence-` 加已知digest hex构造，不能从metadata复制后自比。输入env仅是受保护workflow接线，不自证可信CI或授权。stdout仅上述非提升交付结果，失败退出1；该result是本轮诊断输出，不是新可提升证明类型，也不是H2输入。

- [ ] **1. RED：实际字节与metadata边界。** 新测试为完整fixture写三份固定Buffer、两个服务metadata原件，测试readback变更、缺失、未知file、wrongrun/source/id（含同run/source但ID不同）、metadata与upload output不等、两artifact互换、expired=true、空/NaN/无效日期、89日、恰90日、较长实际截止时间均有断言。成功result永远promotionEligible=false，公开交付结果输入build/custody verifier必须拒绝。

```js
// 私有实现的时间判定；返回 expiresAt 必须是 observed metadata 的原时间。
const created = Date.parse(metadata.created_at);
const expires = Date.parse(metadata.expires_at);
if (!Number.isFinite(created) || !Number.isFinite(expires) || expires < created + 90 * 86400000) {
  throw Object.assign(new Error("BUILD_DELIVERY_RETENTION_INVALID"), {
    code: "BUILD_DELIVERY_RETENTION_INVALID"
  });
}
```

另核合法UTC日历、`created <= observedAt < expires`，不能接受 `Date.parse` 自动修正的不存在日期。

- [ ] **2. 运行 RED。** `node --test scripts/release/verify-build-delivery.test.mjs`，应缺导出/文件或命中明确反例；不执行真实 gh。
- [ ] **3. 实现纯核验及薄固定CLI。** 测试CLI使用本地临时文件和合成服务响应；write操作仅测试fixture，不请求artifact。CLI不上传、不签名、不创建receipt；metadata读回的真实性在生产由受保护workflow的实际gh调用提供，不由单元测试声称。
- [ ] **4. 修改workflow接线。** proof上传保留digest命名、改90；支持材料在proof attestation验证后独立上传90。均 `overwrite:false`、按实际upload返回的artifact ID下载而非跨run搜索；分别 `gh api repos/$GITHUB_REPOSITORY/actions/artifacts/$ID` 保存metadata，再调用薄CLI核对。删除旧receipt-upload及其public伪custody、内联180 trustRoot和promotionEligible=true断言。保留proof原名 `build-proof-<digest>`、支持材料原名 `build-proof-evidence-<digest>`；不再发布 `build-proof-receipt-<digest>`。末尾显示 `delivery-verified / authorityCustody=INPUT_REQUIRED / promotionEligible=false`。

同时删除 job output `build-proof-receipt-artifact-id`；保留 `build-proof-digest/build-proof-artifact-id/build-proof-evidence-artifact-id`，分别只表示内容身份和交付定位。当前没有其他workflow经 `needs` 消费这些outputs，但旧RC按artifact名称下载，必须保留这项行为回归检查。

这不是允许最终提升绕过receipt：**禁止触发**冻结的 `release-candidate-gate/final-chain`，不能把它们将来因缺receipt失败当作安全冻结；旧RC在admit-build之前已有source任务。不得为了绿灯修改这些workflow。正常构建/交付完成可以成功，但不表示R1/H2/RC通过。实际GitHub保留不足90（含repo设置截断）必须构建交付门禁失败，不能仅修改要求数字。

最终交付summary只记录已读回的两个artifact，不引用其自身未来上传/保管；留在本job日志不等于权威证明。本任务不为summary继续建立自指receipt链。H2仍要求proof与private receipt同workflow/source/run及独立attestation；delivery-only run不具备该receipt。后续若已有合格私有来源，仍须独立批准其窄producer接入并生成满足同run约束的**新构建**，不能把后来人工import伪装为原run产物，也不能未经批准放宽同run规则。

- [ ] **5. 流程静态回归、GREEN与提交。** `build-proof.test.mjs` 修改现有“三个180”静态断言为两次90交付及旧伪custody/提升声明不存在；保留旧 verifier180 行为测试。新增薄CLI纳入catalog/manifest。完整运行 `verify-build-delivery.test.mjs`、`build-proof.test.mjs`、既有只读 `build-materials.test.mjs`；后者不在修改范围，失败先STOP。契约/发现、YAML格式与diff通过后，精确六文件提交 `fix(ci): verify 90-day build delivery without claiming custody`。不运行workflow，实际CI/readback/H2全标NOT_RUN。

## RP6：兼容联合验证、文档消费边界与移交

**Files**

- Modify: `docs/superpowers/plans/2026-09-10-stage1-retention-90-day-sync-plan.md`（执行记录及审查引用，不改已批准范围）
- Modify: `docs/superpowers/plans/2026-09-06-stage1-r1-manual-trust-and-authorization-plan.md`
- Modify: `docs/superpowers/plans/2026-09-06-stage1-r2-runner-migrate-verify-plan.md`

**消费归属**：本步骤只更新两份已存在计划对新契约的引用，不写 R1.3/R2 代码。R1.3加载固定 `release/contracts/manual-stage1-profile.v2.json`；该真实文件依旧由H1另批创建，禁止本任务创建。H1 owner-binding.v1结构不变，profileDigest绑定新版本。H2新receipt固定文件名为 `inputs/build/{proofRawHex}.custody-receipt.retention90.v1.json`；旧路径不存在fallback。共享 `assertProofCustody/assertBuildIdentity` 由RP4交付，R1.3的文件/步骤/导出/提交清单必须删除重复施工；R1.3仍拥有固定IO与两份真实gh验签，不降低信任源。

R2.2实际实时收发、R2.3当前请求归档校验均向RP2接口传同一固定loader取得的canonical profileBytes；每次与当前request/auth摘要匹配。历史重评估遵守RP3的被评估request路由，不能用当前profile替换原profile；未知历史版本继续STOP。R1.2实际session由RP3同步，不归R2重复施工。R2.4仍显式汇总两个独立operationRef且同build，不增加聚合平台。

- [ ] **1. 联合当前路径完整测试。** 在既有Ubuntu/Node22隔离环境记录准确版本，然后串行执行，保留每条命令完整计数和退出码：

```powershell
node --test packages/release-foundation/test/evidence-custody.test.mjs packages/release-foundation/test/manual-stage1-contracts.test.mjs packages/release-foundation/test/manual-runner-evidence.test.mjs packages/release-foundation/test/manual-stage1-session.test.mjs scripts/release/build-proof.test.mjs scripts/release/build-materials.test.mjs scripts/release/verify-build-delivery.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'RETENTION_CURRENT_PATH_FAILED' }
pnpm release:contracts:verify
if ($LASTEXITCODE -ne 0) { throw 'RETENTION_CONTRACT_FAILED' }
pnpm release:database-tests:discover
if ($LASTEXITCODE -ne 0) { throw 'RETENTION_DISCOVERY_FAILED' }
```

无效环境先停，不安装/下载；不把Node24辅助通过当Node22发布通过。实际进程版本检查、secret隔离及超时沿原门槛，任何此前未通过用例都包含在完整文件内。

- [ ] **2. 冻结路径只做无外部副作用兼容回归。** 完整运行下列已存在的纯测试文件；任何文件实际试图连接DB/网络/调用云端则停止报告，不提供凭证、不开资源、不skip：

```powershell
node --test scripts/release/custody-evidence.test.mjs scripts/release/workflow-custody-record.test.mjs packages/release-foundation/test/approval.test.mjs packages/release-foundation/test/approval-revocations.test.mjs scripts/release/approval-workflows.test.mjs packages/release-foundation/test/database-test-launcher.test.mjs scripts/release/database-test-launcher-cli.test.mjs packages/release-foundation/test/dispatch-authorization.test.mjs packages/release-foundation/test/snapshot-custody-contracts.test.mjs packages/release-foundation/test/evidence-archive-contracts.test.mjs packages/release-foundation/test/snapshot-export.test.mjs packages/release-foundation/test/snapshot-chain.integration.test.mjs scripts/release/final-compose-custody-adapters.test.mjs scripts/release/aggregate-release-proof.test.mjs scripts/release/release-dag-assemblers.test.mjs scripts/release/generate-s1-exit-evidence.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'RETENTION_LEGACY_COMPATIBILITY_FAILED' }
```

兼容回归不生成新运行证明、不执行旧workflow，也不授予旧180路径新执行权。Schema原文件及210 policy摘要须与施工前完全一致。

- [ ] **3. 跨文档检查并记录精确完成状态。** R1/R2同步本步骤的类型、固定文件、profileBytes参数、共享export所有者及CI交付事实。R1.3代码前置可在本次实现审查通过后解除，H2私有权威receipt与单独attestation、整链实际保留及授权import仍STOP；Actions不再伪造这些材料。历史批准提交及测试记录不改写，新的 contract digest 明确列出，不复用旧候选build。
- [ ] **4. 主控联合审查。** 对照 §1三张表逐项查生产、实时、archive、history、旧消费者、CI；特别验证“新profile配旧receipt”“旧UNKNOWN换profile”“public交付伪装custody”“NaN expires”“210被截断”均被拒绝或保留原事实。新90的可用代码与真实90存储就绪分别报告，不合并一个PASS。
- [ ] **5. 文档独立提交。** 精确三文件提交 `docs: record retention sync and unblock only R1.3 code dependency`；若任一实现或兼容审查不通过，不使用该标题宣称解除，保留STOP。不推送、不合并、不创建H1/H2原件。

## 3. 退出、失败与后续人工事项

本计划的完成条件是已批准范围内代码/Schema/CI配置的离线验证和独立审查通过，不是线上构建、90天真实保管或阶段1签字通过。缺少实际权威保管仍是H2输入阻断，不能把此计划扩成部署存储、生成批准或调整OSS/WORM任务。

停止条件：发现未登记的当前主线producer；必须改变授权/锁/状态机；需要改旧Schema原件、真实210锁、凭证或外部资源；旧UNKNOWN被过滤；需要下载依赖；测试失败；权威原件或独立readback缺失。保留原始失败结果，不补造期限、不重签历史、不自动重试写操作。

回退只针对本轮代码提交，经独立审查使用前向修正或受控revert；存在新v2记录后，不能回退成无法识别该记录并忽略UNKNOWN的执行入口，应停止执行并保留数据。无文件/档案/volume/云对象删除步骤。未来到期处置和真实保管续期均需独立批准。

人工事项仍按原顺序：R1.3代码审查 → H1真实身份/安全路径/备份批准 → 含新contract的可信构建 → H2权威保管与原件import逐项批准/真实验签 → H3与R2真实执行。Task30、Staging及外部资金操作不在此授权内。
