# R4 fresh 反例追加：人工定价证据集合与 HTTP fixture 隔离

本稿是已批准阶段1审计施工的窄追加，前向补充 `2026-09-26-stage1-return-browser-gap-plan.md`，不改原计划 hash、业务守卫或历史失败。使用原 SDD 主控/实现/独立审查分工；通过本稿独立审查后才修改原只读服务范围。不是新的线上操作、审批或数据授权。

## 已有事实与范围

源 `f02af8de8f30a25fc9c04f360da37b24e507366d` 的完整 expiry fresh 实际 94 collected/selected/executed、91 passed、3 failed，exit1；报告保管、独立读回和精确目标退役完成。原件保留于 ignored `node_modules/.cache/sdd/stage1-return-browser-gap/db-capture/r4-browser-expiry-fresh-1.*`，report digest `sha256:b16ac2fc94bc48d63d437d7933f50a26393b472d9ba63d5ce04e370bc98ed951`。不能覆盖此记录或把原件改成成功。

两项旧 Task7 调度断言受到新增 HTTP fixture 的三个 ACTIVE 到期计划影响。既有 cleanup 故意保留不可变事实，且 scheduler 查询全库。新增 HTTP 断言自身通过；解决 fixture 隔离，不降低旧全局断言或移动用例掩盖顺序依赖。

第三项真实调用人工计价，在缺审批守卫前收到 `CLOSURE_PRICING_APPROVAL_AUTHORITY_MISMATCH`。证据上传关联 CHECKLIST_ITEM，真实实物接收为同一 evidenceId 追加 DAMAGE_PROOF；Schema 只约束来源三元组唯一。`resolveClosureApprovalAuthority` 的 PRICING_OVERRIDE 将关联行 count 与去重后的请求 ID 数比较，合法多关联会误拒；反向也可能用一个 ID 的多行抵消另一缺失 ID。当前 `createPricing` 的外层 Set 检查不替代审批请求入口的独立核验。

精确可写代码/测试：

- 实现者：`apps/api/src/subscription-closure/subscription-return-governance.service.ts`，仅 PRICING_OVERRIDE 证据成员校验；`apps/api/test/subscription-closure-pricing.spec.ts`，既有真实服务入口回归。
- 主控：`apps/api/test/subscription-expiry-return.integration.spec.ts`，仅三个新增 HTTP 用例的 fixture 隔离、真实多关联事实断言及本次人工计价反例；已通过的其他行为与旧断言不变。
- 主控文档：本文件、后续真实验收报告；原冻结计划不改。

## 1. HTTP fixture 的调度隔离

三个新增 HTTP 用例的全部行为和无副作用断言结束后，在 finally 中关闭 HTTP app，并仅按该 fixture 的 scheduleId/orderId 将 ACTIVE 可变计费计划置为 PAUSED，记录 fixture 专用 pauseReason、version 加一并读回确认。用嵌套 finally 保证 HTTP 关闭异常仍进入此精确隔离；不修改其他 fixture、全局清理 helper 或 append-only 事件/账单/审计/closure 事实，不删除记录。测试库仍只由原 Launcher 在保管后精确退役。记录这是测试结束后的隔离，不是正常退车生产逻辑或完成证明。

## 2. 人工定价证据成员校验

先通过既有真实 `requestApproval` / `createPricing` 入口建立 RED。测试 fixture 的 count/findMany 从同一证据关联 rows 按真实 where 条件计算，不能仅硬编码计数制造结果。覆盖：

1. A 的 checklist+damage 两关联及 B 的合法关联，请求证据集合 A/B 完整，审批输入去重排序保持原规则。
2. 相同真实多关联，未知非空 approvalId 进入原 `CLOSURE_PRICING_APPROVAL_REQUIRED`，账单/收费行零写；有效当前批准可通过，失效/拒绝/价格或版本不符仍拒绝。
3. 缺失或其他案的 B，包含 A 两关联恰好抵消缺项的反例，拒绝为原 AUTHORITY_MISMATCH，审批 delegate、账单、收费行零写。
4. 重复请求 ID 按原去重规则处理；合同、人工条款、delta 与当前 settlement 守卫不变。

最小生产改动：PRICING_OVERRIDE 原 count 改为 `findMany({ where: { closureCaseId, evidenceId: { in: evidenceIds } }, select: { evidenceId: true } })`；构造 ID Set，原条件改为存在请求 ID 未包含在 Set 即拒绝。禁止用 `count >= length`，不增加公开 helper/export、DTO、Schema、migration、依赖或可配置绕过。事务和行锁、合同/条款/delta/current revision、批准状态/快照/价格、错误码和检查次序全部保留。

本次不修改 registration 或 financial 审批分支。邻近行数校验存在待独立验证风险，尤其 financial 的两来源行数相加可能被重复关联抵消缺项；在审计后续项保留，不能把本次通过宣称为这些分支已验证。

## 3. 验证与收口

沿本开发轮已完成的受控 preflight，不开 ambient DB。生产改动前保留真实 RED；聚焦 pricing 单元 GREEN、API typecheck、三个改动文件的 lint/格式与 diff 检查通过后独立审查并精确提交。原 Web 87/87、API 六文件197/197保持其原实际 source，不因本次测试-only或新增窄 API 变动虚报重跑。

最终干净同源通过原未修改 B5 capture 串行完整 expiry fresh → asset fresh；新的 prefix 保存新原件，无 filter/skip/only。必须读回 counts/exit/report/receipt/digest/权限和退役事实，失败即保留原件继续诊断。PG 新增断言明确该证据存在 evidencePurpose 为 CHECKLIST_PROOF 与 DAMAGE_PROOF 的两条不同用途关联（前者绑定 checklistItemId，上传 targetType 为 CHECKLIST_ITEM），再证明缺审批拒绝及原账单/版本不变；这不构成真实人工批准或供应商事实。

独立审查完整变更与实际证据后，主控才整合主候选、追加验收报告和原执行索引。实际浏览器、线上已停 Docker、R2.2、最终双链与阶段1签字仍是独立未完成项；本次不执行线上恢复/部署/渠道/资金/CI。
