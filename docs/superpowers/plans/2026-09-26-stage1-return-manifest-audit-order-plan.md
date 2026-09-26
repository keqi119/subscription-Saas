# 退车签署 task audit 同时刻排序诊断与限域修复计划（独立设计审查通过）

> 执行方式：沿已批准审计计划使用 subagent-driven-development；独立 DOC 审查已接受完整 snapshot visited 检测。实施及最终数据库门禁仍须按实际证据验收。

本轮财务审批重试候选 `d333a5cd1ff516a9e20c2daa54e65e0ca2586dac` 的最终离线全部通过，完整 expiry fresh-2 为 111/112。唯一 pending WAIVER 用例尚未进入财务逻辑，在既有真实签署 producer 的 callback 自动 finalize 后，`validateExactReturnManifestSuccessorChain` 返回 false；具体子谓词和当时行值没有保存在 launcher 摘要中。不能把以下静态风险直接写成本次 PG 已证明的根因。

用户已批准按 Stage 1 审计计划继续实施；此文件是本轮门禁暴露的窄追加，不增加真实环境、渠道或资金操作。先有确定性反例和独立设计审查，再修改生产；缺证据时不得靠盲重跑、延迟或删除校验结束本轮。

## 已核事实与具体范围

- `subscription-closure.service.ts` 的 `validateProducedReturnManifestSuccessorChain` 读取 taskAudits 时按 `createdAt,id` 排序，然后将下标 0–3 当作 CREATE / start / complete / finalize，并核全部相邻 before/after snapshot。
- `return-manifest-esign.service.ts` 四阶段独立取真实 `clock_timestamp()` 后转换为 JS Date，再显式写入 task 阶段时间与 audit.createdAt。没有严格不同毫秒的来源契约；AuditLog 的 UUID 不表示因果顺序。同毫秒合法记录有被错误排序的可能。
- 当前签署 unit 只覆盖 surface / provider / config，未覆盖完整合法链的同毫秒逆 ID 情形。财务准备器各案/actor/provider/storage 均独立，未发现确定的夹具错误；不得加 fixture sleep 掩盖。
- 当前生产源与刚完成 fresh-2 的 128 migrations / status / diff / 七权限 false / 退役结果相同；新 round 先记录 git status 和 skip-dotenv Prisma validate，沿该同字节 fresh 前置。无 schema、迁移、依赖、权限或 manifest 变更。

只允许追加以下两个文件的生产/单元范围：

1. `apps/api/test/return-manifest-esign.service.spec.ts`：确定性合法事实与逆序反例，以及损坏/歧义/时间逆序拒绝。
2. `apps/api/src/subscription-closure/subscription-closure.service.ts`：仅该 validator 的 task audit 消费排序与私有辅助函数；不改 producer、DTO、外部接口、通用审计系统或其他业务分支，不重排/改写数据库原审计。

既有财务五生产/四测试字节冻结。其已有 PG oracle 修正及旧失败原件保留。本次最后仍运行同一实际 expiry suite 和 asset suite，不过滤失败用例、不修改 suite/manifest；若诊断确需扩大文件/模型/共享契约，先给出具体理由与新限域说明。

## T1：先证明风险

实施者在既有隔离 code worktree，仅修改上述 unit；先核 API src 与 d333 一致。使用实际公开 `validateExactReturnManifestSuccessorChain`，完整合法 producer 事实的 controlled IO rows，查询替身真实执行 `createdAt,id` 排序。

- 正常递增时间完整合法链必须先 valid。
- 四阶段合法同毫秒、ID 与真实快照链相反，预期仍 valid，当前实现应得到确定性 RED。
- 本次使用按真实 producer 字段构造的完整 controlled 事实 fixture，不运行真实 producer。现有完整真实 producer fixture 仅在 PG suite 私有辅助函数内，直接导入会注册数据库 suite；不为此引入字体、环境或新测试设施。先以实际公开 validator 接受正常时间完整链，再用同一 factory 参数重新生成所有相同事实的日期、receipt 与 hash 绑定，验证同毫秒顺 ID 对照和逆 ID 反例。查询替身按实际 where 与 createdAt,id 排序；不能复制 validator 写测试专用镜像，也不能把独立数组排序失败称为完整链反例，不得通过缺字段或跳过子谓词让反例变红。
- 保存实际生产源、测试字节摘要、命令、退出值和完整日志。controlled rows 不冒充当次 PG 行值，也不声称此 RED 自动确定 fresh-2 的历史根因。

## T2：条件式最小修复

仅当 T1 确证且本计划获独立接受后，task audit 顺序改从完整 snapshot 因果关系解析：

1. 输入必须恰四条，不接受重复 ID。唯一 CREATE 且 beforeSnapshot 为 null 是起点。
2. 每一步只接受唯一剩余 UPDATE，其完整 beforeSnapshot 与上一条完整 afterSnapshot 按既有 canonical 比较一致。跟踪已访问的完整 afterSnapshot 状态；候选 afterSnapshot 若等于当前或任意更早状态则拒绝，从而显式拒绝自环与闭环。分叉、断链、循环、无后继或多后继都拒绝，不选第一个凑链。
3. 恰好消费全部四条，最后 afterSnapshot 仍须等于实际当前 task 的完整既有投影。
4. 原 validator 的 actor / entity / module / action / request / source / files / signers / callback / receipt / revision / hash / 生命周期检查全部保留。四个有语义的位置仍逐个与 task.createdAt / startedAt / completedAt / updatedAt 精确相等，并保持非递减，允许合法相等而不允许逆序。
5. 不新增 caller `verified` 标志、第二套 parser、通用审计重排接口；私有 helper 只返回唯一合法顺序或拒绝。查库排序可保留作稳定读取，但不能再把随机 ID 排名当作业务顺序。

需要的回归：正常递增与同毫秒各排列（至少逆 ID 和交错）、同毫秒/不同毫秒但断链、额外或缺失行、重复 ID、双 CREATE、分叉/歧义、显式 CREATE null→A / UPDATE A→B / B→C / C→A 四行闭环与 UPDATE 自环、错 actor/entity/source、阶段时间不匹配或倒退、最终快照不匹配。测试必须消费实际新 validator，不以 helper 单独通过代替全链。

## T3：独立审查与最终门禁

先聚焦新旧签署 unit、`subscription-closure.service.spec.ts`、`subscription-return-manifest-content.spec.ts`，保存 RED/GREEN 和必要类型/lint。独立 reviewer 审查全部原校验仍在、完整事实生成与真实查询排序、无日期延迟或只看 hash 的旁路。

精确集成后，最终干净候选执行财务原 API6 加上述三文件的 API9、原 Web2、API/Web types、全部变更 owned lint、diff，并冻结实际 11 文件摘要（原九文件加本次两文件）。同源串行完整 `api.subscription-expiry-return.postgres` → `api.asset-operations.postgres`；使用原 unchanged B5 capture 与新 prefix `financial-approval-retry-expiry-fresh-3` / 尚未使用的 `financial-approval-retry-asset-fresh-1`。失败按实际 first guard 诊断，原件不覆盖。

最后独立回读 report/receipt、真实 counts/exit/目标角色、run/容器退役；正式报告同时保留原 98/102、110/112、111/112 的实际分类和新反例边界。只有当前代码完整门禁实际通过，才整合 CLEAN/ORIGINAL；真实浏览器、渠道、Node22 最终镜像、真实发布输入和 Stage 1 签字仍开放。
