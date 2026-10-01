# Closure 财务审批未知结果重试 Implementation Plan

基线：D:/Projects/auto-subscription-platform/.worktrees/stage1-financial-evidence-20260926，HEAD 0ca44e6eddf4c6be148bf46f9e75e0206b695f0d。仅源码审计；未执行测试/PG/网络/Docker/环境读取。原 financial 窄切片仅涵盖 key 接线和 evidence membership，本方案涉及 Accounting/UI/page，需精确审查后独立实施；用户总体 stage1 授权持续，不要求泛化重批。v2 原稿仅在 R22 ignored cache 完成只读审计与独立 DOC 审查，SHA256 c745b49ebde24a23fef8ad9a57d4f742d5c40003ca01a5ffe3984d8d71e24691，结论 ACCEPT；本文由主控前向登记，除标题/状态、换行规范化和 requestEvidenceSnapshot 字段名勘误外不改设计。原 v1/v2 原件均保留。施工使用 superpowers:subagent-driven-development 或 superpowers:executing-plans，生产、测试、实际 PG 与来源证据均需按下文独立验证，方案接受不等于已实施。

## 已核行为

1. governance requestApproval:1256、decideApproval:1312 每次产生 new Date()，source tuple 的 type/id/key 分别为 SUBSCRIPTION_CLOSURE_APPROVAL/caseId/closure-approval-request:${key} 或 closure-approval-decision:${key}。repository requestApprovalPayload:1209 / decisionPayload:1221 包含 requestedAt/decidedAt、actor、完整规范化权威及业务字段；replayApprovalReceipt:1475 附近同时比较 commandType、完整 payloadHash、canonical payloadSnapshot，并核 approvalId 非空/costEntryId 为空。这里不应删掉时间/actor/权威比较。
2. 非“所有真实重试必然冲突”：首个命令已成功提交、source 相同、前置检查通过且两个服务器 Date 毫秒不同，则完整 payload 必异，触发 ASSET_ACCOUNTING_SOURCE_CONFLICT。相同毫秒、同规范化 payload 可以 replay。首调用 rollback 没有收据时，第二调用是首次成功写；不同 key 是新命令，不是 replay。
3. Financial UI return-settlement-stage:179/215 每次点击 randomUUID；request 还重新上传 proof 获取新 fileId。当前 run:146 捕获错误后没有保存原命令。因此再次点击既不稳定 key，也不稳定 evidenceIds。API 包装器只 JSON.stringify input，无自动审批重试时间绑定。
4. 权限与 actor：controller:287/302 有 BUSINESS_EXCEPTION_REQUEST/APPROVE；AuthGuard 每请求 validateToken，AuthService:194 起重新读取当前 ACTIVE/nondeleted user 及当前有效 role/permission，不信 JWT 内权限。Accounting assertWriteContext:1416 先检查当前传入 actor 非空、permission、context.key=source.key；decideApprovalInTransaction:1137 又在 repository 前做 requester != decider。不同有效 actor 属于完整 payload 变化，已有同 source 收据应 SOURCE_CONFLICT；requester 决定先 SELF_APPROVAL_FORBIDDEN。直接服务调用仅证明传入 context 权限；repository 的 ACTIVE 用户核验在 replay 返回之后，不能静态声称服务 exact replay 已重核数据库 actor 活性。
5. 当前权威：governance resolveClosureApprovalAuthority:3549 在 closure 行锁下重核未 retired、当前 settlement、settlement 阶段、本案账单余额与逐项受管证据；之后 Accounting resolveApprovalAuthority:1286 锁 source/subject 并回调。当前 revision/归属/零余额/证据失效可能先 CLOSURE_* 拒绝。仍合法但 amount/resultHash 变化会改变 payload：已有同 source 收据 → SOURCE_CONFLICT；新 decision source 没有收据时 → APPROVAL_SNAPSHOT_MISMATCH。不能统一改成“老 receipt 已存在即可成功”。
6. repository receipt replay 在当前 approval version/status 检查前。合法已决定命令携原 expectedVersion=0 replay 可返回旧已决定结果，即使当前 version=1；修改 expectedVersion 本身应 SOURCE_CONFLICT。request replay 返回原 PENDING outcome，即使现在 APPROVED/EXPIRED；这是历史命令 ACK，不是当前授权。UI 必须独立 reload；recordDisposition 的当前权威/真实批准检查继续生效。
7. registration 风险：governance decideApproval:1390 附近在 APPROVED + VEHICLE_REGISTRATION_DOCUMENT_MISSING 后无条件 updateMany，将 CLOSURE_RETURN_MANIFEST_ESIGN job 的 attempt/lease/completed/result 清零并置 PENDING。Accounting public 返回值不暴露 wrote。若通用修复让旧 registration decision replay 成功，该副作用会重复。不能以 status=APPROVED 或已有 receipt 推断本次 wrote=true。

## 既有受管时间模式及不采用的捷径

recovery 的 RequestRecoveryApprovalDto/DecideRecoveryApprovalDto:430–442 接受 requestedAt/decidedAt，controller:585/600 映射 Date，service normalizeRequest/DecideRecoveryApproval:10051 起只核有限 Date、规范化身份/文本；真实 managed authority/capability 与 event fingerprint 绑定该时间，重放还复核权威。pricing refresh controller（return-pricing-stage:158 起）将 key+occurredAt 一次冻结，retry 复用，是合法稳定命令消费模式。它们不证明外部 financial HTTP 任意历史/未来客户端时间可信，也没有给 financial 独立可接受时间窗口。

故本稿不推荐新增 requestedAt/decidedAt HTTP 字段。若以后改成显式时间，必须先另定业务时间与服务器记录时间、允许窗口、首次冻结、来源、审计及篡改拒绝契约；当前不可用“和 recovery 一样”替代这个决定。

## 唯一推荐设计：financial 专用服务器首写时间复用

仅 SETTLEMENT_WAIVER/SETTLEMENT_WRITE_OFF。HTTP/DTO 保持原样，不接受客户端提供命令时间。pricing/registration 继续既有方法与时序，本设计不修其跨时刻重试，不改变 registration job 副作用。

未来新增两条窄 Accounting 消费入口（名称提案）：requestClosureFinancialApprovalInTransaction(tx, commandWithoutRequestedAt, context, authorityResolver) 和 decideClosureFinancialApprovalInTransaction(tx, commandWithoutDecidedAt, context, authorityResolver)。仅接受上述 financial exceptionType、SETTLEMENT_CASE、本案 source type、相应固定 key prefix；治理层按真实 authority.exceptionType 分派。共享已有 permission/source/authority/self-approval/audit 执行核心，旧入口不改语义；不可让普通调用者传“already verified/replay”flag。

次序固定：当前 closure/bill 行锁与完整 resolver → Accounting 既有 source+subject 事务锁/当前 context guards → financial 专用当前 actor SHARE 锁+ACTIVE/nondeleted 核验 → 同 source 收据时间候选读取 → 真实现有 request/decision execute/replay/full payload 比较 → audit 仅 wrote。

收据时间候选由 repository 内部窄 helper 在上述锁持有期间读取，不由 governance 随手查询再提前返回：
- 无收据：此处生成一次服务器 new Date()，作为本次首次业务命令时间，正常实际插入与收据/audit 同事务提交；rollback 不保留成功假象。仍保留首次服务器时间含义，不新增任意客户端回填。
- 有收据：先核同 source tuple、正确 EXCEPTION_REQUEST/DECIDE、approvalId 非空/costEntryId 为空、payloadSnapshot 自身 canonical hash 等于 payloadHash、相应时间为有限且规范化 ISO；source/key/type 不符与坏收据不回退成首次写。approvalOutcomeFromReceipt 仅为既有 enum/date/version 解码，不把它称为事实链 validator；随后增加 financial 私有消费关系校验，不新增第二个通用 parser。以既有 publicApprovalOutcomeJson 重新编码与原 outcomeSnapshot canonical 全件比较，避免 decoder 把漏字段/额外字段/类型转换藏掉；所有 ID 要逐值合法且相等，不靠 String() 接受数字 ID。
- 完整身份链：receipt.approvalId == outcome.id == 锁住/读回的真实 approval.id；decision 再等于调用 command.approvalId。receipt.actorId == payload.requestedBy/decidedBy == 历史 outcome 相应 actor == 真实审批的原 requester/decider；调用当前 actor 必须最终参与完整 payload 比较，换有效 actor 不可因原 actor 真而被承认。同 case/financial exceptionType/subjectType/subjectId/subjectField 逐值匹配 payload/outcome/真实行。receipt source tuple 对当前命令逐值匹配；request 的 outcome/真实 requestSource tuple 还必须等于该 request receipt tuple。decision source 是 decision key，不能把它误要求等于 approval.requestSourceKey；decision outcome 的原 requestSource tuple 必须等真实 approval 的 requestSource tuple，并通过真实 request receipt 的身份/请求事实链核验。
- 原请求不可变事实：outcome.requestedAt/requestedBy/requestReason/requestEvidenceSnapshot/requestSource*、subject*、subjectSnapshot/hash 与真实 approval 原请求事实一致；canonical(subjectSnapshot) == canonical(payload.authoritySnapshot)，且 hashBusinessExceptionSnapshot(subjectSnapshot) == outcome.subjectSnapshotHash == 真实 approval.subjectSnapshotHash。对 request 还核 payload.requestReason/requestEvidenceSnapshot/requestedAt/requestedBy 同各原事实；对 decision 核它的 historical authoritySnapshot 与审批保存快照、原 request receipt 一致。当前重新 resolver 的权威不在此被覆盖，稍后完整 payload 比较仍可因当前权威变化拒绝。
- 历史 request outcome 固定 PENDING/version=0，decision/decisionComment/decidedAt/decidedBy/expiredAt/expiredBy/expiryReason 全为实际 null，不能把 APPROVED/EXPIRED 历史 outcome 填进 request receipt。真实行允许合法后继 PENDING(v0)、APPROVED/REJECTED(v1)、EXPIRED（未决定时 v1、APPROVED 后 v2），按实际 request/decision/expiry 不可变事实和状态组合核验，不要求历史 outcome 与当前整行字节相等。
- 历史 decision outcome 的 status == decision == payload.decision，decidedAt/decidedBy/decisionComment == payload 对应值，version == 原 payload.expectedVersion + 1（原 expectedVersion 非负安全整数），历史 expiry 三字段 null，所有原请求事实保留。真实当前行可同 APPROVED/REJECTED 状态与该版本/决定事实，或 APPROVED 后 EXPIRED 且版本为历史版本+1、原决定不变、真实 expiry 字段成立；REJECTED 不能伪造为后继 EXPIRED。decision 的原请求 outcome PENDING 仍只当历史请求 ACK，不推断当前有效批准。
- 只有这套关系核验通过，才取服务器原 requestedAt/decidedAt 做时间候选。时间与 payload/outcome/真实原事实必须相等；既有数据库 append-only receipt 与原请求/决定时间是来源。若同源历史记录不满足链，明确拒绝，不修复/改写原件，不重新签发日期。候选验证不新增 replay 成功判定。
- 取到的时间仍只是内部候选；以“当前重新解析的全部 body、当前 actor、当前 authority + 候选时间”构造完整命令，必须继续进入既有 requestApprovalPayload/decisionPayload/replayApprovalReceipt 的完整摘要与逐字 canonical 比较后才能成功。不得过滤时间字段、跳过真实 Accounting、返回自定义成功，或以 hash 看起来存在即信 outcome。已有损坏/不同命令/不同 body 收据不能当作“无收据”重新写，也不得自动修收据。
- 同 key 并发在既有 closure/source 锁内串行，第二个以已提交首个 receipt 的时间再完整比较；不同 body/actor/权威仍冲突。不得在 closure/source 锁前读取时间、先 cache Date 再等待锁、忽略唯一键冲突或换 key 重试。

AuditLog 和 receipt 的实际记录时间是现存数据库 createdAt（schema AuditLog:2949、receipt:4827），不是新造 recordedAt 字段。首写 requestedAt/decidedAt 为服务器首次命令业务时间；真正 replay 不重写它、不新增 audit/receipt。未来只读回复/客户端重试发生时间不是原业务时刻，也不能覆盖 createdAt；如产品要记录每次尝试，应另立操作日志范围，本稿不加入。

## 实际 UI 消费与上传边界

代码新增事实：page.tsx:6295–6305 refreshSubscriptionClosure 捕获异常并 setSubscriptionClosure(null)，loadOrder:6316–6323 因子调用吞异常而 fulfilled；Settlement:8253–8258 目前只有 onChanged=loadOrder。所以“调用 onChanged 完成后保留 pending”不足：刷新失败会卸载 ReturnSettlementStage 并丢 pending。page 既有 createReturnClosureReadback 接线:5301–5319 已有真实 order/case/权限绑定与 readViews WeakSet；pricing 已消费同一 helper。第五生产文件只接这套 reloadClosure/onClosureReadback 到 Settlement。

在 return-settlement-stage.tsx 内建立实际消费的 createReturnFinancialApprovalController（名称提案），UI 事件只通过此 controller 进入 upload/request/decision/retry/reload；测试也调用这个同一导出，不写另一个测试专用状态机。callbacks 为现有 API upload/request/decision、reloadClosure/onClosureReadback 与 onState；不得允许 caller 覆盖权限、时间、success 或 source。financial 成功/未知后的读回只走 helper，不再调用 onChanged=loadOrder；其他 settlement 动作继续原 onChanged，不更换通用刷新行为。

1. 上传前冻结。startRequest 同步检查并设置 controller busy（不用等 React setState），冻结 order/case/currentUser/revision/bill/type/当前能力绑定、File 引用及原说明/证据选择，并生成一次 key。generation token 与此次 frozen intent 一起保管，然后才 await upload。上传完成前不能接受同意图的第二次 start。收到 fileId 后再次核 generation/绑定/当前能力，才把已知 proof id 填进冻结 command 并实际发 approval POST；旧 case/user/revision 的 upload 回包不得提交到新绑定，也不得把旧 callback/closure props 混进新 body。失效异步结果仅遗留可能的旧案 proof，不写新审批，不自动删真实文件。
2. 上传未知单独状态。uploadFinancialProof:948 起没有请求 key，每次 randomUUID 后 storage put+FileObject.create。若上传请求返回结果未知/网络丢包且没有已知 fileId，进入 upload-unknown：approval POST=0，无可重放的完整审批命令，不自动重传上传、不猜 fileId、不拿同 hash 搜索结果作替代；明确 UI 提示上传结果未确定。先读当前案；用户显式选择“新意图重新上传”才可产生新 key/新 FileObject，可能留下原孤立 proof，报告此边界。此方案不改上传 DTO/storage，不声称上传幂等或自动 cleanup；普通 retry 对 upload-unknown 不可发 POST/upload。
3. proof 已知后的审批未知。只在已知 proof/evidenceIds 时冻结完整审批 body（原 key/type/bill/revision/evidenceIds/reason）并发送。approval POST 响应丢失可 retry 原 command，上传次数仍一次，body/key 完全相同。decision 首发冻结原 approvalId/expectedVersion/decision/comment/key，未知也只 retry 原 body。原 ACK 成功但 GET 失败，保留 committed + refresh-required，只 reload，不重新 POST；HTTP 明确拒绝标 changed/blocked，先读回/人工新意图，不能无限自动 retry。
4. 并发与生命周期。controller generation 覆盖 A→B→A、用户/权限/案/版本/输入变化；每次 GET 加递增 readSequence，仅最新且同 generation 的 helper view 可交 onClosureReadback。在调用 publish 前核当前 token，在 await 后再核，旧 finally 不可清新 busy。bind 完全相同只保留 pending，合法 readback 同绑定更新不重建 controller；相同权限不同用户也必须失效（page helper 未包含用户ID，controller 自己绑定用户）。组件 effect 每个 setup 新建 instance，cleanup dispose 该 instance，并仅在 ref===instance 时清 ref；disposed 永不复用。React StrictMode setup→cleanup→setup 不能复活旧对象，也不从 effect 自动触发写操作；真实新的 instance 才接受新事件。Props回调/binding依赖改变按 generation 消费，不能只用 memo 永存被 dispose 的对象。
5. 用户编辑未解决意图时禁止无声替换：明确撤销旧 retry/读回并重新人工选择，才建立新 key；UI busy/pending 阻止冲突操作。组件真正卸载或整页 reload 的跨会话恢复不在此范围；通用外部 loadOrder 仍可能卸载，不能宣称长期 pending 存活。这里闭合的是 financial 自己成功后的受管读回失败，失败不调用 setClosure(null)，保持原展示及 pending 供安全 reload。

未来 UI 证据分层：web Vitest 当前 environment=node，renderToStaticMarkup 不运行 effects。deferred 测试要使用实际 financial controller + 真实 createReturnClosureReadback（低层 apiFetch mock），覆盖真实 helper rejected/品牌 readViews/绑定失效；setup→dispose→new setup 模拟严格生命周期并静态核真实组件在 effect 内创建，不能把静态 markup 当作实际浏览器 StrictMode 运行。真实 DOM StrictMode/browser 另记 NOT_RUN，不能为本切片临时安装 DOM 平台/依赖。
## 精确后续文件范围（本窄切片未涵盖，需精确审查后独立实施）

生产五文件：
- apps/api/src/subscription-closure/subscription-return-governance.service.ts：financial 两类型分派，不动 pricing/registration 副作用。
- apps/api/src/asset-accounting/asset-accounting.service.ts：两条 financial 窄消费入口及复用现有执行核心/guards/audit。
- apps/api/src/asset-accounting/asset-accounting.repository.ts：financial 内部锁内候选时间与真实原审批事实一致性校验；完整 replay predicate 保持原样。
- apps/web/src/components/subscription-closure/return-settlement-stage.tsx：实际 financial 窄 controller、上传前冻结/同步 busy、未知上传 fail-closed、显式原命令 retry、generation/读序/lifecycle、消费真实读回 helper。
- apps/web/src/app/orders/[id]/page.tsx：仅给 ReturnSettlementStage 加 reloadClosure={returnClosureReadback.reloadClosure} 与 onClosureReadback={returnClosureReadback.onClosureReadback}，复用当前 page 真实 helper；不改通用 loadOrder/refreshSubscriptionClosure 或其他工作区刷新。

测试四文件：apps/api/test/subscription-closure-financial.spec.ts（真实 governance/Accounting guards，明确其现有 repository 是替身）、apps/api/test/asset-accounting.repository.spec.ts（真实 repository 与 fake transaction IO，完整比较/污染/活性/候选关系）、apps/api/test/subscription-expiry-return.integration.spec.ts（主控独占实际 PG 三层组合）、apps/web/test/subscription-return-browser-actions.spec.tsx（沿现有实际 controller/UI 消费测试方式）。不修改 DTO/controller/API 包装器/Auth/Schema/manifest/storage/上传 API，不新增通用 parser 或授权品牌。page 精确仅本接线，其他动作继续原 onChanged，不向所有工作区扩散。

## 未来真实 RED → GREEN（此审计全部 NOT_RUN）

1. 主控在现有 prepareFinancialApproval(prisma,type) 两类型 fixture 接真实 governance + AssetAccountingService + AssetAccountingRepository + AuditService；proof 使用既有真实 uploadFinancialProof（storage IO 仍受控）。同 key/完整原 body 第一次成功后，等待并记录实际 Date.now() 严格晚于 persisted requestedAt（decision 类似），再调用。期待相同历史 outcome、完整 truth 无新增、receipt/audit 各仅首写一份；当前源码会在前置仍相同时真实 SOURCE_CONFLICT。不能用 repository stub 或固定假时钟冒充这个 RED；比较全部 receipt payload，包括时间，而非只比较结果 id。
2. decision 必须原 expectedVersion 再调用，并断言当前审批 version 仅 +1。同 key 改 reason/comment/decision/evidence/expectedVersion/有效 actor、原时间候选污染、commandType/costEntryId/approvalId/outcome/真实原时间不一致各独立拒绝，truth 无新增。覆盖 canonical 等价证据去重/排序仍合法；字节无关的请求顺序不是新意图。
3. 权限撤销：真实 HTTP Auth/Permissions 路径仍重读当前权限（现有代码事实）；服务组合用新 context.permissions=[] 验证前置拒绝，但不得称它证明 HTTP 当前权限刷新。financial 服务新增当前 actor 活性拒绝用真实 user 状态变化；requester 决定先 SELF_APPROVAL_FORBIDDEN。不写 Auth 代码；若现有 PG fixture 没有 HTTP server，只分层报告，不能声称已跑 HTTP。
4. 同 key/current revision 变更或 evidence 失效验证正确前置 CLOSURE_*；余额部分变化仍合法时验证已有 receipt SOURCE_CONFLICT，尚无 decision receipt 时 SNAPSHOT_MISMATCH；新 key不是 replay，仍需要全部当前权威。原 request ACK 在审批已经决定/过期后可能是历史 PENDING，独立 readback/recordDisposition 必须拒绝过期授权。
5. 同 key/同 body 两个并发真实事务只能一个首写，一份 receipt/audit；不同 body 并发一个成功另一个 SOURCE_CONFLICT，不换 UUID/key、不留下半写。异常中断/rollback 后无 receipt 的下一次才可新首写。
6. registration/pricing 路径回归保持原有跨时刻冲突/未修范围；预置已完成 registration ESIGN job，financial replay 不得调用 registration updateMany，任务全部状态/lease/attempt 完全不变。不得声称本设计已修 registration replay。
7. 实际 UI mock API 首请求成功但响应丢失、decision 响应丢失、只刷新失败：精确断言原 key/body/version/evidence 不变、proof 上传一次；绑定/当前用户/编辑变化停 retry；双击一个命令；当前权限失去后禁用动作。API mock 不代表实际浏览器/线上；真实 PG 不代表 HTTP/真实 storage。


### 收据污染反例的专门要求

只在 asset-accounting.repository.spec.ts 的受控 transaction rows 改坏，保持 command 全件和 payloadSnapshot/payloadHash 正确：逐个只改 receipt.actorId、receipt.approvalId、outcome.id、outcome.requestedBy/decidedBy、outcome.requestSource*、outcome.subjectId/subjectField、outcome.subjectSnapshotHash、outcome.subjectSnapshot、outcome.requestReason/evidence、outcome.requestedAt/decidedAt、outcome.status/decision/version、request 历史 decision/expiry null、decision 历史 expiry null。另改真实 fake approval 原事实或其 hash，以证明不能只相信 outcome 的自洽 hash。每个反例必须命中新窄消费链 guard，后续真实 request/decide write=0；其中完整 payload 仍正确的反例不能靠旧 SOURCE_CONFLICT 碰巧拒绝代替链验证。真假相邻对照保留真实当前 APPROVED/EXPIRED 后继，不整行相等误拒。

PG 禁止改 append-only receipt/audit 或伪造历史审批行来做这些污染反例。PG 只用真实服务 producer 产生 receipt、request→decision→允许 expiry 的合法状态和新实际业务权威变化验证；污染输入是受控 rows 单元证据，不能称为实际 PG 污染测试。

### UI 的实际窄 controller RED

- 使用实际 page helper + deferred GET，approval 成功后读回 reject：pending/committed 保留、不 publish null、不卸载式重置，retry 只 GET。检查实际 page 第五文件向 Settlement 传两 props，actual financial handler 不走 legacy onChanged；静态源码检查仅证明接线，helper/controller 动态测试证明消费，不合并成已跑完整 page/browser。
- upload 尚 pending 时同步第二点击：upload 一次、approval POST0；A→B→A/user/revision/权限变化后旧 upload resolve(fileId)，approval POST 仍0，旧 finally 不清新 busy。输入在 await 前已固定，改变页面字段不能改已发意图。
- upload 响应丢失：upload-unknown、无 fileId、approval POST0；普通 retry 仍两项 POST0，显式人工新意图才另一次 upload。已知 proof 后 approval 响应丢失：原 key/body/evidenceId 原样两次，upload 一次；decision同理保留 original expectedVersion。
- 同绑定两 GET 后新先完成、旧后完成，只发布新读；假 view/别案view不能通过 createReturnClosureReadback 的 readViews；binding/user/权限失效旧回包不发布。setup/cleanup/setup 新实例可用，旧实例/deferred不写不发布；旧 finally 不能释放当前实例忙态。Node 模拟此生命周期不冒称真实 DOM StrictMode。

## 可执行任务次序与最终验证边界（只列未来，全部未运行）

T0 冻结主控指定实施 source；保留本 v1/v2 原件，先精确审查这五生产+四测试文件与上述窄接口，按新独立切片分工，不与 Financial/PG owner 并写。主控 fresh/preflight 编排如原 financial plan，未知/旧开发目标不借用。

T1 先在既有 PG prepareFinancialApproval 中新增真实三层的跨毫秒 request/decision 重试 RED，保存 source/输入全件、首原服务器时间、实际后调用 clock、receipt/audit/truth 原件、exit；主控唯一 PG 执行者。另先在 repository fake rows 得到 outcome/actor/hash 保持 payloadHash 正确的关系 RED。不能在局部 service stub 中造 replay 成功。

T2 最小实现 financial-only Accounting/server timestamp 候选关系 + governance 分派，完整 payload/replay predicate 不改。跑相邻良性后继与全部 guard unit GREEN；旧 registration/pricing 时序不修，不导出 wrote/success 覆盖项。独立 reviewer 核时间来源与完整链后再进入 UI。

T3 先新增实际 financial controller/真实 readback helper 的 upload-unknown、旧 upload回包、approval未知、refresh-required 与 lifecycle RED。同步冻结/busy→控制器→page两props精确接线，实现窄 GREEN。保留 proof 上传已成功但响应丢失可能孤立文件的限制，不改 storage/上传 contract。

T4 最终同 source 的完整离线门禁（不使用自动 prisma generate/typecheck wrapper，不安装依赖；已有生成客户端/依赖缺失则报阻断，不连接 DB）：

```text
pnpm --filter @subscription-saas/api exec vitest run --project unit test/subscription-closure-financial.spec.ts test/asset-accounting.repository.spec.ts test/asset-accounting.service.spec.ts test/subscription-closure-pricing.spec.ts test/subscription-closure.controller.spec.ts test/subscription-return-governance-gate.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/subscription-return-browser-actions.spec.tsx test/subscription-return-three-stage.spec.tsx
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/api exec eslint src/subscription-closure/subscription-return-governance.service.ts src/asset-accounting/asset-accounting.service.ts src/asset-accounting/asset-accounting.repository.ts test/subscription-closure-financial.spec.ts test/asset-accounting.repository.spec.ts test/subscription-expiry-return.integration.spec.ts
pnpm --filter @subscription-saas/web exec eslint "src/app/orders/[id]/page.tsx" src/components/subscription-closure/return-settlement-stage.tsx test/subscription-return-browser-actions.spec.tsx
git diff --check
```

这些是后续 offline 指定命令，不是本 DOC 已通过记录；在 PowerShell quoted [id] 文件名按 CLI 字符串传递，读写必须 LiteralPath。逐次保存完整 stdout/stderr/exit/UTC/source+输入摘要、失败原件和最终同字节 counts，不拼接不同源中间 GREEN。

T5 离线/独立代码 review 通过并精确提交后，由主控唯一地在干净同源候选执行现有 B5 capture，串行完整 suite api.subscription-expiry-return.postgres → api.asset-operations.postgres。原 wrapper 相对路径 db-capture/b5-capture-invocation.ps1 为主控忽略的受控证据资产，此 DOC 不读取或复制其环境/secret；执行前主控确认其实际绝对路径、原件摘要与获审参数。固定参数名 -Prefix/-SuiteId，两个 ID 来自 release/contracts/database-test-manifest.v1.json，launcher 是 scripts/release/run-database-suite.mjs。本轮保留新的 prefix financial-approval-retry-expiry-fresh-1 / financial-approval-retry-asset-fresh-1，任一已有原件则停止不用覆盖；命令结构为 wrapper -Prefix 上述前缀 -SuiteId 对应suite，未绑定真实 wrapper 路径/受控窗口前不可粘贴执行。

禁止直接 vitest PG 文件、ambient DATABASE_URL、额外数据库/旧目标、修改 suite/manifest、并发 PG、全局清表、修改 append-only 证据。保存 report/receipt/raw stdout stderr/源标识/真正 counts/exit/目标身份权限读回，按 B5 精确退役，任一失败按第一 guard 保留诊断。PG 的 storage 合成 IO/直接服务权限上下文不等于真实 HTTP/browser/storage；真实网络/资金/线上全部 NOT_RUN。

T6 reviewer 按同字节 source/hashes、完整门禁与证据层级验收；只有实际执行后才登记通过。此稿不勾选任何实现/RED/GREEN 项，不因 parent 此刻 PG 已绿就称该设计通过。

交付边界：本设计已获独立 DOC ACCEPT，尚不是已验证修复；实施时保持获审时间候选关系、窄接口及失败分类，再以实际反例和完整门禁证明。前一 Financial 修复的 PG 结果不作为本设计的实施证据。
