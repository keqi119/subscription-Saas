# Closure 财务审批接线与证据成员校验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. 主控安排实现者与独立 reviewer；各步骤用 checkbox 留存实际证据。

**Goal:** 让既有 Closure 审批请求/决定正确传递受管幂等键，并使 WAIVER / WRITE_OFF 审批逐一核验请求证据 ID 属于本案两类受管来源。

**Architecture:** 先修同一 governance 服务中两处 Accounting 调用接线，使用各自服务端生成的同一 source.key；再将 financial 分支的两来源行数相加改为 ID 并集覆盖。保持事务、行锁、审批快照、独立决定人和处置规则，最后在原 expiry fresh suite 使用真实上传、请求、决定和处置证明组合路径。

**Tech Stack:** 现有 TypeScript / NestJS / Prisma / PostgreSQL / Vitest，不增加依赖、Schema、migration、enum、权限或 shared export。

**Spec:** `DEV_SPEC.md`；`docs/superpowers/specs/2026-08-26-stage1-return-evidence-contract-pricing-settlement-design.zh-CN.md` §9、§13；`docs/superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md`；已审窄追加 `docs/superpowers/plans/2026-09-26-stage1-pricing-evidence-membership-fix-plan.md`。

## Global Constraints

- 本稿原始草稿在 ignored cache 中完成独立 DOC 审查，SHA256 `45dbb5e18ec0c3862b622fe107b60dc1c802e15f94990781cbd409bebbe31e6c`；该审查不代表已实施或已验收。只读核查基线为 `a86ed40763e5a9ebb31f58ab7e3e740d7a72b23b`，写稿时 tracked tree 干净。主控在同源R4两套PG完成后前向登记本计划，未改变R4门禁候选。
- 本 DOC 任务本身不执行测试、数据库、Docker、网络、依赖安装或 secret / dotenv 读取。后续施工由主控按独立审查及受控 preflight 编排；已批准阶段 1 审计范围覆盖此具体后续单元，无需泛化重批。
- 所有钱仍以 cents 保存；减免/坏账不可伪装为支付，不直接缩小账单或伪造 APPROVED。重要操作的既有审计、命令收据和不可变事实完整保留。
- 唯一未来生产文件：`apps/api/src/subscription-closure/subscription-return-governance.service.ts`。可写范围仅 `requestApproval` / `decideApproval` 的 Accounting context 幂等键接线，以及 `resolveClosureApprovalAuthority` 的 financial 分支证据成员检查。
- 唯一未来测试文件：`apps/api/test/subscription-closure-financial.spec.ts` 与 `apps/api/test/subscription-expiry-return.integration.spec.ts`。后者只由主控或其明确指定的 owner 写；串行合入、独立审查，禁止同文件并写。
- Accounting service/repository、controller/DTO/AuthGuard/PermissionsGuard、storage、Schema、pricing/registration 权威分支、`recordDisposition` 均只读，不扩成通用审批平台或历史数据修复。
- PG 只由主控通过既有 launcher/B5 capture 创建、保管、独立读回并精确退役。禁止 ambient `DATABASE_URL`、直接 vitest 跑 PG 文件、修改 suite/manifest、降低 guard、全局清表或删除 append-only 证据。

## Review Focus

1. 合法请求与决定必须进入真实 `AssetAccountingService`；缺少 context key 的 RED 不能被替身绕过。见任务 1。
2. A 的两条 link 不能抵消缺失/他案 B；financial-proof 的错误前缀或他案文件同样不能抵消。见任务 2 的双类型、双入口矩阵。
3. 合法多关联和重复请求 ID 应保留原去重排序语义；union 不要求两类来源各出现一次，也不增加额外证据用途约束。见任务 2 的合法对照。
4. 真实双人决定、权限、当前 FINALIZED / 余额快照、proof P、幂等冲突、并发更新条件及审计必须仍有效。见任务 1 的真实 service 边界和任务 3 的 PG 读回。
5. 测试来源与结论分开：unit rows/repository/audit 替身、真实 PG 服务链、合成 storage/provider、浏览器/线上 NOT_RUN 分别记录；registration 与跨时刻审批重试另列待办。见任务 3 / 收口边界。

## 已核事实与真实接口

以下行号对应上述只读基线，实施时按符号定位，不用行号作 patch 匹配。

| 事实                                                                                                                                                                                                               | 已核代码                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestApproval` 和 `decideApproval` 生成 `closure-approval-request:${idempotencyKey}` / `closure-approval-decision:${idempotencyKey}`，但传给 Accounting 的 context 只有 actorId/ipAddress/permissions/userAgent | governance `requestApproval` 1256 起、`decideApproval` 1310 起                                                                                                                                                                                    |
| Accounting 真实入口必须有非空 scalar `context.idempotencyKey`，且逐字等于 canonical `source.key`；缺失为 `ASSET_ACCOUNTING_IDEMPOTENCY_KEY_INVALID`                                                                | `apps/api/src/asset-accounting/asset-accounting.service.ts` 1098、1137、1416–1443                                                                                                                                                                 |
| controller 的 `requestContext()` 仅返回 ipAddress/userAgent，`RequestContext` 也未声明 key；不能假设 HTTP header 自动补入当前 context                                                                              | `subscription-closure.controller.ts` 771；`apps/api/src/auth/auth.types.ts`                                                                                                                                                                       |
| financial resolver 已去重/排序 evidenceIds，却用 link count + file count 与集合长度比较                                                                                                                            | governance 3545 起、3715 附近。link where 为 closureCaseId + evidenceId in；file where 为 id in + 本案 `financial-proof/` 前缀                                                                                                                    |
| 实物接收为同一已上传 evidenceId 追加 DAMAGE_PROOF；原 CHECKLIST_PROOF 绑定 checklistItemId，DAMAGE_PROOF 不绑定 checklistItemId                                                                                    | `subscription-closure.service.ts` 的 physical receipt `vehicleReturnEvidenceLink.createMany`；expiry 文件 `prepareGovernedCompletion` 的真实 upload/receipt 与既有双 link 断言。上传 targetType 是 CHECKLIST_ITEM，不能把它误写成 evidencePurpose |
| 合法 A 两行、本案 financial-proof P 一行，请求 `[A,B,P]`，B 缺失/他案时仍有 `2+1 >= 3`                                                                                                                             | 静态可达的成员校验缺口；本稿未跑新 RED。当前完整审批链还会先受上面的 key 缺失阻断，不能报告现版本已经实际完成非法减免                                                                                                                             |
| `decideApproval` 从保存的 subjectSnapshot 重建输入并再次调用 resolver；Accounting 校验权限、独立决定人和快照，但不独立查询 Closure 证据归属                                                                        | governance 1337–1389；Accounting service/repository 的 request/decision 入口                                                                                                                                                                      |
| `recordDisposition` 检查本案 proofFileId P，及已批准快照包含 P、当前 revision/hash/bill/amount/type 等；不逐一重查快照所有 evidenceIds                                                                             | governance 2382 起，尤其 2468–2479、2570–2627。此次不修改该入口，不修复历史已批准记录                                                                                                                                                             |

既有 HTTP 接口保持原样，controller 不改：

- `POST /api/subscription-closures/:id/financial-proofs/upload`：`SUBSCRIPTION_CLOSURE_SETTLE`，调用 `uploadFinancialProof(caseId, file, actorId)`。
- `POST /api/subscription-closures/:id/approval-requests`：`BUSINESS_EXCEPTION_REQUEST`，调用 `requestApproval(caseId, input, user, context)`。
- `POST /api/subscription-closures/:id/approvals/:approvalId/decision`：`BUSINESS_EXCEPTION_APPROVE`，调用 `decideApproval(caseId, approvalId, input, user, context)`。
- `POST /api/subscription-closures/:id/receivable-dispositions`：`SUBSCRIPTION_CLOSURE_SETTLE`，调用 `recordDisposition(caseId, input, actorId)`。

`uploadFinancialProof` 校验文件 bytes/MIME，调用 `StorageService.putSubscriptionClosureFinancialProof`，再创建有 contentSha256 的 FileObject。生产路径前缀来自 `storage.service.ts:227`，不由调用人提交 objectKey。未来 PG 用该真实方法产出 P，仅存储 IO 使用内存 adapter，不直接 insert 伪造 P。

## 任务 0：冻结、受控 preflight 与证据目录

**Files:** 本稿将由主控在独立审查接受后决定精确文档提交位置；本 DOC 阶段仍只保存在 ignored cache，不改现有已冻结计划或索引。

- [ ] 主控确认当前 R4 PG 已终态、保管和退役；记录实际实施 HEAD/status、此三文件 owner 与本稿 hash。保留所有前向改动，不复位到本文只读基线。
- [ ] 按 `AGENTS.md` / 原获审 B5 流程在新的受控 fresh 窗口完成 migrate deploy/status/diff 和身份/权限读回，或明确记录主控认可的同开发轮有效 preflight。迁移 pending/失败或身份不明不得开始生产修改；不运行连接 ambient 的裸命令。
- [ ] 已有依赖可直接使用。Prisma 离线校验若需要，沿 `apps/api/prisma-env-policy.ts` 的 `STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV=1` 路径，由主控记录；不读取 `.env`，不改 lockfile/依赖。
- [ ] 后续原件统一写 ignored `node_modules/.cache/sdd/stage1-return-browser-gap/`，采用 `financial-key.*`、`financial-membership.*` 与新的 PG prefix；已有 R4 原件不得覆盖。记录命令、source/diff、真实 counts/exit，而非预先写 PASS。

## 任务 1：审批调用的幂等键接线（先独立 RED → GREEN）

**Files:** 修改 governance 的两个已有 Accounting 调用；扩展既有 `subscription-closure-financial.spec.ts`，保留原有财务派生/法催测试。

**Interfaces:** `AssetAccountingCommandContext.idempotencyKey?: string | readonly string[]` 的既有规则实际只接受非空 string，且等于 command.source.key。Closure 的 input.idempotencyKey 仍由原 `requiredText(...,180)` 处理；`RequestContext`、HTTP DTO/header、user 权限不改。

- [ ] **1.1 写真实入口 RED。** 同文件建立 `financialApprovalHarness()`，使用有效 UUID、当前本案 FINALIZED revision、正余额账单与合法单一 P，避免证据数量缺口影响该 RED。实例化真实 `SubscriptionReturnGovernanceService` 和真实 `AssetAccountingService`，调用真实 `requestApproval` / `decideApproval`，不得 stub 两个 Accounting service 方法。事务 rows、repository 和 audit IO 可用同文件窄替身，明确不证明 PG 锁/回滚；参照只读 `asset-accounting.service.spec.ts` 的 serviceHarness，不导入测试文件或新增共享 helper。
- [ ] request 期望到达 repository 的 PENDING 创建；decision 使用明确标注的 unit PENDING 输入行和另一 actor，期望到达 repository decision。各自实际旧版预期先失败为 `ASSET_ACCOUNTING_IDEMPOTENCY_KEY_INVALID`，repository 写入和 audit 均零；分别保存 RED，不能仅因 request setup 失败声称 decision 已测。
- [ ] **1.2 最小生产接线。** 在各原调用前冻结局部 source 对象，原 command.source 引用它，context 新增 `idempotencyKey: source.key`；request 与 decision 的前缀分别保持原值。key 不从 caller context/header 覆盖，也不加权限或默认 actor。两处接线适用于各既有审批类型，但不改变任何类型的 authority 分支。
- [ ] **1.3 GREEN 与保护反例。** 断言实际 Accounting 入口产生的 repository source 和审计 requestContext key 完整相等；两前缀不混用。合法 actor/permission 保持；缺 request/approve 权限仍 `ASSET_ACCOUNTING_PERMISSION_REQUIRED`，同一操作者自批仍 `ASSET_ACCOUNTING_SELF_APPROVAL_FORBIDDEN`，拒绝时 repository decision 与 audit 零新增。audit IO 替身只记录真实 Accounting 所发事件，不能替代 service 的权限判断。这里不声称替身验证了 repository snapshot/version 或真实审计持久化。
- [ ] 聚焦命令：`pnpm --filter @subscription-saas/api exec vitest run --project unit test/subscription-closure-financial.spec.ts`。基线、RED、GREEN 分别留完整 stdout/stderr/exit。
- [ ] 独立 review 这两处接线和真实入口证据后，精确提交已审 production/test 两文件；然后再开始任务 2。提交标题可为 `fix(closure): bind approval accounting idempotency keys`，不包含其他 owner 的 expiry 改动。

## 任务 2：financial 两来源 ID 并集（单独 RED → GREEN）

**Files:** 同 production 文件仅 financial 分支；同 financial test 文件。

**Interfaces:** 输入仍为去重、排序后的 evidenceIds。合法来源仍是当前 `closureCaseId` 的 `VehicleReturnEvidenceLink.evidenceId`，或 `FileObject.id` 且 objectKey 以精确本案 `subscription-closure/${closureCaseId}/financial-proof/` 开头。只改变成员判定，不新增“必须有某一用途”或“两类必须齐全”的业务规则。

- [ ] **2.1 扩展 row-backed fixture。** `vehicleReturnEvidenceLink.count/findMany` 从同一 link rows 按实际 where.closureCaseId 与 where.evidenceId.in 过滤；`fileObject.count/findMany` 从同一 file rows 按 where.id.in 与 where.objectKey.startsWith 过滤。select 只投影实际字段，null evidenceId 不匹配 in。旧 count 和新 findMany 都由 rows 导出，不能硬编码计数/不读 where；保持真实 Accounting service，不 spy 掉其入口。
- [ ] **2.2 两类型 × 两入口矩阵。** `WAIVER` / `WRITE_OFF` 均分别通过 `requestApproval` 和 `decideApproval` 验证下表。decision 用保存的 PENDING snapshot 重建相同请求；测试内改变 rows 仅模拟 resolver 面对的当前权威事实，明确不是可对真实 append-only 记录执行删除的生产操作。每个拒绝断言原 `CLOSURE_FINANCIAL_APPROVAL_AUTHORITY_MISMATCH`、repository 审批写入/audit/账单/处置零变化。

| rows 与请求                                                            | 应有结果 / RED 分类                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 本案 A 的 CHECKLIST_PROOF + DAMAGE_PROOF，合法本案 P；请求 `[P,A,A]`   | 接受并传递 `[A,P]` 的排序去重集合；旧版本通常已通过，是合法 characterization |
| A 两行、P 一行；请求 `[A,B,P]`，B 根本不存在                           | 拒绝；任务 1 接线完成后旧数量逻辑错误放行，是真实入口 membership RED         |
| 同上，B 仅有他案 link，或是他案 financial-proof FileObject             | 拒绝；即使实际表中有 B 也不能算本案覆盖，是真实 membership RED               |
| A 两行；请求 `[A,P]`，P 缺失、前缀为本案其他目录或另案 financial-proof | 拒绝；A 的重复 link 不能代替 P，是真实 membership RED                        |
| 单 link A + 合法 P；请求另加缺失 B                                     | 仍拒绝，是未被重复行抵消时的既有正确行为                                     |
| 全部 ID 完整，分别为 link-only、proof-only、混合来源；重复请求 ID      | 保持原准入和排序；不把 union 改成要求每个 ID 同时在两表                      |

- [ ] 保留邻近 guard characterization：空证据为 `CLOSURE_APPROVAL_EVIDENCE_REQUIRED`；缺 bill / 非 FINALIZED 或 SETTLED 为 `CLOSURE_FINANCIAL_APPROVAL_INPUT_INVALID`；错案/retired/旧 revision 先 `CLOSURE_APPROVAL_STALE`；错 order 或余额 <=0 为原 financial AUTHORITY_MISMATCH。按真实最先 guard 分类，不把所有错误统一改成成员错误。
- [ ] **2.3 最小实现。** link count 改 `findMany`，原 where 原样，`select: { evidenceId: true }`；file count 改 `findMany`，原 where 原样，`select: { id: true }`。构造两结果 ID 的 Set，并仅把 `linkedEvidence + financialProofs < evidenceIds.length` 改为 `evidenceIds.some(id => !coveredIds.has(id))`。不比较 Set.size 代替逐 ID 检查，不取第一/最后 link，不过滤调用记录，不新增 export。
- [ ] 事务/closure→settlement→bill 行锁顺序、Promise.all、FINALIZED/SETTLED 兼容、bill.orderId/remainingAmount、snapshot amount/revision/hash、错误码、审批/处置 guard 全部保持；PRICING_OVERRIDE 已修 Set 逻辑和 registration 现状不改。
- [ ] **2.4 GREEN。** 重跑任务 1 同一聚焦文件，确认各 membership RED 转 GREEN，原 guard characterization 不退化。分别记录此阶段新增测试数、旧版实际错误结果和最终 counts，不把任务 1 key 错误当成本阶段缺项 RED。
- [ ] owned lint/格式/diff 与独立审查接受后精确提交两文件，标题可为 `fix(closure): require every financial approval evidence ID`。服务已有 Prettier 基线若仍不通过应记录 baseline/current 同态，不格式化整个大文件；新增块与新增测试格式必须合规。

## 任务 3：原 expiry suite 的真实双人财务链与最终门禁

**Files:** 主控独占修改既有 `apps/api/test/subscription-expiry-return.integration.spec.ts`，不增加 suite、生产 API 或测试连接器。

**Interfaces:** 复用 `prepareGovernedCompletion(prisma, { paid:false, damageResponsibility:"PLATFORM" })`、`insertRuntimeUser`、`AssetAccountingService` / `AssetAccountingRepository` / `AuditService` 与当前 governance。该 helper 真实完成 upload→physical receipt→delta/责任确认→inspection→propose→finalize；现有 100 cents 未清账单是明确的历史输入 fixture，不称真实支付渠道账单。选择 PLATFORM 仅避免引入额外计价账单，同时仍产出同一 A 的 checklist/damage 两关联；读回必须证明这一点。

- [ ] **3.1 建立真实来源。** 每个 approval type 使用独立 fixture。`A = h.evidenceIds.get("VEHICLE_EXTERIOR")`；用实际 PG 查询断言仅一个 evidenceId、有不同 CHECKLIST_PROOF / DAMAGE_PROOF 两关联及各自 checklistItemId/damageId 关系。当前 settlement 必须 FINALIZED、hash 非空、未清账单属于当前 order 且 remainingAmount=100n；不得改旧 hash 或直接置终态。
- [ ] 为当前案创建新的 governance 实例，构造参数第六项为真实 `AssetAccountingService(prisma,new AssetAccountingRepository(),new AuditService(prisma))`，第七项维持三阶段 gate。复用成熟 fixture 的真实 Prisma；financial storage 只实现原 `putSubscriptionClosureFinancialProof` / `deleteObject` 的内存 IO，objectKey 使用输入 caseId/objectIdentity 和生产精确前缀。真实 `uploadFinancialProof` 使用已校验 PNG bytes 产出 P，读回 FileObject 前缀、SHA、size、uploadedBy；不能 mock 返回一个未持久化 fileId。
- [ ] **3.2 缺项拒绝。** 两类型分别请求 `[A,B_missing,P]` 与 `[A,B_foreign,P]`；B_missing 是未存在 UUID，B_foreign 来自另一个真实 fixture 的 upload/receipt 或 financial upload。先读回证明 B 来源，再经真实 governance / Accounting 请求，期待 financial AUTHORITY_MISMATCH。审批行、Accounting receipt/audit、账单和 disposition 的前后精确快照不变；保留 `[A,A,P]` 合法输入对照。此步若在任务 2 前单独运行，必须记录当时真正最先失败/放行，不能预写 RED 结论。
- [ ] **3.3 真实合法双人链。** 请求人 R 取当前 fixture ACTIVE user，决定人 D 通过既有 `insertRuntimeUser` 写入另一 ACTIVE 测试用户，明确 R!=D。使用真实 `RequestUser` 的 `business_exception:request` / `business_exception:approve` 权限输入，调用真实 request→读回 PENDING id/version/snapshot→真实 D decision APPROVED→读回 APPROVED 和审计。权限对象是 PG fixture 身份边界，不称真实 JWT/UI 角色验收。不得直接 insert/update APPROVED，不能用 Accounting mock 自动批准。
- [ ] 正向之前或独立 fixture 覆盖无权限请求/决定与 R 自批，断言原权限/独立人错误且决定/audit 零写；拒绝后仍可由合法 D 决定。decision 的 expectedVersion 从独立读回获得；合法集不变时真实 repository 仍核对 snapshotHash / canonical snapshot。至少用独立 fixture 检查过期 expectedVersion 为 `ASSET_ACCOUNTING_APPROVAL_VERSION_CONFLICT`；用既有 `settleTask6Bill` / `FinanceService` 在请求后真实部分收款，使余额从 100n 变为 99n，再决定应为 `ASSET_ACCOUNTING_APPROVAL_SNAPSHOT_MISMATCH`。不能改写 approval snapshot 让测试成功，且不把该受控支付/provider fixture 称为外部真实支付。
- [ ] **3.4 实际处置。** 用 P.fileId 和刚产生的真实 approvalId 调用 `recordDisposition`：WAIVER→WAIVED、WRITE_OFF→WRITTEN_OFF，billId 精确、chargeLineId=null（当前选用原历史租金账单）、ownerType=FINANCE、ownerId=R、detail 为固定说明、各命令独立稳定 key。P 必须在已批准 evidenceIds 内；不带批准/用另一 P/错 revision/hash/amount 时原 `CLOSURE_DISPOSITION_APPROVAL_REQUIRED` 等 guard 保持。负例使用独立未处置 fixture，避免余额已零先触发其他 guard。
- [ ] 读回：一条正确 approval-bound disposition，amountCents=100n，bill 剩余为零且 billStatus=CANCELLED，paidAmount 未伪增、paymentRecord/paymentWriteOff 零新增；financialStatus 按既有 `deriveClosureFinancialState` 分别为 SETTLED / WRITTEN_OFF（WAIVED 是 disposition，不是 financialStatus），原 settlement/hash、order/contract/运营终态不被本次财务动作伪造。Accounting CREATE / APPROVE 审计各一次且 operator 分别为 R/D、subject/source/hash 正确。不能要求服务本来没有发出的额外 disposition 审计；既有处置事实仍完整持久化。
- [ ] `recordDisposition` 同 key/body 重放返回原事实，账单/approval/receipt/audit/disposition 零新增；同 key 改 detail 仍原幂等冲突。request/decision 的跨时刻重试另见下方限制，不伪造 frozen clock 宣称已支持正常重试。
- [ ] **3.5 fixture 隔离。** 同案精确读回后才清理测试活动调度；遵守已修 R4 helper 的按 scheduleId/orderId PAUSED 规则，在 finally 保留不可变证据，不影响其他样本或全库 scheduler 断言。不复用全局计数来判定本案财务写入。完整 suite 必须无 `.only`、filter、skip。
- [ ] **3.6 离线最终检查。** 沿现有依赖，执行下列单元集合与 API tsc、三 owned 文件 lint/diff；如沿同一 R4 source 合入，主控已有更大同源门禁可包含本集合，避免重复重负载。所有数量以实际原件为准。

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/subscription-closure-financial.spec.ts test/subscription-closure-pricing.spec.ts test/asset-accounting.service.spec.ts test/subscription-closure.controller.spec.ts test/subscription-return-governance-gate.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/api exec eslint src/subscription-closure/subscription-return-governance.service.ts test/subscription-closure-financial.spec.ts test/subscription-expiry-return.integration.spec.ts
git diff --check
```

- [ ] **3.7 PG 同源准入。** 离线通过、独立审查、精确提交后由主控在干净 source 使用原 `db-capture/b5-capture-invocation.ps1` 编排完整 `api.subscription-expiry-return.postgres`，随后 `api.asset-operations.postgres` 基础回归，串行不并发。launcher 来源是 `scripts/release/run-database-suite.mjs`，suite 来源是 `release/contracts/database-test-manifest.v1.json`；B5 wrapper 参数是 `-Prefix` 与 `-SuiteId`。prefix 采用未使用的 `financial-approval-expiry-fresh-1` / `financial-approval-asset-fresh-1`，存在任一同名原件即停止而非覆盖。本稿不执行这些命令。
- [ ] 保管完整 stdout/stderr、source/input identity、真实 counts、exit、report/receipt、独立 digest、目标身份/权限读回和精确退役。失败保留原件并按真正第一 guard 诊断，不降低旧断言或修改 guard 迎合测试。
- [ ] 三文件最终 SHA、每任务 RED/GREEN 分类、完整门禁及未执行范围交独立 reviewer；接受后主控整合候选和前向验收记录。本文的 checklist 只有实际执行后才可勾选。

## 保留范围与独立审计待办

1. **Registration 未证实相同端到端缺口。** 该分支查询还带 checklistItemId；真实 receipt 的 DAMAGE_PROOF 不带该字段，不能拿本次 A 双 link 直接证明同一检查项可重复计数。e-sign 后置还按 ID Set.every 检查缺项。同 item 多 link 的合法 producer 可达性须另查；不改其 count，也不宣称此次修复覆盖 registration。
2. **审批跨时刻重试未在本切片修复。** `asset-accounting.repository.ts:1209/1221` 将 requestedAt/decidedAt 纳入 payload；Closure 每次调用使用 new Date()，`replayApprovalReceipt` 对 payload 精确比较。因此同 key 的后续调用可能原样触发 `ASSET_ACCOUNTING_SOURCE_CONFLICT`。此次只补 context.key，保持现有冲突/零新增语义，不改时间接口、收据 hash 或把假时钟下的结果冒称真实幂等重放。另立最小真实 RED 后安排后续审计。
3. **历史已批准记录。** 此次入口修复阻止新的无覆盖 request/decision；不读取真实业务库推断是否存在历史坏记录，不改既有 approval snapshot/receipt/hash，不绕过当前 disposition 守卫。历史处置复核若需要，须独立只读评估与明确范围。
4. **边界。** 此稿仅完成只读代码核查与可审设计；所有新增 RED/GREEN、真实双人 PG、浏览器、Staging、渠道、资金动作均尚未执行。原 R4 已有门禁事实按原 source 保留，不能因本稿出现而报该后续切片完成。
