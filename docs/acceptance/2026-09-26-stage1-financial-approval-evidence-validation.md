# Stage 1 Closure 财务审批接线与证据成员修复验证

执行日期：2026-09-26。实际干净测试源 `0ca44e6eddf4c6be148bf46f9e75e0206b695f0d`，完整 expiry 98/98、asset 33/33，合计131/131；组合单测186/186，API类型、owned lint和差异检查通过。两套报告/receipt已独立重开校验并精确退役。本文仅覆盖本地修复，不构成真实浏览器、渠道、最终镜像或阶段1签字。

## 改动和范围

基线为 `a3ba5746dcb0f0b72b37fd0c80acfc42e58964b9`，沿[获审计划](../superpowers/plans/2026-09-26-stage1-financial-approval-evidence-plan.md)实施，一个生产文件、两个既有测试文件：

- `59940f19c1d45c44328c1fc17ba192cda7f18121`：governance 的 request/decide 将原服务端生成的 `source.key` 同时传给 Accounting context。保留请求与决定的各自前缀，不读取 caller 自定义 context key，不增加权限或默认 actor。此前真实 Accounting 会因缺键拒绝合法调用。
- `a7322df3d4343bbde96cf0134cb2fabc8ddd0ba8`：仅 financial authority 分支将 link count + proof count 改为两来源ID并集逐项覆盖。真实上传/实物接收可让一个 A 同时具有 CHECKLIST_PROOF、DAMAGE_PROOF；A 的两行现在不能替代缺失、他案或错误目录的 B/P。单来源、合法多关联、请求ID去重排序仍保留。
- `0ca44e6eddf4c6be148bf46f9e75e0206b695f0d`：在原 expiry suite 增加四个真实PG组合用例，分别覆盖WAIVER/WRITE_OFF合法链和余额/结算版本变化。未新增suite或跳过原测试。

原事务、锁序、权限、自批限制、当前revision/hash/bill/amount守卫、Accounting审计和命令收据保持。未改Accounting实现、controller/DTO、Schema/migration、权限定义、seed、shared export、manifest/launcher、pricing/registration权威分支或recordDisposition。三个代码切片已分别独立审查接受；其中PG切片最初为静态接受，实际结果由下述完整门禁补足。

## 反例与离线门禁

| 原件 | 实际结果 | 解释 |
| --- | --- | --- |
| `financial-key.red.log/.exit` | 24执行，18通过/6失败，exit1 | 四个合法request/decide先受真实Accounting缺键guard阻断；另两个自批测试也提前停在该guard，不能称旧自批曾被放行。 |
| `financial-key.green.final.log/.exit` | 24/24，exit0 | 真实Accounting入口通过，权限与自批守卫保留；repository/audit IO仍是明确的unit替身。 |
| `financial-membership.red.log/.exit` | 100执行，76通过/24失败，exit1 | 六种重复link掩盖缺失/跨案/错误proof目录 × 两类型 × 两入口，均错误resolve；不称unit替身已实际完成非法PG处置。 |
| `financial-membership.green.final.log/.exit` | 104/104，exit0 | 首GREEN100后补四项既有缺bill输入分类；与其他聚焦计数重叠，不累加。 |
| `final-offline.unit5.log/.meta.json` | 五文件186/186，exit0 | financial、pricing、Accounting service、closure controller、governance gate；同源0ca44e6e，11:36:49Z闭合。 |
| `final-offline.api-types.*` / `owned-lint.*` / `diff-check.*` | 均exit0 | 同源API tsc在11:38:09Z闭合，三文件lint在11:38:15Z闭合；源和文件摘要在`final-offline.inputs.json`。 |

第一轮Task1 lint有两个未使用测试参数，原失败日志保留，修正后最终lint0。格式检查：governance原基线/current均false，保留既有例外；financial unit从false变true；expiry原基线/current均true。没有整文件格式化生产大文件或放宽lint策略。最终五文件日志SHA256为 `f0e553b1813f9e7c75f837ebe405168733323e85532354c6497f272c3bfc7465`。

最终三个输入SHA256：

| 文件 | SHA256 |
| --- | --- |
| `apps/api/src/subscription-closure/subscription-return-governance.service.ts` | `7fb5dd6d2cea93100ef95f2e985ab4854b21764515e787dba7beac8dd62f7494` |
| `apps/api/test/subscription-closure-financial.spec.ts` | `78f13925312bcdf28825f19a676f89b629c0b762c9f1cdbf46ff0c7d2f72fec4` |
| `apps/api/test/subscription-expiry-return.integration.spec.ts` | `be59a1f961636983468e9d002f780d2fe8b3ca9aab62225c941ad973db48c6bd` |

## 真实PG覆盖与边界

真实upload/receipt产生A的两类关联；真实uploadFinancialProof持久化P的FileObject、hash、size和上传人。请求R与独立决定D都是ACTIVE数据库用户，经真实Governance、Accounting service/repository、Audit、Prisma写PENDING→APPROVED，随后真实recordDisposition写WAIVED或WRITTEN_OFF；没有直接插入APPROVED。缺项/他案证据、缺权限、自批、错误expectedVersion、不带批准及不在批准证据内的本案proof均拒绝，联合事实不变。

合法处置后账单remainingAmount=0、CANCELLED，paidAmount不伪增，PaymentRecord/PaymentWriteOff无新增；FinancialStatus分别为SETTLED/WRITTEN_OFF，处置amount=100 cents且绑定真实approval。Accounting CREATE/APPROVE审计和EXCEPTION_REQUEST/EXCEPTION_DECIDE收据各一次，操作者分别R/D；历史settlement、order/contract及运营状态不伪造。同处置key/body重放返回原事实且零新增，改detail仍冲突。recordDisposition原本未发额外AuditLog，本轮不要求或声称新增此审计，处置事实仍持久化。

真实FinanceService将余额100→99后，旧请求的决定被snapshot mismatch拒绝；重新真实批准99后支付至98，旧批准不能处置。再对98真实请求/批准，先读回批准金额与账单一致、原revision/hash匹配，然后真实propose/finalize产生新revision，旧批准仍拒绝；不改旧审批或结算。`pending.version+1`证明错误/超前expectedVersion拒绝，不冒称历史旧版本更新。

该版本用例打印`resultHashChanged`诊断，但原launcher成功路径仅保留sanitized log摘要，未独立保管该布尔原值；本报告不报告其值，也不将该组合提升为单独隔离hash字段的PG反例。保管的是完整launcher stdout/stderr、结构化报告/receipt与摘要，不宣称保留了全部内部Vitest成功日志。

Unit的Prisma rows/repository/audit IO为替身，不能替代PG锁/持久化。PG的RequestUser权限是fixture身份边界，storage/签署/支付provider为合成输入，100 cents账单为既有历史fixture；不是JWT、真实浏览器、法大大或外部资金验收。仅在断言后按精确scheduleId/orderId/ACTIVE/version暂停测试计划并读回，不删除append-only事实；launcher负责最终目标退役。

## 数据库保管与独立读回

两套在同一干净0ca44e6e、原未修改B5 capture/launcher下串行fresh执行。每套collected=selected=executed=passed，failed/skipped/filtered/cancelled/todo均0、exit0。主控另用原Read-B5FreshResult重开报告/receipt，核文件SHA、stdout/stored canonical与receipt content/readback摘要一致，七项runtime特权/ownership全false；精确run目录已移除，旧fixed target/secrets未复活。

| suite | UTC开始 / 关闭 | runId / operationId |
| --- | --- | --- |
| `api.subscription-expiry-return.postgres`，98/98 | `11:39:37.9534204Z` / `11:47:26.2105970Z` | `8d085262-d084-4cac-83fb-ae66acd6cbef` / `253a3f57-5196-4afd-b6fa-cafd470f5c46` |
| `api.asset-operations.postgres`，33/33 | `11:48:26.5021460Z` / `11:49:53.8579511Z` | `dde644df-d8e0-47d4-a904-59880e502bbf` / `9a2cb256-0493-45b2-9796-c54a36e07576` |

| suite | report SHA256 / bytes | receiptId / receipt文件SHA256 |
| --- | --- | --- |
| expiry | `927e32f280d517b093f08a83c950a872e6494d09839ac3909bfdd09310ce38b8` / 970 | `a76a27c2-164d-4bbf-90d5-6b9278229759` / `984d54c7b6d8c5adabaa643ebcc37159f2f4a75401994f11998952c6ccc0b320` |
| asset | `da75a9da9f8e9e4cd2d47636e960c2689832095fbbbe64181202eb5dfa3f2ada` / 960 | `5a450282-9b07-4d3c-8bfc-4060800b1c69` / `92caf0350ced99983176cbd111c0cbaac1da8f0784db51380834ae4e1243f314` |

expiry目标为`s1ci_3a901504ed405dda09a6648d` / OID16386，fingerprint `sha256:0f4799ccc42343bb82ad73909919c8a8abde988c572b53935b55ef248fd56c48`；asset为`s1ci_af7988b174d09dfb2ac31458` / OID16386，fingerprint `sha256:8c8517629e136a429676b0965c7d28417f5484998c5c9d7693d9f027a0a5acb6`。非同一个目标复用。

原件根：`D:/Projects/auto-subscription-platform/.worktrees/stage1-financial-evidence-20260926/node_modules/.cache/sdd/financial-evidence-20260926/`。捕获前缀是`db-capture/financial-approval-expiry-fresh-1`、`db-capture/financial-approval-asset-fresh-1`；`financial-pg-evidence-summary.json`保存独立读回完整索引；持久report/receipt在同worktree的`.release-local/evidence/`。两套均首轮通过，无本轮PG失败被省略。

现有128迁移在fresh目标执行deploy/status/diff，未新增迁移或线上DDL。契约176文件、68Schema、13个commandContract；repository digest `9630a34b556da831b260396b8aa28e2176cb1e113a174962ff09a94382d4dbb3`，migration digest `65ebe3208fc618ae82ad24f66b793e9bddd7464526dd45b8a0d9893d24a0ff62`。manifest digest `f4892d83e4943fe8acaf729bf4fd87cc41fb143f6b6abc55e8b8e80929f74116`，discovery digest `4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a`，95候选/39登记/56例外/0未分类。Node24.14.0、pnpm11.4.0、Prisma7.8.0仅为本地辅助环境，不是最终Node22镜像。

## 独立待办与阶段1门槛

- 跨时刻审批重试未修：前置检查仍通过且两次服务器时间不同毫秒时，同key完整payload会SOURCE_CONFLICT；同毫秒不必然冲突。UI再次点击还会创建新key，request重新上传proof，尚不具备稳定未知结果重试。已做独立只读设计审计，建议financial两类型锁内复用经核验的服务器首写时间、保持完整payload比较，并冻结UI命令；不向HTTP开放任意时间回填，不把registration的签署job重新排队。本修复与设计验证须另成单元。
- Registration有界审计追踪了upload/replay/supersede、physical receipt、unilateral seal三个link写入点，未发现同case/item/evidence重复行的现有producer；DB没有该三元组唯一约束，count仍是防御缺口。正常e-sign reconcile还有精确item的Set.every，重复A不能替代B。该结论为只读审计，不称PG证明无漏洞或覆盖全部历史数据；最小防御矩阵另排。
- 未读取或修复真实历史审批/处置数据，未改历史snapshot/receipt/hash。线上Docker未恢复；需要线上联调时须先按用户指示恢复并核健康。本轮没有服务器、CI、provider或资金动作。
- H1实际owner/host、H2私密存储writer/独立reader、expected-schema来源输入，完整R2.2/3/4、最终Node22三镜像fresh/snapshot双链、真实Admin/Portal A/B及成熟样本、两次非空维护与恢复演练仍开放；阶段1未收口。

本轮代码、完整原件及本文已获独立终审限定ACCEPT。审查者实际重开两套report/receipt并复算文件与canonical摘要、counts/source、七项权限和退役，核实四份最终离线日志/关闭状态及三个现场输入SHA；没有重复运行测试或扩大为真实浏览器、线上、最终Node22或阶段1收口。
